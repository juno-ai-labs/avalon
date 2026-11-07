import {
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
} from "./index";

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
  | { code: "stopped"; closeCode: number }
  | { code: "transport_error"; phase: "heartbeat" | "send" | "socket" }
  | { code: "timeout"; phase: "ticket" | "open" | "sync" | "heartbeat" };

/**
 * One subscribed connection, as a host of {@link watchWorkspaceSocket} sees it.
 * Each reconnect is a new connection; one that has closed sends nothing.
 */
export interface WorkspaceSocketConnection {
  /**
   * Writes one client event as JSON. False when this connection is no longer
   * the open one, so a request made for it can be dropped rather than queued.
   * A connection that is closing still counts as open: the frame is dropped,
   * and `onClosed` follows, which is when a pending request fails.
   */
  send(event: unknown): boolean;
}

export interface WorkspaceSocketWatchDependencies {
  /** A fresh workspace socket ticket from `GET /workspace/socket`. */
  ticket(signal?: AbortSignal): Promise<{ url: string; ticket: string }>;
  open(url: string, ticket: string): ReachSocket;
  /**
   * The answer to this connection's `subscribe`: the whole sidebar, sent on
   * every connect, cold or resuming. Passed as decoded JSON, not parsed, for
   * the reason {@link isSubscribeAnswer} gives.
   */
  onSubscribed(answer: unknown, connection: WorkspaceSocketConnection): void;
  /** Every other JSON frame, decoded and unparsed. */
  onMessage?(message: unknown, connection: WorkspaceSocketConnection): void;
  /** The connection went, whatever the reason. Anything asked of it will not be answered. */
  onClosed?(connection: WorkspaceSocketConnection): void;
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
 * Hold one workspace socket outside a renderer and hand its frames to the host.
 *
 * The transport alone: ticket, subscribe, heartbeat, reconnect, and the two
 * close codes that end a session for good. What the frames mean is the
 * host's. It subscribes, because an unsubscribed socket is how the server
 * marks one it has stopped serving, and nothing is replayed across a
 * reconnect: every connection starts again from its own subscribe answer.
 *
 * @returns stop, which closes the socket and cancels any reconnect.
 */
export function watchWorkspaceSocket(dependencies: WorkspaceSocketWatchDependencies): () => void {
  let stopped = false;
  let socket: ReachSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let generation = 0;
  let ticketAbort: AbortController | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let currentConnection: WorkspaceSocketConnection | null = null;

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    if (pongTimer !== null) clearTimeout(pongTimer);
    heartbeatTimer = null;
    pongTimer = null;
  };
  const clearDeadline = (): void => {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
  };
  const retire = (): void => {
    clearDeadline();
    clearHeartbeat();
    const retired = socket;
    const connection = currentConnection;
    socket = null;
    currentConnection = null;
    if (connection) dependencies.onClosed?.(connection);
    try { retired?.close(); } catch { /* The old connection is no longer addressable. */ }
  };
  const timeout = (phase: "ticket" | "open" | "sync" | "heartbeat"): void => {
    generation += 1;
    ticketAbort?.abort();
    ticketAbort = null;
    retire();
    dependencies.onDiagnostic?.({code: "timeout", phase});
    scheduleReconnect();
  };
  const armDeadline = (phase: "ticket" | "open" | "sync"): void => {
    clearDeadline();
    const expected = generation;
    deadline = setTimeout(() => {
      if (!stopped && generation === expected) timeout(phase);
    }, WORKSPACE_SOCKET_OPEN_TIMEOUT_MS);
  };
  const scheduleHeartbeat = (target: ReachSocket): void => {
    clearHeartbeat();
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (stopped || socket !== target) return;
      try { target.send("ping"); } catch {
        dependencies.onDiagnostic?.({ code: "transport_error", phase: "heartbeat" });
        retire();
        scheduleReconnect();
        return;
      }
      pongTimer = setTimeout(() => {
        pongTimer = null;
        if (!stopped && socket === target) timeout("heartbeat");
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
    const expected = ++generation;
    armDeadline("ticket");
    const controller = new AbortController();
    ticketAbort = controller;
    let ticket: { url: string; ticket: string };
    try {
      ticket = await dependencies.ticket(controller.signal);
    } catch (error) {
      if (stopped || generation !== expected) return;
      clearDeadline();
      ticketAbort = null;
      dependencies.onDiagnostic?.({ code: "ticket_failed", error });
      scheduleReconnect();
      return;
    }
    if (stopped || generation !== expected) return;
    clearDeadline();
    ticketAbort = null;
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
    armDeadline("open");
    let subscribed = false;
    const connection: WorkspaceSocketConnection = {
      send: (event) => {
        if (stopped || socket !== next) return false;
        try { next.send(JSON.stringify(event)); } catch {
          dependencies.onDiagnostic?.({ code: "transport_error", phase: "send" });
          retire();
          scheduleReconnect();
          return false;
        }
        return true;
      },
    };
    currentConnection = connection;
    next.addEventListener("open", () => {
      if (stopped || socket !== next) return;
      armDeadline("sync");
      if (!connection.send({ type: "subscribe", afterWaterline: 0 })) return;
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
        clearDeadline();
        attempt = 0;
        dependencies.onSubscribed(decoded, connection);
        return;
      }
      dependencies.onMessage?.(decoded, connection);
    });
    next.addEventListener("close", (event) => {
      if (socket !== next) return;
      socket = null;
      currentConnection = null;
      clearDeadline();
      clearHeartbeat();
      dependencies.onClosed?.(connection);
      if (stopped) return;
      // The server ended this session's access or the session itself.
      // Reconnecting would only be refused again; the host decides what next.
      if (event.code === WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE
        || event.code === WORKSPACE_SOCKET_SESSION_INACTIVE_CODE) {
        stopped = true;
        dependencies.onDiagnostic?.({ code: "stopped", closeCode: event.code });
        return;
      }
      dependencies.onDiagnostic?.({ code: "closed", closeCode: event.code });
      scheduleReconnect();
    });
    next.addEventListener("error", () => {
      if (!stopped && socket === next) {
        dependencies.onDiagnostic?.({ code: "transport_error", phase: "socket" });
        retire();
        scheduleReconnect();
      }
    });
  };

  void connect();
  return () => {
    stopped = true;
    generation += 1;
    ticketAbort?.abort();
    ticketAbort = null;
    clearDeadline();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearHeartbeat();
    const current = socket;
    socket = null;
    current?.close();
  };
}
