# Channels, Threads, and navigation

> Created 2026-10-10.
>
> Rally's hierarchy becomes Organization, Space (hidden for now), Channel,
> Thread, and Breakout. Today's Channel is renamed Thread, today's Space
> container becomes the new Channel, and the sidebar becomes a section switcher
> for Channels, Threads, and Activity. Companion: [state](state.md). Supersedes
> the hierarchy defined by
> [the Spaces PRD](../2026-09-18_spaces-and-product-hierarchy/prd.md). Related
> subsystem references: [desktop shell](../../desktop-shell.md),
> [Spaces](../../spaces.md), [attention menu](../../attention-menu.md),
> [menu bar](../../menu-bar.md), [pinning](../../workstream-pinning.md),
> [access requests](../../channel-access-requests.md), and
> [links](../../workstream-links.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Rally's visible hierarchy becomes **Organization → Space → Channel → Thread →
Breakout**, with the Space level hidden for now. In terms people already know:
a Space is a project, a Channel is its list of tasks, a Thread is one task, and
a Breakout is a sub-task.

A **Channel** is a stable, named place for an ongoing area of work, such as a
team, a client, or an open role. It holds no conversation and runs no
inference. It lists the threads started in it, and its composer starts a new
one. A **Thread** is what Rally calls a Channel today: a contained unit of work
that runs from start to finish, where people and Rally talk and act. A
**Breakout** stays what it is today, and to a person it is just another thread.

The sidebar becomes a section switcher with three sections: **Channels**,
**Threads**, and **Activity**. People find a channel in one list, jump back into
any thread they take part in from a second list sorted by recency, and see what
happened to them across threads in a third. Panes open side by side in a stack,
so a channel, its thread, and the thread's breakout stay in reach without a
second sidebar.

This ships on macOS and in the browser, which share one renderer. iOS keeps
working against the API and gains no new UI in this change.

## Motivation

The founder spent two days and about twenty sketches on this layout, and the
main constraint was to avoid multiple sidebars again. The 2026-10-01 change in
[`desktop-shell.md`](../../desktop-shell.md) removed three nested rails (Spaces,
Channels, and per-Channel Breakouts) because they spent most of the window on
navigation. Any new level has to fit without bringing them back.

The current model mixes two kinds of thing under one name. Some Channels are
long-lived places that a team returns to for months. Others are short pieces of
work that start, finish, and hand back a result. Slack keeps the first kind
stable: a person has 10 to 30 channels, and a recruiter with one channel per
open role may have 50 or 60, each lasting months. Rally's Channels today behave
like the second kind. A list that holds both grows without bound, and the
stable places get lost among the short tasks.

People need two things that pull in different directions. They need to find a
channel easily, which wants a short, stable, alphabetical list. And they need
to pop back into a thread easily, which wants a list of recent work. Slack has
no thread list, so people fall back on its activity view to find threads.
ChatGPT and Claude solve the second need with a sidebar of recent
conversations. Rally gives each need its own section and keeps the two apart.

A thread is reached two ways: from the channel it was started in, or from the
Threads list. When a thread is done, its result goes back to the channel, where
the next person finds it.

There is no usage data to size this. The evidence is the product owner's
direct decision, the sketches behind it, and the shell change of 2026-10-01
that showed what a nested layout costs.

## Goals

1. Every user-visible surface on macOS and the browser presents the hierarchy
   as Organization, Channel, Thread, and Breakout, and never shows the word
   Space.
2. A person finds any channel they can see from one list: their pinned
   channels first, then every channel from A to Z.
3. A person reopens any thread or breakout they take part in from one list,
   sorted by recency by default.
4. A person sees, in one feed, the events that concern them across threads:
   being added, breakouts started, runs finished, mentions, and threads started
   in their channels.
5. A channel screen shows each of its threads as a short summary with one
   control that opens it, and starts a new thread from its composer.
6. A thread the viewer cannot open still shows in its channel's feed as a
   locked row, with a way to request access, and reveals nothing else.
7. Every existing Space, its id, its memberships, its Slack room bindings, its
   D1 anchors, and its links carry over as a Channel with no data copy.
8. Every link that worked before this change still opens the same thing.
9. A person opens a thread beside its channel, and a breakout beside its
   thread, without losing their place.
10. The Threads button shows the same count as today's attention count, the
    macOS menu bar, and the dock badge.

## Non-goals

1. **An iOS redesign is deferred.** iOS is a prototype platform and lags the
   desktop. It keeps working against the API, which stays compatible, and gains
   no new UI here.
2. **Visible Spaces are deferred.** The Space level exists in the model so the
   hierarchy has room to grow, but nothing shows it and nothing stores it yet.
   See key design decision 3.
3. **Thread summaries that track a thread as it diverges are deferred.** The
   channel feed shows the thread's existing AI description. The founder noted
   Rally "may in the future summarize the thread itself"; that needs new
   inference and its own PRD.
4. **Unread dots and new-thread counts on Channels are rejected for now** by the
   product owner. Channels are a place to find things, not a second queue. The
   Threads count is the one number to watch.
5. **Nested breakouts are rejected.** A breakout cannot have its own breakout.
   The pane stack stays two deep for any piece of work, and a breakout is
   already a sub-task.
6. **Starting a thread outside a channel is rejected.** A person starts a
   thread only from a channel's composer, so every thread has a home and its
   result has somewhere to go back to. Sidekick runs, connectors, and Slack
   rooms keep creating threads the way they do today, in the channel they name
   or in General.
7. **Storage renames are rejected**, for the same reason as non-goal 7 of
   [the Spaces PRD](../2026-09-18_spaces-and-product-hierarchy/prd.md): they add
   migration risk and change nothing a person sees. See key design decision 2.
8. **A channel conversation is rejected.** A channel has no chat between
   people, no Rally replies, and no inference of its own. Conversation happens
   in threads.

## Product behavior

### Product language

| Today | After this change |
| --- | --- |
| Organization | Organization |
| Space | Channel |
| Channel | Thread |
| Breakout | Breakout (a thread, to a person) |

Every visible surface uses the new words: navigation, headers, empty and error
states, tooltips, accessible names, menus, notifications, and docs written for
users. "New channel" creates a channel in the new sense. "New breakout" stays.

### The section switcher

The left edge of the window holds the section switcher: three buttons, each an
icon with a label, for **Channels**, **Threads**, and **Activity**. The person's
avatar sits at the bottom and opens the account menu, as today. The selected
section's list fills the sidebar next to it. The switcher is not called a rail;
that name belongs to the server's `channel_rails`.

The **Threads** button carries a red count. It counts the same items as today's
attention count: conversations where the person is unseen, mentioned, or has
unread messages, plus pending access requests the person can decide
([`attention-menu.md`](../../attention-menu.md)). The macOS menu bar and the
dock badge show the same number. The **Channels** button has no badge.

The attention pop-out leaves the sidebar's top bar. Its job moves to the
Activity section and the Threads list's **Needs attention** sort.

### Channels section

The list has two parts:

1. **Pinned**: the channels the person pinned, in the order they dragged them.
2. **All channels**: every channel the person can see, A to Z. There is no sort
   control.

Each row shows the channel's icon, its name, the time of its last activity, and
"N threads". General is an ordinary channel named General and sorts with the
rest.

A person sees a channel when it is Organization-wide, or when it is private and
they are a member. Choosing a row opens the channel screen.

### Threads section

The list has two parts:

1. **Pinned**: the threads and breakouts the person pinned, in the order they
   dragged them.
2. Every thread and breakout the person takes part in.

The second part sorts by **Recent** (the default), **A to Z**, or **Needs
attention**. Needs attention puts the items counted on the Threads button
first.

Each row shows a status marker, the title, and a chip for each channel the
thread sits in. The marker is red when the thread needs the person, blue when
it has unread messages, and the running mark when Rally is working. A breakout
row also carries a chip naming its parent thread.

Choosing a row opens the thread or breakout as the left pane, with nothing to
its right.

### Activity section

Activity is a feed of server events about the person, grouped under **Today**,
**Yesterday**, and older dates. Pending access requests the person can decide
sit on top, above the groups. Each item has an unread dot until the person
opens it.

The events are:

- someone added you to a thread;
- someone started a breakout on a thread, with a breakout chip;
- Rally finished a run in a thread you take part in;
- someone mentioned you;
- someone started a thread in a channel you are in.

Choosing an item opens what it names. Activity has no reply box and no triage
state; it points to work and does not hold it.

An event about a thread or breakout the person cannot open does not reach their
feed. The server checks this when it reads the feed, so an item never names a
thread the person could not see.

### Channel screen

A channel screen has a header with the channel's name, icon, scope, and menu, a
feed, and a composer at the bottom.

The **feed** lists the threads in the channel, newest nearest the composer. Each
thread shows:

- a one or two line summary, which is the thread's existing AI description.
  This change adds no new inference;
- one breakout-style chip that opens the thread.

Every thread uses the same chip, so the feed reads the same whatever kind of
work a thread holds.

A thread the person cannot open shows as a **locked row**: the words "Private
thread", the time it started, and a **Request access** chip. It shows no title,
no summary, and no participants. The chip opens the existing access request
flow ([`channel-access-requests.md`](../../channel-access-requests.md)).

The **composer** starts a new thread. A person types a prompt and sends it; the
prompt becomes the thread's first message, Rally starts work in the thread, and
the thread opens in the right pane. The composer offers the same audience
choice a new Channel offers today, with the same default. In a private channel
only members see the composer.

Nobody chats in a channel. There is no message list between people, and Rally
never replies on a channel screen.

### Scope and access

A channel's scope is **private** or **Organization-wide**. Every channel starts
Organization-wide, including every channel migrated from a Space. A member can
make a channel private; a private channel is listed only to its members.

A channel grants no access to its threads. Each thread keeps its own audience,
exactly as a Channel does today. So an Organization-wide channel can hold a
private thread, which shows as a locked row, and a private channel can hold an
Organization-wide thread, which anyone can open from a link or search.

A thread can sit in several channels, as a Channel can sit in several Spaces
today. It shows in each channel's feed, and its row in the Threads list carries
a chip for each.

### Panes

Panes form a stack. Two are visible at once; earlier ones collapse into
breadcrumbs above the left pane.

1. Opening a thread from a channel puts the channel on the left and the thread
   on the right.
2. Opening a breakout from that thread moves the thread to the left, puts the
   breakout on the right, and turns the channel into a breadcrumb.
3. Opening a link inside the breakout, such as an artifact or a resource, moves
   the breakout to the left and opens the link on the right. The thread joins
   the breadcrumbs.

Choosing a breadcrumb returns to it: that item becomes the left pane and the
one after it the right pane. Opening a thread from the Threads list or Activity
starts a new stack with the thread on the left. The thread's channel chips in
its header open the channel as a new stack.

Breakouts do not nest, so a stack is at most channel, thread, breakout, and one
link.

At phone width in the browser, one pane is visible and the rest are
breadcrumbs. The section switcher sits in the sidebar sheet that the menu
button opens today.

### Empty, loading, error, and offline

- **Empty.** The Channels section is never empty, because General always
  exists. An empty Threads section says "No threads yet" and offers to open
  Channels. An empty Activity section says "Nothing here yet". An empty channel
  feed shows only the composer, with "Start the first thread in this channel".
- **Loading.** Lists draw from what the workspace socket already holds, as the
  sidebar does today, and show placeholder rows only on a cold start. Opening a
  channel draws its header at once and fills the feed when the first page
  arrives.
- **Error.** A list or feed that fails to load shows the failure in place with
  a retry button, and the reason the server gave.
- **Offline.** Lists and feeds show what was last loaded and say so. The
  composer is disabled with "You're offline", and pin drags are refused rather
  than queued.

### Links

`/s/<space>/c/<channel>/b/<breakout>` already reads as channel, thread, and
breakout, because the Space id is now the channel id and the old Channel id is
now the thread id. Old links keep resolving to the same item. New links use the
same shape. See [`workstream-links.md`](../../workstream-links.md).

## Impact on the product contract

This changes [the implementation brief](../2026-08-05_avalon-implementation-brief/prd.md)
in four places, and this PRD edits it in the same change.

1. **The hierarchy sentence and the Space clause move.** The brief said the
   visible hierarchy is Organizations, Spaces, Channels, and Breakouts, and that
   every Channel belongs to a Space that is "an organizational and inheritance
   surface". It now says Organizations, Channels, Threads, and Breakouts, with a
   Space level that is not yet shown; that every Thread belongs to at least one
   Channel; and that a Channel lists threads, holds no conversation, runs no
   inference, and grants no access to its threads.
2. **What the brief called a Channel is now a Thread.** The clauses on the
   durable home of work, Rally being inherent, automation runs owning one
   conversation, Breakouts, and the Terminal plugin now say Thread. Their
   meaning does not change.
3. **"Rally has no global activity feed" no longer holds.** The Activity
   section is a feed across threads. It lists events about the person, not
   everything that happens in the Organization, and it never shows connector
   activity, which
   still routes into a watched resource, an automation, or an in-thread
   suggestion. The brief's clause now says that.
4. **"Rather than a global inbox" is kept, with a narrower meaning.** The
   Threads list sorted by Needs attention and the Activity feed are close to an
   inbox. Neither holds work: there is no reply box, no done state, and no
   archive outside a thread, and each item opens the thread where work happens.
   The brief's opening sentence keeps the phrase. A later change that adds a
   reply box, a done state, or an archive to either surface crosses that line
   and must change the brief.

The rest holds: viewing does not create participation, tools stay typed and
authorized, writes stay idempotent, visible, and audited, and Rally gains no
global search beyond what exists.

## Decision log

### 2026-10-10 — Activity reads the existing log; no new event types

**Decided:** A thread or breakout start is the conversation's opening message
event, now tagged with `metadata.substreamId`. "Rally finished" is each
conversation's latest `completed_at` from the directory. Mentions become
`mentioned` targets on message events. No `thread.started`, `breakout.started`
or `run.finished` producer is added.

**Why:** Each fact was already recorded once; a second event would be a second
answer that can disagree with the first.

**Changes:** Narrows the Data model's activity sketch. Starts written before
deploy carry no `substreamId`, so they do not appear. A run that finishes twice
shows once, at its latest finish. Shipped in PR A.

### 2026-10-10 — Activity read state is one time per person

**Decided:** `workspace_activity_seen(user_id, seen_through)`, moved forward
when the tab is opened. No per-item read rows.

**Why:** Opening the tab reads everything above it; a per-item ledger records
that fact once per row. Supersedes the Data model's per-item reads.

**Changes:** Unread is "newer than the last time you opened Activity". Shipped
in PR A.

### 2026-10-10 — Private channels use the existing audience route

**Decided:** No new add and remove member routes. `PATCH /spaces/:id/audience`
sets the scope and the whole member set in one WorkspaceDO transaction, and now
accepts `personal`. Creation still reads every scope as `workspace`, so a
desktop that still sends `personal` on creation makes a public channel.

**Why:** The route already does both in one transaction; delta routes would be
a second write path to the same rows.

**Changes:** Nothing in scope. The old desktop's `SpaceScopeSchema` already
accepted `personal`, so a private channel parses there (rollout's check).
Shipped in PR A.

### 2026-10-10 — Guests get no locked rows; pins mirror one way

**Decided:** A guest's channel feed lists only the threads they may open. Pins
made on an old desktop are copied into `workspace_pins`; pins made on the new
client are not written back to the per-Space table.

**Why:** A guest reaches a channel only through threads shared with them, and
the rest of an Organization's work is none of theirs to count. Writing new pins
back would need a Space to file each one under, which a thread pin no longer
has.

**Changes:** Narrows Product behavior's locked rows to members, and Rollout's
"pin dual-write keeps both clients in step" to the old-to-new direction. Shipped
in PR A.

### 2026-10-10 — Sidekicks live in the title pill; a private channel's threads start private

**Decided:** The Sidekick list is a level of the title pill's pop-out: a
thread's and a breakout's pills keep the Sidekicks level they have, and the
channel screen's pill gains one listing the channel's Sidekick defaults (the
Space defaults of kind `sidekick`). A thread started in a private channel is
visible only to the person who started it and whoever they mention. A thread
started in an Organization-wide channel stays Organization-wide, as every new
thread is today.

**Why:** The product owner's answers to the two open questions. The sidebar
never held a Sidekick list, so nothing moves out of it.

**Changes:** Resolves both open questions. Space Sidekick defaults are kept
rather than retired in the cleanup PR. `resolveSpaceWorkstreamStart` narrows a
thread a person starts in a private channel to private. Shipped in PR B for
every creator, then limited to the person-started route
(`narrowInPrivateSpaces`): a connector such as Slack resolves its own audience
from its room, and narrowing it left a public Slack channel's thread unreadable
to that channel's members.

## Key design decisions

1. **Today's Space container is the new Channel.** It keeps the same rows
   (WorkspaceDO `spaces`, `space_viewers`, `space_channel_memberships`) and the
   same ids. The General Space becomes the General channel. Slack room bindings,
   D1 anchors, and links carry over untouched, and
   `/s/<space>/c/<channel>/b/<breakout>` already reads as channel, thread, and
   breakout. A new channel table was rejected: it means copying rows, re-keying
   pins, moving hosted parents and anchors, re-pointing Slack bindings, and
   rewriting links, and it gains nothing.
2. **Storage names stay.** `spaces`, `workstream`, the `channels` table (which
   holds threads), and `substream` keep their names, as non-goal 7 of the
   Spaces PRD kept workspace and workstream. Only user-facing copy changes.
   Renaming was rejected because it costs migrations and changes nothing a
   person sees.
3. **The hidden Space level gets no storage now.** When Spaces become visible,
   they can be a nullable parent container column on `spaces`. A table built
   now would be a second implementation nobody has asked for.
4. **Locked rows break the listing rule on purpose.** Rally does not normally
   list what a person cannot open. A channel feed that hid private threads
   would look complete while it was not, and people could not ask to join
   work they did not know existed. The locked row reveals that a thread exists
   and when it started, and never its title, summary, or participants.
5. **Pins move to one per-person table keyed by item kind.** One table,
   `workspace_pins`, holds thread, channel, and breakout pins, so the Pinned
   part of each section reads one place. Old per-Space pins are copied into
   thread pins, and pin writes go to both tables until old desktops age out.
   Keeping per-Space pins was rejected: a thread pin no longer belongs to one
   place.
6. **Activity reuses the WorkspaceDO activity event log.** Digests already
   write `workspace_activity_events` and its targets. The new events are
   written with `digestible = 0`, so digests ignore them. Breakout events are
   filtered per viewer at read time against `breakout_viewers`, so a change to
   a breakout's audience never leaves a stale item. A separate feed store was
   rejected as a second log for the same events.
7. **No feature flag.** The client switch ships in one pull request so
   "Channel" never means two things in a shipped build. A flag would put both
   meanings in one build and in every screen that says the word.

## Data model

Sketch only; the migrations and [`data-model.md`](../../data-model.md) are the
record. Every change is in WorkspaceDO SQLite, and every one adds rather than
replaces until the cleanup in rollout step 3.

- **`workspace_pins`** `(user_id, item_kind, item_id, position, created_at,
  updated_at)`, primary key `(user_id, item_kind, item_id)`, with
  `item_kind IN ('thread', 'channel', 'breakout')` and an index on
  `(user_id, item_kind, position, item_id)`. Backfilled from
  `workspace_workstream_pins` and `workspace_pinned_order` as thread pins, one
  row per thread, in the person's existing pinned order.
- **Participation indexes** on `channel_viewers(user_id, is_participant)` and
  `breakout_viewers(user_id, is_participant)`, so the Threads list reads one
  person's threads without scanning every viewer row.
- **A feed index** on `space_channel_memberships(space_id, state, joined_at,
  workstream_id)`, so a channel's feed pages in order.
- **`spaces.scope` accepts `'personal'` again.** Migration 94 made every Space
  Organization-wide; the column's check still allows `'personal'`, and the
  service stops refusing it. `'personal'` is the stored value for a private
  channel. No existing row changes.
- **Activity read state**: a per-person cursor `(user_id, read_through_sequence)`
  for "mark all read", and per-item reads `(user_id, event_id, read_at)` for
  items opened above the cursor.

No D1 table changes. Slack room bindings and D1 anchors keep pointing at the
same Space ids.

## Regional impact

None. Channels, threads, pins, and activity all live in WorkspaceDO in the
Organization's region, as they do today. Nothing new crosses the regional
boundary.

## Security and trust model

- A private channel's name, icon, and feed are visible only to its members.
  The server filters the Channels list and refuses a channel screen to anyone
  else.
- A channel grants no reader to its threads. Each thread's own audience is the
  only authority on who opens it, as today.
- A locked row carries only the thread id, its start time, and the request
  access action. The server builds it without reading title, description, or
  participants, so the renderer never holds them.
- Activity items are checked per viewer at read time against the thread's and
  breakout's current audience. An item the viewer cannot open is dropped, not
  redacted.
- Guests see no Channels section. The guest browser keeps showing only the
  threads and breakouts shared with them.

## Rollout

This ships to everyone on merge, with no flag (key design decision 7). It lands
in three pull requests, and the server deploys before the client.

1. **A: server, add-only.** The new tables, indexes, scope value, feed and
   Threads list reads, activity events and read state, and pin dual-writes. No
   current client calls any of it, so it is invisible.
2. **B: client, the whole switch.** Section switcher, the three sections,
   channel screen, panes, and every copy change, on macOS and in the browser
   together. It needs A deployed in every region first.
3. **C: cleanup.** Once the declared minimum client version is past B's
   release, remove the legacy Space and pin routes, stop the dual-write, and
   drop `workspace_workstream_pins` and `workspace_pinned_order`.

To back out B, revert it; A keeps serving the old client, and the pin
dual-write keeps both clients' pins in step. A channel made private after B
shipped stays private, and the old client must show it as a personal Space;
A checks that its Space contract still parses that value before B merges.
