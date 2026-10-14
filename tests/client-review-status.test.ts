import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveReviewStatus, reviewColorView, withReviewDecision } from '../frontend/src/lib/client-review-status.ts';
import type { ClientReviewItem } from '../frontend/src/lib/api.ts';

test('current colors follow the assessment until decided and restore on reset without changing the assessment', () => {
  for (const assessment of ['green', 'yellow', 'red'] as const) {
    const original = { ai_status: assessment, effective_status: 'yellow', decision: null } as ClientReviewItem;
    assert.equal(effectiveReviewStatus(original), assessment, 'stale effective fields must not hide the saved assessment');
    const approved = withReviewDecision(original, { decision: 'approved', decided_at: 1, feedback_note: null, feedback_reason: null });
    const disapproved = withReviewDecision(approved, { decision: 'disapproved', decided_at: 2, feedback_note: null, feedback_reason: null });
    const reset = withReviewDecision(disapproved, null);
    assert.equal(approved.effective_status, 'green');
    assert.equal(disapproved.effective_status, 'red');
    assert.equal(reset.effective_status, assessment);
    for (const review of [approved, disapproved, reset]) assert.equal(review.ai_status, assessment);
    assert.equal(original.decision, null, 'updating the cache must not mutate an earlier snapshot');
  }
});

const review = (job_id: string, ai_status: ClientReviewItem['ai_status'], created_at: number, decision: ClientReviewItem['decision'] = null) => (
  { job_id, ai_status, created_at, decision }
);
const approved = { decision: 'approved', decided_at: 1, feedback_note: null, feedback_reason: null } as const;
const disapproved = { ...approved, decision: 'disapproved' } as const;

test('batch colors group red, yellow, green with newest first inside each color without mutating cached reviews', () => {
  const input = Object.freeze([
    review('green', 'green', 60), review('yellow-old', 'yellow', 10), review('red-old', 'red', 20),
    review('yellow-new', 'yellow', 40), review('red-new', 'red', 30),
    review('approved-red', 'red', 50, approved), review('disapproved-green', 'green', 70, disapproved),
  ]);
  const view = reviewColorView(input);
  assert.deepEqual(view.reviews.map(r => r.job_id), ['disapproved-green', 'red-new', 'red-old', 'yellow-new', 'yellow-old', 'green', 'approved-red']);
  assert.deepEqual(view.counts, { all: 7, red: 3, yellow: 2, green: 2 });
  assert.equal(input[0].job_id, 'green');
});

test('batch filters use current decisions and keep counts for all colors available', () => {
  const input = [review('pending', 'yellow', 1), review('approved', 'red', 2, approved), review('disapproved', 'green', 3, disapproved)];
  for (const [color, id] of [['yellow', 'pending'], ['green', 'approved'], ['red', 'disapproved']] as const) {
    const view = reviewColorView(input, color);
    assert.deepEqual(view.reviews.map(r => r.job_id), [id]);
    assert.deepEqual(view.counts, { all: 3, red: 1, yellow: 1, green: 1 });
  }
  assert.equal(reviewColorView(input).reviews.length, 3);
});

test('a batch can show an empty color without losing its other colors or affecting another batch', () => {
  const first = [review('first-yellow', 'yellow', 1)];
  const second = [review('second-green', 'green', 2), review('second-red', 'red', 1)];
  assert.deepEqual(reviewColorView(first, 'red'), { reviews: [], counts: { all: 1, red: 0, yellow: 1, green: 0 } });
  assert.deepEqual(reviewColorView(second).reviews.map(r => r.job_id), ['second-red', 'second-green']);
  assert.deepEqual(reviewColorView(first).reviews.map(r => r.job_id), ['first-yellow']);
});

test('decision changes move a creative between color groups and reset restores its assessment group', () => {
  const original = review('changing', 'yellow', 1) as ClientReviewItem;
  const fixed = review('fixed', 'red', 2) as ClientReviewItem;
  const decided = withReviewDecision(original, approved);
  assert.deepEqual(reviewColorView([fixed, decided], 'yellow').reviews, []);
  assert.deepEqual(reviewColorView([fixed, decided], 'green').reviews.map(r => r.job_id), ['changing']);
  assert.deepEqual(reviewColorView([fixed, withReviewDecision(decided, null)], 'yellow').reviews.map(r => r.job_id), ['changing']);
});
