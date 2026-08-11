# Realtime socket admission

Every Avalon WebSocket — the work-stream room the desktop keeps open, and the
dictation bridge to Azure — is opened with a short-lived ticket rather than the
session credential. This document owns how that ticket is issued, how it reaches
the Worker, and how a handshake is accepted or refused. What happens *on* an
open socket belongs elsewhere: the room's fan-out, replay, and presence are
`WorkstreamRoom`'s, and the dictation bridge's audio rules are in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

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
| `apps/api/src/routes/socket.ts` | The two upgrade routes. The query ticket is optional here; the service decides what was presented. |
| `apps/api/src/durable-objects/workstream-room.ts` | Answers the work-stream upgrade — or refuses it. Never sees a ticket. |
| `apps/desktop/src/renderer/lib/api.ts` | Parses a ticket response, strips the deprecated query ticket, and attaches the handshake subprotocols. |

## How it works

A client cannot authenticate a WebSocket handshake the way it authenticates a
request: a browser sets no headers on one, so `Authorization` is unavailable. So
admission is split in two.

1. **Issue.** The desktop calls `GET /workstreams/:id/socket` or
   `GET /realtime/transcription/socket` as an ordinary authenticated request.
   The Worker checks the caller may open that socket and mints a 60-second HS256
   JWT binding user, workspace, region, a one-time `jti`, and — for a room — the
   work stream. It answers with the handshake URL and the ticket.
2. **Present.** The client opens the socket with the ticket as the second
   `WebSocket` constructor argument: `[avalon.ticket.v1, <ticket>]`. The browser
   sends those as `Sec-WebSocket-Protocol`, the one request header it will carry
   on a handshake. A ticket is a compact JWS — base64url joined by dots — which
   is a legal subprotocol token, so it needs no encoding.
3. **Verify.** The Worker checks the `Upgrade` header and the exact `Origin`,
   reads the ticket off the offer, verifies the signature and the claims, and
   rejects a region or work-stream mismatch.
4. **Admit.** A room upgrade is forwarded to the Durable Object, which
   re-authorizes against the same visibility rule the REST reads use and
   atomically consumes the ticket id. Dictation consumes its `jti` in D1 and
   reserves a session lease before opening the Azure socket.
5. **Negotiate.** If the client offered the sentinel, the accepted 101 answers
   with it. Chromium fails a handshake whose subprotocol offer went unanswered,
   so the answer is required — and it is always the sentinel, never the ticket.

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
- **The room never receives the ticket.** It is verified at the edge and
  stripped from the subrequest; the room authorizes from the identity headers.
- **Origin is checked before the ticket is read.** An exact match against
  `ALLOWED_ORIGINS`, so a lookalike host cannot spend a ticket.
- **A ticket is single-use.** The room and the dictation bridge each consume the
  `jti` atomically; a replay is refused rather than opening a second socket.

## Boundary

This module owns admission: issuing a ticket, presenting it, verifying it, and
answering the handshake. It exposes the four transport helpers in
`@avalon/contracts/socket-tickets` to both the Worker and the renderer, and
`issueSocketTicket` / `verifySocketTicket` to the services that need them.

It does not own what happens next. Room subscription, event replay, presence,
and the `resync_required` contract are `WorkstreamRoom`'s, described in
[`ARCHITECTURE.md`](ARCHITECTURE.md); the reconnect and heartbeat behavior of
the client is in [`RUNBOOK.md`](RUNBOOK.md); dictation's audio limits and Azure
contract are in [`ARCHITECTURE.md`](ARCHITECTURE.md). It depends on
`SESSION_SIGNING_KEY`, `ALLOWED_ORIGINS`, and the regional Durable Object
namespace helper.

## Failure modes and limits

- **No ticket presented** — 401 `socket_ticket_required`, before any room call.
- **Malformed subprotocol offer** — 401, without consulting the query.
- **A non-sentinel offer** (`graphql-ws`, say) — nothing is read out of it; 401.
- **Bad signature, wrong audience, expired** — 401 `invalid_socket_ticket`. The
  ticket lives 60 seconds; a client that stalls between issue and open must ask
  for another.
- **Wrong region or work stream** — 403 `socket_ticket_scope_mismatch`.
- **Disallowed origin** — 403 `socket_origin_forbidden`.
- **Room refusal** — the room's own JSON status reaches the client unchanged:
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
the provider's redirect and cannot move; [`SECURITY.md`](SECURITY.md) records
what that leaves exposed.

## Changelog

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
