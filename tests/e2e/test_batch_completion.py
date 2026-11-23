import asyncio
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
import pytest

from app.main import app
from app.review_pipeline import storage
from app.review_pipeline.models import CreateBatchItem


@pytest.fixture(scope='module', autouse=True)
def local_database():
    assert os.environ.get('CONVEX_DEPLOYMENT') == 'anonymous:anonymous-agent'
    assert urlsplit(storage.CONVEX_URL).hostname == '127.0.0.1'
    assert storage.CONVEX_HTTP_SECRET == 'batch-completion-test'


def create_batch(count=2):
    items = [
        CreateBatchItem(item_id=f'item-{i}', file_name=f'creative-{i}.mp4', media_kind='video')
        for i in range(count)
    ]
    return storage.create_batch(uuid4().hex, items, offer_outcomes=[]).batch_id


def finish(batch_id, index=0, **changes):
    return storage.finish_batch_item(batch_id, f'item-{index}', **{
        'status': 'complete', 'job_id': f'job-{index}', 'result': 'yellow',
        'message': 'Complete', **changes,
    })


def test_concurrent_completions_persist_every_item_and_claim_one_notification():
    batch_id = create_batch(85)
    with ThreadPoolExecutor(max_workers=3) as workers:
        completions = list(workers.map(lambda i: finish(batch_id, i), range(85)))
    owners = [batch for batch, should_notify in completions if should_notify]
    assert len(owners) == 1
    assert all(item.status == 'complete' for item in owners[0].items)
    persisted = storage.get_batch(batch_id)
    assert [(item.job_id, item.status) for item in persisted.items] == [
        (f'job-{i}', 'complete') for i in range(85)
    ]
    assert persisted.notification_claim_id
    assert persisted.notification_claim_id == owners[0].notification_claim_id


def test_replayed_completion_preserves_the_batch_and_notification_claim():
    batch_id = create_batch()
    outcome = {'offerId': 'offer', 'offerName': 'Offer', 'evaluationState': 'evaluated',
               'overallStatus': 'yellow', 'message': 'Evaluated'}
    payload = {'secret': storage.CONVEX_HTTP_SECRET, 'batchId': batch_id, 'itemId': 'item-0',
               'jobId': 'job-0', 'status': 'complete', 'message': 'Complete', 'offerOutcomes': [outcome]}
    with httpx.Client(base_url=storage.CONVEX_URL) as client:
        def submit():
            response = client.post('/api/mutation', json={'path': 'batches:finishItem', 'args': payload})
            response.raise_for_status()
            assert response.json()['status'] == 'success'
            return response.json()['value']['shouldNotify']

        assert submit() is False
        before = storage.get_batch(batch_id)
        payload['offerOutcomes'] = [dict(reversed(outcome.items()))]
        assert submit() is False
        assert storage.get_batch(batch_id) == before

    _, should_notify = finish(batch_id, 1)
    assert should_notify
    claimed = storage.get_batch(batch_id)
    assert finish(batch_id, 1)[1] is False
    assert storage.get_batch(batch_id) == claimed


def test_late_failure_keeps_the_completed_item_in_the_batch_api():
    async def scenario():
        batch_id, item_id, sibling_id = [uuid4().hex for _ in range(3)]
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            created = await client.post('/api/batches', json={
                'batch_id': batch_id,
                'items': [{'item_id': item, 'file_name': 'creative.mp4', 'media_kind': 'video'}
                          for item in [item_id, sibling_id]],
            })
            created.raise_for_status()
            storage.finish_batch_item(batch_id, item_id, status='complete', job_id='job', result='green')
            expected = (await client.get(f'/api/batches/{batch_id}')).raise_for_status().json()
            assert expected['items'][0]['status'] == 'complete'
            late = await client.post(f'/api/batches/{batch_id}/items/{item_id}/failed',
                                     json={'message': 'Late worker failure'})
            assert late.raise_for_status().json()['items'][0]['status'] == 'complete'
            fetched = await client.get(f'/api/batches/{batch_id}')
            assert fetched.raise_for_status().json() == expected

    asyncio.run(scenario())


def test_retry_accepts_the_replacement_job_and_rejects_its_predecessor():
    batch_id = create_batch()
    finish(batch_id, status='upload_failed', result=None)
    assert storage.claim_batch_item_retry(batch_id, 'item-0')
    storage.update_batch_item(batch_id, 'item-0', job_id='replacement', status='queued')
    before = storage.get_batch(batch_id)
    assert finish(batch_id)[1] is False
    assert storage.get_batch(batch_id) == before
    finish(batch_id, job_id='replacement')
    changed, should_notify = finish(batch_id, job_id='replacement', result='red')
    assert changed.items[0].result == 'red'
    assert should_notify is False
    item = storage.get_batch(batch_id).items[0]
    assert (item.job_id, item.status, item.result) == ('replacement', 'complete', 'red')


@pytest.mark.parametrize(('attempts', 'should_notify', 'status'), [
    (0, True, 'claimed'), (3, False, 'failed_exhausted'),
])
def test_replaying_a_ready_pending_batch_respects_its_saved_attempts(tmp_path, attempts, should_notify, status):
    batch_id = uuid4().hex
    snapshot = tmp_path / 'batch.json'
    snapshot.write_text(json.dumps([{
        'batchId': batch_id, 'createdAt': 1, 'updatedAt': 1, 'expectedCount': 1,
        'notificationReady': True, 'notificationStatus': 'pending', 'notificationAttempts': attempts,
        'items': [{'itemId': 'item-0', 'fileName': 'creative.mp4', 'mediaKind': 'video',
                   'jobId': 'job-0', 'status': 'complete', 'message': 'Complete', 'result': 'yellow'}],
    }]))
    subprocess.run(['./node_modules/.bin/convex', 'import', '--append', '--table', 'reviewBatches',
                    str(snapshot)], check=True)
    assert finish(batch_id)[1] is should_notify
    saved = storage.get_batch(batch_id)
    assert saved.notification_status == status
    assert bool(saved.notification_claim_id) is should_notify


def test_missing_items_and_unauthorized_callers_do_not_mutate_batches():
    batch_id = create_batch()
    before = storage.get_batch(batch_id)
    with httpx.Client(base_url=storage.CONVEX_URL) as client:
        for item_id, secret, reason in [
            ('missing', storage.CONVEX_HTTP_SECRET, 'Batch item not found'),
            ('item-0', 'wrong', 'Unauthorized'),
        ]:
            response = client.post('/api/mutation', json={
                'path': 'batches:finishItem',
                'args': {'secret': secret, 'batchId': batch_id, 'itemId': item_id,
                         'status': 'complete', 'message': 'Complete'},
            })
            error = response.json()
            assert error['status'] == 'error'
            assert reason in error['errorMessage']
            assert storage.get_batch(batch_id) == before
