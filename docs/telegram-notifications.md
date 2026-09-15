# Internal Telegram notifications

The internal chat reports release and advertiser-review milestones. Processing
progress stays in the app. These notifications use the selected offer as the
advertiser and keep AdChecked assessments separate from advertiser decisions.

## Messages and triggers

| Event | Behavior |
| --- | --- |
| A review is queued or a batch starts | Quiet. |
| A review, live scan, or batch finishes successfully | Quiet. Finished batches created today appear in today's roundup. |
| A batch or selected creatives are released | One summary per batch/release action, grouping the newly released advertisers. |
| An email is being sent or its sending status changes | Edit the matching release summary. Drafting/previewing sends nothing. |
| One creative is approved/disapproved | Quiet until that advertiser has decided on all released creatives in the batch. |
| An advertiser finishes a batch | One completion summary with explicit approved/disapproved counts and a feedback link. |
| A decision changes or a completed batch is reopened | Correct the existing completion post; do not create a stream of new posts. |
| An automatic retry, recovery, or scan with no new files | Quiet. |
| A terminal review, upload, import, or automation failure | An actionable failure alert. Batch failures are consolidated at batch completion. |
| An email send is uncertain or stays in `sending` for ten minutes | An actionable delivery-check alert; never resend email automatically. |
| Unqueued uploads make no progress for two hours | The existing once-per-batch attention alert. |
| PDF generation | PDFs remain available in the app; no automatic Telegram attachment or attachment-failure post. |

Release summaries identify the batch and advertiser, count the **newly released**
creatives using their original red/yellow/green assessment, show advertiser review
progress at release, and link to the batch filtered to that advertiser. Partial
releases are labeled. Release is additive: repeating an unchanged release sends
nothing, and a later release gets its own summary of the newly released creatives.
Large summaries use bounded continuation posts with stable advertiser groupings.
The release transaction schedules one durable preparation job per batch. Selecting
creatives across many batches therefore does not hydrate every batch in the same
database transaction. Retrying preparation reuses its stable release event key.

```text
Batch released · 15 Sept 2026 Auto

Kissterra — 22 creatives
AdChecked assessment: 🔴 7 · 🟡 15 · 🟢 0
Advertiser review at release: 0/22 completed
Notification: Email not sent yet
Open batch
```

Release makes results visible; it does not send email. The notification line is
updated after the actual email attempt, including recipients (abbreviated when
long), sending time, and timezone. Only an email covering the released creatives
can mark their summary as sent. Provider acceptance means **sent**, not delivered
to an inbox or read. A newer attempt's status is not overwritten by a late
callback from an older attempt. The existing email history remains the detailed
audit record.

Advertiser completion requires an explicit decision on every currently released,
evaluated creative for that advertiser. AI-green does not mean advertiser-approved.
Advertisers finish independently. Withheld creatives are excluded; unavailable
released results prevent a false completion. A subsequent partial release or
cleared decision reopens the existing completion post. If a decision is cleared
before the completion post is sent, that premature post is cancelled.

## Daily roundup

The default is **18:00 America/Toronto**, checked every five minutes and adjusted
for daylight saving time. Change these **Convex deployment environment variables**:

- `TELEGRAM_DIGEST_TIME`: local `HH:mm`, default `18:00`.
- `TELEGRAM_DIGEST_TIMEZONE`: IANA timezone, default `America/Toronto`.
- `TELEGRAM_DIGEST_ENABLED`: set `false` to disable future daily runs.
- `TELEGRAM_ADMIN_URL`: admin link origin, default `https://admin.adchecked.com`.

The roundup includes only finished batches **created that day**, from midnight
in `TELEGRAM_DIGEST_TIMEZONE` through the roundup's start time. The heading's date
is the batch-date filter, not just the date the message was generated. Older batches
are excluded even if they still need release or advertiser review, or were reviewed
today. Batches created after the roundup starts are outside that day's snapshot
and do not carry into the next day's roundup.

Eligible batches are grouped by advertiser, showing assessment totals, creatives
ready for release, release-email status, advertiser-review progress, and completed
reviews. Empty roundups send nothing.

A durable daily run paginates that day's batches, then the advertiser-sorted entries,
so it does not silently truncate a busy day. The date window is saved when the run
starts, including across daylight saving changes or retries after midnight.
Continuation posts are used only when Telegram's message length requires them. On the first run, existing
email records seed the delivery projection before batches are summarized. This
prevents already-sent emails from being labeled unsent. Cursor and message writes
are transactional; scheduler retries resume rather than restart the roundup.

Operators can inspect a single batch without sending anything:

```sh
CONVEX_DEPLOYMENT=prod:energetic-partridge-813 pnpm exec convex run telegramMilestones:previewBatch '{"batchId":"BATCH_ID"}'
```

## Delivery, isolation, and deployment

The existing Python backend sends and edits messages using the Cloudflare runtime
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and optional `TELEGRAM_MESSAGE_THREAD_ID`.
The existing maintenance/Worker schedule wakes the backend for pending messages,
even without a new review job. Convex cron jobs prepare the daily roundup and
check stalled email attempts; no bot token is needed in Convex.

The outbox stores a stable event key, rendered text, revision, Telegram message/chat
IDs, lease ownership, attempts, and delivery state. If an email finishes while the
release post is being sent, the original acknowledgement retains its message ID
and queues the newer revision as an edit. Unchanged Telegram edits count as
successful acknowledgements. A deleted or uneditable original post is replaced.
Changing the configured chat creates a new post in that chat rather than applying
an unrelated message ID there. Messages use escaped HTML and fit Telegram's UTF-16
length limit. Release-part boundaries reserve delivery-text space so email updates
do not leave stale continuation messages.

Immediate retries handle transient transport failures; durable claims retry with
backoff up to eight attempts. Exhausted records remain inspectable in Convex.
Missing transport credentials preserve pending messages without using attempts.
Tokens, bot URLs, and response bodies are excluded from error logs. Delivery is
at least once: a Telegram acceptance followed by a lost acknowledgement can still
produce a duplicate. Old processing-success/start messages are suppressed during
rollout, and old backend containers cannot claim the new editable messages.

Only internally owned reviews feed these summaries. Partner API reviews retain
their isolated signed webhooks; external publisher submissions are excluded from
the shared internal chat. Digital Nudge attribution follows the repository's
existing internal-source classification. Advertiser-group routing is not enabled;
it requires a separate advertiser-to-chat mapping and recipient-scoped messages.

Tests use local database fixtures and mocked Telegram transport. They cover quiet
triggers, assessments versus decisions, partial releases, reopened/cancelled
completion, email coverage and uncertainty, message editing and acknowledgement
races, tenant isolation, daily pagination, DST, HTML bounds, retries, and legacy
rollout suppression. Tests and read-only previews do not send live messages.
