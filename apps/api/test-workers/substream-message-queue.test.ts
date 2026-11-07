/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * What happens to a message that is queued rather than answered immediately.
 *
 * A substream admits a message in two durable steps and delivers it in a third,
 * and between them the queue is the only thing holding it. The failure this
 * suite exists to catch is always the same shape: a message reaches
 * `pending_loop_inputs` (or the mailbox row before it) and never reaches the
 * model — and because the head-of-line gate hides every input behind an
 * unsettled one, that is rarely one lost message. It is the whole queue.
 *
 * So each case here drives the real object through a real run and then asks the
 * same two questions of the durable state: did *this* message get its own
 * execution receipt, and did the model actually see its text. `settledRun` and
 * friends deliberately do not force an alarm where the loop is supposed to
 * carry the work itself — forcing one would supply the wake-up whose absence is
 * the bug.
 *
 * `message-to-output-pipeline.test.ts` owns the single-message happy path and
 * the interrupted-admission recovery; this owns what happens when more than one
 * message is waiting, and when the run they are waiting on does not simply
 * succeed.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AuthContext } from "../src/env";
import { createCanvas } from "../src/services/canvas-service";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { conversationObjectName, substreamLoopId, workspaceDOName } from "../src/durable-objects/names";
import {
  capturedProviderRequests,
  installScriptedProvider,
  openProviderGate,
  restoreProviderFetch,
} from "./helpers/scripted-provider";
import {
  holdFirstWorkspaceRead,
  holdLoopExecuting,
  releaseHeldLoop,
  seedWorkspaceControlPlane,
} from "./helpers/substream-fixture";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import type { Env } from "../src/env";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000f0a1");
/**
 * Reassigned per test, for the reason the pipeline suite reassigns its own: a
 * finished test's persistent-loop drain can outlast `reset()`, and giving each
 * test its own work-stream id sends that zombie work to its own object instead
 * of the next test's queue — which is exactly the state these tests assert on.
 */
let WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000f0a2");
let workstreamOrdinal = 0;
const USER_ID = asUserId("00000000-0000-7000-8000-00000000f0a3");
const SESSION_ID = "00000000-0000-7000-8000-00000000f0a4";
const MODEL = "queue-suite/primary";
const TEST_ENV: Env = env;

/** Wall-clock budgets, sized for a contended multi-suite run. See the pipeline suite. */
const RUN_SETTLE_TIMEOUT_MS = 15_000;
const LOOP_RELEASE_TIMEOUT_MS = 10_000;
const ADMISSION_SETTLE_TIMEOUT_MS = 5_000;

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  role: "member" as const,
};

beforeEach(async () => {
  workstreamOrdinal += 1;
  WORKSTREAM_ID = asWorkstreamId(
    `00000000-0000-7000-8000-${String(workstreamOrdinal).padStart(4, "0")}0000f0a2`,
  );
  await reset();
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  await env.DB.batch([
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
    // The D1 anchors `createCanvas` claims for the conversation it makes.
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
  ]);
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
  await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

function agentStub(): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
  ));
}

async function product(stub: DurableObjectStub, body: unknown): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await stub.fetch("https://object.test/internal/product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Every case's conversation is a Canvas's chat.
    body: JSON.stringify({ parentKind: "canvas", ...(body as Record<string, unknown>) }),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * The conversation every case drives: a Canvas's chat, created the way the
 * product creates one, and its first message admitted through the ordinary
 * `create_message`. The body adds the run that message activated, which the
 * cases settle; activation is left to the object's own alarm, so a case that
 * holds the loop before the run executes still can.
 */
async function initializeWorkstream(
  stub: DurableObjectStub,
  openingMessage: string,
  extra: { telemetryJourney?: "workstream_create" } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  await createCanvas(TEST_ENV, {
    workspaceId: WORKSPACE_ID, creatorUserId: USER_ID, canvasId: WORKSTREAM_ID, title: "Queue",
  });
  // A Canvas has no model picker; the pinned model is how a case reaches its
  // scripted provider.
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE workstream SET model_override = ? WHERE id = 1", MODEL);
  });
  const sent = await product(stub, {
    operation: "create_message",
    auth: AUTH,
    input: {
      text: openingMessage,
      clientMessageId: "queue-open-1",
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
      ...(extra.telemetryJourney ? { telemetryJourney: extra.telemetryJourney } : {}),
    },
  });
  if (sent.status !== 200) return sent;
  const turnId = (sent.body.turn as { turnId: string }).turnId;
  let harnessRunId: string | null = null;
  await expect.poll(async () => {
    harnessRunId = await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec<{ run_id: string; execution_context_json: string }>(
        `SELECT run_id, execution_context_json FROM runs
          WHERE execution_context_json IS NOT NULL ORDER BY created_at, run_id`,
      ).toArray();
      return rows.find((row) => (
        JSON.parse(row.execution_context_json) as { triggerMessageId?: string | null }
      ).triggerMessageId === turnId)?.run_id ?? null;
    });
    return harnessRunId === null ? `no run was activated for ${turnId}` : "activated";
  }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 20 }).toBe("activated");
  return { status: sent.status, body: { ...sent.body, turnId, harnessRunId } };
}

/** Admit one member message through the AgentLoopDO product/RPC compatibility endpoint. */
async function sendMessage(
  stub: DurableObjectStub,
  input: {
    text: string;
    clientMessageId: string;
    telemetryOperationId?: string;
    telemetryRequestReceivedAt?: number;
    telemetryJourney?: "workstream_create" | "substream_create" | "message_send";
    auth?: AuthContext;
  },
): Promise<{ turnId: string; deliveryState: string }> {
  const result = await product(stub, {
    operation: "create_message",
    auth: input.auth ?? AUTH,
    input: {
      text: input.text,
      clientMessageId: input.clientMessageId,
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
      ...(input.telemetryOperationId ? { telemetryOperationId: input.telemetryOperationId } : {}),
      ...(input.telemetryRequestReceivedAt !== undefined
        ? { telemetryRequestReceivedAt: input.telemetryRequestReceivedAt }
        : {}),
      ...(input.telemetryJourney ? { telemetryJourney: input.telemetryJourney } : {}),
    },
  });
  expect(result.status).toBe(200);
  return {
    turnId: (result.body.turn as { turnId: string }).turnId,
    deliveryState: String(result.body.deliveryState),
  };
}

interface QueueRunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  status: string;
  terminalized_at: number | null;
  created_at: number;
  trigger: string | null;
}

/** Every execution receipt this object holds, oldest first, with its trigger. */
async function executionReceipts(stub: DurableObjectStub): Promise<QueueRunRow[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<QueueRunRow>(
      `SELECT run_id, status, terminalized_at, created_at,
              json_extract(execution_context_json, '$.triggerMessageId') AS trigger
         FROM runs WHERE execution_context_json IS NOT NULL
        ORDER BY created_at, run_id`,
    ).toArray());
}

/** The user text of every streaming request this object's provider has seen, per call. */
async function providerUserTurns(stub: DurableObjectStub): Promise<string[][]> {
  const requests = await capturedProviderRequests(stub);
  return requests.map((request) =>
    (request.body.messages as Array<{ role?: unknown; content?: unknown }>)
      // A person's messages only: a Canvas's host adds its own context to
      // every run as a user message, which no person said.
      .filter((message) => message.role === "user" && JSON.stringify(message.content).includes("rally_author"))
      .map((message) => JSON.stringify(message.content)));
}

/** Poll until every named turn owns a terminal execution receipt, in this order. */
async function settledInOrder(
  stub: DurableObjectStub,
  triggers: readonly string[],
): Promise<void> {
  await expect.poll(async () => {
    const receipts = await executionReceipts(stub);
    const ordered = receipts
      .filter((run) => run.trigger !== null && triggers.includes(String(run.trigger)))
      .map((run) => ({ trigger: String(run.trigger), settled: run.terminalized_at !== null }));
    if (ordered.length !== triggers.length) {
      return `minted ${ordered.length} of ${triggers.length} receipts: `
        + `${JSON.stringify(ordered)}`;
    }
    if (ordered.some((run) => !run.settled)) return `not every receipt settled: ${JSON.stringify(ordered)}`;
    return ordered.map((run) => run.trigger).join(",");
  }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe(triggers.join(","));
}

/** Poll until the loop owns no execution. */
async function waitForLoopRelease(stub: DurableObjectStub): Promise<void> {
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM substream_loops WHERE status = 'executing'`,
    ).one().count), {
    timeout: LOOP_RELEASE_TIMEOUT_MS,
    interval: 50,
    message: "the singleton loop never released its execution",
  }).toBe(0);
}

/**
 * Poll until the gated run is actually held at the provider boundary.
 *
 * The loop's status flips to `executing` at activation, which is before the
 * execution environment is assembled — so waiting on that would let a send race
 * ahead of the run it is supposed to queue behind. The captured request is the
 * only evidence the run has reached the gate and is going to sit there.
 */
async function waitForGatedProviderCall(stub: DurableObjectStub): Promise<void> {
  await expect.poll(async () => (await capturedProviderRequests(stub)).length, {
    timeout: RUN_SETTLE_TIMEOUT_MS,
    interval: 25,
    message: "the opening run never reached the held provider call",
  }).toBe(1);
}

function assistantTurn(text: string): readonly unknown[] {
  return [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }];
}

async function holdFirstExternalSettlement(
  stub: DurableObjectStub,
): Promise<{ entered: boolean; open: boolean }> {
  return runInDurableObject(stub, (instance) => {
    const gate = { entered: false, open: false };
    const target = instance as unknown as {
      settleAgentRun: (...args: unknown[]) => Promise<string | null>;
    };
    const settle = target.settleAgentRun.bind(target);
    let held = false;
    target.settleAgentRun = async (...args: unknown[]): Promise<string | null> => {
      if (!held) {
        held = true;
        gate.entered = true;
        while (!gate.open) await scheduler.wait(10);
      }
      return settle(...args);
    };
    return gate;
  });
}

describe("a message queued behind a live run", () => {
  it("records fresh terminal metrics before external settlement leaves the inference lane", async () => {
    const stub = agentStub();
    const analytics: unknown[] = [];
    try {
      await installScriptedProvider(
        stub,
        [assistantTurn("answering with measured terminal metrics")],
        { primaryModel: MODEL, fallbackModels: [] },
      );
      await runInDurableObject(stub, (instance) => {
        const target = instance as unknown as {
          env: { RUN_ANALYTICS: { writeDataPoint: (point: unknown) => void } };
        };
        target.env.RUN_ANALYTICS = {
          writeDataPoint: (point: unknown) => { analytics.push(point); },
        };
      });
      const opened = await initializeWorkstream(stub, "opening message");
      await expect.poll(async () => (await executionReceipts(stub))
        .find((run) => run.run_id === opened.body.harnessRunId)?.terminalized_at ?? null, {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
      }).not.toBeNull();

      await expect.poll(() => analytics.length, {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "fresh terminal metrics were lost before external settlement",
      }).toBe(1);
      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ settled_at: number | null }>(
          `SELECT external_settled_at AS settled_at FROM runs WHERE run_id = ?`,
          opened.body.harnessRunId as string,
        ).one().settled_at), {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
      }).not.toBeNull();
      expect(await runInDurableObject(stub, (instance, state) => {
        const runId = opened.body.harnessRunId as string;
        const input = JSON.parse(state.storage.sql.exec<{ execution_context_json: string }>(
          `SELECT execution_context_json FROM runs WHERE run_id = ?`,
          runId,
        ).one().execution_context_json);
        state.storage.sql.exec(
          `UPDATE runs SET external_settled_at = 123456789, execution_available_at = NULL
            WHERE run_id = ?`,
          runId,
        );
        void (instance as unknown as {
          persistAgentRunForExternalSettlement: (
            workflowInput: unknown,
            outcome: { status: "completed" },
          ) => Promise<unknown>;
        }).persistAgentRunForExternalSettlement(input, { status: "completed" });
        return state.storage.sql.exec<{ settled_at: number | null }>(
          `SELECT external_settled_at AS settled_at FROM runs WHERE run_id = ?`,
          runId,
        ).one().settled_at;
      })).toBe(123456789);
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("starts the next inference while the previous run's external settlement is blocked", async () => {
    const stub = agentStub();
    let settlementGate: { entered: boolean; open: boolean } | null = null;
    try {
      await installScriptedProvider(
        stub,
        [
          assistantTurn("answering the opening message"),
          assistantTurn("answering without waiting for external delivery"),
        ],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      await initializeWorkstream(stub, "opening message");
      await waitForGatedProviderCall(stub);
      const queued = await sendMessage(stub, {
        text: "do not wait for settlement",
        clientMessageId: "queue-settlement-independent-1",
      });
      settlementGate = await holdFirstExternalSettlement(stub);

      await openProviderGate(stub);
      await expect.poll(() => settlementGate?.entered ?? false, {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "the opening run never entered external settlement",
      }).toBe(true);
      expect(settlementGate.open).toBe(false);
      // This is the contract: the second provider call happens while the first
      // run's delivery/metadata continuation is still deliberately blocked.
      await expect.poll(async () => (await capturedProviderRequests(stub)).length, {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "the next inference waited for external settlement",
      }).toBe(2);
      await settledInOrder(stub, [queued.turnId]);

      settlementGate.open = true;
      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM runs
            WHERE terminalized_at IS NOT NULL AND external_settled_at IS NULL`,
        ).one().count), {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 50,
        message: "the independent settlement lane did not drain",
      }).toBe(0);
    } finally {
      if (settlementGate) settlementGate.open = true;
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("reclaims an external settlement drain after its durable claim expires", async () => {
    const stub = agentStub();
    let settlementGate: { entered: boolean; open: boolean } | null = null;
    try {
      await installScriptedProvider(
        stub,
        [assistantTurn("answering before a cancelled external continuation")],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      await initializeWorkstream(stub, "opening message");
      await waitForGatedProviderCall(stub);
      settlementGate = await holdFirstExternalSettlement(stub);
      await openProviderGate(stub);
      await expect.poll(() => settlementGate?.entered ?? false, {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
      }).toBe(true);

      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE runs SET execution_available_at = ?
            WHERE terminalized_at IS NOT NULL AND external_settled_at IS NULL`,
          Date.now() - 1,
        );
      });
      await runDurableObjectAlarm(stub);

      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM runs
            WHERE terminalized_at IS NOT NULL AND external_settled_at IS NULL`,
        ).one().count), {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "expired external settlement claim was not reclaimed",
      }).toBe(0);
      expect(settlementGate.open).toBe(false);
    } finally {
      if (settlementGate) settlementGate.open = true;
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("delivers every message queued during one run, in admission order, one run each", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          assistantTurn("answering the opening message"),
          assistantTurn("answering the first queued message"),
          assistantTurn("answering the second queued message"),
          assistantTurn("answering the third queued message"),
        ],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      await initializeWorkstream(stub, "opening message");
      await waitForGatedProviderCall(stub);

      const first = await sendMessage(stub, { text: "queued first", clientMessageId: "queue-1" });
      const second = await sendMessage(stub, { text: "queued second", clientMessageId: "queue-2" });
      const third = await sendMessage(stub, { text: "queued third", clientMessageId: "queue-3" });
      expect([first, second, third].map((turn) => turn.deliveryState))
        .toEqual(["pending", "pending", "pending"]);

      await openProviderGate(stub);
      // One receipt each, in admission order, and every one of them terminal.
      // A queue that delivers only its head — the shape a single-message test
      // cannot see — fails here rather than silently dropping two messages.
      await settledInOrder(stub, [first.turnId, second.turnId, third.turnId]);

      const turns = await providerUserTurns(stub);
      expect(turns).toHaveLength(4);
      // The opening request must not carry a message admitted after it started:
      // `queue` means *after this run*, and a queued input promoted into the
      // running turn would be a steer wearing the wrong mode.
      expect(turns[0]!.join(" ")).not.toContain("queued first");
      expect(turns[1]!.join(" ")).toContain("queued first");
      expect(turns[2]!.join(" ")).toContain("queued second");
      expect(turns[3]!.join(" ")).toContain("queued third");
      // Each run sees everything said before it, so the array only ever grows.
      expect(turns.map((request) => request.length)).toEqual([1, 2, 3, 4]);

      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_inputs`,
        ).one().count)).toBe(0);
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("carries a queued message forward when the run it waited on fails", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          // Broken mid-stream rather than refused outright: a refusal opens the
          // provider circuit, and then the queued message's own run fails
          // `provider_circuit_open` without ever being offered to the model —
          // correct behaviour, but it would hide whether the queue delivered.
          [
            { choices: [{ delta: { content: "partial before the break" }, finish_reason: null }] },
            { error: { message: "provider stream broke" } },
          ],
          assistantTurn("answering the queued message"),
        ],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      const opened = await initializeWorkstream(stub, "opening message");
      await waitForGatedProviderCall(stub);
      const queued = await sendMessage(stub, {
        text: "queued behind a failure",
        clientMessageId: "queue-failure-1",
      });

      await openProviderGate(stub);
      // The opening run dies at the provider boundary. A failure releases the
      // loop without a safe step boundary, so the queued input has to fall
      // forward to the next idle activation rather than die with the run.
      await settledInOrder(stub, [queued.turnId]);
      expect((await executionReceipts(stub))
        .find((run) => run.run_id === opened.body.harnessRunId)?.status).toBe("failed");

      const turns = await providerUserTurns(stub);
      expect(turns.at(-1)!.join(" ")).toContain("queued behind a failure");
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("carries a queued message forward when the run it waited on is stopped", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [assistantTurn("interrupted"), assistantTurn("answering the queued message")],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      await initializeWorkstream(stub, "opening message");
      await waitForGatedProviderCall(stub);
      const queued = await sendMessage(stub, {
        text: "queued behind a stop",
        clientMessageId: "queue-stop-1",
      });
      await runInDurableObject(stub, async (instance) => {
        await (instance as unknown as { product: WorkstreamObjectProductService }).product.stop(
          AUTH,
          "00000000-0000-7000-8000-0000000004ff",
        );
      });

      await openProviderGate(stub);
      // A durable stop consumes no pending input. The person stopped the run,
      // not the message they had already queued behind it.
      await settledInOrder(stub, [queued.turnId]);
      expect((await providerUserTurns(stub)).at(-1)!.join(" "))
        .toContain("queued behind a stop");
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("keeps a queued message when the object is replaced before its activation runs", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [assistantTurn("answering the opening message")],
        { primaryModel: MODEL, fallbackModels: [] },
      );
      const opened = await initializeWorkstream(stub, "opening message");
      await expect.poll(async () => (await executionReceipts(stub))
        .find((run) => run.run_id === opened.body.harnessRunId)?.terminalized_at !== null,
      { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe(true);
      await waitForLoopRelease(stub);

      // Pin the loop so admission cannot activate: this is the state where the
      // queue's only claim on the object is its rows. The hold is durable, so
      // it survives the eviction below and still gates the replacement.
      await runInDurableObject(stub, (_instance, state) => {
        holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
      });
      const queued = await sendMessage(stub, {
        text: "queued across an eviction",
        clientMessageId: "queue-evict-1",
      });
      expect(queued.deliveryState).toBe("pending");

      // Everything in memory goes: the drain, the claim on the preparation, and
      // the owner of whatever alarm was armed. What is left is the durable
      // queue, and the replacement object has to rediscover the message from
      // that alone.
      await evictDurableObject(stub);
      // The provider boundary lives on the instance's `env`, so the replacement
      // needs it installed again — the eviction under test is of Rally's
      // in-memory state, not of the external system this stands in for.
      await installScriptedProvider(
        stub,
        [assistantTurn("answering after the eviction")],
        { primaryModel: MODEL, fallbackModels: [] },
      );
      await runInDurableObject(stub, (_instance, state) => { releaseHeldLoop(state); });

      await runDurableObjectAlarm(stub);
      await settledInOrder(stub, [queued.turnId]);
      expect((await providerUserTurns(stub)).at(-1)!.join(" "))
        .toContain("queued across an eviction");
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("delivers the queue in the order a reorder left it, not the order it arrived", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          assistantTurn("answering the opening message"),
          assistantTurn("answering the dragged message"),
          assistantTurn("answering the message it passed"),
        ],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      await initializeWorkstream(stub, "opening message");
      await waitForGatedProviderCall(stub);
      const first = await sendMessage(stub, { text: "arrived first", clientMessageId: "queue-order-1" });
      const second = await sendMessage(stub, { text: "arrived second", clientMessageId: "queue-order-2" });

      const reordered = await runInDurableObject(stub, async (instance) => {
        return (instance as unknown as { product: WorkstreamObjectProductService })
          .product.reorderPendingInputs(
            AUTH,
            "00000000-0000-7000-8000-0000000004fe",
            [second.turnId, first.turnId],
          );
      });
      expect(reordered.pendingInputs.map((input) => input.inputId))
        .toEqual([second.turnId, first.turnId]);

      await openProviderGate(stub);
      // The drag is authority over promotion order, not just over a list the
      // composer paints: the model has to be asked the second message first.
      await settledInOrder(stub, [second.turnId, first.turnId]);
      const turns = await providerUserTurns(stub);
      expect(turns[1]!.join(" ")).toContain("arrived second");
      expect(turns[2]!.join(" ")).toContain("arrived first");
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("admits one input and one run for a client message id sent twice while queued", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [assistantTurn("answering the opening message"), assistantTurn("answering the queued message")],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      await initializeWorkstream(stub, "opening message");
      await waitForGatedProviderCall(stub);

      const first = await sendMessage(stub, { text: "sent twice", clientMessageId: "queue-dup-1" });
      const replay = await sendMessage(stub, { text: "sent twice", clientMessageId: "queue-dup-1" });
      expect(replay.turnId).toBe(first.turnId);
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_inputs`,
        ).one().count)).toBe(1);

      await openProviderGate(stub);
      await settledInOrder(stub, [first.turnId]);
      // A retry that admitted a second input would show up as a second run and
      // a second copy of the same sentence in the model's array.
      expect((await providerUserTurns(stub)).at(-1)!
        .filter((content) => content.includes("sent twice"))).toHaveLength(1);
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE client_message_id = ?`,
          "queue-dup-1",
        ).one().count)).toBe(1);
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("replays a message when only its telemetry correlation changes", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [assistantTurn("answering the opening message"), assistantTurn("answering telemetry replay")],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      await initializeWorkstream(stub, "opening message");
      await waitForGatedProviderCall(stub);

      const first = await sendMessage(stub, {
        text: "same product command",
        clientMessageId: "queue-telemetry-replay-1",
        telemetryOperationId: "00000000-0000-7000-8000-000000000101",
        telemetryRequestReceivedAt: 1_789_689_600_000,
        telemetryJourney: "message_send",
      });
      const replay = await sendMessage(stub, {
        text: "same product command",
        clientMessageId: "queue-telemetry-replay-1",
        telemetryOperationId: "00000000-0000-7000-8000-000000000102",
        telemetryRequestReceivedAt: 1_789_689_600_500,
        telemetryJourney: "substream_create",
      });
      expect(replay.turnId).toBe(first.turnId);
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("records one message_sent per message a person sends, however often it is retried", async () => {
    await createTelemetryTables();
    const stub = agentStub();
    // The envelope admits a deployed environment name, and this suite's
    // configuration says `test`; the object's own env is what it stamps.
    const restoreEnvironment = await runInDurableObject(stub, (instance) => {
      const objectEnv = (instance as unknown as { env: { APP_ENV: string } }).env;
      const previous = objectEnv.APP_ENV;
      objectEnv.APP_ENV = "development";
      return previous;
    });
    try {
      await installScriptedProvider(
        stub,
        [assistantTurn("answering the opening message"), assistantTurn("answering the support session"),
          assistantTurn("answering the member")],
        { primaryModel: MODEL, fallbackModels: [], gateFirstCall: true },
      );
      const opening = await initializeWorkstream(stub, "opening message", { telemetryJourney: "workstream_create" });
      await waitForGatedProviderCall(stub);

      // Support writes as the member without the member sending anything.
      await sendMessage(stub, {
        text: "sent by support",
        clientMessageId: "queue-message-sent-support",
        auth: { ...AUTH, principal: "impersonation" },
      });
      const sent = await sendMessage(stub, { text: "sent by the member", clientMessageId: "queue-message-sent-1" });
      await sendMessage(stub, { text: "sent by the member", clientMessageId: "queue-message-sent-1" });

      // The support message was admitted first, so by the time the member's
      // event lands, a support event would have too.
      await expect.poll(async () => (await acceptedMessageSent())
        .some((event) => (event.properties as { messageId?: string }).messageId === sent.turnId), {
        timeout: ADMISSION_SETTLE_TIMEOUT_MS,
        interval: 25,
      }).toBe(true);
      const accepted = await acceptedMessageSent();
      expect(accepted).toHaveLength(2);
      // The composer's opening message counts too, recorded where it is admitted.
      expect(accepted.find((event) => (event.properties as { messageId?: string }).messageId
        === opening.body.turnId)).toMatchObject({ name: "message_sent", properties: { messageKind: "message" } });
      expect(accepted.find((event) => (event.properties as { messageId?: string }).messageId
        === sent.turnId)).toMatchObject({
        name: "message_sent",
        identityScope: "workspace-user",
        properties: {
          workstreamId: WORKSTREAM_ID,
          messageId: sent.turnId,
          visibility: "private",
          workstreamOrigin: "ad_hoc",
          messageKind: "message",
          attachmentCount: 0,
          mentionCount: 0,
          participantAddedCount: 0,
        },
      });
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { env: { APP_ENV: string } }).env.APP_ENV = restoreEnvironment;
      });
    }
  });
});

/** The regional acceptance tables the telemetry collector writes; this suite's D1 starts empty. */
async function createTelemetryTables(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("ALTER TABLE users ADD COLUMN analytics_person_id TEXT"),
    env.DB.prepare("ALTER TABLE users ADD COLUMN product_analytics_enabled INTEGER NOT NULL DEFAULT 1"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN name TEXT NOT NULL DEFAULT 'Test workspace'"),
    env.DB.prepare(`CREATE TABLE telemetry_profile_jobs (id TEXT PRIMARY KEY, subject_user_id TEXT, workspace_id TEXT,
      job_kind TEXT, destination_analytics_id TEXT, anonymous_epoch_id TEXT, properties_json TEXT, version INTEGER,
      state TEXT, created_at TEXT, delete_at TEXT)`),
  ]);
  await env.TELEMETRY_DB.batch([
    env.TELEMETRY_DB.prepare(`CREATE TABLE telemetry_accepted_events (event_id TEXT PRIMARY KEY, payload_hash TEXT,
      envelope_json TEXT, route TEXT, routing_basis TEXT, analytics_subject_id TEXT, workspace_analytics_id TEXT,
      subject_user_id TEXT, accepted_at TEXT, normalized_timestamp TEXT, delete_at TEXT, delivery_state TEXT,
      terminal_code TEXT)`),
    env.TELEMETRY_DB.prepare(`CREATE TABLE telemetry_delivery_receipts (event_id TEXT PRIMARY KEY, payload_hash TEXT,
      route TEXT, result_code TEXT, created_at TEXT, delete_at TEXT)`),
  ]);
}

async function acceptedMessageSent(): Promise<Array<Record<string, unknown>>> {
  const rows = (await env.TELEMETRY_DB.prepare(
    "SELECT envelope_json FROM telemetry_accepted_events WHERE json_extract(envelope_json, '$.name') = 'message_sent'",
  ).all<{ envelope_json: string }>()).results;
  return rows.map((row) => JSON.parse(row.envelope_json) as Record<string, unknown>);
}

describe("a message queued behind an unsettled admission", () => {
  /**
   * Park one admission mid-preparation and return its gate.
   *
   * The parked `createMessage` never returns, which is the point: while its
   * mailbox row says `preparing`, the head-of-line gate hides every input
   * admitted after it from `pendingInputs`, from the loop, and from every
   * viewer's snapshot. That is the difference between one message not sending
   * and a whole substream going quiet.
   */
  async function parkAdmission(
    stub: DurableObjectStub,
    input: { text: string; clientMessageId: string; mentions?: unknown[] },
  ): Promise<{ gate: { open: boolean }; inputId: string }> {
    const gate = await runInDurableObject(stub, (instance) => {
      const service = (instance as unknown as {
        product: WorkstreamObjectProductService;
      }).product;
      // `env` is a constructor parameter property: private to the compiler, an
      // ordinary writable field to the runtime this test replaces it in.
      return holdFirstWorkspaceRead(service as unknown as { env: Env });
    });
    // Enter through the same binding endpoint as production. The successful
    // preparation returns an activation request to the AgentLoopDO; calling
    // the product service directly here would discard that handoff and invent
    // a wake-up failure that the real caller cannot have.
    void product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: input.text,
        clientMessageId: input.clientMessageId,
        mentions: (input.mentions ?? []) as never,
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    }).catch(() => undefined);
    const reserved = (): Promise<string | null> => runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ input_id: string }>(
        `SELECT input_id FROM pending_loop_input_mailbox
          WHERE client_message_id = ? AND state = 'preparing'`,
        input.clientMessageId,
      ).toArray()[0]?.input_id ?? null);
    await expect.poll(reserved, {
      timeout: ADMISSION_SETTLE_TIMEOUT_MS,
      interval: 25,
      message: "the parked admission never reserved its mailbox row",
    }).not.toBeNull();
    return { gate, inputId: (await reserved())! };
  }

  it("keeps a message admitted behind an unsettled one hidden, then delivers both in order", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          assistantTurn("answering the opening message"),
          assistantTurn("answering the parked message"),
          assistantTurn("answering the message behind it"),
        ],
        { primaryModel: MODEL, fallbackModels: [] },
      );
      const opened = await initializeWorkstream(stub, "opening message");
      await expect.poll(async () => (await executionReceipts(stub))
        .find((run) => run.run_id === opened.body.harnessRunId)?.terminalized_at !== null,
      { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe(true);
      await waitForLoopRelease(stub);

      const parked = await parkAdmission(stub, {
        text: "admitted first, still preparing",
        clientMessageId: "queue-headline-1",
      });
      const behind = await sendMessage(stub, {
        text: "admitted second, waiting behind it",
        clientMessageId: "queue-headline-2",
      });

      // Ordering is the whole reason the gate exists, so the later message is
      // written but must not be *visible* while the earlier one is unsettled.
      // Hidden rather than missing: a queue that dropped it would look the same
      // from `pendingInputs` alone, and the two are opposite bugs.
      expect(await runInDurableObject(stub, (_instance, state) => ({
        stored: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_inputs`,
        ).one().count,
        visible: new SubstreamLoopStorage(state.storage).pendingInputs().length,
      }))).toEqual({ stored: 1, visible: 0 });

      parked.gate.open = true;
      // Both, in admission order, and neither promoted ahead of the other.
      await settledInOrder(stub, [parked.inputId, behind.turnId]);
      const turns = await providerUserTurns(stub);
      expect(turns[1]!.join(" ")).toContain("admitted first, still preparing");
      expect(turns[2]!.join(" ")).toContain("admitted second, waiting behind it");
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("releases the queue when the admission ahead of it fails instead of settling", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [assistantTurn("answering the opening message"), assistantTurn("answering the survivor")],
        { primaryModel: MODEL, fallbackModels: [] },
      );
      const opened = await initializeWorkstream(stub, "opening message");
      await expect.poll(async () => (await executionReceipts(stub))
        .find((run) => run.run_id === opened.body.harnessRunId)?.terminalized_at !== null,
      { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe(true);
      await waitForLoopRelease(stub);

      // Mentions someone who is not a member of this workspace, so preparation
      // refuses it once the held read is released. A refusal is a terminal
      // state for that row, and the queue behind it has to move on.
      const doomed = await parkAdmission(stub, {
        text: "mentions a stranger",
        clientMessageId: "queue-doomed-1",
        mentions: [{
          type: "person",
          label: "Stranger",
          userId: "00000000-0000-7000-8000-00000000beef",
          connectorType: null,
          startOffset: 0,
          endOffset: 8,
        }],
      });
      const survivor = await sendMessage(stub, {
        text: "queued behind a doomed admission",
        clientMessageId: "queue-survivor-1",
      });

      doomed.gate.open = true;
      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ state: string }>(
          `SELECT state FROM pending_loop_input_mailbox WHERE input_id = ?`,
          doomed.inputId,
        ).toArray()[0]?.state ?? "absent"), {
        timeout: ADMISSION_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "the doomed admission never reached a terminal state",
      }).toBe("failed");

      // The refusal belongs to one message. Everything queued behind it was
      // admitted successfully and has to reach the model anyway — a terminal
      // row that kept blocking would be the same outage with a different cause.
      await settledInOrder(stub, [survivor.turnId]);
      expect((await providerUserTurns(stub)).at(-1)!.join(" "))
        .toContain("queued behind a doomed admission");
      expect((await providerUserTurns(stub)).at(-1)!.join(" "))
        .not.toContain("mentions a stranger");
    } finally {
      await restoreProviderFetch(stub);
    }
  });
});
