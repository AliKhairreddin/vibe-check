from __future__ import annotations

import html
import hashlib
from functools import wraps
import logging
import os
import textwrap
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import httpx

from .media import MediaKind
from .models import JobRecord, OfferOutcome, ReviewBatch, ReviewBatchItem, ReviewRequestMeta

logger = logging.getLogger(__name__)

STATUS_LABELS = {
    'complete': 'Complete',
    'failed': 'Failed',
    'green': '🟢 Green — Ready to run',
    'yellow': '🟡 Yellow — Fix or review before publishing',
    'red': '🔴 Red — Critical stop',
}
RESULT_STATUSES = {'green', 'yellow', 'red'}
LEGACY_RESULT_STATUSES = {
    'pass': 'green',
    'amber': 'yellow',
    'yellow': 'yellow',
    'orange': 'yellow',
    'needs_review': 'yellow',
    'likely_violation': 'red',
}
WRAP_WIDTH = 34
MAX_NAME_CHARS = 140
MAX_BATCH_MESSAGE_CHARS = 3900
TELEGRAM_SEND_ATTEMPTS = 3
TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024
OFFER_DISPLAY_ORDER = (
    ('acp', 'ACP'),
    ('kissterra', 'Kissterra'),
    ('leadeconomy', 'Lead Economy'),
    ('smartfinancial', 'Smart Financial'),
)
NOT_REVIEWED_LABEL = '⚪ N/A — Not reviewed'
DISABLED_LABEL = '⚪ N/A — Turned off'
MISSING_GUIDELINES_LABEL = '⚪ N/A — Guidelines not saved'


def _best_effort_notification(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except Exception as exc:
            logger.error('Telegram notification unavailable handler=%s error_type=%s', function.__name__, type(exc).__name__)
            return False
    return wrapped


def telegram_enabled() -> bool:
    return bool(
        os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
        and os.getenv('TELEGRAM_CHAT_ID', '').strip()
    )


def build_report_url(job_id: str, offer_id: str = '') -> str:
    base_url = os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/')
    return _filtered_url(f'{base_url}/reviews/{job_id}/report', offer_id) if base_url else ''


def build_batch_url(batch_id: str, offer_id: str = '', result: str = '') -> str:
    base_url = os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/')
    return _filtered_url(f'{base_url}/batches/{batch_id}', offer_id, result) if base_url else ''


def _filtered_url(url: str, offer_id: str = '', result: str = '') -> str:
    query = {key: value for key, value in {'offer': offer_id, 'result': result}.items() if value}
    return f'{url}?{urlencode(query)}' if query else url


def build_live_scans_url() -> str:
    base_url = os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/')
    return f'{base_url}/live-scans' if base_url else ''


def build_review_message(
    record: JobRecord,
    report: dict[str, Any],
    ad_copy_text: str = '',
    media_kind: MediaKind | None = None,
) -> str:
    kind = 'Creative' if record.has_creative else 'Ad copy'
    lines = [f'<b>{kind} review done</b>']
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

    # Legacy single-offer reports need the job's actual client, not an ACP guess.
    report = {**report, 'primary_offer_id': report.get('primary_offer_id') or record.primary_offer_id}
    for offer_name, offer_report in _ordered_offer_reports(report):
        if offer_report is None:
            continue
        offer_id = str(offer_report.get('offer_id') or record.primary_offer_id)
        lines.extend(_client_summary(offer_name, [offer_report], lambda result: build_report_url(record.job_id, offer_id)))
        if record.has_creative and record.has_ad_copy:
            for key, label in [('creative', 'Creative'), ('ad_copy', 'Ad copy')]:
                source = _source_result(offer_report, key)
                if source:
                    lines.append(f'{label}: {html.escape(_format_offer_status(source["status"]))}')
    _add_report_link(lines, build_report_url(record.job_id), 'Open report')
    return '\n'.join(lines)


@_best_effort_notification
def send_review_message(
    record: JobRecord,
    report: dict[str, Any],
    ad_copy_text: str = '',
    media_kind: MediaKind | None = None,
) -> bool:
    sent = _send_event(
        f'review:{record.job_id}:complete',
        build_review_message(record, report, ad_copy_text, media_kind),
        pdf_job_id=record.job_id,
    )
    return sent


def build_live_scan_message(
    record: JobRecord,
    report: dict[str, Any],
    meta: ReviewRequestMeta,
    media_kind: MediaKind | None = None,
) -> str:
    kind_label='Creative' if meta.live_scan_kind == 'creative' else 'Primary text'
    lines=[f'<b>Live {html.escape(kind_label.lower())} review done</b>']
    if meta.live_scan_account_name:
        _add_field(lines,'Meta account',meta.live_scan_account_name)
    if meta.live_scan_creative_name:
        _add_field(lines,'Creative name',meta.live_scan_creative_name)
    if meta.live_scan_kind == 'creative':
        _add_field(lines,'Type',_creative_type_label(media_kind))
    elif meta.ad_copy:
        _add_field(lines,'Primary text',_wrap_text(meta.ad_copy,max_chars=MAX_NAME_CHARS))
    if meta.live_scan_observation_date:
        _add_field(lines,'Observed live',meta.live_scan_observation_date)

    report = {**report, 'primary_offer_id': report.get('primary_offer_id') or record.primary_offer_id}
    for offer_name,offer_report in _ordered_offer_reports(report):
        if offer_report is not None:
            offer_id = str(offer_report.get('offer_id') or record.primary_offer_id)
            lines.extend(_client_summary(offer_name, [offer_report], lambda result: build_report_url(record.job_id, offer_id)))

    report_url=build_report_url(record.job_id)
    live_url=build_live_scans_url()
    if report_url or live_url:
        lines.extend(['','<b>Links:</b>'])
    if live_url:
        lines.append(
            f'<a href="{html.escape(live_url,quote=True)}">Open live scans</a>'
        )
    if report_url:
        lines.append(
            f'<a href="{html.escape(report_url,quote=True)}">Open report</a>'
        )
    return '\n'.join(lines)


@_best_effort_notification
def send_live_scan_message(
    record: JobRecord,
    report: dict[str, Any],
    meta: ReviewRequestMeta,
    media_kind: MediaKind | None = None,
) -> bool:
    sent = _send_event(
        f'review:{record.job_id}:complete',
        build_live_scan_message(record,report,meta,media_kind),
        pdf_job_id=record.job_id,
    )
    return sent


def build_batch_message(
    batch: ReviewBatch,
    reports_by_job_id: dict[str, dict[str, Any]] | None = None,
) -> str:
    complete = sum(item.status == 'complete' for item in batch.items)
    failed = sum(item.status in {'failed', 'upload_failed'} for item in batch.items)
    pending = max(0, batch.expected_count - complete - failed)
    kind = 'Ad copy' if batch.items and all(item.media_kind == 'copy_only' for item in batch.items) else 'Creative'
    state = 'in progress' if pending else 'failed' if failed and not complete else 'done with issues' if failed else 'done'
    if not batch.items:
        state = 'has no items'
    date = datetime.fromtimestamp(batch.created_at / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
    lines = [f'<b>{kind} review {date} — {state}</b>']
    if batch.source_label:
        _add_field(lines, 'Source', batch.source_label)
    lines.append(f'{complete}/{batch.expected_count} reviewed' + (f' · {failed} failed' if failed else ''))
    if pending:
        lines.append(f'⏳ {pending} still pending — final results will follow.')

    groups: dict[str, tuple[str, list[dict[str, Any] | None]]] = {}
    item_reports = []
    for item in batch.items:
        report = None
        if item.status == 'complete':
            report = (reports_by_job_id.get(item.job_id or '') if reports_by_job_id is not None
                      else _load_batch_item_report(item.job_id))
        report = _batch_snapshot_report(item, report, batch)
        known = {}
        for name, value in _ordered_offer_reports(report):
            if value is None:
                continue
            offer_id = str(value.get('offer_id') or '')
            if not offer_id:
                continue
            if offer_id not in groups:
                groups[offer_id] = (name, [])
            known[offer_id] = value
        item_reports.append((item, known))
    for offer_id, (name, reports) in groups.items():
        for item, known in item_reports:
            if item.status == 'complete' and (offer_id in known or not known):
                reports.append(known.get(offer_id))
        lines.extend(_client_summary(name, reports, lambda result: build_batch_url(batch.batch_id, offer_id, result)))
    if not groups and batch.items:
        lines.extend(['', 'Client: unavailable — check the review details.'])
    if state == 'done' and (not groups or any(
        not value or not _overall_status(value)
        for _, reports in groups.values() for value in reports
    )):
        lines[0] = lines[0].replace('— done</b>', '— done with issues</b>')

    upload_failed = sum(item.status == 'upload_failed' for item in batch.items)
    processing_failed = failed - upload_failed
    for count, label, result in [(upload_failed, 'upload/import failed', 'upload_failed'), (processing_failed, 'review failed', 'failed')]:
        if count:
            lines.append(_count_link(f'⚫ {count} {label}', build_batch_url(batch.batch_id, result=result)))
    if failed:
        lines.append('Open the failed items for details and retry instructions.')
    _add_report_link(lines, build_batch_url(batch.batch_id), 'Open batch reports')
    return '\n'.join(lines)


def _batch_snapshot_report(item: ReviewBatchItem, report: dict[str, Any] | None, batch: ReviewBatch) -> dict[str, Any] | None:
    if report is not None:
        return _merge_batch_item_report(item, report)
    if item.offer_outcomes:
        outcomes = [outcome.model_dump(mode='json') for outcome in item.offer_outcomes]
        evaluated = [value for value in outcomes if value['evaluation_state'] == 'evaluated']
        if len(evaluated) == 1 and item.result and not evaluated[0].get('overall_status'):
            evaluated[0]['overall_status'] = item.result
        return {'offer_outcomes': outcomes}
    offer_ids = batch.review_context.offer_ids if batch.review_context else []
    if offer_ids:
        return {'offer_results': [
            {'offer_id': offer_id, 'overall_status': item.result if len(offer_ids) == 1 else None}
            for offer_id in offer_ids
        ]}
    # Only historical batches with no client metadata use the historical ACP default.
    return {'offer_id': 'acp', 'overall_status': item.result} if item.result else None


def _count_link(label: str, url: str) -> str:
    return html.escape(label) + (f' — <a href="{html.escape(url, quote=True)}">Review</a>' if url else '')


def _client_summary(name: str, reports: list[dict[str, Any] | None], url_for_result) -> list[str]:
    lines = ['', f'<b>Client: {html.escape(" ".join(name.split())[:80])}</b>']
    counts = {status: 0 for status in ('red', 'yellow', 'green')}
    unavailable = disabled = missing = overrides = 0
    for report in reports:
        state = _evaluation_state(report)
        status = _overall_status(report) if report else None
        if state == 'disabled':
            disabled += 1
        elif state == 'missing_guidelines':
            missing += 1
        elif status:
            counts[status] += 1
            overrides += int(status == 'green' and _uses_internal_exception(report))
        else:
            unavailable += 1
    for status, emoji in [('red', '🔴'), ('yellow', '🟡'), ('green', '🟢')]:
        lines.append(_count_link(f'{emoji} {counts[status]} {status}', url_for_result(status)))
    for count, label in [(disabled, 'not reviewed — turned off'), (missing, 'not reviewed — guidelines not saved'), (unavailable, 'results unavailable')]:
        if count:
            lines.append(_count_link(f'⚪ {count} {label}', url_for_result('unavailable')))
    if overrides:
        lines.append(f'{overrides} green under an approved internal exception.')
    return lines


@_best_effort_notification
def send_batch_message(batch: ReviewBatch) -> bool:
    from .storage import get_batch_offer_summaries

    if not batch.items or not all(item.status in {'complete', 'failed', 'upload_failed'} for item in batch.items):
        return False
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
        # A saved final snapshot can still be reported when its compact report
        # projection is missing. Unknown results are explicit, never green.
        logger.warning(
            'Telegram batch notification using saved snapshot batch_id=%s job_id=%s',
            batch.batch_id,
            item.job_id or 'unavailable',
        )
    message = build_batch_message(batch, reports_by_job_id)
    revision = hashlib.sha256(message.encode()).hexdigest()[:16]
    sent = all([_send_event(f'batch:{batch.batch_id}:{revision}:{index}', part)
                for index, part in enumerate(_message_parts(message))])
    if sent and any(item.status == 'complete' for item in batch.items):
        if not _attach_batch_pdf(batch):
            _pdf_unavailable(f'batch:{batch.batch_id}:{revision}', build_batch_url(batch.batch_id))
    return sent


def _message_parts(message: str) -> list[str]:
    # Split between complete HTML lines, never inside a tag or escaped entity.
    parts: list[str] = []
    current: list[str] = []
    for line in message.splitlines():
        if _telegram_length(line) > MAX_BATCH_MESSAGE_CHARS:
            raise ValueError('A Telegram message line exceeds the supported length.')
        if _telegram_length('\n'.join([*current, line])) > MAX_BATCH_MESSAGE_CHARS and current:
            parts.append('\n'.join(current))
            current = ['<b>Review summary continued</b>']
        current.append(line)
    if current:
        parts.append('\n'.join(current))
    return parts


def _telegram_length(text: str) -> int:
    return len(text.encode('utf-16-le')) // 2


def _send_event(event_key: str, message: str, *, pdf_job_id: str | None = None) -> bool:
    from .storage import _convex_call, convex_enabled

    if _telegram_length(message) > MAX_BATCH_MESSAGE_CHARS:
        parts = _message_parts(message)
        return all([_send_event(f'{event_key}:part:{index}', part,
                                pdf_job_id=pdf_job_id if index == len(parts) - 1 else None)
                    for index, part in enumerate(parts)])
    if not convex_enabled():
        sent = _send_telegram_message(message, f'event={event_key}')
        if sent and pdf_job_id:
            _deliver_review_pdf(event_key, pdf_job_id)
        return sent
    try:
        status = _convex_call('mutation', 'telegramNotifications:enqueue', {
            'eventKey': event_key, 'message': message,
            **({'pdfJobId': pdf_job_id} if pdf_job_id else {}),
        })
        if status == 'sent':
            return True
        if not telegram_enabled():
            return False
        delivery = _convex_call('mutation', 'telegramNotifications:claim', {'eventKey': event_key})
        return _deliver_event(delivery) if isinstance(delivery, dict) else False
    except Exception as exc:
        logger.error('Telegram event could not be delivered event=%s error_type=%s', event_key, type(exc).__name__)
        return False


def _deliver_event(delivery: dict[str, Any]) -> bool:
    from .storage import _convex_call

    sent = _send_telegram_message(delivery['message'], f'event={delivery["eventKey"]}')
    updated = _convex_call('mutation', 'telegramNotifications:finish', {
        'eventKey': delivery['eventKey'], 'claimId': delivery['claimId'], 'success': sent,
    })
    if sent and updated and delivery.get('pdfJobId'):
        _deliver_review_pdf(delivery['eventKey'], delivery['pdfJobId'])
    return sent


def deliver_pending_telegram_notifications(*, limit: int = 5) -> int:
    from .storage import _convex_call, convex_enabled

    if not convex_enabled() or not telegram_enabled():
        return 0
    _convex_call('mutation', 'telegramNotifications:queueStalledBatches', {
        'appUrl': os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/'),
    })
    delivered = 0
    for _ in range(max(1, min(limit, 10))):
        delivery = _convex_call('mutation', 'telegramNotifications:claim', {})
        if not isinstance(delivery, dict):
            break
        delivered += int(_deliver_event(delivery))
    return delivered


def _deliver_review_pdf(event_key: str, job_id: str) -> None:
    from .storage import get_status

    try:
        attached = _attach_review_pdf(get_status(job_id), f'job_id={job_id}')
    except Exception:
        attached = False
    if not attached:
        _pdf_unavailable(event_key, build_report_url(job_id))


def _pdf_unavailable(event_key: str, url: str) -> None:
    _send_event(f'{event_key}:pdf', '\n'.join([
        '<b>Review done — PDF attachment unavailable</b>',
        'The review results are saved. Open the review to view results or retry the PDF download.',
        _count_link('Review details', url),
    ]))


@_best_effort_notification
def send_job_event(record: JobRecord | str, meta: ReviewRequestMeta, event: str, message: str, *, attempt: int = 0) -> bool:
    # Partner API tenants receive their isolated signed webhooks.
    if meta.api_partner_id:
        return False
    if isinstance(record, str):
        from .storage import get_status
        record = get_status(record)
    title = {
        'queued': 'Review queued', 'retrying': 'Review delayed — retrying',
        'recovered': 'Review resumed after interruption', 'failed': 'Review failed',
    }[event]
    if meta.live_scan_kind:
        title = f'Live {"creative" if meta.live_scan_kind == "creative" else "primary text"} — {title.lower()}'
    lines = [f'<b>{title}</b>']
    names = [profile.display_name for profile in meta.offer_profiles]
    if not names:
        names = [_offer_display_name({'offer_id': value}, _offer_identity(value)) for value in record.offer_ids]
    _add_field(lines, 'Client', ', '.join(names), max_chars=300)
    _add_field(lines, 'Name', meta.live_scan_creative_name or record.file_name or record.job_id)
    if meta.live_scan_account_name:
        _add_field(lines, 'Meta account', meta.live_scan_account_name)
    _add_field(lines, 'Status', message, max_chars=400)
    if event == 'failed':
        lines.append('No verdict was produced. Open the job details and retry the review.')
    url = build_batch_url(meta.batch_id) if meta.batch_id else build_report_url(record.job_id).removesuffix('/report')
    _add_report_link(lines, url, 'Open review details')
    if meta.live_scan_kind:
        _add_report_link(lines, build_live_scans_url(), 'Open live scans')
    return _send_event(f'review:{record.job_id}:{event}:{attempt}', '\n'.join(lines))


@_best_effort_notification
def send_review_started(record: JobRecord, meta: ReviewRequestMeta) -> bool:
    if meta.api_partner_id:
        return False
    if not meta.has_batch:
        return send_job_event(record, meta, 'queued', 'Review queued. Results will follow when processing finishes.')
    from .storage import get_batch
    batch = get_batch(meta.batch_id or '')
    names = ', '.join(profile.display_name for profile in meta.offer_profiles)
    lines = ['<b>Review batch started</b>']
    _add_field(lines, 'Client', names, max_chars=300)
    if batch.source_label:
        _add_field(lines, 'Source', batch.source_label)
    lines.append(f'{batch.expected_count} items submitted. A client summary will follow when all items finish.')
    _add_report_link(lines, build_batch_url(batch.batch_id), 'Open batch progress')
    return _send_event(f'batch:{batch.batch_id}:started', '\n'.join(lines))


@_best_effort_notification
def send_automation_event(automation, run_id: str, status: str, message: str) -> bool:
    titles = {'no_matches': 'Scheduled review — no new creatives', 'failed': 'Scheduled review could not start'}
    lines = [f'<b>{titles[status]}</b>']
    _add_field(lines, 'Schedule', automation.name)
    _add_field(lines, 'Status', message, max_chars=400)
    if status == 'failed':
        lines.append('Check Drive access, enabled offers, and saved guidelines, then retry the schedule.')
    base = os.getenv('APP_PUBLIC_URL', '').strip().rstrip('/')
    _add_report_link(lines, f'{base}/automations' if base else '', 'Open schedules')
    return _send_event(f'automation:{run_id}:{status}', '\n'.join(lines))


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
                'with_override':result.get('internal_disposition') == 'accepted_with_override' or snapshot.with_override,
                'message':(
                    'Green under the saved current internal rules.'
                    if result.get('internal_disposition') == 'accepted_with_override'
                    else 'Evaluated using the effective saved policy.'
                ),
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
            'message':(
                'Green under the saved current internal rules.'
                if result.get('internal_disposition') == 'accepted_with_override'
                else 'Evaluated using the effective saved policy.'
            ),
            'offer_id':offer_id,
            'offer_name':str(result.get('offer_name') or offer_id),
            'overall_status':status,
            'with_override':result.get('internal_disposition') == 'accepted_with_override',
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
    if all(item.status in {'complete', 'failed', 'upload_failed'} for item in batch.items):
        try:
            from .pdf_reports import ensure_batch_pdf
            ensure_batch_pdf(batch_id)
        except Exception:
            logger.exception('Could not generate combined PDF report for batch %s.', batch_id)
    if should_notify:
        success = send_batch_message(batch)
        if mark_batch_notification(batch_id, success, batch.notification_claim_id):
            batch.notification_claim_id = None
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
                    if response.json().get('ok') is not True:
                        raise RuntimeError('Telegram did not acknowledge the notification.')
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


def _attach_review_pdf(record: JobRecord, log_context: str) -> bool:
    try:
        from .pdf_reports import ensure_review_pdf, read_pdf_artifact

        artifact = ensure_review_pdf(record.job_id)
        content = read_pdf_artifact(artifact)
        caption = (
            '<b>Unified creative PDF</b>\n'
            f'{html.escape(record.file_name or record.job_id)} · all offers'
        )
        return _send_telegram_document(
            artifact.filename,
            content,
            caption,
            log_context,
        )
    except Exception as exc:
        logger.warning(
            'Telegram PDF attachment unavailable %s error_type=%s',
            log_context,
            type(exc).__name__,
        )
        return False


def _attach_batch_pdf(batch: ReviewBatch) -> bool:
    log_context = f'batch_id={batch.batch_id}'
    try:
        from .pdf_reports import ensure_batch_pdf, read_pdf_artifact

        artifact = ensure_batch_pdf(batch.batch_id)
        content = read_pdf_artifact(artifact)
        caption = (
            '<b>Unified batch PDF</b>\n'
            f'All {batch.expected_count} creatives · all offers'
        )
        return _send_telegram_document(
            artifact.filename,
            content,
            caption,
            log_context,
        )
    except Exception as exc:
        logger.warning(
            'Telegram PDF attachment unavailable %s error_type=%s',
            log_context,
            type(exc).__name__,
        )
        return False


def _send_telegram_document(
    filename: str,
    content: bytes,
    caption: str,
    log_context: str,
) -> bool:
    token = os.getenv('TELEGRAM_BOT_TOKEN', '').strip()
    chat_id = os.getenv('TELEGRAM_CHAT_ID', '').strip()
    if not token or not chat_id:
        return False
    if not content or len(content) > TELEGRAM_DOCUMENT_MAX_BYTES:
        logger.warning(
            'Telegram PDF attachment skipped %s bytes=%s',
            log_context,
            len(content),
        )
        return False

    payload: dict[str, Any] = {
        'chat_id': chat_id,
        'caption': caption,
        'parse_mode': 'HTML',
    }
    message_thread_id = os.getenv('TELEGRAM_MESSAGE_THREAD_ID', '').strip()
    if message_thread_id:
        payload['message_thread_id'] = message_thread_id

    last_error: Exception | None = None
    attempts = 0
    try:
        with httpx.Client(timeout=30) as client:
            for attempt in range(1, TELEGRAM_SEND_ATTEMPTS + 1):
                attempts = attempt
                try:
                    response = client.post(
                        f'https://api.telegram.org/bot{token}/sendDocument',
                        data=payload,
                        files={
                            'document': (
                                filename,
                                content,
                                'application/pdf',
                            ),
                        },
                    )
                    response.raise_for_status()
                    if response.json().get('ok') is not True:
                        raise RuntimeError('Telegram did not acknowledge the document.')
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
        'Telegram PDF attachment failed %s attempts=%s error_type=%s http_status=%s',
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
        'internal_disposition': (
            'accepted_with_override'
            if value.get('with_override') is True
            else None
        ),
        'overall_status': (value.get('automated_status') or value.get('overall_status')) if evaluated else None,
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


def _uses_internal_exception(report: dict[str, Any] | None) -> bool:
    return bool(
        isinstance(report, dict)
        and report.get('internal_disposition') == 'accepted_with_override'
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
