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
import { beforeAll, describe, expect, it } from "vitest";

import { asSubstreamId } from "@avalon/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeAll(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
});

const RUN = "00000000-0000-7000-8000-00000000rc01";
const ATTEMPT = "attempt-1";
const OWNER = "owner-1";

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    substreamAgentName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`),
    ),
  ));
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
});
