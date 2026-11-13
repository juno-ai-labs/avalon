/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEngineeringMcpHandler } from "../../engineering-mcp/src/index";
import { TASKS_EXTENSION, TaskSnapshotSchema } from "../../engineering-mcp/src/tasks";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";

const OPERATOR = { subject: "audit-engineer", email: "audit@example.com", audience: "engineering-mcp" };
const query = { name: "query_data_lake", arguments: { lakehouse: "llm_inference", sql: "SELECT 42 AS answer FROM default.llm_inference" } };

async function rpc(params: Record<string, unknown>, options: { tasks?: boolean; auditLog?: R2Bucket } = {}) {
  const handler = createEngineeringMcpHandler({
    ENGINEERING_TASKS: env.ENGINEERING_TASKS!,
    ENGINEERING_AUDIT_LOG: options.auditLog ?? env.ENGINEERING_AUDIT_LOG!,
    GLOBAL_INSPECTION: new EngineeringInspectionBridge(createExecutionContext(), env),
    CLOUDFLARE_ACCOUNT_ID: "audit-test-account", BASIN_SQL_API_TOKEN: "test-not-a-credential",
  }, OPERATOR);
  const response = await handler.fetch(new Request("https://mcp.internal.rallywith.ai/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": String(params.name) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "audit-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": options.tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {},
      },
    } }),
  }));
  expect(response.status).toBe(200);
  return (await response.json() as { result: Record<string, unknown> }).result;
}

/** Every record in the bucket, by event. The doubled clock gives them one timestamp. */
async function auditRecords(): Promise<Map<string, Record<string, unknown>>> {
  const listed = await env.ENGINEERING_AUDIT_LOG!.list({ prefix: "tool-calls/2050/01/01/" });
  const records = await Promise.all(listed.objects.map(async ({ key }) =>
    (await env.ENGINEERING_AUDIT_LOG!.get(key))!.json<Record<string, unknown>>()));
  const byEvent = new Map(records.map((record) => [String(record.event), record]));
  expect(byEvent.size, "one record per event").toBe(records.length);
  return byEvent;
}

function basinResponse(value: unknown) {
  return Response.json({ success: true, errors: [], result: value });
}

beforeEach(() => {
  // A task schedules its alarm at Date.now(). On the real clock it fires on its
  // own and races the test; a doubled future clock leaves delivery to the test,
  // as in engineering-mcp-tasks.test.ts.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2050-01-01T00:00:00.000Z"));
});

afterEach(async () => {
  const listed = await env.ENGINEERING_AUDIT_LOG!.list();
  if (listed.objects.length > 0) await env.ENGINEERING_AUDIT_LOG!.delete(listed.objects.map(({ key }) => key));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("engineering MCP tool-call audit log", () => {
  it("records who called which tool with what arguments, then how the call ended", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));
    await rpc(query);

    const records = await auditRecords();
    expect([...records.keys()].sort()).toEqual(["tool_call_finished", "tool_call_started"]);
    const started = records.get("tool_call_started");
    const finished = records.get("tool_call_finished");
    expect(started).toMatchObject({
      schema: "rally.engineering-mcp.audit/v1",
      event: "tool_call_started",
      tool: "query_data_lake",
      actor: { subject: "audit-engineer", email: "audit@example.com", audience: "engineering-mcp" },
      arguments: { lakehouse: "llm_inference", sql: "SELECT 42 AS answer FROM default.llm_inference" },
    });
    expect(finished).toMatchObject({ event: "tool_call_finished", tool: "query_data_lake", outcome: "succeeded", callId: started!.callId });
    expect(finished).not.toHaveProperty("arguments");
    expect(finished).not.toHaveProperty("errorCode");
  });

  it("names the reason a tool call failed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: false, errors: [{ code: 40004, message: "Invalid query" }] }, { status: 400 }));
    await rpc(query);

    const finished = (await auditRecords()).get("tool_call_finished");
    expect(finished).toMatchObject({ event: "tool_call_finished", outcome: "failed", errorCode: "lakehouse_query_failed:40004" });
  });

  it("refuses to run a tool whose started record cannot be written", async () => {
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));
    // Real R2 cannot be made to refuse a write; this binding forwards every
    // other call to it and fails the one the guard depends on.
    const refusing = new Proxy(env.ENGINEERING_AUDIT_LOG!, {
      get(target, property) {
        if (property === "put") return async () => { throw new Error("R2 put failed (10001)"); };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await rpc(query, { auditLog: refusing });

    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^engineering_audit_unavailable:/) }] });
    expect(provider).not.toHaveBeenCalled();
    expect((await auditRecords()).size).toBe(0);
  });

  it("links a deferred task's creation to how the task finished", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));
    const task = TaskSnapshotSchema.parse(await rpc(query, { tasks: true }));
    expect(await runDurableObjectAlarm(env.ENGINEERING_TASKS!.get(env.ENGINEERING_TASKS!.idFromName(task.taskId)))).toBe(true);

    const records = await auditRecords();
    expect([...records.keys()].sort()).toEqual(["task_finished", "tool_call_finished", "tool_call_started"]);
    const started = records.get("tool_call_started");
    const created = records.get("tool_call_finished");
    const finished = records.get("task_finished");
    expect(started).toMatchObject({ event: "tool_call_started", tool: "query_data_lake" });
    expect(created).toMatchObject({ event: "tool_call_finished", outcome: "task_created", taskId: task.taskId });
    expect(finished).toMatchObject({
      event: "task_finished", tool: "query_data_lake", taskId: task.taskId, outcome: "succeeded",
      actor: { subject: "audit-engineer" },
    });
  });
});
