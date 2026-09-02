import type { Env } from "../env";
import { uuidV7 } from "../lib/uuid-v7";
import { logInfo, logWarn } from "../observability/logger";
import {
  LegacyWorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventIngestResultSchema,
  WorkspaceConnectorEventSchema,
  type WorkspaceConnectorEvent,
  type WorkspaceConnectorEventClaimRequest,
  type WorkspaceConnectorEventClaimRpcResult,
  type WorkspaceConnectorEventIngestRequest,
  type WorkspaceConnectorEventIngestResult,
  type WorkspaceConnectorEventRequest,
  type WorkspaceConnectorEventSettleRequest,
} from "./workspace-connector-event-protocol";
import { iso } from "./workspace-projection";

/**
 * The workspace's connector-event ledger: its row shape, the row-to-contract
 * mapper, and the writes that move an event through ingest, claim, and
 * settlement.
 *
 * Kept apart from the RPC class because the ledger is a state machine — a
 * canonical row chosen by provider identity or dedupe key, leased for a bounded
 * processing window, settled under a fence — and its three retention windows,
 * its lease length, and the statements enforcing them are one design that has to
 * be read together.
 */

export interface WorkspaceConnectorEventRow extends Record<string, SqlStorageValue> {
  event_id: string;
  payload_hash: string;
  connection_id: string;
  connection_scope: "personal" | "workspace";
  connection_owner_user_id: string | null;
  connector_type: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  resource_type: string | null;
  provider_resource_id: string | null;
  actor_json: string;
  subject_json: string;
  occurred_at: number;
  received_at: number;
  title: string;
  summary: string;
  text_snippet: string;
  payload_ref: string | null;
  visibility_json: string;
  target_user_ids_json: string;
  entity_keys_json: string;
  dedupe_key: string;
  raw_content_hash: string | null;
  metadata_json: string;
  external_people_json: string;
  processing_status: "pending" | "processing" | "processed" | "failed";
  processing_attempt: number;
  workflow_instance_id: string | null;
  processing_orchestrator: "queue" | "workflow" | null;
  claimed_at: number | null;
}

export const CONNECTOR_EVENT_INGRESS_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
// Queue consumers have a 15-minute platform wall-time limit. This expiry is
// only for Queue claims. A retiring Workflow can retry multiple 15-minute
// processing attempts, so its claim remains exclusive until it settles.
export const CONNECTOR_EVENT_PROCESSING_LEASE_MS = 15 * 60_000;
// Thirteen months, deliberately the most generous window in the fleet: event
// bodies are provenance input, and the 10 GB object ceiling is the only hard
// bound this fence exists to protect.
export const CONNECTOR_EVENT_BODY_RETENTION_MS = 396 * 24 * 60 * 60_000;

export function connectorEventFromRow(
  row: WorkspaceConnectorEventRow,
  workspaceId: string,
  region: Env["AVALON_REGION"],
): WorkspaceConnectorEvent {
  return WorkspaceConnectorEventSchema.parse({
    connectorType: row.connector_type,
    activity: {
      id: row.event_id,
      workspaceId,
      region,
      connectionId: row.connection_id,
      connectionScope: row.connection_scope,
      connectionOwnerUserId: row.connection_owner_user_id,
      provider: row.provider,
      providerEventId: row.provider_event_id,
      eventType: row.event_type,
      resourceType: row.resource_type,
      providerResourceId: row.provider_resource_id,
      actor: JSON.parse(row.actor_json) as unknown,
      subject: JSON.parse(row.subject_json) as unknown,
      occurredAt: iso(row.occurred_at),
      receivedAt: iso(row.received_at),
      title: row.title,
      summary: row.summary,
      textSnippet: row.text_snippet,
      payloadRef: row.payload_ref,
      visibility: JSON.parse(row.visibility_json) as unknown,
      targetUserIds: JSON.parse(row.target_user_ids_json) as unknown,
      entityKeys: JSON.parse(row.entity_keys_json) as unknown,
      dedupeKey: row.dedupe_key,
      rawContentHash: row.raw_content_hash,
      metadata: JSON.parse(row.metadata_json) as unknown,
      externalPeople: JSON.parse(row.external_people_json) as unknown,
    },
  });
}

export function latestConnectorEventSequence(storage: DurableObjectStorage): number {
  return storage.sql.exec<{ sequence: number }>(
    `SELECT COALESCE(MAX(event_sequence), 0) AS sequence FROM workspace_connector_events`,
  ).one().sequence;
}

/**
 * The canonical-event write behind {@link WorkspaceDO.ingestConnectorEvent}.
 *
 * Runs after the object has asserted its own workspace identity, so it takes
 * only the environment it logs and regionalizes against and the storage it
 * writes.
 */
export function ingestWorkspaceConnectorEvent(
  env: Env,
  storage: DurableObjectStorage,
  request: WorkspaceConnectorEventIngestRequest,
): WorkspaceConnectorEventIngestResult {
  const activity = request.event.activity;
  // Evaluators address canonical Rally identities, never provider IDs. Resolve
  // provider relationships once before the canonical event commits so every
  // destination sees one closed context without per-evaluator provider work.
  const relatedResourceIds = storage.sql.exec<{ id: string }>(
    `SELECT id FROM resources
      WHERE workspace_id = ? AND connection_id = ? AND provider = ?
        AND provider_resource_id IS NOT NULL
        AND (provider_resource_id = ? OR EXISTS (
          SELECT 1 FROM json_each(?) entity
           WHERE entity.value = resources.provider_resource_id
        ))
      ORDER BY id`,
    request.workspaceId,
    activity.connectionId,
    activity.provider,
    activity.providerResourceId,
    JSON.stringify(activity.entityKeys),
  ).toArray().map((row) => row.id);
  const resolvedPeople = (activity.externalPeople ?? []).flatMap((person) => {
    const row = storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM external_user_identities
        WHERE workspace_id = ? AND provider = ?
          AND provider_tenant_id = ? AND provider_user_id = ?`,
      request.workspaceId,
      person.provider,
      person.providerTenantId,
      person.providerUserId,
    ).toArray()[0];
    return row ? [{ userId: row.user_id, role: person.role }] : [];
  });
  const participantPersonIds = [...new Set(resolvedPeople.map((person) => person.userId))];
  const authorPersonIds = [...new Set(resolvedPeople
    .filter((person) => person.role === "author" || person.role === "actor")
    .map((person) => person.userId))];
  const evaluatorMetadata = {
    ...activity.metadata,
    ...(relatedResourceIds.length > 0 ? { resourceIds: relatedResourceIds } : {}),
    ...(participantPersonIds.length > 0 ? { participantPersonIds } : {}),
    ...(authorPersonIds.length > 0 ? { authorPersonIds } : {}),
    ...(authorPersonIds[0] ? { actorPersonId: authorPersonIds[0] } : {}),
  };
  const result = WorkspaceConnectorEventIngestResultSchema.parse(
    storage.transactionSync(() => {
      const receipt = storage.sql.exec<{
        payload_hash: string;
        connector_event_id: string;
        processing_status: WorkspaceConnectorEventRow["processing_status"];
        processing_attempt: number;
      }>(
        `SELECT receipt.payload_hash, receipt.connector_event_id, event.processing_status,
                event.processing_attempt
           FROM workspace_connector_event_ingress_receipts receipt
           JOIN workspace_connector_events event ON event.event_id = receipt.connector_event_id
          WHERE receipt.ingress_event_id = ?`,
        request.ingressEventId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.payload_hash !== request.payloadHash) {
          throw new Error("connector_event_ingress_idempotency_conflict");
        }
        return {
          eventId: receipt.connector_event_id,
          duplicate: true,
          processingStatus: receipt.processing_status,
          processingAttempt: receipt.processing_attempt,
        };
      }

      const byProvider = storage.sql.exec<WorkspaceConnectorEventRow>(
        `SELECT * FROM workspace_connector_events
          WHERE connection_id = ? AND provider_event_id = ? AND event_type = ?`,
        activity.connectionId,
        activity.providerEventId,
        activity.eventType,
      ).toArray()[0];
      const byDedupe = storage.sql.exec<WorkspaceConnectorEventRow>(
        `SELECT * FROM workspace_connector_events
          WHERE connection_id = ? AND dedupe_key = ?`,
        activity.connectionId,
        activity.dedupeKey,
      ).toArray()[0];
      if (byProvider && byDedupe && byProvider.event_id !== byDedupe.event_id) {
        throw new Error("connector_event_identity_collision");
      }
      const canonical = byProvider ?? byDedupe;
      if (canonical && canonical.payload_hash !== request.payloadHash) {
        throw new Error("connector_event_identity_reused_with_different_content");
      }

      const now = Date.now();
      let eventId = canonical?.event_id ?? activity.id;
      let processingStatus = canonical?.processing_status ?? "pending";
      if (!canonical) {
        storage.sql.exec(
          `INSERT INTO workspace_connector_events (
            event_id, payload_hash, connection_id, connection_scope,
            connection_owner_user_id, connector_type, provider,
            provider_event_id, event_type, resource_type, provider_resource_id,
            actor_json, subject_json, occurred_at, received_at, title, summary,
            text_snippet, payload_ref, visibility_json, target_user_ids_json,
            entity_keys_json, dedupe_key, raw_content_hash, metadata_json,
            external_people_json, processing_status, workflow_instance_id,
            processing_attempt, claimed_at, processed_at, processing_error, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, 'pending', NULL, -1, NULL, NULL, NULL, ?, ?
          )`,
          activity.id,
          request.payloadHash,
          activity.connectionId,
          activity.connectionScope,
          activity.connectionOwnerUserId,
          request.event.connectorType,
          activity.provider,
          activity.providerEventId,
          activity.eventType,
          activity.resourceType,
          activity.providerResourceId,
          JSON.stringify(activity.actor),
          JSON.stringify(activity.subject),
          Date.parse(activity.occurredAt),
          Date.parse(activity.receivedAt),
          activity.title,
          activity.summary,
          activity.textSnippet,
          activity.payloadRef,
          JSON.stringify(activity.visibility),
          JSON.stringify(activity.targetUserIds),
          JSON.stringify(activity.entityKeys),
          activity.dedupeKey,
          activity.rawContentHash,
          JSON.stringify(evaluatorMetadata),
          JSON.stringify(activity.externalPeople ?? []),
          now,
          now,
        );
        eventId = activity.id;
        processingStatus = "pending";
      }
      storage.sql.exec(
        `INSERT INTO workspace_connector_event_ingress_receipts
           (ingress_event_id, payload_hash, connector_event_id, received_at)
         VALUES (?, ?, ?, ?)`,
        request.ingressEventId,
        request.payloadHash,
        eventId,
        now,
      );
      storage.sql.exec(
        `DELETE FROM workspace_connector_event_ingress_receipts
          WHERE ingress_event_id IN (
            SELECT ingress_event_id FROM workspace_connector_event_ingress_receipts
             WHERE received_at < ?
             ORDER BY received_at, ingress_event_id LIMIT 100
          )`,
        now - CONNECTOR_EVENT_INGRESS_RECEIPT_RETENTION_MS,
      );
      // Processed event bodies are the highest-volume rows in the object,
      // and the only unbounded ones absent this reap. Thirteen months —
      // matching the longest regional retention anywhere in Avalon — dwarfs
      // every consumer's reach-back (opportunity evidence expires in weeks
      // and start snapshots copy what they need), so this is a size fence,
      // not a semantics change. Pending/failed rows never age out.
      storage.sql.exec(
        `DELETE FROM workspace_connector_events
          WHERE event_id IN (
            SELECT event_id FROM workspace_connector_events
             WHERE processing_status = 'processed' AND received_at < ?
             ORDER BY received_at, event_sequence LIMIT 50
          )`,
        now - CONNECTOR_EVENT_BODY_RETENTION_MS,
      );
      return {
        eventId,
        duplicate: Boolean(canonical),
        processingStatus,
        processingAttempt: canonical?.processing_attempt ?? -1,
      };
    }),
  );
  logInfo(env, "connector_event_authority_ingested", {
    workspace_id: request.workspaceId,
    connection_id: activity.connectionId,
    connector_type: request.event.connectorType,
    provider: activity.provider,
    ingress_event_id: request.ingressEventId,
    connector_event_id: result.eventId,
    duplicate: result.duplicate,
    processing_status: result.processingStatus,
    processing_attempt: result.processingAttempt,
    outcome: "committed",
  });
  return result;
}

/** One stored connector event as the contract shapes it, or null. */
export function workspaceConnectorEvent(
  env: Env,
  storage: DurableObjectStorage,
  request: WorkspaceConnectorEventRequest,
): WorkspaceConnectorEvent | null {
  const row = storage.sql.exec<WorkspaceConnectorEventRow>(
    `SELECT * FROM workspace_connector_events WHERE event_id = ?`,
    request.eventId,
  ).toArray()[0];
  return row ? connectorEventFromRow(row, request.workspaceId, env.AVALON_REGION) : null;
}

/**
 * The lease acquisition behind {@link WorkspaceDO.claimConnectorEvent}.
 *
 * `legacyWorkflowContract` shapes only the log line and the answer's schema; the
 * claim itself is identical either way.
 */
export function claimWorkspaceConnectorEvent(
  env: Env,
  storage: DurableObjectStorage,
  request: WorkspaceConnectorEventClaimRequest,
  legacyWorkflowContract: boolean,
): WorkspaceConnectorEventClaimRpcResult {
  const result = WorkspaceConnectorEventClaimResultSchema.parse(
    storage.transactionSync(() => {
      const row = storage.sql.exec<WorkspaceConnectorEventRow>(
        `SELECT * FROM workspace_connector_events WHERE event_id = ?`,
        request.eventId,
      ).toArray()[0];
      if (!row) throw new Error("connector_event_not_found");
      if (row.processing_status === "processed") return { outcome: "processed" as const };
      const now = Date.now();
      // A pre-cutover Workflow may replay its claim step after WorkspaceDO
      // committed the claim but before Workflows persisted the step result.
      // Reissuing that exact Workflow lease is idempotent. Queue owners are
      // only correlation IDs, so Queue replays must never use this exception.
      const sameLegacyWorkflowLease = request.orchestrator === "workflow"
        && row.processing_status === "processing"
        && (row.processing_orchestrator ?? "workflow") === "workflow"
        && row.workflow_instance_id === request.processingOwnerId;
      if (row.processing_status === "processing" && !sameLegacyWorkflowLease) {
        // A pre-v12 active claim has no discriminator because only Workflows
        // could create it. Workflow step timeouts apply per retry attempt, so
        // no finite Queue lease can safely prove that handler has stopped.
        // Its own terminal path either completes or enqueues a failed redrive.
        if ((row.processing_orchestrator ?? "workflow") === "workflow") {
          return {
            outcome: "busy" as const,
            reason: "legacy_workflow_active" as const,
            retryAt: null,
          };
        }
        const claimedAt = typeof row.claimed_at === "number" ? row.claimed_at : now;
        const retryAt = claimedAt + CONNECTOR_EVENT_PROCESSING_LEASE_MS;
        if (retryAt > now) {
          return {
            outcome: "busy" as const,
            reason: "active_lease_not_expired" as const,
            retryAt,
          };
        }
      }
      if (
        (row.processing_status === "processing" || row.processing_status === "failed")
        && request.attempt < row.processing_attempt
      ) {
        return {
          outcome: "busy" as const,
          reason: "failed_attempt_not_advanced" as const,
          retryAt: null,
        };
      }
      // `workflow_instance_id` is the compatibility-era physical column. A
      // Workflow's instance ID remains its lease; Queue claims receive a new
      // authority-generated UUID on every acquisition. Settlement fences on
      // this value, so an expired handler cannot settle its successor's work.
      const processingLeaseId = request.orchestrator === "workflow"
        ? request.processingOwnerId
        : uuidV7(now);
      const processingLeaseExpiresAt = request.orchestrator === "workflow"
        ? null
        : now + CONNECTOR_EVENT_PROCESSING_LEASE_MS;
      storage.sql.exec(
        `UPDATE workspace_connector_events
            SET processing_status = 'processing', workflow_instance_id = ?,
                processing_orchestrator = ?, processing_attempt = ?, claimed_at = ?,
                processing_error = NULL, updated_at = ?
          WHERE event_id = ?`,
        processingLeaseId,
        request.orchestrator,
        request.attempt,
        now,
        now,
        request.eventId,
      );
      return {
        outcome: "claimed" as const,
        event: connectorEventFromRow(row, request.workspaceId, env.AVALON_REGION),
        processingLeaseId,
        processingLeaseExpiresAt,
      };
    }),
  );
  logInfo(env, "connector_event_authority_claimed", {
    workspace_id: request.workspaceId,
    connector_event_id: request.eventId,
    processing_owner_id: request.processingOwnerId,
    processing_attempt: request.attempt,
    processing_orchestrator: request.orchestrator,
    processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
    processing_lease_id: result.outcome === "claimed" ? result.processingLeaseId : null,
    processing_lease_expires_at: result.outcome === "claimed"
      ? result.processingLeaseExpiresAt
      : result.outcome === "busy"
        ? result.retryAt
        : null,
    outcome: result.outcome,
    reason: result.outcome === "busy" ? result.reason : null,
  });
  if (!legacyWorkflowContract) return result;
  return LegacyWorkspaceConnectorEventClaimResultSchema.parse(
    result.outcome === "claimed"
      ? { outcome: "claimed", event: result.event }
      : { outcome: result.outcome },
  );
}

/** The fenced terminal write behind {@link WorkspaceDO.settleConnectorEvent}. */
export function settleWorkspaceConnectorEvent(
  env: Env,
  storage: DurableObjectStorage,
  request: WorkspaceConnectorEventSettleRequest,
  legacyWorkflowContract: boolean,
): void {
  // A persisted pre-cutover Workflow claim has no separate lease in its step
  // result; its instance ID is exactly the value stored in the physical lease
  // column, so this fallback is both narrow and replay-compatible.
  const processingLeaseId = request.processingLeaseId ?? request.processingOwnerId;
  const now = Date.now();
  const changed = storage.sql.exec<{ event_id: string }>(
    `UPDATE workspace_connector_events
        SET processing_status = ?, processed_at = CASE WHEN ? = 'processed' THEN ? ELSE NULL END,
            processing_error = ?, updated_at = ?
      WHERE event_id = ? AND workflow_instance_id = ? AND processing_status = 'processing'
      RETURNING event_id`,
    request.outcome,
    request.outcome,
    now,
    request.error,
    now,
    request.eventId,
    processingLeaseId,
  ).toArray().length;
  if (changed === 1) {
    logInfo(env, "connector_event_authority_terminal", {
      workspace_id: request.workspaceId,
      connector_event_id: request.eventId,
      processing_owner_id: request.processingOwnerId,
      processing_lease_id: processingLeaseId,
      processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
      outcome: request.outcome,
      reason: "settlement_committed",
    });
    return;
  }
  const settled = storage.sql.exec<{
    processing_status: WorkspaceConnectorEventRow["processing_status"];
    workflow_instance_id: string | null;
  }>(
    `SELECT processing_status, workflow_instance_id
       FROM workspace_connector_events WHERE event_id = ?`,
    request.eventId,
  ).toArray()[0];
  if (
    settled?.workflow_instance_id === processingLeaseId
    && settled.processing_status === request.outcome
  ) {
    logInfo(env, "connector_event_authority_terminal", {
      workspace_id: request.workspaceId,
      connector_event_id: request.eventId,
      processing_owner_id: request.processingOwnerId,
      processing_lease_id: processingLeaseId,
      processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
      outcome: request.outcome,
      reason: "settlement_replayed",
    });
    return;
  }
  logWarn(env, "connector_event_authority_settlement_failed", {
    workspace_id: request.workspaceId,
    connector_event_id: request.eventId,
    processing_owner_id: request.processingOwnerId,
    processing_lease_id: processingLeaseId,
    processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
    requested_outcome: request.outcome,
    authoritative_outcome: settled?.processing_status ?? "missing",
    authoritative_processing_owner_id: settled?.workflow_instance_id ?? null,
    reason: "settlement_fenced",
  });
  throw new Error("connector_event_settlement_fenced");
}
