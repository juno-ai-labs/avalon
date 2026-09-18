import "../../../tests/isolated-region";
import { describe, expect, it, vi } from "vitest";

import { asArtifactId, asAutomationId, asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { EngineeringInspectionRpcBinding } from "@rally/contracts/engineering-inspection";

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
    listWorkspaces: vi.fn<EngineeringInspectionRpcBinding["listWorkspaces"]>(
      async () => ({ region, items: [] }),
    ),
    listWorkstreams: vi.fn<EngineeringInspectionRpcBinding["listWorkstreams"]>(
      async () => ({ found: false }),
    ),
    listSubstreams: vi.fn<EngineeringInspectionRpcBinding["listSubstreams"]>(
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
    resolveWorkstream: vi.fn<EngineeringInspectionRpcBinding["resolveWorkstream"]>(
      async () => ({ found: false }),
    ),
    resolveSubstream: vi.fn<EngineeringInspectionRpcBinding["resolveSubstream"]>(
      async () => ({ found: false }),
    ),
    resolveSidekick: vi.fn<EngineeringInspectionRpcBinding["resolveSidekick"]>(
      async () => ({ found: false }),
    ),
    resolveArtifact: vi.fn<EngineeringInspectionRpcBinding["resolveArtifact"]>(
      async () => ({ found: false }),
    ),
    runWorkspaceSql: vi.fn<EngineeringInspectionRpcBinding["runWorkspaceSql"]>(
      async () => ({ found: false }),
    ),
    runWorkstreamSql: vi.fn<EngineeringInspectionRpcBinding["runWorkstreamSql"]>(
      async () => ({ found: false }),
    ),
    runSubstreamSql: vi.fn<EngineeringInspectionRpcBinding["runSubstreamSql"]>(
      async () => ({ found: false }),
    ),
    runSidekickSql: vi.fn<EngineeringInspectionRpcBinding["runSidekickSql"]>(
      async () => ({ found: false }),
    ),
    runArtifactSql: vi.fn<EngineeringInspectionRpcBinding["runArtifactSql"]>(
      async () => ({ found: false }),
    ),
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
  it.each(hostedClients.originHostnames)("admits the %s hosted origin to the MCP transport", async (hostname) => {
    const env: Env = {
      GLOBAL_INSPECTION: regionalBinding("global"),
      ENTERPRISE_INSPECTION: regionalBinding("enterprise"),
    };

    const response = await rpc(env, "tools/list", {}, `https://${hostname}`);
    expect(response.result).toMatchObject({ tools: expect.any(Array) });
  });

  it("publishes every inventory and SQL tool with mutation annotations on SQL", async () => {
    const env: Env = {
      GLOBAL_INSPECTION: regionalBinding("global"),
      ENTERPRISE_INSPECTION: regionalBinding("enterprise"),
    };

    const response = await rpc(env, "tools/list");
    const result = response.result as { tools: Array<{ name: string; annotations?: Record<string, boolean> }> };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "list_workspaces",
      "list_workstreams",
      "list_substreams",
      "list_sidekicks",
      "list_artifacts",
      "run_workspace_sql",
      "run_workstream_sql",
      "run_substream_sql",
      "run_sidekick_sql",
      "run_artifact_sql",
    ]);
    for (const tool of result.tools.filter((item) => item.name.startsWith("run_"))) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
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
    const env: Env = { GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: regionalBinding("enterprise") };

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
    vi.mocked(global.listWorkstreams).mockResolvedValue({ found: true, value });
    vi.mocked(enterprise.listWorkstreams).mockResolvedValue({
      found: true,
      value: { ...value, region: "enterprise" },
    });

    const response = await rpc(
      { GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise },
      "tools/call",
      { name: "list_workstreams", arguments: { workspaceId } },
    );
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("exists in multiple Rally regions");
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
    const env: Env = { GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise };

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
      { GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise },
      "tools/call",
      { name: "list_artifacts", arguments: { workspaceId } },
    );
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("exists in multiple Rally regions");
  });

  it("routes bound substream SQL to exactly one regional authority", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb3");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000eb4");
    const substreamId = asSubstreamId("0");
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(enterprise.resolveSubstream).mockResolvedValue({
      found: true,
      value: {
        region: "enterprise",
        workspaceId,
        workstreamId,
        substreamId,
        authorityGeneration: 7,
      },
    });
    vi.mocked(enterprise.runSubstreamSql).mockResolvedValue({
      found: true,
      value: {
        region: "enterprise",
        workspaceId,
        workstreamId,
        substreamId,
        result: {
          columns: ["answer"],
          rows: [{ answer: 42 }],
          rowsRead: 1,
          rowsWritten: 0,
        },
      },
    });

    const response = await rpc(
      { GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise },
      "tools/call",
      {
        name: "run_substream_sql",
        arguments: {
          workspaceId,
          workstreamId,
          substreamId,
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
    expect(enterprise.runSubstreamSql).toHaveBeenCalledWith({
      workspaceId,
      workstreamId,
      substreamId,
      authorityGeneration: 7,
      query: { sql: "SELECT ? AS answer", bindings: [42] },
    });
    expect(global.runSubstreamSql).not.toHaveBeenCalled();
    expect(enterprise.runSubstreamSql).toHaveBeenCalledTimes(1);
  });

  it("routes bound Sidekick SQL to the SidekickDO in exactly one regional authority", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb7");
    const sidekickId = asAutomationId("00000000-0000-7000-8000-000000000eb8");
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.resolveSidekick).mockResolvedValue({
      found: true,
      value: { region: "global", workspaceId, sidekickId, authorityGeneration: 4 },
    });
    vi.mocked(global.runSidekickSql).mockResolvedValue({
      found: true,
      value: {
        region: "global",
        workspaceId,
        workstreamId: null,
        substreamId: null,
        sidekickId,
        result: {
          columns: ["lifecycle"],
          rows: [{ lifecycle: "paused" }],
          rowsRead: 1,
          rowsWritten: 0,
        },
      },
    });

    const response = await rpc(
      { GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise },
      "tools/call",
      {
        name: "run_sidekick_sql",
        arguments: { workspaceId, sidekickId, sql: "SELECT lifecycle FROM automation" },
      },
    );
    const result = response.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      region: "global",
      sidekickId,
      result: { rows: [{ lifecycle: "paused" }] },
    });
    expect(global.runSidekickSql).toHaveBeenCalledWith({
      workspaceId,
      sidekickId,
      authorityGeneration: 4,
      query: { sql: "SELECT lifecycle FROM automation", bindings: [] },
    });
    expect(enterprise.runSidekickSql).not.toHaveBeenCalled();
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
      { GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise },
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

  it("does not execute SQL when both regions resolve the target", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb5");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000eb6");
    const substreamId = asSubstreamId("0");
    const global = regionalBinding("global");
    const enterprise = regionalBinding("enterprise");
    vi.mocked(global.resolveSubstream).mockResolvedValue({
      found: true,
      value: {
        region: "global",
        workspaceId,
        workstreamId,
        substreamId,
        authorityGeneration: 7,
      },
    });
    vi.mocked(enterprise.resolveSubstream).mockResolvedValue({
      found: true,
      value: {
        region: "enterprise",
        workspaceId,
        workstreamId,
        substreamId,
        authorityGeneration: 7,
      },
    });

    const response = await rpc(
      { GLOBAL_INSPECTION: global, ENTERPRISE_INSPECTION: enterprise },
      "tools/call",
      {
        name: "run_substream_sql",
        arguments: {
          workspaceId,
          workstreamId,
          substreamId,
          sql: "DELETE FROM fixture",
        },
      },
    );
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("must resolve to one region");
    expect(global.runSubstreamSql).not.toHaveBeenCalled();
    expect(enterprise.runSubstreamSql).not.toHaveBeenCalled();
  });
});
