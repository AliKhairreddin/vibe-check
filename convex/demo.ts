import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { mutation, internalMutation, type MutationCtx } from './_generated/server.js';
import { DEMO_TTL_MS, isDemoRole } from '../shared/demo.ts';
import { seedDemo, type DemoState } from './demoData.ts';
import { DemoError, runDemoRequest } from './demoEngine.ts';

function authorize(secret: string) {
  const expected = process.env.CONVEX_HTTP_SECRET;
  if (!expected || secret !== expected) throw new Error('Unauthorized');
}
const result = v.object({ status: v.number(), body: v.any() });
const error = (status: number, detail: string) => ({ status, body: { detail } });
// These durable limits supplement the edge limiter and cannot be reset by
// switching roles, clearing cookies, or reaching a different Cloudflare POP.
async function limit(ctx: MutationCtx, key: string, maximum: number, window: number, now: number) {
  const row = await ctx.db.query('demoLimits').withIndex('by_key', q => q.eq('key', key)).unique();
  if (row && row.expiresAt > now) {
    if (row.count >= maximum) return false;
    await ctx.db.patch(row._id, { count: row.count + 1 });
  } else if (row) await ctx.db.patch(row._id, { count: 1, expiresAt: now + window });
  else await ctx.db.insert('demoLimits', { key, count: 1, expiresAt: now + window });
  return true;
}
export const create = mutation({
  args: { secret: v.string(), tokenHash: v.string(), ipHash: v.string(), role: v.string(), nonce: v.string() }, returns: result,
  handler: async (ctx, args) => {
    authorize(args.secret);
    if (!isDemoRole(args.role) || !/^[a-f0-9]{64}$/.test(args.tokenHash) || !/^[a-f0-9]{64}$/.test(args.ipHash)) return error(400, 'Invalid demo request.');
    const now = Date.now();
    if (!await limit(ctx, `create:${args.ipHash}`, 5, 3600000, now) || !await limit(ctx, 'create:global', 300, 3600000, now)) return error(429, 'Demo creation is temporarily limited. Try again in an hour.');
    if (await ctx.db.query('demoWorkspaces').withIndex('by_token_hash', q => q.eq('tokenHash', args.tokenHash)).unique()) return error(409, 'This demo token already exists.');
    const session = { role: args.role, createdAt: now, expiresAt: now + DEMO_TTL_MS };
    const id = await ctx.db.insert('demoWorkspaces', { ...session, tokenHash: args.tokenHash, state: seedDemo(now, args.nonce.slice(0, 36)), windowStart: now, requests: 0, writes: 0 });
    await ctx.scheduler.runAt(session.expiresAt, makeFunctionReference<'mutation'>('demo:expire'), { id });
    return { status: 201, body: session };
  },
});
export const request = mutation({
  args: { secret: v.string(), tokenHash: v.string(), path: v.string(), method: v.string(), body: v.any(), nonce: v.string() }, returns: result,
  handler: async (ctx, args) => {
    authorize(args.secret);
    const now = Date.now();
    const workspace = await ctx.db.query('demoWorkspaces').withIndex('by_token_hash', q => q.eq('tokenHash', args.tokenHash)).unique();
    if (!workspace || workspace.expiresAt <= now) {
      if (workspace) await ctx.db.delete(workspace._id);
      return error(401, 'Your demo has expired. Start a fresh demo to continue.');
    }
    const freshWindow = now - workspace.windowStart >= 60000;
    const requests = freshWindow ? 0 : workspace.requests;
    const writes = freshWindow ? 0 : workspace.writes;
    const writing = !['GET', 'HEAD'].includes(args.method);
    if (requests >= 180 || (writing && writes >= 30)) return error(429, 'Demo activity is limited to 180 reads and 30 changes per minute. Try again shortly.');
    await ctx.db.patch(workspace._id, { windowStart: freshWindow ? now : workspace.windowStart, requests: requests + 1, writes: writes + Number(writing) });
    const session = () => ({ role: workspace.role, expiresAt: workspace.expiresAt, createdAt: workspace.createdAt });
    if (args.path === '/session' && args.method === 'GET') return { status: 200, body: session() };
    if (args.path === '/session' && args.method === 'DELETE') { await ctx.db.delete(workspace._id); return { status: 200, body: { signed_out: true } }; }
    if (args.path === '/role' && args.method === 'PUT') {
      const role = args.body?.role;
      if (!isDemoRole(role)) return error(400, 'Choose a valid demo role.');
      await ctx.db.patch(workspace._id, { role });
      return { status: 200, body: { ...session(), role } };
    }
    if (!args.path.startsWith('/api/') || args.path.length > 2000 || JSON.stringify(args.body).length > 50000) return error(400, 'Invalid demo operation.');
    try {
      const state = JSON.parse(JSON.stringify(workspace.state)) as DemoState;
      const body = runDemoRequest(state, workspace.role, args.path, args.method, args.body, now, args.nonce.slice(0, 36));
      if (writing) {
        if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 650000) return error(429, 'This demo workspace is full. Start a fresh demo to continue.');
        await ctx.db.patch(workspace._id, { state });
      }
      return { status: 200, body };
    } catch (reason) {
      if (reason instanceof DemoError) return error(reason.status, reason.message);
      throw reason;
    }
  },
});
export const expire = internalMutation({
  args: { id: v.id('demoWorkspaces') }, returns: v.null(),
  handler: async (ctx, { id }) => { const row = await ctx.db.get(id); if (row && row.expiresAt <= Date.now()) await ctx.db.delete(id); return null; },
});
export const cleanup = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const now = Date.now();
    // Ten 650 KB snapshots leave ample room below Convex's 16 MiB read limit.
    const workspaces = await ctx.db.query('demoWorkspaces').withIndex('by_expires_at', q => q.lte('expiresAt', now)).take(10);
    const limits = await ctx.db.query('demoLimits').withIndex('by_expires_at', q => q.lte('expiresAt', now)).take(500);
    for (const row of [...workspaces, ...limits]) await ctx.db.delete(row._id);
    if (workspaces.length === 10 || limits.length === 500) await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('demo:cleanup'), {});
    return null;
  },
});
