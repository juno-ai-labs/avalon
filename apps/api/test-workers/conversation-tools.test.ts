/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Sidekick's home and attached conversations, and the object methods the
 * `rally:conversations` tools stand on, through the real Durable Objects.
 *
 * SidekickDO projects its home into WorkspaceDO's directory; WorkspaceDO
 * decides a conversation tool's scope from its own directories and admits the
 * acting person through the hosted parent's `authorizeViewer`; a Channel's or
 * Breakout's own AgentLoopDO appends a post. The model-driven path (a real
 * run calling `conversation_post`) is in `automation-post-result.test.ts`; the
 * tools' argument and failure shapes are in `test/conversation-tools.test.ts`.
 * A Breakout's full access to its Channel (its Main's messages through these
 * tools, and its Main's resource links) is here too, because this suite makes
 * real Channels and Breakouts.
 */

import type { HarnessToolContext } from "@rally/agent-harness";
import { createCanvas } from "../src/services/canvas-service";
import { conversationToolPorts, createConversationsPlugin } from "../src/services/conversation-tools";
import { substreamLoopId } from "../src/durable-objects/names";
import { createAgentCommunicationPlugin } from "../src/services/agent-communication-plugin";
import { attachWorkstreamRuntimeResource } from "../src/services/workstream-object-client";
import { createWorkstreamAttachmentTools } from "../src/services/workstream-attachment-tools";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
import { TerminalSandboxCoordinator } from "../src/services/terminal/coordinator";
import { createTerminalPortFactory } from "../src/services/terminal/object-port";
import type { TerminalSandboxProvider } from "../src/services/terminal/provider-contract";
import { sha256, sha256Hex } from "../src/lib/crypto";
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  artifactAssetKey,
  asArtifactId,
  agentIdForAddress,
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type AutomationDraft,
  WorkstreamWorkflowInputSchema,
  type SubstreamId,
} from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { loadVisibleWorkstreamResourcePage, loadVisibleWorkstreamResourcesByIds } from "../src/services/workstream-resource-visibility";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { createConversationResourceLinks, createResourcePortFactory } from "../src/runtime/resource-port";
import type { Env } from "../src/env";
import { AgentCommunicationService } from "../src/services/agent-communication-service";
import { projectAuthorization } from "../src/services/authorization-projection-service";
import { validateAttachmentToolReceiptReplay } from "../src/services/attachment-tool-receipts";
import { createArtifactDataToolContext } from "../src/services/workstream-artifact-data-wiring";
import { resolveSiteForViewer } from "../src/services/artifact-site-resolution";
import { artifactHostDOName } from "../src/durable-objects/names";
import { createAutomation } from "../src/services/automation-service";
import {
  bootstrapConversationChildRuntime,
} from "../src/services/workstream-runtime-database";
import { deliverEffectsToWorkspace } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";

import { applySidekick } from "./helpers/sidekick";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { countingEnv } from "./helpers/counting-namespace";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000c0a10");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-0000000c0a11");
const COLLEAGUE_ID = asUserId("00000000-0000-7000-8000-0000000c0a12");
const SESSION_ID = "00000000-0000-7000-8000-0000000c0a13";
/** A member of the Organization who is in no Channel this suite makes. */
const OUTSIDER_ID = asUserId("00000000-0000-7000-8000-0000000c0a15");
const CHANNEL_RESOURCE_ID = "00000000-0000-7000-8000-0000000c0ae1";
const NOW = "2026-09-27T10:00:00.000Z";
const TEST_ENV: Env = env;

/** Reassigned per test so a finished test's still-draining objects are not the next test's. */
let ordinal = 0;
let ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000c0a0001");
let AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-00000c0a0003");

const DEFINITION: AutomationDraft = {
  name: "Weekly call prep",
  description: "Collects updates for the weekly call",
  overview: "Collects the founders' updates and writes the agenda.",
  instructions: "Collect updates and post the agenda to the home conversation.",
  triggers: [{ type: "manual" }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  customTools: [],
  suggestedScope: "workspace",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

useHeldEffectQueue();

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function conversation(parentId: string, substreamId: SubstreamId | "0" = "0") {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, parentId, substreamId)));
}

async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, COLLEAGUE_ID, NOW),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, automation_subscription_id, created_at, updated_at)
      VALUES (?, 'global', ?, NULL, ?, ?, ?)`)
      .bind(`prep-${ordinal}`, WORKSPACE_ID, AUTOMATION_ID, NOW, NOW),
  ]);
}

/**
 * A room: a Canvas made the way creation makes one, open to the people named
 * (or to the Organization) beside its author.
 */
async function seedRoom(
  roomId: string,
  title: string,
  participantUserIds: string[] = [AUTHOR_ID],
  scope: "personal" | "workspace" = "personal",
): Promise<void> {
  await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: AUTHOR_ID, canvasId: roomId, title });
  const others = participantUserIds.filter((userId) => userId !== AUTHOR_ID).map(asUserId);
  if (scope === "workspace" || others.length > 0) {
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: roomId,
      actor: { userId: asUserId(AUTHOR_ID), actorRole: "member" },
      update: scope === "workspace" ? { visibility: "workspace", userIds: [] } : { visibility: "participants", userIds: others } });
  }
  await deliverEffectsToWorkspace(TEST_ENV, conversation(roomId));
}

/** An Organization Sidekick, created the way authoring creates one, applied and projected. */
async function seedSidekick(_home: "0", automationId = AUTOMATION_ID): Promise<void> {
  await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workspace", automationId,
  });
  const addressed = { workspaceId: WORKSPACE_ID, automationId };
  await workspace().sidekickSubmitDefinition({ ...addressed, draft: DEFINITION, evaluatorRules: null, submittedByRunId: null });
  await applySidekick(TEST_ENV, {
    ...addressed, actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: true },
  });
}

/** Deliver canonical attachment discovery for every parent this fixture creates. */
async function projectResourceAccess() {
  await workspace().beginAuthorizationBackfill({ workspaceId: WORKSPACE_ID });
  const parents = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ parent_id: string }>(
    "SELECT workstream_id AS parent_id FROM channels UNION SELECT automation_id AS parent_id FROM automation_directory",
  ).toArray());
  for (const { parent_id: parentId } of parents) {
    const job = { type: "authorization_projection_v1" as const, region: "global" as const, workspaceId: WORKSPACE_ID, parentId };
    await projectAuthorization(TEST_ENV, job);
    const { substreamIds } = await workspace().listAuthorizationChildren({ workspaceId: WORKSPACE_ID, parentId });
    for (const substreamId of substreamIds) await projectAuthorization(TEST_ENV, { ...job, substreamId: asSubstreamId(substreamId) });
  }
  expect(await workspace().authorizationBackfillStatus({ workspaceId: WORKSPACE_ID })).toMatchObject({ complete: true });
}

beforeEach(async () => {
  ordinal += 1;
  const suffix = String(ordinal).padStart(4, "0");
  ROOM_ID = asWorkstreamId(`00000000-0000-7000-8000-${suffix}000c0a01`);
  AUTOMATION_ID = asAutomationId(`00000000-0000-7000-8000-${suffix}000c0a03`);
  await reset();
  await seedRegionalDatabase();
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  // The second member, known to the Organization the way a membership event
  // makes one known, so a Breakout can seat them.
  await workspace().applyMemberStatus({ workspaceId: WORKSPACE_ID, sequence: 1, removed: false, relationship: {
    workspaceId: WORKSPACE_ID, userId: COLLEAGUE_ID, accessClass: "member", role: "member", status: "active",
    incarnation: "existing-member", revision: 1,
  } });
  await seedRoom(ROOM_ID, "Investors", [AUTHOR_ID, COLLEAGUE_ID]);
});

describe("sidekick_attach_resource", () => {
  async function source(draft = false, visible = true) {
    const resourceId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, metadata_json,
         uploaded_by_user_id, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'document', 'avalon_upload', 'Calendar source', 'text/plain', '{}', ?, ?, ?, ?)`,
      resourceId, WORKSPACE_ID, AUTHOR_ID, draft ? "draft" : "attached", NOW, NOW);
    });
    if (visible) await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      resourceId, attachedByUserId: AUTHOR_ID });
    return resourceId;
  }
  function tool(parentId: string = ROOM_ID, parentKind: "canvas" | "automation" = "canvas") {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind, parentId, substreamId: "0", loopId: substreamLoopId(parentId),
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const plugin = createAgentCommunicationPlugin(new AgentCommunicationService(TEST_ENV, input), "");
    const attach = plugin.tools.find((candidate) => candidate.definition.name === "sidekick_attach_resource")!;
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: parentId,
      harnessRunId: input.harnessRunId, effectIntentId: crypto.randomUUID(), toolCallId: "attach-context",
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    return (sidekickId: string, resourceId: string) => attach.execute({ sidekickId, resourceId }, context);
  }
  const directLinks = () => runInDurableObject(conversation(AUTOMATION_ID), (_instance, state) =>
    state.storage.sql.exec("SELECT resource_id FROM workstream_resource_links").toArray());

  it("attaches once without a message or activation and makes the resource visible to future runs", async () => {
    await seedSidekick("0");
    const resourceId = await source();
    const attach = tool();
    await expect(attach(AUTOMATION_ID, resourceId)).resolves.toMatchObject({ output: {
      sidekickId: AUTOMATION_ID, resourceId, alreadyAttached: false,
    } });
    expect(await directLinks()).toEqual([{ resource_id: resourceId }]);
    // The wizard can attach to itself without the messaging self-address restriction.
    await expect(tool(AUTOMATION_ID, "automation")(AUTOMATION_ID, resourceId)).resolves.toMatchObject({ output: {
      sidekickId: AUTOMATION_ID, resourceId, alreadyAttached: true,
    } });
    expect(await directLinks()).toEqual([{ resource_id: resourceId }]);
    const activation = asSubstreamId(crypto.randomUUID());
    await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "automation", AUTOMATION_ID, activation);
    expect(await createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, activation,
      { type: "user", userId: AUTHOR_ID }).attachedResourceIds()).toEqual([resourceId]);
    expect(await runInDurableObject(conversation(AUTOMATION_ID), (_instance, state) => ({
      turns: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM participant_transcript_turns").one().n,
      runs: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM runs").one().n,
      inputs: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_loop_input_mailbox").one().n,
    }))).toEqual({ turns: 0, runs: 0, inputs: 0 });
  });

  it("refuses a resource absent from this conversation without changing the Sidekick", async () => {
    await seedSidekick("0");
    await expect(tool()(AUTOMATION_ID, await source(false, false)))
      .rejects.toMatchObject({ code: "sidekick_resource_unavailable" });
    expect(await directLinks()).toEqual([]);
  });

  it("uses the normal sharing checks to refuse an unsent upload", async () => {
    await seedSidekick("0");
    await expect(tool()(AUTOMATION_ID, await source(true)))
      .rejects.toMatchObject({ code: "sidekick_attachment_draft_requires_message" });
    expect(await directLinks()).toEqual([]);
  });

  it("refuses an inaccessible personal Sidekick", async () => {
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: COLLEAGUE_ID,
      scope: "personal", automationId: AUTOMATION_ID });
    await expect(tool()(AUTOMATION_ID, await source()))
      .rejects.toMatchObject({ code: "sidekick_contact_forbidden" });
    expect(await directLinks()).toEqual([]);
  });
});

describe("Sidekick resource reads by ID", () => {
  async function source(owner = AUTHOR_ID, status = "attached") {
    const id = crypto.randomUUID();
    const key = `sidekick-resource/${id}`;
    await TEST_ENV.PAYLOADS.put(key, "October calendar: publish the launch on Friday.");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'document', 'avalon_upload', 'Calendar instructions', 'text/plain', ?, '{}', ?, ?, ?, ?)`,
      id, WORKSPACE_ID, key, owner, status, NOW, NOW);
    });
    return id;
  }

  it.each(["wizard", "activation", "worker"])("lets a Sidekick %s read a known, unattached resource as its execution user", async (kind) => {
    await seedSidekick("0");
    const resourceId = await source();
    const forbiddenId = await source(COLLEAGUE_ID, "draft");
    const child = kind === "wizard" ? "0" : asSubstreamId(crypto.randomUUID());
    if (child !== "0") await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "automation", AUTOMATION_ID, child);
    if (kind === "worker") await runInDurableObject(conversation(AUTOMATION_ID, child), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO background_agent (id, execution_principal_json) VALUES (1, ?)",
        JSON.stringify({ type: "user", userId: AUTHOR_ID }));
    });
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "automation", parentId: AUTOMATION_ID, substreamId: child, loopId: "resource-read-test",
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID,
      harnessRunId: input.harnessRunId, toolCallId: "read-unattached", executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal };
    const tools = createWorkstreamAttachmentTools(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID), input);
    const read = tools.find((tool) => tool.definition.name === "read_resource")!;
    await expect(read.execute({ resourceId }, context)).resolves.toMatchObject({
      output: { text: "October calendar: publish the launch on Friday." },
    });
    for (const id of [forbiddenId, crypto.randomUUID()]) {
      await expect(read.execute({ resourceId: id }, context)).rejects.toMatchObject({ code: "resource_not_found" });
    }
    // Direct reads neither attach the resource nor expand the advertised inventory.
    const resources = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, child, input.executionPrincipal);
    expect(await resources.attachedResourceIds()).toEqual([]);
    const database = withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID).DB;
    expect((await loadVisibleWorkstreamResourcePage(database, resources, { workspaceId: WORKSPACE_ID,
      workstreamId: AUTOMATION_ID, principal: input.executionPrincipal, attachmentKind: null, limit: 25 })).rows).toEqual([]);
    // The exact same read is reauthorized after the underlying permission changes.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET uploaded_by_user_id = ?, attachment_status = 'draft' WHERE id = ?",
        COLLEAGUE_ID, resourceId);
    });
    await expect(read.execute({ resourceId }, context)).rejects.toMatchObject({ code: "resource_not_found" });
    const threadResources = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, ROOM_ID, undefined, "0", input.executionPrincipal);
    expect((await loadVisibleWorkstreamResourcesByIds(database, threadResources, { workspaceId: WORKSPACE_ID,
      workstreamId: ROOM_ID, principal: input.executionPrincipal, resourceIds: [await source()] }))).toEqual([]);
  });

  it("resolves an unattached site's stored data by its ID or alias", async () => {
    await seedSidekick("0");
    const resourceId = await source();
    const artifactId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET resource_type = 'generated_site', slug = 'calendar' WHERE id = ?", resourceId);
      state.storage.sql.exec(`INSERT INTO artifact_registry
        (artifact_id, workspace_id, resource_id, workstream_id, mode, stateful, current_version, manifest_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 1, 1, 'test-manifest', ?, ?)`,
      artifactId, WORKSPACE_ID, resourceId, ROOM_ID, Date.parse(NOW), Date.parse(NOW));
    });
    const calls: string[] = [];
    const statements: string[] = [];
    const runtime = withWorkspaceRuntimeDatabase(countingEnv(calls), WORKSPACE_ID);
    const database = new Proxy(runtime.DB, { get(target, key) {
      if (key === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const observed = new Proxy(runtime, { get: (target, key) => key === "DB" ? database : Reflect.get(target, key) });
    const context = createArtifactDataToolContext(observed, {
      workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal: { type: "user", userId: AUTHOR_ID }, reader: null,
    });
    for (const reference of [resourceId, "calendar"]) {
      calls.length = 0;
      statements.length = 0;
      await expect(context.resolveArtifact(reference)).resolves.toEqual({
        artifactId, slug: "calendar", mode: "active", stateful: true, scope: { rows: "all" },
      });
      expect(calls.filter((call) => call === "authorizationResourceFacts")).toEqual(["authorizationResourceFacts"]);
      expect(statements.filter((sql) => /FROM (resources|artifact_registry)\b/u.test(sql))).toHaveLength(reference === "calendar" ? 1 : 0);
    }
    await expect(context.resolveArtifact(crypto.randomUUID())).resolves.toBeNull();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET uploaded_by_user_id = ?, attachment_status = 'draft' WHERE id = ?",
        COLLEAGUE_ID, resourceId);
    });
    await expect(context.resolveArtifact("calendar")).resolves.toBeNull();
  });

  it("limits a member who did not publish a site to their own rows, and nobody else", async () => {
    // The author and a Sidekick read every row; a colleague who can see the
    // site reads only their own rows in its per-viewer tables. The author is
    // whoever the publishing run ran as, `uploaded_by_user_id`.
    await seedSidekick("0");
    const resourceId = await source();
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      resourceId, attachedByUserId: AUTHOR_ID });
    const artifactId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET resource_type = 'generated_site', slug = 'journal' WHERE id = ?", resourceId);
      state.storage.sql.exec(`INSERT INTO artifact_registry
        (artifact_id, workspace_id, resource_id, workstream_id, mode, stateful, current_version, manifest_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 1, 1, 'test-manifest', ?, ?)`,
      artifactId, WORKSPACE_ID, resourceId, ROOM_ID, Date.parse(NOW), Date.parse(NOW));
    });
    await projectResourceAccess();
    const scopeFor = async (reader: string | null) => (await createArtifactDataToolContext(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID), {
      workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, principal: { type: "user", userId: AUTHOR_ID }, reader,
    }).resolveArtifact(resourceId))?.scope;
    expect(await scopeFor(AUTHOR_ID)).toEqual({ rows: "all" });
    // The same reader, once someone else published the site.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET uploaded_by_user_id = ? WHERE id = ?", COLLEAGUE_ID, resourceId);
    });
    await projectResourceAccess();
    expect(await scopeFor(AUTHOR_ID)).toEqual({ rows: "viewer", viewerId: AUTHOR_ID });
    // An unattended run reads every row.
    expect(await scopeFor(null)).toEqual({ rows: "all" });
  });

  it("finds a site's organization from its hostname only for someone who can read it", async () => {
    // A protected site sends a signed-out visitor to sign in; the browser then
    // knows only the hostname. The answer names the organization and resource
    // for a reader, is 403 for someone who cannot read it, and 404 for no site.
    await seedSidekick("0");
    const resourceId = await source();
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      resourceId, attachedByUserId: AUTHOR_ID });
    await projectResourceAccess();
    const artifactId = crypto.randomUUID();
    const stub = "level-luminous-sequential-schrodinger";
    await TEST_ENV.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS artifact_hostname_routes (
      hostname_stub TEXT PRIMARY KEY, region TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(region, artifact_id))`).run();
    await TEST_ENV.PLATFORM_DB.prepare("INSERT INTO artifact_hostname_routes VALUES (?, ?, ?, ?)")
      .bind(stub, TEST_ENV.AVALON_REGION, artifactId, NOW).run();
    await TEST_ENV.ARTIFACT_HOSTS.get(TEST_ENV.ARTIFACT_HOSTS.idFromName(
      artifactHostDOName(TEST_ENV.AVALON_REGION, asArtifactId(artifactId)),
    )).recordPublish({
      artifactId, workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, resourceId, region: TEST_ENV.AVALON_REGION,
      manifest: {
        version: 1, artifactId: asArtifactId(artifactId), artifactVersion: 1, mode: "static", stateful: false,
        serverModuleSha256: null, totalBytes: 1, publishedAt: NOW,
        assets: [{ path: "index.html", contentType: "text/html; charset=utf-8", sizeBytes: 1, sha256: "0".repeat(64) }],
      },
    });

    await expect(resolveSiteForViewer(TEST_ENV, AUTHOR_ID, stub)).resolves.toEqual({ workspaceId: WORKSPACE_ID, resourceId });
    // Someone outside the Organization.
    await expect(resolveSiteForViewer(TEST_ENV, OUTSIDER_ID, stub)).rejects.toMatchObject({ status: 403, code: "site_access_denied" });
    await expect(resolveSiteForViewer(TEST_ENV, AUTHOR_ID, "no-such-site-anywhere-here")).rejects.toMatchObject({ status: 404, code: "site_not_found" });
    // A member of the Organization who is not in the site's Channel is told
    // the site exists, not that it is missing.
    await workspace().applyMemberStatus({ workspaceId: WORKSPACE_ID, sequence: 2, removed: false, relationship: {
      workspaceId: WORKSPACE_ID, userId: OUTSIDER_ID, accessClass: "member", role: "member", status: "active",
      incarnation: "outsider", revision: 1,
    } });
    await expect(resolveSiteForViewer(TEST_ENV, OUTSIDER_ID, stub)).rejects.toMatchObject({ status: 403, code: "site_access_denied" });
  });

  it("does not turn read access to an unattached resource into permission to forward it", async () => {
    await seedSidekick("0");
    const resourceId = await source();
    const principal = { type: "user" as const, userId: AUTHOR_ID };
    const database = withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID).DB;
    expect((await loadVisibleWorkstreamResourcesByIds(database,
      createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, "0", principal),
      { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal, resourceIds: [resourceId] }))
      .map((row) => row.title)).toEqual(["Calendar instructions"]);
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "automation", parentId: AUTOMATION_ID, substreamId: "0", loopId: "forward-private-resource",
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null, executionPrincipal: principal, reason: "test" });
    const service = new AgentCommunicationService(TEST_ENV, input);
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID,
      harnessRunId: input.harnessRunId, effectIntentId: crypto.randomUUID(), toolCallId: "forward-private-resource",
      executionPrincipal: principal, signal: new AbortController().signal };
    await expect(service.start({ name: "Reader", description: "Read the resource", message: "Read the attached resource",
      attachmentIds: [resourceId] }, context))
      .rejects.toMatchObject({ code: "agent_attachment_unavailable" });
    const threadAgent = agentIdForAddress({ parentKind: "canvas", parentId: ROOM_ID, substreamId: asSubstreamId("0") });
    const { teamId } = await workspace().ensureAgentTeam({ workspaceId: WORKSPACE_ID, originAgentId: service.senderId });
    await workspace().joinAgentTeam({ workspaceId: WORKSPACE_ID, teamId, agentId: threadAgent });
    await expect(service.send({ agentId: threadAgent, message: "Use this resource", attachmentIds: [resourceId] },
      { ...context, effectIntentId: crypto.randomUUID() }))
      .rejects.toMatchObject({ code: "agent_attachment_unavailable" });
    expect(await createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, ROOM_ID, undefined, "0", principal).attachedResourceIds()).toEqual([]);
    await expect(service.attachSidekickResource(AUTOMATION_ID, resourceId))
      .rejects.toMatchObject({ code: "sidekick_resource_unavailable" });
  });

  it("drops an old receipt when resource authorization is unavailable while keeping direct reads retryable", async () => {
    await seedSidekick("0");
    const resourceId = await source(COLLEAGUE_ID);
    const runId = crypto.randomUUID();
    const effectId = crypto.randomUUID();
    await runInDurableObject(conversation(AUTOMATION_ID), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
        model_iteration, next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
        idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count, input_tokens,
        output_tokens, cost_micros, output_bytes, created_at, updated_at)
        VALUES (?, '0', 'completed', '{}', 0, 0, '', 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`, runId);
      state.storage.sql.exec(`INSERT INTO tool_effects
        (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name, mode,
         request_hash, authority_revision, status, tool_call_id, input_json, output_ref)
        VALUES (?, ?, 0, 0, ?, 'read_resource', 'read', 'request', 'runtime', 'completed', 'read-call', '{}', 'receipt/output')`,
      effectId, runId, `runtime:${effectId}`);
      state.storage.sql.exec(`INSERT INTO attachment_tool_receipts
        (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at) VALUES (?, ?, ?, 'old-digest', 1)`,
      WORKSPACE_ID, resourceId, effectId);
    });
    const runtime = withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID);
    const principal = { type: "user" as const, userId: AUTHOR_ID };
    await expect(validateAttachmentToolReceiptReplay(runtime, { workspaceId: WORKSPACE_ID,
      workstreamId: AUTOMATION_ID, principal, invocationId: effectId, capability: "workstream.resources.read" }))
      .resolves.toBe("invalid");
    await expect(loadVisibleWorkstreamResourcesByIds(runtime.DB,
      createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, "0", principal),
      { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal, resourceIds: [resourceId] }))
      .rejects.toMatchObject({ code: "authorization_unavailable" });
  });

  it("conceals foreign resources and preserves a retryable authorization lookup failure", async () => {
    await seedSidekick("0");
    const foreignWorkspace = asWorkspaceId(crypto.randomUUID());
    const foreign = TEST_ENV.WORKSPACE_DOS.getByName(workspaceDOName("global", foreignWorkspace));
    await foreign.initializeWorkspace(foreignWorkspace, "wnam");
    const foreignId = crypto.randomUUID();
    await runInDurableObject(foreign, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'document', 'avalon_upload', 'Foreign calendar', '{}', ?, 'attached', ?, ?)`,
      foreignId, foreignWorkspace, AUTHOR_ID, NOW, NOW);
    });
    const principal = { type: "user" as const, userId: AUTHOR_ID };
    const resources = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, "0", principal);
    const read = (resourceId: string) => loadVisibleWorkstreamResourcesByIds(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID).DB,
      resources, { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal, resourceIds: [resourceId] });
    expect(await read(foreignId)).toEqual([]);
    // This resource may have an undiscovered sharing location. An incomplete
    // authorization lookup must stay retryable instead of reporting a denial.
    await expect(read(await source(COLLEAGUE_ID))).rejects.toMatchObject({ code: "authorization_unavailable", status: 503 });
  });
});

describe("a Breakout's access to its Channel", () => {
  /** A link in one conversation's object, as an attach writes it. */
  async function link(target: DurableObjectStub, resourceId: string, attachedAt: number): Promise<void> {
    await runInDurableObject(target, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, NULL, 0, 'generated', '{}', ?, ?)`,
        resourceId, attachedAt, attachedAt,
      );
      state.storage.sql.exec(
        `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
         ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
        attachedAt,
      );
    });
  }

  it.each(["unattached"])("imports and retains an authorized %s site until access is lost", async (kind) => {
    await seedSidekick("0");
    const artifactId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("<h1>Original calendar</h1>");
    const assets = [{ path: "index.html", contentType: "text/html", sizeBytes: bytes.length, sha256: await sha256Hex(bytes) }];
    const digest = await sha256Hex(JSON.stringify(assets.map((asset) => [asset.path, asset.sha256])));
    const manifestKey = `test-site/${artifactId}`;
    await env.PAYLOADS.put(artifactAssetKey(artifactId, 1, "index.html"), bytes);
    await env.PAYLOADS.put(manifestKey, JSON.stringify({ version: 1, artifactId, artifactVersion: 1,
      mode: "static", stateful: false, serverModuleSha256: null, assets, totalBytes: bytes.length, publishedAt: NOW }));
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
         content_ref, content_sha256, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'generated_site', 'avalon_generated', ?, 'Calendar',
        'application/vnd.rally.site-manifest+json', ?, ?, '{"sourcePath":"content-calendar"}', 'attached', ?, ?)`,
      CHANNEL_RESOURCE_ID, WORKSPACE_ID, `terminal:${ROOM_ID}:content-calendar`, manifestKey, digest, NOW, NOW);
      if (kind === "unattached") state.storage.sql.exec("UPDATE resources SET uploaded_by_user_id = ? WHERE id = ?",
        AUTHOR_ID, CHANNEL_RESOURCE_ID);
    });
    if (kind === "home") await link(conversation(ROOM_ID), CHANNEL_RESOURCE_ID, 1_000);
    const writes: string[] = [];
    const unused = async () => { throw new Error("unexpected Daytona operation"); };
    // Only Daytona is doubled: R2, resource access and durable import receipts are real.
    const provider: TerminalSandboxProvider = {
      createSandbox: unused, getSandbox: unused, startSandbox: unused, recoverSandbox: unused,
      stopSandbox: unused, archiveSandbox: unused, deleteSandbox: unused, updateNetworkPolicy: unused,
      configureGitHubReadAccess: unused, clearGitHubReadAccess: unused, readFile: unused, runCommand: unused,
      writeFile: async (_sandbox, _path, content) => { writes.push(new TextDecoder().decode(content)); },
      runUtilityCommand: async (_sandbox, input) => ({ exitCode: 0, stderr: "",
        stdout: input.operation === "resource.import.finalize" ? "1" : "" }),
    };
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID,
      harnessRunId: crypto.randomUUID(), toolCallId: "import-home-site", executionPrincipal: { type: "user", userId: AUTHOR_ID },
      signal: new AbortController().signal };
    const bridge = createTerminalResourceBridge(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID),
      createTerminalPortFactory(TEST_ENV, undefined, "0"));
    await expect(bridge.importResource(context, { resourceId: CHANNEL_RESOURCE_ID,
      destinationPath: ".rally-output/content-calendar" }, ".rally-output/content-calendar", 1, "sandbox", provider))
      .resolves.toMatchObject({ resourceId: CHANNEL_RESOURCE_ID, outcome: "created", fileCount: 1 });
    expect(writes).toEqual(["<h1>Original calendar</h1>"]);
    expect(await runInDurableObject(conversation(AUTOMATION_ID), (_instance, state) =>
      state.storage.sql.exec("SELECT resource_id FROM workstream_resource_links").toArray())).toEqual([]);
    const runtimeEnv = withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID);
    const ports = createTerminalPortFactory(TEST_ENV, undefined, "0");
    const terminal = ports(WORKSPACE_ID, AUTOMATION_ID);
    const now = Date.now();
    // Keep lifecycle alarms outside this fixture's read/revocation assertions.
    const deadlines = { idleExpiresAt: now + 600_000, archiveDueAt: now + 1_200_000, expireDueAt: now + 1_800_000 };
    await terminal.reserveFirstGeneration({ stableName: "imported-calendar", authorityFingerprint: await sha256(JSON.stringify({
      principal: `user:${AUTHOR_ID}`, repository: "scratch",
    })), networkRevision: 1, runId: context.harnessRunId, operationLeaseExpiresAt: now + 60_000, ...deadlines, now });
    await terminal.attachProviderSandbox({ generation: 1, sandboxId: "sandbox", lifecycleState: "running", ...deadlines, now });
    await terminal.releaseOperation({ runId: context.harnessRunId, now });
    const coordinator = new TerminalSandboxCoordinator(runtimeEnv, ports, createResourcePortFactory(TEST_ENV), provider);
    // The next tool call must keep a readable unattached import instead of
    // treating the lack of a local attachment as a revoked import.
    await expect(coordinator.peekRunning(context)).resolves.toMatchObject({ providerSandboxId: "sandbox", generation: 1 });
    await runInDurableObject(conversation(ROOM_ID), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM workstream_resource_links WHERE resource_id = ?", CHANNEL_RESOURCE_ID);
    });
    if (kind === "unattached") await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM resources WHERE id = ?", CHANNEL_RESOURCE_ID);
    });
    await projectResourceAccess();
    await expect(coordinator.peekRunning(context)).resolves.toBeNull();
    await expect(bridge.importResource(context, { resourceId: CHANNEL_RESOURCE_ID,
      destinationPath: ".rally-output/content-calendar" }, ".rally-output/content-calendar", 1, "sandbox", provider))
      .rejects.toMatchObject({ code: "resource_not_found" });
    expect(writes).toHaveLength(1);
  });

});

describe("a Sidekick's Canvases through the conversation tools", () => {
  const SIDE_ROOM = () => asWorkstreamId(ROOM_ID.replace(/0a01$/u, "0a04"));
  const WRITTEN = () => asWorkstreamId(ROOM_ID.replace(/0a01$/u, "0a05"));

  /** The Sidekick's configuration conversation, talking with `userId`. */
  function configuration(userId: string) {
    return WorkstreamWorkflowInputSchema.parse({
      region: "global", workspaceId: WORKSPACE_ID, parentKind: "automation", parentId: AUTOMATION_ID, substreamId: "0",
      loopId: `automation:${AUTOMATION_ID}:substream:0:loop`, harnessRunId: crypto.randomUUID(),
      triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId }, reason: "user_message",
    });
  }

  /** The real plugin over the real ports: WorkspaceDO's scope and each parent's admission. */
  function conversationTools(userId: string) {
    const input = configuration(userId);
    const plugin = createConversationsPlugin(input, conversationToolPorts(TEST_ENV, input), (tool) => [tool]);
    if (!plugin) throw new Error("conversations_plugin_missing");
    const byName = new Map(plugin.tools.map((tool) => [tool.definition.name, tool]));
    const context = (effectIntentId: string): HarnessToolContext => ({ workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID,
      harnessRunId: input.harnessRunId, toolCallId: effectIntentId, effectIntentId,
      executionPrincipal: { type: "user", userId: asUserId(userId) }, signal: new AbortController().signal });
    return { run: (name: string, args: unknown, receipt: string = crypto.randomUUID()) => byName.get(name)!.execute(args, context(receipt)) };
  }

  async function seedCanvases(): Promise<void> {
    await seedSidekick("0");
    // The author's alone: the colleague cannot open it.
    await seedRoom(SIDE_ROOM(), "Side room");
    // Made by one of the Sidekick's runs, which makes the Sidekick its writer.
    await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: AUTHOR_ID, canvasId: WRITTEN(),
      title: "Weekly agenda", writer: { sidekickId: AUTOMATION_ID, runId: crypto.randomUUID() } });
  }

  it("lists the Sidekick's own conversation, the Canvas it writes and the Canvases attached to it, as each person may open them", async () => {
    await seedCanvases();
    const author = conversationTools(AUTHOR_ID);
    expect((await author.run("attach", { conversation: ROOM_ID })).output).toMatchObject({
      conversationId: ROOM_ID, kind: "canvas", title: "Investors", alreadyAttached: false });
    // By the title the person used, among the Canvases they can open.
    expect((await author.run("attach", { conversation: "side ROOM" })).output).toMatchObject({
      conversationId: SIDE_ROOM(), kind: "canvas", alreadyAttached: false });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT parent_kind, parent_id, substream_id FROM sidekick_conversation_attachments
        WHERE automation_id = ? ORDER BY attached_at, parent_id`, AUTOMATION_ID,
    ).toArray())).toEqual([
      { parent_kind: "canvas", parent_id: ROOM_ID, substream_id: "0" },
      { parent_kind: "canvas", parent_id: SIDE_ROOM(), substream_id: "0" },
    ]);

    const listed = async (userId: string) => ((await conversationTools(userId).run("list", {})).output as {
      conversations: Array<{ conversationId: string; isOwn: boolean }> }).conversations.map((entry) => entry.conversationId);
    expect(await listed(AUTHOR_ID)).toEqual([AUTOMATION_ID, WRITTEN(), ROOM_ID, SIDE_ROOM()]);
    // `canvasAdmits` for the colleague: a participant of Investors, nobody on
    // the side room, and the run's Canvas follows the Sidekick's audience.
    expect(await listed(COLLEAGUE_ID)).toEqual([AUTOMATION_ID, WRITTEN(), ROOM_ID]);
    await expect(conversationTools(COLLEAGUE_ID).run("read", { conversation: SIDE_ROOM() }))
      .rejects.toMatchObject({ code: "conversation_access_denied" });
  });

  it("refuses to attach a Canvas the person cannot open, and never names one by a title they cannot see", async () => {
    await seedCanvases();
    const colleague = conversationTools(COLLEAGUE_ID);
    await expect(colleague.run("attach", { conversation: "Side room" })).rejects.toMatchObject({ code: "conversation_not_found" });
    await expect(colleague.run("attach", { conversation: SIDE_ROOM() })).rejects.toMatchObject({ code: "conversation_access_denied" });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT parent_id FROM sidekick_conversation_attachments WHERE automation_id = ?`, AUTOMATION_ID,
    ).toArray())).toEqual([]);
  });

  it("posts into a Canvas's Chat the Sidekick writes, once per receipt, and reads it back", async () => {
    await seedCanvases();
    const author = conversationTools(AUTHOR_ID);
    const posted = await author.run("post", { conversation: WRITTEN(), text: "The agenda is ready." }, "post-receipt");
    expect(posted.output).toMatchObject({ conversationId: WRITTEN(), replayed: false });
    expect((await author.run("post", { conversation: WRITTEN(), text: "The agenda is ready." }, "post-receipt")).output)
      .toMatchObject({ conversationId: WRITTEN(), replayed: true });
    const read = (await author.run("read", { conversation: "weekly agenda" })).output as {
      conversationId: string; messages: Array<{ text: string }> };
    expect(read.conversationId).toBe(WRITTEN());
    expect(read.messages.map((message) => message.text)).toEqual(["The agenda is ready."]);
  });
});
