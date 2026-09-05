from html.parser import HTMLParser
from types import SimpleNamespace

import httpx
import pytest

from app.review_pipeline import telegram, storage, jobs
from app.review_pipeline.models import (
    BatchReviewContext, JobRecord, JobStatus, OfferOutcome, ReviewBatch,
    ReviewBatchItem, ReviewRequestMeta,
)


@pytest.fixture(autouse=True)
def isolated_notifications(monkeypatch, tmp_path):
    monkeypatch.setenv('APP_PUBLIC_URL', 'https://admin.adchecked.com')
    monkeypatch.delenv('TELEGRAM_BOT_TOKEN', raising=False)
    monkeypatch.delenv('TELEGRAM_CHAT_ID', raising=False)
    monkeypatch.setattr(storage, 'CONVEX_URL', '')
    monkeypatch.setattr(storage, 'CONVEX_HTTP_SECRET', '')
    monkeypatch.setattr(storage, 'JOB_DATA_DIR', tmp_path)


def item(index, status='green', offer='kissterra', **kwargs):
    return ReviewBatchItem(
        item_id=str(index), file_name=f'creative-{index}.png', media_kind='image',
        status='complete', job_id=f'job-{index}',
        offer_outcomes=[OfferOutcome(offer_id=offer, offer_name=offer.title(),
                                    evaluation_state='evaluated', overall_status=status, **kwargs)],
    )


def batch(items, **kwargs):
    return ReviewBatch(batch_id='sample', created_at=1783450800000, updated_at=1,
                       expected_count=len(items), items=items, **kwargs)


def test_boss_sample_counts_and_each_filtered_link():
    values = [item(i, status) for i, status in enumerate(['red'] * 2 + ['yellow'] * 27 + ['green'] * 18)]
    message = telegram.build_batch_message(batch(values), {})
    assert '47/47 reviewed' in message
    assert 'Client: Kissterra' in message
    assert 'Client: ACP' not in message
    for count, color in [(2, 'red'), (27, 'yellow'), (18, 'green')]:
        assert f'{count} {color}' in message
        assert f'/batches/sample?offer=kissterra&amp;result={color}' in message
    assert 'creative-46.png' not in message
    assert len(message) < 1500


def test_multi_offer_counts_each_item_once_per_client():
    value = item(0, 'yellow')
    value.offer_outcomes.append(OfferOutcome(offer_id='acp', offer_name='ACP', evaluation_state='evaluated', overall_status='red'))
    message = telegram.build_batch_message(batch([value]), {})
    assert message.count('Client:') == 2
    acp, kissterra = message.split('<b>Client: Kissterra</b>')
    assert '1 red' in acp and '0 yellow' in acp
    assert '0 red' in kissterra and '1 yellow' in kissterra


def test_items_for_another_client_are_not_missing_results():
    message = telegram.build_batch_message(batch([item(1, 'green', 'acp'), item(2, 'red', 'kissterra')]), {})
    assert 'results unavailable' not in message
    assert 'done with issues' not in message


@pytest.mark.parametrize('state', ['failed', 'upload_failed'])
def test_failures_are_not_red_verdicts(state):
    failed = item(1)
    failed.status = state
    message = telegram.build_batch_message(batch([failed]), {})
    assert '— failed</b>' in message
    assert '0/1 reviewed' in message
    assert '🔴 0 red' in message and '🟢 0 green' in message
    assert f'result={state}' in message


def test_partial_failure_retains_all_success_counts():
    failure = item(3)
    failure.status = 'upload_failed'
    message = telegram.build_batch_message(batch([item(1, 'green'), item(2, 'yellow'), failure]), {})
    assert 'done with issues' in message
    assert '2/3 reviewed' in message
    assert '1 green' in message and '1 yellow' in message
    assert '1 upload/import failed' in message


@pytest.mark.parametrize('state,label', [('disabled', 'turned off'), ('missing_guidelines', 'guidelines not saved'), ('evaluated', 'results unavailable')])
def test_missing_or_disabled_results_remain_explicit(state, label):
    value = item(0, None)
    value.offer_outcomes[0].evaluation_state = state
    message = telegram.build_batch_message(batch([value]), {})
    assert 'done with issues' in message
    assert label in message
    assert '🟢 0 green' in message
    assert 'result=unavailable' in message


def test_single_result_fallback_uses_actual_client():
    value = item(0, None)
    value.result = 'yellow'
    message = telegram.build_batch_message(batch([value]), {})
    assert 'Client: Kissterra' in message and '1 yellow' in message
    assert 'Client: ACP' not in message


def test_multi_client_primary_result_is_not_copied_to_unknown_results():
    value = item(0, None)
    value.result = 'red'
    value.offer_outcomes.append(OfferOutcome(offer_id='acp', offer_name='ACP', evaluation_state='evaluated'))
    message = telegram.build_batch_message(batch([value]), {})
    assert message.count('results unavailable') == 2
    assert '1 red' not in message


def test_empty_and_pending_batches_do_not_send_completion(monkeypatch):
    calls = []
    monkeypatch.setattr(telegram, '_send_event', lambda *a, **k: calls.append(a))
    assert 'has no items' in telegram.build_batch_message(batch([]), {})
    pending = item(1)
    pending.status = 'queued'
    assert 'in progress' in telegram.build_batch_message(batch([pending]), {})
    assert not telegram.send_batch_message(batch([]))
    assert not telegram.send_batch_message(batch([pending]))
    assert not calls


def test_missing_projection_still_delivers_snapshot(monkeypatch):
    monkeypatch.setattr(storage, 'get_batch_offer_summaries', lambda ids: {})
    sent = []
    monkeypatch.setattr(telegram, '_send_event', lambda key, message: sent.append(message) or True)
    monkeypatch.setattr(telegram, '_attach_batch_pdf', lambda value: True)
    assert telegram.send_batch_message(batch([item(1, 'red')]))
    assert '1 red' in sent[0]


def test_snapshot_override_survives_summary_hydration(monkeypatch):
    monkeypatch.setattr(storage, 'get_batch_offer_summaries', lambda ids: {'job-1': {'offer_results': [{'offer_id': 'kissterra', 'overall_status': 'green'}]}})
    sent = []
    monkeypatch.setattr(telegram, '_send_event', lambda key, message: sent.append(message) or True)
    monkeypatch.setattr(telegram, '_attach_batch_pdf', lambda value: True)
    assert telegram.send_batch_message(batch([item(1, with_override=True)]))
    assert '1 green under an approved internal exception.' in sent[0]


class ValidHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
    def handle_starttag(self, tag, attrs):
        assert tag in {'b', 'i', 'a'}
        self.stack.append(tag)
    def handle_endtag(self, tag):
        assert self.stack.pop() == tag


def test_large_multiclient_message_splits_without_broken_html_or_lost_counts():
    values = [item(i, 'red', offer=f'client-{i}') for i in range(30)]
    for value in values:
        value.offer_outcomes[0].offer_name = '<&" Client ' + '🟢' * 80
    message = telegram.build_batch_message(batch(values, source_label='<script>& Review'), {})
    parts = telegram._message_parts(message)
    assert len(parts) > 1
    assert sum(part.count('Client:') for part in parts) == 30
    for part in parts:
        assert telegram._telegram_length(part) <= 3900
        parser = ValidHTML()
        parser.feed(part)
        assert not parser.stack
    assert '<script>' not in message


@pytest.mark.parametrize('kind', ['video', 'image', 'copy_only'])
def test_single_review_types_and_client_link(kind):
    record = JobRecord(job_id='one', primary_offer_id='kissterra', offer_ids=['kissterra'],
                       has_creative=kind != 'copy_only', has_ad_copy=kind == 'copy_only')
    message = telegram.build_review_message(record, {'overall_status': 'green'}, media_kind=kind)
    assert 'review done' in message
    assert 'Client: Kissterra' in message
    assert '1 green' in message
    assert '/reviews/one/report?offer=kissterra' in message
    assert 'Client: ACP' not in message


@pytest.mark.parametrize('event', ['queued', 'retrying', 'recovered', 'failed'])
@pytest.mark.parametrize('live_kind', [None, 'copy', 'creative'])
def test_lifecycle_events_identify_client_and_link_job(monkeypatch, event, live_kind):
    sent = []
    monkeypatch.setattr(telegram, '_send_event', lambda key, message: sent.append((key, message)) or True)
    meta = ReviewRequestMeta(live_scan_kind=live_kind, live_scan_account_name='Buying account')
    assert telegram.send_job_event(JobRecord(job_id='one', file_name='one.png', offer_ids=['kissterra']), meta, event, 'Safe failure or progress reason')
    key, message = sent[0]
    assert event in key
    assert 'Kissterra' in message and '/reviews/one' in message
    if live_kind:
        assert 'Live ' in message and '/live-scans' in message
    if event == 'failed':
        assert 'No verdict was produced' in message
        assert '/report' not in message


def test_partner_api_events_stay_out_of_shared_telegram(monkeypatch):
    monkeypatch.setattr(telegram, '_send_event', lambda *a, **k: pytest.fail('Tenant data sent to shared Telegram'))
    meta = ReviewRequestMeta(api_partner_id='private-partner')
    assert not telegram.send_job_event(JobRecord(job_id='one'), meta, 'failed', 'Failure')
    assert not telegram.send_review_started(JobRecord(job_id='one'), meta)


@pytest.mark.parametrize('status', ['failed', 'no_matches'])
def test_scheduled_noop_and_failure_alerts(monkeypatch, status):
    sent = []
    monkeypatch.setattr(telegram, '_send_event', lambda key, message: sent.append((key, message)) or True)
    assert telegram.send_automation_event(SimpleNamespace(name='Daily creatives'), 'run-id', status, 'No new files or unable to read source')
    assert status in sent[0][0]
    assert 'Daily creatives' in sent[0][1] and '/automations' in sent[0][1]


def test_notification_exception_cannot_escape_into_review_job(monkeypatch):
    monkeypatch.setattr(telegram, '_send_event', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('bad notification')))
    assert not telegram.send_job_event(JobRecord(job_id='one'), ReviewRequestMeta(), 'retrying', 'Retrying')
    assert not telegram.send_review_message(JobRecord(job_id='one'), {'overall_status': 'green'})


def test_failed_individual_job_sends_failure_event(monkeypatch):
    import asyncio
    storage.set_status('failed-job', JobStatus.queued, 0, 'Queued', 'Copy', has_creative=False)
    async def fail_review(*args):
        raise RuntimeError('Provider unavailable')
    monkeypatch.setattr(jobs, 'review_with_openrouter', fail_review)
    sent = []
    monkeypatch.setattr(jobs, 'send_job_event', lambda record, meta, event, message: sent.append(event))
    asyncio.run(jobs.process_job('failed-job', None, 'copy_only', ReviewRequestMeta(ad_copy='Test copy')))
    assert storage.get_status('failed-job').status == JobStatus.failed
    assert sent == ['failed']


def test_durable_delivery_enqueues_claims_and_records_failure(monkeypatch):
    monkeypatch.setattr(storage, 'convex_enabled', lambda: True)
    monkeypatch.setattr(telegram, 'telegram_enabled', lambda: True)
    calls = []
    def convex(kind, function, args):
        calls.append((function, args))
        if function.endswith(':enqueue'): return 'pending'
        if function.endswith(':claim'): return {'eventKey': 'one', 'claimId': 'claim-1', 'message': 'Message'}
        return True
    monkeypatch.setattr(storage, '_convex_call', convex)
    monkeypatch.setattr(telegram, '_send_telegram_message', lambda *args: False)
    assert not telegram._send_event('one', 'Message')
    assert calls[-1] == ('telegramNotifications:finish', {'eventKey': 'one', 'claimId': 'claim-1', 'success': False})


def test_durable_sent_event_is_not_sent_twice(monkeypatch):
    monkeypatch.setattr(storage, 'convex_enabled', lambda: True)
    monkeypatch.setattr(storage, '_convex_call', lambda *args: 'sent')
    monkeypatch.setattr(telegram, '_send_telegram_message', lambda *args: pytest.fail('duplicate message'))
    assert telegram._send_event('one', 'Message')


def test_pending_alert_is_recovered_by_drain(monkeypatch):
    monkeypatch.setattr(storage, 'convex_enabled', lambda: True)
    monkeypatch.setattr(telegram, 'telegram_enabled', lambda: True)
    deliveries = iter([{'eventKey': 'one', 'claimId': 'recovered', 'message': 'Message'}, None])
    calls = []
    def convex(kind, function, args):
        if function.endswith(':claim'): return next(deliveries)
        if function.endswith(':finish'): calls.append(args)
        return True
    monkeypatch.setattr(storage, '_convex_call', convex)
    monkeypatch.setattr(telegram, '_send_telegram_message', lambda *args: True)
    assert telegram.deliver_pending_telegram_notifications() == 1
    assert calls[0]['claimId'] == 'recovered' and calls[0]['success']


def test_missing_credentials_preserve_pending_notification(monkeypatch):
    monkeypatch.setattr(storage, 'convex_enabled', lambda: True)
    calls = []
    monkeypatch.setattr(storage, '_convex_call', lambda kind, function, args: calls.append(function) or 'pending')
    assert not telegram._send_event('one', 'Message')
    assert calls == ['telegramNotifications:enqueue']
    assert telegram.deliver_pending_telegram_notifications() == 0


def test_pdf_failure_has_separate_alert_and_keeps_result_sent(monkeypatch):
    storage.set_status('one', JobStatus.complete, 100, 'Complete')
    sent = []
    monkeypatch.setattr(telegram, '_send_telegram_message', lambda message, context: sent.append(message) or True)
    monkeypatch.setattr(telegram, '_attach_review_pdf', lambda *args: False)
    assert telegram.send_review_message(JobRecord(job_id='one'), {'overall_status': 'green'})
    assert len(sent) == 2
    assert '1 green' in sent[0]
    assert 'PDF attachment unavailable' in sent[1]


@pytest.mark.parametrize('code,attempts', [(400, 1), (401, 1), (403, 1), (429, 3), (500, 3)])
def test_telegram_transport_retry_policy(monkeypatch, code, attempts):
    monkeypatch.setenv('TELEGRAM_BOT_TOKEN', 'test-token')
    monkeypatch.setenv('TELEGRAM_CHAT_ID', 'test-chat')
    sent = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs):
            sent.append(kwargs)
            return httpx.Response(code, request=httpx.Request('POST', url), json={'ok': False})
    monkeypatch.setattr(telegram.httpx, 'Client', Client)
    monkeypatch.setattr(telegram.time, 'sleep', lambda seconds: None)
    assert not telegram._send_telegram_message('Message', 'test')
    assert len(sent) == attempts
