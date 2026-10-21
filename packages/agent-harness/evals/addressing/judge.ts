import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { AddressingClassificationSchema } from "@rally/contracts";
import type { AddressingClassification } from "@rally/contracts";
import { AddressingEvaluationCaseSchema } from "../../src/addressing-evaluation";
import { AzureOpenAIClient, renderAddressingMessages } from "../../src/index";
import { assertProtectedEvaluationPaths, writePrivateFile } from "./secure-paths";

const EvaluationReportSchema = z.object({
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  models: z.array(z.object({ model: z.string().min(1) }).passthrough()),
  results: z.array(z.object({
    caseId: z.string().min(1),
    model: z.string().min(1),
    expected: AddressingClassificationSchema.nullable(),
    actual: AddressingClassificationSchema.optional(),
    latencyMs: z.number().nonnegative(),
    error: z.string().optional(),
    resolvedModels: z.array(z.string()).optional(),
    cascadeRoute: z.enum(["not_needed", "typesafe", "fallback", "terminal_heuristic"]).optional(),
    cascadeFallbackReason: z.enum(["low_confidence", "typesafe_failure"]).optional(),
    typesafeConfidence: z.number().min(0).max(1).optional(),
  })),
});
type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const result = index === -1 ? fallback : process.argv[index + 1] ?? fallback;
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function classificationFromText(text: string): AddressingClassification {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("Sol returned no JSON object");
  return AddressingClassificationSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

async function main(): Promise<void> {
  const datasetPath = resolve(argument("--dataset"));
  const reportPath = resolve(argument("--report"));
  const outputPath = resolve(argument("--output"));
  await assertProtectedEvaluationPaths([datasetPath, reportPath], [outputPath]);
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const apiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
  if (!endpoint || !apiKey) throw new Error("AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are required");
  const datasetSource = await readFile(datasetPath, "utf8");
  const datasetSha256 = createHash("sha256").update(datasetSource).digest("hex");
  const cases = datasetSource.trim().split("\n")
    .map((line) => AddressingEvaluationCaseSchema.parse(JSON.parse(line)));
  const reportSource = await readFile(reportPath, "utf8");
  const report = EvaluationReportSchema.parse(JSON.parse(reportSource)) as EvaluationReport;
  if (report.datasetSha256 !== datasetSha256) {
    throw new Error("The evaluation report was produced from a different dataset SHA-256");
  }
  const disagreements = new Set(report.results.filter((result) =>
    result.expected !== null
      && result.actual !== undefined
      && result.expected.classification !== result.actual.classification)
    .map((result) => result.caseId));
  for (const evaluationCase of cases) {
    if (evaluationCase.expected === null) disagreements.add(evaluationCase.id);
  }
  const client = new AzureOpenAIClient({ endpoint, apiKey });
  const judgments = [];
  for (const [index, evaluationCase] of cases.filter((item) => disagreements.has(item.id)).entries()) {
    const messages = renderAddressingMessages(evaluationCase.input);
    messages[messages.length - 1]!.content += `\n\nReturn only JSON with exactly these fields:\n`
      + `{"classification":"agent_action|human_only|both|uncertain","confidence":0.0,"rationaleCode":"imperative|question|connector_mention|rally_reference|active_task|elicitation_answer|human_coordination|social_acknowledgement|insufficient_signal"}`;
    let content = "";
    const startedAt = performance.now();
    try {
      await client.stream({
        model: "gpt-5.6-sol",
        messages,
        includeWebSearch: false,
        reasoningEffort: "medium",
      }, (delta) => { content += delta; });
      const sol = classificationFromText(content);
      const candidates = Object.fromEntries(report.models.map(({ model }) => {
        const result = report.results.find((item) => item.model === model && item.caseId === evaluationCase.id);
        return [model, result?.actual ?? null];
      }));
      judgments.push({
        caseId: evaluationCase.id,
        production: evaluationCase.expected,
        candidates,
        sol,
        supportsProduction: evaluationCase.expected !== null
          && sol.classification === evaluationCase.expected.classification,
        latencyMs: Math.round(performance.now() - startedAt),
      });
      process.stderr.write(`Sol medium ${index + 1}/${disagreements.size} ok\n`);
    } catch (error) {
      judgments.push({
        caseId: evaluationCase.id,
        production: evaluationCase.expected,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        latencyMs: Math.round(performance.now() - startedAt),
      });
      process.stderr.write(`Sol medium ${index + 1}/${disagreements.size} error\n`);
    }
  }
  const output = {
    generatedAt: new Date().toISOString(),
    datasetSha256,
    sourceReportSha256: createHash("sha256").update(reportSource).digest("hex"),
    judge: { model: "openai/gpt-5.6-sol", providerModel: "gpt-5.6-sol", reasoningEffort: "medium" },
    disagreementCases: disagreements.size,
    judgments,
  };
  await writePrivateFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    datasetSha256,
    disagreementCases: disagreements.size,
    completed: judgments.filter((judgment) => "sol" in judgment).length,
    errors: judgments.filter((judgment) => "error" in judgment).length,
    output: outputPath,
  }, null, 2)}\n`);
}

await main();
