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

Sidekick authoring uses the shared conversation surface in a separate library window. Generated descriptions summarize instructions; ready submissions save immediately. The center workstream sidebar replaces participant rows with a facepile and, below them, lists this work stream's Sidekicks: the ones it owns and the ones its main conversation has loaded, in one section, with access-checked removal of an attachment affecting future executions. `ConversationSurface` owns both queries and hands the merged rows to the sidebar and the inspector rail, so the two rails cannot disagree about what a room has.

## Where the code lives

- `apps/desktop/src/renderer/components/conversation-follow.tsx` owns the
  **Jump to latest** and transient `ActivityPresence`, sharing retained motion.
- `apps/desktop/src/renderer/components/agent-work-timing.tsx` owns every row in
  that 20px-mark column: `AgentWorkTiming`, which counts, and the two that name
  a state instead — `AgentCompactionIndicator` and `RunStoppingIndicator`, both
  one call to the `ActivityStatusRow` primitive. A third state goes there, not
  into a third copy of the row's `role`, live-region attributes and orb props.
  `conversationActivityRow` in `screens/conversation-surface.tsx` is the single
  decision about which of them the feed's activity slot shows;
  `conversationShowsStoppingRow` beside it is the separate question of whether
  the composer dock acknowledges a pending stop, and the two are separate
  because only one of them lives inside the scroller.
- `apps/desktop/src/renderer/components/message-feed.tsx` renders the ordered
  list itself — every row, the unread divider, the oversized-message
  placeholder, and row disclosure — and `workstream-blocks.tsx` renders
  the human, assistant, tool, activity, attachment, and failure rows it
  composes. Both adapters render `MessageFeed`; windowing is the one thing it
  takes from its host, because only the paging surface needs it.
- `apps/desktop/src/renderer/components/primitives.tsx` owns `Tip` and
  `TipGroup`: a hover explanation, and the group a row of controls shares one
  delay and one provider through. A new tooltip comes from there rather than
  from Radix's five parts; eight files still assemble those by hand and predate
  it.
- `apps/desktop/src/renderer/lib/window-activation.ts` answers the one question
  every one of those surfaces has to ask before it opens: whether the hover or
  the focus it is looking at came from the person or from the window being
  brought to the front. `App` installs it per window; `Tip` and the sidebar's
  row preview ask it, and anything else that opens on hover or focus should.
- `apps/desktop/src/renderer/components/expanded-composer.tsx`,
  `use-draft-text.ts`, and `use-file-attachments.ts` provide the common composer
  shell, local text persistence, and staged-file lifecycle.
- `apps/desktop/src/renderer/screens/conversation-surface.tsx` is the one feed
  composition: `ConversationSurface({parentKind, parentId, substreamId,
  renderHeader})` owns the transcript, composer, attachments, and the socket
  hooks for one conversation, keyed by the parent id and substream. Its
  composer draft is `workstreamDraftKey` over the parent id, whichever kind of
  parent that is. `screens/workstream.tsx` renders it for a work stream;
  `screens/automation.tsx` renders `components/automation-header.tsx` in a sibling profile pane
  through `SidekickDetailLayout`, with a short conversation heading over the feed with `parentKind: "automation"` and `substreamId:
  "0"`. Tool rows are not rendered one per call: they collapse into one row per plugin, which
  [`plugin-activity-rows.md`](plugin-activity-rows.md) owns entirely. The
  retired automation-draft adapter kept a row per call, which is the divergence
  that made the collapse a decision worth recording rather than an obvious one.

## Contract

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
above it, which `app.css.node.test.ts` holds for every rule naming either
class.

Every surface with a composer renders the same one, dressed the same way: the
message capsule, keyed on `:is(.workstream-screen, .workstream-launch-screen)
.workstream-composer.is-message-capsule` — one 44px pill on a 22px corner, a
42px-tall field, the plus in the left column and the send or dictation control
in the right. `ComposerInput` takes `layout: 'message-capsule'` on all four
surfaces (the conversation, the new-substream dock, a workspace-level new chat
and a project-owned one), and no surface states a treatment of its own. Wrapped
text and staged attachments span the controls' own grid row, so the reserve at
the foot of the field is what holds the two apart: the 28px control, the 7px of
row padding under it, and 4px of air between the last line and the top of the
plus. A
launcher that dressed its field differently made the element a person types
their first message into the odd one out on a screen already showing the
conversation it becomes, and it made the hand-off a costume change.

The run's Stop action is an icon after Send, sharing the microphone's circular
neutral background, with a tooltip that explains the
current action or pending stop. Its mounted, inert-when-hidden slot animates its
width and horizontal translation together: the microphone and Send move left
as Stop slides through the capsule's clipped right corner, and return as it
slides out. Both control groups center in the single-line row; multiline and
attachment layouts keep them bottom-aligned. CSS transitions reverse in place on rapid state changes and are
removed for reduced motion. A pending stop shows a spinner and remains hoverable for its tooltip
but cannot submit another stop request. The capsule's rounded overflow clips
the moving button; tooltips portal outside it. `IconButton` tooltips do not duplicate
the button's accessible name as a second screen-reader description.

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

Once a member-requested stop settles, the feed renders it as an intentional
terminal state with a filled stop-square and no recovery action. The stopped
prompt remains transcript history; continuing means composing a fresh turn,
not replaying the stopped request. Failed runs remain a separate state and keep
their Retry action.

The composer's width is the conversation's, not the pane's, and it is one width
across every surface that has a composer. A turn is capped at `--turn-width-cap`
(640px, in `app.css`); `--composer-width` is three quarters of that, and the
field is centred on it, so the field and the bubbles it produces read as one
column rather than as a full-width row under a narrow transcript. Four rules read
that property: the composer stack under `:is(.workstream-screen,
.workstream-launch-screen)` — which is the settled conversation, the new-chat
screen and the new-substream dock, because a launcher is a conversation that has
not happened yet — plus the two rows a launcher stacks over its field, the
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
narrows when a sidebar expands and widens when one collapses, where a viewport
media query would have answered for a width nobody is looking at. A size query
measures the container's content box, so the number in the query is that pane
width less a dock's two 16px gutters. Every dock states the same gutter, because
a dock that states a different one crosses at a different *pane* — and a launcher
that crosses somewhere else puts the width change back into the hand-off, in a
band of pane widths either side of the threshold. `app.css.node.test.ts` holds
the threshold and every dock's gutter to that one sum.

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
trailing rows, the live timer and the run notices, take `sys.space.block.gap`
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
`ComposerInput`. An automation's page keeps its lifecycle controls (apply,
pause, resume, delete, run now, the run-history dialog) outside the feed rather than
inside it. Neither host may smuggle those controls through an optional common
prop.

The work-stream host supplies `WorkstreamSidebar` through the surface's
`renderSidebar` slot, between global navigation and the feed. It displays the
current work stream, its viewer-visible private substreams, resources whose
direction is `artifact`, then participants from the same live detail/presence
state as the conversation. Every conversation row in it is the navigation
sidebar's work-stream row — borderless, one 36px leading slot, the same title
and the same idle/hover/current fills — and only the mark in that slot says
which conversation it is: the work stream's own icon tinted with its appearance
colour for the main conversation, a Tabler `corner-down-right` arrow for a
substream, and a Tabler `plus` for **New substream**. A substream being created has a row
of its own in that list, drawn with the arrow and carrying a title skeleton
until the child exists; it is the one conversation row that is not a button,
because the reader is already on the surface it stands for. See
[`substream-creation.md`](substream-creation.md#the-launch-surface). That arrow is the same
shape the feed's control draws as a text `↳`, and the two deliberately no
longer mean the same thing: in this rail the arrow says a row *is* a substream,
while on a settled turn it says *start* one. Compact shows the first character of a substream's
title, capitalized, in place of its arrow, because a rail of identical arrows
with no titles beside them says only that these are substreams; both marks
are drawn in the slot, stacked, and cross-fade over the collapse motion. The
main conversation's
mark reads the parent work stream's appearance off its **sidebar row** rather
than its cached detail, so a colour or icon change moves both rails on the same
receipt; the header stays on the detail, which is what retires the picker's
preview. See [`workstream-appearance.md`](workstream-appearance.md).
Artifact selection
uses `useCitations.openPreview` to open the artifact lightbox, including an
explicit unavailable-preview state rather than an inspector fallback; arrival
of an artifact never opens a panel. Generated sites open the existing isolated
native viewer inside a resource lightbox, not the file conversion endpoint.
**Artifacts** is absent, not empty, until the work stream has one — the way the
Sidekick strip below it already is — because a heading over a placeholder row
spends rail height saying a conversation has produced nothing yet, which is
every conversation's opening state. Each artifact row carries the renderer's own
tooltip through the shared `Tip` primitive, opening to the **right** so it covers
the feed rather than the next artifact, and never a native `title`: the rail
truncates a long title and the compact rail drops it entirely, so the tooltip is
how the row is read, and `title` draws it in the desktop's own type, after the
desktop's own delay, and not at all for a reader who arrives by keyboard. That is
the same rule the sidebar facepile settled — one tooltip language per slot, never
Radix and native together. It has no **Manage resources** button or
resource-list popup.
File previews still offer individual **Resource details**; their lightbox retains
refresh, watch, archive and version history, but no navigation to a resource list.
Changing conversations closes both lightboxes and pending resource dialogs.
Participants are one facepile button onto the
existing management dialog. Selecting a row switches the feed's substream; the
rail itself stays at work-stream scope.

Its device-local collapse preference is independent of the global sidebar.
Expanded width defaults to 280px and is draggable between 240px and 400px;
the icon rail is 96px (`COLLAPSED_SIDEBAR_WIDTH`), matching the existing Grok navigation. Its trailing-edge
handle also accepts Left/Right keys, and a held arrow key suppresses the
collapse animation exactly as a drag does — it is the same gesture reached from
the keyboard, writing the width over and over, and the class is raised on
`keydown` and dropped on `keyup` rather than after a guessed idle period. Width is persisted separately from global
navigation. Dragging below 210px collapses it; expanding requires crossing
220px, retaining the existing ten-pixel hysteresis. Reaching either width is
animated over `--sidebar-collapse-motion`, the one duration both sidebars spend,
except while a drag is in progress: the gesture must land on the pointer, so
`.is-resizing` takes the transition off for as long as it lasts. This sidebar
carries that width on two channels — the `flex-basis` that draws it, and the
`--workstream-sidebar-width` it publishes to the shell for `--rail-max-slot` —
and **both** are transitioned over that same interval. A change that adds a
third consumer of its width adds it to that set: a channel left untransitioned
reaches its final value in one frame and steps whatever reads it while this
sidebar is still travelling. It temporarily
collapses when its enclosing pane cannot fit the preferred width
plus the existing 424px conversation reservation. Only that pane is observed,
so collapse cannot change its own measurement and cause oscillation. All paint
uses the existing light/dark sidebar, row, text, and focus tokens; selectors are
scoped to the new component and do not change global navigation rows.

Neither rail ends a line it cannot fit with an ellipsis or a hard cut: the line
fades out. `@keyframes clipped-line-fade` in `app.css` carries a `mask-image`
whose last 24px go to transparent, and the rule under it lists every line the
two rails clip — a row title, the flex line a title shares with a system-work
cog, a row hint, a project name, a Sidekick tile's caption, the account row's
name and address, and a centre-rail row's name and subtitle. A mask rather than
a gradient painted over the line, because each of those rows has an idle, a
hover and a current fill and an overlay matched to one shows as a bar in the
other two.

The fade appears only where something is actually clipped, and nothing measures
anything to decide that. The mask rides a scroll-driven animation whose timeline
is the line's own inline scroller: a line whose text fits is not scrollable, its
timeline is inactive, and an animation on an inactive timeline contributes
nothing — so a title ending a few pixels short of the edge keeps its last
characters at full ink, which an unconditional mask would fade for no reason.
Renaming a row, dragging either rail, or collapsing one re-decides on its own.
The keyframe holds one value at both ends because nothing is meant to move; the
timeline is being asked a question about overflow, not used as a clock, and the
fill mode is what keeps the mask applied for the reader whose reduced-motion
preference forces every animation to 0.001ms.

Both longhands sit below the `animation` shorthand, which resets both of them,
and `app.css.node.test.ts` asserts their *positions* rather than their presence.
Duration is the milder of the two: the shorthand puts it back to `0s`.
`animation-timeline` is the one that costs the condition — reinstated above the
shorthand it falls back to the document's timeline, `auto` computes to `0s`
against that, the fill holds the 100% keyframe from the first frame, and every
listed line takes the mask whether it clips anything or not. That is the
unconditional fade this arrangement exists to avoid, reachable by a reordering
that looks like tidying, which is why the ordering is pinned and not merely the
three declarations. jsdom lays nothing out, so no component test sees any of it.

The global navigation's contents travel with its edge. Every rule in its
stylesheet that changes a shape between the expanded sidebar and the 96px rail
transitions on `--sidebar-layout-motion`, stated once on `.sidebar` as the
collapse motion; a drag sets it to `0s` for the transitions it would start and
takes the property off everything already travelling, since a running
transition keeps the duration it began with. The rows narrow to their 36px marks
while their titles fade under a clip, the headings close to no height, the group
gaps and the scroll box's padding close, the titlebar's New work stream fades,
the account row keeps its avatar and closes its name, and the Sidekick tiles
shed their captions. Nothing on screen during the toggle is `display: none` in
the rail — hidden copy is kept in layout at zero size and faded, with
`visibility` carried on the same interval so it leaves the accessibility tree
when the fade ends — and every travelling value is a number in both layouts,
because a keyword cannot be interpolated. Search sits in a command bar between
the titlebar and the scroll box in both layouts, a grid of two numeric tracks:
the pill closes to a 54px square in place, and the second track opens for the
rail's New work stream row, which arrives and leaves through
[`list-motion.md`](list-motion.md)'s insert motion. The aside carries a
registered `--sidebar-compact` number on the same interval, drawn from by
nothing; the component listens to the platform's transition events for it on
the aside itself to know when the layout has settled, and holds the list
motion until then.

The work-stream sidebar's contents travel the same way, on the same
`--sidebar-layout-motion` restated on it and cancelled the same way by its own
drag: its
rows narrow to their 36px marks as their copy fades under a clip, the section
headings close to no height as the section rules and their spacing arrive, the
substream mark cross-fades from arrow to initial, the participants' avatars
shrink into the square with their overlap, the empty state closes to its icon,
and the footer's toggle is carried to the centre by the footer's padding.
Nothing in it is centred with `justify-content`, which cannot travel: a mark is
centred by the row's padding, and content of no fixed width — the avatar
stack, the empty state's icon — by a transform of `calc(18px - 50%)`. It has no
list motion to hold and so carries no `--sidebar-compact`.

Both dividers say what they are. A grip carries no words, and the double-click
that collapses the sidebar beside it was written down nowhere, so each handle is
wrapped in `DragHint` (`components/primitives.tsx`): a `Tip` whose
trigger is the handle's whole pointer target rather than the pill drawn inside
it, so the hint and the pill appear for the same approach, and whose content is
centre-aligned, which lands it beside the pill without either side measuring the
other. Its two lines are the citation popover's two lines: the subordinate one
is dimmed to 0.72 and left at the tooltip's own size, which is how a tooltip
here says *secondary* and the only way it says it. The first line names the
drag; the second names the quick action in the
direction the next one would go, collapse while expanded and expand while
compact. That second line names a key as well as the double-click, and it has
to: the hint opens on focus as well as on hover, so its most likely reader is
the one who cannot double-click at all. `Enter` is the key, performing exactly
what the double-click performs and refused under exactly the same condition,
which is the action the ARIA authoring practices give a window splitter. That second line is dropped exactly where the gesture would be refused:
a window too narrow for the navigation's expanded width, or a pane too narrow
for the work-stream rail's contents, which are the same conditions that disable
each footer toggle. The navigation takes that condition as a prop,
`constrained`, rather than deriving it: `compact` is `collapsed || constrained`
and so reads the same for a sidebar the reader collapsed as for one the window
is pinning, and somebody who did both is held by the window. Derived as
`compact && !collapsed` it read false for exactly that reader, which brought
the footer toggle back to life, made the hint offer an expansion that could not
happen, and rewrote the saved preference to expanded for a widening that might
never come. Keeping the two in step is the point of the hint, so a new
guard on either double-click adds itself to the hint in the same change. The
right sidebar's handle takes the same hint from the same primitive, with one
difference in what it offers: that panel closes from its own header control, so
its double-click, and its `Enter`, restore `DEFAULT_RAIL_WIDTH` rather than
collapsing anything, through the same clamp the drag uses, so a window whose
derived maximum is under that width resets to the maximum instead. There the key is the only keyboard route to that width at
all: the arrows step by a fixed amount, so reaching the default by holding one
means counting steps to a number nothing on screen shows. Either sidebar's
arrows do reach its collapsed width, by crossing the collapse threshold, so
`Enter` there is about the hint being honest rather than about reachability.

The route host, not the feed, owns identity transitions. A new work stream
begins with local composer keys; after durable admission its adapter rekeys
text/files and adopts the server identity without remounting the conversation
family. A new automation is created by `POST /automations` before its
conversation is opened, so its page starts on a durable id. Socket snapshots remain authoritative after reconnect;
local optimistic rows are reconciled by stable client turn IDs.

Delivered attachments follow the message body and precede its action row. Every
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
optional work summary, and the collapse-all control when the turn has
collapsible headings. It starts on
the same vertical as the response body and the action row beneath it: the turn
has no avatar, so nothing sits left of the name and nothing reserves space for
one.

Finished assistant turns also share the action row. Copy and export remain
local actions; **Speak** uses the regional authenticated stream documented in
[`message-speech.md`](message-speech.md) and receives the complete stored
markdown even when the shared renderer has collapsed its sections. **New
substream** closes that row, and every settled human turn — the reader's own and
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
and also serves meeting recording. It requests audio permission and a socket
ticket concurrently, then starts the 24 kHz PCM16 worklet as soon as the requested
inputs are available. `listening` means local capture is running; it does not
wait for the ticket or the provider's session acknowledgement. OS permission,
device startup, and worklet loading remain prerequisites for capture.

Each attempt retains worklet frames in memory until the provider acknowledges
its session configuration. It then combines adjacent frames into messages that fit the shared 256,000-character
proxy limit, sending a batch every 100 ms until caught up. A batch holds roughly
four seconds of PCM, allowing about 40 times real-time transport while remaining
below the proxy's existing 30-message-per-second admission limit. Live frames and
commits follow the backlog in order. Samples and
sample rate stay unchanged. Azure's [audio-buffer API](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/realtime-audio-reference-ga#input_audio_bufferappend)
accepts buffered bytes; Rally disables server VAD and commits explicitly.
Faster transport therefore preserves the audio signal, though equivalent model
accuracy is an inference from that contract, not a measured provider guarantee.

Stop during local capture drains the final partial frame and waits for connection
readiness before committing, so even a recording shorter than startup survives.
Stop before capture starts cancels setup. Failure or unmount clears the attempt's
buffer and stops its inputs; late setup results cannot revive an older attempt.
The existing 10-second connection budget starts with local capture and covers
the pending ticket, provider acknowledgement, and backlog drain. Expiry aborts
the ticket request, clears the buffer, stops inputs, and rejects pending Stop or
commit calls. Permission prompts do not consume that network budget. Startup
batches wait when outbound socket pressure is high; the same deadline bounds
that wait. Live capture retains its existing socket backpressure failure.
The frame-size and rate limits live in `@rally/contracts/realtime-transcription`,
shared with the proxy. Audio is not persisted to disk.

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

## Changelog

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
