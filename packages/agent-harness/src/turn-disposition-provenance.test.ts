import { describe, expect, it } from "vitest";
import { renderTurnDispositionMessages } from "./prompts/turn-disposition";
import { TURN_DISPOSITION_MAX_TITLE_CODE_POINTS, type TurnDispositionState } from "./turn-disposition";

const state: TurnDispositionState = {
  parent: { kind: "channel", title: "General" },
  conversation: { kind: "thread", title: "Demo launch", purpose: "Prepare the demo", messages_before: 1 },
  so_far: { earlier_outputs: [], carried_up_before: 0 },
  recent_messages: [],
  judged_message: { author: "person", text: "The demo schedule is ready.", outputs: [] },
};

describe("turn disposition provenance", () => {
  it("bounds Breakout titles by code point without splitting an emoji", () => {
    const input: TurnDispositionState = { ...state, judged_message: {
      ...state.judged_message, merged_from: { kind: "breakout", title: "🚀".repeat(TURN_DISPOSITION_MAX_TITLE_CODE_POINTS + 1) },
    } };
    const messages = renderTurnDispositionMessages(input);
    expect(JSON.parse(String(messages[1]!.content)).judged_message).toEqual({
      author: "person", text: "The demo schedule is ready.", outputs: [],
      merged_from: { kind: "breakout", title: `${"🚀".repeat(199)}…` },
    });
  });
});
