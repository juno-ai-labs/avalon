/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerSocketEvent } from "@rally/contracts";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { ConversationSuggestionStorage } from "../src/durable-objects/conversation-suggestions";
import { ScheduledAlarmStore } from "../src/durable-objects/scheduled-alarms";
import { admitFixturePendingInput, holdLoopExecuting, releaseHeldLoop, seedWorkspaceControlPlane, USER_ID, WORKSPACE_ID, WORKSTREAM_ID } from "./helpers/substream-fixture";

beforeEach(async () => { await reset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function admitMerge(queued: boolean, failRealtime = false, classifyPositive = false) {
  const workstreamId = WORKSTREAM_ID;
  const sessionId = "00000000-0000-7000-8000-0000000009f2";
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId });
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
  await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace, (_instance, state) => {
    const channelId = "00000000-0000-7000-8000-0000000009f5";
    state.storage.sql.exec(`INSERT INTO spaces
      (space_id, title, scope, authority_generation, source_version, payload_hash, revision, created_at, updated_at)
      VALUES (?, 'General', 'workspace', 1, 1, 'space', 1, 0, 0)`, channelId);
    state.storage.sql.exec(`INSERT INTO channels
      (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title, description, preview,
       scope, exact_state, last_activity_at, origin_type, title_status, latest_attention_ordinal,
       unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
      VALUES (?, 1, 1, 'source', 'hash', 'Demo launch', '', '', 'workspace', 'idle', 0, 'ad_hoc', 'settled', 0, 0, 0, 0, 0)`, workstreamId);
    state.storage.sql.exec(`INSERT INTO space_channel_memberships
      (space_id, workstream_id, state, generation, joined_at, updated_at)
      VALUES (?, ?, 'active', 1, 0, 0)`, channelId, workstreamId);
  });
  const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, workstreamId),
  ));
  expect((await stub.bootstrapRuntime({ workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: workstreamId, generation: 1 })).status).toBe(200);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE workstream SET title = 'Demo launch', description = 'Prepare the demo' WHERE id = 1");
    state.storage.sql.exec(`INSERT INTO participants
      (user_id, participation_reason, added_by_user_id, status, participant_epoch, added_at, updated_at)
      VALUES (?, 'creator', ?, 'active', 0, 1, 1)`, USER_ID, USER_ID);
  });
  if (classifyPositive) await runInDurableObject(stub, (instance) => {
    const runtime = instance as unknown as { env: { TYPESAFE_API_KEY?: string; OPENROUTER_STRUCTURED_MODEL?: string } };
    runtime.env = { ...runtime.env, TYPESAFE_API_KEY: "test-not-a-real-key", OPENROUTER_STRUCTURED_MODEL: "openai/gpt-5.6-terra" };
  });
  if (failRealtime) await runInDurableObject(stub, (instance) => {
    // Fault-inject only the publication boundary; admission, SQLite, alarms,
    // and the observer still execute on real workerd.
    const publisher = instance as unknown as { deliverCommittedRealtimeEvent(event: unknown): Promise<void> };
    vi.spyOn(publisher, "deliverCommittedRealtimeEvent").mockRejectedValue(new Error("forced_realtime_delivery_failure"));
  });
  if (queued) await runInDurableObject(stub, async (_instance, state) => {
    holdLoopExecuting(state);
    // The durable shape of a message to people waiting behind an in-flight
    // step. Neither it nor the merge should start a model run when released.
    await admitFixturePendingInput(state, { inputId: "00000000-0000-7000-8000-0000000009f4", text: "Earlier room message", startsRun: false });
  });
  const result = await stub.handleProductRequest({
    operation: "create_message",
    auth: { sessionId, userId: USER_ID, workspaceId: WORKSPACE_ID, region: "global", role: "member" },
    input: {
      text: "The demo schedule is ready.", clientMessageId: "merge-demo-result", attachmentIds: [], mentions: [],
      merge: { type: "conversation_merge", schemaVersion: 1,
        mergedFrom: { breakoutId: "00000000-0000-7000-8000-0000000009f3", title: "Demo schedule" },
        mergedByUserId: USER_ID, actingAgent: false },
    },
  });
  expect(result.status).toBe(200);
  expect(JSON.parse(result.bodyJson).deliveryState).toBe(queued ? "pending" : "canonical");
  if (queued) {
    await runInDurableObject(stub, (_instance, state) => releaseHeldLoop(state));
    await runDurableObjectAlarm(stub);
  }
  return stub;
}

it.each([false, true])("judges a merged result without starting a run (queued: %s)", async (queued) => {
  const stub = await admitMerge(queued);
  // No provider key is installed here. Reaching classifier_unavailable proves
  // admission ran the observer; the Node test supplies the provider response
  // and proves that the same candidate produces a merge_up row.
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT code FROM turn_disposition_judgements").toArray(),
  )).toEqual([{ code: "classifier_unavailable" }]);
  expect(await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS n FROM runs").one().n,
  )).toBe(0);
});

it("judges a committed merge while realtime delivery keeps failing", async () => {
  const stub = await admitMerge(false, true);
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT code FROM turn_disposition_judgements").toArray(),
  )).toEqual([{ code: "classifier_unavailable" }]);
  expect(await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS n FROM durable_outbox WHERE channel = 'semantic_realtime_v1' AND state = 'pending'").one().n,
  )).toBeGreaterThan(0);
});

it("publishes a ready suggestion after canonical delivery recovers without reclassifying", async () => {
  const provider = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === "https://api.typesafe.ai") return Response.json({
      model: "jev-test", answers: {
        disposition: { type: "choice", choice: "worth_carrying_up", confidence: 0.99 },
        carried_item_kind: { type: "choice", choice: "deliverable", confidence: 0.99 },
      },
    });
    if (url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/models") return Response.json({ data: [] });
    if (url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/chat/completions") {
      const request = JSON.parse(String(init?.body));
      return Response.json({ id: "draft-test", model: request.model,
        choices: [{ message: { role: "assistant", content: JSON.stringify({ text: "The demo schedule is ready for the Channel." }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    throw new Error(`unexpected_provider_request:${url.origin}${url.pathname}`);
  });
  vi.stubGlobal("fetch", provider);
  const stub = await admitMerge(false, true, true);
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT status, draft_status, draft_text FROM conversation_suggestions").toArray(),
  )).toEqual([{ status: "open", draft_status: "ready", draft_text: "The demo schedule is ready for the Channel." }]);
  // Wait for the failed publication attempt to settle before recovering the
  // transport, so the assertion cannot pass on an in-flight draft notification.
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind = 'merge_suggestion' AND attempt > 0").one().n,
  )).toBe(1);
  const providerCalls = provider.mock.calls.length;
  const delivered: ServerSocketEvent[] = [];
  await runInDurableObject(stub, (instance, state) => {
    const publisher = instance as unknown as {
      deliverCommittedRealtimeEvent(event: ServerSocketEvent): Promise<void>;
      broadcast(event: ServerSocketEvent): void;
    };
    vi.mocked(publisher.deliverCommittedRealtimeEvent).mockRestore();
    const broadcast = publisher.broadcast.bind(instance);
    vi.spyOn(publisher, "broadcast").mockImplementation((event) => { delivered.push(event); broadcast(event); });
    state.storage.sql.exec("UPDATE durable_outbox SET not_before = 0 WHERE channel = 'semantic_realtime_v1' AND state = 'pending'");
    state.storage.sql.exec("UPDATE _internal_durable_alarms SET retry_at = 0 WHERE kind = 'merge_suggestion'");
  });
  await runDurableObjectAlarm(stub);
  await expect.poll(() => delivered.filter((event) => event.type === "conversation_suggestion_changed").map((event) => event.suggestion.draft.text))
    .toContain("The demo schedule is ready for the Channel.");
  const turnIndex = delivered.findIndex((event) => event.type === "transcript_turn_upserted");
  expect(turnIndex).toBeGreaterThanOrEqual(0);
  expect(turnIndex)
    .toBeLessThan(delivered.findIndex((event) => event.type === "conversation_suggestion_changed"));
  expect(provider.mock.calls).toHaveLength(providerCalls);
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind = 'merge_suggestion'").one().n,
  )).toBe(0);
});

it("resumes a pending merge draft after eviction and retires its durable intent", async () => {
  const stub = await admitMerge(false);
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS n FROM turn_disposition_judgements").one().n,
  )).toBe(1);
  // Durable state at cancellation: classification committed an open pending
  // row, but drafting did not return. The intent must outlive the old isolate.
  await runInDurableObject(stub, async (_instance, state) => {
    const { judged_turn_id: turnId } = state.storage.sql.exec<{ judged_turn_id: string }>(
      "SELECT judged_turn_id FROM turn_disposition_judgements",
    ).one();
    const suggestions = new ConversationSuggestionStorage(state.storage.sql);
    const row = suggestions.insertOpen({
      suggestionId: "00000000-0000-7000-8000-0000000009f6", kind: "merge_up", judgedTurnId: turnId,
      judgedTurnSequence: 1, runId: `merge:${turnId}`, target: { kind: "channel", id: "00000000-0000-7000-8000-0000000009f5", title: "General" },
      decision: { choice: "worth_carrying_up", confidence: 0.95, model: "test" }, now: Date.now(),
    });
    suggestions.recordJudgement({ runId: row.run_id, judgedTurnId: turnId, code: "worth_carrying_up",
      choice: "worth_carrying_up", confidence: 0.95, carriedItemKind: "deliverable", model: "test",
      failureKind: null, suggestionId: row.suggestion_id, now: Date.now() });
    new ScheduledAlarmStore(state.storage.sql).schedule({ kind: "merge_suggestion", key: turnId, dueAt: 0 });
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  await evictDurableObject(stub);
  await runDurableObjectAlarm(stub);
  // No draft provider is configured, so recovery withdraws the row rather
  // than leaving the skeleton pending forever.
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT status, draft_status FROM conversation_suggestions").toArray(),
  )).toEqual([{ status: "withdrawn", draft_status: "failed" }]);
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind = 'merge_suggestion'").one().n,
  )).toBe(0);
});
