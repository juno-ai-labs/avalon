# Agent harness

Rally's production loop is an adapter over `@juno-ai/bind` 16.0.0. Bind owns turn/tool iteration, plugin activation, skill registration and activation, transcript healing, completion-defect detection, streaming resets, and route execution. The owning `AgentLoopDO` Durable Object hosts every conversation loop and stores admission, leases, transcript, receipts, streaming checkpoints, and terminal state in explicit SQLite; there is no pre-cutover drain or Workflow fallback for this surface. WorkspaceDO is authoritative for workspace connector/resource/memory/policy state and cross-conversation products; regional D1 retains identity, membership, routing, migration and operational records, while R2 stores large outputs. Separate non-workstream loops may still use Cloudflare Workflows.

Each substream owns one persistent server-side, tool-using loop. A run is a
subordinate execution receipt for one activation of that loop; it never creates
or identifies the loop. The loop is not a participant, separate persona,
terminal, or general code-execution environment.

A Sidekick is drafted in a conversation of its own, and every run of it is a
conversation of its own, both `AgentLoopDO`s under the Sidekick, which is
hosted in its Organization's `WorkspaceDO`; there is no second host. The drafting tools are the loadable
`rally:sidekicks` plugin (`rally_sidekicks` to the model), available in a work
stream and in a Sidekick's chat alike and withheld from a run, and a run's loop
reads its definition from the parent by revision at start. See
[`automation-lifecycle.md`](automation-lifecycle.md).

Sidekick submission returns to the conversation loop after publication. The model
acknowledges the save, and conversational completion requires a persisted final
assistant turn. The generic `completedByTool` harness outcome does not exempt a
AgentLoopDO run from that terminalization requirement.


`runRallyEvaluation` uses the production `runHarnessWithBind` assembly from an
initial prepared scenario or a settled checkpoint. Bind owns checkpoint advancement
and forks; Rally captures its flat projection and plugin/skill activation hints.
The eval host restores configuration and isolated tool state, and allocates a fresh
loop identity per fork. Production without checkpoint capture keeps the existing
ledger path. (Session import, the one production producer of a prepared
conversation, is deleted; [its retirement record](workstream-durable-object.md#2026-11-08--retirement-records-conversation-suggestions-session-import-work-stream-origin-attachments) is in `workstream-durable-object.md`.)

A Thread's and a Breakout's first message had its own classifier
(`opening-message.ts`, with an evaluation under `evals/opening-message`); both
were deleted in plan step C-3 with Thread creation. A Canvas's or a Sidekick's
first message is addressed like any other.

Message addressing is a two-stage cascade. JEV receives every
message passed to the classifier using the optimized TypeSafe choice question and
structured state recorded by the eval. A choice is accepted only when its
confidence is strictly greater than `0.5`; exactly `0.5`, lower confidence, an
HTTP failure, or an invalid response falls through to the fixed addressing
fallback, `deepseek/deepseek-v4-flash-0731`, at low
reasoning, pinned to the exact `wafer/fast` endpoint with provider fallback
disabled. The JEV stage has a one-second owned deadline, about three times the
measured 346 ms p95; caller cancellation terminates the cascade, while the
owned deadline permits fallback. The OpenRouter leg has a 15-second owned
deadline, above the measured 10.0-11.6 second p99 range. If both providers fail
or stall, the conservative deterministic classifier is the terminal availability
floor so addressing cannot prevent the user's message from being persisted. The cascade has no
Flagship role or Worker model variable: changing
its model, provider, prompt, or threshold requires a new evaluation and deploy.
The OpenRouter fallback model list is deliberately not used on this path.
Production and staging require `TYPESAFE_API_KEY`; development without it
retains the pre-cascade heuristic/OpenRouter path so local Workers can boot
without a TypeSafe credential.
See [`jev-best-practices.md`](jev-best-practices.md) for the request-design,
evaluation, confidence-calibration, and fallback methodology behind this
cascade.

The cascade is assembled from three primitives under
`packages/agent-harness/src/jev/`, which are the harness's JEV surface for every
classifier rather than addressing's own: `client.ts` owns one TypeSafe SystemOne
request — the endpoint, the response envelope, the owned deadline, and the
`typesafe_*` failure vocabulary — and knows no decision; `cascade.ts` owns
primary, fallback and terminal floor, including the rule that a cancelled caller
propagates rather than advancing a stage; and `questions.ts` types a Choice
question so a criterion cannot ship without its include and exclude boundaries.
Addressing supplies the state, the questions, the threshold and the mapping, and
nothing else. The second caller is the semantic trigger gate in
[`semantic-activity-triggers.md`](semantic-activity-triggers.md);
[`jev-classifier-opportunities.md`](jev-classifier-opportunities.md) lists the
decisions that may want a third. A classifier's provider diagnostics go to
`apps/api/src/services/classifier-diagnostics.ts`, which writes both the
`structured_inference` log row and the archived inference record for all of them.

Every cascade emits one `addressing_classifier_outcome` log row with `success`,
the selected provider, final classification and confidence, and an outcome that
distinguishes accepted JEV answers from low-confidence and failed-primary
fallbacks. Each provider request also emits correlated `structured_inference`
rows with its request id, success, latency, and response size. The inference
lakehouse retains exact provider request and response envelopes plus usage,
including schema-invalid JEV responses, under the shared trace id; Workers Logs
keep indexed operational fields rather than duplicating message content or
credential-shaped fields. Exact-envelope lakehouse staging uses the shared
runtime deferral. In a Worker invocation that registers the work with
`waitUntil`; in the owning Durable Object, Cloudflare already keeps the object
active while its asynchronous I/O is pending and `waitUntil` itself adds no
extra lifetime. Hashing, R2 persistence, and queue delivery therefore leave the
classification critical path without becoming a bare floating promise.

The addressing classifier has a production-replay eval at
`packages/agent-harness/evals/addressing`. The raw JSONL is a caller-supplied,
ignored file that stays in an access-controlled scratch directory; only
content-free aggregate evidence belongs in Git. The runner can invoke the exact
JEV request, an OpenRouter candidate without fallback, or the production
cascade. Reports bind themselves to the corpus SHA-256 and distinguish provider
success, conditional agreement, and failure-inclusive end-to-end accuracy.
Sol adjudication also binds to the exact source-report hash so stale artifacts
cannot be joined by case ID. The provider benchmark samples the UTF-8 bytes of
the rendered provider messages and counterbalances provider order while keeping
provider fallback disabled. Provider pins in the runtime are explicit per model,
so a configured candidate cannot silently escape to an unmeasured endpoint.

Host recovery reads the persisted outcome before current principal admission and
Sidekick setup. Returning that immutable result to the durable host starts no new
provider or tool work. Fresh execution still validates its principal and reuses
that observation when filtering guest Sidekick candidates, avoiding a second
membership read for each skill resolution. Guest execution boundaries reuse
the conversation parent's `authorizeViewer` admission for access and archive state,
rather than invoking general resource authorization and then re-reading parent
lifecycle.

## Sidekick trust and activation

The host resolves Sidekick candidates once and persists their accepted instruction
snapshots with activation refs for retry. Model/tool boundary checks authorize
active sources only; a deleted unused catalog candidate cannot revoke unrelated
work. Loading a new source rechecks stored `loadable`, publication, lifecycle,
principal, workspace, and audience before activation is committed. Catalog
metadata is escaped onto one discovery line and is data, not an instruction.
Activated Sidekick content is user-authored guidance subordinate to platform
policy and the current request, and grants no tools or credentials.

## Sidekick instruction sources

The host resolves stored-loadable Sidekicks against execution and conversation audiences when the run starts and when it loads a new skill. An active Sidekick skill is then trusted for the rest of that run; withdrawing its audience does not interrupt an in-flight model or tool turn, and the next run resolves it again. The model sees these reusable instructions as Skills, with `skill-brand-voice` names and integer suffixes only for collisions (`skill-brand-voice-2`); catalog guidance and loaded instruction wrappers use skill terminology. Previously persisted `sidekick-…` aliases are projected as `skill-…` while retaining their suffixes. Conversation-owned name assignments survive retries, renames, and removal of earlier duplicates; durable activation refs and attachments retain canonical Sidekick IDs. Per-execution snapshots and loaded refs live in the owning substream; main-conversation loads also attach the Sidekick for future executions. Loading adds instructions, never credentials or access to the Sidekick memory scope.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/agent-harness/src/bind-runtime.ts` | The Bind adapter itself — registry construction, the tool loop's hooks, streaming. |
| `packages/agent-harness/src/tool-arguments.ts` | Schema-guided numeric-string normalization, blanked-optional-argument stripping, and bounded model-visible argument errors. |
| `scripts/eslint-rules/tool-input-boundaries.mjs` | Prevents individual tools from replacing the exact shared numeric-string policy with permissive coercion or compatibility unions. |
| `packages/agent-harness/src/prompts/` | Every stable prompt. Byte-stable and golden-hashed; read [`writing-prompts.md`](writing-prompts.md) first. |
| `packages/agent-harness/src/skills.ts`, `built-in-skills.ts`, `task-skills/` | The skill registry, its three bounds, and the built-in skill catalog, including procedures scoped by `ownerPlugin` and the task skills. |
| `packages/agent-harness/src/tool-activity.ts` | `toolActivityName` — the prose every transcript row is labelled with. |
| `packages/agent-harness/src/tool-schema-safety.ts` | The measured rule for what xAI reads as an object, two build-time checks over what Bind's sanitizer *emits*, and the run-time repair gated on one of them — that repair is the piece with the blast radius, since it rewrites third-party schemas. |
| `apps/api/src/runtime/harness-run-runtime.ts` | The host side: admission, the lease, run scope, receipts, terminal state. |
| `apps/api/src/durable-objects/agent-loop-do.ts` | `AgentLoopDO`: the post-cutover full-loop host, durable dispatcher, keep-alive, stream feed, steering, and child-local timers. |
| `apps/api/src/services/integrations.ts` | Context assembly and `loadRunPromptContext`. |
| `apps/api/src/services/sidekick-operation-accounts.ts` | Per-operation delegate selection, safe fallback and private debug checkpoints. |
| `apps/api/src/services/completed-tool-replay.ts` | Read-only tool-owned validation before a historical completed result is presented again. |
| `apps/api/src/durable-objects/tool-execution-account.ts` | Private account checkpoints in the existing receipt ledger. |
| `apps/api/src/services/memory-table-service.ts` | Table tool schemas, scoped access, actionable conflicts and preparation of declared tables. |
| `apps/api/src/durable-objects/workspace-memory-storage.ts`, `memory-table-definition.ts` | Atomic table/metadata receipts, structural compatibility and the shared public table projection. |
| `packages/contracts` — `readStructuredFailure` | The shape a tool's machine-readable failure half is read through. |

### Completion verification before stopping

Ordinary persistent conversation loops use the premature-stop baseline question
with explicit agent identity and participant addressing, pinned to JEV 1.14.0
with a one-second deadline. The host accepts a
stop only when JEV reports `answer_or_result` or `blocker_or_question` with
confidence **strictly above 0.70**. An unfinished or unclear result, confidence
at or below 0.70, missing trigger context, unavailable credentials, timeout, or
malformed response causes one verification reprompt. This is a narrow judgment
of stopping behavior, not a proof of factual correctness or task completeness.

The question identifies Rally as the AI author of the candidate response and
`@Rally` as a mention addressing that agent. Implicit requests and requests whose
bot mention was removed still count; mentions may name recipients, subjects or
connector tools rather than assignees. Work explicitly assigned only to another
participant stays theirs in human messages; that exception does not transfer
Rally's work to people mentioned in activation content. An acknowledgement of an
explicit instruction for Rally to wait or act after another participant or
future event is an answer/result. A separately requested immediate deliverable still has to
be judged, even when the same message also tells Rally to wait afterward.

The check runs at Bind's `onTurnWouldEnd` hook, after the model produces a
response that would end its turn and before the host finalizes the run. The
main model receives the verification prompt in its existing tool loop. It
must finish remaining work, or briefly identify what it already delivered; it
must inspect artifacts and receipts before repeating an action. The host does
not replay tools. Existing attachment grounding runs first. A grounded terminal
boundary, fixed-purpose profile, seeded demo, or nonpersistent host bypasses
this check. There is no second classifier to admit only action requests: the
four-way baseline also recognizes answers, plans and acknowledgements, as in
the eval corpus. The classifier adds up to its one-second deadline to this
terminal path, plus teammate lookup time. An unnecessary recovery spends one
additional model turn and may produce a redundant completion confirmation;
that cost is accepted to reduce missed unfinished work.

The snapshot uses the exact triggering turn, including structured elicitation
content, all user/assistant text in the current Bind projection, and current-
execution tool receipt statuses, summaries and output references. It omits
system policy and raw tool payloads. There is no last-N cutoff: nonadjacent
instructions and later corrections remain available until ordinary compaction
replaces them with a checkpoint. It does not retrieve discarded history or
automatically add another conversation's transcript. This production projection
differs from the offline suite's curated antecedents; judge errors and oversized
requests still take the verification fallback.

An initial Sidekick activation with no triggering chat message uses its
versioned definition's instructions, expected outputs, default behavior and
trigger as the request. This is the same definition used by the acting model;
it does not replace a referenced chat message that cannot be found. Otherwise,
manual Sidekick runs would always consume recovery for falsely missing context.

Authoritative lifecycle gates run before judging and again after it returns.
Cancellation, required input, admitted/executing tools, ambiguous writes, an
already-used recovery, or unknown execution state suppress verification. Every
eligible stop checks teammates, including work delegated in earlier executions.
An executing teammate, admitted or preparing input, or unavailable teammate
status suppresses verification: the existing message-delivery path owns the
reply. This is conservative at team scope and can defer a check when another
teammate is busy. Terminal compaction precedes the lifecycle check; the nudge
commit checks Stop atomically after materializing its payload, and model-turn
reservation checks Stop again before admitting another request.

The nudge is a `protocol_user_appended` transition with derived provenance
`completion_verification` and the execution ID. The same atomic commit stores
the model input and its one-use marker in `transcript_facts`; no separate flag
can commit without the message. The marker is read from immutable facts rather
than current projection links, so retry, compaction and eviction cannot reset
it. A later execution can receive its own verification. Generation, revision
and execution fences continue to protect the append. Ordinary string-valued
host nudges retain protocol-only provenance.

`completion_verification_decision` logs the mapped decision, confidence, model
and failure kind; this is a recommendation, not evidence that a prompt was
committed. `agent_completion_reprompted` records a successful recovery-prompt
commit in structured logs and regional product telemetry, with reason, choice,
confidence, threshold, requested judge model, and opaque run/parent IDs. It uses
a stable event ID per execution, emits nothing when a lifecycle gate or commit
rejects recovery, and never blocks continuation on telemetry. Join its
`harnessRunId` to `run_terminal` to follow outcomes; it does not prove provider
delivery or successful recovery. The shared classifier sink archives exact exchanges and
records usage as `completion_verification`. The
[eval suite](../packages/agent-harness/evals/premature-stop/README.md) shares the
production question and fallback mapping; its existing reports remain frozen.
The 0.70 result is exploratory: only one eligible real positive and a reused
holdout. Deterministic integration tests establish recovery mechanics,
not how often a live main model successfully finishes missing work.

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

A tool result's `contentParts` (images, audio, files) never enter that
projection, Bind's messages or the boundary hash. The harness holds them in
memory by provider tool call ID and adds them after the JSON text of the
matching tool message in the next provider request only; the request after
that carries the JSON alone. When that next request is a compaction summary,
the summary carries them, since it replaces the tool messages they belong to. A model that needs an image again asks for it
again, through `view_resource` or the tool that made it. A restart between a
tool result's acceptance and that next request loses the parts for that one
request; the JSON result, which names the resource, survives. When the object
starts, before its first projection read, the host rewrites any loop-state
tool message that still holds non-text parts, written before this rule, to its
text alone, one payload at a time (`retireInlineToolMessageContent`). It also
drops a provider-boundary record at the current revision, which hashed the old
bytes and would otherwise read as a conflicting replay.

Host context messages carry non-provider `provenance` metadata until Bind heals
the initial array. The initialization transition records an origin beside each
surviving exact message: participant and trigger wrappers point to their durable
turn/event, tool wrappers point to receipts, and compaction continuations point
to their checkpoint. The adapter
strips that metadata while constructing OpenAI-compatible messages, so it never
changes provider bytes. Runtime-created continuation nudges are protocol-only unless a host supplies
derived provenance for a durable policy decision such as completion verification;
accepted assistant messages are canonical, and a host policy transformation is
applied before either Bind or the participant transcript can accept one;
accepted tool results retain their receipt identity. The conversation host uses
that boundary to replace output after an unresolved attachment access with a
content-free provenance notice. Because the replacement is the accepted turn,
run settlement and realtime completion cannot disagree with canonical text.

On the first activation, only canonical transcript history bootstraps the
persistent Bind projection. After it, the projection is appended one admission
at a time and never re-read from the transcript — so a human turn that started
no run (one the addressing classifier judged to be conversation between people)
used to stay out of the model's context for good. The conversation object now
records how far into the transcript the projection has looked, and every
admission first appends the conversation turns between that mark and its own
admission point, in transcript order, before appending itself. Model-only
activation inputs — connector activity, scheduled wake-ups, and
Slack origin wrappers — cross a separate host boundary on every activation. Each carries full
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

Before provider I/O, the conversation host reserves the next global model-turn
index, stable turn ID, and exact participant transcript sequence, then Bind
commits `assistant_reserved` to its durable projection. Provider I/O may begin
only after both commits. The host repairs an unresolved reservation before
calling the harness again; Bind refuses to infer from a projection that still
contains one. On takeover, an explicit stop settles the reservation and ends the
execution. Otherwise the host replaces the lost preview with a canonical
interruption status pill and resumes the same execution at the next model-turn
index. That retry is safe because a pending reservation means no assistant
response was durably accepted and therefore no tool from it could have started.
A failed or stopped outcome in the still-live harness settles its reservation
before execution terminalization. If the host reservation survived but
`assistant_reserved` did not, recovery commits that missing edge first and then
settles it; neither step invokes the provider, and either may be safely resumed
after a crash.
Stream and checkpoint events for participant loops carry that same sequence.

A relocated conversation may retain the original IDs of settled historical
turns. A differing last-reservation ID is accepted only for an accepted, failed,
or stopped assistant reservation with no unfinished tool batch and an affirmative
`validateHistoricalAssistantReservation` host result. The host proves the exact
head, local reservation/transcript relationship, and next-turn counters; an absent,
false, or failing port stops the run. New reservations still require the current
loop's ID format. The next normal reservation replaces the historical pointer
without rewriting any old turn, payload, or receipt.
Host recovery uses the original reservation turn ID to find tool receipts and
elicitations before resuming the harness. The owning
[durable-object document](workstream-durable-object.md) describes that proof and
recovery path.

### Addressing

For subsequent messages that need addressing classification, a lightweight classifier returns `agent_action`, `human_only`, `both`, or `uncertain` with confidence and a terse rationale code. Explicit Rally/connector mentions and clear work requests invoke the harness. Social acknowledgement and human-only coordination can remain unanswered — including a message aimed at a teammate: the caller passes the display names of the people the message mentions (`humanMentions`, resolved from validated mention rows), and the prompt rules that a message telling or asking a mentioned person something is that person's to act on, even mid-task, unless it also asks Rally for work. The same signal gates the deterministic fast paths: an opening imperative short-circuits to `agent_action` only while the message mentions nobody, since "Please review the deck @Alex" hands the work to Alex, not to Rally. Uncertain messages invoke only when an active task or explicit tool context exists. The current message is preserved in full. Only the newest ten context messages with nonblank text are retained; empty and whitespace-only tool turns are excluded before selecting those ten. Older messages are omitted, and each retained message is bounded to 1,000 Unicode code points by keeping its opening and conclusion around a middle ellipsis. JEV receives that history in its state payload, and the model-independent OpenRouter prompt receives the same bytes: Terra uses that renderer when evaluated directly, while the hosted cascade uses it for the pinned DeepSeek fallback. The label is not exposed in the UI.

A message that invokes nothing is still a turn the model reads. The conversation object appends every such human or external text turn, and every Sidekick `conversation_post`, to the loop's projection at the next text admission, in transcript order, ahead of the input that follows it — rendered with a header saying it was said to the room, not to Rally, and naming its author (a member's `person_id`, or a Sidekick's `sidekick_id`), so the model reads it as context rather than as a request ([`workstream-durable-object.md`](workstream-durable-object.md)). An elicitation answer carries no such fill; the turns said while the question was open wait for the next text input.

In a Sidekick's own conversation (substream `"0"` under the Sidekick) the classifier's answer decides only whether an agent answers. Which agent is the Sidekick's to say when the loop takes the message: a message its sender marked as a wizard edit (`intent: "edit_sidekick"`), or an answer to what the wizard asked, is the wizard's when the sender manages the Sidekick and is refused otherwise; every other message addressed there starts a run under the Sidekick's definition with the message as its opening, from a manager as much as from anyone, and the run answers in its own conversation ([`automation-lifecycle.md`](automation-lifecycle.md#the-shared-conversation)). A marked edit needs no classifier: the mark addresses it. The conversation's own loop therefore runs only the wizard, only for a manager, and a message there always queues rather than steering.

A record-only message from the engineering bridge ([`engineering-mcp.md`](engineering-mcp.md#messages-and-text-reads)) never reaches either classifier: it starts no run whatever the room's size. Apart from it, a demo seed action is the one message the classifier never sees. It carries a `seed` ([`demo-workspaces.md`](demo-workspaces.md#seeding-a-demo-from-a-pack)) whose `assistant` turn says whether the line starts a run — present means yes, `null` means no — and the object takes that answer over the room's size and the message's attachments alike. The pack is the authority on which of its lines address Rally, and seeding a scripted conversation cannot wait on a live model's guess about each one. The field reaches the object only over its internal RPC; the message route has none.

A separate continuation classifier handles information supplied for earlier work.
`classifyMessageAdmission` composes it with ordinary addressing without changing
the addressing prompt. It receives the same bounded history, separates human
instructions from agent replies with sequence positions, and includes the current
sender. Supplied sender names identify contributors; a self-identification or
relayed report cannot stand in for another person's own required reply. A distinct
speaker list is derived from that metadata. The continuation Choice returns
three operational decisions. Separate Choices
check the human assignment and whether each required contributor has their own
author-attributed turn. All three share one request. A proposed wake-up with
unconfirmed assignment or contributor evidence uses the focused fallback, rather
than letting an unsolicited agent offer, a relayed report, or a human-owned task
create authority:

- `resume_requested_work`: the newest message completes the prerequisites of an
  unfinished human request to Rally. Use it instead of the ordinary addressing result.
- `followup_without_rally_action`: information follows earlier work but Rally
  has no ready action. Keep Rally inactive even if ordinary addressing mistook a
  partial input, human-owned task, or closed request for new work. During an
  active task or with connector addressing, keep ordinary addressing so
  continuation cannot veto signals it does not see. Addressing Rally by name
  alone does not make partial inputs ready.
- `use_addressing`: a new request to Rally, including a revision, or a message
  unrelated to earlier work. Keep the ordinary addressing decision.

When history exists and TypeSafe is configured, both classifiers start
concurrently. Continuation selects which result to use, and cancels ordinary
addressing when its result is unnecessary. It uses the same
one-second primary deadline and strict confidence greater than `0.5` as addressing.
Low confidence or failure uses a continuation-specific prompt on
`openai/gpt-6.1-sol`, low reasoning, pinned to `openai` without provider/model
fallback, with its own 15-second deadline. Addressing has an independent
15-second fallback deadline; they overlap instead of adding serially. A fallback
answer at or below `0.5`, or failure of both stages, returns `use_addressing`
to preserve the ordinary decision. Caller cancellation propagates.
Each stage has schema name `message_continuation`; final outcome logs record its
decision, confidence, and stage separately from ordinary addressing.

This is bounded conversation classification. An instruction outside the latest
ten text turns cannot be recovered. The full agent decides how to perform admitted
work; there is no new wait registration, alarm, or task lifecycle.

### Naming

A person titles a Canvas, and a Sidekick's conversations carry the Sidekick's
name. A Canvas created with no title is titled by a model from the message that
opened its Chat (`canvasTitleFromOpening` in `canvas-naming.ts`); it keeps the
title it has when the model answers nothing usable. The Thread naming pass is
deleted ([its retirement record](canvases.md#2026-11-08--retirement-records-naming-a-work-stream-work-stream-descriptions) is in `canvases.md`). The
`workstream_naming` model role serves that call and one other, the title a
long pasted text is given (`pasted-text-service.ts`).

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
and automation finalization use the same run receipt's
`external_settled_at` marker in a separate object-local
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

One `AgentLoopDO` owns one **persistent Bind loop**, not one loop per message
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
the admitted AgentLoopDO socket. Terminal remains a plugin in the same loop and executes its
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

System producers that already own a canonical trigger—such as an
automation opening input, activity, or inbound email—may prepare an unlinked
execution receipt and wake the same loop. `transcriptFenceMessageId` separates
the trigger's identity from the newest canonical turn that activation may see.
A retry can therefore preserve what caused the failed activation while moving
its upper input fence to an explicitly admitted correction. Both values are
frozen in the receipt's execution context before it is linked to the singleton;
neither value creates or identifies a loop.

After admission Rally validates the execution principal and records the run scope once, canonically hashed: principal, eligible connection IDs and capabilities, trigger policy, routing and prompt versions, tool-surface hash, and limits. A later attempt of the same run leaves that record untouched rather than re-freezing its own, because a run resumed after a Worker deploy recomputes the build half of the scope from different code and refusing the difference killed the run. **The record is not what a resumed attempt executes against.** Root tool authorization never reads it: an attempt assembles its tool surface freshly on every activation, so a resumed run's authority is its current state rather than its admitted state, and a connection added mid-run can widen it. What holds is live revalidation — the execution principal, conversation state, connection identity, owner, grants and capability are rechecked at run start, before credential decryption, before every tool call, and between model turns. Within one attempt, membership, ownership, grant, disablement and policy checks may only remove authority. Independent reads run concurrently: principal and Channel identity, active connection rows, and resident-context rendering. One final run-authority check follows all active connection checks and precedes each model call. Tool execution independently repeats the required authority and capability checks.

### Context and stable prompts

Context is assembled for the execution principal from the conversation title and objective, recent persisted messages, current and planned execution times, the run reason, and the selected trigger. An automation run also receives, from `AutomationDO.readRunDefinition` by its pinned revision, the existing Sidekick ID, definition revision, name, instructions, expected outputs, and default behavior, and `homeConversationId`: the Sidekick's home conversation (its Channel's Main or a Breakout) when a room owns it, null otherwise. A triggering activity or inbound email is added as explicitly untrusted user-role evidence, never promoted into the system prompt.

Sidekick execution policy identifies this as one activation of an existing
Sidekick, rather than a request to configure it again. Rally owns future
scheduled and event-triggered activations; completing this run does not require
creating a replacement or scheduling the next regular run. The host supplies
`sidekickId`, `runId`, `definitionRevision` and the actual trigger in a derived
user-role activation message, keeping run-specific identity out of the stable
system prefix. A schedule trigger names the existing schedule, its kind and
planned activation time; it does not ask the run to create another schedule.

Attached resources are exposed as an authorized index and hydrated lazily through tools. Their manifests and contents remain untrusted evidence. A partial read is not represented as the whole resource: the prompt requires exact cursor continuation when more coverage is needed and requires the answer to disclose any remaining `charactersBefore` or `charactersAfter` boundary. Full workspace history, unrelated resources, and another participant's private connector data are excluded.

All base prompts are rendered by typed, dependency-free functions in `@rally/agent-harness`, and the prompt version is frozen with the run. Per-run time, reason, IDs, and trigger evidence are user-role messages rather than mutations of the system prefix, so retries and route fallbacks see stable policy. One host-rendered section follows the active skill instructions: the resident context the `residentContext` port renders from the conversation's context-residency ledger ([`resident-context.md`](resident-context.md)). An active plugin may also render its own instruction section per model call from the run's live view (`renderSystemMessage`), as `rally:code` renders `# Code API` from whatever is active that turn ([`code-mode.md`](code-mode.md)); such a section is a pure function of the active set, so a resumed attempt renders the same bytes. The resident context is a pure render of committed ledger state and changes only through a compaction, where the cached prefix is already lost, or a source invalidation; during an uncompacted run a block is a tail message, appended at the settled step as a derived input ahead of any participant steer. Bind validates the transcript before inference and heals dangling or orphaned tool-protocol rows; Rally records diagnostics without adding provider-controlled text to the system prompt.

Prompt authority is layered as platform policy, authorized conversation and automation configuration, current human instructions, then explicitly untrusted provider/resource/tool data. Every run receives a compact, stable-ID-sorted catalog derived only from its already-authorized plugin registry and partitioned into `Currently active` and `Available to load`. Loading a plugin adds its guidance under `Active Plugin Instructions` (static Rally policy plus optional connected-server usage instructions, subordinate to Rally policy and the user's request) and exposes its exact typed tools on the next model turn. The catalog is stated as capability rather than as a suggestion, because the tools visible on any given turn are only the ones already loaded: an available plugin can answer a question, so consulting the catalog is part of searching, and asking a person for something a listed plugin could look up is a claim that it is unavailable rather than a request for missing input. An agent drafting an automation may use those real connector tools to inspect live provider context; it prefers reads and never performs a provider write merely to test a proposed automation. Remote account labels, resources, and provider content never become trusted plugin prose. User-authored automation draft state remains user-role context.

A new child substream may also begin with an immutable inherited-context seed.
On the first canonical Bind bootstrap only, the host renders its ordered summary
and history parts before the child's own turns. Seed material is never a system
message and never reconstructs tool calls or results, execution receipts, or
pending inputs. A persisted Bind projection already contains the prefix, and a
compaction checkpoint has replaced it, so neither path prepends the seed again.
The `full-history` and `verbatim` recipe identifiers mean all eligible
participant-authored text with its attribution, mentions, and attachment
references. They deliberately do not promise tool-history fidelity: even
participant-safe tool inputs and results are omitted rather than flattened into
text that could look like a new instruction or reconstruct an action protocol.

### Behavior policy

The agent acts on clear scoped requests, infers safe defaults, batches independent reads, prefers authorized connectors over public substitutes, and verifies material writes when a read-back path exists. It requests structured input only when a required identifier, permission, connection, timezone, or irreversible choice has no safe default. It never treats a proposed, failed, or ambiguous call as success and never retries an ambiguous write.

Every address, identifier, URL, name, date, and quoted fact in an outward-facing write must be sourced from a tool result in the run, the authorized task context, or a person in the conversation. Inferring a default settles a choice among safe options and never supplies an unheld fact, so an unsourceable value is a missing identifier that routes to a lookup or a question rather than a plausible placeholder. Identifiers are threaded through unchanged from the result that produced them and from the same connection, and a result carrying only identifiers is a step rather than an answer. These are platform policy and belong here rather than in any one connector's plugin message, because the same failure is available through every connector that writes.

Substantial interactive work starts with a brief approach; updates then focus on changes to participants' expectations or decisions they need to make. Headless runs skip progress narration. Final responses lead with the result and omit padding while retaining requested detail and material caveats. The prompt owns the writing rules; its preference for natural language applies to style only and does not relax platform policy. Private reasoning is never emitted.

The standing prompt names the product as it is: an Organization holds Canvases and Sidekicks, a Canvas's Chat is where its people ask Rally for work, and a Sidekick's shared conversation is where the people it is shared with read its runs and ask for more, each run in a conversation of its own. It names no Channel, Thread, Breakout or Space, and the task context's key for the title and objective is `conversation`. Every Sidekick run that an inbound email did not start runs on the `self_delivery` surface, whose section says what the people in the Sidekick's shared conversation see (the final message is the reply on the run's row there, and nothing sends it anywhere else), that any send to a reader outside Rally is the run's own work, done with its tools, and that it sends nothing when the instructions ask for no delivery; left silent, a run that *describes* emailing a summary has not emailed it. The `rally:conversations` plugin's run instruction says the same about the row and tells the run not to post that reply into the shared conversation again; a post is for another conversation. [`conversation-tools.md`](conversation-tools.md) owns the plugin and [`automation-lifecycle.md`](automation-lifecycle.md) the run rows.

A document-shaped request is written as a Markdown file in the conversation's terminal workspace and published as a generated resource, rather than streamed into the transcript (`DOCUMENT_GENERATION_POLICY`, `prompts/document-generation.ts`). The section carries the document-type trigger, the narration discipline, the same-path revision rule with its import recovery, the participant override in both directions, and the inline fallback when the workspace cannot be reached. It names no tool: the Terminal plugin's activated system message already carries the write-beneath-the-resource-directory-then-publish mechanics, and this section renders before that plugin loads. It is standing platform policy on every conversation run, with an explicit output-surface tie-breaker: an externally delivered run includes the complete usable result in its final message because recipients cannot open Rally resource embeds. [`terminal-workspaces.md`](terminal-workspaces.md) owns the publish path the normal conversation rule steers into.

The same module's **Sites** section is the site-shaped equivalent: a request whose natural output is a page or a small app becomes a *directory* of files, published as a live artifact people open. It carries only the trigger and the two rules a model gets wrong without it — publish the directory rather than a file inside it, and a request for a new thing is a new site at a new path — plus the pointer to the skill. The build craft is hundreds of lines and would be charged to every request, so it ships as the loadable `building-live-sites` skill and is read at the moment it matters. Like the document half it is standing rather than gated, and falls back the same way when the sandbox cannot be reached. [`live-web-artifacts.md`](live-web-artifacts.md) owns what a published directory becomes and how it is served.

An answer says what it rests on, inline (`CITATION_POLICY`, `prompts/citations.ts`). The section teaches the link form for referring to a resource in a sentence, GFM footnotes for a source that backs a specific claim, and the definition grammar the renderer actually lifts — exactly one link, targeting a `resource://` identifier or an `https://` URL, with optional words around it. It says once what to do when no identifier is in context (name the thing in plain words) rather than repeating a prohibition the working-style rule and the attachment policy already carry twice; those two answer "ask a person", which a headless automation run cannot. The *announcement* rule — the embed form for a document the run just published — lives in `DOCUMENT_GENERATION_POLICY` so there is one rule for that act. Rendered for every conversation run, interactive and automation alike, since they share one system prompt. [`markdown-rendering.md`](markdown-rendering.md) owns the renderer half, and [`slack-integration.md`](slack-integration.md) owns the reduction Slack delivery applies; the email renderer's is `markdownToEmailText` in `email-markdown.ts`.

Written answers are GitHub-flavoured Markdown, and TeX or math delimiters are never written — Unicode or plain words are used instead (`RESPONSE_FORMATTING_POLICY`, composed into the conversation system prompt). Elicitation questions and option labels are plain text because their surface does not render Markdown. The TeX rule exists because no Rally surface renders TeX and several routed models emit it for symbols; [`model-text-normalization.md`](model-text-normalization.md) owns the display-side repair this pairs with, and `prompts.test.ts` pins the rule's exact wording because that document depends on it.

### Connection plugins and authority narrowing

Tool definitions may carry optional `longRunning` metadata. Bind registration
renders a light advisory sentence in the tool description, preserving it in
`load_plugin` results and provider tool definitions. False or omission adds
nothing. This does not change execution policy or require delegation; image
generation and editing are the first producers. The parameterized harness
test in `index.test.ts` covers deferred activation and direct execution for
true, false, and omitted hints.

Every connector adapter supplies a static agent-plugin descriptor whose provider type and code-authored tool order must match its manifest. At run start Rally creates one Bind plugin per eligible installed connection, identified as `connection:<uuid>` with a stable hashed wire prefix. Its tools are narrowed to the connection's frozen grants and run policy:

- Ad-hoc runs may include workspace connections and the initiating user's personal connections that a person has not disabled. A stored `needs_reconnect` no longer removes a connection from a run — see [Stored status is a belief, not a gate](connectors.md#stored-status-is-a-belief-not-a-gate).
- Sidekick runs include the connections the Sidekick's definition bound at apply time (`readRunDefinition().defaultPluginIds` and `connectorBindings`) and eligible connections attached through the run's resources. Attached connections remain limited to the immutable grants frozen for the run.
- Inbound-email runs remove external connector writes.

Bound connections, attached resources, and previously used plugins are activation hints, not extra authority. Hints are filtered through the frozen scope and reauthorized before restoration. Other eligible plugins appear only in a bounded catalog and are discovered and activated with the always-active `rally_discovery` tools: `list_plugins`, `search_plugins`, and `load_plugin`. Search normalizes case and punctuation, ranks exact field matches ahead of distinct keyword overlap across ids, names, aliases, and descriptions, and returns at most twenty matches plus `totalMatches` so a truncated result can be narrowed. It uses OR discovery rather than requiring the entire query to occur in one catalog field. An explicit load may run a convergent host-owned `onActivate` preparation hook after reauthorization and dynamic tool loading. Successful preparation is single-flighted for the run, then activation is durably recorded before the plugin's tools or trusted guidance become visible. Failed preparation remains retryable only when the host returns model-safe retry guidance; provider details are not exposed.

The shared discovery instructions require checking both active and loadable
plugins, including built-ins, before reporting a missing capability. The Sidekick
connector catalog describes connected integrations and may omit built-in tools;
the run's plugin catalog and discovery tools provide the complete inventory.
The agent loads the relevant plugin, inspects its tools, and names a missing tool
or actual rejection when reporting a blocker, distinguishing an unattempted
operation from a failed one. This rule belongs to discovery rather than to an
individual workflow's skill.

When that durable activation belongs to a credential plugin, the host also
records its model-facing `plugin_*` ID in the automation-drafting state for the
run. Explicit loads, preloads, and restored hints all cross the same bridge.
`sidekick_submit_draft` can therefore enforce that a ready definition names
only connectors the model both loaded through discovery and inspected through
the automation catalog, without maintaining an unrelated second notion of
"loaded." Because restored durable activations deliberately skip `onActivate`,
the `rally:sidekicks` plugin prepares itself on its first tool call too: it
rebuilds completed plugin inspections and staged evaluator rules from the run's
tool receipts before validating a resumed draft. From a Sidekick's own
conversation, on a manager's marked edit, it submits a revision to that
Sidekick. Authoring reads project saved
legacy custom-MCP recommendations into the current catalog IDs, so an edit
can load and inspect the same IDs it resubmits.

`HarnessPlugin.displayName` remains trusted, code-authored prompt metadata.
`activityDisplayName` and `connectorType` are participant-only host metadata;
Bind's plugin conversion does not copy either into the model catalog or active
instruction headings. A configured custom MCP label belongs in that activity
field, never in `displayName`.

A hosted-MCP connection may supply `HarnessPlugin.loadTools` instead of a
code-authored tool array. Configured servers use their persisted discovered
description in the catalog, normalized to one line; shipped providers retain
their code-authored descriptions. After `load_plugin` reauthorizes the connection, the harness
single-flights that callback, replaces the empty deferred Bind plugin with the
returned live surface and refreshed plugin `systemMessage`, and only then
persists and exposes the activation. The
result is cached for that run in both Bind's registry and the host plugin object;
a later run discovers again. Restored or
preloaded dynamic hints materialize and hash this surface before their initial
activation receipt is written. A discovery failure
returns `plugin_tools_unavailable` and leaves the plugin inactive. The protocol,
validation, and provider declaration are owned by
[`hosted-mcp-connectors.md`](hosted-mcp-connectors.md).

Every run owns a fresh Bind registry. Canonical tool names are local to their owning plugin and contain no repeated plugin prefix; Bind adds the plugin's stable short name when it renders the model-facing wire name. The always-active plugins whose canonical names are already globally unambiguous declare an empty short name and are advertised unprefixed: `rally_discovery` keeps the global controls `list_plugins`, `search_plugins`, and `load_plugin`, `rally_skills` keeps `load_skill` and `read_skill_resource`, and `rally_core` keeps `current_time`, `request_elicitation`, `get_connector_connection_state`, and `show_connector_connection`. `rally_memory` and `rally_tables` are always active too but keep `memory_` and `table_`: `rally_tables` owns a `search` that collides with `rally_web`'s, and Bind refuses duplicate always-active wire names outright; `rally_memory`'s `recall`, `remember` and `forget` would reach the model as bare verbs with no object. The always-active `rally_core` plugin owns exact time and structured elicitation; elicitation uses `provider_key` idempotency because the receipt-derived key is also the durable question identity. `rally_sidekicks` (canonical id `rally:sidekicks`, wire prefix `sidekick_`, deferred in a room, preloaded in a Sidekick's own conversation) owns Sidekick research, the `sidekicks_list` an edit starts from, and draft submission; `rally_conversations` (canonical id `rally:conversations`, wire prefix `conversation_`) is preloaded wherever a loop has a conversation scope and holds `list`, `read`, `post` and `attach` as that scope allows ([`conversation-tools.md`](conversation-tools.md)). The canonical ids are the identity of a persisted activation and stay; the model reads only the model id, the wire prefix, and the prose. Workstream agents load `rally_workstream` by default for current-workstream context, resources, and delegation. Specialized memory and table capabilities retain their own stable plugin identities. The public-web tools live in the loadable `rally_web` plugin, and `rally_code` (canonical id `rally:code`, wire prefix `code_`) is loadable wherever the Worker has a `CODE_LOADER` binding; a Sidekick run whose definition carries saved tools also holds the always-active `rally_custom_tools` (`rally:custom-tools`, wire prefix `custom_`) ([`code-mode.md`](code-mode.md)). A runtime registers only the applicable bundles, so plugin instructions and durable receipt identities cannot advertise tools absent from that run.

In a provider-verified region, ordinary conversation runs also register the
deferred built-in `rally:terminal` plugin. It has no connection row. An explicit
`load_plugin` acquires and initializes its Daytona sandbox and prepares the
selected repository before the complete ten-tool family becomes visible.
Repository failures that the ten-tool surface itself can repair are deferred,
so `checkout_repository` remains available. A restored durable activation skips
this hook: it does not eagerly allocate on every later run, and its first tool
retains the ordinary acquisition path. Terminal is absent when the region is
unsupported; the emergency breaker keeps it discoverable but makes explicit
activation and every provider operation fail with host-authored guidance. Current
principal/resource and repository/publication checks remain executor
preconditions rather than scopes. The sandbox lifecycle and authority fence are owned by
[`terminal-workspaces.md`](terminal-workspaces.md), not by Bind.

Ordinary conversation runs with the main Azure inference credentials also
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

Loading never widens the frozen scope. At run start and before each model call, Rally verifies run authority. Each connector tool call and built-in write checks again before receipt replay or execution; built-in reads use the preceding model-call decision. Connector calls also check live identity, scope, owner, grants, capability, and disablement. Revocation drops a plugin on a new activation or denies its next tool call. A stored `needs_reconnect` does not: it is a belief about a past moment, and a call it would have withheld now reaches the provider and fails on the provider's answer. Workspace calls use the workspace principal while preserving the initiating user in audit data; personal calls execute as the connection owner. A Sidekick may select an
eligible consenting owner independently of its coordinator; ordinary
conversations remain limited to their own personal connections.

Revalidation also says why it is asking, because the two occasions need different work. An **activation** — a `load_plugin`, a restored hint, the initial preload — happens a handful of times per run and is checked all the way to the provider. A **continuation** runs before every inference and keeps the activated tool surface visible without reading the connection row again. The model boundary makes one fresh run-authority decision. Ordinary connector calls check live run authority and the connection row before receipt replay or execution. Sidekick calls reuse the inventory delegation snapshot, then check the actual selected connection before a new provider operation; retained completed results remain historical receipt facts. The execution carries its decision through credential preparation and the provider effect without another live check. A revoked connection can therefore remain model-visible until the model tries to use it, and a revocation during an already authorized tool call may let that call finish. The next call checks again. Provider credential refusal still surfaces on tool use.

Completed receipts may have a tool-owned `validateCompletedReplay` read. The
host runs it before loading or emitting the old success. A refusal is a typed
`HarnessToolReplayRefusal`: Bind returns an authorization failure and records
its rejection diagnostic, without starting execution or emitting a failure that
would overwrite the completed historical effect. Transport failures retain the
existing receipt-port failure behavior. Tools without this hook retain normal
historical replay.

Sidekick delegation uses this read to match the immutable action receipt to
the execution actor, target user, intent and source, then compare its generation
to current consent and check an allowed grant's current eligibility. Withdrawal
acknowledgements remain inspectable after membership or Sidekick access loss.
A stale acknowledgement never re-enters the consent executor or prepares a new
grant; the model reads current delegation before a new change.

Interrupted delegation writes reconcile against the same accepted action
receipt before any executor re-entry. Only an exact, current accepted action
returns its persisted outcome. Missing, superseded or unavailable acceptance
stays named and requires current grant inspection and a new delegation change;
recovery cannot prepare an old intent at a newer generation. Startup recovery
reconstructs only the delegation subset for the execution actor,
without loading authoring tools or creating a Terminal sandbox. The result is
stored through the normal R2/receipt path before the repaired transcript can
claim success. A proven recovered result can settle an already-ambiguous
receipt through its existing reconciliation flag.

### Sidekick operation accounts

A Sidekick inventory includes its eligible delegates' connections. Its coordinator
continues to own the run, conversation and personal run preferences; selecting a
provider account does not replace that identity or grant human access. The tool
inventory loads delegation through WorkspaceDO's ordinary authorization view;
continuations and new runs rebuild that snapshot. Background model/tool boundaries
read only the root lifecycle and stop generation, without rescanning delegates
or changing the coordinator. Selection stops at an eligible preferred user;
audience-constrained selection never checks unrelated grants. Matching evaluators
reuse pending eligibility only within one matching request; queued delivery
checks independently. Each call reuses the inventory snapshot and
checks the actual serving connection and capability before credentials are
prepared. No healthy operation adds a provider access probe or revocation barrier.

Each operation starts with the selected plugin's connection, then tries configured
source connections, the creator and remaining eligible delegates in stable grant
order. Duplicate connections are tried once. Only adapter-marked pre-effect
access refusals permit fallback; cancellation, empty results and uncertain failures
do not. Remote MCP tools retain their selected connection because inventories
may differ across accounts. There is no `rallyAccount` selector or special handling
of inboxes, named senders, replies, returned IDs, handoffs or page continuations.

The existing receipt checkpoint log records `execution_account` selections before
write dispatch, definite write refusals, and the account that served the write.
Reads neither look up nor append account checkpoints. Write checkpoints retain
first selection, actual principal, connection and grant generation for database
queries. This debug information is not projected into app activity or tool output.
Recovery of the exact same uncertain effect retains its original account and
provider key; separate operations select independently. Normal lease and
cancellation fences apply, with no synchronous cross-object revocation barrier.

`composeBeforeToolCallHooks` runs policies in order, stops at the first denial,
and carries the last supplied authorization context through to execution. A
context may be falsey, including `false` or `null`; only `undefined` means none
was supplied.

Initial preload and restored-hint authorization checks run together. Rally then prepares and persists successful activations in stable plugin order. Bind receives precisely the IDs this host just checked and persisted, so its immediate in-attempt rehydration restores them without repeating their connector row, credential, and provider health checks. Hints supplied without that current-attempt evidence receive concurrent live activation checks, with results applied in hint order; a later explicit load also checks live. Bind's eligibility gate and dynamic tool loading still run during restoration, and the model boundary still checks run authority before provider I/O.

A built-in plugin carries no credential, so its authorization is settled by the run scope alone and can never be indeterminate. Built-in reads spend the authority checked before their model turn; built-in writes recheck live run authority before receipt replay or execution. A revocation during model inference can therefore allow a resulting built-in read, while a write is freshly fenced. The set of built-ins that hold that authority is derived from the plugins the run registered — registration is already the conditional decision, since Terminal is absent without its provider configuration, `rally:web` without `FIRECRAWL_API_KEY`, multimodal generation without the Azure inference pair, and `rally:code` without `CODE_LOADER`. An id the run does not carry, whether invented by the model or restored from an activation hint a later deploy stopped registering, is denied.

Revalidation answers with one of three verdicts, and the third one is the point of having them. `authorized` activates; `denied` is a decision about authority — a revoked credential, a withdrawn grant, an owner who no longer holds the connection — and reaches the model as `plugin_not_authorized`; `indeterminate` means the host could not reach a decision at all, because the provider timed out, the transport failed, or the health check answered something that says nothing about this run's authority. Both non-authorized verdicts leave the plugin inactive, so the distinction costs the run nothing, and it is what stops a provider hiccup from being reported as a permission problem: an `indeterminate` load returns `plugin_authorization_unavailable`, and the host logs `connector_plugin_reauthorization_failed` with the connection and the underlying cause rather than discarding it — a connector's own code, or the failing paths of a schema rejection, as `code` ([`naming-a-schema-failure.md`](naming-a-schema-failure.md)). An adapter distinguishes the two the same way, through `reconnectRequired` on its health result. A verdict must never be derived from a swallowed exception — a failure to verify is not a denial, and reporting it as one sends a run off to explain a permission problem that may not exist.

All four non-success activation outcomes — unavailable, unauthorized,
authorization indeterminate, and deferred tools unavailable — use typed thrown
failures. Bind therefore emits `tool_failed`, the host stores a failed receipt,
and the model sees `success: false` with a stable code and recovery action. A
returned result containing an `error` field would instead be a completed tool by
protocol and is forbidden for these cases.

The existing Sidekick plugin exposes delegation during direct and autonomous
work. The host supplies the execution actor; model input selects the Sidekick,
any current Organization userId, and allow/withdraw intent. Creator enrollment
is automatic for every creation path. There is no human-speaker classifier or
special quoted/event-consent guidance. Authoring, activation and room
presentations retain the `sidekick_…` wire prefix.
[Sidekick lifecycle](automation-lifecycle.md#delegation-consent-authority) owns
the consent authority; loading these tools starts no run and grants no account
access. Sidekick activation prompts carry permission-recovery guidance directly,
independently of the authoring plugin: report unresolved work once through the
existing conversation post, and never claim delivery after a refusal.

### Skills

A plugin gives the model a capability; a **skill** gives it a procedure. Skills are markdown instruction modules — how this workspace triages a queue, what a handover note must carry, the house voice — disclosed in the same three tiers the plugin catalog uses, because a workspace's accumulated know-how does not fit in a context window while a catalog line costs about fifty tokens.

A run's skills are **frozen with its scope**, exactly like its plugins. The host resolves them against the execution principal before admission and passes them on `RunHarnessInput.skills`; nothing in the loop reaches a store, so `load_skill` can only surface a body the run was already authorized to read. When a run has no skills, neither prompt section nor either tool appears.

No loop recommends skills: the `rally_skill_recommendations` plugin and its `list_skill_recommendations`, `recommend_skill` and `unrecommend_skill` tools went with Threads, because a Sidekick is no longer something a conversation owns or recommends. What remains of the ordinary-loop `rally:sidekicks` variant is the Sidekick delegation tools, under the model id `rally_sidekicks`, offered only to a user principal. Sidekick authoring remains a separate surface; the product still calls these saved sources Sidekicks.

The always-active `rally_skills` plugin owns two globally named controls. `load_skill` takes an exact name from the `# Skills` catalog and adds the skill's body to `# Active Skill Instructions` for the rest of the run. `read_skill_resource` reads a bundled reference file, and refuses until its skill has been loaded — that gate is what stops a model pulling every catalog skill's references without taking on the instructions they belong to.

**Loading a skill grants no authority.** Where a skill declares an owner plugin it is offered only to a run whose scope already includes that plugin — the eligible plugin ids are handed to the skill registry, which drops the rest before the catalog is built — and loading it *names* the plugin for the model to load separately rather than activating it: an auto-activation would let a document issue a capability grant. Skill bodies are also not trusted prose about the world — they are workspace-authored instructions, and are wrapped in a `<skill_content name=…>` element so the model can tell them apart from platform policy and from one another.

Three bounds keep a looping model from loading its way into a context-limit error: a count cap, a budget over the total tokens of loaded bodies, and a byte cap on a single `read_skill_resource` response. Bind judges the first two (`admitSkillLoad`); Rally measures the token half by resolving the bodies the load would actually inject, and applies the third itself — an unbounded Tier-3 read would otherwise route around the Tier-2 budget, since a skill whose body fits can bundle a reference that does not. All three are configurable, through `maxActiveSkills`, `maxActiveSkillBodyTokens`, and `maxSkillResourceBytes`.

The package ships thirteen skills of its own (`BUILT_IN_SKILLS` in `@rally/agent-harness`), for a host with no library yet. Seven are unowned and offered to ordinary runs: `deep-research`, `writing-an-email`, `scheduling-a-calendar-event`, `using-the-local-inapp-browser`, `using-external-structured-data`, and the two task skills described below. The other six each set an `ownerPlugin` and are offered only to a run whose scope already carries that plugin: `polling-for-events` below, `tracking-seen-or-done-items` owned by `rally:tables`, `building-live-sites` above, and the three AI-chat readers — `reading-an-ai-chat`, `reading-chatgpt-conversations` and `reading-claude-conversations` (`reading-ai-chats-skills.ts`) — owned by Rally's browser plugin, `avalon:browser`. The generic reader is written against what every chat page must have (conversation data the page loaded, messages with authors, ids and parent links) rather than any markup, and ends in a self-check against the page; the provider companions carry routes and shapes as hints to verify, so a provider redesign degrades to the generic procedure instead of a wrong import. The email and calendar skills are deliberately provider-agnostic — they name no connector and no tool, because the failures they exist to prevent (an address composed from a name and a domain, a fact quoted from memory, a guest list replaced when one attendee was meant to be added, a write reported as done without a result confirming it) belong to the task rather than to any one provider, and the next mail or calendar connector will carry them too. Neither sets an `ownerPlugin`, so neither implies that loading it granted the connection it describes.

**Task skills** live in `packages/agent-harness/src/task-skills/`, one folder per skill holding its `skill.ts`, collected as `TASK_SKILLS` and spread into `BUILT_IN_SKILLS`. A task skill is named for an outcome a person asks for rather than a capability: it reads the request, settles what has to be decided before work starts, and names the procedure skills that do the work. `reporting-on-data` finds every connected source that holds part of an answer, names the keys that join them, and slices the joined records the way the person asked, deferring row-level reading to `using-external-structured-data`; it reads a zero, an unmatched filter value or a late source as a finding to caveat rather than a failure, and only a source that did not answer as a failure of that one section; its body carries a section for a Sidekick wizard, which maps the shape of all accessible data and shows the person a plan for combining and slicing it before saving that plan as the run procedure. `creating-an-app` reads "an app" as a live web site, turns a clear iOS or Android request toward a site because Rally builds no native apps, and builds an open site without asking when the app saves nothing people add (a character counter, a converter, a calculator). An app that saves what people add needs Rally sign-in, by default so the site knows who added what (a visitor signs in from the site and comes back), so the one question it may ask, before the first file, is whether those entries are shared or private (`private_to_viewer`). An anonymous poll, survey or feedback box stores answers without who sent them; anyone on the internet can submit to any site, so a public poll just accepts requests without a viewer id. It then hands off to `building-live-sites`. Neither sets an `ownerPlugin`, so a run without Terminal can still route an app request and say what it needs instead of the skill vanishing from the catalog.

`using-external-structured-data` owns the source-handling procedure shared by
sites, reports, imports and other outputs. It has no owner-plugin gate; local-file
steps require Terminal separately. See [the skill](../packages/agent-harness/src/using-external-structured-data-skill.ts)
for its direct-processing and Terminal paths. `building-live-sites` references
it while retaining site-specific recovery, formats and publication.

`using-the-local-inapp-browser` is unowned so its limitation guidance reaches
ordinary conversations that lack browser tools. [Agent profiles](#agent-profiles)
declare their own complete skill catalogs.

The API also offers `reading-google-meeting-notes`
(`google-meeting-notes-skill.ts`) when the frozen catalog contains a Google
connection with Calendar, Drive, or Docs read capability. The host binds
one copy to an eligible connection's canonical id; it is not in the globally
offered `BUILT_IN_SKILLS` list because connection ids vary per run. The procedure
can compose separate Mail + Calendar and Drive + Docs connections. It reads a
known or Calendar-attached Doc first, searches Drive for missing artifacts, and
keeps generated notes distinct from transcripts. Its bundled storage/access
reference records official Google sources, including unattached manual notes,
current and legacy Drive folders, shortcuts, and independent sharing rules.
Loading it activates neither its owning connection nor the other Google preset. A shared Google credential still appears as separate
Mail + Calendar and Drive + Docs + Sheets plugins. The host freezes each view's
capabilities and activation independently, while joining their capabilities by
connection ID for run scope; see [Google connector views](connectors.md#google).

The standing system prompt defines Sidekicks and their separate activation
conversations. The Sidekicks plugin and automation-specific Terminal guidance
explain shared files, execution-user access, and overlapping updates when those
facts are needed. The tracking skill keeps completion records and output claims
in durable tables. Public help also feeds the rendered manual, Markdown, search
index and full manual for model readers; those descriptions must agree.

`polling-for-events` owns trigger selection and source-resource lookup. Its
catalog covers actions after external changes, including site refreshes. It
branches between explicit schedules, supported events with resolved bindings,
and polling justified by a concrete event/filter/resolution gap. Saved run
instructions retain that rationale; a search miss does not establish an
unsupported event. `building-live-sites` carries the saved refresh procedure:
back up local files and import the current published source into the original directory,
preserve its publishing conversation and consumer data format, reconcile all
eligible source records, then verify publication. Each refresh claims the shared
output before import and compares complete, programmatically transformed source
records against the current publication, including on the first run. A handwritten
record array inside a script is not a source transformation. Initial publication, Sidekick
activation and a successful refresh are distinct outcomes.
The event skill composes with `tracking-seen-or-done-items`, which owns shared
ledgers, claims, recovery and baselines. Notification backlogs may be baselined
from the watch's start, but synchronization must first reconcile the real output;
an empty tracking table is not evidence that output is current. The tracking skill is owned by `rally:tables`
rather than `rally:sidekicks` so execution runs can load it without authoring
tools. The skill bodies are the procedures; this document records their scope.

All of them are offered to every production run the API starts, subject to the owner filter. Nothing is withheld by surface. A skill
is advice, and what a surface may *do* is settled in the tool loop. Offering is
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
   separate terminal signal for child and generic non-conversation executions.
9. Run external-platform delivery only after reloading a saved canonical turn:
   the exact terminal turn normally, or the open elicitation turn while waiting
   on a person. Status cleanup and suppressed-delivery receipts may run without
   one; reply or comment content may not.

Web discovery and page reading are bounded Firecrawl tools. Search returns ranked links and page fetch returns clean markdown. Both are omitted without `FIRECRAWL_API_KEY`; an inbound-email run holds them like any other, per [`security.md`](security.md).

### Elicitation

The canonical `request_elicitation` tool belongs to `rally:core`, which carries no wire prefix, so the model reads it as `request_elicitation`. It creates a typed text/radio/single/multi-select block and pauses the shared harness loop. The request row retains the stable original tool slot. When a person answers, the loop atomically accepts one tool result containing that answer (`answer: null` with `skipped: true` when they skipped, `cancelled: true` when a newer message cancelled the question; the tool's description tells the model not to ask a skipped question again) and promotes the visible participant response before any later provider call. The participant turn is canonical UI history, not a second Bind user message; the model therefore receives the answer exactly once through the suspended tool protocol. Original tool-call position and dense result-acceptance order are separate identities, so another result accepted while the elicitation waits does not renumber either fact. In a conversation, the conversation becomes `needs_input`; a valid answer clears attention when no blockers remain and activates the same `AgentLoopDO` loop. When drafting an automation, the agent first saves its best partial state with `automation_submit_draft` (a revision that is not `ready`), then calls the same core elicitation tool; the next turn resumes from the saved draft and the answered conversation.

### Seeded runs

A run a demo seed started is an ordinary run with one substitution: the source
of model output. Its execution context carries the seed, and
`runWorkstreamHarness` sets `OpenRouterConfig.fetch` — an injection point the
client already exposes for exactly this purpose — to a function that answers
the run's one chat-completion request from the seed's turn, in the streamed
form every run asks for, and answers everything else emptily so nothing
leaves the machine. A second chat-completion request is refused with a 400 the
client does not retry on the same endpoint, and a seeded run carries no
fallback models, so that refusal is the run's failure rather than the first
of several. The seam covers the OpenRouter client and nothing else, so the
seeded run is routed where the seam is: `demoSeedModelRoute` keeps the
resolved primary model when it is not Azure-bound, otherwise takes the first
unbound fallback, otherwise a fixed unbound id, and the run's config omits the
Azure transport. An Azure-bound model such as `x-ai/grok-4.3` is tried there
first, and a seeded run left on it would be answered by a live model, never by the seed.
The id is only what the run records about itself, since the seam answers
whatever name the request carries. A seed has one turn because a
seeded run makes no tool calls, and without tool calls the loop asks once. The
seam covers the client it is handed to. Prose ends the loop as
`completed`; a question is a call to the real `request_elicitation` tool
with validated arguments, and the run parks on `needs_input` like any other.
Tools, plugins, receipts, activity rows and settlement are the ordinary path,
which is what makes the seeded turn history rather than a row written to look
like it. The run an answer to that question resumes is built from the answer,
not from the seeded context, so it is never seeded. Owned by
[`demo-workspaces.md`](demo-workspaces.md).

### Durable receipts and terminal state

Google plugin splits retain compatibility with verified earlier receipt
identities. The host reconstructs the complete prior tool surface under the
original canonical ID, for the same connection and currently granted operations.
The normal operation, capability, mode, retry-policy and input-hash fences still
apply. Pre-pagination surfaces are accepted only for unchanged operations.
Identity aliases alone never authorize replay. This also supplies prior request
plans to idempotency lookup, so a retry does not repeat an external effect merely
because its plugin was split.

Authored pageable tools use [receipt-owned page IDs](tool-pagination.md). Their
first-call schema has no cursor; `_next` accepts only a page ID. Private executor
continuations are removed before output reaches Bind or the result receipt.

Each tool call receives a stable Rally receipt ID derived from the run, model turn, and original tool position; the provider call ID remains only in the model protocol. A tool that starts work outside Rally keys it to `HarnessToolContext.effectIntentId` instead, which the host resolves through `resolveToolEffectIntentId` after `tool_started` and which names the stored receipt row rather than the call: the row is created once and kept, so a resumed attempt reattaches to the effect it already started instead of starting a second one. The owning `AgentLoopDO` stores canonical inputs, immutable plan hashes, plugin/connection identity, mode, idempotency policy, optional provider key, and append-only progress in `tool_effects` and `tool_effect_checkpoints`; there is no D1 compatibility owner. Completed receipts retain provider operation IDs. Successful output is written to regional R2 and then committed to the current regional conversation authority before Bind can observe it. A `code_execute` program's nested calls are receipts of their own at `<program toolCallId>:call:<index>`, planned, looked up and settled through the same host functions a direct call uses, with no transcript rows of their own ([`code-mode.md`](code-mode.md#nested-calls)).

If the object is evicted after `assistant_accepted` but before every
`tool_result_accepted`, Bind does not repair the protocol array. Before another
provider request or pending input can cross the loop boundary, the host walks
the missing call positions against their durable receipts. A completed or
failed receipt becomes the corresponding exact tool result; an admitted call is
terminalized as `not_run`; an executing *read* is failed. An executing **write**
is not classified from its status: the host re-enters the tool over that same
receipt, through `reenterInterruptedWriteForRecovery`. Terminal and consent
recovery build their owning plugin directly. Authored connector writes with
provider keys reuse ordinary inventory construction and invoke only the owning
tool; unused plugin clients are disposed without activation. Remote MCP tools
cannot opt themselves into this recovery contract. A tool that
declares `HarnessTool.reenterable` either resolves its own durable effect from
the receipt — `run_command` reattaches to the `terminal_tasks` row its
`effect_intent_id` names — or carries a `HarnessTool.reconcileEffect` that
establishes what the attempt did without performing it. The host consults the
reconciler first: `landed` returns its result and the executor is never
reached, `not_landed` is the only licence to run the tool, because it says the
external effect is provably absent and the call is therefore a first execution,
and `unknown` leaves the attempt unresolved. `publish_resource` needs one,
because its executor resolves a document by `(work stream, published path)` —
what is published there now, not what this attempt published — and would swap
the stored content whenever the sandbox file had moved on; its reconciler reads
`resource_versions` instead, which is append-only and carries each revision's
`author_run_id`, so a publication this run made inside the receipt's window
reads as landed even after somebody else has revised the document away. A
`provider_key` tool is re-submitted under the key its receipt was admitted with,
never a fresh one; a missing original key cannot be reconstructed. Calendar
creates use that key as their event ID and read back a duplicate through the
original account when the admitted arguments name a stable calendar ID. Omitted
defaults and calendar names cannot be reconstructed safely and stay unresolved.
The host passes its existing replay marker to adapters for this check.
Observed withdrawal leaves recovery unresolved until that
same delegate is eligible again, including for an Organization connection.
Only a tool that is not re-enterable, a plugin that cannot be
built, or a re-entry that threw settles `ambiguous_external_write`, and the
receipt, the `harness_interrupted_write_reentry` log line and the model's tool
result all name the tool and the reason. Results are appended with their
original call index and a separate dense accepted ordinal. A residual ambiguity
settles the whole tool batch and the cycle **continues**: the repaired protocol
array already carries the ambiguity as a failed tool result telling the model to
check the call before repeating it, and the model is the only reader able to act
on it.

Before the input hash or any host hook sees arguments, the harness walks the
tool's original execution JSON Schema and applies three normalizations. First,
it removes synthetic nulls advertised for independent optional non-nullable
top-level scalars. Existing semantic nulls and referenced properties stay intact.
The model-facing schema supplies this explicit omission alternative; it does not
change the executor contract. Next, it normalizes
a string only where the field
is exclusively numeric and the complete string is a finite JSON number. Unsafe
integers and ambiguous string-or-number fields remain strings and fail or parse
under the executor's normal contract. A redundant `number` plus `integer` type
uses number semantics, because number already contains integer. One shared
10,000-schema-visit budget covers normalization and union mismatch scoring, in
addition to the depth cap, so a provider-controlled recursive branching schema
cannot turn the walk exponential. This makes a medium model's `"0"` and the
preferred `0` one canonical receipt identity without turning numeric-looking
resource ids or free text into numbers. On a tool whose `mode` is `read`, it also drops an
**optional** property whose value is `""` when that property's schema declares
the empty string is not one of its values — `minLength` of at least 1, a `type` without `string`, or an
`enum`/`const` excluding it, composed through `$ref`, `allOf`, and every branch
of an `anyOf`/`oneOf`. A required property keeps the blank so validation names
the field, an undeclared key keeps it so a strict parse still reports it, and a
schema this walk cannot read keeps it too. A **write** keeps every blank,
because there `null` and absence are different requests — clearing a field
versus leaving it alone — and choosing between them is the executor's to refuse
by name, not the harness's to guess. So does anything nested inside a value,
and any schema carrying `if`, `then`, `else`, `dependentRequired`, or
`dependentSchemas`: requiredness there is answerable only per instance or by
merging an ancestor's branches, which is a schema evaluator's job. Requiredness is itself resolved
across the composed schema rather than read from the node carrying `properties`,
since a generated schema commonly separates the two, and a walk that cannot
finish drops nothing. `{}` and `{ after: "" }` are
therefore one receipt identity. What that is for, and the obligation it puts on
a tool's schema, is
[`agent-tools.md`](agent-tools.md#1-fail-loud-never-silently-ignore-an-input).
Executors remain the enforcement point.
When one throws a Zod error, the harness checks the normalized input against the
tool's original execution JSON Schema and any code-authored `validateInput` refinement:
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
Incomplete safe reads may resume, and so may an incomplete `provider_key` write
whose plan, request hash and provider key all match the call asking to run —
`admit` answers `resume_write`, because the provider collapses two calls
carrying one key. A reused or mismatched plan, a provider key that differs from
the admitted one, or an incomplete `record_before_execute` write becomes
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
tool again rather than returning the JSON inclusion summary alone. Terminal's
`view_image` has no such derivative to rebuild from, since its picture is a file
in the sandbox, so the host always invalidates its completed receipt and reads
the file again. No data URI
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

Each agent's default model and its fallback stages are one Cloudflare Flagship flag, resolved once per run and evaluated against the region, the environment, and the run's subject — the workspace, conversation, and user, each carrying the attributes a targeting rule matches on; the regional Worker variables remain the checked-in default that an absent flag, an unbound binding, and a failed evaluation all resolve to. [`feature-flags.md`](feature-flags.md) owns the flag keys, the value shape, and how a model change is rolled out.

Standalone structured-output agents enter through `runStructuredInference`. The gateway resolves the role's flag, constructs the provider client, combines any caller cancellation with a two-minute ceiling, and emits redacted diagnostics for every request, repair, validation, fallback, and completion stage. ESLint prevents API feature modules from constructing `OpenRouterClient`, reading model-selection variables directly, or removing the gateway's signal and diagnostic hooks. The harness package has a separate portability boundary: production sources cannot import database, connector, API, or Node-only implementations and cannot read `process`; host capabilities arrive through explicit ports.

Provider routing is deterministic and versioned by Bind. Rally contributes a
checked-in canonical-model binding and one planner transport per provider; Bind
resolves the policy, filters candidates against the turn's actual capabilities,
builds the Azure/OpenRouter/model stages, operates their shared circuit breaker,
and executes traversal. `x-ai/grok-4.3` and `x-ai/grok-4.6` are Azure-bound:
their same-model route is Azure first and OpenRouter second.
`openai/gpt-5.6-sol` is hard-fenced to Azure only; an Azure outage or missing
price fails that model stage instead of sending the expensive same-model call
to OpenRouter. That fence has no slack in it, so a request Azure *rejects* ends
the run rather than degrading: every tool schema is corrected to a plain object
root at `toModelToolDefinitions` for that reason, and
[`agent-tools.md`](agent-tools.md) carries the rule an author has to follow. Other canonical models remain OpenRouter-only. A file-parser request, audio input, or another
capability an Azure binding has not proved skips that candidate before any
network request rather than sending a body the deployment may reject.

Inference defaults that belong to a model rather than to one task live in the
harness's canonical-model defaults registry. Models absent from that registry
send no reasoning control and therefore retain the provider default. Omission
accepts the registry setting when present; an explicit task/run effort,
including structured inference's `none`, overrides it. Model flags may carry
`reasoningEffort` (`low`, `medium`, or `high`) for the entire route, taking
precedence over the registry but below explicit task settings. `x-ai/grok-4.6`,
`google/gemini-3.7-flash`, `google/gemini-3.8-flash` and `openai/gpt-6.1-sol`
currently default to `low` everywhere: routed conversation turns and direct
structured or streaming OpenRouter calls all resolve the setting
(`reasoningEffortFor`) after the actual primary or fallback model is selected.
The registry marks Grok 4.6 and both Gemini Flash models `reasoningRequired`,
because their providers refuse `none` ("Reasoning is mandatory for this
endpoint"); a task's `none` is served at that model's default there, so a
fallback can still answer a call whose primary runs without reasoning.
Tool-bearing requests also opt in to parallel tool calls on both OpenRouter
and Azure; requests with no tools omit the field.

The two transports speak different APIs. A streamed OpenRouter turn goes to
the Responses API (`/api/v1/responses`); an Azure turn goes to Chat
Completions. Structured calls and embeddings stay on OpenRouter's Chat
Completions and embeddings endpoints. Bind's transcript and storage keep the
Chat message shape; only the OpenRouter client translates, out through
`toResponsesInput` and back through `createResponsesStreamReducer`.
`openRouterResponsesRequest` is the one builder: Bind builds the body once,
archives it, and hands it to the client to send as-is.

The checked-in Monad production bindings were verified against the live
`monad-prod-resource` deployment details on 2026-08-30 for Grok and on
2026-09-02 for Sol:

| Canonical model | Azure deployment | Version / lifecycle | Deployment | Live quota | Guardrail |
| --- | --- | --- | --- | --- | --- |
| `x-ai/grok-4.3` | `grok-4.3` | `1` / Preview | Global Standard | 250,000 TPM / 250 RPM | DefaultV2 |
| `x-ai/grok-4.6` | `grok-4.6` | `1` / Preview | Global Standard | 2,250,000 TPM / 2,250 RPM | DefaultV2 |
| `openai/gpt-5.6-sol` | `gpt-5.6-sol` | `2026-07-09` / Generally Available | Global Standard | 2,500,000 TPM / 2,500 RPM | DefaultV2 |

All three accept Chat Completions at
`https://monad-prod-resource.services.ai.azure.com/openai/v1/chat/completions`.
The Foundry deployment's generated sample defaults Sol to the Responses API,
while its model details explicitly list both Chat completion and Responses;
Rally uses the already-supported Chat Completions surface. Sol accepts text and
image input, returns text, supports agent tools, and has a 1,050k context window
with a 128k output limit. Its version policy upgrades when a new default version
is available, and the deployment has no spillover or priority target.
Manual inference probes returned token usage but no dollar `cost` or `price`
field. A repeated synthetic streaming Responses request in the live Foundry
playground carried the `web_search` tool definition while explicitly declining
to call it. The completed response reported 14,137 input tokens, 14,094 cached
input tokens, five output tokens, and zero web-search requests, confirming that
cached tokens are a subset of input tokens on a tool-bearing request to this
deployment. When Azure omits price, the configured fallback is the unweighted arithmetic
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
it never fetches or writes pricing. A failed cache read omits Azure; the normal
bound policy leaves OpenRouter available, while Sol's hard provider fence leaves
no candidate and fails closed. Azure's Retail Prices
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
the cached per-million-token rates and each binding's cache semantics
through Bind's configured-rate billing function. Azure reports cached Grok
tokens alongside rather than inside `prompt_tokens`, so Rally adds both input
buckets only to select the OpenRouter prompt-size tier; Bind still prices each
bucket exactly once. Sol uses OpenAI's subset semantics, where cached tokens are
already inside prompt tokens, so Bind subtracts that subset before pricing the
uncached input bucket. A missing, malformed, or
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
official `@openrouter/sdk` schemas own provider request serialization (Chat and
Responses) and successful Chat response/chunk parsing; Responses stream events
are read by the reducer above. Model content parts and function tools are
mapped to Rally's wire types, unsupported tool variants fail at the boundary,
and input audio admits only the `wav` and `mp3` formats the OpenRouter SDK
contract supports. This keeps an SDK union or return-shape change visible to the
compiler instead of letting it emerge later in a provider request.

### Streaming stability

SSE comments are ignored. Azure's Chat function-call fragments are combined by index, and OpenRouter's Responses argument deltas by output index, with the `done` event's arguments taken as final. Each model turn has a stable `turnId`; `epoch` and `streamSeq` order protocol frames within it, independently of the AgentLoopDO event `sequence` used for socket replay. A pre-output route retry may advance the attempt epoch but has no participant text to retract. Once a delta is observable, failure closes the step rather than issuing a transparent route restart.

Text deltas are buffered before broadcast, but a reset is sent alone and batches never cross turn or epoch boundaries. The room commits each sequenced stream frame together with an accumulated active-stream checkpoint in Durable Object storage. Its metadata and bounded text chunks share that transaction, so a long answer cannot make one storage value reject every later frame. An initial snapshot or history-gap resync reassembles that checkpoint, including its independent Bind cursor and attempt boundary, so somebody joining after the response began installs the exact partial text before catch-up and live frames cross the same sequence boundary.

The desktop retains room and per-message stream cursors across socket and route handoffs, rejects duplicate or stale frames, and removes only the failed active turn's ephemeral preview while preserving completed text from earlier tool turns. There is no background subscriber for a conversation that is not open, and a canonical refresh retains the active transient assistant row until its accepted turn or failure status arrives. The owning `AgentLoopDO` is the only regional authority for its conversation: it stores the complete accepted assistant message plus a bounded active-output checkpoint while streaming, and terminal resynchronization remains canonical.

### Transcript row attribution

Every chat surface renders one row component, so a tool row must mean the same
thing wherever it appears, in a conversation's feed and in an automation's chat
alike.

A row's icon is the plugin that **owns** the tool being called, and nothing
else. It is resolved from `tool_invocations.connection_id`, which already
records the connector that ran the tool. Tools Rally owns — web research, plugin discovery, memory, tables,
conversation reads — have no connector behind them and carry no plugin icon.
The contract's `ToolInvocation.plugin` holds a single nullable plugin, so a
row with several icons cannot be represented. A discovery row may still *name* several plugins in its label
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
Google calendar cancellation/RSVP and inbox state actions declare complete action
paths: otherwise `mark_read` would be described as a read despite mutating mail,
and a series cancellation would lose its distinction from one occurrence. See
[Google workflows](google-workflows.md).

### Child agents

Background agents have their own stable child substream and `AgentLoopDO`.
The `rally_agents` plugin starts them through durable admission and returns
without waiting for their execution. Each uses the same Bind harness, inherited
model and execution principal, explicit opening context, and independent tool
discovery. Normal authorized writes and recursive delegation are available.
The obsolete inline child integration, runtime/storage entry points, and
`workstream_run_subagent` surface are removed. Historical schema fields remain
for existing data; new background work uses normal independent run recovery. [Agent communication](agent-communication.md) owns the tools,
teams, reply references, Sidekick discovery and separate stop ownership.

Bind remains the core owner of each feed's loop. Independent substreams provide
responsiveness while preserving Bind's ordered input acceptance, tool receipts,
suspension, checkpoint and completion protections. Rally routes and persists
messages through existing harness ports. Missing loop capabilities belong in
the Bind runtime library, not a parallel loop or a runtime patch in Rally.

### Agent profiles

A conversation provisioned with an `agent_profile` (a column on its
`workstream` row, set once by `provisionWorkstreamObject`) does one fixed job.
`runWorkstreamHarness` reads it from the conversation's identity and, for a
profiled run, replaces three things wholesale: the system prompt (the
profile's, not the conversation prompt), the model route (the profile's
Flagship role, `resolveAgentModelRouting`), and the tool surface — exactly the
profile's plugins as always-active core plugins, through `profileHarnessTools`,
with no built-in or connector plugin and no plugin discovery. Its skill
catalog is exactly the skills the profile names, with no inherited built-in,
connector, or Sidekick skills. This is a complete catalog declaration rather
than a list of exclusions: general guidance about unsupported capabilities must
not contradict a specialized profile that has those capabilities. A skill is
instructions only, so naming one widens nothing a run can do. The
registry is `apps/api/src/services/agent-profiles.ts`, and it is empty: its
one entry, `session_import`, went with session import. A stored profile this Worker
does not know fails the run as `agent_profile_unknown` rather than running
with every tool.

A profile may also name an `ended` hook: cleanup owed once a run of it has
ended, failed or stopped. `AgentLoopDO` calls it right after
`terminalizeHarnessAttempt`, which every executed run passes through — a normal
return, a stop, and a host that threw alike — so the outcome is durable first, with the run's workspace, parent and — for a run a person
started — user; a hook that throws is logged as
`agent_profile_run_end_failed` with its code and does not change the run's
outcome. No profile names one now.

### Scoped durable memory

What this section once covered as prose memory — items the model added by scope
kind, searched by hybrid FTS and Vectorize retrieval, and recalled at admission —
is gone. Rally's memory is now a store of facts a background sweep writes, with
visibility decided by each fact's source conversations; [`agent-memory.md`](agent-memory.md)
owns it, including the `rally_memory` plugin's three tools (`memory_recall`,
`memory_remember`, `memory_forget`), and the per-activation digest every run
starts with.

What stays here is the scope resolution the typed tables use. `resolveMemoryAccess`,
the canonical run check, derives a run's scope union from the frozen principal
and the parent kind on the run's input, and stores no decision; it also gates
every memory tool call, so an inline child (an empty union) reaches no memory.
Scope ids come from `ensureScope`, which keeps each immutable `memory_scopes`
row per isolate (`memory-scope-cache.ts`) and applies the caller's `writable`
per call.

**Never delete, re-create or re-id a `memory_scopes` row without clearing that
cache first**, or a warm isolate keeps handing out the old id. The cache is
correct only because a scope row is immutable (`memory_scopes_are_immutable`),
typed-RPC-only, and never deleted. Tests break that premise — storage isolation
gives each test a fresh object under the same workspace id — so
`apps/api/test/setup.ts` clears it after every test in both suites. The cache is
unbounded: its size is the distinct scopes one isolate has served, and whether
it needs a cap is the team's call.

A conversation whose parent is an automation, its drafting chat and every run
alike, resolves the workspace scope and the Sidekick's own scope of kind
`sidekick`, keyed by the Sidekick id and writable: what a run learns is what the
next run should know, and what the person said while drafting is part of that.
The person's own scope stays out, because a run acts for the automation rather
than as the person. The parent kind on the run's input is the fact that decides
it. **A conversation's runs never reach an automation's scope**, whoever started
them and whatever posted into the room.

**The union is not the whole story, and in one direction it currently overstates
what is withheld.** The protocol projector reauthorizes replayed *attachment*
results and nothing else, so a completed `memory_table_query` receipt from an
earlier run in the same transcript window is replayed to the next run verbatim,
out of R2, whatever that run's own union is. Until the projector filters a
replayed result against the current union, the scope union is the authority for
what a run may *search*, not a guarantee about everything in its context.

Root runs receive the stable `rally_tables` plugin for large structured collections that should not enter prompt context as prose. Tables inherit the conversation, automation, user, and workspace authorization union. Reads accept a reauthorized table ID plus typed filter/search/projection/order/cursor arguments or an exact `memoryTableRowIds` selector for conflict recovery; they never accept scope or owner selectors and expose no raw SQL. Rows use typed columns, a declared natural key, synchronous WorkspaceDO FTS for searchable text, typed cell indexes, revision compare-and-swap, reversible invalidation, and receipt-backed append-only mutation records.

Table mutations return identifiers and current revisions. On a revision
conflict, the failed result directs the model to re-read those exact identifiers,
reconcile its intended change, and retry with the newly observed revision. Table
insert contention is a separate typed failure because inserts do not have an
`expectedRevision`; after bounded host retries it directs the model to query by
the declared natural key and retry only the rows that remain absent.

Sidekick definitions may declare tables used across runs; [Sidekick publication](automation-lifecycle.md) owns their provisioning and activation contract.

`table_create` reopens a same-name table when column names (case insensitive),
types, required/searchable flags and ordered natural-key columns match.
Declaration order is irrelevant; stored column IDs and order stay stable. Table
and column descriptions and usage instructions are editable metadata. A reopen
updates that metadata for every run sharing the table and records its receipt
atomically, leaving row contents, cell IDs, row revisions, and schema/data
revisions unchanged. A schema conflict
returns `memory_table_name_schema_conflict`, the existing `memoryTableId`,
incompatible field paths and `retryable: false`. The recovery is to call
`table_describe` and reuse the stored schema, or choose another name and
explicitly copy/transform rows; retrying unchanged cannot succeed.
A run can also create a table through `rally_tables` in its authorized scope.
Table rows never enter a prompt unasked; the agent queries only needed rows and
columns.

### Scheduled wake-ups

`rally:workstream` carries `schedule_wakeup`, `list_wakeups`, and `cancel_wakeup`, so a run can defer work to a stated instant instead of promising it in text. `schedule_wakeup` takes the prompt plus exactly one of `delay` — a duration in common units, `"5 minutes"`, `"90 sec"`, `"1h30m"`, or an ISO-8601 `"PT2H30M"` — or `at`, an exact ISO-8601 timestamp. An `at` without an offset is read in the run's local zone, or in an explicit `timezone`; an `at` that carries an offset is absolute and rejects `timezone` rather than silently choosing between the two. The resolved instant must be at least one minute and at most one year out, whichever form produced it. Pending wake-ups are capped per conversation, and every rejection returns a stable code with its remediation and accepted vocabulary in the model-visible failed result.

The tool is `provider_key`-idempotent against `(workstream_id, idempotency_key)`, so a replayed receipt returns the persisted wake-up instead of scheduling a second. A wake-up belongs to the conversation whose run scheduled it — a Canvas's Chat, a Sidekick's conversation, or a Sidekick run child — and lives in that conversation's object, whose own alarm fires it into that conversation's loop. A child's wake-up never runs in its parent's `"0"`, which would write the child's prompt into another transcript; a Sidekick run child's continues its run only as `continueSidekickRun` allows, the question a member's message there asks, and a refusal consumes it. A delegated worker's wake-up runs as that worker, with its owner's sandbox and reporting, and a stopped worker's is consumed without running. Firing claims the row before launching, so a lost claim means a missed wake-up rather than a duplicated run, and releases the claim when the harness cannot start so a later alarm retries. The principal that scheduled the wake-up is re-validated against current membership at fire time — a wake-up cannot outlive the authority that created it. The resulting run reads the prompt as an explicit trigger message labelled as coming from an earlier run of the same conversation; the transcript row is separate host-written system state. Sub-agents get none of these tools: they cannot schedule, and a parent's wake-ups are not theirs to act on.

Every conversation response carries `nextPendingWakeup`, the earliest pending
row by due time, derived with an indexed lookup; the bounded prompt prefix is
cut before the data crosses the API boundary. No sidebar row draws it now; the
wake-up tools remain the boundary for complete wake-up detail.

That split — a labelled trigger message for the model, a system row for the person reading the transcript — is the contract for every scheduler-started run, not a wake-up detail. A run whose instructions exist only as a transcript `system` row reaches the model with nothing but its conversation's objective, because the protocol projector drops those rows as UI state; whatever starts a run has to hand the host something to render.

### Loop stop, receipt cancellation, and deferred systems

Ordinary **Stop** on a persistent conversation loop writes
`substream_loops.stop_requested_at` and `stop_after_step_ordinal`. It does not
write `runs.cancellation_requested_at` and does not terminate an in-flight model
request or tool call out of band. The loop owner observes the request only after
the accepted response and every tool it already emitted settle, then prevents
the next provider step and terminalizes the subordinate receipt.

`runs.cancellation_requested_at` is instead a receipt-local cleanup signal for
descendant/child runs and generic non-conversation executions. It is not loop
control. Admission observes a pre-start receipt cancellation, and a live receipt
owner observes it through heartbeats and event checks. If that observation
aborts a child or generic tool, the same live attempt may settle that exact
in-flight receipt even though receipt cancellation has been requested; the
narrow settlement path still requires the current attempt id, lease owner,
unexpired lease, `running` parent, and no prior terminalization. A
`record_before_execute` write remains ambiguous, while a definitive read failure
remains failed. A tool that dispatches writes of its own (a Code Mode program)
reports one left unknown by throwing the exported `AmbiguousExternalWriteError`
itself; Bind's dispatch classifies that as it classifies its own interrupted
write, so the receipt, the `tool_failed` event, the host's ambiguous flag and
the loop stop are the same for a nested write as for a direct one. In every checkpoint, successful-completion, and failure batch,
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
which matches every unfinished automation row in the conversation rather than
the run's own — is restricted to a reaped root. If an obsolete executor loses
ownership, its local dispatch is deferred to adopt the successor's result; it
cannot write an unfenced product failure.

The conversation transcript, attached resources, activation hints, run scope,
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
- **Owning a failure is not a reason to stop naming it.** The one 400 whose
  cause the endpoint states in a machine code — `context_length_exceeded` —
  is reported under that name with kind `context`, still Rally's request and
  never the provider's. So is OpenRouter's 404 when its routing funnel names an
  input filter (`failed_routing_step` of `Filter by Image Support`, `File` or
  `Audio`): `model_input_unsupported`, kind `context`, because the model
  cannot read an input the request carries. The invariant above is about *who owns* a failure; this
  one is about *what it was*, and answering the first by discarding the second
  is how a run that crossed a known token limit reached a member as "Rally
  could not complete this run. Retrying is unlikely to help."
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
- **The run scope is recorded once, canonically hashed, and never rewritten.** A
  later attempt leaves the record alone rather than reproducing it, because a
  resumption across a deploy legitimately recomputes a different build. The
  record is a forensic one on the root path: a resumed attempt executes against
  a freshly assembled tool surface, not against the stored fields, so live
  reauthorization rather than the record is what bounds it.
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
- **A triggering activity or inbound email is user-role content**, never promoted
  into the system prompt. It carries no trust label of its own. The same holds for
  a naming request and a skill body, which is wrapped in `<skill_content name=…>`
  so the model can tell it from platform policy.
- **The trigger's two jobs stay separate on a retry.** As *identity* it admits a
  brief or an inbound email to the model at all; as *bound*
  (`transcriptFenceMessageId`) it is the newest *turn* the run may see — a turn,
  because the newest one is usually the agent's and an assistant turn's id is
  `<loopId>:turn:<ordinal>` rather than a UUID. The fence
  is resolved once at launch and travels in the durable workflow input, never
  re-read at projection time — an attempt that replays must read the same window it
  read the first time.
- **`retry` inherits the stored `trigger_message_id` rather than reconstructing
  it.** Reconstructing the trigger as "the latest human message" is right only while
  nothing has happened since, and fences finished work out of the replay whenever it
  has.
- **Every write to a title is conditional on the status the pass started from.**
  Renaming settles a conversation, so a generated name arriving afterwards is dropped
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
- **A child can never widen the parent's frozen scope**, is read-only by a tool-loop
  hook rather than by what it was given, and cannot recurse.
- **The model never selects a memory scope.** The memory tools take a query, a
  fact, or a fact id, and the table tools a table id; the host derives the
  authorized scope union from the frozen principal and the parent kind on the
  run's input, and a fact's visibility from its sources ([`agent-memory.md`](agent-memory.md)).
- **An automation's conversations own no `workstream` memory scope**, and
  `resolveMemoryAccess` is the only thing that says so: WorkspaceDO validates
  no scope owner at all. A run under an automation writes into the automation's
  scope, which the next run reads; a `workstream` scope keyed by the run's
  substream would be one nothing reads again.
- **Whatever starts a run hands the host something to render.** A run whose
  instructions exist only as a transcript `system` row reaches the model with
  nothing but its conversation's objective, because the protocol projector drops
  those rows as UI state; the exceptions are the rows it admits by their
  structured content's kind (an inbound email, an external event, a Sidekick's
  self-review notice), each through its own renderer.
- **A cancellation is a durable request, observed by the lease owner**, which alone
  commits the fenced `stopped` transition. Stopping never kills an in-flight
  provider or tool operation out of band.
- **A row carries exactly one plugin icon, the one that owns the tool.**
  `ToolInvocation.plugin` holds a single nullable plugin, so a row with several
  icons cannot be represented.
- **Prompt sections are a pure render of run state.** Bodies are rebuilt from the
  active set on every turn in Bind's total order rather than spliced into the
  previous prompt, so a resumed attempt produces the same bytes as a fresh one and
  the provider's cached prefix survives. The resident-context section is a pure
  render of the host's committed ledger, with one deliberate exception: at a
  compaction the harness renders the compacted system message from the state
  `prepareCompaction` proposes, and the host commits exactly those transitions in
  the checkpoint's transaction, so the projection and the ledger agree the moment
  the replacement is durable.
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
| The create path a run is launched from | [`hosted-conversation-parents.md`](hosted-conversation-parents.md), [`canvases.md`](canvases.md) |
| Reading a captured inference record back | [`runbook.md`](runbook.md#inspecting-a-runs-raw-inference) |
| Regional analytical inference capture and retention | [`inference-lakehouse.md`](inference-lakehouse.md) |

A substream owns one server-side, tool-using loop. A run is an execution receipt.
Neither is a participant, a separate persona, a terminal, or a general code-execution
environment, and nested child delegation, personas, roles,
and general child participants remain deferred product work.

## Failure modes and limits

Addressing retains only the newest ten context messages and silently omits older
ones. Each retained message is center-truncated to 1,000 Unicode code points;
the current message is not truncated.

Root ordinary conversation runs allow 1,000 model iterations and have no tool-call, wall-clock, or cost ceiling. A conversation loop otherwise continues until completion, elicitation, its safe-boundary stop, ambiguous write, lease or authority loss, context failure, or provider failure. Per-tool time and plugin-catalog tokens remain bounded, and request establishment, time to first token, and inter-chunk idle time have separate watchdogs. Deliberately bounded one-shot callers such as meeting notes retain their own independent ceilings. Active plugin count, active tool-schema bytes, model-visible tool-result bytes, and replay payload bytes are not capped by the agent runtime. Web results, fetched bytes, and attachments remain independently bounded by their owning tools. Live context size comes only from OpenRouter's returned prompt and completion token counts; Rally does not estimate it from serialized bytes. After a completed provider turn exceeds 80% of the selected model's OpenRouter `context_length` (with Monad's 200,000-token fallback when the catalog is unavailable), Bind replaces the whole live context beneath the system prompt with one synthetic user message carrying an LLM continuation summary; no earlier message survives verbatim. Conversation checkpoints store one principal-and-resource-inventory-revision-scoped summary regionally with the durable sequence boundary. The live checkpoint and every authorized replay append a freshly rendered, fixed-size resource inventory before newer messages; a scope mismatch falls back to complete durable transcript replay. The first request must fit the selected model because automatic compaction depends on usage from a completed turn. [`context-compaction.md`](context-compaction.md) owns that policy — the threshold, the summary prompt, the deterministic appendix, the checkpoint shape, and the stored row — and is the document to read and update before changing any of them.

A published document is readable in the desktop client, and was not until 2026-08-27. A generated resource appears in the conversation rail under **Artifacts**, and its detail panel now renders the resource's readable content beneath the metadata, through `/resources/:id/preview` — the same authorized route `AttachmentLightbox` uses, which materializes extracted text for a file that is not already text. The gap that remains is narrower: the rail resolves an inspector target only from the loaded conversation's own resources, so a document cited from *another* conversation still has nowhere to open. [`markdown-rendering.md`](markdown-rendering.md) owns the citation half of this and records the same limit.

Host-owned receipt operations may set `HarnessTool.deadline: "run"` to use the
parent run signal without a second per-tool timer. Conversation import saves
use this because their file uploads and durable commit must return an outcome
instead of racing the generic tool timer; run cancellation remains authoritative.
The host marks durable input re-entry with `HarnessToolContext.replaying` so a
tool can decode a historical receipt without weakening validation of new calls.

Per-tool time and the model catalog fetch use a **cancellable** deadline whose timer is cleared once the call it guarded returns. The Bind loop runs inside a long-lived `AgentLoopDO` operation, so an `AbortSignal.timeout()` left armed after a fast tool call retains dead timer work and can keep the isolate active after useful work ended. The rule and its incident are [`runbook.md`](runbook.md).

Image attachments retain their exact original object for display and download. Before model admission, the regional Worker validates the byte signature and dimensions and writes a reusable bounded derivative to regional R2, referenced separately from D1. PNG, JPEG, WebP, HEIF/HEIC, and the primary TIFF path are normalized through Cloudflare Images; the TIFF fallback preflights dimensions before pixel decode, while HEIF has no whole-buffer local fallback. Animated GIFs become a single storyboard derivative with up to six representative timestamped frames plus bounded duration, frame-count, dimensions, and loop metadata. Only the derivative is placed in the model protocol transcript. Non-image message attachments contribute a compact manifest only; authorized attachment tools own every byte of text, Office, and PDF hydration.

The same derivative backs `view_resource`, including after replay or
compaction. A requested smaller long edge is an ephemeral scale-down and never
replaces the reusable object. Text derivatives may instead use an isolated
summary inference: filenames, focus text, and chunks stay in user-role data,
citations are checked against exact UTF-16 ranges, and derivatives over the
bounded reader budget report sampled partial coverage rather than claiming a
whole-file read.

Bounded callers use `run_wall_time_limit_exceeded`, `run_iteration_limit_exceeded`, `run_tool_call_limit_exceeded`, and `run_cost_limit_exceeded` when one of their explicit ceilings is reached. Those codes remain in the public failure contract so historical runs and bounded subsystems stay readable. A limit never silently reinterprets a write as successful.

When every route candidate answers with a transport fault the provider owns — no response, a 408, a 429, a 5xx, or a successful HTTP stream whose bounded provider error code is `unavailable`, `service_unavailable`, or a numeric 408/429/5xx — the run fails as `provider_unavailable`, kind `provider`, and not as `harness_execution_failed`. An OpenAI-compatible endpoint can accept the HTTP request and disclose an outage only in a later SSE error envelope. The two named machine codes classify as `server_error`; numeric codes reuse Bind's HTTP taxonomy but admit only timeout, rate-limit, and server-error categories. The same provider traversal and whole-plan retry rules then apply despite the successful surrounding status. Other statusless stream codes, including numeric request, credential, and credit failures, stay terminal because a blanket retry would hide the owner of the fault. When the circuit breaker had already opened and no request went out at all, the run fails as `provider_circuit_open`, kind `routing`: Bind's executor reports that as `no_viable_endpoints` carrying no error, and letting that emptiness fall through to the generic bucket reinstated the misattribution during exactly the minute an outage was worst — the first run in a workspace named accurately, every run behind it blamed on Rally. The two codes stay separate because the breaker opens on 401/402/403 as readily as on a 5xx, so a refusal cannot be attributed to the provider without knowing why it opened, which the breaker does not record. The distinction is the whole point of the code: `harness_execution_failed` means Rally’s own defect and gives a member no reason to try again, so filing an upstream outage under it sends whoever reads the failure to the wrong system. A 400 stays generic, because the request shape is ours; 401, 402, and 403 stay generic too, because the credential or the credit is ours. One 400 is the exception, and it is an exception about the *reason* rather than the owner: an OpenAI-compatible endpoint refusing a prompt longer than it accepts says so in a bounded machine code, `context_length_exceeded`, and that run fails under that name with kind `context`. Azure and OpenAI set it as `error.code`, which is read directly; OpenRouter does not adopt it, reporting its own numeric 400 and forwarding the endpoint's envelope in `metadata.raw`, which `isProviderContextLengthRejection` parses to read that endpoint's own `error.code`. It parses rather than pattern-matches because `openRouterProviderError` sets `detail` to the *whole* response body and not to `metadata.raw` alone: a substring search there also sees the provider's free-text `message`, so a provider that echoes the rejected request back or names codes in prose would have an unrelated 400 relabelled as a context refusal and its member told to start a new conversation over a schema fault. The first revision of this shipped with exactly that search, under a comment claiming it did not do it, and review caught it; the negative case is now pinned by a test. The rejection is still Rally's request and is never reported as the provider's; what changed is only that Rally stopped throwing away a reason it had been handed. A run died on 2026-09-17 with compaction sized from OpenRouter's catalog `context_length` of 1,050,000 for a model whose Azure deployment accepts 922,000, and the 400 that said so arrived as `harness_execution_failed` — Rally's own defect, with no remedy and no next step — which is the generic-code defect `CLAUDE.md` names, on a path that had the reason in hand. It traverses before it is named: another endpoint for the same model may have a larger window, so the code is what is left once every candidate has refused, read from the last attempt's error. Note that it says the endpoint disagreed with Rally's sizing, which `context_limit_exceeded` — Rally's own accounting declining to send a run it cannot make fit — does not; the two are near-namesakes and mean opposite things about who was wrong, so neither may be used for the other. A refusal from the platform Rally runs *on* is neither: Cloudflare bounds how deep one request may recurse through Workers and how many subrequests one invocation may make, and enforces both by refusing whichever call asks next — a D1 read, a Durable Object hop, a fetch. That run fails as `platform_limit_exceeded`, kind `platform`, decided in `FatalHarnessPortError` from the platform's own wording rather than at the call site, because the port that happened to ask is in no position to know. Filing it under that port's code is not a naming quibble: on 2026-08-24 a conversation died reporting `tool_receipt_persistence_failed` when nothing about the receipt had failed, and the investigation started in the receipt authority. Bind's `isRetriableAttemptError` is the authority for the split, minus completion defects, which are the model answering badly rather than the provider failing to answer.

Before that failure is reached, the harness re-executes the **whole route plan** up to `transportRetries` times, which the conversation host sets from `HARNESS_TRANSPORT_RETRIES` (declared as `1` in `wrangler.global.jsonc`, the one regional config; `0` disables it, which is why it is read through `countEnv` rather than `numericEnv` — the latter rejects zero). The wait is a clamped backoff honouring `Retry-After` up to `TRANSPORT_RETRY_MAX_DELAY_MS`, and it is skipped entirely when the run's remaining wall clock cannot hold the wait plus a **worst-case replay of the whole plan** — every candidate, each able to spend its establishment timeout and then its time-to-first-token timeout, because the stream watchdog only opens once the response head lands. Reserving less lets a bounded caller's retry manufacture the deadline it defers to, and the outage is then reported as `run_wall_time_limit_exceeded`. Root conversation runs set no wall clock and are unaffected. This is the host-side retry Bind's disposition matrix expects rather than a second guess at its ordering: the matrix answers a retriable transport fault by traversing to the next provider and then the fallback model, and gives it no same-endpoint budget, because with somewhere to traverse to there is no reason to wait. A plan with nowhere to go therefore had no recovery at all — and a conversation pinned from the developer-mode model selector is exactly that plan, since [`feature-flags.md`](feature-flags.md) has an override carry no fallbacks by design. The retry is skipped once output or an external effect has reached a surface that cannot be retracted, the same rule the executor applies to traversal. Each re-execution records another failure against the shared per-workspace circuit breaker, whose threshold is 3, which is why the budget is small by default: a larger one trades one run's recovery for opening the endpoint on every other run in the workspace. Each attempt appends to the owning execution object's `inference_attempts` ledger and emits its own lakehouse terminal record, so a retried turn is visible as more than one attempt sharing a `turn_id`.

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

The validated `resourceAuthorization` recovery hint is also forwarded, but only
to the durable failed-tool block for the desktop card; it is not model-visible
provider data.

Separately, Product analytics records a content-free `agent_tool_started` only
after the execution plan is durable and replay/ambiguity checks permit a new
invocation. It carries the canonical tool, plugin, capability, mode, run kind,
execution scope, and opaque conversation/run/automation IDs. It never carries an
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

`pnpm --filter @rally/agent-harness exec vitest run src/index.test.ts`
checks completed replay refusals reach the model without executor calls, new
execution plans or terminal effect events. Real workerd
`test-workers/sidekick-delegation.test.ts` drives the consent receipt RPC and
actual tool-owned replay validator in direct and autonomous contexts; it covers
stale and unavailable acknowledgements, matching actor/target/intent and read-only withdrawal
recovery. These prove protocol and authority behavior, not semantic model intent. The same workerd lane exercises crash repair
through real replacement leases, receipt settlement and R2 for both consent
presentations; accepted, missing and superseded recovery are separate
assertions. Autonomous changes to another Organization user are covered too. `apps/api/test/terminal-command-recovery.test.ts`
checks shared re-entry semantics and deadline cleanup on reconciliation.

`pnpm --filter @rally/api exec vitest run test/sidekick-operation-accounts.test.ts
 test/connector-resource-access.test.ts` covers plugin selection, eligible fallback,
read account-checkpoint bypass, uncertain-write recovery, withdrawal and the
assembled Google executor. Real workerd `sidekick-run-continuation.test.ts` covers
coordinator failover for root runs and background workers, including resumed
input after eviction, reuse of activation eligibility during an attempt, and
pause/stop-generation fencing. Restoring the old read checkpoints and background
eligibility scans makes the corresponding regressions fail.
`tool-receipt-authority.test.ts` proves checkpoint leases, cancellation and rollback;
`sidekick-delegation-admission.test.ts` covers event audiences, sources and schedules.
Production-code negative controls are recorded in the
[delegation implementation plan](PRDs/2026-10-22_sidekick-delegation/plan.md).

Completion verification is covered by
`packages/agent-harness/src/completion-verification.test.ts` (JEV threshold,
unavailability and cancellation), `packages/agent-harness/src/index.test.ts`
(persist-before-inference and context delivery), and
`apps/api/test/completion-verification.test.ts` (host lifecycle gates).
The real workerd suites `workstream-transcript-runtime.test.ts` and
`message-to-output-pipeline.test.ts` cover compaction/eviction and the complete
production path for low confidence, unavailable judgment and accepted results.
They also cover Stop during terminal compaction and nudge materialization,
pending delegated inputs, and actual model-request delivery after eviction
between the nudge commit and the next model call.
Run them with `pnpm --filter @rally/api test:workers` and the respective paths;
`-t 'completion verification'` scopes the added runtime cases.

The [premature-stop evaluation](../packages/agent-harness/evals/premature-stop/README.md#agent-identity-and-participant-addressing)
covers agent identity and addressing semantics through live JEV regressions.

Sidekick catalog naming is covered by `apps/api/test/sidekick-presentation.test.ts`
(`pnpm --filter @rally/api exec vitest run test/sidekick-presentation.test.ts`).


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
| `apps/api/test/tool-transcript-durability.test.ts` | That a successful result is durable before Bind observes it, and that receipts replay. |
| `apps/api/test/core-tool-idempotency.test.ts` | Receipt identity, plan hashes, and the `ambiguous_external_write` path. |
| `apps/api/test/workstream-tool-receipt-storage.test.ts` | `admit`'s decisions against real migrations, including `resume_write` for an unsettled `provider_key` write and the two guards that keep it narrow: the declared class, and the admitted provider key. |
| `apps/api/test/terminal-command-recovery.test.ts` | That re-entry follows `HarnessTool.reenterable` rather than a tool name, re-enters over the receipt's own effect identity, re-submits a `provider_key` write under the key it was admitted with, and consults `reconcileEffect` first — running the executor only on `not_landed`. |
| `apps/api/test/terminal-resource-bridge.test.ts` | The publication reconciler against real WorkspaceDO resource schema and its capture triggers: a publication this run made in the window, one that predates it, one revised away by a later run, another run's revision inside the window, and a path never published. |
| `apps/api/test-workers/workstream-transcript-runtime.test.ts` | Crash repair of an interrupted tool batch on real workerd, including a write that could not be asked what it did: the receipt, its error, and the model's tool result all name the tool, and the batch is repaired rather than abandoned. Also the repair that holds no lease, which settles `no_repair_lease` rather than asking a question it could not record the answer to. |
| `apps/api/test/tool-usage-telemetry.test.ts`, `run-outcome-telemetry.test.ts` | Started/terminal tool and root-run outcomes, person/workspace attribution, replay/idempotency, bounded performance dimensions, and prohibited content. |
| `apps/api/test/bind-tool-failure-classification.test.ts` | The structured-failure allowlist and its size bound. |
| `apps/api/test/connector-tool-prose.test.ts`, `avalon-tool-prose.test.ts` | Every registry tool reaching a non-generic row, and no `write` described in passive words. |
| `apps/api/test/scoped-memory.test.ts` | The host-derived scope union and the typed tables' post-read revision races, against a real `WorkspaceDO` standing in for the memory authority. `apps/api/test-workers/workspace-memory.test.ts` proves the tables' transactional receipts and witnesses on real workerd. The fact store's suites are in [`agent-memory.md`](agent-memory.md#testing). |
| `apps/api/test/message-run-context.test.ts` | The personal system prompt travels only on a turn the member started. |
| `apps/api/test/model-protocol-transcript.test.ts` | Historical tool-pair reconstruction, including sanitized structured failure recovery after resume. |
| `apps/api/test/workstream-transcript-storage.test.ts` | Atomic activation-input admission under the exact execution/Bind fence, full-provenance replay checks, pending-input suppression, ordered multi-input commits, idempotency across compaction, repair of a host reservation missing its Bind edge, and stop winning a steer-preparation race without consuming input. |
| `apps/api/test/workstream-wakeup.test.ts` | Both time forms, the bounds, idempotency, typed refusal codes and remediation, the pending marker, claim-before-launch, and that a Sidekick run child's wake-up starts in its own loop, only as the Sidekick allows. |
| `apps/api/test/bind-host-durability.test.ts` | Host-only boundaries around activation persistence, ambiguous halts, and attachment grounding, including the validation-versus-content-failure distinction and post-start validation receipt reuse. |
| `apps/api/test/attachment-tool-receipts.test.ts` | Exact derivative and completed-output-reference dependency fencing, replay reauthorization, all-or-nothing multi-image registration, and successor-safe mismatch cleanup. |

| `apps/api/test/agent-inference-logging.test.ts` | That no legacy D1/R2 path remains and provider refusals stay content-free in Workers Logs. |
| `apps/api/test/inference-lakehouse.test.ts` | Exact request/attempt archival, pointer integrity, Pipeline delivery, and oversized-record preservation. |
| `packages/db/test/agent-inference-retirement-migration.test.ts` | Migration 0094 removes the regional payload-log table and workspace preference while preserving workspace rows and foreign-key integrity. |
| `packages/agent-harness/src/*.test.ts` | Persistent-loop projection and activation boundaries, including resumed-history preservation, empty system activations, takeover replay, and fail-closed ordering before model-catalog or inference I/O; plus prompt golden hashes, skill bounds, `toolActivityName`, transport retry/fallback behavior, and the automation drafting tools. |

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

## Slow inference status

Root conversation Azure and OpenRouter calls allow 180,000 ms for first answer text or
tool-call output after the response stream opens. Bounded inline child
callers retain their existing 45,000 ms provider allowance (or a lower deployment
setting) so their total run budgets and transport retries remain meaningful. The
independent establishment and inter-chunk deadlines remain in force. Total work
is governed by the caller run deadline; summing idle budgets into an absolute
stream cap would truncate healthy output after a slow first token. Empty
chunks and metadata do not restart that window. A shared per-stream observer
notifies `onInferenceDelay` after 30,000 ms, then clears on first output or any
settlement, including cancellation. Its timer and queued notifications are
attempt-local and disposed before provider traversal or tool execution. Notification
failures are swallowed by the observer and cannot replace provider output or errors.
Provider reads do not wait for status transport; first output, disposal, and abort
release pending notification delivery without inventing another timeout. The
conversation settlement tombstone rejects an activation that arrives after its clear.

## Proactive execution preparation

Harness startup uses separate `Preparation` instances for the Sidekick run
response, connector inventory, prompt context, and tool setup. Definition and
inventory reads start while the initial lease heartbeat completes. Prompt and
tool setup start after that heartbeat, alongside canonical transcript loading.
Each consumer awaits only its dependency's existing promise. Rejections are
observed immediately and failed preparations can be retried by later demand.
Each `Preparation` exposes the settled attempt's I/O-visible `elapsedMs`, or
`null` before it settles; retry clears the failed attempt's measurement before
the replacement starts. This lets diagnostics measure the reusable dependency
itself instead of placing clocks around whichever control-flow path consumes it.
No model or tool execution is started by preparation; Bind's live authority,
lease, transcript, and command checks remain in their ordinary path.

The Sidekick response is shared by prompt and tool setup within one execution.
Although its definition revision is immutable, the response includes current
plugin defaults, bindings, and run state, so it is not cached across executions.
Connector inventory is also execution-scoped. Built-in tool surface hashes retain
only the latest serialized metadata variant per built-in plugin in isolate
memory; different metadata replaces the entry. They contain no executor closures,
credentials, or run state. Isolate eviction drops these optimizations and demand
reconstructs them. There is no timer, persistent cache, or global readiness gate.

## Changelog

### 2026-11-07 — The prompts speak of Canvases and Sidekicks, a run's result is posted once, and a Sidekick's conversation goes to the wizard only on a manager's marked edit

**What changed:** In a Sidekick's conversation (`"0"`), a message addressed to
an agent starts a run of the Sidekick, whoever sent it; `"0"`'s loop takes no
turn for it. A message marked `intent: "edit_sidekick"` on `create_message`, an
elicitation answer and a resource authorization are the wizard's, and only from
a manager. A marked edit skips the classifier, whose prompt is unchanged. With
the `workstream` scope retired (plan step A-5), the Thread loop's
`rally:sidekicks` variant keeps only the delegation tools, presented as
`rally_sidekick_delegation`; `list_skill_recommendations`, `recommend_skill`
and `unrecommend_skill` are gone. The authoring prompt and the submission
schema offer only `personal` and `workspace`, and lose the owning-Thread lines
(the room scope, "Scheduled result delivery to a workstream is limited to the
owning workstream", and the home conversation as where feedback and Terminal
publications live).

Then plan step C-5's vocabulary half. The standing work prompt
(`prompts/workstream.ts`) replaces the Channel, Thread and Breakout paragraph
and its identifier map with the Organization, Canvas and Sidekick paragraph
above, renames the task context's `workstream` key to `conversation`, and says
"outside Rally" where it said "outside this thread". The `self_delivery`
section and the activation rules now say the final message is the reply on the
run's row in the Sidekick's shared conversation, read by everyone the Sidekick
is shared with, where they said it notified nobody; permission recovery says
what is blocked in the final message rather than alerting an owning
conversation that no Sidekick has. `RUN_POST_INSTRUCTION` and the wizard's
guide (`AUTOMATIONS_PLUGIN_SYSTEM_MESSAGE`) say the same and tell a run not to
post its report into the shared conversation a second time; the wizard's
sandbox line names "the conversation that asked for this one" and its
publication line a Canvas the Sidekick writes. The compaction prompt and the
live inventory appendix say "conversation" (`# Authoritative conversation
resource inventory`); the memory digest titles a Canvas's facts (stored kind
`thread`) "About the Canvas" and a retired room's by its label, and the sweep's
prose files a fact under the placement's own subject; the `building-live-sites`
skill saves the Canvas a site is in and publishes a refresh into it with
`publish_resource`'s `canvas` argument rather than using a Thread-owned
Sidekick; `sidekicks_list`, the run change guidance, the skill catalog, the
document policy, the scheduled wake-up header and three built-in skills drop
Thread wording, and so do the `rally:conversations` attach tool, its
not-found refusal and the peer instruction, which now name a Canvas's Chat or a
Sidekick's conversation. The context-length error tells a member to start a new
Canvas. The turn-disposition eval and `turn-disposition-evaluation.ts`, which
only exercised merge and Breakout dispositions, are deleted, with
`prompts/turn-disposition.ts` and its provenance test (the eval was its only
consumer) and `prompts/work-opportunity.ts` (no importer since suggested work
was deleted). A run's row now carries its reply whole
([`automation-lifecycle.md`](automation-lifecycle.md#runs-in-the-shared-conversation)),
which the prompts' claim that the row is the delivery depends on.
`workstream-name.ts`, `workstream-description.ts` and `session-import.ts` went
in C-2 with the naming and description services; `suggestion-draft.ts` and
`src/turn-disposition.ts` went in C-3 with the suggestion services;
`mergeInstruction` and the `merges` option of the conversation tools are
deleted; C-3 also deleted `opening-message.ts` and its evaluation with a
Thread's and a Breakout's first-message admission.

**Why:** The Canvases and Sidekicks decision log keeps the wizard and run
separation in a conversation now open to everyone the Sidekick is shared with,
and its 2026-11-07 entry has a manager mark a wizard edit explicitly. The first
build sent every manager's message to the wizard, so a manager could never ask
the Sidekick for work there. After the cutover every run is a Canvas Chat, a
Sidekick's wizard or a Sidekick run, and the prompt still told the model it
was in a Thread under a Channel, a structure no conversation has any more. A-4
projects a run's final message into the Sidekick's shared conversation as the
run's row, so "notifies nobody" was false, and the guidance that also had runs
post their report with `conversation_post` put the same report in `"0"` twice.

**Considered and rejected:** Telling an edit from a request by the text, which
would be a second classifier with its own way to misroute.

**Golden hashes moved:** `workstream`, `automationWorkstream` (the paragraph,
the context key, the document line and, for the second, the activation lines),
`memorySweep` (the subject rule) and `memoryDigest` (two group titles) moved
with the prompts; each was regenerated by rendering the case before and after
the change and reading the diff, which held only the edits above.
`compactionCheckpoint` moved only because its fixture's appendix string was
renamed to the new heading; the renderer did not change. The fixed-prompt byte
ceiling (8,500) holds: the new paragraph is shorter than the one it replaced.

**Evals:** The plan asked for the addressing and premature-stop evals before
and after. The addressing prompt is unchanged, so its eval inputs are byte for
byte the same. The premature-stop addressing set, whose wake-up case quotes the
renamed header, was rerun after the change against JEV 1.14.0: 15 of 15 labels
correct.

**Consequences:** Addressing in a Sidekick's conversation has two stages, the
classifier (or the mark) and the Sidekick's routing; anything that adds a new
kind of human input to `"0"` must say whether it is the wizard's. The prompt
files keep their stored names (`workstream.ts`, `outputSurface: "workstream"`,
the memory subject kinds `thread`, `channel`, `breakout`), and the prose avoids
those names until the `memory_facts` rebuild renames the kinds. A future
prompt that names a room must name a Canvas or a Sidekick's conversation, and
a Sidekick report in Rally is its final message.

Design: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.

### 2026-11-03 — Task skills: reporting on data and creating an app

**What changed:** A new `task-skills/` folder holds skills named for an outcome
a person asks for, collected as `TASK_SKILLS` and added to `BUILT_IN_SKILLS`.
The first two are `reporting-on-data`, with a section for Sidekick wizards, and
`creating-an-app`.

**Why:** The existing skills each teach one capability (read rows without loss,
build a site). Requests arrive as outcomes ("a report on our deals", "make me an
app"), and nothing told the model which capabilities to combine or what to
settle first: that a report should join every related source, that an app here
means a live web site, and that shared versus private has to be asked before
storage is written.

**Considered and rejected:** Folding the app question into `building-live-sites`,
which is owned by Terminal and so is missing from the catalog of a run without
it, the run most likely to need to say what an app requires. A separate wizard
skill for reports, which would split one job across two catalog lines.

**Consequences:** A task skill routes and decides; it does not repeat the
procedure skills it names. Keep its catalog line short, since it shares the
catalog budget with every other skill.

### 2026-10-31 — A plugin may render its system message from the active set, and see the run it is in

**What changed:** `HarnessPlugin` gains `renderSystemMessage(view)`, rendered on
every model call in place of the static `systemMessage` while the plugin is
active, and `attachRuntimeView(view)`, handed the run's live view once when
`createPluginRuntime` builds it. `HarnessRuntimeView` answers which plugins are
active and which the run holds. `HarnessTool` gains `yieldsContentParts`, the
host's claim that a tool's result is current-turn content a program cannot
hold, set on `view_image`, `view_resource`, `browser_js` and the image
generators. The first user is `rally:code`, whose `# Code
API` block lists the callable tools of whatever is active this turn
([`code-mode.md`](code-mode.md)).

**Why:** Bind's plugin system message is a static string, and no hook let a
plugin see the run. The code plugin's prompt depends on the active set, and its
gateway has to refuse a call to a plugin the run has not loaded; both needed a
read-only view, and rendering per turn is the same discipline the tool list and
the skill sections already follow.

**Considered and rejected:** Rendering the API into the catalog line, which
every run would pay for whether or not it composes; a host-side activation API
so a program could load a plugin, which would let a tool widen the run's
surface.

**Consequences:** A dynamic message changes the system projection when the
active set changes, which Bind already records as `system_projection_changed`.
A plugin that renders from the view must be a pure function of it, or it costs
the cached prefix on every turn.

### 2026-10-29 — Tool image parts ride the next provider request only

**What changed:** `harnessResultOutcome` no longer folds a tool result's
`contentParts` into the tool message that Bind keeps and the host persists.
The harness holds them in memory and `withCurrentTurnContent` adds them to the
next provider request only, including a compaction summary request. When the
object starts, before its first projection read, the host rewrites loop-state
tool messages that still hold non-text parts to their text, one payload at a
time under the same fact identity, clears the provider-boundary record at the
current revision, and logs `bind_loop_inline_tool_content_retired`.

**Why:** On 2026-10-25 four `generate_image` results put 15.6 MB of base64
PNGs into one Thread's loop state. Every later step rebuilt that state several
times over (projection, prepared messages, a clone, two canonical hashes, the
request body), the Durable Object ran past its memory limit, and because the
bytes were durable every restart did the same: 28 attempts, then a cancel.
`HarnessToolResult.contentParts` was already documented as content that must
never enter a durable receipt or transcript; the bind runtime broke that.

**Considered and rejected:** Storing an image reference in loop state and
loading the bytes for every later request. It keeps every image a Thread has
made in every request, so memory still grows with history and would need a new
cap; the documented design was already current-turn only. A schema migration
for the repair: migrations are synchronous SQL and the payload ID is an
async SHA-256.

**Consequences:** The model sees a tool's image on the turn right after the
tool ran, not on later turns. Any new tool that returns `contentParts` gets
this for free. A restart in the gap between a tool result and the next
request drops that request's parts.

### 2026-10-25 — The model reads Sidekick posts, skipped questions and its opening author

**What changed:** The gap-fill also appends a Sidekick's `conversation_post` (a
`system` turn of type `automation_activation`). `projectSidekickPostMessage`
renders it for both the gap-fill and the history bootstrap: a user-role aside
whose `<rally_author>` trailer holds `sidekick_id`, `display_name`,
`delivered_at` and, when the post forwards someone outside Rally,
`forwarded_from`. Only a post that is the run's own trigger drops the
said-to-the-room header. The history reader now selects each turn's
`author_name_snapshot`, and a skipped question's tool result carries
`skipped: true`.

**Why:** A help-desk Sidekick posted an email and a suggested reply; the member
said "send that reply", and the model had never seen the post, because the
gap-fill took only human, external and imported `text` turns. It replied to an
unrelated Gmail thread instead. The same Thread showed the opening message
naming its author by user id, and a skip reaching the model as a bare
`answer: null`, which it answered by asking again.

**Considered and rejected:** Admitting a post as a `starts_run = 0` loop input,
which reaches the model by the same transition but routes posting through the
pending-input queue for no gain. Giving a Sidekick a `person_id`, which would
let the model resolve "me" to a member who did not speak. A sentinel string for
a skip, which a text answer could equal.

**Consequences:** A post still never wakes the agent. Posts written before this
change sit below `transcript_projected_through` and are not backfilled. A post
whose structured content does not parse keeps its text under "Sidekick" with
no id.

### 2026-10-23 — Table creation supports metadata edits with stable schema

**What changed:** Table creation compares stored schema, reconciles editable
metadata with its receipt, and returns field-specific recovery for incompatible
schemas. Unicode case variants update by the matched column's stable ID.

**Why:** Treating descriptions and usage instructions as schema blocked harmless
edits. A separate metadata write after service-side comparison would still race,
so compatibility, metadata and receipts belong in the storage transaction.

**Consequences:** Metadata edits apply to every authorized run sharing the table.
Column IDs, natural-key order and row/cell data must survive these edits; actual
schema changes require an explicit migration into another table.

### 2026-10-22 — Updates and final responses carry only what participants need

**What changed:** The work-stream prompt replaces its update-every-three-or-four-tool-calls instruction with a brief approach for substantial interactive work and updates only for blockers, unexpected delays, material changes of approach, or participant decisions. Headless runs explicitly skip progress narration, and the help article describes the new policy. Final responses lead with the result, use plain words and active voice, cut repetition and process recaps, and stop when the request is satisfied while retaining needed detail and caveats. The natural-language exception applies only to style. Existing wording is shortened to keep the prompt within its fixed size budget while retaining explicit tool lookup, the ban on invented placeholders, and the distinction between identifiers and read records.

**Why:** A CSV business-case request accumulated progress messages that merely described intermediate checks and the next writing step, followed by a final message that repeated the published document's findings. Tool count was creating a reason to speak without creating information a participant needed, and the general response policy lacked a concise, direct writing rule.

**Considered and rejected:** Keeping a fixed tool-call cadence with shorter updates still rewards routine narration. The existing work indicators already show that execution continues. A fixed response length would not account for requests that need substantial explanation; the rule preserves needed detail and makes clarity take precedence over strict brevity.

**Consequences:** Narration remains available when expectations change, without a tool-count quota. Concision must not omit requested detail or material caveats. This changes prompt guidance only; reviewer acknowledgement loops and the feed's treatment of saved prose remain separate mechanisms.

Pull request: [#1423](https://github.com/juno-ai-labs/avalon/pull/1423).

### 2026-10-22 — Share structured-source handling across output types

**What changed:** Added the built-in `using-external-structured-data` skill for
complete reads, raw-response transfer, coded transformations and field-by-field
checks. It is offered without a provider-specific owner and asks for Terminal
only when local files or code are needed. The site skill loads it instead of
copying the general procedure.

**Why:** A calendar build lost source fields despite a complete Sheet response.
The transfer and validation procedure also applies to reports, imports and other
outputs; keeping it only in the site skill would hide it from those tasks and
encourage separate copies. Site recovery and publication remain in their
existing skill so source-data guidance does not absorb destination behavior.

Pull request: [#1421](https://github.com/juno-ai-labs/avalon/pull/1421).

### 2026-10-22 — Identify the agent in completion judgments

**What changed:** Completion verification identifies Rally and its mention syntax,
scopes requested work to that agent without requiring a literal mention, and
distinguishes requested waiting from a blocker or an unfinished immediate task.

**Why:** A production request assigned review to a person and explicitly told
Rally to wait. The judge accepted Rally's acknowledgement at 0.55 confidence,
below the 0.70 stopping threshold, triggering a second acknowledgement from the
same run. The judge had the conversation but no definition of which participant
was the AI.

**Considered and rejected:** Lowering the stopping threshold or bypassing checks
on messages containing `@Rally`. Neither supplies the missing identity context,
and a mixed-addressing message can still assign immediate work to Rally.

**Consequences:** The question's identity and addressing semantics are part of
the classifier contract. The existing threshold, lifecycle gates and one-use
recovery remain in force; prompt changes are checked with live model regressions,
not a provider double that returns the expected label.

Pull request: [#1422](https://github.com/juno-ai-labs/avalon/pull/1422).

### 2026-10-22 — Select eligible Sidekick delegates through existing receipts

**What changed:** Eligible delegates' connections enter the Sidekick inventory.
Code-authored tools can fall back after a definite pre-effect access refusal.
Write receipt checkpoints record actual accounts privately and retain the original
account only for recovery of that exact uncertain effect. Reads skip account
checkpoint I/O; background model/tool boundaries reuse activation eligibility
and check only root lifecycle and stop generation. Delegation changes
use ordered actor/target receipts, including autonomous mutations. Provider-key
recovery preserves the original provider key, including Calendar event creation.

**Why:** A Thread-owned Sidekick could use a person's consent for a Sheet event,
but the connector executor still admitted only the coordinator's credentials.
The user requested simple delegation and eventual consistency, then explicitly
removed account-dependent workflows, selectors and user-facing account activity.
Repeated background eligibility scans and read-account checkpoints added serial
durable work despite the accepted eventual-consistency contract. Unused detail
status and duplicate matching/repository reads likewise contributed no required
product behavior.

**Considered and rejected:** Per-person workflow loops, credential pools, access
preflights, resource/reply/page account bindings and a separate identity selector.
The existing connector refusal and receipt primitives cover the required behavior.

**Consequences:** Each new operation selects independently. Uncertain effects
remain on their original account to prevent duplicate writes. Account details
remain queryable in the receipt database and are not exposed in normal app UI.

### 2026-10-22 — Explain unsupported local browser requests through a skill

**What changed:** Ordinary conversations can load `using-the-local-inapp-browser`
to explain that they cannot inspect a page open in Rally and offer appropriate
inputs, including the existing import action for ChatGPT or Claude conversation
text.

**Why:** A request to reproduce an open Claude document's visual style fell back
to a public-web read of its sign-in page. The agent described that as browser
inspection and later claimed a visual match after only rewriting Markdown.

**Considered and rejected:** Adding a per-skill exclusion for the importer.
Agent profiles already declare their complete skill catalog, so preserving
that boundary also keeps future general guidance out of fixed-job loops.

**Consequences:** The skill is offered without a browser owner plugin and grants
no browser access. Profiles inherit no general skills; the importer receives
only its three AI-chat reading skills. When ordinary conversations gain browser
access, update this limitation alongside the tools.

### 2026-10-22 — Distinguish a Sidekick activation from setup

Run policy names the existing Sidekick and Rally’s responsibility for its regular
schedule. The task context includes its ID and definition revision; a derived
activation message supplies the run ID and actual trigger.
The calendar’s first activation interpreted a completion recheck as unfinished
automation setup and created a duplicate. Explicit execution identity addresses
that confusion while retaining the ordinary completion check and tool authority.

### 2026-10-22 — Reconcile the first synchronization and transform actual source rows

**What changed:** Tracking distinguishes historical notification suppression from
synchronizing an existing output. Site refresh instructions claim and import the
current publication before comparison, reconcile first-run differences, and parse
complete machine-readable connector records rather than handwritten row lists.

**Why:** The calendar setup applied notification baselining to a site mirror and
placed comparison before recovery of the published data. That could discard
changes before the first timer or compare against missing files. The builder also
copied rows manually despite loading the skill. Explicit input and completion
boundaries address those concrete failures without adding a second sync system.


### 2026-10-21 — Carry trigger decisions and site recovery into saved runs

**What changed:** The event skill branches explicitly between requested schedules,
resolved event watches and justified polling, and saves the choice's rationale.
The site skill backs up existing local files and imports the current published
source before each refresh, retaining unfinished work while preserving newer
changes made in another sandbox.
Saved instructions identify the resource,
owning thread, import and publication paths, and data format. Runs account for
every requested source row and check each stage of completion separately.
Sandbox-specific Terminal guidance is sent only to Sidekick conversations,
while the standing prompt describes their separate conversations. The tracking
skill coordinates overlapping updates with a revision-checked output claim;
the site skill holds it through import, edits and publication. Public help
explains shared files and the current execution-user boundary.

**Why:** The content-calendar experiment chose polling before resolving its event
resource and expected a later activation to inherit the creator's files.
Sidekick runs now
share their wizard's sandbox, but the requesting Thread remains separate and
files still need recovery after a reset. Skills
present in one conversation did not make those steps durable for the next agent.
Another reminder to load a skill was insufficient; the decisions and recovery
steps must be saved with the work. Evaluation must observe resolution, import,
row coverage and publication, rather than counting skill loads.

### 2026-10-21 — Seen-item tracking is shared by authoring and execution

**What changed:** `tracking-seen-or-done-items` owns the durable-table procedure formerly
inside `polling-for-events`. It is scoped to Tables access and applies to any
workflow whose independent runs need shared state. It directs runs to load
Tables and select an authorized scope they share; the polling skill loads it
as a companion when configuring a watcher.

**Why:** Remembering completed work is needed by event-driven Sidekicks as well
as timers. Keeping the procedure inside an authoring-only polling skill made
execution runs unable to load the table-access playbook directly. Read-then-act
also allowed overlapping runs to repeat effects before either recorded success;
a claim must be distinct from completion, and the first triggering event must
not be discarded as a historical baseline.

**Considered and rejected:** Copying the instructions into a second skill would
leave two definitions of stable keys, baselines and completion ordering to drift.

**Consequences:** Table and deduplication guidance belongs in the shared skill;
trigger selection and polling cadence remain in `polling-for-events`. Loading
the skill grants no table access or Sidekick authoring tools. The Tables prompt
and skill share the claim-before-action, complete-after-success ordering;
recovery requires verified ownership and replay safety rather than an invented
claim-expiration timeout.

Pull request: [#1394](https://github.com/juno-ai-labs/avalon/pull/1394).

### 2026-10-21 — Google plugin splits preserve verified receipt identities

**What changed:** Google views carry compatible prior single-family and combined
surfaces, including their canonical IDs, into receipt replay and idempotency lookup.

**Why:** Splitting an already-used credential changes the plugin ID and whole
surface hash without changing a completed operation. Treating that receipt as a
new tool could interrupt recovery or repeat an effect. Accepting ID aliases alone
was rejected because a changed schema or policy must still refuse replay.

**Consequences:** Compatibility is proved against reconstructed tool surfaces
and the existing connection, operation and policy fences; future changes must
preserve those checks and the captured pre-split receipt regression.

### 2026-10-21 — Verify uncertain completion once before ending a turn

**What changed:** Ordinary persistent loops use the evaluated baseline JEV
question with a 0.70 stop-acceptance threshold and one durable verification
reprompt. The nudge and its execution-scoped marker commit as one derived fact.
Message-less Sidekick activations resolve their request from the versioned
definition used by the acting model. Stop fences the nudge commit and next
reservation; teammate lifecycle includes queued work and earlier delegations.
Committed reprompts have a separate, deduplicated telemetry event so classifier
recommendations cancelled by lifecycle gates do not inflate recovery counts.

**Why:** A promise that work is underway was being accepted as the final answer.
Missing unfinished work is more costly than an extra verification turn. The chosen
baseline caught all 19 eligible positives in the exploratory corpus; prompt
variants increased confidence in a wrong answer and missed a recovery.

**Considered and rejected:** A strict unfinished-label confidence gate misses
confidently misclassified promises. An in-memory recovery flag resets after
eviction, and checking current transcript text loses the marker on compaction.
The host preserves lifecycle exclusions; the judge cannot override cancellation,
existing work, ambiguous writes or required input.

### 2026-10-21 — Classify deferred-request continuations separately

**What changed:** History excludes blank tool turns before selecting ten text
turns. A dedicated JEV continuation decision, with sender identity, composes with
ordinary addressing: ready follow-ups wake Rally; partial, human-owned, cancelled,
superseded, and completed-work follow-ups leave it inactive; new requests retain
ordinary addressing. Both classifiers start concurrently; uncertain continuation
decisions use a focused Sol fallback and hand back to addressing if still unsure.
Later admissions wait for earlier preparations to settle and classify against
canonical text plus accepted queued text, preserving contributor order.

**Why:** A requested report could look like human conversation even though its
arrival made earlier work ready. Tool turns displaced that request from history,
but restoring it did not fix the actor classifier's status-report boundary.
Extending that prompt introduced false invocations on human-owned and completed
work. A separate continuation decision preserves ordinary addressing and corrects
false invocations on informational follow-ups.

**Considered and rejected:** Overloading addressing with ownership, prerequisites,
and closure checks made unrelated routing regress. A binary continuation result
could add missing wake-ups but could not suppress existing false ones without
also suppressing new requests; the third decision hands new requests back to
addressing. Durable pending-wait state would require a new registration and
lifecycle; this change uses the bounded transcript instead. The existing DeepSeek
fallback misclassified human-owned tasks in live evaluation, so continuation uses
the separately evaluated Sol route.

**Consequences:** Messages with history spend two overlapping checks, cancelling
ordinary addressing when it is unnecessary. Concurrent human admissions wait on
earlier preparations so two final reports cannot both miss each other; failed
preparations contribute no text. Active-task and connector addressing signals
remain with ordinary addressing. There is no recovery beyond the latest ten
text turns. A compact evaluation summary preserves the historical results;
review fixes changed composition and clarified sender identity, with corrected
synthetic regressions evaluated again.

PR: [#1376](https://github.com/juno-ai-labs/avalon/pull/1376).


### 2026-10-20 — Resume verified settled history after a loop relocation

**What changed:** Added host validation for historical accepted, failed, and
stopped reservations. Pending reservations and unfinished tool batches still
require host settlement before inference.

**Why:** A relocated conversation may retain historical turn IDs; the incident
and host proof are described in [Workstream Durable Object](workstream-durable-object.md#changelog).

**Considered and rejected:** Unconditional acceptance would bypass the host's
proof that historical state is settled and consistent.

**Consequences:** The harness preserves historical IDs and allocates the next
turn under the current loop ID. Hosts without validation retain strict rejection.

### 2026-10-20 — Opening messages can establish a conversation without starting work

**What changed:** A shared three-way JEV decision gates the first message in a
Thread or Breakout. Human-to-human messages and names/descriptions persist
without a run; prompts and unavailable or uncertain classifications start one.

**Why:** Thread creation previously always invoked Rally, and single-person
Breakouts bypassed addressing. Naming a conversation or speaking to another
person therefore elicited an unwanted agent reply.

**Considered and rejected:** Reusing the later-message classifier unchanged:
it does not distinguish naming a conversation, and its uncertain policy can
silently drop an opening work request. A second generative fallback would add
latency where the requested safe default is simply to process the prompt.

**Consequences:** Silent initialization is a complete, retryable create.
Subsequent messages must still activate normally. Public creation receipts must
replay silent openings as well as openings with runs, and explicit Slack summons
or started opportunities must bypass classification. Independent routing and
materialization overlap with JEV to avoid serial latency. Classifier details stay
internal; silence never becomes an explanation of classification. The prompt's
synthetic evidence does not replace production calibration.

### 2026-10-19 — Google meeting knowledge loads against an authorized connection

**What changed:** A reusable meeting-notes skill covers Calendar references,
Drive-only Docs, transcript segments, Gemini summaries, and access failures.
The API offers one copy owned by an eligible frozen Google connection; authoring
and connector messages point to it instead of repeating the procedure.

**Why:** Repeated follow-up workflows confused Calendar attachment metadata with
where Google stores the document, and a missing attachment or Meet-specific
tool was treated as proof that notes could not be read. Google also has both
new and legacy folder layouts, and manual notes may never be attached.

**Considered and rejected:** Offering a Google-specific skill globally would
advertise it to runs with no usable Google connection. One copy per connection
would duplicate the same catalog entry when Mail and Drive are separate presets.

**Consequences:** Connection selection stays in the host's frozen authorization
scope. Loading instructions grants no tools. Future guidance should extend the
shared skill and its sourced reference rather than expanding standing prompts.


### 2026-10-19 — A wake-up fires in the conversation that scheduled it

**What changed:** `schedule_wakeup` had already written a Breakout's or a
Sidekick run child's wake-up into that child's own object, but nothing after
the write followed it there. The child's alarm loaded the row through a port
that named no substream, which from the object's bare `this.env` dispatches to
the parent's Main; Main had no such row, the timer returned, and the stall gate
held it forever. `refreshAgentTimerAlarm` re-armed Main, and
`launchWorkstreamHarness` hard-coded Main's loop and `parentKind: "workstream"`.
The alarm now names its own substream, `fireWorkstreamWakeup` takes the
conversation and launches into its loop, and a Sidekick run child's wake-up
carries the `automationRun` and continuation `continueSidekickRun` answers.

**Why:** Production held 95 such timers across four conversations, 91 in one
Sidekick whose ten-minute runs each scheduled a daily wake-up, the oldest on
attempt 1,150 after two and a half weeks. Moving every wake-up back to Main was
rejected for the reasons the section above gives.

**Consequences:** A wake-up run's `parentKind` is now the object's own, as a
message-started run's already was, and a delegated worker's wake-up carries
`backgroundAgent` as its message-started runs do; a stopped worker's wake-up is
consumed without running. Every port the fire uses names the conversation. The continuation note a Sidekick run child's
wake-up reads names Rally as the sender and the run as the source. A timer
whose row is still pending after its handler returns now throws a named code —
`agent_timer_wakeup_unreachable` or `agent_timer_claim_lost` — instead of
stalling silently, and both alarm reports carry `substream_id`.

### 2026-10-19 — Prose memory leaves the harness; the tables stay

**What changed:** The scoped-memory items, their hybrid search, the Vectorize
projection and admission-time recall for every run kind are gone from this
module. `rally_memory` now carries `memory_recall`, `memory_remember` and
`memory_forget` over a fact store with source-based visibility, owned by
[`agent-memory.md`](agent-memory.md). `resolveMemoryAccess`, `ensureScope` and
the `rally_tables` plugin stay here.

**Why:** See the owner's entry: nine memories across every Organization after
two months said the model-chosen scope design was not producing memory. This
module's boundary moved; the reasoning is there.

**Consequences:** `loadRunPromptContext` no longer takes a lease or returns a
memory context hash, and the preparation breakdown has no `memory_context_ms`
or `memory_recall_required`. A run's scope hash no longer includes a memory
hash; `run_scopes.memory_context_hash` is always NULL.

Shipped in #1300. Design: `docs/PRDs/2026-10-18_agent-memory/prd.md`.

### 2026-10-18 — The settlement lane asks JEV what a settled turn calls for

**What changed:** `settleAgentRun` gained a last step after the description
loop: the turn-disposition observer, which runs deterministic gates and then
`judgeTurnDisposition`, the third JEV caller beside addressing and the
semantic trigger gate, over a state naming the parent, the conversation's
charter, what it has produced so far, the newest three messages and the judged
turn. Every provider call is recorded through the classifier diagnostic sink
under `turn_disposition_classifier`. The step never fails settlement. The
harness also gained the `suggestion_draft` prompts, golden-hashed. The
mechanism is owned by [its retirement record](workstream-durable-object.md#2026-11-08--retirement-records-conversation-suggestions-session-import-work-stream-origin-attachments) (retired);
the question, its 0.6 threshold and its three recent messages are pinned to the
corpus evaluation and the GEPA ablation in
`docs/PRDs/2026-10-17_merge-and-breakout-suggestions/design.md`.

**Why:** the settlement lane is already the platform's "something finished,
look at the conversation" hook, durable on the run row and retried with
backoff, and the two model calls it makes are slower than this one; a Queue
hop with a return RPC would add a queue and a dispatch branch for a call the
lane has room for. JEV rather than a generative judgement because the answer is
one member of a closed set and the threshold has to be applied to a confidence
the provider computed, the lesson `contextual-routing.md` recorded when the
router was retired.

### 2026-10-09 — OpenRouter agent turns stream over the Responses API

**What changed:** The OpenRouter streaming client sends agent turns to
`/api/v1/responses` instead of `/api/v1/chat/completions`. Only its wire layer
changed: `toResponsesInput` and `openRouterResponsesRequest` translate Bind's
Chat-shaped messages out, and `createResponsesStreamReducer` translates the
event stream back into the Chat-shaped result Bind stores. Bind builds the body
once, archives it, and passes it to the client to send as-is. Azure turns,
structured calls and embeddings are unchanged. A Responses stream's transient
failure codes (`server_error`, `rate_limit_exceeded`) traverse like the numeric
ones Chat streams sent. A model that cannot read an input the request carries
now fails as `model_input_unsupported`, read from OpenRouter's
`failed_routing_step` (image, file and audio filters only).

**Why:** OpenAI is moving tool calls with reasoning off Chat Completions
(GPT-5.4 onward refuses tools with any effort but `none`; GPT-6 Astra needs
Responses for any tool call; GPT-6.1 Sol, the default primary, is documented as
"use the Responses API for tool calling"). OpenRouter's GPT-6 guide says it
already translates some Chat fields into Responses items for these models, so
staying on Chat Completions meant depending on a translation layer for the
default model's core path. Token prices are the same on both endpoints, and
OpenRouter's Responses endpoint is stateless, so retention and payload size do
not change. Live two-turn tool loops on Sol 6.1, Gemini 3.8 Flash and Grok 4.6
completed with synthetic `fc_` ids and reported cost and cached tokens. The live
sweep that verified the switch also found a DeepSeek V4 Pro run with an image
attached failing as `harness_execution_failed` while OpenRouter's 404 named the
cause, which is the generic-code defect CLAUDE.md forbids.

**Considered and rejected:** Changing the transcript to Responses items. It
would have meant a Durable Object storage migration and touching every caller
for no gain this change needs; the translation at the client is cheap and
reversible. Replaying reasoning items was left out: it needs a place in the
transcript and a rule for dropping them on compaction and on a fallback to
another model, and is the change that would realize most of the Responses API's
benefit. Building the body in both Bind and the client was the first version;
it serialized the whole transcript twice per attempt on the startup path.

**Consequences:** The transcript stays Chat-shaped until reasoning replay gives
it a reason not to. Any new streamed provider request field goes through
`openRouterResponsesRequest`, never around it, or the archived body stops being
the body sent. A new transient stream code from the Responses API belongs in
`providerDeclaredTransportFailure`'s allowlist, or that outage fails as Rally's
defect. A tool-support, provider or price routing refusal keeps the catch-all,
because the member has nothing to remove. OpenRouter's Responses endpoint does
not expose Anthropic per-block `cache_control` or its 1-hour TTL; explicit
Claude caching would need `prompt_cache_breakpoint` or the Messages endpoint.

Shipped in #1182.

### 2026-10-02 — Sol low is the default primary model

The checked-in Global Worker and development environment now select
`openai/gpt-6.1-sol`; the canonical model registry gives Sol low reasoning
unless a caller explicitly overrides it. The same local conversation imported
correctly in 68.8 seconds at a reported $0.145 with low reasoning, compared
with 158.6 seconds and $0.357 at the provider default. These individual trials
motivated the reversible default change; they are not a general benchmark.
Existing Flagship targeting can override the primary model, and explicit
reasoning settings continue to override the registry.

### 2026-10-01 — A conversation can be provisioned to do one fixed job

**What changed:** A conversation can carry an agent profile, stored on it at
provisioning, that fixes its run's system prompt, model role, whole tool
surface, skill catalog and run-end cleanup. `session_import` is the first; it
names three new browser-owned skills that read AI chats.

**Why:** The conversation importer needed an agent loop whose only tools drive
the person's browser, whose prompt is its own, and whose model must read
screenshots. Nothing let a run narrow its tool surface: `defaultPluginIds` only
preloads, and every run assembled the full built-in and connector set. Without
the skills the importer re-derived each provider's page on every run — 9 of 19
calls reverse-engineering ChatGPT's markup, a DOM read that silently dropped 8
of 15 messages, a page script that sent the signed-in site's cookies to the
model — and with them it read the page's own data in 6–14 calls. The run-end
hook exists because an import's reserved Channel was otherwise left listed
whenever its window closed without discarding it.

**Considered and rejected:** A profile field on the activation, which any
activation path could forget. A new Durable Object for the import, when the
loop and its durability already live here. Provider reading knowledge in the
system prompt, which every run would pay for in full; as skills a run pays for
the catalog line until it loads one, and any browser-bearing run can use them.

**Consequences:** A profile is fail-closed: an unknown stored profile is a
failed run, never the default surface, and a future profile must keep it so. A
profile cannot change under a running conversation. An `ended` hook runs after
every executed run's terminalization, whatever its outcome, so it must be
idempotent and cheap when there is nothing to do. A run cancelled before it ever
executes reaches no terminalization and runs no hook.

Shipped in #1058.

### 2026-09-27 — A run's result reaches a conversation only by conversation_post

**What changed:** The `# Result delivery` section of the work-stream system
prompt and the `rally:sidekick-result` plugin (`post_result`, formerly
`automation_post_result`) are gone. A Sidekick run's instruction about where
its work goes now lives in the `rally:conversations` system message: its final
message stays in the run, and when the instructions say a conversation should
hear something it posts it with `conversation_post`, once, in full, after the
work is done. This reverses "2026-09-03 — A run delivers its own result, and
no trigger narrows its tools" (the section's two arms) and the consequence in
"2026-09-03 — Drafting is a conversation, and a run reads its automation by
revision" that a prompt edit keep the populated arm naming
`automation_post_result` and no other path.

**Why:** The one result tool could reach only the owning Channel's Main and
was keyed on the run, so a run homed in a Breakout, or one continued to
forward a second reply, had no way to deliver; the argument is
[`conversation-tools.md`](conversation-tools.md#changelog)'s. What the first
answer got right still holds: a run must not read silence as "Rally has it
covered", so the replacement instruction says outright that the final message
reaches nobody outside the run.

**Considered and rejected:** Keeping `# Result delivery` and rewording its
populated arm to name `conversation_post`. The home is now one of several
reachable conversations, chosen by the instructions, so the prompt section
would restate the plugin's own system message in a second place.

**Consequences:** A prompt edit that tells a run where its result goes belongs
in `conversationsSystemMessage`, which a test pins.

Shipped in #1006.

### 2026-09-23 — Remove repeated cross-resource checks from model and tool turns

**What changed:** Initial plugin authorization checks run concurrently, with preparation and durable writes kept in stable order. Bind reuses the host's just-validated activation IDs during immediate rehydration instead of repeating connector and provider health checks; other restored hints are checked concurrently and applied in hint order. Active plugin continuation checks run concurrently, and connector continuation preserves the activated tool surface without a connection-row read. The final run-authority and lease checks run concurrently after them. A connector tool call reads live run authority and the connection row together before receipt replay or execution and passes that validated row to credential preparation and execution without a second live check. Built-in reads spend the model-call run-authority result while writes still recheck. Sidekick skill access is resolved at run start and on new skill load, then held for that run. Principal and Channel identity reads also overlap. Model windows arrive from the Channel agent's KV-backed memory rather than a provider catalog request.

**Why:** Repeating D1 and Durable Object checks once per active plugin serialized cross-resource latency before every model call. Initial activation also checked each connector serially and then paid for the same provider health and authority reads again when Bind restored the persisted hints in that same attempt. Tool execution then checked the same authority and connection row three times, with a separate liveness and run-authority read before them. A validated row can be carried through this one tool invocation without another round trip after credential preparation. Re-resolving active Sidekick skills fanned out across WorkspaceDO and Sidekick DOs for every model and tool turn even though their instructions were already in the run snapshot. Built-in reads paid a second run-authority round trip after the model boundary that had just authorized their turn. Provider reservation and Bind transitions remain ordered because those commits define the durable turn boundary.

**Considered and rejected:** Caching connector grants across tool calls would let a later tool call or receipt replay use authority that was revoked before that call began. The post-preparation check was also considered and removed: it narrows, but cannot close, the revocation race before a provider effect and adds another D1 and WorkspaceDO latency hop. Run-wide authority for built-in writes was rejected because a model turn can take long enough for a stopped run to attempt an external effect. The model call's final run-authority check remains.

**Consequences:** Initial connector checks may finish in a different order, but successful activations are persisted in stable order and only those IDs bypass Bind's immediate duplicate check. Revocation between that check and first provider dispatch may leave a connector model-visible until tool use, where the live tool boundary rejects it. Each model call still waits for one fresh run-authority decision. A revocation during a tool call's credential preparation may allow that call, including a write, to finish; the next call is rejected at its own boundary. A Sidekick audience change takes effect on the next run for skills already loaded; built-in reads can finish from a model turn admitted before revocation.

### 2026-09-20 — Translate unspecified optional scalars at the model boundary

`buildPlugin` now advertises a synthetic null alternative for independent,
optional, non-nullable top-level scalar arguments. `runToolCall` removes only
those synthetic nulls before numeric/blank normalization, input hashing,
authorization, receipts and validation against the original execution schema.
Both core and dynamically loaded plugins use the same adapter; read/write mode
does not affect this explicit representation. No strict-mode setting changes.

The pressure was Canva calls containing punctuation in an optional Brand Kit ID.
Omission prose had not prevented the model inventing a value. Stripping punctuation
would guess intent, so strings remain unchanged. Existing nullable arguments retain
null (including clear operations). Referenced properties are excluded because
older schema dialects ignore scalar keywords beside `$ref`. Descriptions, titles
and defaults remain on the outer property rather than being duplicated or moved
inside its nullable alternative. Nested values and roots with composition,
conditional, presence or unknown constraints are not adapted; broadening that
scope must preserve both the authored null semantics and field dependencies.
This supplies a valid representation, not a guarantee that a model will choose it
or that every Canva generation failure has the same cause.

### 2026-09-19 — An interrupted write is asked what it did before it is called unknowable

**What changed:** Crash repair of an interrupted tool batch no longer classifies
an unsettled write on `mode` alone. A receipt now carries the idempotency class
its plan already recorded, and the repair walk *re-enters* the tool over that
same receipt — through `reenterInterruptedWriteForRecovery`, which builds the
one plugin owning the call — before considering the outcome unknown. Only a tool
that cannot be asked, or an attempt to ask that failed, still settles
`ambiguous_external_write`, and its receipt, its log line and the model's tool
result now name the tool and why the question went unanswered.

Four mechanisms moved with it. `reconcileRecoverableTerminalWrite` became
`reenterInterruptedWrite` and takes its decision from `HarnessTool.reenterable`
rather than three hard-coded Terminal names; `publish_resource` declares it, and
so does every tool the old list held. `HarnessTool.reconcileEffect` is the
second half of that decision, for a tool whose executor resolves its effect by
*subject* rather than by receipt. `ToolReceiptStorage.admit` gained
`resume_write`: an unsettled `provider_key` write whose plan, request hash and
provider key all match the call asking to run is resumed rather than settled
ambiguous. And a residual ambiguity no longer fails the cycle — the repair
finishes the protocol array and the run continues.

Six things were wrong in the first cut and are recorded because the reasoning
that produced each was plausible, and because together they say what this kind
of change costs to get right.

Three were about the re-entry itself. It did not revalidate run authority,
because it looked like the continuation of an authorized call rather than a new
one; it is a tool call, and `beforeToolCall` proves authority on every other
one. It ran under a signal that never aborted, on the theory that the tools
reached carry their own budgets — but a claim holds a 300-second lease and
`run_command` may run for 900, so the re-entry could outlive the lease its own
settlement is fenced on; it now holds that lease open and aborts when it cannot.
And it built Terminal without the publication scope `loadHarnessTools` freezes,
which for a work-stream scoped Sidekick resolves `publish_resource` under the
Sidekick's own conversation instead of the room that owns it — the reconciler
would then look for the interrupted publication at a path identity it was never
written to.

Two were about what the repair says. The model-facing result for a residual
ambiguity carried the bare code while the tool name and the instruction went
only to the participant lifecycle: the generic-code defect, on the one path
where continuing instead of stopping depends on the reader being told. And the
settlement failure was caught with the re-entry, so a tool that *answered* and
whose answer could not be written to R2 reported "could not confirm" while
holding the confirmation — the same defect one line further down, now
`reentry_result_not_durable`.

The last was the ordering. Removing the failing arm from the caller let
`ambiguous` outrank `waiting_for_input`, and while an ambiguity failed the cycle
the two could never collide. A batch holding both a withheld elicitation and an
unaskable write would have started the harness on an assistant turn whose
question had no result. Pending human input now outranks everything.

`publish_resource`'s own correction is above: it was declared re-enterable on
the strength of its matching-digest branch alone, and `reconcileEffect` exists
because that branch is not the whole behaviour.

**Why:** On 2026-09-19 a `SubstreamAgent` isolate was replaced two seconds into
a `publish_resource` call. The repair found the receipt `executing`, read
`mode === "write"`, and killed the run — discarding seven completed tool calls
in the same batch and giving the member `ambiguous_external_write` and a request
ID. Nothing about that call was ambiguous. `publish_resource` is `provider_key`,
it was admitted under a stable key, and its executor's first act is to look up
the document `(work stream, published path)` already holds and return it
untouched when the bytes match. The one thing that would have answered the
question was running the tool again, which the repair path had no way to do
because it runs before the run's tool registry exists. It does not need the
registry: it needs the plugin owning the one call it is repairing, and Terminal
is built from exactly the `(env, input)` the repair already holds.

The class distinction is the point, and it is why this is not "retry writes".
`record_before_execute` has no provider-side dedupe and keeps the ambiguous
outcome; `provider_key` promises the provider collapses two calls carrying one
key, and the repair re-submits under the key the interrupted attempt was
admitted with, never a fresh one — a new key is a second write wearing the name
of a retry. `reenterable` is a separate claim, host-authored and deliberately
absent from `ToolDefinition`, which also parses remote MCP declarations: a
server that could assert it would be asserting that Rally may repeat its writes.

Continuing past a residual ambiguity is a traded-off loosening, and the trade is
recorded because the next reader will want to undo it. The stop was there in
case a model handed an ambiguous write simply repeats it. That risk is real and
unchanged. What the stop did not do is prevent it: the member re-sends, a fresh
run mints fresh receipt coordinates, and nothing in the receipt layer connects
the new call to the abandoned one — so the cycle died for nothing, and took its
siblings' completed work with it. Continuing puts the ambiguity in front of the
only reader who can check before acting, as a tool result naming the call and
saying to check it first. A future change that wants the stop back needs a
receipt-layer link between a re-sent call and an abandoned one; without that it
is buying the same nothing.

**What a future change has to respect:** re-entry proves current authority
before it runs anything. `beforeToolCall` does that on every ordinary dispatch
and the repair path bypasses the hook entirely, so it calls
`assertRunAuthorityStillValid` itself; without it a principal who lost
membership between the interruption and the repair would still have their write
executed.

Re-entry also needs a *lease*, not just the fence a settlement runs under, and
the two are separate parameters because one caller has only the fence. The
loop-failure settlement path reconstructs an owner rather than minting a lease,
deliberately — handing a lease back to `ToolReceiptStorage#fence` would be
asking the row to vouch for itself, since that fence compares what it is given
against the same row it read. That is enough to settle a receipt and not enough
to hold a claim open while a tool runs, so a repair without a lease leaves an
interrupted write ambiguous with `no_repair_lease` rather than obtaining an
answer it has no claim to record. The reason is named rather than folded into
the bare code because "nobody asked" and "the question failed" are different
repairs and only one is worth chasing.

Next, a `null` idempotency class — an
unparseable plan, or a receipt written before the class was read back — is
treated as `record_before_execute`, the class that assumes least. A `completed`
or `failed` receipt is never re-entered: the first has a durable result to
replay and the second may already have been read. An `ambiguous` one *is*, and
that is not an exception to a rule about settled receipts — it is what the state
is for, being what a previous re-entry attempt left behind, and
`findCompletedToolResult` reaches it deliberately through
`allowAmbiguousReconciliation`. And the re-entry is bounded twice, by numbers that already
existed rather than invented ones: the tool's own declared `timeoutMs`, which
Bind applies on every ordinary dispatch and which re-entry has to apply itself
because it does not go through Bind, and the attempt lease, which it holds open
and aborts on when it cannot renew — `run_command`'s 900 seconds outlives a
300-second claim, and the lease is what the settlement is fenced on.

**Considered and rejected:** routing a residual ambiguity to `needs_input`, the
human-escalation the live path already has at `halt: "needs_input"`. It would
preserve the batch's completed calls without letting the model near the
ambiguous call, which is the better of the two on its face. It is rejected
because crash repair has no question to escalate *with*: `needs_input` reached
without a durable `elicitation_requests` row is the state the 2026-08-15 entry
below records as a production defect — a run stopped with nothing to answer, no
failed tool row, and a null error. Restoring it here would mean minting a
question on the member's behalf about a write they did not make, which is a
larger change than this one and a product decision rather than a repair.

Also rejected: a per-tool `reconcile()` hook as the *primary* mechanism, which
was the first design. Re-entry is better where the executor already resolves its
own effect, because a reconciler there is a second copy of a lookup free to
drift. `reconcileEffect` exists for the case where that reasoning does not hold,
not as the general answer.

**Left undone:** `resume_write` applies to every `provider_key` write, and that
is safe because every one of them in this tree — memory `add`/`update`
/`invalidate`, the four table writes, `schedule_wakeup`/`cancel_wakeup`,
`request_elicitation` — writes to a Rally-owned authority and begins with a
replay lookup keyed on that same provider key. What none of them has is
`reenterable`, so *crash repair* still cannot ask them and an interrupted
attempt of one stays ambiguous. Picking it up means declaring the property on
those tools and teaching `reenterInterruptedWriteForRecovery` to build their
plugins, which are core rather than Terminal and are constructed differently —
it is the one reason that function names Terminal rather than resolving a
plugin by id.

### 2026-09-19 — Close abandoned Canva transactions from durable receipts

The terminal run's external-settlement lane now cancels known open Canva editing
transactions. The start tool records its provider transaction ID with its normal
successful receipt; cleanup claims and outcomes are append-only checkpoints on
that receipt. A separate transaction table or timer would duplicate the existing
run lifecycle and could cancel while editing is still underway. Other runs cannot
spend the transaction, and cleanup begins only after terminalization.

A dispatched commit without a completed receipt is uncertain and is never
cancelled or replayed. A lost cleanup response also remains uncertain rather than
repeating a mutation. The post-run diagnostic retains this state for reconciliation;
Canva exposes no verified transaction-status lookup, so automatic reconciliation
is not claimed. Cleanup rechecks the personal owner, active membership and stored
connection, and uses the same credential door and MCP deadline as normal calls.

### 2026-09-18 — A 400 that names its own cause stops being reported as ours

**What changed:** `context_length_exceeded` joined `HarnessFailureCodeSchema`,
with kind `context`. `isProviderContextLengthRejection` in `bind-runtime.ts`
reads the endpoint's own machine code out of a captured rejection — directly
from `error.code` for Azure and OpenAI, and by parsing the envelope OpenRouter
forwards in `metadata.raw`, since it reports its own numeric 400 instead of
adopting the upstream code — and the outer catch names the run with it in the
position the catch-all used to hold. Routing is untouched: the rejection still
traverses every candidate for the model first, and the code is read from the
last attempt's error once they have all refused.

**Why:** a run failed on 2026-09-17 against an Azure deployment that accepts
922,000 input tokens while compaction sized it from the 1,050,000 the OpenRouter
catalog reports for that model, so no compaction ran and a 1,415,120-token
request went out. Azure refused it with `context_length_exceeded` in the 400
body, and the run reached its member as `harness_execution_failed`: Rally's own
defect, "retrying is unlikely to help", no next step, and nothing for an
operator to look at — while the log had carried the real code the whole time.
That is the generic-code defect `CLAUDE.md` names, on a path that had the reason
in hand, and the cost is that the sizing bug underneath it reads as an
unexplained outage in every run that hits it.

**Considered and rejected:** *reporting it as `context_limit_exceeded`*, the
code that already exists, which avoids a second near-identical name. It says the
opposite thing about who was wrong: that one is Rally's own accounting declining
to send a run it cannot make fit, and reusing it here would file "the window
Rally sized against is wrong" under "Rally correctly refused", which is the one
distinction an operator needs. *Matching the provider's message text*, which
would have caught more providers and also any rejection that happened to mention
a length; the machine code is bounded and the prose is not. *Making the
rejection terminal so it stops traversing*: a second endpoint for the same model
may have a larger window, and one that does turns this into a recovery.

**What a future change has to respect:** the invariant that a request Rally owns
is never named as the provider's is about *ownership*, and this code does not
weaken it — the kind is `context`, not `provider`. Read the forwarded envelope
by parsing it, never by searching `providerError.detail`, which holds the whole
response body including the provider's free-text `message`: the first revision
searched it and would have relabelled any 400 whose prose named the code. Cover
each transport on a model whose route policy *terminates* on it — the terminal
catch classifies the last attempt's error, so an ordered model proves only the
provider it traversed to. The fix for the sizing itself
belongs in [`context-compaction.md`](context-compaction.md), and this code is
what makes reaching for it possible rather than a substitute for it: a
deployment's input limit is the authority on what fits, and the catalog's
`context_length` is not always the same number.

### 2026-09-18 — JEV is three primitives, and addressing is one of its callers

**What changed:** the TypeSafe endpoint, the response envelope, the owned
deadline, the `typesafe_*` failure vocabulary, the diagnostic envelope and the
cascade's control flow moved out of `classifyAddressingWithTypeSafe` and
`classifyAddressing` into `packages/agent-harness/src/jev/`: `client.ts`,
`cascade.ts` and `questions.ts`. Addressing now supplies state, questions, a
threshold and a mapping. The `structured_inference` log row and the archived
inference record moved to `apps/api/src/services/classifier-diagnostics.ts`.
Behavior is unchanged, including the `>` on the confidence comparison and the
`answers.addressing.confidence` path a schema rejection reports.

**Why:** the second JEV classifier was about to be written, and written the way
the first one was it would have copied roughly a hundred and thirty lines of
transport and forty of diagnostic field mapping.
[`jev-best-practices.md`](jev-best-practices.md#calibrate-confidence-as-an-operational-signal)
names the failure to expect from that — "`>=` in one service and `>` in
another" — and the same applies to whether a timeout is reported as an abort,
which decides whether a cascade spends its fallback.

**Considered and rejected:** *leaving the transport where it was and writing the
second classifier beside it*, which is cheaper today and pays for itself once the
two spellings of a threshold disagree in production. *Giving the request a
default timeout*, so a caller could omit one: a deadline is a number somebody has
to justify for the path it bounds, and a shared default silently applies one
decision's latency budget to another's.

**What a future change has to respect:** the primitives hold no product
decision. A confidence threshold, a state shape, a question and a mapping belong
to the classifier; the endpoint, the envelope and the cascade's transitions belong
to the primitives. The envelope is parsed in one pass around the caller's answers
schema so a rejected field's path stays rooted at `answers.`, which is what tells
an operator which side of the boundary failed; a regression test pins it.

### 2026-09-18 — Watching for events becomes a loadable skill, not policy

**What changed:** `polling-for-events` joined `BUILT_IN_SKILLS` with
`ownerPlugin: "rally:sidekicks"`. It sends a run to the connector's declared
event types first, falls back to an `interval` trigger no faster than every ten
minutes for what inspection rules out, keys a memory table on the item's own id
so a later run skips what an earlier one already reported, and steers off
`resource_watch`.

**Why:** People ask for event-driven behaviour — "tell me whenever a note is
added in Granola", "summarise my meetings when they're done" — and a model
answers it by inventing a poller: it picks a cadence from the person's urgency
rather than from what a watch costs, and writes a run with no memory, which then
reports the same items every tick. The first draft of this skill made the same
mistake one level up, opening on the premise that most connections have no event
to subscribe to. Review disproved it — Granola declares `note.generated`, Google
declares `email.received` and `calendar.event_completed`, and only X and
`custom_mcp` declare none — so the skill now leads with inspection and treats the
timer as the fallback it is. Putting any of this in the standing system prompt
was rejected: it is irrelevant to almost every turn, and the prompt is charged to
all of them. A skill is read only by the run that is actually drafting a
watcher.

**What a future change has to respect:** the ten-minute floor is a number the
team set on the 2026-09-17 design call, not a measurement and not a guess made
here — it is a floor rather than an interval, and the body says in as many words
that slower is fine and the person's own cadence wins. Do not turn it into a
fixed cadence, and do not lower it without the team. The `ownerPlugin` is what
keeps the skill out of an automation occurrence's catalog; a change that drops
it offers a run holding a frozen trigger context a procedure for drafting
Sidekicks it cannot draft. The body's claims about which connectors announce
what are checkable against the manifests, so a connector that gains or loses an
activity trigger is a reason to re-read the opening paragraph. This skill teaches the model to *ask* for a poller
through the Sidekick it drafts; the developer-written, high-water-line poller
that emits internal events (the Google connector's) is a different mechanism and
is not what this describes.

### 2026-09-18 — A wire prefix has to earn its characters

**What changed:** Six plugins dropped their model-facing wire prefix and now
advertise their canonical names unchanged: `rally:core` (`current_time`,
`request_elicitation`, `get_connector_connection_state`,
`show_connector_connection`), `rally:workstream` (`list_resources`,
`read_resource`, `schedule_wakeup`, `run_subagent` and the rest),
`avalon:agents` (`start_agent`, `send_message`, `reply_to_message`, …),
`rally:sidekick-result` (`post_result`), `rally:multimodal-generation`
(`generate_image`, `edit_image`, `generate_audio`), and `rally:terminal`, whose
own entry is in [`terminal-workspaces.md`](terminal-workspaces.md).
`CONNECTOR_CONNECTION_CARD_WIRE_NAME` and `CONNECTOR_CONNECTION_STATE_WIRE_NAME`
are now the canonical names themselves, with `LEGACY_`-named constants and
`isConnectorConnectionCardWireName` covering what stored rows still carry.
`rally:memory`, `rally:tables`, `rally:web`, `rally:sidekicks`, and every
connector plugin keep theirs.

**Why:** A prefix is a namespace, and a namespace is only worth its characters
where two plugins could collide or where the model has to tell one source of a
capability from another. Neither is true of an always-active plugin — the model
cannot load it, cannot unload it, and has no second `current_time` to
disambiguate. It is also not true where the canonical name is already the one
pretraining taught: `read_file` and `generate_image` are names a model has seen
tens of thousands of times, and `terminal_read_file` and
`multimodal_generation_generate_image` are not.
[`agent-tools.md`](agent-tools.md) now states both halves as the test, because
"always-active" alone was the rule for one afternoon and `rally:terminal`
immediately broke it.

**Considered and rejected:** Doing the same for `rally:memory` and
`rally:tables`. Their canonical names are plugin-local verbs — `search`,
`query`, `create`, `add`, `update` — and both own a `search`, so Bind's
duplicate always-active wire-name check throws before the run starts. Renaming
the canonical tools to `memory_search`/`table_query` to get around that was
rejected too: it hand-rolls the prefix the mechanism already renders and puts
the plugin name back in the canonical name the tree's rule keeps out of it.
Also rejected, and this one deliberately rather than for a reason: widening the
duplicate-wire-name check from core plugins to all of them. It was proposed and
declined in favour of the smaller change.

**Consequences:** Three things a future change has to respect. First, the
duplicate-wire-name guard covers less than its name suggests: it iterates Bind's
`corePlugins`, which the API fills from `createWorkstreamCorePlugins` —
`rally:core`, `rally:tables`, `rally:memory` only. `rally:workstream`,
`avalon:agents` and `rally:sidekick-result` are always active and still sit in
`plugins`, outside it, as do `rally:terminal` and
`rally:multimodal-generation`. Five of the six plugins unprefixed here therefore
hold a standing claim on their bare names with nothing at runtime defending it;
`apps/api/test/plugin-wire-names.test.ts` is the compensating control, and
widening the guard to all plugins is the change to make if that is not enough. Second, a durable tool event stores the wire name it
was called under, so `AVALON_TOOL_PROSE` carries both spellings of every
renamed tool and the card recognizer matches both; deleting a retired spelling
silently reverts every row written before this change to the humanized raw
symbol. Third, pagination's page-ID namespace and a plugin's wire prefix were
one field and are now two (`PaginationHost.prefix` and `wirePrefix`): page IDs
still read `workstream_brave_clever_…`, because that namespace is stored on
issued rows and validated on the way back in, while the descriptions around
them name `list_resources`. They are the same string for every connector and
differ only where a plugin advertises no prefix. Not handled, because it
self-corrects within a turn: a run resumed across the deploy has old names in
its transcript history, and a model that copies one instead of reading the tool
surface gets an unresolved-tool failure. Bind's provider alias fallback splits
on `::`, `__`, `.`, and `/` but never `_`, and teaching it to would make
`table_search` resolve to `search`.

### 2026-09-17 — Addressing history keeps both ends of long messages

**What changed:** JEV's state payload and the model-independent OpenRouter
classifier prompt now share one recent-message bound. Each retained message
keeps an even front-and-back window around an ellipsis when it exceeds 1,000
Unicode code points. The newest message remains complete.

**Why:** The opening identifies how a message begins and who it addresses, while
the conclusion often carries the actual request or hand-off. Keeping only the
opening could discard the evidence the classifier needs to decide whether Rally,
a person, or both should act.

**Considered and rejected:** Tail-only truncation, which merely reverses the
blind spot and loses the addressee or setup at the beginning. Raising or removing
the history bound would spend more classifier context without preserving a
predictable request size.

**Consequences:** The omission marker consumes one code point, so the 1,000-point
window retains 500 from the front and 499 from the back. Future changes to this
budget must preserve code-point-safe cutting and the shared JEV/OpenRouter
context boundary. Terra uses the OpenRouter renderer in direct evaluation; the
hosted cascade currently uses it for the pinned DeepSeek fallback.

Shipped in [#819](https://github.com/juno-ai-labs/avalon/pull/819).

### 2026-09-17 — Inference telemetry leaves model critical paths

The addressing classifier, streaming harness callbacks, and standalone
structured inference now hand exact request and response archive work to the
current Cloudflare invocation instead of awaiting R2 and Queue staging inside
provider callbacks. Structured operational logs, cascade status accounting, and
the harness's authoritative inference-attempt ledger remain synchronous, while
exact envelopes keep the same shared trace and inference-request identifiers. A
production trace showed request archival consuming about 1.8 seconds before JEV
was dispatched, making telemetry the dominant controlled cost ahead of a roughly
400-millisecond provider call. Starting the deadline earlier was rejected: it
would make archive latency consume the provider's budget while still delaying
the request. Dropping archive persistence was also rejected because the exact
provider exchange is the evidence used to evaluate and diagnose the classifier.
The classifier receives an explicit deferral port from its Durable Object; deep
shared inference services use the same runtime-backed primitive. This is
best-effort observational persistence, not durable retry: a deployment or
runtime reset can still end work that no durable hand-off accepted.

### 2026-09-17 — Use JEV first and a measured exact fallback for addressing

Message addressing now sends the optimized choice/state contract to JEV and
accepts only confidence above `0.5`. Everything else falls through to one
low-reasoning OpenRouter model; the selected DeepSeek V4 Flash 0731 route is
pinned to `wafer/fast`. Provider failure and schema diagnostics share the
structured-inference lakehouse contract, while a distinct addressing model
constant avoids changing the work-stream naming model. Keeping deterministic
fast paths ahead of JEV was rejected because it would make production differ
from the measured cascade, and OpenRouter model/provider fallback was rejected
because it would route traffic to combinations the evaluation did not measure.
Development without a TypeSafe key preserves the previous path; hosted regions
fail their environment contract when the primary credential is absent.
One terminal outcome row per cascade makes overall completion and primary
acceptance rates directly countable, while exact provider responses remain in
the inference lakehouse rather than indexed logs.
JEV's owned one-second deadline is derived from the measured 346 ms p95 and
keeps the fallback reachable; external cancellation does not start fallback.
The OpenRouter leg's 15-second bound is derived from its two measured p99 tails
and keeps the local floor reachable without cutting through observed requests.
If both remote stages fail, the existing deterministic classifier preserves
message admission and the terminal outcome names that floor explicitly.
Production replay content remains outside Git, and eval artifacts are bound by
corpus and report hashes while reporting both success and failure-inclusive
accuracy.
The addressing Flagship role and Worker model variable were removed in the same
change because an editable fallback would let production depart from the
evaluated cascade without review or fresh evidence.

### 2026-09-17 — Reuse execution admission for guest skill selection

Guest skill discovery uses the principal observation already required by the
host. Adding another membership query to every skill resolution would delay
ordinary assistant and tool attempts. Persisted-outcome recovery precedes that
admission and skill setup: retrying an already settled attempt must recover its
receipt without adding current-membership dependencies or starting new work.
Fresh execution retains its normal admission and boundary checks.

### 2026-09-15 — Share independent preparation promises

Startup repeatedly fetched the Sidekick response and serialized preparation
behind transcript and prompt loading. Separate promises now overlap independent
work and share each result with its consumers. Built-in metadata hashes survive
between runs in isolate memory, while live inventory and Sidekick response fields
refresh per execution. Caching whole plugin objects was rejected because their
handlers capture execution authority and mutable run state. Preparation never
replaces Bind admission or current permission checks.

### 2026-09-15 — Evaluate the production runtime at settled Bind boundaries

Prepared scenarios and checkpoint forks now run through the same Rally runtime
assembly as production. Bind's boundary/advance primitives capture settled state;
Rally stores the associated projection and activation hints. Forks rebase the Rally
loop identity so subsequent turn IDs cannot collide. A host restores executable
configuration and isolated resource/tool state. Reexporting checkpoint functions
alone left evals to reconstruct a different agent; a second loop was rejected.
Canonical bootstrap no longer rejects complete history by an unrelated message/byte
ceiling before Bind can apply its context preparation policy.
### 2026-09-14 — Independent background conversations keep Rally available

Tool definitions can flag long-running work without making that flag a dispatch
rule. Image generation and editing supply the initial hints. The common Bind
registration path carries the hint into loading results and provider-visible
descriptions, so plugins do not each invent delegation prompts. This supports
the uninterrupted-workstreams design while leaving execution, authorization,
and model judgment unchanged; a worker must not be forced to delegate again.

Background agents now use ordinary independent substreams, with team messaging
and separate ownership for stops. The obsolete inline child integration is
removed because it tied delegation to the parent's execution and imposed a
different read-only, non-recursive harness. Sidekick drafting is restricted to
its own authoring conversation; other agents contact it through messages.
Responsiveness must preserve Bind's ownership of every feed's loop and its
protocol, tool and completion protections; missing capabilities belong in Bind.
Agent-to-agent delivery is explicit through messaging tools; ordinary assistant
responses remain local, so background work needs no special completion tool.
Lease renewal continues during settlement of an already-started step after
archive. New model calls and tool calls retain their authority preflights.
Reauthorizing in the stream liveness callback had instead classified a durable
archive stop as a persistence failure before Bind could settle it.

### 2026-09-14 — Explain a slow first response before timing it out

Two Azure Sol calls hit the prior 45-second first-output watchdog. The user
selected a three-minute allowance and a temporary warning after 30 seconds;
those numbers are product decisions, not measured provider guarantees. The
warning follows each inference, never elapsed run time, and clears before
output/tool execution or settlement. Keepalives no longer restart the first-token
clock; doing so would let an empty stream avoid the stated deadline. Existing
establishment and inter-chunk limits remain independent. Bounded child and meeting
callers keep their prior first-output allowance rather than silently losing retries
to their shorter total budgets. Healthy output has no synthetic cap derived from idle
timeouts; the caller owns total duration. Ancillary status callbacks cannot hold
provider reads or cancellation hostage, including when a callback never settles.

### 2026-09-14 — The queue, not Bind, decides what an open question may be followed by

**What changed:** the hazard the 2026-09-12 entry below records as live — a
steer or queued message ahead of an elicitation answer in one FIFO, killing the
run with `run_state_persistence_failed` and blocking the answer behind it — is
fixed on Rally's side of the port. Bind's refusal is unchanged and stays
correct; `applyBindLoopTransition` still rejects `protocol_user_appended` while a
tool result is withheld, and `pendingBindToolBatch` is what the object now reads
to see which calls are open.

**Why:** the entry below found this by reading the code and proposed a new field
on the settled step saying whether the batch opened an answer-suspend. That
field would have been Rally's to add, and it is not the one that was needed:
it exists only at a safe step, and the rooms this actually wedged were idle,
parked on the question, activating from the queue. The projection already
carries the answer.

**Consequences:** no change to the Bind package or to the ports. The entry
below's "what a future change has to respect" paragraph stands as the record of
what was believed on 2026-09-12; the mechanism that replaced it, and why parking
alone was not enough, is in the 2026-09-14 entry in
[`workstream-durable-object.md`](workstream-durable-object.md), which owns the
queue.

### 2026-09-12 — Bind 15 carries the loop patch, and this repository stops patching

**What changed:** `@juno-ai/bind` moves from 14.0.0 to 15.0.0, whose new surface
is the three loop ports this repository had been patching in since it adopted
Bind: `ToolLoopTurn.acceptMessage`, `ToolLoopParams.beforeToolMessageAccepted`
and `ToolLoopParams.onStepSettled`, plus `StepSettlement`,
`DiscardedTurnWithToolCallsError` and `InputBlockedBySuspendError`. Names and
signatures are the patch's, so `bind-runtime.ts` is unchanged.
`patches/@juno-ai__bind@14.0.0.patch` is deleted along with the
`patchedDependencies` block in `pnpm-workspace.yaml` and in the lockfile;
`minimumReleaseAgeExclude` names 15.0.0. The lockfile is edited for the Bind
entries alone — five lines.

Three behaviours differ from the patch, all of them defects review found while
the code was being read as a package contract rather than as a diff:

- A `shouldStop` that fires while `onStepSettled` returns queued input no longer
  buys another model call. The patch's `continue` skipped the stop check that
  the sibling `onTurnWouldEnd` path performs, so a disabled agent kept spending
  for as long as input kept arriving.
- Input delivered while an `answer`-suspend is open is refused rather than
  appended, and reported as an `InputBlockedBySuspendError`. Appending it is
  what produces `assistant(tool_calls) → user → tool` once the answer is
  threaded back — a pairing every provider rejects. **For this repository that
  is defence in depth rather than a live path**: our own projection guard
  refuses the same message earlier and harder (below), so Bind's refusal is
  reached only if that guard is ever relaxed.
- A `requestCompaction` carried by the outcome that opened an `answer`-suspend
  survives, now that a same-step answer can clear the suspension and let the run
  continue.
- A fourth difference this repository cannot currently reach: the patch dropped
  the assistant message whenever `acceptMessage === false` and ran the batch
  anyway, while 15.0.0 refuses that discard for a tool-calling turn, keeps the
  message and reports a `DiscardedTurnWithToolCallsError` per requested call.
  `discardEmptyAssistant` requires `toolCalls.length === 0`, so Rally only ever
  asks for the allowed shape.

`onToolCallRejected` is now wired at the production `runHarness` call site,
logging `agent_tool_call_rejected` with the code and the workspace, work-stream,
substream and run ids. That port had never been supplied outside tests, so every
tool result Bind synthesized rather than threw was read by the model and by
nobody else.

**Why:** A patch is keyed by an exact version, so every Bind upgrade regenerates
it, and the 13.0.0 file had already drifted to inexact hunks that pnpm's applier
was tolerating. That is the visible cost. The larger one is that a patch gets no
review: three of the behaviours above were wrong in the file this repository has
been running, and two of them were found within an hour of the same code being
read as a package contract. Only the suspend refusal was reachable from here —
`shouldStop` and `requestCompaction` are never wired into `runToolLoop` by
`bind-runtime.ts`, so those two were latent in the patch rather than live in
production — which is the point rather than a mitigation: an unreviewed file
carries its defects until something makes someone read it. The ports are pure, identical for every host, and
expressible over injected values, which is where Bind's ownership fence puts
them.

**What a future change has to respect:** **Nothing but the answer may be
prepared for a step that left an elicitation open, and today the attempt kills
the run rather than corrupting it.** `settlePendingSteersAtStep` prepares
pending inputs whenever `stop_requested_at` is null, with no knowledge of
whether the batch just halted on `needs_input`. Both preparers —
`prepareDerivedBindAppends` for resident-context deliveries and
`preparePendingBindAppends` for participant steers — build a
`protocol_user_appended` transition, and `applyBindLoopTransition` refuses that
kind unless `lastAssistantStepIsSettled`, which an open `answer`-suspend makes
false by construction: its tool result is withheld, so an expected call id has
no accepted result. The transition throws `bind_loop_protocol_user_invalid`.

Where that leaves us is worth stating exactly, because two plausible readings
are both wrong. **The ledger is not corrupted**: both preparers run before
`storage.transactionSync`, so the throw precedes every write — no steer row is
committed, and no resident-context delivery is marked delivered, so neither is
silently lost. And **Bind's refusal is not the signal**: this guard fires first,
so `InputBlockedBySuspendError` does not appear in our logs for this. What
actually happens is that `requiredPort` converts the throw into
`run_state_persistence_failed`, a terminal user-facing error — and because
steers and elicitation answers share one `pending_loop_inputs` queue drained
oldest-first (`pendingSteersForCommit`, `ORDER BY input_sequence`), a steer
queued ahead of the answer blocks the answer too. Head-of-line blocking on that
work stream's input, not a bad transcript. All of this predates the upgrade; the
guards are unchanged by it.

The fix is smaller than the surface suggests, and it is not a Durable Object
redesign. The host already knows: `harnessResultOutcome` is where the
`answer`-suspend is constructed, from `result.halt === "needs_input"`, and
`settleStep` already enriches Bind's three-field step with `loopId`,
`executionId`, `assistantTurnId`, `modelTurnIndex`, `generation` and
`stateRevision` before handing it to `onStepSettled`. One more field — whether
this batch opened an answer-suspend — is what `settlePendingSteersAtStep` needs
to park both kinds of input instead of preparing them, and it is Rally's field
to add.

Two housekeeping rules, one carried forward and one retired. **The lockfile edit
stays surgical**: a `--lockfile-only` install re-resolves every `latest` catalog
entry (vitest 4→5, zod, eslint, and `@types/node` backwards by four majors on
the run that produced this change), so resolve into a scratch copy if you like,
but commit only the Bind lines. And **the 2026-09-11 entry's instruction to
regenerate `patches/@juno-ai__bind@<version>.patch` on the next upgrade is
spent**, superseded here: there is no patch, and recreating one would rebuild
the mechanism this change removed.

### 2026-09-11 — Bind 14: a nullable property reaches the model as a union

**What changed:** `@juno-ai/bind` moves from 13.0.0 to 14.0.0, whose one
behavioral change is in `sanitizeToolSchema`: a `type` array of exactly one
scalar type plus `"null"` is rewritten to `anyOf: [{type: T, …}, {type: "null"}]`
instead of collapsed to `type: T` with "Accepts T or null." appended to the
description. The type-bearing keywords move onto the typed branch, annotations
stay on the node, and the branch re-enters the walk so the retype-to-object,
pattern, enum and `required` transforms still apply to it. The five shapes
that keep the collapse, a multi-type union the common one, are listed once
under Principle 1 of [`agent-tools.md`](agent-tools.md). The loop patch this
repository carries (`acceptMessage`,
`beforeToolMessageAccepted`, `onStepSettled`) targets files that are
byte-identical between 13.0.0 and 14.0.0; it was regenerated rather than
renamed, since pnpm keys a patch by exact version and the old file's hunks were
inexact (below). The lockfile changes only the Bind entries.

**Why:** The collapse left a caller unable to say "none" in the half of a
declaration it treats as binding, and it had been measured twice: on a Drive
cursor, and then on `send_message.thread_ts`, where a scheduled Sidekick
invented values for thousands of refused calls or replied to its own previous
post. The `agent-tools.md` entry of the same date and `research.md` in
[the Sidekick delivery PRD](PRDs/2026-09-11_sidekick-delivery-reliability/research.md)
hold the record. Every consumer of Bind has the same defect, so the rewrite
belongs in Bind rather than in this repository's pre-sanitizer corrector, and
`droppedNullableBranches` becomes the guard that Bind keeps delivering it.

**What a future change has to respect:** `apps/api/test/tool-schema-sanitization.test.ts`
now asserts the dropped null branches over every declaration of every authored
tool, nested ones included, as an exact list: three multi-type unions with
`null` that Bind 14 still collapses (two Sheets cell values and the artifact
query's `params`) and nothing else, so a Bind upgrade that collapsed again
fails there naming the tool and the dotted path, and a new multi-type union
has to be added by name. A Bind upgrade regenerates `patches/@juno-ai__bind@<version>.patch`
from a `git diff` rather than renaming it. The 13.0.0 file's hunk line counts
were inexact: GNU `patch` needed fuzz to apply it to 13.0.0 itself, and pnpm's
applier had been tolerating that. The loop files did not change between 13.0.0
and 14.0.0, so a rename would have worked by accident; a regenerated diff
states exact hunks against the version it names, and is what the next upgrade
should produce too. And the lockfile is edited for the Bind entries alone; a
non-frozen install re-resolves every `latest` catalog entry and drags unrelated
majors along.

### 2026-09-11 — Trigger content carries a source label again

**What changed:** The three paths that lost all framing when the trust labels
came out get a plain source line: `INBOUND EMAIL:`, `SLACK CONTEXT:` and
`SIDEKICK TRIGGER:`. The external-event path already kept
`EVENT THAT STARTED THIS RUN:`, and a Sidekick result already carried its name
and delivery time.

**Why:** Removing the labels took provenance with it. A trigger email was
reaching the model as a bare user-role message with nothing saying it was an
email, which made it indistinguishable from something a person in the room had
typed. The label says where the text came from and claims nothing about trust.

**What a future change has to respect:** these are source labels, not trust
labels. A renderer that carries outside content needs one so a reader of the
transcript can tell what it is; it does not need, and should not grow back, an
instruction about how far to believe it.

### 2026-09-11 — Trigger content is no longer labelled untrusted

**What changed:** The five `renderUntrusted*` / `renderTriggerActivityMessage`
helpers are deleted from `prompts/workstream.ts`. Slack surrounding context, a
trigger email, an external event, a Sidekick result and a trigger activity are
projected as plain user-role messages. The prompt-authority invariant above is
rewritten: the layering by role survives, the trust labelling does not.

**Why:** Requested by the team and reaffirmed. A Sidekick is first-party code
under an authorized principal, and labelling its own output `UNTRUSTED` was
judged to be miscommunicating that.

**What a future change has to respect:** `prompts.test.ts` still asserts that an
injection string reaches a user-role message and never the system one, now
through the renderers that remain. A new renderer carrying outside content still
belongs in that test — the role rule is unchanged and is now the only rule.

### 2026-09-09 — A host port for context that lives in the prefix after a compaction

**What changed:** `RunHarnessInput.residentContext` carries two host operations.
`render()` returns sections `renderStableSystemPrompt` places last, read before
every model call. `prepareCompaction({ compactionEventId, generation, stateRevision })`
runs inside `compact()` before the summary turn; its `section` becomes the
compacted context's system message (bumping the system projection revision when
the bytes change) and its `excludedMessagePositions` are removed from the
summariser's input. `settlePendingSteersAtStep` accepts `derivedInputs` and a
synchronous `markDerivedInputsDeliveredInTransaction`, appended ahead of
participant steers and closed in the same commit; `commitBindCompaction` accepts
a synchronous `applyInTransaction` hook. The host is the substream agent, whose
ledger is in [`resident-context.md`](resident-context.md).

**Why:** The first resident content is a checkout's `AGENTS.md`. It has to
survive compaction, and the harness's own rule is that the prefix is stable
mid-run; a compaction is the one moment the prefix can change for free, so the
port is shaped around that moment. The harness learns one seam and no concept,
the same division the skill and plugin catalogs use.

**What a future change has to respect:** `prepareCompaction` must move no block
on the host side (it may record what it proposed) and the transitions it
proposes must be applied only inside the checkpoint commit, and only to the
blocks it proposed, or a crash or a concurrent load between the two leaves a
projection and a ledger that disagree. Positions are projected indices with the
system message at zero; a host must answer against the head the harness named
or refuse, and the harness refuses a position that is not a user message. The
compacted system message is always `renderSystemPrompt(section)`, never a copy
of the running system message, so the two branches cannot drift.

### 2026-09-09 — A seeded run is routed where its seam is

**What changed:** The harness exports `isAzureBoundModel`, and
`runWorkstreamHarness` routes a seeded run through `demoSeedModelRoute`: the
resolved primary model when it is not Azure-bound, otherwise the first unbound
fallback, otherwise `google/gemini-2.5-flash-lite`; no fallback models, and no
Azure transport in the run's config.

**Why:** The seam replaces the OpenRouter client's `fetch` and nothing else,
and production's default model, `x-ai/grok-4.3`, is Azure-first. A seeded run
in production would have gone to Azure — a live model answering in the seed's
place, and an `ask` turn failing its settlement — while every local and test
environment, routed to OpenRouter, passed. Found by tracing the production path
rather than by a failure. The seam was not widened to the Azure client because
the seed answers a request by name and cares nothing for the transport;
pinning the route is one function with no second seam to keep honest.

**What a future change has to respect:** A transport added to the router is a
transport the seam does not cover. Either the seeded route stays on the
OpenRouter client or the seam is handed to the new client too; a seeded run
that reaches a live provider is the failure the demo exists to avoid.

### 2026-09-08 — Readable Sidekick skill names

Skill names now use kebab-case Sidekick names, adding integer suffixes only for
collisions, so models can recognize knowledge without copying UUIDs. The host translates activation
refs at the harness boundary; storage keeps canonical IDs so attachments and
existing activation snapshots retain their meaning. Conversation-owned `sidekick_skill_names` reserves each name permanently for its
Sidekick, so removing an earlier duplicate cannot redirect an old tool argument.
Assignments retain the title at first discovery; a later rename updates the
catalog description, not the assigned name. Non-Latin letters and script marks
are retained. UUID-derived suffixes were rejected to keep the requested simple
integer duplicate names. Pure snapshot-equality assertions were removed because
they did not test the host's choice of snapshot.

### 2026-09-08 — Publication returns to the conversation for its final response

Remove the ready submission's terminal tool halt and ask the model to acknowledge
the save. Live Sidekick validation showed the earlier `completedByTool` adapter
handling did not satisfy the final-turn requirement in `terminalizeHarnessAttempt`:
publication succeeded but the run failed. The runtime invariant remains intact;
the authoring tool now follows the normal conversational completion path. The
real workerd authoring regression fails on the old halt and verifies both the
published definition and completed run with its persisted final reply.

### 2026-09-08 — Sidekick trust and activation

The host resolves Sidekick candidates once and persists their accepted instruction
snapshots with activation refs for retry. Model/tool boundary checks authorize
active sources only; a deleted unused catalog candidate cannot revoke unrelated
work. Loading a new source rechecks stored `loadable`, publication, lifecycle,
principal, workspace, and audience before activation is committed. Catalog
metadata is escaped onto one discovery line and is data, not an instruction.
Activated Sidekick content is user-authored guidance subordinate to platform
policy and the current request, and grants no tools or credentials.

This records the review fixes because stale effects, overbroad revocation, and
implicit compatibility assumptions can break otherwise valid delegated work.
Future changes must retain the separate ownership and execution boundaries.

### 2026-09-07 — A seeded run answers its own provider requests

**What changed:** `WorkstreamWorkflowInputSchema` gains an optional `seed`, and
`runWorkstreamHarness` sets `OpenRouterConfig.fetch` to
`demoSeedProviderFetch(seed)` when it is present, with a stand-in API key for an
environment that has none. The object skips the addressing classifier for a
message that carries a seed and starts a run exactly when the seed carries a
turn.

**Why:** The demo feature needs assistant turns that read as Rally's work
without a model having done it, and the only honest way to get one is to run
the ordinary path and replace the bytes at the provider boundary — the
injection point already existed for that. The classifier is skipped rather than
answered through a double because the pack, not a model, is the authority on
which of its lines address Rally. Owned by
[`demo-workspaces.md`](demo-workspaces.md), which records the alternatives.

**What a future change has to respect:** The seed replaces only the source of
model output. Anything that moves receipts, activities or settlement out of the
path a seeded run shares with every other run makes seeded history a fabrication.

### 2026-09-06 — Accept provider model capitalization in memory embeddings

**What changed:** Memory and text search share a case-insensitive comparison
against the canonical Qwen embedding model. Scoped-memory tests exercise both
provider spellings through document indexing and semantic retrieval.

**Why:** OpenRouter returns `Qwen/Qwen3-Embedding-8B` for the lowercase routing
slug. The exact comparison rejected valid vectors, leaving memory indexing to
retry and recall to fall back to FTS. Normalizing only case preserves rejection
of genuinely different models and keeps existing namespace identities intact;
changing the embedding model still requires rebuilding its projection.

### 2026-09-05 — A human turn that started no run still reaches the model

**What changed:** The conversation object appends every unprojected human or
external text turn to the persistent Bind projection at the next text
admission, ahead of the admitted input, using the same `protocol_user_appended`
transition and the same `participant_turn` provenance the pending-input drain
uses, rendered under a header that says it was said to the room and by whom.
The loop records `transcript_projected_through`, the highest transcript
sequence the projection has considered — advanced to what each admission's
scan covered, never to the admitted turn's own sequence — and the run reports
that mark, not the transcript's high-water mark, as what a compaction
checkpoint covers.

**Why:** A message the addressing classifier judged to be conversation between
people was written to the canonical transcript and nowhere else. It rendered for
every member, and the model never saw it: a later run bootstraps from the
projection, and the projection was only ever appended by an admission. Nobody
decided that; it fell out of the persistent-loop cutover. The demo-workspace
work made it visible — a scripted discussion between cast members that Rally
could not answer a question about — but it is a product defect in every room
with more than one person in it.

**Considered and rejected:** Appending at admission time, when the non-invoking
message is written — the loop may be executing, and the pending-input queue
exists precisely so nothing appends to a projection an attempt is mid-way
through. Making every such message an activation input of the next run — the
trigger is a pending input the object drains, so those would land *after* the
question they preceded. Re-reading the transcript on every activation — that is
the bootstrap path, and it exists once for a reason: the projection is the exact
hash-verified provider-boundary value, and rebuilding it from the transcript
would change what the model already saw.

**Consequences:** The model's conversation now interleaves side conversation
with the turns that address it, so a question about what two people said is
answerable. Existing rooms start with the mark at the transcript's high-water
mark (v45 backfills it), so nothing historical surfaces on upgrade; only turns
from then on are carried. A compaction checkpoint's `compactedThroughSequence`
is the projection's mark, which a later bootstrap may replay slightly more from
than before rather than lose turns the model never saw.

### 2026-09-04 — Child seeds enter Bind once as inert context

**What changed:** A fresh child Bind bootstrap reads its immutable initial
context and prepends a pure model projection of its ordered summary/history
parts. Historical authorship and attachment references remain visible, while
no tool protocol or executable action is reconstructed.

**Why:** The child feed and its inference must consume the same frozen seed.
Treating inherited turns as newly admitted inputs would rerun old instructions;
prepending after a projection or checkpoint would duplicate them.

**Considered and rejected:** Copying the source Bind transcript, which carries
live protocol and private state; and placing the summary in the system prompt,
which would promote historical data into platform authority.

**Consequences:** Only a missing canonical projection with no prior compaction
reads the seed. Later runs and recovered/compacted loops use their durable Bind
projection exactly as before.

### 2026-09-04 — A run a tool ended is completed, not an empty answer

**Superseded for conversational authoring on 2026-09-08:** the adapter behavior
below did not remove the terminalizer's final-turn requirement. Sidekick submission
now returns to the model for a closing response; completed conversation runs must
have that durable final turn.

**What changed:** `HarnessOutcome` gains `completedByTool`, set when a tool's
`halt: "completed"` ends the loop. The host's terminal result reads a
completed outcome with no final text as `completed` when that flag is set,
and as `failed` with `empty_completion` otherwise, as before. The run
storage's host-outcome checkpoint no longer refuses a completed outcome
with no final turn; it had, and the first cut of this change left every
tool-ended run un-terminalized under `host_outcome_content_mismatch`.

**Why:** A ready draft submitted from an automation's own conversation ends
the run from `submit_draft`, and the model is not asked for a closing
message. The host saw a completed outcome with no final turn and recorded
the run as failed with "the model returned no durable final response", so
every successful ready submission on the live stack was logged as a failed
run and the conversation showed a failure pill under a draft that had just
been accepted. The failure code is right for a model that stops talking
mid-task; it is wrong for a tool that says the task is done.

**Consequences:** A completed run may have no final turn. Anything that
counts failed runs no longer counts tool-ended ones; anything that renders a
completed run must tolerate the absence of a final message, which the
needs-input path already required.

### 2026-09-03 — Drafting is a conversation, and a run reads its automation by revision

**What changed:** The separate compiler host is gone with the first automation
object. The drafting tools are the loadable `rally:automations` plugin, in a
work stream and in an automation's own chat alike (deferred in a room and
preloaded in the automation's own chat, which is otherwise an ordinary
`SubstreamAgent` with the ordinary catalog),
and `automation_submit_draft` writes a definition revision to the automation.
A run's loop input carries `automationRun: {automationId, runId,
definitionRevision, trigger}` and nothing else about the automation, beside
`automationContinuation` when input continued the run
([continuing a run](automation-lifecycle.md#continuing-a-run)); the prompt
context, the bound plugins, and the tables description come from
`AutomationDO.readRunDefinition` at start, and `assertRunAuthorityStillValid`
reads `readRunState` before each provider write. The result reaches an owning
room through the run's own `automation_post_result` tool, in a plugin preloaded
only on such a run. Memory for a conversation under an automation is the
workspace store's `automation` scope; the retired scope union, the subscription
id, and the origin type are gone. The `automation_compiler` and
`automation_result_disposition` model roles no longer exist.

**Why:** [`automation-lifecycle.md`](automation-lifecycle.md) carries the
reasoning. For this document: a second host running the same harness had to
re-implement admission, receipts, elicitation, stop, retry, and a socket to
stream narration, all of which the persistent loop already had; putting the
drafting conversation on a `SubstreamAgent` deletes that host and leaves one
loop. Reading the definition by revision rather than freezing a copy in the
loop input is what lets a run's contract be four fields, and what stops every
definition field from becoming a stored-context migration. The memory scope
followed the parent kind because that is the one fact a run under an automation
reliably carries.

**Considered and rejected:** Preloading `rally:automations` in an automation's
own chat, so the drafting tools are visible on the first turn. The plan this
shipped from expected it; the code loads the plugin through the catalog in
both places, and this entry records the code. Picking it up means passing a
`preload` decision through `createAvalonAutomationsPlugin` keyed on
`parentKind`.

**Consequences:** Both arms of `# Result delivery` and the result plugin's system message now say one thing: the tool posts, nothing else does. A future prompt edit has to keep the populated arm naming `automation_post_result` and no other path. The compiler-only
`automation_*` attachment tools, narration frames, and the compiler's `tool`
stream event are gone; a row's plugin comes from `tool_invocations` only. The
retired memory rule about "a work stream an automation created" has no subject
left: a run is a substream under the automation, never a work stream.

### 2026-09-03 — A run delivers its own result, and no trigger narrows its tools

**What changed:** The `# Result delivery` section of the work-stream system
prompt has two arms: one names the owning room as the only destination Rally
posts to and tells the run not to post there itself, the other tells a run with
an empty `resultDelivery` that nothing sends for it and that any sending its
instructions ask for is its own work. The list's channel type is `workstream`
alone. `requestedDelivery` is gone from the submit-draft tool schema and its
normalizer, and the drafting tool's submission pre-check now applies the same
`automationDraftAcceptanceBlocker` the object does, phrasing both of its
refusals for the model. In `apps/api/src/services/integrations.ts` the three
`inbound_email` tool guards are gone, so a mail-started run holds write-mode
connector tools and the Firecrawl web tools like any other run.

**Why:** Delivery destinations chosen at creation and sent by a loop after the
run could not express what instructions can, and their existence let a run read
silence as "Rally has it covered"; the empty arm is what stops that. The
inbound-email guards named one trigger of several that carry untrusted content
and so described a boundary that did not exist. Both decisions and their
alternatives are recorded in [`automation-lifecycle.md`](automation-lifecycle.md)
and [`security.md`](security.md); this entry records that the harness body above
now describes them.

Two corrections landed on review before this merged. `outputSurface` gained a
fourth value, `self_delivery`, for an automation run no room owns: the
`external_delivery` section says the final message *is delivered* outside the
work stream, which for a run whose delivery section says nothing sends for it
would license leaving the result in the final message; the new section keeps
the outside-reader guidance and says the run's own sends are the only delivery.
And the automations plugin's system message and the submit-draft scope
description stopped promising that a personal automation "delivers to their own
inbox or DM": they now say Rally posts a result only to an owning room, and
that any other send must be written into the instructions as a step.

**What a future change has to respect:** the empty arm is load-bearing and must
stay accurate in both directions; a destination Rally sends to must appear in
the list and nothing else may. The submission pre-check must keep applying the
object's own predicate rather than a copy of it, or the two drift and a refusal
reaches the model as a bare code again. The authoring text and the run prompt
describe the same contract from two ends, so a change to where results go edits
both.

Shipped in #541.

### 2026-09-03 — Gemini 3.8 Flash defaults to low reasoning

**What changed:** `google/gemini-3.8-flash` joined `x-ai/grok-4.6` in the
canonical-model defaults registry with `reasoningEffort: "low"`. Every path
that resolves an omitted effort through the registry — routed Bind turns and
the direct structured and streaming OpenRouter clients — now sends
`reasoning: { effort: "low" }` for that model unless the caller sets an effort
explicitly. Gemini 3.8 Flash has no Azure binding, so the OpenRouter transport,
which declares every capability, is the only candidate the added
`reasoning_effort` requirement is checked against.

**Why:** The request was for Gemini 3.8 Flash to run at `low`, the same policy
Grok 4.6 already has. The reasoning behind that preference was not recorded
beyond the request itself.

**Considered and rejected:** Setting the effort per Flagship role, for the same
reason the Grok entry rejected it: the setting is a property of the model, and a
per-role value misses a Gemini fallback selected after another model failed.

**Consequences:** A caller that wants Gemini 3.8 Flash at a different effort
must ask for it explicitly, exactly as for Grok 4.6. Older Gemini Flash models
are not in the registry and continue to send no reasoning field.

Shipped in #541.

### 2026-09-03 — A rejection keeps the body it came in

**What changed:** `OpenRouterProviderError` gained a third field, `detail`: the
body the provider answered with, as text, beside the `code` and `providerName`
that classify it. `openRouterProviderError` now takes either the response text
or an already-decoded envelope, and returns a value whenever there is either a
classification or a body — so a refusal it cannot classify at all is no longer
discarded. Everything downstream already carried `providerError`, so
the archive and the three `agent_inference_attempt_failed` /
`structured_inference` log sites needed nothing but the new field: the logs gain
`provider_error_detail`, named for [the log-shape rule](runbook.md#log-shape)
that an opaque provider string is a `detail` and never a `message`. The durable
`inference_attempts` ledger deliberately stays as it was, holding the routing
decision and `failure_classification` and no provider text: it is a per-object
SQLite row on the execution path, and the two surfaces built for evidence
already have the body.

`providerErrorKind` is deleted. It recorded whether the body was JSON or text
and no code ever read it; `detail` answers the same question by being the body.

Two drops of the same bytes are fixed with it, both upstream of the new field.
Both streaming clients read the failed response twice — `await response.json()`,
and `await response.text()` in its `catch` — but `json()` consumes the stream
even when it throws, so the fallback raised `Body is unusable` and a non-JSON
refusal became an uncoded `TypeError`: no status, no `retry-after`, no
classification, and therefore a bare `harness_execution_failed` for a gateway's
HTML 502. And `readJsonResponse`, which serves the two non-streaming paths,
returned `null` for a body it could not parse and dropped the text with it. Both
now read once and keep the bytes beside the parse.

**That fix moves routing, not just legibility, and it is the part to review as
behavior.** `Body is unusable` is a `TypeError`, and `classifyProviderFailure`
maps a `TypeError` to `network` — Bind's blanket-retriable arm, with the status
thrown away. Carrying the status instead puts the same refusal on the status
branch: a non-JSON 429 now honours its `Retry-After` rather than Bind's own
backoff, a non-JSON 5xx stays retriable, and a non-JSON 400/401/403 becomes
request-shaped or credential and stops being retried across providers, which is
the intended reading of those codes and was previously unreachable for a body
that failed to parse. `index.test.ts` pins the 429 case against the shape the
double read used to produce.

**Why:** on 2 September a work stream pinned to `openai/gpt-5.6-sol` failed its
opening run. Azure answered 400 `invalid_function_parameters`, which says a tool
schema was refused and cannot say which of the twenty-eight in that request it
was. That code was all that four surfaces retained — the run row, the
`inference_attempts` ledger, the log, and the archived attempt record — because
the sentence naming the tool was read into `details` and dropped at the
transport. Pinning made it terminal rather than merely slow: `pinnedModelRouting`
carries no fallbacks and Sol's route is Azure-only, so one 400 exhausted the
plan, and a 400 is not a transport failure, so it surfaced as the catch-all.
Reconstructing the reason afterwards took log archaeology and live provider
probes, and still did not name the tool.

**Considered and rejected:** keeping only the provider's `message`. A gateway
sets it to `Provider returned error` and puts the upstream's real sentence in
`metadata.raw`, so a message-only capture reads as though nothing was learned;
the whole body covers that without a per-provider extractor and without a
schema to maintain as providers change theirs. Also rejected: extracting only
structural parts such as OpenAI's `param` (`tools[13].parameters`). The Grok
root-union rejection of 13 August carried no `param` at all and said everything
in prose, so a structural extractor would have kept nothing on the incident that
motivated the tool-schema guards. Also rejected: a length ceiling of this
field's own. Its two destinations already bound it and neither bound is this
change's to set — the archive stores the body whole, and a log row carries the
first 2,000 characters under the shared string bound in `redact` that every log
field is subject to. Adding a third number on top would be [a number nobody
here can justify](adding-security-defensive-and-other-limits.md).

**Every inference path, including embeddings.** `EmbeddingDiagnostic` had no
provider-error field at all, so a rejected embedding call recorded a
`failure_kind` and nothing about the refusal — the one inference path this change
would otherwise have left as it found it. It now carries `providerError` like the
streaming and structured paths, and `embedding_inference` logs the same three
fields the other two events do.

The cut lands with an irony worth stating: the rejection that motivated this is
a few hundred characters and survives whole, while the bodies long enough to
reach 2,000 are the ones quoting our request back — so the case the old
exclusion existed for is now cut mid-echo rather than excluded.

Shipped in #541.

### 2026-09-03 — The assembled memory-recall query is bounded before run setup uses it

**What changed:** `freezeRunMemoryContext` clamps its query to
`MEMORY_RECALL_QUERY_LIMIT` before recall, hashing or persistence. That constant
moved to `@rally/contracts`, the one dependency the memory service, the memory
tools and `AutomationAgent` all share, and every recall-query bound now reads it
instead of repeating the literal. `workstream_harness_threw` logs stack *frames*
rather than the first six lines of `stack`, and `table_search` declares the
`minLength`/`maxLength` its executor enforces.

**Why:** The recall query is assembled from run content — `memoryQueryParts`
joins the objective, the trigger context and the entire text of the triggering
message — and an automation run sends it to the automation memory tool's
`search`, whose `query` is capped. An automation triggered by a long email or
chat message therefore built an over-long query, and the `ZodError` escaped
inside run setup: before the frozen scope, before the first inference, before
any tool. The run failed on every attempt and stayed failed.

The logging change is why that took days to attribute. `stack` is the message
followed by the frames, and a `ZodError`'s message is multi-line JSON: twelve
lines of message and five frames for this error, so the first six lines were
message only — on the one log written to record *where* a run died, while
`reason` already carried *what*.

**What a future change has to respect:** the clamp belongs in
`freezeRunMemoryContext` rather than at the call site, because that is where the
automation and workspace recall paths converge and where the query reaches the
hash and the persisted text; clamping later would freeze a query the run did not
search with, and a replay would not match it. The truncation is not free on both
branches — the workspace branch embeds the query for a vector search, so a
prefix retrieves differently — and it is accepted because `memoryQueryParts`
appends the objective first and the triggering message last, so what is dropped
is the tail of a long message rather than the objective. Reordering those parts
would change what truncation costs.

Shipped in #541.

### 2026-09-02 — A deploy no longer kills the runs it interrupts

**What changed:** `persistScope` and `persistPluginActivation` reuse an existing
row for the run whatever the caller passes, instead of comparing the incoming
`scopeHash` / `toolSurfaceHash` against the stored one and answering `mismatch`.
The `mismatch` outcome is gone from `FencedWriteOutcome`, and with it the
`immutable_run_scope_mismatch` and `plugin_activation_mismatch` throws in
`harness-run-runtime.ts`. A run whose Durable Object is reset now simply
restarts its loop against the scope it was admitted with.

**Why:** Production, 2026-09-02. A work-stream run was mid-flight when the
deploy promoting `1543508` landed. Cloudflare resets a Durable Object when the
Worker's code is updated, which killed the in-flight provider request for model
turn 12 and then killed the first recovery attempt. Recovery itself worked: the
dangling assistant reservation was settled honestly as
`assistant_turn_interrupted`, and the loop re-entered twice. The third
resumption ran on the new bundle and died in `persistImmutableRunScope`, because
the scope hash mixes the deployed build — tool-surface hash, prompt version,
routing policy version, limits — into the authority it was meant to be about,
and `stableRunToolSurfaceHash` hashes every tool's `inputSchema` verbatim. The
deployed diff added `minLength: 1` to some Linear and X cursor properties. That
was the whole distance from a JSON-schema tweak to a terminal
`harness_execution_failed`, whose member copy reads *"Retrying is unlikely to
help"* when retrying was precisely what worked. The comparison was unsound
rather than merely unlucky: the stored hash is what the run was admitted with,
the incoming one is recomputed from whatever code the current attempt runs, and
those are only equal when no deploy intervened. The team already knew half of
this — the `WORKSTREAM_PROMPT_VERSION` entry below declines to bump a constant
for exactly this reason — but a version constant can be withheld and a
connector's `inputSchema` cannot.

**Considered and rejected:** Splitting the hash into an authority half that
stays frozen and a build half that is only recorded, which keeps a real check on
a resumed attempt widening its connection set — rejected as more machinery than
this earns right now; live per-tool-call reauthorization already refuses a
connection the workspace has since revoked, and the widening case was only ever
caught by killing the run. Keeping the freeze and re-admitting a fresh run on
mismatch — rejected because it still pays a full restart and a duplicate model
spend on every deploy. Minting a new attempt ID on restart — rejected because
tool receipts are keyed to `(run_id, attempt_epoch, tool_position)` and plugin
activations to the attempt, so a fresh identity re-runs external writes the dead
instance already made; the resumption path already restarts the loop without
that cost.

Raised in review and also rejected: *filtering* the freshly assembled tool
surface against the stored eligible connection and capability fields. It is
strictly better than the two rejected checks above — it restores the admitted
bound without reinstating any comparison, so a run still restarts rather than
dying — and it was declined anyway, deliberately. Rally is one product with one
authorization path, and that path is live: the principal, work-stream state,
connection identity, owner, grants and capability are rechecked before every
tool call. A second bound derived from a snapshot would be a parallel model to
keep correct, and the case it uniquely catches — a connection added between two
attempts of one run, in the seconds a Durable Object takes to restart — is
narrow enough not to earn one. Revisit this if resumed runs ever become
long-lived enough for workspace state to move underneath them routinely.

**Consequences:** Nothing re-checks that a resumed attempt's authority did not
widen between attempts, so a connection added mid-run can widen the resumed
surface. That bound now rests entirely on live revalidation before every tool
call, which is where the enforcement already was: the stored `run_scopes` row is
read in only two places, both on the inline-child path, and never to authorize a
tool. **This is the intended model rather than a gap awaiting a follow-up**: a
resumed run's authority is its current state, and live revalidation is what
bounds it. Anyone reading this as an oversight should change it deliberately,
not patch it.

**A third site of the same shape survives, one step downstream, and this change
is what makes it reachable.** The tool-receipt path compares a recomputed
per-plugin `toolSurfaceHash` against a stored one in `storedToolPolicyMatches`
(`integrations.ts`) and compares a recomputed `execution_plan_hash` against a
stored one in `admit` (`workstream-tool-receipt-storage.ts`); the plan hash folds
in that same surface hash, and receipt coordinates are deterministic, so a
resumed attempt re-issues the same coordinate and both comparisons go false
after a deploy. `compatiblePriorPlanHashes` covers only the legacy
canonical-name variant. The consequence is not a killed run on the root path but
a worse answer on a narrower one: a completed tool call is not replayed from its
durable receipt, cannot be rebound, and `admit` reports
`ambiguous_external_write` for a call that definitively completed — and on the
inline-child path `integrations.ts` throws `tool_receipt_execution_plan_mismatch`,
which is uncoded and becomes the same terminal `harness_execution_failed` this
entry set out to remove. So read this entry's title narrowly: a deploy no longer
kills an interrupted run *through the scope and activation writes*. Fixing the
receipt path was deliberately left out of this change because it moves what
counts as "the same plan" for replay, which is the machinery that keeps a
completed external write from being re-sent, and that deserves its own change
and its own tests. The rule below is what it needs: compare stored against
stored, or exclude the build fields.

The removed value comparison was also doing a second job by accident. Because a
stale executor carries a different attempt ID, it fell to `mismatch` and threw,
which fenced it; `persistPluginActivation` had no other ownership assertion at
all, since `persistRunPluginActivation` does not call
`assertHarnessAttemptOwned`. Reusing on the row alone would have handed a
zombie executor a false success and let it keep building context against a run
it no longer holds. Both writes therefore run `attemptOwnership` *before* the
reuse path, which keeps the deploy fix and still reports a lost lease. The child binding is untouched and still has teeth,
because `persistInlineChildScope` compares the child's `inherited_scope_hash`
against the parent's *stored* hash — two stored values, neither recomputed, so a
deploy cannot separate them. `run_scopes.scope_hash` and
`run_plugin_activations.tool_surface_hash` survive as a forensic record of the
build a run was admitted on; no migration was needed and none of the columns
moved. Anyone reinstating a comparison here must compare stored against stored,
or exclude the build fields, or it will fail every run that outlives a deploy.

### 2026-09-02 — A blanked optional argument is normalized to an omission

**What changed:** `normalizeToolArguments` gained a second rule beside
numeric-string normalization: on a tool whose `mode` is `read`, an optional
property of the top-level arguments object given `""` is removed when its
declared schema says the empty string is not one of its values. It takes the
tool's mode from the call site for that reason. It runs in
the same walk, under the same depth and visit budgets, and therefore before the
input hash, `beforeToolCall`, receipt planning, and execution. The three
functions in `tool-arguments.ts` are now exported from the package so the
composition of harness rule and connector schema can be tested against the real
tool registries.

**Why:** A production run could not file a Linear ticket because it sent
`after: ""` as a pagination cursor; Linear answered `Argument Validation Error`
with no field named, and the model retried unchanged until it gave up. Blanking
an optional parameter rather than omitting it is ordinary small-model behavior,
and the harness is the one place that can absorb it for every tool at once
instead of each connector rediscovering it.

**Considered and rejected:** Fixing it inside each connector executor, which
leaves the next connector to repeat it and still spends a round trip on an error
the model may not recover from. Also rejected: applying the rule to writes. A
blanked `assigneeId` dropped from `linear_update_issue` leaves the issue's
assignee untouched and reports the update as complete, while `null` there
clears it — two different requests the harness cannot choose between, so the
executor refuses the call by name instead. Also rejected: treating what the
walk cannot read as requiring nothing. A depth or visit bound, an unresolvable
`$ref`, a nested value whose requiredness an ancestor's branches split between
them, and the conditional requiredness keywords are each unproven rather than
unrequiring, and each keeps every blank. Also rejected: reading `required` from the node
that declares `properties`. A generated or hosted-MCP schema separates the two,
so that would have dropped a required blank from a tool whose arguments Rally
forwards without a local parse — the argument would have gone missing instead of
being refused. Also rejected: stripping every empty string,
which would silently discard values that mean something — a cleared description,
a repository root path — and is the silent drop `agent-tools.md` principle 1
forbids. Gating on what the schema itself declares is what keeps the two apart,
and it is deliberately narrow: `pattern` and `format` are not consulted, so a
field that must not be empty says so with `minLength`.

**Consequences:** The tolerance is opt-in per field through the declared schema,
so a tool that omits `minLength: 1` on a never-empty string still forwards the
blank. Receipt identity for a call with a blanked optional argument now matches
the same call without it, which is a change in `inputHash` for that shape.

### 2026-09-02 — Automation authoring and interrupted turns share durable truth

**What changed:** `core_request_elicitation` now declares `provider_key`
idempotency, matching the receipt-derived key its executor requires. A persisted
credential activation now records both the canonical `connection:<uuid>` and
the model-facing `plugin_*` identity consumed by ready-draft validation,
including preloaded and restored activation hints; a dropped activation removes
both identities again. Completed inspection, people/resource search, and
evaluator receipts rebuild the Automations plugin's otherwise in-memory state
after eviction in durable tool order. The authoring run ID is also the stable
automation ID, so recreating the plugin cannot fork a second automation. On
object takeover, a pending assistant reservation is settled visibly and the
Bind loop continues at the next model turn instead of terminalizing the
execution, while the configured model-turn ceiling continues counting across
takeovers.

**Why:** One production automation-authoring run exposed all three mismatches.
The elicitation definition withheld the key its executor required; loading and
inspecting Granola could never satisfy submission because the draft tools held
an unrelated empty loaded set; and the replacement `SubstreamAgent` reclaimed
the attempt only to close it as `assistant_turn_interrupted`. Each durable fact
already existed, but its next consumer used a disconnected representation.

**Considered and rejected:** Removing the ready-draft load requirement would
allow a definition to name a connector the model never activated. Weakening the
elicitation executor to invent an ID would lose replay convergence. Retrying an
accepted assistant/tool turn after eviction would risk repeating an external
effect; only an unaccepted reservation is retried.

**Consequences:** Elicitations converge on one durable question; ready drafts
recognize only live connector activations plus the inspection, research, and
evaluator facts the harness actually persisted; and an instance/socket reset
self-heals when the abandoned model turn has no accepted side effects. Repeated
takeovers cannot reset the run's model-turn budget. Existing ambiguous-tool
recovery and explicit cancellation remain fail-closed.

### 2026-09-02 — GPT-5.6 Sol is Azure-only

**What changed:** The provider registry now binds canonical
`openai/gpt-5.6-sol` to the `gpt-5.6-sol` Monad production deployment and gives
that model an explicit Azure-only policy. The binding admits Chat Completions,
streaming, tools, image input, reasoning effort, a 128k output limit, and OpenAI
subset cache accounting. Route tests prove a successful Azure request and prove
that a 503 never reaches OpenRouter.

**Why:** Sol is deployed with sufficient Azure capacity, while its OpenRouter
route is too expensive to use as an availability fallback. The policy must be a
hard provider fence, not merely the first entry in an ordered route.

**Considered and rejected:** Reusing the default Azure-then-OpenRouter policy,
or using Foundry's generated Responses sample as evidence that a new transport
was required. The live model details list both Chat completion and Responses,
so the existing adapter is supported; an ordered policy would violate the cost
constraint during exactly the outages that trigger traversal.

**Consequences:** Sol runs fail closed when Azure is unavailable, the Azure
credential is absent, required capabilities do not match, or the scheduled
price record cannot be trusted. PDF/file-parser and audio turns therefore fail
before provider I/O on a Sol-pinned work stream; the immutable pin requires a
new work stream to choose another model. Ace admits Sol only for roles whose
complete path is wired to Azure. Configured fallback *models* remain independent
stages, but Bind never invokes the Sol model itself through OpenRouter.

### 2026-09-02 — Model defaults and parallel tools are provider-boundary policy

**What changed:** The harness now has one canonical-model defaults registry,
used by routed Bind turns and by the direct OpenRouter structured and streaming
clients. An omitted call-level reasoning effort resolves through that registry;
`x-ai/grok-4.6` is the first entry and defaults to `low`. All other models still
omit reasoning unless a caller explicitly asks for it. Tool-bearing OpenRouter
and Azure Chat Completions bodies now send `parallel_tool_calls: true`.
OpenRouter requests now use `https://rallywith.ai` as their stable HTTP referer
instead of whichever regional API base URL constructed the client.

**Why:** Rally needs Grok 4.6 to run at `low` unless a task deliberately asks
for something else. Setting that independently in every model-using role would
drift as flags, fallbacks, and new inference entrypoints change. Parallel tool
execution was already a Bind behavior after tool calls were returned; the
request had to state that the model may return the batch in the first place.

**Considered and rejected:** Setting Grok's effort on each Flagship role. That
would make a property of the selected model part of eleven task configurations
and would miss a Grok fallback selected after another model failed. Applying the
default before routing was also rejected because a fallback may have a different
default; resolution happens against the candidate actually sent.

**Consequences:** A new app-wide model behavior belongs in the registry, while
role-specific requests continue to use explicit overrides. A model absent from
the registry must continue to serialize no reasoning field. Provider bindings
for a model with a reasoning default must declare the reasoning capability, so
Bind can reject an incompatible candidate before I/O. Parallel-tool policy is
only serialized when tools exist.

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

### 2026-09-01 — External settlement and automatic memory recall leave the path to inference

**What changed:** A terminal run releases the persistent loop after its
canonical terminal commit. Slack/digest/automation delivery and name/description
maintenance drain independently from `external_settled_at`, with an eager
`waitUntil` attempt and alarm recovery. The lane preserves terminal-run order;
its retry deadline is no longer an executable-loop deadline.

Opening and follow-up composer messages, elicitation answers, non-automation
inbound email, and Slack opening, follow-up, and elicitation messages no longer
call `freezeRunMemoryContext` before the first model request. Their immutable
run scope records a null memory-context hash. The `rally_memory` plugin and
explicit `memory_search` tool are unchanged. Non-message runs and automation
executions retain automatic frozen admission recall even when an automation's
trigger reason is also `inbound_email`.

**Why:** The previous drain awaited every external and cosmetic continuation
before it promoted the next queued message. A slow connector, classification,
name generation, or description refresh therefore became time-to-inference even
though the transcript and Bind state required by the next run were already
durable.

Production traces for three ordinary composer messages showed the fixed Qwen
query embedding taking 8.46–8.83 seconds before main inference, while the vector
leg failed, FTS recalled no items, and the run continued without any memory
context. A message already has its immediate context in the durable transcript,
so this speculative lookup should not delay every reply.

**Considered and rejected:** Dropping settlement or making it fire-and-forget
would lose delivery after eviction. Running later settlements around a failed
older one would make external destinations observe results out of order. The
existing durable receipt already provides both recovery and ordering, so a new
Queue or table would duplicate authority.

For recall: adding a timeout or a shorter guessed budget still keeps a provider
call on the message path and would introduce a defensive limit the team has not
chosen. Starting recall asynchronously cannot add a result to an inference
request that has already begun, and conditionally restarting the request would
make first-turn behavior nondeterministic. Removing the memory plugin entirely
would also remove deliberate, task-specific recall; this change removes only the
automatic admission lookup.

**Consequences:** External delivery can trail later in-app inference. Its lane
must remain idempotent and ordered, and every mutation of its due time must keep
the shared object alarm armed. Only canonical terminalization and loop fencing
may gate promotion of the next queued input.

A new human-message ingress must join the no-admission-recall set. If automatic
recall is reintroduced for messages, it needs evidence that its result value
outweighs its provider latency and a failure path that does not silently pay for
an unusable vector result.

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

### 2026-08-30 — A dedicated multimodal plugin generates durable images and replay-safe speech

**What changed:** Runs with main Azure inference credentials now advertise the
deferred `rally_multimodal_generation` plugin. Its initial two Bind tools call
Azure's `gpt-image-2` image endpoints and return an ephemeral image part to the
current turn. Generation publishes one durable generated resource under a
receipt-derived identity; editing publishes a new version of the selected image
resource under the same resource ID. Tool timeouts are fixed at five minutes.

The plugin also advertises a third Bind write, `generate_audio`. It calls the
main Azure `gpt-4o-mini-tts` deployment, MIME-verifies and bounds one MP3
response, and publishes it under the durable effect identity. Desktop
current-resource and version previews render native audio controls; the tool
result and plugin system message carry the AI-voice disclosure because the same
player also serves user-uploaded audio.

**Why:** The agent needs a native image capability that participates in Bind's
plugin discovery, receipt policy, and workstream resource ownership. Reusing a
chat-model route or Terminal would either misstate the provider API or make a
first-class product operation depend on a sandbox. Generated speech needs the
same plugin activation, receipt, timeout, regional storage and resource
ownership as generated images; keeping it in the same plugin avoids a parallel
lifecycle for one media subtype.

**Considered and rejected:** Preloading the plugin on every run; generation is
specialized and its instructions and tools need not consume every model turn.
Also rejected: failing closed on a missing cached price, because an
observability/cache failure should not deny the requested image; the no-price
case is logged and left uncharged. For speech: injecting generated audio into
the following model turn, since the output is for the person to play, not
evidence the model needs to reconsume; and a guessed charge when Azure returns
no usage and the shared OpenRouter cache has no endpoint price for this model.

**Consequences:** The plugin is absent without the main Azure credential pair,
and audio generation is available anywhere that pair already enables multimodal
generation. West remains future fallback infrastructure and is not selected
implicitly. The durable receipt stores JSON only; a later turn views the
attached resource instead of replaying provider bytes. An audio receipt and its
metadata must not persist the source text or instructions, and no billing entry
is created without provider usage and a valid shared price.

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
Cloudflare KV namespace shared by the configured deployments Workers. A dedicated Global
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
hashed into the recorded run scope, and at the time of this change bumping it
failed every in-flight run resuming across the deploy with
`immutable_run_scope_mismatch`. That hazard is gone as of *A deploy no longer
kills the runs it interrupts* above, which stopped comparing a recomputed scope
against the recorded one; the reasoning that follows stands on its own. The section
grants no capability and moves no authority — eligible capabilities and the tool
surface hash are unchanged — and its flag derives from environment and run input
already frozen for the run, so a resumed attempt's scope is the same scope. A
prompt change that did move authority would still need the bump.

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

### 2026-08-27 — Inference moves to the OpenRouter SDK with loop-wide traces, and durable-memory embeddings follow

**What changed:** Rally's provider boundary now uses the official OpenRouter SDK
schemas instead of a direct OpenAI SDK type dependency. Every structured and
streaming request enables router metadata and sends `user`, a stable
`session_id`, and a Broadcast `trace` envelope. A harness loop keeps one
`trace_id` across all of its turns, and each model turn is a separate named span
containing its OpenRouter generation; inference and route fields distinguish
retries. `feature` carries the model category's exact Flagship key while
`source` retains the execution surface. Provider `user` and trace `user_id` both
use the workspace ID; a relevant person remains separate as `context_user_id`.
`intended_model` retains the primary model selected before route traversal while
`model` records each attempted candidate, making fallback requests directly
queryable. Successful streaming attempts retain returned router metadata.

Locally invalid SDK requests are terminal before transport: Rally does not retry
them on the same model or send them to a fallback. Structured retries, repairs,
and fallback models retain one trace ID while their provider request IDs remain
distinct. Provider-controlled error prose is discarded before any operational or
lakehouse record is built.

Memory query and document embeddings now use OpenRouter's native embeddings
endpoint through the shared inference gateway, with `qwen/qwen3-embedding-8b` as
a fixed route with no model fallbacks and explicit 1,024 dimensions.
Query/document input types remain distinct. Vector namespaces are derived from
the fixed requested model and dimension contract, provider model drift fails
closed, and WorkspaceDO migration 23 requeues every current active memory while
keeping old Qwen vectors unreachable during the rebuild.

**Why:** The local inference lakehouse proves what Rally sent and received, but
provider-side diagnosis previously had no complete way to join a routed request
back to its workspace, conversation, relevant person, run, deployment, or exact
loop turn. Changing trace IDs per turn would also fragment one agent execution
into unrelated traces.

Memory embeddings were the remaining language-model inference path calling
Workers AI directly, outside the shared provider and observability boundary.
Reusing the existing 1,024-dimensional indexes avoids a destructive Vectorize
replacement, but equal vector length is not semantic compatibility, so the old
and new spaces need a hard query boundary.

**Considered and rejected:** Using one trace per model turn, overloading
`session_id` with a host request ID, deriving product identity from synthetic
harness plumbing, and treating OpenRouter Broadcast as a replacement for the
Global-only Rally lakehouse. Those respectively lose loop topology, break
conversation grouping, mislabel one-shot surfaces such as meeting notes, or
weaken Rally's exact regional evidence.

For embeddings: mixing the previous Workers AI Qwen3 0.6B and new OpenRouter
Qwen3 8B vectors because both are 1,024-dimensional, replacing both regional
Vectorize indexes, and using a metadata filter that would require provisioning
another metadata index. A versioned namespace is supported without extra index
configuration and makes a partial rebuild fail toward FTS rather than false
semantic matches.

**Consequences:** New inference surfaces must provide an explicit trace context
when the generic harness IDs are not product IDs. Work-stream sessions remain
`<workstream_id>-<substream_id>`, trace IDs remain stable for a loop, workspace
IDs are the provider/PostHog identity, and OpenRouter account owners must
configure Broadcast destinations and privacy policy separately.

The static `memory_embedding` feature label identifies the embedding category in
diagnostics, but no Flagship rule or Ace edit can change its model; changing the
fixed model requires a code change paired with an active-memory requeue. The
current OpenRouter embeddings request schema does not accept Broadcast's custom
`trace` object. It receives workspace `user` plus `X-Session-ID`; Rally keeps
feature, trace, intended/requested/resolved model, fallback, and latency as
content-free regional diagnostics. Query embeddings use the active substream in
that session; document projection uses the owning work stream's canonical main
substream.

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

### 2026-08-24 — Provider calls expose lossless envelopes to a regional lakehouse keyed by substream, and the opt-in D1/R2 ledger is retired

**What changed:** Every streaming attempt now identifies the provider invocation
model and carries its complete normalized response. Every structured provider
fetch gets a stable inference request ID and exposes its exact request,
successful JSON response envelope, bounded failure classification, typed usage,
latency, response bytes, repair position, and terminal validation result to the
host capture hook.

Lakehouse request and attempt records carry the canonical product
`substream_id`. The main feed defaults to `"0"`, and root and inline child
inference both inherit the workflow input's substream; inline child lineage
remains represented by `request_id` and `parent_request_id`.

Migration 0094 drops `agent_inference_payload_logs` and the
`workspaces.log_agent_inference` preference. The API contract, stored desktop
session field, Workspace Settings toggle, and request-only `agent-inference/`
writer were removed. Hosted capture now has one path: the regional inference
lakehouse. Historical R2 objects are retained rather than deleted implicitly.

**Why:** The existing inference ledger described routing and cost, while its
opt-in payload object stopped at the request body. A regional lakehouse cannot
answer why a model behaved differently across providers or repairs without the
matching output/error envelope and one ID joining the request to the attempt.

A work-stream-only analytical key cannot distinguish model calls once multiple
product substreams exist inside one work stream, while using inline children as
synthetic substreams would confuse execution lineage with product conversation
identity.

Keeping a second request-only index duplicated sensitive inference content, made
absence ambiguous because the workspace flag defaulted off, and left operators
choosing between two incomplete diagnostic surfaces after the lossless lakehouse
became authoritative for inference analysis.

**Considered and rejected:** Reconstructing responses from transcript messages.
That loses provider IDs, raw usage and finish metadata, structured validation
failures, rejected provider envelopes, and calls whose output never committed to
the transcript.

Leaving `substream_id` implicit until the product creates a second substream.
The Pipeline stream schema is immutable, so waiting would force a resource
replacement precisely when the identifier first became necessary.

Keeping the D1 row as a fast work-stream lookup. That preserves a second schema
and lifecycle solely for convenience; the lakehouse already indexes
`workstream_id`, `substream_id`, `request_id`, and `inference_request_id`
without putting analytical state back into D1.

**Consequences:** The host hook now handles highly sensitive data and must keep
it on the regional path described in `inference-lakehouse.md`. Ordinary Workers
Logs and object-local operational ledgers remain redacted; only the explicit
lossless store receives the full envelopes. Current main-feed evidence is
explicitly identified as substream `"0"`; future workflow substreams flow into
the lakehouse without changing child-run semantics or adding a D1 lookup path.
D1 no longer stores analytical inference metadata and the general payload bucket
receives no new `agent-inference/` objects. The owning `SubstreamAgent` or
`BlockDashboardAgent` still stores its operational `inference_attempts` rows
because those belong to execution recovery, not analytics.

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

### 2026-08-18 — Each HyperSight block gets a durable Bind-loop owner fed a reproducible model-array interval

**What changed:** Stable block IDs now resolve to `BlockDashboardAgent`
instances. WorkstreamDO durably fans out configured runs, each block agent uses
main `SubstreamAgent("0")` as its fenced source/runtime ledger, and result
versions settle back into WorkstreamDO. Both agent classes share Rally's custom
keep-alive and drain primitives; Bind remains the loop implementation. Every
block dispatch binds the exact eligible compaction checkpoint hash and a
tool-safe upper sequence selected by main `SubstreamAgent("0")`; the block
passes that checkpoint fence into the ordinary Bind run assembly rather than
resolving “latest” at execution time.

**Why:** HyperSight loops can be long and must recover independently, but a
derived block is not a conversation substream and should not acquire a second
message feed or serialize another block's execution. HyperSight may also begin
after another turn or compaction, and a message-ID waterline alone neither fixes
the lossy prefix nor proves a provider-valid tool boundary.

**Considered and rejected:** WorkstreamDO-owned inference, source-agent-owned
fan-out, one agent for every block in the work stream, Workflows, and adopting
the Agents SDK for the loop. They place compute in the control plane, duplicate
configuration ownership, couple unrelated blocks, or add orchestration and
harness abstractions without improving the existing Bind semantics. For the
block's input: copying the full array into WorkstreamDO and allowing the block
to read the current transcript. One duplicates high-volume data in the control
plane; the other changes inputs after dispatch.

**Consequences:** The block agent owns execution/retry while source transcript
and tool/run records remain transactionally beside the work-stream data they
reference. Exact tool calls/results after compaction are retained,
pre-compaction tools are represented only by the summary, and a stale fence
fails before model inference. Tests must prove fenced reads, dispatch/result
idempotency, and eviction recovery.

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

### 2026-08-12 — Deferred plugins may load a live tool surface at activation, and it stays visible to host-side narrowing

**What changed:** `HarnessPlugin.loadTools` lets an authorized deferred plugin
replace its empty tool array during `load_plugin`. The Bind registry receives
the loaded tools only after reauthorization, loads them once per run, and uses
the same persistence, policy, execution, and receipt path as static tools. After
a deferred plugin loads, the API also replaces the host-owned placeholder tool
array as well as returning the tools to Bind. Restored and explicitly preloaded
dynamic plugins load before their activation receipt is persisted, so that
receipt always carries the discovered surface hash.

**Why:** Hosted MCP servers own tool catalogs that can change independently of
Rally and can vary by account. Resolving every eligible connection at run start
would waste provider calls on plugins the model never uses; resolving after
activation would expose an activation that had no callable surface.

Bind correctly exposed the activated surface to the parent model, but
inline-child construction reads the API's frozen plugin objects rather than
Bind's private registry. Leaving that object empty made an already-active
dynamic plugin inherit no read tools. The same empty placeholder had no surface
hash when a prior activation hint was persisted before Bind could call
`loadTools`, causing the next run to fail during setup.

**Considered and rejected:** Treating dynamic MCP tools as a second registry
outside Bind. That would duplicate name resolution, tool policy, serialization,
and receipts exactly where consistency matters. Eager loading was rejected for
the provider-call and refresh cost above. Also rejected: re-discovering from the
provider during child construction, which could produce a different surface from
the one the parent activated and would spend another provider call while
freezing child authority.

**Consequences:** A dynamic plugin catalog entry can be available even though it
has no tools yet. Any caller that inherits capabilities before activation must
fall back to the frozen dynamic grant, while static plugins continue deriving
their exact capabilities from visible tools. Dynamic metadata remains remote
input and never replaces the plugin's trusted display or system guidance. Any
dynamic adapter that returns Rally-classified read tools can pass that exact
activated subset to a child. Hosted MCP currently classifies all
provider-authored tools as writes, so its tools remain excluded by the child's
independent read-only policy. A dynamic provider failure while restoring a hint
drops that hint and leaves the plugin available for an explicit later load; it
does not abort unrelated work.

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
job migrates configured deployments before it deploys either Worker, so the Worker still
live during a migration is the *previous* one — and it calls `loadArtifacts` on
every `GET /workstreams/:id/context`. Dropping the table alongside this code
removal would fail every context request in configured deployments for the length of the
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
token cap, and the deployed `OPENROUTER_AUTOMATION_MODEL` in configured deployments is a
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
