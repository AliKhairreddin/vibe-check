# Review notifications in Telegram

The selected offer is the client. A finished batch is summarized by client, using
the original AdChecked verdict for each submitted item. For example:

```text
Creative review 2026-09-05 — done
47/47 reviewed

Client: YZX
🔴 2 red — Review
🟡 27 yellow — Review
🟢 18 green — Review

Open batch reports
```

Each Review link opens the same batch filtered to that client and color. The
batch page labels the filter as the AdChecked assessment; later client decisions
remain visible separately. Zero counts stay visible. An item containing both a
creative and copy counts once per client, using its overall result. Individual
messages also retain the creative/copy split. Multiple offers produce separate
client sections. Long summaries continue in additional messages without dropping
items or counts. Names and source labels are escaped for Telegram HTML.

## Situation coverage

| Situation | Notification |
| --- | --- |
| A single image, video, or copy-only review is accepted into the queue | Review queued, client/name, progress link. |
| A batch starts processing | One batch-start event with client names, source label when known, total items, and progress link. |
| A single review finishes | Creative/ad-copy review done, client counts, offer-specific report links, creative/copy split when applicable. |
| All batch items finish successfully | Review done, full client totals, filtered links, and combined report link. |
| Some items fail | Review done with issues; completed verdicts remain counted and failures have their own links. |
| Every item fails | Review failed; no failed item is represented as a red verdict. |
| Upload or Drive import fails before a job starts | Upload/import failed count in the terminal batch summary, linked to failed uploads and retry controls. |
| Uploads never reach processing | Once no batch progress has been recorded for two hours, an attention alert identifies the outstanding count and links to the batch. Uploads are not cancelled by the alert. |
| Pipeline error, media/Drive download error, or final timeout | Failed individual/live review alert with the job details link; batch jobs appear in the final batch summary. |
| A timeout can be retried automatically | Review delayed — retrying, with attempt count and progress link. The eventual final result follows. |
| A job resumes after a container interruption | Review resumed after interruption, with a progress link. |
| Interrupted work has no recovery source | Failed review with re-upload instructions, or a failed item in the final batch summary. |
| Live creative or primary text completes | Live review done, client counts, Meta account/creative context, report and Live Scans links. |
| Live review fails | Live failure alert with job and Live Scans links. |
| A scheduled Drive scan completes reviews | The same client summary, with the schedule name as the source. |
| A scheduled scan finds no matching files | Scheduled review — no new creatives, with the reason and schedules link. |
| All matching Drive versions were already reviewed | No-new-creatives message explaining that the current versions were already reviewed. |
| A schedule cannot start, including unavailable offers/guidelines or Drive access problems | Scheduled review could not start, with corrective instructions and schedules link. |
| Partial scheduled import failure | Failed imports in the batch summary; the existing automation recovery continues to retry unqueued files. |
| An offer is disabled or lacks guidelines | Explicit not-reviewed count and reason; never counted as green. |
| A completed result is missing from the compact projection | Use the saved final outcome when available; otherwise explicitly show results unavailable. Do not copy one client's primary verdict to other clients. |
| Green under an internal exception | Green count plus the number using an approved internal exception. |
| PDF generation, attachment, or size failure | Separate PDF-unavailable notice linking to the saved review. The review result remains successful. All-failed batches do not attempt an empty PDF attachment. |
| Telegram rate limit, network error, or server failure | Immediate bounded retry, then durable retry with backoff. Review processing is unaffected. |
| Duplicate terminal callback or delivery worker overlap | Stable event keys deduplicate acknowledged messages; leased claims prevent concurrent ownership. |

Normal extraction/transcription/analysis progress stays on the linked job page.
The summary is not sent as complete while batch items are pending. Repeating an
unchanged terminal callback does not send another result. A user retry that changes
the final batch results gets a new summary.

## Delivery and operational boundaries

`telegramNotifications` stores event keys, rendered messages, claim ownership,
attempts, and delivery state. Existing scheduled maintenance drains it even when
no new review is running. Failed or expired claims are retried up to eight durable
attempts; stale claims cannot acknowledge newer deliveries. Exhausted records remain
inspectable in Convex (`status: exhausted`). Batch completion continues to use the
existing batch outbox as well. The local, Convex-disabled development fallback only
has immediate delivery retries.

Telegram requires a working bot token, chat ID, and optional topic ID. Missing
credentials leave durable events pending without consuming delivery attempts.
Permanent permissions/configuration errors require an operator to fix the bot or
chat; a bot cannot report its own inability to reach that chat. Messages use HTML
and conservatively stay below the [Telegram message size limit](https://core.telegram.org/bots/api#sendmessage).
Transport logs record error classes/statuses, not bot URLs or tokens.

Delivery is at least once: if Telegram accepts a message but the acknowledgement
or subsequent Convex write is lost, retrying can duplicate it. A complete Convex
outage can also prevent an event from being recorded; such errors are logged.
PDF attachments are best effort; their failure does not retry a successfully
acknowledged summary.

These alerts go to the configured internal Telegram chat. Partner API reviews keep
their existing isolated signed completion/failure webhooks and are excluded from
the shared chat. Authentication errors and rejected submissions before a review
record exists stay in the requesting UI/API response. Client approval/disapproval
decisions remain separate from automated review completion notifications.

No live messages are sent by the regression tests. They validate the sample totals,
all review media types, failures, unavailable results, lifecycle events, HTML/length,
offer filters, API isolation, delivery claims, retries, and duplicate suppression.
