// Copying a seed into an Organization, on real workerd: the queue job's
// consumer, WorkspaceDO's Canvas and resource rows, the Chat's object, R2,
// and the artifact host running the guide's own site as a facet.
// `docs/canvas-seeds.md`.
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asArtifactId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { ArtifactHostDO } from "../src/durable-objects/artifact-host-do";
import { artifactHostDOName, conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext, Env } from "../src/env";
import { GETTING_STARTED_WITH_CANVASES } from "../src/canvas-seeds/getting-started-with-canvases";
import { sha256Hex } from "../src/lib/crypto";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { createMessageObjectPort } from "../src/runtime/message-port";
import { CanvasService } from "../src/services/canvas-service";
import { seedCanvas, seededCanvasId } from "../src/services/canvas-seed-service";
import { existingArtifactForResource, publishSiteVersion } from "../src/services/terminal/site-resource-bridge";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
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

/** The object behind a Canvas's Chat. */
function chat(canvasId: string) {
  return env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, canvasId));
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
    `SELECT artifact_id, resource_id, mode, stateful, current_version FROM artifact_registry WHERE workstream_id = ?`, canvasId,
  ).toArray());
}

/** A request as the serving path forwards it: Rally's viewer headers, no cookie. */
function viewerRequest(path: string, viewer: { id: string; name: string } | null, init: RequestInit = {}): Request {
  return new Request(`https://artifact.test${path}`, {
    ...init,
    headers: viewer ? { "x-rally-viewer-id": viewer.id, "x-rally-viewer-name": encodeURIComponent(viewer.name) } : {},
  });
}

function artifactHost(artifactId: unknown): DurableObjectStub<ArtifactHostDO> {
  return env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(
    artifactHostDOName("global", asArtifactId(String(artifactId))),
  )) as DurableObjectStub<ArtifactHostDO>;
}

type GuideState = {
  viewer: { name: string };
  steps: { id: string; done: boolean; by: string | null; parts?: Record<string, boolean> }[];
  cards: { text: string; kind: string; by: string; mine: boolean }[];
};

async function guideState(host: DurableObjectStub<ArtifactHostDO>, viewer: { id: string; name: string }): Promise<GuideState> {
  return (await host.fetchThroughFacet(viewerRequest("/api/state", viewer))).json<GuideState>();
}

function doneSteps(state: GuideState): string[] {
  return state.steps.filter((step) => step.done).map((step) => step.id);
}

/** The seed's files with one changed, as a publish takes them. */
function guideFiles(change: { path: string; edit: (text: string) => string } | null = null) {
  return Promise.all(GETTING_STARTED_WITH_CANVASES.site.files.map(async (file) => {
    const bytes = new TextEncoder().encode(change?.path === file.path ? change.edit(file.text) : file.text);
    return { path: file.path, bytes, sha256: await sha256Hex(bytes) };
  }));
}

/** Rally republishing the guide: the next version, through the path every site publish takes. */
async function republishGuide(canvasId: string, edit: (html: string) => string) {
  const runtime = withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID);
  const [artifact] = await registeredArtifacts(canvasId);
  const resourceId = String(artifact!.resource_id);
  const files = await guideFiles({ path: "index.html", edit });
  await publishSiteVersion(runtime, runtime.DB, {
    workspaceId: WORKSPACE_ID, workstreamId: canvasId, resourceId,
    previous: await existingArtifactForResource(runtime.DB, WORKSPACE_ID, resourceId),
    claimant: crypto.randomUUID(), mode: "active", stateful: true, files,
    fallbackTitle: "Getting Started with Canvases",
    serverModuleSha256: files.find((file) => file.path === "index.js")!.sha256,
    // The row write is each publisher's own and is covered where it lives.
    recordResource: () => Promise.resolve(true),
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
  it("makes one Canvas every member can open, with the site as its first version and a Chat that opens on the owner's request and Rally's answer", async () => {
    expect(await deliverSeedJob()).toEqual([]);

    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    // Read as a member who was never added to it: the Organization is its audience.
    const detail = await new CanvasService(TEST_ENV, auth(MEMBER)).detail(canvasId);
    expect({
      title: detail.title, createdByUserId: detail.createdByUserId, visibility: detail.visibility,
      appearance: detail.appearance, lastEditor: detail.lastEditor,
      artifacts: detail.artifacts.map((artifact) => [artifact.title, artifact.kind, artifact.version]),
    }).toEqual({
      title: "Getting Started with Canvases", createdByUserId: OWNER, visibility: "workspace",
      appearance: { icon: "graduation-cap", color: "blue" }, lastEditor: { kind: "rally", id: null },
      artifacts: [["Getting Started with Canvases", "site", 1]],
    });
    expect((await registeredArtifacts(canvasId)).map((row) => [row.mode, row.stateful, row.current_version]))
      .toEqual([["active", 1, 1]]);

    // The seed's own words, whatever they are: what is proved is who said
    // them, in what order, and that no run stands behind either.
    const said = await createMessageObjectPort(TEST_ENV, WORKSPACE_ID, canvasId).messagesAfter({ afterSequence: 0, limit: 10 });
    expect(said.map((message) => [message.author_type, message.author_user_id, message.message_type, message.harness_run_id, message.text_content])).toEqual([
      ["human", OWNER, "text", null, GETTING_STARTED_WITH_CANVASES.request],
      ["agent", null, "text", null, GETTING_STARTED_WITH_CANVASES.openingMessage],
    ]);
    // Recorded, not asked: nothing was queued for Rally to answer.
    expect(await runInDurableObject(chat(canvasId), (_instance, state) => state.storage.sql.exec(
      "SELECT (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM pending_loop_inputs) AS waiting",
    ).one())).toEqual({ runs: 0, waiting: 0 });
  });

  it("serves the guide's own page and data behind Rally's artifact host", async () => {
    await deliverSeedJob();
    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    const [artifact] = await registeredArtifacts(canvasId);
    const host = artifactHost(artifact!.artifact_id);
    const ada = { id: OWNER, name: "Ada Lovelace" };

    // Nobody outside Rally reads the wall: no viewer headers, no page.
    expect((await host.fetchThroughFacet(viewerRequest("/", null))).status).toBe(401);

    const page = await host.fetchThroughFacet(viewerRequest("/", ada));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Getting Started with Canvases</title>");

    const added = await host.fetchThroughFacet(viewerRequest("/api/cards", ada, { method: "POST", body: JSON.stringify({ text: "A tracker for renewals" }) }));
    const state = await added.json<GuideState>();
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

  it("ticks the Chat steps from what the site can see, with no row from Rally to say so", async () => {
    await deliverSeedJob();
    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    const [artifact] = await registeredArtifacts(canvasId);
    const host = artifactHost(artifact!.artifact_id);
    const ada = { id: OWNER, name: "Ada Lovelace" };
    const grace = { id: MEMBER, name: "Grace Hopper" };
    expect(doneSteps(await guideState(host, ada))).toEqual([]);

    // Step 2, as Rally writes it knowing who asked: the card is Rally's, and
    // the step is that person's alone.
    await host.writeData("INSERT INTO wall_cards (text, asked_by_id) VALUES (?, ?)", ["A renewals tracker", ada.id], 200, { rows: "all" });
    const asked = await guideState(host, ada);
    expect(asked.cards.filter((card) => card.kind === "rally").map((card) => [card.text, card.by])).toEqual([["A renewals tracker", "Rally"]]);
    expect(doneSteps(asked)).toEqual(["ask_rally"]);
    expect(doneSteps(await guideState(host, grace))).toEqual([]);

    // The same write from a Rally that never read the guide's README: only
    // the text. Nobody can be told apart, so it counts for everyone.
    await host.writeData("INSERT INTO wall_cards (text) VALUES (?)", ["A hiring dashboard"], 200, { rows: "all" });
    expect(doneSteps(await guideState(host, grace))).toEqual(["ask_rally"]);

    // Step 3 renames the wall. That republish is not step 4.
    await republishGuide(canvasId, (html) => html.replace(">Team wall</h2>", ">Idea board</h2>"));
    expect(doneSteps(await guideState(host, ada))).toEqual(["ask_rally"]);

    // Step 4 remakes the page, and the page proves it to everybody.
    await republishGuide(canvasId, (html) => html.replace("This is a Canvas.", "This is Northwind's Canvas."));
    expect(doneSteps(await guideState(host, grace))).toEqual(["ask_rally", "make_it_yours"]);
  });

  it("finishes a publish that stopped before the site was served, even after the seed's files changed", async () => {
    // The first attempt writes the site's row and registry, then the
    // artifact host cannot be reached.
    const unreachable = new Proxy(env.ARTIFACT_HOSTS, {
      get(target, property) {
        if (property === "get") return () => { throw new Error("artifact_host_unreachable"); };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(seedCanvas({ ...TEST_ENV, ARTIFACT_HOSTS: unreachable }, { workspaceId: WORKSPACE_ID, creatorUserId: OWNER },
      GETTING_STARTED_WITH_CANVASES)).rejects.toThrow("artifact_host_unreachable");
    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    const [artifact] = await registeredArtifacts(canvasId);
    expect((await artifactHost(artifact!.artifact_id).fetchThroughFacet(viewerRequest("/", { id: OWNER, name: "Ada" }))).status).toBe(404);

    // A deploy lands between the attempts and changes one of the seed's files,
    // and the words of the request the first attempt already recorded.
    const redeployed = { ...GETTING_STARTED_WITH_CANVASES, request: `${GETTING_STARTED_WITH_CANVASES.request}\nA later line.`, site: { ...GETTING_STARTED_WITH_CANVASES.site,
      files: GETTING_STARTED_WITH_CANVASES.site.files.map((file) => file.path === "README.md" ? { ...file, text: `${file.text}\nA later edit.\n` } : file) } };
    expect(await seedCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: OWNER }, redeployed)).toEqual({ canvasId, seeded: true });

    const page = await artifactHost(artifact!.artifact_id).fetchThroughFacet(viewerRequest("/", { id: OWNER, name: "Ada" }));
    expect(page.status).toBe(200);
    expect((await registeredArtifacts(canvasId)).map((row) => row.current_version)).toEqual([1]);
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
    expect(said.map((message) => message.author_type)).toEqual(["human", "agent"]);
  });

  it("opens the Chat on Rally's message alone when the creator has left before the job runs", async () => {
    await env.DB.prepare(`UPDATE workspace_members SET status = 'removed' WHERE workspace_id = ? AND user_id = ?`)
      .bind(WORKSPACE_ID, OWNER).run();

    expect(await deliverSeedJob()).toEqual([]);

    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    const said = await createMessageObjectPort(TEST_ENV, WORKSPACE_ID, canvasId).messagesAfter({ afterSequence: 0, limit: 10 });
    expect(said.map((message) => message.author_type)).toEqual(["agent"]);
  });

  it("does nothing, and asks for no retry, when the guide was archived", async () => {
    await deliverSeedJob();
    const canvasId = await seededCanvasId(WORKSPACE_ID, SEED_KEY);
    await new CanvasService(TEST_ENV, auth(OWNER, "owner")).archive(canvasId);

    // A replay of the creation, or a redrive from the dead-letter queue.
    expect(await deliverSeedJob()).toEqual([]);
  });

  it("fails the job, for the queue to retry, when it names a seed this Worker does not carry", async () => {
    // A throw out of the consumer is the retry: the batch holds one message.
    await expect(deliverSeedJob("a-seed-from-a-newer-version")).rejects.toThrow("canvas_seed_unknown");
    expect(await new CanvasService(TEST_ENV, auth(OWNER, "owner")).list()).toEqual([]);
  });
});
