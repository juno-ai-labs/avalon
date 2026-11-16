import { asUserId, asWorkspaceId, type WorkspaceId } from "@rally/contracts";
import {
  GuestSharedCanvasSchema,
  type SharedCanvas,
  type SharedCanvasesRefreshMessage,
  type WorkspaceSharedCanvasesEvent,
  WorkspaceSharedCanvasesEventSchema,
} from "@rally/contracts/canvas-share-federation";

import { workspaceDOName } from "../durable-objects/names";
import { isRetirementRefusal } from "../durable-objects/object-retirement";
import type { Env } from "../env";
import { durableObjectStubForWorkspace, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { SIDEBAR_LIST_LIMIT } from "./sidebar-reads";

/*
 * Building a person's shared-Canvas lists (`docs/canvas-share-federation.md`).
 * Runs in the Worker, never in an Organization's object: it asks each
 * Organization the person is a guest of for the Canvases shared with them
 * there, and hands each list it builds to the Organization that shows it,
 * which only relays it to the person's sockets. Nothing is stored but the
 * person's switch.
 */

/** Whether Canvases shared with this person join every Organization's list; no row is on. */
export async function readSharedCanvasesEnabled(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT enabled FROM shared_canvases_settings WHERE user_id = ?`)
    .bind(userId).first<{ enabled: number }>();
  return row?.enabled !== 0;
}

export async function writeSharedCanvasesEnabled(env: Env, userId: string, enabled: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO shared_canvases_settings (user_id, enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).bind(userId, enabled ? 1 : 0, new Date().toISOString()).run();
}

export interface PersonOrganization {
  id: string;
  name: string;
  guest: boolean;
}

/** Every Organization in this deployment the person is active in, as a member or a guest. */
export async function personOrganizations(env: Env, userId: string): Promise<PersonOrganization[]> {
  const rows = await env.DB.prepare(
    `SELECT w.id, w.name, m.access_class FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? AND m.status = 'active' AND w.region = ? AND w.abandoned_at IS NULL
      ORDER BY w.id`,
  ).bind(userId, env.AVALON_REGION).all<{ id: string; name: string; access_class: string }>();
  return rows.results.map((row) => ({ id: row.id, name: row.name, guest: row.access_class === "guest" }));
}

async function organizationObject(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)), await workspacePlacementAffinity(env, workspaceId));
}

/**
 * Rebuild this person's list in each target Organization where they have a
 * socket, and relay it there. The Canvases come from every Organization they
 * are a guest of, each asked once whatever the number of targets.
 *
 * An Organization that cannot answer is named in the frame's `unavailable`,
 * so the client keeps what it last showed from it while the rest of the list,
 * an unshare elsewhere included, still lands. The build then throws, so the
 * activity queue retries it until a complete list follows or it dead-letters.
 * A failed relay throws the same way. A retired Organization answers nothing.
 */
async function rebuild(env: Env, userId: string, organizations: readonly PersonOrganization[], targets: readonly string[]): Promise<void> {
  // Each target's ticket before anything is read, so a build that reads later
  // always relays after one that read earlier (`relayTicket`). A target with
  // no socket for the person answers `null` and is skipped.
  const tickets = await Promise.allSettled(targets.map(async (target) =>
    (await organizationObject(env, target)).relayTicket({ workspaceId: target, userId })));
  const live: { target: string; ticket: PromiseSettledResult<number> }[] = [];
  tickets.forEach((ticket, index) => {
    if (ticket.status === "rejected" ? isRetirementRefusal(ticket.reason) : ticket.value === null) return;
    live.push({ target: targets[index]!, ticket: ticket as PromiseSettledResult<number> });
  });
  if (live.length === 0) return;
  const builtAt = Date.now();
  const enabled = await readSharedCanvasesEnabled(env, userId);
  const origins = enabled ? organizations.filter((organization) => organization.guest) : [];
  const answered = await Promise.allSettled(origins.map(async (origin) =>
    GuestSharedCanvasSchema.array().parse(
      await (await organizationObject(env, origin.id)).guestSharedCanvases({ workspaceId: origin.id, userId }))));
  const shared = new Map<string, SharedCanvas[]>();
  const unavailable: WorkspaceId[] = [];
  answered.forEach((result, index) => {
    const origin = origins[index]!;
    if (result.status === "rejected") {
      if (isRetirementRefusal(result.reason)) return;
      unavailable.push(asWorkspaceId(origin.id));
      logWarn(env, "shared_canvases_origin_unread", {
        workspace_id: origin.id, user_id: userId, code: diagnosticErrorCode(result.reason, "shared_canvases_origin_unread"),
      });
      return;
    }
    shared.set(origin.id, result.value.map((canvas): SharedCanvas => ({
      organization: { id: asWorkspaceId(origin.id), name: origin.name, region: env.AVALON_REGION },
      canvas: {
        id: canvas.id, title: canvas.title, updatedAt: new Date(canvas.updatedAt).toISOString(),
        ...(canvas.appearance ? { appearance: canvas.appearance } : {}),
      },
    })));
  });
  const relayed = await Promise.allSettled(live.map(async ({ target, ticket }) => {
    if (ticket.status === "rejected") throw ticket.reason;
    const items = [...shared.entries()].filter(([origin]) => origin !== target).flatMap(([, canvases]) => canvases)
      .sort((a, b) => b.canvas.updatedAt.localeCompare(a.canvas.updatedAt)).slice(0, SIDEBAR_LIST_LIMIT);
    const frame = WorkspaceSharedCanvasesEventSchema.parse({
      type: "workspace_shared_canvases", occurredAt: new Date(builtAt).toISOString(), enabled, items,
      unavailable: unavailable.filter((origin) => origin !== target),
    } satisfies WorkspaceSharedCanvasesEvent);
    await (await organizationObject(env, target)).relayToPerson({
      workspaceId: target, userId, ticket: ticket.value, frame: JSON.stringify(frame),
    });
  }));
  let relayFailed = false;
  relayed.forEach((result, index) => {
    if (result.status === "rejected" && !isRetirementRefusal(result.reason)) {
      relayFailed = true;
      logWarn(env, "shared_canvases_relay_failed", {
        workspace_id: live[index]!.target, user_id: userId, code: diagnosticErrorCode(result.reason, "shared_canvases_relay_failed"),
      });
    }
  });
  if (unavailable.length > 0) throw new Error("shared_canvases_origin_unread");
  if (relayFailed) throw new Error("shared_canvases_relay_failed");
}

/**
 * One `shared_canvases_refresh`: after a subscribe (`this`), the list in that
 * Organization; after a change in an Organization (`others`), the lists in
 * every other one the person is in; after their switch changed (`all`), every
 * list. Throws when any part failed, for the queue to retry: every attempt
 * takes fresh tickets, so a retry never lands an older list.
 */
export async function refreshSharedCanvases(env: Env, message: SharedCanvasesRefreshMessage): Promise<void> {
  const organizations = await personOrganizations(env, message.userId);
  const targets = organizations.map((organization) => organization.id).filter((id) =>
    message.scope === "all" || (message.scope === "this" ? id === message.workspaceId : id !== message.workspaceId));
  if (targets.length === 0) return;
  await rebuild(env, message.userId, organizations, targets);
}

/** Save the person's switch, then queue a rebuild of every list they have, so the queue's retry covers it. */
export async function setSharedCanvasesEnabled(env: Env, workspaceId: string, userId: string, enabled: boolean): Promise<void> {
  await writeSharedCanvasesEnabled(env, userId, enabled);
  await env.ACTIVITY_QUEUE.send({
    kind: "shared_canvases_refresh", region: env.AVALON_REGION, workspaceId: asWorkspaceId(workspaceId), userId: asUserId(userId), scope: "all",
  } satisfies SharedCanvasesRefreshMessage);
}
