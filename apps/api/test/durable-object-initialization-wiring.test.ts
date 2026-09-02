import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Deliberately structural: the invariant is that every future constructor uses
// the one shared input gate. Keep the exact strings close to the call sites so
// formatting-only changes fail visibly instead of silently weakening coverage.
const migratableClasses = [
  "block-dashboard-agent.ts",
  "substream-agent.ts",
  "workspace-do.ts",
  "workstream-do.ts",
] as const;

describe("Durable Object initialization instrumentation", () => {
  it.each(migratableClasses)("routes %s constructor work through the timed base gate", (fileName) => {
    const source = readFileSync(`${process.cwd()}/src/durable-objects/${fileName}`, "utf8");
    const timedGate = fileName === "substream-agent.ts"
      ? "this.storageReady = this.initializeDurableObject(async () => {"
      : "this.initialized = this.initializeDurableObject(async () => {";
    expect(source).toContain(timedGate);
    if (fileName === "substream-agent.ts") {
      expect(source).toContain("this.runtimeRecoveryAttempt = () => this.storageReady.then(");
      expect(source).toContain("if (this.runtimeRecovery === attempt) this.runtimeRecovery = null;");
    }
    expect(source).not.toContain("this.initialized = state.blockConcurrencyWhile(async () => {");
  });
});
