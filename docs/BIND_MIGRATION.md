# Migrating Avalon's harness onto `@juno-ai/bind`

An execution plan for replacing hand-rolled internals of
`packages/agent-harness` with the published `@juno-ai/bind` package.

Written against Avalon `d99a127` ("Publish Avalon 0.2.0 and prepare 0.3.0") and
`@juno-ai/bind@5.0.0` on npm.

Companion to [`MONAD_REUSE.md`](./MONAD_REUSE.md), which assessed *what* is worth
sharing. This document is the *how*. Read the assessment for the reasoning behind
each item; read this one for the order, the gates, and the traps.

---

## What changed since the assessment

`MONAD_REUSE.md` was written against `@juno-ai/bind@2.0.0` and sorted its
findings into three tiers: adopt as a dependency, port the file, adopt the
design. Monad's extraction work has since collapsed most of that distinction.
**Six of the eight sequenced items are now a dependency rather than a port or a
re-implementation:**

| Assessment item | Assessment said | In `5.0.0` today |
|---|---|---|
| §3.1 Streaming idle watchdog | adopt the design, implement it yourself | `createStreamWatchdog` — `bind/completion` |
| §2.1 `sanitize-tool-schema.ts` | port the 683-line file | `sanitizeToolSchema` — `bind/tools` |
| §2.2 Deadline / failure classification / heartbeat | port the file | `createRunDeadline`, `classifyRunFailure`, `createCoalescedHeartbeat` — `bind/run` |
| §3.3 Per-tool-name concurrency cap | adopt the design | `runToolCallsPooledByTool` — `bind/run` |
| §1.1 `RunStats` / `StopReason` | dependency | unchanged — `bind/contracts` |
| §1.2 Routing / breaker | dependency | unchanged — `bind/routing` |

The practical consequence: this migration is mostly **add one dependency and
delete code**, not a port. Verified against the published tarball, not the Monad
source tree.

## Scope decision: take the primitives, keep the loop

`bind` also exports `runToolLoop`, its own iteration engine. **Avalon should not
adopt it**, now or as part of this work.

- `runToolLoop` is typed in OpenAI SDK types throughout and carries concepts
  Avalon has no equivalent of — plugin activation, transcript compaction, a
  two-kind `suspend` directive.
- Avalon's loop carries two things `runToolLoop` does not: `halt: "needs_input"`
  elicitation, and idempotent tool replay keyed by
  `(harnessRunId, turn, tool position)` + canonical input hash.

Replacing the loop is a rewrite with a net feature loss. Replacing what the loop
*calls* is a migration. This plan does only the latter: `runHarness` stays
Avalon's, and every phase swaps a helper underneath it.

`@avalon/agent-harness` also stays the public face. Both consumers —
`apps/api/src/services/integrations.ts:269` and
`apps/api/src/queues/activity-consumer.ts:710` — keep importing from it, so
phases 1–4 change no code outside `packages/agent-harness/`.

---

## Prerequisite: republish `bind`

Two things this plan wants are on Monad `main` (as of `e390032`) but **not** in
published `5.0.0`:

- `parseToolCallArguments` / `toolCallArgumentsAbsent` (`bind/completion`) —
  phase 7 below.
- The `pair_seen` and `tenant_rate` `ChainRule` variants (`bind/run`) — not used
  by this plan; noted so the version delta is complete.

Someone has to cut a release from Monad `main` (`scripts/publish-bind.ts`).
Phases 0–6 do not depend on it and can start immediately.

---

## Phase 0 — land the dependency

```
pnpm --filter @avalon/agent-harness add @juno-ai/bind@5.0.0
pnpm --filter @avalon/agent-harness add -D openai
```

**Pin exactly — no caret.** `bind`'s version stamps the *next major* of whatever
the public mirror already published, so a major bump does not signal a breaking
change and semver ranges carry no information. Read the diff on every upgrade.

**Why `openai` as a devDependency.** Six of `bind`'s `.d.ts` files reference
OpenAI SDK types (`transcript/validate`, `routing/attempt-errors`,
`completion/defects`, `loop/tool-loop`, `run/tool-batch`, `contracts/turn`).
Avalon's `skipLibCheck: true` means those references won't fail the build on
their own, but any Avalon code that *names* one of those types would infer
`any`. A types-only devDependency costs nothing at runtime: the published
package contains **zero** runtime `openai` imports — verified by grepping every
`.js` in the tarball, where the only hit is a comment.

**Workers compatibility.** The published JavaScript uses exactly two platform
APIs: `AbortSignal.any` and `setTimeout`. No Node builtins, no `process`, no
`crypto.subtle`. `unrefTimer` duck-types `timer.unref` before calling it, so it
is a no-op on `workerd` rather than a crash. Total package size 516 KB across
all nine subpaths; import from the subpath (`@juno-ai/bind/completion`), not the
root, so unused modules stay out of the bundle.

**Gate:** `pnpm typecheck && pnpm build` green, and a recorded `wrangler` bundle
size delta for `apps/api`. If the delta is larger than the modules actually
imported, the subpath imports are wrong.

---

## Phase 1 — the streaming idle watchdog

**This is the only phase that fixes a live availability bug.** Do it first.

Avalon's stream read loop (`packages/agent-harness/src/index.ts:279-285`) is an
unguarded `while (true) { await reader.read() }`. The `fetch` carries only
`input.signal`. A provider that opens the stream and then stalls is bounded only
by `HARNESS_MAX_WALL_CLOCK_MS`, which defaults to **240,000 ms**
(`apps/api/src/services/integrations.ts:278`).

Wire `createStreamWatchdog` into `streamModel`: pass `watchdog.signal` to the
`fetch`, call `watchdog.open()` once the response is established, classify each
chunk, and consult `watchdog.stall()` in the `catch` before `dispose()` in a
`finally`.

**The chunk classification is the part to get right.** The tight inter-chunk
budget is **answer-gated, not output-gated**. Monad originally armed it on any
output token including reasoning deltas, and a reasoning model that streams
reasoning then pauses several seconds while composing its answer tripped the 5 s
budget and failed roughly half of one tenant's turns. Avalon's parser already
reads `choice.delta.content` and `choice.delta.tool_calls`
(`index.ts:259-260`), so the mapping is direct:

- `content` / `tool_calls` present → `"answer"`
- a reasoning delta present (`reasoning_content` ?? `reasoning`; providers
  disagree on the name and it is off-spec either way) → `"reasoning"`
- otherwise → `"none"`

**Two distinct wins, worth separating so the change is not oversold.** Avalon
sets `emitted = true` on the first text or tool-call byte and then rethrows
without falling back (`index.ts:178`, `185`) — correct, since replaying could
duplicate visible output or provider writes.

- **Stream opens, no token ever arrives.** `emitted` is still `false`, so the
  120 s time-to-first-token budget fires *and* fallback is still available. This
  turns a 240 s hang into a retry that can succeed.
- **Stall mid-generation.** `emitted` is `true`, so the no-replay rule still
  applies and the run still fails. The win is 5 s instead of 240 s, not a
  recovery.

**Config invariant, learned the hard way in Monad:** never set
`HARNESS_MAX_WALL_CLOCK_MS` below the time-to-first-token budget. At the
defaults there is no conflict (TTFT 120 s < wall clock 240 s < absolute cap
600 s), but lowering the wall clock past 120 s makes the run deadline preempt
the watchdog, and the stall is then classified as a deadline rather than a
retriable transport failure. Monad shipped exactly this bug and fixed it by
deriving the request timeout from `DEFAULT_TIME_TO_FIRST_TOKEN_MS` instead of
writing a literal. Derive it or assert it at startup.

**Gate:** a test that opens a stream, emits nothing, and asserts the run fails
in ~TTFT rather than at the wall clock — driven by an injected clock, not a real
sleep.

---

## Phase 2 — deadline and failure classification

Replace, all inside `runHarness`:

| Delete | With |
|---|---|
| the inline `setTimeout` deadline (`index.ts:689-692`) | `createRunDeadline` |
| `abortSource` + `markExternalAbort` (`index.ts:684-688`, `834`) | `RunDeadline.timedOut` |
| `finishAbort` (`index.ts:729-732`) | `classifyRunFailure` |
| `combineSignals` (`index.ts:1087-1092`) | `RunDeadline.withExternal` |

Roughly 25 lines deleted for a like-for-like swap. The invariant both sides
already hold, and which must survive: **a combined external abort must not read
as a timeout** — that is what separates a user cancellation from a deadline.
`bind` encodes it in `timedOut`, which stays false when only the external signal
fires.

Carry Monad's ownership rule verbatim: whoever classifies the outcome creates
and owns the deadline and disposes it in a `finally`; a callee handed a deadline
must not dispose it. `runHarness` is that owner today and stays it.

**Gate:** `index.test.ts:241-258` already pins deadline-vs-cancellation in one test —
`maxWallClockMs: 5` must yield `failure.kind: "deadline"`, an external abort must
yield `status: "stopped"` with no `failure`. It must stay green **untouched** — if
it needs editing, the swap was not like-for-like.

---

## Phase 3 — tool-schema sanitization

Apply `sanitizeToolSchema` where `modelTools` is built (`index.ts:696-703`).
One call site; 683 lines of transform logic arrive as a dependency.

The assessment measured Avalon's exposure against a default model of
`google/gemini-2.5-flash-lite`, whose function-declaration schema is a strict
OpenAPI 3.0 subset requiring a scalar `type`:

- **22 type-array occurrences** across connector schemas, e.g.
  `startCursor: { type: ["string", "null"] }` in `notion.query_data_source`.
- **45 `additionalProperties: false` occurrences** — xAI/Grok via OpenRouter
  rejects the boolean form on a nested object schema with a hard 400.

The amplifier is what makes this worth doing before it bites: **strict
validators reject the entire request — every tool — on the first violation.**
One bad schema breaks the whole toolset.

**Honest caveat:** the assessment reported a matching construct *signature*, not
an observed Avalon failure. This phase should therefore include a diff of every
connector schema before and after sanitization, committed as a fixture. To
convert "probable" to "known", port Monad's gated live-inference regression
suite (`server/agents/tools/__tests__/tool-schema-model-compat.test.ts`, gated
on `RUN_OPENROUTER_EVALS=1`) alongside it.

**Gate:** the before/after fixture diff is reviewed by a human. A sanitizer that
changes nothing means it is wired up wrong; a sanitizer that changes something
unexpected is a finding.

---

## Phase 4 — batch pooling

Replace the `Promise.allSettled` over all reads (`index.ts:791-793`) with
`runToolCallsPooledByTool`: 5 concurrent calls per *tool name*, full fan-out
across different tools, results returned in input order.

Avalon today has no cap — ten `notion.search` calls in one turn all fire at
once, saturating one downstream service.

Two behaviours to preserve deliberately, not incidentally:

1. **Original-call-order transcript append.** Already correct
   (`appendToolResultsInOriginalOrder`, `index.ts:981`). `bind`'s pooling
   returns results in input order, so this composes — but assert it.
2. **Rejection handling.** Avalon currently *throws* on a rejected read
   (`index.ts:796`). `bind` returns `PromiseSettledResult`s and leaves the
   decision to the caller. Keep throwing, or synthesize an error tool message —
   but do not silently drop, or the next request carries an unanswered
   `tool_call_id` and the provider rejects the whole transcript.

**Gate:** a test asserting 10 same-tool calls never exceed 5 in flight, and that
a rejected read still produces a paired `tool` message or a thrown run failure.

---

## Phase 5 — `RunStats` and `StopReason`

The first phase whose effects cross the package boundary. Everything before it
is internal to `packages/agent-harness/`.

`emptyRunStats` / `accumulateTurn` / `accumulateToolCall` replace the four
hand-rolled folds at `index.ts:995-1043`. The two shapes are already
near-identical — eight fields, same names, same semantics, arrived at
independently — and `bind` is a strict superset (`costCents`).

Take `StopReason` with them. Avalon's `HarnessOutcome.status`
(`completed | needs_input | failed | stopped`) folds "hit `maxIterations`" and
"a tool threw" into the same `failed` plus a `HarnessFailure.code`
discriminator; `bind`'s `done | suspended | iteration_limit | deadline |
aborted` decomposes it properly.

**This is a breaking change to `HarnessOutcome`.** Before starting, audit what
consumes it: `apps/api/src/services/integrations.ts` at minimum, plus anything
persisted to `harness_runs` or emitted over the work-stream event channel to the
desktop client. If the status string reaches the desktop wire protocol, this
phase needs an expand/contract split across two releases — emit both, migrate
readers, then drop the old field.

**Do not skip the audit and assume it is internal.** That is the one place in
this plan where a wrong assumption ships a client-visible regression.

---

## Phase 6 — attempt classification and the circuit breaker

Avalon has **no circuit breaker**: a dead provider is retried on every run.

Adopt `classifyAttemptError` + `failureDisposition` + `createCircuitBreaker`
standalone. These need no `RoutePlan` and no planner adapter.

`classifyAttemptError` takes two host ports. Avalon's existing
`openRouterFailureDisposition` (`index.ts:312-325`) maps onto them almost
directly:

- `asTransportFailure` — recognize `OpenRouterError` and report its status.
- `categorizeStatus` — override the neutral HTTP mapping where OpenRouter
  disagrees with it.

Two properties to carry over, both of which Avalon lacks today and would
otherwise have to rediscover:

- **A malformed prompt must not open the circuit.** Request-shaped rejections (a
  400, a moderation refusal) traverse to another model but record no breaker
  failure — the endpoint is healthy. Without that, one user's flagged prompt
  degrades the shared endpoint for everyone.
- **Breaker keys must be per-credential and secret-free.** Avalon is heading
  toward per-workspace connector credentials; pass an opaque `credentialScope`
  tag so one workspace's revoked key never opens the circuit for others, and
  never key material.

One footgun found empirically in Monad: `APIUserAbortError.name` is `"Error"`,
not `"APIUserAbortError"`. Any abort detection that matches on the class name
silently fails. `bind` exposes `isAbortByName` and an `isAbort` port for this.

**Gate:** a test that a 400 traverses without opening the breaker, and that a
500 opens it after the configured consecutive-failure count.

---

## Phase 7 — tool-argument parsing *(blocked on republish)*

Replace `JSON.parse(call.function.arguments || "{}")` (`index.ts:888`) with
`parseToolCallArguments`.

Avalon's `|| "{}"` already handles the empty-string zero-argument case — the
same bug Monad shipped and fixed, avoided here by luck or care. What `bind` adds:

- **Whitespace-only arguments.** `"  " || "{}"` is `"  "`, which is truthy, so
  it reaches `JSON.parse` and throws. A provider that pads its zero-arg payload
  currently kills a perfectly good call and burns a recovery turn.
- **Valid JSON that is not an object** — `null`, `[]`, `42` — is refused
  *before* dispatch rather than handed to a tool that fails its own validation
  afterward. That ordering matters for any tool whose side effect precedes its
  validation.

Blocked until `bind` is republished from Monad `main`.

---

## Deferred, with a trigger

**Full route planning** (`buildRoutePlan` / `executeRoutePlan`). Requires a
`PlannerTransport` adapter and canonical `vendor/slug` model ids. Avalon is
OpenRouter-only, so every model stage would carry exactly one provider
candidate — real adapter work for no behaviour change.

**Trigger to revisit:** the first time Avalon wants two providers for one model,
or wants provider pinning per workspace. Until then phase 6 delivers the
resilience without the adapter.

---

## Sequencing

| # | Phase | Touches | Effort | Independent? |
|---|---|---|---|---|
| 0 | Land the dependency | `package.json` | S | — |
| 1 | Streaming watchdog | `streamModel` | S | yes |
| 2 | Deadline + classification | `runHarness` | S | yes |
| 3 | Schema sanitization | `modelTools` build | S | yes |
| 4 | Batch pooling | read phase | S | yes |
| 5 | `RunStats` + `StopReason` | **crosses into `apps/api`** | M | no — audit first |
| 6 | Breaker + classification | `OpenRouterClient` | M | yes |
| 7 | Tool-argument parsing | `executeToolCall` | S | **blocked** |

Phases 1–4 are internal to `packages/agent-harness/`, change no `apps/api` code,
and are independently revertible. They can land in any order or in parallel.
Phase 5 is the first one that needs a consumer audit. Phase 7 needs a bind
release.

Suggested first PR: **phases 0 + 1**, because the watchdog is the only live bug
and the dependency is worthless without a first consumer.

## What should flow the other way

Avalon's side-effect idempotency model has no `bind` equivalent and is arguably
better than Monad's receipt table: a stable invocation id derived from
`(harnessRunId, turn, tool position)` (`stableHarnessToolCallId`,
`index.ts:852`), a canonical input hash (`canonicalToolInputHash`,
`index.ts:1111`), `record_before_execute` for non-idempotent writes, and an
explicit `ambiguous` status for uncertain outcomes.

It is already written for `workerd` — `crypto.subtle`, no Node crypto — which
means it clears `bind`'s portability fence as-is. Worth proposing as a
contribution once phases 0–4 have established the dependency in both directions.

## Open questions

1. **Does `HarnessOutcome.status` reach the desktop client?** Determines whether
   phase 5 is a one-PR change or an expand/contract across two releases. Answer
   this before starting phase 5, not during it.
2. **Who owns the `bind` release cadence?** Phase 7 is blocked on a republish,
   and Avalon will keep hitting this. Either Avalon gets a way to request a cut,
   or it pins and waits.
3. **Does Avalon want `bind`'s tool/plugin contracts when they land?**
   `ToolPlugin` / `ToolContext` are slated to move into the package. If they are
   close, Avalon's `HarnessTool` / `HarnessToolContext` (`index.ts:593-611`)
   should be reviewed against them before diverging further.
