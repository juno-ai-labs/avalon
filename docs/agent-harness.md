# Agent harness

Rally's production loop is an adapter over `@juno-ai/bind` 13.0.0. Bind owns turn/tool iteration, plugin activation, skill registration and activation, transcript healing, completion-defect detection, streaming resets, and route execution. The owning `SubstreamAgent` Durable Object hosts every work-stream loop and stores admission, leases, transcript, receipts, streaming checkpoints, and terminal state in explicit SQLite; there is no pre-cutover drain or Workflow fallback for this surface. WorkspaceDO is authoritative for workspace connector/resource/memory/policy state and cross-work-stream products; regional D1 retains identity, membership, routing, migration and operational records, while R2 stores large outputs. Separate non-workstream loops may still use Cloudflare Workflows.

Each substream owns one persistent server-side, tool-using loop. A run is a
subordinate execution receipt for one activation of that loop; it never creates
or identifies the loop. The loop is not a participant, separate persona,
terminal, or general code-execution environment.

Automation authoring runs the compiler through this harness from a second host,
`AutomationAgent`, rather than from a SubstreamAgent. That host owns compiler
admission, the ordered draft turns, the durable stream events a reconnecting
client replays, tool receipts, elicitation, stop and retry, and the draft-only
architect tools; accepted generated runs continue to execute in private
SubstreamAgents through the ordinary persistent loop. What the two hosts share is
the ordered transcript schema and the harness itself — **not** the persistent
loop: an automation's compiler run keeps no Bind projection, and a run picked
back up after an eviction re-enters the model from the stored conversation. See
[`automation-lifecycle.md`](automation-lifecycle.md).

The user-facing dashboard is **HyperSight**. Its harness role, plugin wire
prefix, durable owner, persistence rows, and terminal error codes use the
internal `block_dashboard` / `BlockDashboardAgent` name.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/agent-harness/src/bind-runtime.ts` | The Bind adapter itself — registry construction, the tool loop's hooks, streaming. |
| `packages/agent-harness/src/tool-arguments.ts` | Schema-guided numeric-string normalization and bounded model-visible argument errors. |
| `scripts/eslint-rules/tool-input-boundaries.mjs` | Prevents individual tools from replacing the exact shared numeric-string policy with permissive coercion or compatibility unions. |
| `packages/agent-harness/src/prompts/` | Every stable prompt. Byte-stable and golden-hashed; read [`writing-prompts.md`](writing-prompts.md) first. |
| `packages/agent-harness/src/skills.ts`, `built-in-skills.ts` | The skill registry, its three bounds, and the three skills the package ships. |
| `packages/agent-harness/src/tool-activity.ts` | `toolActivityName` — the prose every transcript row is labelled with. |
| `packages/agent-harness/src/tool-schema-safety.ts` | The measured rule for what xAI reads as an object, two build-time checks over what Bind's sanitizer *emits*, and the run-time repair gated on one of them — that repair is the piece with the blast radius, since it rewrites third-party schemas. |
| `apps/api/src/runtime/harness-run-runtime.ts` | The host side: admission, the lease, run scope, receipts, terminal state. |
| `apps/api/src/durable-objects/substream-agent.ts` | The post-cutover full-loop host, durable dispatcher, keep-alive, stream feed, steering, and child-local timers. |
| `apps/api/src/services/integrations.ts` | Context assembly and `loadRunPromptContext`. |
| `packages/contracts` — `readStructuredFailure` | The shape a tool's machine-readable failure half is read through. |

## How it works

### Exact Bind-loop durability

The host mirrors Bind's accepted message state as an append/replacement ledger,
not as an aggregate participant transcript. Initialization stores the healed
system plus non-system messages. Assistant acceptance, each exact tool-result
message, protocol-only user messages, provider-validation reconciliation, and
compaction replacement advance a monotonic state revision. Compaction also
advances a generation; a stale revision or generation is refused.

Immediately before every provider request, Rally reconstructs the ledger's
message array and compares its canonical SHA-256 with the validated array Bind
will send. The equality includes the newly rendered system projection and its
renderer/input revision. A mismatch or failed persistence port stops the run
before the model-facing state can advance. `input.messages` is therefore only
the never-started loop's canonical bootstrap; after initialization the durable
Bind projection is the exact provider-boundary value. Bind's internal
`state.messages` remains private and may be replaced by compaction.

Host context messages carry non-provider `provenance` metadata until Bind heals
the initial array. The initialization transition records an origin beside each
surviving exact message: participant and trigger wrappers point to their durable
turn/event, tool wrappers point to receipts, memory wrappers point to the frozen
memory hash, and compaction continuations point to their checkpoint. The adapter
strips that metadata while constructing OpenAI-compatible messages, so it never
changes provider bytes. Runtime-created continuation nudges are protocol-only;
accepted assistant messages are canonical, and a host policy transformation is
applied before either Bind or the participant transcript can accept one;
accepted tool results retain their receipt identity. The work-stream host uses
that boundary to replace output after an unresolved attachment access with a
content-free provenance notice. Because the replacement is the accepted turn,
run settlement and realtime completion cannot disagree with canonical text.

On the first activation, only canonical transcript history bootstraps the
persistent Bind projection. Model-only activation inputs — connector activity,
scheduled wake-ups, digest briefs, Slack origin wrappers, and frozen recalled
memory — cross a separate host boundary on every activation. Each carries full
derived provenance plus a stable logical `activationInputId` that is independent
of the execution attempt. The host atomically deduplicates and appends the
missing inputs under the exact active-execution and Bind-head fence, then returns
the committed transitions for Bind to apply plus the stable IDs durably
acknowledged without another append. Every requested ID must be
acknowledged exactly once by one of those two paths; an empty or partial host
answer fails closed instead of silently dropping activation context. The
boundary runs even when the activation has no model-only input, and it resolves before assistant reservation
or provider I/O; persistence or fence failure therefore stops inference. A
resumed loop never replaces its durable history from a freshly assembled
`input.messages` array, and a takeover never repeats an already delivered
pending participant input merely because the executor changed.
The projection is one current metadata head plus one ordered current message
set, rather than one full snapshot per transition. In memory, its non-system
messages form an immutable suffix chain: an append allocates one node and
reservation or system-only transitions share the existing tail. Storage checks
the small head before reusing that projection, writes only the changed message,
and rehydrates the full chain only after eviction or an observed head change.
The chain crosses only the same-isolate storage-to-harness call; it is excluded
from the transcript object RPC and is never JSON serialized. The harness shares
the immutable tail on resume instead of recursively cloning it.
Compaction is the one operation that replaces the complete set. Each stable
activation ID has one immutable fact-backed receipt, and replay lookup reads
only IDs presented at the current boundary.

Assistant streaming remains independent: token deltas continue over the room
while durable lifecycle edges are recorded at accepted turn/tool boundaries.
Each Bind model turn has its own stable participant turn ID, so text before a
tool batch, parallel tool blocks in declared call order, and narration after the
batch cannot be collapsed back into one aggregate row.

Before provider I/O, the work-stream host reserves the next global model-turn
index, stable turn ID, and exact participant transcript sequence, then Bind
commits `assistant_reserved` to its durable projection. Provider I/O may begin
only after both commits. The host repairs an unresolved reservation before
calling the harness again; Bind refuses to infer from a projection that still
contains one. A failed or stopped harness outcome settles that reservation
before execution terminalization and replaces ephemeral partial output with a
canonical status pill. If the host reservation survived but `assistant_reserved`
did not, recovery commits that missing edge first and then settles it; neither
step invokes the provider, and either may be safely resumed after a crash.
Stream and checkpoint events for participant loops carry that
same sequence. A generic host such as HyperSight has no participant sequence
but still keeps one stable loop identity.

### Addressing

Before starting a loop, a lightweight classifier returns `agent_action`, `human_only`, `both`, or `uncertain` with confidence and a terse rationale code. Explicit Rally/connector mentions and clear work requests invoke the harness. Social acknowledgement and human-only coordination can remain unanswered — including a message aimed at a teammate: the caller passes the display names of the people the message mentions (`humanMentions`, resolved from validated mention rows), and the prompt rules that a message telling or asking a mentioned person something is that person's to act on, even mid-task, unless it also asks Rally for work. The same signal gates the deterministic fast paths: an opening imperative short-circuits to `agent_action` only while the message mentions nobody, since "Please review the deck @Alex" hands the work to Alex, not to Rally. Uncertain messages invoke only when an active task or explicit tool context exists. The label is not exposed in the UI.

### Naming

A work stream is created under a provisional title — the first non-empty line of its objective — and named by a separate one-shot structured call a moment afterwards. The naming agent gets the objective and the opening message as bounded user-role data: the request is what is being named, never an instruction it follows, and a request asking for a particular name has no more authority than any other outside content. Reasoning is switched off rather than left to the model's default, because the model is relabelling text it has already been handed in full — asking for the lowest *effort* would switch thinking on for a model that does none.

Naming sits outside the creation path deliberately. The person who typed the request is waiting on that response, the run starts against the unchanged objective, and the name arrives over the socket as `workstream_renamed`; a person renaming from the header publishes the same event. Until it arrives the title is a placeholder, so `workstreams.title_status` says so and the sidebar row and header render a skeleton rather than showing the request as though it were a name.

The transcript is what a name is usually missing. A work stream is looked at once more after it reaches five messages — on a new message and at the end of a run, both of which stop on a count for a work stream that is not due one — and named again from the conversation so far, which is where the identifier, the person, or the actual problem tends to arrive. That second pass settles the title for good.

Every write is conditional on the status the pass started from, which is what keeps a person's title safe: renaming a work stream settles it, so a generated name that arrives afterwards is dropped rather than applied, and a title supplied by the caller is settled from the start and never generated over. Every failure — an unreachable model, an unusable answer, an absent `OPENROUTER_API_KEY` — leaves the title standing and still advances the status, because a skeleton that never resolves is worse than a title taken from the request.

### Activation, admission, and immutable run scope

Every producer derives the same `loopId` from stable product identity. A human
pending-input activation promotes that input, creates and links its subordinate
execution receipt, and acquires the loop lease in one object transaction. An
external or manual-retry producer commits its receipt first, and activation
atomically links that same receipt to the idle loop. In both cases a lost
response replays one stable activation rather than minting another loop. Each
execution attempt claims a time-bounded object-local lease and heartbeats while
waiting on model output and tools; after each committed attempt heartbeat it also extends the singleton
loop lease. Scope, receipt-plan/completion, checkpoint, and terminal commits
require the same attempt ID, lease owner, and expiry. An obsolete executor
cannot publish a terminal result, and `completed` cannot commit until its final
agent message is durable. Expired attempts are compare-and-swap reaped as
failed.

Terminalization releases the persistent loop as soon as its canonical
transcript, Bind state, and run status are durable. External result delivery,
automation finalization, and work-stream name/description maintenance use the
same run receipt's `external_settled_at` marker in a separate object-local
drain. Before awaiting external work, the drain moves the receipt's existing
execution deadline to the maintenance-recovery horizon. The host starts the
drain eagerly with `waitUntil`; the derived alarm candidate abandons a stale
in-memory continuation and reclaims the receipt after that durable claim
expires. It processes terminal receipts in run order, but its deadline never
reserves the loop or delays the next queued inference.

Activation has one durable signal: the subordinate run receipt. There is no
second dispatch table whose row can disagree with it. An external automation,
wake-up, email, or activity may arrive with that receipt already created; it
still targets the same stable loop. A failure after receipt commit is replayable
against the same receipt and loop, while a failure before it commits may be
prepared again.

### Execution primitive and expected duration

One `SubstreamAgent` owns one **persistent Bind loop**, not one loop per message
or execution receipt. One model/tool step plus settlement is its safe boundary:
steering input becomes visible after the active step settles, queued input waits
until the active activation becomes idle, and neither interrupts in-flight
provider or tool I/O. Most active cycles are expected to last 2–30 minutes. Time to first token is
normally 1–5 seconds, ordinary tools take seconds, and a Terminal call usually
finishes within a minute at p95 but can take 3–5 minutes. Rare coding sessions
may continue for more than two hours.

The child wraps active work in a custom `keepAliveWhile()`, scheduling a
30-second alarm heartbeat while the in-memory computation exists. Correctness
does not depend on remaining resident: the persistent-loop projection and
lease, subordinate execution receipt and attempt lease, immutable scope, tool receipts, streaming checkpoint, and final-turn
fence resume or reconcile the run after eviction. Hibernating feed sockets wake
only for batched frames or product events; user message commands arrive through
the admitted SubstreamAgent socket. Terminal remains a plugin in the same loop and executes its
actual coding commands in Daytona.

An invoked participant message is admitted first as a pending loop input. It
does not create an execution receipt or a second loop. At its eligible boundary,
one object-local transaction promotes that input to its immutable canonical
turn and advances the persistent Bind projection. If the loop was idle, that
same transaction creates the subordinate receipt for the activation that will
execute it; a steer promoted at a safe step continues the receipt already
executing. The receipt keeps `triggerMessageId` as immutable execution
provenance; the persistent loop keeps the conversation itself and is resumed
rather than reconstructed from that trigger on every activation.

System producers that already own a canonical trigger—such as a digest brief,
automation opening input, activity, or inbound email—may prepare an unlinked
execution receipt and wake the same loop. `transcriptFenceMessageId` separates
the trigger's identity from the newest canonical turn that activation may see.
A retry can therefore preserve what caused the failed activation while moving
its upper input fence to an explicitly admitted correction. Both values are
frozen in the receipt's execution context before it is linked to the singleton;
neither value creates or identifies a loop.

After admission Rally validates the execution principal and persists an immutable, canonically hashed run scope: principal, eligible connection IDs and capabilities, trigger policy, routing and prompt versions, tool-surface hash, and limits. A replay must reproduce that scope. Connections installed or expanded later cannot enter it; subsequent membership, ownership, grant, disablement, and policy checks may only remove authority.

### Context and stable prompts

Context is assembled for the execution principal from the work-stream title and objective, recent persisted messages, current and planned execution times, the run reason, and the selected trigger. Automation runs also receive the pinned template name/version, instructions, expected outputs, default behavior, subscription overrides, and the active destinations Rally will deliver the result to. A triggering activity or inbound email is added as explicitly untrusted user-role evidence, never promoted into the system prompt.

Attached resources are exposed as an authorized index and hydrated lazily through tools. Their manifests and contents remain untrusted evidence. A partial read is not represented as the whole resource: the prompt requires exact cursor continuation when more coverage is needed and requires the answer to disclose any remaining `charactersBefore` or `charactersAfter` boundary. Full workspace history, unrelated resources, and another participant's private connector data are excluded.

All base prompts are rendered by typed, dependency-free functions in `@rally/agent-harness`, and the prompt version is frozen with the run. Per-run time, reason, IDs, and trigger evidence are user-role messages rather than mutations of the system prefix, so retries and route fallbacks see stable policy. Bind validates the transcript before inference and heals dangling or orphaned tool-protocol rows; Rally records diagnostics without adding provider-controlled text to the system prompt.

Prompt authority is layered as platform policy, authorized work-stream and automation configuration, current human instructions, then explicitly untrusted provider/resource/tool data. Both the work-stream agent and automation architect receive a compact, stable-ID-sorted catalog derived only from their already-authorized plugin registry and partitioned into `Currently active` and `Available to load`. Loading a plugin adds its static code-authored guidance under `Active Plugin Instructions` and exposes its exact typed tools on the next model turn. The catalog is stated as capability rather than as a suggestion, because the tools visible on any given turn are only the ones already loaded: an available plugin can answer a question, so consulting the catalog is part of searching, and asking a person for something a listed plugin could look up is a claim that it is unavailable rather than a request for missing input. The automation architect may use those real connector tools to inspect live provider context while drafting; it prefers reads and never performs a provider write merely to test a proposed automation. Remote account labels, resources, and provider content never become trusted plugin prose. User-authored automation draft state remains user-role context.

### Behavior policy

The agent acts on clear scoped requests, infers safe defaults, batches independent reads, prefers authorized connectors over public substitutes, and verifies material writes when a read-back path exists. It requests structured input only when a required identifier, permission, connection, timezone, or irreversible choice has no safe default. It never treats a proposed, failed, or ambiguous call as success and never retries an ambiguous write.

Every address, identifier, URL, name, date, and quoted fact in an outward-facing write must be sourced from a tool result in the run, the authorized task context, or a person in the work stream. Inferring a default settles a choice among safe options and never supplies an unheld fact, so an unsourceable value is a missing identifier that routes to a lookup or a question rather than a plausible placeholder. Identifiers are threaded through unchanged from the result that produced them and from the same connection, and a result carrying only identifiers is a step rather than an answer. These are platform policy and belong here rather than in any one connector's plugin message, because the same failure is available through every connector that writes.

Interactive multi-round work starts with a short plan and reports meaningful phase changes. Headless runs skip progress narration. Completions lead with the outcome, evidence, and blockers; private reasoning is never emitted.

An automation run's final message is what Rally delivers, so the run is told which destinations Rally will send it to and told to drop every recipient matching one before it sends anything of its own. Without that, an automation asked to email its owner does the sending as well as Rally and the owner receives it twice. The destinations travel in the automation context as `resultDelivery`, filtered by the predicate each channel's own sender uses, and the rule is a `# Result delivery` section rendered only when that list is non-empty — as a standing bullet it was charged to every interactive run, where the list is absent and a rule about it can only be resolved and then ignored. [`workstream-email-addresses.md`](workstream-email-addresses.md#outbound-automation-results) owns the delivery itself.

A document-shaped request is written as a Markdown file in the work stream's terminal workspace and published as a generated resource, rather than streamed into the transcript (`DOCUMENT_GENERATION_POLICY`, `prompts/document-generation.ts`). The section carries the document-type trigger, the narration discipline, the same-path revision rule with its import recovery, the participant override in both directions, and the inline fallback when the workspace cannot be reached. It names no tool: the Terminal plugin's activated system message already carries the write-beneath-the-resource-directory-then-publish mechanics, and this section renders before that plugin loads. It is standing platform policy on every work-stream run, with an explicit output-surface tie-breaker: an externally delivered run includes the complete usable result in its final message because recipients cannot open Rally resource embeds, while a HyperSight block run skips publication and submits finished Markdown through its required block tool. [`terminal-workspaces.md`](terminal-workspaces.md) owns the publish path the normal work-stream rule steers into.

The same module's **Sites** section is the site-shaped equivalent: a request whose natural output is a page or a small app becomes a *directory* of files, published as a live artifact people open. It carries only the trigger and the two rules a model gets wrong without it — publish the directory rather than a file inside it, and a request for a new thing is a new site at a new path — plus the pointer to the skill. The build craft is hundreds of lines and would be charged to every request, so it ships as the loadable `building-live-sites` skill and is read at the moment it matters. Like the document half it is standing rather than gated, and falls back the same way when the sandbox cannot be reached. [`live-web-artifacts.md`](live-web-artifacts.md) owns what a published directory becomes and how it is served.

An answer says what it rests on, inline (`CITATION_POLICY`, `prompts/citations.ts`). The section teaches the link form for referring to a resource in a sentence, GFM footnotes for a source that backs a specific claim, and the definition grammar the renderer actually lifts — exactly one link, targeting a `resource://` identifier or an `https://` URL, with optional words around it. It says once what to do when no identifier is in context (name the thing in plain words) rather than repeating a prohibition the working-style rule and the attachment policy already carry twice; those two answer "ask a person", which a headless automation run cannot. The *announcement* rule — the embed form for a document the run just published — lives in `DOCUMENT_GENERATION_POLICY` so there is one rule for that act. Rendered for every work-stream run — interactive, automation and scheduled digest alike, since they share one system prompt; the meeting prompts compose `RESPONSE_FORMATTING_POLICY` separately and correctly do not get it. [`markdown-rendering.md`](markdown-rendering.md) owns the renderer half, and [`digests.md`](digests.md) and [`slack-integration.md`](slack-integration.md) own the reductions the two non-renderer delivery surfaces apply.

Written answers are GitHub-flavoured Markdown, and TeX or math delimiters are never written — Unicode or plain words are used instead (`RESPONSE_FORMATTING_POLICY`, composed into the work-stream system prompt and both meeting prompts). Elicitation questions and option labels are plain text because their surface does not render Markdown. The TeX rule exists because no Rally surface renders TeX and several routed models emit it for symbols; [`model-text-normalization.md`](model-text-normalization.md) owns the display-side repair this pairs with, and `prompts.test.ts` pins the rule's exact wording because that document depends on it.

### Automation compilation

Natural-language automation creation compiles to the validated draft schema. The compiler preserves established choices, defaults to personal scope and manual execution when omitted, and writes three to eight self-contained outcome-focused steps. A calendar recurrence carries the IANA timezone a person named for it and null otherwise, and the account zones it would otherwise have to guess at — the requester's and the workspace's — are rendered into a user-role message the policy defers to by name; exact provider events use deterministic triggers and meaning-based conditions use semantic triggers. Connector manifests expose trusted activity descriptors with exact event names and typed deterministic filters through plugin search, inspection, and loading. Each connector-activity or semantic-activity trigger names a reusable source binding key and suggests one inspected plugin; acceptance binds that slot to one authorized connection without requiring the source plugin to be preloaded at runtime. Required capabilities are the minimum external grants. A destination Avalon delivers to is described rather than instructed: the compiler never writes a provider send for one, because Avalon sends the result there itself. Which destinations the owner asked for is a required field of the submit-draft schema, `requestedDelivery`, closed to the two Avalon offers — the create screen selects from it rather than re-reading the draft's prose. It records what was asked and never what was inferred: a briefing *about* somebody's inbox is not a request to be emailed, a send aimed at a third party is not a request for the owner, and a request to be "sent the result" that names no channel resolves to nothing rather than to a guess.

Request-scoped attachment tools may be added directly to the preloaded automation architect. They inherit its `automation_*` wire prefix and are not catalog-loaded connector capabilities. The API host freezes their admitted resource IDs and owns every authorization recheck; the harness only exposes the supplied strict tools for that compiler run.

The compiler narrates while it researches, and the composer streams that narration. `compileAutomation` emits `started` once for the whole compile, a `thinking` frame per inference request, a `tool` row per discovery call, and `delta` frames carrying the architect's own text: the plan it states alongside its first tool calls, and a progress update every three or four calls after that. The `# Narration` section of the compiler policy owns what belongs in that text — settled sentences about the automation, never a question, never internal deliberation, never a tool or field name — and the submission turn is the one turn that carries none of it, because Rally renders the settled result from the saved draft and the elicitation instead. Narration accumulates into one composer bubble across turns, so the compiler tracks what earlier turns settled: a route restart replays only its own turn, and the reset frame restores the earlier updates rather than clearing text the reader has already seen.

The compiler may retain an incomplete draft while asking one focused question. An omitted calendar timezone stays null through the draft and into storage, and is resolved at acceptance, inside the automation's own object, against the scope it is being accepted with and the account it will run for; an explicit trigger timezone wins there, and a zone the runtime cannot format refuses acceptance rather than being replaced. Null is the distinction that makes the resolution possible at all — a default filled in at compile time is indistinguishable from a zone the person named, and answers for the scope the compiler guessed rather than the one the automation was created with. Missing resources, event sources, destinations, or unsupported schedules still require input. The compiler never invents credentials, access, resource IDs, event types, or filter fields; ready drafts must use an inspected connector's declared activity vocabulary. Because most of what makes a submission *ready* is a cross-field refinement no JSON Schema can state — a binding key, an inspected plugin, one declared prefilter event type — `automation_submit_draft` supplies `normalizeAutomationDraft` and `AutomationDraftSchema` — one shared parse, used by both its executor and its `validateInput` — so a rejected submission comes back to the model as the named field rather than as an external fault. The normalize step is half of that: it is what decodes the JSON-string fields at all. Structured output the compiler cannot parse becomes `502 model_output_invalid` with a request ID; the repair pass belongs to `client.structured`, which this path does not use.

### Connection plugins and authority narrowing

Every connector adapter supplies a static agent-plugin descriptor whose provider type and code-authored tool order must match its manifest. At run start Rally creates one Bind plugin per eligible installed connection, identified as `connection:<uuid>` with a stable hashed wire prefix. Its tools are narrowed to the connection's frozen grants and run policy:

- Ad-hoc runs may include workspace connections and the initiating user's personal connections that a person has not disabled. A stored `needs_reconnect` no longer removes a connection from a run — see [Stored status is a belief, not a gate](connectors.md#stored-status-is-a-belief-not-a-gate).
- Automation runs include explicitly bound connection/capability pairs and eligible connections attached through work-stream resources. Attached connections remain limited to the immutable grants frozen for the run.
- Inbound-email runs remove external connector writes.

Bound connections, attached resources, and previously used plugins are activation hints, not extra authority. Hints are filtered through the frozen scope and reauthorized before restoration. Other eligible plugins appear only in a bounded catalog and are discovered and activated with the always-active `rally_discovery` tools: `list_plugins`, `search_plugins`, and `load_plugin`. Search normalizes case and punctuation, ranks exact field matches ahead of distinct keyword overlap across ids, names, aliases, and descriptions, and returns at most twenty matches plus `totalMatches` so a truncated result can be narrowed. It uses OR discovery rather than requiring the entire query to occur in one catalog field. An explicit load may run a convergent host-owned `onActivate` preparation hook after reauthorization and dynamic tool loading. Successful preparation is single-flighted for the run, then activation is durably recorded before the plugin's tools or trusted guidance become visible. Failed preparation remains retryable only when the host returns model-safe retry guidance; provider details are not exposed.

A hosted-MCP connection may supply `HarnessPlugin.loadTools` instead of a
code-authored tool array. It still appears through the same static trusted
catalog entry. After `load_plugin` reauthorizes the connection, the harness
single-flights that callback, replaces the empty deferred Bind plugin with the
returned live surface, and only then persists and exposes the activation. The
result is cached for that run in both Bind's registry and the host plugin object
used to narrow inline-child authority; a later run discovers again. Restored or
preloaded dynamic hints materialize and hash this surface before their initial
activation receipt is written. A discovery failure
returns `plugin_tools_unavailable` and leaves the plugin inactive. The protocol,
validation, and provider declaration are owned by
[`hosted-mcp-connectors.md`](hosted-mcp-connectors.md).

Every run owns a fresh Bind registry. Canonical tool names are local to their owning plugin and contain no repeated plugin prefix; Bind adds the plugin's stable short name when it renders the model-facing wire name. `rally_discovery` intentionally retains the global controls `list_plugins`, `search_plugins`, and `load_plugin`. The always-active `rally_core` plugin owns exact time and structured elicitation, and `rally_automation_architect` owns automation research and draft submission. Workstream agents load `rally_workstream` by default for current-workstream context, resources, and delegation. Specialized memory and table capabilities retain their own stable plugin identities. The public-web tools live in the loadable `rally_web` plugin. A runtime registers only the applicable bundles, so plugin instructions and durable receipt identities cannot advertise tools absent from that run.

In a provider-verified region, ordinary work-stream runs also register the
deferred built-in `rally:terminal` plugin. It has no connection row. An explicit
`load_plugin` acquires and initializes its Daytona sandbox and prepares the
selected repository before the complete nine-tool family becomes visible.
Repository failures that the nine-tool surface itself can repair are deferred,
so `checkout_repository` remains available. A restored durable activation skips
this hook: it does not eagerly allocate on every later run, and its first tool
retains the ordinary acquisition path. Terminal is absent when the region is
unsupported; the emergency breaker keeps it discoverable but makes explicit
activation and every provider operation fail with host-authored guidance. Current
principal/resource and repository/publication checks remain executor
preconditions rather than scopes. The sandbox lifecycle and authority fence are owned by
[`terminal-workspaces.md`](terminal-workspaces.md), not by Bind.

Ordinary work-stream runs with the main Azure inference credentials also
register the deferred built-in `rally:multimodal-generation` plugin. It has no
connection row and exposes three record-before-execute writes: create one image
from a prompt, edit one currently visible image with an optional PNG mask, or
turn bounded text into one AI-generated MP3 recording.
Each tool has a five-minute ceiling and fixes the provider request to
`gpt-image-2` for images or `gpt-4o-mini-tts` for speech. Image moderation,
quality, background and count are fixed to low, medium, automatic and one;
speech output is fixed to MP3 and defaults to the `marin` voice.
The executor publishes the verified bytes to the workspace resource authority.
Generation attaches a new resource; editing compare-and-swaps a new version onto
the selected resource, preserving its ID and version history. A durable
effect-intent-derived identity makes a settled replay converge on that resource;
no raw media bytes enter a receipt or transcript. Audio remains a playable
human-facing resource and is not projected back to the model. The shared
OpenRouter-average pricing record is advisory on this surface: unavailable
pricing or usage is logged and produces no image charge rather than hiding the
plugin or refusing the call. [`agent-tools.md`](agent-tools.md#multimodal-generation-tool-contract-registry)
owns the exact schemas and resource result.

Loading never widens the frozen scope. At run start, before credential decryption, before every tool call, and between model turns, Rally revalidates the execution principal, work-stream state, automation subscription and pinned template version, trigger evidence and status, connection identity/scope/owner, current grants, capability, and whether a person has disabled it. Revocation drops a plugin. A stored `needs_reconnect` does not: it is a belief about a past moment, and a call it would have withheld now reaches the provider and fails on the provider's answer. Workspace calls use the workspace principal while preserving the initiating user in audit data; personal calls remain owner-only.

Revalidation also says why it is asking, because the two occasions need different work. An **activation** — a `load_plugin`, a restored hint, the initial preload — happens a handful of times per run and is checked all the way to the provider. A **continuation** runs before every inference, and is answered from Rally's own records: the principal, the work stream, the automation authority, the connection's identity, scope, owner, grants, and disablement are what that check exists to catch, and all of them are already known here. Asking the provider instead would spend a round trip per active plugin per turn to rediscover them, and on a connector whose health check writes it would repeat that write. A credential the provider has since refused therefore surfaces on the next tool call rather than between turns — which is the right place, since that is where a provider call was going to happen anyway.

A built-in plugin carries no credential, so its authorization is settled by the run scope alone and can never be indeterminate. The set of built-ins that hold that authority is derived from the plugins the run registered — registration is already the conditional decision, since Terminal is absent without its provider configuration, `rally:web` without `FIRECRAWL_API_KEY`, and multimodal generation without the Azure inference pair. An id the run does not carry, whether invented by the model or restored from an activation hint a later deploy stopped registering, is denied.

Revalidation answers with one of three verdicts, and the third one is the point of having them. `authorized` activates; `denied` is a decision about authority — a revoked credential, a withdrawn grant, an owner who no longer holds the connection — and reaches the model as `plugin_not_authorized`; `indeterminate` means the host could not reach a decision at all, because the provider timed out, the transport failed, or the health check answered something that says nothing about this run's authority. Both non-authorized verdicts leave the plugin inactive, so the distinction costs the run nothing, and it is what stops a provider hiccup from being reported as a permission problem: an `indeterminate` load returns `plugin_authorization_unavailable`, and the host logs `connector_plugin_reauthorization_failed` with the connection and the underlying cause rather than discarding it. An adapter distinguishes the two the same way, through `reconnectRequired` on its health result. A verdict must never be derived from a swallowed exception — a failure to verify is not a denial, and reporting it as one sends a run off to explain a permission problem that may not exist.

All four non-success activation outcomes — unavailable, unauthorized,
authorization indeterminate, and deferred tools unavailable — use typed thrown
failures. Bind therefore emits `tool_failed`, the host stores a failed receipt,
and the model sees `success: false` with a stable code and recovery action. A
returned result containing an `error` field would instead be a completed tool by
protocol and is forbidden for these cases.

### Skills

A plugin gives the model a capability; a **skill** gives it a procedure. Skills are markdown instruction modules — how this workspace triages a queue, what a handover note must carry, the house voice — disclosed in the same three tiers the plugin catalog uses, because a workspace's accumulated know-how does not fit in a context window while a catalog line costs about fifty tokens.

A run's skills are **frozen with its scope**, exactly like its plugins. The host resolves them against the execution principal before admission and passes them on `RunHarnessInput.skills`; nothing in the loop reaches a store, so `load_skill` can only surface a body the run was already authorized to read. When a run has no skills, neither prompt section nor either tool appears.

The always-active `rally_skills` plugin owns two globally named controls. `load_skill` takes an exact name from the `# Skills` catalog and adds the skill's body to `# Active Skill Instructions` for the rest of the run. `read_skill_resource` reads a bundled reference file, and refuses until its skill has been loaded — that gate is what stops a model pulling every catalog skill's references without taking on the instructions they belong to.

**Loading a skill grants no authority.** Where a skill declares an owner plugin it is offered only to a run whose scope already includes that plugin — the eligible plugin ids are handed to the skill registry, which drops the rest before the catalog is built — and loading it *names* the plugin for the model to load separately rather than activating it: an auto-activation would let a document issue a capability grant. Skill bodies are also not trusted prose about the world — they are workspace-authored instructions, and are wrapped in a `<skill_content name=…>` element so the model can tell them apart from platform policy and from one another.

Three bounds keep a looping model from loading its way into a context-limit error: a count cap, a budget over the total tokens of loaded bodies, and a byte cap on a single `read_skill_resource` response. Bind judges the first two (`admitSkillLoad`); Rally measures the token half by resolving the bodies the load would actually inject, and applies the third itself — an unbounded Tier-3 read would otherwise route around the Tier-2 budget, since a skill whose body fits can bundle a reference that does not. All three are configurable, through `maxActiveSkills`, `maxActiveSkillBodyTokens`, and `maxSkillResourceBytes`.

The package ships three skills of its own (`BUILT_IN_SKILLS` in `@rally/agent-harness`), for a host with no library yet: `deep-research`, `writing-an-email`, and `scheduling-a-calendar-event`. The latter two are deliberately provider-agnostic — they name no connector and no tool, because the failures they exist to prevent (an address composed from a name and a domain, a fact quoted from memory, a guest list replaced when one attendee was meant to be added, a write reported as done without a result confirming it) belong to the task rather than to any one provider, and the next mail or calendar connector will carry them too. Neither sets an `ownerPlugin`, so neither implies that loading it granted the connection it describes.

All three are offered to every production run the API starts — ad-hoc,
automation, and HyperSight block alike. Nothing is withheld by surface. A skill
is advice, and what a surface may *do* is settled in the tool loop: HyperSight
composes `rejectToolModesBeforeCall(["write"], …)` into its `beforeToolCall`, so
a write-mode tool is refused before it runs no matter what the model has read.
Withholding a skill would hide advice without removing authority. Offering is
not activation: a run sees only the catalog line until it loads one, and loading
grants no authority. It is an ordinary `HarnessSkill` and not a second source:
a host still chooses to put it in `skills`, and the frozen-scope rule is
unchanged. It is authored in TypeScript rather than as a `SKILL.md` because the
harness runs in `workerd`, where there is no filesystem to read one at startup.

Bind's skill warnings — a name collision that lost a skill, a restored hint refused by a narrowed scope, a drifted pin — surface through `onSkillWarning`. Unwired, they are computed and discarded.

The prompt sections are a pure render of run state. Bodies are rebuilt from the active set on every turn in Bind's total order (origin, then name) rather than spliced into the previous prompt, so a resumed attempt produces the same bytes as a fresh one and the provider's cached prefix survives. Loaded refs are durably recorded through `persistSkillActivation` and restored on the next attempt through `skillActivationHints` — a hint, like a plugin activation hint, so a ref the narrowed scope no longer resolves is dropped rather than restored.

Skill scope misses, load-budget refusals, reads before activation, and missing
bundled resources are also typed failures rather than successful `output.error`
envelopes. Their messages carry the shortest next action; already-loaded skill
refs remain in the active catalog rather than being mislabeled as `available`,
and only bounded resource paths travel through the structured failure allowlist.

### Loop

1. Claim the lease, validate the principal, freeze the run scope, and load authorized context.
2. Register the applicable stable core plugins plus the frozen connection catalog; restore only reauthorized hints.
3. Reauthorize active plugins, render the stable prompt/tool surface, and ask OpenRouter through Bind's deterministic route plan.
4. Stream text through the epoch-aware protocol; reasoning fields are ignored.
5. Normalize unambiguous schema-declared numeric strings, validate tools, and recheck authority. Bind runs writes sequentially and may overlap independent reads. It accepts ordinary results in the model's original call order; a withheld elicitation result keeps its original call index and receives a later dense acceptance ordinal when the person answers.
6. Persist each immutable execution plan before execution and make a successful bounded result durable before returning it to Bind.
7. Persist the complete assistant message, then let the lease-owning child executor append the terminal lifecycle event.
8. Stop on completion, elicitation, the host's safe-boundary loop stop, ambiguous
   write, limit, lease loss, or failure. Receipt-local cancellation remains a
   separate terminal signal for child and generic non-work-stream executions.
9. Run external-platform delivery only after reloading a saved canonical turn:
   the exact terminal turn normally, or the open elicitation turn while waiting
   on a person. Status cleanup and suppressed-delivery receipts may run without
   one; reply or comment content may not.

Web discovery and page reading are bounded Firecrawl tools. Search returns ranked links and page fetch returns clean markdown. Both are omitted without `FIRECRAWL_API_KEY` and from inbound-email runs.

### Elicitation

The canonical `request_elicitation` tool belongs to `rally:core` and is rendered to the model as `core_request_elicitation`. It creates a typed text/radio/single/multi-select block and pauses the shared harness loop. The request row retains the stable original tool slot. When a person answers, the loop atomically accepts one tool result containing that answer and promotes the visible participant response before any later provider call. The participant turn is canonical UI history, not a second Bind user message; the model therefore receives the answer exactly once through the suspended tool protocol. Original tool-call position and dense result-acceptance order are separate identities, so another result accepted while the elicitation waits does not renumber either fact. In a work stream, the work stream becomes `needs_input`; a valid answer clears attention when no blockers remain and activates the same `SubstreamAgent` loop. In automation creation, the architect first saves its best partial state with `automation_submit_draft`, then calls the same core elicitation tool; the next creator request resumes from the saved draft and answered conversation.

### Durable receipts and terminal state

Each tool call receives a stable Rally receipt ID derived from the run, model turn, and original tool position; the provider call ID remains only in the model protocol. A tool that starts work outside Rally keys it to `HarnessToolContext.effectIntentId` instead, which the host resolves through `resolveToolEffectIntentId` after `tool_started` and which names the stored receipt row rather than the call: the row is created once and kept, so a resumed attempt reattaches to the effect it already started instead of starting a second one. The owning `SubstreamAgent` stores canonical inputs, immutable plan hashes, plugin/connection identity, mode, idempotency policy, optional provider key, and append-only progress in `tool_effects` and `tool_effect_checkpoints`; there is no D1 compatibility owner. Completed receipts retain provider operation IDs. Successful output is written to regional R2 and then committed to the current regional work-stream authority before Bind can observe it.

If the object is evicted after `assistant_accepted` but before every
`tool_result_accepted`, Bind does not repair the protocol array. Before another
provider request or pending input can cross the loop boundary, the host walks
the missing call positions against their durable receipts. A completed or
failed receipt becomes the corresponding exact tool result; an admitted call is
terminalized as `not_run`; an executing write becomes
`ambiguous_external_write`. Results are appended with their original call index
and a separate dense accepted ordinal. An ambiguous recovery settles the whole
tool batch and then fails the current cycle visibly without retrying the
provider or pretending that human input was requested.

Before the input hash or any host hook sees arguments, the harness walks the
tool's provider-facing JSON Schema and normalizes a string only where the field
is exclusively numeric and the complete string is a finite JSON number. Unsafe
integers and ambiguous string-or-number fields remain strings and fail or parse
under the executor's normal contract. A redundant `number` plus `integer` type
uses number semantics, because number already contains integer. One shared
10,000-schema-visit budget covers normalization and union mismatch scoring, in
addition to the depth cap, so a provider-controlled recursive branching schema
cannot turn the walk exponential. This makes a medium model's `"0"` and the
preferred `0` one canonical receipt identity without turning numeric-looking
resource ids or free text into numbers. Executors remain the enforcement point.
When one throws a Zod error, the harness checks the normalized input against the
same JSON Schema the model saw and any code-authored `validateInput` refinement:
a mismatch becomes a bounded `kind: "validation"` result from the closest union
branch, while valid input means the failure came from downstream data.
Validation failures are labelled `phase: "validation"` on the lifecycle event.
The attachment grounding guard discards such a call from its started-access
bookkeeping because no executor content read occurred; only an execution-phase
content failure can create an unresolved attachment claim. A validation event
may arrive either before `tool_started` or after an executor rejects its parsed
arguments. In the latter case the host settles the exact receipt identity it
recorded for that start and never replans the call as an empty-input validation
receipt; validation-only receipts exist only for failures that never started.

Completed receipts replay without another provider call only while their owning
subsystem's authorization and dependency checks still pass. Attachment list
results always re-execute; attachment content results require every resource to
remain visible at the exact derivative hash recorded before completion.
Historical protocol reconstruction applies that same rule before it replays a
completed attachment tool pair from an earlier run; the persisted execution
plan identifies attachment operations, and a failed current-authority check
omits their assistant/tool messages rather than trusting the R2 result.
Incomplete safe reads may resume. A reused or mismatched plan, incomplete prior
write, or timed-out `record_before_execute` write becomes
`ambiguous_external_write` and is never blindly repeated. Lifecycle events are
append-only, and terminalization is idempotent and lease-fenced.

Receipt IDs are positional, so a re-executed pass of the same run mints the same
coordinates again — that is what lets it replay the first pass's results instead
of repeating them. A pass that restarts is given the transcript window up to its
own trigger and cannot see the calls the earlier pass made, so it will not
reliably reproduce them, and a *different* call landing on an occupied
coordinate is the expected consequence. When both sides of such a collision are
reads and the recorded receipt has settled, the receipt is **rebound** to the
call in hand: nothing external moved, the recorded result belongs to a pass that
is gone, and the row is replanned in place under an `execution_replanned`
checkpoint. Identical input replays as before, a receipt whose recorded identity
cannot be proven compatible still fails closed, and `record_before_execute`
writes never rebind — for them the coordinate *is* the idempotency key.

A receipt is not always the only record of its call, and one that owns durable
state elsewhere does not rebind either: a delegated child run keyed by the
parent's coordinate, or attachment dependency rows keyed by the invocation id.
Those are asked as questions about state, not about tool names, so a tool that
starts keying either is covered without being listed. Because a rebound receipt
carries checkpoints past the static index its completion path passes, the
completion derives its own index from the row rather than trusting that number —
otherwise the replanned read executes and then cannot persist its result. An
ambiguity that halts a run is recorded as an audit event and as the run's own
error, because a collision with a settled receipt leaves the row itself
untouched and would otherwise reach the person as a bare `needs_input`.

Failed receipts preserve the same bounded structured recovery context that Bind
showed the model when the tool failed. A `tool_failed` event carries the
allowlisted `data` object, the regional host commits that object beside the code
and message in `error_json`, and historical protocol reconstruction restores
the same failed tool result after a Worker retry or run resume. Participant-facing
tool rows continue to render the ordinary error message; the recovery object is
for the model protocol, not a second UI error surface.

An attachment view is the one result with two representations. Its durable
receipt and `tool_completed` event contain only the bounded JSON inclusion
summary. The in-memory tool message adds ordered image parts after that JSON for
the next model turn. On receipt replay the regional host reauthorizes the
resource and recreates those parts from the selected image derivative. If the
parts cannot be recreated, it invalidates the safe-read receipt and executes the
tool again rather than returning the JSON inclusion summary alone. No data URI
enters D1, the replay object, or a persisted transcript row.

Attachment dependencies are registered only after the invocation completion is
accepted, and each insert plus mismatch cleanup requires that invocation to
remain `completed` at the exact content-addressed `output_ref` returned by that
settlement. A stale executor therefore cannot attach old resources to, or delete
dependencies from, a successor replan of the stable invocation identity. The
successor's replan compare-and-swap also repeats the absence of both attachment
dependencies and coordinate-keyed child runs inside its atomic checkpoint and
receipt writes. A dependency that appears after the preliminary read therefore
leaves the completed receipt and its original output untouched.

### Model routing and inference ledger

Each agent's default model and its fallback stages are one Cloudflare Flagship flag, resolved once per run and evaluated against the region, the environment, and the run's subject — the workspace, work stream, and user, each carrying the attributes a targeting rule matches on; the regional Worker variables remain the checked-in default that an absent flag, an unbound binding, and a failed evaluation all resolve to. [`feature-flags.md`](feature-flags.md) owns the flag keys, the value shape, and how a model change is rolled out.

Standalone structured-output agents enter through `runStructuredInference`. The gateway resolves the role's flag, constructs the provider client, combines any caller cancellation with a two-minute ceiling, and emits redacted diagnostics for every request, repair, validation, fallback, and completion stage. ESLint prevents API feature modules from constructing `OpenRouterClient`, reading model-selection variables directly, or removing the gateway's signal and diagnostic hooks. The harness package has a separate portability boundary: production sources cannot import database, connector, API, or Node-only implementations and cannot read `process`; host capabilities arrive through explicit ports.

Provider routing is deterministic and versioned by Bind. Rally contributes a
checked-in canonical-model binding and one planner transport per provider; Bind
resolves the policy, filters candidates against the turn's actual capabilities,
builds the Azure/OpenRouter/model stages, operates their shared circuit breaker,
and executes traversal. `x-ai/grok-4.3` and `x-ai/grok-4.6` are Azure-bound:
their same-model route is Azure first and OpenRouter second. Other canonical
models remain OpenRouter-only. A file-parser request, audio input, or another
capability an Azure binding has not proved skips that candidate before any
network request rather than sending a body the deployment may reject.

The Azure transport is enabled only when its dedicated endpoint and API key are
both present. Those values are separate from realtime-dictation configuration,
so configuring an EU dictation resource cannot accidentally send an EU work
stream to the Global Monad production inference resource. A shared contract
accepts only an HTTPS resource root or `/openai/v1` base, so an endpoint the
transport cannot address fails Worker startup rather than the first model turn.
Azure receives the
deployment name as `model`, the standard OpenAI-compatible message/tool body,
and `reasoning_effort` only for a binding that declares it. OpenRouter-only
Broadcast fields, plugins, routing metadata, and headers never cross that
boundary. Canonical `x-ai/...` identity remains in Rally's transcript and
ledger; the Azure deployment name is recorded separately as the provider
invocation model.

The checked-in Monad production bindings were verified against the live
`monad-prod-resource` deployment details on 2026-08-30:

| Canonical model | Azure deployment | Version / lifecycle | Deployment | Live quota | Guardrail |
| --- | --- | --- | --- | --- | --- |
| `x-ai/grok-4.3` | `grok-4.3` | `1` / Preview | Global Standard | 250,000 TPM / 250 RPM | DefaultV2 |
| `x-ai/grok-4.6` | `grok-4.6` | `1` / Preview | Global Standard | 2,250,000 TPM / 2,250 RPM | DefaultV2 |

Both expose
`https://monad-prod-resource.services.ai.azure.com/openai/v1/chat/completions`.
Manual inference probes returned token usage but no dollar `cost` or `price`
field. When that happens, the configured fallback is the unweighted arithmetic
mean of OpenRouter's published endpoint prices for that canonical model—not the
top-level model-catalog price, which OpenRouter documents as the lowest endpoint
price. On 2026-08-30 the four 4.3 endpoints averaged $1.875 input, $0.30 cached
input, and $3.75 output per million tokens through the first 200,000 prompt
tokens, then $3.75 / $0.60 / $7.50. The five 4.6 endpoints averaged
$2.84 / $0.71 / $8.52, then $5.68 / $1.42 / $17.04 at the same OpenRouter
catalog threshold. A dedicated Global cron refreshes those rates hourly,
writes each model under its canonical OpenRouter ID in the shared regional KV,
and preserves the decimal costs as strings. The inventory covers every model in
the developer-mode manual selector plus every Monad production Azure
deployment carried by OpenRouter: fourteen unique IDs on that date. API inference
only reads the cache when the primary or a fallback model has an Azure binding;
it never fetches or writes pricing. A failed cache read omits Azure and leaves
OpenRouter available. Azure's Retail Prices
API separately published 4.3 Global meters but no 4.6 meter that day; that API
is useful corroboration, not this fallback's rate authority.
The Azure agent route does not enable provider web search, so the separate
per-search catalog charge is neither incurred nor folded into token rates.

Empty completions, truncated tool calls, and fallback-eligible failures may
retry or traverse configured provider and model stages only before an assistant
byte is published and before a tool effect begins. The first observable delta
closes that route permanently. A later failure terminalizes the step, removes
its transient preview, and materializes the reserved failure status instead of
asking another provider for a competing answer. Cancellation and host failures
never route onward.

OpenRouter reports dollars directly. Azure reports token counts, so Rally feeds
the cached per-million-token rates and declared disjoint Grok cache semantics
through Bind's configured-rate billing function. Azure reports cached Grok
tokens alongside rather than inside `prompt_tokens`, so Rally adds both input
buckets only to select the OpenRouter prompt-size tier; Bind still prices each
bucket exactly once. A missing, malformed, or
legacy numeric-cost record removes that Azure candidate before the request;
stale valid pricing remains usable. Missing or internally inconsistent final
Azure usage fails the attempt; it is never recorded as a zero-cost call and
cannot silently bypass a run cost ceiling.
Azure Grok also reports reasoning outside `completion_tokens` while including
it in `total_tokens`; Bind is therefore given `total_tokens - prompt_tokens` as
the billable output count so hidden reasoning is not treated as free.

The Bind/OpenRouter boundary is converted member by member rather than asserted
through `unknown`. Bind's OpenAI-wire-compatible structural messages remain an
internal loop contract, but Rally has no direct OpenAI SDK dependency: the
official `@openrouter/sdk` schemas own provider request serialization and
successful response/chunk parsing. Model content parts and function tools are
mapped to Rally's wire types, unsupported tool variants fail at the boundary,
and input audio admits only the `wav` and `mp3` formats the OpenRouter SDK
contract supports. This keeps an SDK union or return-shape change visible to the
compiler instead of letting it emerge later in a provider request.

Every OpenRouter request opts into router metadata and carries a Broadcast trace
envelope. One harness loop has one `trace_id`, fixed to its durable request/run
ID across every model turn, including tool call, tool result, and final-answer
turns. Every model turn has its own `span_name`; the OpenRouter request is the
generation inside that span. `turn_id`, inference request, and route cursor
fields distinguish the individual generations and retries.
For work-stream inference, `session_id` is exactly
`<workstream_id>-<substream_id>`. Both OpenRouter's top-level `user` and trace
`user_id` are the opaque Rally workspace ID, giving Broadcast and PostHog one
stable tenant identity for user- and system-initiated runs. A relevant person,
when one exists, is kept separately as `context_user_id`. The trace also carries
source, workspace, work-stream, substream, request, parent request, harness run,
draft, region, environment, build, principal, invocation type, provider/model,
inference-request, and route-cursor metadata when each value exists. `feature`
is the authoritative Flagship model-category key (for example,
`agent-model-workstream`), `source` is the inference surface, and `product` is
`rally`. `intended_model` is the primary model Rally selected before route
traversal; `model` is the candidate used for that request, so a mismatch (or a
nonzero `route_stage_index`) identifies application-level fallback.
OpenRouter's PostHog Broadcast
mapping therefore receives the workspace as `distinct_id`, the work-stream
session as `$ai_session_id`, the loop trace as `$ai_trace_id`, the turn
generation name as `$ai_span_name`, and the remaining fields as `metadata_*`
properties. One-shot structured calls use one call-scoped trace ID across
retries, repairs, and fallback models, and use their schema name as the
generation name.
OpenRouter's returned
`openrouter_metadata` is retained with successful streaming attempts so routing
and pipeline decisions join the same lakehouse evidence. Broadcast destination
enablement and content/privacy policy remain OpenRouter account configuration;
the request path supplies trace data but does not silently alter that account
setting.

Every classified provider attempt appends an immutable operational
`inference_attempts` row in the owning `SubstreamAgent` or
`BlockDashboardAgent`, with its turn/route cursor, provider and model, routing
decision, outcome, latency, available token/cache/cost counters, and hashed
credential/workspace identities. Harness-run usage also stores turn/tool
timings and counts. Provider error bodies and credentials are not retained in
that recovery ledger. For Global workspaces, the Global lakehouse separately
uses the closed source vocabulary `workstream`, `automation_compiler`,
`inline_child`, `block_dashboard`, and `meeting_notes` for analytical capture.
EU workspaces intentionally have no analytical inference capture.

The harness also emits lossless events that the Global host sends to the
[`inference lakehouse`](inference-lakehouse.md). A streaming call exposes the
exact outbound body before inference and its complete normalized response or
provider error at the terminal attempt. A structured call assigns one request
ID before each provider fetch and carries its exact outbound body, complete
successful JSON provider envelope, bounded failure classification, usage,
latency, response size, repair position, and validation outcome through
completion. These are explicit host hooks: the portable harness
does not know about R2, Queue, Pipeline, or residency, and a host's capture
failure or the EU host's intentional no-op never changes provider routing or run
outcome.

### Streaming stability

OpenAI-compatible SSE comments are ignored and function-call fragments are combined by index. Each model turn has a stable `turnId`; `epoch` and `streamSeq` order protocol frames within it, independently of the SubstreamAgent event `sequence` used for socket replay. A pre-output route retry may advance the attempt epoch but has no participant text to retract. Once a delta is observable, failure closes the step rather than issuing a transparent route restart.

Text deltas are buffered before broadcast, but a reset is sent alone and batches never cross turn or epoch boundaries. The room commits each sequenced stream frame together with an accumulated active-stream checkpoint in Durable Object storage. Its metadata and bounded text chunks share that transaction, so a long answer cannot make one storage value reject every later frame. An initial snapshot or history-gap resync reassembles that checkpoint, including its independent Bind cursor and attempt boundary, so somebody joining after the response began installs the exact partial text before catch-up and live frames cross the same sequence boundary.

The desktop retains room and per-message stream cursors across socket and route handoffs, rejects duplicate or stale frames, and removes only the failed active turn's ephemeral preview while preserving completed text from earlier tool turns. The shell keeps a background subscriber only for running work streams that are not open, and a canonical refresh retains the active transient assistant row until its accepted turn or failure status arrives. The owning `SubstreamAgent` is the only regional work-stream authority: it stores the complete accepted assistant message plus a bounded active-output checkpoint while streaming, and terminal resynchronization remains canonical.

### Transcript row attribution

Every chat surface renders one row component, so a tool row must mean the same
thing wherever it appears. Two rules keep the work stream and the automation
composer from wording or attributing the same call differently.

A row's icon is the plugin that **owns** the tool being called, and nothing
else. In the compiler, that owner comes from the `automation:` prefix on the
Bind plugin id; in a work stream, it is resolved from
`tool_invocations.connection_id`, which already records the connector that ran
the tool. Tools Rally owns — web research, plugin discovery, memory, tables,
work-stream reads — have no connector behind them and carry no plugin icon.
Both the contract's `ToolInvocation.plugin` and the compiler's `tool` stream
event hold a single nullable plugin, so a row with several icons cannot be
represented. A discovery row may still *name* several plugins in its label
without claiming any of them ran the tool.

A row's label is prose from `toolActivityName` in
[`packages/agent-harness/src/tool-activity.ts`](../packages/agent-harness/src/tool-activity.ts),
never a raw wire name. Tools Rally owns have their own phrasing per lifecycle
state; a connector tool is named after the connector that owns it, matching the
icon beside it; an unrecognized tool degrades to a humanized wire name rather
than a snake_case symbol. Adding a Rally tool means adding its prose there.
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

### HyperSight blocks

A HyperSight block run is the same harness with a different terminal product: it renders one block of shared Markdown for a work stream's dashboard, on a schedule, with no transcript or interactive participant of its own. A user may watch read-only state and streamed output over the block agent's direct socket while the dashboard is visible, but cannot send a message, pause it, or answer an elicitation. One stable `BlockDashboardAgent` owns each block's complete loop. WorkstreamDO owns configuration and fan-out; the block agent resolves main `SubstreamAgent("0")` directly through typed object ports for its run/receipt state and a frozen model-array interval: exact compaction event (or array start) through a complete tool-safe upper sequence. It never executes in the source agent, the parent, or a Workflow. Three things follow.

It is read-only through `rejectToolModesBeforeCall(["write"], …)`, and it cannot
pause — a run that reaches `needs_input` fails with
`block_dashboard_input_unavailable`, because there is no one to answer.

Its output is a tool call. The block is exactly the `markdown` argument passed to the `rally:block-dashboard` plugin's `submit_block`, and assistant text is discarded. Taking the block from the run's trailing text instead made every preamble, apology, and "here is the block:" part of the dashboard; an argument with a schema cannot drift that way. The tool is `mode: "read"` — it settles Rally's own record and reaches no provider, the same reason the automation architect's draft submission is a read — so the write ban above does not lock the run out of its own output.

A turn that would end without that call gets one `onTurnWouldEnd` message asking for it, and only one: a block that will not submit twice running is a failed block, and nagging further only spends the run's ceilings. If it still never submits, the run is recorded `failed` with `block_dashboard_block_not_submitted` rather than completed-and-empty, so a block that renders nothing says why.

HyperSight shares the root run policy: 1,000 routed model attempts and no aggregate
tool-call, cost, or task-scale wall-time ceiling. Its read-only tool policy and inability to pause remain independent
of resource policy. Each terminal refresh contributes one aggregate summary to
the root-run Analytics Engine dataset, so future ceilings can be selected from
the measured distributions rather than assumed in advance.

### Child agents

Inline child Bind execution inside a parent `SubstreamAgent` is disabled. It
would create a second logical loop inside the parent's authority while hiding it
behind the parent's identity, which breaks the one-loop-per-substream invariant.
A future child must receive its own stable child substream and `SubstreamAgent`;
the parent loop ID plus tool-call ID may address that distinct child, but may
never identify a loop executing inside the parent object. Until that durable
routing exists, `workstream_run_subagent` is absent from production tool
surfaces.

### Scoped durable memory

Root work-stream runs receive the stable `rally_memory` plugin. `memory_search`
accepts exactly one of a content query or `memoryItemId`; the exact-ID form is the
conflict-recovery read for a mutation and still reauthorizes the item against the
host-derived scope union. The host returns scope provenance without allowing the
model to select scope IDs. A message-origin run does not search long-term memory
automatically before its first inference: opening and follow-up composer messages,
elicitation answers, inbound email, and Slack opening, follow-up, and elicitation
messages go directly from durable transcript/trigger context to the model. The
plugin remains available, so the agent can explicitly call `memory_search` when
the task needs older context. Non-message ad-hoc runs search workspace, user, and
work-stream memory at admission. An automation run's memory tools execute inside
its named `AutomationAgent` and reach that automation's own memory; the workspace-side
automation scope union was retired with the 2026-08-28 automation cutover, and
`resolveMemoryAccess` refuses a subscription-declaring run by name
(`memory_automation_scope_retired`) rather than reading a subscription row no
reachable store still holds.

**A run in a work stream an automation created, carrying no subscription of its
own, is none of those**, and the run's own `automationSubscriptionId` — not the
work stream's origin — is what decides which it is. That covers more than a
member's reply: an elicitation answer, a manual retry, a HyperSight block
dispatch, and, least obviously, the automation's *own* continuation through a
scheduled wake-up, because `launchWorkstreamHarness` declares no subscription
either. Their search authority includes workspace memory, plus that member's own
when a person is behind it; message runs exercise that authority only through an
explicit memory tool call. The subscription's automation scope stays reachable
exactly from a run that declares it and whose principal matches it, and a work stream an
automation created owns no work-stream scope, because the next run of that
subscription gets a different work stream and anything left in this one could
never be recalled.

**The union is not the whole story, and in one direction it currently overstates
what is withheld.** The protocol projector reauthorizes replayed *attachment*
results and nothing else, so a completed `memory_search` or `memory_table_query`
receipt from an earlier run in the same transcript window is replayed to the next
run verbatim, out of R2, whatever that run's own union is. A reply therefore
resolves no automation scope but can still be handed the items the automation's
run recalled from one. That gap predates this rule and is not created by it —
two people in one ad-hoc work stream reach it the same way — but automation and
owner-user memory only started travelling it once these runs stopped dying.
Until the projector filters a replayed memory result against the current union,
the scope union is the authority for what a run may *search*, not a guarantee
about everything in its context.

Memory is not the whole of what such a run does without: `automationContext` —
the subscription's instructions, expected outputs, result delivery, and its
`rally_tables` durable tables — and the subscription's default plugins are both
gated on the same field, so a reply is also a *less capable* run than the one it
is answering. The sharpest edge is the tables: `table_search` answers a run that
cannot reach them with an empty result rather than a refusal, so a member asking
for a row in the table the automation visibly keeps gets told there is no such
table. Whether these runs should instead inherit what the automation was
configured with is one unanswered product question about who may read and act on
an automation's configuration; whether a work stream an automation created
should start owning a work-stream scope once people are talking in it is a
second. Neither is the memory union's to decide on its own, and neither writes a
row today, so both stay open.

Memory items retain structured provenance, access metadata, expiry, revisions, and reversible invalidation, but no confidence field. Agents add by scope kind and update or invalidate by item ID plus expected revision. Workspace writes require a workspace principal or an owner/admin user. WorkspaceDO FTS is synchronous; OpenRouter `qwen/qwen3-embedding-8b` embeddings and the regional Vectorize projection advance through a replayable WorkspaceDO outbox. Requests explicitly ask for 1,024 dimensions—supported by Qwen3 Embedding 8B's Matryoshka representation—to match the immutable Vectorize index shape and distinguish query from document input. The model is a fixed inference-gateway constant with no Flagship role, Worker override, or model fallback. A fixed-model-and-dimension-derived namespace prevents embeddings from different semantic spaces from ever being compared; OpenRouter reporting a different resolved model fails the request closed, and retrieval falls back to FTS. Changing the constant requires a code change paired with requeueing active memories, and retrieval safely falls back to FTS until that rebuild completes. Hybrid hits are always reloaded from WorkspaceDO before exposure and rechecked against current D1 membership. A non-message root run that performs automatic admission recall stores an immutable snapshot and hash; a message-origin run stores no memory-context hash.

Root runs also receive the separate stable `rally_tables` plugin for large structured collections that should not enter prompt context as prose memories. Tables inherit the same work-stream, automation, user, and workspace authorization union. Reads accept a reauthorized table ID plus typed filter/search/projection/order/cursor arguments or an exact `memoryTableRowIds` selector for conflict recovery; they never accept scope or owner selectors and expose no raw SQL. Rows use typed columns, a declared natural key, synchronous WorkspaceDO FTS for searchable text, typed cell indexes, revision compare-and-swap, reversible invalidation, and receipt-backed append-only mutation records.

Memory and table mutations return identifiers and current revisions. On a revision
conflict, the failed result directs the model to re-read those exact identifiers,
reconcile its intended change, and retry with the newly observed revision. Table
insert contention is a separate typed failure because inserts do not have an
`expectedRevision`; after bounded host retries it directs the model to query by
the declared natural key and retry only the rows that remain absent.

Automation drafts may declare automation-scoped tables. Acceptance materializes an independent table set under the new subscription, so every work stream from that subscription shares its rows while subscribers to a shared template do not share state. Every automation run receives the materialized table IDs, column IDs, natural keys, purpose, and usage/update instructions in its authorized task context. Table rows are never added to admission recall; the agent must query only the rows and columns needed for the current run.

### Scheduled wake-ups

`rally:workstream` carries `schedule_wakeup`, `list_wakeups`, and `cancel_wakeup`, so a run can defer work to a stated instant instead of promising it in text. `schedule_wakeup` takes the prompt plus exactly one of `delay` — a duration in common units, `"5 minutes"`, `"90 sec"`, `"1h30m"`, or an ISO-8601 `"PT2H30M"` — or `at`, an exact ISO-8601 timestamp. An `at` without an offset is read in the run's local zone, or in an explicit `timezone`; an `at` that carries an offset is absolute and rejects `timezone` rather than silently choosing between the two. The resolved instant must be at least one minute and at most one year out, whichever form produced it. Pending wake-ups are capped per work stream, and every rejection returns a stable code with its remediation and accepted vocabulary in the model-visible failed result.

The tool is `provider_key`-idempotent against `(workstream_id, idempotency_key)`, so a replayed receipt returns the persisted wake-up instead of scheduling a second. The workspace scheduler fires it: it claims the row before launching, so a lost claim means a missed wake-up rather than a duplicated run, and releases the claim when the harness cannot start so a later alarm retries. The principal that scheduled the wake-up is re-validated against current membership at fire time — a wake-up cannot outlive the authority that created it. The resulting run reads the prompt as an explicit trigger message labelled as coming from an earlier run of the same work stream; the transcript row is separate host-written system state. Sub-agents get none of these tools: they cannot schedule, and a parent's wake-ups are not theirs to act on.

Every work-stream response carries `nextPendingWakeup`, the earliest pending row
by due time, derived with an indexed lookup. The navigation sidebar renders that
state as a clock at the trailing edge of the row, whether the wake-up came from
`delay` or `at`; fired and cancelled rows do not qualify. Its tooltip shows the
exact local due time and the first 40 characters of the prompt, with an ellipsis
when more remains. The database read bounds the prefix and the mapper finishes
the preview before the data crosses the API boundary, so the list never carries
the full prompt just to label a compact marker; the work-stream tools remain the
boundary for complete wake-up detail.

That split — a labelled trigger message for the model, a system row for the person reading the transcript — is the contract for every scheduler-started run, not a wake-up detail. A scheduled digest carries its frozen window the same way ([`digests.md`](digests.md#the-run)). A run whose instructions exist only as a transcript `system` row reaches the model with nothing but its work stream's objective, because the protocol projector drops those rows as UI state; whatever starts a run has to hand the host something to render.

### Loop stop, receipt cancellation, and deferred systems

Ordinary **Stop** on a persistent work-stream loop writes
`substream_loops.stop_requested_at` and `stop_after_step_ordinal`. It does not
write `runs.cancellation_requested_at` and does not terminate an in-flight model
request or tool call out of band. The loop owner observes the request only after
the accepted response and every tool it already emitted settle, then prevents
the next provider step and terminalizes the subordinate receipt.

`runs.cancellation_requested_at` is instead a receipt-local cleanup signal for
descendant/child runs and generic non-work-stream executions. It is not loop
control. Admission observes a pre-start receipt cancellation, and a live receipt
owner observes it through heartbeats and event checks. If that observation
aborts a child or generic tool, the same live attempt may settle that exact
in-flight receipt even though receipt cancellation has been requested; the
narrow settlement path still requires the current attempt id, lease owner,
unexpired lease, `running` parent, and no prior terminalization. A
`record_before_execute` write remains ambiguous, while a definitive read failure
remains failed. In every checkpoint, successful-completion, and failure batch,
the live-lease fence admits the checkpoint insert; the immediately following
receipt update is tied to that admitted checkpoint rather than re-reading
wall-clock expiry. Crossing the lease deadline between serialized statements
therefore cannot leave an immutable checkpoint beside a still-started receipt.
Parent terminalization still requires the live lease. When receipt-local
cancellation is settled, the leased owner first commits the requested `stopped`
transition, then closes any still-unfinished receipt through the object-local
exact-terminal-stamp fence — unresolved writes become ambiguous and reads fail —
whether it came from the current executor or survived an expired attempt.
Cleanup advances past any checkpoint stranded by an older deployment. A
definite completion or failure that wins first remains terminal. **Every**
terminal transition closes residual receipts, not only the stopped one: a run
that reaches `completed`, `needs_input`, or `failed` is supposed to have settled
each receipt as its tool returned, so one still open at that point is a defect,
and one whose only symptom is a permanently spinning tool card. A run that wrote
its own terminal row says so — its residual receipts carry `run_terminated`,
never the reaper's `parent_run_terminated`, because no lease was observed to be
lost. Both retry paths *derive* that from the terminal row rather than from who
is asking: the reaper keeps `attempt_id` and clears only the lease, so a reaped
root whose settlement was lost matches every predicate the returning original
executor tests, and assuming `direct` there would relabel the reaper's own work.
An immutable lifecycle marker acknowledges successful residual settlement; a
direct retry or the bounded activation sweep repairs any terminal run missing
that marker, preventing a transient second-call failure from leaving a
permanently `started` tool row. The sweep's retry predicate is every terminal
row without the marker rather than a list of the paths known to write one, so a
path added later is covered without being named. Because that walk now also
visits ordinary terminal rows, the stale-automation settlement it performs —
which matches every unfinished automation row in the work stream rather than
the run's own — is restricted to a reaped root. If an obsolete executor loses
ownership, its local dispatch is deferred to adopt the successor's result; it
cannot write an unfenced product failure.

The work-stream transcript, attached resources, activation hints, run scope,
inference ledger, tool receipts, and scoped memory remain distinct durable
records. Nested child delegation, personas, roles, and general child
participants remain deferred product work.


## Invariants

- **One predicate decides both the transport retry and the failure code**, so the
  failures Rally retries are exactly the ones it names as the provider's.
  Splitting them lets a member be told Rally broke for an outage Rally had just
  spent a retry on, which is the pairing that made the original incident hard to
  read.
- **A request Rally owns is never named as the provider's.** A 400 is our
  request shape and 401/402/403 are our credential and credit; they stay
  `harness_execution_failed`, and `provider_circuit_open` says only that Rally
  stopped calling — never why — because the breaker opens on those too. Widening
  the provider arm to cover them points an operator at the wrong system.
- **A retry never replays output a reader has already seen.** The transport retry
  checks the same `producedOutput` flag the route executor clamps traversal on;
  re-rendering a turn someone is part-way through reading is worse than the
  failure it recovers.
- **At most one unexpired harness lease runs in a substream**, and scope,
  activation, receipt-plan and completion, checkpoint, and terminal commits all
  require the same attempt ID, lease owner, and expiry. An obsolete executor cannot
  publish a terminal result.
- **One stable `loopId` belongs to each Bind host.** An execution receipt,
  activation, message, retry, or wake-up may not create a replacement loop.
- **Provider I/O starts only after host reservation and `assistant_reserved`
  both commit.** A crash may leave a reservation to repair, but may not skip or
  allocate a second participant sequence.
- **Canonical messages are immutable.** Streaming output is ephemeral until the
  reserved assistant settles; a failed partial stream becomes an error pill at
  that exact sequence rather than a compatibility message or reordered copy.
- **No provider attempt is retried after observable output or an external
  effect.** Once either happens, replay could duplicate visible text or work.
- **Stop is observed only at the post-step safe boundary.** The active assistant
  and all of its tools settle first; no next provider request begins. If stop
  commits while the host is preparing newly arrived steers, stop wins the
  transaction and those inputs remain pending for the next activation.
- **`completed` cannot commit until the final agent message is durable.**
- **A failed attachment-content call cannot authorize attachment facts.** The
  host gives the model one recovery turn, then replaces terminal prose with a
  content-free failure boundary unless a later successful content access
  resolves the resource.
- **Terminal root runs leave no live-looking tool receipt.** Stale-run reaping
  fails every pending or started tool invocation in the same fenced batch;
  member-requested stops render a distinct terminal stopped outcome in the
  desktop rather than disappearing into idle state.
- **Activation never precedes its subordinate execution receipt.** The receipt
  is the durable start signal; a replay uses its same identity and loop.
- **The run scope is frozen, canonically hashed, and immutable.** A replay must
  reproduce it. Connections installed or expanded later cannot enter it; every
  later check may only *remove* authority.
- **Loading never widens the frozen scope.** Bound connections, attached
  resources, and previously used plugins are activation *hints*, filtered through
  the frozen scope and reauthorized before restoration.
- **Activation is durably recorded before a plugin's tools or trusted guidance
  become visible.**
- **Required host failures carry an explicit recovery category.** Tool lifecycle
  events and receipt checkpoints are `tool_receipt_persistence_failed`; run,
  usage, inference-ledger, compaction, and activation state are
  `run_state_persistence_failed`; authorization revalidation is
  `harness_execution_failed`. The category is selected at the call site from
  the persisted invariant, never inferred from prose in an error label.
- **A verdict is never derived from a swallowed exception.** `denied` is a
  decision about authority; `indeterminate` means the host could not reach one.
  Reporting the second as the first sends a run off to explain a permission problem
  that may not exist.
- **A stored `needs_reconnect` does not drop a plugin.** It is a belief about a
  past moment; the call reaches the provider and fails on the provider's answer —
  see [Stored status is a belief, not a
  gate](connectors.md#stored-status-is-a-belief-not-a-gate).
- **Skills are frozen with the scope, and loading one grants no authority.**
  Nothing in the loop reaches a store, so `load_skill` can only surface a body the
  run was already authorized to read, and a skill naming an owner plugin makes the
  model load it separately rather than activating it — an auto-activation would let
  a document issue a capability grant.
- **A triggering activity or inbound email is untrusted user-role evidence**, never
  promoted into the system prompt. The same holds for a naming request and a skill
  body, which is wrapped in `<skill_content name=…>` so the model can tell it from
  platform policy.
- **The trigger's two jobs stay separate on a retry.** As *identity* it admits a
  brief or an inbound email to the model at all; as *bound*
  (`transcriptFenceMessageId`) it is the newest message the run may see. The fence
  is resolved once at launch and travels in the durable workflow input, never
  re-read at projection time — an attempt that replays must read the same window it
  read the first time.
- **`retry` inherits the stored `trigger_message_id` rather than reconstructing
  it.** Reconstructing the trigger as "the latest human message" is right only while
  nothing has happened since, and fences finished work out of the replay whenever it
  has.
- **Every write to a title is conditional on the status the pass started from.**
  Renaming settles a work stream, so a generated name arriving afterwards is dropped
  rather than applied.
- **A tool call is a proposal.** Tools are validated and authority rechecked before
  execution, at run start, before credential decryption, before every tool call, and
  between model turns.
- **Reasoning fields are ignored**; private chain-of-thought is neither persisted
  nor broadcast.
- **Successful tool output is durable before Bind can observe it**, and completed
  receipts replay without another provider call.
- **An ambiguous external write is never blindly repeated**, and limits never
  silently reinterpret a write as successful.
- **A run's output is what a schema captured, not its trailing text.** A HyperSight
  block is exactly the `markdown` argument to `submit_block`; assistant text is
  discarded.
- **A child can never widen the parent's frozen scope**, is read-only by a tool-loop
  hook rather than by what it was given, and cannot recurse.
- **The model never selects a memory scope.** `memory_search` accepts exactly one
  content query or exact item ID; the host derives the authorized scope union
  from the frozen principal and the run's own declared subscription, and every
  hit is reauthorized and reloaded from WorkspaceDO before exposure and
  rechecked against current D1 membership.
- **A work stream an automation created owns no work-stream memory scope**, and
  `resolveMemoryAccess` is the only thing that still says so. Migration 0036
  held it as a D1 trigger; 0090 dropped that with the rest of D1's product
  enforcement when memory moved into WorkspaceDO, which validates no scope
  owner at all. Break it and memory accrues in a work stream the next run of
  that subscription will never see.
- **Whatever starts a run hands the host something to render.** A run whose
  instructions exist only as a transcript `system` row reaches the model with
  nothing but its work stream's objective, because the protocol projector drops
  those rows as UI state.
- **A cancellation is a durable request, observed by the lease owner**, which alone
  commits the fenced `stopped` transition. Stopping never kills an in-flight
  provider or tool operation out of band.
- **A row carries exactly one plugin icon, the one that owns the tool.** Both
  `ToolInvocation.plugin` and the compiler's `tool` stream event hold a single
  nullable plugin, so a row with several icons cannot be represented.
- **Prompt sections are a pure render of run state.** Bodies are rebuilt from the
  active set on every turn in Bind's total order rather than spliced into the
  previous prompt, so a resumed attempt produces the same bytes as a fresh one and
  the provider's cached prefix survives.
- **The harness package imports no database, connector, API, or Node-only
  implementation and never reads `process`.** Host capabilities arrive through
  explicit ports, and ESLint enforces it.

## Boundary

This document owns the persistent loop and its subordinate executions: how an
activation is admitted, what authority it is frozen with, how steps execute and
record tool calls, and how an execution terminalizes. **Bind** owns
transcript healing, plugin and skill activation, turn and tool iteration,
completion-defect recovery, epoch-aware streaming, and classified route traversal.
**Rally** owns authorization, regional persistence, admission, accounting, and
terminal state.

It does not own:

| For | Read |
| --- | --- |
| What a run remembers once its window fills | [`context-compaction.md`](context-compaction.md) |
| How to *design* a tool so a small model uses it right | [`agent-tools.md`](agent-tools.md) |
| How to *author* a skill | [`writing-skills.md`](writing-skills.md) |
| How to *write* a prompt in `prompts/` | [`writing-prompts.md`](writing-prompts.md) |
| Which model each agent runs on, and the pin that overrides it | [`feature-flags.md`](feature-flags.md) |
| Connector adapters, grants, and health semantics | [`connectors.md`](connectors.md) |
| The create path a run is launched from | [`workstream-creation.md`](workstream-creation.md) |
| The digest that rides this loop | [`digests.md`](digests.md) |
| The description pass that runs after a terminal run | [`workstream-descriptions.md`](workstream-descriptions.md) |
| Reading a captured inference record back | [`runbook.md`](runbook.md#inspecting-a-runs-raw-inference) |
| Regional analytical inference capture and retention | [`inference-lakehouse.md`](inference-lakehouse.md) |

A substream owns one server-side, tool-using loop. A run is an execution receipt.
Neither is a participant, a separate persona, a terminal, or a general code-execution
environment, and nested child delegation, personas, roles,
and general child participants remain deferred product work.

## Failure modes and limits

Root ordinary work-stream and HyperSight runs allow 1,000 model iterations and have no tool-call, wall-clock, or cost ceiling. An ordinary work-stream loop otherwise continues until completion, elicitation, its safe-boundary stop, ambiguous write, lease or authority loss, context failure, or provider failure. HyperSight and generic execution receipts may additionally end through durable receipt cancellation; HyperSight converts elicitation and a missing block submission into its own terminal failures. Per-tool time and plugin-catalog tokens remain bounded, and request establishment, time to first token, and inter-chunk idle time have separate watchdogs. Deliberately bounded one-shot callers such as meeting notes and automation compilation retain their own independent ceilings. Active plugin count, active tool-schema bytes, model-visible tool-result bytes, and replay payload bytes are not capped by the agent runtime. Web results, fetched bytes, and attachments remain independently bounded by their owning tools. Live context size comes only from OpenRouter's returned prompt and completion token counts; Rally does not estimate it from serialized bytes. After a completed provider turn exceeds 80% of the selected model's OpenRouter `context_length` (with Monad's 200,000-token fallback when the catalog is unavailable), Bind replaces the whole live context beneath the system prompt with one synthetic user message carrying an LLM continuation summary; no earlier message survives verbatim. Work-stream checkpoints store one principal-and-resource-inventory-revision-scoped summary regionally with the durable sequence boundary. The live checkpoint and every authorized replay append a freshly rendered, fixed-size resource inventory before newer messages; a scope mismatch falls back to durable transcript replay only within its 2,000-message and 4-MiB serialized preflight bounds. [`context-compaction.md`](context-compaction.md) owns that policy — the threshold, the summary prompt, the deterministic appendix, the checkpoint shape, and the stored row — and is the document to read and update before changing any of them.

A published document is readable in the desktop client, and was not until 2026-08-27. A generated resource appears in the work-stream rail under **Artifacts**, and its detail panel now renders the resource's readable content beneath the metadata, through `/resources/:id/preview` — the same authorized route `AttachmentLightbox` uses, which materializes extracted text for a file that is not already text. The gap that remains is narrower: the rail resolves an inspector target only from the loaded work stream's own resources, so a document cited from *another* work stream still has nowhere to open. [`markdown-rendering.md`](markdown-rendering.md) owns the citation half of this and records the same limit.

Per-tool time and the model catalog fetch use a **cancellable** deadline whose timer is cleared once the call it guarded returns. The Bind loop runs inside a long-lived `SubstreamAgent` operation, so an `AbortSignal.timeout()` left armed after a fast tool call retains dead timer work and can keep the isolate active after useful work ended. The rule and its incident are [`runbook.md`](runbook.md).

When OpenRouter refuses a call, the harness extracts the provider's own classification — code and provider name — from the error body. The provider's free-text message is never written to structured Workers Logs, the object-local operational inference ledger, or the Global inference lakehouse: some upstreams quote the rejected request back inside it, and a key-based redactor cannot recognise member content arriving inside a provider's prose. EU inference likewise does not retain it for later analysis.

Image attachments retain their exact original object for display and download. Before model admission, the regional Worker validates the byte signature and dimensions and writes a reusable bounded derivative to regional R2, referenced separately from D1. PNG, JPEG, WebP, HEIF/HEIC, and the primary TIFF path are normalized through Cloudflare Images; the TIFF fallback preflights dimensions before pixel decode, while HEIF has no whole-buffer local fallback. Animated GIFs become a single storyboard derivative with up to six representative timestamped frames plus bounded duration, frame-count, dimensions, and loop metadata. Only the derivative is placed in the model protocol transcript. Non-image message attachments contribute a compact manifest only; authorized attachment tools own every byte of text, Office, and PDF hydration.

The same derivative backs `workstream_view_resource`, including after replay or
compaction. A requested smaller long edge is an ephemeral scale-down and never
replaces the reusable object. Text derivatives may instead use an isolated
summary inference: filenames, focus text, and chunks stay in user-role data,
citations are checked against exact UTF-16 ranges, and derivatives over the
bounded reader budget report sampled partial coverage rather than claiming a
whole-file read.

Bounded callers use `run_wall_time_limit_exceeded`, `run_iteration_limit_exceeded`, `run_tool_call_limit_exceeded`, and `run_cost_limit_exceeded` when one of their explicit ceilings is reached. Those codes remain in the public failure contract so historical runs and bounded subsystems stay readable. A limit never silently reinterprets a write as successful.

When every route candidate answers with a transport fault the provider owns — no response, a 408, a 429, a 5xx, or a successful HTTP stream whose bounded provider error code is `unavailable`, `service_unavailable`, or a numeric 408/429/5xx — the run fails as `provider_unavailable`, kind `provider`, and not as `harness_execution_failed`. An OpenAI-compatible endpoint can accept the HTTP request and disclose an outage only in a later SSE error envelope. The two named machine codes classify as `server_error`; numeric codes reuse Bind's HTTP taxonomy but admit only timeout, rate-limit, and server-error categories. The same provider traversal and whole-plan retry rules then apply despite the successful surrounding status. Other statusless stream codes, including numeric request, credential, and credit failures, stay terminal because a blanket retry would hide the owner of the fault. When the circuit breaker had already opened and no request went out at all, the run fails as `provider_circuit_open`, kind `routing`: Bind's executor reports that as `no_viable_endpoints` carrying no error, and letting that emptiness fall through to the generic bucket reinstated the misattribution during exactly the minute an outage was worst — the first run in a workspace named accurately, every run behind it blamed on Rally. The two codes stay separate because the breaker opens on 401/402/403 as readily as on a 5xx, so a refusal cannot be attributed to the provider without knowing why it opened, which the breaker does not record. The distinction is the whole point of the code: `harness_execution_failed` means Rally’s own defect and gives a member no reason to try again, so filing an upstream outage under it sends whoever reads the failure to the wrong system. A 400 stays generic, because the request shape is ours; 401, 402, and 403 stay generic too, because the credential or the credit is ours. A refusal from the platform Rally runs *on* is neither: Cloudflare bounds how deep one request may recurse through Workers and how many subrequests one invocation may make, and enforces both by refusing whichever call asks next — a D1 read, a Durable Object hop, a fetch. That run fails as `platform_limit_exceeded`, kind `platform`, decided in `FatalHarnessPortError` from the platform's own wording rather than at the call site, because the port that happened to ask is in no position to know. Filing it under that port's code is not a naming quibble: on 2026-08-24 a work stream died reporting `tool_receipt_persistence_failed` when nothing about the receipt had failed, and the investigation started in the receipt authority. Bind's `isRetriableAttemptError` is the authority for the split, minus completion defects, which are the model answering badly rather than the provider failing to answer.

Before that failure is reached, the harness re-executes the **whole route plan** up to `transportRetries` times, which the work-stream host sets from `HARNESS_TRANSPORT_RETRIES` (declared as `1` in both regional Wrangler configs; `0` disables it, which is why it is read through `countEnv` rather than `numericEnv` — the latter rejects zero). The wait is a clamped backoff honouring `Retry-After` up to `TRANSPORT_RETRY_MAX_DELAY_MS`, and it is skipped entirely when the run's remaining wall clock cannot hold the wait plus a **worst-case replay of the whole plan** — every candidate, each able to spend its establishment timeout and then its time-to-first-token timeout, because the stream watchdog only opens once the response head lands. Reserving less lets a bounded caller's retry manufacture the deadline it defers to, and the outage is then reported as `run_wall_time_limit_exceeded`. Root work-stream runs set no wall clock and are unaffected. This is the host-side retry Bind's disposition matrix expects rather than a second guess at its ordering: the matrix answers a retriable transport fault by traversing to the next provider and then the fallback model, and gives it no same-endpoint budget, because with somewhere to traverse to there is no reason to wait. A plan with nowhere to go therefore had no recovery at all — and a work stream pinned from the developer-mode model selector is exactly that plan, since [`feature-flags.md`](feature-flags.md) has an override carry no fallbacks by design. The retry is skipped once output or an external effect has reached a surface that cannot be retracted, the same rule the executor applies to traversal. Each re-execution records another failure against the shared per-workspace circuit breaker, whose threshold is 3, which is why the budget is small by default: a larger one trades one run's recovery for opening the endpoint on every other run in the workspace. Each attempt appends to the owning execution object's `inference_attempts` ledger and emits its own lakehouse terminal record, so a retried turn is visible as more than one attempt sharing a `turn_id`.

A tool that throws reaches the model as a failed tool result. Where the thrown error carries a machine-readable half — a `code`, and `details` such as which identifier family was expected, that a connection must be reconnected, or which values were available — that half travels in the failure's `data` field, the slot declared for structured recovery context, so the remediation a tool attached is readable by the caller that has to act on it. Keys outside the result variant's own fields are discarded when the message is encoded, so this is not somewhere a caller may improvise.

When an executor throws a Zod error and its normalized arguments also fail the
provider-facing schema or its code-authored refinement, the model sees
`kind: "validation"`, at most five actionable issues from the closest union
branch, and no raw `invalid_union` tree. The message is capped at 1,200
characters and echoes no submitted *value*. It does name up to five rejected
**key** names on an `unrecognized_keys` issue, which is the one thing the model
wrote that comes back to it: "remove these fields" is not actionable without
them. Keep that in view when widening what the message carries, because a model
that authored a key can put content in the key. That bounded schema message is
the complete model recovery context for this branch; structured details from
the executor's thrown error are not forwarded because they may describe
downstream state rather than the rejected arguments. If those arguments pass
both forms, the Zod failure is downstream. A read or provider-idempotent write remains
`kind: "external"` and tells the model to retry once, then report invalid data.
A `record_before_execute` write instead becomes `ambiguous_external_write` and
terminates the run without retry guidance, because the provider may have applied
the mutation before its response failed validation.

The harness reads that half by shape through `readStructuredFailure` in `@rally/contracts`, rather than importing any provider package's error class. What it forwards is an allowlist — `reason`, `field`, `expected`, `available`, `resourceId`, `reconnectRequired`, `retryAfterMs`, `actualMimeType`, `attachmentKind`, and `suggestedCall` — under a total size bound, not whatever an adapter chose to attach. Several adapters already pass a whole parsed provider error body as their details, and forwarding those would put raw provider JSON into the transcript and from there into every later lossless inference request record. A connector wanting a new key in front of the model adds it here, where the decision is reviewable.

Hosted inference capture has one path for Global workspaces: the always-on Global lakehouse. It records exact request and terminal-attempt events through Global R2, Queue, Pipeline, and Data Catalog; the workspace preference, request-only `agent-inference/` writer, and regional D1 index no longer exist. EU inference analytics are intentionally deferred, so EU provider calls have no lakehouse archive or cross-region fallback. Capture remains best-effort and cannot fail an agent run. Reading a captured Global record back is [`runbook.md`](runbook.md#inspecting-a-runs-raw-inference).

Separately, Product analytics records a content-free `agent_tool_started` only
after the execution plan is durable and replay/ambiguity checks permit a new
invocation. It carries the canonical tool, plugin, capability, mode, run kind,
execution scope, and opaque work-stream/run/automation IDs. It never carries an
argument, output, summary, provider payload, or error. User-owned runs retain
person/workspace attribution; unattended workspace runs are grouped under a
personless workspace analytics identity. Failure to record telemetry never
changes tool execution.

When the durable invocation receipt reaches `completed`, `failed`, or
`ambiguous`, `agent_tool_terminal` adds only a bounded result, duration, and
replay flag to the same canonical identity. A root harness run likewise emits
`run_terminal` after its terminal commit with trigger, lifecycle result,
time-to-first-output, turn/tool/write-call buckets, model route, and fallback
state. Child runs are represented through their parent tool invocation rather
than counted as root outcomes. Prompt/message text, error JSON, arguments,
outputs, summaries, token content, and provider responses remain excluded.

## Testing

The suite table below is an inventory, not a claim that the ordered-transcript
PRD is fully proved. Its focused [test contract](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md#test-contract)
maps the persistent-loop, safe-boundary, exact-settlement, observable-failure,
recovery, range/hydration, authority, and renderer requirements to actual test
names. Every focused scenario now has a named implementation; exact-head CI and
the repository's deliberate-break practice remain the acceptance proof. This
documentation pass ran no suites and recorded no deliberate-break failure
proof.

| Suite | Covers |
| --- | --- |
| `apps/api/test/harness-run-runtime.test.ts` | Admission, the lease and its fencing, run-scope freezing, terminal commits, durable structured failures, successful/failure/stop receipt settlement across a mid-batch lease deadline, residual settlement on every terminal status and the marker-driven repair of a directly-failed root that lost its settlement response, healing an occupied checkpoint index, bulk residual-receipt settlement for stop/steering, descendant receipt settlement during child reaping, attachment dependency ordering, and dependency/replan interleavings. |
| `apps/api/test-workers/agent-run-dispatch-reliability.test.ts`, `agent-run-lifecycle.test.ts` | The real-workerd stable-loop state machine: singleton identity, pending-input FIFO and delivery mode, activation replay, alarm recovery after eviction, live-lease exclusion, expired-owner takeover, deferred retry on the same cycle and receipt, and exact execution fences through terminal settlement. |
| `apps/api/test-workers/message-to-output-pipeline.test.ts` | The real-workerd product-to-provider path, including provider-failure reservation settlement into a canonical error pill, a scheduled activation-only input on an already-initialized Bind projection, exact provider-body inclusion, pre-execution launch replay after eviction, and terminal replay without a second source fact, execution receipt, provider boundary, or inference attempt. |
| `apps/api/test-workers/substream-message-queue.test.ts` | The real-workerd multi-input queue, including proof that a deliberately blocked external settlement does not prevent the next queued input from reaching the provider and that the independent settlement lane subsequently drains. |
| `apps/api/test/agent-run-dispatch-queue.test.ts`, `apps/api/test-workers/durable-object-runtime.test.ts` | The separate HyperSight block dispatch ledger: durable wake derivation, reclaim ordering, and direct terminal settlement refusing an obsolete lease token without changing the successor's token, outcome, or stream checkpoint. It does not model SubstreamAgent execution. |
| `apps/api/test/harness-liveness-monitor-lifecycle.test.ts` | Heartbeats, expiry reaping, and the compare-and-swap that fails an abandoned attempt. |
| `apps/api/test/tool-transcript-durability.test.ts` | That a successful result is durable before Bind observes it, and that receipts replay. |
| `apps/api/test/core-tool-idempotency.test.ts` | Receipt identity, plan hashes, and the `ambiguous_external_write` path. |
| `apps/api/test/tool-usage-telemetry.test.ts`, `run-outcome-telemetry.test.ts` | Started/terminal tool and root-run outcomes, person/workspace attribution, replay/idempotency, bounded performance dimensions, and prohibited content. |
| `apps/api/test/bind-tool-failure-classification.test.ts` | The structured-failure allowlist and its size bound. |
| `apps/api/test/connector-tool-prose.test.ts`, `avalon-tool-prose.test.ts` | Every registry tool reaching a non-generic row, and no `write` described in passive words. |
| `apps/api/test/scoped-memory.test.ts` | The host-derived scope union, exact-ID conflict recovery, post-read revision races, and invalidation races, against a real `WorkspaceDO` standing in for the memory authority. `apps/api/test-workers/workspace-memory.test.ts` proves the object's transactional receipts, witnesses, and FTS triggers on real workerd. |
| `apps/api/test/message-run-context.test.ts` | Message-origin runs skip automatic long-term-memory recall while non-message runs retain their frozen admission context. |
| `apps/api/test/model-protocol-transcript.test.ts` | Historical tool-pair reconstruction, including sanitized structured failure recovery after resume. |
| `apps/api/test/workstream-transcript-storage.test.ts` | Atomic activation-input admission under the exact execution/Bind fence, full-provenance replay checks, pending-input suppression, ordered multi-input commits, idempotency across compaction, repair of a host reservation missing its Bind edge, and stop winning a steer-preparation race without consuming input. |
| `apps/api/test/digest-run-context.test.ts` | A scheduled digest's hidden brief becomes an explicit derived activation input with stable logical identity instead of disappearing on loop resume. |
| `apps/api/test/block-dashboard-submission.test.ts` | The single nudge, the `block_dashboard_block_not_submitted` failure, and the discarded trailing text. |
| `apps/api/test/workstream-wakeup.test.ts` | Both time forms, the bounds, idempotency, typed refusal codes and remediation, the pending sidebar marker, and claim-before-launch. |
| `apps/api/test/bind-host-durability.test.ts` | Host-only boundaries around activation persistence, ambiguous halts, and attachment grounding, including the validation-versus-content-failure distinction and post-start validation receipt reuse. |
| `apps/api/test/attachment-tool-receipts.test.ts` | Exact derivative and completed-output-reference dependency fencing, replay reauthorization, all-or-nothing multi-image registration, and successor-safe mismatch cleanup. |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` | The pending-wake-up clock appears only on marked work streams, with the next due time and bounded prompt in its tooltip. |
| `apps/api/test/agent-inference-logging.test.ts` | That no legacy D1/R2 path remains and provider refusals stay content-free in Workers Logs. |
| `apps/api/test/inference-lakehouse.test.ts` | Exact request/attempt archival, pointer integrity, Pipeline delivery, and oversized-record preservation. |
| `packages/db/test/agent-inference-retirement-migration.test.ts` | Migration 0094 removes the regional payload-log table and workspace preference while preserving workspace rows and foreign-key integrity. |
| `packages/agent-harness/src/*.test.ts` | Persistent-loop projection and activation boundaries, including resumed-history preservation, empty system activations, takeover replay, and fail-closed ordering before model-catalog or inference I/O; plus prompt golden hashes, skill bounds, `toolActivityName`, transport retry/fallback behavior, and the automation compiler submission loop. |

Run one with
`pnpm --filter @rally/api exec vitest run test/harness-run-runtime.test.ts` — the
path is package-relative.

Five traps. The prompts are byte-stable and golden-hashed, so an edit fails the
hash assertion by design — update it deliberately rather than regenerating it.
Anything that leases or heartbeats compares against `Date.now()`, so stub the clock
and assert on the stored attempt and expiry rather than on elapsed time. The
harness package's portability boundary is enforced by ESLint, not by the type
checker: a test that imports a database or Node-only module to build a fixture will
pass locally and fail `pnpm lint`.

**A memory-scope fixture can enforce rules production dropped.**
`scoped-memory.test.ts` used to build its memory tables on
`preRetirementProductSqliteDatabase()`, whose through-0089 snapshot still carried
migration 0036's four owner-validation triggers — constraints no deployed
database has — so neutering a scope condition failed a test on
`memory_scope_workstream_owner_invalid` rather than on the union the test
asserts, and the fixture had to drop them by hand. Since memory moved behind
typed WorkspaceDO methods the suite stands up the real object with
`createTestWorkspaceDO`, whose schema is the object's own migration ledger, and
the snapshot serves only identity and membership. Anything that reaches
`memory_scopes` through another fixture still owes this check: a stand-in schema
must not enforce rules the code under test is now solely responsible for.

And **the route circuit breaker is module-scoped**, keyed by provider, model,
credential source, and workspace. A test that deliberately fails one endpoint
three times opens it for every test that runs afterwards under the same
`workspaceId`, which then receive `no_viable_endpoints` — a failure carrying no
attempt error at all — in file order. Give any such test its own `workspaceId`;
the transport-retry tests do, and one of them depends on a sibling having opened
the breaker first, which is stated in the test rather than left to be inferred.
Nothing pins `breakerScope`, so deleting that one property from `routePlan` would
silently return every test to the shared key while each still passes alone.

## Changelog

### 2026-09-01 — Stream-declared provider outages traverse the route

**What changed:** The shared provider-failure classifier now treats the bounded
SSE error codes `unavailable` and `service_unavailable` as `server_error` when
an OpenAI-compatible endpoint already returned HTTP 200. OpenRouter's numeric
stream codes reuse Bind's HTTP taxonomy, with only 408, 429, and 5xx admitted as
transient. With no observable output, Bind can traverse from Azure to OpenRouter
and use the existing whole-plan transport retry; if every route is exhausted,
the member sees `provider_unavailable` instead of `harness_execution_failed`.

**Why:** A production Azure Grok 4.6 request accepted the HTTP stream and then
emitted `error.code = unavailable` before any model output. The error carried no
HTTP status, so the classifier reduced it to the generic `api` kind. Bind
correctly treated that as a terminal client error, which prevented the
same-model OpenRouter route from running and blamed Rally's harness for an
upstream availability failure.

**Considered and rejected:** classifying every statusless stream error as a
provider outage. The same envelope can report a bad model, request, credential,
or policy decision; retrying those errors would conceal an actionable defect.
Provider prose also remains excluded because it can echo member content. New
named transient codes must be added to the bounded allowlist with provider
evidence and a traversal test. Numeric 4xx codes outside 408 and 429 remain
terminal. Bind's existing produced-output fence remains the authority that
prevents replay after a partial answer.
### 2026-09-01 — Message admission and independent settlement close their cancellation gaps

**What changed:** An admitted room socket now uses its existing transport
authority instead of repeating the standalone D1 membership query. Pending
message activation treats its immediate alarm write as best effort because the
reservation pre-arms cancellation recovery. External settlement claims each
terminal receipt through its durable due time before awaiting delivery, and an
expired claim lets an alarm replace a cancelled in-memory drain. Fresh outcomes
also carry their run metrics into that independent lane. Elicitation delivery
now reads the question by run ID, including after the question was answered.

**Why:** The direct message path still paid an authority lookup the live socket
had already established, and a failed eager wake-up reported a committed message
as failed. Separately, runtime cancellation could leave the settlement drain's
promise marked active forever, while its alarm scheduling treated that promise
as evidence of life. Moving settlement out of the inference lane also exposed
that its durable recovery projection does not contain transient metrics or the
identity of the run's elicitation question.

**Considered and rejected:** A client timeout would only hide an uncorrelated
server response and guess a new defensive limit. A new settlement table or
Queue would duplicate the terminal receipt. The socket exception is deliberately
limited to message commands on an admitted room connection; product RPC still
revalidates D1 membership, and revocation remains responsible for closing live
sockets.

**Consequences:** Every recognizable message command with a valid client ID must
receive a correlated terminal receipt. Settlement work must claim before its
first await, remain idempotent under recovery, and leave its durable due time in
the shared alarm candidates. Transient terminal fields must be consumed before
the first cancellable continuation.

### 2026-09-01 — External settlement no longer reserves the inference loop

**What changed:** A terminal run releases the persistent loop after its
canonical terminal commit. Slack/digest/automation delivery and name/description
maintenance drain independently from `external_settled_at`, with an eager
`waitUntil` attempt and alarm recovery. The lane preserves terminal-run order;
its retry deadline is no longer an executable-loop deadline.

**Why:** The previous drain awaited every external and cosmetic continuation
before it promoted the next queued message. A slow connector, classification,
name generation, or description refresh therefore became time-to-inference even
though the transcript and Bind state required by the next run were already
durable.

**Considered and rejected:** Dropping settlement or making it fire-and-forget
would lose delivery after eviction. Running later settlements around a failed
older one would make external destinations observe results out of order. The
existing durable receipt already provides both recovery and ordering, so a new
Queue or table would duplicate authority.

**Consequences:** External delivery can trail later in-app inference. Its lane
must remain idempotent and ordered, and every mutation of its due time must keep
the shared object alarm armed. Only canonical terminalization and loop fencing
may gate promotion of the next queued input.

### 2026-09-01 — Message runs leave automatic long-term-memory recall off their critical path

**What changed:** Opening and follow-up composer messages, elicitation answers,
non-automation inbound email, and Slack opening, follow-up, and elicitation messages no longer
call `freezeRunMemoryContext` before the first model request. Their immutable run
scope records a null memory-context hash. The `rally_memory` plugin and explicit
`memory_search` tool are unchanged. Non-message runs and automation executions
retain automatic frozen admission recall even when an automation's trigger
reason is also `inbound_email`.

**Why:** Production traces for three ordinary composer messages showed the
fixed Qwen query embedding taking 8.46–8.83 seconds before main inference, while
the vector leg failed, FTS recalled no items, and the run continued without any
memory context. A message already has its immediate context in the durable
transcript, so this speculative lookup should not delay every reply.

**Considered and rejected:** adding a timeout or a shorter guessed budget still
keeps a provider call on the message path and would introduce a defensive limit
the team has not chosen. Starting recall asynchronously cannot add a result to
an inference request that has already begun, and conditionally restarting the
request would make first-turn behavior nondeterministic. Removing the memory
plugin entirely would also remove deliberate, task-specific recall; this change
removes only the automatic admission lookup.

**What a future change has to respect:** a new human-message ingress must join
the no-admission-recall set. If automatic recall is reintroduced for messages,
it needs evidence that its result value outweighs its provider latency and a
failure path that does not silently pay for an unusable vector result.

### 2026-09-01 — The standing policy gains a site trigger; the craft goes to a skill

**What changed:** `DOCUMENT_GENERATION_POLICY` gained a `# Sites` section, and
`building-live-sites` joined the built-in skills with `ownerPlugin:
"rally:terminal"`.

**Why:** A site-shaped request has the same shape as a document-shaped one —
write files, publish, announce, revise the same path — so the trigger belongs
beside the document trigger rather than in a second mechanism. What does *not*
belong there is how to build one: the entry-file rule, the handler shape, the
storage class, the viewer headers and the polling manners run to hundreds of
lines, and the standing policy is charged to every interactive run in a
Terminal-supported region.

The byte-budget test is why the section is two paragraphs rather than the nine
bullets it was first written as, and why the bound moved. The first draft put
the layout rules and the entry-name warnings inline and pushed the prompt to
8,735 bytes against an 8,000 ceiling — exactly the prose creep that bound
exists to catch, and moving that material into the skill is what the comment
beside the ceiling asks for. What the trim could not cover is that the
`2026-08-31` change above made this policy standing rather than gated and
rewrote `# Documents` into prose, leaving about 175 bytes of headroom — less
than a second section needs to name itself, name its skill, and give its one
most-missed rule. So the bound is 8,500, raised deliberately rather than
absorbed, and the comment beside it names the sentence in `# Documents` that
now says twice what the two paragraphs after it say once. Trimming somebody
else'"'"'s freshly-landed policy to make room for this one is a decision for
whoever owns that prose, not a silent edit.

**Considered and rejected:** a second standing policy module for sites. It would
have doubled the gating condition and the announcement rules for a trigger that
differs from the document one by a noun.

### 2026-08-31 — Built-in plugin authorization is derived from registration

**What changed:** `isLoadableBuiltinHarnessPlugin` now reads a
`builtinPluginIds` set derived where the built-ins are registered, replacing a
hand-maintained literal of three plugin IDs. `builtinPluginAuthorization` and the
`beforeToolCall` scope check read that one derivation in both the root run and
the inline child surface; the root's activation persistence and
`resolveHarnessToolReceiptPolicy` read it too. The child's activation
persistence is not a consumer: it guards on its own `childPluginSurfaceHashes`
entry instead, and is unchanged. Two tests assert the invariant over the
registered surface rather than a repeated list: every registered non-connector
plugin authorizes for activation while an unregistered built-in id and an
invented one are denied, and the child's set stays narrower than the parent's.

**Why:** The literal list was a second, unlinked statement of which built-ins
exist. `rally:multimodal-generation` shipped absent from it, so image, image-edit
and speech generation registered, entered the plugin catalog, were found by
`search_plugins` — and had every `load_plugin` denied as
`plugin_not_authorized`. Because that verdict's guidance is written for
credential connectors, runs told users to have a workspace owner restore a
connection that does not exist, and fell back to hand-drawn SVG. Nothing failed
at startup, no test covered the list's contents, and the defect was only
reachable in production. Deriving the set makes registering a built-in and
authorizing it the same edit.

**Considered and rejected:** Adding the one missing ID and keeping the literal.
That fixes this instance and leaves the trap armed for the next built-in, with
the same silent, production-only failure. Also rejected: removing the classifier
altogether — its `resolveHarnessToolReceiptPolicy` use is a branch that mints the built-in
receipt identity (`connectionId: null` plus the surface hash), so deleting it
sends every built-in into the connector arm and throws
`Connector identity is outside this run scope`, breaking web, workstream and
Terminal to unblock multimodal.

**Consequences:** A built-in plugin's eligibility is now exactly its
registration, which is where the conditions already live — the Azure inference
pair, `FIRECRAWL_API_KEY`, Terminal's provider configuration. Registering a new
built-in therefore grants it run-scope authority with no second list to update,
so the registration site is the review point for that authority, and the
conditional-registration branches are load-bearing: a built-in that registers
unconditionally and fails inside its tool calls would advertise a capability the
discovery prompt promises is available.

Shipped in the pull request for this change.

### 2026-08-30 — The multimodal plugin creates replay-safe speech resources

**What changed:** `rally_multimodal_generation` now advertises a third Bind
write, `generate_audio`. It calls the main Azure `gpt-4o-mini-tts` deployment,
MIME-verifies and bounds one MP3 response, and publishes it under the durable
effect identity. Desktop current-resource and version previews render native
audio controls; the tool result and plugin system message carry the AI-voice
disclosure because the same player also serves user-uploaded audio.

**Why:** Generated speech needs the same plugin activation, receipt, timeout,
regional storage and resource ownership as generated images. Keeping it in the
existing multimodal plugin avoids a parallel lifecycle for one media subtype.

**Considered and rejected:** Injecting generated audio into the following model
turn. The output is for the person to play, not evidence the model needs to
reconsume. Also rejected: a guessed charge when Azure returns no usage and the
shared OpenRouter cache has no endpoint price for this model.

**Consequences:** Audio generation is available anywhere the main Azure
credential pair already enables multimodal generation. Its receipt and metadata
must not persist the source text or instructions, and no billing entry is
created without provider usage and a valid shared price.

### 2026-08-30 — A dedicated plugin generates and edits durable images

**What changed:** Runs with main Azure inference credentials now advertise the
deferred `rally_multimodal_generation` plugin. Its initial two Bind tools call Azure's
`gpt-image-2` image endpoints, return an ephemeral image part to the current
turn. Generation publishes one durable generated resource under a
receipt-derived identity; editing publishes a new version of the selected image
resource under the same resource ID. Tool timeouts are fixed at five minutes.

**Why:** The agent needs a native image capability that participates in Bind's
plugin discovery, receipt policy, and workstream resource ownership. Reusing a
chat-model route or Terminal would either misstate the provider API or make a
first-class product operation depend on a sandbox.

**Considered and rejected:** Preloading the plugin on every run; generation is
specialized and its instructions and tools need not consume every model turn.
Also rejected: failing closed on a missing cached price, because an
observability/cache failure should not deny the requested image. The no-price
case is logged and left uncharged.

**Consequences:** The plugin is absent without the main Azure credential pair.
West remains future fallback infrastructure and is not selected implicitly.
The durable receipt stores JSON only; a later turn views the attached resource
instead of replaying provider bytes.

### 2026-08-30 — Bound Grok models use Bind's Azure-first provider route

**What changed:** Work-stream and inline-child turns whose canonical model is
`x-ai/grok-4.3` or `x-ai/grok-4.6` now give Bind an Azure candidate followed by
the existing OpenRouter candidate for that same model. Rally supplies the
deployment binding and provider-specific wire adapter; Bind owns policy
resolution, capability skips, route construction, breaker admission, traversal,
failure disposition, and configured-rate cost arithmetic. A dedicated optional
Azure inference endpoint/key pair enables the transport without changing model
flags. Provider invocation names remain separate from canonical model identity
in the inference ledger. The host resolves an unweighted average of all
OpenRouter endpoints for each bound Grok model and gives those rates to Bind.
One public-metadata record per canonical OpenRouter model ID is cached in a
Cloudflare KV namespace shared by the Global and EU Workers. A dedicated Global
cron refreshes the developer-selector and Azure-deployment union hourly; base
and prompt-threshold override costs remain decimal strings in KV and are
converted only at Bind's billing boundary. Startup now validates the Azure
endpoint against the same exact contract used by the transport, and turns whose
primary and fallback models are all OpenRouter-only do not read pricing KV.

**Why:** Monad production carries Global Standard version-1 deployments for
both Grok models, while Rally sent every agent turn through OpenRouter even though its
Bind version already had a multi-provider route executor. Using the same-model
Azure endpoint first gives Rally that deployment's capacity and commercial path
without turning a provider choice into a product model change. The change also
had to preserve cost ceilings: Azure returns usage rather than dollars, and
Grok's cached count is disjoint from `prompt_tokens` while reasoning is separate
from `completion_tokens`, so ordinary subset billing would either undercount or
reject a valid response. When Azure omits dollars, both bindings use the most
recent valid average of OpenRouter endpoint rates, including the 200,000-token
long-context override rather than silently billing a large request at the base
rate. Using the catalog's cheapest
headline price was rejected because it would systematically understate the
intended market-average fallback. Keeping those rates as dated source constants
was also rejected because endpoint inventory changes independently of a Rally
release.

**Considered and rejected:** Encoding Azure as another fallback model. That
would lose the difference between the product model and its provider endpoint,
mislabel same-model traversal in telemetry, and bypass Bind's capability and
circuit-breaker semantics. Reusing the realtime-dictation Azure variables was
also rejected: those are regional and may be configured in EU, while the Monad
production inference resource is a distinct routing authority. A missing Azure
pair therefore omits that provider and leaves the existing OpenRouter route
unchanged.

**Consequences:** A new Azure model needs a checked-in canonical-to-deployment
binding with proved capabilities and a canonical OpenRouter identity in the
Azure pricing inventory. The cron fetches every inventoried model before it
writes any of them; stale valid per-model KV is a deliberate availability
fallback, while no valid price omits Azure instead of treating a request as
free. KV is eventually consistent, which is acceptable for public hourly
pricing metadata and must not be extended to workspace state. Do not make
the Azure client carry OpenRouter Broadcast fields or plugins. Keep turn
requirements accurate: an Azure candidate that cannot serve a file parser,
input modality, reasoning control, or tool surface must be skipped before I/O.
Missing final Azure usage is a failed attempt, never a free one. Provider
ordering remains policy, so changing Azure-first behavior belongs in the route
registry rather than in request code.
### 2026-08-30 — Document generation is standing policy, not a gated section

**What changed:** `DOCUMENT_GENERATION_POLICY` moves into the work-stream
`SYSTEM_PROMPT` alongside the other standing sections. `documentPublishing` and
`runPublishesDocuments` are gone — every work-stream run sees `# Documents`,
including automations, digests, inbound email, Slack-origin, HyperSight blocks,
and regions without Terminal. The host-side gate tests go with them. A typed
output surface now follows the standing rule: external deliveries require the
complete usable body in the final message, and HyperSight blocks require
finished Markdown through the block submission tool instead of a document.

**Why:** The section already told the model what to do when the sandbox cannot
be reached ("answer in the chat and inform the user"). A host gate that omitted
the section for delivery-path and unsupported-region runs was solving the same
problem a second time, and the wrong resolution of an absent rule — promising a
document that never appears — was exactly what the gate existed to prevent. One
standing rule with an explicit fallback is cheaper to reason about than a
conditional render whose absence itself needed reasoning.

**Considered and rejected:** Restoring a host gate for delivery and HyperSight
runs — rejected because absence makes the platform rule depend on every caller
remembering the exclusion. A standing rule followed by an explicit,
surface-specific tie-break keeps one default while stating the actual output
contract where it differs.

**Consequences:** The work-stream golden hash moves. The standing prompt now
always pays for the documents section; the 8,000-byte ceiling in
`prompts.test.ts` is the bound that matters. Output-surface derivation is part of
run-context assembly and must cover any new external delivery origin. Prompt
assembly joins optional sections without blank tombstones, while preserving
blank lines inside authorized task data.

### 2026-08-29 — External delivery reads the exact saved terminal turn

**What changed:** Work-stream terminal side effects reload `finalTurnId`
directly from the canonical transcript instead of fetching the latest 250
messages and searching them. For `needs_input`, they reload the oldest open
elicitation through its canonical transcript turn so the saved structured
prompt remains actionable externally. The shared transcript-turn schema now
accepts the durable loop's structured assistant IDs. When no saved turn exists,
connector status and suppressed automation receipts settle but no external
result body is synthesized. A named-but-missing turn leaves a durable diagnostic
without putting status cleanup behind an endless retry.

**Why:** A completed assistant turn was durable under its stable structured ID,
but generic message hydration still required a UUID. Settlement retried before
Slack delivery on every attempt. The bounded recent-message search also made
external delivery depend on transcript length instead of the terminal fact it
was given.

**What was rejected:** Generating fallback failure/completion prose inside the
delivery layer, or searching a wider transcript page. The first publishes text
that is not canonical; the second remains a page-size-dependent lookup for an
exact key.

**What a future change has to respect:** External adapters project a hydrated
canonical turn and nothing else. A new Teams, Linear, or other conversational
delivery branch belongs after saved-turn hydration, never on the live
stream/checkpoint path.

### 2026-08-29 — Automation authoring preserves connector tool deadlines

**What changed:** The automation creator's connector catalog now carries each
tool's optional `timeoutMs` from API discovery into the executable `HarnessTool`
that Bind receives.

**Why:** The ordinary work-stream path already honored Granola's five-minute
`query_granola_meetings` deadline, but automation authoring copied only the
tool's schema and safety fields into its intermediate catalog. Reconstructing
the tool without the deadline silently restored the shared 30-second default,
so the same provider query still failed in one supported invocation path.

**What was rejected:** Special-casing Granola inside the automation compiler.
The deadline is part of the trusted `ToolDefinition` selected by the connector;
every catalog projection must preserve that contract regardless of provider.

**What a future change has to respect:** Any intermediate representation that
reconstructs an executable tool must carry execution policy fields as well as
model-visible schema. Omitting an optional field is a behavioral change even
when the model-facing catalog looks identical. Bind still combines each tool
deadline with its caller's parent signal: preserving a five-minute tool value
does not widen automation compilation's independent 180-second run ceiling.

### 2026-08-29 — `runHarness` imports the Bind runtime statically

**What changed:** `runHarness` in `packages/agent-harness/src/index.ts` calls
`runHarnessWithBind` through a static import instead of
`await import("./bind-runtime")`.

**Why:** the dynamic form never settled under
`@cloudflare/vitest-pool-workers`. The import promise stayed pending past 36
seconds while a 2-second timer kept firing in the same isolate — so the isolate
was alive and the module load simply never completed, rather than being slow.
Every workers test that let a run reach inference therefore hung inside
`runHarness` and failed as a timeout on some later, unrelated assertion. That
made the whole class of run-completing tests impossible to write, which is what
`participant-notification.test.ts` ran into.

**What was rejected:** leaving the dynamic form and warming the module from the
test. There is no exported path to `bind-runtime` to warm, and it would have
left the same trap armed for the next person.

**Why the lazy form existed is not recorded.** The line arrives with the
repository's initial import and carries no rationale, and no comment, commit
message, or document explains it. The plausible reason is the Workers startup
CPU budget — `bind-runtime` is large, and a dynamic import defers evaluating it
until a run actually needs it. That is a guess and is written here as one. **A
change that needs the lazy form back must establish its reason afresh** and
verify it against this failure, rather than restoring it on the strength of this
note.

**What a future change has to respect:** `bind-runtime` imports seven runtime
values back from `index` (`OpenRouterClient`, `OpenRouterError`,
`HarnessPluginActivationError`, `canonicalToolInputHash`,
`modelMessageWithoutProvenance`, `AVALON_DISCOVERY_PLUGIN_ID`,
`AVALON_DISCOVERY_TOOL_DEFINITIONS`), so the two modules are now a static cycle.
It is sound only because all seven are read inside function bodies rather than
at module top level. Moving any of them into top-level initialization on either
side breaks the cycle at load time.

### 2026-08-29 — Workspace memory becomes typed WorkspaceDO methods, and the retired automation union fails by name

**What changed:** Every statement the memory services ran against the
memory-owned tables — `memory_scopes`, `memory_items`, `memory_items_fts`,
`memory_mutations`, `memory_index_outbox`, and the six `memory_table*` tables —
left the workspace runtime facade and became typed WorkspaceDO methods
(`workspace-memory-protocol.ts` / `workspace-memory-storage.ts`). Each mutation
now decides its receipt replay, compare-and-set, audit record, and outbox
intent inside one `transactionSync`, refuses with a discriminated outcome
rather than a thrown SQL error, and judges its CAS by a `RETURNING` witness
rather than a write counter. Two failure modes ceased to exist with the D1
batches that produced them: `memory_table_insert_contention` (the insert's
bounded retry loop around its own revision counter) and
`memory_table_query_changed_during_read` (the row page and the revision
re-check were separate round trips). The embedding-outbox processor claims,
completes, and retries through the same typed methods; running inside
WorkspaceDO's own alarm it resolves to the registered instance rather than an
RPC to itself. `resolveMemoryAccess`'s automation branch no longer reads
`automation_subscriptions` — it throws `memory_automation_scope_retired` after
the work-stream mismatch check — and the automation memory-table materializers
(`buildAutomationMemoryTableStatements`, `ensureAutomationMemoryTables`,
`loadAutomationMemoryTableContext`) were deleted. The converted tables joined
`WORKSPACE_TYPED_RPC_ONLY_TABLES`, all except `memory_index_outbox`, whose due
time the schedule's alarm-target derivation still reads generically inside the
object.

**Why:** The facade classifies each statement by the table names it mentions
and sends anything it does not recognise to the regional database, which is the
defect class that took automation run work streams down in production
(`no such table: automation_directory`). The memory domain was carrying a live
instance of it: the 2026-08-28 automation cutover dropped
`automation_subscriptions` from every migrated WorkspaceDO while the facade
still routes that name there, so both the automation branch of
`resolveMemoryAccess` and the memory-table materializers would have answered
`no such table: automation_subscriptions` had anything reached them. Nothing
does — automation runs route memory through `AutomationAgent`, and a
subscription-declaring input without frozen context is stopped by name in
`loadRunPromptContext` — but the honest fix for an unreachable branch reading a
dropped table is a named refusal, and for materializers with no callers since
the cutover, deletion.

**Considered and rejected:** Converting the automation branch and the
materializers to typed methods — the rows they read and join no longer exist in
any store this service can reach, so a faithful conversion would have encoded a
query that can never answer. Also rejected: chunking caller-sized `IN (…)`
lists into runs of 90 to stay under object SQLite's 100-bound-parameter
refusal; every id list binds as a single JSON parameter expanded with
`json_each` instead, which removes the ceiling rather than budgeting for it.

**What a future change has to respect:** WorkspaceDO's memory rows are
reachable only through the typed methods — the generic SQL port refuses the
tables by name, with `memory_index_outbox` as the one deliberate exception —
and a memory mutation's replay decision must stay inside the same transaction
as its write, answered as an outcome with a returned witness, never derived
from `rowsWritten` or reconstructed from a constraint violation after a lost
race.

A typed write that leaves an embedding intent must also arm the alarm that
projects it. `memory_index_outbox` is on `WORKSPACE_ALARM_SOURCE_TABLES`, and
while these writes were generic statements `executeRuntimeSql` re-derived the
schedule for them; the first cut of this conversion dropped that, which would
have left a memory written into a quiet workspace unprojected until an
unrelated mutation happened to reconcile. `addMemoryItem`, `updateMemoryItem`
and `invalidateMemoryItem` now call `refreshScheduleAfterMemoryOutboxWrite`,
gated on an outcome that actually wrote a row — a replay or a refusal left no
intent. The outbox claim, completion and retry methods deliberately do not:
their only caller is `processMemoryIndexOutbox`, reached only as the
`memory_index` maintenance target, which runs inside the object's own alarm
drain, whose statements go through the local executor and never carried the
auto-refresh either. A reconcile started there would race the drain's own
end-of-drain `schedule_reconcile` with a stale target list.

### 2026-08-28 — A second host runs the compiler, and a semantic refinement has to be in the executor

**What changed:** `AutomationAgent` runs `compileAutomation` from its own
Durable Object, supplying a draft-mutation port for the three architect tools —
`automation_set_evaluator_rules`, `automation_submit_draft`, and
`core_request_elicitation` — which write into that object's SQLite behind
tool-call-keyed receipts. Connector read executors are installed; no provider
write executor is. Separately, `automation_set_evaluator_rules` now runs its
cross-field evaluator check **inside its executor** and points `validateInput` at
the same function, and each of that check's issue messages was rewritten from a
bare code into a sentence naming the shortest next call.

**Why:** The authoring loop needed the same durability and recovery guarantees as
a work stream without inheriting child-run identity, participants, or
work-stream controls, and the harness is already the thing that provides them.
The `validateInput` half is a defect this host found: the runtime consults
`validateInput` only *after* an executor has thrown a `ZodError`, so a semantic
refinement that lived only in the hook never ran at all — the rule reached
durable storage unchecked, and the hook's whole purpose, turning an external
fault into a named field, was silently inverted. `automation_plugin_not_inspected`
was also not an instruction: a small model reading it has no way to know the
answer is to call `automation_plugin_inspect` and set the rules again.

**Considered and rejected:** Leaving the check in `validateInput` alone and
relying on it being consulted, which is what shipped and did not work. Making
the harness call `validateInput` before every executor, which would move a
per-tool contract into the runtime for every tool that does not need it and
change the meaning of a hook other tools already declare.

**Consequences:** Changes to shared loop semantics need conformance coverage in
both hosts, and `BlockDashboardAgent` remains independent. The rule for any tool
whose executor parses more strictly than its advertised schema is now sharper
than the 2026-08-25 entry below states: `validateInput` is the *reporting* path,
not the enforcement one. **A refinement that must not be bypassed belongs in the
executor**, with `validateInput` pointing at the same function so the two cannot
drift.

### 2026-08-28 — The harness serves one persistent loop per substream

**What changed:** The workflow host executes activations of one persistent
substream loop instead of minting a loop per message: activation admits inputs
through durable receipts, assistant turns reserve their canonical transcript
position before provider I/O, tool results and step settlement commit through
the loop's fenced transition port, and resume reconstructs the existing Bind
head instead of initializing a new history. One landing (#378, the ordered
work-stream transcript PRD); the facets below each carry their own rejected
alternative and invariant.

**Why:** Per-message loop identity let independent activations compete for
conversation order, and positions allocated after asynchronous work could
invert the order a member had already seen.

Shipped in [#378](https://github.com/juno-ai-labs/avalon/pull/378) and implements
the [ordered work-stream transcript PRD](PRDs/2026-08-26_ordered-workstream-turn-transcripts/prd.md).


#### Active stream recovery retains its canonical reservation

**What changed:** Workstream active-output checkpoints now persist and reload
the assistant turn's reserved transcript sequence. The forward migration clears
only the old transient checkpoint projection before adding the required field;
canonical transcript turns and execution receipts are untouched.

**Why:** In-memory streaming carried the reservation, but the SQLite checkpoint
dropped it. A wake-up therefore could not validate the checkpoint contract and
silently returned no active output even though its chunks were durable.

**Considered and rejected:** Inferring a sequence from the turn ID or rebuilding
old checkpoints. The reservation is allocated before provider I/O and is the
only ordering authority; active output is disposable recovery state, so an old
row with no reservation has no safe compatibility value.

**Consequences:** Hibernation recovery preserves the same transcript position
as the live stream. Realtime terminal frames still clear transient output only;
the fenced harness outcome owns execution-receipt and singleton-loop finality.

#### Activation lands before provider-shape validation

**What changed:** A resumed loop now commits its fenced activation inputs before
validating the exact provider message array. A deliberately tolerated empty
completion settles its assistant reservation as failed and is not appended to
Bind; an explicit protocol reminder can then continue the same bounded loop.

**Why:** A valid idle projection ends in its previously accepted assistant turn.
Validating that projection before appending the new activation made Bind add a
synthetic continuation and the harness correctly rejected the mutation, so the
real wake-up input could never reach the provider. Separately, accepting an
empty assistant before appending the automation compiler's reminder made the
next validation drop that empty row and fail the compiler as a persistence
error. Both failures came from validating an intermediate shape that should
never have crossed the provider boundary.

**Considered and rejected:** Allowing Bind's healer to mutate the durable
projection. That would replace host-owned protocol facts with provider-shaping
guesses and could hide incomplete tool recovery. Recreating the loop for each
activation would discard the persistent identity and history this module owns.

**Consequences:** Every real resumed execution needs a durable stimulus: a
pending participant input or an activation input with stable provenance. An
execution with neither has nothing new to infer from and must not rely on a
synthetic `Continue`. Provider-shape healing remains fail-closed after the
activation boundary, and an empty tolerated compiler turn consumes a model-turn
identity without creating a model message.

Implements the forward persistent-loop path in
[#378](https://github.com/juno-ai-labs/avalon/pull/378).

#### The harness test inventory points to the focused product contract

**What changed:** The harness testing section now points to the ordered-
transcript PRD's focused objective/scenario mapping. It names the actual tests
that prove persistent loop identity, safe control boundaries, exact protocol
settlement, observable-failure behavior, and semantic interleaving through the
real workerd product pipeline.

**Why:** The previous 94-case audit corrected nonexistent filenames but then
treated compatibility migration, fleet operations, provider matrices,
benchmarks, and exhaustive faults as product blockers. Rally is shipping a
forward-only persistent-loop contract; its tests should make that behavior
clear without creating unrelated systems.

**Considered and rejected:** Keeping the exhaustive catalog because it looked
more rigorous. It hid the original semantic-ordering and observable-failure E2E
gaps among requirements the approved product does not have.

**Consequences:** A scenario is covered only by a named behavioral assertion at
the correct layer. Manifest hydration and the two original product-path gaps now
have SQL, real-workerd, harness, and Desktop implementations. Exact-head CI and
the deliberate-break practice in `docs/testing.md` are still required, but no
checked-in mutation matrix or operator artifact is required.


#### The host closes interrupted tool batches before Bind resumes

**What changed:** SubstreamAgent now reconciles every missing result after an
accepted assistant tool batch from durable effect receipts. It records explicit
`not_run` and ambiguous results, commits participant lifecycle and Bind state
together, and closes recovered assistant activity intervals as upper bounds.

**Why:** An isolate could disappear after accepting the assistant and only a
prefix of parallel tool results. Bind correctly refused the dangling protocol,
but the host had no recovery step, so the persistent loop could never reach its
next provider boundary.

**Considered and rejected:** Letting Bind synthesize results or retrying the
whole batch. Bind cannot know whether external effects ran, and replaying an
executing write would violate the no-transparent-retry rule.

**Consequences:** Recovery is conservative and receipt-derived. It can continue
after completed, failed, and definitely unstarted calls; any possibly completed
write ends the current cycle visibly after the durable protocol is settled.

#### Elicitation answers close their withheld Bind tool slot

**What changed:** Every durable elicitation records its stable original tool-call
slot. Answer delivery accepts the missing `tool_result_accepted` transition and
promotes the canonical participant response in one commit without adding a
second Bind user message. Tool transitions now distinguish the
original call index from the dense ordinal in which results became durable.

**Why:** The persistent loop previously tried to append an elicitation answer as
a user message while its assistant tool call was still open, so the Bind
projector correctly refused the answer and the loop could not resume. A withheld
first outcome also passed its sparse batch index as result order, conflating two
identities as soon as a later tool result was accepted.

**Considered and rejected:** Healing the message array when the next provider
request is built. That would make provider projection a second authority and
leave crash recovery unable to prove whether the answer had closed the tool.

**Consequences:** Provider I/O remains blocked until the tool transition and UI
promotion are durable. A crash sees either the unanswered pending input or the
complete tool result plus participant turn, never a canonical response beyond
an open call and never two model-facing copies of one answer.

#### Protocol nudges and Bind hashes are environment-independent

**What changed:** Tool-less continuation nudges are persisted with protocol
provenance and no source identity. Bind canonical JSON orders object keys by
specified UTF-16 code units rather than runtime locale collation.

**Why:** A harness-created nudge has no durable participant or event source, so
assigning a synthetic derived identity contradicted the transcript protocol.
Locale collation can change across ICU builds and therefore cannot define the
bytes fenced immediately before provider I/O.

**Considered and rejected:** Keeping a generated nudge source ID or pinning a
locale. The former invents a second authority; the latter still delegates a
hash invariant to mutable collation data.

**Consequences:** Nudge replay matches the PRD's protocol-only category, and
equal Bind projections hash identically across supported runtimes regardless
of their configured locale data.

#### Harness state crosses object boundaries only as typed operations

**What changed:** The SubstreamAgent runtime SQL endpoint and D1-shaped table
router are removed. Run admission, attempt leases, inference accounting, tool
receipts, telemetry, memory access, and development fixtures call typed storage
operations against the object that owns them. The final run/inference/user
compatibility views are dropped by the work-stream v33 cutover.

**Why:** A database-shaped port made every caller a partial co-owner of schema
and status translation. It also preserved per-message-era machinery beside a
loop whose identity and lifecycle are substream-owned. Typed operations keep the
loop singleton while making each run visibly subordinate.

**Considered and rejected:** Retaining a read-only SQL adapter and testing its
rewrite behavior. That would leave duplicate protocol vocabulary and tests that
could pass while the semantic storage operation was wrong.

**Consequences:** No active write accepts the retired `waiting` or `steering`
run phases. Ordinary work-stream Stop is a `substream_loops` request observed at
the safe step boundary; it never uses receipt cancellation and does not cancel
provider or tool work already in flight. Receipt cancellation remains only for
descendant/child and generic non-work-stream cleanup. Immutable migration source
still contains old compatibility definitions only so deployed schema
fingerprints can replay before the cutover drops them.

#### Bind projection updates are proportional to the transition

**What changed:** `bind_loop_heads` is the sole current metadata authority and
current message rows reference it directly. The harness holds non-system
messages as an immutable suffix chain; ordinary append, reservation, settlement,
and system transitions share the unchanged prefix. Object storage validates the
cached head and writes only the transition's message delta, while compaction
performs the deliberate full replacement. Provider-boundary reconstruction and
hash verification still materialize the complete ordered array.

**Why:** A second one-row `bind_loop_states` table duplicated the head's
generation/revision authority, and every ordinary transition still rehydrated,
cloned, and rescanned the full conversation before changing one edge. Over a
long-lived loop that made append cost grow with all prior messages and invited
the two metadata rows to diverge.

**Considered and rejected:** Keeping the duplicate state row as a compatibility
projection, and introducing a generalized transition log. The cutover has not
shipped and old Bind heads are intentionally discarded at cutover, so neither
adds a forward-path capability. The immutable activation receipt table remains
because it owns replay identity across compaction rather than current projection
metadata.

**Consequences:** Eviction recovery pays one full ordered read, provider I/O
pays one full projection/hash, and compaction rewrites the current set. Ordinary
durable transitions do not copy or rewrite historical prefixes. Any future
metadata field belongs on `bind_loop_heads`; recreating a second current-state
row would recreate split authority. The chain must remain an in-isolate detail;
an RPC/JSON projection needs a flat bounded representation instead.

#### Terminalization releases the loop only after the receipt is closed

**What changed:** A safe model/tool step advances the persistent loop's step and
Bind revision but leaves the singleton executing. Host-outcome publication and
attempt terminalization then close the subordinate receipt and make the loop
idle in the terminal boundary. Failed output remains transient and materializes
only as the reserved typed status; provider retry and fallback are unavailable
after any output or effect becomes observable.

**Why:** Making the singleton idle at the safe-step commit left a crash window in
which a running receipt was no longer owned by an executing loop. A later
activation could claim the idle singleton while recovery still had to settle the
old receipt. Retrying after visible output created the same split at the model
boundary: two providers could answer one reserved semantic step.

**Considered and rejected:** Releasing the singleton before receipt settlement
and teaching recovery to search for detached running receipts. That recreates a
second lifecycle authority precisely where the persistent loop is meant to be
the only one.

**Consequences:** Safe-step settlement is not a terminal state. Queue delivery
waits for the terminal boundary that makes the loop idle, while steer delivery
can still commit at the safe step. Any failure after observable work closes that
step without a transparent provider retry.


#### Substreams own persistent loops; runs are activation receipts

**What changed:** `loopId` is stable for each work-stream substream and each
HyperSight block, while `harnessRunId` identifies only a subordinate execution.
The host durably reserves every assistant sequence before provider I/O, delivers
steering only after a complete model/tool step, and heartbeats the singleton
loop lease after its attempt heartbeat. External callers record an execution
receipt before `activateLoop`; inline child execution inside the parent host is
removed from the production surface. Recovery advances the current execution
epoch on the singleton and its subordinate receipt in one transaction. A safe
step may close the singleton, but only host-outcome publication and attempt
terminalization close the receipt; assistant reservations, not a singular run
column, associate every model turn in that execution. When a replacement
isolate expires the vanished owner's harness-attempt lease, it expires that
exact loop lease too without moving a logical cursor, so epoch + 1 takeover is
immediate; a deliberately deferred receipt is left at its chosen due time.
Activation-only model inputs now cross their own pre-provider durable boundary:
logical-source identity provides replay idempotency, full provenance survives
projection, every requested identity receives an explicit durable acknowledgement,
and canonical bootstrap history is never replaced on resume.
The real-workerd pipeline now proves that boundary against the actual provider
body after an object eviction and activation replay, rather than stopping at a
storage-only activation test.

**Why:** Persisted compatibility messages and per-run loop reconstruction made
two authorities able to compose and order the same visible response. They also
left crash windows where inference could start before its transcript position
existed and where a long provider or tool call could outlive the loop lease even
while the subordinate attempt remained healthy.

**Consequences:** Canonical participant messages are immutable and ordered by
one reserved sequence authority. A crash leaves an exact reservation to repair,
not a turn to skip or duplicate. An activation replay uses the same receipt and
loop, and one receipt can span multiple assistant turns. A future child agent
must be routed to its own child substream and
`SubstreamAgent` before its tool can return to production.

#### Participant-safety policy preserves authorship through settlement

**What changed:** Bind now exposes one host policy boundary immediately before
an assistant message is accepted into its private loop and canonical transcript.
The work-stream attachment guard uses it to replace a terminal answer after an
unresolved content access, and suppresses raw deltas while that failure remains
unresolved. When the boundary is accepted by Bind, completion, settlement, and
transcript persistence all receive the same approved bytes. If a boundary is
needed only after an earlier assistant turn was accepted, the host retains that
turn and appends the boundary as a separately identified system notice.

**Why:** Replacing an attachment-derived answer only after Bind accepted the
provider text made the transcript and the run-final checkpoint disagree. The
fail-closed settlement guard then correctly rejected the mismatch, turning the
intended safety response into a failed run.

**Considered and rejected:** Weakening the final-turn equality check, mutating
the canonical turn during settlement, or assigning the provider's streamed turn
ID to host-authored safety text. Each makes settlement a second assistant-text
authority and allows a run result to name text Bind never accepted.

**Consequences:** Any future participant-safety transformation must happen at
the pre-acceptance boundary and must return the exact durable content. It is a
policy boundary, not a renderer filter; post-acceptance rewrites remain invalid.
The host replaces its streamed accumulator with accepted content at that
boundary. A later host-only boundary is a `system` participant turn with its own
stable identity, never an assistant turn. The atomic host-outcome checkpoint can
therefore contain an accepted final turn, a system notice, both, or neither; the
last case is how failed and stopped runs with no assistant output remain
recoverable after a crash. It must not derive assistant settlement content from
later guard state: a recovery tool can clear the failure after an earlier
tool-bearing assistant turn was already sanitized, including on stopped and
needs-input exits.
The fail-closed settlement diagnostic names only the divergent invariant —
`actor`, `run_id`, `role`, or `content` — and never includes either payload.


#### Work-stream settlement adopts the final accepted turn

**What changed:** Bind returns only the latest accepted assistant turn as a run
outcome, including for inline children; tool-turn narration is protocol context,
not part of the terminal answer. Work-stream settlement no longer treats even
that outcome field as transcript authority: the API host tracks the latest
explicitly identified Bind turn, replaces its buffer at every turn boundary,
and adopts only the content Bind accepted for that turn. Earlier assistant text
remains in its own ordered transcript turn.

**Why:** Ordered-turn projection made every assistant response durable when
accepted, but the host still accumulated all assistant text and handed that
aggregate to run settlement. The host separately accumulated every delta across
turns and corrected that value only on `stream_completed`; stopped, failed, and
needs-input paths do not emit that event. Settlement then could not adopt the
final Bind turn exactly and previously copied the aggregate into a second
message.

**Considered and rejected:** Deduplicating by run alone would erase legitimate
assistant turns around tools. Keeping cumulative output as settlement metadata
would preserve a second semantic answer that no model turn actually produced.

**Consequences:** Tool-turn prose remains visible in its causal turn, while the
terminal checkpoint refers only to the current identified response. A stopped
provider stream may preserve its provider-authored partial under the explicit
stream turn ID. Host-authored terminal guidance cannot borrow that ID and uses
a system-notice identity instead. Inline child callers receive the terminal
assistant response as their tool result; they do not concatenate narration from
earlier tool-bearing turns into that response.
### 2026-08-27 — A third standing policy: an answer cites what it rests on

**What changed:** `CITATION_POLICY` joins the work-stream system prompt,
teaching the link form and the GFM footnote form with the definition grammar the
renderer lifts. The document policy's announcement bullet gained the embed form,
which puts that rule behind the publishing gate rather than in standing policy.
The three work-stream golden hashes moved.

**Why:** The renderer learned to turn `resource://` links and qualifying
footnotes into chips and pills, and none of it happens unless a model writes the
syntax. Two placements were rejected. A skill would pay a load round trip for a
rule that applies to any run with an attachment. Keeping the *announcement*
bullet here — where the first draft put it — charged every automation, scheduled
digest, inbound-email and Slack-origin run to announce documents they were
deliberately never told to make; it also left two rules for one act with no
tie-break, since the document policy already owned announcing.

**Consequences:** The worst-case rendered prompt is 6,978 bytes against the
8,000-byte ceiling `prompts.test.ts` asserts, so the next standing rule has
about a kilobyte before something has to move out. The guidance and the renderer
are one contract: the definition grammar named here is the one
`packages/contracts/src/citations.ts` implements, and guidance that promised more
would produce footnotes that silently render classic, with the trailing list the
feature exists to remove. Shipped in
[#381](https://github.com/juno-ai-labs/avalon/pull/381). Design:
[`docs/PRDs/2026-08-27_inline-resource-citations/prd.md`](PRDs/2026-08-27_inline-resource-citations/prd.md).

### 2026-08-27 — A document request becomes a published resource, not a wall of chat

Superseded by the 2026-08-30 standing-policy and output-surface entry above.

**What changed:** `DOCUMENT_GENERATION_POLICY` joined the work-stream system
prompt as a `# Documents` section, rendered only when `loadRunPromptContext`
resolves `documentPublishing` — the region reports Terminal supported, and the
run is not an automation, a scheduled digest, an inbound email, or
Slack-originated. It carries the trigger, the write-then-publish procedure, the
narration discipline, the same-path revision rule, the override, and the inline
fallback.

**Why:** A request like "draft the launch press release" produced one assistant
message spanning many viewport heights, which buried the conversation, read as
finished output rather than a draft under discussion, and repeated itself on
every revision. Every mechanism the alternative needs already existed — the
per-work-stream sandbox, the publish path, the resource rail, the read tools,
the compaction inventory — and only the instruction to use them was missing.
The predecessor design reached the same surface through a new message type, two
dedicated tools, an artifact version ledger and a new rail pane; this is the
same experience as prompt policy plus one publish-path derivation.

**Considered and rejected:** Naming the publish tool in the section, which
`writing-prompts.md` permits where a prompt owns a protocol — rejected because
this renders before the Terminal plugin loads and for runs that never load it,
so the name would teach a call that may not exist. Shipping it as an
always-available skill, the PRD's open question — rejected on measurement: the
rendered standing prompt is 6,172 bytes against its 8,000 ceiling, so it fits
policy and a skill would pay a load round trip for a rule that applies to any
request. A feature flag — rejected because the behavior is a prompt module, so
the deploy is the rollout and the revert is the rollback; an admission-consulted
flag is the recorded escalation if staged rollout is later wanted.

**Consequences:** `WORKSTREAM_PROMPT_VERSION` is deliberately not bumped. It is
hashed into the immutable run scope, so bumping it fails every in-flight run
resuming across the deploy with `immutable_run_scope_mismatch`. The section
grants no capability and moves no authority — eligible capabilities and the tool
surface hash are unchanged — and its flag derives from environment and run input
already frozen for the run, so a resumed attempt's scope is the same scope. A
prompt change that did move authority would still need the bump.

Slack is the one excluded origin the PRD does not name, and it is excluded on
the reason the PRD gives for the others: Slack delivery cannot yet carry a
reference to a resource, so a Slack participant would be told a document exists
and given no way to open it. EU workspaces get nothing from this until Terminal
is regionally supported there; the gate is the plugin's own regional rule, so
that follows automatically rather than needing its own condition.

**A published document currently has no reading surface in the desktop client,
and the PRD assumed it had one.** Verified in a real window: a generated
resource appears in the rail under `Artifacts`, and opening it shows the
metadata panel — title, provider, type, direction, version, last updated,
`Remove` — with no content. `InspectorDetail` in `inspector-rail.tsx` renders
no body, and `AttachmentLightbox`, the one surface that fetches
`/resources/:id/preview`, is wired only to attachments on messages. So the
guidance can produce a document that nobody can read in the app, which is why
this PRD is not `completed`: what it specifies has shipped, and its first
acceptance criterion — a rail entry that opens to the formatted document —
cannot be met until the rail can show one. That is a client change the PRD
deliberately excluded ("no desktop release"), so it is named here rather than
smuggled in.
### 2026-08-27 — Durable-memory embeddings move to OpenRouter

**What changed:** Memory query and document embeddings now use OpenRouter's
native embeddings endpoint through the shared inference gateway, with
`qwen/qwen3-embedding-8b` as a fixed route with no model fallbacks and explicit 1,024
dimensions. Query/document input types remain distinct. Vector namespaces are
derived from the fixed requested model and dimension contract, provider model
drift fails closed, and WorkspaceDO
migration 23 requeues every current active memory while keeping old Qwen
vectors unreachable during the rebuild.

**Why:** Memory embeddings were the remaining language-model inference path
calling Workers AI directly, outside the shared provider and observability
boundary. Reusing the existing 1,024-dimensional indexes avoids a destructive
Vectorize replacement, but equal vector length is not semantic compatibility,
so the old and new spaces need a hard query boundary.

**Considered and rejected:** Mixing the previous Workers AI Qwen3 0.6B and new
OpenRouter Qwen3 8B vectors because both are 1,024-dimensional, replacing both
regional Vectorize indexes, and using a
metadata filter that would require provisioning another metadata index. A
versioned namespace is supported without extra index configuration and makes a
partial rebuild fail toward FTS rather than false semantic matches.

**Consequences:** The static `memory_embedding` feature label identifies this
category in diagnostics, but no Flagship rule or Ace edit can change its model.
Changing the fixed model requires a code change paired with an active-memory
requeue.
The current OpenRouter embeddings request schema does not accept Broadcast's
custom `trace` object. It receives workspace `user` plus `X-Session-ID`; Rally
keeps feature, trace, intended/requested/resolved model, fallback, and latency
as content-free regional diagnostics. Query embeddings use the active
substream in that session; document projection uses the owning work stream's
canonical main substream.

### 2026-08-27 — OpenRouter SDK serialization and loop-wide provider traces

**What changed:** Rally's provider boundary now uses the official OpenRouter SDK
schemas instead of a direct OpenAI SDK type dependency. Every structured and
streaming request enables router metadata and sends `user`, a stable
`session_id`, and a Broadcast `trace` envelope. A harness loop keeps one
`trace_id` across all of its turns, and each model turn is a separate named span
containing its OpenRouter generation; inference and route fields distinguish
retries. `feature` carries the model category's exact Flagship key while
`source` retains the execution surface. Provider `user` and trace `user_id`
both use the workspace ID; a relevant person remains separate as
`context_user_id`. `intended_model` retains the primary model selected before
route traversal while `model` records each attempted candidate, making fallback
requests directly queryable. Successful streaming attempts retain returned router
metadata.

Locally invalid SDK requests are terminal before transport: Rally does not
retry them on the same model or send them to a fallback. Structured retries,
repairs, and fallback models retain one trace ID while their provider request
IDs remain distinct. Provider-controlled error prose is discarded before any
operational or lakehouse record is built.

**Why:** The local inference lakehouse proves what Rally sent and received, but
provider-side diagnosis previously had no complete way to join a routed request
back to its workspace, conversation, relevant person, run, deployment, or exact
loop turn. Changing trace IDs per turn would also fragment one agent execution
into unrelated traces.

**Considered and rejected:** Using one trace per model turn, overloading
`session_id` with a host request ID, deriving product identity from synthetic
harness plumbing, and treating OpenRouter Broadcast as a replacement for the
Global-only Rally lakehouse. Those respectively lose loop topology, break
conversation grouping, mislabel one-shot surfaces such as meeting notes, or
weaken Rally's exact regional evidence.

**Consequences:** New inference surfaces must provide an explicit trace context
when the generic harness IDs are not product IDs. Work-stream sessions remain
`<workstream_id>-<substream_id>`, trace IDs remain stable for a loop, workspace
IDs are the provider/PostHog identity, and OpenRouter account owners must
configure Broadcast destinations and privacy policy separately.

### 2026-08-27 — Explicit plugin activation may prepare convergent runtime state

**What changed:** Deferred plugins may provide an `onActivate` hook with a
plugin-specific deadline. Bind runs it only for an explicit `load_plugin`, after
authorization and dynamic tool discovery but before durable activation. A
successful hook is single-flighted for the run; a failed hook may be retried.
Restored activation hints skip the hook. Bind rechecks cancellation before
persisting and forwards only host-authored retry guidance. Terminal uses the
hook to acquire and initialize Daytona before its tools become visible.

**Why:** Production behavior showed that loading Terminal is almost always
followed immediately by a Terminal tool, while cold sandbox acquisition was the
largest first-tool cost. Paying that setup inside the explicit load overlaps it
with the model's capability-selection step and makes the next tool warm.

**Considered and rejected:** Eager preparation for restored hints, one maximum
deadline shared by every plugin, persisting after a timed-out detached hook,
and failing Terminal activation for a repository state only
`checkout_repository` can repair. Those respectively allocate for unrelated
runs, inflate every plugin load, create a durable state the model was told
failed, or hide the repair tool.

**Consequences:** Plugin hooks must be convergent and must not perform an
outward-facing provider/data write. Restored hints remain allocation-free.
Future hook failures may expose only bounded host-authored guidance, and a new
deadline must be scoped to the requested plugin rather than the discovery tool
globally.

### 2026-08-26 — Every Bind provider boundary is losslessly reproducible

**What changed:** The Bind adapter now emits revisioned state transitions for
initialization, validation reconciliation, assistant messages, exact tool
results, protocol-only messages, and compaction replacement. The work-stream
host durably commits those transitions and records an equality hash before each
provider request. Initialization also carries typed provenance for every healed
non-system message; that metadata is stored with facts and is never sent to the
provider.

**Why:** Bind's private message array is the real continuation state. Aggregate
assistant text plus tool lifecycle rows omitted protocol messages, exact tool
results, healing, and compaction replacement, so recovery could neither prove
nor recreate what the provider consumed.

**Considered and rejected:** Treating `input.messages` as a permanent copy of
Bind state and reconstructing old interleaving heuristically. `input.messages`
is only the admitted input; the ledger follows every later accepted mutation.

**Consequences:** A run cannot continue when transcript persistence or boundary
equality fails. The system prompt remains a deterministic runtime projection,
but its rendered bytes and revision participate in every equality check.
### 2026-08-26 — The addressing classifier is told who a message mentions

**What changed:** `classifyAddressing` and its prompt gained a `humanMentions`
input — the display names of the people the message mentions, resolved by the
work-stream object from the same validated mention rows that drive
notifications, and serialized into the classifier's user-role JSON beside
`connectorMentions`. The prompt now rules that a message telling, asking, or
assigning something to a mentioned person (or to someone it addresses by name)
is that person's to act on — `human_only` even during an active task, even when
Rally spoke last, and even when it states facts or times Rally could act on —
with two stated tie-breaks: naming a person never cancels a request aimed at
Rally, and `addressesRally` reports only that the text contains the product's
name, which the model must read as addressing only when the message speaks *to*
Rally. The deterministic imperative fast path no longer fires when the message
mentions a person; it hands those to the model instead. The work-stream object
also now labels the agent's own turns "Rally" rather than "Avalon" in the
classifier's recent-message context.

**Why:** a member tagged a teammate — "@Casey Lane this was sent at
12:08 Pac" — and Rally answered, checking the current time and "logging" the
timestamp. The classifier never received who the message mentioned: the object
resolved and validated the mentions, then dropped them, so the model saw only
raw text, an active-task flag, and an outcome list with no rule for
person-directed messages. During an active task that reads as a continuation of
work. The prompt could not state a person-addressing rule a medium model could
follow until the audience arrived as data, which is the same reason the
ambiguous product name rides in as `addressesRally` rather than being decided by
regex. The "Avalon" author label was a rebrand miss of the documented
model-facing-string class: the prompt introduces the agent as Rally, so history
attributed to "Avalon" hid from the classifier that the agent itself had asked
the pending question.

**Consequences:** an imperative message that mentions a person now costs a model
call where it used to classify deterministically at 0.9 — the price of not
answering work that was handed to a teammate. A message that only *names* a
person mid-sentence without a mention chip carries no `humanMentions` entry and
is covered only by the prompt's addressed-by-name clause, so plain-text
addressing remains a judgment call for the model. `docs/rally-rebrand-inventory.md`
records the author-label rename.

### 2026-08-26 — A run's own subscription decides whether it is an automation run

**What changed:** `resolveMemoryAccess` no longer requires a work stream to be
`ad_hoc` before granting the non-automation scope union. The run's own
`automationSubscriptionId` decides whether it is an automation run; a run without
one resolves workspace, plus its member's user scope when a person is behind it,
in any work stream. The work-stream scope moved behind its own condition, granted
only where the work stream belongs to no subscription. The two refusals
`writableScope` raises are typed and now name the kinds the run does hold, and
the `rally_memory` policy no longer tells the model a scope kind is available.

**Why:** a work stream an automation creates is a place people reply in, and
every reply admits a user-principal run carrying no subscription. That run fell
past the automation branch into a check that read as a consistency assertion and
was in fact a refusal, so `freezeRunMemoryContext` — the first recall a run
performs, before the model sees anything — threw
`memory_ad_hoc_workstream_mismatch` and the run ended `harness_execution_failed`.
The manual retry took the same path, so the member-facing "Retrying is unlikely
to help" was literally true and left nothing to do but abandon the work stream.
Production run `01a03ed2-a0cd-708a-81f0-ba6cffbf4d87` on 2026-08-26 is the report
this was found from. `assertRunAuthorityStillValid` (`services/integrations.ts`)
already treated a run with no
subscription as a non-automation run in any work stream, and that field is the
run's authority claim rather than a description of its container; the memory
union was the only layer disagreeing.

**Considered and rejected:** *Passing the work stream's
`automation_subscription_id` into a follow-up's run input.* It resolves
differently by subscription scope — a personal automation's owner would succeed
where a workspace automation's replier fails
`memory_workspace_automation_principal_mismatch` — so the same member action
would work in one automation and not another, and it would hand the
subscription's accumulated memory to anyone who can see the work stream. Making
it work would mean running a member's reply under the automation's stored
principal, which is an authorization change, not a repair. *Restating migration
0036's predicate verbatim* — `origin_type = 'ad_hoc' AND
automation_subscription_id IS NULL` — was also rejected: the label is a second
name for the same bit, and the weaker one, since the identity root declares
`origin_type TEXT NOT NULL DEFAULT 'ad_hoc'` with no CHECK and would silently
drop the scope for a value that is neither.

**Consequences:** the class this admits is wider than a member's reply, and not
all of it is repaired. An elicitation answer, a manual retry, and a scheduled
wake-up an automation set for itself all declare no subscription, so each now
runs where it used to die — but as an ordinary run. `automationContext`, the
subscription's default plugins, and its `rally_tables` tables are gated on the
same field, so those runs proceed without the automation's instructions or
tables; `table_search` answers them with an empty result rather than a refusal,
which reads as "no such table" one message below where the automation visibly
used one. `finalizeAutomation` also gates on it, so an elicitation answer
delivers nothing to the subscription's configured destination and leaves
`automation_runs` at `needs_input` — unchanged from before, since the run that
threw delivered nothing either, but now silent instead of loud. And because the
protocol projector reauthorizes only replayed attachment results, a reply's model
context can still carry the memory items the automation's own run recalled, which
is a projector defect this change makes reachable with automation-scope content
rather than one it introduces. Gating delivery
on the *work stream's* subscription instead would mail a member's casual reply to
the automation's destination, so this stays open with the two product questions
in the section above rather than being decided here.

**What a future change has to respect:** the automation branch is the only way
into an automation scope, and reaching it still requires both the declared
subscription and a matching principal. The work-stream-scope condition is now the
only enforcement of migration 0036's `memory_scopes_validate_workstream_owner`,
which 0090 dropped when memory moved into WorkspaceDO — not because the workspace
object cannot see a work stream's origin (`workspace_workstream_directory`
carries both fields) but because that row is a waterline-fenced projection a
constraint would gate scope creation on, and memory rows there hold work-stream
ids as opaque provenance rather than foreign keys. Reading the identity object
here is safe only because every automation producer provisions a work stream
before dispatching a run into it. The condition tests subscription ownership, not
disposability, so a one-per-occurrence system work stream — a digest — still
takes a work-stream scope it will never read back; that is a known exception, not
an oversight.

### 2026-08-25 — A rejected automation draft names the field, instead of telling the model not to change it

**What changed:** `automation_submit_draft`, `web_search`, `web_fetch`, and
`memory_search` each supply a `validateInput` re-running the schema their
executor throws from. For the draft tool that parse is now one shared
`parseAutomationSubmission`, so the normalize step and the schema cannot drift
apart between the hook and the executor. The submission JSON Schema and the
compiler policy both state the requirement behind this failure: a ready
`semantic_activity` trigger's `deterministicPrefilter` names one declared event
type. A prefilter string that is not a JSON object is handed to the schema
rather than coerced to `{}`. `HarnessTool.validateInput`'s own docstring now
says when declaring one is mandatory, and `bind-runtime` calls the hook inside a
`try`.

**Why:** the tool's declared `inputSchema` accepts a draft its executor then
rejects, because everything that decides readiness — the binding key, the
inspected plugin, the prefilter's event type, unique memory-table names — is a
cross-field refinement JSON Schema cannot carry, and the prefilter's is inside an
opaque JSON string besides. The runtime's classifier reads exactly one signal to
tell a correctable argument from an external fault: whether the arguments also
fail the declared schema or a code-authored refinement. With no refinement
supplied they never did, so a `ZodError` raised by the draft's own contract was
filed as downstream data validation and the model was handed "retry once; if it
fails again, report that the tool could not validate its data instead of
changing the arguments" — advice that is correct for a provider response and
exactly wrong here, since the model *is* the author of the rejected value. On
request `8592b3f1` it did as it was told: four submissions, byte-identical
rejections of one missing `deterministicPrefilter.eventType`, then
`automation_draft_not_submitted`, and a `502` whose only member-facing advice was
to try again — which would have failed the same way. The hook existed for this;
this tool had simply never been given one.

**How it is proved:** `packages/agent-harness/src/index.test.ts` compiles a draft
whose ready semantic trigger declares an empty prefilter, and asserts the tool
result the *next* provider request carries names
`triggers[0].deterministicPrefilter.eventType` with the refinement's own
sentence, arrives as `kind: "validation"`, and does not carry the
"instead of changing the arguments" advice — then that the corrected
resubmission compiles. Removing the hook fails it on `kind`, then on that text.
`packages/contracts/src/index.test.ts` pins the path *and* the message of all
six readiness refinements, which became the compiler's correction vocabulary the
moment this change made them reachable; a refinement whose path is wrong names a
field the model cannot find, which is this same loop under another name. The
prefilter pass-through and the schema sentence each have their own case.

**What a future change has to respect:** a tool whose executor parses with a
schema stricter than the one it advertises owes the runtime a `validateInput`.
The omission is invisible — it produces no error log distinguishable from a hard
failure, which is why three tools carried it into production unnoticed.
Without it, its own contract's failures are attributed to somebody else's system
and the model is actively steered away from the fix. The refinement passed here
must stay the same parse the executor runs; two parses that can disagree would
name a field in the correction that the executor does not reject, or accept one
it does.

**Considered and rejected:** *Broadening the runtime's classifier* to treat any
executor `ZodError` as an argument error — the distinction is load-bearing, and a
provider response that fails validation is not the model's to fix. *Loosening
`AutomationDraftSchema`* so the submission is accepted and the missing event type
surfaces later — `POST /automations` refuses the same draft with
`activity_trigger_event_required`, so this only moves the dead end behind a
Create button. *Leaving the submission schema's wording alone* now that
the correction loop works — one recoverable round trip per draft is still a round
trip, and the requirement was invisible to a model reading the field's own
contract. *Adding* the rule to the compiler policy as a second sentence: that
was written and reverted at +124 bytes against 63 of headroom. What went in
instead is a correction, not an addition. Policy already carried a vaguer first
copy — "a declared deterministic prefilter", which beside its
`connector_activity` sibling's "only declared deterministic filter *fields*"
reads as *declared by the plugin*, so `{}` satisfied it. Two statements of one
rule drift into a contradiction, and this pair already had; the fix is to
correct the stale one, at +22 bytes, not to leave it standing beside an accurate
one elsewhere. *Throwing `formatToolArgumentValidationError`'s text from the
executor* instead of declaring the hook — one line, and the model would see the
same field names, but it routes around the classifier: the failure would still
be reported as `kind: "external"`, so the wire contract and the telemetry would
both say the provider's data was bad.

### 2026-08-25 — A platform refusal stops being the asking port's fault

**What changed:** `platform_limit_exceeded`, kind `platform`, joins the failure
codes. `FatalHarnessPortError` decides it from the cause's message —
`platformLimitRefusal` matches the subrequest depth and count wordings, and D1's
`D1_ERROR:` prefix on the first — so every port that wraps its own failure gets
the attribution without knowing to ask for it. The member-safe message says
"this run" rather than naming an operation, and offers a retry, because the
limit is per invocation and a fresh run starts a fresh one.

Two things the new arm exposed came with it. `kind` tested `FatalHarnessPortError`
*below* `timedOut` while `code` tested it above, so a platform refusal landing
during a timed-out run reported `deadline` beside `platform_limit_exceeded`; the
arms are now in one order in both chains. And `HarnessLimitError`'s constructor
excludes the codes that are not limits, so `platform_limit_exceeded` is added to
that list — without it a limit error could be constructed carrying it and would
report kind `limit` for a platform refusal.

**Why:** the codes exist to answer one question — which system produced this —
and this class of failure was answering it wrongly. Cloudflare enforces its
subrequest limits by refusing whichever call asks next, so the refusal surfaces
at an arbitrary port. On 2026-08-24 that was the tool-receipt port: the run
reported `tool_receipt_persistence_failed`, a code whose whole purpose is to say
a write may have crossed an external boundary, for a receipt that was never
attempted. Deciding it in the error's constructor rather than at each call site
is the same reasoning as the provider arms above: an attribution every author
has to remember is one some author will not.

**How it is proved:** `packages/agent-harness/src/index.test.ts` fails a run
through a receipt port that throws the platform's exact wording and expects
`platform_limit_exceeded` with kind `platform`, alongside a case for the count
limit and two negatives — an ordinary SQL error and a missing cause — so the
matcher is asserted at both edges. A further case runs the same refusal past a
real 5 ms wall clock, so `timedOut` is genuinely true and the arm under it is
genuinely reachable, and expects `platform` rather than `deadline`; restoring
the old arm order fails it on exactly the mismatched pair. The exclusion list is
a compile-time claim and is proved by `pnpm typecheck` rather than a spec.

**What a future change has to respect:** `kind` and `code` are two expressions
over one error and answer one question, so an arm added to either goes in the
same position in both. Both chains have been wrong about that once, in opposite
directions, and neither cost anything until a code arrived whose kind was not
already `execution`.

**Considered and rejected:** *Matching on the port that failed* — the refusal
lands anywhere. *Adding a retry* for it inside the harness: the invocation is
already spent, so a retry inside it fails identically; the honest recovery is
the next run, which is what the member-facing message says.

### 2026-08-24 — The compiler is told the timezone it was being asked to schedule in

**What changed:** `renderAutomationCompilerMessages` takes the account's
personal and workspace zones and renders them as a user-role scheduling-defaults
message. The policy line that said to use "the user's timezone" now says to set
a calendar trigger's timezone only to a zone the person named, otherwise to
leave it null for that default, and to name the zone that applies in the trigger
summary. The submit-draft schema's `timezone` field carries the same contract in
its own description. Two sentences left the policy to pay for it — "Flat trigger
records require null for every unused field" and the JSON-string encoding rule —
both of which the rendered submit schema already states per field.

**Why:** the rule referred to a fact the model was never given. Asked to
schedule in a timezone it could not read, a model supplies a popular one, and a
New York account got a 9:00 AM briefing on Pacific time — in the field *and* in
the summary sentence the person reads on the automation, which is model prose
and would still have named the wrong zone had only the field been repaired.
The defaults are a user-role message rather than an interpolation into the
policy: the policy is one constant string every workspace shares, which is the
block a prompt-cache hit is worth the most on, and an account's zones do not
change between turns, so they sit ahead of the draft state that is rewritten
every turn.

**Consequences:** the policy is back to 9,943 bytes against its 10,000 ceiling,
so the byte cap held without being raised. The field is now expected to be null
in the ordinary case, and the normalizer no longer substitutes a default for it —
`AutomationService` resolves it where the `schedules` row is derived. A zone the
model *writes* is still honoured, deliberately: a shared template naming an
American market open must not follow its adopter. So the policy line is what
keeps a model from deciding when an automation runs, not a server-side guard, and
`prompts.test.ts` asserts its wording for that reason. The
substitution was kept in a first draft of this change to keep the wire non-null,
which made the server's resolution unreachable for everything the pipeline
produced: review of #263 found the two cases that cost, and the normalizer's
fill went. `prompts.test.ts` pins the message, its position, and the policy's
deference to it; `index.test.ts` pins that `compileAutomation` sends both halves
and that an unnamed zone comes back null.

A second review round caught the trigger enumeration two paragraphs above still
defining a calendar trigger as "RRULE and timezone", with no tie-break against
the new rule — the reading a medium model is likeliest to take is the earlier
definitional one, which fills the field and puts the resolution back where it
was. It now says "optional timezone". The summary rule was conditioned on the
same predicate at the same time: naming "the zone that applies" asked the model
to pick by a scope chosen after it writes, so an unnamed zone now gets a summary
with no zone in it rather than a guess in the one sentence a person reads.

### 2026-08-24 — EU hosts intentionally discard analytical inference events

**What changed:** The harness still emits the same host-neutral lossless event,
but only the Global API host persists and transports it. The EU host returns
before archive staging and has no Queue or Pipeline binding.

**Why:** Cloudflare cannot put Data Catalog in the EU jurisdiction, and the
direct R2 Pipeline alternative would require a separately bootstrapped
interactive credential. Product direction is to defer EU inference analytics.

**Considered and rejected:** Teaching the portable harness about region, which
would couple provider execution to deployment topology; and forwarding EU
events to Global, which would cross the workspace content boundary.

**Consequences:** Provider execution behavior remains identical in both regions.
Global retains maximal request and terminal-attempt evidence; EU has no raw
lakehouse evidence for production debugging.

### 2026-08-24 — Every terminal run closes its residual receipts, not only a stopped one

**What changed:** `terminalizeHarnessAttempt` settles residual tool receipts on
every terminal status instead of only `stopped`, on both the first commit and
the `already_terminal` repeat that finishes a lost settlement. The bounded
activation sweep's retry predicate became "any terminal row missing the
`residual_receipts_settled` marker" rather than the three paths that used to
write one. A root that wrote its own terminal row now settles with
`run_terminated`/"The run ended before the tool produced a result" instead of
the reaper's `parent_run_terminated`/"lost its durable lease".

**Why:** a `load_plugin` card spun for fourteen hours in a work stream whose run
had already ended. `tool_started` is emitted at `bind-runtime.ts:981` and the
guard that reports `tool_failed` does not open until `:1007`, so a throw in
between — `emit` itself converts any host `onEvent` failure into a
`FatalHarnessPortError` — leaves the receipt `executing` and the transcript part
`pending` with no terminal tool event. Nothing downstream closed it: HQA-08's
repair was written for the stopped, reaped-child, and stale-lease paths, and its
predicate named exactly those, so a root that terminalized `failed` matched
neither the first-pass call nor the retry. The window itself is not reliably
fixable where it opens — emitting `tool_failed` through the same host that just
failed would usually fail again — which is why the fix is at the durable layer
that runs after it. Scoping the settlement rule to the paths then known to need
it is what made a fourteen-hour spinner possible; a future change must not
re-narrow it to a list.

**Consequences:** one extra object RPC and one lifecycle row per terminal run,
against the several RPCs each tool call already costs. Rows terminalized before
this became universal carry no marker either, so the sweep backfills them a
bounded page at a time; it is per work stream, records a marker per repaired
row, and therefore drains rather than repeating. That backfill runs on its
**own** budget: the repair pass and the two reaps shared one, which was harmless
while the pass could only select three narrow paths and starves the stale-lease
reap now that it selects every unmarked terminal row — and that reap is the only
recovery for an executor that died without terminalizing at all. The page is
also ordered newest-first, so a card stranded minutes ago is repaired before a
year of history. Ordering does nothing for a row that can never settle — one
whose object-side terminal stamp does not match records no marker however often
it is tried, so it holds a slot in every page, and the order only decides
whether the wedged rows are the recent or the old ones. Enough of them in one
work stream and the rest of its history is never reached; the signal is
`harness_residual_receipt_repair_failed` repeating one run id, and the fix
would be durable per-row retry state and a backoff whose number is the team's.

A settlement failure still throws out of terminalization rather than being
swallowed, and that now reaches every run rather than only a stopped one. The
noise is real — the substream dispatch logs a successful run as failed once and
skips that pass's `stream_completed` publish — and it is still the better trade,
because the throw is what defers the dispatch by a second, and the retry's own
`reapStaleHarnessRuns` closes the card on the way back in. Swallowing would
report the run cleanly and leave the card spinning until somebody sent the next
message into that work stream, which is the exact failure this entry exists to
remove. The retry path never re-enters `terminalizeHarnessAttempt` — it adopts
the terminal outcome at `substream-agent.ts:1909` — so that sweep is the whole
recovery, which is also why its budget had to stop being shared. Widening the
walk also broke the
implication that a `failed` root in it was always `stale_run_reaped`, which
`settleStaleAutomationRun` relied on — it matches every unfinished automation
row in the work stream, so it is now explicitly restricted to a reaped root, and
`harness-run-runtime.test.ts` pins that a directly-failed root leaves a live
automation run alone. **Still open:** a run whose executor dies without
terminalizing at all leaves the row `running` with a lapsing lease, and
`reapStaleHarnessRuns` is called from exactly one place — immediately before
`claimHarnessAttempt` — so nothing recovers it until someone sends another
message into that work stream. Giving the object a wake reason for its own
expired lease is a
[`durable-object-alarms.md`](durable-object-alarms.md) decision and is not this
change's to make.

### 2026-08-24 — Inference evidence preserves product substream identity

**What changed:** Lakehouse request and attempt records now carry the canonical
product `substream_id`. The main feed defaults to `"0"`, and root and inline
child inference both inherit the workflow input's substream; inline child
lineage remains represented by `request_id` and `parent_request_id`.

**Why:** A work-stream-only analytical key cannot distinguish model calls once
multiple product substreams exist inside one work stream, while using inline
children as synthetic substreams would confuse execution lineage with product
conversation identity.

**Considered and rejected:** Leaving `substream_id` implicit until the product
creates a second substream. The Pipeline stream schema is immutable, so waiting
would force a resource replacement precisely when the identifier first became
necessary.

**Consequences:** Current main-feed evidence is explicitly identified as
substream `"0"`; future workflow substreams flow into the lakehouse without
changing child-run semantics or adding a D1 lookup path.

### 2026-08-24 — The opt-in D1/R2 inference ledger is retired

**What changed:** Migration 0094 drops `agent_inference_payload_logs` and the
`workspaces.log_agent_inference` preference. The API contract, stored desktop
session field, Workspace Settings toggle, and request-only `agent-inference/`
writer were removed. Hosted capture now has one path: the regional inference
lakehouse. Historical R2 objects are retained rather than deleted implicitly.

**Why:** Keeping a second request-only index duplicated sensitive inference
content, made absence ambiguous because the workspace flag defaulted off, and
left operators choosing between two incomplete diagnostic surfaces after the
lossless lakehouse became authoritative for inference analysis.

**Considered and rejected:** Keeping the D1 row as a fast work-stream lookup.
That preserves a second schema and lifecycle solely for convenience; the
lakehouse already indexes `workstream_id`, `substream_id`, `request_id`, and
`inference_request_id` without putting analytical state back into D1.

**Consequences:** D1 no longer stores analytical inference metadata and the
general payload bucket receives no new `agent-inference/` objects. The owning
`SubstreamAgent` or `BlockDashboardAgent` still stores its operational
`inference_attempts` rows because those belong to execution recovery, not
analytics.

### 2026-08-24 — Provider calls expose lossless request and terminal envelopes

**What changed:** Every streaming attempt now identifies the provider invocation
model and carries its complete normalized response. Every structured provider
fetch gets a stable inference request ID and exposes its exact request,
successful JSON response envelope, bounded failure classification, typed usage,
latency, response bytes, repair position, and terminal validation result to the
host capture hook.

**Why:** The existing inference ledger described routing and cost, while its
opt-in payload object stopped at the request body. A regional lakehouse cannot
answer why a model behaved differently across providers or repairs without the
matching output/error envelope and one ID joining the request to the attempt.

**Considered and rejected:** Reconstructing responses from transcript messages.
That loses provider IDs, raw usage and finish metadata, structured validation
failures, rejected provider envelopes, and calls whose output never committed to
the transcript.

**Consequences:** The host hook now handles highly sensitive data and must keep
it on the regional path described in `inference-lakehouse.md`. Ordinary Workers
Logs and object-local operational ledgers remain redacted; only the explicit
lossless store receives the full envelopes.

### 2026-08-23 — The work-stream prompt states what a written answer is made of

**What changed:** `RESPONSE_FORMATTING_POLICY`
(`prompts/response-formatting.ts`) joined the work-stream system prompt, which
every ordinary run — digests included — carries. It states that written
answers are GitHub-flavoured Markdown while an elicitation question is a
plain-text label, that TeX and math delimiters are never written, that a
literal backslash belongs only in code formatting, and that a dollar sign in
prose is plain text.

**Why:** models routed through OpenRouter emit TeX for symbols, and no Rally
surface renders it. The display-side normalizer
([`model-text-normalization.md`](model-text-normalization.md)) repairs what
arrives anyway; the prompt half is the only half that also fixes the copy that
is *stored* — exported, quoted into a later run, read back by the next model —
so both halves exist. The dollar-sign clause is deliberately scoped: an early
draft said a dollar sign belongs in backticks, which instructs a model to
code-format every price — the exact output the normalizer's money rule was
built to protect as prose. A future edit that widens the clause re-fights that
decision.

**Consequences:** the policy is a static module constant in the cached prefix,
~800 bytes against the 8,000-byte ceiling; the digest brief deliberately does
not restate it (a second copy at the user-message layer competed with the
brief's own output shape), and `digest-run.test.ts` pins the absence while
`prompts.test.ts` pins the TeX line's presence.

Shipped in #257.

### 2026-08-23 — The compiler reports the destinations it was asked for, and its ceiling stays at 10,000

**What changed:** `requestedDelivery` became a required field of the
submit-draft tool schema, closed to `email` and `slack_agent_dm`, normalized to
a sorted de-duplicated list with unknown members dropped. The delivery rule in
the compiler policy was scoped to the owner and given an answer for its two
ambiguous readings. A stack-ranked-briefing recipe was deleted from that policy,
and the prompt's byte ceiling — briefly raised to 10,500 — is back at 10,000.

**Why:** The create screen was deciding whether to pre-tick email by pattern-
matching the draft's prose, and the compiler had already parsed that sentence.
The guess was wrong in the expensive direction — the compiler's own worked
example is a briefing about an inbox — and, until the same change made
destinations editable, wrong permanently. Sorting is not cosmetic: the
normalized draft is re-rendered into the compiler's own cached prefix on every
later turn, so the model's word order would otherwise cost a cache hit per turn.

**Considered and rejected:** Leaving the ceiling at 10,500. The comment written
to justify that raise named the sentence that should move out first, and
deleting the sentence it named came in at 9,946 — under the original bound with
room to spare. Raising a defensive limit around something already identified as
removable is backwards, and `docs/writing-prompts.md` asks for the removal
first. The recipe was one workflow's output shape sitting in standing policy
charged to every compile.

**Consequences:** An email-briefing automation drafted from now on gets no
built-in formatting recipe; if that guidance is wanted back it belongs in a
skill, which needs the compiler given a skill surface first — `compileAutomation`
does not pass `skills` to `runHarness` today. Anything reading `requestedDelivery`
must keep treating it as a *request*: it is model output, it selects among
Rally's own fixed channels, and it never carries an address.

### 2026-08-23 — Terminal receipt reconciliation survives a transient object failure

**What changed:** Stopped terminalization, stale-root reaping, and stale-child
reaping now write an immutable `residual_receipts_settled` lifecycle marker only
after object-local residual receipt settlement succeeds. A repeated stopped
terminalization retries when its exact terminal row lacks the marker. The
existing bounded stale-run sweep repairs missing markers before claiming new
expired rows, including already-terminal roots and children, and then records
the acknowledgment so the scan makes forward progress. A rejected repair is
reported and skipped for that activation rather than aborting run admission;
the absent marker keeps it eligible for a later retry. Stopped-root receipt
checkpoints retain the receipt-scoped `run_cancelled` payload, and stale
automation repair can fail only `scheduled` or `running` rows, never a later
member-owned `needs_input` continuation.

**Why:** A run's terminal state and its receipt settlement are necessarily two
object calls. The safer terminal-first ordering was already established, but a
transient failure in the second call left the run terminal. Every retry then
returned `already_terminal`, while the stale-run query selected only live
`running` rows. The receipt therefore remained `admitted` or `executing`
forever and the member-visible tool card kept spinning, contrary to the stated
recovery contract.

**Considered and rejected:** Settling receipts before terminalization would
reintroduce the takeover corruption this ordering was designed to prevent.
Adding a queue, alarm, schema column, or separate reaper would duplicate the
activation sweep and create another recovery owner. The immutable lifecycle
ledger already provides the one durable acknowledgment needed, and the sweep's
existing limit bounds historical catch-up. Letting one rejected historical row
throw out of the sweep was also rejected: the visible warning plus absent marker
preserves diagnosis and retry without preventing unrelated work from starting.

**Consequences:** The first failed settlement remains fail-safe: the terminal
run cannot execute again and its receipt stays visibly open until recovery.
The next direct retry or bounded sweep replays the idempotent settlement, then
marks it complete. Three regressions inject the failure after stopped, root,
and child terminalization, while a fourth proves the BlockDashboard-only sweep
can repair its own stale root without gaining automation authority. Removing
either retry path or the block-origin allowance makes the corresponding
regression fail. Additional causal cases prove a payload-less member stop keeps
`run_cancelled`, an old repair cannot overwrite a later automation elicitation,
and an unsettleable first repair cannot prevent a stale run behind it from being
reaped. Historical repair is synchronous on the run-start path: an activation
may attempt up to 25 old rows before ordinary stale-run reaping. The cost is
finite as markers accumulate; failed attempts are warned and do not consume the
new-work reaping budget, though they remain eligible for a later activation.

### 2026-08-22 — Tool receipts leave the compatibility layer

**What changed:** Every read and write of a durable tool receipt now goes through
`WorkstreamToolReceiptStorage` and its typed port, not D1-shaped SQL rewritten
onto `_runtime_tool_invocations`. Object schema migration 17 drops that view,
`_runtime_tool_checkpoints`, and their four triggers, and adopts two things the
compatibility schema owned that were never compatibility objects: the
`attachment_tool_receipts` table and the `tool_effects_run_call_uq` index.

**Why:** the layer existed so one body of code could run against D1 and the
object during the cutover, and every region past migration 0090 is permanently
past that point. Concretely it cost three round trips per receipt operation —
fence, batch, reconcile — with the run's lease restated in SQL each time because
it could not be trusted in between. Each operation is now one `transactionSync`
on the owning object.

**Considered and rejected:** converting the two telemetry statements and the
stale-run sweep into port operations as well. The telemetry statements are
run-shaped rather than receipt-shaped and their primary table is `harness_runs`,
so they are retargeted at `tool_effects` in place and the harness-runs slice
converts them whole. The sweep did become an operation, but not a variant of an
existing one: every other method is fenced on a live lease, and an expired lease
is the sweep's entire premise.

**Rebasing onto the entry below changed one thing it decided.** That change made
a stopped or reaped run settle its residual receipts and write its terminal
lifecycle row in a single D1 batch, receipts first, and fenced the terminal event
on there being none still open. Those two writes are now in different stores —
the lifecycle row in the regional database, the receipts in the work stream's
object — and no transaction spans them, so one of the two orderings had to be
chosen rather than avoided. The settlement runs *after* the terminal write, in
`settleResidualReceipts`, fenced on the exact `terminalized_at` that write
stamped.

The reason is which failure each ordering leaves behind. Settling first and then
failing to terminalize closes the receipts of a run that is still live and may
have just been taken over by a successor — corrupting a running run. Terminalizing
first and then failing to settle leaves a terminal run with open receipts, which
the next bounded sweep retries because the immutable receipt-settlement marker
is absent; the tool card resolves late instead of wrongly. A future change must
keep that order and marker for that reason, and must not
"restore atomicity" by moving the settlement back ahead of the terminal write.

Two fences the entry below added to the D1 statements moved with the code
rather than being lost to the conversion. A lease owner may settle a receipt
Bind already returned after a member stop — `#fence` takes
`allowCancellationRequested`, and relaxes only that one condition, because
`terminalizeHarnessAttempt` refuses while any receipt is still admitted or
executing and refusing here would deadlock the stop it is honouring. And an
attachment dependency is recorded, and unwound, only against the exact
`output_ref` the caller completed, so a receipt replanned onto another call
between the completion and the registration is not attached to.

**Consequences:** the compat vocabulary does not disappear, it relocates.
`ToolInvocationSchema` still publishes `pending`/`started` and ISO-8601, so
`loadToolInvocation` translates at the wire boundary. Two behaviors that lived
inside compatibility objects are now explicit: migration 14's projection of a
settled receipt into its tool part, which is the only thing stopping a reaped
run's card spinning forever, and the replay dedup the unique index carries. And
a statement moved off a view reports `rowsWritten` rather than a trigger's
counter, which counts index writes — an `=== 1` check that survives such a move
will be wrong.


### 2026-08-22 — Production refusals, cancelled receipts, and inference logs become honest

**What changed:** Plugin activation, skill loading/resource access, and wake-up
refusals now throw typed failures instead of returning successful results with
an `error` field. Producer recovery values are bounded before the fail-closed
sanitizer, already-loaded skills are not mislabeled as available, and plugin
search is normalized, ranked keyword discovery capped at twenty results with a
model-visible total match count. Bind labels rejected arguments as validation-phase failures,
the attachment grounding guard excludes them from unresolved content, and the
host settles a post-start rejection against its already-recorded real-input
receipt rather than creating a conflicting empty-input plan. A
lease-owning attempt may settle any terminal event already returned by Bind for
the exact in-flight receipt after durable cancellation. Stopped terminalization
commits the parent first, then classifies any residual receipt from the current
or an expired attempt under the exact terminal stamp and advances past any
orphan checkpoint index from an older partially admitted settlement. Child
reaping applies the same terminal-first classification after a stopped or
orphaned descendant becomes terminal. An
obsolete executor defers instead of failing its successor; abandoned drain
identity is rechecked after the pre-claim await, and Substream and BlockDashboard
executor-owned dispatch releases and terminal transitions require the exact
lease token. Substream product failure requires that token too; post-terminal
BlockDashboard delivery retries rely on the already-durable terminal outcome.
Checkpoint, completion, and failure batches carry their first live-lease
admission through the immediately serialized receipt write rather than sampling
expiry twice; the receipt update must reference the exact checkpoint ID admitted
by that first statement. Root-stop and child-reaper races retain started receipts
unchanged when a successor takes ownership or an expired child lease is renewed.
The real-worker dispatch fixture now seeds an authoritative product root; a
scheduling-only fixture without that row masked recovery behind a guaranteed
regional-effect authority refusal.
An attachment replay
dependency is registered only after the completion receipt passes that authority
fence and only while its exact output reference remains current; a successor
replan repeats both durable-dependency predicates inside its atomic write.
Migration 0093 aligns the inference payload-log source check with all five
runtime callers.

**Why:** Signed-in production stress testing showed the same protocol lie on
three surfaces: a missing plugin, unavailable skill, and nonexistent wake-up
were green completed rows whose model payload said `success: true`. The same
pass found a natural multi-capability plugin query returned no matches, an
invalid attachment call created a false `Attachment content unverified`
boundary, a stopped Terminal command left its card `started`, and HyperSight's
visible success hid a D1 constraint failure on each opt-in inference payload log.
In each case the durable protocol, not renderer wording, was the repair boundary.

**Considered and rejected:** Renderer-side sniffing for `output.error`, a
blanket conversion of every returned error-shaped object, AND-token discovery,
and allowing parent cancellation to terminalize without closing its tool.
Renderer inference would leave the model, receipt, and audit dishonest; blanket
conversion could reinterpret legitimate domain result envelopes; AND search
still misses queries spanning plugins; parent-only terminalization preserves a
contradictory started child.

**Consequences:** Expected refusals now produce `tool_failed`, failed durable
receipts, and actionable structured model results. New deterministic refusal
paths must throw a code-bearing error with allowlisted details. Search may return
partial keyword matches but reports its full match count when the ranked list is
bounded. The
cancellation exception is not a general fence relaxation: attempt, owner, lease,
running status, and terminalization checks still apply. Residual receipts are
classified after the stopped commit under its exact terminal stamp; a missing
settlement marker makes the direct retry or bounded sweep repeat that idempotent
operation. Every live admitted receipt settlement finishes even if the lease
deadline passes between its serialized checkpoint and receipt writes. Cleanup
advances beyond an older orphan checkpoint rather than conflicting on it. Stop
therefore cannot degrade into a contradictory started row or a stale executor's
later failed outcome, and an abandoned drain cannot continue beside its
replacement. A
stale executor cannot mutate attachment replay dependencies before its completion
is accepted or race that dependency past a successor's preliminary replan check.
New inference callers must add their source to the typed union and the D1 check
in the same change.

### 2026-08-22 — A run is told what Rally will deliver for it

**What changed:** The automation prompt context carries the active destinations
Rally delivers the run's result to, and the standing behavior policy forbids
sending a copy of that result to one of them. The compiler policy says the same
from the other side: a destination is described, never instructed as a provider
send.

**Why:** Platform policy outranks saved automation configuration, and the
automations that already exist have "send me the briefing by email" written into
their instructions. Fixing only the compiler would leave every one of them
sending a second copy until its author rewrote it.

**Considered and rejected:** Listing every frozen target regardless of status. A
disabled or failed target delivers nothing, so naming it would stop a run doing
the sending its task actually needs. Also rejected: leaving the rule in the
always-on policy string, which spends its bytes on every interactive run and
gives a run asked to "email this to Bob" a rule whose subject its context does
not carry.

**Consequences:** A new delivery channel has to be added to `resultDelivery` or
its runs will send a second copy, and the section renders only for a run with a
non-empty list — a caller that populates the field must populate it truthfully.
The rule is enforced by policy, not by a guard: the mechanism, if the destination
set ever includes somebody other than the owner, is a `beforeToolCall` predicate
over a frozen destination list, the same shape that already makes child runs
read-only. `WORKSTREAM_PROMPT_VERSION` was deliberately not bumped, because it is
inside the canonical run-scope hash and bumping it fails every in-flight run's
resumed attempt across a deploy.

### 2026-08-22 — Tools receive the receipt identity their effects are keyed to

**What changed:** `HarnessToolContext` gained an optional `effectIntentId`, and
`resolveToolEffectIntentId` was added to the host ports. Bind calls it once per
dispatch — after the `tool_started` event, before the tool runs — and forwards
the answer on the context.

**Why:** A tool that starts work outside Rally has to name that work with
something a resumed attempt will recognize. Until now the one tool that needed
it, Terminal, queried the host's `tool_invocations` table for its own receipt
id: a subsystem reading another's table for an answer the host had in hand.

**Considered and rejected:** Deriving the id inside Bind from `toolCallId`.
That coordinate is stable across a resume, but the receipt row it maps to is
created once and kept, so the derived id would diverge from the one an
interrupted attempt already used — exactly the case the identity exists to
handle. Also rejected: returning it from `persistToolExecutionPlan`. Rally's
host does that work while handling `tool_started` rather than through that
port, so the return value would reach nobody.

**Consequences:** The ordering is load-bearing and asserted, not just
commented — though for a plainer reason than it first looks: the host writes
the receipt while handling `tool_started`, so before that event it has nothing
to return. A host that queried the row rather than remembering it would get the
same id on a resumed attempt, because the surviving row is the one the first
attempt wrote. A host that implements no receipt ports leaves the field absent,
and a tool that needs one must fail rather than substitute `toolCallId`.
Because tool calls within a turn may run concurrently, a host keys its answers
by `toolCallId` rather than remembering only the latest.

### 2026-08-22 — Required host failures name the invariant that did not persist

**What changed:** Every required harness port supplies its failure category
explicitly. A failed host callback for `tool_started`, `tool_completed`, or
`tool_failed` now keeps the tool-receipt category instead of falling through to
run-state persistence.

**Why:** Terminal production recovery depends on knowing whether the durable
tool receipt or broader run state failed. The previous label regex was an
unstated API: harmless wording changes could silently change retry guidance,
and lifecycle event persistence was categorized as run state even though it is
the authoritative receipt transition.

**Considered and rejected:** Extending the English-label regex and treating
every event callback as run-state persistence. The first keeps semantics coupled
to copy; the second hides the exact write whose state a participant must inspect
before retrying.

**Consequences:** New required ports must choose one of the three durable-host
failure categories deliberately, and tool lifecycle callback regressions are
covered at the public `runHarness` boundary.

### 2026-08-20 — Terminal runs close tools and attachment claims stay grounded

**What changed:** The stale root-run reaper terminalizes pending and started
tool invocations in its ownership-fenced batch, preserving ambiguity for a
started receipt that is not proven to be a read. Attachment content failures
are tracked across tool calls, receive one recovery turn, and end behind a
deterministic content-free boundary if unresolved. End-of-turn hooks no longer
implicitly accept empty provider completions; bounded callers opt in explicitly.
Stopped realtime events map to the object's `cancelled` run state, and the
desktop renders stopped runs explicitly with a distinct status indicator and a
fresh retry.

**Why:** QA observed a terminal retry whose durable tool row still said
`started`, no transcript outcome for a member stop, and a model that converted
an attachment-tool failure into invented facts. Run status alone was therefore
not an honest member or operator view.

**Considered and rejected:** Letting the UI infer tool settlement from the
parent, relying on prompts to obey tool failures, and displaying stopped as
failed. Those respectively preserve contradictory durable state, lack an
enforcement boundary, or misstate an intentional member action.

**Consequences:** Any future terminalization path must audit child and tool
receipts atomically and must not turn an uncertain external write into a
definitive failure. Content-bearing tools must expose stable resource identity
to the grounding guard, empty-completion acceptance must be an explicit caller
decision, and stopped remains a distinct terminal state through storage, wire,
and UI.

### 2026-08-18 — Durable memory authority moves into WorkspaceDO

**What changed:** Prose memory, structured tables, local FTS, mutation receipts,
revision state and the vector-index outbox now live in WorkspaceDO. A run still
freezes its admitted memory context in SubstreamAgent, and current membership is
revalidated from D1.

**Why:** Memory scopes cross work streams but never cross their workspace.
WorkspaceDO is the relational boundary that can authorize workspace/user/
automation/work-stream scopes without leaving a product authority in D1.

**Considered and rejected:** Per-work-stream memory copies and a D1 search
projection. Both make invalidation and revision compare-and-swap split-brain.

**Consequences:** Vectorize remains a derived regional index. Every hybrid hit
is reloaded from WorkspaceDO before model exposure, and an object outage fails
closed rather than trusting the projection.

### 2026-08-18 — HyperSight loops use the BlockDashboard runtime role

**What changed:** The model role, feature-flag key, submission plugin namespace,
run origin, error codes, test modules, and owning Durable Object now use
BlockDashboard identifiers. Model-visible product prompts and tool display copy
still say HyperSight.

**Why:** The harness needs a stable technical role that matches the owning
subsystem across flags, SQL, and telemetry without renaming the product users
recognize.

**Considered and rejected:** Translating only at the Durable Object class. That
would leave one logical loop split across two names in runtime ledgers and
operational queries.

**Consequences:** Internal callers route the `block_dashboard` role and emit
`block_dashboard_*` outcomes. Prompt and UI reviews must continue to treat
HyperSight as the visible name.

### 2026-08-18 — HyperSight input is a reproducible model-array interval

**What changed:** Every block dispatch binds the exact eligible compaction
checkpoint hash and a tool-safe upper sequence selected by main
`SubstreamAgent("0")`. The block passes that checkpoint fence into the ordinary
Bind run assembly rather than resolving “latest” at execution time.

**Why:** HyperSight may begin after another turn or compaction. A message-ID
waterline alone neither fixes the lossy prefix nor proves a provider-valid tool
boundary.

**Considered and rejected:** Copying the full array into WorkstreamDO and
allowing the block to read the current transcript. One duplicates high-volume
data in the control plane; the other changes inputs after dispatch.

**Consequences:** Exact tool calls/results after compaction are retained,
pre-compaction tools are represented only by the summary, and a stale fence
fails before model inference.

### 2026-08-18 — Each HyperSight block gets a durable Bind-loop owner

**What changed:** Stable block IDs now resolve to `BlockDashboardAgent`
instances. WorkstreamDO durably fans out configured runs, each block agent uses
main `SubstreamAgent("0")` as its fenced source/runtime ledger, and result
versions settle back into WorkstreamDO. Both agent classes share Rally's
custom keep-alive and drain primitives; Bind remains the loop implementation.

**Why:** HyperSight loops can be long and must recover independently, but a
derived block is not a conversation substream and should not acquire a second
message feed or serialize another block's execution.

**Considered and rejected:** WorkstreamDO-owned inference, source-agent-owned
fan-out, one agent for every block in the work stream, Workflows, and adopting
the Agents SDK for the loop. They place compute in the control plane, duplicate
configuration ownership, couple unrelated blocks, or add orchestration and
harness abstractions without improving the existing Bind semantics.

**Consequences:** The block agent owns execution/retry while source transcript
and tool/run records remain transactionally beside the work-stream data they
reference. Tests must prove fenced reads, dispatch/result idempotency, and
eviction recovery.

### 2026-08-17 — Work-stream full loops move into `SubstreamAgent`

**What changed:** After the maintenance authority opens, one child Durable
Object directly runs each complete Bind loop, persists its dispatch and recovery
state in SQLite, streams from the same object, owns agent timers, and uses a
custom 30-second alarm keep-alive while in-memory work is active. The generic
Workflow remains for pre-cutover drain and non-workstream loops.
Both generic narration and sequenced work-stream deltas now default to the same
100 ms/2 KB batch boundary, which caps continuous presentation at 10 fps.

**Why:** A substream is the actual model-context and ordering boundary. Keeping
its full loop, transcript, tool receipts, compaction, streaming cursor, and
timers together removes a cross-primitive state machine while retaining durable
recovery through the dispatch ledger and attempt lease.

**Considered and rejected:** Replacing Bind with the Agents SDK, keeping one
Workflow per work-stream loop after cutover, and one Workflow per turn. Only the
SDK's narrow keep-alive behavior was worth porting.

**Consequences:** Work-stream run correctness must survive Durable Object
eviction, and tests must cover eviction/alarm recovery. The prior Workflow-owned
entry below records the intermediate design that this entry superseded.

### 2026-08-17 — Full loops run in Workflow and persist in WorkstreamDO SQL

**What changed:** One Cloudflare Workflow now explicitly owns one complete Bind
loop, including expected 2–30 minute runs and rare two-hour-plus Daytona coding
sessions. Work-stream leases, runs, scopes, receipts, checkpoints, and terminal
rows are served by the owning object's SQL.

**Why:** Treating a Workflow as one turn, or treating a direct Worker invocation
as the durable loop owner, loses the retry and cancellation boundary needed by
long tool-using sessions. Leaving the run ledger in D1 after transcript authority
moved would preserve a split work-stream transaction.

**Considered and rejected:** One Workflow per model turn, one continuously live
Durable Object invocation, and direct Worker-only loops. Each couples useful work
to an invocation lifetime or creates custom recovery between turns.

**Consequences:** Workers execute bounded loop slices, the Workflow retains the
durable full-loop identity, WorkstreamDO hibernation remains available between
events, and Daytona remains the coding execution provider.

### 2026-08-16 — `@juno-ai/bind` 13, and the compensating layer steps back

**What changed:** the pin moved from 12.0.0 to 13.0.0, which closes the one shape
12 forwarded into a 400 — a root union branch carrying its own composition.
`repairRootUnionForProviders` now defers to the sanitizer, returning the schema
untouched unless `nonObjectRootUnionBranches` reports something still fatal after
sanitization. `readableRootUnionBranch` is exported and asserted directly.

**Why:** two things, and the second is the one worth remembering.

The bump itself is the upstream fix specified from here, verified against the
published package before pinning. The gap shape is now dropped; the over-reach
that a careless version of that fix would have caused is absent — a composition
under a branch's *property*, one and two levels down, survives untouched, which
matters because all nine models accept it and destroying it would trade a real
constraint for nothing. Every 12.0.0 behaviour re-verified: headline repair with
`required` intact, idempotence, the Gemini dangling-`required` pruning, the
unrepairable drop, root `allOf` as an intersection, and the copy-down ceiling
still falling back to dropping. All fifteen emitted shapes accepted 9/9 live.

The second thing is that **our own repair had become worse than doing nothing.**
Bind 13 turns a remote `oneOf: [{required:["pageId"]}, {required:["discussionId"]}]`
into self-sufficient object branches every provider accepts and the model can
read. Dropping that composition first — which is what this layer did
unconditionally — threw the constraint away and told the model nothing. The layer
was correct against Bind 11, where the drop was the only thing between a
third-party schema and a 400 covering the whole request. It stopped being correct
the moment the dependency started handling the shape properly, and nothing about
the code would have said so; it would simply have kept quietly deleting
constraints. Gating it on what the sanitizer actually emits fixes that and keeps
the backstop, which a deletion would not: the gate re-engages by itself for any
shape a future sanitizer stops handling, without anyone having to notice.

The checks are now quiet — bind 13 repairs or drops every shape they were built
to catch — which raised the question of whether they still earn their place. They
do, but the reason moved: they are a regression detector on the dependency rather
than a live defence, and that only works if the rules themselves stay asserted.
So `readableRootUnionBranch` is exported and tested directly against every
measured clause, including the over-reach guard. Without that, a sanitizer change
underneath these checks could make them vacuous while they still passed. The
clauses cost roughly two hundred live provider requests to establish and are the
durable asset here; the checks that consume them are replaceable.

A future bump should expect these test files to move again, and should ask why
each expectation changed rather than making it green.

Review caught two errors in the first cut of this, both of them the same mistake
in opposite directions, and both fixed by measuring rather than arguing. The
branch predicate rejected a branch carrying its own **`allOf`**, generalised from
a measurement that only ever covered `anyOf`. An intersection is not a union: a
branch with its own `allOf` is accepted by all nine models and Bind 13
deliberately keeps it, so rejecting it would have made the repair delete a root
union the sanitizer had preserved — the precise harm this change exists to stop.
And `walkPair` assumed the sanitizer never removes a branch, which stopped being
true in Bind 13: an unrepairable root union is now deleted whole, and the walk
skipped it while `nonObjectRootUnionBranches` had nothing left to judge, so an
erased constraint passed both checks. A vanished composition is now reported as
`(composition dropped)`.

### 2026-08-16 — `@juno-ai/bind` 12, which repairs most of what the guards were catching

**What changed:** the pin moved from 11.0.0 to 12.0.0. Bind's sanitizer now
resolves a composition branch's `required` against its parent's `properties` and
copies the referenced subschemas down, so the "exactly one of these" idiom
reaches the wire intact instead of as `oneOf: [{}, {}]`. Where a branch cannot be
made usable it drops the whole root composition rather than emitting an
unusable root. The guards did not change; their *tests* did, because most of
their fixtures are no longer defective.

**Why:** this is the upstream half of the 13 August incident, specified from
here and measured against the same nine models. Verified against the published
package before pinning: the headline case emits self-sufficient branches with
`required` intact and is accepted 9/9; sanitization is idempotent; the Gemini
dangling-`required` pruning that transform exists for is intact; unrepairable
and conflicting-`type` branches drop the composition and are accepted 9/9; root
`allOf` is still treated as an intersection; and at 2000 branches × 100
properties the copy-down hits its ceiling and falls back to dropping rather than
leaving a half-repaired branch.

One shape is not fixed and is the reason both checks stay: a root union branch
carrying **its own** composition — `{ type: "object", anyOf: [...] }` — is
forwarded unchanged and is a hard 400 on grok-4.3/4.5/4.6. `nonObjectRootUnionBranches`
is now the only thing in front of it, and `repairRootUnionForProviders` is the
only thing in front of a hosted MCP server serving it. An upstream fix is
specified; until it ships this repository is the backstop.

The tests were rewritten rather than retargeted, because flipping eight
expectations to `[]` would have left checks that pass for a function returning
nothing. `weakenedCompositionBranches` keeps a positive case bind 12 still
produces — a *nested* branch naming a property nothing in scope declares, which
remains unrepairable — and the traversal test now uses unresolvable names in
each position so it still asserts the walk reaches them. `repairRootUnionForProviders`
never invokes the sanitizer, so its block is version-independent and is now the
standing coverage for the measured branch rules themselves. Whoever next bumps
bind should expect this file to move and should check *why* each expectation
changed rather than making it green.

**Note on the bump itself:** bind's versioning is a release counter, not semver
— "each published release increments the major and resets the rest" — so 11 → 12
implies no API break, and none was found. Resolving it did refresh five
unrelated range dependencies, including `wrangler` and `miniflare`; a no-op
install on the previous pin produces no drift, so that churn belongs to this
change and not to a stale lockfile.

### 2026-08-16 — The root-branch rule, tightened to what was actually measured

**What changed:** `readableRootUnionBranch` is now one predicate shared by
`nonObjectRootUnionBranches` and `repairRootUnionForProviders`, and it rejects
two shapes the previous test accepted: a branch whose own `type` contradicts its
`properties` (`{ type: "string", properties: {…} }`), and a branch carrying its
own composition (`{ type: "object", anyOf: [...] }`). No authored tool has
either shape, so nothing in the surface changed — this closes false negatives
rather than fixing a live failure.

**Why:** the original rule was written from a matrix that never tested a branch
whose `type` and `properties` disagree. Both shapes 400 on grok-4.3/4.5/4.6 with
the same root-union error as the incident, and both were being passed — by the
guard *and* by the run-time repair, which is the worse half: a hosted MCP server
serving either one would have had it forwarded untouched and failed the whole
request, which is the exact outcome that repair exists to prevent.

The two rules are worth stating plainly because both are the opposite of the
intuition. A declared `type` decides **alone** — `properties` does not rescue a
branch typed as something else, so the check cannot be a disjunction over "has
either marker". And nesting a union one level down inside a root branch does not
escape the constraint, so `{ type: "object", anyOf: […] }` is not a workaround
for a root union; it is the same rejection.

Both were found by the reviewer working the corresponding fix in
`@juno-ai/bind`, whose sanitizer faces the identical rule, and both were
re-measured here before being adopted rather than taken on report. The predicate
is shared between the report and the repair for the reason the split nearly
cost: a rule only half the codebase enforces is worse than one nobody does,
because the guard goes green on precisely the schema the repair lets through. A
future change must keep them reading the same function.

### 2026-08-16 — A tool schema is what the sanitizer emits, and that is now tested

**What changed:** The four tools that expressed an exclusive choice as a
composition of bare `required` branches — `memory_search`, Notion
`create_comment`, X `get_user_timeline`, Terminal `import_resource` — no longer
declare it in `inputSchema`. Each states it in its `description` and enforces it
where it always held, in the executor's zod parse.
`packages/agent-harness/src/tool-schema-safety.ts` adds two checks over what
Bind's real `sanitizeToolSchema` *emits*: `nonObjectRootUnionBranches` for a root
`anyOf`/`oneOf` branch xAI will not read as an object, and
`weakenedCompositionBranches`, which compares the authored schema against the
sanitized one and reports any branch that lost a `required` or came out
constraining nothing. `apps/api/test/tool-schema-sanitization.test.ts` walks
every authored tool schema in the repository through both — core, discovery,
skills, the automation architect's own four tools, the HyperSight submission
tool, Terminal, and every connector — and asserts by name that the conditional
and hand-assembled surfaces are actually in the walk.

**Why:** one line on `memory_search` —
`oneOf: [{ required: ["query"] }, { required: ["memoryItemId"] }]` — carried two
independent defects, and separating them took a live matrix across nine models
(grok-4.3/4.5/4.6, gemini-3.5/3.6/3.7-flash, gpt-5.6-terra/sol/luna).

The **fatal** one is the root-level union. Grok requires every branch of a root
union to be recognizably an object — `type: "object"` or `properties`, either
alone suffices — and answers `invalid-argument: … tool parameter root must be an
object type (root schema is an anyOf/oneOf union with a non-object branch)`,
which OpenRouter surfaces as a provider 400 covering the whole request, every
tool. Because `memory_search` is core and present on every request, all 253 x-ai
attempts in the three days after it shipped failed: default routes paid a dead
~1s round trip per turn and fell back to Gemini, so the fleet looked healthy,
while a work stream pinned to Grok from the composer's model picker got
`pinnedModelRouting`'s empty `fallbackModels`, no second candidate, and a bare
`harness_execution_failed` naming neither the tool nor the reason.

The **silent** one is the sanitizer. It prunes a `required` against the same
node's own `properties` — correct for Gemini, whose validator resolves neither
composition nor parent scope — so a branch that is *only* a `required` prunes to
`{}` and the constraint is gone on every provider. Gemini and OpenAI accept the
emptied schema and let the model send both parameters or neither.

The first cut of this change assumed the emptied branch was the xAI trigger. It
is not, and the measurement is why the guard is now two checks rather than one:
the authored branches 400 identically to the sanitized ones, restoring the
`required` does not help, and the same union *nested* under a property is
accepted by all nine models. A single "no empty branches" rule would have
flagged harmless nested cases while missing an author who writes
`oneOf: [{ required: [...] }]` at the root and never trips the sanitizer.

Review of the first cut moved three more boundaries, each of them measured
rather than argued. A root `allOf` is an **intersection**, not a union, and is
accepted by all nine models including every Grok, so the root check reads only
`anyOf`/`oneOf`; treating `allOf` as a union would have failed schemas nothing
objects to. "Emptied" was too narrow in the other direction: `{ description,
required }` prunes to `{ description }` and `{ type: "object", required }` to
`{ type: "object" }`, so the check now compares authored against sanitized and
reports a dropped `required` wherever it lands — the annotation form is *also* a
hard 400 on Grok, while the `type: "object"` form is the silent one and would
otherwise have passed both checks. And the walk missed `dependentSchemas`, the
2019-09 successor to draft-07's `dependencies`, which Bind's sanitizer does
descend into.

Rejected alternatives, all measured: pinning a `provider` preference or dropping
x-ai from the routes hides a schema defect behind routing while every other
provider still loses the constraint; giving each branch `type: "object"` alone
passes xAI but the sanitizer then strips the `required` anyway, so the constraint
is lost silently — the only structural form that both passes and survives is a
full object schema per branch, which is what the attachment tools already use;
teaching Rally to post-process Bind's output would fork the sanitizer. The
weakened-branch check asserts *constraint removed* rather than *unsatisfiable*
deliberately — satisfiability needs a solver, and a branch the sanitizer weakened
is a discarded constraint whether or not some instance still validates.

A future change must keep the guard walking the registries: the same defect in a
tool added later is invisible to a hand-maintained list. It must also keep the
two checks distinct — collapsing them loses exactly the distinction the
measurement bought — and keep the named-surface assertion, because the walk's
weak point is a tool it never reaches rather than one it judges wrongly. Three
surfaces are not in any registry and were missing from the first cut: the
Firecrawl web pair, which `createRallyTools` omits entirely without a
`FIRECRAWL_API_KEY`, and the automation architect's four tools and the HyperSight
submission tool, both built against run state. A lower-bound count cannot notice
any of them leaving; asserting the names can.

Hosted-MCP tools arrive from remote servers at run time, so no build-time walk
can reach them at all — and the exposure there is worse, because one third-party
schema fails the whole request and every other tool in it. They are covered by
`repairRootUnionForProviders` applied at `validateDynamicConnectorTools`, which
enforces the same measured rule as a rewrite instead of a report; see
[`hosted-mcp-connectors.md`](hosted-mcp-connectors.md#changelog) for why it
repairs rather than rejects.

### 2026-08-15 — A settled read receipt rebinds instead of halting the run

**What changed:** A completed *read* receipt whose positional coordinates are
reused by a demonstrably different read is now replanned in place and executed,
under an `execution_replanned` checkpoint, rather than classified
`ambiguous_external_write`. A receipt that has already settled is never handed to
`finalizeToolInvocationFailure`, which can only match a mutable row. When an
ambiguity does halt a run it now records an audit event, a
`tool_receipt_coordinate_conflict` log line, and an error on the run itself.

**Why:** A production run stopped at `needs_input` with no question to answer,
no failed tool row, no audit event, and a null error — nothing anywhere said
why. The primary model 4xx'd on its second turn without falling back, the harness
threw, and the Workflow's one retry of `run-authorized-bind-loop` re-entered the
loop with the turn counter reset to 1. That pass sees only the transcript up to
its own trigger, so it could not know two plugins had already been loaded; its
first tool call landed on `…:turn:1:tool:0`, which a completed `load_plugin`
receipt already held with different input. The receipt was read-mode on both
sides — nothing external had moved — but the collision was classified as an
ambiguous external write, and the finalize it attempted against that completed
row matched no mutable status and raised `RunOwnershipLost`: a lease failure
that had not happened, reported to the person as "waiting on an answer" on a run
that could not be retried. The same fingerprint had already stranded a second
work stream.

Review of the first cut caught three ways the reused row is not as free as it
looks, all now fenced: `run_subagent` declares `mode: "read"` but keys its child
run by the coordinate and admits one objective there; an attachment read leaves
dependency rows whose lifecycle triggers delete the invocation the rebind has
since handed to a different call; and `persistSuccessfulToolResult` passes a
static `checkpointIndex: 1`, which a replanned receipt is already past, so the
completion inserted nothing and raised `RunOwnershipLost` — the same misreported
failure this change exists to remove, one step later.

**Considered and rejected:** Scoping receipt IDs per attempt, which is the
obvious fix and removes the collision entirely — but positional stability across
passes is exactly what lets a retried pass replay a completed write instead of
repeating it, so this would trade a rare stall for duplicated external writes.
Suffixing a colliding receipt to allocate a fresh row, which breaks the tool
runtimes that correlate their own durable state by `tool_call_id`. Rebinding on
any collision, which would let a write receipt be reused. And rebinding whenever
the recorded policy cannot be proven compatible, which is the receipt-identity
fence that stops one tool's result being served for another's call.

**Consequences:** A rebound receipt discards the earlier pass's `output_ref`,
so an R2 result object can be orphaned; the transcript row for that coordinate
updates in place to describe the call that now owns it. Any future path that
mints receipt coordinates must keep them stable within a pass and must not
assume a coordinate is claimed by at most one call over a run's lifetime. The
model-facing protocol is unaffected: rebinding is invisible to it, since the
provider call ID never leaves the wire.

### 2026-08-15 — Workspace runs ask for a member reply, not a task claim

**What changed:** The workspace-authority policy now tells the model to request a reply from a
relevant connected member when personal authority is required. That member's next message runs
under their authority; the prompt no longer describes claiming the whole task.

**Why:** Connector work streams resolve execution authority per message. Claim instructions
described a removed per-thread authority pin and could send users looking for an interaction that
no longer exists.

**Considered and rejected:** Keeping “claim” as informal shorthand. It implies persistent task
ownership, while the actual authorization boundary is the author of each message.

**Consequences:** Agent-facing explanations must distinguish durable work-stream membership from
the principal of a single run. A future connector cannot reintroduce a claim flow through prompt
copy alone.

### 2026-08-14 — A provider outage is retried once and named as the provider's

**What changed:** A route plan that exhausts with a transport fault the provider
owns is re-executed up to `HARNESS_TRANSPORT_RETRIES` times (default 1) after a
clamped, `Retry-After`-aware backoff, and a run that still fails that way now
reports `provider_unavailable` / kind `provider` instead of
`harness_execution_failed`.

**Why:** A pinned work stream spent eight and a half minutes and 17
successful model turns checking out a repository, bootstrapping a sandbox,
installing, and typechecking — and then discarded all of it because turn 18's
single request produced no first token for 45 seconds. Bind classified that
correctly as a retriable transport fault and its disposition said to traverse to
the next provider or the fallback model. `pinnedModelRouting` gives an override
no fallbacks on purpose, so there was neither, and the disposition matrix
deliberately withholds a same-endpoint budget from a fault it expects to
traverse away from. Nothing was left. The gap was not in Bind's ordering — it was
that Rally never implemented the host-side retry `isRetriableAttemptError`
exists to prompt.

The pin itself was not relaxed, and must not be: an override is a request to
observe one specific model, and quietly answering from another would invalidate
the comparison it was created to make. Retrying *the same pinned model* keeps
that promise, which is why the retry lives at the plan level rather than in the
route.

The second half is a diagnostic debt the first half would otherwise have hidden.
The exhaustion path rethrew the transport's own error verbatim — right for
preserving a message, but it dropped the classification, so the outer catch saw
an unrecognized error and filed an upstream outage as `harness_execution_failed`:
*"The Rally harness could not complete this run."* The member was told Rally
broke, and the only way to learn otherwise was the raw-inference runbook. One
predicate now decides both the retry and the code, so the failures Rally retries
are exactly the failures it names as the provider's, and the two lists cannot
drift apart.

**Considered and rejected:** giving a pinned route fallback models, which would
have fixed the outage in one line and destroyed the feature — an override exists
to observe one specific model, so answering from another invalidates the
comparison it was created to make. Also rejected: retrying at the Workflow step
instead, which re-enters the whole run; the unit that failed was one request that
had produced no output and committed nothing, and replaying 17 turns of completed
side effects to recover it is the wrong granularity.

**Consequences:** The retry budget is small because each re-execution records a
failure against the per-workspace circuit breaker, whose threshold is 3 —
**raising it to 2 or more lets a single unlucky run open the endpoint for the
whole workspace**, since a budget of N means N+1 executions and N+1 consecutive
failures. The breaker is also process-local (Bind's own `circuit-breaker.d.ts`
says so), so that ceiling is per-isolate and the fleet-wide request volume during
an outage is a multiple of it; real fleet-wide protection would need D1 or a
Durable Object and is not what this is. Do not widen `isProviderTransportFailure` to cover 400,
401, 402, or 403: those are Rally's request shape and Rally's credentials, a
repeat cannot fix them, and naming them as the provider's would point an operator
at the wrong system. Meeting notes' live pass sets the budget to 0 on purpose;
its one-minute cadence is worth more than any single briefing.

### 2026-08-13 — Telemetry attributes automation only to automation-origin runs

**What changed:** Run and tool telemetry resolves an automation only when the
root harness run declares an automation origin and its work stream points to the
same durable automation run. A later person-initiated run in that work stream
stays a work-stream run with no automation identifier.

**Why:** Automation-created work streams remain usable by people. Joining any
automation row by work-stream identity incorrectly relabeled their later manual
messages and retries as unattended automation usage.

**Considered and rejected:** Treating the work stream's creation origin as the
owner of every future run. Container provenance is not execution provenance.

**Consequences:** Any new run-owner or tool-owner dimension must come from the
specific harness execution path, not merely from a related work stream.

### 2026-08-13 — Durable tool and run receipts emit content-free product usage

**What changed:** Root, HyperSight, automation, system, and inline-child runs now
emit one typed `agent_tool_started` event after a new invocation plan is durable,
then one terminal outcome from its receipt. Root runs emit a terminal lifecycle
event with bounded value/performance dimensions. Events record canonical taxonomy
and opaque resource correlations; unattended workspace execution uses a
personless workspace analytics identity.

**Why:** Tool catalogs show what a model could call, not what the product
actually used or whether it succeeded. Product analysis needs capability
adoption and run value tied to work streams and automations without turning
prompts or provider payloads into analytics.

**Considered and rejected:** Emitting when tools are loaded, capturing arguments
or results, attributing workspace automations to their creator, and letting
telemetry failure abort a tool. Those respectively inflate usage, expose content,
misstate agency, or make observation part of product correctness.

**Consequences:** Replay and ambiguous-write branches emit no new start, while a
replayed terminal receipt is explicitly labeled. The regional runtime—not
desktop ingest—owns workspace-only events. Any future run/tool dimension must
remain a bounded canonical taxonomy and must not add content.
### 2026-08-13 — Terminal activation stays allocation-free and authority-neutral

**What changed:** Supported regional work-stream runtimes register
`rally:terminal` as a deferred built-in plugin. Loading exposes one static
prompt and all eight typed tools but creates no sandbox; execution crosses into
the Terminal coordinator, which keeps its own mutation lease and rechecks its
frozen authority fingerprint.

**Why:** Models need to discover code and CLI capability before choosing it, but
discovery happens more often than execution. Allocating during activation would
couple a cheap Bind routing decision to provider cost and persistent filesystem
state. Splitting tools into inferred scopes would make a medium model reason
about a host-selected subset instead of following visible preconditions.

**Considered and rejected:** Preloading Terminal, allocating at `load_plugin`,
and exposing separate scratch/repository/publication scopes. These respectively
spend prompt/context on ordinary prose, start unused sandboxes, or make tool
availability masquerade as authorization.

**Consequences:** A region must omit the plugin until its provider gate passes;
activation cannot be used as evidence that a sandbox exists. Future built-in
sandbox plugins must keep allocation and authority checks outside Bind plugin
loading.

Shipped in the pull request for this change. Design:
[`docs/PRDs/2026-08-12_daytona-terminal-git-github/prd.md`](PRDs/2026-08-12_daytona-terminal-git-github/prd.md).

### 2026-08-12 — Revision recovery remains executable after races and resumes

**What changed:** Memory and table reads gained exact-ID selectors for revision
conflict recovery, table inserts gained a distinct bounded-contention failure,
and structured tool-failure data is now stored and reconstructed with durable
receipts.

**Why:** A content search could fail to find the item named by a conflict after a
concurrent edit, insert rows have no revision to refresh, and a Worker retry
previously lost the remediation details that Bind had shown the model.

**Considered and rejected:** Separate single-item `get` tools and a second
failure ledger. Exact selectors on the existing read tools keep the model's
sequence small, while the existing receipt already owns the durable outcome.

**Consequences:** `memory_search` accepts exactly one of `query` or
`memoryItemId`; table queries can select exact `memoryTableRowIds`; and
`error_json` may carry the same sanitized recovery object used in the model
protocol without changing participant-facing error rows. Implemented in #151.

### 2026-08-12 — Numeric tool strings normalize before receipts and validation errors become actionable

**What changed:** Every Bind tool call now normalizes an exact finite JSON-number
string only when its declared field is exclusively numeric before hashing,
planning, or execution. The schema traversal has one hard work budget, and a
redundant `number`/`integer` type uses number semantics. A caught Zod failure is
compared with both the declared input schema and any code-authored refinement:
argument failures reach the model as bounded guidance from the closest union
branch, later read failures remain external data-validation errors, and an
invalid response after a non-idempotent write becomes ambiguous rather than
retryable.

**Why:** A production work-stream model sent `"0"` for an integer attachment
offset. The executor returned the complete two-branch Zod union diagnostic as an
external failure, the model repeated the identical call, and then substituted a
partial summary for the requested complete read. The schema contained enough
information both to accept the unambiguous representation and to avoid burying the
one correctable field. Review then exposed two adjacent hazards: a branching
self-reference could consume exponential Worker time despite the depth cap, and
JSON Schema erases code-only refinements while response validation happens after
a write may already have committed.

**Considered and rejected:** Coercing every numeric-looking string would corrupt
ids, phone numbers, ZIP codes, and free text. Adding string alternatives to every
tool schema would teach models the less precise form and duplicate policy across
tool families. Catching and rewriting errors in each executor would drift and
would miss hosted or future tools.

**Consequences:** Numeric normalization is schema-guided and centralized;
string-or-number unions preserve strings, malformed and unsafe values still fail,
and `1` and `"1"` share one receipt identity. A provider schema receives at most
10,000 visits, so exhausting the budget may leave an otherwise tolerated numeric
string unchanged for the executor to reject but cannot stall the Worker.
Executors must continue stricter domain parsing, expose refinements through the
classifier hook, and let downstream Zod errors reach the harness formatter.
ESLint rejects per-tool `z.coerce.number()` and raw number-or-string compatibility
types only when reachable from a tool schema, so unrelated request parsing can
keep its own coercion policy. A non-idempotent write whose response cannot be
validated stops the run as ambiguous and is never automatically repeated.

Shipped in the pull request for this change.

### 2026-08-12 — Historical attachment results reauthorize before projection

**What changed:** Protocol transcript reconstruction now parses each completed
tool's persisted execution plan, recognizes attachment operations, and applies
the same current-principal receipt/dependency validation used by ordinary replay
before adding the assistant/tool pair. Compaction scopes use the monotonic
inventory revision, stale generated appendices are excluded from successive
summaries, and invalidated no-checkpoint replay has explicit pre-provider bounds.

**Why:** A revoked private attachment remained readable through a historical R2
tool result even though its compaction checkpoint correctly failed closed. The
same review found that one shared checkpoint, stale appendix copying, and
unbounded fallback each defeated a different part of the intended context-safe
boundary.

**Considered and rejected:** Trusting `status = completed`, attempting to scrub
arbitrary result JSON, and relying on the next compaction to repair stale
context. Authorization must happen before bytes enter the provider request.

**Consequences:** Hosts that project durable tool history must preserve the
execution plan and supply the current execution principal. Attachment list
results still re-execute, while content results replay only with exact current
visibility and derivative dependencies.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Compaction summaries fail closed across authorization changes

**What changed:** The harness exposes a required host preparation boundary before
the compaction summary call. Rally uses it to capture resource authorization,
then verifies that scope after the call, before persistence, and on replay.

**Why:** The summary itself may preserve attachment IDs and conclusions, so
keeping only the appendix authorization-aware left principal changes and
revocations able to expose model-authored private context.

**Considered and rejected:** Post-hoc summary redaction. A model conclusion can
encode private content without retaining a filename or ID, so string filtering
cannot establish authorization.

**Consequences:** A changed resource view invalidates the checkpoint rather than
reusing it. Hosts adding compaction authorization state must capture it before
the summary sees the transcript and must fail the compaction if it changes.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Compaction separates durable summary from live authorized context

**What changed:** A compaction host may now render a deterministic appendix after
the model summary. Bind applies that appendix to the live synthetic message but
hands persistence a base message containing only the unchanged summary.

**Why:** Resource awareness must survive compaction, while a shared checkpoint
must not freeze or leak the execution principal's current visibility. Keeping the
split in the harness contract prevents a host from accidentally persisting its
live authorization projection.

**Considered and rejected:** Letting the API mutate the checkpoint after Bind
applies it or asking the summary model to emit authoritative resource totals.
Both split the live shape across owners, and the latter makes current database
state depend on lossy model prose.

**Consequences:** `renderAppendix` is a required-port failure boundary when a
host provides it. It must return bounded trusted host data; persistence remains
responsible for storing only the base checkpoint it receives.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Attachment inspection replaces eager prompt content

**What changed:** Work-stream and automation policy now requires the model to
inspect a referenced attachment before answering and forbids calling a partial
read the whole resource when either exact side count is nonzero. Non-image
projection is manifest-only; validated images retain bounded current-turn
delivery.

**Why:** A plausible first 60,000 characters caused a routed model to answer
without the rest of a Markdown transcript. Correctness requires explicit
coverage, not a larger invisible cutoff.

**Considered and rejected:** Keeping eager PDF/file parts and relying on models
to infer truncation from prose. Neither provides one versioned continuation
contract across routed models.

**Consequences:** The automation compiler's fixed prompt ceiling rises from 9
KB to 10 KB for the shared attachment policy. Future prompt growth must retain
the golden hashes and explicit byte ceiling rather than deleting coverage rules
to fit the older bound.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — The automation architect accepts request-scoped attachment tools

**What changed:** `compileAutomation` can add host-authorized read tools to the
preloaded automation architect, giving them the existing `automation_*` wire
namespace without pretending they are connector plugins.

**Why:** Draft attachments must be callable from the first compiler turn, but
their authority is a per-request frozen upload set rather than a connection that
belongs in progressive discovery.

**Considered and rejected:** A globally preloaded attachment plugin and a
catalog-loaded connector-shaped plugin. Both blur who owns authorization and
make request-local resources look durable or workspace-wide.

**Consequences:** The host must provide already narrowed tools and reauthorize
inside every executor. The harness must not cache them beyond the compile call.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

### 2026-08-12 — Multimodal tool results separate live content from receipts

**What changed:** Bind can relay a JSON tool result followed by ephemeral model
content while emitting and persisting only the JSON-safe `HarnessToolResult`.
Work-stream image viewing uses that path and receipt replay rebuilds images from
reauthorized regional derivatives. The isolated attachment reader adds bounded,
verified summaries with complete or sampled-partial coverage.

**Why:** Persisting image data in a receipt makes replay and compaction unsafe,
while returning only a filename leaves a later model unable to see the image.
Large documents need a similarly bounded route that does not refill the main
conversation with every page.

**Considered and rejected:** Base64 inside JSON receipts, raw originals on
replay, and presenting sampled summaries as complete. Each trades a recoverable
reference for either unbounded durable context, a normalization bypass, or a
false coverage claim.

**Consequences:** Any future multimodal tool must keep its live `contentParts`
reconstructable from authorized regional state. Receipt consumers cannot assume
the durable JSON contains every byte the next model turn saw.

Shipped in [#144](https://github.com/juno-ai-labs/avalon/pull/144). Design:
[context-safe agent attachments](PRDs/2026-08-12_context-safe-agent-attachments/prd.md).

This log starts here. The reasoning behind everything above it predates the log
and was not recorded; do not read the absence of an entry as an absence of a
reason for any of it.

### 2026-08-12 — Deferred surfaces remain visible to host-side narrowing

**What changed:** After a deferred plugin loads, the API now replaces the
host-owned placeholder tool array as well as returning the tools to Bind.
Restored and explicitly preloaded dynamic plugins load before their activation
receipt is persisted, so that receipt always carries the discovered surface hash.

**Why:** Bind correctly exposed the activated surface to the parent model, but
inline-child construction reads the API's frozen plugin objects rather than
Bind's private registry. Leaving that object empty made an already-active
dynamic plugin inherit no read tools. The same empty placeholder had no surface
hash when a prior activation hint was persisted before Bind could call
`loadTools`, causing the next run to fail during setup.

**Considered and rejected:** Re-discovering from the provider during child
construction. That could produce a different surface from the one the parent
activated and would spend another provider call while freezing child authority.

**Consequences:** Any dynamic adapter that returns Rally-classified read tools
can pass that exact activated subset to a child. Hosted MCP currently classifies
all provider-authored tools as writes, so its tools remain excluded by the
child's independent read-only policy. A dynamic provider failure while restoring
a hint drops that hint and leaves the plugin available for an explicit later
load; it does not abort unrelated work.

Shipped in the pull request for this change.

### 2026-08-12 — Deferred plugins may load a live tool surface at activation

**What changed:** `HarnessPlugin.loadTools` lets an authorized deferred plugin
replace its empty tool array during `load_plugin`. The Bind registry receives
the loaded tools only after reauthorization, loads them once per run, and uses
the same persistence, policy, execution, and receipt path as static tools.

**Why:** Hosted MCP servers own tool catalogs that can change independently of
Rally and can vary by account. Resolving every eligible connection at run start
would waste provider calls on plugins the model never uses; resolving after
activation would expose an activation that had no callable surface.

**Considered and rejected:** Treating dynamic MCP tools as a second registry
outside Bind. That would duplicate name resolution, tool policy, serialization,
and receipts exactly where consistency matters. Eager loading was rejected for
the provider-call and refresh cost above.

**Consequences:** A dynamic plugin catalog entry can be available even though it
has no tools yet. Any caller that inherits capabilities before activation must
fall back to the frozen dynamic grant, while static plugins continue deriving
their exact capabilities from visible tools. Dynamic metadata remains remote
input and never replaces the plugin's trusted display or system guidance.

Shipped in the pull request for this change.

### 2026-08-12 — The provider SDK boundary is converted, not asserted

**What changed:** Bind's OpenAI-compatible messages and tools are explicitly
converted to Rally's `ModelMessageContentPart` and `ModelRequestTool` wire
types. The four production `as unknown as` assertions in the adapter are gone;
unsupported custom tools fail immediately and input audio is restricted to the
SDK-supported `wav` and `mp3` formats.

**Why:** The repository-wide type-escape audit found that this shipped boundary
could conceal the same category of contract drift as the work-stream cache
failure: an upstream SDK can add a union member or alter a field while the
double assertion continues to compile. Because the inference payload is also
optionally persisted for diagnostics, silently passing a new shape through
would make both provider behavior and its recorded account disagree with the
types Rally exposes.

**Considered and rejected:** Keeping the assertions behind a named generic
adapter. That would improve searchability but still accept every future SDK
variant without a decision. Mapping the variants is slightly longer and makes
the unsupported case explicit.

**Consequences:** An OpenAI or Bind upgrade that changes message or tool unions
must update the converter before typecheck passes. OpenRouter-specific request
tools remain an explicit member of `ModelRequestTool`; they do not masquerade as
OpenAI function tools.

### 2026-08-12 — Pending wake-ups are visible from the navigation

**What changed:** Every work-stream read reports the due time and a 40-character
prompt preview for its earliest pending wake-up. The navigation sidebar shows a
trailing clock for that state and lists both fields in its tooltip. Claiming,
firing, or cancelling that wake-up advances the marker to the next one; removing
the last pending wake-up removes it.

**Why:** A completed status dot describes the latest harness run, not work the
same run deferred. Once an agent scheduled a follow-up, the sidebar looked
identical to a work stream with nothing left to do; the only way to discover
the promise was to reopen it and find the earlier tool row in the transcript.

**Considered and rejected:** Returning every pending wake-up or fetching them
once per sidebar row would expose full prompts, enlarge every list response, or
turn opening the navigation into an N+1 request path. One indexed earliest-row
lookup in the existing work-stream projection supplies the only state the
marker consumes, with truncation before the data crosses the API boundary.

**Consequences:** The clock means a one-shot wake-up is pending; it does not
mean the latest run is scheduled or that a recurring automation owns the work
stream. Equal due times use the wake-up id as a stable tie-break. Older servers
are read as having no pending wake-up during rollout, and the existing list
reconciliation and poll advance or remove a stale marker without a separate
wake-up-detail cache.

### 2026-08-12 — HyperSight shares the root policy and records terminal analytics

**What changed:** HyperSight no longer supplies its separate 8-iteration,
24-tool, four-minute, and 500-cent ceilings or a five-minute Workflow timeout.
It uses the same 1,000-iteration root policy and one-year Workflow deadline as
an ordinary work stream. After the harness has made its terminal product and
usage metadata durable, the Workflow rechecks cancellation and commits the
effective terminal status before the API emits one `harness_run_finished`
structured log and one versioned Analytics Engine datapoint containing only
operational dimensions and numeric run totals.

**Why:** The earlier HyperSight bounds were not backed by the service's actual
latency, tool-call, token, and cost distributions. They could cut off useful
scheduled work before it submitted its block. Terminal summaries establish the
data needed to choose a product threshold later without using prompts,
transcripts, tool arguments, tool results, or connector content as telemetry.

**Considered and rejected:** Writing every model turn or generic loop event and
deriving the final run in Analytics Engine was rejected. Analytics Engine
adaptively samples at write and query time, does not guarantee individual-row
retrieval, cannot reconstruct exact sequences, and supports no joins. A
terminal summary is cheaper, directly queryable, and uses Bind's already
computed totals. Exact per-run investigation stays in the owning
`SubstreamAgent` runtime ledger,
Workers Logs, and Workers Traces; a future per-tool latency dataset must use one fixed-schema
point per completed tool execution rather than mixing event shapes here.

**Consequences:** HyperSight can now run far longer and spend more than before;
1,000 routed model attempts is its final loop guard. Per-tool and provider
watchdogs, read-only enforcement, cancellation, lease fencing, and
ambiguous-write handling still apply. Analytics writes are non-blocking,
best-effort, and never change the durable outcome. Failed/stopped Bind paths
mark detailed turn/model/tool timing unavailable instead of reporting their
fallback zeros as measurements. The positional schema and
sampling-aware queries are documented in
[`runbook.md`](runbook.md#root-run-analytics).

Shipped in #130.

### 2026-08-12 — Ordinary work-stream runs get 1,000 turns and no spend or duration ceilings

**What changed:** The ordinary work-stream loop now allows 1,000 model
iterations and no longer configures a maximum number of tool calls, elapsed wall
time, or model cost. The four `HARNESS_MAX_*` deployment variables were removed;
the iteration value is an explicit product invariant frozen into each run's
scope alongside the remaining catalog bound. The harness accepts all four
ceilings as optional because HyperSight refreshes, inline children, automation
compilation, and meeting-note passes are separate bounded callers. HyperSight
keeps its prior 8-turn, 24-tool, four-minute, and 500-cent ceilings because it
runs unattended. The enclosing Cloudflare Workflow step now gives ordinary
runs one year instead of five minutes; Cloudflare supplies a ten-minute default
when no step timeout is declared and exposes no disabled value, so one year is
the platform-compatible practical removal rather than a task-scale limit.

**Why:** A production repository-research run used its eighth turn to fetch the
last source it needed, then failed before the ninth turn could read that result
and answer. Every provider and tool call had succeeded, and the run was far
below its other ceilings. The fixed iteration budget therefore converted
legitimate forward progress into a terminal failure, while the other three
ceilings could do the same to longer tasks.

**Considered and rejected:** Keeping the eight-turn deployment default. It made
a routine sequence of source reads fail before synthesis. A truly unbounded
iteration count was also rejected in favor of 1,000 turns: it leaves effectively
all legitimate research room while retaining a final guard against a model that
loops forever. Removing the per-tool and provider-stream watchdogs was rejected
because they bound one stalled operation rather than the amount of useful work a
run may perform, and they are what let cancellation and failover recover from an
unresponsive dependency.

**Consequences:** A work-stream run can now continue spending model and provider
capacity without a tool, task-scale time, or cost cutoff, but a pathological
model loop still fails on turn 1,000 and the Workflow platform retains a
one-year step deadline. Scheduled HyperSight refreshes remain bounded and can
fail on any of their four ceilings. Cancellation, lease heartbeats, authority
checks, context compaction, provider watchdogs, and ambiguous-write handling
remain mandatory. Any future resource policy must be explicit about why useful
progress should terminate and which execution product it applies to.

### 2026-08-12 — Mid-stream joins resume from an accumulated room checkpoint

**What changed:** `SubstreamAgent` now folds every `stream_started` and
`stream_delta` event into an active-stream checkpoint and commits its metadata
and bounded text chunks in the same Durable Object storage transaction as the
room sequence. A room snapshot carries the accumulated text, the active turn and epoch, the per-turn
stream sequence, harness run, every seen turn, and the retry prefix boundary.
The desktop installs that text and cursor together before it accepts catch-up or
live frames.

Room cursors now live in a user-and-workspace-scoped registry above the routed
screen. The shell maintains a subscriber for every listed running work stream
that is not currently open, so changing routes hands the stream from the screen
to the shell and back without discarding its cursor or transient transcript row.
REST transcript merges retain that row while the harness is active and replace
it with the canonical final message once the run is terminal.

Canonical reconciliation also re-anchors a checkpoint first received into an
empty cache after the persisted transcript boundary. A history-gap checkpoint
is displayed immediately, then validated against the freshly fetched harness
run before the replay cursor advances; stale cached run detail is never allowed
to discard the only copy of a new run's prefix.

**Why:** The screen used to own both the WebSocket and a cursor initialized to
zero. Leaving a streaming work stream closed that socket; returning subscribed
as a first-time reader, and the room intentionally answered sequence zero with
a detail snapshot rather than replay. That snapshot contained no transcript,
because the partial assistant message does not yet exist as a final local part. A concurrent REST
refresh could then remove the partial row, and later deltas appended to an empty
bubble until `stream_completed` replaced it with the full final text.

The same missing state made a genuine first-time join worse: no client had a
prefix to preserve, and neither the final transcript nor the room snapshot could supply one. The
replay window could not be the source of truth because it is bounded, in memory,
and lost when the room hibernates. The accumulated checkpoint closes both gaps,
while committing it with the claimed room sequence prevents a snapshot from
saying it includes a chunk whose text it does not yet carry.

**Considered and rejected:** Persisting every partial assistant update as a
final transcript part would turn canonical history into an incomplete-message
store and add a high-frequency write path; the transcript remains final-only. Replaying from
sequence zero for an initial subscriber still fails after replay eviction or
hibernation and makes join cost grow with the response. Keeping sockets open for
every listed work stream would cover future scheduled runs but scale connection
count with the sidebar; background subscribers are limited to work streams that
are actually running, and a cold join reconstructs any stream the list poll has
not observed yet from its snapshot.

**Consequences:** A coalesced stream delta now updates bounded checkpoint values
in the room's existing sequence transaction. The checkpoint stores the retry
prefix as an offset into the accumulated text rather than duplicating the prefix, and
terminal lifecycle events remove it. A snapshot from an older server remains
valid because `activeStreams` defaults to an empty list. New socket consumers
must install a checkpoint's Bind cursor with its text; applying the text alone
would duplicate an overlapping catch-up frame, and applying the cursor alone
would truncate the visible response. Any future background-subscription policy
must remain scoped to the signed-in workspace and bounded by active work rather
than by total work-stream count.

### 2026-08-12 — Artifacts are gone; a run's output is its final message

**What changed:** `workstream_create_artifact` was removed from
`rally_workstream`, along with the `artifact.write` capability prefix, the R2
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
`0069_retire_artifact_messages.sql` retires only the message type, a later
release owes the `DROP TABLE`, and the R2 objects under
`<region>/<workspace>/artifacts/` have to be swept before that drop takes their
only pointers with it. [The runbook](runbook.md#finishing-the-artifact-retirement)
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
block-dashboard, activity, and scheduler inserts leave it NULL correctly, because
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
2 KB / 100 ms rule the work-stream socket path uses — `createTextDeltaBatcher`
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
under a spinner counting seconds. Nothing said what Rally had understood the
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
