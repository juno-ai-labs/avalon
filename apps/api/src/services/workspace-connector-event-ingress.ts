import type { NormalizedActivity } from "@rally/contracts";

import {
  WorkspaceConnectorEventQueueMessageSchema,
  WorkspaceConnectorEventSchema,
  type WorkspaceConnectorEvent,
  type WorkspaceConnectorEventQueueMessage,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";

const MAX_CONNECTOR_EVENT_QUEUE_BYTES = 120_000;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

/** Delivery-only fields do not change the provider event's durable identity. */
export async function workspaceConnectorEventPayloadHash(
  event: WorkspaceConnectorEvent,
): Promise<string> {
  const content = {
    ...event,
    activity: {
      ...event.activity,
      id: "",
      receivedAt: "",
    },
  };
  return `sha256:${await sha256Hex(canonicalJson(content))}`;
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
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_CONNECTOR_EVENT_QUEUE_BYTES) {
    throw new Error("workspace_connector_event_queue_payload_too_large");
  }
  await env.ACTIVITY_QUEUE.send(message);
}
