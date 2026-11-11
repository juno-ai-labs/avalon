// Copying a seed into an Organization, on real workerd: the queue job's
// consumer, WorkspaceDO's Canvas and resource rows, the Chat's object, R2,
// and the artifact host running the guide's own site as a facet.
// `docs/canvas-seeds.md`.
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asArtifactId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { ArtifactHostDO } from "../src/durable-objects/artifact-host-do";
import { artifactHostDOName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext, Env } from "../src/env";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { createMessageObjectPort } from "../src/runtime/message-port";
import { CanvasService } from "../src/services/canvas-service";
import { seededCanvasId } from "../src/services/canvas-seed-service";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00005eed0000");
const OWNER = asUserId("00000000-0000-7000-8000-00005eed0001");
const MEMBER = asUserId("00000000-0000-7000-8000-00005eed0002");
const SEED_KEY = "getting-started-with-canvases";
const TEST_ENV: Env = env;
useHeldEffectQueue();

function auth(userId: string, role: AuthContext["role"] = "member"): AuthContext {
  return { sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global", role };
}

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

/** Deliver one `canvas_seed` job to the real consumer, and answer what it asked to retry. */
async function deliverSeedJob(seedKey = SEED_KEY) {
  const batch = createMessageBatch("avalon-do-runtime-test-activity", [{
    id: `seed-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1,
    body: { kind: "canvas_seed", workspaceId: WORKSPACE_ID, creatorUserId: OWNER, seedKey, region: "global" },
  }]);
  await consumeActivityQueue(batch, TEST_ENV);
  return (await getQueueResult(batch, createExecutionContext())).retryMessages;
}

function registeredArtifacts(canvasId: string) {
  return runInDurableObject(workspace(), (_instance: WorkspaceDO, state) => state.storage.sql.exec(
    `SELECT artifact_id, mode, stateful, current_version FROM artifact_registry WHERE workstream_id = ?`, canvasId,
  ).toArray());
}

/** A request as the serving path forwards it: Rally's viewer headers, no cookie. */
function viewerRequest(path: string, viewer: { id: string; name: string } | null, init: RequestInit = {}): Request {
  return new Request(`https://artifact.test${path}`, {
    ...init,
    headers: viewer ? { "x-rally-viewer-id": viewer.id, "x-rally-viewer-name": encodeURIComponent(viewer.name) } : {},
  });
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: OWNER, sessionId: `session-${OWNER}` });
  await env.DB.batch([
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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
  ]);
  // Creation initializes the Organization's object before it asks for the seed.
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  // The platform database's hostname routes, which a site's public origin reserves.
  await env.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS artifact_hostname_routes (
    hostname_stub TEXT PRIMARY KEY, region TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(region, artifact_id))`).run();
});

describe("seeding the Getting Started guide into an Organization", () => {
  it("makes one Canvas every member can open, with the site as its first version and Rally's opening message", async () => {
    expect(await deliverSeedJob()).toEqual([]);

    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    // Read as a member who was never added to it: the Organization is its audience.
    const detail = await new CanvasService(TEST_ENV, auth(MEMBER)).detail(canvasId);
    expect({
      title: detail.title, createdByUserId: detail.createdByUserId, visibility: detail.visibility,
      appearance: detail.appearance, lastEditor: detail.lastEditor,
      artifacts: detail.artifacts.map((artifact) => [artifact.kind, artifact.version]),
    }).toEqual({
      title: "Getting Started with Canvases", createdByUserId: OWNER, visibility: "workspace",
      appearance: { icon: "graduation-cap", color: "blue" }, lastEditor: { kind: "rally", id: null },
      artifacts: [["site", 1]],
    });
    expect((await registeredArtifacts(canvasId)).map((row) => [row.mode, row.stateful, row.current_version]))
      .toEqual([["active", 1, 1]]);

    const opening = await createMessageObjectPort(TEST_ENV, WORKSPACE_ID, canvasId)
      .messageByClientId({ clientMessageId: `canvas-seed:${SEED_KEY}:opening` });
    expect([opening?.author_type, opening?.message_type, opening?.harness_run_id]).toEqual(["agent", "text", null]);
    expect(opening?.text_content?.split("\n")[0]).toBe(
      "Welcome to Rally. This is a Canvas: a conversation with me, and the things I make from it. The page beside this Chat is one of them, and it is live.",
    );
  });

  it("serves the guide's own page and data behind Rally's artifact host", async () => {
    await deliverSeedJob();
    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    const [artifact] = await registeredArtifacts(canvasId);
    const host = env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(
      artifactHostDOName("global", asArtifactId(String(artifact!.artifact_id))),
    )) as DurableObjectStub<ArtifactHostDO>;
    const ada = { id: OWNER, name: "Ada Lovelace" };

    // Nobody outside Rally reads the wall: no viewer headers, no page.
    expect((await host.fetchThroughFacet(viewerRequest("/", null))).status).toBe(401);

    const page = await host.fetchThroughFacet(viewerRequest("/", ada));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Getting Started with Canvases</title>");

    const added = await host.fetchThroughFacet(viewerRequest("/api/cards", ada, { method: "POST", body: JSON.stringify({ text: "A tracker for renewals" }) }));
    const state = await added.json<{ viewer: { name: string }; steps: { id: string; done: boolean; parts?: Record<string, boolean> }[]; cards: { text: string; kind: string; mine: boolean }[] }>();
    expect(state.viewer).toEqual({ name: "Ada Lovelace" });
    expect(state.cards.map((card) => [card.text, card.kind, card.mine])).toEqual([
      ["A tracker for renewals", "person", true],
      ["A weekly status page for the team", "starter", false],
      ["A launch checklist with owners and dates", "starter", false],
      ["A tracker for our hiring plan", "starter", false],
    ]);
    expect(state.steps.map((step) => [step.id, step.done])).toEqual([
      ["use_the_page", false], ["ask_rally", false], ["comment", false],
      ["make_it_yours", false], ["teammate", false], ["own_canvas", false],
    ]);
    expect(state.steps[0]!.parts).toEqual({ addedCard: true, voted: false });
  });

  it("does nothing the second time, and does not undo what people changed since", async () => {
    await deliverSeedJob();
    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    // The owner closes the guide to themselves and renames it.
    const owner = new CanvasService(TEST_ENV, auth(OWNER, "owner"));
    await owner.setAudience(canvasId, { visibility: "creator", userIds: [] });
    await owner.update(canvasId, { appearance: { icon: "rocket" } });

    expect(await deliverSeedJob()).toEqual([]);

    const detail = await owner.detail(canvasId);
    expect([detail.visibility, detail.appearance, detail.artifacts.map((artifact) => artifact.version)])
      .toEqual(["creator", { icon: "rocket", color: "blue" }, [1]]);
    expect((await owner.list()).map((row) => row.title)).toEqual(["Getting Started with Canvases"]);
    const said = await createMessageObjectPort(TEST_ENV, WORKSPACE_ID, canvasId).messagesAfter({ afterSequence: 0, limit: 10 });
    expect(said.map((message) => message.author_type)).toEqual(["agent"]);
  });

  it("fails the job, for the queue to retry, when it names a seed this Worker does not carry", async () => {
    // A throw out of the consumer is the retry: the batch holds one message.
    await expect(deliverSeedJob("a-seed-from-a-newer-version")).rejects.toThrow("canvas_seed_unknown");
    expect(await new CanvasService(TEST_ENV, auth(OWNER, "owner")).list()).toEqual([]);
  });
});
