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

Sidekick authoring uses the shared conversation surface in a separate library window. Generated descriptions summarize instructions; ready submissions save immediately. The center workstream sidebar replaces participant rows with a facepile and lists actually attached Sidekicks, with access-checked removal affecting future executions.

## Where the code lives

- `apps/desktop/src/renderer/components/conversation-follow.tsx` owns the
  **Jump to latest** and transient `ActivityPresence`, sharing retained motion.
- `apps/desktop/src/renderer/components/message-feed.tsx` renders the ordered
  list itself — every row, the unread divider, the oversized-message
  placeholder, and row disclosure — and `workstream-blocks.tsx` renders
  the human, assistant, tool, activity, attachment, and failure rows it
  composes. Both adapters render `MessageFeed`; windowing is the one thing it
  takes from its host, because only the paging surface needs it.
- `apps/desktop/src/renderer/components/expanded-composer.tsx`,
  `use-draft-text.ts`, and `use-file-attachments.ts` provide the common composer
  shell, local text persistence, and staged-file lifecycle.
- `apps/desktop/src/renderer/screens/conversation-surface.tsx` is the one feed
  composition: `ConversationSurface({parentKind, parentId, substreamId,
  renderHeader})` owns the transcript, composer, attachments, and the socket
  hooks for one conversation, keyed by the parent id and substream. Its
  composer draft is `workstreamDraftKey` over the parent id, whichever kind of
  parent that is. `screens/workstream.tsx` renders it for a work stream;
  `screens/automation.tsx` renders `components/automation-header.tsx` through
  `renderHeader` over it with `parentKind: "automation"` and `substreamId:
  "0"`. Tool rows are not rendered one per call: they collapse into one row per plugin, which
  [`plugin-activity-rows.md`](plugin-activity-rows.md) owns entirely. The
  retired automation-draft adapter kept a row per call, which is the divergence
  that made the collapse a decision worth recording rather than an obvious one.

## Contract

The adapter provides canonical ordered turns, loaded coverage, streaming
blocks, activity timing, attachment actions, retry/stop state, and a stable
conversation identity, for a work stream's conversation and an automation's
alike. The common viewport follows only while the reader owns
the latest edge; scrolling transfers ownership to the reader until **Jump to
latest** is selected. Programmatic repositioning is announced before changing
`scrollTop`. Reduced-motion preference gates arrivals, activity transitions, and
the jump control. Exiting controls remain mounted but inaccessible until their
fade completes; changing direction reverses the active animation in place.

Sharing stops at product semantics. Work streams retain participants, unread,
resource, run, and steering controls. The in-flight pending queue is one of
those: it attaches to the work-stream composer, not to the shared
`ComposerInput`. An automation's page keeps its lifecycle controls (apply,
pause, resume, delete, run now, the run list) beside the feed rather than
inside it. Neither host may smuggle those controls through an optional common
prop.

The work-stream host supplies `WorkstreamSidebar` through the surface's
`renderSidebar` slot, between global navigation and the feed. It displays the
current work stream, resources whose direction is `artifact`, then participants
from the same live detail/presence state as the conversation. Artifact selection
uses `useCitations.openPreview` to open the artifact lightbox, including an
explicit unavailable-preview state rather than an inspector fallback; arrival
of an artifact never opens a panel. Generated sites open the existing isolated
native viewer inside a resource lightbox, not the file conversion endpoint.
Generated artifacts has no **Manage resources** button or resource-list popup.
File previews still offer individual **Resource details**; their lightbox retains
refresh, watch, archive and version history, but no navigation to a resource list.
Changing conversations closes both lightboxes and pending resource dialogs.
Participant rows open the
existing management dialog. This sidebar does not add substream navigation.

Its device-local collapse preference is independent of the global sidebar.
Expanded width defaults to 280px and is draggable between 240px and 400px;
the icon rail is 88px, matching the existing Grok navigation. Its trailing-edge
handle also accepts Left/Right keys. Width is persisted separately from global
navigation. Dragging below 210px collapses it; expanding requires crossing
220px, retaining the existing ten-pixel hysteresis. It temporarily collapses
when its enclosing pane cannot fit the preferred width
plus the existing 424px conversation reservation. Only that pane is observed,
so collapse cannot change its own measurement and cause oscillation. All paint
uses the existing light/dark sidebar, row, text, and focus tokens; selectors are
scoped to the new component and do not change global navigation rows.

The route host, not the feed, owns identity transitions. A new work stream
begins with local composer keys; after durable admission its adapter rekeys
text/files and adopts the server identity without remounting the conversation
family. A new automation is created by `POST /automations` before its
conversation is opened, so its page starts on a durable id. Socket snapshots remain authoritative after reconnect;
local optimistic rows are reconciled by stable client turn IDs.

Finished assistant turns also share the action row. Copy and export remain
local actions; **Speak** uses the regional authenticated stream documented in
[`message-speech.md`](message-speech.md) and receives the complete stored
markdown even when the shared renderer has collapsed its sections.

## Testing

Shared components have fixture-level component tests for settled, streaming,
failed, elicitation, attachment, tool, follow, and paging states. Each screen
adapter separately proves its controls and identity transition. Any visible
change also requires a real Electron-window check because DOM assertions cannot
prove layout, focus, scroll position, or overlap.

## Changelog

### 2026-09-08 — Sidekick navigation and attachments

The main-window `/sidekicks` adapter opens the dedicated library and returns the
main window to its workstream route. Opening the account item from an existing
detail navigates the singleton back to the library. The sidebar recognizes both
legacy automation details and new Sidekick details. Attachment remove buttons
have their own class so accessibility labels on the row do not apply button-only
layout. Disabled email triggers hide the displayed address while preserving its
permanent owner reservation. Workspace automation pushes invalidate the library
and attachment REST queries in each open window, keeping cross-window authoring
and availability changes visible without navigation.

This records the review fixes because stale effects, overbroad revocation, and
implicit compatibility assumptions can break otherwise valid delegated work.
Future changes must retain the separate ownership and execution boundaries.

### 2026-09-07 — Sidekick conversations and attachments

Sidekick authoring uses the shared conversation surface in a separate library window. Generated descriptions summarize instructions; ready submissions save immediately. The center workstream sidebar replaces participant rows with a facepile and lists actually attached Sidekicks, with access-checked removal affecting future executions.

This composes knowledge with existing execution machinery while keeping one Sidekick identity and preserving authorization boundaries.


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

### 2026-09-05 — Optically align substream connectors

Shift the flipped Tabler connector up eight pixels so its right-hand endpoint,
not its SVG box, meets the button's vertical center. This applies equally to
existing substreams and New substream, without changing row spacing or color.

### 2026-09-05 — Remove the resource-management entry point and popup

Removed the center-sidebar management button, its host callback, and the resource
list mode of the lightbox at product request. Individual artifact previews and
details remain; the parked right-sidebar architecture is unchanged. A detail
lightbox cannot navigate back into the removed management list.

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

### 2026-09-04 — Elicitation prompts join the conversation design

The old shadowed prompt and separately rounded options were missed by the
GrokBot presentation pass. The shell now uses the installed reference's 16px
container radius, 12px inset, 8px joined-list radius, thin row dividers, and
leading letter badges. Light options use the source's `#e8e8e8`; dark options
adapt the existing raised-hover token. Letter shortcuts supplement numeric
shortcuts; selection, custom answers, multi-select limits, Skip, Submit, and
collapse/reopen retain their existing semantics. Unlike the reference's
immediate single-choice submission, Rally still requires explicit Submit.

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

### 2026-09-04: The automation header asks before deleting, offers only what the object accepts, and hears its own chat

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

### 2026-09-03: An automation's chat is the same feed, under an automation parent

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

### 2026-09-02 — Settled media survives transcript metadata refreshes

**What changed:** Sent-image attachments and citation contexts now key their
asynchronous previews by the semantic content of the attachment or resource
records, rather than the JavaScript identity of the arrays carrying them.

**Why:** Transcript composition filters attachments into a new array on every
render, and socket hydration may replace a work stream's resource array without
changing a record. Treating either allocation as new media cleared settled
thumbnails, revoked their object URLs, and restarted the same reads. The clear
itself rendered again in the attachment case, producing an indefinite
thumbnail/skeleton loop whose alternating row heights made the virtual feed
stutter and correct its scroll position back and forth.

**Considered and rejected:** hiding the movement with a transition or weakening
virtual row measurement. Both would leave the repeated network reads and object
URL churn intact, while making the virtualizer less accurate about the DOM it
actually has to place.

**What a future change has to respect:** transport and composition layers may
recreate arrays around unchanged records. An asynchronous media effect must
restart only when one of the fields it consumes changes; a metadata-only
refresh must keep the settled preview mounted.

### 2026-09-02 — Width-sensitive message rows use their live height

**What changed:** A settled code block now keeps the same React component type
when refreshed mention or citation metadata reparses its surrounding Markdown,
so a finished Mermaid diagram remains mounted. The work-stream feed's
virtualizer also measures each rendered row from its current border box on the
next animation frame instead of accepting the size carried by an earlier
ResizeObserver notification.

**Why:** Switching between the expanded sidebar and the icon rail can reflow a
long answer by thousands of pixels. Production hydration also refreshes message
metadata independently of the stored text; the previous inline code renderer
looked like a new React component on every such refresh, so a rendered Mermaid
diagram repeatedly collapsed to its source fallback. More than one resize
notification may already be queued while those shapes change; replaying an
older height made the virtual transcript chase the same oscillation, and
bottom-follow exposed the disagreement as a vertical twitch.

**Considered and rejected:** weakening bottom-follow, delaying every resize, or
caching rendered SVG across component lifetimes. The reader was still at the
end and the browser already had the correct current layout, so the first two
would hide or prolong the virtualizer's stale measurement. A process-wide SVG
cache would retain unbounded conversation content to repair a component that
did not need to unmount in the first place.

**What a future change has to respect:** message rows are width-sensitive and
can be much taller than the viewport. Their virtual measurement must describe
the DOM at callback time; do not reintroduce cached or queued-entry geometry as
the authoritative row height. Metadata-only Markdown refreshes must also keep
the code renderer's component identity stable.

### 2026-09-02 — Sidebar rows keep their preview beside both sidebar forms

**What changed:** Every work-stream row now opens the same compact preview card
to its right after a short hover or focus delay, whether the sidebar is the
expanded list or the 88px icon rail. The card repeats the source's 16px compact
identity glyph, name, relative activity time, and at most two lines of the
standing row preview. The navigation row itself keeps GrokBot's separate 36px
identity inside a 54px-high row and a 54px-wide compact selection seat. A plain
positioning wrapper anchors the preview so Radix never receives React Router's
callback-based row class and cannot strip the expanded row's layout classes.

**Why:** Collapsing the sidebar correctly protects conversation space, but it
also removes the name and latest-message context that makes an icon meaningful.
GrokBot solves that loss with one stable hover-card contract rather than a
compact-only tooltip, so the interaction does not change when the window does.

**Considered and rejected:** A label-only tooltip in compact mode. It would
leave recent activity undiscoverable and make the expanded and compact rows
behave differently even though they represent the same destination.

**Consequences:** The preview is informational and pointer-transparent; the row
continues to own navigation, warmup, drag, and context-menu behavior. Keep its
source-matched 260px width, 8px offset, 10px inset, 12px radius, and two-line
clamp in sync if the sidebar row contract changes.

### 2026-09-02 — The work-stream sidebar collapses to GrokBot's icon rail

**What changed:** The GrokBot shell now has the same two sidebar forms as its
reference: a 280px default expanded list that remains resizable from 240–400px,
and an 88px compact rail containing centered work-stream glyphs, the bottom New
chat action, and the account avatar. Compact preference is persisted and toggled
with Command-B. The layout also enters compact mode whenever the current window
cannot fit the saved expanded width beside a protected 424px conversation. The
edge resizer collapses below 210px and expands at 220px, matching the reference's
hysteresis.

**Why:** Treating every sub-920px window as a hidden mobile drawer removed the
navigation entirely at the size where GrokBot preserves spatial context with a
rail. A fixed CSS breakpoint also diverged as soon as the person resized their
sidebar: the reference derives its threshold from the saved expanded width.

**Considered and rejected:** A media query at 704px. That only matches GrokBot's
default 280px sidebar; it is wrong for every saved width between 240 and 400px
and cannot represent a manual compact preference at a large window size.

**Consequences:** The GrokBot shell keeps 88px of left navigation at narrow
desktop sizes instead of exposing the old drawer trigger. Row text, search,
section labels, participant clusters, timers, and command-shortcut badges are
presentation-only hidden in compact mode; the work-stream links keep their
accessible names and their existing navigation, context-menu, drag, unread, and
socket-warmup behavior.

### 2026-09-02 — Attachment previews use the GrokBot theater

**What changed:** Image and video previews now open over a dimmed copy of the
conversation, centered at their natural fit, with one top-right control that
switches between fit-to-window and full-size. The filename, zoom strip, download,
close, caption, and thumbnail chrome no longer surround media. HTML opens directly
in the inset document preview; its Preview/Source switch is gone.

**Why:** The prior lightbox exposed every available operation at once. GrokBot's
preview is deliberately quieter: the content is the modal, the conversation
remains visible behind it, and Escape or the surrounding scrim closes it.

**Considered and rejected:** Keeping the source switch only for HTML. Source is
not the presentation a person asked to preview, and download remains available in
the document header when they need the file itself.

**Consequences:** Gallery arrow keys and visible previous/next buttons remain for
multi-image messages, but single media previews have only the fit/full-size
control. Previewable block resource embeds use this same surface instead of the
right inspector; true live generated sites keep their dedicated runtime panel.
HTML keeps the existing scriptless, network-denying sandbox.

### 2026-09-02 — Attachments use the GrokBot feed and preview treatment

**What changed:** Message images now preserve their intrinsic size within a
560-by-200-pixel envelope; image batches become a compact three-tile row with a
folded-count overlay and gallery navigation. Other attachments render as compact
filename-and-size cards with a separate download action. Image previews gained
fit/full-size control and keyboard gallery navigation; HTML files gain a
sandboxed rendered surface, while the existing text, Markdown, audio, and
resource-history previews remain available.

**Why:** The old renderer reduced every sent attachment to the same square tile,
which hid the content hierarchy visible in the reference application and made a
web page, a screenshot, and a downloadable file look interchangeable.

**Considered and rejected:** Importing the extracted GrokBot renderer bundle.
That code is application-specific and minified around private protocols. Rally
reimplements the visible behavior over its existing authenticated content loader,
and HTML previews deny scripts and network access instead of acquiring another
trusted renderer origin.

**Consequences:** Assistant and human attachments retain their existing side
alignment. A feed row may eagerly fetch image bytes for thumbnails, but non-image
content remains lazy until preview or download. The lightbox locks body scrolling
while open and restores focus to the invoking control when it closes.

### 2026-09-02 — Production-data pass closes oversized turns and shell-menu drift

**What changed:** Long human turns now collapse inside their existing bubble
with GrokBot's faded **Show more** treatment, and the disclosure state lives
above the virtual window so scrolling a row away does not reset it. The active
GrokBot shell also selects the independent floating account card instead of the
workspace-switcher presentation. Mention filtering now considers a member's
email as well as their display name.

**Why:** A production transcript paste expanded to tens of thousands of pixels,
the bottom account control reopened Rally's old workspace UI, and a person
whose query matched only their email produced an apparently missing `@` menu.
All three failures were visible-shell behavior; none required changing durable
messages, workspace authority, or mention payloads.

**Considered and rejected:** Truncating stored message text would make the rest
unrecoverable, and moving workspace switching into the Grok card would recreate
the chrome this branch intentionally removed. The complete turn remains one
click away, while the existing workspace presentation and mutations remain
implemented for surfaces that opt into them.

**Consequences:** Human and agent turns keep the same bounded width rules. A
collapsed human turn is additionally bounded to the reference card height and
re-measures through the existing feed virtualizer when opened. The account card
does not fetch background-workspace counts merely because it opened.

### 2026-09-02 — Sidebar participants use GrokBot's compact cluster

**What changed:** Work-stream participant previews now occupy a small overlapping
circle, wedge, and pill cluster with the overflow count immediately to its right.

**Why:** A horizontal chain of same-shaped avatars consumed the row's title room
and did not match the compact participant mark used by the reference interface.

**Considered and rejected:** Applying the cluster to every `AvatarStack` would
also reshape headers, participant controls, and presence surfaces. The sidebar
opts in so those semantic uses retain their ordinary row layout.

**Consequences:** The directory still decides which three people and overflow
count are available. Unlike the retired horizontal "who else" strip, the
cluster represents the full participant preview, including the current person;
this remains a renderer-only geometry change.

### 2026-09-01 — Sidebar creation moves into GrokBot's titlebar row

**What changed:** The work-stream creation action now sits alone at the right
edge of the macOS titlebar row, aligned with the traffic lights. Search occupies
its own full-width rounded row directly below it.

**Why:** GrokBot separates window-level creation from navigation filtering. The
previous shared toolbar made the plus a filled leading control beside search,
which changed both the hierarchy and the vertical rhythm of the reference
header.

**Considered and rejected:** Absolutely positioning the plus over the existing
search row would resemble one screenshot while leaving the DOM and drag regions
as one toolbar. The two-row structure keeps the titlebar draggable and makes the
creation link an explicit no-drag target.

**Consequences:** The search and work-stream list keep their existing behavior,
and only their top offset changes. Overlay scrolling no longer reserves a blank
strip beside either one, and the sidebar resize handle now begins below the
shorter titlebar row.

### 2026-09-01 — Work-stream input becomes a compact message capsule

**What changed:** The active conversation now uses a 42-pixel empty composer
with one attachment action, one-line input, and a trailing voice action. A
non-empty draft adds Send, attachments expand above the writing row, and the
main surface omits the dedicated mention, microphone-menu, and model controls.

**Why:** GrokBot treats input as a compact continuation of the conversation.
Rally's forced text height plus a second toolbar row made the empty field more
than twice as tall and left a large dead band under the transcript.

**Considered and rejected:** Shrinking the old two-row toolbar with global CSS
would leave its extra controls in the accessibility tree and would also alter
the automation and launch composers. Removing typed mentions, drag/drop, or
dictation was rejected because those are interaction capabilities rather than
the mismatched toolbar presentation.

**Consequences:** The main work-stream adapter explicitly selects the capsule
layout. Typed `@`, slash commands, attachment paste/drop, voice input, Send,
Stop, draft persistence, and bounded multiline resizing keep their existing
handlers; other composer hosts retain the shared default.

### 2026-09-01 — GrokBot shell removes Rally-specific navigation chrome

**What changed:** The active desktop shell now mounts a work-stream-only left
navigation and a compact centered conversation title that opens the details
rail. Project, automation, note, meeting, socket, HyperSight, participant-add,
and overflow controls are absent from those two visible chrome regions.

**Why:** This branch is a frontend rewrite against GrokBot's three-column
conversation model. Keeping every existing Rally affordance visible would make
the result a restyled Rally screen rather than a faithful reconstruction; the
product-specific controls will be added back deliberately after the shell is
settled.

**Considered and rejected:** Deleting routes, data queries, or mutations along
with their controls would turn a visual experiment into a product/backend
change and make later reintroduction needlessly expensive. CSS-only hiding was
also rejected because invisible controls should not remain in the accessibility
tree.

**Consequences:** Deep links and existing non-shell surfaces still work, but
they are no longer discoverable through the main left navigation. The centered
title is now the single details-rail affordance on an open work stream.

### 2026-09-01 — Agent documents become paged section-card stacks

**What changed:** The main work-stream feed now splits Rally responses at
top-level h2 headings, represents those sections as 20-pixel-offset square
cards, and opens them in a modal reader that pages by controls, arrow keys, or
horizontal swipe. Preamble and heading-less responses remain readable inline.

**Why:** Structured agent output should be scannable as a document set without
turning long Rally prose into message bubbles or making readers expand several
inline accordions before they can move between sections.

**Considered and rejected:** Replacing `MarkdownBody`'s shared heading behavior
globally would also change automation, attachment, export, and embedded preview
surfaces. Splitting on h3-h6 was rejected because those headings express
structure inside an h2 section rather than a new document card.

**Consequences:** The main work-stream adapter explicitly opts agent turns into
the card reader. The source parser must continue to ignore heading-like text in
code, lists, and blockquotes, and the noninteractive export path must continue
to emit the complete response.

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
