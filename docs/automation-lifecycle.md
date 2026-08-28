# Durable automation lifecycle

An automation is one named `AutomationAgent` Durable Object. The object is
created only when the first authoring turn is admitted, keeps the draft
conversation and compiler receipts, becomes the accepted runtime authority in
place, and owns every later trigger occurrence, run record, timer, and memory
mutation. Draft and active are lifecycle states of the same object; promotion
does not copy state or mint another ID.

This document owns automation lifecycle, authoring, execution, event routing,
and the one-shot retirement of the former WorkspaceDO automation tables.
[`automation-drafts.md`](automation-drafts.md) records the retired table-owned
design and is historical rather than an implementation guide.

## Where the code lives

- `apps/api/src/durable-objects/automation-agent.ts` is the product authority.
- `packages/contracts/src/automation-agent.ts` defines RPC, socket, lifecycle,
  run-context, and projection contracts.
- `packages/contracts/src/automation-evaluators.ts` defines and strictly parses
  connector event evaluators.
- `packages/agent-harness/src/prompts/automation-compiler.ts` publishes the
  draft-only architect tool surface.
- `apps/api/src/durable-objects/workspace-do.ts` owns the content-free directory,
  evaluator registrations, accepted connector events, and destination receipts.
- `apps/api/src/queues/activity-consumer.ts` carries connector events into the
  workspace and ID-only destination wakes out.
- `apps/desktop/src/renderer/screens/automation.tsx` is the stable lifecycle
  route; `new-automation.tsx` and `automation-overview.tsx` are its draft and
  accepted adapters.
- `scripts/cutover-automation-agents.mjs` and the API deployment workflow own the
  one-shot authority cutover.

## Authoring

Selecting **New automation** navigates to `/automations/new` and creates no
server state. Local composer text and staged attachments use the same draft
cache primitives as a new work stream. The first send carries a client creation
key and message ID to the regional API; admission mints one automation ID,
creates its named object, reserves the human turn and compiler run durably, and
returns immediately. The stable `/automations/:id` route then adopts that ID
without remounting the conversation.

The draft feed uses the ordered-turn transcript store, shared feed rows,
composer, attachment presentation, follow controller, and **Jump to latest**
control used by work streams. Its adapter deliberately omits participant,
unread, resource, and run controls. The automation adapter adds template,
review, acceptance, stop, and compiler-retry controls.

One compiler run may be admitted at a time. Provider work is dispatched from a
durable row; checkpoints, tool receipts, elicitation, cancellation, and terminal
repair survive eviction. A stale or simultaneous window cannot replace the
conversation: it may append only against the current object revision.

The architect can search and inspect people, resources, and connector
capabilities, but it cannot execute provider writes. Its state-changing tools
are:

- `automation_set_evaluator_rules`, which replaces the staged, strictly parsed
  external-event evaluator set;
- `automation_submit_draft`, which atomically writes the next compiled
  definition and references staged evaluator keys;
- `core_request_elicitation`, which records one structured unresolved question
  for a not-ready definition.

External-event definitions must set evaluators before submission. Timer-only
and manual-only definitions clear staged event rules and do not call the
evaluator tool. Receipt replay returns the prior result; changed canonical input
creates a later definition revision.

Deleting a draft tombstones the object and removes it from the workspace
directory. It is not archived into a second draft store.

## Acceptance and active authority

Acceptance reauthorizes the acting principal, resolves connections and
provider identities, freezes the accepted definition, installs timer and event
routes, and changes the same object from `draft` to `active`. It is all-or-pause:
failure leaves a recoverable paused automation with its last coherent
definition, conversation, and receipts.

After acceptance, `AutomationAgent` is authoritative for lifecycle, schedules,
occurrence deduplication, generated-run provisioning, paged run history, email
leases, result-delivery receipts, attention, and automation-owned memory.
WorkspaceDO holds content-free projections used to find the object; a stale
projection cannot authorize a read or a run.

Generated runs are private SubstreamAgent-backed work streams. They are absent
from the global work-stream sidebar and appear as content-free rows on the
automation home page. Opening one rechecks the current child audience. The
child receives one immutable `AutomationRunContextV1`, reads and mutates parent
memory over generation-fenced RPC, delivers its own result, and returns only a
terminal receipt to the parent. Deleting an automation tombstones the parent,
deletes generated children, clears routes and attention, and leaves no orphaned
navigation surface.

## Triggers and destination routing

Timers are local alarm entries owned entirely by AutomationAgent. Calendar and
interval calculations, daylight-saving behavior, pause/resume reconciliation,
and missed-occurrence policy therefore do not depend on WorkspaceDO or a timer
evaluator.

Connector events follow one regional path:

1. A connector adapter validates and normalizes an event against its manifest.
2. The regional activity Queue asks WorkspaceDO to accept one canonical event.
3. WorkspaceDO evaluates non-recursive typed DNF rules and registered watched
   resource destinations without model inference.
4. It commits one destination receipt per matching automation or watched work
   stream and sends an identifiers-and-hashes-only Queue wake.
5. The destination rereads the canonical event through a typed WorkspaceDO RPC,
   rechecks its local generation, lifecycle, watch, and audience, then admits
   one occurrence or appends one connected-activity turn.
6. WorkspaceDO records the terminal acknowledgement. Duplicate, reordered, or
   stale wakes are harmless.

Automation evaluator registrations and watched-resource registrations use the
same candidate index, event ledger, destination outbox, and receipt state
machine. A watched work stream does not send an evaluator object: its canonical
resource link already means an exact resource-identity match. Automation rules
need predicates because they can select event families, content, people, and
provider fields. Both converge only after destination-side authorization.

Evaluator documents are versioned, strict, and branded after parsing. They bind
one declared connector connection and event type to DNF predicates over that
event manifest's allowed attributes. Unknown keys, operators, attributes,
plugin/event pairs, duplicate IDs or keys, non-finite numbers, empty values and
groups, and wrong scalar kinds are rejected at every boundary. Missing fields
make ordinary positive and negative predicates false; only
`presence.not_exists` matches absence. Matching is case-sensitive and performs
no coercion.

The conformance vocabulary covers Slack channel messages and substrings;
Linear projects and project tickets; Granola notes, folders, and people; GitHub
pull requests, releases, and repositories; Notion pages and comments; and Gmail
received mail. Connector manifests, rather than evaluator code, own the allowed
event/attribute vocabulary, so adding a connector grows declarations and
fixtures without adding another execution substrate.

## Alarms, recovery, and memory

AutomationAgent extends the shared multi-alarm base. Compiler dispatch, Bind
recovery, run provisioning, schedules, inbound-email recovery, projection
delivery, activation, and maintenance each have a stored alarm key and their own
stall gate. The base orders due work by effective instant and key and always
re-arms the one native alarm to the earliest remaining reason.

Automation memory is object-local. Imported item and table contents retain
their IDs and receipts; children address them only through the parent RPC and
the run context's generation. WorkspaceDO and D1 contain no fallback copy.

## One-shot cutover

The implementation ships in one merge and one coordinated deployment. Before
either regional Worker is replaced, the deployment compares regional D1
workspace inventory with stored WorkspaceDO inventory and wakes every object by
opaque ID through the existing migration-command Queue. A mismatch or new DLQ
entry stops the deployment. This establishes a historical migration ledger so
the new build can distinguish a genuinely fresh object.

The workflow then deploys EU, deploys Global, applies Worker-first D1
migrations, and checks both health endpoints. The cutover script enumerates D1
workspaces and sends named, idempotent WorkspaceDO cutover commands through the
same regional Queues. Each WorkspaceDO witnesses and hashes its source, fences
legacy writes, imports accepted automations into named AutomationAgents,
verifies destination hashes and routes, deletes every legacy draft and its
descendants, removes imported legacy memory, and drops the old tables. It stores
completion outside the removed schema, so retries roll forward from durable
receipts and ordinary object wakes can never perform cleanup. A final regional
health check runs after both queues drain with no DLQ increase.

Fresh WorkspaceDOs bootstrap directly to the current schema and never create
the retired tables. D1 remains identity, membership, routing,
migration-control, audit, and telemetry storage—not a product-state fallback.

## Security, privacy, and regional behavior

Every object name includes the immutable workspace region. Connector payloads,
draft turns, memory, and run content remain in that region. Queue messages carry
opaque IDs, generations, versions, and hashes only. Workspace projections grant
no content access; AutomationAgent and each generated child reauthorize current
membership/audience before returning content. Watched updates require the
canonical event audience to contain every active participant.

## Testing and operations

Contract fixtures prove legal and illegal evaluator documents and connector
vocabulary. Node tests prove pure evaluation, adapters, workflow ordering, and
SQL constraints. Real-workerd tests prove AutomationAgent migration, authoring,
occurrence dedupe, event routing, cutover restart/cleanup, alarms, and object
boundaries. Desktop component tests prove shared conversation behavior and the
stable route; release acceptance also inspects the real Electron window.

Operators use the automation section of [`runbook.md`](runbook.md) for the
one-shot cutover and destination DLQ rehearsal. A failed preflight, health check,
cutover command, or increased dead-letter backlog is a visible release failure;
there is no dual-write fallback or rollback to legacy authority.

## Changelog

### 2026-08-28 — One durable authority replaces the wizard and subscription split

**What changed:** AutomationAgent now owns the complete draft-to-run lifecycle,
typed external-event rules, local timers, generated-run history, and memory. The
desktop uses one stable automation route and shared conversation primitives.
WorkspaceDO retains only regional event evaluation, watched-resource routing,
and content-free projections. The one deployment imports accepted automations,
deletes drafts, and removes the old tables.

**Why:** The former compiler loop, subscription rows, scheduler, and run work
streams split one product concept across independent authorities and exposed
implementation rows in navigation. One object provides a recoverable place to
reserve every transition while keeping connector fan-in centralized.

**Considered and rejected:** Making AutomationAgent a SubstreamAgent subclass
would couple authoring and parent lifecycle to a child execution loop; keeping
WorkspaceDO-owned automation state would preserve the backwards link and
dual-authority failure modes. Dynamic Workers were rejected because the trigger
vocabulary is declarative and must be inspectable, type-safe, and unable to run
arbitrary connector code.

**Consequences:** An automation begins only on first send, keeps one ID through
acceptance, and owns private generated children. Connector additions extend
manifests and typed fixtures. The merge is operationally irreversible after
cleanup and therefore carries its own preflight, receipts, DLQ gates, and final
health check.
