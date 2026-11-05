# Activity events and scheduled digests

Two things live here because the second is built on the first. The
**activity log** is Rally's first-party record of what happened that someone
should hear about, and it feeds the Activity tab. The **digest** is what is
still unread in that tab, sent to a person at the start and end of their day.
The digest reads the tab, not the log.

Read this before adding a notification surface, adding something a digest should
mention, or changing what a connector can deliver to a person.

## Where the code lives

| Concern | File |
| --- | --- |
| The log: writes | `apps/api/src/services/activity-event-service.ts`, backed by WorkspaceDO SQLite |
| Digest configuration, RRULE derivation, schedule rows | `apps/api/src/services/digest-service.ts` |
| Firing one occurrence: the unread rows, the text, the claim, the settle | `apps/api/src/services/digest-run-service.ts` |
| Deciding whether a connector activity may be digested (written, read by nothing today; see [Digestible](#digestible-what-a-person-should-be-told)) | `activityIsDigestible` in `apps/api/src/queues/activity-consumer.ts` |
| Destination dispatch | `apps/api/src/services/digest-delivery-service.ts` |
| The digest as a thread in the person's Personal Channel | `apps/api/src/services/digest-personal-channel.ts` |
| Email HTML | `apps/api/src/services/digest-email-content.ts` |
| Access-request acknowledgements, plain text only through the shared reducer | `apps/api/src/services/access-request-service.ts`; lifecycle in [private access](private-access.md). |
| Markdown → email HTML | `apps/api/src/services/email-markdown.ts` |
| Which lines are code, for both of the above | `packages/contracts/src/markdown-code.ts` — see [`markdown-code.md`](markdown-code.md) |
| Rendering the email for real people, to look at | `scripts/preview-digest-email.mjs` |
| Settings → Notifications → Daily digest | `DailyDigestSettings` in `apps/desktop/src/renderer/components/notification-settings.tsx` |
| The work-stream list every renderer surface shares | `apps/desktop/src/renderer/lib/use-workstreams-query.ts`, served by `WorkspaceDO` |
| The Activity tab's read over the log and the directory, and its read mark | `apps/api/src/durable-objects/workspace-activity-feed.ts` |
| Who is told about news in an Organization-wide Channel | `apps/api/src/durable-objects/activity-audience.ts` |
| A breakout mention's emptied shape and its author-only audience | `apps/api/src/durable-objects/breakout-activity.ts` |
| `GET /navigation/activity` and `PUT /navigation/activity/seen` | `apps/api/src/routes/navigation.ts` |

### Why a second activity table exists

`WorkspaceDO.workspace_connector_events` is provider ingest authority. It is
keyed by connection-scoped provider identity and dedupe constraints, written
before anyone has decided what an event means, and settled by its processing
Workflow. It answers *what did GitHub tell this workspace*. Legacy regional D1
`activities` rows are maintenance import input and are scrubbed before cutover;
live ingest writes no D1 event body.

`WorkspaceDO.workspace_activity_events` answers a different question: *what happened in Rally that
this person should hear about*. A Rally mention has no connection. A
work-stream message has no provider event id. Neither has a dedupe key a
provider controls. Widening `activities` to hold both would leave first-party
rows carrying a column of synthetic nulls for every provider concept they do not
have, and would make every consumer filter ingest state out of a feed.

So the two stay separate, and connector activity is **projected** into
that workspace-local log once it has been processed. Every surface that wants "what
happened, for this person, since this instant" reads one table.

### Private child notifications

Substream mentions and participant additions use the existing direct Slack/email
notification pipeline with child-addressed links. A breakout's activity stays
inside the parent with one exception: a message that mentions somebody enters
the shared log emptied, with no body, `digestible: false`, and its author as the
only audience (see [The Activity tab](#the-activity-tab)). No digest reads it.
Direct notification delivery does not require publishing child activity or
aggregating its unread count into the work stream.

### The log

`workspace_activity_events` is append-only. Four things make it generic rather than a
digest-shaped table with a general name.

**`event_type` and `subject_type` are open strings.** A producer adds a value; no
consumer enumerates them. An unrecognized event still renders, because whoever
knew what happened wrote `title` and `body` at the time.

**Audience is a rule, not a recipient list.** `audience_kind` is one of:

| Kind | Who reads it | Used by |
| --- | --- | --- |
| `workspace` | every active member | workspace-scoped connector activity |
| `user` | exactly one person | a personal connection's activity |
| `workstream` | the work stream's current active participants | work-stream messages |

It is resolved against the reader at read time, by every reader of the log,
against WorkspaceDO's own authoritative directory/viewer rows in the same local
database. Storing recipients instead would freeze the audience at write time:
someone added to a work stream today would never see what happened in it
yesterday.

**`workspace_activity_event_targets` is involvement, not audience.** Audience says who
*may* see an event; a target row says the event is *about* someone — `mentioned`,
`involved`, and whatever a later producer needs. That is what lets a digest lead
with "you were tagged" rather than burying it in a list of everything that moved.
A target outside the audience is stored anyway; the read query still filters by
audience, so recording involvement never grants visibility.

**`event_sequence` is the cursor axis.** No reader resumes from a cursor today
(the digest did until 2026-10-15), but one that does needs a total order that an
insert can only ever extend. Timestamps cannot give
one — two events written in the same millisecond tie, and any tiebreak (a UUID, a
hash) can place the second one *below* a cursor taken after the first, dropping
it from every future read. `event_sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT`:
`AUTOINCREMENT` is what makes it strict, because plain rowids are reused after a
delete and a reused one would appear beneath a cursor that has already passed.

`created_at` is display and retention only. Never cursor on it, and never cursor
on `occurred_at` — a connector poll inserts events whose provider timestamp is
hours old.

#### People interaction ranking

The People picker reads retained human replies and @mentions in either
direction, filtered by current conversation access. Each event counts once per
other person; frequency wins, then recency, then id. Main replies use event-time
participant targets, so replies in a joined Thread count even if the reader did
not post. Breakout replies use current participants because their events retain
only mention targets. Merged copies, agents and connector activity do not count.

`workspace-people-ranking.ts` seeks the reader's authored events, directed
mention/participant targets and participating Breakout replies before applying
access and active-placement checks. Migration 126 adds the partial author
index; existing target and conversation indexes supply the other seeks. Access
joins are materialized once. The unary `+` on the Breakout id comparison keeps
SQLite's expression index seek on both Thread and Breakout; the workerd
regression checks that 10,000 unrelated replies do not increase the read cost.

Guests cannot read ranking. Channel scores use the route's active Channel
placements; standalone Threads get Organization ranking only. This log's
retention also bounds ranking evidence. The [shared picker](shared-ui.md#people-picker-order)
owns eligibility, the five-suggestion display and menu ordering stability.

#### Retention

The WorkspaceDO alarm drops events older than ninety days oldest-first in
bounded batches and lets the cascade take their targets. The oldest retained
row schedules the next expiry; an idle workspace does not wake on a polling
cadence. The log is append-only and would otherwise grow forever.

Ninety days is far longer than anything reads: the Activity tab shows one page
of recent rows, and the digest lists what is in that page. Reaping never disturbs a cursor —
an expired `event_sequence` sits below every live one, so a window that has lost
its rows reads as empty rather than as new. A surface that wants to read further
back than ninety days needs this number raised, not a second table.

#### Digestible: what a person should be *told*

Audience answers who *may* hear about an event. `digestible` answers whether
anybody wants to. They are different questions, and collapsing them is how a
digest becomes a transcript of continuous integration: a repository under active
development emits two events per check run and three per workflow run, so the
oldest two hundred events in a window can be seventeen minutes of one morning's
builds while the reviews, merges and comments sit behind them unread.

**Every event carries the answer on its row**, in `workspace_activity_events.digestible`.
**Nothing reads it today.** Until 2026-10-15 the digest read the log through
`listActivityEvents` with a required `digestibleOnly`; the digest now lists
unread Activity rows (mentions, additions, starts and finished runs), which are
not connector events, so connector activity reaches nobody on a schedule. The
column and the manifests' declarations stay because they are cheap to keep and
expensive to rebuild: a surface that interrupts somebody about connector
activity reads the subset this column marks, and should take the choice as a
required argument rather than a default, because both readings are legitimate
and the wrong one is invisible.

**A withheld event is not a lesser event.** It is ingested, routed, matched
against automations and watches, recorded in the log, and readable by everyone
its audience covers. It simply does not interrupt anybody.

**The column's own `DEFAULT 1` is the one part of this that fails open**, and it
is deliberately left that way — see the changelog entry below for what it cost
and why changing it is expensive. It governs only an insert that does not name
the column, which no production code path performs, so anything reaching
the workspace activity log outside `recordActivityEvent` must set `digestible` itself
rather than expect the column to withhold on its behalf.

For connector activity the answer comes from the connector's own manifest —
`digestible` on each activity type, plus a polling stream's veto over its own
output — which [`connectors.md`](connectors.md#declaring-what-a-digest-may-read)
owns. Nothing about which events matter is written here or in the digest.

#### Adding a producer

Call `recordActivityEvent` with a `dedupeKey` that is stable per workspace, so a
retry or a replayed queue message resolves to the row the first attempt wrote.
It never throws into its caller: an event log that can fail a message post is
worse than one that occasionally misses a row. Use
`recordActivityEventOrThrow` when the write genuinely has to land.

`digestible` is a required field of that call, with no default. A producer that
has not decided whether it is writing news or machinery should not get the
benefit of the doubt in somebody's inbox, and the compiler asks at the call site
rather than letting the question be answered weeks later by whoever receives the
email. A first-party producer knows the answer where it stands; a connector
producer resolves it from the manifest.

Producers today:

| Producer | Event type | Audience | Digestible |
| --- | --- | --- | --- |
| `WorkstreamService.createMessage` | `workstream.message.posted` | the work stream; mentions become `mentioned` targets | always — everything Rally records here is somebody addressing somebody |
| Authoritative `SubstreamAgent` regional-effect outbox | `workstream.message.posted` and later first-party work-stream events | the work stream; named targets travel in the same immutable effect | decided by the object mutation; messages are digestible |
| `WorkstreamObjectProduct.addParticipant`, `WorkstreamObjectProduct.initialize` | `workstream_participant_added` | the work stream; the person added is an `added` target | always — being put in a room is addressed at exactly one person. `initialize` writes one per name in `participantUserIds`, never for the creator |
| `activity-consumer` after routing | `connector.<provider>.<manifest event type>` — so `connector.github.github.push`, and `connector.google.email.received`, because GitHub's manifest ids carry a provider prefix and Google's do not | the connection's own scope | whatever the connector's manifest declared for that activity type |

Since the navigation redesign, a conversation's message and participant events
also carry `metadata.substreamId` (`"0"` for the thread itself, a breakout's id
otherwise), and its message events name each mentioned person as a `mentioned`
target ahead of the `participant` targets (`activityTargets` in
`workstream-object-product.ts`, cut at the effect schema's hundred). The
Activity tab reads these; see [The Activity tab](#the-activity-tab).

### The Activity tab

`WorkspaceActivityFeed` (`apps/api/src/durable-objects/workspace-activity-feed.ts`)
is the second reader of this log, behind `GET /navigation/activity`. It reads,
for one person, newest first:

- events naming them as an `added` or `mentioned` target;
- the latest human reply by somebody else in each conversation they participate
  in (`new_message`), from the existing message-event log. Its
  `unreadMessageCount` counts replies above the viewer's message waterline and
  Mark all read timestamp and the participant's initial read cursor. Migration
  125 indexes replies by conversation and attention ordinal. The query starts
  from participating conversations, seeks each latest reply and counts only
  replies above its read floor; no window scans over read history. Pushes
  restrict these seeks to the changed conversation before pagination.
  The author and nonparticipants receive no reply activity; AI and tool traffic
  never becomes `new_message`. Builds before client contract 11 omit these rows;
- every thread and breakout somebody else started, read from its own
  directory row (`channels` / `breakouts`: `created_by_user_id`,
  `source_created_at`) rather than from an event. An Organization-wide
  thread placed in an Organization-wide Channel is told only to participants
  of a Channel it is in and of the thread (or, for an Organization-wide
  breakout, of the breakout); see [Who is told about Channel
  news](#who-is-told-about-channel-news); and
- the latest finished run (`exact_state = 'completed'`, `completed_at`) of
  each thread and breakout they take part in, read from the directory rather
  than from an event; and
- every **merge** somebody else made ([`conversation-merge.md`](conversation-merge.md)):
  a breakout's into a thread they may list, read from the merge message's own
  event (its `metadata.mergedFrom`, through migration 109's partial index), and
  a thread's into a Channel they may list, read from `space_messages`, whether
  or not they may open the thread. Both are `merged`; a thread's carries
  `mergedInto`. A thread's merge into an Organization-wide Channel is told only
  to the Channel's participants and the thread's. A merge from a thread they may not open is the Channel's row:
  `mergedInto.threadPrivate`, an empty `threadTitle`, and the Channel as its
  only `channelIds`. A build before client contract 7 is served the page
  without merges, and one before 9 without those rows.
- every new **version of an artifact they pinned** that somebody else made
  after they pinned it, while it is generated in a Main they may open
  (`artifact_updated`), read from `resource_versions` against their pin
  ([`workstream-pinning.md`](workstream-pinning.md#artifact-pins)). It is
  settled by reading the artifact through that version, the subject
  `{ kind: "artifact" }` whose waterline is the version seen. A build before
  client contract 8 is served the page without them.

The listing rules apply inside each SQL arm, a breakout through both of the
conversation page's gates, so a row the person may not list now is never read
at all. A page and its cursor therefore never carry a thread or breakout the
viewer cannot list; filtering after the read would have let a page come back
short, or empty with a cursor that names a hidden row.

#### Who is told about Channel news

Listing decides who may *see* a thread or a Channel post; `activity-audience.ts`
decides who is *told*. Every member may list an Organization-wide thread in an
Organization-wide Channel, but its start and its merge into the Channel reach
only people taking part: participants of the Channel (`space_viewers`) and of
the thread (`channel_viewers.is_participant`). A member who never joined the
Channel can still find and open the thread; nothing about it lands in their
Activity, digest, push, email or Slack.

A Channel counts only for what happened after the person joined it.
`space_viewers.joined_at` (migration 134) is stamped from WorkspaceDO's own
clock each time a row turns participant, by every writer: Space creation, an
audience change, seating (General, invitees, posting, starting a thread there)
and the Space's `directory_user` projection, which carries no join time of its
own. A start is compared by `source_created_at`, a merge by `posted_at`. So
joining a Channel brings none of its history into Activity, and someone who
leaves and rejoins hears only what follows the rejoin. A participant from
before migration 134 has no recorded join time (NULL) and keeps hearing about
everything, as before. Participation in the thread itself is not timed: being
added to a thread still tells you it started, and of its merges.

The rule narrows only Organization-wide scope. A private thread or private
Channel already lists to its people. A thread placed in no Organization-wide
Channel keeps its listing audience. Every member is seated in General, so
General's news still reaches everyone who has not left it.

**`?only=mentions`** runs the first arm alone, narrowed to the `mentioned`
relation, so the page and its cursor are cut from mentions and nothing else.
The tab's Mentions chip reads it, because mentions are sparse and a client
filter over newest-first pages could draw an empty page with more behind it.
Unread is the client's, filtered over the pages it holds. Once events settle
rows one subject at a time, unread is no longer a run at the top of the feed,
so the Unread chip can show a short page with more behind it; **Show more**
reads the next. A server filter like `only=mentions` is the fix if that bites.

**The sidebar flattens conversations.** `groupActivityItems` in the contracts
package folds the loaded pages into one row per thread or breakout. The latest
human reply supplies the preview with generated personal instructions removed;
any unread event keeps the row unread, and an unread mention survives later AI
completions. The row sorts at its latest event,
uses a stable conversation key, and shows the reply count and an @mention
indicator. The Activity badge and macOS menu use the same grouping. Artifact
updates and merges into Channels retain their own destinations so their read
waterlines remain actionable. Showing Activity clears nothing.

**A breakout's mentions and human replies** reach the log in one narrow shape
(`breakout-activity.ts`). A breakout is private to the people in it, and a
`workstream`-audience event reaches every participant of the parent thread
through any reader of the log. So the parent (`HostedParent`) forwards a
breakout's message event when it names somebody or has a human author, stamps
`metadata.substreamId` on it, and forwards it emptied: no body, `digestible:
false`, its targets the mentions alone. WorkspaceDO stores any event that
carries a `substreamId` with its author as the only (`user`) audience, the one
reader who could already see it. One with no author is skipped, never stored
under the parent thread's audience, because that audience is exactly the set of
people the breakout is private from. It is kept out of the work-opportunity
outbox and sent to no further consumer. The Activity tab reads its target edge,
and the breakout listing check above decides whether the person named sees it.
Nothing here changes what a digest reads.

**An item is done two ways**, and neither is a row per item.

Read rows are visually de-emphasized, with full opacity restored on hover,
keyboard focus, or an increased-contrast preference. Unread rows and pending
access requests retain full opacity.

- **Mark all read** moves one time per person (`workspace_activity_seen`,
  migration 97) through `PUT /navigation/activity/seen`; every item at or
  before it is done. Showing the tab reads nothing. Moving the mark publishes
  the `activity` sync topic to that person's sockets alone, so their other
  windows and the macOS menu bar, which lists the unread rows
  ([`menu-bar.md`](menu-bar.md)), read the feed again.
- **Events.** The app reports what the person did through
  `POST /navigation/activity/events` (`ActivityEventSchema`). Today there is
  one kind, `read`: a subject (a thread, a breakout, or a Channel) and the
  attention ordinal it was read through, 0 for an open. Each subject keeps one
  waterline per person (`workspace_activity_reads`, migration 101), moved to
  the higher of where it was and the event's ordinal, so a late event never
  moves it back. Reading message 29 of a thread settles a mention at 29 or
  earlier and leaves one at 30 standing. An event that makes a waterline new
  or higher publishes the same per-person `activity` topic Mark all read does;
  one that moves nothing publishes nothing.

**What clears an item is a rule** in a small data language: its grammar, the
rule for each kind, and the evaluator live in
`apps/api/src/durable-objects/activity-clear-rules.ts`, and the feed only binds
each row's subjects (`activityRowFacts`). In words:

- `mentioned`: the conversation read through the mentioning message.
- `added`: the conversation opened after the add.
- `breakout_started`: the breakout opened.
- `thread_started`: the thread opened, or a Channel it was placed in read past
  that placement, removed placements included.
- `run_finished`: the conversation opened after the run finished.
- `merged`: where it landed read through the merge's own ordinal, or opened:
  the thread for a breakout's merge, the Channel for a thread's.

A rule only compares against things that move forward, so a cleared row stays
cleared; a new rule has to keep that.

The desktop reports reads from the visible-read path of a conversation and a
Channel (`lib/activity-events.ts`): the highest ordinal on screen, once per
opening and again when it rises, whether or not the room's own read position
needs moving. A hidden pane reports nothing. Activity is read again only when
it holds an unread row about that subject. Events are the client's to send
rather than a side effect of the acknowledgement routes, so a new kind of
event joins the same endpoint without touching how a conversation keeps its
own unread state.

Every row here is also a push notification:
[`push-notifications.md`](push-notifications.md#activity-rows) owns how a row
reaches a device, and reads this feed to decide it, so a row this tab would
not list is never pushed.

Starts are not read from the opening message's event. Driving the local stack
showed that event does not reliably reach WorkspaceDO (only a handful of
thread-level activity receipts for dozens of threads), and a breakout's is not
forwarded unless it names somebody (`forwardsChildEffect`). The directory row is what every other list
here is drawn from, so a start appears exactly when the thread does. Starts
carry the starter's id and an empty label; the client names them from the
member directory, as the Channel feed names its authors.

### The digest

One digest per person per workspace: a set of days, up to two times, and a set
of destinations. Settings → Notifications → **Daily digest** shows it as two
slots, **Start of day** (the first time before noon) and **End of day** (the
first after it), a **Send to** choice, and **Weekdays** or **Every day**.

**It is what is still unread in Activity, and nothing else.** No model writes
it. At each occurrence the scheduler reads the person's first Activity page
(`listActivity`, the same read the sidebar makes), keeps the rows that are
`unread`, and lists them under one `##` section per kind, in the order Settings
lists the kinds, each worded as the sidebar words it and linked to what it
names (`renderUnreadDigest`). A row is listed while it is less than two days
older than the occurrence, or newer than the last delivered digest, whichever
reaches further back (`splitByAge`); older unread rows are counted in one
closing line, "N more older than 2 days.", rather than listed again. The second
bound is for gaps longer than two days, such as a weekday schedule's Monday: a
row from Friday after Friday's digest has not been listed yet, so it is. Nothing
unread inside the window, nothing sent: the occurrence settles as `empty`, even
when older rows remain.

**A digest is on by default**, for people who already exist and for anyone who
joins later: weekdays at 07:45 in their own timezone, to their email and, for
anyone who is not a guest, their Personal Channel (shown as Rally).

**There is no digest timezone.** A digest's times are wall-clock times in its
owner's own day, and `users.timezone` already says when that is. The derived
`schedules` rows carry the resolved zone because that is the scheduler's
contract, and `rebuildDigestSchedulesForTimezone` re-derives them whenever the
account timezone changes.

#### Who gets one

`reconcileDigestDefaults` runs on the ordinary cron and makes two things true.
It is where "on by default" is implemented, rather than at the four places a
membership is created: a reconciler covers the path someone adds next as well as
the four that exist today, and repairs a half-written save instead of leaving it.

1. **An active member with no digest gets the default.** Absence is unambiguous —
   switching a digest off keeps its row with `enabled = 0` — so this can never
   resurrect something somebody turned off. A member with no account address is
   skipped, because the default destination is that address. The one exception
   is a digest marked `default_destinations_pending` by WorkspaceDO migration
   108: the same call adds whichever of email and Personal Channel it lacks,
   switches it on, and clears the mark. A save clears it too, so the reconciler
   never overrides a choice made after the migration.
2. **An enabled digest with days and times but no `schedules` rows gets them.**
   That is the state a fresh default lands in, and the state a save leaves if it
   fails between writing the configuration and deriving the rows.

#### Scheduling

Each **time** gets its own `schedules` row, not each digest. A single RRULE
cannot carry a list of times: `BYHOUR` and `BYMINUTE` multiply out, so 09:00 plus
17:30 would also fire at 09:30 and 17:00. One rule per time says exactly what was
asked for, and the workspace's alarm already advances, retries and disables each
row independently.

Saving replaces everything: destinations are resolved and frozen *before*
anything is written, so a destination that has gone away fails the request rather
than leaving a schedule that fires into nowhere. A digest with no slot on, or
nowhere to send it, is saved switched off. The workspace alarm is refreshed
*after* the write.

#### An occurrence

`fireDigestSchedule` checks the schedule's own `enabled` bit, then the
execution principal, before anything is written. Then:

1. The occurrence's id is derived from its schedule and instant, so a retried
   alarm finds the delivery its first attempt claimed.
2. A first attempt reads the unread rows, renders them, and claims the
   occurrence in `digest_deliveries` (unique on
   `(digest_schedule_id, planned_for)`) with the text in `summary_markdown`.
   A retry sends that kept text rather than reading Activity again, so every
   destination receives the same digest.
3. Each destination is sent and records its own `last_delivered_delivery_id`.
   A destination's failure is recorded and not thrown: the next occurrence is
   rebuilt from unread Activity anyway, and a retry would hold the schedule row
   and every later occurrence until that destination recovered. An attempt that
   dies before settling is retried by the alarm and sends only what has not
   landed.
4. The occurrence settles `delivered`, or `failed` when every destination
   failed, exactly once.

**Digests never touch the read state.** Sending a digest does not mark anything
read: a row stays in Activity, and in the next digest, until the person reads
it or marks Activity read. Someone who reads nothing between the start and end
of their day gets the same rows again, which is what "unread" means, but only
for two days: after that a row is a count, not a line, so an inbox ignored for a
week does not get the same list every morning.

#### Delivery

Email is the built-in destination and needs no connector. The person's
**Personal Channel** is the other built-in one: the digest arrives as a new
thread in it (`postDigestToPersonalChannel`), titled `Start of day · 15 Oct`,
holding one message from Rally and no run. Nobody created the thread, so it
reaches its owner unread and unseen like any message Rally writes, and no
`thread_started` row announces it. Every step is keyed on the delivery, so a
retry lands on the same thread and message. Its destination row stores the
Space where a connection would be and the person where a provider user would
be, which is the row's shape for anything that is not an email address. A
guest has no Personal Channel and is refused it.

Every other destination is a connection whose connector declares a
`userDelivery` surface in its manifest — the same declaration
[`connectors.md`](connectors.md) describes. The settings screen renders
whatever the API offers, so a connector that starts declaring a surface becomes
a digest destination with no UI change. Adding transport for a new surface is
one entry in `CONNECTOR_DELIVERIES` in `digest-delivery-service.ts`; a target
type with no entry is skipped rather than failing the occurrence.

A destination the provider permanently rejects is moved to `needs_input` rather
than failing silently forever.

#### The email

`digest-email-content.ts` wraps the digest's Markdown, rendered to email-safe HTML by the shared `email-markdown.ts`, in the digest's own shell.

It is light, and only light: the email is a copy of a Rally surface in the
app's light theme, because a mail client cannot report which appearance the
reader chose. Every colour is a light token from
`packages/ui/src/styles/themes.css`, written inline — a mail client will strip a
`<style>` block — and `color-scheme: light only` is declared three ways so a
client in dark mode leaves the page as drawn.

The canvas runs the height of the reading pane rather than stopping at the last
line, so a short digest does not end in a hard edge with the client's own white
below it. `height: 100%` on the document and on the body is the whole of it.

A body background propagates to the canvas and paints the pane by itself, so in
most clients this changes nothing. It exists for the one that paints its own
background onto `html`: propagation happens only while the root element has none,
so that client breaks it, and a full-height body paints the pane itself instead.

The percentage is load-bearing and a viewport unit would be wrong. A webmail
client strips `<body>` and injects the markup into its own page, where the
percentage meets an auto-height ancestor and collapses — leaving the message the
height of its content, which is what a thread card wants. `100vh` would measure
the browser window there and hang a tall tail off the bottom of the card.
Nothing carries a height on a layout table for the same reason: the Word engine
reads that as a minimum against the page box.

All three are worth checking when this changes, and `preview-digest-email.mjs`
only shows the first. Injecting `html { background: #fff !important }` into the
preview reproduces the second; rendering the body markup into a container inside
a taller page reproduces the third.

The structure is: preheader (what a phone shows beside the subject, leading with
the count that decides whether this gets opened now), wordmark, title and
occurrence, count pills with the "for you" pill in brand, the body, a primary
action, and a footer holding only the link to change the schedule. Both links
go through the site's `/open` desktop handoff, addressed to the recipient's
organization (`digestHandoffUrl`): the button to `rallywithai://activity`, which
opens the main window with the sidebar on Activity, where every row the digest
listed lives; the footer to `rallywithai://settings/digest`. Layout is tables and inline styles only — no flexbox, no
grid, nothing a 2007 renderer has to guess at.

A general Markdown library is the wrong tool here: clients ignore most of what
one emits, and rendering raw HTML would mean rendering whatever a thread title or
a model's answer holds into an email. The renderer covers `#` document titles, `##` sections,
`###` subheads, bullets one level deep, numbered lists, links, bold,
`*` or `_` emphasis, inline code, and blockquote, and escapes everything before
a single tag is added, so an `href` can only ever be one it built itself — with
`*`, `_` and backticks encoded inside it, so the emphasis passes that follow
cannot match within the attribute. A table or a fenced block is kept verbatim in
a `<pre>`; other unknown syntax degrades to visible text.

**Citations are reduced before the renderer sees them.** A model's answer may
carry `resource://` link and image targets and GFM footnotes
([`markdown-rendering.md`](markdown-rendering.md)), none of which a mail client
has heard of — so `markdownToEmailHtml`, `markdownToEmailText` and
`markdownToEmailPreheader` each run `rewriteCitationsAsPlainText` first. Chips
and embeds become the words the model wrote; footnotes become numbered markers
over one trailing source list, with an internal source as its title and an
external one as a real link, because a link is the only way a reader outside
Rally can follow it. Without that pass all three leak: the HTML path links only
`http(s)` targets, so a `resource://` link arrives as literal bracket syntax;
the text path appends whatever target it is handed; and neither part has any
footnote handling at all.

**The order is load-bearing:** citations first, then `normalizeModelMarkdown`.
The TeX repair escapes Markdown punctuation in what it unwraps, and a `\[` it
manufactured would stop looking like the link the citation pass has to find.

**The plain-text part is also what Speak reads aloud**, through
`markdownToEmailText`'s `linkTargets: "spoken"`: a named link is its label, a
bare address is *link to* its registrable domain, and an unnamed image is
*image*. The decision and its reasoning are
[`message-speech.md`](message-speech.md)'s.

The digest's own text uses only `##` sections, bullets and links, so it never
reaches the parts of that list a model's answer needs.

The subject names the slot and the occurrence: `Start of day in Juno Labs ·
Wednesday 15 October · 9:00 AM`. Its category tag is `daily_digest`.

#### Looking at it

`scripts/preview-digest-email.mjs` renders the template for every active member
of a workspace and writes one HTML file each. Run it through `tsx`, because it
imports the real template rather than a copy:

```bash
pnpm exec tsx scripts/preview-digest-email.mjs            # the local D1
pnpm exec tsx scripts/preview-digest-email.mjs --db /tmp/global.sqlite
```

It uses regional D1 only for active-member identity and renders a sample body
chosen to stress the template — a priority section, a blockquote, bold, and one
bullet long enough to wrap. Delivered bodies, schedules, and work-stream titles
live in WorkspaceDO and are deliberately not queried from D1. **Every visible change to
the template should be looked at here before it is called done**; a test proves
the markup contains a string, not that the hierarchy reads.

For a remote workspace, export its D1 first — Wrangler holds those credentials,
this script does not:

```bash
pnpm --filter @rally/api exec wrangler d1 export DB --remote \
  --config wrangler.global.jsonc --output /tmp/global.sql
sqlite3 /tmp/global.sqlite < /tmp/global.sql
```

### Product measurement

Saving a schedule emits its actual durable enabled state, cadence class, bounded
day/time counts, delivery target types, and result. A delivery emits once when
settlement reaches a terminal state, with its opaque delivery ID, bounded
activity count, target types, and whether it is the member's first delivery.
Schedule times, timezones, email addresses, activity IDs/content, generated
digest text, thread title, and delivery-provider responses never enter
telemetry. The schedule/delivery tables remain authoritative; reporting failure
cannot change a saved schedule or settlement.

## Invariants

- **Every reader of the log keeps to the audience columns.** A breakout's
  emptied mention sits in the shared log with its author as its only audience;
  a reader that skips the audience columns (a new feed, an export, a count)
  shows it to the whole parent thread, which is the set the breakout is private
  from. Guard: `channels-threads-navigation.test.ts` "given a mention in a
  breakout, when the person named reads Activity, then it appears only once
  they may list the breakout".
- **A producer of a breakout's events stamps `metadata.substreamId`.** It is
  how WorkspaceDO tells a breakout's event from its thread's and narrows the
  audience to the author. An unstamped breakout event is stored under the
  thread's audience and leaks to every thread participant. Guard:
  `channels-threads-navigation.test.ts` "given a breakout's mention whose
  author is unknown, when it is applied, then it is not stored at all rather
  than shown to the parent thread".
- **Audience is resolved against the reader at read time**, by every reader
  of the log. Storing recipients instead freezes
  the audience at write time, so someone added to a work stream today would never
  see what happened in it yesterday.
- **After the DO authority switch, work-stream audience uses the versioned
  WorkspaceDO viewer directory**, not the frozen legacy participant table.
  System work streams are excluded through the matching common row. Before the
  switch, the legacy rows remain the authority for the same query.
- **Recording involvement never grants visibility.** A target row outside the
  audience is stored and still filtered out on read.
- **`event_sequence` is the only cursor axis.** Never cursor on `created_at`, which
  is display and retention only, and never on `occurred_at` — a connector poll
  inserts events whose provider timestamp is hours old. Timestamps tie within a
  millisecond and any tiebreak can place the second event below a cursor taken
  after the first, dropping it from every future read.
- **`digestible` is fixed on the row when it is written.** Nothing reads it
  today; a reader that does takes the choice as a required argument.
- **Anything reaching `workspace_activity_events` goes through the typed
  `recordActivityEvent` contract and sets `digestible` itself.** The strict
  object-local column has no default, so an undecided producer cannot fail open.
  Legacy D1 rows use their historical default only while being imported and are
  scrubbed before the WorkspaceDO route activates.
- **Which events matter is declared by the connector's manifest**, not here and not
  in the digest.
- **A retried occurrence sends the text its first attempt kept.** Reading
  Activity again would send different destinations different digests.
- **Sending a digest never marks anything read.** Unread is the person's state,
  and a digest only reports it.
- **A digest has no timezone of its own.** `users.timezone` answers when its
  wall-clock times are, and a second copy would disagree the first time somebody
  moved.
- **Destinations are resolved and frozen before anything is written on save**, so a
  destination that has gone away fails the request rather than leaving a schedule
  that fires into nowhere. The workspace alarm is refreshed *after* the write,
  because the scheduler reads WorkspaceDO.
- **A digest row is never deleted.** Switching one off keeps the row with
  `enabled = 0`, so absence unambiguously means "never had one" and the reconciler
  cannot resurrect it.

## Boundary

This document owns the WorkspaceDO activity log and the scheduled digest built
on the Activity tab it feeds. It does not own:

| For | Read |
| --- | --- |
| Which connector activity types are worth telling someone about | [`connectors.md`](connectors.md#declaring-what-a-digest-may-read), [`connector-digestibility.md`](connector-digestibility.md) |
| The WorkspaceDO connector-event authority, global route, Queue, and processing Workflow | [`connectors.md`](connectors.md) |
| How each kind of Activity row reaches a person as it happens | [`push-notifications.md`](push-notifications.md) |
| The scheduler and its alarm | [`architecture.md`](architecture.md) |
| The columns and their constraints | [`data-model.md`](data-model.md) |
| The other consumer of a connector's `userDelivery` surface | [`workstream-email-addresses.md`](workstream-email-addresses.md) |
| The `FLAGS` binding, the other three resolvers, and how each one fails | [`feature-flags.md`](feature-flags.md) |

A surface that wants "what happened, for this person" reads the Activity tab's
read (`listActivity`), as the digest does. A new reader of the log itself must
apply the audience columns the same way; see [Invariants](#invariants).

## Failure modes and limits

- **Events older than ninety days are reaped**, oldest-first, by the owning
  WorkspaceDO's one alarm in bounded batches. Reaping never disturbs a cursor —
  an expired `event_sequence` sits below every
  live one, so a window that has lost its rows reads as empty rather than as new. A
  surface that wants to read further back needs this number raised, not a second
  table.
- **`recordActivityEvent` never throws into its caller.** An event log that can fail
  a message post is worse than one that occasionally misses a row; use
  `recordActivityEventOrThrow` where the write genuinely has to land.
- **Nothing unread settles as `empty`** and sends nothing.
- **A digest lists the first Activity page only**, 250 rows, newest first. Older
  unread rows are in Activity and not in the digest.
- **A digest with more than two times keeps the first of each slot.** Older
  schedules could hold up to twelve; the first save from Settings keeps one
  before noon and one after.
- **A target type with no `CONNECTOR_DELIVERIES` entry is skipped rather than
  failing the occurrence** — it was saved by a region that has the connector and this one
  does not.
- **Each destination settles independently** and records its own
  `last_delivered_delivery_id`, so a retried occurrence re-sends only what has
  not landed. A destination's failure is recorded, not thrown. The delivery is
  marked `delivered` once every destination has settled and one landed, and one the provider permanently rejects moves to `needs_input` rather
  than failing silently forever.
- **A member with no account address is skipped by the reconciler**, because the
  default destination is that address.
- **The email is light only**, because a mail client cannot report the reader's
  chosen theme, so it renders in the app's light theme. It renders a Markdown subset: titles,
  sections, subheads, bullets one level deep, numbered lists, links, bold,
  emphasis, inline code, blockquote, and tables or fenced blocks kept verbatim in
  a `<pre>`. Other unknown syntax degrades to visible text rather than being
  passed through as HTML.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/activity-event-projection.test.ts` | Projection from `activities`, audience resolution, target rows, and the cursor. |
| `apps/api/test/digest-email-content.test.ts` | The digest shell: inline styles, counts, and the preheader. |
| `apps/api/test/email-markdown.test.ts` | The shared Markdown subset, escaping, refused link targets, the text part with and without link addresses, and the preview line. |
| `apps/api/test/digest-schedule.test.ts` | The day mask, one `schedules` row per time, timezone re-derivation, the reconciler's two passes, and the Personal Channel frozen as a destination and refused to a guest. |
| `apps/api/test-workers/daily-digest.test.ts` | On real workerd: an unread start listed as the sidebar words it, nothing unread settling as `empty`, a fired-again occurrence sending nothing twice, and a claimed but unsent occurrence sending the text it kept. |
| `apps/api/test/digest-delivery.test.ts` | Independent per-destination settlement, the skipped unknown target type, and `needs_input` on a permanent rejection. |

Run one with
`pnpm --filter @rally/api exec vitest run test/digest-schedule.test.ts` — the
path is package-relative.

**A test proves the markup contains a string, not that the hierarchy reads.** Every
visible change to the email template is looked at through
`scripts/preview-digest-email.mjs` before it is called done — see
[Looking at it](#looking-at-it), which also names the two rendering failures the
preview does *not* reproduce on its own.

## Device notification transport

Mention and seating intents are sent on the channels the person chose for
that kind: push, email, and any connector surface such as Slack. Nothing falls
back to another channel. Both the intent processor and push consumer use
`notificationDeliveryContext`, preserving existing audience and projection
semantics. [Push notifications](push-notifications.md) owns the channels,
device registration, provider delivery and retry receipts.

## Changelog

### 2026-11-05 — News in an Organization-wide Channel reaches its participants only

**What changed:** A thread start, an Organization-wide breakout start and a
thread's merge into an Organization-wide Channel are Activity rows only for
participants of the thread, or of that Channel when they had joined it before
the event (`activity-audience.ts`, `space_viewers.joined_at`, migration 134).
Every notification channel reads this feed, so push, email, Slack and the
digest narrow with it.

**Why:** The product owner asked that people not be notified about new
threads and posts in a public Channel they have not joined, and then that
nothing from before they joined a Channel become Activity. Before, every
member was told of every Organization-wide start and Channel merge, and a
new member's Activity filled with history.

**Considered and rejected:** Filtering in the push sweep alone: the Activity
tab, the digest and the menu bar would still list the rows, and the feed is
the one rule every surface reads. Narrowing listing itself: a member must
still be able to find and open a public thread.

**Considered and rejected for the join time:** Comparing with the thread's
placement time rather than its start: the row is the start and is dated by
it, and a Channel member would be told of an old thread moved in. Backfilling
existing participants to the migration's time: rows they already see would
vanish from Activity, which nobody asked for, so their join time stays NULL.

**Consequences:** A thread placed only in private Channels, or in none, is
unchanged. A start is dated by `source_created_at`, which the creating client
supplies, so a skewed clock can put a start just before or after a join. Any
new writer of `space_viewers` must stamp `joined_at` when a row turns
participant, or that person hears about the Channel's whole history. A test
that expects a member to hear about Channel news must seat them in the
Channel before the news.

### 2026-10-20 — Human replies join Activity and conversations collapse into one row

**What changed:** Human messages in conversations the reader participates in
produce reply activity without requiring an @mention. Latest replies are selected
before pagination, with counts from the message waterline. The sidebar and menu
fold events by conversation, retaining unread mentions and a human preview.
Digest rendering counts a message with both mention and reply rows once, under Mentions.

**Why:** An ongoing human exchange could disappear behind Rally completion
rows: neither ordinary replies nor conversation grouping existed in Activity.

**Considered and rejected:** Manufacturing mention edges for every reply would
confuse explicit mentions with subscriptions. New per-event read state would
duplicate the existing visible-message waterline.

**Consequences:** Reply activity uses current participation and listing gates; its read floor
includes the participant cursor as well as Activity reads. Reply alerts bypass
the foreground-thread presence shortcut and settle through visible-message reads. Private breakout text remains absent from the shared event log;
its reply row identifies the author and conversation without a text preview.


### 2026-10-16 — The email is light and says Rally, and old rows are counted, not repeated

The digest still said Avalon in its wordmark, button and footer, and was drawn
in a dark palette that matched neither of the app's current themes: a muted
volt, large radii, and a volt rule on every section. It now uses the app's light
theme tokens and its quieter look. Light was chosen over dark because a mail
client cannot report the reader's appearance and light is what most inboxes
show around the message. `light only` asks dark-mode clients not to repaint it;
Apple Mail honours that, while some apps (Gmail on a phone) may still adjust it.
A dark variant behind `prefers-color-scheme` was not attempted: a `<style>`
block is stripped by several clients, so it would only reach some readers. The
palette lives in `email-markdown.ts`, so any future email shares it. The
workspace name and the AI notice left the shell; the settings link stayed.
"Open Rally" used to open the bare site root; it now opens Activity through a
new `activity` deep link, since that is where the listed rows are. Desktop
builds older than that link drop it, so for them the button does nothing until
they update; the product accepted that gap rather than hold the API change.

A digest is still unread Activity, but a row past two days old is now one count
at the bottom instead of a line. Unread rows never expire, so every digest
repeated everything a person had not opened, twice a day. Marking rows read on
send was rejected: the digest would then change what Activity shows. Tracking
which rows each digest already listed was rejected as more state than the
problem needs, but the window always reaches back to the last delivered digest,
read from `digest_deliveries`, so a weekend or a weekly schedule never hides a
row that no digest has listed. The age is measured from the occurrence, not the
clock, so a retried occurrence splits the same way. Two days was the product's call; a
digest with only older rows sends nothing, so the count never arrives alone.

### 2026-10-16 — A merge is an Activity row

**What changed:** The Activity tab lists every merge somebody else made: a
breakout into a thread, and a thread into a Channel, as kind `merged`. The
daily digest has a Merges section.

**Why:** A merge is a result arriving where a person works, and the product
owner asked for it to reach the sidebar and push the way starts and finishes
do.

**Considered and rejected:** Reading a breakout's merge from the breakout's
directory row, as a start is. A breakout can merge many times and its row holds
none of them; the merge message's event is the one record of each.

**Consequences:** The breakout-merge arm reads the shared event log by a JSON
field, so it stays on a partial index; a future arm that reads metadata needs
its own. A breakout's merge names the breakout to everyone who may list the
thread, as the merge message itself does.

### 2026-10-16 — The `digests-enabled` flag is removed, and every digest starts the day at 07:45

**What changed:** The `digests-enabled` Flagship flag is gone from the API,
the client flag contract, Settings, Ace's catalog, and Flagship itself (Ace's
deploy now retires it). A digest fires on its own `enabled` bit alone, and
Settings → Notifications always draws the Daily digest group.

The default start-of-day time moves from 09:00 to 07:45, and WorkspaceDO
migration 108 moves everyone, not only new members: each stored digest's
morning time becomes 07:45 (an evening time is kept, no days becomes
weekdays), and each is marked so the reconciler adds the email and Personal
Channel destinations it lacks and switches it on. Most digests made before
2026-10-15 had email only. A stored 09:00 could not say whether someone chose
it, and Settings had been hidden since 2026-08-25, so nobody had a recent
choice to keep. The derived `schedules` rows are dropped by the migration and
rebuilt by the reconciler on the same visit, because their next instant needs
the owner's timezone, which the object cannot compute in SQL; a digest does not
fire between the object waking and the reconciler reaching that member. Empty
digests still never send.

**Why:** The flag was the kill switch for the agent-run digest that the
2026-10-15 rewrite replaced, and it no longer guarded anything worth a switch.
It also failed silently: its live default variation sat at `off`, so every
person's Daily digest settings were hidden and no digest sent, while nothing
in the product said why. A person who wants no digest switches both slots
off, which is the one off this feature now needs.

**Consequences:** If digests ever need an operator-wide stop again, add a new
flag for that purpose rather than reviving this key. Older desktop builds that
still read `digestsEnabled` get the schema default `true`, so they show the
section too.

### 2026-10-15 — The digest is unread Activity, at the start and end of the day

**What changed:** A digest no longer runs the agent. Each occurrence lists what
is still unread in the person's Activity, one section per kind, and sends it to
their email, their Personal Channel (as a new thread from Rally), or a
connector surface such as Slack. Settings shows it inside Notifications as
two slots, Start of day and End of day. The per-occurrence hidden work
stream, the brief, the run settlement and the window cursor are gone. New
members default to their email and their Personal Channel.

**Why:** People asked for one place that says what they have not looked at
yet, twice a day, and Activity already is that place. A summary written by a
model reported a different set of things from the sidebar, cost a run per
person per occurrence, and could not be checked against anything.

**Considered and rejected:** Keeping the model to write a summary of the unread
rows: the rows are already short and worded, and the summary was the part
people could not verify. A new table for the Personal Channel destination: its
row fits the existing shape with the Space where a connection would be, and
the CHECK needs no rebuild. Marking rows read once sent: the person has not
read them, and the sidebar would stop telling them.

**Consequences:** `summary_markdown` is now the text every destination of an
occurrence receives, written at claim. The cursor columns are written as zero.
Old digest work streams (`system_kind = 'digest'`) stay as they were, hidden
unless Debug is on.

**Connector activity is no longer digested, on purpose.** The old digest read
the log, where connector events live; Activity holds only mentions, additions,
starts and finished runs, so a GitHub review or a received email no longer
reaches anyone on a schedule. `listActivityEvents` and
`latestActivityEventCursor` had no other caller and are removed. The
`digestible` column and the manifests' declarations stay, read by nothing,
for the next surface that wants connector news on a schedule.

**A destination that fails no longer fails the occurrence.** Its failure is
recorded and the next occurrence rebuilds from Activity anyway; retrying held
the schedule row, and every later occurrence, behind a destination that was
down. Only an attempt that dies before settling is retried.

### 2026-10-13 — Activity rows are settled by what the person does

**What changed:** The app reports what the person read as events; WorkspaceDO
keeps one waterline per person and subject (migration 101), and an Activity
item is done once its kind's rule holds over those waterlines, as well as when
Mark all read covers it.

**Why:** The PRD says each item keeps its dot until the person opens it, and
the tab cleared dots only through Mark all read, so reading the mention you
were told about left it unread.

**Considered and rejected:** Deriving "done" from each conversation's own read
position (`channel_viewers`, `breakout_viewers`, `space_reads`): it tied
Activity to three projections with different rules (unseen, manual unread, a
guest's Channel). Moving the waterline inside the read-acknowledgement routes:
it covers other clients for free, but misses every read whose position was
already moved (by another client, or before this shipped), which is when a
mention most needs clearing. A per-item read table: it records the same fact
once per item and cannot clear a row not yet on a page. Comparing a finish
with the newest message: a later message made a cleared row unread again.

**Consequences:** Only the desktop reports reads; iOS and any other client
clear rows only through Mark all read until they send events too. An event
names any subject without a listing check: the waterline is the reader's
alone and the feed lists only what they may see.

Shipped in [#1225](https://github.com/juno-ai-labs/avalon/pull/1225). PRD: [Activity section](PRDs/2026-10-10_channels-threads-navigation/prd.md#activity-section).

### 2026-10-10 — The activity log feeds the Activity tab too

**What changed:** Conversation events carry `metadata.substreamId` and
`mentioned` targets, and `WorkspaceActivityFeed` reads the log for the new
Activity tab, with the listing rules applied inside each SQL arm so a page and
its cursor never carry a thread or breakout the viewer cannot list. A
breakout's mentions now enter the shared log, emptied and with the author as
the only audience; one with no author is skipped. Read state is one time per
person.

**Why:** The navigation redesign replaces the attention pop-out with an Activity
tab of things that happened to a person
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)). The log already
held most of it; a second log would be a second answer to the same question. A
mention in a breakout is one of those things, and the log had none, because
child activity stayed inside the parent. Filtering rows after the SQL read let
a page come back short, or empty with a cursor naming a row the viewer could
not see.

**Considered and rejected:** New `thread.started`, `breakout.started` and
`run.finished` events. Starts were first read from the opening message's
event; they are read from the directory row instead, because that event did
not reliably reach WorkspaceDO on the live stack. The directory rows and their
completion times already say each of those, so new producers would only
duplicate them. Storing a breakout mention under the parent thread's audience
when it has no author: that audience is the set of people the breakout is
private from. Forwarding the breakout mention with its body: the shared log
would then carry breakout text for any reader that slips.

**Consequences:** A digest is unchanged: it ignores the new metadata and reads
`mentioned` targets as involvement, as it always read `involved`. A run that
finishes twice shows once, at its latest finish. Any future reader of the log
must keep to the audience columns, and any producer of a breakout's events must
stamp `substreamId`, or a breakout mention reaches the whole parent thread. A
per-item read state can come later as a second table without moving the
one-time mark.

### 2026-09-14 — Share notification eligibility with Apple push

Push now consumes the same durable intents and eligibility function as Slack and
email. Successfully queued push keeps the payload until the existing intent
retention expires, because clearing it at producer settlement would strand an
asynchronous delivery. Slack remains independent; email is the fallback when
neither Slack nor push accepts the notification.


### 2026-09-09 — Seek directly to the activity cursor

**What changed:** Activity reads add a direct sequence lower bound when a cursor
exists. The RPC regression test covers zero, resumed, and empty cursors, mixed
filters, and the first digest's non-null time floor.

**Why:** The optional-cursor OR prevented SQLite from seeking past history.
Production inspection measured 108,665 reads versus 1 for an empty direct range.

**Considered and rejected:** Adding an index or migration: the primary key
already supports the range. Retained the explicit no-cursor branch instead of
substituting zero, preserving its unbounded semantics. Fixed SQL fragments and
their conditional binding must change together.

**Consequences:** Keep the supplied cursor as a direct range, guarded by workerd
rows-read assertions. This guarantee concerns the main-table resumed seek only:
the first digest's time-filtered, sequence-ordered path can still scan history,
and target aggregation can read targets outside the cursor window. Neither cost
is claimed fixed here. Audience and other filters retain their existing behavior.

Shipped in [#628](https://github.com/juno-ai-labs/avalon/pull/628).

### 2026-08-30 — A bare `<br/>` becomes a line break in email prose

**What changed:** `email-markdown.ts` rewrites a bare break tag to `<br>` in the
HTML part (after escaping, after parking code spans) and to a newline in the
plain-text part (outside code spans and preformatted pipe rows).

**Why:** The desktop renderer now honours the same tag, and these two surfaces
showing different bytes for the same briefing is the drift this module already
paid for once. Tables stay preformatted here, so a break tag inside a pipe row
is still characters — this renderer has no table model.

**Considered and rejected:** Flattening email tables into real HTML tables just
to honour the tag. That is a second table renderer, not a break-tag fix.

### 2026-08-30 — Sidebar facepile is the existing AvatarStack, not a compact variant

**What changed:** Digest (and every other personal) sidebar rows use `AvatarStack`
at its existing 24px size. The compact size that had been added for the trailing
slot is gone.

**Why:** a second visual was a parallel facepile, not reuse of the one the header
and participant chips already paint. The Air row is 31px; 24px faces already fit.

**Considered and rejected:** CSS-shrinking the stack only in the sidebar. That
would still be a second look. `extraCount` stays because the directory list is
already truncated to three ids; inventing dummy members so the native overflow
could fire would pollute the accessible name.

**What a future change has to respect:** `AvatarStack` itself is the sidebar
facepile. Do not add a size for this slot.

### 2026-08-29 — Digest settlement receives only saved canonical result text

**What changed:** Digest terminal settlement now receives the same normalized
text rendered from a reloaded canonical turn as other external destinations. A
run with no saved result, or only whitespace, passes `null`; the digest
settlement authority marks that occurrence failed and does not advance its
cursor or synthesize a replacement summary.

**Why:** External delivery previously manufactured a generic completion or
failure sentence when a run had no result text. That made a host-authored
sentence look like the digest the model was required to save and could consume
the window without delivering its contents.

**Considered and rejected:** Keeping a digest-only fallback because email is not
a chat stream. The authority problem is the same for every destination: content
that is absent from the canonical transcript cannot become the external result.

**What a future change has to respect:** Digest delivery may format saved text,
but it must not replace missing saved content with status prose. A missing result
fails the occurrence so its events remain eligible for the next digest.

### 2026-08-29 — The digest tables answer to typed WorkspaceDO methods, not routed SQL

**What changed:** Every digest statement the services sent through the
workspace runtime facade — the settings read and wholesale save, the
reconciler's on-by-default insert and derived-row repair, the timezone rebuild,
the occurrence claim and its lifecycle transitions, settlement, and the
per-destination delivery records — is now a typed method on `WorkspaceDO`
(`workspace-digests-protocol.ts` for the contracts,
`workspace-digests-storage.ts` for the SQL). Three read-then-write sequences
became single object transactions with returned witnesses: the first save
decides create-versus-update inside the write, the reconciler's default answers
`created` from the branch it took rather than from a physical write counter,
and settlement is a compare-and-set whose loser is told `already_settled`. One
routed statement deliberately remains: the settings read that joins
`digest_delivery_targets` to `connector_connections` for display names, which
is the connectors domain's conversion to make. The digest names stay on
`WORKSPACE_LOCAL_TABLES` so an accidental generic statement still routes to the
object rather than failing as D1's `no such table`.

**Why:** the facade classifies each statement by the table names in it, and a
WorkspaceDO table missing from its list is silently answered by regional D1 —
the routing defect that took automation run work streams down in production
(PR #401). A typed method cannot be routed to the wrong database, because its
tables are named inside the object that has them. The round trips were also
live races, not just latency: two concurrent first saves both read "no digest
yet" and `UNIQUE (workspace_id, user_id)` 500ed the loser, and two settlement
attempts of one retried workflow step could both read `running`, both settle,
and both emit the terminal telemetry and append the delivery note.

**Considered and rejected:** converting the delivery-targets display-name join
by splitting it into two typed reads. Both tables live in this object, so the
split is possible — but `connector_connections` belongs to the connectors
domain, whose conversion lands separately in this stack, and carving one of its
reads out here would leave that domain's boundary drawn in two places. Also
rejected: moving the RRULE derivation into the object with the write it feeds.
The recurrence policy is the service's; the object writes exactly the derived
rows it is handed, so *when* a digest fires never becomes a storage question.

**Consequences:** digest state in a Node test now lives in the object database
`createTestWorkspaceDO` stands up, not in the regional fixture — a test that
seeds or asserts digest rows must use the object store, and the suites in
`apps/api/test/digest-*.test.ts` are the worked examples. Settlement side
effects (terminal telemetry, the transcript delivery note) belong to the
attempt whose settle returned `settled`; a new settlement branch must check
that witness rather than assume it won. The methods that rewrite derived
`schedules` rows re-arm the workspace alarm themselves, mirroring the generic
SQL path's backstop, so a future caller that forgets `refreshWorkspaceSchedule`
degrades to a late alarm rather than a dark one.

Shipped in the facade-to-RPC stack (PR 6 of 9), on top of
[#401](https://github.com/juno-ai-labs/avalon/pull/401)'s routing repair.

### 2026-08-28 — Both email passes read one shared answer for where a fence ends

**What changed:** `email-markdown.ts` no longer tracks fenced blocks itself.
`blocksFromMarkdown` — which keeps a fenced block whole in a `<pre>` rather than
flattening it into a paragraph — and `markdownToEmailText` — which drops the
delimiters and indents the body four columns — both read `markdownLineKinds`
from `@rally/contracts/markdown-code`. No output changed for any input the
suite covers.

**Why:** the two passes here were two of five copies of the same question, and
they did not agree with each other, let alone with the citation reduction and
the TeX repair that run immediately before them on the same string.
`markdownToEmailText`'s copy was the loosest of the lot — a bare toggle, so any
fence line flipped the state regardless of its character or length — and
`blocksFromMarkdown` recorded only the first three characters of an opener, so a
```` ``` ```` line closed a ```` ````` ````-opened block.
[`markdown-code.md`](markdown-code.md) records the extraction and why the shared
rule is the citation copy's.

Measured against a vendored copy of the old renderer over 5,832 documents, 2,109
differ and every one is a fence-rule convergence: a closer must now repeat the
opener's character and reach its length, and a delimiter indented four or more
columns, or by a tab, is an indented block rather than a fence. The first two
leave a block whole where the old rules ended it early — `blocksFromMarkdown`
used to accept a closer whose leading whitespace it had trimmed away. None of
them is an input any test pinned.

Both passes read the *fence* kinds only, not the classifier's indented-code
answer. This is a renderer rather than a rewriter: an indented chunk is not a
block boundary in its model, and the rules below it already give one a
paragraph. Reading the extra kind would change what an indented block renders
as, which is a separate decision from where a fence ends.

**Consequences:** the citation reduction, the TeX repair and this renderer can
no longer disagree about which lines of the same email are code, which was the
failure worth removing — all three run over one string in sequence, and a
disagreement between them shows up as a rewritten code sample in somebody's
inbox with nothing failing anywhere.

### 2026-08-28 — The reduction is written for the surface that renders it

**What changed:** `rewriteCitationsAsPlainText` takes a `sources` option:
`markdown` (the default, for the HTML and text paths here, which render Markdown
and reduce its marks), `plain`, and `none`. `markdownToEmailPreheader` uses
`none`, and so does `mention-email-service.messageExcerpt`.

**Why:** The reduction emits Markdown — a `**Sources**` heading and
`[label](url)` for an external source — and two of the surfaces it was given
render none. A mention excerpt is HTML-escaped into a table cell and quoted into
the plain-text body, so the list arrived as literal syntax; it is also a single
line, and `singleLine` flattened a bibliography into the quote, where it
competed with the length budget and truncated mid-entry. The preheader is the
160 characters an inbox shows beside the subject, and appending the source list
before truncating spent them on `Sources 1. Q3 deck` for any answer short enough
to reach it. Both call sites want the reduction and neither wants the list.

**What a future change has to respect:** A new caller picks the shape its
consumer can render, the way `normalizeModelMarkdown` and `normalizeModelText`
are already two entry points for the same reason. The default is the Markdown
one, so a caller that renders nothing has to say so.

### 2026-08-27 — Every email reduces a model's citations before rendering

**What changed:** All three `email-markdown.ts` entry points run
`rewriteCitationsAsPlainText` ahead of their existing work — before
`normalizeModelMarkdown` on the two that call it. Chips and embeds reduce to
their label text; footnotes reduce to numbered markers over one trailing source
list.

**Why:** Model answers began carrying `resource://` targets and GFM footnotes,
and this renderer had no rule for any of it — the HTML path links only
`http(s)`, so an internal link passed through as literal bracket syntax; the
text path appends any target it is given; footnotes were unhandled in both. A
reader would have got a raw internal URL and a page of `[^1]` markers above
nothing. The rejected alternative was teaching this renderer to render
citations: there is nothing for a mail client to render them *as*, and a
trailing source list is the one place a source can live on a surface with no
rail to open.

**Consequences:** The ordering is a constraint, not an accident — widening what
`normalizeModelMarkdown` escapes breaks citation rewriting in email, several
modules from the cause. The reduction is idempotent, so a path that grows a
second call does not double-renumber. Shipped in
[#381](https://github.com/juno-ai-labs/avalon/pull/381). Design:
[`docs/PRDs/2026-08-27_inline-resource-citations/prd.md`](PRDs/2026-08-27_inline-resource-citations/prd.md).

### 2026-08-25 — The Digest settings section hides when digests-enabled is off

**What changed:** `ClientFeatureFlagsSchema` gained `digestsEnabled`, resolved
in `client-feature-flags.ts` through the same `resolveDigestsEnabled` the
entry below already added. Electron's Settings screen drops the Digest nav
item and section entirely — not a disabled state, an absent one — for
whoever it resolves `false` for.

**Why:** The entry below deliberately kept this flag off the client, on the
grounds that nothing needed a value pushed to a connected socket. That left a
real gap: a person whose digest was turned off from outside their control
would open Settings and see it reported as configured and on, with nothing
telling them why nothing was arriving. Hiding the section is the honest
answer to "is this available to me right now," which showing it — disabled
or not — is not.

**Considered and rejected:** Showing the section with a "paused" notice
instead of hiding it. Reasonable on its own, but not what was decided here;
recorded as the alternative in case the hidden version turns out to need
revisiting once this has real usage behind it.

**Consequences:** The Ace-save Queue fan-out this flag already triggered —
previously a harmless no-op, since nothing read the result — now has a real
client effect: a save through Ace propagates to a person's Settings screen
the same way an `automation-workspace-templates-enabled` change already does.
`reconcileDigestDefaults` and `digest_schedules` are untouched by this — the
row a person configured is exactly what it was — but their digest has in
fact stopped arriving, the same `flag_disabled` skip the scheduler already
returns for them. The section is withdrawn because this screen has no copy
for a paused state, not because nothing changed.

### 2026-08-25 — Scheduled digests get an operational kill switch

**What changed:** `digest-flags.ts` adds `digests-enabled`, a Flagship boolean
checked at the top of `fireDigestSchedule` — right after the schedule's own
`enabled` bit and before the occurrence is claimed. It fails open: no binding,
a throw, an unresolved flag, and a non-boolean value all resolve to enabled,
and only an explicit `false` variation actually served by Flagship stops
delivery. It is managed through Ace, alongside the four existing product
Booleans, but is provisioned **on** rather than off — the one call to
`ensureFlag` in `apps/ace/scripts/deploy.mjs` that passes an explicit default.

**Why:** Every kill switch already in the codebase — the four Ace-managed
product Booleans — defaults off and is presentation-only: Electron hides a
surface while the API keeps serving it underneath. Digests are the opposite
case: on by default for every existing person, fired from a cron reconciler
nobody visits a settings screen to trigger. Copying the product-flag pattern
verbatim, default and all, would have silently stopped every digest the
moment the flag was first provisioned. What was wanted was a real stop: an
operator able to turn digest delivery off, from the same editor they already
use for every other flag, without touching anyone's saved schedule,
destinations, or cursor.

**Considered and rejected:** A CLI-only path outside Ace, parallel to the
agent-model flags — the more surgical choice, since nothing here needs a value
pushed to a connected desktop socket the way Ace's fan-out exists to do. It
was rejected for the same reason the presentation flags are not split across
two editors: a second, undiscoverable way to change a Boolean flag is worse
than one editor doing slightly more than its fan-out strictly needs. Also
rejected: gating `reconcileDigestDefaults` instead of the fire path, which
would conflate "does this person have a digest configured" — a product
default, adjustable per person — with "are digests currently allowed to
send" — an operational switch — and would leave a flipped-off flag fighting
the reconciler's own idempotent repair on every cron tick.

**Consequences:** `digest-flags.ts` is the fourth module reading `env.FLAGS`
directly, alongside the three [`feature-flags.md`](feature-flags.md) already
named, and is the only one of the four not consulted through
`client-feature-flags.ts` — it is Ace-managed but not client-visible, so a
save still enqueues Ace's ordinary Queue fan-out even though no connected
client reads this key. That is harmless rather than free: the fan-out always
re-evaluates and re-sends the complete client contract regardless of which
key changed, so this simply repeats work already safe to repeat. A flag skip
is indistinguishable from a quiet schedule from the delivery table alone, the
same ambiguity an `empty` settlement already carries; unlike an `empty`
settlement, though, a flag skip claims nothing, so the cursor does not move
and the missed window is fully recovered the moment the flag serves `true`
again.

### 2026-08-23 — Every email repairs a model's TeX, and consumes the escapes that repair writes

**What changed:** `email-markdown.ts` normalizes on all three of its outputs —
`markdownToEmailHtml` through `normalizeModelMarkdown`, the plain-text
alternative and the preheader through `normalizeModelText` — so `$\rightarrow$`
reaches an inbox as `→` in the digest and in an automation's result alike. The
inline pass parks Markdown escapes behind the same placeholder the code spans
use, before the link pass runs, and restores them as their characters at the
end.

**Why:** the branch that built the TeX repair originally carried its own
enriched digest renderer — tables, task marks, per-width nesting — and that
work was superseded mid-flight when the shared renderer landed and the digest
moved onto it; the enrichment was dropped with its tests rather than fought
over, since the shared renderer's leaner scope is a recorded decision. What
could not be dropped is the repair itself, and its contract: the normalizer
escapes what it unwraps on the promise that the parser downstream eats the
backslash. This renderer is that parser, so without the escape pass a repaired
`$\text{a\_b}$` reached readers as `a\_b` — the artifact class the repair
exists to remove. The escapes are parked *before* the link pass, not unescaped
after it, because `\[a\](https://…)` read through its escapes is a link with a
target its label promised was plain text; and a backslash inside backticks — a
regex's `\.` — is stepped over, because there it is code. Both directions are
pinned by tests that fail without the pass.

**Consequences:** a future email that carries a *person's* words verbatim needs
an opt-out at the entry points first, the way `MarkdownBody` grew one — every
body rendered today is a model's. The plain-text alternative deliberately uses
the entry point that manufactures no escapes; swapping the two entry points is
the failure the normalizer's module document names as its first invariant.

Shipped in #257.

### 2026-08-22 — Being added to a work stream is an event, and a notification

**What changed:** `addParticipant` writes a `workstream_participant_added`
activity event, audience `workstream`, `digestible = 1`, with the person added
as an `added` target. It also emits a `participant_notification` regional
effect, which becomes a `workstream_notification_intents` row under
`notification_kind = 'participant_added'` and reaches the person as a Slack DM,
or as email when no Slack account resolves. `WorkstreamObjectProduct` is now the
log's second first-party producer.

**Why:** this log exists so that "what happened for this person" is one query
rather than a fan-out, and being added to a work stream was missing from it
entirely — so the daily digest could not mention it, and neither could anything
else. The gap showed up as a support report: a colleague added to a work stream
heard about it from nobody. Adding the event without the notification would have
left the person waiting up to a day to find out; adding the notification without
the event would have left the digest still unable to say it.

**Considered and rejected:** `digestible = 0`, on the grounds that a person
already got a DM about it. The two answer different questions — the intent is
whether one person is told now, `digestible` is whether the event is worth
recalling in a summary of the day — and somebody who was added while away
should still see it in the digest that covers that day. Also rejected: an event
per participation change, including removals. Being removed is not something
Rally should announce to the person it happened to, and nobody asked for the
audit trail.

### 2026-08-22 — The Markdown renderer moves out of the digest

**What changed:** The Markdown-to-email-HTML renderer and the shared palette now
live in `email-markdown.ts`. `digest-email-content.ts` keeps the digest's own
shell and calls it. The renderer also gained one level of list nesting and
`*asterisk*` emphasis, both of which it previously passed through as
punctuation.

**Why:** The automation result email needed the same rendering — it was escaping
Markdown into HTML and mailing `##` and `**` to readers — and a second copy of a
security-sensitive renderer is a second place for an escaping rule to be missed.

**Considered and rejected:** Importing `digestMarkdownToHtml` from the digest
module. It works, and it makes every later reader of the automation email believe
the digest owns rules that are common to both.

**Consequences:** The renderer is shared, so a change to it changes the
automation result email too, and both emails' tests have to be read before one
is edited. The digest's own From address moved with it: with
`RESEND_NOTIFICATION_FROM_EMAIL` now configured, a digest arrives from
`notifications@with-avalon.com` rather than the invitations address it had been
falling back to.

### 2026-08-18 — Slack-only members still receive schedule repair

**What changed:** Digest reconciliation pages across every active member rather
than excluding blank email addresses in the regional query. A member without an
email still does not receive a newly invented email target, but an existing
Slack-backed digest has its missing or timezone-stale scheduler rows repaired.

**Why:** Email availability is a delivery-target concern, not a prerequisite
for maintaining an existing digest. Applying it to the outer member scan made
a Slack-only member's enabled digest silently stop after partial creation or a
timezone change.

**Considered and rejected:** Synthesizing an email destination or skipping the
member entirely. The former is invalid product state; the latter also skips
delivery-independent schedule repair.

**Consequences:** The keyset sweep covers more members, still in bounded pages.
New defaults remain email-backed only when a real nonblank address exists.

### 2026-08-18 — Digest scheduling and delivery move beside the activity log

**What changed:** Digest schedules/times/targets/deliveries, their canonical
`schedules` rows, and external-delivery attempts now live in WorkspaceDO with
the activity cursor they consume. WorkspaceScheduler reads those rows through
typed RPC; the sender rechecks D1 identity but settles attempts in WorkspaceDO.

**Why:** A digest and all of its state belong to one workspace. Keeping timing
and delivery state in D1 split each occurrence across two authorities.

**Considered and rejected:** D1 schedule/delivery projections and copying the
activity cursor into D1. Either makes the control plane authoritative again.

**Consequences:** Save-before-arm and idempotent occurrence semantics are
unchanged, but their transaction boundary is local to WorkspaceDO. An object
outage fails closed rather than reading or writing legacy D1 rows.

### 2026-08-18 — The first-party activity log moves into WorkspaceDO, and digest projection starts from a WorkspaceDO-owned connector event

**What changed:** `workspace_activity_events` and target edges now live in the
owning WorkspaceDO. The same object resolves work-stream audience against its
directory, maintains the monotonic cursor, and reaps retention by alarm. The
maintenance importer preserves existing D1 cursor values before writer fences
make the source immutable.

Connector ingest authority is also the owning WorkspaceDO, and the
connector-event Workflow performs the projection into that insertion-ordered
first-party activity log. D1 `activities` is documented as a 24-hour handoff,
not provider history.

**Why:** Every event belongs to one workspace, and its only non-membership
visibility join is already WorkspaceDO-owned. Keeping the log in D1 made digest
serving depend on two product authorities and retained a regional serving table
solely for a join the object could execute locally. On the ingest side, the
normalized provider event belongs to one workspace, while the derived log has
separate audience/cursor semantics; conflating either with a long-lived regional
staging row preserved an unnecessary second authority.

**Considered and rejected:** For the log: copying directory visibility back into
D1, fanning out one event per recipient, and keeping a D1 read projection. Those
alternatives either restore split authority or freeze a mutable audience at
write time. For projection: reading raw provider deliveries during a digest and
keeping D1 activity bodies indefinitely for convenience. The former cannot
reproduce normalized visibility; the latter defeats WorkspaceDO ownership.

**Consequences:** D1 still owns schedules, delivery destinations, active
membership, and notification transport state. Digest windows and user-facing
activity reads are WorkspaceDO RPCs; a WorkspaceDO outage fails closed and never
falls back to frozen D1 rows. Digest projection retries from the durable
Workflow claim. The activity log remains a derived first-party product and never
becomes the source for reconstructing the normalized provider event.

### 2026-08-17 — WorkstreamDO events enter the regional activity log durably

**What changed:** Authoritative work-stream mutations emit first-party activity
events through their local outbox and the regional Queue/D1 inbox. Audience
resolution switches to common/user directory projections after cutover.

**Why:** Digests still require one regional insertion-ordered log, while message
and participant authority no longer lives in D1.

**Considered and rejected:** Reading every WorkstreamDO during a digest or
continuing to resolve post-cutover audience from frozen legacy rows.

**Consequences:** Activity delivery is eventually consistent and idempotent;
membership remains evaluated at read time from the current regional projection.

### 2026-08-13 — Digest telemetry cannot interrupt required settlement

**What changed:** Every terminal digest telemetry call now isolates its entire
context lookup and emission. A telemetry query failure after delivery cannot
skip the occurrence transcript's delivered note.

**Why:** The provider delivery and status update are authoritative product work.
Only the final emitter had been caught, leaving its preceding context queries
able to throw after the digest was already marked delivered.

**Considered and rejected:** Retrying the settlement step. Its terminal-status
guard correctly prevents duplicate email, but would also return before writing
the omitted transcript note.

**Consequences:** Digest telemetry remains best effort around the whole helper;
required settlement work must never be placed after an uncaught analytics read.

### 2026-08-12 — The schedule's work-stream pointer is dropped, now that the window it was waiting on has closed

**What changed:** `0070_drop_digest_schedule_workstream.sql` drops
`digest_schedules.system_workstream_id`. Nothing else — no code, no other
schema, and none of the work streams it named.

Leaving it indefinitely was the alternative and is worse than it looks. A column
the code no longer maintains still reads as *the current work stream* to whoever
finds it next, and it points at work streams that were real when they were
written and are now just the ones a person's earliest digests happened to run in.
`digest_deliveries.workstream_id` is the answer to "where did this run", and two
answers to one question is the thing this document keeps arguing against.

**Considered and rejected:** Deleting the work streams the column pointed at
along with it, on the reasoning that nothing links to them any more. They are
real transcripts their owners can open, and the same argument that keeps
per-occurrence work streams unreaped keeps these: a pointer being dropped is not
a reason to delete somebody's history. They are reachable by URL and, with Debug
enabled, in the sidebar.

**Consequences:** SQLite refuses `DROP COLUMN` for a column that is indexed or
named in a CHECK, a UNIQUE constraint, or a partial-index predicate; this one was
none of those, so the drop is the whole migration and no table rebuild was
needed. That matters for the next person who tries to drop something here —
`activity_events.digestible` would not go the same way, for the reasons in the
entry two below. The migration test now applies `0068` and `0069` in sequence
against the same fixture, so the pair is exercised as the phased change it is
rather than as two unrelated statements.

### 2026-08-12 — A digest run has nowhere to put its summary except the message it ends with

**What changed:** `renderDigestBrief` now opens by telling the run that its final
message *is* the digest and is mailed verbatim — that no summary of it, report
about it, or closing sentence may take its place — and `settleDigestRun` refuses
to settle on a final message too short to be one. The `create_artifact` tool a
digest run could reach — every digest executes the ordinary work-stream loop, so
it loaded `rally_workstream` like any other run — no longer exists. See
[`agent-harness.md`](agent-harness.md#changelog).

**Why:** A run wrote its digest into an artifact and ended with "Outcome: Digest
artifact created (id …)". `deliverResultsDurably` passes `message.textContent` to
`settleDigestRun`, so that sentence became `summary_markdown` and was mailed as
the digest. Nothing failed: the text was non-empty and the run completed, so the
delivery settled as `delivered` and `cursor_through` advanced past events the
recipient was never actually told about. That is the specific failure the "a run
that could not write a digest sends nothing" branch exists to prevent, and it
could not catch this one — from the settlement layer's position a one-line
receipt and a real digest are both just text.

**Considered and rejected:** Reading the artifact when the final message looks
like a receipt. It puts a heuristic between a run and what gets mailed, and every
delivery surface would need its own copy of it.

**Bounded rather than trusted.** The prompt alone would have left the expensive
half of this open — a run can still end on a sign-off, and settlement cannot tell
one from a digest — so `settleDigestRun` now refuses to settle on a final message
shorter than `MINIMUM_DIGEST_CHARACTERS`. That is deliberately a floor on
*implausibility*, not the "does this look like a digest" test rejected above: a
run only reaches settlement when its window held an event, and the brief mandates
an opening sentence, `## ` sections and `- ` bullets, so a real digest clears it
by an order of magnitude. The asymmetry is the argument — rejecting a real digest
costs one delayed occurrence and the events return in the next one, because a
failed delivery does not move the cursor, while accepting a receipt costs the
window permanently.

**Consequences:** Three things now stand between a run and a consumed window,
and they are not interchangeable. Removing the tool closed the destination this
run happened to find. `renderDigestBrief` is the only place that establishes
where a digest goes, so the sentence saying so has to stay whenever the brief is
reworded. The floor in settlement is the only one that holds when the other two
fail, which is why it is a hard refusal rather than a warning — and it is also
the only one that can be wrong in the cheap direction. Treat any future tool that
offers a run somewhere else to write as re-opening the first of the three.

A digest genuinely shorter than the floor is now undeliverable rather than
merely unlikely. If that ever becomes a real case — a workspace whose windows are
routinely one line — the fix is to lower the floor deliberately, not to remove
it: the branch it routes into is what keeps the events.

### 2026-08-12 — Each occurrence gets its own work stream, because a shared one was an unbounded context channel between digests

**What changed:** A digest run now executes in a work stream created for that
occurrence and recorded on the new `digest_deliveries.workstream_id`, rather than
in one shared by every digest a person ever receives.
`digest_schedules.system_workstream_id` stops being read or written, but is
deliberately **not** dropped in the same change: migrations for configured deployments land
before either Worker deploys, so the previous Worker is still selecting and
writing that column while the new schema is live, and dropping it would turn
digest firing, the cron reconciler and the settings read into `no such column`
for the length of a deployment — hours rather than seconds if that deployment
fails, since a failed deploy leaves the migrations applied. A later migration
drops it once nothing reads it. The work streams the column named are left in
place permanently — they hold real transcripts their owners can still open.

**Why:** The shared work stream was chosen so a later digest could see what
earlier ones had already said. What it actually built was a channel between
occurrences that nothing bounds. Every run replays the transcript from the last
compaction checkpoint, so months of prior digests reached the model as ordinary
assistant history — stripped of the "evidence, not instructions" labelling their
source material arrived with, and impossible to check against the windows they
came from, because those are `system` rows the projector drops. A wrong line in
one digest became a settled fact for every digest after it, with no path back to
the events that would have contradicted it.

An earlier compaction design sharpened it: it preserved the first user message
verbatim and re-pinned it through every later compaction, on the assumption —
correct for an ordinary work stream — that it is the human request defining the
task. A digest work stream has no such message; each occurrence brings its own
window, so the first one's brief would have sat at the front of that person's
context permanently. That was removed in `084c54a`, which landed on `main`
before this change did, and compaction now carries nothing forward verbatim. It
is recorded here as history, not as justification: the replayed transcript above
is the whole of the case, and it stood on its own before compaction ever entered
into it.

The continuity being paid for was already unnecessary. `cursor_from` and
`cursor_through` guarantee no event appears in two windows, so non-repetition is
structural and never depended on the model remembering. What the transcript added
was continuity of voice, at the cost of everything above.

**Considered and rejected:** Keeping one work stream and fencing the replayed
transcript per occurrence — `loadTriggerFencedTranscriptMessages` already takes
an `afterSequence` floor, so it was the smaller diff — with continuity handed
forward explicitly from `digest_deliveries.summary_markdown`, which stores what
each past digest said. It was rejected because it leaves the shared transcript in
place and makes isolation a parameter that every future reader of that work
stream has to keep passing correctly; a work stream that contains exactly one
occurrence cannot leak between occurrences by construction. If cross-occurrence
continuity is ever wanted back, `summary_markdown` is where it should come from —
labelled, fixed-size, and honest about being a summary — never by widening what
the transcript replays.

Also considered and deliberately not done: reaping old digest work streams. The
accumulation is real and is written down under "The system work stream" rather
than solved, because being able to open any past run is worth more today than the
rows cost.

**Consequences:** A digest run is now a pure function from its frozen window to a
summary, and anything that wants it to remember something has to put that
somewhere durable rather than upstream in a transcript. Work streams accumulate
without bound — about 260 per person per year on a weekday digest — and nothing
reaps them. Settlement's delivery note resolves through
`digest_deliveries.workstream_id` instead of joining back through `harness_runs`,
so it lands even when the launch never recorded a run id; it no longer feeds the
next run, and exists for whoever opens the transcript looking for why an email
never arrived. A failed launch now releases its work stream along with its claim,
and decides that on the returned run id rather than the row's status, because
deleting a work stream out from under a live run is worse than leaking an empty
one.

Two things this change had to buy that the split itself did not imply. The
sidebar had to page — it asked for one screenful and dropped the cursor, which
was survivable only while nothing but people made work streams; that is
[`workstream-pinning.md`](workstream-pinning.md)'s entry of the same date. An
attempt to solve the same crowding inside `list`, by lifting machinery out of the
recency order and capping it, was written and then reverted: it added a second
population to one method, with its own bound and its own ordering, to answer a
reachability question paging had already answered.

And the cleanup of a released claim had to get *stricter*, then more precise.
`launchWorkstreamHarness` creates the Cloudflare Workflow instance before it
records the instance id, and marks its own run row `failed` on the way out of
either failure — so neither the run row's existence nor its status distinguishes
"nothing started" from "started, and only the record of it failed". The launch
marks the error instead, and both the claim release and the work-stream delete
read that mark. Guarding on the row, which was the first attempt, orphaned a work
stream on every ordinary launch outage.

The titles were shortened after looking at them: the first version reused the
email's `occurrenceLabel` behind the recipient's name, and in a real sidebar the
row ellipsized at the weekday, so two occurrences on the same day rendered as the
same row. A component test asserting the title string would have passed on every
version of this.

### 2026-08-11 — The digestible default stays permissive, and the deployment window that exposed it is written down instead

**What changed:** Nothing in the code or the schema. `activity_events.digestible`
keeps `DEFAULT 1`. What changed is that the reason is now recorded here, in
[`data-model.md`](data-model.md), and — as an operational rule rather than a fact
about this column — in [the runbook](runbook.md#the-window-between-a-migration-and-the-worker-that-needs-it).

**Why:** Deploying the entry below produced six wrong rows. The deploy job
applies migrations before it deploys the Workers, so between `0063` landing at
`18:56:00` and the Global Worker going live at `18:56:23`, the *previous* Worker
inserted six `activity_events` rows without naming `digestible`. They took the
column default of `1` and are marked digestible although every one of
them is operational under the manifests that shipped in the same commit. As
stored in `activity_events.event_type`, which is the form that will match a row:

```sql
SELECT * FROM activity_events
 WHERE digestible = 1 AND event_type IN (
   'connector.github.github.check_run.completed',      -- 2 rows
   'connector.github.github.pull_request.edited',      -- 1 row
   'connector.google.email.updated',                   -- 2 rows
   'connector.google.sheets.spreadsheet_changed'       -- 1 row
 );
```

The doubled `github.` is not a typo, and it is the one place the two namespaces
meet: `projectActivityEvent` writes `connector.<provider>.<manifest event
type>`, and GitHub's manifest ids already carry a `github.` prefix while
Google's do not. A manifest id alone matches no row. The default was chosen to leave pre-existing rows alone.
For connector rows the migration's own backfill then overrode it — but not for
first-party ones: `0063`'s `UPDATE` is `WHERE source_kind = 'activity'`, and
work-stream messages and mentions keep `DEFAULT 1` deliberately, because Rally
has always known those are worth telling somebody about. So the default was the
real answer for a whole class of existing rows, and picking `0` instead would
have cost a second backfill (`WHERE source_kind <> 'activity'`) rather than
nothing. What nobody asked was what the *old code* would write through it, and
for twenty-three seconds that was the only thing the default governed.

**Consequences:** The default is now load-bearing documentation rather than a
safety net: anything that inserts into `activity_events` outside
`recordActivityEvent` must set `digestible` itself, because the column will not
withhold on its behalf. The six rows were left in place — they are six lines of
noise in one digest window and they age out — so a reader comparing the log
against the manifests will find that many disagreements and should not treat it
as drift. The general rule this produced now lives in the runbook, where the
next person adding a `NOT NULL` column to a hot table will meet it before they
pick a default rather than twenty seconds after.

Shipped in #104.

### 2026-08-11 — A digest run is handed its window, and only hears about what a connector confirmed is worth hearing

**What changed:** Two things, because the same digest exposed both. A scheduled
run now receives its frozen window as a labelled user-role trigger message
rendered by `renderScheduledDigestBriefMessage`, instead of relying on the
transcript row the brief is written to. And the window itself is filtered:
`activity_events.digestible` carries a per-event answer, `listActivityEventsForUser`
takes a required `digestibleOnly`, and a digest passes `true`.

**Why:** A production digest arrived reading "No changes since last digest; no
prior baseline or connected activity found", beside a pill counting 200 updates.
The recorded inference for every turn of that run held exactly one message — the
system prompt. The brief is written to `messages` as a `system` row, and the
protocol projector drops system rows as UI state, so the window never reached the
model; asked to summarize something it could not see, it searched memory and
durable tables, found nothing, and reported that nothing had happened. The count
in the email came from `event_count`, which never passes through the model, so
the two halves of the same email disagreed.

The window was also the wrong 200 events. It covered seventeen minutes of one
morning and was 84% GitHub check runs and workflow transitions, because the log
could not tell a connector's machinery from its news. Against the workspace that
produced the empty digest, per-event digestibility withholds 1,610 of 1,937
events, which is the difference between a digest that covers a day and one that
covers a quarter of an hour.

**Considered and rejected:** Making the projector carry `system` rows, which
would have delivered the brief with a one-line change. It would also replay
unlabelled connector text as ordinary history on every later turn of every run
that has a system row, which is what the projector exists to prevent. Also
rejected: filtering the noisy GitHub event types at projection time inside the
digest. That puts a list of one provider's event names inside the digest, where
nobody adding a connector would ever find it — the connector manifest is where
somebody is already deciding what an event means.

**Consequences:** A digest run now fails its attempt when it cannot find its
brief, rather than running blind; the unsettled delivery folds its window into
the next occurrence. The cursor deliberately still advances past withheld
events, so a window that was all machinery settles as `empty` rather than being
re-scanned forever — which means a genuinely quiet week and a week of pure
machinery are indistinguishable from the delivery table alone. Anything that
starts a run from a schedule has to hand the host something to render as a
trigger; a transcript row is not a channel to the model. The reasoning behind
everything in this document before this entry is not recorded, and was not
reconstructed.

Shipped in #93.
