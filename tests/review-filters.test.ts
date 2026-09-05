import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesReviewFilter, validateReviewSearch } from '../frontend/src/lib/review-filters.ts';
import type { ReviewBatchItem } from '../frontend/src/lib/api.ts';

const item = (overrides: Partial<ReviewBatchItem> = {}): ReviewBatchItem => ({
  item_id: 'one', file_name: 'one.png', media_kind: 'image', status: 'complete', message: '',
  offer_outcomes: [
    { offer_id: 'kissterra', offer_name: 'Kissterra', evaluation_state: 'evaluated',
      overall_status: 'green', automated_status: 'yellow', effective_status: 'green', message: '' },
    { offer_id: 'acp', offer_name: 'ACP', evaluation_state: 'evaluated', overall_status: 'red', message: '' },
  ], ...overrides,
});

test('Telegram deep link filters use the original assessment and the selected client', () => {
  const search = validateReviewSearch({ offer: 'kissterra', result: 'yellow' });
  assert.deepEqual(search, { offer: 'kissterra', result: 'yellow' });
  assert.ok(matchesReviewFilter(item(), search.offer!, search.result!));
  assert.equal(matchesReviewFilter(item(), 'kissterra', 'green'), false);
  assert.equal(matchesReviewFilter(item(), 'kissterra', 'red'), false);
  assert.ok(matchesReviewFilter(item(), 'acp', 'red'));
});

test('upload and processing failures never match red results', () => {
  for (const status of ['failed', 'upload_failed'] as const) {
    assert.ok(matchesReviewFilter(item({ status }), 'kissterra', status));
    assert.equal(matchesReviewFilter(item({ status }), 'kissterra', 'red'), false);
  }
});

test('unavailable, disabled, and unknown offers have no color verdict', () => {
  assert.equal(matchesReviewFilter(item(), 'missing-client', 'unavailable'), false);
  const value = item({ offer_outcomes: [{ offer_id: 'kissterra', offer_name: 'Kissterra', evaluation_state: 'disabled', overall_status: null, message: '' }] });
  assert.ok(matchesReviewFilter(value, 'kissterra', 'unavailable'));
  assert.equal(matchesReviewFilter(value, 'kissterra', 'green'), false);
});

test('legacy result fallback does not attribute ACP results to another client', () => {
  const value = item({ offer_outcomes: [], result: 'green' });
  assert.ok(matchesReviewFilter(value, 'acp', 'green'));
  assert.equal(matchesReviewFilter(value, 'kissterra', 'green'), false);
});

test('invalid URL filters are dropped, all resets the filter', () => {
  assert.deepEqual(validateReviewSearch({ offer: '<script>', result: 'bogus' }), { offer: undefined, result: undefined });
  assert.ok(matchesReviewFilter(item({ status: 'queued' }), 'kissterra', 'all'));
});
