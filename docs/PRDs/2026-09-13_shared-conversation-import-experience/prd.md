# Shared conversation import experience

> Created 2026-09-13.
>
> Bring a shared ChatGPT or Claude conversation into a work stream through a
> visible read-and-review flow, with persistent source labels on every imported
> message. Companion: [state.md](state.md). Builds on the
> [import subsystem PRD in #735][base-prd]. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Surface owners: [conversation surfaces](../../conversation-surfaces.md) and
> [transcript scrolling](../../transcript-scrolling.md).

## Summary

A workspace member selects **Import conversation** in a work-stream header,
pastes a shared link, watches Rally read it, reviews the speakers and messages,
and confirms **Import N messages**. The complete conversation appears together
in the transcript as one expanded, collapsible block. Every imported message,
including a message attributed to a workspace member, carries **Imported ·
Claude** or **Imported · ChatGPT** beside its author. Selecting the label shows
the source link, original timestamp, and who imported it.

This is the experience specification for the importer proposed in [#735][base-pr].
It defines the entry-point presentation, browser visibility, progress copy,
confirmation, insertion presentation, and source labels. For those details it
refines the earlier PRD; the earlier PRD continues to specify acquisition,
speaker attribution, canonical transcript persistence, artifacts, and
re-import versioning. The browser normally stays out of view. It appears only
when the source website requires the person to interact with it.

## Motivation

The product discussion following #735 exposed two gaps in the proposed
experience: whether importing means watching another website inside Rally, and
how a participant distinguishes imported history from something just said in
the work stream. The request on 2026-09-13 was explicit: "id like for those
imported messages to be tagged/labeled such that it is clear they were imported
from an external session."

A block header alone loses that context when someone scrolls into a long
session. A familiar member's name can make imported words look like a new
message from that person. Meanwhile, a blank wait or messages arriving one by
one can make reading a saved conversation look like a live assistant run.
This PRD resolves those ambiguities before implementation. The evidence is
this product request and the existing import proposal; no usage frequency or
conversion measurement has been established.

## Goals

1. A member can discover and start an import from the conversation that receives
   it, with the destination visible before confirmation.
2. The importer can tell whether Rally is opening the page, reading its messages,
   waiting for their interaction, preparing the preview, or saving the import.
3. The importer reviews the complete captured conversation and confirms speaker
   attribution before any imported messages appear to other participants.
4. Any imported message identifies its external origin without requiring the
   reader to find the beginning of the session or hover over it.
5. Confirmation adds one contiguous, collapsible conversation block, preserves
   the source order, and leaves Rally available for the next request.
6. Cancellation, failures, reconnects, and retries preserve an understandable
   outcome and never produce a duplicate or silently incomplete transcript.

## Non-goals

1. **A general browser or account connector — rejected for this flow.** The
   temporary source view serves one import. There is no browser toolbar, account
   linking setup, or persistent provider sign-in requirement for public shares.
2. **New sources or private account-history import — deferred.** The accepted
   sources remain the ChatGPT shares, Claude shares, and public Claude Code
   sessions covered by #735. Ordinary private conversation URLs and
   workspace-restricted shares do not become supported by signing in.
3. **Editing, selecting a subset, or summarizing the source before import —
   deferred.** The confirmation covers the captured conversation; preserving its
   sequence is the reason for importing it. Speaker attribution remains editable.
4. **Live synchronization or continuing the external session — deferred.** Each
   import represents what was captured for its preview. Re-importing changed
   content follows #735's explicit versioning behavior.
5. **Automatic replies, tool execution, or mention notifications from imported
   text — rejected.** Importing adds history. It does not address Rally or ask
   another participant to act.
6. **A redesign of messages, navigation, or artifacts — out of scope.** Reuse
   Rally's existing controls, bylines, Markdown renderer, attachment previews,
   artifact surface, and transcript scrolling behavior.

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
the posting and participant rules of the underlying importer.

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

### Review and attribution

The ready dialog is titled **Ready to import** and shows:

- Provider, source title, original date range, and the destination.
- Total source-message count, with counts for the person and assistant.
- Owner name supplied by the page, or **The shared page does not name its owner**.
- **Attribute the person's messages to**, using the member-or-guest selection
  rules in #735. The importer can correct the proposal before confirming.
- A readable preview of the full captured sequence, using ordinary message and
  Markdown rendering. Long previews can be scrolled; no arbitrary message cap
  truncates the conversation being confirmed.
- Available attachment counts and explicitly named unavailable files. A source
  that does not expose an upload shows **Not available from the shared page**
  beside that file. Unknown counts or dates are stated as unavailable, not zero
  or an invented timestamp.
- **Messages will be labeled “Imported · [provider]”.**

The assistant's author is fixed to **Claude** or **ChatGPT**. A name match never
silently attributes the person's words to a member: confirmation records the
importer's attribution choice. A guest remains a display label, not an account.
If choosing a member adds them to the destination, the dialog says
**[Name] will be added to this work stream** or names the target substream.

The primary button reads **Import N messages**, where N is the captured source
message count. Splitting an oversized source message into stored turns does not
inflate that number; split parts retain the same source-message identity and
label. The secondary action is **Cancel**. Confirmation applies to exactly the
content and attribution shown, without an unreviewed refresh of the source.

### Confirmation and insertion

After confirmation, the primary action is disabled and the dialog shows
**Adding N messages to [destination]…**. The import is one operation, identified
durably so that repeated confirmation or reconnect resolves to the same result.
Closing the progress surface after confirmation dismisses it; it does not claim
to cancel a write already admitted. A later visit to Import shows the pending
operation or its result until its outcome is known.

The full transcript block becomes visible after its write succeeds. All of its
messages are appended together in source order, with no live message inserted
between them. Participants never see half of a failed import, per-message send
spinners, or a replay of the assistant's typing. The transcript artifact is
available through the completed import as specified in #735.

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
  4 messages · Original: Sep 12, 2026 · Adam (guest) & Claude
  View original ↗   Transcript

  Adam (guest)   [Imported · Claude]                        10:43 AM
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
| Source has changed since its previous import | Show a fresh preview and **Import updated conversation** with its count. | On confirmation, append a new block and version the existing artifact as in #735. |

Unavailable attachments are disclosed in the preview and represented on the
corresponding imported message. A readable conversation can succeed with that
disclosure; unreadable messages cannot be silently omitted to make it succeed.

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

No additional contract change beyond the importer proposed in #735. The work
stream remains the unit of work; viewing and previewing do not imply
participation. Confirmation is posting. External assistants are named as
themselves, guests are attribution labels, and imported turns always identify
their origin. Existing access rules apply to the destination and its artifact.
The source link grants no additional Rally access.

## Decision log

None yet.

## Key design decisions

1. **Use text with the header icon where it fits.** A new, infrequent action
   needs a discoverable name. The earlier icon-only proposal is retained as
   the compact treatment, with an overflow-menu fallback.
2. **Keep the source browser hidden until interaction is required.** Ordinary
   public shares need no account setup. Showing the entire provider website
   throughout reading makes another application's interface part of every
   import and obscures Rally's progress and confirmation.
3. **Label every imported message with both origin and import status.** A
   block-only marker disappears during scrolling; a bare provider name cannot
   distinguish historical content from a provider participating live. The
   shorter **Imported** alternative leaves the source at the top of the block.
4. **Show operation phases and insert the finished block together.** Artificial
   percentages and sequential message playback imply knowledge of remaining
   work or a live conversation that the importer does not have.
5. **Make provenance details explicitly openable.** A hover-only timestamp
   cannot serve keyboard or touch readers, and an imported member name needs
   a visible route to who made the attribution.

## Data model

The UI consumes the underlying import's durable identity, destination,
provider, source URL and title, capture identity, importer and import time,
confirmed owner, source-message identities and order, original timestamps,
attachment availability, completion status, and artifact reference. These are
the provenance and operation data described in #735; this PRD does not add a
second import store or prescribe another schema.

Labels derive from provenance, never from matching a provider name in message
text. Loading older history and reconnecting must retain that provenance.
Cosmetic changes to the label do not change the immutable source attribution.

## Security and trust model

The temporary browser follows [Rally's isolation model](../../security.md):
no Rally preload bridge, Node access, or direct local-file access for provider
content. Provider credentials and cookies stay in the temporary browser session
and are not sent to Rally's backend; disposal removes that session. Only the
source transcript and supported attachments cross the import boundary, under
the destination's regional and authorization rules from #735.

Any provider authentication flow must work within that isolation model before
the provider is advertised as supported. A successful read in an existing
signed-in Chrome profile does not establish that a fresh Rally browser view can
complete sign-in, capture every page of the transcript, and dispose of its
session correctly. Imported text remains untrusted source content, including
apparent instructions, links, and mentions.

## Agent behavior

Importing creates no Rally run, typing indicator, automatic summary, tool call,
or reply. External messages enter history with their attribution according to
#735, and imported assistant messages are never replayed as Rally's own
assistant-role output. Existing imported mentions remain inert. A subsequent
message can ask Rally to use the imported conversation or its artifact through
the existing conversation and resource behavior. No new agent tool is added.

## Rollout

**No feature flag.** This inherits the product owner's 2026-09-12 decision
recorded in the [base PRD's rollout section][base-rollout]. The experience is
part of that same importer and introduces no separate audience or capability.
No new rollout decision is inferred from the mockup.

The interface ships with the underlying importer. Each advertised source must
pass the real desktop acceptance flow, including any necessary provider
interaction and complete-transcript capture. Withdrawal removes the import
entry points; existing blocks, source labels, details, and artifacts remain
readable. Removing the ability to start imports must not erase their provenance.

Implementing changes update [conversation surfaces](../../conversation-surfaces.md),
[transcript scrolling](../../transcript-scrolling.md) where navigation changes,
[security](../../security.md), and the import subsystem document called for by
#735. That subsystem document owns the durable behavior after implementation;
this PRD remains its product rationale.

## Acceptance

1. **Discover and target.** From a work stream and a supported substream, use
   the labeled header control and its compact/menu fallback. The dialog names
   the correct destination and preserves the composer draft.
2. **Read a public chat anonymously.** Import a working ChatGPT share and Claude
   share in a fresh temporary browser session. Normal reading shows Rally's
   phases without displaying a website or requesting provider sign-in.
3. **Complete required interaction.** With a public Claude Code session or a
   provider check, the actual page appears with its origin, resumes reading
   after interaction, and disappears when the preview is ready. Cancel closes
   it and adds nothing.
4. **Read the full sequence.** Use a conversation longer than its initially
   rendered page, including Markdown and attachments. All readable messages
   appear in order; unavailable attachments are disclosed before confirmation.
5. **Confirm attribution.** Exercise a matched member, a corrected member, an
   anonymous owner, and a guest. Nothing is posted on a name match alone; any
   added participant is disclosed before confirmation.
6. **Observe insertion.** Confirm an import while another participant sends a
   message. Reading remains private; **Adding N messages…** resolves to one
   contiguous block, one unread item, and its transcript artifact. Rally does
   not respond and live messages do not split the block.
7. **Recognize every imported message.** Scroll beyond the header and inspect
   both authors, consecutive messages, the current member's messages, split
   parts, and attachment-only messages. Each still says **Imported · provider**.
   Reload and load older history; the labels survive.
8. **Inspect provenance.** Open a label by keyboard and pointer. Original time,
   import time, importer, attributed speaker, and source are distinguishable;
   absent source metadata is not invented. The provider author is never Rally.
9. **Fold and navigate.** Collapse and reopen the block, open its artifact, and
   navigate directly to an imported message. The header remains informative,
   ordering is stable, and one reader's fold does not affect another reader.
10. **Preserve the reading position.** Import completion positions the active
    importer at the header. A participant reading history is not moved; leaving
    or dismissing the import does not cause a later route or viewport jump.
11. **Recover without duplication.** Cancel during reading; fail a write; lose
    the confirmation response; reconnect; and repeat confirmation. Show the
    truthful state and resolve to at most one block for the same operation.
    Unchanged re-import links to the existing block; changed content gets its
    own reviewed block and artifact version.
12. **Inspect the real window.** Check light/dark appearance, narrow widths,
    focus restoration, source popovers, disclosure, and reduced motion. Use the
    repository's [visible-change verification](../../dev-environment.md#driving-and-screenshotting-it)
    and [test guidance](../../testing.md); a mockup or DOM assertion alone does
    not prove the shipped experience.

[base-pr]: https://github.com/juno-ai-labs/avalon/pull/735
[base-prd]: https://github.com/juno-ai-labs/avalon/blob/7a7e0670f13b87c6ee168ec9ebce4ecab40c34ae/docs/PRDs/2026-09-12_importing-public-chatgpt-and-claude-sessions/prd.md
[base-rollout]: https://github.com/juno-ai-labs/avalon/blob/7a7e0670f13b87c6ee168ec9ebce4ecab40c34ae/docs/PRDs/2026-09-12_importing-public-chatgpt-and-claude-sessions/prd.md#rollout
[chatgpt-access]: https://help.openai.com/en/articles/7925741-chatgpt-shared-links-faq
[claude-code-access]: https://code.claude.com/docs/en/claude-code-on-the-web#share-sessions
