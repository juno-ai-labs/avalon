# Documentation index

Every engineering, product, and operations document for Avalon lives in this
folder. Read the document whose scope matches what you are about to touch, and
update it in the same change.

## How to use this index

- **Planning a change?** Find the document that owns the area, read it first,
  and update it alongside the code. A change spanning several subsystems updates
  each affected document.
- **Starting a session?** [`dev-environment.md`](dev-environment.md) is the one
  to read before running any setup, server, or browser-automation command.
- **Investigating a bug?** The owning document usually states the invariant that
  was violated, and often names the exception you are looking at.
- **Onboarding?** [`PRD.md`](PRD.md) for what Avalon is, then
  [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it is put together, then
  [`DATA_MODEL.md`](DATA_MODEL.md) and [`SECURITY.md`](SECURITY.md).
- **Adding a document?** Create `docs/<NAME>.md`, register it in the correct
  table below, and add it to the Documentation list in the root
  [`README.md`](../README.md).

## Product and architecture

| Document | Scope — read and update when changing… |
| --- | --- |
| [`PRD.md`](PRD.md) | The product contract: work streams as the organizing unit, the agent's role, and the visual language. Read before changing what Avalon *is*. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The monorepo's three deployment surfaces, the Electron main/renderer split, the Hono Worker and its runtime components, and how the packages depend on each other. |
| [`DATA_MODEL.md`](DATA_MODEL.md) | Identity, tenancy, and the D1 schema — the checked-in migrations are authoritative. Read before adding a table, column, or migration. |
| [`REGIONALIZATION.md`](REGIONALIZATION.md) | The Global/EU boundary: single identity endpoint, the Global control plane's membership and invitation discovery, immutable workspace region. Read before touching anything cross-region. |
| [`SECURITY.md`](SECURITY.md) | Trust boundaries — renderer isolation, contextIsolation and sandboxing, CSP, validated IPC, what is treated as untrusted. Read before changing any of those. |
| [`ASSUMPTIONS.md`](ASSUMPTIONS.md) | Low-level ambiguities resolved without changing the product contract. Add to it when you make such a call. |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) | The phased build checklist and its current state. |

## Agent, connectors, and integrations

| Document | Scope — read and update when changing… |
| --- | --- |
| [`AGENT_HARNESS.md`](AGENT_HARNESS.md) | The bounded Bind 10 adapter over OpenRouter: run admission, tool execution, streaming, receipts, and what the Workflow host owns versus what Bind owns. |
| [`CONNECTORS.md`](CONNECTORS.md) | The connector registry and manifest model — OAuth needs, personal versus workspace scopes, activity and resource types, tools, polling, webhooks, watches. Read before adding or changing an adapter. |
| [`PROVIDER_APPS.md`](PROVIDER_APPS.md) | Provider app registrations and their regional routing, plus the source manifests in `config/provider-apps`. Read before changing a registration or callback. |
| [`LINEAR_INTEGRATION.md`](LINEAR_INTEGRATION.md) | The Linear OAuth, webhook, and native-agent design against Linear's published contracts. |
| [`SLACK_INTEGRATION.md`](SLACK_INTEGRATION.md) | The Slack Agent connector's product boundary, tools, and event handling. |
| [`SLACK_PERMISSIONS.md`](SLACK_PERMISSIONS.md) | Every configured Slack OAuth scope and the behavior that depends on it. Read before adding a scope. |
| [`WORKSTREAM_EMAIL_ADDRESSES.md`](WORKSTREAM_EMAIL_ADDRESSES.md) | The permanent per-work-stream and per-automation address format at `automation.with-avalon.com`, and its derivation. |

## Development, verification, and operations

| Document | Scope — read and update when changing… |
| --- | --- |
| [`dev-environment.md`](dev-environment.md) | **Read at the start of every session.** Install, the local D1 database, starting both regional Workers, and running the Electron client headlessly with screenshots. |
| [`SANDBOX.md`](SANDBOX.md) | The Claude Code remote sandbox: environment definition, setup script, egress host list, and version parity against CI and production. |
| [`sandbox-proxy.md`](sandbox-proxy.md) | Outbound HTTPS failures behind the sandbox proxy — policy denials versus clients that break on the CONNECT tunnel — and the fix for each. |
| [`E2E.md`](E2E.md) | The local smoke check and the manual desktop acceptance flows for the sidebar, signup, invitations, settings, realtime recovery, and dictation. |
| [`RUNBOOK.md`](RUNBOOK.md) | Operations: hosted resources per region, secrets, migrations, health verification, deployment, and provider acceptance. |
| [`pull-requests.md`](pull-requests.md) | The required shape of every pull request description, plus the repository's merge style. Read before opening a PR. |
| [`DESKTOP_ICONS.md`](DESKTOP_ICONS.md) | The native adaptive icon, the selectable icon set, and the generation pipeline. Read before changing the artwork. |

## Related material outside this folder

- [`AGENTS.md`](../AGENTS.md) (symlinked as `CLAUDE.md`) — the rule sheet AI
  coding agents read at session start.
- [`README.md`](../README.md) — repository overview, local setup, quality
  commands, and the desktop release process.
- `config/provider-apps` — the source provider manifests that
  [`PROVIDER_APPS.md`](PROVIDER_APPS.md) describes.
