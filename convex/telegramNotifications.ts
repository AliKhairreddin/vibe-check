import { v } from 'convex/values';
import { mutation, query } from './_generated/server.js';
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';

const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;

function requireSecret(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) {
    throw new Error('Unauthorized');
  }
}

const delivery = v.union(v.null(), v.object({
  eventKey: v.string(), message: v.string(), claimId: v.string(),
  pdfJobId: v.union(v.string(), v.null()),
}));

export const isApiReview = query({
  args: { secret: v.string(), jobId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    return Boolean(await ctx.db.query('apiReviewLinks')
      .withIndex('by_job_id', q => q.eq('jobId', args.jobId)).unique());
  },
});

async function claimRow(ctx: MutationCtx, row: Doc<'telegramNotifications'>) {
  const now = Date.now();
  if (row.status === 'sent' || row.status === 'exhausted' || row.nextAttemptAt > now) return null;
  if (row.attempts >= MAX_ATTEMPTS) {
    await ctx.db.patch(row._id, { status: 'exhausted', claimId: undefined, updatedAt: now });
    return null;
  }
  const claimId = crypto.randomUUID();
  await ctx.db.patch(row._id, {
    status: 'claimed', claimId, attempts: row.attempts + 1,
    nextAttemptAt: now + LEASE_MS, updatedAt: now,
  });
  return { eventKey: row.eventKey, message: row.message, claimId, pdfJobId: row.pdfJobId ?? null };
}

// Called by the existing authenticated Python backend, never by the browser.
export const enqueue = mutation({
  args: { secret: v.string(), eventKey: v.string(), message: v.string(), pdfJobId: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    if (!args.eventKey || args.eventKey.length > 250 || !args.message || args.message.length > 3900) {
      throw new Error('Invalid notification');
    }
    const existing = await ctx.db.query('telegramNotifications')
      .withIndex('by_event_key', q => q.eq('eventKey', args.eventKey)).unique();
    if (existing) return existing.status;
    const now = Date.now();
    await ctx.db.insert('telegramNotifications', {
      eventKey: args.eventKey, message: args.message,
      ...(args.pdfJobId ? { pdfJobId: args.pdfJobId } : {}),
      status: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    });
    return 'pending';
  },
});

export const claim = mutation({
  args: { secret: v.string(), eventKey: v.optional(v.string()) },
  returns: delivery,
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    if (args.eventKey) {
      const row = await ctx.db.query('telegramNotifications')
        .withIndex('by_event_key', q => q.eq('eventKey', args.eventKey!)).unique();
      return row ? await claimRow(ctx, row) : null;
    }
    for (const status of ['pending', 'claimed'] as const) {
      const rows = await ctx.db.query('telegramNotifications')
        .withIndex('by_status_and_next_attempt_at', q => q.eq('status', status).lte('nextAttemptAt', Date.now()))
        .take(10);
      for (const row of rows) {
        const claimed = await claimRow(ctx, row);
        if (claimed) return claimed;
      }
    }
    return null;
  },
});

export const finish = mutation({
  args: { secret: v.string(), eventKey: v.string(), claimId: v.string(), success: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const row = await ctx.db.query('telegramNotifications')
      .withIndex('by_event_key', q => q.eq('eventKey', args.eventKey)).unique();
    if (!row || row.status !== 'claimed' || row.claimId !== args.claimId) return false;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: args.success ? 'sent' : row.attempts >= MAX_ATTEMPTS ? 'exhausted' : 'pending',
      claimId: undefined, updatedAt: now,
      nextAttemptAt: now + Math.min(60_000 * 2 ** (row.attempts - 1), 60 * 60_000),
    });
    return true;
  },
});

export const queueStalledBatches = mutation({
  args: { secret: v.string(), appUrl: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    requireSecret(args.secret);
    const now = Date.now();
    const batches = await ctx.db.query('reviewBatches')
      .withIndex('by_notification_ready_and_attention_notified_at_and_updated_at', q =>
        q.eq('notificationReady', false).eq('attentionNotifiedAt', undefined).lte('updatedAt', now - 2 * 60 * 60_000))
      .take(10);
    let queued = 0;
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    for (const batch of batches) {
      const pending = batch.items.filter(item => !item.jobId && !['complete', 'failed', 'upload_failed'].includes(item.status));
      if (pending.length) {
        const eventKey = `batch:${batch.batchId}:stalled:${batch.updatedAt}`;
        const exists = await ctx.db.query('telegramNotifications').withIndex('by_event_key', q => q.eq('eventKey', eventKey)).unique();
        if (!exists) {
          const clients = [...new Set(pending.flatMap(item => (item.offerOutcomes ?? []).map(outcome => outcome.offerName)))];
          const url = `${args.appUrl.replace(/\/$/, '')}/batches/${encodeURIComponent(batch.batchId)}`;
          const message = [
            '<b>Review batch needs attention</b>',
            `Client: ${escape(clients.join(', ').slice(0, 300) || 'See batch details')}`,
            `${pending.length} of ${batch.expectedCount} items have not reached processing.`,
            'No batch progress has been recorded for two hours. Check the uploads and retry any incomplete items.',
            args.appUrl ? `<a href="${escape(url)}">Open batch progress</a>` : `Batch: ${escape(batch.batchId)}`,
          ].join('\n');
          await ctx.db.insert('telegramNotifications', {
            eventKey, message, status: 'pending', attempts: 0,
            nextAttemptAt: now, createdAt: now, updatedAt: now,
          });
          queued++;
        }
      }
      // Alert once without cancelling an upload that may still be recoverable.
      await ctx.db.patch(batch._id, { attentionNotifiedAt: now });
    }
    return queued;
  },
});
