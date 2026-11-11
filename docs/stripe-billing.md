# Stripe billing

Billing attaches to an Organization, including a single-person Organization.
Membership never changes the subscription quantity. Stripe owns prices, currencies,
taxes, discounts, payment methods and invoices; Rally owns eligibility and its
shared usage ledger. Configuration is opt-in: existing deployments keep their
current behavior until `BILLING_CONFIG` is supplied.

## Where the code lives

`apps/api/src/services/billing.ts` owns the lifecycle, with `billing-config.ts` and
`stripe.ts` beside it. The HTTP boundary is `routes/billing.ts`, the D1 schema is
`packages/db/migrations/0131_billing.sql`, and the shared desktop/browser UI is
`apps/desktop/src/renderer/components/organization-billing.tsx`.

## How it works

Administrators open Organization Usage settings, select an offer and supported
currency, optionally enable overages, and prepare Stripe Checkout. A direct
**Open Stripe** link opens the hosted flow on a user gesture in both clients;
returning to Settings refreshes billing status. The base
quantity is always one. Checkout collects billing addresses and tax IDs and uses
Stripe's configured payment methods. Stripe Billing Portal manages payment
methods, invoices and existing subscriptions. Configure its allowed plan changes
to prices in Rally's offer catalog.

Start is the free default plan and requires no checkout. The paid catalog maps
Grow, Max and Ultra to `growth`, `max` and `ultra`. Prices and included usage are
listed in [usage metering](usage-metering.md#plans); configure matching Stripe
prices before enabling billing. Changing a catalog entry does not migrate an
existing Stripe subscription to a new price.

The no-card trial starts at Organization creation. Defaults match the landing
page: 14 days, extended to 60 total days when three active members (the creator
and two teammates) join before expiry. Guests and pending invitations do not
qualify. The extension is earned once before a subscription is created; leaving
and rejoining cannot restart it. Membership triggers persist earned awards; the
first billing read also checks durable join times, so a day-15 read can recognize
a team formed on day 13. Open checkouts with older trial terms are expired and
recreated; a trialing subscription is extended if an older hosted checkout completed. Existing Organizations do not receive a new trial.
Stripe requires at least 48 hours for an explicit trial end; checkout in the last
two days rounds the remaining trial up to 48 hours, preserving the free trial.

Signed subscription webhooks and status/checkout recovery use the same reconciliation
path under an Organization ownership claim. Active/trialing subscriptions select
the configured offer; other states return to `unpaidPlan` (default `starter`).
No running work is suspended. Canceled and incomplete-expired subscriptions allow
fresh checkout; late events for older subscriptions cannot replace a current one.
Offer metadata disambiguates offers sharing a price, and a price-only match must
be unique. Unknown customers/other deployments are acknowledged and logged.

Closing an Organization holds the same claim as checkout. A live subscription or
open checkout blocks closure before the last member loses access. Restore billing
configuration before closing an Organization with a previously created customer.

Optional USD overages use the existing weekly quota and anniversary-month ledger.
The first partial period after consent/paid activation is free. A scheduled job
snapshots every fully closed period after the configured settlement delay (14 days
by default, matching maximum usage queue retention) and adds an invoice item to
the subscription's next invoice. Paid terms are stored per subscription, independently
of the current account. Cancellation records Stripe's `ended_at` and the quota
before downgrade. After the delay, the final partial month is calculated from
retained usage events through that cutoff; later usage is excluded. A final
standalone invoice includes remaining pending items for this Organization's Stripe
customer, uses the saved payment method when available, and is finalized for
collection. Re-subscription preserves the previous subscription's settlement.
Prices and quantities are frozen in permanent
receipts. A retry first searches Stripe invoice-item metadata since the closed period ended, even beyond Stripe's
24-hour idempotency retention, before issuing another write. No current-period
estimate is charged. Currency conversion is not guessed: non-USD plans cannot opt
into overages yet. The existing weekly allowance values remain defined by the
usage plan contract; changing Stripe prices does not change those allowances.

### Source of truth

Stripe owns subscriptions, their trial deadlines after checkout, discounts,
payment methods, invoices and collected payments. It is **not** a complete
record of every Organization's free period or usage in this implementation:

- Before checkout, trial eligibility and earned extensions live in regional D1;
  Stripe may not yet have a customer or subscription. Free Start accounts do not
  automatically create Stripe subscriptions.
- Checkout transfers the remaining trial to Stripe; reconciliation applies earned
  extensions to trialing subscriptions. Coupons are applied in Stripe.
- Detailed usage, included allowances and unbilled/free-period usage stay in Rally's
  usage ledger. Only settled, opted-in overage quantities become Stripe invoice items.
- The visitor-specific pilot offer on the landing page is not redeemed automatically
  by billing; its attribution parameter is not yet consumed by signup.

Making Stripe the complete billing authority would require provisioning every
Organization there, synchronizing all trial/promotion awards and reporting usage
(including included and free usage) through a durable, replayable integration.
Rally's event ledger would still be needed for audit and reconciliation.

## Invariants

- Client input selects catalog offer IDs, never Stripe price IDs or amounts.
  Otherwise a caller could buy an arbitrary price. Tests cover rejected selections.
- Only active Organization administrators, outside support sessions, access billing.
- Checkout never grants an entitlement; verified Stripe subscription state does.
- One open checkout is reused; changing an offer while one is open is refused.
- Overage receipts are immutable in quantity and price. Retrying cannot reprice an
  already charged period. Tests cover replay and pre-consent exclusion.
- Billing does not run on the inference request path. A Stripe outage cannot fail
  a model call.

## Boundary

`GET /workspace/billing`, `POST /workspace/billing/checkout` and
`POST /workspace/billing/portal` are authenticated administrator routes.
`POST /stripe/webhook` accepts Stripe-signed requests. Configure separate webhook
secrets/endpoints for each owning deployment if more regions are introduced.
The current deployment is Global. Standard member plan changes are rejected while
billing is configured; the engineering operator plan override remains available.

This module uses [usage metering](usage-metering.md), not provider invoices, for
usage totals. Enterprise contracts are offers configured by operators, mapped to
an existing quota plan. Consolidated invoicing across multiple Organizations and
custom quota plan definitions are not implemented.

## Failure modes and limits

Stripe errors carry HTTP status and allowlisted provider type/code plus declared
request fields; arbitrary metadata keys and provider messages are withheld. Each
Organization's scheduled failure is logged with its workspace ID and does not
stop the next Organization.

Concurrent operations return `billing_busy`. Ownership does **not** expire: no
clock deadline can allow a slow Stripe request and its replacement to both write.
A terminated Worker can leave `sync_token` set. Recovery requires an operator to
fence the original invocation (stop the old deployment and ensure it cannot resume)
then clear that token. Do not clear a token merely because it is old. Automatic
lease takeover was removed instead of assigning another guessed duration. Stripe
session/receipt discovery recovers uncertain external writes after release.

Unknown/ambiguous prices fail reconciliation: retain retired offers with
`enabled: false`. Extraordinary usage arriving after settlement needs manual
adjustment. The cancellation cutoff reader requires the cutoff week to remain in
the 90-day event-retention window; after that it fails closed with
`billing_cutoff_history_expired` rather than charging post-cancellation usage.
Recover from the retained usage lakehouse before collecting that exceptional tail.

## Testing

`apps/api/test/billing.test.ts` exercises real migrated SQLite and a fake Stripe
HTTP service: eligibility, checkout recovery, lifecycle transitions, authorization,
serialization, cancellation cutoffs and isolated settlement. The usage and
access-revocation suites cover their shared boundaries. Renderer tests cover the
direct-click handoff, focus refresh and the legacy picker after a failed status read.
Live Stripe and a full authenticated desktop/browser flow remain activation checks.

## Configuration and activation

1. Apply regional and usage D1 migrations, including usage migration 0003 for
   Max/Ultra plan history. Keep billing disabled until setup is complete.
2. Create recurring organization prices in Stripe for Grow, Max, Ultra and negotiated
   offers. Add currency options to those
   prices; amounts and tax behavior live in Stripe.
3. Set Worker secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` using the
   secret store, never a `VITE_` variable. Subscribe the webhook to
   `customer.subscription.created`, `.updated` and `.deleted`.
4. Enable the Billing Portal, Stripe Tax registrations in the jurisdictions where
   required, and supported payment methods. Worldwide availability is subject to
   Stripe's country, currency and payment-method coverage.
5. Set `BILLING_CONFIG` to JSON such as:

```json
{
  "returnUrl": "https://app.rallywith.ai",
  "automaticTax": true,
  "unpaidPlan": "starter",
  "trialDays": 14,
  "teamTrialDays": 60,
  "teamTrialMembers": 3,
  "settlementDelayDays": 14,
  "offers": [
    {"id":"grow","name":"Grow","plan":"growth","priceId":"price_REPLACE_GROW","currencies":["usd"]},
    {"id":"max","name":"Max","plan":"max","priceId":"price_REPLACE_MAX","currencies":["usd"]},
    {"id":"ultra","name":"Ultra","plan":"ultra","priceId":"price_REPLACE_ULTRA","currencies":["usd"]}
  ]
}
```

For an automatic special, supply an offer's `couponId`; otherwise Checkout accepts
Stripe promotion codes. Disable new sales with `enabled: false`, retaining the
price mapping. For overages, add `overagePriceId` pointing to a one-time USD price
with `unit_amount_decimal: "0.0001"` cents (one micro-USD), tax behavior and product
tax code configured. Do not use a recurring metered price here: settlement creates
invoice items. Catalog changes need only Worker configuration and Stripe settings;
landing-page prose must be kept aligned separately.

## Changelog

### 2026-11-11 — Organization subscriptions and optional usage settlement

Added configurable Stripe offers, no-card trial eligibility, shared-account checkout,
portal access, verified subscription reconciliation and durable overage receipts.
The product needs group pricing and changing promotions without coupling seats to
charges. Stripe-hosted payment collection was chosen over storing payment details.
The existing ledger stays the usage authority; speculative currency conversion and
per-event charges were rejected because they would diverge from its weekly quota.
Recovery and webhook reconciliation share one path so a lost delivery cannot leave
paid customers on the wrong plan. Non-expiring ownership prevents stale writers;
per-subscription terms preserve obligations through cancellation and re-subscription.
Future changes must preserve pre-consent exclusion, cancellation cutoffs and
permanent charge receipts.
