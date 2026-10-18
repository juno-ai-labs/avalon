import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";

/**
 * Overlay a person's labels on a judge's: the output has one line per case
 * id, the person's line where one exists and the judge's otherwise. Every
 * line keeps its `source` (`person` is stamped on a line without one), so a
 * report scored against the merged file can still be sliced by who labeled.
 */
function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function readLabels(path: string): Promise<Map<string, Record<string, unknown>>> {
  const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  return new Map(lines.map((line) => {
    const parsed = JSON.parse(line) as { id: string } & Record<string, unknown>;
    return [parsed.id, parsed];
  }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const gold = option(argv, "--gold");
  const judge = option(argv, "--judge");
  const output = option(argv, "--output");
  if (!gold || !judge || !output) throw new Error("--gold <file>, --judge <file> and --output <file> are required");
  await assertProtectedEvaluationPaths([resolve(gold), resolve(judge)], [resolve(output)]);
  const goldLabels = await readLabels(resolve(gold));
  const judgeLabels = await readLabels(resolve(judge));
  const merged = new Map<string, Record<string, unknown>>();
  for (const [id, label] of judgeLabels) merged.set(id, label);
  let overlaid = 0;
  for (const [id, label] of goldLabels) {
    if (merged.has(id)) overlaid += 1;
    merged.set(id, { ...label, source: label.source ?? "person" });
  }
  const lines = [...merged.values()].map((label) => JSON.stringify(label));
  await writePrivateFile(resolve(output), `${lines.join("\n")}\n`);
  process.stdout.write(`${JSON.stringify({ gold: goldLabels.size, judge: judgeLabels.size, merged: lines.length, overlaid })}\n`);
}

await main();
