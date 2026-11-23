import json
import subprocess

import pytest

from app.review_pipeline import storage
from app.review_pipeline.models import JobStatus


@pytest.fixture(scope='module')
def refreshed_queue(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp('decisions')
    client_id = 'decision-list-test'
    offer_id = 'acp'
    job_id = 'z-displayed-creative'
    storage.set_status(job_id, JobStatus.complete, 100, file_name='creative.mp4', offer_ids=[offer_id])
    storage.set_report(job_id, {'overall_status': 'yellow', 'summary': 'Needs review', 'findings': []})
    released = storage._convex_call('mutation', 'reviewReleases:release', {
        'jobIds': [job_id], 'offerIds': [offer_id], 'confirmed': True, 'releasedBy': 'test',
    })
    assert released['released'] == 1

    decisions = [{'jobId': f'a-{i:04d}', 'clientId': client_id, 'offerId': offer_id,
                  'decision': 'approved', 'decidedAt': i} for i in range(1000)]
    history = [dict(row, archivedAt=i + 10) for i, row in enumerate(decisions)]
    history.append({'jobId': job_id, 'clientId': client_id, 'offerId': offer_id,
                    'decision': 'disapproved', 'decidedAt': 1, 'archivedAt': 2,
                    'feedbackNote': 'Original decision for this creative'})
    for table, rows in [
        ('clientReviewDecisions', [dict(row, createdAt=1, updatedAt=1) for row in decisions]),
        ('clientReviewDecisionHistory', history),
    ]:
        snapshot = tmp_path / f'{table}.json'
        snapshot.write_text(json.dumps(rows))
        subprocess.run(['./node_modules/.bin/convex', 'import', '--append', '--table', table,
                        str(snapshot)], check=True)

    saved = storage.set_client_review_decision(client_id, offer_id, job_id, 'approved',
                                                feedback_note='Approved after review')
    assert saved['decision'] == 'approved'
    rows = storage.list_client_reviews(client_id, offer_id, limit=1)
    assert [row['jobId'] for row in rows] == [job_id]
    return rows[0], saved


def test_large_review_queue_keeps_the_displayed_jobs_saved_decision(refreshed_queue):
    row, saved = refreshed_queue
    assert row['decision'] == saved
    assert row['effectiveStatus'] == 'green'


def test_large_review_queue_keeps_the_displayed_jobs_decision_history(refreshed_queue):
    row, _ = refreshed_queue
    assert row['previousDecision'] is not None
    assert row['previousDecision']['feedbackNote'] == 'Original decision for this creative'
