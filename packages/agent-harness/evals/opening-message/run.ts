import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { classifyOpeningMessage, openingMessageQuestions, type OpeningMessageDecision } from "../../src/opening-message";
import { TYPESAFE_ADDRESSING_CONFIDENCE_THRESHOLD, TYPESAFE_ADDRESSING_TIMEOUT_MS } from "../../src/index";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";

const caseSchema = z.object({
  id: z.string(),
  split: z.enum(["development", "holdout"]),
  message: z.string(),
  humanMentions: z.array(z.string()).default([]),
  connectorMentions: z.array(z.string()).default([]),
  attachmentCount: z.number().int().nonnegative().default(0),
  expected: z.enum(["prompt_to_process", "human_to_human", "conversation_description"]),
});
const [datasetArg, outputArg, questionsArg] = process.argv.slice(2);
if (!datasetArg || !outputArg) throw new Error("Usage: tsx evals/opening-message/run.ts <dataset.jsonl> <report.json> [questions.json]");
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required; a fallback-only run is not an evaluation");
const dataset = resolve(datasetArg);
const output = resolve(outputArg);
const questionsPath = questionsArg ? resolve(questionsArg) : undefined;
await assertProtectedEvaluationPaths([dataset, ...(questionsPath ? [questionsPath] : [])], [output]);
const questions = questionsPath
  ? z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(questionsPath, "utf8")))
  : openingMessageQuestions;
const raw = await readFile(dataset, "utf8");
const cases = raw.split("\n").filter((line) => line.trim()).map((line) => caseSchema.parse(JSON.parse(line)));
const results: Array<z.infer<typeof caseSchema> & {
  decision: OpeningMessageDecision; latencyMs: number; diagnostics: unknown[];
}> = [];
for (const example of cases) {
  const diagnostics: unknown[] = [];
  const started = performance.now();
  const decision = await classifyOpeningMessage({
    ...example, typesafeApiKey: process.env.TYPESAFE_API_KEY,
    // Evaluation-only prompt substitution: retain production state, transport,
    // deadline, response parsing, and fallback policy for every candidate.
    fetch: async (url, init) => {
      const payload = JSON.parse(String(init?.body));
      return globalThis.fetch(url, { ...init, body: JSON.stringify({ ...payload, questions }) });
    },
    onDiagnostic: (event) => {
      diagnostics.push(event.stage === "model_request"
        ? { ...event, requestPayload: { ...event.requestPayload, questions } }
        : event);
    },
  });
  results.push({ ...example, decision, latencyMs: performance.now() - started, diagnostics });
}
const aggregate = (split: "development" | "holdout") => {
  const selected = results.filter((result) => result.split === split);
  return {
    count: selected.length,
    correct: selected.filter((result) => result.decision.classification === result.expected).length,
    missedPrompts: selected.filter((result) => result.expected === "prompt_to_process"
      && result.decision.classification !== "prompt_to_process").length,
    unwantedRuns: selected.filter((result) => result.expected !== "prompt_to_process"
      && result.decision.classification === "prompt_to_process").length,
    unavailable: selected.filter((result) => result.decision.outcome === "unavailable").length,
  };
};
const summary = { development: aggregate("development"), holdout: aggregate("holdout") };
await writePrivateFile(output, JSON.stringify({
  corpusSha256: createHash("sha256").update(raw).digest("hex"),
  questions,
  confidenceThreshold: TYPESAFE_ADDRESSING_CONFIDENCE_THRESHOLD,
  timeoutMs: TYPESAFE_ADDRESSING_TIMEOUT_MS,
  summary, results,
}, null, 2));
console.log(JSON.stringify(summary));
