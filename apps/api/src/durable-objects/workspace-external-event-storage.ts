import type { z } from "zod";
import type {
  WorkspaceExternalEventDeliveryClaimRequestSchema,
  WorkspaceExternalEventDeliverySettleRequestSchema} from "@rally/contracts";
import {
  ExternalEventEvaluatorV1Schema,
  type ExternalEventRegistrationProjectionV1,
  WorkspaceExternalEventDeliveryQueueMessageSchema,
  WorkspaceExternalEventDeliveryClaimResultSchema,
  WorkspaceExternalEventMatchResultSchema,
} from "@rally/contracts";

import type { Env } from "../env";
import { restrictedActivityUserIds } from "../lib/activity-visibility";
import { uuidV7 } from "../lib/uuid-v7";
import {
  CONNECTOR_EVENT_PROCESSING_LEASE_MS,
  latestConnectorEventSequence,
} from "./workspace-connector-event-storage";
import { evaluateExternalEventPredicate } from "../services/external-event-evaluator";
import { compareProjectionCoordinate } from "./workspace-projection";

/**
 * The workspace's external-event spine: which registrations are active, which
 * destinations one accepted connector event matches, and the leased delivery
 * receipts that carry it to each of them.
 *
 * Apart from the RPC class because registration projection, matching, claiming,
 * and settlement are one exactly-once protocol. A receipt is created
 * deterministically from the event and its destination, leased under a fence,
 * and settled against that same lease; the four writes only make sense read
 * together, and the object around them contributes nothing but its identity
 * assertion.
 */

function externalEventContext(
  metadata: Record<string, unknown>,
  textSnippet: string | null,
): Record<string, string | number | boolean | readonly string[]> {
  const context: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "boolean") context[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) context[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      context[key] = value;
    }
  }
  if (textSnippet !== null) context.messageText = textSnippet;
  return context;
}


/** Project one automation's external-event registration set, in one transaction. */
export function applyWorkspaceExternalEventRegistrations(
  storage: DurableObjectStorage,
  request: ExternalEventRegistrationProjectionV1,
): { applied: boolean; effectiveAfterEventSequence: number } {
return storage.transactionSync(() => {
  const destinationKind = request.destination.kind;
  const destinationKey = destinationKind === "automation"
    ? `automation:${request.destination.automationId}`
    : `workstream:${request.destination.workstreamId}:${request.destination.substreamId}:${request.destination.resourceId}`;
  const existing = storage.sql.exec<{
    authority_generation: number;
    projection_version: number;
    source_hash: string;
  }>(`SELECT authority_generation, projection_version, source_hash
        FROM workspace_external_event_registrations
       WHERE destination_kind = ?
         AND destination_key = ?
       ORDER BY authority_generation DESC, projection_version DESC LIMIT 1`,
  destinationKind, destinationKey).toArray()[0];
  if (existing) {
    const coordinate = compareProjectionCoordinate(
      request.authorityGeneration,
      request.projectionVersion,
      existing.authority_generation,
      existing.projection_version,
    );
    if (coordinate < 0) {
      return { applied: false, effectiveAfterEventSequence: latestConnectorEventSequence(storage) };
    }
    if (coordinate === 0) {
      if (existing.source_hash !== request.sourceHash) {
        throw new Error("external_event_registration_hash_conflict");
      }
      const cutoff = storage.sql.exec<{ cutoff: number }>(
        `SELECT MAX(effective_after_event_sequence) AS cutoff
           FROM workspace_external_event_registrations
          WHERE destination_kind = ? AND destination_key = ?
            AND authority_generation = ? AND projection_version = ?`,
        destinationKind,
        destinationKey,
        request.authorityGeneration,
        request.projectionVersion,
      ).toArray()[0]?.cutoff ?? latestConnectorEventSequence(storage);
      return { applied: false, effectiveAfterEventSequence: cutoff };
    }
  }
  const now = Date.now();
  const cutoff = latestConnectorEventSequence(storage);
  storage.sql.exec(
    `UPDATE workspace_external_event_registrations
        SET state = 'removed', updated_at = ?
      WHERE destination_kind = ? AND destination_key = ?
        AND state = 'active'`,
    now,
    destinationKind,
    destinationKey,
  );
  for (const evaluator of request.evaluators) {
    const registrationId = uuidV7();
    storage.sql.exec(
      `INSERT INTO workspace_external_event_registrations
         (registration_id, destination_key, workspace_id, authority_generation, projection_version,
          source_hash, effective_after_event_sequence, connection_id, connector_type,
          event_type, resource_id, evaluator_json, destination_kind, automation_id,
          workstream_id, substream_id, destination_resource_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      registrationId,
      destinationKey,
      request.workspaceId,
      request.authorityGeneration,
      request.projectionVersion,
      request.sourceHash,
      cutoff,
      evaluator.source.connectionId,
      evaluator.source.connectorType,
      evaluator.source.eventType,
      evaluator.source.resourceId ?? null,
      JSON.stringify(evaluator),
      destinationKind,
      destinationKind === "automation" ? request.destination.automationId : null,
      destinationKind === "workstream_resource_update" ? request.destination.workstreamId : null,
      destinationKind === "workstream_resource_update" ? request.destination.substreamId : null,
      destinationKind === "workstream_resource_update" ? request.destination.resourceId : null,
      now,
      now,
    );
  }
  return { applied: true, effectiveAfterEventSequence: cutoff };
});
}

/** Cheap connector-ingress admission check; matching still happens after normalization. */
export function hasActiveWorkspaceExternalEventRegistration(
  storage: DurableObjectStorage,
  request: { workspaceId: string; connectionId: string; eventType: string },
): { active: boolean } {
const row = storage.sql.exec<{ one: number }>(
  `SELECT 1 AS one
     FROM workspace_external_event_registrations
    WHERE workspace_id = ? AND connection_id = ? AND event_type = ? AND state = 'active'
    LIMIT 1`,
  request.workspaceId,
  request.connectionId,
  request.eventType,
).toArray()[0];
return { active: row !== undefined };
}

/** Deterministically create ID-only destination receipts for one accepted event. */
export function matchWorkspaceExternalEventDestinations(
  env: Env,
  storage: DurableObjectStorage,
  request: { workspaceId: string; eventId: string },
) {
const event = storage.sql.exec<{
  event_id: string;
  event_sequence: number;
  payload_hash: string;
  connection_id: string;
  connector_type: string;
  event_type: string;
  text_snippet: string | null;
  metadata_json: string;
  connection_scope: string;
  connection_owner_user_id: string | null;
  target_user_ids_json: string;
  visibility_json: string;
}>(`SELECT event_id, event_sequence, payload_hash, connection_id, connector_type,
          event_type, text_snippet, metadata_json, connection_scope,
          connection_owner_user_id, target_user_ids_json, visibility_json
      FROM workspace_connector_events WHERE event_id = ?`, request.eventId).toArray()[0];
if (!event) throw new Error("connector_event_not_found");
const metadata = JSON.parse(event.metadata_json) as Record<string, unknown>;
const context = externalEventContext(metadata, event.text_snippet);
const resourceIds = Array.isArray(metadata.resourceIds)
  ? metadata.resourceIds.filter((value): value is string => typeof value === "string")
  : [];
const registrations = storage.sql.exec<{
  registration_id: string;
  authority_generation: number;
  projection_version: number;
  source_hash: string;
  resource_id: string | null;
  evaluator_json: string;
  destination_kind: "automation" | "workstream_resource_update";
  automation_id: string | null;
  workstream_id: string | null;
}>(`SELECT registration_id, authority_generation, projection_version, source_hash,
          resource_id, evaluator_json, destination_kind, automation_id, workstream_id
      FROM workspace_external_event_registrations
     WHERE state = 'active' AND connection_id = ? AND connector_type = ?
       AND event_type = ? AND effective_after_event_sequence < ?
     ORDER BY registration_id`,
event.connection_id, event.connector_type, event.event_type, event.event_sequence).toArray();
// Who this activity may reach, from the one implementation of that rule.
// An automation is a reader like any other: a message in a private Slack
// channel arrives on the *workspace* connection and carries its restriction
// in `visibility`, so matching on connection and event type alone would let
// a personal automation's evaluator probe content its author cannot see.
// Refusing here rather than at admission means no delivery row is created,
// so nothing downstream has to re-derive the audience.
const restrictedUserIds = restrictedActivityUserIds(event);
const deliveries = storage.transactionSync(() => registrations.flatMap((registration) => {
  if (registration.resource_id && !resourceIds.includes(registration.resource_id)) return [];
  if (restrictedUserIds !== null && registration.destination_kind === "automation") {
    // A workspace automation is readable by every member, so a restricted
    // activity can never reach one. A personal automation may see it only
    // when its own author is inside the audience.
    const audience = registration.automation_id === null ? null : storage.sql.exec<{
      scope: string;
      author_user_id: string;
    }>(`SELECT scope, author_user_id FROM automation_directory WHERE automation_id = ?`,
      registration.automation_id).toArray()[0];
    if (!audience || audience.scope !== "personal") return [];
    if (!restrictedUserIds.includes(audience.author_user_id)) return [];
  }
  const evaluator = ExternalEventEvaluatorV1Schema.parse(JSON.parse(registration.evaluator_json));
  if (!evaluateExternalEventPredicate(evaluator.when, context)) return [];
  const destinationId = registration.automation_id ?? registration.workstream_id;
  if (!destinationId) throw new Error("external_event_destination_missing");
  const deliveryId = uuidV7();
  const payloadHash = `${event.payload_hash}:${registration.source_hash}`;
  const inserted = storage.sql.exec<{ delivery_id: string }>(
    `INSERT OR IGNORE INTO workspace_external_event_deliveries
       (delivery_id, workspace_event_id, event_sequence, registration_id,
        authority_generation, projection_version, source_hash, destination_kind,
        destination_id, payload_hash, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
     RETURNING delivery_id`,
    deliveryId,
    event.event_id,
    event.event_sequence,
    registration.registration_id,
    registration.authority_generation,
    registration.projection_version,
    registration.source_hash,
    registration.destination_kind,
    destinationId,
    payloadHash,
    Date.now(),
    Date.now(),
  ).toArray()[0];
  if (!inserted) return [];
  return [WorkspaceExternalEventDeliveryQueueMessageSchema.parse({
    type: "workspace_external_event_delivery_v1",
    schemaVersion: 1,
    region: env.AVALON_REGION,
    workspaceId: request.workspaceId,
    workspaceEventId: event.event_id,
    deliveryId: inserted.delivery_id,
    payloadHash,
  })];
}));
const pending = storage.sql.exec<{
  delivery_id: string;
  payload_hash: string;
}>(`SELECT delivery_id, payload_hash FROM workspace_external_event_deliveries
      WHERE workspace_event_id = ? AND state = 'pending'
      ORDER BY delivery_id`, event.event_id).toArray().map((row) => (
  WorkspaceExternalEventDeliveryQueueMessageSchema.parse({
    type: "workspace_external_event_delivery_v1",
    schemaVersion: 1,
    region: env.AVALON_REGION,
    workspaceId: request.workspaceId,
    workspaceEventId: event.event_id,
    deliveryId: row.delivery_id,
    payloadHash: row.payload_hash,
  })
));
const claimed = storage.sql.exec<{ claimed: number }>(
  `SELECT EXISTS(
     SELECT 1 FROM workspace_external_event_deliveries WHERE workspace_event_id = ?
   ) AS claimed`,
  event.event_id,
).one().claimed === 1;
return WorkspaceExternalEventMatchResultSchema.parse({
  claimed,
  deliveries: [...new Map([...deliveries, ...pending].map((delivery) => [delivery.deliveryId, delivery])).values()],
});
}

/** Take the delivery lease for one destination receipt, or say why not. */
export function claimWorkspaceExternalEventDelivery(
  storage: DurableObjectStorage,
  request: z.infer<typeof WorkspaceExternalEventDeliveryClaimRequestSchema>,
) {
return WorkspaceExternalEventDeliveryClaimResultSchema.parse(
  storage.transactionSync(() => {
    const row = storage.sql.exec<{
      state: string;
      payload_hash: string;
      lease_expires_at: number | null;
      destination_kind: "automation" | "workstream_resource_update";
      authority_generation: number;
      projection_version: number;
      automation_id: string | null;
      workstream_id: string | null;
      substream_id: string | null;
      destination_resource_id: string | null;
      event_id: string;
      event_sequence: number;
      event_type: string;
      title: string;
      summary: string;
      occurred_at: number;
      visibility_json: string;
      target_user_ids_json: string;
    }>(`SELECT delivery.state, delivery.payload_hash, delivery.lease_expires_at,
              registration.destination_kind, delivery.authority_generation,
              delivery.projection_version, registration.automation_id,
              registration.workstream_id, registration.substream_id,
              registration.destination_resource_id, event.event_id, event.event_sequence, event.event_type,
              event.title, event.summary, event.occurred_at, event.visibility_json,
              event.target_user_ids_json
          FROM workspace_external_event_deliveries delivery
          JOIN workspace_external_event_registrations registration
            ON registration.registration_id = delivery.registration_id
          JOIN workspace_connector_events event
            ON event.event_id = delivery.workspace_event_id
         WHERE delivery.delivery_id = ? AND delivery.workspace_event_id = ?`,
    request.deliveryId, request.workspaceEventId).toArray()[0];
    if (!row || row.payload_hash !== request.payloadHash) {
      throw new Error("external_event_delivery_not_found");
    }
    if (row.state === "delivered" || row.state === "not_delivered") return { outcome: "delivered" as const };
    const now = Date.now();
    if (row.state === "delivering" && (row.lease_expires_at ?? 0) > now) {
      return { outcome: "busy" as const, retryAt: row.lease_expires_at! };
    }
    const leaseExpiresAt = now + CONNECTOR_EVENT_PROCESSING_LEASE_MS;
    storage.sql.exec(
      `UPDATE workspace_external_event_deliveries
          SET state = 'delivering', lease_id = ?, lease_expires_at = ?,
              attempts = attempts + 1, updated_at = ?
        WHERE delivery_id = ?`,
      request.leaseId,
      leaseExpiresAt,
      now,
      request.deliveryId,
    );
    const visibility = JSON.parse(row.visibility_json) as { kind?: unknown; scope?: unknown };
    const audienceKind = visibility.kind === "workspace" || visibility.scope === "workspace"
      ? "workspace"
      : "restricted";
    const audienceUserIds = JSON.parse(row.target_user_ids_json) as string[];
    const destination = row.destination_kind === "automation"
      ? {
          kind: "automation" as const,
          automationId: row.automation_id!,
          authorityGeneration: row.authority_generation,
          projectionVersion: row.projection_version,
        }
      : {
          kind: "workstream_resource_update" as const,
          workstreamId: row.workstream_id!,
          substreamId: row.substream_id!,
          resourceId: row.destination_resource_id!,
          authorityGeneration: row.authority_generation,
          projectionVersion: row.projection_version,
        };
    return {
      outcome: "claimed" as const,
      leaseExpiresAt,
      destination,
      event: {
        id: row.event_id,
        eventSequence: row.event_sequence,
        eventType: row.event_type,
        title: row.title,
        summary: row.summary,
        occurredAt: row.occurred_at,
        audienceUserIds,
        audienceKind,
      },
    };
  }),
);
}

/** Settle one delivery against the lease it was claimed under. */
export function settleWorkspaceExternalEventDelivery(
  storage: DurableObjectStorage,
  request: z.infer<typeof WorkspaceExternalEventDeliverySettleRequestSchema>,
): void {
const changed = storage.sql.exec<{ delivery_id: string }>(
  `UPDATE workspace_external_event_deliveries
      SET state = ?, outcome_code = ?, lease_id = NULL, lease_expires_at = NULL,
          updated_at = ?
    WHERE delivery_id = ? AND state = 'delivering' AND lease_id = ?
    RETURNING delivery_id`,
  request.outcome,
  request.outcomeCode,
  Date.now(),
  request.deliveryId,
  request.leaseId,
).toArray();
if (changed.length === 1) return;
const settled = storage.sql.exec<{ state: string; outcome_code: string | null }>(
  `SELECT state, outcome_code FROM workspace_external_event_deliveries WHERE delivery_id = ?`,
  request.deliveryId,
).toArray()[0];
if (settled?.state === request.outcome && settled.outcome_code === request.outcomeCode) return;
throw new Error("external_event_delivery_settlement_fenced");
}
