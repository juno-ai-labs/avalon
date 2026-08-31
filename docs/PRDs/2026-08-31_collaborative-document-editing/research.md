# Prior art: collaborative documents in `monad`

Investigation carried out 2026-08-31 against `juno-ai-labs/monad` at its current
`main`. This document records what that implementation actually does and what it
learned the hard way. It informed [`prd.md`](prd.md) and
[`design.md`](design.md); it is not itself a proposal, and it is not a
description of Rally.

`monad` is a Next.js application on Postgres with its own Node WebSocket server.
Its documents live inside "canvases" and are edited in a rich-text editor. It
carries twelve documents on the subsystem, several of them long; the ones this
investigation drew on are the collaborative-editing protocol design and
implementation notes, the broadcast protocol, versioning, markdown projection,
authorship, agent mutations, architecture direction, and known limitations.

## 1. The engine is a CRDT, and it is the second one

The premise this work started from was that `monad` had built an operational
transformation system. It has not, at any point.

Their protocol design opens by rejecting both bespoke engines: it recommends
adopting **Loro**, a maintained CRDT library, and building a schema and
operation vocabulary above it. The document is explicit that the word "hybrid"
in its title refers to mixing CRDT primitives — a movable tree, a sequence, a
map, a register — and not to any blend of OT and CRDT.

The history underneath that is more useful than the recommendation. They shipped
first on **Yjs**, a different CRDT, with the standard editor integration. The
defects that forced a rewrite were not in Yjs and not in the editor: they were in
the layer translating between them. Their implementation notes list what died on
cutover — the editor's collaboration and cursor wrappers, every direct import of
the Yjs runtime, and the markdown projector's Yjs path — and record that Yjs was
removed entirely in a migration after a one-shot bulk translation of every
existing document. Loro is now the only engine, at version 1.12.

The editor survived both engines untouched. **TipTap**, a wrapper over
ProseMirror, is the framework in both eras, and their notes give the reason
plainly: the bug surface lived in the translation layer, so replacing the editor
would have cost the entire extension catalog and bought no convergence
correctness. That is evidence about layering, and it is why
[`design.md`](design.md) puts the same seam in the same place.

## 2. What "saving" means there

This is the question that prompted the investigation, and their answer separates
three things that all sound like saving:

**Live state.** Every keystroke is an operation: applied, persisted, and
broadcast immediately. There is no save action and no save moment. Closing a
laptop mid-sentence loses nothing.

**Snapshots.** A compacted copy of the document written after every hundred
operations. This is a performance artifact — it bounds how much a rejoining
client has to replay — and it is never user-visible. Their FAQ makes the
distinction explicitly, because it is the one people get wrong.

**Versions.** The user-visible, addressable, immutable history, in a table whose
rows point at snapshot bytes. Four kinds:

| Kind | Created by | Retained |
| --- | --- | --- |
| `named` | A person naming a milestone | Forever |
| `autosave` | A maintenance job promoting an idle snapshot | A retention window, then swept |
| `revert` | Reverting to an earlier version | Forever |
| `snapshot_pin` | Reserved; no consumer yet | Forever |

So typing does not produce V2. Typing produces a continuously durable document,
and versions are the milestones a person can name, diff, and return to. The
autosave job runs every ten minutes and promotes a snapshot into a version only
when the document has been idle and something has changed since the last
version — attaching a row to bytes that already exist rather than writing new
ones.

**Reverting is append-only.** Reverting to v3 while on v5 inserts v6, pointing at
a fresh copy of v3's bytes, with its parent recorded as v5 and its revert source
as v3. v4 and v5 stay visible with their original timestamps and authors.
Nothing is rewritten or deleted; the document's live state is rewound and every
connected editor is told to drop what it has and rejoin, which does discard
un-acknowledged local typing — a cost their own gotchas call out and surface in
the UI by naming who reverted.

**The behavior worth copying outright**: before any agent edit whose diff is
non-empty, they automatically capture a *named* version labelled "Before edits by
\<agent\>", attributed to the agent, taken before a single operation applies. Named
versions are visible by default while autosaves are hidden behind a toggle, so a
bad agent rewrite is always one click from the state the agent saw. It is
best-effort — a failure logs and the edit proceeds — because the edit is the
user-visible outcome.

## 3. How the rest of it is built

**The room.** A per-document in-memory CRDT instance inside a stateless server,
with a FIFO promise chain serializing every apply, a subscriber set for local
sockets, and Postgres `LISTEN/NOTIFY` fanning operations to other nodes. Rooms
are lazy — created on first join, evicted when the last editor leaves — and
compaction takes a Postgres advisory lock so two nodes cannot compact the same
document at once.

The hardest bug class they document comes from this shape. Their operation
table's primary key is a bigserial allocated non-transactionally, so a lower id
can commit *after* a higher one has already advanced a high-water mark, and a
catch-up query keyed on that mark skips the late row permanently. The fix is to
catch up by per-replica frontier difference instead of by id, and their document
spells out the silent-loss chain that follows from getting it wrong: a snapshot
gets stamped with a frontier its bytes do not cover, the next join computes a
tail from the too-high frontier and omits the missing operation, and the pruner
then deletes the row.

**Markdown is server-authoritative.** The CRDT is the truth; a single server-side
projector walks it and produces the markdown that search indexes, agent prompts,
sidebar previews, and export all read. Clients never supply markdown, for two
stated reasons: a client could otherwise send text nobody typed and have it
indexed and fed to a model, and multiple consumers need byte-identical output
for deduplication and change detection to work. The client's only markdown-related
message is a content-free hint that the server might want to re-project.

The projector has two subtleties they shipped as corruption bugs first: adjacent
runs must be coalesced before marks are emitted, or a uniformly bold span
fragments into stray asterisks; and whitespace must be hoisted outside emphasis
delimiters, because CommonMark requires the delimiter to touch a non-space
character. Escaping is context-aware — escaping every special character
corrupted identifiers and paths and broke their agent's exact-match editing tool
against text it had just written itself.

**Agent edits are markdown-shaped.** Two tools: a whole-document replace and a
string replace, the second implemented on top of the first. The agent reads
projected markdown and writes markdown back. Their stated reasons are that
asking a model to emit structured operation envelopes with valid parent
references and per-replica ordering is fragile, that a markdown tool contract
stays stable while the protocol underneath changes, and that reading and writing
the same representation gives the model one mental model. Their string-replace
matcher falls back to a normalized comparison that strips CommonMark escapes, so
the agent's unescaped text still matches the projector's escaped storage.

**Presence** is a separate awareness channel: cursor position, selection range,
colour, and the block being attended to, fanned out to peers and to other nodes,
persisted nowhere, with an explicit "left" message so peers drop a caret.

**Authorship** — who typed each character — is a mark inside the document, with
the author assigned server-side from the socket session rather than claimed by
the client. That server-side assignment replaced a client-side stamping plugin
whose interaction with the sync layer produced a family of bugs; the notes list
three whole failure modes the move rules out by construction.

## 4. Scale, and what it cost

Measured at the current `main`, excluding tests:

| Area | Lines |
| --- | --- |
| Client CRDT binding, protocol types, projector, diff | ~16,000 |
| Editor UI components | ~15,000 |
| Room, sync, and agent-apply server modules | ~4,000 |
| Version and prune data layer | ~1,100 |

One file — the outbound translator — is over 5,000 lines on its own, and their
architecture review says that file is built on the wrong primitive.

Their known-limitations document is the clearest cost signal in the repository:
nineteen numbered entries against the editor binding, most now resolved,
including several that were silent data loss rather than visible breakage —
typing into a new document saving nothing, a plain-text paste dropping its entire
contents, pressing Enter creating no block, and edits typed during a
disconnection being discarded. Two remain open: views diverging under
contention, and list indent and blockquote re-nesting not translating.

## 5. The finding that changed the plan

Their architecture-direction document, written after the audit and preserved as
a decision record, concludes that the outbound translator's whole approach —
watching editor transactions and pattern-matching their step shapes — "is the
wrong primitive". The editor emits several different step shapes for the same
logical edit, so each new extension introduces shape variants nobody has seen,
and every unrecognized variant either falls back to a full re-render or drops
the user's intent entirely. The canonical approach, which the upstream Yjs
integration has used since 2018, is to diff the editor's new state against the
CRDT's state and generate operations from that diff.

They have since shipped the diff-based translator. Their notes on when to do it
are worth reading before scheduling any equivalent work here: they deliberately
did not refactor until the extension surface had stabilized, because adding
block types and editor affordances before the refactor would have meant redoing
the new translator with each one.

For Rally, the conclusion arrives before the code does. That is the single most
valuable thing this investigation produced.
