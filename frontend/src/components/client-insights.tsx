import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowRight,
  CarFront,
  CheckCircle2,
  Clock3,
  Files,
  Gauge,
  Home,
  Layers3,
  Sparkles,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  ClientPortalFrame,
  effectiveReviewStatus,
  useClientAuth,
} from '@/components/client-dashboard';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
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
  listClientReviews,
  type ClientPortalSummary,
  type ClientReviewItem,
  type OverallStatus,
  type ReviewVertical,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const VERTICALS: Array<{
  description: string;
  icon: typeof CarFront;
  id: ReviewVertical;
  label: string;
}> = [
  {
    description: 'Performance and decision trends for auto insurance creatives.',
    icon: CarFront,
    id: 'auto-insurance',
    label: 'Auto Insurance',
  },
  {
    description: 'Performance and decision trends for home insurance creatives.',
    icon: Home,
    id: 'home-insurance',
    label: 'Home Insurance',
  },
];

type PortalReview = {
  clientId: string;
  portal: ClientPortalSummary;
  review: ClientReviewItem;
};

type InsightBatch = {
  batchId: string;
  clientId: string;
  createdAt: number;
  label: string;
  reviews: ClientReviewItem[];
};

export function ClientDashboardPage() {
  return <ClientInsights />;
}

export function ClientVerticalPage() {
  const { verticalId } = useParams({ from: '/client/verticals/$verticalId' });
  const vertical = VERTICALS.find((item) => item.id === verticalId);
  return <ClientInsights vertical={vertical?.id ?? 'auto-insurance'} />;
}

export function ClientBatchPage() {
  const { batchId, clientId } = useParams({ from: '/client/$clientId/batches/$batchId' });
  const { session } = useClientAuth();
  const portal = session.portals.find((item) => item.client_id === clientId);
  const query = useQuery({
    enabled: Boolean(portal),
    queryKey: ['client', clientId, 'reviews'],
    queryFn: () => listClientReviews(clientId),
    staleTime: 30_000,
  });
  const reviews = (query.data?.reviews ?? []).filter((review) => review.batch_id === batchId);
  const batch = reviews.length && portal
    ? buildInsightBatches(reviews.map((review) => ({ clientId, portal, review })))[0]
    : null;
  const counts = statusCounts(reviews);

  return (
    <ClientPortalFrame workspaceName={portal?.display_name}>
      <div className="grid gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="grid gap-1">
            <Link to="/client/reviews" className="mb-2 w-fit text-sm font-medium text-muted-foreground hover:text-foreground">← Back to review queue</Link>
            <p className="text-sm font-medium text-muted-foreground">Batch insights</p>
            <h1 className="font-heading text-3xl font-semibold tracking-tight">{batch?.label ?? 'Creative batch'}</h1>
            <p className="text-sm text-muted-foreground">A focused view of this batch’s effective results and client decisions.</p>
          </div>
          {batch ? <StatusPills counts={counts} total={reviews.length} /> : null}
        </div>

        {!portal ? (
          <EmptyState title="Batch unavailable" description="You do not have access to this client workspace." />
        ) : query.isLoading ? (
          <div className="grid gap-3"><Skeleton className="h-44" /><Skeleton className="h-52" /></div>
        ) : !batch ? (
          <EmptyState title="Batch not found" description="This batch may have been removed or is no longer available." />
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)]">
              <StatusBarChart batches={[batch]} />
              <StatusDonut counts={counts} />
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Creatives in this batch</CardTitle>
                <CardDescription>Client decisions are the visible result; the original AdChecked color remains available for context.</CardDescription>
                <CardAction><Badge variant="outline">{reviews.length} creatives</Badge></CardAction>
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {reviews.map((review) => {
                  const effective = effectiveReviewStatus(review);
                  return (
                    <Link
                      key={review.job_id}
                      to="/client/$clientId/reviews/$jobId"
                      params={{ clientId, jobId: review.job_id }}
                      className={cn(
                        'group grid gap-2 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        effective === 'green' && 'border-emerald-600/45',
                        effective === 'yellow' && 'border-yellow-600/45',
                        effective === 'red' && 'border-red-600/45',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium" title={review.file_name}>{review.file_name}</span>
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <ResultBadge status={effective} />
                        {effective !== review.ai_status ? <Badge variant="outline">AdChecked: {statusLabel(review.ai_status)}</Badge> : null}
                        <Badge variant="secondary">{review.decision?.decision ?? 'pending'}</Badge>
                      </span>
                    </Link>
                  );
                })}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </ClientPortalFrame>
  );
}

function ClientInsights({ vertical }: { vertical?: ReviewVertical }) {
  const { session } = useClientAuth();
  const queries = useQueries({
    queries: session.portals.map((portal) => ({
      queryKey: ['client', portal.client_id, 'reviews'],
      queryFn: () => listClientReviews(portal.client_id),
      refetchInterval: 60_000,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    })),
  });
  const allEntries = useMemo(() => session.portals.flatMap((portal, index) =>
    (queries[index]?.data?.reviews ?? []).map((review) => ({
      clientId: portal.client_id,
      portal,
      review,
    }))), [queries, session.portals]);
  const entries = vertical
    ? allEntries.filter((entry) => entry.review.vertical === vertical)
    : allEntries;
  const reviews = entries.map((entry) => entry.review);
  const batches = buildInsightBatches(entries);
  const counts = statusCounts(reviews);
  const pending = reviews.filter((review) => !review.decision).length;
  const overrides = reviews.filter((review) => review.decision && effectiveReviewStatus(review) !== review.ai_status).length;
  const approvalRate = reviews.length ? Math.round((counts.green / reviews.length) * 100) : 0;
  const isLoading = queries.some((query) => query.isLoading);
  const selectedVertical = vertical ? VERTICALS.find((item) => item.id === vertical) : null;

  return (
    <ClientPortalFrame>
      <div className="grid gap-5">
        <section className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-1">
            <p className="text-sm font-medium text-muted-foreground">{selectedVertical ? 'Performance by insurance line' : 'Workspace overview'}</p>
            <h1 className="font-heading text-3xl font-semibold tracking-tight">{selectedVertical?.label ?? 'Creative performance'}</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              {selectedVertical?.description ?? 'See effective results, decision progress, and batch performance across every creative.'}
            </p>
          </div>
          <Link to="/client/reviews" className={buttonVariants({ size: 'sm' })}><Files />Open review queue</Link>
        </section>

        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        ) : (
          <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-4">
            <InsightMetric icon={Gauge} label="Creatives" value={reviews.length} detail={`${batches.length} batch${batches.length === 1 ? '' : 'es'}`} />
            <InsightMetric icon={CheckCircle2} label="Effective green" value={counts.green} detail={`${approvalRate}% ready rate`} tone="success" />
            <InsightMetric icon={Clock3} label="Needs decision" value={pending} detail={pending ? 'Waiting for client review' : 'Everything reviewed'} />
            <InsightMetric icon={Sparkles} label="Client overrides" value={overrides} detail="Final decisions different from AI" />
          </div>
        )}

        {!vertical ? (
          <section className="grid gap-3 sm:grid-cols-2">
            {VERTICALS.map((item) => {
              const Icon = item.icon;
              const verticalReviews = allEntries.filter((entry) => entry.review.vertical === item.id).map((entry) => entry.review);
              const verticalCounts = statusCounts(verticalReviews);
              return (
                <Link key={item.id} to="/client/verticals/$verticalId" params={{ verticalId: item.id }} className="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Card className="h-full transition-colors group-hover:bg-muted/25">
                    <CardHeader>
                      <span className="mb-1 grid size-9 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"><Icon className="size-4" /></span>
                      <CardTitle>{item.label}</CardTitle>
                      <CardDescription>{item.description}</CardDescription>
                      <CardAction><ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" /></CardAction>
                    </CardHeader>
                    <CardContent><StatusPills counts={verticalCounts} total={verticalReviews.length} /></CardContent>
                  </Card>
                </Link>
              );
            })}
          </section>
        ) : null}

        {reviews.length ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,0.8fr)]">
            <StatusBarChart batches={batches.slice(0, 8)} />
            <StatusDonut counts={counts} />
          </div>
        ) : (
          <EmptyState
            title={selectedVertical ? `No ${selectedVertical.label} creatives yet` : 'No creative data yet'}
            description={selectedVertical?.id === 'home-insurance'
              ? 'Creatives assigned to Home Insurance during submission will appear here.'
              : 'Submit a new batch to populate performance insights.'}
          />
        )}

        {batches.length ? (
          <Card>
            <CardHeader>
              <CardTitle>Recent batches</CardTitle>
              <CardDescription>Open any batch for its own result distribution and creative list.</CardDescription>
              <CardAction><Badge variant="outline">{batches.length} total</Badge></CardAction>
            </CardHeader>
            <CardContent className="grid gap-2">
              {batches.slice(0, 6).map((batch) => (
                <Link
                  key={`${batch.clientId}:${batch.batchId}`}
                  to="/client/$clientId/batches/$batchId"
                  params={{ clientId: batch.clientId, batchId: batch.batchId }}
                  className="group flex flex-wrap items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="grid size-9 place-items-center rounded-lg bg-muted/55 text-muted-foreground"><Layers3 className="size-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{batch.label}</span><span className="block text-xs text-muted-foreground">{formatDate(batch.createdAt)} · {batch.reviews.length} creatives</span></span>
                  <StatusPills counts={statusCounts(batch.reviews)} total={batch.reviews.length} compact />
                  <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </ClientPortalFrame>
  );
}

function InsightMetric({ detail, icon: Icon, label, tone, value }: {
  detail: string;
  icon: typeof Gauge;
  label: string;
  tone?: 'success';
  value: number;
}) {
  return (
    <div className="flex items-start gap-3 bg-card p-4">
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground', tone === 'success' && 'border-emerald-600/30 bg-emerald-500/10 text-emerald-700')}><Icon className="size-4" /></span>
      <span className="min-w-0"><span className="block text-xs font-medium text-muted-foreground">{label}</span><span className="block text-2xl font-semibold tabular-nums tracking-tight">{value}</span><span className="block truncate text-xs text-muted-foreground">{detail}</span></span>
    </div>
  );
}

function StatusBarChart({ batches }: { batches: InsightBatch[] }) {
  const data = batches.slice().reverse().map((batch) => ({
    batch: compactBatchLabel(batch.label, batch.createdAt),
    ...statusCounts(batch.reviews),
  }));
  return (
    <Card>
      <CardHeader><CardTitle>Batch performance</CardTitle><CardDescription>Effective results after client decisions.</CardDescription></CardHeader>
      <CardContent className="h-72 pl-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ left: -18, right: 8, top: 8, bottom: 12 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="batch" tickLine={false} axisLine={false} fontSize={11} interval={0} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={11} />
            <Tooltip cursor={{ fill: 'var(--muted)' }} contentStyle={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--popover)', color: 'var(--popover-foreground)' }} />
            <Bar dataKey="green" stackId="status" fill="var(--chart-1)" radius={[0, 0, 4, 4]} />
            <Bar dataKey="yellow" stackId="status" fill="var(--chart-3)" />
            <Bar dataKey="red" stackId="status" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function StatusDonut({ counts }: { counts: Record<OverallStatus, number> }) {
  const total = counts.green + counts.yellow + counts.red;
  const data = [
    { name: 'Green', value: counts.green, color: 'var(--chart-1)' },
    { name: 'Yellow', value: counts.yellow, color: 'var(--chart-3)' },
    { name: 'Red', value: counts.red, color: 'var(--chart-4)' },
  ].filter((item) => item.value > 0);
  return (
    <Card>
      <CardHeader><CardTitle>Result mix</CardTitle><CardDescription>{total} effective results</CardDescription></CardHeader>
      <CardContent className="grid grid-cols-[9rem_1fr] items-center gap-3">
        <div className="relative h-36 w-36">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart><Pie data={data} dataKey="value" innerRadius={43} outerRadius={64} paddingAngle={2} strokeWidth={0}>{data.map((item) => <Cell key={item.name} fill={item.color} />)}</Pie></PieChart>
          </ResponsiveContainer>
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-xl font-semibold tabular-nums">{total}</span>
        </div>
        <div className="grid gap-2">
          {(['green', 'yellow', 'red'] as OverallStatus[]).map((status) => <div key={status} className="flex items-center justify-between gap-3 text-sm"><span className="flex items-center gap-2"><span className={cn('size-2.5 rounded-full', status === 'green' ? 'bg-emerald-500' : status === 'yellow' ? 'bg-yellow-400' : 'bg-red-500')} />{statusLabel(status)}</span><span className="font-medium tabular-nums">{counts[status]}</span></div>)}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusPills({ compact = false, counts, total }: { compact?: boolean; counts: Record<OverallStatus, number>; total: number }) {
  return <span className="flex flex-wrap items-center gap-1.5"><Badge variant="outline" className={cn(compact && 'hidden lg:inline-flex')}>{total} total</Badge><ResultBadge status="green" value={counts.green} /><ResultBadge status="yellow" value={counts.yellow} /><ResultBadge status="red" value={counts.red} /></span>;
}

function ResultBadge({ status, value }: { status: OverallStatus; value?: number }) {
  const Icon = status === 'green' ? CheckCircle2 : status === 'yellow' ? TriangleAlert : XCircle;
  return <Badge variant="outline" className={cn(status === 'green' && 'border-emerald-600/35 bg-emerald-500/10 text-emerald-700', status === 'yellow' && 'border-yellow-600/35 bg-yellow-400/10 text-yellow-700', status === 'red' && 'border-red-600/35 bg-red-500/10 text-red-700')}><Icon />{value === undefined ? statusLabel(status) : value}</Badge>;
}

function EmptyState({ description, title }: { description: string; title: string }) {
  return <div className="grid min-h-56 place-items-center rounded-xl border border-dashed bg-card p-6 text-center"><div className="grid max-w-sm gap-2"><Gauge className="mx-auto size-7 text-muted-foreground" /><p className="font-medium">{title}</p><p className="text-sm leading-6 text-muted-foreground">{description}</p></div></div>;
}

function buildInsightBatches(entries: PortalReview[]): InsightBatch[] {
  const values = new Map<string, InsightBatch>();
  for (const entry of entries) {
    if (!entry.review.batch_id) continue;
    const key = `${entry.clientId}:${entry.review.batch_id}`;
    const existing = values.get(key);
    if (existing) existing.reviews.push(entry.review);
    else values.set(key, {
      batchId: entry.review.batch_id,
      clientId: entry.clientId,
      createdAt: entry.review.batch_created_at,
      label: entry.review.batch_source_label || `${formatDate(entry.review.batch_created_at)} · Creative approval`,
      reviews: [entry.review],
    });
  }
  return [...values.values()].sort((left, right) => right.createdAt - left.createdAt);
}

function statusCounts(reviews: ClientReviewItem[]): Record<OverallStatus, number> {
  return {
    green: reviews.filter((review) => effectiveReviewStatus(review) === 'green').length,
    yellow: reviews.filter((review) => effectiveReviewStatus(review) === 'yellow').length,
    red: reviews.filter((review) => effectiveReviewStatus(review) === 'red').length,
  };
}

function compactBatchLabel(label: string, createdAt: number) {
  if (label.length <= 18) return label;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(createdAt));
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function statusLabel(status: OverallStatus) {
  return `${status[0].toUpperCase()}${status.slice(1)}`;
}
