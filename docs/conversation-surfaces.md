# Shared conversation surfaces

Rally has one conversation surface: the feed of a `SubstreamAgent`, under
whichever kind of parent it has. A work stream's main feed and an automation's
own chat are the same surface over the same wire, reached through
`/conversations/:parentId` and `/socket/conversations/:parentId/:substreamId`
with a work-stream id or an automation id as the parent. The standalone
automation draft wizard that used to be a second adapter over this family is
gone, and so is the compiler it talked to; drafting an automation is a
conversation in the automation's own substream `0`, with the drafting tools
loaded as a plugin, so there is one adapter and nothing to keep in step with
it. The extracted pieces below are still worth their seams (they are what a
feed is made of), but a change to them has one caller, and a second surface is
a thing to argue for rather than a thing to preserve.

## Sidekick navigation and attachments

The main-window `/sidekicks` adapter opens the dedicated library and returns the
main window to its workstream route. Opening the account item from an existing
detail navigates the singleton back to the library. The sidebar recognizes both
legacy automation details and new Sidekick details. Attachment remove buttons
have their own class so accessibility labels on the row do not apply button-only
layout. Disabled email triggers hide the displayed address while preserving its
permanent owner reservation. Workspace automation pushes invalidate the library
and attachment REST queries in each open window, keeping cross-window authoring
and availability changes visible without navigation.

## Sidekick conversations and attachments

Sidekick authoring uses the shared conversation surface in a separate library window. Generated descriptions summarize instructions; ready submissions save immediately. The center workstream sidebar replaces participant rows with a facepile and keeps a **Sidekicks** section below it, including while the list is loading or empty. When present, its rows are this work stream's Sidekicks: the ones it owns and the ones its main conversation has loaded, with access-checked removal of an attachment affecting future executions. `ConversationSurface` owns both queries and hands the merged rows to the sidebar and the inspector rail, so the two rails cannot disagree about what a room has.

## Where the code lives

- `apps/desktop/src/renderer/components/conversation-follow.tsx` owns the
  **Jump to latest** and transient `ActivityPresence`, sharing retained motion.
- `apps/desktop/src/renderer/components/agent-work-timing.tsx` owns every row in
  that 20px-mark column: `AgentWorkTiming`, which counts, `AgentCompactionIndicator`,
  which names a state instead and is one call to the `ActivityStatusRow`
  primitive, and `RunStopAcknowledgement`, which is the dock's own. It does not
  go through that primitive, and the exception is the point: `ActivityStatusRow`
  is a row for a state that is still running, and this one has to span a change
  from running to settled inside a single mounted live region. Another state
  that is *running* goes into the primitive, not into another copy of the row's
  `role`, live-region attributes and orb props.
  `conversationActivityRow` in `screens/conversation-surface.tsx` is the single
  decision about which of them the feed's activity slot shows, and
  `nextStopAcknowledgement` beside it is the single decision about what the
  dock says of a stop;
  `conversationShowsStoppingRow` beside it is the separate question of whether
  the composer dock acknowledges a pending stop, and the two are separate
  because only one of them lives inside the scroller.
- `apps/desktop/src/renderer/components/message-feed.tsx` renders the ordered
  list itself — every row, the unread divider, the oversized-message
  placeholder, and row disclosure — and `workstream-blocks.tsx` renders
  the human, assistant, tool, activity, attachment, and failure rows it
  composes. Both adapters render `MessageFeed`; windowing is the one thing it
  takes from its host, because only the paging surface needs it.
- `MessageActions` in `workstream-blocks.tsx` is the one hover row under a
  message, on every surface that draws one: Rally's turn, a person's turn and a
  merged result in a Thread or Breakout, and a Channel's own messages and merges
  (`screens/channel.tsx`). The host passes what it can offer (New breakout,
  Merge, whether the text actions apply); the row owns order, labels, fade and
  metrics, styled by the single `.message-actions` class in `app.css`.
- `apps/desktop/src/renderer/components/message-text-menu.tsx` is the Radix
  right-click menu on a feed `MarkdownBody` — assistant and human prose, not
  glances, stills, the inspector, or the lightbox. Copy writes the rendered
  HTML and plain text of the selection, or of the whole body if there is none,
  keeping citation labels and dropping only chrome marked
  `data-clipboard-exclude`. Copy as markdown writes the stored source. Speak
  is the same toggle as the action row, hidden while the turn is still
  streaming; a human body names it *Speak*, not *Speak response*. Look Up and
  Share are macOS-only, behind trusted IPC. Share sends the selected or
  whole-message rendered plain text, never the stored markdown.
- `apps/desktop/src/main/editable-text-menu.ts` gives editable text fields in
  the main, Sidekicks, and settings windows an
  Electron native context menu for spelling suggestions, dictionary learning,
  and editing commands. The main process installs it only for editable targets;
  message prose and sidebar rows retain their renderer-owned menus.
- `packages/ui/src/components/primitives.tsx` owns `Tip` and
  `TipGroup`: a hover explanation, and the group a row of controls shares one
  delay and one provider through. A new tooltip comes from there rather than
  from Radix's five parts; eight files still assemble those by hand and predate
  it.
- `packages/ui/src/components/conversation-menus.tsx` owns the Channel and
  Breakout title-pill menus that replaced the Channel rail
  ([`desktop-shell.md`](desktop-shell.md)).
- `apps/desktop/src/renderer/lib/window-activation.ts` answers the one question
  every one of those surfaces has to ask before it opens: whether the hover or
  the focus it is looking at came from the person or from the window being
  brought to the front. It also answers whether a focus follows a key press or
  a pointer press, so a tip opens on keyboard focus and not on focus that code
  moved after a tap or click. `App` installs it per window, and the browser's
  shell installs it itself because it mounts below `App`; `Tip` and the
  sidebar's row preview ask it, and anything else that opens on hover or focus
  should.
- `apps/desktop/src/renderer/components/expanded-composer.tsx`,
  `use-draft-text.ts`, and `use-file-attachments.ts` provide the common composer
  shell, local text persistence, and staged-file lifecycle.
- `apps/desktop/src/renderer/lib/markdown-lists.ts` owns list editing in a
  draft: what Enter, Tab, Shift+Tab and the two list toggles do to a bulleted or
  numbered list, as pure functions over `(text, selectionStart, selectionEnd)`.
  `composer-input.tsx` binds the keys and applies the returned edit through the
  field's own `execCommand`, so the change stays on its undo stack. A second text surface that wants the same
  keys takes these rather than growing its own; the file's own header states the
  rules and why each is what it is.
- `apps/desktop/src/renderer/screens/conversation-surface.tsx` is the one feed
  composition: `ConversationSurface({parentKind, parentId, substreamId,
  renderHeader})` owns the transcript, composer, attachments, and the socket
  hooks for one conversation, keyed by the parent id and substream. Its
  composer draft is `workstreamDraftKey` over the parent id, whichever kind of
  parent that is. `screens/workstream.tsx` renders it for a work stream;
  `screens/automation.tsx` renders `components/automation-header.tsx` in a sibling profile pane
  through `SidekickDetailLayout`, with a short conversation heading over the feed with `parentKind: "automation"` and `substreamId:
  "0"`. `AddParticipantDialog` stays open after an add or a remove of someone
  else so more than one membership can be changed in one sitting; it closes on
  click-outside, Escape, the header close control, or when the current person
  removes themselves. Tool rows are not rendered one per call: they collapse into one row per plugin, which
  [`plugin-activity-rows.md`](plugin-activity-rows.md) owns entirely. The
  retired automation-draft adapter kept a row per call, which is the divergence
  that made the collapse a decision worth recording rather than an obvious one.

The connector-connection tool is deliberately an opt-in exception to tool-row
collapse. `ConversationSurface` enables it for the main message feed, where its
validated input renders the interactive connector card. `MessageFeed` and
`MessageBlock` default the feature off, so another transcript host cannot gain
OAuth controls merely by reusing the renderer. The card follows the installed
Grok Bot connector-card geometry (column card, 16px radius, 12px padding, 40px
provider mark, 12px header gap) while resolving color and typography through
Rally tokens. The connection and pending states come from Rally's live queries
and app-session OAuth receipt, never from the transcript payload. The card's
identity does come from the completed tool fact: the server retains the
validated id and scope as participant-safe output, and the renderer accepts
that terminal output (plus the exact legacy core-tool summary) so a card that
has been shown stays in the feed across reload, recovery, and virtualization.
An uninterrupted run of repeated presentations for the same connector and
scope collapses to its newest durable row; an intervening conversation row or
history seam starts a separate occasion. Persistence therefore never produces
a double-stacked control.

## Contract

The shared composer mention picker keeps Rally first, then groups people into
**Participants**, **Org members**, and **Guests**. Participation takes precedence
over guest access; pending Organization invitees appear under Org members until
shared into the conversation, when they appear under Participants. Empty groups
are omitted after search. The popup scrolls through every match so a large member
group cannot hide guests, and keyboard navigation skips headings. Account types
remain in accessible option names. Grouping is memoized, with each group carrying
its starting option index so rendering does not search the flattened list for
every row.

A host that hides a conversation must provide `ConversationVisibilityContext`.
The conversation remains mounted, but hidden panes do not claim window-level
file pastes or acknowledge reads. `useVisibleReadAcknowledgement` cancels queued
reads when hidden and rechecks visibility before dispatch.

Human message dots and bubble backgrounds resolve the sender's current account
color from the live member-presentation context. The same resolution applies
to answered elicitations and optimistic answers attributed to the current user.
Profile changes repaint already-loaded turns without rewriting transcript data.
The fill comes straight from the palette — `sys.color.project.<key>`, resolved
through `personalColorKey()` so a retired accent name follows its replacement —
and the ink from `PALETTE_INK`. There is no per-accent component token in
between: the `cmp.member-message.*` roles that used to restate the fill and ink
by hand drifted from the palette and could not survive the accent set changing,
so the feed reads the palette directly. Contrast is still not inferred at render;
`PALETTE_INK` is a checked-in table that `palette.css.node.test.ts` recomputes
from the token values, deciding by APCA rather than the WCAG 2 ratio. Bubble
prose is the strictest thing that table serves, and on `emerald` and `orange`
neither ink reaches APCA's Lc 60 for body text — a property of those two fills,
recorded on `PALETTE_INK`.
Unprofiled and external senders retain their stable identity-color fallback.
These bubble overrides apply only inside the conversation feed hosts. Author
labels use semantic default text while the independently themed dot retains the
profile hue, so a bright dot cannot make the name unreadable.

The adapter provides canonical ordered turns, loaded coverage, streaming
blocks, activity timing, attachment actions, retry/stop state, and a stable
conversation identity, for a work stream's conversation and an automation's
alike. The common viewport follows only while the reader owns
the latest edge; scrolling transfers ownership to the reader until **Jump to
latest** is selected. Programmatic repositioning is announced before changing
`scrollTop`. Reduced-motion preference gates arrivals, activity transitions, and
the jump control. Exiting controls remain mounted but inaccessible until their
fade completes; changing direction reverses the active animation in place. The
jump control hangs one spacing step above the composer, anchored from
underneath to the composer dock's top edge so the gap survives a composer that
grows; that edge is the composer's own only while the dock states no padding
above it, which no automated test covers for the rules naming either class; it
is verified in a real window.

Every surface with a composer renders the same one, dressed the same way: the
message capsule, keyed on `.has-message-capsule
.workstream-composer.is-message-capsule` — one 44px pill on a 22px corner, a
42px-tall field, the plus in the left column and the send or dictation control
in the right. `ComposerInput` takes `layout: 'message-capsule'` on every
surface, and no surface states a treatment of its own. The capsule rules apply
only under a root carrying `has-message-capsule` (today `.workstream-screen`
and `.channel-screen`), so a new screen that hosts the composer adds that class
to its root, or its composer falls back to the toolbar layout. Every surface
also draws it through the same host, `WorkstreamComposer`: the conversation,
the new-breakout dock, the new-Channel launcher and the Channel's own composer.
The host reads only a `ComposerConversation` — participants, scope, run status and stop state — plus
a `draftKey`, so a conversation that does not exist yet supplies those rather
than a whole `WorkstreamDetail`. Wrapped
text and staged attachments span the controls' own grid row, so the reserve at
the foot of the field is what holds the two apart: the 28px control, the 7px of
row padding under it, and 4px of air between the last line and the top of the
plus. A
launcher that dressed its field differently made the element a person types
their first message into the odd one out on a screen already showing the
conversation it becomes, and it made the hand-off a costume change.

The capsule's plus menu starts with **Attach files** when the host passes
`onAttach`. A host may add its own entries after it through `menuActions`
(`ComposerMenuAction`), and the menu shows whenever it has any entry. The
composer draws each and calls its `onSelect`. An entry with a `disabledReason`
is disabled by hand (`aria-disabled`, with selection blocked) rather than with
Radix's `disabled`, which would drop it from arrow-key focus, so a keyboard
still reaches the tooltip that gives the reason. The Channel's composer uses it
for **Import from Claude or ChatGPT** ([session import](session-import.md)).

A paste of `LONG_PASTE_CHARACTERS` or more (`lib/pasted-text.ts`) attaches
as a file instead of landing at the caret, unless the message already holds
all the files it can. The client uploads it as plain text with
`pastedText=true` and shows a skeleton card; `ResourceService.upload` hands it
to `services/pasted-text-service.ts`, which types and names it, and the tile
then shows the resource's title and type.

The run's Stop action is an icon after Send, sharing the microphone's circular
neutral background, with a tooltip that explains the
current action or pending stop. Its mounted, inert-when-hidden slot animates its
width and horizontal translation together: the microphone and Send move left
as Stop slides through the capsule's clipped right corner, and return as it
slides out. Both control groups center in the single-line row; multiline and
attachment layouts keep them bottom-aligned. CSS transitions reverse in place on rapid state changes and are
removed for reduced motion. A pending stop shows a spinner and remains hoverable for its tooltip
but cannot submit another stop request. The capsule's rounded overflow clips
the moving button; tooltips portal outside it. That overflow is `clip` rather
than `hidden`, because the parked button leaves the capsule's content
permanently wider than its box, and only `hidden` would make that a scroll range
nothing resets. `IconButton` tooltips do not duplicate the button's accessible
name as a second screen-reader description.

A pending stop is also said in words, because the button cannot say it. Stop is
observed at the loop's next safe step boundary — the response in flight and
every tool it already asked for settle first, and
[`workstream-durable-object.md`](workstream-durable-object.md) owns that
contract — so the gap between the click and the run ending is a real wait, over
ten seconds in the production report this came from. While a live run carries
`stopRequested`, the dock draws a stopping row as the first cell of the composer
stack, taking the field's width and the stack's own gap.
`conversationShowsStoppingRow` is that condition, gated on a running status
rather than on the flag alone: the loop clears `stop_requested_at` as it goes
idle, and a settled run read back before the next snapshot would otherwise
promise a wait that is over. One exported sentence, `STOPPING_LABEL`, is shared
with the Stop button's tooltip. The row carries no elapsed number, since the
only number worth printing is how much longer and nothing on this side knows it.

**The dock, not the transcript's activity slot, and that is the point.** The
slot sits inside `.transcript-scroll`, which hands the viewport to the reader
the moment they scroll up and never takes it back — pressing Stop does not
restore following, correctly, since only the reader's own scrolling may move the
viewport. A row appended to the feed therefore lands below the fold for exactly
the person most likely to be reading history while a run is going, leaving them
the button spinner and nothing else. Measured at the top of a padded transcript,
the feed row sat 1,720px past a 900px viewport. The dock is outside the
scroller, so the acknowledgement holds at any scroll position, and it sits
beside the control it answers rather than among the rows that describe the run.

Whatever the feed is already showing keeps showing, and both are now on screen
together rather than one replacing the other. Usually that is a row still
counting — the ordered transcript's own, or the slot's elapsed total — though a
run whose rows the transcript has not anchored yet and whose timing is null
leaves the feed silent, so the dock's line can be the only thing on screen. The
response really is still settling either way, so silencing a count would move
the overstatement one row down rather than remove it; the dock's line is what
makes the continued counting legible instead of alarming.
`conversationActivityRow` therefore decides only between the two feed rows,
compaction over the elapsed total, and knows nothing about stopping.

**The sentence names the work, not the response.** A step is one accepted model
response plus settlement of every tool call it already emitted, so a tool the
response asked for runs after the response is done — 3.0 seconds of it in the
production run above, with its own activity row appearing in the feed while the
dock's line was up. Copy that named the response promised a boundary that
arrives while the agent is visibly still working, which is the original defect
one level down.

The stop's acknowledgement has two phases, one place, and one component.
`RunStopAcknowledgement` holds the dock from the request onwards and takes
`settled`: before, the orb and "Stopping once the current work finishes…";
after, a filled stop-square in that same 20px slot and "Run stopped". It
answers a button press, so it sits beside the button, and the reasons the
stopping row is in the dock are its reasons too.

**This row is not the record that a stop happened, and must not become one.**
The record already exists and is durable: a stop that interrupts an assistant
turn settles that turn's reservation as stopped, and
`commitAssistantReservationError` writes an `assistant_turn_stopped` status
fact the feed draws as `.assistant-turn-status-pill` — "Response stopped before
it completed" — anchored to the turn it cut off, where it belongs. The sidebar
carries it too, in `statusLabel.stopped`. What the dock adds is the
acknowledgement of the *button press*, for the people who were in the room, and
that is all it adds. The one case neither covers is a stop with no assistant
reservation open — between steps, or while scheduling — which leaves no
turn-anchored marker because there is no turn to anchor one to. Anybody
tempted to add a transcript row for stops should start there, and not by
duplicating the pill.

One component across both phases rather than two sibling slots, because two
would unmount one `role="status"` and mount another, and a live region inserted
together with its content is not reliably announced. The reader that costs is
the one this row is for: somebody who pressed Stop, cannot see the dock, and
now has nothing in the transcript to fall back on either. Mounted once, the
settled line is a content change inside a region that was already there.

It is temporary, and it is session state. `nextStopAcknowledgement` holds the id
of the run whose stop *this client watched settle*, armed by seeing the room's
pending stop while the run was still going. The arming has to survive that wait:
between the request and the settlement the run still reads `running`, so an
arming that cleared itself as soon as it found nothing to acknowledge would be
gone by the time there was something to say — which is how the first version
of this failed, and what the transition's test pins.

Both halves of the state name a run, and neither can be a boolean, because the
two facts do not arrive together: `applyHarnessStatus` clears `stopRequested`
from the status event and leaves `latestHarnessRun` to the canonical snapshot
behind it, so the arm bridges that gap — and an arm not bound to its own run is
inherited by a snapshot that lands already carrying the next one, which then
says "Run stopped" as the settlement of a request nobody made for it.

Two facts decide the phase, and each covers a stretch the other does not. The
conversation's own `harnessStatus` says whether anything is live: `scheduled`,
`running` and `needs_input` withhold the settled line entirely, because the
status event moves first and a held acknowledgement would otherwise sit in the
dock saying the run stopped while the feed above it draws an agent visibly
working. The run row says whether the thing that ended was a stop — and it is
the only thing that says so. **The status frame for a member stop does not
report `stopped`.** `settleWorkstreamState` leaves a stopped run's work stream
`idle` on purpose, because a stop is the member taking the conversation back
rather than an outcome to report, and this client reads `idle` as `completed`.
Driven against the running client, a real stop reports
`status: completed, runStatus: stopped` — so the frame that ends the wait is
indistinguishable from an ordinary finish until the run row behind it arrives.

Two consequences follow, and both were found by driving a stop rather than by
the suite. The arming has to outlive that frame: cleared on it, the
acknowledgement is gone a beat before its own evidence lands and never appears
at all. And the region has to stay mounted across it, still saying the wait is
on, because it is: with nothing to draw in that window the dock went blank and
the live region unmounted around the very change it exists to announce.

It ends three ways: the run the arm names settles as something other than a
stop, the latest run becomes a different one, or this reader sends their next
message, which answers the button press more completely than the row does and
is the one that covers a turn starting no run. That last one is cleared when
the send is accepted rather than when it is attempted: a send that fails
restores the draft and did not move the conversation on, and nothing could put
the acknowledgement back, the latest run being durably stopped already.

Nothing durable records that the acknowledgement was shown, so opening the
conversation later shows the transcript and no notice. The run row cannot stand
in for it: `latestHarnessRun.status` is permanent, it only moves when a new run
exists, and a member turn the addressing classifier reads as conversation
between people starts no run at all
([`agent-harness.md`](agent-harness.md)) — so a notice read off the row alone
outlived its moment and sat under every later message in a multi-person room.

The stopped prompt remains transcript history; continuing means composing a
fresh turn, not replaying the stopped request. Failed runs are the deliberate
opposite and stay in the feed with their Retry action: a failure is something
that happened to the reader and has to survive a reload for them to act on,
where a stop is something they did and a person who was not there has no button
press to have answered.

The composer's width is the conversation's, not the pane's, and it is one width
across every surface that has a composer. A turn is capped at `--turn-width-cap`
(640px, in `app.css`), except Rally's turns at 640px and narrower, which fill
the column; `--composer-width` is three quarters of that, and the
field is centred on it, so the field and the bubbles it produces read as one
column rather than as a full-width row under a narrow transcript. Four rules read
that property: the composer stack under `.has-message-capsule` — which is the
settled conversation, the new-substream dock and the Channel, because a
launcher is a conversation that has not happened yet — plus the two rows a launcher stacks over its field, the
substream banner and the participant chips, which are centred siblings of the
stack rather than children of it and so each state the measure for themselves.
The draft moves from a launcher to the conversation on one keystroke without the
element unmounting, so a width that differs across that handoff is a width that
moves under the person typing. The cap is declared once for the same reason in
the other direction: the composer cannot read it off the turns, sitting as it
does outside the scroller, in a box the transcript column's percentages never
reach.

Below a 600px pane the field gives the inset up and takes the whole row inside
the dock's gutters, and those two rows come with it. The dock is an inline-size
container named `composer-dock`, so that threshold follows the *pane*, which
narrows when the sidebar is dragged wider or a pane opens beside it, where a viewport
media query would have answered for a width nobody is looking at. A size query
measures the container's content box, so the number in the query is that pane
width less a dock's two 16px gutters. Every dock states the same gutter, because
a dock that states a different one crosses at a different *pane* — and a launcher
that crosses somewhere else puts the width change back into the hand-off, in a
band of pane widths either side of the threshold. No automated test
holds the threshold and every dock's gutter to that one sum; verify them in a
real window.

The feed's vertical rhythm is one primitive: a row owns the space above it,
chosen by what precedes it, and no row sets a bottom margin. `MessageFeed`
decides the gap from the message list (`feedRowGap`, over `feedRowKind`) and
stamps it on `.virtual-message-row` as `data-row-gap`; `app.css` keys the
margin on that attribute. It cannot come from a sibling: the feed is windowed,
so the first mounted row has no previous sibling whatever its index. Each row
is `flow-root`, so the margin is inside the row's border box and the
virtualizer measures it. A turn is a person's `.message-block` (a text turn,
an answered elicitation), an answer is Rally's, and everything else (a tool
row, a timing row, the work accordion, a system note, a status pill, the
proposal card, an open elicitation, the oversized-message placeholder) is an
event; index 0 owns no space, and a row after a stretch this client has not
loaded takes the seam gap whatever its kind, because nothing else marks the
seam. The two launch
surfaces draw the same rows outside the feed wrapper and state the same gaps
for themselves on `.launch-arrival` and the branch context, because a base
rule gives a row no margin of its own. Five cases cover the feed: turn after turn takes
`sys.space.stack.gap`, a turn beside an event in either direction takes
`sys.space.block.gap`, event after event takes `sys.space.event.gap`,
Rally's answer after the work that produced it also takes `sys.space.event.gap`,
because it is the same turn finishing rather than a new one, and a row after an
unloaded stretch takes `sys.space.seam.gap`, the widest, whatever its kind. The surface's own
trailing rows, the live timer and the failure notice, take `sys.space.block.gap`
above them for the same reason. Turn after turn is one unit, and what keeps the
next turn off a bubble is the action slot every person's turn lays out under
itself, painted on hover and held at its height where the surface has no
control to put in it; Rally's answer carries its own row once it has settled. Every other margin, padding and gap in the feed
is a step of the `--space-N` scale `app.css` derives from `ref.space.unit`; a
value off that scale is either a sub-unit optical nudge inside an inline
control or a bleed derived from something else, and says which in a comment.

Sharing stops at product semantics. Work streams retain participants, unread,
resource, run, and steering controls. The in-flight pending queue is one of
those: it attaches to the work-stream composer, not to the shared
`ComposerInput`. An answer to a question is not one of its rows. It is admitted
as a pending input like any message, but it is projected as the answered
question — the same UI identity the canonical turn will carry — so the card
closes the moment the room accepts it, and it neither draws a queue row nor
takes part in a reorder. An automation's page keeps its lifecycle controls (apply,
pause, resume, delete, run now, the run-history dialog) outside the feed rather than
inside it. Neither host may smuggle those controls through an optional common
prop.

The work-stream host passes no `renderSidebar`. What the Channel rail held now
lives in the Channel's title-pill menu: its Space, people, Sidekicks, artifacts,
actions and Breakouts. Each conversation's header is a `TitlePillHeader` that
the host renders through `renderHeader`, and the header context carries
`openArtifact` for the menu's artifact rows. A Channel's Main surface also takes
`breakouts`, `openBreakoutId` and `onOpenBreakout`, and from them draws the
chips under each origin turn and the tick bar along its edge. `scrollToTurn`
asks it to bring a turn into view, and `honorsSearchTarget` says whether
`?turn=&sequence=` names this conversation. The right panel is scoped to the
conversation, not the Channel, because a Channel and its open Breakout are
mounted together. [`desktop-shell.md`](desktop-shell.md) owns the panes, the
pills and that scope. `renderSidebar` (and its `renderOpeningSidebar`
placeholder) remains on the surface, but no host passes it.

The sidebar never ends a line it cannot fit with an ellipsis or a hard cut: the
line fades out. `@keyframes clipped-line-fade` in `app.css` carries a
`mask-image` whose last 24px go to transparent, and the rule under it lists
every line the sidebar clips — a row title, the flex line a title shares with
an activity hint, a Sidekick tile's caption, and the account row's name and
address. A mask rather than
a gradient painted over the line, because each of those rows has an idle, a
hover and a current fill and an overlay matched to one shows as a bar in the
other two.

The same 24px mask sits on the sidebar's own scroller, `.sidebar-scroll`, on
the block axis. A list that overflows fades the edge items are disappearing
into, and only that edge — the far edge at rest, both once the scroller has
moved, the near edge when it can go no further. A list that fits has no
timeline and therefore no mask, so the first and last items stay at full ink.
The near and far lengths are registered custom properties driven by two ranged
scroll animations rather than one interpolating gradient, because blending a
three-stop far-fade into a three-stop near-fade does not produce both fades in
the middle. Those two animations are clocks, so the global reduced-motion kill
switch would pin them at their 100% keyframes; their durations stay `auto`
under that preference, restored next to the kill switch, because a fade that
says "there is more this way" is not motion. The mask does not spare a focus
ring, so the same 24px is `scroll-padding` on each scroller: Tab and the sidebar's
own `scrollIntoView({ block: 'nearest' })` would otherwise park a row flush
with the faded edge.

The fade appears only where something is actually clipped, and nothing measures
anything to decide that. The mask rides a scroll-driven animation whose timeline
is the line's own inline scroller: a line whose text fits is not scrollable, its
timeline is inactive, and an animation on an inactive timeline contributes
nothing — so a title ending a few pixels short of the edge keeps its last
characters at full ink, which an unconditional mask would fade for no reason.
Renaming a row or dragging either sidebar re-decides on its own.
The keyframe holds one value at both ends because nothing is meant to move; the
timeline is being asked a question about overflow, not used as a clock, and the
fill mode is what keeps the mask applied for the reader whose reduced-motion
preference forces every animation to 0.001ms. The scroll-edge cover uses the
same fill; its start and end lengths cannot, and are the exception the kill
switch carves out.

Both longhands sit below the `animation` shorthand, which resets both of them,
and no automated test covers their *positions*; verify the result in a real window.
Duration is the milder of the two: the shorthand puts it back to `0s`.
`animation-timeline` is the one that costs the condition — reinstated above the
shorthand it falls back to the document's timeline, `auto` computes to `0s`
against that, the fill holds the 100% keyframe from the first frame, and every
listed line takes the mask whether it clips anything or not. That is the
unconditional fade this arrangement exists to avoid, reachable by a reordering
that looks like tidying, which is why the ordering is pinned and not merely the
three declarations. jsdom lays nothing out, so no component test sees any of it.

The global navigation is one sidebar that resizes and never collapses: both
apps mount `ResizableSidebar` with `collapsible={false}` and `compact={false}`.
The compact 96px rail, its ⌘B and double-click collapse, and the per-Channel
work-stream sidebar with its own compact layout were removed with the shell
redesign; what that sidebar held now lives in the title pill menus
([`desktop-shell.md`](desktop-shell.md)). The primitive still carries its
compact layout (`--sidebar-compact`, `--sidebar-layout-motion`), which no app
turns on.

Both resize handles say what they are. A grip carries no words, so each is
wrapped in `DragHint` (`packages/ui/src/components/primitives.tsx`): a `Tip`
whose trigger is the handle's whole pointer target rather than the pill drawn
inside it, so the hint and the pill appear for the same approach, and whose
content is centre-aligned, which lands it beside the pill without either side
measuring the other. Its two lines are the citation popover's two lines: the
subordinate one is dimmed to 0.72 and left at the tooltip's own size. The
navigation's hint names the drag alone, since there is nothing to collapse. The
right sidebar's handle (`RailResizeHandle`) adds a second line: its
double-click, and its `Enter` — the hint opens on focus as well as hover, so
its likeliest reader is one who cannot double-click — restore
`DEFAULT_RAIL_WIDTH` through the same clamp the drag uses, so a window whose
derived maximum is under that width resets to the maximum instead. A panel
opens wider than that, at an even split with the conversation
([`desktop-layout.md`](desktop-layout.md)); the reset is the way back to a
narrow one. The key is
the only keyboard route to that width: the arrows step by a fixed amount.

The route host, not the feed, owns identity transitions. A new work stream
begins with local composer keys; after durable admission its adapter rekeys
text/files and adopts the server identity without remounting the conversation
family. A new automation is created by `POST /automations` before its
conversation is opened, so its page starts on a durable id. Socket snapshots remain authoritative after reconnect;
local optimistic rows are reconciled by stable client turn IDs.

Delivered attachments follow the message body and precede its action row. A
person's turn still in flight (`deliveryState: 'sending'`) is that same row at
0.82 opacity with a light sweeping across each surface it draws — the bubble,
and each attachment image cell, media tile and file card — painted by
`app.css` under `.human-message.is-sending` as an overlay that inherits the
surface's corner, in a twentieth of the surface's own ink so it shows on a dark
or profile-coloured bubble as well as on a light card. The sweep is keyed on a
selector list naming those four surfaces, once in the animated rule and once in
its reduced-motion twin, and no automated test pins both: a new attachment
surface has to be added to both lists, or a send made of that attachment alone
goes out with no in-flight cue. Every
turn's identity line is `MessageByline`, one component for the assistant's turn,
a colleague's, the reader's own and a settled elicitation answer, so the name and
the time carry one size and one pair of greys whoever is speaking; what tells
speakers apart is the accent on the dot. The line reads outward from the edge the
turn is aligned to — name first on the leading edge, name last on the trailing
one — laid out in markup rather than by CSS ordering, so a screen reader
announces what a sighted reader sees. The username ends at the bubble-radius
inset, and the person dot travels inside it. The time is `RelativeTime`, which
stays current as now moves and names the exact local time on hover;
[`relative-time.md`](relative-time.md) owns it and the clock behind it.

The assistant turn is the leading-edge case: the author name (`Rally`, or
`Automation` on an automation turn), an optional context label, the time, an
optional work summary. Section controls live beside each heading in the body.
The byline starts on
the same vertical as the response body and the action row beneath it: the turn
has no avatar, so nothing sits left of the name and nothing reserves space for
one.

Finished assistant turns also share the action row. Copy and export remain
local actions; **Speak** uses the regional authenticated stream documented in
[`message-speech.md`](message-speech.md) and receives the complete stored
markdown even when the shared renderer has collapsed its sections. The same
Speak / Stop speaking toggle is on the message-text context menu of a
*settled* assistant turn, riding the same one-voice provider so a menu Speak
and a row Speak cannot overlap. A human body's menu also offers Speak, named
*Speak* rather than *Speak response*, because those words are not a Rally
response.
**New substream** closes that row, and every settled human turn — the reader's own and
a colleague's alike — carries the same control alone in a row beneath its bubble,
inset by the bubble's corner so it ends on the same vertical as the identity line
above it. A settled turn carrying
attachments and no prose still shows the row, holding the cutoff alone: copy,
speech and the exports each act on the response text and are withheld when there
is none. Both placements are described in
[`substream-creation.md`](substream-creation.md). The row owns the hover fade —
a control inside it must not carry its own — and both rows share one set of
button metrics, because the same control appears in each. The corner is
`--turn-bubble-radius`, set on the human turn and read by the bubble, the header
and the action row: a theme that wants a different corner restates the token, not
the corner.

Every control in either row states one sentence — *Copy response*, *Save
response as a PDF* — and `MessageAction` makes that sentence both the button's
accessible name and the tip it opens under itself, out of one string: a row
whose visible labels are a word each cannot grow a control that explains itself
to one reader and not the other. The name is the sentence in every state, which
is why a failed export reads **PDF failed** on screen while still answering to
*Save response as a PDF* — the one place on the row where the name does not
contain the visible words, and the cost of a name that stays findable while the
label moves.

Each row is one `TipGroup`, so the first explanation waits out the shared delay
and the rest of the row opens immediately; the group carries Radix's provider
with it, so a turn explains itself wherever it is rendered rather than only
under a host that mounts one.

Assistant H2 sections use the shared inline Markdown renderer. There is no
heading-generated card deck or paged document reader.

A conversation whose caches were seeded from the local cache renders under a
`ConnectingCard` in a sticky slot at the top of the transcript scroller, and
its composer takes `sendBlocked`: typing, mentions, attachments, and the draft
work, sending is disabled, Enter is swallowed the way it is for an empty
draft, and the card's second line says sending is available once Rally
connects, since the capsule composer hides its footer hint.
The surface reads the feed-source entry as `feedFromLocalCache`; while it is
set, range loads, **Jump to latest**, the search jump, and read
acknowledgements wait as they do for a reconnecting socket, because each
reads against the room's fence and a seed has none. The gate lifts when the
live snapshot lands, not when the socket opens. [`local-cache.md`](local-cache.md)
owns the seed, the card, and what waits on the live frame.

## Dictation capture and connection startup

`lib/use-realtime-dictation.ts` owns microphone capture for the shared composer
and also serves meeting recording. A press starts three things at once and none
of them waits for another: the audio inputs (`getUserMedia`, plus the native tap
when computer audio is requested), the capture graph, and the socket ticket with
the transcription socket behind it. The 24 kHz PCM16 worklet's `AudioContext` is
created inside the press with `sinkId: { type: 'none' }`, so no output device is
opened, and its module loads while the microphone is still opening; the worklet
node itself is built only when the inputs attach, because Chromium renders an
`AudioWorkletNode` with an unconnected output as an automatic-pull node and a
node built early would fill the backlog with silence for as long as a
permission prompt stays up. The context is never suspended or resumed, and
stopping never waits for the module: a stalled fetch must not hold the
microphone or the socket. The socket is opened the moment the ticket lands, so the Worker's
upgrade, the WorkspaceDO admission and Azure's session acknowledgement overlap
the microphone opening rather than follow it. `listening` means local capture is
running; it does not wait for the ticket or the provider's session
acknowledgement, and the microphone is the only thing it waits for. OS
permission and device startup remain prerequisites for capture.

The press itself is answered before any of that. The microphone control takes
`is-arming` while the hook is `requesting` (an arc in the button's own ink
turning around the microphone glyph, over the composer shape's resting paint,
with nothing on the control red) and `is-listening` once capture runs (the full
danger fill, the only red the control ever wears). The two are kept apart
deliberately: red means audio is being captured and saved, and a word spoken
into the arming state is one the person was never told was heard. Red does not
wait for the transcription socket: `listening` is entered when the capture graph
is running and buffering, whether or not the provider has acknowledged the
session yet, and any audio buffered before it has drains in order once it has.
While listening, the worklet reports each chunk's RMS beside its samples and the hook
maps it to a 0 to 1 meter position (`meterLevel`: a dB scale whose floor,
-50 dBFS, is where suppressed room noise sits, with speech under automatic gain
control reading around 0.6); the composer writes it onto the control as
`--dictation-level`, outside React, and the stylesheet draws it as a ring
around the button.

The transcript lands in the same field a person types into, and the field
treats it the way it treats typing: it grows with the text up to the composer's
height limit and scrolls past it. The browser only keeps a caret in view, never
a value it was handed, so each transcript update also asks the field to show
its tail once it has taken its new height, on the render that carries the new
value and again a frame later when the capsule's height animation has settled;
the mention highlight layer follows the same scroll. The newest words are
therefore always the ones on screen while dictation runs.

A pointer or focus reaching the microphone calls `prefetch`, which asks the API
client for a ticket ahead of the press (`prefetchTranscriptionSocketTicket`).
The client hands that ticket to the next `getTranscriptionSocketTicket` once,
and only while the hook's whole 10-second connection budget still fits inside
the ticket's `TRANSCRIPTION_TICKET_LIFETIME_SECONDS` life; a prefetch that
failed falls back to a fresh request, and an unused ticket simply expires.

Each attempt records a device-local `dictation_start` performance trace through
`perf-trace.ts`: `inputs`, `capture`, `session` and `backlog` are the waits the
recording passed through in series, and `captureGraphMs`, `socketTicketMs` and
`sessionReadyMs` say when each parallel branch finished, so the line names the
critical path. It prints through `logDebug` and is not reported to telemetry;
[`performance-tracing.md`](performance-tracing.md#the-desktop-half) has why.

`lib/realtime-audio-sender.ts` owns one ordered PCM queue for startup, live
capture, and the worklet's final partial frame. Nothing leaves it before the
provider acknowledges its session configuration. Its first batch after an idle
interval leaves immediately; subsequent batches are at least 100 ms apart,
combining queued samples into messages within the shared 256,000-character frame
bound. A full batch holds roughly four seconds of PCM, so delayed audio catches
up at about 40 times real time without resampling or dropping samples. The
cadence batches transport work independently of the audio sample rate, using a
monotonic clock so system-clock adjustments cannot postpone queued audio.
Azure's [audio-buffer API](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/realtime-audio-reference-ga#input_audio_bufferappend)
accepts buffered bytes; Rally disables server VAD and commits explicitly.
Faster transport preserves the audio signal, though equivalent model accuracy
is an inference from that contract, not a measured provider guarantee.

The existing 4 MiB transport buffer budget includes both queued audio's eventual
serialized size and the WebSocket's buffered bytes. A batch waits when the socket
has no room; capture fails with the existing network-backpressure error only
when accepting another chunk would exceed that byte budget. This bounds retained
payloads rather than inferring excessive audio from delivery timing. Attempt
cleanup cancels its timer, clears queued PCM, and rejects pending drains.

Stop during capture flushes the final partial frame, waits for connection
readiness, and drains the sender before committing. Segment commits also drain
accepted audio before their commit, preserving the same order during an ongoing
recording. Stop before capture starts cancels setup. Failure or unmount stops the
inputs; late setup results cannot revive an older attempt. The existing
10-second connection budget starts with local capture and covers the pending
ticket, provider acknowledgement, and startup drain. Permission prompts do not
consume that budget. The existing 60-second finalization budget covers the final
audio drain and provider completion together, so a socket that stays open without
draining cannot leave Stop pending forever. A drain timeout names the unsent
audio; a timeout after commit names the missing transcript. The frame-size bound
and transport cadence live in `@rally/contracts/realtime-transcription`. Audio is
not persisted to disk.

A failed recording leaves its recovered text in the draft and shows its error
until the person starts another recording, edits the field, or explicitly sends
the draft. Editing and sending acknowledge the failed attempt through the hook's
`clearError`, returning it to idle without starting capture or changing the
draft. A failure alone never sends the partial transcript, and message-delivery
errors remain owned by the host.

While dictation is running the composer's text belongs to it: the field is
read-only and the mention and device controls are disabled. Send is not on that
list. Pressing it, or Enter, stops dictation and sends the transcript once it
settles, tail included — the composer submits from an effect keyed on the
settled state rather than from the click handler, because the final transcript
arrives through `onValueChange` and the host's submit closure only carries it on
the render after that.

Stopping is reachable even while the draft is empty. It has to be: the field
holds nothing until the first partial arrives, and on a provider that returns
text only at the final commit it holds nothing for the whole recording, so
guarding Send on `submitDisabled` first would lock it in exactly the case the
recording holds the most. `submit` therefore takes the dictation branch before
that guard, and the effect applies the guard afterwards, against the draft the
transcript produced. A silent recording ends in the hook's "No speech was
detected" error rather than an empty transcript; either way a dictation error
ends the attempt without sending, and the draft and the error stay on screen.

## Testing

Shared components have fixture-level component tests for settled, streaming,
failed, elicitation, attachment, tool, follow, and paging states. Each screen
adapter separately proves its controls and identity transition.
`workstream.test.tsx` holds both the dock's stopping condition — a live run
only, so neither a settled run's stale `stopRequested` nor an absent one
acknowledges a wait that is over — and the feed slot's own order, compaction
over the elapsed total, and neither once the ordered transcript draws the run's
rows. Those are decisions in isolation, and a decision agreeing with itself is
not the behaviour: `workstream-open.test.tsx` renders the whole screen over a
running, stop-requested detail and asserts the row is in `.composer-dock` and
not in `.transcript-scroll`. Assert the box, not only the sentence — the text
alone passes just as well in the scroller that hides it from a reader who has
scrolled up, which is the defect that shipped to review. Any visible
change also requires a real Electron-window check because DOM assertions cannot
prove layout, focus, scroll position, or overlap.

## Slow model notice

The shared work-stream and Sidekick conversation surface shows an inline status
beside active response activity while the socket reports a delayed inference
belonging to the displayed running harness run: “The model is currently slowed
down. Responses might take longer.” It uses the semantic warning colour and
`role="status"`. It is not a transcript message and has no retained exit
animation. First output, inference settlement, terminal run status, or a
conversation change clears it immediately. Tool work and inter-chunk pauses
do not create a warning. Multiple delayed calls share one notice until the last
relevant delay clears. The workspace-scoped resume registry retains the delay set
alongside its socket sequence, so revisiting a conversation can resume after the
activation event without losing the warning; later clears replace that retained set.

### Artifact annotation drafts

Each conversation surface owns an in-memory annotation provider keyed by parent
and breakout. Preview hosts hand Comment mode to the panel header, immediately
before the always-visible Expand control. Composer chips and feed excerpts share
that provider and canonical structured content. Only accepted sends clear the
captured pin IDs. A breakout launcher opts out of its parent's draft so it cannot
consume unrelated pins. [Artifact annotations](artifact-annotations.md) owns the
selection and message protocol.

## Changelog

### 2026-10-21 — Deliver dictation independently of arrival timing

**What changed:** The proxy no longer disconnects on the 31st message in a
one-second window. One sender batches startup, live, and final PCM in order,
within the existing frame-size bound, using monotonic time for the existing
100 ms transport cadence. The existing 4 MiB byte budget now accounts for queued
payloads as well as WebSocket bytes;
Stop and segment commits drain accepted audio before committing, within the
existing finalization deadline. Editing or explicitly sending acknowledges a
failed recording's notice without losing its recovered text.

**Why:** A valid recording could be rejected merely because delayed renderer
callbacks or network delivery caught up in a burst. The number 30 had no recorded
resource derivation or provider requirement. Raising it would preserve the same
failure at another arbitrary threshold. Arrival timing is not audio validity;
frame validation, authenticated admission and byte accounting protect their
actual resources. Keeping a separate live send path was rejected because it
bypassed batching and made commit ordering depend on when a chunk arrived.

**Consequences:** Never use this transport cadence as a server admission rule.
Queued PCM must keep its samples and order under steady or delayed delivery, and
no commit may overtake accepted audio. A failed recording must never submit its
partial transcript automatically; the recovered draft remains available and
message-delivery errors stay owned by the host.

### 2026-10-20 — Group mention candidates by conversation membership

**What changed:** The shared picker groups people into Participants, Org members,
and Guests after Rally, with participation taking precedence over guest access.
Search omits empty groups and arrow keys traverse options across headings.
Rows no longer repeat “not participating” beside each email address or show
right-side account-type labels.

**Why:** The flat member-order list mixed people already in the conversation
with people who need adding. Labeled groups make that distinction visible;
removing the eight-result cutoff keeps later groups reachable by scrolling.

### 2026-10-19 — One hover row for every message, Channels included

**What changed:** The three hover rows (Rally's turn, a person's turn, a
merged result) are one exported `MessageActions` with one `.message-actions`
class, and a Channel's own messages and merges now carry it with Copy, Speak,
Image and PDF.

**Why:** Channels had no row at all, and each surface that wanted one would
have rebuilt it a fourth time. The three copies had already drifted: the merge
row in a Thread was classed `.agent-message-actions` inside an article that is
not `.agent-message`, so its hover rule never matched and New breakout and Merge
under a merged result could not be seen. One component and one reveal rule
keyed on the message's container is what stops the next surface from repeating
that.

**Consequences:** A new surface that draws messages renders `MessageActions`
and gets the row; if its container is neither `.message-block` nor
`.channel-feed-item`, add it to the reveal rule rather than writing a second
one. A person's turn in a Thread still passes `textActions={false}`, as before.
A Channel's message copies its stored body, so a typed @name copies as typed,
and passes the text it drew as `rendered`, so the exports keep its mention
chips. It also passes `verbatim`, so its image and PDF keep
the line breaks the feed drew and skip model-text repairs; a host that draws
text verbatim must pass it, or the saved card differs from the screen. In a
Channel the row sits on the message's name · time line (`.channel-feed-byline`)
rather than a line of its own: the row is laid out while hidden, and on its own
line it made every Channel message about 31px taller at rest.

### 2026-10-19 — Share annotation drafts across preview hosts and the composer

**What changed:** The composer owns transient pins across its previews, with editable chips and Comment immediately before Expand.

**Why:** Selections belong to the message being written; per-preview drafts lose comments when the viewer closes.

**Considered and rejected:** Scope changes reset pin state without remounting the conversation, preserving in-flight history.

**Consequences:** Only accepted sends clear their captured pins. Pending annotation sends and open elicitations cannot silently reuse or omit those pins. See [artifact annotations](artifact-annotations.md).

PR #1322; design: `docs/PRDs/2026-10-19_artifact-annotations/prd.md`.



### 2026-10-18 — A long paste attaches as a typed, named file

**What changed:** Text pasted into a composer at or past 5,000 characters
becomes an attachment instead of filling the field. The client uploads it as
plain text and shows a skeleton card; the upload route detects JSON, HTML, XML,
Markdown, TSV or CSV, sets the matching MIME type and extension, and names the
file from its content with the naming model.

**Why:** A pasted document filled the composer, buried whatever the person
meant to say about it, and reached the agent as message text rather than as a
document it can page through and cite. Typing the file keeps the attachment
viewer and the agent's text projection on the right reader. The server does
all of the deciding so there is one implementation of it, which any other
client that uploads a paste gets for free.

**Considered and rejected:** Detecting the type on the client, which showed a
stand-in name and type that changed under the person when the upload
returned; the skeleton claims nothing until the answer is in. Naming the file
on the client before attaching, which leaves the paste showing nothing for the
length of a model call. Renaming the resource after upload, which needs a
rename route and races the send. Asking the model for the type as well as the
name: the heuristics are right for the common cases and cost nothing.

**Consequences:** The 5,000-character threshold and the 8,000-character sample
the model reads are product choices placed here as a starting point; change
them in `pasted-text.ts` and the service. Naming costs about a second before
the attachment is ready to send. The draft cache keeps the paste marker, and
an upload that finds its draft already stored reads the stored resource
rather than describing it from the local file, since the server renamed it.

### 2026-10-17 — Arming turns an arc; red is only for capture that is running

**What changed:** While the hook is `requesting`, the microphone control draws
an arc in the button's own ink turning around the microphone glyph, over the
composer shape's resting paint; the danger wash the arming state wore is gone.
`is-listening` keeps the full danger fill and is now the only state painted
red. It is entered, as before, once the capture graph is buffering audio,
without waiting for the transcription socket.

**Why:** The arming wash is `sys.color.danger.wash`, a dark red in the dark
appearance. A button that turns red on the press says the microphone is on,
and it is not: the inputs are still opening and nothing spoken into that state
is captured. The wash was chosen on 2026-10-16 so the press would read as
acknowledged rather than as loading, which the spinner it replaced had done;
it borrowed the recording colour to do it, and the colour was the stronger
signal. The arc keeps the acknowledgement without the colour.

**Considered and rejected:** The `LoaderCircle` spinner in the glyph's place,
as `transcribing` and `finalizing` use: there the recording is over or paused
and text is awaited, here the microphone itself is opening and the glyph is
what says so. Also rejected: delaying `listening` until the provider
acknowledges the session, so red would mean the service has the audio. Red is
for capture, which starts well before the socket is ready, and the audio in
between is buffered and drained in order.

**Consequences:** A state drawn red on this control is a claim that audio is
being saved. Arming paints no fill, so a composer shape's resting fill excludes
`.is-listening` alone and must not start excluding `.is-arming`; the 2026-10-16
entry's rule that both fills paint alone now holds for `.is-listening` only.

Shipped in #1276.

### 2026-10-16 — Dictation startup overlaps the microphone with everything else

**What changed:** A press starts the inputs, the capture graph and the
ticket-then-socket chain at once, and the recording fill waits only on the
microphone. The control arms on the press before it fills on capture, a level
ring shows audio arriving, the field follows the transcript's tail, hovering
the microphone prefetches the ticket, and a device-local `dictation_start`
trace records the phases. The section above has the mechanics.

**Why:** Three independent costs were paid in series. The worklet module fetch
and the `AudioContext` open ran only after `getUserMedia` resolved; the context
opened an output device nothing played through, then stopped and restarted it
around the module load; and the socket, with the Worker upgrade, the
WorkspaceDO admission and Azure's acknowledgement behind it, began only once
`listening` had been reached. None of that had to wait for the microphone,
which is the one step that does. The spinner shown during `requesting` read as
loading rather than as a press acknowledged, and nothing on the control said
audio was arriving once it was. A transcript longer than the field's height
limit also wrote its newest words below the fold: the field grew and then
scrolled, but a value set from outside never moves a textarea's scroll.

**Considered and rejected:** Holding one warm `AudioContext` and worklet per
renderer across recordings. It removes the graph build from the press
entirely, but the build now overlaps the microphone open and only shows when
that open is faster than a module fetch; the trace will say whether that
happens, and the singleton can follow it. Pre-opening the transcription socket
on hover, so the handshake too would be done by the press: every hover would
reserve a session lease and an Azure connection. Showing the recording fill on
the press: it would promise capture that was not running. Reporting
`dictation_start` to telemetry: the `renderer_perf_flow` event's schema
enumerates its flows and phases, and widening it is its own change.

**Consequences:** A socket can now be open, and its session lease held, while
the attempt is still `requesting`; cancellation and a denied input must close
it, and do, through `cleanupAttempt`, and the lease is held by the proxy for
the open socket rather than by its frames
([`realtime-sockets.md`](realtime-sockets.md#changelog)). The worklet node must
keep being built at attach and never earlier: review of the first cut built it
with the graph and reproduced Chromium pulling the unconnected node, which sent
silence recorded during the permission prompt ahead of the speech. Stopping
must never wait on the module load. The `.is-arming` and `.is-listening` fills
are the only rules that paint the button in those states, so a composer
shape's resting fill must keep excluding both. The prefetched-ticket window is
derived rather than chosen, `TRANSCRIPTION_TICKET_LIFETIME_SECONDS` less the
connection budget, so changing either moves it.

Shipped in #1259.

### 2026-10-13 — The capsule keys on a host class

**What changed:** The capsule rules key on `.has-message-capsule`, which the
thread and Channel roots carry, in place of a list of screens copied into 33
selectors. The Channel composer now wears the capsule.

**Why:** The Channel screen rendered the capsule layout, but `.channel-screen`
was not in the list, so its composer fell back to the toolbar look: a square
box, a visible footer hint and an attachments scrollbar. A list every new host
has to join is how that happened.

**Considered and rejected:** Keying on `.is-message-capsule` alone. Dropping
the scope lowers every rule's specificity by one class, so rules elsewhere that
now lose to the capsule would start winning. One host class keeps it.

Shipped in [#1232](https://github.com/juno-ai-labs/avalon/pull/1232); PRD: [channels and threads navigation](PRDs/2026-10-10_channels-threads-navigation/prd.md).

### 2026-10-13 — Every artifact and attachment opens in the right panel

**What changed:** Every artifact and attachment a conversation opens (a
message or composer attachment, a citation's file, a prior version, a resource
with its actions) lands in its right panel, replacing both lightboxes and the
document-only sidebar. The panel heads itself like a thread pane, its actions in
the title pill's menu, with an Expand that shows the item full-window over it.
Only a resource panel is restored after relaunch; an attachment is a loader
closure with nothing to save.

**Why:** The navigation redesign puts anything opened from a conversation in
the pane beside it (the pane stack), so a person reads it next to the thread
rather than over it. Two modals and a third reading mode were three ways to
show one thing.

**Considered and rejected:** Opening a resource as a plain file preview and
dropping its actions, which would lose versions and archive with no other
route to them. Keeping the gallery's window-wide arrow keys: in a panel the
composer sits beside it, so the arrows act only while focus is in the panel.

**Consequences:** The lightbox remains for surfaces with no conversation panel:
search results and the Channel composer. A new way to open something from a
conversation goes through `openPanel`, not a dialog.

### 2026-10-06 — A tip opens on focus only after a key

**What changed:** `lib/window-activation.ts` records whether the last deliberate
input was a key or a pointer press, and exposes it as `focusFollowsKeyboard`.
`Tip` declines to open on a focus that follows a pointer press. The browser shell
now installs the tracking itself.

**Why:** On a phone-width web window, opening the Sidekicks level of the title
menu moves focus onto Add Sidekick, and its tip, placed to the right of a
full-width row, opened off the edge of the screen. Nobody tabbed there: the focus
was code's, after a tap. The guard that should have caught focus that is not the
person's never ran on the web at all, because the browser mounts `WorkspaceApp`
below the `App` that installs it.

**Considered and rejected:** Placing the tip above or below when neither side
has room, which Radix's tooltip does not expose and which would still show a tip
nobody asked for. Removing this one tip, which leaves every other tip that a
level or a returning dialog focuses with the same defect. `:focus-visible`,
because Chromium drew it on this very focus.

**Consequences:** Hover is unchanged; only focus asks. A pointer user no longer
gets a tip on focus that code moves after their click, which was noise on the
desktop too. A screen reader moves focus without a `keydown`, so after a
click its focus opens no tip until a key is pressed; triggers carry their
`aria-label`, so little is lost. The answer is permissive until the tracking is
installed, so a test mounting one component sees the old behaviour.

Shipped in [#1127](https://github.com/juno-ai-labs/avalon/pull/1127).

### 2026-09-24 — One composer host on every surface

**What changed:** `WorkstreamComposer` takes a `ComposerConversation` (the four
fields it reads) and a `draftKey` instead of a `WorkstreamDetail` and the ids it
built a key from, and gains `ariaLabel` and `onDraftChange`. The new-Channel
launcher now renders it instead of wrapping `ComposerInput` in its own mention
list; the new-breakout dock stops spreading its parent into a fake detail.

**Why:** Only the capsule was shared. The launcher's hand-rolled mention list
had drifted: no `@Rally`, no slash commands, no personal-scope confirmation.
The host needed a real conversation only for four fields and a key, which is
what stopped the launcher from using it.

**Consequences:** A new surface with a composer renders `WorkstreamComposer`
and describes its conversation in those four fields. A field the host starts
reading has to be added to `ComposerConversation`, which every caller then
supplies.

### 2026-09-24 — The stop's acknowledgement leaves the feed

**What changed:** `RunStoppedNotice`, the card the transcript column appended
whenever the latest run's status was `stopped`, is gone. `RunStopAcknowledgement`
holds the dock across both phases and settles the stopping row where it stands,
and `nextStopAcknowledgement` decides when it is drawn: only for a client that
watched that stop settle, and only until the conversation moves on. Its CSS goes with it — the card's rules
are deleted and `.run-stopped-mark` sizes the square to the orb slot it
replaces.

**Why:** the notice was durable chrome for a temporary event, and it was read
off the wrong thing. `latestHarnessRun.status` is permanent and only moves when
a *new run* exists. A member turn the addressing classifier reads as
conversation between people starts no run at all — the decision in
[`agent-harness.md`](agent-harness.md), deliberately invisible in the UI — so in
a room where people are talking to each other the notice sat under every later
message until somebody addressed Rally, which is to say never. What a reader saw
there was a message they had just sent with "This run was stopped by request"
underneath it, and nothing else on screen to read it as. Anchoring it to the
transcript instead would have fixed the ordering and kept the deeper error: a
card in the feed is a historical record, and this is an answer to a button
press, owed to the people who were in the room when it landed and to nobody
else.

**Considered and rejected:** keeping it in the feed and withdrawing it once a
member turn landed after the stop settled — written first, then dropped. It is a
correct rule for the wrong object, and it made the notice's lifetime a question
about turn ordering, which then needs an anchor: timestamps, which an optimistic
turn carries the sender's own clock for, or turn identity, which would have put
`runs.final_turn_id` and `trigger_part_id` on the wire for a banner. Neither
question exists once the acknowledgement stops pretending to be history. Also
rejected: a durable "stop acknowledged" flag on the conversation, which is the
same category error with a migration attached. Also rejected: a timed fade — the
row ends when the conversation moves, which needs no duration, and a duration
here would be a limit picked by whoever typed it rather than by the team
([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).

**Consequences:** no *chrome* in the transcript marks a stop any more. History
is not left silent, which an earlier draft of this entry wrongly claimed and
review corrected: the durable, turn-anchored `assistant_turn_stopped` pill
already ships and is untouched here, so the deletion removes a duplicate rather
than the record. The narrow gap it leaves is a stop taken with no assistant
reservation open, which has no turn to anchor to; closing that is a decision to
make on purpose, and not by adding a second mechanism beside the pill. The acknowledgement does not survive a reload,
which is the point and not a defect to fix. It is armed by the stopping row's
own condition, so a stop that settles before any render shows that row — the
click and the settlement inside one frame — is acknowledged by nothing; the run
is over either way, and the alternative is arming from a durable flag, which is
what this entry removes. A future change to the arming has to keep it alive
across the wait, and bound to the run it was made for: the run reads `running`
for the whole of that wait, so the first version of this cleared the arm on the
same pass that set it and put the row on screen never; the second held it as a
bare boolean, which a snapshot arriving with the *next* run inherits, answering
a button press nobody made for it. The first was caught by driving a real stop
in the client rather than by the suite, and the second by review. Both are now
pinned by the transition's tests and by the rendered case in
`workstream-open.test.tsx`, which drives the status frame and the snapshot as
two steps and fails if the dock stops drawing the row, or draws it in a
different node. Review and the running client between them added the rest in
one round: the conversation's live status withholds the settled line so it
cannot sit beside an agent that is working again, the arming outlives a frame
that cannot say a stop was a stop, and the region is held up through that
window rather than blinking out of existence in it. The failure notice keeps the trailing-row treatment and
the feed's `sys.space.block.gap`, and is now the only thing using it.

### 2026-09-22 — Editable fields get native text actions

**What changed:** Main installs one native context-menu handler for editable
fields in the main, Sidekicks, and settings windows. Message prose and sidebar
rows keep their renderer-owned menus.

**Why:** Electron had spellcheck enabled but supplied no page context menu, so
right-clicking a Channel draft could not offer corrections or editing actions.
The main process receives the spelling suggestions and edit capabilities needed
to build that menu.

**Considered and rejected:** Extending the Radix message menu to editable
fields. That menu is for copying rendered messages and speaking them; duplicating
native editing and spelling behavior there would lose the platform's field
capabilities and blur the boundary between prose and drafts.

**Consequences:** New trusted windows with editable fields need the installer;
future menu changes must leave renderer-owned message and sidebar actions intact
and pass the originating frame and coordinates to native popup actions.

PR [#948](https://github.com/juno-ai-labs/avalon/pull/948).

### 2026-09-21 — Expanded hierarchy headers keep their identity marks

**What changed:** The shared Space and Channel title header now renders its
20px identity mark — the same size used by the conversation header — to the
left of its name while expanded. Compact mode keeps the same mark and hides
only the name, so collapsing a rail no longer swaps between two different
header compositions.

**Why:** The adjacent hierarchy rails named their current Space and Channel but
withheld the visual identity already used by their rows. Keeping the icon in one
stable leading slot makes the header match the navigation object it represents
and lets the expanded and compact states share one composition.

**Considered and rejected:** Adding separate icon markup to the desktop Space
and Channel rails. Both already use `SidebarTitleHeader`, as does the browser
surface, so local copies would let the hierarchy headers drift again.

### 2026-09-21 — Every generated artifact can leave or dock beside the feed

**What changed:** The resource lightbox gives every artifact-direction resource
an **Open in a new window** action, using Tabler's `window-maximize` glyph, and an
**Open in a righthand sidebar** action using `layout-sidebar-right-inactive`.
The sidebar action dismisses the lightbox and
hands the full-bleed document to the shell's resizable right-rail primitive,
whose only chrome is the document title and Close. Live sites still mint a fresh
one-shot navigation and share their per-artifact browser session; generated
files read through the existing authorized preview route and hand those preview
bytes to either the rail reader or the main process, which opens the image,
media, or escaped readable text in an isolated native window. Sources do not
gain either artifact action, and an artifact with no readable content leaves
the corresponding action disabled. All three reading surfaces follow the
resource's canonical `currentVersion`: a mounted lightbox or sidebar re-reads
its preview when that value advances, while the main process records the
version in each detached window and reports stale windows back to the renderer.
The renderer then reads newly authorized preview bytes, or mints a fresh
single-use live-site navigation for each window, and replaces every detached
window for that resource. Closed windows leave the registry and therefore cause
no background content read; navigating the owning conversation closes its
remaining detached windows because that route is also what owns their realtime
subscription. Generated-file refreshes share the inline preview's
`resource_processing` retry contract, and the main process reserves versions
before navigation so two reads that finish out of order cannot move a detached
window back to an older publish. The publishing bridge records the intended
publication event beside the durable resource swap and asks the canonical
conversation object to emit `resource_updated` after a changed file is durable.
Retrying the same publication replays that event, so a crash between the two
authorities cannot leave every open reader permanently on the previous version;
duplicate same-version events are intentionally harmless. For a generated site
it waits until the public artifact pointer also names the
new version, so every reading surface can refresh immediately without racing
the previous site.

**Why:** Opening in a new window lived inside the live-site detail, so it was an accidental
capability of one artifact renderer rather than of artifacts. Images, Markdown,
plain text, PDFs, Office documents, audio, and every later generated-file type
all converge on the authorized preview boundary already; keying the control on
artifact direction makes both affordances follow the product meaning instead of
repeating a file-type allowlist that would immediately drift. Reusing the shell
rail also preserves its one width, feed reflow, responsive cap, keyboard resize,
focus, Escape, and close motion rather than creating a document-only layout
system beside it. Keeping detached-window lifetime in the main process and
content authorization in the renderer preserves the existing boundary while
letting the canonical resource version drive every preview consistently.

**Considered and rejected:** Giving generated files public or directly
navigable API URLs. Their content is workspace-authorized and the preview route
may be a materialized derivative rather than the stored file, so a URL-based
shortcut either loses authorization or creates a second content path. Also
rejected: interpreting generated HTML in the file window. The pop-out treats
all non-media preview bytes as escaped prose under a script-free CSP, preserving
the same trust boundary as the in-product reader.

**Consequences:** `popOutArtifact` now accepts either a site navigation or a
generated preview payload. The shell right rail is active only when a lightbox
hands it an artifact; the retired context-sidebar entry point remains off. New
generated file kinds inherit both actions without a renderer change as long as
the preview route can return readable bytes. A new live executable artifact
still owns its navigation/session minting and must not be routed through the
generated-file payload branch.

### 2026-09-19 — The capsule composer clips rather than hides

**What changed:** The message capsule takes `overflow: clip` in place of
`overflow: hidden`. Nothing else moved, and nothing paints differently: a
control parked outside the rounded corner is cut at the same pixel by either.

**Why:** `hidden` is a scroll container and `clip` is not, and two things inside
this capsule are deliberately outside its box. Stop parks past the right edge so
it can slide in, which leaves a scroll range standing at all times — 56px when
this was measured on the running client — and `ComposerInput` translates the
input shell by the leading column's width for 220ms whenever a draft flips to
the wrapped layout, which adds that column's width to the range for the length
of the animation. Nothing in the renderer reads or resets the capsule's scroll
position, so a capsule scrolled once stayed scrolled: the report this came from
was a draft sitting permanently to the left of its own field, first characters
and model pill alike — the pill is outside the translated shell, which is what
identified the capsule's own scroll offset rather than a stuck animation. A clipped box has no scroll position to strand,
whatever scrolled it.

**Considered and rejected:** Resetting `scrollLeft` when the flip animation
finishes. It is a second mechanism that has to stay correct as the animation
changes, it only covers the window it was written for, and it leaves the
standing range behind Stop scrollable at every other moment. Also rejected:
keeping the parked control inside the box and revealing it by width alone — the
slide through the clipped corner is the treatment, and the clip is what it
slides through.

**Consequences:** The capsule can never hold a horizontal scroll offset, which
is what the parked-control treatment assumed all along. A future control that
needs a scrollbar inside the composer cannot get one by restoring `hidden`: the
field is the scroller and states its own gutter. Changing the value to `visible`
is not a no-op either — the parked Stop would then be drawn outside the capsule.

An engine that cannot parse `clip` is the gentler case, and the reason the base
`.workstream-composer` rule deliberately keeps `overflow: hidden`: the
declaration is dropped at parse time and the cascade falls back to that rule, so
such an engine gets the old behavior, bug included, rather than `visible` with
Stop outside the box. That rule is also not an untreated instance of this bug —
it dresses the toolbar layout, which has no parked control and no flip translate
to put anything outside its box. Give that layout a parked accessory and this
decision has to be made there too.

`app.css.node.test.ts` holds the invariant rather than the declaration: no rule
whose subject is the capsule may settle any scrolling `overflow`, so a later
`@container` or theme rule restating `hidden`, or a longhand `overflow-x` after
the shorthand, fails the same way the original would have.

### 2026-09-18 — Conversation controls own failure language

**What changed:** Transcript paging, message sending, participant changes,
resource attachment, title renaming, conversation sharing, elicitation replies,
and Sidekick-draft acceptance now map rejected operations to stable Rally copy
before rendering. A failed draft acceptance is keyed to its automation id, so
other proposal cards remain healthy. The participant and resource dialogs
accept closed failure states rather than exception strings. Persisted run
failure records remain the explicit exception: their notice intentionally shows
the stored support message beside its code and request id.

**Why:** The conversation adapter supplies several dialogs and persistent
controls next to the rails. Guarding only components whose filenames contained
`sidebar` or `rail` left those adjacent paths able to render a router or provider
sentence for the same failed action.

**Considered and rejected:** Treating the adapter as transport code. It chooses
which product state each control renders, so moving the strings elsewhere would
hide rather than close the boundary.

**Consequences:** New operation failures on this surface need a semantic state
and authored recovery copy. A diagnostic needed for support stays in telemetry,
except for the archived run-result contract described above.

### 2026-09-16 — Message text has a Radix right-click menu, including Speak

**What changed:** Right-clicking assistant or human message prose in the feed
opens the same Radix menu the sidebars use. The items are Copy (rendered
HTML and plain text of the selection, or the whole body), Copy as markdown
(the stored source the action-row Copy already writes), Speak / Stop speaking
through the existing speech provider on a settled turn, then on macOS Look Up
and Share. Writing Tools and Services are not offered. Glance, still,
inspector, and lightbox bodies are unchanged. Whole-body Copy keeps citation
chip labels and drops only chrome marked `data-clipboard-exclude`. Share
sends rendered plain text. A streaming assistant body has no Speak item. A
human body's Speak answers to *Speak*, not *Speak response*. macOS Share
pops `ShareMenu` directly.

**Why:** Electron does not ship a page context menu, so selecting a sentence
and right-clicking it did nothing. The native Chromium menu would have brought
Writing Tools and Services we do not want, and OS Speech instead of Rally's
voice. The action row's Copy is markdown source, which is the wrong paste
into a rich editor. Stripping every `button` from the clone deleted the
model's own citation words; `innerText` on a detached clone has no line
breaks; falling back to stored markdown for Share put `**bold**` in Messages;
Speak during a stream would voice a truncated snapshot; *Speak response* on
a person's own turn is the action-row sentence for the assistant.

**Considered and rejected:** A native Electron `Menu.popup` built from
`webContents` `context-menu` params. Once Writing Tools and Services were
dropped, the remaining items belong in the Radix menu every other Rally
right-click already uses. Also rejected: calling Electron `startSpeaking` /
OS Speech; Speak has to be the same toggle and the same one-voice mutex as
the action row, or two clips play over each other. Also rejected: wrapping
share in a `Menu` whose only item is `role: 'shareMenu'`, which opens a
second-level Share before the sheet.

**Consequences:** Formatted Copy writes `ClipboardItem` from the renderer so
it can carry HTML and is not bound by `system:copy-text`'s 4,000-character
cap, which exists for short identifiers. Look Up restores the snapshot
selection before `showDefinitionForSelection`; Share passes the selected or
whole-message plain text to `ShareMenu`. Off macOS, and in the browser
fallback, those two items are absent. Code-block copy controls and heading
chevrons have to carry `data-clipboard-exclude` or they paste as chrome.

### 2026-09-16 — A rail fades the items it clips, and only the edge that is clipping them

**What changed:** The work-stream list, the work-stream sidebar, and the Sidekick
strip now fade items at a scroll edge the same 24px way a clipped row title
fades, and only while that edge is actually clipping something. A scroller
whose content fits stays sharp; a scroller at rest fades only its far edge; a
scroller in the middle fades both; a scroller that can go no further fades only
the near edge.

**Why:** The line fade made a hard cut on a row title look like a rendering
fault, and the same cut was still sitting on the rails' own scrollports —
work streams disappearing under the command bar, Sidekick tiles sliced at the
sidebar's trailing edge. An unconditional mask would have faded the first and
last items of a short list for no reason, which is the case the line fade
already refuses.

**Considered and rejected:** One animation interpolating a three-stop far-fade
into a three-stop near-fade. The shared stop travels through the scroller and
the list looks washed out in the middle; registered lengths that grow and
shrink over the first and last 24px of travel keep the middle items at full
ink. Also rejected: measuring overflow in the component. The inactive-timeline
condition is the same question the line fade already asks, and a
`ResizeObserver` on these lists would sit next to their existing motion
choreography.

**Consequences:** The cover animation is the overflow question and must keep
one mask at both keyframes. The start and end animations are clocks, so their
`animation-duration: auto` has to win against the global reduced-motion kill
switch — that restore is load-bearing, and deleting it pins every overflowing
list to a leading fade and no trailing one. `animation-range` joins
`animation-duration` and `animation-timeline` below the shorthand; a reorder
that looks like tidying reintroduces an unconditional fade. Do not paint a
gradient over the scroller: these rows carry three fills, and an overlay
matched to one is a bar in the other two. `scroll-padding` of the same 24px
keeps a focused row out of the mask band; without it, Tab and
`scrollIntoView({ block: 'nearest' })` fade the indicator they just scrolled
into view.

Shipped in #803.

### 2026-09-15 — The participant dialog stays open across roster changes

**What changed:** Adding a person no longer closes `AddParticipantDialog`. The
dialog stays up after each add or remove so another membership can be changed
without reopening. It still closes on click-outside, Escape, the header close
control, and when the current person removes themselves — including from a
workspace-scoped Main, where they remain a viewer. Leave-room navigation still
only happens for a substream or a personal Main. A click on a portaled
`.menu-content` — the Remove control — is not treated as outside the dialog.

**Why:** The dialog is the roster, not a single-shot add. Closing it on the
first successful add made adding two people two trips through the facepile, and
a Remove click on the portaled menu dismissed it the same way a click on the
overlay does. That accidental dismissal was also the only thing closing the
dialog after a workspace-scoped self-removal, so the menu exception had to be
paired with an explicit close on every self-removal.

**Considered and rejected:** A Done footer like the new-work-stream picker.
Click-outside is already the dismissal, and a second confirmation would make
the live add/remove path look like a draft. Closing only on add and not on
remove would still interrupt the same sitting.

### 2026-09-14 — Show slow inference as temporary response status

A model may need longer than the old first-token deadline. The user requested
an inline explanation after 30 seconds, present only during that wait. The
surface consumes attempt-scoped server status rather than timing the whole run,
so tool work cannot look like model slowness and a completed warning does not
linger through an exit animation. Delay state travels with retained resume cursors
because replay cannot reconstruct an activation older than the retained sequence.

### 2026-09-14 — An admitted answer closes its question before the loop promotes it

**What changed:** `pendingTranscriptInputOverlay` projects a pending input whose
`messageType` is `elicitation` as the answered question rather than as text: it
takes the question's UI identity (`elicitationMessageId`), carries the parsed
elicitation, and has no delivery state, so `isComposerQueueOverlay` and
`pendingOverlayInputId` both leave it out of the composer queue.
`composeTranscript` then folds it into the canonical question row it answers,
so the two are one row at the question's position.

**Why:** the card is drawn from the canonical elicitation turn, and that turn
carries the status frozen at `open` — only the answer's own turn ever replaces
it. Until the loop promotes the answer there is no such turn, so the optimistic
"answered" the screen writes on submit survived exactly until the next snapshot
and then the question came back, over the answer the person had just given. The
answer meanwhile sat on the composer as a row with no text, rendered as
"Queued message", because an elicitation response has an empty text block.
Neither was a rare window: the loop only promotes the answer when it next runs.

**Considered and rejected:** holding the optimistic answered state across
snapshots on the client. That is a second source of truth for a question's
status, kept alive by the screen, and it would have to be torn down correctly on
a failure, a reconnect, and a second answer from another participant — while the
room already sends everything needed to say so honestly. Filtering empty pending
inputs out of the queue: that hides the symptom and leaves the question asking.

**Consequences:** the feed is *composed*, not upserted, and the two paths
reconcile differently. `composeTranscript` drops an overlay only when its
identity already has a canonical row, and an answer is keyed by its own client
message while the question is keyed by the question — so review caught both
being emitted under one message id, the question drawn twice and a duplicate
React key. `composeTranscript` now folds the answer's status into the canonical
question row and takes the overlay out, which is the same "one row, at the
question's position" rule `orderedTranscriptMessages` already applies to the
canonical pair. A test that reaches this through `upsertTranscriptMessage`
proves nothing: that helper belongs to the socket path, not to the feed.
`queueSequence` is now the marker of composer-queue membership: an overlay
without one is not a row and cannot be reordered. The loop promoting the answer
out of turn is the other half of this, and lives in the 2026-09-14 entry in
[`workstream-durable-object.md`](workstream-durable-object.md).

### 2026-09-13 — The in-flight sweep is painted on each surface of a turn, not on its wrapper

**What changed:** The shimmer that marks a person's turn as still in flight
paints on each surface the turn draws — the message bubble, and every
attachment image cell, media tile and file card — instead of on the
`.human-message-content` wrapper around them. The overlay is inset to its
surface and inherits the surface's corner radius, and it travels by animating
`background-position` over a gradient tile four times the surface's width, the
construction the tool-activity label's shimmer already uses, rather than by
translating a full-width pseudo-element under the wrapper's `overflow: hidden`.
The band is upright where it was tilted 15°: a tilt spreads the band sideways
by the surface's height, which for the bubble is unbounded against its width,
so no tile width kept a tilted band clear of a tall, narrow bubble at the ends
of its travel, and a tinted corner stayed parked there through each pause. The
travel is the transform sweep's 2.5 widths, so the band crosses at the speed
and for the share of the cycle it did before. And the band is a twentieth of
the surface's own ink rather than the shimmer token: the token is a dark tint
for light surfaces (white in the dark theme), and a person's bubble is dark or
profile-coloured in both themes, so on it the token was invisible once the
wrapper's light strip stopped carrying the sweep. The body above describes the
result; this supersedes the wrapper scoping the 2026-09-02 entry below records.

**Why:** The wrapper is a rectangle. It takes in the hover-action slot laid out
under the bubble and the corners the bubble's radius cuts away, so the sweep
read as a grey block behind the pill rather than a light passing over it. It
had been put on the wrapper deliberately, so that a send made of attachments
and no text still carried a cue; keying the sweep on each surface keeps that
cue without the box.

**Considered and rejected:** Keeping the transform sweep and clipping it with
`overflow: hidden` or `clip-path` on each surface. That makes every surface a
clipping box for the length of the send — a file card's controls and any
focus ring inside it would be cut — where the tiled-background overlay clips
only itself.

**Consequences:** A new attachment surface rendered inside a person's turn has
to be added to the selector list at `.human-message.is-sending` in `app.css`,
or a send made of that kind of attachment alone goes out with no in-flight
cue. The band's stop percentages, the 400% tile and the upright band hold
together: the band has to sit clear of the surface at both ends of its travel,
a tilt gives that clearance a height term nothing can bound, and the comment
above the rule carries the arithmetic.

Shipped in [#739](https://github.com/juno-ai-labs/avalon/pull/739).

### 2026-09-12 — The composer writes lists, and stops hiding text behind the plus

**What changed:** Two things about a multi-line draft, delivered together
because they are the same draft.

`lib/markdown-lists.ts` is new and owns list editing as three pure functions
over a draft and its selection: `continueListAtCaret` (the newline key),
`shiftListAtCaret` (Tab and Shift+Tab), and `toggleListAtSelection` (⌘/Ctrl+⇧8
and ⌘/Ctrl+⇧7). So a `- ` or
`1. ` carries itself to the next line, a numbered list counts, Tab nests onto
the column the item above puts its own content in, Enter on an empty item walks
back out a level and then leaves the list, and a task item's continuation gets
an *unchecked* box. Every operation ends by renumbering every ordered run in the
draft, so inserting into the middle of 1–4 gives 1–5 rather than 1, 2, 3, 3, 4.
`composer-input.tsx` binds the keys after the host's own handler and after
sending, so Enter still sends and only the keystroke that was going to insert a
newline reaches a list.

The capsule composer's controls now take a grid row of their own whenever the
field spans the full width — wrapped text, or an attachment row above it —
instead of sharing row 2 with the text. The 39px of bottom padding that used to
hold them apart is gone, back to 4px.

**Why:** A Rally message is Markdown and always has been, so a list was already
something a person could send; what was missing was every editing behaviour
people arrive from Slack, Claude Code and every note app expecting, which made
writing one a chore of retyping dashes and renumbering by hand.

The plus overlapped the draft's own text, which is what prompted the layout
half. The 2026-09-10 entry below ("Multiline composer text spans above its
controls") put the wrapped field in the controls' row and reserved a
control's height of bottom padding to keep them apart. Padding inside a
scroller scrolls: it holds on the *last* line of the draft and nowhere else, so
the moment a draft outgrew the field every line under the caret ran beneath the
plus button — which is exactly the state somebody writing a long list is in.
A row the controls own cannot be scrolled into, and it needs no number to be
chosen.

**A list is started by typing one, and only by typing one.** The plus menu
briefly carried **Bulleted list** and **Numbered list** items, on the reasoning
that a behaviour nobody can see is a behaviour nobody uses. They are not there:
a `- ` or a `1. ` *is* the affordance, the menu command was a second way to say
the same thing that could drift from what the keys do, and the composer's
bottom-left row is the one piece of chrome this change was also making less
crowded. `toggleListAtSelection` stays for the two shortcuts, which are what
turns lines somebody has *already written* into a list — the one thing typing a
marker cannot do.

**Tab belongs to the list, and does not move focus.** Inside a list Tab indents
and Shift+Tab unindents, to a depth of five; outside one Tab is untouched and
still moves to the next control, so an ordinary message and an empty composer
keep the exit they always had. The composer decides that on
`selectionTouchesListItem` — whether the caret is in a list — rather than on
whether the draft moved, and the distinction is the whole point: an earlier
round keyed it on the draft moving, so Tab indented four times and then, with
nothing on screen having changed, threw the caret out of the field on the fifth.
That was reported from a real draft, twice. Five levels is the team's number and
not the format's; `MAX_LIST_DEPTH` is the one line to edit.

The rest of the operations still return `null` to mean "nothing happened, let
the keystroke be" — that contract is the thing to preserve when adding a fourth.
Tab is the documented exception to it.

Edits are applied with `document.execCommand`, not by handing the parent a new
string. That is what keeps them on the textarea's undo stack — ⌘Z after Enter
lifts one marker rather than clearing the draft — and it means each one arrives
at `onValueChange`, the draft cache and the mention rebase as one ordinary
input event. The composer falls back to replacing the draft where the command is
unavailable, which is how the jsdom tests exercise it.

Ordered runs are renumbered wholesale rather than each operation patching up
what it disturbed: continuing, nesting and unnesting all shift numbering below
the caret, and three separate corrections would be three chances to disagree. A
run with nothing above it to be nested under keeps its first ordinal, so a list
deliberately started at `5.` stays started at 5; a nested run always restarts at
1, because a sublist starting at 11 only ever means somebody nested the eleventh
item above it.

The stacking context the old layout needed — `position: relative; z-index: 1` on
both control groups, so the spanning textarea could not intercept their clicks —
is gone with the overlap that required it. `app.css.node.test.ts` guards the two
grid declarations that replaced it instead. Checked in a real window in both
appearances: typing, nesting, unnesting, the menu, the shortcut, undo, and a
draft scrolled with its middle lines beside the controls.

### 2026-09-11 — Connector recovery is a first-class conversation-feed card

**What changed:** The live conversation surface opts into rendering validated
`core_show_connector_connection` tool calls as provider cards with connect,
reconnect, pending, and connected states. These rows are person-facing and
therefore remain outside plugin grouping and settled-work accordions.

**Why:** Collapsing the call into “Rally worked” hid the one action that could
unblock the task. Rendering it as an ordinary tool disclosure exposed a wire
name and JSON instead of the connector the person recognizes.

**Alternative rejected:** Teaching every `MessageBlock` host to render the
card automatically. OAuth is a product control of the live feed; a shared
renderer silently acquiring it would put connection controls into future
read-only or preview surfaces.

**Consequences:** A new transcript host remains neutral until it opts in. The
card's height is measured by the existing feed virtualizer, and completion of
the external OAuth flow refreshes the same global connection query used by
Settings and connector mentions. The completed tool fact carries forward the
validated card identity, so reload, paging, recovery, or virtualization cannot
downgrade an already-shown card into a generic tool disclosure. The first
Connected observation is held above virtualized rows for the feed's lifetime.
Adjacent repeats of the same connector and scope keep the first row's stable
anchor instead of stacking.

### 2026-09-11 — A pending stop says so in words, where the reader is watching

**What changed:** While a running conversation carries `stopRequested`, the one
activity slot above the composer shows a stopping row — an orb and "Stopping
after the current response…" — ahead of the compaction indicator and the elapsed
total. `conversationActivityRow` owns that precedence as a single exported
decision, and one exported sentence now serves both the row and the Stop
button's tooltip.

**Why:** Stop was reported as not working. It was working. In the production run
behind the report, the request was written 1.8s into an assistant turn; that turn
finished 7.0s later, the tool it had already asked for ran for a further 3.0s,
and the loop committed the stop 11.2s after the click — exactly the post-step
safe boundary the durable loop documents. For all 11.2 seconds the only
acknowledgement was a 12px spinner inside a 28px circle and a tooltip that has to
be hovered, while the row above it went on counting "Rally is working". A
correct mechanism with no legible acknowledgement is indistinguishable from a
dead button, and the cost of that is a second and third click on a control that
deliberately refuses them.

**Considered and rejected:** Giving the composer's Stop control a visible
"Stopping…" label. That is the text Stop removed the same day by *Stop slides
through the composer corner*, below, for widening and raising the trailing
control row, and re-adding it would relitigate a decision one day old. Also
rejected: making Stop feel instant by
skipping the tool batch the model already asked for, or aborting the provider
stream outright. Both are real options and neither is a desktop change — the
first would leave the durable Bind head ending in an assistant message with
unanswered `tool_calls`, and the second reverses a stated invariant in two module
documents. Legibility was the part that was unambiguously wrong.

The row was first built into the transcript's activity slot, ranked above the
compaction indicator and the elapsed total, and that was wrong for a reason
worth recording: the slot is inside the scroller. Review caught it. A reader who
has scrolled up to check earlier messages and then presses the always-visible
Stop is precisely the person this change exists for, and they would have been
handed the row 1,720px below a 900px fold — the button spinner and nothing else,
the exact ambiguity being fixed. Having Stop scroll them back down was the other
repair available and is worse: `useTranscriptFollow` exists to enforce that only
the reader's own scrolling moves the viewport, and yanking someone out of the
history they deliberately opened would trade one defect for a ruder one. Moving
the row to the dock keeps both rules.

Wording: the label names the *work*, not the response. Two independent review
passes caught that "after the current response…" promised a boundary the step
does not have, and this PR's own trace is the proof — a tool the response had
already asked for ran for 3.0s after it finished.

**Consequences:** Feedback that answers a composer control belongs in the dock,
not in the feed: anything rendered inside `.transcript-scroll` inherits the
reader's scroll position and can be invisible at the moment it matters most, and
the feed's rows are for describing the run rather than for confirming a click.
The stopping row deliberately shows no duration: any future countdown there
would be a promise about the model's remaining output that nothing in the client
can keep. A real-window check of a scrolling surface has to include a scrolled
position — this defect is invisible from the bottom of the transcript, which is
where the first check was made. If Stop ever does become immediate, this row
becomes dead weight rather than wrong — delete it with the change that makes the
wait disappear.

Shipped in #721.

### 2026-09-11 — An intentional stop does not offer to replay the turn

**What changed:** The terminal stopped notice uses a filled stop-square and no
longer offers Retry. The stopped prompt stays in transcript history, and a
person who wants to continue submits a fresh turn from the composer; failed
runs retain their separate Retry action.

**Why:** Pairing an intentional member stop with an X and a primary Retry button
made the outcome read like a failure awaiting recovery. The August 20 harness
entry correctly required stopped to remain visible and distinct from failed,
but its fresh-retry affordance did not preserve that distinction in the
finished interface. The removed follow-up also claimed partial tool activity
was no longer running even though Stop is observed at the post-step boundary
and the active step settles first.

**Considered and rejected:** Keeping Retry as a quieter link. Any replay action
still suggests that stopping was an interruption to recover from rather than a
terminal choice; a new message makes the next intent explicit instead.

**Consequences:** A stopped request is not restored into the composer or
replayed automatically. Future stopped-state treatments must remain visibly
distinct from failure and must not add a recovery action; retries belong only
to failed runs.

Shipped in #717.

### 2026-09-11 — Stop slides through the composer corner

The text Stop action widened and raised the trailing control row, leaving the
leading controls visibly lower. Stop now uses the same icon geometry after
Send, with its action and pending state explained by a tooltip. A mounted slot
animates width and translation through the clipped capsule corner, so removing
the action does not snap the microphone and Send back into place. Keep hidden
controls inert, pending stops guarded, and single-line control groups centered.

### 2026-09-11 — A rail fades what it cannot fit, and only when it cannot fit it

**What changed:** Every line the navigation sidebar and the work-stream sidebar
clip now ends in a fade instead of an ellipsis or a hard cut — row titles and
hints, project names, Sidekick tile captions, the account row, and the centre
rail's names and subtitles. One `@keyframes clipped-line-fade` and one rule
listing those lines replace the `text-overflow: ellipsis` each carried. The
fade is conditional on real overflow, expressed as a scroll-driven animation on
the line's own inline scroller rather than as a measurement.

**Why:** Reported from a screenshot of both rails side by side, where the two
halves of the same list ended two different ways and neither said "there is more
of this here". `…` spends three characters saying it, which on a 12px row is
most of a word; and the sidebar's title never got even that — it is a flex line
so that a system-work cog can sit beside the text, ellipsis is a block
behaviour, and the title was being cut at a hard vertical edge that reads as a
rendering fault. A mask was chosen over a gradient overlay because these rows
carry three fills and an overlay matched to one is a visible bar in the other
two.

**Consequences:** the condition is the part to respect. An unconditional mask
fades the tail of a title that ends a few pixels short of the edge — text
nothing clipped — and the obvious fix, measuring each line with a
`ResizeObserver`, would put one on every row in a list that already runs its own
motion choreography. The inactive-timeline behaviour gives the same answer for
free and re-decides itself on a rename or a drag, so a change here should keep
the question in CSS rather than move it into the component. Three details are
load-bearing and easy to delete by accident. *Both* longhands have to stay below
the `animation` shorthand, which resets both: duration back to `0s`, and —
the one that actually costs the condition — `animation-timeline` back to the
document's, against which `auto` computes to `0s` and the fill holds the 100%
keyframe from the first frame, masking every listed line whether it clips
anything or not. So the ordering is asserted by position, not the declarations
by presence; a review of the first version of this change caught that the test
pinned only the duration's. The fill mode is what keeps the mask applied for a
reader whose reduced-motion preference forces every duration to 0.001ms. And
both keyframe stops hold the same value, because the timeline is a question
about overflow rather than a clock. The `#000` in the
mask also made `themes.css.node.test.ts` exempt mask declarations from the
"no colour is written into app.css" guard — a mask is sampled for alpha and
never painted, so a literal in one cannot render wrong under another theme, and
the alternative that would have satisfied the guard blindly, `currentColor`,
would have tied how much of the line survives to whatever alpha a text token
carries.

### 2026-09-11 — Coming back to Rally is neither a hover nor a focus

**What changed:** Two surfaces now ask whether the person has touched this
window since it was last brought to the front, and stay shut when the answer is
no: the shared `Tip`, and the work-stream row's preview card. Both also take
themselves down when the window goes to the back, instead of waiting there for
the return. The eight files that still assemble Radix's five tooltip parts by
hand ask nothing and still open on an app switch — the migration onto `Tip`
noted above is what finishes this, and is the reason to finish it.

**Why:** Command-Tab back into Rally raised two preview cards over the
conversation the person had switched back to read — one for the work stream they
are in, one for whatever the cursor happened to be resting on. Both are real
events: the row clicked to get here still holds DOM focus and is focused again
when the window is activated, and the row the window comes forward underneath is
entered by a cursor that never moved. Nothing in either event says the window
manager caused it, so every surface that opens on hover or focus was opening on
every application switch. The card is a reading surface, so this is not a stray
pixel — it covers the screen that was the point of switching back, and it does it
twice.

**Considered and rejected:** Opening only for `:focus-visible`, which would leave
the pointer half untouched and would change *who* gets the card — a pointer user
who clicks a row would stop getting one at all — to fix *when*. Suppressing
everything for a fixed period after an activation, which needs a number nobody
here can derive and answers "recently" when the question is "at all". Fixing it
in the sidebar alone, which leaves the identical defect in the shared `Tip` that
every other surface reaches for.

**Consequences:** `App` installs the guard once per window and the answer is
permissive until it does, so a surface rendered outside it — a test mounting one
component — behaves exactly as it did before. Movement is established by
comparing pointer coordinates rather than by counting events, because the events
an activation produces are precisely the ones that describe a cursor sitting
still; a future opener must not read the arrival of a pointer event as a pointer
having moved. A pointer entry that the guard turns down cannot be replayed, so
the row opens its card on the first real movement afterwards rather than on the
entry — which is why the row listens for movement at all. `Tip` now holds its own
open state so that it has something to put down, and reports that close through
`onOpenChange` as well: a caller rendering `open` — `DragHint` is the one —
would otherwise draw its hint straight back over the returning window, which is
the defect this entry is about wearing a different hat. The guard is
`lib/window-activation.ts`, and it is where a third surface with the same
symptom should go.

### 2026-09-11 — A substream's unread divider can now be read away

**What changed:** The surface acknowledges reads in whatever conversation it is
showing. `conversationReadAcknowledgement` in `conversation-surface.tsx` is the
one place that decides what a conversation owes, addressed to itself, and the
`if (substreamId !== '0') return` that opened the old callback is gone. The
request goes to that conversation's own read-state endpoint (see
[`workstream-durable-object.md`](workstream-durable-object.md)), and its answer
patches that conversation's own detail entry, which
`patchCachedWorkstreamViewerState` was already addressing correctly.

**Why:** the feed drew a divider it could not clear. `firstUnreadIndex` is
computed from the addressed conversation's own `firstUnreadSequenceNumber` and
handed to `MessageFeed` unconditionally, unlike `onStartSubstream` beside it,
while the acknowledgement was Main-only. Because sending a turn advances its
author's own waterline, the **Unread messages** rule came to rest between the
person's question and Rally's answer to it, which is the least useful place it
could be and the one it could not leave, for the life of the substream.
[`workstream-durable-object.md`](workstream-durable-object.md) owns why the
waterline is the child's.

**Considered and rejected:** suppressing the divider in a substream, which is
the smaller diff and the wrong half to change: the child's unread state is real,
it is what the reader wants, and hiding it would have left mentions and the
opening scroll position reading from a waterline nothing maintains. Also
rejected: leaving the in-flight key naming only the work stream. It is reset
whenever the conversation address changes, so two children cannot collide
today, but a key for a per-conversation request that cannot name the
conversation is a trap for the next change.

**Also changed:** an acknowledgement that answers out of order no longer rolls
the waterline back. Two can be in flight, because the send is debounced at
250ms and keyed on the sequence it carries, so a slower round trip for an
earlier position lands after a later one; applied in arrival order the earlier answer put
the divider back above a message that had been read. `patchCachedWorkstreamViewerState`
now drops an answer older than the entry it holds, ordering on the manual-unread
generation first and the read-through within it, because both only move forward
at the authority. It is not specific to substreams, but it undoes this fix when
it fires.

**What a future change has to respect:** the acknowledgement, the divider, and
the opening anchor all read the same conversation's viewer fields. A surface
that starts drawing one of them from the parent's detail entry while the others
read the child's puts the divider back where it was. And the guard above assumes
its two fields are monotonic at the authority; a server that ever lowers
`seen_attention_ordinal` would be silently ignored here.

### 2026-09-11 — The navigation's plus says what it starts, and it starts a work stream

**What changed:** The `+` in the navigation titlebar and its twin in the rail
are wrapped in `Tip` — below the titlebar's, to the right of the rail's, where
the tooltip covers the pane instead of the row under it. Both read
`NEW_STREAM_LABEL`, one module constant that is also their `aria-label`, and it
is **New work stream** in every shell. The GrokBot shell's draft row on that
route, which stood in for the same control while it is open, reads the same
constant instead of its own **New chat**, as does the action row under the
search. Both tips are `describesTrigger={false}`, since that name and the tip
are the same words. Both links now state `className` as a string, from a
`location.pathname` comparison the `returnTo` state was already making, instead
of `NavLink`'s callback form. The current-state prose in this document,
[`list-motion.md`](list-motion.md), [`e2e.md`](e2e.md) and
[`automation-lifecycle.md`](automation-lifecycle.md) calls the row by the new
name; every changelog occurrence is history and is left alone.

**Why:** The plus is the whole control — an icon with no words beside it, in the
one place a pointer looks first — and the only thing naming it was an
`aria-label`, which a reader using a pointer never sees. Every other icon-only
control in the shell answers a hover through `IconButton`, whose `label` is both
names at once; these two links could not use `IconButton` and so had gone
without. The name is one constant rather than a per-shell choice because the
route makes one thing: a work stream. The conversation-only shell presents an
open conversation as a chat, but what this control creates does not change with
the shell around it, and a plus that opens **Start a new work stream** while
calling itself New chat had the reader translating between two names for one
action.

**Consequences:** In the full navigation the titlebar's plus and the action row
under the search share an accessible name, which is honest — they are two ways
to one route — but a test that reaches for that name now has to scope to the
container it means.

**What a future change has to respect:** Radix's `Slot` merges the child's
`className` into the trigger's, so a `NavLink` whose `className` is a callback
reaches the DOM as that callback's *source text* and the link renders unstyled —
the failure is silent, it survives typecheck and every DOM assertion, and only a
real window shows it — so `sidebar.test.tsx` asserts the class on both links
beside the tooltip, because a window is not a gate the next change runs.
`Tip`'s own comment said a child like that "needs a plain wrapper"; it now says
what this change found instead, because a wrapper was not the right answer here.
The cost is layout, not discovery: `useListMotion` finds a keyed row at any
depth, but a wrapper becomes the element its parent lays out — the command bar
is a two-track grid whose second track *is* the rail's plus, and the titlebar's
fade is written `.sidebar-titlebar > .sidebar-new-button`. Resolving the class
to a string at the call site keeps the trigger the link itself. Prefer that;
reach for a wrapper only where nothing lays the child out directly.

### 2026-09-10 — One identity line, painted once rather than once per speaker

**What changed:** `MessageBlock` renders both of its headers through a new
`MessageByline`, and the four `app.css` rules that gave the name and the time a
size, weight, colour and opacity per speaker collapse to two that state them
once. The person dot moves inside the name element. The timestamp is
`RelativeTime`, so it stays current while a work stream is open and gives up the
absolute local time on hover.

**Why:** Rally's turn and a person's turn were drawing the same two facts — who
spoke and when — in visibly different ways: 13px/500 in `neutral-11` under a 0.7
opacity against 12px/500 in `text-subtle`, and an 8.5px time against a 12px one.
No rule looked wrong beside the others, which is how four of them came to exist;
the difference is only visible with both rows on screen, which is how it was
reported.

**Consequences:** a rule scoped to `.agent-message` or `.human-message` that
touches the name or the time is now a test failure rather than a style choice,
because that scoping is what let the four drift. The accent stays per speaker
and paints the dot alone — the name no longer resolves through
`--person-accent`, so the `profile ? text-default` branch that kept a bright
personal hue from making a name unreadable is gone with the problem it solved.
The header order the [September 9 entry](#2026-09-09--attachments-follow-the-message-author-ends-at-the-corner)
fixed in markup is now the component's rule rather than each branch's: the parts
are reversed for a trailing-edge turn, in the DOM, for that entry's reason.
[`relative-time.md`](relative-time.md) owns the byline and the clock from here.

### 2026-09-10 — Every action in a turn's hover row says what it does, and two of its sentences get shorter

**What changed:** The four assistant actions and the substream cutoff open a tip
under themselves, through a new `MessageAction` that takes one `description` and
spends it twice — as the button's `aria-label` and as the tip's words. They go
through `Tip`, the primitive the artifact rows brought in the entry below, which
gains three things here: `TipGroup` over Radix's provider, `describesTrigger`,
and a `collisionPadding` that defaults to 12 rather than to Radix's zero — the
gutter the citation popover had been stating by hand, and the one the cutoff at
the far right of a person's bubble needs. A caller states its own only to want
something else. The Radix contents still assembled by hand are untouched: that
popover states the same 12 itself, and the other ten state none.
**Speak**'s native `title` is gone, superseded.

A tip in a group also closes the moment the pointer leaves its control. Radix's
default is to keep one open while the pointer is over the box itself, which is
right for a popover with something in it to reach — but these rows appear on
hover of the turn, and the box sits outside it, so walking onto the box faded
the row out from under a label still pointing at where it had been. The rows are
the only tips in the app that hang off something transient, which is why this is
on the group rather than on every tip.

Two of the row's sentences also got shorter: *Speak response with an
AI-generated voice* is now *Speak response*, and *Download response as an
image* is now *Save response as an image*. Each is one string, so each moved as
the button's accessible name and its tooltip together.

**Why:** The row is read at 10px in the margin of a turn, so its labels are one
or two words, and three of them — **Image**, **PDF**, **New substream** — name a
thing rather than an action: **Image** is a file this turn becomes, not a
picture in it, and nothing on the row said so before a reader clicked it. The
sentences were already written for exactly this, one per action, and were
reaching only screen readers and voice control. Writing the tip as a second
string would have let the two drift, and this row is where a drifting pair is
least likely to be caught — the visible label is the one part of it a sighted
reader never needs.

The five sentences are read one after another by a pointer travelling the row,
which is a place a sentence's length is felt. Speak's ran roughly twice the
length of its neighbours, and the image export was the only one that said
*Download* where its neighbour said *Save* — the two exports do the same thing
to the same turn and now say so the same way.

**Considered and rejected:** A native `title`, which is what **Speak** had. It
opens after a delay nothing in the app sets, in the OS's box rather than this
one's, and never for a pointer already moving along the row — the same case the
artifact rows made below, arrived at independently on this row. Also rejected:
opening above the row, where a bottom-anchored control usually opens — here it
lands the box on the turn's last line, while under the row there is only the gap
before the next turn. Unifying the app's two open delays (450ms on controls,
300ms on the compact identity and status indicators) was deliberately left
alone: nothing here asked for those surfaces to feel different.

**Consequences:** A control added to either row goes through `MessageAction`,
and so cannot be added without the sentence that explains it; a bare button in
that row now needs a reason. `MessageAction` states that sentence as the
button's name and refuses `aria-label`, `aria-labelledby` and `type` from its
caller, so the name cannot be replaced from outside the row. It opens its tip
with `describesTrigger={false}`: the name already *is* those words, and a name
and a description that read alike are announced one after the other, which reads
the row's one sentence twice to the reader who can least afford it. Anything
else whose name is its tip — `IconButton` is the standing example — has the same
duplication and the same one-word remedy.

A `TipGroup` belongs around any cluster of tips a pointer travels along, and
around any tip on a surface that may render outside `App`: it carries Radix's
provider, which is why the row's tips work in a component test that mounts a
`MessageBlock` and nothing else.

Speak's name no longer says the voice is synthetic, and nothing in the
transcript says it instead; that gap and what closing it would take are recorded
in [`message-speech.md`](message-speech.md). The exports read as a pair, so a
third export format joins them as *Save response as a …*.

### 2026-09-11 — Every dock crosses the narrow row at the same pane

**What changed:** The substream and project launchers' dock states `padding: 12px
16px 28px` rather than `12px 34px 28px`, so its horizontal gutter is the 16px
every other dock states, and the `@media (max-width: 760px)` rule that existed
only to equalise those gutters at narrow widths is gone. The vertical values are
untouched. `app.css.node.test.ts` now reads every rule that pads a dock and holds
each one's side value to the same `threshold + 2 × gutter = 600px` sum.

**Why:** A size query measures the container's content box, so a dock's own
gutters decide which *pane* width the narrow-row branch starts at: 16px sides put
it at a 600px pane, 34px sides at 636px. Between those two the launcher was on
the narrow branch while the conversation it becomes was not, so the field
changed width on the keystroke that submits it — 552px to 480px at a 620px pane,
and 522px to 558px at 590px — which is the exact defect the one-width change was
made to remove, surviving inside it in a 36px band. Raised by an automated review
on the pull request; it had been recorded as an accepted residue in the entry
below, which was the wrong call: the residue was the bug. The hero's 34px was
sized for a 690px column that no longer exists, and the two narrow-width media
rules that already equalised it were saying so.

**Consequences:** On a pane narrow enough for the full-row branch, a launcher's
field, banner and participant row sit 16px from the pane's edges rather than
34px, which is where the conversation's field already sat. Nothing moves at any
wider pane, where the field is 480px centred and the dock's gutters are not what
positions it. The dock padding still transitions across `.is-launching`, with
only the vertical values left to travel.

**Also in this change, because the test that should have caught it did not:**
the gutter scan reads rules out of the stylesheet rather than looking each
selector up with `rule()`, which returns the *first* match for a name — and this
launcher dock's selector is written twice, once in a narrow-width media block and
once as the rule itself, so the lookup answered for the wrong one and the scan
passed over the only dock it exists for. It also strips comments before reading a
declaration, having been fooled once by a comment sitting between the brace and
the `padding` it documents.

### 2026-09-11 — A preview no longer opens with a tooltip over it, or eats Escape

**What changed:** Both lightboxes prevent the dialog's opening auto-focus and
keep focus on the content element instead. The attachment lightbox's nine
icon-only controls (details, download, close, expand, and the gallery arrows)
gained tooltips, which they had never had.

**Why:** A Radix dialog hands focus to its first control on open, Radix opens a
tooltip on focus, and every control in this chrome is an icon. So each preview
opened with a label floating over it that nobody had hovered. Worse, the open
tooltip is then the topmost dismissable layer, so the first Escape dismissed
*it* and the preview stayed: closing a preview with the keyboard took two
presses, and looked like the first one had not registered. The resource
lightbox has shipped this way since it gained icon actions; the attachment
lightbox only acquired it when its buttons gained tooltips, and its own tests
caught it in the same change.

**Considered and rejected:** Leaving the attachment lightbox's icons unlabelled
to avoid the interaction, which trades a real defect for an unnamed control.
Also rejected: converting those buttons to `IconButton`. They carry their own
absolute positions and sizes over the image, and `.icon-button`'s geometry
fights them; `Tip` wraps them and adds nothing but the label.

**Consequences:** Any future dialog whose first focusable is an icon button
needs the same `onOpenAutoFocus`. The search modal already tames it the same
way, for its own reason (the query field takes the focus); `Modal` never showed
this by a different route, since its close button passes
`showTooltip={false}` and so has no tooltip to open. Copying that instead would
leave the control unlabelled, which is the trade this change exists to refuse.
A test that asserts a dialog closes on one Escape is the cheap way to catch the
defect: that is what failed here.

### 2026-09-10 — One composer, dressed one way

**What changed:** The message capsule is now every conversation surface's, and
the launchers state no composer treatment of their own. The capsule's 29 rules
key on `:is(.workstream-screen, .workstream-launch-screen)` instead of
`:is(.workstream-screen, .new-chat-screen)`, which reaches the new-substream dock
and project-owned creation as well; `new-workstream.tsx` passes
`layout="message-capsule"` unconditionally rather than only for a workspace-level
new chat; and all eleven `.launch-composer` rules are gone, along with the
`className` that carried them. Two of those were the treatment itself — a
raised box on `--av-sys-size-radius-xl` with an 84px field under
`elevation-shadow-md`, and the new-chat screen's restatement of the capsule it
was already sitting beside — and two were the transitions that travelled between
the treatments at `.is-launching`, which now have nothing to travel.

**Why:** The new-substream field was 86px tall on an 8px corner while the
conversation's, six inches above it on the same screen, was a 44px pill on a
22px corner; a person starting a substream saw both at once. Three dressings of
one component is also three places to keep in step, and they had already drifted:
the launcher's placeholder ink, its hint ink, and its toolbar padding were each
stated once and read nowhere else.

**Consequences:** Project-owned creation loses the toolbar layout the
2026-09-04 entry in [`workstream-creation.md`](workstream-creation.md) gave it —
that entry's reasoning (the launcher should not look different from the
conversation entry point) is the same reasoning applied to the surface it had
left out. Its developer-only model override moves from the toolbar pill into the
plus menu, where the capsule has carried it since that entry; its footer hint
("Enter to create") is not rendered at all, because the capsule hides
`.composer-hint`, so both launchers now state the keystroke nowhere. The prop is
still passed, and one rule is all that stands between it and being shown again. The new-substream field is a single 42px row until it wraps
rather than an 84px box, so its first impression is smaller; the banner above it
is unchanged. Checked in a real window on both appearances, wrapped and empty.

### 2026-09-10 — One composer width, launchers included

**What changed:** The width the entry below gave the work stream's composer is
now every composer's. `--composer-width` names it once —
`calc(var(--turn-width-cap) * .75)`, 480px — and the composer stack rule takes
`:is(.workstream-screen, .workstream-launch-screen)`, which covers the settled
conversation, the new-chat screen and the new-substream dock. The launcher's own
690px column is gone from all three places it was written out: its stack, the
`.substream-launch-banner`, and the `.new-workstream-modifiers` participant row.
The last two read `--composer-width` and join the field in the narrow-row
branch, because they are centred siblings of the stack, not children of it, and
a row that keeps a wider cap stops lining up on exactly the width where the
field gave its inset up. Two rules the entry below added are gone with the
divergence they existed for: `.new-chat-screen:not(.is-launching)
.composer-stack`, which stated the full row, and the `max-width` transition on
`.workstream-launch-screen .composer-stack`, which travelled the field from the
launcher's width to the conversation's. Nothing travels now, because nothing
moves.

**Why:** The entry below sized one of the three fields a person types a first
message into and left the other two — a new work stream at full width, a new
substream at 690px — so the same draft was three widths depending on where it
was written, and the handoff into the conversation resized the field under the
person mid-sentence. A launcher is not a different surface with its own
proportions; it is the conversation before it exists, which is exactly why the
element is never unmounted across the handoff.

**Consequences:** The substream banner's note truncates earlier than it did at
690px, which is the behaviour that row already states for itself — the label
names the surface and the note only explains it, so the note is the first thing
to go. The narrow-row threshold is stated once, as a content-box width, so the
two launcher docks — 34px gutters against the conversation's 16px — reach it at
a pane about 36px wider. And every consumer of `--composer-width` is now one
edit away from moving together, which is the property the three copies of 690px
did not have.

### 2026-09-10 — The composer is three quarters of the widest turn

**What changed:** The work stream's composer stack is
`max-width: calc(var(--turn-width-cap) * .75)` — 480px — centred over the
transcript, instead of running the full width of the pane. `--turn-width-cap` is
new: the 640px that was written out in each of the three rules capping a turn is
now declared once and read by all of them and by the composer. Under a 600px
pane the field takes the whole row again, through an inline-size container on
`.workstream-screen .composer-dock` and a `@container` query at 568px, that pane
less the dock's two 16px gutters. The new-chat launcher's own rule states the
full row as `max-width: 100%` rather than `none` so the width can travel into
the conversation's measure at launch instead of cutting to it; that screen
already carries `.workstream-launch-screen`, whose stack transitions
`max-width`, so nothing else was needed for it.

**Why:** The field ran to both edges of the pane while every message in it
stopped well short of them, so the one element a person types into was the widest
thing on screen and belonged to no column. Three quarters of the cap rather than
the cap itself keeps the field visibly narrower than the turn it becomes; the
number is the design's, not a derivation. The cap is what both ends read, so it
is named — the composer cannot arrive at it any other way, sitting as it does
outside the scroller where the column's percentages do not reach.

**Considered and rejected:** Reconstructing the transcript's *measure* in the
composer — the pane, less the scrollbar gutter `.transcript-scroll` reserves,
capped at the feed width, less the column's own padding — and taking three
quarters of the full `min(88%, cap, 100% - 82px)` over it. It agrees with the
shipped rule at every pane over ~800px, differing only where the column is
narrow enough that a turn is capped by the column instead of by 640px, and it
buys that agreement with an equation nobody can read a width off and a
dependency on two lengths (the scrollbar gutter, and a column padding that
changes at another breakpoint) that would drift silently. A viewport media query
for the narrow branch was rejected outright: the pane is not the viewport here.

**Consequences:** Between a 600 and roughly an 800px pane the field can be a few
pixels wider than the widest turn, because a turn is capped by the column there
and the field is not; the narrow branch below 600px is deliberately wider still.
The composer is centred on the pane while the transcript column is centred
inside the scroller's gutter, so the two centres differ by half a scrollbar —
4.5px, as they already did. Every conversation on the shared surface moves with
this, a Sidekick's included, which is the point: it is one surface.

### 2026-09-10 — One Sidekicks section, under the people, in both of a room's rails

**What changed:** `ConversationSurface` fetches a work stream's own Sidekicks
alongside its conversation's attachments and passes one merged list to both
rails. The center sidebar renders it as a **Sidekicks** section below
**Participants**; the inspector rail renders the same rows. `SidekickSection`
replaces the attachments-only component, and each row carries the hexagon the
library draws it with and the rail's own `Tip` — labelled with the note as well
as the name, since compact hides the copy and the tooltip is then the only way
to read that a Sidekick is paused — rather than a platform `title`. Adding or
removing a main-room participant invalidates the owned list, which participation
gates and the query key does not carry.

**Why:** The section the sidebar had listed only attachments, so a Sidekick
created in the room — the kind whose managers are that room's participants —
appeared nowhere in it. Merging the two lists rather than adding a second
section keeps one heading and one question ("which Sidekicks are in this
room?"), and the surface composes the rows once so the sidebar and the rail
cannot drift. The rows moved onto the sidebar's own 54px row shape for a reason
the DOM does not show: compact drops every title in that rail, and the previous
attachment rows had no mark, so a collapsed sidebar showed blank squares where
Sidekicks were. The section drops itself — heading included — for an empty list
and for a pending one, which is what the artifact section beside it had settled
hours earlier for the same rail; an empty state written here would have been a
second answer to a question this rail had just answered. Whoever changes this
next: **Remove** sits at the end of the row
rather than on a line of its own, so that a Sidekick that can be detached and one
that cannot occupy rows of the same height — the earlier arrangement left a
ragged gap between otherwise identical rows — and it is clipped rather than
`display: none`d in compact so it travels with the edge like everything else in
that rail.

### 2026-09-10 — Send during dictation stops it and sends what it heard

**What changed:** A live recording no longer disables Send. Pressing it (or
Enter, which runs the same `submit`) stops dictation and sends the transcript
including the tail still in flight. `dictationBlocking` is gone; the states it
named now only gate *editing*, under the name `dictationEditingBlocked`, because
the transcript is written into the same field a caret would be fighting for.
While the stop drains, Send shows its sending spinner and is disabled, so the
wait looks like work rather than a dead button.

**Why:** Stopping and sending was two deliberate acts with an indefinite gap
between them — the recording had to be stopped, finalization watched, and only
then could the message go. Nothing about that gap is the user's problem to
manage. Send already meant "I am done talking".

**Considered and rejected:** Sending the text as it stands and letting the tail
land in an emptied composer, or be dropped. It is the fastest option and it
loses the last words the user spoke, which is the one thing a Send button must
never do quietly. Also rejected: `await dictation.stop()` inside the click
handler and then submitting. That is the obvious shape and it is wrong: the
final transcript reaches the host through `onValueChange`, so the host's submit
closure captured at click time still holds the pre-stop draft, and the tail is
dropped exactly as if it had never been drained. `stop()` resolving is not the
moment the text exists — the render after it is.

**Found in review:** three defects in the first cut, two of them caught by the
PR's bot reviewers and one by a human reading the same diff. Guarding `submit` on `submitDisabled` before the dictation branch
made Send unreachable for a recording that had not produced a partial yet —
which is the whole recording, on a provider that only returns text at the final
commit. And `void dictation.stop()` discarded a promise that rejects when
finalization fails, so a failed stop reached the renderer's `unhandledrejection`
telemetry and was filed as a JavaScript defect. Stopping now comes before the
empty-draft guard, and one `stopDictation` helper consumes the rejection for
every fire-and-forget stop in the component, the five that predate this change
included.

The third was the window those two opened onto. A pending send had no way out
but the hook settling, and finalization runs to a 60-second completion timeout:
for that whole window Send spins, Enter returns on the pending flag, and the
field is read-only because `finalizing` blocks editing. Most of that predates
this change — stopping from the microphone already left the composer read-only
while finalizing — but Send became a second entrance to it and Enter stopped
falling through, so the composer could be wholly unusable for a minute with
nothing to press. A microphone press now cancels the pending send first,
leaving the drain to finish on its own, so one control always answers and the
transcript comes back to the draft rather than being posted.

**What a future change has to respect:** the submit that follows dictation runs
from an effect keyed on the settled dictation state, not from the click handler.
Anything that moves it back into the handler, however it awaits, reintroduces
the stale-closure drop. `workstream-composer-dictation.test.tsx` holds the line
by asserting on the finalized text rather than on the call, and its harness's
`stop` delivers the transcript before it settles precisely so that shape fails.
A dictation error is not a send: the draft stays, the error shows, nothing is
submitted.

### 2026-09-10 — Send is permanent chrome, not a control the first keystroke summons

**What changed:** The capsule composer's Send button renders whether or not
there is anything to send, `disabled` when there is not. `showSubmit` and the
`has-submit` class it drove are gone from `composer-input.tsx`, and with them
the CSS branch that gave the microphone the filled send treatment in an empty
composer: Send keeps that fill permanently, and the microphone is neutral
chrome at rest in every state. No host changed — both already passed
`submitDisabled` for an empty draft, so the disabled state is the one they
were computing all along. This reverses the "a non-empty draft adds Send" half
of the 2026-09-01 capsule entry; the rest of that entry stands.

**Why:** An empty composer had no visible way to send. Enter still submitted and
the affordance appeared with the first character, which is fine for someone who
already knows and useless for someone looking for it — the one moment a reader
scans for a Send button is before they have typed. It also moved the microphone
sideways mid-keystroke, so the control under the cursor changed identity while
the pointer was on it.

**Considered and rejected:** Keeping Send hidden and teaching the empty state
some other way (a hint, a tooltip on the microphone). That trades a control for
prose in the surface where space was the original constraint, and prose does not
answer "where do I click". Also rejected: hiding Send but reserving its box, so
the microphone would not move. That keeps the invisible-affordance problem and
adds a permanent gap next to it, which is the cost of the button with none of
its use.

**What a future change has to respect:** every host of `ComposerInput` must keep
passing a `submitDisabled` that is true for an empty draft. Both hosts also
guard inside their own submit, so a host that stops computing the prop correctly
gets a Send button that looks live and does nothing, rather than an empty
message — a quiet failure, and the reason the prop is worth keeping honest.

### 2026-09-10 — The capsule shows the model control again, as a pill

**What changed:** The message capsule renders the developer-mode model control
beside its attachment button, in both of the control's shapes, and its leading
grid column sizes to its contents instead of a fixed 42px. This reverses the
model half of the 2026-09-01 capsule entry below, which omitted the control; the
dedicated mention and microphone-menu controls stay omitted. It also supersedes
the sentence in the entry directly below saying the model picker is "still the
menu's second section where it renders": the picker has left that menu, so with
**Teach a task** gone the plus menu now holds its attachment item alone in a
debug build too.

**Why:** The control was not removed by that entry so much as relocated — the
choice moved into the composer-actions menu while the read-only pill stayed in
the toolbar layout, so one control had two homes and the answer to "which model
is this?" moved out of the composer at the moment it stopped being a question. A
substream's composer is capsule-shaped like every conversation, so it had
nowhere to show a pin at all, and substreams can now carry one.

**Considered and rejected:** Leaving the choice in the actions menu and adding
the pill only for the locked state. That keeps two homes and makes the read-only
pill more prominent than the decision it records.

**Consequences:** A capsule with no model control is pixel-identical — the
attachment button plus its 7px padding either side is exactly the 42px the
column was fixed at. One with a control spends its label's width out of the text
column. Both were checked in a real window, on the launcher, an existing work
stream, and a substream.


### 2026-09-10 — The dividers say what they are, and what a double-click does

**What changed:** Every resize handle in the shell now shows a two-line tooltip
on hover or focus: `Drag to resize`, and under it the quick action. That is the
navigation's handle, the work-stream sidebar's, and the right sidebar's. The two
sidebars offer the double-click they have always had, named in the direction the
next one would go, and the right sidebar's handle gained a double-click of its
own that restores `DEFAULT_RAIL_WIDTH`, clamped as the drag is. Naming the
navigation's also fixed the condition behind it, which had been derived from a
value that cannot carry it. Each of those three quick actions is
also on `Enter`, the key the ARIA authoring practices give a window splitter,
and the hint names the key beside the gesture. The hint is one primitive,
`DragHint` in `components/primitives.tsx`, and its second line is omitted
wherever the quick action is already guarded off.

**Why:** The double-click that collapses either sidebar has been in the code
since the sidebars were, reachable only by guessing, and the grip pill is the
one control in the shell with no words on it: it says a divider can be grabbed,
not what grabbing it does or that there is a faster way. Both are discovery
problems, and a tooltip is where the answer belongs: it costs nothing until
somebody is already reaching for the handle, which is the only moment either
fact matters.

**Considered and rejected:** Making the grip pill itself the tooltip trigger.
It is 16px wide inside a 12px pointer target that spans the whole divider, so
the hint would have appeared for a narrower gesture than the one that reveals
the pill, and hovering the divider anywhere else, which is a grab, would have
said nothing. Anchoring on the target instead needed no measurement, because
both dividers already centre their pill in it. Also rejected: leaving the right
sidebar's handle with a hint and no quick action, which would have made the one
handle that promises least the one a reader meets in a panel they opened
deliberately; it has a close control, so resetting the width is the action that
was missing rather than a collapse.

**Consequences:** `Tip` gained the four things this hint needs and the rest of
the app does not: a `className` modifier, `disableHoverableContent`, and the
`open`/`onOpenChange` pair that lets a caller take the answer over while Radix
keeps deciding when to open. A second hint of any kind reaches for `Tip` rather
than a sixth hand-rolled subtree. The navigation's "the window is forcing this"
is now the
shell's `sidebarConstrained` passed down, not a derivation, and a second reader
of that condition adds itself to the prop rather than inferring it again from
`compact`. A hint has a veto for the length of a drag, `suppressed`,
which each handle drives from the state that already raises its `.is-resizing`
class. It exists because a grab focuses the handle and a focus is how a tooltip
decides to open without waiting: without the veto a quick grab *opens* the hint,
and Radix's own dismissal cannot catch it, reading an open state from the render
before the focus. A handle that gains a drag gesture without passing its state
in gets the defect back. A handle's quick action also now has three statements
to keep in step: the `onDoubleClick`, the `Enter` branch beside it, and the hint that names
both. A guard added to one and not the others leaves the tooltip offering an
action that does nothing, or leaves the two routes disagreeing about when they
work. The hint is also the only place any of it is written down. Both sidebars have a test pinning the pairing, the
navigation against `forcedCompact` and the work-stream rail against a narrow
pane, and a third pins the right sidebar's reset, each exercising both routes. A
tooltip mounts a Radix popper on
every handle, which brings its own `ResizeObserver`: a test that stubs that
global for a sidebar now needs `unobserve` on the stub, and one that keeps only
the newest observer callback must narrow the pane before opening a hint rather
than after.

### 2026-09-10 — Artifact rows take the renderer's tooltip, through a shared `Tip`

**What changed:** An artifact row in the work-stream sidebar no longer carries a
native `title`; it is wrapped in `Tip`, a new primitive in `primitives.tsx` that
holds the `Tooltip.Root`/`Trigger`/`Portal`/`Content`/`Arrow` subtree once. The
row's tooltip opens to the right. `IconButton`, `StatusDot`,
`SocketStatusIndicator` and `AvatarStack` were moved onto the same primitive
without changing a prop between them — same sides, offsets, alignments and
delays.

**Why:** `title` is the platform's tooltip, not this product's: a different
delay, a different type, no arrow, no theme, and — the part that actually costs
something — nothing at all on keyboard focus. That matters most exactly where
these rows are, because the rail truncates every artifact title and the compact
rail hides it outright, so the tooltip is the only way to read the row. The
primitive came with it because the same five-element subtree was hand-rolled in
nine files; a tenth copy to fix one row is how a portal or an arrow gets left
off. Placing it to the right was the second half: below, it covered the next
artifact, which is the row a reader is most likely to want next.

**Considered and rejected:** Keeping `title` alongside the Radix tooltip. Both
fire on a long hover, at different delays, which the sidebar facepile had already
rejected on 2026-08-30 for the same slot-level reason. Also rejected: converting
the rail's conversation, substream and **New substream** rows in the same change —
they have the same native `title` and the same truncation, but they were not what
this change set out to fix, and `Tip` is now sitting there for whoever does.

**What a future change has to respect:** `Tip` takes `asChild` semantics from
Radix, so its child element becomes the trigger. A child whose `className` is a
callback — a `NavLink` — cannot be slotted directly and needs a plain wrapper to
be the trigger, which is why `sidebar.tsx` still builds its work-stream preview
by hand. Do not give a row both `Tip` and `title`.

### 2026-09-10 — The artifact section is named Artifacts and appears only when full

**What changed:** The work-stream sidebar's second section is headed
**Artifacts** rather than **Generated artifacts**, on both its `aria-label` and
its `h2`, and the whole `<section>` — heading included — is dropped while the
work stream has no `artifact`-direction resource. Its placeholder row and the
`.workstream-context-empty` rules that dressed it are gone with it.

**Why:** "Generated" was doing no work in the rail. Every resource under that
heading is one the work stream produced; the word only distinguished them from
sources, which this section never shows, so it said nothing to a reader while
being the half of the label that got truncated away in a 280px rail. Absence
follows the same reasoning: an empty conversation is the ordinary opening state,
and a heading plus a "No generated artifacts yet" row spent 60px of a rail
shared with substreams and participants to report it. `AttachedSidekicks` had
already settled that question one section down by returning `null`.

**Considered and rejected:** Keeping the heading and hiding only the placeholder
row. That leaves a heading with nothing under it, which reads as a load failure
rather than as an honest empty. Also rejected: keeping the empty state and
shortening only the label, which fixes the smaller half of the problem.

**What a future change has to respect:** The section is the artifact list's own
element, so anything added beside it — a count, a control, a filter — arrives
inside that guard or it resurrects the empty heading. `.workstream-context-empty`
no longer exists; a section that wants an empty state defines its own rather
than reaching for that name.

### 2026-09-10 — Turn to turn closes onto the hover row

**What changed:** `sys.space.stack.gap`, the space a turn owns above itself
when the row before it is also a turn, goes from eight units (32px) to one
(4px). Nothing else in the rhythm moves: a turn beside an event is still four
units and event to event two, so turn to turn is now the smallest distance in
the feed.

**Why:** Both kinds of turn keep an action row under themselves that is laid
out always and painted on hover (Rally's Copy, Speak, Image, PDF and New
substream strip, and the person's New substream), about 18px tall with 8
above it under an answer and 4 under a bubble. At 32px the row a reader
hovered floated in the middle of a 58px void between Rally's answer and the
person's reply, and two people talking in the room sat 54px apart, which read
as separate conversations rather than one exchange. The gap was tuned in a
real window, on screenshots of Rally's hovered strip with a person's reply
under it, and came down in steps: four units, the strip's height rounded down
to the scale; three, judged one unit too loose; then one. At one unit the
strip itself is what keeps the next turn off the last, and the gap is only
the clearance under it. The first cut had added a fifth gap, a closer one for
a person's turn after a person's turn only, and was withdrawn when the ask
turned out to be every turn: two tokens at one value would have been a name
with no second reader. Turn to turn now sits under both the turn-to-event and
the event-to-event gaps. The three were tuned separately, each on its own
screenshots, and the ordering is what those tunings produced rather than a
rule; a later tuning of any of them should not assume the others follow.

**Review then found** that the clearance was not the turn's own everywhere:
the person's action row was rendered only where the turn could start a
substream, so on an automation's conversation, a substream other than the main
one, the launch provenance, an answered elicitation, and a turn still in
flight, the next turn sat 4px under the bubble itself. The slot is now laid out
on every person's turn, with the control inside it only where one exists, and
holds its height (`min-height` at the 20px step) when empty, so the one-unit
gap means the same thing on every surface that reads the token and a turn's
footprint no longer depends on which screen draws it. Rally's answer already
carried its row on every surface once settled.

**Review also found** that the row after a stretch of transcript this client
has not loaded took the turn gap as its default, whatever kind of row it was,
and that default had just become the closest distance in the feed: two rows
with an unseen stretch between them, an event row included, would have drawn
tighter than two consecutive tool rows, and nothing else marks the seam. The
seam has its own gap now, `sys.space.seam.gap`, at the eight units the turn
gap used to be, and `feedRowGap` returns it for any row carrying
`precededByTranscriptGap` before it looks at the kinds on either side. It is
a token rather than a reuse of the block gap because the seam is not a turn
beside an event: it is two rows that are not adjacent, and the distance is
the only thing on screen that says so.

### 2026-09-10 — A seeded conversation shows a connecting card and composes without sending

**What changed:** When the local cache seeds a conversation's caches, the
surface renders the remembered transcript under a small floating
`ConnectingCard` and passes `sendBlocked` to the composer; range loads, the
jump, the search jump, and read acknowledgements wait for the live snapshot
the way they wait for a reconnecting socket. Once the snapshot replaces the
seed the card goes and the composer sends; a draft typed meanwhile survives.

**Why:** A conversation painted from the disk is readable at once, which is
the point of the cache, but everything that reads or writes against the
room's transcript fence has nothing to read it against until the room has
spoken. Sending in particular would position an optimistic row against a
fence the room had not confirmed and report a message sent into a
conversation whose live state the person had not seen.

**Considered and rejected:** Reusing the socket hook's existing queue-and-resend
semantics for a send over a seed. Those are right for a socket that dropped
mid-session, where the transcript on screen is the room's own; a seed is not.
Placing the card in the composer dock beside **Jump to latest**, which would
put two floating controls in one slot.

**Consequences:** `feedFromLocalCache` is a fourth readiness input beside the
socket state, the payload check, and the positioned conversation; a new range
or acknowledgement path has to wait on it too. The composer's `sendBlocked`
is the one way to disable sending without disabling the draft.
[`local-cache.md`](local-cache.md) owns the seed itself.

### 2026-09-10 — The composer's action menu drops "Teach a task"

**What changed:** The second item in the message capsule's plus menu is gone,
along with the `onTeachTask` prop that carried it through `WorkstreamComposer`
into `ComposerInput`, the work-stream host's `navigate('/automations/new')`
handler behind it, and the `.composer-teach-task-icon` rule that coloured its
mark. Outside a debug build that leaves the menu at attachment alone; the
model picker under it (a separator, a **Model** label, and the radio group,
rendered only when `model && debugEnabled && model.kind === 'choice'`) is
untouched, and still the menu's second section where it renders. The create
screen the item opened is untouched too, and still reached from the product:
`AutomationScreen` hosts it at both `/automations/new` and `/sidekicks/new`
(the id `new` is the create), and the Sidekicks library's **New Sidekick**
button links to the second of those. The menu bar item's **New Automation** row
([`menu-bar.md`](menu-bar.md)) and the Slack agent emit
`rallywithai://automations/new`, which deliberately does
*not* land there: `app-session.tsx` routes that intent to `#/workstreams/new`,
because the builder the link once opened is gone and an automation is now
drafted by asking for one in a work stream. So this removal takes away the only
composer-side entrance, not the capability.

**Why:** The entry point was dropped as a product decision, so the shared
composer no longer offers it. Nothing was rehomed, because the prop was not a
composer capability to move: it was the work-stream host reaching a product
route through an optional prop on the shared input, which is what the boundary
above forbids, and removing the item removes the violation rather than relocating
it. No reasoning for adding the item was ever recorded: it arrived whole in
`3acc1987`, the GrokBot layout rebuild that landed as
[#551](https://github.com/juno-ai-labs/avalon/pull/551), which is to say it was
copied in with a borrowed layout rather than designed for this product — the
prop's own doc comment called it "GrokBot-style". A future change that wants a
second action here should add it as a capability the surface owns, not as an
optional callback a host fills with navigation.

Shipped in [#665](https://github.com/juno-ai-labs/avalon/pull/665).

### 2026-09-10 — Jump to latest hangs above the composer, whatever its height

**What changed:** The control is anchored to the composer dock's top edge from
underneath (`bottom: calc(100% + var(--space-2))` in `.jump-bottom`) instead of
sitting a fixed 5px down from that same edge. The gap it leaves is now the same
above a one-line message capsule and above a six-line draft with a queue over
it.

**Why:** The dock's height is the composer's, and the composer's is the draft's:
a wrapped message, a queued row, an error under the field. Measuring downwards
from the dock's top edge therefore put the control *inside* the field, and
further inside the taller that field grew, which is worst in the state a reader
is most likely to be scrolled away in, since a long draft is what pushed the
transcript up in the first place. Sitting in the field it also read as one of
the composer's own controls rather than as something belonging to the transcript
above it.

**Considered and rejected:** Giving the dock padding above the composer and
keeping the control in it. That reserves the control's height in the layout
permanently, so the transcript loses 38px whether or not the reader is away from
the end, and the control is mounted only while they are.

**Consequences:** The control overhangs the transcript rather than the composer,
which is what a control saying *you are not at the end* is for; on a full feed it
paints over the last row, and its own background, border and shadow are what keep
it legible there. It depends on the dock stating no padding above the composer:
give the dock some and the gap grows by that much silently.
`app.css.node.test.ts` holds both halves, because jsdom lays nothing out and no
component test can tell the anchors apart.

Shipped in [#662](https://github.com/juno-ai-labs/avalon/pull/662).

### 2026-09-10 — Multiline composer text spans above its controls

The message capsule now gives wrapped text and explicit newlines the same full
width input layout as attachments, with bottom padding reserving the plus and
send row. Keeping multiline text in the middle column left an empty gutter
above the plus, making the control look misplaced. Measurement uses the compact
width before applying the expanded layout so the wider text cannot make the
layout oscillate. Editing, draft restoration, attachment changes, and composer
width changes remeasure it; short text returns to the compact row. The mention
highlight layer shares the inset, and controls retain their raised hit targets.
Expansion and collapse animate the field height and text inset together over
220ms using the existing composer easing. Interrupted motion starts at the
current painted position, the initial render does not animate in, and
reduced-motion preference applies the final layout immediately.
Wrap measurement also runs beneath the forced attachment layout, preserving
multiline state when the final attachment is removed rather than briefly
returning the text to the compact column.

### 2026-09-10 — The both-host feed rules are the base rules

**What changed:** The 47 `app.css` rules scoped
`:is(.workstream-screen, .automation-chat-surface)` are un-scoped, and the
declarations they had been overriding are removed from the base rules under
them (`.tool-block`, `.tool-block summary`, `.tool-icon`, `.tool-summary` and its
`strong` and `small`, `.tool-details`, `.agent-message-actions`);
`.tool-completed .tool-state`, whose only declaration was overridden, is gone,
as is a second `.human-message .message-author` rule whose every declaration a
later rule replaced. `.workstream-screen`-only rules are untouched. Review
then found that no component applies `.automation-chat-surface` at all, so the
prefix had in practice named one live host rather than two; the last rule left
under that class, a profile-coloured bubble, is deleted with the rest.

**Why:** Those two classes are the only hosts that render the feed, so a rule
scoped to both was a base rule written as an override, and it forced a base rule
to exist underneath for it to beat. Twelve base rules had every declaration
shadowed that way, and the ordering hazards this stylesheet's tests keep
warning about (two rules tying on specificity, source order deciding) were
mostly this pattern. A scan before un-scoping found one place where the change
would have altered which rule won, the human author line, where the
work-stream theme's own rule already carried the winning value; the duplicate
was deleted rather than re-ordered. Shell-scoped and work-stream-scoped rules
stay as overrides because they are ones: the shell has a second sidebar form
and the work stream has a bubble the automation surface does not.

### 2026-09-10 — The feed's spacing is one scale and one rhythm

**What changed:** Every margin, padding and gap in the feed is now a whole
multiple of `ref.space.unit` (4px), through the `--space-1` to `--space-8`
steps `app.css` derives from it, and the space between rows is set in one place:
each row owns the space above it, keyed on what precedes it, through the
`data-row-gap` `MessageFeed` computes from the message list. Turn to turn is 32px, a turn beside an
event is 16, event to event is 8, and Rally's answer sits 8 above the work that
produced it. The per-row bottom margins (`.message-block` 58, `.transcript-event`
28, `.agent-work-timing` 26, `.system-message` 20, the status pill 12/18, the
notices 26) are gone, as are the two negative-margin rules that clawed a turn's
58 back when a tool or timing row followed it, the work-stream theme's second
header margins (7 and 5 against the shared 8 and 4), its `padding-left: 2px`
on the agent turn, and its `+ 4px` on the column padding. Prose tightened with
it: paragraphs 16, headings `24 0 12`, lists `12 0 16` with 4 between items,
blockquote and rule 24, code and table 16, and the answer's last block is trimmed
inside the heading collapse, which had been leaking a full paragraph gap under
every heading-led answer. The tool disclosure sits on a 24px row with no padding
and details at `4 0 4 16`, the accordion's rows are 4 apart, the elicitation
panel is 12 with 8 above its options and actions, the column is 32 on all sides
(24 below 760px, the chevron outdent's floor), and the bubble's `8px 12px` moved
from a literal on the theme rule into the shared bubble rule as `--space-2
--space-3` (by way of `cmp.bubble.padding`, which had been 0 and which the
entry above retires: a token read once was a name with no second reader).

**Why:** A measured pass over the live feed found 184 spacing declarations
using every integer from 1px to 18px, three tokens covering three of them, and a
vertical rhythm that was the *sum* of each row's bottom margin and the next row's
top margin. The sums were the visible defect: the same system note sat 78px below
a bubble and 20px above the answer, two consecutive tool rows were 1px apart, a
status pill had 70 above and 38 below, and the author line had five different
gaps under it (6, 8, 7, 4, 5) set in four places. The negative margins existed
only because a turn set a bottom margin that its own work then had to undo. A
row that owns the space above it makes every gap one number with one owner; it
was preferred over a `gap` on the column, which the virtualizer's absolute rows
cannot use. The first cut decided the gap in CSS with a sibling combinator and
`:has()`, and review caught why that cannot work in a windowed feed: only the
rows in the virtualizer's window are in the DOM, so the first mounted row has
no sibling whatever its index, took no gap at the window's edge, and measured
a different height on either side of it, which the ledger then chased. The gap
is computed from the message list instead. The numbers themselves were
tuned in a real window across six candidates, with machinery rows and the drawer
compressed hardest because a receipt for work the reader has already read the
result of should read denser than progress. One unit token rather than eight
scale tokens because a theme has no opinion about step five that is not an
opinion about the unit. `docs/theming.md` records the token side.

### 2026-09-10 — The work-stream sidebar's contents travel with its edge too

**What changed:** The work-stream sidebar's rows, copy, section headings and
rules, empty state, avatars and footer toggle transition between the expanded
sidebar and the 96px rail over `--sidebar-layout-motion`, restated on that
sidebar and cancelled by its drag, the way the navigation's are in the entry
below. A substream's mark now renders both its branch line and its initial,
stacked in one grid cell, and the stylesheet cross-fades them; the line
settles its eight-pixel lift as the title goes. Compact centring by
`justify-content` is gone: marks are centred by the row's padding, the avatar
stack and the empty state's icon by a `translateX(calc(18px - 50%))` that
travels, and the footer's toggle by 32.5px of right padding.

**Why:** The same cut the navigation sidebar had, reported as a request to
animate the centre sidebar with the same care once the navigation's rows
travelled: only `flex-basis` glided while every row inside cut to its square
in the first frame, and the substream mark was swapped between two elements by
the component, which no stylesheet could ease. `justify-content: center` was
the one rule that could not be carried over, because it is discrete — flipping
it at the first frame throws the avatar to the middle of a still-wide row and
slides it back — and the avatar stack's width is a count nobody knows in CSS,
so a fixed padding could not centre it; a transform in the content's own
percentage can.

**Considered and rejected:** Keeping the component's swap of the mark and
fading the whole mark out and in, which reads as the row blinking. Wrapping
the avatar stack in the 36px mark box for centring, which clips a four-avatar
stack against the row's edge in the full sidebar. Animating the participant
limit — four faces to two — which is a count, not a shape, and is left to
change at the toggle.

**Consequences:** Both substream marks are in the document in both widths,
under `aria-hidden` on the slot as before; a test that counts branch lines in
the rail counts one under each initial. A rule that adds compact centring
here uses padding or a transform, not `justify-content`. The avatar size rule
restates the presence border's own 180ms fade, because a `transition` on the
same element replaces it; a change to that fade is made in both places.

Shipped in #648.

### 2026-09-10 — The navigation's contents travel with its edge, and search stays at the top

**What changed:** Everything inside the global navigation that changes shape
between the expanded sidebar and the 96px rail now transitions between the two
over the same 240ms the box's width spends: the rows narrow to their 36px
marks while their titles fade under a clip, the recency headings close to no
height, the group gaps and the scroll box's padding close, the titlebar's New
chat fades, the account row keeps its avatar and closes its name, the Sidekick
tiles shed their captions, and the search pill closes to its icon. The search
row moved out of the scroll box into a command bar under the titlebar, so it is
at the top in both layouts however far the list is scrolled; the rail's New
chat row is rendered there under it and arrives and leaves through the list
motion. The Sidekick strip stays below the list in both layouts. The interval
is stated once on `.sidebar` as `--sidebar-layout-motion`, which a drag sets to
`0s` while also taking the property off everything already travelling, and the
aside carries a registered `--sidebar-compact` number on the same interval
whose transition events, counted, tell the component when the layout has
settled, with the toggle raising the hold a frame ahead of them.

**Why:** Collapsing the sidebar was reported as only the edge animating: the
width glided and every row, heading and control inside it cut to its compact
shape in the first frame, so the reader watched an empty box close over rows
that had already become icons. The 2026-09-09 entry below animated the box and
left the contents to "re-lay-out rather than animate"; that was the cut.
Search and New chat cut hardest because the two layouts rendered different
elements in different places — a pill inside the scroll box, then a square
inside the scroll box above a second square — and the request was for the
search row to hold its place at the top in both layouts and for the New chat
row to use the row insert and remove motion, which
[`list-motion.md`](list-motion.md) now provides. Two rules follow from
transitioning the contents. Nothing on screen during the toggle is
`display: none` in the rail, because `display` cannot travel: hidden copy is
kept in layout at zero size and faded, with `visibility` on the same interval
so it leaves the accessibility tree when the fade ends. And every travelling
value is a number in both layouts — `width: 100%` for a row's wrapper rather
than `auto`, a heading's `height` rather than its `min-height` — because a
keyword cannot be interpolated and a rule that reaches one cuts. The command
bar is a two-track grid with numeric tracks for the same reason: the slot for
the New chat row opens and closes over the interval rather than the bar
growing by a row in the frame React inserts one.

**Considered and rejected:** Driving every row shape from the one interpolated
`--sidebar-compact` number through `calc()`, which puts one source of truth
under everything but makes each rule an equation nobody can read a width off.
`interpolate-size: allow-keywords` on the sidebar, which would have let `auto`
travel and saved the numeric restatements, but changes what every keyword
inside the sidebar means to a transition; it is used on the strip alone, where
a lone tile is sized to its caption. `@starting-style` for the rows' hidden
copy, which would also have faded in the title of every row that mounts. A
reduced-motion override of its own: the stylesheet's sitewide rule already
brings every transition to 0.001ms for that reader, the box's width included,
so the contents snap with the edge there as they always did, and the channel
is kept in the reduced-motion rule only so its events still bracket the
change.

**Consequences:** A rule that changes a shape between the two layouts declares
its transition on `--sidebar-layout-motion`, or that shape cuts; a shape that
needs a keyword in one width cuts. The titlebar's New chat is hidden by the
`hidden` attribute in the rail rather than unmounted, and the rail's is
rendered only in the rail, marked `data-motion-insert`; a test that counts New
chat links sees one in either layout. `.sidebar-rail-new-button` is styled
without reference to `.is-compact`, because its stand-in is drawn after the
class has gone. The first section under the command bar drops its own top
margin, since the bar's bottom padding is the group gap the collapsed margins
used to provide. A stand-in overhangs the command bar into the list for 160ms on
expand, uncut, because the bar does not clip. React fills in `propertyName`
for `transitionend` alone, so the component reads it from the native event.

Shipped in #648.

### 2026-09-10 — The ↳ marks a substream's row; New substream is a plus

The product owner looked at the rail and asked for the swap: the Tabler
`border-corner-pill` on each substream row, drawn in the 10% sidebar-border
token, read as a grey smudge, while the `↳` on **New substream** read as an
"enter" arrow that belonged on the rows that are substreams. Each substream row
now draws a Tabler `corner-down-right` — the icon form of the same `↳` — in
muted text, and **New substream** went back to a Tabler `plus`. The eight-pixel
lift and the vertical flip the branch line needed went with it, and so did the
`.workstream-new-substream-mark` glyph sizing, since both marks are icons again
and take a `size` prop. This supersedes the same-day change that had given both
New substream controls one glyph: the sidebar's creation
row and the feed's `↳ New substream` control are no longer one glyph, and the
arrow's meaning in the rail is "this is a substream", not "start one". A change
that puts the arrow back on the creation row has to give the substream rows a
different mark first.

**Rejected:** keeping the single glyph and only recolouring the branch line off
the 10% token. It answers the contrast half of the complaint and leaves the
meaning half — an arrow on the one row that is not a branch — exactly as it was.

The launch banner's `border-corner-pill` is deliberately not part of this: it is
drawn in `--av-sys-color-text-default`, so it is legible where the rail's was
not, and whether a creation surface should carry the plus is a separate product
question about a different surface.

Shipped in #656.

### 2026-09-10 — The assistant identity line starts where its prose does

**What changed:** The work-stream theme no longer insets `.agent-message >
header` by 18px, so "Rally", the response body and the action row under it all
begin on the article's own left edge. An invariant in
`app.css.node.test.ts` holds the header free of a left inset under both its
selectors, matching on the value rather than on one spelling of the property.
The human-side check opposite it gained the same widening: both now cover
`padding-inline`, which is the logical spelling this stylesheet actually uses and
which set the inset straight through the old patterns.

**Why:** Rally's turn carries no avatar, so nothing ever occupied the gutter
that padding reserved: the name simply hung 18px right of everything beneath it,
which reads as an accident rather than as an indent. The inset predates the
current tree and no reasoning for it was recorded; nothing in the header is
positioned against it. A future mark to the left of the name belongs in the
header as an element, so that the row lays itself out around it and the text
under it stays where it is.

**Consequences:** Anything added left of the author name has to bring its own
space. The human identity line is unaffected: it is inset from the *right* by
`--turn-bubble-radius`, which is a different rule for a different reason.

### 2026-09-09 — Bound connection startup and preserve ticket lint coverage

**What changed:** Moved the existing 10-second connection deadline to capture
startup, covering tickets and backlog delivery, with cancellation propagated to
the API request. Batches wait for socket pressure to subside. Removed the unused
connecting state and taught the ticket lint rule to follow immutable aliases.

**Why:** Review identified that a stalled ticket could strand Stop and retain
audio indefinitely before the old socket-only timer began. A deadline already
exists for this connection; extending its scope avoids inventing a second cap.
The ticket alias is authenticated and should be checked by lint rather than
excluded from it.

**Consequences:** Startup can no longer wait indefinitely on a ticket or outbound
pressure, and late ticket results cannot revive expired capture. Permission and
device setup precede the network budget; callers see local recording while the
service connects.

### 2026-09-09 — Capture dictation while the service connects

**What changed:** Local capture and its recording indicator precede service
readiness. Per-attempt PCM buffering drains in order on acknowledgement, and
Stop preserves recordings made entirely during connection setup.

**Why:** Waiting for the network before starting the worklet lost the first
words spoken after clicking the microphone. Replaying the backlog at real time
would retain that delay throughout the recording, so transport sends the original
frames in larger transport batches while preserving their samples and sample rate.

**Consequences:** Local listening and remote readiness are separate facts.
Commits must await the drain, and cancellation must release both buffered audio
and late-arriving inputs. OS audio startup still bounds the first captured sample.
### 2026-09-09 — Attachments follow the message, author ends at the corner

**What changed:** Attachments follow human bubbles and assistant prose, before
turn actions. Human headers put the username last in DOM and visual order.

**Why:** The reported file appeared above the words referring to it, while the
timestamp occupied the identity alignment edge. This supersedes the September 2
header order: the existing radius inset now belongs to the username.

**Considered and rejected:** CSS ordering would diverge from screen-reader order
and leave optional context labels ambiguous. Explicit human header markup keeps
context adjacent to the identity. Assistant attachments use a slot before the
actions rather than following the entire content-and-actions component.

**Consequences:** Preserve body → attachments → actions and keep optional header
metadata before the author so its trailing edge stays aligned with the corner.

### 2026-09-09 — A sidebar travels between its two widths

**What changed:** Collapsing or expanding either sidebar is animated over 240ms
rather than cutting between the two widths. The navigation's
`--av-cmp-sidebar-width` is registered with `@property` as a `<length>` and
transitioned on `.workspace-shell` beside `--rail-width`; the work-stream
sidebar transitions both the `flex-basis` that draws it and the
`--workstream-sidebar-width` it publishes to the shell. A drag is the exception:
`.is-resizing` drops the width from the transitioned set for the length of the
gesture, so the edge still lands exactly on the pointer.

**Why:** The double-click on the edge was reported as not reading like a
toggle — 280px to 96px in one frame is closer to a re-render than to a panel
closing, and the reader has to re-find the transcript, which has also jumped.
The motion is attached to the *width* rather than to the double-click handler
that prompted it, so the toolbar buttons, ⌘B, and the constrained-window
breakpoint all animate for free and no caller has to remember to; carrying it on
the custom property means the panel, its grab handle, the room `.main-pane`
leaves for it, and the composer centred over that room move as one thing instead
of four rules kept in step by hand.

The work-stream sidebar needs two channels rather than one because it draws
itself from `flex-basis` and *publishes* its width separately, as
`--workstream-sidebar-width`, for the shell's `--rail-max-slot`. Transitioning
only the one that draws left the published copy stepping to its final value in a
single frame, so with the inspector open and capped by that slot, the inspector's
width jumped by up to 184px while the sidebar beside it was still travelling —
the same cut, moved to the other side of the window. Registering the published
property and transitioning it on the same interval is what keeps the two halves
of the window telling the same story.

**Considered and rejected:** Animating `width` on `.sidebar` and `margin-left`
on `.main-pane` separately. That works for the two obvious elements and silently
leaves behind everything else measured from the same property, which is how a
panel and its handle part company. Also rejected: making the double-click
handler play an animation, which would have left the button and ⌘B cutting. And
rejected for the work-stream sidebar: sizing its `flex-basis` from the published
custom property to collapse the two channels into one, which would have made the
component's own width depend on finding a `.workspace-shell` ancestor — correct
in the app, silently wrong anywhere else it is rendered.

**Also in this change, because animating the width made them wrong:** a path
that grabs or repeatedly writes the width can no longer assume the rendered edge
and the width state are the same number. The navigation's resize handle now
measures the panel on `pointerdown` instead of reading `effectiveSidebarWidth` —
the work-stream sidebar's handle already did — because the handle is drawn at
the rendered edge, and an offset taken from the state was wrong by whatever the
animation had left to run and stayed wrong for the whole drag. Grabbing the
handle mid-flight ends the animation at its target rather than continuing to
glide under the pointer, which is the deliberate choice: the drag then tracks
absolutely from where the pointer is. Arrow-key resize raises the same
suppression a drag does, for as long as the key is held, on both sidebars; left
animated, each 16px step restarted the curve and the rendered edge trailed the
width the collapse threshold is judged against, so the sidebar snapped to the
rail at a width the reader never saw. Neither is reached through `resizing`
itself, which also arms the window pointer listeners — a mouse moved during a
keyboard resize would otherwise take hold of the edge.

**Consequences:** The duration lives once, at `:root` in `app.css`, as
`--sidebar-collapse-motion`; it is deliberately outside the `--av-` namespace
because no theme has an opinion about it, and `themes.css.node.test.ts` lists it
as rule-local for that reason. Two things must stay true: an unregistered custom
property cannot be interpolated — dropping the `@property` block brings back the
cut, at half the duration and with no error — and a drag must keep its opt-out,
or the sidebar trails the pointer. A double-click is two grabs of the same
handle, so the second release has to clear `.is-resizing` before the toggle
lands; both sidebars have a test pinning that, because the failure is a missing
animation on exactly the gesture that asks for it and nothing else reports it.
Each drag drops only its own
channel and restates the other two, so dragging one sidebar cannot stop the
other — or a rail closing on its own — from moving; that re-pairing works by
position and holds because all three entries carry the same 240ms and curve.
`prefers-reduced-motion` needs nothing here: the global kill switch in `app.css`
zeroes every duration.

### 2026-09-09 — Both action rows share one set of button metrics

**What changed:** The agent and human action rows take their button metrics from
one `:is(.agent-message-actions, .human-message-actions) button` rule; the
substream control declares only `white-space: nowrap` of its own. The human row
also dropped an inert `justify-content`.

**Why:** The control's own class restated the row's metrics, and inside the agent
row `.agent-message-actions button` outranks it — so that copy won on Rally's
turn and lost under a person's bubble. The values agreed, so nothing looked
wrong; tuning either row would have moved the control in one place and not the
other, silently. This is the same failure the corner-radius token exists to
prevent. The `justify-content` was inert because the row is shrink-to-fit inside
a column that already aligns it, and it read as if it were doing the work the
padding does.

**Consequences:** Button metrics for either row go in the shared rule. A CSS
invariant test holds it, and asserts no `.agent-message-actions button` rule
comes back to shadow it.

### 2026-09-09 — Keep the cutoff on a turn that carries no prose

**What changed:** The assistant action row renders for the substream cutoff
alone, not only when the turn has text, and copy, speech and the exports are
withheld from a turn whose text is empty.

**Why:** Moving the cutoff out of the identity line moved it behind that row's
"has text" condition, and a settled turn may legally carry attachments and an
empty string — the contract's text block accepts one. Such a turn is still a
place to branch from, and it silently stopped offering it. The text-bearing
actions stay gated because each acts on the response text: an empty clipboard,
silence, and a blank card are worse than an absent button.

**Consequences:** The row's presence and its contents are two questions now. A
control added to it declares which one it answers — whether it needs the text,
or only the turn.

### 2026-09-09 — Align the human action row on the bubble's corner, through the token

**What changed:** The action row under a human turn takes
`padding-inline-end: var(--turn-bubble-radius)`, so it ends where the bubble's
straight edge ends and the curve takes over — the same vertical the identity line
above it stops on. The work-stream theme, which rounds that bubble harder than
the shared default, now restates the corner by setting `--turn-bubble-radius`
rather than writing `18px` onto `border-radius` and onto the header's
`padding-right`.

**Why:** The row was flush with the bubble's widest point, so it read as hung off
the corner rather than as part of the turn. Fixing that exposed the drift the
token was introduced to prevent: two literals in the theme agreed with each other
but not with the token, so a third rule reading the token came out inset by the
shared 14px against an 18px corner.

**Consequences:** The corner is one number in one place. Read it with
`var(--turn-bubble-radius)`; to change it for a surface, set the token on that
surface's `.human-message`. A CSS invariant test in `app.css.node.test.ts` holds
both halves — that the bubble, the header and the action row all read the token,
and that the work-stream theme moves it by the token rather than by a literal.


### 2026-09-09 — The per-message substream cutoff joins the action row

**What changed:** The **New substream** control moved out of the message identity
line into the turn's action row, last after Copy, Speak, Image and PDF, with a
one-control row under a human turn's bubble for the same action.

**Considered and rejected:** Moving it only on assistant turns, which would have
left the same action in two places depending on who spoke.

**Consequences:** The two placements keep identical metrics — the control takes
the row's font size and padding rather than restating them — and the label stays
unbroken (`white-space: nowrap`), because its two words wrap mid-control in a
narrow row. Its accessible name contains its visible words, so voice control can
reach it by what it says; the row's other buttons already read that way.

**Why:** The identity line answers who spoke and when; an action wedged between
the author, the timestamp and the turn's labels competed with that. Everything
else a settled turn can be asked to do already lives in the action row.

**Consequences:** A control added to either row inherits the row's hover fade and
must not declare its own opacity — nesting the two multiplies them and renders
the inner control paler than its neighbours.

### 2026-09-09 — A substream's initial identifies it in the collapsed rail

**What changed:** In compact mode a substream row's mark is the first character
of its title, capitalized, instead of the branch line. Expanded rows are
unchanged, and a title with no first character still falls back to the line.

**Why:** Compact hides every title, so the row shape that had just been unified
left the substreams as a column of identical curves — legible as "these are
substreams", useless for picking one. The main conversation already carries the
work stream's own icon there, so the substreams were the only rows in the rail
with nothing of their own to show. A creator avatar was the obvious alternative
and was rejected: it says who started a substream, not which one it is, and
several substreams from one person collapse back to identical marks.

**Consequences:** The mark is title-derived, so it changes when a substream is
renamed — deliberate, since it is a compressed title rather than an identity.
Two substreams sharing a first letter still collide; the row's `title` attribute
and its accessible name carry the full title in both modes.

### 2026-09-09 — One row shape across both navigation rails

**What changed:** The center sidebar's conversation rows lost their borders and
took the navigation sidebar's work-stream row: a 36px leading mark, a 14px/500
title, and the shared idle/hover/current fills. The main conversation's mark is
the work stream's own icon tinted with its appearance colour (`WorkstreamMark`,
beside the existing filled `WorkstreamGlyph`); a substream's mark is the branch
line, which moved out of its wrapper and into the row's own slot, so substream
rows are full width like everything else in the rail. **New substream** followed
the same shape, losing its dashed border and outer connector.

**Why:** Product asked for both streams to read as the work-stream row they sit
under. The rail previously said "one bordered box per conversation" while the
navigation beside it said "one row per stream", and two boxes with the same fills
but different borders read as two lists rather than one. This reverses
[2026-09-04's "keep navigation quiet"](#2026-09-04--keep-navigation-quiet-and-park-the-right-sidebar),
which had made this row text-only on the grounds that the glyph was already in
the main sidebar and the feed header: the identity is repeated deliberately now,
in a lighter form — a tinted symbol rather than a second filled glyph — because
it is what tells the main conversation apart from its substreams at a glance.

**Consequences:** A substream row no longer carries its creator's avatar; the
private children come from the parent control socket and creator attribution now
lives only in the substream itself. The rail needs the parent's `appearance`,
which the host passes alongside the parent title, so a colour or icon change
lands on this row on the same receipt that moves the sidebar row. The branch
line keeps its eight-pixel lift so its endpoint meets the title, and drops it in
compact mode, where there is no title to meet.

### 2026-09-08 — Rename Main and children in the title bar, scoped to the selected conversation

Both header layouts use the same inline name editor. Single-clicking a title
opens a selected text field; its tooltip explains that Enter saves. Escape
cancels, and failed saves retain the draft. The editor resets when the selected
conversation changes, including between Main and a child sharing the parent ID.
The compact header previously rendered inert text while the older header required
a double click, so neither matched the requested direct editing interaction.

Child rows offer rename and archive using the parent-addressed child API. A
child rename changes its detail cache and child directory; only Main rename or
scope events update the workspace work-stream list. The old unconditional cache
write visibly renamed the parent. Archive returns the selected child to Main;
late action responses cannot navigate a different work stream. Main participants
remain in the sidebar and Main title bar; child facepiles manage their own roster.

### 2026-09-08 — Separate Sidekick management from its conversation

SidekickDetailLayout owns a scrollable profile beside the shared conversation,
with Conversation/Details switches based on the host width, including when
embedded beside the main sidebar. Inactive panes retain layout boxes with
`visibility: hidden` and are inert, preserving measurements, drafts, and sockets.
A visibility context prevents hidden panes from claiming paste or marking reads. The
header-only design left the feed competing with schedules and run history;
those controls now live entirely outside ConversationSurface. Run history is
behind More → Run history, while the first view explains how to ask for changes.


### 2026-09-08 — Remove heading-generated document cards

**What changed:** Removed the H2 card parser, stacked cards, modal paging, and
host opt-in. Assistant responses use the existing inline Markdown path.

**Why:** Product direction explicitly removes the heading card maker, reversing
the 2026-09-01 section-card decision. Keeping it hidden behind an unused prop
would retain functionality that was requested to be removed.

**Consequences:** Shared heading collapse and complete-source copy/export remain
available; H2 headings no longer create cards.

### 2026-09-08 — Keep composer controls above attachment drafts

The workstream and new-chat capsule composers' tool and submit areas explicitly
stack above the input shell, which is positioned for its highlight overlay.
Attachments expand that shell across the controls' grid row, allowing the
textarea to intercept clicks on Send and composer actions even with short or
empty text. The reported case was a long pasted chat; Enter still submitted.
Keeping the controls above the shell preserves the existing layout and send
guards instead of changing submission behavior. The control areas' padding also
receives pointer hits rather than placing the caret in the textarea underneath.
The CSS contract test guards the scoped stacking declarations; verify pointer
clicks in a real window because DOM-only tests cannot detect this overlap.

Shipped in #591.

### 2026-09-05 — Correct row identity and retained animation lifecycle

Plugin and other non-text rows now consume their own arrival identities rather
than a shared turn ID; only text reconciliation uses client/turn identity.
The live-ID set is memoized and arrivals are scanned only when their inputs
change, avoiding unrelated scroll-render work. Retained activity and jump motion
share one lifecycle, reverse an in-flight animation instead of restarting it,
and hold the final exit paint until removal. Hidden-window transitions skip
motion. Tests cover same-turn groups, hidden/reduced-motion suppression, and
both re-entry/reversal paths with hook-owned animation doubles.

Blanket row animation remains rejected: it would replay loaded history and
destabilize the measured feed. Motion stays on the existing inner paint layer,
using the reference's arrival scale/easing rather than changing its visual
language in response to subjective review preferences.

### 2026-09-05 — Animate live arrivals without moving the measured row

The feed consumes event/command-origin arrival IDs once per mounted feed,
including offscreen rows, and animates only an inner paint layer. Snapshots and
history ranges do not opt in; client/turn identity prevents reconciliation from
replaying an entrance. This preserves the virtualizer's measured geometry and
avoids the earlier scroll oscillation. Reduced motion and hidden windows skip
arrival motion. The jump control remains mounted, disabled and hidden from
accessibility during its short exit, cancelling that exit if shown again.
Transient compaction/fallback activity uses the same retained-exit principle;
grouped plugin arrivals use a small scale entrance. Settled activity remains in
the normal transcript/accordion rather than being removed for a visual effect.
Reactions and general message-anchor navigation have no current product surface,
so this change adds neither dormant styling nor new interaction semantics for them.
`conversation-motion.test.tsx` covers replay suppression and exit reversal.

### 2026-09-05 — Remove the resource-management entry point and popup, and optically align substream connectors

Removed the center-sidebar management button, its host callback, and the resource
list mode of the lightbox at product request. Individual artifact previews and
details remain; the parked right-sidebar architecture is unchanged. A detail
lightbox cannot navigate back into the removed management list.

The flipped Tabler connector is shifted up eight pixels so its right-hand
endpoint, not its SVG box, meets the button's vertical center. This applies
equally to existing substreams and New substream, without changing row spacing
or color.

### 2026-09-05 — Keep the center sidebar at work-stream scope

The work-stream host supplies its live parent detail separately from the selected
conversation. Sidebar artifacts, participant rows, previews and management actions
use that parent detail and update the parent cache, even on a direct child link.
This avoids replacing shared navigation with a private child's inventory or roster.
The feed, its citations, composer and private membership remain child-addressed;
the sidebar does not aggregate or publish private child resources. Parent-resource
uploads from a child return to Main log, where the work-stream attachment draft
lives, rather than silently placing a shared upload in the private composer.

### 2026-09-04 — Address private substreams throughout the desktop surface

**What changed:** The work-stream sidebar now lists viewer-visible private
children from the parent control socket, keeps Main as an explicit destination,
and opens a two-step prepare/preview/confirm dialog. Child selection stays under
the parent route while socket caches, initial context, attachments, text drafts,
and participant mutations use the full parent/child identity. Resource
management is withheld in a child until it has a child-addressed mutation path.

**Why:** A private child is a distinct conversation, not a filter over the main
feed. Reusing parent-only draft or mutation identities could leak an unsent
message or modify main while the child looked selected. The preparation preview
also makes the context boundary visible before the irreversible confirmation.

**Consequences:** Parent chrome and the control socket remain stable while the
feed switches. Main retains its released draft key for continuity; child keys
append the substream identity. Do not reintroduce parent REST mutations as a
fallback for child controls.

### 2026-09-04 — Preserve resource capabilities without a right sidebar

**What changed:** Reused the inspector's resource content in a controlled
lightbox. Generated sites retain their dedicated native viewer; unavailable
files have no download action, and failed downloads report an error. Preview
state closes on route changes. The dormant resize handle now reads the same CSS
limit as the frame, including the actual middle sidebar width.

**Why:** Parking the rail removed the only route to resource management and
incorrectly sent site manifests through file conversion. Restoring shell entry
points would violate the requested navigation; duplicating management would
create two implementations to maintain.

**Consequences:** Keep shell rail state inert. Native artifact content must hide
behind nested dialogs/menus and remain clipped to the lightbox viewport. Share
resource actions across hosts rather than rebuilding their authority or APIs.

### 2026-09-04 — Keep navigation quiet and park the right sidebar

The middle sidebar's conversation row is text-only: the work-stream glyph is
already present in the main sidebar and feed header. Compact mode omits that
redundant row instead of leaving an empty icon button; artifact and participant
navigation remain available.

The global work-stream list now shows titles without descriptions or participant
stacks. Only unread rows add a last-change timestamp. Command-number navigation
and its hint overlay are removed. Participants remain available in the dedicated
work-stream sidebar, rather than repeated on every global navigation row.

The right inspector architecture is retained, but `RIGHT_SIDEBAR_ENABLED`
disables its shell host, header controls,
space reservation, and native window expansion. Artifact selection from both
the transcript and the middle sidebar opens the same lightbox; missing previews
show an explicit error there, never a hidden inspector or an endless spinner.
This reverses the previous explicit-inspector fallback at the user's request.

The dormant frame was compared with the running Grok Bot window and the installed
0.39.0 renderer (the relevant rules also agree with the earlier 0.35.0 extraction):
`sand-info-pane` uses a 240ms width transition with cubic-bezier(.22, 1, .36, 1),
and its inner content fades over 160ms with ease. Its background is the editor
surface, with no floating border radius or shadow. Its preferred width defaults
to 320px with a 280px minimum; the visible width preserves 424px for conversation
rather than using the former fixed 560px ceiling. The divider is a full-height
0.5px neutral line in a 10px drag target, with a 120ms hover-color transition.
Preserve those mechanics in the retained frame; its resource contents now also
serve the lightbox. Do not re-enable shell entry points for resource actions.

### 2026-09-04 — Coordinate the two sidebar breakpoints

**What changed:** The shell reserves the compact context rail in addition to
the conversation minimum on existing work-stream routes. Route-switch tests
target the current sidebar button rather than the now-repeated title.

**Why:** With a 400px navigation sidebar, an 860px window previously left only
372px for the transcript after the context rail. Independent breakpoint checks
were insufficient; the outer shell must account for both rails without changing
automation or new-work-stream layouts. The citation hook also exposes its
always-present preview handler in its return type instead of a silent optional call.
Transcript focus now passes through the surface's own ref-backed callback instead
of searching the sidebar's parent DOM; a real screen test covers the connection.

**Consequences:** Keep the compact context width in the outer reservation when
changing rail geometry, and preserve the existing route-switch cleanup assertions.

### 2026-09-04 — The work-stream sidebar supports direct resizing

The sidebar's icon toggle alone did not provide the requested direct width
control. Its trailing divider now reuses the navigation grip and width/drag
thresholds, with pointer capture, cancellation cleanup, keyboard resizing, and
an independent persisted width. Pointer coordinates are relative to this
sidebar's leading edge, not the window, so dragging never includes the first
sidebar's width. The enclosing pane remains the measurement authority and the
424px conversation reservation still bounds expansion.

### 2026-09-04 — Work streams gain a collapsible context sidebar

The layout exploration calls for work-stream identity, generated artifacts,
and participants to remain available beside the feed, without adopting its
different visual styling or implementing substreams yet. A host-owned sidebar
now presents those three sections using the current Grok navigation dimensions
and paint. Reusing the live detail and citation preview path avoids a second
resource query and preserves the explicit-open rule. The automation host does
not opt in, and global navigation keeps its own layout and collapse preference.
Observing the enclosing pane instead of the resized child prevents a feedback
loop when space requires icon mode.

### 2026-09-04 — Review fixes preserve the reference layout without losing behavior

**What changed:** Sidebar search walks subsequent directory pages and offers an
explicit retry when a page fails. Compact links keep their accessible identity.
The shell subscribes to the sidebar breakpoint rather than every pixel of a
window resize. Inspector geometry owns only its applied width delta, adjusts
when the rail width changes, and never restores stale position/height or exits
native maximized/full-screen modes. Unmounting the shell releases that delta.
The new-chat close control appears only when there is a return destination.

**Why:** PR review found regressions introduced while moving the presentation
onto the shared foundation. Filtering one loaded page hid reachable chats;
restoring a saved rectangle overwrote subsequent user window changes.

**Reference check:** The installed Grok Bot 0.39.0 archive still specifies an
88px compact sidebar, 280px default expanded width (240–400px), a protected
424px conversation, 210/220px drag thresholds, and 54px navigation rows. These
values and the existing light/dark paint were retained. The real reference
window was inspected; no generated reference code is added to the repository.

**Consequences:** Media retains the requested theater without Preview/Source or
extra persistent controls. Gallery selection is established before loading;
Radix alone owns modal Escape handling and scroll locking. Attachment MIME
authority and video suffixes are shared with staged and sent tiles. An HTML
preview establishes its network-denying policy before any supplied markup.
Streaming document sections remain ordinary streaming Markdown until complete,
so an unfinished Mermaid section is not interpreted as a settled diagram.


### 2026-09-04 — The Grok presentation stays an adapter over the shared conversation foundation

**What changed:** The Grok-style work-stream screen now renders through the
shared `ConversationSurface` introduced on main, including addressed socket
commands, attachment state, and work-stream-only document cards. Opening a
resource remains an explicit user action: receiving an embed no longer opens or
resizes the inspector automatically. The presentation's literal light and dark
colours were also moved onto the theme system's semantic surface, row, text,
border, status, scrim, and elevation tokens.

**Why:** Rebasing the visual branch onto the shared conversation architecture
left a half-old screen: it imported a deleted auto-open hook, skipped the
work-stream document-card opt-in, and carried colours that bypassed the theme
registry. Keeping a second composition to preserve the visual rewrite would
immediately recreate the feed divergence this module removed.

**Consequences:** Presentation changes belong in the shared surface and its
explicit host options; product semantics remain in the work-stream adapter.
Theme-specific paint must be expressed through registered tokens, and an
attachment or embed may open a preview only from a person's click.

### 2026-09-04 — The automation header asks before deleting, offers only what the object accepts, and hears its own chat

**What changed:** `components/delete-automation-dialog.tsx` is the one
confirmation an automation's deletion goes through; the sidebar's modal moved
into it and `components/automation-header.tsx` opens the same dialog from its
Delete item instead of firing the tombstone from the menu. The header offers
Run now only on an active automation and disables Apply while paused, with
the tooltip saying to resume first, matching what `AutomationDO` accepts.
`lib/workspace-socket.tsx` invalidates the `automation` and
`automation-runs` queries whenever the `automations` sidebar list is pushed.

**Why:** Pull request review. Delete from the header was an irreversible
operation with no question where the sidebar had always asked one. Run now
while paused and Apply on a paused automation both answered `409` from the
object, so the header offered commands guaranteed to fail. And when the
automation's own chat submitted a revision, the object pushed only the
sidebar list, since no HTTP request of the desktop's was in play to publish a
sync topic; the page's detail query never heard, so Create stayed disabled on
a stale definition until a remount or a window-focus refetch.

**Consequences:** Every automations list push now costs a detail refetch on
whichever automation pages are mounted, which is one at a time. The sidebar
and the header cannot disagree about what deleting means: one dialog, one
copy.

### 2026-09-03 — An automation's chat is the same feed, under an automation parent

**What changed:** The conversation surface is addressed by its parent through
`/conversations/:parentId` and the conversation feed socket, and an automation's
own chat is that surface over substream `0` of the automation. On the desktop,
`screens/conversation-surface.tsx` is the one composition, taking `parentKind`,
`parentId`, `substreamId`, and a `renderHeader` slot; the work-stream screen
and the automation screen are hosts over it, and the automation screen's header
carries the lifecycle controls. There is no compiler, no narration stream, and
no draft-specific feed state; the drafting tools are a plugin the ordinary loop
loads.

**Why:** [`automation-lifecycle.md`](automation-lifecycle.md) records why the
automation was rebuilt as a conversation parent. For this document the point
is narrower: the entry of 2026-09-01 below retired the second adapter, and the
second *surface* is now retired with it, because an automation's conversation
is a `SubstreamAgent` like any other.

**Consequences:** A change to the feed family has one caller and two hosts,
the work-stream screen and the automation page, which differ only in the
controls they keep beside the feed. Any control that belongs to the automation
(apply, pause, the run list) stays on its page, not in the family.

### 2026-09-03 — Child feed state cannot leak into or outlive its parent cache

**What changed:** Child transcript turns no longer advance the parent's flat
sidebar attention row. Access revocation evicts only the addressed child, while
parent archive/removal clears every child cache family. Shared detail
invalidation fans out across both the stable main-room key and the child
namespace.

**Why:** Introducing an independently keyed child feed made the old parent-only
prefix invalidation incomplete and let a child turn change unread state on a
different conversation.

**Considered and rejected:** Returning child data to parent-shaped keys would
restore cross-substream cache collisions. Leaving cleanup to cache expiry would
retain data after access or the parent lifecycle ended.

**Consequences:** Parent, child, and sibling caches remain isolated during live
updates, while parent lifecycle mutations still invalidate or remove the whole
owned family.

Shipped in #541.

### 2026-09-02 — Work-stream conversation controls use their substream connection

**What changed:** the shared work-stream socket adapter now exposes message,
elicitation-answer, pending-input reorder, stop, and retry commands. The screen
uses those commands while its rendering and optimistic behavior stay unchanged.

**Why:** those controls act on the conversation child, and the feed already
selects that child. Keeping transport in the adapter lets the same feed and
composer be hosted under a different parent without teaching shared components
about work-stream REST.

**What a future change has to respect:** shared conversation components remain
transport-neutral; a parent adapter provides the addressed substream connection.

### 2026-09-02 — One open-row set, for every kind of collapsible row

**What changed:** `SystemRowDisclosure` is `RowDisclosure`, the `MessageBlock`
prop is `rowDisclosure`, and `MessageFeed` holds a single `expandedRows` set
that now serves two kinds of row: the clamped system note, and the work
accordion a settled run collapses into
([`plugin-activity-rows.md`](plugin-activity-rows.md)).

**Why:** The type was already general — a set of message ids and a toggle — and
its docblock's reasoning was about virtualization, not about system rows. The
second collapsible row needed exactly the same thing for exactly the same
reason, and message ids are unique, so a second state beside the first would
have been the same feed state split in two with nothing deciding which half a
new row belongs in.

**What a future change has to respect:** the set lives above the virtual window
on purpose. A row that scrolls away open and comes back closed re-measures
shorter than the size cache expects, and the virtualizer declines to compensate
a re-measurement during a backward scroll, so the transcript jumps under the
reader by the whole delta.

### 2026-09-02 — Stabilise the GrokBot conversation UI: settled media, live row heights, sidebar previews and icon rail, attachment treatment, and oversized turns

**What changed:**

- *Settled media:* Sent-image attachments and citation contexts now key their
  asynchronous previews by the semantic content of the attachment or resource
  records, rather than the JavaScript identity of the arrays carrying them.
- *Row heights:* A settled code block now keeps the same React component type
  when refreshed mention or citation metadata reparses its surrounding Markdown,
  so a finished Mermaid diagram remains mounted. The work-stream feed's
  virtualizer also measures each rendered row from its current border box on the
  next animation frame instead of accepting the size carried by an earlier
  ResizeObserver notification.
- *Sidebar previews:* Every work-stream row now opens the same compact preview
  card to its right after a short hover or focus delay, whether the sidebar is
  the expanded list or the 88px icon rail. The card repeats the source's 16px
  compact identity glyph, name, relative activity time, and at most two lines of
  the standing row preview. The navigation row itself keeps GrokBot's separate
  36px identity inside a 54px-high row and a 54px-wide compact selection seat. A
  plain positioning wrapper anchors the preview so Radix never receives React
  Router's callback-based row class and cannot strip the expanded row's layout
  classes.
- *Icon rail:* The GrokBot shell now has the same two sidebar forms as its
  reference: a 280px default expanded list that remains resizable from
  240–400px, and an 88px compact rail containing centered work-stream glyphs,
  the bottom New chat action, and the account avatar. Compact preference is
  persisted and toggled with Command-B. The layout also enters compact mode
  whenever the current window cannot fit the saved expanded width beside a
  protected 424px conversation. The edge resizer collapses below 210px and
  expands at 220px, matching the reference's hysteresis.
- *Preview theater:* Image and video previews now open over a dimmed copy of the
  conversation, centered at their natural fit, with one top-right control that
  switches between fit-to-window and full-size. The filename, zoom strip,
  download, close, caption, and thumbnail chrome no longer surround media. HTML
  opens directly in the inset document preview; its Preview/Source switch is
  gone.
- *Attachment feed treatment:* Message images now preserve their intrinsic size
  within a 560-by-200-pixel envelope; image batches become a compact three-tile
  row with a folded-count overlay and gallery navigation. Other attachments
  render as compact filename-and-size cards with a separate download action.
  Image previews gained fit/full-size control and keyboard gallery navigation;
  HTML files gain a sandboxed rendered surface, while the existing text,
  Markdown, audio, and resource-history previews remain available.
- *Production-data pass:* Long human turns now collapse inside their existing
  bubble with GrokBot's faded **Show more** treatment, and the disclosure state
  lives above the virtual window so scrolling a row away does not reset it. The
  active GrokBot shell also selects the independent floating account card
  instead of the workspace-switcher presentation. Mention filtering now
  considers a member's email as well as their display name.

**Why:**

- *Settled media:* Transcript composition filters attachments into a new array
  on every render, and socket hydration may replace a work stream's resource
  array without changing a record. Treating either allocation as new media
  cleared settled thumbnails, revoked their object URLs, and restarted the same
  reads. The clear itself rendered again in the attachment case, producing an
  indefinite thumbnail/skeleton loop whose alternating row heights made the
  virtual feed stutter and correct its scroll position back and forth.
- *Row heights:* Switching between the expanded sidebar and the icon rail can
  reflow a long answer by thousands of pixels. Production hydration also
  refreshes message metadata independently of the stored text; the previous
  inline code renderer looked like a new React component on every such refresh,
  so a rendered Mermaid diagram repeatedly collapsed to its source fallback.
  More than one resize notification may already be queued while those shapes
  change; replaying an older height made the virtual transcript chase the same
  oscillation, and bottom-follow exposed the disagreement as a vertical twitch.
- *Sidebar previews:* Collapsing the sidebar correctly protects conversation
  space, but it also removes the name and latest-message context that makes an
  icon meaningful. GrokBot solves that loss with one stable hover-card contract
  rather than a compact-only tooltip, so the interaction does not change when
  the window does.
- *Icon rail:* Treating every sub-920px window as a hidden mobile drawer removed
  the navigation entirely at the size where GrokBot preserves spatial context
  with a rail. A fixed CSS breakpoint also diverged as soon as the person
  resized their sidebar: the reference derives its threshold from the saved
  expanded width.
- *Preview theater:* The prior lightbox exposed every available operation at
  once. GrokBot's preview is deliberately quieter: the content is the modal, the
  conversation remains visible behind it, and Escape or the surrounding scrim
  closes it.
- *Attachment feed treatment:* The old renderer reduced every sent attachment to
  the same square tile, which hid the content hierarchy visible in the reference
  application and made a web page, a screenshot, and a downloadable file look
  interchangeable.
- *Production-data pass:* A production transcript paste expanded to tens of
  thousands of pixels, the bottom account control reopened Rally's old workspace
  UI, and a person whose query matched only their email produced an apparently
  missing `@` menu. All three failures were visible-shell behavior; none
  required changing durable messages, workspace authority, or mention payloads.

**Considered and rejected:**

- *Settled media:* hiding the movement with a transition or weakening virtual
  row measurement. Both would leave the repeated network reads and object URL
  churn intact, while making the virtualizer less accurate about the DOM it
  actually has to place.
- *Row heights:* weakening bottom-follow, delaying every resize, or caching
  rendered SVG across component lifetimes. The reader was still at the end and
  the browser already had the correct current layout, so the first two would
  hide or prolong the virtualizer's stale measurement. A process-wide SVG cache
  would retain unbounded conversation content to repair a component that did
  not need to unmount in the first place.
- *Sidebar previews:* A label-only tooltip in compact mode. It would leave
  recent activity undiscoverable and make the expanded and compact rows behave
  differently even though they represent the same destination.
- *Icon rail:* A media query at 704px. That only matches GrokBot's default 280px
  sidebar; it is wrong for every saved width between 240 and 400px and cannot
  represent a manual compact preference at a large window size.
- *Preview theater:* Keeping the source switch only for HTML. Source is not the
  presentation a person asked to preview, and download remains available in the
  document header when they need the file itself.
- *Attachment feed treatment:* Importing the extracted GrokBot renderer bundle.
  That code is application-specific and minified around private protocols.
  Rally reimplements the visible behavior over its existing authenticated
  content loader, and HTML previews deny scripts and network access instead of
  acquiring another trusted renderer origin.
- *Production-data pass:* Truncating stored message text would make the rest
  unrecoverable, and moving workspace switching into the Grok card would
  recreate the chrome this branch intentionally removed. The complete turn
  remains one click away, while the existing workspace presentation and
  mutations remain implemented for surfaces that opt into them.

**Consequences:**

- *Sidebar previews:* The preview is informational and pointer-transparent; the
  row continues to own navigation, warmup, drag, and context-menu behavior. Keep
  its source-matched 260px width, 8px offset, 10px inset, 12px radius, and
  two-line clamp in sync if the sidebar row contract changes.
- *Icon rail:* The GrokBot shell keeps 88px of left navigation at narrow desktop
  sizes instead of exposing the old drawer trigger. Row text, search, section
  labels, participant clusters, timers, and command-shortcut badges are
  presentation-only hidden in compact mode; the work-stream links keep their
  accessible names and their existing navigation, context-menu, drag, unread,
  and socket-warmup behavior.
- *Preview theater:* Gallery arrow keys and visible previous/next buttons remain
  for multi-image messages, but single media previews have only the
  fit/full-size control. Previewable block resource embeds use this same surface
  instead of the right inspector; true live generated sites keep their dedicated
  runtime panel. HTML keeps the existing scriptless, network-denying sandbox.
- *Attachment feed treatment:* Assistant and human attachments retain their
  existing side alignment. A feed row may eagerly fetch image bytes for
  thumbnails, but non-image content remains lazy until preview or download. The
  lightbox locks body scrolling while open and restores focus to the invoking
  control when it closes.
- *Production-data pass:* Human and agent turns keep the same bounded width
  rules. A collapsed human turn is additionally bounded to the reference card
  height and re-measures through the existing feed virtualizer when opened. The
  account card does not fetch background-workspace counts merely because it
  opened.

**What a future change has to respect:**

- *Settled media:* transport and composition layers may recreate arrays around
  unchanged records. An asynchronous media effect must restart only when one of
  the fields it consumes changes; a metadata-only refresh must keep the settled
  preview mounted.
- *Row heights:* message rows are width-sensitive and can be much taller than
  the viewport. Their virtual measurement must describe the DOM at callback
  time; do not reintroduce cached or queued-entry geometry as the authoritative
  row height. Metadata-only Markdown refreshes must also keep the code
  renderer's component identity stable.

### 2026-09-01 — Sidebar creation moves into GrokBot's titlebar row, and the work-stream input becomes a compact message capsule

**What changed:** The work-stream creation action now sits alone at the right
edge of the macOS titlebar row, aligned with the traffic lights. Search occupies
its own full-width rounded row directly below it.

The active conversation now uses a 42-pixel empty composer with one attachment
action, one-line input, and a trailing voice action. A non-empty draft adds
Send, attachments expand above the writing row, and the main surface omits the
dedicated mention, microphone-menu, and model controls.

**Why:** GrokBot separates window-level creation from navigation filtering. The
previous shared toolbar made the plus a filled leading control beside search,
which changed both the hierarchy and the vertical rhythm of the reference
header.

GrokBot also treats input as a compact continuation of the conversation.
Rally's forced text height plus a second toolbar row made the empty field more
than twice as tall and left a large dead band under the transcript.

**Considered and rejected:** Absolutely positioning the plus over the existing
search row would resemble one screenshot while leaving the DOM and drag regions
as one toolbar. The two-row structure keeps the titlebar draggable and makes the
creation link an explicit no-drag target.

For the composer: shrinking the old two-row toolbar with global CSS would leave
its extra controls in the accessibility tree and would also alter the
automation and launch composers. Removing typed mentions, drag/drop, or
dictation was rejected because those are interaction capabilities rather than
the mismatched toolbar presentation.

**Consequences:** The search and work-stream list keep their existing behavior,
and only their top offset changes. Overlay scrolling no longer reserves a blank
strip beside either one, and the sidebar resize handle now begins below the
shorter titlebar row.

The main work-stream adapter explicitly selects the capsule layout. Typed `@`,
slash commands, attachment paste/drop, voice input, Send, Stop, draft
persistence, and bounded multiline resizing keep their existing handlers; other
composer hosts retain the shared default.

### 2026-09-01 — The GrokBot shell removes Rally-specific navigation chrome, and agent documents become paged section-card stacks

**What changed:** The active desktop shell now mounts a work-stream-only left
navigation and a compact centered conversation title that opens the details
rail. Project, automation, note, meeting, socket, HyperSight, participant-add,
and overflow controls are absent from those two visible chrome regions.

The main work-stream feed now splits Rally responses at top-level h2 headings,
represents those sections as 20-pixel-offset square cards, and opens them in a
modal reader that pages by controls, arrow keys, or horizontal swipe. Preamble
and heading-less responses remain readable inline.

**Why:** This branch is a frontend rewrite against GrokBot's three-column
conversation model. Keeping every existing Rally affordance visible would make
the result a restyled Rally screen rather than a faithful reconstruction; the
product-specific controls will be added back deliberately after the shell is
settled.

Structured agent output should be scannable as a document set without turning
long Rally prose into message bubbles or making readers expand several inline
accordions before they can move between sections.

**Considered and rejected:** Deleting routes, data queries, or mutations along
with their controls would turn a visual experiment into a product/backend
change and make later reintroduction needlessly expensive. CSS-only hiding was
also rejected because invisible controls should not remain in the accessibility
tree.

For the cards: replacing `MarkdownBody`'s shared heading behavior globally would
also change automation, attachment, export, and embedded preview surfaces.
Splitting on h3-h6 was rejected because those headings express structure inside
an h2 section rather than a new document card.

**Consequences:** Deep links and existing non-shell surfaces still work, but
they are no longer discoverable through the main left navigation. The centered
title is now the single details-rail affordance on an open work stream.

The main work-stream adapter explicitly opts agent turns into the card reader.
The source parser must continue to ignore heading-like text in code, lists, and
blockquotes, and the noninteractive export path must continue to emit the
complete response.

### 2026-09-01 — Work streams adopt the compact conversation shell

**What changed:** The main frontend now uses deterministic color/icon work-stream
identities, compact searchable navigation with participant face piles, attributed
right-aligned human bubbles, open Rally prose, an attached details rail, a small
plus attachment action, and a Rally-plus-people `@` picker. The Electron window
grows with the details rail when the display has spare width.

**Why:** The previous screen distributed one conversation across visually
unrelated navigation, feed, composer, and inspector treatments. The new shell
makes the work stream the stable visual object and keeps human and agent turns
immediately distinguishable without changing their durable contracts.

**Considered and rejected:** A theme-only skin could not change row hierarchy,
message attribution, mention candidates, or window geometry. Bubbling Rally's
output was also rejected because long agent prose is easier to read as an open
document and the product requirement keeps that distinction explicit.

**Consequences:** Shared renderer primitives retain neutral defaults; the main
work-stream screen opts into the new feed treatment. Work-stream ids now seed
appearance, so changing the hash or palette order is a visible migration.
Electron window geometry remains a narrow main-window-only capability.

### 2026-09-02 — Every human turn carries the same identity line, the reader's own included

**What changed:** `MessageBlock` no longer suppresses the header over the
signed-in person's own turn. Every human row — own, coworker, Slack-relayed, and
a settled elicitation answer — now renders the same three parts in the same
order: the person-accent dot, the author's name, and the time. The header is no
longer conditional at all; the `contextLabel` exception that was the only reason
it rendered over an own turn is now just one more part of the line, between the
name and the time. In `app.css` the human bubble's corner radius becomes a
rule-local `--turn-bubble-radius`, and the header takes it as
`padding-inline-end`, so the line stops where the pill's top edge stops and the
curve begins rather than overhanging the round of the corner.

**Why:** "you know who you are" is true of the turn you are typing and false of
the transcript you are reading back. A work stream is a room, and scrolling one
is reading a conversation: whose words these are and when they were said is the
same question about your own turn as about anybody else's, and the old rule made
the reader's own messages the one thing on screen with no time against them —
so the only way to date your own message was to find somebody else's near it.
Suppression also cost the feed its rhythm, because a column of turns that
sometimes has a line above it and sometimes does not reads as two kinds of row.

**Considered and rejected:** showing the time on an own turn but not the name.
It keeps the asymmetry it was meant to fix — a header that is one shape here and
another there — and buys a few pixels of height on the one row the reader is
least likely to be puzzled by. Also rejected: naming the corner radius twice,
once in the bubble and once in the header inset. The two must agree or the line
sits over the curve, and a mismatch of a few pixels on one line is exactly what
a screenshot pass looks past; `--turn-bubble-radius` makes the agreement
structural, and `app.css.node.test.ts` holds both rules to it.

**Consequences:** own and coworker turns differ only in the `own-human-message` /
`coworker-message` class and in the accent the author id resolves to; no CSS
distinguishes them, and nothing should start to — a class that changes the look
of your own turn is the rule this entry removed, coming back. Air, which aligns
turns to the leading edge, leaves the header flush there and the inset does
nothing, which is the same relationship on the other side.

**Two things a header that used to be suppressed had been hiding.** Both were
found in review, and both are the cost of making a line render that previously
did not:

- The settled-elicitation row never stated `--person-accent`. Both halves of the
  line resolve through it — the dot paints its background with it, the name takes
  its colour from it — so without it the dot's background is invalid at
  computed-value time and falls back to `transparent`, and the name, a colour
  being inherited, falls back to the ambient body text. Confirmed in a real
  window: stripping the property off a settled human row moves the dot from
  `rgb(79, 74, 158)` to `rgba(0, 0, 0, 0)` and the name to `rgb(26, 24, 20)`, and
  the dot vanishes. Both human rows now take the accent from one `turnAccent`
  helper rather than from a copied expression — "these two rows are the same row"
  is this file's claim, and a duplicated expression is how it stops being true.
- Answering an elicitation marks the assistant's *question* turn answered where
  it stands, and that turn carries no author record until the canonical human
  turn lands a moment later. The row was therefore labelled "Your elicitation
  response" while visibly attributing the reader's own answer to a "Workspace
  member". `MessageBlock` now takes `currentUserName` and names the reader from
  the session for exactly that window. `Workspace member` remains the fallback
  for a row that is genuinely unattributed.

### 2026-09-02 — An in-flight turn is the bubble it is about to become

**What changed:** `MessageBlock` no longer swaps a turn being sent for a
placeholder. `deliveryState: 'sending'` renders the ordinary human row —
attachments, bubble, text, header when a `contextLabel` needs one — and says it
is still going with the dimming a queued turn already uses plus a shimmer inside
the bubble. The fixed `176 × 40` box and `.message-skeleton` are gone.

**Why:** the placeholder was one size for every message, so the moment the room
accepted a turn the box jumped to the shape of the text it had been standing in
for — a resize on every send, and a long message resized a lot. It was also
hiding words the person had just typed and could still see in the composer they
came from, and hiding them from nobody else: the accepted overlay that replaces
it a few hundred milliseconds later renders that same client text, mentions
included, before the canonical turn lands.

**Considered and rejected:** keeping the placeholder but measuring the text to
size it. That is the bubble, drawn twice, with the second copy free to drift
from the first. Also rejected: leaving the row visually identical to a settled
one — a send can fail, and a turn that has not been admitted should not claim it
has.

**Consequences:** the in-flight row is the settled row's layout, so a change to
the human bubble now reaches the sending state without being asked to. The
sending state's only geometry is `overflow`/`position` on the bubble, for the
shimmer to clip against; anything else written under `.is-sending` will drift
from the row it is supposed to be indistinguishable from. What the optimistic
turn does not carry, the row does not draw, which is why `optimisticMentionRendering`
now builds its text and mentions: a mention chip is rendered *from* the
`[@Name](person://<id>)` Markdown in the message text, which the composer's draft
does not have, so the bubble showed a plain `@Name` that widened into a chip at
the canonical turn — the one width change this row still had in it. That rewrite
is the room's `prepareMentionMarkdown`, moved into `@rally/contracts` and called
by both sides rather than written twice; a second implementation would have to
agree with the first about escaping, overlap, ordering, and which selections are
dropped. Only the *rendered* text is rewritten — what is sent is still the draft
the person typed, and the room rewrites its own copy.

The shimmer hangs off `.human-message-content`, not the bubble: a send can be
attachments alone, and the bubble is drawn only for a turn with text. Under
`prefers-reduced-motion` the sweep is parked over the row rather than travelling
across it, because the global reduced-motion block would otherwise run it once
at 0.001ms and leave it clipped outside the wrapper — an in-flight turn with no
cue at all, and less marked than a queued one.

*Superseded on 2026-09-13.* The sweep no longer hangs off the wrapper, and the
sending state writes no `overflow` on anything: it is painted on each surface
the turn draws, and clips itself to that surface's corner. The 2026-09-13 entry
above has the mechanism and why the wrapper was left.

### 2026-09-01 — An automation's result is a message in the room, named Automation

**What changed:** `automation_activation` is a participant message type, and
`MessageBlock` renders it as the ordinary authored row with `Automation` in the
author slot. The check sits *ahead* of the system-row branch and keys on the
type rather than the author, because Rally appends the row on the automation's
behalf and it therefore arrives with a machine author.

**Why:** A system row means "Rally is noting something that happened *to* this
work stream" — a wake-up fired, a watched resource went stale — and it carries a
renderer, a projector rule, and a reader's expectation to match. An automation's
result is none of those things: it is what somebody in the room is being told,
and it should read like every other thing they are told.

**Considered and rejected:** a row kind of its own. It would need its own empty
and error states, its own answer every time this family changes, and a reason
for every one of them — to present something a reader already knows how to read.
The author line does all of the work a bespoke row would have done.


### 2026-09-01 — One feed component, and the draft conversation stops being a second one

**What changed:** `message-feed.tsx` exists. Until now this document named it and
the file did not: the ordered list lived inline in `workstream.tsx`, and
`new-automation.tsx` mapped its turns through `MessageBlock` by hand. Both
screens now render `MessageFeed`, and the draft conversation gets what only the
work stream had — collapsible assistant headings, system-row disclosure, and the
placeholder for a message too large to draw. `useMessageFeedVirtualizer` sits
beside the component and is called by the *adapter*, because the work stream
drives that instance for anchor restore and for reading which rows are on screen.

**Why:** The split was invisible in the block and total in the loop around it.
Every row prop the work stream passed — `collapseHeadings`,
`systemRowDisclosure`, `citations` — was a decision the draft screen never made,
so a long assistant answer folded into sections in one surface and ran flat in
the other, from the same markdown. Nothing about a draft made that right; it was
just the screen that had been written second.

**Considered and rejected:** Windowing the draft feed too, for symmetry. A draft
holds its whole conversation in memory, pages nothing, and ends with the
compiler loop, so virtualization buys it nothing — and it costs something real:
`getVirtualItems()` measures the scroll element with `getBoundingClientRect`,
jsdom lays nothing out, and a virtualized draft feed renders zero rows under
test. Nineteen tests went dark when it was tried. The `virtualizer` prop is
optional and the rows are identical either way, so this is a windowing strategy
the adapter picks, not a second presentation.

**Also:** citations stay absent on the draft feed, as the prop's own docblock
already said. A citation chip resolves against a work stream's resources and
opens the rail; a draft has neither, so a citation there degrades to its label
text. That is the "sharing stops at product semantics" line, not a gap left
open.

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
transcript pills. Reorder is a private substream-socket command whose canonical
queue state remains visible to every viewer.

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

**Consequences:** Written when two adapters shared this family. Shared
interaction changes needed coverage in both adapters,
while product-specific controls remain locally typed and visibly absent from
the other surface.
