import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";
import { caseSchema, choices } from "./evaluation";
import { comparePolicies, sweepConfidence, verificationPrompt } from "./policies";

const [outputArg, ...reportArgs] = process.argv.slice(2);
if (!outputArg || !reportArgs.length) throw new Error("Usage: compare-policies.ts <comparison.json> <saved-report.json> [...reports]");
const output = resolve(outputArg), inputs = reportArgs.map((p) => resolve(p));
await assertProtectedEvaluationPaths(inputs, [output]);
const reportSchema = z.object({
  summary: z.object({ model: z.string(), corpusSha256: z.string(), questionsSha256: z.string() }),
  results: z.array(caseSchema.extend({
    answer: z.object({ choice: z.enum(choices), confidence: z.number().min(0).max(1) }).nullable(),
    failure: z.string().nullable(), nudge: z.boolean(), latencyMs: z.number(),
    requestBytes: z.number(), inputTokens: z.number().nullable(),
  })),
});
const sources = await Promise.all(inputs.map(async (path) => {
  const text = await readFile(path, "utf8");
  return { report: reportSchema.parse(JSON.parse(text)), sha256: createHash("sha256").update(text).digest("hex") };
}));
const results = sources.flatMap((source) => source.report.results);
if (new Set(results.map((r) => r.id)).size !== results.length) throw new Error("Reports contain duplicate cases; select one revision per suite");
const report = {
  createdAt: new Date().toISOString(), method: "Deterministic policy replay of saved JEV answers; no new inference or recovery execution.",
  preference: "Missed reprompts cost more than an extra verification turn. Use one verification per eligible activation.",
  limitations: ["Cases and answers were already inspected; this is not a fresh holdout.",
    "Zero missed reprompts under verify_once is true by construction for ready cases, not evidence of successful task completion.",
    "The corpus does not label action-request admission separately; verify_once overhead includes eligible non-action replies.",
    "Lifecycle flags are curated offline. The host still needs an authoritative one-use recovery marker and pending-job state."],
  sources: sources.map((s) => ({ ...s.report.summary, reportSha256: s.sha256 })),
  policySourceSha256: createHash("sha256").update(await readFile(new URL("policies.ts", import.meta.url))).digest("hex"),
  verificationPrompt, comparison: comparePolicies(results),
  confidenceSweep: {
    semantics: "strict reprompts only unfinished_work above the threshold; uncertainty_fallback reprompts unfinished/unclear/unavailable/unresolved or confidence at or below the threshold. Lifecycle exclusions apply to all policies.",
    selection: "Exploratory 0.00–1.00 sweep in 0.05 increments over already observed answers. No production threshold change or new holdout claim.",
    rows: sweepConfidence(results, Array.from({ length: 21 }, (_, i) => i / 20)),
  },
};
await writePrivateFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.comparison));
console.log(JSON.stringify(report.confidenceSweep.rows.map((row) => ({ threshold: row.threshold,
  strict: { missed: row.policies.strict!.missed, extra: row.policies.strict!.extraVerificationTurns },
  fallback: { missed: row.policies.uncertainty_fallback!.missed, extra: row.policies.uncertainty_fallback!.extraVerificationTurns },
}))));
