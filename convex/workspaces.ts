import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server.js';

function authorize(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
}
const secret = { secret: v.string() };
async function projectSubmissionOwner(ctx: MutationCtx, clientId: string, jobId: string, publisherId: string | null) {
  const stat = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', jobId).eq('offerId', clientId)).unique();
  if (stat && stat.publisherId !== publisherId) await ctx.db.patch(stat._id, { publisherId });
}
async function publisher(ctx: QueryCtx, id: string) {
  return ctx.db.query('publishers').withIndex('by_publisher_id', q => q.eq('publisherId', id)).unique();
}
async function plan(ctx: QueryCtx, clientId: string) {
  return await ctx.db.query('advertiserPlans').withIndex('by_client_id', q => q.eq('clientId', clientId)).unique()
    ?? { clientId, plan: 'pilot', publisherLimit: 5, monthlyReviewLimit: 250 };
}
export const getPlan = query({
  args: { ...secret, clientId: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const value = await plan(ctx, args.clientId);
    const date = new Date();
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const submissions = await ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_counts_toward_usage_and_created_at', q => q.eq('clientId', args.clientId).eq('countsTowardUsage', true).gte('createdAt', monthStart)).take(value.monthlyReviewLimit + 1);
    const publishers = await ctx.db.query('publishers').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).take(1000);
    return { ...value, monthlyReviews: submissions.length, publishers: publishers.filter(p => p.status !== 'suspended').length };
  },
});
export const setPlan = mutation({
  args: { ...secret, clientId: v.string(), plan: v.union(v.literal('pilot'), v.literal('starter'), v.literal('growth'), v.literal('enterprise')), publisherLimit: v.number(), monthlyReviewLimit: v.number() },
  returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    if (!Number.isInteger(args.publisherLimit) || args.publisherLimit < 1 || args.publisherLimit > 1000 || !Number.isInteger(args.monthlyReviewLimit) || args.monthlyReviewLimit < 1 || args.monthlyReviewLimit > 10000) throw new Error('Invalid plan limits');
    const existing = await ctx.db.query('advertiserPlans').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).unique();
    const { secret: _, ...value } = args;
    if (existing) await ctx.db.patch(existing._id, { ...value, updatedAt: Date.now() });
    else await ctx.db.insert('advertiserPlans', { ...value, updatedAt: Date.now() });
    return null;
  },
});
export const listPublishers = query({
  args: { ...secret, clientId: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const rows = await ctx.db.query('publishers').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).take(1000);
    return rows.map(p => ({ publisherId: p.publisherId, name: p.name, username: p.username, status: p.status, createdAt: p.createdAt, inviteExpiresAt: p.inviteExpiresAt ?? null, managedLogin: p.organizationId === 'digital-nudge' }));
  },
});
export const getPublisher = query({
  args: { ...secret, publisherId: v.optional(v.string()), username: v.optional(v.string()), inviteHash: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    if (args.publisherId) return publisher(ctx, args.publisherId);
    if (args.username) return ctx.db.query('publishers').withIndex('by_username', q => q.eq('username', args.username!)).unique();
    if (args.inviteHash) return ctx.db.query('publishers').withIndex('by_invite_hash', q => q.eq('inviteHash', args.inviteHash!)).unique();
    return null;
  },
});
export const invitePublisher = mutation({
  args: { ...secret, clientId: v.string(), publisherId: v.string(), name: v.string(), username: v.string(), inviteHash: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const existing = await publisher(ctx, args.publisherId);
    if (existing?.organizationId) throw new Error('This login is managed by the publisher organization');
    if (existing && existing.clientId !== args.clientId) throw new Error('Publisher unavailable');
    const limits = await plan(ctx, args.clientId);
    const rows = await ctx.db.query('publishers').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).take(1000);
    if ((!existing || existing.status === 'suspended') && rows.filter(p => p.status !== 'suspended').length >= limits.publisherLimit) throw new Error('Publisher limit reached. Contact AdChecked to upgrade.');
    const value = { inviteHash: args.inviteHash, inviteExpiresAt: Date.now() + 7 * 86400000, status: 'invited' as const, authVersion: (existing?.authVersion ?? 0) + 1 };
    if (existing) await ctx.db.patch(existing._id, value);
    else {
      if (rows.length >= 1000) throw new Error('Workspace publisher capacity reached');
      if (await ctx.db.query('publishers').withIndex('by_username', q => q.eq('username', args.username)).first()) throw new Error('Username already exists');
      await ctx.db.insert('publishers', { ...value, clientId: args.clientId, publisherId: args.publisherId, name: args.name, username: args.username, createdAt: Date.now() });
    }
    return null;
  },
});
export const acceptInvite = mutation({
  args: { ...secret, inviteHash: v.string(), passwordHash: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const row = await ctx.db.query('publishers').withIndex('by_invite_hash', q => q.eq('inviteHash', args.inviteHash)).unique();
    if (!row || row.status !== 'invited' || (row.inviteExpiresAt ?? 0) <= Date.now()) throw new Error('Invitation expired or already used');
    await ctx.db.patch(row._id, { status: 'active', passwordHash: args.passwordHash, inviteHash: undefined, inviteExpiresAt: undefined, authVersion: row.authVersion + 1 });
    if (row.organizationId === 'digital-nudge') {
      const members = await ctx.db.query('publishers').withIndex('by_organization_id', q => q.eq('organizationId', 'digital-nudge')).take(10);
      for (const member of members) if (member._id !== row._id && member.status === 'invited') await ctx.db.patch(member._id, { status: 'active' });
    }
    return { ...row, status: 'active', authVersion: row.authVersion + 1 };
  },
});
export const suspendPublisher = mutation({
  args: { ...secret, clientId: v.string(), publisherId: v.string() }, returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    const row = await publisher(ctx, args.publisherId);
    if (!row || row.clientId !== args.clientId) throw new Error('Publisher unavailable');
    if (row.organizationId) throw new Error('This login is managed by the publisher organization');
    await ctx.db.patch(row._id, { status: 'suspended', inviteHash: undefined, inviteExpiresAt: undefined, authVersion: row.authVersion + 1 });
    return null;
  },
});
export const claimSubmission = mutation({
  args: { ...secret, clientId: v.string(), publisherId: v.string(), jobId: v.string() }, returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    const row = await publisher(ctx, args.publisherId);
    if (!row || row.clientId !== args.clientId || row.status !== 'active') throw new Error('Publisher unavailable');
    const existing = await ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_job_id', q => q.eq('clientId', args.clientId).eq('jobId', args.jobId)).unique();
    if (existing) {
      if (existing.publisherId !== args.publisherId || existing.clientId !== args.clientId) throw new Error('Submission unavailable');
      await projectSubmissionOwner(ctx, args.clientId, args.jobId, args.publisherId);
      return null;
    }
    const limits = await plan(ctx, args.clientId);
    const date = new Date();
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const count = await ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_counts_toward_usage_and_created_at', q => q.eq('clientId', args.clientId).eq('countsTowardUsage', true).gte('createdAt', monthStart)).take(limits.monthlyReviewLimit);
    if (count.length >= limits.monthlyReviewLimit) throw new Error('Monthly review allowance reached. Contact your advertiser to upgrade.');
    await ctx.db.insert('publisherSubmissions', { clientId: args.clientId, publisherId: args.publisherId, jobId: args.jobId, createdAt: Date.now(), countsTowardUsage: true });
    await projectSubmissionOwner(ctx, args.clientId, args.jobId, args.publisherId);
    return null;
  },
});
export const getSubmission = query({
  args: { ...secret, clientId: v.string(), jobId: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    return ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_job_id', q => q.eq('clientId', args.clientId).eq('jobId', args.jobId)).unique();
  },
});
export const releaseUnstartedSubmission = mutation({
  args: { ...secret, clientId: v.string(), publisherId: v.string(), jobId: v.string() }, returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    const review = await ctx.db.query('reviews').withIndex('by_job_id', q => q.eq('jobId', args.jobId)).unique();
    if (review) return null; // An accepted/recoverable job keeps its reservation.
    const row = await ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_job_id', q => q.eq('clientId', args.clientId).eq('jobId', args.jobId)).unique();
    if (row?.publisherId === args.publisherId && row.countsTowardUsage) {
      await ctx.db.delete(row._id);
      await projectSubmissionOwner(ctx, args.clientId, args.jobId, null);
    }
    return null;
  },
});
export const listSubmissions = query({
  args: { ...secret, clientId: v.string(), publisherId: v.optional(v.string()), previewPublisherId: v.optional(v.string()) }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const rows = args.publisherId
      ? await ctx.db.query('publisherSubmissions').withIndex('by_publisher_id', q => q.eq('publisherId', args.publisherId!)).order('desc').take(1000)
      : await ctx.db.query('publisherSubmissions').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).order('desc').take(1000);
    return (await Promise.all(rows.filter(row => row.clientId === args.clientId).map(async row => {
      const review = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', row.jobId).eq('offerId', args.clientId)).unique();
      if (review?.deletedAt !== undefined || ((!review || review.withheld) && args.previewPublisherId !== row.publisherId)) return null;
      return { released: Boolean(review && !review.withheld), jobId: row.jobId, publisherId: row.publisherId, createdAt: row.createdAt, fileName: review?.fileName ?? 'Preparing submission', status: review?.status ?? 'queued', progress: review?.progress ?? (review?.status === 'complete' ? 100 : 0), message: review?.message ?? (review?.status === 'complete' ? 'Review complete' : review?.status === 'failed' ? 'Review failed' : 'Preparing submission') };
    }))).filter(Boolean);
  },
});
export const createShare = mutation({
  args: { ...secret, shareId: v.string(), tokenHash: v.string(), ownerKey: v.string(), clientId: v.optional(v.string()), publisherId: v.optional(v.string()), title: v.string(), expiresAt: v.number(), items: v.array(v.object({ jobId: v.string(), offerId: v.string() })) },
  returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    if (!args.items.length || args.items.length > 100) throw new Error('Select between 1 and 100 creatives');
    for (const item of args.items) {
      const review = await ctx.db.query('reviews').withIndex('by_job_id', q => q.eq('jobId', item.jobId)).unique();
      const stat = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', item.jobId).eq('offerId', item.offerId)).unique();
      if (!review || review.deletedAt !== undefined || !stat || stat.withheld || stat.deletedAt !== undefined || stat.status !== 'complete') throw new Error('Only completed, available creatives can be shared');
      if (args.publisherId) {
        const submission = await ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_job_id', q => q.eq('clientId', args.clientId!).eq('jobId', item.jobId)).unique();
        if (submission?.publisherId !== args.publisherId || submission?.clientId !== args.clientId) throw new Error('Creative unavailable');
      }
    }
    const { secret: _, ...value } = args;
    await ctx.db.insert('publicShares', { ...value, createdAt: Date.now() });
    return null;
  },
});
export const getShare = query({
  args: { ...secret, tokenHash: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const row = await ctx.db.query('publicShares').withIndex('by_token_hash', q => q.eq('tokenHash', args.tokenHash)).unique();
    if (!row || row.revokedAt !== undefined || row.expiresAt <= Date.now()) return null;
    const items = (await Promise.all(row.items.map(async item => {
      const stat = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', item.jobId).eq('offerId', item.offerId)).unique();
      return stat && !stat.withheld && stat.deletedAt === undefined && stat.status === 'complete' ? item : null;
    }))).filter((item): item is { jobId: string; offerId: string } => item !== null);
    return items.length ? { ...row, items } : null;
  },
});
export const listShares = query({
  args: { ...secret, ownerKey: v.string(), clientId: v.optional(v.string()) }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const rows = args.clientId
      ? await ctx.db.query('publicShares').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).order('desc').take(100)
      : await ctx.db.query('publicShares').withIndex('by_owner_key', q => q.eq('ownerKey', args.ownerKey)).order('desc').take(100);
    return rows.map(row => ({ shareId: row.shareId, title: row.title, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt ?? null, count: row.items.length }));
  },
});
export const revokeShare = mutation({
  args: { ...secret, shareId: v.string(), ownerKey: v.string(), clientId: v.optional(v.string()) }, returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    const row = await ctx.db.query('publicShares').withIndex('by_share_id', q => q.eq('shareId', args.shareId)).unique();
    if (!row || (row.ownerKey !== args.ownerKey && (!args.clientId || row.clientId !== args.clientId))) throw new Error('Shared link unavailable');
    await ctx.db.patch(row._id, { revokedAt: Date.now() });
    return null;
  },
});
export const mediaUrl = query({
  args: { ...secret, jobId: v.string() }, returns: v.union(v.string(), v.null()), handler: async (ctx, args) => {
    authorize(args.secret);
    const row = await ctx.db.query('reviewMedia').withIndex('by_job_id', q => q.eq('jobId', args.jobId)).unique();
    if (row) return ctx.storage.getUrl(row.storageId);
    const payload = await ctx.db.query('reviewPayloads').withIndex('by_job_id', q => q.eq('jobId', args.jobId)).unique();
    return payload?.mediaStorageId ? ctx.storage.getUrl(payload.mediaStorageId) : null;
  },
});

export const digitalNudgeMemberships = query({
  args: secret, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const rows = await ctx.db.query('publishers').withIndex('by_organization_id', q => q.eq('organizationId', 'digital-nudge')).take(10);
    return rows.filter(row => row.status !== 'suspended').sort((a, b) => a.clientId.localeCompare(b.clientId)).map(row => ({ clientId: row.clientId, publisherId: row.publisherId }));
  },
});
export const setupDigitalNudge = mutation({
  args: { ...secret, inviteHash: v.optional(v.string()) }, returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    for (const clientId of ['kissterra', 'smart-financial', 'lead-economy', 'acp']) {
      const publisherId = `digital-nudge-${clientId}`;
      const existing = await publisher(ctx, publisherId);
      const primary = clientId === 'kissterra';
      if (!existing) await ctx.db.insert('publishers', { clientId, publisherId, name: 'Digital Nudge', organizationId: 'digital-nudge', username: primary ? 'digital-nudge' : `digital-nudge.${clientId}`, status: 'invited', authVersion: 1, createdAt: Date.now(), ...(primary && args.inviteHash ? { inviteHash: args.inviteHash, inviteExpiresAt: Date.now() + 7 * 86400000 } : {}) });
      else if (primary && args.inviteHash) await ctx.db.patch(existing._id, { inviteHash: args.inviteHash, inviteExpiresAt: Date.now() + 7 * 86400000, status: 'invited', authVersion: existing.authVersion + 1 });
    }
    return null;
  },
});
