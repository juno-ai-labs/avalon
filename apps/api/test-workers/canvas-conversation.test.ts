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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asHarnessRunId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { CanvasArtifactKind } from "@rally/contracts";
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
import { sha256Hex } from "../src/lib/crypto";
import { createTerminalPortFactory } from "../src/services/terminal/object-port";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { bootstrapWorkstreamRuntimeEnvironment } from "../src/services/workstream-runtime-database";
import { createResourceObjectPort } from "../src/runtime/resource-port";
import { createTranscriptObjectPort } from "../src/runtime/transcript-port";
import { CANVAS_NAMING_ALARM_KIND } from "../src/durable-objects/canvas-schema";
import { __integrationTesting } from "../src/services/integrations";
import { ConversationService } from "../src/services/conversation-service";
import { verifySocketTicket } from "../src/services/socket-service";
import { consumeEffectBodies, deliverChildEffects, pendingChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { memberInputs, useOpenRouterDouble } from "./helpers/openrouter-double";
import { responsesEvents, responsesStreamResponse } from "@rally/agent-harness/test-support/responses-stream";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { startWaitBudget, waitBudget } from "./helpers/wait-budget";

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
  const mutable = env as { OPENROUTER_FASTER_MODEL?: string };
  mutable.OPENROUTER_FASTER_MODEL = "double/naming";
  try {
    return await run();
  } finally {
    delete mutable.OPENROUTER_FASTER_MODEL;
  }
}
/**
 * A reply streamed in two parts, the second held until the test releases it:
 * the stand-in for a long reply a person stops halfway through.
 */
const LONG_REPLY_PROMPT = "Tell me a long story.";
const INTERIM_REPLY_PROMPT = "Help me choose an option.";
const INTERIM_REPLY = "I can help narrow it down.";
/**
 * Plain flags rather than promises: the reply's stream is read inside the
 * conversation object, and a promise settled across the test and the object
 * would carry one side's I/O context into the other. The test that holds the
 * reply sets `released` and `finished` in a `finally`, so a failed test never
 * leaves the stream spinning in its conversation object.
 */
const held = { firstPartSent: false, released: false, finished: false };
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
      // be aborted, however long a contended run takes to abort it; one that
      // never aborts gets the rest of its reply when the test ends, and the
      // test has already failed on the stopped status it never saw. A fixed
      // wait here raced the abort: past it, the reply streamed to its end.
      else if (sent > 1) while (!signal?.aborted && !held.finished) {
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
/**
 * The naming pass's answer, and whether it waits for the test before it
 * answers. Plain flags, as `held` below, since the call runs inside the
 * Workspace object.
 */
const naming = { icon: "rocket", holding: false, asked: false, released: false };
async function namingReply(): Promise<{ say: string }> {
  naming.asked = true;
  while (naming.holding && !naming.released) await new Promise((resolve) => setTimeout(resolve, 10));
  return { say: JSON.stringify({ title: "December pricing launch", icon: naming.icon }) };
}
const provider = useOpenRouterDouble((call) => namingCall(call)
  ? namingReply()
  : call.stream && JSON.stringify(memberInputs(call)).includes(LONG_REPLY_PROMPT) ? { raw: heldReply(call.signal) }
    : call.stream && JSON.stringify(memberInputs(call)).includes(INTERIM_REPLY_PROMPT) ? { raw: responsesStreamResponse([
      { choices: [{ delta: { content: INTERIM_REPLY }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "recent-question", type: "function", function: {
        name: "request_elicitation", arguments: JSON.stringify({ prompt: "Which option?", responseType: "text" }),
      } }] }, finish_reason: "tool_calls" }] },
    ]) }
    : { say: "Here is the plan." });
useSelectedModel();

function auth(userId: string): AuthContext {
  return { sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global",
    role: userId === ADMIN ? "admin" : userId === GUEST ? null : "member" };
}

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

/** The development seed writes canonical turns with a supplied timestamp. */
async function seedChatMessage(transcript: ReturnType<typeof createTranscriptObjectPort>, expectedTranscriptSequence: number,
  actor: "human" | "assistant", text: string, createdAtUtc: string): Promise<void> {
  const mutable = env as { APP_ENV?: string };
  const appEnv = mutable.APP_ENV;
  mutable.APP_ENV = "development";
  try {
    await transcript.seedDevelopmentConversationTurn({
      turnId: crypto.randomUUID(), clientMessageId: actor === "human" ? crypto.randomUUID() : null, actor,
      authorUserId: actor === "human" ? CREATOR : null,
      authorSnapshot: actor === "human" ? { displayName: "Creator", avatarUrl: null } : null,
      externalActorJson: null, messageType: "text", text, structuredContentJson: null, producedByRunId: null,
      expectedTranscriptSequence, createdAtUtc,
    });
  } finally {
    if (appEnv === undefined) delete mutable.APP_ENV;
    else mutable.APP_ENV = appEnv;
  }
}

/**
 * A Canvas a Sidekick writes, as a run made one before runs stopped making
 * Canvases: its writer named on the row and attached to the Sidekick.
 */
async function writtenCanvas(sidekickId: string, title: string): Promise<string> {
  const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title });
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`UPDATE canvas_directory SET writer_sidekick_id = ?, writer_run_id = ? WHERE canvas_id = ?`,
      sidekickId, crypto.randomUUID(), canvasId);
  });
  await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, automationId: sidekickId, userId: CREATOR, reference: canvasId });
  return canvasId;
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
  startWaitBudget();
});

// These cases are about who may open a private Canvas, so the Organization
// makes new Canvases private rather than taking the Organization-wide default.
beforeEach(async () => {
  await workspace().saveCanvasSharingDefaults({ workspaceId: WORKSPACE_ID, defaults: { editors: "creator" } });
  // A file published into a Canvas reserves its host, as production's PLATFORM_DB migration declares it.
  await env.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS artifact_hostname_routes(hostname_stub TEXT NOT NULL PRIMARY KEY,
    region TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(region, artifact_id))`).run();
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

  it("refuses a participant who has left the Organization on a path with no session behind it", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER] } });
    // The notice path's check: the Organization object, asked directly.
    const decide = () => workspace().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: canvasId,
      userId: MEMBER, substreamId: asSubstreamId("0") });
    expect(await decide()).toMatchObject({ authorized: true });
    // They leave; the participant list still names them.
    await env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .bind(WORKSPACE_ID, MEMBER).run();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM workspace_member_status WHERE user_id = ?`, MEMBER);
    });
    expect(await decide()).toEqual({ authorized: false, archived: false, refusal: "viewer_relationship_inactive" });
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

  it("makes a Sidekick for a Canvas on request: attached to it, its instructions sent to its wizard once, and only for a Canvas the person can open", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const sidekickId = crypto.randomUUID();
    const request = { sidekickId, instructions: { text: "On every new email, add a row.", clientMessageId: "canvas-sidekick-1" } };
    const first = await new CanvasService(TEST_ENV, auth(CREATOR)).addSidekick(canvasId, request);
    const retried = await new CanvasService(TEST_ENV, auth(CREATOR)).addSidekick(canvasId, request);
    expect(retried).toEqual(first);
    expect(first.sidekickId).toBe(sidekickId);
    expect((await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId)).sidekicks)
      .toEqual([{ id: sidekickId, name: "New Sidekick", status: "draft", madeHere: true, triggerKinds: [], canOpen: true }]);
    // The instructions are the author's message in the Sidekick's own conversation, once.
    const wizard = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, sidekickId)));
    expect(await runInDurableObject(wizard, (_instance, state) => state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM canonical_conversation_turn_details WHERE client_message_id = ?`, "canvas-sidekick-1").one().n)).toBe(1);
    // Someone who cannot open the Canvas makes none for it, and the id stays the first author's.
    await expect(new CanvasService(TEST_ENV, auth(MEMBER)).addSidekick(canvasId, { ...request, sidekickId: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: "canvas_not_found" });
    const { canvasId: other } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await expect(new CanvasService(TEST_ENV, auth(CREATOR)).addSidekick(other, request))
      .rejects.toMatchObject({ code: "sidekick_id_unavailable" });
    expect((await new CanvasService(TEST_ENV, auth(CREATOR)).detail(other)).sidekicks).toEqual([]);
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

/** Every socket `connect` opened in this test; whatever is still open is closed after it, pass or fail. */
const connected: WebSocket[] = [];
afterEach(() => {
  // 1 is OPEN: a socket the test already closed, or the server did, is left alone.
  for (const socket of connected.splice(0)) if (socket.readyState === 1) socket.close(1000, "test ended");
});

/**
 * A workspace socket for this person, subscribed; every frame it receives is
 * kept. A socket closed or failed before its subscribe answer rejects with
 * why, rather than leaving the test waiting out its timeout.
 */
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
  connected.push(socket);
  const frames: Array<Record<string, unknown>> = [];
  const subscribed = new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (String(event.data) === "pong") return;
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "workspace_sync") resolve();
    });
    socket.addEventListener("close", (event) => reject(new Error(`workspace socket closed before its subscribe answer: ${event.code} ${event.reason}`)));
    socket.addEventListener("error", () => reject(new Error("workspace socket failed before its subscribe answer")));
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await subscribed;
  return { socket, frames };
}

type Row = { id: string; title: string; updatedAt: string; appearance?: { icon: string | null; color: string | null }; unread: boolean; sharedWithMe: boolean; presentUserIds: string[]; pinnedPosition: number | null; hasStoredData?: boolean; artifactKind?: CanvasArtifactKind | null };

/** The Canvas rows a socket was last told: the newest list push, else its subscribe payload. */
function canvasRows(frames: Array<Record<string, unknown>>): Row[] {
  const pushes = frames.filter((frame) => frame.type === "workspace_canvas_list");
  if (pushes.length > 0) return pushes.at(-1)!.items as Row[];
  const sync = frames.find((frame) => frame.type === "workspace_sync") as { sidebar?: { canvases?: { items: Row[] } } };
  return sync.sidebar?.canvases?.items ?? [];
}

/** Every table in an object's SQLite with a row whose text names this id, in any column. */
function tablesNaming(sql: SqlStorage, id: string): string[] {
  return sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).toArray().map(({ name }) => name).filter((name) => {
    const columns = sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`).toArray().map((column) => column.name);
    if (columns.length === 0) return false;
    const where = columns.map((column) => `instr(CAST("${column}" AS TEXT), ?) > 0`).join(" OR ");
    return sql.exec(`SELECT 1 FROM "${name}" WHERE ${where} LIMIT 1`, ...columns.map(() => id)).toArray().length > 0;
  });
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
  it("uses a saved Rally message for recency when it has no unread ordinal", async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const { canvasId } = await service.create({ title: "Decision", prompt: { text: INTERIM_REPLY_PROMPT, clientMessageId: "canvas-recent-rally" } });
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    const savedMessages = () => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ created_at: number }>(
      `SELECT created_at FROM canonical_conversation_turn_details
        WHERE (author_type = 'member' AND content = ?) OR (author_type = 'agent' AND content = ?)
        ORDER BY sequence_number`, INTERIM_REPLY_PROMPT, INTERIM_REPLY).toArray());
    await expect.poll(savedMessages, { timeout: waitBudget() }).toHaveLength(2);
    const projections = await pendingChildEffects(chat);
    // Deliver the person's message and the saved reply before the structured question that follows them.
    for (const message of await savedMessages()) {
      const messageAt = new Date(message.created_at).toISOString();
      const projection = projections.find(({ effect }) =>
        effect.kind === "directory_common" && effect.latestAttentionOrdinal === 1 && effect.lastMessageAt === messageAt);
      expect(projection).toBeDefined();
      expect(await consumeEffectBodies(TEST_ENV, [projection])).toEqual({ acked: 1, retried: 0 });
      expect((await service.detail(canvasId)).updatedAt).toBe(messageAt);
    }
  });

  it("keeps the date and order when opening a converted Canvas with historical Chat activity", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Older Canvas" });
    const { canvasId: newerId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Newer Canvas" });
    for (const id of [canvasId, newerId]) {
      await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: id,
        actor: { userId: CREATOR, actorRole: "member" }, update: { visibility: "workspace", userIds: [] } });
    }
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    const routed = await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, canvasId, "canvas");
    await seedChatMessage(createTranscriptObjectPort(routed, WORKSPACE_ID, canvasId), 1, "human", "A saved message from before conversion.",
      "2026-10-18T18:39:04.461Z");
    await deliverChildEffects(TEST_ENV, chat);
    // The converted directory can lag the Chat. Opening must not catch up the date or reorder the list.
    const olderActivity = "2026-10-17T18:00:00.000Z";
    const newerActivity = "2026-10-18T18:00:00.000Z";
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const [id, activity] of [[canvasId, olderActivity], [newerId, newerActivity]] as const) {
        state.storage.sql.exec("UPDATE canvas_directory SET created_at = ?, updated_at = ? WHERE canvas_id = ?",
          Date.parse(activity), Date.parse(activity), id);
      }
      state.storage.sql.exec("DELETE FROM sidekick_child_projections WHERE sidekick_id = ?", canvasId);
    });
    const { frames } = await connect(MEMBER);
    const newer = { id: newerId, updatedAt: newerActivity };
    const older = { id: canvasId, updatedAt: olderActivity };
    expect(clientCanvasRows(frames)).toMatchObject([newer, { ...older, unread: true }]);

    await new ConversationService(TEST_ENV, auth(MEMBER)).socketTicket(canvasId);
    await deliverChildEffects(TEST_ENV, chat);

    const after = await connect(MEMBER);
    expect(clientCanvasRows(after.frames)).toMatchObject([newer, { ...older, unread: false }]);
  });

  it("pushes an archived Canvas off every reader's active list", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId,
      actor: { userId: CREATOR, actorRole: "member" }, update: { visibility: "participants", userIds: [MEMBER] } });
    const creator = await connect(CREATOR);
    const member = await connect(MEMBER);
    expect(clientCanvasRows(creator.frames).map((row) => row.id)).toContain(canvasId);
    expect(clientCanvasRows(member.frames).map((row) => row.id)).toContain(canvasId);
    await new CanvasService(TEST_ENV, auth(CREATOR)).archive(canvasId);
    await expect.poll(() => clientCanvasRows(creator.frames).map((row) => row.id), { timeout: waitBudget() }).toEqual([]);
    await expect.poll(() => clientCanvasRows(member.frames).map((row) => row.id), { timeout: waitBudget() }).toEqual([]);
  });

  it("deletes a Canvas its creator left blank from every store and list, and keeps one with a message, a title, or a reader who is not its creator", () => withNamingModel(async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const creator = await connect(CREATOR);
    const blank = (await service.create({})).canvasId;
    const said = (await service.create({})).canvasId;
    const titled = (await service.create({})).canvasId;
    await expect.poll(() => clientCanvasRows(creator.frames).map((row) => row.id).sort(), { timeout: waitBudget() })
      .toEqual([blank, said, titled].sort());

    const client = await new ConversationService(TEST_ENV, auth(CREATOR)).writableClient(said, "0");
    await client.createMessage({ text: "Plan the December pricing launch.", clientMessageId: "canvas-discard-said",
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
    await deliverChildEffects(TEST_ENV, env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, said))));
    await service.update(titled, { title: "Mine" });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: blank,
      actor: { userId: CREATOR, actorRole: "member" }, update: { visibility: "workspace", userIds: [] } });
    // A reader who did not make it never discards it, even while it is empty.
    expect(await new CanvasService(TEST_ENV, auth(MEMBER)).discardIfBlank(blank)).toEqual({ discarded: false });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: blank,
      actor: { userId: CREATOR, actorRole: "member" }, update: { visibility: "creator", userIds: [] } });

    const chatOf = (canvasId: string) => env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    // What its Chat sent before the delete and the Queue has not delivered yet.
    const late = await pendingChildEffects(chatOf(blank));
    expect(late.length).toBeGreaterThan(0);

    expect(await service.discardIfBlank(said)).toEqual({ discarded: false });
    expect(await service.discardIfBlank(titled)).toEqual({ discarded: false });
    expect(await service.discardIfBlank(blank)).toEqual({ discarded: true });
    await expect.poll(() => clientCanvasRows(creator.frames).map((row) => row.id).sort(), { timeout: waitBudget() })
      .toEqual([said, titled].sort());
    await expect(service.detail(blank)).rejects.toMatchObject({ code: "canvas_not_found" });
    // Once its erase alarm has run, neither the Organization's object nor its
    // Chat's still names it. The kept Canvas is the scan's control.
    await runDurableObjectAlarm(workspace());
    await expect.poll(() => runInDurableObject(workspace(), (_instance, state) => tablesNaming(state.storage.sql, blank)),
      { timeout: waitBudget() }).toEqual([]);
    expect(await runInDurableObject(workspace(), (_instance, state) => tablesNaming(state.storage.sql, said))).toContain("canvas_directory");
    await expect.poll(() => runInDurableObject(chatOf(blank), (_instance, state) => tablesNaming(state.storage.sql, blank)),
      { timeout: waitBudget() }).toEqual([]);
    expect(await runInDurableObject(chatOf(said), (_instance, state) => tablesNaming(state.storage.sql, said))).not.toEqual([]);
    // Delivered after the delete, it is acknowledged rather than retried into
    // the dead-letter queue, and writes nothing back.
    expect(await consumeEffectBodies(TEST_ENV, late)).toEqual({ acked: late.length, retried: 0 });
    expect(await runInDurableObject(workspace(), (_instance, state) => tablesNaming(state.storage.sql, blank))).toEqual([]);
    creator.socket.close(1000, "done");
  }));

  it("keeps a blank-looking Canvas whose Chat holds a message its projection has not delivered yet, and leaves the Chat open", () => withNamingModel(async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const { canvasId } = await service.create({});
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    // Sent from another window: the Chat holds it, the Canvas has not heard yet.
    const client = await new ConversationService(TEST_ENV, auth(CREATOR)).writableClient(canvasId, "0");
    await client.createMessage({ text: "Keep this.", clientMessageId: "canvas-discard-race-1",
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
    expect(await workspace().canvasDiscardIfBlank({ workspaceId: WORKSPACE_ID, canvasId,
      actor: { userId: CREATOR, actorRole: "member" }, commit: false })).toEqual({ discarded: true });

    expect(await service.discardIfBlank(canvasId)).toEqual({ discarded: false });
    expect((await service.detail(canvasId)).id).toBe(canvasId);
    const said = () => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ content: string }>(
      "SELECT content FROM canonical_conversation_turn_details WHERE author_type = 'member' ORDER BY sequence_number").toArray()
      .map((row) => row.content));
    expect(await said()).toEqual(["Keep this."]);
    // Still open: the next message is admitted, into the transcript or the
    // queue behind the run the first one started.
    await client.createMessage({ text: "And this.", clientMessageId: "canvas-discard-race-2",
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
    expect(await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec(
      `SELECT 1 FROM canonical_conversation_turn_details WHERE client_message_id = ?1
        UNION ALL SELECT 1 FROM pending_loop_inputs WHERE client_message_id = ?1`, "canvas-discard-race-2").toArray().length)).toBe(1);
  }));

  it("keeps a blank Canvas another window still has open, and deletes it once only the leaving one did", () => withNamingModel(async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const { canvasId } = await service.create({});
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    const open = async (ticketId: string) => {
      await new ConversationService(TEST_ENV, auth(CREATOR)).authorizeViewer(canvasId);
      const response = await chat.fetch("https://substream.test/socket", { headers: {
        Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-workstream-id": canvasId,
        "x-rally-substream-id": "0", "x-rally-user-id": CREATOR, "x-rally-session-id": `session-${CREATOR}`,
        "x-rally-socket-ticket-id": ticketId, "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        "x-rally-socket-after-sequence": "0",
      } });
      expect(response.status, response.status === 101 ? "" : await response.text()).toBe(101);
      const socket = response.webSocket!;
      const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
      socket.accept();
      return { socket, closed };
    };
    const leaving = crypto.randomUUID();
    await open(leaving);
    const second = await open(crypto.randomUUID());

    expect(await service.discardIfBlank(canvasId, leaving)).toEqual({ discarded: false });
    expect((await service.detail(canvasId)).id).toBe(canvasId);

    second.socket.close(1000, "left");
    await expect.poll(async () => (await service.discardIfBlank(canvasId, leaving)).discarded, { timeout: waitBudget() }).toBe(true);
    await expect(service.detail(canvasId)).rejects.toMatchObject({ code: "canvas_not_found" });
  }));

  it("erases a discarded Canvas's Chat from an alarm committed with the delete, once it can, and again harmlessly", () => withNamingModel(async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const { canvasId } = await service.create({});
    // A fresh stub each time: one that saw the Chat reset is broken for good.
    const chat = () => env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    // The erase cannot run yet: as if the Worker died after the delete committed.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`CREATE TRIGGER hold_canvas_discard_erase AFTER INSERT ON _internal_durable_alarms
        WHEN NEW.kind = 'canvas_discard_erase' BEGIN
        UPDATE _internal_durable_alarms SET retry_at = ${Date.now() + 60_000}
         WHERE kind = NEW.kind AND alarm_key = NEW.alarm_key; END`);
    });
    expect(await service.discardIfBlank(canvasId)).toEqual({ discarded: true });
    await expect(service.detail(canvasId)).rejects.toMatchObject({ code: "canvas_not_found" });
    expect(await runInDurableObject(chat(), (_instance, state) => tablesNaming(state.storage.sql, canvasId))).not.toEqual([]);

    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER hold_canvas_discard_erase");
      state.storage.sql.exec("UPDATE _internal_durable_alarms SET retry_at = 0 WHERE kind = 'canvas_discard_erase'");
    });
    await runDurableObjectAlarm(workspace());
    await expect.poll(() => runInDurableObject(chat(), (_instance, state) => tablesNaming(state.storage.sql, canvasId)),
      { timeout: waitBudget() }).toEqual([]);
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT 1 FROM _internal_durable_alarms WHERE kind = 'canvas_discard_erase'").toArray())).toEqual([]);
    // A retry after the erase landed finds nothing to erase.
    // Its reset can reach the caller before its answer, as the alarm allows for.
    await chat().eraseBlankConversation({ workspaceId: WORKSPACE_ID, parentId: canvasId })
      .catch((error: unknown) => { if (!String(error).includes("conversation_erased")) throw error; });
    await expect.poll(() => runInDurableObject(chat(), (_instance, state) => tablesNaming(state.storage.sql, canvasId)),
      { timeout: waitBudget() }).toEqual([]);
  }));

  it("lists a Canvas to whoever may open it, unread to a participant who has not opened it", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    const creator = await connect(CREATOR);
    const before = await connect(MEMBER);
    expect(canvasRows(creator.frames)).toMatchObject([{ id: canvasId, unread: false, sharedWithMe: false }]);
    expect(canvasRows(before.frames)).toEqual([]);
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER] } });
    // The change is pushed to every socket, each with its own rows.
    await expect.poll(() => canvasRows(before.frames), { timeout: waitBudget() }).toMatchObject([{ id: canvasId, unread: true, sharedWithMe: true }]);
    for (const { socket } of [creator, before]) socket.close(1000, "done");
  });

  it("logs a Canvas list push it cannot build by the field that failed, and still commits the write", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    const creator = await connect(CREATOR);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A row the list's own schema refuses (storage CHECKs keep real rows
      // valid, so the read is made to return one): the push cannot be built.
      await runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
        const target = Object.getPrototypeOf(instance) as { canvasList: (...args: unknown[]) => unknown[] };
        const original = target.canvasList;
        // The suite logs errors only; this test reads a warning.
        const logged = (instance as unknown as { env: { LOG_LEVEL: string | undefined } }).env;
        const level = logged.LOG_LEVEL;
        logged.LOG_LEVEL = "warn";
        target.canvasList = function (this: unknown, ...args: unknown[]) {
          return (original.apply(this, args) as Record<string, unknown>[]).map((row) => ({ ...row, title: "x".repeat(400) }));
        };
        try {
          await instance.canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
            update: { visibility: "participants", userIds: [MEMBER] } });
        } finally {
          target.canvasList = original;
          logged.LOG_LEVEL = level;
        }
      });
      expect(await opens(MEMBER, canvasId)).toBe(true);
      const unpublished = warned.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter((entry) => entry?.event === "workspace_canvas_list_unpublished");
      expect(unpublished).toHaveLength(1);
      expect(String(unpublished[0]!.code)).toContain("title");
    } finally {
      warned.mockRestore();
      creator.socket.close(1000, "done");
    }
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
    await expect.poll(() => clientCanvasRows(creator.frames)[0]?.presentUserIds, { timeout: waitBudget() }).toEqual([MEMBER]);
    // The face pile in the Canvas itself, on the same presence path a Channel's uses.
    creator.socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: canvasId }));
    await expect.poll(() => creator.frames.filter((frame) => frame.type === "workspace_presence").at(-1), { timeout: waitBudget() })
      .toMatchObject({ workstreamId: canvasId, userIds: [MEMBER] });
    expect(await workspace().setSidebarPin({ workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member",
      kind: "canvas", itemId: canvasId, pinned: true })).toEqual({ ok: true });
    await expect.poll(() => canvasRows(member.frames)[0]?.pinnedPosition, { timeout: waitBudget() }).toBe(0);
    expect(canvasRows(creator.frames)[0]?.pinnedPosition).toBeNull();
    for (const { socket } of [creator, member]) socket.close(1000, "done");
  });

  it("refuses a pin request that is not well formed by the field it got wrong", async () => {
    const rejection = await workspace().setSidebarPin({ workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member",
      kind: "canvas", itemId: "not-an-id", pinned: true }).then(() => null, (error: unknown) => (error as Error).message);
    expect(rejection).toMatch(/^set_sidebar_pin_invalid:.*itemId/u);
  });

  it("refuses to pin, and keeps out of presence, a Canvas the viewer may not open", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const creator = await connect(CREATOR);
    const outsider = await connect(MEMBER);
    outsider.socket.send(JSON.stringify({ type: "set_presence", revision: 1, applicationState: "foreground", foregroundWorkstreamId: canvasId }));
    let pongs = 0;
    outsider.socket.addEventListener("message", (event) => { if (String(event.data) === "pong") pongs += 1; });
    outsider.socket.send("ping");
    await expect.poll(() => pongs, { timeout: waitBudget() }).toBeGreaterThan(0);
    expect(canvasRows(creator.frames)[0]?.presentUserIds).toEqual([]);
    expect(await workspace().setSidebarPin({ workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass: "member",
      kind: "canvas", itemId: canvasId, pinned: true })).toEqual({ ok: false });
    for (const { socket } of [creator, outsider]) socket.close(1000, "done");
  });
});

describe("a Canvas's title and pin order", () => {
  it("retitles a Canvas for anyone it admits, on every open list, and tells anyone else it does not exist", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE canvas_directory SET updated_at = ? WHERE canvas_id = ?", Date.parse(NOW), canvasId);
    });
    await expect(new CanvasService(TEST_ENV, auth(MEMBER)).update(canvasId, { title: "Taken over" }))
      .rejects.toMatchObject({ code: "canvas_not_found" });
    const shared = await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER] } });
    expect(shared.updatedAt).toBe(NOW);
    const creator = await connect(CREATOR);
    const renamed = await new CanvasService(TEST_ENV, auth(MEMBER)).update(canvasId, { title: "  Launch plan, v2 " });
    expect(renamed).toMatchObject({ title: "Launch plan, v2", updatedAt: NOW });
    expect((await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId)).title).toBe("Launch plan, v2");
    await expect.poll(() => clientCanvasRows(creator.frames).find((row) => row.id === canvasId)?.title, { timeout: waitBudget() }).toBe("Launch plan, v2");
    creator.socket.close(1000, "done");
  });

  it("keeps the icon and colour anyone it admits chooses, a field at a time, on its detail and every open list, and tells anyone else it does not exist", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    // Unchosen until someone chooses: both fields null, which the client draws as the default.
    expect((await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId)).appearance).toEqual({ icon: null, color: null });
    await expect(new CanvasService(TEST_ENV, auth(MEMBER)).update(canvasId, { appearance: { icon: "flag", color: "emerald" } }))
      .rejects.toMatchObject({ code: "canvas_not_found" });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [MEMBER] } });
    const creator = await connect(CREATOR);
    const before = clientCanvasRows(creator.frames).find((row) => row.id === canvasId);
    expect(before?.appearance).toEqual({ icon: null, color: null });
    const chosen = await new CanvasService(TEST_ENV, auth(MEMBER)).update(canvasId, { appearance: { icon: "flag", color: "emerald" } });
    expect(chosen.appearance).toEqual({ icon: "flag", color: "emerald" });
    // A second person's colour leaves the first person's icon as it was.
    await new CanvasService(TEST_ENV, auth(CREATOR)).update(canvasId, { appearance: { color: "orange" } });
    expect((await new CanvasService(TEST_ENV, auth(MEMBER)).detail(canvasId)).appearance).toEqual({ icon: "flag", color: "orange" });
    await expect.poll(() => clientCanvasRows(creator.frames).find((row) => row.id === canvasId)?.appearance, { timeout: waitBudget() })
      .toEqual({ icon: "flag", color: "orange" });
    // Not activity: the Canvas keeps its place in the recency list, and its title.
    const after = clientCanvasRows(creator.frames).find((row) => row.id === canvasId);
    expect(after).toMatchObject({ title: "Launch plan", updatedAt: before?.updatedAt });
    creator.socket.close(1000, "done");
  });

  it("reads a stored appearance that no longer parses as unchosen, without failing the list, and lets the next choice repair it", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    // A key no catalog stores, as a later catalog could leave behind.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET appearance_json = ? WHERE canvas_id = ?`,
        JSON.stringify({ icon: "retired-glyph", color: "orange" }), canvasId);
    });
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    expect((await service.detail(canvasId)).appearance).toEqual({ icon: null, color: null });
    const rows = await runInDurableObject(workspace(), (_instance, state) =>
      canvasSidebarRows(state.storage.sql, { userId: CREATOR, member: true }, new Map(), 50, () => undefined));
    expect(rows.find((row) => row.id === canvasId)?.appearance).toEqual({ icon: null, color: null });
    const repaired = await service.update(canvasId, { appearance: { color: "blue" } });
    expect(repaired.appearance).toEqual({ icon: null, color: "blue" });
  });

  it("ends a reply being streamed at its next chunk when a person stops it, as a stopped response", async () => {
    held.firstPartSent = false;
    held.released = false;
    held.finished = false;
    try {
      const { canvasId } = await new CanvasService(TEST_ENV, auth(CREATOR)).create({
        title: "Story", prompt: { text: LONG_REPLY_PROMPT, clientMessageId: "canvas-stop-1" },
      });
      const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
      await expect.poll(() => held.firstPartSent, { timeout: waitBudget() }).toBe(true);
      await expect.poll(() => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM substream_loops WHERE id = 1`).one().status), { timeout: waitBudget() }).toBe("executing");
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
      await expect.poll(statuses, { timeout: waitBudget() }).toEqual(["assistant_turn_stopped"]);
      await expect.poll(() => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM substream_loops WHERE id = 1`).one().status), { timeout: waitBudget() }).toBe("idle");
      const accepted = await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM transcript_payloads`).toArray().map((row) => row.payload_json).join("\n"));
      expect(accepted).not.toContain("THE END");
    } finally {
      held.released = true;
      held.finished = true;
    }
  });

  it("archives a streaming Chat, fences its member run, and stops the active loop", async () => {
    held.firstPartSent = false;
    held.released = false;
    held.finished = false;
    try {
      const { canvasId } = await new CanvasService(TEST_ENV, auth(CREATOR)).create({ title: "Story",
        prompt: { text: LONG_REPLY_PROMPT, clientMessageId: "canvas-archive-stream" } });
      const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
      await expect.poll(() => held.firstPartSent, { timeout: waitBudget() }).toBe(true);
      await runInDurableObject(chat, (_instance, state) => { state.storage.sql.exec(
        `INSERT INTO workstream_wakeups (wakeup_id, execution_principal_json, prompt, due_at, status,
          idempotency_key, version, created_at, updated_at) VALUES ('archive-timer', ?, 'Wake later', ?, 'pending', 'archive-timer', 1, 1, 1)`,
        JSON.stringify({ type: "user", userId: CREATOR }), Date.now() + 60_000); });
      // Hold the durable hand-off so the run-authority check must observe the
      // parent tombstone, before the child receives its local archive fence.
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec(`CREATE TRIGGER hold_canvas_archive_delivery AFTER INSERT ON _internal_durable_alarms
          WHEN NEW.kind = 'canvas_archive_conversation' BEGIN
          UPDATE _internal_durable_alarms SET retry_at = ${Date.now() + 60_000}
           WHERE kind = NEW.kind AND alarm_key = NEW.alarm_key; END`);
      });
      await new CanvasService(TEST_ENV, auth(CREATOR)).archive(canvasId);
      expect(await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ archived_at: number | null }>(
        "SELECT archived_at FROM workstream WHERE id = 1").one().archived_at)).toBeNull();
      await expect(__integrationTesting.assertRunAuthorityStillValid(TEST_ENV, {
        region: "global", workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: canvasId,
        loopId: `workstream:${canvasId}:substream:0:loop`, harnessRunId: asHarnessRunId(crypto.randomUUID()), triggerMessageId: null,
        activityId: null, executionPrincipal: { type: "user", userId: CREATOR }, reason: "human_message",
      })).rejects.toThrow(/no longer active/u);
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER hold_canvas_archive_delivery");
        state.storage.sql.exec("UPDATE _internal_durable_alarms SET retry_at = 0 WHERE kind = 'canvas_archive_conversation'");
      });
      await runDurableObjectAlarm(workspace());
      await expect.poll(() => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ archived_at: number | null }>(
        "SELECT archived_at FROM workstream WHERE id = 1").one().archived_at), { timeout: waitBudget() }).not.toBeNull();
      expect(await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM workstream_wakeups WHERE wakeup_id = 'archive-timer'").one().status)).toBe("cancelled");
      held.released = true;
      await expect.poll(() => runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM substream_loops WHERE id = 1").one().status), { timeout: waitBudget() }).toBe("idle");
      const transcript = await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM transcript_payloads").toArray().map((row) => row.payload_json).join("\n"));
      expect(transcript).toContain("assistant_turn_stopped");
      expect(transcript).not.toContain("THE END");
      expect(await workspace().canvasContext({ workspaceId: WORKSPACE_ID, canvasId })).toBeNull();
    } finally { held.released = true; held.finished = true; }
  });

  it("titles a Canvas made with no title from its opening message, on every open list", () => withNamingModel(async () => {
    const creator = await connect(CREATOR);
    const { canvasId } = await new CanvasService(TEST_ENV, auth(CREATOR)).create({
      prompt: { text: "Plan the December pricing launch: owners, dates, and what gates the announcement.", clientMessageId: "canvas-name-1" },
    });
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    // Until its first message reaches the Canvas, it is untitled and settled, not naming.
    expect(await service.detail(canvasId)).toMatchObject({ title: "Untitled Canvas", titleStatus: "settled" });
    // The Chat's first message reaches the Canvas's parent, which names it by an alarm of its own.
    await deliverChildEffects(TEST_ENV, env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, canvasId))));
    await expect.poll(async () => (await service.detail(canvasId)).titleStatus, { timeout: waitBudget() }).toBe("settled");
    expect(await service.detail(canvasId)).toMatchObject({ title: "December pricing launch", appearance: { icon: "rocket", color: null } });
    await expect.poll(() => clientCanvasRows(creator.frames).find((row) => row.id === canvasId)?.title, { timeout: waitBudget() })
      .toBe("December pricing launch");
    const naming = provider.calls.filter(namingCall);
    expect(naming).toHaveLength(1);
    expect(JSON.stringify(naming[0]!.messages)).toContain("Plan the December pricing launch");
    creator.socket.close(1000, "done");
  }));

  it("keeps an icon and colour chosen while the naming pass waits on the model", () => withNamingModel(async () => {
    Object.assign(naming, { holding: true, asked: false, released: false });
    try {
      const { canvasId } = await new CanvasService(TEST_ENV, auth(CREATOR)).create({
        prompt: { text: "Plan the December pricing launch.", clientMessageId: "canvas-name-held" },
      });
      const service = new CanvasService(TEST_ENV, auth(CREATOR));
      await deliverChildEffects(TEST_ENV, env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, canvasId))));
      await expect.poll(() => naming.asked, { timeout: waitBudget() }).toBe(true);
      // A person dresses the Canvas while the model is still answering.
      await service.update(canvasId, { appearance: { icon: "flag", color: "orange" } });
      naming.released = true;
      await expect.poll(async () => (await service.detail(canvasId)).titleStatus, { timeout: waitBudget() }).toBe("settled");
      expect(await service.detail(canvasId)).toMatchObject({
        title: "December pricing launch", appearance: { icon: "flag", color: "orange" },
      });
    } finally {
      Object.assign(naming, { holding: false, released: true });
    }
  }));

  it("keeps the title when the model names an icon off the menu", () => withNamingModel(async () => {
    naming.icon = "not-an-icon";
    try {
      const { canvasId } = await new CanvasService(TEST_ENV, auth(CREATOR)).create({
        prompt: { text: "Plan the December pricing launch.", clientMessageId: "canvas-name-off-menu" },
      });
      const service = new CanvasService(TEST_ENV, auth(CREATOR));
      await deliverChildEffects(TEST_ENV, env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName("global", WORKSPACE_ID, canvasId))));
      await expect.poll(async () => (await service.detail(canvasId)).titleStatus, { timeout: waitBudget() }).toBe("settled");
      expect(await service.detail(canvasId)).toMatchObject({
        title: "December pricing launch", appearance: { icon: null, color: null },
      });
    } finally {
      naming.icon = "rocket";
    }
  }));

  it("waits on an opening of attachments alone, then titles from a person's text and never from Rally's reply", () => withNamingModel(async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const { canvasId } = await service.create({});
    const routed = await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, canvasId, "canvas");
    const transcript = createTranscriptObjectPort(routed, WORKSPACE_ID, canvasId);
    const chat = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", WORKSPACE_ID, canvasId)));
    const say = async (actor: "human" | "assistant", text: string) => {
      const sequence = await runInDurableObject(chat, (_instance, state) => state.storage.sql.exec<{ next: number }>(
        `SELECT next_transcript_sequence AS next FROM transcript_counters WHERE id = 1`).one().next);
      await seedChatMessage(transcript, sequence, actor, text, new Date().toISOString());
    };
    /** Run the naming entry, as the Chat's next message would arm it, and wait for it to be done. */
    const name = async () => {
      await runInDurableObject(workspace(), async (_instance, state) => {
        const now = Date.now();
        state.storage.sql.exec(`INSERT OR REPLACE INTO _internal_durable_alarms (kind, alarm_key, due_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`, CANVAS_NAMING_ALARM_KIND, canvasId, now, now, now);
        await state.storage.setAlarm(now);
      });
      await expect.poll(() => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
        `SELECT 1 FROM _internal_durable_alarms WHERE kind = ? AND alarm_key = ?`, CANVAS_NAMING_ALARM_KIND, canvasId)
        .toArray().length), { timeout: waitBudget() }).toBe(0);
    };
    // An empty Canvas is untitled and settled, and an empty Chat is not activity.
    const created = await service.detail(canvasId);
    expect(created).toMatchObject({ title: "Untitled Canvas", titleStatus: "settled" });
    await deliverChildEffects(TEST_ENV, chat);
    expect((await service.detail(canvasId)).updatedAt).toBe(created.updatedAt);
    // The person's opening carried attachments and no text; Rally answered it.
    await say("human", "");
    // Its first message starts naming it. A seeded turn writes no projection
    // of its own, so the Chat sends the one a message's write would.
    await runInDurableObject(chat, (instance) => (instance as unknown as {
      product: { enqueueDirectorySnapshot(): Promise<void> } }).product.enqueueDirectorySnapshot());
    await deliverChildEffects(TEST_ENV, chat);
    expect(await service.detail(canvasId)).toMatchObject({ title: "Untitled Canvas", titleStatus: "naming" });
    await say("assistant", "Here is the plan.");
    await name();
    expect(await service.detail(canvasId)).toMatchObject({ title: "Untitled Canvas", titleStatus: "naming" });
    expect(provider.calls.filter(namingCall)).toEqual([]);

    // An icon somebody chose before the pass ran is theirs to keep.
    await service.update(canvasId, { appearance: { icon: "flag" } });
    await say("human", "Plan the December pricing launch.");
    await name();
    expect(await service.detail(canvasId)).toMatchObject({
      title: "December pricing launch", titleStatus: "settled", appearance: { icon: "flag", color: null },
    });
    const naming = provider.calls.filter(namingCall);
    expect(naming).toHaveLength(1);
    expect(JSON.stringify(naming[0]!.messages)).toContain("Plan the December pricing launch.");
    expect(JSON.stringify(naming[0]!.messages)).not.toContain("Here is the plan.");
  }));

  it("keeps a person's title over the one its opening message would give it", () => withNamingModel(async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const { canvasId } = await service.create({});
    await service.update(canvasId, { title: "Mine" });
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

  it("never starts naming a Canvas a Sidekick run writes, even untitled", () => withNamingModel(async () => {
    const service = new CanvasService(TEST_ENV, auth(CREATOR));
    const { canvasId } = await service.create({});
    // As a run's Canvas is: its writer named on the row.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET writer_sidekick_id = ?, writer_run_id = ? WHERE canvas_id = ?`,
        crypto.randomUUID(), crypto.randomUUID(), canvasId);
    });
    const client = await new ConversationService(TEST_ENV, auth(CREATOR)).writableClient(canvasId, "0");
    await client.createMessage({ text: "Plan the December pricing launch.", clientMessageId: "canvas-name-3",
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
    await deliverChildEffects(TEST_ENV, env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, canvasId))));
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ title: string; title_status: string }>(
      `SELECT title, title_status FROM canvas_directory WHERE canvas_id = ?`, canvasId).one()))
      .toEqual({ title: "Untitled Canvas", title_status: "settled" });
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
    await expect.poll(() => [position(third), position(first), position(second)], { timeout: waitBudget() }).toEqual([0, 1, 2]);
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
  async function publish(canvasId: string, filePath: string, text: string, replaceCanvasArtifact?: boolean) {
    return canvasBridge(canvasId).publishResource(toolContext(canvasId),
      { filePath, ...(replaceCanvasArtifact === undefined ? {} : { replaceCanvasArtifact }) }, new TextEncoder().encode(text));
  }

  async function backgroundBridge(canvasId: string) {
    const substreamId = asSubstreamId(crypto.randomUUID());
    await workspace().reserveChild({
      workspaceId: WORKSPACE_ID, parentId: canvasId, substreamId, kind: "child",
      createdByUserId: CREATOR, authorityGeneration: 1,
    });
    const producer = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, canvasId, substreamId),
    ));
    expect((await producer.bootstrapRuntime({
      workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: canvasId, substreamId, generation: 1,
    })).status).toBe(200);

    const bridge = createTerminalResourceBridge(
      withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID),
      createTerminalPortFactory(TEST_ENV, undefined, "0"),
      async (input) => {
        const result = await producer.attachRuntimeResource(input);
        expect(result.status).toBe(200);
      },
      null, substreamId, null, "0",
      canvasArtifactNoter(TEST_ENV, { workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: canvasId, substreamId }),
    );
    return {
      bridge,
      resources: createResourceObjectPort(TEST_ENV, WORKSPACE_ID, canvasId, undefined, substreamId),
    };
  }

  it("makes a background agent's publication available in the Canvas Chat and to the producing agent", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const { bridge, resources } = await backgroundBridge(canvasId);
    const published = await bridge.publishResource(toolContext(canvasId),
      { filePath: "plan.md", displayName: "Background plan" }, new TextEncoder().encode("# Launch plan"));
    const detail = await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId);
    expect(detail.artifacts).toMatchObject([{ resourceId: published.resourceId, title: "Background plan" }]);
    const conversations = new ConversationService(TEST_ENV, auth(CREATOR));
    const chat = await conversations.client(canvasId, true);
    expect((await chat.boot()).workstream.resources).toMatchObject([
      { id: published.resourceId, title: "Background plan", direction: "artifact" },
    ]);
    expect(await resources.isAttached({ resourceId: published.resourceId })).toBe(true);
  });

  it.each(["file", "site"] as const)("links an identical %s publication to its second producer", async (kind) => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const first = await backgroundBridge(canvasId);
    const second = await backgroundBridge(canvasId);
    const bytes = new TextEncoder().encode("<h1>Launch plan</h1>");
    const sha256 = await sha256Hex(bytes);
    const publishFrom = (bridge: typeof first.bridge) => kind === "site"
      ? bridge.publishSiteResource(toolContext(canvasId), { filePath: "launch" }, {
        mode: "static", stateful: false, serverModuleSha256: null,
        files: [{ path: "index.html", bytes, sha256 }],
      })
      : bridge.publishResource(toolContext(canvasId), { filePath: "launch.html" }, bytes);

    const published = await publishFrom(first.bridge);
    const retry = await publishFrom(second.bridge);
    expect(retry.resourceId).toBe(published.resourceId);
    expect((await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId)).artifacts).toMatchObject([
      { resourceId: published.resourceId, version: 1 },
    ]);
    expect(await second.resources.isAttached({ resourceId: published.resourceId })).toBe(true);
  });

  it("keeps a background agent's internal capture out of the Canvas Chat", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const { bridge, resources } = await backgroundBridge(canvasId);
    const context = toolContext(canvasId);
    const log = await bridge.publishResource(context, {
      filePath: ".rally/logs/command.log",
      providerResourceId: `terminal-command-log:${context.effectIntentId}`,
    }, new TextEncoder().encode("Internal command output"));

    const chat = await new ConversationService(TEST_ENV, auth(CREATOR)).client(canvasId, true);
    expect((await chat.boot()).workstream.resources).toEqual([]);
    expect((await new CanvasService(TEST_ENV, auth(CREATOR)).detail(canvasId)).artifacts).toEqual([]);
    expect(await resources.isAttached({ resourceId: log.resourceId })).toBe(true);
  });

  it("opens a Canvas whose Organization keeps a retired connector's disabled connection, without listing it", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const RETIRED = "00000000-0000-7000-8000-0000000cb0a1";
    const LIVE = "00000000-0000-7000-8000-0000000cb0a2";
    await runInDurableObject(workspace(), (_instance, state) => {
      const insert = (id: string, status: string, pluginId: string) => state.storage.sql.exec(
        `INSERT INTO connector_connections (id, workspace_id, connector_type, scope, owner_user_id, display_name,
           granted_scopes_json, status, created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'github', 'workspace', NULL, ?, '[]', ?, ?, ?, ?)`,
        id, WORKSPACE_ID, `${pluginId} fixture`, status, NOW, NOW, pluginId);
      insert(RETIRED, "disabled", "plugin_retired_webhook");
      insert(LIVE, "healthy", "plugin_live_github");
      // Retirement refuses a new row of the type and a revival, not this: a
      // disabled row of a type the contract no longer names, as 154 left one.
      state.storage.sql.exec(`UPDATE connector_connections SET connector_type = 'generic_webhook' WHERE id = ?`, RETIRED);
    });
    const chat = await new ConversationService(TEST_ENV, auth(CREATOR)).client(canvasId, true);
    expect((await chat.boot()).workstream.connections.map((connection) => connection.id)).toEqual([LIVE]);
  });

  it("pushes stored-data status from listed database-backed artifacts, independently of the newest artifact or presence", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const { canvasId: otherCanvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const creator = await connect(CREATOR);
    const status = () => clientCanvasRows(creator.frames).find((row) => row.id === canvasId)!;
    expect(status().hasStoredData).toBe(false);

    const resourceId = crypto.randomUUID();
    const otherResourceId = crypto.randomUUID();
    // Registry rows live beside Canvas links in WorkspaceDO. These fixtures
    // distinguish a static site here from a database-backed site elsewhere.
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const [id, parentId, stateful] of [[resourceId, canvasId, 0], [otherResourceId, otherCanvasId, 1]] as const) {
        state.storage.sql.exec(`INSERT INTO resources
          (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
          VALUES (?, ?, 'generated_site', 'avalon_generated', 'Tracker', '{}', 'attached', ?, ?)`, id, WORKSPACE_ID, NOW, NOW);
        state.storage.sql.exec(`INSERT INTO artifact_registry
          (artifact_id, workspace_id, workstream_id, resource_id, mode, stateful, current_version, manifest_ref, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, 1, 'fixture-manifest', 1, 1)`, crypto.randomUUID(), WORKSPACE_ID, parentId, id, stateful);
      }
    });
    const note = (id: string, parentId = canvasId) => workspace().canvasNoteArtifact({
      workspaceId: WORKSPACE_ID, canvasId: parentId, resourceId: id, editor: { kind: "rally", id: null },
    });
    await note(otherResourceId, otherCanvasId);
    await note(resourceId);
    await expect.poll(() => status(), { timeout: waitBudget() }).toMatchObject({ artifactKind: "site", hasStoredData: false });

    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE artifact_registry SET stateful = 1 WHERE resource_id = ?`, resourceId);
    });
    await note(resourceId);
    await expect.poll(() => status().hasStoredData, { timeout: waitBudget() }).toBe(true);
    // A newer file beside it, as a Canvas converted from a Thread may hold;
    // a Chat's publish can no longer add one. The site's note pushes the row.
    await runInDurableObject(workspace(), (_instance, state) => {
      const notesId = crypto.randomUUID();
      const later = new Date(Date.parse(NOW) + 60_000).toISOString();
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'generated_file', 'avalon_generated', 'Tracker notes', 'text/markdown', '{}', 'attached', ?, ?)`,
      notesId, WORKSPACE_ID, later, later);
      state.storage.sql.exec(`INSERT INTO canvas_artifacts (canvas_id, resource_id, added_at) VALUES (?, ?, 1)`, canvasId, notesId);
    });
    await note(resourceId);
    await expect.poll(() => status(), { timeout: waitBudget() }).toMatchObject({ artifactKind: "file", hasStoredData: true, presentUserIds: [] });

    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE resources SET metadata_json = ? WHERE id = ?`, JSON.stringify({ listing: "unlisted" }), resourceId);
    });
    await note(resourceId);
    await expect.poll(() => status().hasStoredData, { timeout: waitBudget() }).toBe(false);
    creator.socket.close(1000, "done");
  });

  it("notes a publish recovered after its attempt died before the note", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const attemptStartedAt = Date.now() - 1_000;
    const context = toolContext(canvasId);
    const published = await canvasBridge(canvasId, false)
      .publishResource(context, { filePath: "plan.md" }, new TextEncoder().encode("# Launch plan"));
    const detail = () => workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" } });
    expect((await detail()).artifacts).toEqual([]);
    // The attempt died before its note, so it never became the Canvas's and has no link.
    expect("url" in published).toBe(false);
    const recovered = await canvasBridge(canvasId).reconcilePublishedResource({ ...context, attemptStartedAt }, { filePath: "plan.md" });
    expect(recovered.outcome).toBe("landed");
    expect((await detail()).artifacts).toMatchObject([{ resourceId: published.resourceId, version: 1 }]);
    // Recovered and noted, it is the Canvas's file, and its link is the host reserved for it.
    const output = recovered.outcome === "landed" ? recovered.result.output as { url?: string } : {};
    const url = output.url ?? null;
    const route = await env.PLATFORM_DB.prepare("SELECT hostname_stub FROM artifact_hostname_routes WHERE artifact_id = ?")
      .bind(published.resourceId).first<{ hostname_stub: string }>();
    expect(route).not.toBeNull();
    expect(url).toContain(route!.hostname_stub);
  });

  it("keeps a replacement's intent when it recovers a publish whose attempt died before the note", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const first = await publish(canvasId, "plan.md", "# Launch plan");
    const attemptStartedAt = Date.now() - 1_000;
    const context = toolContext(canvasId);
    const input = { filePath: "budget.csv", replaceCanvasArtifact: true };
    const replacement = await canvasBridge(canvasId, false).publishResource(context, input, new TextEncoder().encode("line,amount"));
    const detail = () => workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" } });
    expect((await detail()).artifacts.map((artifact) => artifact.resourceId)).toEqual([first.resourceId]);
    expect((await canvasBridge(canvasId).reconcilePublishedResource({ ...context, attemptStartedAt }, input)).outcome).toBe("landed");
    expect((await detail()).artifacts.map((artifact) => artifact.resourceId)).toEqual([replacement.resourceId]);
  });

  it("makes the first publish version 1 by Rally, a republish of the path a new version, and another path its artifact only as a replacement", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const detail = () => workspace().canvasDetail({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: CREATOR, actorRole: "member" } });
    const first = await publish(canvasId, "plan.md", "# Launch plan");
    expect(await detail()).toMatchObject({ lastEditor: { kind: "rally", id: null },
      artifacts: [{ resourceId: first.resourceId, kind: "file", version: 1 }] });
    const again = await publish(canvasId, "plan.md", "# Launch plan, revised");
    expect(again.resourceId).toBe(first.resourceId);
    expect((await detail()).artifacts).toMatchObject([{ resourceId: first.resourceId, version: 2 }]);
    await expect(publish(canvasId, "budget.csv", "line,amount")).rejects.toMatchObject({ code: "canvas_artifact_held" });
    expect((await detail()).artifacts.map((artifact) => artifact.resourceId)).toEqual([first.resourceId]);
    const other = await publish(canvasId, "budget.csv", "line,amount", true);
    expect((await detail()).artifacts.map((artifact) => artifact.resourceId)).toEqual([other.resourceId]);
    // The replaced plan keeps its resource; it is no longer the Canvas's.
    await expect(publish(canvasId, "plan.md", "# Launch plan, third")).rejects.toMatchObject({ code: "canvas_artifact_held" });
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
      canvasSidebarRows(state.storage.sql, { userId, member: true }, new Map(), 50, () => undefined).find((row) => row.id === canvasId)?.unread);
    expect(await unread(MEMBER)).toBe(true);
    expect(await unread(CREATOR)).toBe(false);
  });

  it("names on the Canvas list the Sidekick run whose publish made the newest version, until a later one from its Chat", async () => {
    const sidekickId = crypto.randomUUID();
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId,
      madeInCanvasId: canvasId });
    // Three runs, oldest first: the third is run #3.
    const runIds = ["00000000-0000-7000-8000-0000000cbf01", "00000000-0000-7000-8000-0000000cbf02", "00000000-0000-7000-8000-0000000cbf03"];
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE automation_directory SET title = 'Weekly digest' WHERE automation_id = ?`, sidekickId);
      runIds.forEach((runId, index) => state.storage.sql.exec(`INSERT INTO sidekick_runs(sidekick_id, run_id, occurrence_key,
          trigger_json, definition_revision, harness_run_id, state, summary, opening_json, run_as_user_id,
          coordinator_user_id, created_at, started_at, completed_at, updated_at)
        VALUES (?, ?, ?, '{"kind":"manual"}', 1, ?, 'completed', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
        sidekickId, runId, `run:${runId}`, `${runId}-harness`, CREATOR, CREATOR, index + 1, index + 1, index + 1, index + 1));
    });
    const run = { workspaceId: WORKSPACE_ID, parentKind: "automation" as const, parentId: sidekickId,
      substreamId: asSubstreamId(runIds[2]!), executionPrincipal: { type: "user" as const, userId: CREATOR } };
    const home = (await resolveTerminalPublicationHome(TEST_ENV, run))!;
    expect(home).toEqual({ parentId: canvasId, substreamId: "0" });
    const lastWrittenBy = async () => (await runInDurableObject(workspace(), (_instance, state) =>
      canvasSidebarRows(state.storage.sql, { userId: CREATOR, member: true }, new Map(), 50, () => undefined)))
      .find((row) => row.id === canvasId)?.lastWrittenBy;
    // A version of its artifact, noted as run #3's publish notes it.
    const { resourceId } = await publish(canvasId, "digest.md", "# Digest");
    expect(await lastWrittenBy()).toBeNull();
    // A worker run #3 started publishes where run #3 does, and notes as run #3.
    const worker = { ...run, substreamId: asSubstreamId(crypto.randomUUID()), backgroundAgent: true,
      backgroundAgentRootSubstreamId: runIds[2]!, automationDelegation: { runId: runIds[2]!, stopGeneration: 0 } };
    expect(await resolveTerminalPublicationHome(TEST_ENV, worker)).toEqual(home);
    await canvasArtifactNoter(TEST_ENV, worker)!(home, resourceId, false);
    expect(await lastWrittenBy()).toEqual({ sidekickId, runId: runIds[2], runNumber: 3, sidekickName: "Weekly digest" });
    // An agent the wizard started publishes nowhere, as the wizard.
    expect(await resolveTerminalPublicationHome(TEST_ENV, { ...run, substreamId: asSubstreamId(crypto.randomUUID()),
      backgroundAgent: true, backgroundAgentRootSubstreamId: "0" })).toBeNull();
    await canvasArtifactNoter(TEST_ENV, run)!(home, resourceId, false);
    expect(await lastWrittenBy()).toEqual({ sidekickId, runId: runIds[2], runNumber: 3, sidekickName: "Weekly digest" });
    // A deleted Sidekick's run is no run to open.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE automation_directory SET lifecycle = 'deleted' WHERE automation_id = ?`, sidekickId);
    });
    expect(await lastWrittenBy()).toBeNull();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE automation_directory SET lifecycle = 'active' WHERE automation_id = ?`, sidekickId);
    });
    // A later version from its Chat, which a person asks for, is no run's.
    await publish(canvasId, "digest.md", "# Digest, revised");
    expect(await lastWrittenBy()).toBeNull();
  });

  it("returns no link for a file a Sidekick's own agent publishes, which lands in no Canvas", async () => {
    const sidekickId = crypto.randomUUID();
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId });
    // An agent the wizard started: its publications have no Canvas home.
    const agent = { workspaceId: WORKSPACE_ID, parentKind: "automation" as const, parentId: sidekickId,
      substreamId: asSubstreamId(crypto.randomUUID()), executionPrincipal: { type: "user" as const, userId: CREATOR } };
    const bridge = createTerminalResourceBridge(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID),
      createTerminalPortFactory(TEST_ENV, undefined, "0"), undefined, () => Promise.resolve(null), null, null, "0",
      canvasArtifactNoter(TEST_ENV, agent));
    const published = await bridge.publishResource({ ...toolContext(sidekickId) }, { filePath: "notes.md" },
      new TextEncoder().encode("# Notes"));
    expect(published.publishKind).toBe("file");
    expect("url" in published).toBe(false);
    expect(await env.PLATFORM_DB.prepare("SELECT hostname_stub FROM artifact_hostname_routes WHERE artifact_id = ?")
      .bind(published.resourceId).first()).toBeNull();
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

  it("refuses an archived Sidekick publication home for both explicit and implicit selection", async () => {
    const sidekickId = crypto.randomUUID();
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId,
      madeInCanvasId: canvasId });
    const run = { workspaceId: WORKSPACE_ID, parentKind: "automation" as const, parentId: sidekickId,
      substreamId: asSubstreamId(crypto.randomUUID()), executionPrincipal: { type: "user" as const, userId: CREATOR } };
    await new CanvasService(TEST_ENV, auth(CREATOR)).archive(canvasId);
    await expect(resolveTerminalPublicationHome(TEST_ENV, run)).rejects.toMatchObject({ code: "canvas_archived" });
    await expect(resolveTerminalPublicationHome(TEST_ENV, run, { canvas: canvasId })).rejects.toMatchObject({ code: "canvas_archived" });
  });

  it("publishes a run that names no Canvas into the one its Sidekick was made in, and never makes a Canvas", async () => {
    const canvasCount = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM canvas_directory`).one().count);
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    const madeHere = crypto.randomUUID();
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: madeHere,
      madeInCanvasId: canvasId });
    const elsewhere = crypto.randomUUID();
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: elsewhere });
    const runOf = (parentId: string) => ({ workspaceId: WORKSPACE_ID, parentKind: "automation" as const, parentId,
      substreamId: asSubstreamId(crypto.randomUUID()), executionPrincipal: { type: "user" as const, userId: CREATOR } });
    const before = await canvasCount();
    expect(await resolveTerminalPublicationHome(TEST_ENV, runOf(madeHere))).toEqual({ parentId: canvasId, substreamId: "0" });
    // A run a schedule started acts as the Sidekick itself and lands there too.
    const scheduled = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO sidekick_runs(sidekick_id, run_id, occurrence_key, trigger_json, definition_revision,
          harness_run_id, state, run_as_user_id, coordinator_user_id, requester_user_id, created_at, updated_at)
        VALUES (?, ?, ?, '{"kind":"schedule"}', 1, ?, 'running', ?, ?, NULL, 1, 1)`,
      madeHere, scheduled, `run:${scheduled}`, `${scheduled}-harness`, CREATOR, CREATOR);
    });
    expect(await resolveTerminalPublicationHome(TEST_ENV, { ...runOf(madeHere), substreamId: asSubstreamId(scheduled),
      executionPrincipal: { type: "workspace" as const, workspaceId: WORKSPACE_ID } })).toEqual({ parentId: canvasId, substreamId: "0" });
    // A Sidekick made outside any Canvas has nowhere implicit to publish.
    await expect(resolveTerminalPublicationHome(TEST_ENV, runOf(elsewhere)))
      .rejects.toMatchObject({ code: "canvas_required", details: { field: "canvas" } });
    expect(await canvasCount()).toBe(before);
    // Naming a Canvas attached to it still works.
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, automationId: elsewhere, userId: CREATOR, reference: canvasId });
    expect(await resolveTerminalPublicationHome(TEST_ENV, runOf(elsewhere), { canvas: canvasId })).toEqual({ parentId: canvasId, substreamId: "0" });
  });

  it("opens a Canvas a Sidekick writes to whoever the Sidekick is shared with, and publishes a run only into a Canvas attached to it", async () => {
    const sidekickId = crypto.randomUUID();
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId });
    await workspace().sidekickSetAudience({ workspaceId: WORKSPACE_ID, automationId: sidekickId,
      actor: { userId: CREATOR, actorRole: "member", participantOfOwningWorkstream: false },
      update: { audience: "people", userIds: [MEMBER] } });
    const runId = crypto.randomUUID();
    const run = { workspaceId: WORKSPACE_ID, parentKind: "automation" as const, parentId: sidekickId,
      substreamId: asSubstreamId(runId), executionPrincipal: { type: "user" as const, userId: CREATOR } };
    const canvasId = await writtenCanvas(sidekickId, "Weekly report");
    expect(await resolveTerminalPublicationHome(TEST_ENV, run, { canvas: canvasId })).toEqual({ parentId: canvasId, substreamId: "0" });
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
    // A Canvas not attached to the Sidekick cannot be named; once its
    // configuration conversation attaches it, a person's own Canvas can.
    const { canvasId: elsewhere } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
    await expect(resolveTerminalPublicationHome(TEST_ENV, run, { canvas: elsewhere }))
      .rejects.toMatchObject({ code: "canvas_not_attached_to_sidekick" });
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, automationId: sidekickId, userId: CREATOR, reference: elsewhere });
    expect(await resolveTerminalPublicationHome(TEST_ENV, run, { canvas: elsewhere })).toEqual({ parentId: elsewhere, substreamId: "0" });
  });

  it("still pushes a writer Sidekick's Canvas when an audience change rolled back once and then committed", async () => {
    const sidekickId = crypto.randomUUID();
    const actor = { userId: CREATOR, actorRole: "member" as const, participantOfOwningWorkstream: false };
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId });
    const canvasId = await writtenCanvas(sidekickId, "Weekly report");
    const member = await connect(MEMBER);
    try {
      const update = { workspaceId: WORKSPACE_ID, automationId: sidekickId, actor, update: { audience: "people" as const, userIds: [MEMBER] } };
      // The write fails after it has told the host its readers, inside its
      // transaction, as a later statement's throw would: the audience rolls back.
      const failed = await runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
        const target = instance as unknown as { hostedSidekickHost: () => { noteWriterReaders: (id: string, readers: string) => void } };
        const original = target.hostedSidekickHost.bind(target);
        target.hostedSidekickHost = () => {
          const host = original();
          return { ...host, noteWriterReaders: (id: string, readers: string) => {
            host.noteWriterReaders(id, readers);
            throw new Error("injected_after_touch");
          } };
        };
        try {
          return await instance.sidekickSetAudience(update).then(() => null, (error: unknown) => (error as Error).message);
        } finally {
          target.hostedSidekickHost = original;
        }
      });
      expect(failed).toBe("injected_after_touch");
      expect(clientCanvasRows(member.frames).map((row) => row.id)).not.toContain(canvasId);
      // The same change, committed now, reaches the member's open list.
      await workspace().sidekickSetAudience(update);
      await expect.poll(() => clientCanvasRows(member.frames).map((row) => row.id), { timeout: waitBudget() }).toContain(canvasId);
    } finally {
      member.socket.close(1000, "done");
    }
  });

  it("puts a Canvas a Sidekick writes on the open list of whoever its audience change admits, and takes it off whoever it drops or its archive", async () => {
    const sidekickId = crypto.randomUUID();
    const actor = { userId: CREATOR, actorRole: "member" as const, participantOfOwningWorkstream: false };
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "personal", automationId: sidekickId });
    const canvasId = await writtenCanvas(sidekickId, "Weekly report");
    const member = await connect(MEMBER);
    try {
      expect(clientCanvasRows(member.frames).map((row) => row.id)).not.toContain(canvasId);
      await workspace().sidekickSetAudience({ workspaceId: WORKSPACE_ID, automationId: sidekickId, actor,
        update: { audience: "people", userIds: [MEMBER] } });
      await expect.poll(() => clientCanvasRows(member.frames).map((row) => row.id), { timeout: waitBudget() }).toContain(canvasId);
      await workspace().sidekickSetAudience({ workspaceId: WORKSPACE_ID, automationId: sidekickId, actor,
        update: { audience: "personal", userIds: [] } });
      await expect.poll(() => clientCanvasRows(member.frames).map((row) => row.id), { timeout: waitBudget() }).not.toContain(canvasId);
      // Archiving moves the same rule: its Canvas leaves an admitted reader's open list.
      await workspace().sidekickSetAudience({ workspaceId: WORKSPACE_ID, automationId: sidekickId, actor,
        update: { audience: "people", userIds: [MEMBER] } });
      await expect.poll(() => clientCanvasRows(member.frames).map((row) => row.id), { timeout: waitBudget() }).toContain(canvasId);
      await workspace().sidekickRemove({ workspaceId: WORKSPACE_ID, automationId: sidekickId, actor });
      await expect.poll(() => clientCanvasRows(member.frames).map((row) => row.id), { timeout: waitBudget() }).not.toContain(canvasId);
    } finally {
      member.socket.close(1000, "done");
    }
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
    await expect.poll(() => provider.calls.length, { timeout: waitBudget() }).toBeGreaterThan(0);
    const call = provider.calls.find((candidate) => candidate.messages.some((message) =>
      typeof message.content === "string" && message.content.startsWith("CANVAS CONTEXT")))!;
    const context = call.messages.find((message) => typeof message.content === "string" && message.content.startsWith("CANVAS CONTEXT"))!;
    expect(JSON.parse(String(context.content).replace(/^CANVAS CONTEXT \(host-provided\):\n/u, ""))).toMatchObject({
      canvasId, title: "Launch plan", artifacts: [{ resourceId, title: "plan.md", kind: "file", version: 1 }],
    });
    expect(call.toolNames).toEqual(expect.arrayContaining(["list_resources", "read_resource"]));
    // The run read its memory digest, so the Organization records the Chat as
    // a holder of a copy; a `canvas` holder is admitted (WorkspaceDO migration 137).
    await expect.poll(() => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT parent_kind, parent_id, substream_id FROM memory_digest_holders WHERE parent_id = ?", canvasId,
    ).toArray()), { timeout: waitBudget() }).toEqual([{ parent_kind: "canvas", parent_id: canvasId, substream_id: "0" }]);
  });
});

