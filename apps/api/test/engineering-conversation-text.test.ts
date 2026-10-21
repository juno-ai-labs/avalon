import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import { TranscriptTurnSchema } from "@rally/contracts";
import { conversationAsText } from "../src/services/conversation-text";

const at = "2026-10-21T00:00:00.000Z";
function turn(blocks: unknown[], changes = {}) {
  return TranscriptTurnSchema.parse({ transcriptSequence: 1, turnId: "turn-1", entryKind: "conversation",
    actor: "human", authorUserId: "user-1", authorSnapshot: { userId: "user-1", displayName: "Maya", avatarUrl: null },
    attentionOrdinal: 1, createdAtUtc: at, revision: 1, activityId: null, blocks, ...changes });
}
function text(body: string, changes = {}) {
  return { type: "text", blockId: "block-1", blockIndex: 0, text: body, streaming: false, ...changes };
}

describe("engineering conversation prose", () => {
  it("renders readable text, frozen bylines, attachments and chronological blocks", () => {
    expect(conversationAsText([turn([
      text("Second", { blockIndex: 1, blockId: "block-2" }),
      text("**First** [guide](https://example.com/guide)", { attachments: [{ id: "00000000-0000-7000-8000-00000000ee01", fileName: "plan.pdf", mimeType: "application/pdf", sizeBytes: 10, contentAvailable: true, createdAt: at }] }),
    ])])).toBe("Maya · 2026-10-21T00:00:00.000Z\nFirst guide\n\nAttachment: plan.pdf\n\nSecond");
  });

  it("omits tool payloads, thinking and internal mailbox prose", () => {
    const hidden = turn([
      { type: "tool", blockId: "tool", blockIndex: 0, toolCallId: "call", pluginId: null, toolName: "secret-tool", callIndex: 0, status: "completed", participantSafeInput: "secret-input", participantSafeResult: "secret-result", error: null, activityId: null },
      { type: "thinking", blockId: "thinking", blockIndex: 1, providerEvidence: "reasoning_summary", summary: null, activityId: "thinking" },
      text("internal mailbox", { blockIndex: 2, structuredContent: { kind: "agent_message" } }),
      text("suggested prompt", { blockIndex: 3, messageType: "suggestion" }),
    ], { transcriptSequence: 2 });
    expect(conversationAsText([hidden])).toBe("");
    expect(conversationAsText([turn([text("Opening instructions", { structuredContent: { kind: "agent_message" } })])])).toContain("Opening instructions");
  });

  it("uses the app's hidden personal-instruction rule", () => {
    const prompt = "<user_system_prompt>\nThe following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.\n<user_suppplied>\nPrivate instructions\n</user_suppplied>\n</user_system_prompt>\n\nVisible message";
    expect(conversationAsText([turn([text(prompt)])])).toBe("Maya · 2026-10-21T00:00:00.000Z\nVisible message");
  });

  it("includes annotation comments without exposing model instructions or resource locators", () => {
    const structuredContent = { kind: "artifact_annotations", annotations: [{
      target: { resourceId: "00000000-0000-7000-8000-00000000ee01", version: 1, locator: { type: "file" } },
      content: { exact: "Internal resource metadata", source: "exact", before: "", after: "", truncated: false },
      comment: "Make the introduction shorter.",
    }] };
    expect(conversationAsText([turn([text("Please revise.", { structuredContent })])]))
      .toBe("Maya · 2026-10-21T00:00:00.000Z\nPlease revise.\n\nMake the introduction shorter.");
  });

  it("renders elicitation questions and options without structured internals", () => {
    const elicitation = { id: "00000000-0000-7000-8000-00000000ee01", workstreamId: "00000000-0000-7000-8000-00000000ee02", harnessRunId: "00000000-0000-7000-8000-00000000ee03", prompt: "When should we ship?", responseType: "radio", options: [{ value: "release_slot_2", label: "Today", description: null }], minimumSelections: 1, maximumSelections: 1, targetUserId: null, status: "answered", answer: "release_slot_2", answeredByUserId: null, createdAt: at, answeredAt: at };
    expect(conversationAsText([turn([text("", { messageType: "elicitation", structuredContent: { elicitation } })])])).toBe("Maya · 2026-10-21T00:00:00.000Z\nWhen should we ship?\n- Today\nAnswer: Today");
    expect(conversationAsText([turn([text("", { messageType: "elicitation", structuredContent: {
      elicitation: { ...elicitation, responseType: "multi_select", maximumSelections: null, answer: ["release_slot_2", "After the demo"] },
    } })])])).toContain("Answer: Today, After the demo");
  });
});
