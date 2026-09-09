# Resident context

The context-residency ledger: content the model needs in context that has a
stable identity, a durable record of where it currently lives, and a policy for
how it survives compaction. Its first kind is a checked-out repository's own
working instructions, the `AGENTS.md` files the Terminal plugin discovers; the
ledger, its transitions, and the harness port that renders it know nothing about
files, so a second kind (a skill body, say) is a registry entry rather than a
mechanism. The product requirements are in
[the repository-instruction-files PRD](PRDs/2026-09-08_repository-instruction-files/prd.md).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/resident-context/blocks.ts` | The pure core: the kind registry and its policies, the block row shape, the residency transitions a compaction applies, the one message shape, the prompt-section renderer, code-point truncation, and the two open limits. |
| `apps/api/src/durable-objects/workstream-resident-context-storage.ts` | The ledger over the conversation object's SQLite: record a load, invalidate a kind, drain pending deliveries, render the committed or proposed prompt sections, apply a compaction once per event. |
| `apps/api/src/durable-objects/workstream-resident-context-protocol.ts`, `apps/api/src/runtime/resident-context-port.ts` | The `residentContext` object-port authority a producer of blocks uses: what is resident, record a load, invalidate. Resolves in-object under the persistent loop. |
| `apps/api/src/services/terminal/instruction-files.ts` | The Terminal kind's discovery primitives: the candidate chain from a set of touched paths, and the probe script a sandbox command carries. |
| `apps/api/src/services/terminal/instructions.ts` | The Terminal plugin's glue over the port: build a probe fragment from the known-resident set, split and sanitize the trailer, record, refuse a mutation. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` (`settlePendingSteersAtStep`, `commitBindCompaction`, `bindMessagePositionsBySourceKind`) | Derived inputs appended at the settled step in the same commit that closes them; the compaction commit that carries the ledger's transitions; the positions the summariser must not see. |
| `apps/api/src/durable-objects/substream-agent.ts` (`persistentLoopRuntime`, `settlePersistentLoopStep`) | Drains pending deliveries into the settled step, serves `renderResidentContext` and `prepareResidentContextCompaction`, applies the compaction transitions inside the checkpoint's transaction. |
| `packages/agent-harness/src/index.ts` (`HarnessResidentContext`), `bind-runtime.ts` | The host port: `render()` placed last in the stable system prompt; `prepareCompaction()` before the summary turn, whose answer shapes the compacted system message and the summariser's input. |

## How it works

A **block** is `(kind, id, sha256)` plus its bounded content and where it lives:
`transcript`, `system`, or `none`. A **kind policy** supplies what differs
between kinds: the prefix lifetime in compactions, the heading and preamble the
prompt section prints, the locator a block id renders as, and the reader tool an
omitted or truncated block points at. `repository_instructions` has lifetime two
and renders `./<path>`.

**Load.** A producer finds a block and calls `recordLoaded`. A block already in
context at that content is reported as already resident and nothing happens.
Otherwise every other content for the same id is retired (a transcript block to
`none`, a prompt-resident one flagged `superseded` so the prefix does not change
mid-run), and the new block is written in `transcript` residency with a pending
delivery. The Terminal kind loads from a probe that rides the tool's own sandbox
command: after a read, or before a mutation in `abort` mode, where a candidate
that is not yet resident stops the command with exit 52 before anything
changes and the tool returns `instructions_pending`. The probe's JSON trailer
starts with a marker minted for that one invocation, and the parser is handed
the same value; the tool's own output, which is untrusted and precedes the
trailer, cannot contain it. The repository bootstrap,
the moment a checkout exists, probes the root the same way for a fresh clone
and a restored one.

**Delivery.** At the next settled step, `settlePersistentLoopStep` reads the
pending deliveries and hands them to `settlePendingSteersAtStep` as derived
inputs. Each becomes one `protocol_user_appended` transition, ahead of any
participant steer, with provenance `derived` / `<kind>` / `<id>@<sha>` and the
message `Instructions added from <locator>:` followed by the content. The rows
are closed in the same transaction; a delivery whose provenance the loop has
already projected is closed without a second message. The message lands at the
transcript tail, where it costs nothing the provider has already cached.

**Compaction.** Before the summary turn the harness calls `prepareCompaction`
with the compaction event id and the current head. The object answers with the
sections the ledger *would* render once the transitions in `blocks.ts` have run
(a pure computation, nothing written) and the projected positions of every
message the ledger owns. The harness renders the compacted system message from
those sections, gives the summariser the transcript without those positions
(the ledger carries them forward itself), and builds the replacement
transition; the object applies the transitions inside `commitBindCompaction`'s
transaction, keyed by the event id so a replayed commit changes nothing. From
the next turn the section is part of the new stable prefix. A block stays there
for its kind's lifetime, then leaves; a superseded block leaves at the first
compaction after its edit. A retired block is not forgotten: its row stays at
`none`, and the next load is a change of residency rather than a discovery.

**Invalidation.** A kind's source can be replaced wholesale, as a Terminal
checkout is by `terminal_checkout_repository`. `invalidateKind` moves every
block of the kind to `none`, pending deliveries included. This is the one
transition that changes the prefix mid-run; the old repository's instructions
have no successor message to supersede them.

## Invariants

- **Content enters the system prompt only at a compaction.** During an
  uncompacted run a block is a tail message and the section is a pure render of
  committed ledger state that changes only through `applyCompactionInTransaction`
  or `invalidateKind`. The provider's cached prefix is already lost at a
  compaction, so the move rides that eviction.
- **A block is delivered once per content per residency cycle.** The key is
  `(kind, id, sha256)`; the settled step deduplicates by provenance against what
  the loop already projected; a compaction, a source invalidation, or an edit
  restarts the cycle.
- **Recording and delivering are each one transaction, and a failure of either
  is visible.** A row and its pending flag are written together; the append and
  the close happen in the settlement commit; the compaction transitions ride the
  checkpoint commit. Probe failure, by contrast, is best-effort by contract and
  never decides a tool's or a bootstrap's outcome.
- **Every candidate is contained in its own right.** The probe refuses a symlink
  or a non-regular file and a real path outside the root per candidate, not by
  inheritance from the touched path, and reports the refusal as
  `not a regular file` without reading. Content that is read passes
  `sanitizeTerminalOutput` before it is stored.
- **The prefix and the summary do not both carry a block.** Messages the ledger
  owns are excluded from the summariser's input by their durable provenance
  positions, so a block cannot outlive its residency through a paraphrase in the
  checkpoint.
- **The ledger knows no kind's semantics.** `blocks.ts` holds the registry and
  the transitions; storage, port, harness, and settlement are the same for every
  kind. Adding a kind is a registry entry and a producer.

## Boundary

This document owns the ledger, its transitions, the port, the harness's
`residentContext` seam, and the Terminal kind's discovery. It does not own the
Terminal sandbox, its tools, or the bootstrap
([`terminal-workspaces.md`](terminal-workspaces.md)); the compaction trigger,
summary prompt, or checkpoint shape
([`context-compaction.md`](context-compaction.md)); the persistent loop and its
fences ([`agent-harness.md`](agent-harness.md)); or the prompt-authoring rules,
including the exception this subsystem introduces
([`writing-prompts.md`](writing-prompts.md#12-layer-authority-explicitly)).

## Failure modes and limits

- A probe that errors, or a ledger call that fails while recording, logs through
  `terminal_instruction_probe_failed` and leaves the tool's or bootstrap's own
  outcome alone; the next touch retries, and the root is rediscovered by every
  chain and by the next run's `refreshed` bootstrap.
- A mutation whose governing file is not resident returns `instructions_pending`
  having changed nothing; the instructions are recorded, arrive with that batch,
  and the retry proceeds. Reads never wait. `run_command` and `import_resource`
  probe in a command of their own before the mutation, since neither the model's
  command nor the resource bridge can carry the fragment; every other tool's
  probe rides its own command.
- Two limits are defined and, at the time of writing, open placeholders in
  `blocks.ts`, per
  [`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md):
  `MAX_RESIDENT_CONTEXT_BLOCK_BYTES` (one block's content, cut on a code-point
  boundary at or below it, applied in TypeScript after an unbounded read and
  passed to the probe only when finite) and `MAX_RESIDENT_CONTEXT_SECTION_BYTES`
  (one kind's whole prompt section as emitted, heading and preamble included;
  blocks are dropped from the leaf end until it fits, and the ones left out
  are named one per line, or counted on one line when naming them would not
  fit). The heading, preamble, and counting line are the section's floor: a
  bound below it admits nothing and still emits the floor. The PRD says the
  implementing change does not ship until
  both are finite, because this change introduces the allocation and the
  `content` column's eventual `CHECK` is not an inert site; the numbers are the
  team's and are asked for in the pull request.
- Chain depth needs no cap: the candidates are the ancestors of a touched path.

## Testing

`apps/api/test/terminal-instruction-files.test.ts` runs the real probe under
`bash` and `python3` against a temp directory, including the planted
`AGENTS.md -> .git/config` symlink, and covers the chain, the renderers, and the
transitions. `apps/api/test/workstream-resident-context-storage.test.ts` runs the
ledger against the real migrations: once-per-content recording, superseded
prompt blocks, the lifetime count, replayed compaction events, and invalidation.
`apps/api/test/workstream-transcript-storage.test.ts` proves a derived input is
appended at the settled step, closed in the same commit, and not appended twice
on replay. `apps/api/test/terminal-runtime.test.ts` runs the real probe and
ledger through the runtime's simulated sandbox: the read that delivers the
root, the refused first mutation and its retry, the probe before a command's
durable task, and the checkout that retires everything.
`apps/api/test/terminal-repository.test.ts` proves the bootstrap carries the
probe after the checkout and records the root.
`packages/agent-harness/src/index.test.ts` proves the compacted system message
carries the prepared section, the summariser's input omits the owned positions,
and the persisted checkpoint carries neither.

## Data model

One table and one marker table in the conversation object's SQLite, added by
substream migration 51 beside the run-scoped tables:

| Column | Meaning |
| --- | --- |
| `kind`, `block_id`, `sha256` | The key. `sha256` is the content hash, or `unreadable:<reason>` for a candidate that exists but could not be read. |
| `source_generation` | Kind-specific invalidation token; the Terminal work-space generation for files. |
| `content`, `truncated` | The bounded, sanitized text that was delivered, and whether it is a prefix of the source. |
| `residency`, `superseded`, `compactions_remaining` | Where the block lives and how many compactions its prompt residency has left. |
| `pending_delivery` | Recorded but not yet appended at a settled step. |
| `first_delivered_at`, `last_delivered_at` | The bookkeeping of what this conversation has loaded. |

`resident_context_compactions` holds one row per compaction event whose
transitions were applied. No backfill: every existing conversation starts with an
empty ledger, which is correct because none has been delivered a block.

## Security and trust model

Blocks are untrusted content in both places they can appear. The message is a
user-role derived input like every other outside content the harness admits;
the prompt section is the one exception to
[`writing-prompts.md`](writing-prompts.md#12-layer-authority-explicitly)'s rule
that content never enters the system message, taken knowingly in the PRD and
bounded three ways: only at a compaction, only under a heading that names the
content as subordinate to everything above it and to any participant, and only
for the kind's lifetime. Neither the heading nor `sanitizeTerminalOutput` is a
role-isolation boundary, and nothing here claims one; what a block can do is
governed by the standing sentence in the Terminal plugin's system message and
by the tool loop, which no block can widen. Per-candidate symlink refusal and
`realpath` containment are what keep a repository from planting
`AGENTS.md -> .git/config` and having the probe deliver the checkout's Git
credential header.

## Changelog

### 2026-09-09 — The section bound measures the emitted section, and the probe marker is a nonce

**What changed:** `renderResidentContextSections` sizes the whole section it
emits (heading, preamble, separators, admitted blocks, omission notice) against
`MAX_RESIDENT_CONTEXT_SECTION_BYTES`, dropping blocks from the leaf end until
it fits and falling back from one named line per omitted block to one counting
line when the names would not fit. The Terminal probe prints a marker minted
per invocation (`instructionProbeMarker`) instead of a fixed string, and the
parser is handed the same value.

**Why:** Review of the implementing pull request found both. The first render
counted only the admitted block bodies, so a finite bound would have been
exceeded by the fixed text and by every omission line, and enough omitted
blocks could grow the section without limit under a bound meant to cap it. The
fixed marker was searched for anywhere in stdout, and everything before the
trailer is repository-controlled: a file or a command printing the marker would
have truncated the tool's output at that point and hidden the real trailer
behind it. The nonce closes both; the alternative of parsing only the last
occurrence was rejected because a probe that failed to print would then have
let planted bytes stand in for it.

**What a future change has to respect:** The floor (heading, preamble,
counting line) is emitted even under a bound that cannot hold it; the bound's
derivation has to stay above the floor. The marker prefix is fixed so a test
can recognise a marker, but the parser matches only the full value it was
handed, never the prefix.

### 2026-09-09 — Document created

**What changed:** The context-residency ledger, its Terminal kind, the derived
input at the settled step, and the harness `residentContext` port shipped
together, implementing
[the repository-instruction-files PRD](PRDs/2026-09-08_repository-instruction-files/prd.md).

**Why:** A repository's `AGENTS.md` says how it wants to be worked on, and Rally
ignored it unless the model happened to read it. Delivering it at the tail keeps
the cached prefix intact; moving it into the prefix only at a compaction, the
one moment that change is free, is what lets it survive compaction without
paying prefix churn mid-run.

**Considered and rejected:** Carrying the content in the tool result (no
harness change, but lower salience than every other derived input); rendering
it as a skill (the right shape, but first-party trust origin and a prefix write
on every load); a post-commit hook for the compaction transitions (the
projection is already durable by then); filtering the summariser's input by
harness-side provenance (the harness keeps none per message; the object's
`bind_loop_state_messages` join is exact); a Terminal-owned table and port (the
same rows under a name a second producer could not reuse).

**Consequences:** Both limits are open placeholders and the PRD says the change
does not ship until the team sets them. `run_command` and `import_resource` pay
one probe command before the mutation. Adding a second kind means a registry
entry in `blocks.ts` and a producer that calls the port; nothing in storage,
settlement, or the harness changes.
