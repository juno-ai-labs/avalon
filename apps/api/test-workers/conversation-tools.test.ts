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

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
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
import { createConversationResourceLinks } from "../src/runtime/resource-port";
import type { AuthContext, Env } from "../src/env";
import { AgentCommunicationService } from "../src/services/agent-communication-service";
import { AuthorizationService } from "../src/services/authorization-service";
import { ConversationMergeService } from "../src/services/conversation-merge-service";
import { createAutomation } from "../src/services/automation-service";
import {
  bootstrapConversationChildRuntime,
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { deliverChildEffects, deliverEffectsToWorkspace } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { listVisiblePrivateChildren, withHostedParent } from "./helpers/hosted-parent";
import { applySidekick, sidekickWorkspace } from "./helpers/sidekick";
import { post, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

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
async function seedBreakout(title: string): Promise<SubstreamId> {
  const parent = workspace();
  const operationId = crypto.randomUUID();
  const recipe = {
    policy: { revision: "test-empty-v1", strategy: { id: "empty", version: 1 }, config: {} },
    capture: "none" as const,
    parts: [],
  };
  const reserved = await parent.beginPrivateChildPreparation({
    workspaceId: WORKSPACE_ID, parentId: ROOM_ID, operationId, creatorUserId: AUTHOR_ID, title,
    sourceSubstreamId: "0" as const, sourceThroughTurnId: null, recipe,
    membershipInitializer: { plugin: { id: "creator-only", version: 1 }, config: {}, memberUserIds: [AUTHOR_ID] },
  });
  const hash = "0".repeat(64);
  await parent.savePreparedPrivateChildContext({
    workspaceId: WORKSPACE_ID, parentId: ROOM_ID, operationId,
    preparedContext: { schemaVersion: 1, recipe, recipeHash: hash, capture: null, captureHash: null, parts: [], contentHash: hash },
  });
  await parent.claimPrivateChildConfirmation({ workspaceId: WORKSPACE_ID, parentId: ROOM_ID, operationId, actorUserId: AUTHOR_ID });
  await bootstrapConversationChildRuntime(TEST_ENV, WORKSPACE_ID, "workstream", ROOM_ID, reserved.substreamId);
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, substreamId: reserved.substreamId,
    title, objective: "", scope: "personal", createdByUserId: AUTHOR_ID,
    participantUserIds: [AUTHOR_ID], harnessStatus: "idle", titleStatus: "settled", emailAddress: null,
    emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
  });
  await conversation(ROOM_ID, reserved.substreamId).installPreparedSubstreamContext({
    workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, substreamId: reserved.substreamId, operationId,
  });
  await parent.setPrivateChildTerminalStatus({
    workspaceId: WORKSPACE_ID, parentId: ROOM_ID, operationId, status: "ready", errorCode: null,
  });
  await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID, reserved.substreamId));
  return reserved.substreamId;
}

/** A room Sidekick whose home is `home`, created the way authoring creates one, applied and projected. */
async function seedSidekick(home: SubstreamId | "0"): Promise<void> {
  await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workstream",
    owningWorkstreamId: ROOM_ID, owningSubstreamId: home, automationId: AUTOMATION_ID,
  });
  const addressed = { workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID };
  await workspace().sidekickSubmitDefinition({ ...addressed, draft: DEFINITION, evaluatorRules: null, submittedByRunId: null });
  await applySidekick(TEST_ENV, {
    ...addressed, actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: true },
  });
}

const sidekickScope = () => ({ kind: "sidekick" as const, automationId: AUTOMATION_ID });

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

  it("sends an archived Channel's row only once its Sidekicks are paused, with their list in the same turn", async () => {
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
      await expect.poll(() => frames.some((frame) => frame.type === "workspace_sync")).toBe(true);
      frames.length = 0;

      expect((await post(conversation(ROOM_ID), "/internal/product", {
        operation: "update", auth: AUTH, input: { archived: true },
      })).status).toBe(200);
      await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID));

      // The archived Channel's row, then the automations list the archive's
      // pauses moved, sent together with nothing between them.
      const archivedRow = () => frames.findIndex((frame) => frame.type === "workspace_workstream_state"
        && frame.workstreamId === ROOM_ID && frame.workstream === null);
      await expect.poll(archivedRow).toBeGreaterThanOrEqual(0);
      const list = frames[archivedRow() + 1];
      expect(list).toMatchObject({ type: "workspace_sidebar_list", list: "automations" });
      // The row went out after the pause committed, so a rail it prompts the
      // client to read already shows the Sidekick paused.
      expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ paused_by: string | null }>(
        `SELECT paused_by FROM automation_directory WHERE automation_id = ?`, AUTOMATION_ID,
      ).one())).toEqual({ paused_by: "room_archive" });
      // No earlier automations list told the client before its Channel did.
      expect(frames.slice(0, archivedRow()).filter((frame) => frame.list === "automations")).toEqual([]);
    } finally {
      socket.close();
    }
  });

  it("pauses the Sidekick when its home Breakout is archived", async () => {
    const breakout = await seedBreakout("Weekly call");
    await seedSidekick(breakout);

    await workspace().setPrivateChildArchived({
      workspaceId: WORKSPACE_ID, parentId: ROOM_ID, substreamId: breakout, actorUserId: AUTHOR_ID, archived: true,
    });
    await deliverEffectsToWorkspace(TEST_ENV, conversation(ROOM_ID, breakout));

    const row = await runInDurableObject(sidekickWorkspace(TEST_ENV, WORKSPACE_ID), (_instance, state) =>
      state.storage.sql.exec<{ lifecycle: string; paused_by: string | null; owning_room_archived_at: number | null }>(
        `SELECT lifecycle, paused_by, owning_room_archived_at FROM automation_directory WHERE automation_id = ?`, AUTOMATION_ID,
      ).one());
    expect(row).toMatchObject({ lifecycle: "paused", paused_by: "room_archive" });
    expect(row.owning_room_archived_at).not.toBeNull();
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
        state.storage.sql.exec(`INSERT INTO parent_participant_migrations VALUES (?, ?, ?, NULL, 'complete')`,
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
