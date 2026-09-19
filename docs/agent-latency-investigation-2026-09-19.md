# Agent latency investigation — 2026-09-19

## Executive summary

A profiled production session reported a latency floor: `run_command` costing
1.8–2.4s for a trivial ripgrep, `read_file` 0.4–0.8s, time to first token 3–5s
on a large cached context, ~265s of tool wait inside one main substream, and a
57-second sandbox boot. This report checks each of those numbers against
production telemetry — the `avalon_agent_runs` and `avalon_terminal_operations`
Analytics Engine datasets, the `avalon.llm_inference` Iceberg ledger over R2
SQL, and the Worker structured logs that land in PostHog — and says where the
time actually goes.

**Every number in the report reproduced.** None of them was a misreading, and
none of them is a tail: they are medians. What the profile could not see is the
proportion, and the proportion inverts the intuition that the tool floor is the
problem:

- **Model time is 66.5% of run wall-clock; tool time is 29.8%** (2,046 runs with
  exact timing, 14 days). Halving every tool call in the product buys ~15% of a
  run. The tool floor is real and worth fixing, but it is the smaller half.
- **A trivial `run_command` pays six sequential Daytona round trips, and one of
  them — `process.session_logs` — is 1,214ms on its own**, 53% of the command's
  Daytona time. The other five together cost ~590ms.
- **The 57-second boot is an archived-sandbox restore, not a cold start.**
  Restores from `archived` are bimodal: p50 4.7s, p90 59.6s against a 60s
  timeout ceiling. A genuine cold create is now ~3.3s.
- **`sandbox_create` is failing 59% of the time** over 14 days, and 48 of 56
  attempts on 2026-09-18, all at the `provider_create` phase. This is a live
  production fault, not a latency finding, and it is the most urgent item here.
- **87% of all inference wall time is spent on a feature nothing renders.**
  `work_opportunity_admission` and `work_opportunity_ranking` are 76% of
  inference calls and 9.2 wall-hours of provider time per day, against the agent
  loop's 1.3. [`suggested-work.md`](suggested-work.md) already records that its
  last consumer went away on 2026-09-11 and that the producer was deliberately
  left running for someone to make the call on. This is the measurement for that
  decision.

Three instrumentation defects were found along the way, each of which hides part
of the answer from the next person who asks this question. They are listed under
[Instrumentation defects](#instrumentation-defects) and are the reason parts of
this investigation needed the Iceberg ledger rather than the event built to
answer it.

## Where a run's time goes

`avalon_agent_runs`, 14 days to 2026-09-18, 2,046 runs carrying exact
turn/model/tool timing (`double11 = 1`):

| | p50 | p95 |
| --- | --- | --- |
| Run wall-clock | 86.1s | 262.7s |
| Model time | 55.6s | — |
| Tool time | 19.8s | — |

Summed across the cohort: 216.0M ms total, 143.6M ms model (66.5%), 64.4M ms
tool (29.8%). The residual ~3.7% is harness work between the two.

The profiled session's ~265s of tool wait is a p95 run, not an outlier — p95 run
wall-clock is 262.7s.

Per-model, over the same cohort:

| Model | Runs | Model ms/turn | Tool ms/call | Model share | Tool share |
| --- | --- | --- | --- | --- | --- |
| `x-ai/grok-4.6` | 1,037 | 24,598 | 5,363 | 68.1% | 24.3% |
| `openai/gpt-5.6-terra` | 422 | 9,311 | 4,832 | 65.2% | 39.3% |
| `google/gemini-3.8-flash` | 312 | 15,458 | 5,124 | 62.7% | 27.8% |
| `openai/gpt-5.6-sol` | 15 | 9,241 | 3,878 | 60.2% | 40.0% |

`grok-4.6` carries half the runs at 2.6x `gpt-5.6-terra`'s per-turn model time.
Routing is the single largest lever on run latency that does not require
changing any mechanism.

## The tool floor

Per-tool, from `terminal_tool_finished` in Worker logs, 7 days:

| Tool | Calls | p50 | p95 |
| --- | --- | --- | --- |
| `run_command` | 703 | 2,289ms | 18,019ms |
| `read_file` | 273 | 191ms | 476ms |
| `edit_file` | 188 | 440ms | 1,038ms |
| `write_file` | 63 | 298ms | 5,226ms |
| `checkout_repository` | 106 | 6,512ms | 19,998ms |
| `publish_resource` | 71 | 7,488ms | 14,938ms |
| `apply_patch` | 16 | 51ms | 302ms |

Both reported figures reproduce: `run_command` p50 2,289ms, `read_file` p50
191ms with p95 476ms (the profile's 0.4–0.8s is `read_file`'s tail).

### What `run_command` actually pays for

From `terminal_provider_request_finished`, 7 days, with per-harness-run
frequency. One `run_command` is one Daytona session lifecycle:

| Daytona operation | Per run | p50 | Cost per command |
| --- | --- | --- | --- |
| `process.session_get` | 6.13 | 68ms | 68ms |
| `process.session_create` | 6.11 | 74ms | 74ms |
| `process.session_submit` | 6.11 | 74ms | 74ms |
| `process.session_poll` | 16.47 | 73ms | ~197ms (2.7 polls) |
| **`process.session_logs`** | 6.08 | **1,214ms** | **1,214ms** |
| `process.session_delete` | 6.09 | 177ms | 177ms |

That is ~1,804ms of provider round trips against an observed 2,289ms p50. The
remaining ~485ms is Rally-side work plus `instructions.probe`, which runs 6.93
times per harness run at 123ms.

**`session_logs` is 53% of the Daytona time for a command whose output is a few
lines of ripgrep.** Its p95 is 1,438ms against a p50 of 1,214ms — a flat floor,
not a tail, so it is a fixed cost of the call rather than a function of output
size. It is the highest-value single target in the tool path, and nothing else
in the breakdown is close.

`read_file` by contrast is already minimal: one `process.execute_utility` with
`file.read_page` at 150ms p50, plus ~40ms of Rally work. There is no round trip
to remove.

## Sandbox boot

`avalon_terminal_operations`, 14 days:

| Operation | Source state | n | p50 | p90 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- |
| `sandbox_create` (completed) | absent | 85 | 1,483ms | — | 5,045ms | 17,092ms |
| `sandbox_bootstrap` | running | 157 | 1,773ms | — | 2,354ms | 8,343ms |
| `sandbox_start` | stopped | 59 | 1,160ms | 6,550ms | 6,651ms | 7,224ms |
| `sandbox_start` | **archived** | 23 | 4,688ms | **59,577ms** | 60,050ms | 60,080ms |

A cold create is `sandbox_create` + `sandbox_bootstrap` ≈ **3.3s p50**. A warm
restore from `stopped` (the 5-minute warm-stop tier) is 1.2s.

**The 57-second boot is the `archived` restore.** Its distribution is bimodal —
p50 4.7s, p90 59.6s — and the upper mode sits against a 60-second ceiling that
two observations hit exactly (60,050ms and 60,080ms, both recorded `failed` at
the `start` phase). Roughly one archived restore in five costs a minute or
fails. Archiving happens at 60 minutes, so this is the cost of returning to a
work stream after an hour away, and it is the worst single latency event in the
product.

`terminal-workspaces.md` currently states an "~18s median cold start". That is
stale for the common path: with the owned snapshot the create-plus-bootstrap
median is 3.3s. It remains roughly right only for a run that also checks out a
repository, where `repository.bootstrap` adds 9,090ms p50 — about 12.4s
end-to-end. The document should be corrected to separate the two.

## Time to first token

From `avalon.llm_inference`, 4 days, successful attempts, separated by call
source. This separation matters: the agent loop is a minority of inference
calls, and aggregate per-model figures are dominated by background work.

| Source | Calls | latency p50 | latency p95 | TTFT p50 | TTFT p95 |
| --- | --- | --- | --- | --- | --- |
| `work_opportunity_admission` | 5,299 | 16,644ms | 26,939ms | n/a | n/a |
| `work_opportunity_ranking` | 2,953 | 15,496ms | 20,970ms | n/a | n/a |
| **`workstream`** (the agent loop) | 2,407 | 6,129ms | 18,171ms | **4,366ms** | **10,242ms** |
| `workstream_naming` | 69 | 2,529ms | 4,465ms | n/a | n/a |
| `addressing_classifier` | 54 | 359ms | 5,459ms | n/a | n/a |

**The reported 3–5s TTFT is confirmed: p50 4,366ms, p95 10,242ms.** It is
measured at an average context of 92,516 tokens with an **83% cache hit rate**,
so the profile's "fully cached" reading was substantially right. Caching is
working on the agent loop — when it hits, it covers 99% of the prefix (p50
cached/input ratio 0.99).

TTFT is therefore not a cache-miss problem on the agent loop. It is the cost of
prefilling the ~16K uncached tail plus provider queue and OpenRouter routing
overhead, and it is not addressable by changing how the prompt is assembled.

### The cache does expire between turns

Consecutive `gpt-5.6-terra` calls in the same substream, bucketed by the gap
between them:

| Gap since previous call | Pairs | Calls with any cache hit |
| --- | --- | --- |
| < 60s | 3,572 | 24% |
| 1–5 min | 157 | 11% |
| 5–10 min | 78 | **0%** |
| 10–30 min | 58 | 2% |
| > 30 min | 43 | **0%** |

There is a hard cliff at five minutes: past it, the provider-side cache is
reliably gone. This couples the two halves of the latency floor — a slow tool
call that pushes the inter-turn gap past five minutes makes the *next* turn pay
a full prefill. A Terminal call is documented as usually finishing within a
minute at p95 but able to take 3–5 minutes, which is exactly the range that
straddles this cliff.

The low hit rate in the sub-60s bucket is not the agent loop failing to cache;
it is the bucket being dominated by the one-shot structured calls below, which
have no reusable prefix by construction.

## The background inference load

| Source | Calls/day | Uncached input/day | Output/day | Provider wall-hours/day |
| --- | --- | --- | --- | --- |
| `work_opportunity_admission` | 1,325 | 12.4M tokens | 1.88M tokens | 6.0 |
| `work_opportunity_ranking` | 738 | 10.4M tokens | 0.95M tokens | 3.2 |
| `workstream` (agent loop) | 602 | 9.5M tokens | 0.17M tokens | 1.3 |

Both `work_opportunity_*` sources run on `openai/gpt-5.6-terra` through
OpenRouter at ~16s per call, with a ~1% cache hit rate by construction — each
call carries a different member's context, so there is no shared prefix to
cache. Together they are **87% of inference wall time, 76% of inference calls,
and 16x the agent loop's daily output tokens**.

[`suggested-work.md`](suggested-work.md) states plainly that nothing renders
these suggestions: the new-chat screen dropped its cards and the macOS status
menu dropped its Suggestions section on 2026-09-11. Its changelog records that
switching the producer off was *considered and rejected* in that change, on the
grounds that it is a product decision rather than a detail of a menu edit, and
left the call to be made deliberately. This report supplies the number that
decision needed and takes no position on the product question.

It is not established here that this load slows the agent loop. The two run on
different calls and no queueing evidence was gathered. The finding is cost and
capacity, not latency — but it is the largest single item the investigation
found, by a wide margin.

## Instrumentation defects

Each of these hides part of the answer to the question this report was asked.
Per [the naming rule](naming-a-schema-failure.md) and the flaky-test standard,
a diagnostic that reports a generic or empty value on a path that had the reason
in hand is a defect to fix in the change that finds it.

### `terminal_tool_finished` reports zero provider time on every call

`provider_duration_ms`, `provider_request_count`, `provider_poll_count`,
`provider_operation_count` and `provider_bytes` are **0 on 100% of rows**, and
`rally_duration_ms` consequently equals `duration_ms` — the event asserts that
all of `run_command`'s 2,289ms is Rally-side work, when the provider breakdown
above shows ~1,804ms of it is Daytona. Correspondingly, `tool_name`,
`tool_call_id` and `tool_invocation_id` are **absent from 100% of**
`terminal_provider_request_finished` **rows**, so no provider request can be
attributed to the tool that caused it.

The cause is a lost async context across a Worker boundary.
`apps/api/src/services/terminal/tracing.ts` accumulates into an
`AsyncLocalStorage` store, and `apps/api/src/services/terminal/plugin.ts` runs
each tool executor inside `withTerminalToolTrace`. But the provider is a
*separate Worker*: `createTerminalProviderRpcClient` passes the instrumentation
object to `binding.createSession(configuration, instrumentation)`
(`provider-rpc-client.ts:65`), and `TerminalProviderWorker.createSession`
(`terminal-provider-worker.ts:180`) is a `WorkerEntrypoint` in
`avalon-terminal-global`. When that remote Worker invokes `observeRequest`, it
re-enters the API Worker in a fresh async context, so
`terminalToolTraceStorage.getStore()` returns `undefined` and
`recordTerminalProviderRequest` returns early.

`acquisition_duration_ms` and `acquisition_cache_hit` *are* populated, which
confirms the diagnosis rather than contradicting it: `recordTerminalAcquisition`
is called locally, inside the trace, and works. Only the callbacks that cross
the RPC boundary lose the store.

The fix is to stop relying on ambient context across that boundary and pass the
tool identity explicitly into the session or the per-call callbacks, so the
remote Worker returns the measurement already correlated. This is the event
`terminal-workspaces.md` describes as making "Rally-side work visible when
Daytona calls are fast"; it currently cannot do that.

### Cost is not recorded for OpenRouter-routed inference

In `avalon.llm_inference`, `cost_microusd` averages 0 on every OpenRouter-routed
source, including all 8,252 `work_opportunity_*` calls and the 1,903
`gpt-5.6-terra` agent-loop calls, while Azure-routed calls carry real values
(`gpt-5.6-sol` 288,461 µUSD/call; `grok-4.6` 745,769 µUSD/call). The $149.71
recorded over the 4-day window is almost exactly the 482 Azure `sol` calls plus
14 Azure `grok` calls — the entire OpenRouter spend, which is the large majority
of calls, is invisible in the ledger.

This is why the background-load section above is denominated in tokens and
provider wall time rather than dollars: the ledger cannot currently answer the
cost question, and guessing a price per token is not a measurement.

### The runbook's lakehouse query names a table that does not exist

[`runbook.md`](runbook.md) documents the R2 SQL recipe against
`rally.llm_inference`. The namespace in `config/inference-lakehouse.json` is
`avalon`, and the query fails with `iceberg table not found
"rally.llm_inference"`. This is a rebrand artifact — per
[`rally-rebrand-inventory.md`](rally-rebrand-inventory.md) the infrastructure
identifiers were deliberately not renamed, and the runbook prose was renamed
past them. Correct it to `avalon.llm_inference`.

## The open production fault

`sandbox_create` over 14 days: **122 failed against 85 completed**, every
failure at the `provider_create` phase, across both the `rally-terminal-1` and
`rally-terminal-20260914-0610` snapshots. Failures are fast — 124ms p50 against
1,483ms for a success — so the provider is rejecting the request rather than
timing out.

Daily, the rate is worsening:

| Day | Completed | Failed |
| --- | --- | --- |
| 2026-09-18 | 8 | **48** |
| 2026-09-17 | 10 | 17 |
| 2026-09-16 | 12 | 11 |
| 2026-09-15 | 17 | 18 |
| 2026-09-14 | 6 | 10 |

This is not a latency finding and it is the most urgent item in this report. A
fast rejection at `provider_create` is the shape of a quota or capacity refusal
from Daytona rather than a Rally defect, but that is a hypothesis: the failure
reason is not in the Analytics Engine dataset, which carries only the phase.
Diagnosing it needs the provider's error body, which is the next step and is out
of this report's scope.

## What to do, in order

1. **Diagnose the `sandbox_create` failures.** 86% of creates failed on the most
   recent day. Nothing else here matters if a sandbox cannot be created.
2. **Fix the lost trace across the provider Worker boundary.** Every other tool
   latency question is unanswerable until `terminal_tool_finished` can attribute
   its own time, and the fix is small.
3. **Attack `process.session_logs`.** 1,214ms p50, flat, 53% of a trivial
   command's provider time. Whether it can be folded into the poll that already
   reports completion, or served from the submit response, is a Daytona API
   question rather than a Rally one — but it is the single biggest item in the
   tool path.
4. **Make the archived restore's 60-second mode visible or avoidable.** One
   restore in five costs a minute. Options range from extending the 60-minute
   archive threshold to warming on work-stream open; both are cheap to reverse,
   and per [the limits rule](adding-security-defensive-and-other-limits.md) the
   threshold is the team's number to set.
5. **Decide the `work_opportunity_*` producer question.** 87% of inference wall
   time for a feature with no consumer. `suggested-work.md` left this call open
   deliberately; this is the measurement it was waiting for.
6. **Put model routing on the table.** `grok-4.6` carries half of runs at 2.6x
   `gpt-5.6-terra`'s per-turn model time, and model time is two thirds of a run.

Items 2, 3 and 4 are the tool floor the profile measured. Items 5 and 6 are
larger, and neither is visible from inside a single session.

## Method

Everything above is reproducible without privileged access beyond the deployment
credentials.

- **`avalon_agent_runs` and `avalon_terminal_operations`** (Analytics Engine SQL
  API, `POST /accounts/{id}/analytics_engine/sql`). Column meanings are the
  positional maps in `apps/api/src/observability/harness-run-observability.ts`
  and `apps/api/src/observability/terminal-platform-observability.ts`; the API
  supports `quantileExactWeighted(p)(col, _sample_interval)` but not
  `quantileExact` or `nullIf`. `pnpm terminal:analytics -- --days 7` wraps the
  terminal half.
- **`terminal_tool_finished` / `terminal_provider_request_finished`** are Worker
  structured logs. `apps/api/wrangler.global.jsonc` routes Workers Logs to the
  `posthog-logs` destination, so **the Cloudflare observability API returns
  nothing for them** — query PostHog's `logs` table instead. The structured
  fields live in `body` as JSON, not in `attributes`, so they need
  `JSONExtractString(body, 'event')` rather than an attribute filter.
- **`avalon.llm_inference`** over the R2 SQL API at
  `api.sql.cloudflarestorage.com/api/v1/accounts/{id}/r2-sql/query/avalon-global-inference-lakehouse`.
  It supports `GROUP BY` and aggregates. Note the namespace correction above.

[`production-error-investigation.md`](production-error-investigation.md) is the
general handbook for this kind of work and was followed here.
