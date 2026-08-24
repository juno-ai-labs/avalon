import type { UserId, WorkspaceId } from "@avalon/contracts";
import {
  TELEMETRY_CONNECTOR_TYPES,
  TELEMETRY_WORKSTREAM_CREATION_SOURCES,
  type TelemetryConnectorType,
  type TelemetryWorkstreamCreationSource,
} from "@avalon/contracts/telemetry";

import type { Env, IdentityAuthContext } from "../env";
import { logWarn } from "../observability/logger";
import { createMessageObjectPort } from "../runtime/message-port";
import { withWorkstreamRuntimeDatabase } from "../services/workstream-runtime-database";
import {
  apiTelemetryEnvelope,
  emitAuthenticatedApiTelemetry,
  emitWorkspaceApiTelemetry,
} from "./api-emitter";

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

interface WorkstreamCreationRow {
  scope: "personal" | "workspace";
  origin_type: "ad_hoc" | "automation";
  system_kind: string | null;
  model_override: string | null;
  participant_count: number;
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
    const routed = withWorkstreamRuntimeDatabase(env, input.workspaceId, input.workstreamId);
    const row = await routed.DB.prepare(
      `SELECT w.scope, w.origin_type, w.system_kind, w.model_override,
              (SELECT COUNT(*) FROM workstream_participants participant
               WHERE participant.workstream_id = w.id AND participant.removed_at IS NULL) AS participant_count
       FROM workstreams w
       WHERE w.id = ? AND w.workspace_id = ?
       LIMIT 1`,
    ).bind(input.workstreamId, input.workspaceId).first<WorkstreamCreationRow>();
    // Hidden execution machinery is not a product-created work stream.
    if (!row || row.system_kind !== null) return;
    // Asked after that check rather than beside it, which the retired subquery
    // could not do: a hidden work stream now costs one read instead of two, and
    // the attachment half no longer rides in a statement whose other half
    // belongs to the identity slice.
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
        participantCount: count(row.participant_count),
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
