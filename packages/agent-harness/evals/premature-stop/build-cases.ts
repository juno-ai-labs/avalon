import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";
import { annotationSchema, buildCases, rawSchema } from "./build";

const [rawArg, annotationsArg, outputArg] = process.argv.slice(2);
if (!rawArg || !annotationsArg || !outputArg) throw new Error("Usage: build-cases.ts <raw.jsonl> <annotations.jsonl> <cases.jsonl>");
const rawPath = resolve(rawArg), annotationsPath = resolve(annotationsArg), outputPath = resolve(outputArg);
await assertProtectedEvaluationPaths([rawPath, annotationsPath], [outputPath]);
const lines = (text: string) => text.split("\n").filter((s) => s.trim()).map((s): unknown => JSON.parse(s));
const raw = lines(await readFile(rawPath, "utf8")).map((r) => rawSchema.parse(r));
const annotations = lines(await readFile(annotationsPath, "utf8")).map((a) => annotationSchema.parse(a));
const cases = buildCases(raw, annotations);
await writePrivateFile(outputPath, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
console.log(JSON.stringify({ count: cases.length, development: cases.filter((c) => c.split === "development").length,
  holdout: cases.filter((c) => c.split === "holdout").length }));
