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

export async function createReview(
  form: FormData,
  onUploadProgress?: (progress: number) => void
): Promise<Status> {
  if (!onUploadProgress) {
    const response = await fetch('/api/reviews', { method: 'POST', body: form });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
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
        onUploadProgress(100);
        resolve(JSON.parse(request.responseText) as Status);
        return;
      }
      reject(new Error(request.responseText || `Upload failed with ${request.status}`));
    };

    request.onerror = () => reject(new Error('Network error while creating review'));
    request.send(form);
  });
}

export async function getStatus(id: string): Promise<Status> {
  const response = await fetch(`/api/reviews/${id}`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function listReviews(limit = 50): Promise<ReviewHistoryItem[]> {
  const response = await fetch(`/api/reviews?limit=${limit}`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function getReport(id: string): Promise<Report> {
  const response = await fetch(`/api/reviews/${id}/report`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
