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
automation architect begins its first compiler run. It owns the automation's
canonical identity and lifecycle from that point onward:

```text
draft -> activating -> active <-> paused
draft -> archived
activating -> needs_attention -> activating
needs_attention -> draft  (only before irreversible registration)
active -> deleted
paused -> deleted
```

`needs_attention` is non-runnable activation state, not an active automation or
an editable compiler draft. It may return to `draft` only when cancellation can
prove that no irreversible registration was installed.

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

Acceptance changes the state of that same object. It freezes the accepted
definition, validates the selected scope and authority, installs required
trigger registrations, and moves through `activating` to `active`. It does not
copy the draft into a different owner or mint a replacement automation. The
draft conversation stops being editable and is not used as runtime prompt
context after acceptance.

The AutomationAgent owns automation-local trigger admission, scheduling,
idempotency, run history, configuration, pause/resume, and delivery receipts.
It extends Rally's existing `ScheduledDurableObject`, so calendar occurrences,
Bind recovery, activation reconciliation, outbox retry, and maintenance share
the repository's SQLite-backed multi-alarm index rather than competing for the
one native Cloudflare alarm or reimplementing its drain and recovery rules.
It does **not** execute the generated automation's work. Each admitted trigger
creates one private work stream by default, and that work stream's main
`SubstreamAgent` owns its transcript, participants, Bind loop, tools, resources,
and live stream under the ordered-turn contract. These generated work streams
do not appear in the global work-stream sidebar or directory. The automation
home reads a paged run-summary list from AutomationAgent and opens the child
work stream only when a person chooses a run.

WorkspaceDO remains the workspace control plane and the canonical processor for
external connector events. It keeps queryable, monotonic projections for the
sidebar and activity-trigger evaluation, as well as shared template catalogs,
connector resources, membership, and other workspace-wide authorities. Each
AutomationAgent publishes a versioned, type-safe evaluator set that tells its
WorkspaceDO which canonical Gmail, Linear, Granola, or other external events are
candidates for that automation. WorkspaceDO evaluates those rules beside the
event authority and delivers only durable, idempotent matches to the
AutomationAgent. Calendar and interval timers never enter that evaluator set;
the AutomationAgent schedules them directly through its inherited multi-alarm
index. The same WorkspaceDO evaluator index, match receipt, outbox, and ID-only
Queue wake-up also deliver a canonical resource update to each work stream whose
authoritative resource link has registered a watch. Only the destination adapter
differs: an automation match calls AutomationAgent admission, while a resource
watch appends one idempotent connected-activity update to the watched work
stream after a current audience check. A projection can locate or wake a target;
it cannot authorize a sensitive read or mutation on the target's behalf.

SubstreamAgent, BlockDashboardAgent, and AutomationAgent share one extracted
durable Bind runtime kernel: schema fragments, migrations, run admission and
leases, provider attempts, tool receipts and checkpoints, streaming
checkpoints, recovery, and terminal settlement. They do not share a database or
product authority. Each host supplies its own prompt, tools, authorization,
context projection, lifecycle policy, and result publication. The ordered
transcript substrate is a separate composable module used only by an authority
that saves a replayable LLM conversation: SubstreamAgent and the draft-state
AutomationAgent use it; BlockDashboardAgent continues to retain derived block
dispatch/output state and reaches its source transcript through SubstreamAgent.

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
   presents both windows as editing the same durable draft.
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

## Goals

1. Give an automation one stable ID and one canonical regional owner from the
   first submitted wizard turn until archival or deletion.
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
   than the global work-stream sidebar or directory, without weakening direct
   child authorization when a run is opened.
10. Adopt the ordered transcript substrate for the canonical draft wizard
    conversation and its exact Bind state, and extract a shared durable
    Bind/SQLite kernel used by SubstreamAgent, BlockDashboardAgent, and
    AutomationAgent while preserving their different authorization, context,
    and publication contracts.
11. Preserve personal-draft privacy, generated-run privacy, regional residency,
   inbound-email defenses, and content-free product telemetry.
12. Move existing drafts and active automations without changing their IDs,
    schedules, permanent email addresses, version pins, run history, or effective
    user settings, and without admitting a trigger twice.
13. Replace untyped deterministic activity-filter records with a closed,
    versioned evaluator grammar whose structure is parsed at every wire and
    storage boundary and whose fields and operators are validated against the
    exact connector event manifest before registration.
14. Reuse the external-event evaluator, receipt, outbox, and delivery engine for
    work-stream resource watches, without moving attachment/watch authority or
    transcript ownership into WorkspaceDO and without creating a second
    connector-event fan-out pipeline.

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
4. **Conversational editing of an active automation.** This PRD ends the
   editable draft conversation at acceptance. A future edit/revision workflow
   may start a new authoring session against the same AutomationAgent, but that
   is a separate product decision.
5. **Moving shared templates, connector credentials, workspace resources,
   identity, or membership into every AutomationAgent.** The object stores
   immutable references and frozen grants; shared authorities stay shared.
6. **Enumerating Durable Objects to build product lists.** The administrative
   namespace is not a product index. WorkspaceDO projections serve lists and
   fan-out.
7. **Changing template sharing semantics.** A template remains a versioned
   shared artifact. Adopting it creates one AutomationAgent for the resulting
   subscription; the template itself does not become an AutomationAgent.
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
11. **Using Cloudflare Flagship as the runtime or control plane.** Its ordered
    first-match rules, typed operators, missing-attribute behavior, stable
    context, and safe default inform the local grammar. Automation routing stays
    regional and workspace-authoritative, and this PRD does not add a Flagship
    binding, percentage rollout, or remote flag dependency.

## Product behavior

### Starting and returning to a draft

Selecting **New automation** creates an AutomationAgent and a personal sidebar
draft before starting the first compiler run. The server, not the renderer,
mints the ID. The URL adopts that ID immediately, and all later requests name
the same object.

Submitting a turn durably appends the person's message and admits a compiler
run before provider work begins. The builder then renders a snapshot followed
by live sequenced changes. Navigating elsewhere, closing the window, losing the
SSE connection, or restarting Rally does not cancel the admitted run. Reopening
the draft shows:

- every settled human and Rally turn in canonical order;
- the latest compiled definition and whether it is ready to accept;
- an unanswered structured elicitation, if one is pending;
- the current narration/tool checkpoint and run status when work is active;
- a terminal failure with a safe retry action when work stopped; and
- any attachment identities associated with their original turns.

Those rows are projections of the same canonical turn/block facts and exact
Bind transitions defined by the ordered-turn substrate. A human or assistant
turn has a stable identity; assistant text, thinking, and tool activity retain
their model-declared order; mutable tool/activity lifecycle changes update that
identity rather than creating a competing row. Wizard boot and reconnect use
explicit half-open coverage, an active checkpoint, and one durable event fence.
Because a draft has one author and no collaborative unread state, its initial
unread slice is normally `null` with `unreadReason = no_unread`; the latest
slice and active state still come from the same snapshot. Leaving and returning
therefore exercises the same lossless transcript/reconnect contract already
implemented for work streams, with an AutomationAgent-specific authorization
and presentation adapter.

An interrupted provider request can restart from the last committed Bind
boundary; Rally does not claim to resume the provider's exact network stream.
Durable tool receipts prevent a recovered run from blindly repeating a known
effect. The same socket remains subscribed after a canonical snapshot so newer
events do not fall into a snapshot/reconnect loop.

A failed first compile therefore remains a real, named draft. Its human message
and failure state are present even when no valid compiled definition exists
yet. Retry creates a new attempt against that same turn and object; it does not
open a second draft.

### Ordering and concurrent windows

The AutomationAgent serializes compiler turns. Each submission names the draft
revision it was composed against and is admitted only if that revision is still
current and no earlier turn is active. A stale or concurrent submission is
refused before inference or tool execution, and the client reloads the
canonical conversation. Rally never resolves a conflict by overwriting one
accepted conversation with another.

Answering a structured elicitation is a new, revision-fenced human turn. A
submitted answer is idempotent by its client message ID, so reconnect and retry
cannot answer the same question twice.

### Reviewing and accepting

The review screen reads the current object revision and submits the person's
chosen scope, principal, connector bindings, schedule interpretation, model
override, resource relationships, memory/table definitions, and delivery
destinations against that revision. Suggested scope and destination remain
proposals until this action.

The AutomationAgent claims acceptance once. It freezes the accepted definition
and moves to `activating`. While activating:

- no compiler turn may rewrite the definition;
- no manual, scheduled, activity, or inbound-email trigger may start a run;
- calendar and interval schedules are made durable in the object;
- the WorkspaceDO sidebar projection and complete external-event evaluator
  snapshot are installed and acknowledged;
- the automation's permanent inbound email address is claimed in the Global
  registry; and
- every required registration records an idempotent receipt that can be
  reconciled after a partial failure.

The automation becomes `active` only after the registrations required by its
configuration are acknowledged. The UI keeps the same row and ID and shows an
activating state rather than reporting success early. Repeating the accept
request returns the same result. A recoverable activation failure leaves the
same non-runnable object in a reviewable `needs attention` state with the
failure named; retry moves it back through `activating`. An ambiguous external
registration remains `activating` until reconciliation determines its result.
The object returns all the way to editable `draft` only when cancellation can
prove that no irreversible registration was installed.

The conversation remains canonical while activation is incomplete so a
reviewable failure still has its authoring context. The commit to `active`
retains the frozen definition and acceptance receipt and deletes the draft
conversation, matching today's post-promotion retention behavior. The active
automation never prompts a generated run with the authoring discussion, and
the transcript is not copied to WorkspaceDO or Global storage for convenience.

### Active lifecycle and triggers

An active AutomationAgent serves the automation overview and owns pause,
resume, archive/delete, definition/version adoption, next-run state, and run
history. A paused, archived, deleted, draft, activating, or `needs_attention`
object rejects every run trigger even if a stale projection routes one to it.

- **Calendar and interval:** each canonical schedule is mirrored as an indexed
  entry in `_internal_durable_alarms`. `ScheduledDurableObject` keeps the one
  native alarm pointed at the earliest effective instant across those entries
  and the object's other stored or derived wake reasons. Alarm delivery reloads
  the canonical schedule and definition and uses a stable occurrence key, so
  platform retries resolve to the same admitted run. Advancing, disabling, or
  deleting a schedule reconciles the index and re-arms before returning.
- **Manual:** the overview calls the object directly. A client idempotency key
  identifies the requested run.
- **External activity:** WorkspaceDO parses and persists the normalized event,
  selects evaluator projections by exact connection and event type, evaluates
  each ordered rule set once, and durably delivers an ID-only match receipt to
  each candidate AutomationAgent. Each object rechecks lifecycle, evaluator
  generation, event receipt, and frozen connector authority before admission.
  Activation does not report `active` until the evaluator snapshot has an
  acknowledged routing boundary, so an event cannot fall into a
  visible-but-unroutable gap. Semantic triggers use the same deterministic
  predicate as a prefilter and run their structured semantic gate only after
  that predicate matches.
- **Inbound email:** the Global ledger resolves the permanent address to region,
  workspace, and automation ID. The regional AutomationAgent rechecks active
  state, sender eligibility, receipt idempotency, and the existing restricted
  tool policy before it admits a run.

Admission creates or resolves one `automation_run` identity, then provisions
one generated work stream. If provisioning is interrupted, reconciliation
completes or compensates the one claimed run; retry does not leave an orphan
work stream or create a second one. The automation records the resulting work
stream ID as an opaque child reference. The SubstreamAgent becomes canonical
for everything inside that work stream.

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
failure. Queue delay can make the automation home stale but cannot mutate or
delay the child transcript. A later ordinary participant follow-up in the child
work stream does not reopen the automation occurrence; only harness runs
explicitly admitted as continuations of that occurrence may advance its
execution projection.

Pausing preserves schedules, address claims, and definition. It disarms run
admission, not identity. Its schedule entries are removed from the multi-alarm
index while the canonical schedule records remain paused, and it publishes an
empty evaluator snapshot after its local lifecycle fence rejects stale event
deliveries. Resuming revalidates required registrations, installs and receives
acknowledgement for the current evaluator snapshot, reconciles timer entries,
and re-arms before the object becomes active again. Deletion writes a durable
tombstone, removes every automation-owned alarm entry and live workspace
projection, and keeps permanent Global email claims tombstoned as they are
today.

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
semantic trigger that proposes “any connector” is not registered as a wildcard:
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
  rules: NonEmptyArray<{
    ruleId: ExternalEventEvaluatorRuleId;
    when: ExternalEventPredicateV1;
    result: "match" | "no_match";
  }>;
  defaultResult: "no_match";
  gate:
    | { kind: "deterministic" }
    | { kind: "semantic"; condition: NonEmptyString };
};

type ExternalEventPredicateV1 =
  | { kind: "always" }
  | { kind: "all"; clauses: NonEmptyArray<ExternalEventPredicateV1> }
  | { kind: "any"; clauses: NonEmptyArray<ExternalEventPredicateV1> }
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
    };
```

That AutomationAgent-owned envelope is one publisher's wire contract, not a
reason to build an automation-only matcher. WorkspaceDO compiles every accepted
automation evaluator and every watched work-stream resource link into the same
internal registration shape:

```ts
type WorkspaceExternalEventRegistrationV1 = {
  registrationId: WorkspaceExternalEventRegistrationId;
  registrationGeneration: ExternalEventRegistrationGeneration;
  sourceVersion: ExternalEventRegistrationVersion;
  sourceHash: CanonicalPayloadHash;
  evaluator: ExternalEventEvaluatorV1;
  destination:
    | {
        kind: "automation";
        automationId: AutomationId;
        authorityGeneration: AutomationAuthorityGeneration;
      }
    | {
        kind: "workstream_resource_update";
        workstreamId: WorkstreamId;
        substreamId: SubstreamId;
        authorityGeneration: WorkstreamAuthorityGeneration;
        resourceId: ResourceId;
      };
};
```

The internal type is produced only by the registry-aware compiler and is never
accepted directly from a request. For an automation, it preserves the authored
rules and deterministic or semantic gate. For a work-stream resource watch, the
existing versioned resource-link effect is the registration boundary:
`watchEnabled = true` compiles to the exact resource/connection/event source,
`always -> match`, `defaultResult = no_match`, and a deterministic gate;
`watchEnabled = false`, link removal, archival, or a new authority generation
removes or supersedes that registration. A connector that can report several
legal update event types produces one registration per exact event type. The
registration and evaluator identities are deterministic from the watched-link
identity, destination generation, and event type, so projection replay cannot
mint a second route. The watch may not add a semantic condition or arbitrary
predicate because the person's decision was to receive updates for that named
resource, not to create
a second hidden automation.

WorkstreamDO/SubstreamAgent remains canonical for the attachment and whether it
is watched. Its existing durable child-to-parent-to-WorkspaceDO resource-link
projection supplies resource ID, watch flag, source version, authority
generation, and hash. WorkspaceDO validates the projected resource against its
canonical resource/connection record and connector manifest before indexing the
registration. No request toggles a child flag and writes an evaluator row as one
pretended cross-object transaction; projection replay and same-version hash
fences reconcile the two authorities.

The TypeScript aliases illustrate the contract; checked-in strict Zod schemas
are the runtime authority. Every object rejects unknown keys. Empty strings,
empty groups, empty operator lists, duplicate evaluator IDs, duplicate rule IDs,
duplicate source tuples, non-finite numbers, and invalid revision or generation
identities are structurally invalid. The stateful receiver additionally rejects
a lower projection version and treats the same version with a different hash as
an integrity failure. Array order is rule priority: WorkspaceDO evaluates rules
from first to last and stops at the first result. If no rule matches, the only
legal default is `no_match`. An `always` predicate makes a catch-all explicit.
There is no general `not` node; negative leaf operators preserve the field's
type and avoid inventing ambiguous negation semantics for a missing value.

All string comparison is case-sensitive and performs no trimming, locale
folding, parsing, or scalar-to-array coercion. A missing attribute makes every
leaf predicate false, including `not_equals`, `not_in`, and `has_none`; missing
data never turns an exclusion into a match. `all` matches only when every child
matches, and `any` matches when at least one child matches. The evaluator is run
once against one immutable event context and one immutable evaluator revision;
it cannot observe a value changing between rules.

Structure alone cannot prove that an attribute belongs to a dynamically
registered connector event. Registration therefore has a second contextual
parser. For each evaluator it resolves the exact connector manifest and rejects
the snapshot unless:

- the connector, connection, and event type exist, agree with one another, and
  are in the automation's frozen accepted bindings;
- an optional resource exists in WorkspaceDO, belongs to that connection, and
  is a legal resource target for the event;
- every attribute is declared in that event type's
  `ConnectorActivityTriggerDescriptor.filterFields`;
- predicate `kind` equals the field's declared `valueType` and the selected
  operator is legal for that kind; and
- the same automation generation has not already supplied the same projection
  version with a different canonical payload hash.

The successful result is a branded `ValidatedExternalEvaluatorSet`, and
internal compilation, persistence, projection, and evaluation APIs accept that
type rather than the raw wire type. Serialization erases the brand, so the
receiver parses again. Validation occurs when the architect submits a draft,
when acceptance resolves the proposed source binding to a connection, when
AutomationAgent reads or writes its SQLite record, on every
AutomationAgent-to-WorkspaceDO projection RPC, when WorkspaceDO reads or writes
its evaluator index, and before an evaluator is executed. A malformed stored
row is an integrity failure and fail-closed registration, never an empty filter
or a permissive fallback.

Normalized connector events retain their existing broader canonical evidence,
but evaluation sees a separate closed context containing only fields declared
for that exact connector event type. The connector normalizer creates that
context, and WorkspaceDO parses it against the same manifest descriptor at
ingress and again when loading it for processing. Evaluators cannot use dotted
paths or spread arbitrary `metadata`, `subject`, `actor`, provider payload, or
transcript content into their context. If a product needs “Linear ticket state
changed,” for example, the Linear descriptor first declares typed fields such
as `changedFields: string_array`, `previousStateId: string`, and
`stateId: string`; only then can an accepted evaluator refer to them. A new
Gmail or Granola field follows the same manifest-first path.

Representative compiled rules are intentionally small:

| Intent | Exact source event | Ordered filter |
| --- | --- | --- |
| Run for every new Gmail message | `email.received` | `always -> match` |
| Run when a Linear ticket moves to the configured completed state | `linear.issue.update` | `all(changedFields has "stateId", stateId equals "<accepted-state-id>") -> match` |
| Run for every new Granola transcript | `note.generated` | `always -> match` |

The Linear example is not legal until its manifest and normalizer declare and
populate those state fields. The accepted state ID is a frozen configuration
value, not a display name resolved differently on each event.

The deterministic grammar borrows Cloudflare Flagship's
[ordered first-match rules and nested conditions](https://developers.cloudflare.com/flagship/targeting/),
[type-specific operators and missing-attribute behavior](https://developers.cloudflare.com/flagship/targeting/operators/),
and guidance to use a
[stable evaluation context and safe fallback](https://developers.cloudflare.com/flagship/best-practices/).
It intentionally does not copy Flagship's percentage rollout: random event loss
has no useful meaning for an automation trigger. Semantic meaning is also not
smuggled into a generic operator. A semantic evaluator first produces `match`
from the typed rules, then evaluates its non-empty natural-language condition
through the existing structured inference contract; only a true structured
result becomes a delivery.

Flagship's own numerical rule and nesting limits are platform constraints, not
Rally product requirements, so this PRD does not copy their values. If the
implementation adds a predicate-depth, rule-count, or payload-size ceiling for
resource safety, that ceiling and its refusal behavior require the repository's
separate defensive-limit decision; it cannot appear as an unexplained schema
number.

WorkspaceDO owns the evaluation and delivery transaction boundary:

```text
verified provider event or poll
  -> WorkspaceDO canonical event + parsed evaluation context
  -> exact (connectionId, eventType, optional resourceId) registrations
  -> ordered deterministic evaluation; optional semantic gate
  -> WorkspaceDO durable delivery receipt + outbox
  -> regional Queue ID-only wake-up
  -> destination adapter
       automation: typed AutomationAgent.deliverExternalEvent
       resource watch: audience recheck + typed SubstreamAgent append
  -> destination receipt + WorkspaceDO outbox acknowledgement
```

The wake-up contains opaque workspace event, registration, destination, revision,
and delivery-receipt identities plus a canonical hash, not the event body. A
consumer loads the still-authoritative delivery and event from WorkspaceDO,
then invokes the typed adapter named by the stored destination. The receipt is
unique for the workspace event, registration ID and generation, and destination
identity, while also pinning the evaluator source version/hash; Queue redelivery
cannot create a second automation occurrence or work-stream update.

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
allows the WorkspaceDO outbox row to settle without publishing twice.

An audience refusal, archived/deleted target, detached resource, disabled watch,
or stale authority generation is a terminal `not_delivered` receipt with a safe
reason code, not an append and not an infinite retry. A transient target or
transport failure leaves the shared outbox pending for retry. An evaluator or
watch update does not silently replay old events under new rules; an explicit
replay operation would be a separate product and authorization decision.

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

Shared template discovery remains in WorkspaceDO. Adopting a template pins or
copies an immutable template version into a new AutomationAgent. Publishing an
automation exports an immutable version to the catalog; it does not grant the
catalog authority over the source object's lifecycle or conversation.

Generated automation work streams publish no global-sidebar or general
work-stream-directory listability, even though their WorkstreamDO and
SubstreamAgent authority remain intact. AutomationAgent's object-local
`automation_run` rows are the paged source for the automation home: trigger,
planned/started/completed time, execution/attention/delivery summaries, and the
opaque child work-stream link. Opening a row resolves that named child and
performs current SubstreamAgent reader admission before returning transcript
bounds or content. The run list is therefore cheap and content-free; the
occasional drill-in remains authoritative and cannot be authorized by a stale
parent or WorkspaceDO summary.

### Offline and reconnect behavior

Unsent composer text continues to follow the desktop's existing local composer
draft behavior. Once the API has admitted a turn, it is server-owned work and
continues without the window. Reconnect never converts an uncertain submission
into a new automation: the client first resolves the AutomationAgent ID and
client message ID, then either observes the admitted turn or safely submits it.

## Impact on the product contract

The standing implementation brief does not need to change. This PRD refines its
existing requirements that automations are versioned subscriptions, persistent
work is durable, and every automation run owns exactly one work stream.

There are five deliberate visible improvements beneath that contract: a failed
first compiler turn is returnable, an admitted compiler run survives navigation,
concurrent windows conflict before model work instead of silently losing a
turn, the draft feed preserves ordered turns and reconnects through the shared
transcript contract, and generated runs move from the global work-stream sidebar
to a paged list on their automation home. Active automation semantics,
`You`/`Workspace` scope badges, generated work-stream privacy, and typed
authorized tool execution remain unchanged.

## Decision log

None yet.

## Key design decisions

1. **One object represents a subscription, not a template or a run.** A
   subscription is the thing with an owner, scope, trigger configuration,
   pause state, run history, and draft-to-active lifecycle. A shared template
   can have many independent subscribers, and a run already has its own work
   stream. *Rejected:* one object per template, which would couple unrelated
   subscribers; and one object per run, which would leave the automation itself
   without a durable owner.

2. **The object exists before compiler work starts.** This is what makes a
   failed first turn resumable and gives retries one idempotency domain.
   *Rejected:* allocate on the first successful compiled draft, which preserves
   today's gap while merely moving later rows.

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

5. **The Bind runtime is shared as a kernel, not as one database.** The common
   module owns schema fragments and state-machine operations for admission,
   leases, attempts, receipts, checkpoints, recovery, and settlement. Each
   product host supplies storage at the authority that owns the relevant
   context. Automation compiler rows live in AutomationAgent; work-stream rows
   live in SubstreamAgent; a block keeps its dispatch ownership in
   BlockDashboardAgent and reaches source-context Bind state through the main
   SubstreamAgent's typed local port. *Rejected:* copying the kernel three
   times, and relocating block source state solely to make the diagrams
   symmetrical.

6. **WorkspaceDO projections are indexes, not a second automation authority.**
   Lists and activity matching need workspace-shaped queryability; direct
   object reads provide current configuration and authorization. *Rejected:*
   enumerating the namespace, which is an administrative facility rather than
   a product query; and synchronous fan-out to every automation for each list
   or activity event.

7. **Draft turns conflict before inference.** A revision precondition plus one
   active turn produces a canonical order without paying for model work that
   cannot commit. *Rejected:* today's last-turn-wins behavior, and a post-run
   compare-and-swap that rejects only after research and tool calls have
   already occurred.

8. **The authoring conversation is not runtime context.** Acceptance freezes
   the resulting definition and receipt, then seals the conversation from
   active use. *Rejected:* retaining the full wizard conversation in every
   generated run's prompt, which adds private, irrelevant context and lets
   setup-time wording affect execution after the reviewed definition is fixed.

9. **AutomationAgent extends `ScheduledDurableObject`; it does not implement an
   alarm loop.** Canonical automation schedules are indexed as stored alarm
   entries. Bind dispatch/recovery, activation and projection retry, and
   maintenance expose their own stored entries or derived candidates according
   to the existing base-class rule. The base takes the earliest effective
   instant, performs the pre-work recovery arm, drains independently gated
   entries, detects a handler that made no progress, re-derives indexes, and
   re-arms exactly after work. *Rejected:* a bespoke automation alarm handler,
   which would duplicate behavior Rally already relies on; and keeping
   WorkspaceDO as canonical automation scheduler after moving definition and
   run admission, which would split the runnable decision across two
   authorities. The subclass supplies the existing hooks for candidates,
   entry handling, derived work, and index reconciliation. If its alarm drains
   a Bind dispatch lane, it also excludes an in-flight claimed run from the
   pre/post-work re-derivation just as SubstreamAgent does; it never bypasses
   the base with a second future-alarm derivation.

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
    generated children are absent from the global work-stream sidebar and
    directory. Selecting a run still opens its WorkstreamDO/SubstreamAgent and
    performs current child reader admission. *Rejected:* merging run transcripts
    into AutomationAgent merely because the global sidebar no longer lists
    them; navigation hierarchy does not change canonical content ownership.

14. **WorkspaceDO evaluates external events; AutomationAgent owns timers.** A
    connector event is already canonical, region-local workspace state, so its
    evaluator context and all candidate indexes stay beside that event. The
    AutomationAgent publishes its complete desired evaluator set and receives
    only durable matches. Calendar and interval occurrences derive from the
    accepted automation definition and remain object-local multi-alarm work.
    *Rejected:* waking every AutomationAgent for every workspace event, which
    turns unrelated objects into the query plan; and routing timers through
    WorkspaceDO, which splits schedule authority from run admission.

15. **Evaluator rules are a closed algebra with a manifest-validated context.**
    Ordered first-match rules and an immutable `no_match` default make exclusions
    and fallbacks explicit. Discriminated leaf types make illegal
    operator/value combinations structurally unrepresentable, while the
    registry-aware parser proves that a field belongs to the exact event source.
    *Rejected:* the current `Record<string, unknown>` plus JSON deep equality,
    arbitrary metadata paths, implicit coercion, and a generic operator/value
    pair. Each lets malformed or misspelled rules survive compilation and makes
    a connector schema change fail during event processing instead of at a
    boundary.

16. **Automation triggers and work-stream resource watches share event
    delivery infrastructure, not product authority.** WorkspaceDO compiles both
    into one typed registration index and uses one evaluation receipt/outbox
    engine. AutomationAgent still owns its evaluator set and occurrence;
    SubstreamAgent still owns its watched link, audience, and appended system
    message. *Rejected:* retaining the current direct-watch scan and append as a
    second fan-out loop beside automation evaluation, which would duplicate
    event/resource matching, retries, and receipts; and making WorkspaceDO's
    inverted link authoritative for the append, which would let a stale
    projection disclose restricted activity after participant or watch state
    changed.

## Data model

The exact table names belong to the implementation plan and migrations. The
authority split is fixed by this PRD:

| Authority | Canonical records |
| --- | --- |
| AutomationAgent SQLite | Immutable automation identity and workspace/region fence; lifecycle and revision; draft canonical facts plus author-visible `transcript_sequence` and restricted `loop_sequence` projections from the shared ordered transcript substrate; attachments, active checkpoints, activities, and event fences; compiled and accepted definition revisions; elicitation; local Bind runtime ledger; canonical timer configuration and due work; the shared `_internal_durable_alarms` index; the compiled external-event evaluator snapshot and projection receipts; run occurrence admission/idempotency/history plus content-free child execution projections and their receipts; automation memory/table definitions; resource and connector references; delivery targets and receipts; projection/registration outbox and receipts; tombstone. |
| WorkspaceDO SQLite | Automation directory projections; viewer visibility summaries; validated automation evaluators and watched work-stream resource registrations in one exact connection/event/resource candidate index; canonical normalized events and closed evaluation contexts; destination-typed evaluation delivery receipts/outbox; shared template/version catalog; connector connections and workspace resources; membership-derived routing inputs. |
| Generated SubstreamAgent SQLite | Ordered-turn canonical facts, participant transcript and restricted Bind-loop projections; participants and reader audience; run scope; Bind execution, tools, activity/checkpoints and output; authoritative work-stream resource links/watch flags and memory provenance; idempotent connected-activity message receipts; content-free automation-run and resource-link projection outbox. |
| Global control-plane D1 | Permanent inbound-email address route and tombstone, plus the existing region/workspace routing facts needed before a regional object can be selected. |

Object identity is derived from the existing automation subscription ID, so a
migrated automation keeps its public ID. References across objects are opaque
IDs, never SQLite foreign keys. No query or transaction crosses object
databases.

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
canonical source row and treats a cancelled, paused, superseded, or completed
source as a no-op. AutomationAgent applies the shared alarm schema through its
own append-only object migration history and inherits the migration readiness
gate from `ScheduledDurableObject`'s base.

Existing WorkspaceDO automation rows are imported into the named
AutomationAgent with their current definition, lifecycle, schedule cursor,
address, delivery configuration, memory/table definitions, run identities, and
receipts. The old rows become a frozen migration source and projection rather
than a writable fallback. There is no long-lived dual authority.

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

## Security and trust model

- The session fixes region and workspace before an AutomationAgent is resolved.
  The object records immutable workspace, region, and original-author identity
  and fails closed if a request disagrees.
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
  content, connector credential, tool result, or generated transcript. A
  semantic evaluator's accepted condition is stored because WorkspaceDO owns
  that gate; it remains regional product configuration and is excluded from
  logs and telemetry. Current object authority is checked before a projection
  leads to sensitive disclosure or mutation.
- Evaluators can inspect only the closed, manifest-declared context for their
  exact connector event type. Raw provider bodies, arbitrary metadata, subject
  and actor records, transcript text, and credentials cannot become evaluator
  attributes. Unknown fields, operators, schema versions, and same-version hash
  conflicts fail closed at the receiving boundary.
- Generated work-stream audience is independent of automation scope. A
  workspace automation may be discoverable to workspace members while each
  generated run remains private to its admitted participants. Readers recheck
  the authoritative SubstreamAgent audience before content is returned.
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
`rally_automation_architect`; it does not add a model-visible plugin or tool.
The architect keeps its current prompt, strict `submit_draft` result,
request-scoped attachment tools, connector discovery policy, structured
elicitation, narration rules, and inability to activate an automation itself.

From the person's perspective, the architect gains durable continuity:

- progress and tool rows can be reattached to after leaving the builder;
- an elicitation remains answerable after restart;
- a recoverable run resumes from committed state;
- a failed run remains attached to the turn that caused it; and
- stale concurrent input is rejected before the architect sees it.

The host, not the model, chooses the AutomationAgent ID, author, workspace,
region, admitted attachments, connector catalog, account timezones, expected
revision, and acceptance authority. Loading a connector plugin grants only the
same frozen, reauthorized capability surface it grants today. The architect may
propose a definition but cannot install routes, choose final scope, accept the
draft, create generated work streams, or broaden a connector grant.

The shared runtime kernel is internal and introduces no model-visible wire
names. Each host's existing tool catalog and product policy remain distinct.

## Rollout

The `automation-agent-authority` flag selects the object-owned path for new
automations and migration eligibility. It gates effective authority; it does
not rewrite stored user settings, scope, pause state, schedules, destinations,
or model overrides.

1. Land the 2026-08-26 coordinated breaking cutover from the ordered-turn PRD
   first. Its SubstreamAgent transcript substrate, exact Bind-loop projection,
   stable terminal turn references, activity/snapshot fences, and conformance
   fixtures are the baseline for this work. Do not build AutomationAgent
   against the aggregate run-level transcript protocol that cutover removes.
2. Replace `deterministicFilters` and `deterministicPrefilter` records with the
   strict predicate schemas and branded registry-aware compiler. Make connector
   normalizers emit a closed evaluation context for each declared event type;
   add descriptor fields such as Linear state-change attributes before any rule
   may reference them. Prove this conversion on the current Gmail, Linear, and
   Granola trigger fixtures without retaining an arbitrary-metadata fallback.
3. Extract the remaining durable Bind execution kernel behind existing hosts,
   proving no product behavior change in SubstreamAgent and
   BlockDashboardAgent. Add AutomationAgent as a `ScheduledDurableObject`
   subclass using the existing alarm schema and base-class lifecycle, and add
   its personal-author adapter to the ordered transcript substrate; no separate
   alarm or transcript framework ships.
4. Enable object-owned authoring for new internal drafts. Keep acceptance on the
   object path only; do not introduce a draft-only object that transfers back to
   WorkspaceDO.
5. Migrate existing drafts. Their IDs and saved conversations are normalized
   once into ordered canonical facts and exact post-healing Bind state in the
   named objects; migration verifies the canonical projection hashes rather
   than retaining `draft_conversation_json` as a fallback. In-flight
   request-scoped runs settle on the old path before the authority fence flips.
6. Add the full-snapshot AutomationAgent-to-WorkspaceDO evaluator projection,
   shared destination-typed registration compiler, exact candidate index,
   receipt-backed WorkspaceDO evaluation outbox, and ID-only delivery wake-up.
   The same-version payload hash fence and generation-aware destination
   admission must be live before any external activity automation or resource
   watch migrates.
7. Compile the existing versioned watched-resource link projection into the
   shared registration index and add its typed SubstreamAgent delivery adapter.
   Migrate the current direct-watch resource scan/append behind the same
   authority fence, then remove that parallel fan-out loop; do not retain it as
   fallback after the per-workspace cutover.
8. Migrate paused and manual-only active automations, then timer, external
   activity, and inbound-email automations. Each migration fences old trigger
   admission, imports and hash-verifies canonical state, arms object-local
   timers or acknowledges the external evaluator snapshot as applicable,
   updates the directory projection, and only then flips the per-automation
   authority marker.
9. Replace direct SubstreamAgent writes to workspace-owned `automation_runs`
   with the versioned child-to-AutomationAgent projection. Suppress generated
   children from global work-stream listability and make the automation home
   consume its paged object-local run list before enabling the new authority for
   active automations.
10. Reconcile schedule occurrences, evaluator delivery receipts, inbound-email
   receipts, and run idempotency keys across the cut so every trigger is either
   absent or present once. A migrated object never falls back to writable legacy
   rows.
11. After both regions have no legacy automation authorities and rollback
   evidence has expired, remove the WorkspaceDO canonical automation/schedule
   rows, old compiler endpoint, and compatibility paths. Keep only the new
   projections and shared workspace authorities.

Before an individual authority flip, rollback means abandoning the initialized
object and reopening the unchanged WorkspaceDO source. After the flip, rollback
means stopping migration and repairing/exporting that object's authoritative
state; the flag must not silently reopen a stale writer.

## Acceptance

1. Start a new automation, close Rally during connector research, reopen it in
   another window, and observe the same automation ID, stable ordered turns and
   blocks, explicit loaded coverage, current checkpoint/event fence, and
   eventual result without duplicate tool effects. At each provider boundary,
   the AutomationAgent substrate reconstruction equals Bind's exact post-healing
   message state.
2. Force the first provider attempt to fail before valid draft submission. The
   Automations sidebar still contains one resumable draft with the original
   human turn and a retryable failure; retry does not create another draft.
3. Stop an object between run admission, a tool receipt, an elicitation, output
   checkpointing, and terminal settlement. Each case recovers from the last
   committed boundary and reaches one coherent terminal state.
4. Submit conflicting turns from two windows. Exactly one is admitted; the
   other is refused before any inference or tool execution and reloads the
   winning revision.
5. Accept one draft concurrently from two clients. The automation keeps its ID,
   creates each schedule, address claim, table/memory definition, relationship,
   and delivery target once, and becomes active only after required routes are
   acknowledged.
6. Fail each activation side effect in turn. The UI shows `activating` or a
   reviewable failure, retry reconciles the recorded receipt, and no draft or
   partially activated automation runs.
7. Exercise calendar, interval, manual, activity, and inbound-email triggers
   through alarm retry, object eviction, Queue/provider redelivery, pause,
   resume, and deletion. Each logical trigger resolves to at most one run and
   one generated work stream.
8. Put multiple schedules, a due Bind recovery, an activation/projection retry,
   and maintenance work on one AutomationAgent. Verify the inherited
   multi-alarm base runs them in effective-time order, isolates one entry's
   failure behind its own gate, survives cancellation between pre-work and
   post-work arms, reconciles recurring schedules after they advance, and
   removes the native alarm when no wake reason remains. Prove that an in-flight
   compiler dispatch is not reclaimed by the same alarm drain and that a
   cancelled drain is rediscovered by the base's recovery arm.
9. Verify an activity arriving at the activation boundary is either outside the
   active contract or delivered once; there is no visible-active interval in
   which the automation is absent from routing.
10. Verify every generated run is private by default, absent from the global
    work-stream sidebar/directory, and present exactly once in the paged history
    on its automation home. Opening it serves content only after current
    SubstreamAgent audience authorization even when AutomationAgent or
    WorkspaceDO projection data is stale.
11. Make WorkspaceDO projection delivery fail. Direct overview, lifecycle, and
    trigger decisions remain correct; projection replay catches up
    monotonically without replacing newer state.
12. Run the ordered transcript substrate conformance suite against
    SubstreamAgent and the draft-state AutomationAgent adapter, including exact
    Bind reconstruction, stable turns/blocks, empty and shortened ranges,
    snapshot fencing, active checkpoints, reconnect, activity timing, and
    restricted-payload non-disclosure. Separately run the shared Bind execution
    kernel suite against SubstreamAgent, AutomationAgent, and the Block Dashboard
    source-runtime adapter, including lease loss, receipt replay, ambiguous
    write, checkpoint recovery, cancellation, and terminal repair.
13. Migrate representative drafts and every active trigger class in Global and
    EU. IDs, addresses, settings, next occurrences, history, and receipts are
    unchanged; no content or telemetry crosses the EU boundary.
14. Inspect emitted analytics and logs for all flows above and verify that no
    conversation, prompt, elicitation text/answer, attachment content, tool
    argument/result, or generated transcript is present.
15. Delay, duplicate, reorder, and hash-conflict child run projections. The
    automation home may lag but never regresses, a same-version hash conflict
    fails closed, a terminal projection names only a committed final turn, and
    no child transcript or audience fact appears in AutomationAgent. A normal
    follow-up after terminal does not reopen the occurrence.
16. Prove the implementation consumes the schema and terminal-turn contract
    installed by the 2026-08-26 ordered-turn cutover. No AutomationAgent code
    reads or writes the removed run-level aggregate transcript protocol, and
    draft migration does not retain `draft_conversation_json` as a writable
    fallback.
17. Parse table-driven legal and illegal evaluator fixtures at every boundary.
    Reject unknown schema versions and keys, empty groups and values, duplicate
    IDs and source tuples, non-finite numbers, mismatched field kinds,
    unsupported operators, undeclared attributes, wrong connection/event pairs,
    stale projection versions, and same-version hash conflicts. Demonstrate
    that production evaluator APIs cannot receive an unbranded raw object.
18. Evaluate nested first-match rules for string, number, boolean, and string
    array attributes. Verify case-sensitive comparisons, no coercion, and that a
    missing attribute makes positive and negative leaves false. No matching rule
    must return `no_match`; a semantic trigger must not call inference until its
    deterministic rules return `match`.
19. Ingest representative `email.received`, `linear.issue.update`, and
    `note.generated` events. WorkspaceDO evaluates only manifest-declared
    context, stores one delivery receipt per evaluator revision, and sends an
    ID-only wake-up. Queue duplication, reordering, object eviction, and stale
    evaluator delivery create at most one automation occurrence; a definition
    update does not replay the old event implicitly.
20. Prove a weekday 9:00 AM America/Los_Angeles timer across daylight-saving
    transitions is calculated, armed, recovered, and admitted entirely by
    AutomationAgent. No timer evaluator or timer occurrence is written to or
    delivered by WorkspaceDO.
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
    or an ID-only Queue message cannot disclose the event, and that no provider
    content appears in Queue or DLQ payloads.

## Open questions

None. The implementation plan may choose concrete class, table, RPC, and event
names, but it may not move the authority boundaries or weaken the lifecycle,
privacy, activation, and recovery behavior above without recording a product
decision in this PRD's decision log.
