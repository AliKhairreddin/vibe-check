import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueue, claim, finish, isApiReview } from '../convex/telegramNotifications.ts';

// Run the registered Convex handlers against a small indexed database fixture.
const handler = (fn: unknown) => (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<any> })._handler;
function database() {
  const tables: Record<string, any[]> = { telegramNotifications: [], apiReviewLinks: [] };
  const db = {
    query(table: string) {
      const predicates: Array<(row: any) => boolean> = [];
      const index = {
        eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return index; },
        lte(key: string, value: number) { predicates.push(row => row[key] <= value); return index; },
      };
      return { withIndex(_name: string, configure: (index: any) => unknown) {
        configure(index);
        const matches = () => tables[table].filter(row => predicates.every(predicate => predicate(row)));
        return { unique: async () => matches()[0] ?? null, take: async (count: number) => matches().slice(0, count) };
      } };
    },
    async insert(table: string, value: any) {
      const row = { ...value, _id: `${table}:${tables[table].length}` };
      tables[table].push(row);
      return row._id;
    },
    async patch(id: string, patch: any) {
      const row = Object.values(tables).flat().find(value => value._id === id);
      Object.assign(row, patch);
    },
  };
  return { ctx: { db }, rows: tables.telegramNotifications, tables };
}
const secret = 'test-secret';
process.env.CONVEX_HTTP_SECRET = secret;
const enqueueArgs = { secret, eventKey: 'review:one:complete', message: 'Review done' };

test('outbox deduplicates events and allows only one active claim', async () => {
  const { ctx, rows } = database();
  assert.equal(await handler(enqueue)(ctx, enqueueArgs), 'pending');
  assert.equal(await handler(enqueue)(ctx, enqueueArgs), 'pending');
  assert.equal(rows.length, 1);
  const first = await handler(claim)(ctx, { secret });
  assert.ok(first.claimId);
  assert.equal(await handler(claim)(ctx, { secret }), null);
  assert.equal(await handler(finish)(ctx, { secret, ...first, success: true }), true);
  assert.equal(await handler(enqueue)(ctx, enqueueArgs), 'sent');
  assert.equal(await handler(claim)(ctx, { secret }), null);
});

test('expired claims recover and stale completions cannot acknowledge a new owner', async () => {
  const { ctx, rows } = database();
  await handler(enqueue)(ctx, enqueueArgs);
  const first = await handler(claim)(ctx, { secret });
  rows[0].nextAttemptAt = 0;
  const second = await handler(claim)(ctx, { secret });
  assert.notEqual(first.claimId, second.claimId);
  assert.equal(await handler(finish)(ctx, { secret, ...first, success: true }), false);
  assert.equal(rows[0].status, 'claimed');
  assert.equal(await handler(finish)(ctx, { secret, ...second, success: true }), true);
});

test('delivery failures back off then exhaust after eight claims', async () => {
  const { ctx, rows } = database();
  await handler(enqueue)(ctx, enqueueArgs);
  for (let attempt = 1; attempt <= 8; attempt++) {
    rows[0].nextAttemptAt = 0;
    const delivery = await handler(claim)(ctx, { secret });
    assert.ok(delivery);
    await handler(finish)(ctx, { secret, ...delivery, success: false });
    assert.equal(rows[0].attempts, attempt);
    assert.equal(await handler(claim)(ctx, { secret }), null);
  }
  assert.equal(rows[0].status, 'exhausted');
});

test('authorization and payload bounds are enforced', async () => {
  const { ctx } = database();
  await assert.rejects(handler(enqueue)(ctx, { ...enqueueArgs, secret: 'wrong' }), /Unauthorized/);
  await assert.rejects(handler(claim)(ctx, { secret: 'wrong' }), /Unauthorized/);
  await assert.rejects(handler(finish)(ctx, { ...enqueueArgs, secret: 'wrong' }), /Unauthorized/);
  await assert.rejects(handler(enqueue)(ctx, { ...enqueueArgs, message: '🟢'.repeat(2000) }), /Invalid notification/);
});

test('recovery can identify API-owned jobs without exposing partner data', async () => {
  const { ctx, tables } = database();
  tables.apiReviewLinks.push({ jobId: 'private', partnerId: 'private-partner' });
  assert.equal(await handler(isApiReview)(ctx, { secret, jobId: 'private' }), true);
  assert.equal(await handler(isApiReview)(ctx, { secret, jobId: 'internal' }), false);
});

test('stalled uploads get one durable alert without changing review state', async () => {
  const { ctx, tables, rows } = database();
  const { queueStalledBatches } = await import('../convex/telegramNotifications.ts');
  tables.reviewBatches = [{
    _id: 'batch:one', batchId: 'one', notificationReady: false, updatedAt: 0, expectedCount: 1,
    items: [{ status: 'pending', offerOutcomes: [{ offerName: 'Client <A>' }] }],
  }];
  assert.equal(await handler(queueStalledBatches)(ctx, { secret, appUrl: 'https://admin.adchecked.com' }), 1);
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /Client &lt;A&gt;/);
  assert.match(rows[0].message, /\/batches\/one/);
  assert.equal(tables.reviewBatches[0].items[0].status, 'pending');
  assert.equal(await handler(queueStalledBatches)(ctx, { secret, appUrl: 'https://admin.adchecked.com' }), 0);
});
