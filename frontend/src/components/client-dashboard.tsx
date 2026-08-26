import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Menu } from '@base-ui/react/menu';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ScanSearch,
  Search,
  ShieldCheck,
  Layers3,
  SlidersHorizontal,
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
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Textarea } from '@/components/ui/textarea';
import { CreativeEvidenceImage, CreativeThumbnail } from '@/components/creative-media';
import {
  clearClientSession,
  decideClientReview,
  fetchClientReviewPdf,
  getClientSession,
  getClientReview,
  listClientReviews,
  preloadClientReviewImage,
  verifyClientCredentials,
  type ClientDecisionValue,
  type ClientFeedbackReason,
  type ClientPortalSummary,
  type ClientReviewDetail,
  type ClientReviewItem,
  type ClientReviewList,
  type ClientSession,
  type Finding,
  type OverallStatus,
  type ReviewEvidenceFrame,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const SELECTED_CLIENT_KEY = 'vibe-check-selected-client';
const CLIENT_SIDEBAR_OPEN_KEY = 'vibe-check-client-sidebar-open';

type ReviewGroup = {
  createdAt: number;
  id: string;
  kind: 'batch' | 'individual';
  label: string | null;
  reviews: ClientReviewItem[];
};

type StatusFilter = 'all' | 'pending' | 'approved' | 'disapproved';
type BatchFilter = 'all' | 'unchecked' | 'checked';
type DecisionInput = {
  decision: ClientDecisionValue;
  feedbackNote?: string;
  feedbackReason?: ClientFeedbackReason;
};

type ClientAuthValue = {
  error: string;
  isSigningOut: boolean;
  logout: () => Promise<void>;
  session: ClientSession;
};

const ClientAuthContext = createContext<ClientAuthValue | null>(null);

export function ClientDashboardPage() {
  return (
    <ClientPortalGate>
      <ClientDashboard />
    </ClientPortalGate>
  );
}

export function ClientReviewDetailPage() {
  return (
    <ClientPortalGate>
      <ClientReviewDetail />
    </ClientPortalGate>
  );
}

export const KissterraDashboardPage = ClientDashboardPage;
export const KissterraReviewDetailPage = ClientReviewDetailPage;

function ClientPortalGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<ClientSession | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void getClientSession()
      .then((nextSession) => {
        if (!active) return;
        setSession(nextSession);
        if (window.location.pathname === '/login' || window.location.pathname === '/') {
          void navigate({ to: '/client', replace: true });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setIsChecking(false);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  useEffect(() => {
    if (isChecking) return;
    document.title = !session
      ? 'Sign in · AdChecked'
      : pathname.includes('/reviews/')
        ? 'Creative review · AdChecked'
        : 'Creative reviews · AdChecked';
  }, [isChecking,pathname,session]);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      setError('Enter your username and password.');
      return;
    }
    setIsChecking(true);
    setError('');
    try {
      const nextSession = await verifyClientCredentials(normalizedUsername, password);
      setPassword('');
      const firstPortal = nextSession.portals[0];
      if (firstPortal) {
        void queryClient.prefetchQuery({
          queryKey: ['client', firstPortal.client_id, 'reviews'],
          queryFn: () => listClientReviews(firstPortal.client_id),
          staleTime: 30_000,
        });
      }
      setSession(nextSession);
      if (window.location.pathname === '/login' || window.location.pathname === '/') {
        await navigate({ to: '/client', replace: true });
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsChecking(false);
    }
  }

  async function logout() {
    setIsSigningOut(true);
    setError('');
    try {
      await clearClientSession();
    } catch (reason) {
      setError(`Could not sign out. ${errorMessage(reason)}`);
      setIsSigningOut(false);
      return;
    }
    window.sessionStorage.removeItem(SELECTED_CLIENT_KEY);
    setPassword('');
    setSession(null);
    setError('');
    queryClient.removeQueries({ queryKey: ['client'] });
    await navigate({ to: '/login', replace: true });
    setIsSigningOut(false);
  }

  if (!session) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/30 p-4 text-foreground">
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader>
            <span className="mb-2 grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
              <ScanSearch className="size-5" strokeWidth={2.2} />
            </span>
            <CardTitle as="h1" className="text-2xl">Sign in to AdChecked</CardTitle>
            <CardDescription>
              Sign in to review your creatives and share your decisions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={unlock}>
              <div className="grid gap-2">
                <Label htmlFor="client-username">Username</Label>
                <Input
                  id="client-username"
                  value={username}
                  autoComplete="username"
                  autoFocus
                  disabled={isChecking}
                  onChange={(event) => setUsername(event.currentTarget.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="client-password">Password</Label>
                <Input
                  id="client-password"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  disabled={isChecking}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                />
              </div>
              <Button type="submit" size="lg" disabled={isChecking || !username.trim() || !password}>
                {isChecking ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                {isChecking ? 'Signing in' : 'Sign in'}
              </Button>
            </form>
            {error ? (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle />
                <AlertTitle>Sign-in unsuccessful</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <ClientAuthContext.Provider value={{ error, isSigningOut, logout, session }}>
      {children}
    </ClientAuthContext.Provider>
  );
}

function ClientDashboard() {
  const { session } = useClientAuth();
  const queryClient = useQueryClient();
  const storedClientId = window.sessionStorage.getItem(SELECTED_CLIENT_KEY);
  const initialClientId = session.portals.some((portal) => portal.client_id === storedClientId)
    ? storedClientId!
    : session.portals[0]?.client_id ?? '';
  const [selectedClientId, setSelectedClientId] = useState(initialClientId);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedCreatives, setExpandedCreatives] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [batchFilter, setBatchFilter] = useState<BatchFilter>('all');
  const [loadBackgroundPortals, setLoadBackgroundPortals] = useState(false);

  const queries = useQueries({
    queries: session.portals.map((portal) => ({
      enabled: portal.client_id === selectedClientId || loadBackgroundPortals,
      queryKey: ['client', portal.client_id, 'reviews'],
      queryFn: () => listClientReviews(portal.client_id),
      refetchInterval: portal.client_id === selectedClientId ? 30_000 : 120_000,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    })),
  });
  const selectedIndex = session.portals.findIndex((portal) => portal.client_id === selectedClientId);
  const selectedPortal = session.portals[selectedIndex] ?? session.portals[0];
  const selectedQuery = queries[selectedIndex] ?? queries[0];
  const reviews = selectedQuery?.data?.reviews ?? [];
  const allGroups = useMemo(() => groupReviews(reviews), [reviews]);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleGroups = useMemo(() => allGroups.flatMap((group) => {
    const isChecked = group.reviews.every((review) => Boolean(review.decision));
    if (batchFilter === 'checked' && !isChecked) return [];
    if (batchFilter === 'unchecked' && isChecked) return [];
    const visibleReviews = group.reviews.filter((review) => {
      if (statusFilter !== 'all' && decisionStatus(review) !== statusFilter) return false;
      if (!normalizedSearch) return true;
      return `${review.file_name} ${review.issue_summary ?? ''}`.toLocaleLowerCase().includes(normalizedSearch);
    });
    return visibleReviews.length ? [{ ...group, reviews: visibleReviews }] : [];
  }), [allGroups, batchFilter, normalizedSearch, statusFilter]);

  useEffect(() => {
    if (!selectedPortal) return;
    window.sessionStorage.setItem(SELECTED_CLIENT_KEY, selectedPortal.client_id);
  }, [selectedPortal]);

  useEffect(() => {
    setExpandedGroups((current) => {
      const validIds = new Set(allGroups.map((group) => group.id));
      const next = new Set([...current].filter((id) => validIds.has(id)));
      if (!next.size && allGroups[0]) next.add(allGroups[0].id);
      return setsEqual(current, next) ? current : next;
    });
  }, [allGroups]);

  useEffect(() => {
    if (loadBackgroundPortals || session.role !== 'admin' || !selectedQuery?.data) return;
    const timeout = window.setTimeout(() => setLoadBackgroundPortals(true), 1_500);
    return () => window.clearTimeout(timeout);
  }, [loadBackgroundPortals, selectedQuery?.data, session.role]);

  useEffect(() => {
    if (!selectedPortal) return;
    const visibleReviews = allGroups
      .filter((group) => expandedGroups.has(group.id))
      .flatMap((group) => group.reviews.slice(0, 9));
    for (const review of visibleReviews) {
      preloadClientReviewImage(selectedPortal.client_id, review.job_id);
      void queryClient.prefetchQuery({
        queryKey: ['client', selectedPortal.client_id, 'review', review.job_id],
        queryFn: () => getClientReview(selectedPortal.client_id, review.job_id),
        staleTime: 60_000,
      });
    }
  }, [allGroups, expandedGroups, queryClient, selectedPortal]);

  const decisionMutation = useMutation({
    mutationFn: ({ clientId, jobId, decision, feedbackNote, feedbackReason }: {
      clientId: string;
      jobId: string;
    } & DecisionInput) => decideClientReview(
      clientId,
      jobId,
      decision,
      feedbackReason ? { note: feedbackNote, reason: feedbackReason } : undefined
    ),
    onSuccess: (decision, variables) => {
      updateReviewDecision(queryClient, variables.clientId, variables.jobId, decision);
      queryClient.setQueryData<ClientReviewDetail>(
        ['client', variables.clientId, 'review', variables.jobId],
        (current) => current ? { ...current, review: { ...current.review, decision } } : current
      );
    },
  });
  const bulkMutation = useMutation({
    mutationFn: async ({ clientId, jobIds }: { clientId: string; jobIds: string[] }) => {
      const decisions = await Promise.all(jobIds.map(async (jobId) => ({
        decision: await decideClientReview(clientId, jobId, 'approved'),
        jobId,
      })));
      return { clientId, decisions };
    },
    onSuccess: ({ clientId, decisions }) => {
      for (const value of decisions) {
        updateReviewDecision(queryClient, clientId, value.jobId, value.decision);
      }
    },
  });

  const counts = useMemo(() => ({
    all: reviews.length,
    approved: reviews.filter((review) => review.decision?.decision === 'approved').length,
    disapproved: reviews.filter((review) => review.decision?.decision === 'disapproved').length,
    pending: reviews.filter((review) => !review.decision).length,
  }), [reviews]);
  const checkedBatches = allGroups.filter((group) => group.reviews.every((review) => Boolean(review.decision))).length;
  const uncheckedBatches = allGroups.length - checkedBatches;
  const statusCounts = {
    green: reviews.filter((review) => review.ai_status === 'green').length,
    yellow: reviews.filter((review) => review.ai_status === 'yellow').length,
    red: reviews.filter((review) => review.ai_status === 'red').length,
  };
  const portalCounts = new Map(session.portals.map((portal, index) => [
    portal.client_id,
    queries[index]?.data?.reviews.length,
  ]));

  function selectClient(clientId: string) {
    setSelectedClientId(clientId);
    setSearch('');
    setStatusFilter('all');
    setBatchFilter('all');
    setExpandedGroups(new Set());
    setExpandedCreatives(new Set());
  }

  function prefetchCreative(review: ClientReviewItem) {
    if (!selectedPortal) return;
    preloadClientReviewImage(selectedPortal.client_id, review.job_id);
    void queryClient.prefetchQuery({
      queryKey: ['client', selectedPortal.client_id, 'review', review.job_id],
      queryFn: () => getClientReview(selectedPortal.client_id, review.job_id),
      staleTime: 60_000,
    });
  }

  return (
    <ClientPortalFrame activeClientId={selectedPortal?.client_id} counts={portalCounts} onSelectClient={selectClient}>
      {selectedPortal ? (
        <div className="grid gap-4">
          <section className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Your creative reviews</p>
              <h1 className="font-heading text-3xl font-semibold tracking-tight">{selectedPortal.display_name}</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <MetricBadge label="total" value={reviews.length} />
              <MetricBadge label="red" tone="danger" value={statusCounts.red} />
              <MetricBadge label="yellow" tone="warning" value={statusCounts.yellow} />
              <MetricBadge label="green" tone="success" value={statusCounts.green} />
            </div>
          </section>

          <section aria-label="Review filters" className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2 shadow-xs">
            <div className="relative min-w-56 flex-[1_1_24rem]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-9 border-0 bg-muted/45 pl-9 shadow-none focus-visible:bg-background" value={search} placeholder="Search creatives by filename or review summary…" onChange={(event) => setSearch(event.currentTarget.value)} />
            </div>
            <CompactFilterMenu
              icon={<SlidersHorizontal />}
              label="Status"
              onChange={setStatusFilter}
              options={[
                { count: counts.all, label: 'All', value: 'all' },
                { count: counts.pending, label: 'Pending', value: 'pending' },
                { count: counts.approved, label: 'Approved', value: 'approved' },
                { count: counts.disapproved, label: 'Disapproved', value: 'disapproved' },
              ]}
              value={statusFilter}
            />
            <CompactFilterMenu
              icon={<Layers3 />}
              label="Batches"
              onChange={setBatchFilter}
              options={[
                { count: allGroups.length, label: 'All batches', value: 'all' },
                { count: uncheckedBatches, label: 'Needs review', value: 'unchecked' },
                { count: checkedBatches, label: 'Reviewed', value: 'checked' },
              ]}
              value={batchFilter}
            />
            {(search || statusFilter !== 'all' || batchFilter !== 'all') ? (
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Clear filters" title="Clear filters" onClick={() => {
                setSearch('');
                setStatusFilter('all');
                setBatchFilter('all');
              }}>
                <X />
              </Button>
            ) : null}
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Refresh reviews" title="Refresh reviews" disabled={selectedQuery?.isFetching} onClick={() => void selectedQuery?.refetch()}>
              <RefreshCw className={cn(selectedQuery?.isFetching && 'animate-spin')} />
            </Button>
          </section>

          {selectedQuery?.error ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Reviews unavailable</AlertTitle>
              <AlertDescription>{errorMessage(selectedQuery.error)}</AlertDescription>
              <AlertAction><Button type="button" size="xs" variant="outline" onClick={() => void selectedQuery.refetch()}>Retry</Button></AlertAction>
            </Alert>
          ) : selectedQuery?.isLoading ? (
            <div className="grid gap-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
          ) : visibleGroups.length ? (
            <div className="grid gap-3">
              {visibleGroups.map((group) => {
                const isExpanded = expandedGroups.has(group.id);
                const red = group.reviews.filter((review) => review.ai_status === 'red').length;
                const yellow = group.reviews.filter((review) => review.ai_status === 'yellow').length;
                const green = group.reviews.filter((review) => review.ai_status === 'green').length;
                const pending = group.reviews.filter((review) => !review.decision).map((review) => review.job_id);
                const recommendedPending = group.reviews
                  .filter((review) => !review.decision && aiDecision(review) === 'approved')
                  .map((review) => review.job_id);
                return (
                  <Card key={group.id} className="overflow-hidden py-0">
                    <div className="flex flex-col gap-2 px-4 py-2.5 transition-colors hover:bg-muted/35 sm:flex-row sm:items-center">
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={isExpanded} onClick={() => setExpandedGroups((current) => toggleSetValue(current, group.id))}>
                        {isExpanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                        <span className="min-w-0 truncate font-semibold">{formatBatchTitle(group)}</span>
                        <Badge variant="outline" className="hidden sm:inline-flex">{pending.length ? 'Needs review' : 'Reviewed'}</Badge>
                      </button>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-7 text-xs tabular-nums text-muted-foreground sm:pl-0">
                        <span>{group.reviews.length} total</span>
                        <span className="text-red-700 dark:text-red-300">{red} red</span>
                        <span className="text-yellow-700 dark:text-yellow-300">{yellow} yellow</span>
                        <span className="text-emerald-700 dark:text-emerald-300">{green} green</span>
                        {isExpanded ? (
                          <Button type="button" size="xs" variant="outline" className="ml-1" disabled={!recommendedPending.length || bulkMutation.isPending} onClick={() => bulkMutation.mutate({ clientId: selectedPortal.client_id, jobIds: recommendedPending })}>
                            {bulkMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Check />}
                            Approve recommendations ({recommendedPending.length})
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {isExpanded ? (
                      <CardContent className="border-t bg-muted/15 p-3">
                        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(22rem,100%),1fr))] items-start gap-3">
                          {group.reviews.map((review) => (
                            <CreativeReviewCard
                              key={review.job_id}
                              clientId={selectedPortal.client_id}
                              isExpanded={expandedCreatives.has(review.job_id)}
                              isSaving={decisionMutation.isPending && decisionMutation.variables?.jobId === review.job_id}
                              review={review}
                              onDecide={(input) => decisionMutation.mutate({ clientId: selectedPortal.client_id, jobId: review.job_id, ...input })}
                              onPrefetch={() => prefetchCreative(review)}
                              onToggle={() => {
                                prefetchCreative(review);
                                setExpandedCreatives((current) => toggleSetValue(current, review.job_id));
                              }}
                            />
                          ))}
                        </div>
                      </CardContent>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-52 place-items-center rounded-xl border border-dashed bg-card p-6 text-center">
              <div className="grid max-w-sm gap-2">
                <FileText className="mx-auto size-7 text-muted-foreground" />
                <p className="font-medium">No creatives match the current filters</p>
                <p className="text-sm text-muted-foreground">Try changing the status, review state, or search.</p>
              </div>
            </div>
          )}
          {decisionMutation.error || bulkMutation.error ? <p role="alert" className="text-sm text-destructive">{errorMessage(decisionMutation.error ?? bulkMutation.error)}</p> : null}
        </div>
      ) : null}
    </ClientPortalFrame>
  );
}

function ClientPortalFrame({ activeClientId, children, counts, onSelectClient }: {
  activeClientId?: string;
  children: ReactNode;
  counts?: Map<string, number | undefined>;
  onSelectClient?: (clientId: string) => void;
}) {
  const { error, isSigningOut, logout, session } = useClientAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(CLIENT_SIDEBAR_OPEN_KEY) !== 'false';
  });
  const categories = useMemo(() => {
    const values = new Map<string, ClientPortalSummary[]>();
    for (const portal of session.portals) {
      const current = values.get(portal.category) ?? [];
      current.push(portal);
      values.set(portal.category, current);
    }
    return [...values.entries()];
  }, [session.portals]);

  useEffect(() => {
    window.localStorage.setItem(CLIENT_SIDEBAR_OPEN_KEY, String(sidebarOpen));
  }, [sidebarOpen]);

  function selectPortal(clientId: string) {
    window.sessionStorage.setItem(SELECTED_CLIENT_KEY, clientId);
    if (onSelectClient) onSelectClient(clientId);
    else void navigate({ to: '/client' });
  }

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="bg-muted/20 text-foreground">
      <Sidebar collapsible="icon">
        <SidebarHeader className="p-3 group-data-[collapsible=icon]:p-2">
          <div className="flex items-center gap-1">
            <Link to="/client" className="flex h-10 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-lg px-1.5 text-sidebar-foreground outline-none transition-[color,background-color,opacity] hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"><ScanSearch className="size-4" strokeWidth={2.2} /></span>
              <span className="grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-heading text-sm font-semibold">AdChecked</span>
                <span className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Creative reviews</span>
              </span>
            </Link>
            <SidebarTrigger className="md:hidden" aria-label="Close navigation" title="Close navigation" />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label="Client workspaces">
            {categories.map(([category, portals]) => (
              <SidebarGroup key={category}>
                <SidebarGroupLabel className="uppercase tracking-[0.12em]">{category}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                  {portals.map((portal) => (
                    <SidebarMenuItem key={portal.client_id}>
                      <SidebarMenuButton
                        isActive={activeClientId === portal.client_id}
                        tooltip={portal.display_name}
                        onClick={() => selectPortal(portal.client_id)}
                      >
                        <ShieldCheck />
                        <span>{portal.display_name}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge>{counts?.get(portal.client_id) ?? '—'}</SidebarMenuBadge>
                    </SidebarMenuItem>
                  ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>
        <SidebarFooter className="p-3 group-data-[collapsible=icon]:p-2">
          <div className="rounded-lg border border-sidebar-border bg-card/60 p-3 text-xs leading-5 group-data-[collapsible=icon]:hidden">
            <p className="font-medium">Signed in as {session.username}</p>
            <p className="text-muted-foreground">Client view</p>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Sign out" disabled={isSigningOut} onClick={() => void logout()}>
              {isSigningOut ? <LoaderCircle className="animate-spin" /> : <LogOut />}
                <span>{isSigningOut ? 'Signing out' : 'Sign out'}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {error ? <p role="alert" className="max-w-60 text-xs text-destructive group-data-[collapsible=icon]:hidden">{error}</p> : null}
        </SidebarFooter>
        <ClientSidebarBorderTrigger />
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0 bg-muted/20">
        <ClientMobileHeader />
        <main className="min-w-0 p-4 sm:p-5 xl:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function ClientMobileHeader() {
  const { openMobile } = useSidebar();
  const label = openMobile ? 'Close navigation' : 'Open navigation';

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur md:hidden">
      <SidebarTrigger className="-ml-1" aria-label={label} title={label} />
      <Link to="/client" className="flex items-center gap-2 font-heading text-sm font-semibold">
        <ScanSearch className="size-4" strokeWidth={2.2} />
        AdChecked
      </Link>
    </header>
  );
}

function ClientSidebarBorderTrigger() {
  const { open } = useSidebar();
  const label = open ? 'Collapse navigation' : 'Expand navigation';

  return (
    <SidebarTrigger
      className="absolute top-5 -right-3.5 z-30 hidden size-7 rounded-full border border-sidebar-border bg-background shadow-sm hover:bg-muted md:inline-flex"
      aria-label={label}
      title={`${label} (Ctrl+B)`}
    />
  );
}

function CreativeReviewCard({ clientId, isExpanded, isSaving, onDecide, onPrefetch, onToggle, review }: {
  clientId: string;
  isExpanded: boolean;
  isSaving: boolean;
  onDecide: (input: DecisionInput) => void;
  onPrefetch: () => void;
  onToggle: () => void;
  review: ClientReviewItem;
}) {
  const [draftDecision, setDraftDecision] = useState<Exclude<ClientDecisionValue, 'pending'> | null>(null);

  function chooseDecision(decision: ClientDecisionValue) {
    if (decision !== 'pending' && decision !== aiDecision(review)) {
      setDraftDecision(decision);
      if (!isExpanded) onToggle();
      return;
    }
    setDraftDecision(null);
    onDecide({ decision });
  }

  return (
    <article className={cn('self-start overflow-hidden rounded-xl border bg-card shadow-xs transition-colors', review.ai_status === 'yellow' && 'border-yellow-600/45', review.ai_status === 'red' && 'border-red-600/45', isExpanded && 'ring-1 ring-ring/30')} onFocusCapture={onPrefetch} onPointerEnter={onPrefetch}>
      <div className="flex items-center gap-2 p-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isExpanded} onClick={onToggle}>
          {isExpanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
          <span className="truncate text-sm font-medium" title={review.file_name}>{review.file_name}</span>
        </button>
        <select
          aria-label={`Decision for ${review.file_name}`}
          className={cn(
            'h-8 min-w-28 rounded-md border bg-background px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            review.decision?.decision === 'approved' && 'border-emerald-600/35 text-emerald-700 dark:text-emerald-300',
            review.decision?.decision === 'disapproved' && 'border-destructive/40 text-destructive'
          )}
          value={review.decision?.decision ?? 'pending'}
          disabled={isSaving}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => chooseDecision(event.currentTarget.value as ClientDecisionValue)}
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="disapproved">Disapproved</option>
        </select>
      </div>
      {draftDecision ? (
        <FeedbackForm
          decision={draftDecision}
          isSaving={isSaving}
          review={review}
          onCancel={() => setDraftDecision(null)}
          onSubmit={(feedbackReason, feedbackNote) => {
            onDecide({ decision: draftDecision, feedbackNote, feedbackReason });
            setDraftDecision(null);
          }}
        />
      ) : null}
      {isExpanded ? <InlineCreativeDetails clientId={clientId} review={review} /> : null}
    </article>
  );
}

function InlineCreativeDetails({ clientId, review }: { clientId: string; review: ClientReviewItem }) {
  const { preview } = review;
  return (
    <div className="grid gap-4 border-t bg-muted/10 p-3">
      <CreativeThumbnail alt={`Preview of ${review.file_name}`} className="h-64 w-full rounded-lg" clientId={clientId} jobId={review.job_id} />
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={review.ai_status} /><Badge variant="outline">{preview.finding_count} finding{preview.finding_count === 1 ? '' : 's'}</Badge></div>
        <p className="text-sm leading-6 text-muted-foreground">{preview.summary}</p>
        {review.decision?.feedback_note ? <p className="rounded-lg border bg-background/70 p-2 text-xs leading-5"><span className="font-semibold">Your note:</span> {review.decision.feedback_note}</p> : null}
      </div>
      <div className="grid gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Flags</p>
        {preview.findings.length ? (
          <ul className="grid gap-2">
            {preview.findings.map((finding, index) => <li key={`${review.job_id}-${index}`} className="border-l-2 border-yellow-500 pl-3 text-sm leading-5">{finding}</li>)}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No policy flags were found.</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {preview.google_drive_url ? <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={preview.google_drive_url} target="_blank" rel="noreferrer"><ExternalLink />Open in Drive</a> : null}
        <Link to="/client/$clientId/reviews/$jobId" params={{ clientId, jobId: review.job_id }} className={buttonVariants({ size: 'sm' })}><FileText />View full details</Link>
      </div>
    </div>
  );
}

function ClientReviewDetail() {
  const { clientId, jobId } = useParams({ from: '/client/$clientId/reviews/$jobId' });
  const { session } = useClientAuth();
  const queryClient = useQueryClient();
  const portal = session.portals.find((candidate) => candidate.client_id === clientId);
  const query = useQuery({
    queryKey: ['client', clientId, 'review', jobId],
    queryFn: () => getClientReview(clientId, jobId),
    enabled: Boolean(portal),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const decisionMutation = useMutation({
    mutationFn: ({ decision, feedbackNote, feedbackReason }: DecisionInput) => decideClientReview(
      clientId,
      jobId,
      decision,
      feedbackReason ? { note: feedbackNote, reason: feedbackReason } : undefined
    ),
    onSuccess: (decision) => {
      queryClient.setQueryData<ClientReviewDetail>(['client', clientId, 'review', jobId], (current) => current ? { ...current, review: { ...current.review, decision } } : current);
      updateReviewDecision(queryClient, clientId, jobId, decision);
    },
  });

  if (!portal) {
    return (
      <ClientPortalFrame activeClientId={clientId}>
        <Alert variant="destructive"><LockKeyhole /><AlertTitle>Review unavailable</AlertTitle><AlertDescription>You do not have access to this workspace.</AlertDescription><AlertAction><Link to="/client" className={buttonVariants({ variant: 'outline', size: 'xs' })}>Back to reviews</Link></AlertAction></Alert>
      </ClientPortalFrame>
    );
  }
  if (query.isLoading) return <ClientPortalFrame activeClientId={clientId}><div className="grid gap-4"><Skeleton className="h-36" /><Skeleton className="h-96" /></div></ClientPortalFrame>;
  if (!query.data) {
    return (
      <ClientPortalFrame activeClientId={clientId}>
        <Alert variant="destructive"><AlertCircle /><AlertTitle>Creative unavailable</AlertTitle><AlertDescription>{query.error ? errorMessage(query.error) : 'This creative could not be loaded.'}</AlertDescription><AlertAction><Link to="/client" className={buttonVariants({ variant: 'outline', size: 'xs' })}>Back to batches</Link></AlertAction></Alert>
      </ClientPortalFrame>
    );
  }

  const { evidence_frames: evidenceFrames, google_drive_url: googleDriveUrl, report, review } = query.data;
  return (
    <ClientPortalFrame activeClientId={clientId}>
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link to="/client" className={buttonVariants({ variant: 'outline', size: 'sm' })} onClick={() => window.sessionStorage.setItem(SELECTED_CLIENT_KEY, clientId)}>Back to batches</Link>
          <DecisionControl review={review} isSaving={decisionMutation.isPending} onDecide={(input) => decisionMutation.mutate(input)} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle as="h1" className="text-xl">{review.file_name}</CardTitle>
            <CardDescription>{formatDateTime(review.created_at)} · {mediaLabel(review.media_kind)}</CardDescription>
            <CardAction><AiRecommendation status={review.ai_status} /></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row">
            <CreativeThumbnail alt={`Preview of ${review.file_name}`} className="h-36 w-28 sm:h-40 sm:w-32" clientId={clientId} jobId={review.job_id} />
            <div className="grid content-start gap-3">
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{report.summary}</p>
              <div className="flex flex-wrap gap-2"><StatusBadge status={review.ai_status} /><Badge variant="outline">{report.findings.length} finding{report.findings.length === 1 ? '' : 's'}</Badge>{isClientOverride(review) ? <Badge variant="secondary">Different from recommendation</Badge> : null}</div>
              <div className="flex flex-wrap items-center gap-2">
                <ClientPdfDownloadButton clientId={clientId} jobId={jobId} />
                {googleDriveUrl ? <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={googleDriveUrl} target="_blank" rel="noreferrer"><ExternalLink />Open in Google Drive</a> : null}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Findings with evidence</CardTitle><CardDescription>Each finding is paired with the closest available creative frame.</CardDescription></CardHeader>
          <CardContent>
            {report.findings.length ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {report.findings.map((finding, index) => <FindingCard key={`${finding.source}-${finding.timestamp_start ?? 'none'}-${index}`} finding={finding} frame={nearestEvidenceFrame(evidenceFrames, finding.timestamp_start)} index={index + 1} jobId={jobId} clientId={clientId} />)}
              </div>
            ) : (
              <div className="grid min-h-40 place-items-center rounded-lg border border-emerald-600/25 bg-emerald-500/5 p-6 text-center"><div className="grid gap-2"><CheckCircle2 className="mx-auto size-7 text-emerald-600" /><p className="font-medium">No policy findings</p><p className="text-sm text-muted-foreground">AdChecked found no {portal.display_name} policy issue in this creative.</p></div></div>
            )}
          </CardContent>
        </Card>
        {decisionMutation.error ? <Alert variant="destructive"><AlertCircle /><AlertTitle>Decision not saved</AlertTitle><AlertDescription>{errorMessage(decisionMutation.error)}</AlertDescription></Alert> : null}
      </div>
    </ClientPortalFrame>
  );
}

function FindingCard({ clientId, finding, frame, index, jobId }: { clientId: string; finding: Finding; frame: ReviewEvidenceFrame | null; index: number; jobId: string }) {
  return (
    <article className="flex gap-3 rounded-xl border bg-card p-3">
      {frame ? <CreativeEvidenceImage alt={`Evidence frame for finding ${index}`} clientId={clientId} filename={frame.filename} jobId={jobId} /> : <span className="grid h-32 w-24 shrink-0 place-items-center rounded-lg border bg-muted/30 text-center text-[11px] font-medium text-muted-foreground sm:h-36 sm:w-28">{sourceLabel(finding.source)}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5"><Badge variant="outline">#{index}</Badge><SeverityBadge severity={finding.severity} /><Badge variant="outline">{sourceLabel(finding.source)}</Badge>{finding.timestamp_start ? <Badge variant="secondary">{formatTimestamp(finding.timestamp_start)}</Badge> : null}</div>
        <p className="mt-3 text-sm font-medium leading-5">{finding.evidence}</p>
        <div className="mt-3 grid gap-2 text-xs leading-5 text-muted-foreground"><p><span className="font-semibold text-foreground">Policy:</span> {finding.policy_reason}</p><p><span className="font-semibold text-foreground">Fix:</span> {finding.suggested_fix}</p></div>
      </div>
    </article>
  );
}

function FeedbackForm({ decision, isSaving, onCancel, onSubmit, review }: {
  decision: Exclude<ClientDecisionValue, 'pending'>;
  isSaving: boolean;
  onCancel: () => void;
  onSubmit: (reason: ClientFeedbackReason, note: string) => void;
  review: ClientReviewItem;
}) {
  const [reason, setReason] = useState<ClientFeedbackReason | ''>('');
  const [note, setNote] = useState('');
  const options = feedbackReasonOptions(decision);
  const noteRequired = reason ? isCalibrationReason(reason) : false;
  const canSubmit = Boolean(reason) && (!noteRequired || note.trim().length >= 3);

  useEffect(() => {
    setReason('');
    setNote('');
  }, [decision]);

  return (
    <form
      className="grid w-full max-w-xl gap-3 border-t bg-muted/20 p-3 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason || !canSubmit) return;
        onSubmit(reason, note.trim());
      }}
    >
      <div className="grid gap-1">
        <p className="text-sm font-semibold">Why are you choosing a different decision?</p>
        <p className="text-xs leading-5 text-muted-foreground">Choose the reason that best matches your decision.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`feedback-reason-${review.job_id}`}>Reason</Label>
        <select
          id={`feedback-reason-${review.job_id}`}
          className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value as ClientFeedbackReason | '')}
        >
          <option value="">Choose a reason</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`feedback-note-${review.job_id}`}>{noteRequired ? 'Additional details' : 'Additional details (optional)'}</Label>
        <Textarea
          id={`feedback-note-${review.job_id}`}
          maxLength={1000}
          placeholder={noteRequired ? 'Tell us what should be considered for this creative.' : 'Share any helpful context.'}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" disabled={isSaving} onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="xs" disabled={isSaving || !canSubmit}>{isSaving ? <LoaderCircle className="animate-spin" /> : <Check />}Save decision</Button>
      </div>
    </form>
  );
}

function DecisionControl({ isSaving, onDecide, review }: { isSaving: boolean; onDecide: (input: DecisionInput) => void; review: ClientReviewItem }) {
  const [draftDecision, setDraftDecision] = useState<Exclude<ClientDecisionValue, 'pending'> | null>(null);

  function chooseDecision(decision: Exclude<ClientDecisionValue, 'pending'>) {
    if (decision !== aiDecision(review)) {
      setDraftDecision(decision);
      return;
    }
    setDraftDecision(null);
    onDecide({ decision });
  }

  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button type="button" size="xs" variant={review.decision?.decision === 'approved' ? 'default' : 'outline'} disabled={isSaving} onClick={() => chooseDecision('approved')}>{isSaving ? <LoaderCircle className="animate-spin" /> : <Check />} Approve</Button>
        <Button type="button" size="xs" variant={review.decision?.decision === 'disapproved' ? 'destructive' : 'outline'} disabled={isSaving} onClick={() => chooseDecision('disapproved')}><X /> Disapprove</Button>
        {review.decision ? <Button type="button" size="xs" variant="ghost" disabled={isSaving} onClick={() => onDecide({ decision: 'pending' })}>Reset to pending</Button> : null}
        {isClientOverride(review) ? <Badge variant="secondary">Different from recommendation</Badge> : null}
      </div>
      {draftDecision ? (
        <FeedbackForm
          decision={draftDecision}
          isSaving={isSaving}
          review={review}
          onCancel={() => setDraftDecision(null)}
          onSubmit={(feedbackReason, feedbackNote) => {
            onDecide({ decision: draftDecision, feedbackNote, feedbackReason });
            setDraftDecision(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ClientPdfDownloadButton({ clientId, jobId }: { clientId: string; jobId: string }) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    if (isDownloading) return;
    setIsDownloading(true);
    setError('');
    try {
      const { blob, filename } = await fetchClientReviewPdf(clientId, jobId);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsDownloading(false);
    }
  }
  return <div className="grid gap-1"><Button type="button" size="sm" disabled={isDownloading} onClick={() => void download()}>{isDownloading ? <LoaderCircle className="animate-spin" /> : <Download />}{isDownloading ? 'Preparing report' : 'Download report'}</Button>{error ? <span role="alert" className="max-w-72 text-xs text-destructive">{error}</span> : null}</div>;
}

function CompactFilterMenu<T extends string>({ icon, label, onChange, options, value }: {
  icon: ReactNode;
  label: string;
  onChange: (value: T) => void;
  options: { count: number; label: string; value: T }[];
  value: T;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(buttonVariants({ size: 'sm', variant: value === options[0]?.value ? 'outline' : 'secondary' }), 'shrink-0')}
        aria-label={`${label}: ${selected?.label ?? ''}`}
      >
        {icon}
        <span className="hidden text-muted-foreground xl:inline">{label}</span>
        <span>{selected?.label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{selected?.count}</span>
        <ChevronDown />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
          <Menu.Popup className="min-w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg outline-none">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Filter by {label.toLocaleLowerCase()}</div>
            {options.map((option) => (
              <Menu.Item
                key={option.value}
                closeOnClick
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                onClick={() => onChange(option.value)}
              >
                <span className="flex-1 font-medium">{option.label}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{option.count}</span>
                <Check className={cn('size-4 text-primary', option.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function MetricBadge({ label, tone = 'neutral', value }: { label: string; tone?: 'danger' | 'neutral' | 'success' | 'warning'; value: number }) {
  return <Badge variant="outline" className={cn('px-2.5 py-1 tabular-nums', tone === 'danger' && 'border-red-600/35 bg-red-500/10 text-red-700 dark:text-red-300', tone === 'warning' && 'border-yellow-600/35 bg-yellow-400/10 text-yellow-700 dark:text-yellow-300', tone === 'success' && 'border-emerald-600/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}>{value} {label}</Badge>;
}

function AiRecommendation({ status }: { status: OverallStatus }) {
  const approved = status !== 'red';
  return <Badge className={cn(status === 'yellow' && 'border-yellow-600/30 bg-yellow-400/15 text-yellow-700 dark:text-yellow-300')} variant={status === 'red' ? 'destructive' : status === 'green' ? 'secondary' : 'outline'}>{approved ? <CheckCircle2 /> : <XCircle />}{approved ? 'Approve' : 'Disapprove'}</Badge>;
}

function StatusBadge({ status }: { status: OverallStatus }) {
  return <Badge className={cn(status === 'green' && 'border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', status === 'yellow' && 'border-yellow-600/30 bg-yellow-400/15 text-yellow-700 dark:text-yellow-300', status === 'red' && 'border-red-600/30 bg-red-500/15 text-red-700 dark:text-red-300')} variant="outline">{statusLabel(status)}</Badge>;
}

function SeverityBadge({ severity }: { severity: Finding['severity'] }) {
  return <Badge variant={severity === 'high' ? 'destructive' : 'secondary'}>{capitalize(severity)}</Badge>;
}

function useClientAuth() {
  const value = useContext(ClientAuthContext);
  if (!value) throw new Error('Client portal authentication is unavailable.');
  return value;
}

function groupReviews(reviews: ClientReviewItem[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const review of reviews) {
    const dateKey = new Date(review.created_at).toISOString().slice(0, 10);
    const id = review.batch_id ? `batch:${review.batch_id}` : `individual:${dateKey}`;
    const existing = groups.get(id);
    const createdAt = review.batch_id ? review.batch_created_at : review.created_at;
    if (existing) {
      existing.reviews.push(review);
      if (!review.batch_id) existing.createdAt = Math.max(existing.createdAt, createdAt);
    } else {
      groups.set(id, { createdAt, id, kind: review.batch_id ? 'batch' : 'individual', label: review.batch_source_label, reviews: [review] });
    }
  }
  return [...groups.values()].map((group) => ({ ...group, reviews: group.reviews.sort((left, right) => right.created_at - left.created_at) })).sort((left, right) => right.createdAt - left.createdAt);
}

function updateReviewDecision(queryClient: ReturnType<typeof useQueryClient>, clientId: string, jobId: string, decision: ClientReviewItem['decision']) {
  queryClient.setQueryData<ClientReviewList>(['client', clientId, 'reviews'], (current) => current ? { ...current, reviews: current.reviews.map((review) => review.job_id === jobId ? { ...review, decision } : review) } : current);
}

function nearestEvidenceFrame(frames: ReviewEvidenceFrame[], timestamp: string | null | undefined): ReviewEvidenceFrame | null {
  if (!frames.length) return null;
  const target = parseTimestampSeconds(timestamp);
  if (target === null || Number.isNaN(target)) return frames[0] ?? null;
  return frames.reduce((nearest, frame) => {
    if (frame.timestamp === null) return nearest;
    if (!nearest || nearest.timestamp === null) return frame;
    return Math.abs(frame.timestamp - target) < Math.abs(nearest.timestamp - target) ? frame : nearest;
  }, null as ReviewEvidenceFrame | null) ?? frames[0] ?? null;
}

function decisionStatus(review: ClientReviewItem): StatusFilter {
  return review.decision?.decision ?? 'pending';
}

function aiDecision(review: ClientReviewItem): Exclude<ClientDecisionValue, 'pending'> {
  return review.ai_status === 'red' ? 'disapproved' : 'approved';
}

function isClientOverride(review: ClientReviewItem) {
  if (!review.decision) return false;
  return review.decision.decision !== aiDecision(review);
}

function isCalibrationReason(reason: ClientFeedbackReason) {
  return reason === 'false_positive' || reason === 'missed_policy_issue' || reason === 'partner_preference';
}

function feedbackReasonOptions(decision: Exclude<ClientDecisionValue, 'pending'>): { label: string; value: ClientFeedbackReason }[] {
  if (decision === 'approved') {
    return [
      { label: 'AdChecked was too strict', value: 'false_positive' },
      { label: 'Use this preference for similar creatives', value: 'partner_preference' },
      { label: 'Approve this creative as an exception', value: 'one_off_exception' },
      { label: 'Business decision', value: 'business_decision' },
    ];
  }
  return [
    { label: 'AdChecked missed a policy issue', value: 'missed_policy_issue' },
    { label: 'Use this preference for similar creatives', value: 'partner_preference' },
    { label: 'Business decision', value: 'business_decision' },
  ];
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

function formatBatchTitle(group: ReviewGroup) {
  if (group.label) return group.label;
  const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(group.createdAt));
  return `${date} · ${group.kind === 'batch' ? 'Batch' : 'Individual reviews'}`;
}

function mediaLabel(value: ClientReviewItem['media_kind']) {
  if (value === 'video') return 'Video creative';
  if (value === 'image') return 'Image creative';
  return 'Ad copy';
}

function statusLabel(status: OverallStatus) {
  if (status === 'green') return 'Green';
  if (status === 'yellow') return 'Yellow';
  return 'Red';
}

function sourceLabel(source: Finding['source']) {
  if (source === 'ad_copy') return 'Ad copy';
  if (source === 'audio') return 'Audio';
  if (source === 'onscreen_text') return 'On-screen text';
  if (source === 'visual') return 'Visual';
  return 'Policy';
}

function formatDateTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatTimestamp(value: string) {
  const seconds = parseTimestampSeconds(value);
  if (seconds === null || Number.isNaN(seconds)) return value;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function parseTimestampSeconds(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
