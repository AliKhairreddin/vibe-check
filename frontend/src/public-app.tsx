import { useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronUp, ExternalLink, Link2, ScanSearch } from 'lucide-react';
import { Button, buttonVariants } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Badge } from './components/ui/badge';
import { OfferResultBadge } from './components/offer-outcomes';
import { effectiveReviewStatus } from './lib/client-review-status';
import { PricingPage } from './components/pricing-page';
import { SharedFindings } from './components/shared-findings';
import { getClientSession } from './lib/api';
import { acceptInvite, getInvite, getSharedCollection, getSharedDetail } from './lib/workspace-api';

function PublicShell({ children, reviewHref, signedIn = false }: { children: React.ReactNode; reviewHref?: string; signedIn?: boolean }) {
  return <div className="min-h-screen bg-muted/20"><header className="border-b bg-background"><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5"><a href="https://adchecked.com" className="flex items-center gap-2 font-semibold"><ScanSearch />AdChecked</a><a href={reviewHref ?? "/login"} className="text-sm text-muted-foreground">{signedIn ? "Continue review" : "Sign in"}</a></div></header><main className="mx-auto max-w-6xl px-5 py-10">{children}</main></div>;
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
  const [expanded, setExpanded] = useState(false);
  if (query.isLoading) return <p className="rounded-xl border bg-card p-6">Loading creative…</p>;
  if (query.error || !query.data) return <p role="alert" className="rounded-xl border p-6 text-destructive">{query.error?.message ?? 'Creative unavailable'}</p>;
  const { review, report, media_url: mediaUrl, evidence_frames: frames } = query.data;
  const driveUrl = review.preview.google_drive_url;
  const detailsId = `findings-${jobId}`;
  return <article className="min-w-0 overflow-hidden rounded-2xl border bg-card shadow-xs">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1"><h2 className="wrap-anywhere text-base font-semibold">{review.file_name}</h2><p className="mt-1 text-xs text-muted-foreground">{report.offer_name} · {new Date(review.created_at).toLocaleDateString()}</p></div>
      <OfferResultBadge status={effectiveReviewStatus(review)} automatedStatus={review.ai_status} clientDecision={review.decision?.decision} />
    </div>
    <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:gap-5 sm:p-5">
      <div className="min-w-0">
        {review.media_kind === 'copy_only' ? <div className="grid h-48 place-items-center rounded-xl bg-muted text-sm text-muted-foreground">Ad copy review</div> : mediaError ? frames[0] ? <img alt="Creative evidence preview" src={frames[0].url} className="h-60 w-full rounded-xl bg-muted object-contain" /> : <p className="grid h-48 place-items-center rounded-xl bg-muted p-5 text-sm text-muted-foreground">The original media is unavailable.</p> : review.media_kind === 'video' ? <video className="h-60 w-full rounded-xl bg-black object-contain" src={mediaUrl} poster={frames[0]?.url} controls playsInline preload="metadata" onError={() => setMediaError(true)} /> : <a href={mediaUrl} target="_blank" rel="noreferrer" aria-label={`Open full image for ${review.file_name}`}><img className="h-60 w-full rounded-xl bg-muted object-contain" src={mediaUrl} alt={review.file_name} onError={() => setMediaError(true)} /></a>}
        {driveUrl ? <a href={driveUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline', size: 'sm', className: 'mt-3 w-full' })}><ExternalLink />Open in Google Drive</a> : null}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-3">
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">AI recommendation: {review.ai_status === 'green' ? 'Ready' : review.ai_status === 'red' ? 'On hold' : 'Needs review'}</Badge><span className="text-xs text-muted-foreground">{report.findings.length} finding{report.findings.length === 1 ? '' : 's'}</span></div>
        <p className="wrap-anywhere text-sm leading-7">{report.summary}</p>
        <div className="w-full rounded-lg bg-muted/40 px-3 py-2.5"><p className="text-xs font-medium">{review.decision ? `Advertiser decision: ${review.decision.decision}` : 'Awaiting advertiser decision'}</p>{review.decision?.feedback_note ? <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-sm leading-6 text-muted-foreground">{review.decision.feedback_note}</p> : null}</div>
        {report.findings.length || frames.length ? <Button variant="outline" size="sm" aria-expanded={expanded} aria-controls={detailsId} className="mt-auto" onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp /> : <ChevronDown />}{expanded ? 'Hide details' : report.findings.length ? `View findings (${report.findings.length})` : 'View evidence'}</Button> : null}
      </div>
    </div>
    <div id={detailsId} hidden={!expanded} className="min-w-0 border-t bg-muted/20 p-4 sm:p-5">{expanded ? <SharedFindings findings={report.findings} frames={frames} /> : null}</div>
  </article>;
}

function SharedPage({ token }: { token: string }) {
  const query = useQuery({ queryKey: ['shared-collection', token], queryFn: () => getSharedCollection(token), retry: false, refetchInterval: 30_000 });
  const session = useQuery({ queryKey: ['public-client-session'], queryFn: getClientSession, retry: false });
  const [page, setPage] = useState(0);
  const reviewHref = `/client/shared/${encodeURIComponent(token)}`;
  const signedIn = Boolean(session.data);
  function changePage(next: number) {
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  return <PublicShell reviewHref={query.data ? reviewHref : undefined} signedIn={signedIn}>{query.isLoading ? <p>Loading shared review…</p> : query.error || !query.data ? <div className="mx-auto max-w-lg rounded-2xl border bg-card p-8 text-center"><Link2 className="mx-auto mb-4" /><h1 className="text-xl font-semibold">Shared link unavailable</h1><p role="alert" className="mt-3 text-sm text-muted-foreground">{query.error?.message ?? 'Ask the sender for a new link.'}</p></div> : <div className="grid min-w-0 gap-5">
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shared with you · View only</p><h1 className="mt-2 wrap-anywhere text-3xl font-semibold">{query.data.title}</h1><p className="mt-2 text-sm text-muted-foreground">{query.data.job_ids.length} creatives · Expires {new Date(query.data.expires_at).toLocaleDateString()} · No login required</p></div>
      <aside className="rounded-xl border bg-card p-4"><h2 className="text-sm font-semibold">Ready to review these creatives?</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{signedIn ? 'Open these creatives in your workspace to review and leave feedback.' : 'Sign in to approve, disapprove, or leave feedback.'}</p><a href={reviewHref} className={buttonVariants({ size: 'sm', className: 'mt-3' })}>{signedIn ? 'Continue review' : 'Sign in to review'}<ArrowRight /></a></aside>
    </div>
    {query.data.job_ids.slice(page * 5, page * 5 + 5).map(jobId => <SharedCreative key={jobId} token={token} jobId={jobId} />)}
    {query.data.job_ids.length > 5 ? <nav aria-label="Creative pages" className="flex items-center justify-between gap-2"><Button variant="outline" disabled={page === 0} onClick={() => changePage(page - 1)}>Previous</Button><span className="text-sm">Page {page + 1} of {Math.ceil(query.data.job_ids.length / 5)}</span><Button variant="outline" disabled={(page + 1) * 5 >= query.data.job_ids.length} onClick={() => changePage(page + 1)}>Next</Button></nav> : null}
  </div>}</PublicShell>;
}
export function mountPublicApp(element: HTMLElement) {
  const [kind, token = ''] = window.location.pathname.split('/').filter(Boolean);
  document.title = kind === 'pricing' ? 'Pricing · AdChecked' : kind === 'invite' ? 'Publisher invitation · AdChecked' : 'Shared creative reviews · AdChecked';
  createRoot(element).render(<QueryClientProvider client={new QueryClient()}>{kind === 'pricing' ? <PricingPage /> : kind === 'invite' ? <InvitationPage token={token} /> : <SharedPage token={token} />}</QueryClientProvider>);
}
