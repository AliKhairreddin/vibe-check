import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useQueries,
  useQuery,
} from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileImage,
  FileJson,
  Moon,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Sun,
  Upload,
} from 'lucide-react';
import './index.css';
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
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  createReview,
  type Finding,
  getReport,
  getStatus,
  listReviews,
  type OverallStatus,
  type ReviewHistoryItem,
  type Status,
} from '@/lib/api';

type Theme = 'light' | 'dark';
type UploadPhase = 'pending' | 'uploading' | 'queued' | 'failed';

type BatchItem = {
  id: string;
  fileName: string;
  kind: 'creative' | 'ad_copy';
  size: number;
  uploadProgress: number;
  phase: UploadPhase;
  jobId?: string;
  error?: string;
};

const queryClient = new QueryClient();
const ACTIVE_BATCH_KEY = 'vibe-check-active-batch-v2';
const AD_COPY_PREVIEW_LENGTH = 56;
const SOURCE_LABELS: Record<Finding['source'], string> = {
  ad_copy: 'Ad Copy',
  audio: 'Audio Transcript',
  onscreen_text: 'On-screen Text',
  policy: 'Policy',
  visual: 'Visual',
};
const STATUS_LABELS: Record<OverallStatus | 'analyzing_visuals' | 'complete' | 'failed', string> = {
  analyzing_visuals: 'Analyzing Visuals',
  complete: 'Complete',
  failed: 'Failed',
  likely_violation: 'Likely Violation',
  needs_review: 'Needs Review',
  pass: 'Pass',
};

function loadActiveBatch(): BatchItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const saved = window.localStorage.getItem(ACTIVE_BATCH_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const item = value as Partial<BatchItem>;
      if (typeof item.jobId !== 'string' || !item.jobId) return [];
      const kind = item.kind === 'ad_copy' ? 'ad_copy' : 'creative';
      return [{
        id: item.jobId,
        fileName: typeof item.fileName === 'string' && item.fileName ? item.fileName : item.jobId,
        kind,
        size: typeof item.size === 'number' ? item.size : 0,
        uploadProgress: 100,
        phase: 'queued' as const,
        jobId: item.jobId,
      }];
    });
  } catch {
    return [];
  }
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light';
    return window.localStorage.getItem('vibe-check-theme') === 'dark'
      ? 'dark'
      : 'light';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem('vibe-check-theme', theme);
  }, [theme]);

  return {
    theme,
    toggleTheme: () => setTheme((current) => (current === 'dark' ? 'light' : 'dark')),
  };
}

function AppShell() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="sticky top-0 z-20 -mx-4 mb-5 border-b bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <nav className="mx-auto flex max-w-7xl items-center justify-between gap-3">
            <Link to="/" className="flex min-w-0 items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-card">
                <FileImage className="size-4" />
              </span>
              <span className="truncate font-heading text-base font-medium">
                Vibe Check
              </span>
            </Link>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={toggleTheme}
                      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                    />
                  }
                >
                  {theme === 'dark' ? <Sun /> : <Moon />}
                </TooltipTrigger>
                <TooltipContent>
                  {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Link
                      to="/settings"
                      className={buttonVariants({ variant: 'outline', size: 'icon' })}
                      aria-label="Settings"
                    />
                  }
                >
                  <Settings />
                </TooltipTrigger>
                <TooltipContent>Settings</TooltipContent>
              </Tooltip>
            </div>
          </nav>
        </header>
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({ component: AppShell });

function Home() {
  const [sceneDetection, setSceneDetection] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [adCopyText, setAdCopyText] = useState('');
  const [batchItems, setBatchItems] = useState<BatchItem[]>(loadActiveBatch);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const adCopyLines = useMemo(() => splitAdCopyLines(adCopyText), [adCopyText]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const persisted = batchItems.filter((item) => item.jobId);
    if (persisted.length) {
      window.localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify(persisted));
      return;
    }
    window.localStorage.removeItem(ACTIVE_BATCH_KEY);
  }, [batchItems]);

  const historyQuery = useQuery({
    queryKey: ['reviews', 'history'],
    queryFn: () => listReviews(50),
    refetchInterval: (query) => {
      const reviews = query.state.data;
      return reviews?.some((review) => !review.report_ready && review.status !== 'failed')
        ? 3000
        : false;
    },
  });

  const statusQueries = useQueries({
    queries: batchItems.map((item) => ({
      queryKey: ['status', item.jobId],
      queryFn: () => getStatus(item.jobId as string),
      enabled: Boolean(item.jobId),
      refetchInterval: (query: { state: { data?: Status } }) => {
        const status = query.state.data;
        return status?.report_ready || status?.status === 'failed' ? false : 1500;
      },
    })),
  });

  const rows = batchItems.map((item, index) => ({
    item,
    status: statusQueries[index]?.data,
    queryError: statusQueries[index]?.error,
    retry: statusQueries[index]?.refetch,
  }));

  const overallProgress = useMemo(() => {
    if (!rows.length) return 0;
    const total = rows.reduce((sum, row) => sum + progressFor(row.item, row.status), 0);
    return Math.round(total / rows.length);
  }, [rows]);
  const failedCount = rows.filter(
    ({ item, status }) => Boolean(item.error) || status?.status === 'failed'
  ).length;

  function updateBatchItem(id: string, patch: Partial<BatchItem>) {
    setBatchItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError('');

    const form = event.currentTarget;
    const fileInput = form.elements.namedItem('creative') as HTMLInputElement | null;
    const files = Array.from(fileInput?.files ?? []);
    const copyOnly = files.length === 0;

    if (!files.length && !adCopyLines.length) {
      setSubmitError('Choose at least one creative or enter ad copy to review.');
      return;
    }

    const sharedFields = new FormData(form);
    const batchStamp = Date.now();
    const nextItems = copyOnly
      ? adCopyLines.map((copy, index) => ({
          id: `copy-${batchStamp}-${index}`,
          fileName: adCopyItemName(copy, index),
          kind: 'ad_copy' as const,
          size: new Blob([copy]).size,
          uploadProgress: 0,
          phase: 'pending' as const,
        }))
      : files.map((file, index) => ({
          id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
          fileName: file.name,
          kind: 'creative' as const,
          size: file.size,
          uploadProgress: 0,
          phase: 'pending' as const,
        }));

    setBatchItems(nextItems);
    setIsSubmitting(true);

    for (const [index, item] of nextItems.entries()) {
      const copyLine = copyOnly ? adCopyLines[index] : undefined;
      const file = copyOnly ? null : files[index] ?? null;
      updateBatchItem(item.id, { phase: 'uploading' });

      try {
        const status = await createReview(
          buildReviewForm(sharedFields, file, sceneDetection, copyLine),
          (progress) => updateBatchItem(item.id, { uploadProgress: progress })
        );
        updateBatchItem(item.id, {
          jobId: status.job_id,
          phase: 'queued',
          uploadProgress: 100,
        });
        queryClient.setQueryData(['status', status.job_id], status);
        queryClient.invalidateQueries({ queryKey: ['reviews', 'history'] });
      } catch (error) {
        updateBatchItem(item.id, {
          phase: 'failed',
          error: error instanceof Error ? error.message : String(error),
          uploadProgress: 100,
        });
      }
    }

    setIsSubmitting(false);
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
        <Card>
        <CardHeader>
          <CardTitle as="h1" className="text-xl">Review workspace</CardTitle>
          <CardDescription>
            Upload ad creatives or review platform copy by itself.
          </CardDescription>
          <CardAction>
            <Badge variant="outline">
              {selectionBadgeLabel(selectedFiles.length, adCopyLines.length)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="creative">Ad creatives</Label>
              <Input
                id="creative"
                multiple
                name="creative"
                type="file"
                accept="video/mp4,image/jpeg,image/png,image/webp"
                className="h-auto min-h-20 cursor-pointer border-dashed py-5"
                onChange={(event) => {
                  setSelectedFiles(Array.from(event.currentTarget.files ?? []));
                }}
              />
            </div>

            <FormField label="Ad copy / platform captions" htmlFor="ad_copy">
              <div className="grid gap-2">
                <Textarea
                  id="ad_copy"
                  name="ad_copy"
                  value={adCopyText}
                  className="min-h-32"
                  placeholder={'Save more today.\nGet a free quote in minutes.'}
                  aria-describedby="ad-copy-help"
                  onChange={(event) => setAdCopyText(event.currentTarget.value)}
                />
                <p id="ad-copy-help" className="text-xs leading-5 text-muted-foreground">
                  Without a creative, each non-empty line becomes a separate job. With
                  creatives, the full text is attached to every selected creative.
                </p>
              </div>
            </FormField>

            <details className="group rounded-lg border bg-muted/20">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <SlidersHorizontal className="size-4 text-muted-foreground" />
                Advanced review options
                <span className="ml-auto hidden text-xs font-normal text-muted-foreground group-open:hidden sm:inline">
                  Policy, transcript, notes, model, and sampling
                </span>
              </summary>
              <div className="grid gap-4 border-t px-3 py-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <FormField label="Additional policy/guidelines" htmlFor="policy_text">
                    <Textarea
                      id="policy_text"
                      name="policy_text"
                      className="min-h-28"
                      placeholder="Saved publisher guidelines are included automatically."
                    />
                  </FormField>
                  <FormField label="Optional transcript override" htmlFor="manual_transcript">
                    <Textarea
                      id="manual_transcript"
                      name="manual_transcript"
                      className="min-h-28"
                    />
                  </FormField>
                </div>

                <FormField label="Optional product/brand notes" htmlFor="notes">
                  <Textarea id="notes" name="notes" className="min-h-24" />
                </FormField>

                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
                  <FormField label="OpenRouter model" htmlFor="model">
                    <Input
                      id="model"
                      name="model"
                      placeholder="deepseek/deepseek-v4-flash"
                    />
                  </FormField>
                  <FormField label="Frame interval" htmlFor="frame_interval_seconds">
                    <Input
                      id="frame_interval_seconds"
                      name="frame_interval_seconds"
                      type="number"
                      step="0.5"
                      min="0.5"
                      defaultValue="1"
                    />
                  </FormField>
                </div>

                <div className="flex items-center justify-between gap-4 rounded-lg border bg-background/70 px-3 py-3">
                  <div className="grid gap-1">
                    <Label htmlFor="scene_detection">Video scene-change detection</Label>
                    <p className="text-sm text-muted-foreground">
                      Also sample sharp visual cuts so brief on-screen text is less likely
                      to be missed. This can add processing time.
                    </p>
                  </div>
                  <Switch
                    id="scene_detection"
                    checked={sceneDetection}
                    onCheckedChange={setSceneDetection}
                  />
                </div>
              </div>
            </details>

            {submitError ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Upload blocked</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {submissionHint(selectedFiles.length, adCopyLines.length)}
              </p>
              <Button type="submit" disabled={isSubmitting}>
                <Upload data-icon="inline-start" />
                {isSubmitting ? 'Creating jobs' : 'Create review'}
              </Button>
            </div>
          </form>
        </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Batch progress</CardTitle>
            <CardDescription>
              Submission progress first, then backend review progress for each job.
            </CardDescription>
            <CardAction>
              <div className="flex items-center gap-2">
                {rows.length ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setBatchItems([])}
                  >
                    Clear
                  </Button>
                ) : null}
                <Badge
                  variant={
                    failedCount ? 'destructive' : overallProgress === 100 && rows.length
                      ? 'secondary'
                      : 'outline'
                  }
                >
                  {failedCount
                    ? `${failedCount} failed`
                    : overallProgress === 100 && rows.length
                      ? 'Complete'
                      : `${overallProgress}%`}
                </Badge>
              </div>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Progress value={overallProgress}>
              <ProgressLabel>
                {failedCount ? `Overall · ${failedCount} failed` : 'Overall'}
              </ProgressLabel>
              <ProgressValue />
            </Progress>
            {failedCount ? (
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Some jobs did not complete</AlertTitle>
                <AlertDescription>
                  Review the failed job messages below, then adjust the input and resubmit.
                </AlertDescription>
              </Alert>
            ) : null}
            <Separator />
            {rows.length ? (
              <div className="grid gap-3">
                {rows.map(({ item, queryError, retry, status }) => (
                  <BatchRow
                    key={item.id}
                    item={item}
                    status={status}
                    queryError={queryError}
                    onRetry={retry ? () => void retry() : undefined}
                  />
                ))}
              </div>
            ) : (
              <EmptyBatchState />
            )}
          </CardContent>
        </Card>
      </div>

      <HistoryCard
        error={historyQuery.error}
        isLoading={historyQuery.isLoading}
        onRetry={() => void historyQuery.refetch()}
        reviews={historyQuery.data ?? []}
      />
    </div>
  );
}

function FormField({
  children,
  htmlFor,
  label,
}: {
  children: React.ReactNode;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function EmptyBatchState() {
  return (
    <div className="grid min-h-64 place-items-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
      <div className="grid max-w-xs gap-2">
        <div className="mx-auto grid size-10 place-items-center rounded-lg border bg-card">
          <FileImage className="size-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No active batch</p>
        <p className="text-sm text-muted-foreground">
          Start a review to watch each job move through the queue.
        </p>
      </div>
    </div>
  );
}

function BatchRow({
  item,
  onRetry,
  queryError,
  status,
}: {
  item: BatchItem;
  onRetry?: () => void;
  queryError?: Error | null;
  status?: Status;
}) {
  const progress = progressFor(item, status);
  const displayStatus = item.error
    ? 'failed'
    : status?.status ?? (queryError ? 'connection_issue' : item.phase);
  const message =
    item.error ??
    status?.message ??
    (queryError ? 'Status temporarily unavailable' : phaseMessage(item.phase, item.kind));

  return (
    <div className="grid gap-3 rounded-lg border bg-card/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {item.kind === 'ad_copy' ? 'Ad copy only' : formatBytes(item.size)}
          </p>
        </div>
        <StatusBadge status={displayStatus} />
      </div>
      <Progress value={progress}>
        <ProgressLabel className="truncate">{message}</ProgressLabel>
        <ProgressValue />
      </Progress>
      {queryError ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>Could not refresh this job</AlertTitle>
          <AlertDescription>{errorMessage(queryError)}</AlertDescription>
          {onRetry ? (
            <AlertAction>
              <Button type="button" variant="outline" size="xs" onClick={onRetry}>
                <RefreshCw />
                Retry
              </Button>
            </AlertAction>
          ) : null}
        </Alert>
      ) : null}
      {status?.report_ready ? (
        <Link
          to="/reviews/$jobId/report"
          params={{ jobId: status.job_id }}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'justify-self-start')}
        >
          <FileJson data-icon="inline-start" />
          Open report
        </Link>
      ) : item.jobId ? (
        <Link
          to="/reviews/$jobId"
          params={{ jobId: item.jobId }}
          className="w-fit text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          View job
        </Link>
      ) : null}
    </div>
  );
}

function HistoryCard({
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
        <CardTitle className="text-xl">Review history</CardTitle>
        <CardDescription>
          Previous reviews stay here with split creative and copy results.
        </CardDescription>
        <CardAction>
          <Badge variant="outline">{reviews.length} saved</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>History unavailable</AlertTitle>
            <AlertDescription>{errorMessage(error)}</AlertDescription>
            <AlertAction>
              <Button type="button" variant="outline" size="xs" onClick={onRetry}>
                <RefreshCw />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : isLoading ? (
          <div className="grid gap-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-24" />
          </div>
        ) : reviews.length ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Creative</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Creative Result</TableHead>
                  <TableHead>Ad Copy Result</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviews.map((review) => (
                  <TableRow key={review.job_id}>
                    <TableCell className="min-w-48 max-w-80">
                      <span className="block truncate font-medium">
                        {review.file_name || review.job_id}
                      </span>
                    </TableCell>
                    <TableCell className="min-w-40 text-muted-foreground">
                      {formatDateTime(review.created_at)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={review.status} />
                    </TableCell>
                    <TableCell>
                      {review.has_creative ?? true ? (
                        <ResultCell
                          status={
                            review.creative_result ??
                            (review.has_creative === undefined ? review.overall_status : null)
                          }
                        />
                      ) : (
                        <span className="text-sm text-muted-foreground">N/A</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {review.has_ad_copy ?? true ? (
                        <ResultCell
                          status={
                            review.ad_copy_result ??
                            (review.has_ad_copy === undefined ? review.overall_status : null)
                          }
                        />
                      ) : (
                        <span className="text-sm text-muted-foreground">N/A</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {review.report_ready ? (
                        <Link
                          to="/reviews/$jobId/report"
                          params={{ jobId: review.job_id }}
                          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                        >
                          <FileJson data-icon="inline-start" />
                          Open report
                        </Link>
                      ) : (
                        <Link
                          to="/reviews/$jobId"
                          params={{ jobId: review.job_id }}
                          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                        >
                          View job
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="grid min-h-36 place-items-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              Completed and in-progress reviews will appear here after the first upload.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProgressPage() {
  const { jobId } = useParams({ from: '/reviews/$jobId' });
  const query = useQuery({
    queryKey: ['status', jobId],
    queryFn: () => getStatus(jobId),
    refetchInterval: (currentQuery) => {
      const status = currentQuery.state.data;
      return status?.report_ready || status?.status === 'failed' ? false : 1500;
    },
  });
  const status = query.data;

  return (
    <Card className="mx-auto max-w-3xl">
      <CardHeader>
        <CardTitle as="h1" className="text-xl">Job progress</CardTitle>
        <CardDescription>{status?.file_name ?? jobId}</CardDescription>
        <CardAction>
          <StatusBadge status={status?.status ?? 'loading'} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Progress value={status?.progress ?? 0}>
          <ProgressLabel>{status?.message ?? 'Loading job status'}</ProgressLabel>
          <ProgressValue />
        </Progress>
        {status?.report_ready ? (
          <Link
            className={cn(buttonVariants({ variant: 'default' }), 'justify-self-start')}
            to="/reviews/$jobId/report"
            params={{ jobId }}
          >
            <FileJson data-icon="inline-start" />
            Open report
          </Link>
        ) : null}
        {query.error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Status unavailable</AlertTitle>
            <AlertDescription>{errorMessage(query.error)}</AlertDescription>
            <AlertAction>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void query.refetch()}
              >
                <RefreshCw />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReportPage() {
  const { jobId } = useParams({ from: '/reviews/$jobId/report' });
  const query = useQuery({ queryKey: ['report', jobId], queryFn: () => getReport(jobId) });
  const column = createColumnHelper<Finding>();
  const table = useReactTable({
    data: query.data?.findings ?? [],
    columns: [
      column.accessor('severity', {
        header: 'Severity',
        cell: (info) => <SeverityBadge severity={info.getValue()} />,
      }),
      column.accessor(
        (row) =>
          `${row.timestamp_start ?? ''}${row.timestamp_end ? ` - ${row.timestamp_end}` : ''}`,
        { id: 'timestamp', header: 'Timestamp' }
      ),
      column.accessor('source', {
        header: 'Source',
        cell: (info) => <Badge variant="outline">{formatSource(info.getValue())}</Badge>,
      }),
      column.accessor('evidence', { header: 'Evidence' }),
      column.accessor('policy_reason', { header: 'Policy reason' }),
      column.accessor('suggested_fix', { header: 'Suggested fix' }),
    ],
    getCoreRowModel: getCoreRowModel(),
  });

  if (query.isLoading) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (!query.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Report unavailable</AlertTitle>
        <AlertDescription>
          {query.error ? errorMessage(query.error) : 'The report is not ready yet.'}
        </AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void query.refetch()}
          >
            <RefreshCw />
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle as="h1" className="text-xl">Review summary</CardTitle>
          <CardDescription>Review job {jobId}</CardDescription>
          <CardAction>
            <StatusBadge status={query.data.overall_status} />
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="max-w-4xl text-sm leading-6 text-muted-foreground">
            {query.data.summary}
          </p>
          <a
            className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
            href={`/api/reviews/${jobId}/report.json`}
          >
            <Download data-icon="inline-start" />
            Download JSON
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Findings</CardTitle>
          <CardDescription>{query.data.findings.length} findings returned</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className="max-w-[22rem] whitespace-normal align-top"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={table.getAllColumns().length}>
                    No findings were returned.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Safer rewrites</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm leading-6 text-muted-foreground">
            <p>{query.data.safe_rewrite.ad_copy || 'No copy rewrite returned.'}</p>
            {query.data.safe_rewrite.onscreen_text.length ? (
              <ul className="grid list-disc gap-2 pl-5">
                {query.data.safe_rewrite.onscreen_text.map((text, index) => (
                  <li key={`${text}-${index}`}>{text}</li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Review limitations</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid list-disc gap-2 pl-5 text-sm leading-6 text-muted-foreground">
              {query.data.limitations.map((limitation, index) => (
                <li key={`${limitation}-${index}`}>{limitation}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SettingsPage() {
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle as="h1" className="text-xl">Settings</CardTitle>
          <CardDescription>Runtime configuration for deployed reviews.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm leading-6 text-muted-foreground">
          <p>
            Configure OPENROUTER_API_KEY and CONVEX_HTTP_SECRET as Cloudflare Worker
            secrets. The Convex URL is non-secret Worker config, and creatives stay in
            temporary container storage while Convex saves filename, status, progress,
            and final report JSON.
          </p>
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Processing model</AlertTitle>
            <AlertDescription>
              Multi-creative uploads create separate jobs. The backend queue processes one
              job at a time by default and reports per-job progress back to the UI.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'failed' || status === 'likely_violation') {
    return <Badge variant="destructive">{formatStatus(status)}</Badge>;
  }
  if (status === 'complete' || status === 'pass') {
    return <Badge variant="secondary">{formatStatus(status)}</Badge>;
  }
  return <Badge variant="outline">{formatStatus(status)}</Badge>;
}

function SeverityBadge({ severity }: { severity: Finding['severity'] }) {
  if (severity === 'high') return <Badge variant="destructive">High</Badge>;
  if (severity === 'medium') return <Badge variant="secondary">Medium</Badge>;
  return <Badge variant="outline">Low</Badge>;
}

function ResultCell({ status }: { status?: string | null }) {
  return status ? (
    <StatusBadge status={status} />
  ) : (
    <span className="text-sm text-muted-foreground">Not ready</span>
  );
}

function buildReviewForm(
  source: FormData,
  creative: File | null,
  sceneDetection: boolean,
  adCopyOverride?: string
) {
  const form = new FormData();
  if (creative) form.append('creative', creative);

  for (const key of [
    'ad_copy',
    'policy_text',
    'notes',
    'manual_transcript',
    'model',
    'frame_interval_seconds',
  ]) {
    if (key === 'ad_copy' && adCopyOverride !== undefined) {
      form.append(key, adCopyOverride);
      continue;
    }
    const value = source.get(key);
    if (typeof value === 'string') form.append(key, value);
  }

  if (sceneDetection) form.append('scene_detection', 'true');
  return form;
}

function splitAdCopyLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function adCopyItemName(copy: string, index: number) {
  const preview = copy.replace(/\s+/g, ' ').trim();
  if (!preview) return `Ad copy ${index + 1}`;
  const trimmed =
    preview.length > AD_COPY_PREVIEW_LENGTH
      ? `${preview.slice(0, AD_COPY_PREVIEW_LENGTH - 3).trim()}...`
      : preview;
  return `Ad copy ${index + 1}: ${trimmed}`;
}

function selectionBadgeLabel(creativeCount: number, copyLineCount: number) {
  if (creativeCount) return `${creativeCount} creative${creativeCount === 1 ? '' : 's'}`;
  if (copyLineCount) return `${copyLineCount} copy line${copyLineCount === 1 ? '' : 's'}`;
  return '0 selected';
}

function submissionHint(creativeCount: number, copyLineCount: number) {
  if (creativeCount > 1) return `${creativeCount} creatives will be queued as separate jobs.`;
  if (creativeCount === 1) return 'Each creative becomes one review job.';
  if (copyLineCount > 1) return `${copyLineCount} ad copy lines will be queued as separate jobs.`;
  if (copyLineCount === 1) return 'This ad copy line becomes one review job.';
  return 'Select a creative or enter ad copy to create a review job.';
}

function progressFor(item: BatchItem, status?: Status) {
  if (status) return status.progress;
  if (item.error) return 100;
  if (item.phase === 'uploading') return item.uploadProgress;
  return 0;
}

function phaseMessage(phase: UploadPhase, kind: BatchItem['kind']) {
  if (phase === 'uploading') return kind === 'ad_copy' ? 'Submitting' : 'Uploading';
  if (phase === 'queued') return 'Queued';
  if (phase === 'failed') return 'Failed';
  return kind === 'ad_copy' ? 'Pending submission' : 'Pending upload';
}

function formatStatus(status: string) {
  if (status in STATUS_LABELS) return STATUS_LABELS[status as keyof typeof STATUS_LABELS];
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatSource(source: Finding['source']) {
  return SOURCE_LABELS[source] ?? formatStatus(source);
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDateTime(value?: number | null) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
});
const progressRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reviews/$jobId',
  component: ProgressPage,
});
const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reviews/$jobId/report',
  component: ReportPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    progressRoute,
    reportRoute,
    settingsRoute,
  ]),
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  </QueryClientProvider>
);
