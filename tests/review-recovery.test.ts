import assert from 'node:assert/strict';
import test from 'node:test';
import { listInterrupted, claimInterrupted, failInterrupted } from '../convex/reviews.ts';

const secret = 'test-secret';
process.env.CONVEX_HTTP_SECRET = secret;
const invoke = (fn: unknown, ctx: unknown, args: Record<string, unknown>) =>
  (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<any> })
    ._handler(ctx, { secret, ...args });

function fixture() {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    reviews: [], platformInstances: [], reviewOfferStats: [], reviewBatches: [],
  };
  const db = {
    query(table: string) {
      const predicates: Array<(row: any) => boolean> = [];
      const index = {
        eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return index; },
        lte(key: string, value: number) { predicates.push(row => row[key] <= value); return index; },
      };
      const matches = () => (tables[table] ?? []).filter(row => predicates.every(p => p(row)))
        .sort((a, b) => a.updatedAt - b.updatedAt);
      const query = {
        withIndex(_name: string, configure: (index: any) => unknown) { configure(index); return query; },
        order(_direction: string) { return query; },
        unique: async () => matches()[0] ?? null,
        collect: async () => matches(),
        take: async (n: number) => matches().slice(0, n),
      };
      return query;
    },
    async patch(id: string, value: any) {
      Object.assign(Object.values(tables).flat().find(row => row._id === id), value);
    },
    async insert(table: string, value: any) {
      const rows = tables[table] ??= [];
      const row = { ...value, _id: `${table}:${rows.length}` };
      rows.push(row);
      return row._id;
    },
  };
  const add = (jobId: string, values: Record<string, unknown> = {}) => {
    const row = { _id: jobId, jobId, status: 'reviewing_with_llm', updatedAt: now - 600_000,
      createdAt: now - 600_000, processingInstanceId: 'old', fileName: 'creative.mp4',
      offerIds: [], hasCreative: true, ...values };
    tables.reviews.push(row);
    return row;
  };
  return { ctx: { db }, tables, add, now };
}

test('idle maintenance container leaves active and waiting work on other containers alone', async () => {
  const { ctx, tables, add, now } = fixture();
  tables.platformInstances.push({ instanceId: 'busy', updatedAt: now });
  add('active', { processingInstanceId: 'busy' });
  add('waiting', { processingInstanceId: 'busy', status: 'queued', updatedAt: now - 86_400_000 });
  add('new-container', { processingInstanceId: 'starting', updatedAt: now });
  add('interrupted');
  const rows = await invoke(listInterrupted, ctx, { limit: 100, idleInstanceId: 'maintenance' });
  assert.deepEqual(rows.map((row: any) => row.jobId), ['interrupted']);
  assert.equal(rows[0].processingInstanceId, 'old');
});

test('expired owners are recoverable and recent legacy work gets a rollout grace period', async () => {
  const { ctx, tables, add, now } = fixture();
  tables.platformInstances.push({ instanceId: 'old', updatedAt: now - 600_000 });
  add('interrupted');
  add('recent-legacy', { processingInstanceId: undefined });
  add('stale-legacy', { processingInstanceId: undefined, updatedAt: now - 7_200_001 });
  const rows = await invoke(listInterrupted, ctx, { limit: 100 });
  assert.deepEqual(new Set(rows.map((row: any) => row.jobId)), new Set(['interrupted', 'stale-legacy']));
});

test('recovery claim rejects progress, completion, a new heartbeat, or another recovery', async () => {
  for (const change of ['progress', 'complete', 'heartbeat', 'claimed']) {
    const { ctx, tables, add, now } = fixture();
    const row = add('job');
    const args = { jobId: 'job', expectedUpdatedAt: row.updatedAt, instanceId: 'maintenance' };
    if (change === 'progress') row.updatedAt = now;
    if (change === 'complete') row.status = 'complete';
    if (change === 'heartbeat') tables.platformInstances.push({ instanceId: 'old', updatedAt: now });
    if (change === 'claimed') {
      assert.equal(await invoke(claimInterrupted, ctx, args), true);
      assert.equal(row.processingInstanceId, 'maintenance');
    }
    assert.equal(await invoke(claimInterrupted, ctx, args), false, change);
  }
});

test('an idle owner can recover its own abandoned work', async () => {
  const { ctx, tables, add, now } = fixture();
  const row = add('job');
  tables.platformInstances.push({ instanceId: 'old', updatedAt: now });
  assert.deepEqual(await invoke(listInterrupted, ctx, { limit: 100 }), []);
  assert.equal((await invoke(listInterrupted, ctx, { limit: 100, idleInstanceId: 'old' })).length, 1);
  assert.equal(await invoke(claimInterrupted, ctx, {
    jobId: 'job', expectedUpdatedAt: row.updatedAt, instanceId: 'old',
  }), true);
});

test('missing recovery media cannot fail a healthy review on another container', async () => {
  const { ctx, tables, add, now } = fixture();
  tables.platformInstances.push({ instanceId: 'busy', updatedAt: now });
  const active = add('active', { processingInstanceId: 'busy' });
  const fresh = add('fresh', { updatedAt: now });
  const completed = add('completed', { status: 'complete' });
  const stale = add('stale');
  const result = await invoke(failInterrupted, ctx, {
    jobIds: ['active', 'fresh', 'completed', 'stale'], message: 'Missing source',
  });
  assert.deepEqual(result.failedJobIds, ['stale']);
  assert.equal(active.status, 'reviewing_with_llm');
  assert.equal(fresh.status, 'reviewing_with_llm');
  assert.equal(completed.status, 'complete');
  assert.equal(stale.status, 'failed');
});

test('recovery operations require the backend secret', async () => {
  const { ctx } = fixture();
  for (const operation of [listInterrupted, claimInterrupted, failInterrupted]) {
    await assert.rejects(invoke(operation, ctx, { secret: 'wrong' }), /Unauthorized/);
  }
});
