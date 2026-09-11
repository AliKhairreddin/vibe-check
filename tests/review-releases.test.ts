import assert from 'node:assert/strict';
import test from 'node:test';
import { getSelection, release, restrictSmartFinancialAutoBatch } from '../convex/reviewReleases.ts';
import { upsertStatus, softDelete, syncReviewOfferStats, getStatus, getReport as getAdminReport, listRecent } from '../convex/reviews.ts';
import { list, getDetail, getReport, hasReview, decide, clearDecision } from '../convex/clientReviews.ts';
import { listSubmissions, createShare, getShare } from '../convex/workspaces.ts';
import { getAccessibleReview, getSharedOfferReport, listSharedOfferReviews } from '../convex/apiPartners.ts';
import { getBatch, getBatches } from '../convex/batches.ts';
import { deletableBatchReviewIds, hasBatchReleases, hasReviewReleases, isReviewDeletable } from '../frontend/src/lib/review-releases.ts';
import { hasReviewReleases as hasStoredReviewReleases } from '../convex/reviewReleaseState.ts';

const secret = 'release-test-secret';
process.env.CONVEX_HTTP_SECRET = secret;

test('release button distinguishes private, released, and legacy reviews', () => {
  const complete = { status: 'complete', report_ready: true };
  assert.equal(hasReviewReleases({ ...complete, released_offer_ids: [] }), false);
  assert.equal(hasReviewReleases({ ...complete, released_offer_ids: ['smart-financial'] }), true);
  assert.equal(hasReviewReleases({ ...complete, released_offer_ids: ['smart-financial', 'kissterra'] }), true);
  assert.equal(hasReviewReleases({ ...complete, released_offer_ids: null }), true);
  assert.equal(hasReviewReleases(complete), true);
  assert.equal(hasReviewReleases({ status: 'queued', report_ready: false }), false);
  assert.equal(hasReviewReleases(undefined), false);
});

test('Manage and deletion agree for legacy, partial, timestamp-only, private and active reviews', () => {
  const cases = [
    { status: 'complete', report_ready: true, released_offer_ids: [], released: false, deletable: true },
    { status: 'complete', report_ready: true, released_offer_ids: ['kissterra'], released: true, deletable: false },
    { status: 'complete', report_ready: true, released_offer_ids: null, released: true, deletable: false },
    { status: 'complete', report_ready: true, released: true, deletable: false },
    { status: 'complete', report_ready: true, released_offer_ids: [], released_at: 0, released: true, deletable: false },
    { status: 'failed', report_ready: false, released_offer_ids: [], released: false, deletable: true },
    { status: 'failed', report_ready: false, released: false, deletable: true },
    { status: 'failed', report_ready: false, released_offer_ids: ['kissterra'], released: true, deletable: false },
    { status: 'queued', report_ready: true, released_offer_ids: [], released: false, deletable: false },
  ];
  for (const review of cases) {
    assert.equal(hasReviewReleases(review), review.released);
    assert.equal(isReviewDeletable(review), review.deletable);
    assert.equal(hasStoredReviewReleases({
      status: review.status, reportReady: review.report_ready,
      releasedOfferIds: review.released_offer_ids ?? undefined, releasedAt: review.released_at,
    }), review.released);
  }
});
const invoke = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, { secret, ...args });
function fixture() {
  const tables: Record<string, any[]> = {};
  let serial = 0;
  const db = {
    query(table: string) {
      const predicates: ((row: any) => boolean)[] = [];
      let descending = false;
      const index = { eq(key: string, value: unknown) { predicates.push(row => row[key] === value); return index; } };
      const rows = () => (tables[table] ?? []).filter(row => predicates.every(test => test(row))).sort((a, b) => (a._creationTime - b._creationTime) * (descending ? -1 : 1));
      const query = {
        withIndex(_name: string, configure?: (index: any) => void) { configure?.(index); return query; },
        order(order: string) { descending = order === 'desc'; return query; },
        async take(n: number) { return rows().slice(0, n); }, async collect() { return rows(); },
        async paginate(opts: any) { return { page: rows().slice(0, opts.numItems), isDone: true, continueCursor: '' }; },
        async unique() { const result = rows(); assert.ok(result.length < 2); return result[0] ?? null; }, async first() { return rows()[0] ?? null; },
      };
      return query;
    },
    async insert(table: string, value: any) { const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial }; (tables[table] ??= []).push(row); return row._id; },
    async patch(id: string, value: any) { const row = Object.values(tables).flat().find(row => row._id === id); assert.ok(row); Object.assign(row, value); },
    async replace(id: string, value: any) { const row = Object.values(tables).flat().find(row => row._id === id); assert.ok(row); const createdAt = row._creationTime; for (const key of Object.keys(row)) delete row[key]; Object.assign(row, value, { _id: id, _creationTime: createdAt }); },
    async delete(id: string) { for (const rows of Object.values(tables)) { const i = rows.findIndex(row => row._id === id); if (i >= 0) rows.splice(i, 1); } },
  };
  const ctx = { db, storage: { delete: async () => {} } } as any;
  async function add(jobId = 'creative', extra: any = {}) {
    const report = { offer_results: ['kissterra', 'smart-financial'].map(offerId => ({ offer_id: offerId, overall_status: 'green', summary: 'Checked', findings: [] })) };
    const id = await db.insert('reviews', { jobId, fileName: 'creative.mp4', status: 'complete', hasCreative: true, reportReady: true, offerIds: ['kissterra', 'smart-financial'], releasedOfferIds: [], report, createdAt: 1, updatedAt: 1, ...extra });
    const review = tables.reviews.find(row => row._id === id);
    await syncReviewOfferStats(ctx, review, 1);
    return review;
  }
  const releaseArgs = { jobIds: ['creative'], offerIds: ['smart-financial'], confirmed: true, releasedBy: 'admin' };
  return { ctx, tables, add, releaseArgs };
}

test('pending keeps the assessment, decisions override it, and reset restores it across review and batch responses', async () => {
  for (const assessment of ['green', 'yellow', 'red']) {
    const { ctx, tables, add } = fixture();
    await add('creative', { releasedOfferIds: undefined, batchId: 'batch', batchItemId: 'item', report: {
      offer_outcomes: ['kissterra', 'smart-financial'].map(offer_id => ({ offer_id, offer_name: offer_id, evaluation_state: 'evaluated', overall_status: assessment, message: '' })),
      offer_results: ['kissterra', 'smart-financial'].map(offer_id => ({ offer_id, overall_status: assessment, summary: 'Original assessment', findings: [] })),
    } });
    await ctx.db.insert('reviewBatches', { batchId: 'batch', createdAt: 1, updatedAt: 1, expectedCount: 1, notificationStatus: 'sent', items: [{
      itemId: 'item', jobId: 'creative', fileName: 'creative.mp4', mediaKind: 'video', status: 'complete', message: '',
      offerOutcomes: ['kissterra', 'smart-financial'].map(offerId => ({ offerId, offerName: offerId, evaluationState: 'evaluated', overallStatus: assessment, message: '' })),
    }] });
    const args = { clientId: 'kissterra', offerId: 'kissterra', jobId: 'creative' };
    for (const [decision, expected] of [[null, assessment], ['approved', 'green'], ['disapproved', 'red'], [null, assessment]]) {
      if (decision) await invoke(decide, ctx, { ...args, decision, feedbackReason: 'business_decision' });
      else await invoke(clearDecision, ctx, args);
      const [review] = await invoke(list, ctx, { ...args, limit: 100 });
      const detail = await invoke(getDetail, ctx, args);
      for (const value of [review, detail.review]) {
        assert.equal(value.aiStatus, assessment);
        assert.equal(value.effectiveStatus, expected);
        assert.equal(value.decision?.decision ?? null, decision);
      }
      const batch = await invoke(getBatch, ctx, { batchId: 'batch' });
      const [listedBatch] = await invoke(getBatches, ctx, { batchIds: ['batch'] });
      const status = await invoke(getStatus, ctx, { jobId: 'creative' });
      const report = await invoke(getAdminReport, ctx, { jobId: 'creative' });
      const [recent] = await invoke(listRecent, ctx, { limit: 100 });
      for (const value of [batch.items[0], listedBatch.items[0], status, report, recent]) {
        const result = value.offer_outcomes.find((outcome: any) => outcome.offer_id === 'kissterra');
        assert.equal(result.automated_status ?? result.overall_status, assessment);
        assert.equal(result.effective_status ?? result.overall_status, expected);
        assert.equal(result.overall_status, expected);
        assert.equal(result.client_decision ?? null, decision);
        assert.equal(value.offer_outcomes.find((outcome: any) => outcome.offer_id === 'smart-financial').overall_status, assessment);
      }
      assert.equal(tables.reviewBatches[0].items[0].offerOutcomes[0].overallStatus, assessment);
      assert.equal(tables.reviewOfferStats[0].resultStatus, assessment);
    }
  }
});

test('new jobs start private, including when their first update is already complete', async () => {
  const { ctx, tables } = fixture();
  await invoke(upsertStatus, ctx, { jobId: 'new', fileName: 'new.mp4', status: 'complete', progress: 100, reportReady: true, message: 'Complete', offerIds: ['kissterra'] });
  assert.deepEqual(tables.reviews[0].releasedOfferIds, []);
  assert.equal(tables.reviewOfferStats[0].withheld, true);
});

test('completion is private on advertiser list, detail, report, media and decisions', async () => {
  const { ctx, add } = fixture(); await add();
  const args = { clientId: 'kissterra', offerId: 'kissterra', jobId: 'creative' };
  assert.deepEqual(await invoke(list, ctx, { ...args, limit: 100 }), []);
  assert.equal(await invoke(getDetail, ctx, args), null);
  assert.equal(await invoke(getReport, ctx, args), null);
  assert.equal(await invoke(hasReview, ctx, args), false);
  await assert.rejects(invoke(decide, ctx, { ...args, decision: 'approved' }), /unavailable/);
  await assert.rejects(invoke(clearDecision, ctx, args), /unavailable/);
});

test('publisher can preview own private results but advertiser publisher filters and other publishers cannot', async () => {
  const { ctx, add } = fixture(); await add();
  await ctx.db.insert('publisherSubmissions', { clientId: 'kissterra', publisherId: 'owner', jobId: 'creative' });
  const args = { clientId: 'kissterra', offerId: 'kissterra', jobId: 'creative', publisherId: 'owner' };
  assert.deepEqual(await invoke(list, ctx, { ...args, limit: 100 }), []);
  assert.equal((await invoke(list, ctx, { ...args, limit: 100, previewPublisherId: 'owner' })).length, 1);
  assert.equal((await invoke(getDetail, ctx, { ...args, previewPublisherId: 'owner' })).review.jobId, 'creative');
  assert.equal(await invoke(hasReview, ctx, { ...args, previewPublisherId: 'owner' }), true);
  assert.equal(await invoke(getDetail, ctx, { ...args, previewPublisherId: 'other' }), null);
  assert.deepEqual(await invoke(listSubmissions, ctx, args), []);
  assert.equal((await invoke(listSubmissions, ctx, { ...args, previewPublisherId: 'owner' }))[0].released, false);
  await ctx.db.insert('publisherSubmissions', { clientId: 'kissterra', publisherId: 'owner', jobId: 'not-started' });
  assert.deepEqual(await invoke(listSubmissions, ctx, { clientId: 'kissterra' }), []);
});

test('release is confirmed, per-offer, additive, idempotent and blocks deletion', async () => {
  const { ctx, tables, add, releaseArgs } = fixture(); const review = await add();
  await assert.rejects(invoke(release, ctx, { ...releaseArgs, confirmed: false }), /Confirm/);
  assert.equal(review.releasedAt, undefined);
  await invoke(release, ctx, releaseArgs);
  assert.equal(await invoke(hasReview, ctx, { jobId: 'creative', offerId: 'smart-financial' }), true);
  assert.equal(await invoke(hasReview, ctx, { jobId: 'creative', offerId: 'kissterra' }), false);
  await assert.rejects(invoke(softDelete, ctx, { jobId: 'creative' }), /cannot be deleted/);
  assert.equal((await invoke(release, ctx, releaseArgs)).released, 0);
  assert.equal(tables.reviewReleaseEvents.length, 1);
  await invoke(release, ctx, { ...releaseArgs, offerIds: ['kissterra'] });
  assert.deepEqual(new Set(review.releasedOfferIds), new Set(['smart-financial', 'kissterra']));
  assert.equal(tables.reviewReleaseEvents.length, 2);
  await syncReviewOfferStats(ctx, review, 2);
  assert.ok(tables.reviewOfferStats.every(row => !row.withheld));
});

test('Convex rejects deletion without modifying released reviews, media or statistics', async () => {
  for (const extra of [
    { releasedOfferIds: undefined },
    { releasedOfferIds: ['smart-financial'] },
    { releasedOfferIds: [], releasedAt: 0 },
    { status: 'failed', releasedOfferIds: ['kissterra'] },
  ]) {
    const { ctx, tables, add } = fixture();
    const review = await add('protected', extra);
    await ctx.db.insert('reviewMedia', { jobId: review.jobId, storageId: 'media' });
    const before = structuredClone(tables);
    ctx.storage.delete = async () => assert.fail('Released media must not be deleted');
    await assert.rejects(invoke(softDelete, ctx, { jobId: review.jobId }), /Released reviews cannot be deleted/);
    assert.deepEqual(tables, before);
  }
});

test('private completed and failed reviews remain deletable, including legacy failures', async () => {
  for (const extra of [{}, { status: 'failed', reportReady: false }, { status: 'failed', reportReady: false, releasedOfferIds: undefined }]) {
    const { ctx, add } = fixture();
    const review = await add('private', extra);
    await invoke(softDelete, ctx, { jobId: review.jobId });
    assert.equal(typeof review.deletedAt, 'number');
  }
});

test('invalid, failed, deleted, unreviewed, unauthorized or foreign releases cannot write', async () => {
  const { ctx, add, releaseArgs, tables } = fixture(); const review = await add();
  for (const args of [{ secret: 'wrong' }, { confirmed: false }, { offerIds: ['acp'] }, { clientId: 'kissterra', publisherId: 'other' }]) {
    await assert.rejects(invoke(release, ctx, { ...releaseArgs, ...args }));
    assert.equal(review.releasedAt, undefined);
  }
  await ctx.db.insert('publisherSubmissions', { clientId: 'kissterra', publisherId: 'owner', jobId: 'creative' });
  await assert.rejects(invoke(release, ctx, { ...releaseArgs, clientId: 'kissterra', publisherId: 'owner' }), /Choose offers/);
  for (const patch of [{ status: 'failed' }, { status: 'queued' }, { status: 'complete', deletedAt: 1 }]) {
    Object.assign(review, patch);
    await assert.rejects(invoke(release, ctx, releaseArgs));
  }
  assert.equal(tables.reviewReleaseEvents, undefined);
});

test('batch selection checks completion, releases all eligible creatives, and skips failed items', async () => {
  const { ctx, add, releaseArgs } = fixture();
  await add('a', { batchId: 'batch' }); await add('b', { batchId: 'batch' }); await add('failed', { batchId: 'batch', status: 'failed' });
  const batch = { batchId: 'batch', expectedCount: 3, items: [{ status: 'complete' }, { status: 'queued' }, { status: 'failed' }] };
  await ctx.db.insert('reviewBatches', batch);
  await assert.rejects(invoke(getSelection, ctx, { batchId: 'batch' }), /Wait/);
  batch.items[1].status = 'complete';
  const preview = await invoke(getSelection, ctx, { batchId: 'batch' });
  assert.deepEqual(preview.job_ids, ['a', 'b']);
  assert.ok(preview.offers.every((offer: any) => offer.pending === 2));
  assert.equal((await invoke(release, ctx, { ...releaseArgs, jobIds: preview.job_ids })).released, 2);
});

test('batch responses include releases beyond the loaded history page and retain legacy visibility', async () => {
  const { ctx, add, releaseArgs } = fixture();
  await add('private', { batchId: 'batch', batchItemId: 'private' });
  await add('released', { batchId: 'batch', batchItemId: 'released' });
  // Older reviews may link to a batch item by job ID alone.
  await add('legacy', { batchId: 'batch', releasedOfferIds: undefined });
  await add('failed', { batchId: 'batch', batchItemId: 'failed', status: 'failed' });
  await ctx.db.insert('reviewBatches', {
    batchId: 'batch', createdAt: 1, updatedAt: 1, expectedCount: 4, notificationStatus: 'sent',
    items: ['private', 'released', 'legacy', 'failed'].map(jobId => ({
      itemId: jobId, jobId, fileName: `${jobId}.mp4`, mediaKind: 'video',
      status: jobId === 'failed' ? 'failed' : 'complete', message: '',
    })),
  });
  await invoke(release, ctx, { ...releaseArgs, jobIds: ['released'] });
  const single = await invoke(getBatch, ctx, { batchId: 'batch' });
  const [listed] = await invoke(getBatches, ctx, { batchIds: ['batch'] });
  for (const batch of [single, listed]) {
    assert.deepEqual(batch.items.map((item: any) => [item.job_id, item.has_releases]), [
      ['private', false], ['released', true], ['legacy', true], ['failed', false],
    ]);
  }
  assert.equal(hasReviewReleases({ status: 'complete', report_ready: true, released_offer_ids: [] }), false);
  assert.equal(listed.items.some((item: any) => item.has_releases), true);
  const loadedReviews = [{ status: 'complete', report_ready: true, released_offer_ids: [] }];
  assert.equal(hasBatchReleases(loadedReviews, listed), true);
  assert.deepEqual(deletableBatchReviewIds(loadedReviews, listed), []);
  assert.deepEqual(deletableBatchReviewIds(loadedReviews), []);
  const privateBatch = { items: listed.items.filter((item: any) => ['private', 'failed'].includes(item.job_id)) };
  assert.equal(hasBatchReleases(loadedReviews, privateBatch), false);
  assert.deepEqual(deletableBatchReviewIds(loadedReviews, privateBatch), ['private', 'failed']);
  // Fresh history release data must also protect against an older batch response.
  assert.deepEqual(deletableBatchReviewIds([{ status: 'complete', report_ready: true }], privateBatch), []);
});

test('API owners retain private previews while shared offer access is gated', async () => {
  const { ctx, add, releaseArgs } = fixture(); await add();
  await ctx.db.insert('apiPartners', { partnerId: 'partner', status: 'active', sharedReviewOfferIds: ['kissterra', 'smart-financial'] });
  const args = { partnerId: 'partner', jobId: 'creative', offerId: 'smart-financial' };
  assert.equal(await invoke(getAccessibleReview, ctx, args), null);
  assert.equal(await invoke(getSharedOfferReport, ctx, args), null);
  assert.deepEqual((await invoke(listSharedOfferReviews, ctx, { ...args, paginationOpts: { numItems: 100, cursor: null } })).page, []);
  await invoke(release, ctx, releaseArgs);
  assert.deepEqual((await invoke(getAccessibleReview, ctx, args)).accessible_offer_ids, ['smart-financial']);
  assert.equal((await invoke(listSharedOfferReviews, ctx, { ...args, paginationOpts: { numItems: 100, cursor: null } })).page.length, 1);
});

test('public links cannot publish private reviews and recalled offers disappear from existing links', async () => {
  const { ctx, add, releaseArgs, tables } = fixture(); await add();
  const args = { shareId: 'share', tokenHash: 'token', ownerKey: 'admin', title: 'Review', expiresAt: Date.now() + 10000, items: [{ jobId: 'creative', offerId: 'smart-financial' }] };
  await assert.rejects(invoke(createShare, ctx, args), /available/);
  await invoke(release, ctx, releaseArgs); await invoke(createShare, ctx, args);
  assert.equal((await invoke(getShare, ctx, { tokenHash: 'token' })).items.length, 1);
  tables.reviewOfferStats.find(row => row.offerId === 'smart-financial').withheld = true;
  assert.equal(await invoke(getShare, ctx, { tokenHash: 'token' }), null);
});

test('private deletion hides all offers, while legacy advertiser visibility is protected', async () => {
  const { ctx, add } = fixture(); await add();
  await invoke(softDelete, ctx, { jobId: 'creative' });
  await assert.rejects(invoke(release, ctx, { jobIds: ['creative'], offerIds: ['kissterra'], confirmed: true, releasedBy: 'admin' }), /unavailable/);
  const legacy = await add('legacy', { releasedOfferIds: undefined });
  assert.equal(await invoke(hasReview, ctx, { jobId: 'legacy', offerId: 'kissterra' }), true);
  assert.equal((await invoke(getSelection, ctx, { jobIds: ['legacy'] })).offers[0].pending, 0);
  await assert.rejects(invoke(softDelete, ctx, { jobId: legacy.jobId }), /Released reviews cannot be deleted/);
  assert.equal(await invoke(hasReview, ctx, { jobId: legacy.jobId, offerId: 'kissterra' }), true);
});

test('SmartFinancial repair matches only the verified batch and survives projection refresh', async () => {
  const { ctx, add, tables } = fixture();
  await assert.rejects(invoke(restrictSmartFinancialAutoBatch, ctx), /verified repair target/);
  for (const fileName of ['SFI_IM_EN_AUTO_0001.jpeg', 'SFI_VD_EN_AUTO_0004.mp4', 'SFI_VD_EN_AUTO_0005.mp4']) {
    await add(fileName, { fileName, batchId: '676aee6dedc94bf0be11f0eeff8e297b', releasedOfferIds: undefined });
  }
  await add('unrelated', { releasedOfferIds: undefined });
  await invoke(restrictSmartFinancialAutoBatch, ctx);
  await invoke(restrictSmartFinancialAutoBatch, ctx);
  assert.equal(tables.reviewReleaseEvents.length, 3);
  for (const row of tables.reviews.filter(row => row.batchId)) {
    await syncReviewOfferStats(ctx, row, 2);
    assert.equal(await invoke(hasReview, ctx, { jobId: row.jobId, offerId: 'kissterra' }), false);
    assert.equal(await invoke(hasReview, ctx, { jobId: row.jobId, offerId: 'smart-financial' }), true);
  }
  assert.equal(await invoke(hasReview, ctx, { jobId: 'unrelated', offerId: 'kissterra' }), true);
});

test('an API owner can still inspect a private job, while deleted jobs expose no result preview', async () => {
  const { ctx, add } = fixture(); await add('owned');
  await ctx.db.insert('apiPartners', { partnerId: 'owner', status: 'active' });
  await ctx.db.insert('apiReviewLinks', { jobId: 'owned', partnerId: 'owner', status: 'complete', fileName: 'owned.mp4', createdAt: 1, updatedAt: 1 });
  const args = { partnerId: 'owner', jobId: 'owned' };
  assert.equal((await invoke(getAccessibleReview, ctx, args)).report_ready, true);
  await invoke(softDelete, ctx, { jobId: 'owned' });
  const deleted = await invoke(getAccessibleReview, ctx, args);
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.report_ready, false);
  assert.equal(deleted.summary, null);
  assert.equal(deleted.thumbnail_url, null);
});
