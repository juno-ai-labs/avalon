# Rally MCP server

Rally's MCP server lets a person connect Claude, ChatGPT or any other MCP
client to Rally and work with their Canvases from there: find them, create
them, ask Rally to make or change their artifacts, read their Chats, change
who can open them, share them with guests, and keep them tidy. It runs at
`https://mcp.rallywith.ai/mcp` and is the product's own surface for its users,
unlike the [engineering MCP](engineering-mcp.md), which is an operator tool
behind Cloudflare Access.

A connection is an **ordinary Rally workspace session** that the MCP client
holds. Every tool calls the same product route the app calls, with that
session, so the person's role in the Organization and each Canvas's audience
decide exactly as they do in the app. Nothing here is a second permission
system.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/mcp/src/index.ts` | The Worker: OAuth metadata (RFC 9728, RFC 8414), forwarding `/register`, `/token` and `/revoke` to the identity API, the 401 challenge, and the Streamable HTTP MCP endpoint. |
| `apps/mcp/src/api.ts` | `inspectBearer` (the unverified read of a token's audience, expiry and region), `regionalApi` (the service binding for a region) and `RallyApi`, the product API as the connected person. |
| `apps/mcp/src/server.ts` | The tools and the server's instructions. |
| `packages/contracts/src/mcp-oauth.ts` | The OAuth vocabulary: registration, the authorization request, approval, token request and response, the redirect allowlist (`isAllowedMcpRedirectUri`) and the one scope. |
| `apps/api/src/services/mcp-oauth-service.ts` | `McpOAuthService`: registration, consent description, approval and denial, the code exchange, refresh and revocation. |
| `apps/api/src/routes/mcp-oauth.ts` | `/mcp-oauth/register`, `/mcp-oauth/token`, `/mcp-oauth/revoke`, answering OAuth's error shape. |
| `apps/api/src/routes/browser.ts` | `/browser/oauth/authorization`, `/browser/oauth/approve`, `/browser/oauth/deny`: the consent half, behind the browser cookie and its Origin check. |
| `apps/api/src/services/auth-service.ts` | `AccessTokenAudience`, `createMcpSession`, and `refresh`'s separation of desktop and MCP sessions. |
| `apps/api/src/middleware/auth.ts` | `MCP_ROUTE_FAMILIES`: the routes an MCP token reaches. |
| `apps/browser/src/mcp-consent.tsx` | The consent page at `/app/oauth/authorize`. |
| `packages/db/migrations/0126_mcp_oauth.sql` | `mcp_oauth_clients`, `mcp_oauth_codes`, `mcp_oauth_grants`. |
| `plugins/rally/`, `.claude-plugin/marketplace.json` | The Claude Code plugin (the server and a Canvases skill) and the marketplace that lists it. |

## How it works

### Connecting

1. The client calls `/mcp` with no token. The Worker answers 401 with
   `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`.
2. The client reads the resource metadata, then the authorization server's at
   `/.well-known/oauth-authorization-server`. The issuer is the MCP host; the
   authorization endpoint is the browser app's `/app/oauth/authorize`; the
   token, registration and revocation endpoints are the MCP host's.
3. The client registers itself (`POST /register`, RFC 7591). Every client is
   public and proves possession with S256 PKCE; a registration's redirect URIs
   must each be a loopback address (any port) or under an exact hosted origin:
   `https://claude.ai`, `https://claude.com`, `https://chatgpt.com`.
4. The person's browser opens the consent page with the authorization request
   in its query.
5. They approve, the page receives the client's redirect with a single-use
   code, and the client exchanges it at `POST /token` with its verifier.

### Consent

The page is the ordinary browser entry until the person is signed in. Sign-in
returns to `/app/` paths but drops the query, so the page keeps the request in
`localStorage` and reads it back; it holds only what was already in the URL.
Signed in, it asks the API to describe the request
(`GET /browser/oauth/authorization`), which refuses an unregistered client or
a redirect the client did not register, and shows the client's name, the
origin it will return to, and the person's Organizations in the identity
deployment. **Allow** posts `/browser/oauth/approve` with the chosen
Organization; the API checks the person belongs to it and writes a code row.
**Deny** posts `/browser/oauth/deny` and returns `access_denied`. Both answer
the URL to go to; the page navigates there.

### Tokens

The code exchange consumes the code in the statement that reads it, checks
the client, the redirect and the verifier, and calls
`AuthService.createMcpSession`, which writes the session and its
`mcp_oauth_grants` row in one batch. The response's `access_token` is a Rally
access token with the `rally-mcp` audience and the access lifetime the
desktop's has; its `refresh_token` is the session's.

An MCP token reaches only `MCP_ROUTE_FAMILIES`: `/canvases`, `/conversations`,
`/sharing`, `/resources`, `/workspace` and `/workspace/members`. Any other
route answers 403 `mcp_route_unavailable`. Every other verifier
(`verifyAccessToken`) still accepts only the desktop audience, so an MCP
token cannot log out, refresh, onboard or reach the browser adapter.

Refresh runs through `AuthService.refresh` with the client's id: it renews
only a session that client holds, and the desktop's `/auth/refresh` renews
only a session no MCP client holds. The rotation, the renewal window and the
lifetime ceiling are the ordinary session's. Revocation (RFC 7009) ends the
session behind a refresh or access token the client holds through ordinary
logout, which closes its sockets; any other token is ignored and answered 200.

The Worker does not hold the signing key. Before any tool runs it reads the
bearer's claims without verifying them and answers 401 itself for a token
whose audience is not `rally-mcp`, which has expired, or which names no
configured region, so the client refreshes or reconnects. The API verifies the
signature and the session on every call. A session revoked while its access
token is still within its lifetime reaches the tools, and each tool answers
the API's 401 with a message to reconnect.

### Tools

| Tool | Route |
| --- | --- |
| `list_canvases` | `GET /canvases`, filtered here by title |
| `get_canvas` | `GET /canvases/:id` |
| `read_canvas_chat` | `GET /conversations/:id/text`, refusing a Sidekick's conversation |
| `list_people` | `GET /workspace/members` |
| `read_artifact` | `GET /resources/:id/versions/:version/model-content` |
| `create_canvas` | `POST /canvases`, the operation id as the Canvas id and the prompt's `clientMessageId` |
| `send_canvas_message` | `POST /conversations/:id/substreams/0/messages` |
| `update_canvas` | `PATCH /canvases/:id` |
| `set_canvas_audience` | `POST /canvases/:id/audience` |
| `invite_canvas_guests` | `GET /workspace`, then `POST /sharing` |
| `decide_canvas_access_request` | `POST /canvases/:id/access-requests/:userId/decision` |
| `pin_canvas` | `POST /canvases/:id/pin` |
| `rename_artifact` | `PATCH /conversations/:id/resources/:resourceId` |

`GET /canvases` and `GET /conversations/:id/text` were added for this server:
the app reads the list over its workspace socket and the transcript as blocks.
The list is `canvasSidebarRows`, the read the sidebar socket sends
(`WorkspaceDO.canvasListFor`); the text is `ConversationService.readText`,
which the engineering MCP's Chat reads share.

The server's initialization instructions tell the model that Rally, the agent
in the Canvas, does the work: a change to an artifact is a message to the
Chat, followed by reading the Chat.

## Invariants

- **A grant is an ordinary session.** Membership, incarnation, suspension,
  renewal and logout all apply to it unchanged; a second credential type would
  have to re-implement each and would drift. Guard: the refresh and revoke
  cases in `apps/api/test/mcp-oauth.test.ts`.
- **An MCP token reaches only `MCP_ROUTE_FAMILIES`.** A token held by a hosted
  client that reached account, token or settings routes could sign the person
  up for things or mint other sessions. Guard: the 403 case in
  `apps/api/test/mcp-oauth.test.ts`.
- **Desktop and MCP refresh never cross.** If the desktop refresh renewed an
  MCP session it would answer a desktop-audience token and escape the route
  boundary; the reverse lets a client adopt a desktop session. Guard: the
  refresh case in `apps/api/test/mcp-oauth.test.ts`.
- **A redirect is followed only if the client registered it and it is on the
  allowlist.** Otherwise the consent page becomes a way to send a person's
  code to anyone. Guard: the registration case in
  `apps/api/test/mcp-oauth.test.ts`.
- **A code is used once, by its client, with its verifier.** Guard: the replay
  and verifier cases in `apps/api/test/mcp-oauth.test.ts`.
- **Every tool is a product route.** A tool that wrote storage itself would
  skip the audience and role checks. Guard: review; each tool in
  `apps/mcp/src/server.ts` calls `RallyApi`.

## Boundary

This module owns the MCP client's authorization and the tools. It does not
own who may open or manage a Canvas ([`canvases.md`](canvases.md),
[`authorization.md`](authorization.md)), sessions themselves
([`security.md`](security.md)), the cookie transport
([`browser-sessions.md`](browser-sessions.md)), or what Rally does with a
message. Sidekicks have no tools here.

## Failure modes and limits

- **Codes live 10 minutes**, RFC 6749 §4.1.2's recommended maximum.
- **Access tokens and sessions** use the desktop's lifetimes: the access
  lifetime, the 30-day renewal window and the 90-day ceiling.
- **Request bodies** to `/mcp-oauth/*` and the consent posts are capped by the
  existing `authBodyLimit` (4 KiB).
- **Registration is open** and unauthenticated, as RFC 7591 dynamic
  registration is for public clients. No rate limit or row cap exists; a
  `mcp_oauth_clients` table that grows without use is the signal to add one.
- **One deployment.** A grant is a session in the identity deployment, so the
  consent page lists only its Organizations. Another region needs a consent
  hop to that region before it can be offered.
- **The list** is the sidebar's, capped at `SIDEBAR_LIST_LIMIT`.
- **A revoked session** keeps passing the Worker's unverified check until its
  access token expires; each tool then reports the API's 401.
- There is no tool to delete a Canvas or remove an artifact: the app has no
  route for the first, and the second's effect on a Canvas's generated
  artifacts is not settled.

## Testing

- `pnpm --filter @rally/api exec vitest run test/mcp-oauth.test.ts`:
  registration, consent through a real email sign-in, the PKCE exchange, the
  route boundary, refresh in both directions and revocation, over the real
  migrations.
- `pnpm --filter @rally/mcp test`: the challenge, the metadata, token
  forwarding and the tools, with a double for the API's service binding only.
- `claude plugin validate ./plugins/rally` and `claude plugin validate .`
  check the plugin and the marketplace.

## Security and trust model

The MCP client is trusted with what the person approved: their permissions in
one Organization, through the routes above. The consent page names the client
by the name it registered, which it chose, so the page also shows the origin
it returns to, which the allowlist pins to Claude, ChatGPT or the person's own
machine.

## Operations

`deploy-api.yml` deploys this Worker after the Global API, since its token
endpoint forwards there. To connect a client:

- **Claude Code:** `/plugin marketplace add juno-ai-labs/avalon`, then
  `/plugin install rally@rally`. The repository is private, so this works only
  for people with access to it; a public marketplace repository is the step
  before customers can install it this way.
- **Claude.ai and Claude Desktop:** add a custom connector with the server URL.
- **ChatGPT:** in developer mode, add an app with the server URL and OAuth.

## Changelog

### 2026-11-09 — Rally's MCP server for its users

**What changed.** A new Worker at `mcp.rallywith.ai` with thirteen Canvas
tools, an OAuth 2.1 authorization server split between the identity API and
the browser app's consent page, a `rally-mcp` token audience confined to the
Canvas routes, `GET /canvases` and `GET /conversations/:id/text`, and a Claude
Code plugin.

**Why.** People asked to work with Canvases from Claude and ChatGPT, which
reach tools only over MCP with OAuth. A grant is an ordinary session rather
than a token store of its own (Cloudflare's OAuth provider library was the
alternative) so every rule that ends or narrows a session ends or narrows a
grant without a second implementation. A future change must keep MCP and
desktop refresh apart and keep `MCP_ROUTE_FAMILIES` to the routes the tools
call.
