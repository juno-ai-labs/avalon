/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asSubstreamId, asWorkspaceId, asWorkstreamId, WORKSTREAM_REALTIME_MAX_FRAME_BYTES } from "@rally/contracts";
import { conversationObjectName } from "../src/durable-objects/names";
import { WorkspaceConversationView } from "../src/durable-objects/workspace-conversation-view";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { nextConversationViewAt, publishConversationViews } from "../src/durable-objects/conversation-view-projection";
import { boot, seedCanonicalMessageRecord, seedOpenWorkstreamAuthority, seedParticipantMessage, seedWorkstreamRoot } from "./helpers/substream-fixture";

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
    state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL");
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

it.each([
  ['preparing', 0], ['quarantined', 1], ['authoritative', 0],
] as const)("does not publish or block backfill for a %s source at generation %s", async (mode, generation) => {
  const stub = source();
  await runInDurableObject(stub, async (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    await seedParticipantMessage(state, { id: 'awaiting-import', sequence: 1, text: 'Waiting for authority' });
    state.storage.sql.exec('UPDATE workstream SET authority_mode = ?, authority_generation = ? WHERE id = 1', mode, generation);
    expect(nextConversationViewAt(state.storage.sql)).toBeNull();
    await publishConversationViews(state.storage.sql, env.ACTIVITY_QUEUE, job);
    expect(state.storage.sql.exec('SELECT turn_id FROM conversation_view_changes WHERE in_flight_revision IS NOT NULL').toArray()).toEqual([]);
  });
  expect(await stub.backfillConversationView({ ...job, turnId: '' })).toBe('missing');
  expect(await stub.conversationViewProjection({ ...job, turnId: '' })).toBeNull();
  // Activation can still deliver the same durable work; nothing was discarded.
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE workstream SET authority_mode = 'authoritative', authority_generation = 1 WHERE id = 1");
    expect(nextConversationViewAt(state.storage.sql)).toBe(0);
  });
  expect(await stub.backfillConversationView({ ...job, turnId: '' })).toBe('queued');
  expect((await stub.conversationViewProjection({ ...job, turnId: 'awaiting-import' }))?.content?.turn.blocks[0])
    .toMatchObject({ text: 'Waiting for authority' });
});

it("publishes retained preview work when an identity-only source is bootstrapped", async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  const stub = source();
  // Finish constructor recovery before installing the fenced fixture.
  await boot(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    await seedParticipantMessage(state, { id: 'retained', sequence: 1, text: 'Ready after bootstrap' });
    state.storage.sql.exec("UPDATE workstream SET authority_mode = 'preparing', authority_generation = 0 WHERE id = 1");
    await state.storage.deleteAlarm();
  });
  expect(await stub.backfillConversationView({ ...job, turnId: '' })).toBe('missing');
  const response = await stub.fetch('https://substream.test/internal/runtime-bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, parentKind: 'canvas', parentId, generation: 1 }),
  });
  expect(await response.json()).toEqual({ ok: true });
  expect(response.status).toBe(200);
  // An overdue alarm can auto-fire before getAlarm(), which then reads null
  // while the handler is running. Assert its durable Queue claim instead.
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ turn_id: string }>(
      'SELECT turn_id FROM conversation_view_changes WHERE in_flight_revision IS NOT NULL ORDER BY turn_id',
    ).toArray()), { timeout: 10_000 }).toEqual([{ turn_id: '' }, { turn_id: 'retained' }]);
  expect((await stub.conversationViewProjection({ ...job, turnId: 'retained' }))?.content?.turn.blocks[0])
    .toMatchObject({ text: 'Ready after bootstrap' });
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
        activities: [], pluginRuns: [
          { pluginRunId: "running", turnId: "text", pluginId: "terminal", displayName: "Terminal",
            state: "active", durationMs: 1000, elapsedMsAtSnapshot: 30000, timingAccuracy: "observed" },
          { pluginRunId: "unknown", turnId: "text", pluginId: "search", displayName: "Search",
            state: "active", durationMs: null, elapsedMsAtSnapshot: 30000, timingAccuracy: "observed" },
        ],
      },
    };
    views.apply(projection);
    expect(views.opening({ requestId, parentId, substreamId }).view?.transcript.pluginRuns)
      .toMatchObject([{ durationMs: 31000, elapsedMsAtSnapshot: null }, { durationMs: null, elapsedMsAtSnapshot: null }]);
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

it("opens the full compact feed across plugin-only turns within the realtime frame budget", async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName("conversation-view-full-feed");
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do", workerVersionId: "conversation-view-test",
    });
    const views = new WorkspaceConversationView(state.storage);
    const texts = ["Opening request", "Working on it", "", "", "", "", "", "", "Final answer"];
    for (const [index, text] of texts.entries()) {
      const sequence = index + 1;
      const turnId = `turn-${sequence}`;
      views.apply({
        ...job, generation: 1, revision: sequence, header, turnId,
        content: {
          turn: { transcriptSequence: sequence, turnId, entryKind: "conversation", actor: "assistant",
            authorUserId: null, authorSnapshot: null, attentionOrdinal: null, createdAtUtc: header.createdAt,
            revision: 1, activityId: null, blocks: text ? [
              { type: "text", blockId: `block-${sequence}`, blockIndex: 0, text, streaming: false },
            ] : [] },
          activities: [], pluginRuns: text ? [] : [{
            pluginRunId: `plugin-${sequence}`, turnId, pluginId: "terminal", displayName: "Terminal",
            state: "completed", durationMs: 1000, elapsedMsAtSnapshot: null, timingAccuracy: "observed",
          }],
        },
      });
    }
    const opening = views.opening({ requestId, parentId, substreamId });
    const range = opening.view?.transcript.ranges[0];
    expect(range?.covered).toEqual({ startInclusive: 1, endExclusive: 10 });
    expect(range?.turns.map((turn) => turn.turnId)).toEqual([
      "turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8", "turn-9",
    ]);
    expect(range?.turns.flatMap((turn) => turn.blocks.flatMap((block) => block.type === "text" ? [block.text] : [])))
      .toEqual(["Opening request", "Working on it", "Final answer"]);
    expect(opening.view?.transcript.pluginRuns).toHaveLength(6);
    // A large history still obeys the existing wire budget, including UTF-8
    // expansion. It keeps a contiguous newest suffix instead of loading it all.
    state.storage.sql.exec(`UPDATE conversation_view_turns SET content_json = json_set(
      content_json, '$.turn.blocks', json_array(json_object('type', 'text', 'blockId', turn_id,
        'blockIndex', 0, 'text', ?, 'streaming', json('false'))))`, "🦊".repeat(75_000));
    const large = views.opening({ requestId, parentId, substreamId });
    expect(large.view?.transcript.ranges[0]?.turns.map((turn) => turn.turnId))
      .toEqual(["turn-7", "turn-8", "turn-9"]);
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeLessThanOrEqual(WORKSTREAM_REALTIME_MAX_FRAME_BYTES);
    // An oversized newest turn falls back to the authoritative socket rather
    // than returning a misleading older suffix or a header-only preview.
    state.storage.sql.exec(`UPDATE conversation_view_turns SET content_json = json_set(
      content_json, '$.turn.blocks[0].text', ?) WHERE turn_id = 'turn-9'`, "🦊".repeat(300_000));
    expect(views.opening({ requestId, parentId, substreamId }).view).toBeNull();
  });
});

it("refreshes attachment names and removals after their first delivery", async () => {
  const stub = source();
  const resourceId = "00000000-0000-7000-8000-00000000ca04";
  await runInDurableObject(stub, async (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    await seedParticipantMessage(state, { id: "attachment", sequence: 1, text: "Attached" });
    state.storage.sql.exec(`INSERT INTO workstream_resource_links
      (resource_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
      VALUES (?, 0, 'attachment', '{"title":"before.txt","mimeType":"text/plain","metadata":{"size":10}}', 1, 1)`, resourceId);
    state.storage.sql.exec("INSERT INTO participant_transcript_attachments VALUES ('attachment', ?, 0, '{}')", resourceId);
  });
  expect((await stub.conversationViewProjection({ ...job, turnId: "attachment" }))?.content?.turn.blocks[0]?.attachments)
    .toMatchObject([{ fileName: "before.txt" }]);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL");
    state.storage.sql.exec("UPDATE workstream_resource_links SET resource_json = json_set(resource_json, '$.title', 'after.txt') WHERE resource_id = ?", resourceId);
    expect(state.storage.sql.exec("SELECT turn_id FROM conversation_view_changes WHERE pending = 1").toArray())
      .toEqual([{ turn_id: "attachment" }]);
  });
  expect((await stub.conversationViewProjection({ ...job, turnId: "attachment" }))?.content?.turn.blocks[0]?.attachments)
    .toMatchObject([{ fileName: "after.txt" }]);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL");
    state.storage.sql.exec("DELETE FROM workstream_resource_links WHERE resource_id = ?", resourceId);
    expect(state.storage.sql.exec("SELECT turn_id FROM conversation_view_changes WHERE pending = 1").toArray())
      .toEqual([{ turn_id: "attachment" }]);
  });
  expect((await stub.conversationViewProjection({ ...job, turnId: "attachment" }))?.content?.turn.blocks[0]?.attachments).toEqual([]);
});

it("waits for delivered batches and keeps edits made during delivery pending", async () => {
  const stub = source();
  await runInDurableObject(stub, async (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    await seedParticipantMessage(state, { id: "changed", sequence: 1, text: "Before" });
    await publishConversationViews(state.storage.sql, env.ACTIVITY_QUEUE, job);
    expect(nextConversationViewAt(state.storage.sql)).toBeGreaterThan(Date.now());
    expect(state.storage.sql.exec("SELECT turn_id FROM conversation_view_changes WHERE in_flight_revision IS NOT NULL ORDER BY turn_id").toArray())
      .toEqual([{ turn_id: "" }, { turn_id: "changed" }]);
  });
  const delivered = await stub.conversationViewProjection({ ...job, turnId: "changed" });
  const claim = await runInDurableObject(stub, (_instance, state) => {
    const rows = state.storage.sql.exec<{ turn_id: string; in_flight_revision: number }>(
      "SELECT turn_id, in_flight_revision FROM conversation_view_changes ORDER BY turn_id",
    ).toArray();
    state.storage.sql.exec("UPDATE participant_transcript_turns SET revision = revision + 1 WHERE turn_id = 'changed'");
    return rows;
  });
  for (const row of claim) await stub.completeConversationView({
    ...job, turnId: row.turn_id, dispatchRevision: row.in_flight_revision,
    projectedRevision: delivered!.revision, generation: delivered!.generation,
  });
  await runInDurableObject(stub, (_instance, state) => {
    expect(nextConversationViewAt(state.storage.sql)).toBe(0);
    expect(state.storage.sql.exec("SELECT turn_id FROM conversation_view_changes WHERE pending = 1").toArray())
      .toEqual([{ turn_id: "changed" }]);
  });
  expect(await stub.backfillConversationView({ ...job, turnId: "" })).toBe("queued");
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL");
  });
  expect(await stub.backfillConversationView({ ...job, turnId: "" })).toBe("delivered");
});

it("publishes the newest historical page first so previews do not wait for old history", async () => {
  await runInDurableObject(source(), async (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    for (let sequence = 1; sequence <= 101; sequence += 1) {
      await seedParticipantMessage(state, { id: `history-${sequence}`, sequence, text: `Message ${sequence}` });
    }
    // Migration 78 seeds history at one revision, before any incremental edit.
    state.storage.sql.exec("UPDATE conversation_view_changes SET revision = 1");
    await publishConversationViews(state.storage.sql, env.ACTIVITY_QUEUE, job);
    expect(state.storage.sql.exec(`SELECT MIN(turns.transcript_sequence) AS first,
      MAX(turns.transcript_sequence) AS last, COUNT(*) AS count
      FROM conversation_view_changes changes JOIN participant_transcript_turns turns USING (turn_id)
      WHERE changes.in_flight_revision IS NOT NULL`).toArray())
      .toEqual([{ first: 2, last: 101, count: 100 }]);
  });
});

it("requeues a deleted turn after delivery is lost without requiring another edit", async () => {
  const stub = source();
  await runInDurableObject(stub, async (_instance, state) => {
    seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
    await seedParticipantMessage(state, { id: "lost", sequence: 1, text: "Remove me" });
    await publishConversationViews(state.storage.sql, env.ACTIVITY_QUEUE, job);
    await publishConversationViews(state.storage.sql, env.ACTIVITY_QUEUE, job);
    expect(state.storage.sql.exec("SELECT attempts FROM conversation_view_changes WHERE turn_id = 'lost'").one())
      .toEqual({ attempts: 1 });
    state.storage.sql.exec("DELETE FROM participant_transcript_turns WHERE turn_id = 'lost'");
    // No delivery callback arrives. Advance the durable gate rather than the
    // global clock, which would also drive unrelated object alarms.
    state.storage.sql.exec("UPDATE conversation_view_changes SET in_flight_until = 0");
    expect(nextConversationViewAt(state.storage.sql)).toBe(0);
    await publishConversationViews(state.storage.sql, env.ACTIVITY_QUEUE, job);
    expect(state.storage.sql.exec(`SELECT attempts, pending,
      in_flight_revision = revision AS current_claim FROM conversation_view_changes WHERE turn_id = 'lost'`).one())
      .toEqual({ attempts: 2, pending: 1, current_claim: 1 });
  });
  expect((await stub.conversationViewProjection({ ...job, turnId: "lost" }))?.content).toBeNull();
  expect(await stub.backfillConversationView({ ...job, turnId: "" })).toBe("queued");
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
});

