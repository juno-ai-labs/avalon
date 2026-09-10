# Local cache

Opening a space, a stream, or a substream paints from what the device last saw
before the socket that owns it answers. The desktop keeps one IndexedDB
database, `rally-local-cache`, holding the last first page of the workspace
directory and the last canonical state of every conversation the reader opened
or the socket pool warmed. On the next launch, or the next open of a room whose
socket is still cold, the sidebar, the project space, and the transcript are on
screen immediately; a small floating card says the live connection is on its
way, and the composer accepts a draft but does not send until it has arrived.

Nothing in the cache is authoritative. A cached value is a *seed*: it paints,
and that is all it does. The socket's first frame replaces it whatever its
version numbers say, it never completes an opening, it never fences a snapshot,
and it is never written back. Read this before changing what a screen paints
before its socket answers, adding a surface that should, or touching the
socket hooks' first frame.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/local-cache.ts` | The `rally-local-cache` IndexedDB store: rows keyed by `[scope, kind, key]`, the version stamp, the epoch, `defineLocalCacheSlice`, `clearAllLocalCache`, `clearWorkspaceLocalCache`. The only file that touches IndexedDB. |
| `apps/desktop/src/renderer/lib/local-cache-mirror.ts` | `mirrorQueriesToLocalCache`: keep a slice equal to a family of query-cache entries, coalescing a burst of writes into one; `LOCAL_CACHE_WRITE_COALESCE_MS`. |
| `apps/desktop/src/renderer/lib/local-cache-scope.tsx` | `LocalCacheScopeProvider` and `useLocalCacheScope`: the regional workspace every row below it belongs to. No provider, no cache. |
| `apps/desktop/src/renderer/lib/conversation-cache.ts` | The `conversation` slice: one row per `(parent, substream)`, `hydrateConversation`, `mirrorConversation`, the seed marker, and the pruning and forgetting entry points. |
| `apps/desktop/src/renderer/lib/workspace-directory-cache.ts` | The `directory` slice: one row per workspace holding the work-stream list, the automation and note lists, and both project directories; `hydrateWorkspaceDirectory`, `mirrorWorkspaceDirectory`. |
| `apps/desktop/src/renderer/lib/transcript.ts` (`openingTranscriptSnapshot`) | The shape a transcript is persisted in: its opening ranges only. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Hydrates a conversation at effect start, mirrors it while mounted, and treats a seed as neither a completed opening nor a snapshot fence. |
| `apps/desktop/src/renderer/lib/use-workstream-control-socket.ts` | Prunes cached children that left the parent's private-child roster. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Hydrates the directory before connecting, mirrors it after the first subscribe answer, and prunes conversations whose parent that answer no longer lists. |
| `apps/desktop/src/renderer/lib/workstreams-cache.ts` | `evictCachedWorkstream` and `evictCachedSubstream` forget the disk along with the memory. |
| `apps/desktop/src/renderer/lib/app-session.tsx` | Wipes the whole cache when the account leaves the device and one workspace's rows when that membership ends, beside the draft cache's wipes. |
| `apps/desktop/src/renderer/App.tsx` | Mounts the scope provider above the workspace socket provider. |
| `apps/desktop/src/renderer/components/connecting-card.tsx` | The floating card: connecting, waiting for a connection, or failed with a retry. |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | Reads the seed marker: shows the card, gates sending, and holds range loads and read acknowledgements until the feed is live. |
| `apps/desktop/src/renderer/screens/project-space.tsx` | Shows the card over a project painted from the seeded directory. |
| `apps/desktop/src/renderer/components/workstream-composer.tsx` | `sendBlocked`: everything but sending. |

## How it works

### The store and its slices

The store is one object store of rows `{ scope, kind, key, subject, version,
updatedAt, value }` with a compound primary key of `[scope, kind, key]`. A
*scope* is the account's user id followed by
`desktopWorkspaceIdentityKey(region, workspaceId)`, so one account's rows for
one workspace are one key range, leaving that workspace deletes exactly them,
and two accounts on one device that share a workspace never read each other's
rows, whatever order a wipe and a hydration run in. A *kind* names the slice
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

Two slices exist today, and the third surface that wants to paint before its
socket answers defines a third:

| Slice | Key | Subject | Holds |
| --- | --- | --- | --- |
| `directory` | `directory` | `directory` | The work-stream list as the sidebar holds it, the automation list, the note list, and the active and archived project directories. |
| `conversation` | `<parentId>:<substreamId>` | `<parentId>` | The `WorkstreamDetail` the header and composer read, the transcript trimmed to its opening ranges, and a private child's inherited context. |

The store is best-effort by construction, like the draft cache beside it: every
operation resolves to its fallback rather than throwing. A renderer with no
IndexedDB, no quota, or a corrupt database opens every screen the way it did
before the cache existed, waiting for the socket.

### What opening a workspace paints

`WorkspaceSocketProvider` reads the `directory` row for its scope before it
dials. If the work-stream list is still empty, the cached lists go straight
into the query-cache entries the sidebar, the landing route, and the project
space read: `['workstreams']` through `setCachedWorkstreams`, `['automations']`,
`['notes']`, `['projects']`, and `['projects-inactive']`. They go in directly,
not through the versioned receivers, because a seed has no waterline and must
not move a ledger; the ledgers stay at their empty state, which is what lets
the socket's first subscribe answer apply over the seed whatever version it
carries. The directory is seeded as a unit or not at all: the first live
payload writes every list at once, so one of them being present means all of
them are newer than the row.

With the lists present, the sidebar draws rows instead of skeletons, the
landing route resolves to the first work stream without waiting, and a project
space renders its header and members. The subscribe answer then arrives through
the ordinary path described in
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md): page one is
merged over the resident rows, a whole-directory payload replaces them, and a
resident row page one cannot account for triggers the existing reconciling
refetch, which is what retires a seeded row for a work stream archived while
the device was away.

After the first live payload the provider mirrors the five entries back to the
row: any change to any of them schedules one write, coalesced over
`LOCAL_CACHE_WRITE_COALESCE_MS`. Until that payload has landed the mirror
observes and writes nothing, so the seed never persists itself.

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

`ConnectingCard` is one component with three states. Over a conversation it
sits in a zero-height sticky slot at the top of the transcript scroller, so it
floats over the first rows without pushing them down and leaves no layout jump
when it goes; over a project space the slot is absolute at the top of the
screen. It says `Connecting to <name>…` while the socket is dialling or
awaiting its snapshot, `Waiting for a connection to <name>…` while the desktop
is offline, and `Rally could not connect to <name>.` with the hook's opening
error and a **Retry** that restarts the opening sequence once the three
attempts are spent. A work stream Rally is still naming is `this work stream`
rather than its placeholder title. A project's card follows the workspace
socket instead: it shows until the first subscribe answer has replaced the
seeded directory, since a project has no socket of its own.

The composer over a seed is the ordinary composer with `sendBlocked`: typing,
mentions, attachments, the slash commands, and the draft all work, and the
draft survives into the live conversation. Sending is disabled, Enter is
swallowed the way it is for an empty draft so the sentence stays where it was
typed, and the card's second line says sending is available once Rally
connects: the capsule composer hides its footer hint, so the reason lives on
the card the eye is already on. The
gate lifts when the live snapshot lands, not when the socket opens: a message
admitted against a seed's transcript would position its optimistic row against
a fence the room has not confirmed.

A project painted from the seed is read-only until the directory is live.
Every project edit sends the whole record back, so a rename made against the
seed would carry an icon, a colour, or an audience another client changed
since the row was written. The rename, the appearance picker, the audience,
the participants, archive and restore, and the default resources are disabled
while `directoryFromLocalCache` holds, the card's second line says editing is
available once Rally connects, and the work stream links and the **New work
stream** plus still navigate.

### What leaves the cache

The bound on this cache is membership, not a number or an age:

- **The directory prunes parents.** Every live subscribe answer keeps the
  conversations whose parent is a row in the page it carries or an automation
  in its list, and removes the rest for that scope. Page one is the whole of
  what the payload can vouch for, so a conversation opened from a later page is
  forgotten and re-cached on its next open. The directory row itself holds one
  page of the flat list, `WORKSTREAM_PAGE_SIZE` rows, however many pages the
  sidebar has loaded, so the next launch paints what a fresh subscribe answer
  would carry and the live answer replaces it without a visible collapse.
- **The control socket prunes children.** A work stream's metadata frame names
  the private children this reader may still open; a cached child that left
  that roster is removed. The roster followed is the one the version guard
  accepted into the query cache, so a stale frame the cache rejects prunes
  nothing. The main conversation always stays.
- **Eviction forgets the disk.** `evictCachedWorkstream` removes every row
  under the parent in every scope, and `evictCachedSubstream` one child, so an
  access revocation or an archive never leaves a transcript on disk that the
  next launch would paint.
- **Sign-out and account replacement wipe everything**, and leaving or
  surrendering a workspace wipes its scope, in the same places the draft cache
  is wiped. The store carries an epoch for the same race the drafts carry one
  for: a coalesced write scheduled before the wipe states the epoch its content
  belongs to and is dropped when the wipe has moved it on, so nothing in flight
  at sign-out restores what the wipe removed. Hydration reads the epoch before
  its row and seeds nothing if a wipe moved it meanwhile, so a row on its way
  off the disk never paints.

Nothing else evicts, and nothing expires.

## Invariants

- **A seed never completes an opening.** `canonicalCachesAvailable()` is false
  while the feed source is `local_cache`. Break it and a socket that never
  answers is read as recovered from the seed, the deadline stops counting
  attempts, and the card never reports the failure.
- **The first live snapshot replaces a seed whatever its numbers say, and is
  never merged with it.** Break either fence bypass, the transcript's or the
  resume registry's, and a room rebuilt since the row was written is dropped as
  older than the seed for the rest of the session.
- **A remembered project is read-only until the directory is live.** Break it
  and a rename made under the card writes the seed's icon, colour, or audience
  over what another client changed while the device was away.
- **Only socket-delivered state is persisted.** The conversation mirror writes
  only while the feed source is `socket_snapshot`; the directory mirror only
  after the first subscribe answer. Break it and a seed, or a launch surface's
  optimistic turn, becomes what the next launch paints, with no live frame
  having vouched for it.
- **Hydration lands only in empty caches.** Break it and a read that lands
  after the live snapshot puts the older state back over it.
- **A seed moves no ledger.** The waterline ledgers stay untouched by
  hydration. Break it and the socket's first payload is dropped as not newer
  than the seed.
- **The persisted transcript holds no `requested` range.** Break it and the
  live snapshot collapses a long painted history to the opening window.
- **Sending, range loads, read acknowledgements, and the search jump wait for
  the live feed.** Each reads against the room's fence, and a seed has none.
- **Every write states its epoch.** A write from before a wipe is dropped.
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

This module owns the on-device store, its slices, the mirrors, the seed marker
and everything that keys on it, the connecting card, and the composer's send
gate. It does not own:

| For | Read |
| --- | --- |
| The draft the composer keeps, which is a different database with a different lifetime | [`composer-drafts.md`](composer-drafts.md) |
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
shape and could share a module; they do not share rows, keys, or lifetimes.

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
  the same file that uses the cache hangs on that open. `closeLocalCache()`
  before such a test drops the connection so the next use reopens it; the
  socket suites do this in the `beforeEach` of their local-cache blocks.

The suites are `lib/local-cache.test.ts`, `lib/local-cache-mirror.test.ts`,
`lib/conversation-cache.test.ts`, `lib/workspace-directory-cache.test.ts`,
`components/connecting-card.test.tsx`, the `openingTranscriptSnapshot` cases in
`lib/transcript.test.ts`, and the local-cache blocks appended to
`lib/use-workstream-socket.test.tsx`, `lib/workspace-socket.test.tsx`,
`lib/use-workstream-control-socket.test.tsx`, `screens/workstream-open.test.tsx`,
`screens/project-space-screen.test.tsx`, and
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
and gave the seed marker precedence in the open-latency event.

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
thing to reverse. SQLite for the store. The
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
project mutation reads `directoryFromLocalCache` the way the existing ones do.
The draft cache and this cache remain two databases with two lifetimes.
