import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileCheck2,
  History,
  Layers3,
  Plus,
  RefreshCw,
  ShieldCheck,
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  getReviewStats,
  listOfferCatalog,
  listReviews,
  type OfferCatalogItem,
  type OverallStatus,
  type ReviewHistoryItem,
  type ReviewStats,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const RESULT_ORDER: OverallStatus[] = ['green', 'yellow', 'orange', 'red'];
const RESULT_META: Record<OverallStatus, {
  badgeClass: string;
  barClass: string;
  description: string;
  icon: typeof CheckCircle2;
  label: string;
  valueClass: string;
}> = {
  green: {
    badgeClass: 'border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300',
    barClass: 'bg-emerald-500',
    description: 'Ready to run',
    icon: CheckCircle2,
    label: 'Green',
    valueClass: 'text-emerald-700 dark:text-emerald-300',
  },
  yellow: {
    badgeClass: 'border-yellow-600/30 bg-yellow-400/20 text-yellow-800 dark:border-yellow-400/30 dark:bg-yellow-400/15 dark:text-yellow-200',
    barClass: 'bg-yellow-400',
    description: 'Minor fixes',
    icon: TriangleAlert,
    label: 'Yellow',
    valueClass: 'text-yellow-700 dark:text-yellow-200',
  },
  orange: {
    badgeClass: 'border-orange-600/30 bg-orange-500/15 text-orange-700 dark:border-orange-400/30 dark:bg-orange-400/15 dark:text-orange-300',
    barClass: 'bg-orange-500',
    description: 'Review required',
    icon: AlertCircle,
    label: 'Orange',
    valueClass: 'text-orange-700 dark:text-orange-300',
  },
  red: {
    badgeClass: 'border-red-600/30 bg-red-500/15 text-red-700 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-300',
    barClass: 'bg-red-500',
    description: 'Do not publish',
    icon: XCircle,
    label: 'Red',
    valueClass: 'text-red-700 dark:text-red-300',
  },
};

export function DashboardPage() {
  const [selectedOfferId, setSelectedOfferId] = useState('');
  const offersQuery = useQuery({
    queryKey: ['offers', 'enabled'],
    queryFn: listOfferCatalog,
    staleTime: 60_000,
  });
  const enabledOffers = useMemo(
    () => (offersQuery.data ?? []).filter((offer) => offer.enabled),
    [offersQuery.data]
  );
  const fallbackOffer = enabledOffers.find((offer) => offer.is_default) ?? enabledOffers[0];
  const effectiveOfferId = enabledOffers.some((offer) => offer.offer_id === selectedOfferId)
    ? selectedOfferId
    : fallbackOffer?.offer_id ?? 'acp';

  useEffect(() => {
    if (selectedOfferId !== effectiveOfferId) setSelectedOfferId(effectiveOfferId);
  }, [effectiveOfferId, selectedOfferId]);

  const statsQuery = useQuery({
    queryKey: ['reviews', 'stats', effectiveOfferId],
    queryFn: () => getReviewStats(effectiveOfferId),
    staleTime: 15_000,
  });
  const recentQuery = useQuery({
    queryKey: ['reviews', 'recent', 8],
    queryFn: () => listReviews(8),
    refetchInterval: (query) => query.state.data?.some(
      (review) => !review.report_ready && review.status !== 'failed'
    ) ? 3_000 : false,
  });

  const selectedOffer = enabledOffers.find((offer) => offer.offer_id === effectiveOfferId);

  return (
    <div className="grid gap-4">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-1">
          <p className="text-sm font-medium text-muted-foreground">Overview</p>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Monitor review volume, outcomes, and the latest creative checks.
          </p>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
          <OfferFilter
            offers={enabledOffers}
            selectedOfferId={effectiveOfferId}
            onChange={setSelectedOfferId}
            isLoading={offersQuery.isLoading}
          />
          <Link to="/reviews/new" className={buttonVariants({ size: 'lg' })}>
            <Plus data-icon="inline-start" />
            Start a review
          </Link>
        </div>
      </section>

      {offersQuery.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Offer profiles unavailable</AlertTitle>
          <AlertDescription>
            Dashboard totals are falling back to ACP. {errorMessage(offersQuery.error)}
          </AlertDescription>
          <AlertAction>
            <Button type="button" size="xs" variant="outline" onClick={() => void offersQuery.refetch()}>
              <RefreshCw />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {!offersQuery.isLoading && !offersQuery.error && !enabledOffers.length ? (
        <Alert>
          <Layers3 />
          <AlertTitle>No enabled offer profiles</AlertTitle>
          <AlertDescription>
            Showing legacy ACP review data. Enable an offer profile in Settings to filter future results.
          </AlertDescription>
          <AlertAction>
            <Link to="/settings" className={buttonVariants({ variant: 'outline', size: 'xs' })}>
              Settings
            </Link>
          </AlertAction>
        </Alert>
      ) : null}

      {statsQuery.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Review insights unavailable</AlertTitle>
          <AlertDescription>{errorMessage(statsQuery.error)}</AlertDescription>
          <AlertAction>
            <Button type="button" size="xs" variant="outline" onClick={() => void statsQuery.refetch()}>
              <RefreshCw />
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : statsQuery.isLoading ? (
        <DashboardStatsSkeleton />
      ) : statsQuery.data ? (
        <DashboardStats stats={statsQuery.data} offer={selectedOffer} />
      ) : null}

      <RecentReviewsCard
        error={recentQuery.error}
        isLoading={recentQuery.isLoading}
        onRetry={() => void recentQuery.refetch()}
        reviews={recentQuery.data ?? []}
      />
    </div>
  );
}

function OfferFilter({
  isLoading,
  offers,
  onChange,
  selectedOfferId,
}: {
  isLoading: boolean;
  offers: OfferCatalogItem[];
  onChange: (offerId: string) => void;
  selectedOfferId: string;
}) {
  return (
    <label className="grid min-w-44 gap-1 text-xs font-medium text-muted-foreground">
      Offer
      {isLoading ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <select
          aria-label="Dashboard offer"
          className="h-9 rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          value={selectedOfferId}
          disabled={!offers.length}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {offers.length ? offers.map((offer) => (
            <option key={offer.offer_id} value={offer.offer_id}>
              {offer.display_name}
            </option>
          )) : <option value="acp">ACP</option>}
        </select>
      )}
    </label>
  );
}

function DashboardStats({ stats, offer }: { stats: ReviewStats; offer?: OfferCatalogItem }) {
  const outcomeTotal = RESULT_ORDER.reduce((sum, status) => sum + stats.outcomes[status], 0);
  const summary = [
    {
      icon: FileCheck2,
      label: 'Total reviews',
      value: stats.total_reviews,
      detail: `${stats.creative_reviews} creative · ${stats.copy_only_reviews} copy-only`,
    },
    {
      icon: Clock3,
      label: 'In progress',
      value: stats.in_progress_reviews,
      detail: stats.in_progress_reviews === 1 ? 'Active review' : 'Active reviews',
    },
    {
      icon: XCircle,
      label: 'Failed',
      value: stats.failed_reviews,
      detail: stats.failed_reviews ? 'Needs attention' : 'No failed reviews',
    },
    {
      icon: ShieldCheck,
      label: 'Accepted overrides',
      value: stats.accepted_overrides,
      detail: 'Cleared by internal guidance',
    },
  ];

  return (
    <div className="grid gap-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle>Review activity</CardTitle>
          <CardDescription>
            {offer?.display_name ?? formatOfferId(stats.offer_id)} · all saved, non-deleted reviews
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 xl:grid-cols-4">
            {summary.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label} className="flex items-start gap-3 bg-card p-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-muted-foreground">{item.label}</span>
                    <span className="block text-2xl font-semibold tabular-nums tracking-tight">{item.value}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {RESULT_ORDER.map((status) => {
          const meta = RESULT_META[status];
          const Icon = meta.icon;
          const count = stats.outcomes[status];
          return (
            <Card key={status} size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Icon className={cn('size-4', meta.valueClass)} />
                  {meta.label}
                </CardTitle>
                <CardDescription>{meta.description}</CardDescription>
                <CardAction>
                  <span className={cn('text-2xl font-semibold tabular-nums', meta.valueClass)}>{count}</span>
                </CardAction>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {formatPercent(count, outcomeTotal)} of rated reviews
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Status distribution</CardTitle>
          <CardDescription>
            {outcomeTotal ? `${outcomeTotal} completed reviews with a rated outcome` : 'No rated reviews yet'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div
            className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={distributionLabel(stats, outcomeTotal)}
          >
            {outcomeTotal ? RESULT_ORDER.map((status) => (
              <span
                key={status}
                className={RESULT_META[status].barClass}
                style={{ width: `${(stats.outcomes[status] / outcomeTotal) * 100}%` }}
              />
            )) : null}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {RESULT_ORDER.map((status) => (
              <span key={status} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn('size-2 rounded-full', RESULT_META[status].barClass)} />
                {RESULT_META[status].label} {stats.outcomes[status]}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RecentReviewsCard({
  error,
  isLoading,
  onRetry,
  reviews,
}: {
  error: Error | null;
  isLoading: boolean;
  onRetry: () => void;
  reviews: ReviewHistoryItem[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" />
          Recent reviews
        </CardTitle>
        <CardDescription>The eight latest jobs across all offers.</CardDescription>
        <CardAction>
          <Link to="/history" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            View history
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Recent reviews unavailable</AlertTitle>
            <AlertDescription>{errorMessage(error)}</AlertDescription>
            <AlertAction>
              <Button type="button" size="xs" variant="outline" onClick={onRetry}>
                <RefreshCw />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : isLoading ? (
          <div className="grid gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-14" />
            ))}
          </div>
        ) : reviews.length ? (
          <div className="divide-y rounded-lg border">
            {reviews.map((review) => <RecentReviewRow key={review.job_id} review={review} />)}
          </div>
        ) : (
          <div className="grid min-h-36 place-items-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
            <div className="grid max-w-sm gap-2">
              <Activity className="mx-auto size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No reviews yet</p>
              <p className="text-sm text-muted-foreground">
                Start a review to populate dashboard outcomes and recent activity.
              </p>
              <Link to="/reviews/new" className={cn(buttonVariants({ size: 'sm' }), 'mx-auto mt-1')}>
                <Plus />
                Start a review
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecentReviewRow({ review }: { review: ReviewHistoryItem }) {
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{review.file_name || review.job_id}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{formatDateTime(review.created_at)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatOfferId(review.primary_offer_id ?? review.offer_ids?.[0] ?? 'acp')}</span>
          {!review.report_ready && review.status !== 'failed' ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{review.progress}%</span>
            </>
          ) : null}
        </span>
      </span>
      <CompactStatusBadge status={review.overall_status ?? review.status} />
      <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/review:translate-x-0.5" />
    </>
  );
  const className = 'group/review flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

  return review.report_ready ? (
    <Link to="/reviews/$jobId/report" params={{ jobId: review.job_id }} className={className}>
      {content}
    </Link>
  ) : (
    <Link to="/reviews/$jobId" params={{ jobId: review.job_id }} className={className}>
      {content}
    </Link>
  );
}

function CompactStatusBadge({ status }: { status?: string | null }) {
  const result = normalizeResultStatus(status);
  if (result) {
    const meta = RESULT_META[result];
    return (
      <Badge variant="outline" className={meta.badgeClass}>
        <span className={cn('size-1.5 rounded-full', meta.barClass)} />
        {meta.label}
      </Badge>
    );
  }
  if (status === 'failed') return <Badge variant="destructive">Failed</Badge>;
  if (status === 'complete') return <Badge variant="secondary">Complete</Badge>;
  return <Badge variant="outline">{formatStatus(status ?? 'queued')}</Badge>;
}

function DashboardStatsSkeleton() {
  return (
    <div className="grid gap-4" aria-label="Loading dashboard insights">
      <Skeleton className="h-40" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-28" />)}
      </div>
      <Skeleton className="h-28" />
    </div>
  );
}

function normalizeResultStatus(status?: string | null): OverallStatus | null {
  if (status === 'green' || status === 'yellow' || status === 'orange' || status === 'red') {
    return status;
  }
  if (status === 'pass') return 'green';
  if (status === 'needs_review') return 'orange';
  if (status === 'likely_violation') return 'red';
  return null;
}

function formatPercent(value: number, total: number) {
  return total ? `${Math.round((value / total) * 100)}%` : '0%';
}

function distributionLabel(stats: ReviewStats, total: number) {
  if (!total) return 'No rated review outcomes';
  return RESULT_ORDER.map((status) => `${RESULT_META[status].label} ${stats.outcomes[status]}`).join(', ');
}

function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatOfferId(offerId: string) {
  return offerId === 'acp'
    ? 'ACP'
    : offerId.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value?: number | null) {
  if (!value) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default DashboardPage;
