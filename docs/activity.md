# Activity

Activity is one person's feed of what happened to them in Canvases and
Sidekicks: somebody mentioned them in a Canvas's Chat or a Sidekick's
conversation, somebody added them to a Canvas's conversation, a Sidekick run
needs their input, a run they asked for finished, somebody else replied in
a conversation they are in, somebody published a new version in a Canvas
they pinned, somebody asked to open a Canvas they decide on, their own
request to open one was approved, somebody asked to let their events start a
Sidekick, or the person they asked answered. It is the third section of
the rail, beside Canvases and Sidekicks, in the Mac app and the browser alike.

The feed is the push's own source. Each event that records a push
notification intent writes the recipient's Activity row in the same
transaction, so a person is never pushed something their feed lacks, or shown
something they were never pushed. Whether a row has been seen is not stored on
the row: it is derived from the read cursor the Organization already keeps for
every conversation parent, so opening the conversation clears it exactly when
the Canvas or Sidekick row stops being unread.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/activity.ts` | `ActivityItemSchema`, `ActivityPageSchema` (the subscribe payload's `activity` page), `WorkspaceActivityListEventSchema` (the push) and `ActivityMarkAllSeenCommandSchema` (the one command). |
| `apps/api/src/durable-objects/workspace-activity.ts` | WorkspaceDO migration 140 (`workspace_activity_items`, `workspace_activity_seen`, the `activity` waterline), `recordActivityItem`, the one seen expression (`ACTIVITY_SEEN_SQL`) and `activityPage`. |
| `apps/api/src/durable-objects/workspace-notification-intent-storage.ts` | The recorders that write a row beside their intent: `recordPersonNotificationIntent` (mention, add), `recordSidekickRunNotices` (needs input, finished) and `recordParentNotice` (a notice a Canvas or Sidekick records about itself: a reply). |
| `apps/api/src/durable-objects/canvas-artifact-notices.ts` | `tellCanvasPinners`: a new version in a Canvas tells its pinners, one `artifact_updated` intent and row each. |
| `apps/api/src/durable-objects/sidekick-source-notices.ts` | A Sidekick source request's rows: `source_request` for the person asked, `source_approved` or `source_declined` for whoever asked, and the part of migration 146 that admits the three kinds. |
| `apps/api/src/durable-objects/conversation-reply-batch.ts` | The `reply_batch` alarm entry: a conversation's replies batched, then one `new_message` intent and row per recipient. |
| `apps/api/src/durable-objects/workspace-do.ts` | `noteActivityMoved`, `noteActivityReadMoved`, `publishActivityList`, the `activity` page in `sidebarPayload`, and the `activity_mark_all_seen` command. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Applies the page and the push through the versioned sidebar-list receiver; sends Mark all seen. |
| `apps/desktop/src/renderer/components/activity-sidebar-section.tsx` | The Activity list and its rows. |
| `apps/desktop/src/renderer/screens/activity-home.tsx` | The Activity home shown when there is no item to open. |

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

A reply (`new_message`) is recorded when its conversation's reply batch runs
([`push-notifications.md`](push-notifications.md#a-persons-reply)), one
intent per recipient per batch, and its row **collapses**
(`recordCollapsedActivityItem`): while the recipient has an unseen
`new_message` row about the same conversation, that row is brought up to the
newest reply — its message, transcript sequence, author, preview, ordinal and
time — and keeps its id (the first intent's); once it is seen, the next reply
writes a new row. A busy Chat is one row, not one per message. "Unseen" there
is `ACTIVITY_SEEN_SQL`, the page's own expression.

A pinned Canvas's new version (`artifact_updated`) is recorded by the
publish's note to the Canvas (`tellCanvasPinners`) and collapses the same
way, one unseen row per Canvas per pinner: its `subject_id` is the artifact,
which the page names as `artifact` (`resourceId` and its title now, from
`resources`), and its actor whoever made the version.

A request to open a Canvas writes one `access_request` row per decider and,
when approved, an `access_granted` row for the requester, or when denied an
`access_denied` row for them ([`canvas-access-requests.md`](canvas-access-requests.md)).
The request's row is its actions: its `subject_id` is the request, and the
page names where the request stands (`accessRequest`: `pending`, `approved`
or `denied`, and who decided). A denial's row names the decider the same way;
it lists while the Canvas exists although its recipient cannot open it, with
`parentTitle` always null, and reads as seen once they ask again. None
collapses.

A request for a Sidekick source ([`sidekick-sources.md`](sidekick-sources.md))
writes one `source_request` row for the person asked
(`recordSourceRequestAsked`), in the transaction that makes the request. Its
parent is the Sidekick, its actor whoever asked, its `subject_id` the request,
and its preview what was asked ("Events: Email received. Only when: it is
about a pre-seed round"). When that person approves or declines, whoever asked
gets a `source_approved` or `source_declined` row whose actor is the person
(`recordSourceRequestSettled`); a request cancelled by a newer ask writes no
row, and neither does a person answering their own ask. For all three kinds
the page fills `sourceRequest` from `sidekick_source_requests` as it stands
now: the request's id and state (`pending`, `approved`, `declined`,
`cancelled`), the connector type, the event types, the condition, who asked,
and the asked person's name once they have answered (`person_name`). None
collapses.

A row names its parent (`canvas` or `automation`) and its id, the
conversation it happened in (`"0"`, or a run's id), the mentioning message or
the run, who acted (a person for a mention or an add, the Sidekick for a run
notice), and a preview: the text the push's body carries, reduced the same way
(`rewriteMessageAsPlainText`, then `PUSH_BODY_PREVIEW_CHARACTERS`); for a
Needs input row that is the question the run waits on. The title is
not copied: `activityPage` reads it from `canvas_directory` or
`automation_directory` at list time, so a rename is shown as it is now.
A row lists only while the recipient may open its parent: a row about a
Canvas or Sidekick they cannot open is left out of the page and the count
whole, not sent with its title withheld, because its preview, message id and
sequence are the parent's content. One kind is exempt: a declined request
(`access_denied`) lists while its Canvas exists, though its requester cannot
open it — the owner asked on 2026-11-08 to "inform the person [of] a
denial", and the row names no content of the Canvas (no title, preview,
message or sequence; only its id and who declined). The three Sidekick
source kinds are exempt too: each lists while its Sidekick exists and is not
deleted, with the Sidekick's name, whoever the Sidekick's readers are. The
person asked usually cannot open the Sidekick until they approve, and the
request names it to them on purpose; the answer goes to whoever asked about
that Sidekick by name, and a Sidekick a Canvas made is managed by people the
Sidekick list does not hold. A confirmed mention in a creator-only
Canvas seats nobody and its push is skipped `recipient_not_listable`, yet its
row is recorded; it stays stored and lists once the person is let in. The
page, its access filter and the unseen count are one statement: the count is
a window over every listed row before the page's `LIMIT`, and the filter is
the rule `canvasSidebarRows` and the Sidekick list
(`SIDEBAR_SIDEKICK_LISTED_SQL`) already take, joined, with one more reach:
an owner or administrator, who may open every Canvas, lists a row about any
Canvas (a request they decide on, a mention in one they were never in),
read from the relationship the object keeps (`workspace_member_status`). Only a Canvas a
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

At list time a row is seen when any of these holds:

- the recipient's `sidekick_viewer_reads` row for that parent — the read cursor
  the Canvas and Sidekick rows read unread from — has `seen_attention_ordinal`
  at or past the row's ordinal, and, for a kind other than a mention, that read
  was accepted after the row was written (`updated_at >= created_at`); or
- their `workspace_activity_seen.seen_through`, which Mark all seen moves, is
  at or after the row's `created_at`.
- it is a Needs input row and its run (`sidekick_runs`, by the row's
  `run_id`) is no longer in `needs_input`: the question was answered, or the
  run was stopped. The run's own view, where the question is answered, reads
  the run's conversation, not `"0"`, so no read report clears it; without this
  rule the row stayed unseen after the person answered until they read the
  shared conversation or chose Mark all seen. A run that asks again writes a
  new row, and while it waits the earlier row reads unseen again too.

A reply clears as a mention does: its ordinal is its own message's, so the
cursor reaching it is enough, with no condition on the read's time. A pinned
request to open a Canvas stores no ordinal, so no read clears it: it is seen
once the request is settled, by anyone, or by Mark all seen; its grant clears
on a read of the Canvas as an add does. A request for a Sidekick source
(`source_request`) is the same: no ordinal, and seen once the request is no
longer `pending`, by the person's answer or by a newer ask replacing it; its
answer (`source_approved`, `source_declined`) clears on a read of the Sidekick
as an add does. A pinned
Canvas's new version clears on any read of the Chat accepted after it
(`updated_at >= created_at`), the rule `canvasSidebarRows` takes for the
Canvas row's artifact news.

The second condition on a read exists because an add's or a run's ordinal is
what already existed: a requester who had read their own request has a cursor
at that ordinal, and without it their finished run would arrive already seen.
A mention's ordinal is its own message, which nobody can have read before it
existed. `unseenCount` counts every row the same expression calls unseen, not
only the page's.

The same filter and seen rule answer `WorkspaceDO.attention()` (`activityCounts`
over `listedSql`, the CTE `activityPage` reads): `readerAttentionCount` is the
person's unseen Activity in that Organization, `waitingForYou` the unseen
`needs_input` rows among it, `waitingReason` `needs_input` while one waits,
else `unseen` while anything is unseen, and `hasUnreadActivity` whether
anything is. That is the account menu's number for an Organization in the
background ([`multiple-workspaces.md`](multiple-workspaces.md#the-account-menus-directory))
and every push's badge ([`push-notifications.md`](push-notifications.md)),
so the three agree with the rail.

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

A list moves when a row is written, when Mark all seen is chosen, when a run
with Needs input rows stops waiting (`onChildCommonProjection`, and
`stopOpenRuns` for a pause, through `waitingRunActivityRecipients`), and when a
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
glyph (an at sign, a person added, a question, a check, a speech bubble for a
reply, a pencilled file for a new version, a lock for an access request and
for a declined one, and an open lock for a grant), and on a Canvas row the Canvas's own mark as a badge
on the tile's corner (the glyph then sits up and to the left of the tile's
centre, so the badge never covers the right shackle leg that tells the closed
lock from the open one), in the icon and colour chosen for it or else its
default, read from the viewer's Canvas list
([`canvases.md`](canvases.md#choosing-what-a-canvas-looks-like)); on the first line who (a person's name from the member
directory, or the Sidekick's), what (mentioned you in, added you to, needs your
input, finished a run, "in" for a reply, updated <artifact> in, asked to open,
let you into) and the title, or, for a declined request, "<decider> declined
your request to open a Canvas" (the decider's name from `accessRequest.decidedByName`),
which names no Canvas because the requester was refused it, wrapping to at most two lines before it is cut,
so the place, which comes last and tells two rows apart, survives a long name
or verb; the row's tooltip (`title`) holds the whole sentence. The time sits
at the first line's end. On the second line the preview, cut to one line,
with the unseen dot; a row with no preview has no second line, and its dot
sits after the time, so a row is as tall unseen as seen. An access request is
a group: its link, and under it, inside the same open and hover fill, Approve
and Deny (a link holds no buttons), sending
`POST /canvases/:id/access-requests/:userId/decision` for the row's Canvas
(`parentId`) and requester (`actor.id`) through `AccessDecisionActions`, the
component the Share panel's Requests section uses. The buttons are named for
the requester and the Canvas ("Approve Maya for Launch plan"), so several
requests from one person differ; in the phone sheet they take the shared
control height. The Activity push that the same write produces is what
settles the row, and a refusal is the app's error notice. Settled, who
decided takes the buttons' place on a line as tall as they were, so the list
does not move: "You approved" or "You denied" to the decider themselves
(`accessRequest.decidedByUserId` against the session user), "Maya approved"
or "Maya denied" to the others, or the name alone from a server older than the
id. The message stays the preview, and the row is seen. A request for a
Sidekick source (`source_request`, [`sidekick-sources.md`](sidekick-sources.md))
is the same group for the person asked: "<requester> asked for your
<connector> to start <Sidekick>" behind a bolt, and under it the condition in
full when there is one (the one-line preview cuts it, and it is what they are
agreeing to), then Approve and Decline, the
pair the conversation's card and the Sidekick panel draw
([`shared-ui.md`](shared-ui.md#sidekick-sources)), sending
`POST /sidekicks/:id/source-requests/:requestId/decision` for the row's
Sidekick (`parentId`) and `sourceRequest.requestId`. Their acknowledged choice
is drawn filled and held until the Activity push settles the row, which then
reads "You approved", "You declined" or "Replaced by a newer request" in the
buttons' place. Only the person asked has the row, so the answer is always
theirs. The requester's `source_approved` and `source_declined` rows are plain
rows: "<person> approved their <connector> for <Sidekick>", or "declined
their <connector> for <Sidekick>", the Sidekick last as every row's place
is, the person named by the directory or else by
`sourceRequest.personName`. The connector is worded as the card words it
("Gmail"); the preview is the server's. With nothing listed,
the section names every kind it carries. A seen row recedes through one text
colour for both lines (`text-muted`, 5.12:1 in light and 7.49:1 in dark) and a
lighter title weight, never through opacity, so every line of it clears 4.5:1. The rows the route has open (the same conversation, and the
same run when one is open) are drawn open at full contrast; keyboard focus is
a ring, never the open fill. A finished run's row is never drawn open: it opens
the shared conversation, which every finished row of that Sidekick shares, so
marking it would mark them all. A Canvas Chat mention opens the Chat at its message
(`canvasTurnRoute`, from the row's `messageId` and `messageSequence`, the
mentioning turn's transcript sequence the effect carries), and a reply's row
(`new_message`) the same way; a mention recorded before the effect carried it,
an add, an access request and a grant open the Canvas, a declined request
(`access_denied`) opens the Canvas's id onto its requestable pane, which then
says "Request declined" and offers Request access again (opening it reads no
conversation, so the row stays unseen until the requester asks again or Mark
all seen), a source row opens its Sidekick, whose Sources section shows the
request, but only while the viewer's Sidekick list holds that Sidekick: the
person asked usually cannot open it until they approve, so until then their
row opens the Activity home (`/activity`) and is never drawn open
(`activityRoute`'s `sidekickListed`), and a pinned Canvas's
new version (`artifact_updated`) opens it onto that artifact
(`?artifact=<resourceId>`). A row about a
Sidekick opens its conversation, where a run's row is, and a reply there opens
the same conversation; a finished run's row
opens it too, because a read of `"0"` is what clears that row and the run's own
view reads the run. A run that needs input
(`runId`) and a mention in one of its runs open that run (`?run=`), where the
question and its answer form are. An open conversation reports a read on
open, when its cursor moves, and once more for each settled change of its
turns while it is open and visible (`useOpenReadReport`, keyed by
`transcriptTurnsKey`): a run's row finishing in place in front of its
requester moves no cursor, and without that report the finished row stayed
unseen while they watched it. Settled means a turn still live (an active
turn, a streaming block, or one with an `assistant_turn` overlay) counts only
once it settles, because the server revises an assistant turn on every tool's
start and end and each report is a write; the viewer's own turns count for
nothing, since sending one moves the cursor. Loading an older history page
adds turns, so it owes one report at an unchanged cursor.
Opening the run does not read the shared
conversation, so a needs-input row stays unseen until the shared conversation
is read or Mark all seen, the same as a mention in a run. Opening a row keeps the
Activity section open, and so does anything else the pane opens: only a rail
pick leaves it. Entering the section opens its top row in the pane, the row
drawn open and its conversation reporting the read as a click would (pushed
from the rail, replacing a Canvases-home landing at a launch with Activity stored;
[`desktop-shell.md`](desktop-shell.md) has the navigation rule). An empty
feed opens `/activity`, which explains what will appear in the list. If items
arrive while that page is open, it prompts the viewer to choose one. The rail badge is `unseenCount` ("3 unseen"). The dock
badge, and an installed browser app's icon badge, is the same `unseenCount`
while Rally is open (`dockBadgeCount`), the count a push sets on the icon
while it is closed ([`push-notifications.md`](push-notifications.md)); the
menu bar stays Needs attention only ([`menu-bar.md`](menu-bar.md)). The
account menu counts another Organization's unseen Activity
([`multiple-workspaces.md`](multiple-workspaces.md)).

## Invariants

- **A row is written in its intent's transaction, by the intent's recorder.**
  A row written anywhere else could exist without a push, or a push without a
  row. Guard: `workspace-activity.test.ts` (each kind produces its row through
  the production recorder).
- **A row's id is its intent's id.** A replayed effect or retried alarm must
  converge on one row; a fresh id per attempt would list the event twice. A
  collapsing kind's row keeps its first intent's id and is moved only by the
  call that wrote a new intent. Guard: the mention case's single-row
  assertion after redelivery; the reply batch case's one row for two replies.
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
- **A row lists only while the person may open the parent**, except a
  declined request (`access_denied`), which carries nothing of the Canvas but
  its id, and the three Sidekick source kinds, which carry the Sidekick's name
  and what was asked and nothing of its conversation. Otherwise a
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
them. The menu bar does not read it; the dock badge, and the push badge, count its unseen rows.

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
  (`lastReadAt`, a245f7ba1); before it, the effect outbox
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
- **A build older than the Sidekick source kinds is sent its Activity without
  them.** `ActivityKindSchema` is a closed enum inside the workspace socket's
  strict sync event, so one row of a kind a build does not know fails that
  build's parse of the whole subscribe answer: no Canvases, no Sidekicks and
  no Activity, on every reconnect. The socket's ticket carries the client
  contract its request declared, and a socket below
  `SOURCE_ACTIVITY_CLIENT_CONTRACT` (14), or one that declared none, gets the
  page and `unseenCount` with the three source kinds left out
  (`activityPage`'s `sourceKinds`). Such a person is still pushed and emailed,
  and `attention()` (the push's badge, the account menu) counts the row, so a
  closed older Mac's dock badge can be one higher than its rail until it
  updates. A new kind after this one needs the same gate, or a raise of
  `MINIMUM_SERVED_CLIENT_CONTRACT`.
- **A desktop from before the pivot** is refused the workspace socket ticket
  (`MINIMUM_SERVED_CLIENT_CONTRACT`), so it is sent no Activity at all.

Canvas archive excludes every row about that Canvas from both the page and the
unseen count, including a denial notice. Denials remain visible for inaccessible
active Canvases; archive removes the target altogether. The archive transaction
notes every stored recipient so the change reaches already-open workspace sockets.

## Testing

`test-workers/workspace-activity.test.ts` covers archive removing a mention
and its unseen count from an open recipient socket and a fresh subscribe.

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

`hosted-reply-notifications.test.ts` covers a reply's row: two replies in
one batch are one row carrying the newest, a reply within the cooldown moves
that row, the row clears when the cursor passes the reply, and the next reply
after that is a new row. `canvas-artifact-notices.test.ts` covers a pinned
Canvas's new version: a row naming the artifact for the pinner who did not
make it, collapsing while unseen, cleared by a read of the Chat, and a new
row after. `sidekick-source-notices.test.ts` covers a source request's rows:
the asked person's row listing though the Sidekick is not theirs to open, the
row settled and seen by an approval, a decline and a newer ask, the
requester's answer row, and a socket whose ticket declares contract 13, or
none, receiving neither row nor count. `canvas-access-requests.test.ts` covers a request's rows on the
creator's socket and the administrator's page, settled and seen for both by
one approval, and the requester's grant row.

The renderer's `workspace-socket.test.tsx` covers the page and the push, and
`navigation-sidebar.test.tsx` the rows, their links, the badge, the empty state and Mark all seen (a source request's pair, its settled line and where it opens included), and `rail-dock-badge.test.tsx` that the dock badge is Activity's unseen count, sent only once the list has arrived.

## Data model

| Table | Key | Columns |
| --- | --- | --- |
| `workspace_activity_items` | `item_id` (the intent's id; a collapsed row keeps its first intent's) | `workspace_id`, `recipient_user_id`, `kind` (`mention`, `participant_added`, `needs_input`, `run_finished`, `new_message`, `artifact_updated`, `access_request`, `access_granted`, `access_denied`, and, from migration 146's rebuild, `source_request`, `source_approved`, `source_declined`), `parent_kind` (`canvas`, `automation`), `parent_id`, `substream_id`, `message_id`, `message_sequence` (the mention's transcript sequence), `run_id`, `actor_kind` (`person`, `rally`, `sidekick`), `actor_id`, `preview`, `attention_ordinal` (null: clears only by Mark all seen), `created_at` (ms; a collapsed row's moves to its newest event), `subject_id` (what it is about beyond the parent: an artifact's resource id, an access request's id, a Sidekick source request's id). Indexes `(recipient_user_id, created_at DESC)` for the page and `(recipient_user_id, parent_id)` for a read report. |
| `workspace_activity_seen` | `user_id` | `seen_through` (ms): Mark all seen. |
| `canvas_access_requests` | `request_id` | Read for an `access_request` row's seen and its `accessRequest` ([`canvas-access-requests.md`](canvas-access-requests.md)). |
| `sidekick_source_requests` | `request_id` | Read for a `source_request` row's seen and every source row's `sourceRequest` ([`sidekick-sources.md`](sidekick-sources.md)). `person_name` is the asked person's name, taken when they answer. |
| `workspace_sidebar_list_state` | `list` | Row `activity`: the list's waterline. |

## Changelog

### 2026-11-10 — Sidekick source requests join the feed; their rows list for a person who cannot open the Sidekick, and open nothing until they can

**What changed:** Activity records `source_request`, `source_approved` and
`source_declined`. They list while the Sidekick exists, whether or not the
recipient can open it, and a row opens the Sidekick only once the viewer's
Sidekick list holds it. A socket below client contract 14 is sent its page
and count without them.

**Why:** Approving is what makes the person asked a reader, so the rule that
a row lists only while its parent opens would hide the request from the one
person it asks. [`sidekick-sources.md`](sidekick-sources.md#changelog) holds
the reasoning and what was rejected.

**Consequences:** A source row's content must stay what its recipient may
already know (the Sidekick's name and what was asked): the listing exemption
is safe only while that holds. `ActivityKindSchema` is a closed enum in a
strict sync event, so the next kind needs its own contract gate or a raise of
`MINIMUM_SERVED_CLIENT_CONTRACT`; this gate goes when the minimum reaches 14.

### 2026-11-09 — Remove archived Canvas Activity atomically

Archive must remove the content and attention attached to a Canvas, not merely
its sidebar row. The page and count share the archive predicate, and the archive
transaction advances recipient waterlines so an open feed does not retain stale
previews until reconnect.

### 2026-11-09 — Document created: Activity is a per-person feed written with the push it mirrors

**What changed:** Activity returns as the rail's third section: one person's
mentions, adds and Sidekick run notices, replies, pinned-Canvas updates, and
access requests, grants and denials. WorkspaceDO migration 140 adds
`workspace_activity_items` and `workspace_activity_seen`. A row is written in
the transaction of the notification intent it mirrors
(`recordPersonNotificationIntent`, `recordSidekickRunNotices`,
`recordParentNotice`); reply and pinned-update rows collapse to one unseen row
per conversation or Canvas. The workspace socket carries the page and
`workspace_activity_list`, with `activity_mark_all_seen` its one command. Seen
is derived, never marked per row: by the read cursor passing a mention's
ordinal, by a run leaving `needs_input`, by a request being settled, or by Mark
all seen. The page and its counts are one SQL expression (`listedSql`,
`ACTIVITY_SEEN_SQL`), which also answers `attention()`'s count behind the
account menu, the push badge and the dock badge. A row lists only while its
person may open the parent, with one exception, `access_denied`, which carries
nothing of the Canvas but its id.

**Why:** The owner asked on 2026-11-08 to bring the section back. The Thread-era
feed, the Activity tab of the retired `digests.md`, was deleted with the Threads
it read. Writing each row with the intent it mirrors means the feed cannot drift
from what was pushed, and deriving seen from the read cursor that drives every
unread means it cannot disagree with the Canvas or Sidekick row. The access
filter came from the end-to-end pass, which found a mention in a creator-only
Canvas sending its preview to someone who could not open it. A read is dated by
the report's own time because an identical report at an unchanged cursor was
dropped by the outbox's receipt fence, leaving a finished run's row unseen.

**Considered and rejected:** Deriving the feed from each conversation's
transcript on read, a fan-out over every conversation on every rail open. A
`seen_at` column or a per-item mark command, a second read state beside the
conversation's own. A row per reply or per reply batch, which would bury the
feed. Opening a finished run's row at its run (`?run=`): the run view reads the
run's conversation, so the row would never clear. Dimming seen rows by opacity,
which left their previews at 1.9:1.

**Consequences:** A new person-facing event joins by being recorded through one
of the recorders, or by calling `recordActivityItem` in its own intent's
transaction. A change to what lists or what is seen changes `listedSql` or
`ACTIVITY_SEEN_SQL` once, for the page, the counts and the badges together. A
read is dated by when the person read, never by delivery. Nothing prunes either
table: retention, and the 1,000-character preview the subscribe frame carries,
are numbers for the team to set.

Shipped in juno-ai-labs/avalon#1490.
