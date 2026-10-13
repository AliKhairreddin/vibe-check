import { isDemo, type DemoSession } from './demo';
const KEY = 'adchecked-demo-ui';
type DemoUi = { createdAt: number; expiresAt: number; values: Record<string, string> };
function readDemo(): DemoUi | null {
  try {
    const state = JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null') as DemoUi | null;
    if (state && state.expiresAt > Date.now()) return state;
    window.sessionStorage.removeItem(KEY);
  } catch { /* Browser storage may be disabled. */ }
  return null;
}
export function configureDemoUi(session: DemoSession) {
  const current = readDemo();
  if (current?.createdAt !== session.createdAt) window.sessionStorage.setItem(KEY, JSON.stringify({ createdAt: session.createdAt, expiresAt: session.expiresAt, values: {} }));
}
export function clearDemoUi() { window.sessionStorage.removeItem(KEY); }
function storage(kind: 'localStorage' | 'sessionStorage'): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return {
    getItem(key) { return isDemo() ? readDemo()?.values[key] ?? null : window[kind].getItem(key); },
    setItem(key, value) {
      if (!isDemo()) { window[kind].setItem(key, value); return; }
      const current = readDemo();
      if (current) { current.values[key] = value; window.sessionStorage.setItem(KEY, JSON.stringify(current)); }
    },
    removeItem(key) {
      if (!isDemo()) { window[kind].removeItem(key); return; }
      const current = readDemo();
      if (current) { delete current.values[key]; window.sessionStorage.setItem(KEY, JSON.stringify(current)); }
    },
  };
}
export const localStore = storage('localStorage');
export const sessionStore = storage('sessionStorage');
