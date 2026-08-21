import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  Clipboard,
  Code2,
  Infinity as InfinityIcon,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Webhook,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  createApiPartner,
  issueApiKey,
  listApiPartners,
  listOfferCatalog,
  revokeApiKey,
  rotateApiWebhookSecret,
  saveApiPartner,
  type ApiKeyInput,
  type ApiPartner,
  type ApiPartnerInput,
  type ApiScope,
} from '@/lib/api';
import { cn } from '@/lib/utils';

const PARTNERS_QUERY_KEY = ['api-partners'] as const;
const DEFAULT_SCOPES: ApiScope[] = [
  'reviews:create',
  'reviews:read',
  'history:read',
  'evidence:read',
  'reports:download',
  'scans:write',
  'scans:read',
];
const SCOPE_LABELS: Record<ApiScope, { label: string; description: string }> = {
  'reviews:create': { label: 'Create reviews', description: 'Upload creatives and submit ad copy.' },
  'reviews:read': { label: 'Read results', description: 'Read owned review status and JSON results.' },
  'history:read': { label: 'List history', description: 'Browse this partner’s previous reviews.' },
  'evidence:read': { label: 'Read evidence', description: 'Access transcripts, OCR, observations, and frames.' },
  'reports:download': { label: 'Download reports', description: 'Download report JSON and PDFs.' },
  'scans:write': { label: 'Submit live scans', description: 'Hash observed ad media and queue reviews only when content changes.' },
  'scans:read': { label: 'Read live scans', description: 'Read this partner’s current ad fingerprints and observation history.' },
  'reviews:delete': { label: 'Delete reviews', description: 'Permanently remove owned terminal reviews.' },
};

type SecretNotice = {
  kind: 'API key' | 'Webhook signing secret';
  value: string;
};

function emptyPartnerDraft(internal = false): ApiPartnerInput {
  return {
    allowed_offer_ids: [],
    allow_custom_policy: internal,
    concurrent_review_limit: 5,
    description: internal
      ? 'Internal company integration with unrestricted API usage.'
      : '',
    max_upload_mb: 400,
    monthly_review_limit: 500,
    name: internal ? 'Internal company integration' : '',
    retention_days: internal ? 90 : 30,
    status: 'active',
    unlimited_concurrency: internal,
    unlimited_reviews: internal,
    webhook_url: null,
  };
}

function partnerToDraft(partner: ApiPartner): ApiPartnerInput {
  return {
    allowed_offer_ids: [...partner.allowed_offer_ids],
    allow_custom_policy: partner.allow_custom_policy,
    concurrent_review_limit: partner.concurrent_review_limit,
    description: partner.description,
    max_upload_mb: partner.max_upload_mb,
    monthly_review_limit: partner.monthly_review_limit,
    name: partner.name,
    retention_days: partner.retention_days,
    status: partner.status,
    unlimited_concurrency: partner.unlimited_concurrency,
    unlimited_reviews: partner.unlimited_reviews,
    webhook_url: partner.webhook_url,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(value: number | null) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function ApiAccessPanel() {
  const queryClient = useQueryClient();
  const [selectedPartnerId, setSelectedPartnerId] = useState('');
  const [draft, setDraft] = useState<ApiPartnerInput | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [secretNotice, setSecretNotice] = useState<SecretNotice | null>(null);
  const [copied, setCopied] = useState(false);
  const [keyName, setKeyName] = useState('Production');
  const [keyExpiration, setKeyExpiration] = useState('');
  const [keyScopes, setKeyScopes] = useState<ApiScope[]>(DEFAULT_SCOPES);

  const partnersQuery = useQuery({ queryKey: PARTNERS_QUERY_KEY, queryFn: listApiPartners });
  const offersQuery = useQuery({ queryKey: ['offers'], queryFn: listOfferCatalog });
  const partners = partnersQuery.data?.partners ?? [];
  const selectedPartner = partners.find((partner) => partner.partner_id === selectedPartnerId) ?? null;

  useEffect(() => {
    if (isCreating || selectedPartnerId || !partners.length) return;
    setSelectedPartnerId(partners[0].partner_id);
    setDraft(partnerToDraft(partners[0]));
  }, [isCreating, partners, selectedPartnerId]);

  useEffect(() => {
    if (!selectedPartner || isCreating) return;
    setDraft(partnerToDraft(selectedPartner));
  }, [isCreating, selectedPartner]);

  const activeKeyCount = useMemo(
    () => partners.reduce(
      (count, partner) => count + partner.keys.filter((key) => key.status === 'active').length,
      0
    ),
    [partners]
  );
  const monthlyReviewCount = useMemo(
    () => partners.reduce((count, partner) => count + partner.monthly_reviews_created, 0),
    [partners]
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('Partner settings are unavailable.');
      if (!draft.name.trim()) throw new Error('Partner name is required.');
      const input = { ...draft, name: draft.name.trim(), description: draft.description.trim() };
      return isCreating
        ? createApiPartner(input)
        : saveApiPartner(selectedPartnerId, input);
    },
    onSuccess: async (partner) => {
      setSelectedPartnerId(partner.partner_id);
      setIsCreating(false);
      setNotice(`${partner.name} was saved.`);
      setError('');
      await queryClient.invalidateQueries({ queryKey: PARTNERS_QUERY_KEY });
    },
    onError: (reason) => {
      setNotice('');
      setError(errorMessage(reason));
    },
  });

  const keyMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPartner) throw new Error('Save the partner before issuing a key.');
      const input: ApiKeyInput = {
        expires_at: keyExpiration
          ? new Date(`${keyExpiration}T23:59:59`).getTime()
          : null,
        name: keyName.trim(),
        scopes: keyScopes,
      };
      if (!input.name) throw new Error('Key name is required.');
      return issueApiKey(selectedPartner.partner_id, input);
    },
    onSuccess: async (key) => {
      setSecretNotice({ kind: 'API key', value: key.token });
      setCopied(false);
      setNotice(`${key.name} was issued. Copy it now; it will not be shown again.`);
      setError('');
      setKeyName('Production');
      setKeyExpiration('');
      await queryClient.invalidateQueries({ queryKey: PARTNERS_QUERY_KEY });
    },
    onError: (reason) => setError(errorMessage(reason)),
  });

  const rotateWebhookMutation = useMutation({
    mutationFn: () => {
      if (!selectedPartner) throw new Error('Save the partner first.');
      return rotateApiWebhookSecret(selectedPartner.partner_id);
    },
    onSuccess: async (result) => {
      setSecretNotice({ kind: 'Webhook signing secret', value: result.webhook_signing_secret });
      setCopied(false);
      setNotice('Webhook signing secret created. Copy it now; rotating again invalidates it.');
      setError('');
      await queryClient.invalidateQueries({ queryKey: PARTNERS_QUERY_KEY });
    },
    onError: (reason) => setError(errorMessage(reason)),
  });

  async function revokeKey(keyId: string) {
    if (!selectedPartner) return;
    if (!window.confirm('Revoke this API key now? Existing integrations using it will stop immediately.')) {
      return;
    }
    try {
      await revokeApiKey(selectedPartner.partner_id, keyId);
      setNotice('API key revoked.');
      setError('');
      await queryClient.invalidateQueries({ queryKey: PARTNERS_QUERY_KEY });
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function copySecret() {
    if (!secretNotice) return;
    await navigator.clipboard.writeText(secretNotice.value);
    setCopied(true);
  }

  function selectPartner(partner: ApiPartner) {
    setSelectedPartnerId(partner.partner_id);
    setDraft(partnerToDraft(partner));
    setIsCreating(false);
    setSecretNotice(null);
    setNotice('');
    setError('');
  }

  function startPartner(internal: boolean) {
    setSelectedPartnerId('');
    setDraft(emptyPartnerDraft(internal));
    setIsCreating(true);
    setSecretNotice(null);
    setNotice('');
    setError('');
  }

  function updateDraft(patch: Partial<ApiPartnerInput>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setNotice('');
    setError('');
  }

  function toggleOffer(offerId: string, checked: boolean) {
    if (!draft) return;
    const next = checked
      ? [...new Set([...draft.allowed_offer_ids, offerId])]
      : draft.allowed_offer_ids.filter((value) => value !== offerId);
    updateDraft({ allowed_offer_ids: next });
  }

  function toggleScope(scope: ApiScope, checked: boolean) {
    setKeyScopes((current) => checked
      ? [...new Set([...current, scope])]
      : current.filter((value) => value !== scope));
  }

  if (partnersQuery.isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (partnersQuery.error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>API access could not load</AlertTitle>
        <AlertDescription>{errorMessage(partnersQuery.error)}</AlertDescription>
      </Alert>
    );
  }

  const configuredBaseUrl = partnersQuery.data?.base_url ?? '/api/v1';
  const baseUrl = /^https:\/\//.test(configuredBaseUrl)
    ? configuredBaseUrl
    : typeof window === 'undefined'
      ? configuredBaseUrl
      : `${window.location.origin}${configuredBaseUrl}`;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="API partners" value={partners.length.toLocaleString()} />
        <MetricCard label="Active API keys" value={activeKeyCount.toLocaleString()} />
        <MetricCard label="Reviews this month" value={monthlyReviewCount.toLocaleString()} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Partner accounts and credentials</CardTitle>
          <CardDescription>
            Isolate every integration, control its offers and usage, and revoke credentials independently.
          </CardDescription>
          <CardAction className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => startPartner(false)}>
              <Plus /> New partner
            </Button>
            <Button type="button" size="sm" onClick={() => startPartner(true)}>
              <InfinityIcon /> Internal account
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="grid content-start gap-2 rounded-xl border bg-muted/20 p-2">
            {partners.map((partner) => (
              <button
                key={partner.partner_id}
                type="button"
                className={cn(
                  'grid gap-1 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                  !isCreating && selectedPartnerId === partner.partner_id && 'bg-background shadow-sm ring-1 ring-border'
                )}
                onClick={() => selectPartner(partner)}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{partner.name}</span>
                  <Badge variant={partner.status === 'active' ? 'secondary' : 'outline'}>
                    {partner.status}
                  </Badge>
                </span>
                <span className="text-xs text-muted-foreground">
                  {partner.keys.filter((key) => key.status === 'active').length} active keys ·{' '}
                  {partner.unlimited_reviews ? 'unlimited usage' : `${partner.monthly_reviews_created}/${partner.monthly_review_limit} this month`}
                </span>
              </button>
            ))}
            {!partners.length ? (
              <div className="grid gap-2 px-3 py-6 text-center text-sm text-muted-foreground">
                <KeyRound className="mx-auto size-5" />
                No API partners yet.
              </div>
            ) : null}
          </aside>

          {draft ? (
            <div className="grid gap-5">
              {secretNotice ? (
                <Alert className="border-emerald-600/30 bg-emerald-500/5">
                  <ShieldCheck />
                  <AlertTitle>Copy this {secretNotice.kind.toLowerCase()} now</AlertTitle>
                  <AlertDescription className="grid gap-3">
                    <code className="break-all rounded-lg border bg-background p-3 text-xs text-foreground">
                      {secretNotice.value}
                    </code>
                    <div>
                      <Button type="button" size="sm" variant="outline" onClick={() => void copySecret()}>
                        {copied ? <Check /> : <Clipboard />}
                        {copied ? 'Copied' : 'Copy secret'}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {error ? (
                <Alert variant="destructive">
                  <AlertCircle />
                  <AlertTitle>Could not save API access</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              {notice ? (
                <Alert>
                  <Check />
                  <AlertTitle>API access updated</AlertTitle>
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              ) : null}

              <form
                className="grid gap-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveMutation.mutate();
                }}
              >
                <section className="grid gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-heading text-base font-medium">Account</h3>
                      <p className="text-xs text-muted-foreground">Identity, status, and retained evidence.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="api-partner-active">Active</Label>
                      <Switch
                        id="api-partner-active"
                        checked={draft.status === 'active'}
                        onCheckedChange={(checked) => updateDraft({ status: checked ? 'active' : 'suspended' })}
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="api-partner-name">Partner name</Label>
                      <Input
                        id="api-partner-name"
                        value={draft.name}
                        onChange={(event) => updateDraft({ name: event.currentTarget.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="api-retention">Evidence retention (days)</Label>
                      <Input
                        id="api-retention"
                        type="number"
                        min={1}
                        max={365}
                        value={draft.retention_days}
                        onChange={(event) => updateDraft({ retention_days: Number(event.currentTarget.value) })}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="api-partner-description">Description</Label>
                    <Textarea
                      id="api-partner-description"
                      rows={3}
                      value={draft.description}
                      onChange={(event) => updateDraft({ description: event.currentTarget.value })}
                    />
                  </div>
                </section>

                <Separator />

                <section className="grid gap-3">
                  <div>
                    <h3 className="font-heading text-base font-medium">Usage and file limits</h3>
                    <p className="text-xs text-muted-foreground">
                      Unlimited API submission still uses the platform’s bounded processing workers safely.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <LimitControl
                      id="unlimited-reviews"
                      label="Unlimited monthly reviews"
                      checked={draft.unlimited_reviews}
                      onCheckedChange={(checked) => updateDraft({ unlimited_reviews: checked })}
                    >
                      <Label htmlFor="monthly-limit">Monthly review limit</Label>
                      <Input
                        id="monthly-limit"
                        type="number"
                        min={1}
                        max={100000}
                        disabled={draft.unlimited_reviews}
                        value={draft.monthly_review_limit}
                        onChange={(event) => updateDraft({ monthly_review_limit: Number(event.currentTarget.value) })}
                      />
                    </LimitControl>
                    <LimitControl
                      id="unlimited-concurrency"
                      label="Unlimited queued submissions"
                      checked={draft.unlimited_concurrency}
                      onCheckedChange={(checked) => updateDraft({ unlimited_concurrency: checked })}
                    >
                      <Label htmlFor="concurrent-limit">Active review limit</Label>
                      <Input
                        id="concurrent-limit"
                        type="number"
                        min={1}
                        max={50}
                        disabled={draft.unlimited_concurrency}
                        value={draft.concurrent_review_limit}
                        onChange={(event) => updateDraft({ concurrent_review_limit: Number(event.currentTarget.value) })}
                      />
                    </LimitControl>
                  </div>
                  <div className="grid gap-2 sm:max-w-xs">
                    <Label htmlFor="api-max-upload">Maximum upload (MB)</Label>
                    <Input
                      id="api-max-upload"
                      type="number"
                      min={1}
                      max={400}
                      value={draft.max_upload_mb}
                      onChange={(event) => updateDraft({ max_upload_mb: Number(event.currentTarget.value) })}
                    />
                    <p className="text-xs text-muted-foreground">The infrastructure maximum remains 400 MB.</p>
                  </div>
                </section>

                <Separator />

                <section className="grid gap-3">
                  <div>
                    <h3 className="font-heading text-base font-medium">Offer and policy access</h3>
                    <p className="text-xs text-muted-foreground">
                      No offer selected means every currently active offer is evaluated.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(offersQuery.data ?? []).map((offer) => (
                      <label key={offer.offer_id} className="flex items-start gap-3 rounded-lg border p-3">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 accent-primary"
                          checked={draft.allowed_offer_ids.includes(offer.offer_id)}
                          onChange={(event) => toggleOffer(offer.offer_id, event.currentTarget.checked)}
                        />
                        <span className="grid gap-0.5">
                          <span className="font-medium">{offer.display_name}</span>
                          <span className="text-xs text-muted-foreground">
                            {offer.enabled && offer.configured ? `Active · policy v${offer.version}` : 'Currently unavailable'}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                    <div>
                      <Label htmlFor="custom-policy">Custom policy supplements</Label>
                      <p className="text-xs text-muted-foreground">Allow callers to add review-specific guidance.</p>
                    </div>
                    <Switch
                      id="custom-policy"
                      checked={draft.allow_custom_policy}
                      onCheckedChange={(checked) => updateDraft({ allow_custom_policy: checked })}
                    />
                  </div>
                </section>

                <Separator />

                <section className="grid gap-3">
                  <div className="flex items-center gap-2">
                    <Webhook className="size-4 text-muted-foreground" />
                    <h3 className="font-heading text-base font-medium">Completion webhook</h3>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="webhook-url">Public HTTPS endpoint</Label>
                    <Input
                      id="webhook-url"
                      type="url"
                      placeholder="https://partner.example.com/webhooks/vibe-check"
                      value={draft.webhook_url ?? ''}
                      onChange={(event) => updateDraft({ webhook_url: event.currentTarget.value || null })}
                    />
                  </div>
                  {!isCreating && selectedPartner ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={selectedPartner.webhook_configured ? 'secondary' : 'outline'}>
                        {selectedPartner.webhook_configured ? 'Signing enabled' : 'Signing secret needed'}
                      </Badge>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          !draft.webhook_url
                          || draft.webhook_url !== selectedPartner.webhook_url
                          || rotateWebhookMutation.isPending
                        }
                        onClick={() => rotateWebhookMutation.mutate()}
                      >
                        {rotateWebhookMutation.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                        {selectedPartner.webhook_configured ? 'Rotate secret' : 'Create signing secret'}
                      </Button>
                      {draft.webhook_url !== selectedPartner.webhook_url ? (
                        <span className="text-xs text-muted-foreground">Save the partner before creating or rotating its secret.</span>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                <div>
                  <Button type="submit" disabled={saveMutation.isPending || !draft.name.trim()}>
                    {saveMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
                    {isCreating ? 'Create partner' : 'Save partner'}
                  </Button>
                </div>
              </form>

              {!isCreating && selectedPartner ? (
                <>
                  <Separator />
                  <section className="grid gap-4">
                    <div>
                      <h3 className="font-heading text-base font-medium">API keys</h3>
                      <p className="text-xs text-muted-foreground">
                        Secrets are shown once. Use separate keys for each environment or integration.
                      </p>
                    </div>
                    <div className="grid gap-3 rounded-xl border bg-muted/10 p-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="grid gap-2">
                          <Label htmlFor="key-name">Key name</Label>
                          <Input id="key-name" value={keyName} onChange={(event) => setKeyName(event.currentTarget.value)} />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="key-expiration">Expiration (optional)</Label>
                          <Input
                            id="key-expiration"
                            type="date"
                            value={keyExpiration}
                            onChange={(event) => setKeyExpiration(event.currentTarget.value)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {(partnersQuery.data?.available_scopes ?? []).map((scope) => (
                          <label key={scope} className="flex items-start gap-3 rounded-lg border bg-background p-3">
                            <input
                              type="checkbox"
                              className="mt-0.5 size-4 accent-primary"
                              checked={keyScopes.includes(scope)}
                              onChange={(event) => toggleScope(scope, event.currentTarget.checked)}
                            />
                            <span className="grid gap-0.5">
                              <span className="font-medium">{SCOPE_LABELS[scope].label}</span>
                              <span className="text-xs text-muted-foreground">{SCOPE_LABELS[scope].description}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <div>
                        <Button
                          type="button"
                          disabled={keyMutation.isPending || !keyName.trim() || !keyScopes.length}
                          onClick={() => keyMutation.mutate()}
                        >
                          {keyMutation.isPending ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
                          Issue API key
                        </Button>
                      </div>
                    </div>
                    <div className="grid gap-2">
                      {selectedPartner.keys.map((key) => (
                        <div key={key.key_id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                          <div className="grid gap-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{key.name}</span>
                              <Badge variant={key.status === 'active' ? 'secondary' : 'outline'}>{key.status}</Badge>
                              <code className="text-xs text-muted-foreground">{key.prefix}</code>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              Last used {formatDate(key.last_used_at)} · Expires {formatDate(key.expires_at)}
                            </span>
                          </div>
                          {key.status === 'active' ? (
                            <Button type="button" size="sm" variant="destructive" onClick={() => void revokeKey(key.key_id)}>
                              <Trash2 /> Revoke
                            </Button>
                          ) : null}
                        </div>
                      ))}
                      {!selectedPartner.keys.length ? (
                        <p className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground">
                          No API keys have been issued.
                        </p>
                      ) : null}
                    </div>
                  </section>
                </>
              ) : null}
            </div>
          ) : (
            <div className="grid min-h-72 place-items-center rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Create an internal account or a partner to begin.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Code2 className="size-4" /> Integration details</CardTitle>
          <CardDescription>The permanent key belongs on the caller’s server, never inside browser code.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-1">
            <Label>Base URL</Label>
            <code className="overflow-x-auto rounded-lg border bg-muted/30 p-3 text-xs">{baseUrl}</code>
            <a
              className="w-fit text-xs font-medium text-primary underline-offset-4 hover:underline"
              href={`${baseUrl}/docs`}
              target="_blank"
              rel="noreferrer"
            >
              Open interactive API documentation
            </a>
          </div>
          <div className="grid gap-1">
            <Label>Submit a review</Label>
            <pre className="overflow-x-auto rounded-lg border bg-zinc-950 p-4 text-xs leading-5 text-zinc-100"><code>{`curl -X POST '${baseUrl}/reviews' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'Idempotency-Key: your-unique-request-id' \\
  -F 'creative=@creative.mp4' \\
  -F 'ad_copy=Optional accompanying ad copy'`}</code></pre>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            A successful submission returns HTTP 202 with a review ID, status URL, and result URL.
            Completion webhooks are signed with <code>x-vibe-signature</code> over the timestamp and exact JSON body.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-heading text-2xl font-semibold">{value}</span>
      </CardContent>
    </Card>
  );
}

function LimitControl({
  checked,
  children,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  children: ReactNode;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="flex items-center gap-2">
          {checked ? <InfinityIcon className="size-4" /> : null}
          {label}
        </Label>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      </div>
      <div className="grid gap-2">{children}</div>
    </div>
  );
}

export default ApiAccessPanel;
