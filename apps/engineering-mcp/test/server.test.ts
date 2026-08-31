import { describe, expect, it, vi } from "vitest";

import { asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
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

function regionalBinding(region: "global" | "eu"): EngineeringInspectionRpcBinding {
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
    resolveWorkspace: vi.fn<EngineeringInspectionRpcBinding["resolveWorkspace"]>(
      async () => ({ found: false }),
    ),
    resolveWorkstream: vi.fn<EngineeringInspectionRpcBinding["resolveWorkstream"]>(
      async () => ({ found: false }),
    ),
    resolveSubstream: vi.fn<EngineeringInspectionRpcBinding["resolveSubstream"]>(
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
      EU_INSPECTION: regionalBinding("eu"),
    };

    const response = await rpc(env, "tools/list", {}, `https://${hostname}`);
    expect(response.result).toMatchObject({ tools: expect.any(Array) });
  });

  it("publishes the six initial tools with mutation annotations on SQL", async () => {
    const env: Env = {
      GLOBAL_INSPECTION: regionalBinding("global"),
      EU_INSPECTION: regionalBinding("eu"),
    };

    const response = await rpc(env, "tools/list");
    const result = response.result as { tools: Array<{ name: string; annotations?: Record<string, boolean> }> };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "list_workspaces",
      "list_workstreams",
      "list_substreams",
      "run_workspace_sql",
      "run_workstream_sql",
      "run_substream_sql",
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
    const env: Env = { GLOBAL_INSPECTION: global, EU_INSPECTION: regionalBinding("eu") };

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
    const eu = regionalBinding("eu");
    vi.mocked(global.listWorkstreams).mockResolvedValue({ found: true, value });
    vi.mocked(eu.listWorkstreams).mockResolvedValue({
      found: true,
      value: { ...value, region: "eu" },
    });

    const response = await rpc(
      { GLOBAL_INSPECTION: global, EU_INSPECTION: eu },
      "tools/call",
      { name: "list_workstreams", arguments: { workspaceId } },
    );
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("exists in both Rally regions");
  });

  it("routes bound substream SQL to exactly one regional authority", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb3");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000eb4");
    const substreamId = asSubstreamId("0");
    const global = regionalBinding("global");
    const eu = regionalBinding("eu");
    vi.mocked(eu.resolveSubstream).mockResolvedValue({
      found: true,
      value: {
        region: "eu",
        workspaceId,
        workstreamId,
        substreamId,
        authorityGeneration: 7,
      },
    });
    vi.mocked(eu.runSubstreamSql).mockResolvedValue({
      found: true,
      value: {
        region: "eu",
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
      { GLOBAL_INSPECTION: global, EU_INSPECTION: eu },
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
      region: "eu",
      result: { rows: [{ answer: 42 }] },
    });
    expect(eu.runSubstreamSql).toHaveBeenCalledWith({
      workspaceId,
      workstreamId,
      substreamId,
      authorityGeneration: 7,
      query: { sql: "SELECT ? AS answer", bindings: [42] },
    });
    expect(global.runSubstreamSql).not.toHaveBeenCalled();
    expect(eu.runSubstreamSql).toHaveBeenCalledTimes(1);
  });

  it("does not execute SQL when both regions resolve the target", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000eb5");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000eb6");
    const substreamId = asSubstreamId("0");
    const global = regionalBinding("global");
    const eu = regionalBinding("eu");
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
    vi.mocked(eu.resolveSubstream).mockResolvedValue({
      found: true,
      value: {
        region: "eu",
        workspaceId,
        workstreamId,
        substreamId,
        authorityGeneration: 7,
      },
    });

    const response = await rpc(
      { GLOBAL_INSPECTION: global, EU_INSPECTION: eu },
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
    expect(result.content[0]!.text).toContain("exists in both Rally regions");
    expect(global.runSubstreamSql).not.toHaveBeenCalled();
    expect(eu.runSubstreamSql).not.toHaveBeenCalled();
  });
});
