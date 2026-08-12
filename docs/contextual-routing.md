# Contextual routing (paused)

**Status:** Suggested context is paused as of 2026-08-12. It was too noisy to
justify interrupting active work streams before its relevance model was tuned
further. `SUGGESTED_CONTEXT_ENABLED` in
`apps/api/src/lib/suggested-context.ts` is the single product switch: both
producers consult it before doing work, REST and room snapshots return an empty
`suggestions` list, and the desktop transcript discards legacy suggestion rows
and realtime events. Existing `activity_suggestions` rows and the dormant
routing/feedback implementation are intentionally retained for a future tuning
pass; none are deleted or rewritten by the pause.

The remainder of this document records the dormant design that must still hold
if the surface is re-enabled.

The speculative half of activity routing. When a connector activity matches no
resource watch and triggers no automation, contextual routing asks whether one
of the work streams somebody is already using is *about* it, and writes a
**Suggested context** card offering the attachment if the answer is a confident
yes. Accepting attaches the activity's resource to the work stream; dismissing
records that it should not have been offered. An accepted card is a person's
decision about an *existing* work stream, and lands as an ordinary `attachment`;
the place a work stream was *created* from is recorded at creation instead, as an
`origin` — [work-stream origin attachments](workstream-origin-attachments.md)
owns that, and both resolve the same underlying resource row.

Nothing here was asked for. That is the fact the whole design answers to: a card
is an interruption nobody requested, in a transcript somebody is reading for
another reason. So the bar an activity has to clear is set by what this
workspace has actually done with cards like it, and a declaration made for
another purpose can raise that bar but never close the door on its own. Read this
before changing what becomes a card, and
[`connectors.md`](connectors.md#activity-ingestion) for the ingestion pipeline
that feeds it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/lib/suggested-context.ts` | The pause switch shared by both producers and both work-stream read paths. |
| `apps/api/src/queues/activity-consumer.ts` → `routeContextually` | The whole decision: the prior, the candidate query, the one inference, the write. The only caller. |
| `apps/api/src/queues/activity-consumer.ts` → `declaredConfidenceFloor` | Reads the connector manifest's digestibility partition as a starting bar. The one place that translation is made. |
| `apps/api/src/services/activity-routing-feedback.ts` | Every threshold and window, and both reads of past accept/dismiss decisions. The single source of what the feedback means. |
| `apps/api/src/services/activity-suggestion-service.ts` | Inserts the suggestion and publishes `activity_suggestion_created` to the work-stream room. Shared with the other producer, which is why it takes a required `source`. |
| `apps/api/src/services/work-opportunity-service.ts` → `routeExistingDecision` | **The other producer of the same card.** Not part of this module; listed because every feedback read here has to exclude it. |
| `packages/agent-harness/src/prompts/activity-routing.ts` | The classifier prompt and its output schema. |
| `apps/api/src/services/workstream-service.ts` → `resolveSuggestion` | Records `accepted`/`dismissed` and who clicked. The only writer of the signal both feedback reads consume. |
| `apps/desktop/src/renderer/lib/transcript.ts` | Defines the pause-time feed visibility rule that drops every legacy suggestion row. |
| `apps/desktop/src/renderer/lib/api.ts`, `use-workstream-socket.ts` | Apply that rule to canonical and paginated responses, and ignore rollout-era suggestion events while the surface is paused. |
| `packages/db/migrations/0066_activity_suggestion_feedback.sql` | The two indexes those reads seek on. |

## How it works

While paused, `consumeOne` does not call `routeContextually`: activity not
claimed by a watch or automation proceeds directly to suggested-work batching.
Suggested-work admission may still classify an item as `route_existing` so it
does not become a duplicate home-screen opportunity, but
`routeExistingDecision` creates no card. Work-stream REST and room snapshots
return `suggestions: []`, including for pending rows written before the pause.

When enabled, the retained routing path works as follows.

`consumeOne` tries the deterministic routes first — resource watches, then
automation triggers — and calls `routeContextually` only with what neither
claimed. If contextual routing also declines and no watch fired, the activity
falls through to [suggested work](suggested-work.md) instead.

**The confidence floor is the mechanism.** There is one hard stop, and it is
learned rather than declared; everything else moves a number.

1. **The prior, from the connector's declaration.** `declaredConfidenceFloor`
   asks the manifest whether this event type is digestible. A digestible type
   starts at `BASE_CONFIDENCE_FLOOR` (0.8); one the connector put on the
   operational side of a line it actually drew starts at
   `OPERATIONAL_CONFIDENCE_FLOOR` (0.9). A connector whose `digestible` list is
   **empty** drew no line at all and gets no prior — see the invariant below,
   which is the subtlety in this whole area.
2. **The workspace's own record, which replaces the prior.**
   `suggestionAdmission` scores resolved suggestions for
   `(workspace, provider, event type)` within ninety days. Under four
   resolutions there is no evidence and the prior stands. At four or more the
   accept rate takes over completely, in both directions: a type the workspace
   keeps accepting drops back toward 0.8 even if its connector called it
   machinery, and one it keeps dismissing climbs toward 0.95.
3. **Outright suppression, which needs two people.** A type with four or more
   resolutions and **zero** acceptances is at the maximum floor already. It is
   turned off entirely — no candidates selected, no inference bought — only when
   the dismissals came from at least two distinct people. One person's
   dismissals raise the bar to its ceiling; closing the door for a whole
   workspace takes corroboration.
4. **The candidate's own run of dismissals.** The candidate query takes the
   twelve most recently active, non-archived, visible work streams, skipping any
   already routed by a watch or automation, and any with `DISMISSAL_RUN_LIMIT`
   dismissals inside thirty days newer than its most recent acceptance. Both
   exclusions are inside the query, so a skipped work stream is *replaced* by the
   next eligible one rather than costing the model a slot.
5. **The comparison.** One structured inference (role `activity_structured`)
   returns `candidateWorkstreamId`, `confidence`, `reason`, `matchedEntities`,
   and `suggest`. A card needs `suggest`, a confidence at or above the floor
   steps 1–2 arrived at, and an id that is actually in the candidate list.

What survives is written by `createActivitySuggestion` as a `pending` row and
published to the work-stream room, where the desktop client renders it as a
transcript block. `resolveSuggestion` later stamps `accepted` or `dismissed`
along with who clicked, which is what steps 2–4 read on the next activity.
Accepted cards remain in the feed as a receipt that the resource was added;
dismissed cards leave the feed immediately while their database rows remain as
routing feedback.

## Invariants

- **`digestible` is a prior here, never a verdict.** The flag answers "should
  somebody be told this on a schedule", and three unrelated noes are spelled the
  same way: *not news* (a check run finishing), *would render badly in a digest*
  (the generic webhook, whose payload Avalon cannot parse), and *too many events
  per piece of news* (Drive's change feed reporting every save). Only the first
  says anything about relevance to a work stream — a Google Doc being edited is
  prime context and a poor digest line. Treating the flag as a veto silently
  removes Drive, Docs, Sheets, Granola edits, and every generic webhook from
  contextual routing, which is how [PRD flow 4](e2e.md#prd-flow-4--contextual-routing-paused)
  — the acceptance flow for this feature, run over a generic-webhook connection
  — would pass its own tests while testing nothing.
- **An empty `digestible` list is the absence of a judgement, not a negative
  one.** A connector that classifies nothing as news has not said its events are
  irrelevant; it has said it cannot tell. Any future reader of this declaration
  outside the digest needs the same carve-out.
- **`digestible` is consumed here and authored elsewhere.** Never flip a type to
  digestible to change routing: that puts it in everyone's digest to fix one
  surface, and [`connector-digestibility.md`](connector-digestibility.md) is
  reviewed as a statement about a person's inbox. The prior above is deliberately
  weak enough that nobody should ever want to.
- **Only observed behaviour closes a door.** Suppression is the one hard stop and
  it is earned from this workspace's own resolutions. A declaration, a missing
  registry, or an unparseable manifest may move the bar; none of them may
  silently disable the feature.
- **Workspace-wide suppression needs a second person.** A card sits in a shared
  transcript and anybody may resolve it, so a threshold met by one person's
  clicking is one person deciding for everybody — and since suppression blocks
  the cards that would earn an acceptance, nobody else can undo it.
- **Suppression must decay.** Both feedback reads are windowed because a
  suppression rule that blocks the only mechanism which could produce positive
  evidence is permanent by construction. Any future rule added here needs its own
  way back, or it is a one-way door.
- **Candidate exclusion belongs inside the candidate query.** Filtering after
  `LIMIT 12` silently shrinks the list the model sees, so an excluded work stream
  costs a *different* work stream its chance to be matched. This applies to the
  dismissal run and to the already-routed set alike.
- **Every read of `activity_suggestions` as evidence filters on `source`.** The
  table has two producers writing identical-looking rows — this module and
  suggested work's `routeExistingDecision` — so an unscoped count answers "was
  this card useful" when the question asked was "was *this module* right". Both
  feedback reads, and any added later, name the producer they are scoring.
- **`resolveSuggestion` is the only writer of the feedback signal.** Anything
  else that resolves a suggestion — a bulk cleanup, a cascade, a backfill —
  writes training data for these gates, and what it writes into
  `resolved_by_user_id` decides how much damage it does. Stamped with one
  service identity, a mass dismissal cannot suppress anything, because the
  corroboration count stays at one — but it still pins every event type it
  touches to the 0.95 ceiling, which is nearly as quiet and much harder to
  notice. Stamped with the original resolvers, or with several identities, it
  clears the corroboration bar and suppresses those types outright. Neither is a
  decision anybody made about routing.
- **The pause hides cards; it does not delete feedback.** Every desktop message
  path filters suggestion rows through one visibility rule, while the server
  returns empty suggestion snapshots and keeps existing database rows intact.
  Deleting those rows would erase the evidence the dormant routing thresholds
  need. A future re-enable must deliberately restore resolution behavior across
  canonical pages, pagination, realtime events, and the no-socket fallback.

## Boundary

When enabled, contextual routing owns the decision to *offer* an activity to a
work stream, and nothing else. It never attaches, never posts a message, never
starts a run. While paused, no production caller reaches that decision.

It does not own: resource watches or automation triggers (`consumeActivityQueue`,
[`connectors.md`](connectors.md#activity-ingestion)), which are deterministic and
deliberately exempt from everything here because they were asked for by name; the
home-screen suggestions ([`suggested-work.md`](suggested-work.md)), which are a
separate admission agent over a batched window — but note that its
`routeExistingDecision` branch is a **second producer of the same card**, writing
`activity_suggestions` rows through the same `createActivitySuggestion` and
resolved by the same endpoint, so its opportunity-level state is not the only
state it keeps; the digest ([`digests.md`](digests.md)), which owns the
`digestible` declaration this module reads; or the accept/dismiss endpoints and
their idempotency ([`connectors.md`](connectors.md#activity-ingestion)).

Callers: `consumeOne` only. The feedback module is reachable from anywhere but has
no other caller by design — a second consumer of these thresholds means two
policies that will drift.

## Failure modes and limits

| Limit | Value |
| --- | --- |
| Candidates offered to the model | 12, most recently active first |
| Dismissals that suppress a candidate work stream | 3, within 30 days, since its last acceptance |
| Resolutions before an event type's accept rate counts | 4, within 90 days |
| Distinct dismissers before an event type is suppressed outright | 2 |
| Confidence floor | 0.8 digestible / 0.9 operational as a prior, then 0.8–0.95 from the accept rate |
| Activity snippet / candidate objective sent to the model | 2,000 / 1,000 characters |
| Stored title / summary / reason / matched entities | 300 / 2,000 / 1,200 characters, 100 entities |

- **When enabled, the connector registry will not build.** The prior falls back to the base
  floor and routing continues. Withholding would mean one malformed credential
  silently disabling contextual routing region-wide; the same failure is already
  logged as `connector_registry_unavailable_for_digestibility` by
  `activityIsDigestible` on the projection path for the same activity, so the
  fallback here does not log again.
- **When enabled, there is no `OPENROUTER_API_KEY`.** Contextual routing is skipped entirely; watches
  and automations are unaffected.
- **When enabled, a suppressed activity is not dropped, and suppression governs
  this module's output rather than the card type.** Every path here returns `false`, which is
  the same answer "the model declined" gives, so the activity continues to
  suggested-work batching. When the card surface is also enabled, that surface's `routeExistingDecision` can then
  publish a card of its own for the same activity — a genuinely different
  decision, made over a whole window with `confidence: 1` rather than per event,
  and scored separately — but it is the same card in the same transcript, so a
  suppressed event type is not a guarantee that no card about it appears. It is a
  guarantee that *this* module stops producing them. The two are told apart by
  `activity_suggestions.source`; extending one agent's suppression over the other
  is a product decision nobody has made, and would belong in
  [`suggested-work.md`](suggested-work.md) rather than here.
- **A window rolling past a cluster of dismissals resets the record, not just
  one card.** Suppression is not lifted gradually: four dismissals resolved in
  the same afternoon all age out on the same day, `resolved` drops to zero, and
  the type reverts to its *prior* — 0.8 or 0.9, not the 0.95 it had climbed to.
  It then takes four fresh resolutions before the accept rate can act again, so
  the cost of a window expiring is up to four cards, not one. That is the price
  of decay being time-based; a decay proportional to the evidence would smooth
  it, and is the obvious thing to reach for if this proves annoying in practice.
- **The floor cannot exceed 0.95.** A floor of 1.0 is unreachable rather than
  strict, and would make the suppression branch dead code.
- **An operational type is slower to be trusted than a digestible one.** It
  starts at 0.9, so it produces fewer cards, so it accumulates the four
  resolutions that would let the workspace overrule that prior more slowly. This
  is deliberate but it is a real asymmetry: a workspace that would love Google
  Docs cards waits longer to say so than one that would love review requests.

## Testing

`apps/api/test/activity-contextual-routing.test.ts` keeps the dormant prior,
feedback reads, corroboration rule, and candidate exclusions covered against a
migrated in-memory SQLite database. Work-opportunity, work-stream response, and
desktop transcript/socket tests separately assert that the pause creates and
shows no cards.

```bash
pnpm --filter @avalon/api exec vitest run test/activity-contextual-routing.test.ts
```

`apps/desktop/src/renderer/lib/api.test.ts` covers canonical feed reconstruction
and suppression of legacy suggestion rows.
`apps/desktop/src/renderer/lib/use-workstream-socket-suggestions.test.tsx`
covers ignoring suggestion creation and resolution events while the surface is
paused.

Four traps. **GitHub credentials in the fake env are load-bearing** — the registry
is what answers digestibility, and `GITHUB_APP_PRIVATE_KEY` must be PEM-shaped or
the registry throws; one test asserts that fallback deliberately, and the rest
would silently test the fallback instead of the prior. **Resolution timestamps are
relative to the real clock** (`daysAgo`), because the windows are measured from
`new Date()` inside the feedback reads; pinning a base date makes the suite pass
until the date drifts past the window. **The already-routed exclusion test seeds
thirteen work streams on purpose** — with fewer than thirteen the `LIMIT 12`
never binds and the assertion holds whether the exclusion runs in SQL or in
JavaScript afterwards, which is exactly the defect it exists to catch. And
**`generic_webhook` is a regression fixture, not an example**: it is the
connector PRD flow 4 uses, and the test asserting it draws no prior is what stops
the digestibility declaration being turned back into a veto.

## Data model

No tables of its own. `activity_suggestions` (see
[`data-model.md`](data-model.md)) is both the output and the training data: one
row per card, `UNIQUE (activity_id, workstream_id)`, `status` carrying the label,
`resolved_by_user_id` carrying who applied it, and `source` carrying which
producer wrote it.

**The table is not this module's alone, and that is the trap in it.**
`createActivitySuggestion` has two callers — `routeContextually` here, and
`routeExistingDecision` on the suggested-work batching path — writing rows that
are indistinguishable in the transcript and resolved by the same endpoint.
`source` is what makes them distinguishable to a feedback read, and **every read
of this table as evidence must filter on it**. Rows written before the column
exists are `'unknown'` and count for nobody: the two producers cannot be told
apart retroactively, and attributing them would seed these gates with another
agent's record. A third producer must add its own value rather than borrowing one.

A row is written at the moment
the card is published, so every row was seen by somebody and no separate
impression count is needed — unlike `work_opportunity_user_states`, which tracks
impressions because an opportunity can be ranked without ever being shown. Note
that `resolved_by_user_id` is nulled when a user is deleted, so a departed
colleague's dismissals stop counting toward corroboration; that fails toward the
maximum floor rather than toward suppression, which is the safe direction.

## Operations

No card should appear while `SUGGESTED_CONTEXT_ENABLED` is false. After a future
re-enable, diagnose a missing card in this order: the event type's record, then
the prior, then the model's own answer. The record is a query rather than a log
line — suppression is evaluated once per ingested activity, and logging it at
`info` would write thousands of identical lines a day for a suppressed
high-volume type, so `contextual_routing_event_type_suppressed` is at `debug`:

```sql
SELECT a.provider,
       a.event_type,
       SUM(s.status = 'accepted')  AS accepted,
       SUM(s.status = 'dismissed') AS dismissed,
       COUNT(DISTINCT CASE WHEN s.status = 'dismissed' THEN s.resolved_by_user_id END) AS dismissers
  FROM activity_suggestions s
  JOIN activities a ON a.id = s.activity_id
 WHERE s.workspace_id = ?1
   -- Without this the count includes suggested work's cards, and reports a
   -- suppression production is not applying.
   AND s.source = 'contextual_routing'
   AND s.status IN ('accepted', 'dismissed')
   -- ISO with the `T`, not `datetime()`. `resolved_at` is written by `nowIso()`
   -- and compared as text, and `datetime()` emits a space where that format has
   -- a `T` — which sorts lower, so a space-separated cutoff quietly admits
   -- rows from the cutoff day that production counts as out of window.
   AND s.resolved_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
 GROUP BY a.provider, a.event_type
 ORDER BY dismissed DESC;
```

Grouped by provider as well as event type, because that is the key
`suggestionAdmission` scores on: an event type name is not unique across
providers, and a diagnostic that merges two providers' rows can report a
suppression production is not applying.

Four or more resolutions with zero accepted and two or more dismissers is a
suppressed type. The prior is `connector-digestibility.md` plus whether that
connector declares any digestible type at all.

## Changelog

### 2026-08-12 — Suggested context was paused end to end

**What changed:** One shared switch now prevents the per-activity router and
suggested-work's `route_existing` branch from creating cards. REST and room
snapshots return no pending suggestions, the desktop no longer renders the card
or its controls, and rollout-era suggestion socket events are ignored. Existing
rows, feedback, schemas, and the dormant classifier remain in place.

**Why:** The cards were too noisy and their relevance was not tuned well enough
to earn space inside an active work stream. Deleting stored decisions or the
whole implementation was rejected because this is a temporary product pause:
the existing accept/dismiss record and testable routing code are useful inputs
to a future tuning pass. A future re-enable must restore all four guarded
boundaries together — both producers, both snapshot paths, transcript synthesis,
and realtime handling — rather than exposing only part of the surface.

### 2026-08-12 — Dismissing a suggestion removes it from the message feed

**What changed:** The desktop now removes dismissed Suggested context cards on
the live resolution event and after a successful dismissal request when the
socket is unavailable. Canonical and paginated message responses filter
dismissed rows, and every reconciliation consults a session-lived dismissal ID
before committing a response that may have started earlier. Accepted cards
remain visible as confirmation that their resource was added, and the dismissed
database row remains stored for routing feedback.

**Why:** A resolution event replaced the pending card with a resolved card whose
footer said “Dismissed.” Repeating the action therefore accumulated rejected
suggestions in the message feed—the surface the person was trying to clear—and
made the routing feedback improvement feel like more noise rather than less.

**Considered and rejected:** Hiding the resolved content only inside the card
component. The virtualized feed would still own and measure an empty transcript
row, and stale dismissed messages would remain in its cache. Also rejected was
keeping a compact dismissal receipt: acceptance has a durable side effect worth
confirming, while dismissal is specifically the decision that this unsolicited
context does not belong in the work stream.

**Consequences:** Every path that introduces or reconciles suggestion messages
must preserve the same visibility rule. Dismissal IDs remain in the renderer's
query cache for the app session; they are UUIDs that cannot be reused, so this
small monotonic set closes every overlapping page-fetch race without a cleanup
timer or another server read. Dismissal is presentation removal only; future
cleanup must not delete the `activity_suggestions` row, because its status and
resolver are the evidence used to reduce later routing noise.

Shipped in #135.

### 2026-08-12 — The workspace's own dismissals set the bar; the manifest only nudges it

**What changed:** Contextual routing stopped comparing every match against a
constant. An event type's confidence floor now starts from its connector's
digestibility declaration — 0.8 for a digestible type, 0.9 for one its connector
classified as machinery, no change for a connector that classified nothing — and
is then replaced outright by this workspace's own accept rate over ninety days,
in either direction. A type with four or more resolutions, zero acceptances, and
dismissals from two or more distinct people is turned off before the inference
is bought. A work stream with three dismissals in thirty days and no acceptance
since drops out of the candidate pool. Both that exclusion and the pre-existing
already-routed exclusion moved inside the candidate query.
`activity_suggestions` gained a `source` column naming which producer wrote each
card, which both feedback reads filter on, and two indexes leading with it.

**Why:** The only quality control was a constant compared against a number the
model made up about its own answer, and nothing ever read the resolution back.
`resolveSuggestion` had written `dismissed` since the feature shipped and no code
anywhere read that column, so a workspace could dismiss the same suggestion every
day and the next one arrived with identical odds — the pipeline documented
"persist accepted/dismissed routing feedback" as a step and persisted it into a
column nothing consumed. Meanwhile the candidate query never looked at the
activity at all: any of the twelve most recently touched work streams was a
candidate for any event, so the model was asked "does this fit one of these
twelve?" for every unclaimed activity, including the eleven check runs a single
pull request starts. The observed failure was a `review_requested` card routed to
an unrelated work stream whose stated reason cited no shared entity — a correct
classification of a real event, offered to the wrong place, with no way for the
person dismissing it to affect the next one.

**Considered and rejected:** Using `digestible` as a hard gate — no card, at any
confidence, for a type no digest would carry. This was written, tested, and
reverted before shipping, and the reasoning is worth keeping because it is
seductive: a card *is* a stronger interruption than a digest line, so the
inference that it deserves at least as strong a declaration feels airtight. It is
wrong because `digestible` encodes three different noes and only one of them is
about relevance. `generic_webhook` declares `digestible: []` because Avalon
cannot parse an arbitrary payload well enough to render it into somebody's
morning email — and it is the connector [PRD flow 4](e2e.md#prd-flow-4--contextual-routing)
uses to test contextual routing, so the gate broke the feature's own acceptance
flow while every unit test passed. Google's Drive, Docs, and Sheets events are
operational because a change feed reports every save, which is a statement about
digest volume; a document being edited is close to the most useful thing this
feature could possibly offer. The gate would have removed all of them
permanently, and the invariant forbidding "just mark it digestible" would have
left no way back.

Also rejected: requiring `matchedEntities` to be non-empty. It is the obvious
code-level version of the prompt's "a shared generic keyword is not sufficient",
and it fails because the field is produced by the same model whose judgement is
in question — a model inclined to suggest is equally inclined to name an entity.

Also rejected: raising the constant to 0.9 for everyone. It trades recall
everywhere for precision in the workspaces that were complaining, and still
compares against a self-reported score.

Also rejected: reading `activity_suggestions` as though it were this module's
table. It is not, and review caught the assumption before it shipped:
`createActivitySuggestion` has a second caller in suggested work's
`routeExistingDecision`, writing rows that are identical in the transcript and
resolved by the same endpoint. Unscoped, four dismissals of *that* agent's
whole-window decisions would have suppressed an event type here, and a work
stream could have lost its place in the candidate pool over cards this module
never produced — a feedback loop that also re-armed its own counters, since a
suppressed activity falls through to batching where the other producer can
publish the same card. Attributing the pre-column rows to either producer was
rejected for the same reason: they cannot be told apart, and a guess would seed
the gates with the wrong agent's record.

Also rejected: an unwindowed accept rate, and workspace-wide suppression on a
single person's dismissals. The first makes suppression permanent, because a
suppressed type can never earn the acceptance that would lift it. The second lets
one member clear four cards on a quiet afternoon and turn a type off for
everybody, with the same no-way-back problem one level down.

**Consequences:** Suppression is a promise about this module's output, not about
the card type: the suggested-work path can still publish a card for a suppressed
event type, and deliberately keeps its own record. Whether one agent's
suppression should silence the other is a real product question this change does
not answer, and answering it belongs in [`suggested-work.md`](suggested-work.md).
Anything added to `activity_suggestions` from here has to declare its `source`,
and any new read of that table as evidence has to filter on it.

`digestible` is now read by two surfaces with different
questions, which is a standing hazard: the next reader outside the digest will be
tempted to treat it as a verdict again, and the invariants above exist to be
quoted at that change. The prior is deliberately weak — 0.1 of confidence —
because its job is to break ties, not to make decisions. A workspace's own
behaviour is the only thing that switches anything off, which means this design
does nothing at all on day one in a new workspace; that is intended, and the
first four resolutions per event type are what it costs. Because a withheld
activity continues to suggested-work batching rather than being dropped, noise
removed from transcripts arrives at the home screen instead; if that surface gets
louder after this, the batching window is where to look, not these thresholds.

Deterministic entity overlap before the inference — shrinking the candidate list
by the resource and entity keys `matchingResourceIds` already computes on the
same activity — is the next thing this design wants, and would let the candidate
pool stop being "twelve most recent" for events that name a resource at all.
Shipped without it because the feedback gates are measurable on their own and
overlap-based selection changes recall in a way that wants a look at real
resolutions first.

Shipped in #109.
