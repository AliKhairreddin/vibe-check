import type { Status } from './api';

export function hasReviewReleases(review?: Pick<Status, 'released_offer_ids' | 'status' | 'report_ready'> | null): boolean {
  if (!review) return false;
  if (review.released_offer_ids != null) return review.released_offer_ids.length > 0;
  // Reviews created before explicit releases retain their original advertiser visibility.
  return review.status === 'complete' && review.report_ready;
}
