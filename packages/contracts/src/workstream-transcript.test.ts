import { describe, expect, it } from "vitest";

import { TranscriptActivitySchema, TranscriptTurnSchema } from "./workstream-transcript";

const base = {
  transcriptSequence: 1,
  turnId: "turn-1",
  entryKind: "conversation" as const,
  clientMessageId: null,
  externalActor: null,
  attentionOrdinal: 1,
  createdAtUtc: "2026-08-27T12:00:00.000Z",
  revision: 1,
  blocks: [{
    type: "text" as const,
    blockId: "turn-1:text:0",
    blockIndex: 0,
    text: "Hello",
    streaming: false,
  }],
  activityId: null,
};

describe("canonical transcript author provenance", () => {
  it("accepts an immutable human snapshot tied to the stable author id", () => {
    expect(TranscriptTurnSchema.parse({
      ...base,
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: { userId: "user-1", displayName: "Ada", avatarUrl: null },
    }).authorSnapshot?.displayName).toBe("Ada");
  });

  it.each([
    ["missing user id", null, { userId: "user-1", displayName: "Ada", avatarUrl: null }],
    ["missing snapshot", "user-1", null],
    ["mismatched snapshot", "user-1", { userId: "user-2", displayName: "Ada", avatarUrl: null }],
  ])("rejects a human turn with %s", (_case, authorUserId, authorSnapshot) => {
    expect(TranscriptTurnSchema.safeParse({
      ...base,
      actor: "human",
      authorUserId,
      authorSnapshot,
    }).success).toBe(false);
  });

  it.each(["assistant", "external", "system"] as const)(
    "accepts null user provenance on a %s turn",
    (actor) => {
      expect(TranscriptTurnSchema.safeParse({
        ...base,
        actor,
        authorUserId: null,
        authorSnapshot: null,
      }).success).toBe(true);
    },
  );

  it.each([
    ["stable user id", "user-1", null],
    ["human snapshot", null, { userId: "user-1", displayName: "Ada", avatarUrl: null }],
  ])("rejects a nonhuman turn carrying a %s", (_case, authorUserId, authorSnapshot) => {
    expect(TranscriptTurnSchema.safeParse({
      ...base,
      actor: "assistant",
      authorUserId,
      authorSnapshot,
    }).success).toBe(false);
  });
});

describe("omitted-payload turn envelopes", () => {
  const assistant = {
    ...base,
    actor: "assistant" as const,
    authorUserId: null,
    authorSnapshot: null,
  };

  it("accepts a sequence-owning envelope whose payloads are omitted", () => {
    expect(TranscriptTurnSchema.parse({
      ...assistant,
      blocks: [],
      blockCount: 3,
      blocksOmitted: true,
    }).blockCount).toBe(3);
  });

  it("rejects an omitted envelope that does not declare its block count", () => {
    expect(TranscriptTurnSchema.safeParse({
      ...assistant,
      blocks: [],
      blocksOmitted: true,
    }).success).toBe(false);
  });

  it("rejects an omitted envelope that still carries payload blocks", () => {
    expect(TranscriptTurnSchema.safeParse({
      ...assistant,
      blockCount: 1,
      blocksOmitted: true,
    }).success).toBe(false);
  });

  it("rejects a delivered turn whose block count disagrees with its blocks", () => {
    expect(TranscriptTurnSchema.safeParse({
      ...assistant,
      blockCount: 2,
    }).success).toBe(false);
  });
});

describe("canonical transcript activity state", () => {
  it("preserves an ambiguous external effect as a first-class terminal state", () => {
    expect(TranscriptActivitySchema.parse({
      activityId: "turn-1:tool:0:activity",
      parentActivityId: "turn-1:activity",
      scope: "tool_call",
      subjectId: "turn-1:tool:0",
      callIndex: 0,
      label: "Publish",
      state: "ambiguous",
      intervals: [],
      revision: 2,
    }).state).toBe("ambiguous");
  });
});
