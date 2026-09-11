import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveReviewStatus, withReviewDecision } from '../frontend/src/lib/client-review-status.ts';
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
