# Activity

Activity is one person's feed of what happened to them in Canvases and
Sidekicks: somebody mentioned them in a Canvas's Chat or a Sidekick's
conversation, somebody added them to a Canvas's conversation, a Sidekick run
needs their input, or a run they asked for finished. It is the third section of
the rail, beside Canvases and Sidekicks, in the Mac app and the browser alike.

The feed is the push's own source. Each of the four events that records a
push notification intent writes the recipient's Activity row in the same
transaction, so a person is never pushed something their feed lacks, or shown
something they were never pushed. Whether a row has been seen is not stored on
the row: it is derived from the read cursor the Organization already keeps for
every conversation parent, so opening the conversation clears it exactly when
the Canvas or Sidekick row stops being unread.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/activity.ts` | `ActivityItemSchema`, `ActivityPageSchema` (the subscribe payload's `activity` page), `WorkspaceActivityListEventSchema` (the push) and `ActivityMarkAllSeenCommandSchema` (the one command). |
| `apps/api/src/durable-objects/workspace-activity.ts` | WorkspaceDO migration 148 (`workspace_activity_items`, `workspace_activity_seen`, the `activity` waterline), `recordActivityItem`, the one seen expression (`ACTIVITY_SEEN_SQL`) and `activityPage`. |
| `apps/api/src/durable-objects/workspace-notification-intent-storage.ts` | The two recorders that write a row beside their intent: `recordPersonNotificationIntent` (mention, add) and `recordSidekickRunNotices` (needs input, finished). |
| `apps/api/src/durable-objects/workspace-do.ts` | `noteActivityMoved`, `noteActivityReadMoved`, `publishActivityList`, the `activity` page in `sidebarPayload`, and the `activity_mark_all_seen` command. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Applies the page and the push through the versioned sidebar-list receiver; sends Mark all seen. |
| `apps/desktop/src/renderer/components/activity-sidebar-section.tsx` | The rail section: rows, the unseen count, the empty state and Mark all seen. |

## How it works

### One event, one row

A mention or an add reaches its hosted parent as a conversation effect, and
`HostedConversation.applyChildEnvelope` records its intent with
`recordPersonNotificationIntent` beside the effect's receipt
([`hosted-conversation-parents.md`](hosted-conversation-parents.md#a-mention-or-an-add)).
A Sidekick run's needs-input or finished notice is recorded by the
`sidekick_run_notice` alarm entry with `recordSidekickRunNotices`, one intent
per recipient ([`push-notifications.md`](push-notifications.md#a-sidekick-run-that-needs-input-or-finished)).
Both write one `workspace_activity_items` row per recipient in that
transaction, keyed by the intent's own id, so a replayed effect or a retried
alarm converges on one row (`INSERT … ON CONFLICT DO NOTHING RETURNING`, whose
returned id is the witness that this call wrote it). Who receives a row is
exactly who receives the intent: the mentioned person, the added person, the
requester and the Sidekick's managers for a run that needs input, the
requester alone for a finished run.

A row names its parent (`canvas` or `automation`) and its id, the
conversation it happened in (`"0"`, or a run's id), the mentioning message or
the run, who acted (a person for a mention or an add, the Sidekick for a run
notice), and a preview: the text the push's body carries, reduced the same way
(`rewriteMessageAsPlainText`, then `PUSH_BODY_PREVIEW_CHARACTERS`). The title is
not copied: `activityPage` reads it from `canvas_directory` or
`automation_directory` at list time, so a rename is shown as it is now.
A row lists only while the recipient may open its parent: a row about a
Canvas or Sidekick they cannot open is left out of the page and the count
whole, not sent with its title withheld, because its preview, message id and
sequence are the parent's content. A confirmed mention in a creator-only
Canvas seats nobody and its push is skipped `recipient_not_listable`, yet its
row is recorded; it stays stored and lists once the person is let in. The
page, its access filter and the unseen count are one statement: the count is
a window over every listed row before the page's `LIMIT`, and the filter is
the rule `canvasSidebarRows` and the Sidekick list
(`SIDEBAR_SIDEKICK_LISTED_SQL`) already take, joined. Only a Canvas a
Sidekick writes, whose audience includes that Sidekick's, is decided in code
(`writerSidekickAdmits`), asked once per Sidekick that writes a Canvas
before the page is read, and passed into the statement.

### Seen is derived

A row also stores the attention ordinal it is about. For a mention that is the
mentioning message's own ordinal, which the conversation now carries on the
`mention_notification` effect (`attentionOrdinal`). An add and a run notice
name no message of their own, so they store the parent's shared
conversation's latest attention ordinal when the row is written (the
`latestAttentionOrdinal` of its `"0"` projection in
`sidekick_child_projections`). A mention or an add in any conversation under
the parent other than `"0"` — a Sidekick run's — stores none: its ordinal
counts that conversation's messages, which the `"0"` cursor does not measure,
and comparing the two would clear it the moment it was written. Such a row
clears only by Mark all seen. A run notice keeps the `"0"` ordinal: the run's
row is in the shared conversation.

At list time a row is seen when either:

- the recipient's `sidekick_viewer_reads` row for that parent — the read cursor
  the Canvas and Sidekick rows read unread from — has `seen_attention_ordinal`
  at or past the row's ordinal, and, for a kind other than a mention, that read
  was accepted after the row was written (`updated_at >= created_at`); or
- their `workspace_activity_seen.seen_through`, which Mark all seen moves, is
  at or after the row's `created_at`.

The second condition on a read exists because an add's or a run's ordinal is
what already existed: a requester who had read their own request has a cursor
at that ordinal, and without it their finished run would arrive already seen.
A mention's ordinal is its own message, which nobody can have read before it
existed. `unseenCount` counts every row the same expression calls unseen, not
only the page's.

One read cursor per conversation already exists and drives unread everywhere.
A second, per-item mark would let the feed and the Canvas row disagree — a
Canvas read but its mention still unseen, or the reverse. The Thread-era feed
cleared the same way, through rules over each conversation's message
waterline; this keeps that behaviour with one join instead of a rule language.

### Delivery

The list's waterline is `workspace_sidebar_list_state` row `activity`, one
monotonic counter for every person's list, advanced in the transaction of the
write that moved a list. `noteActivityMoved` advances it and remembers the
person; the write's wrapper (`canvasWrite`, `sidekickCall`, the Sidekick alarm
path) then calls `publishActivityList`, which reads each remembered person's
page once and sends `workspace_activity_list` `{occurredAt, waterline,
unseenCount, items}` to that person's subscribed sockets and nobody else's.

A list moves when a row is written, when Mark all seen is chosen, and when a
read report for the person on a Canvas or a Sidekick is accepted:
`HostedConversation.acceptViewerRead` calls the host's
`noteActivityReadMoved` on every report it accepts, whether or not the cursor
moved, because a non-mention row clears on a report's time as well as its
cursor (a run's row is updated in place, so opening the Sidekick after it
finished reports the same cursor). Each report is a distinct effect because
the conversation's `directory_user` effect carries the report's time
(`lastReadAt`, from `member_attention.last_seen_at`); without it a report at an
unchanged cursor was byte-identical to the last one, the conversation's outbox
reused the earlier message id, and the parent's receipt fence dropped it as a
replay, so the row never cleared. A redelivery of one report still dedupes,
and the parent dates the read by that time, not by when it arrived: a report
for a person with no read recorded (`lastReadAt: null`) is dated `0`, so a
message somebody else sends cannot mark their rows seen, and only an older
object that sends no time is dated at arrival. The host
republishes only when the person
has Activity about that parent (`hasActivityFor`, a seek on
`(recipient_user_id, parent_id)`), so a read of anything else costs one
lookup.

The subscribe answer carries the page beside `automations` and `canvases`, so
a reconnect is correct without replaying pushes; the client applies the page
and every push through the same versioned receiver, which drops anything not
newer than what it holds.

### Mark all seen

`activity_mark_all_seen` on the workspace socket writes the person's
`workspace_activity_seen` row to now (never backwards) and is answered by the
list push on every one of their sockets. Clicking an item sends nothing: it
opens the conversation, whose read acknowledgement moves the cursor that
clears it.

### In the client

The section lists the page newest first, each row in the shared sidebar row
layout (`RowLayout`, as Canvas and Sidekick rows are): a tile with the kind's
glyph (an at sign, a person added, a question, a check); on the first line who
(a person's name from the member directory, or the Sidekick's), what
(mentioned you in, added you to, needs your input, finished a run) and the
title, cut to one line, with the time at its end; on the second the preview,
cut to one line, with the unseen dot. A seen row recedes through text colours
that keep the title at 4.5:1 and the second line at 3:1 or better, never
through opacity. The rows the route has open (the same conversation, and the
same run when one is open) are drawn open at full contrast; keyboard focus is
a ring, never the open fill. A Canvas Chat mention opens the Chat at its message
(`canvasTurnRoute`, from the row's `messageId` and `messageSequence`, the
mentioning turn's transcript sequence the effect carries); a mention recorded
before the effect carried it, and an add, open the Canvas. A row about a
Sidekick opens its conversation, where a run's row is; a run that needs input
(`runId`) and a mention in one of its runs open that run (`?run=`), where the
question and its answer form are. Opening the run does not read the shared
conversation, so a needs-input row stays unseen until the shared conversation
is read or Mark all seen, the same as a mention in a run. Opening a row keeps the
Activity section open. The rail badge is `unseenCount` ("3 unseen"). The dock
badge and the menu bar stay Needs attention only
([`menu-bar.md`](menu-bar.md)); Activity does not join them.

## Invariants

- **A row is written in its intent's transaction, by the intent's recorder.**
  A row written anywhere else could exist without a push, or a push without a
  row. Guard: `workspace-activity.test.ts` (each kind produces its row through
  the production recorder).
- **A row's id is its intent's id.** A replayed effect or retried alarm must
  converge on one row; a fresh id per attempt would list the event twice.
  Guard: the mention case's single-row assertion after redelivery.
- **Seen is never written per row.** The read cursor and the one Mark all seen
  row are the only inputs, so the feed cannot disagree with the Canvas or
  Sidekick row's unread. Guard: the implicit-clear case, proved to fail with
  the read join skipped.
- **The page and the count use one expression.** A second copy of the seen
  rule would let the badge and the dots disagree. Guard: `ACTIVITY_SEEN_SQL`
  is the only definition; the Mark all seen case asserts both.
- **A list goes to its person's sockets only.** It names Canvases and
  Sidekicks the person was told about. Guard: the mention case asserts the
  author's socket received no Activity push.
- **A row lists only while the person may open the parent.** Otherwise a
  mention in a Canvas they were never let into, or one they were removed
  from, would send them its preview and ids. Guard: the creator-only Canvas
  case asserts the subscribe answer holds no row and counts nothing, then
  lists it once the person is added.
- **The intents' reaper never touches Activity.** The intent row is a delivery
  record with a retention; the feed is the person's. No shared delete exists.

## Boundary

Activity owns `workspace_activity_items`, `workspace_activity_seen` and the
`activity` waterline. It depends on the two intent recorders to write rows, on
`sidekick_viewer_reads` and `sidekick_child_projections`
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)) for seen,
and on the directory tables for titles. It does not decide who is told about
an event — the push's recipient rules do ([`push-notifications.md`](push-notifications.md))
— and it does not send anything off the workspace socket. Both tables are in
`WORKSPACE_TYPED_RPC_ONLY_TABLES`, so the generic WorkspaceDO SQL port refuses
them. The menu bar and the dock badge do not read it.

## Failure modes and limits

- **No retention.** Rows are kept for as long as the Organization object
  exists; nothing deletes them, including the deletion of their Canvas or
  Sidekick (the row stays stored and no longer lists). Whether and when to
  prune is a decision not yet made; a cap would be a number the team sets
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).
- **The page is the newest `SIDEBAR_LIST_LIMIT` (250) rows.** Older rows are
  counted in `unseenCount` but not listed; there is no paging. Mark all seen
  clears them too.
- **Frame size.** A full page of 250 rows with full 1,000-character previews is
  on the order of a few hundred kilobytes, under the platform's WebSocket
  message limit but not by a wide margin with multi-byte text. A send that
  fails is skipped; the next subscribe carries the page.
- **A mention recorded from an effect emitted before `attentionOrdinal`
  existed** has no ordinal and clears only by Mark all seen.
- **An open that sends no read report** (no message that asks for attention
  is on screen) leaves an add or a run notice unseen; Mark all seen clears it.
  Preferred to the alternative, a row that arrives already seen. The client
  otherwise reports a read on every open, at an unchanged cursor too
  (`conversation-surfaces.md`). That report reaches `acceptViewerRead`
  because the `directory_user` effect carries the report's time
  (`lastReadAt`, the server fix S10, 695611c); before it, the effect outbox
  dropped an effect identical to its last one, and a run's row that arrived
  after the last report stayed unseen until the cursor moved.
- **A mention or an add in a Sidekick run's own conversation** clears only by
  Mark all seen: the shared conversation's cursor does not measure it.
- **A run that fails at once can arrive already seen.** The requester's own
  read report of the message that asked for it is delivered through the Queue
  and can land after the run's `run_finished` row is written — seen locally
  4 ms later, with no model configured — and that report then clears the row.
  A run that takes longer than the Queue's delivery delay is not affected.
- **Mark all seen while the socket is down** is not sent; the button does
  nothing until it reconnects.
- **An older desktop** ignores `workspace_activity_list` by type and strips
  the subscribe payload's `activity` page.

## Testing

`apps/api/test-workers/workspace-activity.test.ts`, on real workerd
(`pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts
test-workers/workspace-activity.test.ts`): a Canvas Chat mention posted to the
conversation object and delivered through the real consumer produces one row
and a push on the recipient's socket only; reading the Chat through the
conversation's `acknowledge_read` operation clears it with no Activity
command; an add delivered to `receiveChildEffects` produces one, and Mark all
seen clears it; a Sidekick run reaching `needs_input` reaches the requester
and the author, and a finished run the requester only, through the notice
alarm, read from a socket's subscribe answer; a finished run clears, and the
list is sent again, on a read report at an unchanged cursor; a mention in a
run's conversation stays unseen however far the shared conversation is read;
a confirmed mention in a creator-only Canvas sends its person nothing until
they are added to it; and reopening the shared conversation at a cursor
already read, through the conversation's own `acknowledge_read`, clears a run
that finished in between. The run cases poll: the notice is recorded by an alarm
the object arms itself.

The renderer's `workspace-socket.test.tsx` covers the page and the push, and
`navigation-sidebar.test.tsx` the rows, their links, the badge, the empty state and Mark all seen, and `rail-dock-badge.test.tsx` that the dock badge leaves Activity out.

## Data model

| Table | Key | Columns |
| --- | --- | --- |
| `workspace_activity_items` | `item_id` (the intent's id) | `workspace_id`, `recipient_user_id`, `kind` (`mention`, `participant_added`, `needs_input`, `run_finished`), `parent_kind` (`canvas`, `automation`), `parent_id`, `substream_id`, `message_id`, `message_sequence` (the mention's transcript sequence), `run_id`, `actor_kind` (`person`, `rally`, `sidekick`), `actor_id`, `preview`, `attention_ordinal` (null: clears only by Mark all seen), `created_at` (ms). Indexes `(recipient_user_id, created_at DESC)` for the page and `(recipient_user_id, parent_id)` for a read report. |
| `workspace_activity_seen` | `user_id` | `seen_through` (ms): Mark all seen. |
| `workspace_sidebar_list_state` | `list` | Row `activity`: the list's waterline. |

## Changelog

### 2026-11-08 — A needs-input row opens the run that asked, and rows take the shared layout

**What changed:** A `needs_input` row opens the run it is about (`?run=` from
its `runId`) rather than the Sidekick's shared conversation.

**Why:** The run is where the question and its answer form are; the shared
conversation's composer starts a new run, so a person sent there answered
nothing. The design is silent on Activity, so this document is the authority.

**Considered and rejected:** Opening the shared conversation at the run's
row, which now carries the question too: it reads `"0"` and clears the row,
but a row could not be scrolled to a run's row without a sequence the item
does not carry.

Rows take the shared row layout, seen rows recede through text colour tokens
rather than 45% opacity (which left a seen preview at 1.9:1 in light and
2.45:1 in dark), and only the rows whose conversation and run the route has
open are marked open: opening a Sidekick marked every row about it, which read
as a multi-selection.

**What a future change must respect:** opening the run does not read `"0"`,
so the row stays unseen until the shared conversation is read or Mark all
seen; a fix belongs in what seen measures, not in the route.
A seen row's colours are tokens chosen for contrast; dimming a row by
opacity is how this failed before.

### 2026-11-08 — A row lists only while its person may open the parent, and every read report is heard

**What changed:** `activityPage` filters out, from the page and the unseen
count, a row about a Canvas or Sidekick its person cannot open, where it only
withheld the title. A conversation's `directory_user` effect carries the
report's time (`lastReadAt`), and the parent dates the read by it, so a report
at an unchanged cursor is a new effect.

**Why:** The end-to-end pass found a confirmed mention in a creator-only
Canvas sending its preview, message id and sequence to someone who could not
open it, and a requester who reopened a Sidekick after its run finished, at
the cursor they had already read, left with the run's row unseen: the report
was byte-identical to the last, so the outbox reused its message id and the
parent's receipt fence dropped it.

**Considered and rejected:** Redacting more fields of a row the person cannot
open: the row's existence is itself the parent's activity. Dating the read by
its arrival: a report delivered after a run finished would clear the run's row
for a read that came before it.

**What a future change must respect:** the access filter and the page are one
statement, and a read is dated by when the person read, never by delivery.

### 2026-11-08 — Activity returns as a per-person feed of the four push events

**What changed:** A third rail section, Activity, lists one person's mentions,
adds and Sidekick run notices. WorkspaceDO migration 148 adds
`workspace_activity_items` and `workspace_activity_seen` and widens the
sidebar-list waterline's CHECK to `activity` by copying the table. The workspace
socket carries the page on subscribe and pushes `workspace_activity_list`;
`activity_mark_all_seen` is its one command. The `mention_notification` effect
carries the message's `attentionOrdinal` and `transcriptSequence`, so a
mention's row clears on the read cursor and opens the Chat at its message.

**Why:** The user asked on 2026-11-08 to bring the Activity section back. The
Thread-era feed (the Activity tab of `digests.md`, retired with the Thread
subsystems; its last version is `git show ad8baaa^:docs/digests.md`) was
deleted at plan step B-3 with the Threads it read. It returns sourced from the
same four events as push, written in the intent's transaction, so the feed
cannot drift from what was pushed. Seen is derived from the read cursor that
already drives every unread, so the feed cannot disagree with the Canvas or
Sidekick row either (the coordinator's 2026-11-08 amendment).

**Considered and rejected:** Deriving the feed from each conversation's
transcript on read, as the old feed derived replies and starts — a fan-out read
over every conversation on every rail open, against the low-latency goal. A
`seen_at` column and a per-item mark command: a second read state beside the
conversation's own. Comparing the read cursor alone for an add or a run notice:
a requester who had read their own request would get their finished run
already seen.

**Consequences:** A new kind of person-facing event joins Activity by being
recorded through one of the two recorders, or by calling `recordActivityItem`
in its own intent's transaction. Retention is undecided and nothing prunes.
