/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A mention in a Canvas's Chat or a Sidekick's shared conversation, end to
 * end: a person posts in the conversation object, its `mention_notification`
 * effect leaves on the activity Queue, the real consumer hands it to the
 * hosted parent in the Organization object, the parent records the intent
 * beside the effect's receipt, and the consumer delivers it, which enqueues
 * the push that the push consumer then sends. Real workerd throughout; only
 * the Apple transport is a double.
 *
 * `push-delivery.test.ts` and the Node delivery tests seed the intent row
 * directly, so they could not see that nothing recorded one: this file is the
 * case that starts from the message.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, type AutomationDraft } from "@rally/contracts";
import type { PushDeliveryMessage } from "@rally/contracts/push-notifications";

import migration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import webPushMigration from "../../../packages/db/migrations/0117_web_push_device_keys.sql?raw";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext, Env } from "../src/env";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { deliverPush } from "../src/queues/push-delivery-consumer";
import { createAutomation } from "../src/services/automation-service";
import { createCanvas } from "../src/services/canvas-service";
import { ConversationService } from "../src/services/conversation-service";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { registerPushDevice } from "../src/services/push-device-service";
import type { ApnsOutcome } from "../src/services/push/apns-transport";
import type { PushPayloads } from "../src/services/push/push-payload";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { consumeEffectBodies, deliverChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ce000");
const AUTHOR = asUserId("00000000-0000-7000-8000-0000000ce001");
const RECIPIENT = asUserId("00000000-0000-7000-8000-0000000ce002");
const NOW = "2026-11-07T10:00:00.000Z";
const TEST_ENV: Env = env;
useHeldEffectQueue();
useOpenRouterDouble(() => ({ say: "Noted." }));
useSelectedModel();

const flags = createTestEnv({ FLAGS: { getBooleanDetails: async () => ({ value: true, reason: "TARGETING_MATCH" }) } }).FLAGS!;
/**
 * An environment that may send push: staging, with Apple configured and the
 * flag on. Local workerd cannot select a jurisdiction, which staging asks
 * for, so the Organization namespace answers it with itself.
 */
const pushEnv = () => ({
  ...env, FLAGS: flags, APP_ENV: "staging" as const, APNS_AUTH_KEY: "configured", APNS_KEY_ID: "configured",
  WORKSPACE_DOS: createTestEnv({ WORKSPACE_DOS: { jurisdiction: () => env.WORKSPACE_DOS } }).WORKSPACE_DOS,
});

function auth(userId: string): AuthContext {
  return { sessionId: `session-${userId}`, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global", role: "member" };
}

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

function conversation(parentId: string): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, parentId, asSubstreamId("0"))));
}

/** The author's message mentioning the recipient, sent the way the Worker sends it. */
async function mention(parentKind: "canvas" | "automation", parentId: string, clientMessageId: string): Promise<void> {
  const text = "@Robin please review the plan";
  const response = await conversation(parentId).fetch("https://object.test/internal/product", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "create_message", parentKind, auth: auth(AUTHOR), input: {
      text, clientMessageId, confirmedParticipantUserIds: [], attachmentIds: [],
      mentions: [{ type: "person", userId: RECIPIENT, connectorType: null, displayName: "Robin", startOffset: 0, endOffset: 6 }],
    } }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await runDurableObjectAlarm(conversation(parentId));
}

/** The Organization object's intents for the recipient, as the push consumer reads them. */
async function recipientIntents(): Promise<{ intent_id: string; workstream_id: string; recipient_user_id: string; notification_kind: string }[]> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
    intent_id: string; workstream_id: string; recipient_user_id: string; notification_kind: string;
  }>(`SELECT intent_id, workstream_id, recipient_user_id, notification_kind FROM workstream_notification_intents
       WHERE recipient_user_id = ? ORDER BY created_at`, RECIPIENT).toArray());
}

/**
 * Deliver the conversation's effects through the real consumer, twice, then
 * send the push its mention enqueued, and return each alert.
 */
async function pushedAlert(parentId: string): Promise<{ title: string; body: string }[]> {
  const sendQueue = vi.spyOn(env.PUSH_DELIVERY_QUEUE!, "send") as unknown as { mock: { calls: [PushDeliveryMessage][] } };
  const delivered = await deliverChildEffects(pushEnv(), conversation(parentId));
  expect(delivered.map((envelope) => envelope.effect.kind)).toContain("mention_notification");
  // The Queue redelivers: the receipt answers each envelope, the parent names
  // the intent again, and its settled state sends nothing a second time.
  expect(await consumeEffectBodies(pushEnv(), delivered)).toEqual({ acked: delivered.length, retried: 0 });
  const intents = await recipientIntents();
  expect(intents).toEqual([{
    intent_id: expect.stringMatching(/^mention:/u), workstream_id: parentId, recipient_user_id: RECIPIENT, notification_kind: "mention",
  }]);
  const [intent] = intents;
  // Processing the intent enqueued exactly one push for the recipient.
  expect(sendQueue.mock.calls.map((call) => call[0])).toEqual([
    { region: "global", workspaceId: WORKSPACE_ID, recipientUserId: RECIPIENT, intentId: intent!.intent_id },
  ]);
  const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
  expect(await deliverPush(pushEnv(), sendQueue.mock.calls[0]![0], send)).toBe(true);
  return send.mock.calls.map((call) => JSON.parse(((call as unknown[])[2] as PushPayloads).apns) as { aps: { alert: { title: string; body: string } } })
    .map((payload) => payload.aps.alert);
}

beforeEach(async () => {
  await reset();
  clearFlagTargetingAttributeCache();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR, sessionId: `session-${AUTHOR}` });
  await env.DB.batch([
    // The delivery step names the Organization and the recipient in Slack and email.
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN name TEXT`),
    // Staging names a placement, which the push environment below is.
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    env.DB.prepare(`UPDATE workspaces SET name = 'Mentions' WHERE id = ?`).bind(WORKSPACE_ID),
    env.DB.prepare(`UPDATE users SET name = 'Avery' WHERE id = ?`).bind(AUTHOR),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'robin@example.com', 'Robin', NULL, 'UTC', ?)`).bind(RECIPIENT, NOW),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, RECIPIENT, NOW),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${RECIPIENT}`, RECIPIENT, WORKSPACE_ID),
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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map((sql) => env.DB.prepare(sql)),
  ]);
  await registerPushDevice(pushEnv(), auth(RECIPIENT), "rr", {
    platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production",
    token: "rr".repeat(32), appVersion: "1",
  });
});

describe("a mention in a hosted conversation", () => {
  it("records the recipient's intent from a Canvas Chat mention and sends its push", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: AUTHOR, title: "Launch plan" });
    await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId, actor: { userId: AUTHOR, actorRole: "member" },
      update: { visibility: "participants", userIds: [RECIPIENT] } });
    // Both can open it; each is seated the way the conversation route seats them.
    for (const userId of [AUTHOR, RECIPIENT]) await new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(canvasId);
    await mention("canvas", canvasId, "canvas-mention-1");

    expect(await pushedAlert(canvasId)).toEqual([{ title: "Avery mentioned you in Launch plan", body: "@Robin please review the plan" }]);
  });

  it("records the recipient's intent from a Sidekick shared-conversation mention", async () => {
    const automationId = asAutomationId(crypto.randomUUID());
    await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR, scope: "workspace", automationId });
    await workspace().sidekickSubmitDefinition({ workspaceId: WORKSPACE_ID, automationId, draft: DEFINITION,
      evaluatorRules: null, submittedByRunId: null });
    await runInDurableObject(workspace(), (instance: WorkspaceDO) => instance.sidekickApply({
      workspaceId: WORKSPACE_ID, automationId, actor: { userId: AUTHOR, actorRole: "member", participantOfOwningWorkstream: false } }));
    for (const userId of [AUTHOR, RECIPIENT]) await new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(automationId);
    await mention("automation", automationId, "sidekick-mention-1");

    // The title is the conversation's own snapshot, taken when it was opened,
    // before the definition named the Sidekick.
    expect(await pushedAlert(automationId)).toEqual([{ title: "Avery mentioned you in New Sidekick", body: "@Robin please review the plan" }]);
  });
});

const DEFINITION: AutomationDraft = {
  name: "Release notes",
  description: "Answers questions about releases",
  overview: "Answers questions about releases",
  instructions: "Answer the question you were asked about releases.",
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
