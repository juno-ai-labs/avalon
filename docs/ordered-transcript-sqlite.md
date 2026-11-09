# Ordered transcript SQLite

`apps/api/src/durable-objects/ordered-transcript-sqlite/` is the one place the
canonical ordered-transcript tables are declared and the one implementation of
the canonical JSON those tables are addressed by. One Durable Object class
installs the statement array today, `AgentLoopDO`, and every conversation
Rally has, a work stream's feed and an automation's chat and runs alike, is a
`AgentLoopDO`, so they are the same rows with the same ordering rules
underneath different parents.

The promise it makes is narrow and load-bearing: **these bytes never change.**
Each host applies the array as one version of its own append-only migration
ledger, and the runner records a hash of every applied version. Editing a
statement here does not migrate anything; it warns on every deployed object's
next check without changing that object's schema. Read this before touching a
file in that folder, and before giving a second object an ordered transcript.

What the rows *mean* is owned elsewhere:
[`workstream-durable-object.md`](workstream-durable-object.md) owns the
work-stream transcript and its protocol,
[`agent-harness.md`](agent-harness.md) owns the Bind loop the
`bind_loop_*` tables project, and
[`automation-lifecycle.md`](automation-lifecycle.md) owns what an automation's
conversations are for. This document owns the shared module itself.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `ordered-transcript-sqlite/schema-v1.ts` | `ORDERED_TRANSCRIPT_SCHEMA_V1`: the frozen, ordered statement array. Counters, content-addressed payloads and facts, participant turns and blocks, the Bind loop ledger and provider boundaries, compaction checkpoints, and nested activities with their intervals. |
| `ordered-transcript-sqlite/canonical-payload-store.ts` | `canonicalTranscriptJson`, `prepareCanonicalTranscriptFact` (canonical bytes plus SHA-256 plus the derived `payload_id`), and `insertPreparedCanonicalTranscriptFact` (the one upsert into `transcript_payloads` and `transcript_facts`). |
| `ordered-transcript-sqlite/participant-transcript-store.ts` | `ParticipantTranscriptStore`: product-neutral append of one plain-text conversation turn, sequence allocation from `transcript_counters`, and an ordered read of those turns. |
| `apps/api/src/durable-objects/sqlite-migrations.ts` | The runner that applies a host's ledger and compares each version's recorded hash against the current statements. The enforcement point for the freeze. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Installs the array as `AgentLoopDO` migration 27. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | The work-stream host adapter: every richer read and write over these tables — blocks, attachments, mentions, activities, Bind states — lives here, not in the shared module. |

### One schema, one ledger today

`ORDERED_TRANSCRIPT_SCHEMA_V1` is a `readonly string[]` of `CREATE TABLE`,
`CREATE INDEX`, and one seeding `INSERT`. A host spreads it into a version of
its own migration list. `AgentLoopDO` added it as version 27. A second host
would ship the same bytes inside its own version and end up with the same
physical schema even though its ledger numbered it differently; the first
automation object did exactly that until it was deleted on 2026-09-03.

The runner hashes each version's statements when it applies them and compares
the stored hash on every later wake. That is what makes the array immutable in
practice rather than by convention: a whitespace change to one statement emits
`substream_agent_do_schema_hash_mismatch:27` with both fingerprints on the next
check of every deployed work-stream agent. Construction continues, so a change
to these tables still needs a **new** versioned delta appended to each host's own
ledger to make old and new schemas converge.

### Content-addressed facts

A transcript row never stores its own content. `prepareCanonicalTranscriptFact`
serializes the payload with `canonicalTranscriptJson`, takes its SHA-256, and
derives `payload_id` as `payload:<audience>:<hash>`.
`insertPreparedCanonicalTranscriptFact` then writes the payload
`ON CONFLICT(audience, payload_sha256, byte_length) DO NOTHING` and the fact
row keyed by `fact_id`, and every ordering table references `fact_id`. Two
identical payloads therefore occupy one row, and the same fact re-prepared from
the same input produces the same id — which is what makes a replayed append
idempotent rather than duplicated.

`audience` (`shared`, `participant`, `model`) is part of the deduplication key
on purpose: identical bytes intended for the model and for a person are
different facts, and collapsing them would let a model-only payload be served
into a participant view.

### Canonical JSON

`canonicalTranscriptJson` sorts object keys by UTF-16 code unit — never
`localeCompare`, because the hash is content addressing and key order has to be
identical on every runtime and locale. It drops `undefined` object values,
recurses through arrays, and **throws** rather than encoding anything it cannot
represent: `transcript_non_json_value` for `undefined` at the top level or a
non-plain value, `transcript_non_finite_number` for `NaN` and the infinities.
Throwing is the point — a payload that silently became `null` would hash
consistently and hide the loss forever.

The function is written to be the hash two separate call sites can agree on
across an object boundary; the automation cutover of 2026-08-28 was its one
consumer outside transcripts and is gone.

### The participant store

`ParticipantTranscriptStore` is the only product-neutral *writer* extracted so
far, and it covers one shape: a single-text-block conversation turn. Preparation
is asynchronous (the hash is `crypto.subtle`) and the append is synchronous, so
a host can hash outside its transaction and commit inside it, preparing the
message before opening `transactionSync`. `appendPreparedMessage` returns the existing sequence
when the `turn_id` is already present, so a retried admission answers with the
coordinate it originally allocated.

## Invariants

- **`ORDERED_TRANSCRIPT_SCHEMA_V1` is immutable.** Its bytes are inside a
  released migration hash. Editing it warns on every deployed object's next
  check but does not apply the edit to stored schemas. Restore a comment-only
  change; add a new versioned delta to the host's ledger for a real schema
  change.
- **A host adds the array as one whole version.** Splitting it across two
  versions, or reordering the statements for one host, produces a different hash
  and — worse — a physically different schema than its siblings, so a query the
  shared module makes would be right in one object and wrong in another.
- **Canonical bytes come from `canonicalTranscriptJson` and nowhere else.** A
  second sort order, or a second undefined/non-finite policy, means two hashes
  for the same payload; deduplication stops working and a replay check starts
  answering "changed" for input that did not change.
- **A fact is written through `insertPreparedCanonicalTranscriptFact`.** It is
  the pair of upserts that keeps `transcript_payloads` and `transcript_facts`
  consistent; a host that inserts a fact directly can reference a payload that
  was never written.
- **The shared module never reads a product-owned table.** It has no access to
  participants, audiences, or authorization, and adding one would make one
  host's rule apply to every host.
  Authorization is the host's, before it calls in.

## Boundary

This module owns the shared schema statements, the canonical JSON and hash, the
payload/fact upsert, and the one plain-turn writer. It exposes those to Durable
Objects inside `apps/api` only. It is deliberately not a package: its consumers
share one deployment surface, and extraction earns nothing until another surface
needs it.

It does not own reads or writes richer than a plain turn. Blocks, attachments,
mentions, tool lifecycle, activity intervals, snapshots, ranges, and every Bind
state transition are implemented in the host adapter,
`workstream-transcript-storage.ts`, rather than here. That is the current
state, not a design goal; see the changelog.

It is also **not** the canonicalizer Bind uses. `@rally/agent-harness` keeps
`canonicalizeBindLoop` for the provider-boundary hash and its own `canonicalJson`
for `canonicalToolInputHash`. Those agree with this one on key order and differ
on `undefined` — the harness encodes it as `null` where this module drops or
rejects it — so a value hashed by one must not be compared against a hash taken
by the other.

## Failure modes and limits

- **A released statement changed.** The runner warns with
  `<component>_schema_hash_mismatch:<version>` and both fingerprints on every
  check of an object that already applied it, then continues. Restore a
  comment-only edit; append a migration for a real schema change.
- **A payload cannot be canonicalized.** `canonicalTranscriptJson` throws
  `transcript_non_json_value` or `transcript_non_finite_number` before anything
  is written, so the caller's transaction never opens. The host surfaces it as
  its own failure — for a draft turn, the admission fails and the client retries
  with the same `clientMessageId`.
- **The same turn is appended twice.** The second call returns the first
  sequence and writes nothing. Nothing detects a *different* payload under the
  same `turn_id`: the fact upsert overwrites the payload reference, and the turn
  keeps its original root fact. Hosts avoid this by deriving `fact_id` from
  `turn_id`.
- **A payload is large.** There is no size limit here. `byte_length` is recorded
  and the transport-level ceiling belongs to whoever serves the row — the
  1,000,000-byte realtime frame limit in
  [`realtime-sockets.md`](realtime-sockets.md), not this module.

## Testing

| Suite | Command | Covers |
| --- | --- | --- |
| `apps/api/test/workstream-object-schema.test.ts` | `pnpm --filter @rally/api test` | The AgentLoopDO ledger, version by version, against `node:sqlite` — including the version that installs this array. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | `pnpm --filter @rally/api test:workers` | The work-stream host's use of the same tables: canonical ranges, oversized-turn envelopes, and compaction recovery. |
| `apps/api/test/workstream-transcript-storage.test.ts`, `apps/api/test/tool-transcript-durability.test.ts` | `pnpm --filter @rally/api test` | The work-stream adapter's reads and writes over these tables. |

The trap: a test that asserts on a migration *hash* is asserting on the bytes of
this file, which is the intent — if such an assertion fails after an edit here,
the edit is wrong, not the test.

## Changelog

### 2026-09-21 — Transcript migration drift warns without blocking the object

**What changed:** A changed released statement now produces the shared
structured fingerprint warning while allowing `SubstreamAgent` construction to
continue.

**Why:** A hash disagreement is evidence that checked-in history moved, but a
comment-only difference elsewhere proved that using the disagreement itself as
a constructor failure can take usable objects offline.

**Considered and rejected:** Keeping this module's hash fatal because transcript
rows are load-bearing. The hash cannot distinguish whitespace from missing DDL;
real transcript changes still require an appended migration, whose SQL and
integrity failures remain fatal.

**Consequences:** The immutable-byte rule remains, now enforced by pinned tests,
review, and an observable warning instead of availability loss. A mismatch does
not update an existing schema and is never a substitute for a forward migration.

### 2026-09-03 — The second host is gone

**What changed:** `AutomationAgent`, which installed this array inside its
migration 1, was deleted with Wrangler tag `v9`. `SubstreamAgent` is the one
host; an automation's chat and its runs are `SubstreamAgent`s under a
Sidekick hosted in `WorkspaceDO`, which installs no transcript.

**Why:** [`automation-lifecycle.md`](automation-lifecycle.md) records the
rebuild. For this module: the reason to extract the schema was a second host,
and the second host stopped needing one the moment its conversation became an
ordinary conversation object.

**Consequences:** The freeze is unchanged; the bytes are still inside a
released `SubstreamAgent` migration. The module stays extracted because
extraction cost nothing to keep and the next host, if one appears, ships the
same bytes the same way.

### 2026-08-28 — The ordered transcript schema becomes a shared module with three hosts

**What changed:** `ORDERED_TRANSCRIPT_SCHEMA_V1`, the canonical JSON and hash,
the payload/fact upsert, and a plain-turn writer moved out of the work-stream
transcript storage into `durable-objects/ordered-transcript-sqlite/`.
`AutomationAgent` now installs the identical array as its own migration 1, so an
automation's draft conversation is an ordered transcript rather than a JSON blob
on a subscription row. The automation cutover and the development seeding route
reuse the same canonical JSON for their source hashes.

**Why:** The durable automation lifecycle needed a conversation with the same
ordering, replay, and content-addressing guarantees the work-stream feed already
had. Copying the statements into a second object would have produced two schemas
that drift the first time either is fixed — and because both are inside released
migration hashes, drift is not something a later change can reconcile. Extracting
the array made the two physically identical by construction.

**Considered and rejected:** Making `AutomationAgent` a `SubstreamAgent`
subclass, which would have coupled authoring and the parent automation lifecycle
to a child execution loop. Publishing the module as a workspace package, which
buys nothing while every consumer is in the same Worker. Rewriting
`workstream-transcript-storage.ts` onto the shared module in the same change —
the automation cutover is already irreversible, and moving the work-stream
transcript's reads underneath it at the same time would have put the whole feed
at risk for a symmetry nobody had asked for.

**Consequences:** These bytes are now inside two released migration hashes, so
the freeze is stricter than it was: a change that used to strand SubstreamAgent
alone now strands AutomationAgent too, and a fourth host makes it stricter again.
Only the schema, the canonical JSON, and the plain-turn writer were extracted —
the design in the PRD also named a Bind-loop ledger, an activity store, a
snapshot store, and a kernel, and **those were cut.** Every richer read and write
is still implemented once per host over the same tables, and a fix to one does
not reach the other. Picking that scope back up needs the work-stream host's
reads moved onto the shared module without changing their behavior, which is a
change worth doing on its own and not inside another cutover. `@rally/agent-harness`
also still holds two canonicalizers of its own; the PRD's goal of one
implementation for provider hashes and transcript hashes was not reached, and a
value must not be hashed by one and compared against the other.

Shipped in the pull request for this change. Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md#shared-sqlite-module).
