import { v } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server.js';
import type { Doc } from './_generated/dataModel';
import { emailFields, validateEmailContent } from './releaseEmailTypes.ts';

const scopeArgs = { secret: v.string(), clientId: v.optional(v.string()), publisherId: v.optional(v.string()) };
type Scope = { secret: string; clientId?: string; publisherId?: string };
function authorize(args: Scope, offerId?: string) {
  if (!process.env.CONVEX_HTTP_SECRET || args.secret !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
  if (Boolean(args.clientId) !== Boolean(args.publisherId) || (args.clientId && offerId && args.clientId !== offerId)) throw new Error('Unauthorized');
  return args.publisherId ? `publisher:${args.publisherId}` : 'admin';
}

// A batch link contains only this advertiser's evaluated, released results.
// Refuse partially released batches so the email cannot silently omit creatives.
async function releasedBatch(ctx: QueryCtx, scope: Scope, offerId: string, batchId: string) {
  const batch = await ctx.db.query('reviewBatches').withIndex('by_batch_id', q => q.eq('batchId', batchId)).unique();
  if (!batch || batch.items.length < batch.expectedCount || batch.items.some(item => !['complete', 'failed', 'upload_failed'].includes(item.status))) return null;
  const rows = await ctx.db.query('reviews').withIndex('by_batch_id', q => q.eq('batchId', batchId)).take(101);
  if (rows.length > 100) return null;
  const jobs: Doc<'reviews'>[] = [];
  for (const row of rows) {
    if (row.deletedAt !== undefined || row.status === 'failed') continue;
    if (scope.publisherId) {
      const submission = await ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_job_id', q => q.eq('clientId', scope.clientId!).eq('jobId', row.jobId)).unique();
      if (submission?.publisherId !== scope.publisherId) return null;
    }
    const stat = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', row.jobId).eq('offerId', offerId)).unique();
    if (!stat || stat.deletedAt !== undefined) continue;
    if (stat.withheld || stat.status !== 'complete' || !stat.resultStatus || row.status !== 'complete' || !row.reportReady) return null;
    jobs.push(row);
  }
  if (!jobs.length) return null;
  const verticals = [...new Set(jobs.map(row => row.vertical))];
  const label = verticals.length === 1 && verticals[0] === 'home-insurance' ? 'Home' : verticals.length === 1 && verticals[0] === 'auto-insurance' ? 'Auto' : 'Creatives';
  return { batchId, label, title: batch.sourceLabel ?? jobs[0].fileName, createdAt: batch.createdAt, count: jobs.length, jobIds: jobs.map(row => row.jobId) };
}

const batchView = v.object({ batchId: v.string(), label: v.string(), title: v.string(), createdAt: v.number(), count: v.number() });
export const batches = query({
  args: { ...scopeArgs, offerId: v.string(), cursor: v.union(v.string(), v.null()), initialBatchId: v.optional(v.string()) },
  returns: v.object({ batches: v.array(batchView), cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    authorize(args, args.offerId);
    const page = await ctx.db.query('reviewBatches').withIndex('by_created_at').order('desc').paginate({ numItems: 10, cursor: args.cursor });
    const ids = [...new Set([...(!args.cursor && args.initialBatchId ? [args.initialBatchId] : []), ...page.page.map(row => row.batchId)])];
    const batches = [];
    for (const batchId of ids) {
      const batch = await releasedBatch(ctx, args, args.offerId, batchId);
      if (batch) { const { jobIds: _, ...view } = batch; batches.push(view); }
    }
    return { batches, cursor: page.continueCursor, isDone: page.isDone };
  },
});

export const recent = query({
  args: { ...scopeArgs, offerId: v.string() },
  returns: v.array(v.object(emailFields)),
  handler: async (ctx, args) => {
    const ownerKey = authorize(args, args.offerId);
    const rows = await ctx.db.query('releaseEmails').withIndex('by_owner_key_and_offer_id', q => q.eq('ownerKey', ownerKey).eq('offerId', args.offerId)).order('desc').take(20);
    return rows.map(({ _id, _creationTime, claimId, ...row }) => row);
  },
});

export const prepare = mutation({
  args: {
    ...scopeArgs, emailId: v.string(), offerId: v.string(), to: v.array(v.string()), cc: v.array(v.string()), replyTo: v.string(),
    subject: v.string(), message: v.string(), signature: v.string(),
    batches: v.array(v.object({ batchId: v.string(), label: v.string(), token: v.string(), shareId: v.string() })),
  },
  returns: v.object(emailFields),
  handler: async (ctx, args) => {
    const ownerKey = authorize(args, args.offerId);
    validateEmailContent(args);
    if (!args.batches.length || args.batches.length > 10 || new Set(args.batches.map(batch => batch.batchId)).size !== args.batches.length) throw new Error('Select between 1 and 10 distinct released batches');
    // Repeating an identical preview request returns the same draft and links.
    const existing = await ctx.db.query('releaseEmails').withIndex('by_email_id', q => q.eq('emailId', args.emailId)).unique();
    if (existing) {
      if (existing.ownerKey !== ownerKey) throw new Error('Email unavailable');
      const { _id, _creationTime, claimId, ...view } = existing;
      return view;
    }
    const now = Date.now();
    const expiresAt = now + 30 * 86400000;
    const links = [];
    for (const selected of args.batches) {
      if (!selected.label.trim() || selected.label.length > 120 || !/^[A-Za-z0-9_-]{43}$/.test(selected.token)) throw new Error('Invalid batch label or link');
      const batch = await releasedBatch(ctx, args, args.offerId, selected.batchId);
      if (!batch) throw new Error('Release every completed creative in each selected batch to this advertiser first');
      const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(selected.token)))).map(byte => byte.toString(16).padStart(2, '0')).join('');
      await ctx.db.insert('publicShares', {
        shareId: selected.shareId, tokenHash, ownerKey,
        ...(args.clientId ? { clientId: args.clientId, publisherId: args.publisherId } : {}),
        title: `${selected.label.trim()} — ${batch.title}`.slice(0, 120), createdAt: now, expiresAt,
        items: batch.jobIds.map(jobId => ({ jobId, offerId: args.offerId })),
      });
      links.push({ batchId: batch.batchId, label: selected.label.trim(), url: `https://app.adchecked.com/share/${selected.token}`, shareId: selected.shareId, jobIds: batch.jobIds });
    }
    const row = {
      emailId: args.emailId, ownerKey, ...(args.clientId ? { clientId: args.clientId, publisherId: args.publisherId } : {}),
      offerId: args.offerId, to: args.to, cc: args.cc, replyTo: args.replyTo,
      subject: args.subject.trim(), message: args.message.trim(), signature: args.signature.trim(), links,
      status: 'draft' as const, createdAt: now, expiresAt,
    };
    await ctx.db.insert('releaseEmails', row);
    return row;
  },
});

export const claim = mutation({
  args: { secret: v.string(), emailId: v.string(), ownerKey: v.string(), claimId: v.string(), from: v.string() },
  returns: v.object({ claimed: v.boolean(), email: v.object(emailFields) }),
  handler: async (ctx, args) => {
    authorize({ secret: args.secret });
    const row = await ctx.db.query('releaseEmails').withIndex('by_email_id', q => q.eq('emailId', args.emailId)).unique();
    if (!row || row.ownerKey !== args.ownerKey) throw new Error('Email unavailable');
    const { _id, _creationTime, claimId, ...email } = row;
    if (row.status !== 'draft') return { claimed: false, email };
    if (row.expiresAt <= Date.now() || row.createdAt < Date.now() - 86400000) throw new Error('Preview expired. Create a fresh email preview');
    // Recheck share revocation and release state immediately before delivery.
    for (const link of row.links) {
      const share = await ctx.db.query('publicShares').withIndex('by_share_id', q => q.eq('shareId', link.shareId)).unique();
      if (!share || share.revokedAt !== undefined || share.expiresAt <= Date.now()) throw new Error('A selected link is no longer available. Create a fresh email preview');
      for (const jobId of link.jobIds) {
        if (row.publisherId) {
          const submission = await ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_job_id', q => q.eq('clientId', row.clientId!).eq('jobId', jobId)).unique();
          if (submission?.publisherId !== row.publisherId) throw new Error('Email unavailable');
        }
        const stat = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', jobId).eq('offerId', row.offerId)).unique();
        if (!stat || stat.withheld || stat.deletedAt !== undefined || stat.status !== 'complete') throw new Error('A selected creative is no longer released');
      }
    }
    await ctx.db.patch(_id, { status: 'sending', claimId: args.claimId, from: args.from });
    return { claimed: true, email: { ...email, status: 'sending' as const, from: args.from } };
  },
});

export const finish = mutation({
  args: { secret: v.string(), emailId: v.string(), claimId: v.string(), status: v.union(v.literal('sent'), v.literal('uncertain')), messageId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize({ secret: args.secret });
    const row = await ctx.db.query('releaseEmails').withIndex('by_email_id', q => q.eq('emailId', args.emailId)).unique();
    if (!row || row.claimId !== args.claimId) throw new Error('Email unavailable');
    if (row.status === 'sending') await ctx.db.patch(row._id, { status: args.status, ...(args.status === 'sent' ? { sentAt: Date.now(), messageId: args.messageId } : {}) });
    return null;
  },
});
