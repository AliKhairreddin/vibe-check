# AdChecked Partner API v1

The Partner API lets another server submit video, image, or copy-only creatives or read explicitly shared offer history from the same review pipeline used by the AdChecked application. Processing is asynchronous: a submission returns immediately with a review ID, and the caller polls or receives a signed webhook before downloading results.

## Access and credentials

Production base URL:

```text
https://api.adchecked.com/api/v1
```

Human-facing documentation uses one hub on the branded application domain:

- Developer guide: `https://admin.adchecked.com/developers/api?view=guide`
- Interactive request console: `https://admin.adchecked.com/developers/api?view=reference`
- Machine-readable schema: `https://api.adchecked.com/api/v1/openapi.json`

The dedicated API hostname remains the server-to-server base so machine traffic stays separate from the browser application and admin console.

An administrator creates an account in **Settings → API access**, chooses offer access and limits, and issues one or more API keys. Internal accounts can also receive explicit **Shared internal review history** access for selected offers. The full key is shown once. Store it only in the integrating service's secret manager and send it on every request:

```http
Authorization: Bearer vc_live_...
```

Keys are hashed before storage and can be independently scoped, expired, and revoked. Available scopes are:

| Scope | Access |
| --- | --- |
| `reviews:create` | Submit reviews and upload creative chunks |
| `reviews:read` | Read owned reviews plus explicitly authorized shared-offer results |
| `history:read` | Browse owned history or an explicitly authorized offer's shared history |
| `evidence:read` | Read transcripts, OCR, visual observations, thumbnails, source media, and evidence frames |
| `reports:download` | Download JSON and offer-specific PDF reports |
| `scans:write` | Upload live ad media, calculate fingerprints, and create reviews when content changes |
| `scans:read` | Read the account's current ad fingerprints and observation history |
| `reviews:delete` | Permanently delete owned terminal reviews |

The admin account can use **Unlimited monthly reviews** and **Unlimited queued submissions**. These remove per-account admission quotas; they do not remove file-size limits or the platform's bounded worker concurrency.

## ACP shared-review dashboard

Use the shared-history endpoint to populate ACP's creative list. The filename is display metadata, not a media identifier; always use `review_id` and the protected URLs returned by the API.

```bash
curl 'https://api.adchecked.com/api/v1/reviews?offer_id=acp&limit=50' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

Each completed row includes a compact, offer-specific result preview:

```json
{
  "access_type": "shared_offer",
  "review_id": "56b8e68d0c3c4d7b935b6d85055bee31",
  "file_name": "creative.mp4",
  "status": "complete",
  "report_ready": true,
  "overall_status": "yellow",
  "summary": "Two claims need additional qualification.",
  "finding_count": 2,
  "top_findings": ["Claim one", "Claim two"],
  "result_url": "/api/v1/reviews/56b8e68d0c3c4d7b935b6d85055bee31/result?offer_id=acp",
  "thumbnail_url": "/api/v1/reviews/56b8e68d0c3c4d7b935b6d85055bee31/thumbnail",
  "media_url": "/api/v1/reviews/56b8e68d0c3c4d7b935b6d85055bee31/media"
}
```

`status` describes processing: `complete` means the analysis finished. `overall_status` is the compliance result and is always `green`, `yellow`, or `red` when a result is ready. While a review is processing, `overall_status`, `summary`, and `finding_count` are `null`, and `top_findings` is empty.

Returned paths are relative to `https://api.adchecked.com`. Use `summary` and `top_findings` in the list and request `result_url` only when a user opens the full detail view.

Thumbnail and media requests require the same Bearer header:

```bash
curl 'https://api.adchecked.com/api/v1/reviews/REVIEW_ID/thumbnail' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  --output thumbnail.jpg

curl 'https://api.adchecked.com/api/v1/reviews/REVIEW_ID/media' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Range: bytes=0-1048575' \
  --output media-part.bin
```

The media endpoint supports `GET`, `HEAD`, and standard single HTTP byte ranges so video players can seek. It is available when a review retains a linked, downloadable Google Drive source; otherwise `media_url` is `null`.

Keep the API key in the ACP backend. Browser `<img>` and `<video>` elements cannot safely attach a secret Bearer header, so ACP should expose its own authenticated same-origin proxy. That proxy should forward the browser's `Range` header and preserve AdChecked's `200`/`206` status plus `Content-Type`, `Content-Length`, `Content-Range`, and `Accept-Ranges` response headers.

## LemmonMaxx phase-one test: three endpoints

The smallest integration surface accepts an existing public media URL and exposes only four job states. It uses the same API key, ownership checks, quotas, and analysis pipeline as the richer upload API.

### 1. Submit a creative URL

```bash
curl -X POST 'https://api.adchecked.com/api/v1/jobs' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: lemmonmaxx-monday-001' \
  --data '{"asset_id":"asset_12345","creative_name":"Monday Creative","media_url":"https://cdn.example.com/creative.mp4"}'
```

The URL must be public HTTPS and resolve to an MP4, JPG, PNG, or WebP file. AdChecked rejects embedded credentials, private/local destinations, unsafe redirects, empty responses, unsupported file signatures, and media larger than the API partner's upload limit. A successful request returns HTTP `202` after the media is validated and queued:

```json
{
  "asset_id": "asset_12345",
  "job_id": "ab12...",
  "creative_name": "Monday Creative",
  "status": "queued",
  "progress": 0,
  "message": "Queued for processing",
  "status_url": "/api/v1/jobs/ab12...",
  "result_url": "/api/v1/jobs/ab12.../result"
}
```

### 2. Poll status

```http
GET /api/v1/jobs/{job_id}
Authorization: Bearer YOUR_API_KEY
```

`status` is always one of `queued`, `processing`, `completed`, or `failed`. The response also echoes `asset_id`, allowing the caller to map the AdChecked job back to its own asset. The endpoint deliberately collapses the richer internal stages so a phase-one client needs only one polling state machine.

### 3. Retrieve the result

```http
GET /api/v1/jobs/{job_id}/result
Authorization: Bearer YOUR_API_KEY
```

Before completion this returns HTTP `409` with `Retry-After: 5`. Once complete it returns:

```json
{
  "asset_id": "asset_12345",
  "job_id": "ab12...",
  "creative_name": "Monday Creative",
  "status": "completed",
  "result": {
    "overall_status": "green",
    "findings": []
  }
}
```

`asset_id` is required, may be up to 200 characters, and is stored as the caller's stable external identifier. It does not replace `job_id`: one asset can have multiple review jobs over time.

This URL-based contract is convenient when LemmonMaxx already has a durable media URL. Direct file upload remains the stronger production option when URLs are short-lived or access-controlled, or when the caller needs byte-for-byte control over what AdChecked receives. Both routes feed the same analysis pipeline and can be used side by side.

## LemmonMaxx live-creative scans

LemmonMaxx should download the media file that Meta is currently serving for an ad and send that file to `POST /scans/creative`. The stable `ad_id` must be Meta's ad ID or another immutable LemmonMaxx identifier—not the creative name.

```bash
curl -X POST 'https://api.adchecked.com/api/v1/scans/creative' \
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

AdChecked streams the upload to temporary storage while calculating SHA-256 directly from the exact media bytes. This hash step does not run OCR, transcription, vision, or an LLM. A second hash covers the ad copy, headline, description, call to action, destination URL, review options, custom context, applicable offer-policy versions, and calibration snapshot.

The two hashes are combined and compared atomically with the last observation for the same API partner and `ad_id`:

- HTTP `202` with `review_created: true` means the ad is new, its media changed, a review field or policy changed, or a failed review needs a retry. The normal AdChecked pipeline is queued.
- HTTP `200` with `review_created: false` and `change_status: unchanged` means the content is unchanged. The existing review is returned and no AI pipeline runs.
- Every accepted request records a tenant-owned observation, including unchanged scans, so LemmonMaxx has an audit trail. Observation history follows the partner's configured retention window; the current state for each ad remains available.

The response always includes `media_sha256`, `fields_sha256`, `content_fingerprint`, `observation_id`, `review_id`, `status_url`, and `result_url`. Possible `change_status` values are `new`, `unchanged`, `media_changed`, `fields_changed`, `media_and_fields_changed`, and `retry`.

Read current and historical state with:

- `GET /scans/ads?limit=50&cursor=...`
- `GET /scans/ads/{ad_id}`
- `GET /scans/ads/{ad_id}/observations?limit=50&cursor=...`

All comparisons and history are isolated by API partner. A different partner cannot read, reuse, or infer another partner's ad or review. Exact-byte hashing is deliberately conservative: if Meta re-encodes an otherwise similar video, the bytes change and AdChecked runs a new review rather than risking a missed replacement.

## Submit and read a review

Send an `Idempotency-Key` on every submission. Reusing the same value for the same account returns the first review instead of creating another one.

```bash
curl -X POST 'https://api.adchecked.com/api/v1/reviews' \
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
- `GET` or `HEAD /reviews/{review_id}/media` for a linked Google Drive creative with byte-range streaming.

Every access check is enforced server-side. A key receives `404` for another account's review unless its partner account has explicit shared-history access to an offer evaluated by that review. Shared access returns only an authorized offer's report; it never grants access to another offer result stored on the same review.

## Resumable uploads

Use the chunk API for large or unreliable uploads:

1. `POST /uploads` with JSON `{ "file_name": "creative.mp4", "content_type": "video/mp4", "size": 123456 }`.
2. Upload every byte range to `PUT /uploads/{upload_id}/chunks/{chunk_index}` using the returned `chunk_size`.
3. Call `POST /uploads/{upload_id}/complete` as multipart form data with review fields and an `Idempotency-Key`.

Chunks are retryable and an already-complete chunk is accepted idempotently. Incomplete upload sessions expire after one hour. The configured account upload maximum and the platform maximum both apply.

## History, deletion, and retention

`GET /reviews?limit=50&cursor=...` returns cursor-paginated partner-owned history when the key has `history:read`. An internal account with configured shared-history access can add `offer_id`, for example `GET /reviews?offer_id=acp&limit=50`, to list every durable admin or API review evaluated for that offer. History rows include the compact traffic-light preview and protected artifact URLs described above. Use the returned review ID with the normal status and report endpoints. On a shared multi-offer review, add `offer_id` to the result or JSON-report request to select one of the account's authorized offers.

CoveragePro is authorized for shared ACP history. LemmonMaxx is authorized for shared ACP, Kissterra, Lead Economy, and Smart Financial history. These permissions are attached to the partner accounts, so existing keys inherit them without rotation as long as the key has the required read scope.

Shared history is read-only. `DELETE /reviews/{review_id}` requires `reviews:delete` and still accepts only terminal reviews originally submitted by that API partner. Expanded evidence bundles are also owner-only; a shared dashboard review exposes its durable offer report and retained thumbnail/frame artifacts, not a reconstructed transcript or OCR bundle.

Reports remain in the normal durable review store. The expanded API evidence bundle follows the account's configured 1–365 day retention window and returns HTTP `410` after expiry. Uploaded media and working extraction files remain temporary and are removed after processing.

## Signed completion webhooks

An administrator may save a public HTTPS webhook URL and create a signing secret. AdChecked sends `review.completed` or `review.failed` events. Redirects are not followed, private/local destinations are rejected, and failed deliveries are retried with backoff up to five attempts.

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
- Media supports `HEAD` and one standard `Range: bytes=...` request; an invalid range returns `416`.
- Every V1 response includes `x-request-id` and `cache-control: no-store`.
- API keys must stay on a server. They are not safe to embed in a browser, mobile app, extension, or distributed desktop binary.
