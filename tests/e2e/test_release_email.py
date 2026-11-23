import json
import secrets
import subprocess
import time
from uuid import uuid4

from app.review_pipeline import storage
from app.review_pipeline.models import CreateBatchItem, JobStatus


def release_creatives(count):
    batch_id = uuid4().hex
    items = [CreateBatchItem(item_id=uuid4().hex, file_name=f'creative-{i}.mp4', media_kind='video')
             for i in range(count)]
    storage.create_batch(batch_id, items, offer_outcomes=[])
    for item in items:
        job_id = uuid4().hex
        storage.set_status(job_id, JobStatus.complete, 100, file_name=item.file_name, batch_id=batch_id)
        storage.set_report(job_id, {'overall_status': 'green', 'summary': 'Reviewed', 'findings': []})
        storage.finish_batch_item(batch_id, item.item_id, job_id=job_id, status='complete', result='green')
        result = storage._convex_call('mutation', 'reviewReleases:release', {
            'jobIds': [job_id], 'offerIds': ['acp'], 'confirmed': True, 'releasedBy': 'admin',
        })
        assert result['released'] == 1
    return batch_id


def release_messages(expected_counts, expected_text):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        data = subprocess.check_output(['./node_modules/.bin/convex', 'data', 'telegramNotifications',
                                        '--limit', '100', '--format', 'json'], text=True, timeout=20)
        rows = json.loads(data)
        matches = {
            batch_id: {row['eventKey'] for row in rows
                       if f'/batches/{batch_id}' in row['message'] and expected_text in row['message']}
            for batch_id in expected_counts
        }
        counts = {batch_id: len(keys) for batch_id, keys in matches.items()}
        if counts == expected_counts:
            return matches
        time.sleep(0.25)
    raise AssertionError(f'Expected {expected_counts} release messages with {expected_text!r}, got {counts}')


def test_combined_email_updates_every_release_message_after_confirmation():
    batches = {release_creatives(21): 21, release_creatives(1): 1}
    original = release_messages(batches, 'Email not sent yet')
    email_id = uuid4().hex
    preview = storage._convex_call('mutation', 'releaseEmails:prepare', {
        'emailId': email_id, 'offerId': 'acp', 'to': ['reviewer@example.test'], 'cc': [],
        'replyTo': 'sender@example.test', 'subject': 'Review', 'message': 'Please review.', 'signature': '',
        'batches': [{'batchId': batch, 'label': 'Creatives', 'shareId': uuid4().hex,
                     'token': secrets.token_urlsafe(32)} for batch in batches],
    })
    assert preview['status'] == 'draft'
    claim = {'emailId': email_id, 'ownerKey': 'admin', 'from': 'sender@example.test', 'claimId': 'first'}
    assert storage._convex_call('mutation', 'releaseEmails:claim', claim)['claimed']
    storage._convex_call('mutation', 'releaseEmails:finish', {
        'emailId': email_id, 'claimId': 'first', 'status': 'sent', 'messageId': 'synthetic-confirmation',
    })
    replay = storage._convex_call('mutation', 'releaseEmails:claim', {**claim, 'claimId': 'second'})
    assert not replay['claimed']
    assert replay['email']['status'] == 'sent'
    assert replay['email']['messageId'] == 'synthetic-confirmation'
    assert release_messages(batches, 'Email sent · reviewer@example.test') == original
