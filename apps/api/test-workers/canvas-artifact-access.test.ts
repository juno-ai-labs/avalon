import { searchAudienceGroupId } from "../src/services/search-audience";
import { ArtifactAccessMessageSchema } from "@rally/contracts/artifact-access";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import {
  reset,
  runInDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asArtifactId,
  asUserId,
  asWorkspaceId,
  asAutomationId,
  asSubstreamId,
  ArtifactManifestSchema,
  artifactAssetKey,
  artifactBlobKey,
  artifactManifestKey,
  type ArtifactManifest,
} from "@rally/contracts";
import type { SitePublishFile } from "../src/services/terminal/site-resource-bridge";
import { sha256Hex } from "../src/lib/crypto";
import { seedWorkstreamRoot } from "./helpers/substream-fixture";
import { startWaitBudget, waitBudget } from "./helpers/wait-budget";
import { createArtifactDataToolContext } from "../src/services/workstream-artifact-data-wiring";
import { createArtifactAudienceTool } from "../src/services/canvas-artifact-audience-tool";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import {
  artifactHostDOName,
  workspaceDOName,
  conversationObjectName,
} from "../src/durable-objects/names";
import {
  applyArtifactAccessChange,
  consumeAccessRevocationQueue,
} from "../src/queues/access-revocation-consumer";
import artifactWorker from "../src/artifacts/index";
import { storedObjectResponse } from "../src/artifacts/stored-object-response";
import { AuthorizationService } from "../src/services/authorization-service";
import { ResourceService } from "../src/services/resource-service";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
import { canvasArtifactNoter } from "../src/services/terminal/authority";
import { createTerminalPortFactory } from "../src/services/terminal/object-port";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import {
  pointArtifactAtVersion,
  publishSiteVersion,
} from "../src/services/terminal/site-resource-bridge";

const OWNER = asUserId("00000000-0000-7000-8000-0000000aa001");
const READER = asUserId("00000000-0000-7000-8000-0000000aa002");
const CANVAS = "00000000-0000-7000-8000-0000000aa100";
const FILE = "00000000-0000-7000-8000-0000000aa200";
const SITE = "00000000-0000-7000-8000-0000000aa201";
const SITE_HOST = asArtifactId("00000000-0000-7000-8000-0000000aa202");
let workspaceId = asWorkspaceId(crypto.randomUUID());
const workspace = () =>
  env.WORKSPACE_DOS.get(
    env.WORKSPACE_DOS.idFromName(
      workspaceDOName(env.AVALON_REGION, workspaceId),
    ),
  );
const host = (id: string) =>
  env.ARTIFACT_HOSTS.get(
    env.ARTIFACT_HOSTS.idFromName(
      artifactHostDOName(env.AVALON_REGION, asArtifactId(id)),
    ),
  );
const share = (
  artifactVisibility: "editors" | "participants" | "workspace" | "public",
  artifactUserIds: string[] = [],
) =>
  workspace().canvasSetAudience({
    workspaceId,
    canvasId: CANVAS,
    actor: { userId: OWNER, actorRole: "member" },
    update: {
      visibility: "creator",
      userIds: [],
      artifactVisibility,
      artifactUserIds: artifactUserIds.map(asUserId),
    },
  });
const snapshot = async () => {
  const delivery = await workspace().canvasArtifactAccessDelivery({
    workspaceId,
    canvasId: CANVAS,
  });
  if (!delivery) throw new Error("missing test Canvas");
  return delivery.snapshot;
};
const sync = (artifactId: string, resourceId = artifactId) =>
  applyArtifactAccessChange(env, {
    kind: "artifact_access_sync",
    region: "global",
    workspaceId,
    canvasId: CANVAS,
    artifactId,
    resourceId,
  });
async function consume(bodies: unknown[]) {
  const batch = createMessageBatch(
    "avalon-do-runtime-test-access-revocations",
    bodies.map((body) => ({
      id: crypto.randomUUID(),
      body,
      timestamp: new Date(),
      attempts: 1,
    })),
  );
  await consumeAccessRevocationQueue(batch, env);
  expect(
    (await getQueueResult(batch, createExecutionContext())).retryMessages,
  ).toEqual([]);
}

beforeEach(async () => {
  await reset();
  workspaceId = asWorkspaceId(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,abandoned_at TEXT,region TEXT,placement_affinity TEXT,analytics_workspace_id TEXT)",
    ),
    env.DB.prepare(
      "INSERT INTO workspaces VALUES(?,'Access test',NULL,'global','wnam',NULL)",
    ).bind(workspaceId),
    env.DB
      .prepare(`CREATE TABLE workspace_members(workspace_id TEXT,user_id TEXT,access_class TEXT,role TEXT,status TEXT,
      incarnation TEXT,revision INTEGER,joined_at TEXT,last_seen_at TEXT,PRIMARY KEY(workspace_id,user_id))`),
    env.DB.prepare(
      `INSERT INTO workspace_members VALUES(?1,?2,'member','member','active','owner-incarnation',1,NULL,NULL),
      (?1,?3,'member','member','active','reader-incarnation',1,NULL,NULL)`,
    ).bind(workspaceId, OWNER, READER),
    env.DB.prepare(
      "CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT)",
    ),
    env.DB.prepare(
      "INSERT INTO users VALUES(?,'Owner',NULL),(?,'Reader',NULL)",
    ).bind(OWNER, READER),
  ]);
  await env.PLATFORM_DB.prepare(
    `CREATE TABLE artifact_hostname_routes(hostname_stub TEXT NOT NULL PRIMARY KEY,region TEXT NOT NULL,
    artifact_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(region,artifact_id))`,
  ).run();
  await workspace().canvasCreate({
    workspaceId,
    canvasId: CANVAS,
    title: "Access test",
    createdByUserId: OWNER,
    authorityGeneration: 1,
  });
  await runInDurableObject(workspace(), (_instance: WorkspaceDO, state) => {
    for (const [id, type, ref, mime] of [
      [FILE, "generated_file", "test-file", "text/plain"],
      [
        SITE,
        "generated_site",
        "test-site-manifest",
        "application/vnd.rally.site-manifest+json",
      ],
    ]) {
      state.storage.sql.exec(
        `INSERT INTO resources(id,workspace_id,resource_type,provider,title,mime_type,content_ref,metadata_json,
        attachment_status,publication_parent_id,revision_author_kind,revision_author_user_id,revision_cause,created_at,updated_at)
        VALUES(?,?,?,'avalon_generated','Published output',?,?, '{}','attached',?,'member',?,'created',?,?)`,
        id,
        workspaceId,
        type,
        mime,
        ref,
        CANVAS,
        OWNER,
        "2026-11-11T12:00:00.000Z",
        "2026-11-11T12:00:00.000Z",
      );
    }
    state.storage.sql.exec(
      `INSERT INTO artifact_registry(artifact_id,workspace_id,workstream_id,resource_id,mode,stateful,current_version,
      manifest_ref,created_at,updated_at,hostname_stub) VALUES(?,?,?,?,'static',0,1,'test-site-manifest',1,1,'quiet-blue-river-garden')`,
      SITE_HOST,
      workspaceId,
      CANVAS,
      SITE,
    );
  });
  const manifest: ArtifactManifest = {
    version: 1,
    artifactId: SITE_HOST,
    artifactVersion: 1,
    mode: "static",
    stateful: false,
    serverModuleSha256: null,
    assets: [
      {
        path: "index.html",
        contentType: "text/html",
        sizeBytes: 17,
        sha256: "a".repeat(64),
      },
    ],
    totalBytes: 17,
    publishedAt: "2026-11-11T12:00:00.000Z",
  };
  await host(SITE_HOST).recordPublish({
    artifactId: SITE_HOST,
    workspaceId,
    workstreamId: CANVAS,
    resourceId: SITE,
    region: "global",
    manifest,
  });
  await env.PAYLOADS.put("test-file", "Published file");
  await env.PAYLOADS.put(
    `artifact/${SITE_HOST}/v1/assets/index.html`,
    "<h1>Website</h1>",
  );
  await env.PLATFORM_DB.prepare(
    "INSERT INTO artifact_hostname_routes VALUES('quiet-blue-river-garden','global',?,'2026-11-11T12:00:00Z')",
  )
    .bind(SITE_HOST)
    .run();
  startWaitBudget();
});

async function visit(stub: string, path = "/", cookie?: string) {
  const ctx = createExecutionContext();
  const response = await artifactWorker.fetch(
    new Request(`https://${stub}-g.rallyusercontent.com${path}`, {
      headers: cookie
        ? {
            cookie: `__rally_artifact_session=${cookie}`,
            "sec-fetch-site": "same-origin",
          }
        : {},
    }),
    {
      APP_ENV: "test",
      AVALON_REGION: "global",
      ARTIFACT_SERVING_DOMAIN: "rallyusercontent.com",
      ARTIFACT_HOSTS: env.ARTIFACT_HOSTS,
      ARTIFACT_SIDEKICKS: ctx.exports.ArtifactSidekickDispatcher({ props: {} }),
      PLATFORM_DB: env.PLATFORM_DB,
      PAYLOADS: env.PAYLOADS,
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("Canvas artifact access propagated to local serving", () => {
  it("keeps public links usable by guests without advertising unrelated Canvases in their search", async () => {
    const guest = asUserId(crypto.randomUUID());
    await env.DB.prepare("INSERT INTO workspace_members VALUES(?,?,'guest',NULL,'active','guest-incarnation',1,NULL,NULL)").bind(workspaceId,guest).run();
    await share('public');
    const group = await searchAudienceGroupId(`artifacts:${CANVAS}`);
    expect(await workspace().readSearchAudience({workspaceId,userId:guest})).not.toContain(group);
    expect((await new AuthorizationService(env).readResource({workspaceId,userId:guest,delegation:null},SITE)).canEditArtifact).toBe(false);
    await share('participants',[guest]);
    expect(await workspace().readSearchAudience({workspaceId,userId:guest})).toContain(group);
  });

  it("retains the old read policy for a legacy generated resource placed in two Canvases", async () => {
    const other = crypto.randomUUID();
    await workspace().canvasCreate({workspaceId,canvasId:other,title:'Other',createdByUserId:OWNER,authorityGeneration:1});
    await runInDurableObject(workspace(),(_instance,state)=>{
      state.storage.sql.exec("UPDATE resources SET publication_parent_id=NULL,uploaded_by_user_id=? WHERE id=?",OWNER,FILE);
      state.storage.sql.exec("INSERT INTO canvas_artifacts VALUES(?,?,1),(?,?,1)",CANVAS,FILE,other,FILE);
    });
    const result = await new AuthorizationService(env).readResource({workspaceId,userId:OWNER,delegation:null},FILE);
    expect(result.resource.id).toBe(FILE);
    expect(result.canEditArtifact).toBeNull();
  });

  it("fails closed before the initial projection, then grants public files and sites and revokes both", async () => {
    expect((await visit("quiet-blue-river-garden")).status).toBe(503);
    const legacy = await host(SITE_HOST).openForViewer({
      userId: OWNER,
      displayName: "Owner",
      appSessionId: "legacy-session",
    });
    const legacyViewer = await host(SITE_HOST).redeemCode(legacy.code);
    await share("public");
    await sync(SITE_HOST, SITE);
    await sync(FILE);
    expect(await (await visit("quiet-blue-river-garden")).text()).toContain(
      "Website",
    );
    const delivery = await workspace().canvasDetail({
      workspaceId,
      canvasId: CANVAS,
      actor: { userId: OWNER, actorRole: "member" },
    });
    expect(delivery.artifactVisibility).toBe("public");
    const fileRoute = await env.PLATFORM_DB.prepare(
      "SELECT hostname_stub FROM artifact_hostname_routes WHERE artifact_id=?",
    )
      .bind(FILE)
      .first<{ hostname_stub: string }>();
    expect(fileRoute).not.toBeNull();
    expect(await (await visit(fileRoute!.hostname_stub)).text()).toBe(
      "Published file",
    );
    await share("editors");
    // Eventual consistency: the previous local projection remains until delivery.
    expect((await visit("quiet-blue-river-garden")).status).toBe(200);
    await sync(SITE_HOST, SITE);
    await sync(FILE);
    expect((await visit("quiet-blue-river-garden")).status).toBe(401);
    expect(
      (await visit("quiet-blue-river-garden", "/", legacyViewer!.session))
        .status,
    ).toBe(401);
    expect((await visit(fileRoute!.hostname_stub)).status).toBe(401);
  });

  it("returns a published file's link, which serves the file to anyone once the Canvas is public", async () => {
    await runInDurableObject(
      env.SUBSTREAM_AGENTS.getByName(conversationObjectName(env.AVALON_REGION, workspaceId, CANVAS, "0")),
      (_instance, state) => seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: CANVAS, parentKind: "canvas" }),
    );
    const bridge = createTerminalResourceBridge(withWorkspaceRuntimeDatabase(env, workspaceId),
      createTerminalPortFactory(env, undefined, "0"), undefined, null, null, null, "0",
      canvasArtifactNoter(env, { workspaceId, parentKind: "canvas", parentId: CANVAS, substreamId: asSubstreamId("0") }));
    const published = await bridge.publishResource({
      workspaceId, workstreamId: CANVAS, harnessRunId: crypto.randomUUID(), toolCallId: crypto.randomUUID(),
      effectIntentId: crypto.randomUUID(), executionPrincipal: { type: "user", userId: OWNER },
      signal: new AbortController().signal,
    }, { filePath: "episode-1.mp3" }, new TextEncoder().encode("episode one audio"));
    expect(published.publishKind).toBe("file");
    const url = new URL("url" in published && published.url ? published.url : "https://missing.invalid");
    // The stub is the first label, ahead of the region suffix.
    const stub = url.hostname.split(".")[0]!.replace(/-g$/u, "");
    await share("public");
    await sync(published.resourceId);
    // The link ends in the file's own name, which podcast apps read its type from.
    expect(url.pathname).toBe("/episode-1.mp3");
    // A podcast app sends no cookie and no fetch metadata.
    const response = await visit(stub, url.pathname);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("episode one audio");
    // The bare host still serves it, and so does any plain name, so a link
    // survives a rename; a path with folders does not.
    expect(await (await visit(stub)).text()).toBe("episode one audio");
    expect(await (await visit(stub, "/renamed-episode.mp3")).text()).toBe("episode one audio");
    expect((await visit(stub, "/episodes/episode-1.mp3")).status).toBe(404);
  });

  it("stores a site's files once by digest, streams new ones in, and serves every version from them", async () => {
    await runInDurableObject(
      env.SUBSTREAM_AGENTS.getByName(conversationObjectName(env.AVALON_REGION, workspaceId, CANVAS, "0")),
      (_instance, state) => seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: CANVAS, parentKind: "canvas" }),
    );
    const bridge = createTerminalResourceBridge(withWorkspaceRuntimeDatabase(env, workspaceId),
      createTerminalPortFactory(env, undefined, "0"), undefined, null, null, null, "0",
      canvasArtifactNoter(env, { workspaceId, parentKind: "canvas", parentId: CANVAS, substreamId: asSubstreamId("0") }));
    const call = () => ({
      workspaceId, workstreamId: CANVAS, harnessRunId: crypto.randomUUID(), toolCallId: crypto.randomUUID(),
      effectIntentId: crypto.randomUUID(), executionPrincipal: { type: "user" as const, userId: OWNER },
      signal: new AbortController().signal,
    });
    const file = async (path: string, text: string) => {
      const bytes = new TextEncoder().encode(text);
      return { path, bytes, sha256: await sha256Hex(bytes) };
    };
    const streamed = async (path: string, text: string, sent: string | (() => Promise<ReadableStream>) = text) => {
      const bytes = new TextEncoder().encode(text);
      return { path, sha256: await sha256Hex(bytes), sizeBytes: bytes.byteLength,
        open: typeof sent === "string" ? async () => new Response(sent).body! : sent };
    };
    const never = async (): Promise<ReadableStream> => { throw new Error("opened_a_file_that_needs_no_bytes"); };
    const stored = async (path: string, text: string, storedIn: string) => {
      const bytes = new TextEncoder().encode(text);
      return { path, sha256: await sha256Hex(bytes), sizeBytes: bytes.byteLength, storedIn };
    };
    const site = (files: SitePublishFile[]) => ({ mode: "static" as const, stateful: false, serverModuleSha256: null, files });
    const publish = (files: SitePublishFile[]) => bridge.publishSiteResource(call(), { filePath: "feed" }, site(files));

    const one = await streamed("episodes/one.mp3", "episode one audio");
    const first = await publish([await file("index.html", "<h1>Show</h1>"), one, await streamed("empty.txt", "", never)]);
    const blob = artifactBlobKey(first.artifactId, one.sha256);
    expect(await (await env.PAYLOADS.get(blob))?.text()).toBe("episode one audio");
    // An empty file is stored without being opened.
    expect((await env.PAYLOADS.head(artifactBlobKey(first.artifactId, await sha256Hex(new Uint8Array()))))?.size).toBe(0);
    expect((await bridge.liveSiteFiles(call(), "feed"))?.manifest.assets)
      .toContainEqual({ path: "episodes/one.mp3", contentType: "audio/mpeg", sha256: one.sha256, sizeBytes: 17 });

    // The next episode: the first is already stored, so it is neither opened nor written,
    // and a second path with the same bytes shares its blob.
    const before = (await env.PAYLOADS.head(blob))!.uploaded.getTime();
    const second = await publish([
      await file("index.html", "<h1>Show, two episodes</h1>"),
      await stored("episodes/one.mp3", "episode one audio", first.artifactId),
      await stored("episodes/one-again.mp3", "episode one audio", first.artifactId),
      await streamed("episodes/two.mp3", "episode two audio"),
    ]);
    expect(second.version).toBe(2);
    expect((await env.PAYLOADS.head(blob))!.uploaded.getTime()).toBe(before);

    // A file that changed after it was listed (other bytes, fewer, or more) is named as
    // that, and the site keeps serving version 2. A provider's failure keeps its own code.
    for (const sent of ["episode three AUDIO", "episode three", "episode three audio, longer"]) {
      await expect(publish([await file("index.html", "<h1>Show, three</h1>"), await streamed("episodes/three.mp3", "episode three audio", sent)]))
        .rejects.toMatchObject({ code: "resource_not_ready", details: { code: "site_file_changed_after_listing" } });
    }
    await expect(publish([await file("index.html", "<h1>Show, three</h1>"),
      await streamed("episodes/three.mp3", "episode three audio", async () => { throw new Error("daytona_file_stream_http_502"); })]))
      .rejects.toMatchObject({ code: "resource_publish_failed", details: { code: "daytona_file_stream_http_502" } });
    // A file gone from the sandbox changed too, and a retry after its producer finishes can succeed.
    await expect(publish([await file("index.html", "<h1>Show, three</h1>"),
      await streamed("episodes/three.mp3", "episode three audio", async () => { throw new Error("daytona_file_stream_http_404"); })]))
      .rejects.toMatchObject({ code: "resource_not_ready", details: { code: "site_file_changed_after_listing" } });
    // A file said to be in another artifact's blobs is refused, never left unwritten.
    await expect(publish([await file("index.html", "<h1>Show, three</h1>"),
      await stored("episodes/elsewhere.mp3", "elsewhere", "00000000-0000-7000-8000-00000000beef")]))
      .rejects.toMatchObject({ code: "resource_publish_failed", details: { code: "site_file_stored_in_another_artifact" } });
    // A download that breaks partway is named by its own error, not as a changed file.
    const breaksPartway = async () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("episode")); controller.error(new Error("daytona_download_reset")); },
    });
    await expect(publish([await file("index.html", "<h1>Show, three</h1>"),
      await streamed("episodes/three.mp3", "episode three audio", breaksPartway)]))
      .rejects.toMatchObject({ code: "resource_publish_failed", details: { code: "daytona_download_reset" } });
    expect((await bridge.liveSiteFiles(call(), "feed"))?.manifest.assets.map((entry) => entry.path))
      .toEqual(expect.arrayContaining(["episodes/one.mp3", "episodes/two.mp3"]));

    // A live version stored before blobs holds nothing a publish may leave
    // unwritten, so the publish counts and streams every file.
    const liveManifestKey = artifactManifestKey(first.artifactId, 2);
    const liveManifest = ArtifactManifestSchema.parse(await (await env.PAYLOADS.get(liveManifestKey))!.json());
    const legacyManifest = { ...liveManifest };
    delete legacyManifest.assetStore;
    await env.PAYLOADS.put(liveManifestKey, JSON.stringify(legacyManifest));
    expect(await bridge.liveSiteFiles(call(), "feed")).toBeNull();
    await env.PAYLOADS.put(liveManifestKey, JSON.stringify(liveManifest));

    // The serving Worker reads the blob through the manifest.
    await share("public");
    await sync(first.artifactId, first.resourceId);
    const stub = new URL(first.url).hostname.split(".")[0]!.replace(/-g$/u, "");
    const served = await visit(stub, "/episodes/two.mp3");
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("episode two audio");
    // A site's stored file revalidates; its page does not.
    expect(served.headers.get("cache-control")).toBe("private, no-cache");
    expect((await visit(stub, "/")).headers.get("cache-control")).toBe("private, no-store");
  });

  it("serves a byte range of a public file and a site's asset, as a player seeking asks for one", async () => {
    await share("public");
    await sync(SITE_HOST, SITE);
    await sync(FILE);
    const fileStub = (await env.PLATFORM_DB.prepare("SELECT hostname_stub FROM artifact_hostname_routes WHERE artifact_id=?")
      .bind(FILE).first<{ hostname_stub: string }>())!.hostname_stub;
    // As an anonymous player sends it: no cookie, no fetch metadata.
    const fetchFrom = async (stub: string, init: RequestInit) => {
      const ctx = createExecutionContext();
      const response = await artifactWorker.fetch(new Request(`https://${stub}-g.rallyusercontent.com/`, init), {
        APP_ENV: "test", AVALON_REGION: "global", ARTIFACT_SERVING_DOMAIN: "rallyusercontent.com",
        ARTIFACT_HOSTS: env.ARTIFACT_HOSTS, ARTIFACT_SIDEKICKS: ctx.exports.ArtifactSidekickDispatcher({ props: {} }),
        PLATFORM_DB: env.PLATFORM_DB, PAYLOADS: env.PAYLOADS,
      }, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    const read = async (response: Response) => ({
      status: response.status,
      body: await response.text(),
      length: response.headers.get("content-length"),
      range: response.headers.get("content-range"),
      accepts: response.headers.get("accept-ranges"),
    });

    // The stored file is "Published file", 14 bytes.
    expect(await read(await fetchFrom(fileStub, { headers: { range: "bytes=0-8" } })))
      .toEqual({ status: 206, body: "Published", length: "9", range: "bytes 0-8/14", accepts: "bytes" });
    expect(await read(await fetchFrom(fileStub, { headers: { range: "bytes=-4" } })))
      .toMatchObject({ status: 206, body: "file", range: "bytes 10-13/14" });
    expect(await read(await fetchFrom(fileStub, { headers: { range: "bytes=10-" } })))
      .toMatchObject({ status: 206, body: "file", range: "bytes 10-13/14" });
    expect(await read(await fetchFrom(fileStub, { headers: { range: "bytes=14-" } })))
      .toMatchObject({ status: 416, body: "", range: "bytes */14" });
    // A range running past the end is cut to the end, as RFC 9110 says.
    expect(await read(await fetchFrom(fileStub, { headers: { range: "bytes=10-99" } })))
      .toMatchObject({ status: 206, body: "file", length: "4", range: "bytes 10-13/14" });
    expect(await read(await fetchFrom(fileStub, {})))
      .toEqual({ status: 200, body: "Published file", length: "14", range: null, accepts: "bytes" });
    expect(await read(await fetchFrom(fileStub, { method: "HEAD" })))
      .toEqual({ status: 200, body: "", length: "14", range: null, accepts: "bytes" });
    // A resumed download that holds another version gets the whole current one.
    const etag = (await fetchFrom(fileStub, { method: "HEAD" })).headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await read(await fetchFrom(fileStub, { headers: { range: "bytes=0-8", "if-range": "\"another-version\"" } })))
      .toMatchObject({ status: 200, body: "Published file" });
    expect(await read(await fetchFrom(fileStub, { headers: { range: "bytes=0-8", "if-range": etag! } })))
      .toMatchObject({ status: 206, body: "Published" });

    // A static site's asset, "<h1>Website</h1>", answers a range the same way.
    expect(await read(await fetchFrom("quiet-blue-river-garden", { headers: { range: "bytes=4-10" } })))
      .toEqual({ status: 206, body: "Website", length: "7", range: "bytes 4-10/16", accepts: "bytes" });

    // A range is no way around the audience: a private file refuses it whole.
    await share("editors");
    await sync(FILE);
    expect((await fetchFrom(fileStub, { headers: { range: "bytes=0-8" } })).status).toBe(401);
  });

  it("lets a browser keep a public file and revalidate it, and stops answering once the Canvas is private", async () => {
    await share("public");
    await sync(SITE_HOST, SITE);
    await sync(FILE);
    const fileStub = (await env.PLATFORM_DB.prepare("SELECT hostname_stub FROM artifact_hostname_routes WHERE artifact_id=?")
      .bind(FILE).first<{ hostname_stub: string }>())!.hostname_stub;
    const fetchFrom = async (stub: string, init: RequestInit) => {
      const ctx = createExecutionContext();
      const response = await artifactWorker.fetch(new Request(`https://${stub}-g.rallyusercontent.com/`, init), {
        APP_ENV: "test", AVALON_REGION: "global", ARTIFACT_SERVING_DOMAIN: "rallyusercontent.com",
        ARTIFACT_HOSTS: env.ARTIFACT_HOSTS, ARTIFACT_SIDEKICKS: ctx.exports.ArtifactSidekickDispatcher({ props: {} }),
        PLATFORM_DB: env.PLATFORM_DB, PAYLOADS: env.PAYLOADS,
      }, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    const first = await fetchFrom(fileStub, {});
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const etag = first.headers.get("etag")!;
    const read = async (response: Response) => ({ status: response.status, body: await response.text() });
    expect(await read(await fetchFrom(fileStub, { headers: { "if-none-match": etag } })))
      .toEqual({ status: 304, body: "" });
    expect((await fetchFrom(fileStub, { method: "HEAD", headers: { "if-none-match": etag } })).status).toBe(304);
    expect(await read(await fetchFrom(fileStub, { headers: { "if-none-match": "\"another-version\"" } })))
      .toEqual({ status: 200, body: "Published file" });
    // Weak tags, lists and `*` match as RFC 9110 has `If-None-Match` compare.
    expect((await fetchFrom(fileStub, { headers: { "if-none-match": `"other", W/${etag}` } })).status).toBe(304);
    expect((await fetchFrom(fileStub, { headers: { "if-none-match": "*" } })).status).toBe(304);
    // A stale tag beside a range is answered with the range, not the whole file.
    expect((await fetchFrom(fileStub, { headers: { "if-none-match": "\"another-version\"", range: "bytes=0-8" } })).status)
      .toBe(206);
    // A caller whose HTML Rally may rewrite asks for exact bytes off, and gets neither a
    // range nor a 304 from the stored page's tag.
    const stored = (await env.PAYLOADS.head(`artifact/${SITE_HOST}/v1/assets/index.html`))!;
    const whole = await storedObjectResponse(env.PAYLOADS, `artifact/${SITE_HOST}/v1/assets/index.html`,
      new Request("https://x.invalid/", { headers: { "if-none-match": stored.httpEtag, range: "bytes=0-3" } }),
      { "content-type": "text/html" }, { ranges: false });
    expect(whole?.status).toBe(200);
    // Nor is a file opened in a tab, whose back-forward copy the browser shows without asking.
    expect((await fetchFrom(fileStub, { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } }))
      .headers.get("cache-control")).toBe("private, no-store");
    // A page is never kept: a private page would outlive its Canvas in the browser.
    const page = await fetchFrom("quiet-blue-river-garden", {});
    expect(page.headers.get("cache-control")).toBe("private, no-store");

    // Every revalidation is admitted first, so a private Canvas refuses at once.
    await share("editors");
    await sync(FILE);
    expect((await fetchFrom(fileStub, { headers: { "if-none-match": etag } })).status).toBe(401);
  });

  it("sends an active site's page whole, with no stale length, when Rally injects into it", async () => {
    // An active site that ends in the taught `env.ASSETS.fetch(request)`, with
    // a share card Rally injects into its page on the way out.
    const page = "<html><head><title>Board</title></head><body>Board</body></html>";
    const activeResource = crypto.randomUUID();
    const activeHost = asArtifactId(crypto.randomUUID());
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO resources(id,workspace_id,resource_type,provider,title,mime_type,content_ref,metadata_json,
        attachment_status,publication_parent_id,revision_author_kind,revision_author_user_id,revision_cause,created_at,updated_at)
        VALUES(?,?,'generated_site','avalon_generated','Board','application/vnd.rally.site-manifest+json','active-manifest','{}',
        'attached',?,'member',?,'created','2026-11-11T12:00:00.000Z','2026-11-11T12:00:00.000Z')`,
        activeResource, workspaceId, CANVAS, OWNER);
      state.storage.sql.exec(
        `INSERT INTO artifact_registry(artifact_id,workspace_id,workstream_id,resource_id,mode,stateful,current_version,
        manifest_ref,created_at,updated_at,hostname_stub) VALUES(?,?,?,?,'active',0,1,'active-manifest',1,1,'calm-green-active-page')`,
        activeHost, workspaceId, CANVAS, activeResource);
    });
    await env.PLATFORM_DB.prepare("INSERT INTO artifact_hostname_routes VALUES('calm-green-active-page','global',?,'2026-11-11T12:00:00Z')")
      .bind(activeHost).run();
    await env.PAYLOADS.put(`artifact/${activeHost}/v1/assets/index.js`,
      "export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };");
    await env.PAYLOADS.put(`artifact/${activeHost}/v1/assets/index.html`, page);
    await host(activeHost).recordPublish({
      artifactId: activeHost, workspaceId, workstreamId: CANVAS, resourceId: activeResource, region: "global",
      manifest: {
        version: 1, artifactId: activeHost, artifactVersion: 1, mode: "active", stateful: false,
        serverModuleSha256: "a".repeat(64), totalBytes: page.length, publishedAt: "2026-11-11T12:00:00.000Z",
        assets: [{ path: "index.html", contentType: "text/html; charset=utf-8", sizeBytes: page.length, sha256: "b".repeat(64) }],
        socialPreview: {
          title: "Board", description: "The team's board",
          image: { path: "social-preview.png", contentType: "image/png", width: 1200, height: 630, alt: "Board", generated: true },
        },
      },
    });
    await share("public");
    await sync(activeHost, activeResource);
    const loader = env.ARTIFACT_LOADER;
    if (!loader) throw new Error("this test needs the worker_loaders binding");
    const fetchPage = async (headers: Record<string, string>) => {
      const ctx = createExecutionContext();
      const response = await artifactWorker.fetch(new Request("https://calm-green-active-page-g.rallyusercontent.com/", { headers }), {
        APP_ENV: "test", AVALON_REGION: "global", ARTIFACT_SERVING_DOMAIN: "rallyusercontent.com",
        ARTIFACT_HOSTS: env.ARTIFACT_HOSTS, ARTIFACT_SIDEKICKS: ctx.exports.ArtifactSidekickDispatcher({ props: {} }),
        ARTIFACT_LOADER: loader, PLATFORM_DB: env.PLATFORM_DB, PAYLOADS: env.PAYLOADS,
      }, ctx);
      await waitOnExecutionContext(ctx);
      const body = await response.text();
      return { status: response.status, body, length: response.headers.get("content-length"), range: response.headers.get("content-range") };
    };
    for (const headers of [{}, { range: "bytes=0-9" }]) {
      const served = await fetchPage(headers);
      expect(served.status).toBe(200);
      expect(served.range).toBeNull();
      // Rally's card is in the page, and no header claims the stored page's shorter length.
      expect(served.body).toContain('property="og:title"');
      expect(served.body).toContain("<body>Board</body>");
      expect(served.length === null || Number(served.length) === new TextEncoder().encode(served.body).length).toBe(true);
    }
  });

  it("serves a blob-stored active site: its module loads by digest and its assets by the manifest", async () => {
    await runInDurableObject(
      env.SUBSTREAM_AGENTS.getByName(conversationObjectName(env.AVALON_REGION, workspaceId, CANVAS, "0")),
      (_instance, state) => seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: CANVAS, parentKind: "canvas" }),
    );
    const bridge = createTerminalResourceBridge(withWorkspaceRuntimeDatabase(env, workspaceId),
      createTerminalPortFactory(env, undefined, "0"), undefined, null, null, null, "0",
      canvasArtifactNoter(env, { workspaceId, parentKind: "canvas", parentId: CANVAS, substreamId: asSubstreamId("0") }));
    const file = async (path: string, text: string) => {
      const bytes = new TextEncoder().encode(text);
      return { path, bytes, sha256: await sha256Hex(bytes) };
    };
    const module = await file("index.js", "export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };");
    const published = await bridge.publishSiteResource({
      workspaceId, workstreamId: CANVAS, harnessRunId: crypto.randomUUID(), toolCallId: crypto.randomUUID(),
      effectIntentId: crypto.randomUUID(), executionPrincipal: { type: "user", userId: OWNER },
      signal: new AbortController().signal,
    }, { filePath: "board" }, {
      mode: "active", stateful: false, serverModuleSha256: module.sha256,
      files: [module, await file("index.html", "<h1>Board</h1>"), await file("data/rows.json", "[1,2,3]")],
    });
    // The module is a blob like every other file, and nothing is at the old path.
    expect(await env.PAYLOADS.head(artifactBlobKey(published.artifactId, module.sha256))).not.toBeNull();
    expect(await env.PAYLOADS.head(artifactAssetKey(published.artifactId, 1, "index.js"))).toBeNull();
    await share("public");
    await sync(published.artifactId, published.resourceId);
    const loader = env.ARTIFACT_LOADER;
    if (!loader) throw new Error("this test needs the worker_loaders binding");
    const stub = new URL(published.url).hostname.split(".")[0]!.replace(/-g$/u, "");
    const fetchPath = async (path: string) => {
      const ctx = createExecutionContext();
      const response = await artifactWorker.fetch(new Request(`https://${stub}-g.rallyusercontent.com${path}`), {
        APP_ENV: "test", AVALON_REGION: "global", ARTIFACT_SERVING_DOMAIN: "rallyusercontent.com",
        ARTIFACT_HOSTS: env.ARTIFACT_HOSTS, ARTIFACT_SIDEKICKS: ctx.exports.ArtifactSidekickDispatcher({ props: {} }),
        ARTIFACT_LOADER: loader, PLATFORM_DB: env.PLATFORM_DB, PAYLOADS: env.PAYLOADS,
      }, ctx);
      await waitOnExecutionContext(ctx);
      return { status: response.status, body: await response.text() };
    };
    expect(await fetchPath("/data/rows.json")).toEqual({ status: 200, body: "[1,2,3]" });
    expect((await fetchPath("/")).body).toContain("<h1>Board</h1>");
  });

  it("artifact-only users can use artifacts but cannot read the conversation; old cookies lose access", async () => {
    await share("participants", [READER]);
    await sync(SITE_HOST, SITE);
    await runInDurableObject(workspace(), async (instance) => {
      await expect(
        instance.canvasDetail({
          workspaceId,
          canvasId: CANVAS,
          actor: { userId: READER, actorRole: "member" },
        }),
      ).rejects.toThrow();
    });
    const decision = await new AuthorizationService(env).checkMany(
      { workspaceId, userId: READER, delegation: null },
      [{ kind: "resource", workspaceId, resourceId: SITE }],
    );
    expect(decision[0]?.status).toBe("allowed");
    const { code } = await host(SITE_HOST).openForViewer({
      userId: READER,
      displayName: "Reader",
      appSessionId: "reader-session",
    });
    const session = await host(SITE_HOST).redeemCode(code);
    expect(session).not.toBeNull();
    expect(
      (await visit("quiet-blue-river-garden", "/", session!.session)).status,
    ).toBe(200);
    await share("editors");
    await sync(SITE_HOST, SITE);
    expect(
      (await visit("quiet-blue-river-garden", "/", session!.session)).status,
    ).toBe(403);
    expect((await host(SITE_HOST).checkSession(session!.session)).ok).toBe(
      true,
    );
  });

  it("renews a viewer session for a year when a person opens the page, never on the page's own requests", async () => {
    await share("participants", [READER]);
    await sync(SITE_HOST, SITE);
    const { code } = await host(SITE_HOST).openForViewer({
      userId: READER,
      displayName: "Reader",
      appSessionId: "reader-session",
    });
    const viewer = await host(SITE_HOST).redeemCode(code);
    const sessionExpiry = () => runInDurableObject(host(SITE_HOST), async (_instance, state) =>
      state.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM viewer_sessions WHERE redeemed_at IS NOT NULL").one().expires_at);
    // A session a minute from expiry, as one last opened a year ago would be.
    const soon = Date.now() + 60_000;
    await runInDurableObject(host(SITE_HOST), async (_instance, state) => {
      state.storage.sql.exec("UPDATE viewer_sessions SET expires_at=? WHERE redeemed_at IS NOT NULL", soon);
    });
    const poll = await visit("quiet-blue-river-garden", "/", viewer!.session);
    expect(poll.status).toBe(200);
    expect(poll.headers.get("set-cookie")).toBeNull();
    expect(await sessionExpiry()).toBe(soon);

    const navigate = async (site: string) => {
      const ctx = createExecutionContext();
      const response = await artifactWorker.fetch(
        new Request("https://quiet-blue-river-garden-g.rallyusercontent.com/", {
          headers: {
            cookie: `__rally_artifact_session=${viewer!.session}`,
            "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
          },
        }),
        {
          APP_ENV: "test", AVALON_REGION: "global", ARTIFACT_SERVING_DOMAIN: "rallyusercontent.com",
          ARTIFACT_HOSTS: env.ARTIFACT_HOSTS, ARTIFACT_SIDEKICKS: ctx.exports.ArtifactSidekickDispatcher({ props: {} }),
          PLATFORM_DB: env.PLATFORM_DB, PAYLOADS: env.PAYLOADS,
        },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    // The page reloading itself, or bouncing itself back through an outside
    // redirect with no click, is a navigation too, but not an open.
    for (const site of ["same-origin", "cross-site"]) {
      const scripted = await navigate(site);
      expect(scripted.status).toBe(200);
      expect(scripted.headers.get("set-cookie")).toBeNull();
      expect(await sessionExpiry()).toBe(soon);
    }

    const opened = await navigate("none");
    expect(opened.status).toBe(200);
    const yearSeconds = 365 * 24 * 60 * 60;
    const maxAge = Number(/Max-Age=(\d+)/u.exec(opened.headers.get("set-cookie") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(yearSeconds - 60);
    expect(maxAge).toBeLessThanOrEqual(yearSeconds);
    expect(opened.headers.get("set-cookie")).toContain(`__rally_artifact_session=${viewer!.session}`);
    expect(await sessionExpiry()).toBeGreaterThan(Date.now() + (yearSeconds - 60) * 1_000);
  });

  it("prunes an open code nobody redeemed once the code expires, not a year later", async () => {
    await share("participants", [READER]);
    await sync(SITE_HOST, SITE);
    const viewer = { userId: READER, displayName: "Reader", appSessionId: "reader-session" };
    await host(SITE_HOST).openForViewer(viewer);
    const pending = () => runInDurableObject(host(SITE_HOST), async (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM viewer_sessions WHERE redeemed_at IS NULL").one().count);
    expect(await pending()).toBe(1);
    await runInDurableObject(host(SITE_HOST), async (_instance, state) => {
      state.storage.sql.exec("UPDATE viewer_sessions SET code_expires_at=? WHERE redeemed_at IS NULL", Date.now() - 1);
    });
    // The next open prunes the dead code and leaves only its own.
    await host(SITE_HOST).openForViewer(viewer);
    expect(await pending()).toBe(1);
  });

  it("keeps source and administrative data editor-only for artifact users", async () => {
    await share("participants", [READER]);
    const authorization = new AuthorizationService(env);
    expect(
      (
        await authorization.readResource(
          { workspaceId, userId: READER, delegation: null },
          SITE,
        )
      ).canEditArtifact,
    ).toBe(false);
    await expect(
      authorization.readResourceForEditing(
        { workspaceId, userId: READER, delegation: null },
        SITE,
      ),
    ).rejects.toThrow("Resource not found");
    expect(
      (
        await authorization.readResourceForEditing(
          { workspaceId, userId: OWNER, delegation: null },
          SITE,
        )
      ).canEditArtifact,
    ).toBe(true);
    const runtime = withWorkspaceRuntimeDatabase(env, workspaceId);
    // Direct ID admission uses a real Sidekick conversation; do not grant a
    // conversation attachment as a substitute for editor authorization.
    const sidekickId = crypto.randomUUID();
    await workspace().sidekickCreate({
      workspaceId,
      automationId: asAutomationId(sidekickId),
      authorityGeneration: 1,
      authorUserId: READER,
      scope: "personal",
    });
    const loop = env.SUBSTREAM_AGENTS.getByName(
      conversationObjectName(env.AVALON_REGION, workspaceId, sidekickId, "0"),
    );
    await runInDurableObject(loop, (_instance, state) =>
      seedWorkstreamRoot(state, 1, {
        workspaceId,
        workstreamId: sidekickId,
        parentKind: "automation",
      }),
    );
    const readerData = createArtifactDataToolContext(runtime, {
      workspaceId,
      workstreamId: sidekickId,
      principal: { type: "user", userId: READER },
      reader: READER,
    });
    expect(await readerData.resolveArtifact(SITE)).toBeNull();
    const unexpectedProviderCall = async (): Promise<never> => { throw new Error("unexpected_provider_call"); };
    const provider: TerminalSandboxProvider = {
      createSandbox: unexpectedProviderCall, getSandbox: unexpectedProviderCall,
      startSandbox: unexpectedProviderCall, recoverSandbox: unexpectedProviderCall,
      stopSandbox: unexpectedProviderCall, archiveSandbox: unexpectedProviderCall,
      deleteSandbox: unexpectedProviderCall, updateNetworkPolicy: unexpectedProviderCall,
      configureGitHubReadAccess: unexpectedProviderCall, clearGitHubReadAccess: unexpectedProviderCall,
      readFile: unexpectedProviderCall, writeFile: unexpectedProviderCall,
      runUtilityCommand: unexpectedProviderCall, runCommand: unexpectedProviderCall,
    };
    const terminal = createTerminalResourceBridge(runtime, () => {
      throw new Error("unexpected_terminal_storage");
    });
    await expect(
      terminal.importResource(
        {
          workspaceId,
          workstreamId: sidekickId,
          harnessRunId: crypto.randomUUID(),
          toolCallId: "source-import",
          executionPrincipal: { type: "user", userId: READER },
          signal: new AbortController().signal,
        },
        { resourceId: SITE, destinationPath: "site" },
        "site",
        1,
        "sandbox",
        provider,
      ),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    const resources = new ResourceService(env, {
      workspaceId,
      userId: READER,
      region: "global",
      role: "member",
      sessionId: "resource-read",
    });
    await expect(resources.content(SITE)).rejects.toMatchObject({
      code: "resource_not_found",
    });
  });

  it("preserves omitted artifact recipients and admits a selected person who is also an editor", async () => {
    await share("participants", [READER]);
    const detail = await workspace().canvasSetAudience({
      workspaceId,
      canvasId: CANVAS,
      actor: { userId: OWNER, actorRole: "member" },
      update: {
        visibility: "participants",
        userIds: [READER],
        artifactVisibility: "workspace",
      },
    });
    expect(detail.artifactUserIds).toEqual([READER]);
    expect(
      (await snapshot()).users.find((person) => person.userId === READER)
        ?.editor,
    ).toBe(true);
  });

  it("stores Organization-wide artifact access whenever the Organization edits, from any caller", async () => {
    const audience = (
      visibility: "creator" | "workspace",
      artifactVisibility?: "editors" | "public",
    ) =>
      workspace().canvasSetAudience({
        workspaceId,
        canvasId: CANVAS,
        actor: { userId: OWNER, actorRole: "member" },
        update: {
          visibility,
          userIds: [],
          ...(artifactVisibility ? { artifactVisibility } : {}),
        },
      });
    await share("editors");
    // An API or MCP caller asks for a narrower artifact audience than its editors.
    expect((await audience("workspace", "editors")).artifactVisibility).toBe(
      "workspace",
    );
    // Omitting it on the way back keeps what was stored, so this reads the row.
    expect((await audience("creator")).artifactVisibility).toBe("workspace");
    expect((await audience("workspace", "public")).artifactVisibility).toBe(
      "public",
    );
  });

  it("raising editors-only artifact access does not revive recipients it had left inactive", async () => {
    const audience = (
      visibility: "creator" | "workspace",
      artifactVisibility?: "editors",
    ) =>
      workspace().canvasSetAudience({
        workspaceId,
        canvasId: CANVAS,
        actor: { userId: OWNER, actorRole: "member" },
        update: {
          visibility,
          userIds: [],
          ...(artifactVisibility ? { artifactVisibility } : {}),
        },
      });
    await share("participants", [READER]);
    // Raised from Specific people: the named recipient stays.
    expect((await audience("workspace")).artifactUserIds).toEqual([READER]);
    // Editors only keeps the omitted recipient row, inactive.
    expect((await audience("creator", "editors")).artifactUserIds).toEqual([READER]);
    // Raised from Editors only: the inactive row is dropped, not honoured.
    const raised = await audience("workspace");
    expect(raised.artifactVisibility).toBe("workspace");
    expect(raised.artifactUserIds).toEqual([]);
  });

  it("lets a Chat's manager open its site to the public with set_artifact_audience, and refuses an editor who does not manage it", async () => {
    // READER is an editor of the Canvas, not its manager. Leaving the artifact
    // audience out keeps the new Canvas's default unchosen.
    await workspace().canvasSetAudience({
      workspaceId,
      canvasId: CANVAS,
      actor: { userId: OWNER, actorRole: "member" },
      update: { visibility: "participants", userIds: [READER] },
    });
    const call = (userId: string, personAsked = false) =>
      createArtifactAudienceTool(env, { workspaceId, canvasId: CANVAS, userId })
        .execute({ audience: "public", personAsked }, {} as never);

    await expect(call(READER)).rejects.toMatchObject({ code: "artifact_audience_not_manager" });
    await sync(SITE_HOST, SITE);
    expect((await visit("quiet-blue-river-garden")).status).toBe(401);

    expect((await call(OWNER)).output).toEqual({ audience: "public", changed: true });
    await sync(SITE_HOST, SITE);
    expect((await visit("quiet-blue-river-garden")).status).toBe(200);
    const detail = await workspace().canvasDetail({
      workspaceId,
      canvasId: CANVAS,
      actor: { userId: OWNER, actorRole: "member" },
    });
    // The editor audience is left as it was.
    expect(detail.visibility).toBe("participants");
    expect(detail.participantUserIds).toEqual([READER]);
  });

  it("refuses set_artifact_audience from a creator who has left the Organization", async () => {
    await workspace().applyMemberStatus({
      workspaceId,
      sequence: 1,
      removed: true,
      relationship: {
        workspaceId,
        userId: OWNER,
        incarnation: "owner-incarnation",
        revision: 2,
        accessClass: "member",
        role: "member",
        status: "active",
      },
    });
    await expect(
      createArtifactAudienceTool(env, { workspaceId, canvasId: CANVAS, userId: OWNER })
        .execute({ audience: "public", personAsked: true }, {} as never),
    ).rejects.toMatchObject({ code: "canvas_not_found" });
    await sync(SITE_HOST, SITE);
    expect((await visit("quiet-blue-river-garden")).status).toBe(401);
  });

  it("never lets a background agent override the audience a manager chose, whatever it claims", async () => {
    await share("editors");
    // An agent's conversation has no person in it, so its "person asked" is a default.
    const agentCall = await createArtifactAudienceTool(env, { workspaceId, canvasId: CANVAS, userId: OWNER, defaultOnly: true })
      .execute({ audience: "public", personAsked: true }, {} as never);
    expect(agentCall.output).toMatchObject({ audience: "editors", changed: false });
    await sync(SITE_HOST, SITE);
    expect((await visit("quiet-blue-river-garden")).status).toBe(401);
  });

  it("never lets an agent's default reopen artifacts a manager restricted in Share", async () => {
    const call = (personAsked: boolean) =>
      createArtifactAudienceTool(env, { workspaceId, canvasId: CANVAS, userId: OWNER })
        .execute({ audience: "public", personAsked }, {} as never);
    // A manager restricts the Canvas's artifacts in Share.
    await share("editors");

    // A later site's default leaves it alone.
    expect((await call(false)).output).toMatchObject({ audience: "editors", changed: false });
    await sync(SITE_HOST, SITE);
    expect((await visit("quiet-blue-river-garden")).status).toBe(401);

    // The person asking for it in the Chat still changes it.
    expect((await call(true)).output).toEqual({ audience: "public", changed: true });
    await sync(SITE_HOST, SITE);
    expect((await visit("quiet-blue-river-garden")).status).toBe(200);
  });

  it("uses site manifests to recognize upgraded archives and never replaces site serving with a file", async () => {
    await share("public");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE resources SET resource_type='generated_file' WHERE id=?",
        SITE,
      );
    });
    expect(
      (
        await workspace().canvasArtifactAccessDelivery({
          workspaceId,
          canvasId: CANVAS,
          resourceId: SITE,
        })
      )?.file,
    ).toBeNull();
    await sync(SITE_HOST, SITE);
    const access = await snapshot();
    await host(SITE_HOST).recordFilePublication({
      workspaceId,
      canvasId: CANVAS,
      revision: access.revision,
      file: {
        resourceId: SITE,
        title: "Manifest",
        versions: [
          {
            version: 1,
            contentRef: "test-site-manifest",
            mimeType: "application/json",
          },
        ],
      },
    });
    expect(await (await visit("quiet-blue-river-garden")).text()).toContain(
      "Website",
    );
  });

  it("returns 403 for an identified artifact user opening a historical site navigation", async () => {
    await share("participants", [READER]);
    await sync(SITE_HOST, SITE);
    const opened = await host(SITE_HOST).openForViewer({
      userId: READER,
      displayName: "Reader",
      appSessionId: "reader-history",
    });
    const viewer = await host(SITE_HOST).redeemCode(opened.code);
    const ctx = createExecutionContext();
    const response = await artifactWorker.fetch(
      new Request(
        "https://quiet-blue-river-garden-g.rallyusercontent.com/__rally/v2/",
        {
          headers: {
            cookie: `__rally_artifact_session=${viewer!.session}`,
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        },
      ),
      {
        APP_ENV: "test",
        BROWSER_APP_ORIGIN: "https://app.example.test",
        AVALON_REGION: "global",
        ARTIFACT_SERVING_DOMAIN: "rallyusercontent.com",
        ARTIFACT_HOSTS: env.ARTIFACT_HOSTS,
        ARTIFACT_SIDEKICKS: ctx.exports.ArtifactSidekickDispatcher({ props: {} }),
        PLATFORM_DB: env.PLATFORM_DB,
        PAYLOADS: env.PAYLOADS,
      },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    await response.text();
  });

  it("refuses an ownerless site before recording resource state", async () => {
    const recordResource = vi.fn(async () => true);
    await expect(
      publishSiteVersion(env, env.DB, {
        workspaceId,
        workstreamId: crypto.randomUUID(),
        resourceId: crypto.randomUUID(),
        previous: null,
        claimant: "ownerless",
        mode: "static",
        stateful: false,
        files: [],
        fallbackTitle: "Site",
        serverModuleSha256: null,
        recordResource,
      }),
    ).rejects.toMatchObject({ code: "canvas_artifact_policy_missing" });
    expect(recordResource).not.toHaveBeenCalled();
  });

  it("does not propagate negative membership cache entries or resource timestamp touches", async () => {
    const before = (await snapshot()).revision;
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO workspace_member_status(user_id,relationship_json,removed_incarnation,active,sequence,updated_at) VALUES(?,NULL,NULL,0,0,0)",
        crypto.randomUUID(),
      );
      state.storage.sql.exec(
        "UPDATE resources SET updated_at='2026-11-12T00:00:00Z' WHERE id=?",
        FILE,
      );
    });
    expect((await snapshot()).revision).toBe(before);
  });

  it("rejects duplicate, stale and wrong-owner projections and retains archive tombstones", async () => {
    await share("public");
    const publicAccess = await snapshot();
    await host(SITE_HOST).applyAccessSnapshot(publicAccess);
    await share("editors");
    const privateAccess = await snapshot();
    await host(SITE_HOST).applyAccessSnapshot(privateAccess);
    expect(await host(SITE_HOST).applyAccessSnapshot(publicAccess)).toEqual({
      applied: false,
    });
    expect(await host(SITE_HOST).applyAccessSnapshot(privateAccess)).toEqual({
      applied: false,
    });
    expect((await visit("quiet-blue-river-garden")).status).toBe(401);
    await runInDurableObject(host(SITE_HOST), async (instance) => {
      await expect(
        instance.applyAccessSnapshot({
          ...privateAccess,
          canvasId: crypto.randomUUID(),
          revision: privateAccess.revision + 1,
        }),
      ).rejects.toThrow("owner_mismatch");
    });
    await workspace().canvasArchive({
      workspaceId,
      canvasId: CANVAS,
      actor: { userId: OWNER, actorRole: "member" },
    });
    await host(SITE_HOST).applyAccessSnapshot(await snapshot());
    expect((await visit("quiet-blue-river-garden")).status).toBe(404);
    expect(
      await host(SITE_HOST).applyAccessSnapshot({
        ...publicAccess,
        revision: privateAccess.revision + 100,
      }),
    ).toEqual({ applied: false });
  });

  it("initializes current policy before publishing new site bytes", async () => {
    await share("public");
    await sync(SITE_HOST, SITE);
    await share("editors");
    expect((await visit("quiet-blue-river-garden")).status).toBe(200);
    const current = await host(SITE_HOST).currentState();
    await pointArtifactAtVersion(env, {
      artifactId: SITE_HOST,
      workspaceId,
      workstreamId: CANVAS,
      resourceId: SITE,
      region: "global",
      manifest: { ...current!.manifest, artifactVersion: 2 },
    });
    expect((await visit("quiet-blue-river-garden")).status).toBe(401);
    expect((await host(SITE_HOST).currentState())?.version).toBe(2);
    // The older archive fan-out is also a permanent local serving fence.
    await host(SITE_HOST).archiveCanvas({ workspaceId, canvasId: CANVAS });
    await share("public");
    await sync(SITE_HOST, SITE);
    expect((await visit("quiet-blue-river-garden")).status).toBe(404);
  });

  it("fences file bytes to the policy revision captured with their references", async () => {
    await share("public");
    await sync(FILE);
    const oldAccess = await snapshot();
    await share("editors");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE resources SET content_ref='new-private-file',updated_at='2026-11-11T13:00:00.000Z' WHERE id=?",
        FILE,
      );
    });
    const delivery = await workspace().canvasArtifactAccessDelivery({
      workspaceId,
      canvasId: CANVAS,
      resourceId: FILE,
    });
    expect(delivery?.file?.versions.at(-1)?.contentRef).toBe(
      "new-private-file",
    );
    await host(FILE).applyAccessSnapshot(delivery!.snapshot);
    await host(FILE).recordFilePublication({
      workspaceId,
      canvasId: CANVAS,
      revision: oldAccess.revision,
      file: delivery!.file!,
    });
    const { code } = await host(FILE).openForViewer({
      userId: OWNER,
      displayName: "Owner",
      appSessionId: "owner-session",
    });
    const viewer = await host(FILE).redeemCode(code);
    const stale = await host(FILE).admitRequest({ session: viewer!.session });
    expect(
      stale.allowed &&
        stale.kind === "file" &&
        stale.file.versions.at(-1)?.contentRef,
    ).toBe("test-file");
    await host(FILE).recordFilePublication({
      workspaceId,
      canvasId: CANVAS,
      revision: delivery!.snapshot.revision,
      file: delivery!.file!,
    });
    const fresh = await host(FILE).admitRequest({ session: viewer!.session });
    expect(
      fresh.allowed &&
        fresh.kind === "file" &&
        fresh.file.versions.at(-1)?.contentRef,
    ).toBe("new-private-file");
    expect((await host(FILE).admitRequest({ session: null })).allowed).toBe(
      false,
    );
  });

  it("retains transactional retry intent and publishes it through the existing Queue", async () => {
    const pending = await runInDurableObject(workspace(), async (_instance, state) => {
      const n = state.storage.transactionSync(() => {
        state.storage.sql.exec(
          "UPDATE canvas_directory SET artifact_visibility='workspace' WHERE canvas_id=?",
          CANVAS,
        );
        return state.storage.sql
          .exec<{
            n: number;
          }>("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind='canvas_artifact_access'")
          .one().n;
      });
      // Production writers arm the alarm through `afterHostedWrite`; raw SQL here does not, so arm it.
      await state.storage.setAlarm(Date.now());
      return n;
    });
    expect(pending).toBe(1);
    await expect
      .poll(
        () =>
          runInDurableObject(
            workspace(),
            (_instance, state) =>
              state.storage.sql
                .exec<{
                  n: number;
                }>("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind='canvas_artifact_access'")
                .one().n,
          ),
        { timeout: waitBudget() },
      )
      .toBe(0);
    const probe = env.QUEUE_PROBE_TEST;
    if (!probe) throw new Error("queue_probe_missing");
    const root = await vi.waitFor(
      async () => {
        const roots = (await probe.received()).flatMap((body) => {
          const result = ArtifactAccessMessageSchema.safeParse(body);
          return result.success &&
            result.data.kind === "canvas_artifact_access_changed" &&
            result.data.workspaceId === workspaceId
            ? [result.data]
            : [];
        });
        expect(roots.length).toBeGreaterThan(0);
        return roots.at(-1)!;
      },
      { timeout: waitBudget() },
    );
    await consume([root]);
    const children = await vi.waitFor(
      async () => {
        const children = (await probe.received()).flatMap((body) => {
          const result = ArtifactAccessMessageSchema.safeParse(body);
          return result.success &&
            result.data.kind === "artifact_access_sync" &&
            result.data.workspaceId === workspaceId
            ? [result.data]
            : [];
        });
        expect(new Set(children.map((child) => child.artifactId))).toEqual(
          new Set([FILE, SITE_HOST]),
        );
        return children;
      },
      { timeout: waitBudget() },
    );
    await consume(children);
    expect(
      (await host(SITE_HOST).admitRequest({ session: null })).allowed,
    ).toBe(false);
  });

  it("propagates membership and role changes and fences concurrent sharing saves", async () => {
    const initial = await share("workspace");
    await sync(SITE_HOST, SITE);
    expect(
      (await snapshot()).users.some((person) => person.userId === READER),
    ).toBe(true);
    await workspace().applyMemberStatus({
      workspaceId,
      sequence: 1,
      removed: true,
      relationship: {
        workspaceId,
        userId: READER,
        incarnation: "reader-incarnation",
        revision: 2,
        accessClass: "member",
        role: "member",
        status: "active",
      },
    });
    expect(
      (await snapshot()).users.some((person) => person.userId === READER),
    ).toBe(false);
    await runInDurableObject(workspace(), async (instance) => {
      await expect(
        instance.canvasSetAudience({
          workspaceId,
          canvasId: CANVAS,
          actor: { userId: OWNER, actorRole: "member" },
          update: {
            visibility: "creator",
            userIds: [],
            artifactVisibility: "public",
            expectedRevision: (initial.sharingRevision ?? 0) - 1,
          },
        }),
      ).rejects.toThrow("Sharing changed");
    });
  });

  it("serves after propagation without product D1 tables or Canvas authority reads", async () => {
    await share("public");
    await sync(SITE_HOST, SITE);
    await env.DB.prepare("DROP TABLE workspace_members").run();
    expect((await visit("quiet-blue-river-garden")).status).toBe(200);
  });
});
