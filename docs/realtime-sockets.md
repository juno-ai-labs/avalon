# Realtime socket admission

Every Rally WebSocket (workspace synchronization/commands, the retired Channel
control socket that installed desktops still open, the direct
conversation feed of a work stream or an automation, and the dictation bridge to
Azure) is opened with a short-lived ticket rather than
the session credential. This document owns how a purpose-specific ticket is
issued, how it reaches the Worker, and how a handshake is accepted or refused.
What happens *on* an open socket belongs elsewhere: workspace directory serving,
invalidation, and command routing are `WorkspaceDO`'s, aggregate metadata is the
Channel's parent's, hosted in `WorkspaceDO`
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)),
feed fan-out/replay/presence is `SubstreamAgent`'s whichever kind of parent the
conversation has, who may open a conversation is its parent's
([`workstream-durable-object.md`](workstream-durable-object.md)), and
the dictation bridge's audio rules are in
[`architecture.md`](architecture.md).

The promise it makes is narrow and worth stating plainly: a socket is opened
only by someone who just proved, over an authenticated HTTP request, that they
may open that exact socket — and proving it leaves no credential anywhere a URL
is recorded. [`websocket-architecture.md`](websocket-architecture.md) owns the
client/server topology, Electron process split, proactive work-stream swarm, and
connection lifecycle around that admission protocol.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/socket-tickets.ts` | The transport: the subprotocol sentinel, the deprecated query parameter, and the shared helpers both sides use. The single source of the wire format. |
| `apps/api/src/services/socket-service.ts` | Issues and verifies the separate workspace, work-stream-control, and conversation-feed ticket audiences, reads the presented ticket, negotiates the response subprotocol, and admits each upgrade. A feed ticket names the conversation's parent kind (`pk`) and id and carries the parent's archive decision. |
| `apps/api/src/services/conversation-service.ts` | Gates a feed ticket on the parent's viewer decision and current authority, seats the reader on the conversation, and starts the recorded main SubstreamAgent's ticket-scoped admission and snapshot preparation as measurable, failure-isolated request background work. |
| `apps/api/src/services/realtime-transcription-service.ts` | The dictation ticket, its WorkspaceDO replay receipt and session lease, and the Azure upgrade. |
| `apps/api/src/routes/socket.ts` | Workspace, work-stream-control, conversation-feed (`/socket/conversations/:parentId/:substreamId`), and dictation upgrade routes. The query ticket is optional here; the service decides what was presented. |
| `apps/api/src/durable-objects/workspace-do.ts` | Accepts the persistent workspace synchronization/command socket, serves authoritative cursor-paged work-stream rows, persists a bounded replay log, and consumes its purpose-specific ticket in SQL. |
| `apps/api/src/durable-objects/hosted-parent.ts` | Accepts the retired Channel control socket for clients released before its state moved onto the workspace socket, and reads the per-viewer breakout list and background-agent counts every Channel row now carries. |
| `apps/api/src/durable-objects/substream-agent.ts` | Accepts the direct read/stream/download feed and all substream-local commands (message, elicitation answer, pending-input reorder, stop, retry), consumes its distinct ticket in SQL, admits writes from the identity serialized when the socket was authorized, and refuses every write on a socket whose parent was archived. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Keeps the workspace socket alive across navigation, correlates/retries directory-page requests, resumes its waterline, applies current work-stream rows, and invalidates workspace query surfaces. |
| `apps/api/src/services/sidebar-reads.ts` | The automation and note statements plus row mappings the sidebar opens with, shared by WorkspaceDO's batch and the REST services so the two readings of one table cannot drift. |
| `apps/desktop/src/renderer/lib/sidebar-list-store.ts` | The one receiver for the sidebar's two pushed lists: the opening batch and every push compare against its per-list waterline ledger rather than writing the caches directly. |
| `apps/desktop/src/renderer/lib/use-workstreams-query.ts` | The directory query. When the connect payload says `channelsBySpace`, it walks the Spaces for their Channel rows and drops what no Space returned; otherwise it pages the directory beyond the first page the payload delivered. It widens the list only when Debug enabled asks for system rows. |
| `apps/desktop/src/renderer/lib/channel-viewer-state.ts` | Writes a Channel row's breakouts (waterlined per viewer) and running background agents into the caches the Channel menu and composer read, and reconciles receipt-backed breakout appearance. |
| `apps/desktop/src/renderer/lib/workstream-state-store.ts` | Shared common/viewer and WorkspaceDO-directory waterline ledgers; independently rejects stale state fields and older pin/page fields. |
| `apps/desktop/src/renderer/lib/workstreams-cache.ts` | The typed write boundary for the shared work-stream list, the detail query key for Main and for a private child, and `patchCachedWorkstream`, the one write for an unversioned fact (a rename or scope event, a REST response, a command receipt) that the list row and the open detail entry must take together. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Keeps a pooled, substream-addressed SubstreamAgent feed, resends idempotent child commands after reconnect until their private operation receipts arrive, and explicitly disables legacy feed-derived presence. |
| `packages/contracts/src/workstream-transcript.ts` | Ordered turn/block, snapshot-fenced range, gap coverage, and nested UTC activity contracts used by the SubstreamAgent feed. |
| `apps/desktop/src/renderer/lib/workstream-socket-pool.tsx` | Owns the Channel Main feeds above the route, gives each mounted owner one opaque lease ID, warms one presence-free feed after a one-second sidebar hover, and retains recently viewed feeds without remounting their connection hooks. |
| `apps/desktop/src/renderer/lib/realtime-socket.ts` | Preserves the browser `WebSocket` event/readiness contract for the work-stream hooks while routing Electron transport through one socket-ID-multiplexed privileged-bridge listener; browser development keeps the native constructor. |
| `apps/desktop/src/common/realtime-socket-validation.ts`, `apps/desktop/src/main/realtime-socket-ipc.ts` | Share strict dependency-free event/channel validation and register the main-window-only IPC capability. |
| `apps/desktop/src/main/realtime-socket-broker.ts` | Owns Electron's SubstreamAgent feed TCP/TLS handshakes in Node (the only kind it admits), fixes the application Origin, follows the complete ordered PAC route, enforces the shared frame ceiling, and closes every owned connection when its renderer goes away. |
| `apps/desktop/src/renderer/lib/api.ts` | Parses every ticket response, strips all query data, and attaches the handshake subprotocols. |

## How it works

A client cannot authenticate a WebSocket handshake the way it authenticates a
request: a browser sets no headers on one, so `Authorization` is unavailable. So
admission is split in two.

1. **Issue.** The desktop calls
   `GET /workspace/socket` for workspace sync/commands (members and guests: it
   is mounted with the workspace-relationship check, not the member-only
   `requireAuth`, because WorkspaceDO shapes a guest's socket itself),
   `GET /workstreams/:id/control-socket` for the retired Channel control socket
   (still served for installed desktops; the current desktop
   never asks for it),
   `GET /conversations/:parentId/substreams/:substreamId/socket` for the feed
   of a work stream's or an automation's conversation, or
   `GET /realtime/transcription/socket`. The Worker checks the caller may open
   that exact purpose and mints a 60-second HS256 JWT binding user, workspace,
   region, one-time `jti`, audience, only the target IDs that purpose requires,
   the current regional session ID, and, for a feed, the parent kind (`pk`),
   the parent id, the authenticated role (null for guests), the current authority generation,
   and whether the parent said it is archived (`parent_archived`). The
   ticket also binds the authorized conversation membership version and the
   contract-10 resolution-suggestion capability. The room persists the capability
   in its attachment and adapts legacy snapshot, broadcast and replay delivery
   as described in [conversation suggestions](conversation-suggestions.md#resolution-delivery-and-acceptance). Session
   validation retains the existing workspace membership-incarnation check. An implicit workspace-member Main read uses
   version zero; explicit grants use positive revisions and their existing local
   freshness check. A guest has no implicit Main admission. The
   conversation feed route also returns that `jti` as `ticketId` beside the
   ticket, the id of the credential and never the credential, because the
   upgrade it authorizes opens a new
   connection carrying no request id, and it is the only value the issuing
   route, the edge, and the room all hold. See
   [`performance-tracing.md`](performance-tracing.md). Once a main-feed ticket is
   minted, its request schedules that recorded SubstreamAgent's ticket-scoped
   admission and initial-snapshot preparation under `waitUntil`. The response
   does not await that work: object initialization, local visibility admission,
   a current D1 session/membership check, and eligible snapshot assembly overlap
   the ticket's transit and client handshake,
   while a failed, revoked, evicted, stale-generation, or unfinished preparation
   leaves the ordinary regional upgrade checks as the fallback. Before any of
   that, the Worker resolves which kind of parent the id names
   (`WorkspaceDO.resolveHostedParent` first, which answers a Channel or Space
   or Sidekick with its authority in one call, else 404; a
   Space is not a conversation this route opens),
   asks that parent's `authorizeViewer`, and for an automation seats the reader
   on the conversation, because the parent's rule is wider than the
   conversation's participant list.
   A non-main UUID is not warmed merely because its parent is visible; the
   parent must first have reserved that child.
   The transcription ticket's lifetime is the shared
   `TRANSCRIPTION_TICKET_LIFETIME_SECONDS`, which the desktop's hover prefetch
   reads; see
   [`conversation-surfaces.md`](conversation-surfaces.md#dictation-capture-and-connection-startup).
2. **Present.** The client opens the socket with the ticket as the second
   protocol: `[rally.ticket.v1, <ticket>]`. Native browser sockets send those
   from the `WebSocket` constructor; Electron's work-stream broker passes the
   same pair from Node's `ws` client and supplies the fixed application Origin
   (`app://rallywithai`). Both become `Sec-WebSocket-Protocol`, the handshake header
   available for browser-compatible ticket presentation. A ticket is a compact
   JWS — base64url joined by dots — which is a legal subprotocol token, so it
   needs no encoding.
3. **Verify.** The Worker checks the `Upgrade` header and the exact `Origin`,
   reads the ticket off the offer, verifies the signature and the claims, and
   rejects a region or work-stream mismatch.
4. **Admit.** A feed upgrade reaches the exact `SubstreamAgent`. When the
   in-memory preparation matches every verified ticket claim and the object's
   local authority generation, the room reuses its ticket-transit
   session/membership decision and eligible prepared snapshot; otherwise it
   re-reads session/membership. Both paths re-read current regional authority
   because a maintenance transition can close a generation in place, recheck
   object-local visibility, and atomically consume the durable ticket receipt.
   Preparation never consumes a ticket. A constant-size revocation fence
   prevents older in-flight preparation from reappearing, and only the newest
   room admission and newest completed snapshot are retained. A
   Channel control upgrade from an older client reaches the workspace's
   `WorkspaceDO` at the internal `/parent-socket` path, where the Channel's
   hosted parent verifies D1 membership plus its local visibility projection
   and accepts the socket tagged `parent-control:<id>`. A workspace upgrade reaches
   the workspace's `WorkspaceDO`, which consumes a separate audience ticket and
   serializes the verified session identity; every subscribe or later command
   rechecks the current D1 session and membership, and both of its publish paths
   sweep the connected set — immediately for a retracting topic, otherwise once
   per 30 seconds — closing the sockets that no longer pass. Neither object
   receives the signed bearer ticket.
   A conversation under an automation, or any substream other than `0`, is
   admitted on the parent's forwarded decision: the ticket's `pk`, parent id,
   and `parent_archived` reach the object as `x-rally-parent-kind`,
   `x-rally-parent-id`, and `x-rally-parent-archived` headers, the object
   checks them against its own identity row, and an archived parent's
   conversation is read-only from that socket. An automation parent has no
   socket of its own: the automation's page holds the conversation feed and
   nothing else.
   Dictation consumes its `jti` and reserves a session lease in the owning
   WorkspaceDO — one serialized transaction, so two simultaneous upgrades
   cannot both pass the per-user/per-workspace concurrency caps — before
   opening Azure. The proxy renews that two-minute lease every 60 seconds on
   a timer for as long as the client socket is open, whatever travels on it:
   the desktop opens the socket while the microphone may still be being
   granted, and a paused recording sends nothing, so a renewal that rode on
   frames would let the next admission's sweep expire a session that is still
   live. The timer stops on every path that releases the session.
5. **Negotiate.** If the client offered the sentinel, the accepted 101 answers
   with it. Chromium fails a handshake whose subprotocol offer went unanswered,
   so the answer is required — and it is always the sentinel, never the ticket.

### Hibernation lifecycle

An admitted SubstreamAgent feed also accepts correlated
`load_transcript_range` requests. The request names the opening `snapshotId`, a
half-open sequence interval, and `resumeAfterEventSequence`; the answer names
the interval actually inspected. The socket's existing admitted identity is
reused for the range—there is no authorization call per returned turn or block.
The corresponding fence and snapshot UTC live in that socket's hibernation
attachment. They survive object eviction and are replaced by the next snapshot;
no global snapshot row or timeout is needed. A snapshot-expired or sequence-ahead request returns a resync outcome rather
than silently reading a new fence. Active response/plugin/tool/thinking and
compaction intervals carry their original UTC start plus the snapshot UTC and
elapsed baseline; the client advances clocks locally.

Both socket-holding objects, WorkspaceDO (workspace and Channel control
sockets) and SubstreamAgent, follow Cloudflare's [WebSocket Hibernation
server pattern](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/):

- The edge Worker validates the method, route, `Upgrade`, origin, ticket, and
  target before invoking a Durable Object, avoiding object requests for invalid
  handshakes.
- The object calls `state.acceptWebSocket(server, tags)` rather than
  `server.accept()`, then immediately calls `server.serializeAttachment(...)`.
  Acceptance must precede attachment so the socket is registered with the
  hibernation API before recoverable connection state is associated with it.
- No object relies on an in-memory session map. Event handlers enumerate
  `state.getWebSockets()` when they need the connected set and validate
  `deserializeAttachment()` at every use, so eviction loses no required state.
- WorkspaceDO attachments also carry explicit application foreground and the
  renderer's foreground work-stream ID. Missing fields from an older deployment
  default to background during rollout; healthy attachments preserve presence
  through hibernation without a timer or database row.
- Exact text `ping` frames receive `pong` through
  `setWebSocketAutoResponse()`, without waking an idle object. The current
  compatibility date also enables runtime close-frame replies; close handlers
  only perform product cleanup such as presence refresh.
- Continuous model fragments are coalesced into one frame every 100 ms or
  2,048 characters. That sits at the upper end of Cloudflare's recommended
  50–100 ms batching window and prevents token-sized WebSocket messages.
- Application timers exist only while a full agent loop is active. An idle
  socket has no interval or timeout in the object, so it can hibernate without
  accruing duration charges.

### Electron connection topology

The main authenticated Electron renderer maintains exactly one native Chromium
WorkspaceDO socket for the active workspace. It is not recreated when the user
changes work streams, and it carries every Channel's metadata, breakout list
and running background agents as that Channel's row. For each active work
stream, every pinned work stream, the five most recently active unpinned work
streams, and any other running work stream, the desktop also maintains one
SubstreamAgent feed socket for Main, and nothing else per Channel. The renderer
owns the feed's protocol state machine, caches, subscriptions, replay,
heartbeat, reconnect jitter, and telemetry. Only its raw Electron transport
crosses the typed preload bridge to a main-process Node broker. That broker
starts every initial handshake as soon as its ticket arrives, so Chromium's
same-endpoint CONNECTING lock cannot serialize a swarm. Main-to-renderer events use one bridge listener and an O(1)
socket-ID lookup rather than broadcasting every frame to every warmed adapter.
Browser development continues to use native WebSockets.
The Node broker resolves every new destination through Electron's system/PAC
proxy configuration and trusts both Node's bundled roots and the operating
system CA store. Moving handshakes out of Chromium therefore does not opt the
work-stream swarm out of managed-network routing or locally installed trust.
Semicolon-delimited directives retain their order: a failed pre-open attempt
advances to the next resolved proxy, and `DIRECT` is available only when policy
returned it. Node and the two object endpoints use one shared 1 MB maximum
application-frame size instead of `ws`'s 100 MB default.
Switching away keeps the exact feed socket
mounted for at least five minutes, so returning to a recently viewed work stream
does not spend another ticket request, handshake, subscribe, or snapshot. The
five-minute clock restarts each time the work stream leaves the foreground;
background-running, pinned, and five-most-recent conversation streams remain
connected beyond it while they retain that role. Holding a
pointer over any sidebar work-stream row for one second warms its
presence-free SubstreamAgent feed before navigation. Selection reuses that
socket; it does not wait for detail REST. A hover snapshot is explicitly speculative: it does not
settle the participant's unseen marker. Committed navigation promotes the
already-admitted socket with one `mark_opened` frame, after the cached snapshot
is available, so seen-state bookkeeping adds no click-to-paint request.
Leaving, cancelling the pointer, unmounting the row, or opening it before the
second passes cancels the warm-up. Once the feed opens, it can remain for up
to five minutes, and a newly qualified hover replaces any other unopened warm
feed; speculative warming is therefore bounded to one row. If the work stream
opens, the retained owner reuses it. Keyboard focus alone does not
warm a socket. Block sockets still
close with the panel and recover from durable checkpoints when it is opened
again. Access revocation is not delayed: the server closes every affected
retained feed immediately, and that feed permanently stops reconnecting. On the
workspace socket, which stays open for the sidebar, losing a Channel is that
Channel's row arriving as a tombstone, which evicts its cached state.

A cold feed open is bounded until route-matching detail and transcript caches
make the work stream renderable. The first attempt covers ticket issue, PAC
resolution, handshake, subscribe, and canonical state with a 10-second
deadline; two timeout retries use 20- and 40-second deadlines. A cacheless open
always subscribes from sequence zero even when its retained resume registry has
a later cursor, because replay alone cannot reconstruct missing base caches. A
schema-valid replay frame therefore does not finish opening; an authoritative
socket snapshot must install both canonical caches. At the deadline the client
checks the caches once more so a snapshot installed in the same turn can
transition to ordinary reconnect behavior instead of being overwritten by a
terminal socket error. Otherwise a timeout closes the broker-owned transport
and aborts an in-flight ticket before reconnect jitter runs. After the third total attempt,
the socket stops reconnecting and the opening screen shows a terminal error.
Its **Try again** action starts a fresh three-attempt sequence. Once canonical
caches exist, ordinary background reconnects remain governed by heartbeat and
reconnect behavior rather than this cold-open limit. Explicit ticket failures
and pre-state socket closes are not elapsed deadlines: they continue through
the existing jittered reconnect loop and do not consume one of the three timed
attempts.

Opening telemetry treats the composer as send-ready only after its active
work-stream handler is installed and the committed composer crosses a paint.
That handler submits through the workspace socket's command queue, not either
pooled work-stream socket, so connecting and reconnecting workspace transports
can still be client-ready. `workstream_send_ready` records that transport state
under the sidebar opening ID; it is not proof of delivery or server
acknowledgement.

The workspace socket carries its authoritative work-stream directory rows plus
durable topic invalidations for the other D1-owned workspace modules. Its
`workspace_sync_events.waterline` is monotonic inside the WorkspaceDO and each
row has a UUIDv7 trace ID. Live receivers ignore an equal/older waterline. On
reconnect the object unions every missed topic and sends one event at the newest
available waterline; if the bounded 1,024-row window cannot cover the cursor,
one `history_unavailable` event names every topic. The client needs current
state, not each invalidation that led to it.

**An event goes to the whole Organization unless it names an audience.**
`publishSync` takes the people it is for (`audienceUserIds`) or the connection
the write changed (`connectionId`), whose audience `WorkspaceDO` reads from its
own `connector_connections` row: the owner for a personal connection, everyone
for the Organization's, everyone for a connection it does not hold. The live
send skips every other socket, and the event is stored with its audience
(`workspace_sync_events.audience_json`, `NULL` for everyone) so that a
reconnect's replay unions only the events sent to that person; a person who
missed only other people's events is answered `resume`. `history_unavailable`
names every topic to everyone, which is each person's own invalidation and
carries no data. A waterline another person's event took is simply skipped by
this client, whose guard only needs the numbers it does see to rise. A replay
therefore answers at the log's newest waterline, not at the newest event it
unioned: a cursor left at the person's own last event would trail every later
event for somebody else, fall out of the pruning window, and cost a
`history_unavailable` refetch of everything.

Its complete topic catalog, and whose each one is:

| Topic | Refetched authoritative surfaces | Audience |
| --- | --- | --- |
| `workspace_profile` | Workspace name, slug, immutable region, workspace timezone, current role, inference-log policy, creation metadata, and onboarding workspace view. | Organization; the person alone for their own onboarding journey (`PATCH /workspace/onboarding`). |
| `member_directory` | Active/invited/suspended members, user name/email/avatar/timezone/role/join time, and onboarding membership state. | Organization. |
| `invitation_directory` | Pending/accepted/expired/revoked invitations, role, inviter, expiry, acceptance, and delivery-visible state. | Organization. |
| `connector_connections` | Connection identity, type, scope/owner, account/display name, capabilities, health/reconnect/error state, catalog capabilities, GitHub repository access, and onboarding connector state. Credentials never enter this feed. | The connection's: its owner for a personal connection, everyone for the Organization's. The person alone for their own Slack identity link. A provider webhook delivery: its matched connections' audience (below). |
| `connector_oauth_attempts` | Signals that a pending OAuth attempt should be read once from its authenticated endpoint. The renderer does not poll while the provider window is open. | The person who started the attempt. |
| `terminal_policy` | Workspace Terminal capability, Daytona configuration availability, network allow/deny policy, version, and validation/failure state. | Organization. |
| `digest_schedule` | Per-viewer digest enablement, cadence/timezone, destinations, and next run. | The person, for their own digest; the connection's audience when a connection a digest can deliver to changes. |
| `automations` | Automation detail, drafts and runs. **Not** the sidebar list, which is pushed whole as `workspace_sidebar_list`. | Organization. |
| `notes` | Note detail. **Not** the sidebar list, which is pushed whole as `workspace_sidebar_list`. | Organization. |
| `resources` | Resource directory, hydration/watch/content availability, work-stream context links, and connector-derived resource changes. | Organization; the connection's audience for a connection change or a provider webhook delivery, since a personal connection's resources are its owner's. |
| `activity` | Connector activity ingestion that can change opportunity generation or activity-derived UI. | Organization. |
| `work_opportunities` | Suggested work/actions, audience, version, accepted/dismissed state, and resulting work-stream directory changes. | Organization. |
| `workstream_directory` | Invalidates WorkspaceDO cursor-page membership/order and pin changes. Normal common/viewer state transitions instead push the current waterlined row directly. D1 is never a list fallback. | Organization. |
| `viewer_preferences` | Telemetry and other current-user workspace preference surfaces. | The person. |
| `feature_flags` | Effective client feature gates when a workspace-scoped producer explicitly publishes a change. | Organization. |

`workspaceSyncPublicationsForMutation` maps each authenticated write to its
topics and one of three audiences: `organization`, `actor` (the person who
wrote), or `connection` (the id in the path, or the one a creating route names
with `noteChangedConnection`; none named is everyone). The map is the one
publisher of a `/connections` request's own write, after its response; the
connection service publishes only what no request carries — an OAuth
completion, which a provider's redirect reaches without a session (and which
the Canva loopback, `POST /connections/canva/complete`, runs, so that route
maps to nothing), and background tool-count discovery. A connection write
publishes `connector_connections`, `resources` and `digest_schedule`, and not
`automations`: no Sidekick read consults a connection, which a Sidekick reads
only when one is applied or its principal is claimed, both of them Sidekick
writes that publish `automations` themselves. Starting an authorization
(`…/start`, `…/reconnect`) writes only the person's attempt, so it publishes
`connector_oauth_attempts` to that person; the completion publishes the
connection's topics to the connection's audience.

Provider webhook ingestion (GitHub, Linear, Notion, through
`services/provider-webhook-service.ts`) is the other background publisher. It
has no single connection id to name, since one delivery can match several
connections in several workspaces, so it passes `audienceUserIds` itself, per
workspace: `connector_connections` and `resources` go to everyone when any
matched connection there is the Organization's, and otherwise only to the
owners of the personal ones. A matched connection with no owner counts as
the Organization's. `activity` goes to the whole Organization.

Electron sends `list_workstreams` with a stable request ID, bounded limit,
optional opaque `(access_or_creation_time, workstream_id)` cursor, and the system-row preference. WorkspaceDO responds
with `workspace_workstream_page`, the directory waterline, each row's independent
common/viewer waterlines plus the corresponding UUIDv7 row identities, parsed work-stream rows,
and the next cursor. Pending page requests survive a transient reconnect
and reject only when the provider is disposed or the user/session changes. A
`workstream_directory` sync invalidation refetches these pages; it never asks a
REST/D1 list endpoint to reconstruct them.

A member's desktop loads its Channel rows a Space at a time. Once the Space
hierarchy is whole, the sidebar that answers a member's `subscribe` carries
every Space the viewer can see and no Channel rows, and says
`channelsBySpace: true`.
The desktop asks each Space with `space_channels`: a stable request ID, the
`spaceId`, optionally `after` (the previous answer's `nextAfter`), and `rails`,
whether to send rails with the rows. WorkspaceDO answers with one
`workspace_space_channels` frame. It holds a page of up to 250 of the Space's
Channels this viewer may see, in id order, as directory rows with their state
versions. Each row carries its breakouts (`privateChildren`), so one answer is
the Space's children and grandchildren. It also holds as many of those
Channels' rails as fit the frame beside the rows. `nextAfter` is the page's
last Channel when the page is full, and `null` when the Space ends there. A
Space the viewer cannot see gets an empty page; a guest's pages hold what the
listing rules give them ([`listing-rules.md`](listing-rules.md)). System Channels
are left off, as the connect page leaves them off.

The desktop walks every Space. It asks the Space on screen alone (else the
first Space of the Channel in front). Once that Space's first page is in, it
asks every other Space at once: the rest of the Space list, then archived
Spaces. Pages within one Space follow each other, since each asks after the
last. WorkspaceDO answers one request at a time either way, so asking together
saves a round trip per Space rather than server work. It asks for rails unless
it already holds one for every Channel it knows in that Space. Each page is
written as it lands, so the Space on screen paints before the walk is over. A
Space put on screen that no walk has returned, such as one created since the
last walk, is asked for on its own; a walk running then reaches it itself. When the walk
ends, a row held before it that no Space returned is dropped. A reconnect
walks every Space again, and every Space counts as loading until the walk has
returned it.

A `workstream_directory` invalidation does not walk every Space. It is
published to every socket in the Organization, for one person's pin as much as
for a Channel moving between Spaces, so a whole walk there would make every
desktop ask every Space at once. The desktop asks the Space on screen again,
and marks every other loaded Space to be asked again when it next comes on
screen. That re-read writes rows and drops none: a Channel that left a Space
arrives as a pushed row, and the next reconnect's whole walk is what retires
anything else.

A Space whose request fails shows the rows held for it and is asked again
when it next comes on screen. A whole walk that fails leaves the directory
query in error, and the sidebar stops waiting on the Spaces it did not reach.

A guest's socket is shaped by the same rules as a member's
([`listing-rules.md`](listing-rules.md)), with Organization-wide scope admitting
only members. The connect snapshot, `list_workstreams`, `workspace_workstream_state`
frames, `channel_rails` and `set_presence` all ask whether this person may list
the Channel, so a guest is sent nothing of an Organization-wide Channel they are
not in, not even a tombstone, and foregrounding one closes the socket as it
would a member's. `set_presence` also admits a Canvas id as the foreground
conversation, when the viewer may open that Canvas by its audience
([`canvases.md`](canvases.md#presence)); one they may not open is kept out of
presence the same way. A guest is sent no automations: the Sidekick library is a
member's.

The sidebar keeps the first page, and the desktop keeps `list_workstreams`
paging, while **an Organization is still opening** (`spacesReady` false). A
Channel can sit in no Space there, and the page is the only way it reaches the
sidebar.

Electron asks for Channel rails with `channel_rails`: a stable request ID and
up to 250 named Channels (`workstreamIds`). The retired Space target
(`spaceId`, `after`), which desktops 1.467.0 and 1.468.0 still send, is
answered with one empty final frame, since refusing it would close their
socket. Each
Channel row carries `railWaterline`; a held rail is stale once a row's passes
it. The desktop asks for stale rails by name, in order: the Channel in front,
then its Spaces, then the other Spaces, then Channels in no Space. Rails
mostly arrive with their Space's rows, so what is left is the rails that moved
since, or did not fit beside their rows.

WorkspaceDO answers with `workspace_channel_rails` frames, each at most
`WORKSTREAM_REALTIME_MAX_FRAME_BYTES` by encoded length, the last one `final`:
the rails that fit, `oversized` for a rail that fits no frame or fails its
schema (the client paints that Channel from its snapshot), and `unavailable`
for a named Channel the viewer is not sent a row for. Named Channels span as
many frames as they need. Every frame carries `nextAfter: null`, a leftover of
the Space target that desktops from before its removal still require. The rail
itself is
[`hosted-conversation-parents.md`](hosted-conversation-parents.md#a-channels-rail-and-its-waterline)'s.

A validated foreground visit persists this user's access time and sends
`workspace_workstream_recency` only to their subscribed sessions. This contains
one workstream, its state version, and the directory waterline; system rows are
included when visited. A cursor whose timestamp differs from its current row
restarts at page one, so a pre-upgrade activity cursor cannot silently skip rows.

Subscribing is answered with the sidebar itself. The `workspace_sync` event that
answers `subscribe` carries a `sidebar` field: one `workstream_page` body plus
the viewer's automations and notes, each bounded at 250 rows and each stamped
with its own waterline. All three come from this object's own SQLite —
`channels`, `automation_directory` and `notes` — read
with no `await` between them, so the sidebar opens on one consistent snapshot
and on no request at all. The client's `subscribe` frame names no collection, no
filter and no page size; it carries a waterline, which is where that client got
to, not what it would like.

The automation slice is deliberately limited to the two scopes the top-level
sidebar renders: every `workspace` automation and the viewer's own `personal`
automations. A `workstream` automation belongs only on its owning room's
automation rail, even when the viewer authored it. This is a positive scope
allowlist at the SQLite read, not an ownership inference after the read: the
whole subscribe answer is schema-checked as one value, so admitting a third
scope into that slice prevents the work-stream, note, project, and automation
lists from being sent at all.

Every subscribe carries it, cold or resuming. A resume where no topic moved
still gets one, under `reason: "resume"` with an empty topic list — the one
event shape allowed to name no topics, because it exists to hand over state
rather than to report news. That matters because a push can be missed while a
socket is away and produce no topic at all: a Sidekick moving its
next run time in `automation_directory` is exactly that; it advances the
automations list and its waterline without naming a `workspace_sync` topic. A resume that missed nothing costs the
bytes and applies nothing, since every list carries the waterline its pushes
carry and the client's comparison drops it. Receivers must apply the sidebar
*before* the topic-waterline guard, or a resume repeating a waterline the client
already holds would be discarded along with the state it was sent to deliver.
They must also skip `workstream_directory` while handling an event that carried
the sidebar: `initial` names every topic, so invalidating that one would send
the client back for the page the same event just delivered — the round trip this
payload exists to remove, reintroduced one line below it.

That private subscribe answer also carries the complete effective client
feature-flag object for the socket's user. The renderer applies it before the
workspace waterline guard for the same reason it applies the sidebar first: a
resume can legitimately repeat a workspace waterline while correcting a value
that lives outside it. Live flag changes arrive as a separate
`workspace_feature_flags` event with the changed key and the complete values.
They are deliberately not a `workspace_sync` topic broadcast: two people in the
same object may match different Flagship rules, so WorkspaceDO evaluates once
per connected user and sends only to that user's sockets.

A person joining or leaving a Channel or Breakout is sent as
`workspace_reach_changed`, naming only the people and never the conversation.
WorkspaceDO raises it where a directory projection flips a viewer's
`is_participant`: the Channel viewer write and the Breakout viewer write, which
every membership path reaches (direct add and remove, mention seating, Space
sources, scope grants, Breakout participant changes), and where an operator's
impersonation relationships are granted or revoked. It is addressed rather
than broadcast: a socket hears a user id only when its own user is that person
or holds an active impersonation relationship to them. It is not a
`workspace_sync` topic, because the topic enum is closed and a new value would
fail every older desktop's subscribe answer; an unknown event `type` is ignored
instead. It is not on the waterline or replayed, so a listener rereads on every
subscribe answer. Two clients listen. The desktop's own workspace socket rereads the
conversation directory (`shared-navigation`) on it: Channel rows and Space
pages already move on the same flip, but the directory says which conversation
a Breakout-only Channel opens on, and without the reread a new grant's row
opened on Main. `watchWorkspaceReach` in
`@rally/contracts/workspace-reach-watch` is the listen-only socket for a host
with no workspace socket of its own: it subscribes, discards the sidebar, and
reports only this event and subscribe answers, with a diagnostic hook the host
logs when it cannot connect. No shipped host holds one since Sideline was
removed; the browser client uses the full workspace socket. It is a filter
over `watchWorkspaceSocket` in the same module, the transport alone, which the
desktop's main process uses to hold the Channel directory behind the menu bar
([`menu-bar.md`](menu-bar.md)).

After a plan change, WorkspaceDO sends `workspace_usage`, the new usage meter,
to every member socket, outside the waterline and never replayed.
[`usage-metering.md`](usage-metering.md) owns it.

With `channelsBySpace`, that page is empty and the directory comes from the
Space walk above.

The directory page in that payload deliberately excludes system work streams.
Debug enabled is rare and engineers only, and the server does not hold the
preference — it lives in the desktop's own application settings — so a viewer
who wants those rows re-draws the sidebar from a `list_workstreams` request
carrying `includeSystem`. Loading the common case unasked and paying a round
trip for the rare one is the way round that suits the p95; the reverse would put
a debug preference in everyone's connect. The automations and notes do not vary
by it at all.

A third list, each viewer's Canvases, rides the same machinery on its own
event, `workspace_canvas_list`, with `canvases` as an optional key of the
subscribe payload's sidebar and its own `canvases` waterline in
`workspace_sidebar_list_state`. It is a separate event type rather than a third
`workspace_sidebar_list` discriminator value because a released client fails a
discriminator value it does not know and ignores an event type it does not
know. A Canvas row, its participants, its Chat's latest message or who is in
it now advance that waterline and push to every socket; one person's read or
pins push to that person alone. [`canvases.md`](canvases.md#the-canvas-list)
owns its rows.

Neither of the first two lists has a REST fetcher behind it any more. WorkspaceDO re-sends the
affected list whole as `workspace_sidebar_list` whenever it writes one of their
rows, so the batch is the only load and the push is the only refresh — which is
also why *every* first page is a batch, not just the cold one: a reconnect or a
debug toggle reloads the directory, and those two lists have nothing else to
reload them.

The two lists detect a change differently, because they have different writers.
Notes go through `runWorkspaceSql`, the one entry point every write to that
table passes through — a desktop REST write, a Workflow, and a workspace alarm —
and `SIDEBAR_LIST_SOURCE_TABLES` maps the written table to the list it
invalidates. Automations no longer have a workspace-local table to watch: the
authority is each Sidekick's own `automation_directory` row in the same
object, and every Sidekick write advances the `automations` waterline and
republishes the list in the same call that changes the row. Both paths end in the same
`workspace_sidebar_list` push.

That push exists rather than another `workspace_sync` topic for a reason that
predates the automation cutover and still holds: the writers that move a
sidebar row carry no HTTP request — a workspace alarm then, an object-to-object
projection now — so the mutation middleware that derives topics from a request
path never saw them, and a sidebar row's next-run time stayed stale until
something unrelated refetched the list.

The event carries the whole list and a waterline for that list, monotonic within
WorkspaceDO and advanced inside the transaction of the write that earned it. A
counter per list rather than one, because the lists change independently and one
counter would let a note write hide an automation update. The opening batch
carries the same numbers, so the batch and every later push land in one client
receiver that applies only a strictly greater version — `sidebar-list-store.ts`
— rather than handlers each trusting arrival order. A push therefore always
advances its list's waterline, even when only a derived field such as a Canvas
row's presence moved: one sent at the waterline the client already holds is
dropped. What the lists do *not* carry is a
version per row: unlike a work-stream row, which is assembled from child objects
over an unordered Queue and needs one per field, the list is the unit here, and
a row the viewer can no longer see is expressed by its absence, so archive and
delete need no tombstone. Each list is read per socket, because a personal
automation or note belongs to one viewer. The renderer applies WorkspaceDO-owned
fields such as pin position only when that row's observed directory waterline is
newer. Every socket reconnect also reloads a resident directory, because current
state rows intentionally do not retain every intermediate push for replay.

A Channel's row (`workspace_workstream_state`, and every row of a sidebar,
page or recency answer) is a complete snapshot, not a partial patch. Sending
null clears a prior value. Common and viewer fields each carry their own
authority-local waterline and UUIDv7 row ID; they are time-sortable
trace/deduplication identities, not a distributed causal clock. On the
workspace socket, a row the viewer may see also carries what the Channel
control socket used to add for its viewer: `privateChildren` (the ready,
unarchived breakouts with this viewer on the roster) with its own
`privateChildrenWaterline`, and `backgroundAgentCounts` (running background
agents by the conversation they work for, counted only for Main and this
viewer's breakouts). Absent means the row does not say, never "none": a REST
row, an older server, and a Channel whose parent is still waiting for its
import all leave the fields out. The breakout list has its own waterline
because it moves with rosters, which do not advance the row's state version.

A state change can still arrive more than once and out of order: a row is
republished by the directory apply, by a breakout roster change, and on a
redelivered effect, and the effects behind it cross an at-least-once, unordered
Queue. Every copy goes through the same Electron ledger. A field applies only
when its authority generation is newer or its own common/viewer waterline
advances; advancing viewer state can never suppress a delayed common update. A
breakout list applies only when its own waterline does not go back. No interval
polling participates in convergence.

The accepted breakout roster also reconciles cached Threads pages and their
pinned copies: resolved children change rank and styling, and children absent
from the roster are removed. Incoming REST pages use the same roster so an
older response cannot restore a removed child. A thread visibility tombstone
refreshes the navigation list; it is not itself proof of an archive.

The retained feed sockets are deliberately not presence. Electron
main reports whether the Rally application has any focused window; each
renderer combines that with its own document/window focus and active route,
then reports the result over the persistent WorkspaceDO socket after subscribe.
Current SubstreamAgent subscriptions send `publishPresence: false`, so an
inactive pin or recent row never enters the legacy feed viewer set. Omitted
fields still default to `true` for older clients during compatibility, but the
current renderer ignores `presence_changed` and resolves the inspector viewer
list exclusively from WorkspaceDO's foreground user IDs.
WorkspaceDO answers with a viewer-scoped snapshot for that one foreground work
stream and excludes the viewer. This separates transport warmth from attention
without adding another connection, heartbeat, or hibernation wake-up.
Each command carries a socket-local revision because its D1 session check yields
the Durable Object input gate; a handler that resumes late cannot restore an
older focus state. Directory visibility changes synchronously revalidate and
clear foreground attachments, and the renderer drops its cached snapshot on a
route change or transport loss.
After the socket's ordinary ticket handshake, presence never uses REST for
write, read, replay, or recovery.

The feed ticket signs the renderer's last applied sequence. A current
SubstreamAgent performs session/membership admission once, stores that admitted
role in the hibernation attachment, and completes the presence-free subscription
before returning the upgrade. An explicit client `subscribe` remains only as a
compatibility path for an older server that did not advertise ticket bootstrap.
Speculative hover intent is signed beside the cursor; the Worker strips both
canonical and legacy client spellings before forwarding either trusted header.
Revocation still closes the admitted attachment; admission reuse is not a new
authorization lifetime.

The Electron broker emits PAC resolution, DNS, TCP, TLS, and edge HTTP-upgrade
durations for direct routes. Proxy CONNECT, TLS, and edge work is deliberately
one aggregate because the proxy agent exposes no reliable inner transition.
Failed PAC routes are counted and timed before the next ordered route begins.
The broker gives the phase callback to its socket factory before client
construction. A phase emitted synchronously during construction is held only
until the broker records renderer ownership, then relayed before later phases
flow live. This closes the main-process factory/listener gap defensively. It
does not establish that the gap caused historical missing fields; an absent
phase still requires checking the packaged-client version and whether that
native phase was emitted.

Checkpoint, queued/running, and terminal publications enter one per-agent
serial queue only after their SQLite transition commits. Adjacent unsent
cumulative checkpoints coalesce to the newest value; queued/running/terminal
events remain ordering barriers and are never replaced. The queue catches and
logs authorization or send failures under `waitUntil`; the Bind callback and
result settlement never await optional socket delivery. A reconnect snapshot
therefore repairs a dropped or coalesced frame, serialization prevents a slow
queued publication from arriving after the matching running state, and a slow
viewer revalidation cannot retain one ever-growing text value per token batch.

`SubstreamAgent` remains the only socket for transcript parts, attachments,
tool/elicitation/suggestion blocks, active token frames/checkpoints, explicit
compaction activity, presence, replay cursors, snapshots, and resync/download. A
compaction start is durable object-local state included in snapshots and resync
frames; the matching finish or a terminal run status clears it. No workspace or
work-stream metadata is inferred from token frames or token silence.

Transcript history is a correlated, viewer-specific request on that same
SubstreamAgent socket. Electron sends `load_transcript_range` with the opening
snapshot ID, an explicit half-open canonical sequence interval,
`resumeAfterEventSequence`, and a request UUID. The agent revalidates the
socket's session and product visibility, requires the snapshot fence still to
match, reads canonical turns, and returns `transcript_range` or a correlated
resync/error outcome. Range replies do **not** allocate a shared room sequence
and are neither broadcast nor replayed: they answer one reader's query and must
not move every other reader's resume cursor. Returned coverage is authoritative
even when no turn occupies part of the interval. A range request belongs to the
exact admitted socket and snapshot fence that sent it. Socket close or
`resync_required` rejects every outstanding request as
`workstream_socket_unavailable`, allowing the screen to retry after canonical
recovery instead of waiting for a timeout that no replacement socket can answer.

Refreshing canonical state is the deliberate opposite. `request_snapshot` takes
no cursor and is answered with the ordinary sequenced `snapshot` frame rather
than a correlated one, so the reply is ordered against the feed and the reader's
existing cursor guard decides whether it still applies. A viewer asking for
canonical state is saying its own may be wrong, which is exactly why a cursor it
supplied cannot be trusted to bound the answer. The request is refused unless
the socket is already subscribed: an unsubscribed socket has no feed to refresh,
and answering one would serve canonical state on a connection that never passed
the subscribe path's authority and maintenance checks. When hibernation has
discarded the replay window, subscribe itself answers with that canonical
snapshot on the still-admitted socket and then catches up any event published
during assembly. If snapshot assembly fails or that one catch-up has already
overflowed the memory window, the room keeps the attachment cursor unchanged
and returns `resync_required` with reason `history_unavailable`. The same REST
fallback uses `sequence_ahead` when the client's cursor guard cannot accept a
lower-sequence socket snapshot; [`architecture.md`](architecture.md) owns the
rest of that behavior.

The initial socket snapshot carries bounded canonical transcript ranges. When a
viewport is within 160 px of the top, Electron requests the adjacent half-open
sequence range, merges it under the snapshot fence, and restores `scrollTop` by
the exact height inserted above the viewport. Newer-range and jump-to-latest
recovery use the same socket path. Layout, scrolling, resizing, and window visibility all
recheck that position.
Short opening feeds fill through the same path. Errors stop automatic paging
and expose a retry control; normal paging shows only a loading status.
A hidden window produces no automatic paging traffic, and the
accepted socket continues to hibernate. A transcript frame is capped at the
shared 1,000,000-byte realtime-frame limit: multi-turn ranges narrow to
truthful coverage, while an indivisible oversized turn keeps its sequence as a
payload-free `blocksOmitted` envelope rendered as a placeholder.

### The deprecated query transport

Workspace, work-stream, conversation, and dictation issuers return query-free
URLs and a separate ticket. Current clients discard all query data from older
responses, including capability flags, and present the ticket in subprotocols.
The upgrade service still accepts deprecated inbound query tickets for clients
that already have one; no current issuer produces them.

### Forward-compatible event reception

Every Rally stream ignores unknown incoming event types. Known events are parsed
through `safeParseSocketEvent` in `packages/contracts/src/socket-events.ts`, which
removes unrecognized object fields, including nested fields, and validates the
remaining data against the same contract. Invalid known values still fail their
existing checks; sender and durable-storage schemas remain strict. Unknown frames
do not advance replay cursors or resolve pending commands. Dictation likewise
ignores unknown provider events before they can bind a pending transcript item.

Socket behavior is unconditional: URLs contain no capability configuration and
a Channel row always carries appearance. Older stored socket
attachments may contain obsolete capability fields; they are ignored on restore.

## Invariants

- **A ticket never appears in a URL a current client opens.** Cloudflare records
  request URLs into stores this repository cannot redact; a ticket in the query
  is a live credential in all of them. Break this and the credential is back in
  the invocation log, the 90-day Logpush export, and every trace span.
- **A room diagnostic never reaches the client handshake.** The room reports
  its accept duration and instance age to the edge on the 101 it answers with;
  the edge records them and strips both before negotiating the subprotocol. A
  header the client did not ask for on a handshake is a header a future reader
  will trust.
- **Only the sentinel is echoed.** Returning the ticket would move it from a
  request header to a response header and undo the change. `ticketId` is not the
  ticket: it is the `jti` a replay check already refuses a second use of, and it
  authorizes nothing on its own.
- **A client that offers the sentinel is held to it.** Falling back to the query
  when its offer is malformed would let a stale URL credential stand in for the
  one the client meant to present.
- **Only a real upgrade is rebuilt.** workerd permits status 101 solely with a
  WebSocket attached, so rebuilding one of the room's JSON rejections throws a
  `RangeError` that no error-middleware branch matches — turning every
  deliberate 401, 403, or 409 into an unhandled 500.
- **No Durable Object receives the signed bearer ticket.** It is verified
  at the edge and stripped from the subrequest. The feed child consumes the JTI
  in `durable_inbox_receipts`; WorkspaceDO consumes the workspace and Channel
  control tickets in `workspace_socket_ticket_receipts`. Workspace membership remains in D1 while
  work-stream participation/revocation is projected locally.
- **Ticket audiences are not interchangeable.** Workspace, aggregate metadata,
  and feed tickets cannot open one another's sockets, and a feed ticket names
  its parent kind, so a ticket for one automation's conversation cannot open a
  work stream's. Otherwise a narrow read
  credential could become a workspace write credential.
- **Origin is checked before the ticket is read.** An exact match against
  `ALLOWED_ORIGINS`, so a lookalike host cannot spend a ticket.
- **A ticket is single-use.** Each target object and the dictation bridge consume
  the `jti` atomically; a replay is refused rather than opening a second socket.
- **A turn is read by the person who wrote it, on the client too.** The room
  advances the author's own `seen_attention_ordinal` in the write that stores
  their message, but the canonical turn reaches their own client first, and
  `advanceWorkstreamAttention` decides unread from it before that viewer state
  arrives. Guessing "unread" in that gap is visible: it draws the **Unread
  messages** divider above the turn the person just sent and lights their own
  sidebar dot for it, for as long as the correction takes. Any local advance of
  attention state applies the room's own author rule rather than waiting to be
  corrected by it.
- **A local advance moves waterlines, never the manual mark.** The room clears
  `manual_unread_from_ordinal` in that same write and a client must not, because
  a turn frame carries no ordering against it: `markUnread` stores the mark at
  the *latest* ordinal, which for a turn the reader just sent is that turn's own,
  so no ordinal comparison separates a mark made before the write from one made
  after it, and the generation that does order them is not on the frame. A
  delayed or replayed own turn — a reconnect, or the same account marking the
  stream unread on another device — would otherwise erase a decision the room is
  still honouring. A waterline is a fact about what arrived and is safe to
  predict; the manual mark is somebody's instruction, and only the room revokes
  it.
- **A close code says why the socket closed.** On the workspace command socket,
  released clients reserve `1008` for an actual access revocation. Invalid JSON
  or an event that fails the shared schema closes with application code `4400`;
  a current session that no longer authenticates closes with `4401`. Reusing
  `1008` for either would permanently stop reconnect and tell the member an
  access decision occurred when none did.

## Boundary

This module owns admission: issuing a purpose-specific ticket, presenting it,
verifying it, and answering the handshake. It exposes the transport helpers in
`@rally/contracts/socket-tickets` to both the Worker and the renderer, and
`issueSocketTicket` / `verifySocketTicket` to the services that need them.

It does not own what happens next. Workspace synchronization, direct room
command admission, child subscription, event replay, presence, and
`resync_required` are described in
[`architecture.md`](architecture.md); the reconnect and heartbeat behavior of
the client is in [`runbook.md`](runbook.md), and how often that reconnect
actually happens is measured by `realtime_socket_state` in
[`telemetry.md`](telemetry.md) — from the client, because admission cannot tell a
first connection from a fourth attempt; dictation's audio limits and Azure
contract are in [`architecture.md`](architecture.md); which data belongs on an
admitted socket at all, rather than behind a REST read, is
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md). It depends on
`SESSION_SIGNING_KEY`, `ALLOWED_ORIGINS`, and the regional Durable Object
namespace helper.

## Failure modes and limits

- **No ticket presented** — 401 `socket_ticket_required`, before any room call.
- **Malformed subprotocol offer** — 401, without consulting the query.
- **A non-sentinel offer** (`graphql-ws`, say) — nothing is read out of it; 401.
- **Bad signature, wrong audience, expired** — 401 `invalid_socket_ticket`. The
  ticket lives 60 seconds; a client that stalls between issue and open must ask
  for another.
- **Wrong audience, region, workspace, parent, or substream** (403
  `socket_ticket_scope_mismatch`).
- **A write on a conversation whose parent is archived** (the object answers
  409 `conversation_parent_archived` on the socket; the read side stays open).
- **Disallowed origin** — 403 `socket_origin_forbidden`.
- **Object refusal** — the object's own JSON status reaches the client unchanged:
  426, 400 `invalid_socket_identity`, 403 `forbidden`, 401
  `socket_ticket_replayed`, 409 `room_identity_mismatch`, 500
  `websocket_unavailable`.
- **Dictation at capacity** — 429 `dictation_concurrency_limit`, at two
  concurrent sessions per user and twenty per workspace.

Once a workspace socket is open, its terminal close outcomes are distinct:

- **Access was revoked** — `1008`. Electron stops reconnecting and reports
  `workspace_access_revoked`.
- **The session is inactive** — `4401`. Electron stops reconnecting and asks the
  member to sign in again under `workspace_session_inactive`.
- **The command frame is invalid** — `4400`. Electron stops resending the same
  invalid command and reports `workspace_socket_invalid_message`, asking the
  member to restart the app and retry.

WorkspaceDO records every identity, protocol, or inactive-session close as
`workspace_socket_closed`, with the close code, fixed cause, operation, frame
size, connection identity when available, and at most 25 schema issue paths and
codes. It never logs the frame, rejected values, Zod messages, or schema regexes.
The access-revocation consumer retains its separate
`workspace_socket_access_revoked` count because that close is an authorization
event rather than a protocol diagnostic.

The client treats every one of these as a failed connect and reconnects with
jittered backoff; it does not distinguish them, which is why the status is worth
keeping correct for whoever reads the logs.

### An instance that stops hearing its sockets

On 2026-09-23 the Juno Labs WorkspaceDO kept accepting workspace-socket upgrades
for hours while running no `webSocketMessage`, no `webSocketClose`, and no ping
auto-response. Alarms, RPC, and upgrades all kept succeeding, so nothing
failed: desktops with no warm directory cache sat at "Opening channels…", and
only the next deploy, which restarts the object, cleared it. The runtime cause
is not known.

WorkspaceDO now watches for it. Every socket must send its first frame within
`WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS` (two minutes, set by the team; the
desktop sends `subscribe` the moment a socket opens).

**The watch keeps a ledger, because the socket does not stay.** Accepting a
socket writes a `workspace_socket_unheard` row, and its first frame deletes it.
The desktop abandons a socket after 65 s without a pong, and the runtime then
drops it from `getWebSockets()` even when the stuck object runs no close
callback. A watch that read only open sockets therefore never saw a silent one
reach its deadline while anyone was still retrying: it fired only once people
gave up and left a half-open socket behind. The ledger row outlives the socket.

The earliest ledger deadline is a derived alarm candidate, and accepting a
socket lowers the alarm to it first, before the row or the socket exists. The
check runs at the start of every alarm, before the maintenance deferral can end
it early. When an alarm finds a row past its deadline, whether or not its socket
is still open, **and** the object has heard from no socket at all since that
socket was accepted, it logs `workspace_socket_first_frame_missed` at error
level (counts and ages only) and calls `state.abort()`. The abort drops every
socket (clients see `1006` and reconnect) and the platform starts a fresh
instance. A row past its deadline that the object *has* heard past is deleted
as answered, so it cannot pin the alarm to a deadline already gone.

**A row an earlier instance accepted, for a socket now gone, is answered too.**
That instance was either reset by this watch or evicted, and an evicted
instance was not stuck. This is what lets a fresh instance settle the rows a
reset left behind without the reset writing anything first, and what keeps a
healthy object that heard a close and then hibernated from reading the row as
a socket it never heard: the close callback's evidence lived only in the
evicted instance's memory. A stuck instance keeps accepting upgrades, so it is
never replaced in the middle of a wedge.

An object held at schema 57 for meeting-notes retirement has no ledger table;
the watch is off there until an operator finalizes it.

**One silent socket is never enough on its own.** Its client controls it, so a
silent socket alone would let any member reset the whole Organization every two
minutes. The object must also have heard from nobody since, and any one of
three signals says it has:

- **The runtime answered some socket's ping** at or after the silent socket's
  accept (`getWebSocketAutoResponseTimestamp`). Idle desktops ping every 50 s,
  and the stuck object answered none. Kept by the runtime, so it survives
  hibernation.
- **A socket accepted at or after the silent one has spoken** (`subscribed` or
  `firstFrameReported` in its attachment). Also survives hibernation.
- **This instance ran any socket callback** after the silent socket's accept:
  a frame, a close, or an error. In memory only, so a hibernation wake forgets
  it; the two above cover that case.

"Spoke" means any frame: `firstFrameReported` is written before the handler
awaits anything, so a slow `subscribe` does not look silent.

**What a false positive looks like.** A client never has to die for a socket to
go silent: the server only has to accept it and never hear a frame, which is
what happens when a connection drops after the upgrade and before `subscribe`
arrives, on a Wi-Fi drop or a laptop lid closed just after a resume reconnect.
Since the ledger, such a socket counts even after it closes, as long as the same
instance is still running at its deadline. It resets the object only when no
other socket answers a ping, speaks, or closes in the following two minutes,
which in practice means nobody else is connected; then the reset interrupts
only background work
(alarms retry, and Queue-delivered RPC redelivers). A member who is the only
one connected can cause the same on purpose. Either shows up with few `open_sockets` and a
`missed_sockets` of one; a wedge with people retrying shows several missed
sockets, most of them in `missed_closed_sockets`.

**One missed socket is held, not reset.** Below
`WORKSPACE_SOCKET_MISSED_SOCKETS_BEFORE_RESET` (two, set by the team), the
watch logs `workspace_socket_first_frame_held` at warn level, once per
instance, and keeps the ledger row so that the next silent socket counts with
it. A held row stops being an alarm candidate, since its
deadline is already past; a hibernation wake forgets which rows were held and
judges them again, once. Any later socket that speaks settles it. A real wedge
with a client retrying reaches two within one more retry, about a minute or
two.

The desktop narrows the window from its side too. A dialled workspace socket
that has not opened within `WORKSPACE_SOCKET_OPEN_TIMEOUT_MS` (15 s, set by the
team) is closed and redialled, so a live client whose `101` was lost speaks on a
new socket well inside the server's deadline, and that settles the silent one.
Main relays `powerMonitor` suspend and resume to every window: on suspend the
provider aborts any ticket in flight, settles and closes its socket, and dials
nothing until resume, the network coming back, or a person asking to
reconnect.

Directory pages are read-only and are not reconnect-resend commands. If
Electron receives the browser `offline` signal while a page is in flight, it
clears that request's 120-second timer and rejects immediately with
`workspace_directory_offline`. Room message commands remain pending because
their client message IDs make reconnect resend idempotent. Each pending command
also remembers the socket instance that most recently accepted it: submitting a
second command on a healthy connection sends only the new command, while a new
socket instance after reconnect replays every command still awaiting its private
receipt.

## Testing

| Suite | Command | Covers |
| --- | --- | --- |
| `packages/contracts/src/socket-tickets.test.ts` | `pnpm --filter @rally/contracts test` | The wire format: offers, parsing, refusal of non-tickets, URL stripping. |
| `apps/api/test/socket-ticket-transport.test.ts` | `pnpm --filter @rally/api test` | Precedence and the negotiation decision, on Node. |
| `apps/api/test/workstream-socket-warm.test.ts` | `pnpm --filter @rally/api test` | `ConversationService.socketTicket`: the parent's viewer decision gating the ticket, the parent kind and archive decision on it, and the deferred main-substream warm-up. |
| `apps/api/test-workers/socket-subprotocol-runtime.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts` | The runtime constraint, on real workerd. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts` | Hibernating WorkspaceDO and SubstreamAgent attachments/snapshots; authoritative workspace directory application/page/resource queries; eviction; native-RPC envelopes; workspace protocol/session/access close-code separation and payload-free diagnostics; truthful bounded transcript ranges; indivisible-turn payload-free envelopes; revocation; compaction recovery; queued-run coalescing; and ticket replay on real workerd. |
| `apps/api/test-workers/workspace-socket-first-frame.test.ts`, `apps/api/test/socket-first-frame-watch.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts`; `pnpm --filter @rally/api test` | The first-frame watch, through the real accept and alarm paths: silent sockets below the reset threshold are held, logged at warn, and kept without holding the alarm, and the one that reaches it resets; a held socket is let go once a later socket speaks; with the threshold at one, a silent socket on a silent object resets it, logs, and is dropped, also while the region is closed for maintenance and after its client has already closed it; each of the three "still hearing sockets" signals alone prevents a reset, including after a hibernation wake; the ledger forgets a socket once it speaks, lets go of a judged row, and does not reset a fresh instance after a reset or an eviction; accepting pulls the alarm in. |
| `apps/api/test-workers/message-to-output-pipeline.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts` | Fresh message admission and its private receipt on the authenticated SubstreamAgent socket, stable turn identity after hibernation/resend, and the message-to-provider pipeline on real workerd. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx`, `use-workstreams-query.test.tsx`, `workstream-state-store.test.ts` | `pnpm --filter @rally/desktop test` | One persistent workspace connection, truthful terminal errors for access/session/protocol closes, correlated directory pages/pagination, immediate offline page rejection, waterline resume, stale/duplicate rejection across both sockets, independent common/viewer ordering, and idempotent command resend. |
| `apps/api/test-workers/workspace-socket-fanout.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/workspace-socket-fanout.test.ts` | Sync topic audiences on real sockets, live and on replay, and the Channel row's; the full list is in [`websocket-architecture.md`](websocket-architecture.md#testing). |
| `apps/api/test/workspace-realtime-service.test.ts` | `pnpm --filter @rally/api exec vitest run test/workspace-realtime-service.test.ts` | The mutation map: each write's topics and audience. |
| `apps/api/test-workers/channel-viewer-state.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts` | Each viewer's own breakouts on the connect sidebar, per Channel; a roster change pushed to that breakout's members only; running background agents pushed to every reader and counted only where each can look; a lost Channel tombstoned without closing the socket; the current list after a resubscribe; nothing said for a parent still waiting for its import; foregrounding a Channel warms its Main. |
| `apps/api/test-workers/channel-rails.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts test-workers/channel-rails.test.ts` | `channel_rails` answers on a real socket: rail contents, `unavailable`, `attached` absent until reported, frames within a lowered frame limit and `oversized`, a guest's answer, a corrupt stored row that still ends in `final`; and the row pushed with a higher `railWaterline` for each kind of rail change. `space_channels` on the same fixture: a Space's rows with their breakouts and rails for each viewer, rails that do not fit left out, paging by visible Channels, and the Spaces-only sidebar once the hierarchy is whole, for a member and a guest alike, with the retired `channels_by_space` ignored. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx` (breakouts block) | `pnpm --filter @rally/desktop test` | The breakout list and running agents taken from sidebar and pushed rows and kept with no screen observing them, waterline order, silence on an absent field, eviction on a tombstone, receipt-backed appearance, and pruning the disk cache to the roster. |
| `apps/desktop/src/main/realtime-socket-broker.test.ts`, `realtime-socket-ipc.test.ts`, `apps/desktop/src/common/realtime-socket-validation.test.ts` | `pnpm --filter @rally/desktop test` | Ordered PAC fallback, shared frame ceiling, normal-close removal, renderer-owner isolation, shared IPC channels, main-window authorization, and strict main-to-preload events. |
| `apps/desktop/src/renderer/lib/workstream-socket-pool.test.tsx`, `use-workstream-socket.test.tsx`, `apps/desktop/src/renderer/screens/workstream.test.tsx` | `pnpm --filter @rally/desktop test` | Initial admission for the pooled SubstreamAgent feed and that no Channel control ticket is ever requested, exact-feed reuse for five minutes after switching streams, background/recent overlap, expiry and backward-clock recovery, in-place route reconciliation, direct SubstreamAgent command/feed reconnect, private message receipts, streaming, explicit compaction lifecycle/reconciliation, range merging, oversized-turn placeholder rendering, and scroll thresholds/anchor preservation. |
| `apps/api/test-workers/conversation-parent-contract.test.ts` | `pnpm --filter @rally/api test:workers` | `authorizeViewer` on both kinds of parent through the real ticket route, refusal of fresh tickets for a Sidekick archived with its room, and the read-only socket refusal for retained legacy room-archived Sidekicks. |
| `scripts/smoke-local.mjs` | `pnpm smoke:local` | A real handshake end to end, both transports, and the replay status. |

**The trap, and it has already cost one bug:** Node's `Response` refuses status
101, so the Node suite stands in a fake one. That fake validates nothing, which
means it will happily construct the invalid upgrade that workerd rejects — a
test written there can assert a rebuild "works" while production throws. Any
assertion about what may be *constructed* belongs in `test-workers/`, where the
runtime is the real one. Ticket fixtures are also deliberately not shaped like
real JWTs: a `eyJ`-prefixed literal trips the Gitleaks `jwt` rule and fails the
`secrets` gate on the pull request that adds it, and deleting it in a later
commit does not clear it — the scan reads commits, not the working tree.

## Security and trust model

The handshake is an unauthenticated surface reached before any session exists,
so everything on it is untrusted: the origin, the offered subprotocols, and the
URL. The ticket is the only thing that carries authority, and it is verified
before anything else is believed.

The reason the transport moved is that Cloudflare's capture is wider than
Rally's. `request-context.ts` logs `pathname` only and `redact` scrubs by key,
but the platform records the whole request independently — the invocation log's
`$workers.event.request.url`, the Logpush export's `Event`, and a trace span's
`url.full` and `url.query`. Nothing in this repository can reach those. The
`Sec-WebSocket-Protocol` header is not captured, which is the whole point.

The sentinel is public and carries no authority. The other query-string
credential on this surface — a connector OAuth callback's `?code=` — is fixed by
the provider's redirect and cannot move; [`security.md`](security.md) records
what that leaves exposed.

Child archive admission uses the same `parent_archived` ticket field as parent archive. Already-open private-child sockets additionally check the versioned local archive mirror; there is no per-command parent RPC. See [work-stream durable objects](workstream-durable-object.md) for lifecycle delivery.

## Changelog

### 2026-11-07 — A Canvas's Chat is a conversation feed with ticket kind `canvas`

**What changed:** A conversation ticket's `pk` may be `canvas`, and
`verifySocketTicket` accepts it. The route admits a Canvas reader by the
Canvas's audience and seats them in the Chat before minting, as it does for a
Sidekick's conversation. The workspace socket carries each viewer's Canvas
list: `canvases` on the subscribe payload's sidebar and a
`workspace_canvas_list` push; `set_presence` admits a Canvas the viewer may
open as its foreground conversation.

**Why:** A Canvas's Chat is an ordinary conversation object (the Canvases and
Sidekicks decision log), so it opens on the same feed socket. The list is its
own event type because a released client fails a `workspace_sidebar_list`
discriminator value it does not know and ignores an event type it does not
know.

**Consequences:** The conversation object refuses a ticket whose kind
disagrees with its root row, so a Canvas id cannot be opened as a Thread. A
new sidebar list goes on its own event type, never as a new discriminator
value of an existing one.

### 2026-11-06 — The iOS client is deleted

The native client that set `app://rallywithai` on its own handshake and kept
opening the retired control socket is gone; the control socket now serves only
installed desktops, and its removal is a later phase of the [Canvases and Sidekicks pivot](PRDs/2026-11-06_canvases-and-sidekicks/prd.md).

### 2026-10-16 — The dictation lease is held by the open socket, not by its frames

**What changed:** The proxy renews a dictation session's WorkspaceDO lease on
a 60-second timer for as long as the client socket is open. Renewal used to
ride on client frames, once per 60 seconds of them.

**Why:** The desktop now opens the socket as soon as its ticket lands, which
can be while the microphone permission prompt is still up (the
[`conversation-surfaces.md`](conversation-surfaces.md#changelog) entry of the
same date), and a paused recording has always sent nothing. Either can outlast
the two-minute lease with no frame to renew it, after which the next
admission's sweep deletes the session row; the socket keeps proxying, because
a failed renewal is deliberately not fatal, so the recording runs outside the
per-user and per-workspace caps. Found in review of #1259.

**Considered and rejected:** Delaying admission until the input resolves,
which gives back the overlap the client change exists for. Making a failed
renewal close the socket, which would let a WorkspaceDO that was briefly
unreachable end a live recording.

**Consequences:** A live socket holds its lease for as long as it is open,
whatever travels on it; the frame handler no longer touches the lease, and the
timer is cleared on every path that releases the session.

Shipped in #1259.

### 2026-10-03 — A guest's workspace socket carries no member directory

**What changed:** WorkspaceDO sends a guest's socket no Channel rows (connect
snapshot, `list_workstreams` pages, `workspace_workstream_state` frames,
tombstones included) and no sidebar automations. A guest's `set_presence`
foreground is dropped, and `channel_rails` answers a guest only for a Channel
they take part in.

**Why:** Those lists follow member rules, so a guest received every
Organization-public Channel's title, description, email address and activity,
and every workspace automation. The old browser guest shell ignored the
snapshot; once guests mounted the desktop shell, it cached the rows, which is
how the gap surfaced (security review on #1088).

**Considered and rejected:** Filtering on the client, which leaves the data on
the wire; and sending guests the Channels they participate in, which the
shell does not need, since a guest's rail is `shared-navigation`. Checking a
guest's foreground against their grants: this object's visibility check
follows member rules, and a Breakout-only guest's Channel fails it, which
closed their socket.

**Consequences:** Anything a guest's shell shows about a Channel comes from
`shared-navigation`, the conversation's own socket, or a rail for a Channel
they take part in. A guest's sidebar times and unread marks refresh with
`shared-navigation` (focus, reach changes) rather than live. Members see no
workspace-level presence for a guest. A new list or message on the workspace
socket must decide what a guest gets before it ships.

Shipped in #1088.

### 2026-09-30 — Every member is sent Spaces, and `channel_rails` names Channels only

**What changed:** A member's connect sidebar carries Spaces and no Channel rows
whenever the Space hierarchy is whole, without the desktop asking.
`channels_by_space` is retired. The `channel_rails` Space target (`spaceId`,
`after`) no longer reads a Space: it is answered with one empty final frame.

**Why:** Both were kept only for desktops from before 1.469.0, the first
release that walks Spaces. Those desktops have had time to update.

**Considered and rejected:**
- *Keeping `channels_by_space` as a no-op.* An unknown event type is already
  ignored, so a desktop that still sends it needs nothing from the server.
- *Refusing the Space target.* A 1.467.0 or 1.468.0 desktop still holding
  rows from its disk cache would ask a Space for them, and a refused request
  closes the socket with 4400, which it would then hit again on every
  reconnect. An empty answer costs one frame.
- *Removing the desktop's paging toward a Space's `channelCount`.* It only
  runs against the first-page sidebar, which a member no longer gets. But a
  desktop from this change meeting a server from before it, in a rollback,
  would get that page with no opt-in sent, and the paging is what fills a
  Space there. It stays until that cannot happen.

**Consequences:**
- A desktop older than 1.469.0 is sent no Channel rows and never asks a Space
  for them, so its sidebar lists nothing. That is the cost of this change for
  anyone who has not updated. It stays connected.
- `nextAfter` is still sent, always `null`, because 1.469.0 through this
  release require it on a `workspace_channel_rails` frame. The contract now has
  it optional, so a later server can stop sending it once those releases are
  gone.

### 2026-09-30 — One silent socket is held, and the desktop stops leaving them

**What changed:** WorkspaceDO resets only once
`WORKSPACE_SOCKET_MISSED_SOCKETS_BEFORE_RESET` (two) sockets are missed at
once; fewer are held, logged as `workspace_socket_first_frame_held` at warn
level, and kept in the ledger without being alarm candidates. The desktop closes
and redials a workspace socket that has not opened within
`WORKSPACE_SOCKET_OPEN_TIMEOUT_MS` (15 s), closes its socket and dials nothing
after `powerMonitor` suspend until resume, the network coming back, or a manual
reconnect, and reports `open_timeout` and `suspended` as socket causes. Handshake telemetry gains `sinceTicketRequested`
and `windowVisible`.

**Why:** Eleven resets in three days paged #firehose-alert, all with
`missed_sockets: 1`, and none was a wedge. Matched by request ID against the
desktop's handshake telemetry, two were a Mac app on 1.469.0: one got its
ticket, the server sent `101`, and the socket sat CONNECTING for about twelve
minutes, because nothing timed out an open; the other asked for a ticket that
reached the server five minutes later, with its 10-second ticket timeout never
firing, so the renderer was not running. The desktop had no suspend handling
and no open timeout, and the server read each such socket as the object going
deaf.

**Considered and rejected:** Holding one missed socket and deleting its row:
the next silent socket would then count alone, and a real wedge would never
reach the threshold. Storing the held mark in SQLite: a migration for a mark
whose only cost when lost is one repeated warn per wake. A client-only fix:
sleep can still land between the server's accept and the client's `open`, and a
suspend handler cannot run on a machine that has already gone to sleep. A
suspend flag only a resume clears: an aborted sleep can deliver no resume,
which would leave the socket down for the life of the process. Labelling the
suspend close from the power flag at its `close` event: a resume can land
before that event, so the socket closed for sleep is settled and reported at
suspend instead.

**Consequences:** A real wedge recovers one retry later, about a minute or two.
Two dead-on-arrival sockets on one live instance, with no socket heard from in
between, still reset, however far apart they are. The desktop's new telemetry
causes and fields reach an older API as properties its strict schema refuses,
so the API has to deploy before a desktop that sends them. Sideline and the
browser tab share the listen-only watcher, which has neither the open timeout
nor suspend handling yet.

### 2026-09-28 — The connect payload carries Spaces, and each Space is asked for its Channels

**What changed:** The connect payload carries Spaces and no Channel rows for a
desktop that asks, and the desktop walks the Spaces with `space_channels`
(above). The rail prefetch now asks only by name.

**Why:** The connect page was the viewer's 250 most recently opened Channels
across every Space. The sidebar shows one Space's Channels. A Space whose
Channels were all older than that page drew nothing until the sidebar paged the
global list, 250 rows at a time, until it had the Space's `channelCount` rows.
Rail prefetch only reached Channels whose rows were held. Asking by Space loads
the Space on screen first, whatever its Channels' age, and one walk loads every
Channel and its rail ahead of need.

**Considered and rejected:**
- *Keeping the 250 rows on connect beside the walk.* That is two paths for the
  same rows, and the one the sidebar needs is the Space's.
- *A `subscribe` field instead of a separate event.* `subscribe` is a strict
  schema, and a server one deploy behind would close the socket on the unknown
  key. It ignores an unknown event type.
- *Rows and rails as two walks.* One answer carries both. A rail that does not
  fit beside its rows is asked for by name, so frame packing needs no second
  page cursor.

**Consequences:**
- A `workstream_directory` invalidation re-reads only the Space on screen on
  each desktop, where it used to refetch the directory's pages.
- A reconnect walks every Space again, where it used to resend 250 rows. That
  is one request per 250 Channels, and it asks for rails only where none are
  held. After the Space on screen, every Space's first page is asked at once,
  so a reconnect costs about two round trips plus one per page beyond a
  Space's first, not one per Space. There is no cap on requests in flight: a
  burst of large answers delays other frames on the socket, and a cap would be
  a number for the team to set if that shows.
- The walk is the whole directory, so it bounds the conversation cache on disk
  the way a whole connect page did.
- The disk mirror still keeps 250 rows, so a cold launch paints those and the
  rest arrive with the walk.
- The `channel_rails` Space target and `list_workstreams` paging stay for older
  desktops, guests, and an Organization still opening.

### 2026-09-28 — Channel rails over the workspace socket

**What changed:** The workspace socket answers `channel_rails` with
`workspace_channel_rails` frames, and Channel rows carry `railWaterline`.

**Why, and what was rejected:** In
[`hosted-conversation-parents.md`](hosted-conversation-parents.md#changelog),
which owns the rail. Pushing whole rails on every change was rejected here: most
changes reach people not looking at that Channel, so only the waterline rides
the row and the client asks.

**Consequences:** A Space answer never names a Channel the viewer cannot see,
including in `nextAfter`. No new cap: the frame limit is the socket's, and 250
is the named-request limit. A client that ignores `railWaterline` never asks.

### 2026-09-26 — Provider webhooks tell their connections' audience

**What changed:** Provider webhook ingestion (GitHub, Linear, Notion) publishes
`connector_connections` and `resources` per workspace to the audience of the
connections the delivery matched: everyone when any of them there is the
Organization's, otherwise only the owners of the personal ones. `activity`
still goes to the whole Organization. Before, all three went to everyone.

**Why:** It was the one background path left out of the audience narrowing in
the entry below. A webhook for somebody's personal GitHub connection made every
window in the Organization refetch its connections and resources, which only
the owner can see change.

**Consequences:** The audience is the connections the delivery matched before
any connector filter, so a delivery a filter drops still tells those owners.
A new webhook publisher has to pass an audience the same way, or it tells
everyone.

### 2026-09-26 — A sync event names who it is for

**What changed:** `publishSync` takes an audience (people, or a connection
whose audience is its owner when personal and everyone otherwise), sends only
to it, and stores it in `workspace_sync_events.audience_json` (WorkspaceDO
migration 74) so replay after a reconnect reaches the same people. The mutation
map gives each write its audience: a digest, an onboarding journey, a telemetry
preference and an OAuth attempt are the writer's; a connection write is the
connection's, and no longer names `automations`. A `/connections` request's
own write is published once, by the middleware: the connection service's
duplicate publishes for request-path writes (disconnecting, installation
changes, key replacement, custom MCP tool policy, the Canva loopback) are gone,
and it publishes only OAuth completions and background discovery. A replay
answers at the log's newest waterline rather than the newest event it
unioned for that person.

**Why:** Every topic went to every socket. One person's digest edit, or their
personal connector's OAuth, tool policy or GitHub settings, made every window
in the Organization refetch its connections, resources, Sidekicks and digest.

**Considered and rejected:** Filtering only the live send: a client that was
away replays the unfiltered log and the narrowing is undone. Having each
connection route publish with the scope it had loaded, which adds an awaited
RPC to requests whose middleware publish is deferred; `WorkspaceDO` reads the
connection's scope from its own row instead. New per-person topics, which the
closed topic enum would make every older desktop reject. Keeping both the
middleware and the service publishing a request's connection write: each
such write reached every socket in its audience twice.

**Consequences:** A publisher of a per-person change has to pass its audience;
without one the event still goes to everyone, which costs refetches but hides
nothing, since an event names topics and never data. Connection-scoped events
are decided by the row as it stands at publish time: a connection deleted
before its publish is told to everyone. A new `/connections` route relies on
the mutation map (naming a created connection with `noteChangedConnection`)
and must not publish again from the service; a completion or background path
no request reaches is the only place the service publishes. See
[`websocket-architecture.md`](websocket-architecture.md) for the Channel-row
half of this change.

### 2026-09-24 — Membership changes reach the people who show them

**What changed:** WorkspaceDO sends `workspace_reach_changed` when a directory
projection flips someone's participation in a Channel or Breakout, and when an
operator's impersonation relationships change. It goes to that person's own
sockets and to operators with an active relationship to them, found in one
query per publish, and names people only. The desktop rereads guest navigation
on it. Sideline and the lite browser, which had no workspace socket, hold a
listen-only one through `watchWorkspaceReach`.

**Why:** Sideline's catalog reflected sign-in time, and a guest's sidebar on
either client learned of a new grant only on window focus: guests are sent no
Space snapshot, and the shared navigation is assembled on request with nothing
to push it.

**Considered and rejected:** Reusing `workstream_directory`, which is broadcast
to every socket on every mention and participant notification and says nothing
about Breakouts or represented people. A new `workspace_sync` topic, which the
closed topic enum would make every older desktop reject, including its
subscribe answer. Naming the conversation, which would disclose a membership
the receiver might not be able to list. Polling, which adds a timer number
nobody set and still lags.

The workspace socket ticket was member-only, so no guest client could open the
socket this event rides on; it now admits guests, whose socket WorkspaceDO
already withholds Space state from.

**Consequences:** The event is a nudge. It is not durable, so a listener
rereads on every subscribe answer, the first included, because its opening read
can finish before it subscribes. Listen-only sockets are still full subscribers
and are sent the sidebar they discard; a lighter subscribe mode for them is the
next change if that cost shows. Scope changes, new workspace-scoped Channels
and archives are not nudged.

### 2026-09-25 — The first-frame watch counts sockets their clients gave up on

**What changed:** WorkspaceDO records each accepted socket in
`workspace_socket_unheard` (migration 71) until its first frame, and the alarm
judges those rows rather than the open sockets. A row the object has heard
past, or one an earlier instance accepted for a socket now gone, is deleted as
answered. The log row gains `missed_closed_sockets`. The table is refused on the
generic SQL port, and the watch is off on an object held at schema 57.

**Why:** On 2026-09-24 two organizations wedged, each on the first instance
after a deploy's code-update reset. Forward Search sat stuck for 85 minutes
while its one member's desktop opened a socket pair about every two minutes and
was never heard; the watch fired only after they stopped retrying. The desktop
abandons a silent socket at 65 s, the runtime then drops it from
`getWebSockets()` without a close callback, and a watch that read only open
sockets never saw one reach the two-minute deadline. The earlier entry's
derivation, "two minutes is past that with margin", was backwards: the margin
is what hid the case the watch exists for. Judging open sockets also held the
alarm at `now + 1` for as long as one silent socket stayed open among active
ones, since its past deadline stayed a candidate.

**Considered and rejected:** A deadline under 65 s. It still ties the server to
a client timer, so a change to the heartbeat reopens the gap without anyone
noticing, and a late alarm can miss a socket dropped at 65 s anyway. Keeping the
ledger in memory: a hibernation wake loses it, the reason the earlier
review required stored evidence. Clearing the ledger and awaiting
`storage.sync()` before the abort, so the fresh instance would not reset over
the rows: the wedge's cause is unknown, and an await on a storage flush could
keep the one recovery path from reaching `state.abort()`. Deleting the row in
the close and error callbacks: the earlier-instance rule already covers a
healthy close followed by an eviction, without a write on those paths.

**Consequences:** One insert per accept and one delete per first frame. A
connection that drops before `subscribe` now counts after it closes, so the
lone-member reset described above can happen without a half-open socket. The
cause of the wedge is still unknown; that both 2026-09-24 wedges began at a
deploy is the lead to follow.

### 2026-09-24 — A WorkspaceDO that stops hearing its sockets resets itself

**What changed:** WorkspaceDO's alarm checks for sockets that have sent no
frame within two minutes while the object heard from no socket at all: no ping
answered, no later socket speaking, no socket callback. Finding any, it logs
`workspace_socket_first_frame_missed` and calls `state.abort()`. Accepting a
socket first lowers the alarm to that socket's deadline.

**Why:** the 2026-09-23 incident in "An instance that stops hearing its
sockets" above: nothing failed, so nothing alerted, and only a deploy cleared
it. The alarm is the one path still running in that state.

**Considered and rejected:** A client-side first-sync timeout only reconnects,
and every reconnect lands on the same stuck instance. Closing the silent sockets
before aborting was tried: the abort breaks the output gate first, so the close
frame never leaves, and the abort drops the sockets anyway. Resetting on a
silent socket alone was rejected in review: any member could hold one open and
reset the whole Organization every two minutes. Counting only sockets accepted
by the current instance was dropped in review too: an instance restarts on
every hibernation wake, so that rule disabled the watch for any object that
slept, and the abort already leaves nothing to inherit. For the same reason the
"heard from" evidence cannot be in-memory alone.

**Consequences:** The deadline is a team-set limit. The runtime cause is still
unknown, so an error-level `workspace_socket_first_frame_missed` is the signal
to watch; one that recurs means the reset is treating a symptom.

### 2026-09-17 — Ordinary pending-command replay follows socket generations

**What changed:** Each unresolved desktop command records the socket object it
was sent on. A later command on that same healthy connection skips older pending
entries; opening a replacement socket still sends every unresolved command with
its original operation ID.

**Why:** The pending map is both the private-receipt wait set and the reconnect
replay set. Treating every ordinary send as if it were a reconnect resent all
older unacknowledged commands, adding duplicate server admission and receipt
work to the healthy path.

**Considered and rejected:** Removing replay state after `send()` would make an
ambiguous disconnect lose read-your-write certainty. A second queue was also
unnecessary: socket identity is the exact generation fence the existing map
needed.

**Consequences:** Healthy sockets send one frame per ordinary submitted command.
A lost receipt causes safe replay on reconnect; application-foreground recovery
may also explicitly replay an unresolved operation on the same socket after a
suspended renderer resumes. Both paths preserve the original operation ID, so
server-side operation IDs and mutation idempotency remain required.

Shipped in [#815](https://github.com/juno-ai-labs/avalon/pull/815).

### 2026-09-08 — Make socket evolution independent of URL capabilities

An appearance query flag caused installed desktop validation to block the entire
control connection, hiding newly created children. Remove capability negotiation
from ticket issuance, upgrades, and hibernating attachments. All receivers ignore
unknown event types and additive fields through one receive-only parser; rejecting
an entire metadata snapshot because of a new field recreates the same failure.
Ticket URLs are query-free across workspace, control, conversation, and dictation.
The Azure upstream transcription intent is provider-owned and remains required.
Clients predating tolerant reception still require an update to understand an
expanded known frame; this change cannot retroactively change installed parsers.


### 2026-09-09 — One write for unversioned facts on both caches

**What changed:** Seven places wrote a rename, scope change, unread mark, or
read acknowledgement to the sidebar list and the open detail entry by hand, and
three of them disagreed about which fields the detail should take. They now
call `patchCachedWorkstream` in `workstreams-cache.ts`, which takes the fields
and the detail entry to address and writes the list row with it; the new
appearance receipt joined them rather than becoming an eighth copy. The detail
query key moved there from the feed hook so the cache module does not import
the hook that imports it.

**Why:** Adding one more hand-rolled copy would have left the header and the
sidebar one forgotten `setQueryData` away from disagreeing again. Every REST
response was narrowed to the fields that are its own news. A rename or scope
change carries the title, scope, and `updatedAt` it moved. A read
acknowledgement or unread mark carries only its viewer fields, through
`patchCachedWorkstreamViewerState` in `workstream-state-store.ts`, which also
rederives the unread pair; spreading the whole summary had written its common
fields (appearance, harness status, scope) through an unversioned path, where
a response computed before a later change and delivered after it puts the
older value back. A rename issued while a private child is open now writes the
parent's entry, which is the one the header renders, rather than the child's.
The harness status and attention advances were deliberately left on their own
writers, because they are substream-owned and a child's value must not reach
the parent's list row.

### 2026-09-08 — The room says how long its accept took, so the edge can say what it waited for

**What changed:** An accepted feed upgrade's 101 carries two internal headers
from the SubstreamAgent, its accept duration and its instance age. The edge
turns them into `rally.socket.room_accept_ms`,
`rally.socket.room_activation_ms`, and `rally.socket.room_instance_age_ms` on
the upgrade flow and strips both before the handshake is negotiated.

**Why:** Three opens of one work stream took 2.9–12.6 s with the edge's
`room_upgrade` step as the slowest and the room's own accept at 119–214 ms; the
rest was the platform activating a cold object before its constructor, which
no span in the room can see. [`performance-tracing.md`](performance-tracing.md#what-room_upgrade-contains)
owns the evidence and the attributes.

**Consequences:** The headers are object-to-Worker only. Admission is
unchanged: they are set after the ticket is consumed and carry no authority.

Shipped in #607.

### 2026-09-06 — Page older history from viewport position

**What changed:** The desktop reuses snapshot-fenced range requests for
position-based infinite scrolling, after initial viewport positioning completes.

**Why:** Short opening snapshots needed more history even without a scroll event.

**Considered and rejected:** Enlarging every opening snapshot to guess at rendered
height; the existing range transport can fetch only what the viewport needs.

**Consequences:** Range sizes and authorization remain unchanged. Covered
intervals must advance even when a page contains no visible rows; the client
reports non-advancing coverage as an error. Renderer behavior is owned by
[`transcript-scrolling.md`](transcript-scrolling.md).

Shipped through [PR #565](https://github.com/juno-ai-labs/avalon/pull/565).

### 2026-09-04 — Private child sockets admit on parent membership, wait for complete inherited context, and recover in place

**What changed:** WorkstreamDO authorizes non-main feed tickets against the
exact ready child and exact active member, returning that member's version. The
signed ticket and Worker-to-object header carry the version. SubstreamAgent
requires its versioned parent mirror before either prepared or direct socket
admission and rechecks the mirror on commands. The WorkstreamDO control snapshot
also pushes the viewer's complete ready-child directory.

The desktop treats an initial-context snapshot as part of the child's canonical
opening baseline. Chunked context must assemble and validate before sends
become ready. A close during assembly discards the partial value and reconnects
from sequence zero; malformed matching chunks request a fresh authoritative
snapshot.

Both main and child `resync_required` handling now rejects pending range work,
discards partial snapshot assembly, abandons the old connection generation,
resets the addressed resume cursor to zero, and installs the new admitted
socket's snapshot as the authoritative baseline. The opening screen's Retry
action starts a fresh bounded socket sequence without a REST reader.

**Why:** Parent-level readability does not imply sibling-child readability, and
a ticket minted before removal must stop working without waiting for expiry.

Resuming after the snapshot sequence while some context chunks were missing
could permanently skip the immutable seed, and a malformed completed assembly
previously remained full and ignored every retransmitted chunk.

Main's REST detour and child's socket reset were two recovery state machines
for the same SubstreamAgent authority. They could race independently ordered
cache writes and made a child's correct identity-preserving behavior an
exception.

**Considered and rejected:** A REST child-list fetch and child-local roster as
the admission authority. They add a second refresh state machine and cannot
fence a stale signed ticket against a later parent removal.

Keeping a previously cached seed while a newer snapshot's chunks arrive. That
would call the child ready against context the current authority had not
completed sending.

**Consequences:** Rolling clients treat an absent `privateChildren` field as an
empty list. New servers always send it. Non-main tickets with no positive
membership version fail closed before SubstreamAgent creates an identity.

Main conversations retain their existing readiness path. Child readiness now
requires detail, transcript, and either an explicitly empty context snapshot or
one fully validated inherited-context payload.

Snapshot failure is visible instead of hidden behind a second transport. Keep
sending disabled until the new baseline arrives, and preserve the
connection-generation and snapshot fences that reject late frames.

### 2026-09-04 — No feed ticket for an archived work stream

**What changed:** `ConversationService.socketTicket` refuses a `workstream`
parent that is archived with `404 conversation_not_found`, the same answer its
boot gives. An automation's conversation keeps taking tickets after its
archive, with `parentArchived` in the admission so the object seats a reader
and refuses writes.

**Why:** The work-stream object refuses every read of an archived room, boot
and snapshot included. A ticket for one opened a socket that logged
`substream_socket_snapshot_prepare_failed` and never sent a frame or a close,
so the client waited on nothing. Refusing at the ticket makes the archive
visible at the first request rather than as a silent socket.

### 2026-09-03 — One feed ticket for every conversation, named by its parent

**What changed:** The feed ticket is issued at
`GET /conversations/:parentId/substreams/:substreamId/socket` and presented at
`/socket/conversations/:parentId/:substreamId`, for a work stream's conversation
and an automation's alike. Its claims carry the parent kind (`pk`) beside the
parent id, and its admission carries `parent_archived`; the Worker forwards
both as `x-rally-parent-kind` and `x-rally-parent-archived`, and the
conversation object refuses writes on an archived parent's socket. The
automation ticket audience, `GET /automations/:id/agent/socket`, the
`/socket/automations/:id` upgrade, and the automation object's own socket room
are gone.

**Why:** The automation object no longer has a conversation of its own to
serve: its chat is a `SubstreamAgent` under it, exactly as a work stream's
feed is a `SubstreamAgent` under `WorkstreamDO`. One ticket shape for one kind
of object is fewer audiences to keep apart, and the parent kind on the ticket
is what lets the object check it was addressed under the parent it belongs to.
[`workstream-durable-object.md`](workstream-durable-object.md) carries the
design.

**Consequences:** The parent's decision is the read admission, carried down
once at issue; the conversation's participant row is still the write check.
A change that admits a socket from the participant row alone, or that stops
forwarding `parent_archived`, reopens writes into an archived parent's
conversations. The entries below that describe the automation room record what
was true when they shipped.

### 2026-09-03 — A durable command is acknowledged independently of its socket

**What changed:** Substream mutation handlers use the identity already admitted
on the hibernating socket, emit a named `workstream.room.substream_command` span,
and guard every private receipt send against a concurrently closed connection.
Elicitation and retry wake/publication work after the commit is best-effort;
failure is logged for alarm/outbox recovery while the client still receives the
truth about the durable write. The desktop retains a command across a send race
for reconnect replay and rejects all waiting commands if the bounded socket-open
sequence reaches its terminal state.

**Why:** A disconnect or wake-up failure after commit could previously escape
the handler or report failure for state which was already durable, causing the
renderer to retire the one replay key that could recover it.

**Considered and rejected:** A second per-command wall-clock timeout would race
the existing heartbeat/reconnect owner and require an ungrounded new limit.
Command liveness remains the socket lifecycle's responsibility.

**Consequences:** A lost receipt is a delivery miss, not a second mutation
outcome. Reconnect resends the same operation id, while terminal inability to
open rejects the queue instead of leaving promises pending forever.

Shipped in #541.

### 2026-09-02 — Child feed recovery stays inside the addressed SubstreamAgent

**What changed:** renderer detail, transcript, overlay, feed-source, and
snapshot-generation caches now include a non-main substream ID. A child's
`resync_required` reconnects that socket from sequence zero for a canonical
child snapshot; only main child `0` can use the work-stream REST recovery boot.
Reorder and stop receipts are committed with their mutations so reconnect
resends cannot act on newer child state.

**Why:** a work-stream ID identifies the parent, not one of its conversations.
Sharing its cache keys made child frames overwrite main-feed state, while a
parent REST recovery could never reconstruct the child's transcript. A private
receipt sent without durable mutation fencing also acknowledged an old command
after applying it to a newer queue or execution.

**Considered and rejected:** adding a child REST boot, because the owning socket
already supplies the canonical snapshot and another read path would duplicate
authority; and dropping ambiguous commands on disconnect, because the caller
would lose read-your-write certainty.

**What a future change has to respect:** feed identity is the full parent-plus-
child address. Child recovery remains on the child transport, and every
retriable mutation needs a durable fence at the transaction it changes.

### 2026-09-02 — The substream socket becomes the child command plane

**What changed:** one operation-ID protocol now carries message admission,
elicitation answer, pending-input reorder, stop, and retry directly to the
addressed SubstreamAgent. The desktop retains each command across reconnect and
the object returns a private correlated result. Retry reuses the operation ID
as its durable run receipt, making an ambiguous resend safe. The unused
WorkspaceDO `create_message` command is removed in the same hard cutover.

**Why:** the ticket has already selected and authorized the child authority.
Routing these same mutations through work-stream REST added an unnecessary
product-parent hop and would have coupled a future automation-owned substream to
work-stream routes.

**Considered and rejected:** dual REST/socket support because no deployed client
needs a compatibility window. Parent-owned participants, resources, metadata,
and archive remain outside this child protocol.

**What a future change has to respect:** every child command needs a durable
idempotency identity and a private receipt; canonical consequences still travel
as sequenced feed state.

### 2026-09-02 — A room-owned automation cannot block the whole sidebar snapshot

**What changed:** WorkspaceDO's top-level automation read now admits only
`personal` and `workspace` rows before applying its existing viewer rule. A real
workerd regression test projects a third, `workstream`-scoped automation owned
by the opening room and proves a fresh workspace subscription still receives
the complete sidebar with only the ordinary automation in its top-level list.

**Why:** The work-stream automation migration expanded
`automation_directory.scope`, but the older sidebar query selected every row
authored by the viewer. Once a viewer authored a room-owned automation, that
row reached `WorkspaceSidebarSchema`, whose top-level automation contract
correctly accepts only `personal` and `workspace`. The resulting `ZodError`
happened before `workspace_sync` was sent, leaving every sidebar section in its
loading state. A Worker deploy made the latent incompatibility visible by
restarting sockets and forcing a fresh subscription; the deployed change did
not itself alter the sidebar path.

**Considered and rejected:** filtering only on
`owning_workstream_id IS NULL`. The schema pairs that column with today's
`workstream` scope, but a positive allowlist makes the top-level wire contract
explicit and keeps a future scope expansion from entering this payload by
accident.

**Consequences:** Room-owned automations remain in the room rail and continue
to advance the automation-directory waterline, but never enter the top-level
summary array. A future top-level scope requires an intentional contract,
query, client, and regression-test change together.

### 2026-09-02 — Ticket transit prepares admission and the initial feed frame

**What changed:** Feed tickets now sign the authenticated role and current
authority generation beside their existing exact identity, cursor, expiry, and
one-time ticket ID. The main-feed ticket continuation asks SubstreamAgent to
recheck and prepare that exact admission and, for a non-speculative replay plan
without pending-input spill, assemble the viewer-specific initial snapshot.
Upgrade reuses the work only when every verified claim, current session expiry,
and the object's local generation match; otherwise it takes the regional
session/membership and snapshot path. Current maintenance authority remains an
upgrade-time check on both paths.

**Why:** Current local traces left roughly 168 ms in repeated room authority and
session/membership reads and roughly 242 ms in snapshot detail after the native
handshake had already completed. Ticket transit was warming only schema and
repositories, leaving those two waits serialized on the opening path.

**Considered and rejected:** Persisting prepared snapshots would turn a
short-lived latency optimization into another content store and require cleanup
semantics. Treating forwarded role headers as authority without a matching
signed ticket and request-scoped preparation would make them forgeable. Marking
the work stream opened during preparation was also rejected because a ticket
request that never upgrades must not settle unseen state.

**Consequences:** A successful preparation removes the session/membership join
and eligible snapshot detail assembly from room upgrade, while retaining the
current maintenance read. The room holds at most one prepared admission and one
completed snapshot; speculative tickets and pending-input spill stay
admission-only, and spill frames serialize one at a time during delivery. The
durable ticket receipt still enforces one use, actual acceptance still settles
unseen state, and revocation fences pending work. Eviction, mismatch, expiry,
local product mutation, sequence change, or preparation failure loses only the
optimization and falls back to the old path. `workstream_socket_ticket_warm_finished.preparation_outcome`,
`rally.socket.admission_source`, and `rally.snapshot.source` expose which path ran.

### 2026-09-02 — Ticket transit overlaps main-room wake and construction cannot drop phases

**What changed:** Issuing a main-feed ticket now schedules its recorded
SubstreamAgent's storage-ready `wake()` as best-effort request background work
and records the ticket ID, outcome, and duration. The Electron broker now gives
its phase callback to the socket factory before construction and briefly holds
any synchronous phase until renderer ownership is registered.

**Why:** Cold object initialization was paid only after the ticket request and
native handshake had completed, leaving that transit time unused. Review of the
full renderer/preload ordering showed the originally suspected renderer race
could not occur: the hook attaches synchronously and IPC cannot interrupt that
turn. The factory boundary was the actual fragile ordering because construction
preceded the broker's phase subscription, even though today's PAC resolution is
asynchronous.

**Considered and rejected:** Awaiting `wake()` before returning the ticket would
put initialization on the critical path and let an optimization fail a valid
ticket request. Warming arbitrary non-main UUIDs was rejected because those
children do not yet have a product creation path that records them in the parent
directory. Renderer-side buffering was removed because it modeled an impossible
event order and retained unused setup state on control sockets. Caching PAC
results was also rejected without phase evidence: proxy selection may depend on
the full URL and current network policy.

**Consequences:** A main-feed ticket performs one additional idempotent Durable
Object RPC. Ticket correctness and response latency do not depend on it; the
`workstream_socket_ticket_warm_finished` event makes success, failure, and
duration joinable to the upgrade by ticket ID, and the upgrade remains the
cold-start fallback. Non-main tickets do not materialize objects. New
packaged-client samples can distinguish direct PAC/DNS/TCP/TLS/edge time from
the truthful proxy aggregate without a main-process construction blind spot,
but historical missing fields retain an unknown cause.

### 2026-09-02 — A client no longer marks a work stream unread for the reader's own turn

**What changed:** `advanceWorkstreamAttention` takes the signed-in user, read
from `RallyApi.viewerUserId`, and applies the room's own author rule to a turn
the reader wrote: their read waterline moves to that message's attention
ordinal, as the write that stored it did in the room. It also stopped carrying
its own copy of the unread derivation and now calls `withDerivedUnread`, the one
the versioned state store already used. `youAreMentioned` moves with the
waterline it is derived from, under the newest-turn fence the invariants above
state. The room's other half of that rule — the manual mark clearing — is
deliberately *not* mirrored; the invariant above says why.

**Why:** the local advance ran a few hundred milliseconds ahead of the viewer
state the room publishes, and in that window it was wrong in the one way a
reader can see. Sending a message drew an **Unread messages** divider directly
above it and lit that work stream's own sidebar dot — for the person who had
just typed it. The read acknowledgement then cleared both, so the whole defect
was a flash, which is what made it read as a rendering glitch rather than as
state; it was state, and it was this function's.

**Considered and rejected:** suppressing the divider in the feed instead, on the
grounds that it is where the flash was seen. It would have left the sidebar dot
lighting for your own message and put a second, disagreeing copy of "who has
read this" in a component whose job is to render turns. Also rejected: waiting
for the room's viewer push and simply not advancing attention locally at all —
that gives up the responsiveness the local advance exists for, and it is a
coworker's message, not your own, that the divider is *for*. And, on review,
rejected a generation fence around the manual mark: a fence is machinery for
keeping a prediction that has no business being made, and not predicting is both
smaller and strictly safer.

**Consequences:** `WorkstreamSocketApi` now includes `viewerUserId`, so a test
double for the feed declares who is reading; passing `null` reproduces the old
behavior and is what an unauthenticated client does. The rule is the client's
mirror of a server rule, so a change to how the room treats an author's own
message has a second place to follow.

### 2026-09-01 — Cold feed opening fails visibly after three timed attempts

**What changed:** Initial work-stream feed opening now has three total timed
attempts: 10 seconds, 20 seconds, and 40 seconds. Each deadline includes the
ticket request through route-matching canonical detail and transcript state,
cancels pending ticket, REST resync, and broker transport work, and the third
timeout shows a terminal error. Cacheless retained readers subscribe from zero,
replay-only frames keep the deadline armed, and a canonical REST result already
in the caches at the deadline wins. The error's **Try again** action starts a
new bounded sequence.

**Why:** A ticket, PAC lookup, handshake, subscribe, or first snapshot could
stall without producing a close or error, leaving the product on “Opening work
stream…” indefinitely. The person explicitly chose these deadlines and two
retries so the failure becomes visible without mistaking a slow cold wake for
an immediate transport failure.

**Considered and rejected:** A single fixed deadline would give later cold-wake
attempts no additional room. Continuing silently after the third timeout would
preserve the indefinite-spinner failure under a different state. Applying the
same cap to a feed that has already populated caches would unnecessarily stop
background live-update recovery.

**Consequences:** Three stalled attempts consume at most 70 seconds of deadline
time, plus reconnect jitter, before presenting the error. Explicit failures and
pre-state closes do not consume that budget and may continue reconnecting; this
change bounds silence, not every wall-clock path to canonical state. Canonical
cache installation permanently removes the opening deadline for that retained
connection; an unrelated valid feed event does not. Closing during PAC
resolution must complete immediately so a timed attempt cannot leave a
main-process socket behind.

### 2026-09-01 — Hover warms the complete pair and upgrade bootstraps the feed

**What changed:** Deliberate row hover now retains a presence-free control/feed
pair. The feed cursor is signed into its ticket, admission is reused for the
initial snapshot, and a current server queues that snapshot during the upgrade.
The main-process broker reports direct-route handshake phases and a truthful
proxy aggregate.

**Why:** A warm metadata socket still left the feed's Worker forwarding, object
wake, authorization, and first frame on the click path. Those are the costs a
two-second total target cannot leave hidden behind a generic handshake bucket.

**Considered and rejected:** A second unsigned cursor header would let the
renderer change replay state after ticket issue. Publishing hover presence would
misstate attention. Splitting proxy internals at guessed callback boundaries
would make the diagnosis less reliable.

**Consequences:** Hover may wake and snapshot one additional SubstreamAgent, but
never publishes viewer presence or marks the row opened, and remains bounded to
one speculative row. Navigation promotes that retained attachment with a
one-way `mark_opened` frame. Bootstrap failure closes the already-accepted
server socket so reconnect cannot strand an orphan. Older client/server
combinations still use explicit subscribe. Revocation and attachment
serialization remain the lifetime boundary after admission.
### 2026-09-01 — The admitted room socket carries its own message commands

**What changed:** `create_message` and its private success/failure receipt moved
from the persistent WorkspaceDO socket to the retained SubstreamAgent socket.
The room attachment now persists the admitted role and analytics workspace
surrogate through hibernation; an attachment from before this protocol reconnects
with code 1012 before sending.

**Why:** The room socket already fixes the entire routing tuple and access
revocation closes it when that authority ends. Sending through the parent added
authorization and routing work without making the child transaction safer.

**Considered and rejected:** A fresh D1 session query per message would make an
admitted socket only half-authorized and retain the measured delay. Removing the
legacy parent handler in the same deploy would break released clients.

**Consequences:** The desktop keeps an unacknowledged command across ordinary
disconnects and resends the same client message identity. Private receipts do
not advance room sequence, and all other product mutations still return
`rest_required` on this socket.

### 2026-08-29 — Dictation admission becomes one question to WorkspaceDO

**What changed:** `WorkspaceDO.admitTranscriptionSession`,
`releaseTranscriptionSession`, and `renewTranscriptionSession` replace the four
statements `realtime-transcription-service.ts` used to send through the
workspace runtime facade. The SQL, the two-minute lease, and both concurrency
caps now live in `workspace-transcription-storage.ts`, beside the insert that
enforces them; the service keeps the socket proxy and maps a refusal to its
`ApiError`. A refusal travels as an outcome (`ticket_replayed`,
`concurrency_limit`) rather than a throw, because the status and sentence a
person reads are the service's to choose and a thrown RPC error arrives as a
bare message. `apps/api/test/realtime-transcription-admission.test.ts` is
deleted; its four properties are asserted against a real object in
`apps/api/test-workers/workspace-transcription-admission.test.ts`, and the proxy
suite counts admissions through a small double instead of a hand-built copy of
the object's schema.

**Why:** the facade routes each statement by the table names in it and sends
anything it does not recognise to the regional database — the defect that took
automation run work streams down. Beyond that routing risk, admission read as
one decision and was not: the sweep, the one-time ticket consumption and the
cap-checked insert were three round trips and three separate critical sections,
and the comment above them claimed the object serialized the sequence. Each
statement was individually atomic, so the caps did hold; what a reader could
not tell is which of the two they were getting. Inside the object it is one
`transactionSync`, and the reading is true.

**Considered and rejected:** passing the caps in the request. It keeps them
next to the product code that chose them, and it lets any caller admit itself
past them by sending a larger number — an authorization decision made by the
side being authorized. They are unchanged values, moved.

**What a future change has to respect:** the ticket stays consumed when
admission is refused for concurrency. It was spent on that attempt, and
returning it would turn one ticket into two admissions. Both tables stay named
in `WORKSPACE_LOCAL_TABLES` so an accidental generic statement reaches the
object rather than falling through to regional D1, and both are now also in
`WORKSPACE_TYPED_RPC_ONLY_TABLES`, so the object refuses such a statement by
name instead of executing it. The two lists do different jobs and a table needs
both: the first decides where a statement goes, the second decides whether it
is allowed to be generic at all.

### 2026-08-28 — A fifth audience admits the automation draft room

**What changed:** `automation_socket` joins the ticket audiences. The desktop
asks `GET /automations/:id/agent/socket`, presents the ticket through the same
`rally.ticket.v1` subprotocol, and upgrades at `/socket/automations/:id`.
`AutomationAgent` accepts through the hibernation API, consumes the ticket id in
its own `automation_socket_ticket_receipts`, re-reads the session and active
membership from D1, and admits only the automation's author. The issuer returns
a clean URL with no `?ticket=` — like the HyperSight issuer and unlike the four
legacy ones. Electron dials it through the same Node broker as the work-stream
pair, under a third route kind.

**Why:** Compiling an automation draft streams for tens of seconds and had no
durable channel: the previous design streamed a response body, so closing the
window lost the narration and a reconnect could not recover it. A room backed by
the object's own event log makes the stream resumable, and reuses an admission
protocol that is already the answer to "a browser cannot set a header on a
handshake".

**Considered and rejected:** Carrying compiler frames on the singleton workspace
socket, which would put one author's high-frequency model output on every
member's connection and give a draft the workspace room's audience. Reusing the
substream feed audience, which would have made a narrow single-author read
credential interchangeable with a work-stream feed credential — the exact thing
the separate-audiences invariant exists to prevent.

**Consequences:** Five product objects now accept hibernating sockets and five
consume a ticket id in their own SQL; a sixth has to do both, and has to join the
[access-revocation](access-revocation.md) walk, because the room admits on a
ticket and never re-authorizes. The automation room is author-only, so it is
narrower than the automation's own REST readership on purpose. A ticket that
somehow reaches the room for a non-author is not a shaped refusal — the room's
assertion throws — which is acceptable only because the issuing route refuses
that person before a ticket exists.

Shipped in the pull request for this change. Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md).

### 2026-08-28 — Feed transport carries only canonical turns and typed overlays

**What changed:** The feed socket's transport moved onto the persistent-loop
cutover's single display authority: snapshots and history reads carry only
canonical ordered turns, live noncanonical state is a typed overlay, and an
oversized turn stays a sequence-owning payload-free envelope. The facets
below are the decisions this change is made of — each carries its own
rejected alternative and its own invariant.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).

#### Oversized canonical turns stay sequence-owning, payload-free envelopes

**What changed:** SubstreamAgent now measures correlated `transcript_range`
frames in UTF-8 bytes against the shared 1,000,000-byte realtime-frame limit.
It removes only whole turns from the tail and reports the exact shorter
covered prefix; the desktop keeps the remaining suffix as a gap under the same
snapshot fence. When one indivisible turn cannot fit, the range instead
carries a payload-free envelope — `blocksOmitted: true` plus the true
`blockCount` — and the desktop renders a "too large to display" placeholder in
its canonical position.

**Why:** Range replies bypass room replay and were sent directly, so they also
bypassed the byte check applied to opening snapshots. A valid 20-sequence page
could exceed the broker's one-frame limit even though each turn was valid.

**Considered and rejected:** Chunking the ordered range frame itself, which
couples canonical sequence assembly to byte transport; marking an omitted turn
covered, which loses history; and delivering the oversized payload out of line
through manifest tables plus chunked, hash-verified byte-range hydration.
Nothing in the product can produce an indivisible oversized turn today, so
that transport would serve a row no code writes.

**Consequences:** Pagination may need another adjacent request for unusually
large groups of turns, but never claims omitted history as loaded and never
moves the shared room cursor. An envelope advances transcript coverage
immediately and keeps ordering independent of payload delivery; its content is
deliberately not delivered. `blocksOmitted` is the whole contract a future
delivery mechanism would build behind, if a producer of such turns ever
exists.

#### Canonical ranges and explicit overlays replace message pages

**What changed:** SubstreamAgent snapshots and correlated history reads now
carry only canonical ordered turns. `load_transcript_range` and
`transcript_range` exchange snapshot-fenced half-open sequence intervals. Live
noncanonical UI state crosses the protocol as a typed overlay with its own ID,
provenance, anchor, and revision; it is never inferred from a persisted message
page or appended by timestamp. Streaming frames carry `streamId` for transient
run grouping and `turnId` for the canonical model turn; checkpoints persist the
same distinction and run completion closes only the transient stream identity.
Activity-derived duration rows inherit the sequence of their canonical turn,
and an interrupted correlated range read is released immediately into the
existing reconnect-and-retry path.

**Why:** A persisted compatibility page, disjoint canonical ranges, and live
stream state gave the renderer three plausible orders and two identities for
the same assistant output. A page row outside loaded canonical coverage could
be mistaken for a newest transient and render below the actual tail.

**Considered and rejected:** Content/timestamp deduplication and a permanent
message-ID bridge. Both retain ambiguous authority and fail for repeated text,
clock skew, unloaded gaps, or legitimate same-content turns.

**Consequences:** Retired `load_message_page`, `message_page`, and
`message_created` feed frames are protocol errors. Old Electron builds are
deliberately incompatible. Ordering comes only from canonical sequence plus an
overlay's explicit anchor; derived activity rows cannot fall back to sequence
zero, and an unpositioned canonical row fails the composition invariant instead
of being silently invented at the beginning. Reconnect or pagination cannot
manufacture order. Correlated range promises never outlive the transport and
snapshot fence capable of answering them. The protocol rejects the former
ambiguous `messageId` streaming field.

### 2026-08-26 — Electron opens work-stream socket swarms outside Chromium's endpoint lock

**What changed:** Electron's WorkstreamDO control and SubstreamAgent feed
connections now use a main-process Node broker behind a WebSocket-compatible
renderer adapter. The pool proactively owns both sockets for the active work
stream, every pin, the five most recently active unpinned work streams, and any
additional running work stream. Initial ticket requests and broker dials start
independently; reconnects retain their existing jitter. The singleton
WorkspaceDO, HyperSight block, dictation, and browser-development sockets keep
their existing transport.

**Why:** Chromium serializes simultaneous WebSocket handshakes that resolve to
the same endpoint. A cold group therefore queued behind earlier handshakes even
though every target was a different Durable Object, defeating proactive
warming and making a later sidebar selection pay the queue. Node connections
do not share that Chromium gate.

**Considered and rejected:** Separate Chromium sessions would also create
independent endpoint locks, but each session carries its own browser storage,
cache, proxy, certificate, and lifecycle surface. Moving protocol and cache
ownership into main would duplicate the mature renderer state machines. The
broker therefore owns only raw transport and exposes the same event contract
back to those state machines.

**Consequences:** Main accepts this capability only from the primary Rally
window, validates a configured regional `ws`/`wss` origin, exact declared route
shape, clean URL, and ticket sentinel, and supplies `app://rallywithai` itself.
Ticket values never enter logs. Reloading or destroying the renderer terminates
all of its broker sockets. A new per-work-stream socket kind must update the
typed IPC schemas and the route-kind validator rather than accepting an
arbitrary URL. The renderer must retain one multiplexed bridge subscription;
adding one preload listener per socket makes every frame scale with the swarm.

Shipped in #341.

### 2026-08-26 — Workspace presence describes foreground attention, not socket warmth

**What changed:** The WorkspaceDO protocol now accepts explicit application and
foreground-work-stream state plus a socket-local revision after subscription and returns viewer-scoped
presence snapshots. The desktop derives the state from Electron application
focus, renderer focus/visibility, and the selected route. Presence lives in
hibernation attachments and is recomputed from `getWebSockets()` on focus,
directory-visibility, or connection changes; the face pile animates only other
present users and discards snapshots when their route or socket stops being current.

**Why:** Recently viewed work-stream metadata/feed pairs stay mounted for fast
switching, so their open/close lifecycle cannot say where a person currently is.
Application focus alone is also insufficient when a Settings window covers the
workspace renderer.

**Considered and rejected:** A feed subscribe/close signal would conflate the
pool with attention. An in-memory room map would disappear on hibernation. A
durable row with a TTL would require storage writes, alarms, and an invented
expiry duration for state already bounded by the socket lifecycle.

**Consequences:** Clients wait for the workspace sync response before sending
presence, avoiding interleaving with asynchronous subscription admission, and
revision every command so asynchronous session authorization cannot reorder it.
Attachments from the previous deployment resume as background. Presence frames
remain ephemeral, authorized, recipient-specific, and outside the workspace
waterline/replay log. Presence has no REST fallback.

### 2026-08-26 — Substream sockets carry snapshot-fenced transcript ranges

**What changed:** Feed snapshots now carry the ordered transcript fence, two
opening ranges, active turns, and nested activity baselines. Correlated range
requests fill explicit gaps over the same socket and snapshot. The socket's
hibernation attachment owns that reader fence, and each range result carries the
bounded activity rows referenced by its turns.

**Why:** Cursor pages could not distinguish missing history from an empty page
or retain a disjoint unread island and live tail. Reconnect also needed an
authoritative elapsed baseline without streaming clock ticks.

**Considered and rejected:** A REST request per gap, a fresh participant
authorization per row, an append-only table of every open, and a guessed
snapshot TTL. The SubstreamAgent already owns the admitted socket, its durable
attachment, and the transcript SQL.

**Consequences:** Clients must retain `snapshotId`, coverage, and event fence
together. A range reply does not advance the room event sequence and cannot be
interpreted as realtime catch-up.

### 2026-08-26 — Route handoff cannot paint a retained work stream under the next URL

**What changed:** The main Electron workspace router now commits its small local
route tree synchronously instead of wrapping hash-history updates in a React
transition. The reused work-stream route then verifies that both the detail
payload and every transcript row belong to the work-stream id in the current URL
before rendering them or running payload-dependent effects. During a socket-pool
handoff it keeps the opening surface up until both keyed query observers have
moved to that id. The pool's route-selected owner also enables its feed directly,
instead of waiting for the descendant screen to admit it in a later layout effect.

**Why:** The keyed socket pool correctly retained each work stream's own
connection and cache, but the visible `WorkstreamScreen` intentionally remained
mounted while its route parameter changed. React Router could move the URL and
active sidebar row while its concurrent route render left the prior screen on
the page; after that render began, the detail and transcript observers could
also publish their new keyed results in separate phases. Together those gaps
briefly painted the previous work stream under the newly selected sidebar row.
After the socket-first opening change landed on the base branch, live rebase QA
also showed a cold destination remaining on the opening surface because its
owner never received the descendant admission update.

**Considered and rejected:** Closing the previous sockets would remove the
five-minute back-navigation benefit without making the visible route update
atomic. Keying and remounting the whole screen would also discard unrelated
screen-local state on every switch. Trying to flush individual `navigate` calls
does not override a declarative `HashRouter` whose history listener itself uses
`startTransition`. The synchronous policy is therefore scoped to the main
workspace router; the standalone Settings and Meeting windows keep their
defaults. The identity fence is the next narrow boundary: retained connections
stay live and their caches stay warm, while only data for the selected id may
paint. Waiting for descendant admission was also rejected: the active route is
already the product-level selection signal, and making its owner wait adds an
ordering dependency between sibling pool owners and the route subtree.

**Consequences:** A handoff can show the existing Opening work stream surface
for an intermediate render, but it cannot flash another work stream's header or
transcript. Every future payload rendered by, or allowed to drive effects in,
this reused route must participate in the same route-identity fence. An active
owner opens its feed even before a descendant consumes the pooled connection;
background and retained owners keep their existing admission rules.

### 2026-08-26 — Canonical snapshots fence recovery and revocation clears the reader

**What changed:** Every accepted SubstreamAgent snapshot advances a renderer
generation. REST recovery captures that generation and, after each await,
keeps the socket-written detail, transcript, cursors, and lineage if the
generation advanced. Recovery windows are consumed once and cleared by every
new snapshot. A reopened screen whose retained socket outlived its base caches,
and mutation paths that need repair, request one canonical frame from that
socket. Either room's access-revoked close evicts all per-work-stream reader,
context, HyperSight, and recovery cache families through one shared boundary.

**Why:** Retry deliberately overlaps the reconnecting feed socket. Without a
fence, a late HTTP answer could replace a newer canonical snapshot that had
already repaired the screen; retaining its window could replace that snapshot
again during a later repair. Query caches can also expire while a background
socket remains connected, and invalidation cannot refetch a deliberately
disabled REST reader. The two sockets can observe revocation at different
times, so partial cleanup could leave content from the other room in memory
after either room said the reader was no longer authorized.

**Considered and rejected:** Cancelling HTTP requests alone still trusts every
transport and test double to honor abort after it has returned data. Letting
each socket maintain its own eviction list preserves two security boundaries
that drift whenever a new work-stream cache family is added.

**Consequences:** A socket snapshot remains authoritative even when it races a
manual REST retry. REST remains the explicit unavailable-state reader; ordinary
repair and a cache-empty retained connection use `request_snapshot`. New
per-work-stream cache families that can contain reader state must be added to
`evictCachedWorkstream`, and either 1008 close path must continue to call that
shared boundary.

### 2026-08-25 — Selection immediately admits the feed

**What changed:** The selected work stream admits its pooled SubstreamAgent
feed immediately, before any detail or transcript query succeeds. Its first
snapshot fills both renderer caches and makes the feed/composer surface usable.
The WorkstreamDO control socket starts independently; the feed does not await
its viewer preference. Hover remains control-only.

**Why:** The former gate waited for a REST boot from SubstreamAgent before
opening a socket to the same SubstreamAgent for another boot. That serialized
duplicate authority work on every cold navigation and put the two-second P90
goal behind two complete network paths.

**Considered and rejected:** Parallel REST and socket boots retain duplicate
snapshot assembly and an ambiguous canonical winner. Hover feed warm-up would
publish presence without an open. Making HyperSight preference part of the feed
snapshot would add a cross-object call to the critical path.

**Consequences:** Presence begins at selection, which is the user action it now
represents. After the first ticket or handshake failure, the reconnecting state
exposes Retry for the REST recovery twin while the socket continues reconnecting;
offline and access-revoked states expose the same manual path. Ordinary navigation
does not read REST. Retained sockets and access-revocation behavior are unchanged.

### 2026-08-25 — Every work-stream socket attempt names why it started and the pooled lease that served it

**What changed:** WorkstreamDO-control and SubstreamAgent-feed loops emit
`workstream_socket_started` immediately before every ticket request. Initial
attempts distinguish hover warmup, active work stream, background work stream,
and retained work stream; every later attempt is `reconnect`. The event's
operation ID is reused as the ticket request's `x-request-id`.

Every mounted work-stream socket owner also receives one UUIDv7 lease ID. Its
WorkstreamDO control and SubstreamAgent feed starts share that ID across
reconnects until the owner leaves the pool. Each start keeps a separate
operation ID for its own ticket request and records a pending sidebar-opening
ID when it has one. The click lifecycle records the serving lease, including a
lease created by hover before the click. The lease adds pooled-lifetime and
opening-parent lineage without changing the request correlation above.

**Why:** Connected/drop telemetry omits attempts that fail before a handshake,
and pool call sites cannot see internal reconnects. With hover warming and
five-minute retained pairs, counting only route opens also confuses “no socket
needed” with “a socket start was missed.” The connection loop is the only
boundary every reason crosses.

A work-stream ID groups every historical connection and a socket request ID
identifies only one dial. Neither says which retained control/feed pair served
a specific opening. A click-parent ID alone also cannot connect a pre-click
hover warmup to the later opening that consumed it.

**Considered and rejected:** Emitting from the pool would miss direct hooks and
reconnects. Emitting on `WebSocket` construction would miss ticket failures.
Calling a hover-warmed control socket a feed start would misstate the presence
boundary: hover still never starts the SubstreamAgent feed.

Reusing the click operation ID for ticket requests would make multiple distinct
requests indistinguishable. Minting a new lease on every reconnect would reduce
the lease to another attempt ID. Assigning a click retroactively to the
hover-start event would rewrite causality rather than representing the pooled
lifetime.

**Consequences:** Start counts are attempt counts and may exceed successful
connections. Each start can join its regional ticket request, while the
existing `realtime_socket_state` event remains the source for connected,
retrying, and stopped outcomes.

A lease is renderer-local correlation, not authorization or a server socket
identity. It ends when the keyed pool owner unmounts; reconnects within that
lifetime retain it. Direct non-pooled hooks generate the same shape for test
and embedding compatibility. Both events and the lease ID are content-free
Product analytics that honor opt-out and follow the existing regional and
consent boundary.

### 2026-08-25 — A deliberate sidebar hover warms the work-stream control socket

**What changed:** Holding the pointer over a sidebar work-stream row for one
second opens its pooled WorkstreamDO metadata socket. A shorter hover opens
nothing. The SubstreamAgent feed is added when the work stream is selected; the
already-warm control socket is reused.

**Why:** The five-minute pool removed the repeat cost when switching back to a
work stream, but the first switch to a listed work stream still waited for its
ticket requests, handshakes, subscriptions, and snapshots after the click. A
one-second dwell is the requested signal that the row may be opened soon and
gives the presence-free half of that work a head start without making pointer
travel through the sidebar open connections.

**Considered and rejected:** Warming immediately on pointer entry would turn
ordinary cursor movement into network work. Opening every listed work stream
would make the whole sidebar live and abandon the pool's time-bounded scope.
Warming the SubstreamAgent feed would publish the hovering user to other members
as “Viewing now” even though they never opened the work stream. Closing the
control socket on pointer leave would throw away the warm-up during the click
and route transition that it exists to accelerate.

**Consequences:** At most one warmed-but-unopened work stream can keep one
hibernatable control socket for up to five minutes; another qualifying hover
replaces it. Warm-only state does not subscribe to the feed, publish presence,
or invalidate the sidebar from a feed snapshot. The pool's stable action context
also keeps socket connection-state churn from re-rendering every sidebar row.
Access revocation still closes the socket immediately. The one-second threshold
is the product promise and must remain literal in its test.

### 2026-08-25 — Recently viewed work-stream sockets survive navigation for five minutes

**What changed:** Electron owns WorkstreamDO metadata and SubstreamAgent feed
sockets in a keyed pool above the active route. A work stream that leaves the
foreground keeps its exact socket pair for at least five minutes; returning
within that window reuses the connections, and a running work stream remains
connected without an expiry. A newly opened route enters that pool only after
its initial detail and transcript reads succeed; once admitted, the keyed entry
stays admitted while it is active, recent, or running. Only the socket owners
are keyed: the route subtree stays at a fixed position and continues to
reconcile the same `WorkstreamScreen` instance in place when its ID changes.

**Why:** Route ownership closed both sockets immediately even though the person
was likely to switch back. Reopening paid for two ticket requests, two
handshakes, two subscriptions, and two snapshots before realtime state was
current again, while Cloudflare can hibernate the idle connections at no object
duration cost.

**Considered and rejected:** Keeping only the React Query cache still requires
fresh subscriptions before it is safe to trust; opening sockets for every work
stream in the directory would retain connections unrelated to recent use. A
five-minute recent set preserves the likely back-navigation path without making
the whole sidebar live. The recent set deliberately has no separate count cap:
the team-set promise applies to every work stream left during that window, and
an LRU cap would silently shorten it for fast navigation.

**Consequences:** Feed and metadata sockets share the same retention lifetime,
but HyperSight block sockets still follow panel visibility. Access revocation
still closes retained sockets immediately. Future route refactors must keep the
pool keyed by work-stream id and preserve the initial-read admission signal or
they will turn retention into either close-and-redial or rejected-route retry
loops. Expiry re-arms if the wall clock moves backward before a timer fires.
The live recent count is therefore time-bounded rather than count-bounded; any
future cap needs an explicit team-owned number and a corresponding promise
change.

Shipped in #305.

### 2026-08-25 — A lost replay cache no longer discards a healthy socket

**What changed:** Resume subscriptions now receive canonical state on the same
SubstreamAgent connection when hibernation lost the in-memory replay window.
`resync_required` is reserved for `sequence_ahead` and the last-resort
`history_unavailable` fallback when a canonical snapshot cannot be delivered
without reopening the subscribe race.

**Why:** Cloudflare restores hibernating sockets and their attachments, not the
object instance's replay array. Closing the restored socket for that normal
condition could generate presence changes on subscribe and close, advance the
durable cursor, and repeat the miss after the next activation.

**Considered and rejected:** Persisting the replay cache pays durable writes for
an optimization; removing presence changes only narrows the trigger. The
existing canonical snapshot and catch-up boundary repairs all replay-event
classes without a new client message.

**Consequences:** The connection remains usable after an ordinary repair. A
failed or overflowed repair retains the old cursor and takes explicit REST
recovery, as does an impossible client-ahead cursor.

### 2026-08-25 — The ticket sentinel is rally.ticket.v1, and the offered one is echoed

**What changed:** `SOCKET_TICKET_SUBPROTOCOL` is `rally.ticket.v1`.
`avalon.ticket.v1` is listed in `SUPERSEDED_SOCKET_TICKET_SUBPROTOCOLS` and
still accepted, and `withNegotiatedSubprotocol` now echoes back whichever
sentinel the client offered rather than always the canonical one.

**Why:** The Avalon-to-Rally rename reached the sentinel, and accepting the
superseded spelling inbound is not sufficient on its own: Chromium fails a
handshake whose response selects a subprotocol the client never offered, so a
build installed before the rename would have been refused at the 101 even
though its ticket verified. Echoing the offered sentinel is what makes
acceptance real. Rejected: renaming outright and letting old builds fall back to
the deprecated query parameter — that puts the credential back in the URL, which
is the one thing this whole scheme exists to prevent. A future change that
renames another negotiated wire identifier has to respect the same asymmetry:
the reader may accept many spellings, but the response must return the one it
was given.

### 2026-08-24 — Product feature flags reconcile privately on subscribe and push

**What changed:** WorkspaceDO now evaluates the full client feature-flag
contract per viewer on every subscribe and after each key-only product-flag RPC.
The subscribe answer carries the values privately; later
`workspace_feature_flags` events go only to sockets for the evaluated user.

**Why:** A shared workspace broadcast cannot represent targeted answers for two
different members, and a live-only push leaves a disconnected client stale.
Putting current values on subscribe makes reconnect the reconciliation path
without adding another socket or a permanent renderer poll.

**Considered and rejected:** Carrying the new value in the Queue/RPC would make
one audience's answer authoritative for everybody. Adding feature flags to the
workspace waterline would persist and replay user-specific state through a
workspace-wide log.

**Consequences:** Feature flags are processed before the workspace waterline
guard, the live event always replaces the complete flag object, and any future
per-user socket state must stay off the common broadcast path.

### 2026-08-24 — Workspace socket closes stop impersonating access revocation

**What changed:** WorkspaceDO now closes malformed JSON/schema frames with
`4400`, inactive sessions with `4401`, and reserves the released `1008` contract
for an actual access revocation. Every server-initiated protocol/session close
emits a payload-free `workspace_socket_closed` diagnostic. Electron stops
resending terminal failures and maps the three codes to separate access,
sign-in, and invalid-command errors.

**Why:** Production treated every `1008` as “You can no longer access this
workspace,” even though WorkspaceDO also used it when a client frame failed
validation or an already-open socket's session became inactive. The UI could
therefore state a permission decision that never happened, while the server log
did not retain enough context to identify the actual path.

**Considered and rejected:** Parsing close-reason prose on the client leaves
behavior coupled to copy and does not help structured production queries.
Continuing to reconnect malformed commands resends the same rejected bytes
forever. Changing the established access-revocation code would make a mixed
desktop/API rollout fail open against older servers, so `1008` remains reserved
and only the overloaded conditions move to application codes.

**Consequences:** New workspace-socket terminal causes need a distinct shared
code and a desktop mapping. Diagnostics may add bounded fixed fields, paths, or
codes, but never raw frames or rejected values.

### 2026-08-22 — An admitted socket is never re-authorized, only closed

**What changed:** Block sockets no longer cache an authorization decision for 60
seconds and re-check it, and no socket role revalidates a listener on a timer.
Admission still decides authorization fresh on every connect, and an inbound
command or page request on an open socket still revalidates before it is served.
What changed is the *listening* side: a socket holds until the
[access-revocation queue](access-revocation.md) tells its object to close it.

**Why:** The bounded caches were each an object rediscovering, up to a minute
late, something D1 already knew at the moment it was written. They cost a query
on a publish path to answer a question that is almost always "still fine", and
the WorkspaceDO version of the same idea shipped an ordering bug that silently
dropped invalidations. Publishing the retraction from the request that wrote it
reaches the socket in about a second and costs nothing when nothing changed.

**Considered and rejected:** Shortening the caches. That multiplies the cost of
the expensive half without removing the window, and leaves two mechanisms where
the whole point was to have one.

**Consequences:** A socket role added later owes a `revokeSocketAccess`, and its
parent owes it a place in the child list that parent returns; without both, its
sockets survive every revocation. Losing participation or visibility on a single
work stream no longer closes anything until reconnect — those are object-local
facts the D1-fed queue cannot see.

Shipped in #229. Owned by [`access-revocation.md`](access-revocation.md).

### 2026-08-22 — Three review findings on the sidebar payload and its push

**What changed:** Three defects the automated review on #232 found, all in code
that PR introduced. `activateWorkstreamRoute` now reads `archived_at` through
`workstreamExecutionEnvironment`, not `workspaceDatabase`. `publishSidebarList`
awaits `revalidateBeforePublish(false)` before it sends, which made
`runWorkspaceSql` async. And the connect payload no longer suppresses the
`workstream_directory` invalidation unconditionally — only when page one
accounts for every row already resident.

**Why:** Each was a case of a new path skipping a bound the paths beside it
hold. `workstreams` is not a workspace-local table, so the workspace facade
sends its statements to regional D1, where migration 0090 dropped `archived_at`
— the gate would have failed with `no such column` after reserving the address,
on every automation run and Slack work-stream create. The push carries a
viewer's whole automation or note list, which is exactly the payload
`publishWorkstreamState` sweeps for, so a revoked session kept receiving product
rows until an unrelated publication happened to sweep. And the directory
refetch, skipped to save a round trip, was the only thing retiring a work stream
archived while the socket was away: page one merges rather than replaces, so the
tombstone survived.

A payload with no `nextCursor` needs no refetch at all: it is the whole
directory rather than page one, so a resident row missing from it has only one
reading and is dropped outright. The ledger the pushed lists are ordered by is
also pinned against garbage collection — nothing observes it, so React Query
would have collected it after five idle minutes and reset the guard to -1,
leaving the lists looking right while the total order they depend on quietly
stopped holding.

**Considered and rejected:** Reproducing the server's `last_activity_at DESC,
workstream_id` ordering on the client to decide whether an unaccounted-for row
belongs to a later page — it duplicates the cursor arithmetic in a second place
that can drift from it, to save a request that only a reader who has scrolled,
on a reconnect, will pay. Letting the client ask instead keeps one authority for
the ordering. Also rejected: keeping the waterlines in a module-level `Map`
instead of pinning the cache entry, which leaks state between workspaces and
between tests. A future change must not restore the unconditional skip: a cold
connect has nothing resident and still pays nothing, which is the case the
payload exists for.

### 2026-08-21 — Subscribing is answered with the sidebar

**What changed:** The `workspace_sync` event that answers `subscribe` carries a
`sidebar` field — the first directory page, the automations and the notes, each
waterlined. `list_sidebar` and `workspace_sidebar_page` are gone; nothing
requests the sidebar's first screen any more. Every subscribe carries it,
including a resume where no topic moved, which is the new `reason: "resume"`
with an empty topic list. The desktop no longer fetches page one at all.

**Why:** [`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) asks the
connect exchange to deliver what the opened surface paints, and forbids a
subscribe frame that names a collection, a filter or a page size.
`list_sidebar` named two of the three. It had removed two REST reads, which was
worth having, but it left the round trip in place and it was a new instance of a
pattern that document marks as behaviour to replace.

**Considered and rejected:** A separate unprompted `workspace_sidebar` frame,
which was built first and works — but it makes the connect exchange two frames
where one will do, and a resume with nothing to report has no sync event to sit
beside. Keeping `list_sidebar` as a debug-only request was also rejected once it
was clear `includeSystem` filters only work streams: `list_workstreams` already
takes that flag, so the debug re-draw needs no command of its own.

**Consequences:** A subscribe now costs a directory read plus two list reads on
the object, per socket, including on every reconnect — where it previously cost
an invalidation the client answered with its own requests, so the round trips
went down and the object's work went up. The sidebar must be applied before the
topic-waterline guard, since a quiet resume repeats a waterline the client
already holds. System work streams are the one thing the payload does not
serve; that preference lives in the desktop, and a debug viewer asks for the
wider directory itself.

### 2026-08-21 — The two sidebar lists are pushed, not invalidated

**What changed:** WorkspaceDO re-sends the automations or the notes whole, per
viewer, as `workspace_sidebar_list` whenever it writes one of their rows,
detected at the `executeRuntimeSql` choke point every write passes through.
Neither list has a REST fetcher on the desktop any more: the opening batch
seeds them, the push refreshes them, and every first page is a batch so a
reconnect or debug toggle re-seeds all three. The `automations` and `notes`
topics keep only the detail surfaces REST still serves.

**Why:** Those topics were derived from the method and path of a mutating REST
request, so the socket's correctness depended on the REST surface existing —
and any writer without a request was invisible to it. The workspace alarm
updating `last_run_at`/`next_run_at` after a scheduled run is exactly that
case: the sidebar's next-run time stayed stale until an unrelated automation
write or an app restart. Pushing from the write itself fixes the staleness and
removes the inverted dependency at once.

**Considered and rejected:** Keeping invalidation and adding a publish call at
every service that writes these tables — many call sites, each able to forget,
and the alarm's writes do not pass any of them; per-row waterlines and tombstones
mirroring the work-stream row — the list is the unit here and a removed row is
expressed by its absence; and diffing the list to push only changed rows, which
buys nothing at 250 summaries and adds a way to be wrong. Shipping with *no*
version at all was also rejected, after the fact: the first cut argued that one
authority on one thread over an ordered transport made the last send provably
newest, which was true of the code as written and is still not enough. Two
producers write these cache entries — the batch and the push — and
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md) asks every pushed
payload to carry its authority's ordering so that the guard survives a third.

**Consequences:** A user action that writes the table more than once sends the
list more than once — resuming an automation writes the subscription and then
its email route, and a real window shows two identical `workspace_sidebar_list`
frames. Each carries the same whole list, so the extra one is idempotent, and
deduplicating across separate RPC calls would mean debouncing a push nobody has
measured a cost for. Invalidating `['automations']` or `['notes']` on the desktop
now does nothing, by design — the socket is the sole writer, and the shell
reads them through `useSocketOwnedList`, whose fetcher throws rather than
returning an empty list if anything ever enables it. A new writer of these
tables gets the push for free as long as it goes through the workspace runtime
database; one that reaches the tables another way would not, and there is no
such writer today. `AutomationService.list` keeps its email-route
reconciliation and keeps a caller: the pause/resume path defers a failed Global
transition to it by name, so the desktop retains one deliberate repair query
that feeds nothing the sidebar renders.

### 2026-08-21 — The sidebar opens on one answer instead of three

**What changed:** A `list_sidebar` command and its `workspace_sidebar_page`
reply. WorkspaceDO answers the cold sidebar read with the first directory page,
the viewer's automations and the viewer's notes together, from three local
SQLite reads with no `await` between them. Electron sends it in place of the
first `list_workstreams`, seeds all three caches before the query resolves, and
holds the REST `automations`/`notes` queries disabled until it settles. The
statement and row mapping for each list are shared with the REST services in
`sidebar-reads.ts`.

**Why:** The three lists have one authority and had three transports. Work
streams came down this socket while automations and notes each cost a Worker
round trip that turned straight back into RPC to this same object — so opening
the sidebar paid for three sequential arrivals of data one object could have
answered at once, and filled in three visible stages.

**Considered and rejected:** Leaving the two on REST and only reordering their
fetches, which does not remove a round trip; moving them onto their own socket
commands, which is three correlated requests instead of one and still fills the
sidebar in stages; and making the batch the refresh path too, which would let a
directory invalidation overwrite an automations list a REST refresh had just
written.

**Consequences:** The workspace protocol now carries a second correlated
directory shape, and a caller must match a reply's kind to the request that
asked for it — resolving a batch into a page's shape would hand an array where
an object is unpacked. The automation email route in the batch is whatever is
stored, since reconciling it is a Global-registry call that cannot run on the
object's socket thread; the REST refresh remains the only path that reconciles.
Both lists are bounded at 250 and truncate rather than reject. A future list
that belongs to the sidebar should join this batch rather than add a transport.

### 2026-08-21 — A subscribed viewer can ask the room to re-send canonical state

**What changed:** `ClientSocketEventSchema` gained `request_snapshot`, a
cursorless frame that a subscribed SubstreamAgent socket may send to have the
room re-serve the sequenced `snapshot` it would send an initial subscriber. The
agent refuses it on an unsubscribed socket and otherwise runs the existing
subscribe path at sequence zero.

**Why:** The desktop was reconciling canonical state over REST, which meant the
one thing this module exists to admit a reader to — the room that holds the
state — was not the thing being asked. The full reasoning, including the loop
that prompted it, is in [`architecture.md`](architecture.md); recorded here
because the client frame set is part of this module's contract.

**Considered and rejected:** *A correlated direct reply* alongside
`message_page`. Those are viewer-specific answers to viewer-specific questions
and deliberately carry no room sequence; canonical state is neither, and an
unordered answer would have to be compared against the feed by hand. *Reusing
`subscribe` with `afterSequence: 0`*, which reaches the same code with no
contract change but reads as a join on an already-joined socket and resets the
resume cursor as a side effect.

**Consequences:** This is the second client frame that is not a mutation, and
the first that is answered with a broadcast-shaped event. Anything that makes
`snapshot` unsequenced, or gives `request_snapshot` a cursor, removes the
property that makes the reply safe to send without correlation.

### 2026-08-20 — The feed ticket's id is returned, and joins the traces of a socket open

**What changed:** `GET /workstreams/:id/socket` and
`GET /workstreams/:id/substreams/:substreamId/socket` return `ticketId`, the
ticket's `jti`, alongside the ticket. `WorkstreamService.socketTicket` now mints
that id and hands it to `issueSocketTicket` rather than letting the issuer
generate one. The issuing route, the edge upgrade, and the room all record it as
the `rally.socket.ticket_id` span attribute.

**Why:** Opening a work stream was reported slow with no way to say which part
was slow, and the socket half was the invisible half. A WebSocket upgrade is a
separate invocation that Cloudflare's automatic tracing traces on its own, and a
browser can attach no header to a handshake — so nothing tied a room taking two
seconds to assemble a snapshot back to the client that asked for the ticket a
moment earlier. The `jti` was already the one value the issuing route, the edge,
and the room all hold — the room consumes it — so it needed to be returned
rather than invented.

**Considered and rejected:** *Putting a trace id in the handshake.* The ticket
subprotocol offer is the one thing a browser lets a client set on a handshake,
and it is spent on the credential; adding a second protocol element would change
the negotiation this document's whole design is built around. *Using the ticket
id as the trace id on the far side* — it is a UUID, and a UUID without its dashes
is a valid W3C trace id. This was built and removed: the platform owns trace
identity, and a hand-made id forks the trace graph so that the room's spans stop
appearing under the calls that produced them. It is a correlation attribute
instead. *Correlating by timestamp and workspace.* It fails exactly when it is
needed — several sockets open at once during a reconnect storm. *Returning the
whole ticket to the client for correlation.* It already has the ticket; the point
was to record an identifier without recording a credential, which is why
`ticketId` is recorded and the ticket never is.

**Consequences:** Anything that changes how a ticket id is produced must keep
the value the route records identical to the one the room reports consuming, or
the socket seam of `workstream_open` silently stops joining — nothing fails, the
traces just no longer meet. `ticketId` is now part of the two feed routes'
response contract and the desktop's `SocketTicket`; it is optional on the client
so a Worker that predates it still parses. The other ticket audiences —
workspace, control, block, dictation — deliberately do not return one, because
nothing traces them yet.

Shipped in #203.

### 2026-08-18 — Dictation admission serializes in the owning WorkspaceDO

**What changed:** The dictation bridge consumes its ticket `jti` and holds its
session lease in WorkspaceDO-local SQL (`realtime_transcription_ticket_receipts`
and `realtime_transcription_sessions`) through the workspace runtime port; the
D1 tables are fenced maintenance-import input after the authority cutover.

**Why:** The per-user and per-workspace concurrency caps were counted with D1
compare-and-set, so two simultaneous upgrades could both pass the check, and a
lost release needed a retry-delay loop. The workspace object serializes the
expiry sweep, ticket consumption, and cap-checked insert as one transaction —
the same receipt model every other socket audience already uses.

**Considered and rejected:** A dedicated admission object (the workspace
object already exists on this path and the caps are workspace facts), and
leaving admission in D1 for latency (one RPC ahead of opening a
cross-continent Azure WebSocket).

**Consequences:** Dictation admission fails closed if the workspace object is
unreachable. The lease-release retry loop remains as defense in depth but no
longer papers over a racing store.

### 2026-08-18 — Schema-drifted agent frames leave bounded diagnostics

**What changed:** WorkstreamDO control and BlockDashboardAgent sockets still
ignore malformed frames and recover from the next authoritative snapshot, but
each hook now records one payload-free warning per mounted socket set.

**Why:** Silent Zod failures made a server/client contract mismatch
indistinguishable from an idle socket, while logging every frame or its payload
would create noise and risk exposing product content.

**Considered and rejected:** Closing the socket on the first malformed frame,
logging raw frames, and warning without a per-mount bound.

**Consequences:** A malformed frame does not disrupt the UI or reconnect loop;
developers get the validation issues or JSON error from the first occurrence.

### 2026-08-18 — Offline directory reads fail immediately

**What changed:** The workspace socket rejects only pending directory-page
requests when the desktop goes offline, while keeping idempotent message
commands eligible for reconnect resend.

**Why:** A read-only page cannot succeed offline and previously held its caller
for the full command timeout. Mutations have different recovery semantics and
must not be discarded with reads.

**Considered and rejected:** Rejecting every pending command and waiting for the
generic 120-second timeout.

**Consequences:** Infinite-scroll callers can render their offline state
promptly; message delivery retains ambiguous-result recovery.

### 2026-08-18 — Both control sockets share field-level waterlines

**What changed:** WorkstreamDO metadata and WorkspaceDO directory events now
carry the same per-field UUIDv7 row identities plus independent common/viewer waterlines.
The renderer applies both through one query-cache ledger and rejects equal or
older fields. Workspace directory pages separately fence WorkspaceDO-owned pin
fields with their directory waterline and reload after reconnect. Workspace
topic events now expose a `waterline` and UUIDv7,
coalesce missed topics on reconnect, and signal OAuth completion instead of
driving an interval poll.

**Why:** Queue-delivered WorkstreamDO-to-WorkspaceDO changes can duplicate and
reorder, while the direct work-stream socket is deliberately faster for an open
row. Two caches or one combined version would allow the delayed copy to roll
back the header/sidebar or a viewer-only update to hide a common update.

**Considered and rejected:** Ordering by UUIDv7 alone, replaying every missed
invalidation, retaining REST query intervals, and making only one socket update
the shared work-stream cache. Independent same-millisecond UUIDs are not causal,
and the product needs both the active low-latency path and inactive sidebar path.

**Consequences:** Receivers care about newest state per authority key rather
than every intermediate event. New socket-published state must declare its
waterline, generation, and cache authority; UUID lexical order remains useful
for tracing only.

### 2026-08-18 — Workspace socket serves the authoritative work-stream directory

**What changed:** WorkspaceDO now answers correlated, cursor-paged
`list_workstreams` messages from its own SQLite directory. Electron's infinite
work-stream query uses this socket exclusively and retries an unresolved page
after reconnect. The topic stream continues to invalidate D1-owned workspace
modules and now invalidates the object-owned directory pages too.

**Why:** Once WorkspaceDO owns cross-work-stream state, serving the sidebar
through a REST/D1 projection would preserve the very second authority the move
is intended to remove. The persistent socket already has the authenticated
workspace/session context and reconnect lifecycle.

**Considered and rejected:** A new directory-only socket, one WorkstreamDO
socket per sidebar row, and REST fallback. They add connection count, unbounded
fan-out, or split authority respectively.

**Consequences:** The workspace protocol carries both invalidations and bounded
directory responses; callers must correlate request IDs and retain requests
across transient reconnects. WorkstreamDO sockets still provide fresher complete
detail snapshots for selected/running rows but are not required to render a
workspace list.

### 2026-08-18 — Substream sockets page history and carry compaction state, and every agent socket resumes from a durable checkpoint

**What changed:** The feed socket now supports correlated before/after cursor
reads from object-local message authority. Electron's upward infinite scroll,
newer recovery, and jump-to-latest use those reads while preserving viewport
position.

SubstreamAgent feed events and snapshots now carry the active Bind compaction
run/attempt/index/trigger/start time. Electron renders that phase directly and
restores it after replay history is unavailable.

Each visible HyperSight block now opens a purpose-scoped, single-use,
hibernating socket directly to its `BlockDashboardAgent`. The block agent
commits and emits the same active-stream checkpoint contract as SubstreamAgent;
WorkstreamDO continues to publish configuration/preferences but no longer
relays per-block run output.

**Why:** Once SubstreamAgent owns the message feed, fetching older pages through
a separate regional transport duplicates authorization and can race the live
snapshot. A room-sequenced page reply would be worse: one reader scrolling
would advance every reader's replay cursor.

A silent token interval is not a protocol. The user needs to distinguish
context summarization from slow inference, tools, and a disconnected socket
even after switching away and back.

The block DO owns the complete loop, so routing token output through
WorkstreamDO created a second publication hop and could not resume an in-flight
answer from the execution owner's checkpoint. Direct block sockets make every
agent authority independently streamable and recoverable after eviction or UI
navigation.

**Considered and rejected:** For history pages: broadcasting page results,
allocating a room sequence per page, loading the whole transcript in the
initial snapshot, and polling REST while scrolling. They respectively leak
viewer work, corrupt resume semantics, exceed frame/memory bounds, or restore a
split serving path.

For compaction: heuristics based on elapsed time and an in-memory only event.
Neither has a durable boundary, and both glitch on reconnect.

For block sockets: terminal-result-only block sockets, relaying block tokens
through WorkstreamDO, and polling. They respectively hide long progress, load
the control object, or cannot preserve smooth live output.

**Consequences:** Pagination is request/reply, per-reader, reauthorized, capped
at 250 rows and 900 KB, and wakes only the target agent when a user asks for
history. The loading row/button remains as progress and retry UI; ordinary
scrolling starts the request automatically.

Compaction lifecycle frames share the ordered SubstreamAgent room sequence;
only the matching run/attempt/index may finish the phase, and terminal status
is a defensive clear. HyperSight does not send the event because its runs do
not enable context compaction today.

The block-socket decision supersedes the earlier no-block-socket consequence
below. Electron opens block sockets only while the HyperSight panel is visible,
closes removed blocks, replaces from full checkpoints, and ignores stale
revisions. Idle accepted sockets hibernate; block socket tickets have a fourth
audience and their own SQL replay receipts. Committed block frames pass through
a caught serial publication queue that coalesces adjacent unsent checkpoints,
so delivery order is preserved and a viewer-side or authorization dependency
can neither fail the owned agent loop nor build an unbounded stream backlog.

### 2026-08-18 — Electron holds separate workspace, work-stream, and substream sockets, and HyperSight rides the WorkstreamDO one

**What changed:** Each authenticated renderer now holds one persistent
WorkspaceDO synchronization/command socket, a complete-metadata WorkstreamDO
socket for each active/running work stream, and the direct SubstreamAgent
transcript socket. Each has a distinct ticket audience and SQL replay/receipt
boundary.

HyperSight configuration, per-block run status/results, and viewer preference
arrive as WorkstreamDO control events. Individual `BlockDashboardAgent`
instances expose no desktop socket.

**Why:** Workspace settings/directories, aggregate work-stream metadata, and a
high-volume ordered model feed have different authorities and lifecycles. The
previous per-message workspace socket could not keep settings or sibling
clients live, while putting metadata on token frames would couple navigation
state to an agent run.

A derived block is work-stream metadata, not an ordered conversation feed.
Adding a socket per block would multiply background connections and duplicate
authorization/reconnect state without improving token delivery.

**Considered and rejected:** One multiplexed workspace socket for all token
traffic, WorkstreamDO metadata inferred from the child feed, and periodic REST
polling. They respectively recreate a workspace throughput bottleneck, lose
model-free metadata updates, and spend resources while still adding sync delay.

For HyperSight: broadcasting block results from main SubstreamAgent, opening a
block-agent WebSocket, and REST polling. Those options misplace publication
authority, increase idle sockets, or add avoidable churn.

**Consequences:** New workspace surfaces must map to a typed sync topic and new
WorkstreamDO fields must be included in its full snapshot. The renderer must
clear nullable snapshot fields, preserve the workspace version cursor across
reconnect, and keep child sockets only for selected or running work streams.

The renderer applies block-result versions from the existing work-stream
control connection; the source feed remains limited to canonical conversation
data and active output.

### 2026-08-17 — Socket acceptance follows the documented hibernation lifecycle

**What changed:** Both Durable Objects now register the server socket with
`acceptWebSocket()` before serializing its attachment. Real-workerd eviction
tests cover attachment recovery and runtime auto-response for workspace and
substream sockets.

**Why:** Cloudflare's lifecycle registers a socket as hibernatable first and
then associates the state a replacement isolate will deserialize. Matching that
order removes dependence on permissive runtime behavior and makes the recovery
contract explicit.

**Considered and rejected:** Maintaining a second in-memory session map merely
to mirror the example. Rally already enumerates `getWebSockets()` and validates
attachments at each use, which survives hibernation without duplicate state.

**Consequences:** New socket acceptors must preserve accept-then-attach ordering,
keep attachment data below Cloudflare's 16 KiB bound, and add forced-eviction
coverage in the workerd suite.

### 2026-08-17 — Commands and feeds use separate hibernating sockets

**What changed:** User messages now enter one workspace-scoped `WorkspaceDO`
socket, while the Electron app connects directly to the selected
`SubstreamAgent` for snapshot, streaming, replay, and download. Tickets carry
distinct audiences and are consumed in each object's explicit SQLite table.

**Why:** Workspace authorization/routing is the natural write boundary, while a
direct child feed avoids a parent fan-out hop and lets independently active
substreams stream and reconnect without blocking one another.

**Considered and rejected:** One bidirectional child socket would put workspace
write authorization in every agent object. Proxying every token through the
workspace object would turn it into a throughput and billing hotspot.

**Consequences:** The desktop maintains two lifecycle state machines. A
`create_message` on the child feed is a protocol error, and switching children
resumes from each child's own cursor/checkpoint.

### 2026-08-17 — Room tickets carry the session needed for later commands

**What changed:** The work-stream ticket binds the current regional session ID,
and the verified edge forwards that ID into the room's serialized socket
attachment without forwarding the signed ticket.

**Why:** A hibernating socket can outlive logout, revocation, or membership
changes. Once the socket became a message-command ingress, connect-time identity
was insufficient to authorize every later mutation.

**Considered and rejected:** Passing the session bearer or full signed socket
ticket into the Durable Object would broaden credential exposure. Trusting the
user/workspace claims for the socket lifetime would let a revoked session keep
writing until the connection happened to close.

**Consequences:** Every message command can query the current regional session.
Sockets serialized before this claim existed are deliberately closed with 1012
when they first try to write and reconnect with a fresh ticket.

### 2026-08-17 — Room ticket receipts move into named local SQL and admission follows the authority generation

**What changed:** The verified ticket JTI remains consumed by the one
work-stream room, but its replay receipt now lives on the `socket_ticket`
channel in `durable_inbox_receipts`. Existing `socket-ticket:<jti>` values are
imported in place and then deleted. Room admission now names the authority
generation it must reauthorize against, while ticket replay receipts and
hibernating transport stay local to the same object.

**Why:** The Durable Object was already SQLite-backed. A named receipt table
gives replay protection an inspectable key and retention query instead of an
unstructured hidden value, without moving the bearer ticket into the room.

After product authority moves, a frozen legacy participant row cannot revoke a
live reader. Workspace membership remains a D1 fact; work-stream participation
becomes an object fact.

**Considered and rejected:** Consuming the work-stream JTI in D1, which would
add a regional database write and contention point to every socket admission;
passing the signed ticket through, which broadens credential exposure; and
keeping D1 participant rows as an authorization fallback, which would silently
restore a second authority.

**Consequences:** Admission semantics and error codes are unchanged by the
receipt move. Any new room ticket path must use the SQL receipt operation and
preserve the edge/room split between signature verification and final
authorization. Maintenance closes every existing room socket. Reconnect is
admitted only after the regional generation opens and the new authority
answers.

### 2026-08-11 — The ticket moves from the query string to the handshake subprotocol

**What changed:** A client presents its realtime ticket as
`Sec-WebSocket-Protocol: rally.ticket.v1, <ticket>` instead of `?ticket=`. The
server reads it from there, prefers it over the query, echoes only the sentinel,
and still accepts the query so builds released before this keep connecting.

**Why:** Enabling Workers Traces (#80) surfaced that Cloudflare records whole
request URLs into three stores — the invocation log, the 90-day Logpush export
to R2, and now trace spans — none of which any redaction here can reach, because
the URL arrives on the request rather than through `logEvent`. A 60-second
single-use ticket sitting in all three is a small exposure but a real one, and
it was the only half of that finding that could actually be fixed: the other,
a connector OAuth callback's `?code=`, is the provider's redirect and cannot
move. The header is the one a browser will set on a handshake.

**Considered and rejected:** Offering the ticket as the *only* subprotocol. The
server must echo a token it was offered, so the echo would then be the
credential itself, in a response header — the same problem one hop later. Also
rejected: cutting the query transport in the same change. The desktop
auto-updates, but a build in the wild reads the URL field and would fail its
next reconnect the moment the query stopped being accepted.

**Consequences:** Two transports exist until released builds roll over, and the
exposure persists for those clients until the second half ships — dropping
`SOCKET_TICKET_QUERY_PARAM`, the ticket in the issued URL, and the smoke check's
compatibility assertion. `withNegotiatedSubprotocol` must keep its
`status !== 101 || !webSocket` guard: without it, every room rejection is
rebuilt into an upgrade workerd refuses to construct, and a deliberate 401
becomes an unhandled 500. That regression is covered on real workerd rather than
on Node, because the Node suite's stand-in `Response` cannot express the
constraint.

Shipped in #106.
