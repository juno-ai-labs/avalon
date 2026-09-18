# Canva platform research

> Read from Canva's published documentation on 2026-09-17, and measured against
> the live provider the same day; followed up on 2026-09-18. Documentation claims and live measurements are
> kept apart deliberately, because two of the load-bearing ones disagreed.
>
> The second half of this document — the Connect APIs and their webhooks — is no
> longer proposed. It is kept because it is what the workspace scope was costed
> against before it was cut, and it is the answer to "why not just ingest Canva
> events". Anything that becomes a registration is recorded in
> [`provider-apps.md`](../../provider-apps.md) with its date, the way Fireflies'
> and Ashby's are.

## The two platforms

Canva ships two developer surfaces. They authenticate differently, are registered
differently, and only one of them emits events.

| | Canva MCP | Connect APIs |
| --- | --- | --- |
| What it is | A remote Streamable HTTP MCP server | A REST API over designs, folders, assets, comments, brand templates, exports, autofill |
| Endpoint | `https://mcp.canva.com/mcp` | `https://api.canva.com/rest/v1/…` |
| Registration | A redirect URI allowlisted by Canva; client identified by CIMD or DCR | An integration in the [Developer Portal](https://www.canva.com/developers/), client ID + secret |
| Authorization | OAuth, per Canva user | OAuth 2.0 authorization code + PKCE, per Canva user |
| Events | None | Webhook notifications (preview) |
| Tenancy | Per user, explicitly — no organization-level authentication | Per user. There is no team or service credential |

Sources: [MCP overview](https://www.canva.dev/docs/mcp/),
[Connect overview](https://www.canva.dev/docs/connect/),
[Creating integrations](https://www.canva.dev/docs/connect/creating-integrations/).

**Only the MCP server is in scope.** The rest of this document explains why.

## Canva MCP, as documented

- One endpoint, `https://mcp.canva.com/mcp`, Streamable HTTP. `mcp-remote` over
  stdio is documented only for clients that cannot speak remote MCP.
- **CIMD is the recommended client identity**: the OAuth `client_id` is an HTTPS
  URL serving a JSON document, so no client is pre-registered and no secret is
  held. **DCR is documented as deprecated** but still accepted.
- **The redirect URI must be allowlisted by Canva**, through a
  [waitlist form](https://docs.google.com/forms/d/e/1FAIpQLSdtsKA9LSmY-JEf_nF5QYBdjxfnXbgqvlKzd8obKGSPSK_eOA/viewform)
  reviewed for "brand alignment, trust and safety considerations, compliance
  readiness, technical fit, and strategic alignment". Canva notes that many
  established AI tools already have access.
- **No organization-level authentication.** Canva's own words: access varies by
  user, users can only reach their own or shared content, and "you can't set up a
  single service account or application-level authentication that works for all
  users."
- **Manual client registration** is documented for platforms supporting neither
  CIMD nor DCR: `POST https://mcp.canva.com/register`, with
  `https://mcp.canva.com/authorize` and `/token`.
- **Canva communicates over two domains**, `canva.com` and `canva.ai`; a client
  must allow both.
- **Timeouts**: `generate-design` can run long, and Canva suggests a 60-second
  client timeout.

### The published tool list

Canva *does* publish one, at
[Tools and rate limits](https://www.canva.dev/docs/mcp/tools/) — around thirty (the live server returns 35; see the probe below)
tools with a per-minute rate limit and plan availability each. An earlier index
page lists only ten, which is how this research first recorded it wrongly. The
catalog is transcribed in [`design.md`](design.md#the-tool-surface) at review
level only: Rally's pass-through must read `tools/list` live, and a snapshot in
source is a second authority that goes stale — which two of Canva's own pages
already demonstrate.

Historical tool-page plan claims (2026-09-17; the current overview differs):

- **All plans**: design generation, editing, search, exports, comments, asset
  uploads, folders, imports.
- **Pro and above**: brand templates, brand kits, resize. Export quality also
  improves — lossless PNG, transparency, premium elements.
- **Enterprise**: autofill and brand template datasets.

## The live probe (2026-09-17)

Two probes, run the same day and reported separately because they establish
different things.

The **OAuth probe** below was protocol-level only: no credentials were used, no
login was completed, and no token was ever issued — every request stopped at the
redirect to Canva's login page. A few throwaway OAuth clients were registered at
Canva's open endpoint; none were authorized.

The **Inspector probe**, further down, did authorize — with a real Canva account
over a loopback redirect — and is what produced the live tool catalog.

### Registration is open; `/authorize` is the gate

`POST https://mcp.canva.com/register` returned **`201` with a real `client_id`
and `client_secret` for every redirect URI tried**, including
`https://example.com/callback` and `http://localhost:9999/cb`. No approval field,
no pending state, no error naming an allowlist. **Registration is not the gate.**

Presenting one of those clients at `/authorize`, with correct PKCE and the same
redirect URI it registered, is where the allowlist appears:

| redirect URI | result |
| --- | --- |
| `https://api.rallywith.ai/connections/canva/callback` | `400` · `Invalid redirect URI.` |
| `https://example.com/callback` | `400` · `Invalid redirect URI.` |
| `https://cursor.com/connector` | `400` · `Invalid redirect URI.` |
| `https://www.canva.com/cb` | `400` · `Invalid redirect URI.` |
| `https://claude.ai/…`, `https://claude.com/…` | `302` → Canva login |
| `https://chatgpt.com/connector_platform_oauth_redirect` | `302` → Canva login |
| `http://localhost:<port>/…`, `http://127.0.0.1:<port>/…`, `https://localhost:<port>/…` | `302` → Canva login |

The refusal body is exactly `Invalid redirect URI.` — `text/plain`, 21 bytes, no
OAuth error code, no redirect carrying `error=`, no mention of an allowlist or a
waitlist. A client that hits it has nothing to diagnose from.

An accepted client's `302` proves only the *client* was accepted: Canva swaps in
its own upstream OAuth app and sends the user to
`https://www.canva.com/api/oauth/authorize?client_id=OC-…&redirect_uri=https%3A%2F%2Fmcp.canva.com%2Fcallback&…`.

**So the two documentation pages were never in tension about policy — they are in
tension about where you find out.** The open registration endpoint is real and
useless on its own.

Three further observations:

- **Matching is exact host, any path.** `https://claude.ai/totally/other/path`
  passes; `https://evil.claude.ai/cb` and `https://claude.ai.evil.example.com/cb`
  do not. No suffix hole, but anyone with an open redirect on an allowlisted host
  could point a DCR client at it. The allowlist is not a security boundary.
- **It is partner identification.** Canva fingerprints the redirect host and
  forwards `mcp_client_type` upstream — `ClaudeConnector`, `ChatGPTConnector`,
  `Other` for loopback.
- **Tested loopback URLs were accepted**, across the tested ports and schemes. That is the
  standard native-application flow, and it is the one path needing no approval.

### Authorization server metadata

`GET https://mcp.canva.com/.well-known/oauth-authorization-server` → `200`:

```json
{"issuer":"https://mcp.canva.com",
 "authorization_endpoint":"https://mcp.canva.com/authorize",
 "token_endpoint":"https://mcp.canva.com/token",
 "registration_endpoint":"https://mcp.canva.com/register",
 "grant_types_supported":["authorization_code","refresh_token",
   "urn:ietf:params:oauth:grant-type:jwt-bearer"],
 "token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],
 "revocation_endpoint":"https://mcp.canva.com/token",
 "code_challenge_methods_supported":["plain","S256"],
 "client_id_metadata_document_supported":true}
```

- **Refresh is advertised**, and `offline_access` is not published. This does
  not prove default token issuance, successful refresh or rotation; those remain
  live acceptance tests.
- PKCE offers `plain` as well as `S256`; use `S256`.
- Revocation shares the token endpoint URL.
- `.well-known/openid-configuration` → `404`. Not an OIDC provider.

### Consent is all sixteen scopes, whatever is requested

A request carrying `scope=profile:read` produced an upstream authorization asking
for all sixteen published scopes: `profile:read`, `design:meta:read`,
`design:content:read`, `design:content:write`, `folder:read`, `folder:write`,
`brandtemplate:meta:read`, `brandtemplate:content:read`,
`brandtemplate:content:write`, `comment:read`, `comment:write`, `asset:read`,
`asset:write`, `brandkit:read`, `help:answers:read`, `help:answers:write`.

**There is no least-privilege connection available**, which also contradicts
Canva's own published advice to request only the minimum scopes needed.

### Two provider bugs worth designing around

- **`/authorize` returns `500 Internal Server Error` for an unknown
  `client_id`**, where OAuth requires a 400-class error. A stale or revoked Rally
  registration would surface as an opaque server error.
- Canva sends `code_challenge_method=s256` lowercase on its own upstream hop,
  which is non-conformant to RFC 7636. Internal to Canva; noted only so nobody
  copies it.

### The local Inspector probe

A second probe the same day connected MCP Inspector 2.7.0 to
`https://mcp.canva.com/mcp` with per-user OAuth on a real Canva account,
protocol `2025-11-25`. A loopback redirect needed no manual registration and no waitlist
approval — which is what made it possible, and which says nothing about
production redirect eligibility.

**35 tools were returned with complete input schemas.** The docs table lists an
`autofill-design` tool that the live catalog does not serve, and omits `search`
and `fetch`, which it does. Neither list is the contract; `tools/list` is.

Properties of the live surface, all from the schemas:

- **All 35 descriptions call `user_intent` mandatory**, but none includes it
  in the schema's `required` array. Calls supplied it; omission was not tested.
  Neither model authorship nor a telemetry purpose follows from the schema.
- **No tool declares an `outputSchema`.** Responses are undeclared.
- **`search-designs` takes `sort_by`** with `relevance`, `modified_descending`,
  `modified_ascending`, `title_descending`, `title_ascending`, and `ownership`
  with `any`, `owned`, `shared`. Canva's own documentation page for this tool
  publishes neither parameter. Ordering alone does not establish an incremental
  cursor: stopping at a prior top ID misses an older design edited before that
  top design. Shared ownership is not a sharing-event feed.
- **`list-folder-items` takes `sort_by`** across created, modified and title, in
  both directions, and `folder_id: 'root'` lists the top level.
- **`list-comments(design_id, limit ≤ 100, continuation)`** pages a design's
  threads, and `list-replies` takes a `comment_id`. These input schemas alone
  did not prove stable IDs or response shapes; the follow-up below tested them.
- **`get-design` accepts a full Canva share URL**, and its description states
  that "any collaboration token embedded in the URL is needed to access a design
  shared via link and will be parsed and forwarded automatically". A share URL is
  potentially access-bearing; exact link-only access semantics remain untested.
- **Annotations do not determine Rally authority or quota consumption.** `generate-design` and `export-design` are
  `readOnlyHint: true` although both create and consume quota;
  `commit-editing-transaction` and `cancel-editing-transaction` are
  `destructiveHint: true`.
- **`design_types` currently supports only `presentation`.**
- Tool descriptions carry imperative prompt-steering at the client model,
  including "🚫 NEVER use this tool…" in `search-designs`.

Exercised end to end: search, generate (four candidates), create from candidate,
read content before and after editing, open an editing transaction (which
returned element ids and pages), perform a title update and a targeted text
replacement, commit, re-read, get design, list export formats (PDF, JPG, PNG,
PPTX, GIF, MP4), export to PDF, and resize. The edit was visually confirmed in
the Canva editor afterwards.

`resize-design` succeeded on the tested account and returned
`trial_information.uses_remaining = 1` — so a plan-gated tool can answer from a
trial quota rather than refusing, which is a second reason not to pre-screen on
plan. `list-brand-kits` and `search-brand-templates` returned empty lists, which
proves neither entitlement nor absence.

Not exercised in this first probe: comments and replies, asset upload, folder operations, brand
template creation, import. Two disposable designs remain in the test account.

### What could not be settled

CIMD redirect eligibility, refresh issuance/renewal, revocation and link-only
access were not settled. The current official route is the waitlist application;
a speculative CIMD bypass is not a prerequisite to applying.

## Live watch follow-up (2026-09-18)

Used the same authenticated Inspector connection, a disposable design, and the
Canva browser editor. These are observed integration behaviors, not published
ordering/consistency guarantees. No user identifiers, design IDs, signed URLs,
credentials or test content are copied into this record.

| Experiment | Observed result | Consequence |
| --- | --- | --- |
| Browser title and text edits | `get-design.updated_at` advanced | Candidate signal for an eventual change notification |
| Isolated layout-only move | Timestamp advanced; content text unchanged | Content-text comparison alone misses layout changes |
| Duplicate page | Initial metadata/pages lagged; later reads and browser reload showed two pages | No fixed propagation latency measured |
| Create four threads and three replies | IDs matched creation responses | IDs support observed deduplication |
| Force one item per page | Threads newest-first; replies oldest-first; both ended with a continuation to an empty page | Follow continuation until absent; do not depend on observed ordering |
| Insert thread during pagination | Existing scan finished older threads; fresh scan found insertion | Repeat complete scans; cursor is not a proven snapshot |
| Add replies to oldest thread | Parent timestamp/order and design timestamp unchanged; no embedded replies/count | Scan replies independently, including old threads |
| Resolve a thread in browser | Thread remained, with `thread_type.resolver`; timestamp unchanged | Timestamps cannot announce resolution either |

Observed thread fields: `id`, `design_id`, `thread_type` (type, content,
mentions, optional resolver), author, `created_at`, `updated_at`. Replies carried
`id`, `design_id`, `thread_id`, author, content, mentions and timestamps. There
was no separate status field in this observed thread shape.

`get-design-content` returned text. No `metadata.revision_id` was observed; the
earlier PRD claim was unsupported. The proposed watch is a coalesced report of
change since an observation, not an exact revision feed. Full comment and reply
scans with durable ID deduplication are justified; a top-ID waterline is not.

Still untested: deletions, comment/reply edits, mentions, other-user actions,
reopening, timestamp ties, large designs and provider consistency guarantees.
Rally's checkpoint atomicity, failed scans and delivery recovery also require
implementation tests. The disposable design retains the probe edits and
comments; other designs were not changed.

## Current access and policy review (2026-09-18)

The [overview](https://www.canva.dev/docs/mcp/) continues to direct partners to
apply for redirect allowlisting, and recommends CIMD while retaining DCR. Local
Inspector success is not production approval. The application is drafted, not
submitted. The proposed Global and EU callback paths are recorded in the PRD;
they are not implemented or approved. Rally is pre-launch with zero active
users. The suggested initial pilot forecast is fewer than 1,000 aggregate MCP
tool calls per month across users and workspaces, not a measured demand figure,
per-user quota or contractual promise.

The current overview assigns resize to Pro+ and brand kits, templates and
autofill to Enterprise, unlike the earlier tool-page claims above. Per-call
results remain authoritative for entitlement; trial-backed resize does not
establish the account's full plan status.

The [usage policy](https://www.canva.dev/docs/mcp/usage-policy/) establishes:

- Background access requires opt-in and clear controls, never a default watch.
- Shared agents cannot run with another user's token; access to derived outputs
  requires each user's own authentication. Shared work-stream/digest compatibility
  needs Canva clarification; membership is not sufficient evidence.
- Canva data cannot train, evaluate or improve external models. Brand Kits stay
  within Canva design workflows; operational retention must be minimized.
- MCP limits are per user; OAuth protections are per client. Backoff and error
  monitoring are required, and credit consumption should remain visible.

These policy requirements are separate from what a successful API call permits.

## Why the workspace scope was cut

Kept as the record of what a Canva workspace connection would have cost. The
product decision, taken 2026-09-17, was that it is too complicated to ask a
customer to do.

### Webhook configuration is per integration, not per connection

In the Developer Portal, an integration enables `collaboration:event` and enters
**one Webhook URL**. That is the entire configuration surface: no webhook API, no
per-user subscription, no per-event toggle, nothing Rally can register, rotate or
reconcile. Three consequences:

1. One URL serves every Canva user who authorized the integration, in every Canva
   team, for every Rally workspace — so routing is Rally's problem and the
   payload is the only thing that can solve it.
2. Enabling notifications enables **all eleven** event types. There is no
   subscription choice to make.
3. Registration, rotation and removal are manual, in a UI — the Fireflies
   posture, and the reason
   [`connector-installation-lifecycle.md`](../../connector-installation-lifecycle.md)
   exists.

### Preview status forces a private integration

Webhook notifications and the Keys API are both **preview**. Canva states that
"public integrations that use preview APIs or features will not pass the review
process", and that private integrations "can only be used by your team on a Canva
Enterprise plan".

So a Rally-owned integration with webhooks could serve only Juno Labs' own Canva
team. Reaching customers would mean **each customer registering their own private
integration** — MFA, thirteen scopes, a client ID and secret pasted into Rally, a
Rally-issued URL pasted back into Canva, an Enterprise plan, and a real comment
on a real design to prove delivery works, because Canva has no test-event button.
That is the setup that was judged too complicated, and it is the whole reason the
scope is gone.

### The eleven event types, for whenever this is revisited

Each delivery carries `id`, `created_at` (UNIX seconds) and `content`, with
`content.type` as the discriminant.

| `content.type` | Subject | Distinguishing fields |
| --- | --- | --- |
| `comment` | `design` | `comment_event` (`new`/`reply`), `comment_url`, thread with `thread_type` (`comment`/`suggestion`), `plaintext`/`markdown`, `mentions` |
| `design_mention` | `design` | as comment, scoped to a mention |
| `suggestion` | `design` | a suggestion-typed thread |
| `design_access_requested` | `design` | `triggering_user` is a `TeamUser` |
| `design_approval_requested` | `design` | **no property list published** — only a worked example |
| `design_approval_response` | `design` | `initial_requesting_user`, `responding_groups[]` with `external` |
| `design_approval_reviewer_invalidated` | `design` | **no `triggering_user`** — the system, not a person |
| `share_design` | `design` | optional `share` carrying a `message` |
| `share_folder` | `folder` | optional `share` with `message` |
| `folder_access_requested` | `folder` | `folder` (`FolderSummary`) |
| `team_invite` | neither | `receiving_user`, `inviting_team` with `external` |

Shared shapes: `User` is `id` (required) and `display_name`. `TeamUser` is
`user_id`, `team_id`, `display_name`, **all optional**. `DesignSummary` carries
`id`, `urls.edit_url`, `urls.view_url`, `created_at`, `updated_at` required, plus
`title`, `url`, `thumbnail`, `page_count`. `FolderSummary` carries `id`, `name`,
`created_at`, `updated_at` required. **Thumbnail URLs expire after 15 minutes.**
Mentions are keyed `"<user_id>:<team_id>"` and appear in text as
`[user_id:team_id]`.

Notice what is absent: no `design.created`, `design.updated`, `design.published`,
`export.completed` or `folder.item_added`. **Canva emits collaboration
notifications, not content-change events.** Even with the workspace scope, Rally
could never have learned that a design changed.

Scopes per family, for the record — and note that receiving a *folder access
request* requires `folder:permission:write`, a write scope, to read an event:

| Notification type | Required scopes |
| --- | --- |
| Comments | `collaboration:event`, `design:meta:read`, `comment:read` |
| Design access requests | `collaboration:event`, `design:meta:read` |
| Design approvals | `collaboration:event`, `design:meta:read` |
| Design sharing | `collaboration:event`, `design:meta:read` |
| Folder access requests | `collaboration:event`, `folder:permission:write` |
| Folder sharing | `collaboration:event`, `folder:read` |
| Team invitations | `collaboration:event` |

### Verification, for whenever this is revisited

`GET https://api.canva.com/rest/v1/connect/keys` is public and unauthenticated,
returning a JWKS of Ed25519 public keys (`kty: OKP`, `crv: Ed25519`, `kid`
selecting). Canva says the keys rotate and recommends caching them, refetching
only on an unrecognized `kid`.

**The exact signature envelope remains unresolved** — header names, and whether
the body is a signed JWT or JSON with a detached signature. Canva's prose says
"decrypt the webhook signature", which describes no signature scheme. It would
need one observed delivery to settle, which the personal-only scope no longer
requires.

## What the platform rules out, either way

- **No workspace-level credential**, on either platform. Every token belongs to
  one Canva user.
- **No content-change events**, even with webhooks.
- **No least-privilege consent**, measured.
- **No organization-level authentication**, stated by Canva.
