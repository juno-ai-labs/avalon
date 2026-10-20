import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE } from "./index";
import {
  WORKSPACE_SOCKET_HEARTBEAT_MS,
  WORKSPACE_SOCKET_PONG_TIMEOUT_MS,
  watchWorkspaceReach,
  watchWorkspaceSocket,
  type ReachSocket,
  type WorkspaceSocketConnection,
  type ReachWatchDiagnostic,
} from "./workspace-reach-watch";

type Listener = (event: never) => void;

class FakeSocket implements ReachSocket {
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

/** The subscribe answer, as the server shapes it: the one sync that carries `sidebar`. */
const subscribeAnswer = {
  type: "workspace_sync",
  eventId: "01920000-0000-7000-8000-000000000001",
  waterline: 3,
  occurredAt: "2026-09-24T00:00:00.000Z",
  topics: ["workstream_directory"],
  reason: "initial",
  sidebar: {},
};
const broadcast = {
  type: "workspace_sync",
  eventId: "01920000-0000-7000-8000-000000000002",
  waterline: 4,
  occurredAt: "2026-09-24T00:00:01.000Z",
  topics: ["activity"],
  reason: "change",
};
const reachChanged = {
  type: "workspace_reach_changed",
  occurredAt: "2026-09-24T00:00:01.000Z",
  userIds: ["00000000-0000-7000-8000-00000000e001"],
};

function harness(options: { ticket?: () => Promise<{ url: string; ticket: string }>; open?: () => FakeSocket } = {}) {
  const sockets: FakeSocket[] = [];
  const onStale = vi.fn();
  const diagnostics: ReachWatchDiagnostic[] = [];
  const stop = watchWorkspaceReach({
    ticket: options.ticket ?? (async () => ({ url: "wss://api.example/socket/workspaces/w", ticket: "t" })),
    open: options.open ?? (() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    onStale,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  /** Let the pending ticket promise settle, then open the newest socket. */
  const opened = async (): Promise<FakeSocket> => {
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets.at(-1)!;
    socket.emit("open");
    return socket;
  };
  return { sockets, onStale, diagnostics, stop, opened };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("watchWorkspaceReach", () => {
  it.each(["open", "sync"] as const)("replaces a stalled %s without depending on close", async (phase) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const {sockets, diagnostics} = harness();
    await vi.advanceTimersByTimeAsync(0);
    const old = sockets[0]!;
    if (phase === "sync") {
      old.emit("open");
      old.message("pong");
    }
    await vi.advanceTimersByTimeAsync(15_750);
    expect(sockets).toHaveLength(2);
    expect(old.closed).toBe(true);
    expect(diagnostics).toContainEqual({code: "timeout", phase});
    old.emit("close", {code: 1006});
    expect(sockets).toHaveLength(2);
  });

  it("abandons an unresolved ticket and ignores its late completion", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let resolve!: (value: {url: string; ticket: string}) => void;
    const ticket = vi.fn().mockImplementationOnce(() => new Promise(r => {resolve = r;}))
      .mockResolvedValue({url: "wss://api.example/socket/workspaces/w", ticket: "new"});
    const {sockets, diagnostics} = harness({ticket});
    await vi.advanceTimersByTimeAsync(15_750);
    expect(sockets).toHaveLength(1);
    resolve({url: "wss://api.example/socket/workspaces/w", ticket: "old"});
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(diagnostics).toContainEqual({code: "timeout", phase: "ticket"});
  });

  it.each(["socket", "heartbeat", "send"] as const)("reports %s transport failures before retrying", async (phase) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { sockets, diagnostics, opened } = harness();
    const socket = await opened();
    socket.message(subscribeAnswer);
    if (phase === "socket") socket.emit("error");
    else {
      vi.spyOn(socket, "send").mockImplementation(() => { throw new Error("transport unavailable"); });
      if (phase === "heartbeat") await vi.advanceTimersByTimeAsync(WORKSPACE_SOCKET_HEARTBEAT_MS);
      else socket.emit("open");
    }
    expect(diagnostics).toContainEqual({ code: "transport_error", phase });
    await vi.advanceTimersByTimeAsync(750);
    expect(sockets).toHaveLength(2);
  });

  it("subscribes, and reports the first subscribe answer and a reach change, but not a broadcast", async () => {
    const { onStale, opened } = harness();
    const socket = await opened();

    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "subscribe", afterWaterline: 0 });
    // The host's opening read may have finished before this subscribe, so a
    // change between the two reached no socket.
    socket.message(subscribeAnswer);
    expect(onStale).toHaveBeenCalledTimes(1);

    socket.message(broadcast);
    socket.message({ type: "workspace_presence", occurredAt: reachChanged.occurredAt, workstreamId: null, userIds: [] });
    expect(onStale).toHaveBeenCalledTimes(1);

    socket.message(reachChanged);
    expect(onStale).toHaveBeenCalledTimes(2);
  });

  it("recognizes a subscribe answer carrying a field this build does not know", async () => {
    const { onStale, opened } = harness();
    const socket = await opened();
    socket.message({ ...subscribeAnswer, sidebar: { somethingNewer: true }, alsoNew: 1 });
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("reports stale after a reconnect, since nothing is replayed across the gap", async () => {
    const { sockets, onStale, diagnostics, opened } = harness();
    const first = await opened();
    first.message(subscribeAnswer);
    first.emit("close", { code: 1006 });
    expect(diagnostics).toEqual([{ code: "closed", closeCode: 1006 }]);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(2);
    const second = await opened();
    second.message(subscribeAnswer);
    expect(onStale).toHaveBeenCalledTimes(2);
  });

  it("ignores a message from a socket it has already replaced", async () => {
    const { onStale, opened } = harness();
    const first = await opened();
    first.emit("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(1_500);
    await opened();

    first.message(reachChanged);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("pings when quiet, and closes and reconnects when the pong does not come", async () => {
    const { sockets, opened } = harness();
    const socket = await opened();
    socket.message(subscribeAnswer);

    await vi.advanceTimersByTimeAsync(WORKSPACE_SOCKET_HEARTBEAT_MS);
    expect(socket.sent.at(-1)).toBe("ping");
    await vi.advanceTimersByTimeAsync(WORKSPACE_SOCKET_PONG_TIMEOUT_MS);
    expect(socket.closed).toBe(true);

    socket.emit("close", { code: 1006 });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(2);
  });

  it("keeps the socket when the pong arrives", async () => {
    const { opened } = harness();
    const socket = await opened();
    socket.message(subscribeAnswer);
    await vi.advanceTimersByTimeAsync(WORKSPACE_SOCKET_HEARTBEAT_MS);
    socket.message("pong");
    await vi.advanceTimersByTimeAsync(WORKSPACE_SOCKET_PONG_TIMEOUT_MS);
    expect(socket.closed).toBe(false);
  });

  it("names a failed ticket and tries again", async () => {
    let calls = 0;
    const failure = new Error("Rally could not issue a ticket");
    const { sockets, diagnostics } = harness({
      ticket: async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return { url: "wss://api.example/socket/workspaces/w", ticket: "t" };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics).toEqual([{ code: "ticket_failed", error: failure }]);
    expect(sockets).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(1);
  });

  it("retries when opening the socket throws, rather than stopping for good", async () => {
    let attempts = 0;
    const sockets: FakeSocket[] = [];
    const { diagnostics } = harness({
      open: () => {
        attempts += 1;
        if (attempts === 1) throw new SyntaxError("The URL is invalid");
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["open_failed"]);
    expect(sockets).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(sockets).toHaveLength(1);
  });

  it("stops, and says so, after the server revokes access", async () => {
    const { sockets, diagnostics, opened } = harness();
    const socket = await opened();
    socket.message(subscribeAnswer);
    socket.emit("close", { code: WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE });
    expect(diagnostics).toEqual([{ code: "stopped", closeCode: WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE }]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("closes the socket and stops reconnecting when stopped", async () => {
    const { sockets, diagnostics, stop, opened } = harness();
    const socket = await opened();
    stop();
    expect(socket.closed).toBe(true);
    socket.emit("close", { code: 1000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });
});

describe("watchWorkspaceSocket", () => {
  it("hands the host each frame with a connection that stops sending once it has closed", async () => {
    const sockets: FakeSocket[] = [];
    const subscribed: unknown[] = [];
    const messages: unknown[] = [];
    const closed: WorkspaceSocketConnection[] = [];
    let connection: WorkspaceSocketConnection | null = null;
    const stop = watchWorkspaceSocket({
      ticket: async () => ({ url: "wss://api.example/socket/workspaces/w", ticket: "t" }),
      open: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onSubscribed: (answer, current) => {
        subscribed.push(answer);
        connection = current;
      },
      onMessage: (message) => messages.push(message),
      onClosed: (current) => closed.push(current),
    });
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0]!;
    socket.emit("open");

    socket.message(subscribeAnswer);
    socket.message(broadcast);
    expect(subscribed).toEqual([subscribeAnswer]);
    expect(messages).toEqual([broadcast]);

    expect(connection!.send({ type: "space_channels" })).toBe(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "space_channels" });

    socket.emit("close", { code: 1006 });
    expect(closed).toEqual([connection]);
    expect(connection!.send({ type: "space_channels" })).toBe(false);
    stop();
  });
});
