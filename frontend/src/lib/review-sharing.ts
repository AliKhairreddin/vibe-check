import type { OfferOutcome } from './api';

type ShareableReview = { job_id?: string | null; status: string; offer_outcomes?: OfferOutcome[] };

export function shareableReviewIds(reviews: ShareableReview[], offerId = 'all'): string[] {
  return [...new Set(reviews.flatMap(review => {
    if (!review.job_id || review.status !== 'complete') return [];
    const outcomes = review.offer_outcomes ?? [];
    if (outcomes.length && !outcomes.some(outcome =>
      (offerId === 'all' || outcome.offer_id === offerId) && outcome.evaluation_state === 'evaluated'
    )) return [];
    return [review.job_id];
  }))];
}
