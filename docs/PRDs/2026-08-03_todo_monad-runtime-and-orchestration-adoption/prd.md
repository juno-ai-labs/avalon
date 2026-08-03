# Borrowing from Monad's Harness & Orchestration Model — PRD & Architecture

> **Status: todo.** Created 2026-08-03. Owner: TBD. Written against Avalon `d99a127` and `@juno-ai/bind@6.0.0`.
> **Scope posture: Avalon is a prototype.** This document deliberately takes *less* from Monad than
> Monad has. Monad's model was shaped by a production multi-tenant workload; Avalon has neither that
> load nor the headcount to carry that much machinery. Everything here is either (a) preventing a
> failure that costs real money unattended, (b) protecting the product's core promise in a demo, or
> (c) cheap enough that not doing it is the odd choice. Everything else is in §8 **Deferred**, each
> with the signal that should trigger it.
> **Related:** [`../../AGENT_HARNESS.md`](../../AGENT_HARNESS.md), [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md), [`../../CONNECTORS.md`](../../CONNECTORS.md)
> **Monad references** are to `juno-ai-labs/monad` at `e390032`: `docs/agent-architecture.md`, `docs/agent-activation-design.md`, `docs/agent-run-harness.md`, `docs/job-system.md`, `docs/bind.md`.

> The question this answers: *if we set aside Avalon's current harness and orchestration design and
> take Monad's instead, adjusted for Cloudflare, what would we build?*
>
> The full answer is a quarter of work — sessions, a durable activation pipeline, per-turn workflow
> steps, a Durable Object per session key, per-connector provenance, progressive tool disclosure,
> memory. **That is the wrong amount of building for a prototype**, so this PRD keeps three ideas and
> defers the rest with explicit triggers.
>
> The three: **an agent chain must be bounded** (an unattended loop spends money), **context must be
> summarized rather than amputated** (the product's promise is durable shared context), and
> **admission must be one stage, not two call sites** (Monad ended up with three drifting copies of
> the same check; Avalon has two entry points today and consolidating now is nearly free).
>
> The most useful thing borrowed is not a mechanism but a substitution: where Monad reaches for a
> precise instrument, a prototype should reach for a blunt one. Monad bounds runaway chains by
> carrying lineage through every causal hop; Avalon can get most of that protection from a
> workspace-wide rate ceiling that needs no lineage at all (§4.2). Build the precise version when the
> blunt one starts producing false positives — not before.

## Contents

§0 Verified facts · §1 Problem · §2 Goals / Non-goals · §3 Design space · §4 What to build ·
§5 Data model · §6 Invariants · §7 Sequencing · §8 Deferred, with triggers · §9 Risks ·
§10 Open questions · §11 Testing

---

## 0. Verified facts that shape this PRD

All verified against source on 2026-08-03 at Avalon `d99a127`.

1. **Avalon has no session, no compaction, and no memory.** The `sessions` table is auth refresh
   tokens (`0001_initial.sql:32`), unrelated. Context is assembled per run by `boundModelContext`
   (`apps/api/src/services/integrations.ts:686-710`): the system prompt is truncated to 60 % of
   `HARNESS_MAX_CONTEXT_BYTES` (200 KB default), then messages are taken **newest-first until the
   byte budget runs out**. History past the budget is *dropped*, never summarized, and the first
   message that does not fit is truncated **mid-content**.
2. **The budget is bytes, not tokens, and tool definitions escape it entirely.** `modelTools` is
   built separately (`packages/agent-harness/src/index.ts:696-703`) and passed alongside. Measured:
   65 tools / ~31 KB / ~8,600 tokens on **every** model call, up to
   `HARNESS_MAX_MODEL_ITERATIONS` (8) times per run — the largest fixed per-call cost is the one
   thing unmetered.
3. **Run lineage exists and is unbounded.** `harness_runs.parent_harness_run_id`
   (`0001_initial.sql:288`), with no depth, no chain root, and no admission check anywhere. Only the
   elicitation-answer path passes a parent (`workstream-service.ts:408`).
4. **The run graph can cycle through a third party.** An agent's connector write produces a provider
   webhook → an activity → a `connector_activity` automation match → a new run.
   `github.issues.create` → `github.issue.opened` is closed, as are `linear.create_comment`,
   `notion.create_comment`, and `google.gmail.send`. The only guard on the path is
   `dedupe_key`/`raw_content_hash` (`integrations.ts:1424-1474`), which stops the *same* activity
   twice and says nothing about a new one the agent just caused.
5. **Echo suppression by actor cannot work.** `activities.actor_json` exists
   (`0001_initial.sql:112`), but Avalon writes through the **user's** OAuth grant, so the agent's
   comment is authored by the user's provider account and is byte-identical to the user typing it.
   Filtering by actor would suppress genuine human activity.
6. **Avalon has idempotent tool replay that Monad does not.** Stable id from
   `(harnessRunId, turn, position)` (`index.ts:852`), canonical input hash (`index.ts:1111`),
   `record_before_execute`, and an explicit `ambiguous` status. Already `workerd`-native.
7. **The platform cannot run Monad's admission model.** D1 has no advisory locks, no
   `SELECT … FOR UPDATE SKIP LOCKED`, and no `pg_cron`. Monad's claim-time admission
   (`pg_try_advisory_xact_lock` per key, held counts from `claimed_holder_keys`) has no D1
   translation. Durable Objects are the only true serialization primitive available.
8. **The whole tool loop is one workflow step.**
   `step.do("run-authorized-harness-loop", …)` (`workflows/workstream-loop.ts:78`), so a failure at
   turn 7 of 8 re-runs all eight. Avalon's replay (fact 6) is what keeps that from duplicating
   writes.
9. **`@juno-ai/bind@6.0.0` is published and `workerd`-clean.** Zero runtime `openai` imports (types
   only); the only platform APIs used are `AbortSignal.any` and `setTimeout`. `6.0.0` is the first
   release carrying all six `ChainRule` kinds.

---

## 1. Problem

Three problems, ranked by what they cost an unattended prototype.

### 1.1 A loop spends money with nobody watching

Facts 3–5. Nothing counts hops in the connector cycle, and the cheap mitigation is unavailable.
A prototype is exactly the environment where this is worst: few users, no dashboards, and an
OpenRouter balance that can drain overnight before anyone looks.

### 1.2 Context is amputated, not compacted

Fact 1. Avalon's stated promise is *durable context people and an agent share*. A long work stream
does not get compacted, it gets cut off mid-message with no summary of what was lost. This shows up
in a demo the moment a work stream gets interesting, which for a prototype is the failure that
matters most after cost.

### 1.3 Two entry points, no shared admission

`launchHarness` and the activity consumer each start runs with no validation, no rate limit, no
dedupe. Monad ended up with the same check hand-rolled at **three** entry points, drifting, caught
only by a review. Avalon has two today. Consolidating at two is nearly free; at four it is a
project.

**Not a problem yet:** unbounded concurrency per work stream, unmetered tool payload as a *cost*
line, no resume on failure. All real, none of them urgent at prototype scale. §8.

---

## 2. Goals / Non-goals

**Goals**

- G1. A runaway chain stops on its own, without anyone watching.
- G2. A long work stream keeps its beginning in summarized form.
- G3. One code path decides whether a run may start.
- G4. Consume `@juno-ai/bind@6.0.0` for anything it already solves; write no new primitive that
  exists there.

**Non-goals**

- NG1. **Monad's job system.** Cloudflare Workflows and Queues already are one.
- NG2. **Loom.** Avalon's `activities` pipeline is the same idea with less machinery.
- NG3. **Memory, dreaming, roles, graduation.** Monad product decisions Avalon has no use for.
- NG4. **A Durable Object per session key.** Correct, and §8-deferred — the concurrency it prevents
  is not currently hurting anyone.
- NG5. **Per-connector provenance.** The precise instrument. §4.2 explains what replaces it.
- NG6. **Restructuring the workflow into per-turn steps.** §8.

---

## 3. Design space

### 3.1 Design A — port Monad's runtime onto D1

Recreate `queue.jobs`, claim-time admission, held-key rows, the reaper.

**Rejected, and not close.** Fact 7: Monad's correctness under contention rests on advisory locks
D1 does not have. The honest substitute over-admits — the exact bug class the model exists to
prevent — and it means running a hand-rolled queue beside Cloudflare Queues and Workflows.

### 3.2 Design B — adopt Monad's model wholesale, mapped to Cloudflare primitives

Sessions, an activation pipeline, a Durable Object per session key (its single-threaded execution
*is* the mutex Monad builds with locks), per-turn workflow steps, per-connector provenance,
progressive tool disclosure.

**Right, and rejected on scope.** This is a quarter of work. Every piece is defensible in
isolation, and together they are more machinery than the product currently justifies. The DO-as-mutex
mapping in particular is genuinely better than Monad's lock table — no held-key rows, no release
path, no reaper — which is why it is deferred rather than discarded (§8).

### 3.3 Design C — the three ideas that pay off now, blunt instruments where possible ✅

Bound the chain, summarize instead of truncating, one admission path. Where Monad uses a precise
mechanism, use the cheapest one that removes the failure mode, and write down what would justify
upgrading.

**Chosen.**

### 3.4 Design D — do nothing until it hurts

**Rejected on §1.1 alone.** The cost failure is unattended and unbounded, and "until it hurts" for
an overnight loop means "after it has already cost the money."

### 3.5 Evaluation

| | A: port | B: full model | **C: three ideas** | D: nothing |
|---|---|---|---|---|
| Stops a runaway (§1.1) | ✅ | ✅ | ✅ | ❌ |
| Keeps stream history (§1.2) | ✅ | ✅ | ✅ | ❌ |
| One admission path (§1.3) | ✅ | ✅ | ✅ | ❌ |
| Correct under contention | ❌ | ✅ | not addressed (§8) | ❌ |
| Fights the platform | severe | none | none | — |
| Cost | very high | high | **low** | none |

---

## 4. What to build

### 4.1 One admission path (G3)

A single module — `apps/api/src/services/activation/admit.ts` — that both `launchHarness` and the
activity consumer call **before** creating anything:

1. Validate the signal shape (zod).
2. Measure (§4.2), hand the rules to `admitChildRun` from `@juno-ai/bind/run`.
3. Return admit / refuse with `rule` and `retryable`.

`admitChildRun` is the **only** decider. No hand-rolled comparison at any entry point — that is the
whole lesson from Monad's three-copy drift, and it costs nothing to honour from the start.

**Admit before create.** The check precedes both the `INSERT INTO harness_runs`
(`workstream-service.ts:633`) and the `WORKSTREAM_LOOP_WORKFLOW.create`
(`activity-consumer.ts:596`). A chain bounded once its runs exist is not bounded, it is billed.

### 4.2 Bound the chain with a blunt instrument (G1)

**The substitution that keeps this small.** Monad bounds a runaway by carrying lineage through every
causal hop, so it can say *this specific chain has gone too deep*. Avalon's cycle leaves the process
and comes back through a webhook, so carrying lineage means resolving
`(provider, resource) → run` per connector — real work, and silently wrong for any connector whose
webhook reports a different id than its write returned.

A prototype does not need to know *which* chain ran away. It needs the spending to stop. So:

**Primary guard — a workspace rate ceiling.** `tenant_rate`: count harness runs the workspace created
in a rolling window, refuse past a ceiling. No lineage required, catches every cycle regardless of
shape, and one indexed count answers it. At prototype scale nobody has a legitimate burst, so the
false-positive rate is ~0.

**Secondary — depth, where lineage is already free.** The elicitation path already passes a parent
(fact 3), and any future in-process spawn would too. Add `chain_depth` / `chain_root_run_id` and run
the `depth` and `chain_budget` rules on that. This costs one migration and catches in-process
recursion exactly, while the rate ceiling covers the connector cycle approximately.

**Not built: provenance carry.** §8, with its trigger.

Rules in evaluation order — first refusal wins, so the order picks which reason a person sees:

| Rule | Measurement | Covers |
|---|---|---|
| `depth` (omit at depth 0) | `chain_depth - 1` | in-process recursion, exactly |
| `chain_budget` | `COUNT(*)` over `chain_root_run_id` | a chain that stays shallow but fans out |
| `tenant_rate` | workspace runs in a rolling window | **the connector cycle**, and everything else |

**`retryable` maps onto queue behaviour**, which is worth more here than in Monad (Monad drops the
field — nothing downstream waits). The activity consumer already uses
`message.retry({ delaySeconds: 30 })` (`activity-consumer.ts:199`):

- `retryable: true` (`tenant_rate`) → `message.retry(…)`; the window rolls.
- `retryable: false` (`depth`, `chain_budget`) → ack and record. Retrying costs a queue slot forever
  and can never succeed.

**Omit, never sentinel.** A measurement that came back *broken* (`NaN`, negative) **refuses**; a
measurement that could not be taken at all (the D1 query threw) is expressed by **omitting the
rule**, which admits. Passing `NaN` for "unknown" turns a transient D1 blip into every agent in the
workspace refusing to run. Decide it in the `catch` at the call site.

### 4.3 Summarize instead of truncating (G2)

The smallest change that fixes §1.2: when `boundModelContext` is about to drop messages, summarize
the dropped prefix with one LLM call and cache it on the work stream, then prepend the summary
instead of the dropped turns.

Deliberately **not** a session table. Avalon rebuilds context from `messages` each run, and that is
fine at this scale — the bug is not "we rebuild", it is "we discard". A cached
`context_summary` + `context_summary_through_sequence` on `workstreams` is enough to stop
discarding, and it is roughly two orders of magnitude less work than sessions + compaction +
memory-flush turns.

Two details worth taking from Monad because both were learned from failures:

- **Never truncate mid-message.** Drop whole turns. A half-message is worse than an absent one — the
  model treats the fragment as complete.
- **Summarize on the provider's real token counts if they are to hand**, not bytes. The current
  200 KB byte budget is not a proxy for the model's context window; it is a different quantity with
  similar units. If wiring real counts is awkward, keep the byte budget as the *trigger* but fix the
  mid-message truncation regardless — that part is a two-line change.

### 4.4 Shrink the tool payload — the cheap half only

Fact 2: 65 tools, ~31 KB per call. Monad's answer is progressive disclosure with a `load_plugin`
tool and a catalog. **That is the deferred version** (§8).

The prototype version: contribute connector tools only for connectors the work stream actually
references — its automation's `requiredCapabilities`, its resources, its participants' grants —
instead of every healthy workspace connector. This is a filter at `loadHarnessTools`, not a
protocol, and it needs no model-facing change.

Do this **only if** it stays a filter. The moment it needs the model to ask for more, it has become
the deferred item and should wait for the trigger.

---

## 5. Data model

One migration, `0025` (next free prefix; `0024` is highest committed). SQLite has no
`ADD COLUMN IF NOT EXISTS`, so guard on `pragma_table_info` or rely on the runner's applied ledger.

```sql
ALTER TABLE harness_runs ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE harness_runs ADD COLUMN chain_root_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL;
ALTER TABLE workstreams ADD COLUMN context_summary TEXT;
ALTER TABLE workstreams ADD COLUMN context_summary_through_sequence INTEGER;
CREATE INDEX IF NOT EXISTS harness_runs_chain_idx ON harness_runs(chain_root_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS harness_runs_workspace_created_idx ON harness_runs(workspace_id, created_at DESC);
```

Existing rows default to depth 0 with a null root, which is the correct reading of history rather
than a lie — see §6/2.

---

## 6. Invariants

Short list on purpose. These are the ones that are cheap to honour now and expensive to retrofit.

1. **One decider.** Every bound goes through `admitChildRun`. No hand-rolled comparison, at any entry
   point, ever.
2. **Null means me.** A root run's `chain_root_run_id` is `NULL`; read the root as
   `chain_root_run_id ?? id`. Adopting the *parent's* id as the root at every level makes each
   generation its own chain, and every per-chain bound then silently never fires.
3. **Admit before create.** §4.1.
4. **Omit, never sentinel.** §4.2.
5. **Whole turns only.** Never truncate a message body to fit a budget.
6. **A chain never spans regions.** Global and EU have separate D1s; a root id from one is
   meaningless in the other. A cross-region cause starts a new chain at depth 0, deliberately.
7. **Refusal strings reach people.** Branch on `rule`, never on the prose.

---

## 7. Sequencing

| # | Step | Effort | Ships |
|---|---|---|---|
| 0 | **Measure** (§11) | hours | nothing — sets the ceilings from real traffic |
| 1 | `bind@6.0.0` + `0025` migration + `admit.ts`, both entry points | days | §4.1 + §4.2 |
| 2 | Stop mid-message truncation | hours | half of §4.3, independently |
| 3 | Prefix summary + cache | days | rest of §4.3 |
| 4 | Tool filter | days | §4.4, only if it stays a filter |

**Step 0 gates the ceilings.** Set them from Avalon's measured traffic, **not from Monad's** —
5 / 500 / 100-per-30 s were tuned against a different workload.

**If only one step is funded, do 1.** It is the only one addressing an unattended cost failure.
Step 2 is hours and should happen regardless.

---

## 8. Deferred, with triggers

Each of these is right, and each is waiting on a signal rather than on a decision. Recording the
trigger is the point — otherwise "deferred" quietly becomes "forgotten".

| Deferred | Why not now | Trigger to build it |
|---|---|---|
| **Durable Object per session key** (Monad's mutex, done better — the object's single-threaded execution replaces the lock table, held-key rows, release path, and reaper) | Concurrent runs on one work stream are not currently observed to hurt | First interleaved-write bug, or any user report of a work stream contradicting itself |
| **Per-connector provenance carry** (`(provider, resource) → run`, so the connector cycle carries real depth) | Expensive per connector, and silently wrong for any provider whose webhook id ≠ its write id | The §4.2 rate ceiling starts refusing legitimate work, i.e. its first false positive |
| **Sessions + compaction + memory** | §4.3's cached prefix summary buys the product promise for ~1 % of the work | A work stream where the summary itself exceeds the budget, or a need for cross-stream recall |
| **Per-turn workflow steps** (resume at the failed turn instead of re-running all of them) | Re-running 8 turns costs cents at this scale | A run long or expensive enough that a retry is felt, or a non-idempotent tool that replay cannot cover |
| **Progressive tool disclosure** (`load_tools` + catalog) | §4.4's filter is a filter, not a protocol | The filter stops shrinking the payload enough, or a tool-selection eval regresses past ~30 tools |
| **Streaming idle watchdog, deadline, schema sanitizer, batch pooling** — all present in `@juno-ai/bind@6.0.0` | Genuinely small; each fixes a real defect | Take them opportunistically whenever the surrounding code is open. The watchdog is the most valuable: the stream read loop has no inter-chunk timeout, so a stalled provider is bounded only by a 240 s wall clock |

---

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The rate ceiling is blunt** — it cannot tell a loop from a busy morning | Set it from step 0's measurements with headroom; `retryable: true` means a false positive delays rather than drops. Its first false positive is the provenance trigger (§8) |
| R2 | **Depth stays 0 for the connector cycle**, so the `depth` rule never fires there | Stated, not hidden: the rate ceiling is the guard for that path (§4.2). Do not let the presence of `chain_depth` imply coverage it does not have |
| R3 | **The prefix summary is lossy in a way that matters** | Keep the summarized-through sequence number so the raw history is always recoverable from `messages`; the summary is a cache, never the source of truth |
| R4 | **"Prototype" stops being true and nobody revisits §8** | The triggers are written as observable events, not judgement calls |
| R5 | **`bind` releases are outside Avalon's control** — its version stamps the next major of the public mirror, so a major bump carries no breakage signal | Pin `6.0.0` exactly, never a caret |

---

## 10. Open questions

- Q1. **Has the cycle already happened?** §11's first query answers it. If chains do not exist in
  production yet, §1.1 is real but cold, and step 1 is preventive rather than urgent.
- Q2. **What is a sane workspace ceiling?** §11's second query. Guessing produces either a useless
  ceiling or a false-positive generator.
- Q3. **Does the §4.4 filter actually shrink anything**, or do most work streams reference most
  connectors? Measurable before building.
- Q4. **What should flow the other way, from Avalon into `bind`?** Three candidates, verified
  against `bind`'s published source. None is prototype work; they are recorded because `bind` is a
  published package and one of them is a latent bug in it.

  1. **The no-replay-after-visible-output rule — a real gap in `bind` today.** Avalon sets
     `emitted = true` on the first assistant text or tool-call byte and then refuses to fall back
     (`index.ts:178`, `:185`), because replaying could duplicate output a user already saw or a
     provider write already made. `bind`'s `failureDisposition` decides retry / next-provider /
     fallback **purely from the error taxonomy** and has no notion that the attempt already produced
     visible output. Monad never hit this because its `callLLM` accumulates the whole completion
     and streams nothing to the user — so **any `bind` consumer that streams tokens to a UI and uses
     `executeRoutePlan` will duplicate output on a mid-stream failure.** The fix is small: an
     `attemptProducedOutput` signal that clamps a disposition to `propagate`.
  2. **The streamed tool-call assembler.** `detectCompletionDefect` consumes an
     `AssembledCompletion` and its own header says a host "assembling chunks by hand" fits — i.e.
     `bind` assumes the host wrote the assembler. Every host therefore writes the same
     accumulate-by-`index`, carry-`id`, concatenate-`name`/`arguments`, sort-by-index loop, and it
     has a real footgun (deltas may carry `id` in any chunk, and arrival order is not call order).
     Avalon's version is clean and pure.
  3. **Idempotent tool replay (fact 6), split along the fence.** `canonicalJson` and
     `stableHarnessToolCallId` are pure string/object work and portable as-is. The SHA-256 is
     **not**: `bind`'s build is `lib: ["es2022"], types: []`, so `crypto.subtle` and `TextEncoder`
     are untyped there. It would enter as an injected `digest` port — the pattern `bind` already
     uses for `StreamTimers` and `AttemptClassification`. The judgement (what to canonicalize, how
     to derive the id, what `ambiguous` means) is the portable part; the primitive is the host's.

---

## 11. Testing

**Step 0 queries** (both executed against the real schema on 2026-08-03):

```sql
WITH RECURSIVE chain(id, root, depth) AS (
  SELECT id, id, 0 FROM harness_runs WHERE parent_harness_run_id IS NULL
  UNION ALL
  SELECT r.id, c.root, c.depth + 1
    FROM harness_runs r JOIN chain c ON r.parent_harness_run_id = c.id
)
SELECT depth, COUNT(*) FROM chain GROUP BY depth ORDER BY depth DESC;

SELECT workspace_id, substr(created_at, 1, 13) AS hour, COUNT(*)
  FROM harness_runs
 WHERE origin NOT IN ('human_message','opening_message','elicitation_answer')
 GROUP BY 1, 2 HAVING COUNT(*) > 20 ORDER BY 3 DESC;
```

**Required tests** — proportionate to the build, not to Monad's suite.

- A depth-0 run is **admitted**: the depth rule is *omitted*, not passed `parentDepth: -1`. Monad
  shipped this exact bug — the conversion refuses every root run — and caught it only against a real
  database.
- A workspace over its ceiling is refused with `retryable: true`, and the refusal reaches
  `message.retry`.
- A D1 error in a count omits that rule and **admits**; a `NaN` count **refuses**. Pin the
  distinction with a ceiling that would refuse any measured value.
- No message body is ever truncated mid-content.
- A work stream past the byte budget retains its opening as a summary, and the raw history is still
  reconstructable from `messages` at the recorded sequence number.
