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
  kind?: 'google_drive_file' | 'google_sheet' | null;
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

export type OverallStatus = 'green' | 'yellow' | 'orange' | 'red';
export type LegacyOverallStatus = 'pass' | 'needs_review' | 'likely_violation';
export type ResultStatus = OverallStatus | LegacyOverallStatus;

export type OfferOutcome = {
  offer_id: string;
  offer_name: string;
  evaluation_state: 'evaluated' | 'disabled' | 'missing_guidelines';
  overall_status: OverallStatus | null;
  creative_result: OverallStatus | null;
  ad_copy_result: OverallStatus | null;
  message: string;
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
  items: ReviewBatchItem[];
  notification_status: string;
};

export type CreateReviewBatchInput = {
  batch_id: string;
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

type ChunkedUpload = {
  upload_id: string;
  chunk_size: number;
  chunk_count: number;
};

const CHUNKED_UPLOAD_THRESHOLD = 8 * 1024 * 1024;
const MAX_CHUNK_ATTEMPTS = 3;
const ADMIN_PASSWORD_KEY = 'vibe-check-admin-password';

export function getAdminPassword(): string {
  if (typeof window === 'undefined') return '';
  return window.sessionStorage.getItem(ADMIN_PASSWORD_KEY) ?? '';
}

export function setAdminPassword(password: string): void {
  if (typeof window === 'undefined') return;
  const normalized = password.trim();
  if (normalized) window.sessionStorage.setItem(ADMIN_PASSWORD_KEY, normalized);
  else window.sessionStorage.removeItem(ADMIN_PASSWORD_KEY);
}

function adminHeaders(headers?: HeadersInit, password = getAdminPassword()): Headers {
  const result = new Headers(headers);
  if (password) result.set('x-admin-password', password);
  return result;
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
  const response = await fetch(input, init);
  const body = await response.text();
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return parseJson<T>(body);
}

export async function createReview(
  form: FormData,
  onUploadProgress?: (progress: number) => void
): Promise<Status> {
  const creative = form.get('creative');
  if (onUploadProgress && creative instanceof File && creative.size > CHUNKED_UPLOAD_THRESHOLD) {
    return createChunkedReview(form, creative, onUploadProgress);
  }

  if (!onUploadProgress) {
    return requestJson<Status>('/api/reviews', { method: 'POST', body: form });
  }

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/reviews');

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
  return requestJson<Status>('/api/drive/reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function createChunkedReview(
  form: FormData,
  creative: File,
  onUploadProgress: (progress: number) => void
): Promise<Status> {
  const upload = await requestJson<ChunkedUpload>('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    await sendChunkWithRetry(upload.upload_id, index, creative.slice(start, end));
    onUploadProgress(Math.round((end / creative.size) * 100));
  }

  const completionForm = new FormData();
  for (const [key, value] of form.entries()) {
    if (key !== 'creative' && typeof value === 'string') completionForm.append(key, value);
  }
  try {
    return await requestJson<Status>(`/api/uploads/${upload.upload_id}/complete`, {
      method: 'POST',
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

async function sendChunkWithRetry(uploadId: string, index: number, chunk: Blob) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(`/api/uploads/${uploadId}/chunks/${index}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
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
  await requestJson<{ authorized: boolean }>('/api/admin/check', {
    headers: adminHeaders(undefined, password),
  });
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
