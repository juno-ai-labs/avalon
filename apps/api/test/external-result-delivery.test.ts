import { describe, expect, it } from "vitest";

import type { Message } from "@rally/contracts";

import {
  canonicalExternalResultText,
} from "../src/services/external-result-delivery";

const baseMessage: Message = {
  id: "00000000-0000-7000-8000-000000000001",
  clientMessageId: null,
  workspaceId: "00000000-0000-7000-8000-000000000002",
  workstreamId: "00000000-0000-7000-8000-000000000003",
  author: { type: "agent" },
  messageType: "text",
  textContent: " Saved result ",
  structuredContent: null,
  mentions: [],
  attachments: [],
  sequenceNumber: 1,
  createdAt: "2026-08-29T00:00:00.000Z",
  editedAt: null,
};

describe("canonical external result rendering", () => {
  it("renders ordinary result text only after receiving a canonical message", () => {
    expect(canonicalExternalResultText(baseMessage)).toBe("Saved result");
    expect(canonicalExternalResultText({ ...baseMessage, textContent: " \n " })).toBeNull();
    expect(canonicalExternalResultText(null)).toBeNull();
  });

  it("renders a saved elicitation prompt instead of its empty text column", () => {
    expect(canonicalExternalResultText({
      ...baseMessage,
      id: "00000000-0000-7000-8000-000000000004",
      messageType: "elicitation",
      textContent: "",
      structuredContent: {
        kind: "elicitation",
        elicitation: { prompt: " Which environment? " },
      },
    })).toBe("Which environment?");
  });

  it("does not fall back to unsaved elicitation data when the saved shape is invalid", () => {
    expect(canonicalExternalResultText({
      ...baseMessage,
      messageType: "elicitation",
      textContent: "",
      structuredContent: { kind: "elicitation", prompt: "Not canonical" },
    })).toBeNull();
  });

});
