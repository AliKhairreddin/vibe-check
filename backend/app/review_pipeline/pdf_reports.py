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
PAGE_SIZE = landscape(letter)
PAGE_WIDTH, PAGE_HEIGHT = PAGE_SIZE
TERMINAL_BATCH_STATUSES = {'complete', 'failed', 'upload_failed'}
STATUS_COLORS = {
    'green': colors.HexColor('#16803a'),
    'yellow': colors.HexColor('#b77900'),
    'orange': colors.HexColor('#c45a08'),
    'red': colors.HexColor('#c62828'),
}
STATUS_LABELS = {
    'green': 'Green - Ready to run',
    'yellow': 'Yellow - Minor fixes',
    'orange': 'Orange - Review required',
    'red': 'Red - Do not publish',
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


def review_pdf_path(job_id: str) -> Path:
    return storage.job_dir(job_id) / 'report.pdf'


def batch_pdf_path(batch_id: str) -> Path:
    path = storage.JOB_DATA_DIR / 'batches' / f'{batch_id}-report.pdf'
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _artifact_path(owner_type: ArtifactOwnerType, owner_id: str) -> Path:
    return review_pdf_path(owner_id) if owner_type == 'review' else batch_pdf_path(owner_id)


def _safe_filename(value: str, fallback: str) -> str:
    stem = Path(value).stem.strip() if value else ''
    stem = re.sub(r'[^A-Za-z0-9._ -]+', '-', stem)
    stem = re.sub(r'\s+', ' ', stem).strip(' .-_')
    return f'{(stem or fallback)[:120]}-report.pdf'


def _review_filename(record: JobRecord) -> str:
    return _safe_filename(record.file_name, record.job_id)


def _batch_filename(batch: ReviewBatch) -> str:
    label = batch.source_label or f'batch-{batch.batch_id[:8]}'
    return _safe_filename(label, f'batch-{batch.batch_id[:8]}')


def get_pdf_artifact(owner_type: ArtifactOwnerType, owner_id: str) -> PdfArtifact | None:
    local_path = _artifact_path(owner_type, owner_id)
    if local_path.exists() and local_path.stat().st_size:
        filename = local_path.name
        try:
            filename = (
                _review_filename(storage.get_status(owner_id))
                if owner_type == 'review'
                else _batch_filename(storage.get_batch(owner_id))
            )
        except (FileNotFoundError, ValueError):
            pass
        return PdfArtifact(filename=filename, path=local_path)
    remote = storage._convex_call(
        'query',
        'reportArtifacts:get',
        {'ownerType': owner_type, 'ownerId': owner_id},
    )
    if not isinstance(remote, dict) or not remote.get('url'):
        return None
    return PdfArtifact(
        filename=str(remote.get('filename') or local_path.name),
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
                'ownerId': owner_id,
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
    try:
        return float(value)
    except (TypeError, ValueError):
        match = re.search(r'\d+(?:\.\d+)?', str(value))
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
    return STATUS_COLORS.get(str(status), colors.HexColor('#64748b'))


def _draw_status_pill(pdf: canvas.Canvas, x: float, y: float, status: Any, label: str | None = None) -> None:
    status_text = str(status or 'not available')
    text = label or STATUS_LABELS.get(status_text, status_text.replace('_', ' ').title())
    color = _status_color(status)
    pdf.setFillColor(colors.Color(color.red, color.green, color.blue, alpha=0.10))
    pdf.setStrokeColor(color)
    pdf.roundRect(x, y, 150, 24, 6, fill=1, stroke=1)
    pdf.setFillColor(color)
    pdf.setFont(FONT_BOLD, 8)
    pdf.drawCentredString(x + 75, y + 8, _plain(text)[:34])


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
    evidence: bool = False,
    placeholder: str = 'No creative frame is available for this report.',
) -> None:
    border = colors.HexColor('#c62828') if evidence else colors.HexColor('#4f83c2')
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

    flow_y = PAGE_HEIGHT - 139
    pdf.setFillColor(colors.HexColor('#f2f4f7'))
    pdf.rect(10, flow_y - 54, PAGE_WIDTH - 20, 70, fill=1, stroke=0)
    pdf.setFillColor(colors.HexColor('#111827'))
    pdf.setFont(FONT_BOLD, 9)
    pdf.drawString(58, flow_y - 2, 'Creative evidence')
    pdf.drawCentredString(PAGE_WIDTH / 2, flow_y - 2, 'Automated policy review')
    pdf.drawRightString(PAGE_WIDTH - 58, flow_y - 2, 'Offer outcomes')
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
        name = _plain(offer.get('offer_name') or offer.get('offer_id') or 'Offer')
        pdf.setFillColor(colors.HexColor('#111827'))
        pdf.setFont(FONT_BOLD, 9)
        pdf.drawString(412, y + 8, name[:42])
        _draw_status_pill(pdf, 582, y, offer.get('overall_status'))
        y -= 38
    if len(offers) > 6:
        pdf.setFillColor(colors.HexColor('#667085'))
        pdf.setFont(FONT_REGULAR, 8)
        pdf.drawString(412, y + 8, f'{len(offers) - 6} additional offer results are included in the report.')
        y -= 24
    primary = offers[0] if offers else report
    styles = _styles()
    summary = _paragraph(primary.get('summary') or 'No review summary was returned.', styles['body'])
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
        ('Observed evidence', _plain(finding.get('evidence'))),
        ('Why it matters', _plain(finding.get('policy_reason'))),
        ('Suggested fix', _plain(finding.get('suggested_fix'))),
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
) -> list[Any]:
    source = str(finding.get('source') or 'policy')
    source_label = SOURCE_LABELS.get(source, source.replace('_', ' ').title())
    timestamp = timestamp_label(finding.get('timestamp_start'))
    offer_name = _plain(offer.get('offer_name') or offer.get('offer_id') or 'Offer')
    _header(
        pdf,
        f'{offer_name} finding {index} of {count}',
        f'{record.file_name or record.job_id} | {source_label} | {timestamp}',
    )
    _draw_status_pill(
        pdf,
        PAGE_WIDTH - 188,
        PAGE_HEIGHT - 88,
        offer.get('overall_status'),
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
        evidence=True,
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
) -> list[Any]:
    offer_name = _plain(offer.get('offer_name') or offer.get('offer_id') or 'Offer')
    _header(
        pdf,
        f'{offer_name} finding {finding_index} continued',
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


def generate_review_report_pdf(
    target: Path | io.BytesIO,
    record: JobRecord,
    report: dict[str, Any],
    *,
    frames_dir: Path | None = None,
    frames: Sequence[dict[str, Any]] = (),
    transcript: dict[str, Any] | None = None,
    ad_copy: str = '',
) -> None:
    if isinstance(target, Path):
        target.parent.mkdir(parents=True, exist_ok=True)
    canvas_target = str(target) if isinstance(target, Path) else target
    pdf = NumberedCanvas(canvas_target, pagesize=PAGE_SIZE, pageCompression=1)
    pdf.setTitle(f'{record.file_name or record.job_id} - Compliance Evidence Report')
    pdf.setAuthor('Vibe Check')
    _summary_page(pdf, record, report, frames_dir, frames)
    pdf.showPage()
    findings = _all_findings(report)
    for finding_index, (offer, finding) in enumerate(findings, start=1):
        remaining = _finding_page(
            pdf,
            record,
            offer,
            finding,
            finding_index,
            len(findings),
            frames_dir,
            frames,
            transcript,
            ad_copy,
        )
        pdf.showPage()
        while remaining:
            remaining = _continuation_page(pdf, record, offer, finding_index, remaining)
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
) -> PdfArtifact:
    path = review_pdf_path(job_id)
    filename = _review_filename(record)
    generate_review_report_pdf(
        path,
        record,
        report,
        frames_dir=frames_dir,
        frames=frames,
        transcript=transcript,
        ad_copy=ad_copy,
    )
    persist_pdf_artifact('review', job_id, path, filename)
    return PdfArtifact(filename=filename, path=path)


def ensure_review_pdf(job_id: str) -> PdfArtifact:
    record = storage.get_status(job_id)
    artifact = get_pdf_artifact('review', job_id)
    if artifact is not None:
        return artifact
    report = storage.get_report(job_id)
    if report is None:
        raise FileNotFoundError(job_id)
    return build_and_store_review_pdf(job_id, record, report)


def _batch_offer_summary(item: Any) -> str:
    outcomes = getattr(item, 'offer_outcomes', None) or []
    values = []
    for outcome in outcomes:
        if outcome.evaluation_state != 'evaluated':
            continue
        status = outcome.overall_status or 'not rated'
        values.append(f'{outcome.offer_name}: {status.title()}')
    if values:
        return ' | '.join(values)
    return str(getattr(item, 'result', None) or getattr(item, 'status', 'not available')).replace('_', ' ').title()


def _batch_cover_pdf(batch: ReviewBatch) -> bytes:
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
        pdf.drawString(468, table_top - 17, 'Offer outcomes')
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
            status_color = _status_color(item.result) if item.status == 'complete' else colors.HexColor('#64748b')
            pdf.setFillColor(status_color)
            pdf.setFont(FONT_BOLD, 8)
            pdf.drawString(370, y + 15, _plain(item.status).replace('_', ' ').title())
            pdf.setFillColor(colors.HexColor('#263242'))
            pdf.setFont(FONT_REGULAR, 7)
            pdf.drawString(468, y + 15, _plain(_batch_offer_summary(item))[:70])
        pdf.setFillColor(colors.HexColor('#667085'))
        pdf.setFont(FONT_REGULAR, 8)
        pdf.drawString(40, 38, f'Batch summary page {page_index} of {len(chunks)}. Individual creative reports follow.')
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def build_and_store_batch_pdf(batch: ReviewBatch) -> PdfArtifact:
    if not all(item.status in TERMINAL_BATCH_STATUSES for item in batch.items):
        raise ValueError('Batch PDF is available after every item reaches a terminal state.')
    writer = PdfWriter()
    cover_bytes = _batch_cover_pdf(batch)
    for page in PdfReader(io.BytesIO(cover_bytes)).pages:
        writer.add_page(page)
    for item in batch.items:
        if item.status != 'complete' or not item.job_id:
            continue
        try:
            artifact = ensure_review_pdf(item.job_id)
            report_bytes = read_pdf_artifact(artifact)
            for page in PdfReader(io.BytesIO(report_bytes)).pages:
                writer.add_page(page)
        except Exception:
            logger.exception('Could not include review PDF for batch item %s.', item.item_id)
    path = batch_pdf_path(batch.batch_id)
    temporary = path.with_suffix('.tmp.pdf')
    with temporary.open('wb') as output:
        writer.write(output)
    os.replace(temporary, path)
    filename = _batch_filename(batch)
    persist_pdf_artifact('batch', batch.batch_id, path, filename)
    return PdfArtifact(filename=filename, path=path)


def ensure_batch_pdf(batch_id: str, *, force: bool = False) -> PdfArtifact:
    if not force:
        artifact = get_pdf_artifact('batch', batch_id)
        if artifact is not None:
            return artifact
    batch = storage.get_batch(batch_id)
    return build_and_store_batch_pdf(batch)
