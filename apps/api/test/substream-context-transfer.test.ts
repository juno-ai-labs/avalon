import { describe, expect, it } from "vitest";
import { asSubstreamId, asWorkspaceId, asWorkstreamId, ServerSocketEventSchema, WORKSTREAM_REALTIME_MAX_FRAME_BYTES } from "@rally/contracts";
import type { SubstreamInitialContext } from "@rally/contracts/substream-creation";
import { initialContextFrames } from "../src/durable-objects/substream-context-transfer";

const address = { sequence: 0, snapshotId: "snapshot", occurredAt: "2026-09-04T12:00:00.000Z" };

describe("initial context snapshot transfer", () => {
  it("does not send a context transfer for a main conversation without a seed", () => {
    expect(initialContextFrames(null, address)).toEqual([]);
  });

  it("round-trips a multi-frame seed with escaped and non-ASCII text without exceeding the transport ceiling", () => {
    const context: SubstreamInitialContext = {
      source: { workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000001"),
        workstreamId: asWorkstreamId("00000000-0000-7000-8000-000000000002"), substreamId: asSubstreamId("0") },
      throughTurnId: null, policyRevision: "test", contentHash: "a".repeat(64),
      parts: [{ kind: "summary", text: '\u0000"\\😀'.repeat(WORKSTREAM_REALTIME_MAX_FRAME_BYTES),
        requestedModel: "test", resolvedModel: "test", inputTokens: 1, outputTokens: 1 }],
    };
    const frames = initialContextFrames(context, address);
    expect(frames.length).toBeGreaterThan(1);
    for (const [index, frame] of frames.entries()) {
      const encoded = JSON.stringify(frame);
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(WORKSTREAM_REALTIME_MAX_FRAME_BYTES);
      expect(ServerSocketEventSchema.parse(JSON.parse(encoded))).toMatchObject({ ...address, chunkIndex: index, chunkCount: frames.length });
    }
    expect(JSON.parse(frames.map((frame) => JSON.parse(JSON.stringify(frame)).json).join(""))).toEqual(context);
  });
});
