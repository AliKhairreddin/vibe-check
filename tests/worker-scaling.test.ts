import assert from 'node:assert/strict';
import test from 'node:test';
import { hasLocalWork, planPartnerDispatch, type ShardHeartbeat } from '../worker/scaling.ts';

const now = 1_000_000;
const shards = Array.from({ length: 40 }, (_, i) => ({ name: `blue-${i}`, objectId: `object-${i}` }));
const heartbeat = (i: number, active = 0, pending = 0, updatedAt = now): ShardHeartbeat =>
  ({ backendObjectId: shards[i].objectId, active, pending, workers: 5, updatedAt });
const plan = (pending: number, instances: ShardHeartbeat[] = []) =>
  planPartnerDispatch(pending, shards, instances, 5, now).map(s => s.name);

test('idle queues wake nothing; small batches do not wake all 40 shards', () => {
  assert.deepEqual(plan(0), []);
  assert.deepEqual(plan(1), ['blue-0']);
  assert.equal(plan(6).length, 2);
  assert.equal(plan(100).length, 20);
  assert.equal(plan(200).length, 40);
  assert.equal(plan(10_000).length, 40);
});

test('free warm workers are preferred and local pending jobs reserve their capacity', () => {
  assert.deepEqual(plan(3, [heartbeat(12, 2), heartbeat(19)]), ['blue-19']);
  assert.deepEqual(plan(6, [heartbeat(12, 2, 2), heartbeat(19)]), ['blue-19', 'blue-12']);
  assert.deepEqual(plan(7, [heartbeat(12, 2, 2), heartbeat(19)]), ['blue-19', 'blue-12', 'blue-0']);
});

test('stale, old-slot and replaced process heartbeats cannot hide demand', () => {
  const oldSlot = { ...heartbeat(7), backendObjectId: 'green-7' };
  assert.deepEqual(plan(1, [heartbeat(7, 0, 0, now - 180_001), oldSlot]), ['blue-0']);
  assert.deepEqual(plan(1, [heartbeat(7, 0, 0, now - 1), heartbeat(7, 5)]), ['blue-0']);
  assert.deepEqual(plan(1, [heartbeat(7, 5), heartbeat(7, 0, 0, now - 1)]), ['blue-0']);
});

test('at capacity, existing busy workers are woken to claim work when they finish', () => {
  assert.equal(plan(1, shards.map((_, i) => heartbeat(i, 5))).length, 40);
});

test('active jobs, queued work and background maintenance each prevent idle shutdown', () => {
  assert.equal(hasLocalWork({ active: 0, pending: 0, background: 0 }), false);
  for (const state of [{ active: 1 }, { pending: 1 }, { background: 1 }]) {
    assert.equal(hasLocalWork(state), true);
  }
});
