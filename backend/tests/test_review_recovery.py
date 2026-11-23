import asyncio
import json

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


def test_recovery_sends_the_observed_snapshot_for_both_terminal_decisions(monkeypatch):
    calls = []

    def convex_call(kind, path, args):
        calls.append((kind, path, args))
        if path == 'reviews:listInterrupted':
            return [{'jobId': 'job', 'status': 'processing_video', 'updatedAt': 456,
                     'processingInstanceId': 'old-container'}]
        if path == 'reviews:failInterrupted':
            return {'failedJobIds': [item['jobId'] for item in args['snapshots']]}
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

    assert recovery.fail_unrecoverable_jobs([review]) == ['job']
    assert calls[2][2]['snapshots'] == [{'jobId': 'job', 'expectedUpdatedAt': 456}]


MANIFEST_EVENTS = ['ready', 'gone', 'HTTP 503', 'batch deadline', 'incomplete JSON']


@pytest.mark.anyio
@pytest.mark.parametrize('first', MANIFEST_EVENTS)
@pytest.mark.parametrize('second', MANIFEST_EVENTS)
async def test_recovery_source_model(tmp_path, monkeypatch, first, second):
    jobs = {'ready', 'changing', 'missing'}
    enqueued = []
    missing = []
    event = first
    release = asyncio.Event()

    async def source(reader, writer):
        try:
            request = await reader.readuntil(b'\r\n\r\n')
            job_id = request.split()[1].decode().lstrip('/')
            outcome = event if job_id == 'changing' else 'ready'
            if outcome == 'batch deadline':
                await release.wait()
            body = json.dumps({
                'version': 1, 'job_id': job_id, 'file_name': 'copy.txt', 'media_kind': 'copy_only',
                'meta': {'batch_id': 'batch', 'batch_item_id': job_id},
            }).encode()
            if outcome == 'incomplete JSON':
                body = b'{'
            status = {'gone': 404, 'HTTP 503': 503}.get(outcome, 200)
            writer.write(f'HTTP/1.1 {status} Response\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body)
            await writer.drain()
        finally:
            writer.close()

    def list_reviews():
        return [recovery.InterruptedReview(
            job_id=job_id, file_name='copy.txt', file_size=None, source_kind=None,
            source_file_id=None, source_url=None, batch_id='batch', batch_item_id=job_id,
            offer_ids=('offer',), has_ad_copy=True,
        ) for job_id in sorted(jobs)]

    def fail(reviews):
        for review in reviews:
            jobs.remove(review.job_id)
            missing.append(review.job_id)
        return [review.job_id for review in reviews]

    async def enqueue(job_id, *args, **kwargs):
        jobs.remove(job_id)
        enqueued.append(job_id)

    monkeypatch.setattr(storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(queue, 'list_interrupted_reviews', list_reviews)
    monkeypatch.setattr(queue, 'fail_unrecoverable_jobs', fail)
    monkeypatch.setattr(queue, 'claim_interrupted_review', lambda _: True)
    monkeypatch.setattr(queue, 'enqueue_job', enqueue)
    async with await asyncio.start_server(source, '127.0.0.1', 0) as server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setattr(recovery, '_list_payload_rows_sync', lambda ids: [
            {'jobId': job_id, 'manifestUrl': f'http://127.0.0.1:{port}/{job_id}'}
            for job_id in ids if job_id != 'missing'
        ])
        expected_queued = {'ready'}
        expected_failed = {'missing'}
        for event in (first, second):
            if event == 'batch deadline':
                monkeypatch.setattr(recovery, 'MANIFEST_BATCH_DEADLINE_SECONDS', 3.0)
            else:
                monkeypatch.setattr(recovery, 'MANIFEST_BATCH_DEADLINE_SECONDS', 35.0)
            release = asyncio.Event()
            try:
                await queue.recover_interrupted_jobs()
            finally:
                release.set()
            if 'changing' not in expected_queued | expected_failed:
                if event == 'ready':
                    expected_queued.add('changing')
                if event == 'gone':
                    expected_failed.add('changing')
            assert sorted(enqueued) == sorted(expected_queued)
            assert sorted(missing) == sorted(expected_failed)


@pytest.mark.anyio
@pytest.mark.parametrize('eventually_available', [True, False])
async def test_uploaded_review_retries_manifest_reads_within_its_attempt_limit(
    tmp_path, monkeypatch, eventually_available,
):
    work = asyncio.Queue()
    monkeypatch.setattr(queue, '_queue', work)
    monkeypatch.setattr(storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(storage, 'convex_enabled', lambda: False)
    monkeypatch.setattr(queue, 'send_job_event', lambda *_args, **_kwargs: None)
    monkeypatch.setenv('JOB_MAX_ATTEMPTS', '3')
    job = queue.QueuedReviewJob('upload', tmp_path / 'clip.mp4', 'video', ReviewRequestMeta(), attempt=2)
    payload = recovery.RecoveredReviewPayload(
        'upload', 'clip.mp4', 5, 'video', job.meta, media_url='https://example.test/media',
    )
    deferred = recovery.ManifestAvailability.RETRY_LATER
    reads = [deferred, payload if eventually_available else deferred]

    async def lookup(_ids):
        return {'upload': reads.pop(0)}

    async def restore(_payload, path):
        path.write_bytes(b'video')

    async def process(job_id, path, _kind, _meta):
        assert path.read_bytes() == b'video'
        storage.set_status(job_id, JobStatus.complete, 100)

    monkeypatch.setattr(queue, 'load_recovery_payloads', lookup)
    monkeypatch.setattr(queue, 'restore_media', restore)
    monkeypatch.setattr(queue, 'process_job', process)
    await work.put(job)
    worker = asyncio.create_task(queue._process_queue(0))
    try:
        await asyncio.wait_for(work.join(), timeout=5)
    finally:
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker
    assert not reads
    record = storage.get_status(job.job_id)
    assert record.status == (JobStatus.complete if eventually_available else JobStatus.failed)
    if not eventually_available:
        assert 'after 3 attempts' in record.message
