import { describe, expect, it } from "vitest";
import { judgeTurnDisposition, suggestionForTurnDisposition, type TurnDispositionState } from "./turn-disposition";

const state: TurnDispositionState = {
  parent: { kind: "channel", title: "Launch" },
  conversation: { kind: "thread", title: "Fix footer", purpose: "Correct the footer link", messages_before: 3 },
  so_far: { earlier_outputs: [], carried_up_before: 1 },
  recent_messages: [{ author: "person", text: "The link is correct now. Close this out." }],
  judged_message: { author: "rally", text: "The footer link is fixed and verified. Nothing remains open.", outputs: [] },
};

describe("mark resolved classification", () => {
  it("returns the provider's resolution decision and maps it to resolution in Threads and Breakouts", async () => {
    const decision = await judgeTurnDisposition({
      typesafeApiKey: "test-key",
      state,
      fetch: async () => new Response(JSON.stringify({
        model: "jev-test",
        answers: {
          disposition: { type: "choice", choice: "mark_resolved", confidence: 0.94 },
          carried_item_kind: { type: "choice", choice: "update", confidence: 0.9 },
        },
      }), { headers: { "content-type": "application/json" } }),
    });
    expect(decision).toEqual({
      code: "mark_resolved", disposition: "mark_resolved", confidence: 0.94,
      kind: "update", kindConfidence: 0.9, model: "jev-test",
    });
    expect(suggestionForTurnDisposition(decision, "thread")).toBe("mark_resolved");
    expect(suggestionForTurnDisposition(decision, "breakout")).toBe("mark_resolved");
    expect(suggestionForTurnDisposition({ ...decision, confidence: 0.6 }, "thread")).toBeNull();
  });
});
