# Turn-disposition evaluation

Measures the decision behind the merge and Breakout suggestions
(`docs/PRDs/2026-10-17_merge-and-breakout-suggestions/design.md`): given a
settled Rally turn, its conversation's purpose and the messages before it,
does the turn call for carrying up to the parent, breaking a side question
out, or nothing. Two targets answer the same state bytes: JEV through
`judgeTurnDisposition` (`--target typesafe`) and a generative model through
`renderTurnDispositionMessages` over OpenRouter (`--target openrouter
--models openai/gpt-5.6-terra`). The report records each call's end-to-end
latency and the agreement with a golden label a person gave.

Raw production exports are customer content: keep them in an owner-only
scratch directory (mode 0700, files 0600), never commit them, and delete them
after the run. The runners refuse paths outside one protected directory.
`synthetic-cases.jsonl` is a content-safe fixture for checking the runner; it
is not a benchmark.

```bash
# 1. Export (see the design's "Where the labels come from"), then build cases:
pnpm --filter @rally/agent-harness eval:turn-disposition:build -- \
  --extract "$EVAL_DIR" --output "$EVAL_DIR/cases.jsonl"

# 2. Label: view a slice, write labels as JSONL {id, disposition, kind, note?}.
#    Pass --labels to see only the cases that file has not labeled yet, so a
#    corpus that grows between batches can be labeled incrementally.
pnpm --filter @rally/agent-harness eval:turn-disposition:view -- \
  --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels.jsonl" --from 0 --to 20

# 3. Run each target, sequentially, with repeats for the stability floor:
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:turn-disposition -- \
  --target typesafe --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels.jsonl" \
  --runs 2 --output "$EVAL_DIR/jev.json"
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:turn-disposition -- \
  --target openrouter --models openai/gpt-5.6-terra --reasoning-effort none \
  --cases "$EVAL_DIR/cases.jsonl" --labels "$EVAL_DIR/labels.jsonl" \
  --runs 2 --output "$EVAL_DIR/terra.json"
```

Every report binds itself to the SHA-256 of the cases and the labels it
read, and to the source files that shaped the request, so a stale report
cannot pass for a current one. Only content-free aggregates leave the
protected directory.
