from __future__ import annotations

import html
import logging
import os
import textwrap
from typing import Any

import httpx

from .media import MediaKind
from .models import JobRecord

logger = logging.getLogger(__name__)

STATUS_LABELS = {
    'complete': 'Complete',
    'failed': 'Failed',
    'likely_violation': 'Likely Violation',
    'needs_review': 'Needs Review',
    'pass': 'Pass',
}
RESULT_STATUSES = {'pass', 'needs_review', 'likely_violation'}
WRAP_WIDTH = 34
MAX_NAME_CHARS = 140


def telegram_enabled() -> bool:
    return bool(os.getenv('TELEGRAM_BOT_TOKEN') and os.getenv('TELEGRAM_CHAT_ID'))


def build_report_url(job_id: str) -> str:
    base_url = os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/')
    return f'{base_url}/reviews/{job_id}/report' if base_url else ''


def build_review_message(
    record: JobRecord,
    report: dict[str, Any],
    ad_copy_text: str = '',
    media_kind: MediaKind | None = None,
) -> str:
    report_url = build_report_url(record.job_id)
    lines = ['<b>Vibe Check Result</b>']

    if record.has_creative:
        _add_source_section(
            lines,
            _creative_type_label(media_kind),
            record.file_name or record.job_id,
            _source_result(report, 'creative'),
            report_url,
        )
    if record.has_ad_copy:
        _add_source_section(
            lines,
            'Ad copy',
            _ad_copy_name(record, ad_copy_text),
            _source_result(report, 'ad_copy'),
            report_url,
        )

    return '\n'.join(lines)


def send_review_message(
    record: JobRecord,
    report: dict[str, Any],
    ad_copy_text: str = '',
    media_kind: MediaKind | None = None,
) -> bool:
    token = os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
    chat_id = os.getenv('TELEGRAM_CHAT_ID', '').strip()
    if not token or not chat_id:
        return False

    payload: dict[str, Any] = {
        'chat_id': chat_id,
        'text': build_review_message(record, report, ad_copy_text, media_kind),
        'parse_mode': 'HTML',
        'disable_web_page_preview': True,
    }

    message_thread_id = os.getenv('TELEGRAM_MESSAGE_THREAD_ID', '').strip()
    if message_thread_id:
        payload['message_thread_id'] = message_thread_id

    try:
        with httpx.Client(timeout=15) as client:
            response = client.post(
                f'https://api.telegram.org/bot{token}/sendMessage',
                json=payload,
            )
            response.raise_for_status()
        return True
    except Exception as exc:
        response = getattr(exc, 'response', None)
        status_code = getattr(response, 'status_code', None)
        logger.error(
            'Telegram notification failed job_id=%s error_type=%s http_status=%s',
            record.job_id,
            type(exc).__name__,
            status_code if status_code is not None else 'unavailable',
        )
        return False


def _add_source_section(
    lines: list[str],
    type_label: str,
    name: str,
    result: dict[str, str] | None,
    report_url: str,
) -> None:
    lines.extend(['', f'<b>Type:</b> {html.escape(type_label)}'])
    _add_field(lines, 'Name', name, max_chars=MAX_NAME_CHARS)
    _add_field(
        lines,
        'Result',
        _format_status(result.get('status') if result else None),
        max_chars=40,
    )
    if report_url:
        lines.append('<b>Report Link:</b>')
        lines.append(
            f'<a href="{html.escape(report_url, quote=True)}">'
            f'Open report</a>'
        )


def _add_field(
    lines: list[str],
    label: str,
    value: Any,
    *,
    max_chars: int = MAX_NAME_CHARS,
) -> None:
    if value in (None, ''):
        return
    lines.append(f'<b>{html.escape(label)}:</b>')
    lines.append(html.escape(_wrap_text(value, max_chars=max_chars)))


def _wrap_text(value: Any, *, max_chars: int) -> str:
    text = ' '.join(str(value).split())
    if len(text) > max_chars:
        text = text[: max_chars - 3].rstrip() + '...'
    wrapped = textwrap.wrap(
        text,
        width=WRAP_WIDTH,
        break_long_words=False,
        break_on_hyphens=False,
    )
    return '\n'.join(wrapped) if wrapped else text


def _source_result(report: dict[str, Any], key: str) -> dict[str, str] | None:
    source_results = report.get('source_results')
    if isinstance(source_results, dict):
        result = source_results.get(key)
        if isinstance(result, dict):
            status = result.get('status')
            if status in RESULT_STATUSES:
                return {
                    'status': status,
                    'summary': str(result.get('summary') or ''),
                }
    if key == 'ad_copy':
        fallback = _split_result(report, lambda source: source == 'ad_copy')
    else:
        fallback = _split_result(report, lambda source: source != 'ad_copy')
    return {'status': fallback, 'summary': ''} if fallback else None


def _split_result(report: dict[str, Any], source_matches) -> str | None:
    status = _overall_status(report)
    findings = report.get('findings')
    if not isinstance(findings, list) or not findings:
        return status

    relevant = [
        finding
        for finding in findings
        if isinstance(finding, dict) and source_matches(str(finding.get('source') or ''))
    ]
    if not relevant:
        return 'pass' if status in RESULT_STATUSES else None
    if any(finding.get('severity') == 'high' for finding in relevant):
        return 'likely_violation'
    return 'needs_review'


def _overall_status(report: dict[str, Any]) -> str | None:
    status = report.get('overall_status')
    return status if status in RESULT_STATUSES else None


def _format_status(status: Any) -> str:
    value = str(status or '').strip()
    if value in STATUS_LABELS:
        return STATUS_LABELS[value]
    return value.replace('_', ' ').title() if value else 'Not returned'


def _ad_copy_name(record: JobRecord, ad_copy_text: str) -> str:
    preview = ' '.join(ad_copy_text.split())
    if preview:
        return f'Ad copy: {preview}'
    if not record.has_creative:
        return record.file_name or record.job_id
    return f'Ad copy for {record.file_name or record.job_id}'


def _creative_type_label(media_kind: MediaKind | None) -> str:
    if media_kind == 'video':
        return 'Creative Vid'
    if media_kind == 'image':
        return 'Creative Image'
    return 'Creative'
