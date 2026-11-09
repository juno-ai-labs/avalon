/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ResourceRevisionSchema, asUserId, asWorkspaceId } from "@rally/contracts";

import seed from "../../../packages/db/seed-product.json";
import { workspaceDOName } from "../src/durable-objects/names";
import type { Env } from "../src/env";
import { SeedProductBodySchema, seedPayloads, seedProduct } from "../src/routes/dev";
import { ResourceService } from "../src/services/resource-service";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000002";
const TEST_ENV: Env = env;

describe("the development seed's stored bodies", () => {
  it("stores the Launch plan artifact's body where its content_ref points, so it renders", async () => {
    // The local-authority script drops the human-readable note before posting.
    const body: Record<string, unknown> = { ...seed };
    delete body.comment;
    const fixture = SeedProductBodySchema.parse(body);
    await seedPayloads({ ...env, AVALON_REGION: "global" }, fixture.workspaceId, fixture.payloads);

    const artifact = fixture.workspaceTables.resources!.find((row) => row.id === "00000000-0000-7000-8000-000000000041")!;
    const stored = await env.PAYLOADS.get(String(artifact.content_ref));
    expect(stored?.httpMetadata?.contentType).toBe("text/markdown; charset=utf-8");
    expect((await stored!.text()).split("\n")[0]).toBe("# Pricing launch readiness");
  });

  it("refuses a body outside the Organization's seed prefix", async () => {
    await expect(seedPayloads({ ...env, AVALON_REGION: "global" }, WORKSPACE_ID, [
      { key: `global/${WORKSPACE_ID}/resources/real.md`, contentType: "text/plain", text: "x" },
    ])).rejects.toMatchObject({ code: "seed_payload_key_not_allowed" });
    expect(await env.PAYLOADS.get(`global/${WORKSPACE_ID}/resources/real.md`)).toBeNull();
  });
});

describe("the seeded Launch plan artifact's versions", () => {
  const LAUNCH_PLAN = "00000000-0000-7000-8000-000000000021";
  const ARTIFACT = "00000000-0000-7000-8000-000000000041";
  /** Launch plan's creator in the fixture. */
  const SAMANTHA = "00000000-0000-7000-8000-000000000003";
  /** The fixture's webhook connection. */
  const CONNECTION = "00000000-0000-7000-8000-000000000061";
  const RUN = "00000000-0000-7000-8000-0000000000d1";

  /**
   * The fixture as the local-authority script posts it, with only Launch plan,
   * no Sidekick and no Chat turns: the transcript's development seam answers
   * only a development Worker, and the turns are not what this reads.
   */
  function launchPlanSeed() {
    const body: Record<string, unknown> = { ...seed };
    delete body.comment;
    const fixture = SeedProductBodySchema.parse(body);
    return { ...fixture, automations: [], canvases: fixture.canvases
      .filter((canvas) => canvas.id === LAUNCH_PLAN).map((canvas) => ({ ...canvas, messages: [] })) };
  }

  async function prepare() {
    await reset();
    await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: SAMANTHA, sessionId: `session-${SAMANTHA}` });
    // The regional rows `createCanvas` writes, which this suite's empty D1 lacks.
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
        workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
        state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
        workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
        object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
        source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
        source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
        verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
    ]);
  }

  /** What `GET /resources/:id/versions` answers Samantha, newest first. */
  async function versions() {
    const reader = new ResourceService(TEST_ENV, { sessionId: `session-${SAMANTHA}`, userId: asUserId(SAMANTHA),
      workspaceId: asWorkspaceId(WORKSPACE_ID), region: "global", role: "member" });
    return ResourceRevisionSchema.array().parse(await reader.versions(ARTIFACT))
      .map(({ version, mimeType, sizeBytes, contentAvailable, author }) => ({ version, mimeType, sizeBytes, contentAvailable, author }));
  }

  /** Who `GET /resources/:id/versions` says made each version, newest first. */
  async function authors() {
    const reader = new ResourceService(TEST_ENV, { sessionId: `session-${SAMANTHA}`, userId: asUserId(SAMANTHA),
      workspaceId: asWorkspaceId(WORKSPACE_ID), region: "global", role: "member" });
    return ResourceRevisionSchema.array().parse(await reader.versions(ARTIFACT))
      .map(({ version, author, authorName }) => ({ version, author, authorName }));
  }

  /** The stored body's length in UTF-8 bytes, which is what a publish records as its size. */
  const BODY_BYTES = 770;

  it("lists the one version as Markdown, sized, stored and by Rally, and a re-run adds none", async () => {
    await prepare();
    await seedProduct(TEST_ENV, launchPlanSeed());
    const once = await versions();
    expect(once).toEqual([
      { version: 1, mimeType: "text/markdown", sizeBytes: BODY_BYTES, contentAvailable: true, author: { kind: "system" } },
    ]);
    await seedProduct(TEST_ENV, launchPlanSeed());
    expect(await versions()).toEqual(once);
  });

  it("repairs every version an older seed wrote as empty plain text", async () => {
    await prepare();
    // The resource an older seed wrote: plain text, no body, no size, no author.
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", asWorkspaceId(WORKSPACE_ID))));
    await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'text', 'fixture', 'launch-readiness', 'Launch readiness notes', 'text/plain', '{}', ?, ?)`,
      ARTIFACT, WORKSPACE_ID, "2026-07-31T19:15:00.000Z", "2026-07-31T19:39:00.000Z");
    });
    await seedProduct(TEST_ENV, launchPlanSeed());
    await seedProduct(TEST_ENV, launchPlanSeed());
    expect(await versions()).toEqual([
      { version: 2, mimeType: "text/markdown", sizeBytes: BODY_BYTES, contentAvailable: true, author: { kind: "system" } },
      { version: 1, mimeType: "text/markdown", sizeBytes: BODY_BYTES, contentAvailable: true, author: { kind: "system" } },
    ]);
  });

  it("leaves a version a run made after seeding alone on a re-run", async () => {
    await prepare();
    await seedProduct(TEST_ENV, launchPlanSeed());
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", asWorkspaceId(WORKSPACE_ID))));
    // A run republishes the artifact as a table with its own body, as the Terminal's publish stages it.
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`UPDATE resources SET mime_type = 'text/csv', content_ref = ?, metadata_json = '{"size":11}',
        revision_author_kind = 'agent', revision_author_run_id = ?, revision_cause = 'published' WHERE id = ?`,
      `global/${WORKSPACE_ID}/resources/${ARTIFACT}/terminal/plan`, RUN, ARTIFACT);
    });
    await seedProduct(TEST_ENV, launchPlanSeed());
    expect(await versions()).toEqual([
      { version: 2, mimeType: "text/csv", sizeBytes: 11, contentAvailable: true, author: { kind: "agent", runId: RUN } },
      { version: 1, mimeType: "text/markdown", sizeBytes: BODY_BYTES, contentAvailable: true, author: { kind: "system" } },
    ]);
  });

  it("names a member's version by the person and a connector's by its connection, and Rally's by nobody", async () => {
    await prepare();
    await seedProduct(TEST_ENV, launchPlanSeed());
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", asWorkspaceId(WORKSPACE_ID))));
    // A rename by Samantha, then a refetch by the fixture's connection, as their producers stage them.
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`UPDATE resources SET title = 'Launch readiness', revision_author_kind = 'member',
        revision_author_user_id = ?, revision_cause = 'renamed' WHERE id = ?`, SAMANTHA, ARTIFACT);
      state.storage.sql.exec(`UPDATE resources SET title = 'Launch readiness notes', revision_author_kind = 'connector',
        revision_author_connection_id = ?, revision_cause = 'refetched' WHERE id = ?`, CONNECTION, ARTIFACT);
    });
    expect(await authors()).toEqual([
      { version: 3, author: { kind: "connector", connectionId: CONNECTION }, authorName: "Incident updates fixture" },
      { version: 2, author: { kind: "member", userId: SAMANTHA }, authorName: "Member" },
      { version: 1, author: { kind: "system" }, authorName: null },
    ]);
  });
});
