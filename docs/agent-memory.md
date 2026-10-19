# Agent memory

Agent memory is what Rally remembers on its own from the conversations it takes
part in, and what a person asks it to remember or forget. A background **sweep**
reads a window of a Thread, Breakout or Sidekick conversation after it settles
and asks a strong model which facts to record, revise or retract; the facts live
in `WorkspaceDO`, each filed under a subject (the Organization, a Channel, a
Thread, a Breakout, a person, a Sidekick) and carrying the conversations it was
learned from. Three tools let a run recall, remember and forget. Nothing is
recalled automatically at run start in this release; the per-activation digest
is the next rollout step of the PRD.

The promise this module makes: **a fact reaches a reader only while they may
open every conversation it came from today, and only when its subject admits
them.** Visibility is computed at read time from the directory `WorkspaceDO`
already keeps, never from a scope the model names. Read this before changing the
fact store, the sweep lane, the tools, or anything that decides who may see a
conversation.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/workspace-memory-facts-storage.ts` | The store: migration 116, the visibility rules (`openableBy`, `subjectAdmits`, `sourcesOpenToAudience`), recall, remember, forget, sweep candidates and `applyMemorySweep`. Every rule about who sees a fact is here. |
| `apps/api/src/durable-objects/workspace-memory-facts-protocol.ts` | The typed RPC shapes, the subject and reader vocabularies, `memorySourceOf`, the sweep operation schema and refusal codes. |
| `apps/api/src/durable-objects/workspace-do.ts` | The five RPC methods (`recallMemoryFacts`, `rememberMemoryFact`, `forgetMemoryFact`, `memorySweepCandidates`, `applyMemorySweep`) and the person reader's relationship read. |
| `apps/api/src/durable-objects/workstream-scheduling-storage.ts` | `memory_sweep_state`: the cursor, the rest, the claim, the settle, the release and the alarm's retry time (conversation-object migration 76). |
| `apps/api/src/services/memory-sweep-service.ts` | The lane: `attemptMemorySweep` (gates, claim, one Queue send) and `runMemorySweep` (window, candidates, model, apply, settle). The open limits. |
| `apps/api/src/services/memory-service.ts` | The `rally:memory` tools (`recall`, `remember`, `forget`), the trust class of a remembered fact, and the scope resolution `rally_tables` still uses. |
| `packages/agent-harness/src/prompts/memory-sweep.ts` | The sweep prompt and its strict JSON schema. Golden-hashed in `prompts.test.ts`. |
| `apps/api/src/durable-objects/substream-agent.ts` | The two triggers: the settlement step after the description loop, and the alarm lane (`nextMemorySweepAt`). |
| `apps/api/src/queues/activity-consumer.ts` | The `memory_sweep` Queue branch. |
| `apps/api/src/services/memory-scope-cache.ts`, `workspace-memory-storage.ts` | The scopes and typed tables of `rally_tables`, unchanged by this module and documented in [`agent-harness.md`](agent-harness.md#scoped-durable-memory). |

## How it works

### A fact

One or two plain sentences, with: a `subjectKind` and `subjectId`; a `kind`,
`standing` (true until it changes) or `situational` (with a `validUntil` and the
basis for it: `stated`, `event`, `assumed`); an optional `validFrom` for
something that starts later; `derivedFrom`, the trust class of what established
it (`person`, `agent`, `external`, or `mixed` after an update joined two);
`conflict`, set when two people disagree and the fact states both positions;
`evidence`, transcript sequence numbers; and `sourceConversations`, one or more
of `<channelId>` (a Thread's Main), `<channelId>/<breakoutId>`,
`sidekick:<automationId>`, `space:<spaceId>`. A fact is never without a source:
an Organization fact was promoted *from* somewhere, and that somewhere decides
who may see it. A fact is **active** while it is not retracted, not superseded,
and not past `validUntil`; an upcoming fact (`validFrom` in the future) is
active and is shown as such.

### The sweep

**Trigger.** `settleAgentRun` calls `attemptMemorySweep` after the description
loop's step, for conversations whose parent is a Thread or a Sidekick (a
Channel's own feed is not swept: PRD non-goal 9). The conversation object's
alarm calls the same attempt when `memory_sweep_state.retry_at` is due.

**Gate**, cheapest first: model access; the conversation exists and is not
archived; the window since the cursor holds at least
`MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES` person messages with
`MEMORY_SWEEP_MINIMUM_PERSON_CHARACTERS` between them (agent turns and tool rows
never count); the conversation has rested (`rest_until`). A rested-later
conversation with enough behind the cursor sets `retry_at = rest_until` so the
alarm comes back; every other skip clears `retry_at`, which is what keeps the
alarm from waking into the same answer.

**Claim.** `claimMemorySweep` pushes `rest_until` to the floor and records the
range *before* anything is sent, the description loop's claim: two runs settling
together spend one sweep, and a failing model is not retried by every run behind
it. A claim in flight blocks the next for `MEMORY_SWEEP_CLAIM_TIMEOUT_MS`; after
that a lost delivery is presumed and the next run may claim. The claim leaves
`retry_at` at its rest, so a delivery lost together with its release is claimed
again by the alarm at the rest rather than waiting for an unrelated run to
settle; a settle or release moves `retry_at` first. The claim is one
`ACTIVITY_QUEUE.send` of `{ type: "memory_sweep", region, workspaceId,
parentKind, parentId, substreamId, fromSeq, toSeq, attempt }`; a failed send
releases the claim.

**Run** (`runMemorySweep`, in the consumer). Re-read the window through the
message port from `fromSeq` minus an overlap of context messages to `toSeq`,
dropping tool rows and empty rows and labelling authors person, external, agent
or system. Ask `WorkspaceDO` for the **placement** (the conversation's subject,
its Thread, the Channels it sits in, whether it is Organization-wide, the
speakers who may be the subject of a `person` fact) and the **candidates**:
active facts on the conversation's subjects matching the window's terms, plus
every active situational fact on those subjects, **restricted to facts every
current participant of the conversation may open and whose subject the
placement admits** (`sweepVisibleFacts`: an Organization fact only in an
Organization-wide conversation, a Channel fact only for a Channel every
participant may list, a person fact only for a speaker). Render the prompt, call
`runStructuredInference` on role `memory_sweep` (flag
`agent-model-memory-sweep`, default the primary model, metered `memory_sweep`,
Organization pays). The model returns a flat list of operations (`add`,
`update`, `confirm`, `retract`); the service drops incoherent rows (an `add`
without text, an `update` without an id), converts horizons to instants, mints
one fact id per operation, and calls `applyMemorySweep` with the speakers and
the candidate ids it was handed.

**Apply**, one `WorkspaceDO` transaction. Compare `fromSeq` with the stored
receipt's `to_seq` for this conversation: behind it, the range was already
applied and the stored receipt is answered; ahead of it, a range was skipped and
`cursor_ahead` names the stored `to_seq`; equal, the operations apply in order.
An `add` is refused by code when its subject is wider than the placement allows
(`subject_above_placement`), names a Channel or person outside it
(`subject_id_not_in_placement`), or is situational without a horizon
(`horizon_required`). An `update`, `confirm` or `retract` is refused when the
fact is not among the candidates this sweep was handed, or is no longer one
every participant may open under a subject the placement admits
(`fact_not_candidate`), or is missing or inactive; the model reads a fact id off
an untrusted transcript as readily as off the candidate list, so the list the
store returned is the only one it accepts back. An `update` inserts a new fact
that supersedes and links
its predecessor and carries the union of both facts' sources. The receipt
(`memory_sweep_receipts`, one row per conversation) is written in the same
transaction and the refusals are returned, not thrown.

**Settle.** The consumer moves the conversation's cursor to the receipt's
`toSeq` with `settleMemorySweep`, a compare-and-swap on the claimed `fromSeq`
that is a no-op at an equal `toSeq`, so a redelivery after a committed apply
finishes from the receipt rather than wedging the conversation. A sweep that
wrote rests at the floor; a quiet one doubles the rest up to the ceiling. On
`cursor_ahead` the cursor is rewound to the store's `to_seq`. A model or store
failure releases the claim (`retry_at = rest_until`) and rethrows; the consumer
acks either way, because the conversation's own claim decides when it is tried
again.

### Visibility

Computed inside `WorkspaceDO` at every read, in TypeScript over small batched
SQL (one query per source kind over a JSON list, never one per fact):

1. **Sources.** The reader may open every conversation in
   `sourceConversations` today: a Thread's Main by `mainOpenableSql`, a
   Breakout by `channelListedSql` and `breakoutListedSql`, a Channel's feed by
   `spaceListedSql`, a Sidekick by its scope, authorship, execution, or its
   home conversation ([`listing-rules.md`](listing-rules.md)).
2. **Subject.** An `organization` fact needs `admitsOrganizationWide` (a
   member, never a guest); a `channel` fact needs that Channel listed to the
   reader; a `person` fact is the reader's own only; `thread`, `breakout` and
   `sidekick` facts need nothing beyond their sources.
3. **Audience.** Inside a conversation, every fact but the reader's own
   `person` facts must also be one every current participant may open, so a
   Breakout member acting in the Thread above is not handed the Breakout's words
   where others read the reply. An Organization-wide conversation's audience is
   every member, answered structurally (the source itself must be
   Organization-wide); a private one's is its participant list, intersected.

A reader is a person (resolved to their relationship: access class and whether
they administer), a Sidekick (opens itself and its home; sees Organization facts
only when its scope is `workspace`), or the conversation itself (a workspace
principal acting in a Thread, which reads what every participant may). The FTS
index never grants access: hits are reloaded and filtered before they leave the
object.

### The tools

`rally:memory` (wire prefix `memory_`) is preloaded in every root run of a
Thread Main, a Breakout, and a Sidekick's conversation and runs; an inline child
reaches nothing (`resolveMemoryAccess` answers it an empty union, the gate every
tool call passes).

- `memory_recall(query, limit?)`: FTS over the subjects of the run's
  conversation plus the acting person, filtered by the rules above, best match
  first, `limit` at most 25 (default 10). Each fact is rendered with its
  subject's display title, its horizon, `expired`, `upcoming`, and its first
  source's title. Nothing found is an empty list.
- `memory_remember(text, kind, validUntil?, about?)`: writes one fact under
  the acting person (`about: "me"`) or the conversation's own subject. The
  trust class is the input that started the run (`derivedFromOf`): a Slack or
  email trigger writes `external`, an agent exchange `agent`. A sentence that
  matches an active fact on the subject word for word, among the facts the
  reader may see from here, returns that fact with `deduplicated: true`; a
  match they can no longer open is written again, since a dedupe against it
  would report a memory recall could never return. Every active fact of the
  subject is compared, not a page. Idempotent on the provider key: a replay answers from
  `memory_fact_receipts`.
- `memory_forget(factId)`: retracts, when the reader may. A person forgets
  their own facts and what the conversation they stand in established; a
  Channel's or the Organization's facts take an administrator (owner or admin);
  a Sidekick forgets what came from itself and its home. Seeing a fact never
  implies the right to retract it.

Failure codes: `memory_horizon_required`, `memory_horizon_forbidden`,
`memory_personal_unavailable`, `memory_fact_not_found`,
`memory_fact_not_visible`, `memory_fact_not_forgettable`, and
`memory_unavailable` when the object cannot be reached, whose cause is logged
as `memory_tool_unavailable`. Argument shape is the harness's `validateInput`
hook, which names the field.

### The import

Migration 116 turned every live row of the retired `memory_items` store into a
standing fact the agent recorded (`derived_from = 'agent'`, `created_by =
'import'`):

| scope kind | subject | source |
| --- | --- | --- |
| `user` | `person`, owner | provenance `workstreamId` when it is a thread, else the owner's Personal Channel, else General |
| `workstream` | `thread` (or `sidekick`, when the owner is a Sidekick) | the owner |
| `sidekick` | `sidekick`, owner | `sidekick:<owner>` |
| `workspace` | `organization` | provenance `workstreamId` when it is a thread, else General |

A row whose source could not be named (a `user` item whose owner was never
seated in an Organization with no General yet) was not imported. Production held
nine items in one Organization and none to one elsewhere when this shipped.

## Invariants

- **Every fact has at least one source, and the source decides who reads it.**
  Breaking it (a null source, a fact copied without its sources) would let a
  conversation narrowed to private keep leaking what was said in it. Guard: the
  `json_array_length > 0` check on `memory_facts`, and
  `test-workers/memory-facts.test.ts` ("hands a sweep only the facts every
  current participant may open").
- **The model never names a scope, subject owner, or conversation.** The run's
  frozen principal and conversation decide; the only ids a tool accepts are
  fact ids it was handed. Breaking it lets a prompt widen what a run reads.
  Guard: the tool input schemas and `test/scoped-memory.test.ts`.
- **A fact may be filed no wider than its conversation's placement.** An
  `organization` fact needs an Organization-wide conversation; a `channel` fact
  a Channel the conversation sits in; a `person` fact a listed speaker. Breaking
  it promotes a private room's words to everyone. Guard: `applyMemorySweep`'s
  refusal codes, `test-workers/memory-facts.test.ts`.
- **Candidates and updates are fenced by the audience and the placement.** A
  sweep is handed only facts every participant may open under a subject the
  placement admits; an `update`, `confirm` or `retract` must name one of those
  candidates; and an update carries the union of sources, so a public Thread's
  sweep can never restate a private Breakout's words under the public source,
  and a fact id quoted in a transcript cannot reach a fact the sweep was not
  shown. Guard: `sweepVisibleFacts` and `candidateFactIds` in
  `memorySweepCandidates` and `applyMemorySweep`; the workerd suite above.
- **The cursor fence is the store's, not the consumer's.** A range is applied
  once; a replay answers from the receipt; a gap is refused. Breaking it
  double-writes facts on a Queue redelivery. Guard: `test-workers/memory-facts.test.ts`
  ("applies a sweep once behind the cursor fence…").
- **Every attempt moves `retry_at`.** The alarm lane reads nothing else, and
  an attempt that left it where it was would wake the object into the same
  answer forever (`onScheduledAlarmStalled`). Guard:
  `test/memory-sweep-service.test.ts` asserts the row after each path.
- **`memory_scopes` stays.** The typed tables of `rally_tables` reference it;
  `MEMORY_SCOPE_DEPENDENTS` and `WORKSPACE_FENCED_TABLES` feed frozen
  migrations and are not edited. Guard: migration hashes.
- **Forgetting is authorized apart from seeing.** Guard:
  `test/memory-facts-tools.test.ts` ("lets a member forget their own facts…").

## Boundary

Owns: the fact store and its visibility rules, the sweep lane end to end, the
three tools, and the import. Exposes: the five `WorkspaceDO` RPCs, the
`memory_sweep` Queue message, `createMemoryTools`, and the prompt renderer.
Depends on: the directory projection and listing rules in `WorkspaceDO`
([`listing-rules.md`](listing-rules.md), [`spaces.md`](spaces.md)), the
conversation object's message, identity and scheduling ports
([`workstream-durable-object.md`](workstream-durable-object.md)), the
structured-inference gateway and model flags
([`feature-flags.md`](feature-flags.md)), usage metering
([`usage-metering.md`](usage-metering.md)), and the activity Queue.

Does not: inject anything at run start (PRD step 2, the digest); show facts to
people (step 3, the review surface); sweep a Channel's own feed; embed or
vector-index facts (Turbopuffer, when wanted:
[`text-search.md`](text-search.md)); own `rally_tables`
([`agent-harness.md`](agent-harness.md#scoped-durable-memory)).

## Failure modes and limits

- **Model unavailable or schema-invalid:** the run throws after releasing the
  claim; `memory_sweep_failed` names the reason (`zodDiagnosticCode` for a
  schema failure). The alarm retries at the claim's rest. No cursor moves.
- **`WorkspaceDO` unreachable from a tool:** `memory_unavailable` to the model,
  `memory_tool_unavailable` with the cause in the log.
- **Lost Queue delivery:** the claim times out after
  `MEMORY_SWEEP_CLAIM_TIMEOUT_MS`; the alarm, left `retry_at` at the claim's
  rest, claims again there, as does any settlement before it. The store's fence
  makes the late delivery, if it arrives, a replay.
- **Conversation archived or deleted between claim and run:** candidates
  answer `conversation_missing`; the cursor settles to `toSeq` with nothing
  written.
- **A model operation outside the placement:** refused by code and logged;
  the rest of the batch applies.

Limits, every one a placeholder the team has not set
([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)),
declared as `LIMIT UNSET` constants in `memory-sweep-service.ts`:

| Constant | Placeholder | What it bounds |
| --- | --- | --- |
| `MEMORY_SWEEP_REST_FLOOR_MS` | 1 hour | The quiet a conversation earns after a sweep that wrote |
| `MEMORY_SWEEP_REST_CEILING_MS` | 24 hours | The most a quiet conversation earns (floor doubling per quiet sweep) |
| `MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES` / `_CHARACTERS` | 3 / 200 | New person conversation needed for a model call |
| `MEMORY_SWEEP_MAXIMUM_WINDOW_MESSAGES` / `_CHARACTERS` | 300 / 160,000 | The window the model reads |
| `MEMORY_SWEEP_WINDOW_OVERLAP_MESSAGES` | 20 | Messages before the cursor shown as context |
| `MEMORY_SWEEP_MAXIMUM_CANDIDATES` | 60 | Remembered facts shown to the model |
| `MEMORY_SWEEP_CLAIM_TIMEOUT_MS` | 15 minutes | How long a claim holds the lane |

Arithmetic the placeholders came from: a Sol-class call on a 300-message
window costs one call per conversation per rest period, and Juno Labs' busiest
Thread settles a few dozen runs a day, so the floor bounds a Thread at roughly
one call an hour and the ceiling at one a day when nothing new was learned. The
tool-side bounds (`text` at most 600 characters, `limit` at most 25, the recall
query at `MEMORY_RECALL_QUERY_LIMIT`) are from the PRD's design and are not
defensive numbers.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test-workers/memory-facts.test.ts` | Migration 116 on a populated object at 115 (subjects, sources, FTS, the drop, the retired alarm row); `applyMemorySweep`'s fence, receipt replay and `cursor_ahead`; placement refusals; candidate and recall audience fencing. Run with `pnpm --filter @rally/api test:workers`. |
| `apps/api/test/memory-facts-tools.test.ts` | The three tools over a real `WorkspaceDO` (node:sqlite) and real conversation objects: person facts follow their person and nobody else, conversation facts stay with their subject, forget authority, dedupe, receipt replay, horizon errors. The fixture uses `migratedSqliteDatabase()` because the object reads a person's relationship from current `workspace_members`. |
| `apps/api/test/memory-sweep-service.test.ts` | The attempt's gates and claim, the Queue message, rest and `retry_at`; the run's window, candidates, prompt, apply, settle, release on model failure, replay and rewind, quiet rests. The model is a stubbed `fetch`; `WorkspaceDO` is a stub recording its calls. |
| `packages/agent-harness/src/prompts.test.ts` | The sweep prompt's golden hash, injection isolation, bounding, and load-bearing lines. |
| `apps/api/test/scoped-memory.test.ts`, `test-workers/workspace-memory.test.ts` | The scopes and typed tables this module leaves in place. |

Traps: the Node fixtures seed `channels` and `channel_viewers` by hand (the
directory projection has no Node writer), so a visibility test that forgets a
participant row reads as "not a participant", which is the production default
too. `memory_sweep_state` is created by conversation migration 76; a test
object below it has no row and `nextMemorySweepAt` reads `null`.

## Data model

`WorkspaceDO`: `memory_facts` (indexed on subject and activity, FTS5 shadow
`memory_facts_fts`), `memory_sweep_receipts` (one row per conversation),
`memory_fact_receipts` (tool replays). Conversation object:
`memory_sweep_state` (singleton). Instants are Unix milliseconds. The retired
`memory_items`, `memory_items_fts`, `memory_mutations`, `memory_index_outbox`
and `run_memory_contexts` are gone; `run_scopes.memory_context_hash` stays,
always NULL, because `run_scopes` is a referenced parent.
[`data-model.md`](data-model.md) is authoritative.

## Security and trust model

Transcript text, remembered facts, titles and names are untrusted data in the
prompt's user message; the system prompt carries policy only
([`writing-prompts.md`](writing-prompts.md)). A fact's `derivedFrom` keeps the
trust class of its evidence so a later step can keep `external` facts out of
anything injected automatically (PRD design decision 11). The model's
`subjectKind` is a request the host checks against the placement, never an
authority. `retracted_by` records who forgot a fact.

## Changelog

### 2026-10-19 — Facts, sweeps and three tools replace the scoped-memory items store

**What changed:** `rally:memory` now reads a store of facts that a background
sweep writes after conversations settle, filed under subjects and carrying their
source conversations; the tools are `memory_recall`, `memory_remember` and
`memory_forget`. The prose half of scoped memory (`memory_items`, its FTS and
Vectorize index, the index outbox, the four `memory_search/add/update/invalidate`
tools) is gone, and so is admission-time recall for every run kind. Live items
were imported as facts by migration 116. The team struck the planned
`memory-sweep-enabled` kill switch before implementation; the lane ships on and
is stopped by a revert or a deploy.

**Why:** Nine memories across every production Organization after two months,
all written by the agent choosing a scope kind, is the measurement: a memory the
model has to decide to write is one it almost never writes, and one it has to
decide to search is one it rarely finds. The scope model also made the reader
pick where to look, which is the wrong party. Admission recall had already been
removed for message runs because its embedding cost 8.5 seconds on the critical
path. The PRD's research (`docs/PRDs/2026-10-18_agent-memory/research.md`)
surveys what every comparable product does instead: observe, extract in the
background, and attach. Visibility by source is what lets facts be promoted to
a Channel or the Organization without a parallel permission system: the
directory `WorkspaceDO` already keeps answers who may open the source today.

**Considered and rejected:** Running the sweep inline at settlement, as the
description loop does its model call. A Sol-class call on a 300-message window
holds a conversation object's settlement lane for the call's duration, and a
retry policy would have to be invented there; the Queue already has one, and
the thread-backfill lane had worked out one-claim-at-a-time. Keeping Vectorize
for semantic recall: the PRD chose FTS for the first release and Turbopuffer,
the text-search pipeline, when semantic recall is wanted. A kill switch: struck
by the team as a feature flag the product does not want to carry. A
per-participant join in SQL for visibility: replaced by batched queries per
source kind, because the join grew past reading.

**Consequences:** Every limit in the lane is a placeholder (`LIMIT UNSET`); the
team owes the numbers. `memory_scopes` must stay for `rally_tables`, and the
frozen lists that feed migrations 1 and 50 are not edited. `run_scopes.memory_context_hash`
is dead weight until a migration drops it. A future digest (PRD step 2) renders
from `recallMemoryFacts` with the same visibility rules and must not invent a
second one. Anything that changes who may open a conversation changes who may
read the facts learned there, with no write: that is the design, and a cache of
visibility decisions would break it.

Shipped in #1300. Design: `docs/PRDs/2026-10-18_agent-memory/prd.md` and `design.md`.
