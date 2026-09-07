import { v } from 'convex/values';
import { mutation, query } from './_generated/server.js';
import { attributeInternalReview, DIGITAL_NUDGE_CLIENTS } from './publisherOwnership.ts';

function authorize(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
}
export const recordHeartbeat = mutation({
  args: { secret: v.string(), instanceId: v.string(), startedAt: v.number(), requests: v.number(), errors: v.number(), active: v.number(), pending: v.number(), workers: v.number(), cpuPercent: v.optional(v.number()), memoryBytes: v.optional(v.number()), memoryLimitBytes: v.optional(v.number()) },
  returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    const previous = await ctx.db.query('platformInstances').withIndex('by_instance_id', q => q.eq('instanceId', args.instanceId)).unique();
    const requests = Math.max(0, args.requests - (previous?.requests ?? 0));
    const errors = Math.max(0, args.errors - (previous?.errors ?? 0));
    const now = Date.now();
    const { secret: _, ...value } = args;
    if (previous) await ctx.db.patch(previous._id, { ...value, updatedAt: now });
    else await ctx.db.insert('platformInstances', { ...value, updatedAt: now });
    const hour = Math.floor(now / 3600000) * 3600000;
    const traffic = await ctx.db.query('platformTrafficHours').withIndex('by_hour', q => q.eq('hour', hour)).unique();
    if (traffic) await ctx.db.patch(traffic._id, { requests: traffic.requests + requests, errors: traffic.errors + errors });
    else await ctx.db.insert('platformTrafficHours', { hour, requests, errors });
    const oldInstances = await ctx.db.query('platformInstances').withIndex('by_updated_at', q => q.lt('updatedAt', now - 86400000)).take(10);
    const oldTraffic = await ctx.db.query('platformTrafficHours').withIndex('by_hour', q => q.lt('hour', now - 7 * 86400000)).take(10);
    for (const row of [...oldInstances, ...oldTraffic]) await ctx.db.delete(row._id);
    return null;
  },
});

export const overview = query({
  args: { secret: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const now = Date.now();
    const [instances, traffic, publishers, stats, timings] = await Promise.all([
      ctx.db.query('platformInstances').withIndex('by_updated_at', q => q.gte('updatedAt', now - 86400000)).order('desc').take(200),
      ctx.db.query('platformTrafficHours').withIndex('by_hour', q => q.gte('hour', now - 86400000)).take(25),
      ctx.db.query('publishers').take(1000),
      ctx.db.query('reviewOfferStats').withIndex('by_created_at').order('desc').take(1000),
      ctx.db.query('reviewProcessingMetrics').withIndex('by_started_at').order('desc').take(200),
    ]);
    const scopes = await Promise.all(stats.map(stat => ctx.db.query('publisherSubmissions').withIndex('by_client_id_and_job_id', q => q.eq('clientId', stat.offerId).eq('jobId', stat.jobId)).unique()));
    const visible = stats.flatMap((stat, i) => stat.deletedAt !== undefined ? [] : [{ ...stat, publisherId: scopes[i]?.publisherId }]);
    const recentReviews = [...new Map(visible.map(stat => [stat.jobId, stat])).values()];
    const summary = (rows: typeof visible) => ({ reviews: rows.length, completed: rows.filter(row => row.status === 'complete').length, failed: rows.filter(row => row.status === 'failed').length, pending: rows.filter(row => !['complete', 'failed'].includes(row.status)).length, flagged: rows.filter(row => row.resultStatus === 'red' || row.resultStatus === 'yellow').length });
    const advertisers = DIGITAL_NUDGE_CLIENTS.map(clientId => ({ clientId, ...summary(visible.filter(row => row.offerId === clientId)), publishers: publishers.filter(p => p.clientId === clientId).map(p => ({ publisherId: p.publisherId, name: p.name, status: p.status, ...summary(visible.filter(row => row.publisherId === p.publisherId)) })) }));
    const durations = timings.map(row => row.totalMs).sort((a, b) => a - b);
    const waits = timings.flatMap(row => row.queueWaitMs === undefined ? [] : [row.queueWaitMs]).sort((a, b) => a - b);
    const percentile = (values: number[], fraction: number) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;
    return {
      observedAt: now, sampleLimit: 1000, sampledOfferResults: stats.length,
      publishers: publishers.length, advertisers, instances, traffic,
      reviews: { sampled: recentReviews.length, complete: recentReviews.filter(r => r.status === 'complete' && r.deletedAt === undefined).length, failed: recentReviews.filter(r => r.status === 'failed' && r.deletedAt === undefined).length, pending: recentReviews.filter(r => !['complete', 'failed'].includes(r.status) && r.deletedAt === undefined).length },
      processing: { sampleSize: timings.length, medianMs: percentile(durations, .5), p95Ms: percentile(durations, .95), p95QueueWaitMs: percentile(waits, .95), failed: timings.filter(row => !row.completed).length },
    };
  },
});

export const backfillDigitalNudge = mutation({
  args: { secret: v.string() }, returns: v.object({ processed: v.number(), done: v.boolean() }), handler: async (ctx, args) => {
    authorize(args.secret);
    const key = 'digital-nudge-ownership-v1';
    const previous = await ctx.db.query('maintenanceState').withIndex('by_key', q => q.eq('key', key)).unique();
    if (previous?.complete) return { processed: 0, done: true };
    const page = await ctx.db.query('reviewOfferStats').paginate({ cursor: previous?.cursor ?? null, numItems: 100 });
    for (const row of page.page) await attributeInternalReview(ctx, row.offerId, row.jobId, row.createdAt);
    const value = { key, complete: page.isDone, cursor: page.continueCursor, updatedAt: Date.now() };
    if (previous) await ctx.db.patch(previous._id, value);
    else await ctx.db.insert('maintenanceState', value);
    return { processed: page.page.length, done: page.isDone };
  },
});
