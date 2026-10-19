# Annotation editing decisions

Run from the repository root with `OPENROUTER_API_KEY` available:

```sh
pnpm exec tsx packages/agent-harness/evals/artifact-annotations/run.ts --model google/gemini-3.8-flash
```

Seven synthetic user turns use the production annotation projection. They check
one exact quote, XML-escaped exact text, several quotes, mandatory reading for truncation, reconciliation
of an older version, rebuilding a converted spreadsheet and locating rendered
HTML in source. The model returns an editing decision, not an actual tool edit.
On 2026-10-19 the medium fallback model above passed all six original cases after the production
guidance made truncation's read requirement explicit. A local app without model
credentials cannot demonstrate end-to-end artifact editing; this evaluation is
reported separately from message admission and renderer verification.

The review follow-up adds XML escaping to the exact-quote case; all seven cases
passed with decoded original oldString values on 2026-10-19.
