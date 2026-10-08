# Attention menu

The button left of search in the sidebar's top bar. While anything in the
active Organization is waiting for the reader, it shows the number of
conversations waiting, white on the sidebar's unread red; when nothing is, it is
a bell whose tooltip says **Nothing needs your attention**. Opening it lists
every waiting Channel and Breakout, and choosing one opens it.

It runs on macOS and the web, which mount the same sidebar. It reads only what
the sidebar already holds, so opening it makes no request and its count moves
with the same socket push that moves a sidebar dot.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/common/attention-items.ts` | `attentionItems`: which conversations are listed, why, and in what order. `readerMarkerStatus`: the reader's own marker on one conversation, ranked by `MARKER_PRECEDENCE`; `markerRank` exposes that ranking for sorting. In `common/` because the macOS menu bar counts the same list in the main process ([`menu-bar.md`](menu-bar.md)). |
| `apps/desktop/src/renderer/lib/attention-items.ts` | `useAttentionItems`: reads each Channel's Breakout list from the query cache. `attentionItemPath`: the route an item opens. Re-exports `attentionItems`. |
| `apps/desktop/src/renderer/lib/format.ts` | Re-exports `readerMarkerStatus` and `markerRank` for renderer callers. |
| `apps/desktop/src/renderer/components/attention-menu.tsx` | The trigger (count or bell), its tooltip, the dropdown and its rows. |
| `apps/desktop/src/renderer/components/app-shell.tsx` | Calls `useAttentionItems` over the sidebar's rows and passes the result to `Sidebar`. |
| `apps/desktop/src/renderer/components/sidebar.tsx` | Places `AttentionMenu` in `SidebarTopActions`, before search. |
| `packages/ui/src/styles/app.css` | `.attention-trigger`, `.attention-count`, `.attention-menu*`. |

## How it works

A conversation is listed when one of the three reader-owned states from
[`workstream-markers.md`](workstream-markers.md) is true for it:

- **unseen**: the reader was added to it and has never opened it;
- **mentioned**: a mention of the reader sits above their read point. Rally's
  own replies can mention a person and set the same flag
  ([`workstream-durable-object.md`](workstream-durable-object.md)), so a
  mention by a colleague and one by Rally are the same row;
- **unread**: messages sit above their read point.

The run's own states are left out. A running agent or one that needs input is
on the sidebar dot already, and the menu answers a narrower question: what has
somebody sent this person that they have not looked at.

Main comes from the Channel row (`unseen`, `youAreMentioned`, `hasUnread`).
It is skipped when Main is not the reader's: `mainWithheld`, or an
`associativeSubstreamId` other than `'0'` ([`listing-rules.md`](listing-rules.md)).
Breakouts come from the Channel's `privateChildren`, which the Organization
socket writes into `['workstream-children', id]`
([`desktop-shell.md`](desktop-shell.md)); a Breakout's `unreadCount > 0` is its
unread. `useAttentionItems` observes only the Channels whose row has a
non-zero `breakoutAttentionCount`, with `enabled: false`, so it never fetches.
Archived, system and pending rows are skipped.

Each conversation is one row with its highest-ranked state, ordered by
`MARKER_PRECEDENCE` (unseen, mentioned, unread), then newest activity first,
then title. A row shows the Channel's glyph (a Breakout uses its Channel's, as
the Space dashboard does), the conversation's title, the state's label (with
"in *Channel*" for a Breakout), its activity time and its marker dot.

**Access requests** waiting on the reader come first, one row each: the
conversation's mark and name, "*Name* asked to join", and two icon buttons,
Tabler `check` (tooltip **Approve**) and `cancel` (tooltip **Decline**).
Choosing a button answers the request and keeps the menu open for the next.
Choosing the row opens the request's dialog instead. The list comes from the
workspace socket like everything else here, and the count, the tooltip's
label and the dock badge include it. [`channel-access-requests.md`](channel-access-requests.md)
owns the requests.

Choosing a row navigates to `/workstreams/:id`, adding `?substream=:id` for a
Breakout. Opening the conversation is what clears it: the same read and
first-open paths that clear the sidebar dot remove the row and lower the count.

## Invariants

- **The menu bar's count is this menu's count.** The main process calls the
  same `attentionItems` over its own socket's rows, reading Breakout lists under
  the same `breakoutAttentionCount` condition `useAttentionItems` uses. Changing
  what is listed here changes the number beside the status item with it.
- **The menu and the sidebar dot read the same fields.** Both take unread,
  mentioned and unseen from the Channel row and its Breakout list. A second
  source (a new request, a separate store) would let the count say three while
  the sidebar shows two dots. Guard: runnable tests in `attention-items.test.ts`
  over those fields.
- **The order between the three states is `MARKER_PRECEDENCE`.**
  `readerMarkerStatus` and `markerRank` read that list rather than restating it,
  so reordering the sidebar ranking reorders the menu. Guard:
  `attention-items.test.ts` pins the current order.
- **Opening the menu fetches nothing.** The Breakout queries are disabled
  observers; letting one fetch adds a request per waiting Channel to every
  shell render. Guard: none automated.
- **The dock badge is this count.** `useDockBadge` sends the items plus the
  access requests, and
  `readerAttentionCount` in `workspace-space-storage.ts` counts the APNs badge
  with the same three states over Mains and Breakouts. A new reader-owned
  state goes in both. Guard: `workspace-attention.test.ts` for the server side
  only.
- **Count and list are one list.** The trigger shows the items plus the access
  requests, the rows under it, so the number can never disagree with them. Guard:
  `attention-menu.test.tsx`.

## Boundary

Owns the list, its order, the trigger and the dropdown. It does not decide
whether a conversation is unread, mentioned or unseen; that is
[`workstream-markers.md`](workstream-markers.md) and the objects behind it. It
does not mark anything read; opening the conversation does.

It covers the active Organization only. Other Organizations' attention is the
account menu's (`GET /workspace/attention`,
[`multiple-workspaces.md`](multiple-workspaces.md)), and that boundary holds:
no cross-Organization list.

It does not name who mentioned the reader (see the changelog).

## Failure modes and limits

- **While the Channel directory is still loading** (the Space walk at
  startup, a page not yet read on an older server's paged list, or a walk that
  failed), the menu never says "Nothing needs your attention": an empty list
  reads **Still loading channels**, and a non-empty one adds that line under
  its rows. `AppShell` decides this from the directory query (`hasMore`,
  `isFetching`, `isError`).
- **A Breakout list that has not arrived yet** (a cold start before the first
  socket row, or a REST-only row) lists none of that Channel's Breakouts. The
  Channel's own Main still lists. The list fills in when the row arrives.
- **A row older than the socket's first push** says what it said last; the
  menu is as current as the sidebar, no more and no less.
- **The count shows 99+ past two digits** so it stays in the 32px button the
  sidebar's minimum width is sized for; the accessible label keeps the exact
  number. The list has no cap and scrolls. The count's colours are the `workstream-news` and
  `palette-ink-light` tokens, checked in a real window in both themes.

## Testing

| Suite | Command |
| --- | --- |
| `apps/desktop/src/renderer/lib/attention-items.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/attention-items.test.ts` |
| `apps/desktop/src/renderer/components/attention-menu.test.tsx` | `pnpm --filter @rally/desktop exec vitest run src/renderer/components/attention-menu.test.tsx` |

Radix opens a dropdown on `pointerdown`, not `click`; the menu test sends
`pointerDown` with `button: 0` to open it. Colours and layout have no unit test
and are checked in a real window.

## Changelog

### 2026-10-07 — Access requests listed first, with approve and decline

**What changed:** Requests to join one of the reader's Channels or Breakouts
are listed above the waiting conversations, counted with them, and answered
in place with two icon buttons or from a dialog the row opens.

**Why:** Product asked for the requests in the activity area with inline
approve and decline. Putting them here means the count, the dock badge and
the menu bar agree on one number. The APNs badge, counted on the server,
does not include them yet.

### 2026-10-05 — Attention menu added

**What changed:** A count-or-bell button left of search lists every Channel and
Breakout that is unseen, mentions the reader, or is unread, and opens the one
chosen.

**Why:** The sidebar dot says a Channel needs the reader, but finding which
Breakout, and across a long list, meant scanning. People wanted one place that
links straight to everything waiting for them.

**Considered and rejected:** A new server read returning the list. The Channel
rows and Breakout lists already on the client carry every field it needs, and a
request would add latency to every open for no new information. Counting a
running agent or needs-input run, as `conversationNeedsViewer` does: those are
the agent's state, not something sent to the person. Naming the mention's
author: it needs a server change and was not asked for.

**Consequences:** The menu only claims "nothing" once the whole directory has
loaded; review caught that a partly walked list would otherwise read as
exhaustive. A new reader-owned state belongs in `readerMarkerStatus` and
`MARKER_PRECEDENCE` together, and then appears here and on the sidebar dot at
once. Anything that should appear here but is not a conversation (a failed
Sidekick, say) needs a source this module does not have yet.
