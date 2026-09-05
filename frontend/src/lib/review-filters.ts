import type { ReviewBatchItem } from './api';

export const REVIEW_RESULT_FILTERS = ['all', 'red', 'yellow', 'green', 'failed', 'upload_failed', 'unavailable'] as const;
export type ReviewResultFilter = typeof REVIEW_RESULT_FILTERS[number];
export type ReviewSearch = { offer?: string; result?: ReviewResultFilter };

export function validateReviewSearch(search: Record<string, unknown>): ReviewSearch {
  return {
    offer: typeof search.offer === 'string' && /^[a-z0-9_-]{1,100}$/.test(search.offer) ? search.offer : undefined,
    result: REVIEW_RESULT_FILTERS.includes(search.result as ReviewResultFilter) ? search.result as ReviewResultFilter : undefined,
  };
}

function normalizedStatus(status: string | null | undefined) {
  if (status === 'pass') return 'green';
  if (['amber', 'orange', 'needs_review'].includes(status ?? '')) return 'yellow';
  if (status === 'likely_violation') return 'red';
  return status;
}

export function matchesReviewFilter(item: ReviewBatchItem, offerId: string, result: ReviewResultFilter): boolean {
  if (result === 'all') return true;
  if (result === 'failed' || result === 'upload_failed') return item.status === result;
  if (item.status !== 'complete') return false;
  const outcomes = item.offer_outcomes ?? [];
  const scoped = offerId === 'all' ? outcomes : outcomes.filter(outcome => outcome.offer_id === offerId);
  if (offerId !== 'all' && outcomes.length && !scoped.length) return false;
  const statuses = scoped.filter(outcome => outcome.evaluation_state === 'evaluated')
    .map(outcome => normalizedStatus(outcome.automated_status ?? outcome.overall_status));
  if (statuses.length === 1 && !statuses[0] && outcomes.filter(outcome => outcome.evaluation_state === 'evaluated').length === 1) {
    statuses[0] = normalizedStatus(item.result);
  }
  // Only historical ACP rows without an offer snapshot use the primary result.
  if (!outcomes.length && (offerId === 'all' || offerId === 'acp')) statuses.push(normalizedStatus(item.result));
  if (result === 'unavailable') return !statuses.some(status => ['red', 'yellow', 'green'].includes(status ?? ''));
  return statuses.includes(result);
}
