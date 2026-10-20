# Suggested work

The four suggestions exposed through the native menu bar: where they come from, who is allowed to
see one, and — the part that has bitten hardest — when the ranking that orders
them is allowed to run. Unclaimed connector activity becomes a candidate, a model
admits a fraction of it, and a bounded tournament orders each member's four ahead
of any request that will show them.

**Nothing renders these suggestions today.** The Grok-style new-chat screen
dropped its suggestion cards, and on 2026-09-11 the macOS status menu dropped its
Suggestions section — see [`menu-bar.md`](menu-bar.md). Admission, ranking, and
the scheduling below all still run, and `GET /work-opportunities` still answers;
there is simply no surface asking. Read every "the menu bar reads this" below as
describing a consumer that existed and can exist again, not one that is running.

Two things follow. The ranking's dependence on attention is now unfed: nothing
reports impressions, so the tournament has no evidence that a suggestion was put
in front of someone and passed over. And whoever brings a surface back inherits
the impression obligation with it — a surface that displays without reporting
freezes its own list. `clientFeatureFlags.suggestedWorkEnabled` likewise has no
client consumer left; it still gates the API.

Read this before changing admission, ranking, the `work_opportunities` family of
tables, or `GET /work-opportunities`. Two properties hold the whole thing
together, and both were learned the hard way in production: **a request never
ranks**, and **ranking follows attention**.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/work-opportunity-batching.ts` | Candidate ingestion — `enqueueActivityOpportunity` and the debounce windows. |
| `apps/api/src/services/work-opportunity-service.ts` | Admission/ranking model work and the HTTP product service; post-cutover storage calls are typed WorkspaceDO RPCs. |
| `apps/api/src/durable-objects/workspace-product-schema.ts`, `workspace-product-storage.ts` | The authoritative workspace-local tables, atomic repository operations, leases, and alarm due times. |
| `apps/api/src/workflows/work-opportunity.ts` | Retryable admission and ranking compute against fenced WorkspaceDO inputs. |
| `apps/api/src/routes/work-opportunities.ts` | Suggestion reads, impressions, dismissal, start, and product-usage emission. |
| `packages/agent-harness/src/prompts/work-opportunity.ts` | The admission and ranking prompts. |
| `packages/db/migrations/0083_workspace_product_do_authority.sql` | The maintenance import ledger and permanent D1 writer fences; it is not the product schema. |

Model contracts are in [`agent-harness.md`](agent-harness.md) and the flags that
route them are in [`feature-flags.md`](feature-flags.md).

## How it works

```
connector activity / Rally mention
  → WorkspaceDO event → Queue processing: watches and automations
  → nothing claimed it? enqueueActivityOpportunity()
  → WorkspaceDO.opportunity_batch_windows          (10-minute debounce, 60-minute cap)
  → WorkspaceDO alarm → fenced admission Workflow
  → admission model                    → WorkspaceDO.work_opportunities + provenance
  → marks the affected members due
  → WorkspaceDO alarm → ranking Workflow → suggested_work_sets
  → GET /work-opportunities → typed WorkspaceDO RPC reads the stored set, nothing more
```

Connector sources retain up to 10,000 deduplicated people, including every
reference's source evidence. Canonical sources and stored provenance never use
the former roster prefixes. Admission presents one bounded view under its
existing character budget, sharing space between people and source text, with
`externalPeopleCoverage` stating shown and total counts. Decisions resolve and
persist against the full original sources. This view may omit people from model
consideration but never removes them from canonical storage or provenance.

### Admission

An activity only becomes a candidate if no resource watch or matching automation
claimed it. The gate remains exclusive: work already handled by a deterministic
route should not also be offered as new work.

Some activity is never a candidate, decided by event type in
`enqueueActivityOpportunity` before any window is opened for it:
`github.check_run.*` and `github.workflow_run.*`. A check run is the status of
a commit and a workflow run is the same status a level up. They were 24,000 of
the 50,000 events one workspace admitted on 2026-09-02, at a frontier-model
call each, and the answer was `ignore`. GitHub ingress now discards check runs
and unfinished workflow runs before they are stored
([`connectors.md`](connectors.md#dropping-events-that-say-nothing-new)), so the
only declared type left here is `github.workflow_run.completed`. The
`github.check_run.` prefix stays, named in
`SUGGESTED_WORK_RETIRED_EVENT_TYPE_PREFIXES`, because check runs stored before
that change can still drain through processing. The list is an exclusion rather than an
inclusion so that a new connector's activity is offered until somebody finds a
reason not to, and it withholds only this surface: excluded activity is still
logged, still routes to watches and automations, and still reaches the feed.

**This is not the digest's partition, and must not become it.** Every connector
manifest already sorts its event types into `digestible` and `operational`
([`connector-digestibility.md`](connector-digestibility.md)), and 136 of the 197
declared types are operational. Admission withholds one. The two questions are
different, and the gap between them is where a suggestion lives: "would a person
want this read back to them on a schedule" is No for `drive.file_changed` and
`linear.comment.update`, while "is there work here" may well be Yes.
`activity-consumer.ts` records that boundary, and inheriting the partition
would withhold all 136.

What admission does borrow is the **floor**. A type this gate withholds must be
one its own connector already declined to call news, so this can never be the
stricter of the two, and it cannot end up contradicting a manifest that later
reclassifies a type. `work-opportunity-batching.test.ts` binds that to the
registry: it fails if the gate withholds a digestible type, if the five it
withholds change, or if a prefix stops matching any declared type at all —
which is how a family renamed at the connector surfaces here rather than as a
bill.

Calendar changes are deliberately not on it. The other 18,000 events that day
were `calendar.event_changed`, and that was a connector defect rather than a
property of the activity: one edit to a recurring series arrived as one
activity per expanded instance, ~730 per attendee. [`connectors.md`](connectors.md)
records the fix (2026-09-02 — one edit to a recurring series is one activity),
after which a moved or cancelled meeting is one candidate per connection, and
that is the kind of thing that produces work.

Admission may add a distinct opportunity, improve an existing opportunity, or
ignore the evidence. Existing work streams are supplied only as context for
recognizing duplicates; admission cannot route activity into one or create a
card inside it.

Admission context never performs an unrestricted directory read. Live connector
activity is admitted through personal windows: each names one audience member
and receives workspace rows plus private rows that member actively participates
in; creation metadata is not a separate permission. A workspace-visible connector event fans out to one such window
per active member; it never combines their private directory permissions in one
inference. The explicit workspace directory form remains fail-closed to
workspace-scoped rows for callers that genuinely hold a workspace audience. No
request has a nullable viewer form; omission cannot broaden the candidate set.

Admission itself is a model decision (`work_opportunity_admission`) and is biased
toward `ignore`. It resolves the people named in the evidence against verified
external identities, and it never lets an inference widen access: for a personal
audience, a link may explain a suggestion but can only ever target the audience
member. It runs at low reasoning effort, like the ranking's elimination rounds:
it is a coarse gate asked tens of thousands of times a day.

Personal OAuth connections with an explicit `providerUserId: null` do not
contribute verified aliases. Their provider account may identify a shared MCP
resource rather than a person. Older connections that omit the field retain
the provider-account fallback.

The context every admission call carries — up to 250 members with their
verified aliases, the 20 most recent work streams the audience may see, and up
to 12 existing opportunities — is bounded per opportunity by
`ADMISSION_CONTEXT_REASONING_CHARACTERS`, because at the previous 4,000-character
cap the prior admission reasoning alone was about half of every prompt while the
evidence being judged was four activities. The model needs enough of the
rationale to recognise a duplicate, not the whole memo.

Audience is decided by the batch window's partition. A personal connector's
activity enters `personal:<owner>`. Restricted activity enters one personal
window per permitted user. Workspace-visible activity enters
`workspace:<user-id>` for every active member. The window audience controls
whose private context the model may inspect; the source keeps its independent
workspace or restricted audience for the final routing check.

For `N` active workspace members, one workspace-visible event performs `N`
WorkspaceDO enqueue RPCs and enters `N` independent personal windows. Those
windows may each run admission and may produce distinct opportunities or route
decisions for their member; there is deliberately no cross-member deduplication,
because deduplicating would require merging private candidate context. The
fan-out has no guessed member cap: an overloaded object or Workflow failure is
the visible failure mode until the team chooses a product limit.

### Ranking

The tournament groups candidates, ranks each group, and ranks the winners, down to
a final ordered four. Elimination rounds run at low reasoning effort — they answer
"which of these twelve survive", asked several times — and only the final
comparison runs at high effort.

On exhausting the budget a tournament keeps the finalists it has, in tournament
order, and writes them. **A ranking must always write something, and never an empty
something while candidates exist.** `orderedOpportunityIds` has a maximum and no
minimum, and ids the model invents are filtered out, so a ranking can select
nothing; storing that against the real fingerprint creates a set the read path
calls unranked and the scheduler declines to re-rank, and the two do that to each
other indefinitely. An empty selection therefore falls back to recency order. A
member with nothing stored also gets recency order written first, against an
*empty* fingerprint, so they see four suggestions immediately while the real
ranking stays outstanding.

### Freshness

`suggested_work_sets.candidate_fingerprint` hashes the id and version of every
candidate the member is eligible for. It is the *only* freshness signal, and it is
sufficient: it detects an admission, a revision, an expiry, a dismissal, and an
opportunity leaving `active`.

The one thing it cannot see is impressions, which feed the ranking but are not
candidates. That is why the impression trigger blanks `candidate_fingerprint` along
with setting `due_at` — asking for a ranking the cache will skip is not asking for
anything.

### What asks for a ranking

| Trigger | Delay | Who |
| --- | --- | --- |
| Opportunity admitted or revised | `DUE_DEBOUNCE_MS` (30 min) | The window's audience — one member, or every active member |
| Opportunity names a member | none | That member |
| Member dismisses or starts a suggestion | none | That member |
| Impressions, at most hourly | none | That member |
| Read finds eligible candidates the stored set does not account for | none | That member |
| Read finds a ranked suggestion no longer showable | `READ_REPAIR_DELAY_MS` (2 min) | That member |

A workspace-scope admission marks **every** active member, set-based over
`workspace_members` — not the member list admission was given, which is capped at
250 by name and would leave the rest of a large workspace never re-ranked.

The two read-path rules are what catch a hole nothing on the write path sees: a
workspace suggestion started or dismissed by *somebody else*, or one that simply
expired. The second is about a gap, not an absence — a member with no eligible
opportunities has an empty set as their steady state, and asking for a ranking on
that would cost a write and a scheduler claim on every read forever.

A hole is also topped up from the recency fallback for the read that finds it,
rather than rendering a short list until the next pass. The inline ranking this
replaced always returned four, and a home screen quietly losing a row for minutes
is a regression the member can see.

### Member activity

`workspace_members.last_seen_at` remains a D1 membership/control input written by `requireAuth`, debounced to
`LAST_SEEN_RESOLUTION_MS` (5 minutes) in the statement rather than by reading
first. It is deferred and its failures are swallowed: it schedules background work
and is never worth failing a request over.

It is on the membership, not the user — someone can be active in one workspace and
dormant in another. A WorkspaceDO alarm claims only active/non-dormant members;
if every due member is dormant it deliberately leaves the request parked and
sets no replacement alarm. The next authenticated suggestion read wakes the
object. `NULL` reads as dormant, so an idle workspace does not pay for polling.

### Starting one

`POST /work-opportunities/:id/start` creates a work stream whose title and
objective are the `displayPrompt` and whose opening message is the
`executionPrompt` — **written as the selecting member's own turn**, not the
agent's. Selecting is the request, and the brief is that request expanded; the
`suggested_work_expansion` structured content on the message is what records that
the words are Rally's, and both the transcript label and the model projection read
it from there rather than from the author. The creation path itself belongs to
[`workstream-creation.md`](workstream-creation.md).

The activity provenance roots behind the suggestion are attached to the new work
stream as origin resources — up to eight, and only unrestricted,
workspace-visible connector objects — so the work stream links back to the
issue, thread, or page it was proposed from. WorkspaceDO resolves the authorized
provenance roots, and the regional creation coordinator materializes their
resource IDs into SubstreamAgent's initial SQL transaction before that RPC
enqueues the first Workflow. The first model context therefore cannot race the
origin attachments. See
[work-stream origin attachments](workstream-origin-attachments.md).

### Product measurement

A suggestion is measurable only after the API durably records the observation.
The home and menu-bar surfaces submit the opportunity ID, current version,
bounded position, and surface; the server adds audience, connector provenance,
freshness, and prior-impression count from stored state. Dismiss and start use the
same versioned context. That context is returned by the same WorkspaceDO operation
that records the impression, dismissal, or start claim; the HTTP route never
reconstructs it from regional D1. Connector types come only from the object's
bounded provenance after its per-member visibility filter. If this optional
context cannot be read or validated, the product mutation still succeeds, the
object logs `workspace_opportunity_telemetry_context_failed`, and detailed
measurement is skipped (or a successful start uses the legacy event). A start
emits only after work-stream creation succeeds and includes the created
work-stream UUID for the conversion join. Replays use stable event IDs, and a
current detailed start does not also emit the legacy success event. Prompts,
titles, activity bodies, provider account IDs, and ranking-model output never
enter telemetry.

## Invariants

- **A request never ranks.** `list()` reads `suggested_work_sets` and filters it to
  what is still showable; no model call is on the read path. An inline tournament
  cannot finish inside a request, is cancelled when the client gives up, and stores
  nothing.
- **Ranking follows attention.** A member seen in the last fifteen minutes is
  ranked first; one not seen in a week is not ranked at all until they return.
- **A ranking always writes something, and never an empty something while
  candidates exist.** An empty selection stored against a real fingerprint is a set
  the read path calls unranked and the scheduler declines to re-rank — they do that
  to each other indefinitely.
- **`candidate_fingerprint` is the only freshness signal.** A second guard ANDed
  beside it can only cause misses the fingerprint would not; see
  [Failure modes and limits](#failure-modes-and-limits) for what the last one cost.
- **A request is identified by `request_seq`, never by `due_at`.** Every ask
  increments the counter; the scheduler records the value it claimed and clears the
  request only if that value is still current. Comparing due times does not work,
  and the reason is subtle enough to be worth stating: an admission landing
  mid-tournament debounces `DUE_DEBOUNCE_MS` out, which is *later* than the request being
  ranked, so `MIN` keeps the existing value and the column does not move at all. A
  request that leaves the row byte-identical is indistinguishable from no request,
  and the completed run clears it on the way out — the member keeps a set that was
  out of date before it was written.
- **Setting a due time never delays one already outstanding** — `MIN` wins.
  While a pass holds the lease, `due_at` is that pass's own claim time, not an
  outstanding request, so a request arriving mid-pass is parked in
  `pending_due_at` (`MIN` among the requests that arrive during the pass) and
  `settleRanking` re-arms `due_at` from it. Taking `MIN` against the claim time
  kept a time already past, and under continuous admissions the next pass began
  the moment the current one settled, whatever the debounce said.
- **Clearing a due time matters as much as setting it.** One left behind is
  re-claimed on every pass forever.
- **An inference never widens access.** For a personal audience a link may explain
  a suggestion but can only ever target the audience member.
- **Admission is exclusive with every deterministic claim on an activity.** A
  watch or automation delivery is not also offered as new work.
- **Measurement enrichment cannot fail a product action.** WorkspaceDO owns the
  suggestion and its visible provenance, returns optional telemetry context with
  each member mutation, and degrades a context-read failure to `null`. Regional D1
  is never a fallback product-state reader.

## Boundary

This module owns candidate admission, the ranking tournament, its scheduling, and
the stored set a surface would read. It does not own:

| For | Read |
| --- | --- |
| The retired Suggested context feature | [`contextual-routing.md`](contextual-routing.md) |
| What happens after a suggestion is started | [`workstream-creation.md`](workstream-creation.md) |
| The model contracts and structured-output rules | [`agent-harness.md`](agent-harness.md) |
| Which model each of these prompts runs on | [`feature-flags.md`](feature-flags.md) |
| The activity ingestion that feeds it | [`connectors.md`](connectors.md) |

## Failure modes and limits

The tournament is bounded on three axes, and every one of them exists because the
unbounded version did not finish:

| Bound | Value | What it stops |
| --- | --- | --- |
| `MAX_RANK_CANDIDATES` / `MAX_RANK_CHARACTERS` | 12 / 80k | A group too large for one call |
| `MAX_RANK_ROUNDS` | 10 | A tournament that will not converge |
| `RANK_BUDGET_MS` | 2 min | A tournament that converges too slowly to matter |

Each WorkspaceDO alarm claims at most six independent Workflow instances. That
is an object-local admission ceiling, not a fleet-wide throughput limit, and no
Workflow extends the alarm invocation. Each ranking still has its two-minute
tournament budget and a fifteen-minute Workflow-step timeout.

What the scheduler will not do:

- **Rank a dormant member.** Their request stays outstanding and is served on the
  first object wake after the auth middleware records them again.
- **Starve the less-active tier.** A request waiting longer than
  `RANK_STARVATION_MS` (30 min) is promoted to the top tier, so a handful of
  members who are always due cannot hold the queue indefinitely.
- **Record a failed settle as a failed ranking.** The settle sits outside the catch
  that marks `status = 'failed'`; a lease left to expire costs one re-rank, where
  marking a good set failed costs the member their suggestions.
- **Push a newer request out on failure.** The retry delay applies only when
  `request_seq` still matches the attempt that failed.
- **Overwrite `status` when it claims.** Claiming is lease-only. `status` is the
  record of how the last ranking ended, and the fingerprint cache reads it — a claim
  that clobbered it would guarantee a full tournament every time.
- **Release the lease before the run is over.** `storeRankingSet` writes the ranking
  and touches neither `due_at` nor the lease, because it is also called mid-run for
  the provisional write. Only `settleRankingRequest` ends a claim.
- **Rank more than the bounded per-alarm claim batch.** Each claimed member is a
  separate Workflow, and the next WorkspaceDO alarm continues from durable due
  rows rather than holding one regional cron invocation open.
- **Turn an ambiguous terminal callback into a fence error.** Once a batch
  window is `completed`, repeating either its final event mutation or settlement
  is a successful no-op. A different lease against a nonterminal window still
  fails, so Workflow redelivery cannot duplicate attempts or requeue evidence.
- **Fail a suggestion action because optional measurement context is unavailable.**
  The object logs the failed context read and returns the completed action with no
  context. The route omits the detailed event; a successful start keeps the
  compatibility event so the conversion is not lost entirely.

One known defect remains:

- **Failed batch events are abandoned silently.** `requeueFailures` retries below
  `attempt_count < 3`; there is no dead letter and no alert, so the activities
  behind them are never considered. In production this had consumed 1,775 events —
  mostly admission timeouts — by the time anyone looked.
The retired `workspace_opportunity_versions` counter and
`suggested_work_sets.workspace_version` are not present in the WorkspaceDO
schema; the D1 counter table itself is dropped by
`0085_retire_dead_tables.sql`, having lost its last reader long before the
cutover. Legacy D1 opportunity sources and their work-stream provenance columns
exist only through 0089; migration 0090 removes both, leaving the regional
work-stream identity anchor with no product provenance.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/work-opportunity-batching.test.ts` | Admission batching, provenance scoping, the start ledger's claim/replay/roll-forward contract, and that the renderer contract strips what the object holds. |
| `apps/api/test/work-opportunity-routes.test.ts` | Impression, dismissal, and start routes succeed when regional D1 permits only workspace-placement reads, proving optional telemetry does not reach retired D1 product tables. |
| `apps/api/test/suggested-work-opening-turn.test.ts` | That the opening message is the member's own turn carrying `suggested_work_expansion`. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | Strict WorkspaceDO schema, atomic activity/provenance/resolution writes, dedupe, visibility, dismissal, serving, and every read-path request rule below. |
| `apps/api/test-workers/opportunity-ranking.test.ts` | The ranking pipeline the object owns: who is a candidate, the cached state, the stored result, the recorded round, the lease settlement's `request_seq` guard, the claim ledger's completion fence, and visibility-filtered telemetry context returned by member actions. |
| `apps/api/test-workers/opportunity-batching-window.test.ts` | The aggregation window: the ten-minute debounce, the one-hour cap from the first event, one window per partition, and a replayed source counted once. |

Run one with
`pnpm --filter @rally/api exec vitest run test/work-opportunity-batching.test.ts`
— the path is package-relative. The workerd suite takes
`--config vitest.workers.config.ts`.

**The request rules belong in the workerd suite, not a Node one.** Whether a read
asks for a ranking is decided inside `listOpportunities`, against the object's own
SQLite, so a Node test can only reach it through a stub that answers for it. This
is not a style preference: the rules used to be asserted in a Node suite against a
parallel D1 implementation that migration 0090 made unreachable, so for as long as
that suite was green it was proving something production never ran.

The trap is the clock. Every scheduling rule here is a comparison against
`Date.now()`. Pass `now`, `scheduleAt` and `rerankBefore` explicitly and assert on
the stored `request_seq` and `due_at`, rather than stubbing the clock and asserting
on how long a pass took.

## WorkspaceDO data model

| Table | Holds |
| --- | --- |
| `work_opportunities` | The suggestion: both prompts, audience, provider icon, TTL, start bookkeeping |
| `work_opportunity_user_links` | Who the evidence named, how confidently, and where that is recorded |
| `work_opportunity_user_states` | Per-member impressions, dismissal, and what they started |
| `opportunity_provenance_nodes` / `_edges` | The evidence graph, scoped by visibility |
| `work_opportunity_snapshots` | What a member actually saw at the moment they started one |
| `suggested_work_sets` | The stored ranking, its fingerprint, and its scheduling state — `due_at` for the outstanding request, `pending_due_at` for one that arrived while a pass held the lease |
| `suggested_work_ranking_rounds` | Every tournament round, for explaining a ranking after the fact |
| `opportunity_batch_windows` | The debounce window candidates accumulate in |

None repeats `workspace_id`: `workspace_identity` binds the database once.
User, connector, work-stream, message, and Workflow identifiers cross authority
boundaries as stable text IDs and therefore are not fake local foreign keys.
Within the object, opportunity roots, links, user states, and snapshots have
real SQLite foreign keys and commit with the owning opportunity transaction.

## Operations

Open the workspace's Durable Object Data Studio.
`suggested_work_ranking_rounds` is the first place to look when suggestions are
wrong or missing: rounds accumulating with no corresponding `last_ranked_at` means
tournaments are starting and never finishing. From there, check
`suggested_work_sets.status` — a claim never overwrites it, so it is a true record
of how the last ranking ended — and `request_seq` against the scheduler's claimed
value.

## Changelog

### 2026-10-19 — Full canonical rosters have a bounded admission view

**What changed:** Sources and provenance retain up to 10,000 deduplicated people.
Each packed batch receives one bounded inference view with shown/total coverage;
persistence receives the complete original source once per decision.

**Why:** Canonical truncation lost real people. Splitting long source text across
roster windows could instead require hundreds of sequential calls and let later
decisions overwrite earlier user links or ignore an earlier opportunity.

**Considered and rejected:** An oversized prompt fails at the provider. Windowing
would need cross-window decision reconciliation and resumable checkpoints for a
coarse admission gate. A bounded view uses the existing character budget while
keeping all canonical evidence for subsequent work.

**Consequences:** Model sampling is explicit and does not promise every person
was considered. Source fingerprints and persisted provenance retain the full
roster, and one batch cannot repeatedly replace links for the same source.


### 2026-10-19 — Shared MCP resources are not verified people

Apollo authenticates each owner against the same MCP resource URL. Treating that
URL as a verified subject made successive owners overwrite one another in the
identity directory. Directory sync now honors an explicit null provider user
ID; inferring a person from the resource was rejected. Omitted IDs retain the
legacy account fallback, so existing verified connectors keep working.

### 2026-09-11 — The last consumer went away; the producer stayed

**What changed:** The macOS status menu dropped its Suggestions section, so
`menu-bar-content.ts` no longer reads `GET /work-opportunities`, no longer posts
impressions, and no longer starts a suggestion. Nothing in this module changed.
No candidate admission, ranking, schedule, table, or endpoint was touched.

**Why:** the menu was reworked around getting back into work already in flight
rather than starting something new — [`menu-bar.md`](menu-bar.md) argues that in
full. Suggested Work lost its surface as a consequence of that decision, not
because anything here was judged wrong.

**Considered and rejected:** switching the producer off in the same change.
Admission and ranking are a scheduled, stateful subsystem with its own hard-won
properties, and turning it off is a product decision about the capability, not a
detail of a menu edit. Left running and named here instead, so whoever makes that
call makes it deliberately.

**Consequences:** ranking follows attention, and nothing is reporting attention
any more — no surface records impressions, so each member's ordered four is now
re-ranked only by whatever else moves it. Do not read the current ordering as
evidence the tournament is working or failing. A surface that comes back must
bring impression reporting with it, or it inherits a frozen list.

### 2026-09-03 — Suggested Work stops paying a frontier model to ignore CI

**What changed:** Three bounds on the same pipeline. `enqueueActivityOpportunity`
withholds `github.check_run.*` and `github.workflow_run.*` from candidacy
before a window is opened (`isSuggestedWorkCandidateEventType`), and returns
what became of the activity so the consumer's terminal log records
`opportunity_enqueued` truthfully rather than as "unclaimed". The admission
call runs at `low` reasoning effort and sees at most `ADMISSION_CONTEXT_REASONING_CHARACTERS` (600)
of each existing opportunity's reasoning rather than 4,000. `DUE_DEBOUNCE_MS`
is 30 minutes rather than 2, and governs only the admission paths: the read
path's repair keeps its own two minutes as `READ_REPAIR_DELAY_MS`. For the
debounce to hold, `suggested_work_sets` gained `pending_due_at` (WorkspaceDO
schema v30): a request arriving while a pass holds the lease is parked there
and re-armed at its own time when the pass settles.

**Why:** The OpenRouter bill. In the week to 2026-09-03 the admission and
ranking prompts made 59,500 calls on `openai/gpt-5.6-terra` (the Flagship
choice since 2026-08-27), consuming a billion input tokens, 95 percent of them
from one three-member workspace. Three multipliers stacked: 42,000 of that
workspace's 50,000 candidates on 2026-09-02 were CI check runs, workflow-run
status transitions, and calendar instances (one recurring-series edit expands
to ~730 `calendar.event_changed` activities per attendee, because the poll asks
Google for `singleEvents`); each admission call was ~18,800 input tokens of
which the evidence was ~6,000 and the rest repeated context, half of it prior
admission reasoning; and every admission marked its members due two minutes
out, so with activity flowing the object ran 1,970 tournaments (8,590 rounds)
for three people in one day. Reasoning at `high` was a further quarter of the
admission output tokens.

**Considered and rejected:** Moving only the Flagship model. That is the largest
single lever and is being done separately, but a cheaper model asked the same
useless questions at the same rate is still the same design, and the next
model change would bring the cost straight back. Excluding
`calendar.event_changed` alongside the CI types: an earlier draft of this
change did, but the calendar volume was the connector expanding one series
edit into every instance, and that was fixed at the connector the same day
([`connectors.md`](connectors.md), 2026-09-02). With one activity per edit, a
moved or cancelled meeting is exactly the kind of candidate this surface
exists for, so withholding it here would have been treating a symptom after
its cause was gone. An inclusion list of candidate event types: it would
silently withhold every connector added later. Making the debounce depend on
whether the member is currently looking: the scheduler already declines
dormant members, and the tiering is where attention belongs.

**Consequences:** A check run or a workflow run can no longer become a
suggestion, however meaningful. The gate is bound to the connector manifests as
a floor rather than copied from them, so it cannot silently disagree with a
connector's own classification; review asked whether the exclusion duplicated
the digest partition, and the answer recorded above is that it deliberately
withholds five where that partition withholds 142. A member's set can now be up to
thirty minutes behind the admissions that changed it, unless one of the
immediate triggers fires (a suggestion naming them, a dismissal, a start) or
they open the home screen to an unranked or holed set, which repairs in two
minutes as before — review found the first draft had moved that member-present
path to thirty minutes too, which is a new member's first impression, so the
read repair got its own constant. Review also found the debounce did not hold
while a tournament was running: `markRankingDue` took `MIN` against the
in-flight pass's claim time, so under continuous admissions the next pass began
the moment the current one settled. That is why the parking column exists. An
existing opportunity's rationale reaches the next admission truncated, so a
duplicate that is only recognisable from the tail of a long memo may be admitted
twice. The 600-character cap and the thirty minutes are starting points chosen
for cost, not measured optima; `__workOpportunityTesting.limits` exposes both.

Shipped in #541.

### 2026-08-30 — Admission can no longer route into an existing work stream

**What changed:** The `route_existing` decision and its card-writing branch were
removed. Existing work streams remain in admission context only to help the
model avoid duplicate home-screen opportunities.

**Why:** Suggested context was removed as a product. Keeping a second producer
inside Suggested Work would preserve the same work-stream interruption and its
authorization, feedback, and rollout machinery under another name.

**Considered and rejected:** Mapping `route_existing` to `ignore` after model
output. Removing it from the model contract makes the boundary explicit and
prevents a future caller from treating that classification as a hidden route.

**Consequences:** Unclaimed activity has one speculative product surface: the
four Suggested Work items on the home screen. Existing work streams can prevent
a duplicate suggestion but cannot receive the evidence.

### 2026-08-24 — Admission context carries an explicit reader audience, and workspace-visible activity enters every member's private context

**What changed:** Suggested Work's admission read now sends WorkspaceDO either a
workspace audience or the exact personal audience member. Workspace admission
can inspect only workspace-scoped work streams; personal admission can inspect
everything that member may already view. The enabled `route_existing` decision
may create a card again only after a separate source-to-target audience check.

An unrestricted workspace connector event now fans into one personal admission
window per active member. Each inference sees that member's workspace-visible
and private work streams. The source retains its workspace audience, so it may
route into any target the member can read; a restricted source in the same kind
of window remains unable to broaden.

**Why:** The previous workspace call passed `userId = null`, and WorkspaceDO
interpreted null as “do not apply visibility.” That exposed private work-stream
titles and objectives to a workspace inference even though no workspace reader
had permission to see them.

Once scoped correctly, a workspace event is readable by every member, but a
single workspace window could inspect only workspace-scoped work streams. It
therefore could not recognize that the public event belonged to one member's
private work.

**Considered and rejected:** Picking a representative member for workspace
admission or filtering after the 20-row recency limit. The first borrows private
permissions the batch does not own; the second lets hidden rows consume the
bounded candidate set.

One workspace inference over the union of every member's private work streams,
or keeping both workspace and personal copies. The first leaks private titles
across users; the second creates duplicate opportunities and competing routing
decisions.

**What a future change has to respect:** Every cross-work-stream inference read
must name its audience before SQL executes. Workspace and personal are distinct
authorization cases, not null and non-null variants of one optional predicate.
Permission to inspect a target does not by itself authorize moving source content
there; the source audience must contain every target reader. The admission
audience and source audience answer different questions. Public evidence may be
evaluated separately in every member's authorized context, but those contexts
must never be merged.

### 2026-08-24 — Suggested-work telemetry follows WorkspaceDO authority

**What changed:** Impression, dismissal, and start-claim RPCs now return a
bounded telemetry context from WorkspaceDO-owned opportunity, member-state, and
visibility-filtered provenance data. HTTP routes consume that context and no
longer query regional D1 opportunity tables. A context read or validation failure
is logged and reduced to no detailed context without undoing or failing the
product action.

**Why:** After migration 0090 removed the legacy regional product tables, the
optional route-side enrichment continued selecting from them. Production
impressions and suggestion actions therefore returned an error even though the
authoritative WorkspaceDO operation was valid.

**Considered and rejected:** Recreating the D1 tables or maintaining a D1 read
projection would restore dual authority; dropping all detailed measurement would
discard useful exposure and conversion context. Reading the bounded fields from
the same object that owns the action preserves the funnel without another source
of truth.

**Consequences:** Future suggestion telemetry fields must be derived object-side
from data visible to the acting member. Missing optional context skips the
detailed event (with the legacy successful-start fallback) and can never turn a
successful suggestion action into an HTTP 500.

### 2026-08-19 — Provenance roots and user links import under the object's uniqueness

**What changed:** The maintenance-import source queries normalize two legacy
shapes the object schema refuses: provenance root positions are exported as a
dense per-opportunity rank over `(position, node_id)`, and duplicate user-link
identity assertions collapse to the latest row (highest rowid) per
`(opportunity, user, role, resolution, provenance node)` group.

**Why:** Legacy D1 keyed roots only by `(opportunity_id, node_id)` and treated
NULL `user_id` link rows as distinct under its unique, so re-rootings stacked
several node sets onto the same positions and duplicate NULL-user assertions
accumulated. The object enforces `UNIQUE (opportunity_id, position)` and a
COALESCE'd link identity index; both quarantined generation 3 of the Global
authority cutover mid-import. Normalizing in the source query keeps the
transform deterministic across pages and retries, which the exact-match import
check requires. A fleet audit of every other object-side unique found identical
D1 constraints, so these two are the complete set.

**Considered and rejected:** Relaxing the object's uniques (they encode the
product's real invariants — one node per position, one assertion per identity),
and deduplicating inside the Durable Object importer (cross-row state there
breaks the page-idempotent exact-match contract).

### 2026-08-18 — Completed opportunity windows settle idempotently

**What changed:** Duplicate event-mutation and window-settlement callbacks
return success after completion; nonterminal lease mismatches remain fenced.

**Why:** A Workflow may retry after the object committed but before the caller
observed its response. Treating that ambiguity as a fresh failure can
double-count attempts or create duplicate retry windows.

**Considered and rejected:** Persisting every callback receipt separately and
accepting a stale lease while a window is still processing.

**Consequences:** Terminal retries converge without extra rows. Active work
still requires the exact current lease.

### 2026-08-18 — Suggested work becomes WorkspaceDO-owned Workflow compute, admitted from connector-event Workflows

**What changed:** The complete opportunity graph and resolved per-user product
state moved into WorkspaceDO SQLite. Local alarms claim due admission/ranking
rows and create deterministic Workflows; reads, impressions, dismissal, and
start bookkeeping use typed RPC. Starting an opportunity also reads its bounded,
authorized provenance roots from WorkspaceDO and places their origin resources
in the new SubstreamAgent before its first run is dispatched. The maintenance
importer copies all D1 rows in foreign-key order before D1 writers are
permanently fenced, then route activation scrubs the source product rows.

Unclaimed connector evidence reaches batching from the per-event Workflow after
its normalized body has committed to WorkspaceDO. The regional Queue consumer no
longer runs watches, automations, or suggestion admission inline. Pending batch
rows fence the 24-hour D1 handoff redaction until the admission source has been
snapshotted.

**Why:** Opportunities and their evidence are scoped to one workspace, while a
regional D1 scheduler made cost and correctness depend on fleet-wide scans. A
workspace-local transaction can persist the opportunity, provenance, user
resolution, and ranking invalidation atomically. Queue callbacks should remain
short admission bridges, while semantic admission can take seconds and must have
durable retries independent of Queue redelivery; the source event itself belongs
to one workspace object.

**Considered and rejected:** Using D1 as a read projection, running model work
inside the DO alarm, and periodically waking dormant workspaces. Projections
restore dual authority, inference blocks the object's control plane, and idle
alarms spend money without improving a user-visible result. Also rejected:
increasing Queue retries around inference and retaining connector bodies
indefinitely in D1 for the delayed batch reader.

**Consequences:** Workflow payloads contain only fenced object pointers. D1
still supplies active membership/last-seen and verified connector identity
inputs, but no opportunity content, provenance, or user state remains or is read
after cutover; only redacted opportunity ID anchors satisfy the unshipped
workstream foreign key. Restricted personal connector evidence remains in the
opportunity snapshot but is never widened into a workstream-visible origin
resource. New connector suggestion sources must be reconstructible from
WorkspaceDO or materialize a bounded batch snapshot before the handoff expires;
they must not extend D1 event-body retention.

### 2026-08-13 — Older suggestion clients retain successful-start telemetry

**What changed:** A start request without the newer surface/position context now
emits the compatibility `suggested_work_started` event with
`surface=workspace_home`. New clients with complete exposure context continue to
emit only `suggested_work_started_v2`.

**Why:** Released clients do not send `surface`. Conditioning the compatibility
event on that optional field silently removed successful-start measurement until
every client upgraded.

**Considered and rejected:** Dropping older-client events or fabricating v2
position/provenance context. The former breaks the adoption series; the latter
would corrupt detailed exposure analysis.

**Consequences:** Missing optional attribution degrades to the truthful legacy
home surface and never creates a partially invented v2 event.

### 2026-08-13 — Exposure context completes the suggested-work funnel

**What changed:** Meaningful impressions, dismissals, and successful starts now
emit server-owned events with opportunity version, position, surface, audience,
connector types, freshness/exposure buckets, and—on success—the new work-stream
UUID.

**Why:** A start count alone cannot distinguish an unseen suggestion from a
visible one that was ignored or rejected, and client-only clicks over-count
failed creation.

**Considered and rejected:** DOM impression capture, prompt/title properties,
one connector event per provenance root, and emitting legacy plus detailed starts
for the same request. Those choices respectively mismeasure visibility, expose
content, multiply conversions, or inflate starts.

**Consequences:** Every suggestion surface must report a bounded position and
version. Older clients without that context keep the legacy success fallback;
current requests produce one detailed event per state transition.
### 2026-08-12 — Existing-work decisions stopped creating transcript cards

**What changed:** Admission still recognizes `route_existing`, but while
Suggested context is paused the decision creates no `activity_suggestions` row
or work-stream event. Activity not claimed by a watch or automation now reaches
admission without first running the per-activity contextual classifier.

**Why:** Removing the noisy work-stream card should not turn the same evidence
into duplicate proposed work on the home screen. Retaining `route_existing` as
a terminal classification preserves that distinction, while guarding its write
keeps the work-stream surface fully quiet. Removing the action from the model
contract was rejected because it would conflate “already has a home” with
“irrelevant” and make a future re-enable a schema migration.
