import assert from 'node:assert/strict';
import test from 'node:test';
import { submit, getBatch, statusColors, getAsset, claim, heartbeat, finish, pending } from '../convex/apiJobs.ts';
import { assertApiLease, syncApiJobState } from '../convex/apiJobState.ts';
import { setReport, upsertStatus, listInterrupted, failInterrupted } from '../convex/reviews.ts';

const invoke = (fn: unknown, ctx: unknown, args: Record<string, unknown>) =>
  (fn as { _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<any> })._handler(ctx, { secret: 'test-secret', ...args });
process.env.CONVEX_HTTP_SECRET = 'test-secret';

function fixture() {
  const tables: Record<string, any[]> = {};
  const reads: string[] = [];
  let serial = 0;
  const db = {
    query(table: string) {
      reads.push(table);
      const predicates: Array<(row: any) => boolean> = [];
      let direction = 1;
      let columns: string[] = [];
      const index = {
        eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return index; },
        lte(key: string, value: number) { predicates.push(row => row[key] <= value); return index; },
      };
      const matches = () => [...(tables[table] ?? [])].filter(row => predicates.every(p => p(row)))
        .sort((a, b) => {
          for (const key of [...columns, '_creationTime']) {
            if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction;
          }
          return 0;
        });
      const query = {
        withIndex(name: string, configure: (index: any) => unknown) {
          if (name.endsWith('available_at')) columns = ['availableAt'];
          if (name.endsWith('batch_position')) columns = ['batchPosition'];
          configure(index); return query;
        },
        order(value: string) { direction = value === 'desc' ? -1 : 1; return query; },
        unique: async () => { const rows = matches(); assert.ok(rows.length <= 1); return rows[0] ?? null; },
        first: async () => matches()[0] ?? null,
        take: async (n: number) => matches().slice(0, n),
      };
      return query;
    },
    async insert(table: string, value: any) {
      const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial };
      (tables[table] ??= []).push(row); return row._id;
    },
    async patch(id: string, value: any) {
      const row = Object.values(tables).flat().find(r => r._id === id);
      assert.ok(row, `Missing ${id}`); Object.assign(row, value);
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const index = rows.findIndex(row => row._id === id);
        if (index !== -1) rows.splice(index, 1);
      }
    },
  };
  tables.apiPartners = [{ _id: 'partner', partnerId: 'p', status: 'active', allowedOfferIds: ['acp'], maxUploadMb: 400,
    monthlyReviewLimit: 500, concurrentReviewLimit: 5, unlimitedConcurrency: true, unlimitedReviews: false }];
  tables.apiKeys = [{ _id: 'key', keyId: 'k', partnerId: 'p', status: 'active', scopes: ['reviews:create'] }];
  const args = (count = 2) => ({
    partnerId: 'p', apiKeyId: 'k', batchId: 'batch_' + 'a'.repeat(32), idempotencyKey: 'batch-1', requestHash: 'hash-1',
    offerId: 'acp', offerName: 'ACP', requestMeta: '{}', maxBytes: 400 * 1024 * 1024,
    creatives: Array.from({ length: count }, (_, i) => ({ jobId: i.toString(16).padStart(32, '0'), assetId: `asset_${i}`, creativeName: `Creative ${i}`, mediaUrl: `https://cdn.example.com/${i}.png` })),
  });
  return { ctx: { db }, tables, reads, args };
}

test('100 creatives are reserved once, ordered, and batch idempotency rejects changed payloads', async () => {
  const { ctx, tables, args } = fixture();
  const result = await invoke(submit, ctx, args(100));
  assert.equal(result.total, 100);
  assert.equal(result.status, 'queued');
  assert.equal(result.assets[99].asset_id, 'asset_99');
  assert.equal(tables.apiMonthlyUsage[0].reviewsCreated, 100);
  assert.equal(tables.reviews.length, 100);
  await invoke(submit, ctx, { ...args(100), batchId: 'batch_' + 'b'.repeat(32) });
  assert.equal(tables.apiJobBatches.length, 1);
  assert.equal(tables.apiMonthlyUsage[0].reviewsCreated, 100);
  await assert.rejects(invoke(submit, ctx, { ...args(100), requestHash: 'changed' }), /different batch/);
});

test('invalid batch, unauthorized offer, exhausted quota and expired credentials reserve nothing', async () => {
  for (const kind of ['empty', 'oversize', 'duplicates', 'offer', 'monthly', 'concurrent', 'key', 'expired', 'secret']) {
    const { ctx, tables, args } = fixture();
    const input: any = args(kind === 'empty' ? 0 : kind === 'oversize' ? 101 : 2);
    if (kind === 'duplicates') input.creatives[1].assetId = input.creatives[0].assetId;
    if (kind === 'offer') input.offerId = 'another';
    if (kind === 'monthly') tables.apiPartners[0].monthlyReviewLimit = 1;
    if (kind === 'concurrent') Object.assign(tables.apiPartners[0], { unlimitedConcurrency: false, concurrentReviewLimit: 1 });
    if (kind === 'key') tables.apiKeys[0].partnerId = 'other';
    if (kind === 'expired') tables.apiKeys[0].expiresAt = 1;
    if (kind === 'secret') input.secret = 'wrong';
    await assert.rejects(invoke(submit, ctx, input));
    assert.equal(tables.apiJobBatches?.length ?? 0, 0, kind);
    assert.equal(tables.apiReviewLinks?.length ?? 0, 0, kind);
    assert.equal(tables.apiMonthlyUsage?.length ?? 0, 0, kind);
  }
});

test('asset lookups are tenant-scoped, select latest submission, and pin exact owned reviews', async () => {
  const { ctx, tables, args } = fixture();
  await invoke(submit, ctx, args());
  assert.equal(await invoke(getBatch, ctx, { partnerId: 'other', batchId: args().batchId }), null);
  assert.equal(await invoke(getAsset, ctx, { partnerId: 'other', assetId: 'asset_0' }), null);
  assert.equal(await invoke(getAsset, ctx, { partnerId: 'p', assetId: 'asset_1', reviewId: args().creatives[0].jobId }), null);
  const old = tables.apiReviewLinks[0];
  await ctx.db.insert('apiReviewLinks', { ...old, jobId: 'new-review', requestedOfferId: 'kissterra', executionStatus: 'processing' });
  const latest = await invoke(getAsset, ctx, { partnerId: 'p', assetId: 'asset_0' });
  assert.equal(latest.review_id, 'new-review');
  assert.equal(latest.color, null);
  assert.equal((await invoke(getAsset, ctx, { partnerId: 'p', assetId: 'asset_0', offerId: 'acp' })).review_id, old.jobId);
  assert.equal((await invoke(getAsset, ctx, { partnerId: 'p', assetId: 'asset_0', reviewId: old.jobId })).review_id, old.jobId);
});

test('colors never read reports/evidence and do not paint pending, failed or foreign assets green', async () => {
  const { ctx, tables, reads, args } = fixture();
  await invoke(submit, ctx, args(5));
  for (const [i, color] of ['green', 'yellow', 'red'].entries()) {
    Object.assign(tables.apiReviewLinks[i], { executionStatus: 'completed', reportReady: true, resultColor: color, findingCount: i });
  }
  Object.assign(tables.apiReviewLinks[3], { executionStatus: 'failed', reportReady: true, resultColor: 'green' });
  reads.length = 0;
  const colors = await invoke(statusColors, ctx, { partnerId: 'p', assetIds: ['asset_0', 'asset_1', 'asset_2', 'asset_3', 'asset_4', 'missing'] });
  assert.deepEqual(colors.map((r: any) => r.color), ['green', 'yellow', 'red', null, null, null]);
  assert.equal(colors[0].clean, true);
  assert.equal(colors[1].clean, false);
  assert.equal(colors[5].status, 'not_found');
  assert.deepEqual([...new Set(reads)], ['apiReviewLinks']);
  const foreign = await invoke(statusColors, ctx, { partnerId: 'other', assetIds: ['asset_0'] });
  assert.equal(foreign[0].status, 'not_found');
});

test('batch status waits for every asset, with counts preserving partial successes', async () => {
  const { ctx, tables, args } = fixture();
  await invoke(submit, ctx, args());
  tables.apiReviewLinks[0].executionStatus = 'failed';
  assert.equal((await invoke(getBatch, ctx, { partnerId: 'p', batchId: args().batchId })).status, 'processing');
  tables.apiReviewLinks[1].executionStatus = 'completed';
  const batch = await invoke(getBatch, ctx, { partnerId: 'p', batchId: args().batchId });
  assert.equal(batch.status, 'failed');
  assert.deepEqual(batch.counts, { queued: 0, processing: 0, completed: 1, failed: 1 });
});

test('leases exclude duplicate workers, recover expired attempts, and fence late writes', async () => {
  const { ctx, tables, args } = fixture();
  await invoke(submit, ctx, args(1));
  const first = await invoke(claim, ctx, {});
  assert.equal(await invoke(claim, ctx, {}), null);
  await invoke(heartbeat, ctx, { jobId: first.job_id, leaseId: first.lease_id });
  tables.apiReviewLinks[0].availableAt = 0;
  const second = await invoke(claim, ctx, {});
  assert.notEqual(second.lease_id, first.lease_id);
  await assert.rejects(assertApiLease(ctx as any, first.job_id, first.lease_id), /lease/);
  await assert.rejects(invoke(setReport, ctx, { jobId: first.job_id, apiLeaseId: first.lease_id, report: {} }), /lease/);
  await assert.rejects(invoke(upsertStatus, ctx, { jobId: first.job_id, apiLeaseId: first.lease_id, status: 'complete', progress: 100, message: 'old', reportReady: true }), /lease/);
  await assert.rejects(invoke(finish, ctx, { jobId: first.job_id, leaseId: first.lease_id, success: false, retryable: false, message: 'old' }), /lease/);
  assert.equal(tables.apiReviewLinks[0].executionStatus, 'processing');
});

test('transient failures retry three times and invalid media fails immediately', async () => {
  const { ctx, tables, args } = fixture();
  await invoke(submit, ctx, args(2));
  for (let attempt = 1; attempt <= 3; attempt++) {
    tables.apiReviewLinks[0].availableAt = -1;
    const task = await invoke(claim, ctx, {});
    await invoke(finish, ctx, { jobId: task.job_id, leaseId: task.lease_id, success: false, retryable: true, message: 'temporary' });
    assert.equal(tables.apiReviewLinks[0].status, attempt < 3 ? 'active' : 'failed');
  }
  const task = await invoke(claim, ctx, {});
  await invoke(finish, ctx, { jobId: task.job_id, leaseId: task.lease_id, success: false, retryable: false, message: 'Unsupported file' });
  assert.equal(tables.apiReviewLinks[1].status, 'failed');
  assert.equal(tables.apiReviewLinks[1].mediaUrl, undefined);
  assert.equal(await invoke(claim, ctx, {}), null);
});

test('completed jobs survive a lost completion acknowledgement without running again', async () => {
  const { ctx, tables, args } = fixture();
  await invoke(submit, ctx, args(1));
  const task = await invoke(claim, ctx, {});
  Object.assign(tables.reviews[0], { status: 'complete', reportReady: true });
  Object.assign(tables.apiReviewLinks[0], { executionStatus: 'completed', reportReady: true });
  assert.equal(await invoke(pending, ctx, { now: tables.apiReviewLinks[0].availableAt - 1 }), false);
  assert.equal(await invoke(pending, ctx, { now: tables.apiReviewLinks[0].availableAt + 1 }), true);
  tables.apiReviewLinks[0].availableAt = 0;
  assert.equal(await invoke(claim, ctx, {}), null);
  assert.equal(tables.apiReviewLinks[0].status, 'complete');
  assert.equal(tables.apiReviewLinks[0].attempts, 1);
  assert.equal(tables.apiReviewLinks[0].mediaUrl, undefined);
  assert.equal(task.job_id, tables.reviews[0].jobId);
});

test('transport replay is safe even without an idempotency key', async () => {
  const { ctx, tables, args } = fixture();
  const input = { ...args(1), idempotencyKey: undefined };
  await invoke(submit, ctx, input);
  await invoke(submit, ctx, input);
  assert.equal(tables.apiJobBatches.length, 1);
  assert.equal(tables.apiReviewLinks.length, 1);
  assert.equal(tables.apiMonthlyUsage[0].reviewsCreated, 1);
});

test('compact projection uses only the selected offer and normalizes old colors', async () => {
  const { ctx, tables, args } = fixture();
  await invoke(submit, ctx, args(1));
  await syncApiJobState(ctx as any, tables.apiReviewLinks[0], { status: 'complete', reportReady: true }, {
    overall_status: 'red', findings: ['other offer'], offer_results: [
      { offer_id: 'other', overall_status: 'red', findings: ['bad'] },
      { offer_id: 'acp', overall_status: 'amber', findings: ['selected issue'] },
    ],
  });
  const [card] = await invoke(statusColors, ctx, { partnerId: 'p', assetIds: ['asset_0'] });
  assert.equal(card.color, 'yellow');
  assert.equal(card.finding_count, 1);
});

test('generic recovery cannot take ownership of durable batch jobs', async () => {
  const { ctx, tables, args } = fixture();
  await invoke(submit, ctx, args());
  assert.deepEqual(await invoke(listInterrupted, ctx, { limit: 100 }), []);
  await invoke(failInterrupted, ctx, { jobIds: args().creatives.map(c => c.jobId), message: 'interrupted' });
  assert.ok(tables.reviews.every(r => r.status === 'queued'));
});
