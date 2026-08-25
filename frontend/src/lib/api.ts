export type Status = {
  job_id: string;
  file_name: string;
  file_size?: number | null;
  status: string;
  progress: number;
  message: string;
  report_ready: boolean;
  has_creative?: boolean;
  has_ad_copy?: boolean;
  batch_id?: string | null;
  batch_item_id?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  offer_ids?: string[];
  primary_offer_id?: string | null;
};

export type ReviewSource = {
  kind?: 'google_drive_file' | 'google_sheet' | 'meta_ads' | null;
  status: 'linked' | 'not_found' | 'ambiguous' | 'unavailable';
  url?: string | null;
  file_id?: string | null;
  label: string;
  message: string;
  checked_at: number;
};

export type ReviewSources = {
  sources: ReviewSource[];
};

export type DriveCreativeFile = {
  file_id: string;
  name: string;
  mime_type: string;
  size?: number | null;
  modified_time?: string | null;
  web_view_link: string;
};

export type DriveBrowserItem = DriveCreativeFile & {
  kind: 'folder' | 'creative';
  selectable: boolean;
  disabled_reason?: string | null;
};

export type DriveFolder = {
  folder_id: string;
  name: string;
  web_view_link: string;
};

export type DriveBrowserResult = {
  current_folder: DriveFolder;
  items: DriveBrowserItem[];
  max_selection: number;
};

export type DriveSelectionResult = {
  files: DriveCreativeFile[];
  max_selection: number;
};

export type CreateDriveReviewInput = {
  file_id: string;
  ad_copy: string;
  policy_text: string;
  notes: string;
  manual_transcript: string;
  model: string;
  frame_interval_seconds: number;
  scene_detection: boolean;
  batch_id?: string;
  batch_item_id?: string;
  offer_ids: string[];
};

export type OfferOverride = {
  override_id: string;
  title: string;
  guidance: string;
  rationale: string;
  enabled: boolean;
};

export type OfferProfile = {
  offer_id: string;
  display_name: string;
  official_guidelines: string;
  internal_overrides: OfferOverride[];
  enabled: boolean;
  is_default: boolean;
  version: number;
  created_at?: number | null;
  updated_at?: number | null;
};

export type OfferProfileInput = Pick<
  OfferProfile,
  'display_name' | 'official_guidelines' | 'internal_overrides' | 'enabled' | 'is_default'
>;

export type OfferCatalogItem = Pick<
  OfferProfile,
  'offer_id' | 'display_name' | 'enabled' | 'is_default' | 'version'
> & {
  configured: boolean;
  override_count: number;
};

export type Finding = {
  severity: 'low' | 'medium' | 'high';
  source: 'audio' | 'onscreen_text' | 'visual' | 'ad_copy' | 'policy';
  timestamp_start?: string | null;
  timestamp_end?: string | null;
  evidence: string;
  policy_reason: string;
  suggested_fix: string;
  confidence: 'low' | 'medium' | 'high';
  internal_override?: {
    override_id: string;
    title: string;
    disposition: 'accepted' | 'partial' | 'uncertain';
    rationale: string;
  } | null;
};

export type OverallStatus = 'green' | 'yellow' | 'red';
export type LegacyOverallStatus = 'amber' | 'orange' | 'pass' | 'needs_review' | 'likely_violation';
export type ResultStatus = OverallStatus | LegacyOverallStatus;

export type OfferOutcome = {
  offer_id: string;
  offer_name: string;
  evaluation_state: 'evaluated' | 'disabled' | 'missing_guidelines';
  overall_status: OverallStatus | null;
  creative_result: OverallStatus | null;
  ad_copy_result: OverallStatus | null;
  with_override?: boolean;
  message: string;
};

export type AppliedPolicyOverride = {
  override_id: string;
  title: string;
  source: Finding['source'];
  evidence: string;
  rationale: string;
};

export type OfferResult = {
  offer_id: string;
  offer_name: string;
  guideline_version?: number | null;
  overall_status: ResultStatus;
  summary: string;
  source_results?: {
    creative?: {
      status: ResultStatus;
      summary: string;
    } | null;
    ad_copy?: {
      status: ResultStatus;
      summary: string;
    } | null;
  };
  findings: Finding[];
  applied_overrides?: AppliedPolicyOverride[];
  safe_rewrite: { ad_copy: string; onscreen_text: string[] };
  limitations: string[];
  policy_sources?: string[];
  internal_disposition?: 'clear' | 'accepted_with_override' | 'action_required' | 'human_review';
};

export type Report = OfferResult & {
  schema_version?: number;
  primary_offer_id?: string | null;
  offer_results?: OfferResult[];
  offer_outcomes?: OfferOutcome[];
};

export type ReviewEvidenceFrame = {
  filename: string;
  timestamp: number | null;
  url: string;
};

export type ReviewEvidence = {
  frames: ReviewEvidenceFrame[];
};

export type ClientDecisionValue = 'pending' | 'approved' | 'disapproved';
export type ClientFeedbackReason =
  | 'false_positive'
  | 'missed_policy_issue'
  | 'partner_preference'
  | 'one_off_exception'
  | 'business_decision';

export type ClientReviewDecision = {
  decided_at: number;
  decision: ClientDecisionValue;
  feedback_note: string | null;
  feedback_reason: ClientFeedbackReason | null;
};

export type ClientReviewItem = {
  ai_status: OverallStatus;
  batch_created_at: number;
  batch_id: string | null;
  batch_source_label: string | null;
  created_at: number;
  decision: ClientReviewDecision | null;
  file_name: string;
  issue_summary: string | null;
  job_id: string;
  media_kind: 'video' | 'image' | 'copy_only';
  preview: {
    finding_count: number;
    findings: string[];
    google_drive_url: string | null;
    summary: string;
  };
};

export type ClientReviewList = {
  client_id: string;
  display_name: string;
  reviews: ClientReviewItem[];
};

export type ClientPortalSummary = {
  category: string;
  client_id: string;
  display_name: string;
};

export type ClientSession = {
  portals: ClientPortalSummary[];
  role: 'admin' | 'client';
  username: string;
};

export type ClientReviewDetail = {
  client_id: string;
  display_name: string;
  review: ClientReviewItem;
  report: OfferResult;
  evidence_frames: ReviewEvidenceFrame[];
  google_drive_url: string | null;
  report_pdf_url: string;
};

export type ReviewHistoryItem = Status & {
  overall_status?: Report['overall_status'] | null;
  creative_result?: Report['overall_status'] | null;
  ad_copy_result?: Report['overall_status'] | null;
  offer_outcomes?: OfferOutcome[];
};

export type ReviewHistoryPage = {
  reviews: ReviewHistoryItem[];
  next_cursor: string | null;
  has_more: boolean;
};

export type ReviewBatchItem = {
  item_id: string;
  file_name: string;
  media_kind: 'video' | 'image' | 'copy_only';
  status: string;
  job_id?: string | null;
  result?: OverallStatus | null;
  offer_outcomes?: OfferOutcome[];
  message: string;
};

export type ReviewBatch = {
  batch_id: string;
  created_at: number;
  updated_at: number;
  expected_count: number;
  source_label?: string | null;
  items: ReviewBatchItem[];
  notification_status: string;
};

export type CreateReviewBatchInput = {
  batch_id: string;
  source_label?: string;
  items: Array<Pick<ReviewBatchItem, 'item_id' | 'file_name' | 'media_kind'>>;
};

export type ReviewStats = {
  offer_id: string;
  offer_ids: string[];
  total_reviews: number;
  completed_reviews: number;
  creative_reviews: number;
  copy_only_reviews: number;
  in_progress_reviews: number;
  failed_reviews: number;
  accepted_overrides: number;
  outcomes: Record<OverallStatus, number>;
};

export type DeletedReview = {
  job_id: string;
  deleted_at: number;
};

export type ApiScope =
  | 'reviews:create'
  | 'reviews:read'
  | 'history:read'
  | 'evidence:read'
  | 'reports:download'
  | 'scans:write'
  | 'scans:read'
  | 'reviews:delete';

export type ApiKeyRecord = {
  created_at: number;
  expires_at: number | null;
  key_id: string;
  last_used_at: number | null;
  name: string;
  prefix: string;
  revoked_at: number | null;
  scopes: ApiScope[];
  status: 'active' | 'revoked';
};

export type ApiPartner = {
  active_reviews: number;
  allowed_offer_ids: string[];
  allow_custom_policy: boolean;
  concurrent_review_limit: number;
  created_at: number;
  description: string;
  keys: ApiKeyRecord[];
  max_upload_mb: number;
  month_key: string;
  monthly_review_limit: number;
  monthly_reviews_created: number;
  name: string;
  partner_id: string;
  retention_days: number;
  status: 'active' | 'suspended';
  unlimited_concurrency: boolean;
  unlimited_reviews: boolean;
  updated_at: number;
  webhook_configured: boolean;
  webhook_url: string | null;
};

export type ApiPartnerInput = Pick<
  ApiPartner,
  | 'allowed_offer_ids'
  | 'allow_custom_policy'
  | 'concurrent_review_limit'
  | 'description'
  | 'max_upload_mb'
  | 'monthly_review_limit'
  | 'name'
  | 'retention_days'
  | 'status'
  | 'unlimited_concurrency'
  | 'unlimited_reviews'
  | 'webhook_url'
>;

export type ApiPartnerList = {
  available_scopes: ApiScope[];
  base_url: string;
  partners: ApiPartner[];
};

export type ApiKeyInput = {
  expires_at: number | null;
  name: string;
  scopes: ApiScope[];
};

export type IssuedApiKey = ApiKeyRecord & { token: string };

export type IssuedWebhookSecret = {
  partner_id: string;
  webhook_configured: boolean;
  webhook_signing_secret: string;
};

export type ReviewAutomation = {
  automation_id: string;
  name: string;
  enabled: boolean;
  folder_id: string;
  file_name_pattern: string;
  time_of_day: string;
  timezone: string;
  days_of_week: number[];
  include_subfolders: boolean;
  created_at?: number | null;
  updated_at?: number | null;
  last_run_at?: number | null;
  last_run_status?: string | null;
  last_scheduled_for?: string | null;
  last_run_message?: string | null;
  last_batch_id?: string | null;
};

export type ReviewAutomationInput = Pick<
  ReviewAutomation,
  | 'name'
  | 'enabled'
  | 'folder_id'
  | 'file_name_pattern'
  | 'time_of_day'
  | 'timezone'
  | 'days_of_week'
  | 'include_subfolders'
>;

export type AutomationRunResult = {
  automation: ReviewAutomation;
  status: string;
  message: string;
  matched_count: number;
  queued_count: number;
  batch_id?: string | null;
  job_ids: string[];
};

export type LiveReviewState = {
  job_id: string | null;
  message: string;
  progress: number;
  result: OverallStatus | null;
  status: string;
};

export type LiveScanCopyFinding = {
  ad_count: number;
  ad_ids: string[];
  copy_key: string;
  first_observed_at: number;
  last_observed_at: number;
  primary_text: string;
  review: LiveReviewState;
};

export type LiveScanCreativeFinding = {
  ad_count: number;
  ad_ids: string[];
  ad_set_names: string[];
  campaign_names: string[];
  copies: LiveScanCopyFinding[];
  creative_key: string;
  creative_name: string;
  delivery_statuses: string[];
  first_observed_at: number;
  last_observed_at: number;
  review: LiveReviewState;
};

export type LiveScanAccount = {
  account_id: string;
  account_name: string;
  creatives: LiveScanCreativeFinding[];
  first_observed_at: number;
  last_observed_at: number;
  live_ad_count: number;
  scan_count: number;
  source_url: string | null;
};

export type LiveScanDay = {
  accounts: LiveScanAccount[];
  observation_date: string;
  totals: {
    accounts_observed: number;
    copy_variants: number;
    live_ads: number;
    outcomes: Record<OverallStatus, number>;
    pending: number;
    unique_creatives: number;
  };
};

type ChunkedUpload = {
  upload_id: string;
  chunk_size: number;
  chunk_count: number;
};

const CHUNKED_UPLOAD_THRESHOLD = 8 * 1024 * 1024;
const MAX_CHUNK_ATTEMPTS = 3;
const BACKEND_SHARD_HEADER = 'x-vibe-backend-shard';

function adminHeaders(headers?: HeadersInit): Headers {
  return new Headers(headers);
}

function requestHeaders(headers?: HeadersInit): Headers {
  return new Headers(headers);
}

export function fetchWithAdminAccess(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, headers: requestHeaders(init?.headers) });
}

function clientHeaders(headers?: HeadersInit) {
  return new Headers(headers);
}

function apiErrorMessage(body: string, status: number): string {
  const fallback = `Request failed with status ${status}`;
  const trimmed = body.trim();
  if (!trimmed) return fallback;

  try {
    const payload = JSON.parse(trimmed) as { detail?: unknown };
    const detail = payload.detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    if (Array.isArray(detail)) {
      const messages = detail.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const message = (item as { msg?: unknown }).msg;
        return typeof message === 'string' && message.trim() ? [message.trim()] : [];
      });
      if (messages.length) return messages.join(' ');
    }
  } catch {
    // The API can also return a short plain-text error from an upstream proxy.
  }

  if (!trimmed.startsWith('<')) return trimmed.slice(0, 300);
  return fallback;
}

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error('The server returned an invalid response. Please try again.');
  }
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { ...init, headers: requestHeaders(init?.headers) });
  const body = await response.text();
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return parseJson<T>(body);
}

function reviewShardKey(value?: FormData | CreateDriveReviewInput): string {
  const batchItemId = value instanceof FormData
    ? value.get('batch_item_id')
    : value?.batch_item_id;
  return typeof batchItemId === 'string' && batchItemId.trim()
    ? batchItemId.trim()
    : crypto.randomUUID();
}

function shardHeaders(shardKey: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set(BACKEND_SHARD_HEADER, shardKey);
  return result;
}

export async function createReview(
  form: FormData,
  onUploadProgress?: (progress: number) => void
): Promise<Status> {
  const creative = form.get('creative');
  const shardKey = reviewShardKey(form);
  if (onUploadProgress && creative instanceof File && creative.size > CHUNKED_UPLOAD_THRESHOLD) {
    return createChunkedReview(form, creative, onUploadProgress, shardKey);
  }

  if (!onUploadProgress) {
    return requestJson<Status>('/api/reviews', {
      method: 'POST',
      headers: shardHeaders(shardKey),
      body: form,
    });
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/reviews');
    request.setRequestHeader(BACKEND_SHARD_HEADER, shardKey);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onUploadProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          const status = parseJson<Status>(request.responseText);
          onUploadProgress(100);
          resolve(status);
        } catch (error) {
          reject(error);
        }
        return;
      }
      reject(new Error(apiErrorMessage(request.responseText, request.status)));
    };

    request.onerror = () => reject(new Error('Network error while creating review'));
    request.onabort = () => reject(new Error('Review submission was cancelled'));
    request.send(form);
  });
}

export async function listDriveCreatives(): Promise<DriveCreativeFile[]> {
  const response = await requestJson<{ files: DriveCreativeFile[] }>('/api/drive/files');
  return response.files;
}

export async function browseDriveFolder(folderId?: string): Promise<DriveBrowserResult> {
  const params = new URLSearchParams();
  if (folderId) params.set('folder_id', folderId);
  const query = params.toString();
  return requestJson<DriveBrowserResult>(`/api/drive/browse${query ? `?${query}` : ''}`);
}

export async function resolveDriveSelection(
  folderIds: string[],
  fileIds: string[]
): Promise<DriveSelectionResult> {
  return requestJson<DriveSelectionResult>('/api/drive/selection/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folder_ids: folderIds, file_ids: fileIds }),
  });
}

export async function createDriveReview(input: CreateDriveReviewInput): Promise<Status> {
  const shardKey = reviewShardKey(input);
  return requestJson<Status>('/api/drive/reviews', {
    method: 'POST',
    headers: shardHeaders(shardKey, { 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  });
}

async function createChunkedReview(
  form: FormData,
  creative: File,
  onUploadProgress: (progress: number) => void,
  shardKey: string
): Promise<Status> {
  const upload = await requestJson<ChunkedUpload>('/api/uploads', {
    method: 'POST',
    headers: shardHeaders(shardKey, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      file_name: creative.name,
      content_type: creative.type,
      size: creative.size,
    }),
  });

  onUploadProgress(0);
  for (let index = 0; index < upload.chunk_count; index += 1) {
    const start = index * upload.chunk_size;
    const end = Math.min(start + upload.chunk_size, creative.size);
    await sendChunkWithRetry(
      upload.upload_id,
      index,
      creative.slice(start, end),
      shardKey
    );
    onUploadProgress(Math.round((end / creative.size) * 100));
  }

  const completionForm = new FormData();
  for (const [key, value] of form.entries()) {
    if (key !== 'creative' && typeof value === 'string') completionForm.append(key, value);
  }
  try {
    return await requestJson<Status>(`/api/uploads/${upload.upload_id}/complete`, {
      method: 'POST',
      headers: shardHeaders(shardKey),
      body: completionForm,
    });
  } catch (completionError) {
    try {
      return await getStatus(upload.upload_id);
    } catch {
      throw completionError;
    }
  }
}

async function sendChunkWithRetry(
  uploadId: string,
  index: number,
  chunk: Blob,
  shardKey: string
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetchWithAdminAccess(`/api/uploads/${uploadId}/chunks/${index}`, {
        method: 'PUT',
        headers: shardHeaders(shardKey, { 'content-type': 'application/octet-stream' }),
        body: chunk,
      });
    } catch (error) {
      lastError = error;
    }

    if (response) {
      const body = await response.text();
      if (response.ok) return;
      const error = new Error(apiErrorMessage(body, response.status));
      if (response.status < 500 && response.status !== 408 && response.status !== 429) throw error;
      lastError = error;
    }

    if (attempt < MAX_CHUNK_ATTEMPTS) {
      await new Promise((resolve) => window.setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Upload chunk failed');
}

export async function getStatus(id: string): Promise<Status> {
  return requestJson<Status>(`/api/reviews/${id}`);
}

export async function listReviews(limit = 50): Promise<ReviewHistoryItem[]> {
  return requestJson<ReviewHistoryItem[]>(`/api/reviews?limit=${limit}`);
}

export async function getReviewStats(offerIds: string[] = ['acp']): Promise<ReviewStats> {
  const params = new URLSearchParams({ offer_ids: offerIds.join(',') });
  return requestJson<ReviewStats>(`/api/reviews/stats?${params}`);
}

export async function deleteReview(id: string): Promise<DeletedReview> {
  return requestJson<DeletedReview>(`/api/reviews/${id}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
}

export async function verifyAdminPassword(password: string): Promise<void> {
  await requestJson<{ authorized: boolean }>('/api/admin/session', {
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ password }),
  });
}

export async function getAdminSession(): Promise<void> {
  await requestJson<{ authorized: boolean }>('/api/admin/session');
}

export async function clearAdminSession(): Promise<void> {
  await requestJson<{ signed_out: boolean }>('/api/admin/session', {
    method: 'DELETE',
    keepalive: true,
  });
}

export async function listApiPartners(): Promise<ApiPartnerList> {
  return requestJson<ApiPartnerList>('/api/admin/api/partners', {
    headers: adminHeaders(),
  });
}

export async function createApiPartner(input: ApiPartnerInput): Promise<ApiPartner> {
  return requestJson<ApiPartner>('/api/admin/api/partners', {
    method: 'POST',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  });
}

export async function saveApiPartner(
  partnerId: string,
  input: ApiPartnerInput
): Promise<ApiPartner> {
  return requestJson<ApiPartner>(`/api/admin/api/partners/${encodeURIComponent(partnerId)}`, {
    method: 'PUT',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  });
}

export async function issueApiKey(
  partnerId: string,
  input: ApiKeyInput
): Promise<IssuedApiKey> {
  return requestJson<IssuedApiKey>(
    `/api/admin/api/partners/${encodeURIComponent(partnerId)}/keys`,
    {
      method: 'POST',
      headers: adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    }
  );
}

export async function revokeApiKey(partnerId: string, keyId: string): Promise<void> {
  await requestJson<unknown>(
    `/api/admin/api/partners/${encodeURIComponent(partnerId)}/keys/${encodeURIComponent(keyId)}`,
    { method: 'DELETE', headers: adminHeaders() }
  );
}

export async function rotateApiWebhookSecret(
  partnerId: string
): Promise<IssuedWebhookSecret> {
  return requestJson<IssuedWebhookSecret>(
    `/api/admin/api/partners/${encodeURIComponent(partnerId)}/webhook-secret`,
    { method: 'POST', headers: adminHeaders() }
  );
}

export async function listOfferCatalog(): Promise<OfferCatalogItem[]> {
  const response = await requestJson<{ offers: OfferCatalogItem[] }>('/api/offers/catalog');
  return response.offers;
}

export async function listOfferProfiles(): Promise<OfferProfile[]> {
  const response = await requestJson<{ offers: OfferProfile[] }>('/api/offers', {
    headers: adminHeaders(),
  });
  return response.offers;
}

export async function saveOfferProfile(
  offerId: string,
  input: OfferProfileInput
): Promise<OfferProfile> {
  return requestJson<OfferProfile>(`/api/offers/${encodeURIComponent(offerId)}`, {
    method: 'PUT',
    headers: adminHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  });
}

export async function disableOfferProfile(offerId: string): Promise<OfferProfile> {
  return requestJson<OfferProfile>(`/api/offers/${encodeURIComponent(offerId)}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
}

export async function listReviewAutomations(): Promise<ReviewAutomation[]> {
  const response = await requestJson<
    ReviewAutomation[] | { automations: ReviewAutomation[] }
  >('/api/automations', { headers: adminHeaders() });
  return Array.isArray(response) ? response : response.automations;
}

export async function saveReviewAutomation(
  automationId: string,
  input: ReviewAutomationInput
): Promise<ReviewAutomation> {
  return requestJson<ReviewAutomation>(
    `/api/automations/${encodeURIComponent(automationId)}`,
    {
      method: 'PUT',
      headers: adminHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    }
  );
}

export async function deleteReviewAutomation(automationId: string): Promise<void> {
  await requestJson<unknown>(`/api/automations/${encodeURIComponent(automationId)}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  });
}

export async function runReviewAutomation(automationId: string): Promise<AutomationRunResult> {
  return requestJson<AutomationRunResult>(
    `/api/automations/${encodeURIComponent(automationId)}/run`,
    {
      method: 'POST',
      headers: adminHeaders(),
    }
  );
}

export async function getLiveScans(date: string): Promise<LiveScanDay> {
  const params = new URLSearchParams({ date });
  return requestJson<LiveScanDay>(`/api/live-scans?${params}`);
}

export async function listReviewHistoryPage(
  cursor: string | null = null,
  limit = 50
): Promise<ReviewHistoryPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return requestJson<ReviewHistoryPage>(`/api/reviews/history?${params}`);
}

export async function createReviewBatch(input: CreateReviewBatchInput): Promise<ReviewBatch> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await requestJson<ReviewBatch>('/api/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not create review batch');
}

export async function getBatch(id: string): Promise<ReviewBatch> {
  return requestJson<ReviewBatch>(`/api/batches/${id}`);
}

export async function getBatches(ids: string[]): Promise<ReviewBatch[]> {
  const batchIds = Array.from(new Set(ids.filter(Boolean)));
  if (!batchIds.length) return [];
  const chunks = Array.from(
    { length: Math.ceil(batchIds.length / 100) },
    (_, index) => batchIds.slice(index * 100, (index + 1) * 100)
  );
  const batches = await Promise.all(chunks.map((chunk) => {
    const params = new URLSearchParams({ batch_ids: chunk.join(',') });
    return requestJson<ReviewBatch[]>(`/api/batches?${params}`);
  }));
  return batches.flat();
}

export async function reportBatchUploadFailure(
  batchId: string,
  itemId: string,
  message: string
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await requestJson<ReviewBatch>(`/api/batches/${batchId}/items/${itemId}/failed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not record batch upload failure');
}

export async function getReport(id: string): Promise<Report> {
  return requestJson<Report>(`/api/reviews/${id}/report`);
}

export async function getReviewSources(id: string): Promise<ReviewSources> {
  return requestJson<ReviewSources>(`/api/reviews/${id}/source`);
}

export async function getReviewEvidence(id: string): Promise<ReviewEvidence> {
  return requestJson<ReviewEvidence>(`/api/reviews/${id}/evidence`);
}

export async function verifyClientCredentials(
  username: string,
  password: string
): Promise<ClientSession> {
  return requestJson<ClientSession>('/api/client/session', {
    method: 'POST',
    headers: clientHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ username, password }),
  });
}

export function getClientSession(): Promise<ClientSession> {
  return requestJson<ClientSession>('/api/client/session');
}

export async function clearClientSession(): Promise<void> {
  await requestJson<{ signed_out: boolean }>('/api/client/session', {
    method: 'DELETE',
    keepalive: true,
  });
}

export async function listClientReviews(clientId: string, limit = 1000): Promise<ClientReviewList> {
  const params = new URLSearchParams({ limit: String(limit) });
  return requestJson<ClientReviewList>(
    `/api/client/${encodeURIComponent(clientId)}/reviews?${params}`,
    { headers: clientHeaders() }
  );
}

export async function getClientReview(
  clientId: string,
  jobId: string
): Promise<ClientReviewDetail> {
  return requestJson<ClientReviewDetail>(
    `/api/client/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(jobId)}`,
    { headers: clientHeaders() }
  );
}

export async function decideClientReview(
  clientId: string,
  jobId: string,
  decision: ClientDecisionValue,
  feedback?: { note?: string; reason?: ClientFeedbackReason }
): Promise<ClientReviewDecision | null> {
  return requestJson<ClientReviewDecision | null>(
    `/api/client/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(jobId)}/decision`,
    {
      method: 'PUT',
      headers: clientHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        decision,
        ...(feedback?.note ? { feedback_note: feedback.note } : {}),
        ...(feedback?.reason ? { feedback_reason: feedback.reason } : {}),
      }),
    }
  );
}

const clientReviewImageCache = new Map<string, Promise<Blob>>();

export async function fetchClientReviewImage(
  clientId: string,
  jobId: string,
  filename?: string
): Promise<Blob> {
  const suffix = filename
    ? `/frames/${encodeURIComponent(filename)}`
    : '/thumbnail';
  const cacheKey = `${clientId}:${jobId}:${filename ?? 'thumbnail'}`;
  const cached = clientReviewImageCache.get(cacheKey);
  if (cached) return cached;
  const request = fetch(
    `/api/client/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(jobId)}${suffix}`,
    { headers: clientHeaders() }
  ).then(async (response) => {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(apiErrorMessage(body, response.status));
    }
    return response.blob();
  });
  clientReviewImageCache.set(cacheKey, request);
  try {
    const blob = await request;
    if (clientReviewImageCache.size > 200) {
      const oldest = clientReviewImageCache.keys().next().value;
      if (oldest) clientReviewImageCache.delete(oldest);
    }
    return blob;
  } catch (error) {
    clientReviewImageCache.delete(cacheKey);
    throw error;
  }
}

export function preloadClientReviewImage(
  clientId: string,
  jobId: string,
  filename?: string
): void {
  void fetchClientReviewImage(clientId, jobId, filename).catch(() => undefined);
}

export async function fetchClientReviewPdf(
  clientId: string,
  jobId: string
): Promise<{ blob: Blob; filename: string }> {
  const reportPath = `/api/client/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(jobId)}/report.pdf`;
  const response = await fetch(reportPath, { headers: clientHeaders() });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(apiErrorMessage(body, response.status));
  }
  const blob = await response.blob();
  const signature = await blob.slice(0, 5).text();
  if (signature !== '%PDF-') throw new Error('The server returned a non-PDF response.');
  const disposition = response.headers.get('content-disposition') ?? '';
  const encodedName = disposition.match(/filename\*=utf-8''([^;]+)/i)?.[1];
  const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  let filename = `${jobId}-client-report.pdf`;
  try {
    filename = encodedName ? decodeURIComponent(encodedName) : (quotedName || filename);
  } catch {
    filename = quotedName || filename;
  }
  filename = filename.split(/[\\/]/).pop() || `${jobId}-client-report.pdf`;
  if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';
  return { blob: new Blob([blob], { type: 'application/pdf' }), filename };
}
