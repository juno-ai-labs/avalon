/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A conversation import, end to end on real objects: the Channel is reserved,
 * the agent runs in a hidden child of it under the `session_import` profile,
 * every browser step is a desktop action this test answers over the child's
 * real socket, and the result opens the Channel with the imported history.
 *
 * The model is the provider double; the desktop is this test. What is real is
 * everything between: the reservation, the child's provisioning and loop, the
 * durable action rows, the socket, and the Channel's initialization.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSpaceId, asSubstreamId, asUserId, asWorkspaceId, type SpaceId } from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { SessionImportRunService } from "../src/services/session-import-run-service";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { LINK_PAYLOADS_TABLE } from "./helpers/link-payloads-table";
import { useOpenRouterDouble, type ProviderCall } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000cc0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000cc1");
const SESSION_ID = "00000000-0000-7000-8000-000000000cc2";
const CONVERSATION_ID = "0a1b2c3d-0000-4000-8000-00000000c0de";
const SOURCE_URL = `https://chatgpt.com/c/${CONVERSATION_ID}`;

const AUTH: AuthContext = { sessionId: SESSION_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, region: "global", role: "member" };

useSelectedModel();
/** The scripted agent: read the page, then finish with the stored messages. */
const provider = useOpenRouterDouble((call: ProviderCall) => {
  const toolResults = call.messages.filter((message) => message.role === "tool").length;
  if (toolResults === 0) return { callTool: { name: "browser_evaluate", arguments: { script: "return window.__probe" } } };
  if (toolResults === 1) return { callTool: { name: "import_finish", arguments: { title: "Garden irrigation", messages: "messages-handle" } } };
  return { say: "Imported." };
});

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function child(workstreamId: string, substreamId: string) {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, workstreamId, asSubstreamId(substreamId))));
}

function creationEnv(): Env {
  return new Proxy(env, {
    get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
      ? "workerd-test-email-address-key-0123456789"
      : Reflect.get(current, property, receiver),
  });
}

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: SESSION_ID });
  // The regional rows creation writes around the object calls, as in
  // `conversation-creation.test.ts`; columns follow packages/db/migrations.
  await env.DB.batch([
    env.DB.prepare(LINK_PAYLOADS_TABLE),
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'initialized', 'completed', 'failed')),
      message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

async function personalSpace(): Promise<SpaceId> {
  const reserved = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID, userId: USER_ID,
    space: { name: "Private", iconKey: "briefcase", colorKey: "blue", scope: "personal" },
  });
  if (!reserved.ok) throw new Error(`reserveSpace refused: ${reserved.code}`);
  return asSpaceId(reserved.space.id);
}

interface Frame { type: string; request?: { id: string; action: { kind: string } } }

/** Open the child's feed as its creator's desktop would, and collect its frames. */
async function openDesktop(workstreamId: string, substreamId: string, membershipVersion: number) {
  const response = await child(workstreamId, substreamId).fetch("https://substream.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-workstream-id": workstreamId,
      "x-rally-substream-id": substreamId,
      "x-rally-socket-admission-membership-version": String(membershipVersion),
      "x-rally-user-id": USER_ID,
      "x-rally-session-id": SESSION_ID,
      "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const frames: Frame[] = [];
  socket.addEventListener("message", (event) => {
    try { frames.push(JSON.parse(String(event.data)) as Frame); } catch { /* heartbeat */ }
  });
  socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0, publishPresence: false }));
  const answered = new Set<string>();
  /** The next desktop action of `kind` this desktop has not answered yet. */
  const nextAction = async (kind: string) => {
    let found: Frame["request"];
    await expect.poll(() => {
      found = frames.find((frame) => frame.type === "desktop_action_requested"
        && frame.request?.action.kind === kind && !answered.has(frame.request.id))?.request;
      return found ? "requested" : frames.map((frame) => frame.type).join(",");
    }, { timeout: 10_000, interval: 25 }).toBe("requested");
    answered.add(found!.id);
    return found!;
  };
  const answer = (id: string, outcome: unknown) =>
    socket.send(JSON.stringify({ type: "answer_desktop_action", actionId: id, outcome }));
  return { socket, frames, nextAction, answer };
}

describe("a conversation import run", () => {
  it("reads the page through the desktop and opens the Channel with what it read", async () => {
    const spaceId = await personalSpace();
    const clientMessageId = crypto.randomUUID();
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Garden irrigation", spaceIds: [spaceId], clientMessageId });

    // Reserved, not open: the Channel's own conversation refuses until the import completes.
    await expect(new WorkstreamObjectClient(creationEnv(), AUTH, run.workstreamId, "0").get()).rejects.toThrow();

    const admission = await workspace().authorizeViewer({
      workspaceId: WORKSPACE_ID, parentId: run.workstreamId, userId: USER_ID, substreamId: asSubstreamId(run.substreamId),
    });
    expect(admission.authorized).toBe(true);
    const desktop = await openDesktop(run.workstreamId, run.substreamId, admission.membershipVersion ?? 0);
    const alarm = runDurableObjectAlarm(child(run.workstreamId, run.substreamId));

    const evaluate = await desktop.nextAction("browser.evaluate");
    expect(evaluate.action).toEqual({ kind: "browser.evaluate", script: "return window.__probe" });
    desktop.answer(evaluate.id, { ok: true, result: {
      url: SOURCE_URL, title: "Garden irrigation", value: { turns: 2 }, stored: [],
    } });

    const finish = await desktop.nextAction("session_import.finish");
    expect(finish.action).toEqual({ kind: "session_import.finish", title: "Garden irrigation", messages: "messages-handle" });
    // What a desktop does on finish: hand Rally the assembled conversation.
    await service.complete(run.workstreamId, {
      title: "Garden irrigation",
      clientMessageId,
      spaceIds: [spaceId],
      source: { provider: "chatgpt", url: SOURCE_URL, sessionId: CONVERSATION_ID },
      content: { messages: [
        { role: "user", text: "How often should I water tomatoes?", sourceMessageId: "m1" },
        { role: "assistant", text: "Deeply, about twice a week.", sourceMessageId: "m2" },
      ] },
    });
    desktop.answer(finish.id, { ok: true, result: { workstreamId: run.workstreamId, messages: 2 } });
    await alarm;

    const opened = await new WorkstreamObjectClient(creationEnv(), AUTH, run.workstreamId, "0").get();
    expect(opened.title).toBe("Garden irrigation");
    const checkpoint = await new WorkstreamObjectClient(creationEnv(), AUTH, run.workstreamId, "0").importedSessionCheckpoint();
    expect(checkpoint.map((entry) => entry.sourceMessageId)).toEqual(["m1", "m2"]);

    // The run saw only its profile's tools, and the page's answer came back as the tool's result.
    expect(new Set(provider.calls.flatMap((call) => call.toolNames))).toEqual(new Set([
      "browser_evaluate", "browser_snapshot", "browser_screenshot", "browser_click", "browser_scroll",
      "browser_type", "browser_press_key", "browser_navigate", "browser_load", "import_finish", "import_fail",
    ]));
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1)?.content)).toContain("\\\"turns\\\":2");
    desktop.socket.close();
  }, 60_000);

  it("keeps a desktop's answer for the tool when the object loses the waiting call", async () => {
    const spaceId = await personalSpace();
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Evicted", spaceIds: [spaceId], clientMessageId: crypto.randomUUID() });
    const agent = child(run.workstreamId, run.substreamId);
    const desktop = await openDesktop(run.workstreamId, run.substreamId, 1);
    void runDurableObjectAlarm(agent).catch(() => undefined);
    const evaluate = await desktop.nextAction("browser.evaluate");
    // The waiting tool is gone, as after an eviction; the answer must still land durably.
    await runInDurableObject(agent, (instance) => {
      (instance as unknown as { desktopActionWaiters: Map<string, unknown> }).desktopActionWaiters.clear();
    });
    desktop.answer(evaluate.id, { ok: true, result: { url: SOURCE_URL, title: "t", value: 1, stored: [] } });
    await expect.poll(() => runInDurableObject(agent, (_instance, state) => state.storage.sql.exec<{ status: string }>(
      `SELECT status FROM desktop_actions WHERE action_id = ?`, evaluate.id).one().status), { timeout: 5_000 }).toBe("answered");
    // A re-entered call with the same receipt reads that answer instead of asking again.
    const replayed = await runInDurableObject(agent, (_instance, state) => state.storage.sql.exec<{ outcome_json: string }>(
      `SELECT outcome_json FROM desktop_actions WHERE action_id = ?`, evaluate.id).one().outcome_json);
    expect(JSON.parse(replayed)).toMatchObject({ ok: true, result: { value: 1 } });
    desktop.socket.close();
  }, 60_000);

  it("admits only the person the import is for to its hidden conversation", async () => {
    const spaceId = await personalSpace();
    const run = await new SessionImportRunService(creationEnv(), AUTH)
      .start({ sourceUrl: SOURCE_URL, title: "Refused", spaceIds: [spaceId], clientMessageId: crypto.randomUUID() });
    const other = asUserId(crypto.randomUUID());
    const admission = await workspace().authorizeViewer({
      workspaceId: WORKSPACE_ID, parentId: run.workstreamId, userId: other, substreamId: asSubstreamId(run.substreamId),
    });
    expect(admission.authorized).toBe(false);
  });

  it("discarding a Channel that never opened archives it and retires its create key", async () => {
    const spaceId = await personalSpace();
    const clientMessageId = crypto.randomUUID();
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Abandoned", spaceIds: [spaceId], clientMessageId });
    const listed = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ archived_at: number | null }>(
      `SELECT archived_at FROM channels WHERE workstream_id = ?`, run.workstreamId).one().archived_at);
    expect(await listed()).toBeNull();
    await service.discard({ workstreamId: run.workstreamId, substreamId: run.substreamId, clientMessageId });
    expect(await listed()).not.toBeNull();
    await expect(service.complete(run.workstreamId, {
      title: "Abandoned", clientMessageId, spaceIds: [spaceId],
      source: { provider: "chatgpt", url: SOURCE_URL, sessionId: CONVERSATION_ID },
      content: { messages: [{ role: "user", text: "late", sourceMessageId: "m1" }] },
    })).rejects.toMatchObject({ code: "workstream_create_discarded" });
  }, 60_000);
});
