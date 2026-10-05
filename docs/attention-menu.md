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
| `apps/desktop/src/renderer/lib/attention-items.ts` | `attentionItems`: which conversations are listed, why, and in what order. `useAttentionItems`: reads each Channel's Breakout list from the query cache. `attentionItemPath`: the route an item opens. |
| `apps/desktop/src/renderer/lib/format.ts` | `readerMarkerStatus`: the reader's own marker on one conversation, ranked by `MARKER_PRECEDENCE`. `markerRank` exposes that ranking for sorting. |
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

Choosing a row navigates to `/workstreams/:id`, adding `?substream=:id` for a
Breakout. Opening the conversation is what clears it: the same read and
first-open paths that clear the sidebar dot remove the row and lower the count.

## Invariants

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
  observers. Making one fetch would add a request per Channel with a waiting
  Breakout to every render of the shell. Guard: none automated; the query
  options say `enabled: false`.
- **Count and list are one array.** The trigger shows `items.length`, so the
  number can never disagree with the rows under it. Guard:
  `attention-menu.test.tsx`.
- **The count's colours are tokens:** `--av-sys-color-workstream-news` and
  `--av-sys-color-palette-ink-light`, so both themes follow the sidebar's own
  unread red. Guard: verified visually, no automated guard.

## Boundary

Owns the list, its order, the trigger and the dropdown. It does not decide
whether a conversation is unread, mentioned or unseen; that is
[`workstream-markers.md`](workstream-markers.md) and the objects behind it. It
does not mark anything read; opening the conversation does.

It covers the active Organization only. Other Organizations' attention is the
account menu's (`GET /workspace/attention`,
[`multiple-workspaces.md`](multiple-workspaces.md)), and that boundary holds:
no cross-Organization list.

It does not say *who* mentioned the reader. The Channel row carries only that a
mention is unread; naming the author needs the WorkspaceDO viewer row to carry
it, which is a server change nobody has made.

## Failure modes and limits

- **A Breakout list that has not arrived yet** (a cold start before the first
  socket row, or a REST-only row) lists none of that Channel's Breakouts. The
  Channel's own Main still lists. The list fills in when the row arrives.
- **A row older than the socket's first push** says what it said last; the
  menu is as current as the sidebar, no more and no less.
- **No cap on the count or the list.** The trigger widens past two digits and
  the dropdown scrolls.

## Testing

| Suite | Command |
| --- | --- |
| `apps/desktop/src/renderer/lib/attention-items.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/attention-items.test.ts` |
| `apps/desktop/src/renderer/components/attention-menu.test.tsx` | `pnpm --filter @rally/desktop exec vitest run src/renderer/components/attention-menu.test.tsx` |

Radix opens a dropdown on `pointerdown`, not `click`; the menu test sends
`pointerDown` with `button: 0` to open it. Colours and layout have no unit test
and are checked in a real window.

## Changelog

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

**Consequences:** A new reader-owned state belongs in `readerMarkerStatus` and
`MARKER_PRECEDENCE` together, and then appears here and on the sidebar dot at
once. Anything that should appear here but is not a conversation (a failed
Sidekick, say) needs a source this module does not have yet.
