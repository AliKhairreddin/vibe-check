# Stripe Managed Payments

Billing belongs to the advertiser workspace; included publisher teams never pay separately. Existing workspaces `acp`, `kissterra`, `lead-economy`, and `smart-financial` are the frozen free-access cohort. They need no Stripe customer, card, or subscription. A missing billing row does not grant free access to any other workspace. Existing quotas remain unchanged.

New advertisers are provisioned by the owner under Advertiser plans after configuring the offer and guidelines. The seven-day invitation creates a login; it does not grant product access. Starter and Growth checkout is available after signing in. The public pricing page remains sales-assisted. Enterprise pricing and capacity remain by agreement; the Enterprise catalog price is the published starting price, not a promise of fixed custom capacity.

## Production setup

Target Stripe account: `acct_1UQElt24SyhXpvZG` (AdChecked), in **live mode**. The other THAT CANADIAN SOFTWARE SERVICES Stripe account is a separate account. Do not mix their API credentials, products, prices, or webhook secrets.

1. Complete live activation and Managed Payments onboarding in Stripe. The account owner must handle bank details, tax residency, verification and acceptance of terms.
2. Put the AdChecked live secret key in the ignored, private `.env.stripe` file as `STRIPE_SECRET_KEY=...`. Do not paste it into chat or commit it. For routine runtime use, a restricted live key needs Customers and Checkout Sessions write, Customer Portal write, and Prices, Subscriptions and Invoices read. Provisioning additionally needs Products, Prices, Webhook Endpoints and Portal Configuration write and Account read.
3. Run `node --env-file=.env.stripe scripts/setup-stripe.mjs --configure-convex`. It verifies the account ID before writing, provisions three products and five USD recurring prices, configures period-end cancellation and Starter/Growth plan changes, and securely sets the Convex environment. No charge or subscription is created. Reruns reuse product IDs and price lookup keys. `.env.stripe.billing` is a private ignored recovery file containing the webhook secret and catalog IDs. If creating the webhook succeeded but its response was lost, retrieve its signing secret from Stripe and put it in that file before retrying.
4. Keep secrets only in Convex environment variables. The frontend and Cloudflare Worker need no Stripe key. Configure `STRIPE_BILLING_MODE=live`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION`, and `STRIPE_PRICE_{STARTER,GROWTH}_{MONTH,YEAR}`. `STRIPE_PRICE_ENTERPRISE_MONTH` identifies the agreed base Enterprise product for reconciliation; no generic Enterprise self-service checkout is exposed.
5. Push main. The existing deployment workflow verifies code, deploys Convex, initializes the free cohort, and deploys Cloudflare. Monitor it through the final backend health check. Never run local `wrangler deploy` for this repository.

The live webhook URL is `https://energetic-partridge-813.convex.site/stripe/webhook`. Use the API version pinned by Stripe SDK 23.0.0 (`2026-09-30.endive`). Setup registers checkout completion and asynchronous payment results; subscription create, update, delete, pause and resume; invoice paid, payment failure/action-required/finalization-failed; and customer deletion.

## Access and synchronization

The backend checks workspace ownership from signed sessions; no browser-supplied Stripe customer IDs are accepted. Only an active Managed Payments subscription to a configured price, quantity one, with a paid latest invoice and an unexpired paid-through date grants new-workspace access. Trials do not grant free access. Returning from Checkout does not unlock the app. Billing and sign-in remain available while payment is required. Publisher uploads also check entitlement in the durable mutation that reserves quota.

Webhooks verify raw-body signatures and mode, deduplicate event IDs, then synchronize current Stripe state. Concurrent reads use leases and revision checks, preventing an older provider read from overwriting a newer event. Failed or incomplete API reads preserve the last good state and quota; access still ends at the confirmed paid-through date. Successful reconciliation updates Starter/Growth allowances without resetting calendar-month usage. Cancellation at period end preserves access until then; canceled, incomplete, past-due, unpaid and paused subscriptions do not grant access.

Ordinary pages read saved Convex state. Webhooks refresh changed records; reconciliation is otherwise daily, at the paid-through boundary, or after a deliberate customer refresh (at most once per minute). A five-minute recovery cron retries failed or interrupted synchronization. Event receipts retain IDs only for 30 days. Customer deletion revokes access, removes local provider identifiers, and uses a new customer generation if the workspace later restarts.

## Validation and recovery

`pnpm run verify` covers payment gating, the free cohort, signed webhooks, wrong-mode events, duplicate deliveries, concurrent checkout, stale synchronization, failed reads, invitations, cross-workspace access and publisher restrictions. Local responsive billing previews are disposable and must not ship.

Before declaring payments ready, open a real live Checkout session without completing a purchase and verify plan, amount, interval, tax handling and Link merchant-of-record labeling. A live charge must be completed by the account owner/customer. Test successful payment, failure, renewal, cancellation and webhook delivery in a separate Stripe test deployment; never point production workspaces at sandbox prices or keys. Monitor Stripe delivery failures and `billingWorkspaces.syncError` after rollout.

If checkout is unavailable, inspect Convex configuration, account capabilities and Managed Payments eligibility. Preserve current records on provider errors. Use `billing:requestSync` through the signed billing endpoint to reconcile deliberately. Do not manually mark a workspace active from a Checkout redirect or invoice screenshot.

Sources: [Stripe Managed Payments setup](https://docs.stripe.com/payments/managed-payments/set-up), [eligibility](https://docs.stripe.com/payments/managed-payments/eligibility), [customer management](https://docs.stripe.com/payments/managed-payments/how-it-works).
