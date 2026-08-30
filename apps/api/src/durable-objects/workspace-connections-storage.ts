import { uuidV7 } from "../lib/uuid-v7";
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
  WorkspaceConnectionResultSchema,
  WorkspaceConnectionListResultSchema,
  WorkspaceConnectionWriteResultSchema,
  WorkspaceConnectionSettleResultSchema,
  WorkspaceConnectionLeaseClaimResultSchema,
  WorkspaceConnectionPluginIdsResultSchema,
  type WorkspaceConnection,
  type WorkspaceConnectionResult,
  type WorkspaceConnectionListResult,
  type WorkspaceConnectionListRequest,
  type WorkspaceConnectionReadRequest,
  type WorkspaceConnectionFindRequest,
  type WorkspaceConnectionCreateRequest,
  type WorkspaceConnectionRefreshRequest,
  type WorkspaceConnectionWriteResult,
  type WorkspaceConnectionStatusRequest,
  type WorkspaceConnectionDisableRequest,
  type WorkspaceConnectionCredentialWriteRequest,
  type WorkspaceConnectionEnvelopeRotateRequest,
  type WorkspaceConnectionSettleResult,
  type WorkspaceConnectionLeaseClaimRequest,
  type WorkspaceConnectionLeaseClaimResult,
  type WorkspaceConnectionLeaseSettleRequest,
  type WorkspaceConnectionLeaseReleaseRequest,
  type WorkspaceConnectionRepositoryAccessRequest,
  type WorkspaceConnectionIdentityRequest,
  type WorkspaceConnectionPluginIdsRequest,
  type WorkspaceConnectionPluginIdsResult,
} from "./workspace-connections-protocol";

interface AttemptRow extends Record<string, SqlStorageValue> {
  id: string;
  provider: "google" | "github" | "granola" | "linear" | "notion" | "slack";
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
    if (claimed?.id === request.receiptId) {
      return WorkspaceWebhookReceiptClaimResultSchema.parse({
        outcome: "claimed",
        receiptId: claimed.id,
      });
    }
    return WorkspaceWebhookReceiptClaimResultSchema.parse({ outcome: "duplicate" });
  });
}

/**
 * Every column of `connector_connections`, named rather than `SELECT *`.
 *
 * The replaced statements were mostly `SELECT *`, which is why the readers
 * downstream could each pick a different subset without anyone noticing when
 * one of them stopped being written. Naming the columns here makes the row a
 * contract: `WorkspaceConnectionSchema` is `.strict()`, so a column added to
 * the table and not to both lists fails the parse in tests rather than
 * arriving as an untyped extra at a call site.
 */
const CONNECTION_COLUMNS = `id, workspace_id, connector_type, scope, owner_user_id,
       provider_account_id, display_name, encrypted_credentials, credential_iv,
       credential_key_version, credential_refresh_lease_id,
       credential_refresh_lease_expires_at, granted_scopes_json, status, cursor_json,
       config_json, last_sync_at, next_poll_at, error_json, created_at, updated_at,
       model_plugin_id`;

function connectionResult(row: WorkspaceConnection | undefined): WorkspaceConnectionResult {
  return WorkspaceConnectionResultSchema.parse({ connection: row ?? null });
}

/**
 * The qualifications a read may add, as SQL fragments over code-owned text.
 *
 * Every fragment is a constant; only bindings vary. That is the rule the
 * SQL-construction guidance asks for, and it is what lets one method stand in
 * for the eleven near-identical `WHERE` clauses the services used to write.
 */
function readPredicate(request: {
  connectorType?: string | undefined;
  scope?: string | undefined;
  activeOnly?: boolean | undefined;
  healthyOnly?: boolean | undefined;
  visibleToUserId?: string | undefined;
}): { sql: string; bindings: (string | number)[] } {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  if (request.connectorType !== undefined) {
    clauses.push("AND connector_type = ?");
    bindings.push(request.connectorType);
  }
  if (request.scope !== undefined) {
    clauses.push("AND scope = ?");
    bindings.push(request.scope);
  }
  if (request.activeOnly) clauses.push("AND status <> 'disabled'");
  if (request.healthyOnly) clauses.push("AND status = 'healthy'");
  if (request.visibleToUserId !== undefined) {
    clauses.push("AND (scope = 'workspace' OR owner_user_id = ?)");
    bindings.push(request.visibleToUserId);
  }
  return { sql: clauses.join("\n        "), bindings };
}

export function workspaceConnection(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionReadRequest,
): WorkspaceConnectionResult {
  const predicate = readPredicate(request);
  return connectionResult(storage.sql.exec<WorkspaceConnection>(
    `SELECT ${CONNECTION_COLUMNS} FROM connector_connections
      WHERE id = ? AND workspace_id = ?
        ${predicate.sql}`,
    request.connectionId,
    request.workspaceId,
    ...predicate.bindings,
  ).toArray()[0]);
}

export function listWorkspaceConnections(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionListRequest,
): WorkspaceConnectionListResult {
  return WorkspaceConnectionListResultSchema.parse({
    connections: storage.sql.exec<WorkspaceConnection>(
      `SELECT ${CONNECTION_COLUMNS} FROM connector_connections
        WHERE workspace_id = ? AND (scope = 'workspace' OR owner_user_id = ?)
        ORDER BY display_name COLLATE NOCASE`,
      request.workspaceId,
      request.userId,
    ).toArray(),
  });
}

/**
 * The adoption search. Always active-only: every replaced statement carried
 * `status <> 'disabled'`, because a disabled connection is a decision somebody
 * made and re-adopting it would undo that silently.
 */
export function findWorkspaceConnection(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionFindRequest,
): WorkspaceConnectionResult {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  if (request.scope !== undefined) {
    clauses.push("AND scope = ?");
    bindings.push(request.scope);
  }
  if (request.providerAccountId !== undefined) {
    if (request.providerAccountId === null) {
      clauses.push("AND provider_account_id IS NULL");
    } else {
      clauses.push("AND provider_account_id = ?");
      bindings.push(request.providerAccountId);
    }
  }
  if (request.ownerUserId !== undefined) {
    if (request.ownerUserId === null) {
      clauses.push("AND owner_user_id IS NULL");
    } else {
      clauses.push("AND owner_user_id = ?");
      bindings.push(request.ownerUserId);
    }
  }
  if (request.excludeConnectionId !== undefined) {
    clauses.push("AND id <> ?");
    bindings.push(request.excludeConnectionId);
  }
  if (request.creationIdempotencyKey !== undefined) {
    clauses.push("AND json_extract(config_json, '$.creationIdempotencyKey') = ?");
    bindings.push(request.creationIdempotencyKey);
  }
  return connectionResult(storage.sql.exec<WorkspaceConnection>(
    `SELECT ${CONNECTION_COLUMNS} FROM connector_connections
      WHERE workspace_id = ? AND connector_type = ? AND status <> 'disabled'
        ${clauses.join("\n        ")}
      ORDER BY created_at
      LIMIT 1`,
    request.workspaceId,
    request.connectorType,
    ...bindings,
  ).toArray()[0]);
}

export function workspaceConnectionPluginIds(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionPluginIdsRequest,
): WorkspaceConnectionPluginIdsResult {
  return storage.transactionSync(() => {
    const taken = storage.sql.exec<{ model_plugin_id: string }>(
      `SELECT model_plugin_id FROM connector_connections
        WHERE workspace_id = ? AND status <> 'disabled' AND (? IS NULL OR id <> ?)`,
      request.workspaceId,
      request.excludeConnectionId,
      request.excludeConnectionId,
    ).toArray().map((row) => row.model_plugin_id);
    const current = request.excludeConnectionId === null
      ? null
      : storage.sql.exec<{ model_plugin_id: string }>(
        `SELECT model_plugin_id FROM connector_connections WHERE id = ? AND workspace_id = ?`,
        request.excludeConnectionId,
        request.workspaceId,
      ).toArray()[0]?.model_plugin_id ?? null;
    return WorkspaceConnectionPluginIdsResultSchema.parse({ taken, current });
  });
}

/**
 * Settle the attempt a connection write authorized, inside that write's
 * transaction.
 *
 * The predicate is the one `persistConnectionMutation` used: only a pending or
 * failed attempt binds, so a replayed callback cannot re-point an attempt that
 * already succeeded at a different connection.
 */
function bindAttemptToConnection(
  storage: DurableObjectStorage,
  bind: { attemptId: string; region: string } | undefined,
  connectionId: string,
  at: string,
): void {
  if (!bind) return;
  storage.sql.exec(
    `UPDATE connector_oauth_attempts
        SET connection_id = ?, updated_at = ?
      WHERE id = ? AND region = ?
        AND status IN ('pending', 'failed')`,
    connectionId,
    at,
    bind.attemptId,
    bind.region,
  );
}

export function createWorkspaceConnection(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionCreateRequest,
): WorkspaceConnectionWriteResult {
  return storage.transactionSync(() => {
    const row = storage.sql.exec<WorkspaceConnection>(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, encrypted_credentials, credential_iv, credential_key_version,
          granted_scopes_json, model_plugin_id, status, cursor_json, config_json,
          next_poll_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', '{}', ?, ?, ?, ?)
       RETURNING ${CONNECTION_COLUMNS}`,
      request.connectionId,
      request.workspaceId,
      request.connectorType,
      request.scope,
      request.ownerUserId,
      request.providerAccountId,
      request.displayName,
      request.credentials?.ciphertext ?? null,
      request.credentials?.iv ?? null,
      request.credentials?.keyVersion ?? null,
      request.grantedScopesJson,
      request.modelPluginId,
      request.configJson,
      request.nextPollAt,
      request.at,
      request.at,
    ).toArray()[0];
    bindAttemptToConnection(storage, request.bindAttempt, request.connectionId, request.at);
    return WorkspaceConnectionWriteResultSchema.parse(
      row ? { outcome: "written", connection: row } : { outcome: "missing" },
    );
  });
}

export function refreshWorkspaceConnection(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionRefreshRequest,
): WorkspaceConnectionWriteResult {
  return storage.transactionSync(() => {
    const pollAssignment = request.nextPollAt === undefined ? "" : ", next_poll_at = ?";
    const pollBinding = request.nextPollAt === undefined ? [] : [request.nextPollAt];
    const row = storage.sql.exec<WorkspaceConnection>(
      `UPDATE connector_connections
          SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
              granted_scopes_json = ?, provider_account_id = ?, display_name = ?,
              model_plugin_id = ?, status = 'healthy', error_json = NULL,
              config_json = ?${pollAssignment}, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND connector_type = ?
        RETURNING ${CONNECTION_COLUMNS}`,
      request.credentials.ciphertext,
      request.credentials.iv,
      request.credentials.keyVersion,
      request.grantedScopesJson,
      request.providerAccountId,
      request.displayName,
      request.modelPluginId,
      request.configJson,
      ...pollBinding,
      request.at,
      request.connectionId,
      request.workspaceId,
      request.connectorType,
    ).toArray()[0];
    // The bind is skipped when nothing was refreshed: an attempt must not be
    // pointed at a connection this call did not actually write.
    if (row) bindAttemptToConnection(storage, request.bindAttempt, request.connectionId, request.at);
    return WorkspaceConnectionWriteResultSchema.parse(
      row ? { outcome: "written", connection: row } : { outcome: "missing" },
    );
  });
}

export function setWorkspaceConnectionStatus(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionStatusRequest,
): WorkspaceConnectionWriteResult {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  if (request.connectorType !== undefined) {
    clauses.push("AND connector_type = ?");
    bindings.push(request.connectorType);
  }
  if (request.fromStatus !== undefined) {
    clauses.push("AND status = ?");
    bindings.push(request.fromStatus);
  }
  const row = storage.sql.exec<WorkspaceConnection>(
    `UPDATE connector_connections
        SET status = ?, error_json = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
        ${clauses.join("\n        ")}
      RETURNING ${CONNECTION_COLUMNS}`,
    request.status,
    request.errorJson,
    request.at,
    request.connectionId,
    request.workspaceId,
    ...bindings,
  ).toArray()[0];
  return WorkspaceConnectionWriteResultSchema.parse(
    row ? { outcome: "written", connection: row } : { outcome: "missing" },
  );
}

export function disableWorkspaceConnection(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionDisableRequest,
): WorkspaceConnectionWriteResult {
  const row = storage.sql.exec<WorkspaceConnection>(
    `UPDATE connector_connections
        SET status = 'disabled', encrypted_credentials = NULL, credential_iv = NULL,
            next_poll_at = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ?
      RETURNING ${CONNECTION_COLUMNS}`,
    request.at,
    request.connectionId,
    request.workspaceId,
  ).toArray()[0];
  return WorkspaceConnectionWriteResultSchema.parse(
    row ? { outcome: "written", connection: row } : { outcome: "missing" },
  );
}

export function setWorkspaceConnectionCredentials(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionCredentialWriteRequest,
): WorkspaceConnectionWriteResult {
  const row = storage.sql.exec<WorkspaceConnection>(
    `UPDATE connector_connections
        SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
            updated_at = ?
      WHERE id = ? AND workspace_id = ?
        ${request.activeOnly ? "AND status <> 'disabled'" : ""}
      RETURNING ${CONNECTION_COLUMNS}`,
    request.credentials.ciphertext,
    request.credentials.iv,
    request.credentials.keyVersion,
    request.at,
    request.connectionId,
    request.workspaceId,
  ).toArray()[0];
  return WorkspaceConnectionWriteResultSchema.parse(
    row ? { outcome: "written", connection: row } : { outcome: "missing" },
  );
}

export function rotateWorkspaceConnectionEnvelope(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionEnvelopeRotateRequest,
): WorkspaceConnectionSettleResult {
  const settled = storage.sql.exec<{ id: string }>(
    `UPDATE connector_connections
        SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
            updated_at = ?
      WHERE id = ? AND workspace_id = ?
        AND encrypted_credentials = ? AND credential_iv = ? AND credential_key_version = ?
      RETURNING id`,
    request.next.ciphertext,
    request.next.iv,
    request.next.keyVersion,
    request.at,
    request.connectionId,
    request.workspaceId,
    request.expected.ciphertext,
    request.expected.iv,
    request.expected.keyVersion,
  ).toArray()[0];
  return WorkspaceConnectionSettleResultSchema.parse({
    outcome: settled ? "settled" : "raced",
  });
}

/**
 * Claim the refresh lease, minting its id and expiry here.
 *
 * The lease id and the deadline are the object's to produce: a caller
 * that invented both could hand two workers the same lease id, and a caller
 * whose clock ran slow could set an expiry already past. The envelope comes
 * back with the claim because the winner needs it and a second read would let
 * a rival's settle land between the two.
 */
export function claimWorkspaceConnectionCredentialLease(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionLeaseClaimRequest,
): WorkspaceConnectionLeaseClaimResult {
  const leaseId = uuidV7();
  const expiresAt = new Date(Date.parse(request.at) + request.leaseMs).toISOString();
  const row = storage.sql.exec<{
    encrypted_credentials: string | null;
    credential_iv: string | null;
    credential_key_version: number | null;
  }>(
    `UPDATE connector_connections
        SET credential_refresh_lease_id = ?, credential_refresh_lease_expires_at = ?
      WHERE id = ? AND workspace_id = ? AND status <> 'disabled'
        AND (credential_refresh_lease_id IS NULL
             OR credential_refresh_lease_expires_at < ?)
      RETURNING encrypted_credentials, credential_iv, credential_key_version`,
    leaseId,
    expiresAt,
    request.connectionId,
    request.workspaceId,
    request.at,
  ).toArray()[0];
  if (!row) return WorkspaceConnectionLeaseClaimResultSchema.parse({ outcome: "held" });
  const complete = row.encrypted_credentials !== null
    && row.credential_iv !== null
    && row.credential_key_version !== null;
  return WorkspaceConnectionLeaseClaimResultSchema.parse({
    outcome: "claimed",
    leaseId,
    // A connection can hold the lease and no envelope — a disabled-then-revived
    // row, or one whose credentials were cleared. The caller decides what to do
    // about that; the claim itself succeeded.
    credentials: complete
      ? {
        ciphertext: row.encrypted_credentials,
        iv: row.credential_iv,
        keyVersion: row.credential_key_version,
      }
      : null,
  });
}

export function settleWorkspaceConnectionCredentialLease(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionLeaseSettleRequest,
): WorkspaceConnectionSettleResult {
  const settled = storage.sql.exec<{ id: string }>(
    `UPDATE connector_connections
        SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
            credential_refresh_lease_id = NULL,
            credential_refresh_lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status <> 'disabled'
        AND credential_refresh_lease_id = ?
      RETURNING id`,
    request.credentials.ciphertext,
    request.credentials.iv,
    request.credentials.keyVersion,
    request.at,
    request.connectionId,
    request.workspaceId,
    request.leaseId,
  ).toArray()[0];
  return WorkspaceConnectionSettleResultSchema.parse({
    outcome: settled ? "settled" : "raced",
  });
}

export function releaseWorkspaceConnectionCredentialLease(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionLeaseReleaseRequest,
): void {
  storage.sql.exec(
    `UPDATE connector_connections
        SET credential_refresh_lease_id = NULL, credential_refresh_lease_expires_at = NULL
      WHERE id = ? AND workspace_id = ? AND credential_refresh_lease_id = ?`,
    request.connectionId,
    request.workspaceId,
    request.leaseId,
  );
}

export function setWorkspaceConnectionRepositoryAccess(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionRepositoryAccessRequest,
): WorkspaceConnectionSettleResult {
  const settled = storage.sql.exec<{ id: string }>(
    `UPDATE connector_connections
        SET config_json = json_set(COALESCE(config_json, '{}'),
                                   '$.githubRepositoryAccess', json(?)),
            updated_at = ?
      WHERE id = ? AND workspace_id = ? AND connector_type = 'github'
        AND status <> 'disabled'
        AND COALESCE(
              CAST(json_extract(config_json, '$.githubRepositoryAccess.revision') AS INTEGER),
              0
            ) = ?
      RETURNING id`,
    request.accessJson,
    request.at,
    request.connectionId,
    request.workspaceId,
    request.expectedRevision,
  ).toArray()[0];
  return WorkspaceConnectionSettleResultSchema.parse({
    outcome: settled ? "settled" : "raced",
  });
}

export function setWorkspaceConnectionIdentity(
  storage: DurableObjectStorage,
  request: WorkspaceConnectionIdentityRequest,
): WorkspaceConnectionWriteResult {
  const row = storage.sql.exec<WorkspaceConnection>(
    `UPDATE connector_connections
        SET provider_account_id = ?, display_name = ?, config_json = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND connector_type = ? AND scope = ?
      RETURNING ${CONNECTION_COLUMNS}`,
    request.providerAccountId,
    request.displayName,
    request.configJson,
    request.at,
    request.connectionId,
    request.workspaceId,
    request.connectorType,
    request.scope,
  ).toArray()[0];
  return WorkspaceConnectionWriteResultSchema.parse(
    row ? { outcome: "written", connection: row } : { outcome: "missing" },
  );
}
