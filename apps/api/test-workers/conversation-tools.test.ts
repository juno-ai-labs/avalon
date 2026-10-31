/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Sidekick's home and attached conversations, and the object methods the
 * `rally:conversations` tools stand on, through the real Durable Objects.
 *
 * SidekickDO projects its home into WorkspaceDO's directory; WorkspaceDO
 * decides a conversation tool's scope from its own directories and admits the
 * acting person through the hosted parent's `authorizeViewer`; a Channel's or
 * Breakout's own SubstreamAgent appends a post. The model-driven path (a real
 * run calling `conversation_post`) is in `automation-post-result.test.ts`; the
 * tools' argument and failure shapes are in `test/conversation-tools.test.ts`.
 * A Breakout's full access to its Channel (its Main's messages through these
 * tools, and its Main's resource links) is here too, because this suite makes
 * real Channels and Breakouts.
 */

import type { HarnessToolContext } from "@rally/agent-harness";
import { createAgentCommunicationPlugin } from "../src/services/agent-communication-plugin";
import { attachWorkstreamRuntimeResource } from "../src/services/workstream-object-client";
import { createAvalonTerminalPlugin } from "../src/services/terminal/plugin";
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
import { resolveTerminalPublicationHome } from "../src/services/terminal/authority";
import { loadVisibleWorkstreamResourcePage, loadVisibleWorkstreamResourcesByIds } from "../src/services/workstream-resource-visibility";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { createConversationResourceLinks, createResourcePortFactory } from "../src/runtime/resource-port";
import type { AuthContext, Env } from "../src/env";
import { AgentCommunicationService } from "../src/services/agent-communication-service";
import { AuthorizationService } from "../src/services/authorization-service";
import { projectAuthorization } from "../src/services/authorization-projection-service";
import { validateAttachmentToolReceiptReplay } from "../src/services/attachment-tool-receipts";
import { createArtifactDataToolContext } from "../src/services/workstream-artifact-data-wiring";
import { ConversationMergeService } from "../src/services/conversation-merge-service";
import { createAutomation } from "../src/services/automation-service";
import {
  bootstrapConversationChildRuntime,
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { consumeEffectBodies, deliverChildEffects, deliverEffectsToWorkspace, pendingChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { listVisiblePrivateChildren, withHostedParent } from "./helpers/hosted-parent";
import { applySidekick, sidekickWorkspace } from "./helpers/sidekick";
import { post, seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { placeMembership, removeMembership } from "./helpers/space-membership";
import { countingEnv } from "./helpers/counting-namespace";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000c0a10");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-0000000c0a11");
const COLLEAGUE_ID = asUserId("00000000-0000-7000-8000-0000000c0a12");
const SESSION_ID = "00000000-0000-7000-8000-0000000c0a13";
const GUEST_ID = asUserId("00000000-0000-7000-8000-0000000c0a14");
/** A member of the Organization who is in no Channel this suite makes. */
const OUTSIDER_ID = asUserId("00000000-0000-7000-8000-0000000c0a15");
const CHANNEL_RESOURCE_ID = "00000000-0000-7000-8000-0000000c0ae1";
const BREAKOUT_RESOURCE_ID = "00000000-0000-7000-8000-0000000c0ae2";
const NOW = "2026-09-27T10:00:00.000Z";
const TEST_ENV: Env = env;

const AUTH: AuthContext = {
  sessionId: SESSION_ID, userId: AUTHOR_ID, workspaceId: WORKSPACE_ID, region: "global", role: "member",
};

/** Reassigned per test so a finished test's still-draining objects are not the next test's. */
let ordinal = 0;
let ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000c0a0001");
let OTHER_ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000c0a0002");
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
  suggestedScope: "workstream",
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

/** A personal room with only the author in it, made the way creation makes one. */
async function seedRoom(
  roomId: string,
  title: string,
  participantUserIds: string[] = [AUTHOR_ID],
  scope: "personal" | "workspace" = "personal",
): Promise<void> {
  await workspace().reserveChild({
    workspaceId: WORKSPACE_ID, parentId: roomId, substreamId: asSubstreamId("0"), kind: "main",
    createdByUserId: AUTHOR_ID, authorityGeneration: 1,
    directory: { title, description: "", scope, systemKind: null, emailAddress: null,
      titleStatus: "settled", createdAt: NOW },
  });
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, roomId, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: roomId, title, objective: "", scope,
    createdByUserId: AUTHOR_ID, participantUserIds, harnessStatus: "idle", titleStatus: "settled",
    emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
  });
  await deliverEffectsToWorkspace(TEST_ENV, conversation(roomId));
}

/** A ready private Breakout of the room with only the author in it, as creation makes one. */
async function seedBreakout(title: string, roomId = ROOM_ID): Promise<SubstreamId> {
  const parent = workspace();
  const operationId = crypto.randomUUID();
  const recipe = {
    policy: { revision: "test-empty-v1", strategy: { id: "empty", version: 1 }, config: {} },
    capture: "none" as const,
    parts: [],
  };
  const reserved = await parent.beginPrivateChildPreparation({
    workspaceId: WORKSPACE_ID, parentId: roomId, operationId, creatorUserId: AUTHOR_ID, title,
    sourceSubstreamId: "0" as const, sourceThroughTurnId: null, recipe,
    membershipInitializer: { plugin: { id: "creator-only", version: 1 }, config: {}, memberUserIds: [AUTHOR_ID] },
  });
  const hash = "0".repeat(64);
  await parent.savePreparedPrivateChildContext({
    workspaceId: WORKSPACE_ID, parentId: roomId, operationId,
    preparedContext: { schemaVersion: 1, recipe, recipeHash: hash, capture: null, captureHash: null, parts: [], contentHash: hash },
  });
  await parent.claimPrivateChildConfirmation({ workspaceId: WORKSPACE_ID, parentId: roomId, operationId, actorUserId: AUTHOR_ID });
  await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "workstream", roomId, reserved.substreamId);
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: roomId, substreamId: reserved.substreamId,
    title, objective: "", scope: "personal", createdByUserId: AUTHOR_ID,
    participantUserIds: [AUTHOR_ID], harnessStatus: "idle", titleStatus: "settled", emailAddress: null,
    emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
  });
  await conversation(roomId, reserved.substreamId).installPreparedSubstreamContext({
    workspaceId: WORKSPACE_ID, workstreamId: roomId, substreamId: reserved.substreamId, operationId,
  });
  await parent.setPrivateChildTerminalStatus({
    workspaceId: WORKSPACE_ID, parentId: roomId, operationId, status: "ready", errorCode: null,
  });
  await deliverEffectsToWorkspace(TEST_ENV, conversation(roomId, reserved.substreamId));
  return reserved.substreamId;
}

/** A room Sidekick whose home is `home`, created the way authoring creates one, applied and projected. */
async function seedSidekick(home: SubstreamId | "0", automationId = AUTOMATION_ID): Promise<void> {
  await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workstream",
    owningWorkstreamId: ROOM_ID, owningSubstreamId: home, automationId,
  });
  const addressed = { workspaceId: WORKSPACE_ID, automationId };
  await workspace().sidekickSubmitDefinition({ ...addressed, draft: DEFINITION, evaluatorRules: null, submittedByRunId: null });
  await applySidekick(TEST_ENV, {
    ...addressed, actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: true },
  });
}

const sidekickScope = () => ({ kind: "sidekick" as const, automationId: AUTOMATION_ID });

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
  OTHER_ROOM_ID = asWorkstreamId(`00000000-0000-7000-8000-${suffix}000c0a02`);
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

describe("conversations in the current thread's Channels", () => {
  async function channel(name: string, threads: typeof ROOM_ID[]) {
    const result = await workspace().reserveSpace({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      space: { name, iconKey: "briefcase", colorKey: "blue", scope: "workspace" } });
    if (!result.ok) throw new Error(`reserveSpace refused: ${result.code}`);
    for (const workstreamId of threads) {
      await placeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
        spaceId: result.space.id, workstreamId });
    }
    return result.space.id;
  }

  const scope = (substreamId: SubstreamId | "0" = "0") => ({ kind: "conversation" as const,
    parentId: ROOM_ID, substreamId });
  const list = (substreamId: SubstreamId | "0" = "0", userId = AUTHOR_ID) => workspace().conversationToolScope({
    workspaceId: WORKSPACE_ID, userId, scope: scope(substreamId),
  });
  const resolve = (reference: string, substreamId: SubstreamId | "0" = "0", userId = AUTHOR_ID) =>
    workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId, scope: scope(substreamId), reference });

  it("reaches every thread and breakout across its Channels once, without following a sibling into another Channel", async () => {
    const second = asWorkstreamId("00000000-0000-7000-8000-0000000c0af1");
    const outside = asWorkstreamId("00000000-0000-7000-8000-0000000c0af2");
    await seedRoom(OTHER_ROOM_ID, "Founders");
    await seedRoom(second, "Planning");
    await seedRoom(outside, "Elsewhere");
    const ownBreakout = await seedBreakout("Own side work");
    const peerBreakout = await seedBreakout("Peer side work", OTHER_ROOM_ID);
    const firstChannel = await channel("First", [ROOM_ID, OTHER_ROOM_ID]);
    const secondChannel = await channel("Second", [ROOM_ID, OTHER_ROOM_ID, second]);
    await channel("Outside", [OTHER_ROOM_ID, outside]);

    for (const substreamId of ["0", ownBreakout] as const) {
      const listed = (await list(substreamId)).conversations;
      const parentsFirst = substreamId === "0" ? [ROOM_ID, firstChannel, secondChannel]
        : [`${ROOM_ID}/${ownBreakout}`, ROOM_ID, firstChannel, secondChannel];
      expect(listed.slice(0, parentsFirst.length).map((entry) => entry.conversationId)).toEqual(parentsFirst);
      const entries = listed.filter((entry) => entry.kind !== "space");
      expect(entries.map((entry) => entry.conversationId).sort()).toEqual([
        ROOM_ID, `${ROOM_ID}/${ownBreakout}`, OTHER_ROOM_ID, `${OTHER_ROOM_ID}/${peerBreakout}`, second,
      ].sort());
      expect(entries.find((entry) => entry.isOwn)?.substreamId).toBe(substreamId);
      expect(entries.find((entry) => entry.conversationId === `${OTHER_ROOM_ID}/${peerBreakout}`))
        .toMatchObject({ isOwn: false, isParent: false });
      for (const [reference, conversationId] of [[OTHER_ROOM_ID, OTHER_ROOM_ID], ["Founders", OTHER_ROOM_ID],
        [`${OTHER_ROOM_ID}/${peerBreakout}`, `${OTHER_ROOM_ID}/${peerBreakout}`],
        ["Peer side work", `${OTHER_ROOM_ID}/${peerBreakout}`], [second, second]] as const) {
        expect(await resolve(reference, substreamId)).toMatchObject({ ok: true, conversation: { conversationId } });
      }
      expect(await resolve(outside, substreamId)).toMatchObject({ ok: false, code: "conversation_not_in_scope" });
    }
  });

  it("rechecks conversation access, archives and current placement on each call", async () => {
    await seedRoom(OTHER_ROOM_ID, "Founders", [AUTHOR_ID, COLLEAGUE_ID]);
    const breakout = await seedBreakout("Private side work", OTHER_ROOM_ID);
    const shared = await channel("Shared", [ROOM_ID, OTHER_ROOM_ID]);
    await channel("Other home", [OTHER_ROOM_ID]);

    expect((await list("0", COLLEAGUE_ID)).conversations.map((entry) => entry.conversationId))
      .toEqual([ROOM_ID, shared, OTHER_ROOM_ID]);
    expect(await resolve(`${OTHER_ROOM_ID}/${breakout}`, "0", COLLEAGUE_ID))
      .toMatchObject({ ok: false, code: "conversation_access_denied" });
    expect(await resolve("Private side work", "0", COLLEAGUE_ID))
      .toMatchObject({ ok: false, code: "conversation_not_in_scope", resourceId: null });
    expect(await resolve(`${OTHER_ROOM_ID}/${breakout}`)).toMatchObject({ ok: true });
    await workspace().setPrivateChildArchived({ workspaceId: WORKSPACE_ID, parentId: OTHER_ROOM_ID,
      substreamId: breakout, actorUserId: AUTHOR_ID, archived: true });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(OTHER_ROOM_ID, breakout));
    expect((await list()).conversations.map((entry) => entry.conversationId))
      .toEqual([ROOM_ID, shared, OTHER_ROOM_ID]);
    expect(await resolve(`${OTHER_ROOM_ID}/${breakout}`)).toMatchObject({ ok: false, code: "conversation_archived" });

    await removeMembership(workspace(), { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      spaceId: shared, workstreamId: OTHER_ROOM_ID });
    expect((await list()).conversations.map((entry) => entry.conversationId)).toEqual([ROOM_ID, shared]);
    expect(await resolve(OTHER_ROOM_ID)).toMatchObject({ ok: false, code: "conversation_not_in_scope" });
  });

  it("does not disclose private peers when resolving a duplicate title or a private Channel", async () => {
    await seedRoom(OTHER_ROOM_ID, "Investors");
    const breakout = await seedBreakout("Investors", OTHER_ROOM_ID);
    const shared = await channel("Shared", [ROOM_ID, OTHER_ROOM_ID]);

    expect(await resolve("Investors", "0", COLLEAGUE_ID))
      .toMatchObject({ ok: true, conversation: { conversationId: ROOM_ID } });
    expect(await resolve("Investors")).toMatchObject({ ok: false, code: "conversation_ambiguous",
      available: [ROOM_ID, OTHER_ROOM_ID, `${OTHER_ROOM_ID}/${breakout}`] });
    expect(await resolve(OTHER_ROOM_ID, "0", COLLEAGUE_ID))
      .toMatchObject({ ok: false, code: "conversation_access_denied" });
    await workspace().noteSpaceAudience({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, spaceId: shared,
      audience: { scope: "personal", participantUserIds: [AUTHOR_ID] } });
    // The colleague still reads the current thread, but the private Channel
    // no longer supplies peers to that thread's tools.
    expect((await list("0", COLLEAGUE_ID)).conversations.map((entry) => entry.conversationId)).toEqual([ROOM_ID]);
    expect(await resolve(OTHER_ROOM_ID, "0", COLLEAGUE_ID))
      .toMatchObject({ ok: false, code: "conversation_not_in_scope" });
  });

  it.each([
    "00000000-0000-7000-8000-0000000c0af3",
    "00000000-0000-7000-8000-0000000c0af4/00000000-0000-7000-8000-0000000c0af5",
  ])("keeps a private peer with UUID-shaped title %s opaque, including when archived", async (title) => {
    await seedRoom(OTHER_ROOM_ID, title);
    const shared = await channel("Shared", [ROOM_ID, OTHER_ROOM_ID]);
    expect(await resolve(title, "0", COLLEAGUE_ID)).toEqual({
      ok: false, code: "conversation_not_in_scope", resourceId: null, available: [ROOM_ID, shared],
    });
    // A normalized id really naming the peer keeps the specific refusal.
    expect(await resolve(OTHER_ROOM_ID.toUpperCase(), "0", COLLEAGUE_ID))
      .toMatchObject({ ok: false, code: "conversation_access_denied", resourceId: OTHER_ROOM_ID });
    expect((await post(conversation(OTHER_ROOM_ID), "/internal/product", {
      operation: "update", auth: AUTH, input: { archived: true },
    })).status).toBe(200);
    await deliverEffectsToWorkspace(TEST_ENV, conversation(OTHER_ROOM_ID));
    expect(await resolve(title, "0", COLLEAGUE_ID)).toEqual({
      ok: false, code: "conversation_not_in_scope", resourceId: null, available: [ROOM_ID, shared],
    });
    expect(await resolve(OTHER_ROOM_ID.toUpperCase(), "0", COLLEAGUE_ID))
      .toMatchObject({ ok: false, code: "conversation_archived", resourceId: OTHER_ROOM_ID });
  });

  it("preserves specific refusals for own and parent conversations named by title", async () => {
    const breakout = await seedBreakout("Own side work");
    for (const [title, resourceId] of [["Own side work", breakout], ["Investors", ROOM_ID]] as const) {
      expect(await resolve(title, breakout, COLLEAGUE_ID))
        .toEqual({ ok: false, code: "conversation_access_denied", resourceId, available: [] });
    }
    await workspace().setPrivateChildArchived({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: breakout, actorUserId: AUTHOR_ID, archived: true });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID, breakout));
    expect(await resolve("Own side work", breakout))
      .toEqual({ ok: false, code: "conversation_archived", resourceId: breakout, available: [] });
    expect((await post(conversation(ROOM_ID), "/internal/product", {
      operation: "update", auth: AUTH, input: { archived: true },
    })).status).toBe(200);
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID));
    for (const substreamId of ["0", breakout] as const) {
      expect(await resolve("Investors", substreamId))
        .toEqual({ ok: false, code: "conversation_archived", resourceId: ROOM_ID, available: [] });
    }
  });
});

describe("a Sidekick's home conversation", () => {
  it("carries a Breakout home from the Sidekick to the Organization and lists it first", async () => {
    const breakout = await seedBreakout("Weekly call");
    await seedSidekick(breakout);

    expect(await workspace().automationOwner({ workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID }))
      .toEqual({ owningWorkstreamId: ROOM_ID, owningSubstreamId: breakout });
    const listed = await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      scope: sidekickScope() });
    expect(listed.conversations).toEqual([{
      conversationId: `${ROOM_ID}/${breakout}`, parentId: ROOM_ID, substreamId: breakout,
      kind: "breakout", title: "Weekly call", isHome: true, isOwn: false, isParent: false,
    }]);
    // Leaving the conversation out of a post means the home.
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      scope: sidekickScope(), reference: null })).toMatchObject({
      ok: true, sidekickName: "Weekly call prep", conversation: { conversationId: `${ROOM_ID}/${breakout}` },
    });
  });

  it("narrows a Breakout-homed Sidekick to the Breakout's members, wherever it is asked", async () => {
    // The colleague is in the room, not in the Breakout.
    const breakout = await seedBreakout("Weekly call");
    await seedSidekick(breakout);

    expect((await workspace().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID,
      userId: COLLEAGUE_ID })).authorized).toBe(false);
    const authorization = new AuthorizationService(TEST_ENV);
    expect(await authorization.checkMany({ workspaceId: WORKSPACE_ID, userId: COLLEAGUE_ID, delegation: null },
      [{ kind: "conversation", workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, substreamId: asSubstreamId("0") }]))
      .toMatchObject([{ status: "denied" }]);
    // Nor can the colleague make a Sidekick homed there from its loop.
    const loop = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "workstream", parentId: ROOM_ID, substreamId: breakout, loopId: `workstream:${ROOM_ID}:substream:${breakout}:loop`,
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: COLLEAGUE_ID }, reason: "test" });
    const context = { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, harnessRunId: loop.harnessRunId,
      toolCallId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(),
      executionPrincipal: loop.executionPrincipal, signal: new AbortController().signal };
    await expect(new AgentCommunicationService(TEST_ENV, loop).createSidekick("workstream", context))
      .rejects.toMatchObject({ code: "sidekick_owning_workstream_forbidden" });
  });

  it("sends an archived Thread's row only once its Sidekicks are archived, with their list in the same turn", async () => {
    await seedSidekick("0");
    const response = await workspace().fetch("https://workspace.test/socket", { headers: {
      Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": AUTHOR_ID, "x-rally-session-id": SESSION_ID,
      "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1000) + 60),
    } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const frames: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data)) as Record<string, unknown>); });
    try {
      socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      await expect.poll(() => frames.some((frame) => frame.type === "workspace_sync"), { timeout: 5_000 }).toBe(true);
      frames.length = 0;

      expect((await post(conversation(ROOM_ID), "/internal/product", {
        operation: "update", auth: AUTH, input: { archived: true },
      })).status).toBe(200);
      await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID));

      // The archived Thread's row and the updated Sidekick list arrive together.
      const archivedRow = () => frames.findIndex((frame) => frame.type === "workspace_workstream_state"
        && frame.workstreamId === ROOM_ID && frame.workstream === null);
      await expect.poll(archivedRow, { timeout: 5_000 }).toBeGreaterThanOrEqual(0);
      const list = frames[archivedRow() + 1];
      expect(list).toMatchObject({ type: "workspace_sidebar_list", list: "automations", items: [] });
      expect(await workspace().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, userId: AUTHOR_ID }))
        .toEqual({ authorized: false, archived: true });
      // No earlier automations list told the client before its Channel did.
      expect(frames.slice(0, archivedRow()).filter((frame) => frame.list === "automations")).toEqual([]);
    } finally {
      socket.close();
    }
  });

  it.each(["Thread", "Breakout"] as const)("retains the %s archive cascade when restore is delivered first", async (kind) => {
    const home = kind === "Thread" ? "0" : await seedBreakout("Weekly call");
    await seedSidekick(home);
    for (const archived of [true, false]) {
      if (kind === "Thread") {
        expect((await post(conversation(ROOM_ID), "/internal/product", {
          operation: "update", auth: AUTH, input: { archived },
        })).status).toBe(200);
      } else {
        await workspace().setPrivateChildArchived({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
          substreamId: asSubstreamId(home), actorUserId: AUTHOR_ID, archived });
      }
    }
    const effects = (await pendingChildEffects(conversation(ROOM_ID, home)))
      .filter((envelope) => envelope.effect.kind === "directory_common")
      .sort((a, b) => b.sourceVersion - a.sourceVersion);
    const restored = effects[0]!;
    expect(restored.effect).toMatchObject({ archivedAt: null, archiveGeneration: 1 });
    expect(effects.some((envelope) => envelope.effect.kind === "directory_common" && envelope.effect.archivedAt !== null)).toBe(true);
    expect(await consumeEffectBodies(TEST_ENV, [restored])).toEqual({ acked: 1, retried: 0 });
    expect(await workspace().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, userId: AUTHOR_ID }))
      .toEqual({ authorized: false, archived: true });

    // New work in the restored room must survive old archive deliveries/replays.
    const newSidekick = asAutomationId(crypto.randomUUID());
    await seedSidekick(home, newSidekick);
    for (const envelope of [...effects.slice(1), restored]) {
      expect(await consumeEffectBodies(TEST_ENV, [envelope])).toEqual({ acked: 1, retried: 0 });
    }
    expect(await workspace().sidekickReadDetail({ workspaceId: WORKSPACE_ID, automationId: newSidekick,
      actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: true } }))
      .toMatchObject({ lifecycle: "active" });
  });

  it("keeps new Sidekicks when a restored Breakout's directory projection is delayed", async () => {
    const home = await seedBreakout("Weekly call");
    await seedSidekick(home);
    await workspace().setPrivateChildArchived({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: home, actorUserId: AUTHOR_ID, archived: true });
    await workspace().setPrivateChildArchived({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: home, actorUserId: AUTHOR_ID, archived: false });
    const newSidekick = asAutomationId(crypto.randomUUID());
    await seedSidekick(home, newSidekick);
    // Accept the archive projection after the registry has already restored
    // the Breakout and admitted new work, before delivering its restore.
    const archived = (await pendingChildEffects(conversation(ROOM_ID, home)))
      .find((envelope) => envelope.effect.kind === "directory_common" && envelope.effect.archivedAt !== null);
    expect(archived).toBeDefined();
    expect(await consumeEffectBodies(TEST_ENV, [archived])).toEqual({ acked: 1, retried: 0 });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID, home));
    expect(await workspace().sidekickReadDetail({ workspaceId: WORKSPACE_ID, automationId: newSidekick,
      actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: true } }))
      .toMatchObject({ lifecycle: "active" });
  });

  it.each(["active", "paused", "draft"] as const)("archives a Sidekick in %s state with its home Breakout and keeps Main and sibling Sidekicks", async (lifecycle) => {
    const breakout = await seedBreakout("Weekly call");
    const sibling = await seedBreakout("Hiring");
    const mainSidekick = asAutomationId(crypto.randomUUID());
    const siblingSidekick = asAutomationId(crypto.randomUUID());
    await seedSidekick("0", mainSidekick);
    await seedSidekick(sibling, siblingSidekick);
    if (lifecycle === "draft") {
      await createAutomation(TEST_ENV, {
        workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workstream",
        owningWorkstreamId: ROOM_ID, owningSubstreamId: breakout, automationId: AUTOMATION_ID,
      });
    } else {
      await seedSidekick(breakout);
      if (lifecycle === "paused") await workspace().sidekickPause({ workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID,
        actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: true } });
    }

    await workspace().setPrivateChildArchived({
      workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: breakout, actorUserId: AUTHOR_ID, archived: true,
    });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID, breakout));

    const row = await runInDurableObject(sidekickWorkspace(TEST_ENV, WORKSPACE_ID), (_instance, state) =>
      state.storage.sql.exec<{ lifecycle: string; paused_by: string | null; owning_room_archived_at: number | null }>(
        `SELECT lifecycle, paused_by, owning_room_archived_at FROM automation_directory WHERE automation_id = ?`, AUTOMATION_ID,
      ).one());
    expect(row).toMatchObject({ lifecycle: "deleted", paused_by: null });
    expect(row.owning_room_archived_at).not.toBeNull();
    for (const automationId of [mainSidekick, siblingSidekick]) {
      expect(await workspace().sidekickReadDetail({ workspaceId: WORKSPACE_ID, automationId,
        actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: true } }))
        .toMatchObject({ lifecycle: "active" });
    }

    await workspace().setPrivateChildArchived({
      workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: breakout, actorUserId: AUTHOR_ID, archived: false,
    });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID, breakout));
    expect(await workspace().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, userId: AUTHOR_ID }))
      .toEqual({ authorized: false, archived: true });
  });
});

describe("attaching a conversation to a Sidekick", () => {
  it("refuses a person who cannot post there, and records one row however often it is asked", async () => {
    await seedRoom(OTHER_ROOM_ID, "Founders");
    await seedSidekick("0");

    const refused = await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID,
      userId: COLLEAGUE_ID, automationId: AUTOMATION_ID, reference: OTHER_ROOM_ID });
    expect(refused).toEqual({ ok: false, code: "conversation_access_denied", available: [], resourceId: OTHER_ROOM_ID });

    const attached = await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID,
      userId: AUTHOR_ID, automationId: AUTOMATION_ID, reference: "founders" });
    expect(attached).toMatchObject({ ok: true, alreadyAttached: false,
      conversation: { conversationId: OTHER_ROOM_ID, kind: "channel", title: "Founders" } });
    expect(await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID,
      userId: AUTHOR_ID, automationId: AUTOMATION_ID, reference: OTHER_ROOM_ID }))
      .toMatchObject({ ok: true, alreadyAttached: true });
    expect(await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec<{ parent_id: string }>(
        `SELECT parent_id FROM sidekick_conversation_attachments WHERE automation_id = ?`, AUTOMATION_ID,
      ).toArray())).toEqual([{ parent_id: OTHER_ROOM_ID }]);
  });

  it("reads and posts only where the Sidekick is attached", async () => {
    await seedRoom(OTHER_ROOM_ID, "Founders");
    await seedSidekick("0");
    const resolve = (reference: string) => workspace().resolveConversationToolTarget({
      workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, scope: sidekickScope(), reference,
    });

    // The author can open Founders, but the Sidekick is not attached to it.
    expect(await resolve(OTHER_ROOM_ID))
      .toEqual({ ok: false, code: "conversation_not_in_scope", available: [ROOM_ID], resourceId: null });
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID,
      userId: AUTHOR_ID, automationId: AUTOMATION_ID, reference: OTHER_ROOM_ID });
    expect(await resolve("Founders")).toMatchObject({ ok: true, conversation: { conversationId: OTHER_ROOM_ID } });
  });
});

describe("a conversation tool's scope", () => {
  it("re-admits on every list, omitting a Breakout the person has left", async () => {
    const breakout = await seedBreakout("Weekly call");
    await seedSidekick("0");
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID,
      userId: AUTHOR_ID, automationId: AUTOMATION_ID, reference: `${ROOM_ID}/${breakout}` });
    const listed = async () => (await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID,
      userId: AUTHOR_ID, scope: sidekickScope() })).conversations.map((entry) => entry.conversationId);
    expect(await listed()).toEqual([ROOM_ID, `${ROOM_ID}/${breakout}`]);

    // The author adds someone, then leaves; the Breakout goes on without them.
    await workspace().addPrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: breakout, actorUserId: AUTHOR_ID, userId: COLLEAGUE_ID, operationId: "add-colleague" });
    await workspace().removePrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: breakout, actorUserId: AUTHOR_ID, userId: AUTHOR_ID, operationId: "author-leaves" });
    // The Breakout reports its roster to its parent, which the Organization
    // hosts; the parent applies the Breakout's viewer rows in the same object.
    // The parent outbox is left alone: adding a member queued a
    // participant_notification this suite's D1 has no tables to deliver.
    await deliverChildEffects(TEST_ENV, conversation(ROOM_ID, breakout));

    expect(await listed()).toEqual([ROOM_ID]);
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      scope: sidekickScope(), reference: `${ROOM_ID}/${breakout}` }))
      .toEqual({ ok: false, code: "conversation_access_denied", available: [], resourceId: breakout });
  });

  it("reaches nothing for a person whose membership has ended", async () => {
    await seedSidekick("0");
    const scope = { kind: "conversation" as const, parentId: ROOM_ID, substreamId: asSubstreamId("0") };
    const listed = async () => (await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID,
      userId: COLLEAGUE_ID, scope })).conversations.map((entry) => entry.conversationId);
    expect(await listed()).toEqual([ROOM_ID]);

    await workspace().applyMemberStatus({ workspaceId: WORKSPACE_ID, sequence: 2, removed: true, relationship: {
      workspaceId: WORKSPACE_ID, userId: COLLEAGUE_ID, accessClass: "member", role: "member", status: "active",
      incarnation: "existing-member", revision: 1,
    } });

    expect(await listed()).toEqual([]);
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: COLLEAGUE_ID,
      scope, reference: ROOM_ID }))
      .toEqual({ ok: false, code: "conversation_access_denied", available: [], resourceId: ROOM_ID });
  });

  it("refuses an archived conversation by name, and lists it no longer", async () => {
    await seedRoom(OTHER_ROOM_ID, "Founders");
    await seedSidekick("0");
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID,
      userId: AUTHOR_ID, automationId: AUTOMATION_ID, reference: OTHER_ROOM_ID });

    const archived = await post(conversation(OTHER_ROOM_ID), "/internal/product", {
      operation: "update", auth: AUTH, input: { archived: true },
    });
    expect(archived.status).toBe(200);
    await deliverEffectsToWorkspace(TEST_ENV, conversation(OTHER_ROOM_ID));

    expect((await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      scope: sidekickScope() })).conversations.map((entry) => entry.conversationId)).toEqual([ROOM_ID]);
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      scope: sidekickScope(), reference: OTHER_ROOM_ID }))
      .toEqual({ ok: false, code: "conversation_archived", available: [], resourceId: OTHER_ROOM_ID });
  });

  it("gives a Breakout loop its own Breakout and its Channel's Main, and nothing else", async () => {
    const breakout = await seedBreakout("Weekly call");
    await seedRoom(OTHER_ROOM_ID, "Founders");
    const scope = { kind: "conversation" as const, parentId: ROOM_ID, substreamId: breakout };

    expect((await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, scope }))
      .conversations.map((entry) => [entry.conversationId, entry.isOwn]))
      .toEqual([[`${ROOM_ID}/${breakout}`, true], [ROOM_ID, false]]);
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      scope, reference: OTHER_ROOM_ID })).toMatchObject({ ok: false, code: "conversation_not_in_scope" });
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
  function tool(parentId: string = ROOM_ID, parentKind: "workstream" | "automation" = "workstream") {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind, parentId, substreamId: "0", loopId: `${parentKind}:${parentId}:substream:0:loop`,
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

  it("refuses a Sidekick owned by another thread even when the user can open both", async () => {
    await seedRoom(OTHER_ROOM_ID, "Another thread");
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID,
      scope: "workstream", owningWorkstreamId: OTHER_ROOM_ID, automationId: AUTOMATION_ID });
    await expect(tool()(AUTOMATION_ID, await source()))
      .rejects.toMatchObject({ code: "sidekick_owned_by_another_thread" });
    expect(await directLinks()).toEqual([]);
  });

  it("refuses an inaccessible personal Sidekick", async () => {
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: COLLEAGUE_ID,
      scope: "personal", owningWorkstreamId: null, automationId: AUTOMATION_ID });
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

  it("uses current private-conversation access for a resource outside the Sidekick's home", async () => {
    await seedSidekick("0");
    const privateSource = await seedBreakout("Private source");
    await workspace().addPrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: privateSource, actorUserId: AUTHOR_ID, userId: COLLEAGUE_ID, operationId: crypto.randomUUID() });
    const resourceId = await source(COLLEAGUE_ID);
    await attachWorkstreamRuntimeResource(TEST_ENV, { workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID,
      substreamId: privateSource, resourceId, attachedByUserId: COLLEAGUE_ID });
    await projectResourceAccess();
    const principal = { type: "user" as const, userId: AUTHOR_ID };
    const resources = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, "0", principal);
    const database = withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID).DB;
    const read = () => loadVisibleWorkstreamResourcesByIds(database, resources,
      { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal, resourceIds: [resourceId] });
    expect((await read()).map((row) => row.title)).toEqual(["Calendar instructions"]);
    await workspace().removePrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: privateSource, actorUserId: AUTHOR_ID, userId: AUTHOR_ID, operationId: crypto.randomUUID() });
    await projectResourceAccess();
    expect(await read()).toEqual([]);
    // The source still exists for its remaining member; knowing its ID alone
    // did not preserve the former reader's access.
    const colleague = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, "0",
      { type: "user", userId: COLLEAGUE_ID });
    expect((await loadVisibleWorkstreamResourcesByIds(database, colleague, { workspaceId: WORKSPACE_ID,
      workstreamId: AUTOMATION_ID, principal: { type: "user", userId: COLLEAGUE_ID }, resourceIds: [resourceId] }))
      .map((row) => row.title)).toEqual(["Calendar instructions"]);
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
      workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal: { type: "user", userId: AUTHOR_ID },
    });
    for (const reference of [resourceId, "calendar"]) {
      calls.length = 0;
      statements.length = 0;
      await expect(context.resolveArtifact(reference)).resolves.toEqual({ artifactId, slug: "calendar", mode: "active", stateful: true });
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
    const threadAgent = agentIdForAddress({ parentKind: "workstream", parentId: ROOM_ID, substreamId: asSubstreamId("0") });
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

  it.each(["wizard", "activation", "worker"])("gives a Sidekick %s its home and attached conversations' resources without copying links", async (kind) => {
    const home = await seedBreakout("Calendar setup");
    const sibling = await seedBreakout("Private sibling");
    await workspace().addPrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: sibling, actorUserId: AUTHOR_ID, userId: COLLEAGUE_ID, operationId: crypto.randomUUID() });
    await workspace().removePrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: sibling, actorUserId: AUTHOR_ID, userId: AUTHOR_ID, operationId: crypto.randomUUID() });
    await seedRoom(OTHER_ROOM_ID, "Attached source");
    const attached = await seedBreakout("Source details", OTHER_ROOM_ID);
    await seedSidekick(home);
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      automationId: AUTOMATION_ID, reference: `${OTHER_ROOM_ID}/${attached}` });
    const attachedId = "00000000-0000-7000-8000-0000000c0ae3";
    const siblingId = "00000000-0000-7000-8000-0000000c0ae4";
    await link(conversation(ROOM_ID), CHANNEL_RESOURCE_ID, 1_000);
    await link(conversation(ROOM_ID, home), BREAKOUT_RESOURCE_ID, 2_000);
    await link(conversation(OTHER_ROOM_ID, attached), attachedId, 3_000);
    await link(conversation(ROOM_ID, sibling), siblingId, 4_000);
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const id of [CHANNEL_RESOURCE_ID, BREAKOUT_RESOURCE_ID, attachedId, siblingId]) {
        state.storage.sql.exec(`INSERT INTO resources
          (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
          VALUES (?, ?, 'generated_document', 'avalon_generated', 'Calendar source', '{}', 'attached', ?, ?)`,
        id, WORKSPACE_ID, NOW, NOW);
      }
    });
    const child = kind === "wizard" ? "0" : asSubstreamId(crypto.randomUUID());
    if (child !== "0") await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "automation", AUTOMATION_ID, child);
    if (kind === "worker") await runInDurableObject(conversation(AUTOMATION_ID, child), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO background_agent (id, execution_principal_json) VALUES (1, ?)",
        JSON.stringify({ type: "user", userId: AUTHOR_ID }));
    });
    const principal = { type: "user" as const, userId: AUTHOR_ID };
    await projectResourceAccess();
    const resources = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, child, principal);
    const database = withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID).DB;
    const before = await resources.inventoryFingerprint();
    const page = await loadVisibleWorkstreamResourcePage(database, resources,
      { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal, attachmentKind: null, limit: 25 });
    expect(page.rows.map((row) => row.id).sort()).toEqual([CHANNEL_RESOURCE_ID, BREAKOUT_RESOURCE_ID, attachedId].sort());
    expect((await loadVisibleWorkstreamResourcesByIds(database, resources,
      { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID, principal, resourceIds: [CHANNEL_RESOURCE_ID, siblingId] }))
      .map((row) => row.id)).toEqual([CHANNEL_RESOURCE_ID]);
    expect(await runInDurableObject(conversation(AUTOMATION_ID, child), (_instance, state) =>
      state.storage.sql.exec("SELECT resource_id FROM workstream_resource_links").toArray())).toEqual([]);
    // New attachments are inherited by the same reader, not a setup-time snapshot.
    await link(conversation(OTHER_ROOM_ID), "00000000-0000-7000-8000-0000000c0ae5", 5_000);
    expect(await resources.attachedResourceIds()).toContain("00000000-0000-7000-8000-0000000c0ae5");
    expect(await resources.inventoryFingerprint()).not.toBe(before);
    // Detaching the conversation removes both its own and inherited resources.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM sidekick_conversation_attachments WHERE automation_id = ?", AUTOMATION_ID);
    });
    expect((await resources.attachedResourceIds()).sort()).toEqual([CHANNEL_RESOURCE_ID, BREAKOUT_RESOURCE_ID].sort());
    // Being an editor of the home Thread does not grant its private Breakout.
    const colleague = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, AUTOMATION_ID, undefined, child,
      { type: "user", userId: COLLEAGUE_ID });
    expect(await colleague.attachedResourceIds()).toEqual([]);
    const targetInput = { workspaceId: WORKSPACE_ID, parentKind: "automation" as const, parentId: AUTOMATION_ID, executionPrincipal: principal };
    expect(await resolveTerminalPublicationHome(TEST_ENV, targetInput)).toEqual({ parentId: ROOM_ID, substreamId: home });
    await expect(resolveTerminalPublicationHome(TEST_ENV, { ...targetInput, executionPrincipal: { type: "user", userId: COLLEAGUE_ID } }))
      .rejects.toMatchObject({ code: "conversation_access_denied" });
    await workspace().addPrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: home, actorUserId: AUTHOR_ID, userId: COLLEAGUE_ID, operationId: "add-home-colleague" });
    await workspace().removePrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: home, actorUserId: AUTHOR_ID, userId: AUTHOR_ID, operationId: "leave-home" });
    expect(await resources.attachedResourceIds()).toEqual([]);
  });

  it.each(["home", "unattached"])("imports and retains an authorized %s site until access is lost", async (kind) => {
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

  it("follows every page of a Sidekick's inherited resource inventory", async () => {
    await seedSidekick("0");
    await seedRoom(OTHER_ROOM_ID, "Source files");
    await workspace().attachSidekickConversation({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID,
      automationId: AUTOMATION_ID, reference: OTHER_ROOM_ID });
    const ids = [CHANNEL_RESOURCE_ID, BREAKOUT_RESOURCE_ID, crypto.randomUUID()];
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const id of ids) state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'generated_document', 'avalon_generated', 'Source file', '{}', 'attached', ?, ?)`, id, WORKSPACE_ID, NOW, NOW);
    });
    await link(conversation(ROOM_ID), ids[0]!, 1_000);
    await link(conversation(ROOM_ID), ids[1]!, 2_000);
    await link(conversation(OTHER_ROOM_ID), ids[2]!, 3_000);
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "automation", parentId: AUTOMATION_ID, substreamId: "0", loopId: "pagination-test",
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const list = createWorkstreamAttachmentTools(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID), input)
      .find((tool) => tool.definition.name === "list_resources")!;
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID,
      harnessRunId: input.harnessRunId, toolCallId: "resource-page", executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal };
    const first = await list.execute({ limit: 1 }, context);
    const second = await list.execute(first.pagination!.continuations[0]!.input, context);
    const third = await list.execute(second.pagination!.continuations[0]!.input, context);
    expect([first, second, third].map((result) => result.output)).toMatchObject([
      { items: [{ resourceId: ids[2] }] }, { items: [{ resourceId: ids[1] }] }, { items: [{ resourceId: ids[0] }] },
    ]);
    expect(third.pagination!.continuations).toEqual([]);
  });

  function publication(sidekickId = AUTOMATION_ID) {
    const input = WorkstreamWorkflowInputSchema.parse({ region: "global", workspaceId: WORKSPACE_ID,
      parentKind: "automation", parentId: sidekickId, substreamId: "0", loopId: "publication-test",
      harnessRunId: crypto.randomUUID(), triggerMessageId: null, activityId: null,
      executionPrincipal: { type: "user", userId: AUTHOR_ID }, reason: "test" });
    const context: HarnessToolContext = { workspaceId: WORKSPACE_ID, workstreamId: sidekickId,
      harnessRunId: input.harnessRunId, effectIntentId: crypto.randomUUID(), toolCallId: "publish-agenda",
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    return { input, context, bridge: createTerminalResourceBridge(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID),
      createTerminalPortFactory(TEST_ENV, undefined, "0"), undefined, () => resolveTerminalPublicationHome(TEST_ENV, input)) };
  }

  it.each(["file", "site"] as const)("isolates same-path %s publications in Main and two private Sidekick homes", async (kind) => {
    await TEST_ENV.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS artifact_hostname_routes (
      hostname_stub TEXT PRIMARY KEY, region TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(region, artifact_id))`).run();
    const homes = ["0" as const, await seedBreakout("Private calendar"), await seedBreakout("Private agenda")];
    const sidekicks = [AUTOMATION_ID, asAutomationId(crypto.randomUUID()), asAutomationId(crypto.randomUUID())];
    for (let i = 0; i < homes.length; i++) await seedSidekick(homes[i]!, sidekicks[i]!);
    const publishes = sidekicks.map((id) => publication(id));
    const publish = async (index: number, text: string) => {
      const { bridge, context } = publishes[index]!;
      const bytes = new TextEncoder().encode(text);
      const attempt = { ...context, effectIntentId: crypto.randomUUID() };
      return kind === "file" ? bridge.publishResource(attempt, { filePath: "agenda.md" }, bytes)
        : bridge.publishSiteResource(attempt, { filePath: "agenda" }, { mode: "static", stateful: false,
          files: [{ path: "index.html", bytes, sha256: await sha256Hex(bytes) }], serverModuleSha256: null });
    };
    const main = await publish(0, "Main agenda");
    const privateA = await publish(1, "Private A agenda");
    const privateB = await publish(2, "Private B agenda");
    expect(new Set([main.resourceId, privateA.resourceId, privateB.resourceId]).size).toBe(3);
    expect((await publish(0, "Updated Main agenda")).resourceId).toBe(main.resourceId);
    expect((await publish(1, "Updated Private A agenda")).resourceId).toBe(privateA.resourceId);
    for (const [i, resourceId] of [main.resourceId, privateA.resourceId, privateB.resourceId].entries()) {
      expect(await runInDurableObject(conversation(ROOM_ID, homes[i]!), (_instance, state) =>
        state.storage.sql.exec("SELECT resource_id FROM workstream_resource_links").toArray()))
        .toEqual([{ resource_id: resourceId }]);
    }
    expect(await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS count FROM resources WHERE provider = 'avalon_generated'").one()))
      .toEqual({ count: 3 });
    if (kind === "file") {
      const { bridge, context } = publishes[2]!;
      expect(await bridge.reconcilePublishedResource({ ...context, attemptStartedAt: 0 },
        { filePath: "agenda.md" })).toMatchObject({ outcome: "landed", result: { output: { resourceId: privateB.resourceId } } });
    }
  });

  it.each(["file", "site"] as const)("preserves a legacy wizard %s's resource identity when publishing to its home", async (kind) => {
    await TEST_ENV.PLATFORM_DB.prepare(`CREATE TABLE IF NOT EXISTS artifact_hostname_routes (
      hostname_stub TEXT PRIMARY KEY, region TEXT NOT NULL, artifact_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(region, artifact_id))`).run();
    await seedSidekick("0");
    const { bridge, context } = publication();
    const legacy = createTerminalResourceBridge(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID),
      createTerminalPortFactory(TEST_ENV, undefined, "0"));
    const path = kind === "file" ? "agenda.md" : "calendar";
    const publish = async (publisher: typeof bridge, text: string) => {
      const bytes = new TextEncoder().encode(text);
      const attempt = { ...context, effectIntentId: crypto.randomUUID() };
      return kind === "file" ? publisher.publishResource(attempt, { filePath: path }, bytes)
        : publisher.publishSiteResource(attempt, { filePath: path }, { mode: "static", stateful: false,
          files: [{ path: "index.html", bytes, sha256: await sha256Hex(bytes) }], serverModuleSha256: null });
    };
    const original = await publish(legacy, "Original wizard output");
    const previousKind = await bridge.publishedKindForPath(context, path);
    const recovered = await bridge.reconcilePublishedResource({ ...context, attemptStartedAt: 0 }, { filePath: path });
    const refreshed = await publish(bridge, "Refreshed wizard output");
    expect(refreshed.resourceId).toBe(original.resourceId);
    expect(previousKind).toBe(kind);
    expect(recovered).toMatchObject({ outcome: "landed", result: { output: { resourceId: original.resourceId } } });
    if ("url" in original && "url" in refreshed) expect(refreshed.url).toBe(original.url);
    expect(await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS count FROM resources WHERE provider = 'avalon_generated'").one()))
      .toEqual({ count: 1 });
    expect(await runInDurableObject(conversation(ROOM_ID), (_instance, state) =>
      state.storage.sql.exec("SELECT resource_id FROM workstream_resource_links").toArray()))
      .toEqual([{ resource_id: original.resourceId }]);
  });

  it("keeps Terminal available and refuses publication and recovery after home access ends", async () => {
    const home = await seedBreakout("Private calendar");
    await seedSidekick(home);
    const { input, context, bridge } = publication();
    const configuredEnv: Env = { ...TEST_ENV, TERMINAL_REGION_CAPABILITY: "supported", DAYTONA_API_KEY: "test-only",
      DAYTONA_API_URL: "https://daytona.example.test", DAYTONA_TARGET: "us", DAYTONA_TERMINAL_SNAPSHOT: "test" };
    const plugin = await createAvalonTerminalPlugin(configuredEnv, input);
    expect(plugin?.tools.map((tool) => tool.definition.name)).toEqual(expect.arrayContaining(["run_command", "import_resource", "publish_resource"]));
    const first = await bridge.publishResource(context, { filePath: "agenda.md" }, new TextEncoder().encode("Original"));
    await workspace().addPrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: home, actorUserId: AUTHOR_ID, userId: COLLEAGUE_ID, operationId: "add-home-member" });
    await workspace().removePrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: home, actorUserId: AUTHOR_ID, userId: AUTHOR_ID, operationId: "leave-home" });
    await deliverChildEffects(TEST_ENV, conversation(ROOM_ID, home));
    const publishTool = plugin!.tools.find((tool) => tool.definition.name === "publish_resource")!;
    await expect(publishTool.reconcileEffect!({ filePath: "agenda.md" },
      { ...context, attemptStartedAt: 0 })).rejects.toMatchObject({ code: "conversation_access_denied" });
    await expect(bridge.publishResource(context, { filePath: "agenda.md" }, new TextEncoder().encode("Forbidden")))
      .rejects.toMatchObject({ code: "conversation_access_denied" });
    await expect(bridge.publishSiteResource(context, { filePath: "calendar" }, { mode: "static", stateful: false,
      files: [], serverModuleSha256: null })).rejects.toMatchObject({ code: "conversation_access_denied" });
    const after = await createAvalonTerminalPlugin(configuredEnv, input);
    expect(after?.tools.map((tool) => tool.definition.name)).toEqual(expect.arrayContaining(["run_command", "import_resource", "publish_resource"]));
    expect(await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec("SELECT content_sha256 FROM resources WHERE id = ?", first.resourceId).one()))
      .toEqual({ content_sha256: await sha256Hex("Original") });
    plugin?.[Symbol.dispose]();
    after?.[Symbol.dispose]();
  });

  it("refuses to reuse a legacy Main identity attached only to a private Breakout", async () => {
    const privateHome = await seedBreakout("Legacy private output");
    await seedSidekick("0");
    const { context, bridge } = publication();
    const resourceId = crypto.randomUUID();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, provider_resource_id, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'generated_document', 'avalon_generated', ?, 'Private agenda', '{}', 'attached', ?, ?)`,
      resourceId, WORKSPACE_ID, `terminal:${ROOM_ID}:agenda.md`, NOW, NOW);
    });
    await link(conversation(ROOM_ID, privateHome), resourceId, 1_000);
    await expect(bridge.publishResource(context, { filePath: "agenda.md" }, new TextEncoder().encode("Forbidden")))
      .rejects.toMatchObject({ code: "resource_not_found" });
    expect(await runInDurableObject(conversation(ROOM_ID), (_instance, state) =>
      state.storage.sql.exec("SELECT resource_id FROM workstream_resource_links").toArray())).toEqual([]);
  });

  it("publishes into the exact home Breakout during setup without exposing the output in Main", async () => {
    const home = await seedBreakout("Private calendar");
    await seedSidekick(home);
    const input = { workspaceId: WORKSPACE_ID, parentId: AUTOMATION_ID, parentKind: "automation" as const,
      executionPrincipal: { type: "user" as const, userId: AUTHOR_ID } };
    const bridge = createTerminalResourceBridge(withWorkspaceRuntimeDatabase(TEST_ENV, WORKSPACE_ID),
      createTerminalPortFactory(TEST_ENV, undefined, "0"), undefined, () => resolveTerminalPublicationHome(TEST_ENV, input));
    const result = await bridge.publishResource({ workspaceId: WORKSPACE_ID, workstreamId: AUTOMATION_ID,
      harnessRunId: crypto.randomUUID(), effectIntentId: crypto.randomUUID(), toolCallId: "publish-agenda",
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal },
    { filePath: "agenda.md" }, new TextEncoder().encode("# Private calendar agenda"));
    const linked = (child: string) => createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, ROOM_ID, undefined, child).attachedResourceIds();
    expect(await linked(home)).toEqual([result.resourceId]);
    expect(await linked("0")).toEqual([]);
  });

  it("sees every resource its Channel's Main has attached, beside its own", async () => {
    const breakout = await seedBreakout("Weekly call");
    await link(conversation(ROOM_ID), CHANNEL_RESOURCE_ID, 1_000);
    await link(conversation(ROOM_ID, breakout), BREAKOUT_RESOURCE_ID, 2_000);

    const seen = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, ROOM_ID, undefined, breakout);
    expect((await seen.links({})).links.map((row) => row.resource_id))
      .toEqual([BREAKOUT_RESOURCE_ID, CHANNEL_RESOURCE_ID]);
    // A point lookup, which is what read_resource makes, finds the Channel's.
    expect((await seen.links({ resourceIds: [CHANNEL_RESOURCE_ID] })).links.map((row) => row.resource_id))
      .toEqual([CHANNEL_RESOURCE_ID]);
    expect(await seen.inventoryFingerprint()).toBe("inventory:1/1");

    // The Channel attaching something changes what the Breakout sees, so a
    // Breakout's cursor or compaction checkpoint must not keep matching.
    await link(conversation(ROOM_ID), "00000000-0000-7000-8000-0000000c0ae3", 3_000);
    expect(await seen.inventoryFingerprint()).toBe("inventory:1/2");

    // The Channel inherits nothing from its Breakouts.
    const channel = createConversationResourceLinks(TEST_ENV, WORKSPACE_ID, ROOM_ID, undefined, "0");
    expect((await channel.links({ resourceIds: [BREAKOUT_RESOURCE_ID] })).links).toEqual([]);
    expect(await channel.inventoryFingerprint()).toBe("inventory:2");
  });

  it("admits a Breakout's member to its Channel's Main, though the Channel itself would not", async () => {
    await workspace().applyMemberStatus({ workspaceId: WORKSPACE_ID, sequence: 2, removed: false, relationship: {
      workspaceId: WORKSPACE_ID, userId: OUTSIDER_ID, accessClass: "member", role: "member", status: "active",
      incarnation: "outsider", revision: 1,
    } });
    const breakout = await seedBreakout("Weekly call");
    await workspace().addPrivateChildParticipant({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: breakout, actorUserId: AUTHOR_ID, userId: OUTSIDER_ID, operationId: "add-outsider" });
    // The parent outbox is left alone, as above: the add queued a
    // participant_notification this suite's D1 has no tables to deliver.
    await deliverChildEffects(TEST_ENV, conversation(ROOM_ID, breakout));
    expect((await workspace().authorizeViewer({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: asSubstreamId("0"), userId: OUTSIDER_ID })).authorized).toBe(false);

    const scope = { kind: "conversation" as const, parentId: ROOM_ID, substreamId: breakout };
    expect((await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID, userId: OUTSIDER_ID, scope }))
      .conversations.map((entry) => entry.conversationId))
      .toEqual([`${ROOM_ID}/${breakout}`, ROOM_ID]);
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: OUTSIDER_ID,
      scope, reference: ROOM_ID })).toMatchObject({ ok: true, conversation: { conversationId: ROOM_ID } });

    // The standing is the Breakout's: without it, the Channel's Main is
    // refused like any conversation they cannot open.
    const mainScope = { kind: "conversation" as const, parentId: ROOM_ID, substreamId: asSubstreamId("0") };
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: OUTSIDER_ID,
      scope: mainScope, reference: ROOM_ID }))
      .toEqual({ ok: false, code: "conversation_access_denied", available: [], resourceId: ROOM_ID });
  });
});

describe("a conversation post", () => {
  function postRequest(substreamId: SubstreamId, clientMessageId: string) {
    return {
      schemaVersion: 1 as const, workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, substreamId, clientMessageId,
      text: "Adam: nothing from me this week.",
      post: {
        type: "automation_activation" as const, schemaVersion: 1 as const, automationId: AUTOMATION_ID,
        automationName: "Weekly call prep", runId: crypto.randomUUID(), deliveryId: clientMessageId,
        trigger: { kind: "manual" as const }, occurredAt: Date.now(),
        externalSource: { provider: "slack", displayName: "Adam" },
      },
    };
  }

  it("lands once in a Breakout, as the Sidekick, without waking its agent", async () => {
    const breakout = await seedBreakout("Weekly call");
    const target = conversation(ROOM_ID, breakout);

    const first = await target.appendConversationPost(postRequest(breakout, "conversation-post:run:receipt"));
    expect(first).toMatchObject({ outcome: "appended", code: "conversation_post_appended" });
    const again = await target.appendConversationPost(postRequest(breakout, "conversation-post:run:receipt"));
    expect(again).toEqual({ outcome: "replayed", code: "conversation_post_replayed", messageId: first.messageId });

    const stored = await runInDurableObject(target, (_instance, state) => ({
      posts: state.storage.sql.exec<{ id: string; message_type: string; structured_content_json: string }>(
        `SELECT id, message_type, structured_content_json FROM canonical_conversation_turn_details
          WHERE client_message_id LIKE 'conversation-post:%'`,
      ).toArray(),
      pending: state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM pending_loop_inputs`).one().count,
      runs: state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM runs`).one().count,
    }));
    expect(stored.posts).toHaveLength(1);
    expect(stored.posts[0]).toMatchObject({ id: first.messageId, message_type: "automation_activation" });
    expect(JSON.parse(stored.posts[0]!.structured_content_json)).toMatchObject({
      automationName: "Weekly call prep", externalSource: { provider: "slack", displayName: "Adam" },
    });
    expect({ pending: stored.pending, runs: stored.runs }).toEqual({ pending: 0, runs: 0 });
    await deliverChildEffects(TEST_ENV, target);
  });

  it("refuses an archived conversation and one it is not addressed to", async () => {
    const breakout = await seedBreakout("Weekly call");
    const target = conversation(ROOM_ID, breakout);
    expect(await target.appendConversationPost(postRequest(asSubstreamId("0"), "conversation-post:run:wrong")))
      .toEqual({ outcome: "refused", code: "workstream_destination_mismatch", messageId: null });

    await workspace().setPrivateChildArchived({
      workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: breakout, actorUserId: AUTHOR_ID, archived: true,
    });
    expect(await target.appendConversationPost(postRequest(breakout, "conversation-post:run:late")))
      .toEqual({ outcome: "refused", code: "workstream_archived", messageId: null });
  });
});

describe("a guest", () => {
  type GrantTarget =
    | { kind: "workstream"; workspaceId: typeof WORKSPACE_ID; parentId: string }
    | { kind: "conversation"; workspaceId: typeof WORKSPACE_ID; parentId: string; substreamId: SubstreamId };

  /**
   * A guest of the Organization, with the room's conversations under grant
   * authority: a guest reaches only what a grant gives them.
   */
  async function seedGuest(substreamIds: SubstreamId[]): Promise<void> {
    await workspace().applyMemberStatus({ workspaceId: WORKSPACE_ID, sequence: 2, removed: false, relationship: {
      workspaceId: WORKSPACE_ID, userId: GUEST_ID, accessClass: "guest", role: null, status: "active",
      incarnation: "guest", revision: 1,
    } });
    await runInDurableObject(workspace(), (_instance, state) => {
      for (const substreamId of substreamIds) {
        state.storage.sql.exec(`INSERT OR IGNORE INTO parent_participant_migrations (parent_id, substream_id, transfer_id, incarnations_json, phase) VALUES (?, ?, ?, NULL, 'complete')`,
          ROOM_ID, substreamId, crypto.randomUUID());
      }
    });
  }

  async function grant(target: GrantTarget): Promise<void> {
    await withHostedParent(workspace(), ROOM_ID, (hosted) => {
      hosted["scopeGrants"]({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID }).mutate({
        operationId: crypto.randomUUID(), actorUserId: AUTHOR_ID, userId: GUEST_ID, target, active: true,
        expectedRevision: 0,
      }, "guest");
    });
  }

  it("opens a Breakout-homed Sidekick through the Breakout's grant, not the Channel's", async () => {
    const breakout = await seedBreakout("Weekly call");
    await seedSidekick(breakout);
    await seedGuest([asSubstreamId("0"), breakout]);
    const opens = async () => (await workspace().authorizeViewer({ workspaceId: WORKSPACE_ID,
      parentId: AUTOMATION_ID, userId: GUEST_ID, requireGrantAuthority: true })).authorized;

    await grant({ kind: "workstream", workspaceId: WORKSPACE_ID, parentId: ROOM_ID });
    expect(await opens()).toBe(false);
    await grant({ kind: "conversation", workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: breakout });
    expect(await opens()).toBe(true);
  });

  it("reaches only by grant: an Organization-wide Channel is not theirs to read", async () => {
    // Every member reads an Organization-wide Channel without a seat; a guest
    // reads only what a grant gives them, and has none here. (A guest cannot
    // be seated in a Breakout without a share, so a seat is not a way in.)
    await seedRoom(OTHER_ROOM_ID, "Announcements", [AUTHOR_ID], "workspace");
    await seedGuest([]);
    const scope = { kind: "conversation" as const, parentId: OTHER_ROOM_ID, substreamId: asSubstreamId("0") };

    expect((await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID, userId: GUEST_ID, scope }))
      .conversations).toEqual([]);
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: GUEST_ID,
      scope, reference: OTHER_ROOM_ID })).toMatchObject({ ok: false, code: "conversation_access_denied" });
  });

  it("lists a conversation a grant gives them, as it resolves it", async () => {
    await seedSidekick("0");
    await seedGuest([asSubstreamId("0")]);
    await grant({ kind: "conversation", workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: asSubstreamId("0") });
    const scope = { kind: "conversation" as const, parentId: ROOM_ID, substreamId: asSubstreamId("0") };

    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: GUEST_ID,
      scope, reference: ROOM_ID })).toMatchObject({ ok: true, conversation: { conversationId: ROOM_ID } });
    expect((await workspace().conversationToolScope({ workspaceId: WORKSPACE_ID, userId: GUEST_ID, scope }))
      .conversations.map((entry) => entry.conversationId)).toEqual([ROOM_ID]);
    // A reference outside the scope is refused with the same list, not the
    // directory's viewer rows, which record no grant.
    expect(await workspace().resolveConversationToolTarget({ workspaceId: WORKSPACE_ID, userId: GUEST_ID,
      scope, reference: "Nowhere" })).toMatchObject({ ok: false, code: "conversation_not_in_scope", available: [ROOM_ID] });
  });
});

describe("a Breakout's merge into its Thread", () => {
  const SHAREABLE_ID = "00000000-0000-7000-8000-0000000c0af1";
  const SOMEONE_ELSES_ID = "00000000-0000-7000-8000-0000000c0af2";

  /** The rows the attach path's source check reads, in the Organization's runtime database. */
  async function seedResources(): Promise<void> {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, model_plugin_id,
         encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json, created_at, updated_at)
        VALUES ('conn-1', ?, 'google', 'personal', ?, 'Google', 'google-fixture', 'x', 'x', 1, '[]', ?, ?)`,
      WORKSPACE_ID, COLLEAGUE_ID, NOW, NOW);
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'document', 'rally_artifact', 'Price model', '{}', 'attached', ?, ?)`, SHAREABLE_ID, WORKSPACE_ID, NOW, NOW);
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, connection_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'conn-1', 'document', 'google', 'Colleague notes', '{}', 'attached', ?, ?)`,
      SOMEONE_ELSES_ID, WORKSPACE_ID, NOW, NOW);
    });
  }

  async function mainState() {
    return runInDurableObject(conversation(ROOM_ID), (_instance, state) => ({
      merges: state.storage.sql.exec<{ structured_content_json: string }>(
        `SELECT structured_content_json FROM canonical_conversation_turn_details WHERE client_message_id LIKE 'merge-%'`,
      ).toArray().map((row) => JSON.parse(row.structured_content_json) as unknown),
      links: state.storage.sql.exec<{ resource_id: string }>("SELECT resource_id FROM workstream_resource_links")
        .toArray().map((row) => row.resource_id),
      pending: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_loop_inputs").one().count,
      runs: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM runs").one().count,
    }));
  }

  it("lands once in Main with the tags the server writes, starting no run in a room of two", async () => {
    const breakout = await seedBreakout("Sequence B");
    const service = new ConversationMergeService(TEST_ENV, AUTH);
    const request = { body: "Sequence B is approved.", clientMessageId: "merge-1", breakoutId: breakout };

    const first = await service.merge(ROOM_ID, request);
    expect(first).toMatchObject({ mergedInto: { kind: "thread", id: ROOM_ID, title: "Investors" }, replayed: false, sharedResourceIds: [] });
    expect(await service.merge(ROOM_ID, request)).toEqual({ ...first, replayed: true });

    expect(await mainState()).toEqual({
      merges: [{ type: "conversation_merge", schemaVersion: 1, mergedFrom: { breakoutId: breakout, title: "Sequence B" },
        mergedByUserId: AUTHOR_ID, actingAgent: false }],
      links: [], pending: 0, runs: 0,
    });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID));
    const children = await listVisiblePrivateChildren(workspace(), { workspaceId: WORKSPACE_ID, parentId: ROOM_ID, userId: AUTHOR_ID });
    expect(children.children.find((child) => child.substreamId === breakout)).toMatchObject({ resolved: true });
    await workspace().setPrivateChildArchived({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: breakout, actorUserId: AUTHOR_ID, archived: true });
    expect((await listVisiblePrivateChildren(workspace(), { workspaceId: WORKSPACE_ID, parentId: ROOM_ID, userId: AUTHOR_ID }))
      .children.some((child) => child.substreamId === breakout)).toBe(false);
    await workspace().setPrivateChildArchived({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID,
      substreamId: breakout, actorUserId: AUTHOR_ID, archived: false });
    expect((await listVisiblePrivateChildren(workspace(), { workspaceId: WORKSPACE_ID, parentId: ROOM_ID, userId: AUTHOR_ID }))
      .children.find((child) => child.substreamId === breakout)).toMatchObject({ resolved: true });
    // The merge message's activity event carries the source, so the Thread's
    // other people see a merged row; its author does not.
    const merged = async (userId: string) => {
      const page = await workspace().listActivity({ workspaceId: WORKSPACE_ID, userId, cursor: null, only: null });
      if (!page.ok) throw new Error(`listActivity refused: ${page.code}`);
      return page.page.items.filter((item) => item.kind === "merged");
    };
    expect(await merged(COLLEAGUE_ID)).toEqual([expect.objectContaining({
      kind: "merged", actorUserId: AUTHOR_ID, threadId: ROOM_ID, breakout: { substreamId: breakout, title: "Sequence B" },
    })]);
    expect(await merged(AUTHOR_ID)).toEqual([]);
  });

  it("leaves one Merged marker in the Breakout naming the merge, however often it is retried", async () => {
    const breakout = await seedBreakout("Sequence B");
    const service = new ConversationMergeService(TEST_ENV, AUTH);
    const request = { body: "Sequence B is approved.", clientMessageId: "merge-marked", breakoutId: breakout };
    const markers = () => runInDurableObject(conversation(ROOM_ID, breakout), (_instance, state) =>
      state.storage.sql.exec<{ content: string; structured_content_json: string; author_type: string }>(
        `SELECT content, structured_content_json, author_type FROM canonical_conversation_turn_details
          WHERE client_message_id LIKE 'merged-into:%' ORDER BY sequence_number`,
      ).toArray().map((row) => ({ ...row, structured_content_json: JSON.parse(row.structured_content_json) as unknown })));

    const merged = await service.merge(ROOM_ID, request);
    await service.merge(ROOM_ID, request);

    expect(await markers()).toEqual([{
      content: "Merged into Investors",
      author_type: "system",
      structured_content_json: {
        type: "conversation_merged_into", schemaVersion: 1,
        mergedInto: { kind: "thread", id: ROOM_ID, title: "Investors" },
        messageId: merged.messageId, mergedByUserId: AUTHOR_ID, actingAgent: false,
      },
    }]);
    // Rally's merge, for the same person, is marked as Rally's.
    await service.merge(ROOM_ID, { ...request, clientMessageId: "merge-marked-by-rally" }, { actingAgent: true });
    expect((await markers()).map((marker) => (marker.structured_content_json as { actingAgent: boolean }).actingAgent))
      .toEqual([false, true]);
    // The Thread gains only the merges; the markers are the Breakout's.
    expect((await mainState()).merges).toHaveLength(2);
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID));
  });

  it("refuses the whole merge when one embed cannot be shared, attaching nothing; then attaches what it embeds", async () => {
    await seedResources();
    const breakout = await seedBreakout("Sequence B");
    const service = new ConversationMergeService(TEST_ENV, AUTH);
    const body = `See [Price model](resource://${SHAREABLE_ID}) and [notes](resource://${SOMEONE_ELSES_ID}).`;

    await expect(service.merge(ROOM_ID, { body, clientMessageId: "merge-2", breakoutId: breakout }))
      .rejects.toMatchObject({ code: "merge_resource_not_shareable", details: { field: "body.resources[1]" } });
    expect(await mainState()).toMatchObject({ merges: [], links: [] });

    const merged = await service.merge(ROOM_ID, {
      body: `See [Price model](resource://${SHAREABLE_ID}).`, clientMessageId: "merge-3", breakoutId: breakout,
    });
    expect(merged.sharedResourceIds).toEqual([SHAREABLE_ID]);
    expect(await mainState()).toMatchObject({ links: [SHAREABLE_ID] });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID));
  });

  it("refuses to merge an artifact its author cannot read, sharing nothing", async () => {
    const UNREAD_ID = "00000000-0000-7000-8000-0000000c0af3";
    // A colleague's generated artifact, attached to no conversation the author reads.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, metadata_json, uploaded_by_user_id, attachment_status, created_at, updated_at)
        VALUES (?, ?, 'document', 'avalon_generated', 'Comp model', '{}', ?, 'attached', ?, ?)`,
      UNREAD_ID, WORKSPACE_ID, COLLEAGUE_ID, NOW, NOW);
      // Discovery has covered every conversation, so "attached nowhere" is an answer, not a gap.
      state.storage.sql.exec(`INSERT OR IGNORE INTO authorization_backfill(parent_id, parent_kind, completed)
        SELECT workstream_id, 'workstream', 1 FROM channels`);
    });
    const breakout = await seedBreakout("Sequence B");
    const service = new ConversationMergeService(TEST_ENV, AUTH);

    await expect(service.merge(ROOM_ID, {
      body: `See [the model](resource://${UNREAD_ID}).`, clientMessageId: "merge-unread", breakoutId: breakout,
    })).rejects.toMatchObject({ code: "merge_resource_not_shareable", details: { field: "body.resources[0]" } });
    expect(await mainState()).toMatchObject({ merges: [], links: [] });
  });

  it("replays a retry after the Breakout was renamed, keeping the first title", async () => {
    const breakout = await seedBreakout("Sequence B");
    const service = new ConversationMergeService(TEST_ENV, AUTH);
    const request = { body: "Approved.", clientMessageId: "merge-renamed", breakoutId: breakout };
    const first = await service.merge(ROOM_ID, request);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE breakouts SET title = 'Sequence C' WHERE substream_id = ?", breakout);
    });
    expect(await service.merge(ROOM_ID, request)).toEqual({ ...first, replayed: true });
    expect((await mainState()).merges).toEqual([expect.objectContaining({ mergedFrom: { breakoutId: breakout, title: "Sequence B" } })]);
  });

  it("shares what the body cites by alias and through a footnote, and refuses an alias that names nothing", async () => {
    await seedResources();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE resources SET slug = 'calm-river-quiet-lamp' WHERE id = ?", SHAREABLE_ID);
    });
    const breakout = await seedBreakout("Sequence B");
    const service = new ConversationMergeService(TEST_ENV, AUTH);

    await expect(service.merge(ROOM_ID, {
      body: "See [it](resource://no-such-alias-here).", clientMessageId: "merge-alias-1", breakoutId: breakout,
    })).rejects.toMatchObject({ code: "merge_resource_not_shareable", details: { field: "body.resources[0]" } });

    const merged = await service.merge(ROOM_ID, {
      body: "Priced.[^1]\n\n[^1]: [Price model](resource://calm-river-quiet-lamp)",
      clientMessageId: "merge-alias-2", breakoutId: breakout,
    });
    expect(merged.sharedResourceIds).toEqual([SHAREABLE_ID]);
    expect(await mainState()).toMatchObject({ links: [SHAREABLE_ID] });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID));
  });

  it("refuses a Breakout that is not this Thread's", async () => {
    await expect(new ConversationMergeService(TEST_ENV, AUTH).merge(ROOM_ID, {
      body: "Done", clientMessageId: "merge-4", breakoutId: "00000000-0000-7000-8000-0000000c0aff",
    })).rejects.toMatchObject({ code: "conversation_access_denied" });
    expect(await mainState()).toMatchObject({ merges: [] });
  });
});
