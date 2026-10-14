import { v, getConvexSize } from 'convex/values';
import { query, mutation, type QueryCtx, type MutationCtx } from './_generated/server.js';
import { normalizeOverrides, publicProfile } from './offers.ts';
import { LEGACY_VERTICALS, VERTICAL_CATALOG, validVerticalId } from './verticalCatalog.ts';

const secret = { secret: v.string() };
const overrides = v.array(v.object({ overrideId: v.string(), title: v.string(), guidance: v.string(), rationale: v.string(), enabled: v.boolean() }));
function authorize(value: string) {
  if (!process.env.CONVEX_HTTP_SECRET || value !== process.env.CONVEX_HTTP_SECRET) throw new Error('Unauthorized');
}
const legacyClients = new Set(['acp', 'kissterra', 'lead-economy', 'smart-financial']);
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
