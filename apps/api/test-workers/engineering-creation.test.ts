/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asSpaceId, asSubstreamId, asUserId, asWorkspaceId, type WorkstreamId } from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { AuthContext, Env } from "../src/env";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { SubstreamCreationService } from "../src/services/substream-creation-service";
import { SpaceService } from "../src/services/space-service";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { deliverEffectsToWorkspace } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { changeRelationships } from "./helpers/workspace-relationship-events";

const ORIGINAL_ORG = asWorkspaceId("00000000-0000-7000-8000-00000000ee01");
const CREATOR = asUserId("00000000-0000-7000-8000-00000000ee02");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000ee03");
const ORG = asWorkspaceId("00000000-0000-7000-8000-00000000ee04");
const CHANNEL = asSpaceId("00000000-0000-7000-8000-00000000ee05");
const THREAD_OPERATION = "00000000-0000-7000-8000-00000000ee06";
const PROMPT = "Help us plan the release.";
const contexts: ReturnType<typeof createExecutionContext>[] = [];
function executionContext() {
  const context = createExecutionContext();
  contexts.push(context);
  return context;
}
afterEach(async () => {
  for (const context of contexts.splice(0)) await waitOnExecutionContext(context);
});

// This path deliberately starts a real run; only the external provider is doubled.
useHeldEffectQueue();
useSelectedModel();
useOpenRouterDouble((call) => {
  const format = JSON.stringify(call.body.response_format ?? {});
  return { say: call.stream ? "Start with the release checklist."
    : format.includes("message_addressing") ? JSON.stringify({ classification: "agent_action", confidence: 1, rationaleCode: "imperative" })
    : format.includes("substream_context_summary") ? JSON.stringify({ summary: "The release checklist is the starting point." })
    : JSON.stringify({ title: "Release plan", icon: "circle-dot", ...(format.includes('"summary"') ? { summary: "Plan the release." } : {}) }) };
});

function creationEnv(): Env {
  return new Proxy(env, { get: (target, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
    ? "workerd-test-email-address-key-0123456789" : Reflect.get(target, property, receiver) });
}

function workspace(orgId = ORG) {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", orgId)));
}

function auth(userId = CREATOR, role: AuthContext["role"] = userId === CREATOR ? "owner" : "member"): AuthContext {
  return { sessionId: "engineering-test", userId, workspaceId: ORG, region: "global", role, principal: "engineering" };
}

async function createOrg(bridge: EngineeringInspectionBridge) {
  return bridge.createOrg({ operationId: ORG, creatorUserId: CREATOR, region: "global", name: "Launch team", userIds: [MEMBER] });
}

async function createChannel(bridge: EngineeringInspectionBridge) {
  return bridge.createChannel({ operationId: CHANNEL, creatorUserId: CREATOR, orgId: ORG, name: "Releases", participantUserIds: [MEMBER] });
}

async function settledThread(threadId: WorkstreamId, creatorUserId = CREATOR, role: AuthContext["role"] = creatorUserId === CREATOR ? "owner" : "member") {
  const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName("global", ORG, threadId, asSubstreamId("0"))));
  await runDurableObjectAlarm(stub);
  const client = new WorkstreamObjectClient(creationEnv(), auth(creatorUserId, role), threadId);
  await expect.poll(async () => (await client.boot()).transcript.ranges.flatMap((range) => range.turns)
    .flatMap((turn) => turn.blocks).filter((block) => block.type === "text").map((block) => block.text),
  // Parent handoff, alarm delivery and the provider round trip, below the test budget.
  { timeout: 10_000 })
    .toContain("Start with the release checklist.");
  await expect.poll(async () => (await client.get()).harnessStatus, { timeout: 10_000 }).toBe("completed");
  return client;
}

beforeEach(async () => {
  await reset();
  await seedInspectableWorkspace(env.DB, { workspaceId: ORIGINAL_ORG, userId: CREATOR, sessionId: "engineering-test", at: "2026-10-21T00:00:00.000Z" });
  await env.DB.batch([
    env.DB.prepare("ALTER TABLE users ADD COLUMN platform_user_id TEXT"),
    env.DB.prepare("ALTER TABLE users ADD COLUMN google_subject TEXT"),
    env.DB.prepare("UPDATE users SET platform_user_id = 'platform-creator' WHERE id = ?").bind(CREATOR),
    env.DB.prepare("INSERT INTO users (id, email, name, timezone, created_at, platform_user_id) VALUES (?, 'member2@example.com', 'Member Two', 'UTC', '2026-10-21T00:00:00.000Z', 'platform-member')").bind(MEMBER),
    env.DB.prepare("ALTER TABLE workspace_members ADD COLUMN joined_at TEXT"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN created_by_user_id TEXT"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN created_at TEXT"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN updated_at TEXT"),
    env.DB.prepare(`CREATE TABLE regional_onboarding_operations (
      operation_id TEXT PRIMARY KEY, platform_user_id TEXT NOT NULL, action TEXT NOT NULL,
      workspace_id TEXT NOT NULL, invitation_id TEXT, completed_at TEXT, created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
  ]);
});

describe("engineering product creation", () => {
  it("creates an Organization with its owner and members, seats them, and resumes without duplicates", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    await createOrg(bridge);
    await createOrg(bridge);
    expect((await env.DB.prepare("SELECT user_id, role, status FROM workspace_members WHERE workspace_id = ? ORDER BY user_id").bind(ORG).all()).results)
      .toEqual([{ user_id: CREATOR, role: "owner", status: "active" }, { user_id: MEMBER, role: "member", status: "active" }]);
    const spaces = await bridge.listSpaces({ workspaceId: ORG });
    expect(spaces.found && spaces.value.items.map((space) => space.scope).sort()).toEqual(["individual", "individual", "workspace"]);
    expect((await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(ORG).all()).results).toEqual([{ id: ORG }]);
    expect((await env.DB.prepare("SELECT id FROM sessions WHERE workspace_id = ?").bind(ORG).all()).results).toEqual([]);
  });

  it("rejects unknown users and mismatched regions before creating an Organization", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    const request = { operationId: ORG, creatorUserId: CREATOR, name: "Launch team", userIds: [THREAD_OPERATION], region: "global" };
    await expect(bridge.createOrg(request)).rejects.toThrow("regional_user_not_found");
    await expect(bridge.createOrg({ ...request, region: "enterprise" })).rejects.toThrow("region_mismatch");
    expect((await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(ORG).all()).results).toEqual([]);
  });

  it("creates one Channel with the named participants and applies ordinary audience refusals", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    await createOrg(bridge);
    await createChannel(bridge);
    const channel = await createChannel(bridge);
    expect(channel.channel.participants.map((person) => person.userId).sort()).toEqual([CREATOR, MEMBER]);
    const visible = await bridge.listUserChannels({ orgId: ORG, userId: MEMBER });
    expect(visible.items.filter((space) => space.scope === "individual").flatMap((space) => space.participants.map((person) => person.userId))).toEqual([MEMBER]);
    expect(visible.items.some((space) => space.id === CHANNEL)).toBe(true);
    const spaces = await bridge.listSpaces({ workspaceId: ORG });
    expect(spaces.found && spaces.value.items.filter((space) => space.name === "Releases").map((space) => space.spaceId)).toEqual([CHANNEL]);
    await expect(bridge.createChannel({ operationId: THREAD_OPERATION, creatorUserId: CREATOR, orgId: ORG,
      name: "Awaiting audience", participantUserIds: [THREAD_OPERATION] })).rejects.toThrow("space_access_denied");
    const after = await bridge.listSpaces({ workspaceId: ORG });
    expect(after.found && after.value.items.some((space) => space.name === "Awaiting audience")).toBe(true);
  });

  it("starts the prompt once in the specified Channel and keeps private Channel threads private", async () => {
    const context = executionContext();
    const bridge = new EngineeringInspectionBridge(context, creationEnv());
    await createOrg(bridge);
    await createChannel(bridge);
    await new SpaceService(creationEnv(), auth()).updateAudience(CHANNEL, { scope: "personal", participantUserIds: [CREATOR, MEMBER] });
    const request = { operationId: THREAD_OPERATION, creatorUserId: CREATOR, orgId: ORG, channelId: CHANNEL, prompt: PROMPT };
    const created = await bridge.createThread(request);
    const client = await settledThread(created.threadId);
    await waitOnExecutionContext(context);
    const replay = await bridge.createThread(request);
    expect(replay.threadId).toBe(THREAD_OPERATION);
    expect(replay.turnId).toBe(created.turnId);
    const boot = await client.boot();
    expect(boot.workstream.scope).toBe("personal");
    expect(boot.transcript.ranges.flatMap((range) => range.turns).flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "text" && block.text === PROMPT)).toHaveLength(1);
    expect(await workspace().channelSpaces({ workspaceId: ORG, userId: CREATOR, workstreamId: created.threadId })).toEqual({ spaceIds: [CHANNEL] });
    await expect(bridge.createThread({ ...request, prompt: "A different prompt" })).rejects.toThrow(/conflict/);
  });

  it("preserves the rejected field across the regional RPC boundary", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    await expect(bridge.createOrg({ operationId: ORG, creatorUserId: CREATOR, region: "global", name: "X", userIds: [] }))
      .rejects.toThrow(/name:too_small/);
    await expect(bridge.createThread({ operationId: THREAD_OPERATION, creatorUserId: CREATOR, orgId: ORG,
      channelId: CHANNEL, prompt: "  " })).rejects.toThrow(/prompt:custom/);
  });

  it("creates as a member and enforces the app's guest creation refusal without changing their role", async () => {
    const context = executionContext();
    const bridge = new EngineeringInspectionBridge(context, creationEnv());
    await createOrg(bridge);
    const channel = await bridge.createChannel({ operationId: CHANNEL, orgId: ORG, creatorUserId: MEMBER,
      name: "Member launch", participantUserIds: [CREATOR] });
    expect(channel.channel.participants.map((person) => person.userId).sort()).toEqual([CREATOR, MEMBER]);
    const created = await bridge.createThread({ operationId: THREAD_OPERATION, creatorUserId: MEMBER,
      orgId: ORG, channelId: CHANNEL, prompt: PROMPT });
    const client = await settledThread(created.threadId, MEMBER, "member");
    await waitOnExecutionContext(context);
    expect((await client.boot()).workstream.createdByUserId).toBe(MEMBER);
    await changeRelationships(creationEnv(), ORG, [MEMBER], env.DB.prepare("UPDATE workspace_members SET role = NULL, access_class = 'guest', revision = revision + 1 WHERE workspace_id = ? AND user_id = ?").bind(ORG, MEMBER));
    await expect(bridge.createChannel({ operationId: crypto.randomUUID(), creatorUserId: MEMBER, orgId: ORG,
      name: "Guest launch", participantUserIds: [] })).rejects.toThrow("space_access_denied");
    await expect(bridge.createThread({ operationId: crypto.randomUUID(), creatorUserId: MEMBER,
      orgId: ORG, channelId: CHANNEL, prompt: PROMPT })).rejects.toThrow("space_access_denied");
    expect((await env.DB.prepare("SELECT access_class, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(ORG, MEMBER).all()).results)
      .toEqual([{ access_class: "guest", role: null }]);
  });

  it.each(["member", "guest"] as const)("admits an ordinary send as a %s, executes it, and deduplicates retries", async (accessClass) => {
    const context = executionContext();
    const bridge = new EngineeringInspectionBridge(context, creationEnv());
    await createOrg(bridge);
    await createChannel(bridge);
    const created = await bridge.createThread({ operationId: THREAD_OPERATION, creatorUserId: CREATOR,
      orgId: ORG, channelId: CHANNEL, prompt: PROMPT });
    const client = await settledThread(created.threadId);
    // Use the product's participant-grant migration and sharing entrance.
    await expect.poll(() => workspace().beginMainParticipantMigration({ workspaceId: ORG, parentId: created.threadId }), { timeout: 10_000 })
      .toMatchObject({ status: "complete" });
    await client.addParticipant(MEMBER);
    if (accessClass === "guest") {
      await bridge.createChannel({ operationId: "00000000-0000-7000-8000-00000000ee0a", creatorUserId: CREATOR,
        orgId: ORG, name: "Unshared", participantUserIds: [] });
      await changeRelationships(creationEnv(), ORG, [MEMBER], env.DB.prepare(
        "UPDATE workspace_members SET role = NULL, access_class = 'guest', revision = revision + 1 WHERE workspace_id = ? AND user_id = ?").bind(ORG, MEMBER));
    }
    const request = { orgId: ORG, userId: MEMBER, threadId: created.threadId,
      operationId: "00000000-0000-7000-8000-00000000ee08", text: "Please add the release owner.", runMode: "queue" };
    await bridge.sendMessage(request);
    await bridge.sendMessage(request);
    const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", ORG, created.threadId, asSubstreamId("0")));
    await runDurableObjectAlarm(stub);
    await expect.poll(async () => (await client.readTranscript({ afterSequence: 0 })).range.turns
      .filter((turn) => turn.actor === "assistant").flatMap((turn) => turn.blocks).filter((block) => block.type === "text" && block.text === "Start with the release checklist.").length,
    { timeout: 10_000 }).toBe(2);
    await expect.poll(async () => (await client.get()).harnessStatus, { timeout: 10_000 }).toBe("completed");
    const turns = (await client.readTranscript({ afterSequence: 0 })).range.turns;
    const sent = turns.filter((turn) => turn.clientMessageId === request.operationId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ actor: "human", authorUserId: MEMBER,
      authorSnapshot: { displayName: "Member Two" }, blocks: [expect.objectContaining({ text: request.text })] });
    expect((await bridge.readConversation({ orgId: ORG, userId: MEMBER, threadId: created.threadId })).text)
      .toContain("Member Two ·");
    await deliverEffectsToWorkspace(creationEnv(), stub);
    expect((await bridge.listUserConversations({ orgId: ORG, userId: MEMBER, channelId: CHANNEL, kind: "channel" })).items.map((item) => item.id))
      .toEqual([THREAD_OPERATION]);
    // This fixture's converted guest retains their original explicit General
    // seat, but gains neither Unshared nor their former Personal Channel.
    if (accessClass === "guest") expect((await bridge.listUserChannels({ orgId: ORG, userId: MEMBER })).items.map((item) => item.name).sort()).toEqual(["General", "Releases"]);
    await waitOnExecutionContext(context);
  });

  it("reads the app's Channel feed and independently authorizes, sends to, and pages a private Breakout", async () => {
    const context = executionContext();
    const bridge = new EngineeringInspectionBridge(context, creationEnv());
    await createOrg(bridge);
    await createChannel(bridge);
    const created = await bridge.createThread({ operationId: THREAD_OPERATION, creatorUserId: CREATOR,
      orgId: ORG, channelId: CHANNEL, prompt: PROMPT });
    const client = await settledThread(created.threadId);
    const channel = await bridge.readChannel({ orgId: ORG, userId: MEMBER, channelId: CHANNEL });
    expect(channel.text).toContain("Channel: Releases");
    expect(channel.text).toContain("Thread: ");
    expect(channel.text).toContain("Help us plan the release.");
    expect(channel.text).not.toContain("Start with the release checklist.");
    const page = await bridge.readConversation({ orgId: ORG, userId: MEMBER, threadId: created.threadId, limit: 1 });
    expect(page.text).toContain(PROMPT);
    expect(page.text).toContain("afterSequence=1");
    const later = await bridge.readConversation({ orgId: ORG, userId: MEMBER, threadId: created.threadId, afterSequence: 1 });
    expect(later.text).toContain("Start with the release checklist.");
    expect(later.text.slice(later.text.indexOf("\n\n"))).not.toContain(PROMPT);
    const service = new SubstreamCreationService(creationEnv(), auth());
    const prepared = await service.prepare(created.threadId, { operationId: crypto.randomUUID(), title: "Private release", throughTurnId: null });
    const child = await service.confirm(created.threadId, prepared.operationId);
    await deliverEffectsToWorkspace(creationEnv(), env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", ORG, created.threadId, asSubstreamId(child.substreamId))));
    expect((await bridge.listUserConversations({ orgId: ORG, userId: CREATOR, channelId: CHANNEL, kind: "breakout" })).items
      .map((item) => ({ id: item.id, parentId: item.breakoutOf?.workstreamId }))).toEqual([{ id: child.substreamId, parentId: THREAD_OPERATION }]);
    expect((await bridge.listUserConversations({ orgId: ORG, userId: MEMBER, channelId: CHANNEL, kind: "breakout" })).items).toEqual([]);
    const target = { orgId: ORG, userId: CREATOR, threadId: created.threadId, breakoutId: child.substreamId };
    await expect(bridge.readConversation({ ...target, userId: MEMBER })).rejects.toThrow();
    await expect(bridge.sendMessage({ ...target, userId: MEMBER, operationId: crypto.randomUUID(), text: "Must not post" })).rejects.toThrow();
    await bridge.sendMessage({ ...target, operationId: crypto.randomUUID(), text: "A private launch note.", runMode: "queue" });
    await expect.poll(async () => (await bridge.readConversation(target)).text, { timeout: 10_000 }).toContain("A private launch note.");
    expect((await bridge.readConversation({ orgId: ORG, userId: CREATOR, threadId: created.threadId })).text).not.toContain("A private launch note.");
    expect((await client.readTranscript({ afterSequence: 0, throughSequence: 1 })).range.turns).toHaveLength(1);
    const childClient = new WorkstreamObjectClient(creationEnv(), auth(), created.threadId, child.substreamId);
    await expect.poll(async () => (await childClient.get()).harnessStatus, { timeout: 10_000 }).toBe("completed");
    await waitOnExecutionContext(context);
  });

});
