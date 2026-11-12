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

const CANVAS = "0190a000-0000-7000-8000-000000000001";
const USER = "0190a000-0000-7000-8000-0000000000c1";

/** A Canvas's sidebar row as `GET /canvases` answers it (`CanvasSidebarRowSchema`). */
function sidebarRow(row: { id: string; title: string; visibility: string; updatedAt: string; artifactKind: string | null; unread: boolean; pinnedPosition: number | null }) {
  return { ...row, createdByUserId: USER, createdAt: "2026-11-01T00:00:00.000Z", lastEditor: null, writerSidekickId: null,
    presentUserIds: [], sharedWithMe: false };
}

/** A Canvas as `GET /canvases/:id` answers it (`CanvasDetailSchema`). */
function canvasDetail(artifacts: Array<{ resourceId: string; title: string; version: number; mimeType: string | null }>) {
  return { id: CANVAS, title: "Launch", createdByUserId: USER, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z",
    lastEditor: null, writerSidekickId: null, visibility: "creator", participantUserIds: [], canManage: true,
    artifacts: artifacts.map((artifact) => ({ ...artifact, kind: "file", updatedAt: "2026-11-09T00:00:00.000Z" })) };
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
    // The body is passed on as a stream, not read into this Worker first.
    const forwarded = await worker.fetch(new Request("https://mcp.example.test/token", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" }) as Request<unknown, IncomingRequestCfProperties>,
      env(upstream.binding));
    expect(await forwarded.json()).toEqual({ path: "/mcp-oauth/token", body: "grant_type=refresh_token" });
  });
});

describe("the Canvas tools", () => {
  it('updates editor and artifact audiences through the shared route with a revision fence', async()=>{
    const detail={...sidebarRow({id:CANVAS,title:'Launch',visibility:'participants',updatedAt:'2026-11-11T12:00:00Z',artifactKind:null,unread:false,pinnedPosition:null}),
      participantUserIds:[USER],artifacts:[],canManage:true,artifactVisibility:'public',artifactUserIds:[],sharingRevision:9};
    const upstream=api(async request=>{
      expect(`${request.method} ${new URL(request.url).pathname}`).toBe(`POST /canvases/${CANVAS}/audience`);
      expect(await request.json()).toEqual({visibility:'participants',userIds:[USER],artifactVisibility:'public',artifactUserIds:[],expectedRevision:8});
      return Response.json(detail);
    });
    const {body}=await rpc(upstream.binding,call('set_canvas_audience',{canvasId:CANVAS,visibility:'participants',userIds:[USER],artifactVisibility:'public',artifactUserIds:[],expectedRevision:8}));
    expect(body.result?.isError).not.toBe(true);
    expect(JSON.parse(body.result!.content[0]!.text)).toMatchObject({artifactVisibility:'public',artifactUserIds:[],sharingRevision:9});
  });

  it('leaves artifact settings omitted for an older editor-only audience update',async()=>{
    const upstream=api(async request=>{
      expect(await request.json()).toEqual({visibility:'creator',userIds:[]});
      return Response.json({...sidebarRow({id:CANVAS,title:'Launch',visibility:'creator',updatedAt:'2026-11-11T12:00:00Z',artifactKind:null,unread:false,pinnedPosition:null}),
        participantUserIds:[],artifacts:[],canManage:true,artifactVisibility:'public',artifactUserIds:[],sharingRevision:10});
    });
    const {body}=await rpc(upstream.binding,call('set_canvas_audience',{canvasId:CANVAS,visibility:'creator',userIds:[]}));
    expect(JSON.parse(body.result!.content[0]!.text).artifactVisibility).toBe('public');
  });

  it.each(['workspace', 'participants'])('refuses an artifact-only update that omits the %s editor list before calling the API', async (visibility) => {
    const upstream = api(() => Response.json(canvasDetail([])));
    const { body } = await rpc(upstream.binding, call('set_canvas_audience', {
      canvasId: CANVAS, visibility, artifactVisibility: 'public', expectedRevision: 8,
    }));
    expect(body.result?.isError).toBe(true);
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it('preserves guest editors on an artifact-only update with the required complete list', async () => {
    const upstream = api(async (request) => {
      expect(`${request.method} ${new URL(request.url).pathname}`).toBe(`POST /canvases/${CANVAS}/audience`);
      expect(await request.json()).toEqual({ visibility: 'workspace', userIds: [USER], artifactVisibility: 'public', expectedRevision: 8 });
      return Response.json({ ...canvasDetail([]), visibility: 'workspace', participantUserIds: [USER], artifactVisibility: 'public', sharingRevision: 9 });
    });
    const { body } = await rpc(upstream.binding, call('set_canvas_audience', {
      canvasId: CANVAS, visibility: 'workspace', userIds: [USER], artifactVisibility: 'public', expectedRevision: 8,
    }));
    expect(body.result?.isError).not.toBe(true);
    expect(JSON.parse(body.result!.content[0]!.text)).toMatchObject({ participantUserIds: [USER], artifactVisibility: 'public' });
  });

  it('gets an artifact-only share link without requesting its Canvas or minting a viewer session',async()=>{
    const resourceId='0190a000-0000-7000-8000-0000000000bb';
    const upstream=api(request=>{
      expect(`${request.method} ${new URL(request.url).pathname}`).toBe(`GET /resources/${resourceId}/artifact/link`);
      return Response.json({artifactId:resourceId,canonicalUrl:'https://quiet-blue-river-garden-g.rallyusercontent.com'});
    });
    const {body}=await rpc(upstream.binding,call('get_artifact_link',{resourceId}));
    expect(JSON.parse(body.result!.content[0]!.text)).toEqual({artifactId:resourceId,canonicalUrl:'https://quiet-blue-river-garden-g.rallyusercontent.com'});
    expect(upstream.fetch).toHaveBeenCalledTimes(1);
  });

  it("lists the reader's Canvases through the product route, as the connected person, asking Rally to filter by title", async () => {
    const bearer = live();
    const upstream = api((request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${bearer}`);
      // Rally filters by title, across every Canvas rather than the most recent page.
      expect(new URL(request.url).pathname + new URL(request.url).search).toBe("/canvases?query=launch");
      return Response.json({ items: [
        sidebarRow({ id: CANVAS, title: "Launch plan", visibility: "workspace", updatedAt: "2026-11-09T00:00:00.000Z",
          artifactKind: "file", unread: false, pinnedPosition: 0 }),
      ] });
    });
    const { body } = await rpc(upstream.binding, call("list_canvases", { query: "launch" }), bearer);
    expect(JSON.parse(body.result!.content[0]!.text)).toEqual([{
      id: CANVAS, title: "Launch plan", visibility: "workspace", updatedAt: "2026-11-09T00:00:00.000Z",
      createdByUserId: USER, newestArtifactKind: "file", unread: false, pinned: true, sharedWithMe: false, writtenBySidekickId: null,
    }]);
  });

  it("names the field when Rally answers in a shape this Worker does not know, never its value", async () => {
    const upstream = api(() => Response.json({ items: [sidebarRow({ id: CANVAS, title: "Launch plan", visibility: "workspace",
      updatedAt: "2026-11-09T00:00:00.000Z", artifactKind: "hologram", unread: false, pinnedPosition: null })] }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { body } = await rpc(upstream.binding, call("list_canvases", {}));
    expect(body.result).toEqual({ isError: true, content: [{ type: "text",
      text: "Rally answered in a form this connector does not recognize, so the request may or may not have taken effect. Check in Rally before repeating it (rally_response_invalid:items.0.artifactKind:invalid_value)" }] });
    expect(logged).toHaveBeenCalledWith(JSON.stringify({ event: "rally_mcp_tool_failed", tool: "list_canvases",
      code: "rally_response_invalid:items.0.artifactKind:invalid_value" }));
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

  it("adds a Sidekick to a Canvas through the Canvas's own route, with the operation id as the Sidekick's id and its instructions' message id", async () => {
    const SIDEKICK = "0190a000-0000-7000-8000-0000000000cc";
    const upstream = api(async (request) => {
      expect(`${request.method} ${new URL(request.url).pathname}`).toBe(`POST /canvases/${CANVAS}/sidekicks`);
      expect(await request.json()).toEqual({ sidekickId: SIDEKICK,
        instructions: { text: "On every new email, add a row to Inbox.", clientMessageId: SIDEKICK } });
      return Response.json({ sidekickId: SIDEKICK, turnId: "turn-9" }, { status: 201 });
    });
    const { body } = await rpc(upstream.binding, call("add_canvas_sidekick", {
      canvasId: CANVAS, operationId: SIDEKICK, instructions: "  On every new email, add a row to Inbox. " }));
    expect(JSON.parse(body.result!.content[0]!.text)).toEqual({ sidekickId: SIDEKICK, turnId: "turn-9",
      next: "The Sidekick is made and Rally's setup agent has the instructions. It is a draft until that agent saves it: check its status with get_canvas, and tell the person it may ask them a question in Rally." });
  });

  it("makes a Sidekick with a new Canvas in the one create request, under its own id", async () => {
    const SIDEKICK = "0190a000-0000-7000-8000-0000000000cd";
    const upstream = api(async (request) => {
      expect(`${request.method} ${new URL(request.url).pathname}`).toBe("POST /canvases");
      expect(await request.json()).toEqual({ canvasId: "0190a000-0000-7000-8000-0000000000aa",
        prompt: { text: "Build a PR dashboard", clientMessageId: "0190a000-0000-7000-8000-0000000000aa" },
        sidekick: { sidekickId: SIDEKICK, instructions: { text: "Update it when a pull request is merged.", clientMessageId: SIDEKICK } } });
      return Response.json({ canvasId: "0190a000-0000-7000-8000-0000000000aa", turnId: "turn-1",
        sidekick: { sidekickId: SIDEKICK, turnId: "turn-2" } }, { status: 201 });
    });
    const { body } = await rpc(upstream.binding, call("create_canvas", { operationId: "0190a000-0000-7000-8000-0000000000aa",
      prompt: "Build a PR dashboard", sidekick: { operationId: SIDEKICK, instructions: "Update it when a pull request is merged." } }));
    const result = JSON.parse(body.result!.content[0]!.text) as { sidekick: unknown; next: string };
    expect(result.sidekick).toEqual({ sidekickId: SIDEKICK, turnId: "turn-2" });
    expect(result.next).toContain("It is a draft until that agent saves it");
  });

  it("reports Rally's own refusal, and tells the person to reconnect when the session ended", async () => {
    const upstream = api(() => Response.json({ error: { code: "session_revoked", message: "The session is no longer active" } }, { status: 401 }));
    const { body } = await rpc(upstream.binding, call("get_canvas", { canvasId: CANVAS }));
    expect(body.result).toEqual({ isError: true, content: [{ type: "text",
      text: "The session is no longer active (session_revoked). The connection to Rally has ended; reconnect Rally to continue." }] });
  });

  it("puts a sentence before a refusal whose message is only its diagnostic code", async () => {
    const upstream = api(() => Response.json({ error: { code: "canvas_publish_content_invalid",
      message: "canvas_publish_content_invalid:files.0.content:base64" } }, { status: 422 }));
    const { body } = await rpc(upstream.binding, call("publish_site", { canvasId: CANVAS, name: "pricing",
      files: [{ path: "index.html", content: "%%%", encoding: "base64" }] }));
    expect(body.result).toEqual({ isError: true, content: [{ type: "text",
      text: "Rally could not accept what was sent; the code names the part to correct (canvas_publish_content_invalid:files.0.content:base64)" }] });
  });

  it("publishes a self-contained page as a site through the Canvas's artifacts route", async () => {
    const upstream = api(async (request) => {
      expect(`${request.method} ${new URL(request.url).pathname}`).toBe(`POST /canvases/${CANVAS}/artifacts`);
      expect(await request.json()).toEqual({ kind: "site", name: "pricing", files: [
        { path: "index.html", content: { encoding: "text", data: "<h1>Pricing</h1>" } }] });
      return Response.json({ resourceId: "0190a000-0000-7000-8000-0000000000bb", title: "pricing", kind: "site", version: 1,
        outcome: "created", url: null }, { status: 201 });
    });
    const { body } = await rpc(upstream.binding, call("publish_site", { canvasId: CANVAS,
      name: "pricing", files: [{ path: "index.html", content: "<h1>Pricing</h1>" }] }));
    expect(JSON.parse(body.result!.content[0]!.text)).toMatchObject({ outcome: "created", version: 1 });
    expect(body.result!.content[1]).toEqual({ type: "resource_link", uri: `rally://canvas/${CANVAS}/artifact/0190a000-0000-7000-8000-0000000000bb/v1`, name: "pricing" });
  });

  it("reads a just-published text artifact as one of its Canvas's, from its original before Rally has extracted text from it", async () => {
    const asked: string[] = [];
    const upstream = api((request) => {
      const path = new URL(request.url).pathname;
      asked.push(path);
      if (path.endsWith("/model-content")) {
        return Response.json({ error: { code: "resource_version_content_unavailable", message: "This representation is unavailable for the resource version" } }, { status: 404 });
      }
      return new Response("deal_id,amount\nD-1,100\n", { headers: { "content-type": "text/csv" } });
    });
    const { body } = await rpc(upstream.binding, call("read_artifact", { canvasId: CANVAS, resourceId: "0190a000-0000-7000-8000-0000000000dd", version: 1 }));
    expect(body.result).toEqual({ content: [{ type: "text", text: "deal_id,amount\nD-1,100\n" }] });
    expect(asked).toEqual([
      `/canvases/${CANVAS}/artifacts/0190a000-0000-7000-8000-0000000000dd/versions/1/model-content`,
      `/canvases/${CANVAS}/artifacts/0190a000-0000-7000-8000-0000000000dd/versions/1/content`,
    ]);
  });

  it("does not read an Office document's zip bytes as text while its text is not extracted yet", async () => {
    const upstream = api((request) => {
      if (new URL(request.url).pathname.endsWith("/model-content")) {
        return Response.json({ error: { code: "resource_version_content_unavailable", message: "This representation is unavailable for the resource version" } }, { status: 404 });
      }
      return new Response("PK\u0003\u0004[Content_Types].xml", { headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    });
    const { body } = await rpc(upstream.binding, call("read_artifact", { canvasId: CANVAS, resourceId: "0190a000-0000-7000-8000-0000000000dd", version: 1 }));
    expect(body.result).toEqual({ content: [{ type: "text",
      text: "This version has no text form to read yet. Try again later, or open the Canvas in Rally to see it." }] });
  });

  it("reads an SVG's original as text", async () => {
    const upstream = api((request) => {
      if (new URL(request.url).pathname.endsWith("/model-content")) {
        return Response.json({ error: { code: "resource_version_content_unavailable", message: "x" } }, { status: 404 });
      }
      return new Response("<svg/>", { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
    });
    const { body } = await rpc(upstream.binding, call("read_artifact", { canvasId: CANVAS, resourceId: "0190a000-0000-7000-8000-0000000000dd", version: 1 }));
    expect(body.result).toEqual({ content: [{ type: "text", text: "<svg/>" }] });
  });

  it("refuses to read a Sidekick's conversation as a Canvas's Chat", async () => {
    const upstream = api(() => Response.json({ kind: "automation", title: "Digest", text: "hello", throughSequence: 3, nextAfterSequence: null }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { body } = await rpc(upstream.binding, call("read_canvas_chat", { canvasId: CANVAS }));
    expect(body.result).toMatchObject({ isError: true, content: [{ text: "That id names a Sidekick, not a Canvas (conversation_not_canvas)" }] });
    expect(logged).toHaveBeenCalledWith(JSON.stringify({ event: "rally_mcp_tool_failed", tool: "read_canvas_chat", code: "conversation_not_canvas" }));
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
    const artifactId = "0190a000-0000-7000-8000-0000000000ee";
    const uri = `rally://canvas/${CANVAS}/artifact/${artifactId}/v2`;
    const upstream = api((incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path === `/canvases/${CANVAS}`) return Response.json(canvasDetail([{ resourceId: artifactId, title: "Launch plan", version: 2, mimeType: "text/markdown" }]));
      if (path.endsWith("/model-content")) return Response.json({ error: { code: "resource_version_content_unavailable", message: "x" } }, { status: 404 });
      expect(path).toBe(`/canvases/${CANVAS}/artifacts/${artifactId}/versions/2/content`);
      return new Response("# Launch plan", { headers: { "content-type": "text/markdown" } });
    });
    const { body } = await rpc(upstream.binding, call("get_canvas", { canvasId: CANVAS }));
    expect(body.result!.content.slice(1)).toEqual([{ type: "resource_link", uri, name: "Launch plan", mimeType: "text/markdown" }]);

    const read = (await rpc(upstream.binding, request("resources/read", { uri }))).body as unknown as {
      result: { contents: Array<{ uri: string; text: string }> } };
    expect(read.result.contents).toEqual([{ uri, mimeType: "text/plain", text: "# Launch plan" }]);
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

describe("the request bound", () => {
  it("carries a publish of the largest artifact Rally takes, and refuses one past it before parsing", async () => {
    // 25,000,000 bytes as base64 is 33,333,336 characters; the SDK's own
    // default bound (4 MiB) would refuse it.
    const largest = "A".repeat(33_333_336);
    let forwarded = 0;
    const upstream = api(async (incoming) => {
      forwarded = ((await incoming.json()) as { content: { data: string } }).content.data.length;
      return Response.json({ resourceId: "0190a000-0000-7000-8000-0000000000ff", title: "big.bin", kind: "file", version: 1, outcome: "created", url: null }, { status: 201 });
    });
    const accepted = await rpc(upstream.binding, call("publish_file", { canvasId: CANVAS,
      name: "big.bin", content: largest, encoding: "base64" }));
    expect(accepted.status).toBe(200);
    expect(forwarded).toBe(33_333_336);

    const tooLarge = await worker.fetch(new Request("https://mcp.example.test/mcp", { method: "POST",
      headers: { authorization: `Bearer ${live()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(call("publish_file", { canvasId: CANVAS, name: "huge.bin",
        content: "A".repeat(35_000_000), encoding: "base64" })) }) as Request<unknown, IncomingRequestCfProperties>, env(upstream.binding));
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json<{ error: string; error_description: string }>()).error_description).toContain("as base64");
  }, 60_000);
});

describe("browser-based clients", () => {
  it("answers a hosted origin's preflight without a token, and lets it read the answer", async () => {
    const binding = api(() => Response.json({ items: [] })).binding;
    const preflight = await worker.fetch(new Request("https://mcp.example.test/mcp", { method: "OPTIONS", headers: {
      origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } }) as Request<unknown, IncomingRequestCfProperties>, env(binding));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");

    const answered = await worker.fetch(new Request("https://mcp.example.test/mcp", { method: "POST", headers: {
      origin: "https://claude.ai", authorization: `Bearer ${live()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(call("list_canvases", {})) }) as Request<unknown, IncomingRequestCfProperties>, env(binding));
    expect(answered.status).toBe(200);
    expect(answered.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
  });

  it("refuses any other origin, preflight or not", async () => {
    const binding = api(() => Response.json({})).binding;
    const preflight = await worker.fetch(new Request("https://mcp.example.test/mcp", { method: "OPTIONS",
      headers: { origin: "https://evil.example" } }) as Request<unknown, IncomingRequestCfProperties>, env(binding));
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("compares the whole origin, so a hosted client's host over http, on another port, or an opaque origin is refused", async () => {
    const upstream = api(() => Response.json({ items: [] }));
    for (const origin of ["http://claude.ai", "https://claude.ai:8443", "null"]) {
      const response = await worker.fetch(new Request("https://mcp.example.test/mcp", { method: "POST", headers: {
        origin, authorization: `Bearer ${live()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(call("list_canvases", {})) }) as Request<unknown, IncomingRequestCfProperties>, env(upstream.binding));
      expect([origin, response.status]).toEqual([origin, 403]);
      expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    }
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it("lets a hosted origin read that the person's deployment is unavailable", async () => {
    // A deployment this Worker has no binding for, as a Worker deployed
    // before that deployment's binding was added sees it.
    const unbound = env(api(() => Response.json({})).binding);
    Reflect.deleteProperty(unbound, "GLOBAL_API");
    const response = await worker.fetch(new Request("https://mcp.example.test/mcp", { method: "POST", headers: {
      origin: "https://chatgpt.com", authorization: `Bearer ${live()}`, "content-type": "application/json" },
      body: JSON.stringify(call("list_canvases", {})) }) as Request<unknown, IncomingRequestCfProperties>, unbound);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "region_unavailable" });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
  });
});
