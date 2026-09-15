import assert from 'node:assert/strict';
import test from 'node:test';
import { release } from '../convex/reviewReleases.ts';
import { decide, clearDecision } from '../convex/clientReviews.ts';
import { claim, finish, setMessage, enqueue } from '../convex/telegramNotifications.ts';
import { digestSections, recordEmailDelivery, checkDelivery, prepareRelease } from '../convex/telegramMilestones.ts';
import { tick, advanceRun } from '../convex/telegramDigest.ts';
import { localDate, localDayStart, messageParts } from '../convex/telegramMessageTypes.ts';

const secret = 'milestone-secret';
process.env.CONVEX_HTTP_SECRET = secret;
const invoke = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, { secret, ...args });

function fixture() {
  const tables: Record<string, any[]> = {};
  let serial = 0;
  const scheduled: any[] = [];
  const db = {
    query(table: string) {
      const predicates: ((row: any) => boolean)[] = [];
      let indexName = ''; let direction = 1;
      const index: any = Object.fromEntries(['eq', 'gte', 'lte', 'lt'].map(op => [op, (key: string, value: any) => {
        predicates.push(row => op === 'eq' ? row[key] === value : op === 'gte' ? row[key] >= value : op === 'lte' ? row[key] <= value : row[key] < value); return index;
      }]));
      const rows = () => (tables[table] ?? []).filter(row => predicates.every(p => p(row))).sort((a, b) => {
        const field = indexName === 'by_day_and_name' ? 'name' : indexName === 'by_started_at' ? 'startedAt' : indexName === 'by_created_at' ? 'createdAt' : '_creationTime';
        return (typeof a[field] === 'string' ? a[field].localeCompare(b[field]) : a[field] - b[field]) * direction;
      });
      const query: any = {
        withIndex(name: string, fn?: (index: any) => void) { indexName = name; fn?.(index); return query; },
        order(value: string) { direction = value === 'desc' ? -1 : 1; return query; },
        async take(count: number) { return rows().slice(0, count); },
        async first() { return rows()[0] ?? null; },
        async unique() { assert.ok(rows().length <= 1); return rows()[0] ?? null; },
        async paginate({ cursor, numItems }: any) {
          const start = Number(cursor ?? 0); const end = start + numItems;
          return { page: rows().slice(start, end), isDone: end >= rows().length, continueCursor: String(end) };
        },
      };
      return query;
    },
    async insert(table: string, value: any) {
      const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial };
      (tables[table] ??= []).push(row); return row._id;
    },
    async get(id: string) { return Object.values(tables).flat().find(row => row._id === id) ?? null; },
    async patch(id: string, value: any) { Object.assign(await db.get(id), value); },
    async replace(id: string, value: any) { const row = await db.get(id); const created = row._creationTime; for (const key of Object.keys(row)) delete row[key]; Object.assign(row, value, { _id: id, _creationTime: created }); },
    async delete(id: string) { for (const rows of Object.values(tables)) { const i = rows.findIndex(row => row._id === id); if (i >= 0) rows.splice(i, 1); } },
  };
  const ctx: any = { db, scheduler: { runAfter: async (_delay: number, _fn: any, args: any) => { scheduled.push(args); return 'scheduled'; } } };
  async function addBatch(batchId = 'batch', count = 3, offers = ['kissterra'], privateResults = true) {
    for (const offerId of offers) if (!(tables.offerProfiles ?? []).some(row => row.offerId === offerId)) {
      await db.insert('offerProfiles', { offerId, displayName: offerId === 'kissterra' ? 'Kissterra' : offerId });
    }
    const items = [];
    for (let i = 0; i < count; i++) {
      const jobId = `${batchId}-${i}`;
      await db.insert('reviews', { jobId, batchId, status: 'complete', reportReady: true, offerIds: offers,
        releasedOfferIds: privateResults ? [] : offers, createdAt: Date.now(), updatedAt: Date.now(), fileName: 'creative.png' });
      for (const offerId of offers) await db.insert('reviewOfferStats', { jobId, batchId, offerId, status: 'complete',
        resultStatus: ['red', 'yellow', 'green'][i % 3], withheld: privateResults ? true : undefined, createdAt: Date.now(), updatedAt: Date.now() });
      items.push({ jobId, itemId: String(i), status: 'complete', fileName: 'creative.png', offerOutcomes: [] });
    }
    await db.insert('reviewBatches', { batchId, sourceLabel: `${batchId} <Auto>`, createdAt: Date.now(), expectedCount: count, items });
    return items.map(item => item.jobId);
  }
  const posts = () => tables.telegramNotifications ?? [];
  const releaseBatch = async (jobIds: string[], offerIds = ['kissterra']) => {
    const result = await invoke(release, ctx, { jobIds, offerIds, confirmed: true, releasedBy: 'admin' });
    while (scheduled.some(args => args.releaseId)) {
      const [args] = scheduled.splice(scheduled.findIndex(args => args.releaseId), 1);
      await invoke(prepareRelease, ctx, args);
    }
    return result;
  };
  const decision = (jobId: string, offerId = 'kissterra', value = 'approved') => invoke(decide, ctx, { jobId, offerId, clientId: offerId, decision: value, feedbackReason: 'business_decision' });
  return { ctx, db, tables, scheduled, addBatch, posts, releaseBatch, decision };
}

test('release groups advertisers, uses original colors, and repeating release is quiet', async () => {
  const f = fixture(); const ids = await f.addBatch('batch', 3, ['kissterra', 'acp']);
  await f.releaseBatch(ids, ['kissterra', 'acp']);
  assert.equal(f.posts().length, 1);
  const message = f.posts()[0].message;
  assert.match(message, /Kissterra — 3/); assert.match(message, /acp — 3/);
  assert.match(message, /🔴 1 · 🟡 1 · 🟢 1/);
  assert.match(message, /0\/3 completed/); assert.match(message, /Email not sent yet/);
  assert.match(message, /&lt;Auto&gt;/); assert.doesNotMatch(message, /<Auto>/);
  await f.releaseBatch(ids, ['kissterra', 'acp']);
  assert.equal(f.posts().length, 1);
});

test('all explicit decisions trigger one completion per advertiser; edits correct the same post', async () => {
  const f = fixture(); const ids = await f.addBatch('batch', 3, ['kissterra', 'acp']);
  await f.releaseBatch(ids, ['kissterra', 'acp']);
  for (const id of ids.slice(0, 2)) await f.decision(id);
  assert.equal(f.posts().length, 1); // Green alone does not count as a decision.
  await f.decision(ids[2], 'kissterra', 'disapproved');
  assert.equal(f.posts().length, 2);
  const completed = f.posts()[1];
  assert.match(completed.message, /3\/3 reviewed/); assert.match(completed.message, /2 approved · ❌ 1 disapproved/);
  await f.decision(ids[2], 'kissterra', 'disapproved');
  assert.equal(completed.revision, 1);
  await f.decision(ids[2]);
  assert.equal(f.posts().length, 2); assert.match(completed.message, /3 approved · ❌ 0 disapproved/);
  assert.equal(f.posts()[0].message.match(/🔴 1 · 🟡 1 · 🟢 1/g).length, 2);
});

test('partial release completion excludes withheld items and reopens after more release', async () => {
  const f = fixture(); const ids = await f.addBatch();
  await f.releaseBatch([ids[0]]); await f.decision(ids[0]);
  const completed = f.posts().find((row: any) => row.eventKey.startsWith('advertiser-review:'));
  assert.match(completed.message, /Partial release/); assert.match(completed.message, /1\/1 reviewed/);
  completed.messageId = 44; completed.status = 'sent';
  await f.releaseBatch(ids.slice(1));
  assert.match(completed.message, /review reopened/); assert.match(completed.message, /1\/3 reviewed/);
  await f.decision(ids[1]); await f.decision(ids[2]);
  assert.match(completed.message, /finished reviewing/); assert.equal(completed.messageId, 44);
  assert.equal(f.posts().filter((row: any) => row.eventKey.startsWith('advertiser-review:')).length, 1);
  await invoke(clearDecision, f.ctx, { jobId: ids[0], offerId: 'kissterra', clientId: 'kissterra' });
  assert.match(completed.message, /2\/3 reviewed/);
});

test('a decision cleared before delivery cancels the premature completion', async () => {
  const f = fixture(); const ids = await f.addBatch('small', 1); await f.releaseBatch(ids); await f.decision(ids[0]);
  const post = f.posts().find((row: any) => row.eventKey.startsWith('advertiser-review:'));
  await invoke(clearDecision, f.ctx, { jobId: ids[0], offerId: 'kissterra', clientId: 'kissterra' });
  assert.equal(post.status, 'sent');
  assert.equal(await invoke(claim, f.ctx, { eventKey: post.eventKey, protocol: 2 }), null);
  await f.decision(ids[0]);
  assert.equal(post.status, 'pending');
});

test('API and external publisher releases, decisions, and digest entries stay out of the internal chat', async () => {
  for (const kind of ['api', 'publisher']) {
    const f = fixture(); const ids = await f.addBatch();
    for (const jobId of ids) await f.db.insert(kind === 'api' ? 'apiReviewLinks' : 'publisherSubmissions',
      { jobId, partnerId: 'partner', publisherId: 'external', clientId: 'kissterra' });
    await f.releaseBatch(ids); for (const id of ids) await f.decision(id);
    assert.equal(f.posts().length, 0);
    assert.deepEqual(await digestSections(f.ctx, 'batch', 0, Date.now()), []);
  }
});

test('delivery stores Telegram identifiers and edits the same post when email status changes', async () => {
  const f = fixture(); const ids = await f.addBatch(); await f.releaseBatch(ids);
  const post = f.posts()[0];
  assert.equal(await invoke(claim, f.ctx, { eventKey: post.eventKey }), null); // old container protocol
  const claimed = await invoke(claim, f.ctx, { eventKey: post.eventKey, protocol: 2 });
  const email: any = { emailId: 'email', offerId: 'kissterra', status: 'sent', to: ['advertiser@example.com'], cc: [],
    createdAt: Date.now(), sentAt: Date.now(), links: [{ batchId: 'batch', jobIds: ids }] };
  await recordEmailDelivery(f.ctx, email); // races with the original send acknowledgement
  assert.equal(post.status, 'claimed');
  await invoke(finish, f.ctx, { eventKey: post.eventKey, claimId: claimed.claimId, success: true, messageId: 123, chatId: '-100' });
  assert.equal(post.status, 'pending'); assert.equal(post.messageId, 123);
  const edit = await invoke(claim, f.ctx, { eventKey: post.eventKey, protocol: 2 });
  assert.equal(edit.messageId, 123); assert.match(edit.message, /Email sent · advertiser@example.com/);
  await invoke(finish, f.ctx, { eventKey: post.eventKey, claimId: edit.claimId, success: true, messageId: 123, chatId: '-100' });
  assert.equal(post.status, 'sent'); assert.equal(f.posts().length, 1);
});

test('email previews are quiet, coverage is checked, and uncertain attempts never claim success', async () => {
  const f = fixture(); const ids = await f.addBatch(); await f.releaseBatch(ids);
  const email: any = { emailId: 'email', offerId: 'kissterra', status: 'draft', to: ['advertiser@example.com'], cc: [],
    createdAt: Date.now(), links: [{ batchId: 'batch', jobIds: [ids[0]] }] };
  await recordEmailDelivery(f.ctx, email); assert.equal(f.tables.telegramBatchDeliveries, undefined);
  await recordEmailDelivery(f.ctx, { ...email, status: 'sent', sentAt: Date.now() });
  assert.match(f.posts()[0].message, /Email not sent yet/); // The rest of the release was not sent.
  await recordEmailDelivery(f.ctx, { ...email, status: 'uncertain', links: [{ batchId: 'batch', jobIds: ids }] });
  assert.match(f.posts()[0].message, /Email sending unconfirmed/);
  assert.match(f.posts()[1].message, /Email needs attention/);
  await recordEmailDelivery(f.ctx, { ...email, status: 'uncertain', links: [{ batchId: 'batch', jobIds: ids }] });
  assert.equal(f.posts().length, 2);
});

test('a stuck email send creates one alert and leaves the original email claim unchanged', async () => {
  const f = fixture(); const ids = await f.addBatch(); await f.releaseBatch(ids);
  const email: any = { emailId: 'stuck', offerId: 'kissterra', status: 'sending', to: ['advertiser@example.com'], cc: [],
    createdAt: Date.now() - 900000, links: [{ batchId: 'batch', jobIds: ids }] };
  await recordEmailDelivery(f.ctx, email); await invoke(checkDelivery, f.ctx);
  assert.match(f.posts()[1].message, /Email needs attention/); assert.equal(email.status, 'sending');
  await invoke(checkDelivery, f.ctx); assert.equal(f.posts().length, 2);
});

test('roundup separates ready, partial decisions, completed activity and unavailable results', async () => {
  const f = fixture(); const ids = await f.addBatch();
  let [entry] = await digestSections(f.ctx, 'batch', 0, Date.now());
  assert.match(entry.message, /3 ready for release/);
  await f.releaseBatch(ids); await f.decision(ids[0]);
  [entry] = await digestSections(f.ctx, 'batch', 0, Date.now());
  assert.match(entry.message, /1\/3 completed/);
  for (const id of ids.slice(1)) await f.decision(id);
  [entry] = await digestSections(f.ctx, 'batch', 0, Date.now());
  assert.match(entry.message, /Review completed/);
  assert.deepEqual(await digestSections(f.ctx, 'batch', Date.now() + 1, Date.now() + 2), []);
  f.tables.reviewOfferStats[0].resultStatus = undefined;
  [entry] = await digestSections(f.ctx, 'batch', 0, Date.now());
  assert.match(entry.message, /1 not evaluated/); assert.match(entry.message, /🔴 0/);
});

test('roundup is once per local day, resumes pages, groups advertisers and omits empty posts', async () => {
  const f = fixture();
  for (let i = 0; i < 24; i++) await f.addBatch(`batch-${i}`, 1, [i % 2 ? 'Zebra' : 'Alpha']);
  process.env.TELEGRAM_DIGEST_TIME = '00:00';
  await invoke(tick, f.ctx); await invoke(tick, f.ctx);
  assert.equal(f.tables.telegramDigestRuns.length, 1);
  while (f.scheduled.length) await invoke(advanceRun, f.ctx, f.scheduled.shift());
  const run = f.tables.telegramDigestRuns[0]; assert.equal(run.status, 'complete');
  assert.equal(f.tables.telegramDigestEntries.length, 24);
  const text = f.posts().map((post: any) => post.message).join('\n');
  for (let i = 0; i < 24; i++) assert.equal((text.match(new RegExp(`/batches/batch-${i}\\?`, 'g')) ?? []).length, 1);
  assert.ok(text.lastIndexOf('<b>Alpha</b>') < text.indexOf('<b>Zebra</b>'));
  assert.ok(f.posts().every((post: any) => post.message.length <= 3900));
  const count = f.posts().length; await invoke(tick, f.ctx); assert.equal(f.posts().length, count);
  const empty = fixture(); await invoke(tick, empty.ctx);
  while (empty.scheduled.length) await invoke(advanceRun, empty.ctx, empty.scheduled.shift());
  assert.deepEqual(empty.posts(), []);
  delete process.env.TELEGRAM_DIGEST_TIME;
});

test('roundup includes only today’s batches and keeps its window when resumed after midnight', async t => {
  for (const [timeZone, midnight, evening] of [
    ['America/Toronto', '2026-09-15T04:00:00Z', '2026-09-15T22:00:00Z'],
    ['Asia/Kolkata', '2026-09-14T18:30:00Z', '2026-09-15T12:30:00Z'],
  ]) await t.test(timeZone, async t => {
    const previousZone = process.env.TELEGRAM_DIGEST_TIMEZONE;
    const previousTime = process.env.TELEGRAM_DIGEST_TIME;
    process.env.TELEGRAM_DIGEST_TIMEZONE = timeZone;
    process.env.TELEGRAM_DIGEST_TIME = '18:00';
    t.after(() => {
      if (previousZone === undefined) delete process.env.TELEGRAM_DIGEST_TIMEZONE;
      else process.env.TELEGRAM_DIGEST_TIMEZONE = previousZone;
      if (previousTime === undefined) delete process.env.TELEGRAM_DIGEST_TIME;
      else process.env.TELEGRAM_DIGEST_TIME = previousTime;
    });
    const start = Date.parse(midnight);
    const cutoff = Date.parse(evening);
    let now = cutoff;
    t.mock.method(Date, 'now', () => now);
    const f = fixture();
    // A missed roundup must not turn today's message into a multi-day backlog.
    await f.db.insert('telegramDigestRuns', { day: '2026-09-12', startedAt: cutoff - 3 * 86400000,
      since: start - 3 * 86400000, status: 'complete', cursor: null, part: 0, buffer: [] });
    for (const [batchId, createdAt] of [
      ['old-ready', start - 1], ['old-reviewed-today', start - 1],
      ['today-midnight', start], ['today-reviewed', start + 1],
      ['today-cutoff', cutoff], ['after-cutoff', cutoff + 1], ['still-processing', start],
    ] as const) {
      const ids = await f.addBatch(batchId, 1);
      f.tables.reviewBatches.find(batch => batch.batchId === batchId).createdAt = createdAt;
      if (batchId.includes('reviewed')) { await f.releaseBatch(ids); await f.decision(ids[0]); }
      if (batchId === 'still-processing') f.tables.reviewBatches.find(batch => batch.batchId === batchId).items[0].status = 'processing';
    }
    await invoke(tick, f.ctx);
    const run = f.tables.telegramDigestRuns[1];
    assert.equal(run.day, '2026-09-15');
    assert.equal(run.since, start);
    // Stored bounds must survive retries even after the local date has changed.
    now += 86400000;
    while (f.scheduled.length) await invoke(advanceRun, f.ctx, f.scheduled.shift());
    assert.equal(run.status, 'complete');
    assert.deepEqual(f.tables.telegramDigestEntries.map(entry => entry.batchId).sort(),
      ['today-cutoff', 'today-midnight', 'today-reviewed']);
    const posts = f.posts().filter(post => post.eventKey.startsWith('digest:'));
    assert.ok(posts.length > 0);
    assert.match(posts[0].message, /Creative review roundup · 2026-09-15/);
    assert.match(posts[0].message, /Review completed/);
    // None of yesterday's outstanding or post-cutoff batches carry over.
    await invoke(tick, f.ctx);
    while (f.scheduled.length) await invoke(advanceRun, f.ctx, f.scheduled.shift());
    assert.equal(f.posts().filter(post => post.eventKey.startsWith('digest:')).length, posts.length);
  });
});

test('the first roundup stays quiet when only older outstanding batches exist', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-15T23:00:00Z'));
  const f = fixture();
  await f.addBatch('old-outstanding');
  f.tables.reviewBatches[0].createdAt = Date.now() - 7 * 86400000;
  await invoke(tick, f.ctx);
  while (f.scheduled.length) await invoke(advanceRun, f.ctx, f.scheduled.shift());
  assert.equal(f.tables.telegramDigestRuns[0].status, 'complete');
  assert.deepEqual(f.posts(), []);
});

test('local day bounds follow DST and configured timezones instead of UTC or a rolling 24 hours', () => {
  for (const [timeZone, timestamp, expected] of [
    ['America/Toronto', '2026-03-08T22:00:00Z', '2026-03-08T05:00:00Z'],
    ['America/Toronto', '2026-11-01T23:00:00Z', '2026-11-01T04:00:00Z'],
    ['America/Toronto', '2026-09-15T04:00:00Z', '2026-09-15T04:00:00Z'],
    ['America/Toronto', '2026-09-15T03:59:59.999Z', '2026-09-14T04:00:00Z'],
    ['Asia/Kolkata', '2026-09-15T12:30:00Z', '2026-09-14T18:30:00Z'],
    ['Pacific/Kiritimati', '2026-09-15T04:00:00Z', '2026-09-14T10:00:00Z'],
  ]) assert.equal(localDayStart(Date.parse(timestamp), timeZone), Date.parse(expected), `${timeZone} at ${timestamp}`);
});

test('legacy queued/start/success messages are suppressed during rolling deployment; failures remain', async () => {
  const f = fixture();
  for (const title of ['Review queued', 'Review batch started', 'Creative review done', 'Scheduled review — no new creatives', 'Creative review 2026-09-14 — done']) {
    assert.equal(await invoke(enqueue, f.ctx, { eventKey: title, message: `<b>${title}</b>` }), 'sent');
  }
  assert.equal(f.posts().length, 0);
  assert.equal(await invoke(enqueue, f.ctx, { eventKey: 'failure', message: '<b>Creative review 2026-09-14 — done with issues</b>' }), 'pending');
});

test('HTML splitting stays within Telegram UTF-16 limits and local dates respect DST', () => {
  const parts = messageParts('<b>Roundup</b>', Array.from({ length: 50 }, () => '<b>🟢 Advertiser &amp; team</b>\n' + 'x'.repeat(150)));
  for (const part of parts) { assert.ok(part.length < 3900); assert.equal((part.match(/<b>/g) ?? []).length, (part.match(/<\/b>/g) ?? []).length); }
  assert.equal(localDate(Date.parse('2026-07-01T22:00:00Z'), 'America/Toronto').time, '18:00');
  assert.equal(localDate(Date.parse('2026-12-01T23:00:00Z'), 'America/Toronto').time, '18:00');
});

test('expired editable claims cannot overwrite the acknowledgement of a newer delivery', async () => {
  const f = fixture(); await setMessage(f.ctx, 'release:test', 'Released');
  const first = await invoke(claim, f.ctx, { protocol: 2 }); f.posts()[0].nextAttemptAt = 0;
  const second = await invoke(claim, f.ctx, { protocol: 2 });
  assert.equal(await invoke(finish, f.ctx, { eventKey: first.eventKey, claimId: first.claimId, success: true, messageId: 99 }), false);
  assert.equal(await invoke(finish, f.ctx, { eventKey: second.eventKey, claimId: second.claimId, success: true, messageId: 100 }), true);
  assert.equal(f.posts()[0].messageId, 100);
});

test('the first roundup recognizes historical sent email before summarizing existing batches', async () => {
  const f = fixture(); const ids = await f.addBatch('existing', 1, ['kissterra'], false);
  await f.db.insert('releaseEmails', { emailId: 'historical', offerId: 'kissterra', status: 'sent',
    to: ['already-sent@example.com'], cc: [], createdAt: Date.now() - 60000, sentAt: Date.now() - 50000,
    links: [{ batchId: 'existing', jobIds: ids }] });
  process.env.TELEGRAM_DIGEST_TIME = '00:00';
  await invoke(tick, f.ctx);
  while (f.scheduled.length) await invoke(advanceRun, f.ctx, f.scheduled.shift());
  assert.match(f.posts()[0].message, /Email sent · already-sent@example.com/);
  assert.doesNotMatch(f.posts()[0].message, /Email not sent/);
  delete process.env.TELEGRAM_DIGEST_TIME;
});

test('late callbacks from older emails cannot replace a newer attempt', async () => {
  const f = fixture(); const ids = await f.addBatch(); await f.releaseBatch(ids);
  const email: any = { emailId: 'new', offerId: 'kissterra', status: 'sent', to: ['new@example.com'], cc: [],
    createdAt: 100, sendingAt: 200, sentAt: 300, links: [{ batchId: 'batch', jobIds: ids }] };
  await recordEmailDelivery(f.ctx, email);
  await recordEmailDelivery(f.ctx, { ...email, emailId: 'old', sendingAt: 150, status: 'uncertain', to: ['old@example.com'] });
  assert.match(f.posts()[0].message, /new@example.com/); assert.equal(f.posts().length, 1);
});

test('long multi-advertiser releases retain stable continuation posts through sending updates', async () => {
  const f = fixture(); const offers = Array.from({ length: 10 }, (_, i) => `offer-${i}`);
  const ids = await f.addBatch('large', 3, offers);
  for (const profile of f.tables.offerProfiles) profile.displayName = profile.offerId + '&'.repeat(90);
  await f.releaseBatch(ids, offers);
  const locations = offers.map(offer => f.posts().findIndex((p: any) => p.message.includes(`${offer}&amp;`)));
  const count = f.posts().length;
  for (const offerId of offers) await recordEmailDelivery(f.ctx, { emailId: offerId, offerId, status: 'sent',
    to: ['x'.repeat(70) + '@example.com', 'other@example.com'], cc: [], createdAt: 100, sentAt: 200,
    links: [{ batchId: 'large', jobIds: ids }] } as any);
  assert.equal(f.posts().length, count);
  assert.deepEqual(offers.map(offer => f.posts().findIndex((p: any) => p.message.includes(`${offer}&amp;`))), locations);
  assert.ok(f.posts().every((p: any) => p.message.length < 3900));
});

test('cross-batch releases prepare independently and retrying preparation cannot duplicate summaries', async () => {
  const f = fixture(); const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await f.addBatch(`selected-${i}`, 3))[0]);
  await invoke(release, f.ctx, { jobIds: ids, offerIds: ['kissterra'], confirmed: true, releasedBy: 'admin' });
  assert.equal(f.posts().length, 0); assert.equal(f.scheduled.length, 20);
  assert.ok(f.scheduled.every(args => args.items.length === 1));
  const args = f.scheduled[0]; await invoke(prepareRelease, f.ctx, args); await invoke(prepareRelease, f.ctx, args);
  assert.equal(f.posts().length, 1); assert.match(f.posts()[0].message, /partial release; 3 evaluated/);
  assert.equal(f.tables.reviewReleaseEvents.length, 20);
});
