# Adopting Monad's Harness & Orchestration Model in Avalon — PRD & Architecture

> **Status: todo.** Created 2026-08-03. Owner: TBD. Written against Avalon `d99a127` and `@juno-ai/bind@6.0.0`.
> **Related:** [`../../MONAD_REUSE.md`](../../MONAD_REUSE.md) (what is worth sharing), [`../../BIND_MIGRATION.md`](../../BIND_MIGRATION.md) (the incremental alternative — Design C below), [`../../AGENT_HARNESS.md`](../../AGENT_HARNESS.md), [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md), [`../../REGIONALIZATION.md`](../../REGIONALIZATION.md)

> This PRD answers a specific question: *if we set aside Avalon's current harness and orchestration
> design and instead take Monad's, adjusted for Cloudflare, what would we build?*
>
> The answer is **not** "port Monad's runtime." Monad's runtime is a long-lived Node worker holding a
> Postgres advisory lock for up to an hour; Avalon is `workerd`, D1, Durable Objects, Queues, and
> Workflows across two regions. A literal port is both impossible and undesirable.
>
> The answer is that Monad's design is really **four ideas**, and three of them are missing from
> Avalon entirely: **the session is the unit of continuity** (not the run), **admission is a stage,
> not a call site**, **runs can start runs and the graph must be bounded**, and **tools are disclosed
> progressively**. Each maps onto a Cloudflare-native primitive, and one of the mappings is
> *better* than Monad's: Monad derives a session key and takes a Postgres advisory lock on it, while
> Avalon can address a **Durable Object** by that same key, whose single-threaded execution **is** the
> mutex — no lock table, no held-key rows, no reaper.
>
> Two things Avalon already does better than Monad are kept and become load-bearing: **idempotent
> tool replay** and **regional residency**.

## Contents

§0 Verified facts · §1 Problem · §2 Goals / Non-goals · §3 Design space · §4 Chosen architecture ·
§5 Data model · §6 Product surface · §7 Invariants · §8 Cost & concurrency · §9 Cutover ·
§10 Risks · §11 Decisions & open questions · §12 Testing · §13 Success metrics

---

## 0. Verified facts that shape this PRD

All verified against source on 2026-08-03 at Avalon `d99a127`.

1. **Avalon has no session, no compaction, and no memory.** The `sessions` table is auth refresh
   tokens (`0001_initial.sql:32`), unrelated. Context is assembled per run by `boundModelContext`
   (`apps/api/src/services/integrations.ts:686-710`): the system prompt is truncated to 60 % of
   `HARNESS_MAX_CONTEXT_BYTES` (200 KB default) and messages are taken **newest-first until the byte
   budget runs out**. History past the budget is *dropped*, never summarized, and the first message
   that does not fit is truncated **mid-content** before the loop breaks. Nothing carries across runs
   except the message list itself.
2. **The budget is bytes, not tokens, and tool definitions escape it entirely.** `modelTools` is
   built separately (`packages/agent-harness/src/index.ts:696-703`) and passed alongside. The
   measured payload is 65 tools / ~31 KB / ~8,600 tokens on **every** model call, resent up to
   `HARNESS_MAX_MODEL_ITERATIONS` (8) times per run — the largest fixed cost per call is the one
   thing not metered.
3. **The entire tool loop runs inside a single workflow step.**
   `step.do("run-authorized-harness-loop", …)` (`apps/api/src/workflows/workstream-loop.ts:78`)
   wraps `runWorkstreamHarness`. A Workflow step is the retry unit, so a failure at turn 7 of 8
   re-runs **all eight turns**. Avalon's idempotent tool replay is what currently keeps that from
   duplicating side effects — see fact 5.
4. **Run lineage exists and is unbounded.** `harness_runs.parent_harness_run_id`
   (`0001_initial.sql:288`) and a `launchHarness` that accepts a parent
   (`workstream-service.ts:627`), with no depth, no chain root, and no admission check anywhere.
   Only the elicitation-answer path passes a parent today (`workstream-service.ts:408`).
5. **Avalon has idempotent tool replay that Monad does not.** A stable invocation id from
   `(harnessRunId, turn, tool position)` (`stableHarnessToolCallId`, `index.ts:852`), a canonical
   input hash (`canonicalToolInputHash`, `index.ts:1111`), `record_before_execute` for
   non-idempotent writes, and an explicit `ambiguous` status for uncertain outcomes. It is already
   `workerd`-native (`crypto.subtle`, no Node crypto).
6. **Avalon is already two-region; Monad's federation is aspirational.** Separate D1 databases per
   region (`wrangler.global.jsonc`, `wrangler.eu.jsonc`) with RPC bridges. Monad's federation
   invariants ("never assume co-location", "no synchronous cross-cluster calls in request paths")
   are things Avalon already lives with.
7. **There is no concurrency control on harness runs.** Nothing prevents two runs on the same work
   stream at once. The only claim is the workflow's own `claim-harness-run` step, which checks a
   terminal status and is not a mutex.
8. **The platform cannot run Monad's admission model.** D1 has no advisory locks, no
   `SELECT … FOR UPDATE SKIP LOCKED`, and no `pg_cron`. Monad's claim-time admission
   (`queue.claim_jobs` taking `pg_try_advisory_xact_lock` per key, held counts derived from
   `claimed_holder_keys`) has no D1 translation. **Durable Objects are the only true serialization
   primitive available.**
9. **`@juno-ai/bind@6.0.0` is published and `workerd`-clean.** Zero runtime `openai` imports (types
   only), and the only platform APIs used are `AbortSignal.any` and `setTimeout`. `6.0.0` is the
   first release carrying all six `ChainRule` kinds and `parseToolCallArguments`.

---

## 1. Problem & motivation

### 1.1 Avalon's agent has no memory of itself

Every run rebuilds its context from the message list and throws away whatever does not fit in
200 KB, newest-first. There is no summary of what was dropped, no state that survives a run, and no
distinction between "this conversation" and "this run." A long work stream therefore does not get
*compacted*, it gets *amputated* — and silently, mid-message.

This is the difference in kind between the two systems, and it is invisible until a work stream gets
long. Monad's session + compaction + memory model exists because the same product promise —
*durable context people and an agent share* — cannot be kept by re-reading the last 200 KB.

### 1.2 Admission is a call site, not a stage

Two code paths start runs (`launchHarness`, the activity consumer) and neither validates, rate
limits, dedupes, or bounds anything. Monad learned this the expensive way: it ended up with the same
depth comparison hand-rolled at *three* entry points, free to drift, caught only by a review. The
fix — one pipeline every entry point calls — is cheaper to adopt now, at two entry points, than
later at four.

### 1.3 The graph can already loop, and it is unbounded

An agent's connector write produces a provider webhook, which becomes an activity, which matches a
`connector_activity` automation, which starts a run. `github.issues.create` → `github.issue.opened`
is a closed cycle, as is `linear.create_comment`, `notion.create_comment`, and
`google.gmail.send`. Nothing counts hops. The only guard is content-hash dedup, which stops the
*same* activity twice and says nothing about a new one the agent just caused.

The cheap mitigation does not work: Avalon writes through the **user's** OAuth grant, so the agent's
comment is authored by the user's provider account and is byte-identical in `actor_json` to the user
typing it. Suppressing by actor suppresses genuine human activity.

### 1.4 Why now

The tools payload is 2× the threshold past which Monad measured tool-selection accuracy degrading,
and it is unmetered. Runs are unbounded in count. Context is amputated rather than compacted. Each
of these is individually survivable and they compound: a long-running workspace with several
connected automations is the configuration where all three bite at once, and that is the
configuration the product is sold on.

---

## 2. Goals / Non-goals

**Goals**

- G1. The **session**, not the run, becomes the unit of continuity: durable, keyed, compacted.
- G2. One **activation pipeline** every run-start path goes through — validate, rate limit, chain
  safety, dedupe, concurrency, dispatch.
- G3. **Bounded orchestration**: lineage carried, depth counted, admission before creation, using
  `admitChildRun` from `@juno-ai/bind/run` as the single decider.
- G4. **Progressive tool disclosure** so a call carries ~6 plugin descriptions instead of 65 tool
  schemas.
- G5. **Per-turn durability**: a run that fails at turn 7 resumes at turn 7.
- G6. Every primitive that exists in `@juno-ai/bind@6.0.0` is consumed from it, not reimplemented.

**Non-goals**

- NG1. **Porting Monad's job system.** Cloudflare Workflows and Queues already are one. §3/A.
- NG2. **Porting Loom.** Avalon's `activities` pipeline is the same idea with less machinery, and it
  is sufficient. Adopting a CDC ledger would be adopting Monad's *constraints*, not its design.
- NG3. **Roles, graduation, dreaming, GEPA.** Monad product decisions about a multi-agent roster
  Avalon does not have.
- NG4. **A second runtime.** Whatever is chosen applies to every run. §3/D.
- NG5. **Changing the connector or automation model.** This PRD is about what happens *after* a
  trigger fires.

---

## 3. First-principles design space

### 3.1 Design A — literal port of Monad's runtime onto D1

Recreate `queue.jobs`, claim-time admission, `claimed_holder_keys`, the blocked/ready tables, and
the stale-run reaper as D1 tables and a Worker cron.

**Rejected, and not close.** Monad's admission correctness rests on
`pg_try_advisory_xact_lock(hashtext(key))` serializing the check-and-insert of competing claims. D1
has no advisory locks and no `SKIP LOCKED`; the best available substitute is an optimistic
`UPDATE … WHERE status='pending'` and a retry, which over-admits under contention — exactly the
class of bug Monad's model was built to eliminate. It would also mean running a hand-rolled queue
*beside* Cloudflare Queues and Workflows, paying for both.

### 3.2 Design B — adopt the model, map each primitive to its Cloudflare-native equivalent ✅

Keep Monad's four ideas. For each mechanism, use the platform primitive that already provides that
guarantee, rather than reproducing Monad's implementation.

The pivotal mapping: **Monad derives a session key and takes a lock on it; Avalon addresses a
Durable Object by that key.** A DO is single-threaded by construction, so the mutex is the object's
existence. There is no lock table, no held-key rows, no release path, and no reaper — the three
places Monad's earlier counting-semaphore design leaked.

**Chosen.** It gets Monad's guarantees with less machinery than Monad has, because Cloudflare
supplies natively what Monad had to build.

### 3.3 Design C — primitives only (the incremental plan)

Adopt `@juno-ai/bind`'s watchdog, deadline, sanitizer, pooling, and chain rules; leave Avalon's
architecture alone. This is [`BIND_MIGRATION.md`](../../BIND_MIGRATION.md).

**Rejected as the answer to this question, kept as the fallback.** It fixes real bugs and is a
fraction of the cost, but it does not touch §1.1 (no session) or §1.4 (unmetered tools) because
those are not primitive gaps — they are model gaps. If Design B does not get funded, C is what
should happen instead, and every phase of C is a subset of B.

### 3.4 Design D — two runtimes: Monad's model for automations, current path for interactive

**Rejected.** The interactive path is where sessions matter most (a person is having a
conversation), and two runtimes is how the duplicate-decider problem in §1.2 becomes permanent.

### 3.5 Evaluation

| | A: literal port | **B: model + native mapping** | C: primitives only | D: two runtimes |
|---|---|---|---|---|
| Session continuity (§1.1) | ✅ | ✅ | ❌ | partial |
| Single admission stage (§1.2) | ✅ | ✅ | partial | ❌ |
| Bounded graph (§1.3) | ✅ | ✅ | ✅ | partial |
| Tool disclosure (§1.4) | — | ✅ | ❌ | partial |
| Correct under contention | ❌ (no advisory locks) | ✅ (DO) | n/a | ❌ |
| Fights the platform | severe | none | none | moderate |
| Cost | very high | high | low | high |

---

## 4. Chosen architecture (Design B)

### 4.1 The mapping table

| Monad concept | Monad mechanism | Avalon mechanism |
|---|---|---|
| Session key mutex | `pg_try_advisory_xact_lock` at claim + `claimed_holder_keys` | **Durable Object addressed by the session key.** Single-threaded execution *is* the mutex. `held ⟺ the DO has a live run`; no lock table, no release, no reaper |
| Durable run record | `agent_runs` row | `harness_runs` row (exists) + workflow instance id |
| The loop | one long-lived worker process | Workflow with **one `step.do` per model turn** (§4.3) |
| Run deadline | in-process `AbortController`, 60 min | Workflow-level budget checked per turn + `createRunDeadline` inside each turn step for the LLM call |
| Streaming stall | two-phase watchdog in `callLLM` | `createStreamWatchdog` (`bind/completion`), answer-gated |
| Activation | `server/agents/activation/pipeline.ts` | one shared module both entry points call (§4.4) |
| Chain admission | `admitChildRun` + a measurement layer | identical — `admitChildRun` from `bind/run`, D1 counts (§4.5) |
| Chain lineage | 3 columns on `agent_runs` | 3 columns on `harness_runs` + **provenance carry** (§4.6) |
| Session + compaction | `agent_sessions.compaction_summary` | `harness_sessions` (§4.2) |
| Recurring work | `pg_cron` | Cloudflare Cron Triggers (already used by `connector-poll`) |
| Fact ledger → activation | Loom CDC | the existing `activities` pipeline (NG2) |
| Stale run reaper | `pg_cron` sweep | the Workflow's own terminal state + a cron sweep for orphans |
| Progressive disclosure | `tool-discovery__load_plugin` | same, over connector groups (§4.7) |
| Tool schema safety | `sanitizeToolSchema` | identical — from `bind/tools` |

### 4.2 Sessions (G1)

A new `harness_sessions` table keyed by a derived session key, mirroring Monad's derivation:

| Key | When | Concurrency |
|---|---|---|
| `workstream:{workstreamId}` | ad-hoc and human-triggered runs | one run per work stream |
| `automation:{subscriptionId}:{workstreamId}` | automation-triggered runs | one per subscription per stream |
| `child:{parentRunId}` | child runs (§4.5) | one per child |

The session holds the running transcript, a `compaction_summary`, and the provider's last real token
counts. **Compaction replaces truncation**: when the session's provider-reported token count crosses
a fraction of the model's real context window, older turns are summarized by an LLM call into
`compaction_summary` and the recent tail is preserved.

Two details worth taking verbatim from Monad because both were learned from failures:

- **Compact on real token counts, never a byte or character estimate.** Avalon's current 200 KB byte
  budget is not a proxy for the model's window; it is a different quantity that happens to have
  similar units.
- **Flush to memory before compacting.** A silent turn that writes observations to durable storage
  before the summary discards them, or the compaction is lossy in exactly the way that matters.

### 4.3 One workflow step per model turn (G5)

Today the whole loop is one step, so a retry re-runs every turn (fact 3). Restructure to:

```
step.do("admit")            → activation pipeline decision (§4.4)
step.do("turn-1")           → build context, one model call, run its tool batch, persist session
step.do("turn-2")           → …
step.do("finalize")         → terminal status, events, billing
```

**This is only safe because Avalon already has idempotent tool replay** (fact 5). A retried turn
step re-derives the same `stableHarnessToolCallId` for each call, finds the completed invocation,
and replays its recorded output instead of re-executing the write. That machinery exists and is
currently load-*bearing-by-accident*; under per-turn steps it becomes the explicit contract that
makes the restructure sound. **Monad has no equivalent and would want one** — see §11/Q4.

The wall-clock budget moves from an in-process `AbortController` to a workflow-level deadline
checked at each turn boundary, with `createRunDeadline` still owning the LLM call *inside* a step so
a stalled provider is torn down rather than merely abandoned.

### 4.4 One activation pipeline (G2)

A single module — `apps/api/src/services/activation/pipeline.ts` — that every run-start path calls,
in Monad's order:

1. **Validate** the signal shape (zod, both sides).
2. **Workspace rate limit** — `tenant_rate`, depth-0 only, fails **open**.
3. **Chain safety** — `admitChildRun` over the rules in §4.5.
4. **Dedupe** on a stable idempotency key.
5. **Derive the session key** (§4.2) and therefore the Durable Object id.
6. **Dispatch** — the DO admits or refuses, then starts the Workflow.

`launchHarness` and the activity consumer become thin callers. Nothing else may start a run.

### 4.5 Bounded orchestration (G3)

`admitChildRun` from `@juno-ai/bind/run` is the **only** decider; a measurement module runs the D1
counts and hands it a `ChainRule[]`. Rules in evaluation order — first refusal wins, so the order
chooses which reason a person sees:

| Rule | Measurement | Refuses when |
|---|---|---|
| `depth` (omit at depth 0) | `chain_depth - 1` | the chain has gone as many hops as allowed |
| `pair_seen` | a prior run in this chain with the same `(automation, workstream)` | this pair already ran once in this chain |
| `chain_budget` | `COUNT(*)` over `chain_root_run_id` | the chain spent its run budget |
| `pair_cooldown` | `now −` the **most recent** matching run | the pair ran within the cooldown |
| `tenant_rate` | workspace runs in a rolling window | depth-0 burst ceiling |

**`retryable` is worth more here than in Monad.** Monad drops it — nothing downstream waits.
Cloudflare Queues retry with a delay and the activity consumer already uses
`message.retry({ delaySeconds: 30 })` (`activity-consumer.ts:199`), so:

- `retryable: true` (`pair_cooldown`, `tenant_rate`, `tenant_ceiling`) → `message.retry(…)`
- `retryable: false` (`depth`, `chain_budget`, `pair_seen`) → ack and record

Retrying a non-retryable refusal costs a queue slot forever and can never succeed.

**Omit-vs-sentinel.** A measurement that came back *broken* (`NaN`, negative) **refuses**; a
measurement the host *could not take at all* (the D1 query threw) is expressed by **omitting the
rule**, which admits. Passing `NaN` for "unknown" turns a transient D1 blip into every agent in the
workspace refusing to run. Decide it in the `catch` at each call site.

### 4.6 Provenance carry — the one place Monad's design does not transfer

Monad's spawn sites know their parent. Avalon's cycle leaves the process, goes through a third
party, and comes back with the causal link gone: the activity knows which provider resource changed
and nothing knows which run changed it.

So a connector write records `(provider, provider_resource_id) → harness_run_id`, and the activity
consumer resolves that mapping to find the parent before starting a run.
`tool_invocations.provider_operation_id` (`0001_initial.sql:310`) is the existing hook.

**This is load-bearing: §4.5's admission checks are decoration until provenance works** — without
it every automation-started run looks like a root and depth reads 0 forever. It is also the piece
most likely to be *partially* correct: a provider that reports a different resource id on the
webhook than it returned on the write breaks that connector's join **silently**. Build it connector
by connector, one test per connector, and treat an unresolvable parent as depth 0 **plus a metric**,
never an error.

### 4.7 Progressive tool disclosure (G4)

Ship the built-in `avalon.*` tools plus a compact catalog of connector *groups* (`github`, `notion`,
`linear`, `google.calendar`, …) with descriptions, and a `load_tools` call that activates one group
for the rest of the run. Measured effect on the current payload: **65 tools / ~31 KB → ~6 tools plus
a ~1 KB catalog**, with `github`'s 18 tools / 12.7 KB loaded only when the model asks.

Two rules from Monad, both non-obvious:

- **Bring tool definitions inside the context budget.** They are the largest fixed per-call payload
  and today they are the only thing unmetered (fact 2).
- **Re-render the system prompt as a pure function of run state on every activation**, rather than
  mutating it in place, so unchanged inputs re-render byte-identically and the provider's implicit
  prefix cache survives.

### 4.8 What Avalon keeps because it is better

1. **Idempotent tool replay** (§4.3). Kept, and promoted to a stated contract.
2. **Regional residency.** Already shipped, and stricter than Monad's aspiration.
3. **`halt: "needs_input"`.** Monad's two-kind `suspend` distinguishes `wake` from `answer`; Avalon
   needs only `wake` today, and its elicitation ends the run cleanly with paired transcripts. Adopt
   Monad's *invariants* (never send an unpaired tool call; at most one open suspend; never compact a
   pending suspend) without adopting the second resume kind.

---

## 5. Data model

One migration per phase; `0025` is the next free prefix. SQLite has no `ADD COLUMN IF NOT EXISTS`,
so guard each `ALTER` on `pragma_table_info` or rely on the runner's applied-migration ledger.

```sql
-- Phase 1: lineage
ALTER TABLE harness_runs ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE harness_runs ADD COLUMN chain_root_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL;
ALTER TABLE harness_runs ADD COLUMN session_key TEXT;
CREATE INDEX IF NOT EXISTS harness_runs_chain_idx ON harness_runs(chain_root_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS harness_runs_workspace_created_idx ON harness_runs(workspace_id, created_at DESC);

-- Phase 2: sessions
CREATE TABLE IF NOT EXISTS harness_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  transcript_json TEXT NOT NULL DEFAULT '[]',
  compaction_summary TEXT,
  last_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  last_output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, session_key)
);

-- Phase 3: provenance
CREATE TABLE IF NOT EXISTS provider_write_provenance (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider, provider_resource_id)
);
```

`transcript_json` in D1 has a row-size ceiling; if a compacted transcript approaches it, the
transcript moves to R2 with the row holding a pointer — the same shape `tool_invocations` already
uses for `output_ref`. Decide this from measurement, not up front (§11/Q2).

---

## 6. Product surface changes

- **Refusals become visible and explain themselves.** A refused automation shows the activity, skips
  the run, and states which bound fired and whether waiting helps. Today it would silently not
  happen.
- **Long work streams stop losing their beginning.** Compaction replaces truncation, so the agent
  can refer to what happened earlier in a stream instead of behaving as though it never did.
- **Tool loading is observable** in the run panel — the model asking for `github` is a visible step,
  which is also the debugging surface for "why didn't it use the right tool."
- **Run history gains chain shape**: a run shows its parent and its depth, so a person can see that
  three runs were one cascade rather than three coincidences.
- **No change to how automations are authored.** §2/NG5.

---

## 7. Invariants

1. **Admit before create.** No `INSERT INTO harness_runs` and no `WORKFLOW.create` precedes the
   pipeline decision. A chain bounded once its runs exist is not bounded, it is billed.
2. **One decider.** Every bound is evaluated by `admitChildRun`. No hand-rolled comparison anywhere,
   at any entry point, ever.
3. **The Durable Object is the only mutex.** No advisory-lock emulation, no `status='claimed'`
   optimistic loop. If something needs serializing, it is addressed by a DO id.
4. **Null means me.** A root run's `chain_root_run_id` and `parent_harness_run_id` are both `NULL`;
   read the root as `chain_root_run_id ?? id`. Adopting the *parent's* id as the root at every level
   makes each generation its own chain and every per-chain bound silently never fires.
5. **A chain never spans regions.** Global and EU have separate D1s; a chain root id from one is
   meaningless in the other. A cross-region cause starts a new chain at depth 0, deliberately.
6. **A turn step is idempotent or it does not retry.** Per-turn steps are only sound because tool
   replay is; any new side effect inside a turn step must go through the same
   `(stable id, input hash)` path.
7. **Omit, never sentinel.** An unmeasurable bound is an omitted rule. `NaN` means broken, not
   unknown.
8. **Cooldown queries are ordered.** `ORDER BY created_at DESC, id DESC` — the moment an elapsed
   span is derived from a row, an arbitrary match errs toward *admitting*.
9. **One clock sample per admission.** Two `Date.now()` calls let a row inside the window evaluate
   as outside it.
10. **Refusal strings reach people.** Branch on `rule`, never on the prose, and assume a human reads
    the reason.

---

## 8. Cost & concurrency

- **Token cost falls before it rises.** Progressive disclosure removes ~7,600 tokens per call
  (~8,600 → ~1,000) across up to 8 calls per run. Compaction adds one LLM call per compaction event.
  Net expected: strongly negative for long streams, roughly neutral for short ones.
- **Run count falls.** The §4.5 bounds cap a cascade that today has no ceiling.
- **Concurrency becomes explicit.** One run per session key, enforced by the DO. Today two runs on
  one work stream can interleave writes to the same transcript.
- **D1 read volume rises** — admission adds up to four counts per run start. All are indexed
  point/range queries on `(chain_root_run_id, created_at)` and `(workspace_id, created_at)`; the
  depth rule short-circuits before any query.

---

## 9. Cutover

Staged, not one PR. Each phase ships independently and is revertible; phases 1–3 are invisible to
users.

| # | Phase | Ships | Gate |
|---|---|---|---|
| 0 | **Measure** | nothing | chain-depth histogram + automation-run rates from production D1 (§12) |
| 1 | Lineage + `bind@6.0.0` | `0025` migration, `descendChain`/`rootChain` wired | every new run writes three consistent columns |
| 2 | Activation pipeline + admission | one module, both entry points | a synthetic 6-hop cascade stops at the configured depth |
| 3 | Provenance carry | per connector | a connector round-trip resolves its parent; unresolved → depth 0 + metric |
| 4 | Sessions + compaction | `harness_sessions`, compaction turn | a stream past the old byte budget retains its beginning |
| 5 | Per-turn workflow steps | restructured workflow | a killed run resumes at the failed turn without repeating writes |
| 6 | Progressive disclosure | catalog + `load_tools` | per-call tool payload < 2 KB; no regression in tool-selection evals |
| 7 | Workspace rate ceiling | `tenant_rate`, fail-open | a burst is capped; a D1 error does not stop the workspace |

**Phase 0 gates everything** — set every limit from Avalon's measured traffic, **not from Monad's**
(5 / 500 / 5 s / 100-per-30 s were tuned against a different workload).

**If only one phase is funded, do 4** (sessions + compaction). It is the only one addressing a
capability Avalon does not have at all, and phases 1–3 are the incremental plan
([`BIND_MIGRATION.md`](../../BIND_MIGRATION.md)) which stands on its own.

---

## 10. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Provenance is silently partial** (§4.6) — one connector's webhook id ≠ its write id, so that connector's chains all read depth 0 | One test per connector; emit a metric on every unresolved parent and alert on the rate, so "silently" is not available |
| R2 | **Per-turn steps expose a non-idempotent tool** that today hides behind whole-loop retry | Phase 5 follows phase 3; audit every write tool against the `(stable id, input hash)` path before restructuring, and treat `ambiguous` as a blocker not a warning |
| R3 | **DO-per-session-key adds a hop** to every run start and a new failure mode (DO unavailable) | The DO does admission only, not execution; a DO error fails the *start*, which is already a failure path, and the queue retry covers it |
| R4 | **Compaction loses something the user needed** | Memory-flush turn before compaction (§4.2); keep the pre-compaction transcript in R2 for a retention window so a bad summary is diagnosable |
| R5 | **Progressive disclosure regresses tool selection** — the model does not know to load the group | Gate phase 6 on an eval comparing selection accuracy before/after on real work streams; Monad's threshold (~30 tools) is evidence, not proof, for Avalon's prompt |
| R6 | **This is a quarter of work, not a sprint**, and stalls half-done | Phase ordering is strictly independent-first; every phase is shippable alone, and phases 1–3 alone equal the fallback plan |
| R7 | **`bind` releases are outside Avalon's control** — its version stamps the next major of the public mirror, so a major bump carries no breakage signal | Pin `6.0.0` exactly, never a caret; read the diff on every upgrade |

---

## 11. Decisions & open questions

**Decided**

- D1. **Durable Object per session key, not a lock table.** §3.2. The platform supplies the
  guarantee; emulating Postgres locks on D1 is the one design here that would be actively worse than
  what Avalon has.
- D2. **`admitChildRun` is the only decider**, from day one, at every entry point. §7/2.
- D3. **Keep Avalon's idempotent replay and elevate it to a contract** rather than adopting Monad's
  receipt table. §4.8.
- D4. **No Loom.** §2/NG2.
- D5. **Compaction on real provider token counts**, never bytes. §4.2.

**Open**

- Q1. **Do chains exist in production today?** Phase 0's histogram answers it. If the answer is "only
  elicitation answers", §1.3 is real but cold, and phases 1–3 become preventive work on a calmer
  schedule than phase 4.
- Q2. **Does a compacted transcript fit a D1 row?** Determines whether phase 4 needs R2 offload on
  day one or later. Measure against the longest existing work stream.
- Q3. **What is the right session key for an automation that spans work streams?** §4.2 assumes one
  stream per session. An automation that fans out to several needs either a key per stream (chosen
  provisionally) or a shared key that serializes them all.
- Q4. **Should idempotent replay flow back into `bind`?** It is `workerd`-native and clears bind's
  portability fence as-is, and Monad has no equivalent. Candidate contribution once phase 3 proves
  the shape.
- Q5. **Does progressive disclosure interact badly with automations** whose instructions name a
  capability the model must first load? May need the automation's `requiredCapabilities` to
  pre-activate groups.

---

## 12. Testing

**Phase 0 queries** (both executed against the real schema on 2026-08-03):

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

**Required tests**

- A synthetic cascade stops at the configured depth, and the refusal names the rule.
- A depth-0 run is admitted — the depth rule is *omitted*, not passed `parentDepth: -1`. (Monad
  shipped this bug and caught it only against a real database.)
- Two concurrent starts on one session key produce one run.
- A D1 error in a count omits that rule and **admits**; a `NaN` count **refuses**. Pin the
  distinction with a bound that would refuse any measured value.
- The cooldown query returns the most recent row when two are inside the window — assert on the
  measured span, not on which row, so the test cannot pass by timing luck.
- A killed run resumes at the failed turn and re-executes no completed write.
- A connector round-trip resolves its parent; a deliberately mismatched id yields depth 0 **and**
  increments the unresolved metric.
- A stream past the old 200 KB budget retains its opening after compaction.
- Tool-selection accuracy before/after progressive disclosure, on real work streams.
- A chain root id from the other region is never accepted (§7/5).

## 13. Success metrics

| Metric | Today | Target |
|---|---|---|
| Tool payload per model call | ~31 KB / ~8,600 tok | < 2 KB / < 600 tok |
| Context past the budget | dropped, unsummarized | compacted, 0 silent drops |
| Runs with a resolved parent (automation-started) | 0 % | > 90 %, unresolved alerting |
| Max observed chain depth | unbounded | ≤ configured, refusals visible |
| Concurrent runs per session key | unbounded | 1 |
| Wasted turns on a retried run | all turns | 0 completed turns |
