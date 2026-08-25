# Realtime socket admission

Every Rally WebSocket — workspace synchronization/commands, work-stream
metadata, the direct substream feed, derived HyperSight block output, and the
dictation bridge to Azure — is
opened with a short-lived ticket rather than
the session credential. This document owns how a purpose-specific ticket is
issued, how it reaches the Worker, and how a handshake is accepted or refused.
What happens *on* an open socket belongs elsewhere: workspace directory serving,
invalidation, and command routing are `WorkspaceDO`'s, aggregate metadata is `WorkstreamDO`'s,
feed fan-out/replay/presence is `SubstreamAgent`'s, derived block streaming is
`BlockDashboardAgent`'s, and the dictation bridge's audio rules are in
[`architecture.md`](architecture.md).

The feature is still labelled **HyperSight** in the application. Its internal
socket owner, ticket audience, event types, query keys, and URL path use
`BlockDashboard` / `block-dashboard`; there is no legacy `/hypersight` route.

The promise it makes is narrow and worth stating plainly: a socket is opened
only by someone who just proved, over an authenticated HTTP request, that they
may open that exact socket — and proving it leaves no credential anywhere a URL
is recorded.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/socket-tickets.ts` | The transport: the subprotocol sentinel, the deprecated query parameter, and the shared helpers both sides use. The single source of the wire format. |
| `apps/api/src/services/socket-service.ts` | Issues and verifies the separate workspace, work-stream-control, substream-feed, and HyperSight-block ticket audiences, reads the presented ticket, negotiates the response subprotocol, and admits each upgrade. |
| `apps/api/src/services/realtime-transcription-service.ts` | The dictation ticket, its WorkspaceDO replay receipt and session lease, and the Azure upgrade. |
| `apps/api/src/routes/socket.ts` | Workspace, work-stream-control, substream-feed, HyperSight-block, and dictation upgrade routes. The query ticket is optional here; the service decides what was presented. |
| `apps/api/src/durable-objects/workspace-do.ts` | Accepts the persistent workspace synchronization/command socket, serves authoritative cursor-paged work-stream rows, persists a bounded replay log, and consumes its purpose-specific ticket in SQL. |
| `apps/api/src/durable-objects/workstream-do.ts` | Accepts the per-work-stream aggregate metadata socket and returns complete viewer-specific snapshots. |
| `apps/api/src/durable-objects/block-dashboard-agent.ts` | Accepts one hibernating socket per visible configured block and returns its durable run plus active-output checkpoint. |
| `apps/api/src/durable-objects/substream-agent.ts` | Accepts the direct read/stream/download feed and consumes its distinct ticket in SQL. It rejects user message commands. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Keeps the workspace socket alive across navigation, correlates/retries directory-page requests, resumes its waterline, applies current work-stream rows, invalidates workspace query surfaces, and resends idempotent message commands after reconnect. |
| `apps/api/src/services/sidebar-reads.ts` | The automation and note statements plus row mappings the sidebar opens with, shared by WorkspaceDO's batch and the REST services so the two readings of one table cannot drift. |
| `apps/desktop/src/renderer/lib/sidebar-list-store.ts` | The one receiver for the sidebar's two pushed lists: the opening batch and every push compare against its per-list waterline ledger rather than writing the caches directly. |
| `apps/desktop/src/renderer/lib/use-workstreams-query.ts` | Pages the work-stream directory beyond the first, which the connect payload delivers; it does not fetch page one and widens the list only when Debug enabled asks for system rows. |
| `apps/desktop/src/renderer/lib/use-workstream-control-socket.ts` | Applies complete waterlined WorkstreamDO metadata snapshots to detail and sidebar caches. |
| `apps/desktop/src/renderer/lib/workstream-state-store.ts` | Shared common/viewer and WorkspaceDO-directory waterline ledgers used by both parent sockets; independently rejects stale state fields and older pin/page fields. |
| `apps/desktop/src/renderer/lib/use-block-dashboard-sockets.ts` | Opens block sockets only while HyperSight is visible, applies full stream checkpoints, rejects stale revisions, and reconnects without duplicate text. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Keeps the selected/running SubstreamAgent feed and invokes the separate WorkstreamDO control lifecycle. |
| `apps/desktop/src/renderer/lib/workstream-socket-pool.tsx` | Owns those two work-stream sockets above the route and retains recently viewed work streams without remounting their connection hooks. |
| `apps/desktop/src/renderer/lib/api.ts` | Parses every ticket response, strips the deprecated query ticket, and attaches the handshake subprotocols. |

## How it works

A client cannot authenticate a WebSocket handshake the way it authenticates a
request: a browser sets no headers on one, so `Authorization` is unavailable. So
admission is split in two.

1. **Issue.** The desktop calls
   `GET /workspace/socket` for workspace sync/commands,
   `GET /workstreams/:id/control-socket` for aggregate metadata,
   `GET /workstreams/:id/substreams/:substreamId/socket` for the feed, or
   `GET /workstreams/:id/block-dashboard/blocks/:blockId/socket` for a block agent, or
   `GET /realtime/transcription/socket`. The Worker checks the caller may open
   that exact purpose and mints a 60-second HS256 JWT binding user, workspace,
   region, one-time `jti`, audience, only the target IDs that purpose requires,
   and the current regional session ID. The two work-stream feed routes also
   return that `jti` as `ticketId` beside the ticket — the id of the credential,
   never the credential — because the upgrade it authorizes opens a new
   connection carrying no request id, and it is the only value the issuing
   route, the edge, and the room all hold. See
   [`performance-tracing.md`](performance-tracing.md).
2. **Present.** The client opens the socket with the ticket as the second
   `WebSocket` constructor argument: `[rally.ticket.v1, <ticket>]`. The browser
   sends those as `Sec-WebSocket-Protocol`, the one request header it will carry
   on a handshake. A ticket is a compact JWS — base64url joined by dots — which
   is a legal subprotocol token, so it needs no encoding.
3. **Verify.** The Worker checks the `Upgrade` header and the exact `Origin`,
   reads the ticket off the offer, verifies the signature and the claims, and
   rejects a region or work-stream mismatch.
4. **Admit.** A feed upgrade reaches the exact `SubstreamAgent`, which
   re-authorizes read visibility and atomically consumes its ticket id. A
   metadata upgrade reaches the exact `WorkstreamDO`, which verifies D1
   membership plus its local visibility projection. A workspace upgrade reaches
   the workspace's `WorkspaceDO`, which consumes a separate audience ticket and
   serializes the verified session identity; every subscribe or later command
   rechecks the current D1 session and membership, and both of its publish paths
   sweep the connected set — immediately for a retracting topic, otherwise once
   per 30 seconds — closing the sockets that no longer pass. Neither object
   receives the signed bearer ticket.
   A HyperSight upgrade reaches the exact block agent after the edge verifies
   D1 membership and WorkstreamDO authorizes the block/viewer pair. The block
   consumes its own ticket receipt and persists only the bounded authorization
   timestamp in the hibernation attachment.
   Dictation consumes its `jti` and reserves a session lease in the owning
   WorkspaceDO — one serialized transaction, so two simultaneous upgrades
   cannot both pass the per-user/per-workspace concurrency caps — before
   opening Azure.
5. **Negotiate.** If the client offered the sentinel, the accepted 101 answers
   with it. Chromium fails a handshake whose subprotocol offer went unanswered,
   so the answer is required — and it is always the sentinel, never the ticket.

### Hibernation lifecycle

All four product objects follow Cloudflare's [WebSocket Hibernation
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

Each authenticated Electron renderer window maintains exactly one WorkspaceDO
socket for the active workspace. It is not recreated when the user changes work
streams. Main, standalone Settings, and Meeting windows therefore converge
independently without routing product data through main-process IPC. For
each selected or still-running work stream, the desktop also maintains one
WorkstreamDO metadata socket and one SubstreamAgent feed socket. While the
HyperSight panel is visible it additionally maintains one direct socket per
configured block. Switching away keeps the exact metadata/feed socket pair
mounted for at least five minutes, so returning to a recently viewed work stream
does not spend another ticket request, handshake, subscribe, or snapshot. The
five-minute clock restarts each time the work stream leaves the foreground;
background-running conversation streams remain connected beyond it. Block
sockets still close with the panel and recover from durable checkpoints when it
is opened again. Access revocation is not delayed: the server closes every
affected retained socket immediately, and that socket permanently stops
reconnecting.

The workspace socket carries its authoritative work-stream directory rows plus
durable topic invalidations for the other D1-owned workspace modules. Its
`workspace_sync_events.waterline` is monotonic inside the WorkspaceDO and each
row has a UUIDv7 trace ID. Live receivers ignore an equal/older waterline. On
reconnect the object unions every missed topic and sends one event at the newest
available waterline; if the bounded 1,024-row window cannot cover the cursor,
one `history_unavailable` event names every topic. The client needs current
state, not each invalidation that led to it. Its
complete topic catalog is:

| Topic | Refetched authoritative surfaces |
| --- | --- |
| `workspace_profile` | Workspace name, slug, immutable region, workspace timezone, current role, inference-log policy, creation metadata, and onboarding workspace view. |
| `member_directory` | Active/invited/suspended members, user name/email/avatar/timezone/role/join time, and onboarding membership state. |
| `invitation_directory` | Pending/accepted/expired/revoked invitations, role, inviter, expiry, acceptance, and delivery-visible state. |
| `connector_connections` | Connection identity, type, scope/owner, account/display name, capabilities, health/reconnect/error state, catalog capabilities, GitHub repository access, and onboarding connector state. Credentials never enter this feed. |
| `connector_oauth_attempts` | Signals that a pending OAuth attempt should be read once from its authenticated endpoint. The renderer does not poll while the provider window is open. |
| `terminal_policy` | Workspace Terminal capability, Daytona configuration availability, network allow/deny policy, version, and validation/failure state. |
| `digest_schedule` | Per-viewer digest enablement, cadence/timezone, destinations, and next run. |
| `automations` | Automation detail and drafts. **Not** the sidebar list, which is pushed whole as `workspace_sidebar_list`. |
| `notes` | Note detail. **Not** the sidebar list, which is pushed whole as `workspace_sidebar_list`. |
| `resources` | Resource directory, hydration/watch/content availability, work-stream context links, and connector-derived resource changes. |
| `activity` | Connector activity ingestion that can change opportunity generation or activity-derived UI. |
| `work_opportunities` | Suggested work/actions, audience, version, accepted/dismissed state, and resulting work-stream directory changes. |
| `workstream_directory` | Invalidates WorkspaceDO cursor-page membership/order and pin changes. Normal common/viewer state transitions instead push the current waterlined row directly. D1 is never a list fallback. |
| `viewer_preferences` | Telemetry, HyperSight, and other current-user workspace preference surfaces. |
| `feature_flags` | Effective client feature gates when a workspace-scoped producer explicitly publishes a change. |

Electron sends `list_workstreams` with a stable request ID, bounded limit,
optional opaque `(last_activity_at, workstream_id)` cursor, and the system-row preference. WorkspaceDO responds
with `workspace_workstream_page`, the directory waterline, each row's independent
common/viewer waterlines plus the corresponding UUIDv7 row identities, parsed work-stream rows,
and the next cursor. Pending page requests survive a transient reconnect
and reject only when the provider is disposed or the user/session changes. A
`workstream_directory` sync invalidation refetches these pages; it never asks a
REST/D1 list endpoint to reconstruct them.

Subscribing is answered with the sidebar itself. The `workspace_sync` event that
answers `subscribe` carries a `sidebar` field: one `workstream_page` body plus
the viewer's automations and notes, each bounded at 250 rows and each stamped
with its own waterline. All three come from this object's own SQLite —
`workspace_workstream_directory`, `automation_subscriptions` and `notes` — read
with no `await` between them, so the sidebar opens on one consistent snapshot
and on no request at all. The client's `subscribe` frame names no collection, no
filter and no page size; it carries a waterline, which is where that client got
to, not what it would like.

Every subscribe carries it, cold or resuming. A resume where no topic moved
still gets one, under `reason: "resume"` with an empty topic list — the one
event shape allowed to name no topics, because it exists to hand over state
rather than to report news. That matters because a push can be missed while a
socket is away and produce no topic at all: the workspace alarm advancing an
automation's next run is exactly that. A resume that missed nothing costs the
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

The directory page in that payload deliberately excludes system work streams.
Debug enabled is rare and engineers only, and the server does not hold the
preference — it lives in the desktop's own application settings — so a viewer
who wants those rows re-draws the sidebar from a `list_workstreams` request
carrying `includeSystem`. Loading the common case unasked and paying a round
trip for the rare one is the way round that suits the p95; the reverse would put
a debug preference in everyone's connect. The automations and notes do not vary
by it at all.

Neither list has a REST fetcher behind it any more. WorkspaceDO re-sends the
affected list whole as `workspace_sidebar_list` whenever it writes one of their
rows, so the batch is the only load and the push is the only refresh — which is
also why *every* first page is a batch, not just the cold one: a reconnect or a
debug toggle reloads the directory, and those two lists have nothing else to
reload them.

Change detection sits in `runWorkspaceSql`, the one entry point every write to
these tables passes through — a desktop REST write, a Workflow, and the
workspace alarm advancing `next_run_at` after a scheduled run. That last one is
why the push exists rather than another topic: the alarm carries no HTTP
request, so the mutation middleware that derives topics from a request path
never saw it, and a sidebar row's next-run time stayed stale until something
unrelated refetched the list. The alarm reaches its own SQL through
`localWorkspaceEnv` rather than the RPC method, so both callers go through
`runWorkspaceSql` — a check on the RPC method alone would miss the writer that
motivated it.

The event carries the whole list and a waterline for that list, monotonic within
WorkspaceDO and advanced inside the transaction of the write that earned it. Two
counters rather than one, because the lists change independently and one counter
would let a note write hide an automation update. The opening batch carries the
same two numbers, so the batch and every later push land in one client receiver
that applies only a strictly greater version — `sidebar-list-store.ts` — rather
than two handlers each trusting arrival order. What the lists do *not* carry is a
version per row: unlike a work-stream row, which is assembled from child objects
over an unordered Queue and needs one per field, the list is the unit here, and
a row the viewer can no longer see is expressed by its absence, so archive and
delete need no tombstone. Each list is read per socket, because a personal
automation or note belongs to one viewer. The renderer applies WorkspaceDO-owned
fields such as pin position only when that row's observed directory waterline is
newer. Every socket reconnect also reloads a resident directory, because current
state rows intentionally do not retain every intermediate push for replay.

`WorkstreamDO` always sends a complete snapshot, not a partial patch.
Common fields are identity, workspace ID, title/title status, description,
preview, email address, origin, creator, automation subscription/run, planned
time, exact and normalized state, attention/unread baseline, last activity,
completion/archive/create/update timestamps, scope/system kind, next wakeup and
next Terminal action. Its viewer overlay is participation/listability, unread
count, mention status, read-through waterline, manual-unread fence/generation,
and latest mention sequence. Sending null clears a prior value. Common and
viewer fields each carry their own authority-local waterline and UUIDv7 row ID.
The common and viewer IDs are preserved independently across both socket paths;
they are time-sortable trace/deduplication identities, not a distributed causal
clock.

The same logical state can arrive first from the active WorkstreamDO socket and
later from WorkspaceDO after at-least-once, unordered Queue delivery. Both
handlers write through the same Electron ledger. A field applies only when its
authority generation is newer or its own common/viewer waterline advances;
advancing viewer state can never suppress a delayed common update. The direct
path therefore updates an open header immediately, while the workspace path
updates an inactive row, sidebar group, unread badge, or You Are Mentioned view.
No interval polling participates in convergence.

The WorkstreamDO socket carries shared HyperSight configuration and the current
viewer's HyperSight preference. Each configured block has a direct
`BlockDashboardAgent` socket for queued/running/terminal state, token output,
and reconnect snapshots. This is a block-result channel, not a conversation
feed: it accepts no user messages and exposes no source transcript.

The block agent commits the same `ActiveStreamCheckpoint` shape used by
`SubstreamAgent` before it sends a frame. Its initial snapshot always includes
the checkpoint field. That field is a complete text, turn/epoch, stream
sequence, and checkpoint revision only for the matching committed in-flight
run; it is `null` for queued/terminal runs or when no checkpoint has committed,
and the run state/result is then authoritative.
Live frames carry complete checkpoints rather than token-sized rows. Electron
replaces visible text from a newer checkpoint and rejects an older revision;
it never concatenates a reconnect snapshot to cached text. The shared harness
batcher limits publication to the 100 ms/2,048-character boundary (at most the
10 fps tier), so 100 tokens/second does not mean 100 socket frames or SQL rows
per second.

Authorization is not on that high-frequency path at all. A block socket is
authorized when it connects and holds until something closes it; the agent does
not re-ask on a timer. WorkstreamDO still commands an immediate block-socket
sweep when a block is removed from the dashboard, which is its own fact rather
than a D1 one. Losing access is carried instead by the
[access-revocation queue](access-revocation.md), which reaches every object
holding one of that person's sockets. Every checkpoint broadcast therefore stays
local to the execution owner.

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

Older/newer transcript pagination is a correlated, viewer-specific request on
that same SubstreamAgent socket. Electron sends `load_message_page` with an
opaque before/after cursor, request UUID, and bounded limit (200 by default,
250 maximum). The agent revalidates the socket's session and product visibility,
reads its local `parts` authority, and returns `message_page` or a correlated
error. Page replies do **not** allocate a shared room sequence and are neither
broadcast nor replayed: they answer one reader's query and must not move every
other reader's resume cursor.

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

The initial socket snapshot still carries the newest page and both cursors.
When a user scrolls within 160 px of the top, Electron requests the preceding
page, merges by stable message identity, and restores `scrollTop` by the exact
height inserted above the viewport. Newer-page and jump-to-latest recovery use
the same socket path. Requests exist only while the user navigates history; an
idle/background window produces no pagination traffic, and the accepted socket
continues to hibernate. A page frame is capped at 900 KB; the agent reduces the
page toward the requested cursor and returns the adjusted continuation cursor
rather than splitting one message or emitting an oversized frame.

### The deprecated query transport

The legacy workspace, work-stream, substream, and dictation issuers still return
a URL containing `?ticket=` because a desktop build released before the
subprotocol scheme reads exactly that field. The HyperSight issuer is new and
returns only a clean URL. The shared upgrade service still accepts the query on
legacy-compatible routes; the header wins when both are present. The current
renderer strips any legacy query at the point it parses a ticket, so no current
client sends one and no block-ticket bearer is ever issued in a URL.

## Invariants

- **A ticket never appears in a URL a current client opens.** Cloudflare records
  request URLs into stores this repository cannot redact; a ticket in the query
  is a live credential in all of them. Break this and the credential is back in
  the invocation log, the 90-day Logpush export, and every trace span.
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
  in `durable_inbox_receipts`; WorkspaceDO, WorkstreamDO, and
  BlockDashboardAgent consume theirs in their own SQL receipt tables. Workspace membership remains in D1 while
  work-stream participation/revocation is projected locally.
- **Ticket audiences are not interchangeable.** Workspace, aggregate metadata,
  feed, and block-agent tickets cannot open one another's sockets. Otherwise a narrow read
  credential could become a workspace write credential.
- **Origin is checked before the ticket is read.** An exact match against
  `ALLOWED_ORIGINS`, so a lookalike host cannot spend a ticket.
- **A ticket is single-use.** Each target object and the dictation bridge consume
  the `jti` atomically; a replay is refused rather than opening a second socket.
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

It does not own what happens next. Workspace command authorization/routing and
child subscription, event replay, presence, and `resync_required` are described in
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
- **Wrong audience, region, workspace, work stream, substream, or block** — 403 `socket_ticket_scope_mismatch`.
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

Directory pages are read-only and are not reconnect-resend commands. If
Electron receives the browser `offline` signal while a page is in flight, it
clears that request's 120-second timer and rejects immediately with
`workspace_directory_offline`. Message commands remain pending because their
client message IDs make reconnect resend idempotent.

## Testing

| Suite | Command | Covers |
| --- | --- | --- |
| `packages/contracts/src/socket-tickets.test.ts` | `pnpm --filter @rally/contracts test` | The wire format: offers, parsing, refusal of non-tickets, URL stripping. |
| `apps/api/test/socket-ticket-transport.test.ts` | `pnpm --filter @rally/api test` | Precedence and the negotiation decision, on Node. |
| `apps/api/test-workers/socket-subprotocol-runtime.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts` | The runtime constraint, on real workerd. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | `pnpm --filter @rally/api exec vitest run --config vitest.workers.config.ts` | Hibernating WorkspaceDO, WorkstreamDO, SubstreamAgent, and BlockDashboardAgent attachments/snapshots; authoritative workspace directory application/page/resource queries; eviction; native-RPC envelopes; workspace protocol/session/access close-code separation and payload-free diagnostics; bidirectional transcript pagination and revocation; compaction recovery; block checkpoint recovery/revocation; queued-run coalescing; ticket replay; and read-only feeds on real workerd. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx`, `use-workstreams-query.test.tsx`, `workstream-state-store.test.ts` | `pnpm --filter @rally/desktop test` | One persistent workspace connection, truthful terminal errors for access/session/protocol closes, correlated directory pages/pagination, immediate offline page rejection, waterline resume, stale/duplicate rejection across both sockets, independent common/viewer ordering, and idempotent command resend. |
| `apps/desktop/src/renderer/lib/use-workstream-control-socket.test.tsx` | `pnpm --filter @rally/desktop test` | Complete aggregate snapshots, stale waterline rejection, nullable-field clearing, revocation, and reconnect. |
| `apps/desktop/src/renderer/lib/use-block-dashboard-sockets.test.tsx` | `pnpm --filter @rally/desktop test` | Full-checkpoint replacement without duplicated text, stale revision rejection, ticket and short-lived-socket reconnect backoff, permanent stop on `1008`, offline/online recovery, removed-block closure, and ping/pong timeout. |
| `apps/desktop/src/renderer/lib/workstream-socket-pool.test.tsx`, `use-workstream-socket.test.tsx`, `apps/desktop/src/renderer/screens/workstream.test.tsx` | `pnpm --filter @rally/desktop test` | Initial-read admission for the pooled WorkstreamDO/SubstreamAgent pair, exact-pair reuse for five minutes after switching streams, expiry closure, direct SubstreamAgent feed reconnect/resync, streaming, explicit compaction lifecycle/reconciliation, page merging, direction-neutral errors, scroll thresholds/anchor preservation, and workspace-command routing. |
| `scripts/smoke-local.mjs` | `pnpm smoke:local` | A real handshake end to end, both transports, and the replay status. |

**The trap, and it has already cost one bug:** Node's `Response` refuses status
101, so the Node suite stands in a fake one. That fake validates nothing, which
means it will happily construct the invalid upgrade that workerd rejects — a
test written there can assert a rebuild "works" while production throws. Any
assertion about what may be *constructed* belongs in `test-workers/`, where the
runtime is the real one. Ticket fixtures are also deliberately not shaped like
real JWTs: a `eyJ`-prefixed literal trips the Gitleaks `jwt` rule and fails the
`secrets` gate over the whole history, not just the diff.

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

## Changelog

### 2026-08-25 — Recently viewed work-stream sockets survive navigation for five minutes

**What changed:** Electron owns WorkstreamDO metadata and SubstreamAgent feed
sockets in a keyed pool above the active route. A work stream that leaves the
foreground keeps its exact socket pair for at least five minutes; returning
within that window reuses the connections, and a running work stream remains
connected without an expiry. A newly opened route enters that pool only after
its initial detail and transcript reads succeed; once admitted, the keyed entry
stays admitted while it is active, recent, or running.

**Why:** Route ownership closed both sockets immediately even though the person
was likely to switch back. Reopening paid for two ticket requests, two
handshakes, two subscriptions, and two snapshots before realtime state was
current again, while Cloudflare can hibernate the idle connections at no object
duration cost.

**Considered and rejected:** Keeping only the React Query cache still requires
fresh subscriptions before it is safe to trust; opening sockets for every work
stream in the directory would retain connections unrelated to recent use. A
five-minute recent set preserves the likely back-navigation path without making
the whole sidebar live.

**Consequences:** Feed and metadata sockets share the same retention lifetime,
but HyperSight block sockets still follow panel visibility. Access revocation
still closes retained sockets immediately. Future route refactors must keep the
pool keyed by work-stream id and preserve the initial-read admission signal or
they will turn retention into either close-and-redial or rejected-route retry
loops.

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

### 2026-08-22 — The sidebar push does not re-ask who may listen

**What changed:** Rebasing this branch onto `main` landed it on top of the
access-revocation queue. The sweep this branch had added to `publishSidebarList`
is gone with the mechanism it belonged to, and that publish is synchronous
again, as are `runWorkspaceSql` and its callers.

**Why:** The finding it answered was real — a revoked session kept receiving a
viewer's whole automation and note list — but the answer is no longer the
publisher's. `docs/access-revocation.md` closes an open socket from a queue
message written by whoever ended the access, and names re-checking authorization
on the way out as the mechanism it replaced. A publisher that asks again is the
thing that is not to come back, whatever it is publishing: the bound belongs to
the socket, not to any one payload sent over it.

**Considered and rejected:** Keeping an interval-gated sweep on this one path
because it is the widest payload the object sends. Width is not the argument —
if the socket is still open it is authorized, and if it is not it has already
been closed, so a second opinion here can only disagree with the queue.

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

### 2026-08-18 — Block sockets and optimistic ordering survive stale browser events

**What changed:** BlockDashboard socket ticket failures use the same stopped,
revoked, offline-aware reconnect gate as socket closes, and a redundant browser
`online` event leaves an already open or connecting socket alone. HyperSight
block drag cancellation restores the authoritative order, while keyboard and
drop reorders retain an optimistic configuration until the parent acknowledges
that exact order; live run updates merge into it meanwhile.

**Why:** A late ticket rejection could arm a reconnect after unmount, and an
`online` event could visually demote a healthy connection. Parent query pushes
can also carry the old block order while a save is in flight, which previously
made successful keyboard reorders appear to snap back.

**Considered and rejected:** Disabling live query updates during a save. Block
run checkpoints remain useful while configuration is pending, so only the
stale configuration fields are held optimistically.

**Consequences:** Connection state no longer glitches on redundant network
events, and block ordering changes remain stable without suppressing streamed
HyperSight results.

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

### 2026-08-18 — HyperSight sockets use the BlockDashboard protocol name

**What changed:** Block-agent ticket audiences, headers, event discriminators,
routes, desktop query keys, and hook names now use `block-dashboard`, backed by
`BlockDashboardAgent`. The rendered panel and all accessibility labels remain
HyperSight.

**Why:** The direct socket is an implementation boundary, not the product
surface. A single internal name makes route, binding, SQL, and replay telemetry
searchable as one subsystem.

**Considered and rejected:** Serving `/hypersight` aliases or accepting both
event vocabularies. No external client has shipped against this protocol, so
dual admission would add permanent ambiguity without a compatibility benefit.

**Consequences:** Desktop and Worker must deploy together for this unshipped
cutover. Product copy tests continue to assert HyperSight, while protocol tests
assert only BlockDashboard paths and event names.

### 2026-08-18 — Transcript history pages come from SubstreamAgent on demand

**What changed:** The feed socket now supports correlated before/after cursor
reads from object-local message authority. Electron's upward infinite scroll,
newer recovery, and jump-to-latest use those reads while preserving viewport
position.

**Why:** Once SubstreamAgent owns the message feed, fetching older pages through
a separate regional transport duplicates authorization and can race the live
snapshot. A room-sequenced page reply would be worse: one reader scrolling
would advance every reader's replay cursor.

**Considered and rejected:** Broadcasting page results, allocating a room
sequence per page, loading the whole transcript in the initial snapshot, and
polling REST while scrolling. They respectively leak viewer work, corrupt
resume semantics, exceed frame/memory bounds, or restore a split serving path.

**Consequences:** Pagination is request/reply, per-reader, reauthorized, capped
at 250 rows and 900 KB, and wakes only the target agent when a user asks for
history. The loading row/button remains as progress and retry UI; ordinary
scrolling starts the request automatically.

### 2026-08-18 — Compaction activity survives socket reconnect

**What changed:** SubstreamAgent feed events and snapshots now carry the active
Bind compaction run/attempt/index/trigger/start time. Electron renders that phase
directly and restores it after replay history is unavailable.

**Why:** A silent token interval is not a protocol. The user needs to
distinguish context summarization from slow inference, tools, and a disconnected
socket even after switching away and back.

**Considered and rejected:** Heuristics based on elapsed time and an in-memory
only event. Neither has a durable boundary, and both glitch on reconnect.

**Consequences:** Compaction lifecycle frames share the ordered SubstreamAgent
room sequence; only the matching run/attempt/index may finish the phase, and
terminal status is a defensive clear. HyperSight does not send the event because
its runs do not enable context compaction today.

### 2026-08-18 — Every agent socket streams and resumes from a durable checkpoint

**What changed:** Each visible HyperSight block now opens a purpose-scoped,
single-use, hibernating socket directly to its `BlockDashboardAgent`. The block
agent commits and emits the same active-stream checkpoint contract as
SubstreamAgent; WorkstreamDO continues to publish configuration/preferences but
no longer relays per-block run output.

**Why:** The block DO owns the complete loop, so routing token output through
WorkstreamDO created a second publication hop and could not resume an in-flight
answer from the execution owner's checkpoint. Direct block sockets make every
agent authority independently streamable and recoverable after eviction or UI
navigation.

**Considered and rejected:** Terminal-result-only block sockets, relaying block
tokens through WorkstreamDO, and polling. They respectively hide long progress,
load the control object, or cannot preserve smooth live output.

**Consequences:** This decision supersedes the earlier no-block-socket
consequence below. Electron opens block sockets only while the HyperSight panel
is visible, closes removed blocks, replaces from full checkpoints, and ignores
stale revisions. Idle accepted sockets hibernate; block socket tickets have a
fourth audience and their own SQL replay receipts. Committed block frames pass
through a caught serial publication queue that coalesces adjacent unsent
checkpoints, so delivery order is preserved and a viewer-side or authorization
dependency can neither fail the owned agent loop nor build an unbounded stream
backlog.

### 2026-08-18 — HyperSight converges on the WorkstreamDO socket

**What changed:** HyperSight configuration, per-block run status/results, and
viewer preference now arrive as WorkstreamDO control events. Individual
`BlockDashboardAgent` instances expose no desktop socket.

**Why:** A derived block is work-stream metadata, not an ordered conversation
feed. Adding a socket per block would multiply background connections and
duplicate authorization/reconnect state without improving token delivery.

**Considered and rejected:** Broadcasting block results from main
SubstreamAgent, opening a block-agent WebSocket, and REST polling. Those options
misplace publication authority, increase idle sockets, or add avoidable churn.

**Consequences:** The renderer applies block-result versions from the existing
work-stream control connection; the source feed remains limited to canonical
conversation data and active output.

### 2026-08-17 — Electron uses separate workspace, work-stream, and substream sockets

**What changed:** Each authenticated renderer now holds one persistent WorkspaceDO
synchronization/command socket, a complete-metadata WorkstreamDO socket for each
active/running work stream, and the direct SubstreamAgent transcript socket.
Each has a distinct ticket audience and SQL replay/receipt boundary.

**Why:** Workspace settings/directories, aggregate work-stream metadata, and a
high-volume ordered model feed have different authorities and lifecycles. The
previous per-message workspace socket could not keep settings or sibling clients
live, while putting metadata on token frames would couple navigation state to an
agent run.

**Considered and rejected:** One multiplexed workspace socket for all token
traffic, WorkstreamDO metadata inferred from the child feed, and periodic REST
polling. They respectively recreate a workspace throughput bottleneck, lose
model-free metadata updates, and spend resources while still adding sync delay.

**Consequences:** New workspace surfaces must map to a typed sync topic and new
WorkstreamDO fields must be included in its full snapshot. The renderer must
clear nullable snapshot fields, preserve the workspace version cursor across
reconnect, and keep child sockets only for selected or running work streams.

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

### 2026-08-17 — Admission follows the work-stream authority generation

**What changed:** Room admission now names the authority generation it must
reauthorize against, while ticket replay receipts and hibernating transport stay
local to the same object.

**Why:** After product authority moves, a frozen legacy participant row cannot
revoke a live reader. Workspace membership remains a D1 fact; work-stream
participation becomes an object fact.

**Considered and rejected:** Keeping D1 participant rows as an authorization
fallback, which would silently restore a second authority.

**Consequences:** Maintenance closes every existing room socket. Reconnect is
admitted only after the regional generation opens and the new authority answers.

### 2026-08-16 — Room ticket receipts move into named local SQL

**What changed:** The verified ticket JTI remains consumed by the one
work-stream room, but its replay receipt now lives on the `socket_ticket`
channel in `durable_inbox_receipts`. Existing `socket-ticket:<jti>` values are
imported in place and then deleted.

**Why:** The Durable Object was already SQLite-backed. A named receipt table
gives replay protection an inspectable key and retention query instead of an
unstructured hidden value, without moving the bearer ticket into the room.

**Considered and rejected:** Consuming the work-stream JTI in D1, which would
add a regional database write and contention point to every socket admission;
and passing the signed ticket through, which broadens credential exposure.

**Consequences:** Admission semantics and error codes are unchanged. Any new
room ticket path must use the SQL receipt operation and preserve the edge/room
split between signature verification and final authorization.

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
