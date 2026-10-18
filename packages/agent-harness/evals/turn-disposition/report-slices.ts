import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TurnDisposition } from "../../src/turn-disposition";
import {
  TurnDispositionCaseSchema,
  type TurnDispositionCase,
  type TurnDispositionResult,
} from "../../src/turn-disposition-evaluation";
import { assertProtectedEvaluationPaths } from "../addressing/secure-paths";
import { isDevelopmentCase } from "./split";

/**
 * Slice one report by who wrote the message, which kind of conversation it
 * sat in, who labeled it, and the development/holdout split, and print the
 * carry-up confusion (true and false positives and negatives) for each slice.
 * The whole-corpus summary in the report hides the question that matters for
 * the product: whether a classifier that looks good overall is quiet on the
 * person's messages and the non-final turns, where almost nothing should be
 * suggested, and still catches the settled turns, where most of the positives
 * are. Prints content-free aggregates only.
 */
interface LabelLine {
  id: string;
  disposition: TurnDisposition;
  source?: string;
}

interface Report {
  target: string;
  summaries: Array<{ model: string }>;
  results: TurnDispositionResult[];
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

interface Scored {
  evaluationCase: TurnDispositionCase;
  expected: TurnDisposition;
  actual: TurnDisposition;
  confidence: number;
  source: string;
}

interface SliceRow {
  slice: string;
  n: number;
  accuracy: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  sideTp: number;
  sideFp: number;
  sideFn: number;
  suggestedRate: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function scoreSlice(slice: string, rows: Scored[], threshold: number): SliceRow {
  // Production maps a positive at or below the threshold to no suggestion, so
  // agreement is scored on that decision, not on the raw choice.
  const decided = (row: Scored): TurnDisposition => row.actual !== "continue_here" && !(row.confidence > threshold) ? "continue_here" : row.actual;
  const carried = (row: Scored): boolean => row.actual === "worth_carrying_up" && row.confidence > threshold;
  const tp = rows.filter((row) => carried(row) && row.expected === "worth_carrying_up").length;
  const fp = rows.filter((row) => carried(row) && row.expected !== "worth_carrying_up").length;
  const fn = rows.filter((row) => !carried(row) && row.expected === "worth_carrying_up").length;
  const tn = rows.length - tp - fp - fn;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const side = (row: Scored): boolean => row.actual === "side_question_worth_a_breakout" && row.confidence > threshold;
  return {
    slice,
    n: rows.length,
    accuracy: ratio(rows.filter((row) => decided(row) === row.expected).length, rows.length),
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    sideTp: rows.filter((row) => side(row) && row.expected === "side_question_worth_a_breakout").length,
    sideFp: rows.filter((row) => side(row) && row.expected !== "side_question_worth_a_breakout").length,
    sideFn: rows.filter((row) => !side(row) && row.expected === "side_question_worth_a_breakout").length,
    suggestedRate: ratio(rows.filter((row) => carried(row) || side(row)).length, rows.length),
  };
}

function format(row: SliceRow): string {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    row.slice.padEnd(26),
    String(row.n).padStart(5),
    pct(row.accuracy).padStart(7),
    String(row.tp).padStart(5),
    String(row.fp).padStart(5),
    String(row.fn).padStart(5),
    String(row.tn).padStart(5),
    pct(row.precision).padStart(7),
    pct(row.recall).padStart(7),
    pct(row.f1).padStart(7),
    `${row.sideTp}/${row.sideFp}/${row.sideFn}`.padStart(10),
    pct(row.suggestedRate).padStart(7),
  ].join(" ");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const report = option(argv, "--report");
  const cases = option(argv, "--cases");
  const labels = option(argv, "--labels");
  const threshold = Number(option(argv, "--threshold") ?? "0");
  const run = Number(option(argv, "--run") ?? "1");
  if (!report || !cases || !labels) throw new Error("--report, --cases and --labels are required");
  await assertProtectedEvaluationPaths([resolve(report), resolve(cases), resolve(labels)], []);
  const parsed = JSON.parse(await readFile(resolve(report), "utf8")) as Report;
  const caseById = new Map((await readFile(resolve(cases), "utf8")).split("\n").filter((line) => line.trim().length > 0)
    .map((line) => TurnDispositionCaseSchema.parse(JSON.parse(line))).map((evaluationCase) => [evaluationCase.id, evaluationCase]));
  const labelById = new Map((await readFile(resolve(labels), "utf8")).split("\n").filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LabelLine).map((label) => [label.id, label]));
  const scored: Scored[] = [];
  for (const result of parsed.results) {
    if (result.run !== run || !result.actual) continue;
    const evaluationCase = caseById.get(result.caseId);
    const label = labelById.get(result.caseId);
    if (!evaluationCase || !label) continue;
    scored.push({
      evaluationCase,
      expected: label.disposition,
      actual: result.actual.disposition,
      confidence: result.actual.confidence,
      source: label.source?.startsWith("judge") ? "judge" : "person",
    });
  }
  const slices: Array<[string, (row: Scored) => boolean]> = [
    ["all", () => true],
    ["development", (row) => isDevelopmentCase(row.evaluationCase)],
    ["holdout", (row) => !isDevelopmentCase(row.evaluationCase)],
    ["labeled by a person", (row) => row.source === "person"],
    ["labeled by the judge", (row) => row.source === "judge"],
    ["person's messages", (row) => row.evaluationCase.production.authorType !== "agent"],
    ["Rally's messages", (row) => row.evaluationCase.production.authorType === "agent"],
    ["Rally final turns", (row) => row.evaluationCase.production.finalTurnOfCompletedRun],
    ["Rally non-final turns", (row) => row.evaluationCase.production.authorType === "agent" && !row.evaluationCase.production.finalTurnOfCompletedRun],
    ["Threads", (row) => row.evaluationCase.production.conversationKind === "thread"],
    ["Breakouts", (row) => row.evaluationCase.production.conversationKind === "breakout"],
    ["Threads, person", (row) => row.evaluationCase.production.conversationKind === "thread" && row.evaluationCase.production.authorType !== "agent"],
    ["Threads, Rally", (row) => row.evaluationCase.production.conversationKind === "thread" && row.evaluationCase.production.authorType === "agent"],
    ["Breakouts, person", (row) => row.evaluationCase.production.conversationKind === "breakout" && row.evaluationCase.production.authorType !== "agent"],
    ["Breakouts, Rally", (row) => row.evaluationCase.production.conversationKind === "breakout" && row.evaluationCase.production.authorType === "agent"],
    ["not a digest", (row) => row.evaluationCase.production.systemKind === null],
    ["with earlier outputs", (row) => row.evaluationCase.state.so_far.earlier_outputs.length > 0],
    ["holdout, person-labeled", (row) => !isDevelopmentCase(row.evaluationCase) && row.source === "person"],
  ];
  process.stdout.write(`${parsed.target} ${parsed.summaries.map((summary) => summary.model).join(",")} run ${run} threshold ${threshold}: ${scored.length} scored\n`);
  process.stdout.write(`${["slice".padEnd(26), "n".padStart(5), "acc".padStart(7), "TP".padStart(5), "FP".padStart(5), "FN".padStart(5), "TN".padStart(5), "prec".padStart(7), "recall".padStart(7), "F1".padStart(7), "side TP/FP/FN".padStart(10), "sugg%".padStart(7)].join(" ")}\n`);
  for (const [name, predicate] of slices) {
    process.stdout.write(`${format(scoreSlice(name, scored.filter(predicate), threshold))}\n`);
  }
}

await main();
