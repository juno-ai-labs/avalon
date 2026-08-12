import type { SlackOriginContext } from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";

import type { Env } from "../env";
import { truncateUtf16Safe } from "../lib/text";
import { logWarn } from "../observability/logger";
import { publishWorkstreamEvent } from "./integrations";

/**
 * The place a work stream started from, in the shape the `resources` table
 * stores it. A descriptor is provider-agnostic on purpose: every ingress that
 * can begin a work stream describes its own origin once, and the resolution,
 * attachment, and broadcast below are the same for all of them.
 */
export interface OriginResourceDescriptor {
  connectionId: string;
  provider: string;
  resourceType: string;
  providerResourceId: string;
  title: string;
  canonicalUrl: string | null;
  metadata: Record<string, unknown>;
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
 * The Slack conversation an invocation arrived in.
 *
 * Keyed on the thread rather than the channel because the thread is the place a
 * person would go back to: an `@Avalon` mention that opens a new top-level
 * message still gets a thread of its own, so there is always one, and it names
 * the channel through the title and metadata anyway. A DM has a thread too —
 * the root the agent posts when there is nothing to reply under.
 *
 * Slack Agent policy forbids storing provider content pulled in for context, so
 * nothing here carries message text: the identifiers, the channel name, and the
 * kind of conversation are origin metadata, and the content behind them stays
 * in Slack where an authorized tool can fetch it for a run.
 */
export function slackOriginResourceDescriptor(input: {
  connectionId: string;
  channelId: string;
  threadTs: string;
  origin: SlackOriginContext;
  permalink?: string | null;
}): OriginResourceDescriptor {
  return {
    connectionId: input.connectionId,
    provider: "slack",
    resourceType: "slack_thread",
    providerResourceId: `${input.channelId}:${input.threadTs}`,
    title: slackOriginTitle(input.origin),
    canonicalUrl: input.permalink ?? null,
    metadata: {
      teamId: input.origin.teamId,
      channelId: input.channelId,
      ...(input.origin.channelName ? { channelName: input.origin.channelName } : {}),
      threadTs: input.threadTs,
      channelType: input.origin.channelType,
      invocationType: input.origin.invocationType,
    },
    contentRef: null,
  };
}

function slackOriginTitle(origin: SlackOriginContext): string {
  if (origin.channelType === "im") return "Slack direct message";
  if (origin.channelName) return truncateUtf16Safe(`Thread in #${origin.channelName}`, 300);
  return "Slack thread";
}

/**
 * The columns of an `activities` row this module reads. Every one is optional
 * and untyped so that a caller holding a narrower row projection, or a raw
 * `Record<string, unknown>` off D1, passes it without a cast — the checks below
 * are the ones that decide whether a row can describe an origin at all.
 */
export interface ActivityOriginRow {
  connection_id?: unknown;
  provider?: unknown;
  resource_type?: unknown;
  provider_resource_id?: unknown;
  title?: unknown;
  metadata_json?: unknown;
  payload_ref?: unknown;
}

/**
 * The connector object an activity is about — the Linear issue, the GitHub pull
 * request, the Notion page. An activity that names no provider resource
 * describes something with no place to point at, and returns null rather than a
 * resource nobody can open.
 */
export function activityOriginResourceDescriptor(
  activity: ActivityOriginRow,
): OriginResourceDescriptor | null {
  if (typeof activity.connection_id !== "string" || activity.connection_id.length === 0) return null;
  if (typeof activity.provider_resource_id !== "string" || activity.provider_resource_id.length === 0) return null;
  if (typeof activity.provider !== "string" || activity.provider.length === 0) return null;
  const metadataJson = typeof activity.metadata_json === "string" ? activity.metadata_json : "{}";
  return {
    connectionId: activity.connection_id,
    provider: activity.provider,
    resourceType: typeof activity.resource_type === "string" && activity.resource_type.length > 0
      ? activity.resource_type
      : "activity",
    providerResourceId: activity.provider_resource_id,
    title: truncateUtf16Safe(String(activity.title ?? activity.provider), 300),
    canonicalUrl: connectorActivityUrl(metadataJson),
    metadata: parseMetadata(metadataJson),
    contentRef: typeof activity.payload_ref === "string" ? activity.payload_ref : null,
  };
}

/** Providers disagree on the key; take the first that is actually a link. */
export function connectorActivityUrl(metadataJson: string): string | null {
  const metadata = parseMetadata(metadataJson);
  for (const candidate of [metadata.canonicalUrl, metadata.url, metadata.htmlUrl, metadata.permalink]) {
    if (typeof candidate === "string" && /^https?:\/\//u.test(candidate)) return candidate;
  }
  return null;
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
  slackOriginTitle,
};
