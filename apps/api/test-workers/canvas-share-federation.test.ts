/**
 * Canvas share federation on the real Organization objects
 * (`docs/canvas-share-federation.md`): a Canvas explicitly shared with a guest
 * of its Organization shows in the guest's other Organization, built by the
 * Worker from the Canvas's own Organization and relayed to their socket there;
 * a change to it, or to the guest, invalidates through the interactive queue.
 * Nothing about the Canvas is stored outside its Organization.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";
import { SharedCanvasesRefreshMessageSchema, type SharedCanvasesRefreshMessage } from "@rally/contracts/canvas-share-federation";

import settingsMigration from "../../../packages/db/migrations/0135_shared_canvases_settings.sql?raw";
import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { refreshSharedCanvases } from "../src/services/shared-canvases";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let ORIGIN = asWorkspaceId(crypto.randomUUID());
let HOME = asWorkspaceId(crypto.randomUUID());
const CREATOR = asUserId("00000000-0000-7000-8000-0000000cc001");
/** A guest of the origin, a member of their own Organization. */
const GUEST = asUserId("00000000-0000-7000-8000-0000000cc002");
/** A member of both. */
const MEMBER = asUserId("00000000-0000-7000-8000-0000000cc003");
let CANVAS = crypto.randomUUID();
const NOW = "2026-11-16T10:00:00.000Z";
const owner = { userId: CREATOR, actorRole: "member" as const };
const object = (workspaceId: string): DurableObjectStub<WorkspaceDO> =>
  env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId))));

/** Every refresh either object queued, spied before any write: a due alarm runs by itself. */
let queued: { mock: { calls: unknown[][] }; mockClear: () => void };

/**
 * Run what the interactive queue would: every refresh queued so far, and any
 * those queue in turn, until none is left. Answering for a guest the first
 * time caches their relationship, which queues one more refresh of its own.
 */
async function drain(): Promise<SharedCanvasesRefreshMessage[]> {
  const ran: SharedCanvasesRefreshMessage[] = [];
  for (;;) {
    await runDurableObjectAlarm(object(ORIGIN));
    await vi.waitFor(async () => expect(await runInDurableObject(object(ORIGIN), (_instance: WorkspaceDO, state) => state.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind = 'canvas_share_federation'").one().n)).toBe(0));
    const messages = queued.mock.calls.flatMap(([body]) => {
      const parsed = SharedCanvasesRefreshMessageSchema.safeParse(body);
      return parsed.success ? [parsed.data] : [];
    });
    queued.mockClear();
    if (messages.length === 0) return ran;
    for (const message of messages) await refreshSharedCanvases(env, message);
    ran.push(...messages);
  }
}

/** Who a drain refreshed, and how, once each. */
const refreshed = (messages: SharedCanvasesRefreshMessage[]) =>
  [...new Set(messages.map((message) => `${message.scope}:${message.workspaceId === HOME ? "home" : "origin"}:${message.userId}`))].sort();

type Frame = { enabled: boolean; items: Array<{ organization: { name: string }; canvas: { title: string } }> };

/** A subscribed socket in the home Organization, keeping each shared-Canvas frame. */
async function connect(userId: string, impersonatorId?: string): Promise<{ frames: Frame[]; close: () => void }> {
  const response = await object(HOME).fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket", "x-rally-workspace-id": HOME, "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId, "x-rally-session-id": `session-${userId}`, "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      ...(impersonatorId ? { "x-rally-socket-impersonator-id": impersonatorId } : {}),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const frames: Frame[] = [];
  await new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (String(event.data) === "pong") return;
      const frame = JSON.parse(String(event.data)) as { type?: string } & Frame;
      if (frame.type === "workspace_sync") resolve();
      if (frame.type === "workspace_shared_canvases") frames.push(frame);
    });
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  });
  return { frames, close: () => socket.close(1000, "done") };
}

const titles = (frames: Frame[]) => frames.at(-1)?.items.map((item) => `${item.organization.name}: ${item.canvas.title}`);

beforeEach(async () => {
  await reset();
  vi.restoreAllMocks();
  queued = vi.spyOn(env.INTERACTIVE_QUEUE, "send");
  ORIGIN = asWorkspaceId(crypto.randomUUID());
  HOME = asWorkspaceId(crypto.randomUUID());
  CANVAS = crypto.randomUUID();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: ORIGIN, userId: CREATOR, sessionId: `session-${CREATOR}` });
  const membership = (workspaceId: string, userId: string, accessClass: "member" | "guest") =>
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at) VALUES (?, ?, 'active', ?, ?, ?)`)
      .bind(workspaceId, userId, accessClass === "guest" ? null : "member", accessClass, NOW);
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT NOT NULL DEFAULT 'Organization'`),
    env.DB.prepare(`UPDATE workspaces SET name = 'Acme' WHERE id = ?`).bind(ORIGIN),
    env.DB.prepare(`INSERT INTO workspaces(id, region, name) VALUES (?, 'global', 'Home')`).bind(HOME),
    ...[GUEST, MEMBER].map((userId) => env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at) VALUES (?, ?, 'Person', NULL, 'UTC', ?)`)
      .bind(userId, `${userId}@example.com`, NOW)),
    membership(ORIGIN, GUEST, "guest"), membership(HOME, GUEST, "member"),
    membership(ORIGIN, MEMBER, "member"), membership(HOME, MEMBER, "member"),
    ...[GUEST, MEMBER].map((userId) => env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, HOME)),
    ...splitSqlStatements(settingsMigration).map((sql) => env.DB.prepare(sql)),
  ]);
  await object(HOME).initializeWorkspace(HOME, "wnam");
  await object(ORIGIN).saveCanvasSharingDefaults({ workspaceId: ORIGIN, defaults: { editors: "creator" } });
  await object(ORIGIN).canvasCreate({ workspaceId: ORIGIN, canvasId: CANVAS, title: "Launch plan", createdByUserId: CREATOR, authorityGeneration: 1 });
  await object(ORIGIN).canvasSetAudience({ workspaceId: ORIGIN, canvasId: CANVAS, actor: owner,
    update: { visibility: "participants", userIds: [GUEST, MEMBER] } });
  await drain();
});

describe("Canvas share federation", () => {
  it("shows a guest's Canvas in their own Organization, and follows its rename and unshare", async () => {
    const home = await connect(GUEST);
    // The subscribe asked for this Organization's list, and nobody else was touched.
    const opened = refreshed(await drain());
    expect(opened).toContain(`this:home:${GUEST}`);
    expect(opened.every((entry) => entry.endsWith(GUEST))).toBe(true);
    expect(titles(home.frames)).toEqual(["Acme: Launch plan"]);

    await object(ORIGIN).canvasUpdate({ workspaceId: ORIGIN, canvasId: CANVAS, actor: owner, title: "Partner launch" });
    // A rename refreshes the guest's other Organizations; a member on the list is not touched.
    expect(refreshed(await drain())).toEqual([`others:origin:${GUEST}`]);
    expect(titles(home.frames)).toEqual(["Acme: Partner launch"]);

    await object(ORIGIN).canvasSetAudience({ workspaceId: ORIGIN, canvasId: CANVAS, actor: owner,
      update: { visibility: "participants", userIds: [MEMBER] } });
    await drain();
    expect(titles(home.frames)).toEqual([]);
    home.close();
  });

  it("does not federate a Canvas to a member of its Organization, even one explicitly added", async () => {
    expect(await object(ORIGIN).guestSharedCanvases({ workspaceId: ORIGIN, userId: MEMBER })).toEqual([]);
    const home = await connect(MEMBER);
    await drain();
    expect(titles(home.frames)).toEqual([]);
    home.close();
  });

  it("takes it away when the guest becomes a member of the Canvas's Organization", async () => {
    const home = await connect(GUEST);
    await drain();
    expect(titles(home.frames)).toEqual(["Acme: Launch plan"]);
    await runInDurableObject(object(ORIGIN), (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO workspace_member_status (user_id, relationship_json, removed_incarnation, active, sequence, updated_at)
         VALUES (?, ?, NULL, 1, 1, ?) ON CONFLICT (user_id) DO UPDATE SET relationship_json = excluded.relationship_json, sequence = 1`,
        GUEST, JSON.stringify({ workspaceId: ORIGIN, userId: GUEST, accessClass: "member", role: "member", status: "active", incarnation: "promoted", revision: 2 }), Date.now(),
      );
      // As the relationship delivery does after writing.
      void state.storage.setAlarm(Date.now());
    });
    expect(refreshed(await drain())).toEqual([`others:origin:${GUEST}`]);
    expect(titles(home.frames)).toEqual([]);
    home.close();
  });

  it("sends a support session nothing from the person's other Organizations", async () => {
    const supported = await connect(GUEST, "00000000-0000-7000-8000-0000000cc0ff");
    expect(await drain()).toEqual([]);
    // Even a rebuild for the person does not reach it.
    await refreshSharedCanvases(env, { kind: "shared_canvases_refresh", region: "global", workspaceId: HOME, userId: GUEST, scope: "this" });
    expect(supported.frames).toEqual([]);
    supported.close();
  });

  it("drops a frame built before the last one relayed, so a slow build cannot land last", async () => {
    const home = await connect(GUEST);
    await drain();
    const frame = (title: string) => JSON.stringify({ type: "workspace_shared_canvases", occurredAt: NOW, enabled: true,
      items: [{ organization: { id: ORIGIN, name: "Acme", region: "global" }, canvas: { id: CANVAS, title, updatedAt: NOW } }] });
    const relay = (builtAt: number, title: string) => object(HOME).relayToPerson({
      workspaceId: HOME, userId: GUEST, channel: "shared_canvases", builtAt, frame: frame(title), supportSessions: false });
    const now = Date.now() + 60_000;
    expect(await relay(now + 2, "Newer")).toBe(1);
    expect(await relay(now + 1, "Older")).toBe(0);
    await vi.waitFor(() => expect(titles(home.frames)).toEqual(["Acme: Newer"]));
    home.close();
  });
});
