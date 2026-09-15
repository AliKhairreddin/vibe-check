import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, type MutationCtx } from './_generated/server.js';
import type { Id } from './_generated/dataModel';
import { digestSections, recordEmailDelivery } from './telegramMilestones.ts';
import { localDate, messageParts } from './telegramMessageTypes.ts';
import { setMessage } from './telegramNotifications.ts';

const advance = makeFunctionReference<'mutation'>('telegramDigest:advanceRun');
async function schedule(ctx: MutationCtx, runId: Id<'telegramDigestRuns'>) {
  await ctx.scheduler.runAfter(0, advance, { runId });
}

export const tick = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    if (process.env.TELEGRAM_DIGEST_ENABLED === 'false') return null;
    const latest = await ctx.db.query('telegramDigestRuns').withIndex('by_started_at').order('desc').first();
    if (latest && latest.status !== 'complete') { await schedule(ctx, latest._id); return null; }
    const now = Date.now();
    const local = localDate(now);
    const time = process.env.TELEGRAM_DIGEST_TIME || '18:00';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('TELEGRAM_DIGEST_TIME must be HH:mm');
    if (local.time < time) return null;
    if (await ctx.db.query('telegramDigestRuns').withIndex('by_day', q => q.eq('day', local.day)).unique()) return null;
    const runId = await ctx.db.insert('telegramDigestRuns', {
      day: local.day, startedAt: now, since: latest?.startedAt ?? now - 86400000,
      status: latest ? 'scanning' : 'emails', cursor: null, part: 0, buffer: [],
    });
    await schedule(ctx, runId);
    return null;
  },
});

// Each transaction advances its stored cursor. Repeated scheduler invocations
// continue from that cursor rather than repeating work or sending another digest.
export const advanceRun = internalMutation({
  args: { runId: v.id('telegramDigestRuns') }, returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status === 'complete') return null;
    if (run.status === 'emails') {
      // Seed existing delivery records once so the first roundup never labels a
      // previously sent email as unsent. New sends are recorded transactionally.
      const page = await ctx.db.query('releaseEmails').paginate({ cursor: run.cursor, numItems: 1 });
      for (const email of page.page) await recordEmailDelivery(ctx, email);
      await ctx.db.patch(runId, { status: page.isDone ? 'scanning' : 'emails', cursor: page.isDone ? null : page.continueCursor });
    } else if (run.status === 'scanning') {
      const page = await ctx.db.query('reviewBatches').withIndex('by_created_at', q => q.lte('createdAt', run.startedAt))
        .paginate({ cursor: run.cursor, numItems: 1 });
      for (const batch of page.page) {
        for (const entry of await digestSections(ctx, batch.batchId, run.since, run.startedAt)) {
          await ctx.db.insert('telegramDigestEntries', { day: run.day, batchId: batch.batchId, ...entry });
        }
      }
      await ctx.db.patch(runId, { status: page.isDone ? 'sending' : 'scanning', cursor: page.isDone ? null : page.continueCursor });
    } else {
      const page = await ctx.db.query('telegramDigestEntries').withIndex('by_day_and_name', q => q.eq('day', run.day))
        .paginate({ cursor: run.cursor, numItems: 10 });
      const header = `<b>Creative review roundup · ${run.day}</b>`;
      const parts = messageParts(header, [...run.buffer, ...page.page.map(entry => entry.message)]);
      const pending = page.isDone ? [] : parts.splice(-1);
      let part = run.part;
      for (const message of parts) await setMessage(ctx, `digest:${run.day}:${part++}`, message);
      // Store the last incomplete message without its heading for the next page.
      const buffer = pending.map(message => message.slice(header.length).replace(/^ \(continued\)/, '').trim());
      await ctx.db.patch(runId, { cursor: page.continueCursor, status: page.isDone ? 'complete' : 'sending', part, buffer });
    }
    await schedule(ctx, runId);
    return null;
  },
});
