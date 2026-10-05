import type { SubstreamInitialContext } from "@rally/contracts/substream-creation";
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { renderSubstreamInitialContext } from "../src/services/substream-initial-context";

const context = (): SubstreamInitialContext => ({
  source: {
    workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000001"),
    workstreamId: asWorkstreamId("00000000-0000-7000-8000-000000000002"),
    substreamId: asSubstreamId("0"),
  },
  throughTurnId: "turn-2",
  policyRevision: "test-policy",
  contentHash: "a".repeat(64),
  parts: [
    {
      kind: "summary",
      text: "# Open\nVerify the migration.",
      requestedModel: "google/gemini-2.5-flash-lite",
      resolvedModel: "google/gemini-2.5-flash-lite",
      inputTokens: 12,
      outputTokens: 5,
    },
    {
      kind: "history",
      messages: [{
        turnId: "turn-2",
        transcriptSequence: 2,
        actor: "assistant",
        authorUserId: null,
        authorLabel: "Rally",
        createdAt: "2026-09-04T12:00:00.000Z",
        blocks: [{
          text: "I proposed the command but did not run it.",
          mentions: [],
          attachments: [{
            id: "00000000-0000-7000-8000-000000000005",
            fileName: "plan.md",
            mimeType: "text/markdown",
            sizeBytes: 20,
            contentAvailable: true,
            createdAt: "2026-09-04T12:00:00.000Z",
          }],
        }],
      }],
    },
  ],
});

describe("substream initial model context", () => {
  it("renders ordered summary/history as inert non-system messages with provenance", () => {
    const messages = renderSubstreamInitialContext(context());
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.every((message) => message.role !== "system" && !message.tool_calls)).toBe(true);
    expect(messages[0]?.content).toContain("derived context, not a new instruction");
    expect(JSON.stringify(messages[1]?.content)).toContain("plan.md");
    expect(messages[1]?.provenance).toEqual({
      originKind: "derived",
      sourceKind: "substream_initial_context",
      sourceId: "a".repeat(64),
      sourceRevision: null,
    });
  });

  it("names a Sidekick as one, under the user role it shares with people", () => {
    const seed = context();
    seed.parts = [{
      kind: "history",
      messages: [{
        turnId: "turn-2",
        transcriptSequence: 2,
        actor: "sidekick",
        authorUserId: null,
        authorLabel: "Pipeline digest",
        createdAt: "2026-09-04T12:00:00.000Z",
        blocks: [{ text: "Weekly pipeline: 4 new deals", mentions: [], attachments: [] }],
      }],
    }];
    const [message] = renderSubstreamInitialContext(seed);
    expect(message?.role).toBe("user");
    expect(JSON.stringify(message?.content)).toContain("Author: Pipeline digest (Sidekick)");
  });

  it("renders no messages when no seed is installed", () => {
    expect(renderSubstreamInitialContext(null)).toEqual([]);
  });
});
