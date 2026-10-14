import type Stripe from 'stripe';
import { v } from 'convex/values';

// Frozen launch cohort. Absence of a billing record NEVER exempts new workspaces.
export const LEGACY_WORKSPACES = ['acp', 'kissterra', 'lead-economy', 'smart-financial'] as const;
export const isGrandfathered = (clientId: string) => (LEGACY_WORKSPACES as readonly string[]).includes(clientId);
export const paidPlan = v.union(v.literal('starter'), v.literal('growth'), v.literal('enterprise'));
export const billingInterval = v.union(v.literal('month'), v.literal('year'));
export const ALLOWANCES = { starter: { publisherLimit: 5, monthlyReviewLimit: 250 }, growth: { publisherLimit: 25, monthlyReviewLimit: 1000 } };
export type PaidPlan = 'starter' | 'growth' | 'enterprise';

export function configuredPrices() {
  return (['starter', 'growth', 'enterprise'] as const).flatMap(plan => (['month', 'year'] as const).flatMap(interval => {
    const priceId = process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`];
    return priceId ? [{ plan, interval, priceId }] : [];
  }));
}

export function billingReady(isTest: boolean) {
  const mode = process.env.STRIPE_BILLING_MODE;
  return mode === (isTest ? 'test' : 'live') && Boolean(process.env.STRIPE_WEBHOOK_SECRET)
    && ['sk', 'rk'].some(prefix => process.env.STRIPE_SECRET_KEY?.startsWith(`${prefix}_${isTest ? 'test' : 'live'}_`));
}

export function accessAllowed(row: { accessMode: string; status: string; paidThrough?: number } | null, clientId: string, now = Date.now()) {
  if (isGrandfathered(clientId)) return true;
  if (row?.accessMode === 'complimentary' && row.status === 'exempt') return true;
  return row?.accessMode === 'subscription' && row.status === 'active' && (row.paidThrough ?? 0) > now;
}

// Reconcile current provider state; webhook delivery order is not subscription order.
export function subscriptionSnapshot(subscriptions: Stripe.Subscription[], isTest: boolean) {
  const relevant = subscriptions.filter(s => s.livemode === !isTest && !['canceled', 'incomplete_expired'].includes(s.status));
  if (relevant.length > 1) throw new Error('Multiple subscriptions require reconciliation');
  const subscription = relevant[0] ?? subscriptions.filter(s => s.livemode === !isTest).sort((a, b) => b.created - a.created)[0];
  if (!subscription) return { status: 'none', paidThrough: 0, cancelAtPeriodEnd: false };
  const item = subscription.items.data[0];
  const mapping = configuredPrices().find(p => p.priceId === item?.price.id);
  const invoice = subscription.latest_invoice;
  const paid = invoice && typeof invoice !== 'string' && invoice.status === 'paid';
  const valid = subscription.items.data.length === 1 && item.quantity === 1 && mapping && !subscription.pause_collection && subscription.managed_payments?.enabled === true;
  return {
    subscriptionId: subscription.id, priceId: item?.price.id,
    status: valid ? subscription.status : 'unsupported',
    paidThrough: valid && paid && subscription.status === 'active' ? item.current_period_end * 1000 : 0,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    plan: valid ? mapping.plan : undefined,
  };
}
