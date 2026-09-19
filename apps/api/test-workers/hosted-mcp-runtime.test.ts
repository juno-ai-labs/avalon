/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from "vitest";
import { listHostedMcpTools, HOSTED_MCP_DEFAULT_RESPONSE_BYTES } from "@rally/connectors";

// The provider is doubled, but the fetch receiver check belongs to real workerd.
// A data URL supplies the response without credentials or a live network dependency.
describe("hosted MCP on Workers", () => {
  it("calls fetch without binding it to the MCP request object", async () => {
    const nativeFetch = globalThis.fetch;
    const tools = await listHostedMcpTools({
      providerName: "Fixture", serverUrl: "https://provider.example/mcp",
      auth: {}, signal: new AbortController().signal, maxResponseBytes: HOSTED_MCP_DEFAULT_RESPONSE_BYTES,
      fetch: async function (this: unknown, _url, init) {
        const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
        if (!request.id) return new Response(null, { status: 202 });
        const result = request.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : { tools: [{ name: "read", inputSchema: { type: "object" } }] };
        return nativeFetch.call(this, `data:application/json,${encodeURIComponent(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))}`);
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });
});
