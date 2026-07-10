from __future__ import annotations

import html
import logging
import os
import textwrap
from datetime import datetime, timezone
from typing import Any

import httpx

from .media import MediaKind
from .models import JobRecord, ReviewBatch

logger = logging.getLogger(__name__)

STATUS_LABELS = {
    'complete': 'Complete',
    'failed': 'Failed',
    'green': '🟢 Green — Ready to run',
    'yellow': '🟡 Yellow — Minor fixes',
    'orange': '🟠 Orange — Review required',
    'red': '🔴 Red — Do not publish',
}
RESULT_STATUSES = {'green', 'yellow', 'orange', 'red'}
LEGACY_RESULT_STATUSES = {
    'pass': 'green',
    'needs_review': 'orange',
    'likely_violation': 'red',
}
WRAP_WIDTH = 34
MAX_NAME_CHARS = 140
MAX_BATCH_MESSAGE_CHARS = 3900


def telegram_enabled() -> bool:
    return bool(os.getenv('TELEGRAM_BOT_TOKEN') and os.getenv('TELEGRAM_CHAT_ID'))


def build_report_url(job_id: str) -> str:
    base_url = os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/')
    return f'{base_url}/reviews/{job_id}/report' if base_url else ''


def build_batch_url(batch_id: str) -> str:
    base_url = os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/')
    return f'{base_url}/batches/{batch_id}' if base_url else ''


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
    return _send_telegram_message(
        build_review_message(record, report, ad_copy_text, media_kind),
        f'job_id={record.job_id}',
    )


def build_batch_message(batch: ReviewBatch) -> str:
    title_date = datetime.fromtimestamp(
        batch.created_at / 1000,
        tz=timezone.utc,
    ).strftime('%B %d').replace(' 0', ' ')
    lines = [f'<b>Batch Uploaded {html.escape(title_date)}</b>']
    report_url = build_batch_url(batch.batch_id)
    footer = []
    if report_url:
        footer = [
            '',
            '<b>Report Link:</b>',
            f'<a href="{html.escape(report_url, quote=True)}">Open batch reports</a>',
        ]

    for index, item in enumerate(batch.items):
        result = _format_status(item.result) if item.status == 'complete' else '⚫ Failed — Review did not complete'
        section = [
            '',
            f'<b>Type:</b> {html.escape(_batch_type_label(item.media_kind))}',
            '<b>Name:</b>',
            html.escape(_wrap_text(item.file_name, max_chars=MAX_NAME_CHARS)),
            '<b>Result:</b>',
            html.escape(result),
        ]
        if item.status != 'complete' and item.message:
            section.extend([
                '<b>Failure:</b>',
                html.escape(_wrap_text(item.message, max_chars=MAX_NAME_CHARS)),
            ])
        remaining = len(batch.items) - index
        if len('\n'.join([*lines, *section, *footer])) > MAX_BATCH_MESSAGE_CHARS:
            lines.extend(['', f'<i>{remaining} more item(s) are listed on the batch report page.</i>'])
            break
        lines.extend(section)

    lines.extend(footer)
    return '\n'.join(lines)


def send_batch_message(batch: ReviewBatch) -> bool:
    return _send_telegram_message(
        build_batch_message(batch),
        f'batch_id={batch.batch_id}',
    )


def finish_batch_item_and_notify(
    batch_id: str,
    item_id: str,
    *,
    status: str,
    job_id: str | None = None,
    result: str | None = None,
    message: str = '',
) -> ReviewBatch:
    from .storage import finish_batch_item, mark_batch_notification

    batch, should_notify = finish_batch_item(
        batch_id,
        item_id,
        status=status,
        job_id=job_id,
        result=result,
        message=message,
    )
    if should_notify:
        success = send_batch_message(batch)
        mark_batch_notification(batch_id, success)
        batch.notification_status = 'sent' if success else 'failed'
    return batch


def _send_telegram_message(text: str, log_context: str) -> bool:
    token = os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
    chat_id = os.getenv('TELEGRAM_CHAT_ID', '').strip()
    if not token or not chat_id:
        return False

    payload: dict[str, Any] = {
        'chat_id': chat_id,
        'text': text,
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
            'Telegram notification failed %s error_type=%s http_status=%s',
            log_context,
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
            status = _normalize_result_status(status)
            if status:
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
        return 'green' if status in RESULT_STATUSES else None
    if any(finding.get('severity') == 'high' for finding in relevant):
        return 'red'
    if any(finding.get('severity') == 'medium' for finding in relevant):
        return 'orange'
    return 'yellow'


def _overall_status(report: dict[str, Any]) -> str | None:
    status = report.get('overall_status')
    return _normalize_result_status(status)


def _normalize_result_status(status: Any) -> str | None:
    if status in RESULT_STATUSES:
        return status
    return LEGACY_RESULT_STATUSES.get(status)


def _format_status(status: Any) -> str:
    raw_value = str(status or '').strip()
    value = _normalize_result_status(raw_value) or raw_value
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


def _batch_type_label(media_kind: str) -> str:
    if media_kind == 'video':
        return 'Creative Vid'
    if media_kind == 'image':
        return 'Creative Image'
    if media_kind == 'copy_only':
        return 'Ad copy'
    return 'Creative'
