import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TurnDispositionCaseSchema, type TurnDispositionCase } from "../../src/turn-disposition-evaluation";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";

/**
 * Turn the raw Breakout exports into evaluation cases.
 *
 * Input: every `extract-*.jsonl` in the protected scratch directory, one line
 * per Breakout, carrying the rows the export query returned: a `meta` row
 * (title, description), the `turn` rows (every text or system turn, bounded),
 * and the `run` rows (status and final turn). Output: one case per final turn
 * of a completed run, with the purpose, the turn, the ten messages before it,
 * and what production did afterwards. `expected` starts null; labels are
 * joined by the runner from a separate file.
 */
interface ExportLine {
  workspaceId: string;
  workstreamId: string;
  substreamId: string;
  archived: number;
  exactState: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const directory = option(argv, "--extract");
  const output = option(argv, "--output");
  if (!directory || !output) throw new Error("--extract <dir> and --output <file> are required");
  const files = (await readdir(directory)).filter((name) => /^extract-.*\.jsonl$/.test(name)).sort();
  if (files.length === 0) throw new Error("no extract-*.jsonl files found");
  const inputs = files.map((name) => resolve(directory, name));
  await assertProtectedEvaluationPaths(inputs, [resolve(output)]);

  const cases: TurnDispositionCase[] = [];
  const stats = { breakouts: 0, withCompletedRuns: 0, cases: 0, emptyPurpose: 0, mergedLater: 0, parseFailures: 0 };
  for (const input of inputs) {
    const source = await readFile(input, "utf8");
    for (const line of source.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: ExportLine;
      try {
        parsed = JSON.parse(line) as ExportLine;
      } catch {
        stats.parseFailures += 1;
        continue;
      }
      stats.breakouts += 1;
      const rows = parsed.rows;
      const meta = rows.find((row) => row.k === "meta");
      const title = text(meta?.mt).trim();
      const description = text(meta?.body).trim();
      const purpose = description || title;
      const turns = rows.filter((row) => row.k === "turn")
        .map((row) => ({
          seq: Number(row.seq),
          turnId: text(row.tid),
          author: text(row.at),
          messageType: text(row.mt),
          body: text(row.body),
          structuredType: text(row.sc),
          createdAt: Number(row.ts),
        }))
        .sort((left, right) => left.seq - right.seq);
      const finalTurnIds = new Map<string, string>();
      for (const row of rows) {
        if (row.k !== "run") continue;
        if (text(row.at) !== "completed") continue;
        const finalTurnId = text(row.run);
        if (finalTurnId) finalTurnIds.set(finalTurnId, text(row.tid));
      }
      const finalTurns = turns.filter((turn) =>
        turn.author === "agent" && turn.messageType === "text" && finalTurnIds.has(turn.turnId) && turn.body.trim().length > 0);
      if (finalTurns.length === 0) continue;
      stats.withCompletedRuns += 1;
      const mergeMarkers = turns.filter((turn) => turn.structuredType === "conversation_merged_into").map((turn) => turn.seq);
      finalTurns.forEach((turn, index) => {
        const nextSeq = finalTurns[index + 1]?.seq ?? Number.POSITIVE_INFINITY;
        const recent = turns
          .filter((candidate) => candidate.seq < turn.seq
            && (candidate.messageType === "text" || candidate.messageType === "automation_activation")
            && candidate.author !== "system"
            && candidate.body.trim().length > 0)
          .slice(-10)
          .map((candidate) => ({
            author: candidate.author === "agent" ? "rally" as const : "person" as const,
            text: candidate.body,
          }));
        const mergedLater = mergeMarkers.some((seq) => seq > turn.seq);
        const evaluationCase: TurnDispositionCase = {
          id: `${parsed.substreamId}:${turn.seq}`,
          workspaceId: parsed.workspaceId,
          workstreamId: parsed.workstreamId,
          substreamId: parsed.substreamId,
          turnId: turn.turnId,
          runId: finalTurnIds.get(turn.turnId)!,
          createdAt: Number.isFinite(turn.createdAt) ? turn.createdAt : 0,
          state: {
            conversation: { kind: "breakout", purpose, title },
            settled_turn: { text: turn.body },
            conversation_context: { recent_messages: recent },
          },
          production: {
            mergedLater,
            mergedBeforeNextTurn: mergeMarkers.some((seq) => seq > turn.seq && seq < nextSeq),
            lastTurn: index === finalTurns.length - 1,
            breakoutState: parsed.exactState,
            archived: parsed.archived === 1,
            turnOrdinal: index + 1,
            turnCount: finalTurns.length,
          },
          expected: null,
        };
        TurnDispositionCaseSchema.parse(evaluationCase);
        if (purpose.length === 0) stats.emptyPurpose += 1;
        if (mergedLater) stats.mergedLater += 1;
        cases.push(evaluationCase);
        stats.cases += 1;
      });
    }
  }
  cases.sort((left, right) => left.createdAt - right.createdAt);
  await writePrivateFile(resolve(output), `${cases.map((evaluationCase) => JSON.stringify(evaluationCase)).join("\n")}\n`);
  process.stdout.write(`${JSON.stringify(stats)}\n`);
}

await main();
