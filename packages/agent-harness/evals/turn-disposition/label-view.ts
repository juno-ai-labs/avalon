import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TurnDispositionCaseSchema } from "../../src/turn-disposition-evaluation";

/**
 * A compact view of a slice of cases for a person labeling them: the purpose,
 * the last messages before the turn, the turn, and what production did. It
 * prints customer content and exists only to be read inside an authorized
 * labeling session; never pipe it into a log.
 */
function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function cut(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** The head and the tail of a long turn: what it set out to do and how it ended. */
function cutBothEnds(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const tail = Math.floor(limit / 3);
  return `${flat.slice(0, limit - tail)} […${flat.length - limit} chars…] ${flat.slice(-tail)}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const path = option(argv, "--cases");
  if (!path) throw new Error("--cases is required");
  const from = Number(option(argv, "--from") ?? "0");
  const to = Number(option(argv, "--to") ?? "20");
  const turnWidth = Number(option(argv, "--turn") ?? "900");
  const contextWidth = Number(option(argv, "--context") ?? "200");
  const contextCount = Number(option(argv, "--context-count") ?? "3");
  const lines = (await readFile(resolve(path), "utf8")).split("\n").filter((line) => line.trim().length > 0);
  const allCases = lines.map((line) => TurnDispositionCaseSchema.parse(JSON.parse(line)));
  // With --labels, show only the cases that file has not labeled yet, so a
  // corpus that grows between batches can be labeled incrementally.
  const labelsPath = option(argv, "--labels");
  const labeled = new Set<string>();
  if (labelsPath) {
    for (const line of (await readFile(resolve(labelsPath), "utf8")).split("\n")) {
      if (line.trim().length > 0) labeled.add((JSON.parse(line) as { id: string }).id);
    }
  }
  const cases = allCases.filter((evaluationCase) => !labeled.has(evaluationCase.id));
  process.stdout.write(`cases ${allCases.length}; unlabeled ${cases.length}; showing ${from}..${Math.min(to, cases.length) - 1}\n`);
  cases.slice(from, to).forEach((evaluationCase, offset) => {
    const index = from + offset;
    const { state, production } = evaluationCase;
    process.stdout.write(`\n### [${index}] ${evaluationCase.id}\n`);
    process.stdout.write(`purpose: ${cut(state.conversation.purpose, 220)} | title: ${cut(state.conversation.title, 80)}\n`);
    process.stdout.write(`turn ${production.turnOrdinal}/${production.turnCount}${production.lastTurn ? " (last)" : ""}; state ${production.breakoutState}; mergedLater ${production.mergedLater}\n`);
    for (const message of state.conversation_context.recent_messages.slice(-contextCount)) {
      process.stdout.write(`  ${message.author}: ${cut(message.text, contextWidth)}\n`);
    }
    const artifacts = state.settled_turn.artifacts?.length ?? 0;
    process.stdout.write(`RALLY${artifacts > 0 ? ` [+${artifacts} artifact]` : ""}: ${cutBothEnds(state.settled_turn.text, turnWidth)}\n`);
  });
}

await main();
