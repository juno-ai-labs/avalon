import {
  WorkspaceTranscriptionAdmitResultSchema,
  WorkspaceTranscriptionRenewResultSchema,
  type WorkspaceTranscriptionAdmitRequest,
  type WorkspaceTranscriptionAdmitResult,
  type WorkspaceTranscriptionRenewRequest,
  type WorkspaceTranscriptionRenewResult,
  type WorkspaceTranscriptionSessionRequest,
} from "./workspace-transcription-protocol";

/**
 * How long an admitted dictation session's lease lasts.
 *
 * Carried here rather than in the service because the sweep that enforces it
 * and the insert that sets it are both in this file: a lease length the writer
 * and the reaper disagree about is a session that is either collected while in
 * use or never collected at all.
 */
export const TRANSCRIPTION_SESSION_LEASE_SECONDS = 2 * 60;

/**
 * How many dictation sessions one person, and one workspace, may hold at once.
 *
 * Both are product caps rather than platform limits, and they are the team's
 * numbers: they were set with the feature and are unchanged here. They live
 * beside the insert that enforces them so a caller cannot admit itself past
 * them by passing a larger number.
 */
export const MAX_CONCURRENT_USER_TRANSCRIPTION_SESSIONS = 2;
export const MAX_CONCURRENT_WORKSPACE_TRANSCRIPTION_SESSIONS = 20;

/**
 * Sweep, consume the ticket, and reserve a session — as one critical section.
 *
 * The three steps used to be three statements sent through the workspace
 * runtime facade, which is three round trips and three separate critical
 * sections. Each statement was individually atomic, so the caps held; what did
 * not hold is the sequence, and a reader had no way to tell from the call site
 * which of the two it was getting. `transactionSync` makes the reading true.
 */
export function admitWorkspaceTranscriptionSession(
  storage: DurableObjectStorage,
  request: WorkspaceTranscriptionAdmitRequest,
): WorkspaceTranscriptionAdmitResult {
  return storage.transactionSync(() => {
    storage.sql.exec(
      `DELETE FROM realtime_transcription_sessions WHERE expires_at_s <= ?`,
      request.nowSeconds,
    );
    storage.sql.exec(
      `DELETE FROM realtime_transcription_ticket_receipts WHERE expires_at_s <= ?`,
      request.nowSeconds,
    );

    const receipt = storage.sql.exec(
      `INSERT OR IGNORE INTO realtime_transcription_ticket_receipts
         (ticket_id, workspace_id, user_id, consumed_at_s, expires_at_s)
       VALUES (?, ?, ?, ?, ?)`,
      request.ticketId,
      request.workspaceId,
      request.userId,
      request.nowSeconds,
      request.ticketExpiresAtSeconds,
    );
    if (receipt.rowsWritten === 0) {
      return WorkspaceTranscriptionAdmitResultSchema.parse({
        outcome: "ticket_replayed",
        expiresAtSeconds: null,
      });
    }

    const expiresAtSeconds = request.nowSeconds + TRANSCRIPTION_SESSION_LEASE_SECONDS;
    const reserved = storage.sql.exec(
      `INSERT INTO realtime_transcription_sessions
         (id, ticket_id, workspace_id, user_id, started_at_s, expires_at_s)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (
         SELECT COUNT(*) FROM realtime_transcription_sessions
         WHERE workspace_id = ? AND user_id = ? AND expires_at_s > ?
       ) < ?
         AND (
           SELECT COUNT(*) FROM realtime_transcription_sessions
           WHERE workspace_id = ? AND expires_at_s > ?
         ) < ?`,
      request.sessionId,
      request.ticketId,
      request.workspaceId,
      request.userId,
      request.nowSeconds,
      expiresAtSeconds,
      request.workspaceId,
      request.userId,
      request.nowSeconds,
      MAX_CONCURRENT_USER_TRANSCRIPTION_SESSIONS,
      request.workspaceId,
      request.nowSeconds,
      MAX_CONCURRENT_WORKSPACE_TRANSCRIPTION_SESSIONS,
    );
    if (reserved.rowsWritten === 0) {
      // The ticket stays consumed. It was spent on this attempt, and handing it
      // back would make a refused admission retryable as a fresh one.
      return WorkspaceTranscriptionAdmitResultSchema.parse({
        outcome: "concurrency_limit",
        expiresAtSeconds: null,
      });
    }
    return WorkspaceTranscriptionAdmitResultSchema.parse({
      outcome: "admitted",
      expiresAtSeconds,
    });
  });
}

export function releaseWorkspaceTranscriptionSession(
  storage: DurableObjectStorage,
  request: WorkspaceTranscriptionSessionRequest,
): void {
  storage.sql.exec(
    `DELETE FROM realtime_transcription_sessions WHERE id = ? AND workspace_id = ?`,
    request.sessionId,
    request.workspaceId,
  );
}

export function renewWorkspaceTranscriptionSession(
  storage: DurableObjectStorage,
  request: WorkspaceTranscriptionRenewRequest,
): WorkspaceTranscriptionRenewResult {
  const expiresAtSeconds = request.nowSeconds + TRANSCRIPTION_SESSION_LEASE_SECONDS;
  const renewed = storage.sql.exec(
    `UPDATE realtime_transcription_sessions SET expires_at_s = ?
      WHERE id = ? AND workspace_id = ?`,
    expiresAtSeconds,
    request.sessionId,
    request.workspaceId,
  ).rowsWritten > 0;
  return WorkspaceTranscriptionRenewResultSchema.parse({
    renewed,
    expiresAtSeconds: renewed ? expiresAtSeconds : null,
  });
}
