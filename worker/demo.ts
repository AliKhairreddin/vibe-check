import { DEMO_API, DEMO_TTL_MS, isDemoRole } from '../shared/demo.ts';

const COOKIE = '__Host-adchecked_demo';
const json = (body: unknown, status = 200, retryAfter = 60) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...(status === 429 ? { 'retry-after': String(retryAfter) } : {}) } });
type DemoEnv = Pick<Env, 'CONVEX_URL' | 'CONVEX_HTTP_SECRET' | 'DEMO_RATE_LIMITER'>;
type Result = { status: number; body: Record<string, unknown> };
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
function cookie(request: Request) { return request.headers.get('cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? ''; }
function setCookie(response: Response, token: string, maxAge = DEMO_TTL_MS / 1000) {
  response.headers.set('set-cookie', `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
  return response;
}
async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Use JSON for demo requests. Uploads are simulated.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 50000) { await reader.cancel(); throw new Error('Demo requests must be smaller than 50 KB.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.');
  return parsed as Record<string, unknown>;
}
async function convex(env: DemoEnv, operation: 'create' | 'request', args: Record<string, unknown>): Promise<Result> {
  const response = await fetch(`${env.CONVEX_URL.replace(/\/$/, '')}/api/mutation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ path: `demo:${operation}`, args: { ...args, secret: env.CONVEX_HTTP_SECRET }, format: 'json' }),
  });
  if (!response.ok) throw new Error('Demo storage unavailable');
  const payload = await response.json() as { status: string; value?: Result };
  if (payload.status !== 'success' || !payload.value) throw new Error('Demo storage unavailable');
  return payload.value;
}
const xml = (value: unknown) => String(value ?? '').replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]!));
function sampleImage(body: Record<string, unknown>) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="#e7f1ec"/><rect x="60" y="60" width="1080" height="680" rx="36" fill="#143e36"/><text x="110" y="145" fill="#a7f3d0" font-family="sans-serif" font-size="24">HARBOR / MAPLE · FICTIONAL SAMPLE CREATIVE</text><text x="110" y="300" fill="white" font-family="sans-serif" font-size="46">Coverage for your next chapter.</text><text x="110" y="390" fill="white" font-family="sans-serif" font-size="25">${xml(String(body.claim ?? '').slice(0, 70))}</text><text x="110" y="565" fill="#a7f3d0" font-family="sans-serif" font-size="21">${xml(String(body.title ?? '').slice(0, 75))}</text><text x="110" y="650" fill="#a7f3d0" font-family="sans-serif" font-size="22">DEMO ONLY · No real offer or insurance product</text></svg>`;
}
function samplePdf(body: Record<string, unknown>) {
  const escape = (s: unknown) => String(s ?? '').replace(/[^\x20-\x7E]/g, ' ').replace(/[\\()]/g, '\\$&');
  const reports = Array.isArray(body.demo_reports) ? body.demo_reports as Record<string, unknown>[] : [body];
  const pages = reports.map(report => {
    const lines = ['AdChecked - FICTIONAL DEMO REPORT', 'Simulated results. Not a real compliance assessment.', '', report.file_name, report.offer_name, `Result: ${report.overall_status}`, report.summary, '', 'Suggested rewrite:', (report.safe_rewrite as { ad_copy?: string })?.ad_copy ?? '', '', 'No paid processing or external action was performed.'];
    const wrapped = lines.flatMap(line => String(line ?? '').match(/.{1,72}(?:\s|$)|.{1,72}/g) ?? ['']).slice(0, 30);
    return `BT /F1 12 Tf 50 750 Td 20 TL ${wrapped.map((l, i) => `${i ? 'T* ' : ''}(${escape(l)}) Tj`).join('\n')} ET`;
  });
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((content, i) => objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}
/** Returns null only outside /api/demo. Demo failures NEVER fall back to production. */
export async function handleDemoApi(request: Request, env: DemoEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/demo/')) return null;
  const origin = request.headers.get('origin');
  const mutating = !['GET', 'HEAD'].includes(request.method);
  if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site' || (mutating && origin !== url.origin)) return json({ detail: 'Demo requests must come from this website.' }, 403);
  // Rate-limit all requests, including invalid/expired tokens before any DB access.
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const allowed = await env.DEMO_RATE_LIMITER.limit({ key: `demo:${ip}` });
  if (!allowed.success) return json({ detail: 'Too many demo requests. Try again in a minute.' }, 429);
  let body: Record<string, unknown> = {};
  if (mutating) { try { body = await boundedJson(request); } catch (reason) { return json({ detail: reason instanceof Error ? reason.message : 'Invalid request.' }, 400); } }
  try {
    if (url.pathname === '/api/demo/session' && request.method === 'POST') {
      if (!isDemoRole(body.role)) return json({ detail: 'Choose a demo experience.' }, 400);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      const created = await convex(env, 'create', { tokenHash: await hash(token), ipHash: await hash(`${env.CONVEX_HTTP_SECRET}:demo:${ip}`), role: body.role, nonce: crypto.randomUUID() });
      return created.status === 201 ? setCookie(json(created.body, 201), token) : json(created.body, created.status, 3600);
    }
    const token = cookie(request);
    if (!/^[a-f0-9]{64}$/.test(token)) return json({ detail: 'Start a demo to explore a private workspace.' }, 401);
    const path = url.pathname === '/api/demo/session' ? '/session' : url.pathname === '/api/demo/role' ? '/role' : url.pathname.startsWith(`${DEMO_API}/api/`) ? `${url.pathname.slice(DEMO_API.length)}${url.search}` : '';
    if (!path) return json({ detail: 'Unknown demo endpoint.' }, 404);
    const result = await convex(env, 'request', { tokenHash: await hash(token), path, method: request.method, body, nonce: crypto.randomUUID() });
    if (result.status !== 200) return json(result.body, result.status);
    if (path === '/session' && request.method === 'DELETE') return setCookie(json(result.body), '', 0);
    if (result.body?.demo_asset === true) return new Response(request.method === 'HEAD' ? null : sampleImage(result.body), { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox" } });
    if (url.pathname.endsWith('/report.pdf')) return new Response(samplePdf(result.body), { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="fictional-demo-report.pdf"', 'cache-control': 'no-store' } });
    return json(result.body);
  } catch {
    return json({ detail: 'The demo could not reach its private storage. Please try again.' }, 503);
  }
}
