export const PUBLIC_HOST = 'adchecked.com';
export const WWW_HOST = 'www.adchecked.com';
export const CLIENT_HOST = 'app.adchecked.com';
export const ADMIN_HOST = 'admin.adchecked.com';
export const API_HOST = 'api.adchecked.com';
export const LEGACY_HOST = 'vibe-check.thatcanadian.dev';

export type HostSurface = 'admin' | 'api' | 'client' | 'legacy' | 'public' | 'unknown' | 'workers';

export function hostSurface(hostname: string): HostSurface {
  const normalized = hostname.toLowerCase();
  if (normalized === PUBLIC_HOST || normalized === WWW_HOST) return 'public';
  if (normalized === CLIENT_HOST) return 'client';
  if (normalized === ADMIN_HOST) return 'admin';
  if (normalized === API_HOST) return 'api';
  if (normalized === LEGACY_HOST) return 'legacy';
  if (normalized.endsWith('.workers.dev')) return 'workers';
  return 'unknown';
}

export function isPartnerApiPath(pathname: string): boolean {
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/');
}

export function isClientApiPath(pathname: string): boolean {
  return pathname === '/api/client/check' || pathname.startsWith('/api/client/');
}

export function isLegacyCompatibleApiPath(pathname: string): boolean {
  const isLegacyClientApi = pathname === '/api/client/check'
    || (
      pathname.startsWith('/api/client/')
      && pathname !== '/api/client/session'
    );
  return isPartnerApiPath(pathname)
    || isLegacyClientApi
    || pathname === '/api/live-scans/observe'
    || pathname === '/api/live-scans/creative';
}

export function apiRequestAllowed(surface: HostSurface, pathname: string): boolean {
  if (surface === 'admin') {
    return pathname.startsWith('/api/')
      && !isClientApiPath(pathname)
      && !isPartnerApiPath(pathname);
  }
  if (surface === 'client') return isClientApiPath(pathname);
  if (surface === 'api' || surface === 'workers') return isPartnerApiPath(pathname);
  if (surface === 'legacy') return isLegacyCompatibleApiPath(pathname);
  return false;
}

export function isAdminSessionPath(pathname: string): boolean {
  return pathname === '/api/admin/session' || pathname === '/api/scanner/session';
}

export function legacyDestination(url: URL): URL {
  if (isPartnerApiPath(url.pathname)) return replaceOrigin(url, `https://${API_HOST}`);
  if (isClientApiPath(url.pathname) || isClientPagePath(url.pathname)) {
    const destination = replaceOrigin(url, `https://${CLIENT_HOST}`);
    if (url.pathname === '/kissterra' || url.pathname === '/kissterra/') {
      destination.pathname = '/client';
    } else if (url.pathname.startsWith('/kissterra/reviews/')) {
      destination.pathname = `/client/kissterra${url.pathname.slice('/kissterra'.length)}`;
    }
    return destination;
  }
  return replaceOrigin(url, `https://${ADMIN_HOST}`);
}

export function isStaticAssetPath(pathname: string): boolean {
  return pathname === '/favicon.svg'
    || pathname === '/robots.txt'
    || pathname.startsWith('/assets/');
}

export function isClientPagePath(pathname: string): boolean {
  return pathname === '/'
    || pathname === '/login'
    || pathname === '/client'
    || pathname.startsWith('/client/')
    || pathname === '/kissterra'
    || pathname.startsWith('/kissterra/');
}

export function shouldRedirectAdminPathToClient(pathname: string): boolean {
  return pathname === '/client'
    || pathname.startsWith('/client/')
    || pathname === '/kissterra'
    || pathname.startsWith('/kissterra/');
}

export function authRateLimitKey(request: Request, surface: HostSurface): string {
  const connectingIp = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  return `${surface}:${connectingIp}`;
}

export function isAdminPagePath(pathname: string): boolean {
  return pathname === '/'
    || pathname === '/login'
    || pathname === '/history'
    || pathname === '/live-scans'
    || pathname === '/automations'
    || pathname === '/settings'
    || pathname.startsWith('/reviews/')
    || pathname.startsWith('/batches/')
    || pathname.startsWith('/developers/');
}

function replaceOrigin(url: URL, origin: string): URL {
  const destination = new URL(url.pathname + url.search, origin);
  destination.hash = url.hash;
  return destination;
}
