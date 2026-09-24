/**
 * Notice a Durable Object that accepts sockets but never hears from them.
 *
 * Every desktop client sends its first frame (`subscribe`) the moment its
 * socket opens. A socket this instance accepted that has still sent nothing
 * long after that is either a client that died in the few milliseconds between
 * open and send, or an instance whose hibernatable WebSocket events have
 * stopped arriving. Production has shown the second: the Juno Labs WorkspaceDO
 * kept accepting upgrades for hours while running no `webSocketMessage`, no
 * `webSocketClose`, and no ping auto-response, and only a restart cleared it
 * (see `docs/realtime-sockets.md`, "An instance that stops hearing its
 * sockets").
 *
 * Only sockets accepted by *this* instance count. A restart that inherits a
 * silent socket from the instance it replaced has not been shown to be stuck,
 * and counting that socket would reset the object again on every alarm.
 */

/** What the watch reads from one socket's attachment. */
export interface FirstFrameWatchedSocket {
  connectedAt: string;
  subscribed: boolean;
  firstFrameReported: boolean;
}

/**
 * The instant by which this socket should have sent its first frame, or `null`
 * when it is not being watched: it already sent one, or an earlier instance
 * accepted it.
 */
export function firstFrameDeadline(
  socket: FirstFrameWatchedSocket,
  deadlineMs: number,
  instanceStartedAt: number,
): number | null {
  if (socket.subscribed || socket.firstFrameReported) return null;
  const connectedAt = Date.parse(socket.connectedAt);
  if (!Number.isFinite(connectedAt) || connectedAt < instanceStartedAt) return null;
  return connectedAt + deadlineMs;
}

/** The earliest first-frame deadline among these sockets, for the alarm to wake on. */
export function nextFirstFrameDeadline(
  sockets: readonly FirstFrameWatchedSocket[],
  deadlineMs: number,
  instanceStartedAt: number,
): number | null {
  let earliest: number | null = null;
  for (const socket of sockets) {
    const deadline = firstFrameDeadline(socket, deadlineMs, instanceStartedAt);
    if (deadline !== null && (earliest === null || deadline < earliest)) earliest = deadline;
  }
  return earliest;
}

/** Whether this socket's first-frame deadline has passed. */
export function missedFirstFrame(
  socket: FirstFrameWatchedSocket,
  now: number,
  deadlineMs: number,
  instanceStartedAt: number,
): boolean {
  const deadline = firstFrameDeadline(socket, deadlineMs, instanceStartedAt);
  return deadline !== null && deadline <= now;
}
