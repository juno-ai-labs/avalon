import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

const { createToolEffectIntents } = __integrationTesting;

const integrationsSource = readFileSync(
  new URL("../src/services/integrations.ts", import.meta.url),
  "utf8",
);

function section(start: string, end: string): string {
  const startIndex = integrationsSource.indexOf(start);
  const endIndex = integrationsSource.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return integrationsSource.slice(startIndex, endIndex);
}

function expectOrdered(source: string, markers: readonly string[]): void {
  let previousIndex = -1;
  for (const marker of markers) {
    const markerIndex = source.indexOf(marker);
    expect(markerIndex, `missing marker: ${marker}`).toBeGreaterThan(previousIndex);
    previousIndex = markerIndex;
  }
}

describe("the receipt a tool's effects are keyed to", () => {
  it("answers per call, so concurrent tools cannot take each other's receipt", () => {
    const intents = createToolEffectIntents();

    intents.record("run-1:turn:1:tool:0", "receipt-a");
    intents.record("run-1:turn:1:tool:1", "receipt-b");

    // Both, not just the last. `runsSerially` lets a turn's tool calls execute
    // concurrently, so a single latest-receipt slot would hand the first tool
    // the second one's identity.
    expect(intents.resolve("run-1:turn:1:tool:0")).toBe("receipt-a");
    expect(intents.resolve("run-1:turn:1:tool:1")).toBe("receipt-b");
  });

  it("has no answer for a call it never recorded", () => {
    const intents = createToolEffectIntents();
    intents.record("run-1:turn:1:tool:0", "receipt-a");

    // Absent rather than a nearby guess: Bind omits the field entirely on
    // `undefined`, and every Terminal write then fails closed. Returning some
    // other call's receipt would key an external effect to the wrong row.
    expect(intents.resolve("run-1:turn:1:tool:9")).toBeUndefined();
    expect(intents.resolve("")).toBeUndefined();
  });

  it("re-recording a call replaces its receipt rather than keeping the first", () => {
    const intents = createToolEffectIntents();

    intents.record("run-1:turn:1:tool:0", "receipt-a");
    intents.record("run-1:turn:1:tool:0", "receipt-b");

    // `persistToolExecutionPlan` is what decides which row survives a replan;
    // this only ever reports its latest answer for the coordinate.
    expect(intents.resolve("run-1:turn:1:tool:0")).toBe("receipt-b");
  });
});

/**
 * The seam above is only worth anything if the shared substream harness is wired to
 * it, and that wiring is reachable only by running a whole harness against a
 * provider. Deleting the `record` call leaves every suite green and breaks
 * every Terminal write in production with `tool_receipt_missing`, so the
 * ordering is asserted against the source the way
 * `harness-liveness-monitor-lifecycle.test.ts` asserts the run lifecycle.
 */
describe("the shared substream harness records and resolves through that seam", () => {
  it("records the substream run's receipt from the plan, then answers Bind with it", () => {
    const root = section(
      "export async function runWorkstreamHarness(",
      "function azureInferenceConfig(",
    );

    expectOrdered(root, [
      "const toolEffectIntents = createToolEffectIntents();",
      "resolveToolEffectIntentId: toolEffectIntents.resolve,",
      "case \"tool_started\": {",
      "const receipt = await persistToolExecutionPlan(",
      "toolEffectIntents.record(event.toolCallId, receipt.invocationId);",
    ]);
  });

  it("keeps the recorded value the plan's own answer, not the call coordinate", () => {
    // The whole point of the change: `receipt.invocationId` is the row
    // `persistToolExecutionPlan` settled on, which is not `event.toolCallId`.
    expect(integrationsSource).not.toContain("record(event.toolCallId, event.toolCallId)");
    expect(
      integrationsSource.match(/EffectIntents\.record\(event\.toolCallId, receipt\.invocationId\)/gu),
    ).toHaveLength(1);
  });
});
