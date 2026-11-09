# Rally MCP server

Rally's MCP server lets a person connect Claude, ChatGPT, OpenCode or any
other MCP client to Rally and work with their Canvases from there: find them,
create them, ask Rally to make or change their artifacts, publish artifacts
they already made in that tool into a Canvas, read their Chats, change who
can open them, share them with guests, and keep them tidy. It runs at
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
| `apps/mcp/src/server.ts` | The tools, resources, prompts and the server's instructions. |
| `apps/mcp/src/skills.ts` | The skills catalog, served from the plugin's own `SKILL.md` files. |
| `packages/contracts/src/mcp-oauth.ts` | The OAuth vocabulary: registration, the authorization request, approval, token request and response, the redirect allowlist (`isAllowedMcpRedirectUri`) and the one scope. |
| `apps/api/src/services/mcp-oauth-service.ts` | `McpOAuthService`: registration, consent description, approval and denial, the code exchange, refresh and revocation. |
| `apps/api/src/routes/mcp-oauth.ts` | `/mcp-oauth/register`, `/mcp-oauth/token`, `/mcp-oauth/revoke`, answering OAuth's error shape. |
| `apps/api/src/routes/browser.ts` | `/browser/oauth/authorization`, `/browser/oauth/approve`, `/browser/oauth/deny`: the consent half, behind the browser cookie and its Origin check. |
| `apps/api/src/services/auth-service.ts` | `AccessTokenAudience`, `createMcpSession`, and `refresh`'s separation of desktop and MCP sessions. |
| `apps/api/src/middleware/auth.ts` | `MCP_ROUTE_FAMILIES`: the routes an MCP token reaches. |
| `apps/api/src/services/canvas-publication-service.ts` | `CanvasPublicationService`: a person publishing a file or a static site into a Canvas, behind `POST /canvases/:id/artifacts`. |
| `apps/api/src/services/resource-publication.ts` | The publication writes Rally's own publish and a person's share: the identity, the INSERT, the content swap, with the revision's author as a parameter. |
| `packages/contracts/src/canvas-build.ts` | `detectSiteSource`: what a site's files are (static, component, project), and the libraries a component may import. |
| `apps/api/src/services/canvas-build/canvas-build-service.ts`, `build.sandbox.mjs` | `CanvasBuildService`, which builds a component or project in the Canvas's sandbox under a publication build's lease, and the script that builds and checks it there. |
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
| `read_artifact` | `GET /resources/:id/versions/:version/model-content`, else `…/content` when the original is text |
| `create_canvas` | `POST /canvases`, the operation id as the Canvas id and the prompt's `clientMessageId` |
| `send_canvas_message` | `POST /conversations/:id/substreams/0/messages` |
| `update_canvas` | `PATCH /canvases/:id` |
| `set_canvas_audience` | `POST /canvases/:id/audience` |
| `invite_canvas_guests` | `GET /workspace`, then `POST /sharing` |
| `decide_canvas_access_request` | `POST /canvases/:id/access-requests/:userId/decision` |
| `pin_canvas` | `POST /canvases/:id/pin` |
| `rename_artifact` | `PATCH /conversations/:id/resources/:resourceId` |
| `publish_file` | `POST /canvases/:id/artifacts` with `kind: "file"` |
| `publish_site` | `POST /canvases/:id/artifacts` with `kind: "site"`: files to serve, a React component, or a project ([Building](#building)) |

`GET /canvases` and `GET /conversations/:id/text` were added for this server:
the app reads the list over its workspace socket and the transcript as blocks.
The list is `canvasSidebarRows`, the read the sidebar socket sends
(`WorkspaceDO.canvasListFor`); the text is `ConversationService.readText`,
which the engineering MCP's Chat reads share.

### Publishing

`publish_file` and `publish_site` bring something made outside Rally (a
Claude or ChatGPT artifact, a file in an OpenCode workspace) into a Canvas as
one of its artifacts, exactly as written. Before this, only Rally's own
`publish_resource`, inside a run, could put an artifact in a Canvas; a
person's upload is a message attachment, which never becomes one.

`POST /canvases/:id/artifacts` (`CanvasPublicationService`) takes a `file`
(one document, as text or base64) or a static `site` (files with an
`index.html`). It authorizes the person as a reader who can take part in the
Canvas, then writes through `resource-publication.ts`, the same writes Rally's
publish makes, with the person as the revision's author (`member`):

1. The identity is `canvas:<canvasId>:<name>`. The same name again finds the
   same row: equal content is `unchanged`, new content is a swap and a new
   version, and a name already published as the other kind is refused
   (`canvas_artifact_kind_changed`).
2. A file's bytes go to R2 and the row is inserted or swapped; a site's
   files are written as a version (`writeArtifactVersion`), its hostname
   reserved, its row inserted or swapped, registered, and its host pointed at
   the new version last, in the order Rally's publish uses.
3. The resource is attached to the Chat and noted on the Canvas
   (`canvasNoteArtifact`) with the person as its last editor. Both are
   idempotent and run on every outcome, so a retry finishes a call that wrote
   the row but lost its answer.

The answer is the artifact's id, title, kind, current version, the outcome,
and the Canvas's link opened on it. A site with a server module (`index.js`)
is refused: running code is Rally's to publish from its sandbox.

### Building

A site's files are not always ready to serve. Claude's and ChatGPT's React
artifacts are one `.jsx` or `.tsx` file with a default export that imports
`lucide-react`, `recharts` and shadcn/ui from paths that exist only in their
own renderer, and Claude Code or OpenCode produce projects with a build step.
So a `site` publish first decides what its files are, in the Worker, before
any sandbox starts (`detectSiteSource` in `packages/contracts/src/canvas-build.ts`):

| Files | Becomes |
| --- | --- |
| a root `package.json` with a `build` script | a project: built by its own script |
| a root `index.html` | a static site, published as it is |
| one root `.jsx`/`.tsx` with a default export | a component: built with Rally's toolchain |
| anything else | refused, naming why (`canvas_build_entry_missing`, `canvas_build_entry_ambiguous`, `canvas_build_script_missing`) |

A component may import only `COMPONENT_LIBRARIES` (React, lucide-react,
recharts, lodash, clsx, tailwind-merge) and the shadcn/ui modules the build
provides (`COMPONENT_UI_MODULES`); anything else is refused as
`canvas_build_unsupported_import:<module>` without starting a sandbox.

`CanvasBuildService` then builds in the Canvas's own Terminal sandbox, the one
its Chat's runs use ([`terminal-workspaces.md`](terminal-workspaces.md)). It
acquires the sandbox through the same coordinator as an agent run, as the
person, and holds the operation lease as `PUBLICATION_BUILD_HOLDER`: an agent
run waits for it (`sandbox_busy`) and the idle sweep leaves it alone until the
lease expires. It stages the files under `/tmp/rally-canvas-build/<id>`,
outside the agent's `/workspace`, and runs `build.sandbox.mjs`, which ships
into the sandbox as text as `apply_patch.py` does:

1. A component gets a host page that mounts its default export, the shadcn/ui
   pieces it imports, and Tailwind generated from its classes, bundled with
   esbuild against pinned library versions installed once per sandbox and
   reused. A project runs `npm ci` (or `npm install`) and `npm run build`, and
   its output is the first of `dist`, `build`, `out` holding an `index.html`.
2. The result is opened in the sandbox's Chromium. An uncaught error, a failed
   request for one of its own files, or an empty page refuses the publish
   (`canvas_build_check_failed`, `canvas_build_check_empty`) with what went
   wrong.
3. The output is listed with its digests, read back, checked against the
   listing, and published as a static site through the path above. The build
   directory is deleted and the lease released whatever happened.

The libraries are copied into the artifact at build time, so a published site
never loads code from anywhere else when it is viewed. Its identity is the
source it was published from, so an unchanged republish answers `unchanged`
without starting a sandbox. The answer's `build` says what was built and how
much text the check saw rendered.

`read_artifact` reads Rally's text form of a version, which extraction
writes a moment after a publish; until then a version whose original is
already text (Markdown, CSV, HTML, JSON) reads as its original, so an
artifact can be read back the moment it is published. A PDF or a sheet
answers that its text is not ready yet.

### Skills, resources and prompts

The Worker serves the MCP SDK's own handler (`createMcpHandler` from
`@modelcontextprotocol/server` 2.4.0), one stateless server per request, for
both the 2026-07-28 protocol and the 2025-era protocol clients speak today.

**Skills.** Through MCP's skills extension (`io.modelcontextprotocol/skills`)
the server lists and serves two skills: `skill://rally/canvases/SKILL.md`
(finding, changing, sharing and tidying Canvases) and
`skill://rally/publishing/SKILL.md` (bringing in work made elsewhere). They
are the plugin's own files (`plugins/rally/skills/*/SKILL.md`), bundled into
the Worker as text, so Claude Code's plugin and every client that reads
skills from a server get one copy. Each listing carries the files' digests,
and the SDK's `SkillCatalog` computes them from the bytes it serves.

**Resources.** Three templates: `rally://canvas/{canvasId}` (the detail),
`rally://canvas/{canvasId}/chat` (the Chat's first page) and
`rally://artifact/{resourceId}/v{version}` (a version as text). They are not
listed; `list_canvases` finds Canvases. `get_canvas` returns a resource link
for each artifact, and `publish_file` and `publish_site` one for the version
they made, so a client can read it back without another tool call. An id
that is not one is refused before Rally is asked.

**Prompts.** `publish_to_rally`, `start_canvas` and `catch_up`, which Claude
shows as slash commands. Each is a user message that names the workflow.

The server's instructions stay sufficient on their own for a client that
reads neither skills nor prompts, and point at the two skills.

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
- **A person's publish writes as the person.** Each revision it makes is
  authored `member` with their id, never as Rally's run, and the Canvas's
  last editor is the person. Guard: the version case in
  `apps/api/test-workers/canvas-publication.test.ts`.
- **A publish path names a file inside the artifact.** No segment is empty,
  `.` or `..`, and none carries a backslash or control character, so a path
  cannot alias another or leave the artifact's storage prefix. Guard:
  `packages/contracts/src/canvas-publish.test.ts`.
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
- **A published artifact** is capped at `MAX_ATTACHMENT_BYTES` (25 MB by
  default), the limit Rally's own publish and uploads use, counted over all of
  a site's files; a site is also capped at `ARTIFACT_MAX_ASSET_COUNT` files.
  The content arrives as JSON, so base64 bytes cost a third more on the wire.
  An oversized body is refused from its length before anything is decoded,
  and base64 decodes in one pass (`Uint8Array.fromBase64`), because a 25 MB
  file is a 33 MB string and each copy counts against the isolate's 128 MB.
- **Measured on workerd, 2026-11-09** (route to R2, one run, not a benchmark):
  a 5 MB file in 0.13 s, 25 MB in 0.5 s, a 50-file site in 0.2 s, 500 files
  in 0.8 s, 2,000 files in 2.4 s; each read back byte for byte. A site's
  files upload six at a time, as Rally's own publish does; a site near the
  platform's subrequest limit fails the publish rather than half-landing.
- **The MCP hop is the tighter bound.** The MCP Worker holds a tool call's
  arguments several times over (the request, the SDK's parse, the body sent
  on), so a call carrying tens of megabytes can exceed its memory and fail.
  In practice a model's tool call is bounded far lower by its output length,
  well under a megabyte, so large binaries come from a client that sends
  them without the model writing them out. No cap is set here.
- **An MCP request body is at most 4 MiB**, the SDK handler's default
  (`maxRequestBodySize`), refused with 413 before it is parsed. A tool call
  publishing content near the API's 25 MB cap is refused here first. Not a
  number this change chose: it is the library's, kept open for the team to
  set; the arithmetic is a base64 file of N bytes costing about 4N/3 bytes of
  request.
- **A build needs the Terminal.** In a deployment without it (local
  development by default), a component or project is refused with
  `canvas_build_unavailable`; files with an `index.html` still publish.
- **A build's latency** is the sandbox's acquisition (a stopped sandbox
  starts, a missing one is created), the toolchain install on the first
  component build in a sandbox (about 10 s locally), then about 2 s per
  component; a project pays its own install and build. It runs within the
  Terminal's command ceiling (900 s) inside the 16-minute lease. A build
  while Rally is mid-command in the same Canvas is refused
  `canvas_build_sandbox_busy` rather than queued.
- There is no tool to delete a Canvas or remove an artifact: the app has no
  route for the first, and the second's effect on a Canvas's generated
  artifacts is not settled.

## Testing

- `pnpm --filter @rally/api exec vitest run test/mcp-oauth.test.ts`:
  registration, consent through a real email sign-in, the PKCE exchange, the
  route boundary, refresh in both directions and revocation, over the real
  migrations.
- `pnpm --filter @rally/api test:workers test-workers/canvas-publication.test.ts`:
  a person's file and site land as Canvas artifacts on real workerd, a
  republish versions the same artifact with the person as each revision's
  author, a repeat changes nothing, bytes are stored exactly from either
  base64 alphabet, an oversized file is refused before it is decoded, a
  site's files are a set, and someone the Canvas does not admit writes
  nothing.
- `pnpm --filter @rally/contracts exec vitest run src/canvas-publish.test.ts`:
  the path and site rules a publish is held to.
- `pnpm --filter @rally/contracts exec vitest run src/canvas-build.test.ts`:
  what a site's files are detected as, and the imports a component is held to.
- `pnpm --filter @rally/api exec vitest run test/canvas-build-service.test.ts`:
  the build runs under the publication build's lease over the real coordinator,
  returns only output matching its listing, and releases the lease and deletes
  its directory on every path. Daytona is a double.
- `build.sandbox.mjs` itself is checked by hand, as Daytona cannot run in a
  suite: run it with a request naming a component's directory (it prints its
  report on the last line). On 2026-11-09 it built a Claude-style dashboard
  (recharts, lucide-react, shadcn Card/Button/Badge, Tailwind), a timer and a
  Vite project, and refused a component that throws on render.
- `pnpm --filter @rally/mcp test` also covers the skills (each served
  file matches the digest its listing advertises), the resources (a link from
  `get_canvas` read back as text, and a malformed id refused before Rally is
  asked) and a prompt.
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
- **OpenCode:** add the server to `opencode.json` under `mcp.servers`,
  `{"mcp": {"servers": {"rally": {"type": "remote", "url": "https://mcp.rallywith.ai/mcp"}}}}`,
  then `opencode mcp auth rally`. OpenCode tries a client ID metadata
  document first, which this server does not advertise, then registers
  itself, and signs in with a loopback redirect, which registration admits.

## Changelog

### 2026-11-09 — Rally's MCP server for its users

**What changed.** A new Worker at `mcp.rallywith.ai` with fifteen Canvas
tools, including publishing a file or a static site made elsewhere into a
Canvas through a new `POST /canvases/:id/artifacts` (building a React
component or a project in the Canvas's sandbox, and checking it renders,
before it publishes), an OAuth 2.1 authorization server split between the identity API and
the browser app's consent page, a `rally-mcp` token audience confined to the
Canvas routes, `GET /canvases` and `GET /conversations/:id/text`, and a Claude
Code plugin.

**Why.** People asked to work with Canvases from Claude and ChatGPT, which
reach tools only over MCP with OAuth. A grant is an ordinary session rather
than a token store of its own (Cloudflare's OAuth provider library was the
alternative) so every rule that ends or narrows a session ends or narrows a
grant without a second implementation. A person's publish was the gap that
made an MCP client useful for work already done in Claude, ChatGPT or
OpenCode; it was built on the write steps lifted out of Rally's own publish
(`resource-publication.ts`) rather than a second writer, and rather than
asking Rally to republish an attachment, which would put a model run between
the person and their exact bytes. Claude's and ChatGPT's React artifacts are
source, not a page, so a publish detects what it was given in the Worker and
builds only what needs it, in the Canvas's own sandbox (the product decision
of 2026-11-09 that a Canvas has one shared sandbox); compiling in the page
from a CDN was rejected because it loads code from elsewhere on every view
and never checks the page renders. The Worker serves the SDK's handler rather than the `agents` package's,
which pinned the SDK to an exact older version and would have blocked the
skills extension. Skills are served from the plugin's files rather than
written a second time. A future change must keep MCP and desktop
refresh apart, keep `MCP_ROUTE_FAMILIES` to the routes the tools call, and
change a publication write in `resource-publication.ts` for both publishers.
