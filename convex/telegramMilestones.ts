import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './_generated/server.js';
import type { Doc } from './_generated/dataModel';
import { setMessage } from './telegramNotifications.ts';
import { resolveReviewSource } from './reviewSources.ts';
import { adminUrl, batchLink, escapeHtml, localDate, shortText } from './telegramMessageTypes.ts';

type Context = QueryCtx | MutationCtx;
type Section = Doc<'telegramReleaseSummaries'>['sections'][number];
type OfferState = {
  offerId: string; name: string; total: number; withheld: number; red: number; yellow: number; green: number;
  jobIds: string[]; approved: number; disapproved: number; lastDecisionAt: number; unavailable: number; unavailableReleased: number;
};
const byBatch = (ctx: Context, batchId: string) => ctx.db.query('reviewBatches').withIndex('by_batch_id', q => q.eq('batchId', batchId)).unique();
const decisionKey = (batchId: string, offerId: string) => `advertiser-review:${batchId}:${offerId}`;
const terminal = (status: string) => ['complete', 'failed', 'upload_failed'].includes(status);
const color = (status?: string) => status === 'amber' || status === 'orange' ? 'yellow' : status;

async function internalJob(ctx: Context, jobId: string) {
  return (await resolveReviewSource(ctx, jobId)).historySourceKind === 'internal';
}

// Compact stats only: never read the large report documents to prepare messages.
export async function batchState(ctx: Context, batchId: string) {
  const batch = await byBatch(ctx, batchId);
  if (!batch) return null;
  const offers = new Map<string, OfferState>();
  let internalItems = 0;
  let failed = 0;
  for (const item of batch.items) {
    if (item.jobId && !await internalJob(ctx, item.jobId)) continue;
    internalItems++;
    if (['failed', 'upload_failed'].includes(item.status)) { failed++; continue; }
    if (item.status !== 'complete' || !item.jobId) continue;
    const [stats, decisions] = await Promise.all([
      ctx.db.query('reviewOfferStats').withIndex('by_job_id', q => q.eq('jobId', item.jobId!)).take(100),
      ctx.db.query('clientReviewDecisions').withIndex('by_job_id', q => q.eq('jobId', item.jobId!)).take(100),
    ]);
    const offerIds = new Set([...stats.map(s => s.offerId), ...(item.offerOutcomes ?? []).map(s => s.offerId), ...(batch.reviewContext?.offerIds ?? [])]);
    for (const offerId of offerIds) {
      const stat = stats.find(s => s.offerId === offerId);
      if (stat?.deletedAt !== undefined) continue;
      let offer = offers.get(offerId);
      if (!offer) {
        const profile = await ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', offerId)).unique();
        offer = { offerId, name: profile?.displayName ?? item.offerOutcomes?.find(o => o.offerId === offerId)?.offerName ?? offerId,
          total: 0, withheld: 0, red: 0, yellow: 0, green: 0, jobIds: [], approved: 0, disapproved: 0, lastDecisionAt: 0, unavailable: 0, unavailableReleased: 0 };
        offers.set(offerId, offer);
      }
      const verdict = color(stat?.resultStatus);
      if (!stat || stat.status !== 'complete' || !['red', 'yellow', 'green'].includes(verdict ?? '')) {
        offer.unavailable++;
        if (!stat?.withheld) offer.unavailableReleased++;
        continue;
      }
      offer.total++;
      offer[verdict as 'red' | 'yellow' | 'green']++;
      if (stat.withheld) { offer.withheld++; continue; }
      offer.jobIds.push(item.jobId);
      const decision = decisions.filter(d => d.offerId === offerId).sort((a, b) => b.decidedAt - a.decidedAt)[0];
      if (decision) {
        offer[decision.decision === 'approved' ? 'approved' : 'disapproved']++;
        offer.lastDecisionAt = Math.max(offer.lastDecisionAt, decision.decidedAt);
      }
    }
  }
  return { batch, offers: [...offers.values()], failed, internalItems,
    complete: batch.items.length >= batch.expectedCount && batch.items.every(item => terminal(item.status)),
    title: batch.sourceLabel || `Batch ${localDate(batch.createdAt).day} · ${batch.batchId.slice(0, 8)}` };
}

async function deliveryText(ctx: Context, batchId: string, offerId: string, jobIds: string[]) {
  const delivery = await ctx.db.query('telegramBatchDeliveries')
    .withIndex('by_batch_id_and_offer_id', q => q.eq('batchId', batchId).eq('offerId', offerId)).unique();
  if (!delivery || !jobIds.length || !jobIds.every(id => delivery.jobIds.includes(id))) return 'Email not sent yet';
  const recipients = [...delivery.to, ...delivery.cc];
  const addresses = shortText(recipients.slice(0, 3).join(', '), 90)
    + (recipients.length > 3 ? ` (+${recipients.length - 3} more)` : '');
  if (delivery.status === 'sent') {
    const sent = localDate(delivery.sentAt ?? delivery.updatedAt);
    return `✉️ Email sent · ${addresses} · ${sent.day} ${sent.time} (${shortText(process.env.TELEGRAM_DIGEST_TIMEZONE || 'America/Toronto', 40)})`;
  }
  if (delivery.status === 'uncertain' || Date.now() - delivery.updatedAt > 10 * 60_000) return `⚠️ Email sending unconfirmed · check delivery before resending · ${addresses}`;
  return `Email sending · ${addresses}`;
}

async function renderRelease(ctx: MutationCtx, summary: Pick<Doc<'telegramReleaseSummaries'>, 'eventKey' | 'batchId' | 'title' | 'sections'>) {
  const header = `<b>Batch released · ${shortText(summary.title)}</b>`;
  const parts: string[] = [];
  let part = header;
  let reserved = header.length;
  for (const section of summary.sections) {
    const link = summary.batchId.startsWith('selection:')
      ? section.jobIds.length > 1 ? `${adminUrl()}/history` : `${adminUrl()}/reviews/${encodeURIComponent(section.jobIds[0])}/report?offer=${encodeURIComponent(section.offerId)}`
      : batchLink(summary.batchId, section.offerId);
    const body = `<b>${shortText(section.name)} — ${section.jobIds.length} creative${section.jobIds.length === 1 ? '' : 's'}</b>`
      + (section.jobIds.length < section.eligible ? ` (partial release; ${section.eligible} evaluated in batch)` : '')
      + `\nAdChecked assessment: 🔴 ${section.red} · 🟡 ${section.yellow} · 🟢 ${section.green}`
      + `\nAdvertiser review at release: ${section.reviewed}/${section.jobIds.length} completed`;
    const footer = `\n<a href="${escapeHtml(link)}">${summary.batchId.startsWith('selection:') ? 'Open review' : 'Open batch'}</a>`;
    // Reserve the maximum delivery-line space before grouping. Sending updates
    // cannot move an advertiser between posts or leave stale continuation posts.
    const size = body.length + footer.length + 920;
    if (reserved + size > 3800 && part !== header) { parts.push(part); part = header; reserved = header.length; }
    part += `\n\n${body}\nNotification: ${await deliveryText(ctx, summary.batchId, section.offerId, section.jobIds)}${footer}`;
    reserved += size;
  }
  if (part !== header) parts.push(part);
  for (const [index, message] of parts.entries()) await setMessage(ctx, `${summary.eventKey}:${index}`, message);
}

// Called in the release transaction, only for newly released offer/job pairs.
export async function queueReleaseNotifications(ctx: MutationCtx, additions: { jobId: string; batchId?: string; offerIds: string[] }[]) {
  const releaseId = crypto.randomUUID();
  const groups = new Map<string, typeof additions>();
  for (const item of additions) {
    if (!await internalJob(ctx, item.jobId)) continue;
    const key = item.batchId || `selection:${releaseId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const [batchId, items] of groups) {
    await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('telegramMilestones:prepareRelease'), {
      releaseId, batchId, items: items.map(({ jobId, offerIds }) => ({ jobId, offerIds })),
    });
  }
}

export const prepareRelease = internalMutation({
  args: { releaseId: v.string(), batchId: v.string(), items: v.array(v.object({ jobId: v.string(), offerIds: v.array(v.string()) })) },
  returns: v.null(),
  handler: async (ctx, { releaseId, batchId, items }) => {
    const eventKey = `release:${releaseId}:${batchId}`;
    if (await ctx.db.query('telegramReleaseSummaries').withIndex('by_event_key', q => q.eq('eventKey', eventKey)).unique()) return null;
    const state = await batchState(ctx, batchId);
    const sections = new Map<string, Section>();
    for (const item of items) {
      if (!await internalJob(ctx, item.jobId)) continue;
      for (const offerId of item.offerIds) {
        const stat = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', item.jobId).eq('offerId', offerId)).unique();
        const verdict = color(stat?.resultStatus);
        if (!stat || stat.withheld || stat.deletedAt !== undefined || stat.status !== 'complete' || !['red', 'yellow', 'green'].includes(verdict ?? '')) continue;
        let section = sections.get(offerId);
        if (!section) {
          const profile = await ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', offerId)).unique();
          section = { offerId, name: profile?.displayName ?? offerId, jobIds: [], red: 0, yellow: 0, green: 0,
            eligible: state?.offers.find(s => s.offerId === offerId)?.total ?? items.filter(i => i.offerIds.includes(offerId)).length, reviewed: 0 };
          sections.set(offerId, section);
        }
        section.jobIds.push(item.jobId);
        section[verdict as 'red' | 'yellow' | 'green']++;
        const decisions = await ctx.db.query('clientReviewDecisions').withIndex('by_job_id', q => q.eq('jobId', item.jobId)).take(100);
        if (decisions.some(d => d.offerId === offerId)) section.reviewed++;
      }
    }
    if (!sections.size) return null;
    const summary = { eventKey, batchId, title: state?.title ?? 'Selected creatives',
      sections: [...sections.values()].sort((a, b) => a.name.localeCompare(b.name)), createdAt: Date.now() };
    await ctx.db.insert('telegramReleaseSummaries', summary);
    await renderRelease(ctx, summary);
    // A later partial release reopens an already completed advertiser batch.
    if (state) for (const section of sections.values()) await refreshDecisionMessage(ctx, state, section.offerId);
    return null;
  },
});

async function refreshDecisionMessage(ctx: MutationCtx, state: NonNullable<Awaited<ReturnType<typeof batchState>>>, offerId: string) {
  const offer = state.offers.find(s => s.offerId === offerId);
  if (!offer || !offer.jobIds.length) return;
  const reviewed = offer.approved + offer.disapproved;
  const releasedCount = offer.jobIds.length + offer.unavailableReleased;
  const finished = reviewed === releasedCount;
  const eventKey = decisionKey(state.batch.batchId, offerId);
  const existing = await ctx.db.query('telegramNotifications').withIndex('by_event_key', q => q.eq('eventKey', eventKey)).unique();
  if (!finished && !existing) return;
  const message = `<b>${shortText(offer.name)} ${finished ? 'finished reviewing' : 'review reopened'}</b>`
    + `\nBatch: ${shortText(state.title)}`
    + (offer.withheld || !state.complete ? '\nPartial release — covers the creatives currently released to this advertiser.' : '')
    + `\n<b>${reviewed}/${releasedCount} reviewed</b>`
    + `\n✅ ${offer.approved} approved · ❌ ${offer.disapproved} disapproved`
    + (finished ? '' : `\n${releasedCount - reviewed} awaiting a decision or result recovery`)
    + `\n<a href="${escapeHtml(batchLink(state.batch.batchId, offerId))}">View decisions and feedback</a>`;
  if (!finished && existing && !existing.messageId && existing.status !== 'claimed') {
    await ctx.db.patch(existing._id, { message, status: 'sent', updatedAt: Date.now() });
    return;
  }
  await setMessage(ctx, eventKey, message);
}

export async function queueDecisionNotification(ctx: MutationCtx, jobId: string, offerId: string) {
  if (!await internalJob(ctx, jobId)) return;
  const stat = await ctx.db.query('reviewOfferStats').withIndex('by_job_id_and_offer_id', q => q.eq('jobId', jobId).eq('offerId', offerId)).unique();
  if (!stat?.batchId) return;
  const state = await batchState(ctx, stat.batchId);
  if (state) await refreshDecisionMessage(ctx, state, offerId);
}

// Only server-confirmed email attempts update the message. Drafts have no effect.
export async function recordEmailDelivery(ctx: MutationCtx, email: Doc<'releaseEmails'>) {
  if (email.status === 'draft') return;
  for (const link of email.links) {
    if (!(await Promise.all(link.jobIds.map(id => internalJob(ctx, id)))).every(Boolean)) continue;
    const previous = await ctx.db.query('telegramBatchDeliveries')
      .withIndex('by_batch_id_and_offer_id', q => q.eq('batchId', link.batchId).eq('offerId', email.offerId)).unique();
    const attemptCreatedAt = email.sendingAt ?? email.createdAt;
    if (previous && previous.emailId !== email.emailId && previous.attemptCreatedAt > attemptCreatedAt) continue;
    const value = { batchId: link.batchId, offerId: email.offerId, emailId: email.emailId, jobIds: link.jobIds,
      status: email.status, to: email.to, cc: email.cc, attemptCreatedAt,
      updatedAt: email.sentAt ?? attemptCreatedAt, sentAt: email.sentAt };
    if (previous) await ctx.db.patch(previous._id, value);
    else await ctx.db.insert('telegramBatchDeliveries', value);
    await queueReleaseRefresh(ctx, link.batchId);
    const attentionKey = `email-attention:${email.emailId}:${link.batchId}`;
    if (email.status === 'uncertain') await emailAttention(ctx, attentionKey, link.batchId, email.offerId);
    else if (email.status === 'sent') {
      const alert = await ctx.db.query('telegramNotifications').withIndex('by_event_key', q => q.eq('eventKey', attentionKey)).unique();
      if (alert) await setMessage(ctx, attentionKey, `<b>Email sending confirmed</b>\n${await deliveryText(ctx, link.batchId, email.offerId, link.jobIds)}\n<a href="${escapeHtml(batchLink(link.batchId, email.offerId))}">Open batch</a>`);
    }
  }
}

async function emailAttention(ctx: MutationCtx, eventKey: string, batchId: string, offerId: string) {
  await setMessage(ctx, eventKey, `<b>Email needs attention</b>\nAdvertiser: ${shortText(offerId)}\nSending could not be confirmed. Check the email provider before resending; the advertiser may already have received it.\n<a href="${escapeHtml(batchLink(batchId, offerId))}">Open batch</a>`);
}

export const checkDelivery = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const rows = await ctx.db.query('telegramBatchDeliveries').withIndex('by_status_and_updated_at', q => q.eq('status', 'sending').lte('updatedAt', Date.now() - 10 * 60_000)).take(10);
    for (const row of rows) {
      // The email claim remains untouched: a timeout must never resend email.
      await ctx.db.patch(row._id, { status: 'uncertain' });
      await queueReleaseRefresh(ctx, row.batchId);
      await emailAttention(ctx, `email-attention:${row.emailId}:${row.batchId}`, row.batchId, row.offerId);
    }
    return null;
  },
});

async function queueReleaseRefresh(ctx: MutationCtx, batchId: string) {
  // Convex permits one paginated query per transaction. Email claims, finishes,
  // digest backfills and delivery checks can each touch multiple batches.
  // Schedule each refresh atomically with its delivery record, then render in
  // separate transactions so summary pagination cannot roll back email state.
  await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('telegramMilestones:refreshReleasePage'), { batchId, cursor: null });
}

async function refreshReleasePageHandler(ctx: MutationCtx, args: { batchId: string; cursor: string | null }) {
  const page = await ctx.db.query('telegramReleaseSummaries').withIndex('by_batch_id', q => q.eq('batchId', args.batchId))
    .paginate({ cursor: args.cursor, numItems: 20 });
  for (const summary of page.page) await renderRelease(ctx, summary);
  if (!page.isDone) await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('telegramMilestones:refreshReleasePage'), { batchId: args.batchId, cursor: page.continueCursor });
  return null;
}
export const refreshReleasePage = internalMutation({
  args: { batchId: v.string(), cursor: v.union(v.string(), v.null()) }, returns: v.null(), handler: refreshReleasePageHandler,
});

export async function digestSections(ctx: Context, batchId: string, since: number, until: number) {
  const state = await batchState(ctx, batchId);
  if (!state?.internalItems || !state.complete) return [];
  const entries = [];
  for (const offer of state.offers) {
    if (!offer.total && !offer.unavailable) continue;
    const reviewed = offer.approved + offer.disapproved;
    const finished = offer.jobIds.length > 0 && reviewed === offer.jobIds.length && !offer.withheld && !offer.unavailable;
    if (finished && (offer.lastDecisionAt < since || offer.lastDecisionAt > until)) continue;
    const stages = [];
    if (offer.withheld) stages.push(`${offer.withheld} ready for release`);
    if (offer.jobIds.length) {
      stages.push(finished ? `Review completed · ✅ ${offer.approved} approved · ❌ ${offer.disapproved} disapproved`
        : `Advertiser review: ${reviewed}/${offer.jobIds.length} completed`);
      stages.push(`Notification: ${await deliveryText(ctx, batchId, offer.offerId, offer.jobIds)}`);
    }
    if (offer.unavailable) stages.push(`${offer.unavailable} not evaluated / results unavailable — check batch`);
    entries.push({ offerId: offer.offerId, name: offer.name,
      message: `<b>${shortText(offer.name)}</b> · ${shortText(state.title)}\n${offer.total} evaluated · 🔴 ${offer.red} · 🟡 ${offer.yellow} · 🟢 ${offer.green}`
        + (state.failed ? ` · ${state.failed} batch upload/processing failures` : '')
        + `\n${stages.join('\n')}\n<a href="${escapeHtml(batchLink(batchId, offer.offerId))}">Open batch</a>` });
  }
  return entries;
}

// Read-only operator preview; it does not enqueue or send anything.
export const previewBatch = internalQuery({
  args: { batchId: v.string() }, returns: v.array(v.object({ offerId: v.string(), name: v.string(), message: v.string() })),
  handler: (ctx, args) => digestSections(ctx, args.batchId, Date.now() - 86400000, Date.now()),
});
