import { describe, expect, it } from "vitest";

import {
  responseToRpcResult,
  rpcResultBody,
} from "../src/durable-objects/rpc-result";

describe("Durable Object RPC response compatibility", () => {
  it("preserves bounded diagnostics from a non-JSON error response", async () => {
    const result = await responseToRpcResult(new Response("upstream gateway failed", {
      status: 502,
      headers: { "content-type": "text/plain" },
    }));

    expect(result.status).toBe(502);
    expect(rpcResultBody(result)).toEqual({ error: "upstream gateway failed" });
  });

  it("preserves structured JSON bodies", async () => {
    const result = await responseToRpcResult(Response.json({ results: [{ changes: 1 }] }));
    expect(rpcResultBody(result)).toEqual({ results: [{ changes: 1 }] });
  });
});
