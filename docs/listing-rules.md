# Listing rules (retired)

**The listing rules are deleted.** `apps/api/src/durable-objects/listing-rules.ts`
held the one ladder that decided who may be told a Space, Channel or Breakout
exists: Organization-wide scope admits a member and never a guest, a
participant is listed what they take part in, a Channel is listed through a
Breakout of it, and a Space through a Channel in it. The Canvases and Sidekicks
pivot ([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)) removed all three
from the product, and plan step C-2 deleted the module once its last reader,
agent memory's visibility, was re-derived from Canvas and Sidekick
participation.

This document is kept for its changelog, which is the record of why the guest
rule and the "listed through" rules are shaped as they are. Do not build on
anything it describes; the code is gone.

## What survived

- **`admitsOrganizationWide`**, `AccessClass` and `Viewer` moved to
  `apps/api/src/services/authorization-policy.ts`, beside `sidekickAdmits`:
  the member-versus-guest difference still decides every Canvas and Sidekick
  read, scope grants and search's audience.
- **Agent memory's visibility** (`workspace-memory-facts-storage.ts`) opens a
  Canvas source through `canvasReaderAllows` and a Sidekick source through
  `sidekickAdmits`; a Thread's, Breakout's or Channel's source opens to nobody
  ([`agent-memory.md`](agent-memory.md)).
- **Scope grants' Organization-wide branch** (`scope-grant-policy.ts`) reads
  the parent's visibility and the access class directly.

## Changelog

### 2026-11-07 — The listing rules are deleted

**What changed:** `listing-rules.ts` is deleted. Its last importers were agent
memory's visibility SQL (Thread, Breakout and Channel sources), a Thread
summary's Space pins and scope grants' Thread rule; the first is re-derived from
Canvas and Sidekick participation, the second returns no pins, and the third
inlines the access-class test. `admitsOrganizationWide` moved to
`authorization-policy.ts`.

**Why:** Plan step C-2 of the [Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md):
nothing lists a Space, Channel or Breakout any more, and a rule ladder over
tables nothing writes would only keep the next reader building on it.

**Consequences:** The `channels`, `breakouts`, `spaces` and viewer tables stay
until plan step C-7 drops them; nothing in this module's place reads them.

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
