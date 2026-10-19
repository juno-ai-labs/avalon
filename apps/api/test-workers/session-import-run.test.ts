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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asSpaceId, asSubstreamId, asUserId, asWorkspaceId, type SpaceId } from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { prepareSessionImport } from "../src/services/session-import-files";
import { SessionImportRunService } from "../src/services/session-import-run-service";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";
import { useOpenRouterDouble, type ProviderCall } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const verification = {
  checks: [{ name: "page content", passed: true, basis: "Compared every displayed turn." }],
  branch: { complete: true as const, basis: 'Selected leaf reaches the root.' },
  page: { messageCount: 2, firstSourceMessageId: 'm1', lastSourceMessageId: 'm2', sampledSourceMessageIds: ['m2'], basis: 'Both rendered turns compared.' },
  fileCount: 0,
};

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000f20");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000f21");
const SESSION_ID = "00000000-0000-7000-8000-000000000f22";
const CONVERSATION_ID = "0a1b2c3d-0000-4000-8000-00000000c0de";
const SOURCE_URL = `https://chatgpt.com/c/${CONVERSATION_ID}`;

const AUTH: AuthContext = { sessionId: SESSION_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, region: "global", role: "member" };

useSelectedModel();
/** The scripted agent: read the page, then finish with the stored messages. */
const provider = useOpenRouterDouble((call: ProviderCall) => {
  // A Breakout's preparation summarizes its thread's context.
  if (JSON.stringify(call.body.response_format ?? {}).includes("substream_context_summary")) {
    return { say: JSON.stringify({ summary: "The thread plans a garden." }) };
  }
  // The icon pass the opened Channel gets, a structured call with no tools.
  if (call.toolNames.length === 0) return { say: JSON.stringify({ title: "Tomato watering", icon: "megaphone" }) };
  const toolResults = call.messages.filter((message) => message.role === "tool").length;
  if (toolResults === 0) return { callTool: { name: "browser_js", arguments: { code: "nodeRepl.write(await rally.pageScript(\"return window.__probe\"));" } } };
  if (toolResults === 1) return { callTool: { name: "import_finish", arguments: { title: "Garden irrigation", messages: "messages-handle", verification } } };
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
      // The opened Channel's icon pass is a model call from the Worker, which
      // skips it without a key and a naming model; the provider double answers it.
      : property === "OPENROUTER_API_KEY" ? "workerd-test-openrouter-key"
        : property === "OPENROUTER_CLASSIFIER_MODEL" ? "double/naming"
          : Reflect.get(current, property, receiver),
  });
}

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: SESSION_ID });
  // The regional rows creation writes around the object calls, as in
  // `conversation-creation.test.ts`; columns follow packages/db/migrations.
  await env.DB.batch([
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
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

/**
 * A Space to import into. Organization-wide, as every Space is, and granting
 * no reader: the imported Channel stays its creator's.
 */
async function importSpace(): Promise<SpaceId> {
  const reserved = await workspace().reserveSpace({
    workspaceId: WORKSPACE_ID, userId: USER_ID,
    space: { name: "Imports", iconKey: "briefcase", colorKey: "blue", scope: "workspace" },
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

afterEach(() => { delete (env as { TOOL_DEFAULT_TIMEOUT_MS?: string }).TOOL_DEFAULT_TIMEOUT_MS; });

/**
 * `creationEnv()` with the Organization object answering the named methods as
 * a deploy's reset does: every other call reaches the real object.
 */
function resettingEnv(methods: readonly string[]): Env {
  const namespace = env.WORKSPACE_DOS;
  const resetting = new Proxy(namespace, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property !== "get" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: Parameters<typeof namespace.get>) => new Proxy(namespace.get(...args), {
        get: (stub, method) => typeof method === "string" && methods.includes(method)
          ? async () => { throw new Error("Durable Object reset because its code was updated."); }
          : Reflect.get(stub, method),
      });
    },
  });
  return new Proxy(creationEnv(), {
    get: (current, property, receiver) => property === "WORKSPACE_DOS" ? resetting
      : property === "LOG_LEVEL" ? "warn"
        : Reflect.get(current, property, receiver),
  });
}


describe("a conversation import run", () => {
  it("keeps a committing import alive past the ordinary tool deadline and settles its durable receipt", async () => {
    (env as { TOOL_DEFAULT_TIMEOUT_MS?: string }).TOOL_DEFAULT_TIMEOUT_MS = "1000";
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const clientMessageId = crypto.randomUUID();
    const spaceIds = [await importSpace()];
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Slow save", spaceIds, clientMessageId });
    const admission = await workspace().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: run.workstreamId,
      userId: USER_ID, substreamId: asSubstreamId(run.substreamId) });
    const desktop = await openDesktop(run.workstreamId, run.substreamId, admission.membershipVersion ?? 0);
    const alarm = runDurableObjectAlarm(child(run.workstreamId, run.substreamId));
    const evaluate = await desktop.nextAction("browser.script");
    desktop.answer(evaluate.id, { ok: true, result: { output: [] } });
    const finish = await desktop.nextAction("session_import.finish");
    try {
      await new Promise(resolve => setTimeout(resolve, 1100));
      await service.complete(run.workstreamId, { title: "Slow save", clientMessageId, spaceIds,
        source: { provider: "chatgpt", url: SOURCE_URL, sessionId: CONVERSATION_ID },
        content: { messages: [{ role: "user", text: "Question", sourceMessageId: "m1" },
          { role: "assistant", text: "Answer", sourceMessageId: "m2" }] } });
      desktop.answer(finish.id, { ok: true, result: { workstreamId: run.workstreamId, messages: 2 } });
      await alarm;
      await expect.poll(() => runInDurableObject(child(run.workstreamId, run.substreamId), (_instance, state) =>
        state.storage.sql.exec("SELECT status, error_json FROM runs").one()), { timeout: 10_000 })
        .toMatchObject({ status: "completed", error_json: null });
      expect(await runInDurableObject(child(run.workstreamId, run.substreamId), (_instance, state) =>
        state.storage.sql.exec("SELECT tool_name,status FROM tool_effects WHERE tool_name='import_finish'").one()))
        .toEqual({ tool_name: "import_finish", status: "completed" });
    } finally { desktop.socket.close(); await alarm.catch(() => undefined); }
  }, 60_000);

  it.each([undefined, 2])("uploads files across messages with width %s through real R2 and preserves source order", async (width) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    // Gate the real binding's writes to expose the interleave; every write still reaches real R2.
    const payloads = new Proxy(env.PAYLOADS, { get(target, property) {
      if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        started.push(String(args[0]));
        await gate;
        return target.put(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const testEnv = new Proxy(creationEnv(), { get(target, property, receiver) {
      return property === "PAYLOADS" ? payloads : Reflect.get(target, property, receiver);
    } });
    const operationId = "parallel-files";
    const pending = prepareSessionImport(testEnv, AUTH, {
      title: "Files", source: { provider: "chatgpt", url: SOURCE_URL, sessionId: CONVERSATION_ID },
      content: { messages: [
        { role: "user", text: "Uploads", sourceMessageId: "m1", files: ["one.txt", "two.txt"].map(name => ({
          name, mimeType: "text/plain", kind: "attachment" as const, source: { kind: "inline" as const, encoding: "utf8" as const, data: name } })) },
        { role: "assistant", text: "Generated", sourceMessageId: "m2", files: [{ name: "three.txt", mimeType: "text/plain",
          kind: "artifact", source: { kind: "inline", encoding: "utf8", data: "three.txt" } }] },
      ] },
    }, operationId, new Map(), width);
    try { await expect.poll(() => started.length).toBe(width ?? 3); }
    finally { release(); await pending.catch(() => undefined); }
    const prepared = await pending;
    expect(prepared.messages.map(message => message.text)).toEqual(["Uploads", "Generated"]);
    const ids = prepared.messages.flatMap(message => message.attachmentIds ?? []);
    const titles = await runInDurableObject(workspace(), (_instance, state) => ids.map(id =>
      state.storage.sql.exec<{ title: string }>("SELECT title FROM resources WHERE id=?", id).one().title));
    expect(titles).toEqual(["one.txt", "two.txt", "three.txt"]);
  });
  it("drains a failed upload batch, stops later files, and reuses successful drafts on retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    const payloads = new Proxy(env.PAYLOADS, { get(target, property) {
      if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        writes += 1;
        if (writes === 1) throw new Error("R2 unavailable");
        await gate;
        return target.put(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const testEnv = new Proxy(creationEnv(), { get(target, property, receiver) {
      return property === "PAYLOADS" ? payloads : Reflect.get(target, property, receiver);
    } });
    const preview = { title: "Files", source: { provider: "chatgpt" as const, url: SOURCE_URL, sessionId: CONVERSATION_ID },
      content: { messages: ["one", "two", "three"].map(name => ({ role: "user" as const, text: name, sourceMessageId: name,
        files: [{ name: `${name}.txt`, mimeType: "text/plain", kind: "attachment" as const,
          source: { kind: "inline" as const, encoding: "utf8" as const, data: name } }] })) } };
    let settled = false;
    const pending = prepareSessionImport(testEnv, AUTH, preview, "partial-files", new Map(), 2)
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await expect.poll(() => writes).toBe(2);
      expect(settled).toBe(false);
    } finally { release(); await pending; }
    expect(await pending).toMatchObject({ error: { message: "R2 unavailable" } });
    expect(writes).toBe(2);
    const firstDrafts = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec("SELECT id,title,content_ref FROM resources WHERE resource_type='uploaded_file'").toArray());
    expect(firstDrafts).toMatchObject([{ title: "two.txt" }]);
    const retried = await prepareSessionImport(creationEnv(), AUTH, preview, "partial-files", new Map(), 2);
    expect(retried.messages.map(message => message.attachmentIds?.length)).toEqual([1, 1, 1]);
    const after = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec("SELECT id,title,content_ref FROM resources WHERE resource_type='uploaded_file'").toArray());
    expect(after).toHaveLength(3);
    expect(after.find(row => row['title'] === 'two.txt')).toEqual(firstDrafts[0]);
  });

  it("reads the page through the desktop and opens the Channel with what it read", async () => {
    const spaceId = await importSpace();
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

    const evaluate = await desktop.nextAction("browser.script");
    expect(evaluate.action).toEqual({ kind: "browser.script", code: "nodeRepl.write(await rally.pageScript(\"return window.__probe\"));" });
    desktop.answer(evaluate.id, { ok: true, result: {
      output: [{ type: "text", text: '{"turns":2}' }],
    } });

    const finish = await desktop.nextAction("session_import.finish");
    expect(finish.action).toEqual({ kind: "session_import.finish", title: "Garden irrigation", messages: "messages-handle", verification });
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
    // The importer's name stands, and the icon pass read the history for an
    // icon; the colour is the Channel's, given at birth.
    expect(opened.appearance).toEqual({ icon: "megaphone", color: "blue" });
    const checkpoint = await new WorkstreamObjectClient(creationEnv(), AUTH, run.workstreamId, "0").importedSessionCheckpoint();
    expect(checkpoint.map((entry) => entry.sourceMessageId)).toEqual(["m1", "m2"]);

    // The run saw only its profile's tools, and the page's answer came back as the tool's result.
    expect(new Set(provider.calls.flatMap((call) => call.toolNames))).toEqual(new Set([
      "browser_js", "browser_js_reset",
      "import_finish", "import_fail",
      // The profile's skills, offered by Bind's own skill tools.
      "load_skill", "read_skill_resource",
    ]));
    expect(JSON.parse(String(provider.calls[1]!.messages.at(-1)?.content))).toEqual({ success: true, data: { output: ['{"turns":2}'] } });
    // Finishing returns to the model, whose reply is the run's final turn, so the run completes.
    await expect.poll(() => runInDurableObject(child(run.workstreamId, run.substreamId), (_instance, state) =>
      state.storage.sql.exec<{ status: string; has_final_turn: number }>(
        `SELECT status, final_turn_id IS NOT NULL AS has_final_turn FROM runs`).one()), { timeout: 10_000 })
      .toEqual({ status: "completed", has_final_turn: 1 });
    desktop.socket.close();
  }, 60_000);

  it("keeps a desktop's answer for the tool when the object loses the waiting call", async () => {
    const spaceId = await importSpace();
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Evicted", spaceIds: [spaceId], clientMessageId: crypto.randomUUID() });
    const agent = child(run.workstreamId, run.substreamId);
    const desktop = await openDesktop(run.workstreamId, run.substreamId, 1);
    void runDurableObjectAlarm(agent).catch(() => undefined);
    const evaluate = await desktop.nextAction("browser.script");
    // The waiting tool is gone, as after an eviction; the answer must still land durably.
    await runInDurableObject(agent, (instance) => {
      (instance as unknown as { desktopActionWaiters: Map<string, unknown> }).desktopActionWaiters.clear();
    });
    desktop.answer(evaluate.id, { ok: true, result: { output: [{ type: "text", text: "1" }] } });
    await expect.poll(() => runInDurableObject(agent, (_instance, state) => state.storage.sql.exec<{ status: string }>(
      `SELECT status FROM desktop_actions WHERE action_id = ?`, evaluate.id).one().status), { timeout: 5_000 }).toBe("answered");
    // A re-entered call with the same receipt reads that answer instead of asking again.
    const replayed = await runInDurableObject(agent, (_instance, state) => state.storage.sql.exec<{ outcome_json: string }>(
      `SELECT outcome_json FROM desktop_actions WHERE action_id = ?`, evaluate.id).one().outcome_json);
    expect(JSON.parse(replayed)).toMatchObject({ ok: true, result: { output: [{ type: "text", text: "1" }] } });
    desktop.socket.close();
  }, 60_000);

  it("admits only the person the import is for to its hidden conversation", async () => {
    const spaceId = await importSpace();
    const run = await new SessionImportRunService(creationEnv(), AUTH)
      .start({ sourceUrl: SOURCE_URL, title: "Refused", spaceIds: [spaceId], clientMessageId: crypto.randomUUID() });
    const other = asUserId(crypto.randomUUID());
    const admission = await workspace().authorizeViewer({
      workspaceId: WORKSPACE_ID, parentId: run.workstreamId, userId: other, substreamId: asSubstreamId(run.substreamId),
    });
    expect(admission.authorized).toBe(false);
  });

  it("refuses to discard any conversation but the caller's own import, and leaves its agent running", async () => {
    const spaceId = await importSpace();
    const run = await new SessionImportRunService(creationEnv(), AUTH)
      .start({ sourceUrl: SOURCE_URL, title: "Kept", spaceIds: [spaceId], clientMessageId: crypto.randomUUID() });
    const stopRequested = () => runInDurableObject(child(run.workstreamId, run.substreamId), (_instance, state) =>
      state.storage.sql.exec<{ stop_requested_at: number | null }>(`SELECT stop_requested_at FROM substream_loops`).one().stop_requested_at);
    // Another member of the Organization, naming the import's own child.
    const other = new SessionImportRunService(creationEnv(), { ...AUTH, userId: asUserId("00000000-0000-7000-8000-000000000f23") });
    await expect(other.discard({ workstreamId: run.workstreamId, substreamId: run.substreamId, clientMessageId: null }))
      .rejects.toMatchObject({ code: "session_import_not_found" });
    // The creator, naming the Channel's main conversation instead of the import.
    await expect(new SessionImportRunService(creationEnv(), AUTH).discard({ workstreamId: run.workstreamId, substreamId: "0", clientMessageId: null }))
      .rejects.toMatchObject({ code: "session_import_not_found" });
    expect(await stopRequested()).toBeNull();
  }, 60_000);

  it("archives a new Channel its run ended without opening, with no discard from the desktop", async () => {
    const spaceId = await importSpace();
    const clientMessageId = crypto.randomUUID();
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Closed window", spaceIds: [spaceId], clientMessageId });
    const agent = child(run.workstreamId, run.substreamId);
    const desktop = await openDesktop(run.workstreamId, run.substreamId, 1);
    const alarm = runDurableObjectAlarm(agent);
    const evaluate = await desktop.nextAction("browser.script");
    desktop.answer(evaluate.id, { ok: true, result: { output: [{ type: "text", text: "1" }] } });
    // The finish is refused and nothing completes the import; the window is gone.
    const finish = await desktop.nextAction("session_import.finish");
    desktop.answer(finish.id, { ok: false, code: "import_rejected", message: "Rally refused the import." });
    desktop.socket.close();
    await alarm;
    await expect.poll(() => runInDurableObject(agent, (_instance, state) =>
      state.storage.sql.exec<{ status: string }>(`SELECT status FROM runs`).one().status), { timeout: 10_000 }).toBe("completed");

    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ archived_at: number | null }>(
      `SELECT archived_at FROM channels WHERE workstream_id = ?`, run.workstreamId).one().archived_at)).not.toBeNull();
    await expect(service.complete(run.workstreamId, {
      title: "Closed window", clientMessageId, spaceIds: [spaceId],
      source: { provider: "chatgpt", url: SOURCE_URL, sessionId: CONVERSATION_ID },
      content: { messages: [{ role: "user", text: "late", sourceMessageId: "m1" }] },
    })).rejects.toMatchObject({ code: "workstream_create_discarded" });
  }, 60_000);

  it("admits one run for two starts of the same import at once", async () => {
    const spaceId = await importSpace();
    const clientMessageId = crypto.randomUUID();
    const input = { sourceUrl: SOURCE_URL, title: "Twice", spaceIds: [spaceId], clientMessageId };
    const [first, second] = await Promise.all([
      new SessionImportRunService(creationEnv(), AUTH).start(input),
      new SessionImportRunService(creationEnv(), AUTH).start(input),
    ]);
    expect(second).toEqual(first);
    expect(await runInDurableObject(child(first.workstreamId, first.substreamId), (_instance, state) =>
      state.storage.sql.exec<{ runs: number }>(`SELECT COUNT(*) AS runs FROM runs`).one().runs)).toBe(1);
  }, 60_000);

  it("refuses to discard a Channel a completing import has claimed", async () => {
    const spaceId = await importSpace();
    const clientMessageId = crypto.randomUUID();
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Opening", spaceIds: [spaceId], clientMessageId });
    // Where a complete stands between its claim and opening the Channel.
    await env.DB.prepare(`UPDATE workstream_create_receipts SET state = 'initialized' WHERE workstream_id = ?`).bind(run.workstreamId).run();
    await expect(service.discard({ workstreamId: run.workstreamId, substreamId: run.substreamId, clientMessageId }))
      .rejects.toMatchObject({ code: "session_import_already_open" });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ archived_at: number | null }>(
      `SELECT archived_at FROM channels WHERE workstream_id = ?`, run.workstreamId).one().archived_at)).toBeNull();
    expect((await env.DB.prepare(`SELECT state FROM workstream_create_receipts WHERE workstream_id = ?`).bind(run.workstreamId)
      .first<{ state: string }>())?.state).toBe("initialized");
  }, 60_000);

  /** An opened thread to import into, its own import agent stopped. */
  async function openedThread(service: SessionImportRunService): Promise<string> {
    const spaceId = await importSpace();
    const clientMessageId = crypto.randomUUID();
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Garden", spaceIds: [spaceId], clientMessageId });
    await service.complete(run.workstreamId, {
      title: "Garden", clientMessageId, spaceIds: [spaceId],
      source: { provider: "chatgpt", url: SOURCE_URL, sessionId: CONVERSATION_ID },
      content: { messages: [{ role: "user", text: "Plan the garden", sourceMessageId: "g1" }] },
    });
    await service.discard({ workstreamId: run.workstreamId, substreamId: run.substreamId, clientMessageId: null });
    return run.workstreamId;
  }

  const BREAKOUT_URL = "https://claude.ai/chat/0a1b2c3d-0000-4000-8000-0000000b0a75";
  const breakoutSource = { provider: "claude" as const, url: BREAKOUT_URL, sessionId: "0a1b2c3d-0000-4000-8000-0000000b0a75" };

  it("imports a conversation as a Breakout of an existing thread, listed only once it holds the history", async () => {
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const threadId = await openedThread(service);
    const clientMessageId = crypto.randomUUID();
    const run = await service.startBreakout(threadId, { sourceUrl: BREAKOUT_URL, title: "Watering notes", clientMessageId });
    expect(run.workstreamId).toBe(threadId);
    // A replayed start finds the agent it launched rather than starting another.
    expect(await service.startBreakout(threadId, { sourceUrl: BREAKOUT_URL, title: "Watering notes", clientMessageId })).toEqual(run);
    const admission = await workspace().authorizeViewer({
      workspaceId: WORKSPACE_ID, parentId: threadId, userId: USER_ID, substreamId: asSubstreamId(run.substreamId),
    });
    expect(admission.authorized).toBe(true);
    const reservation = () => workspace().readPrivateChildPreparation({ workspaceId: WORKSPACE_ID, parentId: threadId, operationId: clientMessageId });
    expect((await reservation())?.status).not.toBe("ready");

    // A finish naming a conversation the import was not started on is refused before any upload.
    const otherUrl = "https://claude.ai/chat/0a1b2c3d-0000-4000-8000-0000000b0a76";
    await expect(service.completeBreakout(threadId, {
      title: "Watering notes", clientMessageId, source: { ...breakoutSource, url: otherUrl, sessionId: "0a1b2c3d-0000-4000-8000-0000000b0a76" },
      content: { messages: [{ role: "user", text: "Wrong chat", sourceMessageId: "x1", files: [{ name: "x.txt", mimeType: "text/plain",
        kind: "attachment", source: { kind: "inline", encoding: "utf8", data: "x" } }] }] },
    })).rejects.toMatchObject({ code: "session_import_source_mismatch" });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT title FROM resources WHERE resource_type='uploaded_file'").toArray())).toEqual([]);

    const created = await service.completeBreakout(threadId, {
      title: "Watering notes", clientMessageId, source: breakoutSource,
      content: { messages: [
        { role: "user", text: "How often should I water tomatoes?", sourceMessageId: "b1" },
        { role: "assistant", text: "Deeply, about twice a week.", sourceMessageId: "b2" },
      ] },
    });
    expect(created).toMatchObject({ substreamId: (await reservation())?.substreamId, title: "Watering notes" });
    expect((await reservation())?.status).toBe("ready");
    const breakout = new WorkstreamObjectClient(creationEnv(), AUTH, threadId, created.substreamId);
    expect(JSON.stringify((await breakout.boot()).transcript)).toContain("Deeply, about twice a week.");
    // Its source is recorded like a thread's, so it can be read again later.
    expect((await breakout.importedSessionCheckpoint()).map((entry) => entry.sourceMessageId)).toEqual(["b1", "b2"]);
    await service.discard({ workstreamId: threadId, substreamId: run.substreamId, clientMessageId: null });
  }, 60_000);

  it("refuses a Breakout import into a thread the caller cannot see before launching any agent in it", async () => {
    const threadId = await openedThread(new SessionImportRunService(creationEnv(), AUTH));
    const outsiderId = asUserId("00000000-0000-7000-8000-000000000f24");
    // A member of the Organization who is not in this private thread.
    await env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, outsiderId).run();
    const outsider = new SessionImportRunService(creationEnv(), { ...AUTH, userId: outsiderId });
    await expect(outsider.startBreakout(threadId, { sourceUrl: BREAKOUT_URL, title: "Not mine", clientMessageId: crypto.randomUUID() }))
      .rejects.toMatchObject({ status: 404 });
    expect(await workspace().hiddenChildren({ workspaceId: WORKSPACE_ID, parentId: threadId, userId: outsiderId })).toEqual([]);
  }, 60_000);

  it("discarding a Breakout import cancels its reservation, so a late finish cannot open it", async () => {
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const threadId = await openedThread(service);
    const clientMessageId = crypto.randomUUID();
    const run = await service.startBreakout(threadId, { sourceUrl: BREAKOUT_URL, title: "Abandoned", clientMessageId });
    await service.discard({ workstreamId: threadId, substreamId: run.substreamId, clientMessageId, breakout: true });
    expect((await workspace().readPrivateChildPreparation({ workspaceId: WORKSPACE_ID, parentId: threadId, operationId: clientMessageId }))?.status)
      .toBe("failed");
    await expect(service.completeBreakout(threadId, {
      title: "Abandoned", clientMessageId, source: breakoutSource,
      content: { messages: [{ role: "user", text: "late", sourceMessageId: "b1", files: [{ name: "late.txt", mimeType: "text/plain",
        kind: "attachment", source: { kind: "inline", encoding: "utf8", data: "late" } }] }] },
    })).rejects.toMatchObject({ code: "substream_creation_cancelled" });
    // Refused before its file was uploaded, so nothing is left behind.
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT title FROM resources WHERE resource_type='uploaded_file'").toArray())).toEqual([]);
  }, 60_000);

  it("discarding a Channel that never opened archives it and retires its create key", async () => {
    const spaceId = await importSpace();
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

  it("takes back by its create key a Channel whose start failed and could not retire it", async () => {
    const spaceId = await importSpace();
    const clientMessageId = crypto.randomUUID();
    const listed = (workstreamId: string) => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ archived_at: number | null }>(
      `SELECT archived_at FROM channels WHERE workstream_id = ?`, workstreamId).one().archived_at);
    // The launch fails after the reservation, and the retire behind it fails
    // the same way: the desktop gets an error and no ids.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(new SessionImportRunService(resettingEnv(["reserveHiddenChild", "discardReservedMain"]), AUTH)
      .start({ sourceUrl: SOURCE_URL, title: "Stranded", spaceIds: [spaceId], clientMessageId }))
      .rejects.toThrow("Durable Object reset");
    const receipt = await env.DB.prepare(`SELECT workstream_id FROM workstream_create_receipts WHERE client_message_id = ?`)
      .bind(clientMessageId).first<{ workstream_id: string }>();
    expect(await listed(receipt!.workstream_id)).toBeNull();
    expect(warned.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.event === "session_import_retire_failed")
      .map(({ workstream_id, reason }) => ({ workstream_id, reason })))
      .toEqual([{ workstream_id: receipt!.workstream_id, reason: "session_import_retire_failed:durable_object_code_updated" }]);
    warned.mockRestore();

    const service = new SessionImportRunService(creationEnv(), AUTH);
    expect(await service.abandon(clientMessageId)).toEqual({ abandoned: true });
    expect(await listed(receipt!.workstream_id)).not.toBeNull();
    await expect(service.complete(receipt!.workstream_id, {
      title: "Stranded", clientMessageId, spaceIds: [spaceId],
      source: { provider: "chatgpt", url: SOURCE_URL, sessionId: CONVERSATION_ID },
      content: { messages: [{ role: "user", text: "late", sourceMessageId: "m1" }] },
    })).rejects.toMatchObject({ code: "workstream_create_discarded" });
  }, 60_000);

  it("refuses to abandon a key a completing import has claimed, before stopping its agent", async () => {
    const spaceId = await importSpace();
    const clientMessageId = crypto.randomUUID();
    const service = new SessionImportRunService(creationEnv(), AUTH);
    const run = await service.start({ sourceUrl: SOURCE_URL, title: "Opening", spaceIds: [spaceId], clientMessageId });
    await env.DB.prepare(`UPDATE workstream_create_receipts SET state = 'initialized' WHERE workstream_id = ?`).bind(run.workstreamId).run();
    await expect(service.abandon(clientMessageId)).rejects.toMatchObject({ code: "session_import_already_open" });
    expect(await runInDurableObject(child(run.workstreamId, run.substreamId), (_instance, state) =>
      state.storage.sql.exec<{ stop_requested_at: number | null }>(`SELECT stop_requested_at FROM substream_loops`).one().stop_requested_at)).toBeNull();
    expect(await service.abandon(crypto.randomUUID())).toEqual({ abandoned: false });
  }, 60_000);
});
