import { describe, expect, it } from "vitest";
import { ConversationSuggestionSchema, SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS, suggestionTurnIsVisible } from "./conversation-suggestions";
import { safeParseSocketEvent } from "./socket-events";
import { ServerSocketEventSchema } from "./index";

describe("suggestionTurnIsVisible", () => {
  it("shows a turn while fewer than three newer messages exist and hides it at the third", () => {
    expect(SUGGESTION_VISIBLE_WITHIN_NEWEST_TURNS).toBe(3);
    expect(suggestionTurnIsVisible("t2", ["t1", "t2"])).toBe(true);
    expect(suggestionTurnIsVisible("t2", ["t1", "t2", "t3", "t4"])).toBe(true);
    expect(suggestionTurnIsVisible("t2", ["t1", "t2", "t3", "t4", "t5"])).toBe(false);
    expect(suggestionTurnIsVisible("t9", ["t1", "t2"])).toBe(false);
  });
});

describe("conversation suggestions on the socket", () => {
  const suggestion = {
    suggestionId: "00000000-0000-7000-8000-000000000031",
    kind: "merge_up",
    judgedTurnId: "turn-2",
    status: "open",
    draft: { status: "pending", text: null, subject: null },
    target: { kind: "thread", id: "00000000-0000-7000-8000-000000000032", title: "Pricing" },
  };

  it("parses the changed event and the snapshot's optional list", () => {
    expect(ConversationSuggestionSchema.parse(suggestion)).toEqual(suggestion);
    const event = safeParseSocketEvent(ServerSocketEventSchema, {
      type: "conversation_suggestion_changed", sequence: 4, occurredAt: "2026-10-18T10:00:00.000Z", suggestion,
    });
    expect(event.success).toBe(true);
  });

  it("is stripped from a snapshot by a parser that does not know the key, so an older build keeps its snapshot", () => {
    // The snapshot schema as a build before this field parsed it: the same
    // object with the key removed is what `safeParseSocketEvent` faces there.
    const snapshot = {
      type: "snapshot", sequence: 1, occurredAt: "2026-10-18T10:00:00.000Z", reason: "initial",
      workstream: null, transcript: null, pendingInputChunkCount: 0, suggestions: [suggestion],
    };
    const stripped = safeParseSocketEvent(
      ServerSocketEventSchema.options[0]!.omit({ suggestions: true, workstream: true, transcript: true }).strict(),
      { ...snapshot, workstream: undefined, transcript: undefined },
    );
    expect(stripped.success).toBe(true);
  });
});
