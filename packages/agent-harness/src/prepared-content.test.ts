import { describe, it, expect } from "vitest";
import { checkpointFromContent, forkLoopCheckpoint, parseLoopCheckpoint, serializeLoopCheckpoint } from "./prepared-content";

describe("prepared content checkpoints", () => {
  it("uses Bind serialization and forks independent eval identities and budgets", () => {
    const checkpoint = checkpointFromContent({
      executionId: "fixture", maxIterations: 3,
      bindings: { configuration: { model: "test" }, environment: { fixture: "comments" } },
      content: { messages: [{ role: "user", text: "Question" }, { role: "assistant", text: "Answer" }] },
    });
    const restored = parseLoopCheckpoint(JSON.parse(serializeLoopCheckpoint(checkpoint)));
    const fork = forkLoopCheckpoint(restored, { executionId: "evaluation", maxIterations: 7, bindings: restored.bindings });
    expect(fork.state.messages).toEqual([{ role: "user", content: "Question" }, { role: "assistant", content: "Answer" }]);
    expect(fork.executionId).toBe("evaluation");
    expect(fork.maxIterations).toBe(7);
    expect(checkpoint.executionId).toBe("fixture");
    expect(fork.iterationsUsed).toBe(0);
  });
});
