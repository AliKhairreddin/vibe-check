# Interactive demo workspaces

Public and sign-in pages link to `/demo` on the client portal. The chooser offers
publisher, advertiser, administrator, and employee experiences. All use the existing
application routers, dashboards, filters, forms, review components, and decision-status
logic under `/demo/workspace`. Role changes retain the visitor's data. Starting fresh
creates a new independent dataset.

## Isolation and lifecycle

- The Worker issues a random 256-bit, host-only `__Host-adchecked_demo` capability cookie
  (`Secure`, `HttpOnly`, `SameSite=Strict`, fixed 24-hour lifetime). Only its SHA-256 hash
  is stored. Demo credentials are never production login credentials.
- Every demo API call goes through `/api/demo/`. The Worker returns directly before
  production read shortcuts, containers, email delivery, or partner dispatch. Requests
  require the same origin for mutations. Demo handlers never fall back to production.
- The Convex functions require the existing server-only `CONVEX_HTTP_SECRET`. Each
  request loads exactly the workspace selected by the token hash, checks its expiry,
  and enforces the selected role. IDs and request bodies cannot select a different
  workspace. Unknown operations are denied. No production table is read or written.
- `demoWorkspaces` holds a bounded snapshot of all sample records and edits. A scheduled
  internal mutation deletes it at the 24-hour deadline; a five-minute indexed sweep
  provides recovery in batches of ten workspaces (below transaction read limits even
  for full snapshots) and removes expired rate-limit records in bounded batches. Expired
  sessions are rejected on every request even before cleanup runs. There are no demo
  files, external objects, or child records to orphan. Signing out deletes the snapshot.
- Browser preferences and active batches use separate, expiring session storage in demo
  mode. They never load or overwrite normal account preferences or submission drafts.
  A fresh workspace resets its browser state. No migration/adoption endpoint exists.

## Samples and simulations

Each workspace starts with two explicitly fictional insurance offers, two publishers,
three campaign batches, twelve reviews, findings, sample creative artwork, advertiser
feedback, and a disabled sample automation. Visitors can submit simulated reviews,
release them, switch to the advertiser to record decisions, edit policies, manage
publishers and plans, filter histories, and download illustrative reports.

Reviews use deterministic examples, **not live AI assessment**. Files remain on the
visitor's device; only bounded copy and filename metadata are sent. Artwork is synthetic.
Email previews and sends are simulated inside the snapshot with no provider call.
Publisher invites and share links are explicitly simulated. Automation edits persist,
but enabling a schedule never registers background execution; manual checks simulate
results. Live integration calls, real API keys, payments, and consequential operations
are denied. The API reference's live request runner is also disabled in demo mode.

“Create your account” opens `/signup?from=demo` on the client hostname. Visitors
create an email/password account and a new private advertiser workspace immediately;
no invitation or sales contact is required. Signup creates a blank disabled policy,
a starter allowance and an unpaid subscription record atomically. It never reads or
copies a demo workspace. The real session cookie and demo capability are independent.
Demo cleanup is attempted only after signup succeeds; failure does not undo the real
account and the original 24-hour cleanup still applies.

The signed-in visitor lands at `/client/setup` to add their own guidelines. Setup is
available before subscribing; existing billing gates still protect reviews and
publisher operations. Pricing can supply `plan=starter|growth&interval=month|year`
to continue to hosted checkout, with retry after an account is created. Existing
free accounts keep their exemption and are never enrolled by signup.

Signup accepts only workspace name, email and password. The Worker checks host,
origin and body size, replaces untrusted gateway headers, and derives an IP hash.
The backend requires this trusted gateway and enforces a global Convex admission
limit before password hashing (5 attempts/IP/hour, 200 total/hour). Limiter rows
expire after one hour. Provisioning rejects duplicate normalized login names and
workspace IDs. Passwords use the application's existing scrypt implementation and
sessions use the existing signed HttpOnly cookie. Signup does not send email or
create a Stripe customer until the visitor proceeds to checkout.

## Resource bounds

- Cloudflare edge admission: 240 demo requests per IP per minute, separate from sign-in.
- Durable creation: five workspaces per hashed IP per hour and 300 globally per hour.
- Durable session admission: 180 total requests and 30 mutations per minute.
- 50 KB request bodies; 650 KB maximum saved snapshot; 80 reviews, eight offers,
  20 batches (up to 20 items each), ten publishers/automations, 20 simulated shares,
  and 15 email previews. Larger requests fail without replacing good data.
- Mutations are transactional, preserving concurrent edits through Convex conflict
  retries. Limits persist across cookie deletion, role changes, and edge locations.

## Verification

`pnpm run verify` includes `tests/demo.test.ts`: separate-visitor isolation, forged IDs,
role restrictions, immutable automated verdicts, submit/release/decide, expiry, scheduled
and fallback deletion, durable rate limits, CSRF/cookie protections, fail-closed storage,
and no outbound work for simulated email/automation actions. The fixture rejects access
to every table except the two demo tables. Browser QA covers mobile and 1920px layouts,
expanded/collapsed navigation, refresh persistence, and the real review forms.
