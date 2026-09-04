# Durable automation lifecycle

An automation is one `AutomationDO` Durable Object and one conversation. The
object is a conversation parent, like `WorkstreamDO`: its substream `0` is the
automation's own chat, where the automation is drafted, created, and later
edited, and every run is a child substream under it. The object holds the
automation itself (lifecycle, immutable definition revisions, schedules, runs,
inbound-email receipts) and the shared parent tables its conversations report
into. Draft and active are lifecycle states of one object; applying a revision
mints no second id and copies no state anywhere.

`WorkspaceDO` keeps a content-free `automation_directory` row per automation,
published by the object through the same outbox its children's aggregates
travel through, plus the typed external-event registrations that fan a
connector event out to it. A directory row can locate an automation; it never
authorizes reading one.

Read this before changing automation routes, the drafting plugin, triggers,
schedules, runs, the result tool, or the sidebar row. The hierarchy an
`AutomationDO` sits in, the conversation-parent contract it implements, and the
effect pipeline its children use are owned by
[`workstream-durable-object.md`](workstream-durable-object.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/automation-do.ts` | The object: its v1 schema, `create`, `submitDefinition`, `apply`, `pause`, `resume`, `remove`, `setOwningRoomArchived`, `runNow`, `admitExternalEvent`, `admitInboundEmail`, `readRunDefinition`, `readRunState`, `readDetail`, `listRuns`, `claimExecutionPrincipal`, the parent contract, the schedule and run-provisioning alarms, and the sidebar row it enqueues. |
| `apps/api/src/durable-objects/automation-do-protocol.ts` | The request schemas the Worker and the Queue consumer send it, and the two alarm kinds `automation_schedule` and `automation_run`. |
| `apps/api/src/durable-objects/conversation-parent-object.ts` | The parent half it inherits: child registry, projections, receipts, aggregation, the outbox and its drain. See [`workstream-durable-object.md`](workstream-durable-object.md). |
| `apps/api/src/services/automation-service.ts` | `createAutomation`, the one way an automation comes into existence with its conversation open, used by `POST /automations` and by a room's first draft; and `AutomationService`, the Worker-side access every route goes through, which resolves whether the caller is in the owning room before asking the object. |
| `apps/api/src/routes/automations.ts` | `GET /`, `POST /`, `GET /workstream/:workstreamId`, `GET /:id`, `POST /:id/run`, `POST /:id/accept`, `POST /:id/execution-principal`, `POST /:id/pause`, `POST /:id/resume`, `DELETE /:id`, `GET /:id/runs`. The conversation itself is reached through `/conversations/:automationId`. |
| `apps/api/src/services/integrations.ts` | `createAvalonAutomationsPlugin`: the drafting plugin's host, which creates a room's automation on its first submission and posts the proposal card; `readAutomationRunDefinition` and `assertRunAuthorityStillValid`, the two reads a run makes of its parent; `createAutomationPostResultPlugin`, the `automation_post_result` tool; and the run prompt context built from the definition. |
| `packages/agent-harness/src/automation-creator-tools.ts` | The `rally:automations` plugin: the draft schema's tools, `AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE`, and the submission pre-check. |
| `packages/contracts/src/automation-agent.ts` | `AutomationScopeSchema`, `AutomationLifecycleStateSchema`, the run trigger, `AutomationRunReferenceV1` (what a run's loop input carries), `AutomationActivationV1` (the row a result becomes), and `AutomationDraftProposedV1` (the card). |
| `packages/contracts/src/index.ts` | `AutomationDraftSchema`, `AutomationRunDefinitionV1Schema` (the `readRunDefinition` answer), `AutomationSummarySchema`, `WorkstreamAutomationSummarySchema`, `AutomationRunSchema`, `AutomationDetailSchema`. |
| `packages/contracts/src/automation-evaluators.ts` | The strict external-event evaluator grammar (`always`, or `all` over leaves) and the delivery message the matcher emits. |
| `apps/api/src/services/external-event-evaluator.ts` | The pure predicate evaluator WorkspaceDO matches registrations with. |
| `apps/api/src/durable-objects/workspace-do.ts` | Migration 31: `automation_directory` and `workspace_external_event_registrations`; `applyAutomationDirectory`, `listAutomationDirectory`, `listWorkstreamAutomations`, `automationOwner`, `workstreamParticipant`, `applyExternalEventRegistrations`, `matchExternalEventDestinations`, and the owning-room archive fan-out `notifyOwningRoomArchival`. |
| `apps/api/src/queues/activity-consumer.ts` | Delivers a matched event to `admitExternalEvent`, and a run child's effects to the object through the shared effect leg. |
| `apps/api/src/services/resend-inbound-email-service.ts` | `ingestAutomation`: resolves the sender, stores the message, and calls `admitInboundEmail` once. |
| `apps/api/src/services/memory-service.ts` | `resolveMemoryAccess`: a conversation whose parent is an automation resolves the workspace scope and the automation's own `automation` scope. |
| `apps/desktop/src/renderer/screens/automation.tsx`, `components/automation-header.tsx`, `screens/conversation-surface.tsx` | `/automations/new` calls `POST /automations` and replaces itself with `/automations/:id`; that route renders the header (lifecycle badge, scope, email address, Create or Apply changes, Pause, Resume, Delete, Run now, the run list from `GET /automations/:id/runs`) over the shared conversation surface with `parentKind: "automation"` and `substreamId: "0"`. |
| `apps/desktop/src/renderer/components/sidebar.tsx`, `components/inspector-rail.tsx` | The sidebar's automation rows (drafts labelled **Draft**, the **New automation** action beside **New work stream**) and the room rail's automation grouping from `GET /automations/workstream/:workstreamId`; an automation's own conversation shows no such grouping. |

## How it works

### Two entry points, two homes

An automation is created empty and drafted in its own conversation. Two things
create one:

- **`POST /automations`**, the sidebar's "New automation". It takes no body:
  `AutomationService.create` calls `createAutomation` with `scope: "personal"`
  and no owning work stream, and answers `{automationId}`. The desktop's
  `/automations/new` makes that call once per visit and replaces itself with
  `/automations/:id`, so Back never lands on a screen that would create
  another; the draft is written in the conversation that page shows, and
  **Create** on its header is the first apply.
- **A room's agent submitting a draft.** The `rally:automations` plugin is
  available in every conversation except a run's: preloaded in an automation's
  own conversation, and in a work stream deferred (discovered through
  `list_plugins` and loaded with `load_plugin`). In a work stream, its first
  `automation_submit_draft` calls `createAutomation` with `scope: "workstream"`,
  `owningWorkstreamId` the room, and the harness run id as the automation id,
  so a second submission from the same authoring loop refines the first
  rather than creating another; it then submits the definition and appends an
  `automation_draft_proposed` card to the room's feed, keyed on the automation
  and the revision so a retry replays the card. In an automation's own
  conversation the plugin submits to that automation and posts no card.

`createAutomation` creates the object first (`AutomationDO.create`: the
automation row in `draft`, its `"0"` child registered, its sidebar row
enqueued), then bootstraps the conversation the way a work stream's is
(`bootstrapWorkstreamRuntimeEnvironment` with `parentKind: "automation"`, which
writes the D1 anchor and route keyed by the automation id, and
`provisionWorkstreamObject` with the author as the one participant and the
placeholder title "New automation"). The object exists before its conversation
does, so the conversation's parent always answers.

Where an automation appears follows from how it was made. The left sidebar
lists the automations `listAutomationDirectory` returns: every `workspace`
automation and the viewer's own `personal` ones, drafts included, and never a
room's (`owning_workstream_id IS NULL`). A room's automation appears only in
that room's rail, through `GET /automations/workstream/:workstreamId`
(`listWorkstreamAutomations`, gated on participation in the room), drafts
included. Scope is chosen in the automation's own chat, between `personal` and
`workspace`, and only while the automation is still a draft; a room's
automation is the room's from the start and stays so.

### Drafting in the conversation

The conversation is an ordinary `SubstreamAgent` under the automation, with the
author seated and the same feed, composer, and plugin catalog a work stream
has. What the drafting plugin's tools write is a **definition revision**:
`automation_submit_draft` calls `AutomationDO.submitDefinition({draft,
evaluatorRules, submittedByRunId})`, which appends an immutable row to
`definition_revisions` (the draft JSON, its hash, the evaluator rules the
loop's `automation_set_evaluator_rules` had buffered, and `ready` from the
draft), bumps `current_definition_revision`, follows the draft's name and
description onto the automation so the sidebar row names it, and enqueues the
row. A draft that is not `ready` (the agent asked a clarifying question) is
still a revision; apply refuses it until a ready one lands. A deleted
automation refuses submissions.

Nothing about drafting is fenced by a generation or a claim. The conversation
is the automation's for its whole life, so an edit after acceptance is another
turn in the same chat and another revision; applying it is the same action as
the first apply.

### Applying a revision

`POST /automations/:id/accept` is `AutomationDO.apply`. It is the first-time
Create and every later re-apply alike, takes no body, and reads everything
from the object: the current revision must be `ready`, and an active
automation whose accepted revision is already the current one answers its
detail without doing anything.

Everything read from outside the object happens first, in `prepareApplication`:

- **Bindings** come from the definition. `automationAcceptanceSelections`
  derives the default plugins from `recommendedPlugins` and the activity
  sources from each external trigger's binding key and suggested plugin; each
  selected plugin resolves against `connector_connections` read through the
  workspace runtime port (a WorkspaceDO table; regional D1 has not had it since
  migration 0090). A plugin with no connection refuses with
  `automation_plugin_unavailable`; a `workspace` automation may bind only
  workspace connections (`automation_workspace_connection_required`); anybody
  else's personal connection refuses with
  `automation_personal_connection_access_denied`, because a room's automation
  outlives whoever wrote it and binding a colleague's credentials would lend
  them to a standing automation they never agreed to.
- **Evaluators** are validated against the connector manifests: each rule
  names an inspected plugin, its `all` leaves may name people (resolved against
  active members) and resources (which must belong to the bound connection),
  and `validateDraftEvaluatorRules` expands event families into one registration
  per event type. `automationDraftAcceptanceBlocker` runs here too, the same
  predicate the drafting tool's pre-check applies, so a `ready` draft is one
  apply will not refuse for anything the draft itself settles.
- **Schedules** are computed from the triggers: an interval from now, a calendar
  from its RRULE in the trigger's timezone or, when it names none, the run-as
  user's timezone for a personal automation and the workspace's otherwise
  (`automation_timezone_invalid` when the runtime cannot format it,
  `automation_recurrence_has_no_future` when the rule never fires again).
- The **email address** is reserved in the Global registry
  (`reserveAutomation`, idempotent per automation).

Then one transaction replaces `schedules`, writes the bindings, plugin ids,
evaluator projection, and address onto the row, sets `lifecycle = 'active'`,
clears `paused_by`, records the accepted revision, and enqueues the sidebar
row. After it, the object cancels the previous schedules' alarm entries and
arms one `automation_schedule` entry per new schedule, then replaces the
workspace's registrations for this destination
(`WorkspaceDO.applyExternalEventRegistrations`, a complete replacement with no
coordinate or hash) and stores the `effectiveAfterEventSequence` it answers
with. A failure anywhere throws to the caller as an `ApiError` (the class
survives the RPC hop) and the caller applies again; the registration replacement
is idempotent, so a repeat converges.

The definition's `memoryTables` travel to each run in `readRunDefinition` and
nothing materializes them at apply time. A run creates the table it needs with
the memory tables plugin's `create` tool, under the automation's memory scope,
the first time it needs one; the next run finds it there.

### Triggers and occurrences

Every trigger ends in `admitOccurrence(occurrenceKey, trigger, opening)`, which
inserts one `runs` row in state `pending` with `INSERT OR IGNORE` on the unique
`occurrence_key`, returns `{runId, reused}`, and arms one `automation_run` alarm
entry for the run. A repeated admission of the same occurrence answers with the
run it already made. The object must hold an accepted revision
(`automation_not_active` otherwise), and the run is pinned to that revision.

| Trigger | Entry | Occurrence key | Refusals |
| --- | --- | --- | --- |
| **Manual** | `POST /automations/:id/run` with an `idempotency-key` header; `runNow` | `manual:<idempotencyKey>` | `automation_not_active` unless `active`; `automation_forbidden` unless the caller may manage it |
| **Schedule** | the `automation_schedule` alarm for one schedule row; `executeSchedule` | `schedule:<scheduleId>:<plannedFor>` | skipped silently unless `active`; the next occurrence is computed from now and re-armed |
| **Connector event** | the Queue consumer's `admitExternalEvent`, one message per matched registration | `external:<workspaceEventId>` | `automation_<lifecycle>` unless `active`; `automation_event_before_activation_boundary` when the event's sequence is at or below `effective_after_event_sequence` |
| **Inbound email** | `resend-inbound-email-service.ts` calling `admitInboundEmail` once per delivery | `inbound_email:<resendEmailId>` | see below; the refusal is written to `inbound_email_receipts` |

**Connector events** follow one regional path. The regional activity Queue
hands a normalized event to `WorkspaceDO.ingestConnectorEvent`; a second,
ID-only delivery claims it for processing and calls
`matchExternalEventDestinations`, which selects active registrations by
connection, connector type, event type, and
`effective_after_event_sequence`, applies the audience rule (a restricted
activity never reaches a `workspace` automation and reaches a `personal` one
only when its author is inside the audience), evaluates each registration's
predicate with no model inference, and returns one complete
`workspace_external_event_delivery_v1` message per match carrying the
registration, the destination, and the event. There is no delivery ledger and
no lease: the consumer sends each message to the Queue, and the destination is
idempotent on the event id, which is all a lease ever guaranteed. A redelivery
answers `automation_occurrence_replayed`. Registrations for an automation and
for a watched work-stream resource share one candidate index; a watched work
stream sends no evaluator object, while an automation needs predicates because
it selects event families, content, people, and provider fields.

An evaluator rule is one AND group: `when` is `{kind: "always"}` or
`{kind: "all", allOf: [leaf, ...]}` over the manifest's declared attributes.
Unknown keys, operators, attributes, plugin/event pairs, duplicate ids, empty
groups, non-finite numbers, and wrong scalar kinds are rejected at every
boundary; missing fields make positive and negative predicates false and only
`presence.not_exists` matches absence; matching is case-sensitive with no
coercion. A rule that needs OR is two rules.

**Inbound email** arrives at the automation's permanent address
([`workstream-email-addresses.md`](workstream-email-addresses.md)). The regional
ingress fetches the message, resolves the sender to an active member, stores
the payload in R2 and the email as a resource, and then calls
`admitInboundEmail` once. The object answers a retry from
`inbound_email_receipts` by Resend email id before deciding anything; a new
message is refused with `automation_not_active`,
`automation_email_route_mismatch` (the address is not this automation's), or
`email_sender_not_authorized` (no member matched, or a `personal` automation's
sender is neither its author nor its run-as principal), and the refusal is the
receipt. An admitted message stores its text, structured content, and resource
id as the run's `opening`. There is no pre-fetch screen and no hourly window.

### Runs

The `automation_run` alarm provisions a run (`provisionRun`). Every step is
idempotent so a retry after a partial failure resumes rather than provisioning
twice:

1. A run whose automation is no longer `active` is marked `stopped` instead.
2. The run's definition is read by its revision (`readRunDefinition`), the run
   is registered as a `child` of the automation, and the child conversation is
   bootstrapped and provisioned as substream `<runId>` under the automation:
   title from the definition's name, objective from its instructions,
   `scope: "personal"` with the run-as principal as its only participant,
   `harnessStatus: "scheduled"`, and the automation's model override.
3. For a mail-started run, the email resource is attached to the run's
   conversation as `inbound_email` and the opening text is appended there as a
   `system` message, which becomes the loop's trigger message.
4. The model is the automation's pin (`automationModelOverride`, dropped back
   to the flag when the pinned id has since been retired) or
   `scheduledWorkstreamModel`. A harness run is admitted with origin
   `automation_run` and the run-as user as execution principal, and
   `activateWorkstreamLoop` starts the run's own persistent loop with
   `parentKind: "automation"`, `parentId` the automation, `substreamId` the run,
   and `automationRun: {schemaVersion: 1, automationId, runId,
   definitionRevision, trigger}`.
5. `runs.state` moves to `running`.

The loop input carries a reference, not a copy. At loop start
`readAutomationRunDefinition` asks the parent for `AutomationRunDefinitionV1`
(the definition minus its triggers, the bindings and plugin ids, scope, owning
work stream, run-as principal, model override, trigger, opening, and state),
which builds the prompt context and decides which connector plugins preload.
Before every provider write, `assertRunAuthorityStillValid` asks the parent
`readRunState`; a run the automation no longer knows, whose automation is not
`active`, or whose own row is no longer `running` or `needs_input`, refuses
with `ConnectorError("unauthorized")`, so a run that outlives a pause or a
delete stops rather than finishing on stale consent. The
`rally:automations` drafting plugin is withheld from a run.

The run reports its state the way every conversation does: its
`directory_common` effect reaches the parent through the child effect leg, and
`AutomationDO.onChildCommonAggregate` maps the conversation state onto
`runs.state` forward only (`RUN_STATE_FROM_CONVERSATION_STATE`: `completed`,
`failed`/`error`/`budget_exhausted` to `failed`, `needs_input`,
`stopped`/`cancelled` to `stopped`, every live state to `running`) and copies
the preview onto `summary`; a terminal run keeps its state. Nothing a run says
leaves the object: `forwardsChildEffect` is false, so a run produces no sidebar
row, no activity, and no notification.

### Posting a result

A run of a room's automation holds one extra plugin, `rally:automation-result`,
preloaded, with the tool `automation_post_result`. It is offered only when
`readRunDefinition().owningWorkstreamId` is not null, so a personal or
workspace automation cannot post into a room at all. The tool asks
`WorkstreamDO.authority` for the room's generation and archive state, refuses an
archived or missing room as the tool's error, and calls the room's substream
`0` `appendAutomationActivation` with `deliveryId = runId`, which appends one
`automation_activation` message authored by "Automation" (or answers
`replayed` for a second call). The run's `# Result delivery` prompt section
names that room as the one destination; every other destination the
instructions name is the run's own work with its connector tools.

### Lifecycle

| Transition | Who | What |
| --- | --- | --- |
| `pause` | a manager | `runs` in `pending`, `running`, or `needs_input` become `stopped`; `lifecycle = 'paused'`, `paused_by = 'person'`; schedule and run alarm entries cancelled; the workspace's registrations replaced with `[]`; sidebar row enqueued |
| `resume` | a manager | each schedule's next due instant recomputed from now (a paused automation does not fire what it slept through), `lifecycle = 'active'`, `paused_by` cleared, alarms re-armed, the accepted evaluator projection re-registered with a fresh sequence boundary; refused with `automation_room_archived` while the owning room is archived |
| `remove` (`DELETE`) | a manager | open runs stopped, `lifecycle = 'deleted'`, alarms cancelled, registrations replaced with `[]`; the object is kept, and `authorizeViewer` answers unauthorized and archived from then on |
| `setOwningRoomArchived` | `WorkspaceDO`, from a directory effect that archived or unarchived the owning room | archiving pauses an `active` automation with `paused_by = 'room_archive'`; unarchiving resumes only an automation the archive paused, so a person's pause is never undone by somebody unarchiving the room. The Worker's viewer decision reports `archived` while the room is, which makes the automation's conversation and runs read-only |

Who may manage (`assertManager`): the author or the run-as principal; for a
`workspace` automation also an owner or admin; for a room's automation only a
participant of the room, because authorship is not a share in the room's
automation. Who may view (`assertViewer`, and `authorizeViewer` for the
conversation): a `workspace` automation by any member, otherwise the author,
the run-as principal, or a participant of the owning room.
`claimExecutionPrincipal` lets a manager take over `run_as_user_id` and rebinds
every binding the last principal took with them to the claimant's own or a
workspace connection, reporting what it could not rebind.

### The directory row

Every change enqueues the automation's own `directory_automation` effect
(`enqueueDirectory`) under the projection key `automation`: id, author,
lifecycle, scope, owning work stream, title, description, next run. It travels
the parent outbox and the Queue like a work stream's aggregate and lands in
`WorkspaceDO.applyAutomationDirectory`, which accepts a strictly newer
`sourceVersion`, ignores an older one, refuses an equal one with a different
hash, bumps the `automations` sidebar waterline, and republishes the list. The
row is content-free by design; `GET /automations/:id` reads the object.

### Memory

`resolveMemoryAccess` gives a conversation whose parent is an automation two
scopes: the workspace's, and the automation's own scope of kind `automation`
keyed by the automation id, writable. The drafting chat and every run share it,
so what a run learns is what the next run knows and what the person said while
drafting is part of that. The person's own scope stays out, because a run acts
for the automation rather than as the person, and a workspace automation's runs
would otherwise write into whichever member happened to be its principal.
Automation memory is ordinary WorkspaceDO memory; there is no separate engine.

## Invariants

- **One automation is one object and one conversation, for its whole life.**
  Apply changes a lifecycle column in place and records which revision runs.
  Anything that mints a second id, or a second conversation, breaks every run,
  receipt, and email claim keyed on the first.
- **A definition revision is immutable and a run is pinned to one.** A run
  reads its definition from the parent by revision rather than carrying a copy,
  which is why the loop input can be a four-field reference and why a later
  field change never has to migrate stored run contexts. Editing a revision in
  place would change what a run in flight was authorized to do.
- **`occurrence_key` is the only admission fence.** Every trigger converges on
  it with `INSERT OR IGNORE`, so a Queue redelivery, a provider retry, and a
  repeated **Run now** each answer with the run they already made. A trigger
  that admits without a key admits twice.
- **A run stops when its automation no longer consents.** Pause and delete mark
  the run rows and the lifecycle, and `assertRunAuthorityStillValid` reads the
  live state before every provider write. There is no generation fence on this
  object; the row is the fence.
- **A directory row locates; it never authorizes.** `automation_directory` holds
  no definition and no run content; every content read goes to the object, which
  re-derives authority from its own row, asking WorkspaceDO only whether a
  viewer is in the owning room.
- **`AutomationDO` forwards nothing its children say.** The workspace hears the
  automation's row and nothing else; forwarding a run's aggregate would put
  every run in the work-stream directory, which is the design this replaced.
- **The one way a result reaches a room is `automation_post_result`.** Rally
  posts nothing after a run; the run posts, once, when its instructions say the
  room should hear it. A second delivery path is a duplicate the room reads
  twice.
- **Bindings are derived from the definition, never taken from a request.**
  `apply` carries an id and nothing else; a request field restating what the
  draft settled is a second source of truth for it.
- **A room's automation is the room's.** Its scope is fixed at creation, its
  managers are the room's participants, it is listed only in the room's rail,
  and the room's archive pauses it. Authorship confers nothing on it.

## Boundary

This module owns the automation: creation, drafting, revisions, apply,
lifecycle, schedules, occurrence admission, run provisioning, run state, the
result tool, and the sidebar row.

It depends on the conversation hierarchy for its conversations and its runs
(`SubstreamAgent`, the shared parent base, the effect legs;
[`workstream-durable-object.md`](workstream-durable-object.md)); on WorkspaceDO
for the directory row, the registrations and the matcher, the owning-room
participation answer, and **every workspace-product table it reads**
(`connector_connections`, `resources`, `users`' timezones through regional D1
and the rest through `withWorkspaceRuntimeDatabase`); on the Global
`workstream_email_routes` registry for its address; on regional D1 for identity
and membership; and on the agent harness for what a run does
([`agent-harness.md`](agent-harness.md)).

It does not own the connector manifests that define what an evaluator may name
([`connectors.md`](connectors.md)), the socket admission and the
`/conversations` routes ([`realtime-sockets.md`](realtime-sockets.md)), how mail
reaches an address ([`workstream-email-addresses.md`](workstream-email-addresses.md)),
or the memory store the automation scope lives in.

## Failure modes and limits

- **A failure inside the object is an `ApiError` with a stable snake_case
  code**, thrown directly and surviving the RPC hop with its status: 403
  `automation_forbidden`, 404 `automation_not_found` or
  `automation_run_not_found`, 409 `automation_not_active`,
  `automation_not_paused`, `automation_room_archived`, 422
  `automation_definition_not_ready`, `automation_plugin_unavailable`,
  `automation_workspace_connection_required`,
  `automation_personal_connection_access_denied`, `automation_person_not_found`,
  `automation_resource_not_found`, `automation_recurrence_has_no_future`,
  `automation_timezone_invalid`, and the evaluator blocker codes. An identity
  mismatch is a bare `Error`, deliberately, because it is a wiring fault and not
  a refusal.
- **Apply fails part-way.** The transaction either committed or did not; the
  alarm re-arming and the registration replacement after it are idempotent, so
  the caller applies again and converges. Nothing is fenced by generation.
- **A run cannot be provisioned.** The `automation_run` alarm entry backs off
  under the shared alarm gate and retries; every step is a replay on an opened
  object. A run admitted while the automation was paused is marked `stopped`
  when its alarm fires.
- **The Queue redelivers a matched event.** `admitExternalEvent` answers
  `automation_occurrence_replayed`; the consumer logs it and acks.
- **A result cannot be posted.** `automation_post_result` throws
  `automation_owning_room_archived`, `automation_owning_room_missing`, or
  `automation_post_result_refused:<code>` (a stale generation or an archived
  room decided inside the room's object); the run sees the tool error and says
  so in its result.
- **A run's parent is unreachable** when `readRunDefinition` or `readRunState`
  is asked. The loop fails that turn and the harness's own retry applies; a run
  never proceeds on a definition it could not read.
- **The sidebar row lags.** The row travels two Queue legs; a person who just
  submitted a draft sees the title update when the row lands, not when the
  tool returned. `GET /automations/:id` reads the object and is never stale.
- **Runs are listed to fifty and a detail's `recentRuns` to twenty.** Older
  runs stay in the object; there is no paging yet.

## Testing

| Suite | Command | Covers |
| --- | --- | --- |
| `apps/api/test-workers/automation-do.test.ts` | `pnpm --filter @rally/api test:workers` | On real workerd, with `connector_connections` in WorkspaceDO and deliberately absent from D1: draft, `submitDefinition`, and `apply` binding a workspace connection, reserving the address, and activating; a missing connection refused; a second ready revision re-applied on an active automation; pause stopping the in-flight run and clearing registrations, resume re-arming; delete tombstoning the row and leaving the sidebar; management refused to a member who is neither author nor principal; `runNow` idempotent on its key; `admitExternalEvent` idempotent and refused before the boundary; `admitInboundEmail` answering a retry from its receipt and refusing a stranger; the run provisioned as a child substream whose loop reads its definition by revision, with `runs.state` following the child's state through the effect leg. |
| `apps/api/test-workers/automation-post-result.test.ts` | `pnpm --filter @rally/api test:workers` | The result tool appending into the owning room's substream `0`, and refused for an archived room and a stale generation. |
| `apps/api/test-workers/automation-directory.test.ts` | `pnpm --filter @rally/api test:workers` | `create` alone putting a draft row in the author's sidebar, a workspace row in everyone's, and a room's row only in `listWorkstreamAutomations`. |
| `apps/api/test-workers/automation-acceptance-bindings.test.ts` | `pnpm --filter @rally/api test:workers` | The binding half in isolation: the table absent from D1, a recommended plugin bound from the workspace object's connections, a missing one refused, a disabled row skipped for the live one. |
| `apps/api/test-workers/external-event-routing.test.ts` | `pnpm --filter @rally/api test:workers` | One accepted event and one matcher serving an automation and watched work streams; a redelivery admits once. |
| `apps/api/test-workers/conversation-parent-contract.test.ts`, `conversation-effect-queue.test.ts` | `pnpm --filter @rally/api test:workers` | The parent contract through the real ticket route, and the effect legs an automation's children use, including a child effect producing no `parent_effect` row. Owned by [`workstream-durable-object.md`](workstream-durable-object.md#testing). |
| `apps/api/test/external-event-evaluator.test.ts` | `pnpm --filter @rally/api test` | The pure predicate: legal and illegal documents, missing-field semantics, and the connector vocabulary. |
| `apps/api/test/run-authority-validity.test.ts` | `pnpm --filter @rally/api test` | A running run admitted, a paused or unknown one stopped, connector evidence not re-read after admission, and a run with no automation reference asking no automation. |
| `apps/api/test/scoped-memory.test.ts` | `pnpm --filter @rally/api test` | An automation's conversation resolving the workspace scope and its own `automation` scope. |
| `apps/api/test/resend-inbound-email.test.ts`, `workstream-email-routing.test.ts`, `workstream-email-address.test.ts` | `pnpm --filter @rally/api test` | The single admission call, its receipts, and the address claim. |
| `apps/api/test/access-revocation.test.ts` | `pnpm --filter @rally/api test` | The workspace fan-out naming an automation and the consumer walking its children. |
| `packages/agent-harness/src/automation-creator-tools.test.ts` | `pnpm --filter @rally/agent-harness test` | The drafting tools, the `all` evaluator shape, and the submission pre-check. |

Traps worth knowing before writing one here. The `test-workers` D1 starts with
no schema, so a test that exercises membership or sessions declares those tables
itself, and it must not declare a WorkspaceDO table there
([`testing.md`](testing.md#declaring-a-table-the-region-does-not-have)); the
binding files assert the absence in their first test rather than trusting a
comment. Every file uses its own workspace id, because two files sharing one would
queue behind each other's WorkspaceDO. An `automation_run` alarm is armed for now the moment
an occurrence is admitted, so a test that wants to inspect a `pending` run
reads it in the same `runInDurableObject` invocation that admitted it, per
[`durable-object-alarms.md`](durable-object-alarms.md). A test that reaches
`apply` addresses WorkspaceDO, so call `initializeWorkspace` first. Effects
between a run and its parent and between the parent and the workspace do not
deliver themselves: drive them with `deliverEffectsToWorkspace` and its
siblings in `test-workers/helpers/conversation-effects.ts`.

## Data model

`AutomationDO` SQLite, one migration: `automation`, `definition_revisions`,
`schedules`, `runs`, `inbound_email_receipts`, the shared parent tables, and
`_internal_durable_alarms`. [`workstream-durable-object.md`](workstream-durable-object.md#automationdo)
catalogs the columns; the occurrence keys and run states are in the tables
above. `run_id` is the child substream id, and `harness_run_id` is unique per
run.

`WorkspaceDO` migration 31 rebuilt `automation_directory` (automation id,
workspace, author, `source_version`, hash, lifecycle, scope, owning work stream,
title, description, next run, projected time) and
`workspace_external_event_registrations` (no generation, version, or hash; a
complete replacement per destination keyed on `destination_key`, with
`effective_after_event_sequence` as the cutoff), dropped
`workspace_external_event_deliveries`, `automation_creation_claims`,
`automation_cutover_campaign`, `automation_templates`, and
`automation_template_versions`, and deleted every work-stream directory row an
automation run had made. [`data-model.md`](data-model.md) is the map of both
authorities.

## Regional impact

Every object name is `<region>:<workspaceId>:automation:<automationId>` and the
constructor asserts the object's jurisdiction against `AVALON_REGION`, so an
automation cannot be addressed from the wrong region. Its conversations are
`SubstreamAgent`s in the same region, named by the automation id. Connector
payloads, draft turns, memory, and run content stay in the workspace's region.
The one cross-region call is the email-address reservation, which reaches the
Global `workstream_email_routes` registry and carries the address and opaque
owner ids only (the column is still named `automation_subscription_id`; D1
migrations are immutable). Queue messages between objects carry the envelope
inline and stay regional.

## Security and trust model

Every RPC re-derives authority from the object's own row rather than from the
caller's claim. The Worker resolves one fact the object cannot see, whether the
caller is a participant of the owning room, and sends it as
`participantOfOwningWorkstream`; a failure to resolve it sends `false`, which
only ever withholds the room's standing. Reads admit the author, the run-as
principal, any member for a `workspace` automation, and the room's participants
for a room's; management additionally admits a workspace owner or admin, but
only for a `workspace` automation.

The conversation's readers are the parent's decision, carried to the
conversation object on the ticket and by seating the reader; a run's
conversation seats only the run-as principal, and its state reaches nobody but
the parent.

Inbound mail is untrusted: the From header can be spoofed, so the sender must
resolve to an active workspace member, and to the author or principal for a
personal automation. That screening is the whole control; an inbound-email run
holds the same tools as any other run, a decision
[`security.md`](security.md) records.

Binding is where credentials are lent: a personal connection may be bound only
by its owner or the run-as principal, and a `workspace` automation binds only
workspace connections. `claimExecutionPrincipal` is the one way a run-as
principal changes, and the claimant is always the caller.

Losing access closes an open conversation. The automation holds no socket of
its own; the [access-revocation queue](access-revocation.md) reaches its
conversations through `listChildren`.

## Operations

A run's state, its trigger, and its summary are on `GET /automations/:id/runs`
and in the object's `runs` table. A sidebar row that disagrees with the object
is a Queue delivery that has not landed: read the object's `durable_outbox` and
the regional activities dead-letter queue, per
[`workstream-durable-object.md`](workstream-durable-object.md#operations). A
missing scheduled run is a schedule row whose `next_due_at` is null or an
alarm entry behind its backoff gate in `_internal_durable_alarms`;
`automation_scheduled_alarm_failed` names the entry and the handler's code. A
run refusing provider writes with "This automation run is no longer running"
was paused or deleted after admission. [`runbook.md`](runbook.md) has the
production inspection paths.

## Changelog


### 2026-09-04: A posted result drains into the room, and the rail survives an archive

**What changed:** The pending-input drain in `workstream-transcript-storage.ts`
tested the canonical payload's role, which is `system` for an
`automation_activation`, and threw `pending_input_bind_role_invalid` on every
drain of one. A pending input that throws stays first in line, so the first
result an automation posted into a room stopped that room from processing
anything after it, and the object logged the failure about sixty times a
second until the room was archived. The guard now reads the bind payload the
transition appends, which is the `user` message the model sees.
`WorkspaceDO.listWorkstreamAutomations` admits a participant of an archived
room, whose automations are paused rather than gone, and both directory reads
refuse with a typed 403 instead of an uncaught error.

**Why:** Found by driving the room-scoped flow on a running stack with live
inference: the workerd suite's post-result case exercised the idle-activation
path, which initializes the loop from canonical history and never reaches the
drain, so it passed against the defect. The Node transcript-storage suite now
carries the case with a Bind head in place, which is the path a room that has
run before takes.

**Consequences:** A test that proves an activation reaches a room's model has
to give the room a Bind head first. The archived room's rail lists its paused
automations; resuming one is refused with `automation_room_archived` until the
room is unarchived.

### 2026-09-03: The automation is rebuilt as a conversation parent

**What changed:** `AutomationAgent` is deleted (Wrangler tag `v9`) and
`AutomationDO` created with a fresh one-migration schema: one automation row,
immutable definition revisions, schedules, runs keyed by occurrence, and
inbound-email receipts, plus the parent tables it shares with `WorkstreamDO`.
An automation's substream `0` is its conversation for its whole life, where it
is drafted, created, and edited through the `rally:automations` plugin; each
run is a child substream named by the run id, reading its definition from the
parent by revision and reporting its state through the same child-effect leg
every conversation uses. `POST /automations` creates an automation and its
conversation; a room's agent creates a room-scoped one on its first
submission. Posting into the owning room is the run's own tool,
`automation_post_result`. Inbound email is one `admitInboundEmail` call. A
connector event reaches the object as one Queue message per matched
registration, carrying the event, from a WorkspaceDO whose registrations have no
coordinates and whose matcher holds no lease. Memory is the workspace store's
`automation` scope.

**Why:** The previous object was a distributed-systems design for a product
with no users: about eleven thousand lines, thirty-two tables, a two-phase
acceptance, a generation fence on every asynchronous path, a per-run
classifier, and roughly a third of it left over from two deleted designs, the
standalone draft compiler and the August cutover. Its runs were hidden work
streams because nothing else could be the parent of a conversation; the parent
role was `WorkstreamDO`'s by construction and could not be given to an
automation. Making the parent explicit (the entry of this date in
[`workstream-durable-object.md`](workstream-durable-object.md)) let the
automation own its conversation and its runs directly, and everything that
had compensated for not owning them, the origin type, the exposed flag, the
run-context copy, the delivery receipts, the archive fan-out to run work
streams, went with the hidden work streams. The effect pipeline it reports
through changed at the same time and for the same reason: the opaque wake-up
plus the load-back and acknowledge RPCs distrusted a Queue that already
retries, and queues on every asynchronous hop is the repo's own default. There
are no users yet, only dogfood, so there is no compatibility path; every
automation that existed before is gone with its class and is recreated by
chatting.

**Considered and rejected:** Keeping `AutomationAgent` and pointing its runs at
the new parent contract. Rejected because the object's size was the problem,
not one feature in it; a migration of its thirteen released versions to the
new shape would have cost more than the rewrite and kept the leftovers.
Delivering a result by a classifier after the run, as before. Rejected
because a tool the run calls with the text it wants the room to see is the
instructions being followed, and a classifier judging the final message was a
second model deciding what the first one meant.

**Scope cut, deliberately, and what would have to be true to pick each back
up:** the disposition classifier and its corpus (a result posts when the run
posts it; bring it back only if runs prove to post noise); delivery receipts
(the activation row keyed on the run id is the receipt); hidden run work
streams and the exposed flag (runs are child substreams; nothing lists them);
the inbound-email double screen and hourly rate window (one admission call
writes one receipt; a rate limit is a decision for when mail volume exists,
and the number would be the team's); DNF evaluator groups (one rule is one AND
group, and a person who needs OR writes two rules); authority-generation
fences on automations (the run row's state is the fence, and
`assertRunAuthorityStillValid` reads it live); templates end to end (adopting
a definition is pasting it into a chat); the standalone draft compiler
substrate, its socket, and its transcript (drafting is a conversation); the
cutover module, script, tables, and attention codes (the cutover ran once and
nothing predates it now); the automation memory engine (the workspace store
already had an `automation` scope kind); and definition-time memory-table
materialization (a run creates the table it needs through the memory tables
plugin's `create` tool under the automation scope; materializing at apply
would return only if runs prove unable to agree on a table's shape).

**Consequences:** A run is pinned to an immutable revision, so an edit applies
to the next run and never to one in flight. The `occurrence_key` unique
constraint is the only admission fence, and a new trigger kind has to derive
one. `AutomationDO` forwards nothing its children say, so an automation's runs
are invisible to the sidebar, the activity log, and notifications by
construction. Where the plan this shipped from and the code differ, the code
is described above: `readRunState` answers with both the automation's lifecycle
and the run row's state, and `assertRunAuthorityStillValid` refuses unless the
lifecycle is `active` and the run is `running` or `needs_input`; and a
mail-started run's opening is appended to the run's own conversation as a
`system` message, which is what its loop reads as the trigger. The desktop
moved with it: the automation overview screen, the attention notice, the
template surfaces, and the principal-unavailable card are gone, and the
automation page is the shared conversation surface under a header that carries
the lifecycle.

### 2026-09-03 — An automation has no destinations of its own

**What changed:** Delivery targets are gone from automations end to end.
`deliveryTargets` is off the frozen run context and `AutomationDetailSchema`;
`requestedDelivery` is off the draft, its enum, and the model's tool schema;
`AutomationDeliveryTargetInput/SetSchema` are deleted; `resolveDeliveryTargets`,
`updateDeliveryTargets`, `PATCH /automations/:id`, the desktop delivery editor,
the child's external delivery loop, and five error-table rows are removed.
AutomationAgent schema v13 strips `$.deliveryTargets` from stored run contexts
and rebuilds `automation_acceptance` without `delivery_targets_json`; work-stream
object schema v37 strips the same key from the child's verbatim copy in
`runs.execution_context_json`, which is never cleared and is read back through
the same strict schema on claim, recovery, settlement and retry. The
classifier's `reach.canDeliver` is now `owningWorkstreamId !== null`. The
system prompt's result-delivery section gained a second arm that tells a run
with no destination that sending is its own work. Separately and first, the
inbound-email tool filtering came out (previous entry). Digest delivery is a
different system and is untouched.

**Why:** Delivery was modelled as deterministic infrastructure decided at
creation — a two-element enum of destinations, resolved to IDs, frozen into the
run context, sent by a loop after the run ended. That shape could not express
"email the finance team, and DM me only if it is urgent", it needed a member to
pick a connection at a moment the product no longer had, and it is what
produced the four-field defect the previous entry cleaned up. The judgement
about *where* a result should go belongs with the judgement about *what* it
should say, which is the loop's. So the automation knows nothing about
delivery, and a run sends what its instructions ask for with the tools it was
bound.

**What survived, and why it is not delivery:** the room that owns a
`workstream`-scoped automation is still woken with the result. That follows
from ownership rather than from anybody choosing it, was already separate from
`deliveryTargets` in the child (`substream-agent.ts`, the block that begins
"The room that owns this automation"), and is the one case the disposition
classifier was built for — a spurious result in a shared room. `delivery_state`,
the receipt machinery, `resolveRunDisposition` and `expose_workstream` all keep
their jobs against that one destination.

**The security trade, stated once:** what a run chooses to send is now inside
the loop, and the loop is steered by whatever steers the loop, including
trigger content. Before this change that was already true of every
`connector_activity` run, which held write tools while reading equally
untrusted third-party pages; only inbound email was filtered, and the previous
entry removed that filter on the grounds that a boundary drawn around one
channel out of several is not a boundary. The control that remains is
screening at ingress — a sender must resolve to an active workspace member —
and it is now the same control for every trigger.

**The migration:** `AutomationRunContextV1Schema` is `z.strictObject`, so a
frozen context still carrying `deliveryTargets` would stop parsing the moment
the field left the contract: every claimed-but-unexecuted run, and every
historical row the detail path reads. v13 rewrites them with `json_remove`,
guarded by `json_extract ... IS NOT NULL` so a resume after a failed later
group is a no-op, and rebuilds `automation_acceptance` because SQLite refuses
`DROP COLUMN` on a column named in a CHECK. It mirrors the v9 rebuild beside
it, including the `owning_workstream_id` copy v9 had to null and this one
preserves.

**Considered and rejected:** *tolerating the key* as an optional ignored field.
Lower risk for a run in flight at the moment of deploy, and it leaves a dead
field in a frozen contract that every future reader has to know to ignore.
*Keeping the deterministic path for untrusted triggers only.* That was the
recommended shape before the inbound-email filter came out, and it stops
making sense once no trigger is special: the split would have to be drawn on a
distinction the codebase no longer makes anywhere else. *Removing the
classifier.* Its most-cited case is the one that survives.

**What a future change has to respect:** the room wake is not a delivery target
and must not be modelled as one — the moment it becomes a chosen destination it
becomes something a run could be steered to drop. And the prompt's empty arm is
load-bearing: it is the only thing that tells a personal automation that nothing
sends for it, and a run that reads silence as "Rally has it covered" is the
silent-loss defect this whole sequence began with, in its final form.

Shipped in #541.

### 2026-09-03 — An inbound-email run holds the same tools as any other run

**What changed:** The three `inbound_email` guards in
`apps/api/src/services/integrations.ts` are gone: `loadHarnessTools` no longer
withholds write-mode connector tools from a mail-started run, `createAvalonTools`
no longer omits the Firecrawl search and fetch tools from one, and a child
harness spawned by one keeps its `web.` capabilities. `triggerPolicy.inboundEmail`
is still recorded on the run; nothing narrows on it.

**Why:** The filter named one trigger out of several that carry untrusted
content into the loop. A `connector_activity`, `semantic_activity` or `webhook`
run reads third-party text that is exactly as untrusted as a mail body, and held
every write tool it was bound while doing so; a control that applied to inbound
email alone was not a boundary, and its existence let two documents claim a
protection that did not exist for the other channels. Filtering on trigger
provenance is done at ingress, where a sender must resolve to an active
workspace member before a run exists, and where the same question can be asked
of every trigger at once.

**Considered and rejected:** *Leaving the guard in place until a general control
replaces it*, which keeps a rule that misdescribes itself and defers the general
question with no owner. *Generalizing the guard now into a trust flag on the
workflow input gated at both tool-assembly sites*, which is the right shape if
the team decides trigger content should narrow tools; it needs a policy for
which triggers and which tools, and that policy is a decision to be made, not a
default to be typed into a refactor.

**Consequences:** A mail-started run may write to its bound connectors and fetch
the web, and the prompt's empty delivery arm tells it to send results itself
when its instructions say so, so a forwarded mail that passes the sender screen
can steer sends as well as reads. [`security.md`](security.md) carries the
rewritten invariant and the same reasoning from the threat-model side. Anyone
reintroducing a narrowing must do it for every external trigger, and the tests
that proved the omissions (`connector-tool-selection.test.ts`,
`firecrawl-web-tools.test.ts`) were inverted to assert the tools are present.

Shipped in #541.

### 2026-09-03 — Acceptance takes an ID, and derives the rest from the draft

**What changed:** `POST /automations`, `AutomationAgentService.accept` and
`CreateAutomationRequestSchema` are deleted. `POST /automations/:id/accept` is
the only way an automation is created, and `acceptDraft` no longer accepts
`defaultPluginIds`, `activitySourcePluginIds` or `deliveryTargets`:
`automationAcceptanceSelections` reads all three off the stored definition.
`automationDraftAcceptanceBlocker` is one predicate called by
`admitAuthoredDraft` and again by `prepareAcceptance`. Five previously untabled
codes gained rows, as this entry first landed; two of them,
`automation_evaluator_source_binding_mismatch` and
`automation_evaluator_connection_missing`, were removed again the same day once
the predicate made them unreachable, and `requestedDelivery`, which this entry
first narrowed to `email`, left the draft entirely in the entry above, so
neither of those two changes survives on `main`. `isExternalEventTrigger`
becomes a type predicate.

**Why:** the create wizard was deleted on 2026-09-01, and the request schema it
was shaped for outlived it. Every field in that schema was a question only the
wizard could answer, and the one caller left — the proposal card, which holds
nothing but the summary it displays — sent empty values that acceptance read as
decisions. Four fields, four defects, of which
[the previous entry](#2026-09-03--the-proposal-cards-create-stops-answering-500)
fixed one:

| Field | Card sent | Result |
| --- | --- | --- |
| `modelOverride` | `null` | 500 on every card, fixed 2026-09-03 |
| `activitySourcePluginIds` | `{}` | every external-event draft refused, untabled, generic 409 |
| `deliveryTargets` | `[]` | **silent** — a draft asking for emailed results created delivering nothing |
| `defaultPluginIds` | `[]` | **silent** — an automation ran without the connectors its own overview named |
| `resourceIds` | `[]` | parsed and never read by anything |

Two loud and two silent, and the silent pair is the worse half: an automation
created successfully that does less than the card described. Patching each field
would have left the shape that produced them, so the fix is the inversion. The
draft is not a fallback source for these facts, it is the only one that was ever
authoritative — a ready draft's activity trigger names the plugin the model
loaded and inspected against a live connection activation, and its recommended
plugins were held to the same rule by the authoring tools.

**Why one predicate:** the
[2026-09-01 entry](#2026-09-01--an-event-driven-draft-must-carry-its-rules-to-be-submitted)
fixed this same shape once, for evaluator rules, by making submission and
acceptance share `evaluatorRulesMissing` — a draft one admits and the other
refuses reaches a person as a card whose button cannot work. That was one field
of a class. `ready` now means "acceptance will not refuse this for anything the
draft itself settles", and the questions only the present can answer — whether a
named plugin still resolves to a healthy connection the caller may bind — are
deliberately left where they were.

**Why delivery narrowed:** only `email` is derivable, because it resolves from
the author's own user row and names no connection. `slack_agent_dm` needs a
connection ID a draft deliberately does not carry, and `channel` has no
delivery-target shape at all. Both used to pre-tick a box on the wizard where a
member supplied what was missing; with it gone they were recorded and dropped.
Narrowing the tool schema means the drafting conversation offers what can
actually be delivered, and both remain settable afterwards through
`PATCH /automations/:id`, which is where a connection can be chosen.
`AutomationRequestedDeliverySchema` stays wide so drafts already stored still
parse; they refuse with a sentence instead of being silently dropped.

**How it is proved:** `apps/api/test-workers/automation-agent.test.ts` on real
workerd, one test per derived field plus both ends of the predicate. Each was
broken in the production code and watched to fail for the reason its name
claims, then reverted: emptying the activity-source map and the recommended-plugin
list, and removing the trigger/evaluator agreement check. The two silent defects
are the ones this mattered most for, since nothing about them ever failed before.
(The delivery list and the delivery-channel check this entry first covered were
removed the same day by the entry above.)

**Considered and rejected:** *passing `suggestedActivitySourcePluginIds` at the
call site*, which fixes the loud symptom and leaves the shape, the two silent
defects, and the second source of truth. *Keeping the fields as optional
overrides*, which keeps a schema nobody fills and invites the next empty value
to be read as a decision. *Refusing `slack_agent_dm` at acceptance only*, which
puts the refusal after the drafting conversation has ended, where the person has
nothing to act on — the same defect this entry is about, one field over.

**What a future change has to respect:** recorded above as two invariants.
Two refusals this entry first tabled, `automation_evaluator_source_binding_mismatch`
and `automation_evaluator_connection_missing`, turned out to be unreachable once
the predicate ran first: it returns `automation_activity_source_unbound` for the
first condition, and the binding loop refuses `automation_plugin_unavailable` for
the second. Their throws and rows are gone; the evaluator loop now only looks the
connection up. One consequence to know about: the card's Create used to bind nothing, and now
binds every plugin the draft recommends, holding each to the object's own rule
that a personal connection is bound only by its owner. A room draft whose
drafting loop recommended the author's personal connection is therefore created
by the author and refused, legibly, for anyone else in the room
(`automation_personal_connection_access_denied`), and a workspace-scoped draft
recommending any personal connection is refused for everyone
(`automation_workspace_connection_required`). Both are the rule working as
written; if a room should be able to create such a draft, the change is for the
drafting tools to stop recommending personal plugins for room and workspace
scopes, not for acceptance to skip the check.

Shipped in #541.

### 2026-09-03 — The proposal card's Create stops answering 500

**What changed:** `AutomationAgentService.acceptAuthoredDraft` built its create
request with `modelOverride: null`. `CreateAutomationRequestSchema` declares that
field as an `optional()` enum, so `accept`'s re-parse threw a `ZodError`, which
is not an `ApiError` and matches no row of the error table — the boundary
answered `500 internal_error` / "An unexpected error occurred". The field is
gone (absent is how the schema spells "no override", and `accept` already
coalesces it to the `null` the object stores), and the request is now annotated
`z.input<typeof CreateAutomationRequestSchema>` so a field whose *type* the
schema cannot accept is a typecheck failure rather than a runtime fault. The
schema's parse-time-only constraints — `resourceIds`' `.max(20)` and the
`superRefine` over `deliveryTargets` and `scope` — are outside what an
annotation can prove, and are recorded as such in the invariant.

**Why:** the card was the only way to create an automation drafted in a work
stream, and it had never worked. There was no member input that could avoid it
and nothing on screen to act on: the card offered a sentence with no next step
under it and the same button again. Nor was there a bad request to blame — the
service composed the rejected object itself, one function above the parse that
rejected it, which is why the type system had every fact it needed and was never
asked. `accept` takes `unknown` because it is a REST boundary; the internal
caller was inheriting that looseness for free.

**How it was found:** `POST /automations/:id/accept 500 internal_error` in the
Global Worker logs, with `error_name: ZodError`, `route: /automations/:id/accept`
and `validation_issues: [{ path: "modelOverride", code: "invalid_value" }]` —
the fields the
[2026-08-31 entry](#2026-08-31--the-create-boundarys-own-refusals-stop-answering-500)
added to `errorHandler` for exactly this, since without them the line says only
"internal_error" and names neither the field nor the route.

**How it is proved:** `apps/api/test-workers/automation-agent.test.ts` accepts a
seeded ready draft through `acceptAuthoredDraft` against a real AutomationAgent
and asserts the automation comes back `active`. Restoring `modelOverride: null`
fails it on the `ZodError`. It is asserted through the service rather than
against the schema because what failed was the request the service constructs; a
schema test would restate the literal beside it and survive the break.

**What a future change has to respect:** recorded above as an invariant, beside
the one about refusals raised outside the error table — this is the same 500
reached by a different route, and a changelog is not where a future change is
checked.

**Considered and rejected:** widening `CreateAutomationRequestSchema` to
`.nullish()`. It fixes this call and leaves the wire contract with two spellings
of "no override" for every client, and it fixes nothing about the seam that
allowed it — the next mismatched field would be another 500. Also rejected:
`modelOverride: undefined` for explicitness, which `exactOptionalPropertyTypes`
rejects outright.

Shipped in #541.

### 2026-09-02 — Work-stream authoring recognizes real plugin loads and elicitation receipts

**What changed:** The work-stream Automations plugin now shares credential
activation state with the harness: when a canonical connection activation is
persisted, its model-facing plugin ID becomes available to ready-draft
validation, and a dropped activation removes that permission again. On a resumed
run, completed inspection, people/resource search, and evaluator receipts
rebuild the Automations plugin's transient authoring state in tool order before
its first tool executes. The harness run ID is the authored automation ID, so a
replacement plugin instance refines the same draft instead of creating another.
The shared elicitation tool now requests the provider idempotency key its durable
question writer already required.

**Why:** An hourly Granola automation loaded the connector and inspected its
automation metadata, but submission still read an empty private loaded set and
asked for the same work again. Its fallback elicitation then failed before
writing because the tool definition selected record-before-execute semantics
while the executor required a provider key. Together those bugs left no valid
authoring exit.

**Considered and rejected:** Treating every connector in the catalog as loaded
would erase the distinction ready-draft validation exists to enforce. Removing
the durable key check would let a replay create a second blocking question.

**Consequences:** Explicit loads, preloads, and restored activation hints all
satisfy the same ready-draft rule once the model also inspects the plugin.
Eviction cannot erase completed inspection, research, or evaluator state and
cannot fork a duplicate automation. A closed connector activation immediately
stops satisfying ready-draft validation. Repeated elicitation execution resolves
to one stored question.

### 2026-09-01 — An event-driven draft must carry its rules to be submitted

**What changed:** `admitAuthoredDraft` refuses a ready draft that has an
external-event trigger and no evaluator rules — absent or empty, the same
condition `prepareAcceptance` already applied. A draft that is not ready is
exempt.

**Why:** the two ends disagreed about who enforces the invariant, so neither
did. `admitAuthoredDraft` takes `evaluatorRules` as
`AutomationSetEvaluatorRulesInputV1Schema.nullable().default(null)` and wrote the
row only `if (request.evaluatorRules)`, with no check that an event-driven draft
had any; the drafting loop's `submitDraft` port passed whatever local
`stagedEvaluatorRules` happened to hold, `null` until the model called
`set_evaluator_rules`. The draft was then admitted **ready** and posted as a
proposal card, and `prepareAcceptance` threw `automation_evaluator_rules_required`
when somebody pressed Create. Reproduced on real workerd before the fix.

`automation_authored_evaluator_sets` was added so an authored draft's rules had
somewhere to live — its own schema comment names this failure, *"an event-driven
draft written in a work stream is proposed as ready and then refused at
acceptance for rules it had no way to record"* — but giving them a home did not
make recording them required. This adds the requirement.

Create is the wrong place for the refusal: the drafting loop has ended by then,
so nothing can repair the submission, and what is left is a card whose button
cannot work. A refused tool call inside the loop is repaired and retried
instead. The `ready` exemption is deliberate and load-bearing: without it a
partial submission paired with a clarifying question — the ordinary way a draft
asks for a missing detail — would be refused, and the test asserts that case for
that reason.

The drafting tool refuses first, with a sentence rather than a code. A tool
executor's thrown `Error` reaches the model as `error.message` verbatim, tagged
an external fault, so the object's `automation_evaluator_rules_required` arrives
naming nothing it can act on — and a model given that resubmits the same draft
until the loop runs out, which `set_evaluator_rules`' own `validateInput`
comment already records happening. `submit_draft` therefore carries the same
check phrased as an instruction, beside the load-and-inspect refusal it mirrors,
and `submit_draft`'s tool description states the requirement so the round trip
is usually avoided. The object's throw stays as the one no caller can bypass.

Both boundaries in the object call one predicate, `evaluatorRulesMissing`, over
`isExternalEventTrigger` in `@rally/contracts`, rather than each spelling the
condition out. The first draft of this change duplicated it and
left a note saying the two must be kept identical; review pointed out that a
note is what failed last time. The same class of defect was fixed once before in
the compiler path this replaced and recurred here because each end read the
state its own way, so the requirement is structural now — dropping a trigger
kind from `isExternalEventTrigger` breaks the regression test rather than
silently teaching one boundary and not the other. The predicate lives in
contracts beside the trigger union; the several other places in the tree that
spell the three kinds out predate this and are not converted here.

Author review added the drafting-tool half. The guard alone made the refusal
*possible* to repair; what the model actually received still did not say how,
which is the difference between a loop that recovers and one that repeats
itself. It also caught a stale claim in the pull request description — copy
quoted from a file the drafting-stack deletion had already removed — and noted
what this does not close: `automation_evaluator_source_binding_mismatch`,
`automation_evaluator_connection_missing` and `automation_plugin_unavailable`
still refuse at Create in the same dead-end shape (the first two were made
unreachable by the shared predicate and removed on 2026-09-03; only the third
remains). Those depend on the accepting
person's chosen connections rather than on the submitted draft, so they cannot
move to submission the way this one could; the class is narrowed, not closed.

### 2026-09-01 — The disposition classifier gets a corpus, and it is a gate

**What changed:** A fixed corpus of real-shaped results, each with the
disposition a person would have chosen and the reasoning for it, lives in
`packages/agent-harness/src/prompts/automation-result-disposition-corpus.ts`.
`scripts/score-automation-disposition-corpus.mjs` scores it against a live
model and exits non-zero on any miss; a unit test keeps the corpus itself
honest.

**Why:** This classifier is the only thing between every automation in the
fleet and every destination it has. Nothing about a disposition raises an
error, retries, or reaches a dead-letter queue — a result judged `done` simply
never arrives, and the person waiting for it has no way to know it existed. A
regression is silent in exactly the direction nobody checks, which is what
makes this a release gate rather than a nice-to-have.

**Considered and rejected:** Scoring in the ordinary test suite. It needs a
real model, and a suite that cannot run without provider credentials is a suite
people learn to skip. Also rejected: one pass rate. A swallowed result and a
spurious exposure are not interchangeable — the first is invisible, the second
is a row somebody ignores — and a single number lets a release trade one for
the other unnoticed, so they are counted and reported separately.

**Consequences:** The unit test guards the corpus, not the model: it refuses a
case expecting an arm that case's own reach never offers, and it requires all
three arms to appear, because a classifier that answered `done` to everything
would pass a corpus of nothing but `done` — and that is precisely the broken
model this exists to catch. Every case carries a `why`, because when one starts
failing the question is whether the model drifted or the case was wrong, and
only a recorded reason answers it later without re-arguing the corpus.

### 2026-09-01 — Who an automation runs as becomes state somebody can take over

**What changed:** `automation_state` gains `run_as_user_id`, and the two sites
that built the execution principal from the identity row's `author_user_id` now
resolve `run_as_user_id ?? author_user_id`. `claimExecutionPrincipal` takes the
automation over for its caller, rebinds each dead personal binding to the
claimant's own connection for the same plugin, and records what moved and what
could not in `automation_principal_claims`. `POST
/automations/:id/execution-principal` is the route; a system row carrying
`automation_principal_unavailable` is the card that prompts it.

**Why:** A work stream's automation outlives its author — that is the point of
the room owning it — but the principal was derived from an immutable identity
column, so an offboarded author took the automation down with them. Separating
the two lets "who runs it" move while "who wrote it" stays provenance the run
history keeps reporting.

**Considered and rejected:** A body naming the claimant. That field would let
one person lend a colleague's Gmail to a standing automation; agreeing to run
your own credentials is something the person does themselves, so the caller is
always the claimant and the body is empty. Also rejected: refusing a claim when
the claimant lacks a connection for one of the dead providers. The room would
rather have most of its automation back, so the takeover proceeds and the
missing providers are reported for the card to keep naming.

**Consequences:** Bindings to workspace-scoped connections are never rewritten —
they belong to the workspace rather than to whoever authorized them, so they
never broke. The claim is idempotent on "already runs it with nothing to move",
so a retry after a lost response writes no second audit row. Filling this in
also revealed that `assertManager`'s `participantOfOwningWorkstream` arm had no
caller: pause and resume now resolve participation through WorkspaceDO, which is
what makes a room's automation manageable by the room at all.

### 2026-09-01 — An owned automation follows its room into the archive

**What changed:** AutomationAgent answers `pauseForArchivedWorkstream` and
`resumeForUnarchivedWorkstream`, and `pause`/`resume` now write and clear
`automation_state.paused_reason`. Archiving or unarchiving a work stream fans
out to the automations it owns, found through WorkspaceDO's
`automationsOwnedByWorkstream`.

**Why:** A room's automations belong to the room, so a decision about the room
is a decision about them — that is what ownership buys over a creator who may
be gone. The two new entry points skip the manager check because nobody is
acting on the automation; they check ownership instead, so a room an automation
merely delivers into has no say over whether it runs.

**Considered and rejected:** Resuming every paused automation when a room comes
back. Without `paused_reason`, an automation somebody deliberately stopped and
one the archive stopped are the same row, and unarchiving would restart the
first. Also rejected: doing this inside the work stream's own commit — each
automation is a separate object, so the fan-out is asynchronous and happens
after the room's state is settled.

**Consequences:** The fan-out is best effort per automation and every refusal is
a decision rather than a failure: already paused, paused by a person, no longer
owned. One object refusing must not stop the rest, so failures are logged and
the loop continues. An automation whose pause reason is `person` is invisible to
unarchiving, permanently, until a person resumes it.

**Only archival is wired, because only archival exists.** The design this
implements also says deleting a work stream deletes the automations it owns, and
that clause has nothing to attach to: Rally has no work-stream deletion path.
`deletion_epoch` is a column on the work-stream object that nothing writes,
there is no delete operation on the product service, and the client's removal
affordance is Archive. Whoever builds work-stream deletion owns adding the
cascade beside `applyArchiveToOwnedAutomations`; inventing a deletion path here
to have somewhere to hang it would ship a destructive operation nobody asked
for.

### 2026-09-01 — An automation a work stream can own

**What changed:** `workstream` joins the automation scope vocabulary.
AutomationAgent schema version 9 rebuilds `automation_acceptance` to admit it
and to carry `owning_workstream_id`, paired to the scope by a CHECK so the two
cannot disagree; WorkspaceDO version 26 rebuilds `automation_directory` the same
way and adds an index for the per-room read the sidebar's index does not serve.
`automation_state` gains `paused_reason`. Nothing sets the new scope yet — the
authoring path that would is a later change — so every existing automation
crosses both rebuilds unchanged and owning nothing.

**Why:** An automation attached to a work stream is a standing behavior of that
work stream: authored there, managed by whoever is there now, and delivering
there. Keying any of that to its creator makes a personnel change into a silent
product failure, and keying it to the workspace makes a room's business
everybody's.

`paused_reason` exists because archiving a work stream will pause the
automations it owns and unarchiving will resume them — and resuming everything
is wrong. An automation a person paused last month must not come back to life
because somebody unarchived the room, so only rows that say
`workstream_archived` are resumed.

**Also, and it is a loosening:** acceptance no longer requires owner-or-admin
for `workspace` scope. `connection-service.ts` already lists workspace-scoped
connections to every member, so a member can call that connection's tools from a
run in their own work stream today; a workspace automation adds a *schedule* on
something they can already do, not a capability they lacked. What the workspace
acquires is a standing object it must manage, so editing, pausing and deleting
one stay owner-or-admin. The residual is that it runs unattended and repeatedly
where interactive use is attended and once, and the workspace learns of it by
seeing it in the list rather than by being asked.

**Considered and rejected:** widening the shared `ScopeSchema`. A work stream
has no third scope, and the enum is used wherever a room's audience is chosen —
widening it would offer `workstream` in every one of those places. Automations
got `AutomationScopeSchema` of their own instead.


### 2026-09-01 — A completed run's result is judged before it is delivered

**What changed:** `resolveRunDisposition` on AutomationAgent, four columns on
`automation_runs` (DO schema version 8), and one call from the child's
settlement path before its delivery loop. The answer is `done` or `deliver`
today; `expose_workstream` exists in the column's CHECK and is deliberately not
offered until there is a code path that can act on it.

**Why:** Every completed run delivered something. The only escape was
`shouldSuppressAutomationResult`, a regex matching one English phrasing about
emails, so "No changes in the pipeline this week" was delivered and a real
finding whose wording happened to match was silently withheld. That is
survivable for one person's inbox and not for a shared room, which is what the
automations-in-a-work-stream PRD needs it to be safe for.

**Considered and rejected:** letting the run decide, with a tool. It has the
most context and costs no extra inference, and it is the loop untrusted trigger
content steers — a disposition it chooses is one an attacker can influence in
both directions, and a turn that went badly ends most gracefully by declaring
there was nothing to report. The classifier reads the run's output from outside
it, holds no tools and no credentials, and answers a schema of two or three enum
values and a sentence.

**Also:** the arms are rendered into that schema from what the automation can
reach rather than checked afterwards, so an arm it has no use for is not a value
the model can emit; and an automation that can reach nobody spends no inference
at all.

### 2026-09-01 — Abandonment fences already-addressed automations

**What changed:** AutomationAgent now reads the regional workspace lifecycle
before compiler/provider dispatch, schedule handling, run provisioning, and
outbox delivery. Observed abandonment pauses schedules and terminalizes the
object's pending work; an unavailable lifecycle read fails closed.

**Why:** Closing route and socket admission does not stop an AutomationAgent
whose own alarm was already stored. Without a local operational check it could
call a provider or provision a child after the final member abandoned the
workspace.

**Considered and rejected:** Relying on membership revocation fan-out or adding
a second pushed lifecycle projection. The former does not own every alarm lane;
the latter creates another value whose delivery must race the D1 authority.

**Consequences:** Each execution lane pays one regional D1 read before external
work. D1 failure delays work visibly through the existing alarm retry, while
abandonment is terminal for pending local operations.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-31 — The create boundary's own refusals stop answering 500

**What changed:** `AutomationAgentService.accept` raised
`automation_draft_id_required` and `automation_definition_revision_stale` as
bare `Error`s. Both now go through `automationRefusal`, a new export of
`automation-agent-errors.ts` that reads the same table `withAutomationErrors`
does, so they answer 422 and 409 with the sentences already written for them.
A third refusal joins them: a draft whose first compiler run has not settled has
no definition row, and `AutomationDraftSchema.parse(null)` threw a `ZodError`
from between the two. The table `satisfies` its shape now, and the codes
`automationRefusal` accepts are its keys, so a misspelled one loses its specific
sentence at compile time rather than at a call site nobody tested. The
`listAutomationDirectory` call the service made outside a wrapper is wrapped as
well, and its `automation_directory_access_denied` — with
`automation_author_access_denied`, the matching refusal on the first authoring
send — gains a table row at 403. `automationApiError` also rebuilds an `ApiError`
a collaborator raised inside the object, whose class does not survive an RPC hop.
On the client, the create screen gains its own sentence for the stale refusal,
ranks a failed create ahead of the older compiler failure that used to render
over it, and clears the notice when a new turn makes it untrue.

**Why:** `errorHandler` maps anything that is not an `ApiError` to `500
internal_error` / "An unexpected error occurred". The whole point of the error
table is that a refusal is not a fault, and these two sat outside the only
wrapper that reads it — so the create screen showed one unexplained sentence and
no next step for the two cases the table has the clearest answers to. Both
reproduce against a local stack: `POST /automations` with a draft that is not
byte-identical to the stored definition, and one with no `draftId`, each
answered `500 internal_error`. That status is also what any client backing off
on 5xx retries, and every occurrence was logged at error severity beside genuine
faults, which is why nothing in the logs distinguished them.

`listAutomationDirectory` was the same defect one step earlier: it refuses a
non-member with `automation_directory_access_denied`, object vocabulary that
reached the member as the same 500. Both membership refusals sit at **403**
rather than on the `SAFE_CODE` fallback's 409, because 409 is the status a
client retries and retrying is the one thing that never turns a non-member into
a member. They are reachable: the membership read in `requireAuth` and the one
inside the object are two separate reads of `workspace_members`, so a revocation
landing between them arrives here.

The larger half of the same class is `acceptDraft` reaching
`WorkstreamEmailRoutingService` to claim the automation's address. That service
throws `ApiError`, and an EU region whose `GLOBAL_EMAIL_ROUTER` binding is
unreachable raises a deliberate 503 there — which arrived as `500` because
`instanceof` does not survive the hop and the human sentence matches neither the
table nor `SAFE_CODE`. `automationApiError` now recognises it by shape, which
does survive. This one is defence rather than a proven repair: the workers pool
preserves the class, so the test that guards the outcome passes with the rebuild
removed, and the boundary where it does not is one no suite here reproduces.

`applyAutomationProjection` is deliberately **not** wrapped. Everything it can
throw is a fault rather than a refusal — a `ZodError` on its own strict schema,
`workspace_object_identity_mismatch`, or `automation_projection_hash_conflict` —
and the table cannot express a fault. An earlier revision of this change did
wrap it, which moved a real defect onto the generic 409 instead of the 500 that
is true of it.

**Considered and rejected:** Raising these through `automationApiError(new
Error(code))`, which needs no new export. The claim that a typo would otherwise
fall through to a 500 was checked and is false — every plausible misspelling
keeps the `automation_` prefix and lands on `SAFE_CODE`'s generic 409 — so what
the key union actually buys is narrower than it first looked: the specific
status and sentence cannot be lost at a call site without a test. That was
judged worth one exported function and a type alias, and the `as const` and the
parallel `Map` an earlier revision carried were dropped once `satisfies` alone
was shown to preserve both the key union and the literal statuses.

Also rejected: wrapping every unwrapped object call on sight.
`withAutomationErrors` is right only where the call can refuse; where it can
only fault, its `SAFE_CODE` fallback converts a defect into a retryable-looking
409 and hides it. Also rejected: wrapping the whole of `accept` in
`withAutomationErrors`, which is shorter and makes every throw in the method
look like the object's. The file's own note explains why the wrapping is per
call site rather than blanket, and a refusal this boundary decides for itself is
worth reading as such. Also rejected: loosening the byte-identical comparison so
the stale case stops arising. The comparison is the acceptance contract — the
caller is confirming the definition it showed a person — and a mismatch it did
not refuse would create an automation nobody reviewed.

**What a future change has to respect:** A refusal decided in the service, not
the object, still belongs in `AUTOMATION_ERROR_RESPONSES` and must be raised
with `automationRefusal`; `throw new Error(code)` outside a wrapper is a 500
again, and the type only protects the codes, not the raising. Before wrapping a
call, ask what it can throw: a fault is better left at 500 than dressed as a
conflict. `automation_region_mismatch`, from `claimAutomationDraft`, is such a
fault still riding the `SAFE_CODE` fallback at 409 — left alone here because
narrowing that regex changes every code it covers, not just this one. The stale
refusal
now says "This draft changed while you were reviewing it. Reload and try again."
That is the right sentence for the race it was written for — a compiler turn
settling while somebody reviews — and the wrong one for a client whose bundled
copy of `AutomationDraftSchema` differs from the server's, where reloading
changes nothing. Distinguishing those needs the revision the caller reviewed to
travel with the request, which this change does not add. The refusal now logs
which top-level fields disagreed — names only, never values — so the two are at
least distinguishable in the log.

Three things this change deliberately did not take on, each named because the
next person will meet them here. The sixteen per-call-site `withAutomationErrors`
wraps could collapse into one middleware on the two routers that construct this
service, which is where a missed site came from in the first place; that is a
change to every automation route's error mapping at once and wants its own
review. `automation_region_mismatch` still rides `SAFE_CODE` at 409 as a fault
dressed as a conflict; narrowing that regex changes every code it covers.
And a directory refusal now has a sentence the sidebar has no branch to show —
it still renders a denial as "No active automations".

Shipped in [#450](https://github.com/juno-ai-labs/avalon/pull/450). Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md).

### 2026-08-31 — Connector reads leave regional D1 for the object that has the rows

**What changed:** the three statements AutomationAgent sent to its own `env.DB`
for `connector_connections` and `slack_user_links` — the plugin-binding read in
`prepareAcceptance` and both reads in `resolveDeliveryTargets` — now go through
`withWorkspaceRuntimeDatabase`. The `users` read beside them stays on the
regional binding, which is the authority that has that table.

**Why:** migration 0090 dropped both tables from regional D1 when the workspace
authority opened; WorkspaceDO is their only live authority. The object kept
asking D1 for them, so every one of those reads raised `D1_ERROR: no such
table`. That is not one of this object's snake_case codes, so
`withAutomationErrors` passed it through unmapped and `errorHandler` answered
`500 internal_error`. What a person saw: ticking Slack DM under **Delivered to**
on an automation put "An unexpected error occurred" under the list and left the
box unticked, with no way to save a connector destination at all. Acceptance
carried the same defect on the same table — choosing any connector plugin for a
new automation failed the same way, and equally silently.

The same read also gained `AND status <> 'disabled'`.
`connector_connections_active_model_plugin_id_uq` is partial on
`status != 'disabled'` and `allocateModelPluginId` hands a disabled row's name
back out, so connect/disconnect/reconnect leaves two rows sharing one
`model_plugin_id`; `new Map` kept whichever an `ORDER BY`-less scan returned
last, and a disabled winner refused a plugin the create screen had just offered.
The predicate is the one that screen's own catalog applies. Two delivery codes
that were thrown but unmapped — `automation_email_delivery_unavailable` and
`automation_workspace_connection_required` — were added to the error table, so
both halves of the destination list answer with a sentence rather than one of
them falling to the generic net. And `detailUnchecked` stopped projecting a
Slack target's `displayName` as the raw provider id: that field is read only for
a destination whose connection is gone, where `U0ABCDEF` was the sole label on
the one row telling a person something was wrong.

**Considered and rejected:** wrapping the object's whole `env` once in the
constructor. Not for the reason that first suggests itself — an earlier draft of
this entry said it would wrongly route identity and membership reads through the
facade, which is false: the compiler turn already hands `compileAutomationDraft`
an env wrapped exactly that way, and its `searchPeople` runs
`workspace_members JOIN users` through it to regional D1 without incident. The
real obstacle is that the port needs a workspace id and the constructor has
none — identity is read from storage behind `await this.initialized`. A private
`workspaceDatabase(workspaceId)` is what that leaves, and it is what the object
now has; `workstream-object-product.ts` had already arrived at the same shape.

**Considered and deferred:** converting these reads to typed WorkspaceDO methods,
which is where the rest of the facade is going.
[`connectors.md`](connectors.md) rejects converting `connector_connections`
deliberately — it carries the AES-GCM credential envelope and interlocks with
regional control-plane writes — and [`digests.md`](digests.md) rejects carving
out one of its reads because it would leave that domain's boundary drawn in two
places. Routed SQL is the correct interim here; these three reads convert when
`connector_connections` does, and not before.

**What a future change has to respect:** a Durable Object gets the raw
environment. Unlike a service, nothing wraps its `DB` on the way in, so any
statement it sends that names a `WORKSPACE_LOCAL_TABLES` table has to be routed
explicitly. That is no longer only prose:
`apps/api/test/durable-object-workspace-table-routing.test.ts` scans every object
under `durable-objects/` and fails on one, importing the real
`WORKSPACE_LOCAL_TABLES` rather than a copy of it — the list drifts precisely
when a table is added, which is the moment the guard matters. An ESLint rule was
the other candidate and was rejected for that reason: rules are `.mjs` and would
have to restate the list.

Worth knowing about the region that has not cut over: migration 0090's guard is
a `CHECK` that aborts, so such a region keeps the D1 shells — but every *writer*
of `connector_connections` already routes through the port, so those shells are
empty. Before this change that region did not answer 500; it answered
`automation_delivery_connection_unavailable` for a connection that plainly
exists, which is the worse of the two, because it reads as a legitimate refusal
rather than as a fault.

### 2026-08-29 — The template gallery becomes three typed WorkspaceDO methods

**What changed:** `listAutomationTemplates`, `publishAutomationTemplate` and
`addAutomationTemplateVersion` replace the six statements
`automation-service.ts` sent through the workspace runtime facade. The SQL
lives in `workspace-automation-template-storage.ts`. The gallery's author names
stay a regional lookup in the service, because they join `users`, which the
object does not have.

**Why:** the facade routes by table name and sends anything it does not
recognise to the regional database. Beyond that, adding a version read
`latest_version_number` and then wrote the incremented value in a separate
batch. Two people publishing a revision at the same moment both read the same
number and both wrote it, and `UNIQUE (template_id, version_number)` refused
the second — a 500 with nothing in it a person could act on. Inside the object
the read and the bump are one critical section, so the numbers are consecutive.

`automationTemplateOwnership` is a preflight the service asks before it
validates a draft's connectors. Moving the write into the object had put the
ownership fence after that validation, so adding a version to a template that
is missing, archived, or somebody else's answered with a connector error
instead of the 404 the endpoint has always given — a changed contract, and one
that describes connector state to a caller with no claim on the template. The
transactional write still fences on ownership; the preflight decides only what
is said.

**Considered and rejected:** returning the gallery already joined to author
names. The object has no `users` table and no business acquiring one; asking
it to would put a regional identity read behind a workspace-product method.

**What a future change has to respect:** `usedBy` is zero because nothing
counts subscriptions any more — the cutover moved them to AutomationAgent and
dropped the table the count joined. The literal `0 AS use_count` in the old
query said the same thing less clearly, and making it plain in code does not
make it right: `new-automation.tsx` renders the value into "by {author} · used
by {count}", so every card in the gallery has read "used by 0" for every
template in every workspace since the cutover. That is a user-visible defect
this change documents rather than fixes, and the honest options are to drop the
field from the route contract and the desktop row, or to have AutomationAgent
answer the count. It is not settled, and nobody should read "reports zero
rather than a number it cannot know" as "the interface is fine".

### 2026-08-29 — The cutover has run, and its deploy scaffolding is removed

**What changed:** The three one-shot steps that carried the authority cutover —
the single-region refusal, the preflight ledger wake, and the `--apply` — are
gone from `deploy-api.yml`, along with the two workflow tests that asserted
their ordering and the release summary paragraph that asked for their removal.
`scripts/cutover-automation-agents.mjs` stays, as an operator tool rather than
a deploy step, and gains `--workspace=<id>` so that repairing one workspace is
one message rather than a regional fan-out. The
`AUTOMATION_CUTOVER_DRAIN_TIMEOUT_MS` justification is corrected, as is every
neighbouring comment and document section that still described the script as
something a deploy runs.

**Why:** The cutover ran in production on 2026-08-28 and cannot run again
meaningfully; every step above was written to be temporary. The refusal is the
one that costs something if it stays: it bans an EU-only or Global-only deploy
outright, so the next person needing a one-region hotfix would be blocked by a
gate naming a cutover that finished months earlier, with nothing to tell them
it had already happened.

The limit's stated reason was simply wrong, which is worse than terse. It
claimed a failing message would retry forever without reaching the dead-letter
queue; the command queues carry five retries and a dead-letter queue, and the
drain loop already fails on any rise in that count. The real exposure is a
drain that is slow, or a backlog that never reads zero because
`avalon-<region>-migration-commands` is shared with the migration tracker's
"Force a migration" fan-out — a case nobody had written down.

**Considered and rejected:** Deleting `cutoverWorkspaceAutomations`, the
campaign table, and the script outright. That is the honest end state, but it
requires knowing every workspace completed, and the cutover proves completion
only negatively — an empty backlog and a flat dead-letter count. There is no
per-workspace receipt to read, which is a gap the original change already
recorded. Until something can answer that positively, keeping the remedy costs
a dead file and losing it strands any workspace the sweep missed.

**Consequences:** A single-region deploy is possible again. Anyone reviving the
script by hand needs the Cloudflare credentials the deploy job used to assert,
and should name the workspace: a region-wide run wakes every WorkspaceDO in it,
shares a queue with the migration tracker's force-migration fan-out, and is the
case whose drain wait is unbounded. A `503 automation_cutover_in_progress` is no
longer a wait — with no cutover deploy left it names a workspace that was
carried over and never finished, and the targeted `--apply` is its repair.

### 2026-08-28 — One durable authority replaces the wizard and the subscription split

**What changed:** `AutomationAgent` is a new Durable Object class that owns an
automation from its first authoring turn through acceptance and every run after
it: the draft conversation, the compiled definition and its revisions, typed
external-event rules, local timers, occurrence admission, generated-run
provisioning and history, automation-owned memory, inbound-email admission, and
result-delivery receipts. WorkspaceDO keeps a content-free `automation_directory`
row, the typed evaluator registrations and delivery ledger, and the viewer
authorization the agent asks it for. The desktop has one stable
`/automations/:id` route with a draft adapter and an accepted adapter over the
shared conversation surface. One coordinated deployment imports every accepted
automation, discards legacy drafts, and drops the old tables. The facets below
each carry their own reasoning.

**Why:** The former design split one product concept across independent
authorities — a compiler loop, subscription rows, the workspace scheduler, and
three separate run producers — with no single place to reserve a transition. A
draft was a row in a table whose lifecycle column was also the run state, so a
draft nobody finished was indistinguishable from an automation in trouble; a
model override reached manual runs and was silently dropped by scheduled and
activity-triggered ones because each of the three producers built the work-stream
row itself. One object gives every transition one transactional owner while
leaving connector fan-in centralized where the events already arrive.

**Considered and rejected:** Making `AutomationAgent` a `SubstreamAgent`
subclass, which couples authoring and parent lifecycle to a child execution loop.
Keeping automation state in WorkspaceDO, which preserves the backwards link and
the dual-authority failure modes. Dynamic Workers per automation, rejected
because the trigger vocabulary is declarative and has to stay inspectable,
type-safe, and unable to run arbitrary connector code. A staged per-automation
flag with dual writes and a frozen legacy rollback source, rejected because there
are no customer automations to carry through a compatibility window and the extra
machinery would make the failure modes harder to reason about, not easier.

**Consequences:** An automation begins only on first send and keeps one ID
through acceptance. Anything asynchronous must carry the authority generation or
it will land after a pause or a delete. Adding a connector extends manifests and
typed fixtures rather than adding an execution substrate. The merge is
operationally irreversible after cleanup, which is why it carries its own
preflight, per-workspace receipts, DLQ gates, and a final health check — and why
the deploy workflow now refuses to replace one region without the other.

#### Acceptance deletes the draft conversation

**What changed:** Committing an acceptance drops the transcript turns, blocks,
facts, Bind loop rows, compiler runs, tool receipts, staged submissions, and
every definition revision but the accepted one, and resets the realtime cursor.

**Why:** The conversation exists to produce a definition. Once that definition is
frozen and running, the turns are a copy of the model's reasoning about a
document that no longer changes, kept in the object that also has to stay small
enough to serve run history quickly. Keeping them also meant an accepted
automation had two plausible answers to "what is this", one of which nothing
maintains.

**Considered and rejected:** Retaining the conversation read-only. It doubles the
object's largest table for a surface no accepted-automation screen renders, and
it invites a later change to re-open authoring on a definition that is already
installed as a trigger route.

**Consequences:** There is no "how was this automation written" view after
acceptance, and adding one means re-deriving it rather than reading it back.
`automation_state.projection_version` exists because of this deletion: the
realtime `event_sequence` resets here, and a projection version derived from it
went backwards and left the directory showing a live automation as a draft.

#### A generated run is personal to the automation's author

**What changed:** Every generated work stream is created with `scope: "personal"`
and the automation's author as its only participant, regardless of whether the
automation itself is personal or workspace-scoped. This reverses the
2026-08-25 decision recorded in [`data-model.md`](data-model.md) that every
automation-generated work stream copies its automation's scope.

**Why:** A child run is a nested execution record, not a room. Copying workspace
scope made every member a reader of every run of every workspace automation,
including runs over a connection they cannot otherwise see, and made the run's
audience a second, independently drifting answer to a question the automation's
own scope already answers.

**Considered and rejected:** Keeping scope inheritance and filtering the run list
per viewer, which leaves the work stream itself workspace-readable and only hides
the index into it.

**Consequences:** A workspace automation's runs are visible to its author. Any
future surface that shows another member a run has to widen the child's
participants deliberately, and the run-authority check that re-reads the parent's
live generation is what any such widening must not bypass.

#### One run producer, one frozen context

**What changed:** `AutomationService.createRun`, the workspace scheduler's
`startAutomation`, and the activity consumer's `startActivityAutomation` are
gone. Every trigger — manual, schedule, connector event, inbound email — inserts
an `automation_runs` row with a complete `AutomationRunContextV1`, and one alarm
lane provisions it.

**Why:** Three producers each built the child work-stream row inline, so a column
added to one was honoured by manual runs and silently ignored by the other two.
That is exactly how the model pin shipped in review, and nothing about the shape
of those three call sites would have caught the next one.

**Considered and rejected:** Keeping three producers behind a shared helper. The
helper existed; the drift happened anyway, because a helper does not stop a
caller from writing the row itself.

**Consequences:** A field a run needs is added to `AutomationRunContextV1` and is
then frozen at admission — a run reads what it was given, not what the automation
says now. Changing what a run may do therefore takes effect on the next
occurrence, not on the one already claimed.

#### A pause or delete stops work already in flight

**What changed:** Pause, resume, and delete bump the automation's authority
generation, and a generated run re-reads the parent's live lifecycle and
generation before issuing a connector write.

**Why:** The frozen run context proves what a run was authorized to do when it
started; it cannot prove the automation still wants it done. A run that outlived
its own automation would otherwise keep writing to providers on consent that had
been withdrawn — the failure a person expects **Pause** to prevent.

**Considered and rejected:** Cancelling the child run outright on pause. That
loses a partially finished run's work and its transcript for a state the user may
undo a minute later; refusing only the outward-facing writes keeps the record and
stops the effect.

**Consequences:** Every new asynchronous path into an automation carries the
generation, and a path that does not is a way for withdrawn work to land. Delete
archives generated children through the outbox rather than deleting them, so a
run's record survives the automation that produced it.

#### AutomationAgent holds its own socket room and joins access revocation

**What changed:** The draft screen opens a hibernating WebSocket to the agent
through a fourth ticket audience, dialled by Electron's Node broker as a third
route kind. The room consumes its ticket ID once, re-checks the session against
D1, and admits only the author. `WorkspaceDO.revokeSocketAccess` now returns
automation IDs and the access-revocation consumer fans out to each agent.

**Why:** Compiler streaming had no durable channel: the previous design streamed
a response body, so a closed window lost the run's narration and a reconnect
could not recover it. A room with the object's own event log behind it makes the
stream resumable. And a room that admits on a ticket never re-authorizes, so
without joining the revocation fan-out an automation feed would stay open after
its holder lost workspace access — the one thing that queue exists to prevent.

**Considered and rejected:** Reusing the workspace socket for compiler frames.
Draft narration is high-frequency and belongs to one screen; putting it on the
singleton connection makes every member's workspace socket carry one author's
model output. Polling `GET .../agent/draft` alone, which is still the recovery
path but cannot carry deltas at a readable cadence.

**Consequences:** Any new socket-holding Durable Object has to be added to the
revocation walk, and the class list in
[`access-revocation.md`](access-revocation.md) is where that is recorded. The
room is author-only, so a workspace automation's live draft is narrower than its
REST readership by design.

#### The compiler's resource search is scoped to the author's own connections

**What changed:** The architect's resource search joins `connector_connections`
and admits a row only when the connection is not disabled and is either
workspace-scoped or owned by the author.

**Why:** The previous statement selected every resource in the workspace and then
looked up plugin IDs from a separate unscoped query. Resource titles routinely
carry customer, deal, and candidate names, so a personal connection's resources
could be surfaced into another member's draft conversation.

**Considered and rejected:** Filtering after the fact in the mapping step, which
is what the old code effectively did and what let the two statements disagree.

**Consequences:** The filter and the plugin lookup are one row now; a future
column the search needs must come off the same join rather than a second query.

#### The wire carries an attention reason; the client owns the words

**What changed:** `AutomationSummary` and `AutomationDetail` carry
`attention`, a nullable enum of `unsupported_trigger`,
`legacy_runtime_error`, and `run_projection_integrity_conflict`.
`applyAutomationProjection` parses the incoming `attentionCode` against that
same enum rather than accepting any string, so a code no screen can render is
refused where it is written rather than stored and later ignored. Both
directory readers project it beside `status`, `detailUnchecked` returns the
object's own copy, and every AutomationAgent projection now carries the
object's current attention code instead of a hard-coded `null`. The sentences
a person reads live in the desktop client.

**Why:** The cutover already computed both of the first two codes — a legacy
trigger with no equivalent in the new runtime, and a subscription that was
already failing — and nothing carried them past WorkspaceDO. Worse, the
cutover *pauses* an automation whenever it sets one, and both readers rank
`paused` ahead of `attention_code`, so the entire account a person got of an
automation that will never run again was the word "Paused". An upgrade that
silently strands somebody's automation and then declines to say so is the
failure this facet exists to close.

**Considered and rejected:** Sending the sentence from the server, which would
have frozen the copy into every row already projected and let text written for
whoever was debugging the cutover reach a product surface — the stored
`automation_state.attention_message` is exactly that, operator-voiced, and is
now read by nothing. Keeping the write boundary at `z.string().nullable()`,
which is what let a stale fixture project `"paused"` — a lifecycle state, not
a reason — without complaint.

**Consequences:** A new reason is a contract change and a client change
together; adding one server-side alone renders nothing. `status` semantics are
untouched, so an automation with no attention code is unaffected. Two gaps
remain and are deliberate: `run_projection_integrity_conflict` is set on the
object and shown in the detail read but enqueues no projection, so the sidebar
learns of it only at the next unrelated projection; and whether `error` should
outrank `paused` for a carried-over automation is a product decision nobody
has taken.

#### Scope cut: the shared substrate is the schema, not the Bind state

**What changed:** Only the frozen schema array, the canonical JSON and fact
store, and a plain-turn writer were extracted to
`durable-objects/ordered-transcript-sqlite/`. The Bind-loop ledger, activity
store, snapshot store, and kernel named in the PRD were not, and
`workstream-transcript-storage.ts` still implements every richer read and write
itself. AutomationAgent installs the `bind_loop_*` tables with the rest of the
array and never writes them, so the compiler's exact Bind state — goal 10's
second half — is not durable: an evicted run re-enters the model from the stored
conversation.

**Why:** The cutover is irreversible. Moving the work-stream transcript's reads
onto a new shared module, or building a second durable Bind host, in the same
change would have put the whole feed at risk for a symmetry no product behavior
needed. The staged mutations and tool receipts already make a re-entered compiler
run safe, which is what the recovery requirement was actually protecting.

**Consequences:** A fix to an ordered-transcript read applies to one host and not
the other, and a compiler run that is evicted mid-turn costs one model turn
again. The empty `bind_loop_*` tables are inside AutomationAgent's released
migration 1 and cannot now be removed from it. Picking the rest up is a change of
its own; [`ordered-transcript-sqlite.md`](ordered-transcript-sqlite.md) records
what would have to be true.

Shipped in the pull request for this change. Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md).
