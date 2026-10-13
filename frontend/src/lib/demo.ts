import { DEMO_API, DEMO_BASE, type DemoSession } from '../../../shared/demo';
export { DEMO_BASE, demoHome, type DemoRole, type DemoSession } from '../../../shared/demo';
export const isDemo = () => typeof window !== 'undefined' && (window.location.pathname === '/demo' || window.location.pathname.startsWith('/demo/'));
export const demoBasepath = () => isDemo() ? DEMO_BASE : '/';
export const appPathname = (path: string) => isDemo() && path.startsWith(DEMO_BASE) ? path.slice(DEMO_BASE.length) || '/' : path;
export const pageUrl = (path: string) => isDemo() ? `${DEMO_BASE}${path}` : path;
export function apiUrl(path: string) {
  return isDemo() && path.startsWith('/api/') && !path.startsWith('/api/demo/') ? `${DEMO_API}${path}` : path;
}
export function demoRequest(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === 'string') return apiUrl(input);
  return input;
}
export class DemoControlError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function demoControl(path: 'session' | 'role', method = 'GET', body?: unknown): Promise<DemoSession> {
  const response = await fetch(`/api/demo/${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new DemoControlError(data.detail ?? 'The demo could not be opened. Please try again.', response.status);
  return data;
}
export async function leaveDemo() {
  await demoControl('session', 'DELETE');
  window.sessionStorage.removeItem('adchecked-demo-ui');
  window.location.assign('/demo');
}
