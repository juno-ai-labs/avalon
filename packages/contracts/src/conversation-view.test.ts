import { expect, it } from "vitest";
import { projectConversationView } from "./conversation-view";
import { TranscriptRangeResultSchema } from "./workstream-transcript";

it("keeps visible text, attachments, and plugin timing but strips every tool payload and call identity", () => {
  const range = TranscriptRangeResultSchema.parse({
    purpose: "latest", requested: { startInclusive: 1, endExclusive: 2 }, covered: { startInclusive: 1, endExclusive: 2 },
    turns: [{
      transcriptSequence: 1, turnId: "turn", entryKind: "conversation", actor: "assistant",
      authorUserId: null, authorSnapshot: null, attentionOrdinal: null, createdAtUtc: "2026-10-20T00:00:00.000Z",
      revision: 1, activityId: null, blockCount: 3, blocks: [
        { type: "text", blockId: "text", blockIndex: 0, text: "Here is the result", streaming: false,
          structuredContent: { hidden: "unbounded details" }, attachments: [{
            id: "00000000-0000-7000-8000-000000000001", fileName: "result.txt", mimeType: "text/plain",
            sizeBytes: 10, contentAvailable: true, createdAt: "2026-10-20T00:00:00.000Z",
          }] },
        { type: "tool", blockId: "tool", blockIndex: 1, toolCallId: "secret-call", pluginId: "terminal",
          toolName: "secret-tool", callIndex: 0, status: "completed", participantSafeInput: { secret: "arguments" },
          participantSafeResult: { secret: "results" }, error: "details", activityId: "call-activity" },
        { type: "thinking", blockId: "thinking", blockIndex: 2, providerEvidence: "reasoning_summary",
          summary: null, activityId: "thinking-activity" },
      ],
    }],
    activities: [],
    pluginRuns: [{
      pluginRunId: "plugin", turnId: "turn", pluginId: "terminal", displayName: "Terminal",
      state: "completed", durationMs: 1250, elapsedMsAtSnapshot: null, timingAccuracy: "observed",
      toolCallIds: ["secret-call"],
    }],
  });
  const result = projectConversationView(range);
  expect(result?.turn.blocks).toEqual([{
    type: "text", blockId: "text", blockIndex: 0, text: "Here is the result", streaming: false,
    attachments: [{ id: "00000000-0000-7000-8000-000000000001", fileName: "result.txt", mimeType: "text/plain",
      sizeBytes: 10, contentAvailable: true, createdAt: "2026-10-20T00:00:00.000Z" }],
  }]);
  expect(result?.turn.blockCount).toBe(1);
  expect(result?.pluginRuns).toEqual([{
    pluginRunId: "plugin", turnId: "turn", pluginId: "terminal", displayName: "Terminal",
    state: "completed", durationMs: 1250, elapsedMsAtSnapshot: null, timingAccuracy: "observed",
  }]);
  expect(projectConversationView({ ...range, turns: [{ ...range.turns[0]!, blocks: [range.turns[0]!.blocks[1]!] }],
    pluginRuns: [] })).toBeNull();
});
