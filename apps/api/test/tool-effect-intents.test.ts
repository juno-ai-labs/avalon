import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

const { createToolEffectIntents } = __integrationTesting;

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
