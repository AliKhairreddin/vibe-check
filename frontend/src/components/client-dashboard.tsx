import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreativeEvidenceImage, CreativeThumbnail } from '@/components/creative-media';
import {
  decideClientReview,
  getClientPassword,
  getClientReview,
  listClientReviews,
  setClientPassword,
  verifyClientPassword,
  type ClientDecisionValue,
  type ClientReviewDetail,
  type ClientReviewItem,
  type ClientReviewList,
  type Finding,
  type OverallStatus,
  type ReviewEvidenceFrame,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const CLIENT_ID = 'kissterra';

type ReviewGroup = {
  createdAt: number;
  id: string;
  label: string;
  reviews: ClientReviewItem[];
};

export function KissterraDashboardPage() {
  return (
    <ClientPortalGate>
      <KissterraDashboard />
    </ClientPortalGate>
  );
}

export function KissterraReviewDetailPage() {
  return (
    <ClientPortalGate>
      <KissterraReviewDetail />
    </ClientPortalGate>
  );
}

function ClientPortalGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState(() => getClientPassword(CLIENT_ID));
  const [isChecking, setIsChecking] = useState(Boolean(getClientPassword(CLIENT_ID)));
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const stored = getClientPassword(CLIENT_ID);
    if (!stored) {
      setIsChecking(false);
      return;
    }
    let active = true;
    void verifyClientPassword(CLIENT_ID, stored)
      .then(() => {
        if (active) setIsUnlocked(true);
      })
      .catch((reason) => {
        if (!active) return;
        setClientPassword(CLIENT_ID, '');
        setPassword('');
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setIsChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = password.trim();
    if (!candidate) {
      setError('Enter your Kissterra review password.');
      return;
    }
    setIsChecking(true);
    setError('');
    try {
      await verifyClientPassword(CLIENT_ID, candidate);
      setClientPassword(CLIENT_ID, candidate);
      setIsUnlocked(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsChecking(false);
    }
  }

  function lock() {
    setClientPassword(CLIENT_ID, '');
    setPassword('');
    setIsUnlocked(false);
    setError('');
    queryClient.removeQueries({ queryKey: ['client', CLIENT_ID] });
  }

  if (!isUnlocked) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 p-4 text-foreground">
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader>
            <span className="mb-2 grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="size-5" />
            </span>
            <CardTitle as="h1" className="text-2xl">Kissterra review portal</CardTitle>
            <CardDescription>
              Sign in to review today’s creatives and record your final approval decision.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={unlock}>
              <div className="grid gap-2">
                <Label htmlFor="kissterra-password">Review password</Label>
                <Input
                  id="kissterra-password"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  autoFocus
                  disabled={isChecking}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
              </div>
              <Button type="submit" size="lg" disabled={isChecking || !password.trim()}>
                {isChecking ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                {isChecking ? 'Signing in' : 'Open review portal'}
              </Button>
            </form>
            {error ? (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle />
                <AlertTitle>Access unavailable</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Link to="/kissterra" className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="size-4" />
            </span>
            <span>
              <span className="block font-heading font-semibold">Kissterra</span>
              <span className="block text-xs text-muted-foreground">Creative review portal</span>
            </span>
          </Link>
          <Button type="button" variant="ghost" size="sm" onClick={lock}>
            <LogOut />
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}

function KissterraDashboard() {
  const queryClient = useQueryClient();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const query = useQuery({
    queryKey: ['client', CLIENT_ID, 'reviews'],
    queryFn: () => listClientReviews(CLIENT_ID),
    refetchInterval: 30_000,
  });
  const groups = useMemo(() => groupReviews(query.data?.reviews ?? []), [query.data?.reviews]);

  useEffect(() => {
    setExpandedGroups((current) => {
      const validIds = new Set(groups.map((group) => group.id));
      const next = new Set([...current].filter((id) => validIds.has(id)));
      if (!current.size) {
        for (const group of groups) {
          if (isToday(group.createdAt)) next.add(group.id);
        }
        if (!next.size && groups[0]) next.add(groups[0].id);
      }
      return setsEqual(current, next) ? current : next;
    });
  }, [groups]);

  const decisionMutation = useMutation({
    mutationFn: ({ jobId, decision }: { jobId: string; decision: ClientDecisionValue }) =>
      decideClientReview(CLIENT_ID, jobId, decision),
    onSuccess: (decision, variables) => {
      queryClient.setQueryData<ClientReviewList>(
        ['client', CLIENT_ID, 'reviews'],
        (current) => current ? {
          ...current,
          reviews: current.reviews.map((review) => review.job_id === variables.jobId
            ? { ...review, decision }
            : review),
        } : current
      );
    },
  });
  const reviews = query.data?.reviews ?? [];
  const awaitingCount = reviews.filter((review) => !review.decision).length;
  const overrideCount = reviews.filter((review) => isClientOverride(review)).length;
  const todayCount = reviews.filter((review) => isToday(review.created_at)).length;

  return (
    <div className="grid gap-5">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-1">
          <p className="text-sm font-medium text-muted-foreground">Daily review queue</p>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Creative approvals</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Review Vibe Check’s recommendation, then approve or disapprove each creative.
          </p>
        </div>
        <Button type="button" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          <RefreshCw className={cn(query.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard icon={FileText} label="Today’s creatives" value={todayCount} />
        <MetricCard icon={Clock3} label="Awaiting your decision" value={awaitingCount} />
        <MetricCard icon={Layers3} label="Overrides recorded" value={overrideCount} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Batches</CardTitle>
          <CardDescription>
            Expand a batch to review each creative. Only Kissterra results are shown here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.error ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Reviews unavailable</AlertTitle>
              <AlertDescription>{errorMessage(query.error)}</AlertDescription>
              <AlertAction>
                <Button type="button" size="xs" variant="outline" onClick={() => void query.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : query.isLoading ? (
            <div className="grid gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-24" />
              <Skeleton className="h-14" />
            </div>
          ) : groups.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <Table className="min-w-[58rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Creative</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-36">Vibe Check</TableHead>
                    <TableHead className="w-72">Kissterra decision</TableHead>
                    <TableHead className="w-32">Reviewed</TableHead>
                    <TableHead className="w-24 text-right">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.flatMap((group) => {
                    const isExpanded = expandedGroups.has(group.id);
                    const decided = group.reviews.filter((review) => review.decision).length;
                    return [
                      <TableRow key={group.id} className="bg-muted/35 hover:bg-muted/50">
                        <TableCell colSpan={6} className="py-2">
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 text-left"
                            aria-expanded={isExpanded}
                            onClick={() => setExpandedGroups((current) => toggleSetValue(current, group.id))}
                          >
                            <span className="grid size-7 place-items-center rounded-md border bg-background">
                              {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold">{group.label}</span>
                              <span className="block text-xs text-muted-foreground">
                                {formatDate(group.createdAt)} · {group.reviews.length} creative{group.reviews.length === 1 ? '' : 's'}
                              </span>
                            </span>
                            <Badge variant={decided === group.reviews.length ? 'secondary' : 'outline'}>
                              {decided}/{group.reviews.length} decided
                            </Badge>
                          </button>
                        </TableCell>
                      </TableRow>,
                      ...(isExpanded ? group.reviews.map((review) => (
                        <TableRow key={review.job_id}>
                          <TableCell>
                            <CreativeThumbnail
                              alt={`Preview of ${review.file_name}`}
                              clientId={CLIENT_ID}
                              jobId={review.job_id}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="block max-w-80 truncate font-medium" title={review.file_name}>
                              {review.file_name}
                            </span>
                            <span className="text-xs text-muted-foreground">{mediaLabel(review.media_kind)}</span>
                          </TableCell>
                          <TableCell><AiRecommendation status={review.ai_status} /></TableCell>
                          <TableCell>
                            <DecisionControl
                              review={review}
                              isSaving={decisionMutation.isPending && decisionMutation.variables?.jobId === review.job_id}
                              onDecide={(decision) => decisionMutation.mutate({ jobId: review.job_id, decision })}
                            />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDateTime(review.created_at)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Link
                              to="/kissterra/reviews/$jobId"
                              params={{ jobId: review.job_id }}
                              className={buttonVariants({ variant: 'outline', size: 'xs' })}
                            >
                              View
                            </Link>
                          </TableCell>
                        </TableRow>
                      )) : []),
                    ];
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="grid min-h-48 place-items-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
              <div className="grid max-w-sm gap-2">
                <CheckCircle2 className="mx-auto size-6 text-muted-foreground" />
                <p className="font-medium">No Kissterra creatives are waiting</p>
                <p className="text-sm text-muted-foreground">New completed reviews will appear here automatically.</p>
              </div>
            </div>
          )}
          {decisionMutation.error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {errorMessage(decisionMutation.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function KissterraReviewDetail() {
  const { jobId } = useParams({ from: '/kissterra/reviews/$jobId' });
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['client', CLIENT_ID, 'review', jobId],
    queryFn: () => getClientReview(CLIENT_ID, jobId),
  });
  const decisionMutation = useMutation({
    mutationFn: (decision: ClientDecisionValue) => decideClientReview(CLIENT_ID, jobId, decision),
    onSuccess: (decision) => {
      queryClient.setQueryData<ClientReviewDetail>(
        ['client', CLIENT_ID, 'review', jobId],
        (current) => current ? {
          ...current,
          review: { ...current.review, decision },
        } : current
      );
      void queryClient.invalidateQueries({ queryKey: ['client', CLIENT_ID, 'reviews'] });
    },
  });

  if (query.isLoading) {
    return <div className="grid gap-4"><Skeleton className="h-36" /><Skeleton className="h-96" /></div>;
  }
  if (!query.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Creative unavailable</AlertTitle>
        <AlertDescription>{query.error ? errorMessage(query.error) : 'This creative could not be loaded.'}</AlertDescription>
        <AlertAction>
          <Link to="/kissterra" className={buttonVariants({ variant: 'outline', size: 'xs' })}>
            Back to batches
          </Link>
        </AlertAction>
      </Alert>
    );
  }

  const { report, review, evidence_frames: evidenceFrames } = query.data;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/kissterra" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Back to batches
        </Link>
        <DecisionControl
          review={review}
          isSaving={decisionMutation.isPending}
          onDecide={(decision) => decisionMutation.mutate(decision)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h1" className="text-xl">{review.file_name}</CardTitle>
          <CardDescription>{formatDateTime(review.created_at)} · {mediaLabel(review.media_kind)}</CardDescription>
          <CardAction><AiRecommendation status={review.ai_status} /></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row">
          <CreativeThumbnail
            alt={`Preview of ${review.file_name}`}
            className="h-36 w-28 sm:h-40 sm:w-32"
            clientId={CLIENT_ID}
            jobId={review.job_id}
          />
          <div className="grid content-start gap-3">
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{report.summary}</p>
            <div className="flex flex-wrap gap-2">
              <StatusBadge status={review.ai_status} />
              <Badge variant="outline">{report.findings.length} finding{report.findings.length === 1 ? '' : 's'}</Badge>
              {isClientOverride(review) ? <Badge variant="secondary">Kissterra override</Badge> : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Findings with evidence</CardTitle>
          <CardDescription>
            Each finding is paired with the closest available creative frame.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {report.findings.length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {report.findings.map((finding, index) => (
                <FindingCard
                  key={`${finding.source}-${finding.timestamp_start ?? 'none'}-${index}`}
                  finding={finding}
                  frame={nearestEvidenceFrame(evidenceFrames, finding.timestamp_start)}
                  index={index + 1}
                  jobId={jobId}
                  clientId={CLIENT_ID}
                />
              ))}
            </div>
          ) : (
            <div className="grid min-h-40 place-items-center rounded-lg border border-emerald-600/25 bg-emerald-500/5 p-6 text-center">
              <div className="grid gap-2">
                <CheckCircle2 className="mx-auto size-7 text-emerald-600" />
                <p className="font-medium">No policy findings</p>
                <p className="text-sm text-muted-foreground">Vibe Check found no Kissterra policy issue in this creative.</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {decisionMutation.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Decision not saved</AlertTitle>
          <AlertDescription>{errorMessage(decisionMutation.error)}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function FindingCard({
  clientId,
  finding,
  frame,
  index,
  jobId,
}: {
  clientId?: string;
  finding: Finding;
  frame: ReviewEvidenceFrame | null;
  index: number;
  jobId: string;
}) {
  return (
    <article className="flex gap-3 rounded-xl border bg-card p-3">
      {frame ? (
        <CreativeEvidenceImage
          alt={`Evidence frame for finding ${index}`}
          clientId={clientId}
          filename={frame.filename}
          jobId={jobId}
        />
      ) : (
        <span className="grid h-32 w-24 shrink-0 place-items-center rounded-lg border bg-muted/30 text-center text-[11px] font-medium text-muted-foreground sm:h-36 sm:w-28">
          {sourceLabel(finding.source)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">#{index}</Badge>
          <SeverityBadge severity={finding.severity} />
          <Badge variant="outline">{sourceLabel(finding.source)}</Badge>
          {finding.timestamp_start ? <Badge variant="secondary">{formatTimestamp(finding.timestamp_start)}</Badge> : null}
        </div>
        <p className="mt-3 text-sm font-medium leading-5">{finding.evidence}</p>
        <div className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground">
          <p><span className="font-semibold text-foreground">Policy:</span> {finding.policy_reason}</p>
          <p><span className="font-semibold text-foreground">Fix:</span> {finding.suggested_fix}</p>
        </div>
      </div>
    </article>
  );
}

function DecisionControl({
  isSaving,
  onDecide,
  review,
}: {
  isSaving: boolean;
  onDecide: (decision: ClientDecisionValue) => void;
  review: ClientReviewItem;
}) {
  return (
    <div className="flex min-w-max items-center gap-1">
      <Button
        type="button"
        size="xs"
        variant={review.decision?.decision === 'approved' ? 'default' : 'outline'}
        disabled={isSaving}
        aria-pressed={review.decision?.decision === 'approved'}
        onClick={() => onDecide('approved')}
      >
        {isSaving ? <LoaderCircle className="animate-spin" /> : <Check />}
        Approve
      </Button>
      <Button
        type="button"
        size="xs"
        variant={review.decision?.decision === 'disapproved' ? 'destructive' : 'outline'}
        disabled={isSaving}
        aria-pressed={review.decision?.decision === 'disapproved'}
        onClick={() => onDecide('disapproved')}
      >
        <X />
        Disapprove
      </Button>
      {isClientOverride(review) ? <Badge variant="secondary">Override</Badge> : null}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: number }) {
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3 py-4">
        <span className="grid size-9 place-items-center rounded-lg border bg-muted/40 text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span>
          <span className="block text-xs font-medium text-muted-foreground">{label}</span>
          <span className="block text-2xl font-semibold tabular-nums">{value}</span>
        </span>
      </CardContent>
    </Card>
  );
}

function AiRecommendation({ status }: { status: OverallStatus }) {
  const approved = status === 'green';
  return (
    <Badge variant={approved ? 'secondary' : 'destructive'}>
      {approved ? <CheckCircle2 /> : <XCircle />}
      {approved ? 'Approve' : 'Disapprove'}
    </Badge>
  );
}

function StatusBadge({ status }: { status: OverallStatus }) {
  return (
    <Badge
      className={cn(
        status === 'green' && 'border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        status === 'amber' && 'border-orange-600/30 bg-orange-500/15 text-orange-700 dark:text-orange-300',
        status === 'red' && 'border-red-600/30 bg-red-500/15 text-red-700 dark:text-red-300'
      )}
      variant="outline"
    >
      {statusLabel(status)}
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: Finding['severity'] }) {
  return <Badge variant={severity === 'high' ? 'destructive' : 'secondary'}>{capitalize(severity)}</Badge>;
}

function groupReviews(reviews: ClientReviewItem[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const review of reviews) {
    const dateKey = new Date(review.created_at).toISOString().slice(0, 10);
    const id = review.batch_id ? `batch:${review.batch_id}` : `individual:${dateKey}`;
    const existing = groups.get(id);
    const label = review.batch_id
      ? review.batch_source_label || `Batch ${review.batch_id.slice(0, 8)}`
      : 'Individual reviews';
    if (existing) {
      existing.reviews.push(review);
      existing.createdAt = Math.max(existing.createdAt, review.created_at);
    } else {
      groups.set(id, { createdAt: review.created_at, id, label, reviews: [review] });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      reviews: group.reviews.sort((left, right) => right.created_at - left.created_at),
    }))
    .sort((left, right) => right.createdAt - left.createdAt);
}

function nearestEvidenceFrame(
  frames: ReviewEvidenceFrame[],
  timestamp: string | null | undefined
): ReviewEvidenceFrame | null {
  if (!frames.length) return null;
  const target = parseTimestampSeconds(timestamp);
  if (target === null || Number.isNaN(target)) return frames[0] ?? null;
  return frames.reduce((nearest, frame) => {
    if (frame.timestamp === null) return nearest;
    if (!nearest || nearest.timestamp === null) return frame;
    return Math.abs(frame.timestamp - target) < Math.abs(nearest.timestamp - target) ? frame : nearest;
  }, null as ReviewEvidenceFrame | null) ?? frames[0] ?? null;
}

function isClientOverride(review: ClientReviewItem) {
  if (!review.decision) return false;
  const aiDecision: ClientDecisionValue = review.ai_status === 'green' ? 'approved' : 'disapproved';
  return review.decision.decision !== aiDecision;
}

function toggleSetValue(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function setsEqual(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isToday(value: number) {
  const date = new Date(value);
  const today = new Date();
  return date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
}

function mediaLabel(value: ClientReviewItem['media_kind']) {
  if (value === 'copy_only') return 'Ad copy';
  return capitalize(value);
}

function statusLabel(status: OverallStatus) {
  if (status === 'green') return 'Green - ready to run';
  if (status === 'amber') return 'Amber - fix or review';
  return 'Red - critical stop';
}

function sourceLabel(source: Finding['source']) {
  return source.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string) {
  const seconds = parseTimestampSeconds(value);
  if (seconds === null || Number.isNaN(seconds)) return value;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, Math.round(seconds % 60));
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function parseTimestampSeconds(value: string | null | undefined) {
  if (!value) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.length >= 2 && parts.length <= 3 && parts.every(Number.isFinite)) {
    const seconds = parts[parts.length - 1] + parts[parts.length - 2] * 60;
    return parts.length === 3 ? seconds + parts[0] * 3600 : seconds;
  }
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function formatDateTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
