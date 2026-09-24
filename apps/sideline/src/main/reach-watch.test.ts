import { WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { watchWorkspaceReach, type ReachSocket } from "./reach-watch";

type Listener = (event: never) => void;

class FakeSocket implements ReachSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  message(body: unknown): void {
    this.emit("message", { data: typeof body === "string" ? body : JSON.stringify(body) });
  }
}

const subscribeAnswer = {
  type: "workspace_sync",
  eventId: "01920000-0000-7000-8000-000000000001",
  waterline: 3,
  occurredAt: "2026-09-24T00:00:00.000Z",
  topics: ["workstream_directory"],
  reason: "initial",
};
const reachChanged = {
  type: "workspace_reach_changed",
  occurredAt: "2026-09-24T00:00:01.000Z",
  userIds: ["00000000-0000-7000-8000-00000000e001"],
};

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
  const onStale = vi.fn();
  const stop = watchWorkspaceReach({
    ticket: async () => ({ url: "wss://api.example/socket/workspaces/w", ticket: "t" }),
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onStale,
    setTimer: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  });
  const opened = async (): Promise<FakeSocket> => {
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const socket = sockets.at(-1)!;
    socket.emit("open");
    return socket;
  };
  return { sockets, timers, onStale, stop, opened };
}

describe("watchWorkspaceReach", () => {
  it("subscribes, and reports a reach change but not the first subscribe answer", async () => {
    const { onStale, opened } = harness();
    const socket = await opened();

    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "subscribe", afterWaterline: 0 });
    socket.message(subscribeAnswer);
    expect(onStale).not.toHaveBeenCalled();

    socket.message({ ...subscribeAnswer, reason: "change", topics: ["activity"] });
    socket.message({ type: "workspace_presence", occurredAt: reachChanged.occurredAt, workstreamId: null, userIds: [] });
    expect(onStale).not.toHaveBeenCalled();

    socket.message(reachChanged);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("reports stale after a reconnect, since nothing is replayed across the gap", async () => {
    const { sockets, timers, onStale, opened } = harness();
    const first = await opened();
    first.message(subscribeAnswer);
    first.emit("close", { code: 1006 });

    timers.filter((timer) => !timer.cleared).at(-1)!.callback();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    const second = await opened();
    second.message(subscribeAnswer);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after the server revokes access", async () => {
    const { timers, opened } = harness();
    const socket = await opened();
    socket.message(subscribeAnswer);
    const before = timers.length;
    socket.emit("close", { code: WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE });
    expect(timers).toHaveLength(before);
    expect(timers.every((timer) => timer.cleared)).toBe(true);
  });

  it("closes the socket and stops reconnecting when stopped", async () => {
    const { timers, stop, opened } = harness();
    const socket = await opened();
    stop();
    expect(socket.closed).toBe(true);
    socket.emit("close", { code: 1000 });
    expect(timers.every((timer) => timer.cleared)).toBe(true);
  });
});
