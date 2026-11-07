import "../../../tests/isolated-region";
import { describe, expect, it, vi } from "vitest";

import { asArtifactId, asAutomationId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { EngineeringInspectionRpcBinding } from "@rally/contracts/engineering-inspection";

import { MANAGED_FLAGS, type FlagAdministrationRpc } from "../../ace/src/protocol";
import type { AccessPrincipal } from "../src/access";
import type { Env } from "../src/env";
import { createEngineeringMcpHandler } from "../src/index";
import hostedClients from "../hosted-clients.json";

const principal: AccessPrincipal = {
  subject: "engineer-1",
  email: "engineer@rallywith.ai",
  audience: "engineering-mcp-audience",
};

function regionalBinding(region: string): EngineeringInspectionRpcBinding {
  return {
    createOrg: vi.fn<EngineeringInspectionRpcBinding["createOrg"]>(),
    sendMessage: vi.fn<EngineeringInspectionRpcBinding["sendMessage"]>(),
    setSidekickPaused: vi.fn<EngineeringInspectionRpcBinding["setSidekickPaused"]>(),
    dumpThreadTranscripts: vi.fn<EngineeringInspectionRpcBinding["dumpThreadTranscripts"]>(),
    retireThreads: vi.fn<EngineeringInspectionRpcBinding["retireThreads"]>(),
    retireOrg: vi.fn<EngineeringInspectionRpcBinding["retireOrg"]>(),
    readConversation: vi.fn<EngineeringInspectionRpcBinding["readConversation"]>(),
    listWorkspaces: vi.fn<EngineeringInspectionRpcBinding["listWorkspaces"]>(
      async () => ({ region, items: [] }),
    ),
    searchOrganizations: vi.fn<EngineeringInspectionRpcBinding["searchOrganizations"]>(
      async () => ({ region, items: [] }),
    ),
    searchUsers: vi.fn<EngineeringInspectionRpcBinding["searchUsers"]>(
      async () => ({ region, items: [] }),
    ),
    listCanvases: vi.fn<EngineeringInspectionRpcBinding["listCanvases"]>(
      async () => ({ found: false }),
    ),
    listSidekicks: vi.fn<EngineeringInspectionRpcBinding["listSidekicks"]>(
      async () => ({ found: false }),
    ),
    listArtifacts: vi.fn<EngineeringInspectionRpcBinding["listArtifacts"]>(
      async () => ({ found: false }),
    ),
    resolveWorkspace: vi.fn<EngineeringInspectionRpcBinding["resolveWorkspace"]>(
      async () => ({ found: false }),
    ),
    resolveConversation: vi.fn<EngineeringInspectionRpcBinding["resolveConversation"]>(
      async () => ({ found: false }),
    ),
    resolveArtifact: vi.fn<EngineeringInspectionRpcBinding["resolveArtifact"]>(
      async () => ({ found: false }),
    ),
    runWorkspaceSql: vi.fn<EngineeringInspectionRpcBinding["runWorkspaceSql"]>(
      async () => ({ found: false }),
    ),
    runConversationSql: vi.fn<EngineeringInspectionRpcBinding["runConversationSql"]>(
      async () => ({ found: false }),
    ),
    runArtifactSql: vi.fn<EngineeringInspectionRpcBinding["runArtifactSql"]>(
      async () => ({ found: false }),
    ),
    runD1Sql: vi.fn<EngineeringInspectionRpcBinding["runD1Sql"]>(
      async ({ database }) => ({ region, database, result: { columns: [], rows: [], rowsRead: 0, rowsWritten: 0 } }),
    ),
  };
}

function flagAdministration(): FlagAdministrationRpc {
  return {
    listProductFlags: vi.fn<FlagAdministrationRpc["listProductFlags"]>(async () => ({ ok: true, value: [] })),
    updateProductFlag: vi.fn<FlagAdministrationRpc["updateProductFlag"]>(async () => ({ ok: true, value: null })),
    listModelFlags: vi.fn<FlagAdministrationRpc["listModelFlags"]>(async () => ({ ok: true, value: [] })),
    updateModelRouting: vi.fn<FlagAdministrationRpc["updateModelRouting"]>(async () => ({ ok: true, value: null })),
  };
}

function testEnv(bindings: Partial<Env> = {}): Env {
  return {
    GLOBAL_INSPECTION: regionalBinding("global"),
    ENTERPRISE_INSPECTION: regionalBinding("enterprise"),
    FLAG_ADMINISTRATION: flagAdministration(),
    CLOUDFLARE_ACCOUNT_ID: "account-1",
    BASIN_SQL_API_TOKEN: "basin-token",
    WORKERS_OBSERVABILITY_API_TOKEN: "observability-token",
    ...bindings,
  };
}

async function rpc(
  env: Env,
  method: string,
  params: unknown = {},
  origin?: string,
): Promise<Record<string, unknown>> {
  const handler = createEngineeringMcpHandler(env, principal, "json");
  const response = await handler.fetch(new Request("https://mcp.internal.rallywith.ai/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  expect(response.status).toBe(200);
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? body;
  return JSON.parse(data) as Record<string, unknown>;
}

describe("Rally engineering MCP tools", () => {
  it("advertises its purpose and usage instructions in initialization", async () => {
    const response = await rpc(testEnv({ GLOBAL_INSPECTION: regionalBinding("global") }), "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Rally", version: "1" },
    });
    expect(response.result).toMatchObject({ serverInfo: {
      name: "Rally engineering",
      description: "Inspect and administer Rally organizations, Canvases, Sidekicks and artifacts. Read production databases, inference data and Worker logs; manage feature flags and model routing; create organizations and send messages as a selected Rally user.",
    } });
    const instructions = (response.result as { instructions: string }).instructions;
    expect(instructions).toContain("a Sidekick is an automation");
    expect(instructions).not.toContain("Thread");
    expect(instructions).toContain("reuse the same operationId and arguments after an uncertain outcome");
    expect(instructions).toContain("Never expose credentials");
  });

  it.each([["read_canvas_chat", "canvas", "canvasId"], ["read_sidekick_conversation", "sidekick", "sidekickId"]] as const)("returns unquoted participant text from %s in the authoritative region", async (name, kind, idKey) => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const orgId = asWorkspaceId("00000000-0000-7000-8000-000000000ef1");
    vi.mocked(enterprise.resolveWorkspace).mockResolvedValue({ found: true, value: { workspaceId: orgId, region: "enterprise", authorityGeneration: 1 } });
    vi.mocked(enterprise.readConversation).mockResolvedValue({ text: "Canvas: Releases\n\nMaya: Ready." });
    const viewer = { orgId, userId: asUserId("00000000-0000-7000-8000-000000000ef2") };
    const conversationId = "00000000-0000-7000-8000-000000000ef4";
    const response = await rpc(testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }), "tools/call",
      { name, arguments: { ...viewer, [idKey]: conversationId } });
    expect(response.result).toMatchObject({ content: [{ type: "text", text: "Canvas: Releases\n\nMaya: Ready." }] });
    expect(enterprise.readConversation).toHaveBeenCalledExactlyOnceWith({ ...viewer, kind, conversationId, afterSequence: 0 });
    expect(global.readConversation).not.toHaveBeenCalled();
  });

  it("routes composer input unchanged and keeps message text out of audit logs", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const orgId = asWorkspaceId("00000000-0000-7000-8000-000000000ef1");
    const operationId = "00000000-0000-7000-8000-000000000ef3";
    vi.mocked(enterprise.resolveWorkspace).mockResolvedValue({ found: true, value: { workspaceId: orgId, region: "enterprise", authorityGeneration: 1 } });
    vi.mocked(enterprise.sendMessage).mockResolvedValue({ receipt: { turn: { turnId: "turn-1", clientMessageId: operationId, createdAt: "2026-10-21T00:00:00.000Z" }, deliveryState: "pending" } });
    const request = { orgId, operationId, userId: asUserId("00000000-0000-7000-8000-000000000ef2"),
      conversationId: "00000000-0000-7000-8000-000000000ef4", text: "Confidential message", runMode: "queue" };
    const audit = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await rpc(testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }), "tools/call", { name: "send_message", arguments: request });
      expect(response.result).not.toHaveProperty("isError", true);
      expect(enterprise.sendMessage).toHaveBeenCalledExactlyOnceWith({ ...request, mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] }, principal);
      expect(global.sendMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(audit.mock.calls)).not.toContain(request.text);
    } finally {
      audit.mockRestore();
    }
  });

  it.each([["pause_sidekick", true], ["resume_sidekick", false]] as const)("routes %s to the Organization's region as the trusted operator", async (name, paused) => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const orgId = asWorkspaceId("00000000-0000-7000-8000-000000000ef1");
    const sidekickId = asAutomationId("00000000-0000-7000-8000-000000000ef6");
    vi.mocked(enterprise.resolveWorkspace).mockResolvedValue({ found: true, value: { workspaceId: orgId, region: "enterprise", authorityGeneration: 1 } });
    vi.mocked(enterprise.setSidekickPaused).mockResolvedValue({ region: "enterprise", orgId, sidekickId, lifecycle: paused ? "paused" : "active" });
    const request = { orgId, userId: asUserId("00000000-0000-7000-8000-000000000ef2"), sidekickId };
    const response = await rpc(testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }), "tools/call", { name, arguments: request });
    expect(response.result).not.toHaveProperty("isError", true);
    expect(response.result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining(`"lifecycle": "${paused ? "paused" : "active"}"`) }] });
    expect(enterprise.setSidekickPaused).toHaveBeenCalledExactlyOnceWith({ ...request, paused }, principal);
    expect(global.setSidekickPaused).not.toHaveBeenCalled();
  });

  it("retires an Organization only in the region that owns it, as the trusted operator", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const orgId = asWorkspaceId("00000000-0000-7000-8000-000000000ef1");
    vi.mocked(enterprise.resolveWorkspace).mockResolvedValue({ found: true, value: { workspaceId: orgId, region: "enterprise", authorityGeneration: 1 } });
    vi.mocked(enterprise.retireOrg).mockResolvedValue({
      region: "enterprise", workspaceId: orgId, complete: false, remaining: 2, parents: 3,
      retiredParents: 1, retiredChildren: 1, retainedOutbox: 0,
      failed: [{ parentKind: "workstream", parentId: "00000000-0000-7000-8000-000000000ef4", error: "child_unreachable" }],
    });
    const response = await rpc(testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }), "tools/call", { name: "retire_org", arguments: { orgId } });
    expect(response.result).not.toHaveProperty("isError", true);
    expect(response.result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining('"remaining": 2') }] });
    expect(enterprise.retireOrg).toHaveBeenCalledExactlyOnceWith({ orgId }, principal);
    expect(global.retireOrg).not.toHaveBeenCalled();
  });

  it("publishes retire_org as destructive", async () => {
    const response = await rpc(testEnv(), "tools/list");
    const tools = (response.result as { tools: Array<{ name: string; annotations?: Record<string, boolean> }> }).tools;
    expect(tools.find((entry) => entry.name === "retire_org")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("routes dump_thread_transcripts to the Organization's region only when confirm names it", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const orgId = asWorkspaceId("00000000-0000-7000-8000-000000000ef1");
    vi.mocked(enterprise.resolveWorkspace).mockResolvedValue({ found: true, value: { workspaceId: orgId, region: "enterprise", authorityGeneration: 1 } });
    vi.mocked(enterprise.dumpThreadTranscripts).mockResolvedValue({ region: "enterprise", orgId, conversations: 3, dumped: 2, skipped: 1,
      failed: [{ parentKind: "workstream", parentId: "thread-1", substreamId: "0", error: "thread_transcript_identity_mismatch" }] });
    const env = testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise });

    const refused = await rpc(env, "tools/call", { name: "dump_thread_transcripts", arguments: { orgId, confirm: "00000000-0000-7000-8000-000000000ef9" } });
    expect(refused.result).toMatchObject({ isError: true, content: [{ type: "text", text: "confirm must equal orgId; nothing was changed" }] });
    expect(enterprise.resolveWorkspace).not.toHaveBeenCalled();

    const response = await rpc(env, "tools/call", { name: "dump_thread_transcripts", arguments: { orgId, confirm: orgId } });
    expect(response.result).not.toHaveProperty("isError", true);
    expect(JSON.parse((response.result as { content: Array<{ text: string }> }).content[0]!.text)).toEqual({
      region: "enterprise", orgId, conversations: 3, dumped: 2, skipped: 1,
      failed: [{ parentKind: "workstream", parentId: "thread-1", substreamId: "0", error: "thread_transcript_identity_mismatch" }],
    });
    expect(enterprise.dumpThreadTranscripts).toHaveBeenCalledExactlyOnceWith({ orgId, confirm: orgId }, principal);
    expect(global.dumpThreadTranscripts).not.toHaveBeenCalled();
  });

  it("publishes the dump as an idempotent write and the retirement as a destructive one, each taking a confirmation", async () => {
    const response = await rpc(testEnv(), "tools/list");
    const tools = (response.result as { tools: Array<{ name: string; inputSchema: { required?: string[] }; annotations?: Record<string, boolean> }> }).tools;
    const dump = tools.find((item) => item.name === "dump_thread_transcripts");
    const retire = tools.find((item) => item.name === "retire_threads");
    expect(dump?.inputSchema.required).toEqual(["orgId", "confirm"]);
    expect(dump?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(retire?.inputSchema.required).toEqual(["orgId", "confirm"]);
    expect(retire?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it("routes retire_threads to the Organization's region only when confirm names it", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const orgId = asWorkspaceId("00000000-0000-7000-8000-000000000ef1");
    vi.mocked(enterprise.resolveWorkspace).mockResolvedValue({ found: true, value: { workspaceId: orgId, region: "enterprise", authorityGeneration: 1 } });
    vi.mocked(enterprise.retireThreads).mockResolvedValue({ region: "enterprise", orgId, parents: 2, conversations: 3,
      retiredParents: 2, retiredConversations: 3, retainedOutbox: 0, failed: [] });
    const env = testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise });

    const refused = await rpc(env, "tools/call", { name: "retire_threads", arguments: { orgId, confirm: "Acme" } });
    expect(refused.result).toMatchObject({ isError: true, content: [{ type: "text", text: "confirm must equal orgId; nothing was changed" }] });
    expect(enterprise.retireThreads).not.toHaveBeenCalled();

    const response = await rpc(env, "tools/call", { name: "retire_threads", arguments: { orgId, confirm: orgId } });
    expect(JSON.parse((response.result as { content: Array<{ text: string }> }).content[0]!.text)).toEqual({
      region: "enterprise", orgId, parents: 2, conversations: 3, retiredParents: 2, retiredConversations: 3, retainedOutbox: 0, failed: [],
    });
    expect(enterprise.retireThreads).toHaveBeenCalledExactlyOnceWith({ orgId, confirm: orgId }, principal);
    expect(global.retireThreads).not.toHaveBeenCalled();
  });

  it("sends Organization creation to only the named region", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const request = { operationId: "00000000-0000-7000-8000-000000000ef1", region: "enterprise",
      creatorUserId: asUserId("00000000-0000-7000-8000-000000000ef2"), name: "New team", userIds: [] };
    vi.mocked(enterprise.createOrg).mockResolvedValue({ region: "enterprise", orgId: asWorkspaceId(request.operationId), userIds: [request.creatorUserId] });
    const response = await rpc(testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }), "tools/call", { name: "create_org", arguments: request });
    expect(response.result).not.toHaveProperty("isError", true);
    expect(enterprise.createOrg).toHaveBeenCalledExactlyOnceWith(request, principal);
    expect(global.createOrg).not.toHaveBeenCalled();
  });

  it("refuses ambiguous Organization routing before a message is sent", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const orgId = asWorkspaceId("00000000-0000-7000-8000-000000000ef1");
    for (const binding of [global, enterprise]) {
      vi.mocked(binding.resolveWorkspace).mockResolvedValue({ found: true, value: { workspaceId: orgId, region: "global", authorityGeneration: 1 } });
    }
    const response = await rpc(testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }), "tools/call", {
      name: "send_message", arguments: { operationId: "00000000-0000-7000-8000-000000000ef3", orgId,
        userId: "00000000-0000-7000-8000-000000000ef2", conversationId: "00000000-0000-7000-8000-000000000ef4", text: "Plan the release." },
    });
    expect(response.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("must resolve to one region") }] });
    for (const binding of [global, enterprise]) expect(binding.sendMessage).not.toHaveBeenCalled();
  });

  it.each(hostedClients.originHostnames)("admits the %s hosted origin to the MCP transport", async (hostname) => {
    const env = testEnv();

    const response = await rpc(env, "tools/list", {}, `https://${hostname}`);
    expect(response.result).toMatchObject({ tools: expect.any(Array) });
  });

  it("publishes every inventory and SQL tool with mutation annotations on SQL", async () => {
    const env = testEnv();

    const response = await rpc(env, "tools/list");
    const result = response.result as { tools: Array<{ name: string; annotations?: Record<string, boolean> }> };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "create_org",
      "send_message",
      "pause_sidekick",
      "resume_sidekick",
      "retire_org",
      "dump_thread_transcripts",
      "retire_threads",
      "read_canvas_chat",
      "read_sidekick_conversation",
      "list_workspaces",
      "list_orgs",
      "search_orgs",
      "list_users",
      "search_users",
      "list_canvases",
      "list_sidekicks",
      "list_artifacts",
      "run_workspace_sql",
      "run_canvas_sql",
      "run_artifact_sql",
      "run_d1_sql",
      "list_feature_flags",
      "update_feature_flag",
      "list_model_flags",
      "update_model_flag",
      "query_data_lake",
      "query_worker_observability",
    ]);
    for (const tool of result.tools.filter((item) => /^(run|update)_/.test(item.name))) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const tool of result.tools.filter((item) => /^create_/.test(item.name))) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
  });

  it("combines both regional workspace inventories", async () => {
    const workspace = {
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000eb1"),
      name: "Global workspace",
      slug: "global-workspace",
      region: "global" as const,
      placementAffinity: "wnam",
      authorityState: "active",
    };
    const global = regionalBinding("global");
    vi.mocked(global.listWorkspaces).mockResolvedValue({ region: "global", items: [workspace] });
    const env = testEnv({ GLOBAL_INSPECTION: global });

    const response = await rpc(env, "tools/call", {
      name: "list_workspaces",
      arguments: {},
    });
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toEqual([workspace]);
    expect(global.listWorkspaces).toHaveBeenCalledWith({});
  });

  it("refuses an identity that resolves in both regional authorities", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb2");
    const value = { region: "global" as const, workspaceId, items: [] };
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.listCanvases).mockResolvedValue({ found: true, value });
    vi.mocked(enterprise.listCanvases).mockResolvedValue({
      found: true,
      value: { ...value, region: "enterprise" },
    });

    const response = await rpc(
      testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }),
      "tools/call",
      { name: "list_canvases", arguments: { workspaceId } },
    );
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("exists in multiple Rally regions");
  });

  it("logs why a tool failed by code, and keeps the error's text off the log", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000ec1");
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.listCanvases).mockResolvedValue({ found: false });
    vi.mocked(enterprise.listCanvases).mockRejectedValue(
      new Error("D1_ERROR: no such column: Customer_Email: SQLITE_ERROR"),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await rpc(
        testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }),
        "tools/call",
        { name: "list_canvases", arguments: { workspaceId } },
      );
      vi.mocked(enterprise.listCanvases).mockResolvedValue({ found: false });
      await rpc(
        testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }),
        "tools/call",
        { name: "list_canvases", arguments: { workspaceId } },
      );
      const rows = logged.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
        .filter((row) => row.event === "engineering_mcp_tool_failed");
      expect(rows.map((row) => row.error_code)).toEqual(["tool_failed:sqlite_no_such_column", "target_not_found"]);
      expect(JSON.stringify(rows)).not.toContain("Customer_Email");
    } finally {
      logged.mockRestore();
    }
  });

  it("serves each inventory tool from the one region that resolves it", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000ebb");
    const sidekickId = asAutomationId("00000000-0000-7000-8000-000000000ebc");
    const artifactId = asArtifactId("00000000-0000-7000-8000-000000000ebd");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000ebe");
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.listSidekicks).mockResolvedValue({
      found: true,
      value: {
        region: "global",
        workspaceId,
        items: [{
          workspaceId,
          sidekickId,
          region: "global",
          lifecycle: "paused",
          scope: "personal",
          owningWorkstreamId: null,
          title: "Standup digest",
          nextRunAt: null,
          projectedAt: 1_700_000_000_000,
        }],
      },
    });
    vi.mocked(global.listArtifacts).mockResolvedValue({
      found: true,
      value: {
        region: "global",
        workspaceId,
        items: [{
          workspaceId,
          artifactId,
          region: "global",
          workstreamId,
          resourceId: "resource-1",
          mode: "active",
          stateful: true,
          currentVersion: 2,
          hostnameStub: "quiet-amber-fox-run",
          updatedAt: 1_700_000_000_000,
        }],
      },
    });
    const env = testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise });

    const sidekicks = await rpc(env, "tools/call", {
      name: "list_sidekicks",
      arguments: { workspaceId },
    });
    expect(JSON.parse((sidekicks.result as { content: Array<{ text: string }> }).content[0]!.text))
      .toMatchObject({ region: "global", items: [{ sidekickId, lifecycle: "paused" }] });
    expect(global.listSidekicks).toHaveBeenCalledWith({ workspaceId });
    expect(enterprise.listSidekicks).toHaveBeenCalledWith({ workspaceId });

    const artifacts = await rpc(env, "tools/call", {
      name: "list_artifacts",
      arguments: { workspaceId },
    });
    expect(JSON.parse((artifacts.result as { content: Array<{ text: string }> }).content[0]!.text))
      .toMatchObject({ region: "global", items: [{ artifactId, stateful: true, currentVersion: 2 }] });
    expect(global.listArtifacts).toHaveBeenCalledWith({ workspaceId });
  });

  it("refuses an inventory target that resolves in more than one region", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000ebf");
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const value = { region: "global" as const, workspaceId, items: [] };
    vi.mocked(global.listArtifacts).mockResolvedValue({ found: true, value });
    vi.mocked(enterprise.listArtifacts).mockResolvedValue({
      found: true,
      value: { ...value, region: "enterprise" },
    });

    const response = await rpc(
      testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }),
      "tools/call",
      { name: "list_artifacts", arguments: { workspaceId } },
    );
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("exists in multiple Rally regions");
  });

  it("routes bound Canvas SQL to exactly one regional authority", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb3");
    const conversationId = "00000000-0000-7000-8000-000000000eb4";
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(enterprise.resolveConversation).mockResolvedValue({
      found: true,
      value: {
        region: "enterprise",
        workspaceId,
        conversationId,
        authorityGeneration: 7,
      },
    });
    vi.mocked(enterprise.runConversationSql).mockResolvedValue({
      found: true,
      value: {
        region: "enterprise",
        workspaceId,
        workstreamId: asWorkstreamId(conversationId),
        substreamId: asSubstreamId("0"),
        result: {
          columns: ["answer"],
          rows: [{ answer: 42 }],
          rowsRead: 1,
          rowsWritten: 0,
        },
      },
    });

    const response = await rpc(
      testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }),
      "tools/call",
      {
        name: "run_canvas_sql",
        arguments: {
          workspaceId,
          conversationId,
          sql: "SELECT ? AS answer",
          bindings: [42],
        },
      },
    );
    const result = response.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      region: "enterprise",
      result: { rows: [{ answer: 42 }] },
    });
    expect(enterprise.runConversationSql).toHaveBeenCalledWith({
      workspaceId,
      conversationId,
      authorityGeneration: 7,
      query: { sql: "SELECT ? AS answer", bindings: [42] },
    });
    expect(global.runConversationSql).not.toHaveBeenCalled();
    expect(enterprise.runConversationSql).toHaveBeenCalledTimes(1);
  });

  it("routes bound artifact SQL to the supervisor in exactly one regional authority", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb9");
    const artifactId = asArtifactId("00000000-0000-7000-8000-000000000eba");
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(enterprise.resolveArtifact).mockResolvedValue({
      found: true,
      value: { region: "enterprise", workspaceId, artifactId, authorityGeneration: 9 },
    });
    vi.mocked(enterprise.runArtifactSql).mockResolvedValue({
      found: true,
      value: {
        region: "enterprise",
        workspaceId,
        workstreamId: null,
        substreamId: null,
        artifactId,
        result: {
          columns: ["current_version"],
          rows: [{ current_version: 3 }],
          rowsRead: 1,
          rowsWritten: 0,
        },
      },
    });

    const response = await rpc(
      testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }),
      "tools/call",
      {
        name: "run_artifact_sql",
        arguments: { workspaceId, artifactId, sql: "SELECT current_version FROM artifact_state" },
      },
    );
    const result = response.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      region: "enterprise",
      artifactId,
      result: { rows: [{ current_version: 3 }] },
    });
    expect(enterprise.runArtifactSql).toHaveBeenCalledWith({
      workspaceId,
      artifactId,
      authorityGeneration: 9,
      query: { sql: "SELECT current_version FROM artifact_state", bindings: [] },
    });
    expect(global.runArtifactSql).not.toHaveBeenCalled();
  });

  it.each(["TELEMETRY_DB", "MESSAGE_ISSUES_DB"] as const)("sends %s SQL to the named region's binding only", async (database) => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(enterprise.runD1Sql).mockResolvedValue({
      region: "enterprise",
      database,
      result: { columns: ["answer"], rows: [{ answer: 42 }], rowsRead: 1, rowsWritten: 0 },
    });

    const response = await rpc(
      testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }),
      "tools/call",
      {
        name: "run_d1_sql",
        arguments: { region: "enterprise", database, sql: "SELECT ? AS answer", bindings: [42] },
      },
    );
    const result = response.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      region: "enterprise",
      database,
      result: { columns: ["answer"], rows: [{ answer: 42 }], rowsRead: 1, rowsWritten: 0 },
    });
    expect(enterprise.runD1Sql).toHaveBeenCalledWith({
      database,
      query: { sql: "SELECT ? AS answer", bindings: [42] },
    });
    expect(global.runD1Sql).not.toHaveBeenCalled();
  });

  it("does not execute SQL when both regions resolve the target", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb5");
    const conversationId = "00000000-0000-7000-8000-000000000eb6";
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.resolveConversation).mockResolvedValue({
      found: true,
      value: {
        region: "global",
        workspaceId,
        conversationId,
        authorityGeneration: 7,
      },
    });
    vi.mocked(enterprise.resolveConversation).mockResolvedValue({
      found: true,
      value: {
        region: "enterprise",
        workspaceId,
        conversationId,
        authorityGeneration: 7,
      },
    });

    const response = await rpc(
      testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise }),
      "tools/call",
      {
        name: "run_canvas_sql",
        arguments: {
          workspaceId,
          conversationId,
          sql: "DELETE FROM fixture",
        },
      },
    );
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("must resolve to one region");
    expect(global.runConversationSql).not.toHaveBeenCalled();
    expect(enterprise.runConversationSql).not.toHaveBeenCalled();
  });

  it("lists managed flags through Ace", async () => {
    const flags = flagAdministration();
    vi.mocked(flags.listProductFlags).mockResolvedValue({
      ok: true,
      value: [{
        ...MANAGED_FLAGS.find((flag) => flag.key === "push-notifications-enabled")!,
        flag: { key: "push-notifications-enabled", enabled: true, default_variation: "on", rules: [] },
      }],
    });
    const env = testEnv({ FLAG_ADMINISTRATION: flags });

    const response = await rpc(env, "tools/call", { name: "list_feature_flags", arguments: {} });
    const result = response.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toEqual([expect.objectContaining({
      key: "push-notifications-enabled",
      label: "Push Notifications Enabled",
      defaultVariation: "on",
      flag: { key: "push-notifications-enabled", enabled: true, default_variation: "on", rules: [] },
    })]);
  });

  it("hands a flag definition to Ace with the engineer it acts for", async () => {
    const flags = flagAdministration();
    vi.mocked(flags.updateProductFlag).mockResolvedValue({
      ok: true,
      value: { key: "multiple-workspaces-enabled", default_variation: "on" },
    });
    const env = testEnv({ FLAG_ADMINISTRATION: flags });
    const update = {
      key: "multiple-workspaces-enabled",
      description: "Multiple workspaces.",
      enabled: true,
      default_variation: "off",
      rules: [{
        priority: 1,
        conditions: [{ attribute: "userEmailDomain", operator: "equals", value: "rallywith.ai" }],
        serve_variation: "on",
      }],
    };

    const response = await rpc(env, "tools/call", { name: "update_feature_flag", arguments: update });
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ key: "multiple-workspaces-enabled", default_variation: "on" });
    expect(flags.updateProductFlag).toHaveBeenCalledWith({
      actor: { subject: "engineer-1" },
      update,
    });
  });

  it("rejects a flag the catalog does not manage before reaching Ace", async () => {
    const flags = flagAdministration();
    const env = testEnv({ FLAG_ADMINISTRATION: flags });

    const response = await rpc(env, "tools/call", {
      name: "update_feature_flag",
      arguments: { key: "unmanaged-enabled", description: "", enabled: true, default_variation: "on", rules: [] },
    });
    const result = response.result as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(flags.updateProductFlag).not.toHaveBeenCalled();
  });

  it("returns Ace's refusal to the engineer and logs it by Ace's code", async () => {
    const flags = flagAdministration();
    vi.mocked(flags.updateModelRouting).mockResolvedValue({
      ok: false,
      code: "invalid_openrouter_models",
      message: "OpenRouter does not recognize or currently route: example/missing",
    });
    const env = testEnv({ FLAG_ADMINISTRATION: flags });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await rpc(env, "tools/call", {
      name: "update_model_flag",
      arguments: { role: "workstream", routing: { model: "example/missing", fallbackModels: [], reasoningEffort: "low" } },
    });
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("OpenRouter does not recognize or currently route: example/missing");
    const rows = logged.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(rows).toEqual([expect.objectContaining({
      event: "engineering_mcp_tool_failed",
      tool: "update_model_flag",
      agent_role: "workstream",
      error_code: "invalid_openrouter_models",
    })]);
    expect(flags.updateModelRouting).toHaveBeenCalledWith({
      actor: { subject: "engineer-1" },
      update: { role: "workstream", routing: { model: "example/missing", fallbackModels: [], reasoningEffort: "low" } },
    });
  });

  it("sends a lakehouse query to the table's own catalog bucket and returns Basin SQL's result", async () => {
    const result = {
      schema: [{ name: "event_id" }],
      rows: [{ event_id: "inference-1:request" }],
      metrics: { bytes_scanned: 1024, files_scanned: 1 },
    };
    const basin = vi.fn<typeof fetch>(async () => Response.json({ success: true, errors: [], result }));
    vi.stubGlobal("fetch", basin);

    const response = await rpc(testEnv(), "tools/call", {
      name: "query_data_lake",
      arguments: { lakehouse: "llm_inference", sql: "SELECT event_id FROM avalon.llm_inference LIMIT 1" },
    });
    const toolResult = response.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(toolResult.isError).toBeUndefined();
    expect(JSON.parse(toolResult.content[0]!.text)).toEqual(result);
    const [url, init] = basin.mock.calls[0]!;
    expect(url).toBe(
      "https://api.sql.cloudflarestorage.com/api/v1/accounts/account-1/basin-sql/query/avalon-global-inference-lakehouse",
    );
    expect(init?.headers).toMatchObject({ Authorization: "Bearer basin-token" });
    expect(JSON.parse(String(init?.body))).toEqual({ query: "SELECT event_id FROM avalon.llm_inference LIMIT 1" });
  });

  it("returns Basin SQL's refusal to the engineer and logs only its code", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({
      success: false,
      errors: [{ code: 40004, message: "unknown column customer_email" }],
    }, { status: 400 })));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await rpc(testEnv(), "tools/call", {
      name: "query_data_lake",
      arguments: { lakehouse: "usage_events", sql: "SELECT customer_email FROM avalon.usage_events" },
    });
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("40004: unknown column customer_email");
    const rows = logged.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(rows).toEqual([expect.objectContaining({
      event: "engineering_mcp_tool_failed",
      tool: "query_data_lake",
      lakehouse: "usage_events",
      error_code: "lakehouse_query_failed:40004",
    })]);
    expect(JSON.stringify(rows)).not.toContain("customer_email");
  });

  it("refuses a lakehouse query without a token before calling Basin SQL", async () => {
    const basin = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", basin);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const env = testEnv();
    delete env.BASIN_SQL_API_TOKEN;

    const response = await rpc(env, "tools/call", {
      name: "query_data_lake",
      arguments: { lakehouse: "analytics_events", sql: "SELECT 1" },
    });
    const result = response.result as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(basin).not.toHaveBeenCalled();
    expect(logged.mock.calls.map((call) => JSON.parse(String(call[0])).error_code))
      .toEqual(["lakehouse_token_unconfigured"]);
  });

  it("sends a Workers Observability query for the window and returns Cloudflare's result", async () => {
    const result = { traces: [{ traceId: "trace-1", rootSpanName: "fetch" }] };
    const cloudflare = vi.fn<typeof fetch>(async () => Response.json({ success: true, errors: [], result }));
    vi.stubGlobal("fetch", cloudflare);
    const filters = [
      { key: "$metadata.service", operation: "eq", type: "string", value: "avalon-api-global" },
      { kind: "group", filterCombination: "or", filters: [{ key: "level", operation: "eq", type: "string", value: "error" }] },
    ];

    const response = await rpc(testEnv(), "tools/call", {
      name: "query_worker_observability",
      arguments: {
        view: "traces",
        from: "2026-10-19T10:00:00Z",
        to: "2026-10-19T11:00:00+00:00",
        filters,
        needle: "timeout",
        limit: 50,
      },
    });
    const toolResult = response.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(toolResult.isError).toBeUndefined();
    expect(JSON.parse(toolResult.content[0]!.text)).toEqual(result);
    const [url, init] = cloudflare.mock.calls[0]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-1/workers/observability/telemetry/query",
    );
    expect(init?.headers).toMatchObject({ Authorization: "Bearer observability-token" });
    expect(JSON.parse(String(init?.body))).toEqual({
      queryId: "rally-engineering-mcp",
      view: "traces",
      dry: true,
      timeframe: { from: 1792404000000, to: 1792407600000 },
      limit: 50,
      parameters: { filters, needle: { value: "timeout" }, limit: 50 },
    });
  });

  it("returns a Workers Observability refusal to the engineer and logs only its code", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
    }, { status: 403 })));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await rpc(testEnv(), "tools/call", {
      name: "query_worker_observability",
      arguments: { view: "events", from: "2026-10-19T10:00:00Z", needle: "wks_secret" },
    });
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("10000: Authentication error");
    const rows = logged.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(rows).toEqual([expect.objectContaining({
      event: "engineering_mcp_tool_failed",
      tool: "query_worker_observability",
      view: "events",
      error_code: "observability_query_failed:10000",
    })]);
    expect(JSON.stringify(rows)).not.toContain("wks_secret");
  });

  it("refuses a Workers Observability query without a token before calling Cloudflare", async () => {
    const cloudflare = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", cloudflare);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const env = testEnv();
    delete env.WORKERS_OBSERVABILITY_API_TOKEN;

    const response = await rpc(env, "tools/call", {
      name: "query_worker_observability",
      arguments: { view: "events", from: "2026-10-19T10:00:00Z" },
    });
    expect((response.result as { isError: boolean }).isError).toBe(true);
    expect(cloudflare).not.toHaveBeenCalled();
    expect(logged.mock.calls.map((call) => JSON.parse(String(call[0])).error_code))
      .toEqual(["observability_token_unconfigured"]);
  });

  function organization(
    id: string,
    name: string,
    createdAt: string,
    memberCount: number,
    lastSeenAt: string | null,
    region: "global" | "enterprise",
  ) {
    return {
      workspaceId: asWorkspaceId(id),
      name,
      slug: name.toLowerCase(),
      region,
      plan: "starter",
      createdAt,
      abandonedAt: null,
      memberCount,
      lastSeenAt,
    };
  }

  it("orders Organizations from both regions as one set, never-seen last, and takes the first N", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.searchOrganizations).mockResolvedValue({ region: "global", items: [
      organization("00000000-0000-7000-8000-000000000ef1", "Acme", "2026-09-01T00:00:00.000Z", 3, null, "global"),
      organization("00000000-0000-7000-8000-000000000ef2", "beta", "2026-08-01T00:00:00.000Z", 9, "2026-10-01T00:00:00.000Z", "global"),
    ] });
    vi.mocked(enterprise.searchOrganizations).mockResolvedValue({ region: "enterprise", items: [
      organization("00000000-0000-7000-8000-000000000ef3", "Cobalt", "2026-10-01T00:00:00.000Z", 5, "2026-10-09T00:00:00.000Z", "enterprise"),
    ] });
    const env = testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise });
    const names = async (name: string, args: Record<string, unknown>) => {
      const response = await rpc(env, "tools/call", { name, arguments: args });
      const result = response.result as { content: Array<{ text: string }> };
      return (JSON.parse(result.content[0]!.text) as { items: Array<{ name: string }> }).items.map((item) => item.name);
    };

    await expect(names("list_orgs", {})).resolves.toEqual(["Cobalt", "Acme", "beta"]);
    await expect(names("search_orgs", {})).resolves.toEqual(["Cobalt", "Acme", "beta"]);
    await expect(names("list_orgs", { orderBy: "name" })).resolves.toEqual(["Acme", "beta", "Cobalt"]);
    await expect(names("list_orgs", { orderBy: "memberCount", direction: "desc", limit: 2 }))
      .resolves.toEqual(["beta", "Cobalt"]);
    await expect(names("search_orgs", { orderBy: "lastSeenAt" }))
      .resolves.toEqual(["Cobalt", "beta", "Acme"]);
    await expect(names("search_orgs", { orderBy: "lastSeenAt", direction: "asc" }))
      .resolves.toEqual(["beta", "Cobalt", "Acme"]);
  });

  it("sends search filters to every region and lists abandoned Organizations too", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const env = testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise });

    await rpc(env, "tools/call", {
      name: "search_orgs",
      arguments: { query: "acme", plan: "growth", createdAfter: "2026-09-01T00:00:00Z", orderBy: "createdAt" },
    });
    await rpc(env, "tools/call", { name: "list_orgs", arguments: {} });

    for (const binding of [global, enterprise]) {
      expect(vi.mocked(binding.searchOrganizations).mock.calls).toEqual([
        [{ query: "acme", plan: "growth", createdAfter: "2026-09-01T00:00:00Z" }],
        [{ abandoned: "include" }],
      ]);
    }
  });

  it("pages by number over both regions' merged, ordered set", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.searchOrganizations).mockResolvedValue({ region: "global", items: [
      organization("00000000-0000-7000-8000-000000000ef1", "Acme", "2026-09-01T00:00:00.000Z", 3, null, "global"),
      organization("00000000-0000-7000-8000-000000000ef2", "Beta", "2026-08-01T00:00:00.000Z", 9, null, "global"),
    ] });
    vi.mocked(enterprise.searchOrganizations).mockResolvedValue({ region: "enterprise", items: [
      organization("00000000-0000-7000-8000-000000000ef3", "Cobalt", "2026-10-01T00:00:00.000Z", 5, null, "enterprise"),
    ] });
    const env = testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise });
    const page = async (args: Record<string, unknown>) => {
      const response = await rpc(env, "tools/call", { name: "search_orgs", arguments: args });
      const result = response.result as { content: Array<{ text: string }> };
      const body = JSON.parse(result.content[0]!.text) as { items: Array<{ name: string }> } & Record<string, unknown>;
      return { ...body, items: body.items.map((item) => item.name) };
    };

    await expect(page({ plan: "starter", limit: 2 }))
      .resolves.toEqual({ items: ["Cobalt", "Acme"], page: 1, pageCount: 2, total: 3, nextPage: 2 });
    await expect(page({ plan: "starter", limit: 2, page: 2 }))
      .resolves.toEqual({ items: ["Beta"], page: 2, pageCount: 2, total: 3, nextPage: null });
    await expect(page({ plan: "starter", limit: 2, page: 3 }))
      .resolves.toEqual({ items: [], page: 3, pageCount: 2, total: 3, nextPage: null });
  });

  it("returns a default page of 200 when no limit is set", async () => {
    const global = regionalBinding("global");
    vi.mocked(global.searchOrganizations).mockResolvedValue({ region: "global", items: Array.from({ length: 201 }, (_, index) =>
      organization(
        `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
        `Org ${index}`,
        "2026-09-01T00:00:00.000Z",
        1,
        null,
        "global",
      )) });

    const response = await rpc(testEnv({ GLOBAL_INSPECTION: global }), "tools/call", { name: "list_orgs", arguments: {} });
    const result = response.result as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text) as { items: unknown[] };
    expect(body).toMatchObject({ total: 201, pageCount: 2, nextPage: 2 });
    expect(body.items).toHaveLength(200);
  });

  function user(
    userId: string,
    name: string,
    email: string,
    createdAt: string,
    organizationCount: number,
    lastSeenAt: string | null,
    region: "global" | "enterprise",
  ) {
    return {
      userId,
      name,
      email,
      region,
      createdAt,
      lastSeenAt,
      organizations: Array.from({ length: organizationCount }, (_, index) => ({
        workspaceId: asWorkspaceId(`00000000-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`),
        name: `Org ${index}`,
        slug: `org-${index}`,
        role: "member",
        accessClass: "member",
        status: "active",
        lastSeenAt,
      })),
    };
  }

  it("orders users from both regions as one set and keeps a person's row in each region", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.searchUsers).mockResolvedValue({ region: "global", items: [
      user("u1", "ada", "ada@example.com", "2026-09-01T00:00:00.000Z", 2, null, "global"),
      user("u2", "Bea", "bea@example.com", "2026-10-01T00:00:00.000Z", 0, "2026-10-02T00:00:00.000Z", "global"),
    ] });
    vi.mocked(enterprise.searchUsers).mockResolvedValue({ region: "enterprise", items: [
      user("u1", "Ada", "ada@example.com", "2026-08-01T00:00:00.000Z", 3, "2026-10-09T00:00:00.000Z", "enterprise"),
    ] });
    const env = testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise });
    const rows = async (name: string, args: Record<string, unknown>) => {
      const response = await rpc(env, "tools/call", { name, arguments: args });
      const result = response.result as { content: Array<{ text: string }> };
      const body = JSON.parse(result.content[0]!.text) as { items: Array<{ userId: string; region: string }>; total: number };
      return body.items.map((item) => `${item.region}:${item.userId}`);
    };

    await expect(rows("list_users", {})).resolves.toEqual(["global:u2", "global:u1", "enterprise:u1"]);
    await expect(rows("list_users", { orderBy: "organizationCount" }))
      .resolves.toEqual(["enterprise:u1", "global:u1", "global:u2"]);
    await expect(rows("search_users", { orderBy: "email" }))
      .resolves.toEqual(["enterprise:u1", "global:u1", "global:u2"]);
    await expect(rows("search_users", { orderBy: "lastSeenAt", limit: 2 }))
      .resolves.toEqual(["enterprise:u1", "global:u2"]);
  });

  it("sends user search filters to every region and none for list_users", async () => {
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    const env = testEnv({ GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise });

    await rpc(env, "tools/call", {
      name: "search_users",
      arguments: { query: "ada", createdBefore: "2026-10-01T00:00:00Z", orderBy: "name", page: 2 },
    });
    await rpc(env, "tools/call", { name: "list_users", arguments: { limit: 5 } });

    for (const binding of [global, enterprise]) {
      expect(vi.mocked(binding.searchUsers).mock.calls).toEqual([
        [{ query: "ada", createdBefore: "2026-10-01T00:00:00Z" }],
        [{}],
      ]);
    }
  });
});
