import assert from 'node:assert/strict';
import test from 'node:test';
import { shareableReviewIds } from '../frontend/src/lib/review-sharing.ts';

test('batch links include every completed creative once and skip unfinished or failed items', () => {
  const batch = Array.from({ length: 20 }, (_, index) => ({ job_id: `job-${index}`, status: 'complete' }));
  assert.deepEqual(shareableReviewIds([...batch, batch[0],
    { job_id: 'pending', status: 'queued' },
    { job_id: 'failed', status: 'failed' },
    { job_id: null, status: 'upload_failed' },
  ]), batch.map(item => item.job_id));
});

test('sharing a selected offer excludes creatives with unavailable or different offer results', () => {
  const outcome = (offer_id: string, evaluation_state: 'evaluated' | 'disabled') => ({ offer_id, offer_name: offer_id, evaluation_state, message: '' });
  const batch = [
    { job_id: 'evaluated', status: 'complete', offer_outcomes: [outcome('kissterra', 'evaluated')] },
    { job_id: 'disabled', status: 'complete', offer_outcomes: [outcome('kissterra', 'disabled')] },
    { job_id: 'other', status: 'complete', offer_outcomes: [outcome('acp', 'evaluated')] },
  ];
  assert.deepEqual(shareableReviewIds(batch, 'kissterra'), ['evaluated']);
  assert.deepEqual(shareableReviewIds(batch), ['evaluated', 'other']);
});
