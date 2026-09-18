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
  primitiveOf,
  type CandidateContract,
  type CandidatePrimitive,
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
  /**
   * The per-case objective, from `objective.md`: mean band utility over the
   * operating band, rescaled to [0, 1] so the Pareto front can compare cases.
   *
   * Not accuracy. A case answered correctly at a confidence the gate will reject
   * scores as the miss it would be in production, and a confident false match
   * scores below a hesitant one.
   */
  score: number;
  /** Mean utility over the band, on the −2..+1 scale the product pays. */
  bandUtility: number;
  /** Contribution to the multiclass Brier score, over P(verdict). */
  brier: number;
  /**
   * Contribution to the binary Brier over P(fire), which is the fair comparison
   * across primitives.
   *
   * The three-class Brier charges a pure Noul for a class it cannot express: it
   * has no way to say "no event of this kind could settle this", so every such
   * case costs it mass it was never able to place. That is a penalty for the
   * primitive's shape rather than for being wrong about the decision, and on a
   * tuning split with ten such cases it is worth about 0.126 — larger than the
   * differences being measured.
   *
   * The product does not care either: `not_met` and `not_judgeable` take the same
   * action. So the binary score asks the only question the gate asks, P(fire)
   * against whether it should have fired, and it is the number a
   * cross-primitive comparison is settled on. The three-class score stays because
   * it is what separates a candidate that understands the third class from one
   * that has quietly dropped it.
   */
  brierBinary: number;
  /** Whether the gate would fire, at each threshold in the band. */
  firesInBand: boolean[];
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
    bandUtility: number;
    brier: number;
    /** The cross-primitive comparison. See `CaseOutcome.brierBinary`. */
    brierBinary: number;
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

/**
 * The thresholds the objective is averaged over.
 *
 * Three points rather than one, so a candidate cannot be tuned to the exact
 * value the gate happens to carry. `objective.md` has the evidence for the band.
 */
export const OPERATING_BAND = [0.5, 0.6, 0.7] as const;

/**
 * The verdict a candidate's answer means.
 *
 * For a Choice it is the mapping. For a Noul it is the scalar against the middle
 * of the operating band: the band's ends are swept by the objective, but the
 * confusion matrix and three-class accuracy need one verdict per case, and the
 * midpoint is the least arbitrary choice available. A hybrid's judgeability
 * answer wins outright when it says the condition can never be settled, because
 * that is a statement about the condition rather than about the degree.
 */
function resolveVerdict(
  candidate: CandidateContract,
  choice: string | null,
  confidence: number | null,
): Verdict | null {
  const primitive = primitiveOf(candidate);
  if (primitive === "choice") {
    return choice !== null && candidate.mapping[choice] ? candidate.mapping[choice]! : null;
  }
  if (confidence === null) return null;
  const judgeability = candidate.judgeability;
  if (judgeability && choice?.startsWith("noul|")) {
    const judged = choice.slice("noul|".length);
    if (judged === judgeability.unjudgeableLabel) return "not_judgeable";
  }
  const midpoint = OPERATING_BAND[Math.floor(OPERATING_BAND.length / 2)]!;
  return confidence > midpoint ? "met" : "not_met";
}

function noulProbabilities(
  candidate: CandidateContract,
  choice: string | null,
  confidence: number | null,
): Record<Verdict, number> {
  const noul = confidence ?? 0;
  const judgeability = candidate.judgeability;
  if (judgeability && choice?.startsWith("noul|")
    && choice.slice("noul|".length) === judgeability.unjudgeableLabel) {
    return { met: 0, not_met: 0, not_judgeable: 1 };
  }
  return { met: noul, not_met: 1 - noul, not_judgeable: 0 };
}

/**
 * What the product pays for one decision. A miss costs double a false fire.
 *
 * The gate guards a state-of-the-art model, not a destructive action: an
 * unwanted run costs one session against a Sidekick that was going to decide
 * for itself whether there was anything to do, while a miss silently drops
 * something the user asked to be watched for. Those are not the same kind of
 * failure, and the scale says so. `objective.md` carries the argument.
 *
 * The magnitude is the team's to set; the direction is not. Both errors are
 * scored as forgone credit rather than a negative, so the cheaper one costs a
 * point and the expensive one costs three, on a scale where 1.0 is perfect.
 */
export const UTILITY_CORRECT = 1;
export const UTILITY_FALSE_FIRE = 0;
export const UTILITY_MISSED_FIRE = -2;

export function utility(fires: boolean, shouldFire: boolean): number {
  if (fires === shouldFire) return UTILITY_CORRECT;
  return fires ? UTILITY_FALSE_FIRE : UTILITY_MISSED_FIRE;
}

/**
 * Whether the gate fires, at each threshold in the band.
 *
 * A Choice must both pick the match label and clear the threshold; a Noul only
 * has to clear it, because the scalar is the whole answer. A hybrid that calls
 * the condition unsettleable never fires whatever the scalar says.
 *
 * Exported because `rescore.ts` re-derives the objective from stored runs, and
 * two implementations of the gate's own rule is how a rescore quietly stops
 * measuring what the runtime does.
 */
export function firesInBand(
  primitive: CandidatePrimitive,
  verdict: Verdict | null,
  confidence: number | null,
  band: readonly number[] = OPERATING_BAND,
): boolean[] {
  return band.map((threshold) => (primitive === "choice"
    ? verdict === "met" && (confidence ?? 0) > threshold
    : verdict !== "not_judgeable" && (confidence ?? 0) > threshold));
}

/** Mean utility over the band, on the −2..+1 scale the product pays. */
export function bandUtilityOf(fires: readonly boolean[], shouldFire: boolean): number {
  return fires.reduce((total, fired) => total + utility(fired, shouldFire), 0) / fires.length;
}

/**
 * P(verdict) from the provider's own distribution, collapsed through the
 * candidate's label mapping.
 *
 * Falls back to putting the whole mass on the chosen verdict when the provider
 * omits probabilities, which is the most charitable reading available and is
 * flagged by `probabilities: null` on the case.
 */
function verdictProbabilities(
  outcome: { choice: string | null; confidence: number | null; probabilities: Record<string, number> | null },
  mapping: Record<string, Verdict>,
): Record<Verdict, number> {
  const mass: Record<Verdict, number> = { met: 0, not_met: 0, not_judgeable: 0 };
  if (outcome.probabilities) {
    for (const [label, probability] of Object.entries(outcome.probabilities)) {
      const verdict = mapping[label];
      if (verdict) mass[verdict] += probability;
    }
    const total = mass.met + mass.not_met + mass.not_judgeable;
    if (total > 0) {
      mass.met /= total;
      mass.not_met /= total;
      mass.not_judgeable /= total;
      return mass;
    }
  }
  const verdict = outcome.choice === null ? null : mapping[outcome.choice];
  if (verdict) mass[verdict] = 1;
  return mass;
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
    // A hybrid's second question is instruction the model reads, so it counts.
    ...(candidate.judgeability
      ? [
        candidate.judgeability.instructions.question,
        candidate.judgeability.instructions.focus,
        candidate.judgeability.instructions.decision,
        ...Object.values(candidate.judgeability.criteria).flatMap((criterion) => [
          criterion.meaning,
          ...criterion.include,
          ...criterion.exclude,
        ]),
      ]
      : []),
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
      primitive: primitiveOf(candidate),
      judgeability: candidate.judgeability ?? null,
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
    const primitive = primitiveOf(candidate);
    if (primitive !== "choice") {
      // A Noul returns the degree itself and no confidence, because the degree is
      // the quantity a threshold is applied to. So the scalar lands in
      // `confidence`, which is what every downstream calculation already
      // thresholds and bins — the gate, the band utility, the calibration sweep.
      const answers = decoded.answers as Record<string, { noul?: unknown; choice?: unknown }> | undefined;
      const noulAnswer = answers?.[candidate.noulName ?? "satisfaction"];
      const noul = typeof noulAnswer?.noul === "number" ? noulAnswer.noul : null;
      if (noul === null) {
        return { outcome: { latencyMs, failureKind: "noul_missing" }, transportFailed: false };
      }
      const judgeability = candidate.judgeability;
      const judged = judgeability ? answers?.[judgeability.name] : undefined;
      const judgeabilityChoice = typeof judged?.choice === "string" ? judged.choice : null;
      if (judgeability && judgeabilityChoice === null) {
        return { outcome: { latencyMs, failureKind: "judgeability_missing" }, transportFailed: false };
      }
      return {
        outcome: {
          latencyMs,
          // The "choice" a Noul made is the scalar's own name plus, for a hybrid,
          // the judgeability answer, so a report still says what was returned.
          choice: judgeabilityChoice === null ? "noul" : `noul|${judgeabilityChoice}`,
          confidence: noul,
          probabilities: null,
          resolvedModel: typeof decoded.model === "string" ? decoded.model : null,
          inputTokens: typeof decoded.usage?.input_tokens === "number" ? decoded.usage.input_tokens : null,
          outputTokens: typeof decoded.usage?.output_tokens === "number" ? decoded.usage.output_tokens : null,
        },
        transportFailed: false,
      };
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
  const confidence = attempt.outcome.confidence ?? null;
  const verdict = resolveVerdict(candidate, choice, confidence);
  const shouldFire = truth.label === "met";
  const primitive = primitiveOf(candidate);
  const fires = firesInBand(primitive, verdict, confidence);
  const bandUtility = bandUtilityOf(fires, shouldFire);
  const probabilities = primitiveOf(candidate) === "choice"
    ? verdictProbabilities(
      { choice, confidence, probabilities: attempt.outcome.probabilities ?? null },
      candidate.mapping,
    )
    // For a Noul the scalar *is* P(match), which is the cleanest probability in
    // the whole comparison: a Choice's confidence is about the label it picked,
    // while this is about the thing being asked.
    : noulProbabilities(candidate, choice, confidence);
  const brier = (["met", "not_met", "not_judgeable"] as const)
    .reduce((total, key) => total + (probabilities[key] - (truth.label === key ? 1 : 0)) ** 2, 0);
  const brierBinary = (probabilities.met - (shouldFire ? 1 : 0)) ** 2;
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
    // Rescaled from the −2..+1 the product pays into 0..1, so the Pareto front
    // compares cases on one axis without the utility's asymmetry changing sign.
    score: (bandUtility + 2) / 3,
    bandUtility,
    brier,
    brierBinary,
    firesInBand: fires,
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
      /** The objective: mean band utility per case, on the −2..+1 scale. */
      bandUtility: outcomes.reduce((total, outcome) => total + outcome.bandUtility, 0) / outcomes.length,
      /** Multiclass Brier over P(verdict). Zero is perfect, 0.667 is a guess. */
      brier: outcomes.reduce((total, outcome) => total + outcome.brier, 0) / outcomes.length,
      brierBinary: outcomes.reduce((total, outcome) => total + outcome.brierBinary, 0) / outcomes.length,
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
      `${candidate.id.padEnd(22)} n=${report.aggregate.n}`
      + ` util=${report.aggregate.bandUtility.toFixed(3)}`
      + ` fireBrier=${report.aggregate.brierBinary.toFixed(3)}`
      + ` brier3=${report.aggregate.brier.toFixed(3)}`
      + ` 3class=${(report.aggregate.threeClassAccuracy * 100).toFixed(2)}%`
      + ` admit=${(report.aggregate.admitAccuracy * 100).toFixed(2)}%`
      + ` hard=${(report.aggregate.hardThreeClassAccuracy * 100).toFixed(2)}%`
      + ` p75=${report.aggregate.latency.p75}ms`
      + ` words=${report.size.words}`
      + ` rec=${report.aggregate.fires.metRecall === null ? "n/a" : (report.aggregate.fires.metRecall * 100).toFixed(1) + "%"}`
      + ` prec=${report.aggregate.fires.metPrecision === null ? "n/a" : (report.aggregate.fires.metPrecision * 100).toFixed(1) + "%"}`
      + ` missed=${report.aggregate.fires.missedFires}`
      + ` falsefires=${report.aggregate.fires.falseFires}`
      + (report.aggregate.scenarios
        ? ` watches=${report.aggregate.scenarios.count}`
          + ` dropped=${report.aggregate.scenarios.withMissedFire}`
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
