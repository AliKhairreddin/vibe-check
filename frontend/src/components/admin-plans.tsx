import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listOfferCatalog } from '@/lib/api';
import { createAdvertiser, getAdminPlans, resetAdvertiserInvite, setAdminPlan, type BillingStatus, type Plan } from '@/lib/workspace-api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select } from './ui/select';

type WorkspacePlan = Plan & { name: string; billing?: BillingStatus };
function PlanEditor({ value }: { value: WorkspacePlan }) {
  const [plan, setPlan] = useState(value.plan);
  const [publishers, setPublishers] = useState(value.publisherLimit);
  const [reviews, setReviews] = useState(value.monthlyReviewLimit);
  const [confirmReset, setConfirmReset] = useState(false);
  const cache = useQueryClient();
  const paid = value.billing?.accessMode === 'subscription';
  const mutation = useMutation({ mutationFn: () => setAdminPlan(value.clientId, plan, publishers, reviews), onSuccess: () => { void cache.invalidateQueries({ queryKey: ['admin-plans'] }); } });
  const invite = useMutation({ mutationFn: () => resetAdvertiserInvite(value.clientId), onSuccess: () => setConfirmReset(false) });
  return <div className="grid gap-4 rounded-xl border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{value.name}</h3><p className="mt-1 text-xs text-muted-foreground">{value.publishers} publisher teams · {value.monthlyReviews} submissions this month</p></div><span className="rounded-full border px-3 py-1 text-xs">{paid ? `Subscription · ${value.billing?.status.replace(/_/g, ' ')}` : 'Existing workspace · Free access'}</span></div>
    {paid ? <><p className="text-sm text-muted-foreground">Stripe controls this workspace’s paid access and plan allowances. Login setup does not grant app access before payment.</p><Button className="w-fit" variant="outline" onClick={() => setConfirmReset(true)}>New login setup link</Button>{confirmReset ? <div className="grid gap-3 rounded-lg border p-4"><p className="text-sm">Reset this advertiser’s login? Their current password and sessions will stop working until they use the new link.</p><div className="flex gap-2"><Button variant="destructive" disabled={invite.isPending} onClick={() => invite.mutate()}>Reset login</Button><Button variant="outline" onClick={() => setConfirmReset(false)}>Cancel</Button></div></div> : null}{invite.data ? <div className="grid gap-2"><Label>Private setup link · expires in 7 days</Label><Input readOnly value={invite.data.invite_url} onFocus={e => e.target.select()} /></div> : null}{invite.error ? <p role="alert" className="text-sm text-destructive">{invite.error.message}</p> : null}</> : <p className="text-sm text-muted-foreground">No card or subscription is required. Changing allowances here preserves the free-access exemption.</p>}
    {!paid || value.plan === 'enterprise' ? <form className="grid gap-4" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}><div className="grid gap-4 sm:grid-cols-3"><div className="grid gap-2"><Label htmlFor={`${value.clientId}-plan`}>Allocation</Label><Select id={`${value.clientId}-plan`} className="w-full" value={plan} onValueChange={next => setPlan(next as Plan['plan'])} options={paid ? [{ value: 'enterprise', label: 'Enterprise · custom' }] : [
      { value: 'pilot', label: 'Pilot · 5 publishers / 250 reviews' }, { value: 'starter', label: 'Starter · 5 publishers / 250 reviews' }, { value: 'growth', label: 'Growth · 25 publishers / 1,000 reviews' }, { value: 'enterprise', label: 'Enterprise · custom' },
    ]} /></div>{plan === 'enterprise' ? <><div className="grid gap-2"><Label htmlFor={`${value.clientId}-publishers`}>Publisher limit</Label><Input id={`${value.clientId}-publishers`} type="number" min={1} max={1000} required value={publishers} onChange={event => setPublishers(Number(event.target.value))} /></div><div className="grid gap-2"><Label htmlFor={`${value.clientId}-reviews`}>Monthly review limit</Label><Input id={`${value.clientId}-reviews`} type="number" min={1} max={10000} required value={reviews} onChange={event => setReviews(Number(event.target.value))} /></div></> : null}</div><Button type="submit" className="w-fit" disabled={mutation.isPending}>Save allocation</Button>{mutation.error ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : mutation.isSuccess ? <p role="status" className="text-sm text-emerald-700">Workspace allocation saved.</p> : null}</form> : null}
  </div>;
}
function CreateAdvertiser({ workspaces }: { workspaces: WorkspacePlan[] }) {
  const [clientId, setClientId] = useState('');
  const [category, setCategory] = useState('Advertising');
  const catalog = useQuery({ queryKey: ['billing-offer-catalog'], queryFn: listOfferCatalog });
  const cache = useQueryClient();
  const create = useMutation({ mutationFn: () => createAdvertiser(clientId, category), onSuccess: () => { setClientId(''); void cache.invalidateQueries({ queryKey: ['admin-plans'] }); } });
  const available = (catalog.data ?? []).filter(offer => offer.enabled && offer.configured && !workspaces.some(w => w.clientId === offer.offer_id));
  function submit(event: FormEvent) { event.preventDefault(); create.mutate(); }
  return <form className="grid gap-4 rounded-xl border bg-card p-5" onSubmit={submit}><div><h3 className="font-semibold">Create a paid advertiser workspace</h3><p className="mt-1 text-sm text-muted-foreground">Configure the advertiser’s offer and guidelines first, then create their login invitation. All new workspaces require a paid subscription.</p></div><div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-2"><Label htmlFor="new-advertiser-offer">Advertiser offer</Label><Select id="new-advertiser-offer" value={clientId} onValueChange={value => setClientId(String(value))} options={[{ value: '', label: 'Choose a configured offer' }, ...available.map(offer => ({ value: offer.offer_id, label: offer.display_name }))]} /></div><div className="grid gap-2"><Label htmlFor="new-advertiser-category">Category</Label><Input id="new-advertiser-category" required maxLength={100} value={category} onChange={e => setCategory(e.target.value)} /></div></div>{catalog.error ? <p role="alert" className="text-sm text-destructive">{catalog.error.message}</p> : !catalog.isLoading && !available.length ? <p className="text-sm text-muted-foreground">No unassigned configured offers. Add the new offer in Offer guidelines first.</p> : null}<Button className="w-fit" disabled={!clientId || create.isPending}>{create.isPending ? 'Creating…' : 'Create workspace invitation'}</Button>{create.error ? <p role="alert" className="text-sm text-destructive">{create.error.message}</p> : null}{create.data ? <div className="grid gap-2 rounded-lg border p-4"><p className="text-sm">Login: {create.data.username}. Share this private setup link with the advertiser; it expires in 7 days.</p><Input aria-label="Advertiser setup link" readOnly value={create.data.invite_url} onFocus={e => e.target.select()} /></div> : null}</form>;
}
export function AdminPlansPanel() {
  const query = useQuery({ queryKey: ['admin-plans'], queryFn: getAdminPlans });
  return <div className="grid gap-4"><div><h2 className="text-xl font-semibold">Advertiser plans</h2><p className="mt-2 text-sm text-muted-foreground">Existing workspaces keep free access. New advertisers subscribe through Stripe; publisher teams are included.</p></div>{query.isLoading ? <p>Loading allocations…</p> : query.error ? <p role="alert" className="text-destructive">{query.error.message}</p> : query.data ? <><CreateAdvertiser workspaces={query.data} />{query.data.map(plan => <PlanEditor key={`${plan.clientId}:${plan.plan}:${plan.publisherLimit}:${plan.monthlyReviewLimit}`} value={plan} />)}</> : null}</div>;
}
