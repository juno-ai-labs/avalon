/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, evictDurableObject, listDurableObjectIds, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asUserId, asWorkspaceId } from "@rally/contracts";

import { createEngineeringMcpHandler } from "../../engineering-mcp/src/index";
import { TASKS_EXTENSION, TaskSnapshotSchema } from "../../engineering-mcp/src/tasks";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import { workspaceDOName } from "../src/durable-objects/names";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";
import { ensureAuditSchema } from "./helpers/audit-fixture";

const OPERATOR = { subject: "task-engineer", email: "engineer@example.com", audience: "engineering-mcp" };
const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000ef70");
const USER = asUserId("00000000-0000-7000-8000-00000000ef71");
const query = { name: "query_data_lake", arguments: { lakehouse: "llm_inference", sql: "SELECT 42 AS answer FROM default.llm_inference" } };

async function rpc(method: string, params: Record<string, unknown> = {}, options: {
  principal?: typeof OPERATOR; tasks?: boolean; origin?: string;
} = {}) {
  const handler = createEngineeringMcpHandler({
    ENGINEERING_TASKS: env.ENGINEERING_TASKS!,
    GLOBAL_INSPECTION: new EngineeringInspectionBridge(createExecutionContext(), env),
    CLOUDFLARE_ACCOUNT_ID: "task-test-account", BASIN_SQL_API_TOKEN: "test-not-a-credential",
  }, options.principal ?? OPERATOR);
  const response = await handler.fetch(new Request("https://mcp.internal.rallywith.ai/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "Mcp-Method": method,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : typeof params.taskId === "string" ? { "Mcp-Name": params.taskId } : {}), ...(options.origin ? { origin: options.origin } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "task-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": options.tasks === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } },
      },
    } }),
  }));
  return { status: response.status, body: await response.json() as { result?: Record<string, unknown>; error?: { code: number; message: string } } };
}

function stub(taskId: string) {
  return env.ENGINEERING_TASKS!.get(env.ENGINEERING_TASKS!.idFromName(taskId));
}

async function start(input = query) {
  const response = await rpc("tools/call", input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.result).toMatchObject({ resultType: "task", status: "working", ttlMs: null });
  expect(response.body.result).not.toHaveProperty("content");
  expect(response.body.result?._meta).not.toHaveProperty("ai.rally/engineering-task");
  return TaskSnapshotSchema.parse(response.body.result);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function basinResponse(value: unknown) {
  return Response.json({ success: true, errors: [], result: value });
}

// Every task has a fresh UUID. Reset once: the pool isolates this file, and
// resetting between tests would abort SDK request-lifecycle continuations.
beforeAll(async () => { await reset(); });
beforeEach(() => {
  // Native alarms must be delivered explicitly by the test, never race reset
  // or eviction. Date is the doubled clock; all production timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2050-01-01T00:00:00.000Z"));
});
afterEach(async () => {
  // Drain scheduled task alarms before reset tears down their storage.
  for (const id of await listDurableObjectIds(env.ENGINEERING_TASKS!)) {
    await runInDurableObject(env.ENGINEERING_TASKS!.get(id), async (_instance, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("engineering MCP task execution", () => {
  it("advertises the extension and keeps unnegotiated or unidentified calls synchronous", async () => {
    expect((await rpc("server/discover")).body.result).toMatchObject({ capabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));
    for (const options of [{ tasks: false }, { principal: { ...OPERATOR, subject: "unknown" } }, { principal: { ...OPERATOR, subject: "" } }]) {
      const response = await rpc("tools/call", query, options);
      expect(response.body.result).toMatchObject({ resultType: "complete", content: [{ type: "text", text: '{\n  "rows": [\n    [\n      42\n    ]\n  ]\n}' }] });
      expect(response.body.result).not.toHaveProperty("taskId");
    }
  });

  it("persists a deferred query and its entire result across eviction and fresh HTTP handlers", async () => {
    const value = { rows: [[42, "日本語🙂".repeat(40_000)]] };
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse(value));
    const task = await start();
    await evictDurableObject(stub(task.taskId));
    await runDurableObjectAlarm(stub(task.taskId));
    await evictDurableObject(stub(task.taskId));
    const polled = await rpc("tasks/get", { taskId: task.taskId });
    expect(polled.body.error, JSON.stringify(polled.body)).toBeUndefined();
    const completed = TaskSnapshotSchema.parse(polled.body.result);
    expect(polled.body.result).toMatchObject({ resultType: "complete", result: { resultType: "complete" } });
    expect(completed.status).toBe("completed");
    expect(JSON.parse(completed.result!.content[0]!.text)).toEqual(value);
    expect(Date.parse(completed.createdAt) + completed.ttlMs! - Date.parse(completed.lastUpdatedAt)).toBe(604_800_000);
    expect(provider).toHaveBeenCalledTimes(1);
    await runInDurableObject(stub(task.taskId), async (_instance, state) => {
      expect(await state.storage.get("input:count")).toBeUndefined();
    });
  });

  it("refuses other subjects, other audiences, missing capabilities, and disallowed Origins", async () => {
    const task = await start();
    for (const principal of [{ ...OPERATOR, subject: "other" }, { ...OPERATOR, audience: "other" }]) {
      for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
        const response = await rpc(method, { taskId: task.taskId, inputResponses: {} }, { principal });
        expect(response.body.error).toMatchObject({ code: -32602, message: expect.stringContaining("task_not_found") });
      }
    }
    expect((await rpc("tasks/get", { taskId: task.taskId }, { tasks: false })).body.error?.code).toBe(-32021);
    expect((await rpc("tools/call", query, { origin: "https://attacker.example" })).status).toBe(403);
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result?.status).toBe("working");
  });

  it("keeps a cancelled query terminal when its in-flight provider response arrives", async () => {
    const entered = deferred<void>();
    const response = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { entered.resolve(); return response.promise; });
    const task = await start();
    const execution = runDurableObjectAlarm(stub(task.taskId));
    await entered.promise;
    expect((await rpc("tasks/cancel", { taskId: task.taskId })).body.error).toBeUndefined();
    response.resolve(basinResponse({ rows: [[42]] }));
    await execution;
    const result = (await rpc("tasks/get", { taskId: task.taskId })).body.result;
    expect(result).toMatchObject({ status: "cancelled" });
    expect(result).not.toHaveProperty("result");
  });

  it("returns provider failures as completed tool errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: false, errors: [{ code: 40004, message: "Invalid query" }] }, { status: 400 }));
    const task = await start();
    await runDurableObjectAlarm(stub(task.taskId));
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result).toMatchObject({
      status: "completed", result: { isError: true, content: [{ type: "text", text: expect.stringContaining("40004") }] },
    });
  });

  it("expires and erases results seven days after completion", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));
    const task = await start();
    vi.setSystemTime(new Date("2050-01-01T02:00:00.000Z"));
    await runDurableObjectAlarm(stub(task.taskId));
    const polled = await rpc("tasks/get", { taskId: task.taskId });
    expect(polled.body.error, JSON.stringify(polled.body)).toBeUndefined();
    const completed = TaskSnapshotSchema.parse(polled.body.result);
    expect(completed.ttlMs).toBe(612_000_000);
    vi.setSystemTime(Date.parse(completed.lastUpdatedAt) + 604_799_999);
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result?.status).toBe("completed");
    vi.setSystemTime(Date.parse(completed.lastUpdatedAt) + 604_800_000);
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.error?.code).toBe(-32602);
    await runDurableObjectAlarm(stub(task.taskId));
    await runInDurableObject(stub(task.taskId), async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
    });
  });

  it("resumes partial retirement after eviction and preserves the operator audit despite cancellation intent", async () => {
    await seedInspectableWorkspace(env.DB, { workspaceId: WORKSPACE, userId: USER,
      sessionId: "00000000-0000-7000-8000-00000000ef72", at: "2026-11-10T00:00:00.000Z" });
    await env.DB.prepare("ALTER TABLE workspaces ADD COLUMN updated_at TEXT").run();
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE)));
    await workspace.initializeWorkspace(WORKSPACE, "wnam");
    await ensureAuditSchema();
    await workspace.canvasCreate({ workspaceId: WORKSPACE, canvasId: "00000000-0000-7000-8000-00000000ef73",
      title: "Retirement task", createdByUserId: USER, authorityGeneration: 1 });
    // Suppress one journal write in real SQLite so the first graph pass is
    // observably incomplete; no retirement RPC or receipt is mocked.
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`CREATE TRIGGER hold_retirement_receipt
        BEFORE UPDATE OF retired_at ON workspace_retirement_graph
        BEGIN SELECT RAISE(IGNORE); END`);
    });
    const response = await rpc("tools/call", { name: "retire_org", arguments: { orgId: WORKSPACE } });
    const task = TaskSnapshotSchema.parse(response.body.result);
    await rpc("tasks/cancel", { taskId: task.taskId });
    await expect(runDurableObjectAlarm(stub(task.taskId))).rejects.toThrow("engineering_retirement_incomplete");
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result).toMatchObject({
      status: "working", statusMessage: "Retirement incomplete: 1 remaining; retrying",
    });
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER hold_retirement_receipt");
    });
    // The test alarm helper does not deliver native retries: schedule its next
    // delivery explicitly, then evict before running the production handler.
    await runInDurableObject(stub(task.taskId), async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await evictDurableObject(stub(task.taskId));
    await runDurableObjectAlarm(stub(task.taskId));
    const polled = await rpc("tasks/get", { taskId: task.taskId });
    expect(polled.body.error, JSON.stringify(polled.body)).toBeUndefined();
    const completed = TaskSnapshotSchema.parse(polled.body.result);
    expect(completed.status).toBe("completed");
    expect(completed.result?.isError).not.toBe(true);
    expect(JSON.parse(completed.result!.content[0]!.text)).toMatchObject({ complete: true, remaining: 0 });
    expect(await workspace.objectRetirementState()).toMatchObject({ retired: true });
    const audit = await env.AUDIT_DB.prepare("SELECT metadata_json FROM audit_events WHERE workspace_id = ? AND action = 'engineering.retire_org.result' AND json_extract(metadata_json, '$.complete') = 1")
      .bind(WORKSPACE).first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({ operator: OPERATOR, complete: true });
  });
});
