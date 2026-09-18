/**
 * Evaluate one or more candidate contracts against the corpus, over live JEV.
 *
 * Deliberately dumb about optimization: this file runs candidates and reports
 * per-case outcomes, and `gepa.ts` decides what to run next. Keeping the two
 * apart is what lets the same runner produce the baseline, every generation, and
 * the final holdout measurement without a flag that changes what "accuracy"
 * means between them.
 *
 * Usage:
 *   dotenv -e .env.local -- pnpm --filter @rally/agent-harness eval:semantic -- \
 *     --candidates evals/semantic-trigger/candidates/gen0.json \
 *     --cases evals/semantic-trigger/cases.jsonl --split dev \
 *     --output /tmp/report.json
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  candidateChoices,
  candidateQuestions,
  candidateState,
  groundTruth,
  type CandidateContract,
  type EvalCase,
  type Verdict,
} from "./contract";
import { splitOf } from "./split";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
/** Four at a time: the provider is shared with nothing else here, and a serial
 * run of 130 cases at a quarter-second each is five minutes per candidate. */
const CONCURRENCY = 4;
/** One retry, for a transport failure only. A refused or malformed answer is a
 * result and is recorded as one: hiding it would flatter every candidate. */
const TRANSPORT_RETRIES = 1;

export interface CaseOutcome {
  caseId: string;
  family: string;
  difficulty: "hard" | "easy";
  truth: Verdict;
  truthSource: "adjudicated" | "authored";
  choice: string | null;
  verdict: Verdict | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  resolvedModel: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  failureKind: string | null;
  /** 1 exact, 0.5 right admit-decision but wrong class, 0 otherwise. */
  score: number;
}

/**
 * How big the instruction is, because a candidate that wins by enumerating cases
 * has not learned the decision.
 *
 * Tracked as a first-class axis rather than a footnote: at equal accuracy the
 * smaller contract is the better one, and the *shape* of the accuracy-versus-size
 * curve is what says whether more wording is still buying anything. It is also
 * the cheapest available proxy for overfitting on a corpus this size, where a
 * held-out split of eighty-odd cases cannot resolve a two-point difference.
 */
export interface CandidateSize {
  /** Bytes of the serialized `questions` document. */
  questionBytes: number;
  /** Bytes of the serialized `state` for one representative case. */
  stateBytes: number;
  criteriaCount: number;
  includeCount: number;
  excludeCount: number;
  /** Words across every instruction and criterion string. */
  words: number;
}

export interface CandidateReport {
  candidateId: string;
  generation: number;
  parent: string | null;
  requestHash: string;
  size: CandidateSize;
  cases: CaseOutcome[];
  aggregate: {
    n: number;
    completed: number;
    threeClassAccuracy: number;
    admitAccuracy: number;
    meanScore: number;
    hardThreeClassAccuracy: number;
    perClass: Record<Verdict, { support: number; correct: number; predicted: number }>;
    confusion: Record<string, number>;
    meanConfidenceCorrect: number | null;
    meanConfidenceIncorrect: number | null;
    /**
     * What a standing watch cares about, which is not accuracy.
     *
     * Three-class accuracy on the balanced half of the corpus answers "does this
     * request understand the decision". It does not answer the question a person
     * asks after installing a Sidekick, which is "how often will this interrupt
     * me for nothing, and will it catch the thing I asked for". Those are
     * precision and recall on `met`, and on a corpus where almost nothing should
     * fire they move independently of accuracy: a request that answered `not_met`
     * to everything would score 85% on a watch and be worthless.
     */
    fires: {
      /** Of the runs this request would have started, how many were wanted. */
      metPrecision: number | null;
      /** Of the runs that were wanted, how many it started. */
      metRecall: number | null;
      falseFires: number;
      missedFires: number;
      /** Unwanted runs per hundred events observed. */
      falseFiresPerHundredEvents: number;
    };
    /** Present only when the evaluated set contains standing-watch scenarios. */
    scenarios?: {
      count: number;
      /** Watches that should never have fired and did not. */
      correctlySilent: number;
      /** Watches that should never have fired and did. */
      brokenSilence: number;
      /** Watches that started at least one unwanted run. */
      withFalseFire: number;
      /** Watches that missed a run they should have started. */
      withMissedFire: number;
      perScenario: Array<{
        scenarioId: string;
        events: number;
        expectedFires: number;
        predictedFires: number;
        falseFires: number;
        missedFires: number;
      }>;
    };
    latency: { p50: number; p75: number; p90: number; p95: number; max: number };
    tokens: { input: number; output: number };
    failures: Record<string, number>;
  };
}

function admitOf(verdict: Verdict | null): boolean {
  return verdict === "met";
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export function candidateSize(candidate: CandidateContract, sample: EvalCase): CandidateSize {
  const questions = candidateQuestions(candidate);
  const strings = [
    candidate.instructions.question,
    candidate.instructions.focus,
    candidate.instructions.decision,
    ...Object.values(candidate.criteria).flatMap((criterion) => [
      criterion.meaning,
      ...criterion.include,
      ...criterion.exclude,
    ]),
  ];
  return {
    questionBytes: Buffer.byteLength(JSON.stringify(questions)),
    stateBytes: Buffer.byteLength(JSON.stringify(candidateState(candidate, sample))),
    criteriaCount: Object.keys(candidate.criteria).length,
    includeCount: Object.values(candidate.criteria).reduce((total, criterion) => total + criterion.include.length, 0),
    excludeCount: Object.values(candidate.criteria).reduce((total, criterion) => total + criterion.exclude.length, 0),
    words: strings.join(" ").split(/\s+/u).filter(Boolean).length,
  };
}

export function requestHash(candidate: CandidateContract): string {
  return createHash("sha256")
    .update(JSON.stringify({
      state: candidate.state,
      instructions: candidate.instructions,
      criteria: candidate.criteria,
      mapping: candidate.mapping,
      model: MODEL,
    }))
    .digest("hex");
}

async function askOnce(
  apiKey: string,
  candidate: CandidateContract,
  testCase: EvalCase,
): Promise<{ outcome: Partial<CaseOutcome>; transportFailed: boolean }> {
  const choices = new Set(candidateChoices(candidate));
  const body = {
    state: candidateState(candidate, testCase),
    questions: candidateQuestions(candidate),
    model: MODEL,
  };
  const startedAt = Date.now();
  try {
    const response = await fetch(JEV_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - startedAt;
    const raw = await response.text();
    if (!response.ok) {
      return {
        outcome: { latencyMs, failureKind: `http_${response.status}` },
        transportFailed: response.status >= 500 || response.status === 429,
      };
    }
    let decoded: {
      model?: unknown;
      answers?: { condition?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } };
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    try {
      decoded = JSON.parse(raw);
    } catch {
      return { outcome: { latencyMs, failureKind: "response_invalid_json" }, transportFailed: false };
    }
    const answer = decoded.answers?.condition;
    const choice = typeof answer?.choice === "string" ? answer.choice : null;
    const confidence = typeof answer?.confidence === "number" ? answer.confidence : null;
    if (choice === null || confidence === null) {
      return { outcome: { latencyMs, failureKind: "answer_missing_fields" }, transportFailed: false };
    }
    if (!choices.has(choice)) {
      // The provider answered outside the closed set the candidate declared.
      // A candidate whose labels the model will not honour is a worse candidate,
      // so this is its score rather than an error to retry around.
      return { outcome: { latencyMs, choice, confidence, failureKind: "choice_outside_set" }, transportFailed: false };
    }
    return {
      outcome: {
        latencyMs,
        choice,
        confidence,
        probabilities: (answer?.probabilities ?? null) as Record<string, number> | null,
        resolvedModel: typeof decoded.model === "string" ? decoded.model : null,
        inputTokens: typeof decoded.usage?.input_tokens === "number" ? decoded.usage.input_tokens : null,
        outputTokens: typeof decoded.usage?.output_tokens === "number" ? decoded.usage.output_tokens : null,
      },
      transportFailed: false,
    };
  } catch (error) {
    return {
      outcome: {
        latencyMs: Date.now() - startedAt,
        failureKind: `request_failed:${error instanceof Error ? error.name : "unknown"}`,
      },
      transportFailed: true,
    };
  }
}

async function evaluateCase(
  apiKey: string,
  candidate: CandidateContract,
  testCase: EvalCase,
): Promise<CaseOutcome> {
  const truth = groundTruth(testCase);
  let attempt = await askOnce(apiKey, candidate, testCase);
  for (let retry = 0; retry < TRANSPORT_RETRIES && attempt.transportFailed; retry += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500 * (retry + 1)));
    attempt = await askOnce(apiKey, candidate, testCase);
  }
  const choice = attempt.outcome.choice ?? null;
  const verdict = choice !== null && candidate.mapping[choice] ? candidate.mapping[choice]! : null;
  const exact = verdict === truth.label;
  const sameDecision = verdict !== null && admitOf(verdict) === admitOf(truth.label);
  return {
    caseId: testCase.id,
    family: testCase.family,
    difficulty: testCase.difficulty,
    truth: truth.label,
    truthSource: truth.source,
    choice,
    verdict,
    confidence: attempt.outcome.confidence ?? null,
    probabilities: attempt.outcome.probabilities ?? null,
    resolvedModel: attempt.outcome.resolvedModel ?? null,
    latencyMs: attempt.outcome.latencyMs ?? 0,
    inputTokens: attempt.outcome.inputTokens ?? null,
    outputTokens: attempt.outcome.outputTokens ?? null,
    failureKind: attempt.outcome.failureKind ?? null,
    score: exact ? 1 : sameDecision ? 0.5 : 0,
  };
}

export async function evaluateCandidate(
  apiKey: string,
  candidate: CandidateContract,
  cases: EvalCase[],
): Promise<CandidateReport> {
  const outcomes: CaseOutcome[] = new Array(cases.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= cases.length) return;
      outcomes[index] = await evaluateCase(apiKey, candidate, cases[index]!);
    }
  }));

  const completed = outcomes.filter((outcome) => outcome.verdict !== null);
  const verdicts: Verdict[] = ["met", "not_met", "not_judgeable"];
  const perClass = Object.fromEntries(verdicts.map((verdict) => [verdict, {
    support: outcomes.filter((outcome) => outcome.truth === verdict).length,
    correct: outcomes.filter((outcome) => outcome.truth === verdict && outcome.verdict === verdict).length,
    predicted: outcomes.filter((outcome) => outcome.verdict === verdict).length,
  }])) as Record<Verdict, { support: number; correct: number; predicted: number }>;
  const confusion: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key = `${outcome.truth}->${outcome.verdict ?? "none"}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  const hard = outcomes.filter((outcome) => outcome.difficulty === "hard");
  const correctConfidences = completed.filter((o) => o.verdict === o.truth).map((o) => o.confidence ?? 0);
  const incorrectConfidences = completed.filter((o) => o.verdict !== o.truth).map((o) => o.confidence ?? 0);
  const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);
  const failures: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (outcome.failureKind) failures[outcome.failureKind] = (failures[outcome.failureKind] ?? 0) + 1;
  }
  const mean = (values: number[]) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

  const predictedMet = outcomes.filter((outcome) => outcome.verdict === "met");
  const truthMet = outcomes.filter((outcome) => outcome.truth === "met");
  const falseFires = predictedMet.filter((outcome) => outcome.truth !== "met").length;
  const missedFires = truthMet.filter((outcome) => outcome.verdict !== "met").length;
  const fires = {
    metPrecision: predictedMet.length === 0 ? null : (predictedMet.length - falseFires) / predictedMet.length,
    metRecall: truthMet.length === 0 ? null : (truthMet.length - missedFires) / truthMet.length,
    falseFires,
    missedFires,
    falseFiresPerHundredEvents: (falseFires / outcomes.length) * 100,
  };

  const byScenario = new Map<string, CaseOutcome[]>();
  for (let index = 0; index < cases.length; index += 1) {
    const scenarioId = cases[index]!.scenarioId;
    if (!scenarioId) continue;
    byScenario.set(scenarioId, [...(byScenario.get(scenarioId) ?? []), outcomes[index]!]);
  }
  const perScenario = [...byScenario].sort(([a], [b]) => a.localeCompare(b)).map(([scenarioId, group]) => ({
    scenarioId,
    events: group.length,
    expectedFires: group.filter((outcome) => outcome.truth === "met").length,
    predictedFires: group.filter((outcome) => outcome.verdict === "met").length,
    falseFires: group.filter((outcome) => outcome.verdict === "met" && outcome.truth !== "met").length,
    missedFires: group.filter((outcome) => outcome.truth === "met" && outcome.verdict !== "met").length,
  }));
  const scenarios = perScenario.length === 0 ? undefined : {
    count: perScenario.length,
    correctlySilent: perScenario.filter((entry) => entry.expectedFires === 0 && entry.predictedFires === 0).length,
    brokenSilence: perScenario.filter((entry) => entry.expectedFires === 0 && entry.predictedFires > 0).length,
    withFalseFire: perScenario.filter((entry) => entry.falseFires > 0).length,
    withMissedFire: perScenario.filter((entry) => entry.missedFires > 0).length,
    perScenario,
  };

  return {
    candidateId: candidate.id,
    generation: candidate.generation,
    parent: candidate.parent,
    requestHash: requestHash(candidate),
    size: candidateSize(candidate, cases[0]!),
    cases: outcomes,
    aggregate: {
      n: outcomes.length,
      completed: completed.length,
      // Failure-inclusive: a candidate that cannot get an answer is not accurate.
      threeClassAccuracy: outcomes.filter((o) => o.verdict === o.truth).length / outcomes.length,
      admitAccuracy: outcomes.filter((o) => o.verdict !== null && admitOf(o.verdict) === admitOf(o.truth)).length / outcomes.length,
      meanScore: outcomes.reduce((total, o) => total + o.score, 0) / outcomes.length,
      hardThreeClassAccuracy: hard.length === 0 ? 0 : hard.filter((o) => o.verdict === o.truth).length / hard.length,
      perClass,
      confusion,
      meanConfidenceCorrect: mean(correctConfidences),
      meanConfidenceIncorrect: mean(incorrectConfidences),
      fires,
      ...(scenarios ? { scenarios } : {}),
      latency: {
        p50: percentile(latencies, 0.5),
        p75: percentile(latencies, 0.75),
        p90: percentile(latencies, 0.9),
        p95: percentile(latencies, 0.95),
        max: latencies[latencies.length - 1] ?? 0,
      },
      tokens: {
        input: outcomes.reduce((total, o) => total + (o.inputTokens ?? 0), 0),
        output: outcomes.reduce((total, o) => total + (o.outputTokens ?? 0), 0),
      },
      failures,
    },
  };
}

export function loadCases(path: string): EvalCase[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EvalCase);
}

export function corpusHash(cases: EvalCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases.map((testCase) => testCase.id).sort())).digest("hex");
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");
  const candidatesPath = argument("candidates");
  const casesPath = argument("cases") ?? "evals/semantic-trigger/cases.jsonl";
  const split = argument("split") ?? "dev";
  const outputPath = argument("output");
  if (!candidatesPath || !outputPath) throw new Error("--candidates and --output are required");

  const candidates = JSON.parse(readFileSync(candidatesPath, "utf8")) as CandidateContract[];
  const all = loadCases(casesPath);
  const cases = split === "all" ? all : all.filter((testCase) => splitOf(testCase.id) === split);
  if (cases.length === 0) throw new Error(`no cases in split ${split}`);

  const reports: CandidateReport[] = [];
  for (const candidate of candidates) {
    const started = Date.now();
    const report = await evaluateCandidate(apiKey, candidate, cases);
    reports.push(report);
    console.log(
      `${candidate.id.padEnd(22)} n=${report.aggregate.n} 3class=${(report.aggregate.threeClassAccuracy * 100).toFixed(2)}%`
      + ` admit=${(report.aggregate.admitAccuracy * 100).toFixed(2)}%`
      + ` hard=${(report.aggregate.hardThreeClassAccuracy * 100).toFixed(2)}%`
      + ` p75=${report.aggregate.latency.p75}ms`
      + ` words=${report.size.words}`
      + ` prec=${report.aggregate.fires.metPrecision === null ? "n/a" : (report.aggregate.fires.metPrecision * 100).toFixed(1) + "%"}`
      + ` rec=${report.aggregate.fires.metRecall === null ? "n/a" : (report.aggregate.fires.metRecall * 100).toFixed(1) + "%"}`
      + ` falsefires=${report.aggregate.fires.falseFires}`
      + (report.aggregate.scenarios
        ? ` watches=${report.aggregate.scenarios.count}`
          + ` noisy=${report.aggregate.scenarios.withFalseFire}`
          + ` broke-silence=${report.aggregate.scenarios.brokenSilence}`
        : "")
      + ` in=${report.aggregate.tokens.input}`
      + ` wall=${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }
  writeFileSync(outputPath, `${JSON.stringify({
    split,
    corpusHash: corpusHash(cases),
    caseCount: cases.length,
    ranAt: new Date().toISOString(),
    candidates,
    reports,
  }, null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
}

if (process.argv[1]?.includes("semantic-trigger/run")) void main();
