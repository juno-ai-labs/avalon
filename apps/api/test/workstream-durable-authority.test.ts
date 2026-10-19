import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { launchWorkstreamHarness, WorkstreamService } from "../src/services/workstream-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  openWorkstreamAuthorityForTest,
  testSubstreamAgentsBinding,
  workstreamObjectGet,
} from "./helpers/durable-authority";

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

/** Creation still needs the regional generation and refuses an unopened stack. */
describe("creation before the durable-object authority opens", () => {
  it("refuses before opening an object", async () => {
    const database = preRetirementProductSqliteDatabase();
    databases.push(database);
    seed(database);
    const objectStores = new Map<string, DatabaseSync>();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    });

    await expect(new WorkstreamService(env, auth).create({
      openingMessage: "Start",
      clientMessageId: "client-2",
      mentions: [],
      participantUserIds: [],
      attachmentIds: [],
    } as never)).rejects.toMatchObject({ status: 503, code: "workstream_maintenance" });
    expect(objectStores.size).toBe(0);
  });
});

describe("launching a run against the open authority", () => {
  it("keeps a durably recorded activation replayable when the activation response is lost", async () => {
    const database = preRetirementProductSqliteDatabase();
    databases.push(database);
    openWorkstreamAuthorityForTest(database);
    seed(database);
    const diagnostic = "provider response included a private upstream detail";
    let loseFirstActivationResponse = true;
    const objectStores = new Map<string, DatabaseSync>();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, {
        objectStores,
        failDispatch: () => {
          if (loseFirstActivationResponse) {
            loseFirstActivationResponse = false;
            throw new Error(diagnostic);
          }
          return null;
        },
      }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(launchWorkstreamHarness(env, {
      workspaceId,
      workstreamId,
      triggerMessageId: null,
      origin: "scheduled_wakeup",
      executionPrincipal: { type: "user", userId: memberId },
      scheduledWakeupId: "00000000-0000-7000-8000-0000000000e1",
      conversation: { parentKind: "workstream", substreamId: "0", backgroundAgent: false },
    })).rejects.toThrow(diagnostic);

    const objectStore = objectStores.get(workstreamId);
    if (!objectStore) throw new Error("expected the launch to open the work-stream object");
    databases.push(objectStore);
    const row = workstreamObjectGet(
      objectStore,
      "SELECT run_id AS id, status, error_json FROM runs ORDER BY created_at DESC LIMIT 1",
    ) as { id: string; status: string; error_json: string | null };
    expect(row).toMatchObject({ status: "running", error_json: null });
    await expect(launchWorkstreamHarness(env, {
      workspaceId,
      workstreamId,
      triggerMessageId: null,
      origin: "scheduled_wakeup",
      executionPrincipal: { type: "user", userId: memberId },
      scheduledWakeupId: "00000000-0000-7000-8000-0000000000e1",
      conversation: { parentKind: "workstream", substreamId: "0", backgroundAgent: false },
    })).resolves.toBe(row.id);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM runs",
    )).toEqual({ count: 1 });
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
