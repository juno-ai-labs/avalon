/**
 * Corpus assembly: merge the authored slices, strip them for adjudication, and
 * fold an independent adjudication back in.
 *
 * The stripping is the point of this file existing. An adjudicator that can see
 * the author's intended label is not an independent judgement, it is a review of
 * one, and the two agree far more often than two independent readings of the same
 * case would. `docs/jev-best-practices.md` asks for ground truth that *can*
 * disagree with the first layer; that only happens if the second layer cannot see
 * the first.
 *
 *   tsx evals/semantic-trigger/prepare.ts merge
 *   tsx evals/semantic-trigger/prepare.ts strip
 *   tsx evals/semantic-trigger/prepare.ts fold
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import type { EvalCase } from "./contract";
import { splitOf } from "./split";

const DIR = "evals/semantic-trigger";
const SLICES = [
  // The balanced half: one condition per case, built to exercise the class
  // boundaries.
  "cases-engineering.jsonl",
  "cases-comms.jsonl",
  "cases-meetings.jsonl",
  // The production-shaped half: standing watches, one condition over a series of
  // events, where almost nothing should fire.
  "cases-loops-engineering.jsonl",
  "cases-loops-meetings.jsonl",
  "cases-loops-projects.jsonl",
];
const MERGED = `${DIR}/cases.jsonl`;
const STRIPPED = `${DIR}/cases-for-adjudication.jsonl`;
const ADJUDICATION = `${DIR}/adjudication.jsonl`;
/**
 * A second pass over cases whose text changed after the first adjudication.
 *
 * Kept as its own file rather than edited into the first: the provenance of a
 * label is part of the evidence, and a corpus where you cannot tell an original
 * judgement from a corrected one cannot be audited later.
 */
const READJUDICATION = `${DIR}/readjudication.jsonl`;

const LABELS = new Set(["condition_met", "condition_not_met", "condition_not_judgeable"]);

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function merge(): void {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const slice of SLICES) {
    const path = `${DIR}/${slice}`;
    if (!existsSync(path)) throw new Error(`missing slice ${slice}`);
    for (const testCase of readJsonl<EvalCase>(path)) {
      if (seen.has(testCase.id)) throw new Error(`duplicate case id ${testCase.id}`);
      seen.add(testCase.id);
      for (const field of ["connector", "eventType", "title", "summary", "textSnippet", "condition", "family", "rationale"] as const) {
        if (typeof testCase[field] !== "string" || testCase[field].trim().length === 0) {
          throw new Error(`${testCase.id}: ${field} is empty`);
        }
      }
      if (!LABELS.has(testCase.intendedLabel)) throw new Error(`${testCase.id}: bad label ${testCase.intendedLabel}`);
      if (testCase.difficulty !== "hard" && testCase.difficulty !== "easy") throw new Error(`${testCase.id}: bad difficulty`);
      cases.push(testCase);
    }
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));
  writeJsonl(MERGED, cases);

  const byLabel = new Map<string, number>();
  const byFamily = new Map<string, number>();
  const bySplit = new Map<string, number>();
  for (const testCase of cases) {
    byLabel.set(testCase.intendedLabel, (byLabel.get(testCase.intendedLabel) ?? 0) + 1);
    byFamily.set(testCase.family, (byFamily.get(testCase.family) ?? 0) + 1);
    const key = `${splitOf(testCase.id)}`;
    bySplit.set(key, (bySplit.get(key) ?? 0) + 1);
  }
  console.log(`merged ${cases.length} cases into ${MERGED}`);
  console.log("labels:", Object.fromEntries([...byLabel].sort()));
  console.log("families:", Object.fromEntries([...byFamily].sort()));
  console.log("split:", Object.fromEntries([...bySplit].sort()));
  console.log("hard:", cases.filter((testCase) => testCase.difficulty === "hard").length);

  // The scenario half gets its own accounting, because its whole point is a base
  // rate the balanced half deliberately does not have.
  const scenarios = new Map<string, EvalCase[]>();
  for (const testCase of cases) {
    if (!testCase.scenarioId) continue;
    scenarios.set(testCase.scenarioId, [...(scenarios.get(testCase.scenarioId) ?? []), testCase]);
  }
  if (scenarios.size > 0) {
    const scenarioCases = [...scenarios.values()].flat();
    const met = scenarioCases.filter((testCase) => (testCase.adjudicatedLabel ?? testCase.intendedLabel) === "condition_met");
    console.log(`scenarios: ${scenarios.size} watches, ${scenarioCases.length} events, `
      + `${met.length} should fire = ${((met.length / scenarioCases.length) * 100).toFixed(1)}% base rate`);
    for (const [scenarioId, group] of [...scenarios].sort()) {
      const fires = group.filter((testCase) => (testCase.adjudicatedLabel ?? testCase.intendedLabel) === "condition_met").length;
      const ordered = [...group].sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
      const outOfOrder = ordered.some((testCase, index) => index > 0
        && (testCase.observedAt ?? "") < (ordered[index - 1]!.observedAt ?? ""));
      if (fires > 2) throw new Error(`${scenarioId}: ${fires} firing events, at most 2 allowed`);
      if (outOfOrder) throw new Error(`${scenarioId}: observedAt is not increasing`);
      console.log(`  ${scenarioId}: ${group.length} events, ${fires} fire`);
    }
    const silent = [...scenarios.values()].filter((group) => group
      .every((testCase) => (testCase.adjudicatedLabel ?? testCase.intendedLabel) !== "condition_met")).length;
    console.log(`  watches that should never fire: ${silent}`);
  }
  // Per-split label balance, because a dev split that is missing a class cannot
  // teach a boundary the holdout then tests.
  for (const split of ["dev", "holdout"] as const) {
    const inSplit = cases.filter((testCase) => splitOf(testCase.id) === split);
    const counts = new Map<string, number>();
    for (const testCase of inSplit) counts.set(testCase.intendedLabel, (counts.get(testCase.intendedLabel) ?? 0) + 1);
    console.log(`${split} (${inSplit.length}):`, Object.fromEntries([...counts].sort()),
      `hard=${inSplit.filter((testCase) => testCase.difficulty === "hard").length}`);
  }
}

/** What an adjudicator is allowed to see: the decision, and nothing about the answer. */
function strip(): void {
  const cases = readJsonl<EvalCase>(MERGED);
  // The scenario fields are withheld as well. An adjudicator who can see that a
  // case belongs to a watch with eleven siblings can infer that almost none of
  // them fire, and label to that prior instead of to the evidence.
  writeJsonl(STRIPPED, cases.map((testCase) => ({
    id: testCase.id,
    connector: testCase.connector,
    eventType: testCase.eventType,
    title: testCase.title,
    summary: testCase.summary,
    textSnippet: testCase.textSnippet,
    condition: testCase.condition,
  })));
  console.log(`wrote ${cases.length} stripped cases to ${STRIPPED}`);
}

function fold(): void {
  const cases = readJsonl<EvalCase>(MERGED);
  const adjudications = new Map(
    readJsonl<{ id: string; label: string; rationale: string }>(ADJUDICATION)
      .map((row) => [row.id, row]),
  );
  if (existsSync(READJUDICATION)) {
    for (const row of readJsonl<{ id: string; label: string; rationale: string }>(READJUDICATION)) {
      adjudications.set(row.id, row);
    }
  }
  let agreed = 0;
  const disagreements: Array<{ id: string; authored: string; adjudicated: string; family: string }> = [];
  const merged = cases.map((testCase) => {
    const adjudication = adjudications.get(testCase.id);
    if (!adjudication) return testCase;
    if (!LABELS.has(adjudication.label)) throw new Error(`${testCase.id}: bad adjudicated label`);
    if (adjudication.label === testCase.intendedLabel) agreed += 1;
    else disagreements.push({ id: testCase.id, authored: testCase.intendedLabel, adjudicated: adjudication.label, family: testCase.family });
    return { ...testCase, adjudicatedLabel: adjudication.label, adjudicatorRationale: adjudication.rationale };
  });
  writeJsonl(MERGED, merged);
  const covered = merged.filter((testCase) => testCase.adjudicatedLabel).length;
  console.log(`folded ${covered} adjudications; agreement ${agreed}/${covered} = ${((agreed / covered) * 100).toFixed(1)}%`);
  console.log(`disagreements (${disagreements.length}):`);
  for (const row of disagreements) console.log(`  ${row.id} [${row.family}] authored=${row.authored} adjudicated=${row.adjudicated}`);
}

const command = process.argv[2];
if (command === "merge") merge();
else if (command === "strip") strip();
else if (command === "fold") fold();
else throw new Error("usage: prepare.ts merge|strip|fold");
