from __future__ import annotations

import html
import io
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Sequence
from urllib.parse import urlsplit

import httpx
from PIL import Image
from pypdf import PdfReader, PdfWriter
import reportlab
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Spacer

from .models import JobRecord, ReviewBatch
from . import storage

logger = logging.getLogger(__name__)

ArtifactOwnerType = Literal['review', 'batch']
PDF_CONTENT_TYPE = 'application/pdf'
PDF_LAYOUT_VERSION = 2
PAGE_SIZE = landscape(letter)
PAGE_WIDTH, PAGE_HEIGHT = PAGE_SIZE
TERMINAL_BATCH_STATUSES = {'complete', 'failed', 'upload_failed'}
STATUS_COLORS = {
    'green': colors.HexColor('#16803a'),
    'amber': colors.HexColor('#b65f00'),
    'red': colors.HexColor('#c62828'),
}
STATUS_LABELS = {
    'green': 'Green - Ready to run',
    'amber': 'Amber - Fix or review',
    'red': 'Red - Critical stop',
}
LEGACY_RESULT_STATUSES = {
    'pass': 'green',
    'yellow': 'amber',
    'orange': 'amber',
    'needs_review': 'amber',
    'likely_violation': 'red',
}
SOURCE_LABELS = {
    'ad_copy': 'Ad copy',
    'audio': 'Audio',
    'onscreen_text': 'On-screen text',
    'policy': 'Policy',
    'visual': 'Visual',
}
UPLOAD_TIMEOUT = httpx.Timeout(125.0, connect=20.0)
DOWNLOAD_TIMEOUT = httpx.Timeout(180.0, connect=20.0)


def _register_fonts() -> tuple[str, str]:
    fonts_dir = Path(reportlab.__file__).resolve().parent / 'fonts'
    regular = fonts_dir / 'Vera.ttf'
    bold = fonts_dir / 'VeraBd.ttf'
    if regular.exists() and bold.exists():
        try:
            pdfmetrics.registerFont(TTFont('VibeSans', regular))
            pdfmetrics.registerFont(TTFont('VibeSans-Bold', bold))
            return 'VibeSans', 'VibeSans-Bold'
        except Exception:
            logger.exception('Could not register bundled PDF fonts.')
    return 'Helvetica', 'Helvetica-Bold'


FONT_REGULAR, FONT_BOLD = _register_fonts()


class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states: list[dict[str, Any]] = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        page_count = len(self._saved_page_states)
        for page_number, state in enumerate(self._saved_page_states, start=1):
            self.__dict__.update(state)
            self.setStrokeColor(colors.HexColor('#d7dde6'))
            self.setLineWidth(0.6)
            self.line(34, 24, PAGE_WIDTH - 34, 24)
            self.setFillColor(colors.HexColor('#5f6b7a'))
            self.setFont(FONT_REGULAR, 8)
            self.drawRightString(PAGE_WIDTH - 34, 11, f'Page {page_number} of {page_count}')
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)


@dataclass(frozen=True)
class PdfArtifact:
    filename: str
    path: Path | None = None
    url: str | None = None


def review_pdf_path(job_id: str, offer_id: str | None = None) -> Path:
    suffix = f'-{offer_id}' if offer_id else ''
    return storage.job_dir(job_id) / f'report{suffix}.pdf'


def batch_pdf_path(batch_id: str, offer_id: str | None = None) -> Path:
    suffix = f'-{offer_id}' if offer_id else ''
    path = storage.JOB_DATA_DIR / 'batches' / f'{batch_id}-report{suffix}.pdf'
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _artifact_owner_id(owner_id: str, offer_id: str | None) -> str:
    versioned_owner = f'{owner_id}:layout:{PDF_LAYOUT_VERSION}'
    return f'{versioned_owner}:offer:{offer_id}' if offer_id else versioned_owner


def _artifact_path(
    owner_type: ArtifactOwnerType,
    owner_id: str,
    offer_id: str | None,
) -> Path:
    return (
        review_pdf_path(owner_id, offer_id)
        if owner_type == 'review'
        else batch_pdf_path(owner_id, offer_id)
    )


def _safe_filename(value: str, fallback: str) -> str:
    stem = str(value).strip() if value else ''
    stem = re.sub(r'[^A-Za-z0-9._ -]+', '-', stem)
    stem = re.sub(r'\s+', ' ', stem).strip(' .-_')
    return f'{(stem or fallback)[:120]}-report.pdf'


def _review_filename(record: JobRecord, offer_name: str | None = None) -> str:
    base_name = Path(record.file_name).stem or record.file_name
    value = f'{base_name} - {offer_name}' if offer_name else base_name
    return _safe_filename(value, record.job_id)


def _batch_filename(batch: ReviewBatch, offer_name: str | None = None) -> str:
    label = batch.source_label or f'batch-{batch.batch_id[:8]}'
    if offer_name:
        label = f'{label} - {offer_name}'
    return _safe_filename(label, f'batch-{batch.batch_id[:8]}')


def get_pdf_artifact(
    owner_type: ArtifactOwnerType,
    owner_id: str,
    offer_id: str | None = None,
) -> PdfArtifact | None:
    local_path = _artifact_path(owner_type, owner_id, offer_id)
    artifact_owner_id = _artifact_owner_id(owner_id, offer_id)
    if local_path.exists() and local_path.stat().st_size:
        filename = local_path.name
        try:
            if owner_type == 'review':
                record = storage.get_status(owner_id)
                offer_name = _offer_name(storage.get_report(owner_id) or {}, offer_id)
                filename = _review_filename(record, offer_name)
            else:
                batch = storage.get_batch(owner_id)
                filename = _batch_filename(batch, _batch_offer_name(batch, offer_id))
        except (FileNotFoundError, ValueError):
            pass
        return PdfArtifact(filename=filename, path=local_path)
    remote = storage._convex_call(
        'query',
        'reportArtifacts:get',
        {'ownerType': owner_type, 'ownerId': artifact_owner_id},
    )
    if not isinstance(remote, dict) or not remote.get('url'):
        return None
    filename = str(remote.get('filename') or local_path.name)
    try:
        if owner_type == 'review':
            record = storage.get_status(owner_id)
            offer_name = _offer_name(storage.get_report(owner_id) or {}, offer_id)
            filename = _review_filename(record, offer_name)
        else:
            batch = storage.get_batch(owner_id)
            filename = _batch_filename(batch, _batch_offer_name(batch, offer_id))
    except (FileNotFoundError, ValueError):
        pass
    return PdfArtifact(
        filename=filename,
        url=str(remote['url']),
    )


def read_pdf_artifact(artifact: PdfArtifact) -> bytes:
    if artifact.path is not None:
        return artifact.path.read_bytes()
    if not artifact.url:
        raise FileNotFoundError(artifact.filename)
    with httpx.Client(timeout=DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
        response = client.get(artifact.url)
        response.raise_for_status()
        return response.content


def _upload_pdf(path: Path) -> str:
    upload_url = storage._convex_call(
        'mutation',
        'reportArtifacts:generateUploadUrl',
        {},
    )
    if not isinstance(upload_url, str) or not upload_url.startswith('https://'):
        raise RuntimeError('Convex returned an invalid report artifact upload URL.')
    with path.open('rb') as body, httpx.Client(
        timeout=UPLOAD_TIMEOUT,
        follow_redirects=True,
    ) as client:
        response = client.post(
            upload_url,
            headers={
                'content-length': str(path.stat().st_size),
                'content-type': PDF_CONTENT_TYPE,
            },
            content=body,
        )
    response.raise_for_status()
    payload = response.json()
    storage_id = payload.get('storageId') if isinstance(payload, dict) else None
    if not isinstance(storage_id, str) or not storage_id:
        raise RuntimeError('Convex did not return a report artifact storage ID.')
    return storage_id


def persist_pdf_artifact(
    owner_type: ArtifactOwnerType,
    owner_id: str,
    path: Path,
    filename: str,
    offer_id: str | None = None,
) -> None:
    if not storage.convex_enabled():
        return
    storage_id: str | None = None
    try:
        storage_id = _upload_pdf(path)
        storage._convex_call(
            'mutation',
            'reportArtifacts:save',
            {
                'contentType': PDF_CONTENT_TYPE,
                'filename': filename,
                'ownerId': _artifact_owner_id(owner_id, offer_id),
                'ownerType': owner_type,
                'storageId': storage_id,
            },
        )
    except Exception:
        if storage_id:
            try:
                storage._convex_call(
                    'mutation',
                    'reportArtifacts:removeFiles',
                    {'storageIds': [storage_id]},
                )
            except Exception:
                logger.exception('Could not remove orphaned report artifact %s.', storage_id)
        raise


def _plain(value: Any) -> str:
    return str(value or '').replace('\u2010', '-').replace('\u2011', '-').replace('\u2012', '-') \
        .replace('\u2013', '-').replace('\u2014', '-').replace('\u2212', '-')


def _paragraph(text: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(html.escape(_plain(text)).replace('\n', '<br/>'), style)


def _direct_pdf_text(value: Any, max_words: int = 28) -> str:
    """Keep generated PDF notes to one short, complete-looking sentence."""
    text = re.sub(r'\s+', ' ', _plain(value)).strip()
    if not text:
        return ''
    first_sentence = re.split(r'(?<=[.!?])\s+', text, maxsplit=1)[0]
    words = first_sentence.split()
    if len(words) <= max_words:
        return first_sentence
    return ' '.join(words[:max_words]).rstrip(' ,;:-') + '...'


def _google_drive_url(record: JobRecord) -> str | None:
    if record.source_kind != 'google_drive_file' or not record.source_url:
        return None
    url = record.source_url.strip()
    parsed = urlsplit(url)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        return None
    return url


def _draw_google_drive_link(
    pdf: canvas.Canvas,
    record: JobRecord,
    *,
    x: float = 44,
    y: float = PAGE_HEIGHT - 117,
) -> None:
    url = _google_drive_url(record)
    if not url:
        return
    label = 'Google Drive:'
    link_text = 'Open exact creative'
    pdf.setFont(FONT_BOLD, 9)
    pdf.setFillColor(colors.HexColor('#3d72b4'))
    pdf.drawString(x, y, label)
    link_x = x + pdfmetrics.stringWidth(label, FONT_BOLD, 9) + 6
    pdf.setFont(FONT_REGULAR, 9)
    pdf.setFillColor(colors.HexColor('#175cd3'))
    pdf.drawString(link_x, y, link_text)
    link_width = pdfmetrics.stringWidth(link_text, FONT_REGULAR, 9)
    pdf.setStrokeColor(colors.HexColor('#175cd3'))
    pdf.setLineWidth(0.5)
    pdf.line(link_x, y - 1, link_x + link_width, y - 1)
    pdf.linkURL(url, (link_x, y - 3, link_x + link_width, y + 10), relative=0, thickness=0)


def _styles() -> dict[str, ParagraphStyle]:
    return {
        'body': ParagraphStyle(
            'body',
            fontName=FONT_REGULAR,
            fontSize=8.5,
            leading=12,
            textColor=colors.HexColor('#263242'),
            alignment=TA_LEFT,
        ),
        'small': ParagraphStyle(
            'small',
            fontName=FONT_REGULAR,
            fontSize=7.5,
            leading=10,
            textColor=colors.HexColor('#5f6b7a'),
        ),
        'field_heading': ParagraphStyle(
            'field_heading',
            fontName=FONT_BOLD,
            fontSize=8.5,
            leading=11,
            textColor=colors.HexColor('#3d72b4'),
            spaceAfter=2,
        ),
        'continuation': ParagraphStyle(
            'continuation',
            fontName=FONT_REGULAR,
            fontSize=9.5,
            leading=14,
            textColor=colors.HexColor('#263242'),
        ),
    }


def _draw_flowables(
    pdf: canvas.Canvas,
    flowables: Sequence[Any],
    x: float,
    y_top: float,
    width: float,
    height: float,
) -> list[Any]:
    remaining = list(flowables)
    y = y_top
    available = height
    while remaining and available > 1:
        flowable = remaining.pop(0)
        _, required = flowable.wrap(width, available)
        if required <= available:
            y -= required
            flowable.drawOn(pdf, x, y)
            available -= required
            continue
        parts = flowable.split(width, available)
        if not parts:
            remaining.insert(0, flowable)
            break
        first, *tail = parts
        _, used = first.wrap(width, available)
        y -= used
        first.drawOn(pdf, x, y)
        remaining = [*tail, *remaining]
        break
    return remaining


def _format_date(value: int | None) -> str:
    if not value:
        return datetime.now(timezone.utc).strftime('%B %d, %Y')
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).strftime('%B %d, %Y')


def _timestamp_seconds(value: Any) -> float | None:
    if value in (None, ''):
        return None
    text = str(value).strip()
    if ':' in text:
        parts = text.split(':')
        if 2 <= len(parts) <= 3:
            try:
                numbers = [float(part) for part in parts]
            except ValueError:
                pass
            else:
                seconds = numbers[-1] + numbers[-2] * 60
                if len(numbers) == 3:
                    seconds += numbers[0] * 3600
                return seconds
    try:
        return float(value)
    except (TypeError, ValueError):
        match = re.search(r'\d+(?:\.\d+)?', text)
        return float(match.group(0)) if match else None


def timestamp_label(value: Any) -> str:
    seconds = _timestamp_seconds(value)
    if seconds is None:
        return 'No timestamp'
    total = max(0, int(round(seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f'{hours:02d}:{minutes:02d}:{secs:02d}' if hours else f'{minutes:02d}:{secs:02d}'


def nearest_frame(frames: Sequence[dict[str, Any]], timestamp: Any) -> dict[str, Any] | None:
    if not frames:
        return None
    target = _timestamp_seconds(timestamp)
    if target is None:
        return frames[0]
    timed = [
        (abs(float(frame['timestamp']) - target), frame)
        for frame in frames
        if isinstance(frame.get('timestamp'), (int, float))
    ]
    return min(timed, key=lambda item: item[0])[1] if timed else frames[0]


def transcript_excerpt(transcript: dict[str, Any] | None, timestamp: Any) -> str:
    chunks = transcript.get('chunks') if isinstance(transcript, dict) else None
    if not isinstance(chunks, list) or not chunks:
        return ''
    target = _timestamp_seconds(timestamp)
    if target is None:
        return _plain(chunks[0].get('text')) if isinstance(chunks[0], dict) else ''
    candidates: list[tuple[float, dict[str, Any]]] = []
    for chunk in chunks:
        if not isinstance(chunk, dict) or not chunk.get('text'):
            continue
        start = _timestamp_seconds(chunk.get('timestamp_start'))
        end = _timestamp_seconds(chunk.get('timestamp_end'))
        if start is not None and end is not None and start <= target <= end:
            return _plain(chunk['text'])
        anchor = start if start is not None else end
        candidates.append((abs(anchor - target) if anchor is not None else 1e12, chunk))
    if not candidates:
        return ''
    return _plain(min(candidates, key=lambda item: item[0])[1]['text'])


def _offer_results(report: dict[str, Any]) -> list[dict[str, Any]]:
    values = report.get('offer_results')
    return [value for value in values if isinstance(value, dict)] if isinstance(values, list) and values else [report]


def _offer_result(report: dict[str, Any], offer_id: str) -> dict[str, Any]:
    result = next((
        value
        for value in _offer_results(report)
        if str(value.get('offer_id') or '').strip().lower() == offer_id
    ), None)
    if result is None:
        raise KeyError(offer_id)
    return result


def _offer_name(report: dict[str, Any], offer_id: str | None) -> str | None:
    if not offer_id:
        return None
    try:
        result = _offer_result(report, offer_id)
    except KeyError:
        return offer_id
    return _plain(result.get('offer_name') or offer_id)


def _report_for_offer(report: dict[str, Any], offer_id: str | None) -> dict[str, Any]:
    return _offer_result(report, offer_id) if offer_id else report


def _all_findings(report: dict[str, Any]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for offer in _offer_results(report):
        findings = offer.get('findings')
        if not isinstance(findings, list):
            continue
        rows.extend((offer, finding) for finding in findings if isinstance(finding, dict))
    return rows


def _header(pdf: canvas.Canvas, title: str, subtitle: str = '') -> None:
    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_BOLD, 15)
    pdf.drawCentredString(PAGE_WIDTH / 2, PAGE_HEIGHT - 34, _plain(title)[:110])
    if subtitle:
        pdf.setFillColor(colors.HexColor('#667085'))
        pdf.setFont(FONT_REGULAR, 8)
        pdf.drawCentredString(PAGE_WIDTH / 2, PAGE_HEIGHT - 48, _plain(subtitle)[:145])


def _status_color(status: Any) -> colors.Color:
    return STATUS_COLORS.get(_normalize_result_status(status), colors.HexColor('#64748b'))


def _draw_status_pill(pdf: canvas.Canvas, x: float, y: float, status: Any, label: str | None = None) -> None:
    status_text = _normalize_result_status(status)
    text = label or STATUS_LABELS.get(status_text, status_text.replace('_', ' ').title())
    color = _status_color(status)
    pdf.setFillColor(colors.Color(color.red, color.green, color.blue, alpha=0.10))
    pdf.setStrokeColor(color)
    pdf.roundRect(x, y, 150, 24, 6, fill=1, stroke=1)
    pdf.setFillColor(color)
    pdf.setFont(FONT_BOLD, 8)
    pdf.drawCentredString(x + 75, y + 8, _plain(text)[:34])


def _normalize_result_status(status: Any) -> str:
    value = str(status or 'not available').strip().lower()
    if value in STATUS_LABELS:
        return value
    return LEGACY_RESULT_STATUSES.get(value, value)


def _offer_status_label(offer: dict[str, Any]) -> str | None:
    if (
        _normalize_result_status(offer.get('overall_status')) == 'green'
        and offer.get('internal_disposition') == 'accepted_with_override'
    ):
        return 'Green - Internal exception'
    return None


def _frame_path(frames_dir: Path | None, frame: dict[str, Any] | None) -> Path | None:
    if frames_dir is None or frame is None:
        return None
    filename = Path(str(frame.get('filename') or '')).name
    candidate = frames_dir / filename
    return candidate if filename and candidate.exists() else None


def _draw_image_box(
    pdf: canvas.Canvas,
    image_path: Path | None,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    callout: str,
    evidence_status: Any = None,
    placeholder: str = 'No creative frame is available for this report.',
) -> None:
    border = (
        _status_color(evidence_status)
        if evidence_status is not None
        else colors.HexColor('#4f83c2')
    )
    pdf.setFillColor(colors.HexColor('#f7f9fc'))
    pdf.setStrokeColor(border)
    pdf.setLineWidth(2.2)
    pdf.roundRect(x, y, width, height, 4, fill=1, stroke=1)
    if image_path is not None:
        try:
            with Image.open(image_path) as image:
                image_width, image_height = image.size
            available_width = width - 14
            available_height = height - 14
            scale = min(available_width / image_width, available_height / image_height)
            draw_width = image_width * scale
            draw_height = image_height * scale
            pdf.drawImage(
                str(image_path),
                x + (width - draw_width) / 2,
                y + (height - draw_height) / 2,
                draw_width,
                draw_height,
                preserveAspectRatio=True,
                mask='auto',
            )
        except Exception:
            logger.exception('Could not render evidence frame %s.', image_path)
            image_path = None
    if image_path is None:
        styles = _styles()
        paragraph = _paragraph(placeholder, styles['body'])
        paragraph.wrapOn(pdf, width - 50, height - 50)
        paragraph.drawOn(pdf, x + 25, y + height / 2 - 18)
    pdf.setFillColor(border)
    pill_width = min(width - 16, max(102, pdfmetrics.stringWidth(callout, FONT_BOLD, 8) + 22))
    pdf.roundRect(x + 8, y + height - 28, pill_width, 20, 6, fill=1, stroke=0)
    pdf.setFillColor(colors.white)
    pdf.setFont(FONT_BOLD, 8)
    pdf.drawString(x + 18, y + height - 21, _plain(callout)[:62])


def _summary_page(
    pdf: canvas.Canvas,
    record: JobRecord,
    report: dict[str, Any],
    frames_dir: Path | None,
    frames: Sequence[dict[str, Any]],
    *,
    include_offer_names: bool,
) -> None:
    title = f'{record.file_name or record.job_id} - Compliance Evidence Report'
    _header(pdf, title, f'Review job {record.job_id}')
    pdf.setFillColor(colors.HexColor('#3d72b4'))
    pdf.setFont(FONT_BOLD, 11)
    pdf.drawString(44, PAGE_HEIGHT - 77, 'Date:')
    pdf.drawString(44, PAGE_HEIGHT - 97, 'Creative:')
    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_REGULAR, 10)
    pdf.drawString(84, PAGE_HEIGHT - 77, _format_date(record.created_at))
    pdf.drawString(102, PAGE_HEIGHT - 97, _plain(record.file_name or record.job_id)[:84])
    _draw_google_drive_link(pdf, record)

    flow_y = PAGE_HEIGHT - 139
    pdf.setFillColor(colors.HexColor('#f2f4f7'))
    pdf.rect(10, flow_y - 54, PAGE_WIDTH - 20, 70, fill=1, stroke=0)
    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_BOLD, 9)
    pdf.drawString(58, flow_y - 2, 'Creative evidence')
    pdf.drawCentredString(PAGE_WIDTH / 2, flow_y - 2, 'Automated policy review')
    pdf.drawRightString(
        PAGE_WIDTH - 58,
        flow_y - 2,
        'Offer outcomes' if include_offer_names else 'Overall outcome',
    )
    pdf.setStrokeColor(colors.HexColor('#111827'))
    pdf.setLineWidth(1.5)
    pdf.line(190, flow_y - 19, 315, flow_y - 19)
    pdf.line(475, flow_y - 19, 600, flow_y - 19)
    pdf.line(307, flow_y - 23, 315, flow_y - 19)
    pdf.line(307, flow_y - 15, 315, flow_y - 19)
    pdf.line(592, flow_y - 23, 600, flow_y - 19)
    pdf.line(592, flow_y - 15, 600, flow_y - 19)

    frame = frames[0] if frames else None
    _draw_image_box(
        pdf,
        _frame_path(frames_dir, frame),
        34,
        66,
        326,
        340,
        callout='Creative frame' if frame is None else f'Creative frame - {timestamp_label(frame.get("timestamp"))}',
    )

    offers = _offer_results(report)
    pdf.setFillColor(colors.HexColor('#ffffff'))
    pdf.setStrokeColor(colors.HexColor('#16803a'))
    pdf.setLineWidth(2)
    pdf.roundRect(392, 66, 366, 340, 4, fill=1, stroke=1)
    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_BOLD, 12)
    pdf.drawString(412, 378, 'Results summary')
    y = 342
    for offer in offers[:6]:
        name = (
            _plain(offer.get('offer_name') or offer.get('offer_id') or 'Offer')
            if include_offer_names
            else 'Overall result'
        )
        pdf.setFillColor(colors.HexColor('#111827'))
        pdf.setFont(FONT_BOLD, 9)
        pdf.drawString(412, y + 8, name[:42])
        _draw_status_pill(
            pdf,
            582,
            y,
            offer.get('overall_status'),
            _offer_status_label(offer),
        )
        y -= 38
    if len(offers) > 6:
        pdf.setFillColor(colors.HexColor('#667085'))
        pdf.setFont(FONT_REGULAR, 8)
        pdf.drawString(412, y + 8, f'{len(offers) - 6} additional offer results are included in the report.')
        y -= 24
    primary = offers[0] if offers else report
    styles = _styles()
    summary = _paragraph(
        _direct_pdf_text(primary.get('summary') or 'No review summary was returned.'),
        styles['body'],
    )
    summary_height = max(52, y - 104)
    _draw_flowables(pdf, [summary], 412, y, 326, summary_height)
    finding_count = len(_all_findings(report))
    pdf.setFillColor(colors.HexColor('#3d72b4'))
    pdf.setFont(FONT_BOLD, 9)
    pdf.drawString(412, 82, f'Findings: {finding_count}')


def _finding_flowables(
    finding: dict[str, Any],
    transcript: dict[str, Any] | None,
) -> list[Any]:
    styles = _styles()
    fields: list[tuple[str, str]] = [
        ('Evidence', _direct_pdf_text(finding.get('evidence'))),
        ('Why it matters', _direct_pdf_text(finding.get('policy_reason'))),
        ('Fix', _direct_pdf_text(finding.get('suggested_fix'))),
    ]
    if finding.get('source') == 'audio':
        excerpt = transcript_excerpt(transcript, finding.get('timestamp_start'))
        if excerpt:
            fields.insert(1, ('Transcript excerpt', excerpt))
    flowables: list[Any] = []
    for heading, value in fields:
        flowables.append(_paragraph(heading, styles['field_heading']))
        flowables.append(_paragraph(value or 'No detail was returned.', styles['body']))
        flowables.append(Spacer(1, 9))
    return flowables


def _finding_page(
    pdf: canvas.Canvas,
    record: JobRecord,
    offer: dict[str, Any],
    finding: dict[str, Any],
    index: int,
    count: int,
    frames_dir: Path | None,
    frames: Sequence[dict[str, Any]],
    transcript: dict[str, Any] | None,
    ad_copy: str,
    *,
    include_offer_names: bool,
) -> list[Any]:
    source = str(finding.get('source') or 'policy')
    source_label = SOURCE_LABELS.get(source, source.replace('_', ' ').title())
    timestamp = timestamp_label(finding.get('timestamp_start'))
    offer_name = _plain(offer.get('offer_name') or offer.get('offer_id') or 'Offer')
    _header(
        pdf,
        (
            f'{offer_name} finding {index} of {count}'
            if include_offer_names
            else f'Finding {index} of {count}'
        ),
        f'{record.file_name or record.job_id} | {source_label} | {timestamp}',
    )
    _draw_status_pill(
        pdf,
        PAGE_WIDTH - 188,
        PAGE_HEIGHT - 88,
        offer.get('overall_status'),
        _offer_status_label(offer),
    )
    pdf.setFillColor(colors.HexColor('#3d72b4'))
    pdf.setFont(FONT_BOLD, 10)
    pdf.drawString(36, PAGE_HEIGHT - 84, f'Source: {source_label}')
    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_REGULAR, 9)
    pdf.drawString(36, PAGE_HEIGHT - 100, f'Timestamp: {timestamp}')
    pdf.drawString(188, PAGE_HEIGHT - 100, f'Severity: {_plain(finding.get("severity") or "not available").title()}')
    pdf.drawString(330, PAGE_HEIGHT - 100, f'Confidence: {_plain(finding.get("confidence") or "not available").title()}')

    frame = nearest_frame(frames, finding.get('timestamp_start')) if source in {'audio', 'onscreen_text', 'visual'} else None
    placeholder = (
        f'This finding is based on submitted ad copy.\n\n{ad_copy}'
        if source == 'ad_copy' and ad_copy
        else f'No timestamped creative frame applies to this {source_label.lower()} finding.'
    )
    callout = f'{source_label} evidence - {timestamp}' if frame else f'{source_label} evidence'
    _draw_image_box(
        pdf,
        _frame_path(frames_dir, frame),
        34,
        58,
        342,
        426,
        callout=callout,
        evidence_status=offer.get('overall_status'),
        placeholder=placeholder,
    )
    pdf.setFillColor(colors.HexColor('#ffffff'))
    pdf.setStrokeColor(colors.HexColor('#d7dde6'))
    pdf.setLineWidth(1)
    pdf.roundRect(398, 58, 360, 426, 4, fill=1, stroke=1)
    return _draw_flowables(
        pdf,
        _finding_flowables(finding, transcript),
        416,
        462,
        324,
        382,
    )


def _continuation_page(
    pdf: canvas.Canvas,
    record: JobRecord,
    offer: dict[str, Any],
    finding_index: int,
    flowables: Sequence[Any],
    *,
    include_offer_names: bool,
) -> list[Any]:
    offer_name = _plain(offer.get('offer_name') or offer.get('offer_id') or 'Offer')
    _header(
        pdf,
        (
            f'{offer_name} finding {finding_index} continued'
            if include_offer_names
            else f'Finding {finding_index} continued'
        ),
        record.file_name or record.job_id,
    )
    pdf.setFillColor(colors.HexColor('#ffffff'))
    pdf.setStrokeColor(colors.HexColor('#d7dde6'))
    pdf.roundRect(34, 50, PAGE_WIDTH - 68, PAGE_HEIGHT - 118, 4, fill=1, stroke=1)
    return _draw_flowables(
        pdf,
        flowables,
        54,
        PAGE_HEIGHT - 92,
        PAGE_WIDTH - 108,
        PAGE_HEIGHT - 158,
    )


def _ellipsize_to_width(
    value: Any,
    width: float,
    font_name: str,
    font_size: float,
) -> str:
    text = re.sub(r'\s+', ' ', _plain(value)).strip()
    if not text or width <= 0:
        return ''
    if pdfmetrics.stringWidth(text, font_name, font_size) <= width:
        return text
    suffix = '...'
    available = max(0, width - pdfmetrics.stringWidth(suffix, font_name, font_size))
    words = text.split()
    line = ''
    for word in words:
        candidate = f'{line} {word}'.strip()
        if pdfmetrics.stringWidth(candidate, font_name, font_size) > available:
            break
        line = candidate
    if line:
        return line.rstrip(' ,;:-') + suffix
    clipped = ''
    for character in text:
        if pdfmetrics.stringWidth(clipped + character, font_name, font_size) > available:
            break
        clipped += character
    return clipped.rstrip() + suffix


def _draw_wrapped_lines(
    pdf: canvas.Canvas,
    value: Any,
    *,
    x: float,
    y_top: float,
    width: float,
    font_name: str,
    font_size: float,
    leading: float,
    max_lines: int,
    color: colors.Color,
) -> float:
    text = re.sub(r'\s+', ' ', _plain(value)).strip()
    if not text or max_lines <= 0:
        return y_top
    words = text.split()
    lines: list[str] = []
    current = ''
    while words and len(lines) < max_lines:
        word = words.pop(0)
        candidate = f'{current} {word}'.strip()
        if not current or pdfmetrics.stringWidth(candidate, font_name, font_size) <= width:
            current = candidate
            continue
        lines.append(current)
        current = word
    if current and len(lines) < max_lines:
        lines.append(current)
    if words and lines:
        remainder = ' '.join([lines[-1], *words])
        lines[-1] = _ellipsize_to_width(remainder, width, font_name, font_size)
    pdf.setFillColor(color)
    pdf.setFont(font_name, font_size)
    y = y_top
    for line in lines:
        pdf.drawString(x, y, line)
        y -= leading
    return y


def _draw_thumbnail(
    pdf: canvas.Canvas,
    image_path: Path | None,
    x: float,
    y: float,
    width: float,
    height: float,
    *,
    border: colors.Color,
    label: str = '',
) -> None:
    pdf.setFillColor(colors.HexColor('#f7f9fc'))
    pdf.setStrokeColor(border)
    pdf.setLineWidth(0.8)
    pdf.roundRect(x, y, width, height, 3, fill=1, stroke=1)
    rendered = False
    if image_path is not None:
        try:
            with Image.open(image_path) as image:
                image_width, image_height = image.size
            inset = 3
            scale = min(
                (width - inset * 2) / max(1, image_width),
                (height - inset * 2) / max(1, image_height),
            )
            draw_width = image_width * scale
            draw_height = image_height * scale
            pdf.drawImage(
                str(image_path),
                x + (width - draw_width) / 2,
                y + (height - draw_height) / 2,
                draw_width,
                draw_height,
                preserveAspectRatio=True,
                mask='auto',
            )
            rendered = True
        except Exception:
            logger.exception('Could not render compact evidence frame %s.', image_path)
    if not rendered and label:
        font_size = 6 if width < 50 else 7
        pdf.setFillColor(colors.HexColor('#667085'))
        pdf.setFont(FONT_BOLD, font_size)
        pdf.drawCentredString(
            x + width / 2,
            y + height / 2 - font_size / 3,
            _ellipsize_to_width(label.upper(), width - 8, FONT_BOLD, font_size),
        )


def _finding_action(finding: dict[str, Any]) -> tuple[str, str]:
    suggested_fix = _direct_pdf_text(finding.get('suggested_fix'), max_words=18)
    if suggested_fix:
        return 'Fix', suggested_fix
    return 'Policy', _direct_pdf_text(finding.get('policy_reason'), max_words=18)


def _draw_finding_card(
    pdf: canvas.Canvas,
    *,
    offer: dict[str, Any],
    finding: dict[str, Any],
    index: int,
    x: float,
    y: float,
    width: float,
    height: float,
    frames_dir: Path | None,
    frames: Sequence[dict[str, Any]],
    include_offer_names: bool,
) -> None:
    source = str(finding.get('source') or 'policy')
    source_label = SOURCE_LABELS.get(source, source.replace('_', ' ').title())
    severity = _plain(finding.get('severity') or 'not available').title()
    severity_color = {
        'High': STATUS_COLORS['red'],
        'Medium': STATUS_COLORS['amber'],
        'Low': colors.HexColor('#3d72b4'),
    }.get(severity, colors.HexColor('#64748b'))
    pdf.setFillColor(colors.white)
    pdf.setStrokeColor(colors.HexColor('#d7dde6'))
    pdf.setLineWidth(0.65)
    pdf.roundRect(x, y, width, height, 3, fill=1, stroke=1)
    pdf.setFillColor(severity_color)
    pdf.rect(x, y, 3, height, fill=1, stroke=0)

    compact = height < 38
    frame_width = min(66 if not compact else 34, max(28, height * 1.2))
    frame_height = max(20, height - 8)
    frame_x = x + 8
    frame_y = y + (height - frame_height) / 2
    frame = nearest_frame(frames, finding.get('timestamp_start')) if source in {
        'audio', 'onscreen_text', 'visual'
    } else None
    _draw_thumbnail(
        pdf,
        _frame_path(frames_dir, frame),
        frame_x,
        frame_y,
        frame_width,
        frame_height,
        border=severity_color,
        label=source_label,
    )

    text_x = frame_x + frame_width + 7
    text_width = width - (text_x - x) - 8
    meta_size = 5.6 if compact else 6.5
    body_size = 5.7 if compact else 7.2
    action_size = 5.4 if compact else 6.5
    timestamp = timestamp_label(finding.get('timestamp_start'))
    offer_name = _plain(offer.get('offer_name') or offer.get('offer_id') or 'Offer')
    meta_parts = [f'#{index}', source_label, timestamp, severity]
    if include_offer_names:
        meta_parts.insert(1, offer_name)
    meta = ' | '.join(meta_parts)
    pdf.setFillColor(severity_color)
    pdf.setFont(FONT_BOLD, meta_size)
    meta_y = y + height - (8 if compact else 11)
    pdf.drawString(
        text_x,
        meta_y,
        _ellipsize_to_width(meta, text_width, FONT_BOLD, meta_size),
    )

    evidence = _direct_pdf_text(finding.get('evidence'), max_words=24)
    action_label, action = _finding_action(finding)
    body_y = meta_y - (7 if compact else 11)
    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_BOLD, body_size)
    pdf.drawString(
        text_x,
        body_y,
        _ellipsize_to_width(evidence or 'Finding detail unavailable.', text_width, FONT_BOLD, body_size),
    )
    action_y = body_y - (7 if compact else 12)
    pdf.setFillColor(colors.HexColor('#526173'))
    pdf.setFont(FONT_REGULAR, action_size)
    action_text = f'{action_label}: {action or "Review the finding before publishing."}'
    pdf.drawString(
        text_x,
        action_y,
        _ellipsize_to_width(action_text, text_width, FONT_REGULAR, action_size),
    )


def _creative_page(
    pdf: canvas.Canvas,
    record: JobRecord,
    report: dict[str, Any],
    frames_dir: Path | None,
    frames: Sequence[dict[str, Any]],
    *,
    include_offer_names: bool,
) -> None:
    findings = _all_findings(report)
    offers = _offer_results(report)
    primary = offers[0] if offers else report
    title = _plain(record.file_name or record.job_id)
    subtitle = f'Creative decision sheet | Review job {record.job_id}'
    _header(pdf, title, subtitle)

    master_frame = frames[0] if frames else None
    master_path = _frame_path(frames_dir, master_frame)
    _draw_thumbnail(
        pdf,
        master_path,
        34,
        454,
        112,
        82,
        border=_status_color(primary.get('overall_status')),
        label='Copy-only review' if not record.has_creative else 'Creative preview',
    )
    pdf.setFillColor(colors.HexColor('#3d72b4'))
    pdf.setFont(FONT_BOLD, 7.5)
    pdf.drawString(158, 523, 'CREATIVE')
    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_BOLD, 10)
    pdf.drawString(
        158,
        507,
        _ellipsize_to_width(title, 420, FONT_BOLD, 10),
    )
    pdf.setFillColor(colors.HexColor('#667085'))
    pdf.setFont(FONT_REGULAR, 7.5)
    finding_suffix = '' if len(findings) == 1 else 's'
    details = f'{_format_date(record.created_at)} | {len(findings)} finding{finding_suffix}'
    pdf.drawString(158, 492, details)
    if include_offer_names:
        names = ', '.join(_plain(offer.get('offer_name') or offer.get('offer_id')) for offer in offers)
        pdf.drawString(
            158,
            479,
            _ellipsize_to_width(f'Offers: {names}', 420, FONT_REGULAR, 7.5),
        )
    summary_y = 464 if include_offer_names else 478
    _draw_wrapped_lines(
        pdf,
        _direct_pdf_text(primary.get('summary') or 'No review summary was returned.', max_words=30),
        x=158,
        y_top=summary_y,
        width=420,
        font_name=FONT_REGULAR,
        font_size=7.2,
        leading=9,
        max_lines=2,
        color=colors.HexColor('#526173'),
    )
    _draw_status_pill(
        pdf,
        PAGE_WIDTH - 184,
        502,
        primary.get('overall_status'),
        _offer_status_label(primary),
    )
    _draw_google_drive_link(pdf, record, x=610, y=486)

    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_BOLD, 10)
    pdf.drawString(34, 435, 'Findings')
    pdf.setFillColor(colors.HexColor('#667085'))
    pdf.setFont(FONT_REGULAR, 7)
    pdf.drawString(100, 435, 'Concise evidence and the recommended action')

    if not findings:
        pdf.setFillColor(colors.HexColor('#f3faf6'))
        pdf.setStrokeColor(STATUS_COLORS['green'])
        pdf.setLineWidth(1)
        pdf.roundRect(34, 72, PAGE_WIDTH - 68, 340, 5, fill=1, stroke=1)
        pdf.setFillColor(STATUS_COLORS['green'])
        pdf.setFont(FONT_BOLD, 17)
        pdf.drawCentredString(PAGE_WIDTH / 2, 265, 'No policy findings')
        pdf.setFillColor(colors.HexColor('#526173'))
        pdf.setFont(FONT_REGULAR, 9)
        pdf.drawCentredString(PAGE_WIDTH / 2, 244, 'This creative is ready to run under the reviewed policy.')
        return

    columns = 1 if len(findings) <= 6 else 2
    rows = (len(findings) + columns - 1) // columns
    gap_x = 8
    gap_y = 4
    area_x = 34
    area_bottom = 36
    area_top = 422
    area_width = PAGE_WIDTH - 68
    area_height = area_top - area_bottom
    card_width = (area_width - gap_x * (columns - 1)) / columns
    card_height = (area_height - gap_y * (rows - 1)) / rows
    for offset, (offer, finding) in enumerate(findings):
        column_index = offset // rows
        row_index = offset % rows
        x = area_x + column_index * (card_width + gap_x)
        y = area_top - (row_index + 1) * card_height - row_index * gap_y
        _draw_finding_card(
            pdf,
            offer=offer,
            finding=finding,
            index=offset + 1,
            x=x,
            y=y,
            width=card_width,
            height=card_height,
            frames_dir=frames_dir,
            frames=frames,
            include_offer_names=include_offer_names,
        )


def generate_review_report_pdf(
    target: Path | io.BytesIO,
    record: JobRecord,
    report: dict[str, Any],
    *,
    frames_dir: Path | None = None,
    frames: Sequence[dict[str, Any]] = (),
    transcript: dict[str, Any] | None = None,
    ad_copy: str = '',
    include_offer_names: bool = True,
) -> None:
    if isinstance(target, Path):
        target.parent.mkdir(parents=True, exist_ok=True)
    canvas_target = str(target) if isinstance(target, Path) else target
    pdf = NumberedCanvas(canvas_target, pagesize=PAGE_SIZE, pageCompression=1)
    pdf.setTitle(f'{record.file_name or record.job_id} - Compliance Evidence Report')
    pdf.setAuthor('Vibe Check')
    _creative_page(
        pdf,
        record,
        report,
        frames_dir,
        frames,
        include_offer_names=include_offer_names,
    )
    pdf.showPage()
    pdf.save()


def build_and_store_review_pdf(
    job_id: str,
    record: JobRecord,
    report: dict[str, Any],
    *,
    frames_dir: Path | None = None,
    frames: Sequence[dict[str, Any]] = (),
    transcript: dict[str, Any] | None = None,
    ad_copy: str = '',
    offer_id: str | None = None,
) -> PdfArtifact:
    selected_report = _report_for_offer(report, offer_id)
    offer_name = _offer_name(report, offer_id)
    path = review_pdf_path(job_id, offer_id)
    filename = _review_filename(record, offer_name)
    generate_review_report_pdf(
        path,
        record,
        selected_report,
        frames_dir=frames_dir,
        frames=frames,
        transcript=transcript,
        ad_copy=ad_copy,
        include_offer_names=offer_id is None,
    )
    persist_pdf_artifact('review', job_id, path, filename, offer_id)
    return PdfArtifact(filename=filename, path=path)


def build_and_store_review_pdf_variants(
    job_id: str,
    record: JobRecord,
    report: dict[str, Any],
    *,
    frames_dir: Path | None = None,
    frames: Sequence[dict[str, Any]] = (),
    transcript: dict[str, Any] | None = None,
    ad_copy: str = '',
) -> list[PdfArtifact]:
    artifacts = [build_and_store_review_pdf(
        job_id,
        record,
        report,
        frames_dir=frames_dir,
        frames=frames,
        transcript=transcript,
        ad_copy=ad_copy,
    )]
    for offer in _offer_results(report):
        offer_id = str(offer.get('offer_id') or '').strip().lower()
        if not offer_id:
            continue
        artifacts.append(build_and_store_review_pdf(
            job_id,
            record,
            report,
            frames_dir=frames_dir,
            frames=frames,
            transcript=transcript,
            ad_copy=ad_copy,
            offer_id=offer_id,
        ))
    return artifacts


def ensure_review_pdf(job_id: str, offer_id: str | None = None) -> PdfArtifact:
    record = storage.get_status(job_id)
    if offer_id and offer_id not in record.offer_ids:
        raise KeyError(offer_id)
    artifact = get_pdf_artifact('review', job_id, offer_id)
    if artifact is not None:
        return artifact
    report = storage.get_report(job_id)
    if report is None:
        raise FileNotFoundError(job_id)
    return build_and_store_review_pdf(job_id, record, report, offer_id=offer_id)


def _batch_offer_name(batch: ReviewBatch, offer_id: str | None) -> str | None:
    if not offer_id:
        return None
    for item in batch.items:
        for outcome in item.offer_outcomes:
            if outcome.offer_id == offer_id:
                return outcome.offer_name
    return offer_id


def _batch_offer_status(item: Any, offer_id: str | None) -> str | None:
    if not offer_id:
        return getattr(item, 'result', None)
    for outcome in getattr(item, 'offer_outcomes', None) or []:
        if outcome.offer_id == offer_id and outcome.evaluation_state == 'evaluated':
            return outcome.overall_status
    return None


def _batch_offer_summary(item: Any, offer_id: str | None = None) -> str:
    outcomes = getattr(item, 'offer_outcomes', None) or []
    values = []
    for outcome in outcomes:
        if offer_id and outcome.offer_id != offer_id:
            continue
        if outcome.evaluation_state != 'evaluated':
            continue
        status = outcome.overall_status or 'not rated'
        values.append(status.title() if offer_id else f'{outcome.offer_name}: {status.title()}')
    if values:
        return ' | '.join(values)
    if offer_id:
        return 'Not evaluated'
    return str(getattr(item, 'result', None) or getattr(item, 'status', 'not available')).replace('_', ' ').title()


def _batch_cover_pdf(batch: ReviewBatch, offer_id: str | None = None) -> bytes:
    buffer = io.BytesIO()
    pdf = NumberedCanvas(buffer, pagesize=PAGE_SIZE, pageCompression=1)
    pdf.setTitle(f'Batch {batch.batch_id} - Compliance Evidence Report')
    rows_per_page = 11
    chunks = [batch.items[index:index + rows_per_page] for index in range(0, len(batch.items), rows_per_page)] or [[]]
    for page_index, items in enumerate(chunks, start=1):
        _header(
            pdf,
            'Batch Compliance Evidence Report',
            f'Batch {batch.batch_id} | Uploaded {_format_date(batch.created_at)}',
        )
        pdf.setFillColor(colors.HexColor('#3d72b4'))
        pdf.setFont(FONT_BOLD, 10)
        pdf.drawString(40, PAGE_HEIGHT - 80, 'Source:')
        pdf.setFillColor(colors.HexColor('#111827'))
        pdf.setFont(FONT_REGULAR, 9)
        pdf.drawString(85, PAGE_HEIGHT - 80, _plain(batch.source_label or 'Manual batch')[:100])
        complete = sum(item.status == 'complete' for item in batch.items)
        failed = sum(item.status in {'failed', 'upload_failed'} for item in batch.items)
        pdf.drawRightString(PAGE_WIDTH - 40, PAGE_HEIGHT - 80, f'{complete} complete | {failed} failed | {len(batch.items)} total')

        table_top = PAGE_HEIGHT - 108
        pdf.setFillColor(colors.HexColor('#eaf0f8'))
        pdf.rect(34, table_top - 26, PAGE_WIDTH - 68, 26, fill=1, stroke=0)
        pdf.setFillColor(colors.HexColor('#23354d'))
        pdf.setFont(FONT_BOLD, 8)
        pdf.drawString(46, table_top - 17, 'Creative')
        pdf.drawString(370, table_top - 17, 'Status')
        pdf.drawString(468, table_top - 17, 'Offer outcome' if offer_id else 'Offer outcomes')
        y = table_top - 26
        for item in items:
            y -= 38
            pdf.setFillColor(colors.white if int((table_top - y) / 38) % 2 else colors.HexColor('#f8fafc'))
            pdf.rect(34, y, PAGE_WIDTH - 68, 38, fill=1, stroke=0)
            pdf.setFillColor(colors.HexColor('#111827'))
            pdf.setFont(FONT_BOLD, 8)
            pdf.drawString(46, y + 22, _plain(item.file_name)[:58])
            pdf.setFillColor(colors.HexColor('#667085'))
            pdf.setFont(FONT_REGULAR, 7)
            pdf.drawString(46, y + 9, _plain(item.media_kind).replace('_', ' ').title())
            selected_status = _batch_offer_status(item, offer_id)
            status_color = _status_color(selected_status) if item.status == 'complete' else colors.HexColor('#64748b')
            pdf.setFillColor(status_color)
            pdf.setFont(FONT_BOLD, 8)
            pdf.drawString(370, y + 15, _plain(item.status).replace('_', ' ').title())
            pdf.setFillColor(colors.HexColor('#263242'))
            pdf.setFont(FONT_REGULAR, 7)
            pdf.drawString(468, y + 15, _plain(_batch_offer_summary(item, offer_id))[:70])
        pdf.setFillColor(colors.HexColor('#667085'))
        pdf.setFont(FONT_REGULAR, 8)
        pdf.drawString(40, 38, f'Batch summary page {page_index} of {len(chunks)}. Individual creative reports follow.')
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def _failed_creative_pdf(item: Any) -> bytes:
    buffer = io.BytesIO()
    pdf = NumberedCanvas(buffer, pagesize=PAGE_SIZE, pageCompression=1)
    title = _plain(getattr(item, 'file_name', '') or 'Creative unavailable')
    _header(pdf, title, 'Creative decision sheet')
    pdf.setFillColor(colors.HexColor('#fff7f7'))
    pdf.setStrokeColor(STATUS_COLORS['red'])
    pdf.setLineWidth(1.2)
    pdf.roundRect(54, 116, PAGE_WIDTH - 108, 350, 6, fill=1, stroke=1)
    pdf.setFillColor(STATUS_COLORS['red'])
    pdf.setFont(FONT_BOLD, 18)
    pdf.drawCentredString(PAGE_WIDTH / 2, 342, 'Review could not be completed')
    pdf.setFillColor(colors.HexColor('#526173'))
    pdf.setFont(FONT_REGULAR, 9)
    _draw_wrapped_lines(
        pdf,
        getattr(item, 'message', '') or 'No result is available for this creative.',
        x=112,
        y_top=310,
        width=PAGE_WIDTH - 224,
        font_name=FONT_REGULAR,
        font_size=9,
        leading=13,
        max_lines=5,
        color=colors.HexColor('#526173'),
    )
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def build_and_store_batch_pdf(
    batch: ReviewBatch,
    offer_id: str | None = None,
) -> PdfArtifact:
    if not all(item.status in TERMINAL_BATCH_STATUSES for item in batch.items):
        raise ValueError('Batch PDF is available after every item reaches a terminal state.')
    if offer_id and not any(
        outcome.offer_id == offer_id and outcome.evaluation_state == 'evaluated'
        for item in batch.items
        for outcome in item.offer_outcomes
    ):
        raise KeyError(offer_id)
    writer = PdfWriter()
    for item in batch.items:
        if item.status != 'complete' or not item.job_id:
            failed_bytes = _failed_creative_pdf(item)
            for page in PdfReader(io.BytesIO(failed_bytes)).pages:
                writer.add_page(page)
            continue
        try:
            artifact = ensure_review_pdf(item.job_id, offer_id)
            report_bytes = read_pdf_artifact(artifact)
            for page in PdfReader(io.BytesIO(report_bytes)).pages:
                writer.add_page(page)
        except Exception:
            logger.exception('Could not include review PDF for batch item %s.', item.item_id)
    path = batch_pdf_path(batch.batch_id, offer_id)
    temporary = path.with_suffix('.tmp.pdf')
    with temporary.open('wb') as output:
        writer.write(output)
    os.replace(temporary, path)
    filename = _batch_filename(batch, _batch_offer_name(batch, offer_id))
    persist_pdf_artifact('batch', batch.batch_id, path, filename, offer_id)
    return PdfArtifact(filename=filename, path=path)


def ensure_batch_pdf(
    batch_id: str,
    offer_id: str | None = None,
    *,
    force: bool = False,
) -> PdfArtifact:
    if not force:
        artifact = get_pdf_artifact('batch', batch_id, offer_id)
        if artifact is not None:
            return artifact
    batch = storage.get_batch(batch_id)
    return build_and_store_batch_pdf(batch, offer_id)
