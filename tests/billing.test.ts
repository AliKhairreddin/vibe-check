import assert from 'node:assert/strict';
import test from 'node:test';
import Stripe from 'stripe';
import { accessAllowed, billingReady, subscriptionSnapshot } from '../convex/billingPolicy.ts';
import { beginCheckout, claimSync, completeSync, grandfatherExisting, receiveEvent, requestSync, requireBillingAccess } from '../convex/billing.ts';
import { create, acceptInvite, resetInvite } from '../convex/advertiserAccounts.ts';
import { claimSubmission } from '../convex/workspaces.ts';
import http from '../convex/http.ts';

process.env.CONVEX_HTTP_SECRET = 'billing-test-secret';
process.env.STRIPE_SECRET_KEY = 'sk_live_test_fixture';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fixture';
process.env.STRIPE_BILLING_MODE = 'live';
process.env.STRIPE_PRICE_STARTER_MONTH = 'price_starter';
const invoke = (fn: any, ctx: any, args: any = {}) => fn._handler(ctx, args);
function fixture() {
  const tables: Record<string, any[]> = {};
  const queryCounts: Record<string, number> = {};
  let serial = 0;
  const db = {
    query(table: string) {
      queryCounts[table] = (queryCounts[table] ?? 0) + 1;
      const predicates: ((row: any) => boolean)[] = [];
      let descending = false;
      const index = { eq(key: string, value: unknown) { predicates.push(r => r[key] === value); return index; }, gte(key: string, value: number) { predicates.push(r => r[key] >= value); return index; }, lte(key: string, value: number) { predicates.push(r => r[key] <= value); return index; }, lt(key: string, value: number) { predicates.push(r => r[key] < value); return index; } };
      const rows = () => (tables[table] ?? []).filter(row => predicates.every(test => test(row))).sort((a, b) => (a._creationTime - b._creationTime) * (descending ? -1 : 1));
      const query = {
        withIndex(_name: string, configure?: (index: any) => void) { configure?.(index); return query; },
        order(order: string) { descending = order === 'desc'; return query; },
        async take(n: number) { return rows().slice(0, n); },
        async collect() { return rows(); },
        async paginate(opts: any) {
          const start = Number(opts.cursor ?? 0);
          const page = rows().slice(start, start + opts.numItems);
          return { page, isDone: start + page.length >= rows().length, continueCursor: String(start + page.length) };
        },
        async unique() { const result = rows(); assert.ok(result.length < 2); return result[0] ?? null; },
        async first() { return rows()[0] ?? null; },
      };
      return query;
    },
    async insert(table: string, value: any) { const row = { ...value, _id: `${table}:${++serial}`, _creationTime: serial }; (tables[table] ??= []).push(row); return row._id; },
    async patch(id: string, value: any) { const row = Object.values(tables).flat().find(row => row._id === id); assert.ok(row); Object.assign(row, value); },
    async delete(id: string) { for (const rows of Object.values(tables)) { const i = rows.findIndex(row => row._id === id); if (i >= 0) rows.splice(i, 1); } },
  };
  const scheduled: any[] = [];
  return { ctx: { db, scheduler: { async runAfter(...args: any[]) { scheduled.push(args); } } }, tables, queryCounts, scheduled };
}

async function seed(ctx: any, extra = {}) {
  return ctx.db.insert('billingWorkspaces', { clientId: 'new-advertiser', accessMode: 'subscription', isTest: false, createdAt: Date.now(), status: 'none', nextSyncAt: 0, revision: 0, ...extra });
}
function subscription(extra = {}): any {
  return { id: 'sub_one', created: 1, livemode: true, status: 'active', managed_payments: { enabled: true }, pause_collection: null, cancel_at_period_end: false,
    latest_invoice: { status: 'paid' }, items: { data: [{ quantity: 1, current_period_end: Math.floor(Date.now()/1000) + 86400, price: { id: 'price_starter' } }] }, ...extra };
}

test('only the explicit existing cohort keeps free access, independent of Stripe', async () => {
  const { ctx, tables } = fixture();
  assert.equal(accessAllowed(null, 'kissterra'), true);
  assert.equal(accessAllowed(null, 'new-advertiser'), false);
  assert.equal(accessAllowed({ accessMode: 'grandfathered', status: 'exempt' }, 'unlisted'), false);
  await invoke(grandfatherExisting, ctx);
  await invoke(grandfatherExisting, ctx);
  assert.equal(tables.billingWorkspaces.length, 4);
  assert.ok(tables.billingWorkspaces.every(r => r.accessMode === 'grandfathered' && !r.customerId));
  await requireBillingAccess(ctx as any, 'kissterra');
  await assert.rejects(requireBillingAccess(ctx as any, 'new-advertiser'), /paid subscription/);
  await ctx.db.insert('publishers', { clientId: 'new-advertiser', publisherId: 'pub', status: 'active' });
  await assert.rejects(invoke(claimSubmission, ctx, { secret: 'billing-test-secret', clientId: 'new-advertiser', publisherId: 'pub', jobId: 'new' }), /paid subscription/);
});

test('paid invoice, supported managed plan, environment, and subscription lifecycle determine access', () => {
  const active = subscriptionSnapshot([subscription()], false);
  assert.equal(accessAllowed({ ...active, accessMode: 'subscription' }, 'new'), true);
  for (const status of ['incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'paused', 'canceled', 'trialing']) {
    const snapshot = subscriptionSnapshot([subscription({ status })], false);
    assert.equal(accessAllowed({ ...snapshot, accessMode: 'subscription' }, 'new'), false, status);
  }
  for (const patch of [{ latest_invoice: { status: 'open' } }, { latest_invoice: 'in_not_expanded' }, { managed_payments: null }, { pause_collection: { behavior: 'void' } }, { livemode: false }, { items: { data: [{ quantity: 2, current_period_end: 9999999999, price: { id: 'price_starter' } }] } }]) {
    assert.equal(accessAllowed({ ...subscriptionSnapshot([subscription(patch)], false), accessMode: 'subscription' }, 'new'), false);
  }
  assert.equal(accessAllowed({ ...active, accessMode: 'subscription', paidThrough: Date.now() - 1 }, 'new'), false);
  assert.equal(subscriptionSnapshot([subscription({ cancel_at_period_end: true })], false).paidThrough > Date.now(), true);
  assert.throws(() => subscriptionSnapshot([subscription(), subscription({ id: 'sub_two' })], false), /Multiple/);
  assert.equal(billingReady(false), true);
  assert.equal(billingReady(true), false);
});

test('checkout is serialized, reuses one attempt, and cannot enroll exempt or wrong-mode workspaces', async () => {
  const { ctx, tables } = fixture();
  await seed(ctx);
  const request = { clientId: 'new-advertiser', priceId: 'price_starter', attempt: 'attempt-one' };
  const first = await invoke(beginCheckout, ctx, request);
  await assert.rejects(invoke(beginCheckout, ctx, request), /being prepared/);
  tables.billingWorkspaces[0].checkoutLeaseUntil = 0;
  const retry = await invoke(beginCheckout, ctx, { ...request, attempt: 'attempt-two' });
  assert.equal(retry.checkoutAttempt, first.checkoutAttempt);
  tables.billingWorkspaces[0].checkoutLeaseUntil = 0;
  await assert.rejects(invoke(beginCheckout, ctx, { ...request, priceId: 'different' }), /open checkout/);
  tables.billingWorkspaces[0].isTest = true;
  await assert.rejects(invoke(beginCheckout, ctx, request), /not available/);
  await invoke(grandfatherExisting, ctx);
  await assert.rejects(invoke(beginCheckout, ctx, { ...request, clientId: 'kissterra' }), /does not need/);
});

test('webhook deduplication, environment isolation, leases, and stale reads preserve correct access', async () => {
  const { ctx, tables, scheduled } = fixture();
  await seed(ctx, { customerId: 'cus_one' });
  const event = { eventId: 'evt_one', customerId: 'cus_one', livemode: true, deleted: false };
  await invoke(receiveEvent, ctx, { ...event, livemode: false });
  assert.equal(scheduled.length, 0);
  await invoke(receiveEvent, ctx, event);
  await invoke(receiveEvent, ctx, event);
  assert.equal(scheduled.length, 1);
  const claimed = await invoke(claimSync, ctx, { clientId: 'new-advertiser', lease: 'lease-one' });
  assert.ok(claimed);
  assert.equal(await invoke(claimSync, ctx, { clientId: 'new-advertiser', lease: 'lease-two' }), null);
  const revision = claimed.revision;
  await invoke(receiveEvent, ctx, { ...event, eventId: 'evt_two' });
  await invoke(completeSync, ctx, { clientId: 'new-advertiser', lease: 'lease-one', revision, snapshot: subscriptionSnapshot([subscription()], false) });
  assert.equal(tables.billingWorkspaces[0].status, 'none', 'event during provider read invalidates that read');
  tables.billingWorkspaces[0].nextSyncAt = 0;
  const current = await invoke(claimSync, ctx, { clientId: 'new-advertiser', lease: 'lease-new' });
  await invoke(completeSync, ctx, { clientId: 'new-advertiser', lease: 'lease-new', revision: current.revision, snapshot: subscriptionSnapshot([subscription()], false) });
  assert.equal(tables.billingWorkspaces[0].status, 'active');
  assert.equal(tables.advertiserPlans[0].monthlyReviewLimit, 250);
  const paidThrough = tables.billingWorkspaces[0].paidThrough;
  tables.billingWorkspaces[0].nextSyncAt = 0;
  await invoke(claimSync, ctx, { clientId: 'new-advertiser', lease: 'lease-error' });
  await invoke(completeSync, ctx, { clientId: 'new-advertiser', lease: 'lease-error', revision: current.revision, error: true });
  assert.equal(tables.billingWorkspaces[0].paidThrough, paidThrough);
  assert.equal(tables.billingWorkspaces[0].syncError, true);
  await invoke(receiveEvent, ctx, { ...event, eventId: 'evt_deleted', deleted: true });
  assert.equal(tables.billingWorkspaces[0].paidThrough, 0);
  assert.equal(tables.billingWorkspaces[0].customerId, undefined);
});

test('advertiser invitations require an owned configured offer and never grant free access', async () => {
  const { ctx, tables } = fixture();
  const args = { secret: 'billing-test-secret', clientId: 'new-advertiser', category: 'Advertising', inviteHash: 'hash' };
  await assert.rejects(invoke(create, ctx, args), /guidelines first/);
  await ctx.db.insert('offerProfiles', { offerId: args.clientId, displayName: 'New advertiser', enabled: true, officialGuidelines: 'Guidelines' });
  await invoke(create, ctx, args);
  assert.equal(tables.billingWorkspaces[0].accessMode, 'subscription');
  assert.equal(tables.billingWorkspaces[0].isTest, false);
  assert.equal(accessAllowed(tables.billingWorkspaces[0], args.clientId), false);
  await assert.rejects(invoke(create, ctx, args), /already exists/);
  await invoke(acceptInvite, ctx, { secret: args.secret, inviteHash: 'hash', passwordHash: 'one-way-hash' });
  assert.equal(tables.advertiserAccounts[0].status, 'active');
  assert.equal(accessAllowed(tables.billingWorkspaces[0], args.clientId), false);
  await assert.rejects(invoke(acceptInvite, ctx, { secret: args.secret, inviteHash: 'hash', passwordHash: 'another' }), /expired/);
  await invoke(resetInvite, ctx, { secret: args.secret, clientId: args.clientId, inviteHash: 'reset' });
  tables.advertiserAccounts[0].inviteExpiresAt = 0;
  await assert.rejects(invoke(acceptInvite, ctx, { secret: args.secret, inviteHash: 'reset', passwordHash: 'another' }), /expired/);
});

test('HTTP webhook requires a valid recent raw-body signature and the correct environment', async () => {
  const handler: any = http.lookup('/stripe/webhook', 'POST')![0];
  const stripe = new Stripe('sk_test_fixture');
  const payload = JSON.stringify({ id: 'evt_signed', type: 'invoice.paid', livemode: true, data: { object: { customer: 'cus_one' } } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  let writes = 0;
  const ctx = { runMutation: async () => { writes++; } };
  const send = (body: string, signature: string) => handler._handler(ctx, new Request('https://example.convex.site/stripe/webhook', { method: 'POST', body, headers: { 'stripe-signature': signature } }));
  assert.equal((await send(payload, header)).status, 200);
  assert.equal(writes, 1);
  assert.equal((await send(payload + ' ', header)).status, 400);
  const old = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET!, timestamp: Math.floor(Date.now()/1000)-600 });
  assert.equal((await send(payload, old)).status, 400);
  const sandbox = payload.replace('true', 'false');
  assert.equal((await send(sandbox, stripe.webhooks.generateTestHeaderString({ payload: sandbox, secret: process.env.STRIPE_WEBHOOK_SECRET! }))).status, 400);
  assert.equal(writes, 1);
});


test('manual refresh remains bounded when Stripe is failing', async () => {
  const { ctx, scheduled } = fixture();
  await seed(ctx, { customerId: 'cus_one', syncError: true, syncedAt: 0 });
  await invoke(requestSync, ctx, { secret: 'billing-test-secret', clientId: 'new-advertiser' });
  await invoke(requestSync, ctx, { secret: 'billing-test-secret', clientId: 'new-advertiser' });
  assert.equal(scheduled.length, 1);
});
