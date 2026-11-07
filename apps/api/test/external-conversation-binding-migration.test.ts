/**
 * WorkspaceDO migration 85: the external conversation binding table, and the
 * carry of every Slack Agent session's exact thread key into it.
 *
 * What a Node run proves here is the migration's SQL against the shipped
 * schema: a v79 object with sessions upgrades to exact thread bindings (never a
 * room binding, never a key rebuilt from a title), the table's CHECKs refuse
 * the shapes the storage never writes, and the storage module resolves the
 * migrated rows the way ingress will. Durable Object transaction behavior is
 * covered in `test-workers/external-conversation-bindings.test.ts`.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { ExternalConversationBindingStorage } from "../src/durable-objects/workspace-external-binding-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const BINDING_MIGRATION_VERSION = 85;
const WORKSPACE = "00000000-0000-7000-8000-0000000b1d00";
const CONNECTION = "00000000-0000-7000-8000-0000000b1d10";
const CHANNEL_WORKSTREAM = "00000000-0000-7000-8000-0000000b1d20";
const DM_WORKSTREAM = "00000000-0000-7000-8000-0000000b1d21";

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

function storageOver(database: DatabaseSync): ExternalConversationBindingStorage {
  const sql = createTestSqlStorage(database);
  return new ExternalConversationBindingStorage(createCloudflareTestBinding<DurableObjectStorage>({
    transactionSync: (body: () => unknown) => body(),
    sql,
  }));
}

function seedSession(database: DatabaseSync, input: {
  id: string; channelId: string; threadTs: string; workstreamId: string;
}): void {
  database.prepare(
    `INSERT INTO slack_agent_sessions
       (id, workspace_id, connection_id, linked_user_id, execution_scope,
        slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
        opening_client_message_id, workstream_id, invocation_kind, channel_type,
        context_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'workspace', 'T1', 'U1', ?, ?, 'event:opening', ?, 'app_mention',
             'public', '{}', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`,
  ).run(input.id, WORKSPACE, CONNECTION, input.channelId, input.threadTs, input.workstreamId);
}

describe("WorkspaceDO migration 85", () => {
  it("carries each session's exact thread key into an active thread binding, and infers no room", () => {
    const database = openDatabase();
    apply(database, BINDING_MIGRATION_VERSION - 1);
    database.prepare(
      `INSERT INTO workspace_identity
         (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, 'global', 'wnam', 0, 0)`,
    ).run(WORKSPACE);
    database.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, encrypted_credentials, credential_iv, credential_key_version,
          granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
          model_plugin_id)
       VALUES (?, ?, 'slack', 'workspace', NULL, 'T1', 'Slack', 'encrypted', 'iv', 1,
               '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
               'plugin_slack_workspace')`,
    ).run(CONNECTION, WORKSPACE);
    seedSession(database, { id: "session-channel", channelId: "C1", threadTs: "1727.001", workstreamId: CHANNEL_WORKSTREAM });
    seedSession(database, { id: "session-dm", channelId: "D1", threadTs: "1727.002", workstreamId: DM_WORKSTREAM });

    apply(database, BINDING_MIGRATION_VERSION, BINDING_MIGRATION_VERSION - 1);

    expect(database.prepare(
      `SELECT installation_id, path_json, target_kind, space_id, parent_kind, parent_id, substream_id,
              state, suspended_reason, claim_key, created_at, updated_at
         FROM external_conversation_bindings ORDER BY path_json`,
    ).all()).toEqual([
      {
        installation_id: "slack:T1",
        path_json: "[\"C1\",\"1727.001\"]",
        target_kind: "conversation",
        space_id: null,
        parent_kind: "workstream",
        parent_id: CHANNEL_WORKSTREAM,
        substream_id: "0",
        state: "active",
        suspended_reason: null,
        claim_key: null,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-02T00:00:00.000Z",
      },
      {
        installation_id: "slack:T1",
        path_json: "[\"D1\",\"1727.002\"]",
        target_kind: "conversation",
        space_id: null,
        parent_kind: "workstream",
        parent_id: DM_WORKSTREAM,
        substream_id: "0",
        state: "active",
        suspended_reason: null,
        claim_key: null,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-02T00:00:00.000Z",
      },
    ]);
    // The session rows stay: they are delivery state now.
    expect(database.prepare("SELECT COUNT(*) AS count FROM slack_agent_sessions").get()).toEqual({ count: 2 });

    // The key the migration wrote is the key the storage reads: a reply in
    // the old thread delivers to its Channel, and the room itself is unbound.
    // The storage is today's, so the object is brought to today's schema first,
    // as every object is before it serves a request.
    apply(database, Number.MAX_SAFE_INTEGER, BINDING_MIGRATION_VERSION);
    const bindings = storageOver(database);
    expect(bindings.resolve({
      installationId: "slack:T1",
      path: ["C1", "1727.001"],
      addressed: false,
      claimKey: null,
      pendingStaleBefore: "2026-09-01T00:00:00.000Z",
    })).toEqual({
      outcome: "deliver",
      target: { kind: "conversation", parentKind: "workstream", parentId: CHANNEL_WORKSTREAM, substreamId: "0" },
    });
    expect(bindings.resolve({
      installationId: "slack:T1",
      path: ["C1", "1727.999"],
      addressed: true,
      claimKey: "event:new",
      pendingStaleBefore: "2026-09-01T00:00:00.000Z",
    })).toEqual({ outcome: "none" });
  });

  it("refuses a binding shape the storage never writes", () => {
    const database = openDatabase();
    apply(database, BINDING_MIGRATION_VERSION);
    const insert = (values: string) => () => database.exec(
      `INSERT INTO external_conversation_bindings
         (installation_id, path_json, target_kind, space_id, parent_kind, parent_id, substream_id,
          state, suspended_reason, claim_key, created_at, updated_at)
       VALUES ${values}`,
    );
    // A Space target that also names a conversation.
    expect(insert(`('slack:T1', '["C1"]', 'space', 'S1', 'workstream', 'W1', '0', 'active', NULL, NULL, 'a', 'a')`))
      .toThrow(/CHECK constraint failed/u);
    // A suspended binding with no reason, and a pending one with no claim.
    expect(insert(`('slack:T1', '["C1"]', 'space', 'S1', NULL, NULL, NULL, 'suspended', NULL, NULL, 'a', 'a')`))
      .toThrow(/CHECK constraint failed/u);
    expect(insert(`('slack:T1', '["C1","1.0"]', 'conversation', NULL, 'workstream', 'W1', '0', 'pending', NULL, NULL, 'a', 'a')`))
      .toThrow(/CHECK constraint failed/u);
    // A path that is not a non-empty array.
    expect(insert(`('slack:T1', '[]', 'space', 'S1', NULL, NULL, NULL, 'active', NULL, NULL, 'a', 'a')`))
      .toThrow(/CHECK constraint failed/u);
  });
});

describe("WorkspaceDO migration 90", () => {
  it("records every binding written before it as a room's own Space, and accepts only a flag", () => {
    const database = openDatabase();
    apply(database, 89);
    database.prepare(
      `INSERT INTO external_conversation_bindings
         (installation_id, path_json, target_kind, space_id, state, created_at, updated_at)
       VALUES ('slack:T1', '["C1"]', 'space', '00000000-0000-7000-8000-0000000b1d30', 'active',
               '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run();

    apply(database, 90, 89);

    expect(database.prepare("SELECT space_matched FROM external_conversation_bindings WHERE path_json = '[\"C1\"]'").all())
      .toEqual([{ space_matched: 0 }]);
    expect(() => database.exec(
      "UPDATE external_conversation_bindings SET space_matched = 2 WHERE path_json = '[\"C1\"]'",
    )).toThrow(/CHECK/u);
  });
});
