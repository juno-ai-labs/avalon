import { describe, expect, it } from "vitest";

import {
  judgeUnheardSockets,
  nextFirstFrameDeadline,
  type FirstFrameWatchedSocket,
  type UnheardSocket,
} from "../src/durable-objects/socket-first-frame-watch";

const DEADLINE_MS = 1_000;
const at = (time: string): number => Date.parse(`2026-09-24T${time}Z`);

function unheard(connectionId: string, acceptedAt: string): UnheardSocket {
  return { connectionId, acceptedAt: at(acceptedAt) };
}

function open(
  connectionId: string,
  connectedAt: string,
  overrides: Partial<FirstFrameWatchedSocket> = {},
): FirstFrameWatchedSocket {
  return {
    connectionId,
    connectedAt: `2026-09-24T${connectedAt}Z`,
    subscribed: false,
    firstFrameReported: false,
    lastAutoResponseAt: null,
    ...overrides,
  };
}

describe("socket first-frame watch", () => {
  it("wakes on the earliest unheard socket's deadline", () => {
    expect(nextFirstFrameDeadline([
      unheard("b", "06:00:20.000"),
      unheard("a", "06:00:05.000"),
    ], DEADLINE_MS)).toBe(at("06:00:06.000"));
    expect(nextFirstFrameDeadline([], DEADLINE_MS)).toBeNull();
  });

  describe("resetting only an object that hears no socket", () => {
    const silent = unheard("silent", "06:00:10.000");
    const late = at("06:05:00.000");
    const judge = (
      sockets: FirstFrameWatchedSocket[],
      lastSocketEventAt: number | null = null,
      now = late,
    ) => judgeUnheardSockets([silent], sockets, now, DEADLINE_MS, lastSocketEventAt);

    it("counts a socket unheard past its deadline when nothing has been heard since", () => {
      expect(judge([open("silent", "06:00:10.000")])).toEqual({ missed: [silent], settled: [] });
      expect(judge([open("silent", "06:00:10.000")], null, at("06:00:10.999"))).toEqual({ missed: [], settled: [] });
    });

    // What the open-sockets-only watch could not see: the client gave up on
    // the socket inside the deadline, so it is no longer open to be read.
    it("counts it after its client has closed it", () => {
      expect(judge([])).toEqual({ missed: [silent], settled: [] });
    });

    it("lets it go once its own attachment says it spoke", () => {
      expect(judge([open("silent", "06:00:10.000", { firstFrameReported: true })]))
        .toEqual({ missed: [], settled: [silent] });
    });

    // Each signal on its own is enough to say the object still hears sockets,
    // and evidence from before the silent socket was accepted says nothing.
    it("settles it once this instance has run a socket callback since", () => {
      expect(judge([], at("06:00:10.001"))).toEqual({ missed: [], settled: [silent] });
      expect(judge([], at("06:00:10.000"))).toEqual({ missed: [silent], settled: [] });
    });

    it("settles it once the runtime has answered any socket's ping since", () => {
      const idle = open("idle", "05:00:00.000", { subscribed: true, lastAutoResponseAt: at("06:00:40.000") });
      const stale = open("stale", "05:00:00.000", { subscribed: true, lastAutoResponseAt: at("06:00:09.000") });
      expect(judge([idle]).missed).toEqual([]);
      expect(judge([open("silent", "06:00:10.000", { lastAutoResponseAt: at("06:00:10.000") })]).missed).toEqual([]);
      expect(judge([stale]).missed).toEqual([silent]);
    });

    it("settles it once a socket accepted after it has spoken", () => {
      expect(judge([open("later", "06:00:30.000", { firstFrameReported: true })]).missed).toEqual([]);
      expect(judge([open("earlier", "06:00:05.000", { subscribed: true })]).missed).toEqual([silent]);
    });
  });
});
