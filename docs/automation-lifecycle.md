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
| `apps/api/src/services/automation-agent-service.ts` | The single REST boundary. Claims an automation ID, addresses the named object, and wraps every RPC so the object's thrown code becomes an HTTP answer. |
| `apps/api/src/services/automation-agent-errors.ts` | The one table mapping an AutomationAgent error code to a status and a sentence a person reads. |
| `apps/api/src/services/automation-service.ts` | What is left of the old service: the shared **template** catalog, publishing, and version validation. It starts no runs. |
| `apps/api/src/services/external-event-evaluator.ts` | The pure DNF predicate evaluator WorkspaceDO matches registrations with. |
| `packages/contracts/src/automation-agent.ts` | Lifecycle, admission, snapshot, and `AutomationRunContextV1` contracts. |
| `packages/contracts/src/automation-evaluators.ts` | The strict, versioned external-event evaluator grammar. |
| `packages/agent-harness/src/prompts/automation-compiler.ts` | The architect's standing policy and its draft-only tool surface. |
| `apps/api/src/durable-objects/workspace-do.ts` | Migration 21: `automation_creation_claims`, `automation_directory`, `workspace_external_event_registrations`, `workspace_external_event_deliveries`, `automation_cutover_campaign` — plus the matcher and the delivery lease. |
| `apps/api/src/queues/activity-consumer.ts` | Carries a canonical event into matching and each ID-only delivery out to its destination object. |
| `apps/api/src/services/resend-inbound-email-service.ts` | Screens inbound mail against the agent before storing anything, then admits it. |
| `apps/desktop/src/renderer/screens/automation.tsx` | The stable `/automations/:id` route; `new-automation.tsx` is its draft adapter and `automation-overview.tsx` its accepted one. |
| `apps/desktop/src/renderer/lib/use-automation-agent-socket.ts` | The draft feed: ticket, snapshot, compiler stream, heartbeat, and reconnect. |
| `scripts/cutover-automation-agents.mjs`, `.github/workflows/deploy-api.yml` | The one-shot authority cutover and the deploy gates around it. |

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
  for a definition that is not ready.

An external-event definition must set evaluators before submission. Timer-only
and manual-only definitions clear staged event rules rather than calling the
evaluator tool with an empty array.

Deleting a draft bumps the authority generation, cancels any live compiler run,
marks the object `deleted`, and projects that lifecycle to the directory. It is
not archived into a second draft store.

### Acceptance

`POST /automations` re-reads the object's snapshot, refuses unless the caller's
submitted draft is byte-identical to the stored definition
(`automation_definition_revision_stale`), and calls `acceptDraft`. Acceptance is
two phases around one durable acceptance row, so an interrupted activation
resumes rather than restarting:

1. **Freeze.** Under one transaction: check the definition is `ready`, the
   revision matches, and no elicitation is pending; resolve connector bindings,
   delivery destinations, and the acceptance timezone; write
   `automation_acceptance` with a hash of the request; write the schedules
   paused; materialize the definition's memory tables; move the lifecycle to
   `activating`. A second acceptance with a different request hash is refused
   with `automation_acceptance_conflict`; an identical retry is idempotent, and
   the authorizing role is deliberately excluded from the hash so a second admin
   retrying is not treated as a different request.
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
`recordDeliveryReceipt`. Provider writes inside a generated run additionally
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

The draft screen holds one WebSocket to the agent, admitted through the ordinary
ticket flow (`GET /automations/:id/agent/socket`, then an upgrade at
`/socket/automations/:id`). The room accepts through Cloudflare's hibernation
API, consumes the ticket ID once in its own SQL, re-checks the session and
membership against D1, and admits only the automation's **author**. It sends a
snapshot on connect and rebroadcasts on every durable change.

## Invariants

- **One automation is one object, for its whole life.** Acceptance changes a
  lifecycle column in place. Anything that mints a second ID at promotion breaks
  every run, receipt, memory row, and email claim keyed on the first.
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
- **Acceptance is idempotent on its request hash and nothing else.** Two
  acceptances that differ in any hashed field are a conflict; identical ones are
  the same acceptance retried.
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

It depends on WorkspaceDO for four things and no more: minting an automation ID
against a creation key, holding the directory row, evaluating and fanning out
connector events, and authorizing a non-author viewer. It depends on the Global
`workstream_email_routes` registry for its address, on regional D1 for identity,
membership, sessions, and connector connections, and on SubstreamAgent for the
execution of a generated run.

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
  conflict.
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
- **A delivery is claimed twice.** The second claim is answered `busy` with the
  lease's expiry and retried after it; settlement is fenced by the lease token,
  so an expired handler cannot overwrite its successor.
- **Too much mail.** Each automation admits at most
  `AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR` inbound runs per clock hour, counted in
  the same transaction that writes the receipt; over it, the message is receipted
  as `email_rate_limit_exceeded` and no run is created.
- **The cutover's drain wait is deliberately open.** `AUTOMATION_CUTOVER_DRAIN_TIMEOUT_MS`
  in `scripts/cutover-automation-agents.mjs` is `+Infinity` and carries a
  `LIMIT UNSET` marker: the guard exists, the number is the team's, and until it
  is set a wedged consumer holds the deploy open until GitHub's own job timeout.
  See [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md).
- **A workspace has not been cut over yet.** Authoring answers 503
  `automation_cutover_in_progress` rather than writing into an object whose
  legacy source has not been imported.

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

`WorkspaceDO` migration 21 adds `automation_creation_claims`,
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

## The one-shot cutover

The implementation ships in one merge and one coordinated deployment, and the
workflow refuses to deploy a single region while the cutover is pending — a build
whose authoring refuses in the region it skipped, and whose legacy timers never
fire there again, is worse than no deploy.

Inside the deploy job, before either Worker is replaced,
`cutover-automation-agents.mjs --preflight` compares each region's D1 workspace
inventory (read in keyset pages, because an unpaged D1 query silently truncates)
against the Durable Object namespace listing, refuses a mismatch, and wakes every
stored WorkspaceDO by opaque ID through the existing migration-command Queue.
That establishes a historical migration ledger, which is how the new build tells
a genuinely fresh object from a carried-over one.

The workflow then deploys EU, deploys Global, applies Worker-first D1 migrations,
and checks both health endpoints. `--apply` sends one named, idempotent cutover
command per workspace through the same Queues. Each WorkspaceDO witnesses and
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
pre-dispatch count and "prove" a drain that never happened — refuses any increase
in either region's dead-letter queue, and is followed by a second two-region
health check.

A workspace born on the new build still creates the legacy tables, because they
live in WorkspaceDO's frozen migration 1 and a released migration is never
edited. It drops them in the same statement that writes its identity row, and
marks its campaign `completed` with source hash `fresh`, so only carried-over
objects require the explicit import.

D1 remains identity, membership, routing, migration control, audit, and
telemetry storage — not a product-state fallback.

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
resolve to an active workspace member (and to the author for a personal
automation), and an inbound-email run additionally omits every connector write
tool and the outbound web search and fetch tools so untrusted mail cannot be used
as an exfiltration channel.

Alarm failures log a `diagnosticErrorCode`, never the thrown message: an alarm
lane runs the compiler and connector tools, so the error reaching the handler can
quote a provider's prose and, through it, the workspace's own retrieved content.

Losing access closes an open room. The room admits on a ticket and never
re-authorizes, so the [access-revocation queue](access-revocation.md) is the only
thing that ends a live automation feed; `WorkspaceDO.revokeSocketAccess` now
returns the automation IDs alongside the work-stream IDs and the consumer fans
out to both.

## Testing

| Suite | Command | Covers |
| --- | --- | --- |
| `apps/api/test-workers/automation-agent.test.ts` | `pnpm --filter @rally/api test:workers` | On real workerd: identity plus the first turn plus one compiler admission committed before dispatch; evaluator replacement and its receipt in one transaction; acceptance in place deleting only the draft conversation; generation-fenced memory with replayed write receipts; a memory table keeping its identity across revisions. |
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
suite. And an automation alarm armed at `now + 1` can fire while a test is still
arranging state — park it in the same `runInDurableObject` invocation that admits
the work, as [`durable-object-alarms.md`](durable-object-alarms.md) describes.

## Operations

The automation section of [`runbook.md`](runbook.md) owns the cutover and its DLQ
rehearsal. A failed preflight, health check, cutover command, or increased
dead-letter backlog is a visible release failure; there is no dual-write fallback
and no rollback to legacy authority.

## Changelog

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
