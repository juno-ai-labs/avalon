import { sendConnectorQueuePayload } from "./connector-queue-payload";
export { MAX_CONNECTOR_EVENT_QUEUE_BYTES } from "./connector-queue-payload";
import type { NormalizedActivity } from "@rally/contracts";

import {
  WorkspaceConnectorEventQueueMessageSchema,
  WorkspaceConnectorEventProcessQueueMessageSchema,
  WorkspaceConnectorEventSchema,
  type WorkspaceConnectorEvent,
  type WorkspaceConnectorEventQueueMessage,
  type WorkspaceConnectorEventProcessQueueMessage,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";


/**
 * Two-stage handoff on one Queue:
 *
 * 1. `workspace_connector_event` carries the bounded event into WorkspaceDO.
 * 2. Only after that commit, `connector_event_process` carries IDs and claim
 *    fences; the consumer reloads the canonical event from WorkspaceDO.
 *
 * Ingress is acknowledged only after the second send is accepted. A crash or
 * send failure therefore replays the idempotent ingest instead of losing the
 * processing wake-up. Keeping event content out of stage 2 also keeps repeated
 * processing deliveries and the DLQ content-free. See `docs/connectors.md`.
 */

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

/** Hash the event with the named activity fields blanked. */
async function hashEventWithout(
  event: WorkspaceConnectorEvent,
  blanked: readonly (keyof NormalizedActivity)[],
): Promise<string> {
  const content = {
    ...event,
    activity: { ...event.activity, ...Object.fromEntries(blanked.map((field) => [field, ""])) },
  };
  return `sha256:${await sha256Hex(canonicalJson(content))}`;
}

/** Delivery-only fields do not change the provider event's durable identity. */
export async function workspaceConnectorEventPayloadHash(
  event: WorkspaceConnectorEvent,
): Promise<string> {
  // Ashby's email-change signal keeps its action ID on retry but renews the
  // watermark. Retain each raw delivery in R2; compare the normalized candidate
  // signal here, so renewed delivery metadata does not conflict with that ID.
  const renewableSignal = event.activity.provider === "ashby"
    && event.activity.eventType === "candidateRecentEmailMessagesUpdated";
  return hashEventWithout(event, [
    "id",
    "receivedAt",
    ...(renewableSignal ? ["payloadRef", "rawContentHash"] as const : []),
  ]);
}

/**
 * What the event says, without when or under which name it was said. Two
 * events for one resource with the same fingerprint tell a reader nothing new:
 * Google re-stamps a calendar event's `updated` with nothing visible changed,
 * and that stamp is the event's identity, so each touch arrives as a new event.
 * An adapter whose only change marker is its timestamp must put that marker in
 * the content as well, or its genuine repeats are suppressed as no-ops.
 */
export function workspaceConnectorEventContentFingerprint(
  event: WorkspaceConnectorEvent,
): Promise<string> {
  return hashEventWithout(event, [
    "id", "receivedAt", "occurredAt", "providerEventId", "dedupeKey", "payloadRef",
  ]);
}

export async function workspaceConnectorEventQueueMessage(input: {
  connectorType: string;
  activity: NormalizedActivity;
  attempt?: number;
}): Promise<WorkspaceConnectorEventQueueMessage> {
  const event = WorkspaceConnectorEventSchema.parse({
    connectorType: input.connectorType,
    activity: input.activity,
  });
  return WorkspaceConnectorEventQueueMessageSchema.parse({
    kind: "workspace_connector_event",
    region: input.activity.region,
    attempt: input.attempt ?? 0,
    request: {
      workspaceId: input.activity.workspaceId,
      ingressEventId: input.activity.id,
      payloadHash: await workspaceConnectorEventPayloadHash(event),
      event,
    },
  });
}

export async function enqueueWorkspaceConnectorEvent(
  env: Env,
  input: Parameters<typeof workspaceConnectorEventQueueMessage>[0],
): Promise<void> {
  const message = await workspaceConnectorEventQueueMessage(input);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
  try {
    await sendConnectorQueuePayload(env, input.activity.workspaceId, message);
  } catch (error) {
    logWarn(env, "connector_event_enqueue_failed", {
      workspace_id: message.request.workspaceId,
      connector_type: message.request.event.connectorType,
      ingress_event_id: message.request.ingressEventId,
      attempt: message.attempt,
      payload_bytes: payloadBytes,
      reason: diagnosticErrorCode(error, "queue_send_failed"),
      error_name: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
  logInfo(env, "connector_event_enqueued", {
    workspace_id: message.request.workspaceId,
    connector_type: message.request.event.connectorType,
    ingress_event_id: message.request.ingressEventId,
    attempt: message.attempt,
    payload_bytes: payloadBytes,
    outcome: "queued",
  });
}

export function workspaceConnectorEventProcessQueueMessage(input: {
  region: WorkspaceConnectorEventProcessQueueMessage["region"];
  workspaceId: WorkspaceConnectorEventProcessQueueMessage["workspaceId"];
  eventId: string;
  processingOwnerId: string;
  processingAttempt: number;
}): WorkspaceConnectorEventProcessQueueMessage {
  return WorkspaceConnectorEventProcessQueueMessageSchema.parse({
    kind: "connector_event_process",
    schemaVersion: 1,
    ...input,
  });
}

/** Enqueue the content-free second stage described by the module contract above. */
export async function enqueueWorkspaceConnectorEventProcess(
  env: Env,
  input: Parameters<typeof workspaceConnectorEventProcessQueueMessage>[0],
): Promise<void> {
  const message = workspaceConnectorEventProcessQueueMessage(input);
  try {
    await env.ACTIVITY_QUEUE.send(message);
  } catch (error) {
    logWarn(env, "connector_event_process_enqueue_failed", {
      workspace_id: message.workspaceId,
      connector_event_id: message.eventId,
      processing_owner_id: message.processingOwnerId,
      processing_attempt: message.processingAttempt,
      reason: diagnosticErrorCode(error, "queue_send_failed"),
      error_name: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
  logInfo(env, "connector_event_process_enqueued", {
    workspace_id: message.workspaceId,
    connector_event_id: message.eventId,
    processing_owner_id: message.processingOwnerId,
    processing_attempt: message.processingAttempt,
    outcome: "queued",
  });
}
