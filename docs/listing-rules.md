# Listing rules

Who may be told that a Space, a Channel or a Breakout exists. One ladder of
rules decides it for every person in an Organization, member or guest, and every
directory, sidebar, socket frame and Space read renders it rather than writing
its own test.

Listing is not reading. These rules decide only what may be named. Each
conversation's own authority still decides whether its content may be opened,
and every Space write still requires an active member.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/listing-rules.ts` | The one source of every rule: `admitsOrganizationWide` (the leaf, shared with read authority and search), `organizationWideSql`, `mainOpenableSql`, `breakoutListedSql`, `channelReachedThroughBreakoutSql`, `channelListedSql`, `spaceReachedThroughChannelSql`, `spaceListedSql`, their TypeScript forms for rows already read, and the `Viewer` type with its `member()` constructor. |
| `apps/api/src/durable-objects/workspace-space-storage.ts` | Space directories, the dashboard page, attention counts and Channel placement, each rendering the rules for a `Viewer`. |
| `apps/api/src/durable-objects/workspace-do.ts` | The Channel directory, the socket's Channel rows, Space snapshots and nudges, and the Space reads (`spaceSummary`, `listSpaceChannels`, `channelSpaces`), each taking the viewer from the socket attachment or the caller's relationship. |
| `apps/api/src/durable-objects/channel-rails.ts` | The Channels a `channel_rails` or `space_channels` answer may name. |
| `apps/desktop/src/renderer/components/app-shell.tsx` | `associativeWorkstreamsForSidebar`: the socket's rows, tagged with the conversation a Breakout-only Channel opens on. |
| `apps/desktop/src/renderer/lib/conversation-directory.ts` | `mainReachable`: whether a Channel's Main is this person's, from the row's `mainWithheld` or the conversation directory. The Channel screen, the socket pool and the feed hook all ask it. |

## How it works

Reach flows up from children and grandchildren and never down. Each rule is
built from the one below it:

1. **Organization-wide** (`admitsOrganizationWide`, rendered as
   `organizationWideSql`). A `workspace`-scoped Space, Channel or Breakout
   admits every member. It admits no guest. This leaf is the only place the
   access class changes an answer, and read authority asks the same one:
   `resolveScopedAccess` in `scope-grant-policy.ts` and search's members group
   (`readSearchAudience`).
2. **Main openable** (`mainOpenableSql`). Organization-wide, or the person's
   `channel_viewers` row says they take part. A Channel grant makes a guest a
   participant.
3. **Breakout listed** (`breakoutListedSql`), asked only inside a listed
   Channel. Organization-wide, or the Breakout's `breakout_viewers.listable`.
4. **Channel listed** (`channelListedSql`). Main is openable, or an unarchived
   Breakout in it is `listable` for this person
   (`channelReachedThroughBreakoutSql`). An Organization-wide Breakout inherits
   its Channel's audience, so it never lists a Channel by itself.
5. **Space listed** (`spaceListedSql`). Organization-wide, a participant, or —
   only while the Space is Organization-wide — an active placement of a Channel
   this person may list (`spaceReachedThroughChannelSql`). A private Space is
   the product's private Channel, so it is listed to its participants alone.
   A Personal Channel (`individual`) is listed to its owner alone, and only
   while they are a member: a participant row for anybody else, or the owner
   as a guest, does not list it.

In product words a Space is a **Channel** and a stored Channel is a **thread**
([the navigation PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)).
The rules keep the storage words.

A Channel's feed (`feedPage` in `workspace-space-storage.ts`) lists only the
threads its viewer may open, by `mainOpenableSql`.

A call site passes a `Viewer` (`userId` and `accessClass`) and never branches
on the access class itself. The socket pins the access class on its attachment
at accept time; an RPC reads it from the caller's relationship. Paths that only
a member reaches (writes, durable intents, pinning) build their viewer with
`member(userId)`.

Each SQL fragment binds its own `?` for the user id where it sits. A statement
that already binds the user id first can pass `userId: "?1"` to reuse it. The
Breakout half is left out on an object that has not reached the Breakout
projection (`breakoutsReady()`), which then lists by Main alone.

**A Channel listed only through a Breakout carries none of Main.** Its row
keeps the name, appearance, scope, and this person's own placement, pins and
Breakout counts. `mainWithheld` in `workspace-do.ts` empties the rest: Main's
description, email address, author, run state, unread position, activity time,
wake-up and roster. Its per-viewer state keeps the person's Breakouts and drops
Main's agents and rail waterline. The rail (`channelRails`) answers only
somebody who may open Main, and foregrounding the Channel does not wake Main.
Presence is Main's audience too: someone listed only through a Breakout neither
joins the Channel's face pile nor is told who is in it.
Each of these asks `mainOpenableSql` or its TypeScript form `mainOpenFor`, not
`channelListedSql`. The row says so in `mainWithheld: true`.

The client draws what the socket sends, with the same screens for a member and
a guest: the landing route, the Space dashboard (read-only for a guest) and the
Channel screen. A Channel listed only through a Breakout arrives as an ordinary
row; the conversation directory (`/sharing/navigation`) adds no rows, and only
says which conversation such a row opens on. `mainReachable` reads the row's
`mainWithheld` and the directory, and the client dials Main unless either says
it is withheld. Before either has arrived it dials, as it always has for a
member: a refusal costs one request and drops only Main's own cached entry.

What a guest may *do* is a separate question (`useShellCapabilities().guest`):
Channel and Space writes, the member directory, imports, connectors and the
Sidekick library stay a member's. Search, Speak and push registration are
everyone's, because each answers only for what the person may already reach.

## Invariants

- **Listing never grants reading.** A listed Channel whose Main is not openable
  still refuses Main; a Space reached through one Channel names no other
  Channel and no participant ([`spaces.md`](spaces.md#invariants)). Guard: the
  `space-authority`, `channel-rails` and `space-conversation-page` workerd
  tests.
- **A guest is told nothing Organization-wide.** If `organizationWideSql`
  admitted guests, every guest would learn every public Channel's and Space's
  name. Guard: `channel-rails.test.ts` "lists a guest the Channel they take
  part in, and nothing of an Organization-wide one they are not in", and the
  guest cases in `space-authority.test.ts`.
- **One text per rule.** A second hand-written test drifts from the first, and
  the two then disagree about whether a row exists; the dashboard page, the
  attention counts, the socket rows and the Space directory must all agree.
  Guard: the rules live in one module; no automated check stops a copy.
- **Listing a Channel is not Main's authority.** A row, rail or wake that
  used `channelListedSql` where it meant Main would hand somebody invited to
  one Breakout the Channel's roster, resources, email address and wake-up.
  Guard: `space-conversation-page.test.ts` "given a Channel this viewer
  reaches only through a Breakout, when their socket lists it, then it carries
  its name and none of Main".
- **Reach never flows down.** Seeing a Space or a Channel is never a reason to
  list what is in it. Breaking this lists private Breakouts to everyone in
  their Channel. Guard: `space-conversation-page.test.ts`. The Channel feed
  follows it too: it lists only threads its reader may open.
- **A private Space reaches nobody through a thread.** If the Space rule
  admitted a private Space through a thread in it, every reader of one thread
  would learn a private Channel's name. Guard:
  `channels-threads-navigation.test.ts` "given a Channel made private, when a
  member who is not in it reads it, then it does not exist for them even
  through a thread in it".
- **The feed names no thread its reader may not open.** Two layers hold it:
  `feedPage`'s filter, and `conversationRows`, which drops a thread the viewer
  may not open, so breaking one alone does not show it. Guard:
  `channels-threads-navigation.test.ts` "given a private thread in a Channel,
  when a member who cannot open it reads the feed, then it is not listed".
  A merge from such a thread is shown, as the merger chose, with its words and
  embeds but without the thread's name or summary
  ([`conversation-merge.md`](conversation-merge.md)).
- **A hidden placement is not news.** A private thread placed since a member
  last read a Channel moves its latest number but leaves it read. Guard: the
  same file, "given a private thread placed since a member last read a
  Channel, when they read the stats, then the Channel is not unread for them".
- **A Personal Channel reaches nobody but its owner.** A participant row is not
  enough, because a row written by mistake would otherwise hand someone
  another member's channel; the owner is `created_by_user_id`. Guard:
  `personal-channel.test.ts` "is listed to nobody but its owner, even one given
  a participant row" and "is not listed to its owner while they are a guest".

## Boundary

Owns: the yes-or-no of being listed. Does not own whether content is readable
(each conversation's own authority), the name and mark a member who holds a
link is shown so they can request access
([`channel-access-requests.md`](channel-access-requests.md)),
Space writes ([`spaces.md`](spaces.md)), or which conversations a guest holds
in a Channel ([`scope-grant-directory.md`](scope-grant-directory.md)).

## Failure modes and limits

- An object without Breakout tables lists Channels by Main alone; a person
  reached only through a Breakout sees nothing there until the projection
  lands.
- A stale `channel_viewers` or `breakout_viewers` row (an older authority
  generation) reads as no access, never as access.
- The Space rule is a correlated existence test with no bound on what it scans;
  [`spaces.md`](spaces.md#failure-modes-and-limits) works through its cost.

## Testing

Workerd, from `apps/api`:

```bash
pnpm exec vitest run --config vitest.workers.config.ts \
  test-workers/channel-rails.test.ts test-workers/space-authority.test.ts \
  test-workers/space-conversation-page.test.ts
```

Each rule has a test that fails when it is broken: Breakout reach
(`space-conversation-page`), the guest leaf (`channel-rails`,
`space-authority`), Space reach through a Channel (`space-authority`,
`channel-rails`), and the TypeScript `channelListed` used for socket rows
(`channel-rails`). The client half is `app-shell.test.tsx`.

## Changelog

### 2026-10-13 — A Personal Channel is listed to its owner alone

**What changed:** `spaceListedSql` lists an `individual` Space only when the
viewer is its creator and a member; other participant rows and guest viewers
do not list it.

**Why:** A Personal Channel is for exactly one person. The participant rule
alone would list it to anybody given a viewer row, and to its owner after they
became a guest, who has no Personal Channel.

**Consequences:** Reach for an `individual` Space depends on
`created_by_user_id`, so that column must stay the owner.

### 2026-10-13 — The Channel feed no longer shows locked threads

**What changed:** A private thread a member is not in is left out of the
Channel feed, as it already was for a guest, instead of showing as a locked
"Private thread" row with a **Request access** chip. It no longer counts
toward the Channel's new-thread count, and a Channel whose only new
placements are hidden from this member no longer reads as unread.

**Why:** The product owner reversed the 2026-10-10 call: a Channel's members
should not see that private work exists in it. That also ends the one
exception to the listing ladder.

**Considered and rejected:** No alternative was recorded with the request.

**Consequences:** The feed contract has one row kind; `kind: "thread"` stays
on the wire because desktops shipped since 1.563 parse the row by it, and can
go once those builds no longer reach the API. The
unread dot is gated on the visible count rather than the Channel's own
waterline, because the waterline still moves for every placement.

PR [#1226](https://github.com/juno-ai-labs/avalon/pull/1226).

### 2026-10-10 — A private Space is listed to its participants alone, and the feed names locked threads

**What changed:** The Space rule's third arm, reach through a listable thread,
now applies only to an Organization-wide Space. A Space may be private again
(it is the product's Channel), and a private one is listed to its participants.
`sharedNavigationSpaces` names only Organization-wide Spaces to a guest. The
Channel feed lists threads a member may not open as locked rows with an id and
a time.

**Why:** The navigation redesign makes a Space the product's Channel and lets a
Channel be private
([PRD](PRDs/2026-10-10_channels-threads-navigation/prd.md)). Under the old rule
anybody who could read one thread in a private Channel was told its name, which
is the one thing making it private is for. The locked rows are the product
owner's call: a Channel's members see that work exists and can ask for it.

**Considered and rejected:** Omitting threads a member cannot open from the
feed. It kept the ladder exceptionless, but the product owner chose to show the
shape of the Channel's work.

**Consequences:** A member never has `through_channel` reach any more; it arises
only for a guest in an Organization-wide Space. The locked row must never gain
a field beyond its id and placement time.

### 2026-10-03 — One listing ladder for members and guests

**What changed:** Spaces, Channels and Breakouts are listed by one set of rules
in `listing-rules.ts`, built up from conversation to Channel to Space. A guest
now gets the workspace socket's Channel rows and Space directory, by the same
rules as a member, with Organization-wide scope admitting only members. A
member now sees a Channel they reach only through a Breakout as a socket row.
The client sidebar no longer builds a guest's rail or Spaces from
`/sharing/navigation`.

**Why:** Each listing path carried its own member or guest test. A guest's
socket had been sent every Organization-wide Channel, which leaked the
Organization's Channel list; #1088 closed that by sending a guest's socket no
Channel rows, Spaces or recency at all, with a guard on each path (see the
2026-10-03 entry in [`realtime-sockets.md`](realtime-sockets.md#changelog)).
Those guards are replaced here by the rules, which give the same answer for an
Organization-wide Channel and list what a guest does take part in. Members reached through
a Breakout only were added on the client from a second directory. Each special
case was a place for the rules to drift.

**Considered and rejected:** Keeping guests off the socket and patching the
leaking path alone. It fixed one leak and kept two answers to the same
question.

Holding Main until the row or the directory has said it is the person's. It
kept a guest from ever asking for Main, but left Main shut wherever neither had
loaded yet, including any screen mounted without the shell.

Using the Channel rule for everything a Channel row carries. Security review
found that it handed somebody listed only through a Breakout Main's roster,
resources, email address and wake-up preview, and let them wake Main. Rows,
rails, the wake and presence now ask the Main rule; only existence and Space
reach ask the Channel rule. Pinned rows are listed by the viewer's rule as it
is now, because a pin outlives a member's demotion to guest.

The guest-only branches beside the rules went in the same change: a guest's
own landing (`SharedLanding`), the Space dashboard withheld from guests, the
socket pool turned off for guests, the Channel screen scoping every guest to
their directory entry, and a guest check in `reachableConversations`, which now
asks each Channel's `readableSubstreams` for everyone. Push, search and Speak
were opened to guests by product decision.

**Consequences:** This reverses the Spaces PRD's non-goal "Guest access to
Spaces is deferred"
([`PRDs/2026-09-18_spaces-and-product-hierarchy`](PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md)).
A guest sees a Space only through a Channel in it or as a participant, read-only.
A new listing or read path must render these rules, and a new leaf term that
differs by access class belongs in `admitsOrganizationWide`, nowhere else.
