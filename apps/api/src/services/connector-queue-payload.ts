import { RegionSchema, WorkspaceIdSchema, type WorkspaceExternalEventDeliveryQueueMessage } from "@rally/contracts";
import { z } from "zod";
import type { WorkspaceConnectorEventQueueMessage } from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";

// Existing envelope budget, below the published 128 KB Queue message maximum:
// https://developers.cloudflare.com/queues/platform/limits/ (2026-10-19).
export const MAX_CONNECTOR_EVENT_QUEUE_BYTES = 120_000;

export const ConnectorQueuePayloadSchema = z.strictObject({
  kind: z.literal("connector_queue_payload"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

function payloadKey(input: z.infer<typeof ConnectorQueuePayloadSchema>): string {
  return `${input.region}/connector-queue/${input.workspaceId}/${input.sha256}.json`;
}

/** Large connector bodies ride by immutable reference; small bodies remain inline. */
export async function sendConnectorQueuePayload(
  env: Env,
  workspaceId: string,
  body: WorkspaceConnectorEventQueueMessage | WorkspaceExternalEventDeliveryQueueMessage,
): Promise<void> {
  const json = JSON.stringify(body);
  if (new TextEncoder().encode(json).byteLength <= MAX_CONNECTOR_EVENT_QUEUE_BYTES) {
    await env.ACTIVITY_QUEUE.send(body);
    return;
  }
  const reference = ConnectorQueuePayloadSchema.parse({
    kind: "connector_queue_payload", region: env.AVALON_REGION, workspaceId, sha256: await sha256Hex(json),
  });
  await env.PAYLOADS.put(payloadKey(reference), json, { httpMetadata: { contentType: "application/json" } });
  // Retain immutable staging through Queue retries/DLQ redrive. A failed send
  // must not delete a body another identical delivery may already reference.
  await env.ACTIVITY_QUEUE.send(reference);
}

export async function readConnectorQueuePayload(env: Env, input: unknown): Promise<unknown> {
  const reference = ConnectorQueuePayloadSchema.parse(input);
  if (reference.region !== env.AVALON_REGION) throw new Error("connector_queue_payload_region_mismatch");
  const object = await env.PAYLOADS.get(payloadKey(reference));
  if (!object) throw new Error("connector_queue_payload_missing");
  const json = await object.text();
  if (await sha256Hex(json) !== reference.sha256) throw new Error("connector_queue_payload_hash_mismatch");
  const body: unknown = JSON.parse(json);
  const coordinates = z.union([
    z.object({ kind: z.literal("workspace_connector_event"), region: RegionSchema,
      request: z.object({ workspaceId: WorkspaceIdSchema }) }),
    z.object({ type: z.literal("workspace_external_event_delivery_v1"), region: RegionSchema, workspaceId: WorkspaceIdSchema }),
  ]).parse(body);
  const workspaceId = "request" in coordinates ? coordinates.request.workspaceId : coordinates.workspaceId;
  if (coordinates.region !== reference.region || workspaceId !== reference.workspaceId) {
    throw new Error("connector_queue_payload_scope_mismatch");
  }
  return body;
}
