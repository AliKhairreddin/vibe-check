export type Status = {
  job_id: string;
  file_name: string;
  status: string;
  progress: number;
  message: string;
  report_ready: boolean;
  has_creative?: boolean;
  has_ad_copy?: boolean;
  created_at?: number | null;
  updated_at?: number | null;
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
};

export type OverallStatus = 'pass' | 'needs_review' | 'likely_violation';

export type Report = {
  overall_status: OverallStatus;
  summary: string;
  source_results?: {
    creative?: {
      status: OverallStatus;
      summary: string;
    } | null;
    ad_copy?: {
      status: OverallStatus;
      summary: string;
    } | null;
  };
  findings: Finding[];
  safe_rewrite: { ad_copy: string; onscreen_text: string[] };
  limitations: string[];
};

export type ReviewHistoryItem = Status & {
  overall_status?: Report['overall_status'] | null;
  creative_result?: Report['overall_status'] | null;
  ad_copy_result?: Report['overall_status'] | null;
};

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

export async function getStatus(id: string): Promise<Status> {
  return requestJson<Status>(`/api/reviews/${id}`);
}

export async function listReviews(limit = 50): Promise<ReviewHistoryItem[]> {
  return requestJson<ReviewHistoryItem[]>(`/api/reviews?limit=${limit}`);
}

export async function getReport(id: string): Promise<Report> {
  return requestJson<Report>(`/api/reviews/${id}/report`);
}
