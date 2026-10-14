import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from './_generated/server.js';
import { accessAllowed, ALLOWANCES, billingReady, configuredPrices, isGrandfathered, LEGACY_WORKSPACES, paidPlan } from './billingPolicy.ts';

const sync = makeFunctionReference<'action'>('stripeBilling:syncWorkspace');
export function authorizeBilling(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
}
export async function billingRow(ctx: QueryCtx, clientId: string) {
  return ctx.db.query('billingWorkspaces').withIndex('by_client_id', q => q.eq('clientId', clientId)).unique();
}
export async function requireBillingAccess(ctx: QueryCtx, clientId: string) {
  if (isGrandfathered(clientId)) return;
  if (!accessAllowed(await billingRow(ctx, clientId), clientId)) throw new Error('An active paid subscription is required for this workspace.');
}
export const status = query({
  args: { secret: v.string(), clientId: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    authorizeBilling(args.secret);
    const row = await billingRow(ctx, args.clientId);
    const grandfathered = isGrandfathered(args.clientId);
    return { accessMode: grandfathered ? 'grandfathered' : row?.accessMode === 'complimentary' ? 'complimentary' : 'subscription', allowed: accessAllowed(row, args.clientId),
      status: grandfathered ? 'exempt' : row?.status ?? 'none', paidThrough: row?.paidThrough ?? null,
      cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false, syncedAt: row?.syncedAt ?? null,
      syncError: row?.syncError ?? false, isTest: row?.isTest ?? false,
      checkoutReady: !grandfathered && row?.accessMode === 'subscription' && billingReady(row.isTest),
      hasCustomer: !!row?.customerId,
      plans: configuredPrices().map(({ plan, interval }) => ({ plan, interval })),
    };
  },
});
export const grandfatherExisting = internalMutation({
  args: {}, returns: v.number(), handler: async ctx => {
    let count = 0;
    for (const clientId of LEGACY_WORKSPACES) {
      if (await billingRow(ctx, clientId)) continue;
      await ctx.db.insert('billingWorkspaces', { clientId, accessMode: 'grandfathered', isTest: false, createdAt: Date.now(), status: 'exempt', nextSyncAt: Number.MAX_SAFE_INTEGER, revision: 0 });
      count++;
    }
    return count;
  },
});
export const getInternal = internalQuery({ args: { clientId: v.string() }, returns: v.any(), handler: (ctx, args) => billingRow(ctx, args.clientId) });

export const beginCheckout = internalMutation({
  args: { clientId: v.string(), priceId: v.string(), attempt: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    const row = await billingRow(ctx, args.clientId);
    if (!row || isGrandfathered(args.clientId) || row.accessMode !== 'subscription') throw new Error('This workspace does not need a subscription.');
    if (!billingReady(row.isTest)) throw new Error('Live billing is not available yet. Contact AdChecked.');
    if (row.subscriptionId && !['none', 'canceled', 'incomplete_expired'].includes(row.status)) throw new Error('Manage your existing subscription instead of starting another.');
    if ((row.checkoutLeaseUntil ?? 0) > Date.now()) throw new Error('Checkout is being prepared. Please retry in a moment.');
    const existingAttempt = row.checkoutAttempt && (row.checkoutExpiresAt ?? 0) > Date.now();
    if (existingAttempt && row.checkoutPrice !== args.priceId) throw new Error('Finish your open checkout or wait 35 minutes before choosing another plan.');
    const patch = existingAttempt ? { checkoutLeaseUntil: Date.now() + 90000 } : {
      checkoutAttempt: args.attempt, checkoutPrice: args.priceId, checkoutExpiresAt: Date.now() + 2100000,
      checkoutId: undefined, checkoutUrl: undefined, checkoutLeaseUntil: Date.now() + 90000,
    };
    await ctx.db.patch(row._id, patch);
    return { ...row, ...patch };
  },
});
export const saveCustomer = internalMutation({
  args: { clientId: v.string(), customerId: v.string(), attempt: v.string() }, returns: v.null(), handler: async (ctx, args) => {
    const row = await billingRow(ctx, args.clientId);
    if (!row || row.checkoutAttempt !== args.attempt || (row.customerId && row.customerId !== args.customerId)) throw new Error('Checkout ownership changed');
    const owner = await ctx.db.query('billingWorkspaces').withIndex('by_customer_id', q => q.eq('customerId', args.customerId)).unique();
    if (owner && owner.clientId !== args.clientId) throw new Error('Customer ownership mismatch');
    await ctx.db.patch(row._id, { customerId: args.customerId, nextSyncAt: Date.now() });
    return null;
  },
});
export const finishCheckout = internalMutation({
  args: { clientId: v.string(), attempt: v.string(), checkoutId: v.optional(v.string()), checkoutUrl: v.optional(v.string()) }, returns: v.null(), handler: async (ctx, args) => {
    const row = await billingRow(ctx, args.clientId);
    if (row?.checkoutAttempt === args.attempt) await ctx.db.patch(row._id, { checkoutLeaseUntil: 0,
      ...(args.checkoutId ? { checkoutId: args.checkoutId, checkoutUrl: args.checkoutUrl } : {}) });
    return null;
  },
});
export const requestSync = mutation({
  args: { secret: v.string(), clientId: v.string() }, returns: v.null(), handler: async (ctx, args) => {
    authorizeBilling(args.secret);
    const row = await billingRow(ctx, args.clientId);
    if (row?.customerId && row.accessMode === 'subscription' && !isGrandfathered(args.clientId) && Date.now() - Math.max(row.syncedAt ?? 0, row.requestedSyncAt ?? 0) > 60000) {
      await ctx.db.patch(row._id, { nextSyncAt: Date.now(), requestedSyncAt: Date.now() });
      await ctx.scheduler.runAfter(0, sync, { clientId: args.clientId });
    }
    return null;
  },
});
export const receiveEvent = internalMutation({
  args: { eventId: v.string(), customerId: v.string(), livemode: v.boolean(), deleted: v.boolean() }, returns: v.null(), handler: async (ctx, args) => {
    if (await ctx.db.query('billingEvents').withIndex('by_event_id', q => q.eq('eventId', args.eventId)).unique()) return null;
    const row = await ctx.db.query('billingWorkspaces').withIndex('by_customer_id', q => q.eq('customerId', args.customerId)).unique();
    if (!row || row.accessMode !== 'subscription' || row.isTest === args.livemode || isGrandfathered(row.clientId)) return null;
    await ctx.db.insert('billingEvents', { eventId: args.eventId, createdAt: Date.now() });
    if (args.deleted) {
      // Provider deletion revokes access and removes provider identifiers locally.
      await ctx.db.patch(row._id, { customerId: undefined, customerGeneration: (row.customerGeneration ?? 0) + 1, subscriptionId: undefined, priceId: undefined, paidThrough: 0, status: 'deleted', checkoutId: undefined, checkoutUrl: undefined, checkoutAttempt: undefined, checkoutExpiresAt: undefined, syncLease: undefined, syncLeaseUntil: 0, syncedAt: Date.now(), nextSyncAt: Number.MAX_SAFE_INTEGER, revision: row.revision + 1 });
    } else {
      await ctx.db.patch(row._id, { nextSyncAt: Date.now(), revision: row.revision + 1 });
      await ctx.scheduler.runAfter(0, sync, { clientId: row.clientId });
    }
    return null;
  },
});
export const claimSync = internalMutation({
  args: { clientId: v.string(), lease: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    const row = await billingRow(ctx, args.clientId);
    if (!row?.customerId || row.accessMode !== 'subscription' || isGrandfathered(args.clientId) || !billingReady(row.isTest) || (row.syncLeaseUntil ?? 0) > Date.now() || row.nextSyncAt > Date.now()) return null;
    await ctx.db.patch(row._id, { syncLease: args.lease, syncLeaseUntil: Date.now() + 90000 });
    return row;
  },
});
export const completeSync = internalMutation({
  args: { clientId: v.string(), lease: v.string(), revision: v.number(), error: v.optional(v.boolean()), snapshot: v.optional(v.object({
    status: v.string(), subscriptionId: v.optional(v.string()), priceId: v.optional(v.string()), paidThrough: v.number(), cancelAtPeriodEnd: v.boolean(), plan: v.optional(paidPlan),
  })) }, returns: v.null(), handler: async (ctx, args) => {
    const row = await billingRow(ctx, args.clientId);
    if (!row || row.accessMode !== 'subscription' || row.syncLease !== args.lease || isGrandfathered(args.clientId)) return null;
    const changed = row.revision !== args.revision;
    const snapshot = args.snapshot;
    // A concurrent event means the read may be stale. Do not apply it.
    if (!args.error && snapshot && !changed) {
      const { plan, ...state } = snapshot;
      await ctx.db.patch(row._id, { ...state, subscriptionId: state.subscriptionId, priceId: state.priceId, syncedAt: Date.now(), syncError: false });
      if (plan && plan !== 'enterprise') {
        const allocation = await ctx.db.query('advertiserPlans').withIndex('by_client_id', q => q.eq('clientId', row.clientId)).unique();
        const fields = { clientId: row.clientId, plan, ...ALLOWANCES[plan], updatedAt: Date.now() };
        if (allocation) await ctx.db.patch(allocation._id, fields); else await ctx.db.insert('advertiserPlans', fields);
      }
    }
    const next = changed ? Date.now() + 1000 : args.error ? Date.now() + 300000
      : Math.min(Date.now() + 86400000, snapshot?.paidThrough && snapshot.paidThrough > Date.now() ? snapshot.paidThrough : Date.now() + 3600000);
    await ctx.db.patch(row._id, { syncLease: undefined, syncLeaseUntil: 0, nextSyncAt: next, ...(args.error ? { syncError: true } : {}) });
    if (changed) await ctx.scheduler.runAfter(1000, sync, { clientId: row.clientId });
    return null;
  },
});
export const recover = internalMutation({
  args: {}, returns: v.null(), handler: async ctx => {
    const due = await ctx.db.query('billingWorkspaces').withIndex('by_next_sync_at', q => q.lte('nextSyncAt', Date.now())).take(25);
    for (const row of due) {
      if (row.accessMode === 'subscription' && row.customerId && billingReady(row.isTest) && (row.syncLeaseUntil ?? 0) <= Date.now()) await ctx.scheduler.runAfter(0, sync, { clientId: row.clientId });
    }
    const old = await ctx.db.query('billingEvents').withIndex('by_created_at', q => q.lt('createdAt', Date.now() - 30 * 86400000)).take(100);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});
