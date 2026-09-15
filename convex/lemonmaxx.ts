import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, type MutationCtx } from './_generated/server.js';
import type { Doc, Id } from './_generated/dataModel';
import { assetStatus, lemonmaxxStatus, LEASE_MS, MAX_ATTEMPTS, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS, retryAfterMs } from './lemonmaxxTypes.ts';

const deliverRef = makeFunctionReference<'action'>('lemonmaxx:deliver');
const claimRef = makeFunctionReference<'mutation'>('lemonmaxx:claim');
const finishRef = makeFunctionReference<'mutation'>('lemonmaxx:finish');
type Sync = Doc<'lemonmaxxStatusSync'>;

async function eligible(ctx: MutationCtx, jobId: string, offerId: string) {
  const partnerId = process.env.LEMONMAXX_PARTNER_ID?.trim();
  if (!partnerId) return null;
  const link = await ctx.db.query('apiReviewLinks').withIndex('by_job_id', q => q.eq('jobId', jobId)).unique();
  if (!link || link.partnerId !== partnerId || link.status === 'deleted' || !link.externalId?.trim()
    || ['.', '..'].includes(link.externalId)) return null;
  // Legacy single-job submissions may not have requestedOfferId. Only the
  // primary offer is unambiguous in that case; unrelated offer results stay local.
  const requestedOfferId = link.requestedOfferId ?? (await ctx.db.query('reviews')
    .withIndex('by_job_id', q => q.eq('jobId', jobId)).unique())?.primaryOfferId;
  if (requestedOfferId !== offerId) return null;
  const partner = await ctx.db.query('apiPartners').withIndex('by_partner_id', q => q.eq('partnerId', partnerId)).unique();
  if (partner?.status !== 'active') return null;
  return link;
}

// Called in the same transaction as the advertiser's decision. The endpoint
// stores one status per asset, so the latest explicit decision wins across offers.
// Note edits and AI colors never call this helper.
export async function queueStatusSync(ctx: MutationCtx, jobId: string, offerId: string, decision: 'approved' | 'disapproved' | 'pending') {
  const link = await eligible(ctx, jobId, offerId);
  if (!link) return;
  const assetId = link.externalId!;
  const row = await ctx.db.query('lemonmaxxStatusSync')
    .withIndex('by_partner_id_and_asset_id', q => q.eq('partnerId', link.partnerId).eq('assetId', assetId)).unique();
  const now = Date.now();
  const value = { partnerId: link.partnerId, assetId, jobId, offerId, desiredStatus: lemonmaxxStatus(decision),
    revision: (row?.revision ?? 0) + 1, updatedAt: now };
  let id: Id<'lemonmaxxStatusSync'>;
  if (row) {
    id = row._id;
    // Hold the existing lease while a request is in flight. Its completion will
    // immediately schedule the newer revision instead of retrying the old one.
    await ctx.db.patch(id, { ...value, ...(row.state === 'claimed' ? {} : {
      state: 'pending' as const, attempts: 0, nextAttemptAt: now, lastError: undefined, responseStatus: undefined,
    }) });
  } else {
    id = await ctx.db.insert('lemonmaxxStatusSync', { ...value, state: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now });
  }
  if (row?.state !== 'claimed') await ctx.scheduler.runAfter(0, deliverRef, { id });
}

const claimValue = v.object({ claimId: v.string(), assetId: v.string(), status: assetStatus });
export const claim = internalMutation({
  args: { id: v.id('lemonmaxxStatusSync') }, returns: v.union(v.null(), claimValue),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    const now = Date.now();
    if (!row || !['pending', 'claimed'].includes(row.state) || row.nextAttemptAt > now) return null;
    const link = await eligible(ctx, row.jobId, row.offerId);
    const stat = await ctx.db.query('reviewOfferStats')
      .withIndex('by_job_id_and_offer_id', q => q.eq('jobId', row.jobId).eq('offerId', row.offerId)).unique();
    if (!link || link.externalId !== row.assetId || link.partnerId !== row.partnerId
      || !stat || stat.withheld || stat.deletedAt !== undefined || stat.status !== 'complete') {
      await ctx.db.patch(id, { state: 'cancelled', claimId: undefined, lastError: 'Asset or offer is no longer eligible for sync', updatedAt: now });
      return null;
    }
    const attempts = row.state === 'claimed' && row.claimedRevision !== row.revision ? 0 : row.attempts;
    if (attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(id, { state: 'failed', claimId: undefined, lastError: 'Delivery retry limit reached', updatedAt: now });
      return null;
    }
    const claimId = crypto.randomUUID();
    await ctx.db.patch(id, { state: 'claimed', claimId, claimedRevision: row.revision,
      attempts: attempts + 1, nextAttemptAt: now + LEASE_MS, updatedAt: now });
    return { claimId, assetId: row.assetId, status: row.desiredStatus };
  },
});

export const finish = internalMutation({
  args: { id: v.id('lemonmaxxStatusSync'), claimId: v.string(), success: v.boolean(), retryable: v.boolean(),
    responseStatus: v.optional(v.number()), retryDelayMs: v.optional(v.number()), error: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.state !== 'claimed' || row.claimId !== args.claimId) return false;
    const now = Date.now();
    const changed = row.revision !== row.claimedRevision;
    const retry = !args.success && args.retryable && row.attempts < MAX_ATTEMPTS;
    const state = changed || retry ? 'pending' : args.success ? 'delivered' : 'failed';
    const delay = changed ? 0 : Math.max(RETRY_DELAYS_MS[row.attempts - 1] ?? 43_200_000,
      Math.min(Math.max(args.retryDelayMs ?? 0, 0), 24 * 60 * 60_000));
    await ctx.db.patch(row._id, { state, claimId: undefined, updatedAt: now,
      attempts: changed ? 0 : row.attempts, nextAttemptAt: now + delay,
      responseStatus: args.responseStatus, lastError: changed || args.success ? undefined : args.error?.slice(0, 200),
      ...(args.success ? { deliveredAt: now } : {}),
    });
    if (state === 'pending') await ctx.scheduler.runAfter(delay, deliverRef, { id: row._id });
    if (state === 'failed') console.error('Lemonmaxx status sync failed', { id: row._id, responseStatus: args.responseStatus });
    return true;
  },
});

export const deliver = internalAction({
  args: { id: v.id('lemonmaxxStatusSync') }, returns: v.null(),
  handler: async (ctx, { id }): Promise<null> => {
    const delivery: { claimId: string; assetId: string; status: Sync['desiredStatus'] } | null = await ctx.runMutation(claimRef, { id });
    if (!delivery) return null;
    const token = process.env.LEMONMAXX_API_TOKEN?.trim();
    if (!token) {
      await ctx.runMutation(finishRef, { id, claimId: delivery.claimId, success: false, retryable: false, error: 'LEMONMAXX_API_TOKEN is not configured' });
      return null;
    }
    let result: { success: boolean; retryable: boolean; responseStatus?: number; retryDelayMs?: number; error?: string };
    try {
      const response = await fetch(`https://api.lemonmaxx.com/api/v1/creative-bank/creative-group/assets/${encodeURIComponent(delivery.assetId)}/status`, {
        method: 'PATCH', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'AdChecked/1.0 (+https://adchecked.com)' },
        body: JSON.stringify({ status: delivery.status }),
      });
      result = { success: response.ok, responseStatus: response.status,
        retryable: response.status >= 500 || [408, 409, 425, 429].includes(response.status),
        ...(response.ok ? {} : { error: `Lemonmaxx returned HTTP ${response.status}` }),
        ...(response.headers.has('retry-after') ? { retryDelayMs: retryAfterMs(response.headers.get('retry-after'), Date.now()) } : {}),
      };
      await response.body?.cancel().catch(() => {});
    } catch {
      // Never persist remote response bodies or exception text (which may contain credentials).
      result = { success: false, retryable: true, error: 'Lemonmaxx request timed out or failed to connect' };
    }
    await ctx.runMutation(finishRef, { id, claimId: delivery.claimId, ...result });
    return null;
  },
});

// Recover scheduled action failures and expired claims without waking a container.
export const recover = internalMutation({
  args: {}, returns: v.number(),
  handler: async (ctx) => {
    let count = 0;
    for (const state of ['pending', 'claimed'] as const) {
      const due = await ctx.db.query('lemonmaxxStatusSync')
        .withIndex('by_state_and_next_attempt_at', q => q.eq('state', state).lte('nextAttemptAt', Date.now())).take(50);
      for (const row of due) { await ctx.scheduler.runAfter(0, deliverRef, { id: row._id }); count++; }
    }
    return count;
  },
});

// Operator recovery after correcting a token or a remote asset. No public caller
// can queue arbitrary IDs or send statuses that did not originate in a decision.
export const retry = internalMutation({
  args: { id: v.id('lemonmaxxStatusSync') }, returns: v.boolean(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row || row.state !== 'failed') return false;
    await ctx.db.patch(id, { state: 'pending', attempts: 0, nextAttemptAt: Date.now(), updatedAt: Date.now(), lastError: undefined });
    await ctx.scheduler.runAfter(0, deliverRef, { id });
    return true;
  },
});

// GET on this PATCH-only route checks the partner's authentication middleware
// without changing a creative. The authenticated response is 405 Allow: PATCH.
export const checkConnection = internalAction({
  args: {}, returns: v.object({ configured: v.boolean(), authenticated: v.boolean(), httpStatus: v.union(v.number(), v.null()) }),
  handler: async () => {
    const token = process.env.LEMONMAXX_API_TOKEN?.trim();
    if (!token || !process.env.LEMONMAXX_PARTNER_ID?.trim()) return { configured: false, authenticated: false, httpStatus: null };
    try {
      const response = await fetch('https://api.lemonmaxx.com/api/v1/creative-bank/creative-group/assets/00000000-0000-0000-0000-000000000000/status', {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'AdChecked/1.0 (+https://adchecked.com)' },
      });
      await response.body?.cancel().catch(() => {});
      return { configured: true, authenticated: response.status === 405 && response.headers.get('allow')?.includes('PATCH') === true, httpStatus: response.status };
    } catch {
      return { configured: true, authenticated: false, httpStatus: null };
    }
  },
});
