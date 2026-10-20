# Opening-message evaluation

Run the exact shipped JEV decision sequentially against a labeled JSONL corpus:

```bash
pnpm --filter @rally/agent-harness exec tsx evals/opening-message/run.ts \
  "$OPENING_EVAL_DIR/cases.jsonl" "$OPENING_EVAL_DIR/report.json"
```

`TYPESAFE_API_KEY` must be configured. Inputs and output must share an owner-only
scratch directory (0700); inputs must be 0600. Copy the synthetic fixture there
to smoke-test the runner. It is invented content, not an accuracy benchmark.
Keep customer corpora and detailed reports outside the repository and delete
them after evaluation.

Each case names `id`, `split` (`development` or `holdout`), `message`, and
`expected`; optional mention lists and attachment count default to empty/zero.
Define the split before tuning. Reports preserve exact requests and responses,
resolved models, confidence, failures, elapsed latency, corpus SHA-256, and
separate counts of missed prompts and unwanted invocations. Missing or
uncertain evidence processes the prompt, because a missed request is the more
expensive failure. Repeat identical baselines to establish variance before
comparing prompt changes; use untouched holdout cases after development.

An optional third positional argument selects a candidate questions JSON file.
Copy it into the same protected directory with mode 0600. Only the questions
change: state, transport, timeout, answer parsing, and the fallback policy remain
the production implementation. Diagnostics record the substituted request.
With Node 24 behind the managed sandbox proxy, set `NODE_USE_ENV_PROXY=1`;
otherwise direct fetches fail or time out and only measure the fallback.

## Live comparison, 2026-10-20

`optimization-cases.jsonl` contains 88 agent-authored synthetic English cases,
split into 44 development and 44 holdout cases before comparing candidates.
`baseline-2026-10-20.json` records aggregate results, corpus and question hashes,
latency, failures, and resolved model (`jev-1.13.0`). Each comparison was repeated
three times with the existing strict `> 0.5` confidence floor and one-second
timeout. The objective minimized missed prompts first, unwanted runs second,
and exact-label errors third.

| Candidate | Development correct, per run | Holdout correct, per run | Holdout unwanted runs |
| --- | --- | --- | --- |
| Original | 40, 40, 41 / 44 | 41, 41, 41 / 44 | 2 each run |
| Compact | 39, 39, 39 / 44 | Not selected | — |
| Explicit boundaries (selected) | 44, 44, 44 / 44 | 43, 43, 43 / 44 | 0 each run |

No candidate missed a prompt in these comparisons. The selected question
distinguishes work assigned **to** people from work **about or for** them, and
conversation labeling from substantive work. It correctly stayed silent on
every held-out silent case. Its one repeat-stable label error confuses a
question-shaped title with human-to-human communication; both suppress the
response. Selected holdout latency was 139 ms p50 and 205 ms p95 in this
environment. Three transport failures in the first original development run
remain included in the aggregate; the initial proxy-less smoke attempts are
excluded from the semantic comparison.

The exact production question reproduced the holdout result in a separate run.
A later 12-case original-candidate CLI smoke check, concurrent with local
quality gates, hit six one-second timeouts and two unwanted invocations through
the safe fallback. Those results are retained separately in the aggregate
report, not replaced by a successful retry. Prompt quality does not eliminate
transport or local scheduling delays; the admission timeout remains unchanged.

These are synthetic regression results, not production accuracy or independent
human adjudication. Do not tune further on this holdout and continue calling it
held out. Production examples and multilingual coverage remain future work.

## Vocabulary comparison, 2026-10-20

Following the request to assist a small model with familiar vocabulary, three
additional candidates tested replacing Thread/Breakout with conversation,
explicitly defining Rally as the AI assistant, and adding short contrasting
examples. The single baseline report includes these comparisons. Exact historical
candidate questions remain in commit `55daddc8f`; the selected prompt has one
source of truth, `src/opening-message.ts`. JEV's training corpus is unknown; familiar wording is a hypothesis,
not evidence that a prompt matches its training data.

The existing boundary prompt was retained. A fresh baseline run made no missed
prompt or unwanted-run decisions across all 88 cases (87 exact labels).
Each new candidate produced two unwanted runs and no missed prompts. The
defined-assistant and familiar-terms candidates repeated those results on a
second identical run. The first plain-language run had five timeouts, included
in its results; the other five comparison runs had none. Calls ran sequentially,
without quality gates competing for resources.

Both original split labels now describe regression slices of a previously
inspected corpus, not a fresh holdout. This comparison supports retaining the
tested prompt; it does not establish generalization or production accuracy.
