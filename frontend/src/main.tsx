import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
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
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  FileImage,
  FileJson,
  HardDrive,
  History,
  Laptop,
  LayoutDashboard,
  LoaderCircle,
  Moon,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Trash2,
  Upload,
  Plus,
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
import { cn } from '@/lib/utils';
import { DashboardPage } from '@/components/dashboard';
import { DriveBrowser } from '@/components/drive-browser';
import { AdminAccessGate } from '@/components/admin-access-gate';
import { OfferSettingsPanel } from '@/components/offer-settings-panel';
import {
  deleteReview,
  createDriveReview,
  createReviewBatch,
  createReview,
  type Finding,
  getBatch,
  getReport,
  getReviewSources,
  getStatus,
  listOfferCatalog,
  listReviewHistoryPage,
  resolveDriveSelection,
  reportBatchUploadFailure,
  type OverallStatus,
  type OfferResult,
  type ResultStatus,
  type ReviewBatch,
  type ReviewHistoryItem,
  type Status,
} from '@/lib/api';

type Theme = 'light' | 'dark';
type CreativeSource = 'drive' | 'computer';
type UploadPhase = 'pending' | 'uploading' | 'importing' | 'queued' | 'failed';

type BatchItem = {
  id: string;
  fileName: string;
  kind: 'creative' | 'ad_copy';
  size: number;
  uploadProgress: number;
  phase: UploadPhase;
  batchId?: string;
  mediaKind: 'video' | 'image' | 'copy_only';
  driveFileId?: string;
  jobId?: string;
  error?: string;
};

const queryClient = new QueryClient();
const ACTIVE_BATCH_KEY = 'vibe-check-active-batch-v2';
const OPENROUTER_MODEL_KEY = 'vibe-check-openrouter-model';
const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';
const AD_COPY_PREVIEW_LENGTH = 56;
const UPLOAD_CONCURRENCY = 4;
const MAX_BATCH_ITEMS = 100;
const MAX_OFFERS_PER_REVIEW = 10;
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
  green: 'Green',
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
};
const RESULT_META: Record<OverallStatus, {
  description: string;
  badgeClass: string;
  dotClass: string;
}> = {
  green: {
    description: 'Ready to run — no policy issue identified.',
    badgeClass: 'border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300',
    dotClass: 'bg-emerald-500',
  },
  yellow: {
    description: 'Minor fixes — low-risk edits are recommended.',
    badgeClass: 'border-yellow-600/30 bg-yellow-400/20 text-yellow-800 dark:border-yellow-400/30 dark:bg-yellow-400/15 dark:text-yellow-200',
    dotClass: 'bg-yellow-400',
  },
  orange: {
    description: 'Review required — resolve meaningful risk or uncertainty before publishing.',
    badgeClass: 'border-orange-600/30 bg-orange-500/15 text-orange-700 dark:border-orange-400/30 dark:bg-orange-400/15 dark:text-orange-300',
    dotClass: 'bg-orange-500',
  },
  red: {
    description: 'Do not publish — a likely violation needs material changes.',
    badgeClass: 'border-red-600/30 bg-red-500/15 text-red-700 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-300',
    dotClass: 'bg-red-500',
  },
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
        id: typeof item.id === 'string' && item.id ? item.id : item.jobId,
        batchId: typeof item.batchId === 'string' ? item.batchId : undefined,
        fileName: typeof item.fileName === 'string' && item.fileName ? item.fileName : item.jobId,
        kind,
        mediaKind: item.mediaKind === 'video' || item.mediaKind === 'image'
          ? item.mediaKind
          : kind === 'ad_copy' ? 'copy_only' : 'video',
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
    <div className="min-h-screen bg-background text-foreground md:flex">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar p-4 md:flex">
        <Link to="/" className="mb-7 flex items-center gap-2 px-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card shadow-sm">
            <FileImage className="size-4" />
          </span>
          <span className="font-heading text-base font-semibold">Vibe Check</span>
        </Link>
        <nav className="grid gap-1" aria-label="Primary navigation">
          <ShellLink to="/" label="Dashboard" icon={<LayoutDashboard />} />
          <ShellLink to="/reviews/new" label="New review" icon={<Plus />} />
          <ShellLink to="/history" label="History" icon={<History />} />
          <ShellLink to="/settings" label="Settings" icon={<Settings />} />
        </nav>
        <div className="mt-auto grid gap-3">
          <div className="rounded-lg border bg-card/60 p-3 text-xs leading-5 text-muted-foreground">
            Official policy results stay separate from offer-scoped internal overrides.
          </div>
          <Button
            type="button"
            variant="ghost"
            className="justify-start"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun /> : <Moon />}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b bg-background/90 px-4 py-3 backdrop-blur md:hidden">
          <div className="flex items-center justify-between gap-3">
            <Link to="/" className="flex items-center gap-2 font-heading font-semibold">
              <span className="grid size-8 place-items-center rounded-lg border bg-card">
                <FileImage className="size-4" />
              </span>
              Vibe Check
            </Link>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun /> : <Moon />}
            </Button>
          </div>
          <nav className="mt-3 grid grid-cols-4 gap-1" aria-label="Primary navigation">
            <ShellLink compact to="/" label="Dashboard" icon={<LayoutDashboard />} />
            <ShellLink compact to="/reviews/new" label="Review" icon={<Plus />} />
            <ShellLink compact to="/history" label="History" icon={<History />} />
            <ShellLink compact to="/settings" label="Settings" icon={<Settings />} />
          </nav>
        </header>
        <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ShellLink({
  compact = false,
  icon,
  label,
  to,
}: {
  compact?: boolean;
  icon: React.ReactNode;
  label: string;
  to: '/' | '/reviews/new' | '/history' | '/settings';
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === '/' }}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&_svg]:size-4',
        compact && 'flex-col gap-1 px-1 py-1.5 text-[11px]'
      )}
      activeProps={{
        className: cn(
          'bg-sidebar-accent text-sidebar-accent-foreground',
          compact && 'flex-col gap-1 px-1 py-1.5 text-[11px]'
        ),
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

const rootRoute = createRootRoute({ component: AppShell });

function ReviewWorkspace() {
  const [sceneDetection, setSceneDetection] = useState(false);
  const [creativeSource, setCreativeSource] = useState<CreativeSource>('drive');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedDriveFolderIds, setSelectedDriveFolderIds] = useState<Set<string>>(new Set());
  const [selectedDriveFileIds, setSelectedDriveFileIds] = useState<Set<string>>(new Set());
  const [selectedOfferIds, setSelectedOfferIds] = useState<Set<string>>(new Set(['acp']));
  const offerSelectionInitialized = React.useRef(false);
  const [adCopyText, setAdCopyText] = useState('');
  const [batchItems, setBatchItems] = useState<BatchItem[]>(loadActiveBatch);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const adCopyLines = useMemo(() => splitAdCopyLines(adCopyText), [adCopyText]);

  const selectedFolderList = useMemo(
    () => Array.from(selectedDriveFolderIds).sort(),
    [selectedDriveFolderIds]
  );
  const selectedFileList = useMemo(
    () => Array.from(selectedDriveFileIds).sort(),
    [selectedDriveFileIds]
  );
  const driveSelectionQuery = useQuery({
    queryKey: ['drive', 'selection', selectedFolderList, selectedFileList],
    queryFn: () => resolveDriveSelection(selectedFolderList, selectedFileList),
    enabled:
      creativeSource === 'drive' &&
      (selectedFolderList.length > 0 || selectedFileList.length > 0),
    staleTime: 60_000,
  });
  const offersQuery = useQuery({
    queryKey: ['offers'],
    queryFn: listOfferCatalog,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (offerSelectionInitialized.current || !offersQuery.data) return;
    const enabledOffers = offersQuery.data.filter((offer) => offer.enabled);
    const defaultOffer = enabledOffers.find((offer) => offer.is_default)
      ?? enabledOffers.find((offer) => offer.offer_id === 'acp')
      ?? enabledOffers[0];
    if (defaultOffer) setSelectedOfferIds(new Set([defaultOffer.offer_id]));
    offerSelectionInitialized.current = true;
  }, [offersQuery.data]);

  const selectedDriveFiles = driveSelectionQuery.data?.files ?? [];
  const creativeCount = creativeSource === 'drive' ? selectedDriveFiles.length : selectedFiles.length;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const persisted = batchItems.filter((item) => item.jobId);
    if (persisted.length) {
      window.localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify(persisted));
      return;
    }
    window.localStorage.removeItem(ACTIVE_BATCH_KEY);
  }, [batchItems]);

  const submittedItems = batchItems.filter(
    (item): item is BatchItem & { jobId: string } => Boolean(item.jobId)
  );
  const statusQueries = useQueries({
    queries: submittedItems.map((item) => ({
      queryKey: ['status', item.jobId],
      queryFn: () => getStatus(item.jobId),
      refetchInterval: (query: { state: { data?: Status } }) => {
        const status = query.state.data;
        return status?.report_ready || status?.status === 'failed' ? false : 1500;
      },
    })),
  });

  const queryByItemId = new Map(
    submittedItems.map((item, index) => [item.id, statusQueries[index]] as const)
  );
  const rows = batchItems.map((item) => {
    const query = queryByItemId.get(item.id);
    return {
      item,
      status: query?.data,
      queryError: query?.error,
      retry: query?.refetch,
    };
  });

  const overallProgress = useMemo(() => {
    if (!rows.length) return 0;
    const total = rows.reduce((sum, row) => sum + progressFor(row.item, row.status), 0);
    return Math.round(total / rows.length);
  }, [rows]);
  const failedCount = rows.filter(
    ({ item, status }) => Boolean(item.error) || status?.status === 'failed'
  ).length;
  const completeCount = rows.filter(({ status }) => status?.report_ready).length;
  const pendingCount = rows.length - completeCount - failedCount;
  const activeBatchId = batchItems.find((item) => item.batchId)?.batchId;

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
    const files = creativeSource === 'computer' ? Array.from(fileInput?.files ?? []) : [];
    const driveFiles = creativeSource === 'drive' ? selectedDriveFiles : [];
    const creatives = creativeSource === 'drive' ? driveFiles : files;
    const copyOnly = creatives.length === 0;

    if (
      creativeSource === 'drive' &&
      (selectedDriveFolderIds.size || selectedDriveFileIds.size) &&
      driveSelectionQuery.isFetching
    ) {
      setSubmitError('The selected Drive folders are still being resolved. Try again in a moment.');
      return;
    }
    if (creativeSource === 'drive' && driveSelectionQuery.error) {
      setSubmitError(errorMessage(driveSelectionQuery.error));
      return;
    }
    if (!selectedOfferIds.size) {
      setSubmitError('Select at least one offer to review against.');
      return;
    }
    if (selectedOfferIds.size > MAX_OFFERS_PER_REVIEW) {
      setSubmitError(`Select no more than ${MAX_OFFERS_PER_REVIEW} offers per review.`);
      return;
    }

    if (!creatives.length && !adCopyLines.length) {
      setSubmitError('Choose at least one creative or enter ad copy to review.');
      return;
    }
    if ((copyOnly ? adCopyLines.length : creatives.length) > MAX_BATCH_ITEMS) {
      setSubmitError(`Select no more than ${MAX_BATCH_ITEMS} creatives or copy lines per batch.`);
      return;
    }

    const sharedFields = new FormData(form);
    sharedFields.set('model', loadOpenRouterModel());
    sharedFields.set('offer_ids', JSON.stringify(Array.from(selectedOfferIds)));
    const batchId = (copyOnly ? adCopyLines.length : creatives.length) > 1 ? randomId() : undefined;
    const nextItems: BatchItem[] = copyOnly
      ? adCopyLines.map((copy, index) => ({
          id: randomId(),
          batchId,
          fileName: adCopyItemName(copy, index),
          kind: 'ad_copy' as const,
          mediaKind: 'copy_only' as const,
          size: new Blob([copy]).size,
          uploadProgress: 0,
          phase: 'pending' as const,
        }))
      : creatives.map((file) => ({
          id: randomId(),
          batchId,
          fileName: file.name,
          kind: 'creative' as const,
          mediaKind: ('mime_type' in file ? file.mime_type : file.type).startsWith('video/') || file.name.toLowerCase().endsWith('.mp4')
            ? 'video' as const
            : 'image' as const,
          size: file.size ?? 0,
          uploadProgress: 0,
          phase: 'pending' as const,
          driveFileId: 'file_id' in file ? file.file_id : undefined,
        }));

    setBatchItems(nextItems);
    setIsSubmitting(true);

    try {
      if (batchId) {
        await createReviewBatch({
          batch_id: batchId,
          items: nextItems.map((item) => ({
            item_id: item.id,
            file_name: item.fileName,
            media_kind: item.mediaKind,
          })),
        });
      }
      await runWithConcurrency(nextItems, UPLOAD_CONCURRENCY, async (item, index) => {
        const copyLine = copyOnly ? adCopyLines[index] : undefined;
        const file = copyOnly ? null : files[index] ?? null;
        const driveFile = item.driveFileId
          ? driveFiles.find((candidate) => candidate.file_id === item.driveFileId)
          : undefined;
        updateBatchItem(item.id, { phase: driveFile ? 'importing' : 'uploading' });

        try {
          const status = driveFile
            ? await createDriveReview(buildDriveReviewInput(
                sharedFields,
                driveFile.file_id,
                sceneDetection,
                batchId,
                item.id
              ))
            : await createReview(
                buildReviewForm(
                  sharedFields,
                  file,
                  sceneDetection,
                  copyLine,
                  batchId,
                  item.id
                ),
                (progress) => updateBatchItem(item.id, { uploadProgress: progress })
              );
          updateBatchItem(item.id, {
            jobId: status.job_id,
            phase: 'queued',
            uploadProgress: 100,
          });
          queryClient.setQueryData(['status', status.job_id], status);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateBatchItem(item.id, {
            phase: 'failed',
            error: message,
            uploadProgress: 100,
          });
          if (batchId) {
            try {
              await reportBatchUploadFailure(batchId, item.id, message);
            } catch (batchError) {
              setSubmitError(
                `A failed upload could not be recorded in the batch: ${errorMessage(batchError)}`
              );
            }
          }
        }
      });
    } catch (error) {
      const message = errorMessage(error);
      setSubmitError(message);
      setBatchItems((current) => current.map((item) => ({
        ...item,
        error: message,
        phase: 'failed',
        uploadProgress: 100,
      })));
    } finally {
      setIsSubmitting(false);
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
        <Card>
        <CardHeader>
          <CardTitle as="h1" className="text-xl">New review</CardTitle>
          <CardDescription>
            Select creatives from Google Drive, upload from your computer, or review copy by itself.
          </CardDescription>
          <CardAction>
            <Badge variant="outline">
              {selectionBadgeLabel(creativeCount, adCopyLines.length)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-5">
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3">
                <Label>Offers to evaluate</Label>
                <Badge variant="outline">
                  {selectedOfferIds.size} / {MAX_OFFERS_PER_REVIEW} selected
                </Badge>
              </div>
              {offersQuery.isLoading ? (
                <Skeleton className="h-16" />
              ) : offersQuery.error ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Offers unavailable</AlertTitle>
                  <AlertDescription>{errorMessage(offersQuery.error)}</AlertDescription>
                </Alert>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {(offersQuery.data ?? []).filter((offer) => offer.enabled).map((offer) => {
                    const selected = selectedOfferIds.has(offer.offer_id);
                    const atOfferLimit = !selected && selectedOfferIds.size >= MAX_OFFERS_PER_REVIEW;
                    return (
                      <button
                        key={offer.offer_id}
                        type="button"
                        aria-pressed={selected}
                        disabled={atOfferLimit}
                        title={atOfferLimit ? `A review can include up to ${MAX_OFFERS_PER_REVIEW} offers.` : undefined}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border bg-background p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                          selected && 'border-primary/50 bg-primary/5'
                        )}
                        onClick={() => setSelectedOfferIds((current) => {
                          const next = new Set(current);
                          if (next.has(offer.offer_id)) {
                            if (next.size > 1) next.delete(offer.offer_id);
                          } else if (next.size < MAX_OFFERS_PER_REVIEW) {
                            next.add(offer.offer_id);
                          }
                          return next;
                        })}
                      >
                        <span className={cn(
                          'grid size-5 shrink-0 place-items-center rounded border',
                          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                        )}>
                          {selected ? <Check className="size-3.5" /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{offer.display_name}</span>
                          <span className="block text-xs text-muted-foreground">
                            Guidelines v{offer.version} · {offer.override_count} overrides
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-xs leading-5 text-muted-foreground">
                Evidence is extracted once, then evaluated independently for up to {MAX_OFFERS_PER_REVIEW} selected offers.
              </p>
            </div>

            <div className="grid gap-3">
              <Label>Ad creatives</Label>
              <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/40 p-1" role="group" aria-label="Creative source">
                <Button
                  type="button"
                  variant={creativeSource === 'drive' ? 'secondary' : 'ghost'}
                  aria-pressed={creativeSource === 'drive'}
                  onClick={() => {
                    setCreativeSource('drive');
                    setSelectedFiles([]);
                  }}
                >
                  <HardDrive />
                  Google Drive
                </Button>
                <Button
                  type="button"
                  variant={creativeSource === 'computer' ? 'secondary' : 'ghost'}
                  aria-pressed={creativeSource === 'computer'}
                  onClick={() => {
                    setCreativeSource('computer');
                    setSelectedDriveFolderIds(new Set());
                    setSelectedDriveFileIds(new Set());
                  }}
                >
                  <Laptop />
                  This computer
                </Button>
              </div>

              {creativeSource === 'drive' ? (
                <div>
                  <DriveBrowser
                    selectedFolderIds={selectedDriveFolderIds}
                    selectedFileIds={selectedDriveFileIds}
                    onSelectionChange={(folders, files) => {
                      setSelectedDriveFolderIds(folders);
                      setSelectedDriveFileIds(files);
                    }}
                  />
                  {(selectedDriveFolderIds.size || selectedDriveFileIds.size) ? (
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                      {driveSelectionQuery.isFetching ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                      {driveSelectionQuery.isFetching
                        ? 'Resolving selected folders…'
                        : driveSelectionQuery.error
                          ? errorMessage(driveSelectionQuery.error)
                          : `${selectedDriveFiles.length} deduplicated creative${selectedDriveFiles.length === 1 ? '' : 's'} ready`}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="grid gap-2">
                  <Input
                    id="creative"
                    multiple
                    name="creative"
                    type="file"
                    accept="video/mp4,image/jpeg,image/png,image/webp"
                    aria-describedby="creative-help"
                    className="h-auto min-h-20 cursor-pointer border-dashed py-5 file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-2 hover:file:bg-accent"
                    onChange={(event) => setSelectedFiles(Array.from(event.currentTarget.files ?? []))}
                  />
                  <p id="creative-help" className="text-xs leading-5 text-muted-foreground">
                    MP4, JPG, PNG, or WebP · up to 200 MB each · batches start four at a time
                  </p>
                </div>
              )}
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
                  Policy, transcript, notes, and sampling
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
                  <div className="hidden md:block" aria-hidden="true" />
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
                <AlertTitle>Review blocked</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {submissionHint(creativeCount, adCopyLines.length)}
              </p>
              <Button type="submit" disabled={isSubmitting}>
                <Upload data-icon="inline-start" />
                {isSubmitting
                  ? 'Starting reviews…'
                  : createButtonLabel(creativeCount || adCopyLines.length)}
              </Button>
            </div>
          </form>
        </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Batch progress</CardTitle>
            <CardDescription>
              Four jobs can start at once; Drive imports and local uploads advance automatically.
            </CardDescription>
            <CardAction>
              <div className="flex items-center gap-2">
                {activeBatchId ? (
                  <Link
                    to="/batches/$batchId"
                    params={{ batchId: activeBatchId }}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    Batch results
                  </Link>
                ) : null}
                {rows.length ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isSubmitting}
                    onClick={() => setBatchItems([])}
                  >
                    Clear
                  </Button>
                ) : null}
                {rows.length ? (
                  <Badge
                    variant={
                      failedCount ? 'destructive' : overallProgress === 100
                        ? 'secondary'
                        : 'outline'
                    }
                  >
                    {failedCount
                      ? `${failedCount} failed`
                      : overallProgress === 100
                        ? 'Complete'
                        : `${overallProgress}%`}
                  </Badge>
                ) : (
                  <Badge variant="outline">4 at a time</Badge>
                )}
              </div>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-4">
            {rows.length ? (
              <>
                <Progress value={overallProgress}>
                  <ProgressLabel>
                    {completeCount} complete · {pendingCount} in progress
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
                <div className="grid max-h-[38rem] gap-3 overflow-y-auto pr-1">
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
              </>
            ) : (
              <EmptyBatchState />
            )}
          </CardContent>
        </Card>
      </div>

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
          Start a review to watch up to four jobs process side by side.
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
  allHistory = false,
  error,
  hasMore = false,
  isFetchingMore = false,
  isLoading,
  onLoadMore,
  onRetry,
  reviews,
}: {
  allHistory?: boolean;
  error: Error | null;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  isLoading: boolean;
  onLoadMore?: () => void;
  onRetry: () => void;
  reviews: ReviewHistoryItem[];
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const deleteMutation = useMutation({
    mutationFn: deleteReview,
    onSuccess: (deleted) => {
      setDeleteCandidate(null);
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      queryClient.removeQueries({ queryKey: ['status', deleted.job_id] });
      queryClient.removeQueries({ queryKey: ['report', deleted.job_id] });
      queryClient.removeQueries({ queryKey: ['source', deleted.job_id] });
      try {
        const active = loadActiveBatch().filter((item) => item.jobId !== deleted.job_id);
        if (active.length) window.localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify(active));
        else window.localStorage.removeItem(ACTIVE_BATCH_KEY);
      } catch {
        // History removal still succeeded if local progress cleanup is unavailable.
      }
    },
  });
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredReviews = useMemo(() => {
    if (!normalizedSearch) return reviews;

    return reviews.filter((review) =>
      [
        review.file_name,
        review.job_id,
        review.status,
        formatStatus(review.status),
        review.overall_status,
        review.overall_status ? formatStatus(review.overall_status) : null,
        review.creative_result,
        review.creative_result ? formatStatus(review.creative_result) : null,
        review.ad_copy_result,
        review.ad_copy_result ? formatStatus(review.ad_copy_result) : null,
        ...(review.offer_ids ?? []),
        formatDateTime(review.created_at),
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch))
    );
  }, [normalizedSearch, reviews]);
  const isSearching = normalizedSearch.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle as={allHistory ? 'h1' : 'h2'} className="text-xl">
          {allHistory ? 'All review history' : 'Review history'}
        </CardTitle>
        <CardDescription>
          {allHistory
            ? 'Browse every saved review, loading older records as needed.'
            : 'Your 50 most recent reviews, with split creative and copy results.'}
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              {isSearching
                ? `${filteredReviews.length} of ${reviews.length}`
                : allHistory
                  ? `${reviews.length}${hasMore ? '+' : ''} loaded`
                  : `${reviews.length} recent`}
            </Badge>
            {!allHistory ? (
              <Link
                to="/history"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                View all
              </Link>
            ) : null}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        {deleteMutation.error ? (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle />
            <AlertTitle>Could not remove review</AlertTitle>
            <AlertDescription>
              {errorMessage(deleteMutation.error)}{' '}
              <Link to="/settings" className="font-medium underline underline-offset-4">
                Unlock admin access in Settings.
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}
        {deleteCandidate ? (
          <Alert className="mb-4">
            <Trash2 />
            <AlertTitle>Remove this review from Vibe Check?</AlertTitle>
            <AlertDescription>
              It will disappear from history and dashboard stats. The original Google Drive file or uploaded source is not deleted.
            </AlertDescription>
          </Alert>
        ) : null}
        {!error && !isLoading && reviews.length ? (
          <div className="mb-4 flex items-center gap-2">
            <div className="relative w-full max-w-md">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search reviews"
                aria-label="Search review history"
                className="pl-8"
              />
            </div>
            {isSearching ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSearchQuery('')}
              >
                Clear
              </Button>
            ) : null}
          </div>
        ) : null}
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
        ) : filteredReviews.length ? (
          <div className={cn('overflow-auto', !allHistory && 'max-h-[42rem]')}>
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>Review</TableHead>
                  <TableHead>Offers</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Creative Result</TableHead>
                  <TableHead>Ad Copy Result</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredReviews.map((review) => (
                  <TableRow key={review.job_id}>
                    <TableCell className="min-w-48 max-w-80">
                      <span className="block truncate font-medium">
                        {review.file_name || review.job_id}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-max items-center gap-1">
                        <Badge variant="outline">
                          {(review.primary_offer_id ?? review.offer_ids?.[0] ?? 'acp').toUpperCase()}
                        </Badge>
                        {(review.offer_ids?.length ?? 0) > 1 ? (
                          <span className="text-xs text-muted-foreground">
                            +{(review.offer_ids?.length ?? 1) - 1}
                          </span>
                        ) : null}
                      </div>
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
                      <div className="flex min-w-max justify-end gap-1">
                        {deleteCandidate === review.job_id ? (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={deleteMutation.isPending}
                              onClick={() => setDeleteCandidate(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              disabled={deleteMutation.isPending}
                              onClick={() => deleteMutation.mutate(review.job_id)}
                            >
                              {deleteMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                              Remove
                            </Button>
                          </>
                        ) : (
                          <>
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
                            {allHistory && (review.report_ready || review.status === 'failed') ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remove ${review.file_name || review.job_id} from history`}
                                title="Remove from history and dashboard stats"
                                onClick={() => setDeleteCandidate(review.job_id)}
                              >
                                <Trash2 />
                              </Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : reviews.length ? (
          <div className="grid min-h-36 place-items-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
            <div className="grid max-w-sm gap-1">
              <p className="text-sm font-medium">No matching reviews</p>
              <p className="text-sm text-muted-foreground">
                Try a creative name, job ID, status, result, or upload date.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid min-h-36 place-items-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              Completed and in-progress reviews will appear here after the first upload.
            </p>
          </div>
        )}
        {allHistory && hasMore && !error ? (
          <div className="mt-4 flex justify-center border-t pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onLoadMore}
              disabled={isFetchingMore}
            >
              {isFetchingMore ? <LoaderCircle className="animate-spin" /> : null}
              {isFetchingMore ? 'Loading older reviews' : 'Load older reviews'}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AllHistoryPage() {
  const query = useInfiniteQuery({
    queryKey: ['reviews', 'all-history'],
    queryFn: ({ pageParam }) => listReviewHistoryPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.has_more ? lastPage.next_cursor : undefined,
  });
  const reviews = query.data?.pages.flatMap((page) => page.reviews) ?? [];

  return (
    <HistoryCard
      allHistory
      error={query.error}
      hasMore={query.hasNextPage}
      isFetchingMore={query.isFetchingNextPage}
      isLoading={query.isLoading}
      onLoadMore={() => void query.fetchNextPage()}
      onRetry={() => void query.refetch()}
      reviews={reviews}
    />
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
  const [selectedOfferId, setSelectedOfferId] = useState('');
  const query = useQuery({ queryKey: ['report', jobId], queryFn: () => getReport(jobId) });
  const sourceQuery = useQuery({
    queryKey: ['source', jobId],
    queryFn: () => getReviewSources(jobId),
    enabled: Boolean(query.data),
  });
  const offerResults: OfferResult[] = query.data
    ? query.data.offer_results?.length
      ? query.data.offer_results
      : [query.data]
    : [];
  const activeOffer = offerResults.find((result) => result.offer_id === selectedOfferId)
    ?? offerResults[0];
  const column = createColumnHelper<Finding>();
  const table = useReactTable({
    data: activeOffer?.findings ?? [],
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
      column.accessor('internal_override', {
        header: 'Internal treatment',
        cell: (info) => {
          const override = info.getValue();
          return override ? (
            <div className="grid min-w-48 gap-1">
              <Badge variant="secondary" className="w-fit">
                {formatStatus(override.disposition)}
              </Badge>
              <span className="text-xs font-medium">{override.title || override.override_id}</span>
              {override.rationale ? (
                <span className="text-xs text-muted-foreground">{override.rationale}</span>
              ) : null}
            </div>
          ) : <span className="text-sm text-muted-foreground">No override</span>;
        },
      }),
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

  if (!activeOffer) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Offer results unavailable</AlertTitle>
        <AlertDescription>This report does not contain a readable offer result.</AlertDescription>
      </Alert>
    );
  }

  const sourceResults = [
    { label: 'Creative', result: activeOffer.source_results?.creative },
    { label: 'Ad copy', result: activeOffer.source_results?.ad_copy },
  ].filter((item): item is {
    label: string;
    result: NonNullable<typeof item.result>;
  } => Boolean(item.result));
  const linkedSources = sourceQuery.data?.sources.filter(
    (source) => source.status === 'linked' && source.url
  ) ?? [];
  const unresolvedSources = sourceQuery.data?.sources.filter(
    (source) => source.status !== 'linked'
  ) ?? [];

  return (
    <div className="grid gap-4">
      {offerResults.length > 1 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Offer result selection">
          {offerResults.map((result) => (
            <Button
              key={result.offer_id}
              type="button"
              size="sm"
              variant={result.offer_id === activeOffer.offer_id ? 'default' : 'outline'}
              aria-pressed={result.offer_id === activeOffer.offer_id}
              onClick={() => setSelectedOfferId(result.offer_id)}
            >
              {result.offer_name}
              <StatusBadge status={result.overall_status} />
            </Button>
          ))}
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle as="h1" className="text-xl">{activeOffer.offer_name} review summary</CardTitle>
          <CardDescription>
            Review job {jobId}{activeOffer.guideline_version ? ` · guidelines v${activeOffer.guideline_version}` : ''}
          </CardDescription>
          <CardAction>
            <div className="flex flex-wrap justify-end gap-2">
              <StatusBadge status={activeOffer.overall_status} />
              <InternalDispositionBadge disposition={activeOffer.internal_disposition} />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="max-w-4xl text-sm leading-6 text-muted-foreground">
            {activeOffer.summary}
          </p>
          <p className="text-sm font-medium">
            {resultDescription(activeOffer.overall_status)}
          </p>
          {activeOffer.internal_disposition === 'accepted_with_override' ? (
            <Alert>
              <CheckCircle2 />
              <AlertTitle>Accepted internally for {activeOffer.offer_name}</AlertTitle>
              <AlertDescription>
                The official guideline finding remains in this report. Every accepted exception is identified in the Internal treatment column below.
              </AlertDescription>
            </Alert>
          ) : null}
          {sourceResults.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {sourceResults.map(({ label, result }) => (
                <div key={label} className="grid gap-2 rounded-lg border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{label}</span>
                    <StatusBadge status={result.status} />
                  </div>
                  {result.summary ? (
                    <p className="text-sm leading-6 text-muted-foreground">{result.summary}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <a
              className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
              href={`/api/reviews/${jobId}/report.json`}
            >
              <Download data-icon="inline-start" />
              Download JSON
            </a>
            {linkedSources.map((source) => (
              <a
                key={`${source.kind}-${source.url}`}
                className={cn(buttonVariants({ variant: 'default' }), 'w-fit')}
                href={source.url ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink data-icon="inline-start" />
                {source.label}
              </a>
            ))}
            {sourceQuery.isLoading ? <Badge variant="outline">Locating source…</Badge> : null}
          </div>
          {unresolvedSources.length || sourceQuery.error ? (
            <div className="flex flex-col items-start gap-2 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="grid gap-1 text-sm text-muted-foreground">
                {unresolvedSources.map((source) => (
                  <p key={`${source.label}-${source.status}`}>{source.message}</p>
                ))}
                {sourceQuery.error ? <p>{errorMessage(sourceQuery.error)}</p> : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={sourceQuery.isFetching}
                onClick={() => void sourceQuery.refetch()}
              >
                <RefreshCw />
                Retry
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Findings</CardTitle>
          <CardDescription>{activeOffer.findings.length} official-policy findings returned</CardDescription>
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
            <p>{activeOffer.safe_rewrite.ad_copy || 'No copy rewrite returned.'}</p>
            {activeOffer.safe_rewrite.onscreen_text.length ? (
              <ul className="grid list-disc gap-2 pl-5">
                {activeOffer.safe_rewrite.onscreen_text.map((text, index) => (
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
              {activeOffer.limitations.map((limitation, index) => (
                <li key={`${limitation}-${index}`}>{limitation}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function BatchPage() {
  const { batchId } = useParams({ from: '/batches/$batchId' });
  const query = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => getBatch(batchId),
    refetchInterval: (current: { state: { data?: ReviewBatch } }) => {
      const batch = current.state.data;
      return batch?.items.every((item) => isTerminalBatchStatus(item.status)) ? false : 1500;
    },
  });

  if (query.isLoading) return <Skeleton className="h-72" />;
  if (!query.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Batch unavailable</AlertTitle>
        <AlertDescription>
          {query.error ? errorMessage(query.error) : 'Batch not found.'}
        </AlertDescription>
      </Alert>
    );
  }

  const completeCount = query.data.items.filter((item) => item.status === 'complete').length;
  const failedCount = query.data.items.filter((item) => isFailedBatchStatus(item.status)).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1" className="text-xl">
          Batch uploaded {formatDate(query.data.created_at)}
        </CardTitle>
        <CardDescription>
          {completeCount} complete · {failedCount} failed · {query.data.expected_count} total
        </CardDescription>
        <CardAction>
          <Link to="/reviews/new" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Back to workspace
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Report</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((item) => (
                <TableRow key={item.item_id}>
                  <TableCell className="whitespace-nowrap">{batchTypeLabel(item.media_kind)}</TableCell>
                  <TableCell className="min-w-64 max-w-md">
                    <span className="block truncate font-medium">{item.file_name}</span>
                    {isFailedBatchStatus(item.status) && item.message ? (
                      <span className="block text-xs text-destructive">{item.message}</span>
                    ) : null}
                  </TableCell>
                  <TableCell><StatusBadge status={item.status} /></TableCell>
                  <TableCell>
                    {item.result ? <StatusBadge status={item.result} /> : (
                      <span className="text-sm text-muted-foreground">
                        {isFailedBatchStatus(item.status) ? 'No result' : 'Not ready'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.status === 'complete' && item.job_id ? (
                      <Link
                        to="/reviews/$jobId/report"
                        params={{ jobId: item.job_id }}
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      >
                        <FileJson data-icon="inline-start" />
                        Open report
                      </Link>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function SettingsPage() {
  const [model, setModel] = useState(loadOpenRouterModel);
  const [saved, setSaved] = useState(false);

  function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextModel = model.trim() || DEFAULT_OPENROUTER_MODEL;
    window.localStorage.setItem(OPENROUTER_MODEL_KEY, nextModel);
    setModel(nextModel);
    setSaved(true);
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-4">
      <section className="grid gap-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Manage offer-specific official guidelines, internal overrides, and review runtime defaults.
        </p>
      </section>
      <AdminAccessGate>
        <OfferSettingsPanel />
      </AdminAccessGate>
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Runtime configuration</CardTitle>
          <CardDescription>Model selection for reviews started from this browser.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 text-sm leading-6 text-muted-foreground">
          <form className="grid gap-3" onSubmit={saveSettings}>
            <FormField label="OpenRouter model" htmlFor="settings-model">
              <Input
                id="settings-model"
                value={model}
                placeholder={DEFAULT_OPENROUTER_MODEL}
                onChange={(event) => {
                  setModel(event.currentTarget.value);
                  setSaved(false);
                }}
              />
            </FormField>
            <div className="flex items-center gap-3">
              <Button type="submit">Save model</Button>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {saved ? 'Saved for future reviews on this browser.' : 'Used for every new review.'}
              </span>
            </div>
          </form>
          <Separator />
          <p>
            Configure OPENROUTER_API_KEY and CONVEX_HTTP_SECRET as Cloudflare Worker
            secrets. The Convex URL is non-secret Worker config, and creatives stay in
            temporary container storage while Convex saves filename, status, progress,
            and final report JSON.
          </p>
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Parallel processing</AlertTitle>
            <AlertDescription>
              Multi-creative uploads create separate jobs. Uploads and backend reviews run
              four at a time by default, with per-job progress reported back to the UI.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const result = normalizeResultStatus(status);
  if (result) return <ResultBadge status={result} />;
  if (isFailedBatchStatus(status)) {
    return <Badge variant="destructive">{formatStatus(status)}</Badge>;
  }
  if (status === 'complete') {
    return <Badge variant="secondary">{formatStatus(status)}</Badge>;
  }
  return <Badge variant="outline">{formatStatus(status)}</Badge>;
}

function ResultBadge({ status }: { status: OverallStatus }) {
  const meta = RESULT_META[status];
  return (
    <Badge
      variant="outline"
      className={meta.badgeClass}
      title={meta.description}
      aria-label={`${formatStatus(status)}: ${meta.description}`}
    >
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', meta.dotClass)} />
      {formatStatus(status)}
    </Badge>
  );
}

function InternalDispositionBadge({
  disposition,
}: {
  disposition?: OfferResult['internal_disposition'];
}) {
  if (!disposition || disposition === 'clear') return null;
  if (disposition === 'accepted_with_override') {
    return (
      <Badge variant="secondary" title="Official findings are accepted under saved internal guidance.">
        <CheckCircle2 />
        Accepted internally
      </Badge>
    );
  }
  if (disposition === 'human_review') return <Badge variant="outline">Internal review needed</Badge>;
  return <Badge variant="destructive">Action required</Badge>;
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
  adCopyOverride?: string,
  batchId?: string,
  batchItemId?: string
) {
  const form = new FormData();
  if (creative) form.append('creative', creative);

  for (const key of [
    'ad_copy',
    'policy_text',
    'notes',
    'manual_transcript',
    'model',
    'offer_ids',
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
  if (batchId && batchItemId) {
    form.append('batch_id', batchId);
    form.append('batch_item_id', batchItemId);
  }
  return form;
}

function buildDriveReviewInput(
  source: FormData,
  fileId: string,
  sceneDetection: boolean,
  batchId?: string,
  batchItemId?: string
) {
  const value = (key: string) => {
    const field = source.get(key);
    return typeof field === 'string' ? field : '';
  };
  const frameInterval = Number(value('frame_interval_seconds'));
  let offerIds = ['acp'];
  try {
    const parsed = JSON.parse(value('offer_ids'));
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      offerIds = parsed;
    }
  } catch {
    // The backend also defaults legacy submissions to ACP.
  }
  return {
    file_id: fileId,
    ad_copy: value('ad_copy'),
    policy_text: value('policy_text'),
    notes: value('notes'),
    manual_transcript: value('manual_transcript'),
    model: value('model'),
    frame_interval_seconds: Number.isFinite(frameInterval) ? frameInterval : 1,
    scene_detection: sceneDetection,
    offer_ids: offerIds,
    ...(batchId && batchItemId ? { batch_id: batchId, batch_item_id: batchItemId } : {}),
  };
}

function loadOpenRouterModel() {
  if (typeof window === 'undefined') return DEFAULT_OPENROUTER_MODEL;
  return window.localStorage.getItem(OPENROUTER_MODEL_KEY)?.trim() || DEFAULT_OPENROUTER_MODEL;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>
) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await task(items[index], index);
      }
    })
  );
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

function createButtonLabel(jobCount: number) {
  if (!jobCount) return 'Create review';
  return `Create ${jobCount} review${jobCount === 1 ? '' : 's'}`;
}

function submissionHint(creativeCount: number, copyLineCount: number) {
  if (creativeCount > 1) return `${creativeCount} creatives will start four at a time.`;
  if (creativeCount === 1) return 'Each creative becomes one review job.';
  if (copyLineCount > 1) return `${copyLineCount} ad copy lines will start four at a time.`;
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
  if (phase === 'importing') return 'Starting Drive import';
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

function normalizeResultStatus(status: string): OverallStatus | null {
  const normalized: Record<ResultStatus, OverallStatus> = {
    green: 'green',
    yellow: 'yellow',
    orange: 'orange',
    red: 'red',
    pass: 'green',
    needs_review: 'orange',
    likely_violation: 'red',
  };
  return normalized[status as ResultStatus] ?? null;
}

function resultDescription(status: string) {
  const result = normalizeResultStatus(status);
  return result ? RESULT_META[result].description : '';
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

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(value));
}

function randomId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function isFailedBatchStatus(status: string) {
  return status === 'failed' || status === 'upload_failed';
}

function isTerminalBatchStatus(status: string) {
  return status === 'complete' || isFailedBatchStatus(status);
}

function batchTypeLabel(mediaKind: 'video' | 'image' | 'copy_only') {
  if (mediaKind === 'video') return 'Creative Vid';
  if (mediaKind === 'image') return 'Creative Image';
  return 'Ad copy';
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});
const newReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reviews/new',
  component: ReviewWorkspace,
});
const progressRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reviews/$jobId',
  component: ProgressPage,
});
const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: AllHistoryPage,
});
const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reviews/$jobId/report',
  component: ReportPage,
});
const batchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/batches/$batchId',
  component: BatchPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    newReviewRoute,
    historyRoute,
    batchRoute,
    progressRoute,
    reportRoute,
    settingsRoute,
  ]),
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
