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
socket frame, or a client query.

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

**The state is already in the object that holds the socket.** WorkspaceDO owns
the work-stream directory, the suggestion tables (`work_opportunities`,
`suggested_work_sets`), automations, notes, resources, and connector
connections. It is a single-threaded object with that data in its own SQLite,
and the socket is already open to it. A REST read of the same rows is a second
entry into the same object, through a Worker, with a fresh authorization pass —
to produce bytes the object could have written to a socket it is holding.

**One channel is one order.** Two channels means two orders, and the interesting
bugs live in the gap: a refetch triggered by an invalidation that overtakes a
push, a screen patched by a socket event and then reverted by a slower response,
a cache entry written by two producers with different shapes. When the same
authority sends the same shape down one ordered channel with its own waterline,
the client's rule is a comparison, not a reconciliation.

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

`SubstreamAgent` enforces this on the wire rather than by convention. A feed
socket that receives a mutation frame is answered `rest_required` — "persist
this action through the work-stream API before publishing it" — and a
`create_message` frame is answered `workspace_socket_required`, which names the
one socket that does take it. A frame type existing in the shared client schema
is therefore not permission to send it; the room decides.

## The rules

- **A socket frame carries state, not the news that state changed.** An
  invalidation the client answers with a fetch is a fallback for a surface not
  yet converted, never a design for a new one. Break this and every new surface
  costs a REST endpoint, a query key, a cache-invalidation entry, and a refetch
  on every reconnect.
- **Never require a request for something the connect could have carried.** If
  a screen's first render needs it and the server could know it, it belongs in
  the connect payload. The test is "would this screen have asked for it in its
  first 50 ms" — if yes, push it.
- **Every pushed payload carries its own ordering.** A waterline, a sequence, or
  a version, compared by the client before it applies anything. Unordered pushes
  over an at-least-once, unordered Queue path silently resurrect old values.
- **A push and a REST response for the same thing are the same shape from the
  same authority.** Two projections of one row drift, and the drift shows up as
  a field that changes when you reload and changes back when you navigate.
- **A push is never the only copy.** Reconnect reconverges by snapshot, not by
  replaying every missed delta. The client needs current state, not the history
  that produced it — a bounded replay window that cannot cover a cursor answers
  with "resync" and a full snapshot.
- **Authorization is rechecked at push time.** A connect-time decision is a
  cached decision; membership and visibility change while a socket is open, and
  the object sweeps readers when they do. Never push to a socket because it was
  once allowed to receive.
- **The connect payload is bounded.** First page plus a cursor, never a
  collection. It is paid per window — Main, Settings, and Meeting each hold
  their own socket — so it holds what that window paints and nothing else.
- **No polling, ever.** No interval refetch, no "just in case" revalidation on
  focus. If a surface goes stale without user action, the fix is a push from its
  authority, not a timer in the renderer.

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
