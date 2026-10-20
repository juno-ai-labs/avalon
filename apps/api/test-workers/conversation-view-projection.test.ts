/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { conversationObjectName } from "../src/durable-objects/names";
import { WorkspaceConversationView } from "../src/durable-objects/workspace-conversation-view";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { nextConversationViewAt, publishConversationViews } from "../src/durable-objects/conversation-view-projection";
import { threadBackfillWork } from "../src/durable-objects/thread-backfill";
import { seedCanonicalMessageRecord, seedParticipantMessage, seedWorkstreamRoot } from "./helpers/substream-fixture";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000ca01");
const parentId = asWorkstreamId("00000000-0000-7000-8000-00000000ca02");
const substreamId = asSubstreamId("0");
const requestId = "00000000-0000-7000-8000-00000000ca03";
const job = { type: "conversation_view_v1" as const, region: "global" as const, workspaceId, parentId, substreamId };
const source = () => env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, parentId));
const header = {
  title: "Cached conversation", titleStatus: "settled" as const, scope: "workspace" as const,
  harnessStatus: "completed" as const, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
};

beforeEach(async () => reset());

it("projects visible text and plugin timing without tool calls and queues edits and deletes", async () => {
  const stub = source();
  await runInDurableObject(stub, async (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    await seedParticipantMessage(state, { id: "visible", sequence: 1, authorType: "agent", text: "Visible answer" });
    await seedCanonicalMessageRecord(state, {
      id: "tool", sequence: 2, messageType: "tool", text: "private tool result", toolName: "secret_tool",
    });
    const transcript = new WorkstreamTranscriptStorage(state.storage);
    transcript.upsertActivity({
      activityId: "turn-work", parentActivityId: null, scope: "assistant_turn", subjectId: "visible",
      callIndex: null, label: "Rally", action: "start", revision: 1, occurredAtUtc: "2026-10-20T00:00:00.000Z",
    });
    transcript.upsertActivity({
      activityId: "plugin-work", parentActivityId: "turn-work", scope: "plugin", subjectId: "rally:terminal",
      callIndex: null, label: "Terminal", action: "start", revision: 1, occurredAtUtc: "2026-10-20T00:00:00.000Z",
    });
    transcript.upsertActivity({
      activityId: "plugin-work", parentActivityId: "turn-work", scope: "plugin", subjectId: "rally:terminal",
      callIndex: null, label: "Terminal", action: "complete", revision: 2, occurredAtUtc: "2026-10-20T00:00:02.000Z",
    });
    expect(nextConversationViewAt(state.storage.sql)).toBe(0);
  });
  const projection = await stub.conversationViewProjection({ ...job, turnId: "visible" });
  expect(projection?.content?.turn.blocks).toEqual([expect.objectContaining({ type: "text", text: "Visible answer" })]);
  expect(projection?.content?.pluginRuns).toEqual([{
    pluginRunId: "plugin-work", turnId: "visible", pluginId: "rally:terminal", displayName: "Terminal",
    state: "completed", durationMs: 2000, elapsedMsAtSnapshot: null, timingAccuracy: "observed",
  }]);
  expect((await stub.conversationViewProjection({ ...job, turnId: "tool" }))?.content).toBeNull();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0");
    state.storage.sql.exec("UPDATE participant_transcript_turns SET revision = revision + 1 WHERE turn_id = 'visible'");
    expect(state.storage.sql.exec<{ turn_id: string }>(
      "SELECT turn_id FROM conversation_view_changes WHERE pending = 1",
    ).toArray()).toEqual([{ turn_id: "visible" }]);
    state.storage.sql.exec("DELETE FROM participant_transcript_turns WHERE turn_id = 'visible'");
  });
  const deleted = await stub.conversationViewProjection({ ...job, turnId: "visible" });
  expect(deleted?.content).toBeNull();
  expect(deleted!.revision).toBeGreaterThan(projection!.revision);
});

it("keeps deletion and generation fences and serves only compact opening rows", async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName("conversation-view-destination");
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do", workerVersionId: "conversation-view-test",
    });
    const views = new WorkspaceConversationView(state.storage);
    const projection = {
      ...job, generation: 1, revision: 2, header, turnId: "text",
      content: {
        turn: { transcriptSequence: 1, turnId: "text", entryKind: "conversation", actor: "assistant",
          authorUserId: null, authorSnapshot: null, attentionOrdinal: null, createdAtUtc: header.createdAt,
          revision: 1, activityId: null, blocks: [
            { type: "text", blockId: "text-block", blockIndex: 0, text: "Cached answer", streaming: false },
          ] },
        activities: [], pluginRuns: [],
      },
    };
    views.apply(projection);
    expect(views.opening({ requestId, parentId, substreamId }).view?.transcript.ranges[0]?.turns[0]?.blocks)
      .toEqual([{ type: "text", blockId: "text-block", blockIndex: 0, text: "Cached answer", streaming: false }]);
    views.apply({ ...projection, revision: 3, content: null });
    views.apply(projection);
    expect(views.opening({ requestId, parentId, substreamId }).view?.transcript.ranges).toEqual([]);
    views.apply({ ...projection, generation: 2, revision: 1 });
    views.apply({ ...projection, generation: 1, revision: 100, content: null });
    expect(views.opening({ requestId, parentId, substreamId }).view?.transcript.ranges[0]?.turns[0]?.turnId).toBe("text");
    // Reject unexpected tool data at the destination boundary too.
    expect(() => views.apply({ ...projection, revision: 200, content: {
      ...projection.content, pluginRuns: [{ toolCallIds: ["secret"] }],
    } })).toThrow();
  });
});

it("backfills populated source storage and every hosted parent including archived breakouts and Sidekicks", async () => {
  const oldSource = env.MIGRATION_PROBE_DO!.getByName("conversation-view-old-source");
  await oldSource.ping();
  await runInDurableObject(oldSource, async (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((m) => m.version <= 77),
      component: "substream_agent_do", workerVersionId: "before",
    });
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    await seedParticipantMessage(state, { id: "historical", sequence: 1, text: "Old message" });
  });
  await runInDurableObject(oldSource, async (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
      component: "substream_agent_do", workerVersionId: "after",
    });
    expect(state.storage.sql.exec<{ turn_id: string }>(
      "SELECT turn_id FROM conversation_view_changes WHERE pending = 1 ORDER BY turn_id",
    ).toArray()).toEqual([{ turn_id: "" }, { turn_id: "historical" }]);
    await publishConversationViews(state.storage.sql, env.ACTIVITY_QUEUE, job);
    expect(nextConversationViewAt(state.storage.sql)).toBeNull();
  });
  const oldWorkspace = env.MIGRATION_PROBE_DO!.getByName("conversation-view-old-workspace");
  await oldWorkspace.ping();
  await runInDurableObject(oldWorkspace, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version <= 123),
      component: "workspace_do", workerVersionId: "before",
    });
    state.storage.sql.exec(`INSERT INTO parent_children(parent_id, substream_id, kind, created_at, archived_at)
      VALUES ('thread', '0', 'main', 1, NULL), ('thread', 'archived-child', 'child', 1, 2),
             ('channel', '0', 'main', 1, NULL)`);
    state.storage.sql.exec(`INSERT INTO sidekick_children(sidekick_id, substream_id, kind, created_at)
      VALUES ('sidekick', '0', 'main', 1), ('sidekick', 'run', 'child', 1)`);
  });
  await runInDurableObject(oldWorkspace, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do", workerVersionId: "after",
    });
    expect(state.storage.sql.exec<{ workstream_id: string }>(
      "SELECT workstream_id FROM thread_backfill WHERE job = 'conversation_view' ORDER BY workstream_id",
    ).toArray()).toEqual([{ workstream_id: "channel" }, { workstream_id: "sidekick" }, { workstream_id: "thread" }]);
    expect(threadBackfillWork(state.storage.sql, { job: "conversation_view", workstreamId: "thread" }))
      .toEqual({ substreamIds: ["0", "archived-child"] });
    expect(threadBackfillWork(state.storage.sql, { job: "conversation_view", workstreamId: "sidekick" }))
      .toEqual({ substreamIds: ["0", "run"] });
    expect(state.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
  });
});
