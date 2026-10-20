import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { nextConversationViewAt } from "../src/durable-objects/conversation-view-projection";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import { seedWorkstreamObjectRoot } from "./helpers/durable-authority";

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
