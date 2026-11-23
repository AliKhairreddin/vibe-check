import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatch, finishItem } from '../convex/batches.ts';

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

test('missing items and unauthorized callers do not mutate batches', async () => {
  const f = await fixture();
  await assert.rejects(invoke(finishItem, f.ctx, f.args(99)), /Batch item not found/);
  await assert.rejects(invoke(finishItem, f.ctx, f.args(0, { secret: 'wrong' })), /Unauthorized/);
  assert.equal(f.writes(), 0);
});
