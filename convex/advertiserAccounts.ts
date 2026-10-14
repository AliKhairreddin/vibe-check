import { v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server.js';
import { isGrandfathered } from './billingPolicy.ts';

function authorize(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
}
export const get = query({
  args: { secret: v.string(), clientId: v.optional(v.string()), username: v.optional(v.string()), inviteHash: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    if (args.clientId) return ctx.db.query('advertiserAccounts').withIndex('by_client_id', q => q.eq('clientId', args.clientId!)).unique();
    if (args.username) return ctx.db.query('advertiserAccounts').withIndex('by_username', q => q.eq('username', args.username!)).unique();
    if (args.inviteHash) return ctx.db.query('advertiserAccounts').withIndex('by_invite_hash', q => q.eq('inviteHash', args.inviteHash!)).unique();
    return null;
  },
});
export const list = query({
  args: { secret: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const rows = await ctx.db.query('advertiserAccounts').take(1001);
    if (rows.length > 1000) throw new Error('Workspace directory needs pagination');
    return rows.map(({ clientId, name, category, username, status }) => ({ clientId, name, category, username, status }));
  },
});
export const create = mutation({
  args: { secret: v.string(), clientId: v.string(), inviteHash: v.string(), category: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    if (isGrandfathered(args.clientId) || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(args.clientId)) throw new Error('Workspace already exists or is invalid');
    if (await ctx.db.query('advertiserAccounts').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).unique()) throw new Error('Workspace already exists or is invalid');
    const offer = await ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', args.clientId)).unique();
    if (!offer?.enabled || !offer.officialGuidelines.trim()) throw new Error('Configure an enabled offer and its guidelines first');
    const username = `advertiser.${args.clientId}`;
    if (await ctx.db.query('publishers').withIndex('by_username', q => q.eq('username', username)).unique()) throw new Error('Username already exists');
    await ctx.db.insert('advertiserAccounts', { clientId: args.clientId, name: offer.displayName, category: args.category.slice(0,100), username,
      status: 'invited', inviteHash: args.inviteHash, inviteExpiresAt: Date.now() + 7 * 86400000, authVersion: 1, createdAt: Date.now() });
    await ctx.db.insert('billingWorkspaces', { clientId: args.clientId, accessMode: 'subscription', isTest: false, createdAt: Date.now(), status: 'none', nextSyncAt: Number.MAX_SAFE_INTEGER, revision: 0 });
    return null;
  },
});
export const resetInvite = mutation({
  args: { secret: v.string(), clientId: v.string(), inviteHash: v.string() }, returns: v.null(), handler: async (ctx, args) => {
    authorize(args.secret);
    const row = await ctx.db.query('advertiserAccounts').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).unique();
    if (!row) throw new Error('Workspace unavailable');
    await ctx.db.patch(row._id, { status: 'invited', authVersion: row.authVersion + 1, passwordHash: undefined, inviteHash: args.inviteHash, inviteExpiresAt: Date.now() + 7 * 86400000 });
    return null;
  },
});
export const acceptInvite = mutation({
  args: { secret: v.string(), inviteHash: v.string(), passwordHash: v.string() }, returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    const row = await ctx.db.query('advertiserAccounts').withIndex('by_invite_hash', q => q.eq('inviteHash', args.inviteHash)).unique();
    if (!row || row.status !== 'invited' || (row.inviteExpiresAt ?? 0) <= Date.now()) throw new Error('Invitation expired or already used');
    const patch = { status: 'active' as const, passwordHash: args.passwordHash, inviteHash: undefined, inviteExpiresAt: undefined, authVersion: row.authVersion + 1 };
    await ctx.db.patch(row._id, patch);
    return { ...row, ...patch };
  },
});

// Operator-only provisioning. Public signup and paid invitations cannot request
// complimentary access. A blank, isolated policy lets the advertiser supply it.
export const createComplimentary = internalMutation({
  args: { clientId: v.string(), name: v.string(), contactName: v.string(), inviteHash: v.string() },
  returns: v.object({ clientId: v.string(), username: v.string(), inviteExpiresAt: v.number() }),
  handler: async (ctx, args) => {
    if (isGrandfathered(args.clientId) || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(args.clientId)
      || !args.name.trim() || args.name.length > 100 || !args.contactName.trim() || args.contactName.length > 160
      || !/^[a-f0-9]{64}$/.test(args.inviteHash)) throw new Error('Invalid complimentary workspace');
    const username = `advertiser.${args.clientId}`;
    // Refuse to replace any existing customer, policy, or access allocation.
    const conflicts = await Promise.all([
      ctx.db.query('advertiserAccounts').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).unique(),
      ctx.db.query('advertiserAccounts').withIndex('by_username', q => q.eq('username', username)).unique(),
      ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', args.clientId)).unique(),
      ctx.db.query('billingWorkspaces').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).unique(),
      ctx.db.query('advertiserPlans').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).unique(),
      ctx.db.query('publishers').withIndex('by_username', q => q.eq('username', username)).unique(),
    ]);
    if (conflicts.some(Boolean)) throw new Error('Workspace already exists or username is in use');
    const now = Date.now();
    const inviteExpiresAt = now + 7 * 86400000;
    await ctx.db.insert('advertiserAccounts', { clientId: args.clientId, name: args.name.trim(), contactName: args.contactName.trim(), category: 'Advertising', username,
      status: 'invited', selfServe: true, inviteHash: args.inviteHash, inviteExpiresAt, authVersion: 1, createdAt: now });
    const profile = { offerId: args.clientId, displayName: args.name.trim(), officialGuidelines: '', internalOverrides: [],
      enabled: false, isDefault: false, version: 1, createdAt: now, updatedAt: now };
    await ctx.db.insert('offerProfiles', profile);
    await ctx.db.insert('offerProfileRevisions', profile);
    await ctx.db.insert('billingWorkspaces', { clientId: args.clientId, accessMode: 'complimentary', isTest: false,
      createdAt: now, status: 'exempt', nextSyncAt: Number.MAX_SAFE_INTEGER, revision: 0 });
    await ctx.db.insert('advertiserPlans', { clientId: args.clientId, plan: 'pilot', publisherLimit: 5, monthlyReviewLimit: 250, updatedAt: now });
    return { clientId: args.clientId, username, inviteExpiresAt };
  },
});
