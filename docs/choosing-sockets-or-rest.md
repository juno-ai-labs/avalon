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

The product reason is the whole reason: Rally should feel like the data was
already there. A screen that renders from a payload that arrived unasked paints
once and paints immediately. A screen that mounts, discovers it needs four
things, requests them, and re-renders as each one lands shows the person four
intermediate states they did not ask to see. Read this before adding an
endpoint, a streamed event, or a client query.

**How to read this document.** Rules are written as imperatives, and a bullet
that begins with "Don't" describes something to avoid — never an instruction to
follow. Two sections near the end, [Where Rally stands
today](#where-avalon-stands-today) and [Known
divergences](#known-divergences), describe how the code behaves right now,
including in the places where it contradicts these rules. Those two sections are
a record of the current state, not examples to copy.

Every section states the principle first and ends with a **Do and Don't**
distillation. The principles are meant to survive this codebase: they apply to a
stream nobody has built yet, and Rally's current mechanisms appear as worked
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

**The state is already in the authority that holds the socket.** In Rally that
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

**Prefer the failure mode you will find out about.** A push that never arrives
leaves a stale screen, and the person looking at it reports it. A refetch storm is latency spread over
whichever surfaces happened to be mounted, which presents as "the app is slow
today" and needs tooling this repository does not have to attribute.

**Do**

- Choose the channel by who owns the field and how often it changes.
- Push anything an open window keeps looking at, from the authority that owns
  it.
- Let the connection's proven identity decide what is sent.
- Keep one *authority* per field — one place that decides the value and stamps
  its version. Other objects may relay it, forwarding that version unchanged.
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
- Don't let a second sender stamp its own version for a field it does not own.
  A relay forwards the owner's version; it does not mint one.
- Don't accept a failure mode that shows up only as diffuse latency. Nothing
  here can attribute that to a cause.

## Why holding all these sockets is affordable

A rule that says "keep a socket open for every window and push everything down
it" invites an obvious objection: that sounds expensive. It is not, and the
reason is the specific platform choice underneath — **Rally runs its
authorities as Cloudflare Durable Objects because they can hibernate a
WebSocket.**

The connection is held by the runtime, not by a running isolate. An object calls
`state.acceptWebSocket(server, tags)` instead of `server.accept()`, and from
that moment the platform owns the socket: the object can be evicted from memory
while every client stays connected, and it is woken when a frame actually
arrives or an alarm fires. An idle window therefore costs storage, not duration.
That is what makes the proactive design in this document affordable — **open is
not the same as resident**, so a person with three windows and a background work
stream is not three-and-a-bit processes sitting idle on our bill.

The trade is that the object's memory is not a place to keep anything. Every
rule below follows from that, and **breaking one of them does not break the
socket — it breaks hibernation, quietly, and the bill is where you find out**:

- **Connection state lives in the attachment, never in a JavaScript map.**
  `serializeAttachment` after `acceptWebSocket` — in that order, so the socket
  is registered before recoverable state is associated with it. Handlers
  enumerate `state.getWebSockets()` and re-validate `deserializeAttachment()` at
  every use, because an eviction between two frames is normal and loses
  everything that was only in memory.
- **Anything a client needs after a wake is reconstructible from SQL.** The
  object cannot remember what it sent. This is also why a connect payload is
  derived from stored state and a client's resume position, rather than from
  anything the server believes about that client.
- **Heartbeats must not wake the object.** All four socket roles register
  `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))`,
  so the runtime answers an exact `ping` frame without loading the object. A
  heartbeat implemented as an ordinary application message would wake it on
  every beat, which converts every idle connection into a billed one and defeats
  the entire arrangement.
- **An idle socket has no timer.** Application intervals and alarms exist only
  while real work is in flight. A `setInterval` that exists to keep an object
  warm, or a poll loop inside the object, is continuous duration bought for
  nothing.
- **High-frequency output is batched before it is sent.** Model fragments
  coalesce into one frame every 100 ms or 2,048 characters. Each frame is a wake
  and a message, so token-sized frames are token-sized wakes.

None of this is a reason to hold fewer sockets or to push less. It is the
opposite: hibernation is what buys the responsiveness, and the way to keep it is
to leave the connection alone while nothing is happening on it.

**Do**

- Hand the connection to the runtime with `state.acceptWebSocket`, then attach
  its recoverable state.
- Keep per-connection state in the socket's attachment and durable state in SQL.
- Register the runtime's ping/pong auto-response for heartbeats.
- Batch high-frequency output into frames on a time or size boundary.
- Let an idle connection be idle. Silence is the cheap state.

**Don't**

- Don't call `server.accept()`, or keep a session map, a cache, or a pending
  request keyed in object memory. An eviction erases it, and the socket that
  survives will be served by an object that has forgotten it.
- Don't implement a heartbeat as an application message the object has to
  answer. That wakes it on every beat.
- Don't run an interval inside the object to keep it warm, to poll for changes,
  or to re-send state nobody asked for.
- Don't send a frame per token, per row, or per keystroke.
- Don't work around a hibernation constraint by keeping the object awake. Move
  the state into the attachment or into SQL instead.

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
  Two paths drift, and the one that drifts is the one that runs less often.

The two lists that follow are requirements. They describe what these connects
are supposed to deliver, not what the code delivers today.

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
not move any other reader's cursor. That is a request rather than a push, and it
is allowed to be one: the reader asked for it by scrolling. This document asks
the server to anticipate the first screen, not to guess where somebody will
scroll to next.

### Designing a connect payload

The two lists above are the contract for Rally's two connects, not a
description of what the code sends today — the workspace connect still answers
with an invalidation the client turns into REST reads, as [Known
divergences](#known-divergences) records. The way to derive the next one:

1. **Start from the screen, not the schema.** List what the surface renders in
   its first frame. That list is the payload; anything else is a later concern.
2. **Cut anything the surface does not paint.** A connect payload is sent on
   every connection, to every window, on every reconnect — Main, Settings, and
   Meeting each hold their own socket. Every field added here is sent that many
   times.
3. **Bound every collection.** First page plus a cursor. A collection that is
   small today is one whose maximum size nothing enforces.
4. **Give every value its ordering**, so the first push and the fiftieth are
   judged by the same rule. See [Ordering and
   de-duplication](#ordering-and-de-duplication).
5. **Decide what a reconnect re-sends.** Current-state pushes are not replayed
   frame by frame, so the payload has to be sufficient on its own — a client
   that reconnects must end up correct without replaying the gap.
6. **Leave room for the surface to be wrong.** Something must be able to ask for
   canonical state again; that request should be answered with the same
   authoritative frame the connect sent, not a special one.

**Sizing a payload to a window requires the handshake to say which window it
is**, and that belongs in the ticket rather than the subscribe frame. A ticket
already establishes a purpose at admission — Rally mints separate workspace,
control, feed, and block audiences — so a per-surface payload is a purpose the
server was told at issue time, not a query the client sends afterwards. The
distinction is the whole of the rule above: the client may declare *what this
connection is for*, never *what data it would like*.

Rally's workspace ticket carries no such purpose today.
`getWorkspaceSocketTicket()` takes no arguments and the subscribe frame carries
only a waterline, so Main, Settings, and Meeting each receive the same payload
and each pays for everything in it. Until a purpose is added there, "budget it
against the window" reduces to "keep it small, because three windows pay for
it" — which is still the right instinct, and is the reason the rule is worth
stating before the mechanism exists.

**Do**

- Send everything the opened surface paints, in the connect exchange.
- Carry a resume position in the subscribe frame — where this client got to.
- Keep the cold connect and the resume on one code path that differs only in
  the position it starts from.
- Bound every collection to a first page plus a cursor.
- Size the payload to the surface the connection serves, and declare that
  surface as a purpose on the ticket when different surfaces need different
  payloads.
- Answer a "resend canonical state" request with the ordinary authoritative
  frame the connect already sends.

**Don't**

- Don't require a follow-up frame or a REST call for something the connect
  could have carried.
- Don't carry a query — a collection name, a filter, a page size — in the
  subscribe frame. A connection that answers queries is a request/response API
  again, and the server has stopped deciding what to send.
- Don't write a separate first-connect path. The rarely-run one drifts, and it
  fails when it is finally needed.
- Don't push a whole collection because it happens to be small today.
- Don't load one payload with every surface the app has. Every window and every
  reconnect pays it.
- Don't infer which surface a connection serves from anything the client sends
  after the handshake. A purpose is established at admission or not at all.
- Don't invent a second, special reply shape for a canonical-state request; two
  shapes for one truth diverge.

## Ordering and de-duplication

### Duplicates are normal, and arrival order proves nothing

**Two sockets will tell you the same thing, and which one gets there first is a
race.** This is not an edge case to be designed out — it is the normal operation
of any hierarchy where a child owns the truth and a parent owns the list, and it
appears the moment a client subscribes to both levels at once.

Rally's instance of it: a work stream's state change commits in
`WorkstreamDO`. That object publishes the committed row on its own control
socket immediately, and *also* projects it through the regional Queue to
`WorkspaceDO`, which publishes it on the workspace socket. A desktop window
viewing that work stream holds both sockets, so it receives both copies. The
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

### How Rally stamps it today

`WorkstreamStateVersion` in `@rally/contracts` is the shape both work-stream
paths carry, and it is worth reading as a design rather than a struct:

| Field | What it decides |
| --- | --- |
| `authorityGeneration` | Which incarnation of the authority produced this — it advances when a work stream is imported into a new object. A payload from an older generation is rejected outright, and a newer one applies unconditionally, because its waterlines come from a different counter and are not comparable to the stored ones. |
| `commonWaterline` | Monotonic within WorkstreamDO for the shared row — title, state, activity, preview. |
| `viewerWaterline` | Monotonic within WorkstreamDO for *this* viewer's overlay — unread, mention, read-through, listability. Zero is a sentinel rather than a position: it means the viewer has no overlay row yet, and the schema requires `viewerEventId` to be null exactly then. A payload stamped zero therefore never applies its viewer half, because the receiver's test is strictly greater. |
| `commonEventId` / `viewerEventId` | The UUIDv7 identity of the state row each half came from. Time-sortable trace identities for correlating the two paths — deliberately **not** a distributed clock, and never the thing a comparison is made on. |

**The two waterlines are independent on purpose, and that is the load-bearing
detail.** Queue delivery is unordered, so a viewer row can arrive after a common
row that was produced before it. One counter for both would let the late viewer
row suppress a common update that had not been delivered yet, and the sidebar
would keep a title that no longer exists. Advancing one half never advances the
other.

The general rule behind it: **fields that change independently need independent
counters.** Two families that advance together may share one; two that can move
without each other must not, or updates to the faster one will hide updates to
the slower one.

WorkspaceDO-owned fields are a third ledger again. Pin position is ordered by
the directory waterline that WorkspaceDO stamps on its own page results, because
that ordering is the parent's and has nothing to do with the child's revisions.
A field's version belongs to whoever owns the field.

### One receiver, not one per socket

**Every sender of a field family funnels into a single receiver that owns the
ledger and the comparison.** Sockets are transports into it, not decision
points. Two handlers each with their own comparison is how the race comes back:
the ledger stops being one ordering and becomes two, and the two diverge the
moment one of the sockets reconnects.

Rally's receiver is
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
throws instead of quietly picking one. Each projection carries its own guard,
so the error names which one disagreed:
`workspace_directory_projection_version_conflict` for the common row and
`workspace_directory_viewer_version_conflict` for a viewer's. A duplicate is
then genuinely a no-op, and a reused version is a loud failure at the point of
ingestion.

The general shape: **hash what you version, compare the hash when the version
repeats, and fail rather than choose.** A conflict here is a bug in the producer;
the only useful client behavior is to make it impossible to ignore.

### The same discipline on the other streams

Each of these owns a different kind of position, and each is worth copying
rather than inventing another:

- **The transcript feed** orders on the room sequence. A frame at or below the
  last applied sequence is dropped. The one exception is a `snapshot`, which may
  apply at an *equal* sequence: a snapshot repairs state, and a client sitting
  at that sequence is exactly the client that asked to be repaired. Applying one
  clears the per-message stream cursors, because it is authoritative for
  everything it covers.
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
an equal position is the truth and is applied. A stream that has not decided
will do both, in different code paths, and the resulting bug is intermittent.

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
- Don't share one counter across fields that different authorities advance.
  Updates to the faster field will hide updates to the slower one.
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
which is what keeps the mutator's view identical to every other client's rather
than close to it.

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
- Don't let the caller's response be the only place a change appears. The
  mutator's view can then differ from every other client's, and nothing will
  correct it.
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
- **Recovery when the socket cursor is ahead.** A lost in-memory replay window
  is repaired by a canonical snapshot on the admitted socket. After
  `resync_required` with reason `sequence_ahead`, the normal cursor guard cannot
  accept a lower-sequence snapshot, so reconciliation goes over HTTP.
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

Three signs the answer above was wrong:

- **You are writing a timer.** An interval refetch, a revalidation on window
  focus, or a retry whose purpose is to notice a change rather than to recover
  from a failure. A surface that goes stale without the user doing anything is a
  missing push.
- **You are writing infrastructure for the channel you picked.** Correlation
  ids, timeouts, and receipt frames on a socket mean the mutation wanted HTTP.
  Cache invalidation, poll intervals, and refetch cascades on a fetch mean the
  read wanted a push.
- **Two places produce the same field and stamp it independently.** A relay is
  fine and is how a work-stream row reaches both the control socket and the
  workspace socket — it forwards the owner's version. Two producers that each
  mint their own version is the problem: the next bug is the two of them
  disagreeing, reported as a value that changes when you navigate and changes
  back when you reload.

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
- **A client must be able to recover without the pushes it missed.** Reconnect
  reconverges by asking for a snapshot, not by replaying every delta that went
  out while it was gone. Break this and a client that missed a window stays
  wrong until something unrelated refreshes it.
- **Revocation closes the socket, and a push trusts an open one.** Authorizing
  is the job of the code that admits a connection and the code that retracts
  access. A sender may write to an open socket without asking again; the socket
  being open *is* the authorization. Put an authorization query on the push path
  instead and the hot path pays continuously for a decision that changes rarely.
  Break it the other way — nothing ever closing the socket — and someone whose
  access ended keeps receiving until they close the window. So whoever ends the
  access closes the socket, and there is exactly one way to do it: publish to the
  access-revocation queue, which carries the retraction to every object holding
  one of that person's sockets and closes them with a policy close, which also
  tells the client to stop retrying. See
  [`access-revocation.md`](access-revocation.md). Do not build a second path, and
  in particular do not build one that polls.
- **The connect payload is bounded**, and it is paid per window — Main,
  Settings, and Meeting each hold their own socket, and none of them is
  distinguishable at admission today. Break this and the cost lands on every
  window and every reconnect at once.
- **No polling, ever.** No interval refetch, no "just in case" revalidation on
  focus. If a surface goes stale without user action, the fix is a push from its
  authority, not a timer in the renderer. A clock that re-renders elapsed time
  is not polling and is not covered by this — it reads no data. Break the
  invariant and every window pays for a request whose answer was already on its
  way.

## Where Rally stands today

The parts of this that are already true, and the parts that are not, as of the
last edit to this file. The middle column says what the code does; the right-hand
column says whether that is what this document asks for. **A row marked No
describes behaviour to replace, not a pattern to copy into something new.**

| Surface | Channel today | Matches this document |
| --- | --- | --- |
| Work-stream directory pages (membership, order, pins) | First page carried on the `workspace_sync` answer to `subscribe`; later pages requested with `list_workstreams`; a `workstream_directory` sync event invalidates them and the client asks again | **Partly.** The first page is pushed and later ones are a scroll the reader asked for, but a pin or a reorder still arrives as news rather than as the changed row. |
| Work-stream common/viewer state | Pushed on both the WorkstreamDO and WorkspaceDO sockets, waterlined | Yes. |
| Transcript parts, tool blocks, token frames, presence | SubstreamAgent socket, snapshot on subscribe | Yes. |
| HyperSight block output | BlockDashboardAgent socket, checkpoint on connect | Yes. |
| Transcript pagination | Correlated request on the SubstreamAgent socket | Yes — a pull the reader asked for, answered by the authority. |
| Opening a work stream | `GET /workstreams/:id`, whose response embeds the metadata **and** the first message window, then sockets take over | Partly. One round trip instead of a push, but one — not one per surface. |
| Workspace profile, members, invitations, connectors, resources, digest, flags, viewer preferences | `workspace_sync` invalidation on the socket → REST refetch of whichever surface is mounted | **No.** The socket carries the news; the data comes over HTTP. |
| The sidebar's automations and notes | Carried on the `workspace_sync` answer to `subscribe`, then pushed whole as `workspace_sidebar_list` on every write, each with its own waterline | Yes. |
| Suggested actions | `GET /work-opportunities?limit=4`, invalidated by the `activity` and `work_opportunities` topics | **No.** The rows are in the object holding the socket. |
| Sending a message | Command frame on the WorkspaceDO command socket, answered with a private receipt | **No** — and deliberately, for now. See below. |
| Connector list in workspace settings | `GET /connections`, re-read on every window refocus (`refetchOnWindowFocus: 'always'`) | **No.** The one focus revalidation in the client; the global default is off. See below. |
| Every other mutation | REST, refused on the feed socket with `rest_required` | Yes. |

## Known divergences

Three places where the running code does not follow this document. They are
written down so that nobody reproduces them by copying what is already there,
and so the work to close them is legible to whoever picks it up. **None of them
is an exception you may extend: two are gaps, and the message send is a single
argued-for carve-out.**

**Cold connect pushes an invalidation, not the data.** A first `subscribe` is
answered with a single `workspace_sync` event whose topic list is *every* topic
and whose reason is `initial`. The client reads that as "all of it may be new"
and refetches each mounted surface, so the home screen's first paint waits on
`GET /workspace`, `GET /workspace/members`, and
`GET /work-opportunities?limit=4`. One of those three reads tables in the object
that sent the frame; the other two are one D1 read away from it. The sidebar
used to be in that list and no longer is — the same event now carries it, which
is what the rest of this should look like. Closing this
means giving the connect path a payload rather than a topic list, per-topic
waterlines so a later push can order against it, and a client that applies
frames instead of invalidating query keys. Until then, `initial` is the boundary
between what this document describes and what runs.

The sidebar is the part of that boundary that has been closed, and it is the
worked example to copy rather than the gap. Its three lists — the first
directory page, the automations and the notes — ride on the `workspace_sync`
event that answers `subscribe`, so opening it costs no request; the two that
were REST reads are pushed whole on every write, each carrying a waterline the
client orders against. Two details are worth taking from it. A resume where no
topic moved still carries the payload, under `reason: "resume"` with an empty
topic list, because a push can be missed while a socket is away and produce no
topic at all — and the receiver applies the sidebar *before* the topic-waterline
guard, or that resume would be discarded along with the state it exists to
deliver. And system work streams are deliberately left out: Debug enabled is
rare, internal, and lives in the desktop's own settings, so a viewer who wants
those rows re-draws from a `list_workstreams` request. Serving the p95 unasked
and charging the rare case a round trip is the trade this document is asking
for, not an exception to it.

What is still open on the sidebar is pins: a pin, an unpin, or a reorder calls
`publishDirectorySync`, which emits only the `workstream_directory` topic, so
the client invalidates and asks again. Work-stream row state is genuinely
pushed, as a waterlined `workspace_workstream_state`. Closing the rest means pin
changes publishing the changed row.

**The connector list re-reads itself on window focus.**
`apps/desktop/src/renderer/screens/workspace-settings.tsx` sets
`refetchOnWindowFocus: 'always'` on the `connections` query, against a global
default of `false` in `App.tsx`. That is the "just in case" revalidation the
[no-polling invariant](#invariants) forbids, on state rather than on a one-shot
signal, so the OAuth-attempt carve-out above does not cover it: the whole list
is re-read on every refocus whether or not a provider window was ever opened.
The push path already exists — `connector_connections` is one of the workspace
sync topics — so closing it means applying pushed connection state on that
screen instead of re-reading. Until then, this is the one place a timer-like
read survives, and it is not a precedent.

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

- [`realtime-sockets.md`](realtime-sockets.md) — how a socket is admitted, which
  object answers each upgrade, and the hibernation lifecycle every socket role
  follows.
- [`workstream-durable-object.md`](workstream-durable-object.md) — the object
  hierarchy that owns the state being pushed, and what each one publishes.
- [`access-revocation.md`](access-revocation.md) — the one way an open socket is
  closed when somebody loses access, which is what lets a push trust one.
- [`architecture.md`](architecture.md) — the surfaces, the request path, and the
  effect pipeline that turns a child's write into a workspace push.
- [`choosing-queues-or-rpc.md`](choosing-queues-or-rpc.md) — the same kind of
  decision one layer down, between two Workers or two objects.
- [`when-adding-a-new-http-header.md`](when-adding-a-new-http-header.md) — the
  checklist for the REST half of this boundary.
- [`workstream-creation.md`](workstream-creation.md) — the create path, and what
  the caller is made to wait for.
