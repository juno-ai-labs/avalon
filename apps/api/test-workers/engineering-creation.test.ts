/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { AuthContext, Env } from "../src/env";
import type { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { createCanvas } from "../src/services/canvas-service";
import { ConversationService } from "../src/services/conversation-service";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { changeRelationships } from "./helpers/workspace-relationship-events";
import { ensureAuditSchema } from "./helpers/audit-fixture";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";

const ORIGINAL_ORG = asWorkspaceId("00000000-0000-7000-8000-00000000ee01");
const CREATOR = asUserId("00000000-0000-7000-8000-00000000ee02");
const MEMBER = asUserId("00000000-0000-7000-8000-00000000ee03");
const ORG = asWorkspaceId("00000000-0000-7000-8000-00000000ee04");
const CANVAS = "00000000-0000-7000-8000-00000000ee05";
const UNKNOWN_USER = "00000000-0000-7000-8000-00000000ee06";
const OPERATOR = { subject: "access-engineer", email: "engineer@example.com", audience: "engineering-mcp" };
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
let iconGate: Promise<void> | undefined;
const provider = useOpenRouterDouble(async (call) => {
  if (!call.stream && iconGate) await iconGate;
  const format = JSON.stringify(call.body.response_format ?? {});
  return { say: call.stream ? "Start with the release checklist."
    : format.includes("message_addressing") ? JSON.stringify({ classification: "agent_action", confidence: 1, rationaleCode: "imperative" })
    : JSON.stringify({ title: "Release plan", icon: "rocket", ...(format.includes('"summary"') ? { summary: "Plan the release." } : {}) }) };
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
  return bridge.createOrg({ operationId: ORG, creatorUserId: CREATOR, region: "global", name: "Launch team", userIds: [MEMBER] }, OPERATOR);
}

/** A Canvas whose Chat holds the opening prompt and Rally's answer, with `MEMBER` on its list. */
async function settledCanvas(bridge: EngineeringInspectionBridge) {
  await createCanvas(creationEnv(), { workspaceId: ORG, creatorUserId: CREATOR, canvasId: CANVAS, title: "Releases" });
  await workspace().canvasSetAudience({ workspaceId: ORG, canvasId: CANVAS, actor: { userId: CREATOR, actorRole: "member" },
    update: { visibility: "participants", userIds: [MEMBER] } });
  await bridge.sendMessage({ orgId: ORG, userId: CREATOR, threadId: CANVAS, operationId: "00000000-0000-7000-8000-00000000ee07",
    text: PROMPT, runMode: "queue" }, OPERATOR);
  const client = await new ConversationService(creationEnv(), auth()).client(CANVAS);
  await runDurableObjectAlarm(canvasChat());
  await expect.poll(async () => assistantTexts(await client.boot()).length,
  // Parent handoff, alarm delivery and the provider round trip, below the test budget.
  { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await client.get()).harnessStatus, { timeout: 10_000 }).toBe("completed");
  return client;
}

function canvasChat() {
  return env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", ORG, CANVAS, asSubstreamId("0")));
}

function assistantTexts(boot: Awaited<ReturnType<WorkstreamObjectClient["boot"]>>): string[] {
  return boot.transcript.ranges.flatMap((range) => range.turns).filter((turn) => turn.actor === "assistant")
    .flatMap((turn) => turn.blocks).flatMap((block) => block.type === "text" ? [block.text] : []);
}

beforeEach(async () => {
  iconGate = undefined;
  await reset();
  await ensureAuditSchema();
  await env.AUDIT_DB.prepare("DELETE FROM audit_events WHERE workspace_id = ?").bind(ORG).run();
  await seedInspectableWorkspace(env.DB, { workspaceId: ORIGINAL_ORG, userId: CREATOR, sessionId: "engineering-test", at: "2026-10-21T00:00:00.000Z" });
  await env.DB.batch([
    env.DB.prepare("ALTER TABLE users ADD COLUMN platform_user_id TEXT"),
    env.DB.prepare("ALTER TABLE users ADD COLUMN google_subject TEXT"),
    env.DB.prepare("UPDATE users SET platform_user_id = 'platform-creator' WHERE id = ?").bind(CREATOR),
    env.DB.prepare("INSERT INTO users (id, email, name, timezone, created_at, platform_user_id) VALUES (?, 'member2@example.com', 'Member Two', 'UTC', '2026-10-21T00:00:00.000Z', 'platform-member')").bind(MEMBER),
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

describe("engineering Organization creation", () => {
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
    const audits = (await env.AUDIT_DB.prepare(
      "SELECT action, actor_type, actor_user_id, target_id, metadata_json FROM audit_events WHERE request_id = ? ORDER BY action",
    ).bind(ORG).all<{ action: string; actor_type: string; actor_user_id: string | null; target_id: string; metadata_json: string }>()).results;
    expect(audits.map(({ action, actor_type, actor_user_id, target_id }) => ({ action, actor_type, actor_user_id, target_id })))
      .toEqual([
        ...Array.from({ length: 2 }, () => ({ action: "engineering.create_org.attempt", actor_type: "system", actor_user_id: null, target_id: CREATOR })),
        ...Array.from({ length: 2 }, () => ({ action: "engineering.create_org.result", actor_type: "system", actor_user_id: null, target_id: CREATOR })),
      ]);
    expect(audits.map((row) => JSON.parse(row.metadata_json))).toEqual([
      ...Array.from({ length: 2 }, () => expect.objectContaining({ operator: OPERATOR, representedUserId: CREATOR, operationId: ORG, outcome: "attempted" })),
      ...Array.from({ length: 2 }, () => expect.objectContaining({ operator: OPERATOR, representedUserId: CREATOR, orgId: ORG, outcome: "admitted" })),
    ]);
  });


  it("requires a durable operator audit before creating product state", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    const request = { operationId: ORG, creatorUserId: CREATOR, region: "global", name: "Launch team", userIds: [MEMBER] };
    await expect(bridge.createOrg(request, undefined)).rejects.toThrow();
    await env.AUDIT_DB.prepare(`CREATE TRIGGER refuse_engineering_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'engineering.create_org.attempt' AND NEW.workspace_id = '${ORG}'
      BEGIN SELECT RAISE(ABORT, 'audit_write_unavailable'); END`).run();
    try {
      await expect(createOrg(bridge)).rejects.toThrow("audit_write_unavailable");
      expect((await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(ORG).all()).results).toEqual([]);
    } finally {
      await env.AUDIT_DB.prepare("DROP TRIGGER refuse_engineering_audit").run();
    }
  });


  it("rejects unknown users and mismatched regions before creating an Organization", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    const request = { operationId: ORG, creatorUserId: CREATOR, name: "Launch team", userIds: [UNKNOWN_USER], region: "global" };
    await expect(bridge.createOrg(request, OPERATOR)).rejects.toThrow("regional_user_not_found");
    await expect(bridge.createOrg({ ...request, region: "enterprise" }, OPERATOR)).rejects.toThrow("region_mismatch");
    expect((await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(ORG).all()).results).toEqual([]);
  });


  it("preserves the rejected field across the regional RPC boundary", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    await expect(bridge.createOrg({ operationId: ORG, creatorUserId: CREATOR, region: "global", name: "X", userIds: [] }, OPERATOR))
      .rejects.toThrow(/name:too_small/);
  });
});

describe("engineering messages in a Canvas's Chat", () => {
  it.each(["member", "guest"] as const)("admits an ordinary send as a %s, executes it, and deduplicates retries", async (accessClass) => {
    const context = executionContext();
    const bridge = new EngineeringInspectionBridge(context, creationEnv());
    await createOrg(bridge);
    const client = await settledCanvas(bridge);
    if (accessClass === "guest") {
      await changeRelationships(creationEnv(), ORG, [MEMBER], env.DB.prepare(
        "UPDATE workspace_members SET role = NULL, access_class = 'guest', revision = revision + 1 WHERE workspace_id = ? AND user_id = ?").bind(ORG, MEMBER));
    }
    const request = { orgId: ORG, userId: MEMBER, threadId: CANVAS,
      operationId: "00000000-0000-7000-8000-00000000ee08", text: "Please add the release owner.", runMode: "queue" };
    await bridge.sendMessage(request, OPERATOR);
    await bridge.sendMessage(request, OPERATOR);
    await runDurableObjectAlarm(canvasChat());
    await expect.poll(async () => assistantTexts(await client.boot()).length, { timeout: 10_000 }).toBe(2);
    await expect.poll(async () => (await client.get()).harnessStatus, { timeout: 10_000 }).toBe("completed");
    const turns = (await client.boot()).transcript.ranges.flatMap((range) => range.turns);
    const sent = turns.filter((turn) => turn.clientMessageId === request.operationId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ actor: "human", authorUserId: MEMBER,
      authorSnapshot: { displayName: "Member Two" }, blocks: [expect.objectContaining({ text: request.text })] });
    const audits = (await env.AUDIT_DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE request_id = ? AND action = 'engineering.send_message.result'",
    ).bind(request.operationId).all<{ metadata_json: string }>()).results;
    expect(audits.map((row) => JSON.parse(row.metadata_json))).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
      operator: OPERATOR, representedUserId: MEMBER, threadId: CANVAS, turnId: sent[0]!.turnId, outcome: "admitted",
    })));
    expect(JSON.stringify(audits)).not.toContain(request.text);
    expect((await bridge.readConversation({ orgId: ORG, userId: MEMBER, threadId: CANVAS })).text).toContain("Member Two ·");
    await waitOnExecutionContext(context);
  });

  it("refuses a send and a read as somebody the Canvas does not admit", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    await createOrg(bridge);
    await settledCanvas(bridge);
    await workspace().canvasSetAudience({ workspaceId: ORG, canvasId: CANVAS, actor: { userId: CREATOR, actorRole: "member" },
      update: { visibility: "creator", userIds: [] } });
    const target = { orgId: ORG, userId: MEMBER, threadId: CANVAS };
    await expect(bridge.readConversation(target)).rejects.toThrow();
    await expect(bridge.sendMessage({ ...target, operationId: crypto.randomUUID(), text: "Must not post" }, OPERATOR)).rejects.toThrow();
  });

  it("posts a record-only message for the Chat's readers without starting a run, where the same message alone would", async () => {
    const context = executionContext();
    const bridge = new EngineeringInspectionBridge(context, creationEnv());
    await createOrg(bridge);
    const client = await settledCanvas(bridge);
    const streamedBefore = provider.calls.filter((call) => call.stream).length;

    const request = { orgId: ORG, userId: CREATOR, threadId: CANVAS, recordOnly: true as const,
      operationId: "00000000-0000-7000-8000-00000000ee0b", text: "Decision: the export drops the legacy columns." };
    const sent = await bridge.sendMessage(request, OPERATOR);
    expect(sent.receipt.deliveryState).toBe("canonical");
    await runDurableObjectAlarm(canvasChat());
    await waitOnExecutionContext(context);

    const turns = (await client.boot()).transcript.ranges.flatMap((range) => range.turns);
    expect(turns.map((turn) => [turn.actor, turn.clientMessageId === request.operationId])).toEqual([
      ["human", false], ["assistant", false], ["human", true],
    ]);
    expect(provider.calls.filter((call) => call.stream).length).toBe(streamedBefore);
  });

  it("returns twenty text turns by default and continues under the same sequence fence", async () => {
    const bridge = new EngineeringInspectionBridge(executionContext(), creationEnv());
    await createOrg(bridge);
    await settledCanvas(bridge);
    await runInDurableObject(canvasChat(), async (_instance, state) => {
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      for (let index = 1; index <= 25; index++) {
        await transcript.appendParticipantMessage({ turnId: `history-${index}`, actor: "human", authorUserId: CREATOR,
          authorSnapshot: { displayName: "History author", avatarUrl: null }, text: `Historical message ${index}.`,
          createdAtUtc: "2026-10-21T00:00:00.000Z", attentionOrdinal: index + 1 });
      }
    });
    const first = await bridge.readConversation({ orgId: ORG, userId: CREATOR, threadId: CANVAS });
    expect(first.text).toContain("Historical message 18.");
    expect(first.text).not.toContain("Historical message 19.");
    expect(first.text).toContain("afterSequence=20 and throughSequence=27");
    const rest = await bridge.readConversation({ orgId: ORG, userId: CREATOR, threadId: CANVAS, afterSequence: 20, throughSequence: 27 });
    expect(rest.text).toContain("Historical message 19.");
    expect(rest.text).toContain("Historical message 25.");
    expect(rest.text).not.toContain("Historical message 18.");
    expect(rest.text).not.toContain("More history");
  });
});
