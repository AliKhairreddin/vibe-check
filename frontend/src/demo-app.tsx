import { configureDemoUi, clearDemoUi } from '@/lib/browser-storage';
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Building2, CheckCircle2, Clock3, FlaskConical, LoaderCircle, ScanSearch, ShieldCheck, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { demoControl, DemoControlError, demoHome, type DemoRole, type DemoSession } from '@/lib/demo';

const experiences: { role: DemoRole; name: string; description: string; icon: typeof Users }[] = [
  { role: 'publisher', name: 'Publisher', description: 'Submit a creative, inspect its findings, and release it to your advertiser.', icon: ScanSearch },
  { role: 'advertiser', name: 'Advertiser', description: 'Review publisher submissions, record decisions, and manage your publisher teams.', icon: Building2 },
  { role: 'owner', name: 'Administrator', description: 'Explore campaign history, edit offer policies, and manage workspace plans.', icon: ShieldCheck },
  { role: 'employee', name: 'Employee', description: 'Run and inspect reviews with the submission tools available to your team.', icon: Users },
];
function DemoWelcome({ initial, expired }: { initial: DemoSession | null; expired: boolean }) {
  const [busy, setBusy] = useState<DemoRole | null>(null);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState(false);
  async function open(role: DemoRole) {
    setBusy(role); setError('');
    try {
      if (initial && !fresh) await demoControl('role', 'PUT', { role });
      else await demoControl('session', 'POST', { role });
      window.location.assign(demoHome(role));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Please try again.'); setBusy(null); }
  }
  return <main className="min-h-svh bg-[#f7faf8] px-5 py-8 text-zinc-950 sm:px-8 sm:py-14">
    <div className="mx-auto max-w-4xl"><a href="https://adchecked.com" className="inline-flex items-center gap-2 text-lg font-semibold"><ScanSearch className="size-7" />AdChecked</a>
      <div className="mt-12 max-w-2xl"><p className="flex items-center gap-2 text-sm font-medium text-emerald-800"><FlaskConical className="size-4" />Your own demo workspace</p><h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">Try the workflow.<br />Take any seat.</h1><p className="mt-5 text-base leading-7 text-zinc-600">Explore a fictional insurance campaign from first review to final decision. No signup or credit card. Your changes stay private and are deleted after 24 hours.</p></div>
      {expired ? <p role="status" className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">Your demo session has ended. Choose an experience to start with fresh sample data.</p> : null}
      <div className="mt-9 grid gap-4 sm:grid-cols-2">{experiences.map(({ role, name, description, icon: Icon }) => <Card key={role} className="border-zinc-200 bg-white text-zinc-950"><CardContent className="flex h-full flex-col gap-4 pt-6"><span className="grid size-10 place-items-center rounded-xl bg-emerald-50 text-emerald-800"><Icon className="size-5" /></span><div><h2 className="text-lg font-semibold">{name}</h2><p className="mt-2 text-sm leading-6 text-zinc-600">{description}</p></div><Button className="mt-auto w-full" disabled={Boolean(busy)} onClick={() => void open(role)}>{busy === role ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}Explore as {name.toLowerCase()}</Button></CardContent></Card>)}</div>
      {initial ? <label className="mt-6 flex items-start gap-3 text-sm text-zinc-700"><input className="mt-0.5 size-4" type="checkbox" checked={fresh} onChange={e => setFresh(e.target.checked)} />Start a fresh workspace instead of continuing this session</label> : null}
      {error ? <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      <div className="mt-8 grid gap-3 border-t border-zinc-200 pt-6 text-sm text-zinc-600 sm:grid-cols-2"><p className="flex items-center gap-2"><Clock3 className="size-4 shrink-0" />Automatically expires after 24 hours</p><p className="flex items-center gap-2"><CheckCircle2 className="size-4 shrink-0" />Fictional data, simulated external actions</p></div>
      <p className="mt-5 text-xs leading-5 text-zinc-500">Reviews use illustrative results. Files are not uploaded or analyzed. Emails, public sharing, integrations, and payments are not sent or executed. Real accounts start with clean data.</p>
    </div>
  </main>;
}
function DemoBanner({ session }: { session: DemoSession }) {
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15000);
    const observer = new ResizeObserver(() => document.documentElement.style.setProperty('--demo-banner-height', `${ref.current?.offsetHeight ?? 0}px`));
    if (ref.current) observer.observe(ref.current);
    return () => { clearInterval(interval); observer.disconnect(); };
  }, []);
  const remaining = Math.max(0, Math.ceil((session.expiresAt - now) / 3600000));
  useEffect(() => { if (now >= session.expiresAt) { clearDemoUi(); window.location.replace('/demo?expired=1'); } }, [now, session.expiresAt]);
  return <div ref={ref} className="demo-banner border-b border-emerald-800/20 bg-emerald-950 px-4 py-2.5 text-white sm:px-6" role="region" aria-label="Demo workspace">
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2"><div className="min-w-0 text-sm"><span className="inline-flex items-center gap-2 font-semibold"><FlaskConical className="size-4" />Demo workspace</span><span className="ml-3 text-emerald-100">{experiences.find(e => e.role === session.role)?.name} · Fictional data · <span className="whitespace-nowrap">{remaining}h left</span></span><p className="mt-1 text-xs text-emerald-100">Changes stay in your session. Reviews and external actions are simulated.</p></div><div className="flex flex-wrap items-center gap-3 text-xs font-medium"><a href="/demo" className="rounded px-1 py-2 underline underline-offset-4">Switch experience</a><a href="/demo/signup" className="rounded-lg bg-white px-3 py-2 text-emerald-950">Create your account <span aria-hidden>↗</span></a></div></div>
  </div>;
}
export async function mountDemoApp(root: HTMLElement) {
  document.title = 'Explore the demo · AdChecked';
  if (window.location.pathname === '/demo/signup') { window.location.replace(window.location.hostname.endsWith('adchecked.com') ? 'https://app.adchecked.com/signup?from=demo' : '/signup?from=demo'); return; }
  let session: DemoSession | null = null;
  try { session = await demoControl('session'); } catch (error) {
    if (!(error instanceof DemoControlError && error.status === 401)) {
      createRoot(root).render(<main className="grid min-h-svh place-items-center p-6"><div className="grid max-w-md gap-4"><h1 className="text-2xl font-semibold">Demo temporarily unavailable</h1><p className="text-sm text-muted-foreground">Your workspace could not be loaded. Retry to continue your session.</p><Button onClick={() => window.location.reload()}>Try again</Button></div></main>);
      return;
    }
    clearDemoUi();
  }
  if (!session || window.location.pathname === '/demo' || window.location.pathname === '/demo/') {
    createRoot(root).render(<DemoWelcome initial={session} expired={new URLSearchParams(window.location.search).has('expired') || window.location.pathname.startsWith('/demo/workspace')} />); return;
  }
  configureDemoUi(session);
  document.documentElement.dataset.demo = 'true';
  const banner = document.createElement('div');
  banner.className = 'demo-banner-host';
  const workspace = document.createElement('div');
  root.append(banner, workspace);
  createRoot(banner).render(<DemoBanner session={session} />);
  if (session.role === 'owner' || session.role === 'employee') (await import('./admin-app')).mountAdminApp(workspace);
  else (await import('./client-app')).mountClientApp(workspace);
}
