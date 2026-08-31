# Collaborative document editing — design

Companion to [`prd.md`](prd.md). The PRD argues for the change and fixes its
scope; this document carries the architecture, the wire protocol, the
materialization algorithm, the complete agent-tool contracts, and the inventory
of what is ported from `monad` versus written fresh. The prior-art findings
themselves are in [`research.md`](research.md).

Nothing here is authoritative after the build: when this ships, the durable
description moves into a module document registered in
[`docs/README.md`](../../README.md), written to the shape in
[`module-documents.md`](../../module-documents.md), and this file becomes
provenance.

## 1. Where the state lives

Three stores, each with one job.

| Store | Holds | Read by |
| --- | --- | --- |
| `DocumentAgent` Durable Object, one per document | The authoritative CRDT state: the operation log, periodic compacted snapshots, and room metadata | Only the room itself |
| `resources` / `resource_versions` in WorkspaceDO | The document's identity, its current pointers, and its complete version history | Everything else — the rail, citations, attachment tools, cleanup |
| Regional R2 | The materialized markdown of each version, and the model-readable derivative | The preview route, the attachment tools, export |

The invariant that makes this work: **the room is the only writer of live
document state, and the resource is the only address anything else uses.** No
consumer outside the room ever reads the CRDT. A consumer that wants content
reads the current version's markdown from R2 through the routes that already
serve it, which is why nothing about the rail, citations, search, compaction, or
the model's read path changes.

### 1.1 Why a Durable Object per document

`monad` runs an in-memory room registry inside a stateless Node server: a map
from document to a loaded CRDT instance, a FIFO promise chain serializing every
apply, a Postgres `LISTEN/NOTIFY` channel fanning operations to other nodes, and
an advisory lock so two nodes do not compact the same document at once. Roughly
two thousand lines exist to reconstruct one property: exactly one authoritative
writer per document, everywhere.

A Durable Object has that property by construction. Single-threaded execution
per object, no second instance, no cross-node fan-out, no advisory lock, and no
class of bug from auto-increment ids committing out of order — the hazard
`monad` documents at length, where a lower id commits after a higher one has
already advanced a high-water mark and the missing operation is silently
skipped. Their fix is a per-replica frontier diff instead of an id cursor; we
inherit the fix as a design property rather than as a bug we have to find.

Rally already runs this shape twice: `AutomationAgent` is a room per open
automation draft, opened on demand by the screen that needs it and closed with
it, and `BlockDashboardAgent` is a room per visible dashboard block with its own
purpose-scoped ticket. `DocumentAgent` is the third instance of a pattern the
codebase, the socket admission layer, and the desktop broker already support.

### 1.2 Object storage schema

Sketch level. Inside `DocumentAgent`'s SQLite:

```
document_meta        one row: resource id, workspace id, region, current
                     frontier, current snapshot id, generation, the frontier
                     last materialized, and the materialization state

document_ops         append-only: op id, replica id, lamport, author user id,
                     engine bytes, created_at.  Indexed by (replica_id, lamport)

document_snapshots   compacted state: snapshot id, frontier, bytes, created_at
```

`document_ops` is truncated behind a snapshot whose frontier causally dominates
the rows, exactly as `monad` prunes theirs. A snapshot is written after a
configured number of operations (a number for the team, per the PRD's non-goal
10) so a rejoin replays a bounded tail rather than the document's whole history.

`generation` exists for the same reason `monad`'s does: if a future change ever
rewinds a document, every persisted row is stamped with the generation current
at write time and sync queries filter on it, so pre-rewind operations stay on
disk for audit and never replay onto the new head. Nothing in this PRD rewinds a
document (non-goal 4); the column ships because retrofitting it later means
rewriting every row.

## 2. The wire protocol

One WebSocket per editor per document, admitted by a purpose-specific ticket
bound to the resource id, following
[`realtime-sockets.md`](../../realtime-sockets.md). Frames, both directions:

| Frame | Direction | Carries |
| --- | --- | --- |
| `document_join` | client → server | The frontier the client already has, empty on a first join |
| `document_sync` | server → client | The snapshot when the client has nothing, plus the operations it is missing; the room's generation |
| `document_op` | client → server | One edit: its engine bytes and the claimed author |
| `document_op_broadcast` | server → client | One applied edit, author as the server assigned it |
| `document_op_rejected` | server → client | A refused edit and why |
| `document_presence` | both | Caret position, selected range, colour — never persisted |
| `document_presence_left` | server → client | A peer disconnected; drop their caret |
| `document_leave` | client → server | Explicit close |

**Two properties are load-bearing.**

*The server assigns the author.* A `document_op` arrives with a claimed author;
the room overwrites it with the identity on the socket session before applying,
so a client cannot attribute its typing to someone else. `monad` added this as a
correction after shipping.

*Membership is re-checked per operation, not per connection.* A ticket admits
the socket; it does not authorize every edit that will ever arrive on it. Access
revoked mid-session stops the next edit.

### 2.1 Join

The client sends the frontier it has. The room answers with the operations it is
missing — and, when the client has nothing at all, the latest snapshot as well.
That second condition is not the same as "the diff is non-empty", and conflating
them is a real bug `monad` shipped and fixed: a snapshot can hold essential base
structure while its own frontier is empty, so a diff against it returns nothing,
a fresh client receives only a tail whose causal parent it never got, and the
document renders blank. The rule is: **a client with no state always gets the
snapshot.**

### 2.2 Presence

Presence frames are forwarded to the other sockets on the room and stored
nowhere. A caret carries the position, the selected range if any, and the
person's colour; the client resolves the name from the workspace directory it
already has, so a presence frame never carries a display name and a person's
name is never broadcast to someone whose directory would not already show it.
Colour is derived deterministically from the user id so the same person is the
same colour for everyone, in every document, without coordination.

## 3. The editor binding

The layering, top to bottom: React document view → TipTap extensions → the
ProseMirror document → the binding → the CRDT document → the room socket.

**The translator diffs states; it does not interpret editor steps.** This is
key design decision 7 in the PRD and the most consequential implementation
choice in the change, so it is worth stating precisely what the two approaches
are. A step-interpreting translator watches each editor transaction, matches its
steps against known shapes, and emits the CRDT operation each shape implies. A
diffing translator ignores the steps, compares the editor's new document against
the CRDT's current state, and emits the operations that reconcile them.

`monad` built the first, and their architecture review concluded it is "the
wrong primitive": the editor produces several different step shapes for the same
logical edit, so every new extension introduces variants nobody has seen, and
each unrecognized variant either falls back to a full re-render or silently
drops the user's intent. Their known-limitations document is that conclusion's
evidence — nineteen numbered entries, including a paste that dropped its entire
contents, an Enter that created no block, and typing into a new document saving
nothing. We build the diffing translator first.

The inbound direction still needs care. Applying a peer's edit by re-rendering
the whole document from the CRDT is correct and destroys the local person's
not-yet-acknowledged typing, because their characters are in the editor and not
yet in the CRDT. The inbound path therefore applies a targeted change to the
affected region and falls back to a full re-render only for edits it cannot
place, which costs the local selection but never their text.

**Extensions.** Four, mirroring the split `monad` settled on because each maps
to one user-visible concept and can be tested alone: the core binding, the
presence layer, the sync transport, and the schema pinned to Rally's rendered
markdown. Authorship marks and comment anchors — their other two — are non-goals
2 and 3 and are not built.

**Schema.** Exactly the constructs `MarkdownBody` renders: paragraph, heading,
bold, italic, strikethrough, inline code, link, bullet list, ordered list, task
list, blockquote, code block, table, image, horizontal rule, hard break. A
construct not in that list is not in the schema, so a document cannot contain
something the rest of the product would render as literal text.

## 4. Markdown projection

The room projects markdown from the CRDT; no client ever supplies it. The
projection is pure — no I/O — and the room persists the result at
materialization.

The projector has to satisfy one constraint the PRD does not state and the build
will hit immediately: **its output must be re-importable into the same document
structure**, because the agent write path parses markdown back in. `monad`
explicitly does not guarantee this and documents the round trip as lossy; they
get away with it because their loss is confined to features Rally is not
building (authorship marks, comment ranges, per-character timestamps). With
those out of scope, the constructs in section 3's schema round-trip cleanly, and
the suite that proves it is a property test over generated documents, not a
fixture list.

Two projector behaviors are worth stealing verbatim, because `monad` shipped
both as corruption bugs before fixing them:

- **Coalesce adjacent runs before emitting marks.** A single visually bold span
  is stored as many runs whenever a non-rendering attribute differs between
  them. Wrapping each run separately emits `**a****b**` instead of `**ab**`, and
  that text reaches search, the model, and export.
- **Hoist whitespace outside emphasis.** CommonMark requires an emphasis
  delimiter to touch a non-space character, so a bold run with a trailing space
  must emit the space outside the delimiters. Otherwise literal asterisks leak
  into the output.

Escaping is context-aware: a special character is escaped only where CommonMark
would actually reparse it. Escaping every occurrence corrupts identifiers and
paths — `agent\_inference\_log` — and, worse here, breaks the exact-match
lookup `workstream_edit_document` depends on, because the model authored the
unescaped text and the document stores the escaped one.

## 5. Materialization

A materialization turns live document state into a resource version. It is the
only path from the room to the resource, and it runs in exactly three
situations:

1. **The document goes quiet.** No operation has arrived for the configured
   interval and at least one has arrived since the last materialization.
2. **An agent edit is about to apply.** Unconditionally, before the edit — so
   the version preceding an agent edit holds what the participants had.
3. **The room is evicting.** Before dropping state, so nothing typed is lost to
   an idle timeout.

The sequence, inside the room:

1. Project markdown from the current CRDT state, and record the frontier that
   projection covers.
2. If the markdown is byte-identical to the resource's current content, stop.
   Nothing semantic changed; no version is minted.
3. Write one new R2 object. Never overwrite a key — resource versioning's
   non-goal 5 excludes overwrite-in-place producers from history for exactly
   this reason, because overwriting destroys the bytes before the layer could
   preserve them.
4. Ask WorkspaceDO to swap the resource's pointers, staging provenance in the
   same statement: `revision_author_kind = 'member'` with the editing member's
   id, `revision_cause = 'replaced'`, and a `revision_storage_kind` naming the
   document shape. WorkspaceDO's existing trigger increments `current_version`
   and captures the version row; the provenance fence rejects a mismatched
   identity by aborting the swap.

   The cause is `replaced` rather than a new `edited` value because
   `revision_cause` and `cause` are enumerated CHECK constraints on STRICT
   tables, which SQLite cannot alter without rebuilding them — the same
   constraint that led `storage_kind` to ship with no CHECK. `author_kind =
   'member'` carries the distinction instead. See the PRD's
   [Data model](prd.md#data-model).
5. On success, record the materialized frontier in `document_meta`.

**Who is the author when several people edited?** The version carries one
`author_kind`/identity pair, because the fence enforces exactly one. The
proposal is the member whose operation was most recent in the materialized
range, which is the person who last touched it and the one a reader would ask.
The alternative — a `system` author for any multi-editor session — is honest but
useless in the rail, where every collaborative session would show no name.
This is a decision worth confirming in review; it is recorded here rather than
in the PRD body because it changes no product scope.

**Ordering against the resource's other writers.** A publish from the Terminal
sandbox and a materialization both swap the same pointers. Both go through
WorkspaceDO, which serializes them; the compare-and-swap on the pointer that was
read means the loser retries against the winner's state rather than clobbering
it. A publish that lands while people are editing produces a version, and the
room re-imports the published content on its next join rather than silently
diverging — which is the case section 7 flags as needing a decision before the
build.

## 6. Agent tool contracts

Both tools join the always-available work-stream runtime operations rather than
any plugin, as the PRD's [Agent behavior](prd.md#agent-behavior) section states.
Canonical names are local to the family — `edit_document` and `write_document` —
and Bind renders the model-facing names by prepending the family's prefix, the
same mechanism that turns `read_resource` into `workstream_read_resource`. The
headings below use the model-facing names because that is what appears in a
transcript.

### 6.1 `workstream_edit_document` (canonical `edit_document`)

```
capability   workstream.resources.edit
mode         write
idempotency  record_before_execute
timeoutMs    open — the team sets it
```

**Input** (strict; unknown keys rejected by the executor's parse, not only by
the advertised schema):

| Property | Required | Shape |
| --- | --- | --- |
| `resourceId` | yes | The document's UUID or its short slug |
| `oldString` | yes | Exact current text to replace, with enough surrounding context to be unique |
| `newString` | yes | Replacement text; may be empty to delete |
| `replaceAll` | no | Default `false`. When `false`, `oldString` matching more than once is an error |

**Output** on success: `{ resourceId, slug, title, replacements, additions,
deletions, version }`. `version` is the resource version the edit produced —
what the model needs next in order to say what it changed, without a second
read.

### 6.2 `workstream_write_document` (canonical `write_document`)

Capability `workstream.resources.write`; same mode and idempotency class.
Input: `{ resourceId, content }`. Output:
`{ resourceId, slug, title, bytes, additions, deletions, version }`.

This is deliberate complete replacement of the document body. It is not the
fallback for a failed edit, and the failure text for `match_not_found` says so —
a model that reaches for a whole-document rewrite after one missed match
destroys work it never read.

Neither tool creates a document. Creation stays with the Terminal publish path,
which is what mints the resource these tools address.

### 6.3 Failure contract

Every failure below is a typed failure with a stable code, a model-visible
sentence containing the shortest safe next action, and only allowlisted detail
keys — `reason`, `retryAfterMs`, `resourceId`, `suggestedCall` from the shared
list in [`agent-tools.md`](../../agent-tools.md). None of them is returned as a
successful result carrying an error field, which would record a dishonest
receipt.

| Code | Sentence the model sees | Details |
| --- | --- | --- |
| `resource_not_found` | "That resource is not available. List the work stream's resources and choose one that is visible." | none — the flat answer is the point |
| `resource_not_editable` | "That resource is not an editable document. Read it with `workstream_read_resource`; to make an editable document, write the file in the Terminal sandbox and publish it." | `suggestedCall`, `resourceId` |
| `match_not_found` | "The document changed after it was read. Read it again and rebuild the edit from the current text." | `resourceId` |
| `match_not_unique` | "That text appears more than once. Read the document again and include enough surrounding context to identify one place, or set `replaceAll` when every match should change." | `reason` |
| `document_busy` | "The document is saving a version. Wait `retryAfterMs` and call the same tool again." | `retryAfterMs` |
| `limit_exceeded` | "The document would exceed its size limit. Reduce the change or split the document." | `reason` |

`resource_not_found` deliberately collapses nonexistent, foreign, detached,
archived, revoked, and principal-invisible resources into one answer, matching
the attachment family, because the zero-versus-many distinction is itself the
disclosure.

### 6.4 Why no `expectedRevision`

The exact-match text is the drift check. This is the same conclusion the
Terminal file family reached and recorded: model-facing revisions are absent
there because exact-match edits give a medium model a check it can act on
without asking it to manage content versions, while the runtime keeps its own
internal hashes and locking. Adding a revision token here would introduce a
value the model must thread between two calls, and its failure mode — a stale
token — has exactly the same recovery as a missed match: read again, rebuild.
One mechanism, one recovery.

## 7. What is ported, what is written, and what is left behind

`monad`'s implementation is not a library and cannot be depended on. It is
application code inside a Next.js app, importing that app's path aliases, its
Postgres access layer, and its own WebSocket server. The measured footprint:

| Area | Lines (non-test) | Disposition |
| --- | --- | --- |
| Client CRDT binding and protocol types | ~16,000 | Port the protocol design and the schema; rewrite the outbound translator diff-based (section 3); drop the authorship and comment-anchor extensions |
| Editor UI | ~15,000 | Reference only. Rally's design language, rail, and theming share nothing with it; the extension catalog is the transferable part |
| Room, sync, and agent-apply server | ~4,000 | Mostly does not apply. Section 1.1 — the room registry, notify fan-out, advisory locks, and id-ordering hazards are all things a Durable Object removes |
| Version and prune layer | ~1,100 | Does not apply. Rally's version layer already exists and is better matched to its storage |

The honest summary: **the design transfers, most of the code does not, and the
bug list transfers best of all.** The protocol shape, the block-tree and
inline-text model, the projector's escaping and coalescing rules, the join-time
snapshot rule, the server-assigned author, and the cross-document operation
check are all findings worth more than the lines that implement them.

## 8. Testing

Per [`testing.md`](../../testing.md), the default is the real Cloudflare
pipeline, and this change is unusually well suited to it:

- **Convergence** belongs in `apps/api/test-workers/`: several simulated editors
  against a real `DocumentAgent`, randomized interleaving of operations,
  asserting identical final state and identical projected markdown. `monad`'s
  equivalent is a four-replica randomized test, and it is the single highest-value
  test in their suite.
- **Materialization** belongs in the Node suite against the checked-in
  migrations, where the capture trigger, the provenance fence, and the version
  numbering are the things under test.
- **The projector** is pure, so a property test over generated documents proves
  the round trip section 4 requires.
- **The binding** is tested at the ProseMirror layer with no socket, driving
  realistic input sequences — the paste, split, merge, and list-indent shapes
  that are `monad`'s entire defect list.
- **The visible surface** is looked at in a real window before it is called
  done, per the repository rule: two clients, carets, name tags, selections.

Every test proves it can fail, per the same document: break the code it covers,
watch it fail for the reason its name claims, revert.
