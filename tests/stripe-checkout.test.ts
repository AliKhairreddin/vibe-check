import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { getFunctionName } from 'convex/server';
import { checkout } from '../convex/stripeBilling.ts';

process.env.CONVEX_HTTP_SECRET = 'checkout-fixture-secret';
process.env.STRIPE_SECRET_KEY = 'rk_live_checkout_fixture';
for (const plan of ['starter', 'growth']) for (const interval of ['month', 'year']) {
  process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`] = `price_${plan}_${interval}`;
}

function fixture(t: TestContext, options: { open?: boolean; subscribed?: boolean; failOnce?: boolean } = {}) {
  const row: any = { _id: 'workspace-row', clientId: 'workspace-public-signup', isTest: false, checkoutAttempt: 'saved-attempt', checkoutExpiresAt: Date.now() + 35 * 60 * 1000 };
  if (options.open) Object.assign(row, { customerId: 'cus_workspace', checkoutId: 'cs_live_open' });
  const requests: { path: string; body: URLSearchParams; headers: Headers }[] = [];
  const mutations: string[] = [];
  let fail = options.failOnce;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname;
    const body = new URLSearchParams(String(init.body ?? ''));
    requests.push({ path, body, headers: new Headers(init.headers) });
    let data: unknown;
    if (path === '/v1/customers') data = { id: 'cus_workspace', livemode: true };
    else if (path === '/v1/subscriptions') data = { data: options.subscribed ? [{ status: 'active' }] : [], has_more: false };
    else if (path.startsWith('/v1/prices/')) {
      const [, plan, interval] = path.split('/').at(-1)!.split('_');
      data = { active: true, livemode: true, currency: 'usd', unit_amount: (plan === 'starter' ? 59900 : 199900) * (interval === 'year' ? 10 : 1), recurring: { interval, interval_count: 1 }, tax_behavior: 'exclusive' };
    } else if (path === '/v1/checkout/sessions/cs_live_open') data = { status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_live_open' };
    else if (path === '/v1/checkout/sessions') {
      if (fail) { fail = false; return Response.json({ error: { type: 'invalid_request_error', message: 'Checkout temporarily unavailable' } }, { status: 400 }); }
      data = { id: 'cs_live_created', livemode: true, url: 'https://checkout.stripe.com/c/pay/cs_live_created' };
    } else throw new Error(`Unexpected Stripe request: ${path}`);
    return Response.json(data);
  });
  const ctx = { async runMutation(ref: any, args: any) {
    const name = getFunctionName(ref);
    mutations.push(name);
    if (name === 'billing:beginCheckout') return { ...row };
    if (name === 'billing:saveCustomer') row.customerId = args.customerId;
    if (name === 'billing:finishCheckout' && args.checkoutId) row.checkoutId = args.checkoutId;
    return null;
  } };
  const run = (plan = 'starter', interval = 'month') => (checkout as any)._handler(ctx, { secret: 'checkout-fixture-secret', clientId: row.clientId, plan, interval });
  return { run, row, requests, mutations };
}

test('public plan choices create workspace-bound Managed Payments checkout with correct prices and return selection', async t => {
  const f = fixture(t);
  for (const plan of ['starter', 'growth']) for (const interval of ['month', 'year']) {
    delete f.row.checkoutId;
    await f.run(plan, interval);
    const params = f.requests.at(-1)!.body;
    assert.equal(params.get('customer'), 'cus_workspace');
    assert.equal(params.get('client_reference_id'), f.row.clientId);
    assert.equal(params.get('line_items[0][price]'), `price_${plan}_${interval}`);
    assert.equal(params.get('line_items[0][quantity]'), '1');
    assert.equal(params.get('mode'), 'subscription');
    assert.equal(params.get('managed_payments[enabled]'), 'true');
    assert.equal(params.has('payment_method_types[0]'), false);
    assert.match(params.get('integration_identifier')!, /^adchecked-subscriptions-[a-z]{8}$/);
    const cancel = new URL(params.get('cancel_url')!);
    assert.equal(cancel.origin, 'https://app.adchecked.com');
    assert.equal(cancel.pathname, '/client/plan');
    assert.equal(cancel.searchParams.get('plan'), plan);
    assert.equal(cancel.searchParams.get('interval'), interval);
  }
  assert.equal(f.requests.filter(r => r.path === '/v1/customers').length, 1);
});

test('checkout failure retains the customer and retries the same idempotent attempt', async t => {
  const f = fixture(t, { failOnce: true });
  await assert.rejects(f.run(), /temporarily unavailable/);
  assert.equal(f.mutations.at(-1), 'billing:finishCheckout', 'release checkout lease after failure');
  assert.equal((await f.run()).url, 'https://checkout.stripe.com/c/pay/cs_live_created');
  assert.equal(f.requests.filter(r => r.path === '/v1/customers').length, 1);
  const attempts = f.requests.filter(r => r.path === '/v1/checkout/sessions');
  assert.equal(attempts[0].headers.get('idempotency-key'), attempts[1].headers.get('idempotency-key'));
});

test('retry reuses an open checkout and an existing subscription prevents another checkout', async t => {
  const f = fixture(t, { open: true });
  assert.equal((await f.run()).url, 'https://checkout.stripe.com/c/pay/cs_live_open');
  assert.equal(f.requests.some(r => r.path === '/v1/checkout/sessions'), false);
  t.mock.restoreAll();
  const paid = fixture(t, { subscribed: true });
  await assert.rejects(paid.run(), /existing subscription/);
  assert.ok(paid.mutations.includes('billing:requestSync'));
  assert.equal(paid.requests.some(r => r.path === '/v1/checkout/sessions'), false);
});
