/** Only the client host may provision real accounts. Never used by demo APIs. */
export async function prepareSignup(request: Request, secret: string): Promise<Request | Response> {
  const url = new URL(request.url);
  if (url.hostname !== 'app.adchecked.com' || request.method !== 'POST') return Response.json({ detail: 'Not found.' }, { status: 404 });
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ detail: 'Invalid request origin.' }, { status: 403 });
  if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ detail: 'Provide JSON signup details.' }, { status: 400 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ detail: 'Provide signup details.' }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 10000) { await reader.cancel(); return Response.json({ detail: 'Signup details are too large.' }, { status: 413 }); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${secret}:signup:${ip}`));
  const headers = new Headers(request.headers);
  headers.set('x-signup-gateway', secret);
  headers.set('x-signup-ip', Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''));
  return new Request(request, { headers, body });
}
