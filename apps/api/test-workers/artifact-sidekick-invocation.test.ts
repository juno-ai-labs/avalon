/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  artifactAssetKey, asArtifactId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId,
  type ArtifactSidekickInvocation, type AutomationDraft,
} from "@rally/contracts";
import type * as TestWorker from "./fixtures/engineering-task-worker";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { artifactHostDOName, conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { createCanvas } from "../src/services/canvas-service";
import { createAutomation } from "../src/services/automation-service";
import artifactWorker from "../src/artifacts/index";
import { ASSET_SHIM_MODULE, ASSET_SHIM_SOURCE, LOADER_ENTRY_MODULE, LOADER_ENTRY_SOURCE } from "../src/artifacts/asset-shim";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble, withSuccessfulSidekickOutcome } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { runSidekickAlarms } from "./helpers/sidekick";
import { startWaitBudget, waitBudget } from "./helpers/wait-budget";

let workspaceId = asWorkspaceId(crypto.randomUUID());
const author = asUserId("00000000-0000-7000-8000-000000009501");
let canvasId = asWorkstreamId(crypto.randomUUID());
let artifactId = asArtifactId(crypto.randomUUID());
let resourceId = crypto.randomUUID();
let sidekickId = crypto.randomUUID();
const actor = { userId: author, actorRole: "member" as const, participantOfOwningWorkstream: false };
const NOW = "2026-11-11T12:00:00.000Z";

const SITE = `
import { DurableObject } from "cloudflare:workers";
export class SiteData extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS items (name TEXT, section TEXT)");
  }
  async fetch(request) {
    if (request.method === "POST") {
      const input = await request.json();
      const result = await this.env.SIDEKICKS.shoppingOrganizer.send(input);
      return Response.json(result, { status: 202 });
    }
    return Response.json(this.ctx.storage.sql.exec("SELECT name, section FROM items").toArray());
  }
}
`;
const STATELESS_SITE = `export default {
  async fetch(request, env) {
    return Response.json(await env.SIDEKICKS.shoppingOrganizer.send(await request.json()), { status: 202 });
  }
};`;

useHeldEffectQueue();
useSelectedModel();
const provider = useOpenRouterDouble(withSuccessfulSidekickOutcome((call) => {
  const written = call.messages.some((message) => message.role === "tool"
    && (typeof message.content === "string" ? message.content : JSON.stringify(message.content)).includes('"rowsWritten"'));
  if (written) return { say: "Added Greek yogurt under Dairy." };
  const write = call.toolNames.find((name) => name === "write_artifact_data");
  if (!write) throw new Error(`Standard artifact write tool missing: ${call.toolNames.join(",")}`);
  return { callTool: { name: write, arguments: {
    resource: resourceId, sql: "INSERT INTO items (name, section) VALUES (?, ?) RETURNING name, section",
    params: ["Greek yogurt", "dairy"],
  } } };
}));

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, workspaceId)));
}
function host() {
  return env.ARTIFACT_HOSTS.get(env.ARTIFACT_HOSTS.idFromName(artifactHostDOName(env.AVALON_REGION, artifactId)));
}
function invocation(overrides: Partial<ArtifactSidekickInvocation> = {}): ArtifactSidekickInvocation {
  return { workspaceId, artifactId, artifactVersion: 1, bindingName: "shoppingOrganizer", operationId: "add-yogurt", input: { item: "Greek yogurt" }, ...overrides };
}
function draft(bindingName = "shoppingOrganizer"): AutomationDraft {
  return {
    name: "Shopping organizer", description: "Sorts shopping items", overview: "Organizes this app's list",
    instructions: `Read the submitted item and use write_artifact_data to add it to resource ${resourceId} in its store section.`,
    triggers: [{ type: "invocation", artifactId, bindingName }], requiredCapabilities: [], expectedOutputs: [],
    defaultBehavior: {}, recommendedPlugins: [], memoryTables: [], customTools: [], suggestedScope: "personal",
    followUpQuestion: null, elicitation: null, ready: true,
  };
}
async function save(id = sidekickId, definition = draft()) {
  return runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickSaveDefinition({
    workspaceId, automationId: id, actor, draft: definition, evaluatorRules: null, submittedByRunId: null,
  }));
}
async function refusal(run: (instance: WorkspaceDO) => Promise<unknown>) {
  return runInDurableObject(workspace(), async (instance: WorkspaceDO) => {
    try { await run(instance); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  });
}
async function rows() {
  return (await host().fetchThroughFacet(new Request("https://app.test/api/items"))).json();
}

/** Register published files against the real workspace and artifact authorities. */
async function publishApp(stateful: boolean, source: string) {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, uploaded_by_user_id, created_at, updated_at)
      VALUES (?, ?, 'generated_site', 'avalon_generated', 'Shopping tracker', '{}', 'attached', ?, ?, ?)`, resourceId, workspaceId, author, NOW, NOW);
    state.storage.sql.exec(`INSERT INTO artifact_registry
      (artifact_id, workspace_id, workstream_id, resource_id, mode, stateful, current_version, manifest_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, 1, 'fixture-manifest', 1, 1)`, artifactId, workspaceId, canvasId, resourceId, stateful ? 1 : 0);
  });
  await workspace().canvasNoteArtifact({ workspaceId, canvasId, resourceId, editor: { kind: "rally", id: null } });
  await env.PAYLOADS.put(artifactAssetKey(artifactId, 1, "index.js"), source);
  await host().recordPublish({ artifactId, workspaceId, workstreamId: canvasId, resourceId, region: env.AVALON_REGION,
    manifest: { version: 1, artifactId, artifactVersion: 1, mode: "active", stateful, serverModuleSha256: "a".repeat(64),
      totalBytes: 0, publishedAt: NOW, assets: [] } });
}

beforeEach(async () => {
  startWaitBudget();
  await reset();
  workspaceId = asWorkspaceId(crypto.randomUUID());
  canvasId = asWorkstreamId(crypto.randomUUID());
  artifactId = asArtifactId(crypto.randomUUID());
  resourceId = crypto.randomUUID();
  sidekickId = crypto.randomUUID();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: author, sessionId: crypto.randomUUID() });
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workstreams (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, object_name TEXT NOT NULL,
      state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0, source_cursor INTEGER NOT NULL DEFAULT 0,
      source_fence_sequence INTEGER NOT NULL, source_hash TEXT, target_hash TEXT, row_counts_json TEXT,
      imported_at TEXT, verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
  ]);
  await createCanvas(env, { workspaceId, canvasId, title: "Shopping tracker", creatorUserId: author });
  await createAutomation(env, { workspaceId, authorUserId: author, scope: "personal", automationId: sidekickId, madeInCanvasId: canvasId });
  await publishApp(true, SITE);
  await save();
});

describe("an app's dedicated Sidekicks", () => {
  it("admits from a real stateful route, then a normal Sidekick run writes through its standard tool", async () => {
    const response = await host().fetchThroughFacet(new Request("https://app.test/api/items", {
      method: "POST", body: JSON.stringify({ operationId: "add-yogurt", input: { item: "Greek yogurt" } }),
    }));
    expect(response.status).toBe(202);
    const admitted = await response.json<{ runId: string; reused: boolean }>();
    expect(admitted.reused).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(await rows()).toEqual([]);
    const repeated = await workspace().artifactInvokeSidekick(invocation());
    expect(repeated).toEqual({ runId: admitted.runId, reused: true });
    const run = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      trigger_json: string; opening_json: string; definition_revision: number;
    }>("SELECT trigger_json, opening_json, definition_revision FROM sidekick_runs WHERE run_id = ?", admitted.runId).one());
    expect(JSON.parse(run.trigger_json)).toEqual({ kind: "invocation", artifactId, artifactVersion: 1, bindingName: "shoppingOrganizer", operationId: "add-yogurt" });
    expect(JSON.parse(run.opening_json)).toMatchObject({ structuredContent: { kind: "artifact_invocation", artifactId, artifactVersion: 1,
      bindingName: "shoppingOrganizer", operationId: "add-yogurt", resourceId, input: { item: "Greek yogurt" } } });
    expect(run.definition_revision).toBe(1);
    await runSidekickAlarms(env, workspaceId);
    await expect.poll(rows, { timeout: waitBudget() }).toEqual([{ name: "Greek yogurt", section: "dairy" }]);
    // Wait for the loop's final reply before the next reset closes its provider stream.
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName(env.AVALON_REGION, workspaceId, sidekickId, asSubstreamId(admitted.runId))));
    const finished = () => runInDurableObject(child, (_instance, state) => state.storage.sql.exec<{
      status: string; terminalized_at: number | null;
    }>("SELECT status, terminalized_at FROM runs ORDER BY created_at DESC LIMIT 1").one());
    await expect.poll(async () => (await finished()).terminalized_at, { timeout: waitBudget() }).not.toBeNull();
    expect((await finished()).status).toBe("completed");
  });

  it("crosses the real stateless loader binding and the serving-to-API dispatch boundary", async () => {
    const oldArtifact = artifactId;
    artifactId = asArtifactId(crypto.randomUUID());
    resourceId = crypto.randomUUID();
    await publishApp(false, STATELESS_SITE);
    await save();
    expect(await refusal((instance) => instance.artifactInvokeSidekick(invocation({ artifactId: oldArtifact })))).toContain("No Sidekick");
    const ctx = createExecutionContext();
    const props = { workspaceId, artifactId, artifactVersion: 1 };
    const loader = env.ARTIFACT_LOADER;
    if (!loader) throw new Error("This suite requires the Worker Loader binding");
    if (!("ArtifactSidekickForwarder" in ctx.exports)) throw new Error("The test Worker must export the serving loopback");
    // Production ctx.exports is typed from the API; this checked export exists only on the real test Worker.
    const forwarder = ctx.exports.ArtifactSidekickForwarder as LoopbackForExport<typeof TestWorker.ArtifactSidekickForwarder>;
    const first = await workspace().artifactInvokeSidekick(invocation({ operationId: "stateless", input: { item: "bread" } }));
    // Exercise the production serving handler's own loader assembly.
    const served = await artifactWorker.fetch(new Request(`https://${artifactId}-g.rallyusercontent.test/api/items`, {
      method: "POST", body: JSON.stringify({ operationId: "stateless", input: { item: "bread" } }),
    }), {
      APP_ENV: "test", AVALON_REGION: env.AVALON_REGION, ARTIFACT_SERVING_DOMAIN: "rallyusercontent.test",
      ARTIFACT_HOSTS: env.ARTIFACT_HOSTS, PAYLOADS: env.PAYLOADS, PLATFORM_DB: env.PLATFORM_DB,
      ARTIFACT_LOADER: loader, ARTIFACT_SIDEKICKS: ctx.exports.ArtifactSidekickDispatcher({ props: {} }),
    }, ctx);
    expect(served.status).toBe(202);
    expect(await served.json()).toEqual({ runId: first.runId, reused: true });
    // The serving Worker's actual forwarder class crosses the loader and named Service Binding too.
    const worker = loader.get(`invocation:${artifactId}`, () => ({
      compatibilityDate: "2026-08-01", mainModule: LOADER_ENTRY_MODULE,
      modules: { [LOADER_ENTRY_MODULE]: LOADER_ENTRY_SOURCE, [ASSET_SHIM_MODULE]: ASSET_SHIM_SOURCE, "index.js": STATELESS_SITE },
      env: { SIDEKICKS: forwarder({ props }) }, globalOutbound: null,
    }));
    const response = await worker.getEntrypoint().fetch(new Request("https://app.test/api/items", {
      method: "POST", body: JSON.stringify({ operationId: "stateless", input: { item: "bread" } }),
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: first.runId, reused: true });
    await save(sidekickId, draft("then"));
    const thenWorker = loader.get(`invocation:${artifactId}:then`, () => ({
      compatibilityDate: "2026-08-01", mainModule: LOADER_ENTRY_MODULE,
      modules: { [LOADER_ENTRY_MODULE]: LOADER_ENTRY_SOURCE, [ASSET_SHIM_MODULE]: ASSET_SHIM_SOURCE,
        "index.js": STATELESS_SITE.replace("shoppingOrganizer", "then") },
      env: { SIDEKICKS: forwarder({ props }) }, globalOutbound: null,
    }));
    const namedThen = await thenWorker.getEntrypoint().fetch(new Request("https://app.test/api/items", {
      method: "POST", body: JSON.stringify({ operationId: "valid-then-name", input: { item: "milk" } }),
    }));
    expect(namedThen.status).toBe(202);
    expect(await namedThen.json()).toMatchObject({ reused: false });
  });

  it("binds several Sidekicks to one app and refuses duplicate names or a second app on a Sidekick", async () => {
    const second = crypto.randomUUID();
    await createAutomation(env, { workspaceId, authorUserId: author, scope: "personal", automationId: second, madeInCanvasId: canvasId });
    await save(second, draft("mealPlanner"));
    const firstRun = await workspace().artifactInvokeSidekick(invocation());
    const secondRun = await workspace().artifactInvokeSidekick(invocation({ bindingName: "mealPlanner" }));
    expect(secondRun.runId).not.toBe(firstRun.runId);
    const ids = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ sidekick_id: string }>(
      "SELECT sidekick_id FROM sidekick_runs ORDER BY sidekick_id").toArray().map((row) => row.sidekick_id));
    expect(ids).toEqual([sidekickId, second].sort());
    expect(await refusal((instance) => instance.sidekickSaveDefinition({ workspaceId, automationId: second, actor,
      draft: draft(), evaluatorRules: null, submittedByRunId: null }))).toContain("invocation.bindingName");
    const twoApps = draft();
    twoApps.triggers.push({ type: "invocation", artifactId: crypto.randomUUID(), bindingName: "anotherApp" });
    expect(await refusal((instance) => instance.sidekickSaveDefinition({ workspaceId, automationId: sidekickId, actor,
      draft: twoApps, evaluatorRules: null, submittedByRunId: null }))).toContain("triggers");
  });

  it("honors pause, unbinding, version changes, and the existing attached-Canvas gate", async () => {
    expect(await refusal((instance) => instance.artifactInvokeSidekick(invocation({ bindingName: "unknown" })))).toContain("No Sidekick");
    await workspace().sidekickPause({ workspaceId, automationId: sidekickId, actor });
    expect(await refusal((instance) => instance.artifactInvokeSidekick(invocation()))).toContain("active");
    await workspace().sidekickResume({ workspaceId, automationId: sidekickId, actor });
    expect(await refusal((instance) => instance.artifactInvokeSidekick(invocation({ artifactVersion: 2 })))).toContain("Reload");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM sidekick_conversation_attachments WHERE automation_id = ?", sidekickId);
    });
    expect(await refusal((instance) => instance.artifactInvokeSidekick(invocation()))).toContain("attached");
    await save(sidekickId, { ...draft(), triggers: [{ type: "manual" }] });
    expect(await refusal((instance) => instance.artifactInvokeSidekick(invocation()))).toContain("No Sidekick");
  });
});
