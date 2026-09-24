import {
  WorkspaceReachChangedEventSchema,
  WorkspaceSocketSyncEventSchema,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  safeParseSocketEvent,
} from "@rally/contracts";

/** The origin Sideline's workspace socket presents; the Worker's `ALLOWED_ORIGINS` must admit it. */
export const SIDELINE_SOCKET_ORIGIN = "app://sideline";

// The Rally desktop's workspace-socket heartbeat and reconnect numbers
// (`apps/desktop/src/renderer/lib/workspace-socket.tsx`), reused rather than
// chosen again: this is the same socket, closed by the same server.
const HEARTBEAT_MS = 50_000;
const PONG_TIMEOUT_MS = 15_000;
function reconnectDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}

/** The slice of the WHATWG `WebSocket` this watcher uses, so a test can drive it. */
export interface ReachSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

export interface ReachWatchDependencies {
  /** A fresh workspace socket ticket from `GET /workspace/socket`. */
  ticket(): Promise<{ url: string; ticket: string }>;
  open(url: string, ticket: string): ReachSocket;
  /**
   * The catalog may no longer match the server: somebody it lists joined or
   * left a Channel or Breakout, or the socket reconnected after a gap in which
   * that could have happened unheard.
   */
  onStale(): void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Hold one workspace socket for the signed-in operator and report when the
 * catalog went stale.
 *
 * Listens for `workspace_reach_changed`, which WorkspaceDO sends only for the
 * operator and the people they may act as, and ignores everything else the
 * socket carries. It subscribes because an unsubscribed socket is how the
 * server marks one it has stopped serving; the sidebar in the answer is
 * discarded.
 *
 * Nothing is replayed across a reconnect, so every subscribe answer after the
 * first reports the catalog stale. The first is skipped because the renderer
 * loads the catalog when the session starts.
 *
 * @returns stop, which closes the socket and cancels any reconnect.
 */
export function watchWorkspaceReach(dependencies: ReachWatchDependencies): () => void {
  const setTimer = dependencies.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = dependencies.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let socket: ReachSocket | null = null;
  let reconnectTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let pongTimer: unknown = null;
  let attempt = 0;
  let subscribedOnce = false;

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) clearTimer(heartbeatTimer);
    if (pongTimer !== null) clearTimer(pongTimer);
    heartbeatTimer = null;
    pongTimer = null;
  };
  const scheduleHeartbeat = (target: ReachSocket): void => {
    clearHeartbeat();
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      if (stopped || socket !== target) return;
      target.send("ping");
      pongTimer = setTimer(() => {
        pongTimer = null;
        if (!stopped && socket === target) target.close();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  };
  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) return;
    attempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelay(attempt));
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    let ticket: { url: string; ticket: string };
    try {
      ticket = await dependencies.ticket();
    } catch {
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    const next = dependencies.open(ticket.url, ticket.ticket);
    socket = next;
    let subscribed = false;
    next.addEventListener("open", () => {
      if (stopped || socket !== next) return;
      next.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      scheduleHeartbeat(next);
    });
    next.addEventListener("message", (event) => {
      if (stopped || socket !== next) return;
      const raw = String(event.data);
      if (raw === "pong") {
        scheduleHeartbeat(next);
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        return;
      }
      if (!subscribed && safeParseSocketEvent(WorkspaceSocketSyncEventSchema, decoded).success) {
        subscribed = true;
        attempt = 0;
        if (subscribedOnce) dependencies.onStale();
        subscribedOnce = true;
        return;
      }
      if (safeParseSocketEvent(WorkspaceReachChangedEventSchema, decoded).success) dependencies.onStale();
    });
    next.addEventListener("close", (event) => {
      if (socket !== next) return;
      socket = null;
      clearHeartbeat();
      // The server ended this operator's access or session. The session
      // refresh path owns sign-out; reconnecting would only be refused again.
      if (event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE
        || event.code === WORKSPACE_SOCKET_SESSION_INACTIVE_CODE) return;
      scheduleReconnect();
    });
    next.addEventListener("error", () => {
      if (!stopped && socket === next) next.close();
    });
  };

  void connect();
  return () => {
    stopped = true;
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    reconnectTimer = null;
    clearHeartbeat();
    const current = socket;
    socket = null;
    current?.close();
  };
}
