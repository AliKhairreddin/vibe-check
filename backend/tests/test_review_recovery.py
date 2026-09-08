import pytest

from app import platform_monitoring
from app.review_pipeline import queue, recovery, storage
from app.review_pipeline.models import JobStatus, ReviewRequestMeta


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.mark.anyio
@pytest.mark.parametrize(('status', 'owner', 'claimed', 'enqueue_fails', 'expected_events'), [
    ('queued', 'old-container', True, False, 0),
    ('reviewing_with_llm', 'old-container', True, False, 1),
    ('reviewing_with_llm', None, True, False, 0),
    ('reviewing_with_llm', 'old-container', False, False, 0),
    ('reviewing_with_llm', 'old-container', True, True, 0),
])
async def test_recovery_only_announces_claimed_started_work(
    tmp_path, monkeypatch, status, owner, claimed, enqueue_fails, expected_events,
):
    meta = ReviewRequestMeta(batch_id='batch', batch_item_id='item')
    review = recovery.InterruptedReview(
        job_id='job', file_name='copy.txt', file_size=None,
        source_kind=None, source_file_id=None, source_url=None,
        batch_id='batch', batch_item_id='item', offer_ids=('acp',),
        has_ad_copy=True, status=status, updated_at=123, processing_instance_id=owner,
    )
    payload = recovery.RecoveredReviewPayload('job', 'copy.txt', None, 'copy_only', meta)
    enqueued, events, claims = [], [], []

    async def load(_):
        return {'job': payload}

    def claim(value):
        claims.append(value)
        return claimed

    async def enqueue(*args, **kwargs):
        if enqueue_fails:
            raise RuntimeError('Queue unavailable')
        enqueued.append(args[0])

    monkeypatch.setattr(storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(queue, 'list_interrupted_reviews', lambda: [review])
    monkeypatch.setattr(queue, 'load_recovery_payloads', load)
    monkeypatch.setattr(queue, 'claim_interrupted_review', claim)
    monkeypatch.setattr(queue, 'enqueue_job', enqueue)
    monkeypatch.setattr(queue, 'fail_unrecoverable_jobs', lambda _: [])
    monkeypatch.setattr(queue, 'send_job_event', lambda *args: events.append(args))
    result = await queue.recover_interrupted_jobs()
    assert claims == [review]
    assert result == {'failed': 0, 'requeued': int(claimed and not enqueue_fails)}
    assert enqueued == (['job'] if claimed and not enqueue_fails else [])
    assert len(events) == expected_events
    if events:
        assert events[0][0:3] == ('job', meta, 'recovered')


def test_status_records_the_same_owner_as_platform_heartbeats(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(storage, '_convex_call_with_retry', lambda *args: calls.append(args))
    storage.set_status('job', JobStatus.queued, 0, file_name='creative.mp4')
    assert calls[0][2]['processingInstanceId'] == platform_monitoring.INSTANCE_ID


def test_recovery_preserves_status_owner_and_snapshot_for_atomic_claim(monkeypatch):
    calls = []

    def convex_call(kind, path, args):
        calls.append((kind, path, args))
        if path == 'reviews:listInterrupted':
            return [{'jobId': 'job', 'status': 'processing_video', 'updatedAt': 456,
                     'processingInstanceId': 'old-container'}]
        return True

    monkeypatch.setattr(storage, 'convex_enabled', lambda: True)
    monkeypatch.setattr(storage, '_convex_call', convex_call)
    review, = recovery.list_interrupted_reviews()
    assert review.status == 'processing_video'
    assert review.processing_instance_id == 'old-container'
    assert recovery.claim_interrupted_review(review)
    assert calls[0][2]['idleInstanceId'] == platform_monitoring.INSTANCE_ID
    assert calls[1] == ('mutation', 'reviews:claimInterrupted', {
        'jobId': 'job', 'expectedUpdatedAt': 456, 'instanceId': platform_monitoring.INSTANCE_ID,
    })
