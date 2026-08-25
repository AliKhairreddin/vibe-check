export type AppSurface = 'admin' | 'client' | 'marketing' | 'unsupported';

const SURFACE_HOSTS: Record<string, AppSurface> = {
  'adchecked.com': 'marketing',
  'www.adchecked.com': 'marketing',
  'app.adchecked.com': 'client',
  'admin.adchecked.com': 'admin',
};

export function appSurfaceForHostname(hostname: string): AppSurface {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return 'admin';
  }
  return SURFACE_HOSTS[normalized] ?? 'unsupported';
}

export function currentAppSurface(): AppSurface {
  const configured = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get('surface')
    : null;
  if (configured === 'admin' || configured === 'client' || configured === 'marketing') {
    return configured;
  }
  return appSurfaceForHostname(window.location.hostname);
}
