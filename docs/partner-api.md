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

## LemmonMaxx batch jobs and asset cards

The four-endpoint workflow accepts **1–100 creatives per batch**, evaluates only the requested offer, and provides lightweight card colors plus full asset details. Existing API keys work with their existing scopes and account limits; no key rotation is needed.

### 1. Submit a batch for one offer

```bash
curl -X POST 'https://api.adchecked.com/api/v1/jobs' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: lemmonmaxx-batch-001' \
  --data '{
    "offer_name": "acp",
    "creatives": [
      {"asset_id":"asset_12345","creative_name":"Monday Video","media_url":"https://cdn.example.com/creative.mp4"},
      {"asset_id":"asset_12346","creative_name":"Monday Image","media_url":"https://cdn.example.com/creative.png"}
    ]
  }'
```

Required scope: `reviews:create`. `offer_name` accepts an enabled offer ID or its exact display name, ignoring case and repeated whitespace. Use authenticated `GET /api/v1/offers` (`reviews:read`) to discover valid `offer_id`, `offer_name`, and `policy_version` values. Unknown, ambiguous, or disabled names return `422`; an offer outside the account's entitlement returns `403`. There is no fallback to a different offer. The selected policy and override snapshot is frozen at submission and reused for retries. No other offer is evaluated or included in the batch's findings.

Each creative requires a nonempty `asset_id` (up to 200 characters), `creative_name` (300), and public HTTPS `media_url` (4,000). Asset IDs must be unique within a batch. Empty batches, more than 100 items, duplicate IDs, and unexpected fields return `422` before any job is created.

Batch admission is atomic: all creatives are saved in Convex with their ownership, IDs, policy snapshot, and quota reservation before HTTP `202`. Monthly and queued-submission limits count each creative; a batch exceeding either limit returns `429` with `Retry-After: 60`, and none of it is accepted. LemmonMaxx's unlimited admission settings allow 100-item batches while execution remains bounded by worker capacity.

The response includes:

```json
{
  "job_id": "batch_0123456789abcdef0123456789abcdef",
  "status": "queued",
  "total": 2,
  "counts": {"queued": 2, "processing": 0, "completed": 0, "failed": 0},
  "offer_id": "acp",
  "offer_name": "ACP",
  "progress": 0,
  "status_url": "/api/v1/jobs/batch_0123456789abcdef0123456789abcdef",
  "assets": [
    {
      "asset_id": "asset_12345",
      "review_id": "11111111111111111111111111111111",
      "job_id": "batch_0123456789abcdef0123456789abcdef",
      "creative_name": "Monday Video",
      "status": "queued",
      "color": null,
      "clean": null,
      "finding_count": null,
      "report_ready": false,
      "result_url": "/api/v1/assets/asset_12345/result?review_id=11111111111111111111111111111111"
    }
  ]
}
```

The example abbreviates `assets`; the real response includes every asset in submission order, plus offer metadata, progress, message, status URL, and timestamps on each card. Processing can start before the response is read, so some states may already be `processing`.

Always supply `Idempotency-Key` (visible ASCII, at most 200 characters). Repeating the same batch payload and key returns the original batch with its current status without downloading again, charging quota again, or creating duplicates. Reusing the key with a changed payload returns `409`. Retrying failed creative analysis requires a new key. Keys are isolated per partner; batch keys and legacy single-review keys use separate namespaces.

Media downloads happen **after** acceptance. URLs must stay publicly downloadable while queued and throughout automatic retries. Downloads verify public destinations, redirects, file signatures (MP4, JPG, PNG, WebP), and the account's file-size limit. An inaccessible or invalid file fails its asset, while other assets continue. A failed analysis is an execution failure, not a red compliance result.

### 2. Fetch batch status

```http
GET /api/v1/jobs/{job_id}
Authorization: Bearer YOUR_API_KEY
```

Required scope: `reviews:read`. Pass the returned `batch_…` ID. The response has the same batch/card shape as submission:

| Status | Meaning |
| --- | --- |
| `queued` | Every asset is waiting to execute. |
| `processing` | Some work has started and at least one asset remains unfinished. |
| `completed` | Every asset finished successfully, regardless of its compliance color. |
| `failed` | Every asset is terminal and at least one failed. Successful assets remain readable. |

`counts` and individual asset states distinguish partial failures. Individual assets can be opened before the entire batch finishes. Poll every five seconds or slower. A partner cannot read another partner's batch, even if it has shared-offer history access.

### 3. Refresh card colors

```bash
curl -X POST 'https://api.adchecked.com/api/v1/assets/status-colors' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  --data '{"asset_ids":["asset_12345","asset_12346"],"offer_name":"acp"}'
```

Required scope: `reviews:read`. Accepts exactly one of `{"asset_id":"…"}` or `{"asset_ids":["…"]}`; a raw JSON array `["asset_12345","asset_12346"]` is also supported. Maximum 100 IDs per request. Optional `offer_name` selects the latest submission for that offer. Without it, the latest submission for each asset wins, including a newer pending or failed submission. Responses always use `data`, in request order:

```json
{
  "data": [
    {"asset_id":"asset_12345","status":"completed","color":"green","clean":true,"finding_count":0,"review_id":"11111111111111111111111111111111","job_id":"batch_0123456789abcdef0123456789abcdef","offer_id":"acp"},
    {"asset_id":"asset_12346","status":"processing","color":null,"clean":null,"finding_count":null,"review_id":"22222222222222222222222222222222","job_id":"batch_0123456789abcdef0123456789abcdef","offer_id":"acp"}
  ]
}
```

Completed analysis returns `green` (clean), `yellow` (needs review), or `red` (critical issue). `clean` is true only for a green result with zero findings. Legacy amber/orange results normalize to yellow. Queued, processing, failed, unknown, or deleted assets return `color: null`; they never appear clean by default. Unknown/deleted/other-partner assets use `status: "not_found"` and null IDs. This endpoint reads indexed compact records without loading transcripts, evidence, or full reports.

### 4. Open asset details

```http
GET /api/v1/jobs/{asset_id}/result
Authorization: Bearer YOUR_API_KEY
```

Required scopes: `reviews:read` and `evidence:read`. The equivalent, unambiguous path is `GET /api/v1/assets/{asset_id}/result`; the `result_url` returned for each card uses it and pins the exact `review_id`.

One asset can have many submissions over time or for different offers. A plain asset lookup selects its **latest submission**, even if unfinished. Add `offer_name` to select its latest submission for one offer, or `review_id` to pin an exact submission. The review ID must belong to both this asset and this API partner. URL-encode asset IDs; use the `/assets/` path for IDs containing slashes or resembling AdChecked's 32-character hexadecimal review IDs. On the legacy `/jobs/{id}/result` route, a 32-character hexadecimal ID without selectors is interpreted as a review job ID.

The response contains the asset card fields plus:

- `result`: complete structured evaluation for the requested offer, including summary, source-specific evaluation, risk assessment, and exact `findings` with policy references and remediation. A clean result has `overall_status: "green"` and `findings: []`.
- `transcript`: extracted timestamped audio transcript (also in `evidence.audio_transcript`); silent/image creatives may have no speech.
- `evidence`: media metadata, OCR, visual observations, limitations, submitted context, and protected frame URLs.
- `evidence_status`: `available`, `expired`, or `unavailable`; `evidence_expires_at` is a Unix timestamp in milliseconds or null.

An unfinished result returns `409` with `Retry-After: 5`; a failed result returns `409` without suggesting that a result will become ready. Unknown or foreign assets return `404`. Transcripts/evidence follow the partner's retention window. After expiry, the durable compliance report remains available while `transcript` and `evidence` are null and `evidence_status` is `expired`.

### Single-creative compatibility

The existing JSON object with `asset_id`, `creative_name`, and `media_url` remains supported. It now accepts optional `offer_name` to evaluate one offer. Omitting it preserves the original multi-offer behavior. A single submission still returns its review job ID, and `GET /jobs/{job_id}` plus `GET /jobs/{job_id}/result` retain their original contract and scopes. Single submissions validate and download the media before returning `202`; use a one-item batch for durable acceptance before download.

### Queue operation

The existing Cloudflare containers process durable batch jobs in their normal bounded worker slots. A scheduled dispatcher wakes the configured backend shards for waiting work. Convex claims, heartbeats, and fencing tokens recover interrupted work and prevent expired attempts from overwriting current status, reports, or evidence. Transient failures retry up to three total attempts; invalid media fails without repeated analysis. This reuses the configured compute capacity rather than requiring a new service or an unbounded number of concurrent model calls.

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
