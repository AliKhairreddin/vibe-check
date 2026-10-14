import type { ClientReviewItem, OverallStatus } from './api';

export type ClientResultFilter = 'all' | OverallStatus;
export const CLIENT_RESULT_FILTERS = ['all', 'red', 'yellow', 'green'] as const;
const STATUS_ORDER: Record<OverallStatus, number> = { red: 0, yellow: 1, green: 2 };

export function effectiveReviewStatus(review: Pick<ClientReviewItem, 'ai_status' | 'decision'>): OverallStatus {
  if (review.decision?.decision === 'approved') return 'green';
  if (review.decision?.decision === 'disapproved') return 'red';
  return review.ai_status;
}

export function withReviewDecision(review: ClientReviewItem, decision: ClientReviewItem['decision']): ClientReviewItem {
  return { ...review, decision, effective_status: effectiveReviewStatus({ ...review, decision }) };
}

// Counts describe the input before the batch's own filter, so every color remains
// discoverable. Callers apply queue-wide filters before passing the reviews here.
export function reviewColorView<T extends Pick<ClientReviewItem, 'ai_status' | 'decision' | 'created_at' | 'job_id'>>(
  reviews: readonly T[],
  filter: ClientResultFilter = 'all',
) {
  const counts: Record<ClientResultFilter, number> = { all: reviews.length, red: 0, yellow: 0, green: 0 };
  const visible: T[] = [];
  for (const review of reviews) {
    const status = effectiveReviewStatus(review);
    counts[status] += 1;
    if (filter === 'all' || filter === status) visible.push(review);
  }
  visible.sort((left, right) => STATUS_ORDER[effectiveReviewStatus(left)] - STATUS_ORDER[effectiveReviewStatus(right)]
    || right.created_at - left.created_at || left.job_id.localeCompare(right.job_id));
  return { reviews: visible, counts };
}
