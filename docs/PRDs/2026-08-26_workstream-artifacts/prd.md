# Work-stream artifacts

> Created 2026-08-26. Revised 2026-08-26 against the product discussion that
> fixed day-one versioning, opened the generation-protocol decision, and
> posed the artifact/resource unification question.
>
> When Rally is asked for a document — a PRD, a press release, a plan, a
> brief, an FAQ, a multi-section analysis — it publishes the document as an
> **artifact**: a card in the transcript, a readable pane in the right rail,
> a version history from day one, revised through conversation instead of
> re-pasted into it. V1 is reading, copying, and agent-driven revision only.
> Companions: [state](state.md), [design](design.md) — the
> generation-protocol decision framework and the data-model rationale live
> there. Subsystem references: [agent harness](../../agent-harness.md),
> [agent tools](../../agent-tools.md),
> [agent attachments](../../agent-attachments.md),
> [meeting notes](../../meeting-notes.md),
> [markdown rendering](../../markdown-rendering.md),
> [work-stream Durable Objects](../../workstream-durable-object.md),
> [feature flags](../../feature-flags.md). Related PRD:
> [ordered work-stream turns](../2026-08-26_ordered-workstream-turn-transcripts/prd.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

When a participant asks for something whose natural shape is a document,
Rally answers conversationally and puts the document itself in an artifact.
The transcript shows a short preamble, a compact artifact card, and a short
postamble inviting iteration; the long-form content lives behind the card, in
a readable document pane that opens in the existing right rail. The
conversation continues around the card: a participant asks for changes in the
composer, and Rally publishes the next version — same artifact, same card
identity in the feed, a version history the pane exposes from the first
release. Every participant sees the same cards, the same pane, and the same
versions, because an artifact is a work-stream resource: the same durable,
workspace-owned object kind that carries every attachment, with a different
role. Resources are what a work stream feeds the model; artifacts are what
the model hands back. One object kind, two roles.

This PRD deliberately distinguishes four tiers, and each section labels which
tier it is writing about:

- **The Friday V1** — what ships first: agent-created single-file Markdown
  artifacts, the card, the read-only pane with selection, copy, and a version
  list, and revision through conversation.
- **Designed now, inactive in V1** — foundation that is prohibitively
  expensive to retrofit and cheap to lay down: the version ledger's author
  provenance (human and connector authors exist in the schema before any
  surface writes them), the producer-agnostic write contract that keeps the
  UX independent of the generation protocol, and the resource machinery that
  already supports cross-work-stream reference.
- **Roadmap** — human editing, comments and annotations, collections,
  richer artifact types, export ([the trajectory](#beyond-v1-the-staging-trajectory)).
- **Open decisions** — the generation protocol's final confirmation, the
  heuristic's exact mix, proactive creation, and the user-facing noun
  ([Open questions](#open-questions)).

The generation protocol — how the model's output becomes an artifact — is
deliberately not settled by fiat. Three candidate mechanisms (markup
extraction, typed artifact tools, the Terminal file workflow) are compared in
[`design.md`](design.md) across model-training alignment, tool-selection
ambiguity, latency, observability, revision behavior, compaction recovery,
future human editing, implementation complexity, and multi-file support. The
recommendation is typed tools for V1, confirmed by a pre-implementation
evaluation, and the data model is shaped so the choice is swappable: a
version enters the ledger with provenance, whoever produced it, and the card,
pane, and history do not know or care which protocol wrote it.

One V1 divergence is accepted knowingly: until the ordered-turn transcript
substrate lands, a run's narration is one message positioned after its tool
activity, so the feed shows the card first and the framing prose after it
rather than preamble → card → postamble (key design decision 12). The surface
this PRD specifies does not change when the substrate ships; the ordering
converges.

The trajectory this starts: Rally as the rapid, multiplayer staging
environment for AI-generated work — shared context in, drafts generated,
refined together in the work stream, and only then handed off to wherever the
finished thing formally lives. Google Docs and Notion remain the destination
for formal editing, sharing, and distribution; Rally competes on the
shared-context drafting loop before that, not on the editor.

## Motivation

A work stream's transcript is, by contract, "a readable shared transcript."
Today a request like "draft the launch press release" defeats that clause:
the answer streams in as one assistant message spanning many viewport heights
of headings, tables, and sections. Four costs, all observed in dogfooding:

1. **The conversation stops being scannable.** The document buries every
   message around it. A participant returning to the work stream scrolls
   through pages of generated prose to find the human exchange, and the
   transcript-follow and unread machinery dutifully lands readers inside the
   middle of a document rather than at the conversation.
2. **Collaborators feel obliged to process the whole output before they can
   speak.** A multiplayer surface filled by one long message reads as
   finished work demanding full review, not as a draft under discussion. The
   conversational moves Rally wants — "tighten the second section", "add a
   risks table" — have no anchor when the draft and the discussion are the
   same undifferentiated column of text.
3. **Iteration multiplies the problem.** Each revision request produces
   another full copy of the document inline. Three rounds of edits is four
   documents' worth of scrollback in a surface people share — and nothing
   ties the copies together as versions of one thing.
4. **The output has no identity.** A document that exists only as message
   text cannot be listed, versioned, referenced from elsewhere, or later
   edited or exported. Every future the product wants for generated work
   needs the output to be an object, and today it is prose.

The opportunity is equally concrete. The work-stream contract names the
"deliverable" as one of the five things a work stream is the home for, and
work streams already do the input half well: participants pool transcripts,
PDFs, links, screenshots, and connector documents as resources, and the
model reads them through the attachment rails. What is missing is the output
half — the deliverable as a first-class thing the group can open, discuss,
revise, and eventually hand off. Rally is closest to being the place where a
team and an agent stage a document *together*; that loop, not a word
processor, is the product.

Rally has also been here before, from the other direction. The original
prototype had artifacts — a `workstream_create_artifact` tool, an
`artifact.write` capability, an R2 store, a download route, a transcript
block — and retired them on 2026-08-12 (the
[agent harness changelog](../../agent-harness.md): "Artifacts are gone; a
run's output is its final message"). The failure was not the idea but the
shape: artifacts were a write destination nothing read back. The scheduled
digest mailed the run's final message, so a run that parked its output in an
artifact delivered "Outcome: Digest artifact created" and nothing else, and
the model itself could not see or revise what it had produced. That
retirement entry left the standing instruction this PRD now follows —
"anything durable that a person should be able to open belongs in
`resources`" — and residue this PRD must not disturb: the regional D1
`artifacts` table is dropped and must not be recreated, an R2 sweep under
`<region>/<workspace>/artifacts/` is still owed, `AVALON_TOOL_PROSE` retains
the retired tool's entry so historical rows still render, and
`WorkstreamContextSchema` carries an always-empty `artifacts` field for
released desktop builds.

This PRD is the corrected shape. An artifact is a resource: it lives on the
object rail every existing reader already serves — the model's attachment
read tools, the right rail's resource list, the compaction inventory that
survives context loss, the deletion lifecycle, the per-work-stream link
machinery. Nothing is parked where nothing looks, so the trap that killed the
first design cannot recur; what is added is the half resources never had — a
version ledger, a revision protocol, a card, and a pane.

## Goals

1. A request whose natural output is a document produces a conversational
   framing in the transcript and the document in an artifact. The transcript
   shows prose a person would say out loud plus a compact card, never the
   full document streamed inline.
2. Clicking an artifact card opens the document pane in the right rail:
   formatted Markdown through the shared renderer, readable at rail widths,
   with free text selection and a one-click copy of the version's stored
   Markdown.
3. A participant revises an artifact by asking in the conversation. A
   revision creates the next version of the same artifact — stable identity,
   monotonically numbered versions — and appears in the transcript as a
   compact revision card, never as a re-pasted document.
4. Version history exists in the data layer from the first shipped artifact,
   and the pane exposes it: a participant can open any prior version
   read-only. Versioning is not retrofittable and is therefore not deferred.
5. Short conversational answers stay inline. An explicit participant
   instruction in either direction — "make that an artifact", "just answer
   in chat" — is honored over the heuristic.
6. The create-an-artifact heuristic is standing policy in the server-shipped
   system prompt: prompt-driven, tunable by API deploy, requiring nothing
   from the desktop client.
7. Every participant and viewer of the work stream sees the same cards,
   versions, and content. Artifacts inherit the work stream's existing
   resource-visibility rules; they add none of their own.
8. The agent creates and revises artifacts only through typed, authorized
   operations with receipts, replay, and a compare-and-swap version fence —
   whatever generation protocol is confirmed, there is no untyped side
   channel into the ledger.
9. The data model survives the roadmap without rework: a version's author
   may later be a human or a connector, an artifact may later join a
   collection, an artifact's type may later be something other than
   Markdown, and the generation protocol may later change — all without
   migrating what V1 wrote.
10. The feature ships behind a fail-closed, workspace-scoped
    `artifacts-enabled` flag, so it can be dogfooded and rolled back without
    a desktop release.

## Non-goals

1. **A human editing surface in the pane.** Deferred — the first roadmap
   phase after V1. In V1 a person changes an artifact by asking Rally; the
   pane is read-only. The version ledger's author provenance is designed for
   human authors now (goal 9) precisely so this deferral costs no migration.
2. **A Google-Docs-quality editor, multi-cursor editing, or presence.**
   Rejected for the foreseeable product. Docs and Notion remain the
   destination for formal editing; Rally's job is the staged drafting loop
   before export, and building a second Docs is the fastest way to lose that
   framing.
3. **Inline comments and annotations on artifacts.** Deferred — a later
   roadmap phase. They raise a real contract question — whether annotating
   creates participation the way answering an elicitation does — that
   deserves its own PRD.
4. **Visual diffs between versions.** Deferred. V1 stores complete versions,
   which is exactly what a later diff surface needs: diffs are computed
   externally by comparing stored versions, never trusted from the model's
   own account of its edits (key design decision 5).
5. **Export and write-back integrations (Google Docs, Notion, Drive).**
   Deferred — the trajectory's hand-off phase. When export comes it follows
   the existing contract for external writes — idempotent, visible, audited,
   no new approval gate. V1 offers copy, which already gets the content
   anywhere.
6. **A live embedded browser or iframe editing surface for external
   documents, or continuous bidirectional synchronization with them.**
   Rejected for V1 and unpromised beyond it. V1 treats a fetched external
   document as a snapshot resource, exactly as attachments work today; the
   subscription future is designed as dormant provenance, not as sync
   (see [External documents](#external-documents-snapshot-now-subscription-later)).
7. **Executing rich artifact types.** Deferred as capability, protected as
   representation: nothing in V1 renders HTML, runs an app, or evaluates a
   spreadsheet, and the pane renders Markdown only — but the artifact object
   carries a type, so later types are new renderers and policy, not a new
   object model. The platform path for the reactive end — Dynamic Workers
   run as supervised Durable Object facets — is identified and sketched in
   [`design.md`](design.md), still gated on its own security PRD.
8. **A workspace artifacts library, cross-work-stream artifact search, or
   sharing an artifact outside its work stream.** Rejected. Rally is
   organized around work streams rather than channels, search, or a global
   inbox, and a documents library is a global inbox by another name. An
   artifact is reached through its work stream. (Cross-work-stream
   *reference* — attaching an existing artifact to another work stream — is
   a different thing the resource model supports by construction; V1 builds
   no surface for it.)
9. **Making every AI answer an artifact.** Rejected. The heuristic's default
   is inline; an artifact is the exception a document-shaped output earns.
   Conversational answers of any length stay conversation.
10. **Artifacts from automation runs, inbound-email runs, and delegated
    child runs.** Deferred. Those runs deliver results by paths (digest
    email, automation `resultDelivery`, tool results to a parent) that do
    not yet know what an artifact is; enabling artifacts there before the
    delivery integration exists would re-create the 2026-08-12 trap. V1
    registers artifact writes for ordinary participant-triggered work-stream
    runs only.
11. **Formats beyond GitHub-flavored Markdown in V1.** Deferred. The
    response formatting policy is GFM-only today and the shared renderer is
    a Markdown renderer. Fenced code blocks inside an artifact are fine;
    code *files* belong to the Terminal plugin's published resources.
12. **Targeted-edit revision operations (`replace_in_artifact` and kin).**
    Deferred. A V1 revision replaces the whole content, which keeps the
    write contract one field wide, makes every version self-contained, and
    is what external diffing needs anyway. Adopt span edits only with
    evidence full replacement hurts (long documents, small edits), and then
    as a protocol detail beneath the same ledger.
13. **A multi-file artifact collection object in V1.** Deferred. A V1
    artifact is exactly one file. A request that genuinely wants several
    documents ("a media packet") produces several artifacts, each with its
    own card. Because artifacts are independent resources, a collection is
    a later additive grouping — a new small association, not a reshaping of
    what V1 wrote (key design decision 6).
14. **A pre-classifier model call deciding artifact-vs-inline.** Deferred.
    Standing policy plus the responding model's own judgment is the V1
    mechanism; the addressing classifier is the template if evidence later
    demands a dedicated one, and `AGENT_MODEL_ROLES` is where it would slot.
15. **New defensive numbers.** Rejected — none are added. Artifact content
    rides the existing resource and message bounds; version counts are
    bounded by the run machinery that already exists. Any guard an
    implementer nonetheless discovers a need for ships open under the
    `LIMIT UNSET` rule, with the number handed back to the team.

## Product behavior

### Primary user stories

The behavior below serves five people; the first four are V1, the fifth is
the trajectory's reason to exist. Acceptance walks each path.

1. **The requester.** A product manager pools context in a work stream —
   meeting transcripts, a PDF of the old spec, screenshots, links — and asks
   Rally for a PRD. They get a draft as an artifact they can open, read, and
   copy, without the draft taking over the conversation they asked from.
2. **The collaborator.** A second participant, watching the same work
   stream, sees the card land and has an anchor for conversational feedback
   — "tighten the goals", "add a risks table" — instead of a wall of
   finished-looking text they feel obliged to fully read before speaking.
3. **The reviser.** Any participant asks for changes in the composer and
   watches the artifact advance to its next version — the same document
   updated, not another wall of text.
4. **The returning reader.** Someone opening the work stream later scans a
   transcript of conversation punctuated by compact cards, lands where the
   unread machinery puts them, opens the current draft when they choose to,
   and can look back at how it got there through the version list.
5. **The hand-off owner** *(trajectory)*. When the group is satisfied, the
   draft leaves Rally for its formal home — copied today, exported through a
   connector later — and the work stream remains the record of how it was
   made.

### Providing context and asking

Steps one and two of the loop already exist and are unchanged: participants
attach transcripts, PDFs, links, screenshots, and connector documents to the
work stream as resources, and the model reads them through the attachment
tools under the existing visibility rules. An external document fetched
through a connector or web tool arrives as a snapshot resource — what V1
adds is on the output side only.

### Creating an artifact

A participant asks for something document-shaped — "draft a PRD for mute
windows", "write the launch press release", "turn this thread into an exec
brief". Rally recognizes the shape (see
[the heuristic](#the-creation-heuristic)) and, during the run, writes the
document into a new artifact: title, a short kind label, and the full
Markdown content. The transcript shows, in order:

1. The standard tool-activity row while the write is in flight, with prose
   of the form **Drafting "Mute windows PRD"** — the same lifecycle row
   every tool gets, settling to completed.
2. The artifact card, appended when the write settles.
3. Rally's conversational text for the run: a short framing of what it made
   and an invitation to iterate — "I've drafted the PRD. Tell me what you'd
   like changed."

Until [the ordered-turn transcript
substrate](../2026-08-26_ordered-workstream-turn-transcripts/prd.md) lands,
a run's narration is one final message positioned after its tool activity,
so the card precedes the prose and the preamble and postamble arrive as one
short message. That is a deliberate, named divergence from the ideal
preamble → card → postamble shape, accepted in key design decision 12 rather
than taking the substrate cutover as a dependency. The standing policy
therefore tells the model to produce the artifact early in the turn and keep
all narration brief and content-free; once the substrate ships, narration
and cards interleave in true model order, and the surface this PRD specifies
is unchanged.

A request that genuinely asks for several documents ("draft the PRD and the
announcement email"; "put together a media packet") produces several
artifacts, each with its own card. Policy discourages gratuitous
multiplication: one request, normally one artifact.

### How creation is signaled

The user experience above is deliberately independent of the mechanism that
produces the artifact. The load-bearing abstraction is the version ledger's
write contract: *a version enters the ledger with content, a title, and
provenance — which run, which protocol, later which person — and the card,
pane, and history render from the ledger without knowing who wrote it.*
Three candidate protocols can satisfy that contract — markup extraction from
the response text, typed artifact tools, and the Terminal file workflow —
and the full comparison across model-training alignment, tool-selection
ambiguity, latency, observability, revision behavior, compaction recovery,
future human editing, implementation complexity, and multi-file support is
in [`design.md`](design.md).

The recommendation, argued there: **typed artifact write operations for V1**
— a create and a revise, carried like every Rally tool with receipts,
replay, and typed failures — with the Terminal file workflow preserved as a
designed-in future producer (its publish path already lands files as
resources) and markup extraction set aside on reliability and authorization
grounds without being locked out of the framework. The recommendation is
confirmed, not assumed: before implementation hardens, the evaluation named
in [Open questions](#open-questions) runs the candidate protocols against
a small fallback-stage model from the work-stream route plan on real
document tasks, and the result is recorded in this PRD's decision log. Whichever protocol wins, the model's
conversational text stays conversational — the document travels through the
protocol, and the chat/document split is soft-enforced by standing policy
and hard-verified by prompt evaluations.

### The artifact card

The card is a compact, quiet block in the transcript — sibling to the
elicitation panel and suggestion block, not a document preview. It is the
minimum card that does its job:

- the artifact title;
- the kind label the model supplied ("PRD", "Press release", "Plan");
- **Created** on the first version, **Revised** afterwards, with the version
  number ("V3");
- nothing else. No excerpt, no scrolling body: the card marks where the
  document happened and opens it, and does not leak the wall of text back
  into the feed.

Clicking anywhere on the card opens the pane on the artifact's **current**
version — the card is an announcement of an event, and the artifact is a
durable object whose present state is what a reader almost always wants; the
version the card announced is one click away in the pane's history (key
design decision 7). Because the card is an ordinary message row, it
participates in everything messages already do: live delivery on the feed
socket, pagination, reconnect, the shared transcript's identical rendering
for every participant, and the automation chat surface's shared styling.

The desktop's artifact branch validates the card payload at render time, not
at ingestion: a message whose `structuredContent.artifact` fails validation
(a future payload shape this build does not know) is kept and falls back to
rendering its text content as an ordinary agent message — degraded but
readable, never dropped. This is a requirement on the new branch, not
today's behavior; today an unknown message shape is rejected wholesale (see
[Data model](#data-model)), which is exactly what the artifact branch must
not do to its own future payloads.

Artifacts also appear where resources already appear: the right rail's
resource list shows them under the same visibility predicate the model's
list tool uses, so the pane is reachable without scrolling for a card.

### The document pane

The pane is the third occupant of the existing right-rail slot, beside the
inspector and HyperSight, using the shared rail frame: same fixed slot, same
resize handle and width bounds, same cross-fade hand-off, same
scrim-at-narrow-widths behavior, same Escape-to-close and focus restore.
Only one rail panel holds the slot at a time; opening an artifact hands off
from whichever panel is open, and the rail toggles in the work-stream header
behave as they do today.

Inside the pane:

- A header with the artifact title, the kind label, the version indicator
  (**V3**), a **Copy** action, and a close control.
- A version list, opened from the version indicator: every version, newest
  first, each row carrying its number, author ("Rally" in V1), and time.
  Selecting a row shows that version read-only, plainly labeled as not
  current (**Viewing V1 of 3 — show current**). This list is the whole V1
  version UI; a diff view is non-goal 4.
- The document body: the selected version's Markdown rendered through the
  shared `MarkdownBody` renderer — the single `react-markdown` mount, with
  the standard model-text normalization, code-block highlighting and
  per-block copy, scrolling tables, and mention chips that are never
  navigable. Host styling overrides typography only, following the document
  scale precedent, and every color comes from theme tokens.
- Free text selection everywhere in the body. **Copy** places the viewed
  version's stored Markdown bytes on the clipboard through the desktop
  bridge — the stored bytes, not the rendered text, matching the per-turn
  Copy precedent — and records copy product-intent telemetry.

States, exhaustively: opening the pane fetches the version's content through
the authorized resource-preview route, so there is a brief **loading** state
(a quiet skeleton in the pane body — the header renders immediately from
the card payload). **Populated** is the normal state. **Error** — the fetch
fails — shows an inline retry affordance and never a blank pane. **Offline**
— cards render from the cached transcript; opening a version already viewed
this session shows the client's cached copy, opening one never fetched shows
the error state's retry; asking for a revision needs a connection exactly as
sending any message does. There is no empty state: the pane only opens on an
artifact that exists. A card whose payload is unreadable falls back as
described above and offers no pane.

### Versions and revision

A participant asks for changes in the composer, in ordinary language. The
run revises the artifact: same identity, next version number, complete
replacement content (non-goal 12). On success:

- a compact **Revised** card appears at that point in the transcript with
  the new version number;
- an open pane showing the current version updates to the new current
  version, visibly but without stealing focus; a pane pinned to a prior
  version stays where the reader put it;
- every earlier version remains in the ledger, one click away — the
  transcript records *when* revisions happened, the ledger records *what*
  each one was.

The semantics, precisely: versions are monotonic per artifact, starting at
one. The write carries a compare-and-swap fence — the version the producer
believes is current — and a stale fence refuses with a typed conflict
telling the model to re-read and rebuild. The fence exists for stale
knowledge (a run revising after compaction, a later run having revised in
between), not for concurrency: version writes serialize at the owning
authority. Models sometimes rewrite wholesale and sometimes make targeted
edits; V1 does not care — whatever the model intended, the ledger stores the
complete resulting version, and any future diff surface compares stored
versions externally rather than trusting the model's account of its own
edits (key design decision 5).

Because an artifact is a resource, the model re-discovers it the way it
re-discovers every attachment: the compaction-surviving inventory counts
it, the list and read tools page and read it, and a post-compaction
revision request recovers by list → read → revise. One artifact-specific
addition is deliberate rather than inherited: the host-rendered inventory
appendix carries per-kind counts, never identities, so the compaction
summary prompt gains the instruction ([Rollout](#rollout)) to retain
artifact ids, titles, and current version numbers exactly.

### What stays inline

Conversational answers, explanations, opinions, short how-tos, code review
commentary, a list of options, a single code snippet — all remain ordinary
messages. The heuristic's default is inline; an artifact is the exception a
document-shaped output earns. When a participant says "just answer here",
the answer is inline no matter its length; when they say "make that an
artifact", it is one no matter how short.

### The creation heuristic

The decision is the model's, steered by standing policy in the work-stream
system prompt — a new prompt module beside the response-formatting policy,
written to the prompt-authoring rules and pinned by the golden-hash tests.
This is a tunable heuristic, not a permanent threshold: the policy's intent,
which the prompt renders in its own words and which instrumentation
([Rollout](#rollout)) exists to retune:

- Create an artifact when the participant explicitly requests a document
  type — a PRD, press release, plan, spec, brief, report, proposal, memo,
  FAQ, media packet, or comparable named deliverable — or asks for one by
  implication ("write something I can send to the board").
- Create one when the planned answer is a substantial structured
  composition: longer than roughly three paragraphs *and* organized with
  headings, multiple sections, or a table intended to stand alone. The
  conjunction is deliberate — either signal alone over-triggers (key design
  decision 10) — and it is the first thing the tuning loop revisits.
- Create one when a large result would otherwise bury the conversation,
  even if it is not a named document type — a long comparative analysis, a
  generated FAQ — and say so in the framing text.
- Do not create one for conversational answers of any length, for content
  whose home is another tool (HyperSight blocks, meeting notes, memory,
  Terminal files), or against an explicit participant instruction.
- Keep in-feed narration around a card short and free of the document's
  content.

The failure modes to tune against, named so the instrumentation can count
them:

- **False positives** — artifacts nobody wanted: a long but conversational
  explanation carded; a step-by-step answer to "how do I…" carded; a
  code-review commentary carded; an answer the participant explicitly asked
  to see inline carded anyway. The observable signals: "just answer in
  chat" overrides, cards never opened by anyone, artifacts with exactly one
  version and no opens.
- **False negatives** — walls of text that should have been artifacts: an
  informally-phrased document request answered inline; a structured
  multi-section answer the model underestimated; a revision of an existing
  artifact delivered as a fresh inline rewrite. The observable signals:
  "make that an artifact" overrides, and long inline assistant messages in
  flag-on workspaces.

Because the prompt ships inside the API Workers, retuning any of this — the
document-type list, the length instinct, the conjunction, the tone of the
framing text — is a server deploy. No client release, no flag change, no
schema change. The per-workspace lever, if one is ever wanted, is a Flagship
rule; V1 does not build it.

### Beyond V1: the staging trajectory

The phases after this PRD, in order, each promoted by named evidence rather
than by schedule. Every phase is a non-goal of V1 above and gets its own PRD
when its time comes; this list exists so the deferrals read as one sequence.
The tier labels from the [Summary](#summary) apply: the version ledger's
provenance and the producer-agnostic write contract are *designed now,
inactive*; everything below is *roadmap*.

**Near term:**

- **Human editing in the pane.** A lightweight whole-document edit that
  saves as a new version with a human author — the ledger's dormant
  `member` provenance activated, no schema change. The agent sees the human
  version like any other and can be asked to continue from it. Promoted
  when V1 dogfooding shows people copying content out to make small edits
  and pasting it back.
- **Collections.** A grouping object over related artifacts (the media
  packet as one thing), additive over V1's independent single-file
  artifacts. Promoted when multi-artifact requests are common enough that
  loose cards visibly fail the group.
- **The Terminal producer.** The Terminal file workflow writing versions
  into the same ledger for artifact kinds where file tooling wins (long
  documents needing targeted edits, code-adjacent outputs), per the
  framework in [`design.md`](design.md).

**Long term:**

- **Comments and annotations**, with their participation-contract PRD.
- **Richer artifact types** — structured tables, HTML dashboards, and
  realtime/reactive mini-apps under a security model of their own. The
  identified platform path for the reactive end is agent-written code run
  as a Dynamic Worker inside a supervised Durable Object facet — its own
  isolated SQLite for runtime state, bindings and network withheld by the
  supervisor, code versions deployed from the ledger
  ([`design.md`](design.md)); the object carries a type from day one so
  these are renderers and policy, not remodeling.
- **External-document subscriptions** — a watched external document whose
  changes can notify the work stream and let the agent decide whether to
  re-read; the connector-authored version is the ledger's third dormant
  provenance (see below).
- **Export and hand-off** — Google Docs, Notion, Drive integrations as
  ordinary idempotent, visible, audited external writes; a possible
  multiplayer editor only if the staging loop proves it is needed.

### External documents: snapshot now, subscription later

V1's contract with external content is the existing one, restated so the
boundary is explicit: a Google Doc, Notion page, or web page enters a work
stream as a snapshot resource at reference time, and it does not track its
source afterwards. The source can change; Rally's copy does not, and nothing
in V1 re-fetches, synchronizes, or notifies. A participant who wants the
newer state asks Rally to fetch it again, which yields a newer snapshot
under the same resource identity where the connector machinery supports it.

The future this deliberately leaves room for, without building any of it: a
watched external document (the contract's "explicitly watched resource" is
the anchor) whose change events reach the work stream as connected
activity, where the agent decides whether to re-read and whether to say so
— and, in ledger terms, a connector-authored version. That is a dormant
provenance value in V1's schema, not a dormant subsystem: no watcher, no
webhook route, no sync loop ships until that PRD is written.

## Impact on the product contract

None — this is the "deliverable" clause of the work-stream definition made
visible, within the existing contract. An artifact is a resource, one of
the contract's named persistent kinds, so the persistent kinds do not
change; opening or reading an artifact is viewing and creates no
participation, while asking for one or for a revision is posting, which
already does; the agent acts only through typed, authorized operations; the
pane is a use of the contextual right rail the contract already names, not
a new surface; and nothing here adds a channel, a global library, search,
or a global inbox — non-goal 8 rejects those outright. No clause moves.

## Decision log

None yet.

## Key design decisions

1. **An artifact is a resource — the same object kind as an attachment,
   with a generated role.** Resources are inputs supplied to the model;
   artifacts are outputs generated by it; the discussion's hypothesis that
   the distinction is role rather than object kind is adopted, because the
   codebase already proves it: Terminal publishes generated files as
   resources today, and meeting notes materialize an AI-authored document
   as a resource with a first-class authoring lifecycle beside it. An
   artifact therefore inherits, nearly whole, the read tools, the
   right-rail listing, the visibility predicate shared between sidebar and
   model, the compaction inventory, the content residency and deletion
   lifecycle, and the per-work-stream link machinery — the exact rails
   whose absence killed the 2026-08-12 design. The three deliberate
   exceptions are named where they land: swap-time content reaping learns
   the ledger (Data model), the read rail's outputs gain the current
   version number (Agent behavior), and the compaction summary prompt
   retains artifact identity (Rollout). The rejected alternatives: a parallel artifact
   store (forks every one of those rails; the Terminal PRD already rejected
   a Terminal-specific artifact table for this reason), and this PRD's own
   earlier draft — artifact-as-transcript-message — which could not carry a
   version history UI, multi-file futures, or human editing without
   becoming a store anyway. The full assessment is in
   [`design.md`](design.md).
2. **The version ledger exists from day one, in the data layer, with
   provenance wider than V1 uses.** Versioning is the one piece that
   cannot be retrofitted: without it, V1 artifacts would be
   current-pointer-only objects (the meeting-notes shape) whose history is
   unrecoverable later. The ledger records, per version, the complete
   content and its author provenance — `agent` (V1 active), `member`
   (dormant until human editing), `connector` (dormant until
   subscriptions) — so the roadmap activates authors instead of migrating
   them. The rejected alternative was current-pointer-only V1 with
   versions later, which silently loses every V1 artifact's history.
3. **The write contract is producer-agnostic; the generation protocol is a
   confirmed recommendation, not an axiom.** The ledger accepts a version
   with content, title, fence, and provenance; cards, pane, and history
   render from the ledger. Typed artifact operations are the V1
   recommendation — best authorization, observability, and latency fit
   today — with the Terminal file workflow a designed-in future producer
   and markup extraction set aside but not struck from the framework. The
   comparison and the confirming evaluation are specified in
   [`design.md`](design.md); the outcome lands in this decision log. The
   rejected alternative was locking the PRD to one mechanism (the earlier
   draft locked to tools; the discussion correctly reopened it).
4. **A revision is a full-replacement version, compare-and-swap fenced.**
   Complete versions keep the ledger simple, make every version
   self-contained and independently readable, and are the substrate
   external diffing needs. The fence follows the established
   `expectedRevision` protocol from the memory and table tools, including
   the conflict code that instructs a re-read. Rejected: in-place mutation
   (destroys history), and targeted-edit operations in V1 (non-goal 12).
5. **Diffs, when they come, are computed from stored versions — never
   trusted from the model.** Models sometimes rewrite wholesale and
   sometimes edit narrowly, and their own account of which is unreliable.
   Storing complete versions makes the model's editing style irrelevant to
   history. This is why non-goal 4 defers the diff *UI* while decision 2
   builds the diff *substrate* now.
6. **V1 is single-file; a collection is a later additive grouping.** One
   artifact, one file, one resource. A media-packet request yields several
   artifacts with several cards. Because each is an independent resource,
   a future collection object is an association over existing rows — no
   reshaping of V1 data. Rejected: a group object in V1 whose only
   occupancy would be groups of one, bought with real schema and UI cost.
7. **The card announces; the ledger owns history; the card opens current.**
   A card is an event in the shared transcript ("V3 was published here");
   the artifact's state lives in the ledger, and clicking any card opens
   the current version with history one click away. This replaces the
   earlier draft's card-opens-its-own-revision-plus-client-side-newer-
   detection, which scanning loaded transcript rows made honest but weak;
   an authoritative version list is strictly better and is what goal 4
   requires anyway.
8. **The pane is the existing rail slot, as a third `RailPanel` variant.**
   It inherits the shared frame, resize bounds, arbitration, theming, and
   accessibility behavior for free, and the contract's named right rail
   stays the product's one side surface. Rejected: a new wider reading
   surface (a visual-language contract conversation this feature does not
   need to open), and the attachment lightbox (full-window modality hides
   the conversation the artifact sits beside).
9. **The heuristic is standing policy, not client logic and not a
   classifier.** Policy ships with the server and retunes in one deploy;
   client heuristics would pin behavior to a release train, and a
   pre-classifier adds a model call and a latency step to every message
   for a decision the responding model can make in context. The addressing
   classifier remains the template if evidence later demands one (non-goal
   14).
10. **The length and structure signals are conjunctive, not independent.**
    The commissioning discussion listed length and structure as separate
    signals; this PRD deliberately requires both, because either alone
    over-triggers: a four-paragraph conversational explanation is not a
    document, and a two-paragraph note with one table is not one either.
    Explicit document-type requests and the burying-a-large-result case
    remain independent triggers, and the participant's explicit instruction
    beats everything. The conjunction is the first candidate for loosening
    if the false-negative signals say so — one policy deploy.
11. **`artifacts-enabled` is consulted server-side at run admission,
    bucketed by workspace — and the desktop deliberately never consults
    it.** The flag decides whether artifact writes and policy enter a run's
    frozen scope. This makes it the second deliberate exception, after
    `digests-enabled`, to the rule that managed product Booleans are
    presentation-only — gating on the server is what makes rollback total
    and skew-safe. Once the desktop's artifact branch ships, it renders
    cards, the rail listing, and the pane unconditionally: an artifact that
    exists is shared history, and hiding it behind a per-user flag push
    would let two participants briefly disagree about what the work stream
    contains, violating goal 7. The client receives `artifactsEnabled` like
    every managed flag and has no reader for it; that is intentional — do
    not add one. Bucketing is by `workspaceId` because artifacts are a
    multiplayer surface.
12. **V1 targets the current feed protocol and accepts the interim
    ordering, rather than depending on the ordered-turn transcript
    substrate.** The substrate PRD is a breaking cutover of the very
    protocol the card rides on, and taking it as a dependency would trade
    a Friday-sized slice for a rearchitecture's schedule. So V1 ships on
    today's feed — card first, combined narration after — and accepts that
    the card's message branch is rebuilt in that cutover. The implementing
    change must, in the same stroke, record the artifact card message as an
    in-scope participant entry kind in the ordered-turn PRD's decision log,
    so the cutover cannot strand it.
13. **The write operations reuse the retired wire name deliberately.** The
    natural name for the create operation is the retired
    `workstream_create_artifact`. Rows the retired tool wrote still exist
    in dogfood and development workspaces — the `AVALON_TOOL_PROSE` entry
    was retained precisely to keep wording them, and entries there outlive
    their tools by rule — so replacing that entry with the new semantics
    deliberately re-words those rows. That cost is accepted: Rally has no
    production users, the name is the one a model reaches for unprompted,
    and this decision knowingly supersedes the entry-outlives-its-tool
    rationale recorded in the agent harness document for this one entry.
14. **Excluded run origins stay excluded until their delivery paths learn
    artifacts.** Automation, inbound-email, and delegated child runs
    (non-goal 10) answer to consumers — digest email, `resultDelivery`,
    parent tool results — that would today deliver a stub instead of a
    document. The 2026-08-12 retirement is the standing evidence for
    treating "who reads this?" as a blocking question, not a follow-up.

## Data model

Tier labels per element: **[V1]** active on day one; **[dormant]** designed
now, written by nothing in V1; **[roadmap]** named for shape only, built
later. Sketch level throughout — the authoritative record is the migrations
and [`data-model.md`](../../data-model.md); deeper rationale in
[`design.md`](design.md).

**The artifact object [V1].** An artifact is a `resources` row in the
workspace authority, with Rally-generated provenance (a Rally provider
identity in the pattern Terminal's published files already use) and the
artifact's title, kind label, and MIME/type identity carried in the row's
existing columns. Its content lives where resource content lives — an R2
object per version in the existing per-region buckets — and the row's
current-content pointer always names the newest version's object, swapped
atomically as versions land, so every existing reader serves the current
version unversioned. (The precedent meeting notes set is the
authority-table-plus-materialized-resource shape, not the swap: notes
overwrite fixed keys in place, which is exactly what a versioned artifact
must not do.)

One inherited rail is modified rather than reused, and the change is named
here so it cannot be missed: today the resource update trigger enqueues the
*superseded* original into the deletion outbox whenever the content pointer
moves, and the sweeper deletes any enqueued object no resource row still
references. Left alone, that machinery would destroy every prior version's
object on every revision. For ledgered resources the swap-time enqueue is
suppressed — or the sweeper taught to keep objects the ledger references —
so prior versions survive; resource-delete-time cleanup then enumerates
version objects into the same outbox (see [`design.md`](design.md)).

**The version ledger [V1 table, partly dormant columns].** A new
append-only table beside the resource authority — one row per version:

- `resource_id`, `version_number` — identity; unique together, monotonic
  per artifact, starting at 1.
- content identity — the version's content object and hash; versions are
  immutable once written.
- `author_kind` — `agent` **[V1]**, `member` **[dormant]**, `connector`
  **[dormant]** — plus the matching author identity column (producing run
  for `agent`, user for `member`, connection for `connector`).
- `produced_by` provenance — the run and receipt identity that wrote it,
  which is also the idempotency key: a replayed write finds its receipt and
  returns the persisted version instead of inserting twice.
- `title` — versions may retitle; the resource row carries the current one.
- `created_at`.

The ledger is generic over resources on purpose: V1 writes it only for
artifacts, but nothing in its shape is artifact-specific, so a future that
versions re-fetched external snapshots or human uploads extends occupancy,
not schema. Whether V1 backfills a single version row for existing
non-artifact resources is implementation's call; the PRD requires only that
it need never happen twice.

**The work-stream link [V1].** The artifact is linked to its work stream
through the existing resource-link machinery with an artifact role label,
so the visibility predicate, the rail listing, the model's list tool, and
the compaction inventory all serve it as they serve every resource.
The label is a new `relationship_type` value, `'artifact'`. Nothing
constrains it: the live link table is object-local with an unconstrained
text column (the legacy D1 link table is already dropped) and contracts
type the field as a plain string, so the new value needs no migration and
no code change. The choice against reusing `'generated'` is
product-grounded — conversational artifacts stay distinguishable from
Terminal build outputs. Cross-work-stream
reference — the same artifact attached to a second work stream — exists by
construction in this machinery; V1 builds no surface that invokes it
**[dormant]**.

**The card message [V1].** The transcript card is a message row
(`message_type = 'artifact'`, a new value of the deliberately un-CHECKed
product vocabulary column; `kind = 'text'`, `role = 'assistant'`,
`author_type = 'agent'`, `visibility = 'people'`) whose
`structured_content_json` carries the typed payload: `artifactId` (the
resource id), `versionNumber`, `title`, `kindLabel`, and the event
(`created` | `revised`). The document content is **not** in the message —
it lives in the version ledger, and the pane fetches it. The row's text
content carries a one-line fallback ("Created the artifact 'Mute windows
PRD' (V1).") so an old or future client that cannot read the payload still
shows something true. The message never enters the model projection; the
model's knowledge of the artifact comes from its own operations and the
resource rails.

On the wire, `Message.messageType` gains `"artifact"` and
`structuredContent.artifact` carries the payload above. The desktop work is
three surfaces — the shared contracts `MessageSchema` enum, the wire-to-UI
message mapping, and the transcript block dispatch — plus the render-time
payload validation required in [the card section](#the-artifact-card), plus
the pane's version-addressed content fetch through the person-facing
resource-preview route the lightbox already uses (`GET
/resources/:id/preview`), widened with version addressing. Today an unknown
`messageType` is not dropped per-message: on the live socket the whole
frame is ignored, and a history page containing one fails the entire fetch
with the stale-build error. That is the pre-release desktop's behavior
toward artifact messages, and the rollout section owns the consequence.

**Write-path shape [V1].** The producing run's write operation settles
against the version ledger's authority with the compare-and-swap fence and
returns `{artifactId, versionNumber, title}`; the card message is appended
in the work stream on settle, deduplicated by the same receipt identity, so
a crash or replay between ledger commit and card append converges instead
of doubling. Reads need no new tools: the model lists and reads artifacts
through the existing attachment operations — carrying the version-number
output extension owned in [Agent behavior](#agent-behavior) — and V1 model
reads are always of the current version.

**Negative space, stated deliberately.** No regional D1 migration —
resource links are object-local (the legacy D1 link table is dropped), and
the artifact rides existing resource records. The dropped D1 `artifacts` table stays
dead and is not revived under any name. The always-empty
`WorkstreamContextSchema.artifacts` field stays empty and unrepurposed. The
owed R2 sweep from the 2026-08-12 retirement is untouched by and unrelated
to this change — new artifact content lives under resource keys, not the
retired `artifacts/` prefix. No collection object, no diff storage, no
subscription machinery, no export state.

## Regional impact

None beyond what the resource substrate already guarantees. Artifact rows,
version rows, and content objects live in the workspace's region — the
jurisdiction-locked workspace authority and that region's R2 bucket — and
never cross the boundary; no queue or workflow carries artifact content. As
with all model output, artifact-producing inference is archived in the
Global lakehouse only — EU inference is intentionally not archived, and
debugging an EU workspace's artifact generation stops at the regional
boundary with no Global fallback. Product analytics for artifact
interactions follow the same asymmetry.

## Security and trust model

The trust surface barely moves, and where it does, it reuses guarded paths:

- Artifact content is model-written Markdown rendered exclusively through
  the single `MarkdownBody` mount, inheriting the normalization pipeline,
  the never-navigable mention chips, and the renderer-isolation posture
  that already applies to every agent message and every Markdown
  attachment. No new renderer, no HTML, no iframe, no execution of any
  artifact content — V1 renders Markdown or nothing, and richer types
  arrive only with their own security PRD (non-goal 7).
- The pane's content fetch uses the authorized person-facing
  resource-preview route under the existing visibility predicate; version
  addressing widens the route's parameters, not its trust model. Knowing an `artifactId` or a version
  number grants nothing outside the caller's existing work-stream access.
- Copy uses the existing main-process clipboard bridge; no new IPC surface.
- Artifact write operations are authorized exactly as their siblings: the
  work stream and workspace come from the run's frozen, host-derived scope,
  never from model-chosen identifiers.
- `artifacts-enabled` is a rollout control, not protection: it gates
  whether the capability is offered, and nothing that protects data is
  scoped by it.

## Agent behavior

This section specifies V1's recommended protocol — typed artifact write
operations — at the level the tool standard requires. If the confirming
evaluation ([Open questions](#open-questions)) overturns the
recommendation, this section is revised by a decision-log entry before
implementation, and the ledger contract above is what stays fixed.

The `rally:workstream` plugin (default-loaded; wire prefix `workstream_`)
gains two write tools, registered only when the run's admission resolved
`artifacts-enabled` for the workspace and the run's origin is an ordinary
participant-triggered work-stream run (non-goal 10). Registration state is
frozen into the run scope like every other authority. The system prompt
carries the artifact policy only when the tools are registered, so the
model is never told about tools it cannot call. Reads ride the existing
attachment operations — `workstream_list_resources` and
`workstream_read_resource` serve artifacts because artifacts are resources
— so the family adds no read tools and no second discovery rail. Making
that sufficient takes one owned contract extension, named here rather than
widened silently: for versioned resources, list items and read outputs
gain the current ledger version number, as a new field named apart from
the read output's existing `version` (which is derivative content
identity, not a ledger number). That is a deliberate change to the shared
attachment contracts, carried by this PRD.

| Canonical (wire) name | Capability | Mode | Idempotency | Purpose |
| --- | --- | --- | --- | --- |
| `create_artifact` (`workstream_create_artifact`) | `artifact.write` | write | replayed from the tool receipt; the server allocates the artifact identity once under the receipt, so a replay returns the persisted identity and version | Publish a new artifact at version 1. |
| `revise_artifact` (`workstream_revise_artifact`) | `artifact.write` | write | replayed from the tool receipt; a version commits at most once per receipt | Publish the next version of an existing artifact. |

Execution mechanics: both tools are internal-authority calls — no provider
I/O — and carry the same timeout class as the sibling internal tools, with
exact milliseconds transcribed from those siblings at implementation.
Neither requires `serial` execution: writes already run sequentially under
the harness contract, and a revise needs an `artifactId` only a settled
call returns. Cancellation and timeout of an in-flight write resolve
cleanly because the version write is transactional at its authority and
receipt-keyed: the version and its receipt either both committed — the
artifact exists, a replay returns it — or neither did, and the call reports
the standard failure. There is no ambiguous-write state to represent.

Wire shapes, concisely (all inputs `additionalProperties: false`, enforced
by a strict parse; exact schemas land in contracts with the
implementation):

- `create_artifact` input: `title` (required), `kindLabel` (required, a
  short human label), `content` (required, GFM Markdown). Output:
  `artifactId`, `versionNumber: 1`, `title`, `createdAt`.
- `revise_artifact` input: `artifactId` (required), `expectedVersion`
  (required — "pass exactly the ledger version number returned by
  `workstream_create_artifact`, your last revision, or
  `workstream_read_resource`", per the read-rail extension above),
  `content` (required, the complete replacement), `title` (optional
  retitle). Output: `artifactId`, `versionNumber` (the new number).

Failure contract — stable codes with the model-visible sentence carrying
the next action, structured detail only from the existing allowlist:

| Code | Model-visible error sentence |
| --- | --- |
| `artifact_not_found` | "No artifact with that id exists in this work stream. Call `workstream_list_resources` to see what exists." |
| `artifact_version_conflict` | "The artifact changed after it was read. Call `workstream_read_resource` for the current content and version, rebuild the revision, and retry with the current version." |
| `artifact_content_too_large` | "The document is too large for one artifact. Shorten it, or split it into more than one artifact." |
| validation failures | The shared strict-parse vocabulary: unknown keys named, missing fields named, no submitted values echoed. |

`artifact_content_too_large` enforces the *existing* resource and message
content bounds in the executor before any write, so oversized content
surfaces as a typed, recoverable failure and never as a raw storage
constraint error; contract tests cover content exactly at and just over
the bound. No new number is introduced (non-goal 15).

Sequencing and discovery: a create is self-sufficient; a revise needs an
`artifactId` and `expectedVersion`, which come from this family's own
outputs or from the resource read rail; after compaction the recovery path
is list → read → revise, and the compaction-surviving resource inventory
is what makes the artifact discoverable at all. The obvious wrong first
call — revising by title, or with a stale version — fails into a sentence
that names the correcting call. Both tools return everything a follow-up
call needs; neither returns a URL, because an artifact's address is its
work stream (deep links are a later slice).

Transcript presentation: each tool gets active-voice per-lifecycle prose
in the tool-activity map ("Drafting …", "Revising …"), satisfying the
prose test that rejects generic or passive rows. The retired
`workstream_create_artifact` prose entry is replaced, per key design
decision 13.

Model-usability acceptance, per the tool-design standard: the new schemas
are reachable by the schema-sanitization walk and named in it; contract
tests cover required, optional, forbidden, success, and failure shapes;
and prompt evaluations on a small fallback-stage model from the
work-stream route plan — the tool standard's design target is a small open
model succeeding from the schema alone — must show a document request
producing one create
with brief narration, a conversational question producing no artifact
call, a revision request reusing the id and version correctly, a
post-compaction revision recovered through list → read → revise, recovery
from `artifact_version_conflict` and from a wrong first call without
looping, and obedience to both explicit participant overrides.

## Rollout

1. The flag: `artifacts-enabled`, a managed product Boolean served as
   `artifactsEnabled` — fail-closed, default variation off, created
   together with its initial targeting rule (staff via the approved
   `userEmailDomain`-family attributes, then dogfooding workspaces),
   edited through Ace, added to Ace's ensured flag set, delivered per-user
   over the WorkspaceDO flag push with up-to-30-second propagation. Per
   key design decision 11 it is additionally consulted at run admission,
   and rollout cohorts bucket by `workspaceId`.
2. Ordering: (a) API deploy — schema, write operations, prompt policy, and
   wire type ship dormant behind the flag, off everywhere; (b) desktop
   release with the card, pane, version list, and schema branches;
   (c) flag on for staff workspaces; (d) widen cohorts as dogfooding
   holds. The order means no server emits an artifact card before a
   desktop that renders them is *released* — but a released build is not
   an installed one. A participant still running the prior build in a
   flag-on workspace hits today's unknown-shape behavior: socket frames
   carrying an artifact card are ignored and a history page containing one
   fails with the stale-build restart error (see
   [Data model](#data-model)). For staff dogfooding cohorts that gap is
   accepted and hereby named; before cohorts widen beyond staff, the
   question of requiring a minimum desktop version for flag-on workspaces
   is settled, not inherited.
3. Rollback is the flag: off stops registration for new runs immediately.
   Existing artifacts and cards remain — they are ordinary durable
   resources and messages, nothing is deleted or migrated by turning the
   feature off, and the desktop never consults the flag (key design
   decision 11), so nothing already visible disappears.
4. The prompt-policy addition lands inside the existing work-stream prompt
   version discipline; whether it warrants a `WORKSTREAM_PROMPT_VERSION`
   bump is settled at implementation against the in-flight-run cost that
   decision carries.
5. The compaction summary prompt gains its retain-artifact-identity
   instruction (ids, titles, current versions — the way it already retains
   exact resource ids) in the same change, with its golden hash updated
   deliberately.

### Instrumentation for tuning

The heuristic and the protocol are tunable only if their behavior is
visible. V1 ships with the following measures, each added through the
standard instrumented-event procedure; they are tuning inputs, and no
numeric target is invented for any of them (non-goal 15):

- **Creation-side (server):** artifact created / artifact revised, with
  workspace, work stream, run identity, and version number — the base
  rates for artifacts per work stream and revisions per artifact.
- **Reception-side (desktop product-intent):** card opened, version list
  opened, prior version opened, copy — the signals that artifacts are
  read and used rather than ignored. An artifact with one version and no
  opens is the false-positive fingerprint.
- **Override signals:** the two explicit instructions — "make that an
  artifact" after an inline answer (false-negative fingerprint) and "just
  answer in chat" after a card (false-positive fingerprint) — are the
  highest-value tuning inputs. V1 measures them by dogfooding review
  through the Global inference lakehouse rather than by building a
  classifier for them; if review shows they are common, instrumenting
  them properly becomes the first tuning investment.
- **Quality review:** the Global lakehouse's archived inference is the
  qualitative loop — read what the model was asked, what it produced, and
  whether the artifact decision was right. EU workspaces are invisible to
  this loop by design; tuning evidence is Global-only, and no EU fallback
  is built or queried.

## Acceptance

1. In a flag-on workspace, "draft a PRD for <topic>" in a work stream
   yields: a tool-activity row, an artifact card titled accordingly, and a
   short conversational message — with the document never rendered inline
   in the feed.
2. Clicking the card opens the right-rail pane on the current version:
   header immediately, body after a brief loading state; headings, tables,
   and code blocks render through the shared renderer; text is selectable;
   **Copy** yields the viewed version's stored Markdown.
3. "Tighten the goals section" then yields a **Revised** card with **V2**;
   an open pane advances to V2; the version list shows V1 and V2 with
   author and time; selecting V1 shows it read-only, labeled **Viewing V1
   of 2 — show current**.
4. The artifact appears in the right rail's resource list under the same
   visibility as its work stream's other resources, and opens the same
   pane from there.
5. A short factual question in the same work stream produces an inline
   answer and no artifact. "Just answer in chat" defeats the heuristic for
   a document-shaped ask; "make that an artifact" creates one from a short
   answer.
6. A second participant sees the same cards live, opens the same versions,
   and sees revision cards appear as they are published.
7. In a flag-off workspace no artifact write is registered, no policy text
   is rendered into the prompt, and no artifact card is ever emitted.
8. Post-compaction, a revision request succeeds via list → read → revise —
   with the compaction summary shown to retain artifact ids, titles, and
   versions — and a deliberately stale `expectedVersion` yields the
   conflict sentence and a successful model recovery.
9. Content at the existing bound commits; content over it yields
   `artifact_content_too_large`, never a raw constraint error; and a test
   proves an interrupted create or revise leaves either both the version
   and its settled receipt or neither, with a replay returning the
   persisted version rather than inserting a second.
10. The pane behaves within the rail contract: hand-off from the inspector
    and HyperSight panels, resize within the shared bounds, scrim at
    narrow widths, Escape restores focus. The pane's fetch-failure state
    shows retry, and offline behavior matches
    [the pane section](#the-document-pane).
11. Every new surface is captured from the running desktop client under
    Xvfb and the images read, per the visible-change rule; `pnpm lint`
    (zero warnings), `pnpm typecheck`, and `pnpm test` pass; prompt golden
    hashes are updated deliberately; and each new test is shown to fail
    when the behavior it protects is broken.

## Open questions

The commissioning discussion posed nine questions. Five are answered in
this PRD's decisions — artifact/resource unification (key design decision
1), single-file V1 with additive collections (decision 6), the minimum
card (the card section), revision status presentation (the card and pane
sections), and the V1 version UI (the pane's version list) — and those
answers stand unless review overturns them. Four remain genuinely open;
each names its options and what the answer changes, and the first three
name their experiments.

1. **The exact heuristic mix** — which combination of intent, length,
   structure, and disruption should trigger an artifact. Options: the V1
   policy as written (explicit types independent; length ∧ structure
   conjunctive; burying-case independent); a looser disjunctive form; a
   stricter explicit-only form. Experiment: run the policy against a fixed
   set of dogfooding-derived prompts spanning the false-positive and
   false-negative cases named in [the heuristic](#the-creation-heuristic),
   on a small fallback-stage model from the work-stream route plan, before
   flag-on; then retune
   from the instrumentation's override and never-opened signals. Changes:
   prompt wording only — this question never blocks the build, which is
   the point of making it policy.
2. **Proactive creation** — may the model create an artifact nobody
   explicitly asked for? Recommendation: yes, under the heuristic — the
   anticipated-length and burying-a-large-result signals *are* proactive
   creation, and the postamble plus the "just answer in chat" override
   keep the participant in charge. The alternative — explicit-request-only
   — eliminates false positives at the cost of most of the feature's
   value. Experiment: dogfood with proactive creation on; if the
   false-positive fingerprints dominate the instrumentation, tighten
   toward explicit-only in policy. Changes: one policy deploy.
3. **The generation protocol's final confirmation** — typed tools
   (recommended) versus the Terminal file workflow for V1. The framework
   and the reasoning are in [`design.md`](design.md); the confirming
   experiment is specified there: the candidate protocols run head-to-head
   on a small fallback-stage model from the work-stream route plan across
   create, revise, post-compaction revise, and multi-document tasks,
   scored on success
   rate, loops, latency, and narration discipline. The outcome lands in
   the decision log before implementation hardens. Changes: the Agent
   behavior section's mechanism and the write-path shape — and nothing
   else, which is what decision 3's abstraction is for.
4. **The user-facing noun** — whether cards and the pane say "artifact",
   "document", or only the kind label. A copy decision to settle against
   real screenshots during implementation; changes UI strings only.
