// An MCP client's token reaches a conversation only when it is a Canvas's
// Chat: the person let the client read and change Canvases, never their
// Sidekicks' conversations. On real workerd, through the Organization
// object's own resolve. `docs/rally-mcp.md`.
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { Hono } from "hono";

import type { AuthContext, Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { canvasRoutes } from "../src/routes/canvases";
import { resourceRoutes } from "../src/routes/resources";
import { issueAccessToken } from "../src/services/auth-service";
import { CanvasPublicationService } from "../src/services/canvas-publication-service";
import { createAutomation } from "../src/services/automation-service";
import { CanvasService, createCanvas } from "../src/services/canvas-service";
import { ConversationService } from "../src/services/conversation-service";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000cd900");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000cd901");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000cd902");
const TEST_ENV: Env = env;
useHeldEffectQueue();

function auth(userId: string): AuthContext {
  return { sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global", role: "member" };
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: CREATOR, sessionId: `session-${CREATOR}` });
  await env.DB.batch([
    // The session check's analytics surrogates (`authenticateSession`).
    env.DB.prepare("ALTER TABLE users ADD COLUMN analytics_person_id TEXT"),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class)
      VALUES (?, ?, 'active', 'member', 'member')`).bind(WORKSPACE_ID, MEMBER),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
  ]);
  // The platform database's hostname routes, which a site's public origin reserves.
  await env.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS artifact_hostname_routes (
    hostname_stub TEXT PRIMARY KEY, region TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(region, artifact_id))`).run();
});

it("opens a Canvas's Chat for an MCP client and finds no Sidekick conversation", async () => {
  const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
  const { automationId } = await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: CREATOR, scope: "workspace" });
  const mcp = new ConversationService(TEST_ENV, auth(CREATOR), undefined, true);

  await expect(mcp.readText(canvasId, { afterSequence: 0 })).resolves.toMatchObject({ kind: "canvas" });
  await expect(mcp.readText(automationId, { afterSequence: 0 })).rejects.toMatchObject({ status: 404, code: "conversation_not_found" });
  // The app's own session still opens the Sidekick's conversation.
  await expect(new ConversationService(TEST_ENV, auth(CREATOR)).readText(automationId, { afterSequence: 0 }))
    .resolves.toMatchObject({ kind: "automation" });
});

it("reads an artifact through the Canvas that holds it, and nothing through /resources", async () => {
  const app = new Hono<HonoAppEnv>().onError(errorHandler).route("/canvases", canvasRoutes).route("/resources", resourceRoutes);
  const publisher = new CanvasPublicationService(TEST_ENV, auth(CREATOR));
  const plan = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
  const other = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR });
  const inPlan = await publisher.publish(plan.canvasId, { kind: "file", name: "plan.md", content: { encoding: "text", data: "# Plan" } });
  const inOther = await publisher.publish(other.canvasId, { kind: "file", name: "notes.md", content: { encoding: "text", data: "# Notes" } });
  const headers = { authorization: `Bearer ${await issueAccessToken(TEST_ENV, auth(CREATOR), "mcp")}` };
  const read = (canvasId: string, resourceId: string) =>
    app.request(`/canvases/${canvasId}/artifacts/${resourceId}/versions/1/content`, { headers }, TEST_ENV);

  const own = await read(plan.canvasId, inPlan.resourceId);
  expect(own.status).toBe(200);
  expect(await own.text()).toBe("# Plan");
  // Its text form is prepared on the first read, not left waiting for one.
  const model = await app.request(`/canvases/${plan.canvasId}/artifacts/${inPlan.resourceId}/versions/1/model-content`, { headers }, TEST_ENV);
  expect([model.status, await model.text()]).toEqual([200, "# Plan"]);
  // Another Canvas's artifact is not this Canvas's, whoever may read it.
  const elsewhere = await read(plan.canvasId, inOther.resourceId);
  expect(elsewhere.status).toBe(404);
  expect((await elsewhere.json<{ error: { code: string } }>()).error.code).toBe("canvas_artifact_not_found");
  const direct = await app.request(`/resources/${inPlan.resourceId}/versions/1/content`, { headers }, TEST_ENV);
  expect(direct.status).toBe(403);
  expect((await direct.json<{ error: { code: string } }>()).error.code).toBe("mcp_route_unavailable");
});

it("finds a Canvas by its title among all of them, not only the most recent", async () => {
  const older = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
  await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Budget" });
  const canvases = new CanvasService(TEST_ENV, auth(CREATOR));
  expect((await canvases.list("LAUNCH")).map((row) => row.id)).toEqual([older.canvasId]);
  expect((await canvases.list()).map((row) => row.title).sort()).toEqual(["Budget", "Launch plan"]);
});
