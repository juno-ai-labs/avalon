# Stripe billing

Billing attaches to an Organization, including a single-person Organization.
Membership never changes the subscription quantity. Stripe owns prices, currencies,
taxes, discounts, payment methods and invoices; Rally owns eligibility and its
shared usage ledger. Configuration is opt-in: existing deployments keep their
current behavior until `BILLING_CONFIG` is supplied.

## Where the code lives

- `apps/api/src/services/billing-config.ts`: validated offer and promotion configuration.
- `apps/api/src/services/billing.ts`: trial, checkout, reconciliation and settlement.
- `apps/api/src/services/stripe.ts`: Stripe REST adapter and raw-body signature verification.
- `apps/api/src/routes/billing.ts`: administrator API and public signed webhook.
- `packages/db/migrations/0131_billing.sql`: organization/customer mapping and permanent settlement receipts.
- `apps/desktop/src/renderer/components/organization-billing.tsx`: shared desktop/browser settings.

## How it works

Administrators open Organization Usage settings, select an offer and supported
currency, optionally enable overages, and continue to Stripe Checkout. The base
quantity is always one. Checkout collects billing addresses and tax IDs and uses
Stripe's configured payment methods. Stripe Billing Portal manages payment
methods, invoices and existing subscriptions. Configure its allowed plan changes
to prices in Rally's offer catalog.

The no-card trial starts at Organization creation. Defaults match the landing
page: 14 days, extended to 60 total days when three active members (the creator
and two teammates) join before expiry. Guests and pending invitations do not
qualify. The extension is earned once before a subscription is created; leaving
and rejoining cannot restart it. Existing Organizations do not receive a new trial.
Stripe requires at least 48 hours for an explicit trial end; checkout in the last
two days rounds the remaining trial up to 48 hours, preserving the free trial.

Signed subscription webhooks re-fetch current Stripe state under an Organization
lock. Active/trialing subscriptions set the existing usage plan and publish the
meter. Past-due/canceled states are recorded without erasing the usage history.
Billing does not suspend running work: there is currently no subscription access
enforcement. A canceled subscription remains attached for operator reconciliation;
self-service re-subscription after cancellation is not yet implemented.

Optional USD overages use the existing weekly quota and anniversary-month ledger.
The first partial period after consent/paid activation is free. A scheduled job
snapshots every fully closed period after the configured settlement delay (14 days
by default, matching maximum usage queue retention) and adds an invoice item to
the subscription's next invoice. Prices and quantities are frozen in permanent
receipts. A retry first searches Stripe invoice-item metadata, even beyond Stripe's
24-hour idempotency retention, before issuing another write. No current-period
estimate is charged. Currency conversion is not guessed: non-USD plans cannot opt
into overages yet. The existing weekly allowance values remain defined by the
usage plan contract; changing Stripe prices does not change those allowances.

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

Stripe errors are surfaced with their HTTP status and retried by webhook delivery
or the next scheduled run. Concurrent operations return `billing_busy`. The lock's
five-minute lease allows recovery after a terminated Worker. Unknown prices fail
reconciliation: retain retired offers with `enabled: false` so old subscriptions
can still be recognized. An open checkout must finish or expire before selection
changes. Late usage arriving after settlement is not automatically adjusted;
reconcile exceptional late events with Stripe credit/debit adjustments.

Subscription payment failure and cancellation update status, but do not currently
revoke product access. Existing clients cannot change a paid plan via the old
plan endpoint. Stripe keys are absent from the client and from source control.

## Testing

`pnpm --filter @rally/api exec vitest run test/billing.test.ts test/usage-metering.test.ts`
uses real migrated SQLite and a fake external Stripe HTTP service. It covers trials,
checkout reuse, selection validation, signature rotation/tampering/replay and
settlement receipts. Full lint and typecheck cover both client platforms.
Live Stripe checkout, portal, tax registrations and payment methods require a
Stripe test account and must be exercised before production activation.

## Configuration and activation

1. Apply regional D1 migrations. Keep billing disabled until setup is complete.
2. Create recurring organization prices in Stripe: Start $100/month and Grow
   $250/month, plus negotiated offers if needed. Add currency options to those
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
  "trialDays": 14,
  "teamTrialDays": 60,
  "teamTrialMembers": 3,
  "settlementDelayDays": 14,
  "offers": [
    {"id":"start","name":"Start","plan":"starter","priceId":"price_REPLACE_START","currencies":["usd"]},
    {"id":"grow","name":"Grow","plan":"growth","priceId":"price_REPLACE_GROW","currencies":["usd"]}
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
Future changes must preserve pre-consent exclusion and permanent charge receipts.
