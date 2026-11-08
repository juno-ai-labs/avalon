/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The retirement fence, on the objects that actually hold the writes.
 *
 * A retired workspace has to go quiet permanently, and "quiet" is not one
 * check at the edge: the spike that motivated this refused a write inside
 * `AgentLoopDO`, and the outbox it stranded belonged to a Channel's parent,
 * which is now hosted by the Organization's `WorkspaceDO`.
 * Anything that reaches a conversation object directly — a native RPC, an
 * `alarm` the platform recovers, a hibernated socket callback — never passes
 * through WorkspaceDO at all, so the gate lives on the shared base every one of
 * these classes already extends.
 *
 * Three behaviours, and they are deliberately different from each other:
 *
 * - a product call **refuses**, so nothing new is written;
 * - retirement and read-only inspection are **permitted**, or retirement could
 *   not finish and an operator could not see what happened;
 * - an effect already handed to the Queue is **dropped and acknowledged**,
 *   because throwing would leave the Queue redelivering dead work forever.
 *
 * The coverage test at the end enumerates the callable surface of each gated
 * class from the prototype chain and proves the gate's own function is
 * installed on every one, so a method the wrapping loop missed cannot be
 * silent. It does not — cannot — decide what retirement should do to a new
 * method: an unlisted method refuses by default, which is the safe direction,
 * and the background callers that can meet that refusal treat it as terminal
 * (`test/retirement-background-callers.test.ts`).
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import {
  RETIREMENT_REFUSAL_CODE,
  gatedSurface,
  isRetirementGated,
  isRetirementRefusal,
  retirementDisposition,
  readObjectRetirement,
} from "../src/durable-objects/object-retirement";
import { AgentLoopDO } from "../src/durable-objects/agent-loop-do";
import { WorkspaceDO } from "../src/durable-objects/workspace-do";
import {
  conversationObjectName,
  workspaceDOName,
} from "../src/durable-objects/names";
import type { Env } from "../src/env";
import { hostedParentStub } from "./helpers/hosted-parent";

const TEST_ENV: Env = env;

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000de00");
const SUBSTREAM_ID = asSubstreamId("0");

/**
 * A tombstone is permanent, so a test needs an object that has never held one.
 * Sharing a name across tests would mean the second test asserting against the
 * first test's retirement instant, which is a fixture accident rather than a
 * behaviour.
 */
let objectSequence = 0;
function freshWorkstreamId() {
  objectSequence += 1;
  const suffix = (0xde10 + objectSequence).toString(16).padStart(4, "0");
  return asWorkstreamId(`00000000-0000-7000-8000-00000000${suffix}`);
}
const ACTOR_ID = asUserId("00000000-0000-7000-8000-00000000de02");
const OPERATION_ID = "00000000-0000-7000-8000-00000000de03";
/** Its own workspace, for the one test that evicts the Organization object. */
const EVICTION_WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000dea0");

/**
 * A Channel's parent, and the object that closes it. The parent is hosted by
 * its Organization's `WorkspaceDO`, so retiring the parent is retiring that
 * object, and each test takes a workspace of its own for the reason above.
 */
function freshParent() {
  const workstreamId = freshWorkstreamId();
  const suffix = (0xfe10 + objectSequence).toString(16).padStart(4, "0");
  const workspaceId = asWorkspaceId(`00000000-0000-7000-8000-00000000${suffix}`);
  return { workstreamId, workspaceId, stub: hostedParentStub(TEST_ENV, workspaceId, TEST_ENV.AVALON_REGION) };
}

/**
 * Caught explicitly rather than through `rejects`: an RPC stub's thenable is
 * observed twice by that matcher, and the second observation surfaces as an
 * unhandled rejection that fails the run for a passing assertion.
 */
async function refusalOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("object retirement", () => {
  it("refuses a product write on a retired conversation parent", async () => {
    const { workstreamId, workspaceId, stub } = freshParent();
    await stub.retireObject({ retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });

    const refusal = await refusalOf(() => stub.listChildren({ workspaceId, parentId: workstreamId }));
    expect((refusal as { code?: string } | undefined)?.code).toBe(RETIREMENT_REFUSAL_CODE);
    // What the predicate every background caller reads sees on the far side of
    // the RPC boundary, where `instanceof` is gone.
    expect(isRetirementRefusal(refusal)).toBe(true);
    // A sentence a model or a person can act on, with the code where the log
    // line's extractor finds it.
    expect((refusal as Error).message).toContain("closed permanently");
    expect((refusal as Error).message).toContain(`(${RETIREMENT_REFUSAL_CODE})`);
  });

  it("refuses a product call on a retired conversation object", async () => {
    // The class the feature exists for: the refusal the spike observed came
    // from `AgentLoopDO`, and it is the class whose runtime recovery is
    // permitted — so it is where a permit that reached too far would show.
    const workstreamId = freshWorkstreamId();
    const agent = TEST_ENV.SUBSTREAM_AGENTS.get(TEST_ENV.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName(TEST_ENV.AVALON_REGION, WORKSPACE_ID, workstreamId, "0"),
    )) as DurableObjectStub<AgentLoopDO>;
    await agent.retireObject({ retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });
    const agentRefusal = await refusalOf(() => agent.searchTurnDocumentIds({
      type: "turn_search_projection_v1",
      region: TEST_ENV.AVALON_REGION,
      workspaceId: WORKSPACE_ID,
      parentId: workstreamId,
      substreamId: "0",
    } as never));
    expect((agentRefusal as { code?: string } | undefined)?.code).toBe(RETIREMENT_REFUSAL_CODE);
  });

  it("closes every socket the object holds, with the close the desktop does not reconnect from", async () => {
    // A Channel's control socket is held by the Organization object that hosts
    // its parent, so that is the object whose sockets retirement has to close.
    const { stub } = freshParent();
    // A socket the object accepted and would ordinarily serve. After the
    // tombstone the hibernated callbacks are dropped, so a socket left open
    // would sit "connected" — the runtime answers its keepalive without waking
    // the object — while every frame it sent was discarded.
    const closeCode = await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      state.acceptWebSocket(server);
      client.accept();
      const closed = new Promise<number>((resolve) => {
        client.addEventListener("close", (event) => resolve((event as CloseEvent).code));
      });
      expect(state.getWebSockets()).toHaveLength(1);
      // Retired from inside the object, so the client end lives in the same
      // isolate as the assertion and its close event can be awaited here.
      await instance.retireObject({ retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });
      return closed;
    });
    expect(closeCode).toBe(1008);
  });

  it("permits retirement and inspection after the object is retired", async () => {
    const { stub } = freshParent();
    const retiredAt = Date.now();
    await stub.retireObject({ retiredAt, operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });

    // Idempotent: a resumed retirement re-runs its steps and must converge.
    await expect(stub.retireObject({
      retiredAt: retiredAt + 1_000,
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "operator_retirement",
    })).resolves.toBeDefined();

    const state = await stub.objectRetirementState();
    expect(state.retired).toBe(true);
    // The first retirement wins; a resumed one does not move the tombstone.
    expect(state.retiredAt).toBe(retiredAt);
    expect(state.operationId).toBe(OPERATION_ID);
  });

  it("drops and acknowledges an effect already handed to the Queue", async () => {
    const { workstreamId, workspaceId, stub } = freshParent();
    await stub.retireObject({ retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });

    // The envelope is well-formed and would ordinarily be applied. A throw here
    // is what leaves the Queue redelivering it forever, so the contract is a
    // terminal acknowledgement naming every envelope the caller handed over.
    const result = await stub.receiveChildEffects({
      substreamId: SUBSTREAM_ID,
      envelopes: [{
        region: TEST_ENV.AVALON_REGION,
        workspaceId,
        parentKind: "workstream",
        parentId: workstreamId,
        substreamId: SUBSTREAM_ID,
        messageId: "00000000-0000-7000-8000-00000000de04",
        payloadHash: "sha256:retired",
        authorityGeneration: 1,
        sourceVersion: 1,
        occurredAt: Date.now(),
        effect: { kind: "directory_common", substreamId: SUBSTREAM_ID, title: "dropped", updatedAt: Date.now() },
      }],
    } as never);

    expect(result.accepted).toEqual([
      { messageId: "00000000-0000-7000-8000-00000000de04", payloadHash: "sha256:retired" },
    ]);

    // Dropped means dropped: nothing about the parent's projection moved.
    await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
      const rows = state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM parent_child_projections WHERE parent_id = ?",
        workstreamId,
      ).toArray();
      expect(rows[0]?.n).toBe(0);
      void instance;
    });
  });

  it("gates from the stored tombstone, not from having just written it", async () => {
    const { workstreamId, workspaceId, stub } = freshParent();
    const retiredAt = Date.now();

    // Deliberately *not* through `retireObject`. That path also marks the live
    // instance, so a gate that consulted only its own memory would pass every
    // assertion in this file while a reconstructed object stayed wide open —
    // which is the object an evicted retired workspace actually gets. Writing the
    // row underneath leaves the storage read as the only way to know.
    await runInDurableObject(stub, (instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO object_retirement (id, retired_at, operation_id, actor_user_id, reason)
         VALUES (1, ?, ?, ?, ?)`,
        retiredAt,
        OPERATION_ID,
        ACTOR_ID,
        "operator_retirement",
      );
      expect(readObjectRetirement(state.storage.sql)?.retiredAt).toBe(retiredAt);
      void instance;
    });

    let refusal: unknown;
    try {
      await stub.listChildren({ workspaceId, parentId: workstreamId });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { code?: string } | undefined)?.code).toBe(RETIREMENT_REFUSAL_CODE);

    const state = await stub.objectRetirementState();
    expect(state.retired).toBe(true);
    expect(state.retiredAt).toBe(retiredAt);
  });

  it("leaves a retired object with no alarm and counts what it still holds", async () => {
    const { workstreamId, stub } = freshParent();

    // An object with work still pending: something armed to wake it, and an
    // effect it accepted but never handed to the Queue. This is the shape the
    // spike found after retiring a parent, and both halves matter — the alarm
    // is what could wake a dead workspace, and the outbox is what it would try
    // to publish if it did. The outbox row is a hosted parent's: an activity
    // effect, the kind that waits in `parent_outbox` for the alarm.
    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      state.storage.sql.exec(
        `INSERT INTO _internal_durable_alarms
           (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json, created_at, updated_at)
         VALUES ('demo_test', 'k1', ?, NULL, 0, 0, NULL, ?, ?)`,
        Date.now() + 60_000,
        Date.now(),
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO parent_outbox
           (message_id, parent_id, partition_key, source_version, source_epoch, effect_kind,
            payload_json, payload_hash, state, attempts, not_before, created_at)
         VALUES (?, ?, ?, 1, 1, 'activity_event', '{}', 'fnv1a64:0000000000000000', 'pending', 0, 0, ?)`,
        "00000000-0000-7000-8000-00000000df01",
        workstreamId,
        workstreamId,
        Date.now(),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
      void instance;
    });

    const receipt = await stub.retireObject({
      retiredAt: Date.now(),
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "operator_retirement",
    });

    // Counted, not drained. Draining would mean publishing from a workspace
    // that is closed; the count is what tells an operator these are retained
    // effects in a dead object rather than preparation still in flight.
    expect(receipt.retainedOutbox).toBe(1);

    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const alarms = state.storage.sql
        .exec("SELECT COUNT(*) AS n FROM _internal_durable_alarms").toArray();
      expect(alarms[0]?.n).toBe(0);
      // The rows themselves stay. Retirement is not deletion, and the tombstone
      // is what stops anything draining them later.
      const outbox = state.storage.sql
        .exec("SELECT COUNT(*) AS n FROM parent_outbox WHERE parent_id = ?", workstreamId).toArray();
      expect(outbox[0]?.n).toBe(1);
      void instance;
    });
  });

  it("still answers after eviction, which is the state a retired workspace is in", async () => {
    const { workstreamId, workspaceId, stub } = freshParent();
    const retiredAt = Date.now();
    await stub.retireObject({ retiredAt, operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });

    // A retired workspace is idle by definition, so its objects *will* be
    // evicted — and every assertion in this file up to here ran against the
    // instance that was alive when the tombstone was written. This is the one
    // that reconstructs from storage, which is what production actually does.
    await evictDurableObject(stub);

    // Operator inspection of a dead workspace has to keep working, or nobody
    // can find out what it was left holding.
    const state = await stub.objectRetirementState();
    expect(state.retired).toBe(true);
    expect(state.retiredAt).toBe(retiredAt);

    // A resumed retirement re-enters here. If construction cannot complete,
    // retirement is permanently stuck partway through its own graph.
    await expect(stub.retireObject({
      retiredAt,
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: "operator_retirement",
    })).resolves.toMatchObject({ retired: true });

    // And the drop still drops. If the object throws out of its constructor
    // instead, the Queue consumer retries this message until it dead-letters —
    // the exact loop the drop disposition exists to prevent.
    const acknowledged = await stub.receiveChildEffects({
      substreamId: SUBSTREAM_ID,
      envelopes: [{
        region: TEST_ENV.AVALON_REGION,
        workspaceId,
        parentKind: "workstream",
        parentId: workstreamId,
        substreamId: SUBSTREAM_ID,
        messageId: "00000000-0000-7000-8000-00000000de05",
        payloadHash: "sha256:evicted",
        authorityGeneration: 1,
        sourceVersion: 1,
        occurredAt: Date.now(),
        effect: { kind: "directory_common", substreamId: SUBSTREAM_ID, title: "dropped", updatedAt: Date.now() },
      }],
    } as never);
    expect(acknowledged.accepted).toEqual([
      { messageId: "00000000-0000-7000-8000-00000000de05", payloadHash: "sha256:evicted" },
    ]);
  });

  it("does not refill the alarm index when a retired agent is rebuilt and recovers", async () => {
    // The second failure the spike found: an alarm on a retired object re-armed
    // after the next traffic, because clearing the alarm did not stop the code
    // that re-derives it. Runtime recovery is permitted — it is construction,
    // arriving late — and the permit carries the whole call, so its alarm sync
    // ran unfenced against the alarm store and put the wake reason back.
    const workstreamId = freshWorkstreamId();
    const agent = TEST_ENV.SUBSTREAM_AGENTS.get(TEST_ENV.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName(TEST_ENV.AVALON_REGION, WORKSPACE_ID, workstreamId, "0"),
    )) as DurableObjectStub<AgentLoopDO>;
    await runInDurableObject(agent, async (instance: AgentLoopDO, state) => {
      // A pending wake reason of the kind recovery re-derives from.
      state.storage.sql.exec(
        `INSERT INTO workstream_wakeups
           (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at, status,
            idempotency_key, version, created_at, updated_at)
         VALUES ('w1', NULL, '{"type":"user","userId":"u"}', 'later', ?, 'pending', 'k1', 1, ?, ?)`,
        Date.now() + 60_000,
        Date.now(),
        Date.now(),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
      void instance;
    });
    await agent.retireObject({ retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });

    // Eviction, then the traffic that rebuilds the object and runs recovery.
    await evictDurableObject(agent);
    expect((await agent.objectRetirementState()).retired).toBe(true);

    await runInDurableObject(agent, async (instance: AgentLoopDO, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const rows = state.storage.sql.exec("SELECT COUNT(*) AS n FROM _internal_durable_alarms").toArray();
      expect(rows[0]?.n).toBe(0);
      void instance;
    });
  });

  it("drops and acknowledges each queue receiver on a retired WorkspaceDO in the shape its consumer parses", async () => {
    // The receivers the activity consumer calls side by side. A third, the
    // Sidekick directory receiver, was found refusing in production — one
    // message retried until it dead-lettered — and nothing asserted the shapes
    // these two answer, so a wrong shape would have been a `strictObject` parse
    // failure in the consumer: the same loop, one layer up.
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000deb0");
    const stub = TEST_ENV.WORKSPACE_DOS.get(
      TEST_ENV.WORKSPACE_DOS.idFromName(workspaceDOName(TEST_ENV.AVALON_REGION, workspaceId)),
    ) as DurableObjectStub<WorkspaceDO>;
    await stub.retireObject({ retiredAt: Date.now(), operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });

    const envelope = { messageId: "00000000-0000-7000-8000-00000000de06", payloadHash: "fnv1a64:0000000000000001" };
    const children = await stub.receiveChildEffects({ substreamId: "1", envelopes: [envelope] } as never);
    expect(children).toEqual({ accepted: [{ messageId: "00000000-0000-7000-8000-00000000de06", payloadHash: "fnv1a64:0000000000000001" }] });
  });

  it("rebuilds every gated class after eviction, and revokes access on it", async () => {
    // One test across both gated object classes on purpose. The two failures this
    // covers were both *category* failures — a method on the construction path
    // that nobody classified, and a permitted entry point reaching a private
    // helper nobody listed — and both were found one class at a time. Neither
    // is visible from a single class, because each class reaches its own
    // helpers, and `AgentLoopDO` recovers its runtime *after* the construction
    // window closes, which is the case a construction-only fix does not reach.
    const retiredAt = Date.now();
    const canvasId = freshWorkstreamId();
    const revocation = {
      workspaceId: EVICTION_WORKSPACE_ID,
      userId: ACTOR_ID,
      sessionId: null,
      reason: "workspace_membership_removed",
    } as const;
    const workspaceStub = TEST_ENV.WORKSPACE_DOS.get(
      TEST_ENV.WORKSPACE_DOS.idFromName(workspaceDOName(TEST_ENV.AVALON_REGION, EVICTION_WORKSPACE_ID)),
    ) as DurableObjectStub<WorkspaceDO>;
    const agentStub = TEST_ENV.SUBSTREAM_AGENTS.get(
      TEST_ENV.SUBSTREAM_AGENTS.idFromName(
        conversationObjectName(TEST_ENV.AVALON_REGION, EVICTION_WORKSPACE_ID, canvasId, "0"),
      ),
    ) as DurableObjectStub<AgentLoopDO>;
    const targets = [
      { name: "WorkspaceDO", stub: workspaceStub, revoke: () => workspaceStub.revokeSocketAccess(revocation) },
      { name: "AgentLoopDO", stub: agentStub, revoke: () => agentStub.revokeSocketAccess(revocation) },
    ] as const;

    const failures: string[] = [];
    for (const { name, stub, revoke } of targets) {
      await stub.retireObject({ retiredAt, operationId: OPERATION_ID, actorUserId: ACTOR_ID, reason: "operator_retirement" });

      // Access revocation is permitted on every gated class because retirement
      // has to be able to close what a dead workspace still holds open. Each of
      // these reads its own identity through a private helper first, so this is
      // the assertion that the permit carries the whole call rather than one
      // name.
      try {
        await revoke();
      } catch (error) {
        failures.push(`${name}.revokeSocketAccess: ${(error as Error).message}`);
      }

      // And the object has to survive being rebuilt from storage with the
      // tombstone already in it, which is the only state production ever has it
      // in after the workspace goes idle.
      await evictDurableObject(stub as never);
      try {
        const state = await stub.objectRetirementState();
        if (state.retiredAt !== retiredAt) failures.push(`${name}: tombstone moved`);
      } catch (error) {
        failures.push(`${name}.objectRetirementState after eviction: ${(error as Error).message}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("fences every callable method on every gated class, and classifies the ones retirement itself needs", () => {
    const gated = [
      { name: "WorkspaceDO", target: WorkspaceDO },
      { name: "AgentLoopDO", target: AgentLoopDO },
    ] as const;

    const unfenced: string[] = [];
    let fenced = 0;
    for (const { name, target } of gated) {
      for (const method of gatedSurface(target)) {
        // Every method on a gated class has a disposition — an unlisted one
        // refuses — so there is nothing to assert about "unclassified"; what
        // can be wrong is the wrapping. A permitted method is deliberately left
        // as it was written; everything else has to have the gate's own
        // function installed in its place. Reading the declared policy alone
        // would pass with the wrapping loop deleted, because the policy is
        // populated before anything is wrapped.
        if (retirementDisposition(target, method) === "permit") continue;
        if (isRetirementGated(target, method)) fenced += 1;
        else unfenced.push(`${name}.${method}`);
      }
    }
    expect(unfenced).toEqual([]);
    // The surface is not empty, so an enumeration that silently found nothing
    // cannot pass by asserting an empty list against nothing.
    expect(fenced).toBeGreaterThan(0);

    // The dispositions the design depends on, pinned by name. Each is a
    // decision a future edit could undo without any test above noticing.
    // `WorkspaceDO` is on this list because it hosts every Channel, Space and
    // Sidekick parent; its conversation-parent contract methods are the same
    // doors.
    for (const target of [WorkspaceDO]) {
      // The walk's own read, on a parent that may already hold a tombstone.
      expect(retirementDisposition(target, "childrenForRetirement")).toBe("permit");
      // A product enumeration stays refused; the revocation consumer acks it.
      expect(retirementDisposition(target, "listChildren")).toBe("refuse");
    }
    // The doors a hosted parent answers on belong to the Organization object:
    // its HTTP door, its alarm, its socket, and its children's effects. A door
    // dropped from this list is a retired parent throwing where the caller
    // expected an answer.
    for (const method of ["fetch", "alarm", "webSocketMessage", "receiveChildEffects"]) {
      expect(retirementDisposition(WorkspaceDO, method)).toBe("drop");
    }
    expect(retirementDisposition(AgentLoopDO, "startRuntimeRecovery")).toBe("permit");
    for (const method of ["beginWorkspaceRetirement", "recordRetiredNode", "workspaceRetirementProgress"]) {
      expect(retirementDisposition(WorkspaceDO, method)).toBe("permit");
    }
  });
});
