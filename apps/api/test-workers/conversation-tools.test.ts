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
import { __integrationTesting } from "../src/services/integrations";
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
  AutomationRunDefinitionV1Schema,
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
import { createWorkstreamArtifactDataTools } from "../src/services/workstream-artifact-data-tools";
import { resolveSiteForViewer } from "../src/services/artifact-site-resolution";
import { artifactHostDOName } from "../src/durable-objects/names";
import { createAutomation } from "../src/services/automation-service";
import { sidekickSourceTools } from "../src/services/sidekick-source-tools";
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
  // Canonical resource reads use inventories from both hosted parent kinds.
  // A Canvas attachment must remain readable after its uploader changes too.
  const parents = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ parent_id: string }>(
    `SELECT automation_id AS parent_id FROM automation_directory
     UNION SELECT canvas_id AS parent_id FROM canvas_directory`,
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

// These cases are about who may open a private Canvas, so the Organization
// makes new Canvases private rather than taking the Organization-wide default.
beforeEach(async () => {
  await workspace().saveCanvasSharingDefaults({ workspaceId: WORKSPACE_ID, defaults: { editors: "creator" } });
});

describe("configured failure destinations", () => {
  it("validates the default execution principal even when an administrator applies the definition", async () => {
    const destinationId = asWorkstreamId(crypto.randomUUID());
    await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: COLLEAGUE_ID,
      canvasId: destinationId, title: "Administrator's private notices" });
    await workspace().applyMemberStatus({ workspaceId: WORKSPACE_ID, sequence: 2, removed: false, relationship: {
      workspaceId: WORKSPACE_ID, userId: COLLEAGUE_ID, accessClass: "member", role: "admin", status: "active",
      incarnation: "existing-member", revision: 2,
    } });
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID,
      scope: "workspace", automationId: AUTOMATION_ID });
    const addressed = { workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID };
    const actor = { userId: COLLEAGUE_ID, actorRole: "admin" as const, participantOfOwningWorkstream: false };
    expect(await workspace().attachSidekickConversation({ ...addressed, userId: COLLEAGUE_ID, reference: destinationId }))
      .toMatchObject({ ok: true });
    await workspace().sidekickSubmitDefinition({ ...addressed,
      draft: { ...DEFINITION, failureNotificationConversationId: destinationId }, evaluatorRules: null, submittedByRunId: null });
    await expect(applySidekick(TEST_ENV, { ...addressed, actor })).rejects.toThrow("failureNotificationConversationId");
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: destinationId,
      actor: { userId: actor.userId, actorRole: actor.actorRole },
      update: { visibility: "participants", userIds: [AUTHOR_ID] } });
    expect(await applySidekick(TEST_ENV, { ...addressed, actor })).toMatchObject({ lifecycle: "active" });
  });

  it("requires an authorized attachment for an Organization Sidekick's configured failure destination", async () => {
    const destinationId = asWorkstreamId(crypto.randomUUID());
    await seedRoom(destinationId, "Dashboard notices");
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID,
      scope: "workspace", automationId: AUTOMATION_ID });
    const addressed = { workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID };
    const actor = { userId: AUTHOR_ID, actorRole: "member" as const, participantOfOwningWorkstream: false };
    await workspace().sidekickSubmitDefinition({ ...addressed,
      draft: { ...DEFINITION, suggestedScope: "workspace", failureNotificationConversationId: destinationId },
      evaluatorRules: null, submittedByRunId: null });
    await expect(applySidekick(TEST_ENV, { ...addressed, actor }))
      .rejects.toThrow("failureNotificationConversationId");
    expect(await workspace().attachSidekickConversation({ ...addressed, userId: AUTHOR_ID, reference: destinationId }))
      .toMatchObject({ ok: true });
    expect(await applySidekick(TEST_ENV, { ...addressed, actor })).toMatchObject({ lifecycle: "active",
      currentDefinition: { failureNotificationConversationId: destinationId } });
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID,
      userId: AUTHOR_ID, scope: { kind: "sidekick", automationId: AUTOMATION_ID }, reference: destinationId }))
      .toMatchObject({ ok: true, conversation: { conversationId: destinationId } });
    const { runId } = await workspace().sidekickRunNow({ ...addressed, actor, idempotencyKey: "configured-destination-context" });
    const definition = AutomationRunDefinitionV1Schema.parse(await workspace().sidekickReadRunDefinition({ ...addressed, runId }));
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "automation", parentId: AUTOMATION_ID, substreamId: runId, loopId: "destination-context",
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "manual",
      automationRun: { schemaVersion: 1, automationId: AUTOMATION_ID, runId,
        definitionRevision: definition.definitionRevision, trigger: definition.trigger } });
    const context = await __integrationTesting.loadRunPromptContext(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID), input,
      { title: "Dashboard notices", objective: "Refresh the dashboard" });
    expect(context.systemPrompt).toContain(`"failureNotificationConversationId": "${destinationId}"`);
    await workspace().canvasArchive({ workspaceId: WORKSPACE_ID, canvasId: destinationId, actor: { userId: AUTHOR_ID, actorRole: "member" } });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(destinationId));
    await expect(applySidekick(TEST_ENV, { ...addressed, actor })).rejects.toThrow("failureNotificationConversationId");
  });

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

  /** A stateful site as a model writes one: an inbox the page lists and a run fills. */
  const INBOX_MODULE = `
import { DurableObject } from "cloudflare:workers";
export class SiteData extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS emails (message_id TEXT PRIMARY KEY, subject TEXT NOT NULL)");
  }
  async fetch() {
    return Response.json(this.ctx.storage.sql.exec("SELECT message_id, subject FROM emails ORDER BY message_id").toArray());
  }
}
`;

  /** Publish a stateful site owned by `canvasId`, registered the way a directory publish registers one. */
  async function statefulSite(slug: string, canvasId: string) {
    const resourceId = await source();
    const artifactId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET resource_type = 'generated_site', slug = ? WHERE id = ?", slug, resourceId);
      state.storage.sql.exec(`INSERT INTO artifact_registry
        (artifact_id, workspace_id, resource_id, workstream_id, mode, stateful, current_version, manifest_ref, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 1, 1, 'test-manifest', ?, ?)`,
      artifactId, WORKSPACE_ID, resourceId, canvasId, Date.parse(NOW), Date.parse(NOW));
    });
    await TEST_ENV.PAYLOADS.put(artifactAssetKey(artifactId, 1, "index.js"), INBOX_MODULE);
    const host = TEST_ENV.ARTIFACT_HOSTS.get(TEST_ENV.ARTIFACT_HOSTS.idFromName(
      artifactHostDOName(TEST_ENV.AVALON_REGION, asArtifactId(artifactId))));
    await host.recordPublish({
      artifactId, workspaceId: WORKSPACE_ID, workstreamId: canvasId, resourceId, region: TEST_ENV.AVALON_REGION,
      manifest: {
        version: 1, artifactId: asArtifactId(artifactId), artifactVersion: 1, mode: "active", stateful: true,
        serverModuleSha256: "a".repeat(64), totalBytes: 0, publishedAt: NOW, assets: [],
      },
    });
    /** What the site's own page lists, read through its handler. */
    const page = async () => (await host.fetchThroughFacet(new Request("https://artifact.test/"))).json();
    return { resourceId, page };
  }

  function writeTool(wiring: Parameters<typeof createArtifactDataToolContext>[1]) {
    const tool = createWorkstreamArtifactDataTools(
      createArtifactDataToolContext(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID), wiring),
    ).find((candidate) => candidate.definition.name === "write_artifact_data")!;
    return (resource: string, messageId: string) => tool.execute({
      resource, sql: "INSERT INTO emails (message_id, subject) VALUES (?, ?) ON CONFLICT(message_id) DO NOTHING",
      params: [messageId, `Subject ${messageId}`],
    }, {} as HarnessToolContext);
  }

  it("lets a Sidekick run change a site's rows only while the site's Canvas is attached to that Sidekick and open", async () => {
    await seedSidekick("0");
    const site = await statefulSite("inbox", ROOM_ID);
    // A run resolves a site as its own conversation, so the run has one, as every provisioned run does.
    const runId = asSubstreamId(crypto.randomUUID());
    await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "automation", AUTOMATION_ID, runId);
    const write = writeTool({
      workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal: { type: "user", userId: AUTHOR_ID }, reader: null,
      write: { kind: "sidekick_run", sidekickId: AUTOMATION_ID, runId },
    });
    // The run-as person can read the site, and that is not enough to write it.
    await expect(write(site.resourceId, "m1")).rejects.toMatchObject({ code: "artifact_canvas_not_attached" });
    expect(await site.page()).toEqual([]);
    // Another Sidekick's attachment to the same Canvas is not this one's.
    const other = asAutomationId(crypto.randomUUID());
    await seedSidekick("0", other);
    expect(await workspace().attachSidekickConversation({
      workspaceId: WORKSPACE_ID, automationId: other, userId: AUTHOR_ID, reference: ROOM_ID,
    })).toMatchObject({ ok: true });
    await expect(write("inbox", "m1")).rejects.toMatchObject({ code: "artifact_canvas_not_attached" });
    expect(await site.page()).toEqual([]);

    expect(await workspace().attachSidekickConversation({
      workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID, userId: AUTHOR_ID, reference: ROOM_ID,
    })).toMatchObject({ ok: true });
    await expect(write(site.resourceId, "m1")).resolves.toMatchObject({ output: { resource: site.resourceId } });
    await expect(write("inbox", "m2")).resolves.toMatchObject({ output: { resource: "inbox" } });
    expect(await site.page()).toEqual([
      { message_id: "m1", subject: "Subject m1" }, { message_id: "m2", subject: "Subject m2" },
    ]);

    await workspace().canvasArchive({ workspaceId: WORKSPACE_ID, canvasId: ROOM_ID, actor: { userId: AUTHOR_ID, actorRole: "member" } });
    await expect(write(site.resourceId, "m3")).rejects.toMatchObject({ code: "canvas_archived" });
    expect(await site.page()).toHaveLength(2);
  });

  it("writes a site's rows as the Sidekick itself when nobody is behind the run, and not for a run whose asker cannot open the Canvas", async () => {
    await seedSidekick("0");
    // The author's alone: the colleague cannot open it.
    const privateRoom = asWorkstreamId(crypto.randomUUID());
    await seedRoom(privateRoom, "Private");
    const site = await statefulSite("private-inbox", privateRoom);
    // A publish links the site to its Canvas, which is how a run with no person finds it: through the attachment.
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: privateRoom,
      resourceId: site.resourceId, attachedByUserId: AUTHOR_ID });
    expect(await workspace().attachSidekickConversation({
      workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID, userId: AUTHOR_ID, reference: privateRoom,
    })).toMatchObject({ ok: true });
    // One run the Sidekick started for itself, and one the colleague asked for under their own access.
    const [own, asked] = [asSubstreamId(crypto.randomUUID()), asSubstreamId(crypto.randomUUID())];
    for (const runId of [own, asked]) await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "automation", AUTOMATION_ID, runId);
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const [runId, requester] of [[own, null], [asked, COLLEAGUE_ID]] as const) {
        const trigger = requester === null
          ? { kind: "schedule", scheduleId: crypto.randomUUID(), scheduleKind: "interval", plannedFor: 1 }
          : { kind: "manual", requestedByUserId: requester };
        state.storage.sql.exec(`INSERT INTO sidekick_runs(sidekick_id, run_id, occurrence_key, trigger_json, definition_revision,
            harness_run_id, state, run_as_user_id, coordinator_user_id, requester_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, 'running', ?, ?, ?, 1, 1)`,
        AUTOMATION_ID, runId, `run:${runId}`, JSON.stringify(trigger), `${runId}-harness`, requester, requester, requester);
      }
    });
    // The colleague's own access is read from the authorization projection, so it has to have run.
    await projectResourceAccess();
    const write = (runId: string, principal: Parameters<typeof createArtifactDataToolContext>[1]["principal"]) => writeTool({
      workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal, reader: null,
      write: { kind: "sidekick_run", sidekickId: AUTOMATION_ID, runId },
    });
    // No person at all: the Organization's principal, and the attachment is the leave to write.
    await expect(write(own, { type: "workspace", workspaceId: WORKSPACE_ID })(site.resourceId, "m1"))
      .resolves.toMatchObject({ output: { resource: site.resourceId } });
    // The colleague cannot open the Canvas, so their own ask cannot write it through the Sidekick.
    await expect(write(asked, { type: "user", userId: COLLEAGUE_ID })(site.resourceId, "m2"))
      .rejects.toMatchObject({ code: "resource_not_found" });
    expect(await site.page()).toEqual([{ message_id: "m1", subject: "Subject m1" }]);
  });

  it("lets a Sidekick's wizard change an attached Canvas's site only as a person who can open that Canvas", async () => {
    await seedSidekick("0");
    // The author's alone: the colleague cannot open it.
    const privateRoom = asWorkstreamId(crypto.randomUUID());
    await seedRoom(privateRoom, "Private");
    const site = await statefulSite("wizard-inbox", privateRoom);
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: privateRoom,
      resourceId: site.resourceId, attachedByUserId: AUTHOR_ID });
    // Linked into a Canvas the colleague can open, the site is readable to them; its own Canvas still is not.
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      resourceId: site.resourceId, attachedByUserId: AUTHOR_ID });
    await projectResourceAccess();
    const wizard = (userId: typeof AUTHOR_ID) => writeTool({
      workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal: { type: "user", userId }, reader: userId,
      write: { kind: "sidekick_wizard", sidekickId: AUTOMATION_ID },
    });
    // The author can read the site, and that is not enough before the Canvas is attached.
    await expect(wizard(AUTHOR_ID)(site.resourceId, "m1")).rejects.toMatchObject({ code: "artifact_canvas_not_attached" });
    expect(await site.page()).toEqual([]);

    expect(await workspace().attachSidekickConversation({
      workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID, userId: AUTHOR_ID, reference: privateRoom,
    })).toMatchObject({ ok: true });
    await expect(wizard(AUTHOR_ID)(site.resourceId, "m1")).resolves.toMatchObject({ output: { resource: site.resourceId } });
    // A wizard turn by someone who cannot open the Canvas writes nothing through the attachment.
    await expect(wizard(COLLEAGUE_ID)(site.resourceId, "m2")).rejects.toMatchObject({ code: "resource_not_found" });
    expect(await site.page()).toEqual([{ message_id: "m1", subject: "Subject m1" }]);
  });

  it("lets a Canvas's Chat change the rows of a site linked to that Canvas, and of no other site", async () => {
    const linked = await statefulSite("linked-inbox", ROOM_ID);
    // The same author's site in another Canvas: readable by them, not linked here.
    const elsewhere = asWorkstreamId(crypto.randomUUID());
    await seedRoom(elsewhere, "Elsewhere");
    const foreign = await statefulSite("foreign-inbox", elsewhere);
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      resourceId: linked.resourceId, attachedByUserId: AUTHOR_ID });
    const write = writeTool({
      workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, principal: { type: "user", userId: AUTHOR_ID }, reader: AUTHOR_ID,
      write: { kind: "canvas_chat", canvasId: ROOM_ID },
    });
    await expect(write(linked.resourceId, "m1")).resolves.toMatchObject({ output: { resource: linked.resourceId } });
    expect(await linked.page()).toEqual([{ message_id: "m1", subject: "Subject m1" }]);
    for (const reference of [foreign.resourceId, "foreign-inbox"]) {
      await expect(write(reference, "m1")).rejects.toMatchObject({ code: "resource_not_found" });
    }
    expect(await foreign.page()).toEqual([]);
    // Attached here as context, the other Canvas's site is readable in this
    // Chat and still not this Canvas's to change.
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      resourceId: foreign.resourceId, attachedByUserId: AUTHOR_ID });
    for (const reference of [foreign.resourceId, "foreign-inbox"]) {
      await expect(write(reference, "m1")).rejects.toMatchObject({ code: "artifact_in_another_canvas" });
    }
    expect(await foreign.page()).toEqual([]);
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
    // A member of the Organization who cannot read the site's Canvas is told
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
    // A Canvas's one shared sandbox, whoever is acting in it.
    await terminal.reserveFirstGeneration({ stableName: "imported-calendar", authorityFingerprint: await sha256(JSON.stringify({
      principal: `canvas:${AUTOMATION_ID}`, repository: "scratch",
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

  /** The Sidekick's configuration conversation, talking with `userId`, in a wizard turn unless `wizard` is false. */
  function configuration(userId: string, wizard = true) {
    return WorkstreamWorkflowInputSchema.parse({
      region: "global", workspaceId: WORKSPACE_ID, parentKind: "automation", parentId: AUTOMATION_ID, substreamId: "0",
      loopId: `automation:${AUTOMATION_ID}:substream:0:loop`, harnessRunId: crypto.randomUUID(),
      triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId }, reason: "user_message",
      // A wizard turn, as the claim marks one only for a manager.
      ...(wizard ? { sidekickWizard: true } : {}),
    });
  }

  /** The real plugin over the real ports: WorkspaceDO's scope and each parent's admission. */
  function conversationTools(userId: string, wizard = true) {
    const input = configuration(userId, wizard);
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
      // The run's own Canvas was attached as it was made.
      { parent_kind: "canvas", parent_id: WRITTEN(), substream_id: "0" },
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
    // By its title the colleague reaches nothing, and is told nothing about
    // the Canvas they cannot open: not that it exists, nor its id.
    const byTitle = await conversationTools(COLLEAGUE_ID).run("read", { conversation: "Side room" })
      .then(() => null, (error: unknown) => error as { code: string; details: unknown });
    expect(byTitle).toMatchObject({ code: "conversation_not_in_scope", details: { available: [AUTOMATION_ID, WRITTEN(), ROOM_ID] } });
    expect(JSON.stringify(byTitle?.details)).not.toContain(SIDE_ROOM());
  });

  it("gives a turn in the configuration conversation that is not a manager's wizard turn neither attach nor post", async () => {
    await seedCanvases();
    // However such a turn was reached, the plugin is not there to call.
    const input = configuration(COLLEAGUE_ID, false);
    expect(createConversationsPlugin(input, conversationToolPorts(TEST_ENV, input), (tool) => [tool])).toBeNull();
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT parent_id FROM sidekick_conversation_attachments WHERE automation_id = ?`, AUTOMATION_ID,
    ).toArray())).toEqual([{ parent_id: WRITTEN() }]);
  });

  it("refuses to attach a Canvas the person cannot open, and never names one by a title they cannot see", async () => {
    await seedCanvases();
    const colleague = conversationTools(COLLEAGUE_ID);
    await expect(colleague.run("attach", { conversation: "Side room" })).rejects.toMatchObject({ code: "conversation_not_found" });
    await expect(colleague.run("attach", { conversation: SIDE_ROOM() })).rejects.toMatchObject({ code: "conversation_access_denied" });
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      `SELECT parent_id FROM sidekick_conversation_attachments WHERE automation_id = ?`, AUTOMATION_ID,
    ).toArray())).toEqual([{ parent_id: WRITTEN() }]);
  });

  it("lets a run nobody asked for reach every attached Canvas, and holds a run somebody asked for to what that person can open", async () => {
    await seedCanvases();
    await conversationTools(AUTHOR_ID).run("attach", { conversation: SIDE_ROOM() });
    // One run the Sidekick started for itself (an event, nobody behind it), and one the colleague asked for.
    const [own, asked] = [crypto.randomUUID(), crypto.randomUUID()];
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const [runId, requester] of [[own, null], [asked, COLLEAGUE_ID]] as const) {
        const trigger = requester === null
          ? { kind: "schedule", scheduleId: crypto.randomUUID(), scheduleKind: "interval", plannedFor: 1 }
          : { kind: "manual", requestedByUserId: requester };
        state.storage.sql.exec(`INSERT INTO sidekick_runs(sidekick_id, run_id, occurrence_key, trigger_json, definition_revision,
            harness_run_id, state, run_as_user_id, coordinator_user_id, requester_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, 'running', ?, ?, ?, 1, 1)`,
        AUTOMATION_ID, runId, `run:${runId}`, JSON.stringify(trigger), `${runId}-harness`, requester, requester, requester);
      }
    });
    const scope = { kind: "sidekick" as const, automationId: AUTOMATION_ID };
    const reached = async (runId: string, userId: string | null) => (await workspace().conversationToolScope({
      workspaceId: WORKSPACE_ID, userId, runId, scope })).conversations.map((entry) => entry.conversationId);
    const named = (runId: string, userId: string | null) => workspace().resolveConversationToolTarget({
      workspaceId: WORKSPACE_ID, userId, runId, scope, reference: SIDE_ROOM() });

    // The attachment is the reach: nobody acts, and the side room nobody but the author can open is there.
    expect(await reached(own, null)).toEqual([AUTOMATION_ID, WRITTEN(), SIDE_ROOM()]);
    // A delegate who cannot open the side room does not take it away from the run.
    expect(await reached(own, COLLEAGUE_ID)).toEqual([AUTOMATION_ID, WRITTEN(), SIDE_ROOM()]);
    expect(await named(own, null)).toMatchObject({ ok: true, conversation: { parentId: SIDE_ROOM() } });
    // The colleague's own ask reads nothing through the Sidekick that they cannot open themselves.
    expect(await reached(asked, COLLEAGUE_ID)).toEqual([AUTOMATION_ID, WRITTEN()]);
    expect(await named(asked, COLLEAGUE_ID)).toMatchObject({ ok: false, code: "conversation_access_denied" });

    // Archiving is what ends the Sidekick's own reach.
    await workspace().canvasArchive({ workspaceId: WORKSPACE_ID, canvasId: SIDE_ROOM(), actor: { userId: AUTHOR_ID, actorRole: "member" } });
    expect(await reached(own, null)).toEqual([AUTOMATION_ID, WRITTEN()]);
    expect(await named(own, null)).toMatchObject({ ok: false, code: "conversation_archived" });
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

describe("a Sidekick's source request asked from a Canvas's Chat", () => {
  it("is drawn in the Chat whose message started the wizard's turn, once per receipt", async () => {
    await seedSidekick("0");
    // This suite's D1 starts with no schema: a request's view reads each person's presentation.
    await TEST_ENV.DB.exec("ALTER TABLE users ADD COLUMN presentation_json TEXT");
    const chatAgent = agentIdForAddress({ parentKind: "canvas", parentId: ROOM_ID, substreamId: asSubstreamId("0") });
    // The wizard's turn the Chat's message started, acting for the person the Chat acts for.
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID, parentKind: "automation",
      parentId: AUTOMATION_ID, substreamId: "0", loopId: substreamLoopId(AUTOMATION_ID), harnessRunId: crypto.randomUUID(),
      triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test",
      sidekickWizard: true, agentExchange: { teamId: chatAgent, senderAgentId: chatAgent, messageId: crypto.randomUUID() } });
    const tool = sidekickSourceTools(TEST_ENV, input, AUTHOR_ID, false).find((candidate) => candidate.definition.name === "request_source")!;
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, harnessRunId: input.harnessRunId,
      effectIntentId: crypto.randomUUID(), toolCallId: "ask-colleague", executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal };
    const asking = () => tool.execute({ sidekickId: AUTOMATION_ID, userIds: [COLLEAGUE_ID], connectorType: "google",
      eventTypes: ["email.received"] }, context);
    const requestId = ((await asking()).output as { requests: { requestId: string }[] }).requests[0]!.requestId;
    // A retried call is the same receipt: one request, one post.
    await asking();

    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ kind: string; id: string }>(
      "SELECT place_parent_kind AS kind, place_parent_id AS id FROM sidekick_source_requests WHERE sidekick_id = ?", AUTOMATION_ID,
    ).toArray())).toEqual([{ kind: "canvas", id: ROOM_ID }]);
    const posts = await runInDurableObject(conversation(ROOM_ID), (_instance, state) => state.storage.sql.exec<{ json: string }>(
      "SELECT structured_content_json AS json FROM canonical_conversation_turn_details WHERE message_type = 'automation_activation'",
    ).toArray().map((row) => JSON.parse(row.json) as { automationId: string; sourceRequests?: unknown }));
    expect(posts.map((post) => ({ automationId: post.automationId, sourceRequests: post.sourceRequests })))
      .toEqual([{ automationId: AUTOMATION_ID, sourceRequests: { requestIds: [requestId] } }]);
  });

  it("is drawn in the Sidekick's shared conversation when one of its wizard's background agents asks", async () => {
    await seedSidekick("0");
    await TEST_ENV.DB.exec("ALTER TABLE users ADD COLUMN presentation_json TEXT");
    const agentSubstream = crypto.randomUUID();
    // A background agent the wizard started, acting for the wizard's person.
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID, parentKind: "automation",
      parentId: AUTOMATION_ID, substreamId: agentSubstream, loopId: `workstream:${AUTOMATION_ID}:substream:${agentSubstream}:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "agent_message",
      backgroundAgent: true, backgroundAgentRootSubstreamId: "0" });
    const tool = sidekickSourceTools(TEST_ENV, input, AUTHOR_ID, false).find((candidate) => candidate.definition.name === "request_source")!;
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, harnessRunId: input.harnessRunId,
      effectIntentId: crypto.randomUUID(), toolCallId: "ask-from-wizard-agent", executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal };
    const requestId = ((await tool.execute({ sidekickId: AUTOMATION_ID, userIds: [COLLEAGUE_ID], connectorType: "google",
      eventTypes: ["email.received"] }, context)).output as { requests: { requestId: string }[] }).requests[0]!.requestId;

    const posts = await runInDurableObject(conversation(AUTOMATION_ID), (_instance, state) => state.storage.sql.exec<{ json: string }>(
      "SELECT structured_content_json AS json FROM canonical_conversation_turn_details WHERE message_type = 'automation_activation'",
    ).toArray().map((row) => JSON.parse(row.json) as { sourceRequests?: unknown }).filter((post) => post.sourceRequests));
    expect(posts.map((post) => post.sourceRequests)).toEqual([{ requestIds: [requestId] }]);
  });

  it("is drawn in the Chat when one of the Chat's background agents asks, since the person reads the Chat and not the agent", async () => {
    await seedSidekick("0");
    await TEST_ENV.DB.exec("ALTER TABLE users ADD COLUMN presentation_json TEXT");
    const agentSubstream = crypto.randomUUID();
    // A background agent the Chat started, acting for the Chat's person.
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID, parentKind: "canvas",
      parentId: ROOM_ID, substreamId: agentSubstream, loopId: `workstream:${ROOM_ID}:substream:${agentSubstream}:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "agent_message",
      backgroundAgent: true, backgroundAgentRootSubstreamId: "0" });
    const tool = sidekickSourceTools(TEST_ENV, input, AUTHOR_ID, false).find((candidate) => candidate.definition.name === "request_source")!;
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: input.harnessRunId,
      effectIntentId: crypto.randomUUID(), toolCallId: "ask-from-agent", executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal };
    const requestId = ((await tool.execute({ sidekickId: AUTOMATION_ID, userIds: [COLLEAGUE_ID], connectorType: "google",
      eventTypes: ["email.received"] }, context)).output as { requests: { requestId: string }[] }).requests[0]!.requestId;

    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ kind: string; id: string }>(
      "SELECT place_parent_kind AS kind, place_parent_id AS id FROM sidekick_source_requests WHERE sidekick_id = ?", AUTOMATION_ID,
    ).toArray())).toEqual([{ kind: "canvas", id: ROOM_ID }]);
    const posts = await runInDurableObject(conversation(ROOM_ID), (_instance, state) => state.storage.sql.exec<{ json: string }>(
      "SELECT structured_content_json AS json FROM canonical_conversation_turn_details WHERE message_type = 'automation_activation'",
    ).toArray().map((row) => JSON.parse(row.json) as { automationId: string; sourceRequests?: unknown }));
    expect(posts.map((post) => ({ automationId: post.automationId, sourceRequests: post.sourceRequests })))
      .toEqual([{ automationId: AUTOMATION_ID, sourceRequests: { requestIds: [requestId] } }]);
  });
});
