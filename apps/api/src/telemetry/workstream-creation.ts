import type { UserId, WorkspaceId } from "@rally/contracts";
import {
  TELEMETRY_CONNECTOR_TYPES,
  TELEMETRY_WORKSTREAM_CREATION_SOURCES,
  type TelemetryConnectorType,
  type TelemetryWorkstreamCreationSource,
} from "@rally/contracts/telemetry";

import type { Env, IdentityAuthContext } from "../env";
import { logWarn } from "../observability/logger";
import { createMessageObjectPort } from "../runtime/message-port";
import {
  apiTelemetryEnvelope,
  emitAuthenticatedApiTelemetry,
  emitWorkspaceApiTelemetry,
} from "./api-emitter";
import { createIdentityObjectPort } from "../runtime/identity-port";

export const WORKSTREAM_CREATION_SOURCES = TELEMETRY_WORKSTREAM_CREATION_SOURCES;
export type WorkstreamCreationSource = TelemetryWorkstreamCreationSource;

type WorkstreamCreationPrincipal =
  | { type: "user"; userId: UserId }
  | { type: "workspace" };

interface WorkstreamCreationTelemetryInput {
  workspaceId: WorkspaceId;
  workstreamId: string;
  creationSource: WorkstreamCreationSource;
  connectorTypes?: readonly string[];
  operationId?: string | null;
  principal: WorkstreamCreationPrincipal;
}

const connectorTypeSet = new Set<string>(TELEMETRY_CONNECTOR_TYPES);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function normalizedConnectorTypes(values: readonly string[]): TelemetryConnectorType[] {
  const present = new Set(values.filter((value) => connectorTypeSet.has(value)));
  return TELEMETRY_CONNECTOR_TYPES.filter((value) => present.has(value));
}

function count(value: number): number {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

/**
 * Older/background work-stream producers still use UUIDv4 while telemetry ids
 * are UUIDv7-only. Replacing only the version nibble creates a stable,
 * event-specific insert id without mutating the resource id or persisting a
 * second identifier. The remaining 122 random bits retain UUID collision
 * resistance.
 */
export function workstreamCreationEventId(workstreamId: string): string {
  if (!uuid.test(workstreamId)) throw new Error("workstream_creation_id_invalid");
  return `${workstreamId.slice(0, 14)}7${workstreamId.slice(15)}`;
}

/**
 * Records the creation after its work-stream transaction commits. A stable id
 * derived from the work-stream UUID prevents retries and idempotent provider
 * deliveries from double-counting creation. This function deliberately absorbs
 * all telemetry failures: observation cannot fail the product operation.
 */
export async function recordWorkstreamCreatedTelemetry(
  env: Env,
  input: WorkstreamCreationTelemetryInput,
): Promise<void> {
  try {
    // The counts live with the work-stream authority — messages and their
    // attachments have no regional copy — so the read routes through the
    // runtime database rather than the regional handle the emitters use.
    const identity = createIdentityObjectPort(env, input.workspaceId, input.workstreamId);
    const row = await identity.identity();
    // Hidden execution machinery is not a product-created work stream.
    if (!row || row.system_kind !== null) return;
    // Both counts are asked after that check rather than beside it, which the
    // retired subqueries could not do: a hidden work stream now costs one read
    // instead of three.
    const participantCount = (await identity.participants()).length;
    const attachmentCount = await createMessageObjectPort(env, input.workspaceId, input.workstreamId)
      .openingAttachmentCount();

    const connectorTypes = normalizedConnectorTypes(input.connectorTypes ?? []);
    const connectorType = connectorTypes.length === 0
      ? "none"
      : connectorTypes.length === 1 ? connectorTypes[0]! : "multiple";
    const identityScope = input.principal.type === "user" ? "workspace-user" : "workspace";
    const eventId = workstreamCreationEventId(input.workstreamId);
    const event = apiTelemetryEnvelope(
      env,
      "workstream_created",
      {
        workstreamId: input.workstreamId,
        visibility: row.scope === "personal" ? "private" : "public",
        creationSource: input.creationSource,
        origin: row.origin_type,
        connectorType,
        connectorTypes,
        connectorTypeCount: connectorTypes.length,
        participantCount: count(participantCount),
        attachmentCount: count(attachmentCount),
        modelOverride: row.model_override !== null,
      },
      input.operationId ?? eventId,
      identityScope,
      env.AVALON_REGION,
      eventId,
    );

    if (input.principal.type === "workspace") {
      await emitWorkspaceApiTelemetry(env, input.workspaceId, event);
      return;
    }
    const auth: IdentityAuthContext = {
      sessionId: `telemetry:workstream-created:${input.workstreamId}`,
      userId: input.principal.userId,
      workspaceId: input.workspaceId,
      region: env.AVALON_REGION,
      role: null,
    };
    await emitAuthenticatedApiTelemetry(env, auth, event);
  } catch (error) {
    logWarn(env, "workstream_creation_telemetry_failed", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      creation_source: input.creationSource,
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }
}
