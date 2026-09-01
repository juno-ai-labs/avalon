# Shared conversation surfaces

Rally's work-stream feed and automation draft wizard are two adapters over one
renderer conversation family. They share presentation and interaction
primitives, not product authority or one stateful screen component.

## Where the code lives

- `apps/desktop/src/renderer/components/conversation-follow.tsx` owns the
  transcript viewport, follow controller, and **Jump to latest** integration.
- `apps/desktop/src/renderer/components/message-feed.tsx` and the message/card
  components it composes render ordered human, assistant, tool, activity,
  attachment, and failure rows.
- `apps/desktop/src/renderer/components/expanded-composer.tsx`,
  `use-draft-text.ts`, and `use-file-attachments.ts` provide the common composer
  shell, local text persistence, and staged-file lifecycle.
- `apps/desktop/src/renderer/screens/workstream.tsx` adapts a SubstreamAgent feed.
  Its tool rows are not rendered one per call: they collapse into one row per
  plugin, which [`plugin-activity-rows.md`](plugin-activity-rows.md) owns
  entirely. The automation adapter below deliberately keeps a row per call.
- `apps/desktop/src/renderer/screens/new-automation.tsx` adapts an AutomationAgent
  draft feed.

## Contract

Both adapters provide canonical ordered turns, loaded coverage, streaming
blocks, activity timing, attachment actions, retry/stop state, and a stable
conversation identity. The common viewport follows only while the reader owns
the latest edge; scrolling transfers ownership to the reader until **Jump to
latest** is selected. Programmatic repositioning is announced before changing
`scrollTop`, and reduced-motion preference controls whether the jump animates.

Sharing stops at product semantics. Work streams retain participants, unread,
resource, run, and steering controls. The in-flight pending queue is one of
those: it attaches to the work-stream composer, not to the shared
`ComposerInput`, and automation drafts have no equivalent. Automation drafts retain templates,
definition review, acceptance, compiler retry/stop, and structured elicitation.
Neither adapter may smuggle those controls through an optional common prop.

The route host, not the feed, owns identity transitions. A new work stream and a
new automation begin with local composer keys; after durable admission their
adapter rekeys text/files and adopts the server identity without remounting the
conversation family. Socket snapshots remain authoritative after reconnect;
local optimistic rows are reconciled by stable client turn IDs.

Finished assistant turns also share the action row. Copy and export remain
local actions; **Speak** uses the regional authenticated stream documented in
[`message-speech.md`](message-speech.md) and receives the complete stored
markdown even when the shared renderer has collapsed its sections. The row is
rendered *beside* the turn's block rather than inside it: it is hidden until the
turn is hovered, and a theme that fills the block would otherwise show an empty
strip of fill on every settled turn.

Both sides of the transcript have the same two-part shape — a gutter carrying
the speaker's mark, and a block the words sit in. Whether that block reads as a
bubble or as plain text running the column is a *theme's* decision, made through
`cmp.bubble.*` in [`theming.md`](theming.md); neither adapter branches on it.
A band between two turns sent on different calendar days is derived from the two
rows rather than stored, so a turn arriving out of order moves the band with it.

## Testing

Shared components have fixture-level component tests for settled, streaming,
failed, elicitation, attachment, tool, follow, and paging states. Each screen
adapter separately proves its controls and identity transition. Any visible
change also requires a real Electron-window check because DOM assertions cannot
prove layout, focus, scroll position, or overlap.

## Changelog

### 2026-09-01 — Rally's turn gets the shape a person's turn already had

**What changed:** An assistant turn renders as
`.agent-message-content` → an aria-hidden `.agent-message-avatar` gutter and an
`.agent-message-column` holding `.agent-message-bubble` and, under it, the
action row. It used to be a bare header followed by prose. The action row moved
out of the block it labels, and the block's prose takes `color: inherit` so the
fill and the tone readable on it are one decision. A centred day band now sits
above the first turn of each calendar day, derived from the two adjacent rows.

**Why:** The reskin in [`theming.md`](theming.md) needed a transcript with a
bubble on both sides, and the only side that could have one was the person's —
Rally's turn had no element to fill and nowhere for a mark to sit. Adding both
to the markup and leaving *whether they are drawn* to `cmp.bubble.*` is what
keeps Terra and Air looking exactly as they did while Grok gets a chat
transcript out of the same components.

**Considered and rejected:** a bubble on the person's side only, which is what
shipped before. A transcript with a bubble facing prose reads as two products,
and it was the reason the avatar had nowhere to go. Also rejected: leaving the
action row inside the bubble. It is `opacity: 0` until hover, so inside a fill
it is a visible empty strip under every settled turn — cheap to see once a
theme fills the block, and invisible until one does.

**What a future change has to respect:** the action row stays a sibling of the
bubble, for that reason. Nothing in either adapter may branch on which theme is
active to decide the shape — the tokens are the branch. And the day band is
derived on render rather than stored on a turn: a turn that arrives late, or one
whose timestamp is corrected, has to be able to move it.

### 2026-09-01 — A queued row renders the transcript's Markdown, clipped to one line

**What changed:** `ComposerQueue` renders each queued message through
`MarkdownBody` (`verbatim`, with the message's stored `mentions`) instead of
printing `item.text`. The row now shows the same emphasis, code spans, and
person/connection chips the turn will show once it lands. `ComposerQueueItem`
carries `mentions` because a connection mention is only offsets into `text`,
and `text` reaches the renderer untrimmed so those offsets still land. The grip's
accessible name keeps a plain string, with link and image syntax unwritten to its
label by `queuePreviewLabel`.

**Why:** A person mention is stored as `[@Ada Lovelace](person:<uuid>)`, so the
plain-text row showed the author the raw source — UUID included — for the
mention they had just typed, and went on showing it until the message left the
queue.

**Considered and rejected:** A second, inline-only renderer for previews. It
would have had to track every construct `MarkdownBody` learns — chips, citation
schemes, the connector token — and the first thing it would have got wrong is
the thing this entry is about. The flattening it would have done in components
is done in `app.css` instead: every block inside `.composer-queue-text
.markdown-body` is `display: inline`, so the row's existing `nowrap` and
ellipsis clip the whole message to its one line.

**Consequences:** The one-line rule now lives in the stylesheet, where no
component test can see it — `app.css.node.test.ts` owns it, and deleting the
flattening fails there rather than silently growing the composer dock to the
height of a queued message. A `.markdown-body` host that recedes states its own
colour rather than inheriting, because the shared-paint guard reserves
`color: inherit` for the embed-card preview.

### 2026-08-30 — Finished assistant turns share Speak and Stop speaking

**What changed:** The common assistant action row can start one streamed AI
voice and stop it. Both work-stream and automation adapters inherit it from the
same message component, and collapsed presentation never truncates the source.

**Why:** Speech is an action on the completed assistant turn, not a product
control belonging to one adapter. Implementing it in WorkstreamScreen would
repeat the divergence this shared conversation family removed.

**Considered and rejected:** A work-stream-only control and DOM text extraction.
The first excludes automation responses without a semantic reason; the second
silently drops collapsed text and turns presentation into data loss.

**Consequences:** Any conversation adapter that renders the shared action row
also needs a `SpeechPlaybackProvider` at its route host. The provider owns one
active voice across all visible turns.

### 2026-08-30 — Work-stream pending messages attach to the composer as a live queue

**What changed:** While a work-stream loop is running, the composer no longer
offers a steer/queue dropdown. Sends default to queue, and pending rows
(author avatar, hover drag handle) stack on the composer instead of as
transcript pills. Reorder is REST, visible to every viewer.

**Why:** The queue is a work-stream product control, not a shared conversation
primitive. Putting it in `ComposerInput` would smuggle loop semantics into
automation drafts.

**Considered and rejected:** Rendering the queue as a sibling in
`composer-stack` rather than inside `composer-wrap`. The attached, slightly
inset stack is a work-stream layout, and the wrap is already the unit the
mention/command popovers position against.

**Consequences:** Shared composer changes still need coverage in both
adapters; the queue remains locally typed on `WorkstreamComposer`.

### 2026-08-28 — Work streams and automation drafts share one conversation family

**What changed:** Feed, composer, attachment, message action, follow, and jump
behavior were extracted from WorkstreamScreen and adopted by the Automation
Draft Wizard through explicit adapters.

**Why:** The two products have the same conversation mechanics but different
authorities and controls; duplicating the mechanics had already produced
different streaming and scrolling behavior.

**Considered and rejected:** Reusing WorkstreamScreen itself would make an
automation draft pretend to have participants, unread state, resources, and a
SubstreamAgent identity. A second wizard-only feed would preserve divergence.

**Consequences:** Shared interaction changes need coverage in both adapters,
while product-specific controls remain locally typed and visibly absent from
the other surface.
