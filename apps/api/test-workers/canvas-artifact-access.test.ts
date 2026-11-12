import { searchAudienceGroupId } from "../src/services/search-audience";
import { ArtifactAccessMessageSchema } from "@rally/contracts/artifact-access";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import {
  reset,
  runInDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
  runDurableObjectAlarm,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asArtifactId,
  asUserId,
  asWorkspaceId,
  asAutomationId,
  type ArtifactManifest,
} from "@rally/contracts";
import { seedWorkstreamRoot } from "./helpers/substream-fixture";
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
import { AuthorizationService } from "../src/services/authorization-service";
import { ResourceService } from "../src/services/resource-service";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
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
    const pending = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          "UPDATE canvas_directory SET artifact_visibility='workspace' WHERE canvas_id=?",
          CANVAS,
        );
        return state.storage.sql
          .exec<{
            n: number;
          }>("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind='canvas_artifact_access'")
          .one().n;
      }),
    );
    expect(pending).toBe(1);
    await runDurableObjectAlarm(workspace());
    // Bootstrap itself can schedule one newer revision; a second alarm drains it.
    await runDurableObjectAlarm(workspace());
    const remaining = await runInDurableObject(
      workspace(),
      (_instance, state) =>
        state.storage.sql
          .exec<{
            n: number;
          }>("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind='canvas_artifact_access'")
          .one().n,
    );
    expect(remaining).toBe(0);
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
      { timeout: 10_000 },
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
      { timeout: 10_000 },
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
