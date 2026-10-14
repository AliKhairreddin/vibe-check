import assert from 'node:assert/strict';
import test from 'node:test';
import { saveGuidelines } from '../convex/offers.ts';
import { demoFixture } from './helpers/demo-fixture.ts';

process.env.CONVEX_HTTP_SECRET = 'guidelines-test-secret';
const secret = 'guidelines-test-secret';
const invoke = (ctx: any, args: any) => (saveGuidelines as any)._handler(ctx, { secret, ...args });
async function fixture() {
  const f = demoFixture();
  for (const table of ['offerProfiles', 'offerProfileRevisions', 'learningStates', 'learningVersions']) f.tables[table] = [];
  for (const offerId of ['own', 'other']) await f.ctx.db.insert('offerProfiles', {
    offerId, displayName: offerId, officialGuidelines: 'Original policy', internalOverrides: [], enabled: true,
    isDefault: offerId === 'other', version: 1, createdAt: 1, updatedAt: 1,
  });
  return f;
}
const input = { offerId: 'own', expectedVersion: 1, officialGuidelines: '  Require a disclosure.  ', enabled: true,
  internalOverrides: [{ overrideId: 'clarification', title: 'Allowed claim', guidance: 'Permit only with a qualifier.', rationale: 'Approved wording', enabled: true }] };

test('guidelines save only one policy, preserve metadata and history, and invalidate its learning', async () => {
  const { ctx, tables } = await fixture();
  const other = structuredClone(tables.offerProfiles[1]);
  const saved = await invoke(ctx, input);
  assert.equal(saved.version, 2); assert.equal(saved.official_guidelines, 'Require a disclosure.');
  assert.equal(saved.internal_overrides[0].override_id, 'clarification');
  assert.equal(saved.display_name, 'own'); assert.equal(saved.created_at, 1); assert.equal(saved.is_default, false);
  assert.deepEqual(tables.offerProfiles[1], other);
  assert.equal(tables.offerProfileRevisions.length, 2);
  assert.equal(tables.offerProfileRevisions[0].officialGuidelines, 'Original policy');
  assert.equal(tables.learningStates[0].offerId, 'own');
  assert.equal(tables.learningStates[0].status, 'pending');
  const before = structuredClone(tables);
  await assert.rejects(invoke(ctx, input), /changed since/);
  assert.deepEqual(tables, before, 'stale writes cannot erase the latest rules');
});

test('missing, unauthorized, empty enabled, duplicated, and oversized policies do not write', async () => {
  const { ctx, tables } = await fixture(); const before = structuredClone(tables);
  for (const [patch, error] of [
    [{ secret: 'forged' }, /Unauthorized/], [{ offerId: 'missing' }, /not found/],
    [{ officialGuidelines: ' ' }, /must include/],
    [{ internalOverrides: [...input.internalOverrides, ...input.internalOverrides] }, /Duplicate/],
    [{ officialGuidelines: 'x'.repeat(200001) }, /characters or fewer/],
    [{ internalOverrides: Array.from({ length: 100 }, (_, i) => ({ ...input.internalOverrides[0], overrideId: `rule-${i}`, guidance: 'x'.repeat(10000) })) }, /UTF-8 bytes/],
  ] as const) await assert.rejects(invoke(ctx, { ...input, ...patch }), error);
  assert.deepEqual(tables, before);
  const paused = await invoke(ctx, { ...input, officialGuidelines: '', enabled: false });
  assert.equal(paused.enabled, false); assert.equal(paused.is_default, false);
});
