# Turn-disposition evaluation

Measures the decision behind the merge and Breakout suggestions
(`docs/PRDs/2026-10-17_merge-and-breakout-suggestions/design.md`): given one
message in a Thread or a Breakout, a person's or Rally's, with its parent, its
conversation's charter, what the conversation has produced so far and the
messages around it, does the message call for carrying up to the parent,
breaking a side question out, or nothing. Two targets answer the same state
bytes: JEV through `judgeTurnDisposition` (`--target typesafe`) and a
generative model through `renderTurnDispositionMessages` over OpenRouter
(`--target openrouter --models openai/gpt-5.6-terra`). The report records
each call's end-to-end latency and the agreement with the label each case has.

Raw production exports are customer content: keep them in an owner-only
scratch directory (mode 0700, files 0600), never commit them, and delete them
after the run. The runners refuse paths outside one protected directory.
`synthetic-cases.jsonl` is a content-safe fixture for checking the runner; it
is not a benchmark. Its merged-result cases explicitly include
`judged_message.merged_from` for both person and Rally authors, with results
that do and do not belong in the parent. The export builder currently omits
this field, so a corpus built from exports does not yet measure provenance.

## Files in the export directory

`build-cases.ts` reads one directory holding, per Organization, an
`inventory-*.json` (Channels, Threads and Breakouts with their titles,
purposes, memberships, merge markers and Breakout parents, from the
WorkspaceDO) and any number of `extract-*.jsonl` (Breakouts) and
`thread-*.jsonl` (Threads), one conversation per line, each holding the rows
`export.sql` returns from the SubstreamAgent: a `meta` row, one `turn` row per
canonical turn, a `run` row per run, and a `checkpoint` row per compaction
checkpoint. A conversation that appears in two files is read once. Every
message with text becomes a case, except the system kinds the host gates
before the classifier runs.

## Labels

Three label files take part, all JSONL `{id, disposition, kind, source?, note?}`:

- The **gold** file is a person's judgment, written incrementally with
  `label-view.ts`, which shows a case the way the classifier sees it (parent,
  charter, so-far, recent messages, the judged message) and, given `--labels`,
  only the cases that file has not labeled yet. `--author`, `--kind`,
  `--final-only`, `--non-final-only` and `--every N` pick a stratum or a
  spread sample.
- The **judge** file is a strong model's answer to every case, made by running
  the evaluation with that model as the target and turning the report into
  labels with `labels-from-report.ts`. Its lines carry `source: "judge:<model>"`
  and are validated by the report's own accuracy against the gold cases.
- The **merged** file is `merge-labels.ts`: the gold line where one exists,
  the judge's otherwise, so every case is scored and the slices can still tell
  who labeled what.

`golden-labels-2026-10-18.jsonl` is the gold file of the first corpus run
with its notes removed: case ids (conversation, substream and turn sequence),
dispositions and kinds only, so a re-export of the same conversations can be
re-scored against the same judgment. The notes, the judge labels and the
cases stay in the protected directory.

```bash
# 1. Export (see the design's "Where the labels come from"), then build cases:
pnpm --filter @rally/agent-harness eval:turn-disposition:build -- \
  --extract "$EVAL_DIR" --output "$EVAL_DIR/cases.jsonl"

# 2. Label by hand, a slice at a time:
pnpm --filter @rally/agent-harness eval:turn-disposition:view -- \
  --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels.jsonl" \
  --author rally --kind thread --non-final-only --every 7 --from 0 --to 20

# 3. Judge everything with a model from a different family than the targets,
#    then overlay the gold labels:
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:turn-disposition -- \
  --target openrouter --models anthropic/claude-sonnet-5.5 --reasoning-effort low \
  --concurrency 24 --timeout-ms 90000 \
  --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels.jsonl" --output "$EVAL_DIR/judge.json"
pnpm --filter @rally/agent-harness eval:turn-disposition:judge-labels -- \
  --report "$EVAL_DIR/judge.json" --output "$EVAL_DIR/labels-judge.jsonl"
pnpm --filter @rally/agent-harness eval:turn-disposition:merge-labels -- \
  --gold "$EVAL_DIR/labels.jsonl" --judge "$EVAL_DIR/labels-judge.jsonl" --output "$EVAL_DIR/labels-merged.jsonl"

# 4. Coverage runs over everything (concurrency is fine; each call's own
#    latency is still recorded), then a sequential run over a sample for the
#    latency numbers:
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:turn-disposition -- \
  --target typesafe --runs 2 --concurrency 4 \
  --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels-merged.jsonl" --output "$EVAL_DIR/jev.json"
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:turn-disposition -- \
  --target openrouter --models openai/gpt-5.6-terra --reasoning-effort none --concurrency 6 \
  --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels-merged.jsonl" --output "$EVAL_DIR/terra.json"
pnpm --filter @rally/agent-harness eval:turn-disposition -- \
  --target typesafe --concurrency 1 --cases "$EVAL_DIR/cases-latency.jsonl" --output "$EVAL_DIR/latency-jev.json"

# 5. Slice a report by author, conversation kind, labeler and split:
pnpm --filter @rally/agent-harness eval:turn-disposition:slices -- \
  --report "$EVAL_DIR/jev.json" --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels-merged.jsonl" --threshold 0.5
```

## Prompt optimization

`gepa.ts` evolves the disposition question and the context policy together
over the development half: a candidate is scored on every development case
with JEV, a reflection model (`--reflector`, Astra by default) reads a
parent's failures and proposes one child, and parents are drawn from the
Pareto front over per-case scores. Every third child may change only the
context policy, so what context the decision needs is tested on its own.
`--holdout` then scores the baseline and the top candidates (plus any named
with `--include`) on the untouched holdout, twice each, which is the only
number that counts. A pool file of hand-written context variants run through
`--holdout --top 0 --include …` is a clean ablation of the context alone.

```bash
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:turn-disposition:gepa -- \
  --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels-merged.jsonl" \
  --output "$EVAL_DIR/gepa-candidates.jsonl" --iterations 30 --concurrency 6
pnpm --filter @rally/agent-harness eval:turn-disposition:gepa -- \
  --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels-merged.jsonl" \
  --output "$EVAL_DIR/gepa-candidates.jsonl" --holdout --top 3 --include c08
```

Every report binds itself to the SHA-256 of the cases and the labels it
read, and to the source files that shaped the request, so a stale report
cannot pass for a current one. Only content-free aggregates leave the
protected directory. The development and holdout halves are fixed by the
conversation id's last hex digit (`report-slices.ts`), so criteria revised
from the development half's errors are scored on a holdout nobody looked at.
