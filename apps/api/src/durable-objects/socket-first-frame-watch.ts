/**
 * Notice a Durable Object that accepts sockets but never hears from them.
 *
 * Every desktop client sends its first frame (`subscribe`) the moment its
 * socket opens. Production has shown an object that kept accepting upgrades
 * for hours while delivering no `webSocketMessage`, no `webSocketClose`, and no
 * ping auto-response, cleared only by a restart (see `docs/realtime-sockets.md`,
 * "An instance that stops hearing its sockets").
 *
 * A socket that missed its first frame is not enough on its own, because one
 * client controls it: any member could open a socket, never speak, and reset
 * the whole Organization every deadline; and a connection that drops without a
 * FIN right after the upgrade looks the same. So a missed socket only counts
 * when the object has heard from no socket at all since accepting it. Three
 * signals say it has, and the first two survive hibernation, which resets any
 * in-memory state:
 *
 * - the runtime answered some socket's `ping` after the silent one was
 *   accepted (idle desktops ping every 50 s, and the stuck object answered
 *   none);
 * - some socket accepted after the silent one has since sent a frame;
 * - this instance ran a socket callback after the silent one was accepted.
 *
 * While any other client is connected, no single client can make all three
 * false.
 */

/** What the watch reads about one socket. */
export interface FirstFrameWatchedSocket {
  connectedAt: string;
  subscribed: boolean;
  firstFrameReported: boolean;
  /** When the runtime last answered this socket's `ping`, or `null` if never. */
  lastAutoResponseAt: number | null;
}

/** The instant by which this socket should have sent its first frame, or `null` once it has. */
export function firstFrameDeadline(socket: FirstFrameWatchedSocket, deadlineMs: number): number | null {
  if (socket.subscribed || socket.firstFrameReported) return null;
  const connectedAt = Date.parse(socket.connectedAt);
  return Number.isFinite(connectedAt) ? connectedAt + deadlineMs : null;
}

/** The earliest first-frame deadline among these sockets, for the alarm to wake on. */
export function nextFirstFrameDeadline(
  sockets: readonly FirstFrameWatchedSocket[],
  deadlineMs: number,
): number | null {
  let earliest: number | null = null;
  for (const socket of sockets) {
    const deadline = firstFrameDeadline(socket, deadlineMs);
    if (deadline !== null && (earliest === null || deadline < earliest)) earliest = deadline;
  }
  return earliest;
}

/**
 * The sockets whose first-frame deadline has passed with the object hearing
 * from no socket since they were accepted. Non-empty means the object has
 * stopped receiving socket events.
 *
 * `lastSocketEventAt` is when this instance last ran a socket callback of any
 * kind, or `null` if it never has.
 */
export function socketsMissedWhileInstanceSilent<T extends FirstFrameWatchedSocket>(
  sockets: readonly T[],
  now: number,
  deadlineMs: number,
  lastSocketEventAt: number | null,
): T[] {
  const heardFromSince = (acceptedAt: number): boolean =>
    (lastSocketEventAt !== null && lastSocketEventAt > acceptedAt)
    || sockets.some((other) =>
      // At or after, for both: the clock is millisecond-grained, and a ping
      // answered or a frame sent by a socket accepted in the same millisecond
      // was still heard no earlier than the silent socket's accept.
      (other.lastAutoResponseAt !== null && other.lastAutoResponseAt >= acceptedAt)
      || ((other.subscribed || other.firstFrameReported) && Date.parse(other.connectedAt) >= acceptedAt));
  return sockets.filter((socket) => {
    const deadline = firstFrameDeadline(socket, deadlineMs);
    return deadline !== null && deadline <= now && !heardFromSince(Date.parse(socket.connectedAt));
  });
}
