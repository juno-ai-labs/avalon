# Canva connector design

> Companion to [`prd.md`](prd.md). Holds the authorization mechanics, the tool
> surface and its limits, and how the connection reaches a Sidekick. Provider
> facts, their sources, and the live measurements behind them are in
> [`research.md`](research.md); nothing here re-argues them.
>
> This connector has one scope, personal. There is no webhook ingress or provider webhook
> event schema, because Canva delivers nothing to an unregistered integration;
> what activity exists is polled from a design somebody named — see Non-goals 1
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
| Activity | Polled watches only. `supportsWebhooks: false`, `supportsPolling: true`, two triggers, `resourceTypes: ["canva_design"]` |

The interactive tool facet uses the pass-through declaration
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

**Refresh is advertised, not yet verified end to end.** Metadata lists the
refresh grant and no `offline_access` scope; neither proves that a token is
issued by default or that renewal succeeds. Use Rally's credential coordinator
and test issuance, expiry, refresh rotation and revocation through the actual
Rally connection. A recoverable `401` enters refresh before reconnect is required.
The advertised revocation endpoint shares the token URL; verify disconnect's
request shape and remote result as well as immediate local removal.

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
`localhost` were accepted for the tested ports without approval. This is
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

CIMD does not establish production redirect eligibility. The probe could not
test a hosted Rally metadata document. Apply through Canva's documented waitlist
while choosing client identity; do not hold the application for a speculative
allowlist bypass. Local Inspector success proves neither callback approval nor
Rally's OAuth lifecycle.

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

Discovered live at activation; never checked in. A local MCP Inspector session
against `https://mcp.canva.com/mcp` on 2026-09-17 (protocol `2025-11-25`)
returned **35 tools with complete input schemas**. It is recorded here at the
level a reviewer needs to judge the connector's value, and is **not** the
contract.

| Area | Tools |
| --- | --- |
| Discovery | `search-designs`, `search`, `fetch`, `get-design`, `get-design-pages`, `get-design-content`, `get-presenter-notes`, `get-export-formats`, `resolve-shortlink` |
| Generation | `generate-design`, `get-design-candidates`, `create-design-from-candidate`, `copy-design`, `import-design-from-url` |
| Editing | `start-editing-transaction`, `perform-editing-operations`, `commit-editing-transaction`, `cancel-editing-transaction`, `get-design-thumbnail` |
| Comments | `list-comments`, `list-replies`, `comment-on-design`, `reply-to-comment` |
| Folders | `create-folder`, `search-folders`, `list-folder-items`, `move-item-to-folder` |
| Assets | `upload-asset-from-url`, `get-assets` |
| Output | `export-design`, `resize-design` |
| Brand | `search-brand-templates`, `get-brand-template-dataset`, `create-design-from-brand-template`, `list-brand-kits` |

Rate limits are per tool per minute, from Canva's published table: 100/min for
most reads, 20/min for generation, editing commits, export, resize and folder
creation, 50/min for `perform-editing-operations`, 30/min for asset upload, and
no listed limit on `resolve-shortlink`. The usage policy specifies per-user MCP
limits and per-client OAuth protections.

**The live catalog and the published one already disagree.** Canva's docs table
lists an `autofill-design` tool; the live `tools/list` does not return it. That
is the argument for the pass-through stated as a fact rather than a principle: a
catalog checked into Rally would have shipped a tool the server does not serve.

Four properties of the live surface shape the implementation:

- **`user_intent` is described as mandatory on all 35 tools**, but absent from
  every schema's `required` array. Server enforcement without it is untested.
  When supplied, send an accurate minimal operation description; deterministic
  wording is acceptable. Do not include unrelated work-stream context, and
  disclose this transfer without assuming Canva uses it as telemetry.
- **No tool declares an `outputSchema`.** Generic results remain bounded,
  truncation-flagged and untrusted. Explicitly validate fields Rally consumes
  for resources, checkpoints, transactions and entitlement notices. Malformed
  or missing fields fail the dependent operation without advancing its checkpoint.
- **Annotations do not determine authority or consumption.** Generation and
  export advertise `readOnlyHint: true`; neither guarantees no quota use.
  Commit/cancel's `destructiveHint: true` is not necessarily an error. Rally's
  own execution and receipt policy remains authoritative, including read-only
  child eligibility. Quota consumption and design mutation are separate facts.
- **`search` and `fetch` overlap discovery/content tools**, but equivalent
  outputs have not been demonstrated. Expose the live surface rather than
  collapsing tools based on names.

Canva's tool descriptions also carry heavy imperative prompt-steering at the
client model — `search-designs` contains "🚫 NEVER use this tool…" and a list of
phrasings that must route elsewhere. It is provider-authored text entering the
run's context, and it is treated as the untrusted content it is.

Two consequences for the product:

- **Rally does not pre-screen on plan.** There is no field that reports a plan
  reliably, the provider decides per call, and its refusal is accurate in a way a
  cached check could never be — the X connector's balance mistake, avoided. The
  probe saw this directly: `resize-design` succeeded on the tested account and
  returned `trial_information.uses_remaining = 1`, so entitlement is a
  per-call negotiation, not a static fact.
- **Entitlements remain provider decisions.** The overview read on 2026-09-18
  assigns resize to Pro+ and brand kits, templates and autofill to Enterprise,
  differing from earlier tool documentation. Empty brand lists prove neither
  entitlement nor its absence. Surface trial allowance and credit consumption
  when returned; do not infer the account's plan from one operation.

### Editing is transactional

Canva's editing tools open a transaction, apply operations, then commit or
cancel. A run owns closing a transaction known to remain open. Cancel on an
abandoned open transaction, but an uncertain commit result is not proof it
failed: preserve the uncertainty and reconcile available provider state rather
than cancelling or replaying mutations blindly. Test cancellation and lost
commit responses; the successful probe did not exercise recovery.

## Failure vocabulary

| Condition | Rally code | Model's next action |
| --- | --- | --- |
| `401`, token expired or revoked | Credential coordinator refresh/recovery, then grant-specific failure | Reconnect only when recovery establishes it is required |
| Tool refused on plan (`license_required` and kin) | `forbidden` carrying Canva's reason | Stop; name what the plan does not cover |
| `429` | `too_many_requests` with the provider's wait | Use exponential backoff respecting the provider wait; retry bounds are owner-set |
| Tool absent from `tools/list` at execution | `unsupported_capability` | Re-read the surface; do not forward an unadvertised name |
| Response over the cap | `payload_too_large` | Ask for less |
| Unknown client at `/authorize` | `invalid_configuration` | Operator action — see below |

That last row is the one to handle deliberately. Canva returns `500 Internal
Server Error` for an unknown `client_id` where OAuth requires a 400-class error,
so an unknown Rally registration can arrive as an opaque server error. Revoked
client behavior was not tested. Read
as a transient provider outage it would be retried forever; named, it is one
operator action.

A refusal that reaches a log, a notice, or the far side of an RPC hop names the
field it rejected, per
[`naming-a-schema-failure.md`](../../naming-a-schema-failure.md). `unhealthy` and
`unexpected_error` on a path that had the reason in hand are defects.

## Watching a design without webhooks

Canva sends nothing, so a watch is polled. The pattern is the one agreed on
2026-09-17 for personal MCP connections: an internal server-side poller, no
faster than the previously agreed ten-minute floor, provider-specific persisted
observations, and new events onto the Cloudflare queue. That floor is a recorded
product decision, not a measured provider latency guarantee. Per-platform
logic, deliberately not abstracted over.

Rally already has `pollingActivity` with its required `normalizeHighWatermark`
hook, and Google's Gmail, Calendar and Drive streams run on it. Canva declares
streams against that runner; "no generalization" means not inventing an
abstraction over two providers' cursors, not ignoring the runner that exists.
One thing does have to change around it: activity has so far been
workspace-scoped, and this is a personal connection delivering events to its
owner. [`automation-lifecycle.md`](../../automation-lifecycle.md) already
anticipates it — *"a connector that later delivers events to personal
connections declares it once, in its adapter, and both surfaces follow."* Canva
is that connector.

### The two streams

**`design.revised`** — compare `get-design.updated_at` for the named design.
The 2026-09-18 browser probe observed advances for title, text and layout-only
edits. `get-design-content` returned text, not `metadata.revision_id`; no
revision cursor was observed. A notification means the design changed since
its previous observation, potentially coalescing edits. Metadata/page reads can
lag the editor. Do not promise every revision, an edit count, precise latency,
or that a text diff explains layout changes. Same-timestamp edits and broader
provider consistency guarantees remain unverified.

**`design.commented`** — scan complete `list-comments` pages and deduplicate
thread IDs. New replies require separate complete `list-replies` scans for
existing threads and reply-ID deduplication; neither parent nor design timestamps
advanced when replies were added. Define whether this trigger includes replies
before exposing its label; the proposed discussion watch includes both and
carries a thread ID plus an optional reply ID. Resolution was observable through
`thread_type.resolver`, also without a timestamp advance; it is not a third
trigger. Do not timestamp-skip threads if inspecting their current state.

Newest-first threads and oldest-first replies were observed, not guaranteed.
Follow continuations until absent, including the observed final empty page.
A thread inserted during paging appeared on the next fresh scan; repeated scans
must deduplicate durable IDs rather than assume a page cursor is a snapshot.
Establish complete initial baselines without announcing historical activity.
Durably couple detected activities with their checkpoints; a partial scan,
malformed result or failure must not acknowledge unseen activity. Test restart
and delivery deduplication through Rally's real polling/queue path.

Watches are explicit opt-ins on named designs, with clear pause/remove controls,
and never enabled merely by connecting. Their cost is metadata calls plus thread
pages plus reply pages across watched threads, including old threads. This can
grow substantially; scheduling and watch ceilings remain owner decisions, not
claims that a single per-minute limit makes capacity irrelevant.

### Why discovery is not a third stream

`search-designs` advertises modified ordering and ownership filters. That is not
a change cursor: if B changes and then the previously top design A changes,
newest-first may still return A then B, so stopping at A misses B. A newly shared
design may retain an old modification time. `ownership: shared` is inventory,
not a share-event feed; query-based searches also describe relevance ordering.
Account-wide discovery remains out of scope, and its incremental reliability is
not established by the catalog.

### What the adapter declares

Two proposed triggers, both narrowing to one `canva_design`, and nothing else.
Expose them only after their acceptance tests and audience policy pass:

| Trigger | Digestibility | Filter fields | Resource relationship |
| --- | --- | --- | --- |
| `design.revised` | digestible | `designId`, `designTitle` | `design` → `canva_design` |
| `design.commented` | digestible | `designId`, `designTitle`, `threadId`, optional `replyId` | `design` → `canva_design` |

`resourceTypes: ["canva_design"]`, `supportsPolling: true`,
`supportsWebhooks: false`, `supportsWatches: true`. The resource type
materializes on every watch, so a rule can name a deck and `resources_search`
returns something — the Granola gap, avoided by construction.

Declaring exactly these two is as important as declaring nothing else. A personal
Granola or Fireflies connection once advertised its connector's full trigger set
while `normalize` refused every non-workspace connection, so the drafting model
built Sidekicks on events that could never arrive and they stayed silent forever,
indistinguishable in the product from a Sidekick with nothing to do yet.

### Canva as the hands, which is still the main story

A personal connection may be bound by its owner or the run-as principal, so a
Sidekick that member owns can use Canva at the end of work something else
started:

- A Linear project reaching *shipped* triggers a run that calls
  `search-brand-templates`, `create-design-from-brand-template` and
  `export-design`, and returns assets to an authorized audience, subject to the policy gate below.
- A weekly schedule exports the current state of a named deck as a dated
  snapshot.
- A run that has just written copy calls `generate-design` to draft the graphic
  beside it.
- And now: a watched deck gains a comment, and the Sidekick reads the thread with
  `list-replies`, checks it against the messaging the work stream holds, and
  answers with `reply-to-comment`.

## Provider policy and audience gate

The [usage policy](https://www.canva.dev/docs/mcp/usage-policy/), reviewed
2026-09-18, requires opt-in and controls for background access. Shared agents
cannot run on someone else's token; users need their own Canva authentication
to run them or access Canva-derived outputs. Clarify compatibility with shared
Rally work streams and digests before exposing those outputs to other members;
ordinary workspace membership is not evidence of permission. Never assume an
exception from the policy's separate delegation provision.

Canva-sourced data must not enter external-model training or evaluation.
Brand Kits stay within Canva design workflows. Preserve operational data
minimization, applicable credit visibility, provider error monitoring and
bounded backoff; their mechanism follows existing infrastructure and their
unset numeric bounds follow the rule below.

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
- The polling interval's floor — the agreed pattern says no faster than ten
  minutes, and the number itself is the team's — and the ceiling on how many
  designs one work stream may watch and how many watches one member may hold.
