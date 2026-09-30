import {
  WorkspaceReachChangedEventSchema,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
} from "./index";
import { safeParseSocketEvent } from "./socket-events";

/**
 * How a client keeps a workspace socket alive: a `ping` after this much quiet,
 * a close when its `pong` does not arrive within the timeout, and jittered
 * exponential backoff to 30 seconds between attempts. One set of numbers for
 * every client of this socket, because they are all closed by the same server.
 */
export const WORKSPACE_SOCKET_HEARTBEAT_MS = 50_000;
export const WORKSPACE_SOCKET_PONG_TIMEOUT_MS = 15_000;
/**
 * How long a client waits for a dialled workspace socket to open before it
 * closes it and dials again.
 *
 * Set 2026-09-30 by the team (15 s, the pong timeout's wait for the same
 * server), not derived here; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: time from `new WebSocket` to its `open` event.
 * Without it: a `101` that never reaches the client leaves the socket in
 *   CONNECTING, sending nothing, until the operating system gives up, while
 *   the server counts it as a socket that never spoke.
 * Direction: upper bound.
 * Trips: the client closes the socket, reports `open_timeout`, and redials
 *   with the ordinary backoff. A redial that speaks within the server's
 *   two-minute first-frame deadline settles the silent socket there.
 * Derive from: a healthy open takes one to four seconds after the ticket;
 *   15 s plus backoff and a ticket still fits well inside two minutes.
 */
export const WORKSPACE_SOCKET_OPEN_TIMEOUT_MS = 15_000;
export function workspaceSocketReconnectDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 750 * 2 ** Math.min(Math.max(attempt, 0), 6));
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}

/** The slice of the WHATWG `WebSocket` this watcher uses, so a test can drive it. */
export interface ReachSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

/**
 * Why the watcher is not listening right now, for the host to log.
 *
 * `stopped` is terminal: the server ended this session's access or the session
 * itself, and the watcher will not reconnect. Everything else is followed by a
 * scheduled retry.
 */
export type ReachWatchDiagnostic =
  | { code: "ticket_failed"; error: unknown }
  | { code: "open_failed"; error: unknown }
  | { code: "closed"; closeCode: number }
  | { code: "stopped"; closeCode: number };

export interface ReachWatchDependencies {
  /** A fresh workspace socket ticket from `GET /workspace/socket`. */
  ticket(): Promise<{ url: string; ticket: string }>;
  open(url: string, ticket: string): ReachSocket;
  /**
   * The host's list may no longer match the server: somebody it shows joined
   * or left a Channel or Breakout, or the socket (re)subscribed after a gap in
   * which that could have happened unheard.
   */
  onStale(): void;
  onDiagnostic?(diagnostic: ReachWatchDiagnostic): void;
}

/**
 * The answer to `subscribe`: the one `workspace_sync` that carries `sidebar`.
 *
 * Recognized by shape, not parsed: the answer carries the whole sidebar, and a
 * host that ships on its own schedule must not stop recognizing it because the
 * server added a field this build's strict schema does not know.
 */
function isSubscribeAnswer(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && (value as { type?: unknown }).type === "workspace_sync"
    && "sidebar" in value;
}

/**
 * Hold one workspace socket and report when a list drawn from membership went
 * stale.
 *
 * For a host with no workspace socket of its own, Sideline and the lite
 * browser client, that needs only to hear that somebody it shows joined or
 * left a Channel or Breakout. It subscribes, because an unsubscribed socket is
 * how the server marks one it has stopped serving, and then ignores everything
 * but `workspace_reach_changed` and the subscribe answer.
 *
 * Every subscribe answer reports stale, the first included: nothing is
 * replayed across a reconnect, and the host's opening read can finish before
 * the first subscribe does.
 *
 * @returns stop, which closes the socket and cancels any reconnect.
 */
export function watchWorkspaceReach(dependencies: ReachWatchDependencies): () => void {
  let stopped = false;
  let socket: ReachSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    if (pongTimer !== null) clearTimeout(pongTimer);
    heartbeatTimer = null;
    pongTimer = null;
  };
  const scheduleHeartbeat = (target: ReachSocket): void => {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (stopped || socket !== target) return;
      target.send("ping");
      pongTimer = setTimeout(() => {
        pongTimer = null;
        if (!stopped && socket === target) target.close();
      }, WORKSPACE_SOCKET_PONG_TIMEOUT_MS);
    }, WORKSPACE_SOCKET_HEARTBEAT_MS);
  };
  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) return;
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, workspaceSocketReconnectDelay(attempt));
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    let ticket: { url: string; ticket: string };
    try {
      ticket = await dependencies.ticket();
    } catch (error) {
      if (stopped) return;
      dependencies.onDiagnostic?.({ code: "ticket_failed", error });
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    let next: ReachSocket;
    try {
      // A constructor can throw synchronously (a malformed URL, a refused
      // protocol). Unhandled, it would reject this call with no retry armed.
      next = dependencies.open(ticket.url, ticket.ticket);
    } catch (error) {
      dependencies.onDiagnostic?.({ code: "open_failed", error });
      scheduleReconnect();
      return;
    }
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
      if (!subscribed && isSubscribeAnswer(decoded)) {
        subscribed = true;
        attempt = 0;
        dependencies.onStale();
        return;
      }
      if (safeParseSocketEvent(WorkspaceReachChangedEventSchema, decoded).success) dependencies.onStale();
    });
    next.addEventListener("close", (event) => {
      if (socket !== next) return;
      socket = null;
      clearHeartbeat();
      if (stopped) return;
      // The server ended this session's access or the session itself.
      // Reconnecting would only be refused again; the host decides what next.
      if (event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE
        || event.code === WORKSPACE_SOCKET_SESSION_INACTIVE_CODE) {
        dependencies.onDiagnostic?.({ code: "stopped", closeCode: event.code });
        return;
      }
      dependencies.onDiagnostic?.({ code: "closed", closeCode: event.code });
      scheduleReconnect();
    });
    next.addEventListener("error", () => {
      if (!stopped && socket === next) next.close();
    });
  };

  void connect();
  return () => {
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearHeartbeat();
    const current = socket;
    socket = null;
    current?.close();
  };
}
