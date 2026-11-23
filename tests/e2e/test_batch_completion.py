import asyncio
import json
import subprocess
from itertools import permutations
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx
import pytest

from app.main import app
from app.review_pipeline import storage
from app.review_pipeline.models import CreateBatchItem


@pytest.fixture(scope='module')
def mutate(local_database):
    with httpx.Client(base_url=storage.CONVEX_URL) as client:
        def call(name, **args):
            response = client.post('/api/mutation', json={
                'path': name, 'args': {'secret': storage.CONVEX_HTTP_SECRET, **args},
            })
            result = response.raise_for_status().json()
            assert result['status'] == 'success', result
            return result['value']

        yield call


def import_rows(tmp_path, table, rows):
    snapshot = tmp_path / f'{table}.json'
    snapshot.write_text(json.dumps(rows))
    subprocess.run(['./node_modules/.bin/convex', 'import', '--append', '--table', table, str(snapshot)],
                   check=True)


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


def test_replayed_completion_preserves_the_batch_and_notification_claim(mutate):
    batch_id = create_batch()
    outcome = {'offerId': 'offer', 'offerName': 'Offer', 'evaluationState': 'evaluated',
               'overallStatus': 'yellow', 'message': 'Evaluated'}
    payload = {'batchId': batch_id, 'itemId': 'item-0',
               'jobId': 'job-0', 'status': 'complete', 'message': 'Complete', 'offerOutcomes': [outcome]}
    assert mutate('batches:finishItem', **payload)['shouldNotify'] is False
    before = storage.get_batch(batch_id)
    payload['offerOutcomes'] = [dict(reversed(outcome.items()))]
    assert mutate('batches:finishItem', **payload)['shouldNotify'] is False
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


def test_retry_accepts_the_replacement_job_and_rejects_its_predecessor(mutate):
    batch_id = create_batch()
    finish(batch_id, status='upload_failed', result=None)
    legacy = mutate('batches:claimItemRetry', batchId=batch_id, itemId='item-0')
    assert legacy == {'claimed': False, 'status': 'upload_failed'}
    assert storage.claim_batch_item_retry(batch_id, 'item-0', 'replacement')
    claimed = storage.get_batch(batch_id)
    assert (claimed.items[0].job_id, claimed.items[0].status) == ('replacement', 'retrying')
    assert finish(batch_id)[1] is False
    assert storage.get_batch(batch_id) == claimed
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
    import_rows(tmp_path, 'reviewBatches', [{
        'batchId': batch_id, 'createdAt': 1, 'updatedAt': 1, 'expectedCount': 1,
        'notificationReady': True, 'notificationStatus': 'pending', 'notificationAttempts': attempts,
        'items': [{'itemId': 'item-0', 'fileName': 'creative.mp4', 'mediaKind': 'video',
                   'jobId': 'job-0', 'status': 'complete', 'message': 'Complete', 'result': 'yellow'}],
    }])
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


def test_recovery_preserves_the_replacement_batch_for_every_delivery_order(tmp_path, mutate):
    orders = list(permutations(('finish replacement', 'fail old review', 'late upload failure')))
    cases = [(uuid4().hex, uuid4().hex, uuid4().hex, order) for order in orders]
    reviews = [{
        'jobId': old, 'batchId': batch, 'batchItemId': 'item', 'fileName': 'creative.mp4',
        'status': 'queued', 'reportReady': False, 'message': 'Queued',
        'progress': 0, 'createdAt': 1, 'updatedAt': 1,
    } for batch, old, _, _ in cases]
    owner_batch, owner_job = uuid4().hex, uuid4().hex
    reviews.append({**reviews[0], 'batchId': owner_batch, 'jobId': owner_job})
    reviews.extend({
        **reviews[0], 'jobId': replacement, 'batchId': batch, 'status': 'running_ocr', 'updatedAt': 2,
    } for batch, _, replacement, _ in cases)
    import_rows(tmp_path, 'reviews', reviews)
    item = {'itemId': 'item', 'fileName': 'creative.mp4', 'mediaKind': 'video'}
    for batch, old, replacement, order in cases:
        mutate('batches:createBatch', batchId=batch, items=[item])
        mutate('batches:updateItemStatus', batchId=batch, itemId='item', jobId=replacement,
             status='queued', message='Queued')
        expected_status = 'queued'
        for event in order:
            if event == 'finish replacement':
                result = mutate('batches:finishItem', batchId=batch, itemId='item', jobId=replacement,
                              status='complete', message='Complete')
                assert result['shouldNotify'], order
                expected_status = 'complete'
            elif event == 'fail old review':
                result = mutate('reviews:failInterrupted', snapshots=[{'jobId': old, 'expectedUpdatedAt': 1}],
                              message='Missing media')
                assert result['failedJobIds'] == [old], order
            else:
                mutate('batches:updateItemStatus', batchId=batch, itemId='item',
                     status='upload_failed', message='Late upload failure')
            stored = mutate('batches:createBatch', batchId=batch, items=[item])['items'][0]
            assert (stored['job_id'], stored['status']) == (replacement, expected_status), (order, event)
            visible = storage.get_batch(batch).items[0]
            visible_status = 'complete' if expected_status == 'complete' else 'running_ocr'
            assert (visible.job_id, visible.status) == (replacement, visible_status), (order, event)

    mutate('batches:createBatch', batchId=owner_batch, items=[item])
    mutate('batches:updateItemStatus', batchId=owner_batch, itemId='item', jobId=owner_job,
         status='queued', message='Queued')
    failed = mutate('reviews:failInterrupted', snapshots=[{'jobId': owner_job, 'expectedUpdatedAt': 1}],
                  message='Missing media')
    assert failed['failedJobIds'] == [owner_job]
    current = storage.get_batch(owner_batch).items[0]
    assert (current.job_id, current.status) == (owner_job, 'failed')


def test_automation_recovery_preserves_a_replacement_batch(tmp_path, mutate):
    batch = create_batch()
    finish(batch, job_id='replacement')
    storage.update_batch_item(batch, 'item-1', status='queued', job_id='current')
    run = uuid4().hex
    import_rows(tmp_path, 'automationRuns', [{
        'runId': run, 'automationId': 'automation', 'batchId': batch, 'status': 'queued',
        'jobIds': ['stale', 'current'], 'createdAt': 1, 'updatedAt': 1, 'leaseExpiresAt': 1,
        'matchedCount': 2, 'queuedCount': 2, 'scheduledFor': '2026-10-22', 'message': 'Queued',
    }])
    import_rows(tmp_path, 'automationJobStates', [{
        'batchId': batch, 'batchItemId': item, 'jobId': job, 'runId': run, 'status': 'queued', 'updatedAt': 1,
    } for item, job in [('item-0', 'stale'), ('item-1', 'current')]])
    assert mutate('automations:recoverInterrupted')['processed'] == 1
    stored = storage.get_batch(batch)
    assert [(item.job_id, item.status) for item in stored.items] == [
        ('replacement', 'complete'), ('current', 'failed'),
    ]
