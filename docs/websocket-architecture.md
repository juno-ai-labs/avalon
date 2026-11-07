# WebSocket architecture

Rally keeps a small set of long-lived WebSockets open so workspace state, the
Canvases and Sidekicks lists, and the open conversation's feed are already
available when a person navigates. Electron deliberately uses two client
transports: the singleton workspace connection stays in Chromium and carries
the Canvases and Sidekicks lists and running background agents, while each
open conversation's substream `0` feed is dialled by a Node broker in the main
process. The split
lets the desktop open a useful swarm in parallel without moving protocol state
or product caches out of the renderer.

A desktop's windows hold **one** workspace socket, in the main window: the
Settings window consumes it through main rather than dialling its own, and
dials only while no main window is publishing — see
[the Organization-sync relay](#one-workspace-socket-per-desktop-the-organization-sync-relay).
On macOS, with the menu bar item on, the main process holds a second, its own,
for the Canvases and Sidekicks lists behind the menu bar's attention count; it outlives every
window ([`menu-bar.md`](menu-bar.md#the-content)).

An automation's page uses the same feed socket kind: its conversation is
substream `0` under the automation, dialled through the same broker and the
same `/socket/conversations/:parentId/:substreamId` route, opened on demand
by that page rather than proactively, and with no control socket beside it.

The lite browser host forwards same-origin ticketed upgrades through a configured
regional API service binding. It returns the source upgrade directly, without
accepting a socket or relaying frames. The shared API client maps browser ticket
URLs to that route and preserves the ticket subprotocol. This implements the
transport boundary. A guest tab opens a standalone feed for the visible
conversation, plus one workspace socket per tab that it reads only for
`workspace_reach_changed`. A member tab runs the desktop shell and so opens the
same set the desktop does — the full workspace socket and the proactive feed
swarm — over native `WebSocket`s, with presence from page visibility and focus.
See [browser-client.md](browser-client.md).

`watchWorkspaceReach` in `@rally/contracts/workspace-reach-watch`, the
listen-only workspace socket for a host without one of its own, has had no
caller since Sideline was removed; it shares the desktop workspace socket's
heartbeat and reconnect numbers.

This document owns the end-to-end topology, connection-selection policy, process
boundaries, and lifecycle. [`realtime-sockets.md`](realtime-sockets.md) owns the
short-lived ticket, subprotocol, and server admission contract;
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) owns which product
data belongs on a socket; and
[`workstream-durable-object.md`](workstream-durable-object.md) owns the state and
protocol inside each Durable Object.

Conversation socket tickets also sign the contract-10 resolution-suggestion
capability. The room persists it across hibernation and adapts snapshot,
broadcast and replay delivery for older enum decoders; see
[conversation suggestions](conversation-suggestions.md#resolution-delivery-and-acceptance).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/lib/workspace-workstream-sockets.tsx` | Selects the active work stream, every pinned work stream, the five most recently active unpinned work streams, and any additional running work stream for proactive connection. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Owns the singleton native Chromium WorkspaceDO socket, workspace subscription, directory paging, replay, and outbound message-command queue. Its `relay` prop makes the main window publish what the socket hears and the Settings window consume it instead of dialling. |
| `apps/desktop/src/common/workspace-sync-relay.ts` | The relay's IPC channel names and message types, the `{ region, workspaceId }` comparison every hop uses, the preload's structural check, and the preload's inbox that holds news arriving before any listener. Dependency-free for the sandboxed preload. |
| `apps/desktop/src/main/workspace-sync-relay.ts` | Main's relay state: the closed Zod parse of what the main window publishes, which Organization is attached, the revision that orders source changes, and forwarding news only for the attached Organization. |
| `apps/desktop/src/main/workspace-sync-relay-ipc.ts` | The relay's two invoke channels and their sender checks: publish from the main window only, read the source from the Settings window only. `main/index.ts` registers it and owns the one receiver and the release points. |
| `packages/contracts/src/workspace-reach-watch.ts` | The listen-only workspace socket for a host without one of its own (no caller since Sideline was removed), and the heartbeat and reconnect numbers every workspace-socket client shares. |
| `apps/desktop/src/renderer/lib/conversation-admission.tsx` | Composes account and workspace-journey readiness independently of connection warming. |
| `apps/desktop/src/renderer/lib/workstream-socket-pool.tsx` | Owns one substream `0` feed per selected work stream above the route, retains recently viewed feeds for five minutes, and supports presence-free feed warming on deliberate hover. |
| `apps/api/src/durable-objects/workspace-resource-versions.ts`, `apps/desktop/src/renderer/lib/resource-heads.ts` | The one ledger of new resource versions, drained for `workspace_resource_versions` and the pinned-artifact announcement, and the client's merge of each announced head into the conversation details and popped-out windows that show it. |
| `apps/desktop/src/renderer/lib/channel-viewer-state.ts` | Writes the breakouts and running background agents each workspace-socket Channel row carries into the caches the Channel menu and composer read. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Owns the SubstreamAgent feed protocol, ticket request, snapshot/replay application, heartbeat, pagination, and reconnect state machine. |
| `apps/desktop/src/renderer/lib/realtime-socket.ts` | Presents a browser-shaped socket to the feed hook and maps Electron sockets onto one socket-ID-multiplexed preload listener. Browser development falls back to the native `WebSocket` constructor. |
| `apps/desktop/src/common/realtime-socket.ts` | Defines the closed IPC schemas for opening, sending, closing, and receiving brokered socket events. |
| `apps/desktop/src/common/realtime-socket-validation.ts` | Defines dependency-free channel names and strict main-to-preload event validation. |
| `apps/desktop/src/preload/index.ts` | Exposes only the typed broker operations to the sandboxed renderer and validates events arriving from main. |
| `apps/desktop/src/main/realtime-socket-ipc.ts` | Registers the main-window-only IPC boundary, parses every request, confines destinations, and relays broker events. |
| `apps/desktop/src/main/realtime-socket-broker.ts` | Owns Node `ws` connections, follows Electron's complete ordered system/PAC route and operating-system CA trust, supplies the Rally application Origin, enforces the shared frame ceiling, relays events, and terminates sockets with their renderer owner. |
| `apps/desktop/src/main/network-recovery.ts`, `network-recovery-ipc.ts`, `common/network-recovery.ts`, and `renderer/lib/network-recovery.ts` | One Chromium-session connection reset after repeated ticket timeouts, generation-fenced observations and the cross-window request barrier. |
| `apps/api/src/routes/socket.ts` | Receives public WebSocket upgrades and sends each accepted request through the correct regional Durable Object namespace. |
| `apps/api/src/services/socket-service.ts` | Issues and verifies purpose-specific socket tickets and constructs the clean upgrade subrequest. |
| `apps/api/src/durable-objects/workspace-do.ts` | Accepts the workspace synchronization/command socket through Cloudflare's hibernation API and publishes each Channel's row, with that viewer's breakouts and running background agents, on it. Still accepts the retired Channel control socket at the internal `/parent-socket` path, tagged `parent-control:<id>`, for clients released before this change. |
| `apps/api/src/durable-objects/substream-agent.ts` | Accepts the substream feed socket, sends the canonical snapshot, and publishes ordered transcript/runtime events. |

## Sidekick library synchronization

Each Sidekicks library renderer shares the existing workspace/session boundary
and listens to WorkspaceDO synchronization. The `automations` topic and the
pushed `automations` sidebar list invalidate the broader library and attachment
REST queries alongside detail and run (`automation-runs`) queries. This matters
when authoring happens in a different window: its local query cache cannot
invalidate the library's cache. A consuming window hears both through the
[Organization-sync relay](#one-workspace-socket-per-desktop-the-organization-sync-relay):
the main window relays each pushed `automations` list as the `automations`
topic, which is all a window that reads the detail surfaces and never the list
needs. No additional broadcast
channel or polling is involved.

Composer execution counts stay on the workspace socket as data. The
`sidekick_activity` client command replaces the socket's exact target set;
WorkspaceDO stores that set and its revision in the hibernating attachment,
re-admits each target, and sends `workspace_sidekick_activity` count snapshots.
The initial registration and every durable activity/default change push the
same shape. Reconnect re-registers open composers, unmount removes them, and
revision/waterline fences discard obsolete responses. Background-agent counts
already arrive in Thread viewer-state rows; neither composer indicator fetches
counts over REST.

### The topology

```text
Electron renderer
  |
  |-- native Chromium WebSocket -------------------------> regional Worker
  |       one WorkspaceDO sync/command socket                    |
  |                                                              +--> WorkspaceDO
  |
  |-- typed preload IPC --> Electron main --> Node ws ----> regional Worker
          one substream 0 feed socket per selected work stream   |
          one substream 0 feed socket for the open automation    +--> SubstreamAgent
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
authoritative directory and presence, and every Channel's complete metadata:
each Channel row it sends a viewer carries that viewer's breakouts and the
background agents running for conversations they can open. There is no
per-Channel metadata socket; the Channel control socket that used to carry
these is retired (see the 2026-09-25 changelog entry). The matching SubstreamAgent socket for the
addressed conversation supplies the canonical feed snapshot, ordered live
events, replay, older-page responses, and the private receipts for message and
conversation commands sent directly by the composer. WorkspaceDO's explicit
foreground signal is the sole source for current-client viewer presence; socket
warmth is not attention.

The singleton socket assigns a UUIDv7 to each connection attempt and reports
content-free opening phases through the desktop reliability telemetry path.
Its `subscribe` frame optionally carries that UUID. WorkspaceDO logs `accepted`
with a server connection ID, then `frame_received` once per socket before
initialization,
`subscribe_received`, `subscribe_authorized`, `sidebar_built`, `flags_resolved`,
and `sync_sent`. The latter phases carry both IDs. `accepted` has only the
connection ID because the room has not received the subscription yet; a
`frame_received` without `subscribe_received` narrows the stall to initialization
or frame validation.

An automation's conversation rides the same broker and the same route kind as
a work stream's feed, addressed by the automation id as the parent, but not the
same policy: it is opened by the automation's page, closed when that page
unmounts or the subject changes, and never warmed, retained, or pooled, because
an automation's chat is configuration work a person is either doing or not, so
there is no navigation latency to pre-pay. It has no control socket: an
automation parent serves no metadata snapshot.

Dictation sockets keep their existing transport and lifecycle. They are not
brokered by this module and are not part of the proactive work-stream swarm.

### One workspace socket per desktop: the Organization-sync relay

Every Rally window mounts `WorkspaceSocketProvider`, and the prewarmed Settings
and Sidekicks windows used to dial through it like the main window: a second
and third socket to the same WorkspaceDO for the whole session, a subscribe
answer carrying a full sidebar neither draws, and a copy of every push. The
relay replaces those sockets without a second protocol. Settings is its one
consumer since the Sidekicks window was removed (2026-11); only the
browser-import window still dials its own. This section is its one full
description; [`settings-window.md`](settings-window.md) and
[`security.md`](security.md) link here.

The protocol carries connection/topic updates and correlated conversation
preview requests and replies between the publishing and consuming windows.
Each names its Organization as `{ region, workspaceId }`,
because a workspace UUID is unique only within a region, and every comparison —
main's, the preload inbox's, the consumer's — compares both.

| Message | Direction | Carries |
| --- | --- | --- |
| `state` | main window → main (`workspace-sync:publish`) | The provider's connection state. Attaches it as the source. |
| `detach` | main window → main (`workspace-sync:publish`) | That provider unmounted with no successor. Ends the source if it is still the attached one. |
| `topics` | main window → main → Settings and Sidekicks (`workspace-sync:relayed`) | Topic names and the waterline they moved at. Besides the sync topics, the relay-only name `usage`. |
| `conversation_view_request` / `conversation_view_cancel` | consumer → main → publishing window | An exact conversation request or cancellation, correlated by request ID. Main accepts only trusted consumer windows and the currently attached Organization. |
| `conversation_view_response` | publishing window → main → consumers | A strictly parsed compact preview. Consumers accept only their pending request, Organization, and conversation. |
| `source` | main → Settings and Sidekicks (`workspace-sync:relayed`, and the `workspace-sync:source` reply) | `{ revision, source: { region, workspaceId, state } \| null }`. |

- **Publish (main window, `relay="publish"`).** The provider publishes its
  connection state on every change and the topics of every sync event that
  passes its waterline guard (the `initial` and `history_unavailable` answers
  included, which name every topic). A `workspace_feature_flags` push, which
  moves no topic, is published as the `feature_flags` topic, and so is a
  subscribe answer's flags when its topics do not already name it; the flag
  values themselves never cross, and the consumer refetches its own. A
  `workspace_sidebar_list` push of the `automations` list is published as the
  `automations` topic, the refetch that push amounts to for a window that does
  not hold the list. A `workspace_usage` push, and every subscribe answer, is
  published as `usage`, a relay-only name
  ([`usage-metering.md`](usage-metering.md)). Conversation preview replies are
  the only content-bearing exception; no
  sidebar, presence, directory pages or meter values cross. Pending preview
  requests are reissued after publisher handover and cancelled on navigation.
- **Detach on unmount, unless replaced.** The provider's cleanup publishes
  `detach` on a microtask, and only if no other publisher has mounted in the
  renderer since. An Organization switch — and StrictMode — unmounts a
  publisher and mounts its successor in one pass, so the successor's `state`
  replaces the source directly and a consumer never sees a gap to dial into. A
  tree that falls into the top-level error boundary, or a session that leaves
  every Organization, has no successor, so main hears `detach` and releases.
- **Relay (main).** `WorkspaceSyncRelay` parses each publication against one
  closed Zod shape (the untrusted edge), attaches the source on `state`,
  forwards `topics` only for the attached Organization, and ignores a
  `detach` for one that is no longer attached. It also releases the source when
  the main window closes, its renderer crashes, or it starts a main-frame
  navigation (a reload). Every source change carries a revision. It does not
  react to the session changing Organization: the main window's own
  publications say when its socket changes.
- **Consume (the Settings window, `relay="consume"`).** The provider asks main for
  the current source and listens for changes, keeping the higher revision.
  While the source is its own Organization it dials nothing, reports the
  source's connection state as its own, keeps `topicWaterlines` from the
  relayed topics (in Settings, the connector OAuth reconcile re-runs on
  `connector_oauth_attempts` there), and invalidates exactly what a socket's
  topic would — except `workstream_directory`, which names a socket-owned list
  neither window holds — and on `usage` reads its usage meter again. While the source is another Organization it
  waits, dialling nothing and reporting `connecting`: both windows follow one
  session but apply it at different moments (the window that asked for a
  switch applies it only after fetching the new Organization), so the main
  window is mid-switch and will attach or detach. Only no source at all makes
  it run its own socket, exactly as before the relay. Until main answers it
  dials nothing; the answer is one IPC round trip.

**Why nothing is missed.** The consumer listens for as long as it is mounted,
and the preload holds relayed topics that arrive before the listener exists
(folded: each topic once with the newest waterline, for one Organization, and
cleared only once a still-subscribed listener has taken them), so a read
started above the provider — account onboarding — is still covered. A read a
consumer window starts is answered by the server before any change made after
it; that change reaches the main window's live socket afterwards, is relayed
afterwards, and invalidates the read. If the main window's socket is not yet
subscribed (a cold start), its first answer is `initial`, which is relayed and
names every topic. Every hand-over starts the same way: when the main window's
socket goes, a consumer subscribes from waterline `0`; when one comes back, its
own `initial` is relayed. The two overlap rather than leave a gap, because the
consumer applies relayed news even while its own socket is still open.

**The trust boundary.** Only the main window may publish and only the Settings
window may read the source (`registerWorkspaceSyncRelayIpc`, behind the shared
trusted-sender check), and main sends relayed events to that window alone. Main is where parsing happens, because the main window's renderer is the
untrusted edge ([`security.md`](security.md)): the shape is closed, so an
unknown key is refused rather than dropped, and the refusal is a code naming
the field. What main sends on is built from that parse, so the preload checks
only the structure its inbox reads. Topic names, waterlines, an Organization
identity and a connection state cross, between two windows of one session; no
row, token, URL or flag value does.

**The main window's own first connect still reads twice.** It reads its
screens' REST queries and then invalidates them on the `initial` answer. That
second read is kept on purpose: a REST read that the server answers before it
processes the `subscribe` can miss a change made between the two, and nothing
on the client can tell such a read from one answered after. The only exact fix
is a sync waterline on each REST response to compare with the answer's, and
most of these reads (D1-backed members, connections) have none. The Settings
window no longer pays it, because while they relay they have no
`initial` of their own.

**When the source goes.** When the main window closes, crashes, reloads or
falls into the error boundary while a consumer window is open, that window dials
its own socket, whose `initial` answer refetches its reads once; when a main
window publishes again, the consumer closes it, and the new main socket's relayed
`initial` refetches them once more. Both are the price of missing nothing
across the hand-over, and neither happens in a steady session or on an
Organization switch. If main cannot answer the source read, the consumer
treats it as nobody publishing and dials its own socket. If the main window
stays attached for another Organization for good — a switch it never applied —
a consumer waits with no socket; its REST reads still work, but nothing
invalidates them until the main window attaches, detaches or goes.

### Selecting the swarm

`WorkspaceWorkstreamSockets` derives one background set from the current WorkspaceDO-owned
directory. The first workspace sync includes every visible running row in
addition to its 250-row recent page, so an old active run cannot fall outside
the client's candidate set:

- every pinned work stream;
- the five most recently active unpinned work streams; and
- every work stream whose harness status is `running`.

The active route is included independently. IDs are de-duplicated, so a pinned,
running, and recently active work stream still owns exactly one feed. Pin order affects the sidebar but does not sequence connection attempts.
There is no separate guessed connection ceiling: the product-selected set is
the set the pool opens.

Cold startup mounts the workspace socket alongside the workspace profile query,
using the restored session's workspace identity. The main window's pool mounts
at the same time, above the profile loading state and inside the onboarding
admission boundary. Its
first directory snapshot can therefore start the opening conversation while the
profile request is still pending. On the root route, the pool adds the same
pin-then-viewer-recency candidate that the landing will choose, including one
outside the five recently active rows. Explicit conversation links warm their
own target; the New route does not become a landing. Secondary windows do not
mount this pool.

The pool and resume state remain mounted when the profile resolves. Its directory
observer only subscribes to cache writes: it registers no query function or
independent pagination state. A route
alone does not mark a feed opened: the conversation's mounted consumer must admit
it, and pending account/journey lookups must also permit conversation admission.
Until then, tickets remain speculative and sending stays disabled. Profile failures disable the pool's API, and changing the account/workspace
scope replaces the workspace connection and every pooled owner. Each connection
still obtains its own authorized ticket; starting earlier bypasses no access check.

When a work stream leaves the active route, its exact feed remains mounted for
five minutes. It stays longer when it still qualifies as pinned, recent, or
running. A one-second deliberate pointer hover may add one SubstreamAgent feed
for an otherwise-cold row. The feed subscription is presence-free, so transport warmth does not claim that the
person is viewing the row or clear its unseen marker. When navigation commits,
the renderer promotes that same admitted socket with `mark_opened`; no new
ticket, handshake, or snapshot enters the paint path.

### Opening a feed

The feed hook requests its purpose-specific 60-second ticket over authenticated
HTTP, then immediately hands the clean URL and `[rally.ticket.v1, ticket]`
protocol offer to the browser-shaped adapter. The Channel's metadata is already
on the client as its workspace-socket row, so nothing else is asked for.
Foregrounding the Channel sends `set_presence` on the workspace socket, which
also wakes the Channel's Main ahead of the feed's arrival.
For the main feed, the Worker also starts a best-effort ticket-scoped
SubstreamAgent preparation without awaiting it, so admission and snapshot work
can overlap the ticket's return trip and native handshake. A room retains only
the newest admission and newest completed snapshot; a newer ticket replaces
them, so speculative traffic cannot grow room memory.

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
when the resolved policy included it. Every client and server feed
frame is bounded to the shared 1 MB protocol ceiling. A direct route reports
PAC resolution, DNS, TCP, TLS, and edge upgrade separately. A proxy route
reports its CONNECT/TLS/edge work as one aggregate because Node's proxy agent
does not expose truthful boundaries inside the tunnel. The broker therefore
avoids Chromium's handshake queue without silently bypassing a managed network,
interception certificate, or fallback policy.

In browser development, the same adapter uses the native `WebSocket`
constructor. That path preserves development compatibility but does not provide
the Electron swarm's independent Node handshakes.

### Server acceptance and hibernation

The regional Worker validates the route, upgrade, Origin, ticket signature,
audience, region, and target identity. It strips the bearer ticket before
forwarding the upgrade and passes only verified identity and the ticket ID to
the target object. A feed ticket additionally carries a signed role and
authority generation. If its in-memory preparation still matches every claim
and the object's local generation, SubstreamAgent reuses the session/membership
decision prepared from D1 during ticket transit and, when safe, its prepared
snapshot. Both prepared and fallback paths still read current regional
authority because maintenance can close a generation in place. Either way the
object enforces local visibility, consumes the ticket ID once, accepts the
server socket, and serializes the attachment needed after eviction.

WorkspaceDO (for the workspace socket, and the retired Channel control socket older clients still open) and SubstreamAgent use Cloudflare's
[WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
Idle objects can be evicted while the platform keeps their sockets connected;
incoming application frames wake the object and recover connection identity
from serialized attachments. Exact `ping` frames are answered by the runtime's
auto-response facility without waking the object. The client therefore keeps
useful sockets warm without requiring an always-running Durable Object instance.

### Who the workspace socket tells, and how often

Every workspace socket in an Organization lands in one `WorkspaceDO`, so each
send that object makes is decided per socket. Two kinds of send carry most of
the traffic, and neither goes to every socket by default.

**A Channel's row** (`workspace_workstream_state`) goes to:

- everybody who can see the Channel now, for a change to the Channel itself
  (its common row, its facepile, its breakout total, its running agents); a
  Channel is seen when it is not archived and is either Organization-wide or
  the person is one of its participants at the Channel's authority generation;
- the one person whose own row moved (unread, mention, breakout list), if they
  can see it;
- **the people the write may have taken the Channel from**, who are sent the
  row if they still see it and the `workstream: null` tombstone if they do not.

Nobody else is sent anything. A tombstone to someone who never saw the Channel
would name a private Channel and say when it moved, and it has no job to do on
the client: the desktop's receiver removes the row, and there is no row to
remove. The people who may have lost a Channel are named inside the
directory transaction, against the rows as they were before it, because once
the batch commits "who could see it a moment ago" is no longer answerable, and
a follow-up can run long after its write (the alarm retries one that failed).
They are carried in the directory follow-up (`channelLosses`) as user ids,
never as "everyone": expanded against whoever is connected when the follow-up
runs, "everyone" would send a Channel's tombstone, and so its id, to a member
who joined after the write and never had it.

| What the write did | Who is owed the tombstone |
| --- | --- |
| A viewer row stopped being a participant, or was deleted for a person who is no longer an active member | That person. |
| The Channel was archived | Everyone who could see it (`channelReadersBefore`): its participants, and for an Organization-wide Channel every member socket subscribed at the write. |
| An Organization-wide Channel narrowed to its participants | As for an archive; the participants still see it and get the row. |
| A new authority generation replaced the row | As for an archive; each participant's row reappears when their viewer row arrives at the new generation. |
| A person left the Organization (`applyMemberStatus`) | That person, for each Channel they sat in; their socket stays open until the revocation walk closes it. |

The subscribed sockets stand in for an Organization-wide Channel's readers
because they are exactly the people holding it: a member with no socket is
answered, when they connect, with a sidebar that already reflects the write,
and `workspace_member_status` cannot list every member, since it learns one
from before it existed only when something asks.

`channelLosses` is required and holds only user-id lists. A follow-up in an
older shape (one recorded before the field existed, or one holding `"all"`)
does not parse, so it is kept as `failed` and logged
`directory_followup_unreadable`, like any other unreadable row. Every
production Organization was checked before the fallback that read those shapes
was removed, and none held one.

Each person's rows are **built once** for all of their sockets and all of the
Channels they are owed, from one set of reads, and sent to each socket.
Whether each person can see each Channel is decided from two reads for every
planned Channel together, so a person who cannot see a Channel costs nothing.

The rows are **coalesced per post-commit pass.** A batch of child effects
applies each envelope in its own transaction and records a follow-up per
envelope; the pass (`runDirectoryFollowUps`, reached through
`afterParentWrite`) collects every Channel those follow-ups touched, and the
hosted parent's own republish (a breakout roster or the running agents moving)
joins the same plan, so a turn's burst of changes sends each Channel once per
socket. The sync topics the pass's activity records moved are published once
the same way. Nothing here waits on anything: the plan is sent synchronously
after the last follow-up ran, with no `await` or round trip added to the
request.

**The rows are best effort, and never hold a follow-up back.**
`publishChannelRows` does not throw: a person whose row cannot be built is
logged (`channel_row_publish_failed`, with the reason's code) and skipped, and
everybody else is still sent theirs. A follow-up that ran is deleted whatever
the sends did, because re-running it would repeat its reconciliations,
archival notices and presence broadcast to re-send a row, and a socket that
missed one is answered with the current sidebar when it reconnects. The pass's
sync topics are the durable part: if publishing them throws, they are recorded
as a follow-up of their own (`directory_followup_sync_deferred`), and only
they are retried.

**A sync topic** (`workspace_sync`) goes to everybody unless its event names an
audience, live and on replay; how an event names one, and each topic's
audience, are in
[`realtime-sockets.md`](realtime-sockets.md#electron-connection-topology).

**A resource's new version** (`workspace_resource_versions`) goes to every
socket whose person may open a Canvas the resource is an artifact of
(`canvas_artifacts`, written by the publish that attached it;
`canvasReaderAllows` decides who may open it). A resource no Canvas lists is
not announced here; its conversation's socket still sends `resource_updated`.
An unlisted resource is never named. It covers every resource
type and every producer, because versions are only ever written by the
`resources` triggers: a trigger on `resource_versions` notes each new version
in `workspace_resource_version_changes` (WorkspaceDO migration 114), and the
write hook that drains the Channel rail's ledger drains it too, after the
write's transaction. It is the one ledger of new versions: the same drain
feeds the pinned-artifact announcement, which keeps only the causes a pin
counts as news ([`workstream-pinning.md`](workstream-pinning.md#artifact-pins)).
Each person's payload is built once for all of their sockets. It carries each resource's head (version, title, MIME
type, update time, whether content exists, size) and nothing about how a
conversation links it, so the client merges it over the resource it holds.

It is off the waterline and never replayed. A client that was away learns the
head from the conversation's snapshot when it next opens it. On the client, every
head the window hears is recorded (`RESOURCE_HEADS_QUERY_KEY`), whether the
workspace socket announced it or a conversation's own snapshot or resource
event carried it. `applyResourceHeads` moves `currentVersion` in every cached
conversation detail that holds the resource at an older version, and
`followResourceHeads`, installed by the workspace socket provider, does the
same after every later write of a detail, so a delayed `resource_updated`, a
snapshot, a REST answer or the local cache can never put an older version
back. Every preview keys on `currentVersion`, so an open panel, a site preview
and the version list reload.

The app shell is the only place that refreshes a popped-out window on a new
version: it reads the recorded heads, with one in-flight set and one abort
signal held for the session. A refresh owned by a conversation screen could be
cancelled when the person left it, after another caller had already stood down
for it. After every reconnect but the first, the shell also reads the current
version of each open window's artifact, because versions written while the
socket was away are not replayed.

### Reconnect and teardown

The control and feed state machines reconnect independently with their existing
jittered backoff. A failure in one does not delay the other's ticket request or
handshake. Snapshot waterlines and replay rules decide whether a reconnected
frame advances cached state; transport warmth is never treated as authority.
Every workspace, control, and feed attempt acquires its ticket through the same
bounded request primitive. Workspace, control, and an already-open feed use the
existing 10-second request boundary; a feed still opening uses that attempt's
existing 10/20/40-second whole-open budget so ticket acquisition cannot defeat
the cold-open ladder. The boundary rejects its caller and aborts the underlying
fetch independently: shared credential renewal or a transport that does not
settle after cancellation therefore cannot leave the loop's in-flight guard set
forever. Timeout is a retryable `ticket_timeout`, distinct from a ticket response
that fails normally and from an offline transition. Owner teardown and an
explicit offline transition abort the same attempt immediately. Transcription
remains outside this persistent-socket boundary because capture owns that
short-lived request's cancellation and timeout lifecycle.

Normal route changes do not destroy a retained owner. Each socket owner also
retains its query entries while mounted, independently of screen observers. The [local-cache contract](local-cache.md#a-live-subscription-owns-its-in-memory-state)
owns those lifetimes and explicit eviction. A full main-frame
navigation, reload, or window close calls `closeOwner` with the renderer's
`webContents` ID and terminates every Node socket belonging to it. A renderer
crash performs the same owner teardown. An ordinary socket close removes that
socket ID from both main and renderer routing tables; invalid close codes or
oversized UTF-8 reasons are rejected before IPC and a native close exception
terminates and forgets the affected socket.
Server access revocation remains terminal and prevents the affected state
machine from reconnecting.

Application foreground is also a recovery edge for the visible conversation
and for any unresolved conversation command. The renderer listens to main's application-focus signal rather than
document visibility alone, because a visible window can lose application focus
without becoming hidden. An already-closed feed bypasses its throttled reconnect
timer immediately. An open feed replays the unresolved operation IDs once more,
requests a single-flight canonical snapshot, and probes liveness without
replacing an older pong deadline. A visible feed without pending commands still
probes liveness or bypasses reconnect backoff; background-only feeds do nothing.

Every attempt is bounded by the existing opening policy. A warm feed accepts
ordered application replay over its canonical cache; pongs alone cannot finish
opening. Empty replay has no completion marker, so a pong-responsive connection
with no application state by its deadline gets one `request_snapshot` fallback
and one more opening budget. This preserves cheap replay without racing its
first event against a platform auto-pong. Snapshot assembly must finish,
including pending-input chunks, before confirming the ticket as live. Abandoning
either chunk assembly resets the subscription cursor: chunks share the snapshot
sequence and cannot be replayed after that sequence.

Ownership is retired before close on timeout, resync, offline, and suspend;
late events and obsolete ticket completions cannot affect replacements. Resume
redials, browser restoration supplies equivalent lifecycle signals, and activating
a retained conversation probes it independently of its sticky admission state.
A previously synchronized feed keeps retrying even if replacement context chunks
are incomplete. Cold opens retain the three-attempt policy. **Reconnect now**
keeps pending command IDs; explicit retry after terminal failure or revoked
access restarts the owner to re-check admission. Automatic access retry stays off.

Organization and shared main-process watchers use the existing 15-second opening
policy for their handshake and initial subscription state; shared watchers also
bound ticket acquisition. Pongs never clear the sync deadline. Backoff resets
only after application state arrives, and every transport failure reports its
cause before retirement. Offline/suspend telemetry requires an active attempt.

### Desktop network recovery

Socket retries alone cannot replace Chromium's shared connection state. On the
desktop, two consecutive online ticket timeouts for the same ticket path escalate
to `session.defaultSession.closeAllConnections()` in main. The user chose this
trigger on 2026-10-05 because a reset interrupts other Chromium requests. An
accepted ticket or a non-timeout outcome clears only its own path's streak: healthy Organization traffic
must not mask a selectively stalled Channel. HTTP errors, owner cancellation and
explicit offline timeouts do not count. The whole-open deadline identifies a
ticket timeout explicitly when it aborts ticket acquisition.

Main owns one recovery state for all Rally windows. It increments the generation
before resetting, publishes `resetting`, and records the escalation before
discarding connections. Each renderer aborts pending HTTP attempts from the old
generation to abandon retries racing the reset when IPC arrives; delivery is asynchronous
and is not an acknowledgement barrier before the native reset.
Preload retains this state before React subscribes and
ignores stale IPC replies. New windows wait for their initial state before
starting requests. New API requests wait during the reset; ticket
requests wait before starting their request-local deadline. Cancellation still
settles a waiting owner. After the reset completes or fails, main publishes
`awaiting_live` and normal reconnect loops resume with their existing backoff.
Only a usable conversation snapshot (including its context chunks) or an applied
Organization sidebar or a validated sequenced import-feed frame from a ticket acquired
in the new generation marks recovery
complete and rearms escalation. A ticket or a transport open alone does not.
Old requests and old sockets cannot rearm it, and an unresolved outage does not
cause repeated connection resets.

This operation preserves windows, login, IndexedDB, drafts and transcript caches.
Healthy Node-brokered feeds remain open. It neither retries interrupted REST
mutations nor changes the existing socket command reconciliation contract. The
ordinary failure surface remains available if the connection reset is insufficient.
The browser client retains its existing reconnect behavior.

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
the pool, cache keys, telemetry, and tests. Add only the eligible feed
sockets: the Channel's breakout list already rides the workspace socket, so a
child needs no metadata socket of its own.

An additional substream is a good proactive candidate when it is the selected
substream, has an explicit user-retention signal, is producing live output the
current UI promises to keep current, or was recently viewed under an approved
retention policy. Do not connect every known substream merely because the Node
broker can launch them concurrently. If multiple children qualify, start their
ticket requests and handshakes independently, preserve one owner per tuple, and
measure selection-to-visible-feed for that substream rather than treating an
open transport as success.

## Invariants

- **Each selected work stream owns at most one substream `0` feed socket, and
  no socket for its metadata.** Duplicate owners would spend one-use tickets,
  duplicate snapshots and events, and make reconnect state race itself. A
  Channel's metadata, breakouts and running agents are its row on the workspace
  socket; a per-Channel metadata socket would bring back the second copy of
  that row this topology removed.
- **A Channel's row reaches only the people who can see the Channel, and the
  people a write just took it from.** A null row sent to anybody else names a
  private Channel and when it moved; a tombstone withheld from somebody who
  lost the Channel leaves it on their screen. A new way to take a Channel from
  someone has to add them to the batch's `channelLosses`, by user id and read
  inside the batch's transaction, or it has to be one of the transitions
  `applyDirectoryEnvelope` already compares.
- **A Channel row never holds a directory follow-up back.** A failed row send
  is logged and skipped; making it defer the follow-up re-runs every
  reconciliation and notice in the pass on each alarm retry, for a row the
  next reconnect would send anyway.
- **A per-person sync event is stored with its audience and replayed only to
  it.** Replaying it to everyone after a reconnect would undo the live send's
  narrowing for every client that was briefly away.
- **Nothing sits on the click-to-feed path but the feed.** The Channel's row is
  already on the client when the feed is asked for, so opening waits for no
  metadata.
- **Main owns transport, not product state.** Moving caches, replay, or protocol
  decisions into main would create two application state machines and make
  browser development behave differently from Electron.
- **The addressed substream socket owns child conversation commands.** Treating
  feed-ready as delivery acknowledgement would confuse feed visibility with
  command admission and server persistence. WorkspaceDO remains the directory
  and presence authority; it does not relay child messages.
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
  lowering the 1 MB bound in only Node, the hosted Channel parent, or SubstreamAgent creates a
  transport-dependent protocol and must not be done.
- **A brokered socket kind is a closed enum with its own route shape.** Adding
  one means adding it to `DesktopRealtimeSocketKindSchema` *and* to
  `validSocketPath`, which is what keeps the renderer from turning main into a
  general network client. A kind whose path check falls through to the
  work-stream branch would accept a URL its own protocol never uses.
- **The Organization-sync relay: one socket per desktop, no gap at a hand-over, names
  and never state.** A consumer dials only while main reports no publisher;
  it listens for its whole life and a fallback socket subscribes from `0`;
  a publisher that goes without a successor detaches; identities compare
  region and UUID together; and only topic names, waterlines and a connection
  state cross. The reasons are in
  [the Organization-sync relay](#one-workspace-socket-per-desktop-the-organization-sync-relay).
  A window that needs a socket-owned list needs a socket of its own; a consumer
  may read only what the relayed topics refetch. Sidekicks qualifies because the
  main window relays its pushed `automations` list as a topic.
- **A conversation that is not pooled must not be given the pool's lifecycle.**
  An automation's feed follows its page. Retaining it for five minutes the way a
  work-stream feed is retained would hold a conversation open after its author
  navigated away, for a latency nobody is waiting on.
- **A reader of a socket-owned cache entry never brings its own fetcher.** An
  observer that only reads an entry the socket fills passes `fetchThroughOwner`
  (`lib/fetch-through-owner.ts`), which runs the fetcher of the observer that
  has a real one. TanStack copies each observer's options onto the query as it
  renders, so a placeholder `async () => undefined` became the query's fetcher
  whenever its reader rendered last, failed the next invalidation ("Query data
  cannot be undefined"), and left the list never read again. Guard:
  `lib/fetch-through-owner.test.ts`.
- **A change that arrives as a push does not invalidate the work-stream
  list.** Invalidating it is a whole Space walk, and a walk answered before
  WorkspaceDO had a thread's new title put the old one back. Keep it for the
  debug toggle, a connect that carried no rows, imports and Sidekick runs.

## Boundary

This module owns which Rally sockets exist concurrently, which Electron process
owns their transport, how brokered events cross IPC, and when pooled sockets are
retained or released. It exposes a browser-compatible `RealtimeSocket` contract
to the conversation feed hook, for either kind of parent.

It does not own ticket claims, expiry, replay prevention, Origin policy at the
Worker, or upgrade negotiation; those belong to
[`realtime-sockets.md`](realtime-sockets.md). It does not decide the contents of
snapshots or events; those belong to the Durable Object modules. It does not
define cache waterlines or choose sockets over REST; see
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md). It also does not
move the workspace synchronization socket or dictation transport into Node.

## Failure modes and limits

- **Ticket request fails:** that socket remains unavailable and its renderer
  state machine retries with jitter. Other feeds proceed independently.
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
- **The main window's socket goes while Settings or Sidekicks is open:** that
  window dials its own and refetches once each way; see
  [the Organization-sync relay](#one-workspace-socket-per-desktop-the-organization-sync-relay).
- **A browser member tab opens the swarm one handshake at a time:** with no Node
  broker, Chromium's same-endpoint scheduling serializes it, and each ticket is a
  cookie resolve and a token mint through the browser adapter. Every open tab
  holds its own swarm; nothing coordinates tabs, by product decision
  ([PRD](PRDs/2026-10-03_full-browser-client/prd.md), decision 3). A tab
  Chromium freezes reports `suspended` through the Page Lifecycle `freeze`
  event and `resumed` on `resume`, so the workspace socket closes and redials as
  the desktop does around sleep. The feed swarm does not listen for either: a
  feed socket that died while frozen is found by its 45 to 55 second heartbeat,
  which is also the desktop's behaviour around sleep.

## Testing

Unit and integration tests do not prove Chromium's native connection reset; that requires real Electron.

| Suite | Command | Covers |
| --- | --- | --- |
| Main, common and IPC network recovery suites | `pnpm --filter @rally/desktop exec vitest run src/main/network-recovery.test.ts src/common/network-recovery.test.ts src/main/network-recovery-ipc.test.ts` | Streaks, reset coalescing, generations, live rearming, state ordering and trusted IPC validation. |
| Renderer network recovery and import run suites | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/network-recovery.test.ts src/renderer/lib/session-import-run.test.ts` | Initial state barrier, ticket deadlines, delayed IPC, cancellation through streamed bodies, and import live confirmation. |
| `apps/desktop/src/main/realtime-socket-broker.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/main/realtime-socket-broker.test.ts` | Destination confinement, ordered PAC fallback, shared payload limit, event relay, normal close cleanup, sends, and renderer-owner teardown. |
| `apps/desktop/src/main/realtime-socket-ipc.test.ts`, `apps/desktop/src/common/realtime-socket-validation.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/main/realtime-socket-ipc.test.ts src/common/realtime-socket-validation.test.ts` | Shared channel wiring, main-window authorization, request confinement, broker relay, and strict dependency-free event validation. |
| `apps/desktop/src/common/workspace-sync-relay.test.ts`, `apps/desktop/src/main/workspace-sync-relay.test.ts`, `apps/desktop/src/main/workspace-sync-relay-ipc.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/common/workspace-sync-relay.test.ts src/main/workspace-sync-relay.test.ts src/main/workspace-sync-relay-ipc.test.ts` | The preload inbox folding news that arrives before a listener and keeping it for the listener that replaces one unsubscribed before it could take it; main refusing a malformed or open publication with the field named, attaching, forwarding only the attached Organization (the same UUID in another region is another one), ignoring a stale detach, releasing once, and ordering by revision; each IPC channel refusing every window but its own. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx` (`the organization-sync relay between windows`) | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/workspace-socket.test.tsx` | The main window publishing state and every topic (`initial` included, a flag push as `feature_flags`, an `automations` list push as `automations`); detaching when unmounted with no successor and not across a switch or StrictMode; a consumer with a live publisher asking for no ticket, reading once, and refetching on relayed topics for its own region and UUID only; dialling only while nobody publishes, closing when somebody does, resubscribing from `0` after; and waiting, socketless, while the publisher serves another Organization. |
| `apps/desktop/src/renderer/lib/realtime-socket.test.ts` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/realtime-socket.test.ts` | Browser-shaped state/events, IPC calls, and one multiplexed preload listener for a socket swarm. |
| `apps/desktop/src/renderer/lib/workstream-socket-pool.test.tsx` | `pnpm --filter @rally/desktop exec vitest run src/renderer/lib/workstream-socket-pool.test.tsx` | Feed ownership with no Channel control ticket ever requested, route retention, expiry, overlap, speculative feed warming, and navigation promotion. |
| `apps/api/test-workers/workspace-socket-fanout.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/workspace-socket-fanout.test.ts` | Who the workspace socket tells, on real sockets: a private Channel's change reaches nobody outside it; the tombstone reaches a removed participant, the readers of a narrowed or archived Channel, every reader of an Organization-wide Channel re-generated for its participants, the participants of a re-generated personal one, and a member who left the Organization, and nobody who never saw the Channel, including a member who joined before a held follow-up ran; one person's two sockets get the same row, built once (a counting wrapper on `channelRowPayloads`); a burst of five changes in one delivery, and two held follow-ups run in one pass, are one row per socket; a row that cannot be built for one person still reaches the others and the follow-up is deleted; a per-person topic and a personal connection's change reach their audience alone, live and on replay, and a replay answers at the log's waterline; an Organization connection's change reaches everyone; a route's `noteChangedConnection` reaches the middleware's publish. |
| `apps/desktop/src/renderer/components/app-shell.test.tsx` | `pnpm --filter @rally/desktop exec vitest run src/renderer/components/app-shell.test.tsx` | Active/background selection, including all pins, five recent unpinned rows, and additional running rows. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/durable-object-runtime.test.ts` | Real-workerd upgrade, hibernation, attachment, snapshot, replay, read-only feed, and revocation behavior. |

The broker tests use a socket factory double because they prove Electron
ownership and event routing, not workerd behavior. Upgrade construction and
hibernation assertions belong in `apps/api/test-workers/`; Node's `Response`
cannot represent a real status-101 response and cannot prove Cloudflare runtime
semantics.

The broker's destination-confinement cases name the one brokered route kind,
the conversation feed, and refuse the retired Channel control path under either
kind name; an automation's feed is the same kind with an automation id in the
parent position, so it is covered by the same path check.

For a manual acceptance check, run the local regional Worker and Electron client
as described in [`dev-environment.md`](dev-environment.md), sign in, and inspect
the Worker output. Each proactively selected work stream should produce one
`101` for `/socket/conversations/:id/0` and none for `/socket/workstreams/:id`
(no `GET /workstreams/:id/control-socket` ticket either). Opening a row whose
feed was proactively warmed should render its feed and enabled composer without
new connection setup. A hover-warmed feed requires no new connection on
selection. A local model credential is required only to complete inference
after a send, not to verify socket or WorkspaceDO command admission.

## Regional impact

The renderer obtains ticket URLs from the workspace's existing regional API
client, and main accepts only origins derived from the configured configured deployments
API base URLs. The broker neither chooses nor changes a workspace's region. The
regional Worker verifies the ticket's region before resolving the Durable Object
binding, and no socket payload crosses between configured deployments.

## Security and trust model

The sandboxed renderer is untrusted at the IPC boundary. Main accepts realtime
socket operations only from the primary Rally window, parses every operation,
and keys authority to that window's `webContents` ID. An open URL must use
`ws`/`wss`, match a configured regional origin exactly, contain no username,
password or fragment, and match the path declared for its kind — one of
the Channel control or SubstreamAgent shapes. Query data is discarded before the
connection opens; it never selects a protocol capability. The first protocol
must be the public ticket sentinel;
main supplies `app://rallywithai` as Origin and accepts no renderer-selected
headers.

The Organization-sync relay is a separate, narrower IPC path, described with
its sender checks and what may cross in
[the Organization-sync relay](#one-workspace-socket-per-desktop-the-organization-sync-relay).

Network recovery accepts observations only from existing trusted Rally renderers.
Its closed schema admits a generation, a ticket path without query values, and
one declared outcome. The renderer cannot choose a reset destination, headers,
credentials or a storage operation. Recovery state broadcast to windows contains
only the generation and phase.

The signed ticket remains confined to the `Sec-WebSocket-Protocol` request
header. It is not put in a URL, returned in an event, or logged. The Worker
echoes only the public sentinel. See [`security.md`](security.md) for the wider
Electron trust boundary.

## Operations

On macOS, `desktop_network_recovery` records in Unified Logging carry the recovery
generation, timeout count and phases `ticket_timeout`, `reset_started`,
`reset_finished`, `reset_failed` and `live_restored`. They contain no request URL,
ticket, credential or message content. The existing OS retention owns persistence;
recovery adds no raw Chromium NetLog collection or new retention budget.

Client `workstream_socket_started`, `realtime_socket_state`, and
`renderer_perf_flow` records identify socket kind, reason, lease, and opening
phase without message content. `renderer_perf_flow` is uploaded only for
click-scoped opening attempts; speculative and retained background socket work
remains in the local performance log rather than polluting user-visible open
percentiles. For packaged macOS builds, governed renderer performance records
also appear in Unified Logging. The `workstream_open` `handshake` phase spans
renderer-to-main IPC plus the network/Worker/object upgrade. Its direct-route
PAC, DNS, TCP, TLS, and edge-upgrade annotations locate that total; proxied
attempts expose one aggregate. Chromium NetLog no longer contains Channel control
and SubstreamAgent handshakes.

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
the renderer starts each feed's ticket request and protocol state machine in the
same render lifecycle. This improves readiness only when work streams are opened
after the proactive feed has reached snapshot-ready state; it does not eliminate
Durable Object wake or snapshot assembly.

The cost of warmth is one client connection and one initial snapshot per
selected work stream. Cloudflare hibernation allows the idle server objects to
stop accruing active compute duration while their sockets remain connected, but
each initial connection, reconnect, wake, and delivered application frame still
uses platform resources. The selection policy bounds recency to five unpinned
rows while intentionally leaving pins and active runs uncapped because those are
explicit product states rather than speculative guesses.

## Changelog

### 2026-11-07 — A new version is announced to a Canvas's readers, and narrowing a Canvas clears presence

**What changed:** `workspace_resource_versions` reads which Canvases list a
resource from `canvas_artifacts` instead of `workspace_workstream_resource_links`,
and `canvasSetAudience` re-broadcasts presence, so someone a narrowed Canvas
no longer admits stops being shown in it and is backgrounded. The unused
`publishNavigationState` (the `workspace_navigation_state` sender) is gone.

**Why:** Only the retired Thread directory projection wrote
`workspace_workstream_resource_links`, so after plan step C-2 no Canvas
artifact's new version reached an open preview. Presence was re-checked only on
socket changes and revocations, never on a Canvas's audience, so a person
removed from a Canvas stayed listed in it. The restored runtime tests
(`workspace-resource-versions.test.ts`, the presence case in
`durable-object-runtime.test.ts`) were what showed both.

### 2026-11-07 — Settings is the relay's only consumer

**What changed:** The Sidekicks window is gone (plan step B-2 of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)),
so main relays the Organization sync to the Settings window alone, and only it
may read the source.

**Why:** Sidekicks moved into the main window, which holds the socket. The
relay is kept rather than deleted because Settings still consumes it: deleting
it would give the prewarmed Settings window its own socket again for the whole
session, the cost the 2026-09-26 entry removed.

**Consequences:** The relay's consumer list is one window; a second secondary
window that reads workspace state joins it the way Sidekicks did.

### 2026-11-06 — The iOS client is deleted

`apps/ios` and its navigation-shaped retain set are gone. `/parent-socket`,
`WorkstreamControlSocketService` and `GET /workstreams/:id/control-socket` were
kept partly for iOS; they now serve only desktops released before the
workspace-socket breakout list, and their removal is a later phase of the
[Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md).

### 2026-10-21 — Push exact-target Sidekick counts to open composers

Composer Sidekick activity registers its receiving targets on the existing
workspace socket and receives count snapshots, just as background-agent counts
already arrive as socket-owned state. WorkspaceDO holds the execution
projections and target admission, so invalidating a REST query would spend an
extra round trip to the same authority on every transition. Watched targets and
their revision survive hibernation in the socket attachment; reconnect
re-registers, unmount removes targets, and snapshot waterlines fence stale
responses. The durable post-commit lane covers execution, attachment, audience,
and Channel-default changes without a new socket or directory-list fan-out.

Pull request: [#1399](https://github.com/juno-ai-labs/avalon/pull/1399).

### 2026-10-20 — Relay conversation previews into Sidekick windows

The compact conversation cache would otherwise work only in the window owning
the Organization socket. The existing relay now carries correlated preview
requests, cancellations, and allowlisted replies so Sidekick conversations can
paint before their live socket attaches. Main checks the consumer sender and
attached Organization; a replacement publisher retries pending requests and a
late reply cannot repaint a cancelled conversation.

### 2026-10-19 — Recover transport and application state across network and power changes

**What changed:** Bounded every feed attempt, fenced stale ticket completions,
and retired failed transports without waiting for close. Added read-only
foreground/activation recovery, power/browser restoration, initial subscription
watchdogs, and **Reconnect now**. Warm feeds accept cheap replay, with a delayed
snapshot fallback for an otherwise silent subscription.

**Why:** Cached content disabled the opening deadline, focus recovery required a
pending mutation, and several paths depended on a close event that might never
arrive. Auto-pongs could hide a missing application subscription. These gaps
left readers on “Waiting to reconnect…” indefinitely.

**Considered and rejected:** App reload discards unrelated state; parallel REST
history duplicates socket authority; snapshot-on-first-pong defeats cheap replay.
Recovery reuses the existing timing policy. Preserve pending command IDs, keep
warm recovery alive through partial chunks, require application state for live
confirmation, and keep automatic access-revocation recovery terminal.

### 2026-10-19 — A new version reaches a Channel's readers

**What changed:** `workspace_resource_versions` also goes to each person who
reads a Channel a merge shared the resource with (an `authorization_locations`
row with `parent_kind = 'space'`), decided by the Channel's own `reach`.

**Why:** A merge now shares its embeds with the Channel, and a reader who
cannot open the thread opens them in the Channel's panel. Gated on threads
alone, that panel never heard of a new version and kept showing the old one.

**Consequences:** The read is by `resource_id`, which
`authorization_locations_resource_idx` serves, and `reach` runs once per
person and Channel. Any further place a resource can be shared needs its
readers added here too, or its previews go stale.

### 2026-10-18 — Every new resource version reaches its open previews

**What changed:** WorkspaceDO sends `workspace_resource_versions` on the
workspace socket when any resource gets a new version, to each person who may
open the Main of a thread linking it. The desktop and browser clients record
every head they hear and hold each cached conversation detail at it, which
reloads inline previews and site previews. The app shell alone refreshes
popped-out windows from those heads, even when their conversation is not on
screen, and rereads them after a reconnect.

The pinned-artifact ledger (migration 111) became this one: migration 114
renames its table and replaces its pins-only trigger with one for every
resource, and the drain hands each reader what it needs, every version to the
previews and the published or replaced ones to the pins.

**Why:** A preview learned of a new version only from the conversation
socket's `resource_updated`. That event goes only to the room that produced the
version, and image edits, connector refetches and derivative re-ingests never
send it. A popped-out window refreshed only while its conversation was mounted.
So a preview open anywhere else stayed on the old version.

**Considered and rejected:** Making every producer send `resource_updated` to
every room that links the resource: many producers to change, and it still
misses popped-out windows. A second ledger beside the pinned-artifact one: two
triggers on the same insert recording overlapping rows, and two drains to keep
in step. Invalidating the conversation detail instead of patching it: the
conversation socket is that entry's only producer, so nothing would refetch it.
Patching only when the event arrives: a delayed room event or snapshot then put
the older version back, so every write of a detail is followed instead.
Refreshing popped-out windows from both the conversation screen and the app
shell with a shared in-flight set: a screen that was left cancelled a refresh
the shell had already stood down for.

**Consequences:** A new producer of versions needs no change here, as long as
it writes through `resources`. A new reader of new versions filters the drain
rather than adding a trigger; the cause a pin counts as news lives in
`isArtifactNewsCause` beside `artifactUpdateSql`, and the two must agree. The
event names a resource only to people who can open a thread linking it, and
never an unlisted one; keep that gate if the payload grows. A new writer of a
conversation detail needs no merge of its own, and a new surface that shows
popped-out windows refreshes them through the app shell's recorded heads, not
a refresh of its own. A window is refreshed only to a newer version than it
shows, never back.

### 2026-10-10 — Readers of a socket-owned entry no longer replace its fetcher

**What changed:** Observers that only read a cache entry pass
`fetchThroughOwner` (`lib/fetch-through-owner.ts`) instead of a placeholder
`async () => undefined`. It runs the fetcher of the observer that has a real
one. A thread's send, retry, elicitation answer and transcript snapshot, and
the Channel composer's create, no longer invalidate the work-stream list.
`useCachedWorkstreams` listens only to that entry's data events.

**Why:** TanStack copies each observer's options onto the query when it
renders, so an invalidation ran whichever observer rendered last. When that was
a reader, the placeholder's `undefined` failed the query ("Query data cannot be
undefined") and the list was never read again. Fixing that made those
invalidations walk every Space on each send. A walk answered before WorkspaceDO
had a thread's new title put the old one back for a moment. The rows those
paths change already arrive as pushes. The whole-cache subscription took events
that observers raise while mounting during another component's render, and
updated the sockets pool from there (React's setState-in-render warning).

**Consequences:** A new reader of a socket-owned or shared entry passes
`fetchThroughOwner`, never its own placeholder. Invalidating the work-stream
list is a whole Space walk: keep it for the debug toggle, a connect that
carried no rows, imports and Sidekick runs, not for a change that arrives as a
push.

### 2026-10-06 — The main process holds a workspace socket for the menu bar

**What changed:** On macOS with the menu bar item on, the main process dials a
workspace socket of its own through `watchWorkspaceSocket` (now the transport
under `watchWorkspaceReach`) and the Node broker's route, walks every Space with
`space_channels`, and applies row pushes. A desktop with a main window open
therefore holds two workspace sockets.

**Why:** The menu bar shows the sidebar's attention count, which needs each
row's reader marks and Breakout lists; only this socket carries them, and the
menu bar has to be right with no window open. The relay could not serve it: it
carries topics, never rows, and ends with the main window.

**Consequences:** The "one per desktop" rule now covers windows, not the main
process. The second socket costs one subscribe answer and one Space walk per
connect, and the same row pushes the window's socket receives. Its frame
ceiling is off, as the renderer's is. [`menu-bar.md`](menu-bar.md) owns the
mechanism.

### 2026-10-05 — Repeated ticket timeouts can reset shared desktop connections

**What changed:** Two consecutive online timeouts for one ticket path escalate
from ordinary retries to one main-process Chromium connection reset. Requests in
every Rally window share its barrier, and observations are fenced by generation.
Only a usable live snapshot or Organization sync rearms recovery.

**Why:** A production desktop launch repeatedly failed to open both old and new
Channels. Renderer reload did not recover it; fully quitting Rally did. The API
logged successful preflights without completed ticket GETs during the failure,
then a 339 ms ticket response after restart. The precise Chromium failure was
not captured, but retries through the same session were insufficient.

**Considered and rejected:** Reloading the renderer repeated the observed failed
recovery. Automatic application relaunch would disrupt drafts and the current
screen. Clearing storage would discard unrelated local state. A connection reset
is the narrower recovery to validate; it is not a claim that the incident's
underlying networking defect has been identified.

**Consequences:** Resetting Chromium connections interrupts in-flight HTTP
requests, so mutations must not be blindly replayed. Healthy Node feeds stay
open. Future recovery must preserve the cross-window generation fence and use
live authority, rather than a ticket or handshake, as its success boundary.

PR: [#1105](https://github.com/juno-ai-labs/avalon/pull/1105).

### 2026-10-03 — A frozen browser tab redials its workspace socket

**What changed:** The browser bridge reports Page Lifecycle `freeze` and
`resume` as `suspended` and `resumed`.

**Why:** A tab Chromium froze otherwise found its dead workspace socket only by
heartbeat, so a member returning to a background tab saw stale Organization
state for up to a minute.

**Considered and rejected:** Treating `visibilitychange` as suspend, which
would drop the socket every time a tab is hidden for a moment.

**Consequences:** Only the workspace socket redials on resume; the feed swarm
still relies on its heartbeat, as on the desktop.

Shipped in #1080. Design: [Full browser client PRD](PRDs/2026-10-03_full-browser-client/prd.md).

### 2026-09-26 — The Sidekicks window consumes the relay, and old follow-up shapes are no longer read

**What changed:** The Sidekicks window now consumes the main window's
Organization-sync relay like Settings (`relay="consume"`) instead of dialling
its own workspace socket. The main window publishes each pushed `automations`
sidebar list as the `automations` topic; main sends relayed events to both
consumer windows; the `workspace-sync:source` IPC answers either one; and the
`automations` topic now also invalidates `['automation-runs']`. With no
publisher, the Sidekicks window dials its own socket as before. Only the
browser-import window still dials its own. Separately, a directory follow-up's
`channelLosses` is now required and holds only user-id lists: the `"all"`
value, the absent-field fallback and `legacyChannelLosers` are gone.

**Why:** The Sidekicks window was the second window holding a socket to the
same WorkspaceDO, with a full sidebar in its subscribe answer and a copy of
every push. The entry below kept it dialling because it was thought to read
the pushed `automations` list. It does not: it reads the detail surfaces that
push refetches (the automation, its runs, the library), so a topic is all it
needs. The follow-up fallback existed only for rows written before #989, and
all 20 production Organizations were checked and held none.

**Consequences:** A consumer may read only what a relayed topic refetches. A
surface the Sidekicks window starts reading from a socket-owned list has to be
turned into a topic by the main window, or that window has to dial again. A
follow-up row in an old shape now fails to parse and is kept as `failed`
(`directory_followup_unreadable`) rather than sent.

### 2026-09-26 — The workspace socket tells each change to the people it is about, once, and Settings relays the main window's socket

**What changed:** A Channel's row is sent to the people who can see the
Channel now and to the people the write may have taken it from, who get the
tombstone; nobody else hears of it. Those people are named by user id inside
the write's transaction (for an Organization-wide Channel, every member socket
subscribed then), so a follow-up the alarm runs late never reaches someone who
joined in between. Each person's row is built once for all of
their sockets, and one post-commit pass sends each Channel once per socket
however many writes in it touched the Channel. The rows are best effort: one
that cannot be built is logged and skipped, and never keeps a follow-up from
being deleted. A sync event can name an
audience (people, or a connection whose owner is the audience when it is
personal), is stored with it, and replays only to it; the mutation map now says
per write who it is for, and a connection write no longer names `automations`.
On the desktop, the main window's socket publishes its connection state and
the topics of every sync event (a flag push as the `feature_flags` topic) to
main, which relays them to the Settings window; Settings applies them through
the same invalidation code and dials its own socket only while main reports no
publisher at all. An Organization is `{ region, workspaceId }` at every hop. A
publisher that unmounts with no successor detaches; one replaced in the same
pass does not, and main no longer releases on a session change, so neither an
Organization switch nor StrictMode makes Settings dial.

**Why:** Every Channel change looped over every subscribed socket in the
Organization and, per socket, ran about six queries, parsed and serialized a
row, and sent it. The directory row's `LEFT JOIN` gave every socket a row, so a
viewer who could not see the Channel was sent `workstream: null`: every
message in a private Channel told every non-member its id and when it was
active. A person with several windows had the same row built per window, and a
turn's burst of effects sent one full row per effect. Sync topics had no
audience, so one person's digest edit or personal connector OAuth invalidated
every socket in the Organization. And every desktop held two workspace sockets:
the Settings window, prewarmed hidden, mounted the same provider, was sent the
full sidebar it never draws and a second copy of every push, and read
everything twice on open (its reads at mount, then again about 600 ms later
when its socket's `initial` landed).

**Considered and rejected:** Deciding tombstones at publish time with a
"could have seen it" test: it misses the readers of an Organization-wide
Channel who have no viewer row when it narrows, and sends tombstones for ever
to people who once had a row. It survives only as the reading of a follow-up
recorded before losses were named, where nothing better is known. Recording
"everyone" for an Organization-wide Channel and expanding it when the
follow-up runs: a member who joined in between is sent the tombstone, and with
it the id, of a Channel they never had. Naming those readers from
`workspace_member_status`: it lists a member from before it existed only once
something has asked about them. Putting off every follow-up of a pass when its
row send throws: each alarm retry re-ran the pass's unrelated reconciliations,
archival notices and presence broadcasts, and one bad row also dropped the
pass's sync topics. Per-Channel subscriptions on the workspace
socket, for the reasons the 2026-09-25 entry gives. Publishing connection
changes from each route handler, which would have added an awaited RPC to
requests that now defer it. Connecting Settings's socket only while shown with
a flag to omit the sidebar: it keeps the double read on every open, needs a
contract and `WorkspaceDO` change, and gives up the prewarm. Trimming the main
window's own first-connect double read: a REST read answered before the server
processes the subscribe can miss a change made between them, and without a
waterline on each REST response the client cannot tell which reads those are.
Relaying flag values as data through a message kind of their own, with its own
list of flag keys at every hop: the `feature_flags` topic already names the
change, and a refetch keeps the relay to names. Releasing the source when the
session changes Organization, or when the provider unmounts: the first ran
before the windows heard of the change and the second before the successor
attached, so Settings dialled a throwaway socket (a ticket and a full `initial`
refetch) on every switch; holding the source until an unmount with no
successor misses nothing and costs no socket. Parsing again in the preload
what main had already parsed: main is the untrusted edge's one parser.

**Consequences:** A change that can take a Channel away from someone has to
name them in `channelLosses`, by user id and inside its transaction (or be a
transition `applyDirectoryEnvelope` compares); `"all"` is still parsed, for
rows already written, and must not be written again. Nothing that must happen
may ride on a Channel row send, which can fail for one person without anyone
retrying it. A new sync topic that is one person's has to be published with an
audience; the table in [`realtime-sockets.md`](realtime-sockets.md) says which
topics are. A connection change still invalidates `resources` and
`digest_schedule` for its whole audience. A socket-less window is now a
supported shape of `WorkspaceSocketProvider`; another secondary window can use
the relay only once it carries what that window reads (Sidekicks reads the
pushed automations list, so it still dials), and anything Settings starts
reading from the socket beyond topics and connection state has to be
published by the main window too. A Settings window whose main window stays on
another Organization waits without a socket, so a switch the main window
never applies leaves Settings unfreshened until it does.

### 2026-09-25 — A Channel's metadata rides the workspace socket; the control socket is retired

**What changed:** The desktop no longer opens a Channel control socket. Each
held Channel (active, pinned, five recent, running, recently viewed, hover
warm-up) now costs one socket, its Main feed, instead of two. What the control
socket carried beyond the directory row, the viewer's breakout list with its
waterline and the running background agents per conversation, is now part of
the Channel's row on the workspace socket: the connect sidebar, every page and
recency answer, and every `workspace_workstream_state` push. The hosted parent
republishes a row when a breakout roster moves for someone (to that person) or
the running agents change (to every reader); everything else already reached
the row through the directory apply. Losing a Channel is its row's tombstone,
which evicts the cached Channel, and the socket stays open for the sidebar.
Foregrounding a Channel on the workspace socket wakes its Main, which the
control socket's open used to do. The breakout screen's own control socket and
the Electron broker's `workstream_control` kind are gone with it.

**Why:** Both sockets landed in the same `WorkspaceDO` once Channel parents
moved there, so the control socket was a second connection, a second ticket
and a second copy of the Channel's row from the same object. The row already
reached every authorized reader whether or not the Channel was open, with the
same versions, so the per-Channel socket bought nothing but its cost: a ticket
request and a handshake per held Channel, a hibernating socket per Channel per
window, and two producers for one cache.

**Considered and rejected:** Per-Channel subscribe and unsubscribe frames on
the workspace socket, with the subscription kept in a `WorkspaceDO` table per
connection. It keeps the per-Channel fan-out narrow, but the data does not need
it: the breakout list is a handful of rows per viewer (the busiest Channel
measured on 2026-09-25 had 4 children) and changes at the rate breakouts are
created, archived or rejoined; a Main or breakout message already republishes
the row to every socket today, so adding the list costs bytes on pushes that
happen anyway. Background-agent counts change on an agent's start and finish,
a few times per run, sent once to each socket. A subscription table would add a
migration, a close-time cleanup and a second authorization path for no
measurable saving.

**Consequences:** `/parent-socket`, `WorkstreamControlSocketService` and
`GET /workstreams/:id/control-socket` stay for desktops released before this
change and for the iOS client, whose child directory is still that socket.
(The Worker half was deleted on 2026-11-07 with the Thread routes; see
[`realtime-sockets.md`](realtime-sockets.md#changelog).)
They can be removed once the oldest supported desktop is this one and iOS
reads the breakout list from its workspace socket. A new per-viewer Channel
fact belongs on the row, not on a new socket.

### 2026-09-23 — Name the first workspace sync boundary

Production showed accepted organization socket upgrades with no completed
WorkspaceDO message callback while clients remained on `Opening channels`.
There was no evidence distinguishing a missing client `subscribe` from a room
callback stalled during initial sync. Add one opaque attempt ID and phase logs
on both sides of that boundary. The ID is optional on the wire so older
desktop releases remain valid, and the phase logs exclude ticket and sidebar
content. The first-frame marker persists in the socket attachment so a client
that never subscribes cannot multiply that log by sending more frames. A future
recovery change should use the observed failing phase rather
than infer a server fault from an accepted upgrade alone.

### 2026-09-17 — Foreground recovery reconciles unresolved commands

**What changed:** When Electron returns to the foreground with a substream
command still awaiting its private receipt, that feed replays the command with
the same operation ID, requests one canonical snapshot, and immediately probes
the current socket with the existing heartbeat deadline. Feeds without an
unresolved command do no foreground reconciliation work.

**Why:** Production timing probes proved that messages and assistant replies
could be durably committed while a background-throttled renderer remained on
`Sending message`. The socket was owned by Electron main, but protocol receipts
and transcript cache updates were processed in the renderer, so a delayed or
lost renderer turn could strand the optimistic message until the window was
raised even though the server path had completed normally.

**Considered and rejected:** Disabling Electron background throttling globally
would keep every hidden renderer running and pay a continuous CPU and power cost
for a recovery needed only while a command is unresolved. Replaying under a new
operation ID was also rejected because it would turn recovery into a duplicate
mutation rather than reuse the room's existing idempotency boundary.

**Consequences:** Foreground recovery is bounded to the affected feed and uses
the same command, snapshot, and heartbeat primitives as reconnect recovery. A
healthy socket settles from its replayed private receipt; an unresponsive socket
closes after the existing pong deadline and reconnects through the normal
cursor-based path.

Shipped in [#818](https://github.com/juno-ai-labs/avalon/pull/818).

### 2026-09-17 — Browser upgrades retain source socket ownership

The lite browser uses the existing ticketed APIs through an explicit cookie mode
in the shared API client. Its web host forwards same-origin upgrades through the
regional service binding, removing cookie/bearer headers and preserving ticket
subprotocols. The source object still owns admission and the connection. This
avoids introducing a frame multiplexer or a second authority merely to host the
browser on another origin. Transport forwarding is tested in real workerd; the
browser now mounts standalone conversation feeds without the desktop pool. The
direct feed fallback does not acquire a parent control socket; a native pool
continues to own its control/feed pair. A real browser check confirms child-only
links request no Main, parent-control or workspace socket. Chrome acceptance covers feed and mutation lifecycle behavior. Production enablement remains a separate release task.

### 2026-09-16 — Migrated Main and child feeds share the grant revision fence

**What changed:** Once participant authority is transferred, both Main and child
feed admission require an active local projection with the ticket's exact revision.
Main socket preparation forwards the parent-issued revision instead of zero.
The feed protocol preserves a guest's null workspace role in signed tickets,
forwarded admission, stored attachments and product calls. An absent role still
means a legacy attachment requiring reauthorization; null is an admitted guest.

**Why:** Main's legacy bypass otherwise accepted pre-migration tickets even after
its roster authority moved to grants. Checking the current session alone cannot
prove the ticket still names the current conversation access.

**Considered and rejected:** Keeping the child-only check leaves different
revocation semantics for two conversations governed by the same grant primitive.

**Consequences:** A stale ticket must be reacquired. Unmigrated Main retains its
legacy admission; this does not activate live migration or guest product routes.
Public conversation ticket issuance uses exact grant authority for guest
relationships. Its workspace-public legacy fallback is disabled, and the same
check protects the addressed conversation's REST recovery snapshot. The real
pipeline covers authenticated ticket issuance, signed-ticket upgrade, guest
message delivery and revocation closure. Mutation proofs catch both the old Main
revision bypass and a guest falling back to legacy workspace-public access.

### 2026-09-15 — Socket ticket acquisition cannot strand reconnect loops

**What changed:** Workspace, WorkstreamDO control, and SubstreamAgent feed
connections now acquire tickets through one attempt-scoped request boundary.
It settles the caller after the owning attempt's existing budget even if the
underlying fetch or shared credential renewal remains pending, aborts on offline
and owner teardown, and reports `ticket_timeout` separately before the ordinary
jittered retry begins. Cold feed opens retain their 10/20/40-second whole-open
ladder; workspace, control, and already-open feed attempts use ten seconds.

**Why:** An API deployment closed the live socket swarm while several ticket
requests were starting. A feed that had opened previously did not arm the
bounded cold-opening timer, and workspace and control tickets had no deadline
at all. Their raw promises never settled, so each loop kept its `connecting` or
`ticketRequestInFlight` guard forever. The active transcript then could not use
its live feed to page beyond the latest opening range even though every
canonical turn remained stored.

**Considered and rejected:** Extending only the feed's cold-opening timer would
leave workspace and control vulnerable and would still couple ticket recovery
to whether a transcript had opened before. Relying only on `AbortController`
was also rejected because credential renewal can outlive fetch cancellation;
the owning caller must settle independently. A new timeout value was
unnecessary: the first work-stream opening already established ten seconds as
the request-and-connection budget.

**Consequences:** Every ticket API accepts cancellation, every socket owner
aborts its pending ticket on offline and teardown, and telemetry can distinguish
a hung request from an ordinary rejected ticket. Adding another persistent
socket kind requires using the same bounded acquisition primitive rather than
awaiting its ticket API directly. Transcription remains deliberately outside
the boundary because capture owns its short-lived request's cancellation and
timeout lifecycle.

Shipped in the pull request for this change.

### 2026-09-14 — iOS retains a navigation-shaped set, not the desktop swarm

**What changed:** The native iOS client now owns a retain set: one workspace
socket, one control socket for the parent on the stack, the visible feed, and
Main of that parent while a child or the substream list is showing, plus
presence-free feeds for directory rows that stayed on screen for one second
(the same delay as desktop hover). Child rows on the substream list warm as
soon as they appear. Sidekick chats stay on-demand until their
row warms. Tickets stay single-use; send reuses a live connection;
foreground remints only dropped sockets in that set. Later directory pages
are `list_workstreams` on the workspace socket; subscribe overlays page one
instead of truncating a scrolled list. Every iOS live connection is one
`RallyTicketedSocket`: the ticket is a subprotocol, the handshake Origin is
`app://rallywithai`, `subscribe` waits for
open, and a retain pass does not cancel that handshake. Directory pages and
the conversation snapshot arrive on those sockets, not as REST boots. A
dropped control stream without metadata still delivers an empty child list
once. Older history is a fenced `load_transcript_range` (snapshot id, half-open
sequence range, event waterline). The iOS feed asks only after the
bottom-anchored list has settled and the reader is on the oldest edge. A ticket already minted for a feed that is
still in the retain set is used, even when a later retain pass asked for
presence.

**Why:** Switching chats on a phone is popping and pushing the stack, not
hovering a sidebar of pins. Copying Electron's pin/recent/running swarm would
hold sockets `URLSessionWebSocketTask` cannot keep across suspend, for rows
the phone does not show at once. Reminting on every send was spending a
one-use ticket to re-handshake an open feed. Replacing the directory with
subscribe's first page threw away rows already paged; a button to load older
messages was a second paging control next to the terminal row. Applying the
retain set once per directory-row disappear cancelled the control socket
before metadata. Sending `subscribe` before the handshake completed dropped
the frame, then marked the socket connected so the next retain pass skipped
it, and the child list never left its wait. A REST work-stream list or Main
boot next to the same subscribe payload is two producers for one field.
`URLSession` omits `Origin` on the upgrade; without `app://rallywithai` the
Worker refuses the handshake before it reads the ticket, and the directory
never paints. A `load_transcript_range` that named only `beforeSequence`
never matched the room's fenced request, so older history never arrived.
Asking that range because the first layout reported offset 0, then scrolling
to the newest row on every tail change, emptied the LazyVStack between jumps.
Throwing away a ticket because a tap upgraded presence during mint made the
first open a second handshake.

**Considered and rejected:** Porting the five-minute retain TTL, the
pin/recent/running selection, or a guessed extra-socket ceiling. The
navigation stack plus the visible row already names the set. A defensive cap
would be a number this change does not own. Also rejected: a REST directory
page or Main transcript boot beside the same subscribe payload, including as
a fallback when the handshake 403s for a missing Origin. Also rejected:
dropping a minted conversation ticket because a later retain pass asked for
presence on the same feed. Also rejected: paging older transcript from a
LazyVStack index-0 sentinel on a bottom-anchored iOS feed.

**Consequences:** Desktop pool policy is unchanged. An iOS change to "keep
more feeds" has to go through the same proactive-coverage tests in this
document: name the interaction, select from memory, no guessed swarm.

### 2026-09-10 — The feed hook paints from the local cache and treats a seed as no opening

**What changed:** `useWorkstreamSocket` reads the conversation's row from the
local cache when its effect starts, seeds empty detail, transcript, and
context caches from it in one batch under the `local_cache` feed source, and
mirrors the caches back to the row for as long as it is mounted once a live
snapshot has installed them. A seed does not count as canonical caches: the
opening deadline arms and counts its attempts over one, the room is
subscribed from sequence zero, and the first snapshot replaces the seed
whatever its sequence says. The control socket prunes cached children that
left the private-child roster. Outside a `LocalCacheScopeProvider` nothing
changes.

**Why:** The proactive pool already makes a warmed row open instantly; a row
opened on a cold launch, or a substream nobody warmed, still waited on the
whole ticket, handshake, subscribe, and snapshot sequence with nothing to
show. What that sequence was about to deliver had been on the device the last
time the row was open.

**Considered and rejected:** Hydrating in the surface rather than the hook. The
hook is the only producer of those caches and the only place that knows
whether an opening completed; a seed written by anyone else would look to it
like a completed opening. Persisting from the pool rather than per hook. The
hook already owns the write path and its lifetime is the retention policy, so
warm rows stay fresh on disk without a second registry.

**Consequences:** `canonicalCachesAvailable()` has a fourth input, the seed
marker, and every future check that a room's state is renderable has to
exclude a seed the same way. Every write to the three entries is a disk write
one coalescing window later; a field that must not persist is stripped in the
conversation mirror. [`local-cache.md`](local-cache.md) owns the design.

### 2026-09-09 — Separate cache observation and onboarding admission from warming

The startup selector used a second stateful paging hook, which could replace a
fully paged directory with its own first-page refetch. It now observes only the
shared cache, leaving pagination with its existing owners. Review also confirmed
that mounting a feed while onboarding was unknown could mark it opened before
setup took over. A composed conversation-admission context now reaches the pool
and direct feeds; unresolved setup keeps tickets speculative and sending disabled,
while successful completion promotes the same sockets. The speculative flag does
not omit transcript data: it suppresses viewing effects, so background freshness
still uses the normal snapshot path.

### 2026-09-09 — Overlap cold-open workspace and conversation admission

Workspace details previously blocked the workspace socket, and the shell then
blocked the conversation pool. Startup now mounts those existing owners before
the profile finishes, retaining them through the loading-to-content transition.
The root's warming candidate and landing share one ordering function so viewer
recency cannot leave the opening row outside the activity-based warm set. We
reused the pool instead of adding another ticket cache or speculative transport.
A mounted feed consumer, rather than a route alone, now admits viewing, so an
opening deep link cannot mark unread work viewed behind a loading/onboarding
screen. Account/workspace changes still tear down the complete connection scope.

### 2026-09-08 — Ignore protocol additions at every receive boundary

Unknown event types are no-ops on workspace, control, conversation, and dictation
streams. The shared receive parser strips additive fields while preserving known
field validation; outgoing and stored schemas remain strict. Ticket URLs and
broker handshakes discard query configuration, so a new metadata capability can
no longer prevent the entire connection from opening. Appearance is unconditional.

### 2026-09-08 — Refresh Sidekick surfaces through workspace synchronization

Added library and attachment invalidation to existing automation pushes. Local
mutation invalidation alone left other windows stale; reusing the authorized
workspace socket avoids a second cross-window data transport. Keep the full
library separate from the filtered enabled shortcut list.

### 2026-09-03 — The automation room is gone; an automation's chat is a conversation feed

**What changed:** The `automation_agent` route kind, `use-automation-agent-socket.ts`,
and the automation object's socket room are removed. An automation's page
opens one conversation feed socket, substream `0` under the automation, through
the same broker, route kind, and `/socket/conversations/:parentId/:substreamId`
path a work stream's feed uses, and no control socket. The work-stream feed
path moved from `/socket/workstreams/:id/substreams/:substreamId` to the
conversation path as well.

**Why:** The automation object stopped holding a conversation. Its chat is a
`SubstreamAgent` under it, like a work stream's feed under `WorkstreamDO`, so
the topology has one feed protocol and one broker kind for both. The design is
recorded in [`workstream-durable-object.md`](workstream-durable-object.md).

**Consequences:** The pool policy is the only thing that distinguishes the
two: a work stream's pair is warmed and retained, an automation's feed follows
its page. A future control socket for automations would be a new brokered
kind, added to the closed enum and the path check like any other. The entry of
2026-08-28 below describes the room this replaced.

### 2026-09-01 — Intent warmth covers the feed and handshakes expose their real phases

**What changed:** A deliberate one-second row hover mounts the complete
presence-free control/feed pair. The signed feed ticket carries its resume
cursor so a current server can authorize and queue the initial subscription
during the upgrade; explicit `subscribe` remains the rolling-deploy fallback.
The Electron broker reports PAC, DNS, TCP, TLS, and edge upgrade for direct
routes and one honest proxy aggregate. Only click-scoped opening traces are
exported.

**Why:** The product target is a total two-second switch, while the prior hover
left the largest connection cold and the 72-hour diagnostic distribution mixed
background retained sockets with real clicks. A single handshake total also
could not distinguish local proxy work from Cloudflare/object latency.

**Considered and rejected:** Publishing feed presence during hover would turn
prediction into user attention. Inventing subphases inside a proxy tunnel would
produce precise-looking false data. Removing the explicit subscribe immediately
would break an old-server/new-client rolling deployment.

**Consequences:** One qualified speculative row may now consume a complete pair
and initial snapshot without changing its unseen state. Navigation sends one
promotion frame on that retained socket. Feed warmth remains bounded by the
existing single hover candidate and retention policy. Direct and proxied
handshake cohorts must be read separately, and product totals continue to come
from feed-visible and send-ready rather than background transport traces.

### 2026-08-31 — The singleton workspace socket follows the active workspace

**What changed:** An account may retain credentials for several workspaces, but
Chromium still owns exactly one WorkspaceDO socket: the active workspace's.
Switching replaces that socket and its directory; background workspaces expose
only the attention read and never join the socket pool.

**Why:** A socket per retained credential would turn the account menu into a
second realtime product and multiply workspace snapshots and object wakes for
content that is not on screen. The switcher needs a count, not a hidden live
directory.

**Considered and rejected:** Keeping all known WorkspaceDO sockets warm so a
switch can reuse one. A saved credential and profile already make activation
immediate, while hidden sockets would obscure which workspace owns commands.

**Consequences:** Session changes must tear down the old workspace provider
before mounting the new one. Background attention remains a regional request
using that workspace's credential; adding background sockets is an architecture
change, not a polling optimization.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-28 — The broker carries a third socket kind, on demand rather than proactively

**What changed:** `automation_agent` joins `workstream_control` and
`substream_feed` as a brokered route kind. `use-automation-agent-socket.ts` opens
one AutomationAgent room while a draft screen is showing a durable automation and
closes it when the screen unmounts or the subject changes. `AutomationAgent`
accepts it through the hibernation API like the other three objects. Nothing
about the proactive work-stream swarm, its selection policy, or its retention
changed.

**Why:** Compiling an automation draft is a long streaming turn, and the previous
design carried it on a response body — closing the window lost the narration with
no way to recover it. It goes through the broker rather than Chromium for the
same reason the work-stream pair does: it is opened alongside whatever
work-stream sockets are already warm, and Chromium serializes handshakes to a
shared endpoint.

**Considered and rejected:** Putting it in the pool. The pool's warming and
five-minute retention are latency optimizations for navigation between work
streams; an authoring room has no such navigation, and retaining it would hold a
single-author room open after its author left. Adding it as an accepted URL under
the existing work-stream route kinds, which would have widened the destination
check the broker exists to enforce.

**Consequences:** The route-kind enum and `validSocketPath` are now the two
places a new socket kind must be declared, and a kind that omits either is either
unopenable or over-permissive. Every object reachable through this topology
accepts hibernating sockets, and any further one must too — and must join the
[access-revocation](access-revocation.md) walk, because none of these rooms
re-authorize after admission.

Shipped in the pull request for this change. Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md).

### 2026-08-27 — Snapshot rotation cannot swallow a requested transcript range

**What changed:** Each pending Electron range request retains the snapshot ID it
named. A reply merges and resolves only if both the request and current cache
still name that snapshot; otherwise it rejects with
`transcript_snapshot_changed`. Older/newer paging and Jump to latest recompute
their next gap against the accepted replacement snapshot and continue.

**Why:** Reconciliation may rotate a snapshot while a range is in flight. The
old handler correctly refused to merge the stale range but still resolved the
caller, converting “history was discarded” into “history loaded” and leaving
the reader stranded until another manual trigger.

**Considered and rejected:** Applying the old range to the new snapshot or
silently resolving it. A range is authoritative only under its named fence, and
success must mean its coverage entered the cache.

**Consequences:** Snapshot churn may cause another socket round trip but never a
busy retry loop: each retry waits for a correlated server reply. No guessed
retry cap is introduced; the route and socket lifecycle remain the cancellation
fences.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

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

### 2026-08-26 — Work-stream socket pairs move outside Chromium's handshake queue, and proactive expansion requires user intent and bounded reasoning

**What changed:** Packaged Electron now opens each selected work stream's
WorkstreamDO control socket and substream `0` feed socket through a route-confined
Node broker. The active work stream, all pins, five recent unpinned work streams,
and all running work streams are opened proactively and independently; the
singleton WorkspaceDO socket remains in Chromium.

The architecture also defines the conditions for proactively connecting another
socket surface and the additional identity, lifecycle, cost, authorization,
instrumentation, and real-runtime checks required for non-zero substreams; that
part changed no runtime behavior.

**Why:** Chromium serialized simultaneous WebSocket handshakes to the same
endpoint even when they routed to different Durable Objects. That made a socket
swarm queue behind itself and moved connection setup back onto a later sidebar
click, conflicting with the two-second click-to-feed-and-send-ready goal.

Moving handshakes to Node makes wider fan-out mechanically easy, and Durable
Object hibernation can make an idle socket look free. Additional substreams
multiply ticket requests, snapshots, object wakes, renderer state, and reconnect
work even when they do not keep an object actively billed. A durable rule is
needed before transport capability becomes accidental product policy.

**Considered and rejected:** Separate Chromium sessions remove the shared
endpoint lock but duplicate storage, cache, proxy, certificate, and lifecycle
state. Moving the complete protocol into Electron main would duplicate the
renderer state machines and make browser development a second product. A raw
Node transport broker preserves one protocol implementation while allowing
parallel handshakes.

For proactive coverage: opening every substream known to a selected work stream
would warm low-probability destinations and require discovery work that can
itself wake each object. A fixed transport-wide connection cap would hide which
product interactions matter and invent a number without a product or platform
derivation.

**Consequences:** The privileged bridge must remain route-confined, renderer
events must stay multiplexed through one listener, and full renderer teardown
must terminate every owned Node socket. Workspace commands, HyperSight blocks,
dictation, browser development, Durable Object admission, and hibernation keep
their existing owners. Future socket kinds do not inherit broker access without
an explicit schema and route-validator change.

Future proactive coverage must name the interaction it makes ready, select
candidates from already-available authority, show worst-case fan-out
arithmetic, preserve immediate revocation and jittered teardown, and prove the
visible boundary in Electron. Other substreams require tuple-keyed pool and
cache ownership; they cannot reuse the current workstream-only key or duplicate
its WorkstreamDO control connection.

Shipped in #341.
