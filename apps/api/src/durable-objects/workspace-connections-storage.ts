import type { ConnectorOAuthProvider } from "@rally/contracts";
import {
  WorkspaceConnectorOAuthAttemptFinishResultSchema,
  WorkspaceConnectorOAuthAttemptReadResultSchema,
  WorkspaceWebhookReceiptClaimResultSchema,
  type WorkspaceConnectorOAuthAttempt,
  type WorkspaceConnectorOAuthAttemptAbandonRequest,
  type WorkspaceConnectorOAuthAttemptExtendRequest,
  type WorkspaceConnectorOAuthAttemptFinishRequest,
  type WorkspaceConnectorOAuthAttemptFinishResult,
  type WorkspaceConnectorOAuthAttemptReadRequest,
  type WorkspaceConnectorOAuthAttemptReadResult,
  type WorkspaceConnectorOAuthAttemptStartRequest,
  type WorkspaceConnectorOAuthAttemptTelemetryBindRequest,
  type WorkspaceWebhookReceiptClaimRequest,
  type WorkspaceWebhookReceiptClaimResult,
} from "./workspace-connections-protocol";

interface AttemptRow extends Record<string, SqlStorageValue> {
  id: string;
  provider: ConnectorOAuthProvider;
  status: "pending" | "succeeded" | "denied" | "failed";
  connection_id: string | null;
  error_code: string | null;
  expires_at: string;
  user_id: string;
  workspace_id: string;
  telemetry_operation_id: string | null;
  telemetry_event_version: number;
  telemetry_scope: "personal" | "workspace" | null;
  telemetry_capability_count: number | null;
  telemetry_reconnect: number;
  created_at: string;
}

/**
 * Expired receipts a single claim may drain from the connection's backlog.
 *
 * Not a number chosen here: it is the bound the generic-webhook prune has
 * shipped with since receipts existed (`ORDER BY expires_at ASC LIMIT 100` in
 * `connection-service.ts`), carried over so the cutover changes which
 * connections get swept — all of them, rather than only generic ones — without
 * also changing how much one delivery pays for it. Raising it is a decision
 * with evidence behind it by then: a connection whose backlog outruns its
 * delivery rate is visible as receipts that stop shrinking.
 */
const RECEIPT_SWEEP_BATCH = 100;

const ATTEMPT_COLUMNS = `id, provider, status, connection_id, error_code, expires_at,
       user_id, workspace_id, telemetry_operation_id, telemetry_event_version,
       telemetry_scope, telemetry_capability_count, telemetry_reconnect, created_at`;

function attemptOf(
  storage: DurableObjectStorage,
  request: { workspaceId: string; attemptId: string; region: string },
  userId: string | null = null,
): AttemptRow | undefined {
  return storage.sql.exec<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS}
       FROM connector_oauth_attempts
      WHERE id = ? AND workspace_id = ? AND region = ?
        AND (? IS NULL OR user_id = ?)`,
    request.attemptId,
    request.workspaceId,
    request.region,
    userId,
    userId,
  ).toArray()[0];
}

function attemptView(row: AttemptRow): WorkspaceConnectorOAuthAttempt {
  return {
    attemptId: row.id,
    provider: row.provider,
    status: row.status,
    connectionId: row.connection_id,
    errorCode: row.error_code,
    expiresAt: row.expires_at,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    telemetryOperationId: row.telemetry_operation_id,
    telemetryEventVersion: row.telemetry_event_version,
    telemetryScope: row.telemetry_scope,
    telemetryCapabilityCount: row.telemetry_capability_count,
    telemetryReconnect: row.telemetry_reconnect === 1,
    createdAt: row.created_at,
  };
}

/** Record a started handoff, pending until its callback or expiry settles it. */
export function startWorkspaceConnectorOAuthAttempt(
  storage: DurableObjectStorage,
  request: WorkspaceConnectorOAuthAttemptStartRequest,
): void {
  storage.sql.exec(
    `INSERT INTO connector_oauth_attempts
       (id, region, provider, user_id, workspace_id, status, connection_id,
        error_code, expires_at, completed_at, created_at, updated_at,
        telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
    request.attemptId,
    request.region,
    request.provider,
    request.userId,
    request.workspaceId,
    request.expiresAt,
    request.at,
    request.at,
    request.telemetryScope,
    request.telemetryCapabilityCount,
    request.telemetryReconnect ? 1 : 0,
  );
}

/** Delete a start whose regional state receipt failed — pending rows only. */
export function abandonWorkspaceConnectorOAuthAttempt(
  storage: DurableObjectStorage,
  request: WorkspaceConnectorOAuthAttemptAbandonRequest,
): void {
  storage.sql.exec(
    `DELETE FROM connector_oauth_attempts
      WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    request.attemptId,
    request.workspaceId,
  );
}

/**
 * Revive an attempt for GitHub's second OAuth leg. Reaches a pending row, or
 * one that lazy expiry marked `failed`/`oauth_attempt_expired` — never a
 * terminal status a person or callback decided.
 */
export function extendWorkspaceConnectorOAuthAttempt(
  storage: DurableObjectStorage,
  request: WorkspaceConnectorOAuthAttemptExtendRequest,
): void {
  storage.sql.exec(
    `UPDATE connector_oauth_attempts
        SET status = 'pending', error_code = NULL, completed_at = NULL,
            expires_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND region = ?
        AND (status = 'pending'
             OR (status = 'failed' AND error_code = 'oauth_attempt_expired'))`,
    request.expiresAt,
    request.at,
    request.attemptId,
    request.workspaceId,
    request.region,
  );
}

/**
 * Read one attempt, optionally settling a due expiry first.
 *
 * The expiry write and the read were two facade round trips; one transaction
 * means the row reported is the row after the sweep, not a state between the
 * two. The sweep is scoped to the requesting member exactly as the poll
 * endpoint's statement was: another member's due attempt is neither expired
 * nor revealed here.
 */
export function readWorkspaceConnectorOAuthAttempt(
  storage: DurableObjectStorage,
  request: WorkspaceConnectorOAuthAttemptReadRequest,
): WorkspaceConnectorOAuthAttemptReadResult {
  return storage.transactionSync(() => {
    if (request.expireDueAt !== null) {
      storage.sql.exec(
        `UPDATE connector_oauth_attempts
            SET status = 'failed', error_code = 'oauth_attempt_expired',
                completed_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND region = ?
            AND (? IS NULL OR user_id = ?)
            AND status = 'pending' AND expires_at <= ?`,
        request.expireDueAt,
        request.expireDueAt,
        request.attemptId,
        request.workspaceId,
        request.region,
        request.userId,
        request.userId,
        request.expireDueAt,
      );
    }
    const row = attemptOf(storage, request, request.userId);
    return WorkspaceConnectorOAuthAttemptReadResultSchema.parse({
      attempt: row ? attemptView(row) : null,
    });
  });
}

/**
 * Settle an attempt, or recognise that its settlement already happened.
 *
 * The compare-and-set takes a pending attempt — or, when settling `succeeded`,
 * any `failed` one, because a callback that already consumed valid OAuth state
 * must win an expiry reconciliation race. Note what that clause says and what
 * it does not: it is `status = 'failed'`, not `error_code =
 * 'oauth_attempt_expired'`, so a `failed` written by a real exchange error is
 * inside its reach too, and this is the facade statement's clause carried over
 * unchanged rather than a rule invented here. Narrowing it to the expiry code
 * would read tighter and is the wrong direction: `oauth_states` is single-use,
 * so a second callback for an attempt that already failed its exchange cannot
 * get far enough to settle anything, while `succeeded` is written only after
 * the connection is committed — a CAS that refused it would answer 409 for a
 * connection that exists, and leave its attempt reporting a failure the user
 * can see was not one. `denied` is deliberately out of reach of both branches:
 * a person who refused the grant is not overridden by a later callback, and the
 * denied-out-of-reach test pins that.
 *
 * A returned witness decides the branch, per `docs/durable-object-sqlite.md`;
 * the convergence check that used to be a second facade read after the failed
 * update now runs in the same transaction, so the answer cannot describe a row
 * that moved between the two.
 */
export function finishWorkspaceConnectorOAuthAttempt(
  storage: DurableObjectStorage,
  request: WorkspaceConnectorOAuthAttemptFinishRequest,
): WorkspaceConnectorOAuthAttemptFinishResult {
  return storage.transactionSync(() => {
    const settled = storage.sql.exec<{ id: string }>(
      `UPDATE connector_oauth_attempts
          SET status = ?, connection_id = ?, error_code = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND region = ?
          AND (status = 'pending' OR (? = 'succeeded' AND status = 'failed'))
        RETURNING id`,
      request.status,
      request.connectionId,
      request.errorCode,
      request.at,
      request.at,
      request.attemptId,
      request.workspaceId,
      request.region,
      request.status,
    ).toArray()[0];
    const row = attemptOf(storage, request);
    if (settled?.id === request.attemptId) {
      // Unreachable as the table stands: the `SELECT` above shares this
      // transaction with an `UPDATE … RETURNING` that just matched this id, and
      // nothing deletes attempts. Kept because that reasoning rests on there
      // being no trigger or cascading delete on this table, which is a property
      // of today's schema rather than of this function.
      if (!row) throw new Error("connector_oauth_attempt_settled_row_missing");
      return WorkspaceConnectorOAuthAttemptFinishResultSchema.parse({
        outcome: "finished",
        attempt: attemptView(row),
      });
    }
    if (!row || row.status !== request.status || row.connection_id !== request.connectionId) {
      return WorkspaceConnectorOAuthAttemptFinishResultSchema.parse({ outcome: "conflict" });
    }
    return WorkspaceConnectorOAuthAttemptFinishResultSchema.parse({
      outcome: "converged",
      attempt: attemptView(row),
    });
  });
}

/**
 * Bind the client's telemetry operation, keeping the first binding. The
 * provider filter the facade statement carried is gone: the table's CHECK
 * constraint already admits exactly the providers that filter listed.
 */
export function bindWorkspaceConnectorOAuthAttemptTelemetry(
  storage: DurableObjectStorage,
  request: WorkspaceConnectorOAuthAttemptTelemetryBindRequest,
): void {
  storage.sql.exec(
    `UPDATE connector_oauth_attempts
        SET telemetry_operation_id = COALESCE(telemetry_operation_id, ?),
            telemetry_event_version = CASE
              WHEN telemetry_operation_id IS NULL THEN ? ELSE telemetry_event_version END,
            updated_at = ?
      WHERE id = ? AND workspace_id = ? AND region = ?`,
    request.operationId,
    request.eventVersion,
    request.at,
    request.attemptId,
    request.workspaceId,
    request.region,
  );
}

/**
 * Claim one webhook delivery, and sweep the connection's expired receipts in
 * the same transaction.
 *
 * The witness is the returned id, not a write counter: through the facade the
 * duplicate branch was `meta.changes === 0`, which is workerd's physical
 * `rowsWritten` standing in for a domain fact — the category
 * `docs/durable-object-sqlite.md` exists to end.
 *
 * The sweep runs for every claim, where the facade path pruned only generic
 * webhook ingestion. Granola receipts carried an `expires_at` and an index on
 * it, but no statement ever deleted them, so a connection's receipts grew
 * without bound in this object's storage. Sweeping here applies the expiry the
 * rows already declare; it admits a redelivery of a signature hash whose
 * receipt has expired, which the providers' own replay windows refuse long
 * before the shortest receipt lifetime does.
 *
 * The sweep is in two parts, and the order matters. The claim's own key is
 * deleted first and unconditionally, because the insert below decides
 * `duplicate` from a unique-index conflict: an expired row for this exact
 * `(connection_id, signature_hash)` left behind would answer every redelivery
 * `duplicate` forever, which is precisely the Granola bug this is fixing. Only
 * then does the backlog drain, in a batch bounded by `RECEIPT_SWEEP_BATCH` —
 * the bound the generic-webhook prune already shipped with, carried over
 * unchanged rather than re-chosen here. It has to stay bounded: the connections
 * whose receipts grew without bound are exactly the ones whose first claim
 * after this deploys would otherwise delete the entire accumulated history
 * inside the same transaction as the claim, and a transaction that exceeds the
 * request's budget takes the claim down with it — leaving every retry to
 * re-attempt the same oversized delete and never make progress. Bounded, the
 * backlog drains a batch per delivery while the claim itself always commits.
 */
export function claimWorkspaceWebhookReceipt(
  storage: DurableObjectStorage,
  request: WorkspaceWebhookReceiptClaimRequest,
): WorkspaceWebhookReceiptClaimResult {
  return storage.transactionSync(() => {
    storage.sql.exec(
      `DELETE FROM webhook_receipts
        WHERE workspace_id = ? AND connection_id = ? AND signature_hash = ?
          AND expires_at <= ?`,
      request.workspaceId,
      request.connectionId,
      request.signatureHash,
      request.receivedAt,
    );
    storage.sql.exec(
      `DELETE FROM webhook_receipts
        WHERE id IN (
          SELECT id FROM webhook_receipts
           WHERE workspace_id = ? AND connection_id = ? AND expires_at <= ?
           ORDER BY expires_at ASC
           LIMIT ?
        )`,
      request.workspaceId,
      request.connectionId,
      request.receivedAt,
      RECEIPT_SWEEP_BATCH,
    );
    const claimed = storage.sql.exec<{ id: string }>(
      `INSERT INTO webhook_receipts
         (id, workspace_id, connection_id, signature_hash, received_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, signature_hash) DO NOTHING
       RETURNING id`,
      request.receiptId,
      request.workspaceId,
      request.connectionId,
      request.signatureHash,
      request.receivedAt,
      request.expiresAt,
    ).toArray()[0];
    let firstObservedAt: string | undefined;
    if (request.eventIdentity) {
      const accepted = storage.sql.exec<{ occurred_at: number }>(
        "SELECT occurred_at FROM workspace_connector_events WHERE connection_id = ? AND provider_event_id = ? AND event_type = ?",
        request.connectionId, request.eventIdentity.providerEventId, request.eventIdentity.eventType).toArray()[0];
      const receipt = storage.sql.exec<{ received_at: string }>("SELECT received_at FROM webhook_receipts WHERE connection_id = ? AND signature_hash = ?",
        request.connectionId, request.signatureHash).toArray()[0];
      firstObservedAt = accepted ? new Date(accepted.occurred_at).toISOString() : receipt?.received_at ?? request.receivedAt;
    }
    if (claimed?.id === request.receiptId) {
      return WorkspaceWebhookReceiptClaimResultSchema.parse({
        outcome: "claimed",
        receiptId: claimed.id,
        ...(firstObservedAt ? { firstObservedAt } : {}),
      });
    }
    return WorkspaceWebhookReceiptClaimResultSchema.parse({ outcome: "duplicate", ...(firstObservedAt ? { firstObservedAt } : {}) });
  });
}
