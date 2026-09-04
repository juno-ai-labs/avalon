/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The durable tool-receipt authority, on real workerd.
 *
 * The Node suite proves what the SQL decides; this proves what the *runtime*
 * decides — that an operation is one atomic step against the object's storage,
 * that a misrouted stub is refused before it can settle another work stream's
 * receipts, and that the endpoint survives eviction. None of those is
 * observable over `node:sqlite`.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import { WorkstreamToolReceiptStorage } from "../src/durable-objects/workstream-tool-receipt-storage";
import type { Env } from "../src/env";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

const RUN = "00000000-0000-7000-8000-00000000rc01";
const ATTEMPT = "attempt-1";
const OWNER = "owner-1";
const OTHER_WORKSTREAM = "00000000-0000-7000-8000-0000000004c9";

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`),
    ),
  ));
}

/** The Terminal endpoint, for the one test that needs an operation that publishes. */
async function terminal(
  stub: DurableObjectStub,
  operation: string,
  ...args: unknown[]
): Promise<void> {
  const { status } = await post(stub, "/internal/terminal", {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation,
    args,
  });
  expect(status).toBe(200);
}

/** Call the real endpoint, exactly as the Worker's port does. */
async function receipt(
  stub: DurableObjectStub,
  operation: string,
  ...args: unknown[]
): Promise<{ status: number; value: unknown; error?: string }> {
  const { status, body } = await post(stub, "/internal/tool-receipt", {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation,
    args,
  });
  const parsed = body as { value?: unknown; error?: string } | null;
  return { status, value: parsed?.value ?? null, ...(parsed?.error ? { error: parsed.error } : {}) };
}

function seedLiveRun(state: DurableObjectState): void {
  state.storage.sql.exec(
    `INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
       model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
       active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
       tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
       created_at, updated_at, legacy_attempt_id, lease_owner, lease_expires_at)
     VALUES (?,'0','running','{}',0,0,'',0,0,1,0,0,0,0,0,0,0,0,0,0,1,1,?,?,?)`,
    RUN,
    ATTEMPT,
    OWNER,
    Date.now() + 600_000,
  );
}

function admission(effectIntentId: string, toolCallId: string): Record<string, unknown> {
  return {
    effectIntentId,
    runId: RUN,
    toolCallId,
    toolName: "read_resource",
    mode: "read",
    connectionId: null,
    requestHash: "request-hash",
    inputJson: "{}",
    executionPlanHash: "plan-hash",
    executionPlanJson: '{"mode":"read"}',
    compatiblePriorPlanHashes: [],
    providerIdempotencyKey: null,
    fence: { runId: RUN, attemptId: ATTEMPT, owner: OWNER },
    now: Date.now(),
  };
}

describe("tool-receipt authority on real workerd", () => {
  it("admits a receipt and its checkpoint in one committed step", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
    });

    const result = await receipt(stub, "admit", admission("effect-1", "call-1"));

    expect(result.status).toBe(200);
    expect(result.value).toEqual({ state: "created", effectIntentId: "effect-1" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT status, tool_position FROM tool_effects`,
      ).toArray()).toEqual([{ status: "executing", tool_position: 0 }]);
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM tool_effect_checkpoints`,
      ).one().count).toBe(1);
    });
  });

  it("reports a lost lease as an outcome rather than an error", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
      state.storage.sql.exec(`UPDATE runs SET lease_owner = 'someone-else'`);
    });

    const result = await receipt(stub, "admit", admission("effect-1", "call-1"));

    // 200 with `ownership_lost`, not a 4xx. A lease that moved on is an
    // ordinary end to a run; making it an error would leave the caller unable
    // to tell it apart from the object being broken.
    expect(result.status).toBe(200);
    expect(result.value).toEqual({ state: "ownership_lost" });
  });

  it("refuses a request routed to the wrong work stream", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/tool-receipt", {
      workspaceId: WORKSPACE_ID,
      workstreamId: "00000000-0000-7000-8000-0000000000ff",
      operation: "admit",
      args: [admission("effect-1", "call-1")],
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "workstream_tool_receipt_identity_mismatch" });
  });

  it("refuses a write against an object that is no longer the authority", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
      state.storage.sql.exec(`UPDATE workstream SET authority_mode = 'quarantined' WHERE id = 1`);
    });

    const result = await receipt(stub, "admit", admission("effect-1", "call-1"));

    // The check the routed path made and these endpoints dropped:
    // `executeWorkstreamRuntimeSql` refused every statement against a
    // `preparing` or `quarantined` object, and the typed ports kept only the
    // identity half of it. A quarantined object is not the one whose writes
    // count, so a write reaching it must fail rather than commit.
    expect(result.status).toBe(409);
    expect(result.error).toBe("workstream_runtime_authority_fenced");
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM tool_effects`).one().count)
        .toBe(0);
    });
  });

  it("refuses an operation that is not on the contract", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/tool-receipt", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "dropEverything",
      args: [],
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_tool_receipt_operation" });
  });

  it("keeps settled receipts across an eviction", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
    });
    await receipt(stub, "admit", admission("effect-1", "call-1"));
    await receipt(stub, "complete", {
      effectIntentId: "effect-1",
      checkpointIndex: 1,
      outputRef: "ref",
      outputSummary: "done",
      providerOperationId: null,
      payloadJson: "{}",
      allowAmbiguousReconciliation: false,
      fence: { runId: RUN, attemptId: ATTEMPT, owner: OWNER },
      now: Date.now(),
    });

    // The isolate is discarded; only the rows carry the receipt. A replay after
    // eviction is what recovery actually does.
    await evictDurableObject(stub);
    await boot(stub);

    const replay = await receipt(stub, "admit", admission("effect-1", "call-1"));
    expect(replay.value).toEqual({ state: "replay_completed", effectIntentId: "effect-1" });
  });
  /**
   * Every method the storage class exposes is reachable through the endpoint.
   *
   * By reflection over the class rather than over the operation list, because
   * the failure this guards is a method added to the class and left off the
   * list — iterating the list would miss it by construction. `Exhaustive<…>`
   * makes that a compile error; this is the same claim at run time, stated as
   * what a caller would actually meet, which is a dispatch that answers
   * `invalid_tool_receipt_operation` for a real operation.
   *
   * The arguments are deliberately empty. What is proved here is that dispatch
   * *finds* the method, so a rejection on the argument's own terms passes; an
   * unknown-operation refusal, or a crash on `undefined`, does not.
   */
  it("closes a stopped run's open receipts, and only against its own terminal stamp", async () => {
    const stub = agent();
    await boot(stub);
    const terminalizedAt = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
    });
    // A read that never started and a write that did. The classification turns
    // on exactly that difference, so a fixture with only one of them would pass
    // against a settlement that ignored the plan's mode entirely.
    await receipt(stub, "admit", admission("effect-read", "call-read"));
    await receipt(stub, "admit", {
      ...admission("effect-write", "call-write"),
      mode: "write",
      executionPlanJson: '{"mode":"write"}',
      requestHash: "write-hash",
    });

    // Terminalizing is the caller's own write, in the regional database. This
    // stands in for it: the settlement is fenced on the stamp it left, and
    // nothing else about the run.
    const settleWith = (at: number) => receipt(stub, "settleResidualReceipts", {
      runId: RUN,
      attemptId: ATTEMPT,
      lease: { kind: "terminalized", at },
      phase: "cancelled",
      errorJson: '{"code":"run_cancelled"}',
      payloadJson: '{"code":"run_cancelled"}',
      ambiguousMessage: "The run stopped while an external write was unresolved",
      now: terminalizedAt,
    });

    // Before the run is terminal there is nothing to settle for, and a stale
    // executor naming an instant the run never carried must change nothing.
    expect((await settleWith(terminalizedAt)).value).toEqual({ settled: 0, open: 2 });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE runs SET status = 'cancelled', terminalized_at = ? WHERE run_id = ?`,
        terminalizedAt,
        RUN,
      );
    });
    expect((await settleWith(terminalizedAt - 1)).value).toEqual({ settled: 0, open: 2 });

    expect((await settleWith(terminalizedAt)).value).toEqual({ settled: 2, open: 0 });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT effect_intent_id, status FROM tool_effects ORDER BY effect_intent_id`,
      ).toArray()).toEqual([
        // The write may already have reached the provider; stopping is not
        // evidence either way, and calling it failed would be a claim.
        { effect_intent_id: "effect-write", status: "ambiguous" },
        { effect_intent_id: "effect-read", status: "failed" },
      ].sort((a, b) => a.effect_intent_id.localeCompare(b.effect_intent_id)));
      expect(state.storage.sql.exec<{ phase: string }>(
        `SELECT phase FROM tool_effect_checkpoints
          WHERE phase IN ('cancelled', 'ambiguous_external_write')
          ORDER BY phase`,
      ).toArray()).toEqual([{ phase: "ambiguous_external_write" }, { phase: "cancelled" }]);
    });
  });

  it("refuses a request carrying more arguments than an operation takes", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
    });

    // Every method on the storage class takes exactly one options object, so a
    // second positional argument is a malformed request rather than a call this
    // endpoint could satisfy. Asserted through the real endpoint because the
    // bound lives in the wire schema, and the typed port cannot produce a
    // request that violates it.
    const { status, body } = await post(stub, "/internal/tool-receipt", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "admit",
      args: [admission("effect-arity", "call-arity"), { second: "argument" }],
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_tool_receipt_operation" });
    // And nothing was admitted on the way to being refused.
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM tool_effects`,
      ).one().count).toBe(0);
    });
  });

  it("dispatches every method the storage class exposes", async () => {
    // `#`-private members are not properties of the prototype, so they are
    // absent from this list by construction rather than by filtering — adding a
    // private helper cannot make this test demand a wire operation for it.
    // Which is the point: the list is "what the class exposes", and that is
    // exactly what the protocol has to carry.
    const methods = Object.getOwnPropertyNames(WorkstreamToolReceiptStorage.prototype)
      .filter((name) => name !== "constructor")
      .filter((name) => typeof Object.getOwnPropertyDescriptor(
        WorkstreamToolReceiptStorage.prototype,
        name,
      )?.value === "function");
    expect(methods.length).toBeGreaterThan(0);

    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
    });

    // One argument carrying every field any operation reads. Each method takes
    // what it needs and ignores the rest, so none of them throws on a missing
    // property — which matters, because a throw inside the object would break
    // its input gate and every later probe with it. What each one *decides* is
    // the Node suite's subject; this is only about the dispatch finding it.
    const everyField = {
      runId: RUN,
      toolCallId: "dispatch-probe",
      effectIntentId: "dispatch-probe",
      toolPosition: 0,
      effectIntentIds: [],
      capabilities: [],
      resourceIds: [],
      dependencies: [],
      checkpointIndex: 1,
      terminalizedAt: Date.now(),
      toolName: "read_resource",
      mode: "read",
      connectionId: null,
      requestHash: "request-hash",
      inputJson: "{}",
      executionPlanHash: "plan-hash",
      executionPlanJson: '{"mode":"read"}',
      compatiblePriorPlanHashes: [],
      providerIdempotencyKey: null,
      outputRef: "probe-ref",
      outputSummary: "probe",
      startedAt: null,
      settledAt: null,
      providerOperationId: "probe-operation",
      payloadJson: "{}",
      errorJson: "{}",
      // `fail` compares the stored status against this one before reading the
      // stored row's error; omitting it makes both `undefined`, which compares
      // equal and then dereferences a row that is not there. Unreachable
      // through the typed port, which requires the field — but this probe is
      // not the typed port.
      status: "failed" as const,
      allowAmbiguousReconciliation: false,
      phase: "probe",
      attemptId: ATTEMPT,
      // `settleResidualReceipts` dereferences this to read its terminal stamp,
      // and an operation that throws inside the object breaks its input gate
      // for every later probe — which is why this argument carries every field
      // rather than only the plausible ones. The stamp deliberately matches no
      // run, so the fence declines and the probe still learns what it came for:
      // that dispatch found the method.
      lease: { kind: "terminalized" as const, at: 1 },
      ambiguousMessage: "probe",
      // Read by the attachment-dependency operations, which refuse a receipt
      // whose settled ref is not this one.
      expectedOutputRef: "probe-ref",
      fence: { runId: RUN, attemptId: ATTEMPT, owner: OWNER },
      now: Date.now(),
    };

    // A receipt the probe's ids resolve to, so the operations that settle or
    // read one meet their real precondition. Without it the loop would trip on
    // a missing row rather than on a missing method, which is a different
    // failure wearing the same clothes.
    await receipt(stub, "admit", { ...everyField, ...admission("dispatch-probe", "dispatch-probe") });

    for (const operation of methods) {
      const answer = await receipt(stub, operation, everyField);
      expect(answer.error ?? "", `operation ${operation}`)
        .not.toBe("invalid_tool_receipt_operation");
      expect(answer.error ?? "", `operation ${operation}`).not.toMatch(/is not a function/u);
      expect(answer.status, `operation ${operation}`).toBe(200);
    }
  });

  /**
   * A receipt operation enqueues nothing the workspace directory reads.
   *
   * An observation of the outbox rather than a table of intents, because a
   * table is only as true as the last person to edit it — and the intent table
   * this replaces had no production reader at all, so nothing but its own test
   * could have contradicted it. The Terminal operation beside it is the
   * control: it goes through `commitRuntimeMutation` and does enqueue, so an
   * empty outbox after a receipt is a fact about receipts rather than about
   * this fixture.
   *
   * Read inside the invocation for the reason `terminal-authority.test.ts`
   * gives at length: the delivery alarm deletes each row as it forwards it, so
   * a later read races a drain that means the effect succeeded.
   */
  it("enqueues no directory effect, where a Terminal operation does", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
      state.storage.sql.exec(`DELETE FROM durable_outbox`);
    });

    const afterReceipt = await runInDurableObject(stub, async (instance, state) => {
      await (instance as SubstreamAgent).executeToolReceiptOperation({
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        operation: "admit",
        args: [admission("effect-1", "call-1")],
      });
      return state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_outbox WHERE channel = 'regional_effect_v1'`,
      ).one().count;
    });
    expect(afterReceipt).toBe(0);

    await terminal(stub, "reserveFirstGeneration", {
      stableName: "avalon-e2e",
      authorityFingerprint: "authority",
      networkRevision: 1,
      runId: RUN,
      operationLeaseExpiresAt: 1_000_000,
      idleExpiresAt: 2_000_000,
      archiveDueAt: 3_000_000,
      expireDueAt: 4_000_000,
      now: 1_000,
    });
    const afterTerminal = await runInDurableObject(stub, async (instance, state) => {
      await (instance as SubstreamAgent).executeTerminalOperation({
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        operation: "attachProviderSandbox",
        args: [{
          generation: 1,
          sandboxId: "daytona-1",
          lifecycleState: "running",
          idleExpiresAt: 2_000_000,
          archiveDueAt: 3_000_000,
          expireDueAt: 4_000_000,
          now: 1_500,
        }],
      });
      return state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_outbox WHERE channel = 'regional_effect_v1'`,
      ).one().count;
    });
    expect(afterTerminal).toBeGreaterThan(0);
  });
});

/**
 * The run's own path to its receipts, on the object that owns them.
 *
 * The Node suite proves the routing decision — which work stream a carried
 * storage answers for. This proves the wiring that decision rests on is
 * actually performed by the real object: that the execution environment a run
 * is handed carries this object's receipt storage, so a receipt operation never
 * needs the namespace at all.
 *
 * The environment is wrapped so `SUBSTREAM_AGENTS` throws on use. A port that
 * dispatches fails here at the moment it dispatches — including the self-call
 * that exhausted subrequest depth on 2026-08-24, which succeeded and so could
 * not be caught by asserting on the answer.
 */
describe("a run's execution environment inside the owning object", () => {
  interface AgentInternals {
    localRuntimeEnvironment(
      workspaceId: string,
      workstreamId: string,
      substreamId: string,
    ): Env;
  }

  /** Every binding but the one a receipt operation must not need. */
  function withoutAgentNamespace(env: Env): Env {
    return new Proxy(env, {
      get(target, property, receiver) {
        if (property === "SUBSTREAM_AGENTS") {
          throw new Error("receipt operation left the isolate");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }

  it("reaches this work stream's receipts without the namespace", async () => {
    const stub = agent();
    await boot(stub);

    const receipts = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      seedLiveRun(state);
      const execution = (instance as unknown as AgentInternals)
        .localRuntimeEnvironment(WORKSPACE_ID, WORKSTREAM_ID, "0");
      return createToolReceiptObjectPort(
        withoutAgentNamespace(execution),
        WORKSPACE_ID,
        WORKSTREAM_ID,
      ).receiptsByIds({ effectIntentIds: [] });
    });

    expect(receipts).toEqual([]);
  });

  it("still needs the namespace for a work stream this object does not own", async () => {
    const stub = agent();
    await boot(stub);

    await expect(runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      const execution = (instance as unknown as AgentInternals)
        .localRuntimeEnvironment(WORKSPACE_ID, WORKSTREAM_ID, "0");
      return createToolReceiptObjectPort(
        withoutAgentNamespace(execution),
        WORKSPACE_ID,
        OTHER_WORKSTREAM,
      ).receiptsByIds({ effectIntentIds: [] });
    })).rejects.toThrow("receipt operation left the isolate");
  });
});
