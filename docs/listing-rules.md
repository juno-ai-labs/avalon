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
| `apps/api/src/durable-objects/listing-rules.ts` | The one source of every rule: `organizationWideSql`, `mainOpenableSql`, `breakoutListedSql`, `channelReachedThroughBreakoutSql`, `channelListedSql`, `spaceReachedThroughChannelSql`, `spaceListedSql`, their TypeScript forms for rows already read, and the `Viewer` type with its `member()` constructor. |
| `apps/api/src/durable-objects/workspace-space-storage.ts` | Space directories, the dashboard page, attention counts and Channel placement, each rendering the rules for a `Viewer`. |
| `apps/api/src/durable-objects/workspace-do.ts` | The Channel directory, the socket's Channel rows, Space snapshots and nudges, and the Space reads (`spaceSummary`, `listSpaceChannels`, `channelSpaces`), each taking the viewer from the socket attachment or the caller's relationship. |
| `apps/api/src/durable-objects/channel-rails.ts` | The Channels a `channel_rails` or `space_channels` answer may name. |
| `apps/desktop/src/renderer/components/app-shell.tsx` | `associativeWorkstreamsForSidebar`: the socket's rows, tagged with the conversation a Breakout-only Channel opens on. |

## How it works

Reach flows up from children and grandchildren and never down. Each rule is
built from the one below it:

1. **Organization-wide** (`organizationWideSql`). A `workspace`-scoped Space,
   Channel or Breakout admits every member. It admits no guest. This leaf is
   the only place the access class changes an answer.
2. **Main openable** (`mainOpenableSql`). Organization-wide, or the person's
   `channel_viewers` row says they take part. A Channel grant makes a guest a
   participant.
3. **Breakout listed** (`breakoutListedSql`), asked only inside a listed
   Channel. Organization-wide, or the Breakout's `breakout_viewers.listable`.
4. **Channel listed** (`channelListedSql`). Main is openable, or an unarchived
   Breakout in it is `listable` for this person
   (`channelReachedThroughBreakoutSql`). An Organization-wide Breakout inherits
   its Channel's audience, so it never lists a Channel by itself.
5. **Space listed** (`spaceListedSql`). Organization-wide, a participant, or an
   active placement of a Channel this person may list
   (`spaceReachedThroughChannelSql`).

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
`channelListedSql`.

The client draws what the socket sends. A Channel listed only through a
Breakout arrives as an ordinary row; the conversation directory
(`/sharing/navigation`) adds no rows, and only says which conversation such a
row opens on, so it never opens on Main.

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
  their Channel. Guard: `space-conversation-page.test.ts`.

## Boundary

Owns: the yes-or-no of being listed. Does not own whether content is readable
(each conversation's own authority),
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

Using the Channel rule for everything a Channel row carries. Security review
found that it handed somebody listed only through a Breakout Main's roster,
resources, email address and wake-up preview, and let them wake Main. Rows,
rails, the wake and presence now ask the Main rule; only existence and Space
reach ask the Channel rule. Pinned rows are listed by the viewer's rule as it
is now, because a pin outlives a member's demotion to guest.

**Consequences:** This reverses the Spaces PRD's non-goal "Guest access to
Spaces is deferred"
([`PRDs/2026-09-18_spaces-and-product-hierarchy`](PRDs/2026-09-18_spaces-and-product-hierarchy/prd.md)).
A guest sees a Space only through a Channel in it or as a participant, read-only.
A new listing path must render these rules, and a new leaf term that differs by
access class belongs in `organizationWideSql`, nowhere else.
