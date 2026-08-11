import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";

describe("Bind host durability boundaries", () => {
  it("returns preload candidates to Bind only after their activation is persisted", async () => {
    const order: string[] = [];
    const persisted = new Set<string>();
    let signalPersistStarted!: () => void;
    let releasePersistence!: () => void;
    const persistStarted = new Promise<void>((resolve) => { signalPersistStarted = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });

    const preparing = __integrationTesting.persistInitialPluginActivations(
      ["connection:preload", "connection:revoked", "connection:preload"],
      async (pluginId) => {
        order.push(`reauthorize:${pluginId}`);
        return pluginId === "connection:revoked" ? "denied" : "authorized";
      },
      async (pluginId) => {
        order.push(`persist:start:${pluginId}`);
        signalPersistStarted();
        await persistenceGate;
        persisted.add(pluginId);
        order.push(`persist:finish:${pluginId}`);
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
      "persist:start:connection:preload",
      "persist:finish:connection:preload",
      "reauthorize:connection:revoked",
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
});
