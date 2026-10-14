import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react';
import { ClientPortalFrame, useClientAuth } from './client-dashboard';
import { useWorkspace } from './workspace-context';
import { Button, buttonVariants } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { getWorkspaceSetup, saveWorkspaceSetup, type WorkspaceSetup } from '@/lib/workspace-api';

function PolicyForm({ clientId, initial }: { clientId: string; initial: WorkspaceSetup }) {
  const [guidelines, setGuidelines] = useState(initial.official_guidelines);
  const cache = useQueryClient();
  const save = useMutation({ mutationFn: () => saveWorkspaceSetup(clientId, guidelines), onSuccess: data => { setGuidelines(data.official_guidelines); cache.setQueryData(['workspace-setup', clientId], data); } });
  function submit(event: FormEvent) { event.preventDefault(); if (!save.isPending) save.mutate(); }
  return <form className="grid gap-5" onSubmit={submit}><div className="grid gap-2"><Label htmlFor="workspace-guidelines">Official review guidelines</Label><Textarea id="workspace-guidelines" className="min-h-64" maxLength={12000} value={guidelines} onChange={e => { setGuidelines(e.target.value); save.reset(); }} disabled={save.isPending} placeholder="Add the claims, disclosures, and creative requirements your team reviews against." /><p className="text-xs leading-5 text-muted-foreground">These guidelines apply to your workspace only. Add your own approved policies before running reviews. Clearing this field pauses the policy.</p></div><div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}Save guidelines</Button>{save.isSuccess ? <p role="status" className="flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="size-4" />{save.data.configured ? 'Guidelines saved' : 'Policy paused'}</p> : null}</div>{save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}</form>;
}
export function WorkspaceSetupPage() {
  const { session } = useClientAuth();
  const { clientId } = useWorkspace();
  const portal = session.portals.find(p => p.client_id === clientId);
  const allowed = session.role === 'client' && portal?.self_serve === true;
  const query = useQuery({ queryKey: ['workspace-setup', clientId], queryFn: () => getWorkspaceSetup(clientId), enabled: allowed });
  return <ClientPortalFrame workspaceName={portal?.display_name}><div className="mx-auto grid w-full max-w-3xl gap-6"><section className="grid gap-2"><p className="text-sm font-medium text-muted-foreground">{portal?.display_name}</p><h1 className="text-3xl font-semibold tracking-tight">Set up your workspace</h1><p className="max-w-2xl text-sm leading-6 text-muted-foreground">Add your review guidelines, then choose a subscription when you’re ready to review creatives. Demo data and activity are never imported into your account.</p></section>{!allowed ? <p>This workspace does not use self-serve setup.</p> : query.error ? <p role="alert">{query.error.message}</p> : !query.data ? <p role="status">Loading your workspace…</p> : <><Card><CardHeader><CardTitle>Your review policy</CardTitle><CardDescription>Your team’s guidelines stay saved, even before you subscribe.</CardDescription></CardHeader><CardContent><PolicyForm key={clientId} clientId={clientId} initial={query.data} /></CardContent></Card><Card><CardHeader><CardTitle>Ready for your first review?</CardTitle><CardDescription>Choose a plan to start reviews and invite your publisher teams. Your existing subscription, if any, stays unchanged.</CardDescription></CardHeader><CardContent><Link to="/client/plan" className={buttonVariants({ variant: 'outline' })}>Choose or manage your plan</Link></CardContent></Card></>}</div></ClientPortalFrame>;
}
