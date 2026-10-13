import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, ShieldCheck } from 'lucide-react';
import type { ClientSession } from '@/lib/api';
import { getBilling, openBillingPortal, refreshBilling, startCheckout, type BillingStatus } from '@/lib/workspace-api';
import { isDemo } from '@/lib/demo';
import { useWorkspace } from './workspace-context';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Select } from './ui/select';

function useBilling(clientId: string, required: boolean) {
  return useQuery({ queryKey: ['billing', clientId], queryFn: () => getBilling(clientId), enabled: required && !isDemo(), retry: 1, staleTime: 5000, refetchInterval: 15000 });
}
function BillingDetails({ clientId, state, publisher = false }: { clientId: string; state: BillingStatus; publisher?: boolean }) {
  const [yearly, setYearly] = useState(false);
  const cache = useQueryClient();
  const action = useMutation({ mutationFn: async (kind: 'starter' | 'growth' | 'portal' | 'refresh') => {
    if (kind === 'refresh') { await refreshBilling(clientId); await cache.invalidateQueries({ queryKey: ['billing', clientId] }); return; }
    const result = kind === 'portal' ? await openBillingPortal(clientId) : await startCheckout(clientId, kind, yearly ? 'year' : 'month');
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || !['checkout.stripe.com', 'billing.stripe.com'].includes(url.hostname)) throw new Error('Unexpected billing destination. Contact AdChecked.');
    window.location.assign(result.url);
  } });
  const canSubscribe = ['none', 'canceled', 'incomplete_expired', 'deleted'].includes(state.status);
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><CreditCard className="size-5" />{state.allowed ? 'Your subscription' : 'Activate your advertiser workspace'}</CardTitle><CardDescription>{publisher ? 'Your advertiser manages the subscription. Publisher teams do not pay separately.' : state.allowed ? 'Manage payment details and cancellation securely with Stripe.' : 'Choose a subscription to use your workspace. Your publisher teams are included.'}</CardDescription></CardHeader><CardContent className="grid gap-5">
    {state.isTest ? <p className="rounded-lg border p-3 text-sm">Test workspace · No live charges or real customer access.</p> : null}
    <div className="text-sm"><p className="font-medium capitalize">{state.status === 'none' ? 'Subscription required' : state.status.replace(/_/g, ' ')}</p>{state.paidThrough ? <p className="mt-1 text-muted-foreground">{state.cancelAtPeriodEnd ? 'Access ends' : 'Paid through'} {new Date(state.paidThrough).toLocaleDateString()}</p> : null}</div>
    {state.syncError ? <p role="status" className="text-sm text-muted-foreground">The latest billing update is delayed. Your last confirmed payment is preserved.</p> : null}
    {!publisher && new URLSearchParams(window.location.search).get('checkout') === 'success' && !state.allowed ? <p role="status" className="rounded-lg border p-3 text-sm">We’re waiting for Stripe to confirm your subscription. This page checks automatically.</p> : null}
    {!publisher && canSubscribe ? state.checkoutReady ? <>
      <div className="flex flex-wrap items-center gap-3"><Button variant={yearly ? 'outline' : 'default'} onClick={() => setYearly(false)} aria-pressed={!yearly}>Monthly</Button><Button variant={yearly ? 'default' : 'outline'} onClick={() => setYearly(true)} aria-pressed={yearly}>Yearly · 2 months free</Button></div>
      <div className="grid gap-3 sm:grid-cols-2">{(['starter', 'growth'] as const).map(plan => {
        const monthly = plan === 'starter' ? 599 : 1999;
        const available = state.plans.some(p => p.plan === plan && p.interval === (yearly ? 'year' : 'month'));
        return <div className="grid gap-3 rounded-xl border p-4" key={plan}><h3 className="font-semibold capitalize">{plan}</h3><p className="text-2xl font-semibold">${(monthly * (yearly ? 10 : 1)).toLocaleString()} <span className="text-sm font-normal text-muted-foreground">USD / {yearly ? 'year' : 'month'}</span></p><p className="text-sm text-muted-foreground">{plan === 'starter' ? '5 publisher teams · 250 reviews/month' : '25 publisher teams · 1,000 reviews/month'}</p><Button disabled={!available || action.isPending} onClick={() => action.mutate(plan)}>Subscribe to {plan === 'starter' ? 'Starter' : 'Growth'}</Button></div>;
      })}</div>
      <p className="text-xs leading-5 text-muted-foreground">Tax is calculated at checkout. Subscriptions renew automatically until canceled. Payments are sold through Link, Stripe’s merchant of record. Review limits reset each calendar month (UTC). No automatic overage charges.</p>
    </> : <p className="text-sm text-muted-foreground">Live checkout is being prepared. Contact <a className="underline" href="mailto:hello@adchecked.com">hello@adchecked.com</a> to finish activation.</p> : null}
    {!publisher ? <div className="flex flex-wrap gap-2">{state.hasCustomer ? <Button variant="outline" disabled={action.isPending || !state.checkoutReady} onClick={() => action.mutate('portal')}>Manage billing</Button> : null}<Button variant="outline" disabled={action.isPending} onClick={() => action.mutate('refresh')}>{action.isPending ? 'Updating…' : 'Check payment status'}</Button></div> : <p className="text-sm">Ask your advertiser to activate or update their subscription to restore workspace access.</p>}
    {action.error ? <p role="alert" className="text-sm text-destructive">{action.error.message}</p> : null}
  </CardContent></Card>;
}
export function BillingPanel({ clientId, required, publisher = false }: { clientId: string; required: boolean; publisher?: boolean }) {
  const query = useBilling(clientId, required);
  if (!required) return <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />Existing workspace · Free access</CardTitle><CardDescription>Your existing access is preserved. No payment method or Stripe subscription is required. Your current workspace allowances still apply.</CardDescription></CardHeader></Card>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return <p>Checking billing…</p>;
  return <BillingDetails clientId={clientId} state={query.data} publisher={publisher} />;
}
export function BillingGate({ session, logout, children }: { session: ClientSession; logout: () => Promise<void>; children: ReactNode }) {
  const { clientId, setClientId } = useWorkspace();
  const required = session.portals.find(p => p.client_id === clientId)?.billing_required === true;
  const query = useBilling(clientId, required);
  if (!required || isDemo() || query.data?.allowed) return children;
  return <div className="min-h-screen bg-muted/20 px-5 py-8"><div className="mx-auto grid max-w-3xl gap-6"><div className="flex flex-wrap items-center justify-between gap-4"><a className="text-lg font-semibold" href="https://adchecked.com">AdChecked</a><Button variant="outline" onClick={() => void logout()}>Sign out</Button></div>{session.portals.length > 1 ? <Select value={clientId} onValueChange={value => setClientId(String(value))} options={session.portals.map(p => ({ value: p.client_id, label: p.display_name }))} /> : <h1 className="text-2xl font-semibold">{session.portals[0]?.display_name}</h1>}{query.error ? <div role="alert" className="rounded-xl border bg-card p-6"><p>We couldn’t check workspace access. Please try again.</p><Button className="mt-4" onClick={() => void query.refetch()}>Retry</Button></div> : query.data ? <BillingDetails clientId={clientId} state={query.data} publisher={session.role === 'publisher'} /> : <p>Checking workspace access…</p>}</div></div>;
}
