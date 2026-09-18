/**
 * Re-derive the objective from stored runs, without calling the provider.
 *
 * The utility matrix in `objective.md` is a product decision, and it has already
 * changed once: it originally charged a false fire double a miss, and the
 * product's economics are the other way round — what sits behind this gate is a
 * model that decides for itself whether there is anything to do, so an unwanted
 * session is cheap and a dropped request is not. Every band utility published
 * before that reversal ranked the population backwards.
 *
 * Re-running eleven candidates against a live model to answer "what would this
 * have scored under a different matrix" is both slow and noisy: the answers did
 * not change, only the price list did. This reads the answers back out of
 * `reports/`, replays the gate's own rule through `firesInBand` from `run.ts`,
 * and pools repeats of the same candidate so a ranking is not read off one run.
 *
 *   tsx evals/semantic-trigger/rescore.ts reports/30-wide-dev.json [...]
 *
 * It is deliberately not a copy of the aggregation in `run.ts`: it reports the
 * objective and the decision counts, which is what a ranking needs, and points
 * at the report for anything per-class.
 */
import { readFileSync } from "node:fs";

import type { CandidateContract, CandidatePolarity, EvalCase } from "./contract";
import { gateShapeOf } from "./contract";
import {
  bandUtilityOf,
  firesInBand,
  loadCases,
  OPERATING_BAND,
  utility,
  type CandidateReport,
} from "./run";
import { splitOf } from "./split";

const DIR = "evals/semantic-trigger";

/** The band point the decision counts are read at. */
const MIDPOINT_INDEX = Math.floor(OPERATING_BAND.length / 2);

interface GenerationFile {
  split: string;
  corpusHash: string;
  caseCount: number;
  ranAt: string;
  candidates: CandidateContract[];
  reports: CandidateReport[];
}

interface RunScore {
  reportFile: string;
  ranAt: string;
  split: string;
  n: number;
  bandUtility: number;
  /** Utility at each threshold in the band, because the band average hides where it fires. */
  utilityAt: number[];
  /** Utility across the wider curve, when one was asked for. */
  curveUtility: number[];
  fireBrier: number;
  threeClass: number;
  recall: number | null;
  precision: number | null;
  missedFires: number;
  falseFires: number;
  /** Standing watches that dropped at least one occurrence they should have caught. */
  watchesDropped: number;
  /** Standing watches that started at least one unwanted run. */
  watchesNoisy: number;
  watches: number;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function spread(values: number[]): number {
  return values.length < 2 ? 0 : Math.max(...values) - Math.min(...values);
}

function scoreRun(
  file: GenerationFile,
  reportFile: string,
  report: CandidateReport,
  scenarioOf: Map<string, string | undefined>,
  curve: number[],
  polarity: CandidatePolarity | null,
): RunScore | null {
  const candidate = file.candidates.find((entry) => entry.id === report.candidateId);
  if (!candidate) throw new Error(`${reportFile} has a report for ${report.candidateId} with no candidate`);
  const own = gateShapeOf(candidate);
  // A Choice's confidence attaches to the label it picked, so "refuse only on a
  // confident refusal" is answerable from a stored run. A Noul's scalar means
  // whatever its question said it means, and no re-reading recovers the question
  // that was not asked — re-gating one would print a number for a request nobody
  // ever sent.
  if (polarity !== null && polarity !== own.polarity && own.primitive !== "choice") return null;
  const gate = polarity === null ? own : { ...own, polarity };

  let utilityTotal = 0;
  const utilityAt = OPERATING_BAND.map(() => 0);
  const curveUtility = curve.map(() => 0);
  let missedFires = 0;
  let falseFires = 0;
  let firedWanted = 0;
  let firedTotal = 0;
  let wantedTotal = 0;
  const dropped = new Set<string>();
  const noisy = new Set<string>();
  const watches = new Set<string>();

  for (const outcome of report.cases) {
    const shouldFire = outcome.truth === "met";
    const fires = firesInBand(gate, outcome.verdict, outcome.confidence);
    utilityTotal += bandUtilityOf(fires, shouldFire);
    fires.forEach((fired, index) => { utilityAt[index]! += utility(fired, shouldFire); });
    firesInBand(gate, outcome.verdict, outcome.confidence, curve)
      .forEach((fired, index) => { curveUtility[index]! += utility(fired, shouldFire); });

    // The decision counts are reported at one threshold rather than over the
    // band, because "how many runs did it drop" is a count of events and not of
    // threshold points. That threshold is the band's midpoint, and it is the
    // gate's own rule at that point rather than the report's `verdict` field: for
    // a Choice, `verdict === "met"` ignores the threshold entirely, so reading it
    // would compare a Choice with no gate against a Noul with one.
    const fired = fires[MIDPOINT_INDEX]!;
    const scenarioId = scenarioOf.get(outcome.caseId);
    if (scenarioId) watches.add(scenarioId);
    if (shouldFire) wantedTotal += 1;
    if (fired) firedTotal += 1;
    if (fired && shouldFire) firedWanted += 1;
    if (fired && !shouldFire) {
      falseFires += 1;
      if (scenarioId) noisy.add(scenarioId);
    }
    if (!fired && shouldFire) {
      missedFires += 1;
      if (scenarioId) dropped.add(scenarioId);
    }
  }

  return {
    reportFile,
    ranAt: file.ranAt,
    split: file.split,
    n: report.cases.length,
    bandUtility: utilityTotal / report.cases.length,
    utilityAt: utilityAt.map((total) => total / report.cases.length),
    curveUtility: curveUtility.map((total) => total / report.cases.length),
    fireBrier: report.aggregate.brierBinary,
    threeClass: report.aggregate.threeClassAccuracy,
    recall: wantedTotal === 0 ? null : firedWanted / wantedTotal,
    precision: firedTotal === 0 ? null : firedWanted / firedTotal,
    missedFires,
    falseFires,
    watchesDropped: dropped.size,
    watchesNoisy: noisy.size,
    watches: watches.size,
  };
}

function main(): void {
  // Positional arguments are report files; every `--flag` takes one value, which is
  // not one. Filtering on the shape of the token instead read `--polarity ignore`
  // as a file called `ignore`.
  const files: string[] = [];
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index]!.startsWith("--")) index += 1;
    else files.push(argv[index]!);
  }
  // Re-gating a stored run under the other polarity costs nothing and answers half
  // the question on its own: polarity changes only the gate rule, and the verdict
  // and confidence of every case are already on disk. What it cannot answer is
  // whether *asking* the negative question changes what the model attends to.
  const asPolarity = process.argv.indexOf("--polarity") === -1
    ? null
    : process.argv[process.argv.indexOf("--polarity") + 1] as CandidatePolarity;
  if (asPolarity !== null && asPolarity !== "match" && asPolarity !== "ignore") {
    console.error(`--polarity takes "match" or "ignore"`);
    process.exit(1);
  }
  const curveIndex = process.argv.indexOf("--curve");
  // The band is where the threshold is *allowed* to sit; the curve is for asking
  // whether that band is the right one, which the reversed asymmetry reopened.
  const curve = curveIndex === -1
    ? []
    : (process.argv[curveIndex + 1] ?? "").split(",").map(Number).filter((value) => Number.isFinite(value));
  if (files.length === 0) {
    console.error("usage: tsx evals/semantic-trigger/rescore.ts <report.json> [...]");
    process.exit(1);
  }
  const cases = loadCases(`${DIR}/cases.jsonl`);
  const scenarioOf = new Map<string, string | undefined>(
    cases.map((testCase: EvalCase) => [testCase.id, testCase.scenarioId]),
  );

  const byCandidate = new Map<string, { words: number; runs: RunScore[] }>();
  const skipped = new Set<string>();
  const splits = new Set<string>();
  const corpora = new Set<string>();
  for (const path of files) {
    const file = JSON.parse(readFileSync(path, "utf8")) as GenerationFile;
    splits.add(file.split);
    corpora.add(file.corpusHash);
    for (const report of file.reports) {
      const scored = scoreRun(file, path, report, scenarioOf, curve, asPolarity);
      if (scored === null) {
        skipped.add(report.candidateId);
        continue;
      }
      const entry = byCandidate.get(report.candidateId)
        ?? { words: report.size.words, runs: [] };
      entry.runs.push(scored);
      byCandidate.set(report.candidateId, entry);
    }
  }

  if (corpora.size > 1) {
    console.log(`WARNING: pooling runs across ${corpora.size} corpus hashes; the labels moved between them.`);
  }
  if (asPolarity !== null) {
    console.log(`Re-gated as polarity=${asPolarity}: the threshold guards`
      + ` ${asPolarity === "ignore" ? "the refusal, so an unsure answer fires" : "the fire, so an unsure answer refuses"}.`);
    if (skipped.size > 0) {
      console.log(`Not re-gated, because a scalar cannot be re-read as the answer to a question`
        + ` it was not asked: ${[...skipped].sort().join(", ")}.`);
    }
  }
  console.log(`band=[${OPERATING_BAND.join(", ")}] splits=${[...splits].join(",")}`
    + ` corpus=${[...corpora].map((hash) => hash.slice(0, 8)).join(",")}`);
  console.log("");
  const bandColumns = OPERATING_BAND.map((threshold) => `u@${threshold}`).join(" | ");
  const at = `@${OPERATING_BAND[MIDPOINT_INDEX]}`;
  console.log(`| candidate | runs | words | band utility | spread | ${bandColumns} | fireBrier | 3-class | recall${at} | precision${at} | missed${at} | false fires${at} | watches dropped${at} | watches noisy${at} |`);
  console.log(`| --- | ---: | ---: | ---: | ---: | ${OPERATING_BAND.map(() => "---:").join(" | ")} | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);

  const rows = [...byCandidate.entries()]
    .map(([candidateId, entry]) => ({
      candidateId,
      words: entry.words,
      runs: entry.runs,
      bandUtility: mean(entry.runs.map((run) => run.bandUtility)),
      utilitySpread: spread(entry.runs.map((run) => run.bandUtility)),
    }))
    .sort((left, right) => right.bandUtility - left.bandUtility);

  const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  for (const row of rows) {
    const runs = row.runs;
    console.log(`| ${row.candidateId} | ${runs.length} | ${row.words}`
      + ` | ${row.bandUtility.toFixed(3)} | ${row.utilitySpread.toFixed(3)}`
      + ` | ${OPERATING_BAND.map((_, index) => mean(runs.map((run) => run.utilityAt[index]!)).toFixed(3)).join(" | ")}`
      + ` | ${mean(runs.map((run) => run.fireBrier)).toFixed(3)}`
      + ` | ${percent(mean(runs.map((run) => run.threeClass)))}`
      + ` | ${percent(mean(runs.map((run) => run.recall ?? 0)))}`
      + ` | ${percent(mean(runs.map((run) => run.precision ?? 0)))}`
      + ` | ${mean(runs.map((run) => run.missedFires)).toFixed(1)}`
      + ` | ${mean(runs.map((run) => run.falseFires)).toFixed(1)}`
      + ` | ${mean(runs.map((run) => run.watchesDropped)).toFixed(1)}`
      + ` | ${mean(runs.map((run) => run.watchesNoisy)).toFixed(1)} |`);
  }

  if (curve.length > 0) {
    console.log("");
    console.log("Utility across the threshold curve, to ask whether the band itself is right:");
    console.log("");
    console.log(`| candidate | ${curve.map((threshold) => `u@${threshold}`).join(" | ")} |`);
    console.log(`| --- | ${curve.map(() => "---:").join(" | ")} |`);
    for (const row of rows) {
      console.log(`| ${row.candidateId} | ${curve
        .map((_, index) => mean(row.runs.map((run) => run.curveUtility[index]!)).toFixed(3))
        .join(" | ")} |`);
    }
  }

  console.log("");
  console.log(`Every number is the mean over a candidate's runs; spread is max − min of its band utility`);
  console.log(`across them, which is the only honest error bar available at ${Math.max(...rows.map((row) => row.runs.length))} runs.`);
  console.log(`Split note: ${cases.filter((testCase) => splitOf(testCase.id) === "dev").length} dev,`
    + ` ${cases.filter((testCase) => splitOf(testCase.id) === "holdout").length} holdout.`);
}

main();
