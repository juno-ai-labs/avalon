/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { admitFixturePendingInput, holdLoopExecuting, releaseHeldLoop, seedWorkspaceControlPlane, USER_ID, WORKSPACE_ID, WORKSTREAM_ID } from "./helpers/substream-fixture";

beforeEach(async () => { await reset(); });

it.each([false, true])("judges a merged result without starting a run (queued: %s)", async (queued) => {
  const workstreamId = WORKSTREAM_ID;
  const sessionId = "00000000-0000-7000-8000-0000000009f2";
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId });
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
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
