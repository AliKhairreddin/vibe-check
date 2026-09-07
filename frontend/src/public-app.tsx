import { useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Link2, ScanSearch } from 'lucide-react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Badge } from './components/ui/badge';
import { PricingPage } from './components/pricing-page';
import { acceptInvite, getInvite, getSharedCollection, getSharedDetail } from './lib/workspace-api';

function PublicShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-muted/20"><header className="border-b bg-background"><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5"><a href="https://adchecked.com" className="flex items-center gap-2 font-semibold"><ScanSearch />AdChecked</a><a href="/login" className="text-sm text-muted-foreground">Sign in</a></div></header><main className="mx-auto max-w-6xl px-5 py-10">{children}</main></div>;
}
function InvitationPage({ token }: { token: string }) {
  const query = useQuery({ queryKey: ['invitation', token], queryFn: () => getInvite(token), retry: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get('password') !== data.get('confirm')) { setError('Your passwords do not match.'); return; }
    setBusy(true); setError('');
    try { await acceptInvite(token, String(data.get('password'))); window.location.assign('/client'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not activate your account.'); setBusy(false); }
  }
  return <PublicShell><div className="mx-auto max-w-md rounded-2xl border bg-card p-7 shadow-sm">
    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Publisher invitation</p>
    {query.isLoading ? <p className="mt-6">Loading invitation…</p> : query.error ? <p role="alert" className="mt-6 text-destructive">{query.error.message}</p> : query.data ? <><h1 className="mt-3 text-2xl font-semibold">Welcome, {query.data.name}</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">{query.data.advertiser} invited your team to upload creatives and review feedback. Their guidelines will be applied automatically.</p>
      <form className="mt-6 grid gap-4" onSubmit={event => void submit(event)}><div className="grid gap-2"><Label htmlFor="invite-username">Your login username</Label><Input id="invite-username" name="username" autoComplete="username" readOnly value={query.data.username} /></div><div className="grid gap-2"><Label htmlFor="invite-password">Create a password</Label><Input id="invite-password" name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /><p className="text-xs text-muted-foreground">Use at least 12 characters.</p></div><div className="grid gap-2"><Label htmlFor="invite-confirm">Confirm password</Label><Input id="invite-confirm" name="confirm" type="password" minLength={12} maxLength={128} autoComplete="new-password" required /></div><Button type="submit" disabled={busy}>{busy ? 'Creating your login…' : 'Activate publisher login'}</Button>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}</form></> : null}
  </div></PublicShell>;
}
function SharedCreative({ token, jobId }: { token: string; jobId: string }) {
  const query = useQuery({ queryKey: ['shared-review', token, jobId], queryFn: () => getSharedDetail(token, jobId), retry: false, refetchInterval: 30_000 });
  const [mediaError, setMediaError] = useState(false);
  if (query.isLoading) return <p className="p-6">Loading creative…</p>;
  if (query.error || !query.data) return <p role="alert" className="rounded-xl border p-6 text-destructive">{query.error?.message ?? 'Creative unavailable'}</p>;
  const { review, report, media_url: mediaUrl, evidence_frames: frames } = query.data;
  return <article className="overflow-hidden rounded-2xl border bg-card"><div className="border-b p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="break-words text-xl font-semibold">{review.file_name}</h2><p className="mt-1 text-sm text-muted-foreground">{report.offer_name} · {new Date(review.created_at).toLocaleDateString()}</p></div><Badge variant="outline">{review.effective_status === 'green' ? 'Ready' : review.effective_status === 'red' ? 'On hold' : 'Needs review'}</Badge></div></div>
    <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"><div>
      {review.media_kind === 'copy_only' ? <div className="rounded-xl bg-muted p-8 text-center text-sm">Ad copy review</div> : mediaError ? frames[0] ? <img alt="Creative evidence preview" src={frames[0].url} className="max-h-96 w-full rounded-xl object-contain" /> : <p className="rounded-xl bg-muted p-8 text-sm">The original media is unavailable. Review findings appear alongside.</p> : review.media_kind === 'video' ? <video className="max-h-[30rem] w-full rounded-xl bg-black" src={mediaUrl} poster={frames[0]?.url} controls preload="metadata" onError={() => setMediaError(true)} /> : <img className="max-h-[30rem] w-full rounded-xl object-contain" src={mediaUrl} alt={review.file_name} onError={() => setMediaError(true)} />}
      {review.decision ? <div className="mt-4 rounded-xl border p-4"><p className="text-sm font-semibold">Advertiser decision: {review.decision.decision}</p>{review.decision.feedback_note ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{review.decision.feedback_note}</p> : null}</div> : null}
    </div><div className="grid content-start gap-4"><p className="text-sm leading-7">{report.summary}</p><p className="text-xs text-muted-foreground">AI recommendation: {review.ai_status === 'green' ? 'Ready' : review.ai_status === 'red' ? 'On hold' : 'Needs review'} · {report.findings.length} findings</p>
      {report.findings.map((finding, index) => <div key={index} className="rounded-xl border p-4"><div className="flex flex-wrap gap-2"><Badge variant="outline">{finding.severity}</Badge><Badge variant="secondary">{finding.source}</Badge>{finding.timestamp_start != null ? <Badge variant="outline">{finding.timestamp_start}s</Badge> : null}</div><p className="mt-3 text-sm font-medium">{finding.evidence}</p><p className="mt-3 text-sm leading-6 text-muted-foreground"><strong className="text-foreground">Policy: </strong>{finding.policy_reason}</p><p className="mt-2 text-sm leading-6 text-muted-foreground"><strong className="text-foreground">Suggested fix: </strong>{finding.suggested_fix}</p></div>)}
      {!report.findings.length ? <p className="flex items-center gap-2 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="size-5" />No policy issues identified.</p> : null}
    </div></div>
    {frames.length ? <div className="border-t p-6"><h3 className="mb-3 text-sm font-semibold">Evidence frames</h3><div className="flex gap-3 overflow-x-auto">{frames.map(frame => <figure key={frame.filename} className="w-40 shrink-0"><a href={frame.url} target="_blank" rel="noreferrer"><img alt={`Evidence at ${frame.timestamp ?? 0} seconds`} src={frame.url} loading="lazy" className="h-40 w-full rounded-lg border object-contain" /></a><figcaption className="mt-1 text-xs text-muted-foreground">{frame.timestamp ?? 0}s</figcaption></figure>)}</div></div> : null}
  </article>;
}
function SharedPage({ token }: { token: string }) {
  const query = useQuery({ queryKey: ['shared-collection', token], queryFn: () => getSharedCollection(token), retry: false, refetchInterval: 30_000 });
  const [page, setPage] = useState(0);
  return <PublicShell>{query.isLoading ? <p>Loading shared review…</p> : query.error || !query.data ? <div className="mx-auto max-w-lg rounded-2xl border bg-card p-8 text-center"><Link2 className="mx-auto mb-4" /><h1 className="text-xl font-semibold">Shared link unavailable</h1><p role="alert" className="mt-3 text-sm text-muted-foreground">{query.error?.message ?? 'Ask the sender for a new link.'}</p></div> : <div className="grid gap-6"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shared with you · View only</p><h1 className="mt-2 text-3xl font-semibold">{query.data.title}</h1><p className="mt-2 text-sm text-muted-foreground">{query.data.job_ids.length} creatives · Expires {new Date(query.data.expires_at).toLocaleDateString()} · No login required</p></div>{query.data.job_ids.slice(page * 5, page * 5 + 5).map(jobId => <SharedCreative key={jobId} token={token} jobId={jobId} />)}{query.data.job_ids.length > 5 ? <div className="flex items-center justify-between"><Button variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-sm">Page {page + 1} of {Math.ceil(query.data.job_ids.length / 5)}</span><Button variant="outline" disabled={(page + 1) * 5 >= query.data.job_ids.length} onClick={() => setPage(page + 1)}>Next</Button></div> : null}</div>}</PublicShell>;
}
export function mountPublicApp(element: HTMLElement) {
  const [kind, token = ''] = window.location.pathname.split('/').filter(Boolean);
  document.title = kind === 'pricing' ? 'Pricing · AdChecked' : kind === 'invite' ? 'Publisher invitation · AdChecked' : 'Shared creative reviews · AdChecked';
  createRoot(element).render(<QueryClientProvider client={new QueryClient()}>{kind === 'pricing' ? <PricingPage /> : kind === 'invite' ? <InvitationPage token={token} /> : <SharedPage token={token} />}</QueryClientProvider>);
}
