# Local cache

Opening a Space, a Channel, or a Breakout paints from what the device last saw
before the socket that owns it answers. The desktop keeps one IndexedDB
database, `rally-local-cache`, holding the last first page of the workspace
directory and the last canonical state of every conversation the reader opened
or the socket pool warmed. It also holds [attachment image bytes](attachment-preview-cache.md),
which are validated against the API before reuse. On the next launch, or the next open of a room whose
socket is still cold, the sidebar, the Channel screen, and the transcript are
on screen immediately; a small floating card says the live connection is on its
way, and the composer accepts a draft but does not send until it has arrived.

Nothing in the cache is authoritative. A cached value is a *seed*: it paints,
and that is all it does. The socket's first frame (or, for REST-backed state
such as `usage`, the next answer) replaces it whatever its version numbers say, it never completes an opening, it never fences a snapshot,
and it is never written back. Read this before changing what a screen paints
before its socket answers, adding a surface that should, or touching the
socket hooks' first frame.

An open also requests the workspace's compact
[conversation view projection](conversation-view-cache.md) alongside disk
hydration; both use the read-only `local_cache` marker and write gates described
here, with reconciliation and retries owned by the linked projection document.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/retain-query-data.ts` | Producer-owned in-memory query retention: keeps pushed state resident for its socket owner's lifetime, without fetching or defeating explicit eviction. |
| `apps/desktop/src/renderer/lib/indexeddb-store.ts` | `createIndexedDbStore`: the best-effort IndexedDB database with an epoch fence that this cache and the draft cache are both built on. The only file that opens IndexedDB. |
| `apps/desktop/src/renderer/lib/local-cache.ts` | The `rally-local-cache` database on that store: rows keyed by `[scope, kind, key]`, the version stamp, `defineLocalCacheSlice`, `clearAllLocalCache`, `clearWorkspaceLocalCache`. |
| `apps/desktop/src/renderer/lib/local-cache-mirror.ts` | `mirrorQueriesToLocalCache`: keep a slice equal to a family of query-cache entries, coalescing a burst of writes into one; `LOCAL_CACHE_WRITE_COALESCE_MS`. |
| `apps/desktop/src/renderer/lib/local-cache-scope.tsx` | `LocalCacheScopeProvider` and `useLocalCacheScope`: the regional workspace every row below it belongs to. No provider, no cache. |
| `apps/desktop/src/renderer/lib/conversation-cache.ts` | The `conversation` slice: one row per `(parent, substream)`, `hydrateConversation`, `mirrorConversation`, the seed marker, and the pruning and forgetting entry points. |
| `apps/desktop/src/renderer/lib/organization-usage.ts` | The `usage` slice: one row per Organization scope holding the last `GET /workspace/usage` answer and when it arrived; `useOrganizationUsage`, which seeds from it and writes each answer back. |
| `apps/desktop/src/renderer/lib/workspace-directory-cache.ts` | The `directory` slice: one row per workspace holding the Channel list, the automation and note lists, and both Space directories; `hydrateWorkspaceDirectory`, `mirrorWorkspaceDirectory`. |
| `apps/desktop/src/renderer/lib/transcript.ts` (`openingTranscriptSnapshot`) | The shape a transcript is persisted in: its opening ranges only. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Hydrates a conversation at effect start, mirrors it while mounted, and treats a seed as neither a completed opening nor a snapshot fence. |
| `apps/desktop/src/renderer/lib/channel-rails.ts` | Holds each Channel's rail at the waterline it was answered at, decides which rails are stale and what to ask for next, and reads and seeds the rails the directory row keeps. |
| `apps/desktop/src/renderer/lib/channel-viewer-state.ts` | Prunes cached children that left the parent's private-child roster, from the breakout list each Channel row carries on the workspace socket; reads those lists for the directory row and seeds them back from it. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Hydrates the directory before connecting, mirrors it after the first subscribe answer, and prunes conversations whose parent that answer no longer lists. |
| `apps/desktop/src/renderer/lib/workstreams-cache.ts` | `evictCachedWorkstream` and `evictCachedSubstream` forget the disk along with the memory. |
| `apps/desktop/src/renderer/lib/app-session.tsx` | Wipes the whole cache when the account leaves the device and one workspace's rows when that membership ends or the workspace refuses the account, beside the draft cache's wipes. |
| `apps/desktop/src/renderer/App.tsx` | Mounts the scope provider above the workspace socket provider. |
| `apps/desktop/src/renderer/components/connecting-card.tsx` | The floating card, connecting, waiting for a connection, or failed with a retry, and the always-mounted slot that is its live region. |
| `apps/desktop/src/renderer/components/substream-launch.tsx` | Carries the parent's card and send gate while a substream is branched off a seed. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Reads the seed marker: shows the card, gates sending, and holds range loads and read acknowledgements until the feed is live. |
| `apps/desktop/src/renderer/screens/workstream.tsx` (`useChannelRail`) | Feeds the Channel title-pill menu's people, Sidekicks and artifacts from the Channel's rail while the conversation has no detail yet. |
| `apps/desktop/src/renderer/components/workstream-composer.tsx` | `sendBlocked`: everything but sending. |

## How it works

### A live subscription owns its in-memory state

A socket's state lives at least as long as the subscription that supplies it.
Screens only read that state; navigating away does not make a retained
subscription's state disposable. `retainQueryData` holds disabled query
observers for the producer's entries, including entries first created after
retention starts. It does not create empty entries, fetch, change values, or
change their garbage-collection duration. On release, the ordinary cache
collection rules resume. Multiple producers can hold the same entry.

The workspace socket holds its directories, feature flags and work-stream
ordering ledgers, and each Channel's breakout list and the version stored
with it, which arrive on that Channel's row. Each conversation socket holds its
detail, transcript, inherited context, streaming overlays, feed source and
snapshot generation. These leases follow the socket-owning effects, including
background retention and reconnects, rather than the visible route.

The existing sidebar-list waterline ledger is the exception: its receiver pins
it for the entire query-client lifetime, independently of the workspace socket.
That older invariant protects all list writes through the receiver, including
ones made without a mounted socket. New socket-owned entries use the lease;
the sidebar ledger's explicit eviction still applies.

`retainQueryData` holds in-memory entries. The adjacent
`retainConversationParents` / `retainConversationChildren` calls instead prune
the persisted cache to a keep-set; they do not supply these in-memory leases.

Explicit removal still wins: the lease releases the removed entry without
recreating it or restoring its old data. If the producer later writes a new
entry under that key, the lease holds the replacement. This matters both for
access revocation and for inherited context, which is removed while a new
chunked snapshot is assembled. Owner cleanup releases every observer and its
cache listener. A newly mounted socket obtains its initial snapshot through
the existing subscribe protocol; returning to a retained socket reads the
state that subscription kept resident.

Disk persistence below is separate. It seeds a new subscription; it is not the
recovery mechanism for an active subscription whose data was discarded.

### The store and its slices

The database is opened through `createIndexedDbStore`, the same best-effort,
epoch-fenced store the draft cache is built on; what is particular to this
cache is one object store of rows `{ scope, kind, key, subject, version,
updatedAt, value }` with a compound primary key of `[scope, kind, key]`. A
*scope* is the account's user id followed by
`desktopWorkspaceIdentityKey(region, workspaceId)`, so one account's rows for
one workspace are one key range, leaving that workspace deletes exactly them,
and two accounts on one device that share a workspace never read each other's
rows, whatever order a wipe and a hydration run in. A guest's scope adds
`:guest`, so an account demoted from member to guest never reads back what it
cached as a member; leaving the workspace deletes both ranges. A *kind* names the slice
that owns the row's shape. The *subject* is what
the row is about, for removal by identity rather than by key: every
conversation under one work stream carries the work stream's id, so losing the
work stream drops them all in one index scan. Two indexes, `[kind, subject]`
and `[kind, key]`, are what let an eviction that knows only an id reach every
scope.

`defineLocalCacheSlice({ kind, version, parse })` is the unit everything else
composes with. A slice reads, writes, lists, and removes rows of its kind; the
store below it is never touched directly. `parse` turns a stored value back
into the slice's type or refuses it, and `version` is bumped when the shape
changes in a way `parse` cannot absorb. A row written under another version, or
one `parse` refuses, is dropped on read and deleted: the cache holds nothing
that cannot be fetched again, so a migration would be work spent on rows the
next socket answer replaces anyway.

Three slices exist today, and the next surface that wants to paint before its
answer arrives defines another:

| Slice | Key | Subject | Holds |
| --- | --- | --- | --- |
| `directory` | `directory` | `directory` | The Channel list as the sidebar holds it, each of those Channels' breakout lists and rails, the automation list, the active and archived Space directories, and the compatible personal-order payload used by the manually arranged Space rail. |
| `conversation` | `<parentId>:<substreamId>` | `<parentId>` | The `WorkstreamDetail` the header and composer read, the transcript trimmed to its opening ranges, and a private child's inherited context. |
| `usage` | `usage` | `usage` | The last `OrganizationUsage` answer, the plan, the share of the week's quota left, the reset instant and the month's overage, and `fetchedAt`, the time it arrived. |

The store is best-effort by construction, like the draft cache beside it: every
operation resolves to its fallback rather than throwing. A renderer with no
IndexedDB, no quota, or a corrupt database opens every screen the way it did
before the cache existed, waiting for the socket.

### What opening a workspace paints

`WorkspaceSocketProvider` reads the `directory` row for its scope before it
dials. If the work-stream list is still empty, the cached lists go straight
into the query-cache entries the sidebar, the landing route, and the Space
dashboard read: `['workstreams']` through `setCachedWorkstreams`, `['automations']`,
`['spaces']`, `['spaces-inactive']`, and `['personal-order']` — the compatible
ordering payload whose Organization entry arranges the Space pills. They go in directly,
not through the versioned receivers, because a seed has no waterline and must
not move a ledger; the ledgers stay at their empty state, which is what lets
the socket's first subscribe answer apply over the seed whatever version it
carries. The socket-owned directory is seeded as a unit or not at all. Navigation
queries are seeded individually only when absent: the socket can win the race
with disk without supplying the REST-owned My Threads page.

The current navigation lists are restored in that same batch: pins, pinned
artifacts, Channel stats and the first page of My Threads (including all pinned
thread and breakout rows). Restoring just the directory would first draw every
Channel unpinned, then animate the pins into place when the socket answers.
The mirror watches these queries too, so pinning without a directory change
updates the next launch. Only the first thread page is kept, with its cursor;
My Threads refreshes through REST. Seeded Channel stats are explicitly
invalidated without starting a refetch: they can paint immediately, but even
Infinity-stale-time readers must refresh before choosing an opening unread
position. A fresh REST or socket answer replaces the seed. Thread rows are validated as mapped client summaries, preserving
fields such as preview, rather than as server wire objects. Each navigation
list is parsed independently so an unreadable list does not discard the others.
Existing in-memory answers always win over disk.
Older rows without navigation remain readable and wait for the live lists.

With the lists present, the sidebar draws rows instead of skeletons, the
landing route resolves to the first Channel without waiting, and a Space
dashboard renders its header and its placements. The subscribe answer then
arrives through the ordinary path described in
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md): page one is
merged over the resident rows, a whole-directory payload replaces them, and a
resident row page one cannot account for triggers the existing reconciling
refetch, which is what retires a seeded row for a work stream archived while
the device was away.

The ordering *is* on the row, and it did not move the version. Without it a cold
launch paints the manually arranged Space pills in the directory's serialization
order and reshuffles it a moment later — the visible flicker the seed exists to
prevent. Legacy Space- and Channel-container entries remain in the shape but are
ignored by the alphabetical Channel list and the Channel menu's Breakouts. A version 3 row written
before it existed has no `ordering` key, and `parse` reads that absence as an
empty arrangement: the natural order for one launch, corrected by the first
payload. Bumping to version 4 to avoid that would have dropped every cached row
and cost every person a cold, empty sidebar, which is the more expensive of the
two by a wide margin. The rule the slice is under is unchanged — the version
moves when the shape changes in a way `parse` *cannot* absorb.

That absorption is the one claim the decision rests on, so
`workspace-directory-cache.test.ts` writes a row at the slice's *own* version
with no `ordering` key and asserts it hydrates with an empty arrangement.
Written at version 3 rather than an older one deliberately: an older version
never reaches `parse` at all, so a test that used one would pass on the version
gate and prove nothing about the shape. Requiring the key makes it fail, which
is what somebody tightening `parseCachedDirectory` later needs it to do — the
alternative is every person on the branch getting a cold, empty sidebar on their
next launch with nothing failing.

For cached and live resolved state, see [merge-back](conversation-merge.md#resolution-and-archiving).

**Each listed Channel's breakout list is on the row too**, under `breakouts`,
keyed by Channel id and holding only the Channels the row keeps. A cold launch
seeds them into the `workstream-children` entries the Channel menu and the
Breakout ticks read, so a Channel's breakouts paint when its sidebar row does. They go in with no state
version and no waterline, so the first live row for each Channel replaces its
list whatever its numbers say, and a seed prunes nothing from the disk. A row
written before the key existed reads as no lists, which is how every Channel
waited before, for one launch; that absence has a correct reading, so the
version did not move. A single Channel's list this build cannot read is left
out alone, since it costs that Channel's menu its opening Breakouts and nothing else.

`spacesReady` is deliberately **not** on the row. It is the Organization's
current cutover state rather than something the device last saw, and a
remembered `true` would paint a hierarchy the next connect may contradict; the
surfaces read a missing answer as ready, which is the same thing a cached
`true` would have said and one fewer place for it to go stale. The row's
version went to **3** for the same reason in reverse: a version 2 row holds
Project directories and Channel rows written before `spaceIds` existed, and a
Channel in no Space is a state no surface is allowed to render.

**Version 4 is a Space's `reach`**, and it is the other half of the same rule.
A cached Space summary written before that field says nothing about *why this
person* can see the Space, and a device holds nothing to derive it from — so
`parse` has no reading to give it. Both absences it could be filled with are
visibly wrong where a reader can see the row: the full relationship draws a
plus, an **Add to space** entry and a drop target on a Space every write on
which the server refuses, and the narrow one takes those controls off every
Space on screen and puts them back a moment later.
[`spaces.md`](spaces.md#who-may-see-a-space-and-why) owns what the field means.

After the first live payload the provider mirrors those entries back to the
row: any change to any of them schedules one write, coalesced over
`LOCAL_CACHE_WRITE_COALESCE_MS`. Until that payload has landed the mirror
observes and writes nothing, so the seed never persists itself.

### What a Channel's menu shows before its conversation answers

The Channel sidebar and its `renderOpeningSidebar` paint were removed with the
shell redesign ([`desktop-shell.md`](desktop-shell.md)); no host passes either
any more. The record kept the name: a Channel's *rail* is now what its title-pill
menu reads while the conversation's snapshot is in flight (`useChannelRail` in
`screens/workstream.tsx`), and the menu's Breakouts come from the breakout list.
A rail is the Channel's people, its owned,
recommended and attached Sidekicks, and its Channel resources, which the
workspace socket sends with each Space's Channel rows ahead of need
(`lib/channel-rails.ts`; the protocol is in
[`realtime-sockets.md`](realtime-sockets.md)). Rails ride the `directory` row
under `rails`, read like `breakouts`, each kept at the `railWaterline` it was
answered at: a waterline and its data are committed together, so a live row at
the same waterline asks for nothing. Without a rail, the people and the
Sidekicks wait for the snapshot.

### What opening a conversation paints

`useWorkstreamSocket` reads the `conversation` row for `(parentId,
substreamId)` when its effect starts, alongside the ticket request, and writes
it into the detail, transcript, and initial-context entries only if all of them
are still empty when the read lands. Whatever is there already is newer than a
seed: a live snapshot that beat the read, or the optimistic opening turn a
launch surface wrote before navigating. The three writes and the seed marker
land in one notification batch, so the surface never renders a frame holding
the detail without the transcript.

The seed marker is the feed-source entry the surface already reads for
telemetry, set to `local_cache`. It is the one signal everything else keys on:

- `submitSubstreamCommand` in the socket hook rejects every room command,
  stop, retry, an elicitation answer, a queue reorder, with
  `workstream_feed_seeded` while the marker is set, beside its existing
  refusals for a revoked reader and a spent opening. The run, the elicitation,
  and the queue on screen are the seed's, and a command has nothing to address
  them against; the gate lives in the choke point so every control inherits
  it, rather than in each control.

- `canonicalCachesAvailable()` in the socket hook is false while the marker is
  set, so a seed never completes an opening. The opening deadline arms as it
  would over empty caches, the room is subscribed from sequence zero, and a
  socket that never answers still ends in the terminal failure after three
  attempts instead of being read as recovered from the seed.
- The first `snapshot` the room sends replaces the seed whatever its numbers
  say. Both ordinary fences are skipped for a seed: the transcript's
  `eventSequence`, which drops a snapshot older than the one on screen, and the
  resume registry's room sequence, which outlives the query entries and would
  otherwise hold a sequence from an earlier visit against the seeded one. The
  seed's numbers are what the room said some launches ago, and a room rebuilt
  since then can legitimately answer with lower ones. A seed is never merged with the snapshot
  either, for the reason the reconciliation merge is reserved for a still
  contiguous socket: nothing proves turns outside the opening ranges did not
  change while the device was away.
- The surface reads the marker as `feedFromLocalCache`. While it is set the
  transcript is on screen and readable, the card is up, the composer takes a
  draft but does not send, range loads and **Jump to latest** wait as they do
  for a reconnecting socket, and read acknowledgements are not sent, because a
  seed's waterlines could read past a mark made on another device since.

Once a live snapshot has installed the caches, the marker is `socket_snapshot`
and the hook's mirror starts persisting: every change to the three entries
schedules one coalesced write of the detail (with presence emptied, since
viewers are a live fact about other people's windows), the transcript trimmed
by `openingTranscriptSnapshot`, and the child's context. The mirror lives for
as long as the hook does, which for a pooled work stream is the pool's
retention, so the rows of warm and recently viewed work streams stay fresh
without anyone opening them.

The transcript is persisted in its opening shape, never with the pages the
reader scrolled into. The socket's first frame is an `initial` snapshot, which
replaces the transcript whole; a cached transcript that carried three hundred
paged turns would paint them and then collapse to the opening sixteen the
moment the live frame arrived. Keeping only the `unread` and `latest` ranges
makes the seed and its replacement the same shape, so in the common case the
swap is invisible and in every case it is never a collapse.

### The connecting card and the composer

`ConnectingCard` is one component with three states, and `ConnectingCardSlot`
is where it floats. Over a conversation the slot is zero-height and sticky at
the top of the transcript scroller, so the card floats over the first rows
without pushing them down and leaves no layout jump when it goes; over a
Space dashboard the slot is absolute, below the title bar's drag strip so the
card never takes a window's drag handle. The slot is the `polite` live region
and stays mounted whether or not a card is in it: a live region that mounts
with its text already present is generally not announced, only a change inside
one is. The card lets the pointer through to the rows under it; only its
**Retry** takes a click. It says `Connecting to <name>…` while the socket is dialling or
awaiting its snapshot, `Waiting for a connection to <name>…` while the desktop
is offline, and `Rally could not connect to <name>.` with the hook's opening
error and a **Retry** that restarts the opening sequence once the three
attempts are spent; the line saying what waits for the connection stays on the
failed card, since that is the moment someone tries to send. A work stream
Rally is still naming is `this work stream` rather than its placeholder
title. A Space's card follows the workspace
socket instead: it shows until the first subscribe answer has replaced the
seeded directory, since a Space has no socket of its own.

The composer over a seed is the ordinary composer with `sendBlocked`: typing,
mentions, attachments, the slash commands, and the draft all work, and the
draft survives into the live conversation. Sending is disabled, Enter is
swallowed the way it is for an empty draft so the sentence stays where it was
typed, and the card's second line says sending is available once Rally
connects: the capsule composer hides its footer hint, so the reason lives on
the card the eye is already on, and the send button's own label says it too,
for whoever reaches the button without seeing the card. The gate lifts when
the live snapshot lands, not when the socket opens: a message admitted against
a seed's transcript would position its optimistic row against a fence the room
has not confirmed. Branching a substream off a seed is gated the same way: the
launch surface carries the parent's card and `sendBlocked`, because a branch
persists the turn id it was taken from, which the room has not confirmed
either.

A Space painted from the seed is read-only until the directory is live.
Every Space edit sends the whole record back, so a rename made against the
seed would carry an icon, a colour, or an audience another client changed
since the row was written. The rename, the appearance picker, the audience,
the participants, archive and restore, and the resource and Sidekick defaults
are disabled while `directoryFromLocalCache` holds, the card's second line says
editing is available once Rally connects, and the Channel links and the **New
channel** plus still navigate.

### What the usage meter paints

Usage is a REST read, `GET /workspace/usage`, and it is fetched when a surface
that shows it opens: the Usage section of Settings → Organization, and the
Organization menu, whose usage line mounts with the menu's content. The
settings window is kept and reused, so a request for the Organization pane
while it is already mounted counts as an opening too. There is no polling; the
figure may lag by minutes as usage accrues and nothing gains from watching it.

A plan change is the one push: `applyPushedOrganizationUsage` writes the
`workspace_usage` meter into the query and the slice
([`usage-metering.md`](usage-metering.md)).

`useOrganizationUsage` reads the row when it mounts and shows it while the
request is in flight. The row is held beside the query rather than written
into it, so an answer already in memory from earlier in the session always
wins over the disk without a check. Each answer is written back whole, under
the epoch read before the request, so a sign-out during the request drops the
write. The PRD owns what each state shows.

### What leaves the cache

The bound on this cache is membership, not a number or an age:

- **The directory prunes parents.** A finished walk of every Space, or a live
  subscribe answer that carries the whole directory (one with no
  `nextCursor`), keeps the conversations whose
  parent is a row in it or an automation in its list, and removes the rest for
  that scope. Page one of a longer directory prunes nothing: it cannot tell a
  parent on a later page from one that is gone, which is the same reason the
  sidebar merges such a page rather than replacing its rows. On a paged
  workspace the disk follows evictions and the child rosters. The directory row itself holds one
  page of the flat list, `WORKSTREAM_PAGE_SIZE` rows, however many pages the
  sidebar has loaded, so the next launch paints what a fresh subscribe answer
  would carry and the live answer replaces it without a visible collapse.
- **The Channel row prunes children.** A Channel's row on the workspace socket
  names the private children this reader may still open; a cached child that
  left that roster is removed. The roster followed is the one the version guard
  accepted into the query cache, so a stale frame the cache rejects prunes
  nothing. The main conversation always stays.
- **Eviction forgets the disk.** `evictCachedWorkstream` removes every row
  under the parent in every scope, and `evictCachedSubstream` one child, so an
  access revocation or an archive never leaves a transcript on disk that the
  next launch would paint.
- **Sign-out and account replacement wipe everything**, and leaving or
  surrendering a workspace wipes its scope, in the same places the draft cache
  is wiped. A workspace that refuses the account when it tries to activate it
  wipes its scope too: a removal made while the client sat in another
  workspace reaches the device only there, since leaving and surrendering both
  need the workspace to be the active one. The store carries an epoch for the same race the drafts carry one
  for: a coalesced write scheduled before the wipe states the epoch its content
  belongs to and is dropped when the wipe has moved it on, so nothing in flight
  at sign-out restores what the wipe removed. Hydration reads the epoch before
  its row and seeds nothing if a wipe moved it meanwhile, so a row on its way
  off the disk never paints.

Nothing else evicts, and nothing expires.

## Invariants

- **Subscription state outlives its screens.** A retained socket also retains
  the values and version markers it supplies. Break this and a quiet socket can
  remain connected after its cache is collected: returning shows no children or
  transcript until a later push or reload supplies another snapshot.
- **Retention never overrides explicit eviction.** Removal releases the old
  entry and restores nothing; otherwise lost access could leave private state
  reachable. Recreated entries acquire a new hold, not the removed value.
- **A seed never completes an opening.** `canonicalCachesAvailable()` is false
  while the feed source is `local_cache`. Break it and a socket that never
  answers is read as recovered from the seed, the deadline stops counting
  attempts, and the card never reports the failure.
- **The first live snapshot replaces a seed whatever its numbers say, and is
  never merged with it.** Break either fence bypass, the transcript's or the
  resume registry's, and a room rebuilt since the row was written is dropped as
  older than the seed for the rest of the session.
- **A remembered Space is read-only until the directory is live.** Break it
  and a rename made under the card writes the seed's icon, colour, or audience
  over what another client changed while the device was away.
- **Only state the server delivered is persisted.** The conversation mirror
  writes only while the feed source is `socket_snapshot`; the directory mirror
  only after the first subscribe answer; the usage slice only a
  `GET /workspace/usage` answer or a `workspace_usage` push. Break it and a seed, or a launch surface's
  optimistic turn, becomes what the next launch paints, with no live frame
  having vouched for it.
- **A seeded breakout list holds no version.** Break it and the first live
  row for a Channel, numbered below what the device remembered from a room
  rebuilt since, is dropped, and the Channel menu shows breakouts that are gone.
- **Hydration lands only in empty caches.** Break it and a read that lands
  after the live snapshot puts the older state back over it.
- **A seed moves no ledger.** The waterline ledgers stay untouched by
  hydration. Break it and the socket's first payload is dropped as not newer
  than the seed.
- **The persisted transcript holds no `requested` range.** Break it and the
  live snapshot collapses a long painted history to the opening window.
- **Sending, room commands, range loads, read acknowledgements, and the
  search jump wait for the live feed.** Each reads against the room's fence,
  and a seed has none. Break it and a message, a stop, or an answer is
  positioned against turns the room may have moved, and the person is told it
  landed in a conversation whose live state they had not seen.
- **Every write states its epoch, and every hydration checks it.** A write
  from before a wipe is dropped; a row read before a wipe is not seeded. Break
  either and a sign-out leaves the previous account's transcript on the disk,
  or on the next account's screen.
- **Eviction reaches the disk.** A memory-only eviction leaves a transcript the
  reader was shut out of on the device.
- **No provider, no cache.** Outside a `LocalCacheScopeProvider` every consumer
  behaves as before the cache existed, which is what keeps every standalone
  screen test and embedding on the old path.
- **Every row is written under its account and workspace scope.** A row
  written under another key cannot be removed when that membership ends, and a
  row written without the account would be readable by the next account on
  the device before the wipe reached it.

## Boundary

This module owns producer-held in-memory query retention, the on-device store,
its slices, the mirrors, the seed marker
and everything that keys on it, the connecting card, and the composer's send
gate. It does not own:

| For | Read |
| --- | --- |
| The draft the composer keeps, a different database with a different lifetime on the same `createIndexedDbStore` | [`composer-drafts.md`](composer-drafts.md) |
| Which channel carries what, and the waterline ledgers a seed must not touch | [`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) |
| The socket pool, retention, and the pair a work stream opens | [`websocket-architecture.md`](websocket-architecture.md) |
| Ticket admission and what the first frame carries | [`realtime-sockets.md`](realtime-sockets.md) |
| The feed, the composer, and the surface the card sits in | [`conversation-surfaces.md`](conversation-surfaces.md) |
| What the `local_cache` feed source means to the open-latency events | [`telemetry.md`](telemetry.md) |
| What may be written under `userData` at all | [`security.md`](security.md) |

The cache starts where the workspace tree does. A cold launch first restores
the session and fetches the workspace profile over REST, and both are gates
above the providers this module hangs from; with the region unreachable the
client still stops at its service screen, and nothing here changes that. What
the cache removes is the socket's share of an open: the ticket, the handshake,
the subscribe, and the first snapshot, on a client that already has a session.

The draft cache and this one are deliberately two databases. A draft is the
reader's own unsent words, expiring after twelve hours and released with the
server-side draft resource; a cached transcript is the room's words, bounded by
membership and replaced by the next frame. They share the same helpers in
shape and share the store beneath them; they do not share rows, keys, or
lifetimes.

## Failure modes and limits

- **No IndexedDB, no quota, a corrupt database:** every read answers null and
  every write reports false. Screens wait for the socket as they did before.
- **A row for a work stream archived or revoked while the device was away:**
  the sidebar seed lists it and, if it is opened, its transcript paints. The
  live directory then retires the row, the ticket request answers 404 and the
  hook keeps retrying with backoff, and the opening deadline reports the
  failure on the card after its three attempts. Opening a room the reader can
  no longer see never gets further than the transcript it had already been
  shown before.
- **A room rebuilt with lower sequence numbers:** the seed is replaced, because
  both fences are skipped for a seed, the resume registry's included.
- **A workspace the account is removed from while the client sits in another
  one** keeps its rows until the account next tries to open it and is refused,
  or signs out. Membership is the bound as this device can observe it; the
  device is not told about a removal it did not witness.
- **A reader shut out while a hydration is in flight:** the read that lands
  after the revocation seeds nothing, because the hook's `stillWanted` reads
  `accessRevoked` as well as its own teardown.
- **The seed's run state and unread marks are stale until the snapshot lands.**
  A work stream that was running when the row was written paints as running
  for the second or two the socket takes. The card is what says so.
- **A quit inside the coalescing window** loses at most that window of changes;
  the previous row stands.
- **A socket answering with `resync_required` before its snapshot:** the
  ordinary recovery path applies; the seed stays on screen until the fresh
  admitted socket installs its baseline.
- **Disk:** one directory row per workspace, and one row per conversation the
  directory and the child rosters still list, each holding the opening ranges
  rather than the whole transcript. There is no count and no age; membership is
  the bound, and a workspace's rows go with its membership.
- **Fake timers in a test stall the fake IndexedDB**, which schedules its work
  on `setImmediate` at call time. See [Testing](#testing).

## Testing

`retain-query-data.test.ts` exercises actual React Query collection with a fake
clock: existing and future entries, multiple owners, no fetching, release,
explicit removal, replacement and whole-cache clearing. The conversation-socket
and workspace-socket suites keep their real receivers and
cache, double transport and time, and verify ten minutes without a screen or
new snapshot followed by release. The control case also checks that a stale
roster cannot overwrite the retained one. Real Electron acceptance creates a
child, navigates away and back, and repeats after the ordinary collection window.

`fake-indexeddb` backs the renderer's jsdom environment (`test/setup.ts`), the
same way it backs the draft cache. Two traps, both already paid for once:

- **`fake-indexeddb` schedules on the global `setImmediate` at call time**, so
  `vi.useFakeTimers()` stalls every read and write until fake time is advanced,
  and a plain `await` on the store hangs to the test timeout. Drive a mirror
  through `flush()` under real timers rather than advancing the coalescing
  window, and where a test genuinely needs the hook's deadline faked, fake only
  `setTimeout`, `clearTimeout`, and `Date` so the store keeps its real
  scheduler.
- **An eviction under fake timers leaves the store holding a database open
  that never settles**, because `evictCachedWorkstream` forgets the disk and
  the open landed on the fake clock that was then discarded. A later test in
  the same worker that uses the cache would hang on that open, so the
  renderer's test setup calls `closeLocalCache()` after every test; no file
  has to know.

The suites are `components/organization-usage.test.tsx` (the `usage` slice: cached paint, the offline label, the write-back; the plan-change push and the reread on subscribe are in `lib/workspace-socket.test.tsx`),
`lib/local-cache.test.ts`, `lib/local-cache-mirror.test.ts`,
`lib/conversation-cache.test.ts`, `lib/workspace-directory-cache.test.ts`,
`components/connecting-card.test.tsx`, the `openingTranscriptSnapshot` cases in
`lib/transcript.test.ts`, and the local-cache blocks appended to
`lib/use-workstream-socket.test.tsx`, `lib/workspace-socket.test.tsx`,
`screens/workstream-open.test.tsx`,
`screens/space-dashboard.test.tsx`, and
`components/workstream-composer.test.tsx`. Run one with
`pnpm --filter @rally/desktop exec vitest run src/renderer/lib/conversation-cache.test.ts`.

The hook tests were proved able to fail the way the invariants say: skipping
the fence bypass leaves the seed's title on screen after the live snapshot;
letting a seed complete the opening stops the deadline counting attempts, so
the terminal failure never arrives; dropping the directory's pruning leaves the
forgotten conversation on disk; and removing the send gate lets the composer
send over a seed.

## Security and trust model

The cache is workspace content stored **unencrypted** in the renderer's
IndexedDB under Electron's `userData` directory, beside the draft cache: the
last first page of the sidebar and, for every conversation the directory still
lists that the reader opened or the pool warmed, its detail and opening
transcript ranges. No credential is ever written there. It is bounded by
membership rather than time: a row exists while its parent is listed and this
reader may still open it, the live directory and child rosters retire rows the
device missed, eviction on revocation removes them at once, leaving a workspace
removes that workspace's rows, and signing out or another account taking over
the device removes all of them. [`security.md`](security.md) owns the boundary
this sits inside.

## Performance and cost

A launch pays one IndexedDB read for the directory and one per conversation
the pool mounts, a dozen or so, each deserializing a detail and an opening
window of turns; the socket hooks would have painted nothing until their
snapshots either way, so the reads sit on time that was idle. Writes are
coalesced to one per conversation per `LOCAL_CACHE_WRITE_COALESCE_MS` at most,
however many frames a run delivers, and a structured clone of an opening window
is small. The cost that would grow is the persisted transcript, and
`openingTranscriptSnapshot` is what keeps it from growing with a reader's
scrolling.

## Changelog

### 2026-10-19 — Restore sidebar pins with their rows

**What changed:** The directory seed and mirror include current pins, artifact
pins, Channel stats and the first My Threads page.

**Why:** Startup restored the directories but not the redesigned sidebar's
pin lists. The live snapshot then looked like a new pin action, sliding saved
pins into place after the rest of the sidebar appeared.

**Considered and rejected:** Disabling list motion or waiting for the network
before drawing the sidebar. Neither repairs the incomplete startup seed.

**Consequences:** Navigation restores in the directory's batch, without moving
socket waterlines or replacing an answer that arrived first. A live directory
does not block restoration of the missing REST thread page. Older cache rows
still load; they acquire navigation after the next live session.

### 2026-10-03 — A guest's rows live apart from a member's

**What changed:** `localCacheScope` takes the access class and suffixes a
guest's scope with `:guest`. `clearWorkspaceLocalCache` deletes both ranges.

**Why:** Guests and members now mount the same shell over the same cache, in
the browser and the Mac app. A member demoted to guest keeps the account and
the workspace, so under one scope the guest view would hydrate transcripts the
person cached as a member, including Channels no longer shared with them,
before any socket said otherwise. Reported in review of #1089.

**Considered and rejected:** Wiping the member rows when the access class
changes. That needs an observer of the transition on both hosts and still
races a hydration that starts first; a separate scope cannot be read at all.

**Consequences:** A promotion back to member starts from the member rows the
device still holds, which that person may read again. Anything that builds a
scope by hand instead of through `localCacheScope` must pass the access class.

### 2026-10-03 — Usage is the first slice without a socket (#1086)

**What changed:** A `usage` slice holds the last `GET /workspace/usage` answer
per Organization, with the time it arrived.

**Why:** The usage quota PRD asks for the cached value right away and a
background refresh when either surface opens; without a row an offline reader
sees nothing.

**Considered and rejected:** Seeding the query cache from the row, the way the
directory and conversation slices do. Those need it because socket hooks read
the query entries; usage has one reader, so keeping the seed beside the query
gives "an answer in memory wins" for free and leaves no seed to fence.
Reusing `mirrorQueriesToLocalCache`: one write per answer needs no coalescing.

**Consequences:** The row is bounded like every other row, by membership and
sign-out wipes, and holds no dollar amount the response does not already
carry. A shape change the schema cannot parse drops the row on read; bump the
slice version only when the schema can no longer absorb an old row.

### 2026-09-27 — The Channel rail paints without waiting for the conversation

**What changed:** The `directory` row gained `breakouts` and `rails`, each kept
Channel's breakout list and rail, seeded on a cold launch. And the Channel rail
is drawn from them while its conversation's first snapshot is in flight,
instead of as three placeholder rows beside the feed's own placeholders.

**Why:** Spaces and Channels painted at once and breakouts did not, which read
as breakouts being slow. The list had already moved onto the workspace socket,
so the delay was two gaps around it. The rail was gated on the conversation
detail from the feed socket, though nothing it lists comes from there. And the
list lived only in memory, so a cold launch had nothing to paint until the
socket's first answer.

**Considered and rejected:** Waiting for the detail but showing the cached list
inside the placeholder rail. That still drew a second rail and swapped it, for
no data the first one lacked. Bumping the slice version for the new key: an
absent list has a correct reading, "wait as before", so the bump would have
cost every device a cold sidebar to avoid one launch of old behavior.

**Consequences:** Anything added to the rail must have an opening source,
the Channel's rail or the directory, or a pending state of its own until the
conversation detail arrives; controls that need the detail stay disabled
until then. A seeded list must stay
unversioned, or a room rebuilt with lower numbers is refused for the session.

### 2026-09-19 — The directory slice goes to version 4 for a field it cannot absorb

**What changed:** `SpaceSummary` gained `reach` — why *this person* can see a
Space — and the `directory` slice went from 3 to 4, dropping every cached row
once.

**Why:** It is the same rule the `ordering` key was measured against, reaching
the opposite answer, and having both is what makes the rule readable. An
absent `ordering` has a correct reading: this person has arranged nothing, and
one launch is drawn in the natural order. An absent `reach` has none — the
field is about the viewer's relationship to a Space and nothing on the device
knows it — and both values it could be filled with are wrong in a way somebody
sees: one draws controls the server refuses, the other takes the controls off
every Space and puts them back. The cost is one cold launch per device.

**Consequences:** The cache test that pins the `ordering` absorption now writes
at version 4, because a row at an older version never reaches `parse` at all
and would pass on the version gate while proving nothing. The next person to
add a key to this row has to say which of the two it is.

### 2026-09-19 — The remembered directory carries the arrangement, without a version bump

**What changed:** The `directory` row gained `ordering`: every list this person
has arranged by hand — the Organization's Spaces, each Space's Channels, each
Channel's Breakouts — seeded into `['personal-order']` alongside the other four
entries and mirrored back with them. The slice stayed at version 3, and `parse`
reads a row written without the field as an empty arrangement.

**Why:** A seed exists to stop the first frame being wrong. Without the
arrangement it *is* wrong for everybody who has dragged anything: the sidebar
paints the natural order, the socket answers a moment later, and the lists
visibly reshuffle under the one reader who cared enough about their order to
set it. Leaving it off the row would have made the seed worse than useless for
exactly the people this feature is for.

**Considered and rejected:** Bumping the slice to version 4, which is the reflex
when a persisted shape changes. It would drop every cached row on every device
to avoid one launch drawn in the natural order — a cold, empty sidebar for
everyone, to prevent a flicker for some. The slice's rule already says the
version moves when the shape changes in a way `parse` cannot absorb, and an
absent optional field is the case `parse` absorbs.

**Consequences:** A row written before this reads as "nothing arranged", which
is indistinguishable from a person who has arranged nothing — and correct for
both, because the first payload replaces it either way. Anything later that adds
a *required* field to this row, or changes the meaning of one already on it,
still has to bump: absorbing an absence is not a precedent for absorbing a
change.

### 2026-09-19 — The directory slice goes to version 3, and the cutover flag stays off it

**What changed:** The `directory` slice's version went from 2 to 3, its two
Project directories became the active and archived Space directories, and every
cached Channel row now carries `spaceIds`. `spacesReady` travels beside the
directories on the wire and on the snapshot, and is deliberately not persisted
on the row.

**Why:** A version 2 row holds Project directories and Channel rows written
before `spaceIds` existed. Every Space surface reads the placement off the row
— the sidebar's placements, the dashboard's list — and a Channel in no Space is
a state the PRD says no surface may render, so a version 2 row seeds a
hierarchy that cannot be drawn truthfully. `spacesReady` is the Organization's
*current* cutover state rather than something the device last saw: a remembered
`true` would paint the hierarchy on a launch the next connect contradicts, and
the surfaces already read a missing answer as ready, which is what a cached
`true` would have said anyway.

**Considered and rejected:** Migrating a version 2 row by reading its Project
directories into Space ones and defaulting every Channel's `spaceIds` to
General's id. The device cannot know General's id before the socket answers,
and the cutover is the server's to perform — a client that invented a placement
would seed a membership the Organization may not have made, which is the one
thing the opening state exists to prevent.

**Consequences:** Every device that had a version 2 row opens cold exactly
once: skeletons in the sidebar, no landing resolution, and the Space dashboard
waiting for the socket, after which the version 3 row is written and the next
launch paints from it. The flag not being on the row means a cold launch always
starts ready and corrects itself on the first payload, rather than starting in
the opening state.

### 2026-09-15 — Live socket owners retain the state they supply

**What changed:** All three socket owners hold the query entries they supply
until their effects end, through one shared retention primitive. Holds follow
replacement entries and yield immediately to explicit removal.

**Why:** A work stream's private-child list was observed only by its screen,
while the socket pool could keep its control socket connected indefinitely.
Five minutes off screen collected the list without disconnecting its producer;
returning sent no subscribe and left the sidebar empty until another metadata
push or Reload. The same ownership mismatch existed for background transcripts,
workspace lists and their version markers.

**Considered and rejected:** A longer or infinite child-list TTL only changes
when the ownership mismatch surfaces or keeps every visited room forever.
Refetching on every navigation duplicates a snapshot already supplied by a live
subscription. Retention belongs to the producer, so the shared mechanism applies
to each socket family rather than adding a special case to the child sidebar.

**Consequences:** Warm subscriptions retain their product state as well as their
transport. The warm set has no ceiling on pinned or running work streams, so
those streams retain their full loaded transcript range and inherited context
until the owner releases them. The persisted snapshot's range bound does not
bound this in-memory state. Releasing the owner restores ordinary collection; access revocation,
sign-out and snapshot-context removal still remove entries immediately. Adding
a socket-owned entry requires adding it to that owner's retained family.

PR: [#775](https://github.com/juno-ai-labs/avalon/pull/775).

### 2026-09-10 — A space, a stream, and a substream open from what the device last saw

**What changed:** The desktop keeps a local cache. The workspace directory and
every conversation the reader opened or the pool warmed are written to
IndexedDB from the query cache after each live socket frame, and read back
into it, marked as a seed, before the next socket answers. A floating card
names the room the live connection is being made to and, over a conversation,
says that sending waits for it, and the composer accepts a draft but does not
send until the live snapshot has replaced the seed. Review of the change added
the account to every row's scope, made hydration refuse a row a wipe overtook,
let a seed skip the resume registry's fence as well as the transcript's,
bounded the directory row to one page, made a remembered project read-only
until its directory is live, followed the accepted child roster when pruning,
and gave the seed marker precedence in the open-latency event. A second round
kept live turns in the persisted row, gated every room command and the
substream launch on the seed, pruned parents only from a whole directory,
refused a hydration a revocation overtook, wiped a workspace that refuses the
account, validated the cached detail with a schema, let the card pass the
pointer through and keep its live region mounted, and moved the IndexedDB
plumbing both caches had been carrying into `createIndexedDbStore`.

**Why:** Opening a work stream, a substream, or a project on a cold client
showed a spinner until the socket ticket, the handshake, the subscribe, and
the first snapshot had all returned, a second or two on a good connection and
indefinitely on a bad one. Everything that screen was about to show had been
on this device the last time it was open. The product asks for the feeling
that the data was already there; a seed the socket then corrects is what that
costs.

**Considered and rejected:** Persisting the whole React Query cache with the
library's own persister. It would carry every query, including ones that must
not paint stale (presence, tickets, the ledgers a seed must not move), and
would give no place to say which entries are seeds. Keeping the seed's paged
history and merging the live snapshot into it, as a reconciliation does. The
room reserves that merge for a still contiguous socket because nothing proves
turns outside the opening ranges did not change while the device was away, so
the seed is trimmed to the opening shape instead. A time-to-live or a row count
as the bound. Neither is a decision this design needs: membership is the bound
that follows from what the cache is, and it is not a number anyone has to
guess. Letting the composer send over a seed with the existing queue-and-resend
semantics. The optimistic row would be positioned against a fence the room had
not confirmed, and the person would be told a message was sent into a
conversation whose live state they had not seen. Gating the workspace tree on
the account-change wipe instead of scoping rows by account. The wipe stays as
the privacy measure; the scope is what makes the order of a wipe and a
hydration irrelevant, and it is the same rule the draft cache keys by. Patching
only the edited field of a project instead of keeping a seeded project
read-only. That moves the fix into the API for every field a project has;
disabling the edits for the second or two the directory takes is the cheaper
thing to reverse. Validating the cached detail through the contracts' wire
schema. The query cache holds the renderer's mapped detail, not the wire
shape, so the row is validated by a schema of the fields the seeded screens
read, nested items included, and `version` covers what that schema cannot
tell apart. A `live` range purpose for turns the socket appends, which would
have told them from paged history in the contract; the ceiling of the opening
ranges tells them apart without one. SQLite for the store. The
renderer is sandboxed with no Node integration, so SQLite would live in the
main process behind a new IPC surface, as a native module or `node:sqlite`,
and every read, write, and wipe would cross it; the cache's access pattern is
get by key, range by prefix, and delete by subject, which IndexedDB's compound
keys and ranges cover in-process, in the store shape the draft cache already
keeps. Reading inside cached content, such as offline search across
transcripts, is what would reopen that question.

**Consequences:** Every writer of the detail, transcript, and context entries
is now also a writer of the disk, through the mirror; a new canonical field
persists without anyone adding it, and a field that must not persist has to be
stripped in the mirror's snapshot the way presence is. The feed-source entry
carries a third value, `local_cache`, which the open-latency telemetry reports
and which every path that reads against the room's fence has to treat as not
live. A future surface that should paint before its socket answers defines a
slice and hydrates and mirrors through it; it does not touch the store. A new
project mutation reads `directoryFromLocalCache` the way the existing ones do,
and a new room command inherits the seed gate from `submitSubstreamCommand`
without naming it. The draft cache and this cache remain two databases with
two lifetimes on one store.
