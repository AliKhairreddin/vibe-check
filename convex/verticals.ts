import { v, getConvexSize } from 'convex/values';
import { query, mutation, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server.js';
import { ensureRevision, normalizeOverrides, publicProfile } from './offers.ts';
import { LEGACY_VERTICALS, VERTICAL_CATALOG, validVerticalId } from './verticalCatalog.ts';

const secret = { secret: v.string() };
const overrides = v.array(v.object({ overrideId: v.string(), title: v.string(), guidance: v.string(), rationale: v.string(), enabled: v.boolean() }));
function authorize(value: string) {
  if (!process.env.CONVEX_HTTP_SECRET || value !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
}
const legacyClients = new Set(['acp', 'kissterra', 'lead-economy', 'smart-financial']);
const auditedClients = ['lead-economy', 'kissterra', 'smart-financial'];
export function defaultVertical(clientId: string, verticalId: string) {
  const entry = VERTICAL_CATALOG.find(item => item[0] === verticalId);
  if (!entry) return null;
  const legacy = legacyClients.has(clientId) && LEGACY_VERTICALS.includes(verticalId);
  return { clientId, verticalId, name: entry[1] as string, enabled: legacy, includeDefault: legacy,
    officialGuidelines: '', internalOverrides: [] as ReturnType<typeof normalizeOverrides>, version: 0, updatedAt: 0 };
}
export async function selectedVertical(ctx: QueryCtx | MutationCtx, clientId: string, verticalId: string) {
  return await ctx.db.query('advertiserVerticals').withIndex('by_client_and_vertical', q => q.eq('clientId', clientId).eq('verticalId', verticalId)).unique()
    ?? defaultVertical(clientId, verticalId);
}
export const list = query({
  args: { ...secret, clientId: v.string(), publisher: v.optional(v.boolean()) }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const rows = await ctx.db.query('advertiserVerticals').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).take(150);
    const saved = new Map(rows.map(row => [row.verticalId, row]));
    const all = VERTICAL_CATALOG.map(([id, , group]) => ({ ...(saved.get(id) ?? defaultVertical(args.clientId, id)!), group }));
    const custom = rows.filter(row => !VERTICAL_CATALOG.some(item => item[0] === row.verticalId)).map(row => ({ ...row, group: 'Custom' }));
    return [...all, ...custom].filter(row => !args.publisher || row.enabled).map(row => args.publisher
      ? { verticalId: row.verticalId, name: row.name }
      : { verticalId: row.verticalId, name: row.name, enabled: row.enabled, includeDefault: row.includeDefault,
        officialGuidelines: row.officialGuidelines, internalOverrides: row.internalOverrides, version: row.version, updatedAt: row.updatedAt, group: row.group });
  },
});
export const reviewPolicy = query({
  args: { ...secret, clientId: v.string(), offerId: v.string(), verticalId: v.string() }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    const policy = await selectedVertical(ctx, args.clientId, args.verticalId);
    const base = await ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', args.offerId)).unique();
    return { policy, base: base ? publicProfile(base) : null };
  },
});

// Freeze the complete small policy set with its matching shared-policy version.
// Internal/API batches select from this snapshot per creative, without fetching
// newer policies on retries or sending other verticals to the review model.
export const reviewCatalog = query({
  args: { ...secret, offerIds: v.array(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.secret);
    if (args.offerIds.length > 3 || args.offerIds.some(id => !auditedClients.includes(id))) throw new Error('Invalid audited offer selection.');
    return Promise.all([...new Set(args.offerIds)].map(async offerId => {
      const base = await ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', offerId)).unique();
      if (!base) throw new Error('Offer profile not found.');
      const rows = await ctx.db.query('advertiserVerticals').withIndex('by_client_id', q => q.eq('clientId', offerId)).take(121);
      if (rows.length > 120) throw new Error('Too many vertical policies.');
      const saved = new Map(rows.map(row => [row.verticalId, row]));
      const policies = [...rows, ...LEGACY_VERTICALS.filter(id => !saved.has(id)).map(id => defaultVertical(offerId, id)!)];
      return { ...publicProfile(base), vertical_policies: policies.map(row => ({
        vertical_id: row.verticalId, name: row.name, enabled: row.enabled, include_default: row.includeDefault,
        official_guidelines: row.officialGuidelines, version: row.version,
        internal_overrides: row.internalOverrides.map(({ overrideId, ...rule }) => ({ ...rule, override_id: overrideId })),
      })) };
    }));
  },
});

// One-time operator migration. All three reviewed sources must still match;
// a changed source or previously edited vertical aborts the whole transaction.
export const assignLegacy = internalMutation({
  args: { assignments: v.array(v.object({
    clientId: v.string(), expectedVersion: v.number(), expectedGuidelines: v.string(), expectedOverrides: overrides,
    sharedGuidelines: v.string(), sharedOverrides: overrides,
    verticals: v.array(v.object({ verticalId: v.string(), enabled: v.boolean(), officialGuidelines: v.string(), internalOverrides: overrides })),
  })) },
  returns: v.array(v.object({ clientId: v.string(), version: v.number(), changed: v.boolean() })),
  handler: async (ctx, { assignments }) => {
    if (assignments.length !== 3 || new Set(assignments.map(a => a.clientId)).size !== 3 || assignments.some(a => !auditedClients.includes(a.clientId))) throw new Error('Provide exactly the three audited advertisers.');
    const prepared = [];
    for (const item of assignments) {
      const base = await ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', item.clientId)).unique();
      if (!base) throw new Error('Offer profile not found.');
      const rows = await ctx.db.query('advertiserVerticals').withIndex('by_client_id', q => q.eq('clientId', item.clientId)).take(121);
      const sharedOverrides = normalizeOverrides(item.sharedOverrides);
      const policies = item.verticals.map(policy => {
        const entry = VERTICAL_CATALOG.find(row => row[0] === policy.verticalId);
        if (!entry || policy.officialGuidelines.length > 200000) throw new Error('Invalid migration policy.');
        return { ...policy, clientId: item.clientId, name: entry[1], includeDefault: true, internalOverrides: normalizeOverrides(policy.internalOverrides), version: 1 };
      });
      if (!item.sharedGuidelines.trim() || item.sharedGuidelines.length > 200000 || policies.length > 10 || new Set(policies.map(p => p.verticalId)).size !== policies.length || !LEGACY_VERTICALS.every(id => policies.some(p => p.verticalId === id))) throw new Error('Incomplete migration.');
      const sameRules = (a: ReturnType<typeof normalizeOverrides>, b: ReturnType<typeof normalizeOverrides>) => JSON.stringify(normalizeOverrides(a)) === JSON.stringify(normalizeOverrides(b));
      const done = base.version === item.expectedVersion + 1 && base.officialGuidelines === item.sharedGuidelines && sameRules(base.internalOverrides, sharedOverrides)
        && rows.length === policies.length && policies.every(policy => rows.some(row => row.verticalId === policy.verticalId && row.version === 1 && row.enabled === policy.enabled && row.includeDefault && row.officialGuidelines === policy.officialGuidelines && sameRules(row.internalOverrides, policy.internalOverrides)));
      if (!done && (base.version !== item.expectedVersion || base.officialGuidelines !== item.expectedGuidelines || !sameRules(base.internalOverrides, normalizeOverrides(item.expectedOverrides)) || rows.length)) throw new Error(`Source changed for ${item.clientId}; audit again before migrating.`);
      prepared.push({ item, base, sharedOverrides, policies, done });
    }
    const result = [];
    for (const { item, base, sharedOverrides, policies, done } of prepared) {
      if (!done) {
        const updatedAt = Date.now();
        await ensureRevision(ctx, base);
        const next = { ...base, officialGuidelines: item.sharedGuidelines, internalOverrides: sharedOverrides, version: base.version + 1, updatedAt };
        if (getConvexSize(next) > 900000) throw new Error('Shared migration policy is too large.');
        await ctx.db.patch(base._id, { officialGuidelines: next.officialGuidelines, internalOverrides: next.internalOverrides, version: next.version, updatedAt });
        await ensureRevision(ctx, next);
        for (const policy of policies) {
          const value = { ...policy, updatedAt };
          if (getConvexSize(value) > 900000) throw new Error('Migration policy is too large.');
          await ctx.db.insert('advertiserVerticals', value);
          await ctx.db.insert('advertiserVerticalRevisions', value);
        }
      }
      result.push({ clientId: item.clientId, version: item.expectedVersion + 1, changed: !done });
    }
    return result;
  },
});
export const save = mutation({
  args: { ...secret, clientId: v.string(), offerId: v.string(), verticalId: v.string(), name: v.string(), enabled: v.boolean(), includeDefault: v.boolean(), officialGuidelines: v.string(), internalOverrides: overrides, expectedVersion: v.number() },
  returns: v.any(), handler: async (ctx, args) => {
    authorize(args.secret);
    if (!validVerticalId(args.verticalId)) throw new Error('Invalid vertical ID.');
    const catalog = VERTICAL_CATALOG.find(item => item[0] === args.verticalId);
    if (!catalog && !args.verticalId.startsWith('custom-')) throw new Error('Custom vertical IDs must start with custom-.');
    const name = catalog?.[1] ?? args.name.trim();
    if (name.length < 2 || name.length > 100) throw new Error('Enter a vertical name between 2 and 100 characters.');
    const existing = await ctx.db.query('advertiserVerticals').withIndex('by_client_and_vertical', q => q.eq('clientId', args.clientId).eq('verticalId', args.verticalId)).unique();
    if (args.expectedVersion !== (existing?.version ?? 0)) throw new Error('Vertical changed since you opened it. Reload before saving.');
    if (!existing) {
      const rows = await ctx.db.query('advertiserVerticals').withIndex('by_client_id', q => q.eq('clientId', args.clientId)).take(120);
      if (rows.length >= 120) throw new Error('A workspace supports up to 120 saved verticals.');
    }
    if (args.enabled && args.includeDefault) {
      const base = await ctx.db.query('offerProfiles').withIndex('by_offer_id', q => q.eq('offerId', args.offerId)).unique();
      if (!base?.enabled || !base.officialGuidelines.trim()) throw new Error('Enable and save the default policy before including it.');
    }
    const text = args.officialGuidelines.trim();
    if (text.length > 200000 || (args.enabled && !args.includeDefault && !text)) throw new Error('Add vertical guidelines or select the default policy before activating.');
    const value = { clientId: args.clientId, verticalId: args.verticalId, name, enabled: args.enabled, includeDefault: args.includeDefault,
      officialGuidelines: text, internalOverrides: normalizeOverrides(args.internalOverrides), version: (existing?.version ?? 0) + 1, updatedAt: Date.now() };
    if (getConvexSize(value) > 900000) throw new Error('The combined vertical guidelines and rules are too large.');
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert('advertiserVerticals', value);
    await ctx.db.insert('advertiserVerticalRevisions', value);
    return { ...value, group: catalog?.[2] ?? 'Custom' };
  },
});
