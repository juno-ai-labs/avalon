# Collaborative document editing

> Created 2026-08-31.
>
> A document Rally generated becomes editable in place: several participants
> type into it at once, each sees the others' carets, name tags, and
> selections, and the document — not the sandbox file it came from — becomes
> the state Rally revises. Companions: [state](state.md),
> [design](design.md) (the room, the protocol, the tool contracts),
> [research](research.md) (what the `monad` implementation does and what
> transfers), [README](README.md). Builds directly on
> [resource versioning](../2026-08-27_resource-versioning/prd.md), whose
> non-goal 1 and design decision 7 reserved the seam this PRD fills, and on
> [terminal artifact generation](../2026-08-27_terminal-artifact-generation/prd.md),
> which produces the documents being edited. Subsystem references:
> [agent attachments](../../agent-attachments.md),
> [agent tools](../../agent-tools.md),
> [data model](../../data-model.md),
> [markdown rendering](../../markdown-rendering.md),
> [realtime sockets](../../realtime-sockets.md),
> [Terminal work spaces](../../terminal-workspaces.md),
> [websocket architecture](../../websocket-architecture.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Rally writes documents today and nobody can change a word of one. A participant
opens the press release Rally drafted, sees a typo, and their only recourse is
to ask Rally to rewrite the file and publish it again — a full model run, tens
of seconds, and no way for two people to work on it at the same time. This
change makes the document itself editable: several participants type into the
same document at once, each sees where the others' carets are with a name tag
saying who it is and their selected text highlighted, and every keystroke is
durable the instant it is typed. There is no save button, because there is
nothing to save — the document is always already saved.

The document stays one resource with one identity. It appears in the same right
rail, is cited the same way, and is read by the model through the same
attachment tools reading the same server-projected markdown. What changes is
which copy is authoritative: once a person edits a document, the live document
is the truth and the sandbox file is a byproduct, so Rally revises documents in
place through two typed tools rather than by republishing over work people did.
Version history keeps working and gets richer — Rally's publishes mint versions
exactly as they do today, and a stretch of human typing becomes one version,
attributed to the person who typed it, once the document goes quiet.

## Motivation

**Documents became a first-class output this month and stopped one step short of
being useful.** Terminal artifact generation shipped the path where a request
like "draft the launch press release" produces a durable document in the rail
instead of a wall of text in the transcript. Resource versioning shipped the
history beneath it. Both landed with the same gap named in their own text:
resource versioning's motivation says "every roadmap the product has sketched
for documents — human edits, diffs computed between versions, export, eventually
an editor — stands on version history existing from before those features
arrive." The history now exists. This is the editor it was built for, and that
PRD's non-goal 1 and design decision 7 wrote down, in advance, the exact seam it
would attach to.

**Revision by republish is expensive in the three ways that matter.** It costs a
model run for a change a person could make in two seconds; it is serial, so two
people cannot both fix something; and it routes an intention through a language
model that could have been expressed directly, which is the one path in the
product where the model is strictly worse than a text cursor. A group drafting a
document together — the case the work stream exists to serve — currently takes
turns asking an agent to type for them.

**The product contract already promises this and does not yet deliver it.** The
implementation brief lists "live collaboration" among the required prototype
outcomes. Today that means the transcript, the rail, and work-stream metadata
update live for everyone. The deliverable at the centre of the work stream does
not.

There is no usage measurement behind this and there will not be: the product has
no load history and no metrics stack, and per the repository's standing rule a
decision here is not gated on numbers nobody can produce. The evidence is the
shape of what shipped — a document surface with a read-only ceiling that two
PRDs from last week each named as the next thing.

## Goals

1. Two or more participants edit the same document at the same time, and each
   one sees the others' text appear as it is typed, without reloading anything.
2. Each editor sees every other editor's caret position, a name tag on that
   caret identifying the person, and the range they have selected.
3. Every edit is durable as it is made. There is no save action, and closing the
   window mid-sentence loses nothing that was typed before it closed.
4. A document remains one resource with one identity through editing: the same
   id, the same slug, the same rail entry, the same citation, the same address
   for every attachment tool. Editing never mints a sibling.
5. A stretch of human editing becomes exactly one new resource version once the
   document goes quiet, carrying `author_kind = 'member'` and the identity of
   the person who edited it, in the history the rail already lists.
6. Rally revises a document people have edited by changing that document in
   place through typed tools, never by republishing a sandbox file over their
   work.
7. Pending human edits are materialized into a version *before* an agent edit is
   applied, so the version immediately preceding any agent edit holds exactly
   what the participants had.
8. The model reads documents exactly as it does today — markdown through the
   existing attachment tools — with that markdown projected server-side from the
   document's authoritative state, never supplied by a client.
9. A document nobody edits behaves in every respect as it does today.

## Non-goals

1. **Operational transformation.** Rejected outright. The request that opened
   this work assumed `monad` had built an OT system to lift; it did not. Its
   protocol design opens by rejecting OT explicitly, it shipped on one CRDT
   (Yjs), and it has since replaced that with another (Loro), deleting the first
   entirely. Choosing OT here means writing an engine from scratch that nobody
   at Juno has built, that the one prior implementation in the company evaluated
   and rejected, and from which none of the existing code transfers. Every
   behavior in goals 1–3 is identical under either. See
   [research](research.md).
2. **Per-character authorship colouring.** Deferred, and the cost of deferring is
   real enough to state: authorship is a mark stored inside the document, so
   history written before it exists carries no attribution and cannot be given
   any retroactively. Picking it up later means every document edited before
   that point shows uncoloured text forever. It is out of this change because
   it doubles the mark schema and the editor surface for a feature nobody has
   asked for, and because version-level attribution (goal 5) answers "who
   changed this" at the granularity the rail actually shows.
3. **Comments anchored to a selection.** Deferred. Anchors that survive edits
   around them are their own hard problem — anchor liveness is a recurring
   defect source in the prior implementation — and the work stream is already
   where discussion happens.
4. **Revert, diff, and version-compare surfaces.** Deferred. Versions are minted
   and listed by machinery that already exists; going back to one is not a
   button in this change. The semantics are fixed already by resource
   versioning's non-goal 3, so nobody invents a rewind later: a restore is a new
   version reusing the restored version's content, and history only appends.
5. **Watching Rally type into a document live.** Deferred. An agent edit lands
   whole — the document changes in one step and everyone sees the result. The
   streaming version is a genuine V2 and needs the agent to emit incremental
   operations rather than markdown, which would change the tool contract in
   section [Agent behavior](#agent-behavior) rather than extend it.
6. **Offline editing.** Deferred. A disconnected client shows the document
   read-only with a clear reason and accepts no edits, rather than queuing
   changes it might not be able to reconcile. Reconciling a queue against a
   document that moved is a separate design.
7. **Block types Rally does not already render.** Rejected for this change. The
   editor supports exactly the constructs `MarkdownBody` renders today, so a
   document reads identically whether it is being edited, previewed, cited, or
   exported. Columns, callouts, math, toggles, and drag-handle block reordering
   are extra schema for constructs that would render as literal text everywhere
   else in the product.
8. **Editing anything that is not a Rally-generated document.** Rejected.
   Uploads, connector-owned pages, and converted binaries are snapshots of
   something owned elsewhere; making them editable is bidirectional external
   synchronization, which resource versioning already rejected as non-goal 4.
   A Notion page stays a Notion page.
9. **A document application.** Rejected, because the contract has no room for
   one: no folders, no document list outside a work stream, no share links, no
   global search across documents. A document is a resource attached to a work
   stream and reachable only through it.
10. **Retention, size, and cadence numbers.** No cap, ceiling, quiet interval, or
    timeout ships with a number invented here. Each is named in
    [Open questions](#open-questions) as a decision for the team, per the
    repository's rule that a defensive limit's number is set rather than
    guessed.

## Product behavior

**Opening a document.** A participant opens a document from the right rail as
they do today. If the document is Rally-generated markdown, it opens editable:
the caret is placeable, typing works, and a small presence indicator shows who
else is in it. Every other resource — a PDF, an upload, a Notion snapshot —
opens exactly as it does now, read-only, with no editing affordance and no
suggestion that one is missing.

**Editing.** Text appears for everyone else as it is typed, character by
character. There is no save control and no dirty indicator, because neither has
anything to describe: the edit is durable before it is visible to anyone else.
The formatting available is what Rally's markdown already renders — headings,
bold, italic, code, links, lists, task lists, quotes, code blocks, tables,
images, horizontal rules — reachable by the markdown shortcuts a person already
types and by a selection toolbar.

**Seeing each other.** Each other editor's caret is drawn in the document at
their position, tinted with a colour stable for that person, with their name in
a small tag attached to it. When they select a range, that range is highlighted
in the same colour. When they stop interacting the tag recedes so it does not
sit over the text being read, and returns as soon as they move again. When they
leave, their caret disappears. None of this is stored: presence is live state
that exists only while people are connected, and a document opened alone shows
nothing.

**Asking Rally to change it.** A participant asks in the work stream — "tighten
the second paragraph" — and Rally edits the document in place. The transcript
shows the ordinary tool-activity rows while it works, then a short message
saying what changed. Anyone with the document open sees it change under them in
one step, not word by word. Before the change applies, whatever people had typed
is captured as its own version, so the state Rally edited from is the state the
history shows them leaving.

**Versions.** The rail's existing version list gains rows from editing. Rally's
publishes appear as they do today, attributed to the run. A stretch of human
editing appears as one row attributed to the person, added once the document has
been quiet for the configured interval rather than while they are still typing.
Opening a prior version works as it does today: read-only, in the existing
preview surface, plainly labelled as not current.

**States.**

- *Loading* — joining the document's room. The last-known content renders
  immediately from the current version, read-only, with editing enabled as soon
  as the room answers. A person never watches an empty pane.
- *Empty* — a document with no content shows the same placeholder affordance any
  empty editor shows, and typing starts it.
- *Error* — the room cannot be reached or refuses the connection. The document
  renders read-only from its current version with a plain statement that live
  editing is unavailable and that changes cannot be made right now. Nothing is
  silently discarded, because nothing is accepted.
- *Offline* — treated as the error state, with the reason named as connectivity.
  Edits are refused rather than queued (non-goal 6).
- *Not editable* — every non-generated resource, unchanged from today.

**A person who is not a participant.** Viewing a work stream does not make
someone a participant, and reading a document does not either. Typing into one
does: the first edit joins them, exactly as posting a message does. See
[Impact on the product contract](#impact-on-the-product-contract) — this is the
one clause this change moves.

## Impact on the product contract

**One clause moves.** The contract reads: "Viewing does not create
participation. Creating, posting, answering an elicitation, or being explicitly
added does." Editing a document is not in that list, and it has to be, because
the alternatives are both wrong. If editing did not create participation, a
non-participant could change a shared deliverable and appear in its version
history as a `member` author while not being in the work stream at all — an
attribution the rail would render as fact about someone who, by the contract, is
not there. If instead only existing participants could edit, a person invited to
look at a draft would have to post a message before they could fix a typo in it.

The proposal is that the clause gains editing a document alongside posting: **"Creating,
posting, editing a document, answering an elicitation, or being explicitly added
does."** This is a deliberate widening of what makes someone a participant and
is the largest conversation in this PRD; it should be settled before the build
starts rather than discovered during it.

Two further clauses are touched and do not move. "Live collaboration" among the
required prototype outcomes is now satisfied by the deliverable as well as the
transcript. The Terminal clause is unchanged: the sandbox still exists, still
generates documents, and gains no user-visible surface — what changes is that
publishing stops being how an already-edited document is revised, which is a
behavior of the publish path rather than a boundary of the sandbox.

## Decision log

None yet.

## Key design decisions

Full rationale, the wire protocol, and the port inventory are in
[design.md](design.md). The decisions a reader might otherwise second-guess:

1. **A CRDT (Loro), not OT, and not a bespoke engine.** Convergence is
   proved by a maintained library rather than by us. The rejected alternatives
   are OT (non-goal 1) and Yjs — Yjs is the engine `monad` retired, and its
   editor-integration layer is where the defects that forced that retirement
   lived.
2. **One Durable Object per document is the room.** The prior implementation's
   most delicate server code — an in-memory room registry, a serialized apply
   queue, cross-node fan-out over database notifications, and a bug class around
   auto-increment ids committing out of order — exists to reconstruct a single
   authoritative writer per document. A Durable Object is one by construction,
   and Rally already runs this exact shape: a per-object socket room opened on
   demand for the automation draft and for each visible dashboard block. The
   rejected alternative is folding documents into `SubstreamAgent` or
   `WorkstreamDO`, which would put per-keystroke traffic through the objects
   that own the transcript and work-stream metadata.
3. **Live document state is not a resource pointer, and materialization is what
   swaps one.** A keystroke is not a pointer swap; if it were, Rally's capture
   trigger would mint a version and write an R2 object per character typed. The
   room holds the authoritative state, and the resource's pointer moves only at
   a materialization boundary — the document going quiet, or an agent edit about
   to apply. The rejected alternative is versioning at op granularity, which is
   unbounded storage for a history nobody would read.
4. **The version row shape does not change.** `resource_versions.storage_kind`
   was added with no CHECK constraint and a comment naming this exact use, so a
   materialized document sets it the way an author is set, and the rail, the
   cleanup outbox, and the provenance fence all keep working untouched. The
   rejected alternative — a parallel document-version table — would split
   history for one resource across two places.
5. **Markdown stays server-projected and the client never supplies it.** Search,
   model context, previews, citations, and export must all read byte-identical
   markdown, and a client that could supply it could lie about what someone
   typed. The rejected alternative, letting the editor send markdown alongside
   its edits, saves a projection and buys a spoofing surface.
6. **Rally edits documents in markdown through typed tools; it never emits CRDT
   operations.** Language models produce markdown well and structured operation
   envelopes with valid parent references badly, and pinning the tool contract to
   markdown keeps it stable while the protocol underneath evolves. The rejected
   alternative — operation-emitting tools — also fails the model-usability bar in
   [`agent-tools.md`](../../agent-tools.md), which asks whether a small model
   could get it right from the schema alone.
7. **The editor-to-CRDT translator is built by diffing states, not by
   interpreting editor steps, from the first commit.** This is the single most
   valuable thing to inherit from the prior implementation, and it is inherited
   as a conclusion rather than as code: they built the step-interpreting version,
   filled a document with nineteen numbered defects — several of them silent data
   loss, including a paste that dropped everything and an Enter that created no
   block — and then wrote that the approach is "the wrong primitive" and should
   be replaced. We start where they finished. The rejected alternative is
   copying the shipped translator because it exists.
8. **TipTap in the renderer, with the schema pinned to what Rally already
   renders.** The desktop client has no editor framework today, so this is new
   either way; TipTap is what the prior implementation's extensions are written
   against, and it survived their engine swap untouched, which is evidence the
   layering holds. The rejected alternatives are raw ProseMirror (rewriting every
   extension for no convergence gain) and Lexical or Slate (the same cost plus
   nothing transferable from `monad`).
9. **Materialize before an agent edit, never after.** Capturing after would fold
   the participants' work and the agent's rewrite into one version, so the
   history would offer no state to go back to. Doing it before makes "Rally
   mangled our draft" recoverable through history that already exists, with no
   revert feature built (non-goal 4).
10. **Only Rally-generated markdown documents are editable.** Editability is a
    property of how the bytes are owned, not of whether they happen to be text.

## Data model

Sketch level; the migration and [`data-model.md`](../../data-model.md) are
authoritative. The shape is deliberately small because the history layer already
exists.

**Unchanged.** `resources`, `resource_versions`, the capture triggers, the
provenance fence, and the deletion outbox all keep their current definitions. A
materialization is an ordinary semantic write to `resources`: it stages
`revision_author_kind = 'member'` with the editing member's id, a
`revision_cause`, and a `revision_storage_kind` naming the document shape, then
swaps `content_ref` and `content_sha256` to a freshly written R2 object. The
existing trigger increments `current_version` and captures the row. Nothing in
SQL needs to learn what a document is.

**One column on `resources`**, naming whether a live document backs this
resource and since when. The room's identity is derived from the resource id, so
no pointer is stored; what the column answers is whether the rail should open
an editor, which cannot be derived from the current version's `storage_kind`
alone (a document is editable from the moment it is first opened for editing,
which is before its first materialization).

**The cause a materialization records is a decision with a real cost on both
sides, and it should be taken deliberately.** `resources.revision_cause` and
`resource_versions.cause` each carry an enumerated CHECK listing `created`,
`published`, `refetched`, and `replaced`, on STRICT tables. SQLite cannot alter
a CHECK on a STRICT table, so admitting a fifth value means rebuilding both
tables — which is the constraint the team already reasoned about when they
deliberately shipped `storage_kind` with no CHECK at all so a new storage shape
would need no rebuild.

The proposal is therefore to **reuse `replaced`** and let `author_kind =
'member'` carry the distinction, since a member replacing a document's content
is literally what an edit is, and the pair reads unambiguously in the rail. The
alternative — an `edited` value that says so directly — costs a rebuild of the
two tables that hold every resource and its entire history, for wording. If the
rail's copy turns out to need the distinction, the cheaper move is for the rail
to read the pair rather than for the schema to carry a fifth value.

**The document's own storage lives in its Durable Object**, not in WorkspaceDO:
the operation log, periodic compacted snapshots, and room metadata including the
frontier each snapshot covers. It is per-document, hibernates with the object,
and is never read by anything outside the room — every other consumer reads the
materialized markdown through the resource. Its schema is in
[design.md](design.md).

## Regional impact

A document's Durable Object lives in the same region as the resource it backs,
in that region's namespace, and its materialized objects are written to that
region's R2 bucket. Nothing about a document crosses the boundary: presence
names and colours are resolved from the regional directory, the markdown
projection runs in the region, and an EU document's content, operation log, and
presence never reach Global. Read [`regionalization.md`](../../regionalization.md)
before touching the placement. As with the rest of the product, EU inference and
analytics remain intentionally unarchived; a document's history lives in its
region's WorkspaceDO and nowhere else.

## Security and trust model

- **The room socket gets its own ticket audience**, bound to the resource id as
  well as the user, workspace, and region, following the purpose-specific
  admission contract in [`realtime-sockets.md`](../../realtime-sockets.md). A
  ticket for one document never opens another, and a work-stream ticket never
  opens a document room.
- **Authorship on the wire is server-assigned.** An edit arrives claiming an
  author; the room overwrites that claim with the identity on the socket session
  before applying it. This is a fix the prior implementation had to make after
  the fact, and it is cheaper to build in.
- **Every operation is validated against the document it arrived on.** An
  operation naming a block, anchor, or object belonging to another document or
  another workspace is refused, not applied. The equivalent gap in the prior
  implementation was a cross-tenant spoofing path closed by an explicit
  precondition check.
- **The renderer is sandboxed and stays that way.** The editor runs in the
  Electron renderer under the existing isolation model in
  [`security.md`](../../security.md); it gains no new privileged surface. Pasted
  content is untrusted input: HTML paste is sanitized to the same construct set
  the schema allows, and links created or pasted in the editor pass the same
  scheme allowlist [`markdown-rendering.md`](../../markdown-rendering.md)
  enforces, so an editor cannot be used to introduce a link the renderer would
  refuse to render.
- **Markdown for search and model context is projected server-side only**
  (design decision 5). A client cannot cause the model to read text nobody
  typed.
- **Membership is checked on join and enforced per operation**, not assumed from
  the ticket alone, so access revoked mid-session stops the next edit rather
  than the next reconnection.

## Agent behavior

**No new plugin.** These are two write operations added to the always-available
work-stream runtime alongside the existing attachment operations
(`workstream_list_resources`, `workstream_read_resource`,
`workstream_search_resource`, `workstream_view_resource`,
`workstream_summarize_resource`), not a loadable plugin. Nothing is loaded,
started, or authorized by their presence; they are subject to the run's ordinary
authorization and are available whenever the attachment family is. The rejected
alternative — a deferred `rally:documents` plugin — adds a load step and a
prompt cost to what is the natural continuation of a read the model has already
done.

**Discovery and sequencing.** The model finds documents with
`workstream_list_resources` and reads one with `workstream_read_resource`, both
unchanged. It then edits with the exact text it just read. There is no
`expectedRevision` on either tool, following the same reasoning the Terminal file
family records in [`agent-tools.md`](../../agent-tools.md): exact-match text
supplies a drift check the model can act on without asking a medium model to
manage content revisions. When the text has moved, the edit fails with a code
that says to read again and rebuild.

**The tools.** Canonical names are `edit_document` and `write_document`, local
to the family as its existing members are; Bind renders them to the model as
`workstream_edit_document` and `workstream_write_document` through the same
prefix that produces `workstream_read_resource`. Both are `mode: "write"`, both
are `idempotency: "record_before_execute"` because an exact-match replacement is
not naturally repeatable and there is no provider key to dedupe on, and both
execute serially against the document's room. Their capabilities extend the
family's existing `workstream.resources` prefix rather than opening a second
namespace.

| Model-facing tool | Strict input | Successful `output` |
| --- | --- | --- |
| `workstream_edit_document` | `{ resourceId: string, oldString: string, newString: string, replaceAll?: boolean }` | `{ resourceId, slug, title, replacements, additions, deletions, version }`. `oldString` must match exactly once unless `replaceAll` is intentional. |
| `workstream_write_document` | `{ resourceId: string, content: string }` | `{ resourceId, slug, title, bytes, additions, deletions, version }`. Deliberate complete replacement of the document body, not a fallback for a failed edit. |

**Not in the automation-draft variant.** The same attachment family is
instantiated for automation drafts under the `automation` prefix over a frozen
attachment set. These two tools are not added there: a draft's attachments are
frozen by construction, and a write against them has nothing coherent to mean.

`resourceId` accepts the resource's UUID or its short slug, resolved
server-side, matching how citations already address a resource. Neither tool
creates a document: a new document is still written as a file in the Terminal
sandbox and published, which is what mints the resource these tools then edit.
`version` in each output is the resource version the edit produced, so the model
can name what it changed without a second read.

**Failures, designed as loop repairs.** Complete wire shapes and the full
failure table are in [design.md](design.md); the recoveries a model must be able
to follow:

| Code | Model-visible recovery |
| --- | --- |
| `resource_not_found` | The same flat answer the attachment family returns for a nonexistent, foreign, detached, archived, or invisible resource — the zero-versus-many distinction is itself the disclosure. List resources again and choose one that is visible. |
| `resource_not_editable` | This resource is not a Rally-generated markdown document. Read it with `workstream_read_resource`; to produce an editable document, write the file in the Terminal sandbox and publish it. |
| `match_not_found`, `match_not_unique` | Read the document again, copy the exact current text with enough surrounding context to be unique, then rebuild the edit. Use `replaceAll` only when every match should change. This is the drift recovery. |
| `document_busy` | Wait the model-visible `retryAfterMs` and call the same tool again. The document is materializing a version; the wait is short and the retry is safe. |
| `limit_exceeded` | The content exceeds the document size ceiling. Split the document or reduce the change; the ceiling is not raisable by a run. |

**Acceptance for model usability.** Schema snapshot and strict-contract tests
for required, optional, forbidden, success, and failure shapes; and prompt
evaluations on the configured medium fallback model covering discovery, a
successful read-then-edit sequence, the predictable wrong first calls (editing a
PDF, editing without reading, and reaching for `workstream_write_document` after
one failed match), recovery from `match_not_found` through a re-read to a
successful edit, and the absence of loops or blind retries. A frontier model
succeeding is not evidence.

## Rollout

Behind a client feature flag, `collaborative-documents-enabled`, closed to off,
per [`feature-flags.md`](../../feature-flags.md) — a client feature has nothing
it must do, and off is exactly today's product.

Phases, each shippable and each leaving the product working with the flag off:

1. The document room and its protocol, server-side, with no client. Provable by
   the workerd suite driving several simulated editors against a real Durable
   Object and asserting they converge.
2. The editor in the renderer, single-user, flag-gated. A document opens
   editable, typing persists, reopening shows the typing.
3. Presence: carets, name tags, selections.
4. Materialization: quiet-boundary versions with member provenance, visible in
   the rail's existing list.
5. The two agent tools, and the materialize-before-agent-edit rule.

**Turning it off** is safe at every point after phase 4, because a materialized
version is an ordinary resource version: with the flag off, documents render
read-only from their current version exactly as they do now, including versions
that people typed. Nothing written by the flag-on path is unreadable to the
flag-off product. Before phase 4, turning it off can strand edits that were
never materialized — so phase 4 is the point at which the flag becomes a true
kill switch, and phases 2 and 3 stay internal.

## Acceptance

The flows anyone can walk to see this is done:

1. Two people open the same document in two clients. Each types; each sees the
   other's text appear, the other's caret with their name on it, and the other's
   selection highlighted. One closes their client; their caret disappears from
   the other's screen.
2. One person types a paragraph and closes the window immediately. Reopening the
   document shows the paragraph.
3. Both stop typing. After the quiet interval, the rail's version list shows one
   new row attributed to a person, not one row per keystroke and not one per
   editor.
4. A participant asks Rally to revise a section of a document they have just
   edited by hand. The rail shows their edit as a version, then Rally's revision
   as the next version, and opening the earlier one shows exactly what they had
   typed.
5. A non-participant with visibility opens the document, reads it, and types one
   character. They become a participant, and the work stream reflects that.
6. A PDF and a Notion page in the same rail open read-only with no editing
   affordance.
7. With the flag off, every document in the product opens exactly as it does
   today, including one that was edited while the flag was on.

Where these become durable checks they land in [`e2e.md`](../../e2e.md).

## Open questions

1. **Does editing a document create participation?** Answering yes moves a
   contract clause (see
   [Impact on the product contract](#impact-on-the-product-contract)). This
   blocks the build: the alternative — only participants may edit — is a
   different product behavior in the rail, not an implementation detail.
2. **How long is "quiet"?** The interval after which an editing session
   materializes into a version. It trades version-list density against how long
   an unmaterialized edit is exposed to a room eviction. The number is the
   team's.
3. **What is the document size ceiling?** The cap `limit_exceeded` reports, in
   characters or bytes, applying to both agent writes and accumulated typing.
   The number is the team's.
4. **When does an idle room evict, and what materializes first?** A room with no
   editors holds unmaterialized state; eviction has to materialize before it
   drops. The eviction delay is the team's.
5. **What timeout do the two agent tools carry?** The number is the team's.
6. **Does a document open editable while its model derivative is still
   processing?** A freshly published document may not yet have a derivative when
   someone opens it. Allowing editing immediately means the derivative is
   computed against a document that is already moving; blocking it briefly is a
   loading state on a fast path. This does not block the build.
