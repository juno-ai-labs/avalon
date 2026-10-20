import { WorkspaceExternalEventDeliveryQueueMessageSchema, type WorkspaceExternalEventDeliveryQueueMessage } from "@rally/contracts";
import { z } from "zod";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";

// Existing budget below the published 128 KB Queue message maximum.
export const MAX_CONNECTOR_EVENT_QUEUE_BYTES = 120_000;

export const ConnectorDeliveryReferenceSchema = z.strictObject({
  kind: z.literal("connector_event_delivery_reference"),
  delivery: WorkspaceExternalEventDeliveryQueueMessageSchema,
});

/** Large deliveries reload context from the canonical event instead of copying it into R2. */
export async function sendConnectorEventDelivery(env: Env, delivery: WorkspaceExternalEventDeliveryQueueMessage): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(delivery)).byteLength;
  await env.ACTIVITY_QUEUE.send(bytes <= MAX_CONNECTOR_EVENT_QUEUE_BYTES ? delivery : {
    kind: "connector_event_delivery_reference",
    delivery: { ...delivery, event: { ...delivery.event, textSnippet: "", metadata: {} } },
  });
}

export async function readConnectorDeliveryReference(env: Env, reference: z.infer<typeof ConnectorDeliveryReferenceSchema>): Promise<WorkspaceExternalEventDeliveryQueueMessage> {
  const delivery = reference.delivery;
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, delivery.workspaceId,
    workspaceDOName(env.AVALON_REGION, delivery.workspaceId));
  const context = z.object({ textSnippet: z.string(), metadata: z.record(z.string(), z.unknown()) }).parse(
    await workspace.connectorEventContext({ workspaceId: delivery.workspaceId, eventId: delivery.event.id }),
  );
  return { ...delivery, event: { ...delivery.event, ...context } };
}
