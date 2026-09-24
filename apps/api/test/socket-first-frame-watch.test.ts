import { describe, expect, it } from "vitest";

import {
  firstFrameDeadline,
  nextFirstFrameDeadline,
  socketsMissedWhileInstanceSilent,
  type FirstFrameWatchedSocket,
} from "../src/durable-objects/socket-first-frame-watch";

const DEADLINE_MS = 1_000;
const at = (time: string): number => Date.parse(`2026-09-24T${time}Z`);

function socket(connectedAt: string, overrides: Partial<FirstFrameWatchedSocket> = {}): FirstFrameWatchedSocket {
  return {
    connectedAt: `2026-09-24T${connectedAt}Z`,
    subscribed: false,
    firstFrameReported: false,
    lastAutoResponseAt: null,
    ...overrides,
  };
}

describe("socket first-frame watch", () => {
  it("gives a silent socket a deadline, and none once it speaks", () => {
    expect(firstFrameDeadline(socket("06:00:10.000"), DEADLINE_MS)).toBe(at("06:00:11.000"));
    expect(firstFrameDeadline(socket("06:00:10.000", { firstFrameReported: true }), DEADLINE_MS)).toBeNull();
    expect(firstFrameDeadline(socket("06:00:10.000", { subscribed: true }), DEADLINE_MS)).toBeNull();
    expect(firstFrameDeadline({ ...socket("06:00:10.000"), connectedAt: "not a time" }, DEADLINE_MS)).toBeNull();
  });

  it("wakes on the earliest deadline", () => {
    expect(nextFirstFrameDeadline([
      socket("06:00:20.000"),
      socket("06:00:05.000"),
      socket("06:00:01.000", { subscribed: true }),
    ], DEADLINE_MS)).toBe(at("06:00:06.000"));
    expect(nextFirstFrameDeadline([], DEADLINE_MS)).toBeNull();
  });

  describe("resetting only an object that hears no socket", () => {
    const silent = socket("06:00:10.000");
    const late = at("06:05:00.000");
    const missed = (sockets: FirstFrameWatchedSocket[], lastSocketEventAt: number | null = null) =>
      socketsMissedWhileInstanceSilent(sockets, late, DEADLINE_MS, lastSocketEventAt);

    it("counts a silent socket past its deadline when nothing has been heard since", () => {
      expect(missed([silent])).toEqual([silent]);
      expect(socketsMissedWhileInstanceSilent([silent], at("06:00:10.999"), DEADLINE_MS, null)).toEqual([]);
    });

    // Each signal on its own is enough to say the object still hears sockets,
    // and evidence from before the silent socket was accepted says nothing.
    it("ignores it once this instance has run a socket callback since", () => {
      expect(missed([silent], at("06:00:10.001"))).toEqual([]);
      expect(missed([silent], at("06:00:10.000"))).toEqual([silent]);
    });

    it("ignores it once the runtime has answered any socket's ping since", () => {
      const idle = socket("05:00:00.000", { subscribed: true, lastAutoResponseAt: at("06:00:40.000") });
      const stale = socket("05:00:00.000", { subscribed: true, lastAutoResponseAt: at("06:00:09.000") });
      expect(missed([silent, idle])).toEqual([]);
      expect(missed([socket("06:00:10.000", { lastAutoResponseAt: at("06:00:10.000") })])).toEqual([]);
      expect(missed([silent, stale])).toEqual([silent]);
    });

    it("ignores it once a socket accepted after it has spoken", () => {
      expect(missed([silent, socket("06:00:30.000", { firstFrameReported: true })])).toEqual([]);
      expect(missed([silent, socket("06:00:05.000", { subscribed: true })])).toEqual([silent]);
    });
  });
});
