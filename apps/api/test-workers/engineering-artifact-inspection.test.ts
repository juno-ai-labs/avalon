/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Which ArtifactHostDO the engineering MCP is allowed to open, against real
 * objects.
 *
 * This object's name carries no workspace segment, so nothing in the name
 * proves the caller may reach it and every UUID in the account is a valid one.
 * `artifact_registry` in WorkspaceDO is the only thing that says which
 * artifacts a workspace has, and these tests put the row there through
 * `registerArtifact` — the function the publish path calls — rather than
 * writing the table, alongside the supervisor's own `recordPublish`.
 *
 * The facet boundary is proved here too, because it is the assumption an
 * operator is most likely to bring: a stateful artifact keeps its tables in a
 * separate facet database, and this RPC sees the supervisor's.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactHostnameStubSchema,
  artifactAssetKey,
  asArtifactId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";

import type { ArtifactHostDO } from "../src/durable-objects/artifact-host-do";
import { artifactHostDOName, workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";
import { registerArtifact } from "../src/services/terminal/site-resource-bridge";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000fa10");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000fa11");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000fa12");
const RESOURCE_ID = "00000000-0000-7000-8000-00000000fa13";
const ARTIFACT_ID = asArtifactId("00000000-0000-7000-8000-00000000fa14");
const UNREGISTERED_ID = asArtifactId("00000000-0000-7000-8000-00000000fa15");
const SESSION_ID = "00000000-0000-7000-8000-00000000fa16";
const HOSTNAME_STUB = ArtifactHostnameStubSchema.parse("quiet-amber-fox-run");
const NOW = "2026-09-17T10:00:00.000Z";
const TEST_ENV: Env = env;
const VERSION = 3;
const PAGE_HTML = "<!doctype html><title>Votes";

/**
 * A stateful artifact, as a model would write one: its storage class keeps a
 * `votes` table in the facet's own database, which is the table the supervisor
 * inspection must not see.
 */
const VOTING_MODULE = `
import { DurableObject } from "cloudflare:workers";
export class SiteData extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS votes (member TEXT PRIMARY KEY, choice TEXT NOT NULL)",
    );
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/vote") {
      this.ctx.storage.sql.exec(
        "INSERT INTO votes (member, choice) VALUES (?, 'yes') ON CONFLICT(member) DO NOTHING",
        request.headers.get("x-rally-viewer-id") ?? "anonymous",
      );
      return Response.json({ ok: true });
    }
    return this.env.ASSETS.fetch(request);
  }
}
`;

function bridge(): EngineeringInspectionBridge {
  return new EngineeringInspectionBridge(createExecutionContext(), TEST_ENV);
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function hostStub(artifactId: string): DurableObjectStub<ArtifactHostDO> {
  return env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(
    artifactHostDOName("global", asArtifactId(artifactId)),
  )) as DurableObjectStub<ArtifactHostDO>;
}

/** Publish one artifact the way the publish path does: registry row, then supervisor. */
async function publishArtifact(): Promise<void> {
  await env.PAYLOADS.put(artifactAssetKey(ARTIFACT_ID, VERSION, "index.js"), VOTING_MODULE);
  await env.PAYLOADS.put(artifactAssetKey(ARTIFACT_ID, VERSION, "index.html"), PAGE_HTML);
  const workspaceEnv = withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID);
  await workspaceEnv.DB.prepare(
    `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
        metadata_json, attachment_status, created_at, updated_at)
     VALUES (?, ?, 'generated_site', 'avalon_generated', 'Vote tracker',
             'text/html', NULL, '{}', 'attached', ?, ?)`,
  ).bind(RESOURCE_ID, WORKSPACE_ID, NOW, NOW).run();

  await registerArtifact(workspaceEnv.DB, {
    artifactId: ARTIFACT_ID,
    hostnameStub: HOSTNAME_STUB,
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    resourceId: RESOURCE_ID,
    mode: "active",
    stateful: true,
    version: VERSION,
    manifestRef: artifactAssetKey(ARTIFACT_ID, VERSION, "manifest.json"),
  });

  await hostStub(ARTIFACT_ID).recordPublish({
    artifactId: ARTIFACT_ID,
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    resourceId: RESOURCE_ID,
    region: "global",
    manifest: {
      version: 1 as const,
      artifactId: ARTIFACT_ID,
      artifactVersion: VERSION,
      mode: "active" as const,
      stateful: true,
      serverModuleSha256: "a".repeat(64),
      assets: [{
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        sizeBytes: PAGE_HTML.length,
        sha256: "b".repeat(64),
      }],
      totalBytes: PAGE_HTML.length,
      publishedAt: NOW,
    },
  });
}

beforeEach(async () => {
  await reset();
  await seedInspectableWorkspace(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: AUTHOR_ID,
    sessionId: SESSION_ID,
    at: NOW,
  });
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("engineering inspection of a live web artifact's supervisor", () => {
  it("lists a registered artifact and runs SQL against the supervisor it names", async () => {
    await publishArtifact();
    const inspection = bridge();

    const listed = await inspection.listArtifacts({ workspaceId: WORKSPACE_ID });
    expect(listed).toMatchObject({
      found: true,
      value: {
        region: "global",
        workspaceId: WORKSPACE_ID,
        items: [{
          artifactId: ARTIFACT_ID,
          workstreamId: WORKSTREAM_ID,
          resourceId: RESOURCE_ID,
          mode: "active",
          stateful: true,
          currentVersion: VERSION,
          hostnameStub: HOSTNAME_STUB,
        }],
      },
    });

    const target = await inspection.resolveArtifact({ workspaceId: WORKSPACE_ID, artifactId: ARTIFACT_ID });
    expect(target).toMatchObject({ found: true, value: { authorityGeneration: 1 } });
    if (!target.found) throw new Error("Expected the artifact to resolve");

    // `artifact_state` is the supervisor's single identity row, so reading it
    // back proves the named object is the one that was published rather than a
    // freshly migrated empty supervisor.
    const executed = await inspection.runArtifactSql({
      workspaceId: WORKSPACE_ID,
      artifactId: ARTIFACT_ID,
      authorityGeneration: target.value.authorityGeneration,
      query: {
        sql: "SELECT artifact_id, workstream_id, current_version FROM artifact_state WHERE id = 1",
        bindings: [],
      },
    });
    expect(executed).toMatchObject({
      found: true,
      value: {
        workspaceId: WORKSPACE_ID,
        workstreamId: null,
        substreamId: null,
        sidekickId: null,
        artifactId: ARTIFACT_ID,
        result: {
          rows: [{
            artifact_id: ARTIFACT_ID,
            workstream_id: WORKSTREAM_ID,
            current_version: VERSION,
          }],
        },
      },
    });
  });

  it("refuses an artifact UUID the workspace registry does not hold", async () => {
    await publishArtifact();
    const inspection = bridge();

    expect(await inspection.resolveArtifact({ workspaceId: WORKSPACE_ID, artifactId: UNREGISTERED_ID }))
      .toEqual({ found: false });
    expect(await inspection.runArtifactSql({
      workspaceId: WORKSPACE_ID,
      artifactId: UNREGISTERED_ID,
      authorityGeneration: 1,
      query: { sql: "CREATE TABLE inspection_should_never_run (id INTEGER)", bindings: [] },
    })).toEqual({ found: false });

    // Nothing ran against the object that name would have addressed. Opening it
    // here migrates it, so its emptiness proves nothing on its own — the
    // statement's own table is what a routed call would have left behind.
    const tables = await hostStub(UNREGISTERED_ID).runInspectionSql({
      sql: "SELECT name FROM sqlite_schema WHERE name = 'inspection_should_never_run'",
      bindings: [],
    });
    expect(tables.rows).toEqual([]);
  });

  it("reaches the supervisor's own database and not the stateful artifact's facet", async () => {
    await publishArtifact();
    // One real request through the facet, so the model's class has created its
    // table and written a row in the facet's own database.
    const voted = await hostStub(ARTIFACT_ID).fetchThroughFacet(new Request(
      "https://artifact.test/vote",
      { headers: { "x-rally-viewer-id": AUTHOR_ID, "x-rally-viewer-name": "Ada" } },
    ));
    expect(voted.status).toBe(200);

    const executed = await bridge().runArtifactSql({
      workspaceId: WORKSPACE_ID,
      artifactId: ARTIFACT_ID,
      authorityGeneration: 1,
      query: {
        sql: "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        bindings: [],
      },
    });
    if (!executed.found) throw new Error("Expected the artifact SQL to execute");
    const tables = executed.value.result.rows.map((row) => row.name);
    // The supervisor's own tables are here; the facet's are in a separate
    // database this RPC has no reach into, whatever the artifact wrote.
    expect(tables).toEqual(expect.arrayContaining(["artifact_state", "error_log", "viewer_sessions"]));
    expect(tables).not.toContain("votes");
  });

  it("refuses a stale caller generation and a quarantined workspace route", async () => {
    await publishArtifact();
    const inspection = bridge();

    expect(await inspection.runArtifactSql({
      workspaceId: WORKSPACE_ID,
      artifactId: ARTIFACT_ID,
      authorityGeneration: 2,
      query: { sql: "SELECT 1 AS answer", bindings: [] },
    })).toEqual({ found: false });

    await env.DB.prepare(`UPDATE workspace_product_authority_routes SET state = 'quarantined' WHERE workspace_id = ?`)
      .bind(WORKSPACE_ID).run();
    expect(await inspection.resolveArtifact({ workspaceId: WORKSPACE_ID, artifactId: ARTIFACT_ID }))
      .toEqual({ found: false });
  });
});
