import { describe, expect, it } from "vitest";

import {
  HarnessStatusSchema,
  conversationNeedsViewer,
  type HarnessStatus,
} from "./conversation-attention";

const READER_FLAGS = ["hasUnread", "unseen", "youAreMentioned"] as const;

/** Every combination of the four inputs, which is what the SQL is held to. */
function everyCombination(): {
  harnessStatus: HarnessStatus;
  hasUnread: boolean;
  unseen: boolean;
  youAreMentioned: boolean;
}[] {
  const rows = [];
  for (const harnessStatus of HarnessStatusSchema.options) {
    for (let mask = 0; mask < 1 << READER_FLAGS.length; mask += 1) {
      rows.push({
        harnessStatus,
        hasUnread: (mask & 1) !== 0,
        unseen: (mask & 2) !== 0,
        youAreMentioned: (mask & 4) !== 0,
      });
    }
  }
  return rows;
}

describe("conversationNeedsViewer", () => {
  it("given every combination of the four inputs, then a live run or any reader state admits", () => {
    const combinations = everyCombination();
    expect(combinations).toHaveLength(7 * 8);
    for (const conversation of combinations) {
      const live = ["scheduled", "running", "needs_input"].includes(conversation.harnessStatus)
        || conversation.hasUnread
        || conversation.unseen
        || conversation.youAreMentioned;
      expect({ ...conversation, needed: conversationNeedsViewer(conversation) })
        .toEqual({ ...conversation, needed: live });
    }
  });

  it("given a finished run nobody has anything outstanding on, then it is stale", () => {
    for (const harnessStatus of ["completed", "stopped", "failed", "idle"] as const) {
      expect(conversationNeedsViewer({ harnessStatus })).toBe(false);
    }
  });

  it("given the three reader states omitted, then they are read as false rather than as unknown", () => {
    // The fields are optional on the wire because a payload written before
    // they existed describes a conversation nobody was waiting on. A
    // conversation that defaulted them to *true* would put every pre-Spaces
    // row on every dashboard.
    expect(conversationNeedsViewer({ harnessStatus: "completed" })).toBe(false);
    expect(conversationNeedsViewer({
      harnessStatus: "completed",
      hasUnread: undefined,
      unseen: undefined,
      youAreMentioned: undefined,
    })).toBe(false);
  });

  it("given `scheduled`, then it is live, because the marker ranking folds it into running", () => {
    // `harnessMarkerStatus` presents `scheduled` as `running`. Excluding it
    // here would drop a conversation off the list and put it back a moment
    // later under a marker that never changed.
    expect(conversationNeedsViewer({ harnessStatus: "scheduled" })).toBe(true);
  });
});
