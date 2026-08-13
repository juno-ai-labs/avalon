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
- **Investigating what an agent actually did in production?**
  [`runbook.md`](runbook.md#inspecting-a-runs-raw-inference) turns a work-stream
  URL into the exact request the model received, using credentials the
  environment already holds.
- **Onboarding?** [the Avalon implementation
  brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md) for what Avalon is,
  then [`architecture.md`](architecture.md) for how it is put together, then
  [`data-model.md`](data-model.md) and [`security.md`](security.md).
- **Building or changing an architecture, engine, or large module?** It gets its
  own document here, created or updated in the same change as the code, and every
  such document carries a running changelog recording *why* each change was made.
  [`module-documents.md`](module-documents.md) defines the threshold, the
  sections, and the changelog rules. Read it first.
- **Adding a document?** Create `docs/<lower-kebab-name>.md` and register it in
  the correct table below. Every document here follows that convention —
  `README.md` is the one conventional exception. This index is the only registry — the root
  [`README.md`](../README.md) points here instead of listing documents, so there
  is nothing to update there. **A PRD is the exception**: it goes in a dated
  folder under `docs/PRDs/` per [`prds.md`](prds.md), and is registered here at
  all only through the `prds.md` row.

## Product and architecture

| Document | Scope — read and update when changing… |
| --- | --- |
| [`prds.md`](prds.md) | How a product requirement document under `docs/PRDs/` is named, which sections it must contain, how its `state.md` records progress, and when it freezes. Read before writing one. The PRD folders themselves are not listed in this index; this row is the tree's entry, and [the Avalon implementation brief](PRDs/2026-08-05_avalon-implementation-brief/prd.md) is the standing product contract it defers to. |
| [`module-documents.md`](module-documents.md) | When an architecture or large module needs its own document here, the sections that document must contain, and how its **changelog** is kept — the running record of what changed in a module and, above all, *why*. Read before creating a document for a subsystem or making a substantial change to one that has one. |
| [`architecture.md`](architecture.md) | The monorepo's three deployment surfaces, the Electron main/renderer split, the Hono Worker and its runtime components, and how the packages depend on each other. |
| [`data-model.md`](data-model.md) | Identity, tenancy, and the D1 schema — the checked-in migrations are authoritative. Read before adding a table, column, or migration. |
| [`regionalization.md`](regionalization.md) | The Global/EU boundary: single identity endpoint, the Global control plane's membership and invitation discovery, immutable workspace region. Read before touching anything cross-region. |
| [`security.md`](security.md) | Trust boundaries — renderer isolation, contextIsolation and sandboxing, CSP, validated IPC, what is treated as untrusted. Read before changing any of those. |
| [`telemetry.md`](telemetry.md) | The main-owned regional product-signal and crash-diagnostic boundary: typed collection, route and preference enforcement, local Crashpad generations, regional delivery, destination adapters, restricted operator access, and retention. Read before adding an event, diagnostic, provider mapping, or telemetry control. |
| [`workstream-creation.md`](workstream-creation.md) | Starting a work stream: the optimistic surface that replaces the launcher on the keystroke, the composer hand-off it is built on, and which steps of `POST /workstreams` the caller is made to wait for versus which are deferred. Read before changing the new-work-stream screen, its transition, or anything on the create path. |
| [`workstream-descriptions.md`](workstream-descriptions.md) | The loop that keeps a work stream's description true as the work moves: the transcript window it reads, the throttle that stops it churning, the guards that stop it generalizing, and where `description_source` comes from. Read before changing how a description is written or displayed. |
| [`workstream-origin-attachments.md`](workstream-origin-attachments.md) | The connector place a work stream started from — the Slack thread, the Linear issue, the object a suggestion was built out of — recorded as a resource attached to it with `relationship_type = 'origin'`, before the run launches. Read before adding a path that creates a work stream from connector activity, or changing what an attachment means. |
| [`workstream-pinning.md`](workstream-pinning.md) | The **Pinned** sidebar section and the per-person `workstream_pins` rows behind it: what a pin is an opinion about, why the manual order is stored as a dense run the server rewrites in full, the three endpoints that answer with the whole pinned list, and the first-page backfill that keeps a quiet pin from falling out of the sidebar. Read before changing pinning, the pinned section, or `GET /workstreams` paging. |
| [`meeting-notes.md`](meeting-notes.md) | Meeting recording and **Control Tower**: the one-minute commit-then-refresh cadence, the transcript windows each pass is given, the live and final prompts and why the live one is written for latency, the compare-and-set that lands a briefing, and the note resource the rest of Avalon reads. Read before changing the cadence, either prompt, or the segment protocol. |
| [`realtime-sockets.md`](realtime-sockets.md) | How a WebSocket is admitted: the short-lived ticket the desktop is issued, why it travels in the handshake's `Sec-WebSocket-Protocol` header rather than the URL, the deprecated query transport still accepted for older builds, and which rejections come from the edge versus the room. Read before changing socket admission, the ticket format, or either upgrade route. |
| [`markdown-rendering.md`](markdown-rendering.md) | The one component every markdown surface renders through: what `MarkdownBody` adds on top of `react-markdown` — highlighted code blocks, scrolling tables, mention chips that are never navigable links — the `.markdown-body` styling a host may not restate, and the two guards that keep the renderer single. Read before adding a surface that shows markdown, changing how any of it is styled, or touching the mention link schemes. |
| [`composer-drafts.md`](composer-drafts.md) | The on-device cache behind every composer: which surfaces keep a draft, how text and attachment bytes are stored and keyed, when a draft expires or is cleared, and how one is restored. Read before changing a composer, the attachment hook, or the draft cache. |
| [`automation-drafts.md`](automation-drafts.md) | An automation that is being set up but has not been created: the subscription row it already is, the conversation saved with it, why it carries no schedule, address, or workspace scope, and how creating one promotes it in place. Read before changing the automation compiler's routes, `POST /automations`, the sidebar's automation section, or the New automation screen. |
| [`menu-bar.md`](menu-bar.md) | The macOS status item: its drop-down and where each row goes, how the main process fetches the menu's content without a window, the template-image artwork, the login-item registration, and the hidden launch that follows from it. Read before changing the menu, adding a row, or touching anything that assumes a window exists at startup. |
| [`assumptions.md`](assumptions.md) | Low-level ambiguities resolved without changing the product contract. Add to it when you make such a call. |
| [`implementation-plan.md`](implementation-plan.md) | The phased build checklist and its current state. |

## Agent, connectors, and integrations

| Document | Scope — read and update when changing… |
| --- | --- |
| [`agent-harness.md`](agent-harness.md) | The Bind 11 adapter over OpenRouter: run admission, caller-specific resource policy, tool execution, loadable skills, streaming, receipts, and what the Workflow host owns versus what Bind owns. |
| [`agent-attachments.md`](agent-attachments.md) | The model-facing attachment subsystem: natural-language kind contracts, durable resource identity, derivative lifecycle, bounded hydration, image recovery, and compaction rediscovery. Read before changing attachment projection, extraction, tools, or cleanup. |
| [`context-compaction.md`](context-compaction.md) | What a run remembers once its context fills up: the 80%-of-window trigger measured from provider usage, the sectioned handoff summary the model is asked for, the two-message transcript a compaction leaves behind, and the per-work-stream checkpoint later runs replay. Read before changing the threshold, the summary prompt, the checkpoint shape, or `workstream_context_compactions`. |
| [`agent-tools.md`](agent-tools.md) | How to *design* an agent tool — names, parameters, discovery, errors, limits, idempotency, and the id-family rules — so a small model uses it correctly first try. Read before adding or reshaping a tool; the harness mechanics stay in `agent-harness.md`. |
| [`terminal-workspaces.md`](terminal-workspaces.md) | The deferred Terminal plugin: typed file/command/resource tools, one authority-fenced Daytona sandbox per work stream, workspace egress policy, lifecycle, and trusted GitHub pull-request publication. Read before changing any Terminal tool, sandbox, network, resource, Git, or participant-visible state. |
| [`writing-skills.md`](writing-skills.md) | How to *author* a skill: the catalog line that decides when it loads, the body that has to execute, bundled resources, and why loading one grants no authority. Read before adding a skill; the skill system stays in `agent-harness.md`. |
| [`writing-prompts.md`](writing-prompts.md) | How to *write* the standing policy, classifier prompts, and rendered catalogs in `packages/agent-harness/src/prompts/` — altitude, authority layering, what belongs in policy rather than a skill, and byte-stability. Read before editing any prompt; the shipped prompts are not exemplars. |
| [`digests.md`](digests.md) | The first-party `activity_events` log — what happened in Avalon that a person should hear about, and who may read it — and the scheduled digest that is its first consumer: days and times, the frozen delivery destinations, the hidden system work stream its runs use, and the cursor that keeps it from repeating itself. Read before adding a notification surface, adding something a digest should mention, or changing where a digest can be sent. |
| [`suggested-work.md`](suggested-work.md) | The four suggestions on the home screen: which unclaimed activity becomes a candidate, how admission decides audience and resolves the people it names, the bounded ranking tournament, and the scheduler that runs it in the background for members who are actually around. Read before changing admission, ranking, the `work_opportunities` tables, or `GET /work-opportunities`. |
| [`feature-flags.md`](feature-flags.md) | The Cloudflare Flagship binding and the per-agent model-routing flags it serves, plus the one thing that overrides them — a work stream pinned to a single model from the composer's developer-mode selector. Read before adding a flag or changing which OpenRouter model an agent runs on. |
| [`connectors.md`](connectors.md) | The connector registry and manifest model — OAuth needs, personal versus workspace scopes, activity and resource types, tools, polling, webhooks, watches. Read before adding or changing an adapter. |
| [`hosted-mcp-connectors.md`](hosted-mcp-connectors.md) | The reusable hosted-MCP pass-through: standards-based OAuth helpers, live `tools/list` activation, exact `tools/call` forwarding, conservative write policy, and the small declaration used to add another server. Read before adding or changing a hosted MCP connector. |
| [`connector-digestibility.md`](connector-digestibility.md) | One row per declared activity type, for every connector, saying whether a person should hear about it in a digest and why. A reference for reviewing that judgement in one place; the manifests are authoritative and a test keeps the two in step. |
| [`contextual-routing.md`](contextual-routing.md) | The paused **Suggested context** surface: the shared switch that disables both producers and hides existing cards, plus the retained classifier and feedback design for a future tuning pass. Read before changing or re-enabling work-stream context suggestions. |
| [`provider-apps.md`](provider-apps.md) | Provider app registrations and their regional routing, plus the source manifests in `config/provider-apps`. Read before changing a registration or callback. |
| [`notion-ingress.md`](notion-ingress.md) | How one public Notion connection serves both regions: the `notion.with-avalon.com` callback and webhook host, the region-prefixed OAuth state, and the Global route directory. Read before changing Notion authorization or webhook ingestion. |
| [`linear-integration.md`](linear-integration.md) | The Linear OAuth, webhook, and native-agent design against Linear's published contracts. |
| [`slack-integration.md`](slack-integration.md) | The Slack Agent connector's product boundary, tools, and event handling. |
| [`slack-permissions.md`](slack-permissions.md) | Every configured Slack OAuth scope and the behavior that depends on it. Read before adding a scope. |
| [`workstream-email-addresses.md`](workstream-email-addresses.md) | The permanent per-work-stream and per-automation address format at `automation.with-avalon.com`, and its derivation. |
| [`workstream-links.md`](workstream-links.md) | The canonical `https://with-avalon.com/app/workstreams/<uuid>` link, why the id sits in the path, and the site rewrite that serves it. Read before emitting or parsing a work-stream link anywhere. |

## Development, verification, and operations

| Document | Scope — read and update when changing… |
| --- | --- |
| [`dev-environment.md`](dev-environment.md) | **Read at the start of every session.** Install, the local D1 database, starting both regional Workers, and running the Electron client headlessly with screenshots. |
| [`sandbox.md`](sandbox.md) | The Claude Code remote sandbox: environment definition, setup script, egress host list, and version parity against CI and production. |
| [`sandbox-proxy.md`](sandbox-proxy.md) | Outbound HTTPS failures behind the sandbox proxy — policy denials versus clients that break on the CONNECT tunnel — and the fix for each. |
| [`e2e.md`](e2e.md) | The local smoke check and the manual desktop acceptance flows for the sidebar, signup, invitations, settings, realtime recovery, and dictation. |
| [`runbook.md`](runbook.md) | Operations: hosted resources per region, secrets, migrations, health verification, deployment, and provider acceptance. |
| [`pull-requests.md`](pull-requests.md) | The required shape of every pull request description, plus the repository's merge style and its no-draft rule. Read before opening a PR; `.github/pull_request_template.md` is its layout and changes with it. |
| [`type-safety-boundaries.md`](type-safety-boundaries.md) | Where runtime parsing, capability-typed mocks, production assertion rules, and centralized Cloudflare test builders keep TypeScript contracts from being asserted past. Read before adding a type escape or platform test double. |
| [`automated-code-review.md`](automated-code-review.md) | The five Azure AI Foundry Cline reviewers, their triggers and credentials, and the context, tool-denial, and posting boundaries that treat pull-request content as untrusted. Read before changing `.github/workflows/azure-ai-reviewers.yml`. |
| [`desktop-icons.md`](desktop-icons.md) | The native adaptive icon, the selectable icon set, and the generation pipeline. Read before changing the artwork. |

## Related material outside this folder

- [`AGENTS.md`](../AGENTS.md) (symlinked as `CLAUDE.md`) — the rule sheet AI
  coding agents read at session start.
- [`README.md`](../README.md) — repository overview, local setup, quality
  commands, and the desktop release process.
- `config/provider-apps` — the source provider manifests that
  [`provider-apps.md`](provider-apps.md) describes.
