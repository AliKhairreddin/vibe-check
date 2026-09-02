import { useState } from 'react';
import {
  ArrowRight,
  Check,
  Clipboard,
  Code2,
  Fingerprint,
  KeyRound,
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
const API_BASE_URL = 'https://api.adchecked.com/api/v1';

const endpoints: Array<{
  description: string;
  method: Method;
  path: string;
  scope: string;
  title: string;
}> = [
  {
    description: 'Send an asset ID, creative name, and public HTTPS media URL. Returns job_id after the media is validated and queued.',
    method: 'POST',
    path: '/jobs',
    scope: 'reviews:create',
    title: '1. Submit creative URL',
  },
  {
    description: 'Poll by job_id. Status is always queued, processing, completed, or failed.',
    method: 'GET',
    path: '/jobs/{job_id}',
    scope: 'reviews:read',
    title: '2. Get job status',
  },
  {
    description: 'Return the asset ID, creative name, and complete structured analysis result after processing finishes.',
    method: 'GET',
    path: '/jobs/{job_id}/result',
    scope: 'reviews:read',
    title: '3. Get job result',
  },
  {
    description: 'Upload the currently running media. AdChecked hashes the bytes and only creates a review when something relevant changed.',
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
    description: 'List durable internal review history for an offer explicitly shared with this account, for example ?offer_id=acp.',
    method: 'GET',
    path: '/reviews?offer_id=acp',
    scope: 'history:read',
    title: 'List shared offer history',
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
  const jobExample = `curl -X POST '${baseUrl}/jobs' \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: lemmonmaxx-monday-001' \\
  --data '{"asset_id":"asset_12345","creative_name":"Monday Creative","media_url":"https://cdn.example.com/creative.mp4"}'`;

  return (
    <div className={embedded ? 'grid gap-6 pb-16' : 'grid gap-8 pb-16'}>
      <section className="relative overflow-hidden rounded-3xl border bg-card px-6 py-10 shadow-sm sm:px-10">
        <div className="pointer-events-none absolute -right-24 -top-32 size-80 rounded-full bg-chart-2/10 blur-3xl" />
        <div className="relative grid max-w-4xl gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">API v1</Badge>
            <Badge variant="outline"><ShieldCheck /> Server to server</Badge>
          </div>
          <div className="grid gap-3">
            <h1 className="max-w-3xl font-heading text-3xl font-semibold tracking-tight sm:text-5xl">
              Put the full AdChecked workflow inside LemmonMaxx.
            </h1>
            <p className="max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg">
              Monday testing needs only three calls: submit a creative URL, poll its normalized status,
              and retrieve the complete JSON analysis with the creative name.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton label="Copy base URL" value={baseUrl} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {[
          [Fingerprint, '1. Accept', 'AdChecked validates the public HTTPS destination, follows only safe redirects, verifies the file bytes, and returns job_id.'],
          [ScanSearch, '2. Process', 'Poll by job_id and receive only queued, processing, completed, or failed while the full pipeline runs.'],
          [ArrowRight, '3. Retrieve', 'When status is completed, request the result endpoint for the asset ID, creative name, and complete structured analysis.'],
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
          Never ship it to browser JavaScript. The three-endpoint flow needs
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5">reviews:create</code> and
          <code className="mr-1 rounded bg-muted px-1.5 py-0.5">reviews:read</code>.
        </AlertDescription>
      </Alert>

      <section id="quick-start" className="grid gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Quick start</p>
          <h2 className="font-heading text-2xl font-semibold tracking-tight">Submit a creative URL</h2>
        </div>
        <CodeBlock code={jobExample} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>HTTP 202 — accepted</CardTitle>
              <CardDescription>
                The response includes asset_id, job_id, creative_name, queued status, status_url, and result_url.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>GET status — poll</CardTitle>
              <CardDescription>
                Continue while queued or processing. Stop on completed or failed.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>GET result — complete</CardTitle>
              <CardDescription>
                Returns asset_id, creative_name, completed status, and the full report in result.
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
            <p className="mt-1 text-sm text-muted-foreground">Start with one direct public MP4, JPG, PNG, or WebP URL and use the returned job_id.</p>
          </div>
          <Button nativeButton={false} render={<a href="/developers/api?view=reference" />}>
            Open API reference <ArrowRight />
          </Button>
        </div>
      </section>
    </div>
  );
}
