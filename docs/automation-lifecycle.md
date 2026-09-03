# Durable automation lifecycle

An automation is one named `AutomationAgent` Durable Object. It is created when
the first authoring turn is admitted, holds the draft conversation while the
architect compiles a definition, becomes the accepted runtime authority in place,
and then owns every trigger occurrence, generated run, schedule, memory mutation,
inbound-email receipt, and result-delivery receipt for the rest of its life.
Draft and active are lifecycle states of one object: promotion mints no second
ID and copies no state to a second authority.

`WorkspaceDO` keeps a content-free `automation_directory` row so the sidebar can
find that object, plus the typed external-event registrations and delivery
receipts that fan a connector event out to it. A projection can locate an
automation; it can never authorize reading one.

Read this before changing automation routes, the architect's tools, triggers,
schedules, runs, memory, the workspace projection, or the one-shot cutover.
[`automation-drafts.md`](automation-drafts.md) is the historical record of the
retired WorkspaceDO subscription-row design and is not implementation guidance.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/automation-agent.ts` | The product authority: schema, socket room, draft admission, compiler dispatch, acceptance, schedules, occurrences, run provisioning, memory RPC, delivery receipts, and the projection outbox. |
| `apps/api/src/durable-objects/automation-agent-memory.ts` | Automation-owned memory items and tables, and the generation-fenced tool executor generated runs reach them through. |
| `apps/api/src/durable-objects/automation-cutover.ts` | The one-shot WorkspaceDO import: the legacy witness and its hash, the per-automation import, and `removeLegacyAutomationSchema`. |
| `apps/api/src/durable-objects/ordered-transcript-sqlite/` | The shared ordered-transcript schema and canonical JSON the draft conversation is stored in — see [`ordered-transcript-sqlite.md`](ordered-transcript-sqlite.md). |
| `apps/api/src/services/automation-agent-service.ts` | The single REST boundary. Claims an automation ID, addresses the named object, and wraps each RPC in `withAutomationErrors` so the object's thrown code becomes an HTTP answer. Each call site wraps itself deliberately: a `Proxy` over the stub is shorter and does not work — its `get` trap hands the stub's own method the proxy as `this`, which a brand-checking stub rejects with a `TypeError`, and an RPC returns a pipelining thenable rather than a native `Promise`, so an `instanceof Promise` branch never attaches the mapping. Both failures are invisible until a request reaches a real object. |
| `apps/api/src/services/automation-agent-errors.ts` | The one table mapping an AutomationAgent error code to a status and a sentence a person reads, and the only place a refusal decided at the REST boundary is raised (`automationRefusal`, keyed on the table so a misspelled code is a type error). It also rebuilds an `ApiError` a collaborator threw inside the object, whose class does not survive the RPC hop. |
| `apps/api/src/services/automation-service.ts` | What is left of the old service: the shared **template** catalog, publishing, and version validation. It starts no runs. |
| `apps/api/src/services/external-event-evaluator.ts` | The pure DNF predicate evaluator WorkspaceDO matches registrations with. |
| `packages/contracts/src/automation-agent.ts` | Lifecycle, admission, snapshot, and `AutomationRunContextV1` contracts. |
| `packages/contracts/src/automation-evaluators.ts` | The strict, versioned external-event evaluator grammar. |
| `packages/agent-harness/src/prompts/automation-compiler.ts` | The architect's standing policy and its draft-only tool surface. |
| `apps/api/src/durable-objects/workspace-do.ts` | Migration 22: `automation_creation_claims`, `automation_directory`, `workspace_external_event_registrations`, `workspace_external_event_deliveries`, `automation_cutover_campaign` — plus the matcher and the delivery lease. |
| `apps/api/src/queues/activity-consumer.ts` | Carries a canonical event into matching and each ID-only delivery out to its destination object. |
| `apps/api/src/services/resend-inbound-email-service.ts` | Screens inbound mail against the agent before storing anything, then admits it. |
| `apps/desktop/src/renderer/screens/automation.tsx` | The stable `/automations/:id` route; `new-automation.tsx` is its draft adapter and `automation-overview.tsx` its accepted one. |
| `apps/desktop/src/renderer/lib/use-automation-agent-socket.ts` | The draft feed: ticket, snapshot, compiler stream, heartbeat, and reconnect. |
| `scripts/cutover-automation-agents.mjs` | The one-shot authority cutover, now an operator tool rather than a deploy step — see the changelog for 2026-08-29. Idempotent per workspace. |

## How it works

### Authoring

Selecting **New automation** navigates to `/automations/new` and creates no
server state. Composer text and staged attachments use the same draft-cache
primitives as a new work stream.

The first send is `POST /automations/agent/draft/turn` carrying a client creation
key and a client message ID. The Worker asks `WorkspaceDO.claimAutomationDraft`
to mint one automation ID against that creation key — the claim table is keyed on
`(workspace_id, author_user_id, client_creation_key)`, so a retried first send
resolves to the same automation rather than a second one. It then admits the turn
on the named object, which durably reserves the human turn and one compiler run
before any provider work, and seeds the directory row itself so the sidebar has
something to show before the outbox drains. The route answers `202` immediately.
`/automations/:id` then adopts that ID without remounting the conversation.

The draft feed is the ordered participant transcript, rendered through the same
feed rows, composer, attachment presentation, follow controller, and **Jump to
latest** control work streams use; its adapter omits participant, unread,
resource, and run controls and adds template, review, acceptance, stop, and
compiler-retry controls. Live state arrives on the automation's own WebSocket
(below); the client also re-reads `GET /automations/:id/agent/draft` after every
durable event, one request at a time.

One compiler run is admitted at a time — a second send while one is running is
refused with `automation_compiler_busy`. Dispatch is a stored alarm entry, not an
in-flight promise, so an evicted object picks the run back up. Every architect
mutation is staged in the object's own SQLite inside the run, keyed by the
provider's tool-call ID and an input hash: replaying the same call returns the
prior result, and a changed canonical input creates a later definition revision.

A picked-up run re-enters the compiler from the stored conversation, not from a
persisted Bind projection: the object installs the shared `bind_loop_*` tables
but writes nothing to them. The staged mutations and tool receipts are what make
that cheap and safe rather than free — a repeated tool call is answered from its
receipt, but the model turn itself is issued again.

The architect may search and inspect people, resources, and connector
capabilities but cannot execute provider writes. Resource search is scoped to
connections the author may actually use — workspace connections plus their own
personal ones — so another member's personal connector titles cannot reach the
draft. Its three state-changing tools are:

- `automation_set_evaluator_rules`, which replaces the staged, strictly parsed
  external-event evaluator set;
- `automation_submit_draft`, which stages the next compiled definition and
  references the staged evaluator keys;
- `core_request_elicitation`, which records one structured unresolved question
  for a definition that is not ready. Its provider-key receipt is also the
  durable question identity, so replay converges on the existing elicitation.

An external-event definition must set evaluators before submission. Timer-only
and manual-only definitions clear staged event rules rather than calling the
evaluator tool with an empty array.

`admitAuthoredDraft` enforces that, on the rules themselves rather than on
whether the tool was called: a **ready** draft carrying a `connector_activity`,
`semantic_activity` or `webhook` trigger is refused when its staged set is
absent **or** empty. It is not merely the same condition `prepareAcceptance`
applies but literally the same predicate — `evaluatorRulesMissing`, over
`externalEventTriggers` — so a new trigger kind reaches both boundaries or
neither. A
draft that is not ready is exempt — a partial submission paired with a
clarifying question has not chosen its rules yet, and acceptance refuses it on
`ready` alone. Submission is the last point at which missing rules are the
drafting loop's problem to fix; past it the refusal has nowhere to land but a
proposal card whose Create button never works.

Deleting a draft bumps the authority generation, cancels any live compiler run,
marks the object `deleted`, and projects that lifecycle to the directory. It is
not archived into a second draft store.

### Acceptance

`POST /automations/:id/accept` is the only way an automation is created. It
carries an ID and nothing else: `acceptAuthoredDraft` reads the stored
definition, checks it is `ready`, resolves the owning room and the caller's
participation in it, and calls `acceptDraft`.

Everything acceptance needs beyond that is **derived from the definition** by
`automationAcceptanceSelections`, never taken from a request:

| Derived | From |
| --- | --- |
| `activitySourcePluginIds` | each external-event trigger's `sourceBindingKey` and `suggestedSourcePluginId` |
| `defaultPluginIds` | `recommendedPlugins[].pluginId` |

That inversion is the point. These were request fields because a create wizard
asked a member to choose them, and that wizard was deleted on 2026-09-01 along
with the last caller that could answer. The drafting loop settles the same
questions earlier and with more evidence: a ready draft's activity trigger names
the plugin the model loaded and inspected against a live connection activation,
and its recommended plugins were held to the same rule. The draft was always the
authoritative source; the request was a copy of it that the surviving caller
could not make.

**An automation has no destinations of its own.** The one place a result goes
because of what the automation *is* rather than what a run *does* is the room
that owns a `workstream`-scoped one, and that follows from ownership, not from
anybody choosing it. Everything outside Rally — an inbox, a channel, a DM, a
document — is the run's to send, inside the loop, with the connector tools it
was bound, as part of doing the work. The run is told so: the system prompt's
result-delivery section names the room when there is one, so the run does not
post there twice, and says outright that nothing sends for it when there is
not, so a run that only describes an email has not sent one. What a run
chooses to send is therefore inside the loop and steered by whatever steers
the loop; the classifier below still decides whether the room hears from it.

What derivation deliberately does **not** settle is the present. A connection
can be revoked, disabled, or become another member's between drafting and
Create, so acceptance still resolves every derived plugin against the
workspace's own connections. Those refusals are the legitimate residue of the
time gap, and each has a table row so it reaches a member as an instruction.

Acceptance is two phases around one durable acceptance row, so an interrupted
activation resumes rather than restarting:

1. **Freeze.** Under one transaction: check the definition is `ready`, the
   revision matches, and no elicitation is pending; resolve connector bindings
   and the acceptance timezone; write
   `automation_acceptance` with a hash of the request; write the schedules
   paused; materialize the definition's memory tables; move the lifecycle to
   `activating`. A second acceptance is refused with
   `automation_acceptance_conflict` when it names a different definition
   revision, scope, or owning room than the row holds; one that names the same
   three is the same acceptance retried, whatever the shape of the request that
   first wrote the row. The stored hash is the fence the activation step checks,
   not the test a retry is held to: the request shape has changed once already,
   and a retry judged on the hash would strand any object a deploy caught
   `activating`.
2. **Install and commit.** Register the evaluators with WorkspaceDO, which
   answers with an `effectiveAfterEventSequence`; arm one alarm entry per
   schedule; reserve the automation's permanent email address in the Global
   registry. Then, in one transaction: record that sequence boundary, unpause the
   schedules, store the address, promote any event held during activation, delete
   the draft conversation, reset the realtime cursor, move the lifecycle to
   `active`, and enqueue the activation projection.

Between the two phases the object re-checks its own lifecycle and authority
generation and throws `automation_activation_fenced` if either moved, cancelling
the schedule entries it armed. Acceptance is therefore all-or-pause: a failure
leaves a recoverable automation with its last coherent definition rather than a
half-installed one.

**Acceptance deletes the draft conversation.** The accepted definition revision
survives; the turns, blocks, transcript facts, Bind loop rows, compiler runs,
tool receipts, staged submissions, and superseded revisions are dropped. An
accepted automation has a run history, not a conversation.

`pause` and `resume` each bump the authority generation. Pausing withdraws the
evaluator registrations, cancels the schedule entries, and refuses any event
being held for activation; resuming re-registers, recomputes each schedule's next
occurrence from now — a paused automation does not fire the occurrences it slept
through — and takes a fresh sequence boundary. Deleting an accepted automation
pauses it first, then projects `deleted` and queues one archive effect per
generated child work stream.

### Triggers

**Timers** are stored alarm entries owned entirely by AutomationAgent under the
`automation_schedule` kind. Calendar and interval arithmetic, daylight-saving
behavior, pause/resume reconciliation, and missed-occurrence policy are local to
the object; WorkspaceDO's `schedules` table no longer carries automations at all.

Before compiler or provider dispatch, schedule work, child-run provisioning, or
outbox delivery, AutomationAgent reads its regional workspace row. A non-null
`abandoned_at` is a terminal authority fence: schedules pause, live compiler
runs fail, claimed occurrences and pending outbox effects fail, and no provider
or collaborator call begins. Route admission alone is insufficient because an
already-addressed Durable Object can wake from its own alarm after membership
has ended.

**Connector events** follow one regional path:

1. A connector adapter validates and normalizes a provider event against its
   manifest, and the regional activity Queue hands it to
   `WorkspaceDO.ingestConnectorEvent`, which commits one canonical event and its
   ingress receipt.
2. A second, ID-only Queue delivery claims that event for processing. After the
   product step runs, the consumer calls
   `WorkspaceDO.matchExternalEventDestinations`.
3. The matcher selects active registrations by connection, connector type, event
   type, and `effective_after_event_sequence`, applies the audience rule, and
   evaluates each registration's typed DNF predicate with no model inference. A
   restricted activity — a private Slack channel arriving on the workspace
   connection — can never reach a workspace automation, and reaches a personal
   one only when its author is inside the audience.
4. Each match inserts one `workspace_external_event_deliveries` row, unique on
   `(event, registration, generation, destination)`, and produces one
   identifiers-and-hashes-only Queue message.
5. The consumer claims that delivery under a lease, and calls
   `AutomationAgent.admitExternalEvent` for an automation or
   `SubstreamAgent.appendWatchedResourceEvent` for a watched work stream. The
   destination rechecks its own generation and lifecycle and admits one
   occurrence, holding it instead if it is still `activating`, and refusing it if
   it arrived at or below the activation boundary.
6. WorkspaceDO records the terminal acknowledgement under the same lease.
   Duplicate, reordered, or stale wakes are harmless: the destination keeps a
   receipt per canonical event ID and answers a replay with
   `automation_occurrence_replayed`.

Automation registrations and watched-resource registrations use one candidate
index, one delivery table, and one receipt state machine. A watched work stream
sends no evaluator object — its canonical resource link already means an exact
resource-identity match — while an automation needs predicates because it selects
event families, content, people, and provider fields. Both converge only after
the destination has authorized the event itself.

Evaluator documents are versioned, strict, and branded after parsing. They bind
one declared connector connection and event type to DNF predicates over that
event manifest's allowed attributes. Unknown keys, operators, attributes,
plugin/event pairs, duplicate IDs or keys, non-finite numbers, empty values and
groups, and wrong scalar kinds are rejected at every boundary. Missing fields
make ordinary positive and negative predicates false; only `presence.not_exists`
matches absence. Matching is case-sensitive and performs no coercion. Connector
manifests, not evaluator code, own the allowed event and attribute vocabulary, so
adding a connector grows declarations and fixtures rather than adding another
execution substrate.

**Inbound email** arrives at the automation's permanent address (see
[`workstream-email-addresses.md`](workstream-email-addresses.md)). The regional
ingress screens it against the agent *before* fetching the message — replay,
lifecycle, and address are decidable from the webhook alone — and again once the
sender has been resolved, and only then stores the payload and creates the
resource. The address is a routing identifier every member can see, so screening
first is what stops a stranger's mail from making Rally store unbounded
attacker-titled objects. `admitInboundEmail` then re-runs every check inside the
transaction that consumes the hourly budget and writes the receipt.

**Manual runs** come from `POST /automations/:id/run` with an `idempotency-key`
header; the agent reuses the run and work stream a repeated key already claimed.

### Generated runs

A claimed occurrence is provisioned by the object's own alarm lane. Provisioning
bootstraps the work-stream runtime, creates the child work stream, appends the
opening input where the trigger has one, admits a harness run, and activates the
persistent loop with one immutable `AutomationRunContextV1`.

Generated runs are private SubstreamAgent-backed work streams. They are absent
from the work-stream sidebar and appear as content-free rows on the automation's
own page. **Every generated run is `scope: "personal"` with the automation's
author as its only participant, whatever the automation's own scope** — a child
run is a nested execution record, not a workspace room.

The child receives the frozen context and returns only a terminal receipt. It
reads and mutates parent memory over generation-fenced RPC — the parent refuses a
call whose harness run ID does not match the run it is addressed for — delivers
its own result to the frozen destinations, and reports each destination through
`recordDeliveryReceipt`.

**Whether it delivers at all is decided once, by the parent.** Before the
delivery loop runs, the child calls `resolveRunDisposition` with the result text;
the parent classifies it on the `automation_result_disposition` model role and
stores the answer on the run — `disposition`, `disposition_source`,
`disposition_reason`, `disposition_at`. The decision lives with the automation
because everything it reads is the parent's state: the definition, the trigger,
and what the last three occurrences were judged to be. A `done` disposition
withholds every destination and writes the classifier's own sentence into each
`skipped` receipt, so the run history says why nobody was told rather than
leaving a bare code to interpret. A classifier that cannot answer **delivers**,
recorded as `default`: a spurious delivery is noise somebody can see, and a
swallowed result is silence nobody knows to look for. The columns are the
idempotency — a delivery retry after a crash reads the stored answer instead of
judging the same occurrence twice. Provider writes inside a generated run additionally
re-check the parent's *live* lifecycle and authority generation, so a run that
outlives a pause or a delete stops rather than finishing on stale consent.

### Projections and the socket

Every lifecycle change enqueues a `workspace_projection` effect in the object's
own outbox. The alarm delivers it to `WorkspaceDO.applyAutomationProjection`,
which compares `(authorityGeneration, projectionVersion)` and discards anything
not strictly newer; equal coordinates with a different payload hash are a
conflict, not an overwrite. `projection_version` is a counter separate from the
realtime `event_sequence`, because acceptance resets that cursor and a projection
version that went backwards left the directory describing a live automation as an
unfinished draft forever.

An `attention_code` travels on the same projection and is the one thing the
directory says about an automation that is *wrong* rather than merely paused. It
is one of three reasons — `unsupported_trigger` for a legacy trigger the new
grammar cannot express, `legacy_runtime_error` for an automation the old runtime
had left in `error`, and `run_projection_integrity_conflict` for a run whose
terminal receipt disagreed with what the parent already recorded. **The server
sends the reason and never the sentence.** The words live in
`apps/desktop/src/renderer/lib/automation-attention.ts`, beside the rest of the
product's copy, so the wording can be rewritten without reprojecting every
automation that already carries a reason — and so nothing a person reads was
written for whoever was debugging the cutover. `unsupported_trigger` is the only
one that says the automation will not run again; the other two are recoverable.

The draft screen holds one WebSocket to the agent, admitted through the ordinary
ticket flow (`GET /automations/:id/agent/socket`, then an upgrade at
`/socket/automations/:id`). The room accepts through Cloudflare's hibernation
API, consumes the ticket ID once in its own SQL, re-checks the session and
membership against D1, and admits only the automation's **author**. It sends a
snapshot on connect and rebroadcasts on every durable change.

### The one-shot cutover

**This ran on 2026-08-28 and the deploy steps that carried it are gone.** What
follows is the record of what the cutover did, kept because the mechanism still
governs any workspace that has to be cut over by hand; it is no longer a
description of what a deploy does. An operator running it now invokes
`scripts/cutover-automation-agents.mjs` directly with the Cloudflare credentials
the deploy job used to assert — see
[`runbook.md`](runbook.md#deployments-and-release-workflows) for the shared-queue
hazard to check first.

It shipped in one merge and one coordinated deployment, and the workflow refused
to deploy a single region while the cutover was pending — a build whose authoring
refuses in the region it skipped, and whose legacy timers never fire there again,
is worse than no deploy.

Inside that deploy job, before either Worker was replaced,
`cutover-automation-agents.mjs --preflight` compared each region's D1 workspace
inventory (read in keyset pages, because an unpaged D1 query silently truncates)
against the Durable Object namespace listing, refused a mismatch, and woke every
stored WorkspaceDO by opaque ID through the existing migration-command Queue.
That established a historical migration ledger, which is how the new build tells
a genuinely fresh object from a carried-over one.

The workflow then deployed EU, deployed Global, applied Worker-first D1
migrations, and checked both health endpoints. `--apply` sends one named,
idempotent cutover command per workspace through the same Queues. Each WorkspaceDO witnesses and
hashes every value the destructive half can remove, checks the draft inventory it
was told to expect, imports each accepted automation into its named
AutomationAgent, verifies the returned receipt hash, re-hashes the source to
prove nothing moved underneath it, then drops the legacy schema and records
completion in `automation_cutover_campaign` — a table outside the removed schema,
so a retry rolls forward from durable receipts and an ordinary object wake can
never perform cleanup. Legacy drafts are discarded rather than imported; a legacy
`error` status becomes `paused` plus an attention code, and a trigger the new
grammar cannot express becomes an `unsupported_trigger` attention code.

The apply loop waits one poll interval before its first backlog read — Queue
metrics are eventually consistent, and an immediate read can report the
pre-dispatch count and "prove" a drain that never happened — and refuses any
increase in either region's dead-letter queue. In the 2026-08-28 release a second
two-region health check followed it; an operator running the script by hand
checks regional health themselves.

A workspace born on the new build still creates the legacy tables, because they
live in WorkspaceDO's frozen migration 1 and a released migration is never
edited. It drops them in the same statement that writes its identity row, and
marks its campaign `completed` with source hash `fresh`, so only carried-over
objects require the explicit import.

D1 remains identity, membership, routing, migration control, audit, and
telemetry storage — not a product-state fallback.

## Invariants

- **One automation is one object, for its whole life.** Acceptance changes a
  lifecycle column in place. Anything that mints a second ID at promotion breaks
  every run, receipt, memory row, and email claim keyed on the first.
- **Every refusal an automation route answers goes through the error table.** A
  refusal the object throws is mapped by `withAutomationErrors`; one the service
  decides for itself is raised with `automationRefusal`; one a collaborator
  raises as an `ApiError` inside the object is recognised by shape after the RPC
  hop, because the class does not survive it. A bare `throw new Error(code)`
  outside a wrapper, or an `ApiError` nobody re-reads on the other side of RPC,
  is a `500 internal_error` and "An unexpected error occurred" — a permanent
  refusal wearing the one status a client retries, logged beside real faults.
  `withAutomationErrors` is for calls that can *refuse*; a call whose failures
  are all faults keeps its 500 rather than being dressed as a conflict.
- **Acceptance derives what the draft decided; it never takes it in a request.**
  The bindings and plugins an automation is created with come from the stored
  definition through `automationAcceptanceSelections`. A request field
  restating any of them is a second source of truth for a fact the draft already
  settled, and the way this failed is instructive rather than hypothetical: the
  fields outlived the wizard that filled them, the one surviving caller sent
  empty values, and acceptance read those as decisions. Two of the four failed
  loudly and two silently, which is why "it errors" is not the test — an
  automation created successfully and doing less than the card described is the
  worse outcome.
- **A `ready` draft is one acceptance will not refuse for anything the draft
  itself settles.** `automationDraftAcceptanceBlocker` is called by
  `admitAuthoredDraft` and again by `prepareAcceptance`; a check either end
  applies alone will drift, and what drift looks like here is a proposal card
  whose Create button cannot work, with nothing on it for the person to act on.
  Anything about the *present* — whether a named plugin still resolves to a
  healthy connection the caller may bind — is deliberately not in that
  predicate, because a draft cannot answer it and acceptance must.
- **A directory row locates; it never authorizes.** `automation_directory` holds
  no definition, no instructions, and no run content, and every content read goes
  through the agent, which re-checks the author or asks WorkspaceDO to authorize
  the viewer. Serving anything from the projection makes a stale row an access
  decision.
- **The authority generation is the fence for everything asynchronous.** Pause,
  resume, and delete each bump it. An occurrence, a memory mutation, a delivery
  receipt, or a provider write carrying an older generation is refused. Adding an
  asynchronous path that does not carry it lets work from a withdrawn automation
  land after it was withdrawn.
- **A projection coordinate only ever increases.** Both writers — the Worker
  seeding the first draft row and the object's outbox — draw the version from the
  object's one monotonic counter. A second source of that number silently drops
  updates, because WorkspaceDO's comparison is the only thing standing between a
  reordered delivery and a wrong sidebar.
- **An event is admitted once, by canonical event ID.** `automation_trigger_receipts`
  is keyed on it, so a Queue redelivery, a lease expiry, and a duplicate match all
  resolve to the same occurrence.
- **Nothing crosses an object boundary except identifiers, generations, versions,
  and hashes.** The delivery Queue message names a delivery, not an event body;
  the child returns a receipt, not a result.
- **Acceptance is idempotent on the facts the row stores.** Two acceptances
  that differ in definition revision, scope, or owning room are a conflict;
  ones that agree on all three are the same acceptance retried, across a change
  in the request's shape.
- **The socket is the author's.** A workspace-scoped automation is readable by
  every member and manageable by owners and admins, but its live draft room
  admits only `author_user_id`. Widening it would put an unaccepted draft's
  conversation in front of people who cannot read it over REST.
- **The cutover is one-shot and irreversible.** `removeLegacyAutomationSchema`
  drops tables. There is no dual-write, no legacy fallback, and no rollback to
  the previous authority; a failure is retried forward from the campaign ledger.

## Boundary

This module owns the whole automation: authoring, compilation, acceptance,
lifecycle, schedules, occurrence admission, generated-run provisioning, run
history, automation-owned memory, inbound-email admission, result-delivery
receipts, and the workspace projection.

It depends on WorkspaceDO for four typed things: minting an automation ID against
a creation key, holding the directory row, evaluating and fanning out connector
events, and authorizing a non-author viewer — **and for every workspace-product
table it reads**. That second half is not a list, because a list of it has now
been wrong twice: `connector_connections`, `slack_user_links` and `resources` are
each read through `withWorkspaceRuntimeDatabase`, and the whole compiler turn
already runs on an env wrapped that way, whose reads reach `resources` joined to
`connector_connections`. The invariant is what to remember: **any statement this
object sends that names a `WORKSPACE_LOCAL_TABLES` table belongs to WorkspaceDO
and goes through the port; regional D1 holds identity, membership and sessions,
and nothing else.** Regional D1 has not had the product tables since migration
0090. It depends on the Global `workstream_email_routes` registry for its
address, on regional D1 for identity, membership, and sessions, and on
SubstreamAgent for the execution of a generated run.

It does not own: the shared template catalog (`automation-service.ts`, and the
`automation_templates` rows survive the cutover); the connector manifests that
define what an evaluator may name ([`connectors.md`](connectors.md)); the agent
loop a generated run executes ([`agent-harness.md`](agent-harness.md)); the
ordered-transcript schema its draft conversation is stored in
([`ordered-transcript-sqlite.md`](ordered-transcript-sqlite.md)); the ticket and
upgrade contract ([`realtime-sockets.md`](realtime-sockets.md)); or how a result
email is addressed and rendered
([`workstream-email-addresses.md`](workstream-email-addresses.md)).

## Failure modes and limits

- **A failure inside the object is a stable snake_case code, not a message.**
  `automation-agent-errors.ts` maps each one to a status and a sentence — 403 for
  an access or authority mismatch, 404 for an unknown automation, 409 for a busy
  compiler or a stale draft, 422 for a schedule with no future or an unknown time
  zone, 503 while a workspace is mid-cutover. An unmapped code that still looks
  like one of ours answers 409 generically; anything else keeps its 500, because
  a fault nobody has reasoned about must not be answered as a retryable
  conflict. Two refusals are decided in `AutomationAgentService` before any RPC
  is made — a create request with no draft id, and a submitted draft that no
  longer matches the stored definition — and they read the same table through
  `automationRefusal`. Raising either as a bare `Error` puts it outside the one
  wrapper that consults the table, which is the whole difference between a
  sentence and a 500. The table is a *refusal* table: its statuses are 403, 404,
  409, 422 and 503, so a call whose failures are all faults — `WorkspaceDO`'s
  `applyAutomationProjection`, whose worst case is two writers disagreeing about
  a coordinate the directory already holds — is deliberately left unwrapped
  rather than given a 409 a client will retry.
- **A derived plugin whose connection has gone** refuses the create:
  `automation_plugin_unavailable` when the workspace has no healthy connection
  for it, whether a recommended plugin or an event source,
  `automation_workspace_connection_required` when a workspace-scoped
  automation would bind a personal one. These are the legitimate residue of the
  gap between drafting and Create, they cannot be moved earlier, and each has a
  table row so it reaches a member as an instruction rather than as the generic
  conflict every untabled code used to produce.
- **The compiler fails or is interrupted.** The run settles as `failed` and stays
  the visible outcome until another turn is admitted — hiding it made a failure
  look like a successful idle reconnect. **Retry** re-arms the dispatch alarm for
  the same run; **Stop** cancels it.
- **A run cannot be provisioned.** The alarm's two lanes — provisioning and the
  projection outbox — each keep their own failure and the first is rethrown after
  both have had a pass, so a disabled connector cannot stop the directory
  projection or the child-archive effects a delete depends on. The run returns to
  `claimed` and the entry retries behind the shared alarm backoff.
- **An outbox effect fails.** It returns to `pending` with an incremented attempt
  and the shared exponential delay. An effect kind nothing can deliver is marked
  `failed` rather than retried forever ahead of the effects behind it.
- **The regional workspace is abandoned.** The operational fence retires every
  local execution lane before external work starts. If D1 cannot answer, the
  object fails closed and leaves the alarm retryable; it does not infer that the
  workspace is operational. Once abandonment is observed, pending local work is
  terminalized rather than retried into a workspace that admission has closed.
- **A delivery is claimed twice.** The second claim is answered `busy` with the
  lease's expiry and retried after it; settlement is fenced by the lease token,
  so an expired handler cannot overwrite its successor.
- **Too much mail.** Each automation admits at most
  `AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR` inbound runs per clock hour, counted in
  the same transaction that writes the receipt; over it, the message is receipted
  as `email_rate_limit_exceeded` and no run is created.
- **The cutover's drain wait is deliberately open.** `AUTOMATION_CUTOVER_DRAIN_TIMEOUT_MS`
  in `scripts/cutover-automation-agents.mjs` is `+Infinity` and carries a
  `LIMIT UNSET` marker: the guard exists and the number is the team's. Until it
  is set, a drain that never completes hangs whoever ran the script — an
  operator's terminal, not a release, since 2026-08-29. A deterministically
  failing message is not what hangs it; the queues carry five retries and a
  dead-letter queue and the loop already fails on any rise in that count. A slow
  fleet-wide drain does, and so does a backlog held above zero by the migration
  tracker's own fan-out into the same queue. See
  [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md).
- **A workspace has not been cut over yet.** Authoring answers 503
  `automation_cutover_in_progress` rather than writing into an object whose
  legacy source has not been imported.
- **A run receipt whose hash disagrees with the recorded one** sets
  `run_projection_integrity_conflict` on the object and broadcasts it to an open
  socket, but does **not** enqueue a projection of its own. The directory picks
  the code up on the next lifecycle change that projects — a pause, a resume, an
  activation — so until then the sidebar row shows nothing wrong while the
  automation's own page does. Every projection reads the code as the object
  currently holds it rather than sending a constant, which is what stops a pause
  from clearing an imported automation's marker; the gap is only in *when* the
  first projection carrying it goes out.

## Testing

| Suite | Command | Covers |
| --- | --- | --- |
| `apps/api/test-workers/automation-agent.test.ts` | `pnpm --filter @rally/api test:workers` | On real workerd: identity plus the first turn plus one compiler admission committed before dispatch; evaluator replacement and its receipt in one transaction; an event-driven authored submission refused when its rules are absent or empty, exempted while the draft is not ready, and admitted through to acceptance once they are set; acceptance in place deleting only the draft conversation; generation-fenced memory with replayed write receipts; a memory table keeping its identity across revisions; the id-only accept creating the automation the object holds for a manual draft and for an external-event one whose source binding comes only from the draft, binding the plugins a draft recommends, refusing a recommended plugin with no connection, a directory membership refusal answering 403, an `ApiError` raised inside the object surviving the RPC hop with its own status, and workspace abandonment retiring compiler, schedule, run, and outbox lanes before external work. |
| `apps/api/test-workers/automation-acceptance-bindings.test.ts` | `pnpm --filter @rally/api test:workers` | On real workerd, with `connector_connections` in WorkspaceDO and deliberately absent from D1: binding the plugins a draft recommends at acceptance, refusing one the workspace has no connection for, binding the live connection when a disabled row still holds the same plugin id, and the service answering a detail rather than an unmapped 500. Its first test asserts the table is absent from D1, because that absence is what makes the rest evidence. |
| `apps/api/test-workers/automation-cutover.test.ts` | `pnpm --filter @rally/api test:workers` | A fresh WorkspaceDO reaching the final schema with no legacy lifecycle tables, and an import that discards audited drafts and replays cleanup safely. |
| `apps/api/test-workers/external-event-routing.test.ts` | `pnpm --filter @rally/api test:workers` | One accepted event and one matcher serving an automation and two watched work streams. |
| `apps/api/test/external-event-evaluator.test.ts` | `pnpm --filter @rally/api test` | The pure predicate: legal and illegal documents, missing-field semantics, and the connector vocabulary. |
| `apps/api/test/automation-run-context.test.ts`, `automation-connector-bindings.test.ts`, `run-authority-validity.test.ts` | `pnpm --filter @rally/api test` | The frozen run context and its destinations, connector binding validation, and the live-generation re-check before a provider write. |
| `apps/api/test/resend-inbound-email.test.ts`, `workstream-email-routing.test.ts` | `pnpm --filter @rally/api test` | Pre-fetch and post-sender screening, admission receipts, and the address claim. |
| `apps/api/test/access-revocation.test.ts` | `pnpm --filter @rally/api test` | The workspace fan-out reaching AutomationAgent. |
| `apps/desktop/src/renderer/lib/use-automation-agent-socket.test.tsx`, `screens/new-automation.test.tsx`, `screens/automation-overview.test.tsx` | `pnpm --filter @rally/desktop test` | Snapshot fencing against the compiler stream, the stable route, and both adapters. |
| `scripts/cutover-automation-agents.test.mjs` | `pnpm test:scripts` | Argument modes, paged inventory, the DLQ refusal, and the drain deadline (driven with a finite value, since the shipped one is open). |

Traps worth knowing before writing one here. The `test-workers` D1 starts with no
schema, so a test that exercises membership or sessions declares those tables
itself; anything that depends on a checked-in migration belongs in the Node
suite. That freedom cuts both ways — see the general warning in
[`testing.md`](testing.md#declaring-a-table-the-region-does-not-have): declaring
a WorkspaceDO table in the D1 fixture makes a mis-routed statement pass. The
delivery-target file's first test asserts the absence rather than trusting a
comment. And an automation alarm armed at `now + 1` can fire while a test is still
arranging state — park it in the same `runInDurableObject` invocation that admits
the work, as [`durable-object-alarms.md`](durable-object-alarms.md) describes;
settling the compiler run in that same invocation is what makes a drain after an
eviction a no-op rather than a real provider call. A test that reaches acceptance
addresses WorkspaceDO, and an object never addressed refuses every caller with
`workspace_object_identity_mismatch` — call `initializeWorkspace` first rather
than patching the agent's `workspace()`, which only works from inside
`runInDurableObject`.

## Data model

`AutomationAgent` SQLite, seven migrations:

| Version | Adds |
| --- | --- |
| 1 | Identity and state, draft message metadata, compiler runs, definition revisions, pending and staged elicitations, staged submissions, draft evaluator sets, tool receipts, realtime events, schedules, acceptance, runs, trigger receipts, the effect outbox — plus `ORDERED_TRANSCRIPT_SCHEMA_V1` and the shared alarm table. |
| 2 | Delivery receipts and automation-owned memory items, tables, columns, rows, and mutations. |
| 3 | The one-shot legacy import receipt. |
| 4 | The email route row and the preserved legacy memory records. |
| 5 | Inbound-email receipts and hourly rate windows. |
| 6 | Fenced memory items and complete mutation receipts. |
| 7 | One-time socket ticket receipts, the monotonic `projection_version`, and the per-turn projection coordinate. |

`WorkspaceDO` migration 22 adds `automation_creation_claims`,
`automation_directory`, `workspace_external_event_registrations`,
`workspace_external_event_deliveries`, and `automation_cutover_campaign`. The
cutover then drops `automation_subscriptions`, `automation_runs`,
`automation_delivery_targets`, `automation_resources`,
`automation_email_receipts`, and `automation_email_rate_windows`, rebuilds
`schedules` without its automation column, deletes private templates, and deletes
`memory_scopes` of kind `automation`. Shared `automation_templates` and
`automation_template_versions` survive. [`data-model.md`](data-model.md) is the
map of both authorities.

## Regional impact

Every object name is `<region>:<workspaceId>:automation:<automationId>` and the
constructor asserts the object's jurisdiction against `AVALON_REGION`, so an
automation cannot be addressed from the wrong region. Connector payloads, draft
turns, memory, and run content stay in the workspace's region. The one
cross-region call is the email-address reservation, which reaches the Global
`workstream_email_routes` registry and carries the address and opaque owner IDs
only. Queue messages between objects carry identifiers, generations, versions,
and hashes.

## Security and trust model

An automation's socket, REST reads, and every RPC re-derive authority from the
object's own identity row rather than from the caller's claim. Reads authorize
the author directly or ask WorkspaceDO whether the viewer may see a
workspace-scoped automation; management (`pause`, `resume`, `delete`,
`PATCH`) additionally admits a workspace owner or admin, but only for a
workspace-scoped automation — a personal one is its author's alone and an admin
role does not reach into it. Creating a workspace-scoped automation requires
owner or admin at acceptance.

Inbound mail is untrusted: the From header can be spoofed, so the sender must
resolve to an active workspace member, and to the author for a personal
automation. That screening is the whole control. An inbound-email run holds the
same tools as any other trigger.

It did not always. The run used to omit every connector write tool and the
outbound web tools, which read like a boundary and was not one: a
`connector_activity` run reading an equally untrusted third-party page kept both,
so the rule hardened one channel out of several and described a protection the
system did not have. Removing it is a deliberate acceptance of the residual
risk, which is prompt injection in the body of mail a member legitimately sends
or forwards. That risk is not new and is not specific to mail — it is the same
risk any connector content carries — and it is now handled in one place for all
of them rather than by a rule that named only this one.

Alarm failures log a `diagnosticErrorCode`, never the thrown message: an alarm
lane runs the compiler and connector tools, so the error reaching the handler can
quote a provider's prose and, through it, the workspace's own retrieved content.

Losing access closes an open room. The room admits on a ticket and never
re-authorizes, so the [access-revocation queue](access-revocation.md) is the only
thing that ends a live automation feed; `WorkspaceDO.revokeSocketAccess` now
returns the automation IDs alongside the work-stream IDs and the consumer fans
out to both.

## Operations

The automation section of [`runbook.md`](runbook.md) owns the cutover and its DLQ
handling. The cutover ran on 2026-08-28 and is no longer part of any deploy, so a
failed preflight, cutover command, or rising dead-letter backlog is now an
operator-run failure rather than a release failure — it stops the person who
invoked the script, and nothing else. What has not changed is that there is no
dual-write fallback and no rollback to legacy authority: the remedy for a
workspace found holding legacy state is to run the script again, which is
idempotent per workspace.

## Changelog

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

### 2026-09-03 — Acceptance takes an ID, and derives the rest from the draft

**What changed:** `POST /automations`, `AutomationAgentService.accept` and
`CreateAutomationRequestSchema` are deleted. `POST /automations/:id/accept` is
the only way an automation is created, and `acceptDraft` no longer accepts
`defaultPluginIds`, `activitySourcePluginIds` or `deliveryTargets`:
`automationAcceptanceSelections` reads all three off the stored definition.
`automationDraftAcceptanceBlocker` is one predicate called by
`admitAuthoredDraft` and again by `prepareAcceptance`. Five previously untabled
codes gained rows. The model's `requestedDelivery` vocabulary narrows to
`email`. `isExternalEventTrigger` becomes a type predicate.

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
