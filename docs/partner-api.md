# Vibe Check Partner API v1

The Partner API lets another server submit video, image, or copy-only creatives to the same review pipeline used by the Vibe Check application. Processing is asynchronous: a submission returns immediately with a review ID, and the caller polls or receives a signed webhook before downloading results.

## Access and credentials

Production base URL:

```text
https://vibe-check.ali-kheireddin1.workers.dev/api/v1
```

Human-facing documentation uses one hub on the branded application domain:

- Developer guide: `https://vibe-check.thatcanadian.dev/developers/api?view=guide`
- Interactive request console: `https://vibe-check.thatcanadian.dev/developers/api?view=reference`
- Machine-readable schema: `https://vibe-check.ali-kheireddin1.workers.dev/api/v1/openapi.json`

The dedicated Worker hostname remains the server-to-server base because the application domain can apply browser-oriented Cloudflare challenges to non-browser clients.

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
| `scans:write` | Upload live ad media, calculate fingerprints, and create reviews when content changes |
| `scans:read` | Read the account's current ad fingerprints and observation history |
| `reviews:delete` | Permanently delete owned terminal reviews |

The admin account can use **Unlimited monthly reviews** and **Unlimited queued submissions**. These remove per-account admission quotas; they do not remove file-size limits or the platform's bounded worker concurrency.

## LemmonMaxx live-creative scans

LemmonMaxx should download the media file that Meta is currently serving for an ad and send that file to `POST /scans/creative`. The stable `ad_id` must be Meta's ad ID or another immutable LemmonMaxx identifier—not the creative name.

```bash
curl -X POST 'https://vibe-check.ali-kheireddin1.workers.dev/api/v1/scans/creative' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'X-Vibe-Ad-Id: 23851234567890123' \
  -F 'creative=@current-ad-1.mp4' \
  -F 'ad_id=23851234567890123' \
  -F 'creative_name=Ad 1' \
  -F 'campaign_id=23850000000000000' \
  -F 'ad_set_id=23851111111111111' \
  -F 'ad_copy=The primary text currently running on Meta' \
  -F 'headline=The current headline' \
  -F 'call_to_action=LEARN_MORE' \
  -F 'destination_url=https://example.com/landing-page'
```

`X-Vibe-Ad-Id` must exactly match the `ad_id` form field. The edge uses it to spread different ads across the configured backend shards while keeping repeated scans of one ad on a stable shard.

Vibe Check streams the upload to temporary storage while calculating SHA-256 directly from the exact media bytes. This hash step does not run OCR, transcription, vision, or an LLM. A second hash covers the ad copy, headline, description, call to action, destination URL, review options, custom context, applicable offer-policy versions, and calibration snapshot.

The two hashes are combined and compared atomically with the last observation for the same API partner and `ad_id`:

- HTTP `202` with `review_created: true` means the ad is new, its media changed, a review field or policy changed, or a failed review needs a retry. The normal Vibe Check pipeline is queued.
- HTTP `200` with `review_created: false` and `change_status: unchanged` means the content is unchanged. The existing review is returned and no AI pipeline runs.
- Every accepted request records a tenant-owned observation, including unchanged scans, so LemmonMaxx has an audit trail. Observation history follows the partner's configured retention window; the current state for each ad remains available.

The response always includes `media_sha256`, `fields_sha256`, `content_fingerprint`, `observation_id`, `review_id`, `status_url`, and `result_url`. Possible `change_status` values are `new`, `unchanged`, `media_changed`, `fields_changed`, `media_and_fields_changed`, and `retry`.

Read current and historical state with:

- `GET /scans/ads?limit=50&cursor=...`
- `GET /scans/ads/{ad_id}`
- `GET /scans/ads/{ad_id}/observations?limit=50&cursor=...`

All comparisons and history are isolated by API partner. A different partner cannot read, reuse, or infer another partner's ad or review. Exact-byte hashing is deliberately conservative: if Meta re-encodes an otherwise similar video, the bytes change and Vibe Check runs a new review rather than risking a missed replacement.

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
