import {
  connectorOriginFromActivity,
  describeConnectorOrigin,
  type AuthorizedConnectorConnection,
  type ConnectorOriginActivity,
  type ConnectorOriginLocator,
} from "@avalon/connectors";
import type { ConnectorOriginResource } from "@avalon/contracts";
import { ConnectorOriginResourceSchema } from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";

import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { truncateUtf16Safe } from "../lib/text";
import { logWarn } from "../observability/logger";
import { publishWorkstreamEvent } from "./integrations";

/**
 * A connector origin bound to the installed credential it was reached through.
 *
 * The connector answers *which object*; the host answers *whose connection*.
 * Keeping the two apart is what stops an adapter from being able to describe an
 * origin against a connection it was never given.
 */
export interface OriginResourceDescriptor extends ConnectorOriginResource {
  connectionId: string;
  provider: string;
  contentRef: string | null;
}

/**
 * `origin` rather than `attachment`, and the distinction is load-bearing in two
 * places: the `workstream_read` tool hands the relationship to the model, which
 * is how it can tell the channel it was summoned from apart from a document
 * somebody attached afterwards, and a future detach path must not treat the two
 * alike — removing the origin loses the only record of where the work stream
 * came from.
 */
const ORIGIN_RELATIONSHIP_TYPE = "origin";

const ORIGIN_RESOURCE_LOOKUP_SQL = `SELECT id FROM resources
  WHERE workspace_id = ? AND connection_id = ? AND provider = ? AND provider_resource_id = ?`;

const ATTACH_ORIGIN_RESOURCE_SQL = `INSERT INTO workstream_resources
  (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
  VALUES (?, ?, ?, 0, '${ORIGIN_RELATIONSHIP_TYPE}', ?)
  ON CONFLICT(workstream_id, resource_id) DO NOTHING`;

const ATTACHED_ORIGIN_RESOURCE_SQL = `SELECT * FROM resources WHERE id = ? AND workspace_id = ?`;

/**
 * Ask a connector where a work stream is being started from.
 *
 * Every ingress goes through here, and none of them knows a provider: the
 * locator carries whatever that connector understands — a normalized activity,
 * or the provider's own session payload — and the adapter turns it into an
 * origin. A connector that implements nothing still answers for its activities,
 * because `connectorOriginFromActivity` in the connector base derives one from
 * the object normalization already recorded.
 *
 * `connection` is optional and buys one thing: an adapter that can only get its
 * canonical URL by asking the provider is allowed to, under the host's
 * credential door. Callers that have no authorized connection to hand still get
 * the origin, without the link.
 */
export async function describeWorkstreamOrigin(env: Env, input: {
  connectorType: string;
  connectionId: string;
  provider: string;
  locator: ConnectorOriginLocator;
  contentRef?: string | null;
  connection?: AuthorizedConnectorConnection;
  signal?: AbortSignal;
}): Promise<OriginResourceDescriptor | null> {
  const origin = await describeOrigin(env, input);
  if (!origin) return null;
  return {
    ...origin,
    connectionId: input.connectionId,
    provider: input.provider,
    contentRef: input.contentRef ?? null,
  };
}

async function describeOrigin(env: Env, input: {
  connectorType: string;
  locator: ConnectorOriginLocator;
  connection?: AuthorizedConnectorConnection;
  signal?: AbortSignal;
}): Promise<ConnectorOriginResource | null> {
  try {
    return await describeConnectorOrigin(
      connectorRegistryForEnv(env).get(input.connectorType),
      input.locator,
      {
        ...(input.connection ? { connection: input.connection } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
  } catch (error) {
    // A registry that cannot be built is one misconfigured credential taking
    // every connector down with it, and an activity needs no adapter to be
    // described — falling back to the base derivation keeps the provenance of
    // every other connector's work streams rather than losing it to Slack's
    // signing secret being absent.
    logWarn(env, "workstream_origin_description_failed", {
      connector_type: input.connectorType,
      locator_kind: input.locator.kind,
      reason: error instanceof Error ? error.message : "unknown",
    });
    if (input.locator.kind !== "activity") return null;
    const derived = connectorOriginFromActivity(input.locator.activity);
    return derived ? ConnectorOriginResourceSchema.parse(derived) : null;
  }
}

/**
 * The `activities` columns the origin locator reads, under the names D1 returns
 * them. Every caller here holds a stored row rather than a `NormalizedActivity`,
 * so this is the one place the two spellings meet.
 */
export function activityOriginLocator(row: {
  resource_type?: unknown;
  provider_resource_id?: unknown;
  title?: unknown;
  metadata_json?: unknown;
}): ConnectorOriginLocator {
  const activity: ConnectorOriginActivity = {
    resourceType: typeof row.resource_type === "string" ? row.resource_type : null,
    providerResourceId: typeof row.provider_resource_id === "string" ? row.provider_resource_id : null,
    title: typeof row.title === "string" ? row.title : null,
    metadata: parseMetadata(typeof row.metadata_json === "string" ? row.metadata_json : "{}"),
  };
  return { kind: "activity", activity };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Record the place a work stream started from, as a resource attached to it.
 *
 * Best-effort by construction. Every caller is on a creation path a person is
 * waiting on — a Slack mention, a suggestion they tapped, an automation that
 * fired — and none of them should fail because the origin could not be written
 * down. A failure is logged and the work stream carries on without the
 * attachment; the alternative is losing the whole run over a provenance record.
 *
 * Returns the resource id when the attachment landed, and null otherwise.
 */
export async function attachWorkstreamOriginResource(env: Env, input: {
  workspaceId: string;
  workstreamId: string;
  attachedByUserId: string | null;
  descriptor: OriginResourceDescriptor;
}): Promise<string | null> {
  try {
    const resourceId = await resolveOriginResource(env, input.workspaceId, input.descriptor);
    if (!resourceId) return null;
    await env.DB.prepare(ATTACH_ORIGIN_RESOURCE_SQL)
      .bind(input.workstreamId, resourceId, input.attachedByUserId, nowIso())
      .run();
    const row = await env.DB.prepare(ATTACHED_ORIGIN_RESOURCE_SQL)
      .bind(resourceId, input.workspaceId)
      .first<Record<string, unknown>>();
    // The rail renders from the socket event, so a work stream open on a screen
    // while its origin lands still shows it without a refetch.
    if (row) {
      await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, {
        type: "resource_attached",
        resource: originResourceEvent(row),
      });
    }
    return resourceId;
  } catch (error) {
    logWarn(env, "workstream_origin_resource_attach_failed", {
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      provider: input.descriptor.provider,
      resource_type: input.descriptor.resourceType,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

/**
 * The resource row for a descriptor, created if this workspace has never seen
 * the object before.
 *
 * Keyed on `(workspace, connection, provider, providerResourceId)` — the same
 * tuple every other resource path uses — so a second work stream started from
 * the same Slack thread, or a suggestion later accepted against the same Linear
 * issue, attaches the row that already exists instead of a second copy of it.
 */
export async function resolveOriginResource(
  env: Env,
  workspaceId: string,
  descriptor: OriginResourceDescriptor,
): Promise<string | null> {
  const bindings = [
    workspaceId,
    descriptor.connectionId,
    descriptor.provider,
    descriptor.providerResourceId,
  ] as const;
  const existing = await env.DB.prepare(ORIGIN_RESOURCE_LOOKUP_SQL).bind(...bindings).first<{ id: string }>();
  if (existing) return existing.id;
  const at = nowIso();
  await env.DB.prepare(
    `INSERT INTO resources
     (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
      title, content_ref, canonical_url, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(
    newId(),
    workspaceId,
    descriptor.connectionId,
    descriptor.resourceType,
    descriptor.provider,
    descriptor.providerResourceId,
    truncateUtf16Safe(descriptor.title, 300),
    descriptor.contentRef,
    descriptor.canonicalUrl,
    JSON.stringify(descriptor.metadata),
    at,
    at,
  ).run();
  // Read back rather than trusting the generated id: a concurrent create for
  // the same object leaves one row, and both callers must attach that one.
  const canonical = await env.DB.prepare(ORIGIN_RESOURCE_LOOKUP_SQL).bind(...bindings).first<{ id: string }>();
  return canonical?.id ?? null;
}

/**
 * An origin attachment is never watched at birth — a watch is a decision
 * somebody makes afterwards — so the broadcast state is the resting state a
 * freshly attached connector resource has.
 */
function originResourceEvent(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    connectionId: row.connection_id == null ? null : String(row.connection_id),
    resourceType: String(row.resource_type),
    provider: String(row.provider),
    providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
    title: String(row.title),
    mimeType: row.mime_type == null ? null : String(row.mime_type),
    canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
    watchEnabled: false,
    watchStatus: row.connection_id == null ? "unsupported" as const : "paused" as const,
    lastHydratedAt: row.last_hydrated_at == null ? null : String(row.last_hydrated_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const __originResourceTesting = {
  attachOriginResourceSql: ATTACH_ORIGIN_RESOURCE_SQL,
  originResourceLookupSql: ORIGIN_RESOURCE_LOOKUP_SQL,
  originRelationshipType: ORIGIN_RELATIONSHIP_TYPE,
};
