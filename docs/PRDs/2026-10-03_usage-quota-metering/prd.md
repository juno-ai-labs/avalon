# Usage quota metering

> Created 2026-10-03.
>
> A pooled weekly inference quota per Organization, metered off the agent
> loop's path and shown as a percentage, with overage shown but not charged.
> Architecture: [`design.md`](design.md). Platform research:
> [`research.md`](research.md). State: [`state.md`](state.md).
> Standing contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [the inference lakehouse](../../inference-lakehouse.md),
> [choosing a Queue or RPC](../../choosing-queues-or-rpc.md),
> [the agent harness](../../agent-harness.md) and
> [member roles](../../workspace-member-roles.md).

## Summary

Each Organization is on one of two plans: **Starter** at $100 a month or
**Growth** at $250 a month. Each plan includes twice its price in inference,
and the weekly quota is that amount divided by four:

| Plan | Price per month | Twice the price | Weekly quota |
| --- | --- | --- | --- |
| Starter | $100 | $200 | $50 |
| Growth | $250 | $500 | $125 |

A month averages about 4.35 weeks, not four, so an Organization that uses every
week's quota gets about 8.7% more than twice its price: about $217 a month on
Starter and $543 on Growth. That is deliberate. Dividing by four keeps the
weekly figure round, and the extra is a small, predictable cost to Rally.

Everyone in the Organization draws on one shared pool. The pool starts each
week at 100% and runs down as Rally does work for the Organization. The week
starts at the instant the Organization was created and resets exactly every 7
days after that. An Organization created on a Thursday at 9:00 AM resets every
Thursday at 9:00 AM.

Members see a percentage, never a dollar figure for the quota. Once the quota
reaches 0%, further usage adds to an **overage** total, priced at standard
inference cost. The total grows through the month and resets each month. Today
it shows struck through, marked as not billed.

Each kind of inference Rally runs is a **metered activity**. One map in code
says, for each activity, whether the Organization pays or Rally pays. Today the
Organization pays for every one. Moving an activity, such as Channel naming, onto
Rally's tab is a one-line change.

## Motivation

Pricing is settled and nothing in the product knows about it. No plan, quota,
seat or billing column exists anywhere in D1. An Organization's spend cannot be
read from any store the product queries.

The cost of nearly every model call is already captured, but it lands in places
that cannot answer "how much has this Organization used this week":

- The [inference lakehouse](../../inference-lakehouse.md) records each request
  and attempt with `workspace_id` and `cost_microusd`. It is an Iceberg table,
  files roll every 300 seconds, and its own document says it is not billing
  authority.
- The `runs` and `inference_attempts` tables hold cost per Channel, inside each
  `SubstreamAgent`. Nothing rolls them up to the Organization.
- `RUN_ANALYTICS` (Analytics Engine) indexes on `source:region`, not
  Organization, and it samples.
- Embeddings, audio generation, message speech, dictation and PDF OCR record no
  cost at all. The addressing classifier and Sidekick trigger gate record tokens
  but no cost.

Charging comes later, and when it does Rally will need weeks of history it can
trust in order to check that the plans are priced right. Members also need to
see the meter run before any charge appears, so the first invoice is not the
first sign that usage counts. Each week without metering is a week of history
lost.

## Goals

1. Every Organization has a plan, Starter or Growth, and its weekly quota is
   twice the monthly price divided by four.
2. Every inference Rally runs for an Organization produces exactly one metered
   usage record with a cost. No activity is left out or recorded at zero cost.
3. Metering adds no awaited work to the agent loop, a Channel open, or any other
   user-facing request. A failure anywhere in metering never fails or slows the
   work it measures.
4. Any member of an Organization can see the percentage of this week's quota
   left, and when it resets, in Settings and in the Organization menu. The
   figure reflects usage within about ten minutes.
5. The quota resets every 7 days at the exact instant the Organization was
   created, with no job to run.
6. Usage past the quota builds up as overage at standard inference cost. Members
   see the month's overage in dollars, struck through and marked as not billed.
   It resets each monthly period.
7. One exhaustive map says, per metered activity, whether the Organization or
   Rally pays. Usage Rally pays for is still recorded, but does not count
   against the quota.
8. The usage ledger survives duplicate delivery without double counting. It is
   shaped so a later change can send it to Stripe without re-instrumenting a
   single call site.

## Non-goals

1. **Collecting a card or charging anyone.** Deferred to a later PRD. Nothing
   here talks to Stripe.
2. **Stopping or slowing work when the quota runs out.** Deferred. A spent
   quota changes what the meter shows and nothing else. This also follows the
   product's rule that Rally never pauses tool execution to ask permission.
3. **Real-time accuracy.** Rejected. A few minutes of lag is fine, and an
   Organization may run a little past 0% before the meter shows it. That usage
   becomes overage, so nothing is lost.
4. **Showing the quota in dollars.** Rejected. The quota is opaque: members see
   a percentage. Overage is the one dollar figure, because it is what an
   Organization would pay.
5. **Self-serve plan choice or upgrade.** Deferred until there is checkout. An
   operator sets the plan from a plan control on Ace's workspaces tab.
6. **Usage by person, Space, Channel or Sidekick.** Deferred. The pool is the
   unit. The usage record keeps those IDs, so a later breakdown needs no new
   instrumentation.
7. **Metering what is not inference.** Firecrawl search and fetch, Daytona
   sandboxes and storage are deferred. The usage record is not tied to
   inference, so each can be added as a new activity.
8. **Per-Organization or per-person payer rules.** Rejected for now. The payer
   map is one global setting.
9. **Rolling unused quota into next week.** Rejected. Each week starts at 100%.
10. **Free plans, trials, seats and discounts.** Deferred.

## Product behavior

### Where the meter appears

**Settings → Organization** gains a **Usage** section above Members. Any member
sees it, whatever their role.

```
Usage
Starter plan

[██████████████░░░░░░]  72% of this week's quota left
Resets Thursday, October 8 at 9:00 AM
Shared by everyone in Juno Labs.

Usage beyond quota this month   $̶1̶2̶.̶4̶0̶   Not billed
```

- The percentage is the share of the week's quota left, rounded down to a whole
  number, never below 0%. Rounding down means the meter never shows more than
  is left.
- The reset time is the next week boundary, shown in the viewer's local time.
  The boundary is a fixed instant every 168 hours, so its local hour moves by
  one when daylight saving starts or ends.
- The overage line appears only when this month's overage is above zero. The
  amount is struck through. A **Not billed** tag beside it explains, on hover
  and focus: "Rally isn't charging for usage beyond your plan yet." The month
  label names the period: "Oct 3 to Nov 2".
- The section is registered in [settings search](../../settings-search.md) as
  "Usage", so searching "quota", "usage" or "plan" finds it.

**Organization menu** (the account and Organization dropdown in the sidebar).
Under the active Organization's row, a thin meter and one line: "72% left this
week". Selecting it opens Settings → Organization at the Usage section. Other
Organizations in the list show no meter.

The meter is a new shared `Meter` primitive in `packages/ui`: a track, a fill,
`role="meter"` with the value attributes, and design tokens for track and fill.
It replaces the one-off `.onboarding-progress` bar, so the next meter costs no
new CSS. It uses the theme's existing colors: brand fill on a sunken track, in
both light and dark. Below 20% left, the fill switches to the theme's warning
color. There is no notification.

### States

| State | Settings → Usage | Organization menu |
| --- | --- | --- |
| Loading, nothing cached | Track with no fill; "Checking usage…" | Line hidden |
| Loading, cached value | Cached value right away, refreshed in the background | Same |
| No usage yet (new week or new Organization) | 100%, full bar | "100% left this week" |
| Partly used | Percentage and bar | Percentage and bar |
| Low (below 20%) | Bar in the warning color | Bar in the warning color |
| Quota spent | 0%, empty bar, "Quota used for this week" | "Quota used this week" |
| Overage this month | Overage line, struck through, **Not billed** | Not shown |
| Error | "Usage isn't available right now." with **Try again** | Line hidden |
| Offline | Last cached value, labelled "as of 2:14 PM" | Last cached value |

The client fetches usage when the Usage section or the Organization menu opens.
It shows any cached value immediately and does not block the screen on the
request. There is no live push: a figure that may lag by minutes gains nothing
from a socket.

### What counts

Each metered activity has one key. The map below starts with every key set to
`true`, meaning the Organization pays:

| Activity key | What it covers |
| --- | --- |
| `agent_run` | Rally's turns in Channels and Breakouts, including inline child runs |
| `sidekick_run` | A Sidekick's run in its own Channel |
| `session_import` | The session import agent |
| `context_compaction` | Summarizing a long run's context |
| `channel_naming` | Naming and renaming a Channel |
| `channel_description` | Writing a Channel's description |
| `breakout_summary` | Breakout context summary |
| `attachment_summary` | Summarizing an attached file |
| `work_opportunity` | Suggested-work admission and ranking |
| `addressing_classifier` | Deciding whether a message addresses Rally |
| `semantic_trigger_gate` | Deciding whether an activity triggers a Sidekick |
| `memory_embedding` | Embedding memory for recall |
| `search_embedding` | Embedding content for search |
| `image_generation` | The image generate and edit tool |
| `audio_generation` | The audio generation tool |
| `message_speech` | Reading a message aloud |
| `dictation` | Live transcription in the composer |
| `document_ocr` | Reading scanned PDFs |

An activity set to `false` is still recorded, against Rally, and never touches
the Organization's quota or overage. Changing a key changes how events are
counted from the time the change deploys. Counts already made stay as they are.

"Standard inference cost" means what Rally pays for the call: the
provider-reported cost for OpenRouter calls, including bring-your-own-key
upstream cost, and Rally's rate card for Azure and Workers AI. The quota and
overage use the same units, so $50 of quota is $50 of that cost.

## Impact on the product contract

None of the brief's clauses move. The brief says nothing on pricing, and this
change adds no gate on what the agent may do. An Organization gains a plan, and
members gain a read-only view of shared usage. When charging begins, its PRD
should add a clause to the brief saying what a plan entitles an Organization to.

## Decision log

None yet.

## Key design decisions

1. **Usage travels on a Cloudflare Queue, not K2.** Cloudflare's K2 event
   streams, launched in public beta on 2026-10-01, are the event log this design
   would like. One stream could feed the lakehouse, this ledger and a later
   Stripe sink as independent subscriptions. Today K2 is pull-only, with no
   consumer Worker, no dead-letter queue and a 10 GB account cap. Queues are
   generally available, push batches of up to 100 to a consumer Worker, and have
   a dead-letter queue, which is the alarm
   [choosing a Queue or RPC](../../choosing-queues-or-rpc.md#deciding-without-measurement)
   relies on. Revisit when K2 gains push consumers. Moving over changes the
   producer helper and the consumer's trigger, not the event or the ledger.
   Detail in [`research.md`](research.md).
2. **A new usage queue, not the inference lakehouse queue.** The lakehouse queue
   feeds a Pipeline sink and carries only streamed and structured calls; it
   misses embeddings, speech, dictation, OCR and media. Its contract also
   forbids using it as billing authority. A dedicated `UsageEvent`, small and
   with no content, keeps the two from constraining each other.
3. **The ledger is D1 rollups, not Analytics Engine.** Analytics Engine samples
   on write and at query time, and Cloudflare says any single record may be
   unrecoverable. An estimate cannot become an invoice later.
4. **Our own ledger, not Stripe credits or Metronome.** Stripe's billing credits
   are applied only when an invoice is finalized, so they cannot drive a live
   percentage, and a weekly reset fits them badly. Stripe's real-time credit
   burndown now runs through Metronome, which is more than this needs before
   anyone pays. The ledger keeps every event, with its ID, cost and activity, so
   it can be sent to Stripe Meters later. Stripe accepts meter events backdated up to 35 days, so history
   older than that stays ours.
5. **The payer map is code, exhaustive by type, not a Flagship flag.** A
   `Record<MeteredActivity, boolean>` in `@rally/contracts` fails typecheck when
   someone adds an activity without deciding who pays. Who pays is a pricing
   decision, and it should go through review rather than an operator toggle. The
   consumer reads the map, not the call site, so a change takes effect without
   touching any emitter.
6. **The week is computed, not reset.** The week start is
   `created_at + 7 days × floor(elapsed / 7 days)`. The rollup is keyed by week
   start, so a new week finds no row and reads 100%. No cron job, no reset write,
   nothing to drift.
7. **Overage is derived when it is read, not split when an event arrives.** The
   consumer only adds each event's cost to a total per week and monthly period.
   Overage is the part of a week's total above that week's quota, and when a
   week straddles a monthly boundary, the earlier part uses up the quota first.
   Sums do not depend on the order events arrive in, so the same events always
   give the same overage. A plan change also re-prices the current week at once
   (decision 12), with nothing to reclassify. Splitting each event as it
   arrived was rejected: queue order would decide which month got overage near
   a boundary, and the recorded split would go stale when the plan changed.
8. **No enforcement.** A spent quota never stops a run. Enforcing would put a
   read on the agent loop's path for a number that is minutes stale. Charging
   overage is the planned answer to heavy use.
9. **Every Organization starts on Starter**, Juno Labs' own and demo
   Organizations included. Nothing is exempt, so internal use shows up in the
   same ledger as customer use. An operator moves an Organization to Growth.
10. **The overage month runs from the sign-up anniversary**: the Organization's
    creation instant on the same day each month, clamped to the last day for
    short months. This matches Stripe's default billing date, so charging lines
    up later. Calendar months were rejected because they need a time zone, and
    they would make the first month a partial one.
11. **Overage is priced at cost**, exactly what Rally pays for the call, with no
    markup. A later markup changes only the displayed figure.
12. **A plan change applies at once.** The new weekly quota applies immediately,
    and the percentage is recomputed against it. An Organization moved from
    Starter to Growth at 0% shows 60% left. Waiting until the next reset was
    rejected because the change is something an operator does for a reason.
13. **The bar turns to the warning color below 20% left**, with no
    notification. The 20% is a product limit set by this PRD and lives in
    `LOW_QUOTA_PERCENT` in `@rally/contracts`. A notification was rejected
    for now; the meter is passive until charging begins.

## Data model

Sketch; [`design.md`](design.md) has the DDL and the consumer algorithm.

- `workspaces.plan`: `'starter' | 'growth'`, not null, default `'starter'`.
- `usage_events`: one append-only row per event, with `event_id` as primary
  key, `workspace_id`, `activity`, `occurred_at`, `cost_microusd`, `model`, and
  the user, Channel, Breakout and Sidekick IDs. The primary key deduplicates
  redelivery. This is the per-event history for a later breakdown and for
  Stripe.
- `usage_rollups`: (`workspace_id`, `week_start`, `period_start`) primary key,
  `quota_microusd`, `organization_microusd`, `rally_microusd`. One row per week
  per monthly period it touches, so at most two rows for each week.

Plan prices and the 2× multiplier live in one `PLANS` constant in
`@rally/contracts`. They are product limits, set by this PRD.

## Regional impact

Usage events never leave the Organization's region. Each region has its own
`avalon-<region>-usage` queue and dead-letter queue behind the one `USAGE_QUEUE`
binding name, and the consumer writes only to that region's `DB`. Global is the
only configured deployment today.

## Security and trust model

- The usage route returns data only to members of the Organization, through the
  existing membership check. Every role may read it. Usage is visible to the
  whole Organization by design.
- A usage event carries IDs, an activity key, a model ID and a cost. It never
  carries prompt text, output or tool arguments.
- Members cannot write usage. Only the server's own call sites produce events.

## Rollout

Ships to everyone on merge, with no flag, per the default in
[`prds.md`](../../prds.md). Every existing Organization starts on Starter.
Metering starts at deploy and is not backfilled, so the first week shows only
usage since deploy. To turn it off, pause the usage queue's consumer, which
keeps messages for the retention period, and revert the client change. Nothing
in the product depends on the ledger.

## Acceptance

1. An admin and a member of one Organization both see the same
   percentage in Settings → Organization and in the Organization menu.
2. A Channel run, a Channel rename and a voice dictation each lower the
   percentage within ten minutes.
3. Setting `channel_naming` to `false` and renaming a Channel leaves the
   percentage unchanged and increases `rally_microusd`.
4. An Organization past 0% shows a growing overage total, struck through and
   marked **Not billed**, and its runs proceed as before.
5. At the week boundary the percentage returns to 100% with no job having run.
   The overage total holds until the month boundary.
6. Delivering the same event twice changes nothing the second time.
7. Breaking the usage queue's consumer leaves agent runs as fast as before, and
   messages collect in the dead-letter queue.

## Open questions

1. **Costing the addressing classifier and trigger gate.** The JEV provider
   returns tokens but no cost. Someone needs to supply its rate, or Goal 2
   cannot be met for those two activities. This blocks only those two
   activities; the rest of the build can go ahead.
