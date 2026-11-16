import { asWorkspaceId } from "@rally/contracts";
import {
  CanvasShareStateSchema,
  SharedCanvasSchema,
  type CanvasShareState,
  type SharedCanvas,
} from "@rally/contracts/canvas-share-federation";
import { z } from "zod";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import { settledFailureCode } from "../lib/settled-failure-code";
import { logWarn } from "../observability/logger";
import { SIDEBAR_LIST_LIMIT } from "./sidebar-reads";

/*
 * A person's "Shared with me" inbox in this deployment's D1
 * (`docs/canvas-share-federation.md`): pointers only, written by the
 * activity-queue consumer from what each Canvas's Organization publishes.
 * Nothing about a Canvas is copied here; a list asks the Canvas's own
 * Organization for what it shows, and that Organization checks again.
 */

/**
 * Apply one Organization's answer for one Canvas. A revision no newer than the
 * stored one changes nothing, so deliveries may arrive late or twice; `gone`
 * removes the row outright. Returns whether the inbox changed, which a rename
 * does too, since it bumps the revision.
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
  const written = await env.DB.prepare(
    `INSERT INTO canvas_share_inbox (user_id, workspace_id, canvas_id, revision, shared) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (user_id, workspace_id, canvas_id) DO UPDATE SET revision = excluded.revision, shared = excluded.shared
     WHERE excluded.revision > canvas_share_inbox.revision`,
  ).bind(...key, state.revision, state.state === "shared" ? 1 : 0).run();
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

export interface SharedCanvasPointers {
  organization: SharedCanvas["organization"];
  canvasIds: string[];
}

/**
 * The inbox's shared pointers for one Organization's list, grouped by the
 * Organization they point into: every other Organization the person is still
 * an active member or guest of, never the one reading.
 */
export async function readSharedCanvasPointers(env: Env, userId: string, excludeWorkspaceId: string): Promise<SharedCanvasPointers[]> {
  const rows = await env.DB.prepare(
    `SELECT i.workspace_id, w.name AS workspace_name, w.region, i.canvas_id
       FROM canvas_share_inbox i
       JOIN workspaces w ON w.id = i.workspace_id AND w.abandoned_at IS NULL
       JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.user_id = i.user_id AND m.status = 'active'
      WHERE i.user_id = ? AND i.shared = 1 AND i.workspace_id <> ?
      ORDER BY i.workspace_id, i.canvas_id`,
  ).bind(userId, excludeWorkspaceId).all<{ workspace_id: string; workspace_name: string; region: string; canvas_id: string }>();
  const groups = new Map<string, SharedCanvasPointers>();
  for (const row of rows.results) {
    const group = groups.get(row.workspace_id)
      ?? { organization: { id: asWorkspaceId(row.workspace_id), name: row.workspace_name, region: row.region }, canvasIds: [] };
    group.canvasIds.push(row.canvas_id);
    groups.set(row.workspace_id, group);
  }
  return [...groups.values()];
}

/**
 * What one Organization's list adds for this person: the inbox's pointers,
 * each resolved by the Canvas's own Organization, which answers only for a
 * Canvas still shared with them. Newest first, at most the sidebar list's own
 * bound. An Organization that cannot answer is logged by name and left out
 * until the next push. Empty while the setting is off.
 */
export async function readSharedCanvases(env: Env, userId: string, excludeWorkspaceId: string): Promise<{ enabled: boolean; items: SharedCanvas[] }> {
  if (!await readSharedCanvasesEnabled(env, userId)) return { enabled: false, items: [] };
  const groups = await readSharedCanvasPointers(env, userId, excludeWorkspaceId);
  const settled = await Promise.allSettled(groups.map(async (group) => {
    const origin = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, group.organization.id,
      workspaceDOName(env.AVALON_REGION, group.organization.id), await workspacePlacementAffinity(env, group.organization.id));
    const states = z.array(z.object({ canvasId: z.string(), state: CanvasShareStateSchema })).parse(
      await origin.canvasShareStates({ workspaceId: group.organization.id, userId, canvasIds: group.canvasIds }));
    return states.flatMap(({ canvasId, state }) => state.state === "shared" ? [SharedCanvasSchema.parse({
      organization: group.organization,
      canvas: {
        id: canvasId, title: state.title, updatedAt: new Date(state.updatedAt).toISOString(),
        ...(state.appearance ? { appearance: state.appearance } : {}),
      },
    })] : []);
  }));
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      logWarn(env, "shared_canvases_origin_unread", {
        workspace_id: groups[index]!.organization.id, user_id: userId, code: settledFailureCode(result.reason, "shared_canvases_origin"),
      });
    }
  });
  const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .sort((a, b) => b.canvas.updatedAt.localeCompare(a.canvas.updatedAt))
    .slice(0, SIDEBAR_LIST_LIMIT);
  return { enabled: true, items };
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
