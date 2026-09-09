import type { ReviewBatch, Status } from './api';

type ReviewReleaseState = Pick<Status, 'released_offer_ids' | 'released_at' | 'status' | 'report_ready'>;

export function hasReviewReleases(review?: ReviewReleaseState | null): boolean {
  if (!review) return false;
  if (review.released_at != null) return true;
  if (review.released_offer_ids != null) return review.released_offer_ids.length > 0;
  // Reviews created before explicit releases retain their original advertiser visibility.
  return review.status === 'complete' && review.report_ready;
}

export function isReviewDeletable(review: ReviewReleaseState): boolean {
  return !hasReviewReleases(review) && (review.status === 'complete' || review.status === 'failed');
}

export function hasBatchReleases(reviews: ReviewReleaseState[], batch?: Pick<ReviewBatch, 'items'>): boolean {
  return reviews.some(hasReviewReleases) || Boolean(batch?.items.some(item => item.has_releases));
}

export function deletableBatchReviewIds(reviews: ReviewReleaseState[], batch?: Pick<ReviewBatch, 'items'>): string[] {
  // Wait for the full batch: the history page may not contain its released creatives.
  if (!batch || hasBatchReleases(reviews, batch)) return [];
  return batch.items.flatMap(item =>
    item.job_id && (item.status === 'complete' || item.status === 'failed') ? [item.job_id] : []
  );
}
