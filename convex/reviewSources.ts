import { v } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server.js';

export const DIGITAL_NUDGE_SOURCE = 'digital-nudge';

function authorize(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) {
    throw new Error('Unauthorized');
  }
}

// Ownership is independent of the offers evaluated and of who later reads a report.
export async function resolveReviewSource(ctx: QueryCtx, jobId: string) {
  const apiOwner = await ctx.db.query('apiReviewLinks')
    .withIndex('by_job_id', q => q.eq('jobId', jobId)).unique();
  if (apiOwner) return { historySource: `api:${apiOwner.partnerId}`, historySourceKind: 'api' as const };
  const submissions = await ctx.db.query('publisherSubmissions')
    .withIndex('by_job_id', q => q.eq('jobId', jobId)).take(20);
  const external = submissions.find(row => !row.publisherId.startsWith('digital-nudge-'));
  if (external) return { historySource: `publisher:${external.publisherId}`, historySourceKind: 'publisher' as const };
  return { historySource: DIGITAL_NUDGE_SOURCE, historySourceKind: 'internal' as const };
}

export const list = query({
  args: { secret: v.string() },
  returns: v.array(v.object({ value: v.string(), label: v.string(), kind: v.string() })),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const [partners, publishers] = await Promise.all([
      ctx.db.query('apiPartners').take(1000),
      ctx.db.query('publishers').take(1000),
    ]);
    return [
      { value: DIGITAL_NUDGE_SOURCE, label: 'Digital Nudge', kind: 'internal' },
      ...partners.sort((a, b) => a.name.localeCompare(b.name)).map(partner => ({
        value: `api:${partner.partnerId}`,
        label: /\bapi\b/i.test(partner.name) ? partner.name : `${partner.name} API`,
        kind: 'api',
      })),
      ...publishers.filter(publisher => publisher.organizationId !== 'digital-nudge'
        && !publisher.publisherId.startsWith('digital-nudge-'))
        .sort((a, b) => a.name.localeCompare(b.name)).map(publisher => ({
          value: `publisher:${publisher.publisherId}`,
          label: `${publisher.name} · ${publisher.clientId}`,
          kind: 'publisher',
        })),
    ];
  },
});

// Run by the existing post-deploy setup script. Each invocation has bounded reads
// and writes; the durable cursor makes interruption/retry safe.
export const backfill = mutation({
  args: { secret: v.string() },
  returns: v.object({ processed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const key = 'reviewHistorySourcesV1';
    const state = await ctx.db.query('maintenanceState').withIndex('by_key', q => q.eq('key', key)).unique();
    if (state?.complete) return { processed: 0, done: true };
    const result = await ctx.db.query('reviews').order('asc')
      .paginate({ cursor: state?.cursor ?? null, numItems: 50 });
    for (const review of result.page) {
      await ctx.db.patch(review._id, await resolveReviewSource(ctx, review.jobId));
    }
    const value = { key, complete: result.isDone, cursor: result.continueCursor, updatedAt: Date.now() };
    if (state) await ctx.db.patch(state._id, value);
    else await ctx.db.insert('maintenanceState', value);
    return { processed: result.page.length, done: result.isDone };
  },
});
