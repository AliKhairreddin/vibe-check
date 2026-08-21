# Vibe Check Partner API v1

The Partner API lets another server submit video, image, or copy-only creatives to the same review pipeline used by the Vibe Check application. Processing is asynchronous: a submission returns immediately with a review ID, and the caller polls or receives a signed webhook before downloading results.

## Access and credentials

Production base URL:

```text
https://vibe-check.ali-kheireddin1.workers.dev/api/v1
```

Interactive V1-only API documentation is available at `/api/v1/docs`; its machine-readable schema is at `/api/v1/openapi.json`.

An administrator creates an account in **Settings → API access**, chooses offer access and limits, and issues one or more API keys. The full key is shown once. Store it only in the integrating service's secret manager and send it on every request:

```http
Authorization: Bearer vc_live_...
```

Keys are hashed before storage and can be independently scoped, expired, and revoked. Available scopes are:

| Scope | Access |
| --- | --- |
| `reviews:create` | Submit reviews and upload creative chunks |
| `reviews:read` | Read owned review status and structured results |
| `history:read` | Browse the account's review history |
| `evidence:read` | Read transcripts, OCR, visual observations, thumbnails, and evidence frames |
| `reports:download` | Download JSON and offer-specific PDF reports |
| `reviews:delete` | Permanently delete owned terminal reviews |

The admin account can use **Unlimited monthly reviews** and **Unlimited queued submissions**. These remove per-account admission quotas; they do not remove file-size limits or the platform's bounded worker concurrency.

## Submit and read a review

Send an `Idempotency-Key` on every submission. Reusing the same value for the same account returns the first review instead of creating another one.

```bash
curl -X POST 'https://vibe-check.ali-kheireddin1.workers.dev/api/v1/reviews' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Idempotency-Key: creative-2026-08-21-v1' \
  -F 'creative=@creative.mp4' \
  -F 'external_id=your-creative-id' \
  -F 'ad_copy=Optional accompanying platform copy'
```

Omit `creative` and provide non-empty `ad_copy` for a copy-only review. Optional fields are `policy_text`, `notes`, `manual_transcript`, `frame_interval_seconds`, and `scene_detection`. Custom `policy_text` is accepted only when the account has that entitlement. Offer eligibility is controlled by the administrator; an API caller cannot activate a disabled or unconfigured offer.

A successful request returns HTTP `202`:

```json
{
  "review_id": "ab12...",
  "external_id": "your-creative-id",
  "status": "queued",
  "progress": 0,
  "status_url": "/api/v1/reviews/ab12...",
  "result_url": "/api/v1/reviews/ab12.../result"
}
```

Poll the returned status URL. Once `report_ready` is `true`, retrieve:

- `GET /reviews/{review_id}/result` for status, the complete structured compliance report, and artifact links;
- `GET /reviews/{review_id}/evidence` for the submitted context, media metadata, timestamped transcript, OCR, visual observations, limitations, and protected frame URLs;
- `GET /reviews/{review_id}/report.json` for a downloadable JSON report;
- `GET /reviews/{review_id}/report.pdf?offer_id=...` for an offer-specific PDF;
- `GET /reviews/{review_id}/thumbnail` or `/frames/{filename}` for protected evidence images.

Every ownership check is enforced server-side. A key from one account receives `404` for another account's review, even if the review ID is known.

## Resumable uploads

Use the chunk API for large or unreliable uploads:

1. `POST /uploads` with JSON `{ "file_name": "creative.mp4", "content_type": "video/mp4", "size": 123456 }`.
2. Upload every byte range to `PUT /uploads/{upload_id}/chunks/{chunk_index}` using the returned `chunk_size`.
3. Call `POST /uploads/{upload_id}/complete` as multipart form data with review fields and an `Idempotency-Key`.

Chunks are retryable and an already-complete chunk is accepted idempotently. Incomplete upload sessions expire after one hour. The configured account upload maximum and the platform maximum both apply.

## History, deletion, and retention

`GET /reviews?limit=50&cursor=...` returns cursor-paginated history when the key has `history:read`. `DELETE /reviews/{review_id}` requires `reviews:delete` and only accepts terminal reviews.

Reports remain in the normal durable review store. The expanded API evidence bundle follows the account's configured 1–365 day retention window and returns HTTP `410` after expiry. Uploaded media and working extraction files remain temporary and are removed after processing.

## Signed completion webhooks

An administrator may save a public HTTPS webhook URL and create a signing secret. Vibe Check sends `review.completed` or `review.failed` events. Redirects are not followed, private/local destinations are rejected, and failed deliveries are retried with backoff up to five attempts.

Webhook headers include:

```text
x-vibe-event-id: evt_...
x-vibe-timestamp: 1787328000
x-vibe-signature: v1=<hex HMAC-SHA256>
```

Verify the signature over the timestamp, a period, and the exact raw request body:

```python
import hashlib
import hmac

expected = hmac.new(
    WEBHOOK_SECRET.encode(),
    timestamp.encode() + b'.' + raw_body,
    hashlib.sha256,
).hexdigest()

if not hmac.compare_digest(f'v1={expected}', signature_header):
    raise ValueError('Invalid webhook signature')
```

Reject stale timestamps in the receiving application and deduplicate events with `x-vibe-event-id`. Return any `2xx` response only after the event has been durably accepted.

## Operational behavior

- Authentication failures return `401`; missing scopes and suspended access return `403`.
- Account quota or queued-submission limits return `429` with `Retry-After`.
- Results or evidence that are still processing return `409` with `Retry-After`.
- Every V1 response includes `x-request-id` and `cache-control: no-store`.
- API keys must stay on a server. They are not safe to embed in a browser, mobile app, extension, or distributed desktop binary.
