import { describe, expect, it } from "vitest";

import { unreadState } from "../src/durable-objects/unread-state";
import { channelReadState } from "../src/durable-objects/workspace-channel-read-storage";

describe("unreadState", () => {
  it("falls back to the tracking start when the reader has no position, so an unopened conversation is not unread", () => {
    expect(unreadState({ latest: 4, seen: null, trackingStart: 4, manual: null }))
      .toEqual({ readThrough: 4, firstUnread: null, hasUnread: false });
  });

  it("is unread from the ordinal after the read position", () => {
    expect(unreadState({ latest: 7, seen: 3, trackingStart: 0, manual: null }))
      .toEqual({ readThrough: 3, firstUnread: 4, hasUnread: true });
  });

  it("lets a manual mark win over a caught-up position", () => {
    expect(unreadState({ latest: 5, seen: 5, trackingStart: 0, manual: 5 }))
      .toEqual({ readThrough: 5, firstUnread: 5, hasUnread: true });
  });
});

describe("channelReadState", () => {
  const row = {
    latest_attention_ordinal: 3,
    unread_tracking_start_ordinal: 0,
    seen_attention_ordinal: 1,
  };

  it("answers a member in ChannelStats's field names", () => {
    expect(channelReadState(row, false)).toEqual({
      latestAttentionSequenceNumber: 3,
      readThroughSequenceNumber: 1,
      firstUnreadSequenceNumber: 2,
      hasUnread: true,
    });
  });

  it("answers a guest as caught up whatever was placed", () => {
    expect(channelReadState(row, true)).toEqual({
      latestAttentionSequenceNumber: 3,
      readThroughSequenceNumber: 3,
      firstUnreadSequenceNumber: null,
      hasUnread: false,
    });
  });
});
