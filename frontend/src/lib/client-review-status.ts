import type { ClientReviewItem, OverallStatus } from './api';

export function effectiveReviewStatus(review: Pick<ClientReviewItem, 'ai_status' | 'decision'>): OverallStatus {
  if (review.decision?.decision === 'approved') return 'green';
  if (review.decision?.decision === 'disapproved') return 'red';
  return review.ai_status;
}

export function withReviewDecision(review: ClientReviewItem, decision: ClientReviewItem['decision']): ClientReviewItem {
  return { ...review, decision, effective_status: effectiveReviewStatus({ ...review, decision }) };
}
