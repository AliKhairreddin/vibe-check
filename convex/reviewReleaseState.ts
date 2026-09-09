type ReviewReleaseState = {
  releasedAt?: number;
  releasedOfferIds?: string[];
  reportReady: boolean;
  status: string;
};

export function hasReviewReleases(review: ReviewReleaseState): boolean {
  if (review.releasedAt !== undefined) return true;
  if (review.releasedOfferIds !== undefined) return review.releasedOfferIds.length > 0;
  // Legacy completed reviews already have advertiser visibility.
  return review.status === 'complete' && review.reportReady;
}
