/**
 * The GEPA bookkeeping: a Pareto front over per-case scores, and the failure
 * digest a reflective teacher mutates from.
 *
 * GEPA's two ideas, and why each one is here rather than a simpler thing:
 *
 * **Reflection instead of a gradient.** There is no gradient through a JEV
 * request, and there are only a hundred and thirty cases, so the search signal
 * has to come from *reading* the failures. `digest` assembles the evidence a
 * teacher needs to do that: the cases a candidate got wrong, grouped by the error
 * class they share, with the full state that produced each one and the
 * corpus author's argument for the label. A teacher handed only an accuracy
 * number can propose nothing better than a guess.
 *
 * **A Pareto front instead of a single best.** Ranking candidates by aggregate
 * accuracy collapses the search onto whatever wins the majority class, and the
 * classes that decide this decision are small: six unjudgeable cases, and the
 * near-miss negatives. A candidate that is the *only* one to get a hard family
 * right is worth keeping even if its average is lower, because the next mutation
 * may inherit that strength. So the front is "best so far on at least one case",
 * and a parent is sampled in proportion to how many cases it uniquely wins.
 *
 * This module never calls a model. It reads reports and prints what to ask.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CandidateContract, EvalCase } from "./contract";
import { loadCases } from "./run";
import type { CandidateReport } from "./run";

interface GenerationFile {
  split: string;
  corpusHash: string;
  candidates: CandidateContract[];
  reports: CandidateReport[];
}

export interface FrontEntry {
  candidateId: string;
  generation: number;
  meanScore: number;
  threeClassAccuracy: number;
  hardAccuracy: number;
  /** Cases where this candidate's score is the best any candidate achieved. */
  bestOn: string[];
  /** Cases where it is the only candidate achieving that best. */
  uniquelyBestOn: string[];
}

export function loadGenerations(directory: string): GenerationFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as GenerationFile);
}

export function paretoFront(generations: GenerationFile[]): FrontEntry[] {
  const reports = generations.flatMap((generation) => generation.reports);
  const bestByCase = new Map<string, number>();
  for (const report of reports) {
    for (const outcome of report.cases) {
      bestByCase.set(outcome.caseId, Math.max(bestByCase.get(outcome.caseId) ?? 0, outcome.score));
    }
  }
  const achieversByCase = new Map<string, string[]>();
  for (const report of reports) {
    for (const outcome of report.cases) {
      if (outcome.score === bestByCase.get(outcome.caseId)) {
        achieversByCase.set(outcome.caseId, [...(achieversByCase.get(outcome.caseId) ?? []), report.candidateId]);
      }
    }
  }
  return reports
    .map((report) => {
      const bestOn = report.cases.filter((o) => o.score === bestByCase.get(o.caseId)).map((o) => o.caseId);
      return {
        candidateId: report.candidateId,
        generation: report.generation,
        meanScore: report.aggregate.meanScore,
        threeClassAccuracy: report.aggregate.threeClassAccuracy,
        hardAccuracy: report.aggregate.hardThreeClassAccuracy,
        bestOn,
        uniquelyBestOn: bestOn.filter((caseId) => (achieversByCase.get(caseId) ?? []).length === 1),
      };
    })
    .filter((entry) => entry.bestOn.length > 0)
    .sort((a, b) => b.uniquelyBestOn.length - a.uniquelyBestOn.length || b.meanScore - a.meanScore);
}

/** How every candidate so far did on one case, for spotting a case nobody gets. */
export function hardestCases(generations: GenerationFile[], limit = 12): Array<{ caseId: string; bestScore: number; attempts: number }> {
  const byCase = new Map<string, { best: number; attempts: number }>();
  for (const generation of generations) {
    for (const report of generation.reports) {
      for (const outcome of report.cases) {
        const existing = byCase.get(outcome.caseId) ?? { best: 0, attempts: 0 };
        byCase.set(outcome.caseId, { best: Math.max(existing.best, outcome.score), attempts: existing.attempts + 1 });
      }
    }
  }
  return [...byCase.entries()]
    .map(([caseId, value]) => ({ caseId, bestScore: value.best, attempts: value.attempts }))
    .sort((a, b) => a.bestScore - b.bestScore)
    .slice(0, limit);
}

/**
 * Everything a teacher needs to propose the next candidate, and nothing else.
 *
 * Bounded on purpose: every failing case in full would be most of the corpus by
 * the third generation, and a teacher that reads a hundred cases writes criteria
 * that fit a hundred cases. Twelve failures, chosen to span error classes rather
 * than to be the twelve worst, is what produces a boundary rule instead of a
 * lookup table — the "cluster errors and replace a boundary rule" practice
 * `docs/jev-best-practices.md` asks for, made structural.
 */
export function digest(
  report: CandidateReport,
  candidate: CandidateContract,
  cases: EvalCase[],
  failureBudget = 12,
): string {
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const failures = report.cases.filter((outcome) => outcome.verdict !== outcome.truth);
  const byClass = new Map<string, typeof failures>();
  for (const failure of failures) {
    const key = `${failure.truth} judged ${failure.verdict ?? "no answer"}`;
    byClass.set(key, [...(byClass.get(key) ?? []), failure]);
  }
  // Round-robin across error classes so the digest spans them.
  const chosen: typeof failures = [];
  const queues = [...byClass.values()].map((group) => [...group].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)));
  while (chosen.length < failureBudget && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) chosen.push(next);
      if (chosen.length >= failureBudget) break;
    }
  }

  const lines: string[] = [];
  lines.push(`## Candidate ${candidate.id} (generation ${candidate.generation}), on the development split`);
  lines.push("");
  lines.push(`Three-class accuracy ${(report.aggregate.threeClassAccuracy * 100).toFixed(1)}% `
    + `(${report.cases.filter((o) => o.verdict === o.truth).length}/${report.aggregate.n}). `
    + `Admit-decision accuracy ${(report.aggregate.admitAccuracy * 100).toFixed(1)}%. `
    + `Hard-case accuracy ${(report.aggregate.hardThreeClassAccuracy * 100).toFixed(1)}%.`);
  lines.push(`Mean confidence when right ${report.aggregate.meanConfidenceCorrect?.toFixed(3) ?? "n/a"}, `
    + `when wrong ${report.aggregate.meanConfidenceIncorrect?.toFixed(3) ?? "n/a"}.`);
  lines.push("");
  lines.push("### Confusion");
  for (const [key, count] of Object.entries(report.aggregate.confusion).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${key}: ${count}`);
  }
  lines.push("");
  lines.push("### Per class");
  for (const [verdict, stats] of Object.entries(report.aggregate.perClass)) {
    lines.push(`- ${verdict}: support ${stats.support}, correct ${stats.correct}, predicted ${stats.predicted}`);
  }
  lines.push("");
  lines.push("### Failures by family");
  const familyCounts = new Map<string, { wrong: number; total: number }>();
  for (const outcome of report.cases) {
    const entry = familyCounts.get(outcome.family) ?? { wrong: 0, total: 0 };
    entry.total += 1;
    if (outcome.verdict !== outcome.truth) entry.wrong += 1;
    familyCounts.set(outcome.family, entry);
  }
  for (const [family, counts] of [...familyCounts.entries()].sort((a, b) => b[1].wrong - a[1].wrong)) {
    lines.push(`- ${family}: ${counts.wrong} wrong of ${counts.total}`);
  }
  lines.push("");
  lines.push(`### ${chosen.length} failing cases, spanning every error class`);
  for (const failure of chosen) {
    const testCase = byId.get(failure.caseId)!;
    lines.push("");
    lines.push(`#### ${failure.caseId} — truth \`${failure.truth}\`, judged \`${failure.verdict ?? "no answer"}\` at confidence ${failure.confidence?.toFixed(2) ?? "n/a"} (family \`${testCase.family}\`, ${testCase.difficulty})`);
    lines.push(`- condition: ${JSON.stringify(testCase.condition)}`);
    lines.push(`- connector / event_type: ${testCase.connector} / ${testCase.eventType}`);
    lines.push(`- title: ${JSON.stringify(testCase.title)}`);
    lines.push(`- summary: ${JSON.stringify(testCase.summary)}`);
    lines.push(`- text_snippet: ${JSON.stringify(testCase.textSnippet.slice(0, 700))}`);
    lines.push(`- why the corpus says \`${failure.truth}\`: ${testCase.rationale}`);
  }
  return lines.join("\n");
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
  const reportsDir = argument("reports") ?? "evals/semantic-trigger/reports";
  const casesPath = argument("cases") ?? "evals/semantic-trigger/cases.jsonl";
  const forCandidate = argument("digest");
  const output = argument("output");
  const generations = loadGenerations(reportsDir);
  const cases = loadCases(casesPath);

  if (forCandidate) {
    for (const generation of generations) {
      const report = generation.reports.find((entry) => entry.candidateId === forCandidate);
      const candidate = generation.candidates.find((entry) => entry.id === forCandidate);
      if (report && candidate) {
        const text = digest(report, candidate, cases);
        if (output) writeFileSync(output, `${text}\n`);
        else console.log(text);
        return;
      }
    }
    throw new Error(`no report for candidate ${forCandidate}`);
  }

  console.log("## Pareto front\n");
  console.log("| candidate | gen | mean score | 3-class | hard | best on | uniquely best on |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const entry of paretoFront(generations)) {
    console.log(`| ${entry.candidateId} | ${entry.generation} | ${entry.meanScore.toFixed(3)} `
      + `| ${(entry.threeClassAccuracy * 100).toFixed(1)}% | ${(entry.hardAccuracy * 100).toFixed(1)}% `
      + `| ${entry.bestOn.length} | ${entry.uniquelyBestOn.length} |`);
  }
  console.log("\n## Cases no candidate has solved\n");
  for (const entry of hardestCases(generations)) {
    console.log(`- ${entry.caseId}: best score ${entry.bestScore} over ${entry.attempts} attempts`);
  }
}

if (process.argv[1]?.includes("semantic-trigger/gepa")) main();
