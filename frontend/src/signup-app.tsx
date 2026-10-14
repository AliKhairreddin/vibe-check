import { createRoot } from 'react-dom/client';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, CheckCircle2, LoaderCircle, ScanSearch } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getClientSession, requestJson, clearClientSession, type ClientSession } from '@/lib/api';
import { getBilling, startCheckout } from '@/lib/workspace-api';
import { clearDemoUi } from '@/lib/browser-storage';

const params = new URLSearchParams(window.location.search);
const plan = params.get('plan');
const selectedPlan = plan === 'starter' || plan === 'growth' ? plan : null;
const interval = params.get('interval') === 'year' ? 'year' : 'month';
function clientPath(path: string) {
  const url = new URL(path, window.location.origin);
  if (['localhost', '127.0.0.1'].includes(window.location.hostname)) url.searchParams.set('surface', 'client');
  return url.pathname + url.search;
}

function SignupPage() {
  const [session, setSession] = useState<ClientSession | null>(null);
  const [paid, setPaid] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(true);
  const [created, setCreated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => { void getClientSession().then(setSession).catch(() => {}).finally(() => setChecking(false)); }, []);

  useEffect(() => {
    let active = true;
    setPaid(null);
    const portal = session?.portals[0];
    if (selectedPlan && session?.role === 'client' && portal?.billing_required) {
      void getBilling(portal.client_id).then(status => { if (active) setPaid(status.allowed); }).catch(() => {});
    }
    return () => { active = false; };
  }, [session]);

  async function checkout(account: ClientSession) {
    if (!selectedPlan) { window.location.assign(clientPath('/client/setup')); return; }
    const portal = account.portals[0];
    if (!portal?.billing_required) { window.location.assign(clientPath('/client')); return; }
    const billing = await getBilling(portal.client_id);
    if (billing.allowed) { window.location.assign(clientPath('/client')); return; }
    const result = await startCheckout(portal.client_id, selectedPlan, interval);
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('Checkout is temporarily unavailable. Your account has been created.');
    window.location.assign(result.url);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (password !== confirmation) { setError('The passwords don’t match. Please check them and try again.'); return; }
    setBusy(true);
    try {
      const account = await requestJson<ClientSession>('/api/client/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_name: workspace.trim(), email: email.trim(), password }) });
      setSession(account); setCreated(true); setPassword(''); setConfirmation('');
      // Demo state is a separate capability. Cleanup never copies or upgrades it.
      try { clearDemoUi(); } catch { /* Storage may be unavailable. */ }
      void fetch('/api/demo/session', { method: 'DELETE', keepalive: true }).catch(() => {});
      await checkout(account);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'We couldn’t create your account. Please try again.'); }
    finally { setBusy(false); }
  }
  async function retryCheckout() {
    if (!session || busy) return;
    setBusy(true); setError('');
    try { await checkout(session); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Checkout is temporarily unavailable.'); } finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError('');
    try { await clearClientSession(); setSession(null); setCreated(false); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Please try again.'); } finally { setBusy(false); }
  }
  return <main className="min-h-svh bg-[#f7faf8] px-5 py-8 text-zinc-950 sm:px-8 sm:py-14">
    <div className="mx-auto max-w-5xl"><a href="https://adchecked.com" className="inline-flex items-center gap-2 text-lg font-semibold"><ScanSearch className="size-7" />AdChecked</a>
      <div className="mt-10 grid items-start gap-10 lg:mt-16 lg:grid-cols-2 lg:gap-20">
        <div className="max-w-lg"><p className="text-sm font-medium text-emerald-800">Your workspace, ready to build</p><h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight">Create your account</h1><p className="mt-5 text-base leading-7 text-zinc-600">Bring your policies, invite your publisher teams, and keep every creative review in one place.</p><ul className="mt-7 grid gap-4 text-sm leading-6 text-zinc-700">{['A private advertiser workspace for your team', 'A clean start — no demo records or decisions', 'No card required to create your account'].map(text => <li key={text} className="flex gap-3"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />{text}</li>)}</ul><p className="mt-7 text-sm leading-6 text-zinc-500">A paid subscription is required to run reviews. Publisher and employee access is managed by the workspace that invites them.</p><a className="mt-6 inline-block text-sm font-medium underline underline-offset-4" href="/demo">{params.get('from') === 'demo' ? 'Back to your demo' : 'Explore the demo first'}</a></div>
        <section aria-label="Create account" className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          {checking ? <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />Checking your session…</p> : session ? <div className="grid gap-5"><h2 className="text-xl font-semibold">{created ? 'Your account is ready' : 'You’re already signed in'}</h2><p className="break-words text-sm leading-6 text-zinc-600">{session.username}<br />{session.portals[0]?.display_name}</p>{created ? <p className="text-sm leading-6 text-zinc-600">Your clean workspace is saved. You can set up your review guidelines now, or continue to your subscription.</p> : null}{selectedPlan && session.role === 'client' && session.portals[0]?.billing_required && paid === false ? <Button disabled={busy} onClick={() => void retryCheckout()}>{busy ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}Continue to checkout</Button> : null}<a className={buttonVariants()} href={clientPath(created ? '/client/setup' : selectedPlan && session.portals[0]?.billing_required ? `/client/plan?plan=${selectedPlan}&interval=${interval}` : '/client')}>{created ? 'Set up your workspace' : 'Open your workspace'}</a>{!created ? <Button variant="outline" disabled={busy} onClick={() => void signOut()}>Sign out to create another account</Button> : null}</div> : <form className="grid gap-5" onSubmit={event => void submit(event)}>
            <div className="grid gap-2"><Label htmlFor="signup-workspace">Workspace name</Label><Input id="signup-workspace" autoComplete="organization" required minLength={2} maxLength={100} value={workspace} onChange={e => setWorkspace(e.target.value)} disabled={busy} placeholder="Your company or team" /></div>
            <div className="grid gap-2"><Label htmlFor="signup-email">Email address</Label><Input id="signup-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} /><p className="text-xs text-zinc-500">You’ll use this email to sign in.</p></div>
            <div className="grid gap-2"><Label htmlFor="signup-password">Password</Label><Input id="signup-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} aria-describedby="password-hint" /><p id="password-hint" className="text-xs text-zinc-500">Use at least 12 characters.</p></div>
            <div className="grid gap-2"><Label htmlFor="signup-confirm">Confirm password</Label><Input id="signup-confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} /></div>
            {selectedPlan ? <p className="rounded-lg bg-emerald-50 p-3 text-sm leading-6 text-emerald-950">Continue to {selectedPlan === 'starter' ? 'Starter' : 'Growth'} · ${((selectedPlan === 'starter' ? 599 : 1999) * (interval === 'year' ? 10 : 1)).toLocaleString()} USD / {interval === 'year' ? 'year' : 'month'} after signup. You’ll confirm your subscription and payment securely at checkout.</p> : null}
            <Button type="submit" size="lg" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}{busy ? 'Creating your account…' : selectedPlan ? 'Create account & checkout' : 'Create your account'}</Button><p className="text-center text-sm text-zinc-600">Already have an account? <a href={clientPath(selectedPlan ? `/login?plan=${selectedPlan}&interval=${interval}` : '/login')} className="font-medium text-zinc-950 underline underline-offset-4">Sign in</a></p>
          </form>}
          {error ? <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">{error}</p> : null}
        </section>
      </div>
    </div>
  </main>;
}
export function mountSignupApp(element: HTMLElement) { document.title = 'Create your account · AdChecked'; createRoot(element).render(<SignupPage />); }
