# Advertiser and publisher workspaces

Advertisers pay for their workspace and invite publisher companies. Each publisher
gets a one-use, seven-day password setup link. Publisher requests are authenticated
with signed cookies and a live membership/version check; suspension and password
reset invalidate existing sessions. Publisher uploads inherit the advertiser’s
offer and saved guidelines. They cannot manage publishers, change advertiser
decisions, choose another advertiser, or trigger internal Telegram notifications.

Digital Nudge has one organization login (`digital-nudge`) with four advertiser
memberships. Its credentials are managed by the platform owner. Its existing
Drive, Telegram, live scan, and admin upload tools remain under Digital Nudge
operations at `https://admin.adchecked.com/publisher`. The ordinary publisher
portal uses direct uploads at `https://app.adchecked.com/login`.

## Initial commercial proposal

| Plan | Monthly USD | Annual USD | Publisher teams | Reviews/month |
| --- | ---: | ---: | ---: | ---: |
| Starter | 599 | 5,990 | 5 | 250 |
| Growth | 1,999 | 19,990 | 25 | 1,000 |
| Enterprise | From 4,499 | By agreement | Custom | Custom |

The proposed annual discount equals two monthly payments (16.67%). At full usage,
monthly list revenue per review is $2.396 for Starter and $1.999 for Growth;
annualized revenue per review is about $1.997 and $1.666. These are starting
commercial assumptions, not verified margins. Review actual inference, media,
storage, and support costs before agreeing high-volume custom pricing. Growth
prices a larger review allowance and network capacity; publishers do not pay
separately. Public pricing is at `https://adchecked.com/pricing`.

All plans are sales-assisted; this release does not process payments or claim
that an invoice has been paid. Owners set agreed allocations in admin Settings →
Advertiser plans. Existing workspaces default to a pilot allocation of 5 teams
and 250 publisher submissions per calendar month. Active and invited teams count
against publisher capacity. Suspended teams do not. Submission reservations are
transactional and idempotent. No automatic overage billing. Usage resets at UTC
month boundaries. Legacy/internal imports are excluded from paid review usage.

## Sharing

Admin, advertiser, and publisher review screens can create public links for one
or up to 100 completed creatives. The UI creates links valid for 30 days. The API
also supports 7 or 90 days. Links contain random 256-bit tokens; Convex stores only
their hashes. Anyone with a link can read the selected offer’s result, evidence,
media, and advertiser feedback without logging in. Public viewers cannot edit.
Revocation and expiry are checked on detail, evidence, and media requests.
Advertisers can revoke links created by their publishers. Publisher access is
restricted to their own links and submissions. Pages refresh every 30 seconds.

Uploaded media is retained in Convex storage after successful processing, and is
removed when the creative is deleted. Older uploads whose original files were
already removed can still display their saved findings and evidence frames.

## Platform monitoring

The owner-only admin landing page shows a live Convex query health check,
Cloudflare backend round-trip measurements, queue load, processing timings,
advertiser/publisher result counts, and hourly backend requests/server errors.
Awake containers report every 60 seconds. CPU and memory come from Linux cgroup
metrics when available; unsupported values are labeled as unavailable. Sleeping
containers are not awakened by the monitoring task. Records become stale after
three minutes; old instance and traffic records are removed after one and seven
days respectively. The chart shows 24 hours. Provider-specific CPU/bandwidth and
static page analytics are linked to the Convex and Cloudflare consoles.

Dashboard result counts are explicitly labeled as a recent sample of up to 1,000
offer results; processing timings use the latest 200 measured jobs. These counts
are not billing records or lifetime totals.

## Deployment and migration

After Convex deployment, run `python3 scripts/setup-publisher-workspaces.py`.
GitHub Actions performs this step automatically before Cloudflare deployment.
It creates Digital Nudge’s memberships and walks existing offer results in
resumable 100-row transactions. Existing publisher and API ownership is preserved.
New internal reviews receive Digital Nudge ownership automatically.

To generate the initial password setup link, run the same script with
`--create-invite`, or use Platform overview → Create publisher setup link. This
explicit action also resets an existing Digital Nudge publisher login. Normal
deployment never resets credentials or creates a new invitation.

Validation includes real FastAPI request/cookie tests, actual Convex handlers with
an indexed in-memory test database, TypeScript checks, production build, and local
browser checks using isolated demo API responses. Browser fixtures are not
production accounts or production uploads.
