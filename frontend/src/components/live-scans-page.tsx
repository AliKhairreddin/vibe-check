import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileJson,
  MessageSquareText,
  Radio,
  RefreshCw,
  TriangleAlert,
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
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  getLiveScans,
  type LiveReviewState,
  type LiveScanCopyFinding,
  type OverallStatus,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const RESULT_ORDER: OverallStatus[] = ['green', 'amber', 'red'];
const RESULT_META: Record<OverallStatus, {
  className: string;
  icon: typeof CheckCircle2;
  label: string;
}> = {
  green: {
    className: 'border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    icon: CheckCircle2,
    label: 'Green',
  },
  amber: {
    className: 'border-orange-600/30 bg-orange-500/15 text-orange-700 dark:text-orange-300',
    icon: TriangleAlert,
    label: 'Amber',
  },
  red: {
    className: 'border-red-600/30 bg-red-500/15 text-red-700 dark:text-red-300',
    icon: XCircle,
    label: 'Red',
  },
};

export function LiveScansPage() {
  const observationDate = localDate();
  const query = useQuery({
    queryKey: ['live-scans', observationDate],
    queryFn: () => getLiveScans(observationDate),
    refetchInterval: (current) => current.state.data?.totals.pending ? 5_000 : 30_000,
  });

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-1">
          <p className="text-sm font-medium text-muted-foreground">Observed automatically</p>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Live scans</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Creative and primary-text findings attached to ads observed live today.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className={query.isFetching ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </section>

      {query.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Live findings unavailable</AlertTitle>
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
          <AlertAction>
            <Button type="button" variant="outline" size="xs" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : query.isLoading ? (
        <LiveScansSkeleton />
      ) : query.data ? (
        <>
          <LiveTotals totals={query.data.totals} />
          {query.data.accounts.length ? (
            query.data.accounts.map((account) => (
              <Card key={account.account_id}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                    <Radio className="size-4 text-emerald-500" />
                    {account.account_name}
                    <Badge variant="secondary">{account.live_ad_count} live ads</Badge>
                  </CardTitle>
                  <CardDescription>
                    Last observed {formatTime(account.last_observed_at)} ·{' '}
                    {account.creatives.length} named creative
                    {account.creatives.length === 1 ? '' : 's'}
                  </CardDescription>
                  {account.source_url ? (
                    <CardAction>
                      <a
                        href={account.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      >
                        Ads Manager
                        <ExternalLink />
                      </a>
                    </CardAction>
                  ) : null}
                </CardHeader>
                <CardContent>
                  {!account.creatives.length ? (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                      No creatives are currently live in the latest observation from this account.
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-3 md:hidden">
                    {account.creatives.map((creative) => (
                      <section
                        key={creative.creative_key}
                        className="grid gap-4 rounded-lg border p-4"
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="truncate font-medium" title={creative.creative_name}>
                              {creative.creative_name}
                            </h3>
                            {creative.campaign_names.length ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {creative.campaign_names.slice(0, 3).join(' · ')}
                                {creative.campaign_names.length > 3
                                  ? ` +${creative.campaign_names.length - 3}`
                                  : ''}
                              </p>
                            ) : null}
                          </div>
                          <Badge variant="secondary" className="shrink-0">
                            {creative.ad_count} ad{creative.ad_count === 1 ? '' : 's'}
                          </Badge>
                        </div>
                        {creative.delivery_statuses.length ? (
                          <p className="text-xs text-muted-foreground">
                            {creative.delivery_statuses.join(', ')}
                          </p>
                        ) : null}
                        <div className="grid gap-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Creative review
                          </p>
                          <div className="flex min-w-0 items-start justify-between gap-3">
                            <ReviewState state={creative.review} />
                            <ReviewReportLink state={creative.review} />
                          </div>
                        </div>
                        <div className="grid gap-2">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Primary-text reviews
                          </p>
                          <CopyFindings copies={creative.copies} />
                        </div>
                      </section>
                    ))}
                      </div>
                      <div className="hidden overflow-x-auto md:block">
                    <Table className="min-w-[68rem]">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-72">Creative name</TableHead>
                          <TableHead className="w-36">Live usage</TableHead>
                          <TableHead className="w-52">Creative review</TableHead>
                          <TableHead>Primary-text reviews</TableHead>
                          <TableHead className="w-28 text-right">Report</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {account.creatives.map((creative) => (
                          <TableRow key={creative.creative_key}>
                            <TableCell className="align-top whitespace-normal">
                              <span className="block font-medium">{creative.creative_name}</span>
                              {creative.campaign_names.length ? (
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {creative.campaign_names.slice(0, 3).join(' · ')}
                                  {creative.campaign_names.length > 3
                                    ? ` +${creative.campaign_names.length - 3}`
                                    : ''}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                              <span className="font-medium">{creative.ad_count} ads</span>
                              {creative.delivery_statuses.length ? (
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {creative.delivery_statuses.join(', ')}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                              <ReviewState state={creative.review} />
                            </TableCell>
                            <TableCell className="align-top whitespace-normal">
                              <CopyFindings copies={creative.copies} />
                            </TableCell>
                            <TableCell className="align-top whitespace-normal text-right">
                              <ReviewReportLink state={creative.review} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="grid min-h-64 place-items-center p-8 text-center">
                <div className="grid max-w-md gap-2">
                  <Radio className="mx-auto size-8 text-muted-foreground" />
                  <p className="font-medium">No live ads observed today</p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Accounts appear here automatically after an installed extension observes a
                    media buyer working in that Meta ad account.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}

function LiveTotals({
  totals,
}: {
  totals: {
    accounts_observed: number;
    copy_variants: number;
    live_ads: number;
    outcomes: Record<OverallStatus, number>;
    pending: number;
    unique_creatives: number;
  };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        icon={Activity}
        label="Accounts observed"
        value={totals.accounts_observed}
        detail="Entered by media buyers today"
      />
      <MetricCard
        icon={Radio}
        label="Live ads"
        value={totals.live_ads}
        detail={`${totals.unique_creatives} unique named creatives`}
      />
      <MetricCard
        icon={MessageSquareText}
        label="Primary texts"
        value={totals.copy_variants}
        detail="Reviewed separately from media"
      />
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Findings</CardDescription>
          <CardTitle className="text-2xl">
            {RESULT_ORDER.reduce((sum, status) => sum + totals.outcomes[status], 0)}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {RESULT_ORDER.map((status) => (
            <ResultBadge key={status} status={status} count={totals.outcomes[status]} />
          ))}
          {totals.pending ? <Badge variant="outline">{totals.pending} processing</Badge> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  detail,
  icon: Icon,
  label,
  value,
}: {
  detail: string;
  icon: typeof Activity;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          <Icon className="size-4" />
          {label}
        </CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}

function ReviewState({ state }: { state: LiveReviewState }) {
  if (state.result) return <ResultBadge status={state.result} />;
  if (state.status === 'waiting_media') {
    return (
      <div className="grid min-w-0 gap-1">
        <Badge variant="outline">Capturing media</Badge>
        <span className="break-words text-xs text-muted-foreground">
          Waiting for an accessible media URL
        </span>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="grid min-w-0 gap-1">
        <Badge variant="destructive">Failed</Badge>
        {state.message ? (
          <span className="break-words text-xs text-destructive">{state.message}</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="grid max-w-44 gap-1.5">
      <Badge variant="outline">{formatStatus(state.status)}</Badge>
      <Progress value={state.progress} aria-label={`${state.progress}% complete`} />
    </div>
  );
}

function CopyFindings({ copies }: { copies: LiveScanCopyFinding[] }) {
  if (!copies.length) {
    return <span className="text-sm text-muted-foreground">No primary text captured</span>;
  }
  return (
    <div className="grid gap-2">
      {copies.map((copy) => (
        <div
          key={copy.copy_key}
          className="grid min-w-0 gap-1.5 border-b pb-2 last:border-b-0 last:pb-0"
        >
          <div className="min-w-0">
            <p className="line-clamp-2 text-sm leading-5" title={copy.primary_text}>
              {copy.primary_text}
            </p>
            <p className="text-xs text-muted-foreground">
              Used by {copy.ad_count} ad{copy.ad_count === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex min-w-0 items-start gap-1">
            <ReviewState state={copy.review} />
            {copy.review.job_id && copy.review.status === 'complete' ? (
              <Link
                to="/reviews/$jobId/report"
                params={{ jobId: copy.review.job_id }}
                className={buttonVariants({ variant: 'ghost', size: 'icon-xs' })}
                aria-label="Open primary-text report"
              >
                <FileJson />
              </Link>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewReportLink({ state }: { state: LiveReviewState }) {
  if (!state.job_id) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Link
      to="/reviews/$jobId/report"
      params={{ jobId: state.job_id }}
      disabled={state.status !== 'complete'}
      className={cn(
        buttonVariants({ variant: 'outline', size: 'xs' }),
        state.status !== 'complete' && 'pointer-events-none opacity-50'
      )}
    >
      <FileJson />
      Open
    </Link>
  );
}

function ResultBadge({ count, status }: { count?: number; status: OverallStatus }) {
  const meta = RESULT_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={meta.className}>
      <Icon />
      {count === undefined ? meta.label : `${count} ${meta.label.toLowerCase()}`}
    </Badge>
  );
}

function LiveScansSkeleton() {
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32" />)}
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

function localDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatStatus(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
