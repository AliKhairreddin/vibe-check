import assert from 'node:assert/strict';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { checkConnection, claim, deliver, finish, recover, retry } from '../convex/lemonmaxx.ts';
import { decide, clearDecision } from '../convex/clientReviews.ts';
import { LEASE_MS, MAX_ATTEMPTS, retryAfterMs } from '../convex/lemonmaxxTypes.ts';

const invoke = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, args);
process.env.CONVEX_HTTP_SECRET = 'test-secret';
process.env.LEMONMAXX_PARTNER_ID = 'lemon';
process.env.LEMONMAXX_API_TOKEN = 'test-only-token';

function fixture() {
  const tables: Record<string, any[]> = {};
  const scheduled: any[] = [];
  let serial = 0;
  const db = {
    query(table: string) {
      const predicates: ((row: any) => boolean)[] = [];
      const index: any = {
        eq(key: string, value: any) { predicates.push(row => row[key] === value); return index; },
        lte(key: string, value: any) { predicates.push(row => row[key] <= value); return index; },
      };
      const rows = () => (tables[table] ?? []).filter(row => predicates.every(p => p(row)));
      const query: any = {
        withIndex(_name: string, fn: any) { fn(index); return query; },
        async unique() { assert.ok(rows().length <= 1); return rows()[0] ? structuredClone(rows()[0]) : null; },
        async take(n: number) { return structuredClone(rows().slice(0, n)); },
      };
      return query;
    },
    async insert(table: string, value: any) {
      const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial };
      (tables[table] ??= []).push(row); return row._id;
    },
    async get(id: string) { return structuredClone(Object.values(tables).flat().find(row => row._id === id) ?? null); },
    async patch(id: string, value: any) { Object.assign(Object.values(tables).flat().find(row => row._id === id), value); },
    async replace(id: string, value: any) {
      const row = Object.values(tables).flat().find(row => row._id === id); const time = row._creationTime;
      for (const key of Object.keys(row)) delete row[key]; Object.assign(row, value, { _id: id, _creationTime: time });
    },
    async delete(id: string) { for (const rows of Object.values(tables)) { const i = rows.findIndex(row => row._id === id); if (i >= 0) rows.splice(i, 1); } },
  };
  const ctx: any = { db, scheduler: { runAfter: async (delay: number, ref: any, args: any) => {
    scheduled.push({ delay, name: getFunctionName(ref), args }); return 'scheduled';
  } } };
  const functions: any = { 'lemonmaxx:claim': claim, 'lemonmaxx:finish': finish };
  ctx.runMutation = (ref: any, args: any) => invoke(functions[getFunctionName(ref)], ctx, args);
  const addReview = async (jobId = 'job', offerId = 'acp', assetId = 'asset', partnerId = 'lemon') => {
    if (!(tables.apiPartners ?? []).some(p => p.partnerId === partnerId)) await db.insert('apiPartners', { partnerId, status: 'active' });
    await db.insert('apiReviewLinks', { jobId, partnerId, externalId: assetId, requestedOfferId: offerId, status: 'complete' });
    await db.insert('reviewOfferStats', { jobId, offerId, status: 'complete', resultStatus: 'green' });
    await db.insert('reviews', { jobId, primaryOfferId: offerId, historySourceKind: 'api', historySource: `api:${partnerId}` });
  };
  const decision = (value = 'approved', jobId = 'job', offerId = 'acp', extra = {}) => invoke(decide, ctx, {
    secret: 'test-secret', jobId, offerId, clientId: offerId, decision: value, feedbackReason: 'business_decision', ...extra,
  });
  const clear = () => invoke(clearDecision, ctx, { secret: 'test-secret', jobId: 'job', offerId: 'acp', clientId: 'acp' });
  const row = () => tables.lemonmaxxStatusSync?.[0];
  return { ctx, tables, scheduled, db, addReview, decision, clear, row };
}

test('advertiser approval, disapproval and reset queue only the three supported statuses', async () => {
  const f = fixture(); await f.addReview();
  await f.decision(); assert.equal(f.row().desiredStatus, 'approved');
  await f.decision('disapproved'); assert.equal(f.row().desiredStatus, 'rejected');
  await f.clear(); assert.equal(f.row().desiredStatus, 'not_selected');
  assert.equal(f.row().revision, 3); assert.equal(f.tables.lemonmaxxStatusSync.length, 1);
  await f.clear(); assert.equal(f.row().revision, 3);
  assert.equal(f.scheduled.length, 3);
});

test('duplicate decisions and feedback-only edits do not replace another offer decision', async () => {
  const f = fixture(); await f.addReview(); await f.addReview('other', 'kissterra');
  await f.decision(); await f.decision(); assert.equal(f.row().revision, 1);
  await f.decision('disapproved', 'other', 'kissterra');
  await f.decision('approved', 'job', 'acp', { feedbackNote: 'New note' });
  assert.equal(f.row().revision, 2); assert.equal(f.row().desiredStatus, 'rejected');
  assert.equal(f.row().offerId, 'kissterra');
});

test('only the configured active partner and the submitted offer can sync', async () => {
  for (const reason of ['other-partner', 'internal', 'missing-asset', 'wrong-offer', 'suspended', 'deleted', 'dot-segment']) {
    const f = fixture(); await f.addReview();
    if (reason === 'other-partner') f.tables.apiReviewLinks[0].partnerId = 'other';
    if (reason === 'internal') f.tables.apiReviewLinks = [];
    if (reason === 'missing-asset') delete f.tables.apiReviewLinks[0].externalId;
    if (reason === 'wrong-offer') f.tables.apiReviewLinks[0].requestedOfferId = 'kissterra';
    if (reason === 'suspended') f.tables.apiPartners[0].status = 'suspended';
    if (reason === 'deleted') f.tables.apiReviewLinks[0].status = 'deleted';
    if (reason === 'dot-segment') f.tables.apiReviewLinks[0].externalId = '..';
    await f.decision(); assert.equal(f.row(), undefined, reason);
  }
});

test('legacy submissions sync only for their primary offer; disabled integration queues nothing', async () => {
  const f = fixture(); await f.addReview(); delete f.tables.apiReviewLinks[0].requestedOfferId;
  await f.decision(); assert.equal(f.row().desiredStatus, 'approved');
  delete process.env.LEMONMAXX_PARTNER_ID;
  try { await f.clear(); assert.equal(f.row().revision, 1); }
  finally { process.env.LEMONMAXX_PARTNER_ID = 'lemon'; }
});

test('in-flight requests hold the asset lease and completion sends only the latest decision', async () => {
  const f = fixture(); await f.addReview(); await f.addReview('other', 'kissterra'); await f.decision();
  const id = f.row()._id;
  const old = await invoke(claim, f.ctx, { id });
  assert.equal(await invoke(claim, f.ctx, { id }), null);
  await f.decision('disapproved', 'other', 'kissterra'); await f.clear();
  assert.equal(f.row().state, 'claimed'); assert.equal(f.scheduled.length, 1);
  assert.equal(await invoke(claim, f.ctx, { id }), null);
  await invoke(finish, f.ctx, { id, claimId: old.claimId, success: false, retryable: true });
  assert.equal(f.row().state, 'pending'); assert.equal(f.row().attempts, 0);
  assert.equal(f.scheduled.at(-1).delay, 0);
  const current = await invoke(claim, f.ctx, { id }); assert.equal(current.status, 'not_selected');
  assert.equal(await invoke(finish, f.ctx, { id, claimId: old.claimId, success: true, retryable: false }), false);
  await invoke(finish, f.ctx, { id, claimId: current.claimId, success: true, retryable: false });
  assert.equal(f.row().state, 'delivered');
});

test('crashed action recovery respects leases and discards an exhausted old revision', async () => {
  const f = fixture(); await f.addReview(); await f.decision(); const id = f.row()._id;
  const time = Date.now(); await invoke(claim, f.ctx, { id });
  assert.ok(f.row().nextAttemptAt >= time + LEASE_MS);
  assert.equal(await invoke(recover, f.ctx), 0);
  await f.clear(); f.row().attempts = MAX_ATTEMPTS; f.row().nextAttemptAt = 0;
  assert.equal(await invoke(recover, f.ctx), 1);
  const next = await invoke(claim, f.ctx, { id }); assert.equal(next.status, 'not_selected');
  assert.equal(f.row().attempts, 1);
});

test('deleted, withheld or reassigned assets are cancelled before sending', async () => {
  for (const reason of ['deleted', 'withheld', 'reassigned']) {
    const f = fixture(); await f.addReview(); await f.decision();
    if (reason === 'deleted') f.tables.reviewOfferStats[0].deletedAt = Date.now();
    if (reason === 'withheld') f.tables.reviewOfferStats[0].withheld = true;
    if (reason === 'reassigned') f.tables.apiReviewLinks[0].externalId = 'changed';
    assert.equal(await invoke(claim, f.ctx, { id: f.row()._id }), null);
    assert.equal(f.row().state, 'cancelled');
  }
});

test('delivery sends the exact PATCH contract with the external asset ID and no redirects', async t => {
  const f = fixture(); await f.addReview('job', 'acp', 'external/id ?'); await f.decision();
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { requests.push({ url, init }); return new Response(null, { status: 204 }); });
  await invoke(deliver, f.ctx, { id: f.row()._id });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.lemonmaxx.com/api/v1/creative-bank/creative-group/assets/external%2Fid%20%3F/status');
  assert.equal(requests[0].init.method, 'PATCH'); assert.equal(requests[0].init.redirect, 'manual');
  assert.deepEqual(JSON.parse(requests[0].init.body), { status: 'approved' });
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-only-token');
  assert.match(requests[0].init.headers['User-Agent'], /^AdChecked/);
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.equal(f.row().state, 'delivered');
  await invoke(deliver, f.ctx, { id: f.row()._id }); assert.equal(requests.length, 1);
});

test('transient responses retry with backoff and Retry-After; permanent responses require operator recovery', async t => {
  t.mock.method(console, 'error', () => {});
  let status = 429;
  t.mock.method(globalThis, 'fetch', async () => new Response('sensitive remote error', { status, headers: { 'retry-after': '90' } }));
  for (status of [429, 503, 408, 401, 403, 404, 422, 302]) {
    const f = fixture(); await f.addReview(); await f.decision();
    await invoke(deliver, f.ctx, { id: f.row()._id });
    const transient = [429, 503, 408].includes(status);
    assert.equal(f.row().state, transient ? 'pending' : 'failed', String(status));
    assert.equal(f.row().lastError, `Lemonmaxx returned HTTP ${status}`);
    if (transient) {
      assert.equal(f.scheduled.at(-1).delay, 90_000);
      assert.equal(await invoke(claim, f.ctx, { id: f.row()._id }), null);
    } else {
      assert.equal(await invoke(retry, f.ctx, { id: f.row()._id }), true);
      assert.equal(f.row().attempts, 0);
    }
  }
});

test('network errors redact details and stop after the retry limit', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret token and remote error'); });
  const f = fixture(); await f.addReview(); await f.decision(); const id = f.row()._id;
  await invoke(deliver, f.ctx, { id }); assert.equal(f.row().state, 'pending');
  assert.equal(f.row().lastError, 'Lemonmaxx request timed out or failed to connect');
  f.row().attempts = MAX_ATTEMPTS - 1; f.row().nextAttemptAt = 0;
  await invoke(deliver, f.ctx, { id }); assert.equal(f.row().state, 'failed');
});

test('missing credentials are recorded without an HTTP call or losing the decision', async t => {
  t.mock.method(console, 'error', () => {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not send'); });
  const f = fixture(); await f.addReview(); await f.decision();
  delete process.env.LEMONMAXX_API_TOKEN;
  try {
    await invoke(deliver, f.ctx, { id: f.row()._id });
    assert.equal(f.row().state, 'failed'); assert.equal(fetch.mock.callCount(), 0);
    assert.equal(f.tables.clientReviewDecisions[0].decision, 'approved');
  } finally { process.env.LEMONMAXX_API_TOKEN = 'test-only-token'; }
});

test('Retry-After supports seconds and HTTP dates and bounds unreasonable values', () => {
  assert.equal(retryAfterMs('120', 0), 120_000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120_000);
  assert.equal(retryAfterMs('invalid', 0), undefined);
  assert.equal(retryAfterMs('99999999', 0), 86_400_000);
});

test('connection checks use GET and distinguish authenticated routes from authentication failures', async t => {
  let status = 405;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined);
    return new Response(null, { status, headers: { allow: 'PATCH' } });
  });
  assert.deepEqual(await invoke(checkConnection, {}), { configured: true, authenticated: true, httpStatus: 405 });
  status = 401;
  assert.deepEqual(await invoke(checkConnection, {}), { configured: true, authenticated: false, httpStatus: 401 });
});
