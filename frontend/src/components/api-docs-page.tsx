import { useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Clipboard,
  Code2,
  FileJson,
  Fingerprint,
  KeyRound,
  Play,
  ScanSearch,
  ShieldCheck,
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
import { Separator } from '@/components/ui/separator';

type Method = 'GET' | 'POST';
const API_BASE_URL = 'https://vibe-check.ali-kheireddin1.workers.dev/api/v1';

const endpoints: Array<{
  description: string;
  method: Method;
  path: string;
  scope: string;
  title: string;
}> = [
  {
    description: 'Upload the currently running media. Vibe Check hashes the bytes and only creates a review when something relevant changed.',
    method: 'POST',
    path: '/scans/creative',
    scope: 'scans:write',
    title: 'Observe a live creative',
  },
  {
    description: 'Read the latest fingerprint, scan count, and linked review for one of your own ad IDs.',
    method: 'GET',
    path: '/scans/ads/{ad_id}',
    scope: 'scans:read',
    title: 'Read an ad’s current state',
  },
  {
    description: 'Read the audit trail showing every observation and whether it was new, changed, retried, or unchanged.',
    method: 'GET',
    path: '/scans/ads/{ad_id}/observations',
    scope: 'scans:read',
    title: 'List scan observations',
  },
  {
    description: 'Poll an owned review until report_ready is true.',
    method: 'GET',
    path: '/reviews/{review_id}',
    scope: 'reviews:read',
    title: 'Check review status',
  },
  {
    description: 'Return the complete compliance report once processing finishes.',
    method: 'GET',
    path: '/reviews/{review_id}/result',
    scope: 'reviews:read',
    title: 'Read review results',
  },
  {
    description: 'Return transcript, OCR, visual observations, limitations, and protected links to evidence frames.',
    method: 'GET',
    path: '/reviews/{review_id}/evidence',
    scope: 'evidence:read',
    title: 'Read evidence and frames',
  },
];

const referenceControls = [
  ['API key', 'Paste the token once. It stays only in this browser tab’s memory and is added as the Bearer header to live requests.'],
  ['Open endpoint', 'Expand a clean request card to see its purpose, required permission, request fields, and cURL example.'],
  ['Copy cURL', 'Copy an implementation-ready command. It always uses YOUR_API_KEY so the token you loaded is never copied accidentally.'],
  ['Send request', 'Call the real production API using the values in that card. A scan can upload media and create a real review.'],
  ['Clear', 'Reset that endpoint’s fields, chosen file, and displayed response. It does not delete server data.'],
  ['Download response', 'Save an authenticated PDF, image frame, or other binary artifact returned by the endpoint.'],
];

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <Button type="button" variant="outline" onClick={copy}>
      {copied ? <Check /> : <Clipboard />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-zinc-950 text-zinc-100 shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-zinc-400">
        <span>Shell</span>
        <CopyButton label="Copy" value={code} />
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-6"><code>{code}</code></pre>
    </div>
  );
}

function MethodBadge({ method }: { method: Method }) {
  return (
    <Badge variant={method === 'POST' ? 'default' : 'secondary'} className="font-mono">
      {method}
    </Badge>
  );
}

export function ApiDocsPage({ embedded = false }: { embedded?: boolean }) {
  const baseUrl = API_BASE_URL;
  const scanExample = `curl -X POST '${baseUrl}/scans/creative' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'X-Vibe-Ad-Id: 23851234567890123' \\
  -F 'creative=@current-ad-1.mp4' \\
  -F 'ad_id=23851234567890123' \\
  -F 'creative_name=Ad 1' \\
  -F 'campaign_id=23850000000000000' \\
  -F 'ad_set_id=23851111111111111' \\
  -F 'ad_copy=The primary text currently running on Meta' \\
  -F 'headline=The current headline' \\
  -F 'call_to_action=LEARN_MORE' \\
  -F 'destination_url=https://example.com/landing-page'`;

  return (
    <div className={embedded ? 'grid gap-6 pb-16' : 'grid gap-8 pb-16'}>
      <section className="relative overflow-hidden rounded-3xl border bg-card px-6 py-10 shadow-sm sm:px-10">
        <div className="pointer-events-none absolute -right-24 -top-32 size-80 rounded-full bg-chart-2/10 blur-3xl" />
        <div className="relative grid max-w-4xl gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary"><BookOpen /> Developer guide</Badge>
            <Badge variant="outline">API v1</Badge>
            <Badge variant="outline"><ShieldCheck /> Server to server</Badge>
          </div>
          <div className="grid gap-3">
            <h1 className="max-w-3xl font-heading text-3xl font-semibold tracking-tight sm:text-5xl">
              Put the full Vibe Check workflow inside LemmonMaxx.
            </h1>
            <p className="max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg">
              Upload the media that is actually running, detect silent creative replacements by content hash,
              and retrieve the same findings, transcript, OCR, visual observations, and evidence frames available in Vibe Check.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button nativeButton={false} render={<a href="/developers/api?view=reference" />}>
              <Play /> Open interactive reference <ArrowRight />
            </Button>
            <Button nativeButton={false} variant="outline" render={<a href={`${baseUrl}/openapi.json`} target="_blank" rel="noreferrer" />}>
              <FileJson /> OpenAPI JSON
            </Button>
            <CopyButton label="Copy base URL" value={baseUrl} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {[
          [Fingerprint, '1. Hash', 'Vibe Check calculates SHA-256 directly from the uploaded media bytes. No OCR, transcription, or AI is used for this step.'],
          [ScanSearch, '2. Compare', 'The media hash and review-field hash are compared with the last observation for the same partner and ad ID.'],
          [ArrowRight, '3. Review or reuse', 'Changed content starts the normal pipeline. Unchanged content reuses the existing review and records a new audit observation.'],
        ].map(([Icon, title, description]) => {
          const StepIcon = Icon as typeof Fingerprint;
          return (
            <Card key={String(title)}>
              <CardHeader>
                <div className="mb-2 grid size-10 place-items-center rounded-xl bg-secondary"><StepIcon /></div>
                <CardTitle>{String(title)}</CardTitle>
                <CardDescription className="leading-6">{String(description)}</CardDescription>
              </CardHeader>
            </Card>
          );
        })}
      </section>

      <Alert>
        <KeyRound />
        <AlertTitle>Keep the key in the LemmonMaxx backend</AlertTitle>
        <AlertDescription>
          Never ship it to browser JavaScript. Create a key in Settings → API access with
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5">scans:write</code>,
          <code className="mr-1 rounded bg-muted px-1.5 py-0.5">scans:read</code>, and the result/evidence permissions LemmonMaxx needs.
        </AlertDescription>
      </Alert>

      <section id="quick-start" className="grid gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Quick start</p>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">Send the currently running creative</h2>
        </div>
        <CodeBlock code={scanExample} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>HTTP 202 — review created</CardTitle>
              <CardDescription>
                The ad is new, its media changed, its copy changed, or the previous attempt failed. Poll the returned status URL.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>HTTP 200 — review reused</CardTitle>
              <CardDescription>
                Media, ad fields, review settings, and applicable policy are unchanged. No OCR, transcription, vision, or LLM processing runs again.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      <Separator />

      <section className="grid gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Endpoints</p>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">The LemmonMaxx integration surface</h2>
        </div>
        <div className="grid gap-3">
          {endpoints.map((endpoint) => (
            <Card key={`${endpoint.method}-${endpoint.path}`} size="sm">
              <CardHeader>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <MethodBadge method={endpoint.method} />
                  <code className="break-all text-sm font-medium">{endpoint.path}</code>
                </div>
                <CardDescription className="leading-6">{endpoint.description}</CardDescription>
                <CardAction><Badge variant="outline">{endpoint.scope}</Badge></CardAction>
              </CardHeader>
              <CardContent className="text-sm font-medium">{endpoint.title}</CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Interactive reference</p>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">What the buttons mean</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            The reference is a custom shadcn testing console for the production API. Treat Send request as a real production request.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {referenceControls.map(([label, description]) => (
            <Card key={label} size="sm">
              <CardHeader>
                <CardTitle>{label}</CardTitle>
                <CardDescription className="leading-6">{description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border bg-muted/30 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 font-heading text-lg font-semibold"><Code2 /> Ready to test?</div>
            <p className="mt-1 text-sm text-muted-foreground">Start with one known ad ID, scan it twice, then replace the file without changing its name.</p>
          </div>
          <Button nativeButton={false} render={<a href="/developers/api?view=reference" />}>
            Open API reference <ArrowRight />
          </Button>
        </div>
      </section>
    </div>
  );
}
