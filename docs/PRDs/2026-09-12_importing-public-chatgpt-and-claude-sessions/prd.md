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
work-stream header's overflow menu sits **Import conversation**, an import
icon with a text label. It takes the link to a shared conversation, shows
what it found and who it thinks was talking, and, once the participant
confirms, writes the complete conversation into the transcript as visibly
imported history: the owner's messages as their own turns when they are a member,
or as a named guest when they are not; the assistant's replies as turns by **ChatGPT**
or **Claude**, each carrying the provider's mark. Rally does not reply to any of
it and the addressing classifier never runs — the same statement-of-intent
mechanism the demo seeder uses, generalized from "a script says whether Rally
answers" to "an import says nobody is asking".

The imported conversation is one collapsible block in the transcript, headed by
a line saying who imported what from where, and one **artifact** in the
work-stream sidebar: a Markdown rendering of the whole conversation, with images
the shared page shows attached to the turns they belonged to. From the next turn
on, Rally can be asked about it like anything else said in the room; after a
compaction the artifact is still there for the resource tools. Reasoning, tool
calls, and hidden system messages are not imported; what a reader of the shared
page sees is what arrives. Every message on both sides carries **Imported ·
Claude** or **Imported · ChatGPT** beside its author, with source details on
selection. Reading shows actual progress phases; the source browser remains
hidden unless the website requires the person to interact with it.

## Motivation

People start work in whichever assistant is open. By the time a question
becomes a work stream, the framing, the false starts, and the assistant's best
draft already exist somewhere else, and today the only ways to bring them in are
to paste the text as one enormous message (attributed to the paster, with the
assistant's words in their mouth) or to attach the share link and hope somebody
follows it. Neither makes the conversation *part of the room*: the transcript
cannot show who said what, Rally cannot treat it as history rather than as a
request, and the artifact list cannot show it as something the room is built on.

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
and no user row (Slack members, inbound email); and the desktop app already
shows third-party web content inside a fenced browser view, the live-artifact
viewer. What is new is small and named below.

The product follow-up on 2026-09-13 made the visual requirement explicit:
"id like for those imported messages to be tagged/labeled such that it is
clear they were imported from an external session." A header alone disappears
when a reader scrolls into a long import, while sequential message playback
can look like a live assistant run. Persistent labels and a read-and-review
flow make the origin and operation clear.

## Goals

1. A participant pastes a public ChatGPT share link or a public Claude link
   and the conversation appears in the transcript as ordinary turns, in the
   order the shared page shows them, without Rally answering, the classifier
   running, or anyone being notified per turn.
2. Every turn is attributed truthfully. The source's owner is matched to a
   workspace member only with the importer's confirmation, and otherwise
   appears under their own name as a guest; the assistant appears as ChatGPT or
   Claude with the provider's mark, never as Rally and never as a member.
3. The import is one thing in the room and one thing in the artifact list: a
   collapsible block in the transcript and an artifact in the work-stream
   sidebar, each linking to the other, so a reader can fold an import to a line and a
   colleague can open the whole conversation as a document.
4. Rally treats the imported conversation as history. The next turn that asks
   about it is answered from the transcript with no tool call, and after a
   compaction the artifact remains readable through the existing resource tools.
5. Images the shared page shows arrive as attachments on the turn they belonged
   to, through the same upload and verification path as a composer attachment;
   anything the page names but does not serve is marked in place rather than
   dropped silently.
6. Failure is truthful and never partial. The dialog explains the source's
   actual state and distinguishes a known failed write from an unknown outcome
   after a lost connection; a conversation is written whole or not at all.
7. Reading exposes its actual phase, produces a complete preview, and asks
   for confirmation before anything is posted. The source browser appears only
   when interaction is necessary.
8. Every imported message, including a member's own messages, identifies its
   source without hovering or finding the block header. Its details identify
   the original time, import time, and person who confirmed its attribution.

## Non-goals

1. **Reasoning, tool calls, hidden system messages, and citations — not
   imported.** The request says so; a reader of the shared page does not see
   them either. A later PRD could fold a "worked for a while" receipt in the
   shape of the work accordion; nothing here forecloses it. Deferred.
2. **Private sessions and provider credentials — out of scope.** Rally holds no
   OpenAI or Anthropic credential: no OAuth, no stored cookies, no account
   export archives. Where a page needs a sign-in — a public Claude Code session
   is visible only to someone signed in to claude.ai — the person signs in
   inside the fenced view on their own machine, in a partition Rally never
   reads and discards afterwards. The share link is the only ingress. Regular
   public chat shares require no provider sign-in; public Claude Code sessions
   follow the provider's logged-in-viewer rule. Ordinary private conversation
   URLs and workspace-restricted shares remain unsupported even after sign-in.
   An export-archive import is a different, offline product and a different
   PRD. Deferred.
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
   possible today is detaching the artifact from the work stream. A retraction
   mechanism for a whole block is its own change; until it exists the
   confirmation step is the safeguard, and the dialog says so.
9. **Guest accounts — rejected.** A guest is a label on turns, not an identity.
   A guest cannot be mentioned, notified, invited from the block, or sign in;
   the data model's rule that a participant is a workspace member — the
   participants table is keyed on a member's user id — does not move.
10. **Editing imported turns, or attributing individual turns differently
    after the fact — rejected.** Attribution is decided once, in the
    confirmation step, for the whole conversation. Selecting a subset or
    summarizing the source before import is also deferred; this flow preserves
    the complete captured conversation.

## Product behavior

### Entry point and destination

The work-stream header shows the existing Lucide **Import** glyph followed by
**Import conversation**, immediately before **⋯**. It is a secondary action;
the composer retains its normal send action. The accessible name and tooltip
are **Import a shared conversation**.

When the header cannot fit the label, the control can reduce to its icon. The
overflow menu also contains **Import a shared conversation…**, including where
dedicated header actions are hidden. Both actions open the same dialog. A
substream's action targets that substream and names it explicitly.

The dialog is bound to the workspace, work stream, and substream from which it
was opened. It never silently retargets an import after navigation. Opening,
reading, or canceling a preview does not add a participant. Confirmation follows
the posting rules: a member who was not yet a participant becomes one with
reason `message`, as with an ordinary message. The control is available to any
workspace member who can open the destination conversation.

### Paste a link

The dialog is titled **Import a shared conversation**. It contains one field,
**Shared conversation link**, a short supported-source line, and **Add to
[destination]**. The actions are **Cancel** and **Read conversation**. Enter
in a valid link field performs the latter action.

Supported link families are `chatgpt.com/share/…`, `claude.ai/share/…`, and
`claude.ai/code/session_…`. Empty input disables reading. An unsupported URL
gets the inline error **Use a shared ChatGPT, Claude, or Claude Code link.**
Validation parses the URL and provider path; a provider name elsewhere in an
unrelated URL is not a match.

Pasting a share link into the ordinary composer does not automatically import
it or change sending behavior. There is no provider sign-in step before reading
a regular public share.

### Reading and provider interaction

The dialog replaces the link form with **Reading shared conversation…** and
the actual phase of the operation. Progress is private to the importer; other
participants see no provisional messages or loading block.

| Phase | Visible copy | Behavior |
| --- | --- | --- |
| Opening | **Opening shared conversation…** | Load the source page in the temporary isolated browser view, kept out of sight. |
| Reading | **Reading messages…** | Collect the conversation, including additional source pages when required. A discovered-message count may appear only when it is known. |
| Attachments, when present | **Preparing attachments…** | Resolve what the shared page makes available and record unavailable attachments for the preview. |
| Source needs sign-in | **Sign in to Claude to read this shared session.** | Reveal the actual provider page within the dialog, with its origin visible. Resume reading after sign-in succeeds. |
| Source needs verification | **Complete the website check to continue.** | Reveal the provider's check for the person to complete; resume after it succeeds. |
| Preparing | **Preparing preview…** | Finish parsing, order the messages, and prepare attribution and attachment information. |

Regular public ChatGPT and Claude chat shares are read without provider
sign-in. Claude Code has different access rules: Anthropic documents its public
sessions as visible to logged-in Claude users. A browser check alone does not
mean the conversation requires sign-in. The dialog responds to the source's
actual state; it does not show a generic sign-in request whenever reading
fails. See [OpenAI's shared-link access rules][chatgpt-access] and
[Anthropic's Code sharing rules][claude-code-access].

The browser disappears again when interaction is complete. The rest of the
flow remains Rally's interface. **Cancel**, the close control, or Escape before
confirmation stops the preview, closes its browser, and leaves the transcript
untouched. A late completion from a canceled preview cannot reopen it.

The UI shows phases rather than an invented percentage or estimated duration.
It does not animate source words as though an assistant were generating them.
The preview becomes ready only after the complete readable message sequence is
captured; reaching the end of the initially rendered page is not sufficient.

Once the page is readable, the main process captures transcript responses
loaded by that page and sends the bytes to the regional Worker for the
provider's deterministic adapter to parse. A ChatGPT share carries the data in
its HTML, a Claude share loads `/api/chat_snapshots/<id>`, and a Claude Code
session uses its session and event responses. Capturing an initial page does
not establish that all source messages have been read. The parsed preview is
stored against the import; no preview writes to the room. Abandoned previews
follow the open retention limit below.

### Review and attribution

The ready dialog is titled **Ready to import** and shows:

- Provider, source title, original date range, and the destination.
- Total source-message count, with counts for the person and assistant, and
  the model name where the page provides it.
- Owner name supplied by the page, or **The shared page does not name its owner**.
- **Attribute the person's messages to**, using the member-or-guest selection
  rules under **Deciding who spoke** below. The importer can correct the
  proposal before confirming.
- A readable preview of the full captured sequence, using ordinary message and
  Markdown rendering. Long previews can be scrolled; no arbitrary message cap
  truncates the conversation being confirmed.
- Available attachment counts and explicitly named unavailable files. A source
  that does not expose an upload shows **Not available from the shared page**
  beside that file. Unknown counts or dates are stated as unavailable, not zero
  or an invented timestamp.
- **Messages will be labeled “Imported · [provider]”.**

The primary button reads **Import N messages**, where N is the captured source
message count. Splitting an oversized source message into stored turns does not
inflate that number; split parts retain the same source-message identity and
label. The secondary action is **Cancel**. Confirmation applies to exactly the
content and attribution shown, without an unreviewed refresh of the source.

The dialog also states **Imported messages cannot currently be removed from
the transcript**, per non-goal 8.

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
confirmation: *Priya will be added to this work stream*, or names the target
substream. They receive the usual participant notification and nothing more.

Rally never attributes words to a member on a name match alone: the confirmation
is the importer's assertion, and it is recorded as one — the block header names
the importer, and every imported turn carries the import's provenance. A member
reading "their" imported turn later can see exactly who imported it and from
where.

The assistant's side is never a choice. It is **ChatGPT** for a ChatGPT
conversation and **Claude** for a Claude one, drawn with the provider's mark in
the byline where a person's turn carries the accent dot.

### Confirmation and insertion

After confirmation, the primary action is disabled and the dialog shows
**Adding N messages to [destination]…**. The import is one operation, identified
durably so that repeated confirmation or reconnect resolves to the same result.
Closing the progress surface after confirmation dismisses it; it does not claim
to cancel a write already admitted. A later visit to Import shows the pending
operation or its result until its outcome is known.

The full transcript block becomes visible after its write succeeds. All of its
messages are appended together in source order, with no live message inserted
between them. The room writes the system turn and all imported canonical
turns in one transaction. Participants never see half of a failed import,
per-message send spinners, or a replay of the assistant's typing. The completed import includes
the transcript artifact described below.

If the importer is still in the originating dialog, completion closes it and
positions the feed at the imported block's header, expanded, so the person can
start at the beginning. This is an explicit consequence of confirmation and
uses the existing transcript navigation mechanism. If the person dismissed the
dialog or moved elsewhere, completion does not move their viewport or switch
conversations; it offers **View imported conversation** in the existing import
result surface. It preserves their composer draft.

Other participants retain the usual follow-versus-reading behavior from
[transcript scrolling](../../transcript-scrolling.md). A reader scrolled into
history keeps their position. The import creates one unread item through its
header, not one for each source message.

### What lands in the transcript

The run opens with a system turn — *Alex imported a ChatGPT conversation:
Create Work Graph Infographic* — which is what the sidebar preview, the activity
feed, and a collapsed block show. That turn is the import's one unit of
attention: other participants see one unread item, not fifty. The imported
turns themselves advance nobody's unread count, create no mention records
(an `@name` inside imported text stays text), and notify nobody.

Each imported turn is then an ordinary turn of one of three shapes:

| The source said | The room shows | Written as |
| --- | --- | --- |
| The owner, matched to a member | The member's own turn, with their name and accent dot, in their own bubble | A human turn by that member, retaining the import provenance and source label |
| The owner, as a guest | *Morgan (guest)* with a plain accent dot | An external-actor turn: provider `chatgpt` or `claude`, display name as confirmed |
| The assistant | *ChatGPT* or *Claude*, with the provider's mark in place of the dot | An external-actor turn: provider `chatgpt` or `claude`, display name *ChatGPT* or *Claude*, the model name the page gave in the turn's provenance |

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

### The imported block and message labels

The block arrives expanded. A quiet vertical rule groups its messages with a
header that reads **[Importer] imported a [provider] conversation**. The header
also contains the source title, message count, original date range when known,
confirmed owner, **View original**, and **Transcript**. The first opens the
original provider URL; the second opens the saved Markdown artifact through
Rally's existing artifact preview. The artifact also appears in the work-stream
sidebar's artifact list; this does not introduce another rail or panel.

The following illustrates the hierarchy; its conversation and counts are
examples, not a required fixture:

```text
Alex imported a Claude conversation                         10:43 AM
⌄ Queue reliability                              Imported · Claude
  4 messages · Original: Sep 12, 2026 · Morgan (guest) & Claude
  View original ↗   Transcript

  Morgan (guest)   [Imported · Claude]                        10:43 AM
  Can we make failed deliveries easier to recover?

  Claude         [Imported · Claude]                       10:43 AM
  Yes. Keep a record of each failed delivery…
```

Every message, on both sides, carries the text **Imported · Claude** or
**Imported · ChatGPT** in its byline. Consecutive messages by one author still
show the label on each message. This includes imported messages attributed to
the current reader, split message parts, and messages containing only an
attachment. The context label must not disappear when ordinary byline grouping
would otherwise suppress the author row.

The label uses a compact import glyph and the existing context-label treatment,
with readable text in both themes. Color alone never conveys provenance. The
provider's author mark supplements its written name; it is never Rally's mark.
Message bodies retain ordinary typography, Markdown, and attachment rendering.
The source label remains visible without hovering and wraps with the byline
at narrow widths instead of becoming an unlabeled icon.

Selecting a message's label opens a small **Import details** popover containing
the provider and title, original message timestamp when available, import
timestamp, importer, confirmed speaker, and source link. It states that the
speaker attribution was confirmed by the importer. These are provenance
details, not a claim that Rally verified the identity behind the original page.
Original timestamps describe when words were said; the transcript's own clock
continues to show when the import was added to Rally.

The header chevron collapses the complete sequence into its source header.
Title, provider, **Imported** label, count, provenance, and source/artifact
actions remain available. Folding is per reader and remembered for the current
session. Reopening restores source order. A link to a specific imported message
expands the block as needed and shows that message with its source label.

The block is derived on the client from the turns' shared import id. The
server writes canonical turns, not layout. The header retains the system-turn
anchor when folded.

### The artifact

The same confirmation creates one resource: a Markdown document titled after
the conversation, whose body opens with where it came from (provider, source
link, owner as confirmed, original dates, who imported it and when) and then
carries the whole conversation with a heading per speaker turn and each
attachment cited by its resource link, so the citation renderer draws it inline.
Its canonical URL is the share link. It is attached to the conversation as an
**artifact** — the `generated` relationship, authored by the importer — so it
appears in the work-stream sidebar's artifact list with the provider's mark, opens in the
document viewer, and is listed to the agent by `workstream_list_resources` like
any other resource. The block's **Transcript** action opens it; the artifact card's
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

### Failures, duplicates, and offline behavior

| Situation | What the importer sees | Transcript outcome |
| --- | --- | --- |
| Link is unavailable, inaccessible, or expired | **This shared conversation is unavailable, or you do not have access.** Offer another link. | Unchanged. Do not invent the precise cause. |
| Page loads but cannot be read completely | **Rally couldn't read the complete conversation.** Offer retry and a support reference. | Unchanged; no successful partial import. |
| Provider format is unsupported | **Rally can't import this conversation's format yet.** | Unchanged. |
| No importable messages | **No messages were found to import.** | Confirmation is unavailable. |
| Offline before confirmation | **You're offline. Reconnect to read this conversation.** Preserve the link and allow cancel/retry. | Unchanged. |
| Write is known to have failed | **The import didn't complete. Nothing was added.** Offer retry of the same operation. | Unchanged. |
| Connection is lost after confirmation | **Checking whether the import completed…** Resolve the existing operation on reconnect. | Unknown until reconciled; do not claim failure or create a second operation. |
| Same link and unchanged content already imported here | **This conversation is already imported.** Offer **View imported conversation**. | No duplicate block. |
| Source has changed since its previous import | Show a fresh preview and **Import updated conversation** with its count. | On confirmation, append a new block and version the existing artifact as described under **The artifact**. |

Unavailable attachments are disclosed in the preview and represented on the
corresponding imported message. A readable conversation can succeed with that
disclosure; unreadable messages cannot be silently omitted to make it succeed.

A parse failure retains the captured page for diagnosis under the open
retention policy. Repeated confirmation reads the durable operation's existing
status and result; a lost response is not proof that nothing was written.

### Accessibility and interaction

Use the shared dialog, button, field, tooltip, popover, and disclosure
primitives. The link field receives focus on open; Cancel and Escape restore
focus to the initiating control before confirmation. The dialog announces phase
changes and completion politely, without reading the entire imported transcript
as a live update. Errors are announced and leave the recovery action reachable.

Source details work by click, keyboard, and touch. The disclosure communicates
expanded state. Loading and insertion obey reduced-motion preferences. Import
labels, source names, and recovery actions remain readable in light and dark
appearance and at narrow conversation widths.

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

1. **The fetcher is the desktop app's own browser, in a fenced view; every
   server-side fetcher is rejected.** Fetching a page is its own primitive with
   one job — a link in, the page's transcript bytes out — and it runs on the
   person's machine: a `WebContentsView` created with the live-artifact viewer's
   isolation contract
   ([`artifact-viewers.ts`](../../../apps/desktop/src/main/artifact-viewers.ts):
   no preload, no Node, sandbox on, context isolation, navigation fenced,
   window-open denied) with a throwaway partition in place of a persistent one,
   pinned to the provider's host. The page loads as it would in a browser, and
   the main process captures the transcript from the responses the page itself
   loads, through the DevTools protocol's read-only network events; nothing is
   injected into the page and nothing bridges out of it. Three facts decided
   this, recorded in [research.md](research.md#5-what-the-documentation-and-the-app-bundle-say):
   Anthropic's documentation says a public Claude Code session is visible only
   to someone signed in to claude.ai, so no server can read one at all;
   Cloudflare's documentation says Browser Run requests "are always identified
   as bot traffic by Cloudflare", so the `BROWSER` binding cannot pass a managed
   challenge; and Firecrawl's documentation promises nothing about challenges,
   while Anthropic's consumer terms forbid accessing the Services "through
   automated or non-human means" — which a scraping service is, and a person's
   own app showing them a page is not. The same view reads a ChatGPT share,
   whose transcript is in the page's HTML, and resolves its images inside the
   page's own session, so one path covers both providers. A server-side ChatGPT
   fetch through the existing Firecrawl client would work — it was verified —
   and is rejected only because it would be a second path with its own failure
   modes for no gain. Daytona computer use is rejected for every reason that
   applies to a server-side fetch, plus the weight of a sandbox for one page
   load. One consequence is stated rather than hidden: importing is a desktop
   action; a phone can paste the link into the room and a desktop participant
   imports it.
2. **Parse the data, not the pixels.** A ChatGPT share page carries the whole
   conversation as a React Router data stream inside the HTML, and decoding it
   gives roles, hidden-message flags, exchange grouping, model names, instants,
   and image pointers exactly
   ([research.md §1](research.md#1-chatgpt-share-pages-httpschatgptcomshareuuid)).
   Extracting from a markdown rendering of the page loses the role boundary;
   asking an LLM to extract is lossy and unverifiable, and would put a model
   between a colleague's words and their attribution. Each provider's adapter is deterministic and unit-tested against
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
   provenance carries the instant the page recorded; selecting the import
   label opens it alongside the import time, and the block header shows the
   original date range. The transcript's order and clock are the room's.
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
    the client reading the row. A synchronous request was rejected because
    browser interaction and attachment preparation can outlive a connection;
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

13. **Use text with the header icon where it fits.** A new, infrequent action
    needs a discoverable name. An icon-only control remains
    the compact treatment, with an overflow-menu fallback.
14. **Keep the source browser hidden until interaction is required.** Ordinary
    public shares need no account setup. Showing the entire provider website
    throughout reading makes another application's interface part of every
    import and obscures Rally's progress and confirmation.
15. **Label every imported message with both origin and import status.** A
    block-only marker disappears during scrolling; a bare provider name cannot
    distinguish historical content from a provider participating live. The
    shorter **Imported** alternative leaves the source at the top of the block.
16. **Show operation phases and insert the finished block together.** Artificial
    percentages and sequential message playback imply knowledge of remaining
    work or a live conversation that the importer does not have.
17. **Make provenance details explicitly openable.** A hover-only timestamp
    cannot serve keyboard or touch readers, and an imported member name needs
    a visible route to who made the attribution.

## Data model

Sketch level; the migration and [`data-model.md`](../../data-model.md) are the
record.

- **`conversation_imports`** (D1, per region): `import_id`, `workspace_id`,
  `workstream_id`, `substream_id`, `importer_user_id`, `provider`,
  `source_url` (canonical), `source_id`, `phase` (`fetching`, `parsing`,
  `awaiting_confirmation`, `writing`, `ready`, `failed`, `abandoned`),
  `attempt`, `content_sha256`, `owner_label` (as the page gave it, nullable),
  `speaker_json` (the confirmed mapping), `resource_id`, `system_turn_id`,
  `first_turn_id`, `last_turn_id`, `source_message_count`, `turn_count`,
  `failure_code`, `created_at`,
  `confirmed_at`, `ready_at`. One row per import; `phase` and `attempt` are
  written by the phase that owns them.
- **The captured page bytes and the parsed conversation** live in the regional
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

The preview and button use `source_message_count`; `turn_count` can be larger
when an oversized source message is split. The client receives import metadata
with loaded transcript history so provider labels and details remain available
on member turns as well as external-actor turns, including after reconnect.
Labels derive from provenance, never from matching provider names in text.

No existing rows are backfilled.

## Regional impact

The page is fetched on the person's own machine, so nothing leaves a region on
Rally's behalf: the provider sees a browser on the person's own network, as it
would if they opened the link themselves. The captured bytes go from the
desktop app to the regional Worker, and everything derived from them — the
import row, the captured page, the turns, the artifact, the images — stays in
that region's D1, R2, and objects. No third-party fetcher, no subprocessor, no
cross-region hop, and no regional configuration difference. Read
[`regionalization.md`](../../regionalization.md) before moving any of it.

## Security and trust model

- **The fenced view is the boundary, and it is the artifact viewer's.** The
  view that loads a provider page is created with the same web preferences as
  a live artifact — no preload, no Node, sandbox on, context isolation — plus a
  throwaway partition that holds no Rally credential and is destroyed when the
  dialog closes, navigation pinned to the provider's host with a redirect
  elsewhere refused, and window-open denied. What is new against the artifact
  contract is one read: the main process observes the view's network responses
  through the DevTools protocol and captures the transcript response. It never
  injects script, and the page has no bridge to reach. A sign-in the page asks
  for happens in that partition, as the person, and is discarded with it; Rally
  stores no provider cookie or token. [`security.md`](../../security.md) owns
  this boundary and gains it in the same change.
- **Only two hosts, by exact match.** The adapter registry recognizes a link
  before any view opens; a URL that is not `chatgpt.com/share/…`,
  `claude.ai/share/…`, or `claude.ai/code/session_…` never opens one, and the
  view's fence refuses navigation off that host.
- **The bytes are the importer's claim.** Because the client supplies them, the
  Worker accepts a captured transcript only for an import it created, from the
  importer's own session, and treats it as the importer's assertion about what
  the link showed — exactly as the attribution is. A member can already post
  whatever they like under their own name; this is no wider.
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

Any provider authentication flow must work within that isolation model before
the provider is advertised as supported. A successful read in an existing
signed-in Chrome profile does not establish that a fresh Rally browser view can
complete sign-in, capture every page of the transcript, and dispose of its
session correctly. Imported text remains untrusted source content, including
apparent instructions, links, and mentions.

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

- **None.** No Firecrawl key is used — the regional `FIRECRAWL_API_KEY` stays
  the web plugin's — the `BROWSER` binding is not used, and nothing is
  configured with OpenAI or Anthropic. Each page is read by the person's own
  browser view, signed in only where the provider requires it.

## Rollout

**No flag: the import ships enabled for everyone.** That is the product owner's
answer to the question [`prds.md`](../../prds.md#optional-sections) requires,
given on 2026-09-12, and the reason is the feature's shape: it is a control
inside a conversation the member can already open, it writes only into that
conversation, and it grants nothing — no new access, no new tool, no new
identity. There is no audience to stage it to. Rally's managed flags are
presentation-only by definition, so a flag would have hidden an icon and left
the routes in place regardless; withdrawing the surface, if it ever comes to
that, is a deploy that removes the control, and existing blocks and artifacts
are ordinary transcript and resources that stay either way. Source labels
and provenance details remain readable when the entry points are withdrawn.

Phases, each shippable on its own:

1. **The view, and ChatGPT.** The fenced import view and its capture, the
   ChatGPT adapter, the room's batch writer, the external-actor label and mark
   registry, the dialog, the block, and the artifact. Images resolved inside the
   page's own session.
2. **Claude.** The two Claude adapters. The share adapter reads the
   `/api/chat_snapshots/<id>` response the page loads — no sign-in, and never
   any attachments, because a shared chat does not carry them. The Claude Code
   session adapter reads the session response the page loads once the person
   has signed in; its shape is confirmed by the build's first task, which loads
   one public session in the view (**Open questions**). If a session page turns
   out to expose no readable transcript, this half ships as a named refusal in
   the dialog rather than not at all.
3. **Substream import and re-import versioning**, if phase 1 shipped them as
   main-feed-only to land sooner.

The implementing changes add a module document for the import subsystem, written to
[`module-documents.md`](../../module-documents.md) and registered in
[`docs/README.md`](../../README.md), and update the owners of the areas touched:
[`demo-workspaces.md`](../../demo-workspaces.md) (the generalized statement of
addressing), [`agent-attachments.md`](../../agent-attachments.md),
[`conversation-surfaces.md`](../../conversation-surfaces.md),
[`transcript-scrolling.md`](../../transcript-scrolling.md) for import navigation,
[`live-web-artifacts.md`](../../live-web-artifacts.md) (the fence the view
reuses), and [`security.md`](../../security.md) (the boundary it adds).

## Acceptance

Walk these in a real window, per
[`dev-environment.md`](../../dev-environment.md#driving-and-screenshotting-it);
the durable checks land in [`e2e.md`](../../e2e.md).

1. **Discover and target.** From a work stream and a supported substream, use
   the labeled header control and its compact/menu fallback. The dialog names
   the correct destination and preserves the composer draft.
2. **Read a public chat anonymously.** Import a working ChatGPT share and
   Claude share in a fresh temporary browser session. Normal reading shows
   Rally's phases without displaying a website or requesting provider sign-in.
3. **Complete required interaction.** With a public Claude Code session or a
   provider check, the actual page appears with its origin, resumes reading
   after interaction, and disappears when the preview is ready. Cancel closes
   it and adds nothing.
4. **Read the full sequence.** Use a conversation longer than its initially
   rendered page, including Markdown and attachments. All readable messages
   appear in order; unavailable attachments are disclosed before confirmation.
5. **Confirm attribution.** Exercise a matched member, a corrected member, an
   anonymous owner, and a guest. Nothing is posted on a name match alone; any
   added participant is disclosed before confirmation. A newly added member
   receives reason `explicit`, the importer as the adding member, and one
   normal participant notification.
6. **Observe insertion.** Confirm an import while another participant sends a
   message. Reading remains private; **Adding N messages…** resolves to one
   contiguous block, one unread item, and its transcript artifact. Rally does
   not respond and live messages do not split the block. Harness-run receipts
   and classifier checks establish that no run or classification was
   triggered; the next request is answered with conclusions attributed to the
   source assistant.
7. **Recognize every imported message.** Scroll beyond the header and inspect
   both authors, consecutive messages, the current member's messages, split
   parts, and attachment-only messages. Each still says **Imported ·
   provider**. Reload and load older history; the labels survive.
8. **Inspect provenance.** Open a label by keyboard and pointer. Original
   time, import time, importer, attributed speaker, and source are
   distinguishable; absent source metadata is not invented. The provider
   author is never Rally.
9. **Fold and navigate.** Collapse and reopen the block, open its artifact,
   and navigate directly to an imported message. The header remains
   informative, ordering is stable, and one reader's fold does not affect
   another reader. A link to the system turn lands on the folded header.
10. **Preserve the reading position.** Import completion positions the active
    importer at the header. A participant reading history is not moved;
    leaving or dismissing the import does not cause a later route or viewport
    jump.
11. **Recover without duplication.** Cancel during reading; fail a write; lose
    the confirmation response; reconnect; and repeat confirmation. Show the
    truthful state and resolve to at most one block for the same operation.
    Unchanged re-import links to the existing block; changed content gets its
    own reviewed block and artifact version. Also interrupt the Worker before
    and during the write: the room contains the whole block or none of it, and
    the dialog reconciles any unknown outcome.
12. **Compaction.** After compaction, the artifact remains in the work-stream
    sidebar and Rally reads its verbatim text through
    `workstream_read_resource` when asked.
13. **Every new limit is open.** `rg -n "LIMIT UNSET"` outside `docs/` lists
    each limit introduced by this feature, with no new defensive number chosen
    by the implementation.
14. **No flag gates the control.** A member of a fresh workspace sees the
    import action with no operator configuration.
15. **Inspect the real window.** Check light/dark appearance, narrow widths,
    focus restoration, source popovers, disclosure, and reduced motion. Use
    the repository's [visible-change
    verification](../../dev-environment.md#driving-and-screenshotting-it) and
    [test guidance](../../testing.md); a mockup or DOM assertion alone does
    not prove the shipped experience.

## Open questions

- **Can a fresh Rally view complete the full Claude Code import? — settles
  the phase 2 adapter, blocks nothing else.** The follow-up investigation read a
  shared Code session in a signed-in Chrome profile. That does not yet prove
  sign-in inside the isolated temporary view or capture of the complete event
  sequence. The build loads a working public session in that view, records the
  transcript responses including pagination, and verifies session disposal.
  The adapter is written against that capture; the decision log records the
  shape and any change needed for provider authentication. The earlier sandbox
  limitation remains recorded in [research.md](research.md).
- **ChatGPT images — best effort, does not block.** The share carries images
  as `sediment://` pointers the hydrated page resolves inside its own session;
  the view captures the resolved image responses the page loads. If a pointer
  resolves to nothing the page fetches, the image lands as the in-place *not
  available* line and Goal 5 narrows to what the page serves.
- **The numbers — handed to the team.** Page size, turn count, attachment
  bytes per import, preview retention, job deadline, and imports per workspace
  per day are each defined once and shipped open. The arithmetic for the
  team's use: a page is a few hundred KB to a few MB of HTML (the example is
  669 KB); an image is up to `MAX_ATTACHMENT_BYTES` each; a turn is at most
  `MESSAGE_MAX_CHARACTERS`; a page load in the view is bounded by the open
  preview deadline; and one import writes one transaction of `turn_count + 1`
  rows plus one resource per image.

[chatgpt-access]: https://help.openai.com/en/articles/7925741-chatgpt-shared-links-faq
[claude-code-access]: https://code.claude.com/docs/en/claude-code-on-the-web#share-sessions
