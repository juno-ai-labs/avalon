/**
 * What the confidence is worth, and where the threshold should sit.
 *
 * The label is only half of what JEV returns, and on this decision it is the
 * less interesting half. The runtime does not act on the label alone: it fires
 * when the choice is `condition_met` **and** the confidence clears a threshold,
 * so two candidates with identical accuracy are not equivalent products. The one
 * whose wrong matches cluster at 0.5 can be made safe by a threshold; the one
 * whose wrong matches arrive at 0.97 cannot be made safe at all.
 *
 * So this reads the per-case confidences and probabilities every report already
 * stores and answers three questions accuracy cannot:
 *
 * 1. **Does confidence separate right from wrong?** Accuracy per confidence bin,
 *    and the gap between mean confidence when right and when wrong. A flat
 *    profile means the number is decoration.
 * 2. **What does each threshold buy?** A sweep over the fire decision: at each
 *    candidate threshold, how many unwanted runs are prevented and how many
 *    wanted ones are lost. This is the curve
 *    `docs/adding-security-defensive-and-other-limits.md` says to hand back
 *    instead of a guessed number.
 * 3. **How calibrated is it?** A Brier score over P(condition_met), which is the
 *    provider's own probability mass rather than its self-report about a choice.
 *
 * Pooling matters: every run of a candidate is pooled, because a threshold chosen
 * from one 151-case run is fitted to that run's sampling noise. It reads reports
 * only and makes no requests.
 *
 *   tsx evals/semantic-trigger/calibration.ts --reports evals/semantic-trigger/reports
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { CandidateContract, Verdict } from "./contract";
import { loadCases } from "./run";
import type { CandidateReport, CaseOutcome } from "./run";

interface GenerationFile {
  split: string;
  candidates: CandidateContract[];
  reports: CandidateReport[];
}

const THRESHOLDS = [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
const BINS: Array<[number, number]> = [[0, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 0.95], [0.95, 1.0001]];

/**
 * The provider's probability that this event matches, not its confidence in
 * whatever it chose.
 *
 * They differ exactly where it matters: a case answered `not_met` at 0.55 may
 * still carry 0.45 of mass on `met`, and a threshold applied to the chosen
 * label's confidence cannot see that. Where probabilities are absent the
 * confidence of a `met` choice is the best available stand-in, and a non-`met`
 * choice contributes zero.
 */
function matchProbability(outcome: CaseOutcome, mapping: Record<string, Verdict>): number {
  if (outcome.probabilities) {
    let total = 0;
    for (const [label, probability] of Object.entries(outcome.probabilities)) {
      if (mapping[label] === "met") total += probability;
    }
    return total;
  }
  return outcome.verdict === "met" ? outcome.confidence ?? 0 : 0;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
  const reportsDir = argument("reports") ?? "evals/semantic-trigger/reports";
  const only = argument("candidates")?.split(",");
  const cases = new Map(loadCases(argument("cases") ?? "evals/semantic-trigger/cases.jsonl")
    .map((testCase) => [testCase.id, testCase]));
  const generations = readdirSync(reportsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(reportsDir, name), "utf8")) as GenerationFile);

  const pooled = new Map<string, { mapping: Record<string, Verdict>; runs: number; outcomes: CaseOutcome[] }>();
  for (const generation of generations) {
    for (const report of generation.reports) {
      if (only && !only.includes(report.candidateId)) continue;
      const candidate = generation.candidates.find((entry) => entry.id === report.candidateId);
      if (!candidate) continue;
      const entry = pooled.get(report.candidateId)
        ?? { mapping: candidate.mapping, runs: 0, outcomes: [] };
      entry.runs += 1;
      entry.outcomes.push(...report.cases);
      pooled.set(report.candidateId, entry);
    }
  }

  for (const [candidateId, entry] of [...pooled].sort()) {
    const answered = entry.outcomes.filter((outcome) => outcome.verdict !== null);
    console.log(`\n## ${candidateId} — ${entry.runs} run(s), ${answered.length} answered case-runs pooled\n`);

    console.log("Accuracy by confidence in the chosen label:\n");
    console.log("| confidence | case-runs | 3-class correct |");
    console.log("| --- | ---: | ---: |");
    for (const [low, high] of BINS) {
      const inBin = answered.filter((outcome) => (outcome.confidence ?? 0) >= low && (outcome.confidence ?? 0) < high);
      if (inBin.length === 0) continue;
      const correct = inBin.filter((outcome) => outcome.verdict === outcome.truth).length;
      console.log(`| ${low.toFixed(2)}–${Math.min(high, 1).toFixed(2)} | ${inBin.length} | ${((correct / inBin.length) * 100).toFixed(1)}% |`);
    }

    const right = answered.filter((outcome) => outcome.verdict === outcome.truth).map((outcome) => outcome.confidence ?? 0);
    const wrong = answered.filter((outcome) => outcome.verdict !== outcome.truth).map((outcome) => outcome.confidence ?? 0);
    const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
    console.log(`\nMean confidence right ${mean(right).toFixed(3)}, wrong ${mean(wrong).toFixed(3)}, separation ${(mean(right) - mean(wrong)).toFixed(3)}.`);

    const brier = mean(entry.outcomes.map((outcome) => {
      const probability = matchProbability(outcome, entry.mapping);
      const actual = outcome.truth === "met" ? 1 : 0;
      return (probability - actual) ** 2;
    }));
    console.log(`Brier score over P(match): ${brier.toFixed(4)} (0 is perfect, 0.25 is a coin flip).`);

    console.log("\nThe fire decision, swept over the threshold. A fire needs the `met` choice AND confidence above it:\n");
    console.log("| threshold | fires | wanted | unwanted | missed | precision | recall | watches made noisy | silence broken |");
    console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const threshold of THRESHOLDS) {
      const fired = entry.outcomes.filter((outcome) => outcome.verdict === "met" && (outcome.confidence ?? 0) > threshold);
      const wanted = fired.filter((outcome) => outcome.truth === "met").length;
      const unwanted = fired.length - wanted;
      const missed = entry.outcomes.filter((outcome) => outcome.truth === "met"
        && !(outcome.verdict === "met" && (outcome.confidence ?? 0) > threshold)).length;
      const noisy = new Set<string>();
      const brokenSilence = new Set<string>();
      for (const outcome of fired) {
        const testCase = cases.get(outcome.caseId);
        if (!testCase?.scenarioId || outcome.truth === "met") continue;
        noisy.add(testCase.scenarioId);
      }
      for (const scenarioId of noisy) {
        const siblings = [...cases.values()].filter((testCase) => testCase.scenarioId === scenarioId);
        const expected = siblings.filter((testCase) => (testCase.adjudicatedLabel ?? testCase.intendedLabel) === "condition_met").length;
        if (expected === 0) brokenSilence.add(scenarioId);
      }
      const precision = fired.length === 0 ? null : wanted / fired.length;
      const totalWanted = entry.outcomes.filter((outcome) => outcome.truth === "met").length;
      console.log(`| ${threshold.toFixed(2)} | ${fired.length} | ${wanted} | ${unwanted} | ${missed}`
        + ` | ${precision === null ? "n/a" : (precision * 100).toFixed(1) + "%"}`
        + ` | ${((totalWanted - missed) / totalWanted * 100).toFixed(1)}%`
        + ` | ${noisy.size} | ${brokenSilence.size} |`);
    }
  }
}

main();
