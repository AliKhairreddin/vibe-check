# October 22, 2026 review failures

## Findings

Production Convex records, including soft-deleted reviews, identify the exact batches in the Telegram screenshot. Times below use America/Toronto (EDT).

| Source | Batch ID | Started | Completed | Failed | Saved failure details |
| --- | --- | --- | ---: | ---: | --- |
| 21 Oct 2026 Auto | `aff01d317d51476587292e9fbf2ccd12` | 1:05 a.m. | 30 | 55 | 54 timeout, 1 non-text response |
| 21 Oct 2026 Auto | `77f1e06f5c6a4e9da7d9eedef5b532c8` | 1:16 a.m. | 38 | 47 | 44 timeout, 3 non-text responses |
| 21 Oct 2026 Auto | `17adc4cd71c34ae6b3c07e1c5278b59a` | 1:24 a.m. | 68 | 17 | 17 timeout |
| 21 Oct 2026 Home | `6811de9006c8423682617fcecb7c00ef` | 1:51 a.m. | 0 | 3 | 3 timeout |
| 22 Oct 2026 (Lead Economy) | `f4e5587baa284d64855712564efc6198` | 2:13 a.m. | 9 | 10 | 10 timeout |
| 22 Oct 2026 (Lead Economy) | `8be1996392b5469f9e15d0571baf6da1` | 2:42 a.m. | 1 | 18 | 18 timeout |

These are 150 failed attempts across repeated submissions, not 150 distinct creatives: 146 timed out and four returned non-text output. Comparing advertiser and exact Drive file IDs found 93 distinct failed sources; all 93 already have completed reruns. No additional reprocessing is needed.

The later successful batches are:

- Home: `2264698810714925906e08d4524aa070`, 3/3 complete.
- Lead Economy: `15ec09df596a4156b427708bac5855c0`, 19/19 complete.
- Auto: `9f50e8282f0745248f86e639f8791e01`, 85/85 complete.

Sampled failed processing metrics show approximately 543 seconds in `offer_reviews`: three 180-second wall-clock deadlines plus one- and two-second backoffs. Metadata extraction, transcription, OCR and vision had already completed. The immediate trigger was a slow or incomplete upstream AI response. Our repeated fixed deadlines, very short synchronized retry delays, and incomplete response-envelope handling were within our control.

The old records do not preserve enough generation/provider metadata to establish why the upstream requests stalled. They do not establish a provider-wide outage, exhausted credits, a Cloudflare plan limit, or a Convex capacity failure. Telegram successfully delivered the summaries of failed reviews.

## Changes

- Timeout recovery doubles the initial request deadline, capped at 600 seconds per attempt (180, 360, 600 with production defaults). The HTTP read timeout no longer cuts longer recovery attempts short. The existing whole-job deadline remains in force.
- After a timeout, provider routing prefers latency for the same model; schema requirements, ZDR and data-collection settings remain enforced.
- Backoff includes jitter. Both HTTP errors and errors inside HTTP 200 responses respect numeric or HTTP-date `Retry-After` headers. Cooldowns over five minutes stop for a later retry instead of making an early request.
- Empty, interrupted, truncated, filtered and error-bearing responses cannot become verdicts or empty assistant correction messages. Available provider/generation identifiers and finish reasons are logged without raw provider diagnostics or evidence content.

## Separate Convex counter contention

The supplied Convex Health screenshot shows about 6.1K retried `platform:recordEdgeRead` mutations and 19 failures, plus retried heartbeats and batch completions. Code inspection found one shared backend hourly counter, 16 edge counter shards, and retention cleanup inside every telemetry write.

Edge recording runs in Worker `waitUntil` and its errors are caught after the review-read response. Heartbeat errors are also caught by the monitor. These are separate telemetry reliability defects, not the saved AI-stage failure reason.

Backend hourly totals now use a stable per-instance hash across 64 shards, edge totals use 64 random shards, and retention runs in a bounded internal hourly cron. Request recording no longer reads or deletes common expired rows. Overview queries include all shards plus legacy unsharded totals. Existing data needs no destructive migration. Retention stays at seven days for traffic and one day for inactive instance records, with bounded hourly cleanup.

Historical Health insights may continue displaying old conflicts after deployment. Reduced contention needs observation under comparable traffic; a passing deploy alone cannot prove that every future conflict is eliminated.

## Follow-up: batch completion, billing, and live conflicts

The CLI's detailed production insights identified the conflicting writers and event times:

- `batches:finishItem`: 21 automatically retried attempts against `reviewBatches`, with the same mutation as the competing writer. The latest recorded event was October 22 at 5:23:35 a.m. EDT. There were no permanent batch-completion failures in these insights. Different genuine item completions must still serialize their shared batch summary and final notification claim; occasional automatic retries are expected under simultaneous completions.
- `billing:recover`: one automatically retried attempt on October 19 at 8:43:59 p.m. EDT. The competing writer was Convex's internal `migrate_persisted_version`, with no application table identified. This is evidence of a platform migration conflict, not a subscription-row race. Production currently has only grandfathered/complimentary billing records and no Stripe customer IDs. The billing implementation is unchanged; additional regression checks cover recovery eligibility, active sync leases, mode isolation, receipt retention, and exempt workspaces.

Batch completion now skips writes when the same job, status, message, result and outcome snapshot are replayed. It compares outcome fields independently of JSON property order, preserves notification ownership/attempt limits, and can still claim a ready pending notification when an otherwise unchanged final item is replayed. Late failures cannot regress a completed item, and callbacks from a different job cannot overwrite the item's current job.

The Python Convex client now recognizes the specific system message for exhausted optimistic-concurrency retries inside HTTP 200 error envelopes. Idempotent persistence calls use the existing bounded retry count with jitter. Other function, authorization and validation errors continue to fail immediately.

Verification uses `convex logs --success --jsonl` and its `occInfo`, `willRetry`, error and execution timestamps, alongside `convex insights --details --json`. The insight totals cover historical events and must not be presented as new post-release errors. A quiet log interval without real completions does not prove there will be no conflicts during the next large batch; duplicate callback replay checks can verify the new no-write path without altering review results or sending notifications.

## Validation

Regression checks exercise real asynchronous timeout cancellation and recovery, capped retries, empty/non-text output, malformed envelopes, embedded provider errors, incomplete otherwise-valid JSON, rate-limit cooldowns, preserved model/privacy settings, sharded aggregation, legacy totals, and bounded retention outside ingestion. Run the repository's complete `pnpm run verify` before delivery. Production deployment follows the push-triggered Convex/Cloudflare workflow, including the Docker OCR benchmark and activated-backend health check.

References: [OpenRouter error envelopes and retry guidance](https://openrouter.ai/docs/api_reference/errors-and-debugging), [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [Convex write-conflict causes and remedies](https://docs.convex.dev/error#1).
