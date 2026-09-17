import assert from 'node:assert/strict';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { batches, prepare, claim, finish, recent } from '../convex/releaseEmails.ts';
import { deliverReleaseEmail, emailRoute, renderReleaseEmail } from '../worker/release-emails.ts';

const secret = 'email-test-secret';
process.env.CONVEX_HTTP_SECRET = secret;
const invoke = (fn: any, ctx: any, args: any = {}) => {
  ctx.paginationCalls = 0;
  return fn._handler(ctx, { secret, ...args });
};
function fixture() {
  const tables: Record<string, any[]> = {};
  let serial = 0;
  const scheduled: { name: string; args: any }[] = [];
  const db = {
    query(table: string) {
      const predicates: ((row: any) => boolean)[] = [];
      const index = { eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return index; } };
      const rows = () => (tables[table] ?? []).filter(row => predicates.every(predicate => predicate(row)));
      const query = {
        withIndex(_name: string, configure?: (index: any) => void) { configure?.(index); return query; },
        order() { return query; },
        async take(n: number) { return rows().slice(0, n); },
        async paginate(opts: any) {
          assert.equal(++ctx.paginationCalls, 1, 'Convex only supports a single paginated query in each function');
          return { page: rows().slice(0, opts.numItems), isDone: true, continueCursor: '' };
        },
        async unique() { const result = rows(); assert.ok(result.length < 2); return result[0] ?? null; },
      };
      return query;
    },
    async insert(table: string, value: any) { const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial }; (tables[table] ??= []).push(row); return row._id; },
    async patch(id: string, value: any) { const row = Object.values(tables).flat().find(row => row._id === id); assert.ok(row); Object.assign(row, value); },
  };
  const ctx = { db, paginationCalls: 0, scheduler: {
    async runAfter(_delay: number, fn: any, args: any) { scheduled.push({ name: getFunctionName(fn), args }); return 'scheduled'; },
  } };
  async function add(batchId: string, vertical = 'auto-insurance') {
    await db.insert('reviewBatches', { batchId, sourceLabel: `${batchId} batch`, createdAt: Date.now(), expectedCount: 1, items: [{ jobId: batchId, status: 'complete' }] });
    await db.insert('reviews', { batchId, jobId: batchId, fileName: 'creative.mp4', status: 'complete', reportReady: true, vertical });
    await db.insert('reviewOfferStats', { jobId: batchId, offerId: 'kissterra', status: 'complete', resultStatus: 'green' });
  }
  const args = {
    emailId: 'a'.repeat(32), offerId: 'kissterra', to: ['advertiser@example.com'], cc: ['team@example.com'], replyTo: 'reply@example.com',
    subject: 'Auto and Home', message: 'Please review.', signature: 'Creative Team',
    batches: ['auto', 'home'].map(batchId => ({ batchId, label: batchId, shareId: batchId, token: (batchId === 'auto' ? 'a' : 'b').repeat(43) })),
  };
  return { ctx, tables, add, args, scheduled };
}

test('combined batch emails claim and finish without reading Telegram summary pages', async () => {
  const f = fixture(); await f.add('auto'); await f.add('home', 'home-insurance'); await invoke(prepare, f.ctx, f.args);
  const args = { emailId: f.args.emailId, ownerKey: 'admin', from: 'sender@example.com', claimId: 'first' };
  assert.equal((await invoke(claim, f.ctx, args)).claimed, true);
  assert.equal(f.ctx.paginationCalls, 0);
  await invoke(finish, f.ctx, { emailId: f.args.emailId, claimId: 'first', status: 'sent', messageId: 'provider-id' });
  assert.equal(f.ctx.paginationCalls, 0);
  assert.equal(f.tables.releaseEmails[0].status, 'sent');
  assert.deepEqual(f.scheduled.map(task => task.name), Array(4).fill('telegramMilestones:refreshReleasePage'));
  assert.deepEqual(f.scheduled.map(task => task.args), ['auto', 'home', 'auto', 'home'].map(batchId => ({ batchId, cursor: null })));
  assert.equal((await invoke(claim, f.ctx, { ...args, claimId: 'second' })).claimed, false);
});

test('one preview combines Auto and Home with separate scoped revocable links; preview retries reuse them', async () => {
  const f = fixture(); await f.add('auto'); await f.add('home', 'home-insurance');
  await f.ctx.db.insert('reviews', { batchId: 'auto', jobId: 'auto-2', fileName: 'second.mp4', status: 'complete', reportReady: true, vertical: 'auto-insurance' });
  await f.ctx.db.insert('reviewOfferStats', { jobId: 'auto-2', offerId: 'kissterra', status: 'complete', resultStatus: 'yellow' });
  await f.ctx.db.insert('reviewOfferStats', { jobId: 'auto', offerId: 'acp', status: 'complete', resultStatus: 'red' });
  const options = await invoke(batches, f.ctx, { offerId: 'kissterra', cursor: null });
  assert.deepEqual(options.batches.map((batch: any) => batch.label), ['Auto', 'Home']);
  const draft = await invoke(prepare, f.ctx, f.args);
  assert.equal(draft.status, 'draft'); assert.equal(draft.links.length, 2);
  assert.deepEqual(draft.links[0].jobIds, ['auto', 'auto-2']);
  assert.notEqual(draft.links[0].url, draft.links[1].url);
  assert.ok(f.tables.publicShares.every(row => row.items.every((item: any) => item.offerId === 'kissterra')));
  assert.ok(f.tables.publicShares.every(row => row.tokenHash.length === 64 && !('token' in row)));
  assert.deepEqual(await invoke(prepare, f.ctx, f.args), draft);
  assert.equal(f.tables.publicShares.length, 2);
});

test('selected older batches are included together on the first page without bypassing release checks', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) await f.add(`recent-${i}`);
  await f.add('auto'); await f.add('home', 'home-insurance'); await f.add('private');
  f.tables.reviewOfferStats.find(row => row.jobId === 'private').withheld = true;
  const page = await invoke(batches, f.ctx, { offerId: 'kissterra', cursor: null, initialBatchIds: ['auto', 'home', 'private', 'auto'] });
  assert.deepEqual(page.batches.slice(0, 2).map((batch: any) => batch.batchId), ['auto', 'home']);
  assert.equal(page.batches.length, 12);
  assert.ok(!page.batches.some((batch: any) => batch.batchId === 'private'));
  await assert.rejects(invoke(batches, f.ctx, { offerId: 'kissterra', cursor: null, initialBatchIds: Array.from({ length: 11 }, (_, i) => `batch-${i}`) }), /between 1 and 10/);
});

test('private, processing, partially released and foreign publisher batches cannot enter an email', async () => {
  for (const kind of ['private', 'processing', 'partial', 'foreign']) {
    const f = fixture(); await f.add('auto'); await f.add('home');
    let scope = {};
    if (kind === 'private') f.tables.reviewOfferStats[0].withheld = true;
    if (kind === 'processing') f.tables.reviewBatches[0].items[0].status = 'processing';
    if (kind === 'partial') {
      await f.ctx.db.insert('reviews', { batchId: 'auto', jobId: 'extra', status: 'complete', reportReady: true });
      await f.ctx.db.insert('reviewOfferStats', { jobId: 'extra', offerId: 'kissterra', status: 'complete', resultStatus: 'red', withheld: true });
    }
    if (kind === 'foreign') scope = { clientId: 'kissterra', publisherId: 'outsider' };
    const available = await invoke(batches, f.ctx, { offerId: 'kissterra', cursor: null, ...scope });
    assert.ok(!available.batches.some((batch: any) => batch.batchId === 'auto'));
    await assert.rejects(invoke(prepare, f.ctx, { ...f.args, ...scope }), /Release every/);
  }
});

test('publisher ownership and advertiser scope are rechecked and unauthenticated access fails closed', async () => {
  const f = fixture(); await f.add('auto'); await f.add('home');
  for (const jobId of ['auto', 'home']) await f.ctx.db.insert('publisherSubmissions', { jobId, clientId: 'kissterra', publisherId: 'owner' });
  const scope = { clientId: 'kissterra', publisherId: 'owner' };
  const draft = await invoke(prepare, f.ctx, { ...f.args, ...scope });
  assert.equal(draft.ownerKey, 'publisher:owner');
  await assert.rejects(invoke(prepare, f.ctx, { ...f.args, ...scope, offerId: 'acp' }), /Unauthorized/);
  await assert.rejects(invoke(recent, f.ctx, { offerId: 'kissterra', secret: 'wrong' }), /Unauthorized/);
  assert.deepEqual(await invoke(recent, f.ctx, { offerId: 'kissterra', clientId: 'kissterra', publisherId: 'outsider' }), []);
  await assert.rejects(invoke(claim, f.ctx, { emailId: draft.emailId, ownerKey: 'admin', from: 'sender@example.com', claimId: 'first' }), /unavailable/);
  f.tables.publisherSubmissions[0].publisherId = 'new-owner';
  await assert.rejects(invoke(claim, f.ctx, { emailId: draft.emailId, ownerKey: 'publisher:owner', from: 'sender@example.com', claimId: 'first' }), /unavailable/);
});

test('claims are one-way, revocation/expiry blocks delivery, and claims never leak through history', async () => {
  const f = fixture(); await f.add('auto'); await f.add('home'); await invoke(prepare, f.ctx, f.args);
  const args = { emailId: f.args.emailId, ownerKey: 'admin', from: 'sender@example.com', claimId: 'first' };
  f.tables.publicShares[0].revokedAt = Date.now();
  await assert.rejects(invoke(claim, f.ctx, args), /no longer available/);
  delete f.tables.publicShares[0].revokedAt;
  f.tables.releaseEmails[0].createdAt -= 2 * 86400000;
  await assert.rejects(invoke(claim, f.ctx, args), /expired/);
  f.tables.releaseEmails[0].createdAt = Date.now();
  assert.equal((await invoke(claim, f.ctx, args)).claimed, true);
  assert.equal((await invoke(claim, f.ctx, { ...args, claimId: 'second' })).claimed, false);
  await assert.rejects(invoke(finish, f.ctx, { emailId: f.args.emailId, claimId: 'wrong', status: 'sent' }), /unavailable/);
  await invoke(finish, f.ctx, { emailId: f.args.emailId, claimId: 'first', status: 'uncertain' });
  assert.equal((await invoke(claim, f.ctx, args)).claimed, false);
  assert.equal((await invoke(recent, f.ctx, { offerId: 'kissterra' }))[0].claimId, undefined);
});

test('headers and recipient limits are validated; HTML is escaped while both batch links remain usable', async () => {
  const f = fixture(); await f.add('auto'); await f.add('home');
  for (const patch of [{ subject: 'Hello\r\nBcc: bad@example.com' }, { to: ['broken'] }, { to: Array(50).fill('a@example.com') }]) {
    await assert.rejects(invoke(prepare, f.ctx, { ...f.args, ...patch }));
  }
  const output = renderReleaseEmail({ message: '<script>bad</script>', signature: 'Team & partners', links: [{ label: '<Auto>', url: 'https://app.adchecked.com/share/auto' }, { label: 'Home', url: 'https://app.adchecked.com/share/home' }] });
  assert.ok(output.html.includes('&lt;script&gt;')); assert.ok(!output.html.includes('<script>'));
  assert.ok(output.text.includes('Home Link: https://app.adchecked.com/share/home'));
  assert.equal(emailRoute(`/api/release-emails/${'a'.repeat(32)}/send`), 'send');
  assert.equal(emailRoute('/api/v1/release-emails/options'), null);
});

test('Worker sends once, retries only audit writes, and does not resend after an ambiguous provider failure', async () => {
  for (const fails of [false, true]) {
    const f = fixture(); await f.add('auto'); await f.add('home'); await invoke(prepare, f.ctx, f.args);
    let sends = 0; let writes = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const payload = JSON.parse(init!.body as string);
      const fn = payload.path.endsWith(':claim') ? claim : finish;
      if (fn === finish && writes++ === 0) throw new Error('Transient audit failure');
      return Response.json({ status: 'success', value: await invoke(fn, f.ctx, payload.args) });
    };
    try {
      const env = { CONVEX_URL: 'https://example.convex.cloud', CONVEX_HTTP_SECRET: secret, RELEASE_EMAIL_FROM: 'sender@example.com', RELEASE_EMAIL: { send: async (email: any) => { sends++; assert.deepEqual(email.to, f.args.to); assert.deepEqual(email.cc, f.args.cc); assert.equal(email.replyTo, f.args.replyTo); if (fails) throw new Error('Provider timeout'); return { messageId: 'provider-id' }; } } } as any;
      const auth = { email_id: f.args.emailId, owner_key: 'admin' };
      const first = await deliverReleaseEmail(env, auth);
      assert.equal((await first.json()).status, fails ? 'uncertain' : 'sent');
      await deliverReleaseEmail(env, auth);
      assert.equal(sends, 1);
      if (!fails) { assert.equal(writes, 2); assert.equal(f.tables.releaseEmails[0].messageId, 'provider-id'); }
    } finally { globalThis.fetch = originalFetch; }
  }
});

test('storage failures are service errors with safe diagnostics and never call the email provider', async () => {
  const originalFetch = globalThis.fetch; const originalError = console.error;
  let sends = 0; const logs: string[] = [];
  const env = { CONVEX_URL: 'https://example.convex.cloud', CONVEX_HTTP_SECRET: secret, RELEASE_EMAIL_FROM: 'sender@example.com',
    RELEASE_EMAIL: { send: async () => { sends++; return { messageId: 'unexpected' }; } } } as any;
  const auth = { email_id: 'a'.repeat(32), owner_key: 'admin' };
  console.error = message => { logs.push(String(message)); };
  try {
    for (const status of [200, 560]) {
      globalThis.fetch = async () => Response.json({ status: 'error', errorMessage: `[Request ID: abc123] Internal failure ${secret} private@example.com` }, { status });
      const response = await deliverReleaseEmail(env, auth);
      assert.equal(response.status, 503);
      assert.match((await response.json()).detail, /Could not confirm email send status/);
      assert.deepEqual(JSON.parse(logs.at(-1)!), { event: 'release_email_storage_error', operation: 'claim', emailId: auth.email_id, reason: 'function', httpStatus: status, requestId: 'abc123' });
    }
    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    assert.equal((await deliverReleaseEmail(env, auth)).status, 503);
    globalThis.fetch = async () => { throw new Error(`Network error ${secret}`); };
    assert.equal((await deliverReleaseEmail(env, auth)).status, 503);
    globalThis.fetch = async () => Response.json({ status: 'error', errorMessage: 'Preview expired. Create a fresh email preview' }, { status: 560 });
    const validation = await deliverReleaseEmail(env, auth);
    assert.equal(validation.status, 409);
    assert.equal((await validation.json()).detail, 'Preview expired. Create a fresh email preview');
    assert.equal(sends, 0);
    assert.ok(logs.every(line => !line.includes(secret) && !line.includes('private@example.com')));
  } finally { globalThis.fetch = originalFetch; console.error = originalError; }
});

test('a lost claim response leaves a durable claim and a status retry cannot send again', async () => {
  const f = fixture(); await f.add('auto'); await f.add('home'); await invoke(prepare, f.ctx, f.args);
  const originalFetch = globalThis.fetch;
  let requests = 0; let sends = 0;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init!.body as string);
    const value = await invoke(claim, f.ctx, payload.args);
    if (requests++ === 0) throw new Error('Response lost after commit');
    return Response.json({ status: 'success', value });
  };
  try {
    const env = { CONVEX_URL: 'https://example.convex.cloud', CONVEX_HTTP_SECRET: secret, RELEASE_EMAIL_FROM: 'sender@example.com',
      RELEASE_EMAIL: { send: async () => { sends++; return { messageId: 'unexpected' }; } } } as any;
    const auth = { email_id: f.args.emailId, owner_key: 'admin' };
    assert.equal((await deliverReleaseEmail(env, auth)).status, 503);
    assert.equal((await (await deliverReleaseEmail(env, auth)).json()).status, 'sending');
    assert.equal(f.tables.releaseEmails[0].status, 'sending');
    assert.equal(sends, 0);
  } finally { globalThis.fetch = originalFetch; }
});
