# Architecture

## System summary

Avalon is a pnpm TypeScript monorepo with three deployment surfaces:

1. `apps/desktop` is the Electron application. Its main process owns main and Settings window lifecycle, custom-protocol login completion, encrypted session storage, file selection, and a minimal validated IPC bridge. Both sandboxed React surfaces use a packaged CommonJS preload and talk only to the configured regional API. The macOS application menu opens the singleton Settings window with **Command-,** and closes the focused window with **Command-W**, which on darwin has to come from a File menu of Avalon's own — Electron's `windowMenu` role omits it there. Settings also closes on **Escape**, a convenience rather than the platform gesture, and only when no dialog, select menu, or unsaved text field has a nearer claim on the keystroke. The main process also owns the macOS menu bar status item, which is the one surface that exists with no window open — Avalon opens at login by default and starts hidden — and which therefore reads the regional API for itself rather than through a renderer; [`menu-bar.md`](menu-bar.md) owns it.
2. `apps/api` is a Hono application deployed as the same Cloudflare Worker code in Global and EU environments. It owns authentication, authorization, REST endpoints, WebSocket upgrades, D1 repositories, R2 objects, Queue production/consumption, Workflows, scheduling, connector execution, and the OpenRouter harness.
3. Shared packages contain runtime-validated contracts, database schema/repositories, connector adapters, agent-loop code, UI primitives, and test fixtures. Business rules live here or in services, never in route handlers.

## Request and event flow

```mermaid
flowchart LR
  E["Electron renderer"] -->|"typed HTTPS"| H["Hono API"]
  E <-->|"hibernating WebSocket"| R["WorkstreamRoom DO"]
  H --> D[("Regional D1")]
  H --> B[("Regional R2")]
  H --> R
  H --> Q["Activity Queue"]
  GH["GitHub App"] -->|"signed webhook"| GI["Smart GitHub ingress"]
  GI -->|"installation route"| H
  GI -->|"exact bytes over RPC"| EH["EU Hono API"]
  Q --> C["Idempotent activity consumer"]
  C --> D
  C --> S["WorkspaceScheduler DO"]
  S --> W["Generic Workstream Workflow"]
  W --> A["Avalon Bind 11 adapter"]
  A --> O["OpenRouter"]
  A --> T["Authorized connection plugins"]
  W --> R
  T --> G["Google APIs"]
  T --> M["Signed webhook"]
```

Canonical product state lives in D1. Large activity payloads, uploads, snapshots, and artifacts live in R2 with relational metadata in D1. Durable Objects coordinate ordering, presence, sockets, and alarms but are not canonical stores.

Users and workspaces each own a validated IANA timezone. The desktop detects the local system timezone during native authentication, while browser or unavailable detection falls back to `America/Los_Angeles`. Workspace defaults are `America/Los_Angeles` in Global and `Europe/London` in EU. Automation compilation preserves explicit trigger timezones and otherwise resolves personal or workspace defaults according to scope before final schema validation.

## Region boundary

Google sign-in has one platform endpoint: the Global control plane at `api.with-avalon.com`. It creates a short-lived, identity-only bootstrap session and then discovers the user's existing workspace memberships and pending invitations in both regions. Only users with neither receive the post-auth workspace-region selector. Existing members activate their workspace directly, while invited users can accept or decline the invitation in its issuing region without a second Google sign-in.

Global reaches the EU deployment only through named Cloudflare Worker RPC service bindings; there is no public internal-bridge HTTP route. `RegionalIdentityBridge` carries minimal onboarding operations. `GitHubRegionalBridge` carries verified setup operations and exact signed GitHub webhook bytes for installations connected in EU. `WorkstreamEmailRoutingBridge` reserves globally unique, immutable friendly addresses, while `InboundEmailRegionalBridge` passes only one verified Resend event to the owning data plane so the body is fetched and stored there. A successful activate, create, or accept operation mints a session in the workspace's owning region, commits the Global opaque workspace binding, and revokes the bootstrap session. The desktop then pins that regional API base URL. Both deployments retain separate D1, R2, Durable Object namespaces, session-signing and credential-encryption keys, and Worker secrets. Cross-region workspace-content access is not implemented.

This is a logical and storage boundary for the prototype, not a claim that all subprocessors provide complete EU-only processing. The Global identity control plane transiently handles onboarding summaries for EU workspaces and stores an opaque EU workspace locator; EU workspace content remains in the EU deployment.

## Identity and secrets

- Google sign-in uses server-side authorization code + PKCE against the single Global `/auth/google/start` endpoint. The Electron main process also creates a separate high-entropy verifier for each native attempt and exposes only its opaque attempt ID and S256 challenge to the renderer. The provider callback redirects through `https://with-avalon.com/auth/desktop/#target=…`; that page accepts only an exact `avalon://auth/complete` target, removes the fragment from history, and opens the app with a short-lived login ticket bound to the attempt. Ticket redemption is one-time and requires the verifier retained only in main-process memory. Workspace choice and invitations are resolved after identity authentication through authenticated onboarding APIs rather than being carried through provider state.
- Connector authorization is separate and incrementally requests only the selected capabilities. Each regional API persists an opaque connector-attempt record before returning the provider URL, completes the provider callback and credential persistence in-region, records a terminal result, and then redirects through the same hosted HTTPS-to-desktop handoff. The custom-protocol launch is a fast notification; Settings also polls the authenticated regional attempt endpoint, so the server record remains authoritative when a browser blocks or loses the launch. Google Mail + Calendar and Google Drive + Docs + Sheets remain presentation and authorization bundles over the same `google` adapter, not separate connector types.
- Desktop refresh material uses a versioned authenticated-encryption envelope. The default envelope uses an application-wide embedded key for update portability; Application → **Lockdown mode** uses Electron `safeStorage` and the operating-system keystore instead. Toggling the mode in-app migrates the auth credential, disposable profile cache, and any legacy session file under the serialized session-mutation boundary. The plaintext `userData/application-settings.json` preference is not authority to unwrap a Lockdown envelope by itself: an off preference paired with a new Lockdown envelope at startup removes only credential-bearing files and forces sign-in. If the keystore becomes unavailable, Avalon automatically applies the same off-and-relogin fallback. Access tokens remain in memory where practical.
- Connector refresh tokens are AES-GCM encrypted with a regional Worker secret.
- OpenRouter, Google, session-signing, webhook, and encryption keys are server-only values loaded from local `.env.local` during development and Cloudflare secrets in hosted environments.
- Azure OpenAI realtime dictation also keeps its endpoint and API key in the regional Worker. The desktop receives a one-minute, single-use Avalon socket ticket, presented through the handshake's `Sec-WebSocket-Protocol` header rather than the query string; Cloudflare consumes its JTI, reserves a bounded regional session, opens the authenticated Azure WebSocket, and admits only rate- and size-limited audio-buffer events from the client. Connections are capped at five minutes and raw microphone audio and transcripts are not persisted by this bridge.
- Every API operation resolves a session, workspace, role, execution principal, connection scope, and requested capability server-side.

## Work streams and live updates

REST/D1 remains canonical. Within each regional workspace, every work stream maps deterministically to exactly one WorkstreamRoom Durable Object named from region, workspace ID, and work-stream ID. EU calls resolve the namespace through `jurisdiction("eu")`. The room coordinates ordering and ephemeral presence; it does not duplicate the canonical transcript.

The room authorizes every connection against D1 itself rather than trusting the one-minute ticket, using the same rule the REST reads apply — see [`DATA_MODEL.md`](DATA_MODEL.md). That check happens once per socket, so anything that retracts it has to reach the connections already inside. Before broadcasting an event that narrows who may read — a work stream becoming `personal`, or a participant being removed — the room sweeps its connected set against that same rule and closes the sockets that fail it, marking each unsubscribed first so the broadcast filter, not the runtime's closed-socket behavior, is what withholds the frame. A revocation closes with `1008`, which the desktop treats as final: it stops reconnecting and drops the cached work stream, because the ticket behind a retry now answers 404.

Publishing is best-effort and swallows its own failures, which is right for every event except a retraction. `publishWorkstreamEvent` reports whether the room accepted the event so a retraction can be logged when it did not, and the room does not rely on having been told at all: on any event other than a `stream_delta`, if its last check is older than 30 seconds it re-asks before delivering. A retraction that never arrived is applied before the next thing the room would have sent, and the same sweep catches the retractions nothing publishes — a workspace membership going inactive. When the sweep's own query fails while resolving a retraction, the room closes every socket with `1011` instead: a failed query is not evidence that any particular reader lost access, and a reconnect re-authorizes against D1, so legitimate readers return in under a second rather than dead-ending on `1008`.

An eviction refreshes presence, after the event rather than with it. Both carry room sequence numbers and the client drops anything at or below the sequence it last applied, so a roster broadcast emitted first — with the higher sequence — would make the client discard the very event that closed the work stream.

The room accepts sockets with Cloudflare's hibernation API and stores connection identity in serialized attachments. After opening, the client sends `subscribe` with its last applied `afterSequence`. Sequence zero receives a snapshot; a reconnect within the bounded in-memory event window receives only newer events. If hibernation discarded that window, the cursor is ahead, or the gap cannot be proved complete, the server sends `resync_required` and the client invalidates its canonical REST queries. The replay cache is intentionally memory-only and bounded to 256 events or 512 KB to avoid per-token Durable Object storage writes.

Room `sequence` orders replayable socket events. Model streaming has a second cursor domain: stable `turnId`, retry `epoch`, and per-epoch `streamSeq`; `reset` replaces only the active turn's partial text from an abandoned route, preserving completed text from earlier tool turns. Deltas are batched without crossing turn/epoch boundaries, and reset frames are emitted alone. The desktop retains stream cursors across reconnects, drops duplicate or stale frames, and still treats the final D1 message and REST snapshot as canonical.

The desktop holds a work stream's harness status in two caches: the detail query behind the open work stream's header, and the list query behind every sidebar row. A `harness_status_changed` frame writes both in one update rather than writing the detail and invalidating the list, so the header and the sidebar dot cannot disagree across a refetch that is still in flight. Polling the list remains the backstop, and is the only refresh for a work stream whose room this client holds no socket to; when a poll returns a status the detail cache was written before, the detail is re-read from REST. Nothing else refreshes it on a timer, so without that a frame lost while connected would strand the header pulsing "Running" over a sidebar row that had already moved on.

Cloudflare's WebSocket auto-response answers exact text `ping` frames with `pong` without waking a hibernated object. The desktop sends jittered keepalives, closes an unresponsive socket, and reconnects with equal-jitter exponential backoff capped at 30 seconds; it pauses retry while offline and resumes with the last room-sequence cursor.

Viewing is presence only. Participant persistence occurs only through explicit addition or an authored work-stream action.

## Agent harness

A lightweight structured classifier decides whether a human message is `agent_action`, `human_only`, `both`, or `uncertain`. Eligible messages start one generic Cloudflare Workflow instance parameterized by opaque IDs.

The production entry point adapts `@juno-ai/bind` 11.0.0 to Avalon's OpenRouter transport and durable ports. Bind owns transcript healing, plugin and skill activation, turn/tool iteration, completion-defect recovery, epoch-aware streaming, and classified route traversal. Avalon owns authorization, regional persistence, admission, accounting, and terminal state.

Each Workflow attempt holds a renewable D1 lease; run-scope, plugin-activation, tool receipt-plan/completion, checkpoint, and terminal commits are fenced by attempt and lease ownership. The run freezes its principal, eligible connections/capabilities, trigger policy, routing/prompt versions, tool-surface hash, and limits. The host revalidates principal and work-stream state, automation subscription and pinned template version, trigger evidence, connection ownership/grants, and health at admission, before credential decryption and tools, and between model turns. Later checks may revoke authority but cannot add a new connection or grant. Expired attempts are compare-and-swap reaped, and completion commits only after the final agent message is durable.

Each run creates a fresh Bind registry. Stable always-active plugins separate discovery, time, scoped prose memory, scoped structured tables, work-stream operations, and automation architecture; the run registers only the bundles applicable to that agent. Each eligible installed connection becomes a credential-scoped Bind plugin built from static adapter metadata and narrowed to frozen grants. Bound or attached connections can preload; other eligible plugins are progressively loaded from the catalog, with activation persisted before exposure. Active plugins are reauthorized before inference and again at tool execution. The loop overlaps safe reads, serializes writes, records execution plans and results, replays completed receipts, and stops rather than repeating an ambiguous external write.

The run also enforces context, token, cost, iteration, tool-call, wall-clock, and streaming-watchdog limits. Classified provider attempts append to an immutable inference ledger. Cancellation is a durable request observed by the lease owner, which alone commits the final `stopped` transition.

Durable memory is scoped to an ad-hoc work stream, an installed automation subscription, a user inside a workspace, or the workspace itself. The host—not the model—derives the searchable scope union from the frozen execution principal and run origin. D1 FTS5 and the regional Vectorize index are searched concurrently, merged with reciprocal-rank fusion, and rechecked against canonical D1 authorization, revision, expiry, and invalidation state. Admission freezes recalled items and their context hash for retries. Memory writes use receipt replay, revision compare-and-swap, append-only mutation records, and a transactional indexing outbox; lexical search remains available while embeddings catch up.

## Automations and scheduling

Natural-language automation creation compiles into a validated draft. A versioned template holds reusable behavior; a subscription pins a version and owns scope, execution principal, connector bindings, overrides, and schedule state.

One WorkspaceScheduler Durable Object per workspace maintains one alarm for the earliest due item. D1 uniqueness constraints are authoritative under repeated alarms. It starts generic workflow instances rather than deploying per-automation code. A planned run and its work stream are reused when the scheduled instant arrives.

The alarm has three target kinds: due `schedules`, due `resource_watches`, and due `workstream_wakeups`. A `schedules` row names exactly one of an automation subscription, a connector connection, or a digest schedule. A Durable Object holds one alarm at a time, so the object arms for the earliest target across all three and drains every target due at that instant before re-arming, with per-target exponential backoff held in Durable Object storage. Workspaces never contend: each has its own object and its own alarm.

A person's scheduled digest is one `schedules` row per delivery time, because a single RRULE multiplies `BYHOUR` by `BYMINUTE` and so cannot carry an arbitrary list of times. When one fires, the scheduler freezes a window over the first-party `activity_events` log, claims the occurrence, and starts an ordinary run in a hidden `system_kind` work stream; what the run writes is then delivered by email or by any connector declaring a personal delivery surface. See [`DIGESTS.md`](DIGESTS.md).

A work stream can schedule its own wake-up through `workstream_schedule_wakeup`, giving a relative duration or an exact ISO-8601 instant plus the prompt to act on. When it fires, the scheduler claims the row, re-checks the execution principal that scheduled it against current membership, writes a system row into the transcript, and starts an ordinary work-stream run whose trigger is the stored prompt.

## Connectors and ingestion

Connector adapters expose typed authorization, polling, webhook normalization, hydration, tools, watches, health checks, and a static agent-plugin descriptor. Runtime plugins are instantiated per eligible connection; provider content and connection labels cannot contribute trusted plugin instructions. V1 ships complete paths for:

- One Google connector family presented as Mail + Calendar and Drive + Docs + Sheets presets, with incremental OAuth scopes, refresh handling, native Docs/Sheets APIs, and bounded read/write tools.
- One public GitHub App with installation tokens, expiring user authorization, a signature-verifying smart ingress, regional fanout, resource discovery, and normalized repository activity.
- One public Linear app with Global and EU OAuth callbacks, app-actor attribution, a signature-verifying smart ingress, regional fanout, a first-class resource surface, and a feature-gated `protocol_only` native-agent surface; plus a separate public Notion integration with regional callbacks and signed regional webhook ingestion.
- Signed generic webhooks with HMAC, timestamp, replay, schema, and deduplication checks.

Google ingestion uses provider cursors rather than push delivery: Gmail history IDs, Calendar sync/completion cursors, and Drive change page tokens. Drive changes are MIME-classified into Drive, Docs, or Sheets resources, so the same Drive poll produces `drive.file_changed`, `docs.document_changed`, or `sheets.spreadsheet_changed`. There is no Google webhook or push-channel implementation; Avalon watches operate after a polled activity has been normalized.

Normalized activities store compact metadata in D1 and opaque payload references to R2. Provider objects discovered from events are upserted as durable regional resources; attaching one to a work stream does not copy provider content, and hydration remains capability-checked through its originating connection. Queue messages contain only IDs and routing metadata. Deterministic trigger/watch checks precede any LLM classification.

## Repository map

```text
apps/
  desktop/                 Electron main, preload, React renderer, packaging
  api/                     Hono Worker, routes, services, DOs, Workflows, Queue
packages/
  contracts/               Zod API, WebSocket, agent, connector contracts
  db/                      D1 migrations, repositories, region-aware queries
  agent-harness/           Bind 11/OpenRouter adapter, prompts, skills, classifiers, tools
  connectors/              Core adapters and credential-plugin descriptors
docs/                      Product, architecture, security, setup, runbooks
```

## Contract boundaries

Every boundary a value crosses is parsed at runtime, not asserted by a type that
build erases. That covers HTTP requests, JSON responses, queue messages, Workflow
params and step results, Durable Object fetches and their stored state, both
directions of a WebSocket, provider webhooks, provider API responses, model
structured output, agent tool arguments, feature flags, desktop IPC, and the
desktop client's own reading of every response.

Four of those are recent and worth naming, because each was a place where a type
stood in for a check:

- **`Env`** is asserted once per isolate at the entrypoints (`assertEnvContract`).
  A missing variable used to surface as a `TypeError` inside whichever request
  first read it, and a malformed numeric one never surfaced at all, because
  `numericEnv` silently substitutes its fallback for anything unparseable.
- **The internal RPC surface** — the `WorkerEntrypoint` bridges — parses each
  argument at the hop (`lib/rpc-contracts.ts`). Same account is not the same
  guarantee, and `region`/`workspaceId` decide which side of the Global/EU
  boundary a record lands on.
- **D1 rows** are parsed at the read rather than coerced field by field, mirroring
  the columns' own CHECK constraints, so a bad row fails where it is read and
  names its column. `mappers/connection.ts` and the row schemas in
  `workstream-service.ts` and `note-service.ts` are the pattern; the readers in
  `integrations.ts`, `automation-service.ts`, `workspace-service.ts`,
  `connection-service.ts`, `work-opportunity-service.ts`, `slack-agent-service.ts`
  and `resource-service.ts` still hand-coerce and are the remaining work.

  Two rules keep a row schema from turning one bad row into a dead list, which is
  the failure the schemas exist to remove rather than relocate:

  - **Mirror a `CHECK` exactly, and bound anything the column does not.** An enum
    that restates a real constraint can only fail on drift, and naming the column
    is the point. A column with no length constraint read into a field a contract
    bounds is truncated at the read instead — `origin_label`, `resources.title`,
    `activities.title`. Without that, one over-long value fails every row the
    same query returned.
  - **Widen the code before the column.** A migration that relaxes a `CHECK` must
    ship after the deploy that widens the matching enum, or rows written by the
    new schema fail the readers still running the old one.
- **Route responses** pass their contract before serializing, enforced by the
  `avalon/require-validated-response` lint rule. Without it the strict side of
  the contract was the far side of the network: the desktop client parses every
  response it receives, so a malformed body left the Worker with a 200 and became
  a client-side `invalid_response` with nothing on the server naming the field.
  A body the route builds from literals is exempt — the route is its own contract
  there.

## Security boundaries

The Electron renderer never receives provider credentials, native PKCE verifiers, OpenRouter keys, Cloudflare administration keys, raw IPC, Node integration, or arbitrary navigation. Main validates every exposed IPC call against a live Avalon window and its pinned renderer origin. API logs redact tokens, codes, bodies, file contents, model context, and unnecessary personal information. External actions and authorization decisions create audit records with structured correlation IDs. Immutable run scopes and live connection reauthorization ensure progressive plugin activation can narrow, but never widen, a run's original authority.
