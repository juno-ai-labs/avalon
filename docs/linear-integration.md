# Linear integration

Rally installs into Linear as **one publicly installable OAuth app** carrying two
composable connector surfaces: a `resource` surface that reads and writes Linear
objects through model-callable tools, and a `native_agent` surface that lets Linear
delegate work to Rally through Agent Sessions. The second is not a tool — it is a
provider control-plane protocol with its own authorization, signed invocation,
session ownership, deadlines, cancellation, activities, and outbound signals — and
it ships in a `protocol_only` state that refuses to start work.

The design follows Linear's published
[OAuth](https://linear.app/developers/oauth-2-0-authentication),
[OAuth app manifest](https://linear.app/developers/oauth-app-manifests),
[webhook](https://linear.app/developers/webhooks),
[agent](https://linear.app/developers/agents), and
[agent interaction](https://linear.app/developers/agent-interaction) contracts.
Read it before changing the manifests in `config/provider-apps`, the callback or
ingress routing, the scope mapping, or anything on the native-agent path — several
of the rules below are Linear's, and breaking them fails at the provider rather
than in a test.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/connectors/src/linear.ts` | The resource adapter: authorization, scopes, webhook normalization, resource types, tools, hydration. |
| `packages/connectors/src/linear-agent.ts` | The native-agent connector metadata — invocation modes, activity kinds, deadlines, runtime state. |
| `apps/api/src/services/linear-routing-service.ts` | The Global organization-to-region directory. |
| `apps/api/src/linear-routing-bridge.ts` | The route lookup exposed to the shared ingress. |
| `apps/api/src/linear-regional-bridge.ts` | The named RPC hop that carries exact signed bytes to the owning region. |
| `apps/api/src/routes/connections.ts` | Both regional OAuth callbacks. |
| `config/provider-apps/linear.json` | The production resource manifest — what is registered today. |
| `config/provider-apps/linear-native-agent.preview.json` | A future update to that same app. Not a second app. |

### Two surfaces on one app

| Surface | Capability kind | Production state | Purpose |
| --- | --- | --- | --- |
| `resource` | `tool` | Enabled | Read, create, update, attach, watch, and automate Linear resources. |
| `native_agent` | `native_agent` | `protocol_only` | Let Linear delegate work to or mention Rally through Agent Sessions. |

Public installation and Linear Integration Directory publication are separate
milestones. The app can be made installable by outside Linear workspaces before
applying for directory review.

### One app, configured deployments

The single app registers both regional OAuth callbacks:

- `https://api.rallywith.ai/connections/linear/callback`
- `https://api.with-avalon.com/connections/linear/callback`

It has one webhook:

- `https://linear.rallywith.ai/ingest/linear`

OAuth state sends each callback directly to the workspace's chosen regional
Worker. The shared webhook ingress verifies Linear's exact signed bytes, reads only
the organization routing key, and forwards the untouched bytes to the owning
regional data plane. Each region verifies the signature again before regional
persistence. Global keeps only the opaque route; provider content remains in its
selected region. [`regionalization.md`](regionalization.md) owns the boundary this
sits on.

### OAuth

Authorization Code with PKCE S256, in one of two actor modes:

- A **personal** Rally connection requests `actor=user`. Its tools act as the
  authorizing Linear user, are available only to that Rally member, and may
  include private teams that user can access.
- A **workspace** Rally connection requests `actor=app`. Its tools act as Rally,
  are available to every member of the Rally Organization, and are limited to the
  teams selected while installing the app.

One public Linear app supports both. A person who wants both identities authorizes
it twice, once per actor, and **the sealed Rally OAuth state — not the requested
provider scopes — selects the actor.**

The shared callback also forwards the adapter's `authorizationState` metadata.
Linear accepts that field without using it to select the actor; the explicit
`connectionScope` recovered from sealed OAuth state remains required.

Scopes are capability-derived, never broader:

| Rally capability | Linear scopes |
| --- | --- |
| `linear.read` | `read` |
| `linear.issue.create` | `issues:create` |
| `linear.comment.create` | `comments:create` |
| `linear.write` | `write` |
| `linear.agent` | `app:assignable`, `app:mentionable`, `write` |

`admin` is never requested — Linear app actors do not support it. `linear.agent` is
workspace-only, because delegation and mentions target the Rally app actor rather
than a human user actor.

Refresh-token rotation is an atomic credential update; the previous token is
retained only for Linear's documented replay grace behavior. The returned scopes
are verified before a connection is marked healthy. Both modes store the
organization ID; personal connections additionally store the authorizing Linear
user ID and workspace connections the app-user ID.

### Resource surface

The production manifest subscribes only to resource, lifecycle, and permission
events Rally can use. Canonical activity types are snake-cased,
delivery-idempotent, and associated with attachable resources wherever the provider
exposes a stable object.

| Linear family | Rally resource | Use |
| --- | --- | --- |
| Issue | `linear_issue` | Work items and automations |
| Comment | `linear_comment` | Discussion context |
| Attachment | `linear_attachment` | Linked external work |
| IssueLabel | `linear_issue_label` | Classification changes |
| Project | `linear_project` | Project context |
| ProjectUpdate | `linear_project_update` | Status/reporting context |
| ProjectLabel | `linear_project_label` | Project classification |
| Cycle | `linear_cycle` | Planning-window context |
| Document | `linear_document` | Long-form knowledge |
| User | `linear_user` | Actor and assignment context |
| Reaction | Activity only | Lightweight feedback signal |
| OAuthAuthorization / PermissionChange | Lifecycle only | Reconnect and access reconciliation |

Large raw deliveries are retained regionally in R2; D1 stores compact normalized
metadata and idempotency state. Resource hydration uses bounded GraphQL queries at
context time.

### Webhook contract

- Verify the HMAC over the exact raw body before parsing.
- Validate the provider timestamp inside the documented replay window.
- Use `Linear-Delivery` as the delivery idempotency key.
- Return exact HTTP 200 for accepted deliveries; other 2xx codes do not satisfy
  Linear's contract.
- Resource deliveries use the ordinary regional activity pipeline.
- Workspace app connections receive matching organization resource events directly.
  A personal connection receives an organization delivery only after one bounded,
  aliased GraphQL query made with that connection's token proves access to the
  signed resource or a signed parent. The resulting activity remains owner-only.
- A production native-agent runtime must durably accept the invocation and
  acknowledge inside Linear's five-second deadline without waiting for the full
  agent run. Once that durable admission succeeds, the host control plane — not the
  model — immediately creates a `👀` reaction on the triggering `sourceCommentId`
  before model or tool processing begins. Issue-only delegations without a source
  comment skip the reaction. This is supplemental to, and does not replace,
  Linear's first-activity deadline.

### Native-agent surface

Linear's Agent APIs remain Developer Preview, and **subscribing to
`AgentSessionEvent` immediately exposes Agent Session UI to customers** — including
when the subscription is added only for debugging. The production resource manifest
therefore does not subscribe to it.

The first-class connector metadata records:

- the authorizing capability (`linear.agent`);
- preview maturity and `protocol_only` versus `operational` runtime state;
- delegation, mention, and follow-up invocation modes;
- thought, action, elicitation, response, and error activities;
- cancellation, external links, plans, and proactive sessions;
- single-connection ownership per Linear provider account;
- the five-second webhook deadline and ten-second first-activity/external-link
  deadline.

Agent-session activation requires all of the following to pass first:

1. A fast durable inbox that can meet the five-second webhook acknowledgement SLO.
2. A unique session-to-Rally-workspace/workstream/run mapping.
3. A durable outbound activity outbox with stable provider activity IDs across
   retries.
4. A deterministic `👀` source-comment acknowledgement before processing, followed
   by an immediate thought or external Rally conversation URL inside ten seconds.
5. Prompt resumption based on immutable Agent Activity history.
6. Stop-signal propagation that halts tool and model work immediately and emits
   exactly one final response or error.
7. Auth and select elicitation/resumption behavior.
8. Plan replacement and proactive-session acceptance tests.
9. Metrics and alarms for both provider deadlines.

### Promoting the preview

Activating the native-agent surface later requires all three controls, in this
order:

1. Change the connector's native runtime state to `operational` after the
   acceptance suite passes.
2. Set `LINEAR_NATIVE_AGENT_ENABLED=true` in configured regional Workers and build the
   desktop app with `VITE_LINEAR_NATIVE_AGENT_ENABLED=true`.
3. Update the registered public app from the resource manifest to the preview
   manifest.

## Invariants

- **The sealed OAuth state selects the actor, not the requested scopes.** A
  callback that infers the actor from what the provider returned can attach an app
  actor's authority to a personal connection.
- **Never fan an organization webhook to a personal connection solely because its
  organization ID matches**, and never fan lifecycle or native-agent events to
  personal connections. Access must be proved per delivery by that connection's own
  token.
- **Signed native events must match organization ID, granted `linear.agent`, and
  the stored Linear `appUserId`.** A resource-only connection must never receive a
  delegation.
- **One active Rally native-agent owner per Linear organization and app
  identity.** Without it, one delegation can start work in multiple Rally tenants.
- **Reconnects preserve both the organization and the actor identity.** A reconnect
  that silently changes either produces a connection whose stored history describes
  a different principal.
- **Only capability-derived scopes are requested**, and the returned scopes are
  verified before the connection is marked healthy — Linear may grant less than was
  asked for.
- **Exact HTTP 200 for an accepted delivery.** Linear's contract does not accept
  other 2xx codes, and a 202 reads as a failure that will be retried.
- **The production manifest does not subscribe to `AgentSessionEvent`**, at any
  time, for any reason, until the acceptance gate passes — the subscription itself
  is what ships the UI.
- **`config/provider-apps/linear-native-agent.preview.json` is an update to the
  same app**, never a second registration. Registering it as a second app splits
  every installation.

## Boundary

This document owns Rally's design against Linear's contracts: the app shape, the
scope mapping, the routing, and the native-agent gate. It does not own:

| For | Read |
| --- | --- |
| The registry, manifests, and adapter rules every connector obeys | [`connectors.md`](connectors.md) |
| The registration itself and its regional routing | [`provider-apps.md`](provider-apps.md) |
| Which Linear activity types are declared digestible | [`connector-digestibility.md`](connector-digestibility.md) |
| The configured deployment boundary the shared ingress sits on | [`regionalization.md`](regionalization.md) |
| The flag that gates the native-agent surface | [`feature-flags.md`](feature-flags.md) |
| Credential encryption and webhook verification rules | [`security.md`](security.md) |

## Failure modes and limits

- **Until the acceptance gate passes, the API rejects `linear.agent` authorization
  even if an operator accidentally turns on the feature flag**, and stale Agent
  Session deliveries are signature-verified and acknowledged without starting work.
  The flag alone is not sufficient to start an agent session, deliberately.
- **A personal connection whose proving query returns missing or revoked
  authorization marks the connection `needs_reconnect`.** A provider *failure* —
  as opposed to a denial — fails the delivery instead, so Linear retries rather
  than Rally silently dropping an event.
- **Five seconds to acknowledge a native invocation, ten seconds to the first
  activity or external link.** Both are Linear's, both need alarms, and neither can
  wait on a model turn.
- **Linear's Agent APIs are Developer Preview** and may change under the recorded
  metadata; the `protocol_only` state exists so that a change breaks a manifest
  rather than a running session.

## Testing

| Suite | Covers |
| --- | --- |
| `packages/connectors/src/linear.test.ts` | Scope derivation, actor selection from sealed state, webhook normalization, resource mapping, and the personal-connection access proof. |
| `apps/api/test/linear-oauth.test.ts` | Both connection scopes through the shared service callback, with migrated regional and object schemas, simulated Linear endpoints, and persisted connection/attempt/routing assertions. |
| `packages/connectors/src/linear-agent.test.ts` | The native-agent metadata: invocation modes, activity kinds, deadlines, and the `protocol_only` refusal. |
| `apps/api/test/linear-routing.test.ts` | The organization-to-region directory and the forwarding of exact signed bytes. |
| `packages/connectors/src/digestibility-doc.test.ts` | That every declared Linear activity type has a row in [`connector-digestibility.md`](connector-digestibility.md). |

Run a single file from the package directory —
`pnpm --filter @rally/connectors exec vitest run src/linear.test.ts` — the path is
package-relative, not repo-relative.

The trap is that signature fixtures are byte-exact. A test that re-serializes a
webhook body before signing it will pass while the production path, which verifies
over the untouched raw body, fails on the same delivery.

## Directory readiness

Before applying for Linear Integration Directory review:

- Public name, icon, description, homepage, support contact, privacy policy, and
  terms are production-ready.
- Requested scopes exactly match documented features.
- OAuth cancellation, partial consent, revoked grants, rotating refresh tokens, and
  reconnect flows are tested.
- Webhook signature, replay, deduplication, retry, and regional-boundary tests
  pass.
- Every subscribed event is either a typed activity/resource or a deliberate
  lifecycle signal.
- The app has customer-facing setup, disconnect, deletion, and data-retention
  documentation.
- Native-agent directory claims remain absent until the operational acceptance gate
  passes.

## Changelog

### 2026-09-17 — Linear accepts the shared OAuth callback envelope

**What changed:** The callback validator accepts the optional
`authorizationState` field passed by `ConnectionService`. Both personal and
workspace flows have service-level regression coverage.

**Why:** Every Linear callback failed before token exchange because the shared
service forwarded this field and Linear's strict schema rejected it. Production
reported `connector_provider_response_invalid` and displayed the generic retry
screen. Adapter-only tests omitted the field and therefore missed the failure.

**Considered and rejected:** Removing the field from the shared service would
break providers that need their saved authorization metadata. Making Linear's
whole callback schema permissive would accept unrelated unknown fields.

**Consequences:** Linear continues validating the code, PKCE verifier, and
explicit connection scope, then verifying the returned actor and granted scopes.
Adapter metadata cannot replace the sealed scope. Callback tests must exercise
the envelope the service actually supplies.

PR: [#810](https://github.com/juno-ai-labs/avalon/pull/810).

### 2026-08-25 — The provider manifest completed Linear's Rally identity cut-over

**What changed:** Both checked-in manifests and the live production registration
now publish Rally descriptions and client names. The broader agent-identity
cut-over in #301 had already changed the native-agent capability and all 24
resource and agent GraphQL operation names; this follow-up adds exact assertions
for those provider-visible names. The same production app, callbacks, scopes,
webhook resource events, client credentials, and signing secret remain in place.

**Why:** Linear exposes the manifest identity to installers and GraphQL operation
names in its request logs. Leaving either surface on Avalon made one integration
present two product identities even after its canonical webhook host moved.

**Considered and rejected:** Creating a replacement Linear app or changing the
OAuth/event contract alongside the rename. Either would introduce new authority,
installation, and delivery behavior unrelated to the public-identity correction.

**Consequences:** Existing authorizations and webhook routing remain valid, and
the four compatibility/canonical callbacks continue to cover the domain migration.
The preview manifest remains a later update to that same app rather than a second
registration, and its preview-only scopes and events remain gated. The reasoning
behind the integration before this entry, beyond the rationale already written
inline, was not recorded or reconstructed.

Shipped in #307; the runtime rename first landed in #301.
