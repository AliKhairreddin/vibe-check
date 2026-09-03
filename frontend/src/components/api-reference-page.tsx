import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clipboard,
  CloudUpload,
  Download,
  Eye,
  EyeOff,
  FileSearch,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Play,
  RotateCcw,
  ScanSearch,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
  Unplug,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type FieldLocation = 'path' | 'query' | 'header' | 'form' | 'json' | 'body';
type FieldKind = 'text' | 'number' | 'textarea' | 'boolean' | 'file';
type BodyEncoding = 'none' | 'multipart' | 'urlencoded' | 'json' | 'binary';

type RequestField = {
  name: string;
  label: string;
  location: FieldLocation;
  kind?: FieldKind;
  required?: boolean;
  advanced?: boolean;
  defaultValue?: string;
  placeholder?: string;
  description?: string;
  accept?: string;
};

type Endpoint = {
  id: string;
  group: string;
  method: HttpMethod;
  path: string;
  title: string;
  description: string;
  scope?: string;
  auth?: boolean;
  bodyEncoding?: BodyEncoding;
  fields?: RequestField[];
  mirroredAdIdHeader?: boolean;
  destructive?: boolean;
};

type EndpointGroup = {
  id: string;
  title: string;
  description: string;
  icon: typeof Server;
};

type EndpointResponse = {
  status: number;
  statusText: string;
  elapsedMs: number;
  contentType: string;
  body?: string;
  binaryUrl?: string;
  binaryName?: string;
  binarySize?: number;
  error?: string;
};

const PRODUCTION_ORIGIN = 'https://api.adchecked.com';

const groups: EndpointGroup[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    description: 'Confirm the API is online and inspect the partner attached to your key.',
    icon: Server,
  },
  {
    id: 'simple-jobs',
    title: '3-API test flow',
    description: 'Submit a public media URL, poll one normalized status, and retrieve the complete JSON result.',
    icon: Play,
  },
  {
    id: 'creative-monitoring',
    title: 'Creative monitoring',
    description: 'Fingerprint currently running media and inspect change history by ad ID.',
    icon: Fingerprint,
  },
  {
    id: 'reviews-results',
    title: 'Reviews & results',
    description: 'Create reviews and retrieve traffic-light results, media, evidence frames, and reports.',
    icon: FileSearch,
  },
  {
    id: 'large-uploads',
    title: 'Large uploads',
    description: 'Use resumable chunks when a creative is too large for one request.',
    icon: CloudUpload,
  },
];

const reviewFormFields: RequestField[] = [
  {
    name: 'creative',
    label: 'Creative file',
    location: 'form',
    kind: 'file',
    accept: 'video/*,image/*',
    description: 'Video or image. Leave empty only when submitting ad copy by itself.',
  },
  {
    name: 'ad_copy',
    label: 'Ad copy',
    location: 'form',
    kind: 'textarea',
    placeholder: 'Primary text currently running with the ad',
  },
  {
    name: 'external_id',
    label: 'External ID',
    location: 'form',
    placeholder: 'Your stable internal reference',
  },
  {
    name: 'Idempotency-Key',
    label: 'Idempotency key',
    location: 'header',
    placeholder: 'A unique retry-safe request ID',
    description: 'Reuse the same value when retrying this exact submission.',
  },
  { name: 'policy_text', label: 'Custom policy', location: 'form', kind: 'textarea', advanced: true },
  { name: 'notes', label: 'Reviewer notes', location: 'form', kind: 'textarea', advanced: true },
  { name: 'manual_transcript', label: 'Manual transcript', location: 'form', kind: 'textarea', advanced: true },
  {
    name: 'frame_interval_seconds',
    label: 'Frame interval (seconds)',
    location: 'form',
    kind: 'number',
    defaultValue: '1',
    advanced: true,
  },
  {
    name: 'scene_detection',
    label: 'Scene detection',
    location: 'form',
    kind: 'boolean',
    defaultValue: 'false',
    advanced: true,
  },
];

const scanFields: RequestField[] = [
  {
    name: 'creative',
    label: 'Currently running media',
    location: 'form',
    kind: 'file',
    required: true,
    accept: 'video/*,image/*',
    description: 'AdChecked calculates SHA-256 directly from these file bytes before any AI work.',
  },
  {
    name: 'ad_id',
    label: 'Ad ID',
    location: 'form',
    required: true,
    placeholder: '23851234567890123',
    description: 'Also sent as X-Vibe-Ad-Id so routing and body identity must match.',
  },
  { name: 'creative_name', label: 'Creative name', location: 'form', placeholder: 'Ad 1' },
  { name: 'campaign_id', label: 'Campaign ID', location: 'form', placeholder: '23850000000000000' },
  { name: 'ad_set_id', label: 'Ad set ID', location: 'form', placeholder: '23851111111111111' },
  { name: 'ad_copy', label: 'Primary text', location: 'form', kind: 'textarea', placeholder: 'The primary text currently running on Meta' },
  { name: 'headline', label: 'Headline', location: 'form', placeholder: 'The current headline' },
  { name: 'call_to_action', label: 'Call to action', location: 'form', placeholder: 'LEARN_MORE' },
  { name: 'destination_url', label: 'Destination URL', location: 'form', placeholder: 'https://example.com/landing-page' },
  { name: 'account_id', label: 'Account ID', location: 'form', advanced: true },
  { name: 'account_name', label: 'Account name', location: 'form', advanced: true },
  { name: 'campaign_name', label: 'Campaign name', location: 'form', advanced: true },
  { name: 'ad_set_name', label: 'Ad set name', location: 'form', advanced: true },
  { name: 'description', label: 'Ad description', location: 'form', kind: 'textarea', advanced: true },
  { name: 'policy_text', label: 'Custom policy', location: 'form', kind: 'textarea', advanced: true },
  { name: 'notes', label: 'Reviewer notes', location: 'form', kind: 'textarea', advanced: true },
  { name: 'manual_transcript', label: 'Manual transcript', location: 'form', kind: 'textarea', advanced: true },
  {
    name: 'frame_interval_seconds',
    label: 'Frame interval (seconds)',
    location: 'form',
    kind: 'number',
    defaultValue: '1',
    advanced: true,
  },
  {
    name: 'scene_detection',
    label: 'Scene detection',
    location: 'form',
    kind: 'boolean',
    defaultValue: 'false',
    advanced: true,
  },
];

const paginationFields: RequestField[] = [
  {
    name: 'limit',
    label: 'Limit',
    location: 'query',
    kind: 'number',
    defaultValue: '50',
    description: 'Maximum number of records to return.',
  },
  {
    name: 'cursor',
    label: 'Cursor',
    location: 'query',
    placeholder: 'Cursor returned by the previous page',
  },
];

const jobIdField: RequestField = {
  name: 'job_id',
  label: 'Job ID',
  location: 'path',
  required: true,
  placeholder: 'The job_id returned when the review was created',
};

const endpoints: Endpoint[] = [
  {
    id: 'api-index',
    group: 'getting-started',
    method: 'GET',
    path: '/api/v1',
    title: 'API information',
    description: 'Return the API version, authentication format, documentation links, and platform upload ceiling.',
    auth: false,
  },
  {
    id: 'api-me',
    group: 'getting-started',
    method: 'GET',
    path: '/api/v1/me',
    title: 'Inspect this API key',
    description: 'Return the owned partner, enabled scopes, limits, and key metadata for the supplied token.',
    scope: 'reviews:read',
  },
  {
    id: 'create-simple-job',
    group: 'simple-jobs',
    method: 'POST',
    path: '/api/v1/jobs',
    title: 'Submit creative URL',
    description: 'Accept a creative name and public HTTPS media URL, then return a job_id after the media is validated and queued.',
    scope: 'reviews:create',
    bodyEncoding: 'json',
    fields: [
      { name: 'asset_id', label: 'Asset ID', location: 'json', required: true, placeholder: 'asset_12345' },
      { name: 'creative_name', label: 'Creative name', location: 'json', required: true, placeholder: 'Monday Creative' },
      { name: 'media_url', label: 'Media URL', location: 'json', required: true, placeholder: 'https://cdn.example.com/creative.mp4' },
      {
        name: 'Idempotency-Key',
        label: 'Idempotency key',
        location: 'header',
        placeholder: 'lemmonmaxx-monday-001',
        description: 'Recommended: reuse the same value when retrying this exact submission.',
      },
    ],
  },
  {
    id: 'simple-job-status',
    group: 'simple-jobs',
    method: 'GET',
    path: '/api/v1/jobs/{job_id}',
    title: 'Get job status',
    description: 'Return exactly one of queued, processing, completed, or failed.',
    scope: 'reviews:read',
    fields: [jobIdField],
  },
  {
    id: 'simple-job-result',
    group: 'simple-jobs',
    method: 'GET',
    path: '/api/v1/jobs/{job_id}/result',
    title: 'Get job result',
    description: 'Return the asset ID, creative name, and complete structured analysis result after processing completes.',
    scope: 'reviews:read',
    fields: [jobIdField],
  },
  {
    id: 'scan-creative',
    group: 'creative-monitoring',
    method: 'POST',
    path: '/api/v1/scans/creative',
    title: 'Observe a live creative',
    description: 'Upload the media currently running for an ad. Unchanged content reuses its review; changed content starts the normal AdChecked pipeline.',
    scope: 'scans:write',
    bodyEncoding: 'multipart',
    fields: scanFields,
    mirroredAdIdHeader: true,
  },
  {
    id: 'scan-ads',
    group: 'creative-monitoring',
    method: 'GET',
    path: '/api/v1/scans/ads',
    title: 'List monitored ads',
    description: 'Return the latest fingerprint, observation count, and current review for ads owned by this partner.',
    scope: 'scans:read',
    fields: paginationFields,
  },
  {
    id: 'scan-ad',
    group: 'creative-monitoring',
    method: 'GET',
    path: '/api/v1/scans/ads/{ad_id}',
    title: 'Read one monitored ad',
    description: 'Return the current fingerprint and linked review for one of your own ad IDs.',
    scope: 'scans:read',
    fields: [{ name: 'ad_id', label: 'Ad ID', location: 'path', required: true, placeholder: '23851234567890123' }],
  },
  {
    id: 'scan-observations',
    group: 'creative-monitoring',
    method: 'GET',
    path: '/api/v1/scans/ads/{ad_id}/observations',
    title: 'List change observations',
    description: 'Return the audit trail showing whether each scan was new, changed, retried, or unchanged.',
    scope: 'scans:read',
    fields: [
      { name: 'ad_id', label: 'Ad ID', location: 'path', required: true, placeholder: '23851234567890123' },
      ...paginationFields,
    ],
  },
  {
    id: 'create-review',
    group: 'reviews-results',
    method: 'POST',
    path: '/api/v1/reviews',
    title: 'Create a review',
    description: 'Submit a creative, ad copy, or both without the live-ad fingerprint comparison.',
    scope: 'reviews:create',
    bodyEncoding: 'multipart',
    fields: reviewFormFields,
  },
  {
    id: 'review-history',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews',
    title: 'List review history',
    description: 'Return owned or authorized offer history with overall_status, summary, finding_count, preview findings, and media links.',
    scope: 'history:read',
    fields: [
      { name: 'offer_id', label: 'Shared offer ID', location: 'query', placeholder: 'acp', description: 'Optional. Requires shared internal history access for this offer.' },
      ...paginationFields,
    ],
  },
  {
    id: 'review-status',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews/{job_id}',
    title: 'Check review status',
    description: 'Poll until report_ready is true, or inspect the failure message when processing cannot finish.',
    scope: 'reviews:read',
    fields: [jobIdField],
  },
  {
    id: 'review-result',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews/{job_id}/result',
    title: 'Get full review results',
    description: 'Return an owned report or one explicitly authorized shared-offer report, findings, decisions, and artifact links.',
    scope: 'reviews:read',
    fields: [
      jobIdField,
      { name: 'offer_id', label: 'Offer ID', location: 'query', placeholder: 'Optional authorized offer slug' },
    ],
  },
  {
    id: 'review-evidence',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews/{job_id}/evidence',
    title: 'Get transcript, OCR, and frames',
    description: 'Return transcript, on-screen text, visual observations, limitations, and owned evidence-frame URLs.',
    scope: 'evidence:read',
    fields: [jobIdField],
  },
  {
    id: 'report-json',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews/{job_id}/report.json',
    title: 'Download JSON report',
    description: 'Download the stored machine-readable report for a completed review.',
    scope: 'reports:download',
    fields: [
      jobIdField,
      { name: 'offer_id', label: 'Offer ID', location: 'query', placeholder: 'Optional authorized offer slug' },
    ],
  },
  {
    id: 'report-pdf',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews/{job_id}/report.pdf',
    title: 'Download PDF report',
    description: 'Download an offer-specific PDF report. Omit offer_id to use the review’s primary offer.',
    scope: 'reports:download',
    fields: [
      jobIdField,
      { name: 'offer_id', label: 'Offer ID', location: 'query', placeholder: 'Optional offer slug' },
    ],
  },
  {
    id: 'review-thumbnail',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews/{job_id}/thumbnail',
    title: 'Get review thumbnail',
    description: 'Return the first available evidence frame for an owned or authorized shared review.',
    scope: 'evidence:read',
    fields: [jobIdField],
  },
  {
    id: 'review-media',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews/{job_id}/media',
    title: 'Stream review media',
    description: 'Stream an authorized Google Drive creative with HTTP byte-range support. Keep the Bearer key on your backend and proxy Range requests from the browser.',
    scope: 'evidence:read',
    fields: [
      jobIdField,
      {
        name: 'Range',
        label: 'Byte range',
        location: 'header',
        defaultValue: 'bytes=0-1048575',
        description: 'Optional. The default interactive test downloads only the first MiB.',
      },
    ],
  },
  {
    id: 'review-frame',
    group: 'reviews-results',
    method: 'GET',
    path: '/api/v1/reviews/{job_id}/frames/{filename}',
    title: 'Get an evidence frame',
    description: 'Return one protected frame using a filename received from the evidence response.',
    scope: 'evidence:read',
    fields: [
      jobIdField,
      { name: 'filename', label: 'Frame filename', location: 'path', required: true, placeholder: 'frame_000012.jpg' },
    ],
  },
  {
    id: 'delete-review',
    group: 'reviews-results',
    method: 'DELETE',
    path: '/api/v1/reviews/{job_id}',
    title: 'Delete a completed review',
    description: 'Permanently delete a completed or failed review owned by this partner.',
    scope: 'reviews:delete',
    fields: [jobIdField],
    destructive: true,
  },
  {
    id: 'start-upload',
    group: 'large-uploads',
    method: 'POST',
    path: '/api/v1/uploads',
    title: 'Start a resumable upload',
    description: 'Register the file metadata and receive the required chunk size, count, and temporary upload ID.',
    scope: 'reviews:create',
    bodyEncoding: 'json',
    fields: [
      { name: 'file_name', label: 'File name', location: 'json', required: true, placeholder: 'large-creative.mp4' },
      { name: 'content_type', label: 'Content type', location: 'json', required: true, placeholder: 'video/mp4' },
      { name: 'size', label: 'File size in bytes', location: 'json', kind: 'number', required: true, placeholder: '52428800' },
    ],
  },
  {
    id: 'upload-chunk',
    group: 'large-uploads',
    method: 'PUT',
    path: '/api/v1/uploads/{upload_id}/chunks/{chunk_index}',
    title: 'Upload one chunk',
    description: 'Send one exact binary chunk. Retry the same index safely when a network request fails.',
    scope: 'reviews:create',
    bodyEncoding: 'binary',
    fields: [
      { name: 'upload_id', label: 'Upload ID', location: 'path', required: true, placeholder: 'ID returned by start upload' },
      { name: 'chunk_index', label: 'Chunk index', location: 'path', kind: 'number', required: true, defaultValue: '0' },
      { name: 'chunk', label: 'Binary chunk', location: 'body', kind: 'file', required: true, description: 'Its byte length must match the expected size for this index.' },
    ],
  },
  {
    id: 'complete-upload',
    group: 'large-uploads',
    method: 'POST',
    path: '/api/v1/uploads/{upload_id}/complete',
    title: 'Complete a resumable upload',
    description: 'Assemble all received chunks and create the AdChecked review.',
    scope: 'reviews:create',
    bodyEncoding: 'urlencoded',
    fields: [
      { name: 'upload_id', label: 'Upload ID', location: 'path', required: true, placeholder: 'ID returned by start upload' },
      ...reviewFormFields.filter((field) => field.kind !== 'file'),
    ],
  },
];

const methodStyles: Record<HttpMethod, string> = {
  GET: 'border-blue-600/20 bg-blue-500/10 text-blue-700 dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-300',
  POST: 'border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300',
  PUT: 'border-amber-600/20 bg-amber-500/10 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300',
  DELETE: 'border-red-600/20 bg-red-500/10 text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300',
};

function fieldDefaults(endpoint: Endpoint) {
  return Object.fromEntries(
    (endpoint.fields ?? [])
      .filter((field) => field.kind !== 'file')
      .map((field) => [field.name, field.defaultValue ?? ''])
  );
}

function initialValues() {
  return Object.fromEntries(endpoints.map((endpoint) => [endpoint.id, fieldDefaults(endpoint)]));
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function fieldValue(
  endpointId: string,
  field: RequestField,
  values: Record<string, Record<string, string>>,
  files: Record<string, Record<string, File | null>>,
) {
  if (field.kind === 'file') return files[endpointId]?.[field.name]?.name ?? '';
  return values[endpointId]?.[field.name] ?? field.defaultValue ?? '';
}

function resolvedPath(
  endpoint: Endpoint,
  values: Record<string, Record<string, string>>,
  files: Record<string, Record<string, File | null>>,
  placeholders: boolean,
) {
  let path = endpoint.path;
  for (const field of endpoint.fields ?? []) {
    if (field.location !== 'path') continue;
    const value = fieldValue(endpoint.id, field, values, files);
    const replacement = value || (placeholders ? `{${field.name}}` : '');
    path = path.replace(`{${field.name}}`, encodeURIComponent(replacement));
  }
  const params = new URLSearchParams();
  for (const field of endpoint.fields ?? []) {
    if (field.location !== 'query') continue;
    const value = fieldValue(endpoint.id, field, values, files);
    if (value) params.set(field.name, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function requestJsonValue(field: RequestField, value: string) {
  if (field.kind === 'number') return Number(value);
  if (field.kind === 'boolean') return value === 'true';
  return value;
}

function curlFor(
  endpoint: Endpoint,
  values: Record<string, Record<string, string>>,
  files: Record<string, Record<string, File | null>>,
) {
  const url = `${PRODUCTION_ORIGIN}${resolvedPath(endpoint, values, files, true)}`;
  const parts = [`curl -X ${endpoint.method} ${shellQuote(url)}`];
  if (endpoint.auth !== false) parts.push("  -H 'Authorization: Bearer YOUR_API_KEY'");

  for (const field of endpoint.fields ?? []) {
    if (field.location !== 'header') continue;
    const value = fieldValue(endpoint.id, field, values, files) || `{${field.name}}`;
    parts.push(`  -H ${shellQuote(`${field.name}: ${value}`)}`);
  }
  if (endpoint.mirroredAdIdHeader) {
    const adId = values[endpoint.id]?.ad_id || '{ad_id}';
    parts.push(`  -H ${shellQuote(`X-Vibe-Ad-Id: ${adId}`)}`);
  }

  if (endpoint.bodyEncoding === 'json') {
    const payload: Record<string, unknown> = {};
    for (const field of endpoint.fields ?? []) {
      if (field.location !== 'json') continue;
      const value = fieldValue(endpoint.id, field, values, files) || `{${field.name}}`;
      payload[field.name] = field.kind === 'number' && !value.startsWith('{') ? Number(value) : value;
    }
    parts.push("  -H 'Content-Type: application/json'");
    parts.push(`  --data ${shellQuote(JSON.stringify(payload))}`);
  }

  if (endpoint.bodyEncoding === 'multipart') {
    for (const field of endpoint.fields ?? []) {
      if (field.location !== 'form') continue;
      const value = fieldValue(endpoint.id, field, values, files);
      if (!value && !field.required) continue;
      if (field.kind === 'file') {
        parts.push(`  -F ${shellQuote(`${field.name}=@${value || 'creative.mp4'}`)}`);
      } else {
        parts.push(`  -F ${shellQuote(`${field.name}=${value || `{${field.name}}`}`)}`);
      }
    }
  }

  if (endpoint.bodyEncoding === 'urlencoded') {
    for (const field of endpoint.fields ?? []) {
      if (field.location !== 'form') continue;
      const value = fieldValue(endpoint.id, field, values, files);
      if (!value && !field.required) continue;
      parts.push(`  --data-urlencode ${shellQuote(`${field.name}=${value}`)}`);
    }
  }

  if (endpoint.bodyEncoding === 'binary') {
    const bodyFile = (endpoint.fields ?? []).find((field) => field.location === 'body');
    const fileName = bodyFile ? fieldValue(endpoint.id, bodyFile, values, files) : '';
    parts.push(`  --data-binary ${shellQuote(`@${fileName || 'chunk.bin'}`)}`);
  }

  return parts.join(' \\\n');
}

function MethodBadge({ method }: { method: HttpMethod }) {
  return (
    <Badge variant="outline" className={cn('min-w-14 justify-center font-mono', methodStyles[method])}>
      {method}
    </Badge>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {copied ? <Check /> : <Clipboard />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

function ResponsePanel({ response }: { response: EndpointResponse }) {
  const successful = response.status >= 200 && response.status < 300;
  return (
    <div className="grid gap-3 rounded-xl border bg-zinc-950 p-4 text-zinc-100 shadow-inner">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge
          variant="outline"
          className={cn(
            'border-white/15 bg-white/5',
            successful ? 'text-emerald-300' : 'text-red-300'
          )}
        >
          {response.status || 'Network error'} {response.statusText}
        </Badge>
        <span className="text-zinc-400">{response.elapsedMs} ms</span>
        {response.contentType && <span className="text-zinc-500">{response.contentType}</span>}
      </div>
      {response.error && <p className="text-sm text-red-300">{response.error}</p>}
      {response.body && (
        <pre className="max-h-[34rem] overflow-auto whitespace-pre-wrap break-words text-[13px] leading-6 text-zinc-200">
          <code>{response.body}</code>
        </pre>
      )}
      {response.binaryUrl && (
        <div className="grid gap-3">
          {response.contentType.startsWith('image/') && (
            <img
              src={response.binaryUrl}
              alt="Authenticated API response preview"
              className="max-h-80 w-auto rounded-lg border border-white/10 object-contain"
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              nativeButton={false}
              size="sm"
              variant="secondary"
              render={<a href={response.binaryUrl} download={response.binaryName} />}
            >
              <Download /> Download response
            </Button>
            {typeof response.binarySize === 'number' && (
              <span className="text-xs text-zinc-400">{response.binarySize.toLocaleString()} bytes</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RequestFieldControl({
  endpoint,
  field,
  value,
  file,
  resetVersion,
  onChange,
  onFileChange,
}: {
  endpoint: Endpoint;
  field: RequestField;
  value: string;
  file: File | null;
  resetVersion: number;
  onChange: (value: string) => void;
  onFileChange: (file: File | null) => void;
}) {
  const id = `${endpoint.id}-${field.name}`;
  return (
    <div className={cn('grid content-start gap-2', (field.kind === 'textarea' || field.kind === 'file') && 'sm:col-span-2')}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{field.label}</Label>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase text-muted-foreground">
            {field.location}
          </Badge>
          {field.required && <span className="text-xs font-medium text-destructive">Required</span>}
        </div>
      </div>
      {field.kind === 'textarea' ? (
        <Textarea
          id={id}
          value={value}
          placeholder={field.placeholder}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.kind === 'boolean' ? (
        <div className="flex h-9 items-center justify-between rounded-lg border bg-background px-3">
          <span className="text-sm text-muted-foreground">{value === 'true' ? 'Enabled' : 'Disabled'}</span>
          <Switch id={id} checked={value === 'true'} onCheckedChange={(checked) => onChange(String(checked))} />
        </div>
      ) : field.kind === 'file' ? (
        <Input
          key={`${id}-${resetVersion}`}
          id={id}
          type="file"
          accept={field.accept}
          className="h-10 cursor-pointer py-1.5"
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
        />
      ) : (
        <Input
          id={id}
          type={field.kind === 'number' ? 'number' : 'text'}
          value={value}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {field.description && <p className="text-xs leading-5 text-muted-foreground">{field.description}</p>}
      {field.kind === 'file' && file && (
        <p className="text-xs text-muted-foreground">
          {file.name} · {file.size.toLocaleString()} bytes
        </p>
      )}
    </div>
  );
}

function EndpointCard({
  endpoint,
  isOpen,
  apiKey,
  values,
  files,
  response,
  loading,
  resetVersion,
  onToggle,
  onValueChange,
  onFileChange,
  onExecute,
  onClear,
}: {
  endpoint: Endpoint;
  isOpen: boolean;
  apiKey: string;
  values: Record<string, Record<string, string>>;
  files: Record<string, Record<string, File | null>>;
  response?: EndpointResponse;
  loading: boolean;
  resetVersion: number;
  onToggle: () => void;
  onValueChange: (field: string, value: string) => void;
  onFileChange: (field: string, file: File | null) => void;
  onExecute: () => void;
  onClear: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advancedFields = (endpoint.fields ?? []).filter((field) => field.advanced);
  const visibleFields = (endpoint.fields ?? []).filter((field) => !field.advanced || showAdvanced);
  const curl = useMemo(() => curlFor(endpoint, values, files), [endpoint, values, files]);
  const needsKey = endpoint.auth !== false;

  return (
    <Card id={endpoint.id} className="scroll-mt-6 overflow-hidden" size="sm">
      <button
        type="button"
        className="grid w-full gap-3 px-4 py-1 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <MethodBadge method={endpoint.method} />
        <span className="grid min-w-0 gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <code className="break-all text-sm font-semibold">{endpoint.path}</code>
            <span className="text-sm text-muted-foreground">{endpoint.title}</span>
          </span>
          <span className="hidden text-xs leading-5 text-muted-foreground sm:block">{endpoint.description}</span>
        </span>
        <span className="flex items-center justify-between gap-2 sm:justify-end">
          {endpoint.scope && <Badge variant="outline" className="font-normal">{endpoint.scope}</Badge>}
          <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
        </span>
      </button>

      {isOpen && (
        <>
          <Separator />
          <CardContent className="grid gap-5 pt-1">
            <p className="text-sm leading-6 text-muted-foreground sm:hidden">{endpoint.description}</p>

            {endpoint.destructive && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>This is a permanent action</AlertTitle>
                <AlertDescription>Only completed or failed reviews can be deleted. The request acts on real production data.</AlertDescription>
              </Alert>
            )}

            {needsKey && !apiKey && (
              <Alert>
                <LockKeyhole />
                <AlertTitle>Load an API key first</AlertTitle>
                <AlertDescription>The key panel is at the top of this page. Your token remains only in this browser tab’s memory.</AlertDescription>
              </Alert>
            )}

            {visibleFields.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                {visibleFields.map((field) => (
                  <RequestFieldControl
                    key={field.name}
                    endpoint={endpoint}
                    field={field}
                    value={values[endpoint.id]?.[field.name] ?? field.defaultValue ?? ''}
                    file={files[endpoint.id]?.[field.name] ?? null}
                    resetVersion={resetVersion}
                    onChange={(value) => onValueChange(field.name, value)}
                    onFileChange={(file) => onFileChange(field.name, file)}
                  />
                ))}
              </div>
            )}

            {advancedFields.length > 0 && (
              <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setShowAdvanced((current) => !current)}>
                <ChevronDown className={cn('transition-transform', showAdvanced && 'rotate-180')} />
                {showAdvanced ? 'Hide optional review settings' : `Show ${advancedFields.length} optional fields`}
              </Button>
            )}

            <div className="overflow-hidden rounded-xl border bg-zinc-950 text-zinc-100">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2">
                <span className="flex items-center gap-2 text-xs text-zinc-400"><Terminal className="size-3.5" /> cURL</span>
                <CopyButton label="Copy cURL" value={curl} />
              </div>
              <pre className="max-h-80 overflow-auto p-4 text-[13px] leading-6 text-zinc-200"><code>{curl}</code></pre>
            </div>

            {response && <ResponsePanel response={response} />}
          </CardContent>
          <CardFooter className="flex flex-wrap justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {endpoint.method === 'GET' ? 'Safe read request' : 'Sends a real production request'}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClear}>
                <RotateCcw /> Clear
              </Button>
              <Button
                type="button"
                size="sm"
                variant={endpoint.destructive ? 'destructive' : 'default'}
                disabled={loading || (needsKey && !apiKey)}
                onClick={onExecute}
              >
                {loading ? <LoaderCircle className="animate-spin" /> : endpoint.destructive ? <Trash2 /> : <Play />}
                {loading ? 'Sending…' : 'Send request'}
              </Button>
            </div>
          </CardFooter>
        </>
      )}
    </Card>
  );
}

function normalizedKey(value: string) {
  return value.trim().replace(/^Bearer\s+/i, '');
}

export function ApiReferencePage({ embedded = false }: { embedded?: boolean }) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [openEndpoints, setOpenEndpoints] = useState(() => new Set(['scan-creative']));
  const [values, setValues] = useState<Record<string, Record<string, string>>>(initialValues);
  const [files, setFiles] = useState<Record<string, Record<string, File | null>>>({});
  const [responses, setResponses] = useState<Record<string, EndpointResponse>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [resetVersions, setResetVersions] = useState<Record<string, number>>({});
  const objectUrls = useRef<Record<string, string>>({});
  const key = normalizedKey(apiKey);

  useEffect(() => {
    const previousTitle = document.title;
    if (!embedded) document.title = 'AdChecked Partner API · Interactive reference';
    const hash = window.location.hash.slice(1);
    if (endpoints.some((endpoint) => endpoint.id === hash)) {
      setOpenEndpoints((current) => new Set(current).add(hash));
    }
    return () => {
      if (!embedded) document.title = previousTitle;
      for (const url of Object.values(objectUrls.current)) URL.revokeObjectURL(url);
    };
  }, [embedded]);

  function toggleEndpoint(id: string) {
    setOpenEndpoints((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setFieldValue(endpointId: string, field: string, value: string) {
    setValues((current) => ({
      ...current,
      [endpointId]: { ...current[endpointId], [field]: value },
    }));
  }

  function setEndpointFile(endpointId: string, field: string, file: File | null) {
    setFiles((current) => ({
      ...current,
      [endpointId]: { ...current[endpointId], [field]: file },
    }));
  }

  function clearResponseUrl(endpointId: string) {
    const url = objectUrls.current[endpointId];
    if (url) {
      URL.revokeObjectURL(url);
      delete objectUrls.current[endpointId];
    }
  }

  function clearEndpoint(endpoint: Endpoint) {
    clearResponseUrl(endpoint.id);
    setValues((current) => ({ ...current, [endpoint.id]: fieldDefaults(endpoint) }));
    setFiles((current) => ({ ...current, [endpoint.id]: {} }));
    setResponses((current) => {
      const next = { ...current };
      delete next[endpoint.id];
      return next;
    });
    setResetVersions((current) => ({ ...current, [endpoint.id]: (current[endpoint.id] ?? 0) + 1 }));
  }

  async function execute(endpoint: Endpoint) {
    clearResponseUrl(endpoint.id);
    const missing = (endpoint.fields ?? []).filter((field) => {
      if (!field.required) return false;
      return !fieldValue(endpoint.id, field, values, files);
    });
    if (missing.length) {
      setResponses((current) => ({
        ...current,
        [endpoint.id]: {
          status: 0,
          statusText: '',
          elapsedMs: 0,
          contentType: '',
          error: `Complete the required ${missing.map((field) => field.label).join(', ')} ${missing.length === 1 ? 'field' : 'fields'} first.`,
        },
      }));
      return;
    }
    setLoading((current) => ({ ...current, [endpoint.id]: true }));
    const started = performance.now();
    try {
      const requestPath = resolvedPath(endpoint, values, files, false);
      const headers = new Headers({ Accept: 'application/json' });
      if (endpoint.auth !== false) headers.set('Authorization', `Bearer ${key}`);
      for (const field of endpoint.fields ?? []) {
        if (field.location !== 'header') continue;
        const value = fieldValue(endpoint.id, field, values, files);
        if (value) headers.set(field.name, value);
      }
      if (endpoint.mirroredAdIdHeader) {
        headers.set('X-Vibe-Ad-Id', values[endpoint.id]?.ad_id ?? '');
      }

      let body: BodyInit | undefined;
      if (endpoint.bodyEncoding === 'multipart') {
        const form = new FormData();
        for (const field of endpoint.fields ?? []) {
          if (field.location !== 'form') continue;
          if (field.kind === 'file') {
            const file = files[endpoint.id]?.[field.name];
            if (file) form.append(field.name, file);
            continue;
          }
          const value = fieldValue(endpoint.id, field, values, files);
          if (value || field.required || field.kind === 'boolean') form.append(field.name, value);
        }
        body = form;
      } else if (endpoint.bodyEncoding === 'urlencoded') {
        const form = new URLSearchParams();
        for (const field of endpoint.fields ?? []) {
          if (field.location !== 'form') continue;
          const value = fieldValue(endpoint.id, field, values, files);
          if (value || field.required || field.kind === 'boolean') form.set(field.name, value);
        }
        body = form;
      } else if (endpoint.bodyEncoding === 'json') {
        const payload: Record<string, unknown> = {};
        for (const field of endpoint.fields ?? []) {
          if (field.location !== 'json') continue;
          const value = fieldValue(endpoint.id, field, values, files);
          if (value || field.required) payload[field.name] = requestJsonValue(field, value);
        }
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(payload);
      } else if (endpoint.bodyEncoding === 'binary') {
        const bodyField = (endpoint.fields ?? []).find((field) => field.location === 'body');
        const file = bodyField ? files[endpoint.id]?.[bodyField.name] : null;
        if (file) {
          headers.set('Content-Type', file.type || 'application/octet-stream');
          body = file;
        }
      }

      const response = await fetch(requestPath, { method: endpoint.method, headers, body });
      const elapsedMs = Math.round(performance.now() - started);
      const contentType = response.headers.get('content-type') ?? '';
      const disposition = response.headers.get('content-disposition') ?? '';
      const binary = contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.includes('application/pdf') || contentType.includes('application/octet-stream');

      if (binary && response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        objectUrls.current[endpoint.id] = url;
        const nameMatch = disposition.match(/filename="?([^";]+)"?/i);
        setResponses((current) => ({
          ...current,
          [endpoint.id]: {
            status: response.status,
            statusText: response.statusText,
            elapsedMs,
            contentType,
            binaryUrl: url,
            binaryName: nameMatch?.[1] ?? `${endpoint.id}-response`,
            binarySize: blob.size,
          },
        }));
        return;
      }

      const text = await response.text();
      let formatted = text;
      if (text && contentType.includes('json')) {
        try {
          formatted = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          formatted = text;
        }
      }
      setResponses((current) => ({
        ...current,
        [endpoint.id]: {
          status: response.status,
          statusText: response.statusText,
          elapsedMs,
          contentType,
          body: formatted || '(empty response body)',
        },
      }));
    } catch (error) {
      setResponses((current) => ({
        ...current,
        [endpoint.id]: {
          status: 0,
          statusText: '',
          elapsedMs: Math.round(performance.now() - started),
          contentType: '',
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setLoading((current) => ({ ...current, [endpoint.id]: false }));
    }
  }

  return (
    <div className={embedded ? 'grid gap-5 pb-16' : 'grid gap-6 pb-16'}>
      <section className="relative overflow-hidden rounded-3xl border bg-card px-6 py-8 shadow-sm sm:px-8">
        <div className="pointer-events-none absolute -right-28 -top-40 size-96 rounded-full bg-chart-2/10 blur-3xl" />
        <div className="relative grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-end">
          <div className="grid max-w-4xl gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">API v1</Badge>
              <Badge variant="outline">OpenAPI 3.1</Badge>
              <Badge variant="outline" className="text-emerald-700 dark:text-emerald-300"><span className="size-1.5 rounded-full bg-emerald-500" /> Production</Badge>
            </div>
            <div className="grid gap-2">
              <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">AdChecked Partner API</h1>
              <p className="max-w-3xl text-base leading-7 text-muted-foreground">
                Start with the three LemmonMaxx test endpoints for URL submission, normalized job status,
                and complete JSON results. The richer upload, scan, evidence, and report APIs remain available below.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton label="Copy base URL" value={`${PRODUCTION_ORIGIN}/api/v1`} />
            </div>
          </div>

          <Card className="relative bg-background/80 backdrop-blur" size="sm">
            <CardHeader>
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg bg-secondary"><KeyRound className="size-4" /></span>
                <div>
                  <CardTitle>API key</CardTitle>
                  <CardDescription>Held only in this tab’s memory.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-2">
              <Label htmlFor="partner-api-key">Bearer token</Label>
              <div className="flex gap-2">
                <Input
                  id="partner-api-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  placeholder="vc_live_…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowKey((current) => !current)}
                  aria-label={showKey ? 'Hide API key' : 'Show API key'}
                >
                  {showKey ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  {key ? <ShieldCheck className="size-3.5 text-emerald-600" /> : <Unplug className="size-3.5" />}
                  {key ? 'Key loaded' : 'No key loaded'}
                </span>
                {key && (
                  <Button type="button" variant="ghost" size="xs" onClick={() => setApiKey('')}>Clear key</Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <Alert>
        <AlertTriangle />
        <AlertTitle>This console talks to the real production API</AlertTitle>
        <AlertDescription>
          GET requests only read data. POST, PUT, and DELETE can create reviews, upload media, or delete completed data.
          Copyable cURL always uses <code className="rounded bg-muted px-1.5 py-0.5">YOUR_API_KEY</code> so the loaded token is never copied accidentally.
        </AlertDescription>
      </Alert>

      <div className="grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="grid gap-3 lg:sticky lg:top-6">
          <div className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Endpoint groups</div>
          <nav className="grid gap-1" aria-label="API endpoint groups">
            {groups.map((group) => {
              const Icon = group.icon;
              const count = endpoints.filter((endpoint) => endpoint.group === group.id).length;
              return (
                <a
                  key={group.id}
                  href={`#group-${group.id}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Icon className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{group.title}</span>
                  <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[10px]">{count}</Badge>
                </a>
              );
            })}
          </nav>
          <Separator />
          <div className="grid gap-2 rounded-xl border bg-card p-3 text-xs leading-5 text-muted-foreground">
            <div className="flex items-center gap-2 font-medium text-foreground"><ScanSearch className="size-4" /> Recommended first test</div>
            <p>Open “Submit creative URL,” send one public MP4 or image URL, then paste its job_id into the next two endpoints.</p>
          </div>
        </aside>

        <main className="min-w-0 grid gap-9">
          {groups.map((group) => {
            const Icon = group.icon;
            const groupEndpoints = endpoints.filter((endpoint) => endpoint.group === group.id);
            return (
              <section key={group.id} id={`group-${group.id}`} className="scroll-mt-6 grid gap-3">
                <div className="flex items-start gap-3 px-1">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary"><Icon className="size-4" /></span>
                  <div>
                    <h2 className="font-heading text-xl font-semibold tracking-tight">{group.title}</h2>
                    <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{group.description}</p>
                  </div>
                </div>
                <div className="grid gap-2">
                  {groupEndpoints.map((endpoint) => (
                    <EndpointCard
                      key={endpoint.id}
                      endpoint={endpoint}
                      isOpen={openEndpoints.has(endpoint.id)}
                      apiKey={key}
                      values={values}
                      files={files}
                      response={responses[endpoint.id]}
                      loading={Boolean(loading[endpoint.id])}
                      resetVersion={resetVersions[endpoint.id] ?? 0}
                      onToggle={() => toggleEndpoint(endpoint.id)}
                      onValueChange={(field, value) => setFieldValue(endpoint.id, field, value)}
                      onFileChange={(field, file) => setEndpointFile(endpoint.id, field, file)}
                      onExecute={() => execute(endpoint)}
                      onClear={() => clearEndpoint(endpoint)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </main>
      </div>
    </div>
  );
}
