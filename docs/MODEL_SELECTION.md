# Model selection

Which model holds each OpenRouter slot, and the evidence for it. The slots
themselves are defined in `apps/api/wrangler.global.jsonc` and
`apps/api/wrangler.eu.jsonc`; how to reproduce a comparison is in
[`AGENT_HARNESS.md`](AGENT_HARNESS.md#comparing-candidate-models).

## Current configuration

Both regions are configured identically:

| Slot | Variable | Model |
| --- | --- | --- |
| Primary | `OPENROUTER_PRIMARY_MODEL` | `google/gemini-3.6-flash` |
| Fallback | `OPENROUTER_FALLBACK_MODELS` | `x-ai/grok-4.3` |
| Classifier | `OPENROUTER_CLASSIFIER_MODEL` | `google/gemini-2.5-flash-lite` |
| Structured | `OPENROUTER_STRUCTURED_MODEL` | `google/gemini-2.5-flash-lite` |
| Automation | `OPENROUTER_AUTOMATION_MODEL` | `x-ai/grok-4.5` |

## Recommendation

**Swap the primary and fallback slots: `x-ai/grok-4.3` primary,
`google/gemini-3.6-flash` fallback.** The promotion of `gemini-3.6-flash` to
primary was made without evidence, and the evidence now says it was the wrong
direction for that slot specifically.

**Move the classifier and structured slots off `gemini-2.5-flash-lite` to
`gemini-3.6-flash`.** This is the larger and more urgent finding. The model on
those slots today fails half the routing suite and is the direct cause of a
user-visible defect already visible in production.

These two changes are independent, and the second matters more than the first.

## Evidence

Run of 2026-08-10: 44 cases, three models, five repeats, 660 requests, through
the product's own prompts and schemas. Cases are derived from the Global
production database; the derivation is described in
[`AGENT_HARNESS.md`](AGENT_HARNESS.md#comparing-candidate-models).

| Suite | Slot it models | `gemini-3.6-flash` | `grok-4.3` | `gemini-2.5-flash-lite` |
| --- | --- | --- | --- | --- |
| addressing | classifier | **52/65 (80%)** | 42/65 (65%) | 39/65 (60%) |
| semantic_trigger | structured | **35/35 (100%)** | **35/35 (100%)** | 31/35 (89%) |
| activity_routing | structured | **40/40 (100%)** | **40/40 (100%)** | 20/40 (50%) |
| agentic | primary | 59/80 (74%) | **67/80 (84%)** | 38/80 (48%) |
| overall | | 186/220 (85%) | 184/220 (84%) | 128/220 (58%) |
| median latency | | 3630ms | 5489ms | 897ms |
| schema repairs | | 0 | 0 | 0 |
| hard errors | | 0 | 0 | 0 |

The near-tie on the overall column is misleading and should not be used to
choose anything. The two models are separated by slot, in opposite directions:
`gemini-3.6-flash` is 15 points better at addressing and 10 points worse at the
full agentic loop.

### The primary slot: `grok-4.3` is better at the job

`gemini-3.6-flash` exhausts its iteration budget. Across the agentic suite:

| | `gemini-3.6-flash` | `grok-4.3` | `gemini-2.5-flash-lite` |
| --- | --- | --- | --- |
| runs ending `failed` | 17/80 (21%) | 3/80 (4%) | 1/80 (1%) |
| mean tool calls per run | 4.2 | 2.1 | 1.2 |
| maximum tool calls in a run | 16 (the ceiling) | 8 | 6 |

A run that ends `failed` is a user-facing failure, and `gemini-3.6-flash`
produces them at five times `grok-4.3`'s rate. The mechanism is visible in the
trajectories: it re-searches memory and re-lists the plugin catalog instead of
converging, and hits `maxToolCalls` before finishing. Two cases show it plainly:

- `agentic/durable_artifact` — "write this up as an artifact" — fails 5/5,
  never reaching `workstream_create_artifact`, against 4/5 for `grok-4.3`.
- `agentic/tracker_issue_creation` fails 5/5, reaching `linear_list_teams` and
  then thrashing instead of calling `linear_create_issue`.

This is not a latency win either. `gemini-3.6-flash` is faster per request
(3.2s versus 5.3s median on the structured suites) but *slower per agentic run*
(7.6s versus 6.7s median), because it spends the difference on extra turns.

Tool coverage: `grok-4.3` reached 19/19 stand-in tools, `gemini-3.6-flash`
18/19 (never `linear_create_issue`), `gemini-2.5-flash-lite` 17/19 (never
`github_repositories_list` or `memory_search`).

### The fallback: keep `gemini-3.6-flash`, in the fallback position

The production ledger supports `gemini-3.6-flash` as a fallback and only as a
fallback. Its entire production record is seven turns inside a *single* run on
2026-08-07, where `x-ai/grok-4.3` returned HTTP errors and the fallback stage
covered every turn successfully (`routing_decision_json.disposition =
"fallback"`, `success = true`). It has never served as primary in production, so
the promotion rested on one incident's worth of fallback traffic.

Swapping the slots preserves that demonstrated property — the two models cover
each other — while putting the better agentic model in front.

### The structured and classifier slots are the real problem

`gemini-2.5-flash-lite` holds both slots in production today, and it fails
every routing abstention case:

| Routing case | `gemini-3.6-flash` | `grok-4.3` | `gemini-2.5-flash-lite` |
| --- | --- | --- | --- |
| `identical_automation_siblings` | 5/5 | 5/5 | **0/5** |
| `ci_check_run_no_evidence` | 5/5 | 5/5 | **0/5** |
| `deploy_event_into_product_workstream` | 5/5 | 5/5 | **0/5** |
| `different_repository` | 5/5 | 5/5 | **0/5** |

Because `routingDecision` only returns a suggestion at or above 0.8 confidence,
every one of those twenty wrong answers cleared the floor and would have been
shown to a user.

This matches the production record rather than predicting it. Of 40 suggestions
ever made, 5 were dismissed and 16 remain unaccepted, and the dismissals cluster
on exactly these shapes: deployment traffic routed into a product-experience
work stream, and documents pulled in on a "likely related" association with no
shared entity. The over-suggestion is the model on the slot, not the prompt —
the same prompt scores 40/40 on two other models.

The classifier slot has a second problem. On
`addressing/quoted_email_injection`, `gemini-2.5-flash-lite` obeys a `SYSTEM
NOTICE` embedded in a quoted email body 5/5, at confidence 1.00.
`gemini-3.6-flash` resists it 5/5 and `grok-4.3` 4/5. Prompt-injection
resistance is a security property of the classifier slot, and the deployed model
does not have it.

Note that the classifier slot only ever sees the messages the heuristic could
not settle: `classifyAddressing` returns early at 0.9 confidence, so the
addressing figures describe the residual hard cases, not all traffic.

## What this run does not establish

- **Two addressing labels are contestable and are not counted against any
  model.** `addressing/ambiguous_affirmation` fails 0/5 on all three models, and
  `addressing/bare_fragment_after_failure` splits 0/5, 4/5, 0/5. Both labels
  were derived from production *silence*, and the silence may itself have been a
  miss. Unanimous failure across three models is better read as a questionable
  label than as three coincident errors.
- **`agentic/public_research` fails on both large models** (0/5 each): neither
  follows `web_search` with `web_fetch`, though the `avalon:web` system message
  instructs it. A failure common to every candidate is a prompt or product
  signal, not a model-selection input.
- **`x-ai/grok-4.5` on the automation slot was not tested,** and has zero rows
  in the 420-attempt inference ledger. That slot has never executed with its
  configured model. Worth investigating independently of this comparison.
- **Five repeats per case** is enough to separate 84% from 48%, and enough to
  call a 0/5 or 5/5 result stable. It is not enough to rank two models three
  points apart.
- The automation-shaped branches of `renderWorkstreamSystemPrompt` are not
  exercised — the agentic suite renders only `{title, objective}`, while 98 of
  198 production runs are automation-origin. `prompts/automation-compiler.ts`
  has no coverage at all.

## Production baseline

Snapshot of the Global database at 2026-08-10T18:35:57Z, for comparison against
any future run:

| Measure | Value |
| --- | --- |
| Inference attempts | 420 |
| `x-ai/grok-4.3` successes | 378 (median 3393ms, p90 9243ms, mean 5348ms) |
| `google/gemini-2.5-flash-lite` successes | 14 (mean 1566ms) |
| `google/gemini-3.6-flash` attempts | 7, all fallback-stage, all successful, one run |
| `x-ai/grok-4.3` non-success | 7 HTTP failures, 7 completion defects, 7 retries |
| Activities processed | 7,844 |
| Activities that produced a suggestion | 40 (0.5%) |
| Suggestions accepted / dismissed / pending | 19 / 5 / 16 |
| Tool invocations | 307, of which Drive search is 175 |
| Work streams | 122, of which 94 share one automation's title and objective |

The EU database is empty, so every figure above is Global and no customer data
crossed a region boundary to produce it.
