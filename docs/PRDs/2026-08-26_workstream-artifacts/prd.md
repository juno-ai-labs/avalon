# Work-stream artifacts

> Created 2026-08-26.
>
> When Rally is asked for a document — a PRD, a press release, a plan, a brief,
> a multi-section analysis — it publishes the document as an **artifact**: a
> card in the transcript that opens in the right rail, revised through
> conversation, instead of a wall of text inline. V1 is viewing and
> agent-driven revision only. Companion: [state](state.md). Subsystem
> references: [agent harness](../../agent-harness.md),
> [agent tools](../../agent-tools.md),
> [markdown rendering](../../markdown-rendering.md),
> [work-stream Durable Objects](../../workstream-durable-object.md),
> [feature flags](../../feature-flags.md). Related PRD:
> [ordered work-stream turns](../2026-08-26_ordered-workstream-turn-transcripts/prd.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

When a participant asks for something whose natural shape is a document, Rally
answers conversationally and puts the document itself in an artifact. The
transcript shows a short framing message and a compact artifact card; the
long-form content lives behind the card, in a readable document panel that
opens in the existing right rail. The conversation continues around the card:
a participant asks for changes in the composer, and Rally publishes a revision
— a new card, a stable artifact identity, a higher revision number. Every
participant sees the same cards and the same content, because an artifact is
work-stream transcript content like any other message.

V1 is deliberately the smallest slice that changes the reading experience:
artifact creation by the agent, a card, a panel with formatted content that a
person can select and copy, and revision through conversation. There is no
human editing surface, no comments, no export, and no artifact store outside
the transcript. The decision about *when* to produce an artifact is standing
policy in the server-shipped system prompt, so tuning it is an API deploy,
never a desktop release.

The trajectory this starts: Rally as the collaborative staging environment for
AI-generated work — shared context in, drafts generated, refined together in
the work stream, and only then exported to wherever the finished thing
formally lives. Google Docs and Notion remain the destination for formal
editing, sharing, and storage; Rally competes on the drafting loop before
that, not on the editor.

## Motivation

A work stream's transcript is, by contract, "a readable shared transcript."
Today a request like "draft the launch press release" defeats that clause: the
answer arrives as one assistant message spanning many viewport heights of
headings, tables, and sections. Three costs, all observed in dogfooding:

1. **The conversation stops being scannable.** The document buries every
   message around it. A participant returning to the work stream scrolls
   through pages of generated prose to find the human exchange, and the
   transcript-follow and unread machinery dutifully lands readers inside the
   middle of a document rather than at the conversation.
2. **Collaborators do not know how to respond.** A multiplayer surface filled
   by one long message reads as finished output, not as a draft under
   discussion. The conversational moves Rally wants — "tighten the second
   section", "add a risks table" — have no visual anchor when the draft and
   the discussion are the same undifferentiated column of text.
3. **Iteration multiplies the problem.** Each revision request produces
   another full copy of the document inline. Three rounds of edits is four
   documents' worth of scrollback in a surface people share.

Rally has been here before, from the other direction. The original prototype
had artifacts — a `workstream_create_artifact` tool, an `artifact.write`
capability, an R2 store, a download route, a transcript block — and retired
them on 2026-08-12 (the
[agent harness changelog](../../agent-harness.md): "Artifacts are gone; a
run's output is its final message"). The failure was not the idea but the
shape: artifacts were a write destination nothing read back. The scheduled
digest mailed the run's final message, so a run that parked its output in an
artifact delivered "Outcome: Digest artifact created" and nothing else, and
the model itself could not see or revise what it had produced. The retirement
also left residue this PRD must not disturb: the regional D1 `artifacts` table
is dropped and must not be recreated, an R2 sweep under
`<region>/<workspace>/artifacts/` is still owed, `AVALON_TOOL_PROSE` retains
the retired tool's entry so historical rows still render, and
`WorkstreamContextSchema` carries an always-empty `artifacts` field for
released desktop builds.

This PRD is the corrected shape. An artifact is transcript content: it rides
the same durable message substrate as everything else in the work stream, so
every existing reader — the feed socket, pagination, reconnect, model replay,
compaction, digests that link the work stream — sees it by construction.
Nothing is parked outside the conversation, so the trap that killed the first
design cannot recur. What changes is presentation and protocol: the document
gets a typed message of its own, a card, a panel, and a revision contract,
instead of being interleaved into the prose of an answer.

The cost of leaving this alone grows with exactly the usage Rally wants most.
Document-shaped work — the "deliverable" the work-stream contract names — is
the center of the product thesis, and it is the usage the current transcript
punishes hardest.

## Goals

1. A request whose natural output is a document produces a conversational
   framing in the transcript and the document in an artifact. The transcript
   shows prose a person would say out loud plus a compact card, never the full
   document inline.
2. Clicking an artifact card opens the document in the right rail: formatted
   Markdown through the shared renderer, readable at rail widths, with free
   text selection and a one-click copy of the artifact's stored Markdown.
3. A participant revises an artifact by asking in the conversation. A revision
   keeps the artifact's stable identity, increments a monotonic revision
   number, and appears as a new card at the point in the transcript where it
   happened.
4. Short conversational answers stay inline. An explicit participant
   instruction in either direction — "make that an artifact", "just answer in
   chat" — is honored over the heuristic.
5. The create-an-artifact heuristic is standing policy in the server-shipped
   system prompt. Tuning what counts as document-shaped requires an API deploy
   and nothing from the desktop client.
6. Every participant and viewer of the work stream sees the same cards and,
   for a given card, the same content. Artifacts inherit the work stream's
   existing visibility rules; they add none of their own.
7. The agent creates and revises artifacts only through typed, authorized
   tools with receipts, replay, and a compare-and-swap revision fence — no
   untyped side channel.
8. The feature ships behind a fail-closed, workspace-scoped `artifacts-enabled`
   flag, so it can be dogfooded and rolled back without a desktop release.

## Non-goals

1. **A human editing surface in the panel.** Deferred — the next slice after
   V1. In V1 a person changes an artifact by asking Rally; the panel is
   read-only. Shipping viewing first keeps the V1 cut honest and lets the
   revision protocol harden before a second writer exists.
2. **A full collaborative rich-text editor: multi-cursor, presence, offline
   merge.** Rejected for the foreseeable product. Google Docs and Notion
   remain the destination for formal editing; Rally's job is the staged
   drafting loop before export, and building a second Docs is the fastest way
   to lose that framing.
3. **Comments and annotations on artifacts.** Deferred. They are the V3 of
   the staging-environment trajectory, and they raise a real contract
   question — whether annotating an artifact creates participation the way
   answering an elicitation does — that deserves its own PRD.
4. **Export integrations.** Deferred. Sending an artifact to Notion, Google
   Docs, or a GitHub repository is the natural completion of the staging
   loop, and when it comes it follows the existing contract for external
   writes — idempotent, visible, audited, no new approval gate. V1 offers
   copy, which already gets the content anywhere.
5. **A workspace artifacts library, cross-work-stream artifact search, or
   sharing an artifact outside its work stream.** Rejected. Rally is organized
   around work streams rather than channels, search, or a global inbox, and a
   documents library is a global inbox by another name. An artifact is reached
   through its work stream.
6. **A first-class artifact store outside the transcript.** Deferred until a
   consumer needs it. Export, watches, and cross-surface reads will eventually
   want a `resources`-backed materialization (the meeting-notes hybrid is the
   precedent); V1 has no such consumer, and a store without a reader is
   exactly the shape retired on 2026-08-12. Nothing in V1 may recreate the
   dropped D1 `artifacts` table.
7. **Streaming the document token-by-token into the panel.** Deferred. Tool
   outputs are durable before they are observed under the current harness
   contract, so V1 content appears when the write settles; the transcript's
   tool-activity row covers the interim. Progressive artifact streaming is a
   real streaming-contract change and gets its own decision.
8. **Artifacts from automation runs, inbound-email runs, and delegated child
   runs.** Deferred. Those runs deliver results by paths (digest email,
   automation `resultDelivery`, tool results to a parent) that do not yet
   know what an artifact is; enabling artifacts there before the delivery
   integration exists would re-create the 2026-08-12 trap. V1 registers the
   artifact tools for ordinary participant-triggered work-stream runs only.
9. **Formats beyond GitHub-flavored Markdown.** Deferred. The response
   formatting policy is GFM-only today, the shared renderer is a Markdown
   renderer, and one format keeps the panel, copy, and revision semantics
   simple. Code files belong to the Terminal plugin's published resources;
   fenced code blocks inside an artifact are fine.
10. **Targeted-edit revisions.** Deferred. A V1 revision replaces the whole
    content, which keeps the tool contract one field wide and makes every
    revision self-contained. Span edits for very long documents are an
    optimization with real failure modes (stale anchors, partial
    application); adopt them only with evidence full replacement hurts.
11. **A pre-classifier model call deciding artifact-vs-inline.** Deferred.
    Standing policy plus the model's own judgment is the V1 mechanism; the
    addressing classifier is the template if a dedicated classifier is ever
    warranted, and `AGENT_MODEL_ROLES` is where it would slot.
12. **New defensive numbers.** None are added. Artifact content rides the
    existing message-content bounds; artifact counts are bounded by run and
    transcript machinery that already exists. Any guard an implementer
    nonetheless discovers a need for ships open under the `LIMIT UNSET` rule,
    with the number handed back to the team.

## Product behavior

### Creating an artifact

A participant asks for something document-shaped — "draft a PRD for mute
windows", "write the launch press release", "turn this thread into an exec
brief". Rally recognizes the shape (see
[the heuristic](#the-creation-heuristic)) and, during the run, calls the
artifact-creation tool with a title, a short kind label, and the full Markdown
content. The transcript shows, in order:

1. The standard tool-activity row while the write is in flight, with prose of
   the form **Drafting "Mute windows PRD"** — the same lifecycle row every
   tool gets, settling to completed.
2. The artifact card, appended when the write settles.
3. Rally's conversational text for the run: a short framing of what it made
   and an invitation to change it — "I've drafted the PRD as an artifact.
   Want me to tighten the goals or add a rollout section?"

Until [the ordered-turn transcript
substrate](../2026-08-26_ordered-workstream-turn-transcripts/prd.md) lands,
a run's narration is one final message positioned after its tool activity, so
the card precedes the prose and the preamble and postamble arrive as one
short message. The standing policy therefore tells the model to call the tool
early and keep all narration brief and content-free; once the substrate
ships, narration and cards interleave in true model order with no change to
this PRD's surface.

The model may create more than one artifact in a run when the request
genuinely asks for it ("draft the PRD and the announcement email"), and each
gets its own card. Policy discourages gratuitous multiplication: one request,
normally one artifact.

### The artifact card

The card is a compact, quiet block in the transcript — sibling to the
elicitation panel and suggestion block, not a document preview. It shows:

- the artifact title;
- the kind label the model supplied ("PRD", "Press release", "Plan");
- **Created** on a first revision, **Revised** afterwards, with the revision
  number;
- nothing else. No excerpt, no scrolling body: the card's job is to mark
  where the document happened and to open it, not to leak the wall of text
  back into the feed.

Clicking anywhere on the card opens the panel on that card's revision.
Because the card is an ordinary message row, it participates in everything
messages already do: it is delivered live on the feed socket, appears in
pagination and reconnect snapshots, keeps its place in the shared transcript
for every participant, and renders identically in the automation chat
surface's shared transcript styling.

If a client's cached copy of a card fails payload validation (a future schema
it does not know), the message falls back to rendering its text content as an
ordinary agent message — degraded but readable, never dropped.

### The document panel

The panel is the third occupant of the existing right-rail slot, beside the
inspector and HyperSight, using the shared rail frame: same fixed slot, same
resize handle and width bounds, same cross-fade hand-off, same
scrim-at-narrow-widths behavior, same Escape-to-close and focus restore. Only
one rail panel holds the slot at a time; opening an artifact hands off from
whichever panel is open, and the rail toggles in the work-stream header
behave as they do today.

Inside the panel:

- A header with the artifact title, the kind label, **Revision N**, a
  **Copy** action, and a close control.
- The document body: the artifact's Markdown rendered through the shared
  `MarkdownBody` renderer — the single `react-markdown` mount, with the
  standard model-text normalization, code-block highlighting and per-block
  copy, scrolling tables, and mention chips that are never navigable. Host
  styling overrides typography only, following the document scale precedent,
  and every color comes from theme tokens.
- Free text selection everywhere in the body. **Copy** places the artifact's
  stored Markdown bytes on the clipboard through the desktop bridge — the
  stored bytes, not the rendered text, matching the per-turn Copy precedent —
  and records the existing copy product-intent telemetry.

States: the panel has no loading state — it opens from a card whose content
the client already holds — and no empty state, because it only opens from a
card. Offline, cards and the panel keep working from the cached transcript;
only asking for a revision needs a connection, exactly as sending any message
does. A card whose payload is unreadable falls back as described above and
offers no panel.

The panel shows the clicked card's revision, honestly labeled. When a newer
revision of the same artifact is present among the client's loaded messages,
the header shows **Newer revision below — open latest**, which jumps the
panel to it. This detection is client-local over loaded rows and is
best-effort by design; the transcript, not a second index, is the authority
on what exists.

### Revising an artifact

A participant asks for changes in the composer, in ordinary language. The
run calls the revision tool with the artifact's id, the revision it believes
is current, and the complete replacement content. On success:

- a new card appears at that point in the transcript, marked **Revised** with
  the new revision number;
- the artifact's identity and title persist (the tool may retitle when asked);
- earlier cards remain exactly as they were — the transcript is a faithful
  record, and an old card opens the old revision.

The revision fence is compare-and-swap: if the artifact has moved past the
revision the model expected — possible after context compaction, or when a
later run revised it — the tool refuses with a conflict that tells the model
to re-read and rebuild. The model recovers by reading the current content,
reapplying the participant's ask, and retrying with the observed revision.
Because a substream admits one mutating run at a time, two runs cannot race a
revision; the fence exists for stale knowledge, not concurrency.

After compaction, the compacted context may no longer contain the document.
The list and read tools exist for exactly this: the model lists the work
stream's artifacts, reads the one in question through the same bounded
read-window contract the attachment reader uses, and revises from what it
read.

### What stays inline

Conversational answers, explanations, opinions, short how-tos, code review
commentary, a list of options, a single code snippet — all remain ordinary
messages. The heuristic's default is inline; an artifact is the exception a
document-shaped request earns. When a participant says "just answer here",
the answer is inline no matter its length; when they say "make that an
artifact", it is one no matter how short.

### The creation heuristic

The decision is the model's, steered by standing policy in the work-stream
system prompt — a new prompt module beside the response-formatting policy,
written to the prompt-authoring rules and pinned by the golden-hash tests.
The policy's intent, which the prompt renders in its own words:

- Create an artifact when the participant explicitly requests a document
  type — a PRD, press release, plan, spec, brief, report, proposal, memo,
  or comparable named deliverable — or asks for one by implication ("write
  something I can send to the board").
- Create one when the planned answer is a substantial structured composition:
  longer than roughly three paragraphs *and* organized with headings,
  multiple sections, or a table intended to stand alone.
- Do not create one for conversational answers of any length, for content
  whose home is another tool (HyperSight blocks, meeting notes, memory,
  Terminal files), or against an explicit participant instruction.
- Keep in-feed narration around a card short and free of the document's
  content.

Because the prompt ships inside the API Workers, retuning any of this — the
document-type list, the length instinct, the tone of the framing text — is a
server deploy. No client release, no flag change, no schema change. The
per-workspace lever, if one is ever wanted, is a Flagship rule; V1 does not
build it.

## Impact on the product contract

None — this is the "deliverable" clause of the work-stream definition made
visible, within the existing contract. An artifact is persistent message
content in its work stream, so the persistent kinds do not change; opening or
reading an artifact is viewing and creates no participation, while asking for
one or for a revision is posting, which already does; the agent acts only
through typed, authorized tools; the panel is a use of the contextual right
rail the contract already names, not a new surface; and nothing here adds a
channel, a global library, search, or a global inbox — non-goal 5 rejects
those outright. No clause moves.

## Decision log

None yet.

## Key design decisions

1. **An artifact is transcript content, not a store beside it.** The document
   lives in a typed work-stream message; identity, revisions, and content all
   ride the durable message substrate. Every existing consumer — sockets,
   pagination, reconnect, replay, compaction, delivery — sees artifacts
   without integration work, which is precisely what the retired 2026-08-12
   design lacked. The rejected alternative was a first-class store
   (WorkstreamDO tables materializing a `resources` row, the meeting-notes
   hybrid): strictly more machinery — settle RPCs, receipts, inventory
   participation, retention — serving consumers V1 does not have. It remains
   the likely V2 shape once export needs a durable address (non-goal 6).
2. **Emission is a typed tool call, never tagged spans in streamed text.**
   The contract requires typed, authorized tools, and a tool call gives the
   write a receipt, replay semantics, and a settle boundary the card can
   anchor to. The rejected alternative — parsing fenced regions out of the
   assistant's streamed prose, as chat products do — has no authorization
   story, breaks on malformed fences mid-stream, and leaves the transcript's
   stored text and its presentation disagreeing about what was said.
3. **The tool family extends `rally:workstream`, reusing the natural wire
   names.** Four tools: create, revise, list, read (catalog in
   [Agent behavior](#agent-behavior)). The wire name
   `workstream_create_artifact` is knowingly the retired tool's name: Rally
   has no production users and therefore no historical transcript rows whose
   rendering could be confused, the name is the one a model reaches for
   unprompted, and the `AVALON_TOOL_PROSE` entry is updated to the new
   semantics in the same change. The rejected alternative was a fresh
   `rally:artifacts` plugin — a full plugin contract for four tools that
   belong with the work stream's other content operations, purely to dodge a
   name.
4. **A revision is a full replacement appended as a new message,
   compare-and-swap fenced on `expectedRevision`.** Append-only keeps the
   transcript a faithful record — an old card opens the old revision — and
   full replacement keeps every revision self-contained. The rejected
   alternatives: mutating the original message in place, which fights the
   transcript's streaming, pagination, and reconnect machinery and rewrites
   shared history; and targeted span edits, deferred per non-goal 10. The
   fence follows the established `expectedRevision` protocol from the memory
   and table tools, including the conflict code that instructs a re-read.
5. **A card opens its own revision; "latest" detection is client-local.** The
   transcript is the single authority on which revisions exist, and the
   client's loaded rows are an honest, best-effort window onto it. The
   rejected alternative — a server-maintained latest-revision pointer — is a
   second authority to keep consistent for a convenience affordance, and it
   returns naturally with the V2 store.
6. **The panel is the existing rail slot, as a third `RailPanel` variant.**
   It inherits the shared frame, resize bounds, arbitration, theming, and
   accessibility behavior for free, and the contract's named right rail stays
   the product's one side surface. The rejected alternatives: a new wider
   reading surface, which is a visual-language contract conversation this
   feature does not need to open; and the attachment lightbox, whose
   full-window modality hides the conversation the artifact is supposed to
   sit beside.
7. **The heuristic is standing policy, not client logic and not a
   classifier.** Policy ships with the server and retunes in one deploy;
   client heuristics would pin behavior to a release train, and a
   pre-classifier adds a model call and a latency step to every message for
   a decision the responding model can make in context. The addressing
   classifier remains the template if evidence later demands one (non-goal
   11).
8. **`artifacts-enabled` is consulted server-side at run admission and
   bucketed by workspace.** The flag decides whether the artifact tools and
   policy enter a run's frozen scope. This makes it the second deliberate
   exception, after `digests-enabled`, to the rule that managed product
   Booleans are presentation-only — gating registration on the server is
   what makes rollback total and skew-safe. Bucketing is by `workspaceId`
   because artifacts are a multiplayer surface: a per-user rule would show
   some participants cards their flag says do not exist. The rejected
   alternative, a client-only presentation flag, leaves flag-off clients
   receiving message types they hide but still store.
9. **The model-facing projection carries an artifact's content once.** The
   artifact message is the canonical owning record of the content; the tool
   call that wrote it already appears in the model's own history with the
   content as its argument. Projection and replay must not hand the model
   both copies — the artifact message projects to the model as identity
   (id, title, revision) with the content reachable by the read tool, per
   the one-owning-record invariant of the ordered-turn transcripts PRD. The
   rejected alternative, full content in both places, doubles context spend
   on every document.
10. **Excluded run origins stay excluded until their delivery paths learn
    artifacts.** Automation, inbound-email, and delegated child runs (non-goal
    8) answer to consumers — digest email, `resultDelivery`, parent tool
    results — that would today deliver a stub instead of a document. The
    2026-08-12 retirement is the standing evidence for treating "who reads
    this?" as a blocking question, not a follow-up.

## Data model

No new tables, no D1 migration, no new Durable Object, no R2 objects. An
artifact is stored where messages are stored, in the owning `SubstreamAgent`'s
`parts` table:

- `message_type = 'artifact'` — a new value of the deliberately un-CHECKed
  product vocabulary column; no `parts` rebuild.
- `kind = 'text'`, `role = 'assistant'`, `author_type = 'agent'` — an
  agent-authored content row on the existing append path.
- `content` — the artifact's Markdown, under the existing message-content
  bounds; no new size limit is introduced.
- `structured_content_json` — the typed card payload: `artifactId` (UUIDv7,
  allocated server-side under the tool receipt so replay returns the same
  id), `title`, `kindLabel`, `revision`, `format` (fixed `"markdown"` in V1).

The current revision number of an artifact is derived — the highest
`revision` among the work stream's artifact rows carrying that `artifactId` —
not counted in a second place. The one-mutating-run-per-substream constraint
serializes writers, so the derivation cannot race.

On the wire, `Message.messageType` gains `"artifact"` and
`structuredContent.artifact` carries the payload above; the desktop adds the
matching branch to its message mapping, its cached-message schema (an
unvalidated type is dropped from cache today), and the transcript block
dispatch.

Negative space, stated deliberately: no regional D1 row — the dropped
`artifacts` table stays dead; no WorkspaceDO or WorkstreamDO table; no
`resources` materialization (non-goal 6); the always-empty
`WorkstreamContextSchema.artifacts` field stays empty and unrepurposed; the
owed R2 sweep from the 2026-08-12 retirement is untouched by and unrelated to
this change.

## Regional impact

None beyond what the substrate already guarantees. Artifact rows live in the
jurisdiction-locked `SubstreamAgent` of their work stream's region and never
cross the boundary; no queue or workflow carries artifact content. As with
all model output, artifact-producing inference is archived in the Global
lakehouse only — EU inference is intentionally not archived, and debugging an
EU workspace's artifact generation stops at the regional boundary with no
Global fallback. Product analytics for artifact interactions follow the same
asymmetry.

## Security and trust model

The trust surface barely moves, and where it does, it reuses guarded paths:

- Artifact content is model-written Markdown rendered exclusively through the
  single `MarkdownBody` mount, inheriting the normalization pipeline, the
  never-navigable mention chips, and the renderer-isolation posture that
  already applies to every agent message. No new renderer, no HTML, no remote
  content.
- Copy uses the existing main-process clipboard bridge; no new IPC surface.
- The artifact tools are authorized exactly as their siblings on
  `rally:workstream`: the work stream and substream come from the run's
  frozen, host-derived scope, never from model-chosen identifiers, and
  knowing an `artifactId` grants nothing outside that scope.
- `artifacts-enabled` is a rollout control, not protection: it gates whether
  the capability is offered, and nothing that protects data is scoped by it.

## Agent behavior

The `rally:workstream` plugin (default-loaded; wire prefix `workstream_`)
gains four tools, registered only when the run's admission resolved
`artifacts-enabled` for the workspace and the run's origin is an ordinary
participant-triggered work-stream run (non-goal 8). Registration state is
frozen into the run scope like every other authority; loading no plugin and
answering no elicitation changes it mid-run. The system prompt carries the
artifact policy (see [the heuristic](#the-creation-heuristic)) only when the
tools are registered, so the model is never told about tools it cannot call.

| Canonical (wire) name | Capability | Mode | Idempotency | Purpose |
| --- | --- | --- | --- | --- |
| `create_artifact` (`workstream_create_artifact`) | `artifact.write` | write | replayed from the tool receipt; the server allocates `artifactId` once under the receipt, so a replay returns the persisted identity | Publish a new artifact at revision 1. |
| `revise_artifact` (`workstream_revise_artifact`) | `artifact.write` | write | replayed from the tool receipt; the revision commits at most once per receipt | Publish the next revision of an existing artifact. |
| `list_artifacts` (`workstream_list_artifacts`) | `artifact.read` | read | safe | Enumerate the work stream's artifacts: id, title, kind label, current revision, updated-at. |
| `read_artifact` (`workstream_read_artifact`) | `artifact.read` | read | safe | Read an artifact's content — current or a named revision — through the same bounded window and cursor contract as `workstream_read_resource`. |

Wire shapes, concisely (all inputs `additionalProperties: false`, enforced by
a strict parse; exact schemas land in contracts with the implementation):

- `create_artifact` input: `title` (required), `kindLabel` (required, a short
  human label), `content` (required, GFM Markdown). Output: `artifactId`,
  `revision: 1`, `title`, `createdAt`.
- `revise_artifact` input: `artifactId` (required), `expectedRevision`
  (required — "pass exactly the `revision` returned by
  `workstream_create_artifact`, `workstream_read_artifact`, or your last
  revision"), `content` (required, the complete replacement), `title`
  (optional retitle). Output: `artifactId`, `revision` (the new number).
- `list_artifacts` input: optional `cursor`. Output: entries plus a
  continuation cursor when more exist.
- `read_artifact` input: `artifactId` (required), `revision` (optional,
  defaults to current), optional range cursor. Output: the content window,
  `revision`, `title`, and range cursors, in the attachment reader's shape.

Failure contract — stable codes with the model-visible sentence carrying the
next action, structured detail only from the existing allowlist:

| Code | Model-visible error sentence |
| --- | --- |
| `artifact_not_found` | "No artifact with that id exists in this work stream. Call `workstream_list_artifacts` to see what exists." |
| `artifact_revision_conflict` | "The artifact changed after it was read. Call `workstream_read_artifact` for the current revision and content, rebuild the revision, and retry with the returned revision." |
| validation failures | The shared strict-parse vocabulary: unknown keys named, missing fields named, no submitted values echoed. |

Sequencing and discovery: a create is self-sufficient; a revise needs an
`artifactId` and `expectedRevision`, both of which come only from this
family's own outputs; after compaction the recovery path is list → read →
revise. The obvious wrong first call — revising by title, or with a stale
revision — fails into a sentence that names the correcting call. Both write
tools return everything a follow-up call needs; neither returns a URL,
because an artifact's address is its work stream (deep links are a later
slice).

Transcript presentation of the tools themselves: each gets active-voice
per-lifecycle prose in the tool-activity map ("Drafting …", "Revising …"),
satisfying the prose test that rejects generic or passive rows. The retired
`workstream_create_artifact` prose entry is replaced, per key design
decision 3.

Model-usability acceptance, per the tool-design standard: the new schemas are
reachable by the schema-sanitization walk and named in it; contract tests
cover required, optional, forbidden, success, and failure shapes; and prompt
evaluations on the configured medium fallback model must show — from the
schema and policy alone — a document request producing one create with brief
narration, a conversational question producing no artifact call, a revision
request reusing the id and revision correctly, recovery from
`artifact_revision_conflict` and from a wrong first call without looping, and
obedience to both explicit participant overrides.

## Rollout

1. The flag: `artifacts-enabled`, a managed product Boolean served as
   `artifactsEnabled` — fail-closed, default variation off, created together
   with its initial targeting rule (staff via the approved
   `userEmailDomain`-family attributes, then dogfooding workspaces), edited
   through Ace, added to Ace's ensured flag set, delivered per-user over the
   WorkspaceDO flag push with up-to-30-second propagation. Per key design
   decision 8 it is additionally consulted at run admission, and rollout
   cohorts bucket by `workspaceId`.
2. Ordering: (a) API deploy — tools, prompt policy, and wire type ship
   dormant behind the flag, off everywhere; (b) desktop release with the
   card, panel, and schema branches; (c) flag on for staff workspaces;
   (d) widen cohorts as dogfooding holds. The order makes version skew
   harmless: no server emits an artifact message before clients that render
   them are released.
3. Rollback is the flag: off stops registration for new runs immediately.
   Existing artifact cards remain in transcripts and continue to render —
   they are ordinary durable messages, and nothing is deleted or migrated by
   turning the feature off.
4. The prompt-policy addition lands inside the existing work-stream prompt
   version discipline; whether it warrants a `WORKSTREAM_PROMPT_VERSION` bump
   is settled at implementation against the in-flight-run cost that decision
   carries (see Open questions).

## Acceptance

1. In a flag-on workspace, "draft a PRD for <topic>" in a work stream yields:
   a tool-activity row, an artifact card titled accordingly, and a short
   conversational message — with the full document nowhere in the transcript.
2. Clicking the card opens the right-rail panel showing the formatted
   document; headings, tables, and code blocks render through the shared
   renderer; text is selectable; **Copy** yields the stored Markdown.
3. "Tighten the goals section" then yields a **Revised** card with revision
   2; opening it shows the updated document; the original card still opens
   revision 1; the older panel offers **open latest**.
4. A short factual question in the same work stream produces an inline answer
   and no artifact. "Just answer in chat" defeats the heuristic for a
   document-shaped ask; "make that an artifact" creates one from a short
   answer.
5. A second participant in the work stream sees the same cards live, opens
   the same content, and sees revision cards appear as they are published.
6. In a flag-off workspace no artifact tool is registered, no policy text is
   rendered into the prompt, and no artifact message is ever emitted.
7. Post-compaction, a revision request succeeds via list → read → revise, and
   a deliberately stale `expectedRevision` yields the conflict sentence and a
   successful model recovery.
8. The panel behaves within the rail contract: hand-off from the inspector
   and HyperSight panels, resize within the shared bounds, scrim at narrow
   widths, Escape restores focus.
9. Every new surface is captured from the running desktop client under Xvfb
   and the images read, per the visible-change rule; `pnpm lint` (zero
   warnings), `pnpm typecheck`, and `pnpm test` pass; prompt golden hashes
   are updated deliberately; and each new test is shown to fail when the
   behavior it protects is broken.

## Open questions

1. **Where does the policy text physically fit?** The standing work-stream
   policy has a byte ceiling held historically by moving content out, not
   raising it. If the artifact policy does not fit the budget, it ships as an
   always-available skill instead. Changes implementation placement only;
   blocks nothing.
2. **Does the prompt change bump `WORKSTREAM_PROMPT_VERSION`?** A bump fails
   resumed in-flight runs across the deploy; not bumping ships new policy
   under the frozen version, which precedent allows. Decides deploy
   sequencing, not product behavior.
3. **What is the user-facing noun?** "Artifact" is the working internal name;
   whether cards and the panel say "artifact", "document", or only the kind
   label is a copy decision to settle against real screenshots during
   implementation. Changes UI strings only.
