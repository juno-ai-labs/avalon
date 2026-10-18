import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TurnDispositionResult } from "../../src/turn-disposition-evaluation";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";

/**
 * Turn one report's answers into a labels file, so a strong model run as a
 * judge over the whole corpus can stand in where no person has labeled yet.
 * Every line carries `source` so a judge's label is never mistaken for a
 * person's; the runner joins labels by id and a person's file can overlay it.
 * With more than one run in the report, the majority answer is written and a
 * split vote is dropped.
 */
function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const report = option(argv, "--report");
  const output = option(argv, "--output");
  if (!report || !output) throw new Error("--report <file> and --output <file> are required");
  await assertProtectedEvaluationPaths([resolve(report)], [resolve(output)]);
  const parsed = JSON.parse(await readFile(resolve(report), "utf8")) as {
    target: string;
    reasoningEffort: string | null;
    results: TurnDispositionResult[];
  };
  const byCase = new Map<string, TurnDispositionResult[]>();
  for (const result of parsed.results) {
    if (!result.actual) continue;
    const list = byCase.get(result.caseId) ?? [];
    list.push(result);
    byCase.set(result.caseId, list);
  }
  const lines: string[] = [];
  let split = 0;
  for (const [caseId, results] of byCase) {
    const votes = new Map<string, number>();
    for (const result of results) votes.set(result.actual!.disposition, (votes.get(result.actual!.disposition) ?? 0) + 1);
    const ranked = [...votes.entries()].sort((left, right) => right[1] - left[1]);
    if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) {
      split += 1;
      continue;
    }
    const disposition = ranked[0]![0];
    const winning = results.filter((result) => result.actual!.disposition === disposition);
    const kind = winning[0]!.actual!.kind;
    const confidence = winning.reduce((total, result) => total + result.actual!.confidence, 0) / winning.length;
    lines.push(JSON.stringify({
      id: caseId,
      disposition,
      kind: disposition === "continue_here" ? null : kind,
      source: `judge:${results[0]!.model}${parsed.reasoningEffort ? `:${parsed.reasoningEffort}` : ""}`,
      confidence: Number(confidence.toFixed(3)),
      votes: results.length,
    }));
  }
  await writePrivateFile(resolve(output), `${lines.join("\n")}\n`);
  process.stdout.write(`${JSON.stringify({ labels: lines.length, split })}\n`);
}

await main();
