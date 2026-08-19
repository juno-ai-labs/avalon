# Realtime socket admission

Every Avalon WebSocket — workspace synchronization/commands, work-stream
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
| `apps/api/src/services/realtime-transcription-service.ts` | The dictation ticket, its D1 replay receipt and session lease, and the Azure upgrade. |
| `apps/api/src/routes/socket.ts` | Workspace, work-stream-control, substream-feed, HyperSight-block, and dictation upgrade routes. The query ticket is optional here; the service decides what was presented. |
| `apps/api/src/durable-objects/workspace-do.ts` | Accepts the persistent workspace synchronization/command socket, serves authoritative cursor-paged work-stream rows, persists a bounded replay log, and consumes its purpose-specific ticket in SQL. |
| `apps/api/src/durable-objects/workstream-do.ts` | Accepts the per-work-stream aggregate metadata socket and returns complete viewer-specific snapshots. |
| `apps/api/src/durable-objects/block-dashboard-agent.ts` | Accepts one hibernating socket per visible configured block and returns its durable run plus active-output checkpoint. |
| `apps/api/src/durable-objects/substream-agent.ts` | Accepts the direct read/stream/download feed and consumes its distinct ticket in SQL. It rejects user message commands. |
| `apps/desktop/src/renderer/lib/workspace-socket.tsx` | Keeps the workspace socket alive across navigation, correlates/retries directory-page requests, resumes its waterline, applies current work-stream rows, invalidates workspace query surfaces, and resends idempotent message commands after reconnect. |
| `apps/desktop/src/renderer/lib/use-workstreams-query.ts` | Builds the sidebar's infinite query exclusively from WorkspaceDO socket pages and retains the last page while a reconnect retries its request. |
| `apps/desktop/src/renderer/lib/use-workstream-control-socket.ts` | Applies complete waterlined WorkstreamDO metadata snapshots to detail and sidebar caches. |
| `apps/desktop/src/renderer/lib/workstream-state-store.ts` | Shared common/viewer and WorkspaceDO-directory waterline ledgers used by both parent sockets; independently rejects stale state fields and older pin/page fields. |
| `apps/desktop/src/renderer/lib/use-block-dashboard-sockets.ts` | Opens block sockets only while HyperSight is visible, applies full stream checkpoints, rejects stale revisions, and reconnects without duplicate text. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Keeps the selected/running SubstreamAgent feed and invokes the separate WorkstreamDO control lifecycle. |
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
   and the current regional session ID.
2. **Present.** The client opens the socket with the ticket as the second
   `WebSocket` constructor argument: `[avalon.ticket.v1, <ticket>]`. The browser
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
   rechecks the current D1 session and membership. Neither object receives the
   signed bearer ticket.
   A HyperSight upgrade reaches the exact block agent after the edge verifies
   D1 membership and WorkstreamDO authorizes the block/viewer pair. The block
   consumes its own ticket receipt and persists only the bounded authorization
   timestamp in the hibernation attachment.
   Dictation consumes its `jti` in D1 and reserves a session lease before
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
configured block. Switching away from an idle work stream closes its
work-stream-scoped sockets; background-running conversation streams keep their
metadata/feed sockets, while block sockets close with the panel and recover
from durable checkpoints when it is opened again.

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
| `automations` | Automation definitions, drafts, subscriptions, pause/archive status, trigger schedules, next/last runs, and work-stream-producing changes. |
| `notes` | Workspace/personal note directory, recording/import state, and note detail invalidation. |
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
REST/D1 list endpoint to reconstruct them. The renderer applies WorkspaceDO-owned
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

Authorization is not on that high-frequency path. A block socket attachment
caches its successful session/user decision for at most 60 seconds, then the
agent groups live sockets by session and viewer for revalidation. WorkstreamDO
also commands immediate block-socket sweeps when a block is removed, hidden, or
its product visibility changes. Thus every checkpoint broadcast remains local
to the execution owner, while revocation is bounded even if the explicit sweep
is delayed.

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
compaction activity, presence, replay cursors, and resync/download. A
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
  request header to a response header and undo the change.
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

## Boundary

This module owns admission: issuing a purpose-specific ticket, presenting it,
verifying it, and answering the handshake. It exposes the transport helpers in
`@avalon/contracts/socket-tickets` to both the Worker and the renderer, and
`issueSocketTicket` / `verifySocketTicket` to the services that need them.

It does not own what happens next. Workspace command authorization/routing and
child subscription, event replay, presence, and `resync_required` are described in
[`architecture.md`](architecture.md); the reconnect and heartbeat behavior of
the client is in [`runbook.md`](runbook.md); dictation's audio limits and Azure
contract are in [`architecture.md`](architecture.md). It depends on
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
| `packages/contracts/src/socket-tickets.test.ts` | `pnpm --filter @avalon/contracts test` | The wire format: offers, parsing, refusal of non-tickets, URL stripping. |
| `apps/api/test/socket-ticket-transport.test.ts` | `pnpm --filter @avalon/api test` | Precedence and the negotiation decision, on Node. |
| `apps/api/test-workers/socket-subprotocol-runtime.test.ts` | `pnpm --filter @avalon/api exec vitest run --config vitest.workers.config.ts` | The runtime constraint, on real workerd. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | `pnpm --filter @avalon/api exec vitest run --config vitest.workers.config.ts` | Hibernating WorkspaceDO, WorkstreamDO, SubstreamAgent, and BlockDashboardAgent attachments/snapshots; authoritative workspace directory application/page/resource queries; eviction; native-RPC envelopes; bidirectional transcript pagination and revocation; compaction recovery; block checkpoint recovery/revocation; queued-run coalescing; ticket replay; and read-only feeds on real workerd. |
| `apps/desktop/src/renderer/lib/workspace-socket.test.tsx`, `use-workstreams-query.test.tsx`, `workstream-state-store.test.ts` | `pnpm --filter @avalon/desktop test` | One persistent workspace connection, correlated directory pages/pagination, immediate offline page rejection, waterline resume, stale/duplicate rejection across both sockets, independent common/viewer ordering, and idempotent command resend. |
| `apps/desktop/src/renderer/lib/use-workstream-control-socket.test.tsx` | `pnpm --filter @avalon/desktop test` | Complete aggregate snapshots, stale waterline rejection, nullable-field clearing, revocation, and reconnect. |
| `apps/desktop/src/renderer/lib/use-block-dashboard-sockets.test.tsx` | `pnpm --filter @avalon/desktop test` | Full-checkpoint replacement without duplicated text, stale revision rejection, ticket and short-lived-socket reconnect backoff, permanent stop on `1008`, offline/online recovery, removed-block closure, and ping/pong timeout. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.test.tsx`, `apps/desktop/src/renderer/screens/workstream.test.tsx` | `pnpm --filter @avalon/desktop test` | Direct SubstreamAgent feed reconnect/resync, streaming, switching streams, explicit compaction lifecycle/reconciliation, page merging, direction-neutral errors, scroll thresholds/anchor preservation, and workspace-command routing. |
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
Avalon's. `request-context.ts` logs `pathname` only and `redact` scrubs by key,
but the platform records the whole request independently — the invocation log's
`$workers.event.request.url`, the Logpush export's `Event`, and a trace span's
`url.full` and `url.query`. Nothing in this repository can reach those. The
`Sec-WebSocket-Protocol` header is not captured, which is the whole point.

The sentinel is public and carries no authority. The other query-string
credential on this surface — a connector OAuth callback's `?code=` — is fixed by
the provider's redirect and cannot move; [`security.md`](security.md) records
what that leaves exposed.

## Changelog

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
to mirror the example. Avalon already enumerates `getWebSockets()` and validates
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
`Sec-WebSocket-Protocol: avalon.ticket.v1, <ticket>` instead of `?ticket=`. The
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
