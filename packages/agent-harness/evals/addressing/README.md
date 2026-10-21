# Addressing classifier evaluation

This suite evaluates the exact OpenRouter, TypeSafe JEV, or production-cascade
path against a caller-supplied JSONL corpus. Raw production exports are customer
content: keep them in an access-controlled scratch directory, never commit them,
and delete them after the run according to the production-data runbook. The
repository ignores `production-cases.jsonl` as a last defense; `--dataset` is
required so a run cannot silently use a stale local export.
`synthetic-cases.jsonl` is a content-safe four-class smoke fixture for checking
the runner itself; it is not an accuracy benchmark.

Create the evaluation directory with `mktemp -d`, copy the authorized export
into it, and set the corpus file to mode `0600`. The runners reject directories
readable by group/other and inputs readable by group/other.

The captured production result is a regression label, not human-reviewed ground
truth. Reports distinguish success rate, conditional agreement among completed
calls, failure-inclusive end-to-end accuracy, per-class precision/recall/F1,
confidence error, provider errors, and latency percentiles.

[`docs/jev-best-practices.md`](../../../../docs/jev-best-practices.md) explains
how to choose a JEV primitive, structure state and criteria, run ablations, keep
a holdout, calibrate confidence, and evaluate a fallback cascade.

Run at least two OpenRouter models with no fallback routing:

```bash
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:addressing -- \
  --target openrouter --dataset "$ADDRESSING_EVAL_DATASET" \
  --output "$ADDRESSING_EVAL_DIR/openrouter.json" \
  --models google/gemini-2.5-flash-lite,google/gemini-3.7-flash
```

Run JEV alone or the exact production cascade with the same corpus:

```bash
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:addressing -- \
  --target typesafe --dataset "$ADDRESSING_EVAL_DATASET" \
  --output "$ADDRESSING_EVAL_DIR/typesafe.json"

dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:addressing -- \
  --target cascade --dataset "$ADDRESSING_EVAL_DATASET" \
  --output "$ADDRESSING_EVAL_DIR/cascade.json" \
  --models deepseek/deepseek-v4-flash-0731
```

Set `ADDRESSING_EVAL_DIR` to the protected directory that contains the dataset;
the scripts reject outputs elsewhere and create report files with mode `0600`.
Models run one after another. Pass an explicit positive `--concurrency` to
parallelize cases within a model. Every report records the corpus SHA-256 so
later adjudication cannot silently join a stale dataset.

`baseline-2026-09-16.json` preserves content-free aggregate results from the
first complete four-model run and the SHA-256 of the external corpus it used.

To adjudicate only the unique disagreement cases with the Azure-bound Sol model
at medium reasoning, after producing `$ADDRESSING_EVAL_DIR/openrouter.json`:

```bash
dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:addressing:judge -- \
  --dataset "$ADDRESSING_EVAL_DATASET" \
  --report "$ADDRESSING_EVAL_DIR/openrouter.json" \
  --output "$ADDRESSING_EVAL_DIR/sol-medium-judge.json"
```

The judge applies the classifier rubric independently. Its output binds itself
to both the corpus SHA-256 and exact source-report SHA-256; the combination
report rejects mismatched inputs. CLI output contains summaries only. Detailed
reports remain in the protected scratch directory and are deleted with the raw
corpus after the evaluation.


## Deferred-request continuations

`--target typesafe` exercises ordinary addressing alone. `--target cascade` now
invokes `classifyMessageAdmission`, the production composition of ordinary
addressing and a dedicated continuation classifier. Optional `input.authorName`
is preserved for that decision. Reports retain ordinary `cascadeRoute` metadata
(`not_needed` when continuation settles the message) and record `continuation` separately; source fingerprints include the new
implementation and prompt. A continuation fallback is not an addressing fallback.

`deferred-actions-cases.jsonl` and `deferred-actions-validation-cases.jsonl` are
synthetic regressions for missing inputs, human ownership, unsolicited offers,
cancellation, delivered results, and new parallel requests. The second corpus was
used during the earlier prompt search and is a development regression set, not an
untouched holdout. Production transcripts and renamings of them remain private.

`continuation-holdout-cases.jsonl` contains the twelve fresh synthetic cases
frozen during this search, evaluated after the final candidate was selected.
They are now consumed holdout cases and should be treated as regressions for
future edits.

`continuation-2026-10-21.json` preserves a compact historical summary with
configuration, corpus and source fingerprints, per-class results, and limitations.
It separates the historical search from a rerun after review fixes to classifier
concurrency, signal preservation, sender identity, and one mislabeled fixture. Passing the dedicated question in isolation does not establish
correctness of the full admission decision.
