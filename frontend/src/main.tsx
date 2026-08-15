import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Menu } from '@base-ui/react/menu';
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
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  CheckCircle2,
  Download,
  ExternalLink,
  FileImage,
  FileJson,
  HardDrive,
  History,
  Laptop,
  LayoutDashboard,
  Layers3,
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
  Radio,
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
import { AutomationsPage } from '@/components/automations-page';
import { LiveScansPage } from '@/components/live-scans-page';
import {
  KissterraDashboardPage,
  KissterraReviewDetailPage,
} from '@/components/client-dashboard';
import { CreativeEvidenceImage, CreativeThumbnail } from '@/components/creative-media';
import {
  batchOutcomeForOffer,
  findOfferOutcome,
  getOfferColumns,
  OfferEligibilityGrid,
  OfferOutcomeCell,
  OfferResultsHeader,
  ReviewOfferResultsRail,
  reviewOutcomeForOffer,
  type OfferColumn,
} from '@/components/offer-outcomes';
import {
  deleteReview,
  createDriveReview,
  createReviewBatch,
  createReview,
  type Finding,
  getBatch,
  getBatches,
  getReport,
  getReviewEvidence,
  getReviewSources,
  getStatus,
  listOfferCatalog,
  listReviewHistoryPage,
  resolveDriveSelection,
  reportBatchUploadFailure,
  type OverallStatus,
  type OfferOutcome,
  type OfferResult,
  type ResultStatus,
  type ReviewBatch,
  type ReviewBatchItem,
  type ReviewHistoryItem,
  type ReviewEvidenceFrame,
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
  amber: 'Amber',
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
  amber: {
    description: 'Needs attention — fix or review the routine issue before publishing.',
    badgeClass: 'border-orange-600/30 bg-orange-500/15 text-orange-700 dark:border-orange-400/30 dark:bg-orange-400/15 dark:text-orange-300',
    dotClass: 'bg-orange-500',
  },
  red: {
    description: 'Critical stop — the policy explicitly identifies serious enforcement risk.',
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
          <ShellLink to="/live-scans" label="Live scans" icon={<Radio />} />
          <ShellLink to="/automations" label="Automations" icon={<CalendarClock />} />
          <ShellLink to="/settings" label="Settings" icon={<Settings />} />
        </nav>
        <div className="mt-auto grid gap-3">
          <div className="rounded-lg border bg-card/60 p-3 text-xs leading-5 text-muted-foreground">
            Results reflect effective policy, with approved internal exceptions identified separately.
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
          <nav className="mt-3 grid grid-cols-6 gap-1" aria-label="Primary navigation">
            <ShellLink compact to="/" label="Dashboard" icon={<LayoutDashboard />} />
            <ShellLink compact to="/reviews/new" label="Review" icon={<Plus />} />
            <ShellLink compact to="/history" label="History" icon={<History />} />
            <ShellLink compact to="/live-scans" label="Live" icon={<Radio />} />
            <ShellLink compact to="/automations" label="Automate" icon={<CalendarClock />} />
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
  to: '/' | '/reviews/new' | '/history' | '/live-scans' | '/automations' | '/settings';
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

function isKissterraPortalLocation() {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.startsWith('/kissterra')
    || window.location.hostname.split('.')[0]?.toLowerCase() === 'kissterra';
}

function RootLayout() {
  return isKissterraPortalLocation() ? <Outlet /> : <AppShell />;
}

function HomePage() {
  return isKissterraPortalLocation() ? <KissterraDashboardPage /> : <DashboardPage />;
}

const rootRoute = createRootRoute({ component: RootLayout });

function ReviewWorkspace() {
  const [sceneDetection, setSceneDetection] = useState(false);
  const [creativeSource, setCreativeSource] = useState<CreativeSource>('drive');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedDriveFolders, setSelectedDriveFolders] = useState<Map<string, string>>(new Map());
  const [selectedDriveFileIds, setSelectedDriveFileIds] = useState<Set<string>>(new Set());
  const [adCopyText, setAdCopyText] = useState('');
  const [batchItems, setBatchItems] = useState<BatchItem[]>(loadActiveBatch);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const adCopyLines = useMemo(() => splitAdCopyLines(adCopyText), [adCopyText]);

  const selectedFolderList = useMemo(
    () => Array.from(selectedDriveFolders.keys()).sort(),
    [selectedDriveFolders]
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
  const eligibleOffers = useMemo(
    () => (offersQuery.data ?? []).filter((offer) => offer.enabled && offer.configured),
    [offersQuery.data]
  );

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
      (selectedDriveFolders.size || selectedDriveFileIds.size) &&
      driveSelectionQuery.isFetching
    ) {
      setSubmitError('The selected Drive folders are still being resolved. Try again in a moment.');
      return;
    }
    if (creativeSource === 'drive' && driveSelectionQuery.error) {
      setSubmitError(errorMessage(driveSelectionQuery.error));
      return;
    }
    if (offersQuery.isLoading) {
      setSubmitError('Offer eligibility is still loading. Try again in a moment.');
      return;
    }
    if (offersQuery.error) {
      setSubmitError(`Offer eligibility could not be loaded. ${errorMessage(offersQuery.error)}`);
      return;
    }
    if (!eligibleOffers.length) {
      setSubmitError('Turn on at least one offer with saved guidelines before starting a review.');
      return;
    }
    if (eligibleOffers.length > MAX_OFFERS_PER_REVIEW) {
      setSubmitError(`No more than ${MAX_OFFERS_PER_REVIEW} offers can be active for a review.`);
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
    sharedFields.set('offer_ids', JSON.stringify(eligibleOffers.map((offer) => offer.offer_id)));
    const batchId = (copyOnly ? adCopyLines.length : creatives.length) > 1 ? randomId() : undefined;
    const batchSourceLabel = creativeSource === 'drive' && creatives.length
      ? driveBatchSourceLabel(selectedDriveFolders, selectedDriveFileIds.size)
      : '';
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
          ...(batchSourceLabel ? { source_label: batchSourceLabel } : {}),
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
                <Label>Offer eligibility</Label>
                <Badge variant="outline">
                  {eligibleOffers.length} will review
                </Badge>
              </div>
              {offersQuery.isLoading ? (
                <Skeleton className="h-28" />
              ) : offersQuery.error ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Offers unavailable</AlertTitle>
                  <AlertDescription>{errorMessage(offersQuery.error)}</AlertDescription>
                </Alert>
              ) : (
                <OfferEligibilityGrid offers={offersQuery.data ?? []} />
              )}
              <p className="text-xs leading-5 text-muted-foreground">
                Evidence is extracted once. Every active offer with saved guidelines is evaluated automatically; all others are recorded as N/A.
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
                    setSelectedDriveFolders(new Map());
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
                    selectedFolders={selectedDriveFolders}
                    selectedFileIds={selectedDriveFileIds}
                    onSelectionChange={(folders, files) => {
                      setSelectedDriveFolders(folders);
                      setSelectedDriveFileIds(files);
                    }}
                  />
                  {(selectedDriveFolders.size || selectedDriveFileIds.size) ? (
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
                    MP4, JPG, PNG, or WebP · up to 400 MB each · batches start four at a time
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
              <Button
                type="submit"
                disabled={
                  isSubmitting
                  || offersQuery.isLoading
                  || Boolean(offersQuery.error)
                  || !eligibleOffers.length
                  || eligibleOffers.length > MAX_OFFERS_PER_REVIEW
                }
              >
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

type HistoryResultFilter = 'all' | OverallStatus | 'na';
type HistoryTypeFilter = 'all' | 'creative' | 'copy_only';
type HistoryDeleteRequest = {
  ids: string[];
  label: string;
};
type HistoryEntry =
  | {
      createdAt: number | null;
      entryKey: string;
      kind: 'review';
      review: ReviewHistoryItem;
    }
  | {
      batch?: ReviewBatch;
      batchId: string;
      createdAt: number | null;
      entryKey: string;
      kind: 'batch';
      reviews: ReviewHistoryItem[];
    };

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
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [offerFilter, setOfferFilter] = useState('all');
  const [resultFilter, setResultFilter] = useState<HistoryResultFilter>('all');
  const [typeFilter, setTypeFilter] = useState<HistoryTypeFilter>('all');
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<string>>(new Set());
  const [deleteRequest, setDeleteRequest] = useState<HistoryDeleteRequest | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const offerCatalogQuery = useQuery({
    queryKey: ['offers'],
    queryFn: listOfferCatalog,
    staleTime: 60_000,
  });
  const batchIds = useMemo(
    () => Array.from(new Set(reviews.flatMap((review) => review.batch_id ? [review.batch_id] : []))),
    [reviews]
  );
  const batchesQuery = useQuery({
    queryKey: ['batches', 'history', batchIds],
    queryFn: () => getBatches(batchIds),
    enabled: batchIds.length > 0,
    staleTime: 30_000,
  });
  const historyEntries = useMemo(
    () => buildHistoryEntries(reviews, batchesQuery.data ?? []),
    [batchesQuery.data, reviews]
  );
  const offerColumns = useMemo(
    () => getOfferColumns(
      offerCatalogQuery.data ?? [],
      reviews.map((review) => review.offer_outcomes)
    ),
    [offerCatalogQuery.data, reviews]
  );
  const deleteMutation = useMutation({
    mutationFn: deleteReviewSelection,
    onSuccess: ({ deletedIds, failedIds, firstError }) => {
      setDeleteRequest(null);
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      for (const jobId of deletedIds) {
        queryClient.removeQueries({ queryKey: ['status', jobId] });
        queryClient.removeQueries({ queryKey: ['report', jobId] });
        queryClient.removeQueries({ queryKey: ['source', jobId] });
      }
      setSelectedReviewIds(new Set(failedIds));
      setDeleteError(
        failedIds.length
          ? `${deletedIds.length ? `Removed ${deletedIds.length}. ` : ''}Could not remove ${failedIds.length} selected review${failedIds.length === 1 ? '' : 's'}: ${errorMessage(firstError)}`
          : null
      );
      try {
        const deleted = new Set(deletedIds);
        const active = loadActiveBatch().filter((item) => !item.jobId || !deleted.has(item.jobId));
        if (active.length) window.localStorage.setItem(ACTIVE_BATCH_KEY, JSON.stringify(active));
        else window.localStorage.removeItem(ACTIVE_BATCH_KEY);
      } catch {
        // History removal still succeeded if local progress cleanup is unavailable.
      }
    },
  });
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const filteredEntries = useMemo(() => {
    return historyEntries.filter((entry) => {
      if (normalizedSearch && !historyEntryMatchesSearch(entry, normalizedSearch)) return false;
      if (!historyEntryMatchesTypeFilter(entry, typeFilter)) return false;
      return historyEntryMatchesResultFilter(
        entry,
        offerColumns,
        offerFilter,
        resultFilter
      );
    });
  }, [
    historyEntries,
    normalizedSearch,
    offerColumns,
    offerFilter,
    resultFilter,
    typeFilter,
  ]);
  const filtersActive = Boolean(
    normalizedSearch ||
    offerFilter !== 'all' ||
    resultFilter !== 'all' ||
    typeFilter !== 'all'
  );
  const selectableVisibleIds = Array.from(new Set(
    filteredEntries.flatMap(deletableHistoryEntryIds)
  ));
  const allVisibleSelected = selectableVisibleIds.length > 0 &&
    selectableVisibleIds.every((jobId) => selectedReviewIds.has(jobId));
  const someVisibleSelected = !allVisibleSelected &&
    selectableVisibleIds.some((jobId) => selectedReviewIds.has(jobId));
  const selectedCount = selectedReviewIds.size;

  useEffect(() => {
    setSelectedReviewIds(new Set());
  }, [normalizedSearch, offerFilter, resultFilter, typeFilter]);

  function resetFilters() {
    setSearchQuery('');
    setOfferFilter('all');
    setResultFilter('all');
    setTypeFilter('all');
  }

  function toggleEntrySelection(entry: HistoryEntry) {
    const entryIds = deletableHistoryEntryIds(entry);
    const entrySelected = entryIds.length > 0 &&
      entryIds.every((jobId) => selectedReviewIds.has(jobId));
    setSelectedReviewIds((current) => {
      const next = new Set(current);
      for (const jobId of entryIds) {
        if (entrySelected) next.delete(jobId);
        else next.add(jobId);
      }
      return next;
    });
  }

  function openHistoryEntry(entry: HistoryEntry) {
    if (entry.kind === 'batch') {
      void navigate({ to: '/batches/$batchId', params: { batchId: entry.batchId } });
      return;
    }
    const to = entry.review.report_ready
      ? '/reviews/$jobId/report' as const
      : '/reviews/$jobId' as const;
    void navigate({ to, params: { jobId: entry.review.job_id } });
  }

  function toggleVisibleSelection() {
    setSelectedReviewIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const jobId of selectableVisibleIds) next.delete(jobId);
      } else {
        for (const jobId of selectableVisibleIds) next.add(jobId);
      }
      return next;
    });
  }

  return (
    <>
      <Card size={allHistory ? 'sm' : 'default'}>
        <CardHeader>
          <CardTitle
            as={allHistory ? 'h1' : 'h2'}
            className={cn('text-xl', allHistory && 'group-data-[size=sm]/card:text-lg')}
          >
            {allHistory ? 'All review history' : 'Review history'}
          </CardTitle>
          <CardDescription>
            {allHistory
              ? 'Browse every saved upload. Multi-creative uploads appear as one batch.'
              : 'Recent uploads, with multi-creative batches grouped into one row.'}
          </CardDescription>
          <CardAction>
            <div className="flex items-center gap-2">
              <Badge variant="outline">
                {filtersActive
                  ? `${filteredEntries.length} of ${historyEntries.length}`
                  : allHistory
                    ? `${historyEntries.length}${hasMore ? '+' : ''} loaded`
                    : `${historyEntries.length} recent`}
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
          {deleteError ? (
            <Alert variant="destructive" className="mb-3">
              <AlertCircle />
              <AlertTitle>Could not remove every review</AlertTitle>
              <AlertDescription>
                {deleteError}{' '}
                <Link to="/settings" className="font-medium underline underline-offset-4">
                  Check admin access in Settings.
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
          {!error && !isLoading && reviews.length ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative min-w-56 flex-1 sm:max-w-sm">
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
                <div className="flex flex-wrap items-center gap-2" aria-label="History filters">
                  <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
                  <select
                    value={offerFilter}
                    onChange={(event) => setOfferFilter(event.target.value)}
                    aria-label="Filter by offer"
                    className={historyFilterClassName}
                  >
                    <option value="all">All offers</option>
                    {offerColumns.map((offer) => (
                      <option key={offer.offer_id} value={offer.offer_id}>
                        {offer.offer_name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={resultFilter}
                    onChange={(event) => setResultFilter(event.target.value as HistoryResultFilter)}
                    aria-label="Filter by result"
                    className={historyFilterClassName}
                  >
                    <option value="all">All results</option>
                    <option value="red">Red</option>
                    <option value="amber">Amber</option>
                    <option value="green">Green</option>
                    <option value="na">N/A</option>
                  </select>
                  <select
                    value={typeFilter}
                    onChange={(event) => setTypeFilter(event.target.value as HistoryTypeFilter)}
                    aria-label="Filter by review type"
                    className={historyFilterClassName}
                  >
                    <option value="all">All types</option>
                    <option value="creative">Creative</option>
                    <option value="copy_only">Copy only</option>
                  </select>
                  {filtersActive ? (
                    <Button type="button" variant="ghost" size="xs" onClick={resetFilters}>
                      Reset
                    </Button>
                  ) : null}
                </div>
              </div>
              {selectedCount ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{selectedCount} selected</Badge>
                    {allVisibleSelected ? (
                      <span className="text-xs text-muted-foreground">
                        All visible reviews selected
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setSelectedReviewIds(new Set())}
                    >
                      Clear
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="xs"
                      onClick={() => setDeleteRequest({
                        ids: Array.from(selectedReviewIds),
                        label: selectedCount === 1
                          ? '1 selected review'
                          : `${selectedCount} selected reviews`,
                      })}
                    >
                      <Trash2 />
                      Delete {selectedCount}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
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
          ) : filteredEntries.length ? (
            <div className={cn('overflow-auto', !allHistory && 'max-h-[42rem]')}>
              <Table className="min-w-[60rem] table-fixed">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow>
                    <TableHead className="h-11 w-8 px-2">
                      <HistoryCheckbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        disabled={!selectableVisibleIds.length}
                        ariaLabel="Select all visible reviews"
                        onChange={toggleVisibleSelection}
                      />
                    </TableHead>
                    <TableHead className="h-11 w-16 px-2 text-xs text-muted-foreground">Creative</TableHead>
                    <TableHead className="h-11 w-72 text-xs text-muted-foreground">Upload</TableHead>
                    <TableHead className="h-11 w-32 text-xs text-muted-foreground">Uploaded</TableHead>
                    <TableHead className="h-11 w-20 text-xs text-muted-foreground">Status</TableHead>
                    <TableHead className="h-11 w-80 text-xs text-muted-foreground">
                      <OfferResultsHeader offers={offerColumns} />
                    </TableHead>
                    <TableHead className="h-11 w-28 text-right text-xs text-muted-foreground">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEntries.map((entry) => {
                    const entryIds = deletableHistoryEntryIds(entry);
                    const selected = entryIds.length > 0 &&
                      entryIds.every((jobId) => selectedReviewIds.has(jobId));
                    const partiallySelected = !selected &&
                      entryIds.some((jobId) => selectedReviewIds.has(jobId));
                    const label = historyEntryLabel(entry);
                    const subtitle = historyEntrySubtitle(entry);
                    return (
                      <TableRow
                        key={entry.entryKey}
                        role="link"
                        tabIndex={0}
                        className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        data-state={selected || partiallySelected ? 'selected' : undefined}
                        onClick={(event) => {
                          if (!isInteractiveRowTarget(event.target)) openHistoryEntry(entry);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !isInteractiveRowTarget(event.target)) {
                            openHistoryEntry(entry);
                          }
                        }}
                      >
                        <TableCell className="px-2 py-1.5">
                          <HistoryCheckbox
                            checked={selected}
                            indeterminate={partiallySelected}
                            disabled={!entryIds.length}
                            ariaLabel={`Select ${label}`}
                            onChange={() => toggleEntrySelection(entry)}
                          />
                        </TableCell>
                        <TableCell className="px-2 py-1.5">
                          <CreativeThumbnail
                            alt={`Preview of ${label}`}
                            className="size-10"
                            jobId={entry.kind === 'review'
                              ? entry.review.has_creative === false ? null : entry.review.job_id
                              : entry.reviews.find((review) => review.has_creative !== false)?.job_id ?? null}
                          />
                        </TableCell>
                        <TableCell className="px-2 py-1.5">
                          <span className="flex min-w-0 items-center gap-2">
                            {entry.kind === 'batch' ? (
                              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                                <Layers3 className="size-3.5" aria-hidden="true" />
                              </span>
                            ) : null}
                            <span className="min-w-0">
                              <span className="block truncate font-medium" title={label}>{label}</span>
                              {subtitle ? (
                                <span className="block truncate text-xs text-muted-foreground" title={subtitle}>
                                  {subtitle}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell
                          className="px-2 py-1.5 text-xs text-muted-foreground"
                          title={formatDateTime(entry.createdAt)}
                        >
                          {formatHistoryDateTime(entry.createdAt)}
                        </TableCell>
                        <TableCell className="px-2 py-1.5">
                          <StatusBadge status={historyEntryStatus(entry)} />
                        </TableCell>
                        <TableCell className="px-2 py-1.5">
                          {entry.kind === 'batch' ? (
                            <div className="flex min-w-64 items-center justify-between gap-3 rounded-md border border-dashed bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
                              <span>
                                View {historyEntryItemCount(entry)} individual result{historyEntryItemCount(entry) === 1 ? '' : 's'}
                              </span>
                              <span className="font-medium text-foreground">Open batch →</span>
                            </div>
                          ) : (
                            <ReviewOfferResultsRail offers={offerColumns} review={entry.review} />
                          )}
                        </TableCell>
                        <TableCell className="px-2 py-1.5 text-right">
                          <div className="flex min-w-max justify-end gap-1">
                            {entry.kind === 'batch' ? (
                              <Link
                                to="/batches/$batchId"
                                params={{ batchId: entry.batchId }}
                                aria-label={`Open ${label}`}
                                className={cn(buttonVariants({ variant: 'outline', size: 'xs' }))}
                              >
                                <Layers3 data-icon="inline-start" />
                                Open batch
                              </Link>
                            ) : entry.review.report_ready ? (
                              <Link
                                to="/reviews/$jobId/report"
                                params={{ jobId: entry.review.job_id }}
                                aria-label={`Open report for ${label}`}
                                className={cn(buttonVariants({ variant: 'outline', size: 'xs' }))}
                              >
                                <FileJson data-icon="inline-start" />
                                Report
                              </Link>
                            ) : (
                              <Link
                                to="/reviews/$jobId"
                                params={{ jobId: entry.review.job_id }}
                                aria-label={`View job for ${label}`}
                                className={cn(buttonVariants({ variant: 'ghost', size: 'xs' }))}
                              >
                                Job
                              </Link>
                            )}
                            {allHistory && entryIds.length ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`Remove ${label} from history`}
                                title="Remove from history and dashboard stats"
                                onClick={() => setDeleteRequest({
                                  ids: entryIds,
                                  label,
                                })}
                              >
                                <Trash2 />
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : reviews.length ? (
            <div className="grid min-h-36 place-items-center rounded-lg border border-dashed bg-muted/20 p-6 text-center">
              <div className="grid max-w-sm gap-1">
                <p className="text-sm font-medium">No matching reviews</p>
                <p className="text-sm text-muted-foreground">
                  Adjust the search or reset one of the active filters.
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

      <AlertDialog.Root
        open={Boolean(deleteRequest)}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteRequest(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[1px]" />
          <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
            <AlertDialog.Popup className="w-full max-w-md rounded-xl bg-popover p-5 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
              <div className="grid gap-4">
                <div className="grid size-9 place-items-center rounded-lg bg-destructive/10 text-destructive">
                  <Trash2 className="size-4" />
                </div>
                <div className="grid gap-1">
                  <AlertDialog.Title className="text-base font-semibold">
                    {deleteRequest?.ids.length === 1
                      ? 'Remove this review?'
                      : `Remove ${deleteRequest?.ids.length ?? 0} reviews?`}
                  </AlertDialog.Title>
                  <AlertDialog.Description className="text-sm leading-5 text-muted-foreground">
                    {deleteRequest?.ids.length === 1 ? (
                      <>
                        <span className="font-medium text-foreground">{deleteRequest.label}</span>{' '}
                        will disappear from history and dashboard stats.
                      </>
                    ) : (
                      `${deleteRequest?.ids.length ?? 0} selected reviews will disappear from history and dashboard stats.`
                    )}{' '}
                    Original Google Drive files and uploaded sources are not deleted.
                  </AlertDialog.Description>
                </div>
                <div className="flex justify-end gap-2">
                  <AlertDialog.Close
                    disabled={deleteMutation.isPending}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    Cancel
                  </AlertDialog.Close>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={deleteMutation.isPending || !deleteRequest}
                    onClick={() => {
                      if (deleteRequest) deleteMutation.mutate(deleteRequest.ids);
                    }}
                  >
                    {deleteMutation.isPending ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                    {deleteMutation.isPending
                      ? 'Removing'
                      : deleteRequest?.ids.length === 1
                        ? 'Remove review'
                        : `Remove ${deleteRequest?.ids.length ?? 0}`}
                  </Button>
                </div>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

const historyFilterClassName =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

function HistoryCheckbox({
  ariaLabel,
  checked,
  disabled = false,
  indeterminate = false,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  indeterminate?: boolean;
  onChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={onChange}
      className="size-4 cursor-pointer rounded border-input accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
    />
  );
}

function isReviewDeletable(review: ReviewHistoryItem) {
  return review.report_ready || review.status === 'failed';
}

function buildHistoryEntries(
  reviews: ReviewHistoryItem[],
  batches: ReviewBatch[]
): HistoryEntry[] {
  const batchById = new Map(batches.map((batch) => [batch.batch_id, batch]));
  const reviewsByBatchId = new Map<string, ReviewHistoryItem[]>();
  for (const review of reviews) {
    if (!review.batch_id) continue;
    const grouped = reviewsByBatchId.get(review.batch_id) ?? [];
    grouped.push(review);
    reviewsByBatchId.set(review.batch_id, grouped);
  }

  const seenBatches = new Set<string>();
  return reviews.flatMap((review): HistoryEntry[] => {
    if (!review.batch_id) {
      return [{
        createdAt: review.created_at ?? null,
        entryKey: `review:${review.job_id}`,
        kind: 'review',
        review,
      }];
    }
    if (seenBatches.has(review.batch_id)) return [];
    seenBatches.add(review.batch_id);
    const batch = batchById.get(review.batch_id);
    const groupedReviews = reviewsByBatchId.get(review.batch_id) ?? [review];
    return [{
      batch,
      batchId: review.batch_id,
      createdAt: batch?.created_at ?? groupedReviews[0]?.created_at ?? null,
      entryKey: `batch:${review.batch_id}`,
      kind: 'batch',
      reviews: groupedReviews,
    }];
  });
}

function historyEntryBatchItems(entry: Extract<HistoryEntry, { kind: 'batch' }>): ReviewBatchItem[] {
  if (entry.batch) return entry.batch.items;
  return entry.reviews.map((review) => ({
    file_name: review.file_name,
    item_id: review.batch_item_id ?? review.job_id,
    job_id: review.job_id,
    media_kind: review.has_creative === false
      ? 'copy_only'
      : /\.(?:jpe?g|png|webp)$/i.test(review.file_name)
        ? 'image'
        : 'video',
    message: review.message,
    offer_outcomes: review.offer_outcomes,
    result: normalizeResultStatus(review.overall_status),
    status: review.status,
  }));
}

function historyEntryItemCount(entry: Extract<HistoryEntry, { kind: 'batch' }>) {
  return entry.batch?.expected_count ?? historyEntryBatchItems(entry).length;
}

function historyEntryLabel(entry: HistoryEntry) {
  if (entry.kind === 'review') return entry.review.file_name || entry.review.job_id;
  const count = historyEntryItemCount(entry);
  const copyOnly = historyEntryBatchItems(entry).every((item) => item.media_kind === 'copy_only');
  return copyOnly
    ? `Batch · ${count} copy review${count === 1 ? '' : 's'}`
    : `Batch · ${count} creative${count === 1 ? '' : 's'}`;
}

function historyEntrySubtitle(entry: HistoryEntry) {
  if (entry.kind === 'review') return '';
  if (entry.batch?.source_label) return entry.batch.source_label;
  const names = historyEntryBatchItems(entry).map((item) => item.file_name).filter(Boolean);
  if (!names.length) return `Batch ${entry.batchId.slice(0, 8)}`;
  const preview = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${preview} +${names.length - 2} more` : preview;
}

function historyEntryStatus(entry: HistoryEntry) {
  if (entry.kind === 'review') return entry.review.status;
  const statuses = historyEntryBatchItems(entry).map((item) => item.status);
  const terminal = statuses.filter((status) => isTerminalBatchStatus(status)).length;
  const failed = statuses.filter((status) => isFailedBatchStatus(status)).length;
  if (terminal !== statuses.length) return 'in_progress';
  if (!failed) return 'complete';
  if (failed === statuses.length) return 'failed';
  return 'complete_with_failures';
}

function deletableHistoryEntryIds(entry: HistoryEntry) {
  if (entry.kind === 'review') {
    return isReviewDeletable(entry.review) ? [entry.review.job_id] : [];
  }
  return historyEntryBatchItems(entry).flatMap((item) =>
    item.job_id && (item.status === 'complete' || item.status === 'failed')
      ? [item.job_id]
      : []
  );
}

function historyEntryMatchesSearch(entry: HistoryEntry, normalizedSearch: string) {
  if (entry.kind === 'review') return reviewMatchesSearch(entry.review, normalizedSearch);
  return [
    entry.batchId,
    entry.batch?.source_label,
    historyEntryLabel(entry),
    historyEntryStatus(entry),
    formatStatus(historyEntryStatus(entry)),
    formatDateTime(entry.createdAt),
    ...historyEntryBatchItems(entry).flatMap((item) => [
      item.file_name,
      item.job_id,
      item.status,
      item.message,
      item.result,
      ...(item.offer_outcomes ?? []).flatMap((outcome) => [
        outcome.offer_id,
        outcome.offer_name,
        outcome.overall_status,
        outcome.creative_result,
        outcome.ad_copy_result,
        outcome.message,
      ]),
    ]),
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
}

function historyEntryMatchesTypeFilter(entry: HistoryEntry, typeFilter: HistoryTypeFilter) {
  if (typeFilter === 'all') return true;
  if (entry.kind === 'review') {
    return typeFilter === 'creative'
      ? entry.review.has_creative !== false
      : entry.review.has_creative === false;
  }
  const items = historyEntryBatchItems(entry);
  return typeFilter === 'creative'
    ? items.some((item) => item.media_kind !== 'copy_only')
    : items.some((item) => item.media_kind === 'copy_only');
}

function historyEntryMatchesResultFilter(
  entry: HistoryEntry,
  offerColumns: ReturnType<typeof getOfferColumns>,
  offerFilter: string,
  resultFilter: HistoryResultFilter
) {
  if (entry.kind === 'review') {
    return reviewMatchesResultFilter(entry.review, offerColumns, offerFilter, resultFilter);
  }
  if (offerFilter === 'all' && resultFilter === 'all') return true;
  const relevantOffers = offerFilter === 'all'
    ? offerColumns
    : offerColumns.filter((offer) => offer.offer_id === offerFilter);
  const outcomes = historyEntryBatchItems(entry).flatMap((item) =>
    relevantOffers.map((offer) => batchOutcomeForOffer(item, offer))
  );
  if (resultFilter === 'na') {
    return outcomes.some((outcome) => !outcome || outcome.evaluation_state !== 'evaluated');
  }
  if (resultFilter !== 'all') {
    return outcomes.some((outcome) =>
      outcome?.evaluation_state === 'evaluated' && outcome.overall_status === resultFilter
    );
  }
  return outcomes.some((outcome) => outcome?.evaluation_state === 'evaluated');
}

function isInteractiveRowTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(
    target.closest('a, button, input, select, textarea, [role="button"], [role="menuitem"]')
  );
}

function reviewMatchesSearch(review: ReviewHistoryItem, normalizedSearch: string) {
  return [
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
    ...(review.offer_outcomes ?? []).flatMap((outcome) => [
      outcome.offer_id,
      outcome.offer_name,
      outcome.overall_status,
      outcome.creative_result,
      outcome.ad_copy_result,
      outcome.message,
    ]),
    formatDateTime(review.created_at),
  ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
}

function reviewMatchesResultFilter(
  review: ReviewHistoryItem,
  offerColumns: ReturnType<typeof getOfferColumns>,
  offerFilter: string,
  resultFilter: HistoryResultFilter
) {
  if (offerFilter === 'all' && resultFilter === 'all') return true;
  const relevantOffers = offerFilter === 'all'
    ? offerColumns
    : offerColumns.filter((offer) => offer.offer_id === offerFilter);
  const outcomes = relevantOffers.map((offer) => reviewOutcomeForOffer(review, offer));

  if (resultFilter === 'na') {
    return outcomes.some(
      (outcome) => !outcome || outcome.evaluation_state !== 'evaluated'
    );
  }
  if (resultFilter !== 'all') {
    return outcomes.some(
      (outcome) =>
        outcome?.evaluation_state === 'evaluated' &&
        outcome.overall_status === resultFilter
    );
  }
  return outcomes.some((outcome) => outcome?.evaluation_state === 'evaluated');
}

async function deleteReviewSelection(ids: string[]) {
  const queue = [...ids];
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  let firstError: unknown;
  const workerCount = Math.min(4, queue.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const jobId = queue.shift();
      if (!jobId) return;
      try {
        await deleteReview(jobId);
        deletedIds.push(jobId);
      } catch (error) {
        failedIds.push(jobId);
        firstError ??= error;
      }
    }
  }));

  return { deletedIds, failedIds, firstError };
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

function PdfDownloadMenu({
  baseHref,
  contentLabel = 'This creative',
  offers,
  size = 'default',
}: {
  baseHref: string;
  contentLabel?: string;
  offers: OfferColumn[];
  size?: 'default' | 'sm';
}) {
  const [downloadingHref, setDownloadingHref] = useState('');
  const [downloadError, setDownloadError] = useState('');

  async function startDownload(href: string) {
    if (downloadingHref) return;
    setDownloadingHref(href);
    setDownloadError('');
    try {
      const response = await fetch(href, { credentials: 'same-origin' });
      if (!response.ok) {
        throw new Error(`PDF request failed with status ${response.status}.`);
      }
      const blob = await response.blob();
      const signature = await blob.slice(0, 5).text();
      if (signature !== '%PDF-') {
        throw new Error('The server returned a non-PDF response.');
      }
      const disposition = response.headers.get('content-disposition') ?? '';
      const encodedName = disposition.match(/filename\*=utf-8''([^;]+)/i)?.[1];
      const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
      let filename = 'vibe-check-report.pdf';
      try {
        filename = encodedName ? decodeURIComponent(encodedName) : (quotedName || filename);
      } catch {
        filename = quotedName || filename;
      }
      filename = filename.split(/[\\/]/).pop() || 'vibe-check-report.pdf';
      if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';

      const objectUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch {
      setDownloadError('The PDF could not be downloaded. Refresh the page and try again.');
    } finally {
      setDownloadingHref('');
    }
  }

  function downloadLinkProps(href: string) {
    return {
      href,
      onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        void startDownload(href);
      },
    };
  }

  return (
    <div className="grid w-fit gap-1">
      <Menu.Root>
        <Menu.Trigger className={buttonVariants({ size })} disabled={Boolean(downloadingHref)}>
          {downloadingHref ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Download data-icon="inline-start" />
          )}
          {downloadingHref ? 'Preparing PDF' : 'Download PDF'}
          <ChevronDown data-icon="inline-end" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
            <Menu.Popup className="min-w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                Choose PDF version
              </div>
              <Menu.LinkItem
                {...downloadLinkProps(baseHref)}
                closeOnClick
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              >
                <Download className="size-4 text-muted-foreground" />
                <span className="grid">
                  <span className="font-medium">Unified · all offers</span>
                  <span className="text-xs text-muted-foreground">{contentLabel} · every offer result</span>
                </span>
              </Menu.LinkItem>
              <div className="my-1 h-px bg-border" />
              {offers.map((offer) => {
                const href = `${baseHref}?offer_id=${encodeURIComponent(offer.offer_id)}`;
                return (
                  <Menu.LinkItem
                    key={offer.offer_id}
                    {...downloadLinkProps(href)}
                    closeOnClick
                    className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
                    <Download className="size-4 text-muted-foreground" />
                    <span className="grid">
                      <span className="font-medium">{offer.offer_name} only</span>
                      <span className="text-xs text-muted-foreground">{contentLabel} · one offer</span>
                    </span>
                  </Menu.LinkItem>
                );
              })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {downloadError ? (
        <p role="alert" className="max-w-72 text-xs text-destructive">{downloadError}</p>
      ) : null}
    </div>
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
  const evidenceQuery = useQuery({
    queryKey: ['evidence', jobId],
    queryFn: () => getReviewEvidence(jobId),
    enabled: Boolean(query.data),
  });
  const offerResults: OfferResult[] = query.data
    ? query.data.offer_results?.length
      ? query.data.offer_results
      : [query.data]
    : [];
  const offerOutcomes: OfferOutcome[] = query.data?.offer_outcomes?.length
    ? query.data.offer_outcomes
    : offerResults.map((result) => ({
        offer_id: result.offer_id,
        offer_name: result.offer_name,
        evaluation_state: 'evaluated' as const,
        overall_status: normalizeResultStatus(result.overall_status),
        creative_result: normalizeResultStatus(result.source_results?.creative?.status),
        ad_copy_result: normalizeResultStatus(result.source_results?.ad_copy?.status),
        with_override: result.internal_disposition === 'accepted_with_override',
        message: 'Evaluated using saved offer guidelines.',
      }));
  const detailedResults = offerResults.filter((result) => {
    const outcome = findOfferOutcome(offerOutcomes, result.offer_id);
    return !outcome || outcome.evaluation_state === 'evaluated';
  });
  const activeOffer = detailedResults.find((result) => result.offer_id === selectedOfferId)
    ?? detailedResults[0];
  const offerColumns = getOfferColumns([], [offerOutcomes]);

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
      <Card size="sm">
        <CardHeader>
          <CardTitle as="h1" className="text-xl">Offer availability</CardTitle>
          <CardDescription>
            Evaluated offers include a result. Offers that were off or missing guidelines remain N/A for this review.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
            role="group"
            aria-label="Offer result selection"
          >
            {offerColumns.map((offer) => {
              const outcome = findOfferOutcome(offerOutcomes, offer.offer_id);
              const result = detailedResults.find((candidate) => candidate.offer_id === offer.offer_id);
              const isSelected = result?.offer_id === activeOffer.offer_id;
              const content = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{offer.offer_name}</span>
                    <OfferOutcomeCell compact outcome={outcome} />
                  </div>
                  <span className="text-xs leading-4 text-muted-foreground">
                    {result
                      ? isSelected ? 'Showing detailed findings' : 'Open detailed findings'
                      : outcome?.message || 'No result was generated.'}
                  </span>
                </>
              );
              return result ? (
                <button
                  key={offer.offer_id}
                  type="button"
                  aria-pressed={isSelected}
                  className={cn(
                    'grid gap-2 rounded-lg border bg-background p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                    isSelected && 'border-primary/50 bg-primary/5'
                  )}
                  onClick={() => setSelectedOfferId(result.offer_id)}
                >
                  {content}
                </button>
              ) : (
                <div key={offer.offer_id} className="grid gap-2 rounded-lg border bg-muted/20 p-3">
                  {content}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-xl">{activeOffer.offer_name} review summary</CardTitle>
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
          <div className="flex flex-col gap-4 sm:flex-row">
            <CreativeThumbnail
              alt={`Preview for review ${jobId}`}
              className="h-40 w-32"
              jobId={jobId}
            />
            <div className="grid content-start gap-3">
              <p className="max-w-4xl text-sm leading-6 text-muted-foreground">
                {activeOffer.summary}
              </p>
              <p className="text-sm font-medium">
                {resultDescription(activeOffer.overall_status)}
              </p>
            </div>
          </div>
          {activeOffer.internal_disposition === 'accepted_with_override' ? (
            <Alert>
              <CheckCircle2 />
              <AlertTitle>Green with internal exception for {activeOffer.offer_name}</AlertTitle>
              <AlertDescription>
                The creative is ready to run under the current saved internal rules. The policy differences that changed the decision are recorded below.
              </AlertDescription>
            </Alert>
          ) : null}
          {activeOffer.applied_overrides?.length ? (
            <div className="grid gap-3">
              <div>
                <h3 className="text-sm font-medium">Applied internal exceptions</h3>
                <p className="text-xs text-muted-foreground">
                  These saved rules materially changed the effective result from the official source policy.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {activeOffer.applied_overrides.map((override) => (
                  <div key={override.override_id} className="grid gap-2 rounded-lg border border-emerald-600/25 bg-emerald-500/5 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{override.title || override.override_id}</Badge>
                      <Badge variant="outline">{formatSource(override.source)}</Badge>
                    </div>
                    <p className="text-sm">{override.evidence}</p>
                    <p className="text-xs leading-5 text-muted-foreground">{override.rationale}</p>
                  </div>
                ))}
              </div>
            </div>
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
            <PdfDownloadMenu
              baseHref={`/api/reviews/${jobId}/report.pdf`}
              offers={detailedResults.map((result) => ({
                offer_id: result.offer_id,
                offer_name: result.offer_name,
              }))}
            />
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
          <CardTitle className="text-xl">Findings with creative evidence</CardTitle>
          <CardDescription>
            {activeOffer.findings.length} effective-policy finding{activeOffer.findings.length === 1 ? '' : 's'} paired with the closest saved frame
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activeOffer.findings.length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {activeOffer.findings.map((finding, index) => (
                <ReviewFindingCard
                  key={`${finding.source}-${finding.timestamp_start ?? 'none'}-${index}`}
                  finding={finding}
                  frame={nearestReviewEvidenceFrame(
                    evidenceQuery.data?.frames ?? [],
                    finding.timestamp_start
                  )}
                  index={index + 1}
                  jobId={jobId}
                />
              ))}
            </div>
          ) : (
            <div className="grid min-h-40 place-items-center rounded-lg border border-emerald-600/25 bg-emerald-500/5 p-6 text-center">
              <div className="grid gap-2">
                <CheckCircle2 className="mx-auto size-6 text-emerald-600" />
                <p className="font-medium">No findings were returned</p>
                <p className="text-sm text-muted-foreground">The creative is ready to run under this offer’s reviewed policy.</p>
              </div>
            </div>
          )}
          {evidenceQuery.error ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Saved frames are temporarily unavailable; the finding text is still complete.
            </p>
          ) : null}
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
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => getBatch(batchId),
    refetchInterval: (current: { state: { data?: ReviewBatch } }) => {
      const batch = current.state.data;
      return batch?.items.every((item) => isTerminalBatchStatus(item.status)) ? false : 1500;
    },
  });
  const offerCatalogQuery = useQuery({
    queryKey: ['offers'],
    queryFn: listOfferCatalog,
    staleTime: 60_000,
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
  const batchComplete = query.data.items.every((item) => isTerminalBatchStatus(item.status));
  const offerColumns = getOfferColumns(
    offerCatalogQuery.data ?? [],
    query.data.items.map((item) => item.offer_outcomes)
  );
  const pdfOffers = offerColumns.filter((offer) => query.data.items.some((item) =>
    findOfferOutcome(item.offer_outcomes, offer.offer_id)?.evaluation_state === 'evaluated'
  ));

  function openBatchItem(item: ReviewBatchItem) {
    if (!item.job_id) return;
    const to = item.status === 'complete'
      ? '/reviews/$jobId/report' as const
      : '/reviews/$jobId' as const;
    void navigate({ to, params: { jobId: item.job_id } });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h1" className="text-xl">
          Batch report
        </CardTitle>
        <CardDescription>
          Uploaded {formatDate(query.data.created_at)} · {completeCount} complete · {failedCount} failed · {query.data.expected_count} total
        </CardDescription>
        <CardAction>
          <div className="flex flex-wrap justify-end gap-2">
            {batchComplete ? (
              <PdfDownloadMenu
                baseHref={`/api/batches/${query.data.batch_id}/report.pdf`}
                contentLabel={`All ${query.data.expected_count} creative${query.data.expected_count === 1 ? '' : 's'}`}
                offers={pdfOffers}
                size="sm"
              />
            ) : null}
            <Link to="/reviews/new" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Back to workspace
            </Link>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="mb-4 grid gap-1">
          <h2 className="text-sm font-medium">Individual creative results</h2>
          <p className="text-xs text-muted-foreground">
            Open any row for that creative’s detailed report and individual PDF options.
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Creative</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                {offerColumns.map((offer) => (
                  <TableHead key={offer.offer_id} className="min-w-32">{offer.offer_name}</TableHead>
                ))}
                <TableHead className="text-right">Report</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((item) => (
                <TableRow
                  key={item.item_id}
                  role={item.job_id ? 'link' : undefined}
                  tabIndex={item.job_id ? 0 : undefined}
                  className={cn(
                    item.job_id && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
                  )}
                  onClick={(event) => {
                    if (item.job_id && !isInteractiveRowTarget(event.target)) openBatchItem(item);
                  }}
                  onKeyDown={(event) => {
                    if (item.job_id && event.key === 'Enter' && !isInteractiveRowTarget(event.target)) {
                      openBatchItem(item);
                    }
                  }}
                >
                  <TableCell className="align-top">
                    <CreativeThumbnail
                      alt={`Preview of ${item.file_name}`}
                      jobId={item.media_kind === 'copy_only' ? null : item.job_id}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{batchTypeLabel(item.media_kind)}</TableCell>
                  <TableCell className="w-80 min-w-64 max-w-80 whitespace-normal align-top">
                    <span className="block truncate font-medium">{item.file_name}</span>
                    {isFailedBatchStatus(item.status) && item.message ? (
                      <span
                        className="mt-1 block line-clamp-2 break-words text-xs leading-4 text-destructive"
                        title={item.message}
                      >
                        {item.message}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top"><StatusBadge status={item.status} /></TableCell>
                  {offerColumns.map((offer) => (
                    <TableCell key={offer.offer_id}>
                      <OfferOutcomeCell outcome={batchOutcomeForOffer(item, offer)} />
                    </TableCell>
                  ))}
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
                    ) : item.job_id ? (
                      <Link
                        to="/reviews/$jobId"
                        params={{ jobId: item.job_id }}
                        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                      >
                        View job
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
          Manage offer-specific official guidelines, current internal rules, and review runtime defaults.
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

function AutomationsRoutePage() {
  return (
    <AdminAccessGate>
      <AutomationsPage />
    </AdminAccessGate>
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
      <Badge variant="secondary" title="The official-policy issue is permitted by a saved internal rule.">
        <CheckCircle2 />
        Accepted internally
      </Badge>
    );
  }
  if (disposition === 'human_review') return <Badge variant="outline">Internal review needed</Badge>;
  return (
    <Badge
      variant="outline"
      className="border-orange-600/30 bg-orange-500/15 text-orange-700 dark:text-orange-300"
    >
      Action required
    </Badge>
  );
}

function SeverityBadge({ severity }: { severity: Finding['severity'] }) {
  if (severity === 'high') return <Badge variant="destructive">High</Badge>;
  if (severity === 'medium') return <Badge variant="secondary">Medium</Badge>;
  return <Badge variant="outline">Low</Badge>;
}

function ReviewFindingCard({
  finding,
  frame,
  index,
  jobId,
}: {
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
          filename={frame.filename}
          jobId={jobId}
        />
      ) : (
        <span className="grid h-32 w-24 shrink-0 place-items-center rounded-lg border bg-muted/30 px-2 text-center text-[11px] font-medium text-muted-foreground sm:h-36 sm:w-28">
          {formatSource(finding.source)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">#{index}</Badge>
          <SeverityBadge severity={finding.severity} />
          <Badge variant="outline">{formatSource(finding.source)}</Badge>
          {finding.timestamp_start ? (
            <Badge variant="secondary">{formatFindingTimestamp(finding.timestamp_start)}</Badge>
          ) : null}
        </div>
        <p className="mt-3 text-sm font-medium leading-5">{finding.evidence}</p>
        <div className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground">
          <p><span className="font-semibold text-foreground">Policy:</span> {finding.policy_reason}</p>
          <p><span className="font-semibold text-foreground">Fix:</span> {finding.suggested_fix}</p>
        </div>
        {finding.internal_override ? (
          <div className="mt-3 rounded-lg border border-emerald-600/25 bg-emerald-500/5 p-2 text-xs leading-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{formatStatus(finding.internal_override.disposition)}</Badge>
              <span className="font-medium">{finding.internal_override.title || finding.internal_override.override_id}</span>
            </div>
            {finding.internal_override.rationale ? (
              <p className="mt-1 text-muted-foreground">{finding.internal_override.rationale}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function nearestReviewEvidenceFrame(
  frames: ReviewEvidenceFrame[],
  timestamp: string | null | undefined
): ReviewEvidenceFrame | null {
  if (!frames.length) return null;
  const target = parseFindingTimestampSeconds(timestamp);
  if (target === null || Number.isNaN(target)) return frames[0] ?? null;
  return frames.reduce((nearest, frame) => {
    if (frame.timestamp === null) return nearest;
    if (!nearest || nearest.timestamp === null) return frame;
    return Math.abs(frame.timestamp - target) < Math.abs(nearest.timestamp - target)
      ? frame
      : nearest;
  }, null as ReviewEvidenceFrame | null) ?? frames[0] ?? null;
}

function formatFindingTimestamp(value: string) {
  const seconds = parseFindingTimestampSeconds(value);
  if (seconds === null || Number.isNaN(seconds)) return value;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.max(0, Math.round(seconds % 60));
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function parseFindingTimestampSeconds(value: string | null | undefined) {
  if (!value) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.length >= 2 && parts.length <= 3 && parts.every(Number.isFinite)) {
    const seconds = parts[parts.length - 1] + parts[parts.length - 2] * 60;
    return parts.length === 3 ? seconds + parts[0] * 3600 : seconds;
  }
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
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

function normalizeResultStatus(status?: string | null): OverallStatus | null {
  const normalized: Record<ResultStatus, OverallStatus> = {
    green: 'green',
    amber: 'amber',
    yellow: 'amber',
    orange: 'amber',
    red: 'red',
    pass: 'green',
    needs_review: 'amber',
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

function formatHistoryDateTime(value?: number | null) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(value));
}

function randomId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function driveBatchSourceLabel(
  selectedFolders: Map<string, string>,
  selectedFileCount: number
) {
  const folderNames = Array.from(selectedFolders.values())
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  const visibleFolders = folderNames.slice(0, 3);
  const folderLabel = folderNames.length > 3
    ? `${visibleFolders.join(', ')} + ${folderNames.length - 3} more folders`
    : visibleFolders.join(', ');
  const fileLabel = selectedFileCount
    ? `${selectedFileCount} selected ${selectedFileCount === 1 ? 'file' : 'files'}`
    : '';
  const label = [folderLabel, fileLabel].filter(Boolean).join(' + ');
  return label.length > 500 ? `${label.slice(0, 497).trimEnd()}...` : label;
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
  component: HomePage,
});
const kissterraRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kissterra',
  component: KissterraDashboardPage,
});
const kissterraReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kissterra/reviews/$jobId',
  component: KissterraReviewDetailPage,
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
const liveScansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/live-scans',
  component: LiveScansPage,
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
const automationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/automations',
  component: AutomationsRoutePage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    kissterraRoute,
    kissterraReviewRoute,
    newReviewRoute,
    historyRoute,
    liveScansRoute,
    automationsRoute,
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
