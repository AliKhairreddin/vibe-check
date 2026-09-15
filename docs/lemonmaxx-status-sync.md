# Lemonmaxx Offer decision sync

Advertiser decisions for API-submitted Lemonmaxx creatives are delivered from
Convex to `PATCH https://api.lemonmaxx.com/api/v1/creative-bank/creative-group/assets/{asset_id}/status`.
The body contains only `status`; the credential is sent as a Bearer token.

| Offer action | Lemonmaxx status |
| --- | --- |
| Approve | `approved` |
| Disapprove | `rejected` |
| Reset to pending | `not_selected` |

The asset ID comes from the submission's `asset_id` (stored as `externalId`),
never the AdChecked job ID. Only the configured partner's submitted offer is
eligible. Legacy submissions without a requested offer use the review's explicit
primary offer. Other partners, internal uploads, unrelated offer results, and
submissions without an external asset ID are excluded.

The endpoint stores **one status per asset**, with no offer parameter. If an
asset is submitted under multiple offers, the latest explicit Offer decision
wins. This does not aggregate approvals across offers. Feedback-only edits,
duplicate decisions, initial pending states, and AI result colors do not change
the external status. Existing decisions are not automatically backfilled on
deployment; subsequent decision changes trigger sync.

## Configuration

Set these variables on the production **Convex** deployment:

- `LEMONMAXX_PARTNER_ID`: the exact `apiPartners.partnerId` for Lemonmaxx.
- `LEMONMAXX_API_TOKEN`: the outbound token issued by Lemonmaxx. This differs from
  the `vc_live_…` token they use to call AdChecked.

Keep credentials in Convex environment variables. Never put them in GitHub source,
frontend configuration, or a webhook URL. Removing the partner ID disables sync;
pending deliveries are cancelled when their eligibility is checked.

The requests identify themselves as `AdChecked/1.0 (+https://adchecked.com)`;
Lemonmaxx's Cloudflare edge rejects some default client user agents.

## Delivery and recovery

Each decision and its queue update commit in one transaction. One
`lemonmaxxStatusSync` row per partner/asset records the latest status, revision,
source review/offer, attempts, HTTP result, and delivery state. The browser can
finish saving while delivery runs in a scheduled internal action.

Only one request for an asset runs at a time. A change during delivery preserves
the existing claim and schedules the newer revision after it completes. The
request timeout is 15 seconds. Abandoned claims expire after 11 minutes (longer
than the Convex action lifetime), and a bounded minute cron recovers due work.
PATCH retries are at least once; the remote operation must remain an idempotent
status assignment.

Connection failures, HTTP 408/409/425/429, and 5xx receive up to eight attempts,
with backoff from 30 seconds to 12 hours. `Retry-After` can extend the delay up to
24 hours. Other HTTP errors, redirects, missing credentials, and exhausted
attempts remain `failed` for inspection. Responses and credentials are never
stored in error messages. Deleted, withheld, suspended, or reassigned assets are
cancelled before delivery.

Use the Convex dashboard to inspect `lemonmaxxStatusSync`, especially `failed`
rows and `responseStatus`. After fixing a credential or remote asset, retry one
failed row with:

```sh
CONVEX_DEPLOYMENT=prod:energetic-partridge-813 pnpm exec convex run lemonmaxx:retry '{"id":"CONVEX_SYNC_ROW_ID"}'
```

Read-only production connectivity check:

```sh
CONVEX_DEPLOYMENT=prod:energetic-partridge-813 pnpm exec convex run lemonmaxx:checkConnection '{}'
```

It uses GET on the PATCH-only route. The authenticated response is HTTP 405 with
`Allow: PATCH`; missing/invalid credentials return 401. This verifies connectivity
and authentication without changing an asset. A completed real decision delivery
is recorded separately as `delivered` after a successful PATCH response.

## CORS

This server-to-server sync is independent of browser CORS. Partner browser access
is configured in Settings → API access → Allowed websites. Lemonmaxx already has
`https://lemonmaxx.com` and `http://localhost:9002` enabled in production.
