# Realtime socket admission

Every Avalon WebSocket — the workspace command socket, direct substream feed,
and dictation bridge to Azure — is opened with a short-lived ticket rather than
the session credential. This document owns how a purpose-specific ticket is
issued, how it reaches the Worker, and how a handshake is accepted or refused.
What happens *on* an open socket belongs elsewhere: workspace command routing
is `WorkspaceDO`'s, feed fan-out/replay/presence is `SubstreamAgent`'s, and the
dictation bridge's audio rules are in
[`architecture.md`](architecture.md).

The promise it makes is narrow and worth stating plainly: a socket is opened
only by someone who just proved, over an authenticated HTTP request, that they
may open that exact socket — and proving it leaves no credential anywhere a URL
is recorded.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/socket-tickets.ts` | The transport: the subprotocol sentinel, the deprecated query parameter, and the four helpers both sides share. The single source of the wire format. |
| `apps/api/src/services/socket-service.ts` | Issues and verifies both ticket kinds, reads the presented ticket off a handshake, negotiates the response subprotocol, and admits a work-stream upgrade. |
| `apps/api/src/services/realtime-transcription-service.ts` | The dictation ticket, its D1 replay receipt and session lease, and the Azure upgrade. |
| `apps/api/src/routes/socket.ts` | Workspace-command, substream-feed, and dictation upgrade routes. The query ticket is optional here; the service decides what was presented. |
| `apps/api/src/durable-objects/workspace-do.ts` | Accepts the hibernating user-command socket and consumes its purpose-specific ticket in SQL. |
| `apps/api/src/durable-objects/substream-agent.ts` | Accepts the direct read/stream/download feed and consumes its distinct ticket in SQL. It rejects user message commands. |
| `apps/desktop/src/renderer/lib/api.ts` | Parses a ticket response, strips the deprecated query ticket, and attaches the handshake subprotocols. |

## How it works

A client cannot authenticate a WebSocket handshake the way it authenticates a
request: a browser sets no headers on one, so `Authorization` is unavailable. So
admission is split in two.

1. **Issue.** The desktop calls
   `GET /workstreams/:id/substreams/:substreamId/socket` for the feed,
   `GET /workstreams/:id/substreams/:substreamId/workspace-socket` for commands,
   or `GET /realtime/transcription/socket`. The Worker checks the caller may
   open that exact purpose and mints a 60-second HS256 JWT binding user,
   workspace, region, one-time `jti`, audience, target work stream/substream,
   and current regional session ID where later commands need it.
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
   command upgrade reaches the workspace's `WorkspaceDO`, which consumes a
   separate audience ticket and serializes the verified session/route identity;
   every later command rechecks the current D1 session and membership before
   routing to the child. Neither object receives the signed bearer ticket.
   Dictation consumes its `jti` in D1 and reserves a session lease before
   opening Azure.
5. **Negotiate.** If the client offered the sentinel, the accepted 101 answers
   with it. Chromium fails a handshake whose subprotocol offer went unanswered,
   so the answer is required — and it is always the sentinel, never the ticket.

### Hibernation lifecycle

The workspace and substream objects follow Cloudflare's [WebSocket Hibernation
server pattern](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/):

- The edge Worker validates the method, route, `Upgrade`, origin, ticket, and
  target before invoking a Durable Object, avoiding object requests for invalid
  handshakes.
- The object calls `state.acceptWebSocket(server, tags)` rather than
  `server.accept()`, then immediately calls `server.serializeAttachment(...)`.
  Acceptance must precede attachment so the socket is registered with the
  hibernation API before recoverable connection state is associated with it.
- Neither object relies on an in-memory session map. Event handlers enumerate
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

### The deprecated query transport

The issuing endpoints still return a URL containing `?ticket=`, and both upgrade
paths still accept it, because a desktop build released before the subprotocol
scheme reads exactly that field. The header wins when both are present. The
renderer strips the query at the point it parses a ticket, so no current client
sends one.

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
- **Neither Durable Object receives the signed bearer ticket.** It is verified
  at the edge and stripped from the subrequest. The feed child consumes the JTI
  in `durable_inbox_receipts`; the workspace command object consumes it in
  `socket_ticket_receipts`. Workspace membership remains in D1 while personal
  participation/revocation is owned by the selected child.
- **Ticket audiences are not interchangeable.** A feed ticket cannot open the
  command socket, and a command ticket cannot open a child feed. Otherwise a
  read credential becomes a write credential.
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
- **Wrong audience, region, work stream, or substream** — 403 `socket_ticket_scope_mismatch`.
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

## Testing

| Suite | Command | Covers |
| --- | --- | --- |
| `packages/contracts/src/socket-tickets.test.ts` | `pnpm --filter @avalon/contracts test` | The wire format: offers, parsing, refusal of non-tickets, URL stripping. |
| `apps/api/test/socket-ticket-transport.test.ts` | `pnpm --filter @avalon/api test` | Precedence and the negotiation decision, on Node. |
| `apps/api/test-workers/socket-subprotocol-runtime.test.ts` | `pnpm --filter @avalon/api exec vitest run --config vitest.workers.config.ts` | The runtime constraint, on real workerd. |
| `apps/api/test-workers/durable-object-runtime.test.ts` | `pnpm --filter @avalon/api exec vitest run --config vitest.workers.config.ts` | Hibernating workspace-command attachments, eviction, ticket replay, and read-only child feeds on real workerd. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.test.tsx` | `pnpm --filter @avalon/desktop test` | Separate lazy command/feed connections, reconnect, resync, and switching streams. |
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
