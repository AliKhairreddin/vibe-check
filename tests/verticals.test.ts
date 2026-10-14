import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { list, save, reviewPolicy, reviewCatalog, assignLegacy } from '../convex/verticals.ts';
import { VERTICAL_CATALOG } from '../convex/verticalCatalog.ts';
import { demoFixture } from './helpers/demo-fixture.ts';

process.env.CONVEX_HTTP_SECRET = 'vertical-test-secret';
const invoke = (fn: any, ctx: any, args: any) => fn._handler(ctx, { secret: 'vertical-test-secret', ...args });
async function fixture() {
  const f = demoFixture();
  for (const table of ['advertiserVerticals', 'advertiserVerticalRevisions', 'offerProfiles', 'offerProfileRevisions']) f.tables[table] = [];
  Object.assign(f.ctx.db, { async replace(id: string, value: any) { const row = await f.ctx.db.get(id); assert.ok(row); const table = id.split(':')[0]; f.tables[table] = f.tables[table].map(item => item._id === id ? { ...value, _id: id } : item); } });
  await f.ctx.db.insert('offerProfiles', { offerId: 'own', displayName: 'Own', officialGuidelines: 'Shared disclosures', enabled: true, internalOverrides: [], version: 4, isDefault: false, createdAt: 1, updatedAt: 1 });
  return f;
}
const input = { clientId: 'own', offerId: 'own', verticalId: 'solar', name: 'Solar', enabled: true, includeDefault: false, officialGuidelines: 'Do not promise free panels.', internalOverrides: [], expectedVersion: 0 };

test('catalog matches Python validation and includes broad industries without activating them for new advertisers', async () => {
  assert.deepEqual(VERTICAL_CATALOG, JSON.parse(readFileSync(new URL('../backend/app/vertical_catalog.json', import.meta.url), 'utf8')));
  const f = await fixture();
  assert.equal((await invoke(list, f.ctx, { clientId: 'own', publisher: true })).length, 0);
  assert.ok((await invoke(list, f.ctx, { clientId: 'own' })).length > 50);
  const legacy = await invoke(list, f.ctx, { clientId: 'kissterra', publisher: true });
  assert.deepEqual(legacy.map((row: any) => row.verticalId), ['auto-insurance', 'home-insurance']);
  assert.ok(legacy.every((row: any) => Object.keys(row).length === 2), 'publishers get names and IDs, never policies or rules');
});

test('audited assignments are atomic, preserve source revisions, and cannot overwrite later edits', async () => {
  const f = await fixture();
  const rule = { overrideId: 'severity', title: 'Severity', guidance: 'Keep severity', rationale: 'Current source', enabled: true };
  const assignments = ['lead-economy', 'kissterra', 'smart-financial'].map(clientId => ({
    clientId, expectedVersion: 5, expectedGuidelines: 'Auto $19 and Home $31', expectedOverrides: [rule],
    sharedGuidelines: 'Shared brand restrictions', sharedOverrides: [rule],
    verticals: [
      { verticalId: 'auto-insurance', enabled: true, officialGuidelines: 'Auto $19', internalOverrides: [] },
      { verticalId: 'home-insurance', enabled: true, officialGuidelines: 'Home $31', internalOverrides: [] },
    ],
  }));
  for (const item of assignments) await f.ctx.db.insert('offerProfiles', { offerId: item.clientId, displayName: item.clientId, officialGuidelines: item.expectedGuidelines,
    // Convex object key order must not affect the guarded comparison.
    internalOverrides: [{ enabled: true, guidance: rule.guidance, overrideId: rule.overrideId, rationale: rule.rationale, title: rule.title }], enabled: true, isDefault: false, version: 5, createdAt: 1, updatedAt: 1 });
  const stale = structuredClone(assignments); stale[2].expectedVersion = 4;
  await assert.rejects(assignLegacy._handler(f.ctx as any, { assignments: stale }), /Source changed/);
  assert.equal(f.tables.advertiserVerticals.length, 0, 'no partial migration');
  const applied = await assignLegacy._handler(f.ctx as any, { assignments });
  assert.ok(applied.every(row => row.changed && row.version === 6));
  assert.equal(f.tables.offerProfileRevisions.length, 6);
  assert.equal(f.tables.advertiserVerticalRevisions.length, 6);
  assert.ok(f.tables.offerProfileRevisions.filter(row => row.version === 5).every(row => row.officialGuidelines === assignments[0].expectedGuidelines));
  assert.ok((await assignLegacy._handler(f.ctx as any, { assignments })).every(row => !row.changed));
  const catalog = await invoke(reviewCatalog, f.ctx, { offerIds: ['kissterra'] });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].version, 6);
  assert.equal(catalog[0].official_guidelines, 'Shared brand restrictions');
  assert.deepEqual(catalog[0].vertical_policies.map((p: any) => p.official_guidelines), ['Auto $19', 'Home $31']);
  f.tables.advertiserVerticals[0].version = 2;
  await assert.rejects(assignLegacy._handler(f.ctx as any, { assignments }), /Source changed/);
  await assert.rejects(invoke(reviewCatalog, f.ctx, { offerIds: ['foreign'] }), /Invalid audited/);
  await assert.rejects(invoke(reviewCatalog, f.ctx, { offerIds: [], secret: 'forged' }), /Unauthorized/);
});

test('vertical policies are isolated, revisioned, preserve the default, and enforce stale writes', async () => {
  const f = await fixture(); const base = structuredClone(f.tables.offerProfiles);
  const first = await invoke(save, f.ctx, input);
  assert.equal(first.version, 1);
  assert.deepEqual(f.tables.offerProfiles, base);
  assert.equal(f.tables.advertiserVerticalRevisions.length, 1);
  await assert.rejects(invoke(save, f.ctx, input), /changed since/);
  assert.equal((await invoke(list, f.ctx, { clientId: 'other', publisher: true })).length, 0);
  const selected = await invoke(reviewPolicy, f.ctx, { clientId: 'own', offerId: 'own', verticalId: 'solar' });
  assert.equal(selected.policy.officialGuidelines, input.officialGuidelines);
  await invoke(save, f.ctx, { ...input, enabled: false, expectedVersion: 1 });
  assert.equal((await invoke(list, f.ctx, { clientId: 'own', publisher: true })).length, 0);
  assert.equal(f.tables.advertiserVerticalRevisions.length, 2);
  assert.equal(f.tables.advertiserVerticalRevisions[0].enabled, true);
  await assert.rejects(invoke(save, f.ctx, { ...input, secret: 'forged' }), /Unauthorized/);
});

test('custom verticals require guidelines and cannot activate an unavailable default', async () => {
  const f = await fixture();
  await assert.rejects(invoke(save, f.ctx, { ...input, officialGuidelines: '' }), /Add vertical guidelines/);
  await assert.rejects(invoke(save, f.ctx, { ...input, verticalId: 'unregistered' }), /Custom vertical/);
  await invoke(save, f.ctx, { ...input, verticalId: 'custom-specialty', name: 'Specialty products' });
  const visible = await invoke(list, f.ctx, { clientId: 'own', publisher: true });
  assert.deepEqual(visible, [{ verticalId: 'custom-specialty', name: 'Specialty products' }]);
  f.tables.offerProfiles[0].enabled = false;
  await assert.rejects(invoke(save, f.ctx, { ...input, includeDefault: true }), /Enable and save/);
});
