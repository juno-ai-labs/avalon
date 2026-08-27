# WebSocket architecture

Rally keeps a small set of long-lived WebSockets open so workspace state,
work-stream metadata, and the active substream feed are already available when
a person navigates. Electron deliberately uses two client transports: the
singleton workspace connection stays in Chromium, while each WorkstreamDO and
substream `0` pair is dialled by a Node broker in the main process. The split
lets the desktop open a useful swarm in parallel without moving protocol state
or product caches out of the renderer.

This document owns the end-to-end topology, connection-selection policy, process
boundaries, and lifecycle. [`realtime-sockets.md`](realtime-sockets.md) owns the
short-lived ticket, subprotocol, and server admission contract;
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) owns which product
data belongs on a socket; and
[`workstream-durable-object.md`](workstream-durable-object.md) owns the state and
protocol inside each Durable Object.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/components/app-shell.tsx` | Selects the active work stream, every pinned work stream, the five most recently active unpinned work streams, and any additional running work stream for proactive connection. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Owns the singleton native Chromium WorkspaceDO socket, workspace subscription, directory paging, replay, and outbound message-command queue. |
| `apps/desktop/src/renderer/lib/workstream-socket-pool.tsx` | Owns one WorkstreamDO/substream `0` pair per selected work stream above the route, retains recently viewed pairs for five minutes, and supports control-only hover warming. |
| `apps/desktop/src/renderer/lib/use-workstream-control-socket.ts` | Owns the WorkstreamDO metadata protocol, ticket request, snapshot application, heartbeat, and reconnect state machine. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Owns the SubstreamAgent feed protocol, ticket request, snapshot/replay application, heartbeat, pagination, and reconnect state machine. |
| `apps/desktop/src/renderer/lib/realtime-socket.ts` | Presents a browser-shaped socket to both work-stream hooks and maps Electron sockets onto one socket-ID-multiplexed preload listener. Browser development falls back to the native `WebSocket` constructor. |
| `apps/desktop/src/common/realtime-socket.ts` | Defines the closed IPC schemas for opening, sending, closing, and receiving brokered socket events. |
| `apps/desktop/src/common/realtime-socket-validation.ts` | Defines dependency-free channel names and strict main-to-preload event validation. |
| `apps/desktop/src/preload/index.ts` | Exposes only the typed broker operations to the sandboxed renderer and validates events arriving from main. |
| `apps/desktop/src/main/realtime-socket-ipc.ts` | Registers the main-window-only IPC boundary, parses every request, confines destinations, and relays broker events. |
| `apps/desktop/src/main/realtime-socket-broker.ts` | Owns Node `ws` connections, follows Electron's complete ordered system/PAC route and operating-system CA trust, supplies the Rally application Origin, enforces the shared frame ceiling, relays events, and terminates sockets with their renderer owner. |
| `apps/api/src/routes/socket.ts` | Receives public WebSocket upgrades and sends each accepted request through the correct regional Durable Object namespace. |
| `apps/api/src/services/socket-service.ts` | Issues and verifies purpose-specific socket tickets and constructs the clean upgrade subrequest. |
| `apps/api/src/durable-objects/workspace-do.ts` | Accepts the workspace synchronization/command socket through Cloudflare's hibernation API. |
| `apps/api/src/durable-objects/workstream-do.ts` | Accepts the per-work-stream aggregate metadata socket through the hibernation API. |
| `apps/api/src/durable-objects/substream-agent.ts` | Accepts the substream feed socket, sends the canonical snapshot, and publishes ordered transcript/runtime events. |

## How it works

### The topology

```text
Electron renderer
  |
  |-- native Chromium WebSocket -------------------------> regional Worker
  |       one WorkspaceDO sync/command socket                    |
  |                                                              +--> WorkspaceDO
  |
  |-- typed preload IPC --> Electron main --> Node ws ----> regional Worker
          one control socket per selected work stream            |
          one substream 0 feed socket per selected work stream   +--> WorkstreamDO
                                                                 +--> SubstreamAgent
```

The Worker remains in every public connection path. Durable Objects do not
expose a public address that Electron can dial directly: the regional Worker
terminates the public route, verifies the ticket and Origin, resolves the
correct namespace and object identity, and forwards the upgrade over a Durable
Object binding. Moving the client handshake from Chromium to Node changes only
which Electron process owns TCP/TLS; it does not bypass authentication, regional
routing, or the Worker-to-object hop.

The WorkspaceDO socket stays in Chromium because there is exactly one for the
active workspace and therefore no swarm to serialize. It supplies the sidebar's
authoritative directory and the command queue used to send messages. A
WorkstreamDO control socket supplies complete work-stream metadata. The
matching SubstreamAgent socket for substream `0` supplies the
canonical feed snapshot, ordered live events, replay, and older-page responses.
Neither member of the pair carries message creation: the composer submits a
command through WorkspaceDO. WorkspaceDO's explicit foreground signal is the
sole source for current-client viewer presence; socket warmth is not attention.

HyperSight block sockets and dictation sockets keep their existing transports
and lifecycles. They are not brokered by this module and are not part of the
proactive work-stream swarm.

### Selecting the swarm

`AppShell` derives one background set from the current WorkspaceDO-owned
directory. The first workspace sync includes every visible running row in
addition to its 250-row recent page, so an old active run cannot fall outside
the client's candidate set:

- every pinned work stream;
- the five most recently active unpinned work streams; and
- every work stream whose harness status is `running`.

The active route is included independently. IDs are de-duplicated, so a pinned,
running, and recently active work stream still owns exactly one control/feed
pair. Pin order affects the sidebar but does not sequence connection attempts.
There is no separate guessed connection ceiling: the product-selected set is
the set the pool opens.

When a work stream leaves the active route, its exact pair remains mounted for
five minutes. It stays longer when it still qualifies as pinned, recent, or
running. A one-second deliberate pointer hover may add only the WorkstreamDO
control socket for one otherwise-cold row; hover never opens the SubstreamAgent
feed or publishes presence.

### Opening a pair

The control and feed hooks mount together. Each independently requests its own
purpose-specific 60-second ticket over authenticated HTTP, then immediately
hands the clean URL and `[rally.ticket.v1, ticket]` protocol offer to the
browser-shaped adapter. Neither ticket request, broker admission, handshake,
subscription, nor initial snapshot awaits the other member of the pair.

In packaged Electron, the adapter allocates a UUID socket ID and invokes the
preload bridge. Main validates the IPC payload and destination before creating a
Node `ws` client. Open, message, error, and close events return over a single
preload subscription and are routed in O(1) time by socket ID. The existing
renderer hooks therefore retain ownership of protocol parsing, caches,
heartbeats, reconnect jitter, replay, and telemetry; main owns raw transport
only. Main asks Electron to resolve the destination through the configured
system or PAC proxy and gives Node both its bundled and operating-system CA
roots. A semicolon-delimited PAC result remains ordered: a connection advances
to the next proxy only when a pre-open attempt fails, and uses `DIRECT` only
when the resolved policy included it. Every client and server control/feed
frame is bounded to the shared 1 MB protocol ceiling. The broker therefore
avoids Chromium's handshake queue without silently bypassing a managed network,
interception certificate, or fallback policy.

In browser development, the same adapter uses the native `WebSocket`
constructor. That path preserves development compatibility but does not provide
the Electron swarm's independent Node handshakes.

### Server acceptance and hibernation

The regional Worker validates the route, upgrade, Origin, ticket signature,
audience, region, and target identity. It strips the bearer ticket before
forwarding the upgrade and passes only verified identity and the ticket ID to
the target object. The object rechecks its own authorization boundary, consumes
the ticket ID once, accepts the server socket, and serializes the attachment
needed after eviction.

WorkspaceDO, WorkstreamDO, and SubstreamAgent use Cloudflare's
[WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
Idle objects can be evicted while the platform keeps their sockets connected;
incoming application frames wake the object and recover connection identity
from serialized attachments. Exact `ping` frames are answered by the runtime's
auto-response facility without waking the object. The client therefore keeps
useful sockets warm without requiring an always-running Durable Object instance.

### Reconnect and teardown

The control and feed state machines reconnect independently with their existing
jittered backoff. A failure in one does not delay the other's ticket request or
handshake. Snapshot waterlines and replay rules decide whether a reconnected
frame advances cached state; transport warmth is never treated as authority.

Normal route changes do not destroy a retained owner. A full main-frame
navigation, reload, or window close calls `closeOwner` with the renderer's
`webContents` ID and terminates every Node socket belonging to it. A renderer
crash performs the same owner teardown. An ordinary socket close removes that
socket ID from both main and renderer routing tables; invalid close codes or
oversized UTF-8 reasons are rejected before IPC and a native close exception
terminates and forgets the affected socket.
Server access revocation remains terminal and prevents the affected state
machine from reconnecting.

### Best practices for extending proactive coverage

Proactive connection is a latency optimization, not the default lifecycle for
every socket the product could open. Add another proactively connected surface
only when all of these are true:

1. **Name the interaction being accelerated.** Define the user-visible ready
   boundary, such as selecting a substream and seeing its feed, and use the
   existing renderer flow to determine whether ticket, handshake, wake, or first
   snapshot time is a material part of misses. A socket needed to render ongoing
   live execution may qualify without a future click; a socket opened only
   because its object exists does not.
2. **Select from an authority already in memory.** Eligibility must come from a
   directory row, current route, explicit user choice, or already-delivered run
   state. Do not issue one read or Durable Object call per candidate to decide
   whether to preconnect it; discovery that wakes the objects being considered
   defeats the optimization.
3. **Use a product signal, not broad enumeration.** Strong signals are an active
   route, an explicit pin or favorite, a run whose live output is visible, and a
   recently viewed item with a deliberate retention policy. Sharing a parent
   work stream, existing in storage, or appearing somewhere below the fold is
   not enough on its own.
4. **Do the worst-case arithmetic before implementation.** Multiply eligible
   feeds per work stream by eligible work streams and concurrently signed-in
   windows. Account for ticket requests, TLS/WebSocket handshakes, initial
   snapshot bytes and queries, object wakes and migrations, renderer cache
   memory, and the reconnect burst after sleep or a network transition.
   Hibernation removes idle object duration; it does not make those operations
   free. If the product needs a count, TTL, or priority cutoff, the team chooses
   and documents that number rather than hiding a guessed defensive cap in the
   transport.
5. **Define the complete lifecycle.** The design must say how identity is
   de-duplicated, when retention begins and ends, how offline startup and
   reconnect jitter behave, how a renderer teardown closes every connection,
   and which close outcomes permanently stop reconnect. Access revocation must
   remain immediate even for a socket whose destination is not visible.
6. **Keep attention and authority separate from warmth.** A background
   subscription must not claim that the person is viewing its content. It must
   use the same authorization and one-use ticket checks as a foreground open,
   and its snapshot must not disclose content merely because the parent is
   visible.
7. **Instrument and prove both outcomes.** Record why the socket started and
   retain ticket/connection correlation. Test that qualifying candidates start
   concurrently, non-qualifying candidates do not start, overlap produces one
   owner, teardown closes it, and a warmed selection crosses the same painted
   and send-ready boundary as a cold selection. Re-run the real Electron flow;
   jsdom cannot prove the browser or Node connection topology.

For additional SubstreamAgent feeds, the current pool cannot simply be widened.
It keys ownership, connection state, and lease identity by `workstreamId` and
the feed hook currently subscribes to substream `0`. Supporting other
substreams requires a feed identity of `(workstreamId, substreamId)` throughout
the pool, cache keys, telemetry, and tests. Keep one WorkstreamDO control socket
per work stream and add only the eligible feed sockets; do not duplicate the
control socket for every child.

An additional substream is a good proactive candidate when it is the selected
substream, has an explicit user-retention signal, is producing live output the
current UI promises to keep current, or was recently viewed under an approved
retention policy. Do not connect every known substream merely because the Node
broker can launch them concurrently. If multiple children qualify, start their
ticket requests and handshakes independently, preserve one owner per tuple, and
measure selection-to-visible-feed for that substream rather than treating an
open transport as success.

## Invariants

- **Each selected work stream owns at most one control socket and one substream
  `0` feed socket.** Duplicate owners would spend one-use tickets, duplicate
  snapshots and events, and make reconnect state race itself.
- **The pair starts independently.** Awaiting control before feed would put
  metadata back on the click-to-feed critical path; awaiting feed before control
  would delay current metadata for no protocol reason.
- **Main owns transport, not product state.** Moving caches, replay, or protocol
  decisions into main would create two application state machines and make
  browser development behave differently from Electron.
- **The workspace socket remains the message-command path.** Treating feed-ready
  or control-ready as delivery acknowledgement would confuse feed visibility
  with command admission and server persistence.
- **The renderer cannot turn the broker into a general network client.** Main
  must continue to validate the configured regional origin, exact route shape,
  declared kind, clean URL, and constrained ticket subprotocol offer, and must
  supply the Origin itself. Weakening this gives compromised renderer content
  arbitrary Node networking authority.
- **A renderer owns every brokered socket it opens.** Send and close operations
  key by both `webContents` ID and socket UUID, so one window cannot address
  another window's connection and teardown cannot strand sockets.
- **Idle server sockets remain hibernatable.** Adding an object-side interval,
  in-memory-only connection registry, or non-hibernation acceptance keeps
  compute active or loses required state on eviction.
- **A warm connection is not presence.** Foreground work-stream identity is
  reported separately over WorkspaceDO; proactively opening a feed must not make
  another member appear to be viewing it. Current Electron feed subscriptions
  explicitly disable the legacy SubstreamAgent presence publication, and the UI
  ignores that legacy event in favor of WorkspaceDO's foreground snapshot.
- **The client and both object endpoints share one frame ceiling.** Raising or
  lowering the 1 MB bound in only Node, WorkstreamDO, or SubstreamAgent creates a
  transport-dependent protocol and must not be done.

## Boundary

This module owns which Rally sockets exist concurrently, which Electron process
owns their transport, how brokered events cross IPC, and when pooled sockets are
retained or released. It exposes a browser-compatible `RealtimeSocket` contract
to the existing work-stream control and feed hooks.

It does not own ticket claims, expiry, replay prevention, Origin policy at the
Worker, or upgrade negotiation; those belong to
[`realtime-sockets.md`](realtime-sockets.md). It does not decide the contents of
snapshots or events; those belong to the Durable Object modules. It does not
define cache waterlines or choose sockets over REST; see
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md). It also does not
move WorkspaceDO, HyperSight block, or dictation transport into Node.

## Failure modes and limits

- **Ticket request fails:** that socket remains unavailable and its renderer
  state machine retries with jitter. The other member of the pair proceeds
  independently.
- **IPC input is malformed or the target is outside the allowlist:** main
  rejects the open before creating a network client; the adapter emits the same
  failed-open sequence the hook already handles.
- **Handshake or object admission fails:** the Node client relays error/close;
  the purpose-specific close semantics and reconnect policy remain in the
  renderer hook.
- **A frame arrives after ownership ended:** main's `active` fence and exact map
  identity suppress it, while the renderer ignores events for an unknown socket
  ID.
- **The main process or renderer exits:** operating-system socket teardown is the
  final backstop, and explicit owner teardown terminates connections during a
  managed navigation, close, or renderer-process crash.
- **A proxy attempt fails before open:** the broker tries the next directive in
  Electron's resolved PAC order. It never invents a direct fallback; `DIRECT`
  is attempted only when the policy returned it. Application restart rebuilds
  the broker with current bundled and operating-system CA roots.
- **A frame exceeds 1 MB:** the producing object refuses an oversized control
  payload, and Node closes an oversized inbound frame. This keeps the two
  Electron transports on the same application limit rather than inheriting
  `ws`'s 100 MB default.
- **Many work streams qualify:** every pin and every running work stream is
  intentionally included, plus five recent unpinned rows and retained pairs.
  This architecture adds no unmeasured defensive cap; changing that product
  policy requires an explicit limit decision.
- **A Durable Object hibernates:** the connection remains established. Its next
  application event may pay object wake, construction, and schema-initialization
  time, but it does not pay a new client TCP/TLS/WebSocket handshake.
- **Browser development opens a large set:** it remains subject to Chromium's
  connection scheduling because only packaged Electron routes these two socket
  kinds through Node.

## Testing

| Suite | Command | Covers |
| --- | --- | --- |
| `apps/desktop/src/main/realtime-socket-broker.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/main/realtime-socket-broker.test.ts` | Destination confinement, ordered PAC fallback, shared payload limit, event relay, normal close cleanup, sends, and renderer-owner teardown. |
| `apps/desktop/src/main/realtime-socket-ipc.test.ts`, `apps/desktop/src/common/realtime-socket-validation.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/main/realtime-socket-ipc.test.ts src/common/realtime-socket-validation.test.ts` | Shared channel wiring, main-window authorization, request confinement, broker relay, and strict dependency-free event validation. |
| `apps/desktop/src/renderer/lib/realtime-socket.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/realtime-socket.test.ts` | Browser-shaped state/events, IPC calls, and one multiplexed preload listener for a socket swarm. |
| `apps/desktop/src/renderer/lib/workstream-socket-pool.test.tsx` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/workstream-socket-pool.test.tsx` | Pair ownership, independent starts, route retention, expiry, overlap, and control-only hover warming. |
| `apps/desktop/src/renderer/components/app-shell.test.tsx` | `pnpm --filter @rally/desktop exec vitest run src/renderer/components/app-shell.test.tsx` | Active/background selection, including all pins, five recent unpinned rows, and additional running rows. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/durable-object-runtime.test.ts` | Real-workerd upgrade, hibernation, attachment, snapshot, replay, read-only feed, and revocation behavior. |

The broker tests use a socket factory double because they prove Electron
ownership and event routing, not workerd behavior. Upgrade construction and
hibernation assertions belong in `apps/api/test-workers/`; Node's `Response`
cannot represent a real status-101 response and cannot prove Cloudflare runtime
semantics.

For a manual acceptance check, run the local regional Worker and Electron client
as described in [`dev-environment.md`](dev-environment.md), sign in, and inspect
the Worker output. Each proactively selected work stream should produce one
`101` for `/socket/workstreams/:id` and one for
`/socket/workstreams/:id/substreams/0`. Opening a row whose complete pair was
proactively warmed should render its feed and enabled composer without new
connection setup. A control-only hover warm-up still opens the feed on
selection. A local model credential is required only to complete inference
after a send, not to verify socket or WorkspaceDO command admission.

## Regional impact

The renderer obtains ticket URLs from the workspace's existing regional API
client, and main accepts only origins derived from the configured Global and EU
API base URLs. The broker neither chooses nor changes a workspace's region. The
regional Worker verifies the ticket's region before resolving the Durable Object
binding, and no socket payload crosses between Global and EU.

## Security and trust model

The sandboxed renderer is untrusted at the IPC boundary. Main accepts realtime
socket operations only from the primary Rally window, parses every operation,
and keys authority to that window's `webContents` ID. An open URL must use
`ws`/`wss`, match a configured regional origin exactly, contain no username,
password, query, or fragment, and match the declared WorkstreamDO or
SubstreamAgent path. The first protocol must be the public ticket sentinel;
main supplies `app://rallywithai` as Origin and accepts no renderer-selected
headers.

The signed ticket remains confined to the `Sec-WebSocket-Protocol` request
header. It is not put in a URL, returned in an event, or logged. The Worker
echoes only the public sentinel. See [`security.md`](security.md) for the wider
Electron trust boundary.

## Operations

Client `workstream_socket_started`, `realtime_socket_state`, and
`renderer_perf_flow` records identify socket kind, reason, lease, and opening
phase without message content. For packaged macOS builds, governed renderer
performance records also appear in Unified Logging. The `workstream_open`
`handshake` phase spans renderer-to-main IPC plus the network/Worker/object
upgrade; Chromium NetLog no longer contains WorkstreamDO and SubstreamAgent
handshakes.

Worker traces and `perf_flow` rows cover ticket issue, edge upgrade, Durable
Object binding, acceptance, subscription, and snapshot assembly. Correlate the
two sides with `rally.request.id`, `rally.socket.ticket_id`,
`rally.socket.connection_id`, and the shared socket lease ID as described in
[`performance-tracing.md`](performance-tracing.md). A server-side upgrade
duration is a lower-bound proxy for the user-visible wait; the renderer's first
frame, painted feed, and send-ready boundary remain the complete measurement.

## Performance and cost

The design removes Chromium's same-endpoint CONNECTING serialization from the
per-work-stream swarm. Node starts each eligible connection independently, while
the renderer starts both ticket requests and both protocol state machines in the
same render lifecycle. This improves readiness only when work streams are opened
after the proactive pair has reached snapshot-ready state; it does not eliminate
Durable Object wake or snapshot assembly.

The cost of warmth is two client connections and two initial snapshots per
selected work stream. Cloudflare hibernation allows the idle server objects to
stop accruing active compute duration while their sockets remain connected, but
each initial connection, reconnect, wake, and delivered application frame still
uses platform resources. The selection policy bounds recency to five unpinned
rows while intentionally leaving pins and active runs uncapped because those are
explicit product states rather than speculative guesses.

## Changelog

### 2026-08-26 — Warm feeds are presence-free and broker limits are end-to-end

**What changed:** Electron feed subscriptions now opt out of legacy
SubstreamAgent viewer publication, and the work-stream screen derives every
current viewer from WorkspaceDO foreground presence. The broker preserves and
tries Electron's complete PAC route in order, shares a 1 MB frame ceiling with
both work-stream object endpoints, and keeps background-only connection churn
out of the renderer's active-connection context. The IPC registration and
dependency-free preload validator are independently tested.

**Why:** Proactively opening pins and recent rows otherwise makes an idle Rally
window report false viewers. Discarding PAC fallbacks strands managed-network
users behind a failed first proxy, and Node's 100 MB default disagrees with the
server protocol. Publishing every background socket through React context also
turns a transport swarm into avoidable foreground render work.

**Considered and rejected:** Keeping legacy feed-derived presence and filtering
only the face pile would leave other presence consumers incorrect. Dialing
directly after any proxy failure would bypass policy. Independent per-process
frame limits would drift again.

**Consequences:** Older clients that omit `publishPresence` retain the legacy
default, while current Electron subscriptions send `false`. Future presence
consumers must read WorkspaceDO, proxy changes must preserve directive order,
and frame-limit changes must update the one shared contract.

Shipped in #341.

### 2026-08-26 — Broker hardening preserves managed networks and complete prewarm discovery

**What changed:** Node-owned work-stream sockets now use Electron's system/PAC
proxy resolution and the operating-system CA roots, renderer crashes terminate
their owned sockets, and malformed close frames cannot strand an addressable
broker entry. The initial WorkspaceDO directory payload now supplements its
recent page with every visible running work stream, including runs older than
the 250-row page. The adapter ignores open/message events after close begins,
and the ticket-provenance lint rule follows aliased and namespace imports.

**Why:** Parallel Node handshakes must not bypass enterprise network policy, and
proactive warming cannot cover “every running work stream” if candidate
discovery itself stops at a pagination boundary. Review also identified process
and protocol edges that could leave transport state inconsistent after a crash
or invalid close attempt.

**Considered and rejected:** Returning the sockets to Chromium would restore its
proxy behavior but also restore the endpoint handshake serialization this
architecture removes. Treating the first 250 rows as an intentional cap was
also rejected because running is a live product state, not a recency guess.

**Consequences:** Proxy resolution occurs for each new connection, CA roots are
captured when the broker is created, and the initial sidebar page can exceed
250 rows. Its combined pins-and-running response has no separate guessed cap;
the recent portion remains cursor-bounded. Future connection targets must
preserve both the discovery guarantee and owner teardown paths.

Shipped in #341.

### 2026-08-26 — Proactive expansion requires user intent and bounded reasoning

**What changed:** The architecture now defines the conditions for proactively
connecting another socket surface and the additional identity, lifecycle,
cost, authorization, instrumentation, and real-runtime checks required for
non-zero substreams. No runtime behavior changed.

**Why:** Moving handshakes to Node makes wider fan-out mechanically easy, and
Durable Object hibernation can make an idle socket look free. Additional
substreams multiply ticket requests, snapshots, object wakes, renderer state,
and reconnect work even when they do not keep an object actively billed. A
durable rule is needed before transport capability becomes accidental product
policy.

**Considered and rejected:** Opening every substream known to a selected work
stream would warm low-probability destinations and require discovery work that
can itself wake each object. A fixed transport-wide connection cap would hide
which product interactions matter and invent a number without a product or
platform derivation.

**Consequences:** Future proactive coverage must name the interaction it makes
ready, select candidates from already-available authority, show worst-case
fan-out arithmetic, preserve immediate revocation and jittered teardown, and
prove the visible boundary in Electron. Other substreams require tuple-keyed
pool and cache ownership; they cannot reuse the current workstream-only key or
duplicate its WorkstreamDO control connection.

Shipped in #341.

### 2026-08-26 — Work-stream socket pairs move outside Chromium's handshake queue

**What changed:** Packaged Electron now opens each selected work stream's
WorkstreamDO control socket and substream `0` feed socket through a route-confined
Node broker. The active work stream, all pins, five recent unpinned work streams,
and all running work streams are opened proactively and independently; the
singleton WorkspaceDO socket remains in Chromium.

**Why:** Chromium serialized simultaneous WebSocket handshakes to the same
endpoint even when they routed to different Durable Objects. That made a socket
swarm queue behind itself and moved connection setup back onto a later sidebar
click, conflicting with the two-second click-to-feed-and-send-ready goal.

**Considered and rejected:** Separate Chromium sessions remove the shared
endpoint lock but duplicate storage, cache, proxy, certificate, and lifecycle
state. Moving the complete protocol into Electron main would duplicate the
renderer state machines and make browser development a second product. A raw
Node transport broker preserves one protocol implementation while allowing
parallel handshakes.

**Consequences:** The privileged bridge must remain route-confined, renderer
events must stay multiplexed through one listener, and full renderer teardown
must terminate every owned Node socket. Workspace commands, HyperSight blocks,
dictation, browser development, Durable Object admission, and hibernation keep
their existing owners. Future socket kinds do not inherit broker access without
an explicit schema and route-validator change.

Shipped in #341.
