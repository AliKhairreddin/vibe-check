import { validAdminSession } from './admin-session.ts';
import { isRecord, projectReadResponse } from './read-contract.ts';
import { drainInternalResponse } from './internal-responses.ts';

type ReadEnvironment = Pick<Env, 'CONVEX_URL' | 'CONVEX_HTTP_SECRET' | 'CORS_ALLOWED_ORIGINS'>
  & Partial<Pick<Env, 'SESSION_SECRET' | 'ADMIN_PASSWORD' | 'EMPLOYEE_ADMIN_PASSWORD'>>;

export function reviewReadRoute(request: Request): { jobId: string; kind: 'status' | 'report' } | null {
  const url = new URL(request.url);
  // Scope only the two existing operator endpoints. History, media, client,
  // public-share and partner APIs keep their own authorization and behavior.
  if (request.method !== 'GET' || url.hostname !== 'admin.adchecked.com') return null;
  const match = /^\/api\/reviews\/([0-9a-f]{32})(\/report)?$/.exec(url.pathname);
  return match ? { jobId: match[1], kind: match[2] ? 'report' : 'status' } : null;
}

function jsonResponse(request: Request, env: ReadEnvironment, body: unknown, status = 200): Response {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-adchecked-read-path': 'edge' });
  const origin = request.headers.get('origin');
  if (origin) {
    headers.set('access-control-allow-credentials', 'true');
    if (env.CORS_ALLOWED_ORIGINS.split(',').map(value => value.trim()).includes(origin)) {
      headers.set('access-control-allow-origin', origin);
      headers.set('vary', 'Origin');
    }
  }
  return Response.json(body, { status, headers });
}

// null explicitly selects the existing backend (unsupported route or transient
// read/contract failure). Authentication failures never fall through to a query.
export async function fetchReviewRead(request: Request, env: ReadEnvironment): Promise<Response | null> {
  const route = reviewReadRoute(request);
  if (!route || !env.CONVEX_URL || !env.CONVEX_HTTP_SECRET) return null;
  if (!await validAdminSession(request, env)) {
    return jsonResponse(request, env, { detail: 'Sign in to continue.' }, 401);
  }
  try {
    const upstream = await fetch(`${env.CONVEX_URL.replace(/\/$/, '')}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        path: route.kind === 'status' ? 'reviews:getStatus' : 'reviews:getReport',
        args: { secret: env.CONVEX_HTTP_SECRET, jobId: route.jobId }, format: 'json',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok) await drainInternalResponse(upstream, 'Review read');
    const payload: unknown = await upstream.json();
    if (!isRecord(payload) || payload.status !== 'success' || !Object.hasOwn(payload, 'value')) {
      throw new Error('Invalid Convex read response');
    }
    if (payload.value === null) return jsonResponse(request, env,
      { detail: route.kind === 'status' ? 'Review job not found' : 'Report not ready' }, 404);
    return jsonResponse(request, env, projectReadResponse(route.kind, payload.value));
  } catch (error) {
    console.warn(JSON.stringify({ event: 'review_read_backend_fallback', kind: route.kind,
      errorType: error instanceof Error ? error.name : typeof error }));
    return null;
  }
}

export async function recordEdgeRead(env: ReadEnvironment): Promise<void> {
  // These reads used to contribute to backend traffic heartbeats. Preserve the
  // platform chart without waking a container or inventing a running instance.
  const response = await fetch(`${env.CONVEX_URL.replace(/\/$/, '')}/api/mutation`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'platform:recordEdgeRead',
      args: { secret: env.CONVEX_HTTP_SECRET, shard: crypto.getRandomValues(new Uint8Array(1))[0] % 16 }, format: 'json' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) await drainInternalResponse(response, 'Edge traffic recording');
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.status !== 'success') throw new Error('Edge traffic recording failed');
}
