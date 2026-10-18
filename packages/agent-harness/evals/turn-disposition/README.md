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
is not a benchmark.

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

Every report binds itself to the SHA-256 of the cases and the labels it
read, and to the source files that shaped the request, so a stale report
cannot pass for a current one. Only content-free aggregates leave the
protected directory. The development and holdout halves are fixed by the
conversation id's last hex digit (`report-slices.ts`), so criteria revised
from the development half's errors are scored on a holdout nobody looked at.
