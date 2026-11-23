import asyncio
import json
import subprocess
import time
from uuid import uuid4

import httpx
import pytest

from app.review_pipeline import queue, recovery, storage


def import_reviews(tmp_path, rows):
    snapshot = tmp_path / 'reviews.json'
    snapshot.write_text(json.dumps(rows))
    subprocess.run(['./node_modules/.bin/convex', 'import', '--append', '--table', 'reviews',
                    str(snapshot)], check=True)


@pytest.mark.parametrize(('unavailable', 'hang', 'passes'), [(16, True, 3), (501, False, 2)])
def test_recovery_reaches_the_available_manifest_after_older_deferrals(
    tmp_path, monkeypatch, unavailable, hang, passes,
):
    prefix = uuid4().hex
    first_update = 1_700_000_000_000
    ids = [f'{prefix}-{n}' for n in range(unavailable + 1)]
    healthy = ids[-1]
    rows = [{
        'jobId': job, 'status': 'queued', 'fileName': 'copy.txt', 'message': 'Queued',
        'reportReady': False, 'progress': 0, 'createdAt': first_update + i, 'updatedAt': first_update + i,
    } for i, job in enumerate(ids)]
    import_reviews(tmp_path, rows)
    observed = []
    attempted = set()
    queued = []
    original_list = recovery.list_interrupted_reviews
    original_client = httpx.AsyncClient

    def select():
        reviews = [review for review in original_list() if review.job_id.startswith(prefix)]
        observed.extend(reviews)
        return reviews

    async def respond(request):
        job = request.url.path[1:]
        attempted.add(job)
        if job != healthy:
            if hang:
                await asyncio.Event().wait()
            return httpx.Response(503)
        return httpx.Response(200, json={
            'version': 1, 'job_id': job, 'file_name': 'copy.txt', 'media_kind': 'copy_only', 'meta': {},
        })

    async def enqueue(job_id, *args, **kwargs):
        queued.append(job_id)

    monkeypatch.setattr(queue, 'list_interrupted_reviews', select)
    monkeypatch.setattr(queue, 'enqueue_job', enqueue)
    monkeypatch.setattr(recovery, '_list_payload_rows_sync', lambda selected: [
        {'jobId': job, 'manifestUrl': f'https://storage.test/{job}'} for job in selected
    ])
    monkeypatch.setattr(recovery.httpx, 'AsyncClient', lambda **kw: original_client(
        **kw, transport=httpx.MockTransport(respond),
    ))
    monkeypatch.setattr(storage, 'JOB_DATA_DIR', tmp_path)
    monkeypatch.setattr(recovery, 'MANIFEST_BATCH_DEADLINE_SECONDS', .5 if hang else 35)
    for _ in range(passes):
        result = asyncio.run(queue.recover_interrupted_jobs())
        assert result['failed'] == 0
    assert queued == [healthy], f'{healthy} did not reach the queue in {passes} scans'
    assert attempted == set(ids)

    initial = {review.job_id: review for review in reversed(observed)}
    for job in (ids[0], healthy):
        args = {'snapshots': [{'jobId': job, 'expectedUpdatedAt': initial[job].updated_at}]}
        assert storage._convex_call('mutation', 'reviews:deferInterrupted', args) == 0
    stored = storage.get_status(ids[0])
    assert stored.updated_at == initial[ids[0]].updated_at
    assert stored.status.value == 'queued'


def test_deferred_review_reenters_selection_and_ignores_stale_observations(tmp_path):
    now = int(time.time() * 1000)
    old = now - 3 * 60 * 60 * 1000
    eligible, waiting = uuid4().hex, uuid4().hex
    import_reviews(tmp_path, [{
        'jobId': job, 'status': 'queued', 'fileName': 'copy.txt', 'message': 'Queued',
        'reportReady': False, 'progress': 0, 'createdAt': old, 'updatedAt': old,
        'recoveryLastTriedAt': attempted,
    } for job, attempted in [(eligible, old), (waiting, now)]])
    selected = {review.job_id: review for review in recovery.list_interrupted_reviews()}
    assert selected[eligible].recovery_last_tried_at == old
    assert waiting not in selected

    def defer(updated_at, last_tried):
        return storage._convex_call('mutation', 'reviews:deferInterrupted', {'snapshots': [{
            'jobId': eligible, 'expectedUpdatedAt': updated_at, 'expectedLastTriedAt': last_tried,
        }]})

    assert defer(old - 1, old) == 0
    assert defer(old, old - 1) == 0
    assert defer(old, old) == 1
    assert defer(old, old) == 0
    assert eligible not in {review.job_id for review in recovery.list_interrupted_reviews()}
