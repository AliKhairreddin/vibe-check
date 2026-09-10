import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrainCircuit, History, Pause, Play, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { listOfferCatalog } from '@/lib/api';
import { controlLearning, getLearning, type LearningDecision, type LearningMetrics, type LearningVersion, type Lesson } from '@/lib/learning';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

const date = (value: number) => new Date(value).toLocaleString();
const error = (value: unknown) => value instanceof Error ? value.message : String(value);

export function LearningPage() {
  const queryClient = useQueryClient();
  const [offerId, setOfferId] = useState(() => new URLSearchParams(window.location.search).get('offer') ?? 'acp');
  const [requestedVersion] = useState(() => Number(new URLSearchParams(window.location.search).get('version')) || undefined);
  const [before, setBefore] = useState<number | undefined>(requestedVersion ? requestedVersion + 1 : undefined);
  const [restore, setRestore] = useState<LearningVersion | null>(null);
  const offers = useQuery({ queryKey: ['offers'], queryFn: listOfferCatalog });
  const dashboard = useQuery({ queryKey: ['learning', offerId, before], queryFn: () => getLearning(offerId, before), refetchInterval: 30_000 });
  const value = dashboard.data;
  const action = useMutation({
    mutationFn: ({ action, version, key }: { action: 'pause' | 'resume' | 'retry' | 'restore' | 'disable'; version?: number; key?: string }) =>
      controlLearning(offerId, action, value?.state?.version ?? 0, version, key),
    onSuccess: () => { setRestore(null); void queryClient.invalidateQueries({ queryKey: ['learning', offerId] }); },
  });
  const selectOffer = (id: string) => {
    setOfferId(id); setBefore(undefined); setRestore(null); action.reset();
    window.history.replaceState(null, '', `/learning?offer=${encodeURIComponent(id)}`);
  };
  const active = value?.state?.enabled && value.current?.guidelineVersion === value.profile?.version ? value.current?.lessons ?? [] : [];
  return <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl"><div className="mb-2 flex items-center gap-2 text-sm font-medium text-primary"><BrainCircuit className="size-4" />Advertiser learning</div>
        <h1 className="text-2xl font-semibold tracking-tight">Guidelines that learn from decisions</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Follow the feedback, checks, and exact changes behind each automatic update.</p></div>
      <div className="grid w-full gap-1.5 sm:w-64"><Label htmlFor="learning-offer">Advertiser / offer</Label>
        <Select id="learning-offer" value={offerId} onValueChange={id => selectOffer(String(id))}
          options={(offers.data ?? []).map(x => ({ value: x.offer_id, label: x.display_name }))} /></div>
    </header>
    {dashboard.isLoading ? <div className="grid gap-4"><Skeleton className="h-32" /><Skeleton className="h-80" /></div> : null}
    {dashboard.error || offers.error || action.error ? <Alert variant="destructive"><AlertTitle>Could not complete the request</AlertTitle><AlertDescription>{error(dashboard.error ?? offers.error ?? action.error)}</AlertDescription></Alert> : null}
    {value && !value.available ? <Alert><AlertTitle>Learning storage is not connected</AlertTitle><AlertDescription>Reviews continue normally. Connect Convex to save feedback processing and guideline history.</AlertDescription></Alert> : null}
    {value?.available ? <>
      <Card><CardHeader className="flex flex-wrap items-start justify-between gap-4 sm:flex-row">
        <div className="grid gap-2"><CardTitle className="flex flex-wrap items-center gap-2"><ShieldCheck className="size-5" />Automatic learning <Badge variant="outline">{value.state?.status ?? 'Collecting feedback'}</Badge></CardTitle>
          <CardDescription className="max-w-2xl leading-6">{value.state?.message ?? 'New advertiser decisions will start the learning process. No clarification is active yet.'}</CardDescription></div>
        {value.canManage ? <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => action.mutate({ action: value.state?.enabled === false ? 'resume' : 'pause' })}>
            {value.state?.enabled === false ? <Play /> : <Pause />}{value.state?.enabled === false ? 'Resume learning' : 'Turn learning off'}</Button>
          <Button variant="outline" size="sm" disabled={action.isPending || value.state?.status === 'processing' || value.state?.enabled === false} onClick={() => action.mutate({ action: 'retry' })}><RefreshCw />Check feedback</Button>
        </div> : <Badge variant="secondary">Read-only access</Badge>}
      </CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-3">
        {[['Base guidelines', value.profile ? `Version ${value.profile.version}` : 'Not configured'], ['Learning revision', value.state?.version ? `Version ${value.state.version}` : 'No revision yet'], ['Active clarifications', String(active?.length ?? 0)]].map(([label, number]) =>
          <div key={label} className="rounded-lg border bg-muted/20 p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold">{number}</p></div>)}
      </div><p className="mt-4 text-xs leading-5 text-muted-foreground">Publication requires consistent independent decisions, passing historical tests, and improvement on later decisions. Original guidelines and internal rules remain authoritative.</p></CardContent></Card>

      <Card><CardHeader><CardTitle>Active clarifications</CardTitle><CardDescription>These clarifications are available to new reviews for this advertiser. Each review checks whether they apply.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">{active?.length ? active.map(x => <div key={x.key} className="grid gap-2"><LessonCard lesson={x} />{value.canManage ? <Button size="sm" variant="outline" className="justify-self-start" disabled={action.isPending} onClick={() => action.mutate({ action: 'disable', key: x.key })}>Disable this clarification</Button> : null}</div>) : <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No learned clarifications are active. Reviews use the saved base guidelines.</p>}
          <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">View the complete guideline text supplied to the reviewer</summary>
            <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{active?.length ? value.current?.effectiveText : value.profile?.baseText ?? 'No saved guidelines.'}</pre></details>
        </CardContent></Card>

      <Card><CardHeader><CardTitle>Changes being evaluated</CardTitle><CardDescription>Suggestions stay here when more evidence is needed or a check prevents publication.</CardDescription></CardHeader>
        <CardContent className="grid gap-4">{value.runs.length ? value.runs.slice(0, 5).map(run => <div key={run._id} className="grid gap-3 border-b pb-4 last:border-0 last:pb-0">
          <p className="text-xs text-muted-foreground">{date(run.createdAt)}</p>
          {run.candidates.length ? run.candidates.map(c => <div key={c.lesson.key} className="grid gap-3"><div className="flex flex-wrap items-center gap-2"><Badge variant={c.status === 'blocked' ? 'destructive' : 'secondary'}>{c.status === 'shadow' ? 'Checking later decisions' : c.status}</Badge><span className="text-sm">{c.reason}</span></div><LessonCard lesson={c.lesson} /><Metrics value={c.metrics} /></div>) : <p className="text-sm text-muted-foreground">{run.message}</p>}
        </div>) : <p className="text-sm text-muted-foreground">No feedback analysis has completed yet. Decisions with an explanation and permission to apply to similar creatives can build evidence.</p>}</CardContent></Card>

      <Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="size-5" />Version history & changes</CardTitle><CardDescription>Every published update has an immutable snapshot, a text diff, and its supporting decisions.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">{value.versions.map(version => <details key={version.version} open={restore?.version === version.version || requestedVersion === version.version} className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm"><span className="font-semibold">Learning v{version.version}</span><span className="ml-2 text-muted-foreground">· Base v{version.guidelineVersion} · {date(version.createdAt)}</span>{version.version === value.state?.version ? <Badge className="ml-2" variant="secondary">Current revision</Badge> : null}</summary>
          <p className="mt-3 text-sm leading-6">{version.reason}</p><p className="mt-1 text-xs text-muted-foreground">Published by {version.actor}</p>
          <div className="my-4"><Metrics value={version.metrics} /></div>
          <div className="max-h-96 overflow-auto rounded-md border bg-muted/20 p-3" aria-label={`Changes in learning version ${version.version}`}>
            {version.diff ? version.diff.split('\n').map((line, i) => <div key={i} className={`whitespace-pre-wrap break-words font-mono text-xs leading-6 ${line.startsWith('+') ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200' : line.startsWith('-') ? 'bg-red-500/10 text-red-800 dark:text-red-200' : 'text-muted-foreground'}`}>{line || ' '}</div>) : <p className="text-xs text-muted-foreground">Base guideline snapshot; no learned text added.</p>}
          </div>
          <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">Complete text for this version</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{version.effectiveText}</pre></details>
          <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">Supporting and evaluated decisions ({version.decisions.length})</summary><Decisions rows={version.decisions} /></details>
          {value.canManage && version.version !== value.state?.version && version.guidelineVersion === value.profile?.version ? <div className="mt-4">
            {restore?.version === version.version ? <div className="grid gap-3 rounded-md border p-3"><p className="text-sm">Restore these clarifications as a new revision? Current feedback will be checked again before the restore is accepted. Existing reports keep their recorded versions.</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ action: 'restore', version: version.version })}>Restore version {version.version}</Button><Button size="sm" variant="ghost" onClick={() => setRestore(null)}>Cancel</Button></div></div>
              : <Button size="sm" variant="outline" onClick={() => setRestore(version)}><RotateCcw />Restore this version</Button>}
          </div> : null}
        </details>)}
        {!value.versions.length ? <p className="text-sm text-muted-foreground">Published versions will appear here after feedback is processed.</p> : null}
        <div className="flex flex-wrap gap-2">{before ? <Button variant="outline" size="sm" onClick={() => setBefore(undefined)}>Latest versions</Button> : null}{value.nextBeforeVersion ? <Button variant="outline" size="sm" onClick={() => setBefore(value.nextBeforeVersion!)}>Older versions</Button> : null}</div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Recent advertiser decisions</CardTitle><CardDescription>One-time exceptions and business decisions remain in history but do not teach guidelines.</CardDescription></CardHeader><CardContent><Decisions rows={value.decisions} /></CardContent></Card>
    </> : null}
  </div>;
}

function LessonCard({ lesson }: { lesson: Lesson }) {
  return <div className="rounded-lg border bg-muted/10 p-4"><p className="font-medium">{lesson.title}</p><p className="mt-2 text-sm leading-6">{lesson.guidance}</p>
    <dl className="mt-3 grid gap-2 text-xs leading-5"><div><dt className="font-medium">Applies when</dt><dd className="text-muted-foreground">{lesson.appliesWhen}</dd></div><div><dt className="font-medium">Does not apply</dt><dd className="text-muted-foreground">{lesson.excludes}</dd></div></dl>
    <p className="mt-3 text-xs text-muted-foreground">{lesson.support} independent supporting creatives · {lesson.contradictions} contradictions · {(lesson.lowerBound * 100).toFixed(0)}% lower confidence bound</p></div>;
}
function Metrics({ value }: { value: LearningMetrics }) {
  return <p className="text-xs leading-6 text-muted-foreground">Historical checks: {value.validation} · Improved: {value.improved} · Regressions: {value.regressions} · Later decisions checked: {value.shadow} · Later improvements: {value.shadowImproved} · Later regressions: {value.shadowRegressions}</p>;
}
function Decisions({ rows }: { rows: LearningDecision[] }) {
  return <div className="mt-3 grid gap-3">{rows.length ? rows.map(row => <div key={row.id} className="rounded-md border p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{row.decision}</Badge>{row.aiStatus ? <span className="text-xs text-muted-foreground">AdChecked: {row.aiStatus}</span> : null}<a className="font-medium underline underline-offset-4" href={`/reviews/${encodeURIComponent(row.jobId)}`}>Open creative</a><span className="text-xs text-muted-foreground">{date(row.decidedAt)}</span></div>
    <p className="mt-2 break-words leading-6">{row.note || 'No explanation supplied.'}</p><p className="mt-1 text-xs text-muted-foreground">{row.reason.replace(/_/g, ' ') || 'Decision only'}{row.scope ? ` · ${row.scope === 'similar_creatives' ? 'Use for similar creatives' : 'This creative only'}` : ''}</p>
  </div>) : <p className="text-sm text-muted-foreground">No decisions to show.</p>}</div>;
}
