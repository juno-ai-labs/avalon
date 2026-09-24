import { describe, expect, it } from "vitest";

import {
  firstFrameDeadline,
  missedFirstFrame,
  nextFirstFrameDeadline,
} from "../src/durable-objects/socket-first-frame-watch";

const DEADLINE_MS = 1_000;
const STARTED = Date.parse("2026-09-24T06:00:00.000Z");

function socket(connectedAt: string, overrides: { subscribed?: boolean; firstFrameReported?: boolean } = {}) {
  return { connectedAt, subscribed: false, firstFrameReported: false, ...overrides };
}

describe("socket first-frame watch", () => {
  it("watches a silent socket this instance accepted", () => {
    const silent = socket("2026-09-24T06:00:10.000Z");
    const due = Date.parse("2026-09-24T06:00:11.000Z");
    expect(firstFrameDeadline(silent, DEADLINE_MS, STARTED)).toBe(due);
    expect(missedFirstFrame(silent, due - 1, DEADLINE_MS, STARTED)).toBe(false);
    expect(missedFirstFrame(silent, due, DEADLINE_MS, STARTED)).toBe(true);
  });

  it("stops watching once the socket sends anything", () => {
    expect(firstFrameDeadline(socket("2026-09-24T06:00:10.000Z", { firstFrameReported: true }), DEADLINE_MS, STARTED))
      .toBeNull();
    expect(firstFrameDeadline(socket("2026-09-24T06:00:10.000Z", { subscribed: true }), DEADLINE_MS, STARTED))
      .toBeNull();
  });

  // A fresh instance that counted the silent sockets it inherited would reset
  // itself again on every alarm.
  it("ignores sockets an earlier instance accepted", () => {
    const inherited = socket("2026-09-24T05:59:59.999Z");
    expect(firstFrameDeadline(inherited, DEADLINE_MS, STARTED)).toBeNull();
    expect(missedFirstFrame(inherited, STARTED + 60 * 60_000, DEADLINE_MS, STARTED)).toBe(false);
  });

  it("ignores an attachment whose accept time does not parse", () => {
    expect(firstFrameDeadline(socket("not a time"), DEADLINE_MS, STARTED)).toBeNull();
  });

  it("wakes on the earliest deadline", () => {
    expect(nextFirstFrameDeadline([
      socket("2026-09-24T06:00:20.000Z"),
      socket("2026-09-24T06:00:05.000Z"),
      socket("2026-09-24T06:00:01.000Z", { subscribed: true }),
    ], DEADLINE_MS, STARTED)).toBe(Date.parse("2026-09-24T06:00:06.000Z"));
    expect(nextFirstFrameDeadline([], DEADLINE_MS, STARTED)).toBeNull();
  });
});
