import Stripe from 'stripe';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action, internalAction, type ActionCtx } from './_generated/server.js';
import { authorizeBilling } from './billing.ts';
import { billingInterval, billingReady, configuredPrices, paidPlan, subscriptionSnapshot } from './billingPolicy.ts';
import type { Doc } from './_generated/dataModel';

const ref = <T extends 'query' | 'mutation'>(kind: T, name: string) => makeFunctionReference<T>(`billing:${name}`);
export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Live billing is not available yet. Contact AdChecked.');
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2, timeout: 20000 });
}
const APP_URL = 'https://app.adchecked.com/client/plan';

export const checkout = action({
  args: { secret: v.string(), clientId: v.string(), plan: paidPlan, interval: billingInterval }, returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    authorizeBilling(args.secret);
    const mapping = configuredPrices().find(p => p.plan === args.plan && p.interval === args.interval);
    if (!mapping || args.plan === 'enterprise') throw new Error('Contact AdChecked to arrange this plan.');
    const row: Doc<'billingWorkspaces'> = await ctx.runMutation(ref('mutation', 'beginCheckout'), { clientId: args.clientId, priceId: mapping.priceId, attempt: crypto.randomUUID() });
    const attempt = row.checkoutAttempt!;
    const stripe = stripeClient();
    try {
      let customerId = row.customerId;
      if (!customerId) {
        // One idempotent customer per workspace, even after network failures.
        const customer = await stripe.customers.create({ metadata: { adchecked_workspace: args.clientId } }, { idempotencyKey: `adchecked-customer-${row._id}-${row.customerGeneration ?? 0}` });
        if (customer.livemode === row.isTest) throw new Error('Stripe environment mismatch');
        customerId = customer.id;
        await ctx.runMutation(ref('mutation', 'saveCustomer'), { clientId: args.clientId, customerId, attempt });
      }
      const existing = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
      if (existing.has_more || existing.data.some(s => !['canceled', 'incomplete_expired'].includes(s.status))) {
        await ctx.runMutation(ref('mutation', 'requestSync'), { secret: args.secret, clientId: args.clientId });
        throw new Error('Manage your existing subscription instead of starting another.');
      }
      if (row.checkoutId) {
        const previous = await stripe.checkout.sessions.retrieve(row.checkoutId);
        if (previous.status === 'open' && previous.url) return { url: previous.url };
        throw new Error('Checkout has finished. Refresh billing status before trying again.');
      }
      const price = await stripe.prices.retrieve(mapping.priceId);
      const expectedAmount = args.plan === 'starter' ? args.interval === 'year' ? 599000 : 59900 : args.interval === 'year' ? 1999000 : 199900;
      if (!price.active || price.livemode === row.isTest || price.currency !== 'usd' || price.unit_amount !== expectedAmount || price.recurring?.interval !== args.interval || price.recurring.interval_count !== 1 || price.tax_behavior !== 'exclusive') throw new Error('Stripe price configuration needs attention');
      const session = await stripe.checkout.sessions.create({
        customer: customerId, mode: 'subscription', managed_payments: { enabled: true },
        line_items: [{ price: mapping.priceId, quantity: 1 }], client_reference_id: args.clientId,
        metadata: { adchecked_workspace: args.clientId }, subscription_data: { metadata: { adchecked_workspace: args.clientId } },
        success_url: `${APP_URL}?checkout=success`, cancel_url: `${APP_URL}?checkout=canceled`,
        expires_at: Math.floor(row.checkoutExpiresAt! / 1000),
      }, { idempotencyKey: `adchecked-checkout-${attempt}` });
      if (!session.url || session.livemode === row.isTest) throw new Error('Checkout unavailable');
      await ctx.runMutation(ref('mutation', 'finishCheckout'), { clientId: args.clientId, attempt, checkoutId: session.id, checkoutUrl: session.url });
      return { url: session.url };
    } finally {
      await ctx.runMutation(ref('mutation', 'finishCheckout'), { clientId: args.clientId, attempt });
    }
  },
});

export const portal = action({
  args: { secret: v.string(), clientId: v.string() }, returns: v.object({ url: v.string() }), handler: async (ctx, args) => {
    authorizeBilling(args.secret);
    const row: Doc<'billingWorkspaces'> | null = await ctx.runQuery(ref('query', 'getInternal'), { clientId: args.clientId });
    if (!row?.customerId || row.accessMode !== 'subscription' || !billingReady(row.isTest)) throw new Error('Billing portal unavailable.');
    const session = await stripeClient().billingPortal.sessions.create({ customer: row.customerId, return_url: APP_URL, ...(process.env.STRIPE_PORTAL_CONFIGURATION ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION } : {}) });
    return { url: session.url };
  },
});

export const syncWorkspace = internalAction({
  args: { clientId: v.string() }, returns: v.null(), handler: async (ctx, args) => {
    const lease = crypto.randomUUID();
    const row: Doc<'billingWorkspaces'> | null = await ctx.runMutation(ref('mutation', 'claimSync'), { ...args, lease });
    if (!row) return null;
    try {
      const subscriptions = await stripeClient().subscriptions.list({ customer: row.customerId!, status: 'all', limit: 100, expand: ['data.latest_invoice'] });
      if (subscriptions.has_more) throw new Error('Incomplete subscription coverage');
      const snapshot = subscriptionSnapshot(subscriptions.data, row.isTest);
      await ctx.runMutation(ref('mutation', 'completeSync'), { ...args, lease, revision: row.revision, snapshot });
    } catch {
      // Preserve saved access and allowances on failure; never log provider bodies or keys.
      await ctx.runMutation(ref('mutation', 'completeSync'), { ...args, lease, revision: row.revision, error: true });
      console.error('Stripe subscription reconciliation failed', { clientId: args.clientId });
    }
    return null;
  },
});

const EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed',
  'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.finalization_failed', 'customer.deleted']);
export async function processStripeEvent(ctx: Pick<ActionCtx, 'runMutation'>, event: Stripe.Event) {
  if (!EVENTS.has(event.type)) return;
  const object = event.data.object;
  const customer = 'customer' in object ? object.customer : event.type === 'customer.deleted' && 'id' in object ? object.id : null;
  const customerId = typeof customer === 'string' ? customer : customer?.id;
  if (!customerId) return;
  await ctx.runMutation(ref('mutation', 'receiveEvent'), { eventId: event.id, customerId, livemode: event.livemode, deleted: event.type === 'customer.deleted' });
}
