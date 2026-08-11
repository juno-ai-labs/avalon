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
- **Onboarding?** [the Avalon implementation
  brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md) for what Avalon is,
  then [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it is put together, then
  [`DATA_MODEL.md`](DATA_MODEL.md) and [`SECURITY.md`](SECURITY.md).
- **Adding a document?** Create `docs/<NAME>.md` and register it in the correct
  table below. This index is the only registry — the root
  [`README.md`](../README.md) points here instead of listing documents, so there
  is nothing to update there. **A PRD is the exception**: it goes in a dated
  folder under `docs/PRDs/` per [`prds.md`](prds.md), and is registered here at
  all only through the `prds.md` row.

## Product and architecture

| Document | Scope — read and update when changing… |
| --- | --- |
| [`prds.md`](prds.md) | How a product requirement document under `docs/PRDs/` is named, which sections it must contain, how its `state.md` records progress, and when it freezes. Read before writing one. The PRD folders themselves are not listed in this index; this row is the tree's entry, and [the Avalon implementation brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md) is the standing product contract it defers to. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The monorepo's three deployment surfaces, the Electron main/renderer split, the Hono Worker and its runtime components, and how the packages depend on each other. |
| [`DATA_MODEL.md`](DATA_MODEL.md) | Identity, tenancy, and the D1 schema — the checked-in migrations are authoritative. Read before adding a table, column, or migration. |
| [`REGIONALIZATION.md`](REGIONALIZATION.md) | The Global/EU boundary: single identity endpoint, the Global control plane's membership and invitation discovery, immutable workspace region. Read before touching anything cross-region. |
| [`SECURITY.md`](SECURITY.md) | Trust boundaries — renderer isolation, contextIsolation and sandboxing, CSP, validated IPC, what is treated as untrusted. Read before changing any of those. |
| [`workstream-descriptions.md`](workstream-descriptions.md) | The loop that keeps a work stream's description true as the work moves: the transcript window it reads, the throttle that stops it churning, the guards that stop it generalizing, and where `description_source` comes from. Read before changing how a description is written or displayed. |
| [`composer-drafts.md`](composer-drafts.md) | The on-device cache behind every composer: which surfaces keep a draft, how text and attachment bytes are stored and keyed, when a draft expires or is cleared, and how one is restored. Read before changing a composer, the attachment hook, or the draft cache. |
| [`ASSUMPTIONS.md`](ASSUMPTIONS.md) | Low-level ambiguities resolved without changing the product contract. Add to it when you make such a call. |
| [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) | The phased build checklist and its current state. |

## Agent, connectors, and integrations

| Document | Scope — read and update when changing… |
| --- | --- |
| [`AGENT_HARNESS.md`](AGENT_HARNESS.md) | The bounded Bind 11 adapter over OpenRouter: run admission, tool execution, loadable skills, streaming, receipts, and what the Workflow host owns versus what Bind owns. |
| [`agent-tools.md`](agent-tools.md) | How to *design* an agent tool — names, parameters, discovery, errors, limits, idempotency, and the id-family rules — so a small model uses it correctly first try. Read before adding or reshaping a tool; the harness mechanics stay in `AGENT_HARNESS.md`. |
| [`writing-skills.md`](writing-skills.md) | How to *author* a skill: the catalog line that decides when it loads, the body that has to execute, bundled resources, and why loading one grants no authority. Read before adding a skill; the skill system stays in `AGENT_HARNESS.md`. |
| [`writing-prompts.md`](writing-prompts.md) | How to *write* the standing policy, classifier prompts, and rendered catalogs in `packages/agent-harness/src/prompts/` — altitude, authority layering, what belongs in policy rather than a skill, and byte-stability. Read before editing any prompt; the shipped prompts are not exemplars. |
| [`FEATURE_FLAGS.md`](FEATURE_FLAGS.md) | The Cloudflare Flagship binding and the per-agent model-routing flags it serves. Read before adding a flag or changing which OpenRouter model an agent runs on. |
| [`CONNECTORS.md`](CONNECTORS.md) | The connector registry and manifest model — OAuth needs, personal versus workspace scopes, activity and resource types, tools, polling, webhooks, watches. Read before adding or changing an adapter. |
| [`PROVIDER_APPS.md`](PROVIDER_APPS.md) | Provider app registrations and their regional routing, plus the source manifests in `config/provider-apps`. Read before changing a registration or callback. |
| [`LINEAR_INTEGRATION.md`](LINEAR_INTEGRATION.md) | The Linear OAuth, webhook, and native-agent design against Linear's published contracts. |
| [`SLACK_INTEGRATION.md`](SLACK_INTEGRATION.md) | The Slack Agent connector's product boundary, tools, and event handling. |
| [`SLACK_PERMISSIONS.md`](SLACK_PERMISSIONS.md) | Every configured Slack OAuth scope and the behavior that depends on it. Read before adding a scope. |
| [`WORKSTREAM_EMAIL_ADDRESSES.md`](WORKSTREAM_EMAIL_ADDRESSES.md) | The permanent per-work-stream and per-automation address format at `automation.with-avalon.com`, and its derivation. |
| [`WORKSTREAM_LINKS.md`](WORKSTREAM_LINKS.md) | The canonical `https://with-avalon.com/app/workstreams/<uuid>` link, why the id sits in the path, and the site rewrite that serves it. Read before emitting or parsing a work-stream link anywhere. |

## Development, verification, and operations

| Document | Scope — read and update when changing… |
| --- | --- |
| [`dev-environment.md`](dev-environment.md) | **Read at the start of every session.** Install, the local D1 database, starting both regional Workers, and running the Electron client headlessly with screenshots. |
| [`SANDBOX.md`](SANDBOX.md) | The Claude Code remote sandbox: environment definition, setup script, egress host list, and version parity against CI and production. |
| [`sandbox-proxy.md`](sandbox-proxy.md) | Outbound HTTPS failures behind the sandbox proxy — policy denials versus clients that break on the CONNECT tunnel — and the fix for each. |
| [`E2E.md`](E2E.md) | The local smoke check and the manual desktop acceptance flows for the sidebar, signup, invitations, settings, realtime recovery, and dictation. |
| [`RUNBOOK.md`](RUNBOOK.md) | Operations: hosted resources per region, secrets, migrations, health verification, deployment, and provider acceptance. |
| [`pull-requests.md`](pull-requests.md) | The required shape of every pull request description, plus the repository's merge style and its no-draft rule. Read before opening a PR; `.github/pull_request_template.md` is its layout and changes with it. |
| [`DESKTOP_ICONS.md`](DESKTOP_ICONS.md) | The native adaptive icon, the selectable icon set, and the generation pipeline. Read before changing the artwork. |

## Related material outside this folder

- [`AGENTS.md`](../AGENTS.md) (symlinked as `CLAUDE.md`) — the rule sheet AI
  coding agents read at session start.
- [`README.md`](../README.md) — repository overview, local setup, quality
  commands, and the desktop release process.
- `config/provider-apps` — the source provider manifests that
  [`PROVIDER_APPS.md`](PROVIDER_APPS.md) describes.
