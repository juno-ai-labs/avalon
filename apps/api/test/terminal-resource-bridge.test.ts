import { artifactAssetKey, asUserId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
import { reapDeletedResourceObjects } from "../src/services/resource-object-cleanup";
import type { WorkstreamRuntimeResourceAttacher } from "../src/services/workstream-object-client";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestDurableObjectId,
  createTestD1PreparedStatement,
  createTestEnv,
} from "./helpers/cloudflare-test";
import {
  executeWorkstreamObjectSql,
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  testTerminalPortFactory,
  seedToolReceipt,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { applyWorkspaceResourceSchema } from "./helpers/workspace-object-tables";
import { workspaceResourceMaintenanceBinding } from "./helpers/workspace-object-rpcs";
import { sha256Hex } from "../src/lib/crypto";
import { RESOURCE_SLUG_PATTERN } from "../src/services/resource-slug";

const W = "10000000-0000-4000-8000-000000000001";
const S = "10000000-0000-4000-8000-000000000002";
const R = "10000000-0000-4000-8000-000000000003";
const U = asUserId("10000000-0000-4000-8000-000000000004");
const I = "10000000-0000-4000-8000-000000000005";
// A second run's receipt. A republish is a different call with a different
// intent, which is exactly what the per-call identity could not recognize.
const I2 = "10000000-0000-4000-8000-000000000007";
const RESOURCE = "10000000-0000-4000-8000-000000000006";
const ARTIFACT = "10000000-0000-4000-8000-000000000008";

const context: HarnessToolContext = {
  workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "resource-call",
  // The receipt still gates the publish; it is no longer the resource's
  // identity, which is now the work stream plus the published path.
  effectIntentId: I,
  executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
};

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture(
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
  workspaceDatabase: (database: ReturnType<typeof preRetirementProductSqliteDatabase>) => D1Database = sqliteD1,
) {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  // Publishing attaches resources through the object's RPC surface, which
  // only exists once the durable-object authority is open.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'resource-user', 'resource@example.com', 'Resource', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Resource', 'terminal-resource', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Resource', 'Resource', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
  `);
  // The publish path's whole point is that a revision keeps its predecessor,
  // and capture lives in WorkspaceDO's triggers — so the fixture takes them
  // from the ledger rather than publishing into a table that has no history.
  applyWorkspaceResourceSchema(database, W);
  const platformDatabase = new DatabaseSync(":memory:");
  openDatabases.push(platformDatabase);
  platformDatabase.exec(readFileSync(fileURLToPath(new URL(
    "../../../packages/db/platform-migrations/0001_artifact_hostname_routes.sql",
    import.meta.url,
  )), "utf8"));
  platformDatabase.exec(readFileSync(fileURLToPath(new URL(
    "../../../packages/db/platform-migrations/0002_minimize_artifact_hostname_routes.sql",
    import.meta.url,
  )), "utf8"));
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  seedWorkstreamRun(objectStore, { id: R,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
  executeWorkstreamObjectSql(objectStore, [
    {
      sql: `INSERT INTO terminal_workspace
              (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
               authority_fingerprint, applied_network_revision, version, last_command_at,
               created_at, updated_at)
            VALUES (1, 'daytona', 'running', 'resource-sandbox', 'sandbox', 1,
                    'authority', 1, 1, ?, ?, ?)`,
      params: [
        Date.parse("2026-08-13T00:00:00.000Z"),
        Date.parse("2026-08-13T00:00:00.000Z"),
        Date.parse("2026-08-13T00:00:00.000Z"),
      ],
    },
  ]);
  // Terminal reads the receipt id off the tool context, but publication still
  // records its effect against this row.
  seedToolReceipt(objectStore, {
    id: I, runId: R, toolCallId: "resource-call", toolName: "publish_resource",
  });
  seedToolReceipt(objectStore, {
    id: I2, runId: R, toolCallId: "resource-recall", toolName: "publish_resource",
    position: 1,
  });
  const objects = new Map<string, Uint8Array>();
  let afterPut: (() => Promise<void>) | undefined;
  const put = vi.fn(async (key: string, value: Uint8Array | string) => {
    objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    await afterPut?.();
  });
  const bucket = createCloudflareTestBinding<R2Bucket>({
    put,
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  });
  const recordPublish = vi.fn(async () => undefined);
  const baseEnv = createTestEnv({
    DB: workspaceDatabase(database), PLATFORM_DB: sqliteD1(platformDatabase),
    PAYLOADS: bucket, AVALON_REGION: "global", APP_ENV: "test",
    MAX_ATTACHMENT_BYTES: "25000000",
    // The reaper's decisions are typed WorkspaceDO methods now. They run the
    // object's own storage functions over this fixture's database, because a
    // second real object could not see the rows the bridge writes here.
    WORKSPACE_DOS: workspaceResourceMaintenanceBinding(database),
    ARTIFACT_HOSTS: createCloudflareTestBinding<Env["ARTIFACT_HOSTS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => ({ recordPublish }),
    }),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore, {
      extra: {
        attachRuntimeResource: vi.fn((request: {
          resourceId: string;
          attachedByUserId: string | null;
          relationshipType?: string;
        }) => {
          objectStore.prepare(
            `INSERT OR IGNORE INTO workstream_resource_links
               (resource_id, attached_by_user_id, watch_enabled, relationship_type,
                resource_json, attached_at, updated_at)
             VALUES (?, ?, 0, ?, ?, ?, ?)`,
          ).run(
            request.resourceId,
            request.attachedByUserId,
            request.relationshipType ?? "generated",
            JSON.stringify({ id: request.resourceId }),
            Date.parse("2026-08-13T12:00:00.000Z"),
            Date.parse("2026-08-13T12:00:00.000Z"),
          );
          return { status: 200, bodyJson: JSON.stringify({ ok: true }) };
        }),
      },
    }),
  });
  const env = baseEnv;
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(), recoverSandbox: vi.fn(async () => undefined),
    startSandbox: vi.fn(), stopSandbox: vi.fn(), archiveSandbox: vi.fn(), deleteSandbox: vi.fn(), updateNetworkPolicy: vi.fn(),
    configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(),
    readFile: vi.fn(), writeFile: vi.fn(async () => undefined),
    runUtilityCommand: vi.fn(),
    runCommand: vi.fn(async (_id, input) => {
      if (input.taskName.startsWith("avalon-import-check")) return { exitCode: 44, stdout: "", stderr: "" };
      if (input.taskName.startsWith("avalon-import-verify")) return { exitCode: 0, stdout: "14 8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169\n", stderr: "" };
      return { exitCode: input.command.startsWith("mkdir") ? 0 : 1, stdout: "", stderr: "" };
    }),
  };
  const utilityImplementation = vi.mocked(provider.runCommand).getMockImplementation()!;
  provider.runUtilityCommand = vi.fn((id, input) => utilityImplementation(id, {
    ...input,
    taskName: input.operation === "resource.import.inspect"
      ? "avalon-import-check"
      : input.operation === "resource.import.finalize"
        ? "avalon-import-verify"
        : "terminal-utility",
  }));
  return {
    database,
    objectStore,
    objects,
    put,
    recordPublish,
    setAfterPut(callback: () => Promise<void>) { afterPut = callback; },
    env,
    provider,
    bridge: createTerminalResourceBridge(
      env,
      testTerminalPortFactory(objectStore),
      inObjectResourceAttacher,
      null,
      null,
      U,
    ),
    /** A bridge whose publications land in `publicationWorkstreamId`. */
    bridgeFor: (publicationWorkstreamId: string | null) => createTerminalResourceBridge(
      env,
      testTerminalPortFactory(objectStore),
      inObjectResourceAttacher,
      publicationWorkstreamId ? async () => ({ parentId: publicationWorkstreamId, substreamId: "0" }) : null,
    ),
  };
}

describe("Terminal resource bridge", () => {
  /**
   * A published static site, as the bucket holds it: the manifest the resource
   * row points at, and one version-immutable object per asset.
   */
  function publishedSite(state: ReturnType<typeof fixture>, files: Array<[string, string]>) {
    const assets = files.map(([path, body]) => ({
      path,
      contentType: path.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8",
      sizeBytes: new TextEncoder().encode(body).byteLength,
      sha256: "b".repeat(64),
    }));
    for (const [path, body] of files) {
      state.objects.set(artifactAssetKey(ARTIFACT, 3, path), new TextEncoder().encode(body));
    }
    const contentDigest = sha256Hex(new TextEncoder().encode(JSON.stringify(
      assets.map((asset) => [asset.path, asset.sha256]),
    )));
    const manifest = new TextEncoder().encode(JSON.stringify({
      version: 1,
      artifactId: ARTIFACT,
      artifactVersion: 3,
      mode: "static",
      stateful: false,
      serverModuleSha256: null,
      assets,
      totalBytes: assets.reduce((total, asset) => total + asset.sizeBytes, 0),
      publishedAt: "2026-08-13T00:00:00.000Z",
    }));
    state.objects.set("site-manifest", manifest);
    return contentDigest;
  }

  function attachSiteResource(state: ReturnType<typeof fixture>, manifestDigest: string) {
    state.database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
          content_ref, content_sha256, metadata_json, attachment_status, model_content_status,
          created_at, updated_at)
       VALUES (?, ?, 'generated_site', 'avalon_generated', ?, 'Wedding site',
               'application/vnd.rally.site-manifest+json', 'site-manifest', ?,
               '{"sourcePath":"wedding-site"}', 'attached', 'unsupported',
               '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, `terminal:${S}:wedding-site`, manifestDigest);
    state.objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
       VALUES (?, ?, 0, 'generated', ?, ?, ?)`,
    ).run(RESOURCE, U, JSON.stringify({ id: RESOURCE }), Date.parse("2026-08-13"), Date.parse("2026-08-13"));
  }

  it("does not treat a publication target as a resource access grant", async () => {
    const state = fixture();
    const room = "10000000-0000-4000-8000-000000000099";
    attachSiteResource(state, await publishedSite(state, [["index.html", "<h1>Private</h1>"]]));
    state.objectStore.prepare("DELETE FROM workstream_resource_links WHERE resource_id = ?").run(RESOURCE);
    await expect(state.bridgeFor(room).importResource(context,
      { resourceId: RESOURCE, destinationPath: ".rally-output/wedding-site" },
      ".rally-output/wedding-site", 1, "sandbox", state.provider))
      .rejects.toMatchObject({ code: "resource_not_found" });
    expect(state.provider.writeFile).not.toHaveBeenCalled();
  });

  it("materializes a published site's own source so a run can revise what is served", async () => {
    const state = fixture();
    const contentDigest = await publishedSite(state, [
      ["index.html", "<h1>Wedding</h1>"],
      ["assets/app.css", "h1{color:red}"],
    ]);
    attachSiteResource(state, contentDigest);
    vi.mocked(state.provider.runUtilityCommand).mockImplementation(async (_id, input) => (
      input.operation === "resource.import.finalize"
        ? { exitCode: 0, stdout: "2\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" }
    ));

    await expect(state.bridge.importResource(
      context,
      { resourceId: RESOURCE, destinationPath: ".rally-output/wedding-site", overwrite: true },
      ".rally-output/wedding-site",
      1,
      "sandbox",
      state.provider,
    )).resolves.toMatchObject({
      resourceId: RESOURCE,
      filePath: ".rally-output/wedding-site",
      outcome: "created",
      fileCount: 2,
      sizeBytes: 29,
      sourceSha256: contentDigest,
    });

    // Both files, under the staging tree rather than over the destination.
    expect(state.provider.writeFile).toHaveBeenCalledWith(
      "sandbox",
      expect.stringMatching(/^\/workspace\/\.rally\/tmp\/[^/]+\/index\.html$/u),
      new TextEncoder().encode("<h1>Wedding</h1>"),
      context.signal,
    );
    expect(state.provider.writeFile).toHaveBeenCalledWith(
      "sandbox",
      expect.stringMatching(/^\/workspace\/\.rally\/tmp\/[^/]+\/assets\/app\.css$/u),
      new TextEncoder().encode("h1{color:red}"),
      context.signal,
    );
    // A nested asset needs its staging parent before the upload lands.
    expect(state.provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      operation: "resource.import.stage",
      command: expect.stringContaining("'assets'"),
    }));
    expect(workstreamObjectGet(
      state.objectStore,
      `SELECT destination_path, source_sha256, state, imported_at IS NOT NULL AS imported
         FROM terminal_imported_resources`,
    )).toEqual({
      destination_path: ".rally-output/wedding-site",
      source_sha256: contentDigest,
      state: "completed",
      imported: 1,
    });
  });

  it("leaves no durable import behind when it refuses an occupied destination", async () => {
    const state = fixture();
    attachSiteResource(state, await publishedSite(state, [["index.html", "<h1>Wedding</h1>"]]));
    // The destination is the site's own publish path, which is exactly what
    // already exists whenever this sandbox published it — so this refusal is
    // the likely first retry, not an edge case.
    vi.mocked(state.provider.runUtilityCommand).mockImplementation(async (_id, input) => (
      input.operation === "resource.import.stage"
        ? { exitCode: 0, stdout: "exists\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" }
    ));

    await expect(state.bridge.importResource(
      context,
      { resourceId: RESOURCE, destinationPath: ".rally-output/wedding-site" },
      ".rally-output/wedding-site",
      1,
      "sandbox",
      state.provider,
    )).rejects.toMatchObject({ code: "destination_exists" });

    // A planned row is read by the next acquisition as a revoked import, which
    // replaces the sandbox and discards the work stream's files. A call that
    // changed nothing must not cost that.
    expect(workstreamObjectGet(
      state.objectStore,
      "SELECT COUNT(*) AS rows FROM terminal_imported_resources",
    )).toEqual({ rows: 0 });
    expect(state.provider.writeFile).not.toHaveBeenCalled();
  });

  it("sends an automatic site import to the path that republishes the same site", async () => {
    const state = fixture();
    attachSiteResource(state, await publishedSite(state, [["index.html", "<h1>Wedding</h1>"]]));

    await expect(state.bridge.importResource(
      context,
      { resourceId: RESOURCE },
      `.rally/resources/${RESOURCE}/resource`,
      1,
      "sandbox",
      state.provider,
    )).rejects.toMatchObject({
      code: "destination_required",
      details: { reason: 'Retry with destinationPath: ".rally-output/wedding-site".' },
    });
    expect(state.provider.writeFile).not.toHaveBeenCalled();
  });

  it("upgrades an unchanged legacy site on its next publish", async () => {
    const attachResource = vi.fn(async () => undefined);
    const state = fixture(attachResource);
    const fileSha256 = "b".repeat(64);
    const contentDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify([
      ["index.html", fileSha256],
    ])));
    state.objects.set("old-manifest", new TextEncoder().encode(JSON.stringify({
      version: 1,
      artifactId: ARTIFACT,
      artifactVersion: 1,
      mode: "static",
      stateful: false,
      serverModuleSha256: null,
      assets: [{
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        sizeBytes: 12,
        sha256: fileSha256,
      }],
      totalBytes: 12,
      publishedAt: "2026-08-13T00:00:00.000Z",
    })));
    state.database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
          content_ref, content_sha256, metadata_json, attachment_status, model_content_status,
          created_at, updated_at)
       VALUES (?, ?, 'generated_site', 'avalon_generated', ?, 'Site',
               'application/vnd.rally.site-manifest+json', 'old-manifest', ?, '{}',
               'attached', 'unsupported', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, `terminal:${S}:site`, contentDigest);
    state.database.prepare(
      `INSERT INTO artifact_registry
         (artifact_id, workspace_id, workstream_id, resource_id, mode, stateful,
          current_version, manifest_ref, hostname_stub, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'static', 0, 1, 'old-manifest',
               'level-luminous-sequential-schrodinger', 1, 1)`,
    ).run(ARTIFACT, W, S, RESOURCE);

    const output = await state.bridge.publishSiteResource(context, { filePath: "site" }, {
      mode: "static",
      stateful: false,
      files: [{
        path: "index.html",
        bytes: new TextEncoder().encode("<h1>new</h1>"),
        sha256: fileSha256,
      }],
      serverModuleSha256: null,
    });

    expect(output.version).toBe(2);
    expect(state.recordPublish).toHaveBeenCalledWith(expect.objectContaining({
      manifest: expect.objectContaining({ socialPreview: expect.any(Object) }),
    }));
    expect(attachResource).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: W,
      workstreamId: S,
      resourceId: RESOURCE,
      eventType: "resource_updated",
    }));
    expect(state.recordPublish.mock.invocationCallOrder[0]).toBeLessThan(
      attachResource.mock.invocationCallOrder[0]!,
    );
    expect(state.database.prepare(
      "SELECT current_version FROM artifact_registry WHERE artifact_id = ?",
    ).get(ARTIFACT)).toEqual({ current_version: 2 });
  });

  it("reports a published site's alias, and the same one when it republishes", async () => {
    const state = fixture(vi.fn(async () => undefined));
    const site = (html: string, sha256: string) => ({
      mode: "static" as const,
      stateful: false,
      files: [{ path: "index.html", bytes: new TextEncoder().encode(html), sha256 }],
      serverModuleSha256: null,
    });

    const first = await state.bridge.publishSiteResource(
      context, { filePath: "site" }, site("<h1>one</h1>", "c".repeat(64)),
    );
    const stored = state.database.prepare("SELECT slug FROM resources WHERE id = ?")
      .get(first.resourceId) as { slug: string | null };
    expect(first.slug).toMatch(RESOURCE_SLUG_PATTERN);
    expect(first.slug).toBe(stored.slug);

    // A crash replay of the same call returns through the equal-content branch.
    const replay = await state.bridge.publishSiteResource(
      context, { filePath: "site" }, site("<h1>one</h1>", "c".repeat(64)),
    );
    expect(replay.resourceId).toBe(first.resourceId);
    expect(replay.slug).toBe(first.slug);

    // A later run with new content swaps the row's content and keeps its alias.
    const republished = await state.bridge.publishSiteResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "site" },
      site("<h1>two</h1>", "d".repeat(64)),
    );
    expect(republished.resourceId).toBe(first.resourceId);
    expect(republished.version).toBe(2);
    expect(republished.slug).toBe(first.slug);
  });

  it("reserves a site's hostname before a republish mutates its resource row", async () => {
    const state = fixture();
    const originalDigest = "a".repeat(64);
    state.database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
          content_ref, content_sha256, metadata_json, attachment_status, model_content_status,
          created_at, updated_at)
       VALUES (?, ?, 'generated_site', 'avalon_generated', ?, 'Site',
               'application/vnd.rally.site-manifest+json', 'old-manifest', ?, '{}',
               'attached', 'unsupported', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, `terminal:${S}:site`, originalDigest);
    state.database.prepare(
      `INSERT INTO artifact_registry
         (artifact_id, workspace_id, workstream_id, resource_id, mode, stateful,
          current_version, manifest_ref, hostname_stub, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'static', 0, 1, 'old-manifest', NULL, 1, 1)`,
    ).run(ARTIFACT, W, S, RESOURCE);
    state.env.PLATFORM_DB = createTestD1Database({
      prepare: () => { throw new Error("platform unavailable"); },
    });

    await expect(state.bridge.publishSiteResource(context, { filePath: "site" }, {
      mode: "static",
      stateful: false,
      files: [{
        path: "index.html",
        bytes: new TextEncoder().encode("<h1>new</h1>"),
        sha256: "b".repeat(64),
      }],
      serverModuleSha256: null,
    })).rejects.toThrow("platform unavailable");

    expect(state.database.prepare(
      "SELECT content_sha256 FROM resources WHERE id = ?",
    ).get(RESOURCE)).toEqual({ content_sha256: originalDigest });
    expect(state.database.prepare(
      "SELECT current_version, hostname_stub FROM artifact_registry WHERE artifact_id = ?",
    ).get(ARTIFACT)).toEqual({ current_version: 1, hostname_stub: null });
  });

  it("imports only a currently visible resource and verifies its stored hash", async () => {
    const { database, objectStore, objects, provider, bridge } = fixture();
    const bytes = new TextEncoder().encode("attached data\n");
    const digest = "8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169";
    objects.set("global/source", bytes);
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
        metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'Input data.csv', 'text/csv', 'global/source', ?, '{}', 'attached', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, digest);
    // The attachment membership lives in the object's link table; the compat
    // view over it is read-only, so the fixture writes the table itself.
    objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
       VALUES (?, ?, 0, 'attachment', ?, ?, ?)`,
    ).run(RESOURCE, U, JSON.stringify({ id: RESOURCE }), Date.parse("2026-08-13"), Date.parse("2026-08-13"));

    await expect(bridge.importResource(context, { resourceId: RESOURCE }, `.rally/resources/${RESOURCE}/resource`, 1, "sandbox", provider)).resolves.toEqual({
      resourceId: RESOURCE,
      filePath: `.rally/resources/${RESOURCE}/resource`,
      outcome: "created",
      mimeType: "text/csv",
      sizeBytes: 14,
      sourceSha256: digest,
    });
    expect(provider.writeFile).toHaveBeenCalledWith(
      "sandbox",
      expect.stringMatching(/^\/workspace\/\.rally\/tmp\//u),
      bytes,
      context.signal,
    );
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringMatching(new RegExp(`target='/workspace/\\.rally/resources/${RESOURCE}/resource'.*mv --`, "su")),
    }));
    expect(workstreamObjectGet(
      objectStore,
      `SELECT destination_path, source_sha256, size_bytes, state, imported_at IS NOT NULL AS imported
         FROM terminal_imported_resources`,
    )).toEqual({
      destination_path: `.rally/resources/${RESOURCE}/resource`,
      source_sha256: digest,
      size_bytes: 14,
      state: "completed",
      imported: 1,
    });
  });

  it("cleans an uploaded import temp file after a provider request failure", async () => {
    const { database, objectStore, objects, provider, bridge } = fixture();
    const bytes = new TextEncoder().encode("attached data\n");
    const digest = "8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169";
    objects.set("global/source", bytes);
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
        metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'Input data.csv', 'text/csv', 'global/source', ?, '{}', 'attached', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, digest);
    objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
       VALUES (?, ?, 0, 'attachment', ?, ?, ?)`,
    ).run(RESOURCE, U, JSON.stringify({ id: RESOURCE }), Date.parse("2026-08-13"), Date.parse("2026-08-13"));
    vi.mocked(provider.runUtilityCommand)
      .mockResolvedValueOnce({ exitCode: 44, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await expect(bridge.importResource(
      context,
      { resourceId: RESOURCE },
      `.rally/resources/${RESOURCE}/resource`,
      1,
      "sandbox",
      provider,
    )).rejects.toThrow("provider unavailable");
    expect(provider.runUtilityCommand).toHaveBeenLastCalledWith("sandbox", expect.objectContaining({
      operation: "file.temp_cleanup",
      command: expect.stringMatching(/^rm -f -- /u),
    }));
  });

  it("fails helpfully when a resource is detached before import", async () => {
    const { provider, bridge } = fixture();
    await expect(bridge.importResource(context, { resourceId: RESOURCE }, "input.txt", 1, "sandbox", provider)).rejects.toMatchObject({
      code: "resource_not_found",
      message: expect.stringContaining("list_resources"),
    });
  });

  it("refuses to write through a non-regular explicit destination", async () => {
    const { database, objectStore, objects, provider, bridge } = fixture();
    const bytes = new TextEncoder().encode("attached data\n");
    const digest = "8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169";
    objects.set("global/source", bytes);
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
        metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'Input data.csv', 'text/csv', 'global/source', ?, '{}', 'attached', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, digest);
    objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
       VALUES (?, ?, 0, 'attachment', ?, ?, ?)`,
    ).run(RESOURCE, U, JSON.stringify({ id: RESOURCE }), Date.parse("2026-08-13"), Date.parse("2026-08-13"));
    vi.mocked(provider.runUtilityCommand).mockImplementation(async (_id, input) => input.operation === "resource.import.inspect"
      ? { exitCode: 45, stdout: "", stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" });

    await expect(bridge.importResource(
      context,
      { resourceId: RESOURCE, destinationPath: "linked-input.csv", overwrite: true },
      "linked-input.csv",
      1,
      "sandbox",
      provider,
    )).rejects.toMatchObject({
      code: "destination_not_regular",
      message: expect.stringContaining("not a regular file"),
    });
    expect(provider.writeFile).not.toHaveBeenCalled();
  });

  describe("reconciling an interrupted publish", () => {
    /** The receipt's own window: everything below is positioned against it. */
    const startedAt = Date.parse("2026-08-14T00:00:00.000Z");
    const reconcileContext = { ...context, attemptStartedAt: startedAt };

    it("reports a publication this run made in the window as landed, and touches nothing", async () => {
      const { database, bridge, put } = fixture();
      await bridge.publishResource(context, { filePath: "report.md", displayName: "Analysis" }, new TextEncoder().encode("# Report\n"));
      const before = database.prepare(
        `SELECT content_sha256, updated_at FROM resources WHERE workspace_id = ? AND provider_resource_id = ?`,
      ).get(W, `terminal:${S}:report.md`);
      put.mockClear();

      await expect(bridge.reconcilePublishedResource(reconcileContext, { filePath: "report.md" }))
        .resolves.toMatchObject({ outcome: "landed", result: { output: { title: "Analysis" } } });

      // The point of asking rather than re-entering: nothing was written, so a
      // document that landed cannot be revised by the act of confirming it.
      expect(put).not.toHaveBeenCalled();
      expect(database.prepare(
        `SELECT content_sha256, updated_at FROM resources WHERE workspace_id = ? AND provider_resource_id = ?`,
      ).get(W, `terminal:${S}:report.md`)).toEqual(before);
    });

    it("reports nothing published at the path as not landed", async () => {
      const { bridge } = fixture();

      await expect(bridge.reconcilePublishedResource(reconcileContext, { filePath: "never-written.md" }))
        .resolves.toEqual({ outcome: "not_landed" });
    });

    it("reports a publication that predates the attempt as not landed", async () => {
      const { database, bridge } = fixture();
      await bridge.publishResource(context, { filePath: "report.md" }, new TextEncoder().encode("# Older\n"));
      // Same run, same path — only the window separates it from the case
      // above. Without the `captured_at` comparison an earlier publish by this
      // same run would be read as this attempt's own work.
      database.prepare(
        `UPDATE resource_versions SET captured_at = ? WHERE workspace_id = ?`,
      ).run("2026-08-13T23:59:59.000Z", W);

      await expect(bridge.reconcilePublishedResource(reconcileContext, { filePath: "report.md" }))
        .resolves.toEqual({ outcome: "not_landed" });
    });

    it("still reports landed when a later run has already revised the document away", async () => {
      const { database, bridge } = fixture();
      await bridge.publishResource(context, { filePath: "report.md", displayName: "Mine" }, new TextEncoder().encode("# Mine\n"));
      // Somebody else republishes the same path afterwards. The live row is
      // now theirs, and the `revision_author_*` columns on it are cleared by
      // the capture trigger, so nothing there can say this attempt happened.
      await bridge.publishResource(
        { ...context, harnessRunId: "20000000-0000-4000-8000-000000000009", effectIntentId: I2, toolCallId: "resource-recall" },
        { filePath: "report.md", displayName: "Theirs" },
        new TextEncoder().encode("# Theirs\n"),
      );
      expect(database.prepare(
        `SELECT title FROM resources WHERE workspace_id = ? AND provider_resource_id = ?`,
      ).get(W, `terminal:${S}:report.md`)).toEqual({ title: "Theirs" });

      // Landed, not unknown: this attempt did publish, so re-entering it would
      // be a second write that undid their revision. The ledger is what makes
      // the distinction available at all, and the result describes the version
      // this attempt wrote rather than the one standing there now.
      await expect(bridge.reconcilePublishedResource(reconcileContext, { filePath: "report.md" }))
        .resolves.toMatchObject({ outcome: "landed", result: { output: { title: "Mine" } } });
    });

    it("refuses to answer when another run revised the path inside the window", async () => {
      const { database, bridge } = fixture();
      await bridge.publishResource(context, { filePath: "report.md" }, new TextEncoder().encode("# Report\n"));
      database.prepare(
        `UPDATE resource_versions SET author_run_id = ?, captured_at = ? WHERE workspace_id = ?`,
      ).run("20000000-0000-4000-8000-000000000009", "2026-08-14T00:00:05.000Z", W);

      // This is the case re-entry must never guess at. The attempt may have
      // landed and been revised away since, so republishing would undo work
      // somebody else did in the window.
      await expect(bridge.reconcilePublishedResource(reconcileContext, { filePath: "report.md" }))
        .resolves.toEqual({ outcome: "unknown", reason: "publication_revised_by_another_run" });
    });
  });

  it("publishes a supported regular file as an attached resource with durable cleanup ownership", async () => {
    const { database, objectStore, objects, put, bridge } = fixture();
    const bytes = new TextEncoder().encode("# Report\n");
    const result = await bridge.publishResource(context, { filePath: "report.md", displayName: "Analysis" }, bytes);

    expect(result).toMatchObject({ title: "Analysis", provider: "avalon_generated", mimeType: "text/markdown", sizeBytes: 9 });
    const resourceId = String(result.resourceId);
    // The resource row is workspace authority (D1) and the attachment is
    // object authority; the cross-store join production no longer performs is
    // asserted as its two halves.
    const row = database.prepare(
      `SELECT provider, title, mime_type, content_ref, attachment_status
         FROM resources WHERE id = ? AND workspace_id = ?`,
    ).get(resourceId, W);
    expect(row).toMatchObject({ provider: "avalon_generated", title: "Analysis", mime_type: "text/markdown", attachment_status: "attached" });
    // The object's own table, in its own vocabulary: the compatibility view
    // that let a test read it as `workstream_resources` is retired.
    expect(objectStore.prepare(
      "SELECT relationship_type FROM workstream_resource_links WHERE resource_id = ?",
    ).get(resourceId)).toEqual({ relationship_type: "generated" });
    expect(objects.has(String((row as { content_ref: string }).content_ref))).toBe(true);
    expect(put).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get()).toEqual({ count: 0 });
  });

  it("keeps uploaded bytes when cleanup runs before the resource pointer commits", async () => {
    const state = fixture();
    let cleanupPasses = 0;
    state.setAfterPut(async () => {
      cleanupPasses += 1;
      // R2 has the bytes at this point, while publishResource has not yet
      // inserted the resource row. This is the production race that left the
      // press-release citation valid but its preview and download at 404.
      expect(await reapDeletedResourceObjects(state.env, W)).toBe(0);
    });

    const result = await state.bridge.publishResource(
      context,
      { filePath: "cleanup-race.md", displayName: "Cleanup race" },
      new TextEncoder().encode("# Still here\n"),
    );

    const row = state.database.prepare(
      "SELECT content_ref FROM resources WHERE id = ? AND workspace_id = ?",
    ).get(result.resourceId, W) as { content_ref: string };
    expect(cleanupPasses).toBe(1);
    expect(state.objects.has(row.content_ref)).toBe(true);
    expect(state.database.prepare(
      "SELECT COUNT(*) AS count FROM resource_object_deletion_outbox",
    ).get()).toEqual({ count: 0 });
  });

  it("keeps Terminal publication staged when the resource insert commits but its response is lost", async () => {
    let failed = false;
    const state = fixture(undefined, (database) => afterCommitFailureD1(
      sqliteD1(database),
      (sql) => {
        if (failed || !sql.includes("INSERT INTO resources")) return false;
        failed = true;
        return true;
      },
    ));

    await expect(state.bridge.publishResource(
      context,
      { filePath: "ambiguous.md", displayName: "Ambiguous" },
      new TextEncoder().encode("# Retained\n"),
    )).rejects.toMatchObject({ code: "resource_publish_failed" });

    const resource = state.database.prepare(
      "SELECT content_ref FROM resources WHERE provider_resource_id = ?",
    ).get(`terminal:${S}:ambiguous.md`) as { content_ref: string };
    expect(state.objects.has(resource.content_ref)).toBe(true);
    expect(state.database.prepare(
      `SELECT cleanup_eligible FROM resource_object_deletion_outbox
        WHERE object_ref = ?`,
    ).get(resource.content_ref)).toEqual({ cleanup_eligible: 0 });
    expect(state.objectStore.prepare(
      "SELECT COUNT(*) AS count FROM workstream_resource_links",
    ).get()).toEqual({ count: 0 });
  });

  it("uses the resident resource attacher instead of same-object RPC", async () => {
    const attachResource = vi.fn(async () => undefined);
    const { bridge } = fixture(attachResource);

    const result = await bridge.publishResource(
      context,
      { filePath: "resident-report.md" },
      new TextEncoder().encode("resident output\n"),
    );

    expect(attachResource).toHaveBeenCalledOnce();
    expect(attachResource).toHaveBeenCalledWith({
      workspaceId: W,
      workstreamId: S,
      resourceId: result.resourceId,
      attachedByUserId: U,
    });
  });

  it("refuses to publish when the harness supplied no receipt identity", async () => {
    const { database, put, bridge } = fixture();
    const unreceipted: HarnessToolContext = { ...context };
    delete unreceipted.effectIntentId;

    await expect(bridge.publishResource(unreceipted, { filePath: "report.md" }, new TextEncoder().encode("# Report\n")))
      .rejects.toMatchObject({ code: "tool_receipt_missing" });
    // `terminal:<effect intent>` is what a retry recognizes. Publishing under
    // any other identity would create a second copy on every attempt.
    expect(put).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 0 });
  });

  it("attributes a published document and its revisions to the run that wrote them", async () => {
    const { database, bridge } = fixture();
    const first = await bridge.publishResource(
      context,
      { filePath: "plan.md", displayName: "Plan" },
      new TextEncoder().encode("# Plan\n\nFirst draft.\n"),
    );
    await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "plan.md" },
      new TextEncoder().encode("# Plan\n\nRevised.\n"),
    );

    // The rail lists these rows as history a participant reads, so each one
    // says which run wrote it and whether it was the document's first state
    // or a revision that superseded one.
    expect(database.prepare(
      `SELECT version, author_kind, author_run_id, author_user_id, cause, storage_kind, on_behalf_of_user_id
         FROM resource_versions WHERE resource_id = ? ORDER BY version`,
    ).all(String(first.resourceId))).toEqual([
      { version: 1, author_kind: "agent", author_run_id: R, author_user_id: null,
        cause: "created", storage_kind: "object", on_behalf_of_user_id: null },
      // A revision also names the person whose run made it, so it is not news to them.
      { version: 2, author_kind: "agent", author_run_id: R, author_user_id: null,
        cause: "published", storage_kind: "object", on_behalf_of_user_id: U },
    ]);
  });

  it("refreshes the owning room's document instead of forking a private copy", async () => {
    // A work-stream-scoped Sidekick runs in its own conversation under the
    // automation, so its tool context names that conversation and not the room.
    const SIDEKICK = "10000000-0000-4000-8000-00000000000a";
    const state = fixture();
    const roomCopy = await state.bridge.publishResource(
      context,
      { filePath: "open-pr-dashboard.html", displayName: "Open PR dashboard" },
      new TextEncoder().encode("<h1>First</h1>"),
    );
    // The Sidekick that room owns refreshes the same path on its schedule.
    // Without the redirect its identity is `terminal:<sidekick>:<path>`, which
    // can never collide with the room's, so the refresh silently becomes a
    // second document at version 1 and the room's copy is never touched again.
    const refreshed = await state.bridgeFor(S).publishResource(
      { ...context, workstreamId: SIDEKICK, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "open-pr-dashboard.html" },
      new TextEncoder().encode("<h1>Second</h1>"),
    );

    expect(refreshed.resourceId).toBe(roomCopy.resourceId);
    expect(state.database.prepare("SELECT COUNT(*) AS count FROM resources").get())
      .toEqual({ count: 1 });
    const row = state.database.prepare(
      "SELECT provider_resource_id, current_version FROM resources WHERE id = ?",
    ).get(String(roomCopy.resourceId)) as {
      provider_resource_id: string;
      current_version: number;
    };
    expect(row.provider_resource_id).toBe(`terminal:${S}:open-pr-dashboard.html`);
    expect(row.current_version).toBe(2);
  });

  it("links a redirected publication to the producing run as well as the owning room", async () => {
    // Visibility is resolved from the links the run's own object holds, so a
    // document linked only to the room is one its own run cannot read back:
    // publish then import on the id just returned would answer
    // `resource_not_found`, and "publish a refresh, then diff it against the
    // last one" is the natural shape of the work these Sidekicks do.
    const SIDEKICK = "10000000-0000-4000-8000-00000000000b";
    const produced: string[] = [];
    const state = fixture(async (input) => { produced.push(input.workstreamId); });
    const published = await state.bridgeFor(S).publishResource(
      { ...context, workstreamId: SIDEKICK },
      { filePath: "open-pr-dashboard.html" },
      new TextEncoder().encode("<h1>Refreshed</h1>"),
    );

    // The room owns the identity...
    const row = state.database.prepare(
      "SELECT provider_resource_id FROM resources WHERE id = ?",
    ).get(String(published.resourceId)) as { provider_resource_id: string };
    expect(row.provider_resource_id).toBe(`terminal:${S}:open-pr-dashboard.html`);
    // ...and the producing conversation still holds a link, through the
    // in-object attacher, so the run can resolve what it just wrote.
    expect(produced).toEqual([SIDEKICK]);
  });

  it("keeps an internal capture in the run's own conversation when publication is redirected", async () => {
    // The command-log and checkout-backup captures name their own namespace
    // rather than deriving one from a path. They are recovery artifacts the run
    // never chose to deliver, so the redirect must not carry them into the
    // owning room's resource list along with the documents it did publish.
    const SIDEKICK = "10000000-0000-4000-8000-00000000000a";
    const attached: { workstreamId: string; resourceId: string }[] = [];
    const state = fixture(async (input) => {
      attached.push({ workstreamId: input.workstreamId, resourceId: input.resourceId });
    });
    const sidekickContext = { ...context, workstreamId: SIDEKICK };
    const capture = await state.bridgeFor(S).publishResource(
      sidekickContext,
      {
        providerResourceId: `terminal-command-log:${I}`,
        filePath: `.rally/logs/${I}.log`,
        displayName: "Terminal command log",
      },
      new TextEncoder().encode("secret stdout the delivered result left out\n"),
    );

    const row = state.database.prepare(
      "SELECT provider_resource_id FROM resources WHERE id = ?",
    ).get(String(capture.resourceId)) as { provider_resource_id: string };
    expect(row.provider_resource_id).toBe(`terminal-command-log:${I}`);
    // Linked to the Sidekick's own conversation. A redirected link would have
    // gone cross-object to the room and never reached this in-object attacher.
    expect(attached).toEqual([{ workstreamId: SIDEKICK, resourceId: String(capture.resourceId) }]);
  });

  it("republishes the same sandbox path onto the same resource instead of a sibling", async () => {
    const attachResource = vi.fn(async () => undefined);
    const { database, objects, put, bridge } = fixture(attachResource);
    const first = await bridge.publishResource(
      context,
      { filePath: "mute-windows-prd.md", displayName: "Mute windows PRD" },
      new TextEncoder().encode("# Mute windows\n\nFirst draft.\n"),
    );
    attachResource.mockClear();
    const revised = new TextEncoder().encode("# Mute windows\n\nTighter goals.\n");
    const second = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "mute-windows-prd.md" },
      revised,
    );

    expect(second.resourceId).toBe(first.resourceId);
    expect(attachResource).toHaveBeenCalledOnce();
    expect(attachResource).toHaveBeenCalledWith({
      workspaceId: W,
      workstreamId: S,
      resourceId: first.resourceId,
      attachedByUserId: U,
      eventType: "resource_updated",
    });
    // One entry in the rail, not one per draft: the rewrite is the same
    // document, so the row it lands on is the one the first publish created.
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 1 });
    const row = database.prepare(
      `SELECT provider_resource_id, title, content_ref, content_sha256, metadata_json, model_content_status
         FROM resources WHERE id = ?`,
    ).get(String(first.resourceId)) as {
      provider_resource_id: string;
      title: string;
      content_ref: string;
      content_sha256: string;
      metadata_json: string;
      model_content_status: string;
    };
    // The work stream is in the identity, so the same file name published from
    // another work stream is a different document.
    expect(row.provider_resource_id).toBe(`terminal:${S}:mute-windows-prd.md`);
    expect(objects.get(row.content_ref)).toEqual(revised);
    expect(row.content_sha256).toBe(second.sourceSha256);
    expect(row.content_sha256).not.toBe(first.sourceSha256);
    // A title is applied when the republish gives one and kept when it does not.
    expect(row.title).toBe("Mute windows PRD");
    expect(second.title).toBe("Mute windows PRD");
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      sourcePath: "mute-windows-prd.md",
      size: revised.byteLength,
    });
    expect(second.derivativeStatus).toBe("pending");
    expect(put).toHaveBeenCalledTimes(2);
    // A won compare-and-swap cancels the deletion this call pre-registered for
    // the bytes it wrote. It says nothing about the superseded object: in
    // production `resources_track_original_after_update` enqueues that one and
    // `resource_versions` keeps it alive, and this fixture carries neither
    // trigger — so asserting a total of zero here would pin a state only the
    // fixture reaches.
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM resource_object_deletion_outbox WHERE object_ref = ?",
    ).get(row.content_ref)).toEqual({ count: 0 });
  });

  it("applies a new title to a republished document and keeps the old one otherwise", async () => {
    const { database, bridge } = fixture();
    const first = await bridge.publishResource(
      context,
      { filePath: "brief.md", displayName: "Launch brief" },
      new TextEncoder().encode("# Brief\n"),
    );
    const renamed = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "brief.md", displayName: "Launch brief v2" },
      new TextEncoder().encode("# Brief\n\nMore.\n"),
    );

    expect(renamed.resourceId).toBe(first.resourceId);
    expect(renamed.title).toBe("Launch brief v2");
    expect(database.prepare("SELECT title FROM resources WHERE id = ?").get(String(first.resourceId)))
      .toEqual({ title: "Launch brief v2" });
  });

  it("keeps a person's rename when a republish repeats the agent's old name, and takes a new one", async () => {
    const I3 = "10000000-0000-4000-8000-000000000009";
    const { database, bridge } = fixture();
    const first = await bridge.publishResource(
      context,
      { filePath: "brief.md", displayName: "Launch brief" },
      new TextEncoder().encode("# Brief\n"),
    );
    database.prepare(`UPDATE resources SET title = 'Launch brief (final)', revision_author_kind = 'member',
      revision_author_user_id = ?, revision_cause = 'renamed' WHERE id = ?`).run(U, String(first.resourceId));

    const repeated = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "brief.md", displayName: "Launch brief" },
      new TextEncoder().encode("# Brief\n\nMore.\n"),
    );
    expect(repeated.title).toBe("Launch brief (final)");

    const named = await bridge.publishResource(
      { ...context, effectIntentId: I3, toolCallId: "resource-rename" },
      { filePath: "brief.md", displayName: "Launch plan" },
      new TextEncoder().encode("# Plan\n"),
    );
    expect(named.title).toBe("Launch plan");
  });

  it("returns the published document unchanged when the same path republishes identical bytes", async () => {
    const { database, put, bridge } = fixture();
    const bytes = new TextEncoder().encode("# Unchanged\n");
    const first = await bridge.publishResource(context, { filePath: "notes.md" }, bytes);
    const again = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "notes.md" },
      bytes,
    );

    // One branch covers a crash-replay of a settled call and a no-change
    // republish: equal content on the same path writes nothing.
    expect(again).toEqual(first);
    expect(put).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 1 });
  });

  it("replays the realtime event when a settled publication attempt is retried", async () => {
    const attachResource = vi.fn(async () => undefined);
    const { bridge } = fixture(attachResource);
    const first = new TextEncoder().encode("# First\n");
    await bridge.publishResource(context, { filePath: "replay.md" }, first);
    attachResource.mockClear();

    await bridge.publishResource(context, { filePath: "replay.md" }, first);
    expect(attachResource).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "resource_attached",
    }));

    const revisionContext = { ...context, effectIntentId: I2, toolCallId: "resource-recall" };
    const second = new TextEncoder().encode("# Second\n");
    await bridge.publishResource(revisionContext, { filePath: "replay.md" }, second);
    attachResource.mockClear();

    await bridge.publishResource(revisionContext, { filePath: "replay.md" }, second);
    expect(attachResource).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "resource_updated",
    }));
  });

  it("keeps distinct sandbox paths as distinct documents", async () => {
    const { database, bridge } = fixture();
    const prd = await bridge.publishResource(context, { filePath: "prd.md" }, new TextEncoder().encode("# PRD\n"));
    const release = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "press-release.md" },
      new TextEncoder().encode("# Release\n"),
    );

    expect(release.resourceId).not.toBe(prd.resourceId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 2 });
  });

  it("returns the settled resource when a publish recorded under the per-call identity replays", async () => {
    const { database, objects, put, bridge } = fixture();
    // A publication that settled before path-scoped identity shipped. Its
    // attempt replaying must find that row, not publish the file a second time.
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
        content_ref, content_sha256, metadata_json, attachment_status, model_content_status,
        created_at, updated_at)
       VALUES (?, ?, 'generated_file', 'avalon_generated', ?, 'Legacy report', 'text/markdown',
               'global/legacy', ?, ?, 'attached', 'ready', '2026-08-13', '2026-08-13')`,
    ).run(
      RESOURCE,
      W,
      `terminal:${I}`,
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d208286a2e6f937dc8",
      JSON.stringify({ sourcePath: "report.md", size: 5, attachmentKind: "document", contentMode: "read" }),
    );
    objects.set("global/legacy", new TextEncoder().encode("hello"));

    const replayed = await bridge.publishResource(
      context,
      { filePath: "report.md" },
      new TextEncoder().encode("# Report\n"),
    );

    expect(replayed.resourceId).toBe(RESOURCE);
    expect(put).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 1 });
  });

  it("reattaches a republished document that is no longer linked to the work stream", async () => {
    const { objectStore, bridge } = fixture();
    const first = await bridge.publishResource(
      context,
      { filePath: "plan.md" },
      new TextEncoder().encode("# Plan\n"),
    );
    objectStore.prepare("DELETE FROM workstream_resource_links WHERE resource_id = ?")
      .run(String(first.resourceId));

    const second = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "plan.md" },
      new TextEncoder().encode("# Plan\n\nRevised.\n"),
    );

    expect(second.resourceId).toBe(first.resourceId);
    expect(objectStore.prepare(
      "SELECT relationship_type FROM workstream_resource_links WHERE resource_id = ?",
    ).get(String(first.resourceId))).toEqual({ relationship_type: "generated" });
  });

  it("invalidates the derivative the superseded bytes produced", async () => {
    const { database, bridge } = fixture();
    const first = await bridge.publishResource(
      context,
      { filePath: "prd.md" },
      new TextEncoder().encode("# One\n"),
    );
    // The extractor has since run against the first draft, so the row is not
    // already in the state the swap is supposed to put it back into.
    database.prepare(
      `UPDATE resources
          SET model_content_status = 'ready', model_content_ref = 'global/derivative-1',
              model_content_sha256 = ?, model_content_character_count = 6,
              model_content_extractor_version = 'v3', model_content_extracted_at = '2026-08-27'
        WHERE id = ?`,
    ).run("a".repeat(64), String(first.resourceId));

    const second = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "prd.md" },
      new TextEncoder().encode("# Two\n"),
    );

    expect(database.prepare(
      `SELECT model_content_status, model_content_ref, model_content_sha256,
              model_content_character_count, model_content_extractor_version, model_content_extracted_at
         FROM resources WHERE id = ?`,
    ).get(String(first.resourceId))).toEqual({
      model_content_status: "pending",
      model_content_ref: null,
      model_content_sha256: null,
      model_content_character_count: null,
      model_content_extractor_version: null,
      model_content_extracted_at: null,
    });
    expect(second.derivativeStatus).toBe("pending");
  });

  it("keeps a description a republish does not restate, and replaces one it does", async () => {
    const { database, bridge } = fixture();
    const first = await bridge.publishResource(
      context,
      { filePath: "prd.md", description: "The mute-windows design." },
      new TextEncoder().encode("# One\n"),
    );
    const metadata = () => JSON.parse(String((database.prepare(
      "SELECT metadata_json FROM resources WHERE id = ?",
    ).get(String(first.resourceId)) as { metadata_json: string }).metadata_json)) as Record<string, unknown>;

    await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "prd.md" },
      new TextEncoder().encode("# Two\n"),
    );
    expect(metadata()).toMatchObject({ description: "The mute-windows design." });

    await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: "prd.md", description: "Rewritten after review." },
      new TextEncoder().encode("# Three\n"),
    );
    expect(metadata()).toMatchObject({ description: "Rewritten after review." });
  });

  it("bounds a published identity the model could otherwise push past the wire contract", async () => {
    const { database, bridge } = fixture();
    // Each component is well under NAME_MAX, so the sandbox writes this happily
    // and the publish succeeds — the overflow is only visible on the way out.
    const longPath = `${"a".repeat(230)}/${"b".repeat(230)}.md`;
    const published = await bridge.publishResource(
      context,
      { filePath: longPath },
      new TextEncoder().encode("# Long\n"),
    );

    const identity = String((database.prepare(
      "SELECT provider_resource_id FROM resources WHERE id = ?",
    ).get(String(published.resourceId)) as { provider_resource_id: string }).provider_resource_id);
    // Past the readable form's budget the path becomes a digest, so the stored
    // identity stays inside `ResourceSchema`'s 500-character bound. A row past
    // it stops the whole work stream opening and fails the workspace's resource
    // list, and nothing in the product can delete a published row to recover.
    expect(identity.length).toBeLessThanOrEqual(500);
    expect(identity).toMatch(new RegExp(`^terminal:${S}:sha256:[0-9a-f]{64}$`, "u"));
    // Still one document per path: republishing it lands on the same row.
    const again = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: longPath },
      new TextEncoder().encode("# Longer\n"),
    );
    expect(again.resourceId).toBe(published.resourceId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 1 });
  });

  it("keeps a caller-named identity out of the path space the model shares", async () => {
    const { database, bridge } = fixture();
    // A command-log capture Rally writes on the model's behalf. Its sandbox path
    // is one the model can also name, so deriving identity from that path would
    // let a run republish over its own audit record.
    const log = await bridge.publishResource(
      context,
      {
        providerResourceId: `terminal-command-log:${I}`,
        filePath: `.rally/logs/${I}.log`,
        displayName: `Terminal command log ${I}`,
      },
      new TextEncoder().encode("real output\n"),
    );
    const forged = await bridge.publishResource(
      { ...context, effectIntentId: I2, toolCallId: "resource-recall" },
      { filePath: `.rally/logs/${I}.log` },
      new TextEncoder().encode("fabricated output\n"),
    );

    expect(forged.resourceId).not.toBe(log.resourceId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 2 });
    expect(database.prepare(
      "SELECT provider_resource_id FROM resources WHERE id = ?",
    ).get(String(log.resourceId))).toEqual({ provider_resource_id: `terminal-command-log:${I}` });
  });

  it("publishes opaque binaries as download-only resources", async () => {
    const { bridge } = fixture();
    await expect(bridge.publishResource(context, { filePath: "program.bin" }, new Uint8Array([0, 255, 1])))
      .resolves.toMatchObject({ attachmentKind: "other", contentMode: "unsupported", derivativeStatus: "unsupported" });
  });
});

function afterCommitFailureD1(base: D1Database, shouldFail: (sql: string) => boolean): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    let bound = base.prepare(sql);
    const statement = {
      bind(...values: unknown[]) {
        bound = bound.bind(...values);
        return statement;
      },
      first<T>(column?: string) {
        return column === undefined ? bound.first<T>() : bound.first<T>(column);
      },
      all<T>() { return bound.all<T>(); },
      async run<T>() {
        const result = await bound.run<T>();
        if (shouldFail(sql)) throw new Error("workspace_response_lost");
        return result;
      },
    };
    return createTestD1PreparedStatement(statement);
  };
  return createTestD1Database({
    prepare,
    batch: base.batch.bind(base),
  });
}
