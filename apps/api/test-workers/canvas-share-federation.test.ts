/**
 * Canvas share federation on the real Organization objects
 * (`docs/canvas-share-federation.md`): the Canvas's own Organization queues one
 * outbox entry per person it is shared with, its alarm sends an address-only
 * activity-queue message, the consumer reads that person's state back and
 * writes their inbox, and their other Organization pushes it to their socket.
 * The D1 tables are the checked-in inbox migration; the inbox's own queries
 * are proved against every migration in `test/canvas-share-inbox.test.ts`.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";
import { CanvasShareChangedMessageSchema, type CanvasShareChangedMessage } from "@rally/contracts/canvas-share-federation";

import inboxMigration from "../../../packages/db/migrations/0135_canvas_share_inbox.sql?raw";
import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { consumeCanvasShareChanged } from "../src/queues/canvas-share-consumer";
import { readSharedCanvases } from "../src/services/canvas-share-inbox";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let ORIGIN = asWorkspaceId(crypto.randomUUID());
let HOME = asWorkspaceId(crypto.randomUUID());
const CREATOR = asUserId("00000000-0000-7000-8000-0000000cc001");
const READER = asUserId("00000000-0000-7000-8000-0000000cc002");
let CANVAS = crypto.randomUUID();
const NOW = "2026-11-16T10:00:00.000Z";
const member = (userId: string) => ({ userId: asUserId(userId), actorRole: "member" as const });
const object = (workspaceId: string): DurableObjectStub<WorkspaceDO> =>
  env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId))));

/**
 * Every federation message the origin has sent since the last call. The spy is
 * installed before any write: the platform fires a due alarm on its own, and a
 * message it sent must not be lost to a race with the manual run below.
 */
let sent: { mock: { calls: unknown[][] }; mockClear: () => void };
async function drainOutbox(): Promise<CanvasShareChangedMessage[]> {
  // The platform runs a due alarm by itself, so a manual run may find it
  // already in flight: wait for the outbox to empty rather than race it.
  await runDurableObjectAlarm(object(ORIGIN));
  await vi.waitFor(async () => expect(await runInDurableObject(object(ORIGIN), (_instance: WorkspaceDO, state) => state.storage.sql
    .exec<{ n: number }>("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind = 'canvas_share_federation'").one().n)).toBe(0));
  const messages = sent.mock.calls.flatMap(([body]) => {
    const parsed = CanvasShareChangedMessageSchema.safeParse(body);
    return parsed.success ? [parsed.data] : [];
  });
  sent.mockClear();
  return messages;
}

async function deliver(): Promise<CanvasShareChangedMessage[]> {
  const messages = await drainOutbox();
  for (const message of messages) await consumeCanvasShareChanged(env, message);
  return messages;
}

const sharedTitles = async () => (await readSharedCanvases(env, READER, HOME)).items.map((item) => item.canvas.title);

/** A subscribed socket for the reader in their home Organization, keeping each shared-Canvas push. */
async function connectHome(): Promise<{ pushes: Array<{ items: Array<{ canvas: { title: string } }> }>; close: () => void }> {
  const response = await object(HOME).fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket", "x-rally-workspace-id": HOME, "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": READER, "x-rally-session-id": `session-${READER}`, "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const pushes: Array<{ items: Array<{ canvas: { title: string } }> }> = [];
  await new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (String(event.data) === "pong") return;
      const frame = JSON.parse(String(event.data)) as { type?: string; items: Array<{ canvas: { title: string } }> };
      if (frame.type === "workspace_sync") resolve();
      if (frame.type === "workspace_shared_canvases") pushes.push(frame);
    });
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  });
  return { pushes, close: () => socket.close(1000, "done") };
}

beforeEach(async () => {
  await reset();
  vi.restoreAllMocks();
  sent = vi.spyOn(env.ACTIVITY_QUEUE, "send");
  ORIGIN = asWorkspaceId(crypto.randomUUID());
  HOME = asWorkspaceId(crypto.randomUUID());
  CANVAS = crypto.randomUUID();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: ORIGIN, userId: CREATOR, sessionId: `session-${CREATOR}` });
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT NOT NULL DEFAULT 'Organization'`),
    env.DB.prepare(`UPDATE workspaces SET name = 'Acme' WHERE id = ?`).bind(ORIGIN),
    env.DB.prepare(`INSERT INTO workspaces(id, region, name) VALUES (?, 'global', 'Home')`).bind(HOME),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at) VALUES (?, 'reader@example.com', 'Reader', NULL, 'UTC', ?)`)
      .bind(READER, NOW),
    // A guest of the Canvas's Organization, a member of their own.
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at) VALUES (?, ?, 'active', NULL, 'guest', ?)`)
      .bind(ORIGIN, READER, NOW),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at) VALUES (?, ?, 'active', 'member', 'member', ?)`)
      .bind(HOME, READER, NOW),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${READER}`, READER, HOME),
    ...splitSqlStatements(inboxMigration).map((sql) => env.DB.prepare(sql)),
  ]);
  await object(HOME).initializeWorkspace(HOME, "wnam");
  await object(ORIGIN).saveCanvasSharingDefaults({ workspaceId: ORIGIN, defaults: { editors: "creator" } });
  await object(ORIGIN).canvasCreate({ workspaceId: ORIGIN, canvasId: CANVAS, title: "Launch plan", createdByUserId: CREATOR, authorityGeneration: 1 });
});

describe("Canvas share federation", () => {
  it("publishes a share, a rename and an unshare to the person's inbox and their other Organization's socket", async () => {
    // Made but shared with nobody: nothing to publish.
    expect(await drainOutbox()).toEqual([]);
    const home = await connectHome();
    await object(ORIGIN).canvasSetAudience({ workspaceId: ORIGIN, canvasId: CANVAS, actor: member(CREATOR),
      update: { visibility: "participants", userIds: [READER] } });
    expect(await deliver()).toEqual([{ kind: "canvas_share_changed", region: "global", workspaceId: ORIGIN, canvasId: CANVAS, userId: READER }]);
    expect(await sharedTitles()).toEqual(["Launch plan"]);
    await vi.waitFor(() => expect(home.pushes.at(-1)?.items.map((item) => item.canvas.title)).toEqual(["Launch plan"]));

    await object(ORIGIN).canvasUpdate({ workspaceId: ORIGIN, canvasId: CANVAS, actor: member(CREATOR), title: "Partner launch" });
    await deliver();
    expect(await sharedTitles()).toEqual(["Partner launch"]);

    await object(ORIGIN).canvasSetAudience({ workspaceId: ORIGIN, canvasId: CANVAS, actor: member(CREATOR),
      update: { visibility: "creator", userIds: [] } });
    await deliver();
    expect(await sharedTitles()).toEqual([]);
    await vi.waitFor(() => expect(home.pushes.at(-1)?.items).toEqual([]));
    home.close();
  });

  it("answers a person the Canvas is not shared with as unshared, and its creator too", async () => {
    await object(ORIGIN).canvasSetAudience({ workspaceId: ORIGIN, canvasId: CANVAS, actor: member(CREATOR),
      update: { visibility: "participants", userIds: [READER] } });
    expect(await object(ORIGIN).canvasShareState({ workspaceId: ORIGIN, canvasId: CANVAS, userId: READER }))
      .toMatchObject({ state: "shared", title: "Launch plan" });
    expect(await object(ORIGIN).canvasShareState({ workspaceId: ORIGIN, canvasId: CANVAS, userId: CREATOR }))
      .toMatchObject({ state: "unshared" });
    expect(await object(ORIGIN).canvasShareState({ workspaceId: ORIGIN, canvasId: crypto.randomUUID(), userId: READER }))
      .toEqual({ state: "gone" });
  });

  it("queues every share made before the migration once, as the object upgrades", async () => {
    await object(ORIGIN).canvasSetAudience({ workspaceId: ORIGIN, canvasId: CANVAS, actor: member(CREATOR),
      update: { visibility: "participants", userIds: [READER] } });
    await drainOutbox();
    // Replay the migration's own backfill statement against the drained object.
    const { CANVAS_SHARE_FEDERATION_STATEMENTS } = await import("../src/durable-objects/canvas-share-federation");
    await runInDurableObject(object(ORIGIN), async (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(CANVAS_SHARE_FEDERATION_STATEMENTS.at(-1)!);
      // As initialization does once its migrations commit (`armNextAlarm`).
      await state.storage.setAlarm(Date.now());
    });
    expect((await drainOutbox()).map((message) => message.userId)).toEqual([READER]);
  });
});
