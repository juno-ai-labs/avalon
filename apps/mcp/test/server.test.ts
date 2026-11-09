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


async function rpc(binding: Fetcher, body: unknown, bearer = live()) {
  const response = await worker.fetch(new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  }) as Request<unknown, IncomingRequestCfProperties>, env(binding));
  const text = await response.text();
  const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
  return { status: response.status, body: JSON.parse(data) as { result?: { content: Array<{ text: string }>; isError?: boolean } } };
}

const call = (name: string, args: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("the OAuth surface", () => {
  it("challenges a request with no token toward its resource metadata", async () => {
    const response = await worker.fetch(new Request("https://mcp.example.test/mcp", { method: "POST" }) as Request<unknown, IncomingRequestCfProperties>,
      env(api(() => new Response()).binding));
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
      env(api(() => new Response()).binding));
    expect(await metadata.json()).toMatchObject({
      issuer: "https://mcp.example.test",
      authorization_endpoint: "https://app.example.test/app/oauth/authorize",
      token_endpoint: "https://mcp.example.test/token",
      code_challenge_methods_supported: ["S256"],
    });
    const resource = await worker.fetch(new Request("https://mcp.example.test/.well-known/oauth-protected-resource") as Request<unknown, IncomingRequestCfProperties>,
      env(api(() => new Response()).binding));
    expect(await resource.json()).toMatchObject({ resource: "https://mcp.example.test/mcp", authorization_servers: ["https://mcp.example.test"] });

    const upstream = api(async (request) => Response.json({ path: new URL(request.url).pathname, body: await request.text() }));
    const forwarded = await worker.fetch(new Request("https://mcp.example.test/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" }) as Request<unknown, IncomingRequestCfProperties>,
      env(upstream.binding));
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

  it("publishes a self-contained page as a site through the Canvas's artifacts route", async () => {
    const upstream = api(async (request) => {
      expect(`${request.method} ${new URL(request.url).pathname}`).toBe("POST /canvases/0190a000-0000-7000-8000-000000000001/artifacts");
      expect(await request.json()).toEqual({ kind: "site", name: "pricing", files: [
        { path: "index.html", content: { encoding: "text", data: "<h1>Pricing</h1>" } }] });
      return Response.json({ resourceId: "0190a000-0000-7000-8000-0000000000bb", title: "pricing", kind: "site", version: 1,
        outcome: "created", url: null }, { status: 201 });
    });
    const { body } = await rpc(upstream.binding, call("publish_site", { canvasId: "0190a000-0000-7000-8000-000000000001",
      name: "pricing", files: [{ path: "index.html", content: "<h1>Pricing</h1>" }] }));
    expect(JSON.parse(body.result!.content[0]!.text)).toMatchObject({ outcome: "created", version: 1 });
  });

  it("reads a just-published text artifact from its original before Rally has extracted text from it", async () => {
    const upstream = api((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/model-content")) {
        return Response.json({ error: { code: "resource_version_content_unavailable", message: "This representation is unavailable for the resource version" } }, { status: 404 });
      }
      expect(path).toBe("/resources/0190a000-0000-7000-8000-0000000000dd/versions/1/content");
      return new Response("deal_id,amount\nD-1,100\n", { headers: { "content-type": "text/csv" } });
    });
    const { body } = await rpc(upstream.binding, call("read_artifact", { resourceId: "0190a000-0000-7000-8000-0000000000dd", version: 1 }));
    expect(body.result).toEqual({ content: [{ type: "text", text: "deal_id,amount\nD-1,100\n" }] });
  });

  it("refuses to read a Sidekick's conversation as a Canvas's Chat", async () => {
    const upstream = api(() => Response.json({ kind: "automation", title: "Digest", text: "hello", throughSequence: 3, nextAfterSequence: null }));
    const { body } = await rpc(upstream.binding, call("read_canvas_chat", { canvasId: "0190a000-0000-7000-8000-000000000001" }));
    expect(body.result).toMatchObject({ isError: true, content: [{ text: "That id names a Sidekick, not a Canvas" }] });
  });
});

const request = (method: string, params: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("skills, resources and prompts", () => {
  it("serves the plugin's skills, each file matching the digest its manifest advertises", async () => {
    const binding = api(() => Response.json({})).binding;
    const listed = (await rpc(binding, request("skills/list", {}))).body as unknown as {
      result: { skills: Array<{ uri: string; frontmatter: { name: string }; resources: Array<{ uri: string; digest: string }> }> } };
    expect(listed.result.skills.map((skill) => [skill.uri, skill.frontmatter.name])).toEqual([
      ["skill://rally/canvases/SKILL.md", "canvases"],
      ["skill://rally/publishing/SKILL.md", "publishing"],
    ]);
    for (const skill of listed.result.skills) {
      for (const file of skill.resources) {
        const read = (await rpc(binding, request("resources/read", { uri: file.uri }))).body as unknown as {
          result: { contents: Array<{ text: string }> } };
        const bytes = new TextEncoder().encode(read.result.contents[0]!.text);
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
        expect(file.digest).toBe(`sha256:${digest}`);
      }
    }
  });

  it("links get_canvas's artifacts as resources, and reads one back as text", async () => {
    const canvasId = "0190a000-0000-7000-8000-000000000001";
    const artifactId = "0190a000-0000-7000-8000-0000000000ee";
    const upstream = api((incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path === `/canvases/${canvasId}`) {
        return Response.json({ id: canvasId, artifacts: [{ resourceId: artifactId, title: "Launch plan", version: 2, mimeType: "text/markdown" }] });
      }
      if (path.endsWith("/model-content")) return Response.json({ error: { code: "resource_version_content_unavailable", message: "x" } }, { status: 404 });
      expect(path).toBe(`/resources/${artifactId}/versions/2/content`);
      return new Response("# Launch plan", { headers: { "content-type": "text/markdown" } });
    });
    const { body } = await rpc(upstream.binding, call("get_canvas", { canvasId }));
    expect(body.result!.content.slice(1)).toEqual([{ type: "resource_link", uri: `rally://artifact/${artifactId}/v2`, name: "Launch plan", mimeType: "text/markdown" }]);

    const read = (await rpc(upstream.binding, request("resources/read", { uri: `rally://artifact/${artifactId}/v2` }))).body as unknown as {
      result: { contents: Array<{ uri: string; text: string }> } };
    expect(read.result.contents).toEqual([{ uri: `rally://artifact/${artifactId}/v2`, mimeType: "text/plain", text: "# Launch plan" }]);
  });

  it("refuses a resource whose id is not one, before asking Rally", async () => {
    const upstream = api(() => Response.json({}));
    const { body } = await rpc(upstream.binding, request("resources/read", { uri: "rally://canvas/..%2Fworkspace/chat" }));
    expect(body).toHaveProperty("error");
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it("offers a catch-up prompt that names the Canvas the person asked about", async () => {
    const { body } = await rpc(api(() => Response.json({})).binding, request("prompts/get", { name: "catch_up", arguments: { canvas: "Q3 launch" } }));
    expect((body as unknown as { result: { messages: Array<{ role: string; content: { text: string } }> } }).result.messages).toEqual([{
      role: "user", content: { type: "text",
        text: "Catch me up on the Rally Canvas \"Q3 launch\": find it, read its whole Chat and its artifacts' latest versions, then tell me what changed, what was decided and what is still open." } }]);
  });
});
