import assert from 'node:assert/strict';
import test from 'node:test';
import { create, request, expire, cleanup } from '../convex/demo.ts';
import { demoFixture } from './helpers/demo-fixture.ts';
import { handleDemoApi } from '../worker/demo.ts';
import { DEMO_TTL_MS } from '../shared/demo.ts';

process.env.CONVEX_HTTP_SECRET = 'demo-test-secret';
const secret = 'demo-test-secret';
const a = 'a'.repeat(64), b = 'b'.repeat(64);
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, { secret, ...args });
const start = (ctx: any, tokenHash = a, role = 'owner', ipHash = a) => invoke(create, ctx, { tokenHash, ipHash, role, nonce: tokenHash.slice(0, 12) });
const call = (ctx: any, path: string, method = 'GET', body: any = {}, tokenHash = a) => invoke(request, ctx, { path, method, body, tokenHash, nonce: crypto.randomUUID() });

test('demo sessions seed fresh disconnected datasets and schedule exact 24h cleanup', async () => {
  const f = demoFixture();
  const first = await start(f.ctx); const second = await start(f.ctx, b);
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.equal(first.body.expiresAt - first.body.createdAt, DEMO_TTL_MS);
  assert.equal(f.scheduled[0].time, first.body.expiresAt);
  const rowsA = (await call(f.ctx, '/api/reviews')).body;
  const rowsB = (await call(f.ctx, '/api/reviews', 'GET', {}, b)).body;
  assert.equal(rowsA.length, 12); assert.equal(rowsB.length, 12);
  assert.notEqual(rowsA[0].job_id, rowsB[0].job_id);
  assert.equal((await call(f.ctx, `/api/reviews/${rowsB[0].job_id}`)).status, 404);
  assert.equal((await call(f.ctx, '/api/reviews/production-job')).status, 404);
  const changed = await call(f.ctx, '/api/offers/harbor-auto', 'PUT', { display_name: 'Edited fictional offer', official_guidelines: 'Sample policy', enabled: true });
  assert.equal(changed.status, 200);
  assert.equal((await call(f.ctx, '/api/offers')).body.offers[0].display_name, 'Edited fictional offer');
  assert.equal((await call(f.ctx, '/api/offers', 'GET', {}, b)).body.offers[0].display_name, 'Harbor Auto (fictional)');
});

test('publisher submit, release, advertiser decision and reset reuse one private session', async () => {
  const f = demoFixture(); await start(f.ctx, a, 'publisher');
  const created = await call(f.ctx, '/api/client/harbor-auto/reviews', 'POST', { ad_copy: 'Save 40% today.' });
  assert.equal(created.status, 200);
  const id = created.body.job_id;
  assert.equal((await call(f.ctx, `/api/client/harbor-auto/reviews/${id}/decision`, 'PUT', { decision: 'approved' })).status, 403);
  await call(f.ctx, '/role', 'PUT', { role: 'advertiser' });
  assert.equal((await call(f.ctx, `/api/client/harbor-auto/reviews/${id}`)).status, 404);
  await call(f.ctx, '/role', 'PUT', { role: 'publisher' });
  const selection = await call(f.ctx, '/api/client/harbor-auto/reviews/release-selection', 'POST', { job_ids: [id] });
  assert.equal(selection.body.offers[0].pending, 1);
  assert.equal((await call(f.ctx, '/api/client/harbor-auto/reviews/release', 'POST', { job_ids: [id], offer_ids: ['harbor-auto'], confirmed: true })).status, 200);
  await call(f.ctx, '/role', 'PUT', { role: 'advertiser' });
  const decision = await call(f.ctx, `/api/client/harbor-auto/reviews/${id}/decision`, 'PUT', { decision: 'approved', feedback_note: 'Verified qualifier.' });
  assert.equal(decision.body.decision, 'approved');
  const detail = await call(f.ctx, `/api/client/harbor-auto/reviews/${id}`);
  assert.equal(detail.body.review.effective_status, 'green');
  assert.equal(detail.body.report.overall_status, 'yellow'); // Immutable AI result.
  await call(f.ctx, `/api/client/harbor-auto/reviews/${id}/decision`, 'PUT', { decision: 'pending' });
  assert.equal((await call(f.ctx, `/api/client/harbor-auto/reviews/${id}`)).body.review.effective_status, 'yellow');
});

test('backend denies role escalation via production IDs, paths and external endpoints', async () => {
  const f = demoFixture(); await start(f.ctx, a, 'publisher');
  for (const path of ['/api/reviews', '/api/admin/session', '/api/client/kissterra/reviews', '/api/client/harbor-auto/publishers']) assert.equal((await call(f.ctx, path)).status, 403);
  const other = f.tables.demoWorkspaces[0].state.reviews.find((r: any) => r.client.publisher_id === 'demo-orbit');
  assert.equal((await call(f.ctx, `/api/client/harbor-auto/reviews/${other.history.job_id}`)).status, 404);
  await call(f.ctx, '/role', 'PUT', { role: 'employee' });
  assert.equal((await call(f.ctx, '/api/offers')).status, 403);
  assert.equal((await call(f.ctx, '/api/offers/harbor-auto', 'PUT', { enabled: false })).status, 403);
  await call(f.ctx, '/role', 'PUT', { role: 'owner' });
  for (const path of ['/api/v1/reviews', '/api/admin/api/partners/x/keys', '/api/checkout', '/api/internal/partner-jobs']) assert.equal((await call(f.ctx, path, 'POST', {})).status, 403);
  await assert.rejects(() => (request as any)._handler(f.ctx, { secret: 'forged', tokenHash: a, path: '/session', method: 'GET', body: {}, nonce: 'x' }), /Unauthorized/);
});

test('creation limits are durable, per-IP and global; session writes are bounded', async () => {
  const f = demoFixture();
  for (let i = 0; i < 5; i++) assert.equal((await start(f.ctx, i.toString().repeat(64))).status, 201);
  assert.equal((await start(f.ctx, b)).status, 429);
  const g = demoFixture(); await start(g.ctx);
  for (let i = 0; i < 30; i++) assert.equal((await call(g.ctx, '/role', 'PUT', { role: 'publisher' })).status, 200);
  assert.equal((await call(g.ctx, '/role', 'PUT', { role: 'owner' })).status, 429);
  const h = demoFixture(); h.tables.demoLimits.push({ _id: 'limit', key: 'create:global', count: 300, expiresAt: Date.now() + 3600000 });
  assert.equal((await start(h.ctx)).status, 429);
});

test('expired sessions fail closed and delete all associated records; cleanup is idempotent', async () => {
  const f = demoFixture(); await start(f.ctx);
  f.tables.demoWorkspaces[0].expiresAt = Date.now() - 1;
  assert.equal((await call(f.ctx, '/api/reviews')).status, 401);
  assert.equal(f.tables.demoWorkspaces.length, 0);
  await start(f.ctx, b);
  const row = f.tables.demoWorkspaces[0]; row.expiresAt = Date.now() - 1;
  await (expire as any)._handler(f.ctx, { id: row._id }); await (expire as any)._handler(f.ctx, { id: row._id });
  assert.equal(f.tables.demoWorkspaces.length, 0);
  f.tables.demoLimits.forEach(r => r.expiresAt = Date.now() - 1);
  await (cleanup as any)._handler(f.ctx, {});
  assert.equal(f.tables.demoLimits.length, 0);
});

test('edge demo boundary uses HttpOnly capabilities, blocks CSRF and never falls back on errors', async () => {
  const f = demoFixture();
  const original = globalThis.fetch;
  let storageCalls = 0;
  globalThis.fetch = async (url: any, init: any) => {
    assert.equal(url, 'https://demo-convex.invalid/api/mutation'); storageCalls++;
    const data = JSON.parse(init.body);
    const fn = data.path === 'demo:create' ? create : request;
    return Response.json({ status: 'success', value: await (fn as any)._handler(f.ctx, data.args) });
  };
  const env = { CONVEX_URL: 'https://demo-convex.invalid', CONVEX_HTTP_SECRET: secret, DEMO_RATE_LIMITER: { limit: async () => ({ success: true }) } } as any;
  const edge = (path: string, method = 'GET', body?: any, cookie = '', origin = 'https://app.adchecked.com') => handleDemoApi(new Request(`https://app.adchecked.com${path}`, { method, headers: { origin, cookie, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  try {
    assert.equal(await edge('/api/reviews'), null);
    assert.equal((await edge('/api/demo/session', 'POST', { role: 'owner' }, '', 'https://evil.example'))?.status, 403);
    assert.equal(storageCalls, 0);
    const created = (await edge('/api/demo/session', 'POST', { role: 'owner' }))!;
    assert.equal(created.status, 201);
    const cookie = created.headers.get('set-cookie')!;
    assert.match(cookie, /__Host-adchecked_demo=[a-f0-9]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400/);
    assert.equal((await edge('/api/demo/proxy/api/reviews', 'GET', undefined, cookie))?.status, 200);
    assert.equal((await edge('/api/demo/proxy/api/release-emails/x/send', 'POST', {}, cookie))?.status, 404);
    const logout = await handleDemoApi(new Request('https://app.adchecked.com/api/demo/session', {
      method: 'DELETE', headers: { origin: 'https://app.adchecked.com', cookie }, body: new Uint8Array(),
    }), env);
    assert.equal(logout?.status, 200); // Cloudflare exposes a stream even for an empty body.
    assert.match(logout!.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal(f.tables.demoWorkspaces.length, 0);
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal((await edge('/api/demo/proxy/api/reviews', 'GET', undefined, cookie))?.status, 503);
    assert.equal((await edge('/api/demo/proxy/api/reviews', 'GET', undefined, ''))?.status, 401);
  } finally { globalThis.fetch = original; }
});

test('email and automation simulations persist without dispatching an external action', async () => {
  const f = demoFixture(); await start(f.ctx, a, 'publisher');
  const batches = (await call(f.ctx, '/api/client/harbor-auto/release-emails/batches')).body.batches;
  const draft = await call(f.ctx, '/api/client/harbor-auto/release-emails/preview', 'POST', { email_id: 'demo-email', offer_id: 'harbor-auto', to: ['reviewer@demo.example'], subject: 'Fictional review', batches: [{ batch_id: batches[0].batchId, label: 'Sample batch' }] });
  assert.equal(draft.body.status, 'draft');
  const sent = await call(f.ctx, '/api/client/harbor-auto/release-emails/demo-email/send', 'POST', { confirmed: true });
  assert.deepEqual(sent.body, { status: 'sent', simulated: true });
  assert.equal((await call(f.ctx, '/api/client/harbor-auto/release-emails/recent')).body[0].status, 'sent');
  await call(f.ctx, '/role', 'PUT', { role: 'owner' });
  const run = await call(f.ctx, '/api/automations/demo-daily/run', 'POST');
  assert.equal(run.body.simulated, true);
  assert.equal(run.body.queued_count, 0);
  assert.equal(f.scheduled.length, 1); // Only the expiry job; never email, AI, or Drive work.
});
