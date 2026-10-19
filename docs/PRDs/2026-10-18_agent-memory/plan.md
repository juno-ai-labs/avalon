# Agent memory: implementation plan

Step 1 of the [PRD rollout](prd.md#rollout): the fact store, the sweep lane,
the three tools, the import, and the removal of admission recall. No digest
injection (step 2) and no review surface (step 3). The team struck the feature
flag on 2026-10-19 ([decision log](prd.md#decision-log)); the lane ships on.

Branch `claude/agent-memory-step-1`, one pull request.

## 1. WorkspaceDO store (migration 116)

New module pair, in the shape of `workspace-memory-storage.ts` and its
protocol: `workspace-memory-facts-storage.ts` and
`workspace-memory-facts-protocol.ts`. The migration is exported as
`MEMORY_FACTS_MIGRATION` from the storage module and referenced from
`WORKSPACE_DO_SCHEMA_MIGRATIONS` with a one-line comment.

Tables, all `STRICT`, instants as Unix milliseconds like the rest of the
object (the kept `memory_scopes`/`memory_tables*` keep their ISO strings):

- `memory_facts`: `fact_id` PK, `workspace_id` (fenced with
  `workspaceIdentityFencesFor`), `subject_kind` (`organization | channel |
  thread | breakout | person | sidekick`), `subject_id`, `kind`
  (`standing | situational`), `text`, `valid_from`, `valid_until`,
  `valid_until_basis` (`stated | inferred | default`), `derived_from`
  (`person | agent | external`), `conflict` (0/1), `confidence`,
  `evidence_json` (sequence numbers), `source_conversations_json` (non-empty
  JSON array of `<channelId>`, `<channelId>/<breakoutId>`,
  `sidekick:<automationId>`, `space:<spaceId>`), `supersedes_fact_id`,
  `superseded_by_fact_id`, `retracted_at`, `retracted_by`, `confirmed_at`,
  `created_by` (`sweep | run:<harnessRunId> | import`), `created_at`,
  `updated_at`. Index on `(subject_kind, subject_id, retracted_at,
  superseded_by_fact_id)`. FTS5 external-content table `memory_facts_fts` with
  the three triggers, the `memory_items_fts` pattern.
- `memory_sweep_receipts`: `conversation` PK, `workspace_id` (fenced),
  `from_seq`, `to_seq`, `operations_json`, `model`, `input_tokens`,
  `output_tokens`, `applied_at`. One row per conversation, the latest range.

Then the import, in SQL: every `memory_items` row with `invalidated_at IS
NULL` and an unexpired `expires_at` becomes a fact, `kind = 'standing'`,
`derived_from = 'agent'`, `created_by = 'import'`:

| scope kind | subject | source |
| --- | --- | --- |
| `user` | `person`, owner | provenance `workstreamId` when it is a thread, else the owner's Personal Channel `space:<id>`, else General `space:<id>` |
| `workstream` | `thread`, owner when owner is a thread; `sidekick`, owner when owner is a Sidekick | `<owner>` or `sidekick:<owner>` |
| `sidekick` | `sidekick`, owner | `sidekick:<owner>` |
| `workspace` | `organization`, workspace id | provenance `workstreamId` when it is a thread, else General |

A row whose source cannot be resolved (no thread, no Personal Channel, no
General) is not imported; the migration leaves it in no table, and the module
document records the rule. Then `DROP TABLE memory_index_outbox`,
`memory_mutations`, `memory_items_fts`, `memory_items` (children first), and
`DELETE FROM _internal_durable_alarms WHERE kind = 'maintenance' AND alarm_key
= 'memory_index'` so a leftover maintenance row cannot name a task that no
longer exists. Frozen lists (`WORKSPACE_FENCED_TABLES`,
`MEMORY_SCOPE_DEPENDENTS`, migration 1 statements) are not edited.

Typed RPC on `WorkspaceDO`, each `await this.initialized; parseRpcInput;
assertWorkspace`:

- `recallMemoryFacts({ reader, subjects, match, now, limit })`: FTS when
  `match` is set, else the subjects' active facts newest first; filtered by
  the visibility rule below.
- `rememberMemoryFact({ reader, fact, conversation, harnessRunId })`:
  dedupes on normalised text within the subject; answers `{ factId,
  deduplicated }`.
- `forgetMemoryFact({ reader, factId, conversation })`: outcomes `retracted |
  already_retracted | not_found | not_forgettable`.
- `memorySweepCandidates({ conversation, subjects, terms, now })`: active
  facts on the subjects matching the window's terms plus every unexpired
  situational fact on them, restricted to facts every current participant of
  the conversation may open.
- `applyMemorySweep({ conversation, fromSeq, toSeq, operations, model,
  usage, placement, now })`: the cursor fence and receipt of design §6.

Visibility, in TypeScript over small batched SQL, not one join: a fact is
visible to a reader when (a) every source in `source_conversations_json` is
openable by the reader today (`mainOpenableSql` for a thread,
`breakoutListedSql` for a Breakout, `spaceListedSql` for a Channel, the
Sidekick's own `automation_directory` scope rule for a Sidekick) and (b) the
subject admits them: `organization` needs `admitsOrganizationWide`; `channel`
needs the Channel listed; `person` is the reader's own facts only; `thread`,
`breakout`, `sidekick` need only (a). A reader is a person `{ userId,
accessClass }` or a Sidekick `{ automationId, homeConversation }`, which opens
`sidekick:<id>` and its home and sees `organization` facts only when its scope
is `workspace`. Forgetting: `person` facts by their subject; facts whose every
source is the current conversation by any participant; `channel` and
`organization` facts by an owner or admin; else `not_forgettable`.

## 2. Conversation object: sweep state (migration 76)

`memory_sweep_state` singleton in `workstream-object-schema.ts` migration 76:
`id = 1`, `swept_through_seq`, `rest_until`, `consecutive_quiet`,
`claim_from_seq`, `claim_to_seq`, `claim_attempt`, `claim_at`, `retry_at`,
`version`, `created_at`, `updated_at`. Methods on the scheduling storage,
registered in the scheduling protocol's dispatched operations:
`memorySweepState`, `claimMemorySweep` (rest re-checked inside the write, the
description claim), `settleMemorySweep` (compare-and-swap on the claimed
`fromSeq`, idempotent at an equal `toSeq`), `releaseMemorySweep` (latest
attempt only). Also a migration dropping `run_memory_contexts`.

`nextMemorySweepAt` becomes a derived alarm candidate: `retry_at` when set.
The settle step sets `retry_at = rest_until` when it skips for rest with
unswept person messages behind it, and the alarm lane runs the same attempt
function. Edits: `nextDerivedAlarmCandidates`, `armAlarmDuringRunDrain`,
`hasDueAlarmWork`, `runDueAlarmWork`.

## 3. The lane

`apps/api/src/services/memory-sweep-service.ts`:

- `attemptMemorySweep(env, { workspaceId, parentId, parentKind, substreamId
  })`: never throws. Gates in cost order: model access, identity (archived,
  Space parent skipped; `workstream` and `automation` admitted), rest, window
  (`messagesAfter` from the cursor, tool rows and empty rows dropped, authors
  labelled person/external/agent/system), person-message and character
  floors, claim, then one `ACTIVITY_QUEUE.send` of
  `{ type: "memory_sweep", region, workspaceId, parentId, parentKind,
  substreamId, fromSeq, toSeq, attempt }`. Called from `settleAgentRun` after
  the description step and from the alarm lane.
- `runMemorySweep(env, message)`: the consumer half. Re-reads the window,
  reads candidates, renders `renderMemorySweepMessages`, calls
  `runStructuredInference` (role `memory_sweep`, activity `memory_sweep`),
  validates operations against the placement (a `subjectKind` the placement
  does not allow is refused by code and skipped), `applyMemorySweep`, then
  `settleMemorySweep` with the receipt's `toSeq`. A `memory_sweep_cursor_ahead`
  refusal settles the cursor to the stored `toSeq` and returns; the next run
  re-reads from there. A model failure releases the claim; the alarm retries
  at the gate.

Floors and rests are open limits (`LIMIT UNSET` constants with the
arithmetic in the module document); the description loop's numbers are the
placeholders until the team sets them.

Prompt: `packages/agent-harness/src/prompts/memory-sweep.ts`, static policy,
placement and candidates and transcript as bounded JSON in the user message,
golden hash and injection tests in `prompts.test.ts`.

Contracts: `memory_sweep` in `AGENT_MODEL_ROLES`, `agent-model-memory-sweep`
in `AGENT_MODEL_FLAG_KEYS` (default `OPENROUTER_PRIMARY_MODEL`, the Sol-class
route), `StructuredInferenceRole`, Ace `MANAGED_MODELS` and deploy script,
pinned tests. `memory_sweep` in `METERED_ACTIVITIES` and `ORGANIZATION_PAYS`.
`memory_embedding` stays in the enum so stored events still parse.

## 4. Tools and removal

`memory-service.ts` keeps the scope half (`MEMORY_SCOPE_KINDS`, `MemoryScope`,
`ensureScope`, `resolveMemoryAccess`, `writableScope`, the scope errors) for
`rally_tables`, and replaces the item half with `createMemoryTools` producing
`memory_recall(query, limit?)`, `memory_remember(text, kind, validUntil?,
about?)`, `memory_forget(factId)` per design §2 and §4, plugin
`rally:memory` kept, wire prefix `memory`, system message rewritten.
`tool-activity.ts` labels replaced.

Deleted: hybrid search, Vectorize (`MEMORY_INDEX` binding, wrangler block,
test stubs), the index outbox and its maintenance task and alarm source,
`freezeRunMemoryContext` and the `FALLIBLE RECALLED MEMORY` message for every
run kind, `MESSAGE_ORIGIN_REASONS_WITHOUT_ADMISSION_RECALL`, the run memory
context protocol operations and storage, `memoryContextMs` and
`memoryRecallRequired` from the preparation breakdown, `memory-search-authorization.ts`
and the `resource.kind === 'memory'` branch it served. `MEMORY_EMBEDDING_MODEL`
and `isMemoryEmbeddingModel` stay in `structured-inference.ts` for text
search, with `feature` required.

## 5. Tests

- workerd: `memory-facts.test.ts` (remember, recall visibility per reader,
  forget authority, apply fence and receipt replay, migration 116 import on a
  populated object following `navigation-migrations.test.ts`), sweep-state
  claim and settle in `workstream-scheduling` coverage.
- Node: tools against a doubled WorkspaceDO RPC; `runMemorySweep` with a
  doubled model proving operations reach `applyMemorySweep` and the cursor
  settles; `attemptMemorySweep` gates; prompt golden hash, injection and
  bounding.
- Rewritten: `scoped-memory.test.ts` (tables half kept),
  `workspace-memory.test.ts` (tables half kept), `message-run-context.test.ts`,
  `workstream-harness-run-storage.test.ts`, `agent-inference-logging.test.ts`,
  `harness-run-runtime.test.ts`, `workspace-do-schema.test.ts` migration 23
  test, `workstream-object-schema.test.ts` tables, wire-name and prose
  fixtures, contracts and Ace pinned lists, alarm fixtures naming
  `memory_index`.
- Each integration test broken once in production code before it is kept.

## 6. Documents

New `docs/agent-memory.md` (module document with changelog), registered in
`docs/README.md`. Updated in the same change: `agent-harness.md`,
`data-model.md`, `automation-lifecycle.md`, `feature-flags.md`,
`usage-metering.md`, `text-search.md`, `performance-tracing.md`,
`workstream-durable-object.md`, `durable-object-alarms.md`, `agent-tools.md`,
`architecture.md`, `inference-lakehouse.md`, `dev-environment.md`,
`testing.md`, `authorization.md`, `demo-workspaces.md`, `ace.md`. `state.md`
stays at in progress until step 3.
