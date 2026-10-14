import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { mutation, internalMutation } from './_generated/server.js';

function authorize(secret: string) {
  if (!process.env.CONVEX_HTTP_SECRET || secret !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
}

// Admission happens before password hashing, across all container instances.
export const admit = mutation({
  args: { secret: v.string(), ipHash: v.string() }, returns: v.boolean(),
  handler: async (ctx, { secret, ipHash }) => {
    authorize(secret);
    if (!/^[a-f0-9]{64}$/.test(ipHash)) throw new Error('Invalid signup admission');
    const now = Date.now();
    const limits = [];
    for (const [key, maximum] of [[`ip:${ipHash}`, 5], ['global', 200]] as const) {
      const row = await ctx.db.query('signupLimits').withIndex('by_key', q => q.eq('key', key)).unique();
      if (row && row.expiresAt > now && row.count >= maximum) return false;
      limits.push({ key, row });
    }
    for (const { key, row } of limits) {
      const expired = !row || row.expiresAt <= now;
      const next = { key, count: expired ? 1 : row.count + 1, expiresAt: expired ? now + 3600000 : row.expiresAt };
      const id = row?._id ?? await ctx.db.insert('signupLimits', next);
      if (row) await ctx.db.patch(id, next);
      if (expired) await ctx.scheduler.runAt(next.expiresAt, makeFunctionReference<'mutation'>('signup:expireLimit'), { id });
    }
    return true;
  },
});
export const expireLimit = internalMutation({
  args: { id: v.id('signupLimits') }, returns: v.null(),
  handler: async (ctx, { id }) => { const row = await ctx.db.get(id); if (row && row.expiresAt <= Date.now()) await ctx.db.delete(id); return null; },
});

// The trusted backend generates the workspace ID. No demo ID, role, offer ID,
// subscription, or existing tenant can be selected by a signup payload.
export const create = mutation({
  args: { secret: v.string(), clientId: v.string(), email: v.string(), name: v.string(), passwordHash: v.string() },
  returns: v.object({ clientId: v.string(), name: v.string(), category: v.string(), username: v.string(), authVersion: v.number() }),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const username = args.email.trim().toLowerCase();
    const name = args.name.trim();
    if (!/^workspace-[a-f0-9]{32}$/.test(args.clientId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || username.length > 254 || name.length < 2 || name.length > 100 || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(args.passwordHash)) throw new Error('Invalid signup details');
    if (await ctx.db.query('advertiserAccounts').withIndex('by_username', q => q.eq('username', username)).unique()
      || await ctx.db.query('publishers').withIndex('by_username', q => q.eq('username', username)).unique()) throw new Error('This email is already in use. Sign in instead.');
    for (const table of ['advertiserAccounts', 'billingWorkspaces', 'advertiserPlans'] as const) {
      if (await ctx.db.query(table).withIndex('by_client_id', q => q.eq('clientId', args.clientId)).unique()) throw new Error('Workspace ID already exists');
    }
    if (await ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', args.clientId)).unique()) throw new Error('Workspace ID already exists');
    const now = Date.now();
    const account = { clientId: args.clientId, name, category: 'Advertising', username, authVersion: 1 };
    await ctx.db.insert('advertiserAccounts', { ...account, status: 'active', selfServe: true, passwordHash: args.passwordHash, createdAt: now });
    const offer = { offerId: args.clientId, displayName: name, officialGuidelines: '', internalOverrides: [], enabled: false, isDefault: false, version: 1, createdAt: now, updatedAt: now };
    await ctx.db.insert('offerProfiles', offer);
    await ctx.db.insert('offerProfileRevisions', offer);
    await ctx.db.insert('billingWorkspaces', { clientId: args.clientId, accessMode: 'subscription', isTest: false, createdAt: now, status: 'none', nextSyncAt: Number.MAX_SAFE_INTEGER, revision: 0 });
    await ctx.db.insert('advertiserPlans', { clientId: args.clientId, plan: 'starter', publisherLimit: 5, monthlyReviewLimit: 250, updatedAt: now });
    return account;
  },
});
