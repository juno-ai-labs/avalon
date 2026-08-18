import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

describe("Bind host durability boundaries", () => {
  it("returns preload candidates to Bind only after their activation is persisted", async () => {
    const order: string[] = [];
    const persisted = new Set<string>();
    const prepared = new Set<string>();
    let signalPersistStarted!: () => void;
    let releasePersistence!: () => void;
    const persistStarted = new Promise<void>((resolve) => { signalPersistStarted = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });

    const preparing = __integrationTesting.persistInitialPluginActivations(
      ["connection:preload", "connection:revoked", "connection:unavailable", "connection:preload"],
      async (pluginId) => {
        order.push(`reauthorize:${pluginId}`);
        return pluginId === "connection:revoked" ? "denied" : "authorized";
      },
      async (pluginId) => {
        expect(prepared.has(pluginId)).toBe(true);
        order.push(`persist:start:${pluginId}`);
        signalPersistStarted();
        await persistenceGate;
        persisted.add(pluginId);
        order.push(`persist:finish:${pluginId}`);
      },
      async (pluginId) => {
        order.push(`prepare:${pluginId}`);
        if (pluginId === "connection:unavailable") return false;
        prepared.add(pluginId);
        return true;
      },
    );

    await persistStarted;
    let finished = false;
    void preparing.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);

    releasePersistence();
    const activationHints = await preparing;

    expect(activationHints).toEqual(["connection:preload"]);
    expect(activationHints.every((pluginId) => persisted.has(pluginId))).toBe(true);
    expect(order).toEqual([
      "reauthorize:connection:preload",
      "prepare:connection:preload",
      "persist:start:connection:preload",
      "persist:finish:connection:preload",
      "reauthorize:connection:revoked",
      "reauthorize:connection:unavailable",
      "prepare:connection:unavailable",
    ]);
  });

  it("omits a final message id for an empty elicitation needs-input run", () => {
    const messageId = "00000000-0000-4000-8000-000000000003";
    const result = __integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "needs_input" },
      streamedText: "",
      messageId,
      ambiguousToolOutcome: false,
      stoppedByUser: false,
    });

    expect(result).toEqual({ status: "needs_input" });
    expect("messageId" in result).toBe(false);
    expect(__integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "needs_input" },
      streamedText: "I need one detail before continuing.",
      messageId,
      ambiguousToolOutcome: false,
      stoppedByUser: false,
    })).toEqual({ status: "needs_input", messageId });
  });

  it("says why an ambiguous halt stopped the run, which nothing else may record", () => {
    const messageId = "00000000-0000-4000-8000-000000000003";
    // An elicitation leaves a question in the transcript to answer. An
    // ambiguity that collided with an already-settled receipt leaves the row
    // untouched, so the run is the only thing left that can explain itself.
    expect(__integrationTesting.workstreamHarnessTerminalResult({
      outcome: { status: "completed" },
      streamedText: "I will locate the repository.",
      messageId,
      ambiguousToolOutcome: true,
      stoppedByUser: false,
    })).toEqual({
      status: "needs_input",
      messageId,
      error: {
        code: "ambiguous_external_write",
        message: "An external action's outcome could not be confirmed, so Avalon stopped instead of repeating it",
      },
    });
  });
});
