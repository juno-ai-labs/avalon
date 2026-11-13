/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, evictDurableObject, listDurableObjectIds, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asUserId, asWorkspaceId } from "@rally/contracts";

import { createEngineeringMcpHandler } from "../../engineering-mcp/src/index";
import { TASKS_EXTENSION, TaskSnapshotSchema } from "../../engineering-mcp/src/tasks";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import { workspaceDOName } from "../src/durable-objects/names";
import { ensureBillingClosureSchema, seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";
import { ensureAuditSchema } from "./helpers/audit-fixture";
import type { EngineeringTaskTestDO } from "./fixtures/engineering-task-worker";

const OPERATOR = { subject: "task-engineer", email: "engineer@example.com", audience: "engineering-mcp" };
const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000ef70");
const USER = asUserId("00000000-0000-7000-8000-00000000ef71");
const query = { name: "query_data_lake", arguments: { lakehouse: "llm_inference", sql: "SELECT 42 AS answer FROM default.llm_inference" } };

async function rpc(method: string, params: Record<string, unknown> = {}, options: {
  principal?: typeof OPERATOR; tasks?: boolean; origin?: string; encodedName?: boolean; nameHeader?: string;
} = {}) {
  const handler = createEngineeringMcpHandler({
    ENGINEERING_TASKS: env.ENGINEERING_TASKS!,
    ENGINEERING_AUDIT_LOG: env.ENGINEERING_AUDIT_LOG!,
    GLOBAL_INSPECTION: new EngineeringInspectionBridge(createExecutionContext(), env),
    CLOUDFLARE_ACCOUNT_ID: "task-test-account", BASIN_SQL_API_TOKEN: "test-not-a-credential",
  }, options.principal ?? OPERATOR);
  const name = typeof params.name === "string" ? params.name : typeof params.taskId === "string" ? params.taskId : undefined;
  const nameHeader = options.nameHeader ?? (name === undefined ? undefined : options.encodedName ? `=?base64?${btoa(name)}?=` : name);
  const response = await handler.fetch(new Request("https://mcp.internal.rallywith.ai/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "Mcp-Method": method,
      ...(nameHeader === undefined ? {} : { "Mcp-Name": nameHeader }), ...(options.origin ? { origin: options.origin } : {}) },
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
  // This file's worker uses the production subclass with alarm-delivery hooks.
  return env.ENGINEERING_TASKS!.get(env.ENGINEERING_TASKS!.idFromName(taskId)) as DurableObjectStub<EngineeringTaskTestDO>;
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
    // More than 128 chunks, including multi-byte characters and chunk 10+.
    const value = { rows: [[42, "日本語🙂".repeat(40_000) + "x".repeat(4_000_000)]] };
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
      expect(state.storage.sql.exec("SELECT kind FROM engineering_task_payloads WHERE kind = 'input'").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT version FROM _sql_schema_migrations").toArray()).toEqual([{ version: 1 }]);
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

  it("returns a task handle and serves task methods for encoded Mcp-Name headers", async () => {
    const created = await rpc("tools/call", query, { encodedName: true });
    expect(created.body.result).toMatchObject({ resultType: "task", status: "working" });
    expect(created.body.result?._meta).not.toHaveProperty("ai.rally/engineering-task");
    const task = TaskSnapshotSchema.parse(created.body.result);
    expect((await rpc("tasks/get", { taskId: task.taskId }, { encodedName: true })).body.result?.status).toBe("working");
    expect((await rpc("tasks/update", { taskId: task.taskId, inputResponses: {} }, { encodedName: true })).body.error).toBeUndefined();
    for (const nameHeader of ["=?base64?not-base64?=", `=?base64?${btoa(crypto.randomUUID())}?=`]) {
      expect((await rpc("tasks/cancel", { taskId: task.taskId }, { nameHeader })).body.error).toBeDefined();
    }
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result?.status).toBe("working");
    expect((await rpc("tasks/cancel", { taskId: task.taskId }, { encodedName: true })).body.error).toBeUndefined();
    expect((await rpc("tasks/get", { taskId: task.taskId }, { encodedName: true })).body.result?.status).toBe("cancelled");
  });

  it("terminates damaged stored inputs with named errors and erases them before retention expiry", async () => {
    for (const [damage, code] of [
      ["missing-count", "engineering_task_missing_input"],
      ["missing-chunk", "engineering_task_missing_input_chunk"],
      ["invalid-json", "engineering_task_input_invalid_json"],
      ["invalid-schema", "engineering_task_input_invalid:arguments.lakehouse:invalid_value"],
    ]) {
      const task = await start();
      await runInDurableObject(stub(task.taskId), async (_instance, state) => {
        if (damage === "missing-count") state.storage.sql.exec("DELETE FROM engineering_task_payloads WHERE kind = 'input'");
        else if (damage === "missing-chunk") state.storage.sql.exec("DELETE FROM engineering_task_chunks WHERE kind = 'input' AND position = 0");
        else state.storage.sql.exec("UPDATE engineering_task_chunks SET content = ? WHERE kind = 'input' AND position = 0",
          damage === "invalid-json" ? "{invalid" : JSON.stringify({ ...query, arguments: { ...query.arguments, lakehouse: "unknown" } }));
      });
      await runDurableObjectAlarm(stub(task.taskId));
      const result = (await rpc("tasks/get", { taskId: task.taskId })).body.result;
      expect(result).toMatchObject({ status: "completed", ttlMs: 604_800_000, result: { isError: true, content: [{ type: "text", text: code }] } });
      await runInDurableObject(stub(task.taskId), async (_instance, state) => {
        expect(state.storage.sql.exec("SELECT kind FROM engineering_task_payloads WHERE kind = 'input'").toArray()).toEqual([]);
        expect(state.storage.sql.exec("SELECT kind FROM engineering_task_chunks WHERE kind = 'input'").toArray()).toEqual([]);
        expect(await state.storage.getAlarm()).toBe(Date.now() + 604_800_000);
      });
      vi.setSystemTime(Date.now() + 604_800_000);
      await runDurableObjectAlarm(stub(task.taskId));
      expect((await rpc("tasks/get", { taskId: task.taskId })).body.error?.code).toBe(-32602);
    }
  });

  it("returns provider failures as completed tool errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: false, errors: [{ code: 40004, message: "Invalid query" }] }, { status: 400 }));
    const task = await start();
    await runDurableObjectAlarm(stub(task.taskId));
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result).toMatchObject({
      status: "completed", result: { isError: true, content: [{ type: "text", text: expect.stringContaining("40004") }] },
    });
  });

  it("terminates a catchable storage failure on the final alarm retry", async () => {
    const task = await start();
    await runInDurableObject(stub(task.taskId), (_instance, state) => {
      // Reject the running-state write in real SQLite, but permit terminal
      // writes. This exercises the outer alarm catch, outside tool execution.
      state.storage.sql.exec("CREATE TABLE rejected_running_write (value INTEGER CHECK (value = 1)) STRICT");
      state.storage.sql.exec(`CREATE TRIGGER reject_running_write BEFORE INSERT ON engineering_task
        WHEN NEW.status_message LIKE 'Running %'
        BEGIN INSERT INTO rejected_running_write VALUES (0); END`);
    });
    expect(await stub(task.taskId).deliverAlarmRetry(5)).toContain("CHECK constraint failed");
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result?.status).toBe("working");
    expect(await stub(task.taskId).deliverAlarmRetry(6)).toBeNull();
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result).toMatchObject({
      status: "completed", result: { isError: true, content: [{ type: "text", text: "tool_failed:sqlite_check_constraint" }] },
    });
    await runInDurableObject(stub(task.taskId), async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT kind FROM engineering_task_chunks WHERE kind = 'input'").toArray()).toEqual([]);
      expect(await state.storage.getAlarm()).toBe(Date.now() + 604_800_000);
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
      expect(state.storage.sql.exec("SELECT task_id FROM engineering_task").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT kind FROM engineering_task_payloads").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT kind FROM engineering_task_chunks").toArray()).toEqual([]);
    });
  });

  it("resumes partial retirement after eviction and preserves the operator audit despite cancellation intent", async () => {
    await seedInspectableWorkspace(env.DB, { workspaceId: WORKSPACE, userId: USER,
      sessionId: "00000000-0000-7000-8000-00000000ef72", at: "2026-11-10T00:00:00.000Z" });
    await ensureBillingClosureSchema(env.DB);
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
    const response = await rpc("tools/call", { name: "retire_org", arguments: { orgId: WORKSPACE } }, { encodedName: true });
    expect(response.body.result).toMatchObject({ resultType: "task", status: "working" });
    const task = TaskSnapshotSchema.parse(response.body.result);
    await rpc("tasks/cancel", { taskId: task.taskId });
    await expect(runDurableObjectAlarm(stub(task.taskId))).rejects.toThrow("engineering_retirement_incomplete");
    expect((await rpc("tasks/get", { taskId: task.taskId })).body.result).toMatchObject({
      status: "working", statusMessage: "Retirement incomplete: 1 remaining; retrying",
    });
    // A separate task exhausts the actual platform retry budget while this
    // failed journal write persists. The production handler returns its partial
    // receipt, erases inputs and schedules expiry, then a new call can resume.
    const exhaustedResponse = await rpc("tools/call", { name: "retire_org", arguments: { orgId: WORKSPACE } });
    const exhausted = TaskSnapshotSchema.parse(exhaustedResponse.body.result);
    expect(await stub(exhausted.taskId).deliverAlarmRetry(5)).toBe("engineering_retirement_incomplete");
    expect((await rpc("tasks/get", { taskId: exhausted.taskId })).body.result?.status).toBe("working");
    expect(await stub(exhausted.taskId).deliverAlarmRetry(6)).toBeNull();
    const partial = TaskSnapshotSchema.parse((await rpc("tasks/get", { taskId: exhausted.taskId })).body.result);
    expect(partial.status).toBe("completed");
    expect(partial.result?.isError).toBe(true);
    expect(JSON.parse(partial.result!.content[0]!.text)).toMatchObject({ complete: false, remaining: 1 });
    await runInDurableObject(stub(exhausted.taskId), async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT kind FROM engineering_task_payloads WHERE kind = 'input'").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT kind FROM engineering_task_chunks WHERE kind = 'input'").toArray()).toEqual([]);
      expect(await state.storage.getAlarm()).toBe(Date.now() + 604_800_000);
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
