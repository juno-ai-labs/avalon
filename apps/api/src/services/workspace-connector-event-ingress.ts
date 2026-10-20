import { MAX_CONNECTOR_EVENT_QUEUE_BYTES } from "./connector-queue-payload";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import { uuidV7 } from "../lib/uuid-v7";
export { MAX_CONNECTOR_EVENT_QUEUE_BYTES } from "./connector-queue-payload";
import type { NormalizedActivity } from "@rally/contracts";

import {
  WorkspaceConnectorEventQueueMessageSchema,
  WorkspaceConnectorEventProcessQueueMessageSchema,
  WorkspaceConnectorEventSchema,
  type WorkspaceConnectorEvent,
  type WorkspaceConnectorEventIngestRequest,
  type WorkspaceConnectorEventQueueMessage,
  type WorkspaceConnectorEventProcessQueueMessage,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";


/**
 * Two-stage handoff on one Queue:
 *
 * 1. Small `workspace_connector_event` messages carry the event into WorkspaceDO;
 *    oversized events call the same admission primitive directly.
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

/** Only known Google normalization enrichments may replay under an existing identity. */
export async function googleConnectorReplayCompatibility(stored: WorkspaceConnectorEvent, incoming: WorkspaceConnectorEvent): Promise<{ compatible: boolean; enrichedEvent: WorkspaceConnectorEvent | null }> {
  const old = stored.activity;
  const next = incoming.activity;
  const calendar = next.eventType === "calendar.event_changed" || next.eventType === "calendar.event_completed";
  const mail = next.eventType === "email.received" || next.eventType === "email.updated";
  if (old.provider !== "google" || next.provider !== "google" || (!calendar && !mail)) return { compatible: false, enrichedEvent: null };
  const metadata = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["resourceIds", "participantPersonIds", "authorPersonIds", "actorPersonId"].includes(key)));
  const oldMetadata = metadata(old.metadata);
  const nextMetadata = metadata(next.metadata);
  let enrichAttachments = false;
  let enrichPeople = false;
  if (calendar && (!Object.hasOwn(oldMetadata, "attachments") || !Object.hasOwn(nextMetadata, "attachments"))) {
    enrichAttachments = !Object.hasOwn(oldMetadata, "attachments") && Object.hasOwn(nextMetadata, "attachments");
    delete oldMetadata.attachments;
    delete nextMetadata.attachments;
  }
  let oldPeople = old.externalPeople ?? [];
  let nextPeople = next.externalPeople ?? [];
  // Historical adapters deduplicated structured people by role/id/email and
  // retained only the first 100. Compare that shape only across unequal sizes
  // where one side can actually be legacy; never mask two full current rosters.
  if (oldPeople.length !== nextPeople.length && Math.min(oldPeople.length, nextPeople.length) <= 100) {
    const legacy = (people: typeof oldPeople) => {
      const seen = new Set<string>();
      return people.filter((person) => {
        const key = JSON.stringify([person.role, person.providerUserId, person.email]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 100);
    };
    enrichPeople = nextPeople.length > oldPeople.length;
    oldPeople = legacy(oldPeople);
    nextPeople = legacy(nextPeople);
  }
  if (mail && oldPeople.length === nextPeople.length) {
    oldPeople = oldPeople.map((person, index) => {
      const other = nextPeople[index]!;
      const compact = (value: typeof person) => value.email !== null && value.sourceText.toLowerCase() === value.email.toLowerCase();
      if (!compact(person) && !compact(other)) return person;
      enrichPeople ||= next.externalPeople!.length >= old.externalPeople!.length && !compact(person) && compact(other);
      return { ...person, sourceText: person.email ?? person.sourceText };
    });
    nextPeople = nextPeople.map((person, index) => oldPeople[index]!.sourceText === oldPeople[index]!.email
      ? { ...person, sourceText: person.email ?? person.sourceText } : person);
  }
  const [oldHash, nextHash] = await Promise.all([
    workspaceConnectorEventPayloadHash({ ...stored, activity: { ...old, metadata: oldMetadata, externalPeople: oldPeople } }),
    workspaceConnectorEventPayloadHash({ ...incoming, activity: { ...next, metadata: nextMetadata, externalPeople: nextPeople } }),
  ]);
  const compatible = oldHash === nextHash;
  return { compatible, enrichedEvent: compatible && (enrichPeople || enrichAttachments) ? {
    ...stored,
    activity: {
      ...old,
      // Independent enrichments may arrive in either order during rollout.
      // Neither an older roster nor missing attachments may erase richer state.
      externalPeople: enrichPeople ? next.externalPeople : old.externalPeople,
      metadata: { ...metadata(old.metadata), ...(enrichAttachments ? { attachments: next.metadata.attachments } : {}) },
    },
  } : null };
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
    if (payloadBytes > MAX_CONNECTOR_EVENT_QUEUE_BYTES) {
      // The canonical authority owns the full event. Its receipt must commit
      // before we can queue IDs; retries reuse the existing admission primitive.
      await admitConnectorEvent(env, message.request, message.attempt);
    } else {
      await env.ACTIVITY_QUEUE.send(message);
    }
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

export async function admitConnectorEvent(
  env: Env,
  request: WorkspaceConnectorEventIngestRequest,
  requestedAttempt: number,
) {
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, request.workspaceId, workspaceDOName(env.AVALON_REGION, request.workspaceId));
  const accepted = await workspace.ingestConnectorEvent(request);
  const processingAttempt = accepted.processingStatus === "processing"
    ? accepted.processingAttempt
    : accepted.processingStatus === "failed"
      ? Math.max(requestedAttempt, accepted.processingAttempt + 1)
      : Math.max(0, requestedAttempt);
  const recordedAttempt = Math.min(processingAttempt, 5);
  let processingOwnerId: string | null = null;
  let processingOutcome:
    | "enqueued" | "active_processing" | "already_processed" | "attempts_exhausted" | "unchanged_content";
  if (accepted.unchangedContent) {
    // A repeat of an earlier event's content. That event's own admission
    // enqueued its processing; waking or retrying it again here would turn
    // every re-stamp into more work.
    processingOutcome = "unchanged_content";
  } else if (
    (accepted.processingStatus === "pending" || accepted.processingStatus === "failed")
    && processingAttempt <= 5
  ) {
    processingOwnerId = uuidV7();
    await enqueueWorkspaceConnectorEventProcess(env, {
      region: env.AVALON_REGION,
      workspaceId: request.workspaceId,
      eventId: accepted.eventId,
      processingOwnerId,
      processingAttempt: recordedAttempt,
    });
    processingOutcome = "enqueued";
  } else if (accepted.processingStatus === "processing") {
    processingOutcome = "active_processing";
  } else {
    processingOutcome = accepted.processingStatus === "processed"
      ? "already_processed"
      : "attempts_exhausted";
  }
  if (accepted.restoredEventId) {
    // Nothing else wakes a restored repeat: its own delivery was dropped.
    await enqueueWorkspaceConnectorEventProcess(env, {
      region: env.AVALON_REGION,
      workspaceId: request.workspaceId,
      eventId: accepted.restoredEventId,
      processingOwnerId: uuidV7(),
      processingAttempt: 0,
    });
  }
  return { accepted, processingAttempt, recordedAttempt, processingOwnerId, processingOutcome };
}
