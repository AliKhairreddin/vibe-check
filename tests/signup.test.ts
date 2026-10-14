import assert from 'node:assert/strict';
import test from 'node:test';
import { create, admit, expireLimit } from '../convex/signup.ts';
import { prepareSignup } from '../worker/signup.ts';
import { demoFixture } from './helpers/demo-fixture.ts';

process.env.CONVEX_HTTP_SECRET = 'signup-test-secret';
const secret = 'signup-test-secret';
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
function fixture() {
  const f = demoFixture();
  // Any unexpected access (reviews, shares, jobs, etc.) is rejected by the fixture.
  delete f.tables.demoWorkspaces; delete f.tables.demoLimits;
  for (const name of ['advertiserAccounts', 'billingWorkspaces', 'advertiserPlans', 'publishers', 'offerProfiles', 'offerProfileRevisions', 'signupLimits']) f.tables[name] = [];
  return f;
}
const args = { secret, clientId: `workspace-${'1'.repeat(32)}`, email: 'New@Company.example', name: '  New company  ', passwordHash: `scrypt$${'2'.repeat(32)}$${'3'.repeat(128)}` };

test('signup creates only a clean owned workspace, never adopts customer or demo data', async () => {
  const { ctx, tables } = fixture();
  await ctx.db.insert('offerProfiles', { offerId: 'existing', officialGuidelines: 'Private existing policy' });
  const original = structuredClone(tables.offerProfiles[0]);
  const first = await invoke(create, ctx, args);
  assert.deepEqual(first, { clientId: args.clientId, username: 'new@company.example', name: 'New company', category: 'Advertising', authVersion: 1 });
  assert.deepEqual(tables.offerProfiles[0], original);
  assert.equal(tables.advertiserAccounts[0].selfServe, true);
  assert.equal(tables.advertiserAccounts[0].status, 'active');
  assert.equal(tables.offerProfiles[1].officialGuidelines, '');
  assert.equal(tables.offerProfiles[1].enabled, false);
  assert.equal(tables.offerProfiles[1].isDefault, false);
  assert.equal(tables.offerProfileRevisions.length, 1);
  assert.equal(tables.billingWorkspaces[0].status, 'none');
  assert.equal(tables.billingWorkspaces[0].accessMode, 'subscription');
  assert.equal(tables.billingWorkspaces[0].customerId, undefined);
  assert.equal(tables.publishers.length, 0);
  await invoke(create, ctx, { ...args, clientId: `workspace-${'2'.repeat(32)}`, email: 'second@company.example' });
  assert.equal(tables.advertiserAccounts.length, 2);
  assert.notEqual(tables.offerProfiles[1].offerId, tables.offerProfiles[2].offerId);
});

test('provisioning rejects unauthorized requests, duplicate email, and existing workspace IDs before writing', async () => {
  const { ctx, tables } = fixture();
  await assert.rejects(invoke(create, ctx, { ...args, secret: 'forged' }), /Unauthorized/);
  await assert.rejects(invoke(create, ctx, { ...args, clientId: 'kissterra' }), /Invalid signup/);
  await ctx.db.insert('publishers', { username: 'new@company.example' });
  await assert.rejects(invoke(create, ctx, args), /email is already in use/);
  tables.publishers.length = 0;
  await ctx.db.insert('offerProfiles', { offerId: args.clientId });
  await assert.rejects(invoke(create, ctx, args), /already exists/);
  assert.equal(tables.advertiserAccounts.length, 0);
  tables.offerProfiles.length = 0;
  await invoke(create, ctx, args);
  await assert.rejects(invoke(create, ctx, { ...args, clientId: `workspace-${'2'.repeat(32)}`, email: 'NEW@COMPANY.EXAMPLE' }), /email is already in use/);
  assert.equal(tables.advertiserAccounts.length, 1);
});

test('signup admission is bounded per IP and globally and old scheduled cleanup cannot remove a renewed window', async () => {
  const { ctx, tables, scheduled } = fixture();
  const request = { secret, ipHash: 'a'.repeat(64) };
  for (let i = 0; i < 5; i++) assert.equal(await invoke(admit, ctx, request), true);
  assert.equal(await invoke(admit, ctx, request), false);
  assert.equal(tables.signupLimits.find(r => r.key === 'global')?.count, 5);
  assert.equal(scheduled.length, 2);
  tables.signupLimits.forEach(row => row.expiresAt = Date.now() - 1);
  assert.equal(await invoke(admit, ctx, request), true);
  await invoke(expireLimit, ctx, scheduled[0].args);
  assert.equal(tables.signupLimits.length, 2);
  tables.signupLimits.find(r => r.key === 'global')!.count = 200;
  assert.equal(await invoke(admit, ctx, { secret, ipHash: 'b'.repeat(64) }), false);
  assert.equal(tables.signupLimits.length, 2);
  tables.signupLimits.forEach(row => row.expiresAt = Date.now() - 1);
  for (const entry of scheduled) await invoke(expireLimit, ctx, entry.args);
  assert.equal(tables.signupLimits.length, 0);
  await assert.rejects(invoke(admit, ctx, { secret: 'forged', ipHash: 'b'.repeat(64) }), /Unauthorized/);
});

function request(extra: RequestInit = {}, host = 'app.adchecked.com') {
  return new Request(`https://${host}/api/client/signup`, { method: 'POST', body: '{}', headers: { origin: `https://${host}`, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', 'x-signup-ip': 'forged', 'x-signup-gateway': 'forged' }, ...extra });
}
test('signup gateway overwrites forged trust headers and preserves body only for same-origin client signup', async () => {
  const prepared = await prepareSignup(request(), secret);
  assert.ok(prepared instanceof Request);
  assert.equal(prepared.headers.get('x-signup-gateway'), secret);
  assert.match(prepared.headers.get('x-signup-ip')!, /^[a-f0-9]{64}$/);
  assert.equal(await prepared.text(), '{}');
  for (const invalid of [request({}, 'admin.adchecked.com'), request({}, 'adchecked.com')]) assert.equal((await prepareSignup(invalid, secret) as Response).status, 404);
  assert.equal((await prepareSignup(request({ headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }), secret) as Response).status, 403);
  assert.equal((await prepareSignup(request({ body: 'x'.repeat(10001) }), secret) as Response).status, 413);
  assert.equal((await prepareSignup(request({ method: 'GET', body: null }), secret) as Response).status, 404);
});
