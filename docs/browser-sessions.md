# Browser sessions

The lite browser uses an opaque cookie to address the ordinary session ledger.
It does not receive desktop access or refresh tokens. The [browser host](browser-client.md) forwards same-origin requests to this
regional authentication boundary. The browser mounts the shared collaboration UI
and uses the existing ticketed conversation sockets.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/migrations/0112_browser_sessions.sql` | Cookie credential index and per-workspace session mappings. |
| `apps/api/src/services/browser-session-service.ts` | Registration (which claims shares waiting for the user's verified addresses), explicit workspace selection, renewal, metadata and logout. |
| `apps/api/src/services/session-authentication.ts` | Shared ordinary-session, membership-incarnation and region checks. |
| `apps/api/src/routes/browser.ts` | HttpOnly cookies, Origin checks and the cookie-to-API adapter. |
| `apps/api/test/browser-sessions.test.ts` | Real migrated SQLite and HTTP protocol cases. |

## How it works

`POST /browser/email/start` uses the existing email challenge and delivery
service. `POST /browser/email/redeem` consumes a proof, resumes its identity-only
session, and sets `__Host-rally-browser-<region>`. The cookie is host-only,
Secure, HttpOnly, SameSite=Lax and has Path=/; its expiry comes from the ordinary
session row. Explicit HTTP development origins use a non-prefixed development
cookie without Secure. Production requires HTTPS.

Registering a session, which every browser sign-in and cross-deployment
activation does, claims any [scoped invitation](scope-invitations.md#claiming)
waiting for the user's verified addresses before the session is described, so
the Organizations it lists already include any the claim joined. A claim that
fails is logged and never fails the sign-in.

The cookie is derived with a purpose-bound HMAC from the identity session's
credential. Only its hash is stored. Retrying the same email redemption recovers
the same cookie rather than breaking another tab or storing readable secrets.
JSON responses contain user, workspace and expiry metadata only. Link GETs
return 405; they do not consume email proofs.

`POST /browser/workspace/select` establishes or reuses a normal workspace
session. `browser_workspace_sessions` maps `(browser session, workspace)` to its
session ID. Concurrent selections use a conditional write and revoke an unused
loser's session. There is no mutable active-workspace field. Selecting workspace
A leaves a tab using B unchanged. Child expiry cannot exceed the identity
session's expiry.

`POST /browser/workspace/create` creates an organization; see
[browser client](browser-client.md#creating-an-organization).

`GET /browser/session` describes identity; `GET /browser/workspaces` lists its
current regional relationships. `POST /browser/session/renew` applies the
ordinary session renewal window, absolute lifetime ceiling, and eligibility
predicate through `AuthService`’s shared `sessionRenewalPolicy`, without token
rotation races in JavaScript. It renews only still-live workspace sessions with
current membership incarnations. It cannot revive an expired or revoked session.
`POST /browser/logout` revokes identity first, then each mapped workspace session
through ordinary logout and its socket-revocation publication, and clears the
cookie.

`/browser/api/<workspace ID>/<product path>` adapts the cookie to the ordinary
API. `_` selects the identity-only session, for a request that is about no
workspace yet. The cookie resolver validates the root binding and chooses the target session.
A request-local bearer is minted internally; ordinary API middleware authenticates
that target once using the same checks as desktop. It is never returned to JavaScript. The
adapter strips cookies and development identity headers from the forwarded
request and overwrites caller-supplied Authorization. Only named product route
families are forwarded, the ones the Canvases and Sidekicks shell calls
(`BROWSER_ROUTE_FAMILIES`, listed in [`browser-client.md`](browser-client.md));
authentication/token issuance, internal operations, onboarding routes and the
retired Thread, Channel and Space families are excluded. Existing product authorization still decides
which scopes the caller may read or mutate. Message-issue submissions use this
same adapter; [message issues](message-issues.md) owns their access and storage.

## Invariants

- A cookie authenticates a user; it does not grant workspace or conversation
  access. Every workspace request checks the ordinary session's immutable
  membership incarnation and current relationship.
- Promotion retains the mapped session. Removal/rejoin makes it unusable until
  explicit workspace selection establishes a fresh binding.
- Mutations require an exact configured browser Origin and reject cross-site
  Fetch Metadata. A bearer supplied alongside a cookie cannot choose the actor.
- Browser responses are no-store. Credentials never enter URLs or JSON bootstraps.
- The cookie transport is confined to `/browser`; ordinary API endpoints do not
  silently begin accepting cookies without the Origin gate.
- Workspace IDs belong in request addresses, never shared mutable tab state.

## Boundary

D1 owns the credential index and session relationships. Product Durable Objects
retain all scope authority. The browser host must expose this boundary on its
own origin through explicit regional routing; it must not rely on third-party
cookies or accept arbitrary API hosts. This adapter forwards HTTP business
requests, not WebSocket frames. The browser host forwards the existing purpose-bound ticket upgrades through its
regional service binding, stripping cookies and Authorization from that path.
The shared product API client supports cookie sessions without bearer renewal;
the browser mounts only the selected conversation feed, plus one workspace
socket it reads only for membership nudges, and does not install the desktop
background socket swarm.

## Failure modes and limits

Missing/invalid browser-origin configuration refuses the transport. Session
renewal reuses the team's existing 30-day inactivity window and 90-day absolute
ceiling; this module introduces no new expiry numbers. Lost email responses are
recoverable using the same redemption operation. A workspace activation racing
logout cannot authenticate through the revoked root, even if it already created
a workspace session. Socket revocation uses the existing logout delivery path
and inherits its documented publication-failure behavior.

## Signup observations

Signup uses the opaque first-account flow and stage contract in [complete signup measurement](telemetry.md#complete-signup-measurement).

## Testing

Run `pnpm --filter @rally/api exec vitest run test/browser-sessions.test.ts`.
The suite applies real migrations and exercises email redemption, cookie flags,
CSRF rejection, two-tab selection and racing activations, the ordinary API
adapter, promotion, rejoin fencing, renewal ceilings and whole-browser logout.
It is backend protocol evidence, not proof of browser rendering or end-to-end
collaboration.

`pnpm --filter @rally/api test:workers test-workers/browser-sessions.test.ts`
additionally proves concurrent activation and cross-tab incarnation isolation
against real D1 in workerd. Its minimal schema declares the runtime dependencies;
the Node suite separately applies the checked-in migrations.

## Changelog

### 2026-11-07 — Only the Canvases and Sidekicks shell's route families cross

**What changed:** The adapter forwards `canvases` and stops forwarding
`workstreams`, `spaces`, `projects`, `navigation` and `work-opportunities`.

**Why:** The pivot to Canvases and Sidekicks ([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md), plan step
B-5) deleted every browser surface that called the Thread families, and the
Canvas routes had never been added, so a browser could not open a Canvas.

**Consequences:** What a cookie reaches is exactly what the shell calls; a new
family is added with the surface that calls it.

Shipped in juno-ai-labs/avalon#1490.

### 2026-10-07 — Create an organization over the cookie

**What changed.** `POST /browser/workspace/create` creates an organization on
Global through the desktop's create path, revokes the bearer session that path
returns, and answers only the new organization's region and id. The browser then
selects it with `/workspace/select`.

**Why.** A signed-in browser with nothing shared had no way to start an
organization. The desktop route answers with a bearer session, which this
adapter exists to keep out of JavaScript.

**Considered and rejected.** Forwarding `onboarding/workspace` through the
adapter, which would hand JavaScript a bearer; and a bridge method that mints a
cookie in the target deployment, as activation does, which creation on Global
does not need.

**Consequences.** Every create mints one bearer session and revokes it at once.
A future route that wraps a bearer-issuing path must do the same: nothing it
returns may carry a credential. Creation outside Global answers 409
`global_identity_required`. [`browser-client.md`](browser-client.md) has the
client side.

PR: [#1129](https://github.com/juno-ai-labs/avalon/pull/1129).

### 2026-10-06 — Claim shares when a browser session is registered

**What changed.** `BrowserSessionService.register` claims every scoped share
waiting for the user's verified addresses before describing the session.

**Why.** Sharing dropped its acceptance step: signing in with the shared-with
address is the whole of joining, and every browser sign-in passes through
registration, so it is the one place that sees them all.

**Considered and rejected.** Claiming on workspace selection would have missed
the organization list a fresh sign-in shows, and needed the person to already
know where to go.

**Consequences.** Registration does a D1 read of the user's verified addresses
and lookup rows on every sign-in, and a Durable Object call per Channel holding
a pending share. Its failures are swallowed by design; watch
`scope_invitation_claim_lookup_failed` and `scope_invitation_claim_failed`.

PR: [#1120](https://github.com/juno-ai-labs/avalon/pull/1120).

### 2026-09-17 — Reuse ordinary sessions behind a browser cookie

**What changed:** Added an opaque browser credential and workspace-specific
session mappings over the existing identity/session ledger. Browser and bearer
renewal share one SQL policy so expiry, region, and membership eligibility cannot
drift between transports.

**Why:** The lite client needs quick email entry without exposing durable
credentials to JavaScript, and two browser tabs must not change each other's
workspace authority.

**Considered and rejected:** A single active-workspace cookie would mix tab
state; one credential cookie per workspace would grow every request's cookie
header. A separate browser user or permission store would duplicate authority.

**Consequences:** Keep workspace selection explicit, reuse ordinary session
incarnation checks, and preserve the same-origin/Origin boundary when the web
host is connected. The frontend and socket host integration remain unfinished.
