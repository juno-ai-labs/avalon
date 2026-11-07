/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Canvas's Chat on the one hosting primitive: a `canvas`-kind conversation
 * object whose parent is the Canvas's row in the Organization object. Opening
 * it is the conversation route's admission (`ConversationService`), the
 * socket ticket names the `canvas` kind, and the Chat's own effects reach the
 * Canvas's parent state. Real workerd throughout.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { createAccessContext } from "../src/services/authorization-service";
import { projectAuthorization } from "../src/services/authorization-projection-service";
import { createCanvas } from "../src/services/canvas-service";
import { createAutomation } from "../src/services/automation-service";
import { canvasArtifactNoter, resolveTerminalPublicationHome } from "../src/services/terminal/authority";
import { createTerminalPortFactory } from "../src/services/terminal/object-port";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { ConversationService } from "../src/services/conversation-service";
import { verifySocketTicket } from "../src/services/socket-service";
import { deliverChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000cb000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000cb001");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000cb002");
const ADMIN = asUserId("00000000-0000-7000-8000-0000000cb003");
const GUEST = asUserId("00000000-0000-7000-8000-0000000cb004");
const NOW = "2026-11-07T10:00:00.000Z";
const TEST_ENV: Env = env;
useHeldEffectQueue();

function auth(userId: string): AuthContext {
  return { sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global",
    role: userId === ADMIN ? "admin" : userId === GUEST ? null : "member" };
}

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

async function opens(userId: string, canvasId: string): Promise<boolean> {
  try {
    await new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(canvasId);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "conversation_not_found") return false;
    throw error;
  }
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: CREATOR, sessionId: `session-${CREATOR}` });
  await env.DB.batch([
    ...[[MEMBER, "member", "member"], [ADMIN, "admin", "member"], [GUEST, null, "guest"]].map(([userId, role, accessClass]) =>
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at)
        VALUES (?, ?, 'active', ?, ?, ?)`).bind(WORKSPACE_ID, userId, role, accessClass, NOW)),
    ...[MEMBER, ADMIN, GUEST].map((userId) => env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${userId}`, userId, WORKSPACE_ID)),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
  ]);
});

describe("a Canvas's Chat", () => {
  it("opens to its creator, a participant, a guest on its list and an administrator, and to nobody else", async () => {
    const { canvasId, created } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    expect(created).toBe(true);
    expect(await opens(CREATOR, canvasId)).toBe(true);
    expect(await opens(MEMBER, canvasId)).toBe(false);
    expect(await opens(GUEST, canvasId)).toBe(false);
    // An administrator manages every Canvas, so opens it.
    expect(await opens(ADMIN, canvasId)).toBe(true);
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER, GUEST] } });
    expect(await opens(MEMBER, canvasId)).toBe(true);
    expect(await opens(GUEST, canvasId)).toBe(true);
  });

  it("issues a socket ticket naming the canvas kind", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const issued = await new ConversationService(TEST_ENV, auth(CREATOR)).socketTicket(canvasId);
    const claims = await verifySocketTicket(TEST_ENV, issued.ticket);
    expect({ parentKind: claims.parentKind, parentId: claims.parentId, substreamId: claims.substreamId })
      .toEqual({ parentKind: "canvas", parentId: canvasId, substreamId: "0" });
  });

  it("takes its Chat's effects into the Canvas's own rows", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    await deliverChildEffects(TEST_ENV, chat);
    const rows = await runInDurableObject(workspace(), (_instance, state) => ({
      projections: state.storage.sql.exec<{ substream_id: string }>(
        `SELECT substream_id FROM sidekick_child_projections WHERE sidekick_id = ?`, canvasId).toArray(),
      reads: state.storage.sql.exec<{ user_id: string }>(
        `SELECT user_id FROM sidekick_viewer_reads WHERE sidekick_id = ?`, canvasId).toArray(),
    }));
    expect(rows).toEqual({ projections: [{ substream_id: "0" }], reads: [{ user_id: CREATOR }] });
  });

  it("admits a Canvas's artifact to whoever opens the Canvas, and to nobody else", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [GUEST] } });
    const resourceId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'generated_file', 'avalon_generated', 'Launch plan.md', '{}', 'attached', ?, ?)`, resourceId, WORKSPACE_ID, NOW, NOW);
    });
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    await runInDurableObject(chat, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO workstream_resource_links
        (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
        VALUES (?, NULL, 0, 'generated', '{}', 1, 1)`, resourceId);
    });
    await projectAuthorization(TEST_ENV, { type: "authorization_projection_v1", region: "global",
      workspaceId: WORKSPACE_ID, parentId: canvasId, substreamId: asSubstreamId("0") });
    const decide = async (userId: string) => (await createAccessContext(TEST_ENV, auth(userId))
      .check({ kind: "resource", workspaceId: WORKSPACE_ID, resourceId })).status;
    // The creator and a guest on the list; a member it was not shared with is refused.
    expect(await decide(CREATOR)).toBe("allowed");
    expect(await decide(GUEST)).toBe("allowed");
    expect(await decide(MEMBER)).toBe("denied");
  });
});

/** A workspace socket for this person, subscribed; every frame it receives is kept. */
async function connect(userId: string): Promise<{ socket: WebSocket; frames: Array<Record<string, unknown>> }> {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `session-${userId}`,
      "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const frames: Array<Record<string, unknown>> = [];
  const subscribed = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      if (String(event.data) === "pong") return;
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "workspace_sync") resolve();
    });
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await subscribed;
  return { socket, frames };
}

type Row = { id: string; unread: boolean; sharedWithMe: boolean; presentUserIds: string[]; pinnedPosition: number | null };

/** The Canvas rows a socket was last told: the newest list push, else its subscribe payload. */
function canvasRows(frames: Array<Record<string, unknown>>): Row[] {
  const pushes = frames.filter((frame) => frame.type === "workspace_canvas_list");
  if (pushes.length > 0) return pushes.at(-1)!.items as Row[];
  const sync = frames.find((frame) => frame.type === "workspace_sync") as { sidebar?: { canvases?: { items: Row[] } } };
  return sync.sidebar?.canvases?.items ?? [];
}

describe("the Canvas list", () => {
  it("lists a Canvas to whoever may open it, unread to a participant who has not opened it", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    const creator = await connect(CREATOR);
    const before = await connect(MEMBER);
    expect(canvasRows(creator.frames)).toMatchObject([{ id: canvasId, unread: false, sharedWithMe: false }]);
    expect(canvasRows(before.frames)).toEqual([]);
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER] } });
    // The change is pushed to every socket, each with its own rows.
    await expect.poll(() => canvasRows(before.frames)).toMatchObject([{ id: canvasId, unread: true, sharedWithMe: true }]);
    for (const { socket } of [creator, before]) socket.close(1000, "done");
  });

  it("shows who is in a Canvas now on its row, and pins it for one viewer", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER] } });
    const creator = await connect(CREATOR);
    const member = await connect(MEMBER);
    member.socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: canvasId }));
    await expect.poll(() => canvasRows(creator.frames)[0]?.presentUserIds).toEqual([MEMBER]);
    // The face pile in the Canvas itself, on the same presence path a Channel's uses.
    creator.socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: canvasId }));
    await expect.poll(() => creator.frames.filter((frame) => frame.type === "workspace_presence").at(-1))
      .toMatchObject({ workstreamId: canvasId, userIds: [MEMBER] });
    expect(await workspace().setSidebarPin({ workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member",
      kind: "canvas", itemId: canvasId, pinned: true })).toEqual({ ok: true });
    await expect.poll(() => canvasRows(member.frames)[0]?.pinnedPosition).toBe(0);
    expect(canvasRows(creator.frames)[0]?.pinnedPosition).toBeNull();
    for (const { socket } of [creator, member]) socket.close(1000, "done");
  });

  it("refuses to pin, and keeps out of presence, a Canvas the viewer may not open", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const creator = await connect(CREATOR);
    const outsider = await connect(MEMBER);
    outsider.socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: canvasId }));
    await new Promise<void>((resolve) => {
      outsider.socket.addEventListener("message", (event) => { if (String(event.data) === "pong") resolve(); });
      outsider.socket.send("ping");
    });
    expect(canvasRows(creator.frames)[0]?.presentUserIds).toEqual([]);
    expect(await workspace().setSidebarPin({ workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member",
      kind: "canvas", itemId: canvasId, pinned: true })).toEqual({ ok: false });
    for (const { socket } of [creator, outsider]) socket.close(1000, "done");
  });
});

describe("a Canvas's artifacts", () => {
  /** Publish a file from the Canvas's Chat through the Terminal's resource bridge, as Rally's publish_resource does. */
  async function publish(canvasId: string, filePath: string, text: string) {
    const bridge = createTerminalResourceBridge(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID),
      createTerminalPortFactory(TEST_ENV, undefined, "0"), undefined, null, null, null, "0",
      canvasArtifactNoter(TEST_ENV, { workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: canvasId, substreamId: asSubstreamId("0") }));
    return bridge.publishResource({ workspaceId: WORKSPACE_ID, workstreamId: canvasId, harnessRunId: crypto.randomUUID(),
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(), executionPrincipal: { type: "user", userId: CREATOR },
      signal: new AbortController().signal }, { filePath }, new TextEncoder().encode(text));
  }

  it("makes the first publish version 1 by Rally, a republish of the path a new version, and another path another artifact", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const detail = () => workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" } });
    const first = await publish(canvasId, "plan.md", "# Launch plan");
    expect(await detail()).toMatchObject({ lastEditor: { kind: "rally", id: null },
      artifacts: [{ resourceId: first.resourceId, kind: "file", version: 1 }] });
    const again = await publish(canvasId, "plan.md", "# Launch plan, revised");
    expect(again.resourceId).toBe(first.resourceId);
    expect((await detail()).artifacts).toMatchObject([{ resourceId: first.resourceId, version: 2 }]);
    const other = await publish(canvasId, "budget.csv", "line,amount");
    expect((await detail()).artifacts.map((artifact) => artifact.resourceId).sort())
      .toEqual([first.resourceId, other.resourceId].sort());
  });

  it("publishes a Sidekick run into a Canvas it makes, open to whoever the Sidekick is shared with", async () => {
    const sidekickId = crypto.randomUUID();
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId });
    await workspace().sidekickSetAudience({ workspaceId: WORKSPACE_ID, automationId: sidekickId,
      actor: { userId: CREATOR, actorRole: "member", participantOfOwningWorkstream: false },
      update: { audience: "people", userIds: [MEMBER] } });
    const runId = crypto.randomUUID();
    const run = { workspaceId: WORKSPACE_ID, parentKind: "automation" as const, parentId: sidekickId,
      substreamId: asSubstreamId(runId), executionPrincipal: { type: "user" as const, userId: CREATOR } };
    const home = await resolveTerminalPublicationHome(TEST_ENV, run, { title: "Weekly report" });
    // The run's later publishes land in the same Canvas.
    expect(await resolveTerminalPublicationHome(TEST_ENV, run)).toEqual(home);
    const canvasId = home!.parentId;
    const read = (userId: string, actorRole: "member" | "admin" = "member") => runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
      try {
        return await instance.canvasDetail({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: asUserId(userId), actorRole } });
      } catch (error) {
        if ((error as { code?: string }).code === "canvas_not_found") return null;
        throw error;
      }
    });
    expect(await read(MEMBER)).toMatchObject({ title: "Weekly report", writerSidekickId: sidekickId, visibility: "creator",
      participantUserIds: [] });
    expect(await read(ADMIN, "admin")).not.toBeNull();
    // Read live: the Sidekick shared with nobody else no longer opens its Canvas to them.
    await workspace().sidekickSetAudience({ workspaceId: WORKSPACE_ID, automationId: sidekickId,
      actor: { userId: CREATOR, actorRole: "member", participantOfOwningWorkstream: false },
      update: { audience: "personal", userIds: [] } });
    expect(await read(MEMBER)).toBeNull();
    // "The Canvases it writes to" is on the Sidekick's detail.
    const sidekick = await runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickReadDetail({
      workspaceId: WORKSPACE_ID, automationId: sidekickId,
      actor: { userId: CREATOR, actorRole: "member", participantOfOwningWorkstream: false } }));
    expect(sidekick.canvases).toMatchObject([{ id: canvasId }]);
    // A Canvas another Sidekick never wrote cannot be named.
    const { canvasId: elsewhere } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await expect(resolveTerminalPublicationHome(TEST_ENV, run, { canvas: elsewhere }))
      .rejects.toMatchObject({ code: "canvas_not_written_by_sidekick" });
  });
});

