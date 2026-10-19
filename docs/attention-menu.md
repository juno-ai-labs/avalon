# Attention menu (retired)

**Retired.** From 2026-10-05 until the navigation redesign
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)), a button left of
search in the sidebar's top bar showed how many conversations were waiting on
the reader and opened a list of them. The redesign deleted the pop-out
(`attention-menu.tsx`). Its count is now the red badge on the sidebar's
**Threads** button, the Threads tab's **Needs attention** sort lists the same
conversations, and access requests are answered at the top of the **Activity**
tab ([`desktop-shell.md`](desktop-shell.md#the-sidebar)).

This document keeps what the menu decided, because `attentionItems` still
decides it for the badge and the dock. The macOS menu bar no longer reads it:
its Needs attention is the Activity tab's unread rows
([`menu-bar.md`](menu-bar.md)).

## What it was

- **One list, three states.** A conversation was listed when it was
  **unseen** (the reader was added and never opened it), **mentioned** (a
  mention of the reader, by a colleague or by Rally, sits above their read
  point) or **unread**, each from
  [`workstream-markers.md`](workstream-markers.md). A run's own states (running,
  needs input) were left out: they are the agent's state, not something sent
  to the person.
- **Main and Breakouts.** Main came from the thread's row and was skipped when
  Main was not the reader's (`mainWithheld`, or an `associativeSubstreamId`
  other than `'0'`). Breakouts came from the thread's `privateChildren` in the
  query cache, read by disabled observers so opening the menu fetched nothing.
- **Order.** One row per conversation with its highest state, ordered by
  `MARKER_PRECEDENCE` (unseen, mentioned, unread), then newest activity, then
  title. Access requests the reader could decide came first.

## What it taught

1. **Count and list are one list.** The number on the button and the rows
   under it were the same array, so they could not disagree. The Threads badge
   keeps this: it counts `attentionItems` plus pending access requests.
2. **Never claim "nothing" from a partial directory.** While the thread
   directory was still loading, an empty list said **Still loading channels**
   rather than **Nothing needs your attention**; review caught that a partly
   walked list would otherwise read as exhaustive.
3. **No second source.** A server read for the list was rejected: the rows
   already on the client carried every field, and a request would add latency
   for no new information.

## Why it went

The redesign gives activity a tab of its own and puts the count on the Threads
button. Keeping the pop-out beside the switcher would have listed the same
waiting work in two places.

## What is left

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/attention-ranking.ts` | `attentionItems`: which conversations are waiting, why, and in what order; `readerMarkerStatus` and `markerRank` over `MARKER_PRECEDENCE`. It sat in `common/` while the macOS menu bar counted the same list in the main process; the menu now lists Activity ([`menu-bar.md`](menu-bar.md)). |
| `apps/desktop/src/renderer/lib/attention-items.ts` | `useAttentionItems` and `attentionItemPath`. |

Rules that still hold:

- **The Threads badge and the dock show one number.** Both read
  `attentionItems`; `readerAttentionCount` in `workspace-space-storage.ts`
  counts the APNs badge with the same three states. A new reader-owned state
  goes in `readerMarkerStatus` and `MARKER_PRECEDENCE`, and in the server
  count. Guard: `attention-items.test.ts`, `navigation-sidebar.test.tsx`, and
  `workspace-attention.test.ts` for the server side.
- **It counts only what the Threads list holds.** Main counts when the
  reader takes part in it (`isParticipant` on the row; absent is counted, as
  before the field existed), and Breakouts come only from the reader's own
  Breakout list. `readerAttentionCount` requires `is_participant = 1` on both
  arms to match.
- **It covers the active Organization only.** Other Organizations' attention
  is the account menu's (`GET /workspace/attention`,
  [`multiple-workspaces.md`](multiple-workspaces.md)).

## Changelog

### 2026-10-19 — Count only threads the reader takes part in

**What changed:** Thread rows carry `isParticipant`. `attentionItems` skips
Main when it is `false`, and `readerAttentionCount` requires participation for
Main and Breakouts alike.

**Why:** The Threads list shows only conversations the reader takes part in
or pinned, but the badge counted every listed thread. An Organization-wide
thread somebody else was working in raised the badge by one while the list,
sorted by Needs attention, showed nothing waiting. The badge's own rule is
that the count and the list are one list, and this broke it.

**Considered and rejected:** Counting pinned threads the reader is not in:
they sit in the Pinned section rather than the list the Needs attention sort
orders, and adding them would need the pin list in the count for no case
anybody reported. Mentions are not lost: mentioning somebody who is not in a
thread adds them to it.

**Consequences:** Unread activity in an Organization-wide thread the reader
is not in now shows only in the Channels tab and Activity. The Breakout arm's
participation check also closes an older disagreement: the APNs count included
unread Organization-wide Breakouts the reader was not in, which the client,
reading only their own Breakout list, never counted. A new place that
lists threads for a reader must take part in the same rule or the badge and
the list will disagree again.

### 2026-10-10 — The pop-out becomes the Threads badge and the Activity tab

**What changed:** `AttentionMenu` is deleted. The same count is the Threads
button's badge; access requests moved to the Activity tab.

**Why:** The navigation redesign gives activity a tab of its own
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)).

**Considered and rejected:** Keeping the pop-out beside the switcher: two
places listing the same waiting work.

**Consequences:** `attentionItems` is unchanged and still the one definition.

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
