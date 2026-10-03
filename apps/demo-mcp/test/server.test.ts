import "../../../tests/isolated-region";
import { describe, expect, it, vi } from "vitest";

import type { DemoAdministrationRpc } from "@rally/contracts/demo-administration";

import type { AccessPrincipal } from "../src/access";
import type { Env } from "../src/env";
import { createDemoMcpHandler } from "../src/index";
import hostedClients from "../hosted-clients.json";

const principal: AccessPrincipal = {
  subject: "operator-1",
  email: "operator@rallywith.ai",
  audience: "demo-mcp-audience",
};

const OPERATION_ID = "00000000-0000-7000-8000-0000000000e2";

/** The Global API's entrypoint, which cannot run here: a double that records what it was handed. */
function administration(overrides: Partial<DemoAdministrationRpc> = {}): DemoAdministrationRpc {
  const refused = async () => ({ ok: false as const, code: "unused", message: "Not used by this test." });
  return {
    listScenarios: vi.fn(refused),
    getScenario: vi.fn(refused),
    checkScenario: vi.fn(refused),
    castCandidates: vi.fn(refused),
    createOrganization: vi.fn(refused),
    listOperations: vi.fn(refused),
    getOperation: vi.fn(refused),
    retryOperation: vi.fn(refused),
    abandonOperation: vi.fn(refused),
    retireOrganization: vi.fn(refused),
    ...overrides,
  } as DemoAdministrationRpc;
}

function testEnv(api: DemoAdministrationRpc): Env {
  return { DEMO_ADMINISTRATION: api };
}

async function rpc(env: Env, method: string, params: unknown = {}, origin?: string): Promise<Record<string, unknown>> {
  const handler = createDemoMcpHandler(env, principal, "json");
  const response = await handler.fetch(new Request("https://demo-mcp.internal.rallywith.ai/mcp", {
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

type ToolList = { tools: Array<{ name: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }> };
type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe("Rally Demo MCP tools", () => {
  it.each(hostedClients.originHostnames)("admits the %s hosted origin to the MCP transport", async (hostname) => {
    const response = await rpc(testEnv(administration()), "tools/list", {}, `https://${hostname}`);
    expect(response.result).toMatchObject({ tools: expect.any(Array) });
  });

  it("publishes the phase-1 tools in order, with destructive annotations only where a demo is closed", async () => {
    const response = await rpc(testEnv(administration()), "tools/list");
    const tools = (response.result as ToolList).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_demo_scenarios",
      "get_demo_scenario",
      "check_demo_scenario",
      "list_demo_cast_candidates",
      "create_demo_organization",
      "list_demo_operations",
      "get_demo_operation",
      "retry_demo_operation",
      "abandon_demo_operation",
      "retire_demo_organization",
    ]);
    expect(tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name))
      .toEqual(["abandon_demo_operation", "retire_demo_organization"]);
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name)).toEqual([
      "list_demo_scenarios",
      "get_demo_scenario",
      "check_demo_scenario",
      "list_demo_cast_candidates",
      "list_demo_operations",
      "get_demo_operation",
    ]);
  });

  it("advertises the pack's whole shape, so a client's model can write one", async () => {
    const response = await rpc(testEnv(administration()), "tools/list");
    const check = (response.result as ToolList).tools.find((tool) => tool.name === "check_demo_scenario")!;
    const pack = (check.inputSchema as { properties: { pack: { required: string[]; properties: Record<string, unknown> } } })
      .properties.pack;
    expect(pack.required).toEqual(["version", "roles", "steps"]);
    expect(JSON.stringify(pack.properties.steps)).toContain("\"create_substream\"");
  });

  it("forwards the arguments as sent with the verified actor, and returns the entrypoint's answer", async () => {
    const createOrganization = vi.fn<DemoAdministrationRpc["createOrganization"]>(async () => ({
      ok: true,
      value: { operationId: OPERATION_ID, status: "running" } as never,
    }));
    const env = testEnv(administration({ createOrganization }));
    const args = {
      requestKey: "northwind-2026-10-03",
      scenario: { scenarioId: "builtin:multiplayer" },
      companyName: "Northwind",
      presenterUserId: "00000000-0000-7000-8000-0000000000a1",
      cast: { priya: { name: "Sam Lee" } },
      notAField: "kept for the entrypoint to refuse",
    };
    const response = await rpc(env, "tools/call", { name: "create_demo_organization", arguments: args });
    expect(createOrganization).toHaveBeenCalledWith({
      actor: { subject: "operator-1", email: "operator@rallywith.ai" },
      input: args,
    });
    const result = response.result as CallResult;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ operationId: OPERATION_ID, status: "running" });
  });

  it("renders a refusal with its code, sentence and issues, and logs only the code", async () => {
    const checkScenario = vi.fn<DemoAdministrationRpc["createOrganization"]>(async () => ({
      ok: false,
      code: "demo_scenario_invalid",
      message: "The scenario has problems listed in issues.",
      issues: [{ path: "steps[1].as", code: "demo_pack_speaker_not_seated", message: "The speaker is not in this conversation." }],
    }));
    const failures = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = testEnv(administration({ createOrganization: checkScenario }));
    const response = await rpc(env, "tools/call", {
      name: "create_demo_organization",
      arguments: { requestKey: "k", scenario: { pack: { version: "secret-pack-text" } } },
    });
    const result = response.result as CallResult;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      code: "demo_scenario_invalid",
      message: "The scenario has problems listed in issues.",
      issues: [{ path: "steps[1].as", code: "demo_pack_speaker_not_seated", message: "The speaker is not in this conversation." }],
    });
    const logged = failures.mock.calls.map((call) => String(call[0])).join("\n");
    expect(JSON.parse(logged)).toEqual({
      event: "demo_mcp_tool_failed",
      actor_subject: "operator-1",
      actor_email: "operator@rallywith.ai",
      tool: "create_demo_organization",
      error_code: "demo_scenario_invalid",
    });
  });

  it("answers a binding that did not respond with a code that says to try again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getOperation = vi.fn<DemoAdministrationRpc["getOperation"]>(async () => {
      throw new Error("Service binding unavailable");
    });
    const response = await rpc(testEnv(administration({ getOperation })), "tools/call", {
      name: "get_demo_operation",
      arguments: { operationId: OPERATION_ID },
    });
    const result = response.result as CallResult;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      code: "regional_unavailable",
      message: "Rally's API did not answer. Try again in a moment.",
    });
  });
});
