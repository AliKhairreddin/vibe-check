import { ReleaseButton } from './release-controls';
import { Select } from '@/components/ui/select';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Copy, LoaderCircle, Plus, Upload, Users } from 'lucide-react';
import { ClientPortalFrame, useClientAuth } from './client-dashboard';
import { useWorkspace } from './workspace-context';
import { ShareButton, SharedLinksPanel } from './share-controls';
import { Button, buttonVariants } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';
import { createReview } from '@/lib/api';
import { DeleteSubmissionButton } from './release-controls';
import { createPublisher, invitePublisher, listPublishers, suspendPublisher, listSubmissions, getPlan, type Invitation } from '@/lib/workspace-api';

export function InvitationResult({ invitation }: { invitation: Invitation }) {
  const [copied, setCopied] = useState(false);
  return <div className="grid gap-3 rounded-xl border border-emerald-600/40 bg-emerald-50/50 p-4"><p className="flex items-center gap-2 text-sm font-semibold"><CheckCircle2 className="size-4" />Publisher setup link ready</p><p className="text-sm">Send this link to the publisher. They choose their own password. The link expires in 7 days and can be used once.</p><p className="break-all text-xs text-muted-foreground">Login: {invitation.username}</p><div className="flex flex-wrap gap-2"><Input className="min-w-0 flex-1" aria-label="Publisher invitation link" readOnly value={invitation.invite_url} onFocus={event => event.target.select()} /><Button variant="outline" onClick={() => void navigator.clipboard.writeText(invitation.invite_url).then(() => setCopied(true)).catch(() => setCopied(false))}><Copy />{copied ? 'Copied' : 'Copy link'}</Button></div></div>;
}
export function PublishersPage() {
  const { session } = useClientAuth();
  const { clientId, setPublisherId } = useWorkspace();
  const cache = useQueryClient();
  const [name, setName] = useState('');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [pendingAction, setPendingAction] = useState<{ id: string; name: string; action: 'suspend' | 'invite' } | null>(null);
  const isManager = session.role !== 'publisher';
  const query = useQuery({ queryKey: ['publishers', clientId], queryFn: () => listPublishers(clientId), enabled: isManager });
  const mutation = useMutation({ mutationFn: (input: { action: 'create' | 'invite' | 'suspend'; id?: string }) => input.action === 'create' ? createPublisher(clientId, name.trim()) : input.action === 'invite' ? invitePublisher(clientId, input.id!) : suspendPublisher(clientId, input.id!).then(() => null), onSuccess: result => { setInvitation(result); setName(''); setPendingAction(null); void cache.invalidateQueries({ queryKey: ['publishers', clientId] }); void cache.invalidateQueries({ queryKey: ['plan', clientId] }); } });
  if (!isManager) return <ClientPortalFrame><p>Publisher management is available to the advertiser.</p></ClientPortalFrame>;
  const advertiser = session.portals.find(p => p.client_id === clientId)?.display_name;
  return <ClientPortalFrame><div className="mx-auto grid max-w-5xl gap-5"><div><p className="text-sm text-muted-foreground">{advertiser} · Publisher network</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Publishers</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Give each affiliate team its own login. Their uploads use your guidelines, and only your team and that publisher can see their workspace.</p></div>
    <Card><CardHeader><CardTitle>Add a publisher</CardTitle><CardDescription>Create a company workspace and a private setup link.</CardDescription></CardHeader><CardContent><form className="flex flex-col items-start gap-3 sm:flex-row sm:items-end" onSubmit={event => { event.preventDefault(); mutation.mutate({ action: 'create' }); }}><div className="grid w-full max-w-lg gap-2"><Label htmlFor="publisher-name">Publisher company name</Label><Input id="publisher-name" placeholder="e.g. Banana Team" minLength={2} maxLength={100} required value={name} onChange={event => setName(event.target.value)} /></div><Button type="submit" disabled={mutation.isPending || name.trim().length < 2}><Plus />Create publisher</Button></form></CardContent></Card>
    {invitation ? <InvitationResult key={invitation.invite_url} invitation={invitation} /> : null}
    {mutation.error ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : null}
    {pendingAction ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4"><p className="max-w-xl text-sm">{pendingAction.action === 'suspend' ? `Suspend ${pendingAction.name}? This signs them out and blocks uploads. Existing reviews stay available.` : `Create a new setup link for ${pendingAction.name}? Their existing login and previous setup link will stop working until they set a new password.`}</p><div className="flex gap-2"><Button variant="ghost" onClick={() => setPendingAction(null)}>Cancel</Button><Button disabled={mutation.isPending} onClick={() => mutation.mutate({ action: pendingAction.action, id: pendingAction.id })}>Confirm</Button></div></div> : null}
    {query.isLoading ? <p>Loading publishers…</p> : query.error ? <p role="alert" className="text-destructive">{query.error.message}</p> : !query.data?.length ? <div className="rounded-xl border border-dashed p-10 text-center"><Users className="mx-auto mb-3 text-muted-foreground" /><p className="font-medium">Your publisher network starts here</p><p className="mt-2 text-sm text-muted-foreground">Add the first team to give them a place to submit creatives.</p></div> : query.data.map(publisher => <div key={publisher.publisherId} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5"><div><p className="font-semibold">{publisher.name} <Badge className="ml-2" variant="outline">{publisher.status}</Badge></p><p className="mt-2 break-all text-xs text-muted-foreground">{publisher.username}</p></div><div className="flex flex-wrap gap-2"><Link to="/client/reviews" className={buttonVariants({ size: 'sm', variant: 'outline' })} onClick={() => setPublisherId(publisher.publisherId)}>View creatives</Link>{publisher.managedLogin ? <Badge variant="secondary">Organization login</Badge> : <Button size="sm" variant="outline" onClick={() => setPendingAction({ id: publisher.publisherId, name: publisher.name, action: 'invite' })}>New setup link</Button>}{publisher.status !== 'suspended' && !publisher.managedLogin ? <Button size="sm" variant="ghost" onClick={() => setPendingAction({ id: publisher.publisherId, name: publisher.name, action: 'suspend' })}>Suspend</Button> : null}</div></div>)}
  </div></ClientPortalFrame>;
}

export function PublisherUploadsPage() {
  const { session } = useClientAuth();
  const { clientId } = useWorkspace();
  const cache = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const query = useQuery({ queryKey: ['submissions', clientId], queryFn: () => listSubmissions(clientId), enabled: session.role === 'publisher', refetchInterval: 5000 });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const shared = new FormData(formElement);
    if (!files.length && !String(shared.get('ad_copy') ?? '').trim()) { setError('Choose a file or enter ad copy.'); return; }
    if (files.length > 100) { setError('Upload up to 100 creatives at a time.'); return; }
    if (files.some(file => file.size > 400 * 1024 * 1024)) { setError('Each file must be 400 MB or smaller.'); return; }
    setBusy(true); setError('');
    let completed = 0;
    const failedFiles: File[] = [];
    const failures: string[] = [];
    for (const [index, file] of (files.length ? files : [null]).entries()) {
      const form = new FormData();
      for (const key of ['ad_copy', 'notes', 'manual_transcript', 'vertical', 'frame_interval_seconds']) form.set(key, String(shared.get(key) ?? ''));
      form.set('scene_detection', shared.get('scene_detection') === 'on' ? 'true' : 'false');
      if (file) form.set('creative', file);
      try {
        await createReview(form, progress => setMessage(`Uploading ${index + 1} of ${files.length || 1}: ${progress}%`), `/api/client/${clientId}`);
        completed += 1;
        void cache.invalidateQueries({ queryKey: ['submissions', clientId] });
      } catch (reason) {
        if (file) failedFiles.push(file);
        failures.push(`${file?.name ?? 'Ad copy'}: ${reason instanceof Error ? reason.message : 'Upload failed'}`);
      }
    }
    setMessage(`${completed} creative${completed === 1 ? '' : 's'} submitted. Results stay private until you release them to your advertiser.`);
    if (failures.length) { setError(failures.join('\n')); setFiles(failedFiles); }
    else { setFiles([]); formElement.reset(); }
    setBusy(false);
  }
  const advertiser = session.portals.find(p => p.client_id === clientId)?.display_name;
  if (session.role !== 'publisher') return <ClientPortalFrame><p>Uploads are available inside publisher workspaces.</p></ClientPortalFrame>;
  return <ClientPortalFrame><div className="mx-auto grid max-w-6xl gap-6"><div><p className="text-sm text-muted-foreground">{advertiser} / {session.publisher_name}</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Uploads &amp; progress</h1><p className="mt-2 text-sm text-muted-foreground">Upload creatives, track their checks, and see feedback from {advertiser}.</p></div>
    <Card><CardHeader><CardTitle>Upload for review</CardTitle><CardDescription>{advertiser}’s saved guidelines are applied automatically.</CardDescription></CardHeader><CardContent><form className="grid gap-5" onSubmit={event => void submit(event)}><fieldset disabled={busy} className="grid gap-5"><div className="rounded-xl border border-dashed bg-muted/20 p-6"><Label htmlFor="publisher-files" className="mb-3 flex items-center gap-2"><Upload className="size-4" />Creative files</Label><Input id="publisher-files" name="creative" type="file" multiple accept="video/*,image/jpeg,image/png,image/webp" onChange={event => setFiles(Array.from(event.target.files ?? []))} /><p className="mt-3 text-xs text-muted-foreground">Images and video · Up to 400 MB per file · Up to 100 files per submission</p>{files.length ? <p className="mt-3 break-words text-sm">{files.map(file => file.name).join(', ')}</p> : null}</div><div className="grid gap-2"><Label htmlFor="publisher-copy">Ad copy</Label><Textarea id="publisher-copy" name="ad_copy" maxLength={50000} rows={4} placeholder="Paste the copy accompanying these creatives, or submit copy on its own." /></div><div className="grid gap-2"><Label htmlFor="publisher-vertical">Insurance vertical</Label><Select
      id="publisher-vertical"
      name="vertical"
      className="h-10"
      options={[
        { value: 'auto-insurance', label: 'Auto Insurance' },
        { value: 'home-insurance', label: 'Home Insurance' },
      ]}
    /></div><details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">Additional review context</summary><div className="mt-4 grid gap-4"><div className="grid gap-2"><Label htmlFor="publisher-notes">Product or brand notes</Label><Textarea id="publisher-notes" name="notes" maxLength={10000} /></div><div className="grid gap-2"><Label htmlFor="publisher-transcript">Manual transcript (optional)</Label><Textarea id="publisher-transcript" name="manual_transcript" maxLength={50000} /></div><div className="grid gap-2"><Label htmlFor="publisher-frame">Frame interval (seconds)</Label><Input id="publisher-frame" name="frame_interval_seconds" type="number" min="0.5" max="10" step="0.5" defaultValue="1" /></div><label className="flex items-center gap-2 text-sm"><input name="scene_detection" type="checkbox" />Also inspect scene changes</label></div></details><Button className="w-fit" type="submit">{busy ? <LoaderCircle className="animate-spin" /> : <Upload />}{busy ? 'Uploading…' : 'Submit for review'}</Button></fieldset>{message ? <p role="status" className="text-sm">{message}</p> : null}{error ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p> : null}</form></CardContent></Card>
    <section className="grid gap-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Your submissions</h2><p className="mt-1 text-sm text-muted-foreground">Review results privately, then release selected creatives to your advertiser.</p></div>{selected.size ? <div className="flex gap-2"><ReleaseButton jobIds={[...selected]} clientId={clientId} size="sm" /><ShareButton key={[...selected].join(',')} jobIds={[...selected]} clientId={clientId} /><Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button></div> : null}</div>
    {query.isLoading ? <p>Loading submissions…</p> : query.error ? <p role="alert" className="text-destructive">{query.error.message}</p> : !query.data?.length ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Your submitted creatives will appear here.</div> : query.data.map(row => <div key={row.jobId} className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4"><input aria-label={`Select ${row.fileName}`} type="checkbox" disabled={row.status !== 'complete'} checked={selected.has(row.jobId)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(row.jobId); else next.delete(row.jobId); return next; })} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{row.fileName}</p><p className="mt-1 text-xs text-muted-foreground">{row.message} {row.status !== 'complete' && row.status !== 'failed' ? `· ${row.progress}%` : ''}</p></div><Badge variant="outline">{row.status}</Badge>{row.status === 'complete' ? <><Badge variant={row.released ? 'secondary' : 'outline'}>{row.released ? 'Released' : 'Private'}</Badge><ReleaseButton jobIds={[row.jobId]} clientId={clientId} size="sm" /><Link to="/client/$clientId/reviews/$jobId" params={{ clientId, jobId: row.jobId }} className={buttonVariants({ size: 'sm', variant: 'outline' })}>View review</Link><ShareButton jobIds={[row.jobId]} clientId={clientId} /></> : null}{!row.released && ['complete', 'failed'].includes(row.status) ? <DeleteSubmissionButton jobId={row.jobId} fileName={row.fileName} clientId={clientId} /> : null}</div>)}
    </section></div></ClientPortalFrame>;
}
export function ClientSharedLinksPage() {
  const { clientId } = useWorkspace();
  return <ClientPortalFrame><SharedLinksPanel clientId={clientId} /></ClientPortalFrame>;
}
export function ClientPlanPage() {
  const { session } = useClientAuth();
  const { clientId } = useWorkspace();
  const query = useQuery({ queryKey: ['plan', clientId], queryFn: () => getPlan(clientId), enabled: session.role !== 'publisher' });
  return <ClientPortalFrame><div className="mx-auto grid max-w-3xl gap-5"><h1 className="text-3xl font-semibold">Plan & usage</h1><p className="text-sm text-muted-foreground">Publisher capacity and reviews submitted through your publisher workspaces. Review usage resets on the first day of each month (UTC).</p>{query.error ? <p role="alert" className="text-destructive">{query.error.message}</p> : query.data ? <Card><CardHeader><CardTitle className="capitalize">{query.data.plan} workspace</CardTitle><CardDescription>{query.data.plan === 'pilot' ? 'You are on a pilot allocation. Contact us to activate a paid plan.' : 'Your plan is managed with the AdChecked team.'}</CardDescription></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2"><div className="rounded-xl border p-4"><p className="text-2xl font-semibold">{query.data.publishers} / {query.data.publisherLimit}</p><p className="mt-2 text-sm text-muted-foreground">Active or invited publisher teams</p></div><div className="rounded-xl border p-4"><p className="text-2xl font-semibold">{query.data.monthlyReviews} / {query.data.monthlyReviewLimit}</p><p className="mt-2 text-sm text-muted-foreground">Reviews submitted this month</p></div></CardContent></Card> : <p>Loading plan…</p>}<div className="flex gap-3"><a href="https://adchecked.com/pricing" className={buttonVariants({ variant: 'outline' })}>Compare plans</a><a href="mailto:hello@adchecked.com?subject=AdChecked%20plan%20change" className={buttonVariants()}>Contact us to change plans</a></div></div></ClientPortalFrame>;
}
