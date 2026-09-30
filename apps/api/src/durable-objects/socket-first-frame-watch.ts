/**
 * Notice a Durable Object that accepts sockets but never hears from them. The
 * rules, and the incident behind them, are in `docs/realtime-sockets.md`, "An
 * instance that stops hearing its sockets".
 */

/**
 * A socket the object accepted and has not yet heard a frame from, as the
 * object's own ledger remembers it. The ledger outlives the socket: a client
 * that gives up on a silent socket closes it, and the runtime drops it from
 * `getWebSockets()` even when no close callback ever runs.
 */
export interface UnheardSocket {
  connectionId: string;
  /** Unix milliseconds. */
  acceptedAt: number;
}

/** What the watch reads about one socket that is still open. */
export interface FirstFrameWatchedSocket {
  connectionId: string;
  connectedAt: string;
  subscribed: boolean;
  firstFrameReported: boolean;
  /** When the runtime last answered this socket's `ping`, or `null` if never. */
  lastAutoResponseAt: number | null;
}

/**
 * The earliest first-frame deadline among these sockets, for the alarm to wake
 * on. A socket in `held` was already judged missed and kept below the reset
 * threshold; its deadline has passed, and waking on it would hold the alarm at
 * `now + 1` until something else settles it.
 */
export function nextFirstFrameDeadline(
  unheard: readonly UnheardSocket[],
  deadlineMs: number,
  held: ReadonlySet<string> = new Set(),
): number | null {
  let earliest: number | null = null;
  for (const socket of unheard) {
    if (held.has(socket.connectionId)) continue;
    const deadline = socket.acceptedAt + deadlineMs;
    if (earliest === null || deadline < earliest) earliest = deadline;
  }
  return earliest;
}

/**
 * Which of the unheard sockets past their deadline this object has settled,
 * and which it missed. Missed means nothing was heard from any socket since
 * that one was accepted: the object has stopped receiving socket events.
 * Settled means something was, or the socket was accepted by an earlier
 * instance and is gone: that instance was reset or evicted, and either way
 * nothing silent carried over. An unheard socket still inside its deadline is
 * neither.
 *
 * `lastSocketEventAt` is when this instance last ran a socket callback of any
 * kind, or `null` if it never has; `instanceStartedAt` is when it was
 * constructed.
 */
export function judgeUnheardSockets<T extends UnheardSocket>(
  unheard: readonly T[],
  open: readonly FirstFrameWatchedSocket[],
  now: number,
  deadlineMs: number,
  lastSocketEventAt: number | null,
  instanceStartedAt: number,
): { missed: T[]; settled: T[] } {
  const openIds = new Set(open.map((socket) => socket.connectionId));
  const heardFromSince = (acceptedAt: number): boolean =>
    (lastSocketEventAt !== null && lastSocketEventAt > acceptedAt)
    || open.some((other) =>
      // At or after, for both: the clock is millisecond-grained, and a ping
      // answered or a frame sent by a socket accepted in the same millisecond
      // was still heard no earlier than the silent socket's accept. A socket
      // that has itself spoken matches here too.
      (other.lastAutoResponseAt !== null && other.lastAutoResponseAt >= acceptedAt)
      || ((other.subscribed || other.firstFrameReported) && Date.parse(other.connectedAt) >= acceptedAt));
  const missed: T[] = [];
  const settled: T[] = [];
  for (const socket of unheard) {
    if (socket.acceptedAt + deadlineMs > now) continue;
    const fromEarlierInstance = socket.acceptedAt < instanceStartedAt && !openIds.has(socket.connectionId);
    if (fromEarlierInstance || heardFromSince(socket.acceptedAt)) settled.push(socket);
    else missed.push(socket);
  }
  return { missed, settled };
}
