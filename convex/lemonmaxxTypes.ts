import { v } from 'convex/values';

export const assetStatus = v.union(v.literal('approved'), v.literal('rejected'), v.literal('not_selected'));
export const syncState = v.union(v.literal('pending'), v.literal('claimed'), v.literal('delivered'), v.literal('failed'), v.literal('cancelled'));
export const statusSyncFields = {
  partnerId: v.string(), assetId: v.string(), jobId: v.string(), offerId: v.string(),
  desiredStatus: assetStatus, revision: v.number(), state: syncState, attempts: v.number(),
  claimId: v.optional(v.string()), claimedRevision: v.optional(v.number()),
  nextAttemptAt: v.number(), createdAt: v.number(), updatedAt: v.number(),
  deliveredAt: v.optional(v.number()), responseStatus: v.optional(v.number()), lastError: v.optional(v.string()),
};

export function lemonmaxxStatus(decision: 'approved' | 'disapproved' | 'pending'): 'approved' | 'rejected' | 'not_selected' {
  return decision === 'approved' ? 'approved' : decision === 'disapproved' ? 'rejected' : 'not_selected';
}

export const MAX_ATTEMPTS = 8;
// Longer than Convex's ten-minute action limit: an abandoned action cannot
// resume and send an old status after a replacement worker has started.
export const LEASE_MS = 11 * 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];

export function retryAfterMs(value: string | null, now: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 24 * 60 * 60_000)) : undefined;
}
