# Stripe billing

Billing attaches to an Organization, including a single-person Organization.
Membership never changes the subscription quantity. Stripe owns prices, currencies,
taxes, discounts, payment methods and invoices. With synchronization enabled it
also records free-account trials, earned awards and all recorded usage totals;
Rally retains its eligibility rules and audit ledger. Configuration is opt-in: existing deployments keep their
current behavior until `BILLING_CONFIG` is supplied.

## Where the code lives

`apps/api/src/services/billing.ts` owns the lifecycle, with `billing-config.ts` and
`stripe.ts` beside it. `billing-coordination.ts` routes writes to the regional
`BillingCoordinatorDO`, one actor per Organization. `stripe-billing-sync.ts` synchronizes free-account trial
records, allowance metadata and usage meters. The HTTP boundary is `routes/billing.ts`, the D1 schema is
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

Start is the free default plan and requires no checkout. When synchronization is
enabled, it receives a Stripe customer and a separate zero-price subscription
record without collecting a card. This record is excluded from paid-subscription
eligibility and never consumes the first-paid pilot offer. The paid catalog maps
Grow, Max and Ultra to `growth`, `max` and `ultra`. Prices and included usage are
listed in [usage metering](usage-metering.md#plans); configure matching Stripe
prices before enabling billing. Changing a catalog entry does not migrate an
existing Stripe subscription to a new price.

The no-card trial starts at Organization creation. Defaults match the landing
page: 14 days, extended to 60 total days when three active members (the creator
and two teammates) join before expiry. Guests and pending invitations do not
qualify. The extension is earned once before a subscription is created; leaving
and rejoining cannot restart it. Membership triggers retain the active-member count at each qualifying transition,
even before a billing account exists. The first billing read can recover a team
formed on day 13 after a teammate leaves. Guest promotion and reactivation count
when they happen, not at an older join date. Existing relationships are first
recorded at migration; earlier membership transitions cannot be reconstructed. Open checkouts with older trial terms are expired and
recreated; a trialing subscription is extended if an older hosted checkout completed. Existing Organizations do not receive a new trial.
Stripe requires at least 48 hours for an explicit trial end; checkout in the last
two days rounds the remaining trial up to 48 hours, preserving the free trial.

When `pilotCouponId` is configured, every Organization's first paid monthly
subscription automatically receives that Stripe coupon. The pilot takes precedence
over the offer's ordinary coupon and promotion-code entry. Checkout collects a
payment method even when the first invoice is zero, starts the subscription
immediately, and does not stack the no-card/team trial. Included plan allowances
remain unchanged. Overage invoice items are explicitly non-discountable, including
on final cancellation invoices; the existing first-partial-period settlement policy
still applies.

Stripe's paginated subscription history decides first-paid eligibility, including
canceled subscriptions whose webhooks never reached Rally. A canceled pilot counts
as used even though its invoices were free. Zero-price Start subscriptions and
expired incomplete payments do not consume the offer. No browser date, signup
link or local-storage flag grants financial eligibility. Each Organization has its
own eligibility; this is not a once-per-person promotion. Subscription metadata
records the pilot coupon so reconciliation preserves its treatment after the
campaign is disabled. Re-subscribing after a paid subscription also cannot restart
the remaining no-card trial.

Signed subscription webhooks and scheduled/checkout recovery use the same reconciliation
path inside the Organization billing actor. Active/trialing subscriptions select
the configured offer; other states return to `unpaidPlan` (default `starter`).
Organizations without a subscription return to the unpaid plan, including legacy
self-service upgrades. An engineering-MCP plan change records an explicit override
that reconciliation preserves. No running work is suspended. Canceled and incomplete-expired subscriptions allow
fresh checkout. Recovery reads all history pages and closes canceled terms before
replacing the current subscription; late old events close only their own terms.
Offer metadata disambiguates offers sharing a price, and a price-only match must
be unique. Unknown customers/other deployments are acknowledged and logged.

Both self-service closure and operator retirement execute their D1 closure fence inside the same actor as checkout. A live subscription or
open checkout blocks closure before the last member loses access. Restore billing
configuration before closing an Organization with a previously created customer.
Synchronous closure never provisions a customer. Background reporting can create
one for retained usage from an Organization closed before its first sync. It cancels an existing zero-price record;
failed cleanup retries in the background. Closed accounts leave the sweep once
free-record cleanup and final paid invoices finish, but pending usage hours independently re-enroll
them, including queued usage that arrives after cleanup. Retirement can resume for
an already abandoned Organization with no billing account without provisioning one.

Optional USD overages use the existing weekly quota and anniversary-month ledger.
The first partial period after consent/paid activation is free. A scheduled job
snapshots every fully closed period after the configured settlement delay (14 days
by default, matching maximum usage queue retention) and adds an invoice item to
the subscription's next invoice. Billable intervals stop when consent is removed, the plan/currency no longer supports
overages, or the subscription leaves active status. Resumption starts a new interval
and waives its first partial period; suspended gaps never become debt. The prior
interval retains its cutoff and quota before any entitlement downgrade.
Terms start at Stripe activation (after any subscription trial), without waiting
for an unused no-card deadline. Paid terms are stored per subscription, independently
of the current account. If activation was missed before cancellation, paid Stripe
subscription invoice periods recover the start, including zero-total pilot invoices.
A trial-only invoice or an unpaid incomplete subscription does not prove activation.
Cancellation records Stripe's `ended_at` and the quota
from the cutoff week's recorded quota, falling back to that subscription's
offer if no rollup exists. After the delay, the final partial month is calculated from
retained usage events through that cutoff; later usage is excluded. A final
standalone invoice includes remaining pending items for this Organization's Stripe
customer, uses the saved payment method when available, and is finalized for
collection. Re-subscription preserves the previous subscription's settlement.
A recorded final invoice retries finalization without recalculating usage, so
expired raw history cannot reopen an already snapshotted obligation. Prices and
quantities are frozen in permanent receipts. A retry first searches Stripe invoice-item metadata since the closed period ended, even beyond Stripe's
24-hour idempotency retention, before issuing another write. No current-period
estimate is charged. Currency conversion is not guessed: non-USD plans cannot opt
into overages yet. The existing weekly allowance values remain defined by the
usage plan contract; changing Stripe prices does not change those allowances.

### Synchronization and source of truth

Set `synchronization` to provision every local Organization in Stripe on the
existing five-minute scheduled tick, including accounts that never open billing.
`pnpm env:sync` copies the optional server keys and preserves the JSON catalog
through local dotenv encoding. Status GETs use stored state without waiting for the billing actor or making provider calls. A single
focus listener refreshes that cache on return from Stripe. Webhooks and scheduled
recovery refresh paid lifecycle state even without usage synchronization. Profile
synchronization is separate, so a bad free price cannot block checkout or closure.
Customer metadata search and subscription discovery recover lost create receipts
beyond Stripe's idempotency window without scanning all customers. Search is
eventually consistent; the stable creation key covers immediate retries. The Organization actor serializes all external writes. Usage reporting runs even if
profile synchronization fails; an empty usage outbox makes no meter-definition calls.

The separate zero-price subscription has `billing_role=free_record`. It records
the no-card trial and earned team extension; its metadata keeps the original
start, base deadline, team deadline and qualification rule even when initial sync
happens after expiry. A persisted award receipt prevents repeatedly applying the
same deadline, so subsequent edits to the free-record trial deadline in Stripe
refresh Rally's checkout cache. Paid subscriptions and pilot coupons retain their
existing lifecycle. Before Checkout, the free subscription is canceled and retained
as award history, releasing Stripe's active-subscription currency restriction. A durable
marker prevents cron recreating it while Checkout is pending. If paid checkout happened
before the free record existed, awards are recorded on the Stripe customer without
creating a conflicting free subscription. Customer metadata shows the current plan, included allowance,
weekly allocation, quota anchor, paid/free subscription IDs, available pilot
coupon, meter IDs and pending/failed usage-hour counts. Metadata reflects the
latest profile sync, so delivery counts may lag one scheduled tick.

Every accepted usage event atomically updates `billing_usage_hours` through a
usage-database trigger. Separate Organization-paid and Rally-paid totals are
kept per UTC hour, including free accounts, trial/pilot periods, included usage
and overages. These permanent totals and their revisions form the delivery outbox;
pruning raw events after 90 days does not remove pending or confirmed totals.
Migration 0004 backfills the retained event ledger before installing the trigger.

Two dedicated Stripe meters use `event_time_window=hour` and sum aggregation.
Each send contains the **absolute** micro-USD total for its hour. Stripe replaces
the earlier value for that hour, so replay after an uncertain response cannot
add the same usage twice, even after its 24-hour identifier-deduplication window.
A retry uses a fresh event identifier; replay safety comes from Stripe's
[hourly replacement semantics](https://docs.stripe.com/billing/subscriptions/usage-based/meters/configure).
A late event increments the revision and causes the complete total to be resent.
A receipt for an older revision cannot acknowledge a concurrent ledger update.
Only customer IDs, timestamps and aggregate cost values leave Rally; detailed
per-event identities remain in its ledger/lakehouse.

Stripe processes events asynchronously. The background synchronizer reads meter
summaries before marking a revision confirmed. A mismatch stays pending and
visible for reconciliation. **Sync errors and mismatches do not block overage
invoicing.** Settlement continues independently using Rally's existing weekly
allowance and closed-period calculation; the reporting meters are not attached to
billable prices, which would charge the same usage again.

Stripe is the operational record for customers, trial awards, subscription
state, applied promotions, reported usage totals, invoices and payments. Rally's
ledger remains the audit/replay source and calculates the existing allowance and
overage rules. This does not migrate that custom arithmetic to Stripe prices or
credit grants. Synchronization is eventual, and its pending/error state matters
when comparing the two systems.

Stripe accepts usage timestamps only within the past 35 days. Older unsent hours
remain in the outbox with terminal `billing_usage_timestamp_expired`; later ticks
skip them while diagnostics continue to count them. They are never
re-timestamped into today's usage. Events already pruned before migration 0004
remain in the lakehouse and rollups, not in Stripe's event history. This provider
boundary means historical completeness cannot be claimed simply by enabling the
integration. Unknown-cost events and failed producer queue sends retain the
existing usage-metering limitations.
Stripe documents the ingestion window and asynchronous processing in
[recording usage](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api).

### Recovery

- `billing_usage_hours` records the current total/revision, meter, last sent and
  confirmed revisions/times, and a diagnostic error code. Inspect rows whose
  confirmed revision differs from the current one, or whose meter differs from
  the configured payer meter. Customer metadata summarizes pending/failed hours.
- An interrupted send is replayed automatically. A successful send awaiting
  aggregation is rechecked on later ticks. Provider failures remain pending and
  retry without preventing the next hour or Organization from synchronizing.
- For an asynchronously rejected event, fix the provider/configuration cause,
  then set that hour's `sent_revision=0, confirmed_revision=0` to replay its
  absolute total. Do not edit the amount or raw ledger to hide a discrepancy.
- Before changing meter IDs, plan the historical migration: events older than
  Stripe's 35-day ingestion window cannot be silently copied into a new meter.
  Use the retained audit history for an operator-led financial adjustment where
  needed; a current-timestamp event is not a historical backfill.

## Invariants

- Client input selects catalog offer IDs, never Stripe price IDs or amounts.
  Otherwise a caller could buy an arbitrary price. Tests cover rejected selections.
- Only active Organization administrators, outside support sessions, access billing.
- Checkout never grants an entitlement; verified Stripe subscription state does.
- A matching open checkout is reused; changing offer, currency or overage consent
  expires the old session before preparing its replacement inside the same actor.
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

Billing writes run to completion inside one `BillingCoordinatorDO` per Organization.
Concurrent calls receive `billing_busy` and can retry once the current operation
finishes. Its actor-local busy flag is released even on failure. Runtime restart
destroys both the executing code and that flag,
so no D1 lock survives a crash and no guessed lease can overlap a live writer.
Interactive calls use RPC because the administrator needs the URL or closure result;
the scheduled sweep retries unfinished D1/Stripe receipts on its next tick. Provider
writes still require idempotency and receipt discovery: actor serialization cannot
make Stripe and D1 one transaction. Checkout saves its exact request before sending it. After an uncertain result,
recovery discovers the open session or replays that same request and idempotency key
before accepting changed terms; an incompatible session is then expired. An
outstanding request also blocks closure until recovered. Billing actors remain reachable after the
Organization's content objects are retired, so late usage and final invoices can finish.

Unknown/ambiguous prices fail reconciliation: retain retired offers with
`enabled: false`. Extraordinary usage arriving after settlement needs manual
adjustment. The cancellation cutoff reader requires the cutoff week to remain in
the 90-day event-retention window; after that it fails closed with
`billing_cutoff_history_expired` rather than charging post-cancellation usage.
Recover from the retained usage lakehouse before collecting that exceptional tail.

## Testing

`apps/api/test/billing.test.ts` exercises real migrated SQLite and a fake Stripe
HTTP service: eligibility, checkout recovery, lifecycle transitions, authorization,
billable intervals, missed activation, old-subscription cutoffs, lazy trial awards, operator retirement,
provider-free status reads and isolated settlement.
`test-workers/billing-coordinator.test.ts` exercises real actor serialization,
restart recovery after an uncertain provider response, and signed webhook dispatch/tampering through Hono and the actor.
`test/stripe-billing-sync.test.ts` covers profile recovery, awards, first-paid
eligibility, hourly delivery, delayed aggregation, replay, concurrent updates,
retention, terminal expiry, closed-account cleanup and settlement continuing
through sync failures.
`test-workers/usage-ledger.test.ts` proves the hourly outbox and rollup remain
atomic when queue batches overlap on real D1. The usage and
access-revocation suites cover their shared boundaries. Renderer tests cover the
direct-click handoff, focus refresh and the legacy picker after a failed status read.
Live Stripe and a full authenticated desktop/browser flow remain activation checks.

## Configuration and activation

1. Max/Ultra usage requires desktop/browser contract 15. Older clients receive
   `client_update_required` on those usage reads and skip those socket snapshots;
   other plans and app activity retain their existing compatibility.
   Apply regional and usage D1 migrations, including usage migration 0003 for
   Max/Ultra plan history and 0004 for the permanent hourly usage outbox. Keep billing disabled until setup is complete.
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

To synchronize free accounts and all recorded usage, create a dedicated **$0
monthly licensed price** on a separate trial-record product. Exclude that product
from the Billing Portal's editable subscription products; it must stay free.
Create two reporting-only Stripe meters with sum aggregation and
`event_time_window: "hour"`, one for Organization-paid micro-USD and one for
Rally-paid micro-USD. Do not attach these meters to billable prices. Add:

```json
"synchronization": {
  "freePriceId": "price_REPLACE_FREE_RECORD",
  "organizationMeterId": "mtr_REPLACE_ORGANIZATION",
  "rallyMeterId": "mtr_REPLACE_RALLY"
}
```

The API validates the free price and meter ingestion mode before provisioning or
sending. Use separate Stripe resources per deployment/account; keep webhook
routing aligned with Organization ownership. Verify in test mode that free
records remain zero-price, team awards update their trial, the pilot remains
available at paid checkout, and repeated hourly totals replace rather than add.
Omitting `synchronization` preserves the earlier checkout-only integration.

To enable the two-month pilot, create a Stripe coupon with `percent_off: 100`,
`duration: "repeating"`, and `duration_in_months: 2`, then add its ID as the top-level
`pilotCouponId` in `BILLING_CONFIG`. Use monthly prices (`interval: "month"`,
`interval_count: 1`); checkout rejects annual/multi-month pilot prices because a
percentage coupon would otherwise waive the entire longer invoice. Scope the
coupon to the subscription products if desired, including all three paid plans.
Percentage discounts work across the catalog's supported currencies. Stripe owns
the discount duration/percentage and returns billing to the normal subscription
price when it expires. Keep the landing claim aligned if those terms change.

Omit `pilotCouponId` to stop new pilot checkouts without removing existing discounts.
A pending checkout is replaced with current campaign terms when an administrator
returns through Rally; already-open hosted pages can still complete until expiry.
For an immediate campaign cutoff, expire those Stripe Checkout Sessions as well.
Remove the landing offer card when ending the campaign. Before live activation,
use Stripe test mode/test clocks to verify two discounted monthly invoices, a
normal third invoice, card collection, tax treatment, and a non-discounted overage
invoice item. Live credentials and coupon provisioning are deployment steps.

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
The pilot uses a Stripe discount rather than a trial because only subscription fees
are waived: included usage stays available and opted-in overages remain billable.
Stripe history prevents repeat redemption without a second local promotion ledger;
visitor-specific marketing deadlines were removed in favor of first-paid eligibility
for every Organization while the campaign is enabled.
Free-account records and hourly usage synchronization were added so Stripe can
hold the billing record before checkout and through free usage. Hourly absolute
values were chosen over raw-event retries because Stripe only deduplicates event
identifiers for at least 24 hours. The audit ledger stays durable; reconciliation
is background work and deliberately does not gate invoice collection.
Qualification counts are recorded before lazy account creation, so departures
cannot erase earned trials and old guest join dates cannot earn new ones. Status
reads avoid the actor writer, and paid recovery precedes settlement independently
of reporting. Customer search replaces account-wide scans; finalized terms and
expired usage revisions stop repeating work. Explicit operator plan overrides
survive paid-state reconciliation.
Per-Organization actors replace crash-stranding D1 claims; a lease timeout was
rejected because it cannot prove a slow external writer has stopped. Explicit
billable intervals preserve earlier obligations while excluding suspended gaps.
Canceled history can recover missed activation from paid invoice evidence. Free
subscriptions are archived at checkout to release currency locks, and the outbox
keeps closed Organizations eligible for usage reporting. These boundaries are
independent of the requested removal of the usage-reconciliation collection gate.
Future changes must preserve pre-consent exclusion, cancellation cutoffs and
permanent charge receipts.
