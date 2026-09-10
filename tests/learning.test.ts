import assert from 'node:assert/strict';
import test from 'node:test';
import { claim, context, control, dataset, enqueueLearning, fail, finish, saveEvidence, saveShadow } from '../convex/learning.ts';
import { decide, clearDecision } from '../convex/clientReviews.ts';
import { isAdminPagePath, apiRequestAllowed, isClientPagePath } from '../worker/routing.ts';

const secret = 'learning-test-secret';
process.env.CONVEX_HTTP_SECRET = secret;
const invoke = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, { secret, ...args });
const metrics = { discovery: 8, validation: 6, improved: 2, regressions: 0, severeRegressions: 0,
  baselineErrors: 2, candidateErrors: 0, shadow: 3, shadowImproved: 1, shadowRegressions: 0 };
function fixture() {
  const tables: Record<string, any[]> = {};
  let serial = 0;
  const db = {
    query(table: string) {
      const predicates: ((row: any) => boolean)[] = [];
      let descending = false;
      let sortKey = '_creationTime';
      const index = {
        eq(key: string, value: unknown) { predicates.push(r => r[key] === value); return index; },
        lte(key: string, value: number) { predicates.push(r => r[key] <= value); return index; },
        lt(key: string, value: number) { predicates.push(r => r[key] < value); return index; },
      };
      const rows = () => (tables[table] ?? []).filter(r => predicates.every(p => p(r)))
        .sort((a, b) => ((a[sortKey] ?? a._creationTime) - (b[sortKey] ?? b._creationTime)) * (descending ? -1 : 1));
      const query = {
        withIndex(name: string, configure?: (index: any) => void) {
          if (name.endsWith('version')) sortKey = 'version';
          if (name.endsWith('decided_at')) sortKey = 'decidedAt';
          if (name.endsWith('created_at')) sortKey = 'createdAt';
          configure?.(index); return query;
        },
        order(order: string) { descending = order === 'desc'; return query; },
        async take(n: number) { return rows().slice(0, n); },
        async unique() { const result = rows(); assert.ok(result.length < 2); return result[0] ?? null; },
        async first() { return rows()[0] ?? null; },
      };
      return query;
    },
    async get(id: string) { return Object.values(tables).flat().find(r => r._id === id) ?? null; },
    async insert(table: string, value: any) { const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial }; (tables[table] ??= []).push(row); return row._id; },
    async patch(id: string, value: any) { const row = await db.get(id); assert.ok(row); Object.assign(row, value); },
    async replace(id: string, value: any) { const row = await db.get(id); const creation = row._creationTime; for (const key of Object.keys(row)) delete row[key]; Object.assign(row, value, { _id: id, _creationTime: creation }); },
    async delete(id: string) { for (const rows of Object.values(tables)) { const i = rows.findIndex(r => r._id === id); if (i >= 0) rows.splice(i, 1); } },
  };
  return { ctx: { db }, tables };
}
async function seed(ctx: any) {
  await ctx.db.insert('offerProfiles', { offerId: 'acp', displayName: 'ACP', officialGuidelines: 'Required disclaimer.', internalOverrides: [], enabled: true, version: 2 });
  await enqueueLearning(ctx, 'acp');
  const state = await ctx.db.query('learningStates').withIndex('by_offer_id', (q: any) => q.eq('offerId', 'acp')).unique();
  state.nextAttemptAt = 0;
  const lease = await invoke(claim, ctx, { token: 'lease' });
  return { state, lease };
}
async function publication(ctx: any, lease: any) {
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = await ctx.db.insert('clientReviewDecisions', { offerId: 'acp', clientId: 'acp', jobId: `j${i}`, decidedAt: i + 1,
      decision: 'approved', feedbackReason: 'partner_preference', feedbackScope: 'similar_creatives', feedbackNote: 'Specific reusable preference.' });
    ids.push(`${id}@${i + 1}`);
    await ctx.db.insert('learningEvidence', { jobId: `j${i}`, offerId: 'acp', fingerprint: `unique-${i}`, complete: true, guidelineVersion: 2, evidence: {} });
  }
  const lesson = { key: 'lesson-1', title: 'Specific clarification', guidance: 'Consider the disclaimer in context.', appliesWhen: 'A disclaimer is visible',
    excludes: 'Missing disclaimer', terms: ['disclaimer'], supportingDecisionIds: ids, contradictingDecisionIds: [], support: 8, contradictions: 0, lowerBound: .675 };
  return { ...lease, guidelineVersion: 2, candidates: [{ lesson, status: 'published', reason: 'Checks passed.', metrics }],
    lessons: [lesson], metrics, decisionIds: ids, message: 'Checks passed.' };
}

test('a decision and its processing request save together, with yellow feedback in either direction', async () => {
  for (const decision of ['approved', 'disapproved']) {
    const { ctx, tables } = fixture();
    await ctx.db.insert('reviewOfferStats', { offerId: 'acp', jobId: 'job', status: 'complete', resultStatus: 'yellow' });
    await ctx.db.insert('reviewOfferReports', { offerId: 'acp', jobId: 'job', report: { guideline_version: 2, learning_version: 1, summary: 'Needs judgment', findings: [{ evidence: 'Claim' }] } });
    const args = { offerId: 'acp', clientId: 'acp', jobId: 'job', decision, feedbackReason: 'partner_preference', feedbackNote: 'A specific distinction.', feedbackScope: 'similar_creatives', findingIndex: 0 };
    const result = await invoke(decide, ctx, args);
    assert.equal(result.feedbackScope, 'similar_creatives');
    assert.equal(tables.clientReviewDecisions[0].guidelineVersion, 2);
    assert.equal(tables.learningStates[0].status, 'pending');
    const generation = tables.learningStates[0].generation;
    await invoke(decide, ctx, args);
    assert.equal(tables.learningStates[0].generation, generation, 'idempotent clicks do not create extra evidence');
    await invoke(clearDecision, ctx, { offerId: 'acp', clientId: 'acp', jobId: 'job' });
    assert.equal(tables.clientReviewDecisions.length, 0);
    assert.equal(tables.clientReviewDecisionHistory[0].feedbackScope, 'similar_creatives');
    assert.equal(tables.learningStates[0].generation, generation + 1);
  }
});

test('only one worker owns an offer and edited feedback fences out stale publication', async () => {
  const { ctx } = fixture();
  const { lease } = await seed(ctx);
  assert.equal(await invoke(claim, ctx, { token: 'second' }), null);
  const args = await publication(ctx, lease);
  await enqueueLearning(ctx, 'acp', true);
  assert.equal(await invoke(finish, ctx, args), false);
});

test('publication is blocked if base policy changes, the lease expires, or owner turns learning off', async () => {
  for (const change of ['policy', 'expiry', 'pause']) {
    const { ctx, tables } = fixture();
    const { lease, state } = await seed(ctx);
    const args = await publication(ctx, lease);
    if (change === 'policy') tables.offerProfiles[0].version++;
    if (change === 'expiry') state.nextAttemptAt = Date.now() - 1;
    if (change === 'pause') await invoke(control, ctx, { offerId: 'acp', action: 'pause', expectedVersion: 0, actor: 'owner' });
    assert.equal(await invoke(finish, ctx, args), false);
    assert.equal(tables.learningVersions?.length ?? 0, 0);
  }
});

test('automatic publication creates an immutable version and only the matching advertiser gets it', async () => {
  const { ctx, tables } = fixture();
  const { lease } = await seed(ctx);
  assert.equal(await invoke(finish, ctx, await publication(ctx, lease)), true);
  const original = JSON.stringify(tables.learningVersions[0]);
  const result = await invoke(context, ctx, { offerId: 'acp', guidelineVersion: 2 });
  assert.equal(result.version, 1);
  assert.equal(result.lessons.length, 1);
  assert.equal((await invoke(context, ctx, { offerId: 'other', guidelineVersion: 2 })).lessons.length, 0);
  assert.equal((await invoke(context, ctx, { offerId: 'acp', guidelineVersion: 3 })).lessons.length, 0);
  await enqueueLearning(ctx, 'acp', true);
  assert.equal(JSON.stringify(tables.learningVersions[0]), original);
  assert.equal(tables.learningVersions[1].lessons.length, 0);
  assert.equal((await invoke(context, ctx, { offerId: 'acp', guidelineVersion: 2 })).lessons.length, 0);
});

test('publication fails closed for insufficient support, regressions, or no prospective validation', async () => {
  for (const change of ['support', 'historical', 'shadow', 'counter']) {
    const { ctx } = fixture();
    const { lease } = await seed(ctx);
    const args = await publication(ctx, lease);
    args.candidates[0].metrics = { ...metrics };
    if (change === 'support') args.lessons[0].support = 1;
    if (change === 'historical') args.candidates[0].metrics.regressions = 1;
    if (change === 'shadow') args.candidates[0].metrics.shadow = 0;
    if (change === 'counter') args.lessons[0].contradictions = 1;
    await assert.rejects(invoke(finish, ctx, args), /requirements/);
  }
});

test('pause removes live learning, restore creates a new version, and stale UI controls cannot overwrite updates', async () => {
  const { ctx, tables } = fixture();
  const { lease } = await seed(ctx);
  await invoke(finish, ctx, await publication(ctx, lease));
  await invoke(control, ctx, { offerId: 'acp', action: 'pause', expectedVersion: 1, actor: 'owner' });
  assert.equal((await invoke(context, ctx, { offerId: 'acp', guidelineVersion: 2 })).lessons.length, 0);
  await assert.rejects(invoke(control, ctx, { offerId: 'acp', action: 'restore', expectedVersion: 1, restoreVersion: 1, actor: 'owner' }), /Refresh/);
  await invoke(control, ctx, { offerId: 'acp', action: 'restore', expectedVersion: 2, restoreVersion: 1, actor: 'owner' });
  assert.equal(tables.learningVersions.length, 3);
  assert.equal((await invoke(context, ctx, { offerId: 'acp', guidelineVersion: 2 })).lessons.length, 1);
});

test('changed evidence blocks restoration and wrong advertiser shadow records are rejected', async () => {
  const { ctx, tables } = fixture();
  const { lease } = await seed(ctx);
  await invoke(finish, ctx, await publication(ctx, lease));
  await invoke(control, ctx, { offerId: 'acp', action: 'pause', expectedVersion: 1, actor: 'owner' });
  tables.clientReviewDecisions[0].decidedAt++;
  await assert.rejects(invoke(control, ctx, { offerId: 'acp', action: 'restore', expectedVersion: 2, restoreVersion: 1, actor: 'owner' }), /feedback changed/);
  await assert.rejects(invoke(saveShadow, ctx, { offerId: 'other', runId: tables.learningRuns[0]._id, jobId: 'j', fingerprint: 'f', baseline: 'yellow', candidate: 'green' }), /Wrong advertiser/);
});

test('processing failures retry with backoff and stale workers cannot change job state', async () => {
  const { ctx } = fixture();
  const { lease, state } = await seed(ctx);
  await invoke(fail, ctx, { ...lease, token: 'wrong' });
  assert.equal(state.status, 'processing');
  await invoke(fail, ctx, lease);
  assert.equal(state.status, 'pending');
  assert.ok(state.nextAttemptAt > Date.now());
  state.attempts = 5; state.nextAttemptAt = 0;
  assert.equal(await invoke(claim, ctx, { token: 'again' }), null);
  assert.equal(state.status, 'failed');
});

test('learning endpoints require the backend secret and the UI is only available in the admin surface', async () => {
  const { ctx } = fixture();
  await assert.rejects(invoke(dataset, ctx, { secret: 'wrong', offerId: 'acp' }), /Unauthorized/);
  assert.ok(isAdminPagePath('/learning'));
  assert.equal(isClientPagePath('/learning'), false);
  assert.equal(apiRequestAllowed('client', '/api/learning/acp'), false);
});

test('evidence snapshots are bounded and immutable across retries', async () => {
  const { ctx, tables } = fixture();
  const args = { jobId: 'job', offerId: 'acp', guidelineVersion: 2, learningVersion: 1, fingerprint: 'f', evidence: { text: 'first' }, complete: true };
  await invoke(saveEvidence, ctx, args);
  await invoke(saveEvidence, ctx, { ...args, evidence: { text: 'changed' } });
  assert.equal(tables.learningEvidence[0].evidence.text, 'first');
  await assert.rejects(invoke(saveEvidence, ctx, { ...args, evidence: { text: 'x'.repeat(71000) } }), /bounded/);
});

test('new decisions arriving during evaluation are coalesced and delay publication', async () => {
  const { ctx, tables } = fixture();
  const { lease, state } = await seed(ctx);
  const args = await publication(ctx, lease);
  await enqueueLearning(ctx, 'acp');
  assert.equal(state.generation, lease.generation);
  assert.equal(state.rerunRequested, true);
  assert.equal(await invoke(finish, ctx, args), true);
  assert.equal(tables.learningVersions[0].lessons.length, 0);
  assert.equal(tables.learningRuns[0].candidates[0].status, 'shadow');
  assert.equal(state.status, 'pending');
});

test('disabling one clarification writes a new version and suppresses its key', async () => {
  const { ctx, tables } = fixture();
  const { lease } = await seed(ctx);
  await invoke(finish, ctx, await publication(ctx, lease));
  await invoke(control, ctx, { offerId: 'acp', action: 'disable', expectedVersion: 1, lessonKey: 'lesson-1', actor: 'owner' });
  assert.equal(tables.learningVersions.length, 2);
  assert.equal(tables.learningVersions[1].lessons.length, 0);
  assert.deepEqual(tables.learningStates[0].suppressedKeys, ['lesson-1']);
});
