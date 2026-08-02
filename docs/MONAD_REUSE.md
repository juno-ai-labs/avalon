# Reusing Monad's agent harness and runtime in Avalon

An assessment of what Avalon's `packages/agent-harness` and API runtime can take
from the Monad repository (`juno-ai-labs/monad`), written against Avalon `447c68b`
and Monad `b1fe057a`.

Monad splits its agent stack in two:

- **`packages/bind`** — the extractable harness, published to npm as
  **`@juno-ai/bind`** (MIT, currently `2.0.0`). Today it carries the LLM
  provider-routing core and the turn-vocabulary contracts. It is fenced by
  ESLint to have no `@/*` imports, no Node builtins, no `process`, no framework
  imports, and peer-deps only (`zod`, plus type-only `openai`). Its build
  compiles with no Node/DOM lib types as a deliberate edge-runtime portability
  gate. See [`docs/bind.md`](https://github.com/juno-ai-labs/monad/blob/main/docs/bind.md).
- **`server/agents/`** — the agent runtime (~15.7k lines), which has no
  codename and is not extracted. Most of it is coupled to Monad's Postgres,
  authz, and edition layers, but several modules are dependency-free by
  construction.

Avalon's harness is a single 1,130-line `packages/agent-harness/src/index.ts`
running on Cloudflare `workerd`. That runtime choice matters: `bind`'s portability
fences were written for exactly this target, so the highest-value pieces are
consumable as a dependency rather than a fork.

The two codebases converged independently on the same design in several places,
which is the strongest argument for sharing: Avalon's `HarnessRunStats` and
`bind`'s `RunStats` are near-identical without any contact between them.

---

## Tier 1 — adopt as a dependency now

### 1.1 `@juno-ai/bind/contracts` replaces `HarnessRunStats` outright

Avalon's `HarnessRunStats` (`packages/agent-harness/src/index.ts:671-684`) and
`bind`'s `RunStats` (`packages/bind/src/contracts/turn.ts`) independently arrived
at the same eight fields with the same names and the same semantics:

| Field | Avalon | bind |
|---|---|---|
| `turns` | ✓ | ✓ |
| `toolCalls` | ✓ | ✓ |
| `inputTokens` / `outputTokens` | ✓ | ✓ |
| `modelTimeMs` / `toolTimeMs` | ✓ | ✓ |
| `outputTokensPerSecond` | ✓ | ✓ |
| `toolTimeBreakdownMs` | ✓ | ✓ |
| `costCents` | — | ✓ |

Both even carry the same rationale — isolating model time from tool time because
task wall-clock conflates provider inference speed with tool execution, and both
match the StirrupJS `speedStats` shape so numbers stay comparable with published
benchmark methodology.

`bind` is a strict superset (`costCents`) and ships the fold functions Avalon
hand-rolls: `emptyRunStats`, `accumulateTurn`, `accumulateToolCall` replace
`emptyHarnessRunStats`, `snapshotHarnessRunStats`, `accumulateHarnessUsage`, and
`accumulateToolTiming` (`index.ts:1005-1053`).

Also available and worth taking: `TurnFn`, `ModelTurnResult`, `TurnUsage`,
`TurnTimings`, `StopReason`. `StopReason` (`done | suspended | iteration_limit |
deadline | aborted`) is a cleaner decomposition than Avalon's
`HarnessOutcome.status` (`completed | needs_input | failed | stopped`), which
currently folds "hit `maxIterations`" and "a tool threw" into the same `failed`
plus a `HarnessFailure.code` discriminator.

**Cost:** low. `pnpm add @juno-ai/bind`, then a mechanical rename. `zod` is
already in Avalon's catalog; the `openai` peer is optional and type-only, so
Avalon's hand-rolled `ModelMessage`/`ModelToolCall` types can stay.

**Caveat:** `TranscriptMessage` and friends are typed as OpenAI SDK types.
Avalon deliberately does not depend on the `openai` package. Take `RunStats` and
`StopReason` (no `openai` reference) and leave the wire-vocabulary aliases.

### 1.2 `@juno-ai/bind/routing` replaces the hand-rolled fallback loop

Avalon's routing is `openRouterFailureDisposition` (`index.ts:304-319`) plus a
nested `for (model) for (attempt)` loop duplicated across `structured()`
(`index.ts:103-156`) and `stream()` (`index.ts:158-191`). `bind/routing` is the
same problem solved considerably further:

| Concern | Avalon today | `bind/routing` |
|---|---|---|
| Failure classification | 3 dispositions (`retry`/`fallback`/`terminal`); unknown errors default to `fallback` | `InferenceAttemptError` taxonomy (`aborted`, `completion_defect`, `network`, `http` + 7 HTTP categories) with a **total** `FailureDisposition` flags record — `sameEndpointRetry`, `nextProvider`, `fallbackModel`, `breaker`, `propagate` |
| Circuit breaking | **none** — a dead provider is retried on every run | Per-`(provider, model, credential source, credential scope)` breaker with half-open probes, injectable clock, and `releaseProbe` so a probe can't stick |
| Fallback axis | model list only | model stage → provider candidate → same-endpoint retry, with fallback-kind attribution |
| Provider pinning | none | `ProviderPolicy` with an `ordered` list and a hard `only` fence |
| Plan | implicit in loop order | explicit, deterministic, frozen `RoutePlan` — snapshot-able in tests and eval artifacts |

Two specific gaps worth calling out, both of which `bind` treats as first-class:

**A malformed prompt should not open the circuit.** `bind` classifies
request-shaped rejections (a 400, a moderation refusal) as `REQUEST_SHAPED`:
traverse to another provider, but `breaker: "none"` — because the *endpoint* is
healthy. Without that distinction, one user's flagged prompt degrades the shared
endpoint for everyone. Avalon has no breaker today, so this is latent rather than
live, but it is the trap to avoid when adding one.

**Credential failures are per-tenant.** `bind`'s breaker key includes an optional
non-secret `credentialScope`, so one tenant's revoked BYOK key never opens the
circuit for others. Avalon is heading toward per-workspace connector credentials;
this is the shape to adopt before it becomes a cross-workspace outage.

**Cost:** medium. `bind`'s planner is built around `PlannerTransport`
(availability + endpoint resolution) and canonical `vendor/slug` model ids.
Avalon is OpenRouter-only, so it would implement a single `PlannerTransport` whose
`resolveCandidate` returns the OpenRouter endpoint for every known model. That is
a genuine adapter, not a drop-in — but request construction and wire-error
classification deliberately stay host-side, which is exactly where Avalon's
existing `streamModel`/`headers` code already lives.

**Recommendation:** adopt `failureDisposition` + `categorizeHttpStatus` +
`createCircuitBreaker` first (they are useful standalone and need no plan), and
defer `buildRoutePlan`/`executeRoutePlan` until Avalon actually wants
multi-provider routing for one model.

---

## Tier 2 — port the file (zero or near-zero dependencies)

These live in `server/agents/` rather than `bind`, but have no meaningful import
graph, so copying is safe and cheap. All are shared/CE code in Monad.

### 2.1 `tools/sanitize-tool-schema.ts` — the highest value-to-cost item here

683 lines, **zero imports**. It rewrites every tool JSON Schema before it reaches
the provider, applying only correctness-preserving transforms, each bisected
against live inference.

**This addresses a latent bug in Avalon with a confirmed shape.** Avalon's
default primary/classifier/structured model is `google/gemini-2.5-flash-lite`
(README; `OPENROUTER_PRIMARY_MODEL`), tool `inputSchema` is an unvalidated
passthrough (`packages/contracts/src/index.ts:574` —
`z.record(z.string(), z.unknown())`), and the connector schemas are hand-written
JSON Schema containing precisely the constructs Monad's sanitizer exists for:

- **22 type-array occurrences** across connector tool schemas, e.g.
  `startCursor: { type: ["string", "null"] }` in `notion.query_data_source`
  (`packages/connectors/src/notion.ts:96-110`). Gemini's function-declaration
  schema is a strict OpenAPI 3.0 subset requiring a **scalar** `type`. Monad's
  production incident: Gemini drops the enclosing `properties` object, the
  otherwise-valid `required` then dangles, and the request 400s with
  `properties[...].required[0]: property is not defined`.
- **45 `additionalProperties: false` occurrences**. xAI/Grok via OpenRouter
  rejects the boolean form on a nested object schema with a hard 400,
  `"property schema 'false' is not supported"`.
- Monad also found Grok mis-reads a tool parameter *literally named*
  `properties` as the JSON-Schema keyword — the exact construct in Notion's API.

The critical amplifier: **strict validators reject the entire request — every
tool — on the first violation.** One bad schema breaks the whole toolset, not
just the offending tool. Monad hit this in production on a Grok-default agent
with Notion tools connected.

I have not run Avalon against live Gemini, so I am reporting a matching construct
signature, not an observed failure. Monad ships a gated live-inference regression
suite for exactly this
(`server/agents/tools/__tests__/tool-schema-model-compat.test.ts`, gated on
`RUN_OPENROUTER_EVALS=1`) — porting that harness alongside the sanitizer is how
to convert this from "probable" to "known".

**Related, separate concern:** Avalon hand-maintains JSON Schema next to Zod
schemas that describe the same thing — `automationJsonSchema` (`index.ts:435-508`,
~70 lines) duplicates `AutomationDraftSchema`, and `normalizeAutomationDraft`
(`index.ts:544-601`) exists to reconcile the two. That is a standing drift hazard.
Monad generates JSON Schema from the Zod `parameters` and sanitizes the result.

### 2.2 `run-harness.ts` — deadline, failure classification, coalesced heartbeat

198 lines, **zero imports**. Exports `createRunDeadline`, `RunTimeoutError`,
`classifyRunFailure`, `createCoalescedHeartbeat`.

Avalon hand-rolls the deadline inline in `runHarness` (`index.ts:693-703`), plus
an `abortSource` variable and a `markExternalAbort` listener (`index.ts:694-698`,
`739-742`) whose entire job is distinguishing "the deadline fired" from "the user
cancelled". That is precisely `RunDeadline.timedOut` + `classifyRunFailure`,
including the subtlety Avalon gets right and would keep: a combined external
abort must **not** read as a timeout.

`RunDeadline.withExternal()` also replaces `combineSignals` (`index.ts:1097-1102`).

`createCoalescedHeartbeat` has no Avalon equivalent and is directly applicable:
collapsing a burst of progress writes to one flush per window is the right shape
for bumping a harness-run row or a Durable Object from inside a hot loop.

Monad's ownership rule is worth copying verbatim: whoever needs to *classify* the
outcome must **create and own** the deadline and dispose it in a `finally`; a loop
handed a deadline must not dispose it, and a loop given none mints its own so a
turn is **never** unbounded. That rule is the fix for a real Monad outage.

### 2.3 Smaller dependency-free utilities

- `tools/parse-tool-name.ts` — zero imports. Namespaced `plugin__tool` parsing.
  Relevant if Avalon's flat `notion.search` namespace ever grows tiers.
- `content-parts.ts` — `openai` types only. Multimodal content-part assembly.
- `skills/skill-md.ts` — `js-yaml` only. SKILL.md frontmatter parsing, if Avalon
  ever wants a skill system.
- `agent-tool-loop.ts` / `agent-tool-call.ts` — need only a logger port and
  `openai` types. Monad's iteration engine, if Avalon outgrows its single loop.

---

## Tier 3 — adopt the design, not the code

### 3.1 The streaming idle watchdog (the most important item in this document)

**Avalon has no inter-chunk timeout.** The stream read loop
(`index.ts:273-281`) is an unguarded `while (true) { await reader.read() }`. The
`fetch` carries only `input.signal`; there is no per-request timeout. A provider
that opens the stream and then stalls mid-generation is bounded **only** by
`HARNESS_MAX_WALL_CLOCK_MS`, which defaults to **240,000 ms**
(`apps/api/src/services/integrations.ts:245`).

This is the single failure Monad's `docs/agent-run-harness.md` is largely about.
Their root-cause note is blunt: the OpenAI SDK `timeout` bounds *establishing* a
request, not the gap between streamed chunks, and this was the cause of their
"thinking… forever" stalls.

Avalon's exposure is worse than the raw 4 minutes suggests, because of an
interaction with its own (correct) no-replay rule. `stream()` sets `emitted = true`
on the first text or tool-call byte, and `index.ts:179` then rethrows without
falling back — right, since replaying could duplicate visible output or provider
writes. So a mid-stream stall burns the **full 4-minute deadline** and then fails
the run **with no fallback available**. Monad's watchdog converts the same event
into a retriable `network` error in ~5 seconds.

Monad's design, worth copying wholesale — the two-phase split and the gating rule
are both hard-won:

| Budget | Value | Arms on |
|---|---|---|
| Time-to-first-token | 120 s | Stream open → first **answer** token |
| Inter-chunk | 5 s | Re-armed per chunk, once **answer** output flows |
| Max call duration | 10 min | Once at stream open, never re-armed; backstop for callers with no deadline |

The subtle part: the tight budget is **answer-gated, not output-gated**. Monad
originally armed it on any output token including reasoning deltas — and a
reasoning model (`x-ai/grok-4.3`) that streams reasoning, then pauses several
seconds while composing its answer, tripped the 5 s budget and failed roughly
half of one tenant's turns. Gating on the first *answer* token (content / refusal
/ tool-call args) keeps the reasoning→answer gap on the generous budget.

Avalon's parser already distinguishes these (`index.ts:253-255` reads
`choice.delta.content` and `choice.delta.tool_calls`) and the harness doc states
reasoning fields are ignored, so the gate is cheap to implement correctly.

**Recommendation: implement this before the next release.** It is the highest
severity item found, it is independent of every other recommendation, and Avalon
has the shape to add it in the existing read loop.

### 3.2 Human-in-the-loop: `suspend` vs `halt: "needs_input"`

Avalon's elicitation (`HarnessToolResult.halt`, `index.ts:615`) is a narrower
version of Monad's typed `SuspendDirective`, which distinguishes two resume kinds:

- **`wake`** — a time/event resume that re-enters via a prompt and **keeps** the
  tool message. This is what Avalon's `halt` is.
- **`answer`** — the run resumes by threading a human response back as the
  suspended call's matching `role:"tool"` result, so the loop **withholds** that
  call's tool message.

Avalon does not need `answer` today: `request_elicitation` ends the workflow and a
new one starts on response, and `appendToolResultsInOriginalOrder`
(`index.ts:811`, `827`) appends the halting call's result too, so transcripts stay
paired. That is a legitimately simpler design.

The invariants are what to take, should Avalon ever thread an answer back:

1. **Never-send-unpaired** — an unpaired tool call may be *persisted* but never
   *sent*; the resume pairs the answer before the first model call.
2. **A fail-loud assertion at the heal site**, bounded to a set of known-suspended
   ids, so a resume bug surfaces in CI rather than as a provider 400.
3. **At most one open `answer`-suspend per run** — a second in the same batch gets
   a synthesized error so no slot is left unpaired.
4. **A pending suspend is never compacted away.**

Monad also restricts suspend detection to first-party tools: a remote MCP tool may
not suspend the host run. Worth adopting pre-emptively if Avalon ever admits
third-party tools into the loop.

### 3.3 Batch execution: pooling by tool name

Avalon splits a batch into concurrent reads and sequential writes, then appends in
the model's original call order (`index.ts:795-827`) — a good design, and one
Monad shares. Monad adds one refinement worth noting: `runToolCallsPooledByTool`
(`executor-tool-batch.ts`) caps concurrency at **5 per tool name** while letting
different tools fan out fully, because a model can request many calls to the same
tool and saturate one downstream service. Avalon's `Promise.allSettled` over all
reads (`index.ts:801-803`) has no such cap — ten `notion.search` calls in one turn
all fire at once.

### 3.4 Ideas worth knowing about, lower priority

- **Two-tier tool discovery.** Monad found tool-selection accuracy degrades past
  ~30 tools, so it loads ~6 core plugins and defers the rest behind a
  `load_plugin` call with a compact catalog in the system prompt. Avalon
  currently contributes *every* granted tool of *every* healthy workspace
  connector to *every* ad-hoc work stream (`docs/AGENT_HARNESS.md`, "Context") —
  the same trajectory, without the mitigation. Worth measuring tool count per run
  before it becomes a quality problem.
- **System prompt as a pure render.** Monad re-renders the whole system message
  from run state on every plugin/skill activation rather than mutating it in
  place, specifically so unchanged inputs re-render byte-identically and the
  provider prompt-cache prefix survives. Relevant to Avalon's cost profile.
- **Skills.** Monad's SKILL.md system (`docs/skills.md`,
  `docs/writing-good-skills.md`) is progressive-disclosure instructions loaded on
  demand. No Avalon equivalent; a product decision, not a gap.

---

## Not worth reusing

- **`executor.ts` (1,888 lines), `context.ts` (1,370), `executor-deps.ts`** —
  bound to Postgres, Drizzle, Monad's authz, editions, queue, and the
  `agent_runs`/`agent_sessions` schema. Avalon's D1 + Durable Object + Workflow
  model is different enough that the port cost exceeds a clean implementation.
- **`llm.ts` (1,807 lines)** — imports `@/db/schema`, `@/edition/*`,
  `@/server/queue/enqueue`, and Monad's billing. Take the watchdog *design*
  (§3.1), not the file.
- **Anything under `@/data/queries/*`, `@/server/authz/*`, `@/edition/*`.**
- **The Jinja prompt templates** (`server/agents/prompts/`, 50+ files) — these
  encode Monad's product semantics (spaces, canvases, Loom, omnipresence), not
  Avalon's work streams.

---

## Suggested sequencing

| # | Item | Tier | Effort | Why now |
|---|---|---|---|---|
| 1 | Streaming idle watchdog (§3.1) | design | S | Only item that is a live availability bug; 4-min stall with no fallback |
| 2 | `sanitize-tool-schema.ts` (§2.1) | port | S | Zero-dep copy; matching construct signature against the default Gemini model |
| 3 | `RunStats` + `StopReason` from `@juno-ai/bind` (§1.1) | dep | S | Near-identical already; establishes the shared vocabulary cheaply |
| 4 | `run-harness.ts` primitives (§2.2) | port | S | Deletes hand-rolled deadline/abort-source code; adds coalesced heartbeat |
| 5 | `failureDisposition` + `createCircuitBreaker` (§1.2) | dep | M | Real resilience gap; no `RoutePlan` adapter required |
| 6 | Per-tool-name concurrency cap (§3.3) | design | S | Small change, prevents downstream saturation |
| 7 | Generate tool JSON Schema from Zod (§2.1) | design | M | Removes the `automationJsonSchema` drift hazard |
| 8 | `buildRoutePlan` / `executeRoutePlan` adapter (§1.2) | dep | L | Defer until multi-provider routing for one model is actually wanted |

Items 1–4 are independent of each other and of Avalon's architecture; they could
land in any order.

## Open questions

1. **Does Avalon want a dependency on `@juno-ai/bind`, or a vendored copy?** The
   package is MIT and published, but its versioning is unusual — the export
   stamps the *next major* of whatever the public mirror already published, so
   Avalon would see major bumps that do not signal breaking changes. Pinning
   exactly is advisable.
2. **Should the shared pieces flow the other way?** Avalon's side-effect
   idempotency model — stable invocation id derived from `(run, turn, tool
   position)`, canonical input hash, `record_before_execute` for non-idempotent
   writes, `ambiguous` for uncertain outcomes — is arguably cleaner than Monad's
   receipt table, and it is written for `workerd` (`crypto.subtle`, no Node
   crypto). It is a candidate to contribute *into* `bind` when the turn kernel
   lands there.
3. **Which Monad extraction phase lands the tool contracts?** `docs/bind.md`
   says `ToolPlugin` / `ToolContext` move into the package once the single-agent
   consolidation work settles
   (`docs/PRDs/2026-07-28_completed_single-agent-monad-consolidation`, now marked
   completed). If those contracts are close to landing, Avalon's `HarnessTool` /
   `HarnessToolContext` (`index.ts:603-621`) should be reviewed against them
   before diverging further.
