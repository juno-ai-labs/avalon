import {
  connectorOriginFromActivity,
  describeConnectorOrigin,
  type AuthorizedConnectorConnection,
  type ConnectorOriginActivity,
  type ConnectorOriginLocator,
} from "@rally/connectors";
import type { ConnectorOriginResource } from "@rally/contracts";
import { ConnectorOriginResourceSchema } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";

import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { truncateUtf16Safe } from "../lib/text";
import { logWarn } from "../observability/logger";
import { publishWorkstreamEvent } from "./integrations";
import { attachWorkstreamRuntimeResource } from "./workstream-object-client";

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
 * places: the `workstream_list_resources` tool hands the relationship to the model, which
 * is how it can tell the channel it was summoned from apart from a document
 * somebody attached afterwards, and a future detach path must not treat the two
 * alike — removing the origin loses the only record of where the work stream
 * came from.
 */
const ORIGIN_RELATIONSHIP_TYPE = "origin";

const ORIGIN_RESOURCE_LOOKUP_SQL = `SELECT id, canonical_url, content_ref FROM resources
  WHERE workspace_id = ? AND connection_id = ? AND provider = ? AND provider_resource_id = ?`;

/**
 * Fills a gap in a row somebody else created; never rewrites an answer.
 *
 * The `IS NULL` in the predicate is a compare-and-set, not decoration: two
 * callers describing the same object at once must not have one overwrite the
 * other's value, and a row that already has a link is not improved by a second
 * opinion about it. Title and resource type are deliberately absent — those
 * belong to whichever path created the row, and rewriting them would make the
 * rail's wording flip depending on which ingress ran most recently.
 */
const BACKFILL_ORIGIN_RESOURCE_SQL = `UPDATE resources
  SET canonical_url = COALESCE(canonical_url, ?),
      content_ref = COALESCE(content_ref, ?),
      updated_at = ?
  WHERE id = ? AND workspace_id = ?
    AND ((canonical_url IS NULL AND ? IS NOT NULL) OR (content_ref IS NULL AND ? IS NOT NULL))`;

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
  connection?: AuthorizedConnectorConnection;
  signal?: AbortSignal;
}): Promise<OriginResourceDescriptor | null> {
  const origin = await describeOrigin(env, input);
  if (!origin) return null;
  return {
    ...origin,
    connectionId: input.connectionId,
    provider: input.provider,
    // An origin never carries content. `payload_ref` on an activity addresses
    // the raw verified webhook body in R2, and `workstream_read_resource` serves
    // whatever `content_ref` points at to the model with no connector
    // authorization of its own — so copying it here would turn "record where
    // this came from" into "publish the provider payload to the run", against
    // the boundary this module states. Content stays where an authorized tool
    // has to go and fetch it.
    contentRef: null,
  };
}

async function describeOrigin(env: Env, input: {
  connectorType: string;
  locator: ConnectorOriginLocator;
  connection?: AuthorizedConnectorConnection;
  signal?: AbortSignal;
}): Promise<ConnectorOriginResource | null> {
  let adapter;
  try {
    adapter = connectorRegistryForEnv(env).get(input.connectorType);
  } catch (error) {
    // Only a registry that cannot be built lands here — one misconfigured
    // credential taking every connector down with it. An activity needs no
    // adapter to be described, so the base derivation keeps the provenance of
    // every other connector's work streams rather than losing it to Slack's
    // signing secret being absent.
    //
    // Deliberately narrower than it was: catching the description as well
    // swallowed `describeConnectorOrigin`'s manifest check and answered with the
    // derived origin instead, which is the one outcome that check exists to
    // prevent — a connector's undeclared resource type would have been reported
    // as a warning and then quietly worked around.
    logWarn(env, "connector_registry_unavailable_for_origin", {
      connector_type: input.connectorType,
      locator_kind: input.locator.kind,
      reason: error instanceof Error ? error.message : "unknown",
    });
    if (input.locator.kind !== "activity") return null;
    const derived = connectorOriginFromActivity(input.locator.activity);
    if (!derived) return null;
    // `safeParse`, because this is the one parse with no `describeConnectorOrigin`
    // around it and a throw here would escape the whole function. Every caller
    // awaits this between committing a work stream and launching its run, so an
    // exception would leave a row at `harness_status = 'running'` with nothing
    // behind it — the origin is not worth that.
    const parsed = ConnectorOriginResourceSchema.safeParse(derived);
    return parsed.success ? parsed.data : null;
  }
  try {
    return await describeConnectorOrigin(adapter, input.locator, {
      ...(input.connection ? { connection: input.connection } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // A connector bug — an undeclared resource type, a description that fails
    // the contract. It produces no origin rather than a substitute one: the
    // adapter said where the work stream came from and was wrong about it, and
    // guessing on its behalf is how a typo becomes a forked resource identity.
    logWarn(env, "workstream_origin_description_failed", {
      connector_type: input.connectorType,
      locator_kind: input.locator.kind,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
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
    await attachWorkstreamRuntimeResource(env, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      resourceId,
      attachedByUserId: input.attachedByUserId,
      relationshipType: ORIGIN_RELATIONSHIP_TYPE,
    });
  
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
  const existing = await env.DB.prepare(ORIGIN_RESOURCE_LOOKUP_SQL).bind(...bindings).first<{
    id: string;
    canonical_url: string | null;
    content_ref: string | null;
  }>();
  if (existing) {
    // The row is shared with every other path that resolves this object, and
    // whichever ran first may have known less than this caller does — an
    // activity carries no permalink, so a Slack thread described later with one
    // would otherwise attach a row that cannot be opened.
    const fillsUrl = existing.canonical_url == null && descriptor.canonicalUrl != null;
    const fillsContent = existing.content_ref == null && descriptor.contentRef != null;
    if (fillsUrl || fillsContent) {
      await env.DB.prepare(BACKFILL_ORIGIN_RESOURCE_SQL).bind(
        descriptor.canonicalUrl,
        descriptor.contentRef,
        nowIso(),
        existing.id,
        workspaceId,
        descriptor.canonicalUrl,
        descriptor.contentRef,
      ).run();
    }
    return existing.id;
  }
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
    currentVersion: Math.max(1, Number(row.current_version ?? 1)),
    relationshipType: "origin" as const,
    direction: "source" as const,
  };
}

export const __originResourceTesting = {
  originResourceLookupSql: ORIGIN_RESOURCE_LOOKUP_SQL,
  originRelationshipType: ORIGIN_RELATIONSHIP_TYPE,
};
