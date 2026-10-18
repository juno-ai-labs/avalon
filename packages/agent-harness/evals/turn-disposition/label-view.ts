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
  // --author person|rally and --kind thread|breakout narrow the slice, so a
  // labeling pass can be stratified by who wrote the message and where.
  const author = option(argv, "--author");
  const kind = option(argv, "--kind");
  const finalOnly = argv.includes("--final-only");
  const nonFinalOnly = argv.includes("--non-final-only");
  // --every N shows every Nth matching case, for a spread sample of a large slice.
  const every = Number(option(argv, "--every") ?? "1");
  const cases = allCases.filter((evaluationCase) => !labeled.has(evaluationCase.id)
    && (!author || evaluationCase.state.judged_message.author === author)
    && (!kind || evaluationCase.state.conversation.kind === kind)
    && (!finalOnly || evaluationCase.production.finalTurnOfCompletedRun)
    && (!nonFinalOnly || !evaluationCase.production.finalTurnOfCompletedRun))
    .filter((_, index) => index % every === 0);
  process.stdout.write(`cases ${allCases.length}; unlabeled ${cases.length}; showing ${from}..${Math.min(to, cases.length) - 1}\n`);
  cases.slice(from, to).forEach((evaluationCase, offset) => {
    const index = from + offset;
    const { state, production } = evaluationCase;
    process.stdout.write(`\n### [${index}] ${evaluationCase.id}\n`);
    process.stdout.write(`parent ${state.parent.kind}: ${cut(state.parent.title, 80)}${state.parent.purpose ? ` | ${cut(state.parent.purpose, 160)}` : ""}\n`);
    process.stdout.write(`${state.conversation.kind}: ${cut(state.conversation.title, 80)} | purpose: ${cut(state.conversation.purpose, 220)}\n`);
    if (state.conversation.opening_request) process.stdout.write(`opening: ${cut(state.conversation.opening_request, 200)}\n`);
    process.stdout.write(`message ${production.ordinal}/${production.count}${production.lastMessage ? " (last)" : ""}; before ${state.conversation.messages_before}; outputs so far ${state.so_far.earlier_outputs.length}; carried ${state.so_far.carried_up_before}; summary ${state.so_far.summary ? "yes" : "no"}; merged later ${production.mergedLater}; breakout next ${production.breakoutStartedBeforeNext}\n`);
    for (const message of state.recent_messages.slice(-contextCount)) {
      process.stdout.write(`  ${message.author}: ${cut(message.text, contextWidth)}\n`);
    }
    const outputs = state.judged_message.outputs;
    const outputNote = outputs.length > 0
      ? ` [${outputs.length} output${outputs.length > 1 ? "s" : ""}: ${outputs.map((output) => output.first_time_here ? "new" : "revised").join(",")}]`
      : "";
    process.stdout.write(`${state.judged_message.author.toUpperCase()}${outputNote}: ${cutBothEnds(state.judged_message.text, turnWidth)}\n`);
  });
}

await main();
