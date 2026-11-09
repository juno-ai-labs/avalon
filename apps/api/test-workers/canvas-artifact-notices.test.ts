/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A new version of a Canvas's artifact tells the people who pinned the
 * Canvas, on real workerd: the version is written through the object's own
 * runtime-SQL port, as a Terminal republish writes it, and its publish notes
 * the Canvas through the RPC production calls (`canvasNoteArtifact`). Each
 * pinner but the version's author gets one `artifact_updated` intent and an
 * Activity row that collapses while unseen and clears on a read of the Chat;
 * the push names the artifact and opens the Canvas onto it.
 * `docs/canvases.md` owns the rule.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId, type CanvasEditor } from "@rally/contracts";
import { ConversationEffectEnvelopeSchema, conversationEffectHash, WorkstreamDirectoryUserEffectSchema } from "@rally/contracts/conversation-effects";

import migration from "../../../packages/db/migrations/0107_user_push_devices.sql?raw";
import webPushMigration from "../../../packages/db/migrations/0117_web_push_device_keys.sql?raw";
import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { AuthContext } from "../src/env";
import { splitSqlStatements } from "../src/lib/sql-statements";
import { deliverPush } from "../src/queues/push-delivery-consumer";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { registerPushDevice } from "../src/services/push-device-service";
import type { ApnsOutcome } from "../src/services/push/apns-transport";
import type { PushPayloads } from "../src/services/push/push-payload";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000ed000");
const AUTHOR = asUserId("00000000-0000-7000-8000-0000000ed001");
const PINNER = asUserId("00000000-0000-7000-8000-0000000ed002");
const CANVAS = "00000000-0000-7000-8000-0000000ed0c1";
const REPORT = "00000000-0000-7000-8000-0000000ed0a1";
const RUN = "00000000-0000-7000-8000-0000000ed0f1";
const NOW = "2026-11-08T10:00:00.000Z";

const flags = createTestEnv({ FLAGS: { getBooleanDetails: async () => ({ value: true, reason: "TARGETING_MATCH" }) } }).FLAGS!;
/** An environment that may send push, as `hosted-mention-notifications.test.ts` builds it. */
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

let requests = 0;
async function runSql(sql: string, params: Array<string | number | null>): Promise<void> {
  requests += 1;
  await workspace().executeRuntimeSql({ workspaceId: WORKSPACE_ID, requestId: `00000000-0000-7000-8000-${String(requests).padStart(12, "0")}`,
    statements: [{ sql, params }] });
}

/** A version of the report, written as a republish writes it, then noted to the Canvas as its publish notes it. */
async function publish(version: number, author: { kind: "member"; userId: string } | { kind: "agent" }, editor: CanvasEditor): Promise<void> {
  await runSql(
    `UPDATE resources SET revision_author_kind = ?, revision_author_user_id = ?, revision_author_run_id = ?, revision_cause = 'published',
            content_ref = ?, content_sha256 = ?, updated_at = ? WHERE id = ?`,
    [author.kind, author.kind === "member" ? author.userId : null, author.kind === "agent" ? RUN : null, `v${version}`, `v${version}`,
      new Date(Date.parse(NOW) + version * 1_000).toISOString(), REPORT],
  );
  expect(await workspace().canvasNoteArtifact({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, resourceId: REPORT, editor }))
    .toEqual({ noted: true });
}

async function intents(): Promise<Array<{ intent_id: string; recipient_user_id: string; state: string }>> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ intent_id: string; recipient_user_id: string; state: string }>(
    `SELECT intent_id, recipient_user_id, state FROM workstream_notification_intents
      WHERE notification_kind = 'artifact_updated' ORDER BY created_at, intent_id`).toArray());
}

/** The Activity this person's workspace socket is opened with. */
async function openedActivity(userId: string): Promise<{ unseenCount: number; items: Array<Record<string, unknown>> }> {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId, "x-rally-session-id": `session-${userId}`, "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const sync = await new Promise<{ sidebar: { activity: { unseenCount: number; items: Array<Record<string, unknown>> } } }>((resolve) => {
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type?: string };
      if (frame.type === "workspace_sync") resolve(frame as never);
    });
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  });
  socket.close(1000, "done");
  return sync.sidebar.activity;
}

/** The pinner's read of the Chat, as the Chat's conversation reports it to the Canvas. */
async function readChat(sourceVersion: number): Promise<void> {
  const effect = WorkstreamDirectoryUserEffectSchema.parse({
    kind: "directory_user", userId: PINNER, isParticipant: true, unreadCount: 0, youAreMentioned: false, listable: true,
    seenAttentionOrdinal: 0, lastReadAt: new Date().toISOString(),
  });
  await workspace().receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes: [ConversationEffectEnvelopeSchema.parse({
    kind: "conversation_effect", contractVersion: 1, region: "global", workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: CANVAS,
    substreamId: "0", generation: 1, messageId: `read:${sourceVersion}`, partitionKey: `user:${PINNER}`, sourceVersion,
    requiredProjectionVersion: null, payloadHash: conversationEffectHash(effect), effect,
  })] });
}

beforeEach(async () => {
  await reset();
  clearFlagTargetingAttributeCache();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR, sessionId: `session-${AUTHOR}` });
  await env.DB.batch([
    env.DB.prepare(`ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'`),
    env.DB.prepare(`UPDATE users SET name = 'Avery' WHERE id = ?`).bind(AUTHOR),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at) VALUES (?, 'robin@example.com', 'Robin', NULL, 'UTC', ?)`)
      .bind(PINNER, NOW),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at) VALUES (?, ?, 'active', 'member', ?)`)
      .bind(WORKSPACE_ID, PINNER, NOW),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(`session-${PINNER}`, PINNER, WORKSPACE_ID),
    ...[migration, webPushMigration].flatMap(splitSqlStatements).map((sql) => env.DB.prepare(sql)),
  ]);
  await registerPushDevice(pushEnv(), auth(PINNER), "pp", {
    platform: "macos", transport: "apns", topic: "ai.rallywith.desktop", apnsEnvironment: "production", token: "pp".repeat(32), appVersion: "1",
  });
  await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, title: "Launch", createdByUserId: AUTHOR, authorityGeneration: 1 });
  await workspace().canvasSetAudience({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, actor: { userId: AUTHOR, actorRole: "member" },
    update: { visibility: "participants", userIds: [PINNER] } });
  for (const userId of [AUTHOR, PINNER]) {
    expect(await workspace().setSidebarPin({ workspaceId: WORKSPACE_ID, userId, accessClass: "member", kind: "canvas", itemId: CANVAS, pinned: true }))
      .toEqual({ ok: true });
  }
  await runSql(
    `INSERT INTO resources (id, workspace_id, resource_type, provider, title, mime_type, metadata_json, content_ref, created_at, updated_at)
     VALUES (?, ?, 'generated_file', 'avalon', 'Launch report', 'text/markdown', '{"size":10}', 'v1', ?, ?)`,
    [REPORT, WORKSPACE_ID, NOW, NOW],
  );
  await workspace().canvasNoteArtifact({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, resourceId: REPORT, editor: { kind: "rally", id: null } });
});

describe("a pinned Canvas's new version", () => {
  it("tells each pinner but its author, collapses while unseen, clears on a read of the Chat, and opens onto the artifact", async () => {
    // The first version is a new artifact, not news.
    expect(await intents()).toEqual([]);

    await publish(2, { kind: "member", userId: AUTHOR }, { kind: "person", id: AUTHOR });
    expect(await intents()).toEqual([{ intent_id: `artifact_updated:${REPORT}:2:${PINNER}`, recipient_user_id: PINNER, state: "delivered" }]);
    expect(await openedActivity(PINNER)).toMatchObject({ unseenCount: 1, items: [{
      id: `artifact_updated:${REPORT}:2:${PINNER}`, kind: "artifact_updated", parentKind: "canvas", parentId: CANVAS, parentTitle: "Launch",
      substreamId: "0", actor: { kind: "person", id: AUTHOR }, artifact: { resourceId: REPORT, title: "Launch report" }, seen: false,
    }] });
    expect((await openedActivity(AUTHOR)).items).toEqual([]);

    const send = vi.fn(async (): Promise<ApnsOutcome> => ({ outcome: "sent" }));
    expect(await deliverPush(pushEnv(), { region: "global", workspaceId: WORKSPACE_ID, recipientUserId: PINNER,
      intentId: `artifact_updated:${REPORT}:2:${PINNER}` }, send)).toBe(true);
    const apns = JSON.parse(((send.mock.calls[0] as unknown[])[2] as PushPayloads).apns) as { aps: { alert: { title: string } }; rally: { url: string } };
    expect(apns.aps.alert.title).toBe("Avery updated Launch report in Launch");
    expect(apns.rally.url).toMatch(/\/cv\/[1-9A-Za-z]+\/a\/[1-9A-Za-z]+\/$/u);

    // Rally's version while the row is unseen moves that row rather than adding one.
    await publish(3, { kind: "agent" }, { kind: "rally", id: null });
    expect(await openedActivity(PINNER)).toMatchObject({ unseenCount: 1, items: [{
      id: `artifact_updated:${REPORT}:2:${PINNER}`, actor: { kind: "rally", id: null }, seen: false,
    }] });

    await readChat(1);
    expect(await openedActivity(PINNER)).toMatchObject({ unseenCount: 0, items: [{ kind: "artifact_updated", seen: true }] });

    await publish(4, { kind: "agent" }, { kind: "rally", id: null });
    expect(await openedActivity(PINNER)).toMatchObject({ unseenCount: 1, items: [
      { id: `artifact_updated:${REPORT}:4:${PINNER}`, seen: false }, { id: `artifact_updated:${REPORT}:2:${PINNER}`, seen: true },
    ] });
  });
});
