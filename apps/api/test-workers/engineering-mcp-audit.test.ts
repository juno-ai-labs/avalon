/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Pipeline } from "cloudflare:pipelines";
import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEngineeringMcpHandler } from "../../engineering-mcp/src/index";
import { TASKS_EXTENSION, TaskSnapshotSchema } from "../../engineering-mcp/src/tasks";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import { recordedAuditRows, recordingAuditLakehouse } from "./helpers/recording-audit-lakehouse";

const OPERATOR = { subject: "audit-engineer", email: "audit@example.com", audience: "engineering-mcp" };
const query = { name: "query_data_lake", arguments: { lakehouse: "llm_inference", sql: "SELECT 42 AS answer FROM default.llm_inference" } };

async function rpc(params: Record<string, unknown>, options: { tasks?: boolean; auditLakehouse?: Pipeline | null } = {}) {
  const auditLakehouse = options.auditLakehouse === undefined ? recordingAuditLakehouse : options.auditLakehouse;
  const handler = createEngineeringMcpHandler({
    ENGINEERING_TASKS: env.ENGINEERING_TASKS!,
    ...(auditLakehouse ? { ENGINEERING_AUDIT_LAKEHOUSE: auditLakehouse } : {}),
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

function basinResponse(value: unknown) {
  return Response.json({ success: true, errors: [], result: value });
}

beforeEach(() => {
  recordedAuditRows.length = 0;
  // A task schedules its alarm at Date.now(). On the real clock it fires on its
  // own and races the test; a doubled future clock leaves delivery to the test,
  // as in engineering-mcp-tasks.test.ts.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2050-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("engineering MCP tool-call audit log", () => {
  it("records who called which tool with what arguments, then how the call ended", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));
    await rpc(query);

    const [started, finished, ...rest] = recordedAuditRows;
    expect(rest).toEqual([]);
    expect(started).toMatchObject({
      schema_version: 1,
      event: "tool_call_started",
      occurred_at: "2050-01-01T00:00:00.000Z",
      tool: "query_data_lake",
      actor_subject: "audit-engineer",
      actor_email: "audit@example.com",
      actor_audience: "engineering-mcp",
      arguments: { lakehouse: "llm_inference", sql: "SELECT 42 AS answer FROM default.llm_inference" },
      outcome: null,
    });
    expect(finished).toMatchObject({
      event: "tool_call_finished", tool: "query_data_lake", outcome: "succeeded",
      call_id: started!.call_id, arguments: null, error_code: null,
    });
    expect(started!.event_id).not.toBe(finished!.event_id);
  });

  it("names the reason a tool call failed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ success: false, errors: [{ code: 40004, message: "Invalid query" }] }, { status: 400 }));
    await rpc(query);

    expect(recordedAuditRows[1]).toMatchObject({ event: "tool_call_finished", outcome: "failed", error_code: "lakehouse_query_failed:40004" });
  });

  it("refuses to run a tool whose started row the stream does not accept", async () => {
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));
    const refusing: Pipeline = { send: async () => { throw new Error("Pipeline send failed"); } };

    const result = await rpc(query, { auditLakehouse: refusing });

    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^engineering_audit_unavailable/) }] });
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining("Retry the call. If it keeps failing, check that the stream still exists") }] });
    expect(provider).not.toHaveBeenCalled();
  });

  it("refuses every tool while the audit stream is not provisioned", async () => {
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));

    const result = await rpc(query, { auditLakehouse: null });

    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^engineering_audit_unconfigured:/) }] });
    // The operator who hits this is rarely who deployed, so the refusal names the fix.
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining(
      "`node scripts/ensure-cloudflare-inference-lakehouse.mjs --deploy-bindings` and then `pnpm --filter @rally/engineering-mcp run deploy`",
    ) }] });
    expect(provider).not.toHaveBeenCalled();
  });

  it("links a deferred task's creation to how the task finished", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => basinResponse({ rows: [[42]] }));
    const task = TaskSnapshotSchema.parse(await rpc(query, { tasks: true }));
    expect(await runDurableObjectAlarm(env.ENGINEERING_TASKS!.get(env.ENGINEERING_TASKS!.idFromName(task.taskId)))).toBe(true);

    const [started, created, finished, ...rest] = recordedAuditRows;
    expect(rest).toEqual([]);
    expect(started).toMatchObject({ event: "tool_call_started", tool: "query_data_lake" });
    expect(created).toMatchObject({ event: "tool_call_finished", outcome: "task_created", task_id: task.taskId });
    expect(finished).toMatchObject({
      event: "task_finished", tool: "query_data_lake", task_id: task.taskId, outcome: "succeeded",
      actor_subject: "audit-engineer", call_id: null,
    });
  });
});
