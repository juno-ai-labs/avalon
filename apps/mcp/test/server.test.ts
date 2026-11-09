import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { inspectBearer } from "../src/api";
import type { Env } from "../src/env";

/** An unsigned token with the claims this Worker reads; the API verifies the signature, not this Worker. */
function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
  return `${encode({ alg: "HS256" })}.${encode(claims)}.signature`;
}
const live = () => token({ aud: "rally-mcp", exp: Math.floor(Date.now() / 1_000) + 600, region: "global" });

/** The API Worker's service binding: the one collaborator that cannot run here. */
function api(handler: (request: Request) => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)));
  return { fetch, binding: { fetch, connect: () => { throw new Error("unused"); } } as unknown as Fetcher };
}

function env(binding: Fetcher): Env {
  return { BROWSER_APP_ORIGIN: "https://app.example.test", GLOBAL_API: binding };
}

const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function rpc(binding: Fetcher, body: unknown, bearer = live()) {
  const response = await worker.fetch(new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  }) as Request<unknown, IncomingRequestCfProperties>, env(binding), context);
  const text = await response.text();
  const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
  return { status: response.status, body: JSON.parse(data) as { result?: { content: Array<{ text: string }>; isError?: boolean } } };
}

const call = (name: string, args: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("the OAuth surface", () => {
  it("challenges a request with no token toward its resource metadata", async () => {
    const response = await worker.fetch(new Request("https://mcp.example.test/mcp", { method: "POST" }) as Request<unknown, IncomingRequestCfProperties>,
      env(api(() => new Response()).binding), context);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"');
  });

  it("refuses a desktop token, and an expired one, before any tool runs", () => {
    expect(inspectBearer(`Bearer ${token({ aud: "avalon-desktop", exp: 9_999_999_999, region: "global" })}`))
      .toEqual({ ok: false, reason: "audience" });
    expect(inspectBearer(`Bearer ${token({ aud: "rally-mcp", exp: 1, region: "global" })}`)).toEqual({ ok: false, reason: "expired" });
  });

  it("publishes the authorization server with the browser's consent page and forwards tokens to the identity API", async () => {
    const metadata = await worker.fetch(new Request("https://mcp.example.test/.well-known/oauth-authorization-server") as Request<unknown, IncomingRequestCfProperties>,
      env(api(() => new Response()).binding), context);
    expect(await metadata.json()).toMatchObject({
      issuer: "https://mcp.example.test",
      authorization_endpoint: "https://app.example.test/app/oauth/authorize",
      token_endpoint: "https://mcp.example.test/token",
      code_challenge_methods_supported: ["S256"],
    });
    const resource = await worker.fetch(new Request("https://mcp.example.test/.well-known/oauth-protected-resource") as Request<unknown, IncomingRequestCfProperties>,
      env(api(() => new Response()).binding), context);
    expect(await resource.json()).toMatchObject({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://mcp.example.test"] });

    const upstream = api(async (request) => Response.json({ path: new URL(request.url).pathname, body: await request.text() }));
    const forwarded = await worker.fetch(new Request("https://mcp.example.test/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" }) as Request<unknown, IncomingRequestCfProperties>,
      env(upstream.binding), context);
    expect(await forwarded.json()).toEqual({ path: "/mcp-oauth/token", body: "grant_type=refresh_token" });
  });
});

describe("the Canvas tools", () => {
  it("lists the reader's Canvases through the product route, as the connected person, filtered by title", async () => {
    const bearer = live();
    const upstream = api((request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${bearer}`);
      expect(new URL(request.url).pathname).toBe("/canvases");
      return Response.json({ items: [
        { id: "0190a000-0000-7000-8000-000000000001", title: "Launch plan", visibility: "workspace", updatedAt: "2026-11-09T00:00:00.000Z",
          createdByUserId: "u", artifactKind: "document", unread: false, pinnedPosition: 0, sharedWithMe: false, writerSidekickId: null },
        { id: "0190a000-0000-7000-8000-000000000002", title: "Budget", visibility: "creator", updatedAt: "2026-11-08T00:00:00.000Z",
          createdByUserId: "u", artifactKind: null, unread: true, pinnedPosition: null, sharedWithMe: false, writerSidekickId: null },
      ] });
    });
    const { body } = await rpc(upstream.binding, call("list_canvases", { query: "launch" }), bearer);
    expect(JSON.parse(body.result!.content[0]!.text)).toEqual([{
      id: "0190a000-0000-7000-8000-000000000001", title: "Launch plan", visibility: "workspace", updatedAt: "2026-11-09T00:00:00.000Z",
      createdByUserId: "u", newestArtifactKind: "document", unread: false, pinned: true, sharedWithMe: false, writtenBySidekickId: null,
    }]);
  });

  it("creates a Canvas whose id and first message are the operation id, so a retry makes one", async () => {
    const upstream = api(async (request) => {
      expect(await request.json()).toEqual({ canvasId: "0190a000-0000-7000-8000-0000000000aa", title: "Roadmap",
        prompt: { text: "Draft a Q1 roadmap", clientMessageId: "0190a000-0000-7000-8000-0000000000aa" } });
      return Response.json({ canvasId: "0190a000-0000-7000-8000-0000000000aa", turnId: "turn-1" }, { status: 201 });
    });
    const { body } = await rpc(upstream.binding, call("create_canvas", {
      operationId: "0190a000-0000-7000-8000-0000000000aa", title: "Roadmap", prompt: "Draft a Q1 roadmap" }));
    expect(JSON.parse(body.result!.content[0]!.text)).toMatchObject({ canvasId: "0190a000-0000-7000-8000-0000000000aa", turnId: "turn-1" });
  });

  it("reports Rally's own refusal, and tells the person to reconnect when the session ended", async () => {
    const upstream = api(() => Response.json({ error: { code: "session_revoked", message: "The session is no longer active" } }, { status: 401 }));
    const { body } = await rpc(upstream.binding, call("get_canvas", { canvasId: "0190a000-0000-7000-8000-000000000001" }));
    expect(body.result).toEqual({ isError: true, content: [{ type: "text",
      text: "The session is no longer active (session_revoked). The connection to Rally has ended; reconnect Rally to continue." }] });
  });

  it("refuses to read a Sidekick's conversation as a Canvas's Chat", async () => {
    const upstream = api(() => Response.json({ kind: "automation", title: "Digest", text: "hello", throughSequence: 3, nextAfterSequence: null }));
    const { body } = await rpc(upstream.binding, call("read_canvas_chat", { canvasId: "0190a000-0000-7000-8000-000000000001" }));
    expect(body.result).toMatchObject({ isError: true, content: [{ text: "That id names a Sidekick, not a Canvas" }] });
  });
});
