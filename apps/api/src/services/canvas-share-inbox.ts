import { asWorkspaceId } from "@rally/contracts";
import {
  SharedCanvasSchema,
  type CanvasShareState,
  type SharedCanvas,
} from "@rally/contracts/canvas-share-federation";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import { settledFailureCode } from "../lib/settled-failure-code";
import { logWarn } from "../observability/logger";
import { SIDEBAR_LIST_LIMIT } from "./sidebar-reads";

/*
 * A person's "Shared with me" inbox in this deployment's D1
 * (`docs/canvas-share-federation.md`): written only by the activity-queue
 * consumer from what each Canvas's Organization publishes, and read by every
 * other Organization the person opens.
 */

/**
 * Apply one Organization's answer for one Canvas. A revision no newer than the
 * stored one changes nothing, so deliveries may arrive late or twice; `gone`
 * removes the row outright. Returns whether the inbox changed.
 */
export async function applyCanvasShare(env: Env, target: { userId: string; workspaceId: string; canvasId: string },
  state: CanvasShareState): Promise<boolean> {
  const key = [target.userId, target.workspaceId, target.canvasId] as const;
  if (state.state === "gone") {
    const removed = await env.DB.prepare(
      `DELETE FROM canvas_share_inbox WHERE user_id = ? AND workspace_id = ? AND canvas_id = ?`,
    ).bind(...key).run();
    return Number(removed.meta.changes ?? 0) > 0;
  }
  const shared = state.state === "shared";
  const written = await env.DB.prepare(
    `INSERT INTO canvas_share_inbox (user_id, workspace_id, canvas_id, revision, shared, title, appearance_json, canvas_updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (user_id, workspace_id, canvas_id) DO UPDATE SET
       revision = excluded.revision, shared = excluded.shared,
       title = CASE WHEN excluded.shared = 1 THEN excluded.title ELSE canvas_share_inbox.title END,
       appearance_json = CASE WHEN excluded.shared = 1 THEN excluded.appearance_json ELSE canvas_share_inbox.appearance_json END,
       canvas_updated_at = CASE WHEN excluded.shared = 1 THEN excluded.canvas_updated_at ELSE canvas_share_inbox.canvas_updated_at END
     WHERE excluded.revision > canvas_share_inbox.revision`,
  ).bind(
    ...key, state.revision, shared ? 1 : 0,
    shared ? state.title : "", shared && state.appearance ? JSON.stringify(state.appearance) : null,
    shared ? state.updatedAt : 0,
  ).run();
  return Number(written.meta.changes ?? 0) > 0;
}

/** Whether this person's inbox joins every Organization's list; no row is on. */
export async function readSharedCanvasesEnabled(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT enabled FROM canvas_share_inbox_settings WHERE user_id = ?`)
    .bind(userId).first<{ enabled: number }>();
  return row?.enabled !== 0;
}

export async function writeSharedCanvasesEnabled(env: Env, userId: string, enabled: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO canvas_share_inbox_settings (user_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).bind(userId, enabled ? 1 : 0, new Date().toISOString()).run();
}

/**
 * What one Organization's list adds for this person: the Canvases shared with
 * them in every other Organization they are still an active member or guest
 * of, newest first, at most the sidebar list's own bound. Empty while off.
 */
export async function readSharedCanvases(env: Env, userId: string, excludeWorkspaceId: string): Promise<{ enabled: boolean; items: SharedCanvas[] }> {
  if (!await readSharedCanvasesEnabled(env, userId)) return { enabled: false, items: [] };
  const rows = await env.DB.prepare(
    `SELECT i.workspace_id, w.name AS workspace_name, w.region, i.canvas_id, i.title, i.appearance_json, i.canvas_updated_at
       FROM canvas_share_inbox i
       JOIN workspaces w ON w.id = i.workspace_id AND w.abandoned_at IS NULL
       JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.user_id = i.user_id AND m.status = 'active'
      WHERE i.user_id = ? AND i.shared = 1 AND i.workspace_id <> ?
      ORDER BY i.canvas_updated_at DESC
      LIMIT ?`,
  ).bind(userId, excludeWorkspaceId, SIDEBAR_LIST_LIMIT).all<{
    workspace_id: string; workspace_name: string; region: string; canvas_id: string; title: string;
    appearance_json: string | null; canvas_updated_at: number;
  }>();
  return {
    enabled: true,
    items: rows.results.map((row) => SharedCanvasSchema.parse({
      organization: { id: row.workspace_id, name: row.workspace_name, region: row.region },
      canvas: {
        id: row.canvas_id, title: row.title, updatedAt: new Date(row.canvas_updated_at).toISOString(),
        ...(row.appearance_json ? { appearance: JSON.parse(row.appearance_json) as unknown } : {}),
      },
    })),
  };
}

/**
 * Tell each Organization this person is in here, but `exceptWorkspaceId`, to
 * push their shared Canvases to their open sockets. One that fails is logged
 * by name and the rest still hear; its sockets read the inbox on reconnect.
 */
export async function publishSharedCanvasesToOrganizations(env: Env, userId: string, exceptWorkspaceId: string | null): Promise<void> {
  const memberships = await env.DB.prepare(
    `SELECT m.workspace_id FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? AND m.status = 'active' AND w.region = ? AND w.abandoned_at IS NULL`,
  ).bind(userId, env.AVALON_REGION).all<{ workspace_id: string }>();
  const targets = memberships.results.map((row) => row.workspace_id).filter((id) => id !== exceptWorkspaceId);
  const settled = await Promise.allSettled(targets.map(async (workspaceId) => {
    const stub = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)), await workspacePlacementAffinity(env, workspaceId));
    await stub.publishSharedCanvases({ workspaceId, userId });
  }));
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      logWarn(env, "shared_canvases_publish_failed", {
        workspace_id: targets[index], user_id: userId, code: settledFailureCode(result.reason, "shared_canvases_publish"),
      });
    }
  });
}
