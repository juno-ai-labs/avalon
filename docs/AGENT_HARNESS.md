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

A launch is never split across the response that asked for it. The `harness_runs` row, the work stream's `running` status, and the Workflows start all complete before `launchWorkstreamHarness` returns, because `attempt_id` and `lease_expires_at` stay NULL until the Workflow admits the run and nothing reaps that shape — a row claiming `running` with no Workflow behind it is a work stream `stop` cannot terminalize and `retry` refuses. Deferring the start to `waitUntil` was tried and reverted for exactly that reason; see [`workstream-creation.md`](workstream-creation.md). A start that fails marks the run failed, publishes `harness_status_changed`, and answers `503`.

A run records the message it was triggered by in `harness_runs.trigger_message_id`, because that id is what fences the transcript the run may see — everything up to and including the trigger, nothing after. `retry` creates a new run for a failed one and inherits that stored id rather than reconstructing it: a run with no message behind it (a scheduled wakeup, an activity, an automation run with no opening message, a HyperSight block) stores NULL and replays the whole available transcript, and so does a row written before the column existed. A scheduled digest is not one of these — it appends its brief and launches against that message — and neither is an automation run that has one. Reconstructing the trigger as "the latest human message" — which is what `retry` did before the column existed — is right only while nothing has happened since, and fences finished work out of the replay whenever it has.

The trigger's two jobs come apart on a retry, and `transcriptFenceMessageId` is what separates them. As *identity* the trigger is what admits a suggested-work brief or an inbound email to the model at all; as *bound* it is the newest message the run may see. A retry has to keep the first and move the second, or replaying the failed run would hide anything said since it failed — including the correction a teammate posts *because* it failed, which starts no run of its own when the work stream has other participants and the message was not for the agent. The fence is resolved once at launch and travels in the durable workflow input, never re-read at projection time: an attempt that replays must read the same window it read the first time. Absent, the trigger is the bound, which is correct for every run a message started.

After admission Avalon validates the execution principal and persists an immutable, canonically hashed run scope: principal, eligible connection IDs and capabilities, trigger policy, routing and prompt versions, tool-surface hash, and limits. A replay must reproduce that scope. Connections installed or expanded later cannot enter it; subsequent membership, ownership, grant, disablement, and policy checks may only remove authority.

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

The compiler narrates while it researches, and the composer streams that narration. `compileAutomation` emits `started` once for the whole compile, a `thinking` frame per inference request, a `tool` row per discovery call, and `delta` frames carrying the architect's own text: the plan it states alongside its first tool calls, and a progress update every three or four calls after that. The `# Narration` section of the compiler policy owns what belongs in that text — settled sentences about the automation, never a question, never internal deliberation, never a tool or field name — and the submission turn is the one turn that carries none of it, because Avalon renders the settled result from the saved draft and the elicitation instead. Narration accumulates into one composer bubble across turns, so the compiler tracks what earlier turns settled: a route restart replays only its own turn, and the reset frame restores the earlier updates rather than clearing text the reader has already seen.

The compiler may retain an incomplete draft while asking one focused question. An omitted calendar timezone resolves from the personal user or workspace according to scope; an explicit trigger timezone wins. Missing resources, event sources, destinations, or unsupported schedules still require input. The compiler never invents credentials, access, resource IDs, event types, or filter fields; ready drafts must use an inspected connector's declared activity vocabulary. Invalid structured output gets one sanitized repair attempt, then `502 model_output_invalid` with a request ID.

## Connection plugins and authority narrowing

Every connector adapter supplies a static agent-plugin descriptor whose provider type and tool order must match its manifest. At run start Avalon creates one Bind plugin per eligible installed connection, identified as `connection:<uuid>` with a stable hashed wire prefix. Its tools are narrowed to the connection's frozen grants and run policy:

- Ad-hoc runs may include workspace connections and the initiating user's personal connections that a person has not disabled. A stored `needs_reconnect` no longer removes a connection from a run — see [Stored status is a belief, not a gate](CONNECTORS.md#stored-status-is-a-belief-not-a-gate).
- Automation runs include explicitly bound connection/capability pairs and eligible connections attached through work-stream resources. Attached connections remain limited to the immutable grants frozen for the run.
- Inbound-email runs remove external connector writes.

Bound connections, attached resources, and previously used plugins are activation hints, not extra authority. Hints are filtered through the frozen scope and reauthorized before restoration. Other eligible plugins appear only in a bounded catalog and are discovered and activated with the always-active `avalon_discovery` tools: `list_plugins`, `search_plugins`, and `load_plugin`. Activation is durably recorded before the plugin's tools or trusted guidance become visible.

Every run owns a fresh Bind registry. Canonical tool names are local to their owning plugin and contain no repeated plugin prefix; Bind adds the plugin's stable short name when it renders the model-facing wire name. `avalon_discovery` intentionally retains the global controls `list_plugins`, `search_plugins`, and `load_plugin`. The always-active `avalon_core` plugin owns exact time and structured elicitation, and `avalon_automation_architect` owns automation research and draft submission. Workstream agents load `avalon_workstream` by default for current-workstream context, resources, and delegation. Specialized memory and table capabilities retain their own stable plugin identities. The public-web tools live in the loadable `avalon_web` plugin. A runtime registers only the applicable bundles, so plugin instructions and durable receipt identities cannot advertise tools absent from that run.

Loading never widens the frozen scope. At run start, before credential decryption, before every tool call, and between model turns, Avalon revalidates the execution principal, work-stream state, automation subscription and pinned template version, trigger evidence and status, connection identity/scope/owner, current grants, capability, and whether a person has disabled it. Revocation drops a plugin. A stored `needs_reconnect` does not: it is a belief about a past moment, and a call it would have withheld now reaches the provider and fails on the provider's answer. Workspace calls use the workspace principal while preserving the initiating user in audit data; personal calls remain owner-only.

Revalidation also says why it is asking, because the two occasions need different work. An **activation** — a `load_plugin`, a restored hint, the initial preload — happens a handful of times per run and is checked all the way to the provider. A **continuation** runs before every inference, and is answered from Avalon's own records: the principal, the work stream, the automation authority, the connection's identity, scope, owner, grants, and disablement are what that check exists to catch, and all of them are already known here. Asking the provider instead would spend a round trip per active plugin per turn to rediscover them, and on a connector whose health check writes it would repeat that write. A credential the provider has since refused therefore surfaces on the next tool call rather than between turns — which is the right place, since that is where a provider call was going to happen anyway.

Revalidation answers with one of three verdicts, and the third one is the point of having them. `authorized` activates; `denied` is a decision about authority — a revoked credential, a withdrawn grant, an owner who no longer holds the connection — and reaches the model as `plugin_not_authorized`; `indeterminate` means the host could not reach a decision at all, because the provider timed out, the transport failed, or the health check answered something that says nothing about this run's authority. Both non-authorized verdicts leave the plugin inactive, so the distinction costs the run nothing, and it is what stops a provider hiccup from being reported as a permission problem: an `indeterminate` load returns `plugin_authorization_unavailable`, and the host logs `connector_plugin_reauthorization_failed` with the connection and the underlying cause rather than discarding it. An adapter distinguishes the two the same way, through `reconnectRequired` on its health result. A verdict must never be derived from a swallowed exception — a failure to verify is not a denial, and reporting it as one sends a run off to explain a permission problem that may not exist.

## Skills

A plugin gives the model a capability; a **skill** gives it a procedure. Skills are markdown instruction modules — how this workspace triages a queue, what a handover note must carry, the house voice — disclosed in the same three tiers the plugin catalog uses, because a workspace's accumulated know-how does not fit in a context window while a catalog line costs about fifty tokens.

A run's skills are **frozen with its scope**, exactly like its plugins. The host resolves them against the execution principal before admission and passes them on `RunHarnessInput.skills`; nothing in the loop reaches a store, so `load_skill` can only surface a body the run was already authorized to read. When a run has no skills, neither prompt section nor either tool appears.

The always-active `avalon_skills` plugin owns two globally named controls. `load_skill` takes an exact name from the `# Skills` catalog and adds the skill's body to `# Active Skill Instructions` for the rest of the run. `read_skill_resource` reads a bundled reference file, and refuses until its skill has been loaded — that gate is what stops a model pulling every catalog skill's references without taking on the instructions they belong to.

**Loading a skill grants no authority.** Where a skill declares an owner plugin it is offered only to a run whose scope already includes that plugin — the eligible plugin ids are handed to the skill registry, which drops the rest before the catalog is built — and loading it *names* the plugin for the model to load separately rather than activating it: an auto-activation would let a document issue a capability grant. Skill bodies are also not trusted prose about the world — they are workspace-authored instructions, and are wrapped in a `<skill_content name=…>` element so the model can tell them apart from platform policy and from one another.

Three bounds keep a looping model from loading its way into a context-limit error: a count cap, a budget over the total tokens of loaded bodies, and a byte cap on a single `read_skill_resource` response. Bind judges the first two (`admitSkillLoad`); Avalon measures the token half by resolving the bodies the load would actually inject, and applies the third itself — an unbounded Tier-3 read would otherwise route around the Tier-2 budget, since a skill whose body fits can bundle a reference that does not. All three are configurable, through `maxActiveSkills`, `maxActiveSkillBodyTokens`, and `maxSkillResourceBytes`.

The package ships three skills of its own (`BUILT_IN_SKILLS` in `@avalon/agent-harness`), for a host with no library yet: `deep-research`, `writing-an-email`, and `scheduling-a-calendar-event`. The latter two are deliberately provider-agnostic — they name no connector and no tool, because the failures they exist to prevent (an address composed from a name and a domain, a fact quoted from memory, a guest list replaced when one attendee was meant to be added, a write reported as done without a result confirming it) belong to the task rather than to any one provider, and the next mail or calendar connector will carry them too. Neither sets an `ownerPlugin`, so neither implies that loading it granted the connection it describes.

All three are offered to every run the API starts — ad-hoc, automation, HyperSight block, and inline child alike. Nothing is withheld by surface. A skill is advice, and what a surface may *do* is settled in the tool loop: HyperSight and inline children both compose `rejectToolModesBeforeCall(["write"], …)` into their `beforeToolCall`, so a write-mode tool is refused before it runs no matter what the model has read. Withholding a skill from those two would hide the advice without removing any authority, and would silently hide the next, more general skill along with the mail and calendar ones. Offering is not activation: a run sees only the catalog line until it loads one, and loading grants no authority. It is an ordinary `HarnessSkill` and not a second source: a host still chooses to put it in `skills`, and the frozen-scope rule is unchanged. It is authored in TypeScript rather than as a `SKILL.md` because the harness runs in `workerd`, where there is no filesystem to read one from at startup.

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

Environment configuration bounds model iterations, tool calls, wall-clock and per-tool time, cost, and plugin-catalog tokens. Request establishment, time to first token, and inter-chunk idle time have separate watchdogs. Active plugin count, active tool-schema bytes, model-visible tool-result bytes, replay payload bytes, and child-result bytes are not capped by the agent runtime. Web results, fetched bytes, and attachments remain independently bounded by their owning tools. Live context size comes only from OpenRouter's returned prompt and completion token counts; Avalon does not estimate it from serialized bytes. After a completed provider turn exceeds 80% of the selected model's OpenRouter `context_length` (with Monad's 200,000-token fallback when the catalog is unavailable), Bind replaces the whole live context beneath the system prompt with one synthetic user message carrying an LLM continuation summary; no earlier message survives verbatim. Work-stream checkpoints are stored regionally with the durable sequence boundary so later runs replay the compacted context plus newer messages. [`context-compaction.md`](context-compaction.md) owns that policy — the threshold, the summary prompt, the checkpoint shape, and the stored row — and is the document to read and update before changing any of them.

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

A connector row is named for the **action**, and the action's verb is found by
scanning the whole tool name for a known one rather than reading a fixed
position — connectors do not agree on word order, and one that says
`send_message` sits beside one that says `drive.search` and one that says
`calendar.create_event`, where the verb is neither first nor last. Reading only
the trailing segment left 63 of 75 connector tools rendering as "Reviewed
<connector>", `send_message` and `create_issue` and `calendar.create_event`
among them: a write to another person, shown to that person's colleague as
though the run had merely looked at something. `apps/api/test/connector-tool-prose.test.ts`
walks every tool in the connector registry and fails on any that reaches the
generic row or that describes a `write` in passive words, so a connector added
later either names its tools with a recognized verb or declares its own prose.

## HyperSight blocks

A HyperSight block run is the same harness with a different terminal product: it renders one block of shared Markdown for a work stream's dashboard, on a schedule, with no transcript of its own and nobody watching it. Three things follow.

It is read-only, by the same `rejectToolModesBeforeCall(["write"], …)` hook the inline children use, and it cannot pause — a run that reaches `needs_input` fails with `hypersight_input_unavailable`, because there is no one to answer.

Its output is a tool call. The block is exactly the `markdown` argument passed to the `avalon:hypersight` plugin's `submit_block`, and assistant text is discarded. Taking the block from the run's trailing text instead made every preamble, apology, and "here is the block:" part of the dashboard; an argument with a schema cannot drift that way. The tool is `mode: "read"` — it settles Avalon's own record and reaches no provider, the same reason the automation architect's draft submission is a read — so the write ban above does not lock the run out of its own output.

A turn that would end without that call gets one `onTurnWouldEnd` message asking for it, and only one: a block that will not submit twice running is a failed block, and nagging further only spends the run's ceilings. If it still never submits, the run is recorded `failed` with `hypersight_block_not_submitted` rather than completed-and-empty, so a block that renders nothing says why.

## Durable inline subagents

The root harness exposes `workstream_run_subagent` through the default-loaded `avalon:workstream` plugin for several independent, substantial read-only investigations. Avalon follows Monad's useful delegation shape while preserving Avalon-specific durable authority:

- A child is an inline Bind run, not an autonomous participant. It receives one self-contained objective and a narrowed subset of plugins already authorized and active in the parent run.
- Child admission is atomically keyed by the parent's stable tool-call receipt. Duplicate calls replay the same durable result, and a child can never widen the parent's frozen scope.
- The database records parent/chain lineage, depth, delegated-task and inherited-scope hashes, leases, activations, inference attempts, tool receipts, checkpoints, result hashes, and terminal state.
- Children are read-only, and that is enforced in the tool loop rather than by what the child was given: a `rejectToolModesBeforeCall(["write"], …)` hook refuses a write-mode tool before it runs, and returns a rejection the child can recover from rather than aborting it the way the scope check behind it does. Firecrawl tools for inbound-email parents, elicitation, recursion, and human-facing progress are unavailable.
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

## Changelog

This log starts here. The reasoning behind everything above it predates the log
and was not recorded; do not read the absence of an entry as an absence of a
reason for any of it.

### 2026-08-12 — Artifacts are gone; a run's output is its final message

**What changed:** `workstream_create_artifact` was removed from
`avalon_workstream`, along with the `artifact.write` capability prefix, the R2
write behind it, the download route, and the transcript block that rendered one.
The `artifacts` table itself is retained for one release and dropped in the
next — see **Consequences**. A run that is asked to produce something now produces it
as text, as a resource, or through a connector write. The workstream prompt's
"create the requested durable artifact" clause went with it.

**Why:** Nothing read artifacts back. The scheduled digest is the case that
proved it: `settleDigestRun` mails the run's *final message*, so a digest run
that wrote its summary into an artifact and closed with "Outcome: Digest artifact
created (id …)" mailed that sentence — and because the sentence is non-empty and
the run completed, the delivery settled as delivered and advanced the cursor, so
the window it covered could never be re-digested. The model was not
misbehaving: the workstream prompt told it to prefer a durable artifact, the tool
was preloaded on every workstream run, and the digest brief never said the final
message *is* the deliverable. A write destination that no consumer reads is a
trap for exactly this, and it had one consumer-shaped surface — the context panel
— that made it look otherwise.

**Considered and rejected:** Teaching the digest to fall back to the newest
artifact when the final message is short. That keeps two places where a digest's
text can live and makes "which one is the digest" a heuristic evaluated at send
time; every other delivery surface would need the same fallback, and each would
guess differently. Also rejected: keeping the tool but hiding it from digest
runs, which leaves ordinary work streams writing into a store nothing reads.

**Consequences:** A run cannot park a long output anywhere but its transcript,
which is the intended constraint — anything durable that a person should be able
to open belongs in `resources`. `message_type` no longer admits `'artifact'`;
the enum is enforced by trigger rather than by rebuilding `messages`, so a writer
that tries one aborts loudly.

**The retirement is unfinished on purpose, and owes two more steps.** The deploy
job migrates both regions before it deploys either Worker, so the Worker still
live during a migration is the *previous* one — and it calls `loadArtifacts` on
every `GET /workstreams/:id/context`. Dropping the table alongside this code
removal would fail every context request in both regions for the length of the
rollout, and indefinitely if the deploy failed after the migration step. So
`0068_retire_artifact_messages.sql` retires only the message type, a later
release owes the `DROP TABLE`, and the R2 objects under
`<region>/<workspace>/artifacts/` have to be swept before that drop takes their
only pointers with it. [The runbook](RUNBOOK.md#finishing-the-artifact-retirement)
carries the sequence.

### 2026-08-12 — Compaction moved to its own document

**What changed:** Compaction policy — the threshold, the summary prompt, the
shape of the compacted transcript, and the stored work-stream checkpoint — now
lives in [`context-compaction.md`](context-compaction.md), which carries its own
changelog. This document keeps a one-paragraph summary and a pointer.

**Why:** It had stopped being a paragraph about the loop. It has a persisted
table, a replay path through the API service, a prompt with its own design
constraints, and invariants an outside change can break silently; the entry that
prompted the split (a first-user-message pin that outlived the conversation it
came from) needed more explanation than a harness-wide log should carry. The
reasoning for that change is the first entry there, not here.

Two pieces of the feature deliberately outlive it, and neither is leftover.
`AVALON_TOOL_PROSE` keeps its `workstream_create_artifact` entry: a transcript
row is worded from its stored `tool_name` every time it is read, so deleting the
entry would re-word every row the tool ever wrote as "Workstream create
artifact" — the raw-name fallback that module exists to prevent. And
`WorkstreamContextSchema` still carries an always-empty `artifacts`, because a
released desktop build bundles the schema that *required* it and would fail the
whole context response without it. That one is temporary and dated in place;
the prose entry is removed only when the rows are.

### 2026-08-12 — A run records what triggered it, so a retry stops guessing

**What changed:** `harness_runs` gained `trigger_message_id`, written by
`launchWorkstreamHarness` and by the automation run insert that builds its row
by hand. `retry` reads it from the run it is retrying instead of resolving "the
latest human message in this work stream", and passes the newest message in the
work stream as `transcriptFenceMessageId` — a new optional field on
`WorkstreamWorkflowInput` that moves the transcript's upper bound without moving
the trigger's identity.

**Why:** The trigger fences the transcript — the projection loads up to and
including it and nothing after — so guessing it wrong does not merely mislabel a
run, it deletes context from the replay. The guess was right only when nothing
had happened since the trigger. Retrying a run that never had a message trigger
at all resolved to whatever human message happened to be closest, which for a
work stream started from suggested work is the opening brief at sequence 1: the
retry re-executed the original request with every subsequent turn fenced out,
and re-ran side-effecting tools against a transcript it could no longer see.
Making the suggested-work brief a human turn is what exposed this; the same
shape was already reachable for any work stream whose last human message was
older than the run being retried.

Storing the trigger alone then broke the same thing from the other side, and
review caught it before it landed. Because the trigger is *also* the bound, a
retry pinned to the failed run's trigger could no longer see anything posted
after that run started — and the message most likely to be sitting there is a
correction explaining why the run was wrong, which `sendMessage` stores without
launching a run whenever the work stream has other participants and the message
was not addressed to the agent. Retrying right after a teammate says "you used
the wrong account" would have re-issued the identical failing request. Splitting
identity from bound is what makes both cases right at once.

**Considered and rejected:** *Deriving the trigger from the failed run's
`origin`* — no migration, but `manual_retry` has no origin of its own to derive
from, so retrying a retry has to walk backwards through runs to find the last
one that meant something. *Leaving `retry` alone and special-casing
suggested-work work streams* — the wrong shape was reachable without them.
*Resolving the retry's trigger as `MAX(stored trigger, newest human message)`* —
one line, and it restores the correction case, but the brief is admitted to the
model only *as* the trigger, so moving the trigger forward silently drops it
from the run that most needs it. That trade is what the fence/identity split
exists to avoid. *Reading the newest message at projection time instead of
storing a fence* — an attempt that replays would read a different window than
the one it read first, which is the whole reason the transcript is fenced.

**Consequences:** NULL keeps its existing meaning, which is what makes the
absent backfill safe: a legacy row replays the whole transcript rather than
silently less of it. Any new path that inserts a `harness_runs` row directly
rather than through `launchWorkstreamHarness` has to write this column too, or
its runs become unretryable-in-place in the same quiet way — the sub-agent,
hypersight, activity, and scheduler inserts leave it NULL correctly, because
none of them has a trigger message. And anything else that ever wants to pin a
run to a trigger without narrowing what it can see now has the field to say so;
the fence is clamped to the trigger, so it can only ever widen the window.

### 2026-08-11 — The automation architect narrates its research

**What changed:** The compiler policy gained a `# Narration` section requiring
assistant text on research turns — a stated plan alongside the first tool calls,
then a progress update every three or four calls — and the ban on assistant text
narrowed from every tool-call turn to the submission turn alone.
`compileAutomation` now forwards Bind's `stream_delta` frames to its host as
coalesced `delta` events, and emits `started` once per compile rather than once
per model turn. The automation composer follows the transcript to the bottom
while a compile streams, and keeps the narration when a compile fails.

The compiler prompt's fixed-overhead bound went from 8 KB to 9 KB in the same
edit. The first attempt kept the old ceiling and paid for the new section by
cutting policy — a restatement of the save-partial-draft-then-elicit rule, and
the enumeration naming source and destination as details never to guess — which
review caught as a real loss of instruction rather than of redundancy. The bound
exists to catch prose creeping in unnoticed; `# Narration` is a deliberate,
permanent section, and deleting rules to fit a ceiling set before it existed is
the wrong trade. Raise it again, deliberately and with an entry here, rather
than compressing policy to fit.

Narration frames are coalesced before they leave the compiler, by the same
2 KB / 75 ms rule the work-stream socket path uses — `createTextDeltaBatcher`
now lives in the harness and both surfaces call it. Unbatched, a narrating
compile is on the order of a thousand frames, each one an SSE write, a schema
parse, a React state update, and a forced reflow from the composer's
follow-to-bottom. The retraction rule the sequenced batcher carries had to be
generalized rather than copied: that one *flushes* before a reset because its
reset clears only the active turn, while the compiler's reset frame carries the
whole replacement buffer, so pending text is *discarded*. Both callers state
which they need at the call site; the batcher itself knows nothing about
retraction.

**Why:** Creating an automation was silent. The architect researches for a
minute or more, and the only thing the transcript showed for all of it was a
column of near-identical tool rows — "Reviewed GitHub", "Reviewed GitHub" —
under a spinner counting seconds. Nothing said what Avalon had understood the
request to be, what it was looking for, or that it had changed course when a
connector turned out to be missing, so a compile that was working looked
indistinguishable from one that was stuck.

Two separate things produced that silence, and fixing either alone changes
nothing. The prompt said "Tool-call turns must contain no assistant text", which
suppressed narration at the source; and `compileAutomation` handled
`stream_started`, `tool_*`, and inference events but dropped `stream_delta`, so
any text the model did write was discarded before it reached the route. The rest
of the path was already built and unused: `AutomationDraftStreamEventSchema` has
carried a `delta` variant, the desktop client has parsed it, and the composer
has rendered a streaming bubble from it, all with tests. Nothing upstream was
muting the model — the provider payload sends `tool_choice: "auto"` with no
token cap, and the deployed `OPENROUTER_AUTOMATION_MODEL` in both regions is a
model that interleaves text with tool calls.

The original ban was not wrong about the case it was written for. Prose on the
submission turn either repeats or contradicts the draft summary the composer
renders from the saved draft, and a question asked in text instead of
`core_request_elicitation` produces no answerable block. That is why the rule was
narrowed to that turn rather than deleted.

**Considered and rejected:** Synthesizing progress lines host-side from tool
events, which needs no model text at all. The rows already say which tool ran;
what was missing is the reasoning between them — which provider is being ruled
out and why the plan changed — and only the model has that. A host template
would have restated the same rows in longer words.

**Consequences:** Narration is transient on the success path. It is not
persisted, and the composer replaces it with the settled assistant message when
the draft arrives, so it gives progress rather than a record — a future change
wanting a durable transcript here has to add one. On the failure path it is
kept: a compile that ends in an error settles its narration into the transcript
as an agent message, because that is the case where the explanation is worth the
most and clearing it would delete the only account of what went wrong. It is
kept head-first and capped, not whole. A compiler stuck repairing a rejected
submission was observed narrating the rejected JSON Schema itself, and the
opening plan is the part that explains a failure while a degenerating run
degenerates at the end — so the tail is what the cap drops.

Narration quality depends on the model honouring the policy, and honouring it is
not free. `x-ai/grok-4.5` at high reasoning effort still emits an occasional
deliberation line — a tool name, a "wait, let me check" — against explicit rules
forbidding both, most often while repairing a rejected submission. The rules are
stated with a discriminating example rather than enforced host-side: filtering
model text by pattern would censor the connector and event names that legitimate
narration is *supposed* to contain. A future model swap should look at this
again rather than assume it is settled.

Narration spends output tokens on every research turn, which lengthens a compile
against the harness's 180-second wall clock; a compile that already ran close to
that ceiling is likelier to reach it. `started` now means "this compile began
streaming", not "a turn began": any host using it to clear per-turn state will
hold text across turns instead.

One thing the single-bubble design accepts: because the bubble renders after the
tool rows, the plan stated at the top of a compile ends up below the calls that
followed it, and the reading order inverts as the run goes on. Per-turn bubbles
would fix the ordering and lose the continuous account, which is the thing worth
having; a future change that revisits this should know the ordering was seen and
traded away rather than missed.

### 2026-08-11 — A connector row finds its verb anywhere in the tool name

**What changed:** The prose for a connector transcript row picks its verb by
scanning every segment of the tool name and taking the last one that is a verb,
rather than reading the trailing segment. A test walks the connector registry and
fails on any tool that reaches the generic row, or that describes a `write` in
passive words.

**Why:** Reading one fixed position assumed every connector names a tool the same
way, and none of them agreed. Five put the verb first (`send_message`), two put
it last (`drive_search`), and those two push it into the middle wherever an area
prefix comes first (`calendar_create_event`). So 63 of 75 connector tools fell
through to "Reviewed <connector>" — including every Slack message sent, every
Linear issue created, and every calendar event written on someone's behalf. That
row is the only account a person gets of what a run did to their account, and it
was describing a write to another human as a glance at something. The Gmail case
was found in production, on a screenshot, and fixed for Gmail alone; the same
fallthrough stayed live on 63 other tools for as long as the lookup did.

**Considered and rejected:** An entry per tool in `CONNECTOR_TOOL_PROSE`. It
would have worked once and rotted immediately — the map is hand-maintained, it is
keyed on an action path that carries no connector namespace unless the tool name
happens to start with an area segment, and the disagreement about word order is
the actual defect. Four such entries were written during this change and then
removed for exactly that reason.

**Consequences:** A connector added later either names its tools with a
recognized verb or declares its own prose; it cannot quietly land in the generic
row, because `apps/api/test/connector-tool-prose.test.ts` walks the registry
rather than a list. Keep it walking the registry — a rewrite that enumerates
tools by hand stops testing the thing it exists to test. Adding a verb to
`CONNECTOR_ACTION_PROSE` is the cheap fix and should stay the first one reached
for; adding an object-keyed entry claims that path for every connector at once
and is only correct when the verb reading is actually wrong rather than vague.

Shipped in #100.
