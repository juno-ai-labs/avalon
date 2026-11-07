# Sidekick lifecycle

A Sidekick lets a person delegate work or knowledge. Its Organization's
`WorkspaceDO` holds its identity, immutable definitions, optional triggers, and
runs, through `HostedSidekick`; how it got there and how it is stored are
[`hosted-conversation-parents.md`](hosted-conversation-parents.md#a-sidekick-is-hosted-beside-them)'s.
The legacy `SidekickDO` that held them before is deleted.
Substream `0` is the authoring conversation; delegated runs are child substreams.

## Delegation consent authority

`sidekick-delegation-storage.ts` owns consent in WorkspaceDO. The strict shared
inputs and outputs live in `packages/contracts/src/sidekick-delegation.ts`.
`HostedSidekick` admits enrollment through current membership and the existing
viewer rule, independently of definition management. Each grant retains its
membership incarnation, generation, original opt-in time, safe label and actor/
request provenance. Eligibility requires the same current incarnation and viewer
access. Pausing retains consent; removing a membership and rejoining never
reactivates the old incarnation's authority.

The host prepares a mutation before dispatch. Preparation records intent without
an enrollment check; the actual mutation authorizes membership and visibility
once before it can grant authority. Preparation durably retains that
operation's observed generation, including across a lost response. Allow checks
it atomically; withdrawal always advances a tombstone, even for an absent grant.
Accepted intents and outcomes have immutable receipts. Replaying an accepted
intent does no write, and a receipt superseded by another generation reports a
stale action instead of presenting its old result as current. A new allow needs
a new delegation action. This orders consent writes inside one object; it adds no
synchronous cross-object authorization barrier or provider probe.

Every creation immediately enrolls its creator, including autonomous creation.
The creation transaction records the grant once under the Sidekick ID, using the
creator's current membership incarnation. No direct-human provenance lookup,
creator-consent marker or disclosure screen is required. Creation replay never
restores an existing withdrawal.

`sidekick-delegation-service.ts` supplies signed-in self-service and exact
viewer-authorized UUID, canonical link or name lookup. Named lookup is not limited
to editable Sidekicks; ambiguous visible names refuse with a stable code.
Sidekick routes serve `/sidekicks/:id/delegation`. There is no Account settings
withdrawal screen or dedicated account HTTP endpoint. The agent's own-grant
lookup and self-withdrawal retain a person's stored grant and safe label after
access loss within the current Organization. The tools never discover or route
to grants in other Organizations. The old D1 `sidekick_delegation_locations`
table is unused; its migration remains immutable.

The `rally:sidekicks` plugin exposes `my_delegations_list`, `delegates_list` and
`set_delegation` during direct and autonomous work. Authoring and Sidekick
activations use the `sidekick` prefix; room presentations use full wire names.
Both presentations teach the resulting `sidekick_` wire names. Configuration
chats use the chatting person's accounts; only activations and delegated work
receive the Sidekick's eligible account pool.
The mutation accepts `{ sidekickId, userId, allowed }`: the model selects a
current Organization user, while the host supplies the execution actor. The
actor needs existing Sidekick access to change another person; the target needs
active Organization membership to be enrolled. A grant alone changes no human
visibility or manager rights. There is no canonical-speaker or special
quoted/event-consent check. The UI retains self-service only; the manager removal
control and endpoint are removed.

Admission uses this authority for events, schedules and manual runs. A run stores
`coordinator_user_id` independently of the directory's legacy human-access field.
Manual Run prefers an eligible requester but never opts them in. Schedules prefer
an eligible saved source owner, then the creator and stable grant order. Personal
events require their source owner's eligible grant; restricted workspace events
require an eligible delegate inside their actual audience. Matching and delivery
both apply this policy, while preserving activation boundaries, deterministic
filters, semantic conditions and occurrence deduplication. Ownership scope alone
never rejects an otherwise eligible event. Coordinator selection checks an
eligible preferred user first, then configured source owners, the creator and
remaining grants. Audience restrictions narrow candidates before eligibility
checks. Matching evaluators share pending eligibility checks only within that
matching request, keyed by Sidekick, user and grant generation; delayed delivery
checks again independently.

An occurrence with no delegate gets a `needs_input` run and safe recovery summary;
an unauthorized event retains no private payload in the Sidekick. Its directory
has a safe `delegationAttention` code and recovery message. Source reconciliation
clears a source warning when coverage returns; unrelated manual or scheduled
admissions do not clear it. Permission-report warnings survive source recovery.
New consent applies
to future occurrences rather than replaying blocked historical work. A continued
run retains its coordinator while eligible and selects another eligible delegate
when that person becomes unavailable. The new coordinator is persisted on the
existing run. Only an empty eligible list refuses with `run_no_eligible_delegate`.
Eligibility refreshes at activation and inventory loading. An ongoing background
attempt reuses that snapshot; model/tool boundaries read the root lifecycle and
stop generation without rescanning delegates or comparing coordinators. Pause,
delete and pause/resume still fence old work.

Migration retains existing `run_as_user_id` as a stable shared-file identity and
preserves existing human access. A durable alarm enrolls missing
creators and established previous task-account users without reconstructing
historical consent provenance. Existing grants and withdrawal tombstones are
never overwritten. A follow-up migration queues creators that an earlier local
version left ungranted. The legacy claim endpoint records self-consent without new human access
entitlements, rebinding configured sources or
changing creator preference. Neither these grants nor coordinator selection
replace the directory's existing reader/manager entitlements.

An activation whose conversation post is refused retains a fixed
`permission_report_unavailable` attention message on the Sidekick. The refused
tool still returns its original failure; normal later admission clears the
attention field. This uses the same directory state as unavailable delegation.

Configured event sources reconcile through `sidekick-source-registrations.ts`.
The saved evaluator remains the source definition. An adapter's authored
`isPortableActivityResource` distinguishes globally addressed resources (Google
files) from account-relative resources (mail and calendars). Only the former
can expand to another eligible delegate's connection. The ordinary resource
resolver creates or finds that connection's Rally resource ID by provider ID;
titles never identify a source. Expanded registrations retain their saved
`sourceEvaluatorId`, so queued delivery still checks the current definition.
Unchanged active registrations keep their ID and event-sequence cutoff. New
or reactivated ones start at the current cutoff; reconciliation does not replay
history. Delivery reads the registration's active state and cutoff from its
existing row read. A removed source refuses a delayed envelope; after
reactivation, an older envelope can only replay an already admitted occurrence,
never create historical work.
Global Google file observations carry a common occurrence key across accounts.
Providers without a common identity keep their existing deduplication semantics.

The existing WorkspaceDO alarm lane stores `sidekick_delegation_sources` work
in the same transaction as consent changes. Apply, resume and legacy enrollment
also queue it. Connection authority changes queue it through migration 130's
SQL triggers, while membership and reader reach use their existing invalidation
paths. Pending changes coalesce into one entry per Sidekick; each enqueue moves
the due instant so an older handler cannot settle a newer change. Cursor and
token renewal do not trigger it. The connection RPC arms the
native alarm after committing the wake. Migration 130 also wakes existing
active configured Sidekicks. The handler refreshes ordinary eligibility and
commits only against the still-current active definition revision. This permits
eventual authorization propagation without a global barrier or provider probe.

Run history carries its coordinating user through the client mapping. Write
operation accounts remain private database debug checkpoints; reads do not look up
or append account checkpoints. App activity does not expose per-operation people
or connection IDs.

Per-operation connector identities, completed-receipt reconciliation, shared
Terminal authorization and desktop/web controls are tracked by the
[implementation plan](PRDs/2026-10-22_sidekick-delegation/plan.md) until all
acceptance evidence is complete.

Sidekick details retain the stored delegation attention message without computing
an unused eligible-delegate status. The separate delegation list loads public
identities and eligibility concurrently after reader authorization.

Delegation list responses include the creator's public identity after
withdrawal and the current allowed users with availability. Membership and
viewer checks still guard the read. Desktop/web show self-service actions with
no manager removal or shared-history disclosure. New Sidekick creates
immediately on opening the route. [Shared UI](shared-ui.md#sidekick-delegation)
owns pending, uncertain-response and offline behavior. The dedicated Account
withdrawal feature remains removed.

Consent receipt reconciliation is a read through
`sidekickReadMyDelegationReceipt`, keyed by the host's original effect ID. It
compares the exact actor, target, intent and source against its durable preparation and
immutable receipt, then checks the current generation. A still-allowed result
also needs current eligibility. It neither prepares a new intent nor mutates a
grant. The normal harness checks this before replaying a completed consent-tool
acknowledgement. Changed generations get the stale-action recovery sentence;
unavailable allowed grants get the enrollment-unavailable sentence. A current
withdrawal receipt remains readable without membership or viewer access.
An interrupted consent tool also reconciles by that original effect identity.
The accepted action's outcome can be saved after response loss; missing or
superseded acceptance cannot trigger a new preparation or another consent
mutation. The existing harness repair path builds the execution user's delegation
subset and preserves the original action ID. It retains a named stale-action
or unavailable reason when no current acknowledgement is safe.

## Sidekick publication and loading

Authoring is conversational. A ready submission saves through `saveDefinition`,
which checks management authority before recording and publishing a revision.
The authoring prompt tells the model that only a refused submission blocks
activation: a connection state check does not, and every Sidekick scope can
configure work using a consenting delegate's personal connection
([`agent-tools.md`](agent-tools.md#2026-10-15--the-connection-check-covers-every-scope)).
The model generates internal instructions and a user-friendly description. An
incomplete submission does not replace the accepted revision. Edits preserve a
person's pause; an archived owning room still refuses publication.
Authoring has two paths. An instruction-only Sidekick is a reusable Skill loaded
into another conversation: its instructions contain the actual knowledge, rules
or procedure, when to use it, and any needed context, constraints or expected
output. It has no triggers or dedicated runs. Tools, resources and delivery steps
are included only when its method needs them. Triggered work instead starts
independent runs and needs a runbook.
Saving a Skill makes its instructions available to load without starting a run.
The authoring guidance follows the setup sequence: preserve scope and read the
current definition, discover resources and capabilities, choose triggers and
test the method, write the runbook, then save and report. Missing required
information calls for a partial draft and a question to the requester; connection
status and another agent's blocker claim are not themselves publication refusals.
The tool descriptions follow the same rules: keep the selected scope, ask the
requesting agent for missing information on delegated setup, and describe saved
behavior without implying a separate approval step.
The legacy `resource_watch` trigger remains in the schema for compatibility;
authoring uses declared connector events or polling because that trigger has no
Sidekick activation path, as `polling-for-events` also explains.

Before submitting executable behavior as ready, the wizard discovers authorized
tools and skills, inspects real resources and sample inputs, resolves their IDs,
and tests the workflow with available reads or non-destructive trials. Schema
inspection is discovery, not a workflow test: the wizard retrieves and transforms
data to produce a representative result, saving working queries or tool arguments
when reusable. It records
what worked, what it could not test, and remaining assumptions. Draft acceptance
is not a workflow test. Future deliveries and other effects stay with future runs
unless requested during setup.

For triggered work, saved instructions form a runbook usable without the setup
conversation:
resources, tools and skills, input formats, ordered steps and decisions, state and
duplicate handling, delivery, success checks, no-op conditions, and recovery from
missing inputs, changed resources, or failures. Verified setup facts, untested
assumptions, and data to refresh each run are explicit. Runs execute the discovered
method rather than repeating setup discovery.

The authoring conversation also has read-only `sidekick_runs_list` and
`sidekick_runs_read`, with `_next({ pageId })` companions. The host fixes their
Sidekick identity; neither accepts a Sidekick selector. List returns newest-first
run summaries and original definition revisions, using a `created_at DESC, run_id`
keyset to reach history beyond the UI's recent runs. Read takes a listed `runId`
and returns its original definition and trigger, current status, chronological
participant transcript (including output links, attachments and feedback recorded
there), and matching tool arguments/results/errors across its activations, each
with its duration (`ms`, from the receipt's start and settlement). The first page
also carries the run's `usage`, read from the run's own object. Its `model` part
comes from `inference_attempts`, the provider's counts per attempt: calls (one
per accepted response, compactions included), failed attempts, input, output
and cached tokens, cost, time, and the first, last and largest call's input.
Its `tools` part gives each tool's calls, definite failures, ambiguous writes
and milliseconds, with a program's own requests (`<id>:call:<n>`) counted apart;
the program's own call's time already includes theirs. Both cover the run's
whole conversation, so tool calls from later chat in it are counted too. A
fixed `note` beside it says every model call sends the whole conversation: a
transcript shows each turn's new message, and a reader that weighs only those
undercounts the cost of a turn.
Exact results use the existing R2 replay reader. Resource receipts are first
reauthorized against the inspecting principal, selected run's attachment scope,
and recorded derivative dependencies; denied results omit input, summary and
payload. Missing, transient and serialization-placeholder results have explicit
availability markers. A page larger than the conversation read budget is served
as fragments of one document: the activation that built the page serves later
fragments from memory (never a page holding a resource result, which is
reauthorized on every fragment), and a continuation that rebuilds it loads in
full exactly the tool outputs the first fragment carried (`full` in its
cursor). The hash a continuation checks covers the run and its transcript, the
turns and their tool calls, not the output bodies. A run whose transcript or
result moved is refused as changed evidence, and so is a continuation whose
rebuilt page does not carry the same outputs in full. Receipt authority
metadata, credentials and private reasoning stay private. Feedback in the home or another attached conversation
is read separately through conversation tools.

Every page resolves current Organization membership and Sidekick read access;
read also checks that the selected child is a run. Its dedicated inspection
operation does not admit a participant, acknowledge read state or wake the run.
A run without a provisioned conversation returns stored definition, trigger,
status and summary with `transcriptAvailability: not_provisioned`.

Evidence has one representation: JSON in `content`, with tool details replacing
participant tool summaries. The definition and trigger appear only on the first
transcript page. Run lists and transcript reads share the existing conversation
maximum page size (50); evidence fragments share its 12,000-character allowance.
`contentOffset` and `pageComplete` identify fragments of one JSON transcript
page, concatenated before parsing. Opaque `_next` cursors retain the sequence
fence, character offset and content hash; each fragment reauthorizes and a
changed or revoked result requires restarting the read. There is no second
history store or new defensive allowance. The wizard's Main and the background
agents it starts there receive these tools (`readsSidekickRuns` in
`sidekick-run-tools.ts`); execution runs, their delegation workers and
instruction-loading conversations do not. A read that names no run serves the
latest delivered review's runs in the notice's order (`reviewRunsToRead` on
the Organization object), carrying the rest of the list in its cursor, so the
wizard hands an agent the assignment and no ids.

The authoring wizard, and the background agents it starts, have their own model
route, `sidekick_authoring`, defaulting
to Sol independently of the ordinary Thread and activation route. Explicit model
pins still win; see [`feature-flags.md`](feature-flags.md). For work requested
after an external change, authoring guidance loads `polling-for-events`, inspects
declared events and resolves the specific source before choosing a timer. When
a suitable event can express the requested change, the wizard uses it and
registers a missing supported source through its authorized connection. An explicitly requested schedule stays in place unless the person chooses
the suggested alternative. A polling fallback names its actual event or resource
resolution gap rather than claiming the connector announces no changes. The saved
definition retains the selected event and resolved resource, or the concrete
reason for polling. The authoring prompt points to the skill for that procedure.

Every activation starts an independent conversation. The Sidekick's wizard,
activations and background agents share one Terminal sandbox; the requesting
Thread and other Sidekicks keep separate sandboxes. Transcripts remain separate;
[`agent-attachments.md`](agent-attachments.md#authorized-work-stream-discovery-and-text-hydration)
defines the resources each run can access. The authoring prompt saves resource
IDs, recovery steps and shared-table access instructions because files can still be lost after
a reset or expiry. For an existing site's refresh,
`building-live-sites` supplies the required import/update/publish procedure and
separates initial publication, activation and verified refresh completion.

Agents can attach resources without starting a run using
[`sidekick_attach_resource`](agent-communication.md).

`automation.loadable` is a stored boolean, not a consumer-derived classification.
The `sidekickLoadable` policy currently returns true for zero configured triggers.
Publication writes the accepted revision and this value in one transaction;
drafts start false and draft edits or pause do not change it. Directory effects
project the stored value. Changing the policy requires recomputing authoritative
values and republishing projections; readers never infer it from trigger count.
Legacy accepted definitions implicitly enabled email and remain non-loadable.
New definitions use `definitionVersion: 2` and an explicit `inbound_email` trigger.
Disabling email hides the address in details but retains its permanent reservation.
Legacy `/automations` detail responses adapt empty/email-only triggers to a manual
placeholder for installed clients; owner execution checks still refuse dedicated
runs of instruction-only definitions. New clients read `/sidekicks` details.

Instruction-only publication does not bind connectors, reserve an email address,
or materialize execution memory tables. It cannot start a dedicated manual run.
Triggered execution retains the existing occurrence-admission and run machinery.
Publication records a `sidekick_publication` alarm alongside its accepted state,
so a partial effect tail can reconcile without asking a person to apply again.

Instruction-only Sidekicks appear to the model as reusable Skills, loaded with
`load_skill`. Their names and instruction wrappers use skill terminology; the
product still calls them Sidekicks. Thread-local setup discovery is a separate
surface and does not enumerate reusable instructions as authoring candidates
from other threads or scopes.

The harness host resolves eligible Sidekicks through WorkspaceDO candidates and
an authorized `readSkillSource` on each owner. A private source's audience must
contain the entire receiving conversation; workspace sources stay regional and
room sources stay within their owning room. Loading grants no tool credentials,
Sidekick memory, authoring history, or run history. The model-visible catalog
escapes metadata and presents it as data; activated instructions remain subordinate
to platform policy and the receiving request. Only active sources are reauthorized
before model/tool boundaries. A new activation separately rechecks eligibility,
so deleting an unused catalog candidate does not stop unrelated work.

Conversation rails read `readSkillSummary` from the source owner using the
receiving conversation's principal and current audience. The summary exposes only
ID, name, description and loadability; it does not require or grant authoring,
memory or run-history access. It shares the source audience policy with
`readSkillSource`, while drafts and paused sources can remain visible but
unavailable for a new load.

Guest recommendation reads authorize the exact Main or child conversation before
and after source reads. They combine explicit workstream recommendations and
owned Sidekicks. Local attachment reads/removals address that conversation and
preserve Main and siblings. Removal rechecks the local participant and archive
state and publishes the existing `automations` invalidation topic.

The shared client reads recommendations through that exact-conversation route
and keys its cache by both workstream and substream. Recommendation mutations
cancel older reads, update Main's answer and invalidate every conversation's
recommendation query. Children refetch their own eligible summaries rather than
receiving Main's source metadata from the mutation response.

The run's existing principal validation supplies the workspace access class to
Sidekick resolution. Skill enumeration and revalidation do not issue a separate
membership query on each assistant or tool attempt. Run authority is still
revalidated at the existing execution boundaries.

New guest runs discover only recommended, workstream-owned or locally loaded
sources. That selection is followed by ordinary source/audience checks; it cannot
make a personal or other-workstream source usable. Already admitted execution
snapshots retain the existing source revalidation rules, so changing a
recommendation does not retroactively change the admitted execution. Sidekick
service management resolves the owning workstream through the directory and
checks its canonical management grant. A Main-only or child-only grant does not
supply this standing. The model listing tool reuses the management decision in
its recommendation options when loading definitions; it does not repeat that
parent read after loading them. Recommendation and catalog reads reuse the parent
kind returned by conversation admission instead of resolving that parent again.
Mutations still obtain their own current authority.
Sidekick mutation HTTP routes accept workspace guests and delegate to these same
owner checks. They use the workspace-authenticated router and retain the existing
realtime invalidation middleware; workspace listing and creation remain member
surfaces. Archived parents retain management standing so the Sidekick
owner can enforce its existing operation-specific archive rules. Detail and
run-history HTTP reads use the same actor decision. The actor preserves a guest's
null workspace role, so workspace skill visibility does not grant workspace-wide
authoring history. Workstream-owned detail/history remains available through the
parent management grant. Guest authoring conversation admission uses that same
canonical management grant. Revoked parent grants publish the existing owned-
Sidekick revocation fan-out from durable grant-directory delivery, closing sockets
in those separately seated conversations. New admission and guest execution
boundaries read current authority; frame publication does not add permission reads.
The lite browser does not expose setup or authoring screens.

A substream persists its skill snapshots by execution id and records loaded refs.
Loading a Sidekick in a workstream's main substream also persists a deduplicated
attachment. Future executions load eligible attachments using their latest
accepted revision; retries retain the admitted bodies while rechecking access.
Loads in child substreams persist in that child's attachment table too; main
and sibling attachments stay independent. Removing an attachment affects future executions.

Workstream-owned Sidekicks are inherently Recommended. Participants and agents
can also attach non-archived workspace Sidekicks through the Channel menu's picker or the
Sidekicks plugin's attach/detach tools. The Channel's parent owns those explicit
links, in `WorkspaceDO`'s `parent_sidekicks`.
Workstream main and child agents receive only list/attach/detach from this
plugin; drafting stays in the Sidekick's own authoring conversation.
Management tools require a user execution principal. Workspace-principal runs
still discover eligible skills but receive no person-authorized management tools.
Hidden background children use a host-only execution path: their stored user
principal, active runtime, local participation and parent participation must
agree. They do not acquire human viewer access. Detachment addresses that
child's loaded attachments directly, preserving Main and siblings; REST callers
still pass the ordinary child viewer check. Attachment routes reject automation
parents with a typed unsupported-parent response.
Each new execution snapshots eligible recommendations and marks their catalog
lines `[Recommended]`, encouraging use when relevant without activating bodies.
Detaching an explicit recommendation also removes the current substream's local
attachment; sibling attachments survive. Workstream ownership itself cannot be
detached. Workspace Sidekicks remain ordinarily discoverable after detachment.
The common recommendation service publishes the existing workspace `automations`
sync topic after a successful change, including agent-originated changes. Every
desktop window invalidates its recommendation queries on that topic, so an idle
sibling view learns about shared changes without waiting for transcript activity.
Both participant preconditions are checked before the shared delete. The two
object removals remain idempotent, not a cross-object transaction. Executions
with no eligible Sidekick sources skip recommendation authority reads entirely.

Recommendation mutation now checks the canonical workstream management grant,
separately from Main or child collaboration. Before Main authority migration,
ordinary members retain the legacy participant rule; after transfer, a projected
Main participant is insufficient. The parent rechecks at the mutation boundary.
Conversation-addressed mutation routes return only that conversation's authorized
source summaries, without reading Main. A guest manager can reuse a source already
recommended or loaded there, but a guessed unrelated workspace Sidekick ID does
not grant discovery or source history. Local removal still needs only the local
conversation permission.

The `sidekick-recommendation-options` conversation endpoint supplies the shared
UI and agent catalog with eligible workspace sources, explicit attachment state
and the canonical parent-management decision. Members retain workspace source
discovery; guests receive only sources already recommended or loaded in the
selected conversation. Owned sources are not presented as removable explicit
recommendations. The UI separates local removal, shared recommendation removal,
and recommending an eligible local source. The agent catalog reports `canAttach`
from the same decision and only reads owned definitions with parent management.

A Channel's title menu lists **Sidekicks**: the Sidekicks the room owns,
explicit workspace recommendations and the current substream's loaded
attachments, folded into one list keyed by Sidekick id. A Channel's Main reads
them from its rail on the Organization socket (below); a breakout, and a Main
whose rail has not arrived, read them over REST — the owned list through
`listWorkstreamAutomations` (`GET /sidekicks/workstream/:id`, which refuses a
caller who is not a participant). The plus-marked Add Sidekick row opens a menu:
Attach existing Sidekick selects a non-archived workspace Sidekick, while Create
new Sidekick opens the existing Sidekick composer.
A row opens that Sidekick in the library window; Remove lives in its right-click
menu when the viewer may remove it. Local removal and workstream recommendation
removal are separate, explicitly labeled actions. Removing a workspace recommendation
also clears its current local attachment. An owned Sidekick that has never been
loaded carries no removal action; its recommendation follows ownership.
The list marks recommendations with a right-aligned circled carambola icon whose
tooltip explains shared discovery without automatic loading.
Picker state is keyed by workstream, and an attachment response cancels older
recommendation reads before updating the selected conversation's cache and
invalidating sibling recommendation queries. Removal state is
keyed by conversation, so navigation cannot carry an error into another substream.
A merged row takes its lifecycle from the owned summary and its availability
from the attachment, because each list knows one of them. The section keeps its
heading for a room with none and while the answer is still on its way; rows
appear only for Sidekicks themselves. A failed read keeps whichever rows did
arrive and adds a normal **Refresh** row; if none arrived, the heading and
Refresh row are the recovery path without a warning-only section. Refresh asks
the socket again for a rail-backed list and retries REST for the rest (the
attachments while the rail has none; all three for a breakout or with no rail),
and guests continue to skip the member-only owned directory. Read and action
failures remain distinct: refused local removal, recommendation, and recommendation
removal each name the action that failed and stay visible until the next
Sidekick-management interaction. That interaction clears only a
settled failure: a removal or attachment still in flight remains observed and
keeps its controls pending, so reopening management cannot permit a duplicate
request or discard the eventual result. The lazy management-options query
belongs only to the picker and never changes the list's state. Those states and
the picker’s load/attach failures are stable Rally-owned copy; raw API,
transport and provider messages never become sidebar text.

Main's three lists ride its Channel rail (`channel_rails`,
[`hosted-conversation-parents.md`](hosted-conversation-parents.md#a-channels-rail-and-its-waterline)),
read from the Organization object's own rows: the room's `automation_directory`
rows, `parent_sidekicks`, and the attachment list Main reports on its
`directory_common` effect. A Main that has never reported is asked to when its
Channel is opened; until it reports, its rail omits `attached` and the desktop
reads that list over REST. A listed Sidekick is named by its title and shown under the
one audience predicate `HostedSidekick.readSkillSummary` applies
(`sidekick-audience.ts`, shared by both), with the directory row's
`run_as_user_id`, which is null until the Sidekick next publishes and leaves the
author alone until then. The directory cannot see a Sidekick's accepted revision
or its owning room's archive, so a rail can call available a Sidekick whose REST
summary would not; loading it still goes through `readSkillSource`, which
refuses.

The Sidekicks library opens in its own window from the account popup, immediately
above Settings. It lists accessible personal, workspace, and room Sidekicks.
The library uses the normal desktop session and workspace boundary. The center
sidebar renders participants as a facepile and provides attachment removal.

The Sidekick profile always shows Pause/Resume, Run now, Run history, and
**When to expect it**. Unavailable actions stay focusable with a tooltip naming
the reason, while their callbacks remain blocked. Run now requires an active,
runnable Sidekick; Run history is available with triggers or previous runs.
The timing section shows **No timing details yet.** when no summaries or next
run exist; a visible inbound email address supplies **When an email arrives**
for legacy definitions whose implicit email trigger has no summary. The
conversation remains the editing surface, without a separate guidance section.

## Activity above the composer

Channel, Thread, and Breakout composers show a distinct running Sidekick count,
covering setup, manual, and triggered executions; idle, archived, and
waiting-for-input executions do not count. The composer registers its exact
target with `sidekick_activity` on the existing workspace socket; WorkspaceDO
admits each target and pushes initial and changed `workspace_sidekick_activity`
counts from accepted local child/run projections. Sources are exact homes,
posting attachments, defaults, recommendations, and loaded instructions.
Instruction links use the shared audience rule; posting consent exposes only
activity, not Sidekick history.

Execution, attachment, audience, visibility, and Channel-default changes use the durable
post-commit lane to push watched counts. Subscription revisions and snapshot
waterlines discard obsolete targets and older snapshots; reconnect re-registers
the open composers. Counts have no REST fetch, polling, or per-Sidekick socket.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/sidekick-activity.ts` | Target-scoped running count from accepted Sidekick execution projections and the target's attachment relationships. |
| `apps/api/src/durable-objects/hosted-sidekick.ts` | `HostedSidekick`: `create`, `submitDefinition`, `apply`, `pause`, `resume`, `remove`, `setAppearance`, `setOwningRoomArchived`, `runNow`, `runSeeded`, `admitExternalEvent`, `admitInboundEmail`, `readRunDefinition`, `readRunState`, `continueRun`, `readDetail`, `listRuns`, `claimExecutionPrincipal`, `reviewDelivery`, `reviewDelivered`, the parent contract (`onChildCommonProjection` moves the run row and counts its finish), and the schedule, run, review and memory-table alarm entries. `WorkspaceDO` answers each as `sidekick*`. |
| `apps/api/src/services/sidekick-run-provisioning.ts` | `provisionSidekickRun`: opens a run's conversation and starts its loop from the `sidekick_run_provision` Queue message the run's alarm entry sends. |
| `apps/api/src/services/sidekick-run-continuation.ts` | `continueSidekickRun`, the run child's call to `continueRun`; `continuationSource`, who continued the run and where; and the refusal text the run's transcript records. |
| `apps/api/src/services/sidekick-review.ts`, `sidekick-review-notice.ts` | `deliverSidekickReview`: the `sidekick_review` Queue message's consumer, which reads the notice from the Sidekick, admits it into the wizard's conversation and reports back; `sidekickReviewText` and `renderSidekickReviewNotice`, the sentence people read and the Rally-attributed framing the model reads. |
| `apps/api/src/durable-objects/substream-agent.ts` | `claimPersistentLoopExecution`, which continues a run from a run child's pending input; `refuseSidekickRunInput`, which settles one the Sidekick refused; and `admitSidekickReview`, which admits the review notice into the wizard's conversation and only there. |
| `apps/api/src/services/workstream-participant-model-message.ts` | `renderRunContinuationNote`, and `externalInputFraming`, which renders outside text in a run child as evidence. |
| `apps/api/src/durable-objects/automation-do-protocol.ts` | The request schemas the Worker and the Queue consumer send it (`AutomationReviewRequest` addresses one review), the alarm kinds `automation_schedule`, `automation_run` and `sidekick_review`, and the `sidekick_review` Queue message. |
| `apps/api/src/durable-objects/workstream-external-message-protocol.ts` | `AdmitSidekickReviewInputSchema`, the review's variant of the system-activation union a conversation object admits. |
| `apps/api/src/durable-objects/conversation-parent-object.ts` | The request shapes and aggregation helpers every hosted parent shares. |
| `apps/api/src/services/automation-service.ts` | `createAutomation`, the one way an automation comes into existence with its conversation open, used by `POST /automations` and by a room's first draft; and `AutomationService`, the Worker-side access every route goes through. It passes who is asking; whether they manage a room's Sidekick is decided where the Sidekick lives. |
| `apps/api/src/routes/automations.ts` | `GET /`, `POST /`, `GET /workstream/:workstreamId`, `GET /:id`, `POST /:id/run`, `POST /:id/accept`, `POST /:id/execution-principal`, `POST /:id/appearance`, `POST /:id/pause`, `POST /:id/resume`, `POST /:id/archive`, legacy `DELETE /:id`, `GET /:id/runs`. The conversation itself is reached through `/conversations/:automationId`. |
| `apps/api/src/services/integrations.ts` | `createAvalonAutomationsPlugin`: the authoring conversation's drafting host, which saves its own Sidekick through domain validation; the history projection's `sidekick_review_due` branch, which admits the notice row as the model's user turn; `readAutomationRunDefinition` and `assertRunAuthorityStillValid`, the two reads a run makes of its parent; the run prompt context built from the definition, which names the home conversation; and the loading of `rally:conversations` ([`conversation-tools.md`](conversation-tools.md)), the one way a run reaches a room. |
| `apps/api/src/durable-objects/workspace-sidekick-conversation-storage.ts` | The home read, `sidekick_conversation_attachments` (WorkspaceDO migration 86), and the conversation scope a Sidekick or a Channel or Breakout loop reaches. |
| `packages/agent-harness/src/automation-creator-tools.ts` | The `rally:sidekicks` plugin (`rally_sidekicks` to the model, its tools under the `sidekick_` prefix): the draft schema's tools, `AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE`, and the submission pre-check. |
| `packages/contracts/src/automation-agent.ts` | `AutomationScopeSchema`, `AutomationLifecycleStateSchema`, the run trigger, `AutomationRunReferenceV1` (what a run's loop input carries), `AutomationActivationV1` (the row a result becomes), `SidekickReviewNoticeV1` (the review row's structured content: counts and the sampled run ids), and `AutomationDraftProposedV1` (the card). |
| `packages/contracts/src/index.ts` | `AutomationDraftSchema`, `AutomationRunDefinitionV1Schema` (the `readRunDefinition` answer), `AutomationSummarySchema`, `WorkstreamAutomationSummarySchema`, `AutomationRunSchema`, `AutomationDetailSchema`. |
| `packages/contracts/src/automation-evaluators.ts` | The strict external-event evaluator grammar (`always`, or `matching` over leaves), the preprocess that still accepts the pre-rename `all` on rows already stored, the delivery message the matcher emits, and `automationBindableResourceTypes` — the one answer to which resources a rule may name, which search, both validators and the `resourceId` normalizer all read. |
| `apps/api/src/services/external-event-evaluator.ts` | The pure predicate evaluator WorkspaceDO matches registrations with. |
| `apps/api/src/durable-objects/workspace-do.ts` | Migration 31: `automation_directory` and `workspace_external_event_registrations`; `listAutomationDirectory`, `listWorkstreamAutomations`, `automationOwner`, `workstreamParticipant`, `applyExternalEventRegistrations`, `matchExternalEventDestinations`, and the owning-room archive fan-out `notifyOwningRoomArchival`. |
| `apps/api/src/queues/activity-consumer.ts` | Delivers a matched event to `sidekickAdmitExternalEvent`, a run child's effects through the shared effect leg, a `sidekick_run_provision` message to `provisionSidekickRun`, and a `sidekick_review` message to `deliverSidekickReview`, logging a failed delivery's code as `sidekick_review_delivery_retry`. |
| `apps/api/src/services/resend-inbound-email-service.ts` | `ingestAutomation`: resolves the sender, stores the message, and calls `admitInboundEmail` once. |
| `apps/api/src/services/memory-service.ts` | `resolveMemoryAccess`: a conversation whose parent is a Sidekick resolves the workspace scope and the Sidekick's own `sidekick` scope. |
| `apps/api/src/services/sidekick-run-tools.ts` | Wizard-only run history: current-member authorization, own-run admission, canonical transcript pages and exact replay results with explicit availability. |
| `apps/desktop/src/renderer/screens/automation.tsx`, `components/automation-header.tsx`, `screens/conversation-surface.tsx` | `/sidekicks/new` calls creation and replaces itself with `/sidekicks/:id`; that route renders the profile (the hexagon, which opens the appearance picker, plus lifecycle badge, scope, email address, Pause, Resume, Archive Sidekick, Run now, and access to the run-history dialog) beside the shared conversation surface with `parentKind: "automation"` and `substreamId: "0"`. |
| `apps/desktop/src/renderer/components/appearance-picker.tsx` | The one icon-and-colour palette, shared with the work stream's header. [`workstream-appearance.md`](workstream-appearance.md) owns it, the catalog, and the deterministic default a Sidekick nobody has chosen for still shows. |
| `apps/desktop/src/renderer/components/sidekick-section.tsx` | `SidekickSection`, the **Sidekicks** section the Channel menu renders, and `workstreamSidekickRows`, the merge of what the room owns with what its conversation loaded — owned first, one row per Sidekick, `undefined` until both answers are in. |
| `packages/ui/src/components/conversation-menus.tsx`, `screens/conversation-surface.tsx` | The section's place in the Channel's title menu, below its people; the two queries behind it (`workstream-sidekicks` and `attached-sidekicks`), the participant check that decides whether a row may be detached, and the 403 a non-participant viewer's listing is read as none. |
| `apps/desktop/src/renderer/components/workstream-glyph.tsx` | `HexagonGlyph`, the rounded hexagon a Sidekick is drawn in, taking a fill, an ink, a symbol, and an optional `HexagonMarker` — a symbol, a colour, and the sentence it means — which it cuts out of the fill along that marker's own outline, gives a hover target the size of the marker's whole box, and reports as `onMarkerHover` so the surface can say what the marker means in its own tooltip (`SIDEKICK_RUNNING_MARKER` is the only one so far); `AutomationGlyph` is that primitive filled from the Sidekick's stored appearance, or from its id where nobody has chosen. |
| `apps/desktop/src/renderer/screens/sidekicks-library.tsx` | `SidekicksWindow`: the window's routes, and the one place its Escape-to-close gesture is installed. |
| `apps/desktop/src/common/sidekicks.ts`, `src/main/index.ts` | `NEW_SIDEKICK_TARGET` and `parseSidekicksWindowTarget`: what a renderer may ask the singleton Sidekicks window to open on — one stored Sidekick, or the composer — parsed in main before it becomes that window's route. |
| `apps/desktop/src/renderer/components/owning-thread-label.tsx` | `OwningThreadLabel`: a Thread-owned Sidekick's Thread, as its glyph and title on a button that opens it, in the library row and the header's scope badge; the plain word "Thread" when the summary carries no `owningThread`. |
| `apps/desktop/src/common/open-thread.ts`, `src/main/index.ts`, `src/renderer/lib/platform.ts` | `openThread` on the bridge: main parses the id with `parseThreadId` and emits the same `workstreams/<id>` deep link an in-app link takes, so the main window opens the Thread and comes forward; the browser tab routes to it. |

### Creation and ownership

The separate Sidekicks window lists all accessible personal, workspace and
workstream-owned entries, including drafts. `GET /sidekicks` uses
`WorkspaceDO.listSidekickDirectoryForAuthorizedMember`: the request's session
authentication already joined the caller's active member row, so the object
applies only the per-row scope filter and does not read `workspace_members`
again. Every caller has proved membership before it asks, so there is no
variant that checks it. The old `/automations` listing remains a compatibility
adapter. Directory membership never grants access to an owner.

A Thread-owned row carries `owningThread`, the Thread's id, title and chosen
appearance, so the library names it without a second request. The list reads
every owning Thread in one `channels` query after the reader rule has run, and
the detail (`HostedSidekick.detail`) reads its one Thread from the same table.
Both name the Thread only to a current participant of it
(`isWorkstreamParticipant`); everyone else gets `null` and sees "Thread".

The window closes on **Escape**, through the shared
`renderer/lib/window-escape.ts` that Settings also uses, and nominates nothing as
unsaved: the only writing surface it hosts is a Sidekick's conversation composer,
whose text and attachments are cached on the device and restored on the next
visit (see [`composer-drafts.md`](composer-drafts.md)), so closing costs no
sentence the cache has already written. It debounces that write by 250 ms and
commits the remainder on React unmount, which no closing window runs, so an edit
newer than the debounce is lost — by Escape, by Command-W, and by the traffic
light alike. That belongs to the draft cache's teardown rather than to this
keystroke, and a sweep here would not recover it, because the sweep reads the DOM
and the loss is in the cache.

The window answers Escape before the library or a Sidekick has rendered, too:
`WorkspaceApp` installs the gesture for this surface while the workspace profile
is still loading or has failed, which is the state with nothing on screen to
click, and stands it down once `SidekicksWindow` mounts and installs its own. The keystroke still stops at anything with a nearer claim on it — an
IME composition, the run-history or delete dialog, a model menu, the composer's
own mention and command lists, and the library's search box while it still holds
a filter.

`POST /sidekicks` creates a personal draft and its authoring conversation.
`/sidekicks/new` replaces itself with the resulting detail route so Back cannot
create a second draft. Coordinating conversations use `rally_agents` to discover
and reuse a suitable Sidekick owned by their workstream, or create a minimal one
there by default, then send setup instructions to its authoring agent. The host
refuses those instructions from a thread that does not own a thread-owned
Sidekick ([`agent-communication.md`](agent-communication.md)). Those
instructions open the authoring conversation and are shown there as its
**Opening instructions** row
([`plugin-activity-rows.md`](plugin-activity-rows.md)). Drafting
tools are available only in that authoring conversation. The persisted drafting
plugin id and canonical tool names stay; the model reads the plugin as
`rally_sidekicks` and its tools under the `sidekick_` prefix in the authoring
conversation. In a room the same persisted plugin identity is presented as
`rally_skill_recommendations`, exposing reusable instructions through
`list_skill_recommendations`, `recommend_skill` and `unrecommend_skill`. Its list
carries only available or already recommended organization skills the room
can recommend; in an authoring conversation the list is that Sidekick's own
definition. Workstream-owned
entries are managed in the library and listed in their own room's Channel menu, beside
that conversation's loaded attachments.

`createAutomation` reserves the durable owner before bootstrapping its main
`SubstreamAgent`, preserving the existing automation parent identity and routes.
The same conversation remains available for subsequent edits. Personal and
workspace drafts retain their existing ability to adopt an explicitly requested
personal/workspace scope before publication; a workstream-owned Sidekick remains
owned by that workstream. Authoring guidance uses the scope already selected
instead of requiring another scope question. The host supplies its Sidekick ID,
and directory reads provide the current definition before revision. Questions
from an agent exchange return through ordinary replies, without participant
elicitation forms.

### Conversational publication

The sidebar shows no Sidekicks. The library window is reached from the
account menu's **Sidekicks** item, and a Channel's own Sidekicks are listed in
its title menu. A running Sidekick still carries `SIDEKICK_RUNNING_MARKER`, the
**play** in `success-base` cut out of its hexagon, wherever its glyph is drawn.

### Drafting in the conversation
`sidekick_submit_draft` calls `WorkspaceDO.sidekickSaveDefinition` under the submitting
actor's management authority. The owner appends an immutable revision and publishes
it immediately when ready. New definitions carry `definitionVersion: 2`; inbound
email is explicit. There is no instruction editor, type selector, or Create/Apply
button. Incomplete submissions remain in authoring history without replacing the
accepted revision. The legacy acceptance route remains callable for compatibility.

Submission returns to the conversation loop so the agent can acknowledge the save
or ask about missing details. It does not halt the run: successful conversational
completion still requires a persisted final assistant turn.

A rule may only name a person the drafting agent resolved, and `people_search`
is where resolution happens. That search is a substring match over member names
and emails, so it can answer "Sarah" and can never answer "me" — every result
therefore also carries `you`, the person the run acts for, read under the same
active-membership predicate as the matches. The set of admissible person ids is
seeded with that same id before the agent calls anything: the guard exists so a
rule cannot name someone the agent *invented*, and the execution principal is
the one id on the run the host supplied itself. `rememberAutomationPeopleSearchResult`
restores `you` alongside the matches so a resumed run rebuilding the set from
replayed tool output agrees with a fresh one.

**A connection advertises only the events its own scope can receive.**
`connectorActivityTriggerDescriptors` takes the connection's scope and returns
nothing where the connector's activity cannot arrive in it, so a personal
Granola, Fireflies or Ashby connection reports `activityTriggerCount: 0` —
their webhooks belong to the workspace install, and `normalize` refuses every
other connection. A zero count on a plugin that plainly has events reads as
"this connector has no events", so the catalog entry also carries the scope
those events *do* need: `plugins_list`, `plugins_search` and `plugin_inspect`
turn it into one sentence saying a workspace connection is required, and
`set_evaluator_rules` refuses a rule on such a plugin with the same sentence
rather than the generic "no event of that name" — which reads as a typo to
correct, and sent the run looking for another event and then a schedule. The
model already saw `scope: "personal"` beside four healthy-looking triggers and
reasonably concluded the connection was usable.

A draft may also carry `customTools`, programs the wizard wrote and tested with
`sidekick_tool_test`; `submit_draft` refuses with `custom_tool_untested`,
naming the field, a ready draft whose tool's current identity (code, input
schema and plugins together) has no recorded test, and a run receives each as
`custom_<name>`. The test tool and its guide exist only where the Worker has a
program runtime ([`code-mode.md`](code-mode.md)).

Instruction-only definitions bypass connector binding, schedule preparation,
email reservation and memory-table creation. Triggered definitions reuse the
existing validation and execution setup: bindings resolve against WorkspaceDO,
every Sidekick scope may bind an eligible delegate's personal connection,
evaluator rules must name inspected sources, and schedules use their explicit or resolved timezone. Google bundle plugin IDs resolve through the same
connection views used by the model catalog: Mail + Calendar and Drive + Docs +
Sheets can bind one credential without sharing tools or trigger descriptors.
Saved combined IDs remain binding aliases; see [connectors](connectors.md).
The object's current revision and lifecycle are checked again after asynchronous
preparation, before committing publication. An archived owning workstream refuses
publication; an ordinary pause is preserved by editing.

Publication prepares table IDs and receipt hashes asynchronously, then rechecks
the revision, accepted revision, lifecycle, principal and owning-room fences.
One transaction creates/reopens every declared execution table, updates compatible
metadata and receipts, replaces schedules, stores bindings and evaluator
projections, writes the accepted revision and computed `loadable`, and advances
the directory. A table conflict rolls back all of those changes. The submitted
revision remains editable through a new immutable revision, while the previous
accepted revision stays active. Instruction-only definitions skip execution
provisioning. Removing triggers leaves admitted runs pinned to their original
revision.

New publications do not arm a table-materialization alarm. Existing
`sidekick_memory_tables` entries are a legacy recovery path: they recheck the
accepted revision after hashing and commit all table changes together. Schema
and receipt conflicts are permanent, produce `sidekick_memory_tables_rejected`
with the code and diagnostic field path, and consume the entry. Unknown failures
retain the scheduler's backoff. Publishing a corrected revision clears obsolete
table-materialization entries for that Sidekick.

`HostedSidekick.reconcileLoadable` is the explicit object-owned operation for a future
policy change. It reads the accepted definition, preserves legacy implicit email
semantics, writes the capability and republishes the directory. It does not accept
a boolean from the caller. Consumers continue to read stored `loadable` unchanged.

Memory tables remain in the Sidekick's execution scope. Publishing an instruction
source does not provision them, and loading instructions never grants access to
these tables, credentials, authoring history or run history.

### Triggers and occurrences

Every trigger ends in `admitOccurrence(occurrenceKey, trigger, opening)`, which
inserts one `runs` row in state `pending` with `INSERT OR IGNORE` on the unique
`occurrence_key`, returns `{runId, reused}`, and arms one `automation_run` alarm
entry for the run. A repeated admission of the same occurrence answers with the
run it already made. The object must hold an accepted revision
(`sidekick_not_active` otherwise), and the run is pinned to that revision.

| Trigger | Entry | Occurrence key | Refusals |
| --- | --- | --- | --- |
| **Manual** | `POST /automations/:id/run` with an `idempotency-key` header; `runNow` | `manual:<idempotencyKey>` | `sidekick_not_active` unless `active`; `sidekick_forbidden` unless the caller may manage it |
| **Schedule** | the `automation_schedule` alarm for one schedule row; `executeSchedule` | `schedule:<scheduleId>:<plannedFor>` | skipped silently unless `active`; the next occurrence is computed from now and re-armed |
| **Connector event** | the Queue consumer's `admitExternalEvent`, one message per matched registration | `occurrence:<key>` when the connector named the occurrence the event reports, else `external:<workspaceEventId>` | `sidekick_<lifecycle>` unless `active`; `sidekick_event_before_activation_boundary` when the event's sequence is at or below `effective_after_event_sequence` |
| **Inbound email** | `resend-inbound-email-service.ts` calling `admitInboundEmail` once per delivery | `inbound_email:<resendEmailId>` | see below; the refusal is written to `inbound_email_receipts` |

**Connector events** follow one regional path. The regional activity Queue
hands a normalized event to `WorkspaceDO.ingestConnectorEvent`; a second,
ID-only delivery claims it for processing and calls
`matchExternalEventDestinations`, which selects active registrations by
connection, connector type, event type, and
`effective_after_event_sequence`, applies the delegation audience rule (a
personal activity requires its source owner's eligible grant, and a restricted
workspace activity requires an eligible delegate inside its actual audience),
evaluates each registration's predicate with no model inference, and returns
one complete
`workspace_external_event_delivery_v1` message per match carrying the
registration, the destination, and the event. There is no delivery ledger and
no lease: the consumer sends each message to the Queue, and the destination is
idempotent on the occurrence key — the event id, unless the connector named the
occurrence the event reports, as Granola does for a note that can arrive as a
share and as a generation — which is all a lease ever guaranteed. A redelivery
answers `sidekick_occurrence_replayed`, and so does a second delivery for the
same named occurrence. Registrations for an automation and
for a watched work-stream resource share one candidate index; a watched work
stream sends no evaluator object, while an automation needs predicates because
it selects event families, content, people, and provider fields.

**A `semantic_activity` trigger's `condition` is tested after the predicate, not
by it.** The predicate above is the only runtime matcher and takes no semantic
test; a registration carries `when` and nothing else, and the projection is built
from `evaluator_rules_json` alone. So a ready `semantic_activity` trigger is
*matched* on exactly what a `connector_activity` trigger is: the evaluator rules
joined to it by `sourceBindingKey`. Its written condition is judged one step
later, in the delivery, and `admitExternalEvent` refuses a gated event whose
verdict does not admit or is missing — outcome codes `sidekick_semantic_*`. The
join from an arriving event to the conditions that gate it is
`deterministicPrefilter.eventType`, which is also the only thing that field is
read for. [`semantic-activity-triggers.md`](semantic-activity-triggers.md) owns
that mechanism, its confidence threshold and its failure modes.

An evaluator rule is one AND group: `when` is `{kind: "always"}` or
`{kind: "matching", allOf: [leaf, ...]}` over the manifest's declared attributes.
Unknown keys, operators, attributes, plugin/event pairs, duplicate ids, empty
groups, non-finite numbers, and wrong scalar kinds are rejected at every
boundary; missing fields make positive and negative predicates false and only
`presence.not_exists` matches absence; matching is case-sensitive with no
coercion. A rule that needs OR is two rules.

`matching` was spelled `all` until the rename, and rows carrying that spelling
are still stored in `definition_revisions.evaluator_rules_json` and
`workspace_external_event_registrations.evaluator_json`. A Zod `preprocess` on
`ExternalEventPredicateV1Schema` rewrites the legacy discriminant before
validation, so both columns keep parsing while every reader past that seam sees
`matching` alone. Because it maps the value *before* the union rather than
adding a third branch to it, the JSON schema `set_evaluator_rules` derives for
the drafting model still names one spelling — which is the point of the rename,
`all` being indistinguishable from `always` to a model reading the two side by
side. What has to be true before the seam can go is in the changelog.

A rule may also narrow itself to one resource, and `automationBindableResourceTypes`
(contracts) is the single answer to which one: the resource types the rule's own
triggers declare a `resourceRelationships` entry for. Those are the containers an
event happens *inside* — a repository, a channel, a project, a page, a folder, a
Drive file, a mail thread — never the files, commits, check runs, messages or
pull requests the events themselves produce, and never a resource with no
connection to bind through, which is every upload, note and generated document.
The accept-side validator, the drafting tool's pre-flight check, the normalizer
that drops an unusable id, and the reconciler that turns a watched work-stream
resource into registrations all ask that one function, and so does
`resources_search`: it searches that set and nothing else, and reports it as
`searchableResourceTypes` beside the rows.

A search result's `searchableResourceTypes` is the union across the catalog,
not proof that the selected event supports a particular type. The event's
`resourceRelationships` is authoritative. A supported type with no matching
registered row is distinct from an unsupported type; a direct connector read
does not register a resource. The wizard's `resources_register` tool takes an
external URL or provider file ID and an authorized `pluginId`. It verifies access
through that connection, derives the title and type from provider metadata, and
uses `ResourceService.resolve` to return the canonical Rally ID. Registration
reuses the existing connection/provider identity; it neither edits the external
file nor grants access. Currently Google Drive, Docs, and Sheets provide the
verified identity needed for registration. Catalog discovery reports
`resourceRegistrationSupported` for each plugin.

Registration results have the same `resources` shape as search results and enter
the same binding-validation state, including receipt replay across turns. The
`polling-for-events` skill owns event selection, registration and fallback policy.
Google advertises registration only on views holding `drive.read` and a bindable
file event. The canonical registration transaction checks connection identity,
status and required capabilities beside the resource write, including reuse of an
existing resource. A refused connection returns `connection_unavailable`; the
resource service maps that outcome to `resource_connection_unavailable`.
Google folder and shortcut registration is refused: binding those entities does
not watch their children or target files. Use declared event filters for folder
contents and the actual target file for a shortcut. An
existing row with a type inconsistent with provider metadata is refused rather
than returned with relationships for a different type.

A declared relationship is not a promise that anything materializes the type:
Granola declares `granola_folder` and writes only `granola_note`, so a Granola
workspace searches a type that has no rows. That is indistinguishable from a search miss here; it is a connector-side gap, and
[`connectors.md`](connectors.md) carries the invariant it violates.

**Inbound email** arrives at the automation's permanent address
([`workstream-email-addresses.md`](workstream-email-addresses.md)). The regional
ingress fetches the message, resolves the sender to an active member, stores
the payload in R2 and the email as a resource, and then calls
`admitInboundEmail` once. The object answers a retry from
`inbound_email_receipts` by Resend email id before deciding anything; a new
message is refused with `sidekick_not_active`,
`sidekick_email_route_mismatch` (the address is not this automation's), or
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
delete stops rather than finishing on stale consent. The one exception is a
continued run, below. The `rally:sidekicks` drafting plugin is withheld from a
run.

A run that loads Terminal reuses the sandbox owned by its Sidekick's wizard.
All activations and background agents share its files and mutation lease, while
run transcripts and resource permissions remain separate. The Sidekick projects
no Terminal deadline for the workspace sweep, so the shared sandbox is created
with Daytona's auto-delete set and retired by the provider alone;
[`terminal-workspaces.md`](terminal-workspaces.md) owns that mechanism.

The run reports its state the way every conversation does: its
`directory_common` effect reaches the parent through the child effect leg, and
`HostedSidekick.onChildCommonProjection` maps the accepted conversation state
onto `sidekick_runs.state`, as [continuing a run](#continuing-a-run) describes.
Nothing a run says leaves the Sidekick: a run produces no sidebar row, no
activity, and no notification.

### Continuing a run

Input to a run child continues the run. The Sidekick's alarm starts a run's
first activation; every later one starts from input somebody sent the child:
an answer to a question the run asked, a member's message, or a reply that a
bound provider thread delivers as an external attributed message. A run keeps
one identity and one history, and can complete more than once.

1. `SubstreamAgent.claimPersistentLoopExecution` takes the next pending input.
   When the object's parent kind is `automation`, its substream is not
   `"0"`, and it has no `background_agent` identity, it calls
   `WorkspaceDO.sidekickContinueRun(runId)` before building the loop
   input (`continueSidekickRun` in `services/sidekick-run-continuation.ts`).
   Delegated workers share the Sidekick parent but are not Sidekick runs.
   A worker rooted in a run asks `sidekickContinueRun` about its persisted
   `root_substream_id`, including through nested delegation. A refusal lands
   the assignment without starting execution. Approval uses the current eligible coordinator and records only `automationDelegation` (root run ID and
   stop generation), without loading the run's instructions or tools. The normal
   model/tool authority check reads root lifecycle and stop generation, so a
   later pause, pause/resume or deletion fences an already activated worker.
   Delegate eligibility and coordinator selection refresh on activation; changing
   the coordinator does not revoke a worker's current eligibility snapshot. Authoring-rooted workers (`"0"`) keep the
   ordinary background-agent path, as authoring itself is not paused.
2. `continueRun` can replace an unavailable coordinator. It answers a refusal code, or
   the `automationRun` block and run-as `executionPrincipal` the scheduled
   start builds, with `definitionRevision` the Sidekick's **currently
   accepted** revision and the run's original trigger, plus `stopGeneration`, its
   stop counter. Continuing a run acts on today's consent, so a run started under
   revision 1 continues under revision 3. It persists `coordinator_user_id`
   independently of the directory's legacy human access field. An unavailable
   coordinator is replaced by another eligible delegate for root and background
   continuations. Existing human reader/manager rights remain unchanged. It does not
   ask who sent the input: anyone who can reach a run may continue it.
3. The loop input carries `automationRun`, the run-as principal, and
   `automationContinuation: {stopGeneration, senderName, source}`; the sender stays
   the author of their own message. `readRunDefinition` reads the revision the
   reference names rather than the run row's own, so the instructions, tools
   and plugins are the accepted revision's.
4. The prompt gains one host-rendered, user-role message after the new input
   (`renderRunContinuationNote`): "This run is continuing because a new
   message arrived in Slack, in the thread you started" (a `provider_thread`
   source, named for the provider) or "in this run" (everything else), the
   sender's display name as a quoted JSON string labelled as data, then "The
   work you already did is above; handle the new message only as the
   Sidekick's instructions direct." Without it the re-rendered instructions
   read as a fresh task, and a model sends its requests again. The name is
   quoted rather than written into the sentence because anyone in a bound
   thread chooses their own. The note is an activation input keyed on the triggering
   turn, so a recovered execution does not add a second one. A turn this
   Sidekick's own wizard started (the agent exchange's sender is
   `automation/<id>/0`) gets a different note instead: the wizard's message,
   usually its answer to the run's change request, goes in the thread where
   the person who asked wrote, whether the change was saved or what it asked.

**Refusals.** `continueRun` answers `sidekick_deleted` for an archived
Sidekick, `sidekick_paused` for one a person paused, `run_not_found`
when the Sidekick object holds no row or no such run, and `run_no_eligible_delegate`
when no delegated user remains eligible. The
child then lands the input as a delivered turn and appends a `system` row after
it (`clientMessageId` `sidekick-run-refused:<inputId>`, structured content
`{kind: "sidekick_run_refused", code, turnId}`) in one transaction
(`WorkstreamTranscriptStorage.deliverRefusedInputInTransaction`), logs
`sidekick_run_continuation_refused` with the code, and claims again, so the
input behind it is not held. Nothing touches Bind: the refused words reach the
model through the gap-fill of whatever run comes next, as said to the room.

**Reopening the run row.** The row moves back to `running` through the
child's own `directory_common` projection, not through `continueRun`.
`onChildCommonProjection` runs only for a projection the parent accepted, one
with a newer `sourceVersion` than it holds, and maps the conversation state
onto `runs.state` (`RUN_STATE_FROM_CONVERSATION_STATE`: `completed`,
`failed`/`error`/`budget_exhausted` to `failed`, `needs_input`,
`stopped`/`cancelled` to `stopped`, every live state to `running`), copying the
preview onto `summary`. A finished row (`completed`, `failed`, `stopped`)
reopens only to a live state, never to `idle` (an unarchive or bootstrap
reports it), and only while the Sidekick is `active`. One finished state never
replaces another, so a run a pause stopped stays stopped when its last
activation later reports `completed`. Because only an accepted projection
moves the row, a late `completed` from an earlier activation carries an older
version and cannot close a continued run.

**The run authority check before the row reopens.** The reopening projection
travels the Queue and lands after the continued execution has started, which
reads its authority at run start. `readRunState` therefore also answers
`stopGeneration`, a counter on the `automation` row (migration 12) that every
Sidekick-side stop of open runs (`stopOpenRuns`, from pause and archive) moves
in the same transaction. `continuedAfterFinish` in `integrations.ts` lets a
continuation act through a finished row: through `completed` or `failed`
always, because those are only ever the child's own report of an activation
that ended; through `stopped` only while the counter is where `continueRun`
read it, because a pause stops open runs and a resume does not reopen them. A
pause that lands after the approval therefore still refuses, even once the
Sidekick is resumed and even on the approval's own millisecond, which is why
the fence is a counter and not a time. The lifecycle check is unchanged: a
Sidekick that is not `active` refuses every write.

**Completing more than once.** The `runs` row has no constraint on its finish;
`completed_at` is the latest finish. Run-outcome telemetry is keyed per
harness run, so each activation emits its own `run_terminal`, now carrying the
run's `automation_run_id`; a count of completions per run is a count of
activations. A Sidekick run child forwards no effects (`forwardsChildEffect`
is false), so a second completion sends no notification, and the Slack
`notify_automation_completed` preference has no sender today.

### Scheduled self-review

The wizard is the model that can reason about a run; a run is the model that
does the work. The review puts the reasoning where the stronger model is and
costs the runs nothing: no tool a run must call, no classifier in its
settlement, no instruction step that exists only to feed the review. What the
host already knows (a run finished, in which state, under which revision) is
what the review is built from, and the wizard reads the rest itself.

**Counting and arming.** The projection that moves `sidekick_runs` is the one
place a finish is known, so it counts there: `onChildCommonProjection` returns
`completed_at`, which that statement writes only when a row moves into a
finished state, and an instant equal to its own is the witness. Only a run
admitted under the accepted revision counts: one still in flight when a
revision was applied is the previous procedure's evidence. A continued run
that finishes again counts again, under the revision it was admitted on, so
its later finishes under a newer accepted revision are not counted. A run
waiting for input has not finished. At `SIDEKICK_REVIEW_RUN_FLOOR` finishes
the same transaction arms one `sidekick_review` entry keyed
`<sidekickId>:review`, due no earlier than `SIDEKICK_REVIEW_INTERVAL_MS` after
the last request, and only while none is armed, because the store resets a
moved entry's retry gate. Both are product numbers the request named, defined
once in `hosted-sidekick.ts`; neither a prompt nor a notice repeats them.
`apply` resets the count, cancels the entry and retires a request not yet
delivered: runs under the previous revision are stale evidence. It does not
move the clock: a person who just revised has not reviewed, so the new
revision is reviewed three days after the last review, once ten runs have
finished under it. Pause and archive cancel the entry with the Sidekick's
other entries; `resume` resends a request still owed, else re-arms from the
count, and so does `reviewDelivered` for finishes that accumulated while a
delivery waited.

**Asking.** `startReview` copies run provisioning rather than awaiting the
wizard from the Organization object's alarm, where one cold conversation
would hold every other alarm job: one transaction inserts a `sidekick_reviews`
row, subtracts from the count the finishes it read (not zeroing it: a finish
that lands while the delegate is looked up falls after this notice's `<= now`
window and counts toward the next review) and stamps `reviewed_at`; then a
`sidekick_review` Queue message, whose consumer (`deliverSidekickReview`)
reads the notice back (`reviewDelivery`, `null` once delivered, abandoned,
superseded by a newer revision, without an eligible delegate, or with the
Sidekick no longer active), admits it into the authoring conversation, and
reports `reviewDelivered`. The entry resends on the run-provisioning backoff
until then, and a request undelivered for one interval is abandoned. The
review executes as a delegate who may also manage the Sidekick
(`reviewCoordinator`, the author first), because its one write is
`saveDefinition` and that checks the manager rule; with none it is skipped
(`sidekick_review_skipped`, code `no_managing_delegate`) and asked again one
interval later.

**The notice** is `SidekickReviewNoticeV1Schema`, built by `reviewNotice`:
counts by finished state since the last request, and a sample of run ids the
host picked so the wizard reads a bounded set however many runs there were
(failed runs, then stopped ones, up to a limit, because a pause stops every
open run at once; waiting runs; and completed runs spaced evenly across the
window, `SIDEKICK_REVIEW_SAMPLE_LIMITS`). Every count and every sampled run is
under the accepted revision, since the window can reach back past a revision
and an earlier revision's runs followed a procedure the person already
changed. It carries no run content: the wizard reads a run with
`sidekick_runs_read`. It names where a change is announced (`announceTo`,
as the conversation tools name it): a room's Sidekick's home, an
Organization Sidekick's General Channel, or its author's Personal Channel
when General is archived or absent, and a personal Sidekick's author's
Personal Channel; null when no such conversation exists yet
(`sidekickAnnouncementSpaceId`). It is admitted through
`admitSystemActivation`
(`SubstreamAgent.admitSidekickReview`, only on a Sidekick's substream `0`) as
a queued `system` row whose text (`sidekickReviewText`) is the one sentence a
person opening the conversation reads: what Rally asked for, in counts, with
no id, instant or revision number. The history projection in
`integrations.ts` admits that system row by its kind as a user message framed
by `renderSidekickReviewNotice`, whose first line attributes it to Rally and
which then lists exactly the runs to read; the rule that drops system rows as
UI state otherwise dropped it, and the wizard's first activation, which
initializes Bind from canonical history, answered a review it never saw.
Memory treats the review as agent-derived.

**What the wizard does with it** is guidance in
`AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE`, not a gate, in four stages. It reads
first, posting nowhere else: it hands the listed runs to one background
agent, whose reader walks them without a run id and which sends one
report that also names each deterministic step a run repeated, skipped or got
wrong and what each run's routine work cost (model turns, calls to each saved
tool, and the items, requests and seconds each call reported), says in one line that it is waiting, and when the reply wakes it,
it reads the Sidekick's posts and replies in its home itself. It then
plans, in one message before any write: what
the runs showed, run by run; whether anything justifies a change (a
procedure problem seen in the runs, a deterministic step the runs repeated,
skipped or got wrong among them, or routine work that cost more turns or tool
calls than the work needs, never a platform failure); and if so
exactly what it will change and nothing else, which where a program runtime
exists says of each such step whether it becomes a saved tool or why it
stays in the instructions. An instruction a run did not follow is not covered
by being written, one run that repeated, skipped or got wrong a deterministic
step is evidence enough, and where a runtime exists such a step is the case
for a tool unless the run shows it failed on something outside it. The plan
comes after the reads because before them there is nothing to plan from: a
plan written from the notice's counts restated the notice and the rules, which
the two first live
reviews showed, whereas a plan written from the runs is the proposal a
reader wants to see before the revision lands. It acts on the plan: nothing
to change, stop after the report; otherwise revise as planned and submit
`ready=true`, never adding a connector, plugin, destination, trigger or
capability (a saved tool is part of the procedure, and the custom-tools guide
says how a review adds, rewrites or removes one:
[`code-mode.md`](code-mode.md#a-sidekicks-saved-tools)), never enrolling a delegate, submitting nothing over a
person's unfinished draft, and never adding a validation step that can turn
a report into a blocker: a run that withheld a data report because two
sources disagreed is a run that was silent when it should have posted, and
the fix is to post with the discrepancy named in one line; a review that
finds such a check removes it, and keeps one a person asked for only as a
caveat the report names. The run cannot be told otherwise: the activation
prompt's platform policy says a data report is always delivered, with a
failed source's reason in place of that section's numbers, and that rule
outranks the saved instructions. A run where no required source answered
reports that once rather than estimating, and a saved condition for when to
report (nothing new, a threshold not crossed) still holds. Only a person adds
a check: their own message in the wizard, or a change request whose
host-written "Run turn started by" line names a Rally member, never a request
another agent relays. When a change was saved
and the notice names where to announce it, it publishes one message there
with `conversation_post`, naming that conversation, for the people the
Sidekick works for: what it now does differently, why, and how to restore
the earlier version; nothing is posted when nothing changed. A Channel
target (General or a Personal Channel) lands in the Channel's own feed as a
message from Rally opening with the Sidekick's name
(`postSidekickChannelMessage`), which the authoring conversation's scope
lists, only that Channel, and no run's scope; a Thread or Breakout target is an ordinary post
([`conversation-tools.md`](conversation-tools.md)). It ends with a report in the authoring conversation for
the owner, who was not present. A revision it submits is an ordinary
revision, and the person reverts by asking for the earlier one.

### Change request from a run

A Sidekick run can ask its own wizard for a change with
`request_sidekick_change`, usually for a person who replied in the run's Slack
thread. The request is an agent message whose text begins with
`SIDEKICK_CHANGE_REQUEST_HEADER`, and the wizard's guide
(`AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE` in
`packages/agent-harness/src/automation-creator-tools.ts`) has a section keyed on
it that takes precedence over Save and report for that message. The section is
the procedure; this document does not restate it.
[`agent-communication.md`](agent-communication.md#a-run-asking-its-wizard-for-a-change)
owns the tool and the frame.

### Home conversation and attachments

A room's Sidekick has a **home conversation**: `owning_workstream_id` names the
Channel and `owning_substream_id` the conversation in it, `"0"` for its Main
conversation or a Breakout id. Both are on the Sidekick's
`automation_directory` row. A Sidekick created in a Breakout (with
`create_sidekick`) takes that Breakout as its home; one
created by a background agent takes Main, because a background agent's
conversation is not one anybody reads. The creator must be able to open the
home: a participant of the Channel for Main, a member of the Breakout
otherwise. Personal and workspace Sidekicks have no home and keep `"0"`.

The home narrows who counts as the room. `authorizeViewer`, the resource
authorization owner (`<channel>/<home>` in `authorization-service.ts`) and search
discovery all read the Breakout's members for a Breakout home and the Channel's
participants for a Main one. Archiving the home Breakout or its Thread archives
the Sidekick through `setOwningRoomArchived`, including drafts and manually
paused Sidekicks. Archiving a Channel archives its exclusive Threads through
the canonical Thread archive path and therefore archives their owned Sidekicks;
shared Threads remain active in their other Channels. A workspace Sidekick
merely attached or recommended in an archived conversation remains available
elsewhere. Restoring a Channel, Thread or Breakout never restores an archived
Sidekick; see Lifecycle.

Thread snapshots retain a monotonic archive generation across restores. The
hosted parent applies each new generation's irreversible Sidekick cascade in
the projection transaction, so delivering restore before archive cannot lose
the cascade. Breakout archival commits its Sidekick cascade with the canonical
child registry change in WorkspaceDO. A legacy `owning_room_archived_at` marker
also becomes terminal on the next archive or restore notice. Pause and resume
re-read lifecycle after authorization so an intervening archive stays terminal.

A Sidekick reads and posts through the `rally:conversations` plugin
([`conversation-tools.md`](conversation-tools.md)), whose scope for a Sidekick is
its home plus the conversations attached to it in WorkspaceDO's
`sidekick_conversation_attachments`. The home is always attached and never a
row. Only the Sidekick's configuration conversation attaches (the
`conversation_attach` tool), and only a conversation the attaching person can
post in, since attaching is the consent to publish there. A run posts with
`conversation_post`, which defaults to the home; nothing posts a run's result
for it. That table is not `parent_sidekicks` or a conversation's
`sidekick_attachments`: those record that a conversation may load the Sidekick
as a skill, and loading writes them automatically.

### Lifecycle

| Transition | Who | What |
| --- | --- | --- |
| `pause` | a manager | `runs` in `pending`, `running`, or `needs_input` become `stopped`; `lifecycle = 'paused'`, `paused_by = 'person'`; schedule, run and review alarm entries cancelled; the workspace's registrations replaced with `[]`; sidebar row enqueued |
| `resume` | a manager | each schedule's next due instant recomputed from now (a paused automation does not fire what it slept through), `lifecycle = 'active'`, `paused_by` cleared, alarms re-armed (a review request still owed is resent at once, else the review entry is re-armed from the count), the accepted evaluator projection re-registered with a fresh sequence boundary; refused with `sidekick_room_archived` while the owning room is archived |
| `archive` (`POST /sidekicks/:id/archive`; legacy `DELETE` remains for installed clients) | a manager | open runs stopped, stored `lifecycle = 'deleted'`, alarms cancelled, registrations replaced with `[]`; the object, conversation, and run history remain stored but become inaccessible, and `authorizeViewer` answers unauthorized and archived from then on. `deleted` is the compatibility tombstone name, not a claim that retained data was destroyed. There is no unarchive operation or archived-Sidekick browser yet. |
| `setOwningRoomArchived` | `WorkspaceDO`, from a directory effect that archived or unarchived the owning room | archiving uses the same terminal archive as an explicit Sidekick archive: active, paused and draft Sidekicks become `deleted`, open runs stop, triggers are cleared, and the Sidekick disappears from owned lists and becomes inaccessible. Replayed archive notifications are idempotent. Restoring the room never restores the Sidekick |

Who may manage (`assertManager`): the author or the run-as principal; for a
`workspace` automation also an owner or admin; for a room's automation only a
participant of the room, because authorship is not a share in the room's
automation. Who may view (`assertViewer`, and `authorizeViewer` for the
conversation): a `workspace` automation by any member, otherwise the author,
the run-as principal, or a participant of the owning room.
`claimExecutionPrincipal` is installed-client compatibility for authenticated
self-consent. Configured bindings, creator preference and human access remain
independent. A successful claim creates no management entitlement.

### The directory row

A Sidekick's `automation_directory` row is its definition row: id, author,
lifecycle, scope, home, title, description and next run beside the accepted
revision, bindings and appearance. Every change writes it in place, bumps the
`automations` sidebar waterline and republishes the list, in the same call.
A late `directory_automation` effect from the deleted `SidekickDO` is
acknowledged and logged as ignored. An applied row that
changes something a rail shows (not its run times) also advances the rail
waterline of the Channel that owns it and of every Channel recommending or
attaching it.

### Memory

`resolveMemoryAccess` gives a conversation whose parent is a Sidekick two
scopes: the workspace's, and the Sidekick's own scope of kind `sidekick`
keyed by the Sidekick id, writable. The drafting chat and every run share it,
so what a run learns is what the next run knows and what the person said while
drafting is part of that. The person's own scope stays out, because a run acts
for the automation rather than as the person, and a workspace automation's runs
would otherwise write into whichever member happened to be its principal.
That scope holds the Sidekick's typed tables. Its prose memory is the fact store
of [`agent-memory.md`](agent-memory.md): a Sidekick's conversation and runs are
swept like a Thread's, their facts are filed under the `sidekick` subject with
source `sidekick:<automationId>`, and a Sidekick reads its own facts, its home
conversation's, and the Organization's when its scope is `workspace`.

### Choosing what a Sidekick looks like

The hexagon on the Sidekick's profile is a button, and it opens the same palette
a work stream's header opens — the same catalog, the same fourteen-hue ring, the
same "each click saves and the popup stays open". The catalog, the descriptions,
the colour vocabulary and the deterministic default all belong to
[`workstream-appearance.md`](workstream-appearance.md); what belongs here is
where the value lives and how it travels.

The Sidekick's directory row stores it, in `appearance_json`, beside the title and
the lifecycle. The work stream keeps its appearance on the *main conversation*
and reaches it with a socket command, and the difference is not an
inconsistency: for a work stream the conversation is the room, while for a
Sidekick the authoring conversation is a child of the object that owns the
identity. Sending an icon down the chat's socket would make substream `0` the
authority for a fact about its parent. So this is `POST /sidekicks/:id/appearance`
— a parent-owned mutation over REST, the way pause, resume and delete are, which
is what [`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) asks for.
Management authority is checked exactly as it is for those three.

The write is a **patch**, merged over what is stored, so two people picking at
once change a field each rather than one silently restoring the other's colour.
The response is the whole `AutomationDetail`, not an acknowledgement: the person
who picked gets the committed value in one round trip and never watches their
own choice arrive twice. The screen sends one at a time, chained on a ref, for
that reason rather than for the object's: the object merges concurrent patches
correctly in any order, but two whole Sidekicks landing out of order would leave
the *cache* holding the earlier one — the same serialization the work stream's
socket hook does, for the same reason.

That chain orders these requests against each other and nothing else, so the
cache write is guarded as well as ordered. A pause, a resume, or the sidebar
push all refresh the same detail while a pick is in flight, and an older whole
Sidekick landing afterwards would put a stale lifecycle back with the
notification that would have corrected it already spent. The write keeps
whichever of the two carries the newer `updatedAt`, which is the object's own
clock and moves on every mutation there: a response older than what is cached
has nothing left to say, because whatever wrote that newer entry read this
appearance too.

Everyone else finds out the way they find out about a rename. The write enqueues
the automation's directory row, which carries the appearance to WorkspaceDO, and
WorkspaceDO pushes the `automations` sidebar list to every subscribed socket in
the workspace. That push is already what tells an open Sidekick page that its
chat published a revision, and the page refetches its detail on it, so the icon
travels the path that exists rather than a second one built for it. The sidebar
tiles and the library list read the appearance straight off the pushed row.

The setup chat chooses one too: `submit_draft` requires an icon and a color,
and `submitDefinition` writes them unless they repeat the last appearance the
chat knew of, which is its own previous submission, kept in
`automation.chat_appearance_json`, or the stored one before its first. A new
color must come from the ring; one outside it is accepted only as the color
already stored. The RPC field is optional, so a seeded or scripted definition
leaves the appearance alone.

A Thread- or Breakout-scoped Sidekick starts with its home conversation's
color in the creation transaction. It reads the current canonical Channel color
through `WorkspaceSpaceStorage.channelColor`, so a pending recolor job cannot
leave it wearing the conversation projection's old color. Without an active
Channel placement, it copies the exact home's stored color or uses the same
id-derived fallback as the glyph. An invalid stored appearance reports field
diagnostics without blocking creation or replay.
Only the color is copied: the icon remains the Sidekick's own generated mark.
This is a creation-time default; later home color changes and repeated creation
requests do not overwrite the Sidekick's appearance. Personal and Organization
Sidekicks still start with `NULL` appearance and use their own id-derived mark.

## Invariants

- **One automation is one object and one conversation, for its whole life.**
  Apply changes a lifecycle column in place and records which revision runs.
  Anything that mints a second id, or a second conversation, breaks every run,
  receipt, and email claim keyed on the first.
- **A definition revision is immutable and an activation is pinned to one.** A
  run reads its definition from the parent by the revision its loop input
  names rather than carrying a copy, which is why the loop input can be a
  four-field reference and why a later field change never has to migrate stored
  run contexts. Editing a revision in place would change what a run in flight
  was authorized to do. A continued run names the revision accepted when it
  continued, so one run's activations may read different revisions; each one
  reads one.
- **Only an accepted child projection moves a run row, and only a live state
  reopens a finished one.** `continueRun` writes nothing. A run hook that acted
  on a projection the parent did not accept would let a late completion from
  an earlier activation close a run that has since continued.
- **`occurrence_key` is the only admission fence.** Every trigger converges on
  it with `INSERT OR IGNORE`, so a Queue redelivery, a provider retry, and a
  repeated **Run now** each answer with the run they already made. A trigger
  that admits without a key admits twice.
- **A run stops when its automation no longer consents.** Pause and delete mark
  the run rows and the lifecycle, and `assertRunAuthorityStillValid` reads the
  live state before every provider write. The lifecycle row fences run authority;
  a separate registration generation orders asynchronous event-registration effects.
- **A Sidekick's directory row is its authority.** It holds the definition
  columns, and every content read re-derives access from it and from the
  Organization's own tables.
- **A Sidekick forwards nothing its children say.** The workspace hears the
  automation's row and nothing else; forwarding a run's aggregate would put
  every run in the work-stream directory, which is the design this replaced.
- **The one way a result reaches a room is `conversation_post`.** Rally
  posts nothing after a run; the run posts, once per result, when its
  instructions say the room should hear it, and a retried receipt lands once. A
  second delivery path is a duplicate the room reads twice.
- **The home is always `owning_workstream_id` plus `owning_substream_id`.**
  Every place that asks who the room is (viewer admission, the authorization
  owner, search discovery, the archive fan-out) reads both. One that read the
  Channel alone would hand a Breakout-homed Sidekick, and every post it made,
  to Channel members outside the Breakout.
- **A conversation attachment is not a skill attachment.** Only
  `sidekick_conversation_attachments` widens what a Sidekick may read and post
  to, and only an attach from its configuration conversation writes it. Reading
  `parent_sidekicks` as reach would grant every conversation that ever loaded
  the Sidekick.
- **Bindings are derived from the definition, never taken from a request.**
  `apply` carries an id and nothing else; a request field restating what the
  draft settled is a second source of truth for it.
- **A trigger is advertised only to a connection that can receive it.** The
  drafting catalog and the accept path both read a connection's triggers
  through `connectorActivityTriggerDescriptors` with its scope, so neither can
  offer an event the connection's scope cannot carry. A Sidekick built on one
  drafts, applies and activates, and then differs from a working Sidekick with
  nothing to do only in that it never fires.
- **A room's automation is the room's.** Its scope is fixed at creation, its
  managers are whoever may manage the room (grants and an archive included),
  its viewers the room's participants, it is listed only in the room's Channel menu,
  and the room's archive archives it. Authorship confers nothing on it.
- **A review's evidence is the accepted revision's runs, and only its
  finishes count toward the next one.** `noteRunFinished` counts a finish only
  under the accepted revision, and every query in `reviewNotice` filters on
  it; `apply` resets the count and leaves the clock. A review built from an
  earlier revision's runs asks the wizard to fix what the person just fixed.
- **The notice reaches the model only through the history projection's
  `sidekick_review_due` branch**, on a `system` row. The wizard's first
  activation initializes Bind from canonical history, so a branch that
  dropped that row would wake the wizard to answer a review it never saw; the
  worker test asserts on the model's prompt, not only on the row.

## Boundary

This module owns the automation: creation, drafting, revisions, apply,
lifecycle, schedules, occurrence admission, run provisioning, run state, the
home conversation and its attachments, and the sidebar row. The conversation
tools that read and post through that scope are
[`conversation-tools.md`](conversation-tools.md)'s.

It depends on the conversation hierarchy for its conversations and its runs
(`SubstreamAgent` and the effect legs;
[`workstream-durable-object.md`](workstream-durable-object.md)); on WorkspaceDO,
which hosts it ([`hosted-conversation-parents.md`](hosted-conversation-parents.md)),
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
  `sidekick_forbidden`, 404 `sidekick_not_found` or
  `sidekick_run_not_found`, 409 `sidekick_not_active`,
  `sidekick_not_paused`, `sidekick_room_archived`, 422
  `sidekick_definition_not_ready`, `sidekick_plugin_unavailable`,
  `sidekick_workspace_connection_required`,
  `sidekick_personal_connection_access_denied`, `sidekick_person_not_found`,
  `sidekick_resource_not_found`, `sidekick_recurrence_has_no_future`,
  `sidekick_timezone_invalid`, and the evaluator blocker codes. An identity
  mismatch is a bare `Error`, deliberately, because it is a wiring fault and not
  a refusal.
- **Apply fails part-way.** The transaction either committed or did not; the
  alarm re-arming and the registration replacement after it are idempotent, so
  the durable publication alarm retries and converges. Registration replacements
  carry a monotonic generation; older effects cannot overwrite newer registration
  state, and equal-generation retries preserve the original activation cutoff.
- **A run cannot be provisioned.** The `automation_run` alarm entry backs off
  under the shared alarm gate and retries; every step is a replay on an opened
  object. A run admitted while the automation was paused is marked `stopped`
  when its alarm fires.
- **The Queue redelivers a matched event.** `admitExternalEvent` answers
  `sidekick_occurrence_replayed`; the consumer logs it and acks.
- **A result cannot be posted.** `conversation_post` refuses with
  `conversation_archived` or `conversation_access_denied`, or
  `invalid_arguments` when a Sidekick with no home leaves the conversation out;
  the run sees the tool error and says so in its result.
- **A run's parent is unreachable** when `readRunDefinition` or `readRunState`
  is asked. The loop fails that turn and the harness's own retry applies; a run
  never proceeds on a definition it could not read.
- **The Sidekick is unreachable when a run child asks `continueRun`.** The
  drain fails before anything is activated, logs
  `substream_loop_drain_failed`, and the child's alarm claims the input again;
  the input stays at the head of the queue until the Sidekick answers.
- **Input the Sidekick refuses** (`sidekick_paused`, `sidekick_deleted`,
  `run_not_found`, `run_no_eligible_delegate`) lands as a delivered turn with a `sidekick_run_refused`
  system row naming the code, and logs `sidekick_run_continuation_refused`.
  What a sender outside Rally sees is the bound thread's to decide. A refused
  answer to a question the run asked lands the same way, as a turn with no
  Bind append; what a later continuation of that run makes of the answered
  question is not covered by a test yet.
- **A review cannot reach the wizard.** `deliverSidekickReview` throws, the
  consumer logs `sidekick_review_delivery_retry` with the code, the Queue
  retries, and the Sidekick's `sidekick_review` entry sends the same review
  id again until `reviewDelivered` lands; the wizard answers a repeat with the
  turn it already holds; one interval later an undelivered request is
  abandoned and logged. A review refused by the
  wizard's object is logged as `sidekick_review_refused_<code>`:
  `sidekick_review_destination_mismatch` or
  `sidekick_review_destination_unavailable` is a wiring fault,
  `workstream_archived` a deleted Sidekick, for which `reviewDelivery`
  answers `null` on the next send, and `workstream_authority_generation_stale`
  retries until the request is abandoned.
- **The sidebar row lags.** The row travels two Queue legs; a person who just
  submitted a draft sees the title update when the row lands, not when the
  tool returned. `GET /automations/:id` reads the object and is never stale.
- **Runs are listed to fifty and a detail's `recentRuns` to twenty.** Older
  runs stay in the object; there is no paging yet.

## Testing

`pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts
test-workers/sidekick-delegation.test.ts` drives the consent RPCs and services on
real workerd, including delayed first delivery, receipt replay, tombstones,
membership incarnations, viewer-only enrollment and own recovery after access
loss. The same lane exercises the actual autonomous creation service and
targeted changes to another Organization user. Production-break controls drop
creator enrollment or restore the old self-only restriction; both fail their
corresponding assertions. Withdrawal ordering and account recovery retain their
existing negative controls.
`test/sidekick-delegation-tools.test.ts` checks both actual plugin presentations
and advertised/runtime schema agreement. Harness `src/prompts.test.ts` covers
activation permission guidance; model behavior needs the separate evaluations.

`test-workers/sidekick-delegation-admission.test.ts` exercises real event matching,
delivery, due alarms, manual admission, continuation and compatibility claims.
The original Thread-owned personal Google Sheet shape and its Organization-owned
variant both start an event run and an hourly run through the same delegate.
Withdrawals, restricted audiences, coordinator identity and retained human
management are checked independently; production-code negative controls prove
those gates. It also checks that detail reads do not scan eligibility, preferred
and personal-event selection avoids unrelated delegates, and matching shares
pending checks only within one request while delivery still observes withdrawal.
Restoring the unnecessary scans or removing request-local sharing fails those
regressions. Delayed-delivery cases prove removed connections cannot start work,
reactivation refuses old unadmitted events, and accepted occurrences still
replay; both new refusals failed against the preceding production code.
The same workerd lane verifies canonical source-account capture,
legacy-opening recovery and rooted background origin reads; metadata cannot
forge that projection. `test/run-authority-validity.test.ts` checks the model/tool boundary's
specific coordinator failure and error-path attention recording.

`pnpm --filter @rally/desktop exec vitest run
src/renderer/components/automation-header.test.tsx` covers persistent profile
controls, timing and legacy email summaries, keyboard navigation to unavailable
menu items, their tooltip reasons, and inert Enter/Space activation. Visual
placement, disabled hover styling and compact Details view are checked in Electron.

Workstream recommendation coverage lives in `test-workers/hosted-sidekick.test.ts`
(child agent tool attachment, fresh main/sibling catalogs, later-created Breakouts,
instruction bodies reaching inference, local loading across eviction, combined
removal, owned-source isolation, and Space defaults on a newly born Channel)
and `test-workers/conversation-parent-contract.test.ts` (v12 migration,
idempotency, scope, participation, durable sync publication and unsupported
automation parents). Hidden child tool coverage also proves REST refusal,
stopped-execution refusal and preservation of Main's loaded attachment.
Run them with `pnpm --filter @rally/api
test:workers`. Desktop `sidekick-picker.test.tsx`, `sidekick-section.test.tsx`, and
`workstream-sidekicks.test.tsx` cover selection, merged badges/removal, and switching
substreams. Harness `skills.test.ts` proves recommendations do not load bodies.

| Suite | Command | Covers |
| --- | --- | --- |
| `apps/api/test-workers/hosted-sidekick.test.ts` | `pnpm --filter @rally/api test:workers` | On real workerd, with `connector_connections` in WorkspaceDO and deliberately absent from D1: draft, `submitDefinition`, and `apply` binding a workspace connection, reserving the address, and activating; a missing connection refused; a second ready revision re-applied on an active automation; pause stopping the in-flight run and clearing registrations, resume re-arming; delete tombstoning the row and leaving the sidebar; management refused to a member who is neither author nor principal; `runNow` idempotent on its key; `admitExternalEvent` idempotent and refused before the boundary; `admitInboundEmail` answering a retry from its receipt and refusing a stranger; the run provisioned as a child substream whose loop reads its definition by revision, with `runs.state` following the child's state through the effect leg; and the scheduled self-review: ten finishes arming, requesting and delivering a review with the counts and sample, whose row carries the sentence a person reads and whose model turn is asked with the Rally-attributed notice first; the three-day floor, a new revision resetting the count and retiring a pending request, a finish under the previous revision not counting, delivery re-arming from the count, resume resending a request still owed; the accepted revision's runs sampled with failures before stops and other revisions excluded, a lost message resent and then delivered once. |
| `apps/api/test/sidekick-review-notice.test.ts`, `test/model-protocol-transcript.test.ts` | `pnpm --filter @rally/api test` | The notice's row sentence and model framing against literals, both windows and an empty sample; and the history projection admitting the notice as one user turn under Rally's first line. |
| `apps/api/test-workers/sidekick-run-continuation.test.ts` | `pnpm --filter @rally/api test:workers` | Continuing a finished run as its run-as user; refusals while paused; a pause after a continuation's approval fencing its writes; a run's loop acting while its row still reads `pending`, before provisioning reports it running; and background workers beneath authoring or run conversations executing initial and follow-up assignments with inherited authority. |
| `apps/api/test-workers/automation-post-result.test.ts` | `pnpm --filter @rally/api test:workers` | The result tool appending into the owning room's substream `0`, and refused for an archived room and a stale generation. |
| `apps/api/test-workers/automation-directory.test.ts` | `pnpm --filter @rally/api test:workers` | `create` alone putting a draft row in the author's sidebar, a workspace row in everyone's, and a room's row only in `listWorkstreamAutomations`; and `setAppearance` — driven through the object's stub, the boundary `AutomationService` crosses — merging one field at a time, reaching both directory listings through the real effect legs, and refusing somebody who cannot manage the Sidekick; and `AutomationService.listSidekicks` listing each scope to exactly the members it did before while the object sends D1 no `workspace_members` read. |
| `apps/desktop/src/renderer/screens/automation.test.tsx` | `pnpm --filter @rally/desktop test` | The profile's appearance saving: an older response losing to a newer Sidekick already in the cache, and its own response applied when nothing newer arrived. |
| `apps/desktop/src/renderer/components/workstream-glyph.test.tsx` | `pnpm --filter @rally/desktop test` | The play cut out of the hexagon with its own mask, its hover target, and the sentence it reports. |
| `apps/api/test-workers/automation-acceptance-bindings.test.ts` | `pnpm --filter @rally/api test:workers` | The binding half in isolation: the table absent from D1, a recommended plugin bound from the workspace object's connections, a missing one refused, a disabled row skipped for the live one. |
| `apps/api/test-workers/external-event-routing.test.ts` | `pnpm --filter @rally/api test:workers` | One accepted event and one matcher serving an automation and watched work streams; a redelivery admits once. |
| `apps/api/test-workers/conversation-parent-contract.test.ts`, `conversation-effect-queue.test.ts` | `pnpm --filter @rally/api test:workers` | The parent contract through the real ticket route, including refusal of author and participant access and fresh tickets after a room archive, retained legacy read-only admission, and the effect legs an automation's children use, including a child effect producing no `parent_effect` row. Owned by [`workstream-durable-object.md`](workstream-durable-object.md#testing). |
| `apps/api/test/external-event-evaluator.test.ts` | `pnpm --filter @rally/api test` | The pure predicate: legal and illegal documents, missing-field semantics, the connector vocabulary an authoring rule is held to — and the boundary between the two predicate spellings, which is where a change that let the model's `matching` reach a stored column would fail. |
| `apps/api/test-workers/sidekick-run-continuation.test.ts` | `pnpm --filter @rally/api test:workers` | On real workerd with the effect queue held, so the run row still reads finished while the continuation runs: input to a completed run continuing it with `automationRun`, the run-as principal (changed since the run started) and the revision accepted since, with the continuation note last; paused, archived and unknown runs refused with their codes, both inputs landed, and the run continuing after a resume; two concurrent replies both reaching the model as the continued run; a finished row reopened only by a newer projection, a stale completion not closing it, repeated complete and reopen cycles, `idle` not reopening, and a paused Sidekick not reopening; an elicitation answer keeping the run's context. |
| `apps/api/test/run-authority-validity.test.ts` | `pnpm --filter @rally/api test` | A running run admitted, a paused or unknown one stopped, connector evidence not re-read after admission, and a run with no automation reference asking no automation; a continuation acting through a `completed` or `failed` row and a `stopped` one that stopped before the approval, and refused for a stop after it or a paused Sidekick. |
| `apps/api/test/model-protocol-transcript.test.ts` | `pnpm --filter @rally/api test` | Among the transcript projection cases: a bound-thread reply in a run child rendered as labelled evidence and never as a member request, in the transcript and in the live admission projection, and the continuation note's wording. |
| `apps/api/test/scoped-memory.test.ts` | `pnpm --filter @rally/api test` | A Sidekick's conversation resolving the workspace scope and its own `sidekick` scope. |
| `apps/api/test/resend-inbound-email.test.ts`, `workstream-email-routing.test.ts`, `workstream-email-address.test.ts` | `pnpm --filter @rally/api test` | The single admission call, its receipts, and the address claim. |
| `apps/api/test/access-revocation.test.ts` | `pnpm --filter @rally/api test` | The workspace fan-out naming an automation and the consumer walking its children. |
| `packages/agent-harness/src/automation-creator-tools.test.ts` | `pnpm --filter @rally/agent-harness test` | The drafting tools, the `matching` evaluator shape, the tool schema offering that spelling alone, the submission pre-check, and the sentence a scope-blocked connection carries into the catalog and into a refused rule. |
| `packages/contracts/src/automation-evaluator-resources.test.ts` | `pnpm --filter @rally/contracts test` | Which resources a rule may name: the bindable set and its predicate, and the sentinel and structural cases that drop an id before the parse. |
| `apps/api/test-workers/sidekick-resource-registration.test.ts` | `pnpm --filter @rally/api test:workers` | Provider-verified registration, canonical identity reuse, event binding and incoming-event resource resolution, inaccessible files, personal ownership, frozen grants, and connection revocation against real WorkspaceDO storage. |
| `apps/api/test/automation-creator-catalog.test.ts` | `pnpm --filter @rally/api test` | The drafting catalog and its research tools against the routed workspace database: the connection a webhook earns by its triggers alone, the triggers a personal connection is not offered and the workspace one still is, people search, and `resources_search` returning only bindable containers — the fresher event resource beside them left out, and nothing at all where a connector declares no relationship. |

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
siblings in `test-workers/helpers/conversation-effects.ts`. For the review:
the entry is armed for now by the tenth finish and the object's own alarm may
run it before the next line, so the Queue `send` spy that stands in for the
consumer is wired in before that finish (`interceptReviewSends`), and what is
asserted is the send and its effects, never the entry's due instant; the
three-day floor is moved by writing `reviewed_at`, not by stubbing the clock;
and the notice row landing proves nothing about the model, which initializes
from canonical history: assert on the prompt the double was asked with.

## Data model

A Sidekick's rows are `WorkspaceDO`'s: `automation_directory` (with the
definition columns migration 91 added, and migration 132's
`runs_since_review` and `reviewed_at`), `sidekick_revisions`,
`sidekick_schedules`, `sidekick_runs`, `sidekick_email_receipts`,
`sidekick_reviews` (migration 132: one row per review request, with the
notice it carried and when it was delivered; the same migration adds
`sidekick_revisions.review_id`, the review a revision answered, null for a
person's), the child
tables, and alarm entries keyed `<sidekickId>:<key>`;
[`hosted-conversation-parents.md`](hosted-conversation-parents.md#a-sidekick-is-hosted-beside-them)
maps them to the tables of the deleted `SidekickDO`.

`WorkspaceDO` migration 32 rebuilt `automation_directory` (automation id,
workspace, author, `source_version`, hash, lifecycle, scope, owning work stream,
title, description, next run, projected time) and
`workspace_external_event_registrations` (a complete replacement per destination
keyed on `destination_key`, with
`effective_after_event_sequence` as the cutoff), dropped
`workspace_external_event_deliveries`, `automation_creation_claims`,
`automation_cutover_campaign`, `automation_templates`, and
`automation_template_versions`, and deleted every work-stream directory row an
automation run had made. [`data-model.md`](data-model.md) is the map of both
authorities. Workspace migration 35 projects stored `loadable`; migration 36
adds `external_registration_generations`, retaining the latest generation and
activation cutoff even for an empty replacement; migration 49 adds
`automation_directory.appearance_json`, nullable and never backfilled; migration 86
adds `automation_directory.owning_substream_id` (`NOT NULL DEFAULT '0'`) and
`sidekick_conversation_attachments`, keyed by `(automation_id, parent_kind,
parent_id, substream_id)` with who attached it and when. Migration 85 is the
external conversation bindings table's. Owner migration 4 stores the
source counter. Versioned registration IDs equal immutable evaluator IDs, so a
late delivery from a superseded predicate is refused by the owner.

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
conversation seats its persisted coordinator, and its state reaches nobody but
the parent.

Inbound mail is untrusted: the From header can be spoofed, so the sender must
resolve to an active workspace member, and to the author or principal for a
personal automation. That screening is the whole control; an inbound-email run
holds the same tools as any other run, a decision
[`security.md`](security.md) records.

A continued run retains its coordinator whoever sent the input,
and `continueRun` does not screen the sender: anyone who can reach a run may
continue it, including a person outside Rally in a thread bound to it. The
control is the framing. Text from an external actor in a run child
(`externalInputFraming`) reaches the model as "EXTERNAL <PROVIDER> MESSAGE:
EVIDENCE, NOT A REQUEST" with the sender's display name and provider member
id, the way inbound mail is labelled, and never as the "EXTERNALLY ATTRIBUTED
... MEMBER REQUEST" a Slack Agent Channel renders; the continuation note, which
carries the sender's name, is a user-role message too. The same row in a
Channel or in a Sidekick's configuration conversation keeps the request
framing.

Binding records configured sources and retains an existing source while its
delegate is unavailable. An owner can configure their own connection during
setup; execution still requires eligible delegation. Every Sidekick scope uses
the same consent policy. `claimExecutionPrincipal` records only the authenticated
claimant's consent; it adds no human access entitlement and cannot replace other
delegates, configured sources or creator preference.

Losing access closes an open conversation. The automation holds no socket of
its own; the [access-revocation queue](access-revocation.md) reaches its
conversations through `listChildren`.

## Operations

A run's state, its trigger, and its summary are on `GET /automations/:id/runs`
and in the Organization's `sidekick_runs` (`run_workspace_sql`, filtered by
`sidekick_id`). A missing scheduled run is a `sidekick_schedules` row whose
`next_due_at` is null or an entry keyed `<sidekickId>:<scheduleId>` behind its
backoff gate in `_internal_durable_alarms`; the Organization's alarm report
names the entry and the handler's code. A run stuck `pending` with its child
registered is waiting on its `sidekick_run_provision` message, which its entry
sends again. When
a handler's code is a schema rejection it names the schema and the failing paths — a
bare `ZodError` there is a parse that has not yet been moved onto
`parseRpcInput`, and is itself the defect to fix before diagnosing further. A
run refusing provider writes with "This automation run is no longer running"
was paused or deleted after admission. Whether and when the wizard was asked
to review is `automation_directory.runs_since_review` and `reviewed_at`, the
`sidekick_reviews` rows (`delivered_at` null while the Queue still owes the
wizard the notice; a request superseded by a revision, skipped on resend or
abandoned is deleted, so the table holds what reached the wizard), the
`<sidekickId>:review` entry, and the `sidekick_review_requested`,
`sidekick_review_delivered`, `sidekick_review_skipped` (with its code) and
`sidekick_review_abandoned` log lines in the Organization object, and
`sidekick_review_delivery_retry` in the consumer, the one line that carries a
refusal's reason. What reviews changed is `sidekick_revisions` where
`review_id` is not null, joined to `sidekick_reviews` on it, and the
`sidekick_review_revised` log line (review id, revision, ready) the save
writes when the wizard submits during a review; both are written by the
host, with nothing for the model to do. A submission is the review's when
its turn carries the review's reason, or when the review's notice is the
last word in the authoring conversation that is not the wizard's own
(`reviewOwnsThisTurn` in `integrations.ts`): the wizard hands the reads to a
background agent and ends its turn, and the agent's reply wakes it with that
reply as the reason. The review's agents are the ones the wizard started
(`ownedAgentDescendants` of the wizard), not every address under the
Sidekick: a run of the same Sidekick passing on a change request has that
address shape too. The delegation is read only when an agent wrote after the
open notice, so most submissions read the conversation alone. A turn a person woke is theirs without reading the
conversation, and a request from any other agent (another Thread's Rally
relaying an edit, or one of this Sidekick's runs) ends the review, as the wake
or as a row; otherwise a review stays open until a person speaks or the next
notice lands.
[`runbook.md`](runbook.md) has the production inspection paths.

## Scoped Sidekick discovery reuse

Guest candidate selection uses one recommended-or-loaded ID rule across execution
and management. Initial execution memoizes recommendation references within that
request; pinned retries still revalidate their sources. Management queries resolve
candidate summaries without recursively invoking other public service entrypoints.
Desktop and browser request management options only when their controls open, not
on every transcript update.

Sidekick authoring uses the shared plugin-discovery guidance to check authorized
capabilities before reporting a blocker. Provider-specific procedures stay with
their owners: the Google plugin prompts point to `reading-google-meeting-notes`
for meeting-document lookup and describe Gmail draft PDF resource attachments.
That reading skill composes with `polling-for-events` for a recurring workflow.
The Sidekick authoring prompt carries no Google-specific lookup or attachment
instructions. See [Google connector guidance](connectors.md#google).

## Changelog

### 2026-11-07 — A run's first page says what it spent

**What changed:** `sidekick_runs_read` adds each tool call's `ms` and a `usage`
summary with a context-growth note on a run's first page (above).

**Why:** The self-review now treats routine cost as evidence, but the reader had
only the transcript: 965 turns to count by hand for Daily Active's run of
2026-11-05, no tool times, and no tokens. A transcript also hides the cost of a
turn: Daily Active's run of 2026-11-06 made 195 calls whose input grew from
30,652 to 333,822 tokens, 42.8 million in all, for $17.20, and no message in it
looked large.

**Considered and rejected:** The usage ledger: it has no index by run, and
`inference_attempts` holds the same costs in the run's own object (the
2026-11-05 run sums to $197.09, what it was billed). Counting assistant turns:
it carries no tokens and misses retries. A per-call token series: the first,
last and largest call show the growth at a fraction of the size. Fencing the
tool counts to the run's own activations: receipts carry no transcript
sequence, and chat after a Sidekick run is rare.

**Consequences:** `usage` is in the first page's content hash, so a receipt or
attempt that settles between fragments of that page is refused as changed
evidence, even when its turns did not move.

### 2026-11-07 — A self-review counts cost, not only failure

**What changed:** The self-review's reader reports what each run's routine work
cost: model turns, calls to each saved tool, and the items, requests and seconds
each call reported. Routine work that cost more turns or tool calls than the work
needs now justifies a change. Where a program runtime exists, a tool call that
finished fewer items than its measured settings, returned exceptions code could
have settled, or timed its share against a fixed number is the case for
re-tuning the tool and timing it again; a tuned tool that still needs several
calls for a large job stays as it is, so a review does not rewrite it each time. The
custom-tools guide adds what re-tuning looks for: a source that answers for many
items in one request, and reads that return every fact the next step needs.

**Why:** Daily Active Rally Organizations made 966 model calls in one run. Moving
its scan into a saved tool cut that, but the tool still took one page per call,
four reads at a time, and one count per conversation that sent every active
conversation back as an exception for a second pass. Each fix came from a person
asking for it step by step: no run was wrong, so the review's list of what
justifies a change (a procedure problem, a deterministic step done wrong, never
a platform failure) never reached it. A review that sees only failure leaves a
Sidekick as costly as it first was.

**Considered and rejected:** Tuning each Sidekick by hand: it does not reach the
next one. A turn or call threshold that triggers a change: a number with nothing
to set it from, where the run's own report already says whether work was routine.

**Consequences:** A review can now revise a Sidekick whose runs all succeeded.
Prod eval scenario P13 (`scripts/code-mode-evals.mjs`) checks that setup alone
produces a tool that finishes a large scan in at most two calls.

### 2026-11-06 — No saved instruction can turn a data report into a blocker

**What changed:** The no-gate rule moved from the wizard's prose into the
activation prompt's platform policy, which outranks a Sidekick's saved
instructions; the wizard and self-review now write a person's check as a
caveat, and only a person's own message or a member-started change request
adds one. `reporting-on-data` gains a short guide to reading zeros and
unmatched values.

**Why:** The two 2026-10-30 entries below put the rule in the wizard's
prose, and the Daily Signup, Traffic & Attribution Report kept withholding
anyway. Its revision 15 still said "Block only required-source failure,
missing result contradictory to relevant data, unconfirmed freshness … No
partial report", because the exception for "the person asked" was met by the
Thread agent's own `send_message` text ("Post complete report … or exact
query/data blocker"), not by anything its owner wrote. On 2026-11-04 the run
saw only `download` clicks, which carry no `flowId` by design, read the
missing `secondary_cta` clicks as contradictory data and posted nothing; the
same zero on 2026-11-02 had posted. A rule in the wizard holds only while
every revision obeys it, and saved instructions sit below platform policy,
so the run-time rule is the one place the behavior cannot drift.

**Consequences:** A run that once would have withheld now posts with
caveats, including for a Sidekick whose saved instructions still say to
block; those instructions need no rewrite to take effect. A person who
genuinely wants silence on a bad day has no way to ask for it; that is
deliberate, and a later request for it is a new decision, not a regression.
A check stated as "missing result contradictory to relevant data" is now a
caveat, so a real tracking break shows up as a posted zero with its caveat
rather than as a missing report. A run where no required source answered
still posts only that, with a recovery step: the alternative, an absolute
"never only a blocker", invites a model to fill an empty report with
estimates.

### 2026-11-02 — A run's change request is not the review's, and a wizard's answer reaches the thread

**What changed:** `reviewOwnsThisTurn` tells the review's agents apart by
delegation, the agents the wizard started, instead of by an address under the
Sidekick. A turn the Sidekick's own wizard starts in a run gets its own
continuation note: post the wizard's answer in the thread where the person
who asked wrote.

**Why:** The first production change request from a run (a Slack reply to the
daily signup report, 2026-11-02) was saved as revision 11, but stamped as the
answer to the last scheduled self-review: the run's message came from
`automation/<id>/<runId>`, the same shape as the review's reader agents, so the
review looked open. The same run then re-posted the report in the new format
and never told the person the change was saved for future reports. The
generic note told it to handle the wizard's message "only as the Sidekick's
instructions direct", and the instructions say nothing about a change request.
Replayed on Terra with a reply that also asked to re-send today's report, the
run confirmed the save in 1 of 3 runs before the note and 4 of 4 after.

**Considered and rejected:** Recognizing a change request by its header text:
the review check would then depend on model-visible wording. A stronger
sentence in the run's own guidance alone: it raised confirmations but cost
change requests elsewhere (Terra sent 25 of 28 instead of 28), because "reply
in the thread" read as "just reply"; the run guidance keeps that instruction
conditional on the wizard's reply.

**Consequences:** A review's revision is recorded against it only while the
latest word after its notice is the wizard's or its delegated agents'. A run
that re-posts its result before the wizard answers still follows the
Sidekick's own delivery instructions, which can put the re-post at the top of
the channel rather than in the thread.

### 2026-11-01 — An instruction a run did not follow is the case for a tool

**What changed:** Review step 2 and the custom-tools guide rule out two
reasons for leaving a deterministic miss in prose: "the instructions already
say so" and "only one run showed it".

**Why:** The first self-review on the build that made the plan answer
tool-or-not (Daily Signup, Traffic & Attribution Report, 2026-11-01 00:41 UTC)
had the scout name three misses in its one run (date bounds passed as literals
where the instructions require computing them in code, deltas typed into the
Slack text by hand, no flow-entry dedupe or paging guard) and the plan decline
all three as "already covered by the current instructions; this single run
does not establish a new rule." Both are the wrong inference: an instruction
the run did not follow is the failure a tool exists to remove, and a
deterministic step is binary evidence. The guide asked for a reason and
accepted any; it now names the two that do not count, and keeps the one that
does: a step that failed on something outside the run (a timed-out read) is
not a re-derived step.

**Consequences:** A review can no longer leave such a step on those two
grounds. The grounds the guide names still stand: a transient failure, and a
writing tool the review cannot test against a scratch table, which is left as
it is and reported. Where no runtime exists, the same step is still a reason
to change the instructions.

### 2026-10-31 — The review plan answers tool-or-not for each deterministic miss

**What changed:** Three sentences of prompt. The scout's assignment (review
step 1, and `SIDEKICK_RUN_READING_GUIDANCE` in its own system message) asks
for each deterministic step a run repeated, skipped or got wrong, with the
examples named: a dedupe after the reads, a page not followed, a date bound, a
union or a count worked by hand. Step 2's list of what justifies a change
gains that item. The custom-tools guide, where a program runtime exists, now
makes the plan say of each such step whether it becomes a tool or why it stays
in the instructions, and calls a plan that leaves that unanswered incomplete.

**Why:** The second production self-review on the deploy that let a review
change tools (Content Machine Research Enricher, 2026-10-31 18:54 UTC) had the
guide in its system message and `sidekick_tool_test` in its catalog. Its scout
reported, run by run, that dedupe ran after the source reads in three of five
runs so known URLs were fetched again, and that the X timeline was read to its
first page in all five. The wizard's plan named neither and changed only the
two delivered outcomes it saw as defects: a double post and an overstated
verification. Step 2 listed what justifies a change (format, time, posted or
silent wrongly, an instruction the run could not follow), and a repeated or
skipped deterministic step was not on it, so the wizard was right by its own
rules to leave them. The guide's sentence granted permission to make a tool
and asked nothing, and permission the plan need not mention is permission the
smallest edit never uses. Making the scout name the misses and the plan answer
for each turns the sentence into a decision the wizard has to write down, in
the plan a reader sees before the revision lands.

**Considered and rejected:** Asking the host to detect a repeated step (a
re-fetched URL, an unfollowed continuation) and put it in the notice: the host
knows a run finished and under which revision, not what the run did, and the
review's design keeps the reasoning in the wizard and costs the runs nothing.
Putting the tool question in step 2 of the authoring prompt rather than the
guide: step 2 is shown in every deployment, and one without a program runtime
would be asked a question it cannot answer; the step-2 addition is only the
observation, which a prose fix (dedupe before the reads) answers there.

**Consequences:** A review now proposes a change for a deterministic miss even
where no runtime exists, as prose. Where one exists, the plan carries one line
per miss; a tool it saves meets the same test gate and single-purpose rule as
at setup. The scout's report grows by one item per run, which is bounded by
the sample the notice picked.

### 2026-10-31 — A review may turn a re-derived step into a saved tool

**What changed:** The custom-tools guide, shown to the wizard only where a
program runtime exists, now says tools change with the procedure in a
self-review, using only plugins already recommended: a deterministic step the
runs re-derived or got wrong becomes a tested saved tool, a tool the runs
misused or no longer need is rewritten or removed along with the instructions
that call it, the plan names each, and a tool is part of the procedure rather
than a new capability. A review tests a writing tool only against a scratch
table, never by accepting a row in a table the runs read, and leaves one it
cannot test that way as it is. That replaces the earlier rule that a review
changes a tool's code only when its program makes no writes.

**Why:** The first production self-review on the deploy that shipped saved
tools (Daily Active Rally Organizations, 2026-10-31) had `sidekick_tool_test`
in its catalog, read four runs that each failed on checkpoint writes, pagination
and set unions, and saved nine thousand characters of procedure prose with
`customTools: []`. Step 3 of the review tells it to change exactly what the plan
named and never to add a capability, and the guide spoke only of setup, so a
tool read as out of bounds. The sentence sits in the guide rather than in step
3 so a deployment with no runtime never tells a wizard to test a tool it does
not have. The no-writes rule existed because a review has nobody present to
accept a test's write; the scratch-table rule keeps that protection (a test
row never lands in a table the runs read, so a checkpoint cannot move on test
input) while letting a review fix a writing tool that can be tested that way,
and the `custom_tool_untested` gate still refuses an untested rewrite.

**Considered and rejected:** Keeping the no-writes rule and letting a review
only add tools: a review that found a writing tool wrong could then neither fix
nor remove it, and the wrong tool would run every day until a person noticed.
Putting the sentence in review step 3 of the authoring prompt: that text is
shown in every deployment, and one without a program runtime would be told to
test a tool it cannot have.

**Consequences:** The test gate and the single-purpose rule apply to a tool a
review adds or rewrites as they apply at setup, so a rewritten tool is an
untested tool until `sidekick_tool_test` runs it again. Removing a tool needs
no test; the guide tells the review to rewrite the instructions that called it
in the same revision, and nothing in the schema checks that, so a stale
`custom_<name>` reference would fail at the run as a tool the plugin does not
have.

### 2026-10-31 — The wizard saves a tested program as a tool its runs call

**What changed:** The definition gains `customTools`: a name, a model-facing
description, a plain-object input schema, a program and the plugins it calls.
The wizard tests a candidate with `sidekick_tool_test`, which runs it for real
through Code Mode with that plugin allowance and records the code hash;
`submit_draft` refuses a ready draft whose tool has no recorded test for its
current code. A run receives every saved tool as `custom_<name>` through the
always-active `rally:custom-tools` plugin. The profile lists them read-only.
[`code-mode.md`](code-mode.md) owns the mechanism.

**Why:** The 2026-10-22 entry made the wizard save its tested method as prose,
and the PostHog report runs showed what prose costs on a weaker model: most of
each run re-verifying what the wizard had verified, and blocks on arithmetic the
run re-derived. A program is the method in a form the run executes rather than
interprets.

**Considered and rejected:** Letting a run paste the saved program into
`code_execute` itself (the point is that the run never handles the code); a
separate tools table (a tool is pure definition, unlike a memory table, which
is shared storage); checking the wizard's receipts from WorkspaceDO at
publication (a cross-object read on the publish path; the test is buffered in
the drafting state and restored from receipts instead).

**Consequences:** A tool needs a triggered Sidekick; an instruction-only one is
a Skill and carries none. A `plugin_*` the tool calls must also be in
`recommendedPlugins`, so the run has it loaded; of Rally's own plugins only
`rally_core`, `rally_tables`, `rally_memory` and `rally_web` may be called, and
they need no recommendation. A changed program, schema or plugin list is an untested tool
again, refused as `custom_tool_untested` by field. The review revises a tool
under the same gate, never adds a plugin through one, and changes a tool's code
only when its program makes no writes.

### 2026-10-30 — A person's check stays; a review removes the wizard's own

**What changed:** On top of the entry below, the authoring prompt says a
data report is delivered even when a number is zero or looks wrong, that a
report is held back when the person asked for that check, and that the
wizard never invents a freshness gate and adds a check only when the
person asks. The self-review removes a check that held a report back,
unless a person asked for it.

**Why:** The entry below forbids a review from saving a new gate; it did not
say what a review does with one already saved, and the PostHog report's
revision 8 was such a gate until its owner rewrote it by hand. The
exception for a person's request keeps the review's rule that it never
undoes a choice a person made, which review bots on the pull request read
the first wording as breaking.

**Consequences:** A gate a review wrote is removed at the next review that
finds it holding a report back; a gate a person wrote is kept at setup and
at review.

### 2026-10-30 — A review may not make a data Sidekick quieter

**What changed:** `AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE` says, when the
procedure is written and again in the self-review's plan and act stages,
that a procedure which reports data delivers its report: two sources that
measure differently will not agree exactly, so a run names the difference in
one line and posts, and holds a report back only when a required source
failed or returned nothing while another shows data. A review treats a report
withheld over a disagreement as "silent when it should have posted", and may
never save a check that compares independently defined measures and blocks on
a mismatch.

**Why:** The Daily Signup, Traffic & Attribution Report's self-review, asked
to explain a day of zeros that a telemetry backlog had caused, added
freshness and cross-source checks and a rule to block when "diagnostics
disagree". Its next scheduled run had the numbers in hand (82 visitors,
105 views, 90 sessions, freshness confirmed) and withheld them because
PostHog's web overview counted `$pageview` plus `$screen` where the run's SQL
counted `$pageview` alone, 56 against 50, with a third figure from a
differently bounded window. A person had to read the blocker, work out that
the measures differed by definition, and ask the wizard to relax the rule.
The review had made the Sidekick stricter, which for a report is the same as
quieter, and the previous guidance named only the opposite failure, posting
when it should have stayed silent.

**Considered and rejected:** A host-side rule that a review's revision may
not lengthen the instructions or add a condition: the guidance already keeps
the rule on what a review may save in the prompt rather than in a gate, and
a length rule would block a legitimate fix. A tolerance number for
cross-source agreement: it would be a guess, and the rule needed is that a
disagreement is reported rather than measured.

**Consequences:** The bar for withholding a data report is a source that
failed or came back empty while another shows data, in the first draft and
after every review. A caveat line is the way to carry doubt; a blocker is
not. Over-validation that still reaches a saved definition is a procedure
problem the next review is told to recognize and remove.

### 2026-10-30 — A silent run ends with one line, never with nothing

**What changed:** The activation prompt tells every run to end with one
short final message in its own run conversation, which notifies nobody, and
never with no text; the authoring prompt tells the wizard to write run
instructions that way, and the self-review never to require an empty final
message. The wizard says one line that it is waiting after it starts its
reading agent, and answers a progress message or a question with one line,
rather than ending the turn with nothing.

**Why:** The harness reads an empty completion as a provider defect
(`acceptEmptyCompletion` is off for every production harness): it retries
the route and then falls back to the next model. Two prompts asked for
exactly that output. A self-review that saved "require an empty final
response when there is nothing to report" made nearly every later run of
that Sidekick fail as `harness_execution_failed` once every model in the
cascade had obeyed, and the wizard's "end your turn" after `start_agent`
handed the turn to a fallback model that ignored the instruction and
narrated, or read the runs a second time. Fleet-wide in the day before
this change, about 2,800 defect attempts across some 900 turns. The
alternative, accepting an empty completion as a silent end of turn, would
have hidden a real provider failure in the same shape as an instructed
silence; one visible line keeps the two apart and costs the owner one
sentence.

**Consequences:** A run's record always ends with text, so the run summary
is never empty for a silent run. A definition that still asks for an empty
final message is overridden by the activation prompt and should be
corrected where found.

### 2026-10-30 — The wizard's agents reach its route, and read before they report

**What changed:** The harness run's model routing passes the agent's
background, run and delegation fields to `resolveWorkstreamModelRouting`,
as the flag key beside it already did, so a background agent the wizard
starts runs on `sidekick_authoring`. The reading guidance for that agent,
and the wizard's assignment to it, ask for one report once every run is
read, and the wizard ends its turn again on any message from the agent
that is not that report.

**Why:** The first three reviews on the delegated path showed both gaps.
Each wizard's agent ran on Terra while the flag key logged said
`sidekick_authoring`: the call site that resolves the route built its own
context from the parent kind and substream alone and dropped the fields
that tell the wizard's agent from a run's worker. And "report run by run"
read as one message per run: GitHub PR Firehose's agent sent a progress
message after each of twenty runs, every one woke the wizard, and the
wizard narrated each to the owner, twenty-odd posts before any plan. The
alternative, a host rule dropping agent progress messages, would have
hidden a question the agent had to ask; one report is what the assignment
should have said.

**Consequences:** A wizard's background agents and its Main share a route,
so a pin or flag change for the wizard moves its agents too. A review's
authoring conversation gains one agent report, not one row per run.

### 2026-10-30 — The first production reviews: a continued turn keeps its review, and run pages stay one document

**What changed:** Three things the first three production reviews showed.
A wizard submission is recorded against the review when the review's notice
is the last word in the authoring conversation that is not the wizard's own
or its own background agents', not only when the turn's reason is the
review's; a person, or an agent from another conversation, ends it. The run reader hashes the
run and its transcript rather than the serialized page, remembers the pages
an activation built, and makes a rebuilt continuation load exactly the
outputs the first fragment carried. The background agents the wizard starts
get the run reader and the wizard's model route, a read that names no run
walks the due review's runs from the notice, and the guidance makes one such
agent the reader.

**Why:** Help email triage's review handed its reads to a background agent
and ended its turn; the agent's reply woke the wizard with that reply as the
reason, and the revision it saved carried no review id and no
`sidekick_review_revised` line, so the one query that lists what reviews
changed missed it. Content Calendar Refresh's review could not finish: it
asked for eight to eleven continuations in one batch, each of which
refetched every tool output of its run from the payload bucket under a
two-second deadline, some reads timed out and fell back to summaries, the
page's hash no longer matched the first fragment's, and the reader refused
every one as changed evidence though all twelve runs had finished days
before. Two of the three reviews first delegated the reads to agents that
have no run tools and lost a minute each; the wizard was delegating as its
coordination guidance tells every agent to, and reading twelve runs in its
own context would have spent the context its plan and revision need, so the
agents got the reader rather than the wizard losing the delegation. The ids
moved into the reader because an assignment that has to carry them is where
a wrong or missing id enters. The alternative for the marker, a
host rule stamping any revision that follows a delivered review, would have
claimed a person's own edit made an hour later; the conversation's state is
the honest signal. The alternative for the reader, a longer deadline, would
have moved the race rather than removed it; one document per page removes
it.

**Consequences:** `review_id` depends on the authoring conversation's
recent rows, read once per submission. A continuation cursor carries the
tool calls served in full; a cursor minted before this change has none and
is served as a first fragment would be. Pages are remembered per activation,
so a continuation from another activation rebuilds and may refuse where the
first activation would have served.

### 2026-10-26 — The wizard reviews its Sidekick every ten runs, three days apart

**What changed:** A run finish under the accepted revision counts on the
Sidekick's row; ten finishes arm a `sidekick_review` entry due no sooner than
three days after the last request; the entry records a `sidekick_reviews`
row and hands a Queue message to a consumer that admits a Rally-attributed
notice, with the finish counts and a host-picked sample of run ids (failed
runs, then stopped, up to ten; waiting runs up to five; ten completed runs
spread evenly across the window, all under the accepted revision), into the
authoring conversation as queued system input under a delegate who may also
manage the Sidekick. The wizard's guidance says what to do with it: read
exactly those runs with the history tools it already has, sort platform
failures from procedure problems, revise when the procedure is at fault,
never widen what the Sidekick can do, and report to the owner. An accepted
revision resets the count; pause and archive cancel the entry. This overturns the
2026-10-23 entry's "not an automatic improvement scheduler": the tools were
the diagnosis, and the scheduler is what nobody was asking them for.

**Why:** Failures were sitting in run history nobody opened. In the
investigated Organization one event-driven Sidekick had failed 196 of 917
runs, every one a provider returning an empty completion before the first
step; a polling Sidekick had run 3,718 times for a three-hour daily window; a
third took five human revisions in one hour over mention formatting. The
history tools shipped three days earlier for exactly this diagnosis, but only
when a person thought to ask. The two floors are the request's. The three
sample limits (`SIDEKICK_REVIEW_SAMPLE_LIMITS`, 10, 5 and 10) are this
change's own, with no measurement behind them: enough failures to see a
pattern, a few waiting runs, and a spread of completed ones, within what one
wizard turn reads; the team sets them in `hosted-sidekick.ts`.

**Considered and rejected:** A per-run self-report tool or an outcome judge
in the run's settlement lane. Both put model work on every run so the review
could do less, which is backwards: the wizard runs the stronger model, and
the review happens once per ten runs. Letting the wizard pick which runs to
read: a Sidekick that ran a thousand times would be read, or not, at the
model's discretion, and the cost is the host's to bound. Awaiting the wizard
from the alarm instead of the Queue hop: the alarm runs inside the
Organization object, and one cold authoring conversation would hold every
other entry behind it; run provisioning took the Queue for the same reason,
and a hop that fires at most once per three days per Sidekick is not where
that shape costs anything. A central sweep over every Sidekick in the
Organization object: one alarm would serialize every review behind an object
that is already overloaded in that Organization, and has no per-Sidekick
clock. Backfilling the count for existing Sidekicks: with `reviewed_at`
null, each Sidekick's first review follows its tenth finish after deploy, at
its own cadence; a backfilled count would have made that the deploy's
instant for all of them. A host-side check on what a review may save (no
new plugin, trigger or capability; nothing over a person's unfinished
revision): proposed in review and rejected as securing against a case nobody
has seen; the review executes as a managing delegate and the rule lives in
the guidance, where the person's report and revert path cover it. The
review's turn is staged by the prompt, read then plan then act then
publish, rather than by a host state machine: the stages exist to make a
change deliberate and announced, and a prompt is the cheapest place to hold
them.

**Consequences:** The count and `reviewed_at` are the floor's only state;
a new revision resets the count rather than the clock, and only the accepted
revision's runs are evidence. Evidence is host-known columns and a
host-picked sample, never work in the run. The review executes as a
managing delegate and can submit a revision, so the capability rule is in
the guidance. A revision a review submits carries the review's id
(`sidekick_revisions.review_id`, from the turn's reason or the authoring
conversation's state, never from the model), so what reviews changed is one
query. A change is announced where the Sidekick's people are: the
notice carries the conversation to post to (a room's Sidekick's home, General
for an Organization's or the author's Personal Channel when General is
gone, the author's Personal Channel for a personal one), and the wizard
posts there after a saved change and never otherwise. A Channel target made
the conversation tools reach a Channel's own messages for a Sidekick scope,
the first writer of those after merges. The row's visible text is facts; the instruction is in the
model-facing renderer and the standing guidance, so a change to either does
not leave old notices carrying old orders. The product numbers live in
`hosted-sidekick.ts`, and nothing the model reads repeats them.

Shipped in #1447.

### 2026-10-23 — The wizard can inspect its own execution history

**What changed:** Authoring gains read-only, pageable run list/read tools over
the existing hosted run records, canonical transcript reader and durable tool
receipts. They include the original procedure, tool inputs/results/errors,
output references and feedback recorded in the run. Every page rechecks access.

**Why:** The wizard could be asked to repair a failed procedure but could not
see the execution evidence. Shared memory and files are incomplete records, and
the text transcript reader deliberately omits tool results. Reusing authoritative
records avoids a second history store and preserves access and ordering semantics.

**Consequences:** These tools support conversational diagnosis, not an automatic
improvement scheduler. Preserve revision identity, opaque page continuations and
explicit result availability. Reuse the conversation page/character allowances:
large replay payloads must be paged without silent truncation or redundant
representations. Inspection must preserve participant and read state, and
resource revocation applies before replaying historical tool data. Receipt
authority metadata stays private; history cannot grant permission.

### 2026-10-23 — Publication includes its declared tables

**What changed:** Tables and editable metadata now commit in the same transaction
as activation, schedules and registrations. Conflicts name the table and fields
and explain how to reuse its schema or explicitly migrate. Legacy alarms consume
permanent conflicts instead of retrying indefinitely.

**Why:** The old post-activation provisioning tail left Sidekicks active with
incompatible declarations and retried immutable failures (960 and 185 attempts
in the investigated Organization). Hosting brought the tables and Sidekick into
one SQLite authority, so there is no longer a cross-object effect to defer.

**Consequences:** Failed publication preserves the previous accepted revision
and rolls back even earlier declarations in the batch. Keep hashes outside the
transaction and recheck authority fences at commit. A retry ceiling was rejected:
it would delay and hide the same deterministic failure rather than distinguish
it from recoverable storage errors.

### 2026-10-22 — Authoring investigates the workflow and saves the execution procedure

**What changed:** Sidekick authoring follows an ordered setup guide, from scope
and discovery through workflow testing, the runbook, and publication. Executable
work requires reusable discovery and non-destructive validation during setup and
revision. Saved instructions carry the procedure, verified facts, remaining
assumptions, per-run checks, delivery and recovery behavior. Missing required
information and publication refusals have distinct next steps. Tool descriptions
share the same scope, requester and immediate-publication rules.
Instruction-only authoring has its own reusable-guidance path without imposing
triggered-run requirements.
Workflow testing exercises data retrieval and transformation for a representative
result; schema inspection alone does not qualify. Reusable queries and tool
arguments are saved with the method.

**Why:** Authoring and execution can have different reasoning capabilities. A
brief objective leaves each independent activation to rediscover the method and
resolve decisions the wizard could have settled once. Configuration acceptance
checks shape and bindings, so it cannot stand in for validating the method.

**Considered and rejected:** Relying on each activation to reconstruct the setup
conversation's reasoning, or treating a successful submission as proof that the
workflow works. Requiring a full live run during setup would also perform future
deliveries and other effects before their requested time.

**Consequences:** The wizard owns reusable investigation, while each activation
owns current inputs and execution. The wizard records validation evidence without
freezing changing inputs; activations still fetch current data and follow the saved
failure and no-op rules. This is authoring guidance, not a new publication gate.

Pull request: [#1425](https://github.com/juno-ai-labs/avalon/pull/1425).

### 2026-10-22 — Record consent independently of Sidekick ownership

**What changed:** WorkspaceDO stores per-person grants, prepared generations,
withdrawal tombstones and accepted mutation receipts. Every creation enrolls its creator immediately, including autonomous creation.
UI self-service and targeted autonomous agent changes use the same authority.
Agent own-grant discovery retains access to a person's stored grants after they
lose Organization or Sidekick access; the dedicated Account withdrawal UI/API
is removed. Event, schedule, manual and continued runs
share eligibility; each run persists its coordinator independently of legacy
human access. Migration retains stable shared-file identities and enrolls missing creators
without reconstructing direct-user consent provenance. Continuation replaces an
unavailable coordinator and persists the replacement without changing human
access. Write accounts remain debug-only receipt records; reads skip account
checkpoint I/O. Background model/tool boundaries reuse activation eligibility and
retain only the root lifecycle and stop-generation check. Coordinator selection
short-circuits preferred users and narrows candidates by audience. Matching shares
pending eligibility within one request; delegation-list identity/eligibility
reads run together. Details omit the unused derived delegation status. Delivery
also enforces reconciled registration state/cutoffs, preserving existing
occurrence replay without admitting historical work after reactivation. Self-action
receipt inspection prevents the outer completed-tool cache from presenting a
withdrawn grant as current without replaying its mutation. Interrupted actions
are reconciled by that same receipt instead of minting a fresh consent intent.
An activation's refused conversation post also records a fixed recovery message
in the same attention field, without adding a separate notification mechanism.

**Why:** A mutable run-as user cannot represent several people's consent or
independent withdrawal. Reusing that field for automatic coordination would also
change existing human access. A durable prepared generation prevents response
loss or delayed dispatch from turning an old allow into a new opt-in. A global
authorization barrier is unnecessary because eventual authorization propagation
is the agreed product contract. Repeated background eligibility scans and account
checkpoints for reads would add durable work to every step without helping
uncertain-write recovery. Recomputing unused detail status and repeating matching
checks likewise adds work without changing the product outcome. Checking only
the Sidekick-wide event cutoff ignored source removal/reactivation, allowing
delayed envelopes to admit work after the reconciled source boundary moved.
A blocked report must also remain visible after the model finishes explaining
it, since an attempted post is not confirmation that anyone received it.

**Considered and rejected:** Reusing directory run-as as the consent list would
couple execution selection to human reader/manager rights. A global revocation
sequencer or per-operation provider preflight would add latency for synchronous
enforcement beyond the agreed eventual-consistency contract. Consent-write
ordering belongs in the one existing owning object.

**Consequences:** Execution consumers use these grants without deriving
human access from selected accounts. Migration and creator initialization cannot
overwrite tombstones. Recovery stays within the current Organization; the unused
regional routing index no longer participates. Consent remains in WorkspaceDO.
Configured sources expand only through authored
portable resource identity; differential registration updates preserve queued
event boundaries. Ordinary connection, membership and reach invalidations wake
reconciliation through the existing alarm lane, with no provider preflight.
The 2026-10-23 revision removes manager removal, creator disclosures and
direct-human restrictions at the user's request; targeted agent writes may
manage any current Organization user. Withdrawal ordering remains intact.

Related: [Sidekick delegation PRD](PRDs/2026-10-22_sidekick-delegation/prd.md).

### 2026-10-22 — Keep Sidekick actions discoverable across lifecycle states

**What changed:** Pause/Resume, Run now, Run history and timing stay visible.
Unavailable actions explain their constraints on hover or keyboard focus and
do not execute. Empty timing has an explicit message, including an email-trigger
summary for older definitions. The “Make it work for you” guidance is removed.

**Why:** The product request favors a consistent profile where people can see
which actions exist and learn why they cannot use them. The prior conditional
controls changed the screen's shape and hid those explanations; the extra
guidance section repeated the conversation's editing role.

**Considered and rejected:** Hiding unavailable controls preserved the earlier
minimal profile but made capabilities harder to discover. Natively disabling
explained controls would remove them from the keyboard path to their tooltip.

**Consequences:** Visibility no longer implies availability. Hosts must preserve
the lifecycle/runnable guards, block unavailable callbacks, and keep disabled
explanations reachable by keyboard. Execution admission remains authoritative.

PR: [#1409](https://github.com/juno-ai-labs/avalon/pull/1409).

### 2026-10-22 — Scoped Sidekicks start in their home's color

Scoped Sidekicks start in their home's color because deriving a color from
the new Sidekick's id gave them an unrelated visual identity. The creation-time
copy leaves later edits independent. Reading the canonical Channel color avoids
freezing a delayed conversation projection's old color into the new Sidekick.
Without a placement, missing or invalid home appearance uses the shared generated
default; an invalid appearance reports the rejected field without blocking creation
or replay.

### 2026-10-22 — Register missing external sources during event setup

**What changed:** The Sidekick wizard can register a provider-verified external
file through its authorized source plugin and use the returned Rally ID in an
event rule. Registration reuses the existing canonical resource operation and
its results survive authoring receipt replay. The connection's required grants
and identity are checked atomically with the write. Change-triggered setup uses
the registration/event procedure; explicit schedules are preserved.

**Why:** The calendar experiment found the right Sheets event but could not
register its source. The coordinator offered registration as a user choice even
though answering could not supply the missing operation. More prompting alone
could not remove that capability gap. The tool closes it without inventing IDs,
loosening access, or treating routine setup as a preference question.

### 2026-10-22 — A room archive archives its owned Sidekicks

**What changed:** Archiving a Thread or a Sidekick's home Breakout invokes the
same Sidekick archive primitive as an explicit archive, for drafts, active and
paused Sidekicks. Runs stop, schedule and run alarms are cancelled, registrations
are cleared, and the retained Sidekick becomes inaccessible. Channel archives
inherit this behavior for their exclusive Threads. Restoring a room never
reactivates its archived Sidekicks. The Channel, Thread and Breakout archive
dialogs describe the cascade and that restoring the room does not restore its
Sidekicks.

**Why:** Archiving a place should archive the delegated work it owns. Pausing
left those Sidekicks retained as live product objects and allowed restoring the
room to restart them, which conflicts with the requested archive behavior.

**Considered and rejected:** Archiving every attached workspace Sidekick would
also stop work used by unrelated conversations. The cascade follows ownership;
shared attachments and Sidekicks in shared Threads that remain active survive.

**Consequences:** The archive fan-out and explicit archive share one synchronous
transition, including the execution stop fence and trigger cleanup. Replays
cannot increment the stop fence again or restore a tombstone. Definitions and
run history remain stored under the existing archive retention policy, and no
Sidekick unarchive operation is introduced. Thread common snapshots retain an
archive generation across restore, and Breakout registry archival commits the
cascade locally; out-of-order effects cannot discard this permanent work.
Restore notices reconcile legacy room archive markers rather than clearing
them, and pause/resume re-read lifecycle after their authorization await.

### 2026-10-21 — Authoring has its own model and preserves activation prerequisites

**What changed:** The wizard uses the independent `sidekick_authoring` model route,
defaulting to Sol. Its prompt loads the event-selection procedure for external
changes, recommends a better event binding without replacing requested schedules,
and saves recovery and shared-table access steps. The wizard and activations
share one Terminal sandbox while their conversations remain independent.

**Why:** Authoring has to resolve capabilities and hand off executable instructions,
not merely produce a plausible schedule. The content-calendar experiment skipped
resource resolution and relied on files in its creator's sandbox. Raising the
wizard's model alone would leave the same implicit handoff; the saved definition
must explain how the next run finds its files and shared state, including
recovery after the shared sandbox is reset or expires.

### 2026-10-21 — Receiving conversations show live Sidekick activity

**What changed:** Each receiving composer shows a count of its running Sidekicks,
including setup, manual, and triggered executions, through one activity read and
the existing Organization socket's target-scoped count snapshots.

**Why:** A Sidekick can work in its own conversation while posting to another,
leaving that receiving conversation looking idle. Lifecycle summaries cannot
answer whether setup or a run is currently executing.

**Considered and rejected:** Opening a socket per Sidekick or polling its run
history. The Organization already holds the accepted child projections and can
answer the activity question without transferring history or adding connections.
Reusing the full automation-list push would refetch unrelated Sidekick surfaces
on every setup turn. Invalidating a REST count would spend a second round trip
on data the socket owner already holds. Activity therefore pushes counts only
to the composers watching them and leaves the directory waterline unchanged.

**Consequences:** Association and target visibility decide where activity may
appear; live execution decides whether it appears. Concurrent executions count
once per Sidekick, and background agents retain their own independent row.

Pull request: [#1399](https://github.com/juno-ai-labs/avalon/pull/1399).

### 2026-10-21 — Background workers under a Sidekick are not run continuations

**What changed:** Input activation distinguishes delegated workers by their
persisted `background_agent` identity. Run-rooted workers obtain approval against
their root run and carry an authority-only delegation reference through every
model/tool check. Authoring-rooted workers retain ordinary background activation.

**Why:** The daily organization activity Sidekick delegated scans to eleven
workers that never executed. Activation treated every non-main child under an
automation parent as a Sidekick run, looked up each worker ID in `sidekick_runs`,
and refused its assignment with `run_not_found`. The coordinator kept waiting
for results while doing only its own scans.

**Considered and rejected:** Continuing any child whose run lookup returns
`run_not_found` would also activate genuine runs whose authority record is
missing. The existing background identity distinguishes the two without relaxing
the run check or adding another stored classification.

**Consequences:** Real Sidekick runs still require continuation approval, including
pause, deletion and run-as checks. Workers keep their own instructions and
inherited principal; a run-rooted worker and its descendants also remain fenced
by their root run's consent and stop generation. Skipping every Sidekick check
for background workers would let paused runs continue through delegated work.
The workerd suite covers startup and follow-up input beneath both origins,
paused queued assignments, nested workers and revocation at model/tool boundaries.

Pull request: [#1386](https://github.com/juno-ai-labs/avalon/pull/1386).

### 2026-10-19 — Authoring checks connected alternatives before declaring a missing capability

**What changed:** Sidekick authoring and polling guidance explicitly compose
Drive + Docs with Mail + Calendar for Meet-note follow-ups, prioritizing a direct
read of the event's attached Doc before Drive search or a blocked conclusion.

**Why:** The authoring agent left a workflow inactive after inspecting only the
Mail preset, despite a connected Drive preset that could provide the notes.
A Calendar attachment already identifies the transcript; discovery first can
miss it or select an unrelated document with a similar title.

**Considered and rejected:** Treating a provider-named preset as the whole
provider's capabilities defeats the connector-neutral composition model.

**Consequences:** The agent must inspect relevant authorized plugins and choose
an actual notes source event or polling. It must still verify note access and
must not infer that an invitation proves a conversation occurred.


### 2026-10-16 — The membership-checking Sidekick directory read is gone

**What changed:** `WorkspaceDO.listSidekickDirectory` is deleted. This
supersedes the 2026-09-28 entry's advice that a caller unable to vouch for
membership "uses `listSidekickDirectory`": no such variant exists now, and the
Bind `verify_membership` path that entry cites was removed in
juno-ai-labs/avalon#1245.

**Why:** Its last production caller, the agents plugin's `sidekicks_list`,
moved to `listSidekickDirectoryForAuthorizedMember`, which the library route
already used. Only tests still called it, so they exercised a path production
never takes.

**Consequences:** Every caller of the directory read must prove active
membership before it asks: the route through session authentication, the
agents plugin through Bind's per-command check. A new caller that cannot must
check membership itself rather than restore a second entry point.

Shipped in juno-ai-labs/avalon#1251.

### 2026-10-15 — A room changes Sidekicks only through their authoring agent, and a thread-owned Sidekick names its thread

**What changed:**
- `submitDraft` keeps only the authoring conversation's path. The room branches
  that created a room-owned Sidekick on first submission, or edited one the room
  owned, are gone, since a room's tool list never carried `submit_draft`.
- In a room, `sidekick_sidekicks_list` returns only `workspaceSidekicks` with
  `canAttach` and `attached`. It no longer reads the room's owned definitions
  or reports `canEdit`. The drafting plugin's guidance dropped its room sentence
  and names `sidekick_sidekicks_list` where it means it.
- `AutomationSummarySchema` gained `owningThread` (id, title, appearance),
  filled by the library list and the detail. The library row and the header's
  scope badge show the thread's glyph and title as a button that opens it,
  through a new `openThread` bridge method; without it they still say "Thread".
  The library row's link moved from the whole card to the title, stretched over
  the card in CSS, so the thread's button is not inside an anchor.

**Why:** A thread's agent rewrote another thread's draft Sidekick, and the
person could not see which thread owned it. Two lists told a room what it could
change, by two rules: `canEdit` here, and ownership in the agents plugin's
`sidekicks_list`. A room changes a Sidekick only by messaging its authoring
agent, so one rule now decides that, enforced where the message is admitted
([`agent-communication.md`](agent-communication.md)). The unreachable room
branches held the only server-side ownership check, which made it look
enforced. "Thread" on the library did not say which one, and the Sidekicks
window is a separate window, so there was no way from a Sidekick to its room.

**Considered and rejected:** Fetching each thread from the client, which costs
a request per row on a surface that should open at once. Gating the thread name
on the reader rule's `homeAdmits`: for a Breakout-homed Sidekick it admits a
Breakout member who may not be in the parent thread, whose title the label
would then reveal and whose link would not open. Participation is a local read
and never names a thread the reader cannot open.

**Consequences:** `canEdit` means one thing wherever a model reads it: whether
this conversation may change that Sidekick. A room that needs a Sidekick's
definition asks its authoring agent. An author who has left the thread still
lists their Sidekick but sees "Thread", and an archived thread is not named.
The rail's `WorkstreamAutomationSummarySchema` omits `owningThread`, as it
omits the owner.

Shipped in juno-ai-labs/avalon#1245.

### 2026-10-06 — A run's loop may act while its row still reads `pending`

**What changed:** The check a Sidekick run's loop makes before it acts
(`readRunAuthority`) accepts a `pending` run as live, as well as `running` and
`needs_input`.

**Why:** Since provisioning moved to the activity Queue (#1106), the consumer
starts the run's loop and only then reports the run running. A loop that
started quickly checked in between and was refused with "This automation run is
no longer running". In production the GitHub PR Firehose Sidekick's run for a
newly opened PR failed this way, 222 ms before the report landed, with no model
call made.

**Considered and rejected:** Reporting the run running before starting the
loop. A loop start that then failed would leave a `running` row the resend
never revisits, since it re-sends only `pending` runs.

**Consequences:** `pending` means "admitted and not stopped": only provisioning
starts a run's loop, and a pause or delete moves even a pending run to
`stopped`, which the check still refuses. A new run state must be classified
here as live or not.

Shipped in [#1111](https://github.com/juno-ai-labs/avalon/pull/1111).

### 2026-10-05 — A Sidekick lives in its Organization object

**What changed:** Every Sidekick's definition, revisions, schedules, runs and
receipts moved from its own `SidekickDO` into its Organization's `WorkspaceDO`
([`hosted-conversation-parents.md`](hosted-conversation-parents.md) owns the
mechanism and the import). Its directory row is its definition row. A run's
conversation is opened by a Queue consumer the run's alarm entry sends to,
not in the alarm. `AutomationService` no longer asks whether the caller is in
the owning room; the Sidekick decides, from the Organization's rows: a room
Sidekick is managed, and its detail read, by whoever may manage the room, and
viewed and listed by the room's participants.

**Why:** See the PRD (`docs/PRDs/2026-10-03_sidekick-parent-into-workspace-do/`).
The two access rules are the ones the Worker and the object applied between
them before the move; the port briefly used the participant rule for both,
which refused a member a grant had made a manager.

**Consequences:** A caller passes who is asking and nothing it concluded about
them. Provisioning a run is idempotent on the run id and may run more than once;
its report, `sidekickRunProvisioned`, is what ends the resends.

### 2026-10-02 — The sidebar no longer shows Sidekicks

**What changed:** The Sidekick strip above the account row is gone, with its
tiles, its **New Sidekick** slot, their tooltip and the sidebar's `automations`
prop. The library opens from the account menu, and a Channel's Sidekicks are in
its title menu.

**Why:** The redesigned sidebar is one list of Channels under the Space pills,
and the strip was the one thing below that list. It was asked to go so the
sidebar reads as light as the design it follows. Nothing became unreachable:
the account menu already opened the same library window.

**Consequences:** `SIDEKICK_RUNNING_MARKER` and the hexagon marker now draw
only where a Sidekick's glyph appears outside the sidebar. A future surface that
wants Sidekicks in navigation should be a Space or menu entry, not a return of
the strip's fixed slot.

### 2026-09-28 — The Sidekick library checks membership once, at authentication

**What changed:** `AutomationService.listSidekicks`, behind `GET /sidekicks`,
calls `WorkspaceDO.listSidekickDirectoryForAuthorizedMember` instead of
`listSidekickDirectory`. The object no longer re-reads the caller's
`workspace_members` row from D1; it still filters every row by scope,
authorship and room participation.

**Why:** Production measurements on 2026-09-27 put the list at a median of
1 s, and it checked access twice. Session authentication joins the caller's
active member row (with its incarnation) before the handler runs, and the route
requires a role, so a guest never reaches it; the object then asked D1 the same
question again from wherever it runs. The other two callers hold equally
verified contexts: Sidekick recommendations read the relationship themselves,
and demo readiness builds its viewer from `demoMemberAuth`. Who sees what is
unchanged — the object's own check was the weaker of the two, since it ignored
the incarnation and admitted guests.

**Considered and rejected:** Keeping the object's check and dropping the
request's. Authentication cannot be skipped for one route, and the object's
check is the one that answers less.

**Consequences:** `AutomationService.listSidekicks` must only be constructed
with an `AuthContext` whose membership was proved in the same request. A caller
that cannot say that uses `listSidekickDirectory`, as the Bind
`verify_membership` path in `agent-communication-service.ts` does.

### 2026-09-28 — A Channel's Sidekicks ride its rail, under a shared audience predicate

**What changed:** A Channel's owned, recommended and attached Sidekicks are
answered from `automation_directory` as part of its rail on the Organization
socket, and the audience `SidekickDO` applies to a skill read moved to
`sidekick-audience.ts`, which the rail calls too. The reasoning is in
[`hosted-conversation-parents.md`](hosted-conversation-parents.md#changelog).

**Why:** The rail's first draft copied the predicate and drifted from it within
the pull request (the name fallback and the run-as handling).

**Considered and rejected:** Reading each summary from its `SidekickDO`, as
REST does: a hop per Sidekick per Channel, multiplied by a Space prefetch.

**Consequences:** A change to who may see a Sidekick is made once, in
`sidekickAudienceAllows`. A field the rail shows must be on the directory row
and in the rail triggers' column lists, or the rail will not notice it moved.

### 2026-09-27 — Sidekick runs continue from input, and post to a home conversation with the conversation tools

**What changed:** Input to a run child continues the run: `continueRun` hands
the loop the run's context at the accepted revision, or refuses with a code
that lands the input instead of holding the queue. Only an accepted, newer
child projection moves the run row, so a run reopens and completes more than
once.

A room Sidekick's home is `owning_workstream_id` plus a new
`owning_substream_id`, so it can be the Breakout it was set up in; every reader
of the owner reads both, and archiving a home Breakout pauses the Sidekick.
Conversations can be attached from the configuration conversation. `post_result`
is gone: a run posts with `conversation_post`
([why](conversation-tools.md#changelog)).

**Why:** A reply in a thread a run started, or an answer to its question,
started a generic loop as the sender with no Sidekick definition, and the
parent ignored every state after a finish.

The Northstar weekly call prep flow needs a Sidekick whose runs leave work for
each other in the Breakout where it was set up.

**Considered and rejected:** Reopening the row in `continueRun`; it stays a
read, and the child's projection stays the row's one writer. That projection
lands after the continued run checks its authority, so the check accepts the
finished row, fencing a pause on a stop counter; a wall-clock fence was
rejected in review because a pause on the approval's millisecond passed it.

Replacing `owning_workstream_id` with a conversation address, which would
rebuild two tables whose `CHECK` constraints name it. Reusing
`parent_sidekicks` or `sidekick_attachments` for attachments: loading a
Sidekick as a skill writes those, which would grant it every conversation that
ever used it.

**Consequences:** A run's activations may read different revisions but never
run as a different person (`run_principal_changed`). A parent-side write of
`completed` or `failed` to a run row must be fenced as `stopped` is.

Anything that asks "who is this Sidekick's room" must read the substream too.

Shipped in #1006. Design: [`docs/PRDs/2026-09-23_external-conversation-bindings/design.md`](PRDs/2026-09-23_external-conversation-bindings/design.md).

### 2026-09-25 — The setup chat chooses a Sidekick's icon and color

**What changed:** `submit_draft` requires `icon` and `color`. The icon is an
exact key from the Channel icon catalog, with each key's drawing description
rendered into the field; the color is one of the fourteen ring colors the picker
offers, or the Sidekick's current color when that is `black` or a retired one.
They ride beside the draft, not inside it, and `submitDefinition` writes them
to `automation.appearance_json` alongside the title, unless they repeat the
last appearance the chat knew of. Migration 9 adds `chat_appearance_json` to
hold that. `sidekicks_list` now returns each Sidekick's current appearance.

**Why:** The chat named a Sidekick but left its look to the id hash, so a new
Sidekick's hexagon said nothing about what it does until somebody opened the
picker. Channels already get a chosen icon from the naming pass; Sidekicks now
choose from the same list, so Channels, Breakouts and Sidekicks share one icon
library and one set of descriptions.

**Considered and rejected:** Putting the two fields in `AutomationDraftSchema`.
That schema also parses every stored revision, so a required field there would
fail on every revision written before it, and the appearance is not part of a
definition anyway: a person changes it from the picker without a revision.
Writing only when nothing is stored, as the Channel naming pass does, was also
rejected: that pass has no person's intent behind it, while the chat does, and
"make it red" has to work. No fallback icon is named to the chat; the catalog
carries descriptions only. Limiting the tool's color to the ring was rejected in
review: a Sidekick wearing a retired color could not echo it, so every edit
would have overwritten it.

Writing every submission was rejected in review: nothing makes the chat
re-read `sidekicks_list`, so a revision copying its own earlier call would
undo a person's pick made since. Carrying the current appearance in every tool
result was also considered; it narrows the window but still trusts the model
to use the latest view, where comparing against the chat's own last value in
the object does not.

**Consequences:** A person's pick survives any submission that repeats what
the chat asked for before; only a value the chat has not submitted replaces
it. The comparison is of serialized JSON, so both writers must keep producing
`{icon, color}` in that key order, which the two schemas' shapes do. Adding an
icon key means adding its description, which the exhaustive `Record` already
enforces.

### 2026-09-22 — Empty rooms keep the Sidekicks heading

**What changed:** Both room rails now retain the shared **Sidekicks** heading
while the merged owned, attached, and recommended lists are pending or empty.
Existing rows and the failed-read **Refresh** action are unchanged.

**Why:** Sidekicks are a standing collaborator category beside Participants,
not a section whose identity should appear only after its first row. Keeping the
heading stable also prevents the rail from shifting between loading, empty, and
populated answers.

**Considered and rejected:** An empty-state row was unnecessary; the persistent
heading supplies the requested structure without spending more rail space or
inventing copy.

**Consequences:** `SidekickSection` always renders its section shell. Its callers
must still distinguish `undefined` from `[]` even though neither state renders a
row, because only the latter is an authoritative empty answer.

### 2026-09-21 — Stale Sidekick reads recover through a row

**What changed:** A failed Sidekick read now keeps every row that did arrive
and inserts the shared **Refresh** row. When none arrived, the Sidekicks heading
and Refresh row remain as the recovery path. Neither case writes stale-data or
load-failure copy into the sidebar or inspector rail.

**Why:** A transient read state is not navigation content. Presenting it as an
ordinary recovery action keeps the rail structurally stable and gives the user
the one useful next step without leaving a warning behind.

**Considered and rejected:** Keeping stable “out of date” copy beside the rows
was rejected because persistent navigation made that operational state look
like another item in the room. Replacing the known rows with an error state was
also rejected because a partial read does not invalidate data already received.

**Consequences:** Every rail that renders `SidekickSection` must supply the
refresh callback when it can report a load failure, and row composition must
continue using cached query data after a failed refetch. Action failures remain
separate because they require acknowledgement of a specific attempted change.

PR [#919](https://github.com/juno-ai-labs/avalon/pull/919).

### 2026-09-17 — A connector event admits under the occurrence its connector named

**What changed:** `admitExternalEvent` keys the run on `occurrence:<key>` when
the delivery carries the occurrence the connector named, and on
`external:<workspaceEventId>` otherwise. The key is a field of the normalized
activity that adapter code sets; the workspace store drops a same-named key
from provider metadata at ingest and lifts only that field onto the delivery.

**Why:** Granola reports one note twice, as a share and as a generation, and a
Sidekick on "Transcript added" must run for the note once. The fuller entry,
with the Granola behaviour behind it and the alternatives rejected, is in
[`connectors.md`](connectors.md#2026-09-17--a-note-shared-into-the-workspace-after-it-was-generated-is-a-transcript-added).

**Considered and rejected:** Reading the key out of the event's metadata. The
generic webhook copies a caller's metadata whole, and the key a Sidekick dedupes
on is not a caller's to pick. Also rejected: one key space for both, where a
connector naming a bare id could collide with another event's.

**Consequences:** Every trigger still converges on `occurrence_key` with
`INSERT OR IGNORE`; a named occurrence delivered twice answers with the run it
already made, like a redelivery.

PR [#807](https://github.com/juno-ai-labs/avalon/pull/807).

### 2026-09-17 — Separate conversation Sidekick use from authoring access

Guest conversation rails now use source-owned summaries and exact conversation
admission. Recommendations include inherently recommended owned Sidekicks; local
loads persist and can be removed within the granted child. A guest-triggered
run uses ordinary user attribution and the existing skill-loading runtime.

The previous list path opened the source's authoring detail and the recommendation
path opened Main. Either coupling required granting unrelated history to a guest
shared into one child. Source audience policy is now shared between minimal
metadata and instruction reads, while new guest discovery follows existing
recommendation/ownership/local-load relationships. Broad workspace discovery and
copying Main's loaded state into a child were rejected. Parent management is
checked by the canonical parent grant, including AutomationService's actor
resolution. The directory locates the owner but its projected Main roster cannot
substitute for current management authority. Source history remains a separate
permission, and recommendations still do not auto-load. Guest candidate selection
uses one recommended-or-loaded helper. A run shares its recommendation read with
initial skill discovery, and management choices load only when controls open;
ordinary transcript updates must not fetch a management catalog.

### 2026-09-15 — The empty Sidekick slot stays visible until an active shortcut occupies it

**What changed:** The sidebar shows its dashed **New Sidekick** tile whenever
the loaded Sidekick directory has no active personal or workspace Sidekick.
Draft, paused, and workstream-owned Sidekicks still do not become shortcuts,
but they no longer suppress the empty-slot action and leave this part of the
sidebar blank.

**Why:** The strip is a visual slot for active standalone Sidekicks. Basing its
empty state on whether any Sidekick record existed made a draft count as though
it occupied that slot even though drafts are deliberately filtered from the
strip. The result was neither a shortcut nor an action. The slot's own occupancy
is the smaller and more legible authority for whether to show its empty state.
The same rule deliberately applies to a paused-only workspace: the tile names
the empty active-shortcut slot, not the absence of every Sidekick, and a blank
slot was judged less useful than keeping the library entry point available.

**Consequences:** The tile remains absent while the directory is loading and
disappears as soon as one active standalone Sidekick can occupy the strip.
When a personal draft already exists, the tile resumes the most recently
updated one rather than routing through `/sidekicks/new` and multiplying
abandoned drafts. A workspace draft is not a resume candidate because the
directory summary proves visibility but not whether this viewer may manage it;
with only workspace drafts, paused, or workstream-owned Sidekicks the tile still
opens `/sidekicks/new`. This reverses the stricter record-existence rule
documented by the 2026-09-10 **The empty strip makes the first Sidekick** entry
below.

### 2026-09-15 — Recommend Sidekicks across a workstream

**What changed:** Workspace Sidekicks can be attached through the rail or agent
tools. Those links and Workstream ownership add a Recommended catalog badge in
every substream. Each substream independently persists its loaded Sidekicks.

**Why:** People and agents need a shared way to nominate relevant knowledge
while each conversation chooses when to load the instructions. The existing
ownership relation and one small attachment table compose those behaviors.

**Consequences:** Recommendations affect future executions. Removing a workspace
recommendation also clears its loaded attachment in the current substream.
The service checks parent and local participation before removal; management
tools are withheld from workspace-principal runs. Empty skill catalogs do not
wake recommendation authorities just to intersect their results with nothing.
The existing `automations` sync topic also refreshes recommendation queries;
publication belongs in the common service because agent tools bypass REST
middleware and otherwise leave other windows stale.
Hidden agents use their durable execution identity for the same commands because
their child conversations intentionally have no human viewer admission. That
exception stays host-only and clears only the executing child's local attachment.

### 2026-09-15 — A rule can name Fireflies

**What changed:** `fireflies` is added to `ConnectorTypeSchema`, and a test in
`apps/api/test/connector-activity-trigger-vocabulary.test.ts` asserts that every
connector manifest declaring an activity trigger is accepted by it.

**Why:** It was the only connector with activity triggers missing from that
enum, so `ExternalEventRegistrationProjectionV1Schema` rejected every Fireflies
registration at `evaluators.0.source.connectorType`. The projection is built
from `connection.connector_type` verbatim (`sidekick-do.ts:1880`) and
`prepareApplication` returns it as `unknown[]`, so nothing typed the value on
the way out and the rejection happened at the far end of the RPC hop.

The visible behaviour was a Fireflies Sidekick that accepted, showed as
published, and never fired. `lifecycle` and `accepted_definition_revision`
commit in the accept's own transaction; registrations are written afterwards by
`applyEffects`, which threw here on every attempt. Scheduled alarms have no
retry ceiling, so it retried indefinitely against a deterministic failure while
`meeting.summarized` arrived, normalized, committed, and matched zero
destinations. The entry above made that failure readable; this is what it
turned out to say.

`TELEMETRY_CONNECTOR_TYPES` already listed `fireflies`. Two spellings of the
registry's membership live in the same package, and the connector was added to
one of them.

**How it is proved:** The test builds the fully-configured registry and lists
the connectors that declare an activity trigger but are not nameable in a rule.
Removing `fireflies` from the enum fails it with
`expected [ 'fireflies' ] to deeply equal []` — the connector by name, which is
the whole diagnosis. It also asserts `unconfiguredConnectorTypes` is empty, so a
connector missing from the fixture cannot pass by never being built.

**What a future change has to respect:** a connector that declares no activity
trigger is deliberately not required in the enum — it can never produce an event
for a rule to match. The test encodes that, so widening it to every connector
would be adding vocabulary for nothing.

**Considered and rejected:** deriving `ConnectorTypeSchema` from
`TELEMETRY_CONNECTOR_TYPES`. It is the wrong authority — it is a telemetry
dimension whose membership answers a different question, and it already
contains `custom_mcp`, which has no activity triggers. The manifests are the
authority, and `@rally/contracts` cannot see them, so the link is a test rather
than a derivation. Also rejected: typing `prepareApplication`'s `evaluators` as
`ExternalEventEvaluatorV1[]` so this failed at compile time. It is the right
shape and worth doing, but it changes an apply path on the strength of a
diagnosis made minutes ago; the guard that fails in CI is the cheaper half and
does not.

Shipped in #765.

### 2026-09-14 — Sidekicks configure themselves through their authoring conversations

Long setup work must leave Rally's coordinating conversation available. Creation
establishes a minimal Sidekick and communication supplies its instructions;
only its authoring agent receives drafting tools. Discovery prefers reuse within
the current workstream. The authoring prompt names its identity and uses the
already selected scope, while existing publication and scope validation remain
authoritative. Returning questions and saved results through the same message
primitives avoids a second setup protocol or an unavailable elicitation form.

### 2026-09-14 — A publication that cannot parse says which field it choked on

**What changed:** `applyExternalEventRegistrations` parses its input through
`parseRpcInput` (`apps/api/src/lib/rpc-input.ts`) rather than
`Schema.parse`. On a rejection it throws a plain `Error` whose message is
`<schema>_invalid:<path>:<code>` for the first three issues, capped at 120
characters.

**Why:** A `ZodError` does not survive a Durable Object RPC hop. The serializer
reduces it to a bare `Error` carrying no `issues`, no derived message and not
even the name, so the calling object logs the bare word `ZodError` and
stops.

That was not a cosmetic loss. A Sidekick's registrations are written only by
the publication tail — `applyEffects` → `replaceRegistrations` → this RPC — and
in production a malformed projection made that hop throw on every attempt. The
alarm has no retry ceiling, so it retried forever; the Sidekick meanwhile
showed as published, because `lifecycle` and `accepted_definition_revision` are
committed in the accept's own transaction and nothing a reader sees consults
`applied_effects_revision`. The visible symptom was a workspace Fireflies
connection delivering `meeting.summarized` correctly and matching zero
destinations, with `sidekick_scheduled_alarm_failed ZodError` as the only
evidence — which names neither the field, nor the schema, nor which of the
handler's several parses failed.

Issue paths and codes are schema shape, not member data; `errorHandler` already
draws that line when it records `validation_issues`, so the same line is drawn
here and values are left behind. The message stays inside the character class
`scheduledAlarmErrorCode` requires, so the operator notice at the third attempt
carries the code rather than degrading to `handler_error`.

**How it is proved:**
`apps/api/test-workers/external-event-rules.test.ts` sends a malformed
projection through a real WorkspaceDO RPC hop and asserts the rejection names
`external_event_registration_projection_invalid` and `evaluators.0.source`.
Restoring `Schema.parse` fails it with `expected 'ZodError' to contain …` —
the production symptom exactly, which is what makes the test worth having on
real workerd rather than against the schema.

**What a future change has to respect:** the Sidekick showing as published
while its registrations are missing is still true, and is not fixed here. This
change makes that state diagnosable in one log line; making it visible — a
Sidekick whose `applied_effects_revision` trails its accepted revision should
not read as healthy — is a change of its own.

**Considered and rejected:** widening `reportScheduledAlarmAttempt` to unpack a
Zod issue list. There is nothing left to unpack by the time it runs; the issues
are gone at the boundary, which is the only place they still exist. Also
rejected: moving every DO RPC entry point onto `parseRpcInput` in this change.
The primitive is there for the next one to adopt as it is touched; converting
some hundred call sites blind is how a diagnostic fix becomes a risk.

Shipped in the pull request for this change.

### 2026-09-14 — A connection advertises only the events its scope can receive

**What changed:** `connectorActivityTriggerDescriptors` takes the connection's
scope and returns `[]` where the connector's events cannot arrive in it, from
the new `activityConnectionScopes` declaration described in
[`connectors.md`](connectors.md#activity-ingestion). The drafting catalog
carries `activityRequiresScope` beside the emptied list, and the three
discovery tools and `set_evaluator_rules` turn it into one sentence naming the
scope a connection needs. `set_evaluator_rules` refuses a rule on a
scope-blocked plugin outright, on the plugin rather than the event: a rule that
names an event type outright is not otherwise checked against the catalog at
drafting time, so without it the draft was accepted and the automation was
silent for good.

**Why:** A personal Granola or Fireflies connection advertised its connector's
full trigger set while `normalize` refuses any connection that is not
workspace-scoped, so the events were ones it could never receive. The model saw
`scope: "personal"` beside four healthy triggers, built the Sidekick on them,
and nothing in the product distinguished the silence that followed from a
Sidekick with nothing to do yet. The first fix was the filter alone, and it
moved the failure rather than removing it: a count of zero is what a drafting
model reads as "this connector has no events", and the next thing it reaches
for is a timer that runs forever and never does the thing it was asked for. The
refusal has to name the scope, because that is the only correction the model
can act on.

**Consequences:** An existing Sidekick bound to a personal connection of one of
these connectors is refused at accept instead of applying and going quiet;
it never fired, so the refusal is the first honest answer it has had. A
connector that later delivers events to personal connections declares it once,
in its adapter, and both surfaces follow.

### 2026-09-14 — `matching` is the model's spelling; `all` stays the stored one

**What changed:** The external-event predicate now has two schemas.
`ExternalEventPredicateV1Schema` is the stored one and still spells its
conjunction `all`, unchanged. `ModelFacingExternalEventPredicateV1Schema`
spells it `matching` and is a `transform` onto the stored one; it is what
`DraftExternalEventEvaluatorV1Schema` uses, and therefore what
`set_evaluator_rules` advertises. `always` and the `allOf` field name are
untouched on both sides.

**Why:** `all` and `always` sat next to each other and read as near-synonyms —
`all` means "every one of these leaves holds", `always` means "every event of
this type". A model authoring this grammar has nothing to separate them, so the
ambiguity landed in real rules rather than in review comments. But the
discriminant is also *stored*, and Worker versions deploy gradually and can be
rolled back, so a version serving beside or after this one must be able to read
anything it writes. Renaming the stored spelling would have written rows the
previous version cannot parse — the same silent outage as the reverse, arriving
by rollback instead of by migration. Confining `matching` to the model's side of
the boundary buys the legibility with no stored change at all, so there is no
compatibility window to manage and nothing to migrate later.

**How the two stay apart:** `z.toJSONSchema(…, { io: "input" })` renders a
transform's *input*, so the tool offers `matching` and never `all`; parsing
yields its *output*, so every reader and every column sees `all`. The stored
schema does not admit `matching` at all, which is what makes "a `matching`
reached a column" a parse failure in a test rather than a row nobody notices.
`packages/contracts` and `apps/api/test/external-event-evaluator.test.ts` pin
both directions.

**Considered and rejected:** renaming the stored discriminant with a
`preprocess` accepting the legacy `all`. It reads as the conservative option and
is the opposite: the parse canonicalizes to `matching` and the writers persist
whatever they parsed, so the first accept under the new version rewrites
`definition_revisions.evaluator_rules_json`, `automation.evaluator_projection_json`
and `workspace_external_event_registrations.evaluator_json` into a spelling the
previous version refuses. Three columns rather than the two an earlier draft of
this entry named: the projection is written from the parsed set in `apply`, and
replayed by the `sidekick_publication` alarm and by `resumeFromPause`, both of
which reach `applyExternalEventRegistrations`. Also rejected: keeping that
design and translating back to `all` at each write, which leaves three
boundaries that must each remember to, and a fourth that will be added later
without.

**Consequences:** `matching` exists in exactly one schema and must not spread;
anything reading a predicate compares against `all`. A future change may rename
the stored spelling once no Worker version predating it can serve or be rolled
back to — at which point the transform becomes an identity and should be
deleted, not left to suggest the two ever disagreed. `ReadPolicy` in
`authorization-policy.ts` has its own unrelated `{kind: 'all'}`; it shares the
spelling and nothing else.

**Also in this change: a source-binding disagreement names both sides.**
`submit_draft`'s `sidekick_activity_source_unbound` refusal now names the
bindings the submitted triggers declare and the rules sitting outside that set,
and `set_evaluator_rules` echoes the same two facts as `declaredSourceBindings`
and `rulesNamingNoTrigger` once a draft exists. Both read one predicate,
`unboundEvaluatorRules`, which is the one `automationDraftAcceptanceBlocker`
refuses on.

**Why:** a source binding key is invented by the drafting model and discoverable
from no catalog — `plugin_inspect` does not emit one and `resources_search`
returns none — so it is the one field where both halves of a disagreement are
values only the model itself chose. "They must agree" therefore left it guessing
which of two labels it had typed wrong. A production drafting run merging a
second trigger into an existing Sidekick hit exactly that and stopped, having
correctly diagnosed the refusal and had no way to act on it.

The echo is a report and not a refusal, and is silent when nothing has been
submitted: rules may be set before the draft, which is what keeps the two calls
order-independent, and a disagreement at that moment may be against a draft the
model is about to replace. Refusing there would answer the ordering question the
buffering exists to avoid. A future change must keep both sites on
`unboundEvaluatorRules` rather than rederiving either: an echo that cleared a
submission the object then rejected would be worse than no echo, because it
would be believed.

**And the field itself now says what it is.** `sourceBindingKey`'s description
told the model to take the value "from plugin_inspect or resources_search
rather than composed". Neither returns one: the `plugin_inspect` projection has
no such field, and `resources_search` fills `sourceBindingKeys` with `[]` for
every row. The value is a label the model composes, validated only as
`^[a-z][a-z0-9_-]{0,62}$` and resolved away at apply, so the description named
a lookup that has never existed. It now says the label is composed, that no
tool returns one, that the identical label goes on each rule, and that
narrowing to a channel or folder is `resourceId`'s business rather than this
field's. The rule half is described too, which it never was — the side that has
to match was the undocumented one.

**Why:** the two descriptions contradicted each other, and the wrong one won. A
connector declaring no resource relationship — Fireflies declares none, so
`automationBindableResourceTypes` is empty for it by construction — makes
`resources_search` correctly return nothing, and that tool's own description
says exactly what to do about it: omit `resourceId` and filter on a declared
field. A production drafting run read the `sourceBindingKey` sentence instead,
searched, found nothing, and reported to the person that a workspace
administrator had to expose "a bindable Fireflies resource" — a thing no
administrator can create. The draft it refused to make was already legal.

**Consequences:** the one case where the value is *not* the model's to choose
is where a resource search returns `sourceBindingKeys` for the resource a rule
names; `evaluatorRuleIssues` has always narrowed to those when present, and the
description now states that exception rather than leaving it to a refusal.
Populating `sourceBindingKeys` later therefore needs no further wording change.

### 2026-09-13 — Removing a Sidekick is presented as archive

**What changed:** The current client calls the retained tombstone transition
**Archive Sidekick** and sends `POST /sidekicks/:id/archive`. The confirmation
states that schedules stop while the retained conversation and run history
become inaccessible. The
legacy `DELETE` route still reaches the same transition for installed clients;
the persisted lifecycle remains `deleted`, and no archive browser or unarchive
operation was added.

**Why:** The operation never destroyed the Sidekick object or its historical
data, so “Delete” overstated what happened and hid the retention semantics from
the person making the choice.

**Considered:** Renaming the stored lifecycle to `archived` now would require a
schema and projection migration without changing any behavior available in the
product. The compatibility tombstone is kept until a future unarchive design
needs to make archived objects addressable again.

**Consequences:** New clients use an archive-shaped API and vocabulary. Old
clients continue to work, archived Sidekicks remain absent from the library,
and restoration remains deliberately unavailable. During a rolling Worker
deployment, a new client falls back to legacy `DELETE` only when the archive
request returns the generic `not_found` route response; a domain
`sidekick_not_found` response is not replayed.

### 2026-09-11 — A Sidekick's result names the Sidekick, and its documents land in the room

**What changed:** Two things a room sees from a Sidekick. The activation row's
author slot renders the Sidekick's name from the row's `automationName` instead
of the constant "Automation" (`transcript.ts` parses it into
`Message.automationActivation`; `workstream-blocks.tsx` reads it, falling back
to "Automation" for a row whose structured content will not parse). And a
work-stream-scoped Sidekick now publishes into the owning room's namespace —
see [`terminal-workspaces.md`](terminal-workspaces.md) for that half.

**Why:** The name was already frozen into every activation row at delivery,
precisely so a later rename would not restate who spoke last week, and the
client was throwing it away. A room with several Sidekicks showed the same word
for all of them.

**The header truncates rather than wraps.** `.message-block > header` gives the
author slot the leftover width with `min-width: 0` and an ellipsis, and pins the
time, work summary and context label to their intrinsic widths. A Sidekick's
name is whatever a person typed and the schema allows 300 characters, so without
it the line wrapped to three rows and squeezed the time into a column. The
truncation point is derived from the container, so this is layout behaviour
rather than a defensive cap with a number to argue about — measured in a real
window at 16px for a short name, a realistic one, and one at the schema bound.

**What a future change has to respect:** the name is the delivered one, never
the Sidekick's current title. Reading it live would rewrite history on a rename,
which is the thing freezing it at delivery exists to prevent.

### 2026-09-11 — A delivered Sidekick result carries no trust label

**What changed:** `renderUntrustedAutomationResultMessage` is deleted. The Bind
payload written by `admitAutomationActivation`, and the projection of the same
row on every later run, are now a user-role message carrying the Sidekick's name,
the delivery timestamp and the result body — no `UNTRUSTED SIDEKICK RESULT`
header. `renderTriggerActivityMessage` and
`renderUntrustedExternalEventMessage` are deleted with it.

**Why:** Requested by the team and reaffirmed. The row is still `actor='system'`
with a null author and still queues rather than interrupts; only the label is
gone.

**What a future change has to respect:** the disposition classifier reads the
result behind the same payload the woken run does, so a change to that payload's
shape changes what the classifier sees. The attribution line is what distinguishes
it from a person's message now that the header does not.

### 2026-09-11 — One tooltip per strip tile, saying whichever part of it the pointer is on

**What changed:** `SidekickStripTile` trades its native `title` for the shared
`Tip`, and takes its whole answer as one `SidekickTileTip` — label, side, and an
optional width modifier — so a tile has exactly one tooltip however many things
are drawn in it. `SidekickTile` picks that answer from where the pointer is: the
Sidekick's name and scope above the tile, or the running marker's own sentence
below it. `HexagonMarker` gains a `description`, `SIDEKICK_RUNNING_MARKER` fills
it with `Active — in service and waiting on its triggers.`, and `HexagonGlyph`
gives the painted marker a transparent hit rect over its whole box and reports
`onMarkerHover`. `.sidekick-tile-tooltip` caps whatever the tile says at 220px,
and the tile carries the marker's sentence as its `aria-description` for a
reader with no pointer to rest on the play.

**Why:** Neither half of a tile could be read. The caption is ellipsized at 80px
and the rail drops it, so a `title` was the only way to the name — the platform's
tooltip, in the platform's type, after its own delay, and never on keyboard
focus, which the artifact rows had already rejected for the same slot-level
reason on 2026-09-10 ([`conversation-surfaces.md`](conversation-surfaces.md)). And the play had nothing to say at all: it was introduced
to replace a mark that had to be learned, and an unnamed symbol is one too. What
it names is the part a play gets wrong on its own — it reads as *running right
now*, while the marker is on every active Sidekick, including every one sitting
idle between triggers.

The description belongs to `HexagonMarker` beside the symbol and the colour,
for the reason the knockout belongs to the hexagon: whoever adds the second
marker states what it means or ships an unexplained one. Only the hexagon can
say *when* the marker is under the pointer, too, because the play is drawn in
its viewBox rather than positioned by the rail. But the hexagon does not draw
the answer, and that is the whole lesson below.

**Considered and rejected:** a second `Tip` on the marker itself, nested inside
the tile's. It is the obvious shape — the explanation hangs where the thing is —
and it cannot work. A Radix root dispatches a document-wide "close everything
else" the moment it *decides* to open, which is before the controlled `open` a
caller passes is consulted, so two roots nested like this resolve to whichever
decided last rather than to the one being pointed at. Both failure modes were
seen in a real window. First, plainly: a pointer crossing the tile on its way to
the play starts the tile's 450ms, the marker's opens at 300ms, and the tile's
lands on top of it at 450ms — the sentence flashing and being replaced by the
name. Stopping the marker's `pointermove` fixes only the order where nothing had
started, and it stops the event dead, because React's `stopPropagation` calls
the native one and React delegates from the root container: the sidebar's own
`window` listener for the resize pill's proximity stops hearing about a pointer
inside the marker's box too. Then, subtly: vetoing the tile's open with a
controlled `open`, as `DragHint` vetoes its hint, leaves the dispatch in place,
so the tile's refused open still closed the marker's — a pointer on the play got
*no* tooltip at all. One root has one answer and cannot race itself.

Also rejected, again: naming the lifecycle in the tile's line. Every tile in the
strip is active, so it spent the tile's one line on the one fact they all share.
A reader without a pointer loses nothing by it — the state is in the tile's
accessible name, and what the marker means is now its `aria-description`, the
register the public-scope badge uses on a work-stream row
([`workstream-durable-object.md`](workstream-durable-object.md), 2026-09-10).

**What a future change has to respect:** the marker reports rather than draws.
Re-nesting a second tooltip inside this one brings back the ordering above,
which no arrangement of delays fixes — the dispatch is on the decision, not on
the render. A third thing in the tile worth explaining is another branch in
`SidekickTile`'s one answer.

And a trap in testing it: advancing fake timers past both delays in a single
`act` lets a tooltip mount *after* the document event it should have heard,
which reads as a pass for a race that is still there — it is how the nested
version's regression test passed while the window showed the defect. Let each
timer land in its own flush.

### 2026-09-11 — One answer to which resources a rule may name

**What changed:** `automationBindableResourceTypes` and
`automationTriggersAdmitResourceType` (contracts) return the resource types a
set of triggers declares a relationship to, and the predicate over that set. The
accept-side validator, the drafting tool's pre-flight check and the `resourceId`
normalizer now all read it rather than each walking `resourceRelationships`
itself. `resources_search` reads it too: it passes those types to
`ResourceService.list`, whose new optional `resourceTypes` confines a page to
them, and an empty admissible set returns nothing rather than everything. Each
returned row carries the `relationships` it is reached through — resolved
against its own plugin's declarations rather than the workspace-wide union — and
the answer carries `searchableResourceTypes`, which is what separates "this query
matched nothing" from "nothing here could ever match". The description stops
enumerating a vocabulary by hand and points at that field instead;
`plugin_inspect` now projects `resourceRelationships`, so the refusal that tells
the model to read the relationships it lists is finally true.
[`connectors.md`](connectors.md) carries the matching invariant, because
declaring a relationship is now also what makes a container findable while
somebody is drafting.

**Why:** `resources_search` offered every resource in the workspace, ordered by
recency, ten at a time. Connector activity materializes a resource per file,
commit, check run, pull request, review and comment, so in a workspace working on
one repository the repository itself was two rows in eighty thousand, all
matching its name, and always staler than its own events: the container could not
be returned at all. The drafting agent searched, found no repository, and
reported that it could not bind GitHub events — so a Sidekick asked for on pull
request opened and merged was saved with a timer and no registration. The tool
was offering, by count, almost exclusively rows the accept-side validator was
certain to refuse.

Making search ask the same question acceptance asks is what keeps the two from
being different answers, which is the defect class this path already carries
scars from. The set is derived from the drafting catalog the model inspects, not
from a list of types maintained beside it, so a connector that declares a new
relationship is searchable the moment it declares it and no second place has to
learn about it. Review found the fifth caller that had been walking
`resourceRelationships` alone — WorkspaceDO's watched-resource reconciler — which
is the same point made against the change itself, so it reads the function now
too.

The first draft of the tool description told the model an empty result meant no
resource could narrow the rule. That is only true when the admissible set is
itself empty, and stating it unconditionally would hand a person "the automation
system cannot bind this" on a mistyped query — the exact sentence this entry
exists because of. Hence `searchableResourceTypes`: the tool reports what it
searched, and the two cases stop looking alike.

What a future change has to respect. `ruleTriggersCanNameAResource` is
deliberately narrower than the length test it replaced: a relationship entry
with no `resourceType` cannot equal any resource's type, so an id written
against it could only ever be refused. That is unreachable through a parsed
descriptor and is asserted in the contracts test rather than left as a trap.
An empty `resourceTypes` means *nothing
matches*, not *no filter*. A caller that means "every type" omits the field, and
the product's own resource list does. Confining the page also costs the early
exit the old query got from a common term — SQLite now scans the table rather
than stopping at ten recent matches — which is accepted rather than indexed: the
worst case is what every low-selectivity query already paid, and this one runs a
handful of times inside a drafting run. An index on `resource_type` is the answer
if that ever shows up as a real cost, and it needs a WorkspaceDO migration.

Not done here, and still true: search ranks by recency alone, so a workspace with
hundreds of repositories can still push the intended one past the tenth row. The
fix is relevance ordering (exact, then prefix, then substring), which changes the
cursor the product's list paginates on and is worth doing as its own change.

### 2026-09-10 — A work stream lists the Sidekicks it owns, beside the ones it loaded

**What changed:** Both of a work stream's rails now render one **Sidekicks**
section, below **Participants** in the center sidebar and after the resources in
the inspector rail. It lists what `GET /sidekicks/workstream/:id` returns — the
Sidekicks this room owns — merged by id with the attachments its main
conversation has loaded, owned first. `SidekickSection` is the row shape and
`workstreamSidekickRows` the merge, both new; the attachments-only component
they replace is gone. Neither rail keeps a heading over an empty list. The
`automations` sync topic and the pushed sidebar list now invalidate
`workstream-sidekicks` alongside `attached-sidekicks`.

**Why:** A room's Sidekick was reachable only through the library's ownership
filter, which is the one surface that is *not* the room — while this module has
said since the scope was introduced that such a Sidekick "is listed only in the
room's rail". The rail had the client for it (`getWorkstreamAutomations`, dead
code) and the server has always had the route; what was missing was the section.
The alternative was a second section beside the attachments one, which would
have put two headings called **Sidekicks** in one rail and asked a reader to
know the difference between owning and loading in order to find one. They are
merged instead, because for a reader they are one question — which Sidekicks are
in this room — and a Sidekick can honestly be both: a room's own loadable
Sidekick loaded in its main conversation appears in both answers and is one
object. Where it does, the owned summary wins the row: it carries the chosen
appearance and the live lifecycle, which an attachment record does not, and the
attachment contributes only its **Remove**, which is the one thing it alone can
say — availability is the attachment's, the way appearance and lifecycle are the
owned summary's, so a merged row reads `Unavailable` from it when the lifecycle
has nothing to add. A future change here has to keep three things: `undefined` and `[]` stay
apart in the caller even though this rail draws neither, because the day a
surface here does speak about emptiness it may only do so for `[]`; a
non-participant's 403 is an answer about the viewer and is read as an empty list
rather than an error, since a workspace-scoped room can be opened by anyone in
the workspace; and removal detaches the attachment, never the Sidekick — a
room's own Sidekick is deleted from its profile in the library.

### 2026-09-11 — `people_search` can answer "me"

**What changed:** Every `people_search` result carries `you` — the person the
run acts for, read under the same active-membership predicate as the match list
— and `resolvedPersonIds` is seeded with the execution principal's id before the
drafting agent calls anything. `rememberAutomationPeopleSearchResult` records
`you.id` so the replay path rebuilds the same set.

**Why:** A run asked to send the person who asked a Slack DM searched the
directory for the literal string `me`. The search is `LIKE '%me%'` over names
and emails, so it matched nobody, and the run stopped and asked which person
that was — holding the id in `input.executionPrincipal` the whole time, four
lines above the query. Two separate things were missing and each one alone
would have left it stuck: the search had no notion of self, and the submission
guard would have rejected the id anyway for not having come out of a search.

**Considered and rejected:** Special-casing the pronoun inside the query — it
guesses at natural language, and gets no better than a list of English words.
Loosening the guard so any person id may be submitted — the guard is what stops
a rule naming a hallucinated person, and the fix was to supply the missing id,
not to stop checking. Returning `you` only when the query matched nothing —
the query that needs it is precisely the one that cannot match, so making it
conditional makes it unreliable for no saving.

**What a future change has to respect:** `you` is a convenience over the
directory, never a way around it — it is read under the membership predicate,
so a suspended member is absent from `you` exactly as they are from the matches.

### 2026-09-10 — The stored names follow the model-facing ones

**What changed:** The four things the previous entry kept are renamed too. The
canonical plugin ids are `rally:sidekicks` and `rally:sidekick-result`; the
capability strings are `rally.sidekick.*`; every `automation_*` error, refusal,
outcome, blocker, and alarm-log code the Sidekick paths produce is `sidekick_*`
(`sidekick_not_found`, `sidekick_not_active`, `sidekick_post_result_refused:<code>`,
`sidekick_scheduled_alarm_stalled`, ...); and a Sidekick's memory scope is
stored as kind `sidekick`, which WorkspaceDO migration 50 writes by replacing
`memory_scopes`. The `modelScopeKind` and `storedScopeKind` boundary the
previous entry introduced is gone, since the two names are now one.

**Why:** Keeping the stored and internal names was a compatibility choice, and
it was withdrawn: one vocabulary in logs, receipts, and rows is worth the
migration, and every one of these was a place a person searching for a Sidekick
would still have had to know to type "automation".

**What stays:** the table names (`automation_directory`, `automation_runs`,
...), the alarm kinds `automation_schedule` and `automation_run`, the telemetry
event names and properties, the transcript row types `automation_activation`
and `automation_draft_proposed`, the diagnostic schema name `automation_draft`,
the object component `automation_do`, and every `Automation*` type, function,
and file name. Those are stored rows, an analytics contract shared with the
desktop, or internal identifiers, and none of them reaches a person or a
model. Two renamed codes land on literals that already existed:
`sidekick_directory_access_denied` now covers the legacy and the current
listing routes alike, and `sidekick_missing` is also the demo-readiness gap
for an expected Sidekick that is not listed; both name the same condition.

**How the stored halves stay readable:**

- A plugin activation hint written under `rally:automations` or
  `rally:automation-result` is read as the new id (`LEGACY_PLUGIN_IDS` in
  `integrations.ts`), so a drafting conversation resumed across the deploy keeps
  its plugin rather than reaching for `load_plugin` again. The old hint row
  stays beside the new one; both are harmless.
- The desktop's activity-row map carries both ids, so a transcript row a run
  recorded before the rename keeps the keyframes glyph.
- `memory_scopes.kind` is a CHECK vocabulary on an immutable row, so migration
  50 replaces the table the way migration 31 replaced `connector_connections`:
  every dependent is held in a scratch copy, the parent is rebuilt with the new
  vocabulary and its rows mapped, the immutability trigger and the workspace
  identity fences are recreated, and the dependents are put back parent-first
  with foreign keys enforced throughout. The populated-upgrade test on workerd
  seeds every table in the cascade closure and proves the FTS shadow tables,
  the fences, and the immutability trigger survive.
- Vectorize metadata carries `scopeKind` for information only; nothing queries
  by it, so vectors written before the rename keep `automation` there.

**What review added:** the outcome an admitted event gets from a paused,
draft, or deleted Sidekick (`sidekick_paused`, ...), the activation outcomes
`sidekick_activation_appended`, `sidekick_activation_replayed`, and
`sidekick_activation_failed`, the consumer's `sidekick_directory_applied`
reason, and the description refresh's `sidekick_parent` skip reason follow the
same rule; the user-visible messages behind the renamed codes say Sidekick; and
the drafting receipt replay selects receipts under both capability
vocabularies, since a conversation that inspected a plugin before the rename
holds receipts under `rally.automation.*` and must still count them. The
materialization receipt for a declared memory table is keyed by the Sidekick,
its revision, and the table's position, and the publication alarm re-applies
the same revision until every effect has landed; its payload hash carried the
scope kind and the rationale, so the rename turned every such re-apply into
`memory_table_mutation_receipt_mismatch` and the alarm into a permanent stall.
The hash now covers only what the definition declared, and a receipt written
under the pre-rename hash is asked for once more under that hash before a
mismatch counts as a defect (`memory-table-materialization-receipts.test.ts`
seeds one and re-applies). In-run tool-receipt replay for the creator and
result tools is not shimmed: a receipt written before the deploy differs in
plugin id and tool surface hash as well as capability, the same situation any
edit to a built-in tool's definition creates, and the platform's answer is the
same; `sidekick_post_result` is deduplicated by the room on the run id, and a
resubmitted `submit_draft` writes the same draft as a revision.

**Consequences:** Receipts and telemetry written from now on carry the new
capability strings and codes; the runbook's search terms changed with them.
`memory_scope_not_writable:<kind>` and the refusals that list scopes now name
`sidekick` because the stored kind does. `MEMORY_SCOPE_KINDS` still orders the
retry list narrowest-first; the value changed, not the position.

### 2026-09-10 — The model reads Sidekick everywhere a person does

**What changed:** Every surface the model reads now says Sidekick. The drafting
plugin's model id is `rally_sidekicks` and its tools render under the
`sidekick_` prefix (`sidekick_submit_draft`, `sidekick_plugin_inspect`,
`sidekick_set_evaluator_rules`, ...); `automations_list` is `sidekicks_list` and
answers `{ sidekicks: [{ sidekickId, ... }] }`; the draft's target field is
`sidekickId`. The result plugin is `rally_sidekick_result` and its tool is
`sidekick_post_result`. A run's task context carries its definition under
`sidekick`, with each durable table's `scopeKind` as `sidekick`, and the memory
and table tools accept and return the scope kind `sidekick`. The run prompt's
`# Result delivery` and `# Where this Sidekick was set up` sections, the
untrusted headers (`UNTRUSTED SIDEKICK RESULT`, `UNTRUSTED SIDEKICK TRIGGER
ACTIVITY`, `AUTHORIZED SIDEKICK CONDITION`), the work-opportunity classifier,
the memory and table plugin policy, the drafting plugin's whole system message,
the tool summaries, and the refusals the model reads verbatim follow. So do the
attachment tools' `sidekick` prefix with its `sidekick_read_resource` and
`sidekick_view_resource` suggested calls, and Slack's activity trigger
descriptions.

**Why:** The product rename had reached the plugin's display name, its
description, and the opening lines of its system message, and stopped. The
model was told it was working with Sidekicks and then handed tools, fields, and
rules that all called the same thing an automation, inside one system message.
A medium model reads that as two things. The rebrand inventory's rule applies
here as it did to Avalon: a field is model-facing if something stringifies it,
and every one of these was.

**Not renamed, deliberately:** the canonical plugin ids `rally:automations` and
`rally:automation-result`, which are the identity of a persisted plugin
activation and the key the desktop's activity rows use; the canonical tool
names receipts record (`submit_draft`, `plugin_inspect`, ...), which is why a
drafting conversation resumed across the deploy keeps its inspections and staged
rules; the stored memory scope kind `automation`, which rows and vector metadata
carry and which now meets the model only through `modelScopeKind` and
`storedScopeKind` at the tool boundary; the `rally.automation.*` capability
strings, which are authorization identity; and the `automation_*` error codes
(`automation_owning_room_archived`, `automation_post_result_refused:<code>`),
which the runbook searches logs for; the one exception is the kind suffix on
`memory_scope_not_writable:<kind>`, which names the kind the model chose and so
reads `sidekick`. Internal type, function, and file names
stay as they were, as the rest of this document already records for the object.

**Consequences:** The result tool's canonical name is now `post_result`, so its
receipts change name; the room's replay on the run id is what still makes a
second post a no-op. Telemetry's `tool_name` values change with the wire names.
A run in flight across the deploy sees the new names on its next turn; a model
that still emits `automationId` is refused by the strict draft schema and
retries with the schema it is shown. Two golden prompt hashes moved,
`automationWorkstream` and `semanticTrigger`, and each was checked against a
rename-only reversal of the new text before it was regenerated.

### 2026-09-10 — The Sidekicks window closes on Escape

**What changed:** `SidekicksWindow` — the window's routes, moved out of `App` into
`screens/sidekicks-library.tsx` — installs `useEscapeClosesWindow`, so a bare
Escape closes the window. It nominates no unsaved-text scope.

**Why:** The window is a singleton opened from the sidebar, the account menu and
a deep link, and it has no sidebar of its own to navigate away through, so
dismissing it meant reaching for Command-W or the traffic light. Settings had
answered the same keystroke since it got its own window; this is that gesture,
extracted rather than copied.

The scope is the part worth respecting later. Settings sweeps its pane because it
saves immediately and a half-written invitation has nowhere to come from. Here
the composer's draft is cached and restored, so a sweep would protect nothing and
would leave Escape dead in every Sidekick that holds one — the failure would read
as a key that quietly stopped working. What still holds the keystroke is
everything that consumes it itself: `preventDefault` from the composer's mention
and command lists, Radix's own dismissal of a dialog or menu, and the focused
control when it holds typing, which is what lets the library's search box clear
its filter before a second Escape takes the window.

### 2026-09-10 — A running Sidekick says so with a play, cut out of its own hexagon

**What changed:** The strip's lifecycle marker is a **play** in
`success-base` instead of a dot in a disc of `surface-default`. It is drawn
inside `HexagonGlyph` rather than as a badge positioned over it: the hexagon
carries an optional `HexagonMarker` — a symbol and a colour — masks its fill
with that symbol's own outline dilated by a stroke, and paints the symbol solid
in the hole. `SIDEKICK_RUNNING_MARKER` is the one marker so far.
`.automation-tile-state` and its three lifecycle rules are gone from `app.css`
along with the containing block the badge needed; the geometry lives in the
hexagon's viewBox units, so it scales from the sidebar's 60px to the rail's
36px with the shape rather than holding a pixel size against it.

**Why:** The dot was drawn as a `.status-dot` inside a `.sidebar-row`, and
`.sidebar-row .status-dot` restyles that element into the work-stream marker's
squared-off tick. What a person saw on the strip was therefore not the dot the
rules here intended but a small dark square with no name, on a Sidekick whose
state it was supposed to be reporting. Rather than pin the radius back, the
marker now says the state instead of colour-coding it: a play is what **Resume**
and **Run now** are already drawn with, so the mark and the controls that
produce it agree.

The knockout is the part that had to move into the hexagon. A marker has one
colour and the fill under it is whichever of the fifteen identity colours the
Sidekick drew, so a marker painted onto the fill is legible on some Sidekicks
and lost on the ones near its own colour — `success-base` on `project-green`
being a pairing the strip hands out today. The disc bought that separation, but
it bought it as a circle around a symbol that is not one, and as an opaque patch
of `surface-default` sitting over a row that is painted in a hover fill half the
time. Masking the fill leaves a hole instead, so the gap follows the symbol and
takes the row's real background — including the hover fill, which is
translucent and could never have been matched by an opaque badge.

**Considered and rejected:** stroking a `surface-default` halo around the play
with `paint-order: stroke fill`, which draws the same silhouette with no mask
and no id, and reintroduces exactly the opaque-patch problem where the marker
overhangs the hexagon. And leaving the marker a dot in the tile with only its
radius fixed, which keeps a mark that has to be learned rather than read.

`SidekickStripTile` lost its `active` flag with the badge. It rendered a
visually hidden "Active" beside the caption, which never reached a screen
reader: `aria-label` on a button replaces the button's contents in the
accessible name, and the label the tile already gets carries the state. The
state now travels two ways and only two — the marker for the eye, the label for
assistive technology — rather than three, one of which was inert.

**What a future change has to respect:** the mask id is per-render
(`useId`) because SVG ids are document-global and the strip draws one hexagon
per Sidekick; a fixed id points every hexagon at the first one's mask, which
looks correct until two markers differ. A second lifecycle marker is another
`HexagonMarker` constant, not another knockout. And `MARKER_KNOCKOUT` is set by
looking at the tile at both of its sizes rather than derived from anything: the
gap has to stay a gap at the rail's 36px, where the whole marker is about 7px
across and the first value tried left under a pixel of it. Narrowing it back to
a hairline is a regression that only shows in the rail.

That constant is also why the knockout copy carries `overflow="visible"`. A
Lucide icon renders as a nested `<svg>`, which establishes its own viewport, and
the UA stylesheet clips one to it; `Play` reaches within about 3 of the 24 units
at the top, so a stroke wider than 6 is cut off square at the top, right and
bottom rather than following the outline. Review caught it at the shipped 7,
where the overflow is about half a unit — a third of a pixel at the 60px tile,
and not visible. Confirmed by rendering the marker at a knockout of 16, where
the gap is plainly a rectangle with the clip and traces the play without it.
It is fixed rather than left because the ceiling was the trap: the gap this
constant claims to leave is only true while the stroke stays inside the box, so
the next person to widen it would have got nothing on three sides and no
indication why.

### 2026-09-10 — A Sidekick's hexagon is a picker, and its choice rides the sidebar push

**What changed:** The hexagon on the Sidekick profile opens the work stream's
appearance palette. `SidekickDO` stores the result in
`automation.appearance_json` (migration 7), `POST /sidekicks/:id/appearance`
writes it under the same management check as pause and delete, and the value
travels on the automation's directory row into `automation_directory`
(WorkspaceDO migration 49), onto `AutomationSummary`, and from there to the
sidebar tiles, the library list and every open profile.

**Why the object rather than the conversation.** A work stream keeps its
appearance on its main conversation and sets it with a socket command, and the
obvious move was to lift the `parentKind === "workstream"` guard off that
command and be done. It was rejected: for a work stream the main conversation
*is* the room, while a Sidekick's authoring chat is a child of the object that
owns the Sidekick's name, scope and lifecycle. Putting the icon there would make
substream `0` the authority for a fact about its parent, and `readDetail` — the
one place every client reads a Sidekick from — would have had to go and ask a
child for one field. `docs/choosing-sockets-or-rest.md` decides the channel from
that: a parent-owned mutation is REST, and this one now sits beside pause,
resume and delete rather than beside message admission.

**Why no new push.** "Streamed to everyone with the sidekick open" needed no new
event. WorkspaceDO already pushes the whole `automations` sidebar list to every
subscribed socket whenever an automation's row changes, and the client already
treats that push as the signal to refetch open Sidekick details — it is how a
chat publishing a revision reaches a second window today. Enqueuing the
directory row puts the icon on that path. A dedicated appearance event on the
authoring conversation's socket was the alternative and buys nothing here: it
would reach only the people with the *chat* open, leave the sidebar tiles to the
existing push anyway, and add a second order to reconcile against the first.

The person who picked does not wait for any of that: the route answers with the
committed `AutomationDetail` and the screen writes it into the detail cache,
which is a better position than the work stream's — whose receipt carries no
payload, and which needs the two unversioned cache writers described in
[`workstream-appearance.md`](workstream-appearance.md) to close the same gap.

**A known, accepted consequence.** `enqueueDirectory` bumps
`registration_generation`, so picking an icon while a publication tail is still
running moves the fence under it and the tail reconciles rather than recording
`applied_effects_revision` — one extra idempotent pass over setup that is
already durable. Exempting appearance from the bump was considered and dropped:
`reconcileLoadable` already publishes a row for a reason unrelated to
registrations, and the fence is deliberately conservative, so a cosmetic
exception to it would be the odd case a later reader has to hold in their head.

**What a future change has to respect:** the patch is partial and merges over
what is stored, so a colour choice never carries an icon with it; `NULL` means
nobody has chosen, which is not the same as choosing the derived mark; and the
directory row is the only way this reaches anybody else. Anything that starts
writing a Sidekick's appearance without enqueuing that row leaves every other
window on the old glyph with nothing to correct it.

### 2026-09-10 — The empty strip makes the first Sidekick

**What changed:** With no Sidekick of any kind, the sidebar's strip holds a single
**New Sidekick** tile — the same tile shape, with the same hexagon drawn as a
dashed outline around a plus — instead of being absent. It opens the singleton
Sidekicks window on the composer. The tile goes once the workspace has any Sidekick — a
draft counts — and the strip stays absent while the workspace socket answer that
carries the Sidekicks is still in flight, which `automations` now reports by
being `undefined` rather than empty, because an unloaded list is not an empty
workspace. `AutomationGlyph`'s hexagon is now a `HexagonGlyph` primitive taking
a fill, an ink, and a symbol, and the strip's tile shape is a
`SidekickStripTile` both tiles render through. `openSidekicks` takes a target
rather than an id, parsed in main by `parseSidekicksWindowTarget`. Neither tile
marks a surface entrypoint any more.

**Why:** Until a Sidekick existed the strip showed nothing, so the one place in
the product that says what a Sidekick is had nothing to say in the only state
where somebody still needs telling — the account menu's Sidekicks item and the
library's own New Sidekick button were the whole path, and neither is where a
person looks. An action tile that reuses the Sidekick tile is also the cheapest
thing to remove later: it is a branch in one strip, not a surface.

The two extractions are what keep the action honest rather than approximate. The
hexagon had the path, the fill, and the identity in one component, so drawing an
empty one meant a second path; the primitive makes the outline and the fill the
same silhouette at the same size by construction. The tile had the same problem
for its collapse behaviour: the rail shrinks the strip's tiles to 54px squares
and sheds their captions, and a second tile shape would have had to be kept in
step with rules it did not share. Main parses a window target rather than an id
because `new` is not one and loosening `IdSchema` to admit it would let any
string reach the window's hash.

Both the strictness of that test and the removal of the entrypoint mark below
came from review on the pull request rather than from the first cut, which keyed
the tile on the strip being empty and would have created a draft per press.

**Considered and rejected:** Keying the tile on no *active* Sidekick, which is
the strip's own predicate and was the first cut: it reads a paused workspace as
an empty one and, because `/sidekicks/new` creates a draft on arrival, leaves
the tile up in precisely the state where pressing it again is cheap. Making
`/sidekicks/new` idempotent for an untouched draft, or routing the tile to an
existing draft instead of the composer, either of which would fix the
re-entrancy itself rather than removing its amplifier — both are changes to the
creation route that the library's button shares, and belong with it rather than
with a sidebar tile. Showing a Sidekicks affordance that opens the library when
paused or draft Sidekicks exist, which is a different feature — a way to reach
non-active Sidekicks from the sidebar — and not the discovery problem this
solves. A filled hexagon in a palette colour, which reads
as an existing Sidekick — the dashed outline is the same thing the draft
lifecycle dot says, and at the rail's 36px the outline is what distinguishes it.
Keeping the tile alongside the shortcuts once Sidekicks exist, which would put a
button that is not a Sidekick in a row that is scrolled and scanned as a list of
them; the library window carries New Sidekick from then on. Opening the library
rather than the composer, which asks a person who just pressed a plus to find a
second one. Carrying the surface entrypoint across the window boundary and
mounting an observer on the Sidekicks surface, which is the fix that would
actually attribute those visits rather than just stop mis-attributing others: it
is an IPC contract change and a telemetry decision of its own, and the Sidekicks
window reports no `surface_viewed` today either way.

The entrypoint mark went because it never worked. `markSurfaceEntrypoint` writes
a module-local marker that `TelemetryRouteObserver` consumes on the next route
change *in the same renderer*, and both tiles open a different renderer — one
whose surface in `App.tsx` mounts no observer at all. The marker could not reach
the visit it described, and instead sat in the main window until its next
unmarked navigation reported itself as `sidebar_automation`. Raised by Codex on
the pull request; it predates this change on the Sidekick tile, and came out of
both rather than being left inconsistent in a strip whose two tiles are
otherwise the same tile.

**Consequences:** The strip is no longer proof that a workspace has an active
Sidekick, and the create tile is proof that it has none at all — a rule that
read either the old way has to read the tiles. `Sidebar`'s `automations` prop is
now `AutomationSummary[] | undefined`, where `undefined` is the wait; a caller
that collapses that with `?? []` puts the tile on a cold sidebar, which is why
the distinction lives in the prop rather than in a separate flag a caller can
forget. `openSidekicks` now refuses a target that is neither a UUID nor `new`
with `Invalid Sidekicks window target` rather than a Zod parse error.

`/sidekicks/new` itself is still not idempotent: it creates a draft per arrival,
and the library's own **New Sidekick** button does the same. Removing the
persistent sidebar entry point once a draft exists takes away the cheap way to
accumulate orphans, not the underlying re-entrancy.

The strip's accessible name follows its contents — **Sidekick shortcuts** when it
holds them, **Sidekicks** when it holds only the offer to make one — because the
first name describes shortcuts that are not there in the empty case. The
outline's stroke is `text-muted`, an ink token rather than a `border-*` one: it
is the whole mark rather than a line beside content, so it answers to the 3:1
floor for graphical objects, and the border ramp has none of that headroom
against `surface-default` (`border-strong` measures 1.38:1 light and 1.44:1
dark, against `text-muted`'s 5.35:1 and 7.99:1).

This entry narrows the 2026-09-08 **Scroll compact Sidekicks with navigation**
entry's and its successor's "the strip is absent when no entries qualify": that
is still true of a workspace whose Sidekicks are all paused, drafts, or
work-stream-owned, and no longer true of one that has none at all.

Shipped in #657.

### 2026-09-10 — The rail keeps the Sidekick strip horizontal, at the bottom

**What changed:** In the compact rail the strip stays below the scrolling
streams and above the account row, and stays a horizontally scrolling row of
54px tiles, with one tile centred and the next showing past the padding. This
reverses the 2026-09-08 entry below, **Scroll compact Sidekicks with
navigation**, which had folded the tiles into the vertical navigation
scroller.

**Why:** The strip was asked to keep its place and its horizontal scroll in
the collapsed sidebar, so the Sidekicks are reached at the same spot whichever
width the sidebar is at and however long the stream list is; folded into the
scroller they moved with the list and were off screen whenever it was long.
The clipping the earlier entry set out to avoid came from centring a 54px tile
in a 54px content box: the rail now gives the strip 21px of padding a side,
which centres a lone tile in the 96px rail exactly and clips nothing, and
closes the tiles' gap so the second tile's mark shows past the edge as the
hint that there is more.

**Considered and rejected:** Keeping the column and pinning it below the list
with its own scroll, which would have given the rail two vertical scrollers
one above the other. Widening the peek by shifting a lone tile off centre,
which would have set it against the rows' 54px seat.

**Consequences:** The strip's spacing is padding rather than a margin in both
widths, so its tiles scroll to the sidebar's edge; the tiles' shapes are
transitions on `--sidebar-layout-motion`, per
[`conversation-surfaces.md`](conversation-surfaces.md), and a rule that gives
a tile a keyword size in one width cuts. On a platform whose scrollbars take
space, an overflowing strip in the rail shows a thin scrollbar under the tile.

Shipped in #648.

### 2026-09-09 — A Sidekick can run from a script, so a demo can ship one that has already run

**What changed:** `SidekickDO` gains `runSeeded`, a second way to admit a run.
It takes a demo pack's seed, stores it on the run row (object migration 6,
`runs.seed_json`), and `provisionRun` puts it in the run's execution context
beside the trigger. The harness then answers that run's provider requests from
the seed instead of reaching OpenRouter, which is the same seam a seeded message
already used. Everything else about the run — admission, provisioning, the Bind
loop, the tool surface, settlement, the run history row — is the ordinary path.
`AutomationService` gains `saveDefinition` and `runSeeded` so the demo seeder can
publish a definition and start that run without a drafting model.

**Why:** A demo workspace is meant to open on a Sidekick that has already done
something, not one that is merely configured. Producing that briefing with a
live model would make preparation depend on inference nobody can replay, and
writing the run's rows directly would be history claiming Rally did something it
did not. Reusing the run path with a scripted provider is the only version where
the briefing in the demo is a real run.

**Consequences:** `runSeeded` is deliberately a separate method from `runNow`
rather than an optional field on it. `runNow` is what `POST /sidekicks/:id/run`
reaches, and a seed on that request shape would be one deserialization away from
letting a member script their own Sidekick's output and keep it as history. A
future change must keep the two request shapes apart. The trigger a seeded run
records is `manual`, naming the author: the schedule did not fire it, and
recording that it did would be the fabricated history the demo feature refuses
everywhere else. `docs/demo-workspaces.md` owns the pack step and the seeding
rules.

### 2026-09-08 — Give Sidekicks a library and dedicated profile layout

The library uses the existing AutomationGlyph identity, a shared search field,
ownership filter pills, and two-column descriptive rows. Detail pages place the
profile, lifecycle actions, schedule, and plain-language guidance beside the
shared conversation. Email is collapsed behind a disclosure, and current and
previous runs are available through More → Run history in a troubleshooting
dialog. The initial page has no run list or counts. Both panes reserve their scrollbar gutters. Hosts narrower than 900px switch
between Conversation and Details without unmounting or removing layout boxes.
The threshold reserves 340px for the profile and 560px for the conversation;
measuring the host also handles the main window with its sidebar. Hidden
conversations do not claim paste or acknowledge reads.

The earlier header-only styling still crowded management information above the
chat and did not meet the requested whole-page redesign. The profile is now a
host-owned sibling, preserving the shared transcript and composer implementation.
Publication remains conversational, and deletion keeps its confirmation dialog.
Run history is secondary because it serves troubleshooting; the first view
should help people understand the Sidekick and ask for changes in their own words.

### 2026-09-08 — Scroll compact Sidekicks with navigation

The compact sidebar now places each enabled standalone Sidekick in the shared
vertical navigation scroller. Horizontal footer tiles could clip the single
icon and gave Sidekicks different spacing from work streams. Expanded navigation
retains its captioned horizontal strip; compact navigation uses the same 54px
row geometry as work streams while the account controls remain fixed.

### 2026-09-08 — Finish authoring conversations after publication

Ready submissions now return to the model for an acknowledgement instead of
halting the harness. Production validation found that publication committed, but
the authoring run then failed with `final_turn_required`: the old compiler-style
tool halt bypassed the conversational final response. Weakening the runtime's
durable-final-turn check was rejected because saving a definition does not replace
the conversation's reply. A real workerd regression drives the authoring tool,
checks publication, and requires a completed run with a persisted final turn.

### 2026-09-07 — Sidekicks compose reusable knowledge with optional execution, and the strip's tiles are the enabled standalone ones

**What changed:** Sidekicks broaden automation ownership to instructions that
can load into an existing conversation. Loadability is stored policy output.
Publication is conversational and immediate, and execution bindings remain
unnecessary for knowledge alone. Main-conversation loads persist attachments,
and per-execution snapshots keep edits from changing resumed instructions. The
library has a dedicated window. The personal and workspace shortcut tiles from
PRs #581 and #582 now represent enabled standalone Sidekicks; tiles open the
library detail, and drafts and paused entries remain manageable there without
occupying the strip. The account popup retains PR #578's simplified ordering,
and the Sidekick WorkspaceDO projection moves to migration 35 after
onboarding's released 34.

**Why:** Loadability is stored as policy output so future eligibility rules can
change without rewriting consumers. The class rename preserves namespace
identity, because replacing objects would discard conversations and execution
history. The library gets its own window so management does not displace
ongoing work. The tiles show the enabled lifecycle rather than in-progress runs
because that was the choice made for them, so no execution-state projection is
needed.

**Considered and rejected:** Replacing the new tiles with library-only
navigation, because people still need direct access to enabled delegated work.
Replacing the objects under the rename, for the reason above.

**Consequences:** Loadability is read from stored policy, never recomputed by a
consumer. A resumed execution reads its own snapshot of the instructions, not
the current revision. The strip holds only enabled standalone Sidekicks; a
draft or a paused one is reached through the library.

### 2026-09-07 — Include workspace automations in the strip

**What changed:** The shared sidebar strip includes both personal and workspace
scopes, and its accessible name is now Automation shortcuts. Legacy rows exclude both
scopes so each automation appears once.

**Why:** Workspace automations need the same direct access as personal ones in
the production conversation-only sidebar.

**Considered and rejected:** A separate workspace list would duplicate navigation
and require different behavior between expanded and compact modes.

**Consequences:** Room-owned automations stay in their existing room navigation.
The strip is absent only when neither standalone scope has entries. Workspace
tiles omit management menus until authoritative capabilities are available, rather
than offering actions that viewer-only members cannot perform. The strip keeps the
server directory order and horizontal overflow for the combined population; it
does not add a separate cap or reorder by recent use.

### 2026-09-07 — Personal automations in the sidebar

**What changed:** Personal automation tiles sit outside the scrolling stream list,
above the account menu. `AutomationGlyph` owns the rounded hexagon and centered
symbol. Compact mode keeps Search and New chat at the top. Links retain explicit
accessible names when captions are hidden, and failed manual runs open the shared
error dialog.

**Why:** Personal automations need direct access in the conversation-only shell,
including when a long stream list scrolls. Compact navigation needs the same
search and creation actions as the expanded sidebar.

**Considered and rejected:** The reference wrapping grid would grow with the
number of automations, so the strip scrolls horizontally in both widths. Literal
reference colors bypassed Rally's theme guard; semantic row, icon, and lifecycle
tokens preserve appearance support instead.

**Consequences:** Empty personal strips do not render, and personal-only directories
suppress the misleading legacy empty list. State markers share stream square
geometry but not its amber glow. Workspace automation rows remain available only
in legacy full-sidebar mode. Reference bundle names above record the inspected
version, not runtime dependencies.

### 2026-09-04 — A replayed create provisions the conversation it skipped

**What changed:** `AutomationService.createAutomation` runs the runtime
bootstrap and the conversation provisioning on every call, not only when the
object answers `created: true`; both are idempotent (insert-or-ignore anchors,
`already_provisioned` from the object).

**Why:** Pull request review. The object's row committed first, so a first
call that died between it and the provisioning answered `created: false`
forever after and skipped both, leaving an automation whose conversation could
not be opened. Room drafting reaches this directly: its automation id is the
stable harness run id, so a retry is the same call again.

**Consequences:** A replay costs one bootstrap RPC and one provisioning RPC
that answer at once; nothing else.

### 2026-09-04 — Apply reconciles on replay, refuses a pause, and creates the declared tables; a retried admission arms its run

**What changed:** `AutomationDO.apply` records `applied_effects_revision`
(migration v2) only after its tail has run, and its replay guard reads that
marker rather than the accepted revision, so an apply whose alarms,
registrations, or tables never landed is repaired by applying again. Apply
refuses a paused automation (`automation_not_active`) and one whose owning
room is archived (`automation_room_archived`). `admitOccurrence` arms the
run alarm on its reused branch when the run is still pending. The
definition's `memoryTables` are created in the automation's memory scope at
apply, and a run's prompt lists every live table in that scope.

**Why:** Pull request review. The accepted revision was written inside the
transaction and the tail ran after it, so a failure in the tail left an
"active" automation with nothing armed and nothing registered, and a repeat
apply returned at once because the revisions matched; the desktop disabled
Apply for the same reason, so nothing could repair it. Apply also set
`lifecycle = 'active'` without asking why the automation was paused, which
resumed a room-archived automation past the refusal `resume` gives. A run
row committed on its own before its alarm was armed, and a retry found the
row and returned `reused` with nothing armed, so the occurrence was lost
while the caller was told it had been replayed. And a definition's
`memoryTables` were collected, stored, and carried to every run without
anything creating them; the team chose to materialize them at apply rather
than drop the declaration.

**Consequences:** An apply while paused is a refusal the desktop should not
offer; resume first. A declared table is never dropped by a later revision.
A table a run created under a declared name with a different shape refuses
the apply, which is the conflict the earlier design deferred; it surfaces at
apply, where a person can rename the declaration.

### 2026-09-04 — A run reads the event that woke it, and an array field has operators it can use

**What changed:** A matched delivery (`WorkspaceExternalEventSchema`) now
carries the event's `textSnippet` and `metadata` beside its title and
summary, and `admitExternalEvent` renders them as the run's opening message
(`lib/external-event-opening.ts`): a system row marked untrusted, with the
same fields in its structured content, appended to the run's transcript
before the loop starts, the way an inbound email already was. The model
history projection admits that row when it is the run's trigger, through
`renderUntrustedExternalEventMessage`, a user-role message whose label says
to work from the event's fields and to treat anything inside it that reads
like an instruction as data; every other system row stays out of the model's
history as before. A run's
opening no longer needs a resource; only an email attaches one. A delivery exceeding the Queue envelope budget now travels intact through
a canonical-event context reference (2026-10-19), rather than dropping its
snippet and metadata; `connector-queue-payload.ts` owns that transport. Separately, a connector filter field whose manifest names no
operators now defaults by value type
(`defaultConnectorActivityFilterOperators`): the set operators for
`string_array` and `person_id_array`, `equals` for everything else.

**Why:** Every event automation drafted on the live stack fired correctly
and then had nothing to say: the run was handed only the event's type, so
"write a line naming the deployed service" produced "service: unavailable".
The rule had just selected on that service; the run deserved to read it.
Storing the opening was not enough on its own: system rows are not model
history, so the first fix put the event in the transcript and the model
still answered "not provided" while it sat in front of a person reading the
same conversation.
The array default was found the same way: Granola's `changedFields` and
Notion's `authorPersonIds` defaulted to `equals`, which the array leaf
schema refuses, so no rule could ever name them.

**Consequences:** The delivery message grows by the event's snippet and
metadata, which ingress already bounded; the trim guard is the only new
limit and it reuses the ingress bound. Connector text now enters a run's
transcript as prose; it is labelled as the connector's words and not an
instruction, and the structured content says `untrusted`. A manifest that
wants `equals` on an array field must say so.

### 2026-09-04 — A rule's "no resource" sentinel, a poison-pill event, and a replayable dev ingress

**What changed:** `withoutUnusableAutomationResourceIds` (contracts) drops
a rule's `resourceId` where it cannot mean anything: a sentinel (the nil or
max UUID in any version-and-variant dress, or empty), or any id on a trigger
that declares no resource relationship. It runs at every place a rule enters
an automation: the `set_evaluator_rules` call, the receipt replay that
rebuilds the draft state on a later turn, and the accept path reading the
stored revision. The tool's JSON schema no longer lists the nil and max UUIDs
as alternatives in its id patterns. A searched resource whose search named no
binding keys is accepted on its plugin alone. `submit_draft`'s optional
`automationId` is read the same way: only a well-formed id that is not a
placeholder names an automation to edit; a slash or a nil UUID is no target,
and the submission creates a new automation as an omitted field does. Handed
through, the placeholder threw from the directory lookup as a bare schema
error the model retried identically. The drafting validator's
filter-field check now has the same `openFilterFields` branch the accept-side
evaluator has, so a rule on a webhook payload key can be written, and both
sides refuse a dotted key on an open descriptor, whose description now says
to name the key bare. The activity consumer acknowledges an admission the workspace ledger refuses
as `connector_event_identity_reused_with_different_content` instead of
retrying it. The dev ingress derives the synthetic activity id from the
workspace, connector, connection, and provider event id, so posting the same
event twice is a replay. The drafting catalog skips a connection whose
connector is not registered in this region with a warning
(`automation_creator_connector_unavailable`) rather than throwing, and shows
the connection's display name beside the connector's.

**Why:** All of these were found by drafting event automations across several
connectors on a running stack with live inference. The model filled the
optional `resourceId` with a sentinel on every rule, because the schema's own
pattern advertised it; the id passed the pattern and no lookup could satisfy
it, so no event automation could be created. Stripping it on the live call
alone was not enough: the next turn restored the sentinel from the raw
receipt, the submit wrote it into the revision, and acceptance refused a
resource that does not exist. Removing the two UUIDs from the advertised
pattern did not stop the model either; it reshaped the placeholder to satisfy
the version and variant nibbles within minutes, which is why the rule is
structural rather than a list: a webhook delivery cannot be about one
resource, so on that trigger the field is noise whatever it holds. A dotted
key was accepted on an open descriptor and would have compiled into a rule
that never matched, since the event context indexes metadata by bare keys. The drafting validator refused every
conditional rule on a webhook while the accept side would have admitted it,
the disagreement the module's own comment forbids. The first replay attempt minted a fresh id per post, and the ledger refused the
reuse on every retry with backoff, which kept one message in flight for
minutes. A seeded connection for a connector with no local credentials threw
inside the catalog and took drafting down for every conversation.

**Consequences:** On a trigger that can be about one resource, an unknown
id is still refused with the sentence naming `resources_search`; only there
does the field carry meaning. A revision written with a placeholder before
this change is read the same way at accept. The
identity refusal is terminal and logged once under
`connector_event_queue_admission_failed`; every other admission failure still
retries. The dev route cannot express two different payloads under one
provider event id, which is the ledger's rule, not the route's.

### 2026-09-04 — A webhook's triggers are its configured event types, and its payload keys are the filter fields

**What changed:** `connectorActivityTriggerDescriptors` (`lib/connector-activity-triggers.ts`)
derives a generic webhook connection's triggers from the connection's own
`eventTypes` allowlist, one trigger per configured type, each marked
`openFilterFields` so a rule may name any metadata key with any operator; the
drafting catalog and the accept path both read triggers through it, and
`plugin_inspect` shows the flag. The harness run's plugin filter keeps an
event-capable connection with no tools, so `load_plugin` on a webhook plugin
succeeds and a ready draft naming it is admitted. An automation's own
conversation replays its drafting receipts (inspections, lookups, rules)
across every turn on the conversation, so a plugin inspected before an
elicitation pause is still inspected after it. The refusal for a resource a
plugin cannot watch says the field may be omitted.

**Why:** The manifest declared one trigger, `webhook.received`, while a
delivery carries the caller's `event_type` and the matcher selects
registrations by exact type, so a webhook rule could be written only for an
event that never arrives; and with no declared filter fields the only legal
rule was `always`. Found by drafting a webhook automation on a running stack
with live inference: the catalog fix made the plugin visible and the run's
own filter then refused to load it.

**Consequences:** A connection is what defines a webhook's vocabulary; adding
an event type to the connection adds a trigger the next draft can name. An
open descriptor is validated for shape only, and a leaf on a key the payload
lacks is a miss at match time, not a refusal at accept.

### 2026-09-04 — A webhook can start an automation, and the drafting agent can look things up

**What changed:** `loadAutomationCreatorPluginCatalog` keeps a connection whose
connector is event-capable (`manifest.activityTriggers` or a `webhookActivity`
source) even when it exposes no tools; a generic webhook has no tools by
design and was dropped from the catalog, so no webhook-triggered automation
could be drafted anywhere. The drafting plugin's `people_search` and
`resources_search` now have a host: workspace members from D1, and the
resource list the person the run acts for can see, each resource with the
plugin its connection is reached through. A `workstream`-scoped automation's
author manages it alongside the room's participants, since the directory row
that names those participants lands through the effect queue and a card that
says "accept" was refused while it was in flight. `matchExternalEventDestinations`
logs `external_event_matched` with the delivery count, so a non-match is no
longer silent.

**Why:** Found by driving the routing path on a running stack: the ingest and
dedupe half worked, the drafting half could not name the webhook, and the two
research tools had thrown `automation_draft_research_host_unavailable` since
the compiler host they were written for was deleted.

**Consequences:** A catalog entry can carry no tools and still be inspected
and bound as a trigger source. The manager rule for a room's automation is
participant or author; a person who leaves the room keeps managing what they
asked for until the room's participants change it.

The rule vocabulary is proved across connectors in
`apps/api/test-workers/external-event-rules.test.ts`: synthetic GitHub, Linear,
Notion, Slack and webhook events ingested through the workspace ledger and
matched against rules from `always` and event type up to compound string,
set, number, boolean, presence and person leaves, restricted audiences (a
restricted event reaches only a personal automation whose author is in the
audience, never a workspace one), and the ordering boundary. The same events
can be fired on a running stack through `POST /dev/connector-events`, a
development-only ingress that enqueues a normalized activity where a verified
webhook would, so everything after ingress is the production path.

### 2026-09-04 — A room can edit an automation it owns

**What changed:** `submit_draft` accepts an `automationId` beside the draft,
and the plugin gains `automations_list`, which the host answers with the
automations the conversation may change and their current definitions. A
room's submission naming one of its own automations writes that automation's
next revision; a room naming any other is refused, and an automation's own
conversation may name only itself.

**Why:** Every room submission created a new automation, keyed on the
authoring run, so asking a room to change the reminder it set up yesterday
produced a second reminder. Editing in the automation's own conversation was
always possible, but a person asking in the room had no way to reach it from
there, and the card the room posts is the natural place to continue.

**Consequences:** The target travels as a tool argument and is stripped before
the draft is parsed, so the stored definition never carries an address.
`automations_list` reads through `WorkspaceDO.listWorkstreamAutomations` and
`AutomationDO.readDetail` as the person the run acts for.

### 2026-09-04 — A posted result drains into the room, and the rail survives an archive

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
room is unarchived. For that refusal to be reachable, the Worker resolves a
manager's participation with `includeArchived`, so the archived room's people
still manage its automation and the object, not a blanket 403, says what the
archive forbids. Two more edges from the same live pass: a feed ticket for a
run's conversation requested before the run alarm has bootstrapped the object
answers `409 conversation_not_ready` instead of an untyped 500, and deleting
an already-deleted automation re-enqueues its directory row so a sidebar entry
left behind by a lost queue message can be cleared through the API.

### 2026-09-03 — The automation is rebuilt as a conversation parent

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
