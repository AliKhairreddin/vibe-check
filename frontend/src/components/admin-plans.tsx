import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAdminPlans, setAdminPlan, type Plan } from '@/lib/workspace-api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

function PlanEditor({ value }: { value: Plan & { name: string } }) {
  const [plan, setPlan] = useState(value.plan);
  const [publishers, setPublishers] = useState(value.publisherLimit);
  const [reviews, setReviews] = useState(value.monthlyReviewLimit);
  const cache = useQueryClient();
  const mutation = useMutation({ mutationFn: () => setAdminPlan(value.clientId, plan, publishers, reviews), onSuccess: () => { void cache.invalidateQueries({ queryKey: ['admin-plans'] }); } });
  return <form className="grid gap-4 rounded-xl border bg-card p-5" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}><div><h3 className="font-semibold">{value.name}</h3><p className="mt-1 text-xs text-muted-foreground">{value.publishers} publisher teams · {value.monthlyReviews} submissions this month</p></div><div className="grid gap-4 sm:grid-cols-3"><div className="grid gap-2"><Label htmlFor={`${value.clientId}-plan`}>Plan</Label><select id={`${value.clientId}-plan`} className="h-9 rounded-md border bg-background px-2 text-sm" value={plan} onChange={event => setPlan(event.target.value as Plan['plan'])}><option value="pilot">Pilot · 5 publishers / 250 reviews</option><option value="starter">Starter · 5 publishers / 250 reviews</option><option value="growth">Growth · 25 publishers / 1,000 reviews</option><option value="enterprise">Enterprise · custom</option></select></div>{plan === 'enterprise' ? <><div className="grid gap-2"><Label htmlFor={`${value.clientId}-publishers`}>Publisher limit</Label><Input id={`${value.clientId}-publishers`} type="number" min={1} max={1000} required value={publishers} onChange={event => setPublishers(Number(event.target.value))} /></div><div className="grid gap-2"><Label htmlFor={`${value.clientId}-reviews`}>Monthly review limit</Label><Input id={`${value.clientId}-reviews`} type="number" min={1} max={10000} required value={reviews} onChange={event => setReviews(Number(event.target.value))} /></div></> : null}</div><Button type="submit" className="w-fit" disabled={mutation.isPending}>Save allocation</Button>{mutation.error ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : mutation.isSuccess ? <p role="status" className="text-sm text-emerald-700">Workspace allocation saved.</p> : null}</form>;
}
export function AdminPlansPanel() {
  const query = useQuery({ queryKey: ['admin-plans'], queryFn: getAdminPlans });
  return <div className="grid gap-4"><div><h2 className="text-xl font-semibold">Advertiser plans</h2><p className="mt-2 text-sm text-muted-foreground">Activate agreed plans and capacity after arranging payment with the advertiser. These controls enforce workspace allowances; they do not charge a card.</p></div>{query.isLoading ? <p>Loading allocations…</p> : query.error ? <p role="alert" className="text-destructive">{query.error.message}</p> : query.data?.map(plan => <PlanEditor key={`${plan.clientId}:${plan.plan}:${plan.publisherLimit}:${plan.monthlyReviewLimit}`} value={plan} />)}</div>;
}
