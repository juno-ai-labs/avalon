# Architecture

Rally is a pnpm TypeScript monorepo with an Electron desktop client, a lite
browser client, a Hono API Worker
across configured deployments,
internal operator Workers, and shared packages that hold every contract and rule
the surfaces agree on. This document is the map of how those surfaces fit
together: what runs where, what crosses which boundary, and which document owns
each subsystem in detail.

Read it before a change that spans more than one surface, before adding a
deployment surface or a package, and before assuming where a rule is enforced.
It stays a map: a subsystem described here in a paragraph has its own document,
and the map points at it rather than absorbing it.

## Where the code lives

```text
apps/
  desktop/                 Electron main, preload, React renderer, packaging
  api/                     Hono Worker, routes, services, DOs, Workflows, Queue
  ace/                     Access-protected internal administration Worker
packages/
  ui/                      Shared collaboration components, display helpers, styles and appearance
  contracts/               Zod API, WebSocket, agent, connector contracts
  db/                      D1 migrations, repositories, region-aware queries
  agent-harness/           Bind/OpenRouter adapter, prompts, skills, classifiers, tools
  connectors/              Core adapters and credential-plugin descriptors
docs/                      Product, architecture, security, setup, runbooks
```

| Path | Responsibility |
| --- | --- |
| `apps/desktop/src/main` | Window and Settings lifecycle, custom-protocol login completion, encrypted session storage, file selection, the macOS status item, main-owned telemetry/crash handling, and raw Node transport for the open conversation's feed socket. |
| `apps/desktop/src/preload` | The packaged CommonJS preload — the only channel between a sandboxed renderer and main. |
| `apps/desktop/src/renderer` | Both React surfaces. Talks only to the configured regional API. Keeps a local cache of the directory and each opened conversation so the Canvases and Sidekicks lists and an open conversation paint before their socket answers; [`local-cache.md`](local-cache.md) owns it. |
| `apps/browser` | Lite browser host, static SPA email sign-in and same-origin regional API forwarding. Shared collaboration uses standalone visible conversation sockets. Owned by [`browser-client.md`](browser-client.md). |
| `apps/api/src/app.ts`, `apps/api/src/routes` | The Hono application and its REST and upgrade routes. |
| `apps/api/src/index.ts`, `apps/api/src/worker-events.ts` | The regional API's statically imported HTTP/event graph and platform exports. Heavy stateless providers run in the typed document, Terminal, and Global telemetry-delivery service Workers owned by [`api-worker-deployment.md`](api-worker-deployment.md). |
| `apps/api/src/services` | Business rules. Route handlers hold none. |
| `apps/api/src/services/terminal` | Deferred Terminal plugin, Daytona adapter, authority-fenced sandbox control plane, resources, and trusted GitHub publication. |
| `apps/api/src/durable-objects` | `WorkspaceDO`, which also hosts the Sidekick and Canvas conversation parents on one `HostedConversation` primitive (`hosted-conversation.ts`, `hosted-sidekick.ts`, `hosted-canvas.ts`; see [`hosted-conversation-parents.md`](hosted-conversation-parents.md)), `AgentLoopDO`, the shared `MigratableDurableObject` schema base and the `ScheduledDurableObject` alarm base above it, the retirement gate (`object-retirement.ts`) that wraps every method of the workspace-owned classes, and their SQL-only migration/storage layers. |
| `apps/api/src/workflows`, `apps/api/src/queues` | Generic orchestration and idempotent regional consumers. |
| `apps/api/src/env.ts` | `assertEnvContract` — the one place the Worker environment is parsed. |
| `apps/api/src/lib/rpc-contracts.ts` | The parsers every RPC bridge argument passes through. |
| `apps/migration-tracker` | The private operator Worker behind `migrations.internal.rallywith.ai`: the Durable Object migration inventory, its hourly account sweep, the forced-migration fan-out onto each region's command queue, and the Cloudflare Access boundary in front of all of it. See [`durable-object-migration-tracking.md`](durable-object-migration-tracking.md). |
| `apps/ace` | The private Hono operator Worker behind `ace.internal.rallywith.ai`: D1-assisted Flagship product targeting, the shared-to-regional Queue fan-out, and the component library future internal pages extend. See [`ace.md`](ace.md). |
| `packages/ui` | Shared collaboration presentation and browser-safe display/theme helpers, consumed by desktop and prepared for the browser host in #825. Owned by [`shared-ui.md`](shared-ui.md) and [`theming.md`](theming.md). |
| `packages/contracts` | Every runtime contract both ends share. A type that only exists at build time is not one of them. |
| `packages/db` | Migrations and region-aware repositories. The migrations are authoritative for the schema. |
| `scripts/eslint-rules/require-validated-response.mjs` | The lint rule that makes a route validate its own response. |

### Core surfaces

1. **`apps/desktop`** is the Electron application. Its main process owns main and
   Settings window lifecycle, custom-protocol login completion, encrypted session
   storage, file selection, and a minimal validated IPC bridge. Both sandboxed
   React surfaces use a packaged CommonJS preload and talk only to the configured
   regional API. The macOS application menu opens the singleton Settings window
   with **Command-,** and closes the focused window with **Command-W**, which on
   darwin has to come from a File menu of Rally's own — Electron's `windowMenu`
   role omits it there. The main window saves its normal bounds and maximized
   state on close in the device's `userData` directory; a later creation restores
   them into a current display's work area, falling back to the default size
   when no valid state exists. This includes reopening after a macOS window close
   without quitting the app; [`main-window-state.md`](main-window-state.md) owns
   the temporary details-rail width and small-display limits. Detached artifact
   windows use the same display clamp and restore their own identity and placement
   after fresh resource authorization; [`desktop-layout.md`](desktop-layout.md)
   owns that device-local lifecycle. Settings also closes on
   **Escape**, a convenience rather than the platform gesture, and only when no
   IME composition, dialog, select menu, or unsaved text field has a nearer
   claim on the keystroke; `renderer/lib/window-escape.ts` is the one predicate
   and the hook that installs it, and each window nominates what closing it
   would cost. A secondary window answers the keystroke before its screen
   exists too — `WorkspaceApp` installs a scope-less one while the workspace
   profile is still in flight or has failed, and stands it down the moment the
   screen mounts its own. The main process also owns the macOS menu bar status item, which
   is the one surface that exists with no window open — Rally opens at login by
   default and starts hidden — and which therefore reads the regional API for
   itself rather than through a renderer;
   [`menu-bar.md`](menu-bar.md) owns it. Main also owns the typed telemetry
   reporter, route and identity epochs, local spool, Crashpad generations, and
   authenticated regional upload; the renderer can only invoke registered
   semantic calls. Main additionally publishes application foreground changes
   over that bridge. A renderer combines them with its own window focus and
   open Canvas before reporting ephemeral presence to WorkspaceDO; an open
   feed socket is never treated as attention.
3. **`apps/api`** is a Hono application deployed as three statically imported
   Cloudflare Worker graphs in each of configured deployments: the regional API plus
   private document-processing and Terminal-provider services reached through
   typed Service Bindings. Global adds a private telemetry-delivery graph and a
   scheduled inference-pricing graph. The API owns authentication, authorization,
   REST endpoints, WebSocket upgrades, D1 repositories, R2 objects, Queue
   production and consumption, Workflows, scheduling, connector execution, and
   the OpenRouter harness. The private services isolate heavyweight stateless
   SDKs without request-time module loading or another product authority.
4. **Shared packages** contain runtime-validated contracts, database schema and
   repositories, connector adapters, agent-loop code, UI primitives, and test
   fixtures. Business rules live here or in services, never in route handlers.
5. **Internal operator Workers** sit behind Cloudflare Access and verify the
   signed Access assertion again in application code. Ace manages product flags;
   the migration tracker manages Durable Object schema state. Neither is a
   privileged route inside the customer API.

### Request and event flow

Authority follows the data boundary. Regional D1 is the thin identity/routing
plane: workspace/member/user identity, opaque connector/object routes,
migration controls, and bounded operational audit/telemetry. WorkspaceDO owns
workspace connector/product state, Terminal policy, shared schedules, the
content-free automation directory and the external-event registrations,
resources/notes/memory/R2 references, external delivery, the Canvas
directory and each viewer's lists, and each Sidekick's own product state, as
a hosted Sidekick that is also the parent of its conversation and its runs.
`AgentLoopDO` SQLite owns substream product state and the full conversation
agent loop. A Canvas and a Sidekick keep their parent state as
`canvas_*`/`sidekick_*` rows in `WorkspaceDO`. Large payloads, uploads, and
snapshots live in R2.

### Region boundary

Google sign-in has one platform endpoint: the Global control plane at
`api.rallywith.ai`. It creates a short-lived, identity-only bootstrap session
and then discovers the user's existing workspace memberships and pending
invitations in configured deployments. Only users with neither receive the post-auth
workspace-region selector. Existing members activate their workspace directly,
while invited users can accept or decline the invitation in its issuing region
without a second Google sign-in.

### Identity and secrets

- Google sign-in uses server-side authorization code + PKCE against the single
  Global `/auth/google/start` endpoint. The Electron main process also creates a
  separate high-entropy verifier for each native attempt and exposes only its
  opaque attempt ID and S256 challenge to the renderer. The provider callback
  redirects through `https://rallywith.ai/auth/desktop/#target=…`; that page
  accepts only an exact `rallywithai://auth/complete` target, removes the fragment
  from history, and opens the app with a short-lived login ticket bound to the
  attempt. Ticket redemption is one-time and requires the verifier retained only
  in main-process memory. Workspace choice and invitations are resolved after
  identity authentication through authenticated onboarding APIs rather than being
  carried through provider state.
- Connector authorization is separate and incrementally requests only the
  selected capabilities. Each regional API persists an opaque connector-attempt
  record before returning the provider URL, completes the provider callback and
  credential persistence in-region, records a terminal result, and then redirects
  through the same hosted HTTPS-to-desktop handoff. The custom-protocol launch is
  a fast notification; the terminal attempt advances the WorkspaceDO socket
  waterline, and Settings then reads the authenticated regional attempt endpoint
  once. Reconnect repeats that reconciliation, so the server record remains
  authoritative when a browser blocks or loses the launch without an interval
  poll. Google Mail + Calendar and Google Drive + Docs + Sheets remain
  presentation and authorization bundles over the same `google` adapter, not
  separate connector types.
- Desktop refresh material uses a versioned authenticated-encryption envelope. The
  default envelope uses an application-wide embedded key for update portability;
  Application → **Lockdown mode** uses Electron `safeStorage` and the
  operating-system keystore instead. Toggling the mode in-app migrates the auth
  credential, disposable profile cache, and any legacy session file under the
  serialized session-mutation boundary. The plaintext
  `userData/application-settings.json` preference is not authority to unwrap a
  Lockdown envelope by itself: an off preference paired with a new Lockdown
  envelope at startup removes only credential-bearing files and forces sign-in. If
  the keystore becomes unavailable, Rally automatically applies the same
  off-and-relogin fallback. Access tokens remain in memory where practical.
- Connector refresh tokens are AES-GCM encrypted with a regional Worker secret.
- OpenRouter, Google, session-signing, webhook, and encryption keys are
  server-only values loaded from local `.env.local` during development and
  Cloudflare secrets in hosted environments.
- Azure OpenAI realtime dictation also keeps its endpoint and API key in the
  regional Worker. The desktop receives a one-minute, single-use Rally socket
  ticket, presented through the handshake's `Sec-WebSocket-Protocol` header rather
  than the query string; Cloudflare consumes its JTI, reserves a workspace-owned
  session, opens the authenticated Azure WebSocket, and admits only size-bounded
  audio-buffer events from the client. Valid audio remains valid under delayed
  or burst delivery. Raw microphone audio and transcripts are not
  persisted by the bridge. The ordered sender and its byte budget are documented
  in [conversation surfaces](conversation-surfaces.md#dictation-capture-and-connection-startup).
- Every API operation resolves a session, workspace, role, execution principal,
  connection scope, and requested capability server-side.

### Conversations and live updates

`WorkspaceDO` is the low-volume control plane for workspace sync/command
admission, Canvas and Sidekick parent state, the lists each viewer sees, and
regional effects. Each authenticated Electron renderer maintains one native
Chromium WorkspaceDO socket for the active workspace, and a main-process Node
broker dials the substream `0` feed of the conversation on screen (a Canvas's
Chat or a Sidekick's conversation, or a run's). WorkspaceDO's explicit
foreground signal is the only presence. Transcript reads, streaming
checkpoints, and loop execution route directly to the selected `AgentLoopDO`
data plane, so parents never become the throughput ceiling for their children.

An authoritative child mutation that changes what a parent lists writes a
versioned effect to the child's local outbox in the same SQLite transaction.
The child sends it over the activity Queue to `WorkspaceDO.receiveChildEffects`,
where the Canvas or Sidekick (`HostedConversation`) records the receipt, the
child's projection and each reader's read of `"0"` in one transaction, and
republishes the list rows that moved on the workspace socket. A person
notification is an intent in `WorkspaceDO` (`workstream_notification_intents`):
a Sidekick run's notices are recorded there by the Sidekick; a conversation's
mention effect stops at its parent today
([known gap](workstream-durable-object.md#directory-effects-and-notifications)). D1
resolves current membership and profile identity; WorkspaceDO resolves the
destination and checks the recipient against the parent's own reader rule, so
Queue reordering cannot outrun a removal. The object therefore owns the fact
that a mention or state change occurred without acquiring workspace
credentials, placing product text in Queue storage, or turning a failed network
call into a lost list update.

Both object roles accept Cloudflare hibernating sockets with purpose-scoped,
single-use tickets and serialized connection attachments. The ticket establishes
the intended object/audience; admission and later commands still resolve current
regional session, membership, and the parent's viewer decision. An already
connected reader is closed only when a retraction reaches its object over the
[access-revocation queue](access-revocation.md), and a policy close (`1008`)
tells Electron to stop retrying. Nothing revalidates a listening socket on a
timer, which is what keeps an authorization query off every token frame. The
complete role-specific protocol lives in
[`realtime-sockets.md`](realtime-sockets.md), and the rule for deciding whether
a given payload travels on one of these sockets or over REST is
[`choosing-sockets-or-rest.md`](choosing-sockets-or-rest.md).

The socket responsibilities are deliberately not interchangeable:

- `WorkspaceDO` publishes each viewer's Canvas and Sidekick lists (with
  unread, Needs input, presence and pins) at their own waterlines, plus
  waterlined workspace-topic invalidations, and takes `set_presence`. It
  carries neither transcript parts nor model tokens.
- `AgentLoopDO` is the direct conversation feed plus correlated
  transcript-page download and the conversation's commands. Its object-local
  SQL owns canonical parts, tool calls/results, active compaction, and the
  accumulated output checkpoint.

A list row that arrives again, or late, is ignored unless its list's waterline
is newer. UUIDv7 makes the same event searchable and millisecond-time-sortable
across republishes, but does not replace authority-local waterlines for causal
correctness.

The AgentLoopDO message receipt is private and outside the published room
sequence. If a connection drops before that receipt, Electron reconnects and
resends the stable client message/operation ID; object-local message identity
makes the retry idempotent. The socket is a mutation grant only for the exact
workspace/parent/substream/user/session/role tuple serialized at admission.
The revocation walk closes it when that grant ends, and the message transaction
still enforces object-local participation.

AgentLoopDO sequences replayable events and keeps a bounded in-memory replay
window. Its SQLite transaction commits accumulated text and Bind cursor before a
batched stream frame is eligible for publication. Initial subscriptions and
subscriptions whose replay history was lost receive a full canonical snapshot,
allowing a cold or post-hibernation subscriber to replace its partial text and
continue without a gap or duplicate. Terminal persistence writes one canonical
local-SQL part and removes the checkpoint; D1 receives no token or
directory-cadence writes. If the replay gap cannot be proved complete, the agent
serves that snapshot on the admitted socket rather than asking Electron to
disconnect and fetch the same authority over HTTP.

AgentLoopDO `sequence` orders replayable feed events. Model streaming has a second
cursor domain: stable `turnId`, retry `epoch`, and per-epoch `streamSeq`; `reset`
replaces only the active turn's partial text from an abandoned route, preserving
completed text from earlier tool turns. Deltas are batched without crossing
turn/epoch boundaries, and reset frames are emitted alone. The desktop retains
feed and stream cursors across socket and route handoffs, drops duplicate or
stale frames, and reconciles to the agent's final local-SQL transcript page.

That reconciliation runs over the socket, not REST. A viewer that needs
canonical state sends `request_snapshot` and the room answers with the same
sequenced `snapshot` frame an initial subscription receives: one frame carrying
the conversation, the newest transcript page, both cursors, and the active-stream
checkpoints, assembled at one sequence. The room holds the asking socket out of
broadcasts while it assembles, exactly as it does for an initial subscribe, then
replays anything published in that window. Because the answer is ordered against
every other frame, the client's ordinary cursor guard decides whether to apply
it, and a viewer keeps at most one request outstanding. If snapshot assembly
fails, or if its one in-memory catch-up has itself fallen outside the replay
window, the agent retains the old attachment cursor and uses
`resync_required` with reason `history_unavailable` as the last-resort REST
fallback. A socket cursor ahead of the durable sequence likewise uses
`sequence_ahead`, because a lower-sequence snapshot would be rejected.

Cloudflare's WebSocket auto-response answers exact text `ping` frames with `pong`
without waking a hibernated object. The AgentLoopDO feed jitters its heartbeat
across 45–55 seconds; the workspace socket uses a fixed 50-second interval.
Every role closes after 15 seconds without `pong`, reconnects with equal-jitter
exponential backoff capped at 30 seconds, pauses while offline, and resumes
from its own topic waterline, list waterlines, feed sequence/stream cursor, or
active-output checkpoint.

Viewing is presence only. Participant persistence occurs only through explicit
addition, a parent's admission, or an authored message.

How a socket is admitted in the first place — the ticket, its transport, and which
rejections come from the edge — is [`realtime-sockets.md`](realtime-sockets.md).

### Agent harness

A lightweight structured classifier decides whether a human message is
`agent_action`, `human_only`, `both`, or `uncertain`. Eligible messages admit
one complete Bind loop into their `AgentLoopDO`.
The durable child dispatch row, attempt lease, receipts, and checkpoints recover
2–30 minute loops and rare two-hour-plus coding sessions across eviction. Generic
Cloudflare Workflows remain available for other orchestration.

Supported regional conversation runtimes may discover the deferred Terminal
plugin. Loading it changes only Bind's prompt/tool surface; the first file,
command, resource, or repository tool call lazily crosses the regional API into
one private Daytona sandbox for that conversation, which the background agents
it starts share. The owning `AgentLoopDO` is the
authority for generation, mutation leases, tasks, retention, resource links,
and GitHub publication receipts; WorkspaceDO owns workspace egress policy,
connector authority, and resource metadata. The provider supplies isolation and process/
filesystem/lifecycle primitives, not Rally's receipts or authorization. See
[`terminal-workspaces.md`](terminal-workspaces.md).

The production entry point adapts `@juno-ai/bind` 15.0.0 to Rally's OpenRouter
transport and durable ports. Bind owns transcript healing, plugin and skill
activation, turn/tool iteration, completion-defect recovery, epoch-aware
streaming, and classified route traversal. Rally owns authorization, regional
persistence, admission, accounting, and terminal state.

Each durable agent attempt holds a renewable SQL lease; run-scope, plugin-activation,
tool receipt-plan/completion, checkpoint, and terminal commits are fenced by
attempt and lease ownership. The run freezes its principal, eligible
connections/capabilities, trigger policy, routing/prompt versions, tool-surface
hash, and limits. The host revalidates principal and conversation state, an
automation run's live state in its parent (`WorkspaceDO.sidekickReadRunState`),
trigger evidence, connection
ownership/grants, and whether a person has disabled the connection, at admission,
before credential decryption and tools, and between model turns. A run whose
automation has since been paused or deleted therefore stops issuing provider
writes rather than finishing on stale consent. Later checks may
revoke authority but cannot add a new connection or grant. Expired attempts are
compare-and-swap reaped, and completion commits only after the final agent message
is durable.

Each run creates a fresh Bind registry. Stable always-active plugins separate
discovery, time, scoped prose memory, scoped structured tables, conversation
operations, and automation drafting; the run registers only the bundles
applicable to that agent. Each eligible installed connection becomes a
credential-scoped Bind plugin built from static adapter metadata and narrowed to
frozen grants. Bound or attached connections can preload; other eligible plugins
are progressively loaded from the catalog, with activation persisted before
exposure. Active plugins are reauthorized before inference and again at tool
execution. The loop overlaps safe reads, serializes writes, records execution plans
and results, replays completed receipts, and stops rather than repeating an
ambiguous external write.

Run limits are caller-specific. Root ordinary conversation runs enforce a
1,000-turn cap but no aggregate tool-call, model-cost, or task-scale
wall-time ceiling. Their Durable Object execution owners combine a 30-second
alarm keep-alive with durable dispatch and lease recovery rather than relying
on a Workflow deadline.
Inline children and other deliberately bounded one-shot harness callers keep
smaller explicit ceilings. Context, token, and per-operation streaming
watchdogs still apply, and classified provider attempts append to an immutable
inference ledger. Cancellation is a durable request observed by the lease
owner, which alone commits the final `stopped` transition.

After durable cancellation is rechecked and the effective terminal status is
committed, every root harness execution also emits one exact structured Workers
Log and one aggregate Workers Analytics Engine datapoint. The datapoint carries
the already-computed run totals—duration, turns, routed model attempts, tool
calls, model/tool time, tokens, cost, and outcome—and no member content or run
identifier. Analytics Engine is sampled and optimized for distributions and
time series, not exact event recovery, so Rally never reconstructs a run from
loop-churn datapoints. D1 remains canonical; Workers Logs and Traces provide
correlated diagnosis. [`runbook.md`](runbook.md#root-run-analytics) owns the
positional dataset schema and sampling-aware queries.

Daytona platform timings use a second fixed-grain dataset,
`avalon_terminal_operations`. One content-free point measures provider create,
managed-image bootstrap, manifest verification, stopped warming, or archived
restore. Keeping platform operations out of `avalon_agent_runs` lets sampling
and percentiles answer image/cold-start questions without pretending a provider
phase is a model-run summary. The Terminal adapter emits both the structured log
and non-blocking aggregate point; neither is canonical sandbox state.

Agent memory is a store of facts in WorkspaceDO that a background sweep writes
after a Canvas's Chat or a Sidekick conversation settles, each filed under a
subject (the Organization, a Canvas, a person, a Sidekick) and carrying the
conversations it was learned from; who may read a fact is decided at read time
from those sources and the Canvas and Sidekick audiences WorkspaceDO already
keeps, never from a scope the model names. A run recalls, remembers and
forgets through three tools; WorkspaceDO FTS5 answers recall.
[`agent-memory.md`](agent-memory.md) owns it. Typed durable tables stay scoped
to a user, the workspace, or a Sidekick in the same store.

[`agent-harness.md`](agent-harness.md) owns the harness in detail, and
[`context-compaction.md`](context-compaction.md) owns what a run remembers once
its window fills.

### Automations and scheduling

An automation is a hosted Sidekick and one conversation. It is a conversation
parent hosted in `WorkspaceDO` beside the Canvases: its substream `0` is the
shared conversation where everyone it is shared with asks it for runs and a
manager edits it through the wizard, and every run is a child substream under
it with a row in `0`. Its rows hold the definition revisions, the
lifecycle, the schedules, the runs, and the inbound-email receipts; a run reads
its definition from the parent by revision and reports its state through the
same effect pipeline every conversation uses.
[`automation-lifecycle.md`](automation-lifecycle.md) owns all of it;
`WorkspaceDO` keeps only a content-free sidebar row the object publishes and
the typed external-event registrations that fan a connector event out.

WorkspaceDO holds one alarm for the earliest due item in its own workspace, and
its uniqueness constraints are authoritative under repeated alarms. It starts
generic workflow instances rather than deploying per-automation code.

The alarm's target kinds are due `schedules`, due `resource_watches`, per-task
maintenance sweeps, Terminal sandbox deadlines, and each Sidekick's schedule,
run, review and run-row entries. A `schedules` row names a connector
connection's poll. A Durable Object holds one alarm at a time, so each
target is a row in the object's `_internal_durable_alarms` list, the alarm is
armed for the earliest of them, and every target due at that instant drains in
one wake, each behind its own exponential-backoff gate, so a broken connector
poll cannot stop a Sidekick's schedule. Workspaces never contend: each has its
own object and its own alarm. [`durable-object-alarms.md`](durable-object-alarms.md)
covers the mechanism, which WorkspaceDO and AgentLoopDO share.

A conversation can schedule its own wake-up through `schedule_wakeup`,
giving a relative duration or an exact ISO-8601 instant plus the prompt to act on.
Its own AgentLoopDO owns that timer: the wake-up becomes an entry in that
object's alarm list, so every wake-up due at one instant fires in one alarm.
When it fires, the agent claims the row, re-checks the execution principal that
scheduled it against current membership, writes a system row into the transcript,
and starts an ordinary run whose trigger is the stored prompt.

### Connectors and ingestion

Connector adapters expose typed authorization, polling, webhook normalization,
hydration, tools, watches, health checks, and a static agent-plugin descriptor.
Runtime plugins are instantiated per eligible connection; provider content and
connection labels cannot contribute trusted plugin instructions. V1 ships complete
paths for:

- One Google connector family presented as Mail + Calendar and Drive + Docs +
  Sheets presets, with incremental OAuth scopes, refresh handling, native
  Docs/Sheets APIs, and bounded read/write tools.
- One public GitHub App with installation tokens, expiring user authorization, a
  signature-verifying smart ingress, regional fanout, resource discovery, and
  normalized repository activity.
- One public Linear app with configured deployments OAuth callbacks, app-actor attribution,
  a signature-verifying smart ingress, regional fanout, a first-class resource
  surface, and a feature-gated `protocol_only` native-agent surface; plus one
  public Notion connection whose single redirect URI and single webhook
  subscription both terminate at a Global ingress that verifies each delivery and
  hands it, and the OAuth authorization code, to the owning region — see
  [`notion-ingress.md`](notion-ingress.md).
- Signed generic webhooks with HMAC, timestamp, replay, schema, and deduplication
  checks.

Google ingestion uses provider cursors rather than push delivery: Gmail history
IDs, Calendar sync/completion cursors, and Drive change page tokens. Drive changes
are MIME-classified into Drive, Docs, or Sheets resources, so the same Drive poll
produces `drive.file_changed`, `docs.document_changed`, or
`sheets.spreadsheet_changed`. There is no Google webhook or push-channel
implementation; Rally watches operate after a polled activity has been
normalized.

Normalized events are committed to their one owning WorkspaceDO before a
Workflow processes them; the regional Queue carries a bounded normalized event
plus its workspace route/hash, while R2 holds large/raw provider bytes. Provider
objects discovered from events are upserted as
WorkspaceDO resources; attaching one to a conversation does not copy provider content, and
hydration remains capability-checked through its originating connection.
Deterministic trigger/watch checks
precede any LLM classification.

- **Authority follows the declared storage boundary.** Regional D1 owns
  membership/identity, opaque ingress/object routing, migration, and operational
  audit/telemetry. `WorkspaceDO` owns workspace-scoped connector, Terminal
  policy, schedule, the content-free automation directory and the
  external-event registrations, resource/note/memory/R2-reference, Canvas
  directory, and external-delivery state, and each hosted Sidekick's product
  state, the parent of its conversation and its runs. Each `AgentLoopDO` owns
  its substream product state, a Canvas and a Sidekick keep their parent state
  as `canvas_*`/`sidekick_*` rows in `WorkspaceDO`, and legacy D1 product and
  pin tables do not exist. R2 holds large payloads; the authority that names each
  workspace reference stays in the owning WorkspaceDO database.

- **Every boundary a value crosses is parsed at runtime, not asserted by a type
  that build erases.** That covers HTTP requests, JSON responses, queue messages,
  Workflow params and step results, Durable Object fetches and their stored state,
  both directions of a WebSocket, provider webhooks, provider API responses, model
  structured output, agent tool arguments, feature flags, desktop IPC, and the
  desktop client's own reading of every response. Four of those are recent and
  worth naming, because each was a place where a type stood in for a check:
  - **`Env`** is asserted once per isolate at the entrypoints
    (`assertEnvContract`). A missing variable used to surface as a `TypeError`
    inside whichever request first read it, and a malformed numeric one never
    surfaced at all, because `numericEnv` silently substitutes its fallback for
    anything unparseable.
  - **The internal RPC surface** — the `WorkerEntrypoint` bridges — parses each
    argument at the hop (`lib/rpc-contracts.ts`). Same account is not the same
    guarantee, and `region`/`workspaceId` decide which side of the configured deployment
    boundary a record lands on.
  - **Stored SQL rows** are parsed at the read rather than coerced field by field,
    mirroring the columns' own CHECK constraints, so a bad row fails where it is
    read and names its column. `mappers/connection.ts` and the row schemas in
    `note-service.ts` are the pattern; the readers in
    `integrations.ts`, `workspace-service.ts`,
    `connection-service.ts`, `work-opportunity-service.ts`,
    `slack-agent-service.ts` and `resource-service.ts` still hand-coerce and are
    the remaining work.
  - **Route responses** pass their contract before serializing, enforced by the
    `rally/require-validated-response` lint rule. Without it the strict side of
    the contract was the far side of the network: the desktop client parses every
    response it receives, so a malformed body left the Worker with a 200 and
    became a client-side `invalid_response` with nothing on the server naming the
    field. A body the route builds from literals is exempt — the route is its own
    contract there.

- **A row schema bounds what its column does not, or one bad row kills a list.**
  Mirror a `CHECK` exactly, and bound anything the column does not: an enum that
  restates a real constraint can only fail on drift, and naming the column is the
  point, while a column with no length constraint read into a field a contract
  bounds is truncated at the read instead — `origin_label`, `resources.title`,
  `activities.title`. Without that, one over-long value fails every row the same
  query returned.

- **Widen the code before the column.** A migration that relaxes a `CHECK` must
  ship after the deploy that widens the matching enum, or rows written by the new
  schema fail the readers still running the old one.

- **Within one attempt, a run's authority can narrow but never widen.**
  Progressive plugin activation cannot introduce a connection or grant the
  attempt did not start with, and live connection reauthorization drops one the
  workspace has since revoked. **Across attempts it is current state, not
  admitted state.** A run whose Durable Object is reset — which a Worker deploy
  does — resumes by assembling its tool surface afresh, so a connection added
  mid-run can widen the resumed surface; the recorded run scope is a forensic
  record on the root path and is not consulted to bound it. See
  [`agent-harness.md`](agent-harness.md).

- **Business rules live in services or shared packages, never in route
  handlers.** A rule enforced in a handler is a rule the scheduler, the Queue
  consumer, and the Workflow do not get.

- **The renderer is never trusted with a secret.** It never receives provider
  credentials, native PKCE verifiers, OpenRouter keys, Cloudflare administration
  keys, raw IPC, Node integration, or arbitrary navigation.

- **Telemetry observes product state; it never becomes product state or changes
  its result.** Producers emit a closed semantic contract, API outcomes come from
  the authoritative service, and a reporter/destination/processor failure is
  swallowed outside that action. Direct PostHog or arbitrary capture from the
  renderer would violate both halves of this rule.

## Boundary

This document owns the shape of the system: the three surfaces, what each one is
responsible for, how a request or event travels between them, and where the region
boundary sits. It deliberately stops at the point a subsystem has its own
document, and it does not absorb one when it grows:

| For | Read |
| --- | --- |
| Identity, tenancy, and the D1 schema | [`data-model.md`](data-model.md) |
| The configured deployment boundary in detail | [`regionalization.md`](regionalization.md) |
| Trust boundaries and the renderer's isolation | [`security.md`](security.md) |
| The Bind adapter, runs, tools, skills, limits | [`agent-harness.md`](agent-harness.md) |
| Socket admission and the ticket | [`realtime-sockets.md`](realtime-sockets.md) |
| The connector registry and manifest model | [`connectors.md`](connectors.md) |
| Model routing flags | [`feature-flags.md`](feature-flags.md) |
| A Canvas, its audience and its artifacts | [`canvases.md`](canvases.md) |
| A Sidekick, its shared conversation and its runs | [`automation-lifecycle.md`](automation-lifecycle.md) |
| The macOS status item | [`menu-bar.md`](menu-bar.md) |
| Regional product telemetry and crash reporting | [`telemetry.md`](telemetry.md) |
| Hosted resources, secrets, deployment, incidents | [`runbook.md`](runbook.md) |
| Operator discovery and raw Durable Object SQLite inspection | [`engineering-mcp.md`](engineering-mcp.md) |

A new module is added to this map in a sentence and documented in its own file per
[`module-documents.md`](module-documents.md); the map does not grow a section for
it.

## Failure modes and limits

- **A AgentLoopDO feed that cannot prove its replay gap is complete is
  snapshotted, not guessed.** If hibernation discarded the in-memory window or
  the gap is incomplete, the agent sends canonical state on the same socket and
  then closes the subscription race with one in-memory catch-up. Snapshot
  failure or catch-up overflow falls back to `history_unavailable` without
  admitting or advancing the socket. A client cursor ahead of the durable
  sequence is different: the agent sends
  `resync_required` with reason `sequence_ahead`, and the client refreshes over
  HTTP because its ordinary cursor guard would reject a lower-sequence snapshot.
- **The AgentLoopDO replay cache is bounded to 256 events or 512 KB**, and is memory-only by
  design. The active-stream checkpoint is a separate logical value whose text is
  segmented across bounded Durable Object values and updated once per batched
  delta; it is not an event log and cannot replay
  non-stream mutations.
- **Publishing to a AgentLoopDO feed is best-effort** and swallows its own failures. The one
  exception is a retraction: `publishWorkstreamEvent` reports whether the room
  accepted it.
- **A revocation closes the socket with `1008` and the desktop stops retrying** —
  the ticket behind a retry now answers 404. The revocation arrives as a queue
  message published by whoever ended the access; see
  [`access-revocation.md`](access-revocation.md).
- **Reconnect uses equal-jitter exponential backoff capped at 30 seconds**, pauses
  while offline, and resumes from the last cursor/waterline for that socket role.
- **Queue delivery is duplicate-prone and unordered by design.** A parent
  retains every state outbox row until its destination has it; WorkspaceDO
  compares authority generation and the affected common/viewer waterline.
  UUIDv7 order alone never decides freshness.
- **Dictation admission is authenticated and bounded by concurrent sessions**,
  with a one-minute single-use ticket and size-bounded audio-buffer events.
  Arrival timing does not determine whether audio is valid. Raw microphone audio
  and transcripts are not persisted by that bridge.
- **A run stops rather than repeating an ambiguous external write.** Context,
  token, iteration, and streaming-watchdog limits terminate root runs;
  inline children and the other
  bounded callers also enforce their explicit cost, tool-call, and wall-clock
  ceilings. The caller-specific numbers are in
  [`agent-harness.md`](agent-harness.md).
- **A missing or malformed Worker variable fails the isolate at its entrypoint**
  rather than inside the first request that happened to read it.
- **Cross-region workspace-content access is not implemented for product
  callers.** The only path is deliberate operator inspection through the
  Access-protected engineering MCP; it has no product fallback and persists no
  returned content.

## Testing

There is no suite for "the architecture" — the invariants above are enforced by
the gates every change runs, and by the suites of the documents in the boundary
table.

- `pnpm lint` (zero warnings) carries `rally/require-validated-response`, which
  is the enforcement for the route-response invariant.
- `pnpm typecheck` and `pnpm test` run across every package.
- CI additionally runs `pnpm test:scripts`, both Wrangler dry-run builds, the
  desktop release invariants
  (`pnpm --filter @rally/desktop test:release`), and a Gitleaks scan over the
  commits the pull request adds to its base branch.
- `pnpm smoke:local` and the manual desktop acceptance flows are in
  [`e2e.md`](e2e.md); running both Workers and the Electron client locally is in
  [`dev-environment.md`](dev-environment.md).

The traps are environmental rather than architectural: in a sandbox the API starts
with `pnpm dev:api:local`, because the `ai` binding forces a remote proxy session
that takes configured deployments down without Cloudflare credentials.

## Security and trust model

The Electron renderer never receives provider credentials, native PKCE verifiers,
OpenRouter keys, Cloudflare administration keys, raw IPC, Node integration, or
arbitrary navigation. Main validates every exposed IPC call against a live Rally
window and its pinned renderer origin. API logs redact tokens, codes, bodies, file
contents, model context, and unnecessary personal information. External actions
and authorization decisions create audit records with structured correlation IDs.
Immutable run scopes and live connection reauthorization ensure progressive plugin
activation can narrow, but never widen, a run's original authority.
Telemetry IPC is a closed named surface, local files are owner-only and bounded,
and raw dumps remain in a dedicated regional bucket behind audited opaque-ID
access and no-egress symbolication.
[`security.md`](security.md) owns these boundaries.

## Changelog

### 2026-11-07 — The product is Canvases and Sidekicks; the native iOS client is deleted

**What changed:** `apps/ios` and `ios-client.md` are gone; the deployment
surfaces are the Electron desktop and the browser SPA. The Channel, Space,
Thread and Breakout parents, their control socket and the cross-Thread
directory are deleted: `WorkspaceDO` hosts a Canvas or a Sidekick over one
`AgentLoopDO` per conversation, and the workspace socket carries each viewer's
Canvas and Sidekick lists.

**Why:** The Canvases and Sidekicks pivot
([PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md)) makes those the two
sections of the product, and deletes iOS rather than carrying a prototype
client forward.


**Consequences:** `platform: "ios"` push registration stays in the contracts
(`push-notifications.ts`) with no client sending it. The owning documents for
the hosting and the conversation object are
[`hosted-conversation-parents.md`](hosted-conversation-parents.md) and
[`workstream-durable-object.md`](workstream-durable-object.md).

### 2026-09-17 — A lite browser host reuses regional identity

Added a browser Worker and passwordless entry beside the desktop and native
clients. The browser is for scoped collaboration without setup or onboarding;
it uses the ordinary session ledger through the regional cookie adapter. The
host forwards through configured service bindings rather than accepting API
hosts from links. Business authority remains in the API. Shared collaboration uses standalone
visible conversation feeds; this adds no socket relay
or separate guest identity system. See [browser-client.md](browser-client.md).

### 2026-09-11 — Native iOS is a fourth deployment surface

**What changed:** The map now includes `apps/ios`, a native SwiftUI client that
signs in with the desktop Google PKCE exchange, holds sessions in the Keychain,
speaks the existing regional HTTP and conversation-feed contracts, and
registers Apple push on the same device registry as the Mac. Electron
remains the desktop surface; iOS is not a mode of it.

**Why:** A phone client that wrapped the renderer would have imported a second
UI toolkit and a WebView trust story into a repo that already isolates one
renderer. Native SwiftUI reuses Worker contracts and keeps iOS secrets in the
Keychain. The alternative — Expo or React Native — was rejected because it
would be a second product pipeline for the same API.

**Consequences:** Architecture changes that assume "the client" is Electron
(preload, CSP, `safeStorage`, IPC) do not apply to iOS. New client-visible
contracts still land in `packages/contracts` and must be implementable from
Swift without a Node process. Details live in [`ios-client.md`](ios-client.md).

Shipped in #725.

### 2026-09-10 — Escape closes the Sidekicks window, through a gesture Settings no longer owns

**What changed:** The Escape-closes-this-window gesture is now the shared
`renderer/lib/window-escape.ts` — `escapeClosesWindow` and the
`useEscapeClosesWindow` hook that installs it — and the Sidekicks window is its
second caller. The gesture is opt-in per window rather than a property of being
a window: the deep-link-error window does not install the hook and
still do not answer Escape. `WorkspaceApp` installs it for the Settings and
Sidekicks surfaces while `workspace.data` is absent, so `Opening workspace…` and
the service-setup error answer Escape rather than being the dead end the
keystroke exists to leave, and stands down once the screen is there so the two
installs never both answer — the higher one nominates no scope and would close
Settings over a draft its pane guard had just refused. The predicate also
declines an Escape belonging to an in-flight IME composition, which the
Settings-only version did not check.

**Why:** The gesture was written once for Settings, with its dialog, modifier,
`preventDefault`, and unsaved-text reasoning inside a 2,500-line screen. Rally
opens four secondary windows and every one of them will eventually want it, so
the second caller was going to be a copy of a subtle predicate rather than a
call to it. What differs between windows is one question — *would closing cost
text that has nowhere to come from?* — so that is the only thing a caller passes:
Settings nominates its visible pane, the Sidekicks window nominates nothing,
because a conversation composer's draft is cached on the device and comes back.
The IME check came with the move: the Sidekicks window's writing surface is a
chat composer, where an Escape that abandons a candidate is the common case, and
a window that closed over one would take a sentence with no undo.

The pre-screen install came out of review. Installing inside the screen made the
gesture a property of the workspace query rather than of the window: while the
profile was loading, `Opening workspace…` had nothing on it to click and Escape
did nothing, which is the dead end this entry is about, in the state a person is
most stuck in. Putting it in `WorkspaceApp` covers both surfaces at once, which
matters more than it looks — installing for Sidekicks alone would have made two
structurally identical windows behave differently during load, the exact drift
the extraction exists to prevent. The `!workspace.data` condition is the whole
safety argument and should be read before either install is moved: the two must
never be armed together, because the higher one nominates no scope and would
close Settings over a half-written invitation the screen's pane guard had just
refused.

### 2026-09-03 — An automation is a conversation parent, not a sibling authority

**What changed:** `AutomationAgent` is replaced by `AutomationDO`, which sits
beside `WorkstreamDO` as the second kind of conversation parent over one shared
base, and whose substream `0` is the automation's own chat. The map above no
longer shows an automation provisioning work streams for its runs; a run is a
child substream under the automation. The Worker's conversation surface is
`/conversations/:parentId` for both kinds of parent, and every asynchronous hop
between the objects rides `ACTIVITY_QUEUE` with its envelope inline.

**Why:** The previous entry of 2026-08-28 drew the line as "the workspace owns
the fan-in, the automation owns its state, the run is a work stream". The
third clause was the compromise that cost the most: a run's work stream needed
an origin type, an exposed flag, and a directory row the sidebar filtered out,
because nothing but a work stream could parent a conversation. Making the
parent role explicit and giving it to the automation removed that. The rest of
the reasoning is in [`workstream-durable-object.md`](workstream-durable-object.md)
and [`automation-lifecycle.md`](automation-lifecycle.md).

**Consequences:** The runtime component map has four migrated Durable Object
classes again (`WorkspaceDO`, `WorkstreamDO`, `AutomationDO`,
`SubstreamAgent`), and the line a future change should check itself against
moved: a conversation belongs to a parent, a parent answers the contract in
`packages/contracts/src/conversation-parent.ts`, and anything that needs to own
conversations becomes a parent rather than minting hidden work streams.

### 2026-09-03 — HyperSight is removed as a subsystem

**What changed:** Rally no longer has a BlockDashboardAgent, HyperSight panel,
configuration or refresh services, socket audience, model role, or stored
runtime state.

**Why:** The feature is being removed completely; a hidden or flag-disabled
subsystem would still carry authority, migrations, and operational cost.

**Consequences:** The durable hierarchy is WorkspaceDO to WorkstreamDO to
SubstreamAgent. Forward migrations delete the retired object class and its
object-local tables; historical migrations remain immutable evidence.

Shipped in #541.

### 2026-09-01 — Desktop identity remains plural across regions

**What changed:** Successful workspace activation retains the narrow Global
identity session while Electron stores independent regional workspace sessions
and selects exactly one. Discovery links regional accounts by verified email
rather than assuming their user UUIDs match.

**Considered and rejected:** Rebinding one refresh token between regions and
making the platform user UUID universal. Both collapse authorities that are
kept separate in storage, signing keys, and deployment.

**Consequences:** The encrypted desktop envelope is an account credential set;
only its active workspace credential crosses the renderer session bridge, and
Global identity retains no workspace-content authority.

Shipped in #464. Design: [Multiple workspaces PRD](PRDs/2026-08-31_multiple-workspaces/prd.md).

### 2026-08-30 — Public inference pricing gets one scheduled producer

**What changed:** Global now deploys a fourth Worker whose hourly scheduled
handler refreshes OpenRouter endpoint averages into the KV namespace both
regional APIs read. The cache has one canonical model-ID key per record and
stores decimal costs as strings. Deployment builds, profiles, uploads, and
promotes seven total Worker artifacts.

**Why:** Provider pricing is shared fleet metadata, not request or workspace
state. Refreshing it inside an arbitrary inference request coupled member
latency and Azure eligibility to an OpenRouter catalog write.

**Considered and rejected:** A Workflow adds durable orchestration without a
durable multi-step transaction to resume; one cron execution is fourteen reads
followed by fourteen small writes. One cron per region would duplicate and race
the same public metadata.

**Consequences:** Inference is read-only against pricing KV, stale valid records
remain available during catalog outages, and a missing record omits Azure. The
Global-only cron is a deployment dependency but not a regional product
authority; [`api-worker-deployment.md`](api-worker-deployment.md) owns its build
and rollout contract.

### 2026-08-30 — Heavy provider graphs move behind typed Worker services

**Why:** Cloudflare evaluates a Worker's static module graph before serving it,
and the monolithic graph crossed the platform startup CPU limit. The controllable
unit is a Worker graph, so heavyweight stateless capabilities need independent
graphs rather than conditional evaluation inside the API.

**Considered and rejected:** Dynamic imports were rejected because Rally's
dependency graph must remain visible to TypeScript and deployment tooling before
execution; request-time loading merely transfers initialization to product
traffic. Splitting Durable Objects was rejected because it would add authority
and namespace migration without isolating the relevant provider libraries.
Retry and minification were rejected because they preserve the timing race.

**Consequences:** Product authority and object identities remain in the API,
while two private compute services become regional deployment dependencies.
Their RPC contracts must remain compatible through service-first rollout, all
imports remain static, and every Worker graph has independent startup evidence.
[`api-worker-deployment.md`](api-worker-deployment.md) owns the detailed build,
test, failure, and rollout contract.

### 2026-08-28 — An automation becomes its own Durable Object

**What changed:** `AutomationAgent` joins the runtime component map as a fifth
Durable Object class, one per automation, owning that automation from its first
authoring turn through every run. WorkspaceDO keeps the connector-event fan-in,
a content-free automation directory, and the typed external-event routing ledger;
`schedules` no longer names an automation, and automation memory is no longer a
workspace memory scope. A generated run re-checks its parent's live lifecycle and
authority generation before a provider write.

**Why:** Automations were spread across the compiler, subscription rows, the
workspace scheduler, and three separate run producers, with no single place to
reserve a transition and no way to tell an unfinished draft from a broken
automation. The map in this document showed a workspace that owned automations;
the product needed one authority per automation and a workspace that owned only
the fan-in every automation shares.

**Considered and rejected:** Making it a `SubstreamAgent` subclass, which would
couple authoring to a child execution loop; a Workflow or a dynamically deployed
Worker per automation, rejected because the trigger vocabulary is declarative and
must stay inspectable and unable to run arbitrary connector code.

**Consequences:** This map now has a fifth object class with its own socket, its
own alarm, its own migration ledger, and its own place on the access-revocation
walk — each of which is a checklist item for the sixth. The workspace remains the
right authority for anything many destinations share, and the wrong one for
anything a single automation owns; that line is the one a future change should
check itself against. [`automation-lifecycle.md`](automation-lifecycle.md) owns
the detail.

Shipped in the pull request for this change. Design:
[the durable automation lifecycle PRD](PRDs/2026-08-25_durable-automation-lifecycle/prd.md).

### 2026-08-24 — Ace is a separate internal deployment surface

**What changed:** Ace joins the architecture as an Access-protected Hono Worker
with its own assets and deployment, while its product-flag delivery crosses into
the regional API Workers through Queues and WorkspaceDO RPC.

**Why:** Internal administration will grow beyond feature flags and needs one
stable home and visual system. Putting its management routes in the customer API
would mix an employee trust boundary and Cloudflare management credential into
both regional product deployments.

**Considered and rejected:** Extending the migration tracker would combine an
operational schema inventory with product administration and give both one
credential surface. Adding routes to each regional API would duplicate a global
Flagship configuration and make operators choose a region.

**Consequences:** Future internal administration extends Ace and its component
library. Ace may coordinate regional work only through explicit bindings and
opaque messages; it does not become a public API or a cross-region data plane.

### 2026-08-21 — A child's state change reaches the workspace socket immediately

**What changed:** After WorkstreamDO commits a batch of child effects, it hands
the resulting directory effects straight to WorkspaceDO over the existing RPC
instead of leaving them for its alarm. The call is bounded to one batch, never
awaited by the child's response, and swallows its own failures. Everything else
already existed: `publishWorkstreamState` was already the per-viewer fan-out,
and the desktop already applied `workspace_workstream_state` through the
waterline ledger.

**Why:** A run going from running to completed reached the *open* work stream
at once, over the control socket `broadcastMetadata` writes to. Every other
surface — the sidebar row, a second window, another member watching the same
workspace — could only learn about it after the effect had gone outbox, alarm,
Queue, consumer batch, RPC. Queues is at-least-once and unordered by design and
the alarm adds its own delay in front of it, so the surfaces a person actually
watches while waiting for a run were the slowest to know it had finished. The
push itself was never the missing piece; its trigger was.

**Considered and rejected:** *Publishing state from WorkstreamDO's own control
socket to every workspace member.* That socket is per-work-stream and only its
readers are connected to it, so the sidebar of someone with the work stream
closed is exactly who it cannot reach. *Broadcasting one frame to all workspace
subscribers and letting clients filter.* Audience here is per person — a
personal work stream is invisible to non-participants — so a shared frame would
put rows on the wire for viewers who may not read them, and make the client the
enforcement point for a visibility rule that belongs to the object. *Replacing
the Queue with the direct call, or letting the direct call consume the outbox.*
The Queue is the durability guarantee across a WorkspaceDO that is evicted,
overloaded, or mid-deploy; the eager call is an optimization that must be
allowed to fail silently, and anything it consumes is something another path
was relying on finding. *Awaiting it inside the
child's effect application.* That would make committing a child's state
conditional on the workspace being reachable, which inverts the ownership the
outbox exists to establish.

**Consequences:** The eager call delivers but deliberately does **not**
acknowledge, so the outbox lifecycle is untouched and the two paths are purely
additive: the Queue's later copy of the same effect finds WorkspaceDO's receipt
for that `messageId` and `payloadHash`, reports no change, and publishes nothing
a second time. Acknowledging was the first attempt and was wrong — draining the
outbox eagerly left the activation fence reporting it had flushed nothing,
because the effects it gates on had already gone, and it moved `not_before`
forward on the Queue path it was racing. Delivery is worth racing the Queue at;
ownership of the outbox is not, and a later change here has to keep that line.
The in-flight guard is memory-only, so a hibernated object wakes willing to try
again, costing a redundant call the receiver deduplicates where the opposite
would silently drop the push. And `publishWorkstreamState` now runs on a hot
path: one directory query per subscribed socket, so a state change costs
O(connected viewers of that workspace).

### 2026-08-21 — Canonical reconciliation is served by the room, not refetched

**What changed:** The desktop no longer reconciles a work stream by fetching
`GET /workstreams/:id` and `GET /workstreams/:id/messages`. It sends
`request_snapshot` on the SubstreamAgent socket it already holds, and the room
replies with the ordinary sequenced `snapshot` frame — `fulfillSubscription` at
sequence zero, with the socket held out of broadcasts while the frame is
assembled and the in-memory catch-up replayed after it. One request is
outstanding at a time. A reconnect no longer reconciles separately at all: the
`subscribe` cursor already makes the room replay what was missed, snapshot when
it cannot, and ask for a resync when it can prove neither. REST reconciliation
survives only for recovery after `resync_required`, where there is no socket to
ask on.

**Why:** The old reconciliation restarted itself whenever the room sequence
advanced while its two fetches were in flight, and it measured that with
`lastSequence` — the *room event* cursor, which `stream_delta` advances once per
coalesced token batch. Streaming frames carry no canonical state, so the test
that asked "did canonical state move under me?" was answered "yes" by the one
class of event that provably could not have moved it. During a run the condition
was therefore always true and the restart had no convergence criterion: one
viewer of one streaming work stream refetched the detail and the transcript
every ~600–900 ms for as long as the run lasted. Production logs for
2026-08-20T22:48Z show 15 detail reads and 14 transcript reads for a single work
stream in 21 seconds, each pair costing two authenticated D1 session reads and
two authority reads before doing any work.

The transport was the deeper error. The room is the authority for both halves a
reconciliation needs and can assemble them at one sequence; two REST reads are
separately authorized, separately timed, and can straddle a write, so detail and
transcript could disagree with each other in a way one snapshot cannot. The
socket's own subscribe path had already solved the concurrency problem correctly
— hold the socket out of broadcasts, deliver, then replay the window — and the
client had reimplemented it as an unbounded retry. The code comment asserting
"REST is now used only to page older history or recover after `resync_required`"
predates this change; reconciliation was the standing violation of it.

**Considered and rejected:** *Keeping REST and fixing only the staleness test*,
by tracking a separate canonical-only sequence that streaming frames do not
advance. It removes the observed loop and nothing else: two round trips remain,
the two halves can still disagree, and the next event class that is neither
clearly canonical nor clearly transient has to be classified correctly by
whoever adds it. *A correlated direct reply*, like `message_page`, carrying a
`requestId`. Direct frames are deliberately outside the room sequence, so the
answer would arrive unordered against the feed and the client would be back to
reasoning about which of two concurrent answers is newer — the exact question
the sequenced frame makes unnecessary. *Re-sending `subscribe` with
`afterSequence: 0`*, which needs no contract change and reaches the same code.
Rejected as a pun: it reads as "I am joining" on a socket that is already
joined, resets the resume cursor as a side effect, and rebroadcasts presence.
*Letting the room push canonical state on terminal status by itself*, which
would send a full transcript to every subscriber on every run completion whether
or not any of them had drifted.

**Consequences:** `request_snapshot` is refused unless the socket is subscribed
— an unsubscribed socket has no feed to refresh, and answering one would serve
canonical state on a connection that skipped the subscribe path's authority and
maintenance checks. The handler must leave the attachment subscribed on every
exit, including a throw: a socket left unsubscribed stops receiving every future
frame, and a reader cannot tell that from a quiet work stream. Anything that
makes `snapshot` frames non-sequenced, or removes the client's cursor guard,
re-creates the staleness question this change removed and will most likely be
patched with another retry. The path is deliberately **not** traced: it is a
background repair rather than one of the three flows a person waits on, and
`docs/performance-tracing.md` reserves `PerfFlow` for those — the cost is that a
slow reconciliation shows up only as its `http_request`-free absence, and adding
a fourth flow is the lever if that turns out to matter.

### 2026-08-18 — D1 becomes a thin identity and routing plane

**What changed:** WorkspaceDO now owns all workspace-scoped product domains:
connector credentials/connection-scoped replay receipts/OAuth attempt status/local
handoff, Terminal egress policy history,
automations, digests/schedules, resources/notes/watches and R2 lifecycle refs,
memory, activity/discovery, notification intents, and external delivery
state. Services keep their repository contracts through a typed
WorkspaceDO SQL port; mixed WorkspaceDO/D1 or WorkspaceDO/SubstreamAgent
transactions are rejected. WorkspaceScheduler reads due work from WorkspaceDO.

**Why:** Every moved record has one workspace owner. Leaving those records in
D1 preserved a second product database and forced agent/workflow paths to cross
authority boundaries for data that can be joined transactionally inside the
workspace object.

**Considered and rejected:** D1 serving projections, per-domain Durable
Objects, and dual writes. The maintenance window permits direct cutover, and one
WorkspaceDO provides the required relational boundary without adding
distributed joins. Connector Queue messages deliberately contain the bounded
normalized event because the ID-only alternative needs a D1 event-body relay;
large/raw provider bytes remain in R2.

**Consequences:** D1 remains on authorization and pre-workspace routing paths,
not product serving paths. Connector ingress uses global routing -> regional
Queue -> WorkspaceDO -> Workflow. R2 stores bytes while WorkspaceDO stores the
only authoritative pointers and deletion intents. Terminal paths explicitly
split child provenance from workspace resource/policy reads.

### 2026-08-18 — Every agent owns a direct resumable output socket

**What changed:** `BlockDashboardAgent` joins `SubstreamAgent` as a direct
Electron streaming authority. Both publish the shared full-checkpoint contract;
WorkstreamDO continues to own block configuration, dispatch coordination, and
published terminal results rather than relaying token traffic.

**Why:** Independent agent loops need visible progress and exact reconnect
semantics, while a model-free parent should not become a high-frequency stream
proxy.

**Considered and rejected:** A WorkstreamDO-only block channel, polling, and
delta-only recovery. They concentrate stream load, reduce progress fidelity, or
produce duplicate/missing text after reconnect.

**Consequences:** This decision supersedes the earlier no-fourth-socket
consequence below. Electron has a fourth socket role and opens one block socket
per configured block only while HyperSight is visible. Idle sockets hibernate;
committed checkpoints survive eviction; shared metadata remains on the parent.
User commands enter WorkspaceDO, while the SubstreamAgent and block-agent
sockets are read-only data-plane feeds rather than remnants of the legacy
single-room mutation protocol.

### 2026-08-18 — HyperSight shards by block, workspaces pin hierarchy affinity, and Electron connects at all three authority levels

**What changed:** *HyperSight sharding.* WorkstreamDO now owns HyperSight
configuration and durable fan-out, while each block ID resolves to a
`BlockDashboardAgent`. The block agent executes Bind, directly uses main
`SubstreamAgent("0")` for fenced source runtime SQL, and settles versioned
results into WorkstreamDO for its socket.

*Electron sockets.* Each authenticated renderer for the active workspace has one
persistent WorkspaceDO synchronization/command socket. Each selected or running
work stream has a WorkstreamDO complete-metadata socket and a SubstreamAgent
transcript/stream socket. Workspace changes invalidate typed D1 query surfaces;
work-stream snapshots update aggregate/sidebar caches directly.

**Why:** Dashboard blocks need independent long-running recovery but are not
independent conversations. Keeping configuration/publication in the parent and
source data in the transcript agent preserves both authorities while allowing
blocks to run in parallel.

Fixed western placement made eastern users pay avoidable latency, but using each
caller's current location would scatter a single workspace's parent and
children. First placement is a one-time decision, so it belongs to the workspace
routing record.

Workspace settings/directories, aggregate work-stream metadata, and ordered
agent output are independent consistency domains. A lazy command-only workspace
connection and token-only child feed left the first two without a live
multi-client synchronization path.

**Considered and rejected:** For HyperSight: model execution in WorkstreamDO,
fan-out owned by the source agent, using substreams for derived blocks, one
shared HyperSight agent, Workflows, and replacing Bind with the Agents SDK.

For placement: per-request child placement and a mandatory WorkspaceDO
provisioning hop. The former breaks colocation; the latter puts a parent on
every child-creation path.

For the sockets: multiplexing all tokens through WorkspaceDO, polling REST for
metadata, and copying authoritative D1 workspace rows into the object. Those
choices create a throughput hotspot, background request churn, or a split
authority.

**Consequences:** The hierarchy has two agent child types with shared lifecycle
primitives. Operators must distinguish low-volume parent dispatch/result RPCs
from direct block-to-source runtime SQL, and Electron needs no fourth socket.

New workspace surfaces need a typed invalidation topic; new aggregate fields
need complete WorkstreamDO snapshots; and user writes remain exclusive to
WorkspaceDO while both child-scoped sockets stay read-only.

### 2026-08-17 — The stateful hierarchy becomes workspace, work stream, substream

**What changed:** The regional graph is now `WorkspaceDO -> WorkstreamDO (no
agent) -> SubstreamAgent`. The workspace socket accepts user commands, Electron
streams directly from the child feed, the child runs the complete Bind loop and
owns timers, and the parent aggregates child projections into the regional
sidebar/activity/notification bridge.

**Why:** Authorization/routing, aggregate metadata, and model-context ordering
are three different serialization boundaries. Combining them makes either the
workspace or the work stream a token-stream/agent bottleneck.

**Considered and rejected:** A single workspace object, a single agent object
per work stream, and proxying child feeds through either parent.

**Consequences:** Every cross-object relationship is a typed RPC plus durable
receipt/outbox rather than a SQL join. Main child `0` preserves the historical
name during maintenance class rename; the newer jurisdiction entry above
defines when that name resolves to a distinct imported object.

### 2026-08-17 — WorkstreamDO is the complete work-stream-down authority

**What changed:** The architecture boundary now places transcript, runs,
compaction, suggestions, wakeups, and Terminal persistence in one
SQLite-backed WorkstreamDO. D1 retains workspace/control state and rebuildable
directory, activity, resource-link, and notification projections.

**Why:** A partial move leaves one logical work-stream mutation split between
two canonical databases.

**Considered and rejected:** Retaining D1 as a product fallback or Terminal/run
ledger. Both would allow post-cutover divergence.

**Consequences:** Cross-work-stream consumers use the durable regional-effect
bridge, and an unavailable object fails closed instead of falling back.

### 2026-08-17 — The foreground socket carries authored message commands

**What changed:** Desktop-authored messages now enter the existing WorkstreamDO
socket as idempotent commands. A private command receipt reports completion,
while the canonical message continues through the shared ordered event log.

**Why:** A foreground send and its realtime result are one interaction owned by
one work stream. Splitting request and result across REST and WebSocket made a
lost HTTP response ambiguous and required a second routing path to the same
authority.

**Considered and rejected:** A workspace-level socket would add a parent hop to
every work-stream mutation and make the workspace object a message bottleneck.
Using the broadcast event as an acknowledgment cannot represent failures after
the message commit, including a failed harness launch.

**Consequences:** Session identity is part of the verified room attachment,
authorization is checked again on every message command, and clients retry only
with the same client message ID. Private receipts never advance or participate
in replay cursors.

### 2026-08-17 — Workstream objects project regional effects through Queue

**What changed:** The work-stream boundary now includes the outbound path from
an object-local transactional outbox through the regional Queue and D1 inbox to
sidebar, activity, and notification consumers.

**Why:** Workspace-wide and person-specific query/delivery state must follow an
object mutation durably even though it belongs in the regional control plane.

**Considered and rejected:** Synchronous D1 and provider calls from the object;
they cannot atomically follow the local commit and make user latency depend on
regional/external availability.

**Consequences:** Regional effects are eventually consistent, at-least-once,
hash-checked, version-ordered, and acknowledged back to their source object.

### 2026-08-17 — Work-stream rooms expose their SQLite storage and gain a maintenance-fenced cutover

**What changed:** `SubstreamAgent` keeps its namespace and product boundary but
replaces free-form Durable Object key/value records with an explicit local SQL
schema. The room imports identity, sequence, active output, pending HyperSight
work, and ticket receipts in place before accepting an event or socket. The
existing one-workstream-per-DO namespace then gains the normalized product
schema and a regional campaign that drains runs, imports and verifies every
object, seeds directory projections, activates one generation, and fences legacy
D1 product writers.

**Why:** The namespace was already SQLite-backed, so a second class and an
object-fleet copy would add risk without changing placement. Named relational
owners make recovery and schema evolution inspectable before the authority
campaign imports regional product rows. Named local tables without a writer
switch are only a shadow copy, though: the approved maintenance window removes
live tailing and dual-write conflicts while still requiring fleet-wide evidence
before authority opens.

**Considered and rejected:** A new Durable Object namespace, which changes
object identity without changing placement; a live migration, which requires
holding queues, tail reconciliation, and conflict policy; and an unfenced
authority flip, for which the maintenance campaign supplies the missing fence.

**Consequences:** An old room pays one lazy local migration on its first wake.
Room code must use `WorkstreamObjectStore`; future DDL uses a new immutable
schema version. D1 remains workspace/control authority and the directory query
plane. Each opened WorkstreamDO becomes product authority, quarantine never
falls back, and the final regional open is an explicit operator action;
authority remains phase-dependent until that open.

Shipped in the pull request for this change.

### 2026-08-13 — Regional telemetry joins client intent to server truth, separates projection from control, and gives main the crash generations

*Native crashes.* The first regional telemetry module boundary in Electron main:
Crashpad writes only inside an active route-final generation, and a later
process rotates or purges that whole generation before starting another handler.
The detailed lifecycle and future regional pipeline live in
[`telemetry.md`](telemetry.md).

**Why:** Product funnels need the intent visible only in the client and the
result known only by the service, while crash reporting must survive renderer
and process failure without placing provider authority in that renderer.

Crashpad cannot be stopped after startup and cannot use Rally's required
authenticated-header uploader. Giving main ownership of the directory above the
live database preserves Electron's supported boundary while allowing policy,
region, and absolute retention to be enforced between launches.

**Considered and rejected:** A PostHog SDK in Electron, automatic DOM/network
capture, a Global region-pending queue, Segment as a second destination layer,
and using analytics as canonical state. Those shapes either weaken the
trust/region boundary or lose the semantic server outcome. Also one
bidirectional telemetry bridge, a shared capability key, and leaving
replay/raw-access helpers without a deployed authorization boundary.

**Future changes must preserve:** Renderer code never owns crash paths or
transport, and main never reads or mutates a database while its Crashpad handler
is active.

Shipped in the pull request for this change. Design: [regional telemetry
PRD](PRDs/2026-08-12_regional-product-telemetry/prd.md).

### 2026-08-13 — Daytona is an external execution substrate, not a fourth Rally surface

**What changed:** The regional API composes a deferred Terminal plugin whose
first tool call reaches a private Daytona sandbox. Rally D1/R2, Bind receipts,
the workspace scheduler, resource subsystem, and GitHub App publisher retain
their existing ownership.

**Why:** Code execution needs an isolation substrate, but making Daytona a
canonical application surface would move authorization, retry state, resources,
and regional lifecycle outside Rally's existing owners.

**Considered and rejected:** Treating provider labels/state as the control
plane, exposing Daytona directly to Electron, and introducing a separate
Terminal Workflow. They respectively cannot enforce tenant authority, create a
new client trust boundary, or duplicate the existing harness/scheduler state
machines.

**Consequences:** Daytona SDK calls remain behind one regional adapter; loading
Terminal cannot allocate; and any alternative provider must implement the same
internal sandbox contract without changing model-facing tools or canonical
state.

Shipped in the pull request for this change. Design:
[`docs/PRDs/2026-08-12_daytona-terminal-git-github/prd.md`](PRDs/2026-08-12_daytona-terminal-git-github/prd.md).

### 2026-08-12 — Root work-stream runs use a caller-specific resource policy

**What changed:** Ordinary root runs now allow 1,000 model turns without
aggregate tool-call, model-cost, or task-scale wall-time ceilings. HyperSight and
other bounded harness products retain their own smaller ceilings, per-operation
watchdogs remain, and Cloudflare's required Workflow deadline is one year for an
ordinary run.

**Why:** A production research run completed eight successful turns and fetched
its final source on the eighth, then the old eight-turn ceiling prevented the
ninth turn from reading that result and answering. The shared defaults treated
legitimate long research and unattended bounded work as the same product.

**Considered and rejected:** Keeping the eight-turn ordinary default would leave
the observed failure intact. Removing the iteration guard entirely was rejected
because 1,000 turns leaves practical research room while still terminating a
pathological model loop. Applying the expanded policy to HyperSight was rejected
because its scheduled refreshes run without a person present to cancel them.

**Consequences:** Cost and tool usage remain recorded but are not aggregate stop
conditions for ordinary root runs. Future resource-policy changes must name the
execution product they govern and preserve the relationship between harness and
Workflow deadlines. The reasoning behind architecture decisions before this
entry was not recorded here and was not reconstructed.

Shipped in #130.
