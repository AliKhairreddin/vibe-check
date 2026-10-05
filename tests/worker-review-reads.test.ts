import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { fetchReviewRead, reviewReadRoute } from '../worker/review-reads.ts';
import { drainInternalResponse, readInternalJson } from '../worker/internal-responses.ts';
import { combineTrafficHours } from '../convex/platformTraffic.ts';

const jobId = 'a'.repeat(32);
const env = { SESSION_SECRET: 'test-signing-secret', ADMIN_PASSWORD: 'owner-password', EMPLOYEE_ADMIN_PASSWORD: 'employee-password',
  CONVEX_URL: 'https://example.convex.cloud', CONVEX_HTTP_SECRET: 'test-database-secret', CORS_ALLOWED_ORIGINS: 'https://admin.adchecked.com,https://app.adchecked.com' };
const hmac = (value: string, encoding: 'hex' | 'base64url') => createHmac('sha256', env.SESSION_SECRET).update(value).digest(encoding);
function cookie() {
  const payload = Buffer.from(JSON.stringify({ kind: 'admin', role: 'owner', exp: Math.floor(Date.now() / 1000) + 60,
    credential_fingerprint: hmac(`admin\0${env.ADMIN_PASSWORD}`, 'hex') })).toString('base64url');
  return `adchecked_admin_session=${payload}.${hmac(payload, 'base64url')}`;
}
const request = (path = `/api/reviews/${jobId}`, options: RequestInit = {}) => new Request(`https://admin.adchecked.com${path}`,
  { ...options, headers: { cookie: cookie(), ...options.headers } });

test('only exact operator read routes bypass the container', () => {
  assert.deepEqual(reviewReadRoute(request()), { kind: 'status', jobId });
  assert.deepEqual(reviewReadRoute(request(`/api/reviews/${jobId}/report?offer=kissterra`)), { kind: 'report', jobId });
  for (const path of ['/api/reviews/history', '/api/reviews', `/api/reviews/${jobId}/media`, `/api/reviews/${jobId}/report.pdf`,
    `/api/client/kissterra/reviews/${jobId}`, `/api/v1/reviews/${jobId}`, '/api/public/shares/token']) {
    assert.equal(reviewReadRoute(request(path)), null);
  }
  for (const method of ['POST', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal(reviewReadRoute(request(undefined, { method })), null);
  for (const host of ['app.adchecked.com', 'api.adchecked.com', 'adchecked.com', 'evil.example']) {
    assert.equal(reviewReadRoute(new Request(`https://${host}/api/reviews/${jobId}`)), null);
  }
});

test('authorized reads use fresh Convex data and preserve missing/deleted responses', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, `${env.CONVEX_URL}/api/query`);
    const payload = JSON.parse(options.body as string);
    assert.equal(payload.args.secret, env.CONVEX_HTTP_SECRET);
    assert.equal(payload.args.jobId, jobId);
    calls++;
    const value = calls === 1 ? { job_id: jobId, progress: 10 } : calls === 2 ? { job_id: jobId, progress: 90 } : null;
    return Response.json({ status: 'success', value });
  });
  for (const progress of [10, 90]) {
    const response = await fetchReviewRead(request(), env);
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get('cache-control'), 'no-store');
    assert.equal((await response!.json()).progress, progress);
  }
  for (const [suffix, detail] of [['', 'Review job not found'], ['/report', 'Report not ready']]) {
    const response = await fetchReviewRead(request(`/api/reviews/${jobId}${suffix}`), env);
    assert.equal(response?.status, 404);
    assert.deepEqual(await response!.json(), { detail });
  }
});

test('unauthorized reads never reach Convex and failures retain the original backend fallback', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Network unavailable'); });
  const denied = await fetchReviewRead(request(undefined, { headers: { cookie: '' } }), env);
  assert.equal(denied?.status, 401);
  assert.equal(calls, 0);
  assert.equal(await fetchReviewRead(request(), env), null);
  assert.equal(calls, 1);
  assert.equal(await fetchReviewRead(request(), { ...env, CONVEX_URL: '' }), null);
});

test('reports retain nested defaults, legacy results, client decisions and the existing CORS allowlist', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'success', value: {
    overall_status: 'amber', summary: 'Legacy report', secret_extra: 'must not escape',
    source_results: { creative: { status: 'pass' } },
    offer_outcomes: [{ offer_id: 'acp', offer_name: 'ACP', evaluation_state: 'evaluated', client_decision: 'approved', automated_status: 'likely_violation', effective_status: 'green' }],
    client_decisions: [{ decision: 'approved', feedback_note: 'Keep this decision' }],
  } }));
  const response = await fetchReviewRead(request(`/api/reviews/${jobId}/report`, { headers: { origin: 'https://app.adchecked.com' } }), env);
  assert.equal(response?.headers.get('access-control-allow-origin'), 'https://app.adchecked.com');
  const report = await response!.json();
  assert.equal(report.overall_status, 'yellow');
  assert.equal(report.source_results.creative.status, 'green');
  assert.deepEqual(report.safe_rewrite, { ad_copy: '', onscreen_text: [] });
  assert.equal(report.offer_outcomes[0].automated_status, 'red');
  assert.equal(report.client_decisions[0].feedback_note, 'Keep this decision');
  assert.equal(report.secret_extra, undefined);
  const disallowed = await fetchReviewRead(request(`/api/reviews/${jobId}/report`, { headers: { origin: 'https://evil.example' } }), env);
  assert.equal(disallowed?.headers.get('access-control-allow-origin'), null);
});

test('malformed or unfamiliar upstream data selects the backend instead of changing the response contract', async t => {
  for (const payload of [{ status: 'error', errorMessage: 'private' }, { status: 'success' }, { status: 'success', value: { job_id: jobId, progress: '10' } }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    assert.equal(await fetchReviewRead(request(), env), null);
    mock.mock.restore();
  }
});

function streamedResponse(status = 200) {
  let chunks = 0;
  let finished = false;
  return {
    response: new Response(new ReadableStream({ pull(controller) {
      if (chunks++ < 128) controller.enqueue(new Uint8Array(64 * 1024));
      else { finished = true; controller.close(); }
    } }), { status }),
    finished: () => finished,
  };
}

test('internal success and error responses are fully drained even beyond stream buffer capacity', async () => {
  for (const status of [200, 503]) {
    const stream = streamedResponse(status);
    if (status === 200) await drainInternalResponse(stream.response, 'Tick');
    else await assert.rejects(drainInternalResponse(stream.response, 'Tick'), /503/);
    assert.equal(stream.finished(), true);
    assert.equal(stream.response.bodyUsed, true);
  }
  const error = streamedResponse(500);
  await assert.rejects(readInternalJson(error.response, 'Queue state'), /500/);
  assert.equal(error.finished(), true);
  const json = Response.json({ active: 1, pending: 2 });
  assert.deepEqual(await readInternalJson(json, 'Queue state'), { active: 1, pending: 2 });
  assert.equal(json.bodyUsed, true);
  await drainInternalResponse(new Response(null, { status: 204 }), 'Empty tick');
});

test('traffic charts retain container and edge reads without adding running instances', () => {
  assert.deepEqual(combineTrafficHours([{ hour: 1, requests: 4, errors: 1 }],
    [{ hour: 1, requests: 7, errors: 0 }, { hour: 1, requests: 2, errors: 0 }, { hour: 2, requests: 3, errors: 0 }]),
  [{ hour: 1, requests: 13, errors: 1 }, { hour: 2, requests: 3, errors: 0 }]);
});
