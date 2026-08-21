# Choosing between the socket and REST

The Electron client talks to its regional Worker two ways: a **WebSocket** into
the Durable Object that owns the state, and an **HTTP request** to the Hono
Worker. This document says which one carries what, and it is deliberately
opinionated, because the two are interchangeable often enough that the choice
otherwise gets made by whichever one the last person happened to write.

**The rule in one line: data comes down the socket, changes go up over REST.**
The socket is not a change-notification channel that the client answers with a
fetch. It carries the data itself, and it carries it **before the client asks**
— by the time a socket is open the server already knows, from the ticket that
opened it, who connected and which workspace they are looking at, and it knows
what the first screen of that workspace needs. Anything the client would have
requested first is something the server should already be sending.

The product reason is the whole reason: Avalon should feel like the data was
already there. A screen that renders from a payload that arrived unasked is
instant; a screen that mounts, discovers it needs four things, asks for them,
and reflows as each lands is a web page. Read this before adding an endpoint, a
streamed event, or a client query.

Every section states the principle first and ends with a **do and don't**
distillation. The principles are meant to survive this codebase: they apply to a
stream nobody has built yet, and Avalon's current mechanisms appear as worked
examples of them rather than as the rule itself. Where a section describes what
the code does today, it says so.

The mechanics of each channel live elsewhere and are not restated here: how a
socket is admitted is [`realtime-sockets.md`](realtime-sockets.md), what each
object owns and publishes is
[`workstream-durable-object.md`](workstream-durable-object.md), and the request
path is [`architecture.md`](architecture.md). This document is the rule sheet
for choosing between them, in the same genre as
[`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md), and like it carries no
changelog.

## Why data comes down the socket

**The server already knows who is asking.** The socket ticket binds a user, a
workspace, a region, and a session before the handshake completes. A `GET` that
follows it is a client spending a round trip to tell the server something the
server just proved. That is the cost of a question whose answer was already
determined.

**The state is already in the authority that holds the socket.** In Avalon that
is WorkspaceDO, which owns the work-stream directory, the suggestion tables
(`work_opportunities`, `suggested_work_sets`), automations, notes, resources,
and connector connections in its own SQLite. The general form of the argument
matters more than the example: when the process holding the connection is also
the process holding the rows, a REST read of those rows is a second entry into
the same place, through another hop, with a fresh authorization pass — to
produce bytes that could have been written to a connection already open.

**One channel is one order.** Two channels means two orders, and the interesting
bugs live in the gap: a refetch triggered by an invalidation that overtakes a
push, a screen patched by a socket event and then reverted by a slower response,
a cache entry written by two producers with different shapes. When the same
authority sends the same shape down one ordered channel carrying its own
version, the client's rule is a comparison, not a reconciliation.

**Changing data is the common case, not the exception.** A work stream's title
lands when the model names it; a run's state moves several times a minute;
unread counts, attention state, and suggestions all move while nobody touches
the keyboard. Anything that changes while a window is open has to arrive over
the socket eventually — so serving its first value over REST means writing and
maintaining two paths to the same field, with the REST one used exactly once per
mount.

**Prefer the failure you will notice.** A push that never arrives is a stale
screen the person using it reports. A refetch storm is latency spread over
whichever surfaces happened to be mounted, which presents as "the app is slow
today" and needs tooling this repository does not have to attribute.

**Do**

- Choose the channel by who owns the field and how often it changes.
- Push anything an open window keeps looking at, from the authority that owns
  it.
- Let the connection's proven identity decide what is sent.
- Keep one authority per field, and let it be the only sender of that field.
- Prefer a design whose failure mode is a stale screen, because somebody
  reports that.

**Don't**

- Don't choose the channel by what is reachable from the component or route you
  happen to be editing.
- Don't add a REST read for the first value of a field the socket will push
  later. That is two code paths to one field, and the second one runs once per
  mount.
- Don't make the client restate identity, scope, or filters that the handshake
  already established.
- Don't serve the same field from a second projection because that one was
  easier to reach; two projections of one row drift.
- Don't accept a failure mode that shows up only as diffuse latency. Nothing
  here can attribute that to a cause.

## Push before it is asked for

The connect exchange is the only request the client should have to make for
first paint. It sends one `subscribe` frame carrying **a resume position, not a
query** — where this client got to, not what it would like. Everything the
opened surface needs comes back unprompted.

Two consequences worth stating outright, because they are what makes this
different from an ordinary subscription:

- **The subscribe frame is not a fetch with extra steps.** It names no
  collection, no filter, and no page size. If a client has to say what it wants,
  the server is not proactive — it is an HTTP API with a persistent connection.
- **A cold connect and a resume differ only in the position.** The server
  decides what to send from what the client has, not from a different code path.
  Two paths drift, and the one that drifts is always the one that runs less
  often.

### What opening a workspace owes the client

Connecting a workspace socket should deliver, without being asked:

- **Workspace metadata** — name, slug, region, timezone, the viewer's role, and
  the viewer's own preferences and effective feature gates. Nothing paints
  correctly before these.
- **Sidebar metadata** — the first page of the work-stream directory with each
  row's common and viewer state, plus the pinned section, and the automation and
  note sections the sidebar renders. A cursor for the rest.
- **The initial suggested actions** — the current suggestion set for this viewer.
  It is computed in the background by the scheduler and already resident in
  WorkspaceDO; the home screen should never be the thing that asks for it.
- **The initial activity the new-work-stream screen shows** — what needs input
  and what recently completed. It is the first thing a person reads in the
  morning and it is derived from rows the same object holds.

The workspace row and the member directory are the parts of that list whose
authority is D1 rather than the object, so pushing them costs WorkspaceDO a D1
read per connect. That is one read, once, replacing one round trip per client
per mount — take the read.

### What opening a work stream owes the client

Opening a work stream should deliver, without being asked:

- **The complete metadata snapshot** — the WorkstreamDO common row and the
  viewer overlay, as one snapshot rather than a patch.
- **The first page of message metadata** — the newest page and, when the reader
  has a resume position, the page around it, with both cursors. The client
  should be able to paint a transcript from the frames the open produced.
- **The block configuration and the viewer's panel preference**, so the panel
  does not flash a default it then corrects.

Deeper history is paged **on the same socket**, correlated by request id,
because the room is the authority for its own transcript and a page reply must
not move any other reader's cursor. That is a pull, but it is a pull the person
asked for by scrolling — which is exactly the case this document does not try to
push.

### Designing a connect payload

The two lists above are what Avalon's two connects owe today. The way to derive
the next one:

1. **Start from the screen, not the schema.** List what the surface renders in
   its first frame. That list is the payload; anything else is a later concern.
2. **Cut anything the surface does not paint.** A connect payload is paid on
   every connection, by every window, on every reconnect — Main, Settings, and
   Meeting each hold their own socket. Generosity here is multiplied by all of
   them.
3. **Bound every collection.** First page plus a cursor. A collection that is
   small today is a collection whose size nobody has constrained.
4. **Give every value its ordering**, so the first push and the fiftieth are
   judged by the same rule. See [Ordering and
   de-duplication](#ordering-and-de-duplication).
5. **Decide what a reconnect re-sends.** Current-state pushes are not replayed
   frame by frame, so the payload has to be sufficient on its own — a client
   that reconnects must end up correct without replaying the gap.
6. **Leave room for the surface to be wrong.** Something must be able to ask for
   canonical state again; that request should be answered with the same
   authoritative frame the connect sent, not a special one.

**Do**

- Send everything the opened surface paints, in the connect exchange.
- Carry a resume position in the subscribe frame — where this client got to.
- Keep the cold connect and the resume on one code path that differs only in
  the position it starts from.
- Bound every collection to a first page plus a cursor.
- Budget the payload against what that specific window renders.
- Answer a "resend canonical state" request with the ordinary authoritative
  frame the connect already sends.

**Don't**

- Don't require a follow-up frame or a REST call for something the connect
  could have carried.
- Don't carry a query — a collection name, a filter, a page size — in the
  subscribe frame. That is a fetch wearing a socket.
- Don't write a separate first-connect path. The rarely-run one drifts, and it
  fails when it is finally needed.
- Don't push a whole collection because it happens to be small today.
- Don't load one payload with every surface the app has. Every window and every
  reconnect pays it.
- Don't invent a second, special reply shape for a canonical-state request; two
  shapes for one truth diverge.

## Ordering and de-duplication

### Duplicates are normal, and arrival order proves nothing

**Two sockets will tell you the same thing, and which one gets there first is a
race.** This is not an edge case to be designed out — it is the normal operation
of any hierarchy where a child owns the truth and a parent owns the list, and it
appears the moment a client subscribes to both levels at once.

Avalon's instance of it: a work stream's state change commits in
`WorkstreamDO`. That object publishes the committed row on its own control
socket immediately, and *also* projects it through the regional Queue to
`WorkspaceDO`, which publishes it on the workspace socket. A desktop window
sitting on that work stream holds both sockets, so it receives both copies. The
direct one is usually first, because it does not wait for a Queue hop — but
Cloudflare Queues is at-least-once and unordered, so "usually" is not something
a client may assume, and a redelivery can put the second copy *behind* a change
that superseded it.

Neither copy can simply be dropped, either. The workspace copy is the only one
an inactive sidebar row ever gets; the direct copy is the only one that arrives
while the Queue is backed up. Suppressing a channel to avoid duplicates trades a
visible bug for an invisible one.

The generalization worth carrying to the next stream: **a client cannot
de-duplicate by channel, by arrival order, or by timestamp.** Channels are not
comparable to each other, arrival order is a property of the network, and clocks
belong to different machines. Only a version stamped by the authority that owns
the data can order two payloads.

### The mechanism: version, ledger, compare

**Every pushed payload carries the version its authority stamped, and the client
keeps a ledger of the newest version it has applied. Applying is a comparison
against that ledger, not a reaction to a frame arriving.** The same change
delivered twice applies once, because the second copy's version is not newer
than what the ledger already holds. Which socket won the race stops mattering,
which is the point: correctness stops depending on a timing property nobody
controls.

A version that can carry this weight has four properties, whatever the stream:

- **It is stamped by the owner of the data**, at commit time, not by the sender
  at send time. A version minted per connection can only be compared against
  other frames from that connection — precisely the comparison that does not
  help.
- **It is monotonic within one authority and one field family**, so "newer"
  is a total order where it is used and nothing is being compared across
  authorities that never agreed on a clock.
- **It survives the transport.** Every path that can carry the payload carries
  the same version unchanged, or the two paths cannot be reconciled.
- **It is a function of the state, not of the delivery.** Two payloads at the
  same version must be the same data — see [A version has to be a function of
  the payload](#a-version-has-to-be-a-function-of-the-payload).

An authority identity belongs beside the counter whenever the counter can
restart — a re-import, a rebuild, a cutover to a new object. Without one, a
fresh authority's low numbers look like ancient history and the client discards
everything it is told.

### How Avalon stamps it today

`WorkstreamStateVersion` in `packages/contracts/src/index.ts` is the shape both
work-stream paths carry, and it is worth reading as a design rather than a
struct:

| Field | What it decides |
| --- | --- |
| `authorityGeneration` | Which incarnation of the authority produced this — it advances when a work stream is imported into a new object. A payload from an older generation is rejected outright, and a newer one applies unconditionally, because its waterlines come from a different counter and are not comparable to the stored ones. |
| `commonWaterline` | Monotonic within WorkstreamDO for the shared row — title, state, activity, preview. |
| `viewerWaterline` | Monotonic within WorkstreamDO for *this* viewer's overlay — unread, mention, read-through, listability. |
| `commonEventId` / `viewerEventId` | The UUIDv7 identity of the state row each half came from. Time-sortable trace identities for correlating the two paths — deliberately **not** a distributed clock, and never the thing a comparison is made on. |

**The two waterlines are independent on purpose, and that is the load-bearing
detail.** Queue delivery is unordered, so a viewer row can arrive after a common
row that was produced before it. One counter for both would let the late viewer
row suppress a common update that had not been delivered yet, and the sidebar
would keep a title that no longer exists. Advancing one half never advances the
other.

The general rule behind it: **fields that change independently need independent
counters.** Two families that advance together may share one; two that can move
without each other must not, or the faster one censors the slower one.

WorkspaceDO-owned fields are a third ledger again. Pin position is ordered by
the directory waterline that WorkspaceDO stamps on its own page results, because
that ordering is the parent's and has nothing to do with the child's revisions.
A field's version belongs to whoever owns the field.

### One receiver, not one per socket

**Every sender of a field family funnels into a single receiver that owns the
ledger and the comparison.** Sockets are transports into it, not decision
points. Two handlers each with their own comparison is how the race comes back:
the ledger stops being one ordering and becomes two opinions that diverge the
moment one of the sockets reconnects.

Avalon's receiver is
`apps/desktop/src/renderer/lib/workstream-state-store.ts`. The control-socket
hook and the workspace-socket provider both call
`applyVersionedWorkstreamState`; neither writes the work-stream caches directly.
The predicate it applies, exactly:

- A payload whose `authorityGeneration` is older than the ledger's is discarded
  whole. Neither half of a stale-authority payload is trustworthy.
- A newer generation applies both halves unconditionally, because the waterlines
  it carries are not comparable to the stored ones.
- At the same generation, each half applies **only if its own waterline is
  strictly greater** than the stored one. Equal is not newer: an equal waterline
  is the duplicate this whole mechanism exists to absorb.
- Whichever halves applied are written back to the ledger, and the halves that
  did not are left at their stored values. A payload can therefore be
  half-applied, which is the correct outcome when one half is behind the other.

A useful test when adding a sender: if the new call site needs its own "have I
seen this?" check, the receiver is in the wrong place. Move the comparison, not
the check.

### A version has to be a function of the payload

The client's guard is only sound if two payloads at the same version are the
same data. That is an invariant to enforce, not an assumption to make — a
version reused for different data turns every dropped duplicate into silent data
loss, and the symptom appears on a screen far away from the cause.

WorkspaceDO enforces it: a projection applies when the generation is newer, or
the generation matches and the source version is higher — and a delivery
arriving at the *same* generation and version with a different payload hash
throws `workspace_directory_projection_version_conflict` instead of quietly
picking one. A duplicate is then genuinely a no-op, and a reused version is a
loud failure at the point of ingestion.

The general shape: **hash what you version, compare the hash when the version
repeats, and fail rather than choose.** A conflict here is a bug in the producer;
the only useful client behavior is to make it impossible to ignore.

### The same discipline on the other streams

Each of these owns a different kind of position, and each is worth copying
rather than inventing another:

- **The transcript feed** orders on the room sequence. A frame at or below the
  last applied sequence is dropped. The one exception is a `snapshot`, which may
  apply at an *equal* sequence — a snapshot is a repair, and a repair that
  refused to replace state at the position it was asked about would repair
  nothing. Applying one clears the per-message stream cursors, because it is
  authoritative for everything it covers.
- **Token frames within a message**, on that same feed, carry a turn, an epoch,
  and a stream sequence, and a per-message cursor drops a fragment from an older
  turn, an older epoch, a lower stream sequence, or any fragment arriving after
  that message completed. This is why a reconnect can replay overlapping text
  without the reader seeing it twice.
- **Block output** carries `{ blockRunId, revision }` per block, and a
  checkpoint that is not newer for the same run is ignored. That is what makes
  the reconnect snapshot idempotent instead of appending a second copy of the
  text already on screen.

Three streams, three position types, one rule: **the receiver decides from a
stored position, and the frame never decides for itself.** The variation is in
what a position means — a room sequence, a per-message cursor, a per-run
revision — and each stream must say which, including what an *equal* position
means. A delta at an equal position is a duplicate and is dropped; a snapshot at
an equal position is the truth and is applied. A stream that has not made that
call will eventually do both, and the bug will be intermittent.

**Do**

- Stamp the version at the authority that owns the data, at commit time.
- Apply a payload by comparing its version against a stored position.
- Carry the same version unchanged down every path that can deliver the
  payload.
- Give independently-moving field families their own counters.
- Pair a counter with an authority identity wherever the counter can restart.
- Funnel every sender of a field family into one receiver that owns the ledger
  and the comparison.
- State what an *equal* position means for this stream, and make the snapshot
  the explicit exception that applies at one.
- Make the version a pure function of the state, and fail loudly when one
  version turns up carrying two different payloads.
- Keep event ids for tracing and correlation.
- Reload the surfaces a socket holds after it reconnects.
- Design for a second sender before one exists.

**Don't**

- Don't stamp the version at the socket, the connection, or the moment of send.
- Don't apply a payload because a frame arrived, and don't infer order from
  arrival, from a timestamp, or from which channel carried it.
- Don't let a relaying hop re-number, re-wrap, or drop the version it forwards.
- Don't share one counter across fields that different authorities advance. The
  faster one will censor the slower.
- Don't assume a counter is monotonic across a re-import, a rebuild, or a
  cutover.
- Don't let each socket handler write the cache with its own comparison.
- Don't leave the meaning of an equal position undefined. The stream will drop
  repairs sometimes and duplicate deltas other times, intermittently.
- Don't assume duplicates are byte-identical, and don't resolve a version
  conflict by picking whichever arrived later.
- Don't de-duplicate on a set of seen ids. It grows without bound, and it
  answers "have I seen exactly this", never "is this older than what I have".
- Don't assume the ledger still covers the gap after a reconnect;
  current-state pushes are not replayed frame by frame.
- Don't skip the comparison because only one socket sends this today. The
  second sender arrives as a feature and finds a rewrite.

## Why mutations go up over REST

Everything that changes state is an HTTP request: create a work stream, accept a
suggestion, answer an elicitation, rename, pin, invite, connect a connector,
change a setting. The authored message send is the one standing exception, and
[the last section](#known-divergences) says why it was granted.

**Because a mutation needs a reply, and HTTP is the thing that has replies.** A
status code, an error body, a retry policy, an idempotency key, per-route
authorization, CORS preflight, and a trace that starts and ends in the same
invocation. A socket command needs every one of those built by hand: a
correlation id, a timeout, a private receipt frame, a failure envelope, and a
resend rule after reconnect. That is HTTP, reimplemented inside a WebSocket, and
maintained by us.

**Because a socket is a stream of state and a mutation is a transaction.** The
push channel's contract is "the newest value wins, older ones are discarded". A
command cannot be discarded because a newer one arrived. Putting both on one
channel means one of the two contracts is a lie.

**Because the reply can carry the result.** REST is not write-only here: when
the caller needs read-your-write — the created work stream's id to navigate to,
the compiled automation to display — the response returns it. The durable
consequence still goes out on the socket to every client including this one,
which is what keeps the mutator's view and everyone else's identical rather than
merely similar.

So the shape of every mutation is: **REST request → authoritative write →
response to the caller → push to every socket that cares.** The response is a
convenience for the caller; the push is the truth for everyone.

Enforce that at the room rather than by convention. `SubstreamAgent` answers any
mutation frame with `rest_required` — "persist this action through the
work-stream API before publishing it" — and answers a `create_message` frame
with `workspace_socket_required`. A frame type existing in a shared client
schema is not permission to send it; the authority decides, and it says so in an
error a client author can act on.

**Do**

- Send state changes as HTTP, with a status code and an idempotency key.
- Return the authoritative result when the caller needs read-your-write.
- Publish the durable consequence to every subscriber, the mutator included.
- Refuse mutation frames at the authority, with an error that names the right
  path.
- Treat a socket command as an exception that has to be argued for in writing.
- Let the push be the ordering for everyone, the caller included.

**Don't**

- Don't build a command frame, correlation id, timeout, and error envelope on a
  socket. That is HTTP rebuilt by hand and maintained by us.
- Don't make a caller learn the outcome of its own write by waiting for a
  broadcast.
- Don't let the caller's response be the only place a change appears; the
  mutator's view then merely resembles everyone else's.
- Don't rely on a shared schema, a code review, or a comment to keep mutations
  off a socket.
- Don't add a socket command because it is fewer lines in the renderer, or
  because a similar one already exists.
- Don't apply a response optimistically in a way the later push cannot correct.

## When a REST read is still right

Not every read is a push. Reach for a `GET` when one of these holds:

- **There is no socket yet.** Sign-in, session establishment, the identity
  endpoint, and choosing which workspace to open all precede the socket that
  would have pushed them. This is a bootstrap, not a data plane.
- **Recovery when the socket said to resync.** After `resync_required` there is
  no healthy channel to ask on, so reconciliation goes over HTTP.
- **The user asked for something specific and large.** A resource's content
  bytes, a note transcript, an export, an attachment preview. It is one
  person's explicit act, it is big, and nobody else's screen depends on it.
- **It is rare, deep, or administrative.** A settings screen nobody has open,
  an invitation preview from an emailed token, a connector's catalog. Pushing it
  to every window on connect costs everyone for a surface almost nobody opens.
- **It is a one-shot signal, not state.** A pending OAuth attempt read once when
  the provider window closes.

The common thread: push what a window will paint and keep painting; fetch what a
person went looking for.

**Do**

- Fetch what a person explicitly went looking for.
- Keep the pre-socket bootstrap to what is needed to open the socket.
- Say at the call site why this one is a fetch.
- Re-read over HTTP when the socket has told you to resync.

**Don't**

- Don't push a surface almost nobody opens to every window on every connect.
- Don't let the bootstrap grow into a second data plane that shadows the first.
- Don't leave a fetch whose reason nobody can reconstruct. It will be copied
  into the next surface.
- Don't use HTTP to paper over a surface that goes stale for any other reason.
  That is a missing push.

## How to decide

In order. The first answer that applies decides it.

1. **Does it change state?** REST. Stop.
2. **Is there a socket open to the authority that owns it?** If not, REST — and
   ask whether the surface should have a socket.
3. **Will the screen that needs it render before it arrives?** Then it belongs
   in the connect payload, not in a request that screen makes.
4. **Can it change while a window is open?** Then it is pushed, and the push is
   the only path — do not add a REST read for its first value.
5. **Is it bounded, or does it have a natural first page?** If neither, it is
   not a connect payload; give it a cursor or leave it a fetch.
6. **Otherwise it is a fetch**, and the reason it is a fetch belongs in a comment
   at the call site.

Three smells that mean the answer above was wrong:

- **You are writing a timer.** An interval refetch, a focus revalidation, a
  retry that exists to catch a change rather than a failure. Staleness without
  user action is a missing push.
- **You are writing infrastructure for the channel you picked.** Correlation
  ids, timeouts, and receipt frames on a socket mean the mutation wanted HTTP.
  Cache invalidation, poll intervals, and refetch cascades on a fetch mean the
  read wanted a push.
- **Two places produce the same field.** Whatever the reason, the next bug is
  the two of them disagreeing, and it will be reported as a value that changes
  when you navigate and changes back when you reload.

## Invariants

The rules a change to this boundary is checked against, each with the
consequence of breaking it.

- **A socket frame carries state, not the news that state changed.** An
  invalidation the client answers with a fetch is a fallback for a surface not
  yet converted, never a design for a new one. Break this and every new surface
  costs a REST endpoint, a query key, a cache-invalidation entry, and a refetch
  on every reconnect.
- **Never require a request for something the connect could have carried.** The
  test is "would this screen have asked for it in its first 50 ms" — if yes,
  push it. Break this and first paint waits on a round trip per surface.
- **Every pushed payload carries its own ordering, stamped by its authority** —
  see [Ordering and de-duplication](#ordering-and-de-duplication). Break this
  and a duplicate from a second channel overwrites newer state, intermittently,
  in a way no test that runs one channel will catch.
- **A push and a REST response for the same thing are the same shape from the
  same authority.** Two projections of one row drift, and the drift shows up as
  a field that changes when you reload and changes back when you navigate.
- **A push is never the only copy.** Reconnect reconverges by snapshot, not by
  replaying every missed delta. Break this and a client that missed a window is
  wrong until something unrelated refreshes it.
- **Authorization is rechecked at push time.** A connect-time decision is a
  cached decision; membership and visibility change while a socket is open.
  Break this and revocation is bounded only by how long someone leaves a window
  open.
- **The connect payload is bounded**, and it is paid per window — Main,
  Settings, and Meeting each hold their own socket. Break this and the cost
  lands on every window and every reconnect at once.
- **No polling, ever.** No interval refetch, no "just in case" revalidation on
  focus. If a surface goes stale without user action, the fix is a push from its
  authority, not a timer in the renderer.

## Where Avalon stands today

The parts of this that are already true, and the parts that are not. This table
is the honest state as of the last edit to this file, not a target.

| Surface | Channel today | Matches this document |
| --- | --- | --- |
| Work-stream directory (sidebar rows, pins, order) | WorkspaceDO socket, cursor-paged, pushed on change | Yes. D1 is never a list fallback. |
| Work-stream common/viewer state | Pushed on both the WorkstreamDO and WorkspaceDO sockets, waterlined | Yes. |
| Transcript parts, tool blocks, token frames, presence | SubstreamAgent socket, snapshot on subscribe | Yes. |
| HyperSight block output | BlockDashboardAgent socket, checkpoint on connect | Yes. |
| Transcript pagination | Correlated request on the SubstreamAgent socket | Yes — a pull the reader asked for, answered by the authority. |
| Opening a work stream | `GET /workstreams/:id`, whose response embeds the metadata **and** the first message window, then sockets take over | Partly. One round trip instead of a push, but one — not one per surface. |
| Workspace profile, members, invitations, connectors, automations, notes, resources, digest, flags, viewer preferences | `workspace_sync` invalidation on the socket → REST refetch of whichever surface is mounted | **No.** The socket carries the news; the data comes over HTTP. |
| Suggested actions | `GET /work-opportunities?limit=4`, invalidated by the `activity` and `work_opportunities` topics | **No.** The rows are in the object holding the socket. |
| Sending a message | Command frame on the WorkspaceDO command socket, answered with a private receipt | **No** — and deliberately, for now. See below. |
| Every other mutation | REST, refused on the feed socket with `rest_required` | Yes. |

## Known divergences

Two, both recorded here rather than quietly left for the next person to find.

**Cold connect pushes an invalidation, not the data.** A first `subscribe` is
answered with a single `workspace_sync` event whose topic list is *every* topic
and whose reason is `initial`. The client reads that as "all of it may be new"
and refetches each mounted surface, so the home screen's first paint waits on
`GET /workspace`, `GET /workspace/members`, `GET /automations`, `GET /notes`,
and `GET /work-opportunities?limit=4`. Three of those five read tables in the
object that sent the frame; the other two are one D1 read away from it. Closing
this means giving the connect path a payload rather than a topic list, per-topic
waterlines so a later push can order against it, and a client that applies
frames instead of invalidating query keys. Until then, `initial` is the boundary
between what this document describes and what runs.

**Message sends go up the workspace socket, not over REST.** This was decided
on purpose and the reasoning is recorded in
[`architecture.md`](architecture.md#changelog) (2026-08-17): a foreground send
and its realtime result are one interaction owned by one authority, and
splitting request from result across HTTP and WebSocket made a lost response
ambiguous. That argument is about the *send*, which is the one mutation whose
result is a stream rather than a value, and it is not weakened by anything in
this document. It remains the one standing exception to "mutations go over
REST"; adding a second one requires the same standard of argument, and
converting this one back requires answering the ambiguity that produced it.

## Related documents

- [`realtime-sockets.md`](realtime-sockets.md) — how a socket is admitted, and
  which object answers each upgrade.
- [`workstream-durable-object.md`](workstream-durable-object.md) — the object
  hierarchy that owns the state being pushed, and what each one publishes.
- [`architecture.md`](architecture.md) — the surfaces, the request path, and the
  effect pipeline that turns a child's write into a workspace push.
- [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md) — the same kind of
  decision one layer down, between two Workers or two objects.
- [`when-adding-a-new-http-header.md`](when-adding-a-new-http-header.md) — the
  checklist for the REST half of this boundary.
- [`workstream-creation.md`](workstream-creation.md) — the create path, and what
  the caller is made to wait for.
