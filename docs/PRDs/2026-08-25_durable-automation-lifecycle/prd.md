# Durable automation lifecycle

> Created 2026-08-25.
>
> Give every automation one regional Durable Object and one stable identity from
> the first wizard turn through active execution, while keeping each generated
> run in its own work stream. State: [`state.md`](./state.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Subsystem references: [`automation-drafts.md`](../../automation-drafts.md),
> [`agent-harness.md`](../../agent-harness.md),
> [`workstream-durable-object.md`](../../workstream-durable-object.md),
> [`durable-object-alarms.md`](../../durable-object-alarms.md),
> [`data-model.md`](../../data-model.md), and
> [`workstream-email-addresses.md`](../../workstream-email-addresses.md).
> Transcript dependency:
> [ordered, range-addressable work-stream turns](../2026-08-26_ordered-workstream-turn-transcripts/prd.md).

## Summary

Every automation is represented by one regional SQLite-backed Durable Object,
called the **AutomationAgent** in this PRD. The object is created before the
automation architect begins its first compiler run, but only after the person
sends the first prompt. Merely opening the new-automation screen creates no
server record or Durable Object. From first-prompt admission onward, the object
owns the automation's canonical identity and lifecycle:

```text
draft -> activating -> active -> paused
draft -> deleted
paused -> activating        (resume)
activating -> active        (first activation or successful reactivation)
activating -> paused        (author pause or failed reactivation)
active | paused | activating -> deleted
```

`activating` may carry a safe error and retry action. It remains non-runnable
until every required registration is acknowledged. A failed first activation
remains retryable, pausable, or deletable and is never reopened as an editable draft. A
failed resume returns to `paused` with its last successfully accepted
definition intact, so a connector failure cannot force the person to delete a
previously working automation. Operational failures are orthogonal
attention/error records rather than another lifecycle state.

While the automation is a draft, its AutomationAgent owns the canonical wizard
conversation, current compiled definition, structured elicitation, streamed
output checkpoint, durable Bind run ledger, and tool receipts. A compiler run
continues after its author closes the screen; reopening the draft reads a
canonical snapshot and reconnects to the same active or terminal run. A failed
first compile still leaves one resumable draft under Automations rather than
discarding the person's request.

The wizard conversation composes the shared ordered transcript substrate
established by the companion work-stream-turn PRD. It does not introduce a
second JSON transcript or infer Bind state from display rows. The same
object-local transaction owns canonical semantic facts, the author-visible
`transcript_sequence` projection, and the restricted lossless `loop_sequence`
projection. AutomationAgent supplies its personal author admission and wizard
presentation adapter; the substrate supplies stable turn/block identity,
explicit range coverage, active checkpoints, activity timing, snapshot/event
fences, and exact Bind reconstruction.

The Automation Draft Wizard also composes the same renderer conversation
surface as a work stream. Its feed, transcript blocks, streaming and activity
presentation, attachment affordances, follow/pagination behavior, and message
composer are shared components and hooks, not parallel wizard implementations.
WorkstreamScreen and the wizard remain thin product adapters: a work stream
supplies participant, attention, resource, and run-control policy, while the
wizard supplies single-author draft admission, compiler lifecycle, review, and
acceptance policy.

Acceptance changes the state of that same object. It freezes the accepted
definition, validates the selected scope and authority, installs required
trigger registrations, and moves through `activating` to `active`. It does not
copy the draft into a different owner or mint a replacement automation. The
active commit deletes the draft conversation; it is neither editable nor used
as runtime prompt context after acceptance.

The AutomationAgent owns automation-local trigger admission, scheduling,
idempotency, run history, configuration, pause/resume, delivery receipts, and
the automation memory scope including its items, table rows, cells, and mutation
receipts.
It extends Rally's existing `ScheduledDurableObject`, so calendar occurrences,
Bind recovery, activation reconciliation, projection recovery, and maintenance
share the repository's SQLite-backed multi-alarm index rather than competing for
the one native Cloudflare alarm or reimplementing its drain and recovery rules.
It does **not** execute the generated automation's work. Each admitted trigger
creates one private work stream by default, and that work stream's main
`SubstreamAgent` owns its transcript, participants, Bind loop, tools, resources,
and live stream under the ordered-turn contract. These generated work streams
do not appear in the global work-stream sidebar. WorkspaceDO retains only a
hidden, content-free reader-admission projection so the automation home can
filter its paged run-summary list without treating the sidebar as authority.
The automation home opens the child work stream only when a person chooses a
run, and the child reauthorizes the open against its current participants.

WorkspaceDO remains the workspace control plane and the canonical processor for
external connector events. It keeps queryable, monotonic projections for the
sidebar and activity-trigger evaluation, as well as shared template catalogs,
connector resources, membership, and other workspace-wide authorities. Each
AutomationAgent publishes a versioned, type-safe evaluator set that tells its
WorkspaceDO which canonical Gmail, Linear, Granola, or other external events are
candidates for that automation. WorkspaceDO evaluates those predicates beside
the event authority and delivers only durable, idempotent matches to the
AutomationAgent. Calendar and interval timers never enter that evaluator set;
the AutomationAgent schedules them directly through its inherited multi-alarm
index. The same WorkspaceDO evaluator index, match receipt, and ID-only Queue
delivery path also deliver a canonical resource update to each work stream whose
authoritative resource link has registered a watch. Only the destination adapter
differs: an automation match calls AutomationAgent admission, while a resource
watch appends one idempotent connected-activity update to the watched work
stream after a current audience check. A projection can locate or wake a target;
it cannot authorize a sensitive read or mutation on the target's behalf.

SubstreamAgent and AutomationAgent share extracted durable Bind and ordered
transcript capabilities: canonical facts, exact Bind state, provider receipts,
tool receipts, checkpoints, activities, snapshots, recovery, and terminal
settlement. They do not share a database or product authority. Each host
supplies its own prompt, tools, authorization, context projection, lifecycle
policy, and result publication. BlockDashboardAgent adopts none of the shared
ordered-transcript or durable Bind host runtime in this cutover; its
source-runtime path is materially different and remains unchanged. A later
change may extract a lower-level receipt helper only after a concrete duplicate
is identified. The ordered transcript substrate is used
only by an authority that saves a replayable LLM conversation: SubstreamAgent
and the draft-state AutomationAgent use it, while BlockDashboardAgent continues
to retain derived block dispatch/output state and reaches its source transcript
through SubstreamAgent.

The implementation is one merge and one deployed Worker build, not a
per-automation product rollout. That build contains a temporary per-workspace
cutover RPC and both readers needed while each workspace is fenced; it never
dual-writes. A merge-triggered deploy step runs only after both regional
Workers are deployed and healthy, migrates and verifies every accepted automation, discards every
legacy draft, then invokes explicit per-object cleanup that removes the old
WorkspaceDO automation-lifecycle schema. Existing-object cleanup cannot run
merely because an object wakes: it requires the explicit receipt-gated cutover
RPC. The same merge adds a current-schema bootstrap mode to the existing SQLite
migration runner, so a WorkspaceDO first created after the regional campaign
starts directly on the post-cutover schema and never recreates empty legacy
automation tables. Once the regional campaign receipt is complete, absence of
a per-workspace campaign row means new AutomationAgent authority, never legacy
authority. Transitional code remains inert after its durable workspace
campaign receipt says `completed`; no second merge or deployment removes it. New drafts
created after that workspace's cutover use AutomationAgent. Rally has no
customer drafts whose setup must survive, but the workflow binds every deletion
to a fresh per-region source witness and object-local hash check.

## Motivation

Rally already promises that automation setup is durable work. A draft appears
under Automations, keeps one ID across turns, and can be reopened tomorrow. The
current execution boundary stops short of that promise:

1. The conversation becomes durable only after a successful compiler turn. A
   provider failure, invalid model output, dropped request, or database failure
   on the first turn leaves no draft to return to.
2. The active compiler run is owned by an HTTP/SSE request. Leaving the builder
   disconnects the only live view of its progress, and the run has no durable
   owner that can recover it from committed Bind boundaries.
3. Two windows each send a whole conversation and settle last-turn-wins. One
   accepted write can erase a different accepted turn, even though the sidebar
   presents both windows as editing the same durable draft. The replacement is
   append-only turn admission, not another whole-draft compare-and-swap.
4. Draft promotion is atomic today only because draft and active automation
   state both live inside WorkspaceDO. A draft-only agent was therefore the
   wrong boundary: promotion would have transferred authority across objects.
   Making the object own the automation after acceptance removes that transfer
   instead of adding a distributed transaction around it.
5. WorkspaceDO owns scheduling and configuration for every automation in the
   workspace even though each automation has an independent lifecycle,
   trigger stream, compiler history, and run-idempotency domain. This enlarges
   the workspace-wide failure and serialization boundary for state that does
   not need cross-automation transactions.
6. The three long-running Bind surfaces already need the same unglamorous
   durability mechanics. Maintaining separate admission, receipt, checkpoint,
   recovery, and SQLite code invites semantic drift; making one surface adopt
   another surface's product model would erase real differences instead.

This proposal is driven by a product-contract and authority mismatch found in
architecture review, not by measured production incident volume. Rally has no
load history or automation reliability series from which to claim a capacity or
outage reduction. The required result is therefore stated in observable
behavior and failure containment, not projected scale.

There are internal accepted automations whose configured behavior and history
must survive the change, but no customer draft setup to preserve. The least
ambiguous migration is consequently destructive at the old boundary: import
accepted automations once, delete old drafts, remove the legacy lifecycle
tables, and let the post-merge system have exactly one canonical writer.

## Goals

1. Give an automation one stable ID and one canonical regional owner from the
   first submitted wizard turn until deletion.
2. Let an author leave and reopen a draft while its compiler is running,
   waiting for input, completed, or failed, without restarting successful work
   or losing the settled conversation.
3. Make the human turn, compiler run, tool effects, structured elicitation,
   streamed checkpoint, and compiled revision durable independently, so each
   can recover from its last committed boundary.
4. Accept a draft by changing state inside the same object, with idempotent
   external registration and no interval in which the UI calls an automation
   active while a required trigger route is absent.
5. Make each active automation the authority for its definition, status,
   trigger admission, next due time, run idempotency, and automation-local
   delivery state.
6. Build AutomationAgent on the existing `ScheduledDurableObject` base and its
   `_internal_durable_alarms` index, so every independent wake reason retains
   exact re-arming, per-entry retry gates, stall detection, and cancellation
   recovery already shared by Rally's other scheduling objects.
7. Keep workspace lists and activity routing queryable without treating a
   WorkspaceDO projection or the Durable Object namespace as canonical product
   state.
8. Preserve the existing work-stream boundary: every automation run owns one
   work stream, and its SubstreamAgent remains the sole authority for generated
   transcript, audience, tools, and agent execution, while the AutomationAgent
   owns only the occurrence and a content-free execution projection.
9. Put generated run work streams in a paged list on the automation home rather
   than the global work-stream sidebar or public directory response, without
   weakening list filtering or direct child authorization.
10. Adopt the ordered transcript substrate for the canonical draft wizard
    conversation and its exact Bind state, and extract only the durable
    Bind/SQLite capabilities required by SubstreamAgent and AutomationAgent.
    BlockDashboardAgent remains unchanged in this cutover.
11. Preserve personal-draft privacy, generated-run privacy, regional residency,
   inbound-email defenses, and content-free product telemetry.
12. Migrate every visible accepted automation without changing its ID,
    schedule, permanent email address, frozen effective definition, run history, or effective
    user settings and without admitting a trigger twice. Preserve `active` and
    `paused`; map legacy `error` to non-runnable `paused` plus an orthogonal
    runtime-error attention record. Delete every legacy draft and remove the old
    WorkspaceDO automation-lifecycle tables in the same merge-triggered cutover.
13. Replace untyped deterministic activity-filter records with a closed,
    versioned evaluator grammar whose structure is parsed at every wire and
    storage boundary and whose fields and operators are validated against the
    exact connector event manifest before registration.
14. Reuse the external-event evaluator, receipt, and Queue delivery engine for
    work-stream resource watches, without moving attachment/watch authority or
    transcript ownership into WorkspaceDO, adding a second transport retry
    owner, or creating a second connector-event fan-out pipeline.
15. Provide reviewed event-family, canonical resource-relationship, canonical
    person, and bounded sensitive-content vocabulary sufficient for the Slack,
    Linear, Granola, GitHub, and Notion trigger intents in this PRD, and refuse
    activation when a connector cannot yet normalize the required evidence.
16. Give the automation architect one strict complete-replacement tool for
    staging evaluator rules, so every external-event draft is produced through
    the same typed and registry-aware boundary that acceptance and WorkspaceDO
    later enforce, without exposing authority-owned IDs or projection fields to
    the model.
17. Reuse the Workstream screen's message-feed, transcript-block, attachment,
    scrolling/follow, streaming/activity, and composer/input implementation in
    the Automation Draft Wizard through product-neutral renderer ports, while
    retaining separate Workstream and AutomationAgent data and lifecycle
    adapters.
18. Preserve every accepted automation's effective execution context, complete
    memory contents, inbound-email defenses, and telemetry attribution after the
    legacy WorkspaceDO joins and tables are gone.

## Non-goals

1. **Running the generated automation inside AutomationAgent.** The object
   admits and records a run; the generated work stream's SubstreamAgent performs
   the work. Combining them would collapse an automation occurrence and a
   participant conversation into one authority even though they have different
   lifetimes, recovery boundaries, and audiences.
2. **Turning AutomationAgent into a generic SubstreamAgent.** The shared Bind
   kernel is reusable machinery, not a common product entity. An automation
   draft is single-author configuration work; a work stream is a multiplayer
   durable conversation.
3. **Making drafts collaborative or workspace-visible.** A draft remains
   personal to its author until acceptance settles the chosen scope.
4. **Changing an accepted automation's definition.** This PRD ends the editable
   draft conversation at acceptance and removes private-template adoption.
   Existing metadata controls that do not replace triggers or schedules may
   remain, but a future reviewed definition-revision workflow is a separate
   product decision and no `active -> activating` producer is specified here.
5. **Moving shared templates, connector credentials, workspace resources,
   identity, or membership into every AutomationAgent.** The object stores
   immutable references and frozen grants; shared authorities stay shared.
6. **Enumerating Durable Objects to build product lists.** The administrative
   namespace is not a product index. WorkspaceDO projections serve lists and
   fan-out.
7. **Changing publication or discovery of shared templates.** A template
   remains a versioned shared artifact, and adopting one creates an independent
   AutomationAgent. This cutover deliberately removes subscriber-side private-
   template version adoption and “update available” behavior: an accepted
   automation freezes the copied definition so WorkspaceDO does not remain a
   runtime settings authority.
8. **Changing generated work-stream audience or delivery destinations.** Run
   work streams remain private by default, and delivery remains a distinct
   configured output rather than an instruction for the model to send twice.
   Removing those children from the global sidebar changes discovery, not their
   reader authority or configured delivery behavior.
9. **Replacing Bind with the Cloudflare Agents SDK or exposing a user-authored
   workflow runtime.** The change supplies a durable host for the existing
   authorized compiler and run machinery.
10. **Choosing new numeric timeouts, transcript ceilings, retry counts, or
    concurrency caps.** Existing limits remain unless implementation evidence
    requires a change; any new defensive number is a separate team decision.
11. **Using Cloudflare Flagship as the runtime or control plane.** Its typed
    operators, missing-attribute behavior, stable context, and safe default
    inform the local grammar. Automation routing stays
    regional and workspace-authoritative, and this PRD does not add a Flagship
    binding, percentage rollout, or remote flag dependency.
12. **A staged automation-authority rollout or legacy compatibility path.** The
    implementation does not dual-write, flip automations individually, retain
    old lifecycle tables for rollback, or migrate pre-cutover drafts. The one
    deployed build may serve a not-yet-fenced workspace through temporary legacy
    readers and invoke migration-only RPCs; those paths become inert at that
    workspace's completion receipt and are never a post-cutover fallback.
13. **Turning the wizard into WorkstreamScreen.** Sharing the conversation
    surface does not give an automation draft participants, unread state,
    presence, work-stream resources, a block dashboard, substream routing, or
    generated-run controls. Those are Workstream product policy, not reusable
    conversation UI.

## Product behavior

### Starting and returning to a draft

Selecting **New automation** continues to do only what it does today: it opens
the empty new-automation screen. The route remains the unpersisted new route,
the composer follows the desktop's local draft behavior, and no AutomationAgent,
automation ID, WorkspaceDO directory row, or Automations-sidebar draft exists
yet. Navigating away without sending leaves nothing to clean up or return to.

That empty screen and every durable draft use the same shared composer/input
surface as a work stream, including attachment staging and preview, paste and
file-drop behavior, dictation, keyboard/send semantics, error presentation, and
local composer-draft recovery. The new-route adapter changes what `onSend`
does: the first send performs AutomationAgent admission, while later sends name
the admitted AutomationAgent. Both `/automations/new` and
`/automations/:automationId` render one `AutomationScreen` beneath a persistent
`/automations/*` shell. `AutomationScreen` selects the draft wizard or the
existing accepted-automation home from authoritative lifecycle state; the
current `?draft=` convention is retired. Changing the child route therefore
does not unmount the conversation subtree. The local composer draft key
transfers atomically from the new-route key to the returned automation-ID key
before the old key is cleared, and staged attachments are re-keyed by the same
admission result. First-send admission therefore does not discard text typed
while the request is in flight, staged attachments, focus, or scroll/follow
state.

Sending the first prompt crosses the durable boundary. The renderer supplies a
stable client creation key and client message ID, but the regional server mints
the automation ID. A regional WorkspaceDO idempotency claim maps
`(author, client creation key)` to that ID, then the named AutomationAgent's
first object-local transaction records its immutable identity, the original
human turn, and compiler-run admission before any provider work begins. An
uncertain retry with the same creation key resolves the same ID and message
rather than creating a second object. The response changes the URL from the new
route to that durable ID, and the admitted draft becomes eligible for the
personal Automations sidebar through its ordinary projection. Until a compiler
produces a name, the sidebar shows the content-free label **New automation**;
the first compiled definition replaces it without another model call on the
creation path.

Later turns name the existing AutomationAgent and durably append the person's
message and compiler-run admission before provider work. The builder renders a
snapshot followed by live sequenced changes. Navigating elsewhere, closing the
window, losing the live WebSocket, or restarting Rally does not cancel an
admitted run. While it is active the shared composer exposes **Stop**. Stopping
durably settles that compiler run as cancelled, preserves committed tool
receipts and the last compiled revision, and permits the next human turn; it
does not attempt to undo a completed provider read. Reopening the draft shows:

- every settled human and Rally turn in canonical order;
- the latest compiled definition and whether it is ready to accept;
- an unanswered structured elicitation, if one is pending;
- the current narration/tool checkpoint and run status when work is active;
- a terminal failure with a safe retry action when work stopped; and
- any attachment identities associated with their original turns.

The settled and live rows render through the same shared feed and block family
used by WorkstreamScreen: human and assistant messages, Markdown, attachments,
thinking and tool activity, elicitation, streaming reveal, work timing,
load/error states, transcript follow, **Jump to latest**, bounded history
loading, and prepend scroll preservation. The wizard may add draft summary,
configuration, review, and acceptance cards around that surface; it may not
fork the conversation renderer or composer to do so.

The wizard uses the shared `use-transcript-follow.ts`
`TRANSCRIPT_END_SLACK` threshold, including its 80-pixel handoff behavior, and
the same virtualized transcript viewport as WorkstreamScreen. It does not
retain the old wizard's two-pixel threshold or a second viewport implementation.

Those rows are projections of the same canonical turn/block facts and exact
Bind transitions defined by the ordered-turn substrate. A human or assistant
turn has a stable identity; assistant text, thinking, and tool activity retain
their model-declared order; mutable tool/activity lifecycle changes update that
identity rather than creating a competing row. Wizard boot and reconnect use a
hibernating WebSocket with the snapshot fence in its socket attachment,
explicit half-open coverage, an active checkpoint, and one durable event fence,
matching the work-stream feed transport. Human-turn admission is an ordinary
HTTP request; compiler text and activity arrive through the socket, not a
second SSE-owned transcript stream.
Because a draft has one author and no collaborative unread state, its initial
unread slice is normally `null` with `unreadReason = no_unread`; the latest
slice and active state still come from the same snapshot. Leaving and returning
therefore exercises the same lossless transcript/reconnect contract already
implemented for work streams, with an AutomationAgent-specific authorization
and presentation adapter.

An interrupted provider request can restart from the last committed Bind
boundary; Rally does not claim to resume the provider's exact network stream.
Durable tool receipts prevent a recovered run from blindly repeating a known
effect. The same WebSocket remains subscribed after a canonical snapshot so newer
events do not fall into a snapshot/reconnect loop.

A failed first compile therefore remains a real, named draft. Its human message
and failure state are present even when no valid compiled definition exists
yet. Retry creates a new attempt against that same turn and object; it does not
open a second draft.

### Ordering and concurrent windows

The AutomationAgent serializes compiler turns. A submitted message is
idempotent by its client message ID. If no compiler turn is active, one
object-local transaction appends the human turn and admits its compiler run; if
a turn is active, the object refuses the new submission as busy before
inference or tool execution and the client preserves the unsent composer text.
The request does not carry a draft revision or expected transcript head. Drafts
are single-author, turns append rather than replace state, and the compiler
always reads the latest canonical conversation, so a stale window cannot cause
a lost update and does not need an optimistic-concurrency token.

The active compiler record uses the admitted run's stable ID, not a new random
ID on each HTTP retry. **Stop** is the person's escape hatch from the busy
fence: it fences any late provider result, terminally settles the run, and lets
the preserved composer text be submitted as a new turn. A stopped run is never
silently reclaimed or resumed by an alarm.

Answering a structured elicitation names the still-pending elicitation and is a
new human turn. The answer is admitted only while that elicitation remains
unanswered and is idempotent by its client message ID, so reconnect and retry
cannot answer the same question twice.

### Reviewing and accepting

The review screen reads the current compiled definition revision and submits
the person's chosen scope, principal, connector bindings, schedule
interpretation, model override, resource relationships, memory/table
definitions, and delivery destinations against that revision. Suggested scope
and destination remain proposals until this action.

The AutomationAgent claims acceptance once. It freezes the accepted definition
and moves to `activating`. While activating:

- no compiler turn may rewrite the definition;
- no manual, scheduled, activity, or inbound-email trigger may start a run;
- calendar and interval schedule records are made durable in the object, but
  their `_internal_durable_alarms` entries are installed only by the final
  `active` commit;
- the WorkspaceDO sidebar projection and complete external-event evaluator
  snapshot are installed and acknowledged with their evaluator generation and
  `effectiveAfterEventSequence` boundary;
- the automation's permanent inbound email address is claimed in the Global
  registry; and
- every required registration records an idempotent receipt that can be
  reconciled after a partial failure.

The automation becomes `active` only after the registrations required by its
configuration are acknowledged. The UI keeps the same row and ID and shows an
activating state rather than reporting success early. Repeating the accept
request returns the same result. A recoverable activation failure leaves the
same non-runnable object in `activating` with the failure named; retry continues
the same activation operation. An ambiguous external registration remains
`activating` until reconciliation determines its result. The person may pause
or delete an initial activation that cannot be completed. A failed resume from
`paused` returns to `paused`, retains the last working
accepted definition and run history, and exposes retry; it never makes deletion
the only exit. Rally does not attempt distributed compensation in order to
reopen either case as an editable draft.

The evaluator acknowledgement is an ordering boundary, not merely confirmation
that a row exists. The existing first Queue stage carries the bounded provider
event to WorkspaceDO. WorkspaceDO then accepts the canonical envelope and
assigns its monotonic workspace event sequence in one transaction before the
consumer publishes the sequence-bearing ID to the second Queue stage.
Installing a generation returns the current accepted sequence as
`effectiveAfterEventSequence`, and evaluation excludes that generation from
events accepted at or below the boundary, including accepted events whose
ID-only second-stage messages are still waiting in the Queue. An event received
by connector ingress before activation but not accepted by WorkspaceDO until
after the boundary is a later canonical event and may match; this PRD does not
claim provider-receipt ordering across the first Queue hop. AutomationAgent stores the generation and
boundary before committing `active`. A delivery for that current generation
and a later event sequence that reaches the object while it is still
`activating` is idempotently recorded in the object's trigger-receipt ledger as
`held_for_activation` and starts no run. The destination delivery can then
settle without depending on Queue retention. The local active commit promotes
every held receipt for that generation into occurrence admission exactly once;
this all-events behavior is deliberate and has no guessed cap. A person who
does not want events accumulated during a stalled activation can pause or
delete instead of activating it. Either transition terminally refuses every
held receipt for that generation and publishes an empty evaluator snapshot; a
later resume uses a new generation. An old
generation or an event at or below the boundary is terminally stale. Event
outcome therefore depends on canonical event order, not whether Queue delivery
happened just before or after the local active commit.

The conversation remains canonical while activation is incomplete so a
reviewable failure still has its authoring context. The commit to `active`
retains the frozen definition and acceptance receipt and deletes the draft
conversation, matching today's post-promotion retention behavior. The active
automation never prompts a generated run with the authoring discussion, and
the transcript is not copied to WorkspaceDO or Global storage for convenience.

### Active lifecycle and triggers

An active AutomationAgent serves the automation overview and owns pause,
resume, delete, next-run state, and run history.
Shared templates are authoring starters only after this cutover: an accepted
automation freezes its effective settings and does not retain the old private-
template update relationship. This PRD does not add accepted-definition editing.
A deleted or draft object terminally rejects every run trigger even
if a stale projection routes one to it. A paused object likewise rejects run
admission. An activating object starts no run, but a current-generation external
delivery later than its activation boundary may be durably held until activation
commits, the author pauses, or the automation is deleted. Entering `paused`
from `activating` terminally refuses all held receipts for that generation;
none may be promoted by a later resume.

- **Calendar and interval:** each canonical schedule is mirrored as an indexed
  entry in `_internal_durable_alarms`. `ScheduledDurableObject` keeps the one
  native alarm pointed at the earliest effective instant across those entries
  and the object's other stored or derived wake reasons. Alarm delivery reloads
  the canonical schedule and definition and uses a stable occurrence key, so
  platform retries resolve to the same admitted run. Advancing, disabling, or
  deleting a schedule reconciles the index and re-arms before returning. Resume
  skips missed occurrences and computes the first occurrence strictly after the
  resume commit; it never creates a catch-up burst. Rally no longer pre-creates
  the next planned work stream before its due time.
- **Manual:** the overview calls the object directly. A client idempotency key
  identifies the requested run.
- **External activity:** WorkspaceDO parses and persists the normalized event,
  selects evaluator projections by exact connection and event type, evaluates
  each typed predicate once, and durably delivers an ID-only match receipt to
  each candidate AutomationAgent. Each object rechecks lifecycle, evaluator
  generation, activation event-sequence boundary, event receipt, and frozen
  connector authority before admission. WorkspaceDO never matches a generation
  against an event at or below its `effectiveAfterEventSequence`; a later
  current-generation delivery that arrives during activation is durably held
  rather than discarded or admitted early. Activation does not report `active`
  until that routing boundary is acknowledged and stored. Multiple evaluator
  registrations matching one canonical event converge on the unique occurrence
  key `(automationId, workspaceEventId)`, so one event creates at most one run.
- **Inbound email:** the Global ledger resolves the permanent address to region,
  workspace, and automation ID. The regional AutomationAgent rechecks active
  state, sender eligibility, receipt idempotency, the existing per-automation
  rate window and receipt lease, and the restricted tool policy before it admits
  a run. The logical occurrence key is `(automationId, resendEmailId)`.

Admission creates or resolves one `automation_run` identity, then provisions
one generated work stream. The admission transaction also writes a stored
`run_provisioning` alarm entry keyed by run ID. Provisioning settlement removes
that entry only after the child identity and immutable run-context snapshot are
committed; a crash therefore re-drives the claimed run instead of advancing the
schedule past an orphan. Retry does not create a second work stream. The
automation records the resulting work-stream ID as an opaque child reference.
The SubstreamAgent becomes canonical for everything inside that work stream.

At occurrence admission AutomationAgent freezes `AutomationRunContextV1`: the
accepted definition revision, effective instructions and model/settings,
trigger metadata, execution principal, delivery destinations, automation ID and
trigger type for telemetry, and an automation-memory scope reference. Child
creation receives that typed snapshot, so generated-run prompting and delivery
never join back to removed WorkspaceDO tables. The child performs result
delivery because it owns the result bytes; AutomationAgent records only the
typed delivery receipt. Automation memory reads and mutations use a fenced typed
RPC to AutomationAgent, whose SQLite transaction owns the memory item/table data
and mutation receipt. No cross-object SQL query is introduced.

AutomationAgent remains canonical for the occurrence envelope: trigger and
idempotency key, planned time, frozen definition revision, child work-stream ID,
admission state, delivery state, and the latest accepted child execution
projection. Parent admission, child execution, and result delivery are separate
state dimensions; no single `status` field may let a delivery retry reopen a
terminal execution or let a child lifecycle update rewrite the trigger claim.

The child publishes a content-free, full execution snapshot only after the
corresponding ordered-turn facts are committed. At minimum it identifies the
automation/run/work-stream/harness generation, child source version and payload
hash, execution outcome, attention state such as `needs_input`, started and
completed times, `committedThroughTranscriptSequence`, and nullable
`finalAssistantTurnId`. It contains no transcript text, prompt, tool argument or
result, reasoning payload, participant list, or delivery content. A terminal
projection cannot name a final turn that is not canonically committed.
An outstanding `needs_input` projection also produces a new automation-run
attention row in WorkspaceDO, without adding the child to the work-stream
sidebar. It is visible only to current automation viewers, displays the
automation name plus **Run needs input**, and navigates to the automation home
with that run selected. A later child projection clears it when input is no
longer needed, the run settles, or the child is deleted; pausing or deleting the
automation clears it as part of projection cleanup.

The durable handoff follows the existing work-stream effect path rather than a
cross-object write hidden inside child settlement:

```text
SubstreamAgent canonical transaction + child durable_outbox
  -> typed, receipt-backed WorkstreamDO aggregate/effect
  -> regional Queue wake-up
  -> typed AutomationAgent.applyRunProjection
  -> AutomationAgent receipt + monotonic automation_run projection
```

AutomationAgent accepts the effect only when the automation ID, run ID, child
work-stream ID, harness identity, and authority generation match its admitted
occurrence. Duplicate `(generation, sourceVersion, hash)` snapshots are no-ops;
lower versions are stale; equal versions with a different hash are an integrity
failure. The child allocates `sourceVersion` and the payload hash atomically with
the exact outbox bytes; this deliberately fails closed rather than accepting the
newer payload on version reuse. An integrity conflict, unknown occurrence, or
tombstoned automation returns a typed terminal `rejected` outcome, records an
attention item where applicable, and acknowledges the child outbox/Queue
delivery instead of throwing into a permanent DLQ loop. Queue delay can make the automation home stale but cannot mutate or
delay the child transcript. A later ordinary participant follow-up in the child
work stream does not reopen the automation occurrence; only harness runs
explicitly admitted as continuations of that occurrence may advance its
execution projection.

Pausing preserves schedules, address claims, and definition. It disarms run
admission, not identity. Its schedule entries are removed from the multi-alarm
index while the canonical schedule records remain paused, and it publishes an
empty evaluator snapshot after its local lifecycle fence rejects stale event
deliveries. Resuming revalidates required registrations, installs and receives
acknowledgement for a new evaluator generation and its
`effectiveAfterEventSequence`, reconciles timer entries, and re-arms before the
object becomes active again. Deliveries from the pre-pause generation are
terminally stale; current-generation deliveries later than the new boundary
are held while resume is activating. Deletion writes a durable
tombstone, removes every automation-owned alarm entry and live workspace
projection, deletes the generated run work streams after an explicit destructive
confirmation, and keeps permanent Global email claims tombstoned as they are
today. The dialog no longer promises that past runs remain. Queue timing may
decide whether an event already in flight was admitted immediately before the
pause commit; the activation event-sequence guarantee above is not claimed for
pause.

### External event evaluator contract

The accepted automation definition compiles to a complete evaluator-set
snapshot. One evaluator names exactly one resolved connector connection and one
manifest-declared event type. A trigger that accepts several event types
therefore compiles to several evaluators. This makes candidate lookup an exact
index operation and gives every predicate one unambiguous field vocabulary;
WorkspaceDO never has to interpret a field whose type changes with the event.
An optional `resourceId` further narrows that exact source for a resource-watch
trigger; acceptance proves that the resource belongs to the named connection
and expands a watch covering several declared events into separate evaluators.
Webhook and poll sources share the same post-normalization contract. A draft
trigger that proposes “any connector” is not registered as a wildcard:
acceptance expands the currently authorized, declared source/event pairs into an
explicit snapshot, and a connector added later does not silently broaden it.

The wire shape is a versioned discriminated union, conceptually:

```ts
type AutomationExternalEvaluatorSetV1 = {
  schemaVersion: 1;
  automationId: AutomationId;
  definitionRevision: AutomationDefinitionRevision;
  authorityGeneration: AutomationAuthorityGeneration;
  projectionVersion: AutomationEvaluatorProjectionVersion;
  evaluators: ExternalEventEvaluatorV1[]; // empty removes every live evaluator
};

type ExternalEventEvaluatorV1 = {
  evaluatorId: ExternalEventEvaluatorId;
  source: {
    connectorType: ConnectorType;
    connectionId: ConnectionId;
    eventType: ConnectorEventType;
    resourceId?: ResourceId;
  };
  when: ExternalEventPredicateV1;
};

type ExternalEventPredicateV1 =
  | { kind: "always" }
  | {
      kind: "dnf";
      anyOf: NonEmptyArray<{
        allOf: NonEmptyArray<ExternalEventPredicateLeafV1>;
      }>;
    };

type ExternalEventPredicateLeafV1 =
  | {
      kind: "string";
      attribute: string;
      operator: "equals" | "not_equals" | "contains" |
        "starts_with" | "ends_with";
      value: NonEmptyString;
    }
  | {
      kind: "string";
      attribute: string;
      operator: "in" | "not_in";
      value: NonEmptyArray<NonEmptyString>;
    }
  | {
      kind: "number";
      attribute: string;
      operator: "equals" | "not_equals" | "greater_than" | "less_than" |
        "greater_than_or_equals" | "less_than_or_equals";
      value: FiniteNumber;
    }
  | {
      kind: "number";
      attribute: string;
      operator: "in" | "not_in";
      value: NonEmptyArray<FiniteNumber>;
    }
  | {
      kind: "boolean";
      attribute: string;
      operator: "equals" | "not_equals";
      value: boolean;
    }
  | {
      kind: "person_id";
      attribute: string;
      operator: "equals" | "not_equals";
      value: PersonId;
    }
  | {
      kind: "person_id_array";
      attribute: string;
      operator: "has";
      value: PersonId;
    }
  | {
      kind: "person_id_array";
      attribute: string;
      operator: "has_any" | "has_all" | "has_none";
      value: NonEmptyArray<PersonId>;
    }
  | {
      kind: "string_array";
      attribute: string;
      operator: "has";
      value: NonEmptyString;
    }
  | {
      kind: "string_array";
      attribute: string;
      operator: "has_any" | "has_all" | "has_none";
      value: NonEmptyArray<NonEmptyString>;
    }
  | {
      kind: "presence";
      attribute: string;
      operator: "exists" | "not_exists";
    };
```

V1 uses disjunctive normal form—`anyOf` groups of `allOf` leaves—instead of an
arbitrarily recursive provider schema. It covers the current connector intents,
keeps the advertised schema within the repository's provider-schema complexity
budget, and makes evaluation deterministic. The internal Zod parser first
discriminates on `kind`, then on that kind's `operator`; it does not attempt one
`z.discriminatedUnion("kind", ...)` whose repeated literals throw when the Zod
4 parser first builds its discriminator map.
The provider-facing leaf schema is structural and flat, while the executor's
strict contextual parse produces the branded union above and rejects every
illegal kind/operator/value combination. `presence.not_exists` is the sole
missing-field test. Every other positive or negative leaf returns false when
its attribute is missing. String operations, including `contains`, are
case-sensitive; the `foobar` conformance case intentionally does not match
`Foobar`.

#### Automation architect evaluator tool

The `rally_automation_architect` plugin adds one model-visible tool whose short
name is `set_evaluator_rules` and whose provider wire name is
`automation_set_evaluator_rules`. The tool authors the external-event portion
of the current draft; it does not write WorkspaceDO registrations or accept an
automation. Its harness definition is:

```ts
const AUTOMATION_SET_EVALUATOR_RULES_TOOL = {
  name: "set_evaluator_rules",
  description:
    "Replace the complete external-event evaluator rule set staged for the " +
    "current automation draft. Use [] to clear it. Inspect every named plugin " +
    "first, and use only event types, event families, resources, fields, and " +
    "operators that inspection declared.",
  capability: "rally.automation.evaluators.set",
  mode: "write",
  idempotency: "record_before_execute",
  inputSchema: AutomationSetEvaluatorRulesInputV1JsonSchema,
} satisfies ToolDefinition;
```

The model supplies authoring keys and inspected source vocabulary, never
host-minted automation, registration, connection, generation, version, hash,
or event-sequence identities. Canonical person and resource IDs are allowed
only when returned by the host resolver tools:

```ts
type AutomationSetEvaluatorRulesInputV1 = {
  schemaVersion: 1;
  evaluators: DraftExternalEventEvaluatorV1[]; // empty is an explicit clear
};

type DraftExternalEventEvaluatorV1 = {
  evaluatorKey: DraftEvaluatorKey;
  source: {
    sourceBindingKey: ActivitySourceBindingKey;
    suggestedSourcePluginId: ModelPluginId;
    event:
      | { kind: "event_type"; eventType: ConnectorEventType }
      | { kind: "event_family"; eventFamily: ConnectorEventFamily };
    resourceId?: ResourceId;
  };
  when: ExternalEventPredicateV1;
};

type AutomationSetEvaluatorRulesResultV1 = {
  accepted: true;
  evaluators: Array<{
    evaluatorKey: DraftEvaluatorKey;
    expandedEventTypes: NonEmptyArray<ConnectorEventType>;
  }>;
};
```

`DraftEvaluatorKey` is a bounded non-empty stable key unique within the
submitted set. It is a model-authored reference such as `github_pr_merged`, not
a UUID and not storage authority. The host derives canonical evaluator IDs from
the AutomationAgent ID, accepted definition revision, authoring key, and exact
expanded event type. The host also supplies the automation ID, author,
workspace, region, authority generation, projection version, resolved
connection ID, and payload hash; none is accepted from tool arguments.

The tool uses complete-replacement semantics. At compiler-run admission the
staged set starts as the latest compiled definition's evaluator set in authoring
shape, or empty for the first run. Every successful call supersedes that set,
and `evaluators: []` is the only explicit tool-level clear operation. A
recovered call replays its durable tool receipt and returns the same result. It never appends implicitly,
because an append API would retain rules the architect stopped mentioning and
make it impossible to distinguish a retry from a second desired rule. More than
one successful call in a compiler run is allowed so the architect can revise
its work; only the latest successfully validated set may be submitted. The
model-visible result does not expose an internal staged-set revision or payload
hash that no subsequent model action consumes.

The architect must successfully call `automation_set_evaluator_rules` before
the first external-event submission and whenever it changes those rules. A
later compiler run may submit the unchanged inherited authoring set without
re-staging it, so answering an elicitation cannot silently reconstruct reviewed
predicates from prose. A definition containing only manual or timer triggers
needs no empty tool call: `automation_submit_draft` atomically clears the prior
evaluator set because the submitted definition has no external-event trigger.
`automation_submit_draft` references evaluator keys from the latest staged set;
it does not carry `deterministicFilters`, `deterministicPrefilter`, raw evaluator
JSON, canonical IDs, or projection metadata. For a `ready = true` draft, the
host requires an exact correspondence between every external-event trigger and
the referenced staged evaluator keys, rejects unused evaluators, and rejects a
trigger whose keys span incompatible source bindings. A `ready = false` draft
may stage an empty or incomplete set, but it cannot be accepted or projected.
Resource-watch registrations synthesized from authoritative watched links do
not pass through this model tool and cannot acquire a custom predicate through
it.

The first parser is the strict, non-recursive Zod schema advertised to the provider;
the tool's `validateInput` hook runs both that structural parse and the frozen-
manifest contextual parse so every correctable rejection occurs before Bind
plans the `record_before_execute` write. A second contextual parser uses only the
frozen manifests of plugins successfully loaded and inspected in the current
compiler run. The run ledger records load and inspect separately; inspection is
not inferred from loading. The parser expands an event family to its declared exact event types and
rejects unknown or duplicate keys, sources, resources, families, event types,
attributes, operators, and person IDs. It also rejects a field kind/operator
combination that the exact event descriptor does not allow. It does not accept
a raw object through a type assertion or silently remove an illegal leaf.

A successful tool call durably records its provider-call receipt and run-scoped
staged set in AutomationAgent SQLite. It performs no connector RPC, Queue send,
timer arm, or WorkspaceDO write. `automation_submit_draft` atomically promotes
the latest staged set and submitted definition into one new canonical compiled
definition revision, or binds an empty evaluator set when the definition has no
external-event trigger; a crash before submission leaves only resumable
compiler-run state, not a half-updated definition. Acceptance later resolves
each binding to an authorized connection, repeats contextual parsing against
the frozen accepted manifest revision, mints the authoritative envelope shown
above, and projects it through the receipt-backed WorkspaceDO path.

#### Complete draft-state agent tool surface

Durable draft authoring adds three automation tools, changes two existing ones,
and makes connector execution read-only. The plugin catalog is complete below,
including the four shared attachment readers.
“Default” timeout means the configured Bind tool timeout with no per-tool
override; this PRD does not invent another numeric ceiling.

| Provider name | Capability | Mode / idempotency | Timeout | `serial` | Draft behavior |
| --- | --- | --- | --- | --- | --- |
| `list_plugins` | `rally.plugins.list` | read / safe | default | no | Unchanged generic frozen-scope discovery. |
| `search_plugins` | `rally.plugins.search` | read / safe | default | no | Unchanged ranked generic discovery. |
| `load_plugin` | `rally.plugins.load` | read / safe | default | yes, by wire name | Loads only the plugin's permitted read executors; loading grants no new authority. |
| `automation_plugins_list` | `rally.automation.plugins.list` | read / safe | default | no | Unchanged compact authorized automation catalog. |
| `automation_plugins_search` | `rally.automation.plugins.search` | read / safe | default | no | Unchanged ranked automation-catalog search. |
| `automation_plugin_inspect` | `rally.automation.plugins.inspect` | read / safe | default | no | Changed output: returns trusted tool schemas plus `ConnectorActivityTriggerDescriptorV2`, including event families, legal resource relationships, field kinds, legal operators, and `person_id`/`person_id_array` fields. The run records inspection separately from loading. |
| `automation_people_search` | `rally.automation.people.search` | read / safe | default | no | New host-owned directory resolver returning canonical person IDs the evaluator tool may use. |
| `automation_resources_search` | `rally.automation.resources.search` | read / safe | default | no | New host-owned authorized-resource resolver returning canonical resource IDs and their source binding/plugin relationship. |
| `automation_read_resource` | `automation.attachments.read` | read / safe | default | no | Shared attachment read within the frozen draft scope. |
| `automation_search_resource` | `automation.attachments.search` | read / safe | default | no | Shared attachment search within the frozen draft scope. |
| `automation_view_resource` | `automation.attachments.view` | read / safe | default | no | Shared attachment preview within the frozen draft scope. |
| `automation_summarize_resource` | `automation.attachments.summarize` | read / safe | default | no | Shared attachment summary within the frozen draft scope. |
| `automation_set_evaluator_rules` | `rally.automation.evaluators.set` | write / record-before-execute | default | yes, by write mode | Complete-replaces the inherited run-scoped evaluator set without creating a definition revision. |
| `automation_submit_draft` | `rally.automation.submit` | write / record-before-execute | default | yes, by write mode | Writes or reuses one compiled definition revision and binds the staged evaluator set. |
| `core_request_elicitation` | `elicitation.write` | write / record-before-execute | default | yes, by write mode | The automation host declares its own definition, separate from the provider-keyed work-stream constant; it creates a pending elicitation only after a partial definition and halts `needs_input`. |
| `core_current_time` | `time.read` | read / safe | default | no | Unchanged authoritative time and timezone read. |

The shared request-scoped attachment readers and web research readers remain
unchanged. Loaded connector read tools remain executable for resolving current
provider context. Connector write schemas remain visible through inspection so
the architect can propose accepted-run capabilities, but their executors are not
installed during draft compilation. The architect has no draft-state tool for
acceptance, lifecycle mutation, schedule installation, evaluator registration,
route claiming, generated-run creation, delivery, or any provider write.

The changed write definitions are:

```ts
const AUTOMATION_SET_EVALUATOR_RULES_TOOL = {
  name: "set_evaluator_rules",
  description:
    "Replace all external-event rules for this draft. Search for people and " +
    "resources and inspect each named plugin first. Pass [] only to clear all rules.",
  capability: "rally.automation.evaluators.set",
  mode: "write",
  idempotency: "record_before_execute",
  inputSchema: AutomationSetEvaluatorRulesInputV1JsonSchema,
} satisfies ToolDefinition;

const AUTOMATION_SUBMIT_DRAFT_TOOL = {
  name: "submit_draft",
  description:
    "Save the best current automation definition. Set ready=false when a " +
    "blocking choice remains, then call core_request_elicitation.",
  capability: "rally.automation.submit",
  mode: "write",
  idempotency: "record_before_execute",
  inputSchema: AutomationDraftSubmissionV2JsonSchema,
} satisfies ToolDefinition;
```

Bind already executes writes serially in model-declared order, so neither write
sets the `HarnessTool.serial` field. `load_plugin` remains the one serial read,
selected by wire name. The automation host does not mutate the shared provider-
keyed `AVALON_REQUEST_ELICITATION_TOOL_DEFINITION`; it declares a host-specific
definition with the same provider name and capability and a reconciled local
executor.
If the model emits set and submit in the same turn, Bind executes set first when
that is the declared call order; submit is rejected when no compatible staged or
inherited set exists. Both local mutations plan with `record_before_execute`,
then commit the AutomationAgent state change and terminal Bind receipt in one
SQLite transaction. The admitted compiler run ID and provider-call coordinates
are stable across HTTP recovery. A settled coordinate replays exactly; a planned
but unsettled coordinate reconciles by its mutation/input hash before execution;
and a coordinate collision with different input fails closed. If Stop or the
existing tool timeout interrupts a planned local write, Bind classifies it as
`ambiguous_external_write` and ends the run. On the next compiler turn,
AutomationAgent reconciles the plan by its stable run coordinate and canonical
input hash before permitting a new call; the terminal classification is not a
model-visible retry instruction.

A new rules call complete-replaces the staged set. A new submission whose
canonical definition and evaluator-set hashes equal the latest compiled
revision is a no-op returning the persisted result; different input creates the
next compiled revision. Neither tool accepts a client-supplied draft revision,
transcript head, automation ID, authority generation, source version, payload
hash, connection ID, registration ID, or event-sequence boundary.

The two resolver reads have strict shapes:

```ts
type AutomationPeopleSearchInputV1 = { query: NonEmptyString };
type AutomationPeopleSearchResultV1 = {
  matches: Array<{ personId: PersonId; displayName: NonEmptyString }>;
};

type AutomationResourcesSearchInputV1 = {
  query: NonEmptyString;
  suggestedSourcePluginId?: ModelPluginId;
};
type AutomationResourcesSearchResultV1 = {
  matches: Array<{
    resourceId: ResourceId;
    displayName: NonEmptyString;
    sourceBindingKey: ActivitySourceBindingKey;
    suggestedSourcePluginId: ModelPluginId;
    relationship: ConnectorResourceRelationship;
  }>;
};
```

Both reject unknown fields. An empty result tells the architect to inspect/load
the relevant plugin or ask the person; multiple matches are returned for the
architect to disambiguate, never guessed. IDs are valid only in the current
frozen workspace/run scope and are contextually reauthorized by
`set_evaluator_rules`.

`AutomationDraftSubmissionV2` removes raw activity filters and removes
`followUpQuestion` and `elicitation` as writable definition fields. Manual,
calendar, and interval trigger shapes remain. Every connector activity,
semantic-activity, resource-specific activity, or webhook trigger is represented
by the one external-event form:

```ts
type DraftExternalEventTriggerV2 = {
  type: "external_event";
  evaluatorKeys: NonEmptyArray<DraftEvaluatorKey>;
  summary: NonEmptyString;
};

type AutomationDraftSubmissionV2 = {
  name: NonEmptyString;
  description: NonEmptyString;
  overview: NonEmptyString;
  instructions: NonEmptyString;
  triggers: NonEmptyArray<
    ManualTrigger | CalendarTrigger | IntervalTrigger |
    DraftExternalEventTriggerV2
  >;
  requiredCapabilities: string[];
  expectedOutputs: string[];
  requestedDelivery: AutomationRequestedDelivery[];
  defaultBehavior: AutomationDefaultBehavior;
  recommendedPlugins: AutomationPluginRecommendation[];
  memoryTables: AutomationMemoryTableDefinition[];
  suggestedScope: AutomationScope;
  ready: boolean;
};

type AutomationSubmitDraftResultV2 = {
  accepted: true;
  definitionRevision: AutomationDefinitionRevision;
  ready: boolean;
};
```

The field bounds and defaults remain those in the current strict
`AutomationDraftSchema`; the implementation moves them into a V2 schema rather
than restating different numbers here. Unknown fields are rejected.
`followUpQuestion`, `elicitation`, raw filters, semantic conditions, canonical
authority fields, and revision inputs are forbidden. Replay returns the
persisted output above.

The evaluator keys name rules in the latest staged set and are presentation
references, not authority. `summary` is the concise human-readable trigger shown
on review; it is never evaluated. A ready submission must reference every staged
evaluator exactly once across its external-event triggers and may reference
nothing else. A partial submission may retain an incomplete mapping for review
and elicitation but cannot be accepted or projected. A submission with no
external-event trigger atomically binds an empty evaluator set, so editing an
event-driven draft into a manual/timer-only draft cannot leave a hidden rule.

`core_request_elicitation` is refused unless the latest revision submitted in
that run has `ready = false`. Acceptance is refused while any elicitation for
the current revision is pending. An elicitation answer names that pending ID and
becomes a new human turn; replacing or settling the elicitation makes an old
answer terminally stale.

The durable tool order for a compiler run is:

```text
catalog and attachment reads
  -> search people/resources, load and inspect named plugins, use provider reads
  -> automation_set_evaluator_rules, for new or changed external events
  -> automation_submit_draft
       ready = true  -> halt completed
       ready = false -> core_request_elicitation -> halt needs_input
```

Discovery and provider reads may share a narrated research turn. Turns that
call `set_evaluator_rules`, `submit_draft`, or `request_elicitation` contain no
assistant narration. A validation rejection is returned through the existing
correctable tool-error path and may be repaired with a new provider call; it
does not erase the last canonical compiled definition revision or show schema
details to the person.

Stable tool failures use the existing typed Bind failure envelope:

| Code | Model-visible next action |
| --- | --- |
| `automation_plugin_not_inspected` | “Inspect the named plugin, then rebuild the rule from its declared events and fields.” |
| `automation_person_not_found` | “Search the workspace directory with `automation_people_search`; do not invent a person ID.” |
| `automation_resource_not_found` | “Search authorized resources with `automation_resources_search`; do not invent a resource ID.” |
| `automation_evaluator_invalid` | “Correct the named field/operator or source using the inspected descriptor, then replace the complete set.” |
| `automation_evaluator_set_missing` | “Set the external-event rules, then submit the draft again.” |
| `automation_elicitation_requires_partial` | “Submit the best current definition with `ready=false`, then request elicitation.” |
| `automation_pending_elicitation` | “Wait for or answer the pending question before acceptance.” |

That AutomationAgent-owned envelope is one publisher's wire contract, not a
reason to build an automation-only matcher. WorkspaceDO compiles every accepted
automation evaluator and every watched work-stream resource link into the same
internal registration shape:

```ts
type WorkspaceExternalEventRegistrationV1 = {
  registrationId: WorkspaceExternalEventRegistrationId;
  authorityGeneration: ExternalEventAuthorityGeneration;
  projectionVersion: ExternalEventProjectionVersion;
  sourceHash: CanonicalPayloadHash;
  effectiveAfterEventSequence: WorkspaceConnectorEventSequence;
  evaluator: ExternalEventEvaluatorV1;
  destination:
    | {
        kind: "automation";
        automationId: AutomationId;
      }
    | {
        kind: "workstream_resource_update";
        workstreamId: WorkstreamId;
        substreamId: SubstreamId;
        resourceId: ResourceId;
      };
};
```

The publisher does not choose `effectiveAfterEventSequence`. WorkspaceDO assigns
the current canonical event high-water when it first installs a new registration
generation or evaluator revision, stores it beside the validated registration,
and returns it in the acknowledgement. An idempotent replay of the same
`(authorityGeneration, projectionVersion, sourceHash)` retains the original
boundary rather than moving it forward. Every
registration in one complete automation snapshot receives the same boundary.

The internal type is produced only by the registry-aware compiler and is never
accepted directly from a request. For an automation, it preserves the authored
typed predicate. For a work-stream resource watch, the
existing versioned resource-link effect is the registration boundary:
`watchEnabled = true` compiles to the exact resource/connection/event source,
`when = always`;
`watchEnabled = false`, link removal, archival, or a new authority generation
removes or supersedes that registration. A connector that can report several
legal update event types produces one registration per exact event type. The
registration and evaluator identities are deterministic from the watched-link
identity, destination generation, and event type, so projection replay cannot
mint a second route. The watch may not add an arbitrary predicate because the
person's decision was to receive updates for that named resource, not to create
a second hidden automation.

WorkstreamDO/SubstreamAgent remains canonical for the attachment and whether it
is watched. Its existing durable child-to-parent-to-WorkspaceDO resource-link
projection supplies resource ID, watch flag, source version, authority
generation, and hash. For this shared registration contract that source version
is `projectionVersion`; both publishers therefore supply the same top-level
`(authorityGeneration, projectionVersion)` coordinate. WorkspaceDO validates the projected resource against its
canonical resource/connection record and connector manifest before indexing the
registration. No request toggles a child flag and writes an evaluator row as one
pretended cross-object transaction; projection replay and same-version hash
fences reconcile the two authorities.

The TypeScript aliases illustrate the contract; checked-in strict Zod schemas
are the runtime authority. Every object rejects unknown keys. Empty strings,
empty groups, empty operator lists, duplicate evaluator IDs, duplicate source
tuples, non-finite numbers, and invalid revision or generation identities are
structurally invalid. The stateful receiver orders projections lexicographically
by `(authorityGeneration, projectionVersion)`: a higher generation always
supersedes an older one, while projection version is monotonic only within one
generation. Reuse of that exact coordinate with a different hash is an integrity
failure. One typed predicate produces `match` or `no_match`; an
`always` predicate is the explicit unconditional match. There is no general
`not` node; negative leaf operators preserve the field's type, and the explicit
presence leaf is the only way to match a missing value.

All string comparison is case-sensitive and performs no trimming, locale
folding, parsing, or scalar-to-array coercion. Except for `presence`, a missing
attribute makes every leaf predicate false, including `not_equals`, `not_in`,
and `has_none`; missing data never turns an exclusion into a match. A DNF group
matches when every `allOf` leaf matches, and the predicate matches when at least
one `anyOf` group matches. The evaluator is run once against one immutable event
context and one immutable evaluator revision.

Structure alone cannot prove that an attribute belongs to a dynamically
registered connector event. Registration therefore has a second contextual
parser. For each evaluator it resolves the exact connector manifest and rejects
the snapshot unless:

- the connector, connection, and event type exist, agree with one another, and
  are in the automation's frozen accepted bindings;
- an optional resource exists in WorkspaceDO, belongs to that connection, and
  is a legal resource target for the event;
- every attribute is declared in that event type's
  `ConnectorActivityTriggerDescriptorV2.filterFields`;
- for every value-bearing leaf kind, predicate `kind` equals the field's
  declared `valueType` and the selected operator is legal; a `presence` leaf is
  legal against any declared field whose operator list includes `exists` or
  `not_exists`; and
- the same automation generation has not already supplied the same projection
  version with a different canonical payload hash.

The successful result is a branded `ValidatedExternalEvaluatorSet`, and
internal compilation, persistence, projection, and evaluation APIs accept that
type rather than the raw wire type. Serialization erases the brand, so the
receiver parses again. Structural and manifest-context validation occur at the
model tool boundary; acceptance revalidates while resolving proposed bindings
to authoritative connections; WorkspaceDO parses the projection RPC; and each
object parses serialized evaluator rows when hydrating them from SQLite. Inside
one of those typed call paths, branded values are not parsed again before every
helper, write, or predicate evaluation. A malformed stored row is an integrity
failure and fail-closed registration, never an empty filter or a permissive
fallback.

Normalized connector events retain their existing broader canonical evidence,
but evaluation sees a separate closed context containing only fields declared
for that exact connector event type. The connector normalizer creates that
context, and WorkspaceDO parses it against the same manifest descriptor at
ingress and again when loading it for processing. Evaluators cannot use dotted
paths or spread arbitrary `metadata`, `subject`, `actor`, or provider payload
into their context.

A connector may deliberately declare a bounded normalized content field such as
Slack `messageText: string`. That declaration is reviewed connector code, not a
path supplied by the architect. It identifies the field as sensitive evaluator
input, permits the ordinary type-compatible string operators such as
case-sensitive `contains`, and keeps the value regional and out of evaluator
projections, indexes, receipts, logs, telemetry, and Queue messages. WorkspaceDO
reads it only from the canonical event while evaluating. Raw bodies and an
entire Granola or Notion transcript are never evaluator context merely because a
substring operator exists.

The connector field vocabulary expands beyond today's scalar types with
`person_id` and `person_id_array`. Their values are canonical Rally person IDs
resolved from the event's verified external identities. Rules select a person
through the directory and store that ID; they never freeze a mutable display
name or put an email address into evaluator configuration. An unresolved or
ambiguous person cannot be accepted for a person predicate. A later event with
no verified mapping simply lacks that person ID and does not match.

Resource relationships are source selectors rather than string predicates.
WorkspaceDO derives a closed `relatedResourceIds` set by resolving the event's
manifest-declared provider entity and parent keys against canonical workspace
resources. The optional `source.resourceId` matches membership in that set. This
one mechanism represents “in this Linear project,” “in this Granola folder,”
“in this GitHub repository,” and “on this Notion page” without comparing names,
URLs, or provider-specific IDs in generic rules. A connector must declare and
normalize the relationship before the architect may propose it.

Connector manifests may also declare named event families such as
`slack.message.created` or `notion.page.updated`. A family is a strict non-empty
set of event types already declared by that same manifest. It is authoring
vocabulary only: acceptance records the manifest revision and expands the family
to one exact-source evaluator per current event type. Adding an event type to the
family later does not silently broaden an accepted automation; adoption creates
a reviewed definition revision. Wildcard prefixes and regular expressions over
event type names are illegal.

`automation_plugin_inspect` projects the manifest through this required
descriptor extension rather than calling the existing descriptor unchanged:

```ts
type ConnectorActivityTriggerDescriptorV2 = {
  eventType: ConnectorEventType;
  label: string;
  description: string;
  eventFamilies: ConnectorEventFamily[];
  filterFields: Array<{
    key: string;
    label: string;
    description: string;
    valueType: "string" | "number" | "boolean" | "string_array" |
      "person_id" | "person_id_array";
    operators: NonEmptyArray<ExternalEventOperator>;
    sensitive: boolean;
  }>;
  resourceRelationships: Array<{
    relationship: ConnectorResourceRelationship;
    resourceType: ResourceType;
  }>;
};
```

`DraftExternalEventEvaluatorV1.attribute` resolves to the descriptor's `key`.
`presence` is a predicate kind, not a field value type: it may target any field
that explicitly advertises `exists` or `not_exists`. V2 extends the current
descriptor and preserves its `key`, `label`, and `description` fields so current
inspection guidance does not regress.

Families, relationships, field kinds, and operators are connector-authored
closed values. `plugin_inspect` returns them only for the frozen manifest
revision recorded in the run, and `set_evaluator_rules` accepts no value absent
from that inspection result.

If a webhook does not carry a required field or relationship, the connector may
perform one authorized bounded enrichment during normalization before the
canonical event commits. It may not fetch once per evaluator. Until the
normalizer can reliably populate and parse that context, draft review names the
trigger as unsupported and acceptance refuses it rather than installing a rule
that can never match.

The required conformance vocabulary is:

| Product intent | Accepted exact event expansion | Resource selector and predicate |
| --- | --- | --- |
| New message in a Slack channel | `slack.message.posted`, `slack.message.replied` from declared family `slack.message.created` | selected `slack_channel` resource; `always` |
| New Slack message containing `foobar` | same family | selected channel when named; `messageText contains "foobar"` |
| A selected Linear project changes | `linear.project.update` and `linear.project.remove` from declared family `linear.project.changed` | selected `linear_project` resource; `always` |
| A ticket in a Linear project changes | `linear.issue.create`, `linear.issue.update`, and `linear.issue.remove` from declared family `linear.issue.changed` | selected parent `linear_project` resource through the issue's normalized project relation; `always` |
| A new Granola transcript is added | `note.generated` | `always` |
| A new Granola transcript is added to a folder | `note.generated` | selected `granola_folder` resource through normalized folder relations; `always` |
| A selected person has a new Granola transcript | `note.generated` | `participantPersonIds has <PersonId>` |
| Any pull request is merged in a repository | `github.pull_request.merged` | selected `github_repository` resource; `always` |
| A new pull request is opened in a repository | `github.pull_request.opened` | selected repository; `always` |
| A release is made for an application | `github.release.published` after review resolves “made” to published rather than draft-created | repository resource bound to the application; `always` |
| A new repository is created | `github.repository.created` | connection only because the repository resource does not exist before this event; `always` |
| A new Notion page is created | `notion.page.created` | connection, or selected parent page/data source when named; `always` |
| A Notion page is updated | `notion.page.content_updated` and `notion.page.properties_updated` from declared family `notion.page.updated` | selected `notion_page` resource when named; `always` |
| A selected person comments on any Notion page | `notion.comment.created` | `authorPersonIds has <PersonId>` |
| A selected Notion page receives a comment | `notion.comment.created` | selected parent `notion_page` resource; `always` |

These rows are acceptance requirements, not claims about today's descriptors.
The current Slack descriptor lacks `messageText`; Linear lacks the typed parent
project/change vocabulary; Granola lacks folder and participant-person fields;
and Notion lacks canonical author-person fields. Those manifest/normalizer
changes must land before the corresponding trigger is advertised or accepted.
GitHub already declares the named event types and repository field, but the
repository relationship still compiles to the canonical resource selector so a
rename does not alter the rule.

The same rule shape also supports a precise Linear state transition once its
descriptor declares `changedFields: string_array`, `previousStateId: string`,
and `stateId: string`:
one `allOf` group containing `changedFields has "stateId"` and
`stateId equals "<accepted-state-id>"`.
The accepted state ID is a frozen configuration value, not a display name
resolved differently on each event.

The deterministic grammar borrows Cloudflare Flagship's
[nested typed conditions](https://developers.cloudflare.com/flagship/targeting/),
[type-specific operators and missing-attribute behavior](https://developers.cloudflare.com/flagship/targeting/operators/),
and guidance to use a
[stable evaluation context and safe fallback](https://developers.cloudflare.com/flagship/best-practices/).
It intentionally does not copy Flagship's ordered first-match rule program or
percentage rollout. Every trigger required here is one typed boolean predicate;
priority, per-rule results, and random event loss add machinery without adding a
requested behavior. Natural-language semantic evaluation is likewise outside
V1. If a future trigger cannot be represented by reviewed connector fields,
adding a model-evaluated gate is a separate product, cost, privacy, and retry
decision rather than an optional branch in every evaluator.

Flagship's own numerical rule and nesting limits are platform constraints, not
Rally product requirements, so this PRD does not copy their values. If the
implementation adds a predicate-depth, rule-count, or payload-size ceiling for
resource safety, that ceiling and its refusal behavior require the repository's
separate defensive-limit decision; it cannot appear as an unexplained schema
number.

For a watched work-stream resource, the intended end-to-end event chain is a
fixed product contract:

`provider → connector ingress → WorkspaceDO → regional Queue → work-stream
authority → transcript/WebSocket`

The watch's control path is separate and runs in the other direction:
WorkstreamDO/SubstreamAgent commits the authoritative resource link and watch
flag, then its durable projection/outbox supplies WorkspaceDO with the resource
identity, watch state, source version/hash, and work-stream authority
generation. WorkspaceDO compiles that intent into the same internal evaluator
registration used by automation destinations. The work stream does not author
an evaluator: it owns only “this attached resource is watched,” while
WorkspaceDO owns the canonical resource-to-connection binding and connector
manifest needed to derive exact event types and relationships.

Each event-chain hop has one responsibility:

- The provider supplies a webhook event, or is read by connector polling owned
  and scheduled by WorkspaceDO.
- Connector ingress verifies provider authenticity, applies any single bounded
  enrichment, normalizes the event and its audience/resource relationships,
  calls WorkspaceDO to durably accept the event and allocate its sequence, and
  only then publishes the returned event ID to the regional Queue. It never
  calls a work stream or appends transcript content.
- WorkspaceDO is the canonical normalized-event authority. It deduplicates the
  event, parses its closed evaluation context, selects and evaluates exact
  registrations, and atomically records destination-specific delivery receipts.
  It returns their opaque IDs to the regional consumer that already owns the
  current connector-event Queue attempt. Its projections can locate a work
  stream but cannot authorize permanent content injection.
- The regional Queue carries an ID-only wake-up for the committed delivery. It
  owns transport retry, not event content, evaluator truth, destination
  authorization, or delivery completion.
- The destination adapter reloads the receipt and event from WorkspaceDO, then
  invokes the named work-stream authority through a typed port. The current
  WorkstreamDO/SubstreamAgent state must re-prove attachment, enabled watch,
  authority generation, target lifecycle, and complete participant audience;
  stale WorkspaceDO registration state can cause a harmless wake-up but never
  an append.
- The work-stream authority idempotently commits one `connected_activity`
  system turn through the ordered-transcript substrate. Only after that commit
  does it publish the ordinary transcript event over the existing WebSocket;
  neither Queue acknowledgement nor socket publication is the canonical write.

Webhook and polling connectors converge at connector ingress. A poll handler
may produce a normalized event but may not bypass WorkspaceDO evaluation or
append directly to a work stream. Likewise, adding a watched event to the
transcript does not by itself admit a Bind run; automatic action uses an
automation evaluator destination through the parallel AutomationAgent branch.

WorkspaceDO owns the evaluation and receipt transaction boundary. The regional
consumer owns the subsequent Queue publication boundary:

```text
verified provider event or poll
  -> WorkspaceDO canonical event + parsed evaluation context
  -> exact (connectionId, eventType, optional resourceId) registrations
  -> deterministic typed predicate evaluation
  -> WorkspaceDO durable delivery receipts
  -> current connector-event Queue consumer publishes receipt IDs
  -> regional Queue ID-only wake-up
  -> destination adapter
       automation: typed AutomationAgent.deliverExternalEvent
       resource watch: audience recheck + typed SubstreamAgent append
  -> WorkspaceDO destination receipt settlement
```

The wake-up contains opaque workspace event, registration, destination, revision,
and delivery-receipt identities plus a canonical hash, not the event body. A
consumer loads the still-authoritative delivery and event from WorkspaceDO,
then invokes the typed adapter named by the stored destination. The receipt is
unique for the workspace event, registration ID and generation, and destination
identity, while also pinning the canonical event sequence, evaluator source
version/hash, and registration boundary; Queue redelivery cannot create a
second automation occurrence or work-stream update.
Several registration receipts for the same automation and event may exist for
diagnostics, but AutomationAgent's occurrence uniqueness collapses them to the
single `(automationId, workspaceEventId)` run.

An automation destination receives the pointer and loads its authoritative
trigger evidence from WorkspaceDO through a typed port after admission. A
work-stream destination first loads the current SubstreamAgent resource link,
watch flag, authority generation, and audience, then requires the event audience
to contain every active participant; the WorkspaceDO resource index is never
sufficient authorization. The adapter then loads the bounded title, summary,
provider, event type, and canonical resource identity from WorkspaceDO and
idempotently appends one `connected_activity`
system message using a client message identity derived from the workspace event
and registration. It publishes the ordinary ordered-turn event only after that
canonical append commits. A duplicate append returns its existing receipt and
allows the WorkspaceDO delivery receipt to settle without publishing twice.

An audience refusal, archived/deleted target, detached resource, disabled watch,
or stale authority generation is a terminal `not_delivered` receipt with a safe
reason code, not an append and not an infinite retry. Queue is the sole
transport retry owner. If publishing a receipt ID fails, the consumer does not
settle its existing connector-event processing message; retry reloads the same
idempotent receipts and republishes their IDs. If the destination call fails
transiently, the delivery message retries. If the destination commits and the
consumer fails before settling WorkspaceDO, redelivery observes the target's
idempotent receipt and then settles the WorkspaceDO receipt. WorkspaceDO does
not add an outbox alarm for this already-queued path. Exhausting the Queue's
configured attempts is a terminal transport failure visible in the existing
DLQ; the WorkspaceDO receipt remains failed and is replayable through the
existing operator Queue/DLQ procedure. There is deliberately no second
automatic sweep, and activation acknowledgement is not a promise that every
future Queue delivery succeeds. An evaluator or watch
update does not silently replay old events under new rules; an explicit replay
operation would be a separate product and authorization decision.

Timer triggers use none of this path. Calendar and interval definitions are
parsed into the accepted AutomationAgent definition, including an explicit or
authoritatively resolved IANA timezone, and produce object-local scheduled alarm
entries. “Every weekday at 9am Pacific” is therefore calculated and admitted by
the AutomationAgent that owns the automation. WorkspaceDO neither receives a
timer evaluator nor wakes the object for that occurrence.

A connector poll needed to observe changes to a watched resource is different
from an automation timer. It remains WorkspaceDO-owned connector-ingestion work
and uses that object's existing multi-alarm scheduling and provider checkpoint.
Its normalized result re-enters the same canonical event/evaluator path as a
webhook; it does not append directly to a work stream from the poll handler.

### Workspace surfaces and projections

WorkspaceDO stores the minimum projections needed to answer workspace-shaped
questions without waking every automation or watched work stream:

- the automation sidebar entry visible to each viewer;
- monotonic lifecycle, title, scope, badge, and next-run summary fields;
- a hidden content-free generated-work-stream reader projection used for paged
  run-list filtering but never returned by the general sidebar/directory API;
- automation-level attention items for generated runs awaiting input;
- complete, generation-fenced automation evaluators and watched work-stream
  resource-link registrations in one exact connection/event/resource candidate
  index; and
- the authority version and typed destination identity needed for routing.

The AutomationAgent publishes its projections through a durable outbox.
Watched resource-link state follows the existing SubstreamAgent -> WorkstreamDO
-> Queue -> WorkspaceDO effect path. WorkspaceDO applies both idempotently and
monotonically and compiles them through the same registration boundary.
Projection failure may delay a sidebar summary, automation event, or resource
update but cannot roll back or mutate either source authority. The automation
overview and every write read the object directly. Before disclosing sensitive
configuration or generated content, the serving path rechecks the current
authoritative object and, for generated content or a connected-activity append,
the owning SubstreamAgent's reader audience rather than trusting a possibly
stale workspace projection.

Shared template discovery remains in WorkspaceDO. Starting from a template
copies its effective immutable definition into a new AutomationAgent. Publishing
an automation exports an immutable version to the catalog; accepted automations
do not retain a live private-template relationship or an “update available”
join back to WorkspaceDO.

Generated automation work streams publish no global-sidebar or general
work-stream-directory listability, even though their hidden reader projection,
WorkstreamDO, and SubstreamAgent authority remain intact. AutomationAgent's object-local
`automation_run` rows are the paged source for the automation home: trigger,
planned/started/completed time, execution/attention/delivery summaries, and the
opaque child work-stream link. To keep the projection content-free, the list no
longer displays the child's title, result summary, participants, or participant
avatars; those appear only after drill-in. Before returning a page, the serving
path filters its child IDs through WorkspaceDO's hidden current-reader
projection. Opening a row resolves that named child and
performs current SubstreamAgent reader admission before returning transcript
bounds or content. The run list is therefore cheap and content-free; the
occasional drill-in remains authoritative and cannot be authorized by a stale
parent or WorkspaceDO summary.

### Offline and reconnect behavior

Unsent composer text continues to follow the desktop's existing local composer
draft behavior. Once the API has admitted a turn, it is server-owned work and
continues without the window. Reconnect never converts an uncertain submission
into a new automation. For the first prompt, the API resolves the stable client
creation key to the server-minted AutomationAgent ID and then resolves the client
message ID; for a later prompt, the client already names the AutomationAgent.
Either path observes the admitted turn or safely retries that same admission.

## Impact on the product contract

This PRD amends the implementation brief's automation-run clause: every
*admitted* run still owns exactly one work stream, but a scheduled occurrence is
admitted and creates that work stream at its due time rather than pre-opening a
planned child. The change removes speculative empty children while preserving
the run/work-stream ownership boundary.

The visible changes are explicit: a failed first compiler turn is returnable; an
admitted compiler run survives navigation and can be stopped; concurrent windows
cannot replace one another's conversation; the draft feed uses the shared
ordered transcript; generated runs move from the global work-stream sidebar to
a content-free paged list on their automation home; run-list titles, summaries,
and avatars move behind drill-in; resuming an accepted automation visibly
passes through reactivation; shared templates no longer advertise later updates to an
accepted automation; and deleting an automation warns that its generated run
work streams are deleted with it. `You`/`Workspace` scope badges, generated
work-stream privacy, and typed authorized tool execution remain unchanged.

Selecting **New automation** is deliberately not one of those changes. It still
opens an unpersisted screen and does not add a sidebar item. Durability begins
when the person sends the first prompt; from that admission onward, even a
failed first compiler attempt is returnable.

The cutover deliberately removes any pre-cutover internal drafts instead of
migrating them. That is a one-time deployment decision enabled by the absence of
customers, not a change to the post-cutover product promise: a draft created in
AutomationAgent remains durable and returnable from its first admitted turn.

## Decision log

- **2026-08-28 — Ship goal 10 as a shared schema only, and cut the rest of the
  extraction.** The module that shipped is `schema-v1.ts`,
  `canonical-payload-store.ts`, and `participant-transcript-store.ts` — not the
  seven files under [Shared SQLite module](#shared-sqlite-module). The Bind-loop
  ledger, activity store, snapshot store, and kernel were not extracted;
  `workstream-transcript-storage.ts` keeps its own implementation of every
  richer read and write over the same tables. AutomationAgent installs the
  `bind_loop_*` tables and never writes them, so the second half of goal 10 —
  the draft compiler's exact Bind state made durable — did not ship: an evicted
  compiler run re-enters the model from the stored conversation, with staged
  submissions and tool receipts making the re-entry safe. Extracting the
  work-stream transcript's reads, or building a second durable Bind host, inside
  an irreversible authority cutover was rejected as risk taken for symmetry no
  product behavior needed. Picking it back up requires moving the work-stream
  host's reads onto the shared module without changing their behavior, as a
  change of its own; the durable consequence is recorded in
  [`ordered-transcript-sqlite.md`](../../ordered-transcript-sqlite.md) and
  [`automation-lifecycle.md`](../../automation-lifecycle.md).

- **2026-08-28 — Bootstrap fresh WorkspaceDOs on the current schema while
  receipt-gating cleanup of historical objects.** The pre-deploy inventory
  materializes every existing workspace on the immutable historical ledger.
  The existing runner may then use a hashed current-schema baseline only for a
  database with no ledger, while the explicit cutover RPC remains the sole
  destructive path for an existing object after import receipts agree. A later
  automatic destructive migration was rejected because object wake has no
  cross-object receipt gate; leaving dead v1 tables in every future workspace
  was rejected because this cutover promises to remove the schema.

- **2026-08-28 — Keep accepted-definition editing out of this cutover.** Resume
  may re-enter `activating`, but no active-definition authoring session or
  trigger/schedule replacement producer is added. This supersedes the prior
  decision below that described active edits as reactivation. Inventing an edit
  surface without a durable conversation and acceptance flow was rejected as a
  second feature hidden inside the authority migration.

- **2026-08-28 — Preserve the existing two-stage connector ingress boundary.**
  The first Queue hop carries the bounded event to WorkspaceDO; canonical event
  order begins when WorkspaceDO accepts and sequences it, and only the second
  hop is ID-only. Activation excludes accepted events at or below its boundary,
  not provider events still awaiting first-stage acceptance. Collapsing ingress
  into a synchronous provider-to-WorkspaceDO call was rejected because this
  feature does not need to remove the existing staging guard.

- **2026-08-27 — Replace automatic schema cleanup with an explicit fenced
  workspace cutover.** WorkspaceDO schema migrations run on object wake and
  cannot wait for cross-object import receipts. The one merged Worker therefore
  keeps temporary legacy readers, fences one workspace, imports and verifies
  its automations, then invokes an explicit idempotent cleanup RPC that drops
  children before parents. No path dual-writes, and the transitional RPC becomes
  inert after its campaign receipt. This supersedes the earlier claim that an
  ordinary migration campaign could gate destructive cleanup.

- **2026-08-27 — Move automation memory data and freeze generated-run context.**
  Import includes memory items, table rows/cells, and mutation receipts—not only
  definitions. AutomationAgent exposes typed memory RPCs to its generated runs,
  while each occurrence snapshots effective settings, delivery targets, and
  telemetry attribution for its child. Cross-object SQL joins and deleting
  automation memory contents were rejected because either would lose accepted
  behavior during the authority move.

- **2026-08-27 — Make accepted-definition changes reactivation, not template
  adoption.** Active edits and resume enter `activating`; failure returns a
  previously accepted automation to `paused` with its last working definition.
  Shared templates remain authoring starters and do not maintain a live update
  relationship after acceptance. This removes a WorkspaceDO join and prevents a
  failed connector refresh from making deletion the only exit.

- **2026-08-27 — Use record-before-execute for draft-local writes.** This
  supersedes the entry immediately below that called evaluator and submission
  tools provider-keyed writes. No external provider supplies an idempotency key.
  The admitted run ID is stable, and each AutomationAgent-local mutation commits
  its host state and terminal Bind receipt in one SQLite transaction after a
  durable plan. Writes run serially by Bind's write-mode rule without setting a
  `serial` field; `load_plugin` remains the only serial read, selected by wire
  name.

- **2026-08-27 — Make draft mutations explicit and keep provider access
  read-only.** `automation_set_evaluator_rules` and
  `automation_submit_draft` are serial, provider-keyed writes to
  AutomationAgent SQLite; the latter is no longer advertised as a safe read.
  Structured elicitation is stored as its own pending record after a partial
  submission instead of being copied into definition JSON. The compiler may
  inspect every trusted connector schema but the host installs only connector
  read executors while the automation is a draft. A generic draft patch tool,
  provider writes for previews, duplicated elicitation fields, and
  model-supplied revision or authority tokens were rejected because they create
  multiple state writers or let authoring cross the acceptance boundary.

- **2026-08-27 — Keep one retry owner and make activation ordering explicit.**
  Evaluator installation now returns an `effectiveAfterEventSequence`; the
  named generation never matches older events, and later current-generation
  deliveries received during activation are durably held in AutomationAgent's
  trigger-receipt ledger until the active commit promotes them. Connector event
  processing already runs under the regional Queue, so WorkspaceDO keeps
  idempotent destination receipts but does not add an outbox alarm for the same
  delivery. The existing Queue attempt retries receipt-ID publication and the
  delivery Queue message retries the destination. Legacy `error` subscriptions
  migrate to `paused` plus an attention record rather than adding another
  lifecycle state. Shared SQLite extraction is capability-driven; this cutover
  does not require rewriting BlockDashboardAgent for symmetry.

- **2026-08-27 — Remove concurrency and evaluator machinery that does not serve
  a current behavior.** Draft messages use idempotent append plus one active
  compiler turn; they do not carry a draft revision or transcript-head
  compare-and-swap because a single author appending a message cannot overwrite
  prior state. Evaluator V1 uses one typed deterministic predicate per exact
  source and does not include ordered per-rule results or a semantic-model gate,
  because every required connector trigger is expressible without either.
  Timer-only and manual-only submissions clear prior evaluators from the
  submitted definition instead of requiring the architect to call a tool with
  an empty array. Activation failures remain `activating` with an error and
  retry action instead of introducing `needs_attention` plus conditional
  distributed rollback to an editable draft. These mechanisms can be added
  later only with a concrete collaborative-editing, semantic-trigger,
  priority-rule, or activation-cancellation requirement.

- **2026-08-27 — Share one renderer conversation surface between Workstream
  and the Automation Draft Wizard.** The wizard reuses the feed, transcript
  blocks, attachments, scrolling/follow behavior, activity presentation, and
  composer/input through product-neutral props and hooks. Workstream and
  Automation remain adapters for different data, authorization, and lifecycle
  contracts. Keeping `AutomationMessageBlock` plus a wizard-specific feed and
  composer assembly was rejected because fixes to streaming, accessibility,
  attachments, elicitation, draft recovery, and scrolling would continue to
  land twice. Importing WorkstreamScreen wholesale was also rejected because it
  would smuggle participant, unread, resource-rail, substream, and run-control
  semantics into a single-author automation draft.

- **2026-08-27 — Create AutomationAgent on the first prompt, not on screen
  open.** Selecting **New automation** remains ephemeral UI and creates no
  server-side draft. First-prompt submission uses a stable client creation key
  to claim one server-minted automation ID, then creates the named object and
  commits identity, the human turn, and compiler admission before provider
  work. Creating empty objects on navigation was rejected because abandoned
  composers are not drafts the person asked Rally to retain.

- **2026-08-27 — Give the architect one complete-replacement evaluator tool.**
  `automation_set_evaluator_rules` stages a structurally and contextually parsed
  authoring set inside the compiler run, and `automation_submit_draft` promotes
  that set with the definition. Host-owned IDs, generations, resolved
  connections, and projections never enter model arguments. Embedding opaque
  filter JSON in `submit_draft`, exposing the authoritative evaluator envelope,
  and incremental add/remove tools were rejected because they respectively
  evade type safety, cross an authority boundary, and make retries and stale
  rule removal ambiguous.

- **2026-08-27 — Cut over in one merge, migrate accepted automations, and
  discard legacy drafts.** There are no customer automations to support through
  a compatibility window. The merge-triggered workflow imports every visible
  accepted automation, preserving paused state and mapping legacy error to
  paused plus attention, verifies its new authority, deletes legacy drafts, and
  removes the old lifecycle schema. A
  staged per-automation flag, dual writes, and a frozen legacy rollback source
  were rejected because they would make the migration and its failure modes
  harder to reason about without preserving customer work.

- **2026-08-26 — Use typed evaluators for ordinary external-event triggers.**
  Accepted automation definitions compile into the closed, versioned,
  manifest-validated evaluator grammar in this PRD. Source selection remains an
  exact connection/event/resource index in WorkspaceDO, and unsupported fields
  or relationships are refused at review or activation rather than delegated to
  a programmable runtime.

## Key design decisions

1. **One object represents a subscription, not a template or a run.** A
   subscription is the thing with an owner, scope, trigger configuration,
   pause state, run history, and draft-to-active lifecycle. A shared template
   can have many independent subscribers, and a run already has its own work
   stream. *Rejected:* one object per template, which would couple unrelated
   subscribers; and one object per run, which would leave the automation itself
   without a durable owner.

2. **The object is created by first-prompt admission, before compiler work—not
   by opening the screen.** This preserves today's lightweight new-automation
   screen while making a failed first submitted turn resumable. A stable client
   creation key resolves uncertain first-submit retries to one server-minted
   automation ID, and the object's first local transaction commits identity,
   the human turn, and run admission before provider work. *Rejected:* creating
   an empty object when the person selects **New automation**, which would fill
   the sidebar and storage with abandoned empty drafts; and allocating only
   after the first successful compile, which preserves today's durability gap
   while merely moving later rows.

3. **Acceptance is a state transition, not a transfer.** The AutomationAgent
   stays canonical after activation, so freezing the definition and claiming
   acceptance are local and atomic. External indexes and address claims are
   receipts reconciled around an `activating` state. *Rejected:* a draft-only
   AutomationAgent that promotes into WorkspaceDO, because it recreates the
   distributed transfer that caused a separate draft object to be rejected.

4. **AutomationAgent orchestrates generated work but does not execute it.** An
   automation and one of its run work streams have different lifetimes,
   transcripts, audiences, and authority. *Rejected:* using SubstreamAgent as
   the automation itself. It is useful code reuse but the wrong product
   boundary.

5. **Bind and transcript reuse is capability-driven, not one database or a
   mandatory three-host rewrite.** The common modules own product-neutral
   schema fragments and operations for canonical facts, exact Bind state,
   attempts, receipts, checkpoints, recovery, and settlement. Each product host
   supplies storage at the authority that owns the relevant context.
   Automation compiler rows live in AutomationAgent; work-stream rows live in
   SubstreamAgent; a block keeps its dispatch ownership in BlockDashboardAgent
   and reaches source-context Bind state through the main SubstreamAgent's typed
   remote object port. BlockDashboardAgent adopts no shared host-runtime capability in
   this cutover. *Rejected:* copying shared invariants, forcing all
   three hosts through one lifecycle abstraction, and relocating block source
   state solely to make the diagrams symmetrical.

6. **WorkspaceDO projections are indexes, not a second automation authority.**
   Lists and activity matching need workspace-shaped queryability; direct
   object reads provide current configuration and authorization. *Rejected:*
   enumerating the namespace, which is an administrative facility rather than
   a product query; and synchronous fan-out to every automation for each list
   or activity event.

7. **Draft turns append and compiler runs serialize.** A client message ID makes
   admission idempotent, the object's SQLite transaction appends rather than
   replaces the conversation, and one active compiler turn prevents overlapping
   model work. A stale idle window may append a message because the compiler
   reads the latest canonical conversation and no accepted turn can be lost.
   *Rejected:* today's whole-conversation last-turn-wins write, and an
   optimistic-concurrency token that rejects safe single-author appends.

8. **The authoring conversation is not runtime context.** Acceptance freezes
   the resulting definition and receipt, then deletes the conversation at the
   active commit. *Rejected:* retaining the full wizard conversation in every
   generated run's prompt, which adds private, irrelevant context and lets
   setup-time wording affect execution after the reviewed definition is fixed.

9. **AutomationAgent extends `ScheduledDurableObject`; it does not implement an
   alarm loop.** Canonical automation schedules,
   activation/projection retry, `run_provisioning`, inbound-email lease recovery,
   and any other lane that can fail or legitimately decline are stored alarm
   entries. Derived candidates are limited to pure instants whose handler always
   makes progress and therefore needs no stall gate. The base takes the earliest effective
   instant, performs the pre-work recovery arm, drains independently gated
   entries, detects a handler that made no progress, re-derives indexes, and
   re-arms exactly after work. *Rejected:* a bespoke automation alarm handler,
   which would duplicate behavior Rally already relies on; and keeping
   WorkspaceDO as canonical automation scheduler after moving definition and
   run admission, which would split the runnable decision across two
   authorities. Bind dispatch/recovery is the exception: like SubstreamAgent,
   it is a derived candidate computed from durable dispatch rows without
   consulting in-memory drain state. Only the drain-time re-arm omits the
   in-flight claimed run; ordinary pre/post-work derivation retains it so an
   interrupted claim cannot strand a running row. The subclass supplies the
   existing hooks for candidates, entry handling, derived work, and index
   reconciliation and never bypasses the base with a second future-alarm
   derivation.

10. **Activation has an explicit intermediate state.** Required projections and
    provider routes are external to the object's SQLite transaction. Showing
    `active` only after acknowledgements makes partial failure visible and
    recoverable. *Rejected:* optimistic active state with best-effort
    registration, which creates triggers users can see but cannot reach.

11. **The draft wizard adopts the ordered transcript substrate.** The
    AutomationAgent is a new authority adapter for the same stable
    turn/block/range, activity, snapshot-fence, canonical-fact, and restricted
    lossless Bind-loop contracts implemented for SubstreamAgent. Its personal
    author policy and wizard view remain distinct product adapters. *Rejected:*
    migrating `draft_conversation_json` into an object-local JSON blob or a
    wizard-only message table, because either would recreate the opaque replay
    and pagination boundary that the ordered-turn cutover removes today.

12. **A generated work stream reports execution; it does not share authority
    with its automation.** SubstreamAgent owns transcript and exact execution
    outcome. AutomationAgent owns the occurrence and applies a content-free,
    versioned full projection through durable outbox, WorkstreamDO, Queue, and
    typed RPC. *Rejected:* the current direct child write to
    `automation_runs`, which crosses authority boundaries, and synchronous
    parent calls in the child commit path, which create cyclic availability.

13. **Generated runs are nested discovery, not parent-owned conversations.**
    AutomationAgent serves a paged content-free run list on the automation home;
    generated children are absent from the global work-stream sidebar and its
    public directory response. A hidden content-free reader projection filters
    the list. Selecting a run still opens its WorkstreamDO/SubstreamAgent and
    performs current child reader admission. *Rejected:* merging run transcripts
    into AutomationAgent merely because the global sidebar no longer lists
    them; navigation hierarchy does not change canonical content ownership.

    Deleting the parent deliberately cascades to its generated children after
    an explicit destructive confirmation. *Rejected:* leaving them as ordinary
    orphaned work streams, because the global list no longer exposes their
    automation provenance and the user action promises removal of the
    automation and its run history as one product entity.

14. **WorkspaceDO evaluates external events; AutomationAgent owns timers.** A
    connector event is already canonical, region-local workspace state, so its
    evaluator context and all candidate indexes stay beside that event. The
    AutomationAgent publishes its complete desired evaluator set and receives
    only durable matches. Calendar and interval occurrences derive from the
    accepted automation definition and remain object-local multi-alarm work.
    *Rejected:* waking every AutomationAgent for every workspace event, which
    turns unrelated objects into the query plan; and routing timers through
    WorkspaceDO, which splits schedule authority from run admission.

15. **Evaluator predicates are a closed algebra with a manifest-validated
    context.** One non-recursive DNF predicate returns match or no-match. The
    flat provider schema stays within the schema budget; a kind-then-operator
    strict parser produces branded leaf types in which illegal combinations are
    unavailable to internal callers, while the
    registry-aware parser proves that a field belongs to the exact event source.
    *Rejected:* the current `Record<string, unknown>` plus JSON deep equality,
    arbitrary metadata paths, implicit coercion, and a generic operator/value
    pair. Each lets malformed or misspelled rules survive compilation and makes
    a connector schema change fail during event processing instead of at a
    boundary.

16. **Automation triggers and work-stream resource watches share event
    delivery infrastructure, not product authority.** WorkspaceDO compiles both
    into one typed registration index and uses one evaluation-receipt and Queue
    delivery engine. AutomationAgent still owns its evaluator set and
    occurrence;
    SubstreamAgent still owns its watched link, audience, and appended system
    message. *Rejected:* retaining the current direct-watch scan and append as a
    second fan-out loop beside automation evaluation, which would duplicate
    event/resource matching, retries, and receipts; and making WorkspaceDO's
    inverted link authoritative for the append, which would let a stale
    projection disclose restricted activity after participant or watch state
    changed. This stays in the same implementation because the new evaluator
    engine becomes the canonical connector-event destination path in this
    cutover; postponing watches would deliberately retain a second matcher and
    retry owner that the shared registration contract exists to remove.

17. **The Workstream and wizard conversation UI is one component family with
    two adapters.** Product-neutral feed and composer ports consume ordered
    message view models, attachment actions, activity state, paging/follow
    controls, send state, and callbacks. WorkstreamScreen supplies multiplayer
identity, attention, resources, suggestions, stop/retry, and work-stream
realtime policy. The Automation Draft Wizard supplies single-author
identity, first-prompt creation, compiler retries, elicitation, draft
configuration, and acceptance. *Rejected:* sharing only CSS and leaf
    controls while retaining two transcript loops, because behavior and
    accessibility would still drift; and parameterizing one monolithic screen
    with product-mode conditionals, because authority and lifecycle policy
    would leak into reusable presentation.

## Data model

The exact table names belong to the implementation plan and migrations. The
authority split is fixed by this PRD:

| Authority | Canonical records |
| --- | --- |
| AutomationAgent SQLite | Immutable automation identity and workspace/region fence; lifecycle plus orthogonal safe attention/error state; draft canonical facts plus author-visible `transcript_sequence` and restricted `loop_sequence` projections; attachments, checkpoints, activities, event fences, compiled and accepted revisions, separate pending elicitation, and the local Bind ledger; canonical schedules and `_internal_durable_alarms`, including `run_provisioning` and inbound-email lease recovery; evaluator snapshots, activation boundaries, trigger receipts, unique occurrences, immutable `AutomationRunContextV1`, and content-free child projections; the complete automation memory scope including items, mutations, table definitions, columns, rows, cells, and index receipts; inbound-email rate windows and receipt leases; resources, connectors, delivery targets/receipts, projection outbox, and tombstone. |
| WorkspaceDO SQLite | First-prompt creation-key claims; automation directory and viewer projections; hidden generated-child reader projections and automation attention; validated automation evaluators and watched-resource registrations in one exact candidate index; evaluator generations and activation boundaries; canonical normalized events sequenced at acceptance, closed evaluation contexts, and delivery receipts; shared template catalog, connectors, resources, and membership routing; per-workspace automation-cutover fence, cursor, audit, and completion receipt. |
| Generated SubstreamAgent SQLite | Ordered-turn canonical facts, participant transcript and restricted Bind-loop projections; participants and reader audience; run scope; Bind execution, tools, activity/checkpoints and output; authoritative work-stream resource links/watch flags and memory provenance; idempotent connected-activity message receipts; content-free automation-run and resource-link projection outbox. |
| Global control-plane D1 | Permanent inbound-email address route and tombstone, plus the existing region/workspace routing facts needed before a regional object can be selected. |

Object identity is derived from the existing automation subscription ID, so a
migrated automation keeps its public ID. References across objects are opaque
IDs, never SQLite foreign keys. No query or transaction crosses object
databases.

`AutomationRunContextV1` is allocated with occurrence admission and supplied to
the child at provisioning. It is the only post-cutover source for effective
instructions/settings, delivery destinations, trigger metadata, execution
principal, automation telemetry attribution, and the parent memory-scope
reference. Import computes and freezes the same effective values that the legacy
template/version plus overrides join produced; no runtime join survives.

AutomationAgent's child execution row stores projection and receipt facts, not
a foreign copy of the child run. It includes the admitted child identities,
authority generation, latest source version/hash, safe execution and attention
summary, committed-through participant sequence, nullable final-turn reference,
and timestamps needed by the automation home. Child transcript blocks,
restricted `loop_sequence` bounds, exact tool results, audience, and provider
payloads never enter the parent database. Delivery state remains an
AutomationAgent record linked to the occurrence rather than a child execution
field.

`_internal_durable_alarms` is an index, never the record of a schedule, Bind
dispatch, activation operation, or outbox effect. Every handler reloads its
canonical source row. A terminal source removes its stored entry; a source that
still names the same due instant but cannot progress because of lifecycle
returns the base class's `{ waitMs }` outcome instead of a false no-op that trips
the stall gate. AutomationAgent applies the shared alarm schema through its
own append-only object migration history and inherits the migration readiness
gate from `ScheduledDurableObject`'s base.

Every WorkspaceDO subscription with `lifecycle_state = 'visible'` and status
`active`, `paused`, or `error` is an accepted automation for cutover purposes.
It is imported into the named AutomationAgent with its current definition,
lifecycle, authority generation, schedule and next-occurrence cursor, permanent
email route, delivery configuration, complete memory items/table contents and
mutation receipts, connector and resource references, resolved effective model
and settings, run identities and history, inbound-email rate windows and receipt
leases, and deduplication and delivery receipts. Legacy `active` and `paused` remain active
and paused. Legacy `error` becomes non-runnable `paused` with a runtime-error
attention record carrying the safe legacy error; `error` does not become a new
AutomationAgent lifecycle state. The import preserves the existing subscription
ID as the object identity and is accepted only after source and destination
hashes and trigger-registration receipts agree.

No current writer is known to produce subscription status `error`; the branch
is fail-safe migration handling, not a claim that such rows exist. The checked-
in audit records zero when that remains true and fails closed on an unexpected
count before deciding whether the mapping is needed.

A legacy semantic trigger, generic webhook, non-scalar deterministic filter, or
other trigger that cannot be represented losslessly by evaluator V1 imports as
non-runnable `paused` with an `unsupported_trigger` attention record preserving
the original safe summary. It is never broadened by dropping an unrepresentable
condition. The pre-cutover audit reports every such row.

Legacy rows with status `draft` are not imported, regardless of visibility.
The cutover deletes those subscriptions, their compiler conversation, and any
private template versions, memory scopes, resources, or other rows reachable
only from those drafts. Drafts are not supposed to hold permanent addresses;
the audit records zero. If an invariant-violating route is nevertheless found,
cleanup fail-safely converts it to a Global tombstone rather than making the
address reusable. Archived and deleted
legacy subscriptions are not runnable imports: the campaign deletes their
generated children and memory descendants under the same destructive policy,
records a minimal migration tombstone for provenance, and retains the permanent
inbound-email tombstone in its existing Global control-plane authority.

After all accepted imports have receipts, the same merge-triggered workflow
removes WorkspaceDO's former lifecycle tables: `automation_subscriptions`,
`automation_runs`, `automation_delivery_targets`,
`automation_email_receipts`, `automation_email_rate_windows`, and
`automation_resources`. It rebuilds the shared `schedules` table without its
automation-subscription branch while retaining connector and digest schedules.
The generic memory tables remain because other products use them, but no
automation-owned source rows remain there after import or draft deletion.
`automation_templates` and `automation_template_versions` remain only as the
shared template catalog described above; private versions copied into imported
automations and rows reachable only from discarded drafts are removed when no
other catalog relationship references them. They are no longer a lifecycle,
settings, version-adoption, or execution fallback.

## Implementation guidelines

Implementation shares the ordered transcript and exact Bind SQLite substrate as
capability-sized code and immutable schema fragments. It never shares one
database, migration ledger, or lifecycle authority among AutomationAgent,
SubstreamAgent, and BlockDashboardAgent. SubstreamAgent and AutomationAgent are
the required consumers in this cutover. BlockDashboardAgent adopts nothing and
must remain behaviorally unchanged; a broader Block Dashboard refactor is
neither a prerequisite nor an acceptance condition. All shared SQL executes synchronously inside the Durable Object that
owns the state.

### Finding the current seams

An implementer should start from these stable files and named sections rather
than from review-sensitive line positions:

- [`apps/api/src/services/automation-service.ts`](../../../apps/api/src/services/automation-service.ts)
  contains today's draft blob, compiler, lifecycle, promotion, run, template-
  adoption, and schedule authority. Inventory every exported reader and writer;
  replace them with typed AutomationAgent RPCs or deliberately retained catalog
  operations before the legacy tables are removed.
- [`apps/api/src/routes/automations.ts`](../../../apps/api/src/routes/automations.ts)
  contains the HTTP/SSE-owned `POST /draft/stream` compiler path. Replace SSE
  transcript ownership with HTTP admission plus the AutomationAgent hibernating
  feed socket; keep request authentication and attachment admission at the
  route boundary.

- [`packages/agent-harness/src/bind-loop-projection.ts`](../../../packages/agent-harness/src/bind-loop-projection.ts)
  contains the pure Bind transition reducer, canonical projection, hashing, and
  provider-boundary verification. Search for `BindLoopTransition`,
  `applyBindLoopTransition`, `canonicalizeBindLoop`, and `hashBindLoop`.
- [`packages/agent-harness/src/index.ts`](../../../packages/agent-harness/src/index.ts)
  contains `AVALON_AUTOMATION_CREATOR_TOOL_DEFINITIONS`, the creator-tool
  executors inside `compileAutomation`, and the existing `submit_draft`
  `validateInput` boundary. Append the new definitions after the existing
  entries, replace positional indexing with name-based lookup, add the two
  resolver reads and `set_evaluator_rules`, change `submit_draft` to a record-
  before-execute write, add the automation-host elicitation definition without
  mutating the shared work-stream constant, and give all changed executors the same
  advertised-schema/strict-Zod validation symmetry, and keep staged/submitted
  state in the durable host adapter rather than the current process closure.
  The compiler's executable-plugin construction is also the seam that must omit
  provider write executors while preserving their trusted schemas in plugin
  inspection. The automation compiler prompt in the `prompts` section is where
  read-only draft research and the external-trigger-only set-before-submit
  behavior are taught; the host clears evaluators itself when the submitted
  definition has no external trigger.
- [`apps/api/src/durable-objects/workstream-object-schema.ts`](../../../apps/api/src/durable-objects/workstream-object-schema.ts)
  contains the SubstreamAgent object migration history. Find the migration
  whose description says it adds the canonical ordered transcript and lossless
  Bind-loop projections; its statements define the first shared schema version.
- [`apps/api/src/durable-objects/sqlite-migrations.ts`](../../../apps/api/src/durable-objects/sqlite-migrations.ts)
  contains `applyDurableObjectSqliteMigrations` and
  `durableObjectMigrationHash`. This remains the one migration runner; the
  automation implementation does not introduce another ledger or runner.
- [`apps/api/src/durable-objects/scheduled-alarms.ts`](../../../apps/api/src/durable-objects/scheduled-alarms.ts)
  documents the existing composition precedent: immutable shared schema
  statements are imported into each object's own append-only migration history.
  The ordered transcript follows the same pattern as
  `SCHEDULED_ALARM_SCHEMA_STATEMENTS`.
- [`apps/api/src/durable-objects/workstream-transcript-storage.ts`](../../../apps/api/src/durable-objects/workstream-transcript-storage.ts)
  is the current combined storage implementation. Read the method groups for
  Bind transition/compaction commits, provider-boundary recording, participant
  turns and tool lifecycle, activities, snapshots/ranges, fact preparation, and
  sequence allocation. Those groups identify the shared stores and the
  work-stream adapter that must be separated.
- [`apps/api/src/durable-objects/workstream-transcript-protocol.ts`](../../../apps/api/src/durable-objects/workstream-transcript-protocol.ts)
  is the current object-port surface. Its operation list is the place to replace
  storage-class reflection with an explicit ordered-transcript port and typed
  mutation effects.
- [`apps/api/src/durable-objects/workstream-regional-effect.ts`](../../../apps/api/src/durable-objects/workstream-regional-effect.ts)
  owns the child-to-regional effect union. Add the automation projection effect
  there, extend WorkstreamDO's `durable_outbox.effect_kind` constraint through a
  new append-only migration, and add the destination branch beside the existing
  Queue consumers in `apps/api/src/queues/activity-consumer.ts`; do not hide the
  new effect behind a generic SQL string or an untyped payload.
- [`packages/contracts/src/workstream-transcript.ts`](../../../packages/contracts/src/workstream-transcript.ts)
  contains reusable transcript schemas. The activity, interval, block, turn,
  and basic range schemas move to a product-neutral contract;
  [`packages/contracts/src/index.ts`](../../../packages/contracts/src/index.ts)
  retains the work-stream socket and snapshot envelopes.
- [`apps/desktop/src/renderer/lib/transcript.ts`](../../../apps/desktop/src/renderer/lib/transcript.ts)
  contains the client-side range coverage, gap calculation, and realtime merge
  reducers. Those reducers are reusable; conversion into the neutral
  `ConversationMessage` remains a host renderer adapter.
- [`apps/desktop/src/renderer/screens/workstream.tsx`](../../../apps/desktop/src/renderer/screens/workstream.tsx)
  contains `WorkstreamScreen`, the transcript viewport,
  `JumpToLatestButton`, range paging, prepend scroll preservation, attachment
  drop handling, and the composer dock. Extract the product-neutral
  conversation surface from those named sections; leave headers, presence,
  attention, resource rails, block dashboard, substream navigation, and
  work-stream run controls in the screen adapter.
- [`apps/desktop/src/renderer/screens/new-automation.tsx`](../../../apps/desktop/src/renderer/screens/new-automation.tsx)
  contains `NewAutomationScreen`, `AutomationMessageBlock`, its own streaming
  follow loop, and a screen-local `ComposerInput` assembly. Replace those
  duplicate conversation paths with the shared surface. Keep the ephemeral
  new-automation intro, templates, compiler/draft state adapter, source/plugin
  configuration, review summary, and acceptance controls in the wizard.
- [`apps/desktop/src/renderer/App.tsx`](../../../apps/desktop/src/renderer/App.tsx)
  and [`apps/desktop/src/renderer/screens/automation-overview.tsx`](../../../apps/desktop/src/renderer/screens/automation-overview.tsx)
  own the existing accepted-home route and lifecycle UI. Introduce the
  lifecycle-dispatching `AutomationScreen` there and retire the `?draft=` route
  without replacing the accepted overview.
- [`apps/desktop/src/renderer/components/workstream-blocks.tsx`](../../../apps/desktop/src/renderer/components/workstream-blocks.tsx),
  [`workstream-composer.tsx`](../../../apps/desktop/src/renderer/components/workstream-composer.tsx),
  and [`composer-input.tsx`](../../../apps/desktop/src/renderer/components/composer-input.tsx)
  are the existing reusable block and input family. Search for `MessageBlock`,
  `ElicitationPanel`, `WorkstreamComposer`, and
  `ComposerInput`. Split product-neutral mechanics from Workstream-only
  mentions, participant confirmation, slash commands, and stop policy rather
  than copying the components into an automation directory.
- [`apps/desktop/src/renderer/components/attachments.tsx`](../../../apps/desktop/src/renderer/components/attachments.tsx)
  owns `MessageAttachments`; reuse it rather than looking for attachment
  rendering in the composer files above.
- [`apps/desktop/src/renderer/lib/use-transcript-follow.ts`](../../../apps/desktop/src/renderer/lib/use-transcript-follow.ts),
  [`apps/desktop/src/renderer/lib/draft-keys.ts`](../../../apps/desktop/src/renderer/lib/draft-keys.ts),
  [`apps/desktop/src/renderer/lib/use-draft-text.ts`](../../../apps/desktop/src/renderer/lib/use-draft-text.ts),
  [`apps/desktop/src/renderer/lib/use-file-attachments.ts`](../../../apps/desktop/src/renderer/lib/use-file-attachments.ts),
  and [`apps/desktop/src/renderer/lib/elicitation.ts`](../../../apps/desktop/src/renderer/lib/elicitation.ts)
  already hold shared follow, local composer-draft, and elicitation behavior.
  Both adapters use those implementations; they do not keep wizard-specific
  substitutes in a screen component.

### Shared renderer conversation surface

The desktop keeps one product-neutral conversation component family. Exact
file names are implementation choices, but the ownership boundary is not:

```text
conversation surface
  feed viewport and ordered row rendering
  transcript block renderers and attachment presentation
  streaming reveal, active work timing, and elicitation
  history paging, follow state, and Jump to latest
  composer shell, input, attachment staging, dictation, and draft cache

Workstream adapter                    Automation draft adapter
  participants and own-author style    single signed-in author
  unread and attention anchors         no collaborative unread state
  work-stream socket/range view        AutomationAgent snapshot/range view
  resources, suggestions, stop/retry   compiler stop/retry and draft review
  work-stream send admission            first-create and later-turn admission
```

The shared surface accepts product-neutral view models and capabilities rather
than a `WorkstreamDetail`, Workstream socket, AutomationAgent response, or
product mode flag. In TypeScript terms, the boundary has the shape below; the
names are illustrative, while the separation is required:

```ts
interface ConversationFeedProps {
  conversationId: ConversationId;
  messages: readonly ConversationMessage[];
  activeWork?: AgentWorkTimingState;
  coverage: TranscriptCoverage;
  loadingOlder: boolean;
  onLoadOlder(): Promise<void>;
  onAnswerElicitation(id: string, answer: ElicitationAnswer): Promise<void>;
  onOpenAttachment(preview: AttachmentPreview): void;
}

interface ConversationMessage {
  conversationId: ConversationId;
  turnId: TurnId;
  sequence: TranscriptSequence;
  blocks: readonly ConversationBlock[];
  author: ConversationAuthor;
}

interface ConversationComposerProps {
  draftKey: string;
  attachments: readonly PendingAttachment[];
  sending: boolean;
  uploading: boolean;
  error?: string;
  capabilities: ComposerCapabilities;
  onSend(input: ConversationInput): Promise<void>;
}
```

Capabilities express concrete optional behavior such as participant mentions,
slash commands, stop, connector mentions, or suggested prompts. They do not
select broad `workstream` versus `automation` branches inside shared leaf
components. Both adapters normalize their authoritative protocol into the same
ordered `ConversationMessage` and activity view models before rendering;
neither renderer reconstructs canonical Bind state from display rows. Client
telemetry uses the real `conversationId`; the wizard never fabricates a
work-stream ID such as `automation-creator`.

The ephemeral `/automations/new` route mounts the same composer used after
admission. Its send adapter claims and creates the AutomationAgent on the first
submission, then adopts the returned durable identity without replacing the
conversation subtree. A route change must not reset text entered during an
in-flight turn, attachments, dictation state, focus, measured row heights, or
follow position. Reopening an existing draft supplies the same surface from the
AutomationAgent snapshot and event stream.

The implementation may retain an established component name such as
`MessageBlock` when it is already product-neutral. It should rename a
Workstream-prefixed component only when the name now misstates ownership; it
must not perform a tree-wide cosmetic rename or create a generic UI framework.
There are exactly two concrete consumers in scope, and extraction stops at the
behavior they demonstrably share.

### Shared SQLite module

The API keeps one internal ordered-transcript SQLite module, split by semantic
responsibility rather than by product host:

```text
durable-objects/ordered-transcript-sqlite/
  schema-v1.ts
  canonical-payload-store.ts
  bind-loop-ledger.ts
  participant-transcript-store.ts
  activity-store.ts
  snapshot-store.ts
  ordered-transcript-kernel.ts
```

This starts as an API-internal module because its current consumers run in the
same Worker deployment surface. It becomes a workspace package only if another
deployment surface needs it; package extraction is not a prerequisite for code
reuse among Durable Objects in `apps/api`. Extraction proceeds only as a second
consumer needs a capability: the automation cutover must not first rewrite all
of SubstreamAgent storage or move BlockDashboardAgent onto an unrelated shared
lifecycle abstraction.

The module owns:

1. Canonical JSON byte preparation and SHA-256 hashing. The Bind projector and
   transcript fact store must call one implementation so provider hashes,
   payload deduplication, replay, and conflict checks cannot drift.
2. Canonical payload/fact insertion and lookup, including audience-separated
   deduplication.
3. Bind head conflict checks, state/message commits, exact reconstruction, and
   provider-boundary receipts.
4. Transcript and loop sequence allocation.
5. Product-neutral turn/block insertion, fact-reference range reads,
   activity/interval lifecycle, and snapshot fences. The shared read returns
   turn/block rows plus canonical fact references, not host content or
   attachment joins.
6. Pure lifecycle mapping, ordering, and typed row conversion that does not
   consult product-owned tables. A synchronous typed host adapter hydrates fact
   content and attachments inside the owning object's transaction.

The module exposes typed storage methods, not raw SQL strings or a generic
query builder. Schema and the queries enforcing that schema remain together so
a table or invariant cannot change for one host while another silently keeps an
old query.

### Migration composition

Shared schema is published as immutable, ordered statement arrays by capability,
for example a canonical-fact schema, Bind-loop ledger schema, participant
transcript schema, activity schema, and snapshot schema. Dependency order is
explicit: Bind and participant rows depend on canonical facts, and snapshots
depend on transcript counters.

The fragments never own an object migration number. Each object imports the
fragments into its own next migration version and records that version in its
own `_sql_schema_migrations` ledger. SubstreamAgent preserves the existing
ordered-transcript migration number and statement order; AutomationAgent uses
the appropriate version in its independent history. BlockDashboardAgent
installs no fragment in this cutover and does not acquire transcript tables
merely to make the three hosts symmetrical.

The first extracted arrays are named as immutable versioned artifacts, such as
`*_SCHEMA_V1`. Once a migration can have been applied, its statements, order,
and whitespace are not edited. A later schema change adds a new versioned delta
array and a new migration entry in every consuming object's own ledger. Tests
pin the existing SubstreamAgent migration hash before and after extraction so a
mechanical move cannot rewrite released history.

### Legacy WorkspaceDO schema removal

The regional D1 migration named for dropping legacy product tables has already
removed D1's former automation tables; it is historical and is not edited. This
cutover removes the newer WorkspaceDO SQLite lifecycle schema declared in the
automation and shared-schedule portions of `workspace-domain-schema.ts`.

The existing migration runner gains one explicit current-schema bootstrap for
a database with no ledger. The pre-deploy inventory first wakes every regional
workspace that already exists so any object capable of containing legacy
automation state has the historical v1 ledger before the new build. A database
first created by the new build instead installs the post-cutover WorkspaceDO
schema and a hashed bootstrap receipt; it does not replay the historical schema
whose automation tables were never authoritative for that new workspace. This
is a baseline mode in `applyDurableObjectSqliteMigrations`, not a second runner,
and tests prove a historically migrated object and a fresh current-baseline
object expose the same final surviving schema.

Existing-object cleanup is **not** an automatically applied migration version:
the runner applies unapplied versions whenever an object wakes and has no cross-
object receipt gate. The deployed Worker instead exposes a typed, idempotent
`finalizeAutomationCutover` WorkspaceDO RPC available only through the migration-
command consumer to the deploy cutover step.
It refuses unless that workspace's durable cutover fence is closed, the audited
source hash still matches, every accepted import and trigger registration has a
matching destination receipt, all destructive draft IDs match the checked-in
regional audit, and no legacy admission is in flight.

The RPC performs synchronous object-local cleanup. SQLite cannot drop the
automation foreign-key branch from `schedules` in place, so both the current
bootstrap and the RPC import one immutable `SURVIVING_SCHEDULE_SCHEMA_V2`
statement artifact. The RPC rebuilds the table with connector and digest
branches, copies only those rows, and recreates every index, constraint, and
both `schedules_workspace_identity_{insert,update}` triggers before validating
foreign keys. Fresh and migrated objects therefore have one final schedule
shape. It deletes source rows in child-first order before dropping tables in
the same order: `automation_email_receipts`,
`automation_email_rate_windows`, `automation_resources`,
`automation_delivery_targets`, `automation_runs`, and finally
`automation_subscriptions`. This satisfies the receipt and rate-window
`ON DELETE RESTRICT` edges rather than relying only on drop order. Automation-
owned generic-memory descendants are removed only after their full destination
hashes are verified. Shared templates and generic memory tables remain for
their other roles. An object wake before this explicit RPC cannot remove source
data.

The cross-object import is not represented as one SQLite transaction. A typed,
versioned WorkspaceDO snapshot and a named AutomationAgent import receipt carry
source version, canonical payload hash, destination authority generation, and
registration status. RPC awaits occur outside object-local transactions. Each
side rereads its final authority before acknowledging, and the migration
campaign invokes destructive cleanup only when every accepted source row has one
matching destination receipt. The per-workspace campaign ledger, rather than a
retained old automation table, is the durable restart cursor. The cleanup code
stays in the one deployed build but refuses after the campaign is complete; it
is not a product-state reader or rollback source.

### Transaction and query boundaries

The top-level ordered transcript kernel owns `transactionSync` for compound
commits. Lower-level stores operate on its transaction-scoped `SqlStorage` and
do not open independent transactions when one accepted Bind transition spans
facts, exact loop state, participant projection, activities, and mutation
effects. Canonicalization and cryptographic hashing finish before the
synchronous transaction begins; there is no `await`, RPC, Queue operation, or
external I/O inside the object-local commit.

The shared query layer includes fact deduplication, Bind head fencing and
reconstruction, provider-boundary recording, sequence allocation, generic
turn/block fact-reference reads, snapshot fencing, and bounded range reads.
Mutations return structured effects such as changed turn and activity IDs.
Each host publishes those effects through its own realtime protocol rather than
switching on storage method names or teaching the shared store about sockets.

Compaction separates the shared atomic operation from the host fence. The
shared kernel commits the exact `state_replaced` transition and checkpoint fact;
a synchronous typed host adapter verifies and writes the continuation metadata
required by the same transaction. SubstreamAgent supplies its resource
inventory and execution-principal fence. AutomationAgent supplies the draft's
attachment, connector-grant, and accepted-definition fence. Neither host's
columns enter the common schema.

### Product adapters that stay separate

The following remain outside the shared module because they are product policy
or references to another authority:

- Work-stream `parts` compatibility joins, human-content hydration, and
  `part_attachments`/resource-link hydration through the synchronous host
  adapter.
- Work-stream attention ordinals, unread anchors, opening-window selection, and
  reads from work-stream realtime state.
- Participant and automation-author authorization, audience expansion, and
  socket ticket/event publication.
- Work-stream resource-inventory compaction fences and AutomationAgent draft or
  accepted-definition fences.
- Automation lifecycle/configuration, timer occurrence, evaluator, delivery,
  and child-run projection tables and queries.
- BlockDashboardAgent dispatch, stream checkpoint, and settlement authority.
- Workstream header/presence, participant management, unread/attention policy,
  inspector and block-dashboard rails, substream routing, resource suggestions,
  and generated-run stop/retry policy.
- Automation new-route intro and templates, first-prompt identity admission,
  compiler retry, source/plugin/delivery configuration, draft summary/review,
  activation, and acceptance controls.

The implementation's work-stream transcript adapter composes the shared
snapshot/range primitives into its unread-plus-latest opening policy. Its
automation-draft adapter composes them into the latest draft conversation plus
active compiler turn. Block dashboard
execution may use the exact Bind ledger through the source-context owner's typed
port without moving block dispatch authority or copying source context into
BlockDashboardAgent.

Tests cover the shared stores once for invariant behavior, then exercise each
host adapter in real workerd. Migration tests apply every consuming object's
complete ledger, pin historical migration hashes, run foreign-key checks, and
prove the indexes used by head reconstruction, range reads, active activities,
and provider-boundary lookup. At least one integration test commits a complete
Bind transition through each participating host so shared unit coverage cannot
hide a broken object-local transaction or port adapter.

## Regional impact

AutomationAgent is a workspace-scoped product object. It is resolved only
through the repository's workspace Durable Object resolver, using the
workspace's immutable region and jurisdiction: US jurisdiction for Global,
European Union jurisdiction for EU. The object asserts its own jurisdiction at
construction. A request-controlled automation ID can never select a region.

Draft conversations, Bind ledgers, definitions, schedules, run history,
connector references, and delivery receipts remain in the workspace's region.
EU data has no Global fallback. Shared provider ingress may receive bytes at its
existing endpoint, but carries only the verified routing envelope to the owning
regional object under the current regionalization contract.

The Global inbound-email registry remains the sole cross-region authority. It
stores only the permanent address and opaque owner route needed to select the
regional object, not lifecycle, conversation, definition, or run content. A
draft receives no address. Activation and deletion preserve the existing
never-reuse/tombstone rules.

The merge deployment preserves the repository's EU-then-Global order because
Global binds the existing EU entrypoints. This change does not add or rename a
cross-region bridge entrypoint; the Global email bridge keeps its current wire
contract. The automation cutover step starts only after both regional deploys
succeed and pass their first health check, and it runs each workspace in its
immutable region. If implementation
does require a new bridge entrypoint, the one-merge rollout is invalid and must
be replaced by the documented three-stage bootstrap before shipping.

## Security and trust model

- The session fixes region and workspace before an AutomationAgent is resolved.
  The object records immutable workspace, region, and original-author identity
  and fails closed if a request disagrees.
- A renderer-provided first-prompt creation key is an idempotency input, not an
  automation identity or authorization capability. WorkspaceDO scopes its claim
  to the authenticated workspace and author; the server mints the automation ID,
  and replay by another principal cannot resolve or create that draft.
- Draft read and write access belongs only to the author. Suggested workspace
  scope grants nothing. Acceptance reauthorizes the selected principal and
  scope; later mutations recheck current membership and role.
- A conversation remembers attachment and connector IDs for continuity but
  never turns them into authority. Every tool call rechecks current ownership,
  workspace, lifecycle, grants, and resource inventory revision. Credentials
  remain in their connector authority and are not copied into AutomationAgent.
- User messages, connector/provider results, attachments, inbound email, and
  model output remain untrusted content. They do not become system instructions
  because the object stores them durably.
- Tool receipts preserve the existing read/write classification,
  authorization-before-effect, idempotency, ambiguous-write, replay, and audit
  contracts. Recovery may repeat a safe read; it does not blindly repeat an
  unresolved write.
- Workspace projections contain only list/routing fields plus the frozen
  accepted evaluator configuration required to decide external events. They
  contain no draft conversation, compiler or generated-run prompt, attachment
  content, connector credential, tool result, or generated transcript. Current
  object authority is checked before a projection leads to sensitive disclosure
  or mutation.
- Evaluators can inspect only the closed, manifest-declared context for their
  exact connector event type. Raw provider bodies, arbitrary metadata, subject
  and actor records, transcript text, and credentials cannot become evaluator
  attributes. Unknown fields, operators, schema versions, and same-version hash
  conflicts fail closed at the receiving boundary.
- A manifest-declared sensitive content field is bounded at normalization and
  remains regional. It may be read in-place for evaluation but is excluded from
  evaluator projections, candidate indexes, receipts, Queue and DLQ messages,
  logs, and telemetry. Declaring one content field never admits the enclosing
  raw message, page, note, or transcript body.
- Person predicates store canonical Rally person IDs selected through the
  directory, never names or email addresses. Resource selectors store canonical
  workspace resource IDs and match normalized relationships, never mutable
  provider names, URLs, or unreviewed provider identifiers.
- Generated work-stream audience is independent of automation scope. A
  workspace automation may be discoverable to workspace members while each
  generated run remains private to its admitted participants. Readers recheck
  the authoritative SubstreamAgent audience before content is returned. A run
  participant who is not an automation viewer receives and may revisit the
  ordinary participant notification's direct work-stream URL; that route opens
  the child directly after SubstreamAgent admission and does not disclose the
  automation home or its other runs.
- A resource-update destination rechecks the authoritative SubstreamAgent link,
  watch flag, authority generation, and complete active-participant audience
  immediately before append. WorkspaceDO's inverted resource index is discovery
  only. Restricted activity is appended only when its audience contains the
  complete work-stream audience; one overlapping reader never suffices.
- External-event Queue messages contain identifiers and hashes, not provider or
  work-stream content. The consumer loads the bounded event projection from the
  regional WorkspaceDO only after it claims the stored destination receipt.
- Inbound-email runs retain sender validation and the restricted connector/web
  tool policy. Moving admission into AutomationAgent does not broaden what
  untrusted mail can invoke.
- Telemetry records lifecycle, latency, result class, turn bucket, trigger
  class, reconnect/resume outcome, and recovery counts without recording
  conversation text, prompts, questions, answers, compiler output, attachment
  content, tool arguments/results, or generated transcript.

## Agent behavior

This PRD changes the host and durability of the existing
`rally_automation_architect`. It adds the model-visible
people/resource resolver reads and `automation_set_evaluator_rules`, changes
`automation_submit_draft` into an honestly declared durable write, and gives
the automation host its own record-before-execute `core_request_elicitation`
definition without changing the shared provider-keyed work-stream definition.
It expands plugin inspection to descriptor V2, stores elicitation
separately from definition JSON, and limits executable connector tools during
compilation to reads. It does not add a plugin, expose internal
registration RPCs, or let the model write an accepted evaluator projection.
The architect keeps its strict submission result, request-scoped attachment
tools, connector discovery policy, structured elicitation wire schema,
narration rules, and inability to activate an automation itself.

The plugin contract remains canonical ID `rally:automation_architect`, model ID
`rally_automation_architect`, and Bind wire prefix `automation`. It is preloaded
only for an admitted draft compiler run in the authenticated author's frozen
workspace scope; it is unavailable to accepted runtime runs and ordinary work
streams. Preload installs the automation catalog and host-owned draft tools but
does not load a connector, contact a provider, create a schedule, accept a
draft, or persist anything beyond ordinary run admission. `load_plugin`
later activates only the connector read executors already present in the frozen
scope.

From the person's perspective, the architect gains durable continuity:

- progress and tool rows can be reattached to after leaving the builder;
- an elicitation remains answerable after restart;
- a recoverable run resumes from committed state;
- a failed run remains attached to the turn that caused it; and
- a concurrent send is refused as busy before a second compiler run starts,
  while the unsent composer text remains available to send afterward; and
- an active compiler run can be stopped without erasing its last durable result.

The host, not the model, chooses the AutomationAgent ID, author, workspace,
region, admitted attachments, connector catalog, account timezones, and
acceptance authority. Loading a connector plugin grants only the
frozen, reauthorized read capability surface for this compiler run. Trusted
inspection still shows write-tool schemas so the architect can name them in an
accepted automation definition, but the compiler host does not install their
executors. The architect may propose a definition but cannot perform a provider
write, install routes, choose final scope, accept the draft, create generated
work streams, or broaden a connector grant.

The automation compiler prompt says: “Search for every person or resource ID;
load and inspect every source plugin; never invent a manifest value. Replace the
complete evaluator set only when external-event rules changed, then submit the
definition. Submit `ready=false` before requesting input. Provider writes are
not available while drafting.” A first external-event definition therefore
requires `automation_set_evaluator_rules`; a later run inherits the prior
authoring set and need not reconstruct it when unchanged. For a manual- or
timer-only definition, submission clears prior evaluators without a model tool
call. The prompt also teaches that loaded provider tools are reads during draft
compilation and that write schemas describe future accepted-run capabilities,
not actions the architect may test. State-changing architect tool turns keep the
existing no-assistant-text rule. A validation rejection is repaired through the
tool's named issue path; it is not narrated to the person and does not erase the
last canonical compiled definition revision.

The shared runtime kernel is internal and introduces no model-visible wire
names. Each host's existing tool catalog and product policy remain distinct.

## Rollout

This ships as one implementation PR and one merge to `main`. That merge starts
one coordinated deployment workflow; there is no product feature flag,
per-automation authority flip, dual-write period, separately merged migration
release, or later cleanup PR. Temporary RPCs and legacy readers exist in the one
deployed build, are callable only under the cutover fence, and become inert—not
deleted code—after the workspace completion receipt.

1. Treat completion of
   `docs/PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md` as a hard
   precondition. Do not merge this implementation while that `state.md` remains
   incomplete. Build AutomationAgent only against the installed ordered-turn
   substrate and exact Bind projection.
2. The implementation PR adds the evaluator/descriptor/resolver contracts,
   AutomationAgent, shared transcript/Bind capabilities, destination engine,
   generated-run context/projections, migration RPCs, and shared desktop
   conversation family. It also updates every caller of the legacy table set
   enumerated by `workspace-runtime-database.ts`, including API services,
   `packages/db/src/index.ts`, seed data, dev routes, telemetry attribution,
   Slack services, inspector provenance, and tests. No generic SQL compatibility
   reader may reach a removed table after cutover.
3. The deployment preserves EU-then-Global order. Before the EU deploy, a
   read-only preflight enumerates regional D1
   workspaces and uses the existing migration-command Queue to wake each one on
   the old build; it refuses deployment unless every pre-existing WorkspaceDO
   has a historical migration ledger. This makes “no ledger” an unambiguous
   fresh-object signal for the new current-schema bootstrap. After both Workers deploy,
   the existing `Verify regional health` step runs against the new build. A
   later step in that same `deploy` job—not a separate job interleaved between
   deploy steps—runs a checked-in cutover script. The script enumerates each
   region's workspaces from regional D1 and submits idempotent commands through
   the existing regional migration-command Queue to a new typed WorkspaceDO
   cutover RPC. It adds no public or Access-gated one-time HTTP route. The
   per-workspace ledger records audit, fence, snapshot, imported IDs/hashes,
   cleanup, and completion. `deploy-api-workflow.test.mjs` pins health before
   cutover and final post-cutover health after it.
4. Before fencing a workspace, the deploy step records a run-time Global/EU
   source witness containing the exact draft, `error`, unsupported-trigger,
   active-lease, and accepted-automation IDs and canonical hash. Draft count is
   not a checked-in defensive limit: every witnessed draft is intentionally
   deleted, while every witnessed accepted automation is imported or preserved
   paused with attention under the rules below. A fresh object-local source
   audit must equal that witness immediately before the fence or the workspace
   is retried from a new witness; no repair merge is required. The
   `beginAutomationCutover` transaction closes a WorkspaceDO-enforced gate over
   every legacy writer of `automation_subscriptions` and its descendants,
   including create/save/promote, patch, pause/resume, archive, share,
   template-version adoption, manual/scheduled/activity run admission, and
   inbound-email receipt claims. Generic and typed WorkspaceDO mutation ports
   refuse writes to those tables after the fence, so a caller that read old
   state before an `await` cannot commit late. No Global address claim begins
   for a fenced workspace. The transaction disables automation schedule rows
   and re-derives the alarm, waits for existing compiler/run/email leases to
   settle, and stores new trigger IDs as deferred evidence. No Queue timing can
   create a legacy run after the fence.
5. WorkspaceDO emits one versioned source snapshot for every accepted
   subscription. AutomationAgent imports idempotently and returns canonical
   hashes and registration receipts. Import preserves IDs, lifecycle, resolved
   effective settings, schedules/cursors, routes, delivery, full memory contents
   and mutation receipts, resources, run history, email rate/lease state, and
   deduplication receipts. Unrepresentable triggers become paused attention,
   never broadened. Drafts are not imported; their audited IDs and any permanent
   address tombstones are recorded before deletion.
6. After every destination hash and registration agrees, the step invokes
   `finalizeAutomationCutover`. That explicit RPC deletes audited drafts and
   descendants, removes imported memory source rows, rebuilds `schedules`, and
   drops legacy child tables before parent tables. It records completion outside
   the removed schema. Ordinary WorkspaceDO construction never performs this
   cleanup.
7. The step activates final AutomationAgent routing, reconciles timers,
   evaluators, watches, email routes, occurrence keys, attention, reader and
   directory projections, then replays deferred trigger evidence through the
   new authority. It verifies both regions and only then runs the normal health
   check. A legacy draft cannot reappear because its rows are gone and the
   completed campaign refuses legacy readers/writers.

The workflow is restartable and roll-forward only. Before a workspace fence,
the new build continues serving that workspace through legacy readers. From
fence until final activation, that workspace's automations are intentionally
unavailable for reads and run admission; other workspaces continue normally.
Failure resumes from the durable campaign ledger—it does not mean a previous
deployment is still serving, and redeploying old code is not rollback. Once
cleanup begins, WorkspaceDO can never reopen as automation lifecycle authority.

## Acceptance

1. Select **New automation**, type without sending, and navigate away. Verify no
   AutomationAgent was created and no automation ID, WorkspaceDO directory row,
   or sidebar draft exists. Open the screen again, send the first prompt, lose
   the response, and retry with the same client creation key and message ID.
   Exactly one server-minted automation ID, object identity, human turn, and
   stable compiler run exist; the provisional first-prompt title is replaced by
   the compiled title. The `/automations/*` shell remains mounted while the URL
   adopts the ID. Close Rally during connector research, reopen it in
   another window, and observe that same ID, stable ordered turns and blocks,
   explicit loaded coverage, current checkpoint/event fence, and eventual
   result without duplicate tool effects. At each provider boundary, the
   AutomationAgent substrate reconstruction equals Bind's exact post-healing
   message state.
2. Force the first provider attempt to fail before valid draft submission. The
   Automations sidebar still contains one resumable draft with the original
   human turn and a retryable failure; retry does not create another draft.
3. Evict an object between run admission, a planned local write, its atomic
   state/terminal-receipt commit, an elicitation, output checkpointing, and
   terminal settlement. Each case recovers from the last committed boundary and
   reaches one coherent terminal state. Separately press **Stop** during an
   active compiler run; late provider output is fenced, committed receipts stay,
   and a new turn can start.
4. Submit turns simultaneously from two windows. Exactly one compiler run is
   admitted; the other submission is refused as busy before inference or tool
   execution and its composer text is preserved. After the first turn settles,
   submitting the second appends it after the canonical result and compiles
   against the complete current conversation. No whole-conversation write or
   stale window can erase either turn. Stop the busy run from either window and
   verify the preserved second composer can then submit.
5. Accept one draft concurrently from two clients. The automation keeps its ID,
   creates each schedule, address claim, table/memory definition, relationship,
   and delivery target once, and becomes active only after required routes are
   acknowledged.
6. Fail each first-activation side effect in turn. The UI keeps the automation in
   non-runnable `activating`, shows the safe error and retry action, and retry
   reconciles the recorded receipt. Deleting the failed activation cleans up
   live projections and tombstones permanent claims without reopening an
   editable draft; no partially activated automation runs. Pause the failed
   first activation and prove held receipts are refused. Repeat from resume:
   failure returns it to `paused` with the last working definition and run
   history, never delete-only.
7. Exercise calendar, interval, manual, activity, and inbound-email triggers
   through alarm retry, object eviction, Queue/provider redelivery, pause,
   resume, and deletion. Each logical trigger resolves to exactly one run and
   one generated work stream. Crash after occurrence admission but before child
   creation; the stored `run_provisioning` wake completes that same child.
8. Put multiple schedules, a due Bind recovery, an activation/projection retry,
   and maintenance work on one AutomationAgent. Verify the inherited
   multi-alarm base runs them in effective-time order, isolates one entry's
   failure behind its own gate, survives cancellation between pre-work and
   post-work arms, reconciles recurring schedules after they advance, and
   removes the native alarm when no wake reason remains. Include stored
   `run_provisioning` and inbound-email lease recovery. Prove each stored lane
   that can fail or decline is independently stall-gated. Prove Bind dispatch
   derives from durable dispatch rows, that an in-flight
   compiler dispatch is not reclaimed by the same alarm drain and that a
   cancelled drain is rediscovered by the base's recovery arm.
9. Accept connector events into WorkspaceDO, leave their ID-only messages in an
   ingress backlog, then install an evaluator generation. Events accepted at or
   below the returned `effectiveAfterEventSequence` never match even when
   processed afterward. Separately leave a provider event in the first Queue
   stage until after activation and prove its later WorkspaceDO acceptance may
   match. Deliver one later matching accepted event both before and after the local active
   commit. Events at or below `effectiveAfterEventSequence` never match; the
   later event is durably held when it arrives during activation and is admitted
   exactly once after activation. Queue timing cannot change its outcome, and
   there is no visible-active interval in which the automation is absent from
   routing.
10. Verify every generated run is private by default, absent from the global
    work-stream sidebar/public directory, and present exactly once in the paged history
    on its automation home only for readers admitted by the hidden content-free
    projection. The list contains no child title, result text, or participant
    identity. Opening it serves content only after current
    SubstreamAgent audience authorization even when AutomationAgent or
    WorkspaceDO projection data is stale. A `needs_input` child creates an
    automation item in the workspace **Needs attention** surface.
11. Make WorkspaceDO projection delivery fail. Direct overview, lifecycle, and
    trigger decisions remain correct; projection replay catches up
    monotonically without replacing newer state.
12. Run the ordered transcript substrate conformance suite against
    SubstreamAgent and the draft-state AutomationAgent adapter, including exact
    Bind reconstruction, stable turns/blocks, empty and shortened ranges,
    snapshot fencing, active checkpoints, reconnect, activity timing, and
    restricted-payload non-disclosure. Separately run the shared Bind capability
    suite against SubstreamAgent and AutomationAgent, including lease loss,
    receipt replay, ambiguous write, checkpoint recovery, cancellation, and
    terminal repair. Prove BlockDashboardAgent adopts none of these modules and
    its existing dispatch/checkpoint/settlement tests remain unchanged.
13. Seed visible `active`, `paused`, and `error` subscriptions plus visible and
    archived drafts, semantic/webhook/non-scalar triggers, memory items/table
    rows/cells/mutations, email rate windows, and live routes in Global and EU,
    then run the one merge-triggered cutover.
    Every accepted automation exists once in its named AutomationAgent with
    unchanged ID, address, settings, next occurrence, history, and receipts;
    legacy `error` and unrepresentable triggers are paused with distinct safe
    attention records and cannot run; effective settings, full memory contents,
    email budget/lease state, and route tombstones match; every legacy draft and
    draft-only dependent row is absent; and no content or telemetry crosses the
    EU boundary. Change a reviewed draft count and prove cleanup fails closed
    before deletion.
14. Inspect emitted analytics and logs for all flows above and verify that no
    conversation, prompt, elicitation text/answer, attachment content, tool
    argument/result, or generated transcript is present. Verify terminal-run and
    tool telemetry still carries automation ID and trigger type from
    `AutomationRunContextV1`, and client conversation telemetry uses the real
    automation conversation ID rather than a fabricated work-stream ID.
15. Delay, duplicate, reorder, and hash-conflict child run projections. The
    automation home may lag but never regresses, a same-version hash conflict
    returns terminal `rejected`, acknowledges the child outbox, and records
    attention rather than retrying into the DLQ. A terminal projection names only a committed final turn, and
    no child transcript or audience fact appears in AutomationAgent. A normal
    follow-up after terminal does not reopen the occurrence.
16. Prove the ordered-turn companion PRD is completed before this merge and the
    implementation consumes its schema and terminal-turn contract. No AutomationAgent code
    reads or writes the removed run-level aggregate transcript protocol, and
    no migration path imports legacy `draft_conversation_json` or retains it as
    a readable or writable fallback.
17. Parse table-driven legal and illegal evaluator fixtures at every boundary,
    beginning with `automation_set_evaluator_rules`. Reject unknown schema
    versions and keys, empty groups and values, duplicate authoring keys, IDs and
    source tuples, non-finite numbers, mismatched field kinds, unsupported
    operators, undeclared attributes, wrong plugin/connection/event pairs, stale
    projection versions, and same-version hash conflicts. Demonstrate that
    production evaluator APIs cannot receive an unbranded raw object.
18. Evaluate non-recursive DNF predicates for string, number, boolean, string-
    array, person, and presence attributes. Verify case-sensitive comparisons,
    no coercion, and that a missing attribute makes every non-presence positive
    and negative leaf false. `presence.not_exists` alone matches absence. A false
    predicate must return `no_match`, and evaluator processing must never invoke
    model inference.
19. Ingest representative Gmail connector `email.received`,
    `linear.issue.update`, and
    `note.generated` events. WorkspaceDO evaluates only manifest-declared
    context, stores one delivery receipt per evaluator revision, and sends an
    ID-only wake-up. Queue duplication, reordering, object eviction, and stale
    evaluator delivery create at most one automation occurrence. Make two rules
    in the same automation match one Linear event and verify the unique
    `(automationId, workspaceEventId)` key still creates one run. A later
    registration generation does not replay the old event implicitly.
20. Prove a weekday 9:00 AM America/Los_Angeles timer across daylight-saving
    transitions is calculated, armed, recovered, and admitted entirely by
    AutomationAgent. No timer evaluator or timer occurrence is written to or
    delivered by WorkspaceDO. Resume after several missed occurrences and
    verify the first due time is strictly after resume with no catch-up run;
    verify no planned work stream is pre-created before its due time.
21. Attach one provider resource to two work streams, enable both watches, and
    configure an automation for the same update. One canonical WorkspaceDO event
    enters one candidate/evaluation engine and creates exactly three typed
    destination receipts: one automation occurrence and one connected-activity
    message in each work stream. No legacy direct-watch scan or second event copy
    participates.
22. Duplicate and reorder the watched-link projection, Queue wake-up, child
    append result, and WorkspaceDO acknowledgement. Each work stream contains
    one update. Disable or detach the watch, archive the work stream, or advance
    its authority generation while a delivery is pending; the destination
    recheck appends nothing and settles a terminal safe refusal rather than
    retrying forever.
23. Route workspace-visible and restricted resource updates into personal and
    workspace-scoped watched work streams. The append succeeds only when the
    canonical event audience contains every current active participant. Prove
    that a stale WorkspaceDO resource-link projection, one overlapping reader,
    or an ID-only Queue message cannot disclose the event. Contract tests prove
    the published Queue message contains identifiers and hashes only; the
    regional manual rehearsal inspects DLQ replay because workerd cannot read a
    hosted dead-letter queue.
24. Compile and evaluate table-driven fixtures for every row in the required
    conformance vocabulary: Slack channel messages and `foobar` content; Linear
    project and project-ticket changes; Granola note creation globally, in a
    folder, and involving a selected person; GitHub pull-request opened/merged,
    release published, and repository created; and Notion page created/updated,
    selected-person comment, and selected-page comment. Each accepted intent
    expands to the exact event types, resource selector, and typed predicates
    stated in the table and creates one delivery per logical event.
25. Attempt to accept each conformance trigger with its required event family,
    field, relationship, or external-identity mapping removed from the connector
    manifest/normalizer. Review reports that trigger as unsupported and
    activation refuses it. Restore the declaration, accept the automation, then
    add a new event type to its named family; the active evaluator snapshot does
    not broaden. A newly authored automation may inspect and accept the expanded
    family, but the existing accepted automation remains frozen because active-
    definition editing is outside this PRD.
26. Evaluate a Slack message containing `foobar`, one without it, uppercase
    `Foobar`, and missing `messageText`. Only the exact lowercase substring
    matches. Verify the bounded message text never enters an evaluator
    projection, index, receipt, Queue or
    DLQ message, log, or telemetry event. Repeat person and resource fixtures
    across provider renames; canonical IDs continue to match, while unresolved
    or ambiguous people and absent resource relationships fail closed.
27. Inspect each migrated WorkspaceDO after explicit cleanup and one WorkspaceDO
    first created by the new build through the current-schema bootstrap. The former
    subscription,
    run, delivery, email-receipt/rate-window, and automation-resource tables do
    not exist; `schedules` has no automation-subscription branch; imported or
    discarded automation-owned memory rows are absent; connector and digest
    schedules still work; foreign-key check passes; child tables were removed
    before parent tables; and the shared template catalog contains no row that
    was reachable only from a deleted draft. Exercise the final API and prove no
    request can read, write, or recreate the removed schema. Both paths expose
    the same final surviving table, index, constraint, and identity-trigger
    shape, and the fresh object never creates a legacy automation table.
28. Interrupt the merge workflow before import, during an idempotent import,
    after all import receipts, and after WorkspaceDO cleanup. Before cleanup it
    resumes without duplicate AutomationAgents or triggers; after cleanup it
    rolls forward without reopening legacy authority. At no point does the
    serving product dual-write or expose a per-automation authority flag, and
    the completed implementation requires no follow-up cleanup merge. Prove an
    ordinary object wake before cleanup cannot drop a source table. Prove
    EU-then-Global deploy ordering and that the cutover step starts only after
    both succeed and pass health.
29. Run the architect through a timer-only draft, one exact event, one event
    family, DNF predicates, a selected person/resource, and an edit from
    event-driven to timer-only. External-event drafts call
    `automation_set_evaluator_rules` before `automation_submit_draft` on the
    first external definition; same-turn writes execute in model-declared order
    and submit rejects a missing set; receipt replay returns the same durable
    result; and a later successful
    set replaces rather than appends. Advertise evaluator, submission, and
    elicitation mutations as `mode: "write"` with
    `idempotency: "record_before_execute"`, and prove their advertised
    JSON Schemas and strict runtime parsers accept and reject the same fixtures.
    Repeating an identical submission under a new provider call returns the
    existing compiled revision, while changed canonical input creates exactly
    one later revision. Timer-only and manual-only drafts make no evaluator tool
    call, and submission atomically clears any evaluator set from the preceding
    definition. Start a later run from an unchanged event-driven draft and prove
    the inherited authoring set is available without re-staging. Reject an
    external-event submission when neither an inherited nor newly staged set
    exists, when a ready trigger references a missing or incompatible evaluator
    key, or when an evaluator is unused. Submit a partial definition,
    request structured elicitation, restart, and verify the pending question is
    linked to that definition revision but absent from definition JSON; its
    answer is a new human turn and cannot satisfy a replaced or settled
    elicitation. Refuse elicitation after `ready=true` and refuse acceptance
    while an elicitation is pending. Search ambiguous people/resources, inspect
    a connector with read and write tools, load it, and
    prove reads remain executable while no provider write executor is installed
    or invoked. Prove that draft tools perform no connector effect or WorkspaceDO
    write and that acceptance, not the model, resolves connections and mints
    canonical evaluator identities and projection metadata.
30. In the Electron client, render equivalent settled, streaming, failed, and
    elicitation transcripts through WorkstreamScreen and the Automation Draft
    Wizard. Verify both use the same feed/block/composer implementations for
    Markdown, attachments and preview, thought/tool rows, work timing,
    streaming reveal, loading/error states, history paging, prepend scroll
    preservation, the shared 80-pixel follow threshold and **Jump to latest**,
    keyboard/send behavior,
    dictation, file paste/drop, and local draft recovery. The new-automation
    first send must adopt the durable ID through the persistent
    `/automations/*` shell without remounting the conversation or
    losing text typed during the request, staged attachments, focus, or scroll
    state. Assert that `draft-keys.ts` transfers the new-route text and
    `use-file-attachments.ts` re-keys staged files before the old key is
    cleared. Workstream-only participant/unread/resource/run controls and
    automation-only template/review/acceptance controls must remain absent from
    the other adapter; both adapters retain their own stop/retry capability.
    Component tests prove common fixtures exercise the same
    shared components, and real-window screenshots verify the visible states;
    no `AutomationMessageBlock`, wizard-only feed loop, or second composer
    assembly remains.

31. Admit a run and verify `AutomationRunContextV1` alone supplies its effective
    prompt settings, delivery destinations, execution principal, trigger
    attribution, and parent memory reference after legacy tables are gone. Read
    and mutate imported memory items and table rows from the child through the
    fenced AutomationAgent RPC; verify mutation replay is idempotent and result
    delivery is sent by the child while only its receipt reaches the parent.
32. Delete an active automation with generated runs. The confirmation explicitly
    says those run work streams are deleted; the parent tombstone, child
    deletions, hidden reader projections, attention items, alarms, evaluator
    routes, and Global email tombstone converge without leaving an inspector or
    sidebar link to an orphan. A generated child's immutable origin projection
    provides automation name/scope/trigger provenance while the parent exists.
33. Layer migration verification honestly: real-workerd tests cover per-object
    fence/import/cleanup RPCs and restart cursors; `pnpm test:scripts` proves
    deploy-step ordering. A checked-in script test injects interruption after
    audit, fence, import, and cleanup receipts and proves restart from each
    cursor. A named manual Global/EU rehearsal proves regional enumeration,
    residency, Queue/DLQ operation, and health; workerd fixtures add the Queue
    consumers and DLQ bindings needed for destination-delivery cases rather
    than claiming the current producer-only test config proves them.
34. In the implementation change, create or update the owning module documents
    and newest-first changelogs for automation lifecycle/drafts, agent harness
    and tools, Durable Object alarms/migration tracking, data model, work-stream
    Durable Objects, connectors, regionalization, telemetry, composer drafts,
    transcript scrolling, and the shared renderer conversation surface. Register
    any new module document in `docs/README.md`; update `docs/e2e.md` and the
    runbook for the manual cutover and DLQ replay.

## Open questions

None. The implementation plan may choose concrete class, table, RPC, and event
names, but it may not move the authority boundaries or weaken the lifecycle,
privacy, activation, and recovery behavior above without recording a product
decision in this PRD's decision log.
