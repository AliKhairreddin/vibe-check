from __future__ import annotations

import html
import logging
import os
import textwrap
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from .media import MediaKind
from .models import JobRecord, OfferOutcome, ReviewBatch

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
TELEGRAM_SEND_ATTEMPTS = 3
OFFER_DISPLAY_ORDER = (
    ('acp', 'ACP'),
    ('kissterra', 'Kissterra'),
    ('leadeconomy', 'Lead Economy'),
    ('smartfinancial', 'Smart Financial'),
)
NOT_REVIEWED_LABEL = '⚪ N/A — Not reviewed'
DISABLED_LABEL = '⚪ N/A — Turned off'
MISSING_GUIDELINES_LABEL = '⚪ N/A — Guidelines not saved'


def telegram_enabled() -> bool:
    return bool(
        os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
        and os.getenv('TELEGRAM_CHAT_ID', '').strip()
    )


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
        _add_source_identity(
            lines,
            _creative_type_label(media_kind),
            record.file_name or record.job_id,
        )
    if record.has_ad_copy:
        _add_source_identity(
            lines,
            'Ad copy',
            _ad_copy_name(record, ad_copy_text),
        )

    lines.extend(['', '<b>Result:</b>'])
    for offer_name, offer_report in _ordered_offer_reports(report):
        _add_offer_result(
            lines,
            offer_name,
            offer_report,
            include_source_split=record.has_creative and record.has_ad_copy,
        )

    _add_report_link(lines, report_url, 'Open report')
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


def build_batch_message(
    batch: ReviewBatch,
    reports_by_job_id: dict[str, dict[str, Any]] | None = None,
) -> str:
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
        section = [
            '',
            f'<b>Type:</b> {html.escape(_batch_type_label(item.media_kind))}',
            '<b>Name:</b>',
            html.escape(_wrap_text(item.file_name, max_chars=MAX_NAME_CHARS)),
            '<b>Result:</b>',
        ]

        if item.status == 'complete':
            report = (
                reports_by_job_id.get(item.job_id)
                if reports_by_job_id is not None and item.job_id
                else _load_batch_item_report(item.job_id)
            )
            snapshot_report = None
            if item.offer_outcomes:
                snapshot_report = {
                    'offer_outcomes': [
                        outcome.model_dump(mode='json')
                        for outcome in item.offer_outcomes
                    ],
                }
            if report is None:
                report = snapshot_report
            if report is None and item.result:
                report = {'offer_id': 'acp', 'overall_status': item.result}
            for offer_name, offer_report in _ordered_offer_reports(report):
                section.append(
                    _offer_status_line(
                        offer_name,
                        _overall_status(offer_report) if offer_report else None,
                        _evaluation_state(offer_report),
                    )
                )
        else:
            section.append('⚫ Failed — Review did not complete')
            if item.message:
                section.extend([
                    '<b>Failure:</b>',
                    html.escape(_wrap_text(item.message, max_chars=MAX_NAME_CHARS)),
                ])

        remaining_after_item = len(batch.items) - index - 1
        reserved_tail = _truncation_notice(remaining_after_item) if remaining_after_item else []
        if len('\n'.join([*lines, *section, *reserved_tail, *footer])) > MAX_BATCH_MESSAGE_CHARS:
            remaining = len(batch.items) - index
            notice = _truncation_notice(remaining)
            if len('\n'.join([*lines, *notice, *footer])) <= MAX_BATCH_MESSAGE_CHARS:
                lines.extend(notice)
            break
        lines.extend(section)

    lines.extend(footer)
    return '\n'.join(lines)


def send_batch_message(batch: ReviewBatch) -> bool:
    from .storage import get_batch_offer_summaries

    complete_job_ids=[
        item.job_id
        for item in batch.items
        if item.status == 'complete' and item.job_id
    ]
    try:
        summaries=get_batch_offer_summaries(complete_job_ids)
    except Exception as exc:
        logger.warning(
            'Telegram batch summary lookup failed batch_id=%s error_type=%s',
            batch.batch_id,
            type(exc).__name__,
        )
        return False
    reports_by_job_id: dict[str, dict[str, Any]] = {}
    for item in batch.items:
        if item.status != 'complete':
            continue
        report=summaries.get(item.job_id or '')
        if report is not None and item.job_id:
            reports_by_job_id[item.job_id] = _merge_batch_item_report(item, report)
            continue
        if item.job_id:
            logger.warning(
                'Telegram batch notification deferred until offer summaries are available batch_id=%s job_id=%s',
                batch.batch_id,
                item.job_id,
            )
            return False
        outcomes_are_final = bool(item.offer_outcomes) and all(
            outcome.evaluation_state != 'evaluated'
            or outcome.overall_status is not None
            for outcome in item.offer_outcomes
        )
        if outcomes_are_final or item.result:
            continue
        logger.warning(
            'Telegram batch notification deferred until report is available batch_id=%s job_id=%s',
            batch.batch_id,
            item.job_id or 'unavailable',
        )
        return False
    return _send_telegram_message(
        build_batch_message(batch, reports_by_job_id),
        f'batch_id={batch.batch_id}',
    )


def _merge_batch_item_report(item, report: dict[str, Any]) -> dict[str, Any]:
    if not item.offer_outcomes or isinstance(report.get('offer_outcomes'), list):
        return report
    raw_results=report.get('offer_results')
    results=(
        [value for value in raw_results if isinstance(value, dict)]
        if isinstance(raw_results, list)
        else [report]
    )
    by_offer_id={
        str(value.get('offer_id') or report.get('primary_offer_id') or 'acp'):value
        for value in results
    }
    outcomes=[]
    seen=set()
    for snapshot in item.offer_outcomes:
        value=snapshot.model_dump(mode='json')
        result=by_offer_id.get(snapshot.offer_id)
        status=_overall_status(result) if result else None
        if status:
            value.update({
                'evaluation_state':'evaluated',
                'overall_status':status,
                'message':'Evaluated using the saved official guidelines.',
            })
        outcomes.append(value)
        seen.add(snapshot.offer_id)
    for offer_id,result in by_offer_id.items():
        if offer_id in seen:
            continue
        status=_overall_status(result)
        if not status:
            continue
        outcomes.append({
            'evaluation_state':'evaluated',
            'message':'Evaluated using the saved official guidelines.',
            'offer_id':offer_id,
            'offer_name':str(result.get('offer_name') or offer_id),
            'overall_status':status,
        })
    return {'offer_outcomes':outcomes}


def finish_batch_item_and_notify(
    batch_id: str,
    item_id: str,
    *,
    status: str,
    job_id: str | None = None,
    result: str | None = None,
    offer_outcomes: list[OfferOutcome] | None = None,
    message: str = '',
) -> ReviewBatch:
    from .storage import finish_batch_item, mark_batch_notification

    batch, should_notify = finish_batch_item(
        batch_id,
        item_id,
        status=status,
        job_id=job_id,
        result=result,
        offer_outcomes=offer_outcomes,
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

    last_error: Exception | None = None
    attempts = 0
    try:
        with httpx.Client(timeout=15) as client:
            for attempt in range(1, TELEGRAM_SEND_ATTEMPTS + 1):
                attempts = attempt
                try:
                    response = client.post(
                        f'https://api.telegram.org/bot{token}/sendMessage',
                        json=payload,
                    )
                    response.raise_for_status()
                    return True
                except Exception as exc:
                    last_error = exc
                    if attempt >= TELEGRAM_SEND_ATTEMPTS or not _is_retryable_telegram_error(exc):
                        break
                    time.sleep(_telegram_retry_delay(exc, attempt))
    except Exception as exc:
        last_error = exc

    response = getattr(last_error, 'response', None)
    status_code = getattr(response, 'status_code', None)
    logger.error(
        'Telegram notification failed %s attempts=%s error_type=%s http_status=%s',
        log_context,
        attempts or 1,
        type(last_error).__name__ if last_error is not None else 'UnknownError',
        status_code if status_code is not None else 'unavailable',
    )
    return False


def _add_source_identity(
    lines: list[str],
    type_label: str,
    name: str,
) -> None:
    lines.extend(['', f'<b>Type:</b> {html.escape(type_label)}'])
    _add_field(lines, 'Name', name, max_chars=MAX_NAME_CHARS)


def _add_offer_result(
    lines: list[str],
    offer_name: str,
    report: dict[str, Any] | None,
    *,
    include_source_split: bool,
) -> None:
    status = _overall_status(report) if report else None
    evaluation_state = _evaluation_state(report)
    lines.append(
        _offer_status_line(
            offer_name,
            status,
            evaluation_state,
        )
    )
    if (
        report is None
        or not include_source_split
        or evaluation_state in {'disabled', 'missing_guidelines'}
    ):
        return

    creative = _source_result(report, 'creative')
    ad_copy = _source_result(report, 'ad_copy')
    lines.append(
        f'  <b>Creative:</b> {html.escape(_format_offer_status(creative.get("status") if creative else None))}'
    )
    lines.append(
        f'  <b>Ad copy:</b> {html.escape(_format_offer_status(ad_copy.get("status") if ad_copy else None))}'
    )


def _add_report_link(lines: list[str], report_url: str, link_text: str) -> None:
    if report_url:
        lines.extend(['', '<b>Report Link:</b>'])
        lines.append(
            f'<a href="{html.escape(report_url, quote=True)}">'
            f'{html.escape(link_text)}</a>'
        )


def _load_batch_item_report(job_id: str | None) -> dict[str, Any] | None:
    if not job_id:
        return None

    try:
        from .storage import get_report

        report = get_report(job_id)
        return report if isinstance(report, dict) else None
    except Exception as exc:
        logger.warning(
            'Telegram batch report lookup failed job_id=%s error_type=%s',
            job_id,
            type(exc).__name__,
        )
        return None


def _ordered_offer_reports(
    report: dict[str, Any] | None,
) -> list[tuple[str, dict[str, Any] | None]]:
    reports: list[dict[str, Any]] = []
    if isinstance(report, dict):
        raw_outcomes = report.get('offer_outcomes')
        if isinstance(raw_outcomes, list):
            reports.extend(
                outcome_report
                for value in raw_outcomes
                if (outcome_report := _report_from_offer_outcome(value)) is not None
            )

        nested = report.get('offer_results')
        if isinstance(nested, list) and any(isinstance(item, dict) for item in nested):
            reports.extend(item for item in nested if isinstance(item, dict))
        if not reports:
            reports = [report]

    by_identity: dict[str, tuple[str, dict[str, Any]]] = {}
    extra_identities: list[str] = []
    fallback_identity = _offer_identity(
        report.get('primary_offer_id') or report.get('offer_id')
        if isinstance(report, dict)
        else ''
    )
    canonical_identities = {identity for identity, _ in OFFER_DISPLAY_ORDER}

    for index, offer_report in enumerate(reports):
        raw_identity = offer_report.get('offer_id') or offer_report.get('offer_name')
        identity = _offer_identity(raw_identity)
        if not identity and index == 0:
            identity = fallback_identity or 'acp'
        if not identity or identity in by_identity:
            continue

        display_name = _offer_display_name(offer_report, identity)
        by_identity[identity] = (display_name, offer_report)
        if identity not in canonical_identities:
            extra_identities.append(identity)

    ordered: list[tuple[str, dict[str, Any] | None]] = [
        (display_name, by_identity.get(identity, ('', None))[1])
        for identity, display_name in OFFER_DISPLAY_ORDER
    ]
    ordered.extend(by_identity[identity] for identity in extra_identities)
    return ordered


def _report_from_offer_outcome(value: Any) -> dict[str, Any] | None:
    if hasattr(value, 'model_dump'):
        value = value.model_dump(mode='json')
    if not isinstance(value, dict):
        return None

    evaluation_state = str(value.get('evaluation_state') or '')
    evaluated = evaluation_state == 'evaluated'
    source_results: dict[str, dict[str, Any]] = {}
    if evaluated and value.get('creative_result'):
        source_results['creative'] = {'status': value['creative_result']}
    if evaluated and value.get('ad_copy_result'):
        source_results['ad_copy'] = {'status': value['ad_copy_result']}
    return {
        'offer_id': value.get('offer_id'),
        'offer_name': value.get('offer_name'),
        'evaluation_state': evaluation_state,
        'overall_status': value.get('overall_status') if evaluated else None,
        'source_results': source_results,
    }


def _offer_identity(value: Any) -> str:
    return ''.join(character for character in str(value or '').casefold() if character.isalnum())


def _offer_display_name(report: dict[str, Any], identity: str) -> str:
    name = str(report.get('offer_name') or '').strip()
    if name:
        return name
    offer_id = str(report.get('offer_id') or '').strip()
    if offer_id:
        return offer_id.replace('-', ' ').replace('_', ' ').title()
    return identity.title()


def _offer_status_line(
    offer_name: str,
    status: Any,
    evaluation_state: str = '',
) -> str:
    return (
        f'<b>{html.escape(offer_name)}:</b> '
        f'{html.escape(_format_offer_status(status, evaluation_state))}'
    )


def _truncation_notice(remaining: int) -> list[str]:
    if remaining <= 0:
        return []
    return [
        '',
        f'<i>{remaining} more item(s) are listed on the batch report page.</i>',
    ]


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


def _format_offer_status(status: Any, evaluation_state: str = '') -> str:
    normalized = _normalize_result_status(status)
    if normalized:
        return _format_status(normalized)
    if evaluation_state == 'disabled':
        return DISABLED_LABEL
    if evaluation_state == 'missing_guidelines':
        return MISSING_GUIDELINES_LABEL
    return NOT_REVIEWED_LABEL


def _evaluation_state(report: dict[str, Any] | None) -> str:
    return str(report.get('evaluation_state') or '') if report else ''


def _is_retryable_telegram_error(exc: Exception) -> bool:
    response = getattr(exc, 'response', None)
    status_code = getattr(response, 'status_code', None)
    if isinstance(status_code, int):
        return status_code in {408, 425, 429} or status_code >= 500
    return isinstance(exc, httpx.TransportError)


def _telegram_retry_delay(exc: Exception, attempt: int) -> float:
    response = getattr(exc, 'response', None)
    if getattr(response, 'status_code', None) == 429:
        try:
            payload=response.json()
            retry_after=payload.get('parameters', {}).get('retry_after')
            if retry_after is not None:
                return max(0.0, min(float(retry_after), 60.0))
        except (AttributeError, TypeError, ValueError):
            pass
    headers = getattr(response, 'headers', None)
    retry_after = headers.get('retry-after') if headers is not None else None
    if retry_after:
        try:
            return max(0.0, min(float(retry_after), 60.0))
        except (TypeError, ValueError):
            pass
    return min(0.25 * (2 ** (attempt - 1)), 1.0)


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
