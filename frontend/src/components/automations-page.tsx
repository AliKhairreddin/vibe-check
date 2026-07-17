import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  FolderSearch,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import {
  deleteReviewAutomation,
  listReviewAutomations,
  runReviewAutomation,
  saveReviewAutomation,
  type ReviewAutomation,
  type ReviewAutomationInput,
} from '@/lib/api';

const AUTOMATIONS_QUERY_KEY = ['automations'] as const;
const AUTOMATION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
const DAYS = [
  { value: 0, label: 'Mon' },
  { value: 1, label: 'Tue' },
  { value: 2, label: 'Wed' },
  { value: 3, label: 'Thu' },
  { value: 4, label: 'Fri' },
  { value: 5, label: 'Sat' },
  { value: 6, label: 'Sun' },
] as const;

function emptyDraft(): ReviewAutomation {
  return {
    automation_id: '',
    name: '',
    enabled: false,
    folder_id: '',
    file_name_pattern: '*',
    time_of_day: '09:00',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    days_of_week: [0, 1, 2, 3, 4],
    include_subfolders: true,
    created_at: null,
    updated_at: null,
    last_run_at: null,
    last_run_status: null,
    last_run_message: null,
    last_batch_id: null,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function AutomationsPage() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ReviewAutomation | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const query = useQuery({
    queryKey: AUTOMATIONS_QUERY_KEY,
    queryFn: listReviewAutomations,
  });
  const automations = useMemo(
    () => [...(query.data ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    [query.data]
  );
  const activeCount = automations.filter((automation) => automation.enabled).length;

  useEffect(() => {
    if (draft || isCreating || !automations.length) return;
    setDraft({ ...automations[0], days_of_week: [...automations[0].days_of_week] });
    setSelectedId(automations[0].automation_id);
  }, [automations, draft, isCreating]);

  function updateCached(automation: ReviewAutomation) {
    queryClient.setQueryData<ReviewAutomation[]>(AUTOMATIONS_QUERY_KEY, (current = []) => {
      const next = current.filter((item) => item.automation_id !== automation.automation_id);
      next.push(automation);
      return next.sort((left, right) => left.name.localeCompare(right.name));
    });
  }

  const saveMutation = useMutation({
    mutationFn: ({ automationId, input }: { automationId: string; input: ReviewAutomationInput }) =>
      saveReviewAutomation(automationId, input),
    onSuccess: (automation) => {
      updateCached(automation);
      setDraft({ ...automation, days_of_week: [...automation.days_of_week] });
      setSelectedId(automation.automation_id);
      setIsCreating(false);
      setIsDirty(false);
      setFormError('');
      setNotice(`${automation.name} was saved${automation.enabled ? ' and is active' : ' as inactive'}.`);
    },
    onError: (error) => {
      setNotice('');
      setFormError(errorMessage(error));
    },
  });
  const deleteMutation = useMutation({
    mutationFn: deleteReviewAutomation,
    onSuccess: (_result, automationId) => {
      queryClient.setQueryData<ReviewAutomation[]>(AUTOMATIONS_QUERY_KEY, (current = []) =>
        current.filter((item) => item.automation_id !== automationId)
      );
      setDraft(null);
      setSelectedId('');
      setIsCreating(false);
      setIsDirty(false);
      setFormError('');
      setNotice('Automation deleted.');
    },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const runMutation = useMutation({
    mutationFn: runReviewAutomation,
    onSuccess: (result) => {
      const automation = result.automation;
      updateCached(automation);
      setDraft({ ...automation, days_of_week: [...automation.days_of_week] });
      if (result.status === 'failed') {
        setNotice('');
        setFormError(result.message || `${automation.name} could not complete its manual check.`);
      } else {
        setNotice(result.message || `${automation.name} finished its manual check.`);
        setFormError('');
      }
    },
    onError: (error) => {
      setNotice('');
      setFormError(errorMessage(error));
    },
  });
  const isMutating = saveMutation.isPending || deleteMutation.isPending || runMutation.isPending;

  function confirmDiscard() {
    return !isDirty || window.confirm('Discard the unsaved automation changes?');
  }

  function startNew() {
    if (!confirmDiscard()) return;
    setDraft(emptyDraft());
    setSelectedId('');
    setIsCreating(true);
    setIsDirty(false);
    setFormError('');
    setNotice('');
  }

  function selectAutomation(automation: ReviewAutomation) {
    if (!confirmDiscard()) return;
    setDraft({ ...automation, days_of_week: [...automation.days_of_week] });
    setSelectedId(automation.automation_id);
    setIsCreating(false);
    setIsDirty(false);
    setFormError('');
    setNotice('');
  }

  function updateDraft(patch: Partial<ReviewAutomation>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setIsDirty(true);
    setNotice('');
    setFormError('');
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const automationId = draft.automation_id.trim().toLocaleLowerCase();
    if (!AUTOMATION_ID_PATTERN.test(automationId)) {
      setFormError('Automation ID must be a lowercase slug of 1–80 letters, numbers, hyphens, or underscores.');
      return;
    }
    if (isCreating && automations.some((automation) => automation.automation_id === automationId)) {
      setFormError(`An automation with the ID “${automationId}” already exists.`);
      return;
    }
    if (!draft.name.trim()) {
      setFormError('Automation name is required.');
      return;
    }
    if (!draft.folder_id.trim()) {
      setFormError('Google Drive folder ID is required.');
      return;
    }
    if (!draft.days_of_week.length) {
      setFormError('Choose at least one day to run.');
      return;
    }
    saveMutation.mutate({
      automationId,
      input: {
        name: draft.name.trim(),
        enabled: draft.enabled,
        folder_id: draft.folder_id.trim(),
        file_name_pattern: draft.file_name_pattern.trim() || '*',
        time_of_day: draft.time_of_day,
        timezone: draft.timezone.trim() || 'UTC',
        days_of_week: [...draft.days_of_week].sort((left, right) => left - right),
        include_subfolders: draft.include_subfolders,
      },
    });
  }

  function removeCurrent() {
    if (!draft || isCreating) return;
    if (!window.confirm(`Delete ${draft.name}? This cannot be undone.`)) return;
    deleteMutation.mutate(draft.automation_id);
  }

  function runCurrent() {
    if (!draft || isCreating || isDirty) return;
    if (!window.confirm(`Run ${draft.name} now and review any matching creatives?`)) return;
    runMutation.mutate(draft.automation_id);
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-4">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-1">
          <p className="text-sm font-medium text-muted-foreground">Scheduled reviews</p>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Automations</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Check a Google Drive folder on a schedule and automatically review matching creatives.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={startNew} disabled={isMutating}>
          <Plus />
          New automation
        </Button>
      </section>

      <Alert>
        <CalendarClock />
        <AlertTitle>
          {activeCount
            ? `${activeCount} automation${activeCount === 1 ? ' is' : 's are'} active`
            : 'Nothing is scheduled automatically'}
        </AlertTitle>
        <AlertDescription>
          {activeCount
            ? 'Active schedules check their saved Drive folders at the configured local time.'
            : 'New automation drafts start turned off. Saving a draft does not create a schedule until you explicitly enable it.'}
        </AlertDescription>
      </Alert>

      {query.error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Automations unavailable</AlertTitle>
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
          <AlertAction>
            <Button type="button" variant="outline" size="xs" onClick={() => void query.refetch()}>
              <RefreshCw /> Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {query.isLoading ? (
        <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <Skeleton className="h-40" />
          <Skeleton className="h-[34rem]" />
        </div>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <Card size="sm" className="md:sticky md:top-8">
            <CardHeader>
              <CardTitle>Saved automations</CardTitle>
              <CardDescription>{automations.length} configured</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {automations.map((automation) => (
                <Button
                  key={automation.automation_id}
                  type="button"
                  variant={selectedId === automation.automation_id && !isCreating ? 'secondary' : 'ghost'}
                  className="h-auto min-h-10 justify-start px-3 py-2 text-left"
                  onClick={() => selectAutomation(automation)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{automation.name}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {automation.time_of_day} · {automation.timezone}
                    </span>
                  </span>
                  <Badge variant={automation.enabled ? 'secondary' : 'outline'}>
                    {automation.enabled ? 'On' : 'Off'}
                  </Badge>
                </Button>
              ))}
              {isCreating ? (
                <Button type="button" variant="secondary" className="justify-start">
                  <Plus /> Unsaved automation
                </Button>
              ) : null}
              {!automations.length && !isCreating ? (
                <div className="grid gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  <p>No automations have been saved.</p>
                  <Button type="button" variant="outline" size="sm" onClick={startNew}>
                    <Plus /> Create one
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {draft ? (
            <Card>
              <CardHeader>
                <CardTitle>{isCreating ? 'New automation' : draft.name}</CardTitle>
                <CardDescription>
                  {isCreating ? 'Configure the schedule and save it as inactive.' : `Automation ID: ${draft.automation_id}`}
                </CardDescription>
                <CardAction>
                  <Badge variant={draft.enabled ? 'secondary' : 'outline'}>{draft.enabled ? 'Active' : 'Inactive'}</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <form className="grid gap-5" onSubmit={submit} aria-busy={isMutating}>
                  {notice ? (
                    <Alert role="status" aria-live="polite">
                      <CheckCircle2 />
                      <AlertTitle>Automation updated</AlertTitle>
                      <AlertDescription>{notice}</AlertDescription>
                    </Alert>
                  ) : null}
                  {formError ? (
                    <Alert variant="destructive">
                      <AlertCircle />
                      <AlertTitle>Automation action failed</AlertTitle>
                      <AlertDescription>{formError}</AlertDescription>
                    </Alert>
                  ) : null}

                  <div className="grid gap-4 sm:grid-cols-2">
                    {isCreating ? (
                      <Field label="Automation ID" htmlFor="automation-id">
                        <Input
                          id="automation-id"
                          value={draft.automation_id}
                          placeholder="daily-creative-review"
                          maxLength={80}
                          required
                          onChange={(event) => updateDraft({ automation_id: event.currentTarget.value.toLocaleLowerCase() })}
                        />
                      </Field>
                    ) : null}
                    <Field label="Name" htmlFor="automation-name">
                      <Input
                        id="automation-name"
                        value={draft.name}
                        placeholder="Weekday creative folder"
                        maxLength={160}
                        required
                        onChange={(event) => updateDraft({ name: event.currentTarget.value })}
                      />
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Google Drive folder ID" htmlFor="automation-folder">
                      <Input
                        id="automation-folder"
                        value={draft.folder_id}
                        placeholder="1AbC…"
                        required
                        onChange={(event) => updateDraft({ folder_id: event.currentTarget.value })}
                      />
                    </Field>
                    <Field label="File name pattern (optional)" htmlFor="automation-pattern">
                      <Input
                        id="automation-pattern"
                        value={draft.file_name_pattern}
                        placeholder="creative-{date}*.mp4"
                        onChange={(event) => updateDraft({ file_name_pattern: event.currentTarget.value })}
                      />
                      <p className="text-xs leading-5 text-muted-foreground">
                        Supports * and ? wildcards plus {'{date}'}, {'{YYYY}'}, {'{MM}'}, and {'{DD}'} date tokens.
                      </p>
                    </Field>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Time of day" htmlFor="automation-time">
                      <Input
                        id="automation-time"
                        type="time"
                        value={draft.time_of_day}
                        required
                        onChange={(event) => updateDraft({ time_of_day: event.currentTarget.value })}
                      />
                    </Field>
                    <Field label="Timezone" htmlFor="automation-timezone">
                      <Input
                        id="automation-timezone"
                        value={draft.timezone}
                        placeholder="America/Toronto"
                        required
                        onChange={(event) => updateDraft({ timezone: event.currentTarget.value })}
                      />
                    </Field>
                  </div>

                  <fieldset className="grid gap-2">
                    <legend className="text-sm font-medium">Days to run</legend>
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                      {DAYS.map((day) => {
                        const selected = draft.days_of_week.includes(day.value);
                        return (
                          <Button
                            key={day.value}
                            type="button"
                            variant={selected ? 'secondary' : 'outline'}
                            aria-pressed={selected}
                            onClick={() => updateDraft({
                              days_of_week: selected
                                ? draft.days_of_week.filter((value) => value !== day.value)
                                : [...draft.days_of_week, day.value],
                            })}
                          >
                            {day.label}
                          </Button>
                        );
                      })}
                    </div>
                  </fieldset>

                  <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
                    <ToggleRow
                      id="automation-subfolders"
                      label="Include subfolders"
                      description="Review matching files nested inside this Drive folder."
                      checked={draft.include_subfolders}
                      onCheckedChange={(checked) => updateDraft({ include_subfolders: checked })}
                    />
                    <ToggleRow
                      id="automation-enabled"
                      label="Automation active"
                      description="Run on the saved schedule. New drafts start off."
                      checked={draft.enabled}
                      onCheckedChange={(checked) => updateDraft({ enabled: checked })}
                    />
                  </div>

                  {!isCreating ? (
                    <div className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Last run</p>
                        <p>{draft.last_run_at ? formatDateTime(draft.last_run_at) : 'Never'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Status</p>
                        <p>{draft.last_run_status || 'No run yet'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Last batch</p>
                        {draft.last_batch_id ? (
                          <a className="font-medium underline underline-offset-4" href={`/batches/${draft.last_batch_id}`}>
                            Open batch
                          </a>
                        ) : <p>None</p>}
                      </div>
                      {draft.last_run_message ? (
                        <p className="text-muted-foreground sm:col-span-3">{draft.last_run_message}</p>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap gap-2">
                      {!isCreating ? (
                        <Button type="button" variant="destructive" onClick={removeCurrent} disabled={isMutating}>
                          <Trash2 /> Delete
                        </Button>
                      ) : null}
                      {!isCreating ? (
                        <Button type="button" variant="outline" onClick={runCurrent} disabled={isMutating || isDirty}>
                          {runMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}
                          Run now
                        </Button>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-end gap-3">
                      <span className="text-xs text-muted-foreground" aria-live="polite">
                        {isCreating && !isDirty
                          ? 'Not saved yet'
                          : isDirty ? 'Unsaved changes' : 'All changes saved'}
                      </span>
                      <Button type="submit" disabled={isMutating || !isDirty}>
                        {saveMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
                        {saveMutation.isPending ? 'Saving' : 'Save automation'}
                      </Button>
                    </div>
                  </div>
                </form>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="grid min-h-80 place-items-center p-6 text-center">
                <div className="grid max-w-sm gap-2">
                  <FolderSearch className="mx-auto size-8 text-muted-foreground" />
                  <p className="font-medium">No automation selected</p>
                  <p className="text-sm text-muted-foreground">
                    Create a disabled schedule now, then enable it when the Drive folder and timing are ready.
                  </p>
                  <Button type="button" variant="outline" className="mx-auto" onClick={startNew}>
                    <Plus /> New automation
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ children, htmlFor, label }: { children: React.ReactNode; htmlFor: string; label: string }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function ToggleRow({
  checked,
  description,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  description: string;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

export default AutomationsPage;
