/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Canvas's Chat on the one hosting primitive: a `canvas`-kind conversation
 * object whose parent is the Canvas's row in the Organization object. Opening
 * it is the conversation route's admission (`ConversationService`), the
 * socket ticket names the `canvas` kind, and the Chat's own effects reach the
 * Canvas's parent state. Real workerd throughout.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { uuidToBase58 } from "@rally/contracts/uuid-base58";

import { canvasSidebarRows } from "../src/durable-objects/hosted-canvas";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { createAccessContext } from "../src/services/authorization-service";
import { projectAuthorization } from "../src/services/authorization-projection-service";
import { CanvasService, createCanvas } from "../src/services/canvas-service";
import { conversationCanonicalUrl } from "../src/services/conversation-link-service";
import { createAutomation } from "../src/services/automation-service";
import { canvasArtifactNoter, resolveTerminalPublicationHome } from "../src/services/terminal/authority";
import { createTerminalPortFactory } from "../src/services/terminal/object-port";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { ConversationService } from "../src/services/conversation-service";
import { verifySocketTicket } from "../src/services/socket-service";
import { deliverChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { memberInputs, useOpenRouterDouble } from "./helpers/openrouter-double";
import { responsesEvents } from "@rally/agent-harness/test-support/responses-stream";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000cb000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000cb001");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000cb002");
const ADMIN = asUserId("00000000-0000-7000-8000-0000000cb003");
const GUEST = asUserId("00000000-0000-7000-8000-0000000cb004");
const NOW = "2026-11-07T10:00:00.000Z";
const TEST_ENV: Env = env;
useHeldEffectQueue();
/** The naming pass's own structured call, told from a Chat turn by its schema. */
function namingCall(call: { stream: boolean; body: Record<string, unknown> }): boolean {
  return !call.stream && JSON.stringify(call.body.response_format ?? {}).includes("canvas_title");
}
/**
 * The naming role's model, for the naming cases alone: `wrangler.test.jsonc`
 * leaves it unset, so every other case here makes no naming call.
 */
async function withNamingModel<T>(run: () => Promise<T>): Promise<T> {
  const mutable = env as { OPENROUTER_CLASSIFIER_MODEL?: string };
  mutable.OPENROUTER_CLASSIFIER_MODEL = "double/naming";
  try {
    return await run();
  } finally {
    delete mutable.OPENROUTER_CLASSIFIER_MODEL;
  }
}
/**
 * A reply streamed in two parts, the second held until the test releases it:
 * the stand-in for a long reply a person stops halfway through.
 */
const LONG_REPLY_PROMPT = "Tell me a long story.";
/**
 * Plain flags rather than promises: the reply's stream is read inside the
 * conversation object, and a promise settled across the test and the object
 * would carry one side's I/O context into the other.
 */
const held = { firstPartSent: false, released: false };
function heldReply(signal: AbortSignal | undefined): Response {
  const events = responsesEvents([
    { choices: [{ delta: { content: "Once upon a time" }, finish_reason: null }] },
    { choices: [{ delta: { content: ", and then THE END." }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ]);
  // The held part, then one chunk per event, each arriving on its own read
  // as a provider's do.
  const split = events.findIndex((event) => JSON.stringify(event).includes("THE END"));
  const encoder = new TextEncoder();
  const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
  const parts = [events.slice(0, split).map(frame).join(""), ...events.slice(split).map(frame), "data: [DONE]\n\n"];
  let sent = 0;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // As `fetch` ends a real body when its request is aborted.
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
    async pull(controller) {
      if (signal?.aborted) return;
      if (sent === 1) while (!held.released) await new Promise((resolve) => setTimeout(resolve, 10));
      // After the chunk read past the Stop, the rest waits for the request to
      // be aborted, so a fixed loop is not raced; one that never aborts gets
      // the rest of its reply after a while and completes it.
      else if (sent > 1) for (let waited = 0; !signal?.aborted && waited < 2_000; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (sent >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(parts[sent]!));
      if (sent === 0) held.firstPartSent = true;
      sent += 1;
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
const provider = useOpenRouterDouble((call) => namingCall(call)
  ? { say: JSON.stringify({ title: "December pricing launch" }) }
  : call.stream && JSON.stringify(memberInputs(call)).includes(LONG_REPLY_PROMPT) ? { raw: heldReply(call.signal) }
    : { say: "Here is the plan." });
useSelectedModel();

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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
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

  it("refuses an Organization-wide Chat to a suspended member and to somebody with no membership", async () => {
    const SUSPENDED = asUserId("00000000-0000-7000-8000-0000000cb005");
    const STRANGER = asUserId("00000000-0000-7000-8000-0000000cb006");
    await env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at)
      VALUES (?, ?, 'suspended', 'member', 'member', ?)`).bind(WORKSPACE_ID, SUSPENDED, NOW).run();
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "workspace", userIds: [] } });
    expect(await opens(MEMBER, canvasId)).toBe(true);
    // Each still holds a session that names them a member; only the
    // relationship the Organization object reads says they are not one.
    for (const userId of [SUSPENDED, STRANGER]) {
      await expect(new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(canvasId))
        .rejects.toMatchObject({ code: "conversation_not_found" });
    }
  });

  it("makes one Canvas and sends its prompt once for a create retried with the same id", async () => {
    const canvasId = asWorkstreamId(crypto.randomUUID());
    const request = { canvasId, title: "Launch plan", prompt: { text: "Draft the launch plan.", clientMessageId: "canvas-create-1" } };
    const first = await new CanvasService(TEST_ENV, auth(CREATOR)).create(request);
    const retried = await new CanvasService(TEST_ENV, auth(CREATOR)).create(request);
    expect(retried).toEqual(first);
    expect(first.canvasId).toBe(canvasId);
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM canvas_directory WHERE created_by_user_id = ?`, CREATOR).one().n)).toBe(1);
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    expect(await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM canonical_conversation_turn_details WHERE client_message_id = ?`, "canvas-create-1").one().n)).toBe(1);
    // Somebody else naming the id, or an id another conversation holds, is refused.
    await expect(new CanvasService(TEST_ENV, auth(MEMBER)).create({ canvasId }))
      .rejects.toMatchObject({ code: "canvas_id_unavailable" });
    const threadId = asWorkstreamId(crypto.randomUUID());
    await env.DB.prepare(`INSERT INTO workstreams (id, workspace_id) VALUES (?, ?)`).bind(threadId, WORKSPACE_ID).run();
    await expect(new CanvasService(TEST_ENV, auth(CREATOR)).create({ canvasId: threadId }))
      .rejects.toMatchObject({ code: "canvas_id_unavailable" });
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

type Row = { id: string; title: string; unread: boolean; sharedWithMe: boolean; presentUserIds: string[]; pinnedPosition: number | null };

/** The Canvas rows a socket was last told: the newest list push, else its subscribe payload. */
function canvasRows(frames: Array<Record<string, unknown>>): Row[] {
  const pushes = frames.filter((frame) => frame.type === "workspace_canvas_list");
  if (pushes.length > 0) return pushes.at(-1)!.items as Row[];
  const sync = frames.find((frame) => frame.type === "workspace_sync") as { sidebar?: { canvases?: { items: Row[] } } };
  return sync.sidebar?.canvases?.items ?? [];
}

/**
 * The Canvas rows a client holds: the subscribe payload, then each push whose
 * waterline is newer than the last one applied, as the desktop's sidebar list
 * store applies them.
 */
function clientCanvasRows(frames: Array<Record<string, unknown>>): Row[] {
  const sync = frames.find((frame) => frame.type === "workspace_sync") as
    { sidebar?: { canvases?: { waterline: number; items: Row[] } } };
  let applied = { waterline: sync.sidebar?.canvases?.waterline ?? -1, items: sync.sidebar?.canvases?.items ?? [] };
  for (const frame of frames) {
    if (frame.type !== "workspace_canvas_list") continue;
    const push = frame as { waterline: number; items: Row[] };
    if (push.waterline > applied.waterline) applied = push;
  }
  return applied.items;
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
    // Applied by waterline, as the client applies it: a push that does not
    // advance it never reaches the row.
    await expect.poll(() => clientCanvasRows(creator.frames)[0]?.presentUserIds).toEqual([MEMBER]);
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

describe("a Canvas's title and pin order", () => {
  it("retitles a Canvas for anyone it admits, on every open list, and tells anyone else it does not exist", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    await expect(new CanvasService(TEST_ENV, auth(MEMBER)).rename(canvasId, "Taken over"))
      .rejects.toMatchObject({ code: "canvas_not_found" });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER] } });
    const creator = await connect(CREATOR);
    const renamed = await new CanvasService(TEST_ENV, auth(MEMBER)).rename(canvasId, "  Launch plan, v2 ");
    expect(renamed.title).toBe("Launch plan, v2");
    expect((await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId)).title).toBe("Launch plan, v2");
    await expect.poll(() => clientCanvasRows(creator.frames).find((row) => row.id === canvasId)?.title).toBe("Launch plan, v2");
    creator.socket.close(1000, "done");
  });

  it("ends a reply being streamed at its next chunk when a person stops it, as a stopped response", async () => {
    held.firstPartSent = false;
    held.released = false;
    const { canvasId } = await new CanvasService(TEST_ENV, auth(CREATOR)).create({
      title: "Story", prompt: { text: LONG_REPLY_PROMPT, clientMessageId: "canvas-stop-1" },
    });
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    await expect.poll(() => held.firstPartSent, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ status: string }>(
      `SELECT status FROM substream_loops WHERE id = 1`).one().status)).toBe("executing");
    await runInDurableObject(chat, (instance) => (instance as unknown as {
      product: { stop: (auth: AuthContext, operationId: string) => Promise<void> };
    }).product.stop(auth(CREATOR), "00000000-0000-7000-8000-0000000cb5f0"));
    // The rest of the reply arrives after the Stop; it must not be streamed to its end.
    held.released = true;
    const statuses = () => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ payload_json: string }>(
      `SELECT payload.payload_json FROM transcript_facts fact
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE fact.fact_kind = 'assistant_turn_status'`).toArray()
      .map((row) => (JSON.parse(row.payload_json) as { structuredContent?: { kind?: string } }).structuredContent?.kind));
    await expect.poll(statuses, { timeout: 15_000 }).toEqual(["assistant_turn_stopped"]);
    await expect.poll(() => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ status: string }>(
      `SELECT status FROM substream_loops WHERE id = 1`).one().status), { timeout: 15_000 }).toBe("idle");
    const accepted = await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ payload_json: string }>(
      `SELECT payload_json FROM transcript_payloads`).toArray().map((row) => row.payload_json).join("\n"));
    expect(accepted).not.toContain("THE END");
  });

  it("titles a Canvas made with no title from its opening message, on every open list", () => withNamingModel(async () => {
    const creator = await connect(CREATOR);
    const { canvasId } = await new CanvasService(TEST_ENV, auth(CREATOR)).create({
      prompt: { text: "Plan the December pricing launch: owners, dates, and what gates the announcement.", clientMessageId: "canvas-name-1" },
    });
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    expect(await service.detail(canvasId)).toMatchObject({ title: "Untitled Canvas", titleStatus: "naming" });
    // The Chat's first message reaches the Canvas's parent, which names it by an alarm of its own.
    await deliverChildEffects(TEST_ENV, env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, canvasId))));
    await expect.poll(async () => (await service.detail(canvasId)).titleStatus, { timeout: 15_000 }).toBe("settled");
    expect((await service.detail(canvasId)).title).toBe("December pricing launch");
    await expect.poll(() => clientCanvasRows(creator.frames).find((row) => row.id === canvasId)?.title)
      .toBe("December pricing launch");
    const naming = provider.calls.filter(namingCall);
    expect(naming).toHaveLength(1);
    expect(JSON.stringify(naming[0]!.messages)).toContain("Plan the December pricing launch");
    creator.socket.close(1000, "done");
  }));

  it("keeps a person's title over the one its opening message would give it", () => withNamingModel(async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const { canvasId } = await service.create({});
    await service.rename(canvasId, "Mine");
    expect(await service.detail(canvasId)).toMatchObject({ title: "Mine", titleStatus: "settled" });
    const client = await new ConversationService(TEST_ENV, auth(CREATOR)).writableClient(canvasId, "0");
    await client.createMessage({ text: "Plan the December pricing launch.", clientMessageId: "canvas-name-2",
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
    await deliverChildEffects(TEST_ENV, env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, canvasId))));
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT 1 FROM _internal_durable_alarms WHERE kind = 'canvas_naming'`).toArray())).toEqual([]);
    expect(await service.detail(canvasId)).toMatchObject({ title: "Mine", titleStatus: "settled" });
    expect(provider.calls.filter(namingCall)).toEqual([]);
  }));

  it("orders one viewer's pinned Canvases as asked, keeping the ones left out after them", async () => {
    const canvases = [];
    for (const title of ["First", "Second", "Third"]) {
      const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title });
      await new CanvasService(TEST_ENV, auth(CREATOR)).pin("canvas", canvasId, true);
      canvases.push(canvasId);
    }
    const [first, second, third] = canvases as [string, string, string];
    const creator = await connect(CREATOR);
    const position = (canvasId: string) => clientCanvasRows(creator.frames).find((row) => row.id === canvasId)?.pinnedPosition;
    expect([position(first), position(second), position(third)]).toEqual([0, 1, 2]);
    await new CanvasService(TEST_ENV, auth(CREATOR)).reorderPins("canvas", [third, first, crypto.randomUUID()]);
    await expect.poll(() => [position(third), position(first), position(second)]).toEqual([0, 1, 2]);
    creator.socket.close(1000, "done");
  });
});

describe("a Sidekick's pin", () => {
  it("pins a Sidekick the viewer is listed and refuses one they are not", async () => {
    const sidekickId = crypto.randomUUID();
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId });
    const pin = (userId: string) => workspace().setSidebarPin({ workspaceId: WORKSPACE_ID, userId, accessClass: "member",
      kind: "sidekick", itemId: sidekickId, pinned: true });
    expect(await pin(MEMBER)).toEqual({ ok: false });
    expect(await pin(CREATOR)).toEqual({ ok: true });
    await workspace().sidekickSetAudience({ workspaceId: WORKSPACE_ID, automationId: sidekickId,
      actor: { userId: CREATOR, actorRole: "member", participantOfOwningWorkstream: false },
      update: { audience: "people", userIds: [MEMBER] } });
    expect(await pin(MEMBER)).toEqual({ ok: true });
  });
});

describe("a Canvas's artifacts", () => {
  /** The Terminal's resource bridge in a Canvas's Chat; `noting: false` is an attempt that dies before its note. */
  function canvasBridge(canvasId: string, noting = true) {
    return createTerminalResourceBridge(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID),
      createTerminalPortFactory(TEST_ENV, undefined, "0"), undefined, null, null, null, "0",
      noting ? canvasArtifactNoter(TEST_ENV, { workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: canvasId, substreamId: asSubstreamId("0") }) : null);
  }

  function toolContext(canvasId: string, harnessRunId = crypto.randomUUID()) {
    return { workspaceId: WORKSPACE_ID, workstreamId: canvasId, harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(), executionPrincipal: { type: "user" as const, userId: CREATOR },
      signal: new AbortController().signal };
  }

  /** Publish a file from the Canvas's Chat through the Terminal's resource bridge, as Rally's publish_resource does. */
  async function publish(canvasId: string, filePath: string, text: string) {
    return canvasBridge(canvasId).publishResource(toolContext(canvasId), { filePath }, new TextEncoder().encode(text));
  }

  it("notes a publish recovered after its attempt died before the note", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const attemptStartedAt = Date.now() - 1_000;
    const context = toolContext(canvasId);
    const published = await canvasBridge(canvasId, false)
      .publishResource(context, { filePath: "plan.md" }, new TextEncoder().encode("# Launch plan"));
    const detail = () => workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" } });
    expect((await detail()).artifacts).toEqual([]);
    const recovered = await canvasBridge(canvasId).reconcilePublishedResource({ ...context, attemptStartedAt }, { filePath: "plan.md" });
    expect(recovered.outcome).toBe("landed");
    expect((await detail()).artifacts).toMatchObject([{ resourceId: published.resourceId, version: 1 }]);
  });

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

  it("marks a Canvas unread to a viewer when somebody else makes a new version of its artifact, not to its publisher", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER] } });
    // Both have read the Chat, before either version was made.
    const readAt = Date.now() - 60_000;
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const userId of [CREATOR, MEMBER]) {
        state.storage.sql.exec(`INSERT INTO sidekick_viewer_reads
          (sidekick_id, user_id, source_version, seen_attention_ordinal, manual_unread_from_ordinal, updated_at)
          VALUES (?, ?, 1, 0, NULL, ?)`, canvasId, userId, readAt);
      }
    });
    await publish(canvasId, "plan.md", "# Launch plan");
    const { resourceId } = await publish(canvasId, "plan.md", "# Launch plan, revised");
    // The revision is the creator's: Rally made it on their behalf, as a run
    // they started does.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE resource_versions SET on_behalf_of_user_id = ? WHERE resource_id = ? AND version = 2`,
        CREATOR, resourceId);
    });
    const unread = (userId: string) => runInDurableObject(workspace(), (_instance, state) =>
      canvasSidebarRows(state.storage.sql, { userId, member: true }, new Map(), 50).find((row) => row.id === canvasId)?.unread);
    expect(await unread(MEMBER)).toBe(true);
    expect(await unread(CREATOR)).toBe(false);
  });

  it("refuses a canvas argument anywhere but a Sidekick run", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const { canvasId: elsewhere } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    // From a Canvas's Chat, naming another Canvas.
    await expect(canvasBridge(canvasId).publishResource(toolContext(canvasId), { filePath: "plan.md", canvas: elsewhere },
      new TextEncoder().encode("# Launch plan"))).rejects.toMatchObject({ code: "canvas_argument_unsupported" });
    // From a Sidekick's own conversation, which is not a run.
    const sidekickId = crypto.randomUUID();
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId });
    await expect(resolveTerminalPublicationHome(TEST_ENV, { workspaceId: WORKSPACE_ID, parentKind: "automation", parentId: sidekickId,
      substreamId: asSubstreamId("0"), executionPrincipal: { type: "user", userId: CREATOR } }, { canvas: canvasId }))
      .rejects.toMatchObject({ code: "canvas_argument_unsupported" });
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

describe("a link to a conversation", () => {
  it("names the Canvas for its Chat and the Sidekick for its conversation, and nothing for a Thread", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    const sidekickId = crypto.randomUUID();
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId });
    const organization = uuidToBase58(WORKSPACE_ID);
    const link = (parentId: string, artifactId?: string) => conversationCanonicalUrl(TEST_ENV, {
      region: "global", workspaceId: WORKSPACE_ID, parentId, ...(artifactId ? { artifactId } : {}) });
    await expect(link(canvasId)).resolves.toBe(`https://app.test/app/global/${organization}/cv/${uuidToBase58(canvasId)}/`);
    const artifactId = crypto.randomUUID();
    await expect(link(canvasId, artifactId)).resolves
      .toBe(`https://app.test/app/global/${organization}/cv/${uuidToBase58(canvasId)}/a/${uuidToBase58(artifactId)}/`);
    await expect(link(sidekickId)).resolves.toBe(`https://app.test/app/global/${organization}/sk/${uuidToBase58(sidekickId)}/`);
    // An id the Organization holds no Canvas or Sidekick for: a Thread's, or nothing's.
    await expect(link(crypto.randomUUID())).resolves.toBeNull();
  });

  it("lets the handoff page name the Canvas, from its current title", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "canvas", canvasId } }))
      .resolves.toEqual({ title: "Launch plan" });
    await expect(workspace().linkTitle({ workspaceId: WORKSPACE_ID, target: { kind: "canvas", canvasId: crypto.randomUUID() } }))
      .resolves.toEqual({ title: null });
  });
});

describe("Rally in a Canvas's Chat", () => {
  it("answers with the Canvas's current artifacts as context and the resource tools a Thread's Main has, and holds a memory digest copy", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    const resourceId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'generated_file', 'avalon_generated', 'plan.md', '{}', 'attached', ?, ?)`, resourceId, WORKSPACE_ID, NOW, NOW);
    });
    await workspace().canvasNoteArtifact({ workspaceId: WORKSPACE_ID, canvasId, resourceId, editor: { kind: "rally", id: null } });
    await new ConversationService(TEST_ENV, auth(CREATOR)).authorizeViewer(canvasId);
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    const response = await chat.fetch("https://object.test/internal/product", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "create_message", parentKind: "canvas", auth: auth(CREATOR),
        input: { text: "Tighten the plan.", clientMessageId: "canvas-ask-1", mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] } }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    await runDurableObjectAlarm(chat);
    await expect.poll(() => provider.calls.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const call = provider.calls.find((candidate) => candidate.messages.some((message) =>
      typeof message.content === "string" && message.content.startsWith("CANVAS CONTEXT")))!;
    const context = call.messages.find((message) => typeof message.content === "string" && message.content.startsWith("CANVAS CONTEXT"))!;
    expect(JSON.parse(String(context.content).replace(/^CANVAS CONTEXT \(host-provided\):\n/u, ""))).toMatchObject({
      canvasId, title: "Launch plan", artifacts: [{ resourceId, title: "plan.md", kind: "file", version: 1 }],
    });
    expect(call.toolNames).toEqual(expect.arrayContaining(["list_resources", "read_resource"]));
    // The run read its memory digest, so the Organization records the Chat as
    // a holder of a copy; a `canvas` holder is admitted (WorkspaceDO migration 143).
    await expect.poll(() => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT parent_kind, parent_id, substream_id FROM memory_digest_holders WHERE parent_id = ?", canvasId,
    ).toArray()), { timeout: 15_000 }).toEqual([{ parent_kind: "canvas", parent_id: canvasId, substream_id: "0" }]);
  });
});

