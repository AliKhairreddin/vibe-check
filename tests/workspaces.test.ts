import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptInvite, claimSubmission, createShare, getShare, invitePublisher, revokeShare, setupDigitalNudge, digitalNudgeMemberships, setPlan, releaseUnstartedSubmission } from '../convex/workspaces.ts';
import { attributeInternalReview } from '../convex/publisherOwnership.ts';
import { recordHeartbeat } from '../convex/platform.ts';
import { apiRequestAllowed, isClientPagePath, isAdminPagePath } from '../worker/routing.ts';

process.env.CONVEX_HTTP_SECRET = 'workspace-test-secret';
const invoke = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, { secret: 'workspace-test-secret', ...args });
function fixture() {
  const tables: Record<string, any[]> = {};
  let serial = 0;
  const db = {
    query(table: string) {
      const predicates: ((row: any) => boolean)[] = [];
      let descending = false;
      const index = { eq(key: string, value: unknown) { predicates.push(r => r[key] === value); return index; }, gte(key: string, value: number) { predicates.push(r => r[key] >= value); return index; }, lt(key: string, value: number) { predicates.push(r => r[key] < value); return index; } };
      const rows = () => (tables[table] ?? []).filter(row => predicates.every(test => test(row))).sort((a, b) => (a._creationTime - b._creationTime) * (descending ? -1 : 1));
      const query = { withIndex(_name: string, configure: (index: any) => void) { configure(index); return query; }, order(order: string) { descending = order === 'desc'; return query; }, async take(n: number) { return rows().slice(0, n); }, async unique() { const result = rows(); assert.ok(result.length < 2); return result[0] ?? null; }, async first() { return rows()[0] ?? null; } };
      return query;
    },
    async insert(table: string, value: any) { const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial }; (tables[table] ??= []).push(row); return row._id; },
    async patch(id: string, value: any) { const row = Object.values(tables).flat().find(row => row._id === id); assert.ok(row); Object.assign(row, value); },
    async delete(id: string) { for (const rows of Object.values(tables)) { const i = rows.findIndex(row => row._id === id); if (i >= 0) rows.splice(i, 1); } },
  };
  return { ctx: { db }, tables };
}
async function seedPublisher(ctx: any, clientId = 'kissterra', publisherId = 'banana') {
  await ctx.db.insert('publishers', { clientId, publisherId, username: publisherId, name: 'Banana', status: 'active', authVersion: 1, createdAt: Date.now() });
}

test('invitations are single use, expire, and reject cross-advertiser resets', async () => {
  const { ctx, tables } = fixture();
  const args = { clientId: 'kissterra', publisherId: 'banana', username: 'banana', name: 'Banana', inviteHash: 'one-way-token-hash' };
  await invoke(invitePublisher, ctx, args);
  await assert.rejects(invoke(invitePublisher, ctx, { ...args, clientId: 'smart-financial' }));
  await invoke(acceptInvite, ctx, { inviteHash: args.inviteHash, passwordHash: 'salted-password-hash' });
  assert.equal(tables.publishers[0].status, 'active');
  assert.equal(tables.publishers[0].inviteHash, undefined);
  await assert.rejects(invoke(acceptInvite, ctx, { inviteHash: args.inviteHash, passwordHash: 'new' }));
  await invoke(invitePublisher, ctx, { ...args, inviteHash: 'expired' });
  tables.publishers[0].inviteExpiresAt = Date.now() - 1;
  await assert.rejects(invoke(acceptInvite, ctx, { inviteHash: 'expired', passwordHash: 'new' }));
});

test('publisher and monthly allowances are enforced and submission reservations are idempotent', async () => {
  const { ctx, tables } = fixture();
  await invoke(setPlan, ctx, { clientId: 'kissterra', plan: 'enterprise', publisherLimit: 1, monthlyReviewLimit: 1 });
  await seedPublisher(ctx);
  await assert.rejects(invoke(invitePublisher, ctx, { clientId: 'kissterra', publisherId: 'extra', name: 'Extra', username: 'extra', inviteHash: 'hash' }), /limit reached/);
  const args = { clientId: 'kissterra', publisherId: 'banana', jobId: 'review-one' };
  await invoke(claimSubmission, ctx, args);
  await invoke(claimSubmission, ctx, args);
  assert.equal(tables.publisherSubmissions.length, 1);
  await assert.rejects(invoke(claimSubmission, ctx, { ...args, jobId: 'review-two' }), /allowance reached/);
  await assert.rejects(invoke(claimSubmission, ctx, { ...args, clientId: 'smart-financial' }));
  tables.publisherSubmissions[0].createdAt = 1;
  await invoke(claimSubmission, ctx, { ...args, jobId: 'review-new-month' });
  assert.equal(tables.publisherSubmissions.length, 2);
  await invoke(releaseUnstartedSubmission, ctx, { ...args, jobId: 'review-new-month', publisherId: 'other' });
  assert.equal(tables.publisherSubmissions.length, 2);
  await invoke(releaseUnstartedSubmission, ctx, { ...args, jobId: 'review-new-month' });
  assert.equal(tables.publisherSubmissions.length, 1);
  await ctx.db.insert('reviews', { jobId: 'review-one', status: 'queued' });
  await invoke(releaseUnstartedSubmission, ctx, args);
  assert.equal(tables.publisherSubmissions.length, 1);
});

test('Digital Nudge attribution supports one creative across advertisers without replacing another publisher', async () => {
  const { ctx, tables } = fixture();
  await invoke(setupDigitalNudge, ctx, { inviteHash: 'setup' });
  assert.equal(tables.publishers.length, 4);
  await invoke(acceptInvite, ctx, { inviteHash: 'setup', passwordHash: 'password' });
  assert.equal((await invoke(digitalNudgeMemberships, ctx)).length, 4);
  await attributeInternalReview(ctx, 'kissterra', 'shared-job', Date.now());
  await attributeInternalReview(ctx, 'smart-financial', 'shared-job', Date.now());
  await attributeInternalReview(ctx, 'kissterra', 'shared-job', Date.now());
  assert.equal(tables.publisherSubmissions.length, 2);
  assert.ok(tables.publisherSubmissions.every(row => row.countsTowardUsage === false));
  await seedPublisher(ctx);
  await invoke(claimSubmission, ctx, { clientId: 'kissterra', publisherId: 'banana', jobId: 'banana-job' });
  await attributeInternalReview(ctx, 'kissterra', 'banana-job', Date.now());
  assert.equal(tables.publisherSubmissions.find(row => row.jobId === 'banana-job').publisherId, 'banana');
  await ctx.db.insert('apiReviewLinks', { jobId: 'api-job', partnerId: 'other-company' });
  await attributeInternalReview(ctx, 'kissterra', 'api-job', Date.now());
  assert.ok(!tables.publisherSubmissions.some(row => row.jobId === 'api-job'));
  await assert.rejects(invoke(invitePublisher, ctx, { clientId: 'kissterra', publisherId: 'digital-nudge-kissterra', name: 'Digital Nudge', username: 'digital-nudge', inviteHash: 'takeover' }), /managed/);
});

test('shares cannot contain foreign publisher jobs or incomplete reviews, and revocation is owner-scoped', async () => {
  const { ctx, tables } = fixture();
  await ctx.db.insert('reviews', { jobId: 'creative', status: 'complete' });
  await ctx.db.insert('reviewOfferStats', { jobId: 'creative', offerId: 'kissterra', status: 'complete' });
  await ctx.db.insert('publisherSubmissions', { jobId: 'creative', clientId: 'kissterra', publisherId: 'banana' });
  const args = { shareId: 's', tokenHash: 'hashed-token', ownerKey: 'publisher:banana', clientId: 'kissterra', publisherId: 'banana', title: 'Selected', expiresAt: Date.now() + 10000, items: [{ jobId: 'creative', offerId: 'kissterra' }] };
  await assert.rejects(invoke(createShare, ctx, { ...args, publisherId: 'other' }));
  tables.reviewOfferStats[0].status = 'queued';
  await assert.rejects(invoke(createShare, ctx, args));
  tables.reviewOfferStats[0].status = 'complete';
  await invoke(createShare, ctx, args);
  assert.ok(await invoke(getShare, ctx, { tokenHash: 'hashed-token' }));
  await assert.rejects(invoke(revokeShare, ctx, { shareId: 's', ownerKey: 'publisher:other' }));
  await assert.rejects(invoke(revokeShare, ctx, { shareId: 's', ownerKey: 'client:other', clientId: 'other' }));
  await invoke(revokeShare, ctx, { shareId: 's', ownerKey: 'client:kissterra', clientId: 'kissterra' });
  assert.equal(await invoke(getShare, ctx, { tokenHash: 'hashed-token' }), null);
  tables.publicShares[0].revokedAt = undefined;
  tables.publicShares[0].expiresAt = Date.now() - 1;
  assert.equal(await invoke(getShare, ctx, { tokenHash: 'hashed-token' }), null);
});

test('platform heartbeats aggregate counter deltas without double-counting repeated samples', async () => {
  const { ctx, tables } = fixture();
  const args = { instanceId: 'one', startedAt: 1, requests: 10, errors: 2, active: 1, pending: 2, workers: 4 };
  await invoke(recordHeartbeat, ctx, args);
  await invoke(recordHeartbeat, ctx, args);
  await invoke(recordHeartbeat, ctx, { ...args, requests: 15, errors: 3 });
  assert.equal(tables.platformTrafficHours[0].requests, 15);
  assert.equal(tables.platformTrafficHours[0].errors, 3);
  await invoke(recordHeartbeat, ctx, { ...args, instanceId: 'two', requests: 4, errors: 0 });
  assert.equal(tables.platformTrafficHours[0].requests, 19);
  await assert.rejects(invoke(recordHeartbeat, ctx, { ...args, secret: 'wrong' }));
});

test('public shares and publisher pages route only through allowed application surfaces', () => {
  assert.ok(apiRequestAllowed('client', '/api/public/shares/token'));
  assert.ok(apiRequestAllowed('client', '/api/client/kissterra/uploads'));
  assert.equal(apiRequestAllowed('client', '/api/admin/platform'), false);
  assert.equal(apiRequestAllowed('public', '/api/public/shares/token'), false);
  assert.equal(apiRequestAllowed('api', '/api/public/shares/token'), false);
  assert.ok(isClientPagePath('/share/token'));
  assert.ok(isClientPagePath('/invite/token'));
  assert.ok(isAdminPagePath('/publisher'));
  assert.ok(isAdminPagePath('/shares'));
});
