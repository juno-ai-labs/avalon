import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migratableClasses = [
  "block-dashboard-agent.ts",
  "substream-agent.ts",
  "workspace-do.ts",
  "workstream-do.ts",
] as const;

describe("Durable Object initialization instrumentation", () => {
  it.each(migratableClasses)("routes %s constructor work through the timed base gate", (fileName) => {
    const source = readFileSync(`${process.cwd()}/src/durable-objects/${fileName}`, "utf8");
    expect(source).toContain("this.initialized = this.initializeDurableObject(async () => {");
    expect(source).not.toContain("this.initialized = state.blockConcurrencyWhile(async () => {");
  });
});
