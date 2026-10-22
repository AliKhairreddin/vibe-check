import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatch, finishItem, claimItemRetry, updateItemStatus } from '../convex/batches.ts';

const secret = 'batch-completion-test';
process.env.CONVEX_HTTP_SECRET = secret;
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, { secret, ...args });

async function fixture(count = 2) {
  let batch: any;
  let writes = 0;
  const ctx = {
    db: {
      query(table: string) {
        return { withIndex() { return {
          unique: async () => table === 'reviewBatches' ? batch ?? null : null,
          take: async () => [],
        }; } };
      },
      async insert(_table: string, value: any) { batch = { ...value, _id: 'batch:one' }; return batch._id; },
      async patch(_id: string, value: any) { writes++; Object.assign(batch, value); },
    },
  };
  await invoke(createBatch, ctx, { batchId: 'batch', items: Array.from({ length: count }, (_, i) => ({
    itemId: `item-${i}`, fileName: `creative-${i}.mp4`, mediaKind: 'video',
  })) });
  const args = (index = 0, extra = {}) => ({ batchId: 'batch', itemId: `item-${index}`, jobId: `job-${index}`,
    status: 'complete', result: 'yellow', message: 'Complete', ...extra });
  return { ctx, batch, args, writes: () => writes };
}

test('each unique completion persists and only the last completion claims notification', async () => {
  const f = await fixture(85);
  for (let i = 0; i < 85; i++) {
    const result = await invoke(finishItem, f.ctx, f.args(i));
    assert.equal(result.shouldNotify, i === 84);
    assert.equal(result.batch.items.filter((item: any) => item.status === 'complete').length, i + 1);
  }
  assert.equal(f.writes(), 85);
  assert.equal(f.batch.notificationAttempts, 1);
  assert.ok(f.batch.notificationClaimId);
});

test('replayed completions do not write or change timestamps, sibling items, or notification ownership', async () => {
  const f = await fixture();
  const outcome = { offerId: 'offer', offerName: 'Offer', overallStatus: 'yellow',
    evaluationState: 'evaluated', message: 'Evaluated' };
  await invoke(finishItem, f.ctx, f.args(0, { offerOutcomes: [outcome] }));
  const before = structuredClone(f.batch);
  // Convex object encoding and JSON callers may use a different property order.
  const reordered = Object.fromEntries(Object.entries(outcome).reverse());
  for (let i = 0; i < 40; i++) {
    assert.equal((await invoke(finishItem, f.ctx, f.args(0, { offerOutcomes: [reordered] }))).shouldNotify, false);
  }
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.batch, before);
  const last = await invoke(finishItem, f.ctx, f.args(1));
  assert.equal(last.shouldNotify, true);
  const claim = f.batch.notificationClaimId;
  assert.equal((await invoke(finishItem, f.ctx, f.args(1))).shouldNotify, false);
  assert.equal(f.batch.notificationClaimId, claim);
  assert.equal(f.batch.notificationAttempts, 1);
  assert.equal(f.writes(), 2);
});

test('duplicate final snapshots can still acquire a pending notification claim', async () => {
  const f = await fixture(1);
  Object.assign(f.batch.items[0], { jobId: 'job-0', status: 'complete', result: 'yellow', message: 'Complete' });
  f.batch.notificationReady = true;
  assert.equal((await invoke(finishItem, f.ctx, f.args())).shouldNotify, true);
  assert.equal(f.writes(), 1);
});

test('late failures and older-job callbacks leave a completed item intact', async () => {
  const f = await fixture(1);
  await invoke(finishItem, f.ctx, f.args());
  const before = structuredClone(f.batch);
  for (const extra of [{ status: 'failed', message: 'Late worker failure' },
    { jobId: 'old-job', result: 'red', message: 'Old completion' }]) {
    assert.equal((await invoke(finishItem, f.ctx, f.args(0, extra))).shouldNotify, false);
  }
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.batch, before);
});

test('explicit upload retry accepts the replacement job and rejects its predecessor', async () => {
  const f = await fixture();
  await invoke(finishItem, f.ctx, f.args(0, { status: 'upload_failed', message: 'Import failed', result: undefined }));
  assert.equal((await invoke(claimItemRetry, f.ctx, { batchId: 'batch', itemId: 'item-0' })).claimed, true);
  await invoke(updateItemStatus, f.ctx, { batchId: 'batch', itemId: 'item-0', jobId: 'replacement', status: 'queued', message: 'Queued' });
  const before = structuredClone(f.batch);
  assert.equal((await invoke(finishItem, f.ctx, f.args())).shouldNotify, false);
  assert.deepEqual(f.batch, before);
  await invoke(finishItem, f.ctx, f.args(0, { jobId: 'replacement' }));
  assert.equal(f.batch.items[0].jobId, 'replacement');
  assert.equal(f.batch.items[0].status, 'complete');
});

test('changed outcome snapshots still persist while notification retries remain bounded', async () => {
  const f = await fixture(1);
  await invoke(finishItem, f.ctx, f.args());
  await invoke(finishItem, f.ctx, f.args(0, { result: 'red', offerOutcomes: [{
    offerId: 'offer', offerName: 'Offer', evaluationState: 'evaluated', message: 'Evaluated', overallStatus: 'red',
  }] }));
  assert.equal(f.batch.items[0].result, 'red');
  f.batch.notificationStatus = 'pending';
  f.batch.notificationAttempts = 3;
  assert.equal((await invoke(finishItem, f.ctx, f.args(0, { result: 'red' }))).shouldNotify, false);
  assert.equal(f.batch.notificationStatus, 'failed_exhausted');
});

test('missing items and unauthorized callers do not mutate batches', async () => {
  const f = await fixture();
  await assert.rejects(invoke(finishItem, f.ctx, f.args(99)), /Batch item not found/);
  await assert.rejects(invoke(finishItem, f.ctx, f.args(0, { secret: 'wrong' })), /Unauthorized/);
  assert.equal(f.writes(), 0);
});
