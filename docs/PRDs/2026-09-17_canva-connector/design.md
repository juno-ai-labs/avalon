# Canva connector design

> Companion to [`prd.md`](prd.md). Holds the authorization mechanics, the tool
> surface and its limits, and how the connection reaches a Sidekick. Provider
> facts, their sources, and the live measurements behind them are in
> [`research.md`](research.md); nothing here re-argues them.
>
> This connector has one scope, personal. There is no ingress, no event schema
> and no trigger manifest, because there is nothing to ingest — see Non-goals 1
> and 2 in [`prd.md`](prd.md).

## Shape of the connector

```
Canva MCP (mcp.canva.com/mcp) ── personal connection ── live tools/list ── model
```

| | |
| --- | --- |
| Capability | `canva.personal.mcp` |
| Connection scopes | `personal` |
| Credential | Canva MCP OAuth tokens, per member |
| Tools | Live `tools/list`, never checked in |
| Activity | None. `supportsWebhooks: false`, `supportsPolling: false`, no `activityTriggers`, no `resourceTypes` |

The whole adapter is the pass-through declaration
[`hosted-mcp-connectors.md`](../../hosted-mcp-connectors.md#declaring-a-pass-through-connector)
already defines:

```ts
const personalMcp = createHostedMcpPassthrough({
  providerName: "Canva",
  serverUrl: "https://mcp.canva.com/mcp",
  capabilities: [CanvaCapabilities.personalMcp],
  connectionScopes: ["personal"],
  capabilityForConnection: () => CanvaCapabilities.personalMcp,
  withAccessToken: (connection, signal, operation) =>
    withFreshProviderToken(connection, signal, operation),
  oauth: {
    redirectUri: canvaRedirectUri(env),
    allowedAuthorizationOrigins: ["https://mcp.canva.com"],
  },
});
```

`canvaRedirectUri` is the one decision that is not boilerplate, and it is below.

## Authorization

### What the server publishes

Measured live on 2026-09-17 from
`https://mcp.canva.com/.well-known/oauth-authorization-server`:

| | |
| --- | --- |
| Issuer | `https://mcp.canva.com` |
| Authorize / token / register | `/authorize`, `/token`, `/register` |
| Grant types | `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:jwt-bearer` |
| PKCE | `S256` and `plain` |
| Token endpoint auth | `client_secret_basic`, `client_secret_post`, `none` |
| Revocation | shares the token endpoint URL |
| CIMD | `client_id_metadata_document_supported: true` |
| OIDC | none — `openid-configuration` returns `404` |

Rally uses `S256`. `plain` being offered is the provider's weakness, not an
option to take.

**Refresh tokens are available and `offline_access` is not a published scope**,
so refresh is granted by default rather than requested. This is the opposite of
Fireflies, and it is why this connection is not designed around reconnection —
though it still reports reconnect-required when refresh fails, because a
measurement on one day is not a guarantee.

**Revocation shares the token endpoint URL.** Wiring disconnect needs care: the
same URL means one of them is selected by request shape rather than by path.

### The redirect URI, which is the whole problem

Canva enforces its allowlist at `/authorize`, on the redirect URI's **host**,
after registration has already succeeded. Registration is open to anyone and
hands back real credentials; the refusal comes one step later as a bare
`400 Invalid redirect URI.` with a 21-byte `text/plain` body and no mention of an
allowlist. Measured; the table of hosts tried is in
[`research.md`](research.md#the-live-probe-2026-09-17).

Two paths follow, and the PRD takes the first with the second held in reserve:

**Primary — an allowlisted Rally redirect.** Apply to the waitlist for the host
Rally will use, then authorize normally: the connector's `redirectUri` is
Rally's, the flow is the one every other connector uses, and it works from every
client Rally has or will have. Blocked until Canva grants it.

**Fallback — loopback from the desktop client.** `http://127.0.0.1:<port>/…` and
`localhost` are accepted unconditionally, on any port, with no approval. This is
the standard native-application flow, not a circumvention. The desktop client
opens a listener bound to loopback for one attempt, the system browser completes
the authorization, the listener receives the code and hands it to the member's
region, and the region exchanges it. **No token ever rests on the desktop**, and
the listener closes after one code.

Its limit is reach, not safety: it needs a local process, so the iOS client and
any browser session are excluded. Building the connector's only authorization
path on the one client that cannot generalize is why it is the fallback.

The redirect URI is therefore a configured value rather than a constant, and the
connector is absent from the catalog while no accepted redirect exists — Goal 6.

### Client identity

CIMD is Canva's recommendation and needs no client secret: the `client_id` is an
HTTPS URL serving a JSON document describing Rally. DCR works today and is
documented as deprecated, though it is still advertised in live metadata with no
deprecation signal.

**Whether CIMD bypasses the redirect-host allowlist is unresolved**, and it is
the question with the most leverage in this document: if it does, the waitlist
stops being blocking. It could not be settled without hosting a metadata document
on a domain we control, and an unfetchable `client_id` URL returns the same
opaque `500` as a nonexistent client, so the probe proved nothing either way.
Test it before anyone fills in the waitlist form.

### Consent breadth

The scopes Rally sends to `/authorize` are ignored. A request carrying
`scope=profile:read` produced an upstream Canva authorization for all sixteen
published scopes:

`profile:read`, `design:meta:read`, `design:content:read`, `design:content:write`,
`folder:read`, `folder:write`, `brandtemplate:meta:read`,
`brandtemplate:content:read`, `brandtemplate:content:write`, `comment:read`,
`comment:write`, `asset:read`, `asset:write`, `brandkit:read`,
`help:answers:read`, `help:answers:write`.

There is no least-privilege connection to offer. Rally requests what it needs for
form's sake and **tells the member what is actually granted**, in the connect card,
before the click. Requesting fewer scopes to make the copy read better would
change nothing about the grant and would make Rally's own words false.

## The tool surface

Discovered live at activation; never checked in. What Canva published on
2026-09-17 was around thirty tools, with per-tool per-minute rate limits and plan
gating. It is recorded here at the level a reviewer needs to judge the
connector's value, and is **not** the contract:

| Area | Tools | Limit | Plan |
| --- | --- | --- | --- |
| Discovery | `search-designs`, `get-design`, `get-design-pages`, `get-design-content`, `get-presenter-notes`, `get-export-formats` | 100/min | All |
| Generation | `generate-design`, `create-design-from-candidate`, `copy-design` | 20/min | All |
| Editing | `start-editing-transaction`, `perform-editing-operations` (50/min), `commit-editing-transaction`, `cancel-editing-transaction`, `get-design-thumbnail` (100/min) | 20/min | All |
| Comments | `comment-on-design`, `list-comments`, `list-replies` (100/min), `reply-to-comment` (20/min) | — | All |
| Folders | `create-folder` (20/min), `list-folder-items`, `search-folders`, `move-item-to-folder` (100/min) | — | All |
| Assets | `upload-asset-from-url` (30/min), `get-assets` (100/min) | — | All |
| Export / import | `export-design`, `import-design-from-url` | 20/min | All\* |
| Shortlinks | `resolve-shortlink` | none | All |
| Brand templates | `search-brand-templates`, `list-brand-kits` (100/min), `create-design-from-brand-template` (20/min) | — | **Pro+** |
| Resize | `resize-design` | 20/min | **Pro+** |
| Autofill | `autofill-design` (60/min), `get-brand-template-dataset` (100/min) | — | **Enterprise** |

\* Export is available on all plans; Free is standard quality, Pro and above get
lossless PNG, transparency and premium elements, and a design containing premium
elements can fail with `license_required`.

Two consequences:

- **Rally does not pre-screen on plan.** There is no field that reports a plan
  reliably, the provider decides per call, and its refusal is accurate in a way a
  cached check could never be. This is settled precedent: the X connector's
  health check reads no balance for the same reason, after reading one reported
  ten thousand usable credits as none and failed every plugin load in the
  workspace.
- **The most valuable tools are the gated ones.** Autofill — a brand template
  plus data becoming a design — is Enterprise-only, and it is the tool that makes
  the "build the launch kit" story work. Worth knowing before anyone promises it.

Whether the rate limits are per user or per client is undocumented and
inconclusive. It only matters if many members connect and share a bucket.

### Editing is transactional

Canva's editing tools open a transaction, apply operations, then commit or
cancel. A run that opens one owns closing it: a failure between open and commit
must cancel rather than abandon, or the member is left with a design holding
uncommitted state and a transaction Rally has forgotten. This is the one
Canva-specific behavior the pass-through's generic write handling does not cover
on its own.

## Failure vocabulary

| Condition | Rally code | Model's next action |
| --- | --- | --- |
| `401`, token expired or revoked | `unauthorized` → connection `needs_reconnect` | Stop; tell the member to reconnect Canva |
| Tool refused on plan (`license_required` and kin) | `forbidden` carrying Canva's reason | Stop; name what the plan does not cover |
| `429` | `too_many_requests` with the provider's wait | Retry once after `retryAfterMs` |
| Tool absent from `tools/list` at execution | `unsupported_capability` | Re-read the surface; do not forward an unadvertised name |
| Response over the cap | `payload_too_large` | Ask for less |
| Unknown or revoked client at `/authorize` | `invalid_configuration` | Operator action — see below |

That last row is the one to handle deliberately. Canva returns `500 Internal
Server Error` for an unknown `client_id` where OAuth requires a 400-class error,
so a stale or revoked Rally registration arrives as an opaque server error. Read
as a transient provider outage it would be retried forever; named, it is one
operator action.

A refusal that reaches a log, a notice, or the far side of an RPC hop names the
field it rejected, per
[`naming-a-schema-failure.md`](../../naming-a-schema-failure.md). `unhealthy` and
`unexpected_error` on a path that had the reason in hand are defects.

## Triggers: there are none, and that is declared

The adapter declares **no** `activityTriggers`, no `resourceTypes`, and neither
webhook nor polling support. That is not an omission to fill in later; it is the
correct declaration for a connector that receives nothing.

It matters because the drafting model reads the catalog. A personal Granola or
Fireflies connection once advertised its connector's full trigger set while
`normalize` refused every non-workspace connection, so the model built Sidekicks
on events that could never arrive and they were silent forever —
indistinguishable, in the product, from a Sidekick with nothing to do yet.
[`automation-lifecycle.md`](../../automation-lifecycle.md) records the fix, and
the correct behavior for Canva falls straight out of it: with no triggers
declared, no Canva trigger is offered, and a rule naming a Canva event is refused
on the plugin, naming the scope.

What a Sidekick *can* do is hold the tools. A personal connection may be bound by
its owner or by the run-as principal, so a Sidekick that member owns — triggered
by a schedule, an inbound email, or another connector's event — can use Canva as
the hands at the end of the work:

- A Linear project reaching *shipped* triggers a run that calls
  `search-brand-templates`, `create-design-from-brand-template` and
  `export-design`, and posts the assets into the work stream.
- A weekly schedule exports the current state of a named deck so the work stream
  holds a dated snapshot.
- A run that has just written copy calls `generate-design` to draft the graphic
  beside it.

Canva is the hands, never the ears. That is the whole shape of this connector,
and Non-goal 2 is where its cost is recorded.

## Limits to be set, not guessed

Each is a defensive limit, and
[`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md)
says the guard is written open and the number handed back:

- The MCP call timeout. Canva documents `generate-design` as long-running and
  suggests raising client timeouts to 60 seconds, so the general default and this
  tool's ceiling may need to differ.
- The response size cap before `payload_too_large`, and the per-string cap before
  `truncated` is set.
- The editing-transaction cleanup delay — how long an opened transaction may sit
  before a run is considered to have abandoned it.
- The loopback listener's lifetime, if that fallback is built.
