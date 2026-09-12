# Importing public ChatGPT and Claude sessions into a work stream

> Created 2026-09-12.
>
> A participant pastes the link to a publicly shared ChatGPT or Claude
> conversation and it lands in the work stream as ordinary transcript turns,
> attributed to the people and the assistant who said them, with Rally treating
> it as history rather than as something to answer. Companions:
> [state.md](state.md), [research.md](research.md) — what the two share pages
> actually serve, verified on 2026-09-12, and what could not be verified from
> the sandbox. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Builds on the seeding path from
> [the demo-workspace PRD](../2026-09-04_demo-workspace/prd.md), owned today by
> [`demo-workspaces.md`](../../demo-workspaces.md).

## Summary

A participant who did some of a work stream's thinking in ChatGPT or Claude
before bringing it to Rally can bring that conversation with them. Beside the
work-stream header's overflow menu sits an **Import** control — a box with an
arrow pointing down into it. It takes the link to a shared conversation, shows
what it found and who it thinks was talking, and, once the participant
confirms, writes the conversation into the transcript as if it had happened in
the room: the owner's messages as their own turns when they are a member, or as
a named guest when they are not; the assistant's replies as turns by **ChatGPT**
or **Claude**, each carrying the provider's mark. Rally does not reply to any of
it and the addressing classifier never runs — the same statement-of-intent
mechanism the demo seeder uses, generalized from "a script says whether Rally
answers" to "an import says nobody is asking".

The imported conversation is one collapsible block in the transcript, headed by
a line saying who imported what from where, and one **artifact** in the
contextual rail: a Markdown rendering of the whole conversation, with any images
the shared page shows attached to the turns they belonged to. From the next turn
on, Rally can be asked about it like anything else said in the room; after a
compaction the artifact is still there for the resource tools. Reasoning, tool
calls, and hidden system messages are not imported; what a reader of the shared
page sees is what arrives.

## Motivation

People start work in whichever assistant is open. By the time a question
becomes a work stream, the framing, the false starts, and the assistant's best
draft already exist somewhere else, and today the only ways to bring them in are
to paste the text as one enormous message (attributed to the paster, with the
assistant's words in their mouth) or to attach the share link and hope somebody
follows it. Neither makes the conversation *part of the room*: the transcript
cannot show who said what, Rally cannot treat it as history rather than as a
request, and the rail cannot list it as something the room is built on.

The request that produced this PRD came with two live examples — a shared
ChatGPT conversation that produced an infographic through several rounds of
"try again, higher abstraction", and a public Claude Code session — and a
product framing worth keeping exactly: the conversation should be imported "as
if it had already happened", with the assistant "responding as an actual
workstream user", and the whole sequence collapsible "as one component" that is
also an artifact. The cost of not doing it is the current workaround's cost,
paid every time: a work stream that opens with a wall of pasted text nobody can
attribute, and an agent that reads a colleague's pasted ChatGPT reply as
something the colleague asked.

The mechanism is close at hand, which is why now. The demo-workspace work landed
a way to write human and assistant turns through Rally's production writers
without a live classifier, by stating the addressing outcome on the message
([`demo-workspaces.md`](../../demo-workspaces.md#seeding-a-demo-from-a-pack));
the transcript already draws turns by an external actor with a display name
and no user row (Slack members, inbound email); and the repository already
fetches public pages two different ways. What is new is small and named below.

## Goals

1. A participant pastes a public ChatGPT share link or a public Claude link
   and the conversation appears in the transcript as ordinary turns, in the
   order the shared page shows them, without Rally answering, the classifier
   running, or anyone being notified per turn.
2. Every turn is attributed truthfully. The source's owner is matched to a
   workspace member only with the importer's confirmation, and otherwise
   appears under their own name as a guest; the assistant appears as ChatGPT or
   Claude with the provider's mark, never as Rally and never as a member.
3. The import is one thing in the room and one thing in the rail: a collapsible
   block in the transcript and an artifact in the contextual rail, each linking
   to the other, so a reader can fold a fifty-message import to a line and a
   colleague can open the whole conversation as a document.
4. Rally treats the imported conversation as history. The next turn that asks
   about it is answered from the transcript with no tool call, and after a
   compaction the artifact remains readable through the existing resource tools.
5. Images the shared page shows arrive as attachments on the turn they belonged
   to, through the same upload and verification path as a composer attachment;
   anything the page names but does not serve is marked in place rather than
   dropped silently.
6. Failure is specific and never partial. A link that is private, expired,
   unsupported, or behind a challenge the fetcher cannot pass names its reason in
   the dialog; a conversation is written whole or not at all.

## Non-goals

1. **Reasoning, tool calls, hidden system messages, and citations — not
   imported.** The request says so; a reader of the shared page does not see
   them either. A later PRD could fold a "worked for a while" receipt in the
   shape of the work accordion; nothing here forecloses it. Deferred.
2. **Private or authenticated sessions — out of scope.** No OAuth to OpenAI or
   Anthropic, no cookies, no account export archives. The share link is the only
   ingress, and "public" means "anyone holding the link can read it", which is
   exactly the condition under which copying it into a workspace needs no
   further consent. An export-archive import is a different, offline product
   and a different PRD. Deferred.
3. **Backdating — rejected.** Imported turns are stamped with the real clock,
   for the reasons [the demo-workspace PRD's non-goal
   1](../2026-09-04_demo-workspace/prd.md#non-goals) already records: a supplied
   historical time touches scheduling, lease, and security behavior across
   roughly twenty harness timestamp sites. The original instants are kept on
   each turn and shown in the block; they are not the transcript's clock.
4. **Rally answering imported turns — never.** The point of the feature is that
   an imported "please make it higher-level" is history, not a request. Rally
   answers the next thing a participant says, which may well be "what do you
   think of the last draft in there?".
5. **Live sync and delta import — deferred.** A ChatGPT share is a snapshot
   fixed at share time; a Claude Code session can keep going. Re-importing a
   changed link appends the whole conversation again as a new block and a new
   version of the artifact; importing only what is new needs a diff and its own
   design.
6. **Starting a new work stream from a link — deferred.** The first version
   imports into an existing conversation. Creating a work stream *from* a shared
   conversation would make the link its origin, which
   [`workstream-origin-attachments.md`](../../workstream-origin-attachments.md)
   defines as written once at creation by the connector that knows the place; a
   second PRD can add that entry point on top of this one's writer.
7. **Other providers — deferred.** Gemini, Grok, Perplexity, and the rest have
   share pages too. The source adapter registry below is where they go; none is
   built now.
8. **Removing an import — deferred, and named so nobody assumes it.** Canonical
   turns are immutable, so an import cannot be undone by deleting rows. What is
   possible today is detaching the artifact from the rail. A retraction
   mechanism for a whole block is its own change; until it exists the
   confirmation step is the safeguard, and the dialog says so.
9. **Guest accounts — rejected.** A guest is a label on turns, not an identity.
   A guest cannot be mentioned, notified, invited from the block, or sign in;
   the data model's rule that a participant is a workspace member — the
   participants table is keyed on a member's user id — does not move.
10. **Editing imported turns, or attributing individual turns differently
    after the fact — rejected.** Attribution is decided once, in the
    confirmation step, for the whole conversation.

## Product behavior

### The import control

The work-stream header's action row gains an **Import** icon button — the
`Import` glyph from `lucide-react`, an open-topped box with an arrow pointing
down into it — placed immediately before the overflow menu's ellipsis, with the
tooltip *Import a shared conversation*. It is the row's first dedicated action
icon (sharing is an item in that overflow menu today, *Copy work-stream link*,
not an icon), so the same item is also offered inside the overflow menu as
*Import a shared conversation…*: the row hides its icons at narrow widths, and
the menu is what remains. Both open the same dialog. A substream shows the
control in its own header and imports into the substream.

The control is shown to any workspace member who can open the conversation.
Importing is posting: an importer who was not yet a participant becomes one
with reason `message`, exactly as sending a message would make them. The flag
in **Rollout** hides the icon and the menu item for anyone it is not on for.

### Reading the link

The dialog opens on one field, *Paste a link to a shared conversation*, with
a line naming what is accepted: a ChatGPT share link (`chatgpt.com/share/…`), a
Claude share link (`claude.ai/share/…`), or a public Claude Code session
(`claude.ai/code/session_…`). Anything else is refused in place, before any
request is made, with *Rally can import shared ChatGPT and Claude conversations.
This link is not one.*

Submitting starts a **preview**. The dialog reads *Reading the shared
conversation…* with a cancel control; closing the dialog cancels a preview that
has not been confirmed. The regional Worker fetches the page through the fetcher
in **Key design decisions**, parses it with the provider's source adapter, stores
the result against the import, and the dialog shows what it found:

| The dialog shows | From |
| --- | --- |
| The provider's mark and the conversation's title | The page's own title |
| Who the page says owns it, or *the page does not name its owner* | Claude Code sessions name the owner; a ChatGPT share is anonymous unless the sharer opted in |
| The count of messages on each side, the date of the first and last, and the model where the page names one | The parsed conversation |
| How many images will come in, and how many files the page names but does not serve | The parsed attachments |
| Where it will land: this work stream, or the substream the dialog was opened from | The importer's position |

Nothing is written to the room by a preview. A preview the importer neither
confirms nor cancels is abandoned by the importer's next action on the dialog or
by the open retention limit below.

### Deciding who spoke

The preview proposes a speaker for the owner's side and the importer confirms
it. The proposal, in order:

1. **A participant of this conversation whose display name matches** the owner
   name the page carries — matched on the folded name, and only when exactly
   one participant matches. Rally already treats a folded display name as the
   key a mention resolves through, and refuses a demo cast whose names collide
   for the same reason, so a unique match is a real signal; two matches are no
   signal, and produce no proposal.
2. **The importer**, offered as *these are my messages*, which is the common
   case for a conversation someone brings into their own work stream.
3. **A guest with the owner's name** — *Morgan (guest)* — or, when the page
   carries no name, a guest named by the importer, defaulting to *Guest*.

The importer can choose any workspace member from the picker instead. Choosing a
member who is not yet a participant adds them as one, by the importer, exactly
as the facepile's add-participant control would, and the dialog says so before
confirmation: *Priya will be added to this work stream.* They receive the usual
participant notification and nothing more.

Rally never attributes words to a member on a name match alone: the confirmation
is the importer's assertion, and it is recorded as one — the block header names
the importer, and every imported turn carries the import's provenance. A member
reading "their" imported turn later can see exactly who imported it and from
where.

The assistant's side is never a choice. It is **ChatGPT** for a ChatGPT
conversation and **Claude** for a Claude one, drawn with the provider's mark in
the byline where a person's turn carries the accent dot.

### What lands in the transcript

Confirming writes the conversation to the room as one contiguous run of
canonical turns, appended at the end of the transcript at the moment of
confirmation, in one transaction: either the whole block is there or none of it
is, and no live message from another participant can land in the middle of it.

The run opens with a system turn — *Alex imported a ChatGPT conversation:
Create Work Graph Infographic* — which is what the sidebar preview, the activity
feed, and a collapsed block show. That turn is the import's one unit of
attention: other participants see one unread item, not fifty. The imported
turns themselves advance nobody's unread count, create no mention records
(an `@name` inside imported text stays text), and notify nobody.

Each imported turn is then an ordinary turn of one of three shapes:

| The source said | The room shows | Written as |
| --- | --- | --- |
| The owner, matched to a member | The member's own turn, with their name and accent dot, in their own bubble | A human turn by that member, exactly as if they had sent it |
| The owner, as a guest | *Morgan (guest)* with a plain accent dot | An external-actor turn: provider `chatgpt` or `claude`, display name as confirmed |
| The assistant | *ChatGPT* or *Claude*, with the provider's mark in place of the dot | An external-actor turn: provider `chatgpt` or `claude`, display name *ChatGPT* or *Claude*, the model name the page gave in the turn's provenance |

Every imported turn's byline carries the context label *imported*, and its
hover reveals the original instant the page recorded for it — *said Sep 4,
2026 at 3:36 PM* — beside the real time it was written to the room. The
transcript's own clock is the latter.

Text is rendered as Markdown through the same renderer as any turn. A source
message longer than the message limit (`MESSAGE_MAX_CHARACTERS`, an existing
number) is split at a paragraph boundary into consecutive turns by the same
speaker, each carrying its part number in its provenance; no new size is chosen
here. Consecutive segments the page shows as one reply — the assistant's text
followed by the image it produced — fold into one turn.

An image the page shows is an attachment on the turn it belonged to, through the
same tile, lightbox, and model-readable derivative as a composer attachment. A
file the page names but does not serve (a user's upload on a ChatGPT share shows
only its name) is a single line in the turn — *Attachment not available from the
shared page: brief.pdf* — never a silent gap.

**The block.** The client draws the contiguous run as one **imported
conversation block**: a header row carrying the provider's mark, the title, the
message count, the original date range, the owner label as confirmed, a link to
the source page, and a chip for the artifact; below it, the turns. The header's
chevron folds the whole run to that one row, the same chevron and quarter-turn
the work accordion and the markdown headings already use, so a reader learns
nothing new. The block arrives expanded, each reader's fold is their own and is
remembered for the session, and a folded block still anchors the system turn so
a link to it lands where it should. The block is derived on the client from the
run's shared import id, the way the work accordion is derived from a run's rows;
the server writes turns, not layout.

### The artifact

The same confirmation creates one resource: a Markdown document titled after
the conversation, whose body opens with where it came from (provider, source
link, owner as confirmed, original dates, who imported it and when) and then
carries the whole conversation with a heading per speaker turn and each
attachment cited by its resource link, so the citation renderer draws it inline.
Its canonical URL is the share link. It is attached to the conversation as an
**artifact** — the `generated` relationship, authored by the importer — so it
appears in the rail's artifact list with the provider's mark, opens in the
document viewer, and is listed to the agent by `workstream_list_resources` like
any other resource. The block's header chip opens it; the artifact card's
*Show in transcript* jumps to the block.

Re-importing a link whose content has changed since produces a new block and a
new version of the same artifact (cause `refetched`); re-importing a link whose
content is unchanged is refused in the dialog with a link to the existing block.

### What Rally does with it

Nothing, until asked. Imported turns reach the model as history said to the
room, never as requests and never as Rally's own words: each projects as a
`user`-role message under the existing *said to the room, not to Rally* framing,
attributed on its first line — *ChatGPT, in a ChatGPT conversation imported by
Alex* or *Morgan (guest), in a Claude conversation imported by Alex* — with no
trust label, per the 2026-09-11 decision in
[`security.md`](../../security.md#changelog) that role placement rather than
labelling is the control. The next message that addresses Rally can refer to the
conversation ("take the third draft in Morgan's ChatGPT thread and make it a
memo") and be answered from context.

After a compaction the turns are summarized like everything else; the artifact
survives in the resource inventory and Rally reads it with the resource tools
when a task needs the verbatim text.

### Failure, offline, and repeats

| State | The dialog | The room |
| --- | --- | --- |
| Unsupported link | Refused before any request, with what is supported | Untouched |
| Page not public, expired, or gone | *This conversation is not publicly shared, or the link has expired.* | Untouched |
| The fetcher was challenged and could not pass | *Rally could not read this page. Claude pages sometimes require a browser check Rally cannot complete; try again later.* — with the import id for support | Untouched |
| The page changed shape and the adapter could not parse it | *Rally could not read this conversation's format* — with the import id; the fetched page is retained for diagnosis | Untouched |
| Confirmed, then the write failed | *The import did not complete. Nothing was added.* with retry | Untouched — the write is one transaction |
| Offline during a preview | The last known phase, labelled stale; reconnecting resumes it | Untouched |
| Offline after confirming | The block arrives with the feed when the socket returns, like any turn | Written; the importer sees it on reconnect |
| Same link, same content, same conversation | Refused, linking to the existing block | Untouched |

An import is a durable operation with an id; repeating a confirmation returns
its existing progress and result rather than a second block. There is no
estimated time and no fabricated progress bar; the phase is the progress.

## Impact on the product contract

None of the clauses move. A work stream is still the unit of work, viewing still
does not imply participation, a participant is still a workspace member, there
are no channels, no inbox, and no global search. What this PRD adds within the
contract is one thing worth stating: **a transcript may contain turns that were
said somewhere else, before the work stream existed, and such a turn is always
marked as imported and attributed to who said it, with the assistant of another
product shown as itself and never as Rally.** A guest is a label on those turns
and not a new kind of participant; the agent gains no new capability and loses
none.

## Decision log

None yet.

## Key design decisions

1. **One fetcher primitive, Firecrawl first; Browser Run recorded as the
   in-region fallback; Daytona rejected.** Fetching a public page is its own
   primitive with one job — a URL in, the page's HTML and final URL out — and the
   first implementation is the existing Firecrawl client
   ([`apps/api/src/lib/firecrawl.ts`](../../../apps/api/src/lib/firecrawl.ts))
   asking for `rawHtml` and, for the rendered image URLs, `html`, one option
   away from what the `rally:web` plugin already sends. Firecrawl is already a
   regional dependency in both regions, already handles retry, `Retry-After`,
   and provider errors, and advertises stealth proxies for pages behind a bot
   challenge — which, [research.md](research.md#2-claude-pages) shows, every
   Claude URL is. Cloudflare Browser Run is also already bound in both regions
   (link capture in [`text-search.md`](../../text-search.md)) and keeps the
   bytes on Cloudflare, so it is the fallback if Firecrawl cannot pass the
   challenge or the team prefers no third party for this path; the primitive's
   interface is what makes that a one-file swap. Daytona computer use is
   rejected: the Terminal snapshot has no browser, both regions run on the `us`
   fleet, and acquiring a sandbox to perform one HTTP fetch is the heaviest
   possible shape for the lightest possible job.
2. **Parse the data, not the pixels.** A ChatGPT share page carries the whole
   conversation as a React Router data stream inside the HTML, and decoding it
   gives roles, hidden-message flags, exchange grouping, model names, instants,
   and image pointers exactly
   ([research.md §1](research.md#1-chatgpt-share-pages-httpschatgptcomshareuuid)).
   Extracting from Firecrawl's markdown loses the role boundary; asking an LLM
   to extract (Firecrawl's `json` format, Browser Run's `json` action) is lossy
   and unverifiable, and would put a model between a colleague's words and their
   attribution. Each provider's adapter is deterministic and unit-tested against
   a captured page; a page whose shape changes fails loudly as a parse error,
   which is the failure a reader will notice.
3. **Imported turns are canonical conversation turns written by the room
   object, in one transaction, with no run and no classifier — the `seed`
   precedent, generalized.** The demo seeder's `seed` field on the room's
   internal create-message input states the addressing outcome and skips
   `classifyWorkstreamMessage`; an import states the same thing — nobody is
   asking — for a whole batch. The room gains one internal-only operation that
   writes the system turn and every imported turn through
   `prepareParticipantMessage` and `commitWithRegionalEffects`, the way an
   external elicitation answer that is not the final one is written today as an
   immediate canonical turn with no loop input. It is unreachable from the
   public route schema, exactly as `seed` is. The alternative — one
   `createMessage` per turn through the seed path — was rejected because it
   cannot make the block contiguous or atomic, and because it would write the
   assistant's replies as *Rally's* turns.
4. **The provider is an external actor, not Rally and not a participant.** A
   Rally assistant turn requires a run (`finalizePreparedAssistantTurn` insists
   on the run that produced it), and rendering ChatGPT's words as Rally's would
   be false in the room and in the model's context. The transcript already has
   the right shape: `actor: "external"` with an `ExternalActorSchema` display
   name and provider, used by Slack and inbound email. The provider value is
   `chatgpt` or `claude`; the byline label and the mark derive from it through a
   small registry, replacing the literal `· Slack` suffix the renderer carries
   today. A guest owner uses the same shape with their confirmed name.
5. **Matched members are human turns, and only after the importer confirms.**
   A unique folded-name match among participants is a proposal, never a
   decision, because a name is a weak key and the cost of a wrong attribution is
   a colleague's words in the wrong mouth. The confirmation is recorded as the
   importer's assertion in the block header and in each turn's provenance.
6. **Real clock, original instants preserved.** Per non-goal 3. Each turn's
   provenance carries the instant the page recorded; the byline shows it on
   hover and the block header shows the range. The transcript's order and clock
   are the room's.
7. **The artifact is a Markdown resource with the `generated` relationship,
   authored by the importer.** The user-facing word is *artifact*, and in the
   data model an artifact is the `generated` direction on a resource
   ([`data-model.md`](../../data-model.md)). An `origin` relationship was
   considered and rejected: origin is written once at creation by the connector
   that knows the place, and a conversation can receive many imports at any
   time. Images are per-turn attachments through `ResourceService.upload` and
   `participant_transcript_attachments`, so nothing about how the room, the
   lightbox, or the attachment tools treat them is new.
8. **The block is client-derived, headed by a real system turn.** The work
   accordion already folds a contiguous run of rows behind a chevron with
   per-reader disclosure; the imported-conversation block is the same
   derivation keyed on the import id in each turn's provenance. A server-side
   grouping row was rejected: layout is the client's, and the system turn
   already gives the block a durable anchor, a sidebar preview, and its one unit
   of attention.
9. **Imported words reach the model as user-role history, attributed, and
   unlabelled.** Never `assistant` role — Rally did not say them, and a model
   that believes it did continues in ChatGPT's voice and defends ChatGPT's
   claims. The existing *said to the room, not to Rally* framing plus a
   one-line attribution is the whole treatment; no `UNTRUSTED` header is
   reintroduced, per the security changelog of 2026-09-11.
10. **The operation is rows plus a Workflow that only points at them.** Preview
    and commit are phases of one durable import row, driven the way demo
    preparation is driven: every phase idempotent, the row written by the phase,
    the client reading the row. A synchronous request was rejected because a
    fetch with a stealth proxy and a page of images runs for tens of seconds and
    a dropped connection must not lose a confirmed import.
11. **Idempotency by identity, not by checks.** An import is identified by
    conversation, canonical source URL, and content hash; every imported turn's
    client message id is derived from the import id and the source turn id, so
    the room's own dedupe on `client_message_id` makes a replayed write a no-op,
    as the demo seeder's derived ids do.
12. **Every new limit ships open.** Page size, turn count, attachment bytes per
    import, preview retention, job deadline, imports per workspace per day —
    each is defined once, set to the open value with the `LIMIT UNSET` marker,
    and handed to the team with the arithmetic, per
    [`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).
    The two numbers this feature reuses are existing ones: `MESSAGE_MAX_CHARACTERS`
    for splitting and `MAX_ATTACHMENT_BYTES` for each image. The host allowlist
    is not a quantity and needs no number.

## Data model

Sketch level; the migration and [`data-model.md`](../../data-model.md) are the
record.

- **`conversation_imports`** (D1, per region): `import_id`, `workspace_id`,
  `workstream_id`, `substream_id`, `importer_user_id`, `provider`,
  `source_url` (canonical), `source_id`, `phase` (`fetching`, `parsing`,
  `awaiting_confirmation`, `writing`, `ready`, `failed`, `abandoned`),
  `attempt`, `content_sha256`, `owner_label` (as the page gave it, nullable),
  `speaker_json` (the confirmed mapping), `resource_id`, `system_turn_id`,
  `first_turn_id`, `last_turn_id`, `turn_count`, `failure_code`, `created_at`,
  `confirmed_at`, `ready_at`. One row per import; `phase` and `attempt` are
  written by the phase that owns them.
- **The fetched page and the parsed conversation** live in the regional
  `PAYLOADS` bucket under the import id until the import is `ready` (then the
  artifact is the durable copy and the page goes through the existing deletion
  outbox) or `failed` at parsing (then the page is kept for diagnosis, subject
  to the open retention limit).
- **Turn provenance**: each imported turn's structured content carries an
  `import` object — `importId`, `sourceTurnId`, `sourceCreatedAt`, `speaker`
  (`member`, `guest`, or `assistant`), `model` where known, `part`/`of` when
  split — which is what the client derives the block from and what the model
  projection attributes from. External-actor turns carry the provider in
  `external_actor_json` as today.
- **Resources**: one `markdown` resource per import (versioned on re-import,
  cause `refetched`), linked with `relationship_type = 'generated'`; one
  resource per imported image, linked as `message_attachment` to its exact
  turn through `participant_transcript_attachments`.
- **Participants**: a member chosen as the owner who is not yet a participant
  gets a `participants` row with reason `explicit` and the importer as
  `added_by_user_id`, through the existing add path.

No existing rows are backfilled.

## Regional impact

The only thing that leaves a region is the share URL, sent to Firecrawl — the
same subprocessor, under the same regional `FIRECRAWL_API_KEY`, that the
`rally:web` plugin already uses from both regions. The page comes back to the
regional Worker and everything derived from it — the import row, the fetched
page, the turns, the artifact, the images — stays in that region's D1, R2, and
objects. There is no cross-region fallback: an EU Worker whose Firecrawl key is
absent has no import surface, the way it has no web plugin, degrading to
nonexistent rather than to failing. Browser Run, the recorded fallback fetcher,
is a Cloudflare-hosted dependency inside each regional Worker and changes none
of this. Read [`regionalization.md`](../../regionalization.md) before moving
any of it.

## Security and trust model

- **Egress is two hosts, by exact match.** The adapter registry recognizes a
  link before anything is fetched; a URL that is not `chatgpt.com/share/…`,
  `claude.ai/share/…`, or `claude.ai/code/session_…` never reaches the
  fetcher. `assertSafePublicUrl` still runs, as it does for both existing
  fetchers. Redirects off those hosts are refused. No cookie, connector
  credential, or Rally identity accompanies the fetch; it is unauthenticated
  public-page retrieval, as link capture already is.
- **Imported content is untrusted data at every boundary it crosses.** Text is
  rendered through the Markdown renderer that already treats member, model,
  email, and attachment text as untrusted; images pass the server-verified MIME
  path every upload passes; the model sees imported words as user-role messages
  that cannot outrank the system prompt. A page can say anything, including
  instructions addressed to Rally, and none of it is executed by importing it.
- **Attribution is an assertion by an authorized member, recorded as one.**
  Only a member who can open the conversation can import into it; a
  member attribution is confirmed by that person and provenance names them on
  every turn. Nothing lets an import speak *as* the importer without their
  choosing *these are my messages*, and nothing lets it speak as Rally at all.
- **Nothing about the fetched conversation is logged.** Failures log the import
  id, provider, phase, HTTP status, and provider code, never the URL's path,
  the title, or the content — the same rule link capture and
  [`runbook.md`](../../runbook.md) already hold.
- **A guest is not an identity.** No session, no mention target, no
  notification, no invitation is created from a guest label.
- **Limits are open**, listed in the implementing pull request under this
  heading and under **Reviewer notes**, per the limits document.

## Agent behavior

This PRD adds no agent tool and changes no plugin; the tool-and-plugin
documentation [`prds.md`](../../prds.md#required-documentation-for-agent-tools-and-plugins)
requires does not apply. What changes is what the agent *reads*:

- Imported turns are in the transcript the persistent loop reads, as user-role
  history said to the room, attributed to the speaker and the importer, never
  as Rally's own prior turns.
- The artifact is a `markdown` resource the agent lists with
  `workstream_list_resources` and reads, searches, or summarizes with the
  existing attachment tools; imported images are attachments it can view.
- The agent cannot start an import. The `rally:web` plugin's `fetch` can still
  read a public share page as markdown when a participant asks about a link,
  exactly as today; that is reading, not importing.
- Rally does not respond to an import. A participant who wants Rally's view
  asks for it in their next message.

## Provider configuration

- **Firecrawl:** the regional `FIRECRAWL_API_KEY` secret already exists in both
  regions; no new secret. The sandbox egress allowlist in
  [`sandbox.md`](../../sandbox.md) already carries `api.firecrawl.dev`.
- **Cloudflare:** the `BROWSER` binding already exists in both regional Worker
  configurations; nothing to apply unless the fallback fetcher is chosen.
- **OpenAI and Anthropic:** none. Both pages are read as an anonymous browser
  would read them.

## Rollout

**Proposed: behind a flag, `conversation-import-enabled`, default off for
everyone.** The question [`prds.md`](../../prds.md#optional-sections) requires
— whether the product owner wants this behind a flag — could not be put to them
while this PRD was written, and the proposal is recorded here pending their
answer in **Open questions**. If yes, the flag is a product Boolean and follows
[`feature-flags.md`](../../feature-flags.md#adding-a-flag) in full: served from
`client-feature-flags.ts`, which fails closed; registered in Ace in all three
places — `ProductFeatureFlagKeySchema`, `MANAGED_FLAGS`, and the deploy
script's `ensureFlag` — with identical description and default, in the phase
that introduces the icon; audiences reached by targeting rules, none in code.
Rally's managed flags are presentation-only by definition: the flag hides the
icon, the menu item, and the dialog, and does not remove the API routes, which
stay behind conversation authorization.

Phases, each shippable on its own:

1. **ChatGPT.** The fetcher primitive, the ChatGPT adapter, the room's batch
   writer, the external-actor label and mark registry, the dialog, the block,
   the artifact, and the flag. Images best-effort from the rendered page.
2. **Claude.** Gated on the spike in **Open questions**: the two Claude
   adapters, and whichever fetcher passes the challenge. If neither does, this
   phase ships as a named refusal in the dialog rather than not at all, and the
   open question stays open.
3. **Substream import and re-import versioning**, if phase 1 shipped them as
   main-feed-only to land sooner.

Turning it off is turning the flag off: no new imports; existing blocks and
artifacts are ordinary transcript and resources and stay. The implementing
changes add a module document for the import subsystem, written to
[`module-documents.md`](../../module-documents.md) and registered in
[`docs/README.md`](../../README.md), and update the owners of the areas touched:
[`demo-workspaces.md`](../../demo-workspaces.md) (the generalized statement of
addressing), [`agent-attachments.md`](../../agent-attachments.md),
[`conversation-surfaces.md`](../../conversation-surfaces.md),
[`text-search.md`](../../text-search.md) if Browser Run is used, and
[`feature-flags.md`](../../feature-flags.md).

## Acceptance

Walk these in a real window, per
[`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it);
the durable checks land in [`e2e.md`](../../e2e.md).

1. **A ChatGPT share into a work stream.** Paste the example link; the preview
   names the title, fifty-odd messages, the model, the date range, and that the
   page does not name its owner. Choose *these are my messages*; confirm. One
   block arrives, headed by the system turn, with the importer's turns in their
   bubble and the assistant's turns under *ChatGPT* with the mark; the images
   are on the assistant turns that produced them. The rail lists one artifact
   with the mark; its card jumps to the block; the block's chip opens the
   document. Another participant's sidebar shows one unread item, not fifty.
2. **A guest.** Import a page whose owner is not a member; confirm the guest
   default. Turns read *Name (guest)*; a mention of that name resolves nowhere;
   nobody was notified.
3. **A matched member who was not a participant.** Choose them; the dialog
   warns they will be added; after confirmation they are a participant with
   reason `explicit`, added by the importer, and received one participant
   notification.
4. **Rally does nothing, then does the right thing.** No run starts and the
   classifier is not called (the room's harness-run receipts show none). The
   next message — *summarize what the assistant in there concluded* — is
   answered from the transcript with no tool call, and the answer attributes the
   conclusions to ChatGPT, not to itself.
5. **Fold.** The header chevron folds the block to one row and unfolds it; a
   link to the system turn lands on the folded block.
6. **Nothing partial.** Kill the Worker between the fetch and the write, and
   again mid-write; the room has either the whole block or none, and the dialog
   says which.
7. **Refusals.** An unsupported link, a private link, and the same link twice
   each produce their named message and leave the room untouched.
8. **Compaction.** After a compaction the artifact is still in the rail and the
   agent reads it through `workstream_read_resource` when asked for the verbatim
   text.
9. **Every new limit is open**: `rg -n "LIMIT UNSET"` outside `docs/` lists
   each one this feature added.

## Open questions

- **Can a fetcher pass claude.ai's challenge? — blocks phase 2, not phase 1.**
  Every Claude URL shape returns a Cloudflare managed challenge to a
  non-browser client ([research.md §2](research.md#2-claude-pages)); neither
  Firecrawl with `proxy: "stealth"` nor Browser Run could be tried from the
  sandbox (no key, no browser egress). The spike is one call of each against
  the example session and a classic share, run by someone with the production
  Firecrawl key and a remote Worker; its answer picks the fetcher for phase 2
  and is recorded in the decision log.
- **Does this ship behind a flag? — the product owner's answer is pending.**
  The proposal above assumes yes. A no is recorded in **Rollout** with its
  reason, per [`prds.md`](../../prds.md#optional-sections).
- **Are ChatGPT's images fetchable from the rendered page? — best effort, does
  not block.** The share carries images as `sediment://` pointers the hydrated
  client resolves; the rendered DOM's image URLs are the expected route and are
  unverified. If they are not fetchable anonymously, images land as the
  in-place *not available* line and Goal 5 narrows to what the page serves.
- **The numbers — handed to the team.** Page size, turn count, attachment
  bytes per import, preview retention, job deadline, and imports per workspace
  per day are each defined once and shipped open. The arithmetic for the
  team's use: a page is a few hundred KB to a few MB of HTML (the example is
  669 KB); an image is up to `MAX_ATTACHMENT_BYTES` each; a turn is at most
  `MESSAGE_MAX_CHARACTERS`; a Firecrawl scrape is one request that the shipped
  client already caps with its own `SCRAPE_TIMEOUT_MS`; and one import writes
  one transaction of `turn_count + 1` rows plus one resource per image.
- **Wording for guests.** *Morgan (guest)* is the proposal; *Morgan · guest* in the
  byline's context-label slot is the alternative. Decide with the designer of
  the byline; nothing else depends on it.
