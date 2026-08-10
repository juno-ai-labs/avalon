# Linear integration architecture

Current as of August 2, 2026. This design follows Linear's public [OAuth](https://linear.app/developers/oauth-2-0-authentication), [OAuth app manifest](https://linear.app/developers/oauth-app-manifests), [webhook](https://linear.app/developers/webhooks), [agent](https://linear.app/developers/agents), and [agent interaction](https://linear.app/developers/agent-interaction) contracts.

## Decision

Avalon uses one publicly installable Linear OAuth app with two composable connector surfaces:

| Surface | Capability kind | Production state | Purpose |
| --- | --- | --- | --- |
| `resource` | `tool` | Enabled | Read, create, update, attach, watch, and automate Linear resources. |
| `native_agent` | `native_agent` | `protocol_only` | Let Linear delegate work to or mention Avalon through Agent Sessions. |

`native_agent` is not a model-callable tool. It is a provider control-plane protocol with its own authorization, signed invocation, session ownership, deadlines, cancellation, activities, and outbound signals.

Public installation and Linear Integration Directory publication are separate. The app can be made installable by outside Linear workspaces before applying for directory review.

## One app and two regions

The single app registers both regional OAuth callbacks:

- `https://api.with-avalon.com/connections/linear/callback`
- `https://eu.api.with-avalon.com/connections/linear/callback`

It has one webhook:

- `https://linear.with-avalon.com/ingest/linear`

OAuth state sends each callback directly to the workspace's chosen regional Worker. The shared webhook ingress verifies Linear's exact signed bytes, reads only the organization routing key, and forwards the untouched bytes to the owning regional data plane. Each region verifies the signature again before regional persistence. Global keeps only the opaque route; provider content remains in its selected region.

## OAuth

- Use Authorization Code with PKCE S256.
- A personal Avalon connection requests `actor=user`. Its tools act as the authorizing Linear user, are available only to that Avalon member, and may include private teams that user can access.
- A workspace Avalon connection requests `actor=app`. Its tools act as Avalon, are available to every member of the Avalon workspace, and are limited to the teams selected while installing the app.
- One public Linear app supports both modes. A person who wants both identities authorizes it twice, once for each actor. The sealed Avalon OAuth state—not the requested provider scopes—selects the actor.
- Request only capability-derived scopes. Do not request `admin`; Linear app actors do not support it.
- Treat refresh-token rotation as an atomic credential update and retain the previous token only for Linear's documented replay grace behavior.
- Verify the returned scopes before marking a connection healthy.
- Store the organization ID for both modes, the authorized Linear user ID for personal connections, and the app-user ID for workspace connections. Reconnects must preserve both the organization and actor identity.
- `linear.agent` is workspace-only because delegation and mentions target the Avalon app actor, not a human user actor.

| Avalon capability | Linear scopes |
| --- | --- |
| `linear.read` | `read` |
| `linear.issue.create` | `issues:create` |
| `linear.comment.create` | `comments:create` |
| `linear.write` | `write` |
| `linear.agent` | `app:assignable`, `app:mentionable`, `write` |

## Resource surface

The production manifest subscribes only to resource, lifecycle, and permission events Avalon can use. Canonical activity types are snake-cased, delivery-idempotent, and associated with attachable resources where the provider exposes a stable object.

| Linear family | Avalon resource | Use |
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

Large raw deliveries are retained regionally in R2; D1 stores compact normalized metadata and idempotency state. Resource hydration uses bounded GraphQL queries at context time.

## Webhook contract

- Verify the HMAC over the exact raw body before parsing.
- Validate the provider timestamp inside the documented replay window.
- Use `Linear-Delivery` as the delivery idempotency key.
- Return exact HTTP 200 for accepted deliveries; other 2xx codes do not satisfy Linear's contract.
- Resource deliveries use the ordinary regional activity pipeline.
- Workspace app connections receive matching organization resource events directly. A personal connection receives an organization delivery only after one bounded, aliased GraphQL query made with that connection's token proves access to the signed resource or a signed parent. The resulting activity remains owner-only. Missing/revoked authorization marks the connection `needs_reconnect`; provider failures fail the delivery so Linear can retry. Never fan an organization webhook to a personal connection solely because its organization ID matches, and never fan lifecycle or native-agent events to personal connections.
- A production native-agent runtime must durably accept the invocation and acknowledge inside Linear's five-second deadline without waiting for the full agent run.
- Once that durable admission succeeds, the host control plane—not the model—immediately creates a `👀` reaction on the triggering `sourceCommentId` before model or tool processing begins. Issue-only delegations without a source comment skip the reaction. This is supplemental to, and does not replace, Linear's first-activity deadline.

## Native-agent surface

Linear's Agent APIs remain Developer Preview. Subscribing to `AgentSessionEvent` immediately exposes Agent Session UI to customers, including when the subscription is added only for debugging. Therefore the production resource manifest does not subscribe to it.

The first-class connector metadata records:

- the authorizing capability (`linear.agent`);
- preview maturity and `protocol_only` versus `operational` runtime state;
- delegation, mention, and follow-up invocation modes;
- thought, action, elicitation, response, and error activities;
- cancellation, external links, plans, and proactive sessions;
- single-connection ownership per Linear provider account;
- the five-second webhook deadline and ten-second first-activity/external-link deadline.

Signed native events must match organization ID, granted `linear.agent`, and the stored Linear `appUserId`. A resource-only connection must never receive a delegation. The operational runtime must also enforce one active Avalon native-agent owner per Linear organization/app identity so one delegation cannot start work in multiple Avalon tenants.

Agent-session activation requires all of the following:

1. A fast durable inbox that can meet the five-second webhook acknowledgement SLO.
2. A unique session-to-Avalon-workspace/workstream/run mapping.
3. A durable outbound activity outbox with stable provider activity IDs across retries.
4. A deterministic `👀` source-comment acknowledgement before processing, followed by an immediate thought or external workstream URL inside ten seconds.
5. Prompt resumption based on immutable Agent Activity history.
6. Stop-signal propagation that halts tools/model work immediately and emits exactly one final response or error.
7. Auth and select elicitation/resumption behavior.
8. Plan replacement and proactive-session acceptance tests.
9. Metrics and alarms for both provider deadlines.

Until those pass, the API rejects `linear.agent` authorization even if an operator accidentally turns on the feature flag, and stale Agent Session deliveries are signed-verified and acknowledged without starting work.

## Registration stages

- `config/provider-apps/linear.json` is the production resource configuration.
- `config/provider-apps/linear-native-agent.preview.json` is a future update to that same app after native-agent acceptance. It is not a second app.

Activating the preview later requires all three controls:

1. Change the connector's native runtime state to `operational` after the acceptance suite passes.
2. Set `LINEAR_NATIVE_AGENT_ENABLED=true` in both regional Workers and build the desktop app with `VITE_LINEAR_NATIVE_AGENT_ENABLED=true`.
3. Update the registered public app from the resource manifest to the preview manifest.

## Directory-readiness checklist

- Public name, icon, description, homepage, support contact, privacy policy, and terms are production-ready.
- Requested scopes exactly match documented features.
- OAuth cancellation, partial consent, revoked grants, rotating refresh tokens, and reconnect flows are tested.
- Webhook signature, replay, deduplication, retry, and regional-boundary tests pass.
- Every subscribed event is either a typed activity/resource or a deliberate lifecycle signal.
- The app has customer-facing setup, disconnect, deletion, and data-retention documentation.
- Native-agent directory claims remain absent until the operational acceptance gate passes.
