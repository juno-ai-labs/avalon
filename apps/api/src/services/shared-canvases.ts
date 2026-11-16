import { asWorkspaceId } from "@rally/contracts";
import {
  GuestSharedCanvasSchema,
  SharedCanvasSchema,
  WorkspaceSharedCanvasesEventSchema,
  type SharedCanvas,
  type SharedCanvasesRefreshMessage,
} from "@rally/contracts/canvas-share-federation";
import { z } from "zod";

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

const RELAY_CHANNEL = "shared_canvases";

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
  region: string;
  guest: boolean;
}

/** Every Organization in this deployment the person is active in, as a member or a guest. */
export async function personOrganizations(env: Env, userId: string): Promise<PersonOrganization[]> {
  const rows = await env.DB.prepare(
    `SELECT w.id, w.name, w.region, m.access_class FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? AND m.status = 'active' AND w.region = ? AND w.abandoned_at IS NULL
      ORDER BY w.id`,
  ).bind(userId, env.AVALON_REGION).all<{ id: string; name: string; region: string; access_class: string }>();
  return rows.results.map((row) => ({ id: row.id, name: row.name, region: row.region, guest: row.access_class === "guest" }));
}

function organizationObject(env: Env, workspaceId: string) {
  return (async () => durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)), await workspacePlacementAffinity(env, workspaceId)))();
}

/**
 * Rebuild this person's list in each target Organization and relay it there.
 * The Canvases come from every Organization they are a guest of, each asked
 * once whatever the number of targets. An Organization that cannot answer is
 * left out and named in the log; a retired one answers nothing.
 */
async function rebuild(env: Env, userId: string, organizations: readonly PersonOrganization[], targets: readonly string[]): Promise<void> {
  if (targets.length === 0) return;
  // Each target's ticket before anything is read, so a build that reads later
  // always relays after one that read earlier (`relayTicket`).
  const tickets = await Promise.allSettled(targets.map(async (target) =>
    (await organizationObject(env, target)).relayTicket({ workspaceId: target, userId, channel: RELAY_CHANNEL })));
  const builtAt = Date.now();
  const enabled = await readSharedCanvasesEnabled(env, userId);
  const origins = enabled ? organizations.filter((organization) => organization.guest) : [];
  const answered = await Promise.allSettled(origins.map(async (origin) =>
    z.array(GuestSharedCanvasSchema).parse(await (await organizationObject(env, origin.id)).guestSharedCanvases({ workspaceId: origin.id, userId }))));
  const shared = new Map<string, SharedCanvas[]>();
  answered.forEach((result, index) => {
    const origin = origins[index]!;
    if (result.status === "rejected") {
      if (!isRetirementRefusal(result.reason)) {
        logWarn(env, "shared_canvases_origin_unread", {
          workspace_id: origin.id, user_id: userId, code: diagnosticErrorCode(result.reason, "shared_canvases_origin_unread"),
        });
      }
      return;
    }
    shared.set(origin.id, result.value.map((canvas) => SharedCanvasSchema.parse({
      organization: { id: origin.id, name: origin.name, region: origin.region },
      canvas: {
        id: canvas.id, title: canvas.title, updatedAt: new Date(canvas.updatedAt).toISOString(),
        ...(canvas.appearance ? { appearance: canvas.appearance } : {}),
      },
    })));
  });
  const relayed = await Promise.allSettled(targets.map(async (target, index) => {
    const ticket = tickets[index]!;
    if (ticket.status === "rejected") throw ticket.reason;
    const items = [...shared.entries()].filter(([origin]) => origin !== target).flatMap(([, canvases]) => canvases)
      .sort((a, b) => b.canvas.updatedAt.localeCompare(a.canvas.updatedAt)).slice(0, SIDEBAR_LIST_LIMIT);
    const frame = JSON.stringify(WorkspaceSharedCanvasesEventSchema.parse({
      type: "workspace_shared_canvases", occurredAt: new Date(builtAt).toISOString(), enabled, items,
    }));
    await (await organizationObject(env, target)).relayToPerson({
      workspaceId: target, userId, channel: RELAY_CHANNEL, ticket: ticket.value, frame, supportSessions: false,
    });
  }));
  relayed.forEach((result, index) => {
    if (result.status === "rejected" && !isRetirementRefusal(result.reason)) {
      logWarn(env, "shared_canvases_relay_failed", {
        workspace_id: targets[index], user_id: userId, code: diagnosticErrorCode(result.reason, "shared_canvases_relay_failed"),
      });
    }
  });
}

/**
 * One `shared_canvases_refresh`: after a subscribe, the list in that
 * Organization; after a change in an Organization, the lists in every other
 * one the person is in. A failed origin or relay is logged and skipped rather
 * than retried: the next change or subscribe rebuilds from the Canvases
 * themselves, and nothing here can drift.
 */
export async function refreshSharedCanvases(env: Env, message: SharedCanvasesRefreshMessage): Promise<void> {
  const organizations = await personOrganizations(env, message.userId);
  const targets = message.scope === "this"
    ? organizations.filter((organization) => organization.id === message.workspaceId).map((organization) => organization.id)
    : organizations.filter((organization) => organization.id !== message.workspaceId).map((organization) => organization.id);
  await rebuild(env, message.userId, organizations, targets);
}

/** After the person's switch changed: every Organization they are in rebuilds. */
export async function refreshSharedCanvasesEverywhere(env: Env, userId: string): Promise<void> {
  const organizations = await personOrganizations(env, userId);
  await rebuild(env, userId, organizations, organizations.map((organization) => organization.id));
}
