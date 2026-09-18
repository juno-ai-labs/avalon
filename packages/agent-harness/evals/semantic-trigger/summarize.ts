/**
 * The committed record of one optimization: what was compared, what won, and on
 * what evidence.
 *
 * Separate from the reports it reads because the reports are large and keyed to a
 * run, while this is the thing a later change reads to know whether it has
 * improved anything. It records the corpus hash so a comparison against a moved
 * corpus is visibly invalid, and the resolved model so a result that came from a
 * different JEV version cannot be mistaken for a prompt effect.
 *
 *   tsx evals/semantic-trigger/summarize.ts --out baseline-YYYY-MM-DD.json
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { CandidateContract } from "./contract";
import { loadCases } from "./run";
import type { CandidateReport } from "./run";
import { splitOf } from "./split";

const DIR = "evals/semantic-trigger";

interface GenerationFile {
  split: string;
  corpusHash: string;
  caseCount: number;
  ranAt: string;
  candidates: CandidateContract[];
  reports: CandidateReport[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main(): void {
  const out = argument("out") ?? `${DIR}/baseline.json`;
  const generations = readdirSync(`${DIR}/reports`)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, file: JSON.parse(readFileSync(join(`${DIR}/reports`, name), "utf8")) as GenerationFile }));
  const cases = loadCases(`${DIR}/cases.jsonl`);

  const adjudicated = cases.filter((testCase) => testCase.adjudicatedLabel);
  const agreed = adjudicated.filter((testCase) => testCase.adjudicatedLabel === testCase.intendedLabel);

  const row = (report: CandidateReport, split: string, ranAt: string) => ({
    candidateId: report.candidateId,
    generation: report.generation,
    parent: report.parent,
    split,
    ranAt,
    requestHash: report.requestHash,
    n: report.aggregate.n,
    completed: report.aggregate.completed,
    threeClassAccuracy: Number(report.aggregate.threeClassAccuracy.toFixed(4)),
    admitAccuracy: Number(report.aggregate.admitAccuracy.toFixed(4)),
    hardThreeClassAccuracy: Number(report.aggregate.hardThreeClassAccuracy.toFixed(4)),
    meanScore: Number(report.aggregate.meanScore.toFixed(4)),
    perClass: report.aggregate.perClass,
    confusion: report.aggregate.confusion,
    meanConfidenceCorrect: report.aggregate.meanConfidenceCorrect === null ? null : Number(report.aggregate.meanConfidenceCorrect.toFixed(4)),
    meanConfidenceIncorrect: report.aggregate.meanConfidenceIncorrect === null ? null : Number(report.aggregate.meanConfidenceIncorrect.toFixed(4)),
    latency: report.aggregate.latency,
    tokens: report.aggregate.tokens,
    failures: report.aggregate.failures,
    resolvedModels: [...new Set(report.cases.map((outcome) => outcome.resolvedModel).filter(Boolean))],
  });

  const summary = {
    corpus: {
      cases: cases.length,
      dev: cases.filter((testCase) => splitOf(testCase.id) === "dev").length,
      holdout: cases.filter((testCase) => splitOf(testCase.id) === "holdout").length,
      hard: cases.filter((testCase) => testCase.difficulty === "hard").length,
      byLabel: Object.fromEntries(["condition_met", "condition_not_met", "condition_not_judgeable"].map((label) => [
        label,
        cases.filter((testCase) => (testCase.adjudicatedLabel ?? testCase.intendedLabel) === label).length,
      ])),
      byFamily: Object.fromEntries([...new Set(cases.map((testCase) => testCase.family))].sort().map((family) => [
        family,
        cases.filter((testCase) => testCase.family === family).length,
      ])),
      groundTruth: {
        adjudicated: adjudicated.length,
        authorAdjudicatorAgreement: adjudicated.length === 0 ? null : Number((agreed.length / adjudicated.length).toFixed(4)),
        note: "Synthetic corpus. The overlay scores against the adjudicated label where one exists and the authored label elsewhere.",
      },
    },
    runs: generations.flatMap(({ name, file }) => file.reports.map((report) => ({
      reportFile: name,
      corpusHash: file.corpusHash,
      ...row(report, file.split, file.ranAt),
    }))),
  };
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`wrote ${out} covering ${summary.runs.length} candidate runs`);
}

main();
