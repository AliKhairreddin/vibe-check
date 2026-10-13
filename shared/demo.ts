export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;
export const DEMO_BASE = '/demo/workspace';
export const DEMO_API = '/api/demo/proxy';
export const DEMO_ROLES = ['owner', 'employee', 'advertiser', 'publisher'] as const;
export type DemoRole = typeof DEMO_ROLES[number];
export type DemoSession = { role: DemoRole; expiresAt: number; createdAt: number };
export function isDemoRole(value: unknown): value is DemoRole {
  return DEMO_ROLES.some(role => role === value);
}
export function demoHome(role: DemoRole) {
  return `${DEMO_BASE}${role === 'owner' || role === 'employee' ? '/publisher' : '/client'}`;
}
