import { isRecord } from './read-contract.ts';

type SessionSecrets = Partial<Pick<Env, 'SESSION_SECRET' | 'ADMIN_PASSWORD' | 'EMPLOYEE_ADMIN_PASSWORD'>>;

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

// Verify the existing Python-issued cookie, including password-rotation revocation.
// This does not issue tokens or introduce another authentication system.
export async function validAdminSession(request: Request, env: SessionSecrets, now = Date.now()): Promise<boolean> {
  if (!env.SESSION_SECRET) return false;
  let token = '';
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (part.slice(0, separator).trim() === 'adchecked_admin_session') {
      token = part.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
    }
  }
  const [encoded, encodedSignature, extra] = token.split('.');
  if (!encoded || !encodedSignature || extra !== undefined) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, fromBase64Url(encodedSignature), encoder.encode(encoded))) return false;
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fromBase64Url(encoded)));
    if (!isRecord(payload) || payload.kind !== 'admin' || !Number.isSafeInteger(payload.exp)
      || typeof payload.exp !== 'number' || payload.exp <= Math.floor(now / 1000)) return false;
    const role = payload.role || 'owner';
    const username = role === 'owner' ? 'admin' : role === 'employee' ? 'employee' : null;
    if (username === null) return false;
    const password = role === 'owner' ? env.ADMIN_PASSWORD ?? '' : env.EMPLOYEE_ADMIN_PASSWORD ?? '';
    const fingerprint = payload.credential_fingerprint;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return false;
    const signature = Uint8Array.from(fingerprint.match(/../g)!, byte => Number.parseInt(byte, 16));
    return crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${username}\0${password}`));
  } catch {
    return false;
  }
}
