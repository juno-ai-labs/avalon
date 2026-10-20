import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { nextConversationViewAt } from "../src/durable-objects/conversation-view-projection";
import { threadBackfillWork } from "../src/durable-objects/thread-backfill";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import { seedWorkstreamObjectRoot } from "./helpers/durable-authority";
import { WorkspaceConversationView } from "../src/durable-objects/workspace-conversation-view";
import { workspaceObjectSqliteDatabase } from "./helpers/workspace-object-tables";

it("migrates historical visible turns and records text, timing, and deletion changes", async () => {
  const database = new DatabaseSync(":memory:");
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    sql: createTestSqlStorage(database), transactionSync: (body: () => unknown) => body(),
  });
  try {
    applyDurableObjectSqliteMigrations({
      storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((m) => m.version <= 77),
      component: "substream_agent_do", workerVersionId: "before",
    });
    seedWorkstreamObjectRoot(database, {
      workspaceId: "00000000-0000-7000-8000-000000000001", workstreamId: "00000000-0000-7000-8000-000000000002",
    });
    const transcript = new WorkstreamTranscriptStorage(storage);
    await transcript.appendParticipantMessage({
      turnId: "old-turn", actor: "assistant", authorUserId: null, authorSnapshot: null,
      text: "Existing text", attentionOrdinal: null, createdAtUtc: "2026-10-20T00:00:00.000Z",
    });
    applyDurableObjectSqliteMigrations({
      storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
      component: "substream_agent_do", workerVersionId: "after",
    });
    expect(database.prepare("SELECT turn_id FROM conversation_view_changes WHERE pending = 1 ORDER BY turn_id").all())
      .toEqual([{ turn_id: "" }, { turn_id: "old-turn" }]);
    database.exec("UPDATE conversation_view_changes SET pending = 0");
    transcript.upsertActivity({
      activityId: "turn-work", parentActivityId: null, scope: "assistant_turn", subjectId: "old-turn",
      callIndex: null, label: "Rally", action: "start", revision: 1, occurredAtUtc: "2026-10-20T00:00:00.000Z",
    });
    transcript.upsertActivity({
      activityId: "plugin-work", parentActivityId: "turn-work", scope: "plugin", subjectId: "terminal",
      callIndex: null, label: "Terminal", action: "start", revision: 1, occurredAtUtc: "2026-10-20T00:00:00.000Z",
    });
    database.exec("UPDATE conversation_view_changes SET pending = 0");
    transcript.upsertActivity({
      activityId: "plugin-work", parentActivityId: "turn-work", scope: "plugin", subjectId: "terminal",
      callIndex: null, label: "Terminal", action: "complete", revision: 2, occurredAtUtc: "2026-10-20T00:00:01.000Z",
    });
    expect(database.prepare("SELECT turn_id FROM conversation_view_changes WHERE pending = 1").all())
      .toEqual([{ turn_id: "old-turn" }]);
    database.exec("UPDATE conversation_view_changes SET pending = 0");
    database.exec("UPDATE participant_transcript_blocks SET revision = revision + 1 WHERE turn_id = 'old-turn'");
    expect(nextConversationViewAt(storage.sql)).toBe(0);
    database.exec("UPDATE conversation_view_changes SET pending = 0");
    database.exec("UPDATE workstream SET authority_generation = authority_generation + 1 WHERE id = 1");
    expect(database.prepare("SELECT turn_id FROM conversation_view_changes WHERE pending = 1 ORDER BY turn_id").all())
      .toEqual([{ turn_id: "" }, { turn_id: "old-turn" }]);
    database.exec("UPDATE conversation_view_changes SET pending = 0");
    database.exec("DELETE FROM participant_transcript_turns WHERE turn_id = 'old-turn'");
    expect(database.prepare("SELECT turn_id FROM conversation_view_changes WHERE pending = 1").all())
      .toEqual([{ turn_id: "old-turn" }]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});

it("keeps cached deletion fences and replaces the prior authority generation", () => {
  const workspaceId = "00000000-0000-7000-8000-000000000001";
  const parentId = "00000000-0000-7000-8000-000000000002";
  const requestId = "00000000-0000-7000-8000-000000000003";
  const database = workspaceObjectSqliteDatabase(workspaceId);
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    sql: createTestSqlStorage(database), transactionSync: (body: () => unknown) => body(),
  });
  try {
    const view = new WorkspaceConversationView(storage);
    const projection = {
      type: "conversation_view_v1", region: "global", workspaceId, parentId, substreamId: "0",
      generation: 1, revision: 2, turnId: "turn",
      header: { title: "Preview", titleStatus: "settled", scope: "workspace", harnessStatus: "completed",
        createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" },
      content: {
        turn: { transcriptSequence: 1, turnId: "turn", entryKind: "conversation", actor: "assistant",
          authorUserId: null, authorSnapshot: null, attentionOrdinal: null, createdAtUtc: "2026-10-20T00:00:00.000Z",
          revision: 1, activityId: null, blocks: [
            { type: "text", blockId: "block", blockIndex: 0, text: "Cached answer", streaming: false },
          ] },
        activities: [], pluginRuns: [],
      },
    };
    const opening = () => view.opening({ requestId, parentId, substreamId: "0" }).view?.transcript;
    view.apply(projection);
    expect(opening()?.ranges[0]?.turns[0]?.blocks).toEqual([
      { type: "text", blockId: "block", blockIndex: 0, text: "Cached answer", streaming: false },
    ]);
    view.apply({ ...projection, revision: 3, content: null });
    view.apply(projection);
    expect(opening()?.ranges).toEqual([]);
    view.apply({ ...projection, generation: 2, revision: 1 });
    view.apply({ ...projection, revision: 100, content: null });
    expect(opening()?.ranges[0]?.turns[0]?.turnId).toBe("turn");
  } finally {
    database.close();
  }
});

it("lists all existing parent conversations for backfill, including Sidekicks and archived breakouts", () => {
  const database = new DatabaseSync(":memory:");
  const sql = createTestSqlStorage(database);
  try {
    for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version <= 123)) {
      for (const statement of migration.statements) database.exec(statement);
    }
    database.exec(`INSERT INTO parent_children(parent_id, substream_id, kind, created_at, archived_at)
      VALUES ('thread', '0', 'main', 1, NULL), ('thread', 'old-breakout', 'child', 1, 2),
             ('channel', '0', 'main', 1, NULL)`);
    database.exec(`INSERT INTO sidekick_children(sidekick_id, substream_id, kind, created_at)
      VALUES ('sidekick', '0', 'main', 1), ('sidekick', 'run', 'child', 1)`);
    for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version > 123)) {
      for (const statement of migration.statements) database.exec(statement);
    }
    expect(database.prepare(
      "SELECT workstream_id FROM thread_backfill WHERE job = 'conversation_view' ORDER BY workstream_id",
    ).all()).toEqual([{ workstream_id: "channel" }, { workstream_id: "sidekick" }, { workstream_id: "thread" }]);
    expect(threadBackfillWork(sql, { job: "conversation_view", workstreamId: "thread" }))
      .toEqual({ substreamIds: ["0", "old-breakout"] });
    expect(threadBackfillWork(sql, { job: "conversation_view", workstreamId: "sidekick" }))
      .toEqual({ substreamIds: ["0", "run"] });
  } finally {
    database.close();
  }
});
