import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  FileUp,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
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
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  disableOfferProfile,
  listOfferProfiles,
  saveOfferProfile,
  type OfferOverride,
  type OfferProfile,
  type OfferProfileInput,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const OFFER_PROFILES_QUERY_KEY = ['offer-profiles'] as const;
const OFFER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
const MAX_GUIDELINES_LENGTH = 200_000;

let nextDraftKey = 0;

type DraftOverride = OfferOverride & { client_key: string };
type DraftProfile = Omit<OfferProfile, 'internal_overrides'> & {
  internal_overrides: DraftOverride[];
};

type SaveVariables = {
  offerId: string;
  input: OfferProfileInput;
};

function newDraftKey() {
  nextDraftKey += 1;
  return `offer-draft-${nextDraftKey}`;
}

function profileToDraft(profile: OfferProfile): DraftProfile {
  return {
    ...profile,
    internal_overrides: profile.internal_overrides.map((override) => ({
      ...override,
      client_key: newDraftKey(),
    })),
  };
}

function emptyOfferDraft(): DraftProfile {
  return {
    offer_id: '',
    display_name: '',
    official_guidelines: '',
    internal_overrides: [],
    enabled: false,
    is_default: false,
    version: 0,
    created_at: null,
    updated_at: null,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sortedProfiles(profiles: OfferProfile[]) {
  return [...profiles].sort((left, right) => {
    if (left.is_default !== right.is_default) return left.is_default ? -1 : 1;
    return left.display_name.localeCompare(right.display_name);
  });
}

export function OfferSettingsPanel() {
  const queryClient = useQueryClient();
  const fieldPrefix = useId().replace(/:/g, '');
  const [selectedOfferId, setSelectedOfferId] = useState('');
  const [draft, setDraft] = useState<DraftProfile | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');

  const profilesQuery = useQuery({
    queryKey: OFFER_PROFILES_QUERY_KEY,
    queryFn: listOfferProfiles,
  });
  const profiles = profilesQuery.data ?? [];

  useEffect(() => {
    if (draft || isCreating || !profiles.length) return;
    const initial = profiles.find((profile) => profile.is_default)
      ?? profiles.find((profile) => profile.offer_id === 'acp')
      ?? profiles[0];
    setSelectedOfferId(initial.offer_id);
    setDraft(profileToDraft(initial));
  }, [draft, isCreating, profiles]);

  function updateCachedProfile(profile: OfferProfile) {
    queryClient.setQueryData<OfferProfile[]>(OFFER_PROFILES_QUERY_KEY, (current = []) => {
      const next = current.map((item) => {
        if (item.offer_id === profile.offer_id) return profile;
        return profile.is_default ? { ...item, is_default: false } : item;
      });
      if (!next.some((item) => item.offer_id === profile.offer_id)) next.push(profile);
      return sortedProfiles(next);
    });
  }

  const saveMutation = useMutation({
    mutationFn: ({ offerId, input }: SaveVariables) => saveOfferProfile(offerId, input),
    onSuccess: (profile) => {
      updateCachedProfile(profile);
      void queryClient.invalidateQueries({ queryKey: ['offers'] });
      void queryClient.invalidateQueries({ queryKey: ['reviews', 'stats'] });
      setSelectedOfferId(profile.offer_id);
      setDraft(profileToDraft(profile));
      setIsCreating(false);
      setIsDirty(false);
      setFormError('');
      setNotice(`${profile.display_name} was saved as version ${profile.version}.`);
    },
    onError: (error) => {
      setNotice('');
      setFormError(errorMessage(error));
    },
  });

  const disableMutation = useMutation({
    mutationFn: disableOfferProfile,
    onSuccess: (profile) => {
      updateCachedProfile(profile);
      void queryClient.invalidateQueries({ queryKey: ['offers'] });
      void queryClient.invalidateQueries({ queryKey: ['reviews', 'stats'] });
      setDraft(profileToDraft(profile));
      setIsDirty(false);
      setFormError('');
      setNotice(`${profile.display_name} is disabled for new reviews.`);
    },
    onError: (error) => {
      setNotice('');
      setFormError(errorMessage(error));
    },
  });
  const isMutating = saveMutation.isPending || disableMutation.isPending;

  function confirmDiscardChanges() {
    return !isDirty || window.confirm('Discard the unsaved changes to this offer?');
  }

  function selectProfile(profile: OfferProfile) {
    if (isMutating) return;
    if (!confirmDiscardChanges()) return;
    setSelectedOfferId(profile.offer_id);
    setDraft(profileToDraft(profile));
    setIsCreating(false);
    setIsDirty(false);
    setFormError('');
    setNotice('');
  }

  function startNewOffer() {
    if (isMutating) return;
    if (!confirmDiscardChanges()) return;
    setSelectedOfferId('');
    setDraft(emptyOfferDraft());
    setIsCreating(true);
    setIsDirty(false);
    setFormError('');
    setNotice('');
  }

  function updateDraft(update: (current: DraftProfile) => DraftProfile) {
    setDraft((current) => current ? update(current) : current);
    setIsDirty(true);
    setFormError('');
    setNotice('');
  }

  function updateOverride(clientKey: string, patch: Partial<DraftOverride>) {
    updateDraft((current) => ({
      ...current,
      internal_overrides: current.internal_overrides.map((override) =>
        override.client_key === clientKey ? { ...override, ...patch } : override
      ),
    }));
  }

  function addOverride() {
    updateDraft((current) => ({
      ...current,
      internal_overrides: [
        ...current.internal_overrides,
        {
          client_key: newDraftKey(),
          override_id: '',
          title: '',
          guidance: '',
          rationale: '',
          enabled: true,
        },
      ],
    }));
  }

  function removeOverride(clientKey: string) {
    updateDraft((current) => ({
      ...current,
      internal_overrides: current.internal_overrides.filter(
        (override) => override.client_key !== clientKey
      ),
    }));
  }

  async function importGuidelines(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const lowerName = file.name.toLocaleLowerCase();
      if (!lowerName.endsWith('.txt') && !lowerName.endsWith('.md')) {
        throw new Error('Choose a .txt or .md guidelines file.');
      }
      const text = await file.text();
      if (text.length > MAX_GUIDELINES_LENGTH) {
        throw new Error('Guidelines must be 200,000 characters or fewer.');
      }
      if (!text.trim()) throw new Error('The selected guidelines file is empty.');
      updateDraft((current) => ({ ...current, official_guidelines: text }));
      setNotice(`Imported ${file.name}. Save the offer to publish this text.`);
    } catch (error) {
      setNotice('');
      setFormError(errorMessage(error));
    } finally {
      input.value = '';
    }
  }

  function validateDraft(current: DraftProfile) {
    const offerId = current.offer_id.trim().toLocaleLowerCase();
    if (!OFFER_ID_PATTERN.test(offerId)) {
      return 'Offer ID must be a lowercase slug of 1–80 letters, numbers, hyphens, or underscores.';
    }
    if (isCreating && profiles.some((profile) => profile.offer_id === offerId)) {
      return `An offer with the ID “${offerId}” already exists.`;
    }
    if (!current.display_name.trim()) return 'Display name is required.';
    if (current.enabled && !current.official_guidelines.trim()) {
      return 'Add official guidelines before enabling this offer.';
    }
    if (current.official_guidelines.length > MAX_GUIDELINES_LENGTH) {
      return 'Guidelines must be 200,000 characters or fewer.';
    }

    const overrideIds = new Set<string>();
    for (const [index, override] of current.internal_overrides.entries()) {
      const overrideId = override.override_id.trim().toLocaleLowerCase();
      if (!OFFER_ID_PATTERN.test(overrideId)) {
        return `Override ${index + 1} needs a lowercase slug ID.`;
      }
      if (overrideIds.has(overrideId)) return `Override ID “${overrideId}” is duplicated.`;
      overrideIds.add(overrideId);
      if (!override.title.trim()) return `Override ${index + 1} needs a title.`;
      if (!override.guidance.trim()) return `Override ${index + 1} needs guidance.`;
    }
    return '';
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const validationError = validateDraft(draft);
    if (validationError) {
      setNotice('');
      setFormError(validationError);
      return;
    }

    const offerId = draft.offer_id.trim().toLocaleLowerCase();
    const enabled = draft.enabled && Boolean(draft.official_guidelines.trim());
    saveMutation.mutate({
      offerId,
      input: {
        display_name: draft.display_name.trim(),
        official_guidelines: draft.official_guidelines.trim(),
        internal_overrides: draft.internal_overrides.map((override) => ({
          override_id: override.override_id.trim().toLocaleLowerCase(),
          title: override.title.trim(),
          guidance: override.guidance.trim(),
          rationale: override.rationale.trim(),
          enabled: override.enabled,
        })),
        enabled,
        is_default: enabled ? draft.is_default : false,
      },
    });
  }

  function disableCurrentOffer() {
    if (!draft) return;
    if (!window.confirm(`Disable ${draft.display_name} for new reviews? Existing reports remain unchanged.`)) {
      return;
    }
    disableMutation.mutate(draft.offer_id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Offer profiles</CardTitle>
        <CardDescription>
          Maintain official guidelines and internal review exceptions separately for every offer.
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isMutating}
            onClick={startNewOffer}
          >
            <Plus />
            New offer
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Alert>
          <ShieldCheck />
          <AlertTitle>Official findings always remain visible</AlertTitle>
          <AlertDescription>
            Internal overrides annotate how your team treats a finding; they never edit the
            official guidelines or remove the violation. Every override applies only to the
            offer where it is saved.
          </AlertDescription>
        </Alert>

        {profilesQuery.error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Offer profiles could not be loaded</AlertTitle>
            <AlertDescription>{errorMessage(profilesQuery.error)}</AlertDescription>
            <AlertAction>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={profilesQuery.isFetching}
                onClick={() => void profilesQuery.refetch()}
              >
                <RefreshCw />
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {profilesQuery.isLoading ? (
          <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
            <div className="grid content-start gap-2">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
            <div className="grid gap-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-64" />
            </div>
          </div>
        ) : (
          <div className="grid items-start gap-5 md:grid-cols-[14rem_minmax(0,1fr)]">
            <nav aria-label="Offer profiles" className="grid gap-2 md:sticky md:top-24">
              {profiles.map((profile) => (
                <Button
                  key={profile.offer_id}
                  type="button"
                  variant={selectedOfferId === profile.offer_id && !isCreating ? 'secondary' : 'ghost'}
                  className="h-auto min-h-10 w-full justify-start px-3 py-2 text-left"
                  aria-current={selectedOfferId === profile.offer_id && !isCreating ? 'page' : undefined}
                  disabled={isMutating}
                  onClick={() => selectProfile(profile)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{profile.display_name}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      {profile.offer_id}
                    </span>
                  </span>
                  {!profile.enabled ? <Badge variant="outline">Off</Badge> : null}
                </Button>
              ))}
              {isCreating ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="h-auto min-h-10 justify-start px-3 py-2"
                  disabled={isMutating}
                >
                  <Plus />
                  Unsaved offer
                </Button>
              ) : null}
              {!profiles.length && !isCreating ? (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  No saved offers were returned. Create one to get started.
                </p>
              ) : null}
            </nav>

            {draft ? (
              <form className="grid min-w-0 gap-5" onSubmit={submit} aria-busy={isMutating}>
                <fieldset disabled={isMutating} className="contents">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <h3 className="font-heading text-lg font-medium">
                      {isCreating ? 'Create offer' : draft.display_name}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {isCreating
                        ? 'Choose a stable ID. It cannot be renamed after the offer is saved.'
                        : `Offer ID: ${draft.offer_id} · Version ${draft.version}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {draft.is_default ? <Badge variant="secondary">Default</Badge> : null}
                    <Badge variant={draft.enabled ? 'outline' : 'destructive'}>
                      {draft.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                </div>

                {notice ? (
                  <Alert role="status" aria-live="polite">
                    <CheckCircle2 />
                    <AlertTitle>Settings updated</AlertTitle>
                    <AlertDescription>{notice}</AlertDescription>
                  </Alert>
                ) : null}
                {formError ? (
                  <Alert variant="destructive">
                    <AlertCircle />
                    <AlertTitle>Could not save offer</AlertTitle>
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                ) : null}

                <section aria-labelledby={`${fieldPrefix}-official-heading`} className="grid gap-4">
                  <div className="grid gap-1">
                    <h4 id={`${fieldPrefix}-official-heading`} className="font-heading font-medium">
                      Official guidelines
                    </h4>
                    <p className="text-sm text-muted-foreground">
                      This is the source policy used to identify violations for this offer.
                    </p>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    {isCreating ? (
                      <div className="grid gap-2">
                        <Label htmlFor={`${fieldPrefix}-offer-id`}>Offer ID / slug</Label>
                        <Input
                          id={`${fieldPrefix}-offer-id`}
                          value={draft.offer_id}
                          placeholder="smart-financial"
                          autoComplete="off"
                          maxLength={80}
                          required
                          aria-describedby={`${fieldPrefix}-offer-id-help`}
                          onChange={(event) => updateDraft((current) => ({
                            ...current,
                            offer_id: event.currentTarget.value.toLocaleLowerCase(),
                          }))}
                        />
                        <p id={`${fieldPrefix}-offer-id-help`} className="text-xs text-muted-foreground">
                          Lowercase letters, numbers, hyphens, or underscores.
                        </p>
                      </div>
                    ) : null}
                    <div className="grid gap-2">
                      <Label htmlFor={`${fieldPrefix}-display-name`}>Display name</Label>
                      <Input
                        id={`${fieldPrefix}-display-name`}
                        value={draft.display_name}
                        maxLength={160}
                        required
                        onChange={(event) => updateDraft((current) => ({
                          ...current,
                          display_name: event.currentTarget.value,
                        }))}
                      />
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Label htmlFor={`${fieldPrefix}-guidelines`}>Official guideline text</Label>
                      <Label
                        htmlFor={`${fieldPrefix}-guidelines-file`}
                        className="h-7 cursor-pointer rounded-lg border border-border bg-background px-2.5 text-xs hover:bg-muted"
                      >
                        <FileUp className="size-3.5" />
                        Import .txt or .md
                      </Label>
                    </div>
                    <Input
                      id={`${fieldPrefix}-guidelines-file`}
                      type="file"
                      accept=".txt,.md,text/plain,text/markdown"
                      className="hidden"
                      aria-label="Import official guidelines from a text or Markdown file"
                      onChange={(event) => void importGuidelines(event)}
                    />
                    <Textarea
                      id={`${fieldPrefix}-guidelines`}
                      value={draft.official_guidelines}
                      className="min-h-72 font-mono text-xs leading-5"
                      maxLength={MAX_GUIDELINES_LENGTH}
                      aria-describedby={`${fieldPrefix}-guidelines-count`}
                      onChange={(event) => updateDraft((current) => {
                        const officialGuidelines = event.currentTarget.value;
                        const configured = Boolean(officialGuidelines.trim());
                        return {
                          ...current,
                          official_guidelines: officialGuidelines,
                          enabled: configured ? current.enabled : false,
                          is_default: configured ? current.is_default : false,
                        };
                      })}
                    />
                    <p id={`${fieldPrefix}-guidelines-count`} className="text-right text-xs text-muted-foreground">
                      {draft.official_guidelines.length.toLocaleString()} / {MAX_GUIDELINES_LENGTH.toLocaleString()} characters
                    </p>
                  </div>

                  <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="grid gap-1">
                        <Label htmlFor={`${fieldPrefix}-enabled`}>Available for new reviews</Label>
                        <p className="text-xs text-muted-foreground">
                          {draft.official_guidelines.trim()
                            ? 'Disabled offers remain visible in historical reports.'
                            : 'Add official guidelines before turning this offer on.'}
                        </p>
                      </div>
                      <Switch
                        id={`${fieldPrefix}-enabled`}
                        checked={draft.enabled}
                        disabled={!draft.enabled && !draft.official_guidelines.trim()}
                        onCheckedChange={(enabled) => updateDraft((current) => ({
                          ...current,
                          enabled,
                          is_default: enabled ? current.is_default : false,
                        }))}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="grid gap-1">
                        <Label htmlFor={`${fieldPrefix}-default`}>Default offer</Label>
                        <p className="text-xs text-muted-foreground">
                          Used as the primary result when every active offer is reviewed.
                        </p>
                      </div>
                      <Switch
                        id={`${fieldPrefix}-default`}
                        checked={draft.is_default}
                        disabled={!draft.enabled}
                        onCheckedChange={(isDefault) => updateDraft((current) => ({
                          ...current,
                          is_default: isDefault,
                        }))}
                      />
                    </div>
                  </div>
                </section>

                <Separator />

                <section aria-labelledby={`${fieldPrefix}-overrides-heading`} className="grid gap-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="grid max-w-2xl gap-1">
                      <h4 id={`${fieldPrefix}-overrides-heading`} className="font-heading font-medium">
                        Internal overrides
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        Document accepted internal exceptions for {draft.display_name || 'this offer'}.
                        The AI still reports the official violation and links the matching exception beside it.
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addOverride}>
                      <Plus />
                      Add override
                    </Button>
                  </div>

                  {draft.internal_overrides.length ? (
                    <div className="grid gap-3">
                      {draft.internal_overrides.map((override, index) => {
                        const overridePrefix = `${fieldPrefix}-override-${override.client_key}`;
                        return (
                          <Card key={override.client_key} size="sm" className={cn(!override.enabled && 'opacity-70')}>
                            <CardHeader>
                              <CardTitle as="h3">Override {index + 1}</CardTitle>
                              <CardDescription>
                                {override.title || 'Untitled internal exception'}
                              </CardDescription>
                              <CardAction className="flex items-center gap-3">
                                <div className="flex items-center gap-2">
                                  <Label htmlFor={`${overridePrefix}-enabled`} className="text-xs">
                                    Enabled
                                  </Label>
                                  <Switch
                                    id={`${overridePrefix}-enabled`}
                                    size="sm"
                                    checked={override.enabled}
                                    onCheckedChange={(enabled) => updateOverride(override.client_key, { enabled })}
                                  />
                                </div>
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="icon-xs"
                                  aria-label={`Remove override ${index + 1}`}
                                  onClick={() => removeOverride(override.client_key)}
                                >
                                  <Trash2 />
                                </Button>
                              </CardAction>
                            </CardHeader>
                            <CardContent className="grid gap-4">
                              <div className="grid gap-4 sm:grid-cols-2">
                                <div className="grid gap-2">
                                  <Label htmlFor={`${overridePrefix}-id`}>Override ID</Label>
                                  <Input
                                    id={`${overridePrefix}-id`}
                                    value={override.override_id}
                                    placeholder="cash-imagery-exception"
                                    maxLength={80}
                                    required
                                    onChange={(event) => updateOverride(override.client_key, {
                                      override_id: event.currentTarget.value.toLocaleLowerCase(),
                                    })}
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label htmlFor={`${overridePrefix}-title`}>Title</Label>
                                  <Input
                                    id={`${overridePrefix}-title`}
                                    value={override.title}
                                    placeholder="Approved cash imagery"
                                    maxLength={160}
                                    required
                                    onChange={(event) => updateOverride(override.client_key, {
                                      title: event.currentTarget.value,
                                    })}
                                  />
                                </div>
                              </div>
                              <div className="grid gap-2">
                                <Label htmlFor={`${overridePrefix}-guidance`}>Internal guidance</Label>
                                <Textarea
                                  id={`${overridePrefix}-guidance`}
                                  value={override.guidance}
                                  className="min-h-24"
                                  maxLength={10_000}
                                  required
                                  placeholder="Explain exactly when this exception may be accepted."
                                  onChange={(event) => updateOverride(override.client_key, {
                                    guidance: event.currentTarget.value,
                                  })}
                                />
                              </div>
                              <div className="grid gap-2">
                                <Label htmlFor={`${overridePrefix}-rationale`}>Rationale (optional)</Label>
                                <Textarea
                                  id={`${overridePrefix}-rationale`}
                                  value={override.rationale}
                                  className="min-h-20"
                                  maxLength={5_000}
                                  placeholder="Record why the team accepts this exception for this offer."
                                  onChange={(event) => updateOverride(override.client_key, {
                                    rationale: event.currentTarget.value,
                                  })}
                                />
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="grid min-h-28 place-items-center rounded-lg border border-dashed bg-muted/20 p-5 text-center">
                      <div className="grid max-w-md gap-1">
                        <p className="text-sm font-medium">No internal overrides</p>
                        <p className="text-sm text-muted-foreground">
                          This offer currently follows its official guidelines without saved exceptions.
                        </p>
                      </div>
                    </div>
                  )}
                </section>

                <div className="flex flex-col-reverse gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    {!isCreating && draft.enabled ? (
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={isMutating}
                        onClick={disableCurrentOffer}
                      >
                        <Trash2 />
                        Disable offer
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-end gap-3">
                    <span className="text-xs text-muted-foreground" aria-live="polite">
                      {isDirty ? 'Unsaved changes' : 'All changes saved'}
                    </span>
                    <Button type="submit" disabled={isMutating || !isDirty}>
                      {saveMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
                      {saveMutation.isPending ? 'Saving' : 'Save profile'}
                    </Button>
                  </div>
                </div>
                </fieldset>
              </form>
            ) : (
              <div className="grid min-h-64 place-items-center rounded-lg border border-dashed p-6 text-center">
                <div className="grid max-w-sm gap-2">
                  <p className="font-medium">Select or create an offer</p>
                  <p className="text-sm text-muted-foreground">
                    Offer-specific official guidelines and internal overrides are managed here.
                  </p>
                  <Button type="button" variant="outline" className="mx-auto" onClick={startNewOffer}>
                    <Plus />
                    New offer
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default OfferSettingsPanel;
