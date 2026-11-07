import type { TelemetryRealtimeSocket, TelemetryRealtimeSocketCause } from '@rally/contracts/telemetry';

import { reportTelemetryProductIntent, telemetryCountBucket } from './telemetry';
import type { WorkstreamSocketStartReason } from './telemetry';

export type RealtimeSocket = TelemetryRealtimeSocket;
/** Why a socket transitioned. `opened` is the only one a live socket carries. */
export type RealtimeSocketCause = TelemetryRealtimeSocketCause;

export function reportWorkstreamSocketStarted(
  workstreamId: string,
  socketLeaseId: string,
  socket: 'workstream_control' | 'substream_feed',
  reason: WorkstreamSocketStartReason,
  attempts: number,
  operationId: string,
  openAttemptId?: string,
): void {
  reportTelemetryProductIntent({
    kind: 'workstream_socket_started',
    operationId,
    workstreamId,
    socketLeaseId,
    ...(openAttemptId ? { openAttemptId } : {}),
    socket,
    reason,
    attempts: telemetryCountBucket(attempts),
  });
}

/**
 * The `realtime_socket_state` producer, one instance per live socket loop.
 *
 * Three hooks run near-identical connect/backoff loops against three different
 * Durable Objects — the workspace directory, the WorkstreamDO control channel,
 * and the AgentLoopDO feed — and the question being asked spans all three:
 * which of them drops, why, and how many attempts a client spends getting back.
 * That only reads as one measurement if the three report the same vocabulary,
 * so the vocabulary lives here rather than three times over.
 *
 * The cause is stated where it is known and read where the transition is
 * observed, because those are rarely the same line: a heartbeat that times out,
 * a transport error, and a room that asked for a resync all close the socket
 * themselves, and by the time the `close` listener runs, the only thing left is
 * a close code that says nothing about which of them it was. {@link willClose}
 * is how the site that knows hands it to the site that reports.
 */
export interface RealtimeSocketTelemetry {
  /** The handshake completed. `attempts` is the retry depth it arrived at. */
  connected(attempts: number): void;
  /**
   * This client is about to close the socket, for a reason the `close` event
   * cannot carry. Consumed by the next {@link disconnected}; a second call
   * before that one replaces the first, which is what a heartbeat timeout
   * racing a transport error should do — either explains the same drop.
   */
  willClose(cause: RealtimeSocketCause): void;
  /**
   * The socket is down. `retrying` is whether anything is scheduled to bring it
   * back: a client that has stopped is the interesting half of this event, and
   * the loop decides it, not the cause — a revocation never retries, a ticket
   * failure retries unless the desktop is offline, and every loop refuses to
   * schedule while it is.
   *
   * Callers gate this on their own teardown flag. A hook closing its socket
   * because the screen went away is not a drop, and counting it would put every
   * ordinary navigation in the drop rate; the flag lives in the loop, so only
   * the loop can tell the two closes apart.
   */
  disconnected(input: { attempts: number; retrying: boolean; cause?: RealtimeSocketCause }): void;
}

export function realtimeSocketTelemetry(socket: RealtimeSocket): RealtimeSocketTelemetry {
  let pendingCause: RealtimeSocketCause | null = null;
  const report = (
    state: 'connected' | 'retrying' | 'stopped',
    cause: RealtimeSocketCause,
    attempts: number,
  ): void => {
    reportTelemetryProductIntent({
      kind: 'realtime_socket_state',
      socket,
      state,
      cause,
      attempts: telemetryCountBucket(attempts),
    });
  };
  return {
    connected(attempts) {
      pendingCause = null;
      report('connected', 'opened', attempts);
    },
    willClose(cause) {
      pendingCause = cause;
    },
    disconnected({ attempts, retrying, cause }) {
      // A close nobody here asked for is the server's, which is the reading a
      // hibernating Durable Object, an evicted room, or a dropped network path
      // all arrive at.
      const resolved = cause ?? pendingCause ?? 'server_closed';
      pendingCause = null;
      report(retrying ? 'retrying' : 'stopped', resolved, attempts);
    },
  };
}
