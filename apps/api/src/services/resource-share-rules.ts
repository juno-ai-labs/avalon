import type { MergeEmbed } from "@rally/contracts";

import type { AuthContext, Env } from "../env";
import { createAccessContext, requireAuthorizedRead } from "./authorization-service";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

/**
 * Whether a person may share a resource into a conversation or a Channel: the
 * one set of rules every attach and every merge applies, so a fix to one is a
 * fix to all (docs/conversation-merge.md). The resource exists in this
 * Organization, the person may read it where the caller asks for that, a
 * personal connection's resource is only its owner's to share, and an upload
 * is shared only once it was sent.
 */
export type ShareRefusal = "resource_not_found" | "resource_access_denied" | "attachment_draft_requires_message";

/**
 * Resolve each token (a resource's id or its alias) and check it, all before
 * anything is shared. A refusal names the position among the distinct tokens,
 * never the resource. `readCheck` asks the canonical resource check whether
 * the person may read each one; unavailable throws, so the caller can retry.
 */
export async function resolveShareableResources(
  env: Env,
  auth: AuthContext,
  tokens: readonly string[],
  options: { readCheck: boolean },
): Promise<
  | { ok: true; rows: Map<string, Record<string, unknown>> }
  | { ok: false; index: number; code: ShareRefusal }
> {
  const distinct = [...new Set(tokens)];
  const database = withWorkspaceRuntimeDatabase(env, auth.workspaceId).DB;
  const access = options.readCheck ? createAccessContext(env, auth) : null;
  const rows = new Map<string, Record<string, unknown>>();
  for (const [index, token] of distinct.entries()) {
    // One keyed read each: a handful of links in one message.
    const row = await database.prepare(
      `SELECT resource.*, connection.scope AS connection_scope,
              connection.owner_user_id
         FROM resources resource
         LEFT JOIN connector_connections connection ON connection.id = resource.connection_id
        WHERE (resource.id = ? OR resource.slug = ?) AND resource.workspace_id = ?`,
    ).bind(token, token, auth.workspaceId).first<Record<string, unknown>>();
    if (!row) return { ok: false, index, code: "resource_not_found" };
    const resourceId = String(row.id);
    if (access) {
      const decision = await access.check({ kind: "resource", workspaceId: auth.workspaceId, resourceId });
      if (decision.status === "unavailable") requireAuthorizedRead(decision);
      // Concealed as the read rule conceals it: one they may not read is absent to them.
      if (decision.status !== "allowed") return { ok: false, index, code: "resource_not_found" };
    }
    if (row.connection_scope === "personal" && row.owner_user_id !== auth.userId) {
      return { ok: false, index, code: "resource_access_denied" };
    }
    if (row.provider === "avalon_upload" && row.attachment_status !== "attached") {
      return { ok: false, index, code: "attachment_draft_requires_message" };
    }
    rows.set(resourceId, row);
  }
  return { ok: true, rows };
}

/** How a merge stores what it embeds: each resource's id, alias, title and kind. */
export function mergeEmbedsOf(rows: ReadonlyMap<string, Record<string, unknown>>): MergeEmbed[] {
  return [...rows.entries()].map(([id, row]) => ({
    id,
    ...(row.slug == null ? {} : { slug: String(row.slug) }),
    title: String(row.title).slice(0, 500),
    kind: String(row.resource_type).slice(0, 100),
  }));
}
