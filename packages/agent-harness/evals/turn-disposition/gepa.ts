import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { OpenRouterClient } from "../../src/index";
import { askJev, JEV_LATEST_MODEL, type JevChoiceQuestion } from "../../src/jev";
import {
  TURN_DISPOSITION_CHOICES,
  TurnDispositionAnswersSchema,
  turnDispositionQuestions,
  type TurnDisposition,
  type TurnDispositionState,
} from "../../src/turn-disposition";
import { TurnDispositionCaseSchema, type TurnDispositionCase } from "../../src/turn-disposition-evaluation";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";
import { isDevelopmentCase } from "./split";

/**
 * GEPA over the turn-disposition request: the disposition question (its
 * focus and criteria) and the context policy (which state fields JEV sees,
 * how much of each, and whether the judged message comes before or after the
 * context) evolve together. Each candidate is scored on every development
 * case; a reflection model reads a parent's failures and proposes one child;
 * parents come from the Pareto front over per-case scores so a candidate
 * that is right where the others are wrong keeps breeding. Every third
 * proposal may change only the context policy, so the question of what
 * context the decision needs is explored on its own and not only as a side
 * effect of rewording. The holdout half is touched once, at the end, by
 * `--holdout`.
 */
const ContextPolicySchema = z.object({
  order: z.enum(["context_first", "judged_first"]),
  parent: z.enum(["none", "title", "title_and_purpose"]),
  opening_request: z.boolean(),
  purpose: z.boolean(),
  messages_before: z.boolean(),
  summary: z.boolean(),
  earlier_outputs: z.number().int().min(0).max(8),
  carried_up_before: z.boolean(),
  recent_messages: z.number().int().min(0).max(10),
  recent_message_chars: z.number().int().min(100).max(1500),
  judged_chars: z.number().int().min(500).max(8000),
  judged_outputs: z.boolean(),
});
type ContextPolicy = z.infer<typeof ContextPolicySchema>;

const CriterionSchema = z.object({
  meaning: z.string().min(1),
  include: z.array(z.string().min(1)),
  exclude: z.array(z.string().min(1)),
});
const QuestionSchema = z.object({
  instructions: z.object({ question: z.string(), focus: z.string(), decision: z.string() }),
  criteria: z.object({
    worth_carrying_up: CriterionSchema,
    side_question_worth_a_breakout: CriterionSchema,
    mark_resolved: CriterionSchema,
    continue_here: CriterionSchema,
  }),
});
const ProposalSchema = z.object({
  rationale: z.string(),
  question: QuestionSchema,
  context: ContextPolicySchema,
});
type Proposal = z.infer<typeof ProposalSchema>;

interface Candidate extends Proposal {
  id: string;
  parent: string | null;
  generation: number;
  mutation: "baseline" | "question_and_context" | "context_only";
}

interface Metrics {
  n: number;
  accuracy: number;
  macroF1: number;
  carryUp: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
  side: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
  personSuggestedRate: number;
  finalTurnSuggestedRate: number;
  meanStateBytes: number;
  errors: number;
  confidence: { meanCorrect: number; meanWrong: number };
}

interface CaseOutcome {
  caseId: string;
  expected: TurnDisposition;
  predicted: TurnDisposition | null;
  choice: TurnDisposition | null;
  confidence: number | null;
  score: number;
  bytes: number;
}

interface Evaluated {
  candidate: Candidate;
  dev: Metrics;
  scores: Record<string, number>;
}

const BASELINE_CONTEXT: ContextPolicy = {
  order: "context_first",
  parent: "title_and_purpose",
  opening_request: true,
  purpose: true,
  messages_before: true,
  summary: true,
  earlier_outputs: 8,
  carried_up_before: true,
  recent_messages: 6,
  recent_message_chars: 700,
  judged_chars: 6000,
  judged_outputs: true,
};

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function centerTruncate(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  const retained = limit - 1;
  const prefix = Math.ceil(retained / 2);
  const suffix = retained - prefix;
  return `${characters.slice(0, prefix).join("")}…${characters.slice(characters.length - suffix).join("")}`;
}

function headTruncate(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

/** The state JEV sees under a policy: excluded fields are absent, not empty. */
export function applyContextPolicy(state: TurnDispositionState, policy: ContextPolicy): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  if (policy.parent !== "none") {
    context.parent = {
      kind: state.parent.kind,
      title: headTruncate(state.parent.title, 200),
      ...(policy.parent === "title_and_purpose" && state.parent.purpose !== undefined
        ? { purpose: headTruncate(state.parent.purpose, 1000) }
        : {}),
    };
  }
  context.conversation = {
    kind: state.conversation.kind,
    title: headTruncate(state.conversation.title, 200),
    ...(policy.purpose ? { purpose: headTruncate(state.conversation.purpose, 1000) } : {}),
    ...(policy.opening_request && state.conversation.opening_request !== undefined
      ? { opening_request: centerTruncate(state.conversation.opening_request, 1200) }
      : {}),
    ...(policy.messages_before ? { messages_before: state.conversation.messages_before } : {}),
  };
  const soFar: Record<string, unknown> = {};
  if (policy.summary && state.so_far.summary !== undefined) soFar.summary = headTruncate(state.so_far.summary, 2500);
  if (policy.earlier_outputs > 0) {
    soFar.earlier_outputs = state.so_far.earlier_outputs.slice(-policy.earlier_outputs)
      .map((output) => ({ title: headTruncate(output.title, 120), messages_ago: output.messages_ago }));
  }
  if (policy.carried_up_before) soFar.carried_up_before = state.so_far.carried_up_before;
  if (Object.keys(soFar).length > 0) context.so_far = soFar;
  if (policy.recent_messages > 0) {
    context.recent_messages = state.recent_messages.slice(-policy.recent_messages)
      .map((message) => ({ author: message.author, text: centerTruncate(message.text, policy.recent_message_chars) }));
  }
  const judged = {
    author: state.judged_message.author,
    text: centerTruncate(state.judged_message.text, policy.judged_chars),
    ...(policy.judged_outputs
      ? { outputs: state.judged_message.outputs.slice(0, 10).map((output) => ({ title: headTruncate(output.title, 120), first_time_here: output.first_time_here })) }
      : {}),
  };
  return policy.order === "judged_first" ? { judged_message: judged, ...context } : { ...context, judged_message: judged };
}

function predictedLabel(choice: TurnDisposition, confidence: number, threshold: number): TurnDisposition {
  return choice !== "continue_here" && confidence > threshold ? choice : "continue_here";
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function prf(outcomes: CaseOutcome[], label: TurnDisposition): Metrics["carryUp"] {
  const tp = outcomes.filter((outcome) => outcome.predicted === label && outcome.expected === label).length;
  const fp = outcomes.filter((outcome) => outcome.predicted === label && outcome.expected !== label).length;
  const fn = outcomes.filter((outcome) => outcome.predicted !== label && outcome.expected === label).length;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return { tp, fp, fn, precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
}

function metrics(outcomes: CaseOutcome[], cases: Map<string, TurnDispositionCase>): Metrics {
  const answered = outcomes.filter((outcome) => outcome.predicted !== null);
  const perClass = TURN_DISPOSITION_CHOICES.map((label) => prf(answered, label));
  const mean = (values: number[]): number => ratio(values.reduce((total, value) => total + value, 0), values.length);
  const persons = answered.filter((outcome) => cases.get(outcome.caseId)!.production.authorType !== "agent");
  const finals = answered.filter((outcome) => cases.get(outcome.caseId)!.production.finalTurnOfCompletedRun);
  return {
    n: outcomes.length,
    accuracy: ratio(answered.filter((outcome) => outcome.score === 1).length, outcomes.length),
    macroF1: mean(perClass.map((item) => item.f1)),
    carryUp: perClass[0]!,
    side: perClass[1]!,
    personSuggestedRate: ratio(persons.filter((outcome) => outcome.predicted !== "continue_here").length, persons.length),
    finalTurnSuggestedRate: ratio(finals.filter((outcome) => outcome.predicted !== "continue_here").length, finals.length),
    meanStateBytes: Math.round(mean(outcomes.map((outcome) => outcome.bytes))),
    errors: outcomes.length - answered.length,
    confidence: {
      meanCorrect: mean(answered.filter((outcome) => outcome.score === 1).map((outcome) => outcome.confidence!)),
      meanWrong: mean(answered.filter((outcome) => outcome.score === 0).map((outcome) => outcome.confidence!)),
    },
  };
}

async function evaluateCandidate(
  candidate: Candidate,
  cases: TurnDispositionCase[],
  expected: Map<string, TurnDisposition>,
  apiKey: string,
  threshold: number,
  concurrency: number,
): Promise<CaseOutcome[]> {
  const questions = {
    disposition: { type: "choice", instructions: candidate.question.instructions, criteria: candidate.question.criteria } satisfies JevChoiceQuestion<TurnDisposition>,
    carried_item_kind: turnDispositionQuestions.carried_item_kind,
  };
  const outcomes = new Array<CaseOutcome>(cases.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < cases.length) {
      const index = next++;
      const evaluationCase = cases[index]!;
      const state = applyContextPolicy(evaluationCase.state, candidate.context);
      const bytes = Buffer.byteLength(JSON.stringify(state));
      const want = expected.get(evaluationCase.id)!;
      let attempt = 0;
      for (;;) {
        try {
          const result = await askJev({
            apiKey,
            model: JEV_LATEST_MODEL,
            schemaName: "turn_disposition_gepa",
            timeoutMs: 15_000,
            state,
            questions,
            answers: TurnDispositionAnswersSchema,
          });
          const choice = result.answers.disposition.choice;
          const confidence = result.answers.disposition.confidence;
          const predicted = predictedLabel(choice, confidence, threshold);
          outcomes[index] = { caseId: evaluationCase.id, expected: want, predicted, choice, confidence, score: predicted === want ? 1 : 0, bytes };
          break;
        } catch (error) {
          attempt += 1;
          if (attempt >= 3) {
            outcomes[index] = { caseId: evaluationCase.id, expected: want, predicted: null, choice: null, confidence: null, score: 0, bytes };
            process.stderr.write(`case ${evaluationCase.id} failed: ${error instanceof Error ? error.message.slice(0, 100) : String(error)}\n`);
            break;
          }
          await new Promise((done) => setTimeout(done, 500 * attempt));
        }
      }
    }
  }));
  return outcomes;
}

/** GEPA's parent selection: the Pareto front over per-case scores, sampled by how many cases each member is best on. */
function selectParent(pool: Evaluated[], caseIds: string[], random: () => number): Evaluated {
  const best = new Map<string, number>();
  for (const caseId of caseIds) best.set(caseId, Math.max(...pool.map((item) => item.scores[caseId] ?? 0)));
  const undominated = pool.filter((item) => !pool.some((other) => other !== item
    && caseIds.every((caseId) => (other.scores[caseId] ?? 0) >= (item.scores[caseId] ?? 0))
    && caseIds.some((caseId) => (other.scores[caseId] ?? 0) > (item.scores[caseId] ?? 0))));
  const weights = undominated.map((item) => caseIds.filter((caseId) => (item.scores[caseId] ?? 0) === best.get(caseId) && best.get(caseId)! > 0).length);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let pick = random() * total;
  for (let index = 0; index < undominated.length; index += 1) {
    pick -= weights[index]!;
    if (pick <= 0) return undominated[index]!;
  }
  return undominated[undominated.length - 1]!;
}

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

const proposalJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rationale", "question", "context"],
  properties: {
    rationale: { type: "string" },
    question: {
      type: "object",
      additionalProperties: false,
      required: ["instructions", "criteria"],
      properties: {
        instructions: {
          type: "object",
          additionalProperties: false,
          required: ["question", "focus", "decision"],
          properties: { question: { type: "string" }, focus: { type: "string" }, decision: { type: "string" } },
        },
        criteria: {
          type: "object",
          additionalProperties: false,
          required: [...TURN_DISPOSITION_CHOICES],
          properties: Object.fromEntries(TURN_DISPOSITION_CHOICES.map((choice) => [choice, {
            type: "object",
            additionalProperties: false,
            required: ["meaning", "include", "exclude"],
            properties: {
              meaning: { type: "string" },
              include: { type: "array", items: { type: "string" } },
              exclude: { type: "array", items: { type: "string" } },
            },
          }])),
        },
      },
    },
    context: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(BASELINE_CONTEXT),
      properties: {
        order: { type: "string", enum: ["context_first", "judged_first"] },
        parent: { type: "string", enum: ["none", "title", "title_and_purpose"] },
        opening_request: { type: "boolean" },
        purpose: { type: "boolean" },
        messages_before: { type: "boolean" },
        summary: { type: "boolean" },
        earlier_outputs: { type: "integer", minimum: 0, maximum: 8 },
        carried_up_before: { type: "boolean" },
        recent_messages: { type: "integer", minimum: 0, maximum: 10 },
        recent_message_chars: { type: "integer", minimum: 100, maximum: 1500 },
        judged_chars: { type: "integer", minimum: 500, maximum: 8000 },
        judged_outputs: { type: "boolean" },
      },
    },
  },
};

const REFLECTION_SYSTEM = `You improve a classifier request for JEV, a small fast model that answers a Choice question about a JSON state. The request has two parts you may change:

1. The question: instructions {question, focus, decision} and three criteria, one per choice, each with a meaning, an include list and an exclude list. The choice names are fixed. Criteria describe boundaries: the meaning is the positive definition, include lists the situations that belong, exclude lists the nearest confusing situations that do not. Keep criteria symmetric between the choices. Shorter requests have won before: subtraction fixes more than accumulation. Keep the whole question under 450 words. Never describe a specific case; describe the recurring class of error.

2. The context policy: which fields of the state JEV sees, how much of each, and whether the judged message comes before or after the context. The state's fields are: parent {kind, title, purpose} (the conversation that would receive a merge), conversation {kind, title, purpose, opening_request, messages_before} (this conversation's charter), so_far {summary (a compaction summary, rarely present), earlier_outputs [{title, messages_ago}], carried_up_before}, recent_messages [{author, text}], judged_message {author, text, outputs [{title, first_time_here}]}. The focus text must only name fields the policy includes. A field is worth sending only if it changes the answer; every extra field is more for a small model to weigh and more bytes of latency.

The decision: read as the owner of the parent conversation, does the judged message call for carrying something up to the parent (worth_carrying_up), does it open a distinct piece of work that deserves its own conversation (side_question_worth_a_breakout), is the whole purpose complete or explicitly closed with nothing left open and no new result for the parent (mark_resolved), or is it a step of the work here (continue_here). Carry-up takes priority when a completed purpose also has something new for the parent. Completion takes priority over continue_here; an open side question prevents resolution. Merge, Breakout and resolution suggestions are shown above a confidence threshold. Scoring treats any low-confidence positive as continue_here. Both false positives (a suggestion on a message that is a revision, progress, chatter, a test, an automation's output) and false negatives (a missed first deliverable, finding, decision or answer) count.

You will be given the parent candidate, its scores and confusion on the development set, a sample of its failures with the state exactly as the policy rendered it, and a few successes to protect. Propose exactly one child candidate as JSON. Explain in the rationale which recurring error class the change targets and what you removed.`;

function formatOutcome(outcome: CaseOutcome, evaluationCase: TurnDispositionCase, policy: ContextPolicy, note: string | undefined): string {
  const state = JSON.stringify(applyContextPolicy(evaluationCase.state, policy));
  const production = evaluationCase.production;
  return [
    `expected: ${outcome.expected}${note ? ` (labeler's note: ${note})` : ""}`,
    `answered: ${outcome.choice} at confidence ${outcome.confidence?.toFixed(2)} (scored as ${outcome.predicted})`,
    `message by: ${production.authorType === "agent" ? "rally" : "a person"}; conversation: ${production.conversationKind}; final turn of a run: ${production.finalTurnOfCompletedRun}`,
    `state as sent: ${centerTruncate(state, 2200)}`,
  ].join("\n");
}

async function reflect(
  client: OpenRouterClient,
  reflector: string,
  parent: Evaluated,
  outcomes: CaseOutcome[],
  cases: Map<string, TurnDispositionCase>,
  notes: Map<string, string>,
  contextOnly: boolean,
  random: () => number,
): Promise<Proposal> {
  const sample = <T>(items: T[], count: number): T[] => [...items].sort(() => random() - 0.5).slice(0, count);
  const fpCarry = outcomes.filter((outcome) => outcome.predicted === "worth_carrying_up" && outcome.expected !== "worth_carrying_up");
  const fnCarry = outcomes.filter((outcome) => outcome.predicted !== "worth_carrying_up" && outcome.expected === "worth_carrying_up");
  const sideErrors = outcomes.filter((outcome) => (outcome.predicted === "side_question_worth_a_breakout") !== (outcome.expected === "side_question_worth_a_breakout"));
  const successes = outcomes.filter((outcome) => outcome.score === 1 && outcome.expected !== "continue_here");
  const failures = [...sample(fpCarry, 5), ...sample(fnCarry, 5), ...sample(sideErrors, 3)];
  const confusion = TURN_DISPOSITION_CHOICES.map((expected) => `${expected}: ${TURN_DISPOSITION_CHOICES.map((predicted) =>
    `${predicted}=${outcomes.filter((outcome) => outcome.expected === expected && outcome.predicted === predicted).length}`).join(", ")}`).join("\n");
  const dev = parent.dev;
  const user = [
    `## Parent candidate\n${JSON.stringify({ question: parent.candidate.question, context: parent.candidate.context }, null, 1)}`,
    `## Parent scores on ${dev.n} development cases\nthree-way accuracy ${(dev.accuracy * 100).toFixed(1)}%, macro F1 ${dev.macroF1.toFixed(3)}, carry-up precision ${(dev.carryUp.precision * 100).toFixed(1)}% recall ${(dev.carryUp.recall * 100).toFixed(1)}% F1 ${dev.carryUp.f1.toFixed(3)} (TP ${dev.carryUp.tp}, FP ${dev.carryUp.fp}, FN ${dev.carryUp.fn}), side-question F1 ${dev.side.f1.toFixed(3)} (TP ${dev.side.tp}, FP ${dev.side.fp}, FN ${dev.side.fn}), suggestions on a person's messages ${(dev.personSuggestedRate * 100).toFixed(1)}%, mean state ${dev.meanStateBytes} bytes.\nConfusion (expected: predicted=count):\n${confusion}`,
    `## Failures (${failures.length} sampled: carry-up false positives, carry-up false negatives, side-question errors)\n${failures.map((outcome, index) => `### Failure ${index + 1}\n${formatOutcome(outcome, cases.get(outcome.caseId)!, parent.candidate.context, notes.get(outcome.caseId))}`).join("\n\n")}`,
    `## Successes to protect (${Math.min(4, successes.length)} sampled)\n${sample(successes, 4).map((outcome, index) => `### Success ${index + 1}\n${formatOutcome(outcome, cases.get(outcome.caseId)!, parent.candidate.context, notes.get(outcome.caseId))}`).join("\n\n")}`,
    contextOnly
      ? "## Your move\nChange ONLY the context policy this time: which fields are sent, how many recent messages and how long, how long the judged message, how many earlier outputs, whether the parent or the summary or the carried-up count is sent, and the order. Keep the question text identical, except remove from the focus any field the new policy no longer sends. Pick a change that tests one idea about what context this decision needs."
      : "## Your move\nPropose one child: change the question text, the context policy, or both. Target the largest recurring error class you can see. Prefer removing or sharpening a line to adding one.",
  ].join("\n\n");
  return client.structured<Proposal>({
    model: reflector,
    messages: [
      { role: "system", content: REFLECTION_SYSTEM },
      { role: "user", content: user },
    ],
    schemaName: "gepa_proposal",
    jsonSchema: proposalJsonSchema,
    parse: (value) => ProposalSchema.parse(value),
    reasoningEffort: "medium",
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const casesPath = resolve(option(argv, "--cases") ?? "");
  const labelsPath = resolve(option(argv, "--labels") ?? "");
  const outputPath = resolve(option(argv, "--output") ?? "");
  if (!option(argv, "--cases") || !option(argv, "--labels") || !option(argv, "--output")) throw new Error("--cases, --labels and --output are required");
  const iterations = Number(option(argv, "--iterations") ?? "30");
  const threshold = Number(option(argv, "--threshold") ?? "0.6");
  const concurrency = Number(option(argv, "--concurrency") ?? "6");
  const reflector = option(argv, "--reflector") ?? "openai/gpt-6-astra";
  const holdout = argv.includes("--holdout");
  const topK = Number(option(argv, "--top") ?? "3");
  const included = (option(argv, "--include") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  await assertProtectedEvaluationPaths([casesPath, labelsPath], [outputPath]);
  const typesafeKey = process.env.TYPESAFE_API_KEY?.trim();
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!typesafeKey) throw new Error("TYPESAFE_API_KEY is required");
  if (!holdout && !openRouterKey) throw new Error("OPENROUTER_API_KEY is required for reflection");

  const allCases = (await readFile(casesPath, "utf8")).split("\n").filter((line) => line.trim().length > 0)
    .map((line) => TurnDispositionCaseSchema.parse(JSON.parse(line)));
  const labels = new Map<string, { disposition: TurnDisposition; source?: string; note?: string }>();
  for (const line of (await readFile(labelsPath, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as { id: string; disposition: TurnDisposition; source?: string; note?: string };
    labels.set(parsed.id, parsed);
  }
  const labeled = allCases.filter((evaluationCase) => labels.has(evaluationCase.id));
  const expected = new Map(labeled.map((evaluationCase) => [evaluationCase.id, labels.get(evaluationCase.id)!.disposition]));
  const notes = new Map([...labels.entries()].filter(([, label]) => label.note).map(([id, label]) => [id, label.note!]));
  const caseById = new Map(labeled.map((evaluationCase) => [evaluationCase.id, evaluationCase]));
  const development = labeled.filter(isDevelopmentCase);
  const holdoutCases = labeled.filter((evaluationCase) => !isDevelopmentCase(evaluationCase));
  const random = seeded(20261018);

  const pool: Evaluated[] = [];
  if (existsSync(outputPath)) {
    for (const line of (await readFile(outputPath, "utf8")).split("\n")) {
      if (line.trim()) pool.push(JSON.parse(line) as Evaluated);
    }
    process.stderr.write(`resumed ${pool.length} candidates\n`);
  }
  const record = async (item: Evaluated): Promise<void> => {
    pool.push(item);
    if (!existsSync(outputPath)) await writePrivateFile(outputPath, "");
    await appendFile(outputPath, `${JSON.stringify(item)}\n`);
  };
  const summarize = (label: string, item: Metrics): string =>
    `${label}: acc ${(item.accuracy * 100).toFixed(1)}% macroF1 ${item.macroF1.toFixed(3)} carry P/R/F1 ${(item.carryUp.precision * 100).toFixed(1)}/${(item.carryUp.recall * 100).toFixed(1)}/${item.carryUp.f1.toFixed(3)} side F1 ${item.side.f1.toFixed(3)} person-sugg ${(item.personSuggestedRate * 100).toFixed(1)}% final-sugg ${(item.finalTurnSuggestedRate * 100).toFixed(1)}% bytes ${item.meanStateBytes} errors ${item.errors}`;

  if (holdout) {
    const ranked = [...pool].sort((left, right) => right.dev.macroF1 - left.dev.macroF1);
    const top = ranked.filter((item) => item.candidate.id !== "baseline").slice(0, topK);
    const extra = pool.filter((item) => included.includes(item.candidate.id) && !top.includes(item) && item.candidate.id !== "baseline");
    const chosen = [pool.find((item) => item.candidate.id === "baseline")!, ...top, ...extra];
    const personIds = new Set(holdoutCases.filter((evaluationCase) => !labels.get(evaluationCase.id)!.source?.startsWith("judge")).map((evaluationCase) => evaluationCase.id));
    const report: unknown[] = [];
    for (const item of chosen) {
      for (const run of [1, 2]) {
        const outcomes = await evaluateCandidate(item.candidate, holdoutCases, expected, typesafeKey, threshold, concurrency);
        const all = metrics(outcomes, caseById);
        const person = metrics(outcomes.filter((outcome) => personIds.has(outcome.caseId)), caseById);
        process.stdout.write(`${item.candidate.id} run ${run} holdout ${summarize("all", all)}\n${" ".repeat(item.candidate.id.length)} ${" ".repeat(6)}         ${summarize("hand-labeled", person)}\n`);
        report.push({ candidate: item.candidate.id, run, dev: item.dev, holdout: all, holdoutHandLabeled: person, outcomes });
      }
    }
    await writePrivateFile(outputPath.replace(/\.jsonl$/, "-holdout.json"), JSON.stringify({ threshold, generatedAt: new Date().toISOString(), report }, null, 1));
    return;
  }

  const client = new OpenRouterClient({ apiKey: openRouterKey!, primaryModel: reflector, fallbackModels: [] });
  const caseIds = development.map((evaluationCase) => evaluationCase.id);
  process.stderr.write(`development ${development.length} cases, holdout ${holdoutCases.length} (untouched)\n`);

  if (!pool.some((item) => item.candidate.id === "baseline")) {
    const baseline: Candidate = {
      id: "baseline",
      parent: null,
      generation: 0,
      mutation: "baseline",
      rationale: "The v2 request as shipped.",
      question: {
        instructions: turnDispositionQuestions.disposition.instructions,
        criteria: turnDispositionQuestions.disposition.criteria as Proposal["question"]["criteria"],
      },
      context: BASELINE_CONTEXT,
    };
    const outcomes = await evaluateCandidate(baseline, development, expected, typesafeKey, threshold, concurrency);
    const dev = metrics(outcomes, caseById);
    await record({ candidate: baseline, dev, scores: Object.fromEntries(outcomes.map((outcome) => [outcome.caseId, outcome.score])) });
    process.stdout.write(`${summarize("baseline", dev)}\n`);
  }

  const outcomesFor = async (item: Evaluated): Promise<CaseOutcome[]> =>
    evaluateCandidate(item.candidate, development, expected, typesafeKey, threshold, concurrency);
  const cachedOutcomes = new Map<string, CaseOutcome[]>();

  const target = pool.length + iterations;
  for (let iteration = pool.length; iteration < target; ) {
    const parent = selectParent(pool, caseIds, random);
    let parentOutcomes = cachedOutcomes.get(parent.candidate.id);
    if (!parentOutcomes) {
      parentOutcomes = await outcomesFor(parent);
      cachedOutcomes.set(parent.candidate.id, parentOutcomes);
    }
    const contextOnly = pool.length % 3 === 2;
    let proposal: Proposal;
    try {
      proposal = await reflect(client, reflector, parent, parentOutcomes, caseById, notes, contextOnly, random);
    } catch (error) {
      process.stderr.write(`reflection failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}\n`);
      continue;
    }
    const child: Candidate = {
      ...proposal,
      id: `c${String(pool.length).padStart(2, "0")}`,
      parent: parent.candidate.id,
      generation: (pool.find((item) => item.candidate.id === parent.candidate.id)?.candidate.generation ?? 0) + 1,
      mutation: contextOnly ? "context_only" : "question_and_context",
    };
    const outcomes = await evaluateCandidate(child, development, expected, typesafeKey, threshold, concurrency);
    cachedOutcomes.set(child.id, outcomes);
    const dev = metrics(outcomes, caseById);
    await record({ candidate: child, dev, scores: Object.fromEntries(outcomes.map((outcome) => [outcome.caseId, outcome.score])) });
    process.stdout.write(`${summarize(`${child.id} <- ${parent.candidate.id} (${child.mutation})`, dev)}\n   ${child.rationale.slice(0, 300).replace(/\n/g, " ")}\n`);
    iteration += 1;
  }
  const ranked = [...pool].sort((left, right) => right.dev.macroF1 - left.dev.macroF1);
  process.stdout.write(`\nTop by development macro F1:\n${ranked.slice(0, 5).map((item) => summarize(item.candidate.id, item.dev)).join("\n")}\n`);
}

await main();
