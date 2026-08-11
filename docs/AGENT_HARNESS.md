# Agent harness

Avalon's production loop is an adapter over `@juno-ai/bind` 11.0.0. Bind owns turn/tool iteration, plugin activation, skill registration and activation, transcript healing, completion-defect detection, streaming resets, and route execution. Avalon's Cloudflare Workflow host and regional D1/R2 stores remain the durable authority for admission, authorization, side effects, accounting, and terminal state.

Each run is one bounded, server-side, tool-using loop inherent to a work stream. It is not a participant, separate persona, terminal, or general code-execution environment.

## Addressing

Before starting a loop, a lightweight classifier returns `agent_action`, `human_only`, `both`, or `uncertain` with confidence and a terse rationale code. Explicit Avalon/connector mentions and clear work requests invoke the harness. Social acknowledgement and human-only coordination can remain unanswered. Uncertain messages invoke only when an active task or explicit tool context exists. The label is not exposed in the UI.

## Naming

A work stream is created under a provisional title — the first non-empty line of its objective — and named by a separate one-shot structured call a moment afterwards. The naming agent gets the objective and the opening message as bounded user-role data: the request is what is being named, never an instruction it follows, and a request asking for a particular name has no more authority than any other outside content. Reasoning is switched off rather than left to the model's default, because the model is relabelling text it has already been handed in full — asking for the lowest *effort* would switch thinking on for a model that does none.

Naming sits outside the creation path deliberately. The person who typed the request is waiting on that response, the run starts against the unchanged objective, and the name arrives over the socket as `workstream_renamed`; a person renaming from the header publishes the same event. Until it arrives the title is a placeholder, so `workstreams.title_status` says so and the sidebar row and header render a skeleton rather than showing the request as though it were a name.

The transcript is what a name is usually missing. A work stream is looked at once more after it reaches five messages — on a new message and at the end of a run, both of which stop on a count for a work stream that is not due one — and named again from the conversation so far, which is where the identifier, the person, or the actual problem tends to arrive. That second pass settles the title for good.

Every write is conditional on the status the pass started from, which is what keeps a person's title safe: renaming a work stream settles it, so a generated name that arrives afterwards is dropped rather than applied, and a title supplied by the caller is settled from the start and never generated over. Every failure — an unreachable model, an unusable answer, an absent `OPENROUTER_API_KEY` — leaves the title standing and still advances the status, because a skeleton that never resolves is worse than a title taken from the request.

## Admission and immutable run scope

The generic Workflow creates one replay-stable attempt identity, reaps expired attempts, and claims a time-bounded D1 lease. At most one unexpired harness lease may run in a work stream. The owner heartbeats while waiting on model output and tools; scope, activation, receipt-plan/completion, checkpoint, and terminal commits require the same attempt ID, lease owner, and expiry. An obsolete executor cannot publish a terminal result, and `completed` cannot commit until its final agent message is durable. Expired attempts are compare-and-swap reaped as failed.

After admission Avalon validates the execution principal and persists an immutable, canonically hashed run scope: principal, eligible connection IDs and capabilities, trigger policy, routing and prompt versions, tool-surface hash, and limits. A replay must reproduce that scope. Connections installed or expanded later cannot enter it; subsequent membership, ownership, grant, health, and policy checks may only remove authority.

## Context and stable prompts

Context is assembled for the execution principal from the work-stream title and objective, recent persisted messages, current and planned execution times, the run reason, and the selected trigger. Automation runs also receive the pinned template name/version, instructions, expected outputs, default behavior, and subscription overrides. A triggering activity or inbound email is added as explicitly untrusted user-role evidence, never promoted into the system prompt.

Attached resources are exposed as an authorized index and hydrated lazily through tools. Full workspace history, unrelated resources, and another participant's private connector data are excluded.

All base prompts are rendered by typed, dependency-free functions in `@avalon/agent-harness`, and the prompt version is frozen with the run. Per-run time, reason, IDs, and trigger evidence are user-role messages rather than mutations of the system prefix, so retries and route fallbacks see stable policy. Bind validates the transcript before inference and heals dangling or orphaned tool-protocol rows; Avalon records diagnostics without adding provider-controlled text to the system prompt.

Prompt authority is layered as platform policy, authorized work-stream and automation configuration, current human instructions, then explicitly untrusted provider/resource/tool data. Both the work-stream agent and automation architect receive a compact, stable-ID-sorted catalog derived only from their already-authorized plugin registry and partitioned into `Currently active` and `Available to load`. Loading a plugin adds its static code-authored guidance under `Active Plugin Instructions` and exposes its exact typed tools on the next model turn. The catalog is stated as capability rather than as a suggestion, because the tools visible on any given turn are only the ones already loaded: an available plugin can answer a question, so consulting the catalog is part of searching, and asking a person for something a listed plugin could look up is a claim that it is unavailable rather than a request for missing input. The automation architect may use those real connector tools to inspect live provider context while drafting; it prefers reads and never performs a provider write merely to test a proposed automation. Remote account labels, resources, and provider content never become trusted plugin prose. User-authored automation draft state remains user-role context.

## Behavior policy

The agent acts on clear scoped requests, infers safe defaults, batches independent reads, prefers authorized connectors over public substitutes, and verifies material writes when a read-back path exists. It requests structured input only when a required identifier, permission, connection, timezone, or irreversible choice has no safe default. It never treats a proposed, failed, or ambiguous call as success and never retries an ambiguous write.

Every address, identifier, URL, name, date, and quoted fact in an outward-facing write must be sourced from a tool result in the run, the authorized task context, or a person in the work stream. Inferring a default settles a choice among safe options and never supplies an unheld fact, so an unsourceable value is a missing identifier that routes to a lookup or a question rather than a plausible placeholder. Identifiers are threaded through unchanged from the result that produced them and from the same connection, and a result carrying only identifiers is a step rather than an answer. These are platform policy and belong here rather than in any one connector's plugin message, because the same failure is available through every connector that writes.

Interactive multi-round work starts with a short plan and reports meaningful phase changes. Headless runs skip progress narration. Completions lead with the outcome, evidence, and blockers; private reasoning is never emitted.

## Automation compilation

Natural-language automation creation compiles to the validated draft schema. The compiler preserves established choices, defaults to personal scope and manual execution when omitted, and writes three to eight self-contained outcome-focused steps. Calendar recurrences require an IANA timezone; exact provider events use deterministic triggers and meaning-based conditions use semantic triggers. Connector manifests expose trusted activity descriptors with exact event names and typed deterministic filters through plugin search, inspection, and loading. Each connector-activity or semantic-activity trigger names a reusable source binding key and suggests one inspected plugin; acceptance binds that slot to one authorized connection without requiring the source plugin to be preloaded at runtime. Required capabilities are the minimum external grants.

The compiler may retain an incomplete draft while asking one focused question. An omitted calendar timezone resolves from the personal user or workspace according to scope; an explicit trigger timezone wins. Missing resources, event sources, destinations, or unsupported schedules still require input. The compiler never invents credentials, access, resource IDs, event types, or filter fields; ready drafts must use an inspected connector's declared activity vocabulary. Invalid structured output gets one sanitized repair attempt, then `502 model_output_invalid` with a request ID.

## Connection plugins and authority narrowing

Every connector adapter supplies a static agent-plugin descriptor whose provider type and tool order must match its manifest. At run start Avalon creates one Bind plugin per eligible installed connection, identified as `connection:<uuid>` with a stable hashed wire prefix. Its tools are narrowed to the connection's frozen grants and run policy:

- Ad-hoc runs may include healthy workspace connections and the initiating user's healthy personal connections.
- Automation runs include explicitly bound connection/capability pairs and eligible connections attached through work-stream resources. Attached connections remain limited to the immutable grants frozen for the run.
- Inbound-email runs remove external connector writes.

Bound connections, attached resources, and previously used plugins are activation hints, not extra authority. Hints are filtered through the frozen scope and reauthorized before restoration. Other eligible plugins appear only in a bounded catalog and are discovered and activated with the always-active `avalon_discovery` tools: `list_plugins`, `search_plugins`, and `load_plugin`. Activation is durably recorded before the plugin's tools or trusted guidance become visible.

Every run owns a fresh Bind registry. Canonical tool names are local to their owning plugin and contain no repeated plugin prefix; Bind adds the plugin's stable short name when it renders the model-facing wire name. `avalon_discovery` intentionally retains the global controls `list_plugins`, `search_plugins`, and `load_plugin`. The always-active `avalon_core` plugin owns exact time and structured elicitation, and `avalon_automation_architect` owns automation research and draft submission. Workstream agents load `avalon_workstream` by default for current-workstream context, resources, artifacts, and delegation. Specialized memory and table capabilities retain their own stable plugin identities. The public-web tools live in the loadable `avalon_web` plugin. A runtime registers only the applicable bundles, so plugin instructions and durable receipt identities cannot advertise tools absent from that run.

Loading never widens the frozen scope. At run start, before credential decryption, before every tool call, and between model turns, Avalon revalidates the execution principal, work-stream state, automation subscription and pinned template version, trigger evidence and status, connection identity/scope/owner, current grants, capability, and health. Revocation drops a plugin. Workspace calls use the workspace principal while preserving the initiating user in audit data; personal calls remain owner-only.

Revalidation answers with one of three verdicts, and the third one is the point of having them. `authorized` activates; `denied` is a decision about authority — a revoked credential, a withdrawn grant, an owner who no longer holds the connection — and reaches the model as `plugin_not_authorized`; `indeterminate` means the host could not reach a decision at all, because the provider timed out, the transport failed, or the health check answered something that says nothing about this run's authority. Both non-authorized verdicts leave the plugin inactive, so the distinction costs the run nothing, and it is what stops a provider hiccup from being reported as a permission problem: an `indeterminate` load returns `plugin_authorization_unavailable`, and the host logs `connector_plugin_reauthorization_failed` with the connection and the underlying cause rather than discarding it. An adapter distinguishes the two the same way, through `reconnectRequired` on its health result. A verdict must never be derived from a swallowed exception — a failure to verify is not a denial, and reporting it as one sends a run off to explain a permission problem that may not exist.

## Skills

A plugin gives the model a capability; a **skill** gives it a procedure. Skills are markdown instruction modules — how this workspace triages a queue, what a handover note must carry, the house voice — disclosed in the same three tiers the plugin catalog uses, because a workspace's accumulated know-how does not fit in a context window while a catalog line costs about fifty tokens.

A run's skills are **frozen with its scope**, exactly like its plugins. The host resolves them against the execution principal before admission and passes them on `RunHarnessInput.skills`; nothing in the loop reaches a store, so `load_skill` can only surface a body the run was already authorized to read. When a run has no skills, neither prompt section nor either tool appears.

The always-active `avalon_skills` plugin owns two globally named controls. `load_skill` takes an exact name from the `# Skills` catalog and adds the skill's body to `# Active Skill Instructions` for the rest of the run. `read_skill_resource` reads a bundled reference file, and refuses until its skill has been loaded — that gate is what stops a model pulling every catalog skill's references without taking on the instructions they belong to.

**Loading a skill grants no authority.** Where a skill declares an owner plugin it is offered only to a run whose scope already includes that plugin — the eligible plugin ids are handed to the skill registry, which drops the rest before the catalog is built — and loading it *names* the plugin for the model to load separately rather than activating it: an auto-activation would let a document issue a capability grant. Skill bodies are also not trusted prose about the world — they are workspace-authored instructions, and are wrapped in a `<skill_content name=…>` element so the model can tell them apart from platform policy and from one another.

Three bounds keep a looping model from loading its way into a context-limit error: a count cap, a budget over the total tokens of loaded bodies, and a byte cap on a single `read_skill_resource` response. Bind judges the first two (`admitSkillLoad`); Avalon measures the token half by resolving the bodies the load would actually inject, and applies the third itself — an unbounded Tier-3 read would otherwise route around the Tier-2 budget, since a skill whose body fits can bundle a reference that does not. All three are configurable, through `maxActiveSkills`, `maxActiveSkillBodyTokens`, and `maxSkillResourceBytes`.

The package ships three skills of its own (`BUILT_IN_SKILLS` in `@avalon/agent-harness`), for a host with no library yet: `deep-research`, `writing-an-email`, and `scheduling-a-calendar-event`. The latter two are deliberately provider-agnostic — they name no connector and no tool, because the failures they exist to prevent (an address composed from a name and a domain, a fact quoted from memory, a guest list replaced when one attendee was meant to be added, a write reported as done without a result confirming it) belong to the task rather than to any one provider, and the next mail or calendar connector will carry them too. Neither sets an `ownerPlugin`, so neither implies that loading it granted the connection it describes. It is an ordinary `HarnessSkill` and not a second source: a host still chooses to put it in `skills`, and the frozen-scope rule is unchanged. It is authored in TypeScript rather than as a `SKILL.md` because the harness runs in `workerd`, where there is no filesystem to read one from at startup.

Bind's skill warnings — a name collision that lost a skill, a restored hint refused by a narrowed scope, a drifted pin — surface through `onSkillWarning`. Unwired, they are computed and discarded.

The prompt sections are a pure render of run state. Bodies are rebuilt from the active set on every turn in Bind's total order (origin, then name) rather than spliced into the previous prompt, so a resumed attempt produces the same bytes as a fresh one and the provider's cached prefix survives. Loaded refs are durably recorded through `persistSkillActivation` and restored on the next attempt through `skillActivationHints` — a hint, like a plugin activation hint, so a ref the narrowed scope no longer resolves is dropped rather than restored.

## Loop

1. Claim the lease, validate the principal, freeze the run scope, and load authorized context.
2. Register the applicable stable core plugins plus the frozen connection catalog; restore only reauthorized hints.
3. Reauthorize active plugins, render the stable prompt/tool surface, and ask OpenRouter through Bind's deterministic route plan.
4. Stream text through the epoch-aware protocol; reasoning fields are ignored.
5. Validate tools and recheck authority. Bind runs writes sequentially and may overlap independent reads, while returning results in the model's original call order.
6. Persist each immutable execution plan before execution and make a successful bounded result durable before returning it to Bind.
7. Persist the complete assistant message, then let the lease-owning Workflow append the terminal lifecycle event.
8. Stop on completion, elicitation, durable cancellation, ambiguous write, limit, lease loss, or failure.

Web discovery and page reading are bounded Firecrawl tools. Search returns ranked links and page fetch returns clean markdown. Both are omitted without `FIRECRAWL_API_KEY` and from inbound-email runs.

## Limits

Environment configuration bounds model iterations, tool calls, wall-clock and per-tool time, cost, and plugin-catalog tokens. Request establishment, time to first token, and inter-chunk idle time have separate watchdogs. Active plugin count, active tool-schema bytes, model-visible tool-result bytes, replay payload bytes, and child-result bytes are not capped by the agent runtime. Web results, fetched bytes, and attachments remain independently bounded by their owning tools. Live context size comes only from OpenRouter's returned prompt and completion token counts; Avalon does not estimate it from serialized bytes. After a completed provider turn exceeds 80% of the selected model's OpenRouter `context_length` (with Monad's 200,000-token fallback when the catalog is unavailable), Bind replaces the live tail with an LLM continuation summary. Work-stream checkpoints are stored regionally with the durable sequence boundary so later runs replay the compacted context plus newer messages.

Per-tool time and the model catalog fetch use a **cancellable** deadline whose timer is cleared once the call it guarded returns. The bind loop runs inside a Workflow step, and a Workers invocation ends when its handler returns, so an `AbortSignal.timeout()` left armed after a fast tool call holds that invocation open with nothing left to do until the runtime cancels it as a hang. The rule and its incident are [`RUNBOOK.md`](RUNBOOK.md).

When OpenRouter refuses a call, the harness extracts the provider's own classification — code and provider name — from the error body. The provider's free-text message is available in memory for the immediate control decision and is never logged: some upstreams quote the rejected request back inside it, and a key-based redactor cannot recognise member content arriving inside a provider's prose.

Image attachments retain their exact original object for display and download. Before model admission, the regional Worker validates the byte signature and writes a reusable bounded derivative to regional R2, referenced separately from D1. PNG, JPEG, and WebP are normalized through Cloudflare Images; TIFF and HEIF/HEIC also have bounded local conversion fallbacks. Animated GIFs become a single storyboard derivative with up to six representative timestamped frames plus bounded duration, frame-count, dimensions, and loop metadata. Only the derivative is placed in the model protocol transcript.

Wall-time, iteration, tool-call, and cost ceilings use `run_wall_time_limit_exceeded`, `run_iteration_limit_exceeded`, `run_tool_call_limit_exceeded`, and `run_cost_limit_exceeded`. Limits never silently reinterpret a write as successful.

A tool that throws reaches the model as a failed tool result. Where the thrown error carries a machine-readable half — a `code`, and `details` such as which identifier family was expected, that a connection must be reconnected, or which values were available — that half travels in the failure's `data` field, the slot declared for structured recovery context, so the remediation a tool attached is readable by the caller that has to act on it. Keys outside the result variant's own fields are discarded when the message is encoded, so this is not somewhere a caller may improvise.

The harness reads that half by shape through `readStructuredFailure` in `@avalon/contracts`, rather than importing any provider package's error class. What it forwards is an allowlist — `reason`, `field`, `expected`, `available`, `reconnectRequired`, `retryAfterMs` — under a total size bound, not whatever an adapter chose to attach. Several adapters already pass a whole parsed provider error body as their details, and forwarding those would put raw provider JSON into the transcript and from there into the inference payload logs on every failed call. A connector wanting a new key in front of the model adds it here, where the decision is reviewable.

Workspace admins may opt into **Log agent inference** from Workspace preferences. The default is off. When enabled, the exact regional OpenRouter request body—including messages, tools, plugins, and reasoning settings—is written to the workspace region's R2 bucket, while D1 indexes routing metadata, hashes, outcomes, latency, and the actual token counts returned by OpenRouter. This diagnostic path is best-effort and cannot fail an agent run. Reading a captured payload back — turning a work-stream URL into the exact request a model received — is [`RUNBOOK.md`](RUNBOOK.md#inspecting-a-runs-raw-inference).

## Elicitation

The canonical `request_elicitation` tool belongs to `avalon:core` and is rendered to the model as `core_request_elicitation`. It creates a typed text/radio/single/multi-select block and pauses the shared harness loop. In a work stream, the work stream becomes `needs_input`; a valid answer persists a visible response, clears attention when no blockers remain, and starts a new generic Workflow linked to the previous run. In automation creation, the architect first saves its best partial state with `automation_submit_draft`, then calls the same core elicitation tool; the next creator request resumes from the saved draft and answered conversation.

## Durable receipts and terminal state

Each tool call receives a stable Avalon receipt ID derived from the run, model turn, and original tool position; the provider call ID remains only in the model protocol. Before execution, D1 stores the canonical input and immutable plan hashes, plugin/connection, mode, idempotency policy, and optional provider key. Append-only checkpoints record progress, and completed receipts retain provider operation IDs. Successful output is written to regional R2 and then committed to D1 before Bind can observe it.

Completed receipts replay without another provider call. Incomplete safe reads may resume. A reused or mismatched plan, incomplete prior write, or timed-out `record_before_execute` write becomes `ambiguous_external_write` and is never blindly repeated. Lifecycle events are append-only, and terminalization is idempotent and lease-fenced.

## Model routing and inference ledger

Each agent's default model and its fallback stages are one Cloudflare Flagship flag, resolved once per run and evaluated against the region, the environment, and the run's subject — the workspace, work stream, and user, each carrying the attributes a targeting rule matches on; the regional Worker variables remain the checked-in default that an absent flag, an unbound binding, and a failed evaluation all resolve to. [`FEATURE_FLAGS.md`](FEATURE_FLAGS.md) owns the flag keys, the value shape, and how a model change is rolled out.

Standalone structured-output agents enter through `runStructuredInference`. The gateway resolves the role's flag, constructs the provider client, combines any caller cancellation with a two-minute ceiling, and emits redacted diagnostics for every request, repair, validation, fallback, and completion stage. ESLint prevents API feature modules from constructing `OpenRouterClient`, reading model-selection variables directly, or removing the gateway's signal and diagnostic hooks. The harness package has a separate portability boundary: production sources cannot import database, connector, API, or Node-only implementations and cannot read `process`; host capabilities arrive through explicit ports.

OpenRouter routing is deterministic and versioned. Empty completions and truncated tool calls receive a bounded same-endpoint defect retry. Other fallback-eligible failures traverse configured model stages under Bind's classified failure policy and a workspace-scoped circuit breaker; cancellation and host failures do not route onward. Because Avalon's stream is retractable, a later attempt explicitly resets partial text instead of concatenating two answers.

Every classified provider attempt appends an immutable inference-ledger row with its turn/route cursor, provider and model, routing decision, outcome, latency, available token/cache/cost counters, and hashed credential/workspace identities. Harness-run usage also stores turn/tool timings and counts. Provider error bodies and credentials are not retained in the ledger.

## Streaming stability

OpenRouter SSE comments are ignored and function-call fragments are combined by index. Each model turn has a stable `turnId`. A route restart increments `epoch`; `streamSeq` orders frames within the turn epoch; `reset: true` replaces text from the abandoned attempt. These fields are independent of the WorkstreamRoom event `sequence` used for socket replay.

Text deltas are buffered before broadcast, but a reset is sent alone and batches never cross turn or epoch boundaries. The desktop retains per-message stream cursors across reconnects, rejects duplicate or stale frames, and replaces only the active turn's abandoned partial text on reset while preserving completed text from earlier tool turns. D1 stores the complete final assistant message; REST resynchronization remains canonical.

## Transcript row attribution

Every chat surface renders one row component, so a tool row must mean the same
thing wherever it appears. Two rules keep the work stream and the automation
composer from wording or attributing the same call differently.

A row's icon is the plugin that **owns** the tool being called, and nothing
else. In the compiler, that owner comes from the `automation:` prefix on the
Bind plugin id; in a work stream, it is resolved from
`tool_invocations.connection_id`, which already records the connector that ran
the tool. Tools Avalon owns — web research, plugin discovery, memory, tables,
work-stream reads — have no connector behind them and carry no plugin icon.
Both the contract's `ToolInvocation.plugin` and the compiler's `tool` stream
event hold a single nullable plugin, so a row with several icons cannot be
represented. A discovery row may still *name* several plugins in its label
without claiming any of them ran the tool.

A row's label is prose from `toolActivityName` in
[`packages/agent-harness/src/tool-activity.ts`](../packages/agent-harness/src/tool-activity.ts),
never a raw wire name. Tools Avalon owns have their own phrasing per lifecycle
state; a connector tool is named after the connector that owns it, matching the
icon beside it; an unrecognized tool degrades to a humanized wire name rather
than a snake_case symbol. Adding an Avalon tool means adding its prose there.
`ToolInvocation.activityName` carries the result to the desktop, which falls
back to the raw tool name only for rows persisted before the field existed.

## Durable inline subagents

The root harness exposes `workstream_run_subagent` through the default-loaded `avalon:workstream` plugin for several independent, substantial read-only investigations. Avalon follows Monad's useful delegation shape while preserving Avalon-specific durable authority:

- A child is an inline Bind run, not an autonomous participant. It receives one self-contained objective and a narrowed subset of plugins already authorized and active in the parent run.
- Child admission is atomically keyed by the parent's stable tool-call receipt. Duplicate calls replay the same durable result, and a child can never widen the parent's frozen scope.
- The database records parent/chain lineage, depth, delegated-task and inherited-scope hashes, leases, activations, inference attempts, tool receipts, checkpoints, result hashes, and terminal state.
- Children are read-only. Connector writes, Firecrawl tools for inbound-email parents, elicitation, recursion, and human-facing progress are unavailable.
- Child and chain depth, concurrency, plugin surface, model iterations, tool calls, tokens, cost, and wall time are independently bounded. Capacity refusal is deterministic rather than an untracked background task.
- Parent and child ownership are revalidated during inference and around tool execution. A lost parent or child lease aborts the child, and a successful result becomes visible to Bind only after it is durable.

This deliberately adopts Monad's focused parallel-investigation strategy without copying in-memory interrupt queues, fire-and-forget persistence, autonomous agents, personas, or nested delegation. Inline children receive no direct memory access; their parent supplies any recalled context needed for the delegated objective.

## Scoped durable memory

Root work-stream runs receive the stable `avalon_memory` plugin. `memory_search` accepts only a query; the host searches every authorized scope and returns scope provenance without allowing the model to select scope IDs. Ad-hoc user runs search workspace, user, and work-stream memory. Personal automations search workspace, owner-user, and automation memory. Workspace automations search workspace and automation memory. All work streams created by one automation subscription therefore share one automation scope.

Memory items retain structured provenance, access metadata, expiry, revisions, and reversible invalidation, but no confidence field. Agents add by scope kind and update or invalidate by item ID plus expected revision. Workspace writes require a workspace principal or an owner/admin user. D1 FTS is synchronous; Workers AI embeddings and the regional Vectorize projection advance through a replayable D1 outbox. Hybrid hits are always reloaded from D1 before exposure, and each root run stores an immutable admission-recall snapshot and hash.

Root runs also receive the separate stable `avalon_tables` plugin for large structured collections that should not enter prompt context as prose memories. Tables inherit the same work-stream, automation, user, and workspace authorization union. Reads accept a reauthorized table ID plus typed filter/search/projection/order/cursor arguments; they never accept scope or owner selectors and expose no raw SQL. Rows use typed columns, a declared natural key, synchronous D1 FTS for searchable text, typed cell indexes, revision compare-and-swap, reversible invalidation, and receipt-backed append-only mutation records. Inline children receive no direct table access.

Automation drafts may declare automation-scoped tables. Acceptance materializes an independent table set under the new subscription, so every work stream from that subscription shares its rows while subscribers to a shared template do not share state. Every automation run receives the materialized table IDs, column IDs, natural keys, purpose, and usage/update instructions in its authorized task context. Table rows are never added to admission recall; the agent must query only the rows and columns needed for the current run.

## Scheduled wake-ups

`avalon:workstream` carries `schedule_wakeup`, `list_wakeups`, and `cancel_wakeup`, so a run can defer work to a stated instant instead of promising it in text. `schedule_wakeup` takes the prompt plus exactly one of `delay` — a duration in common units, `"5 minutes"`, `"90 sec"`, `"1h30m"`, or an ISO-8601 `"PT2H30M"` — or `at`, an exact ISO-8601 timestamp. An `at` without an offset is read in the run's local zone, or in an explicit `timezone`; an `at` that carries an offset is absolute and rejects `timezone` rather than silently choosing between the two. The resolved instant must be at least one minute and at most one year out, whichever form produced it. Pending wake-ups are capped per work stream, and every rejection returns a stable code with its remediation and the accepted vocabulary inside `output`.

The tool is `provider_key`-idempotent against `(workstream_id, idempotency_key)`, so a replayed receipt returns the persisted wake-up instead of scheduling a second. The workspace scheduler fires it: it claims the row before launching, so a lost claim means a missed wake-up rather than a duplicated run, and releases the claim when the harness cannot start so a later alarm retries. The principal that scheduled the wake-up is re-validated against current membership at fire time — a wake-up cannot outlive the authority that created it. The resulting run reads the prompt as an explicit trigger message labelled as coming from an earlier run of the same work stream; the transcript row is separate host-written system state. Sub-agents get none of these tools: they cannot schedule, and a parent's wake-ups are not theirs to act on.

That split — a labelled trigger message for the model, a system row for the person reading the transcript — is the contract for every scheduler-started run, not a wake-up detail. A scheduled digest carries its frozen window the same way ([`DIGESTS.md`](DIGESTS.md#the-run)). A run whose instructions exist only as a transcript `system` row reaches the model with nothing but its work stream's objective, because the protocol projector drops those rows as UI state; whatever starts a run has to hand the host something to render.

## Cancellation and deferred systems

Stopping a run persists `cancellation_requested_at`; it does not terminate the Workflow out of band. Admission observes pre-start cancellation, and a live owner observes it through heartbeats and event checks. The same leased Workflow then commits one fenced `stopped` lifecycle event and returns the work stream to `idle`, preventing a stop/complete race.

The work-stream transcript, attached resources, activation hints, run scope, inference ledger, tool receipts, inline child results, and scoped memory remain distinct durable records. Nested child delegation, personas, roles, autonomous heartbeats, and general child participants remain deferred product work.
