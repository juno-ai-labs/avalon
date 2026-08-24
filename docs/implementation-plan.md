# Phased implementation checklist

## Phase 0 — foundation

- [x] Capture the implementation PRD, architecture, repository map, and assumptions.
- [x] Add data model, security, regionalization, connector, harness, and runbook documents alongside their implementations.

## Phase 1 — monorepo and secure desktop shell

- [x] Create pnpm workspaces, shared configuration, and repeatable root scripts.
- [x] Add Electron main/preload with isolation, sandboxing, CSP, validated IPC, safe storage, deep links, and navigation blocking.
- [x] Add the React/Vite renderer, routing, dark shell, status semantics, responsive behavior, and accessible focus states.
- [x] Implement the left sidebar, work-stream transcript/composer, automation overview/creation flow, and contextual right rail.

## Phase 2 — regional auth and persistence

- [x] Add Global/EU onboarding and region-pinned API selection.
- [x] Add Google login PKCE, single-use desktop tickets, refresh/logout, workspace bootstrap, and invitation contracts.
- [x] Add complete D1 migrations, R2 metadata boundaries, repositories, and explicit local seed tooling.

## Phase 3 — work streams and multiplayer

- [x] Add work-stream CRUD, participants, paged messages, resources, mentions, and viewing-without-participation rules.
- [x] Add SubstreamAgent Durable Object, hibernating sockets, sequence-aware reconnects, ephemeral presence, and batched model deltas.
- [x] Add nonparticipant mention confirmation, structured elicitation, activity suggestions, tool events, and stop behavior.

## Phase 4 — OpenRouter harness

- [x] Add configurable OpenRouter streaming, fallback models, structured classifiers, and bounded context assembly.
- [x] Add the typed tool registry, authorization checks, persisted idempotency records, retry/ambiguity policy, and generic Workstream workflow.
- [x] Ensure human-only messages can remain unanswered and private reasoning is never surfaced.

## Phase 5 — automations and scheduler

- [x] Add conversational draft compilation, template versions, subscriptions, scope badges, overview, run history, pause/resume, and run-now.
- [x] Add RRULE/interval validation, next-run calculation, one scheduler Durable Object per workspace, alarms, and idempotent run creation.
- [x] Add planned work streams so pre-run discussion transitions into the same scheduled run.

## Phase 6 — connectors and activity routing

- [x] Add the connector adapter contract and execution-principal enforcement.
- [x] Add one incremental Google OAuth adapter with separate Mail + Calendar and Drive + Docs + Sheets capability presets.
- [x] Add real Gmail, Calendar, and Drive reads; Gmail and Calendar writes; native bounded Docs/Sheets reads and writes; and Drive change-token normalization for Drive, Docs, and Sheets activity.
- [x] Add one smart-routed public GitHub App, one smart-routed public Linear app with a first-class resource surface and feature-gated `protocol_only` native-agent surface, and regional Notion connection adapters with bounded tools, resource hydration, credential lifecycle, and signed inbound events.
- [x] Replace model-native web discovery with bounded Firecrawl search and page-fetch tools and regional usage accounting.
- [x] Add HMAC generic webhooks, normalized activities, Queue ingestion, and deduplication.
- [x] Add direct watches/triggers and deterministic-then-LLM contextual routing with accept/dismiss feedback, fenced to the activity audience.

## Phase 7 — hardening and delivery

- [x] Add unit, Worker integration, renderer component, and documented E2E coverage for the PRD flows.
- [x] Add structured/redacted logging, audit events, health checks, error states, retry bounds, and performance safeguards.
- [x] Verify install, migrations, typecheck, tests, production builds, Electron packaging, and both Wrangler configurations.
- [x] Deploy the Global and EU Cloudflare resources, apply regional migrations, and verify infrastructure health.
- [x] Configure Google OAuth credentials in both regional Workers and verify all hosted identity and connector callback registrations with Google.
- [ ] Enable the expanded Google APIs, complete consent-screen verification and any required restricted-scope security assessment, and pass both Google preset acceptance flows with a provider test account.
- [x] Deploy regional GitHub, Linear, and Notion callbacks, webhook ingestion, provider manifests, and Firecrawl secrets.
- [x] Register the one public GitHub App, install its regional Worker secrets, and verify its registration ping through smart ingress.
- [ ] Register the one public Linear app and the provider-owned Global/EU Notion apps, then install their generated Worker secrets.
- [ ] Complete the human test-account identity, invitation, and connector acceptance flow.

## Release gates

The implementation is not considered complete if it uses seeded data in production, duplicates automation work streams under retry, treats viewers as participants, exposes credentials to the renderer, omits persisted tool events, silently attaches semantic activity matches, claims Google push delivery when only polling is implemented, or introduces channels, global search, a terminal, separate named agents, or a global inbox.
