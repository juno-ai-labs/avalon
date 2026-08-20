import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { startWorkstreamWorkflow } from "../src/services/integrations";
import { launchWorkstreamHarness, WorkstreamService } from "../src/services/workstream-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { openWorkstreamAuthorityForTest, testSubstreamAgentsBinding } from "./helpers/durable-authority";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const memberId = asUserId("00000000-0000-7000-8000-000000000002");
const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000003");
const at = "2026-08-12T09:00:00.000Z";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

const auth: AuthContext = {
  sessionId: "session-1",
  userId: memberId,
  workspaceId,
  region: "global",
  role: "member",
};

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${memberId}', 'google-member', 'member@example.com', 'Member', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Avalon Studio', 'avalon-studio', 'global', '${memberId}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${workspaceId}', '${memberId}', 'owner', 'active', '${at}');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
       email_address, email_route_status, last_activity_at, created_at, updated_at)
    VALUES ('${workstreamId}', '${workspaceId}', 'A work stream', 'Do the thing', 'ad_hoc',
            '${memberId}', 'idle', 'calm-otter@automation.with-avalon.com', 'active',
            '${at}', '${at}', '${at}');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${workstreamId}', '${memberId}', '${memberId}', 'creator', '${at}');
  `);
}

/**
 * The pre-Durable-Object execution arms are gone. Production opened the
 * authority in both regions and a local stack reaches the same state with
 * `pnpm db:open-authority`; a stack that skipped that step is unsupported, and
 * the product surface has to refuse loudly rather than run code that no longer
 * exists. Directory reads over the regional `workstreams` index are the
 * deliberate exception — they are control-plane, not product state.
 */
describe("a stack that never opened the durable-object authority", () => {
  const refusal = { status: 503, code: "workstream_authority_not_open" };

  function legacyEnv(): { database: DatabaseSync; env: Env } {
    const database = migratedSqliteDatabase();
    databases.push(database);
    seed(database);
    return { database, env: createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" }) };
  }

  it("refuses every product call with the same 503, naming the fix", async () => {
    const { env } = legacyEnv();
    const service = new WorkstreamService(env, auth);
    const elicitationId = "00000000-0000-7000-8000-0000000000e1";
    const calls: Array<Promise<unknown>> = [
      service.get(workstreamId),
      service.context(workstreamId),
      service.update(workstreamId, { title: "Renamed" }),
      service.messages(workstreamId, 10),
      service.acknowledgeRead(workstreamId, {
        readThroughSequenceNumber: 0,
        observedManualUnreadGeneration: 0,
        entrypoint: undefined,
      }),
      service.markUnread(workstreamId),
      service.createMessage(workstreamId, {
        text: "hello",
        clientMessageId: "client-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      }),
      service.addParticipant(workstreamId, memberId),
      service.removeParticipant(workstreamId, memberId),
      service.attachResource(workstreamId, "00000000-0000-7000-8000-0000000000f1"),
      service.detachResource(workstreamId, "00000000-0000-7000-8000-0000000000f1"),
      service.answerElicitation(workstreamId, elicitationId, { answer: "yes" }),
      service.stop(workstreamId),
      service.retry(workstreamId),
      service.create({
        openingMessage: "Start",
        clientMessageId: "client-2",
        mentions: [],
        participantUserIds: [],
        attachmentIds: [],
      } as never),
      service.createFromOpportunity({
        opportunityId: "00000000-0000-7000-8000-0000000000a1",
        version: 1,
        displayPrompt: "Prompt",
        executionPrompt: "Prompt",
        displayPromptHash: "hash",
        executionPromptHash: "hash",
        idempotencyKey: "key",
      }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject(refusal);
    }
  });

  it("refuses a run launch before writing any admission row", async () => {
    const { database, env } = legacyEnv();

    await expect(launchWorkstreamHarness(env, {
      workspaceId,
      workstreamId,
      triggerMessageId: null,
      origin: "human_message",
      executionPrincipal: { type: "user", userId: memberId },
    })).rejects.toMatchObject(refusal);
    await expect(startWorkstreamWorkflow(env, {
      region: "global",
      workspaceId,
      workstreamId,
      harnessRunId: asHarnessRunId("00000000-0000-7000-8000-0000000000b1"),
      triggerMessageId: null,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: memberId },
      reason: "test",
    })).rejects.toMatchObject(refusal);

    expect(database.prepare("SELECT COUNT(*) AS count FROM harness_runs").get())
      .toEqual({ count: 0 });
  });

  it("still serves the regional directory index", async () => {
    const { env } = legacyEnv();
    const service = new WorkstreamService(env, auth);

    const page = await service.list(10);

    expect(page.items.map((item) => item.id)).toEqual([workstreamId]);
  });
});

describe("launching a run against the open authority", () => {
  it("persists static member-safe copy while logging launch diagnostics", async () => {
    const database = migratedSqliteDatabase();
    databases.push(database);
    openWorkstreamAuthorityForTest(database);
    seed(database);
    const diagnostic = "provider response included a private upstream detail";
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, {
        failDispatch: () => {
          throw new Error(diagnostic);
        },
      }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(launchWorkstreamHarness(env, {
      workspaceId,
      workstreamId,
      triggerMessageId: null,
      origin: "human_message",
      executionPrincipal: { type: "user", userId: memberId },
    })).rejects.toMatchObject({
      status: 503,
      code: "workflow_unavailable",
      message: "The Avalon harness could not be started",
    });

    const row = database.prepare(
      "SELECT id, status, error_json FROM harness_runs WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(workstreamId) as { id: string; status: string; error_json: string };
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.error_json)).toEqual({
      code: "workflow_unavailable",
      message: "Avalon could not start this run",
    });
    expect(row.error_json).not.toContain(diagnostic);
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: "workstream_harness_launch_failed",
      request_id: row.id,
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      error_name: "Error",
      error_message: diagnostic,
    }));
  });
});
