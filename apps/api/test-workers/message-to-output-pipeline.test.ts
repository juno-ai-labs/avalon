/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The complete member-visible pipeline: a message goes in, something comes out.
 *
 * This drives the SubstreamAgent through its real product endpoint and direct
 * room socket with real D1 session auth, and then lets the
 * real alarm execute the run. Nothing is seeded into the object by hand; every
 * row the pipeline needs is created by the pipeline.
 *
 * The test worker has no model credentials, so no run can produce a model
 * reply. That is the point of the oracle here: a healthy pipeline must carry
 * the run all the way to the provider boundary and fail *there*, visibly.
 * Failing anywhere earlier — admission, claim, environment assembly — is a
 * pipeline defect this suite exists to catch, and failing *silently* anywhere
 * is the outage we just had. So each case asserts three things: the run
 * reaches a terminal state (nothing hangs), the member-visible work stream
 * state reflects it (nothing lies), and the recorded error is from the
 * provider boundary, not an earlier stage (nothing rots unnoticed).
 */

import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { deliverEffectsToWorkspaceInOrder } from "./helpers/conversation-effects";

import {
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  WorkstreamWorkflowInputSchema,
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import {
  capturedProviderRequests,
  installProviderCapture,
  installScriptedProvider,
  openProviderGate,
  restoreProviderFetch,
} from "./helpers/scripted-provider";
import { createCloudflareTestBinding } from "../test/helpers/cloudflare-test";
import {
  conversationObjectName,
  substreamLoopId,
  workspaceDOName,
} from "../src/durable-objects/names";
import {
  LOOP_EXECUTION_LEASE_MS,
  SubstreamLoopStorage,
} from "../src/durable-objects/substream-loop-storage";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import { WorkstreamMessageStorage } from "../src/durable-objects/workstream-message-storage";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { createSchedulingObjectPort } from "../src/runtime/scheduling-port";
import { launchWorkstreamHarness, WorkstreamService } from "../src/services/workstream-service";
import { BOUND_PARAMETER_ID_CHUNK } from "../src/durable-objects/bound-parameters";
import {
  seedCanonicalMessageRecord,
  seedParticipantMessage,
  holdFirstWorkspaceRead,
  holdLoopExecuting,
  releaseHeldLoop,
} from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000005a1");
/**
 * Reassigned per test. Every test here drives the same *named* objects, and a
 * finished test's live instance — its persistent-loop drain above all — can
 * outlast `reset()` and keep working. Giving each test its own work-stream id
 * sends that zombie work to its own objects instead of the next test's;
 * evicting or aborting instead breaks the tests that manage their own
 * instance lifecycle (and Miniflare's D1 is itself a Durable Object, so
 * `abortAllDurableObjects` wedges every later reset).
 */
let WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000005a2");
let workstreamOrdinal = 0;
const USER_ID = asUserId("00000000-0000-7000-8000-0000000005a3");
/** A second member, so a plain remark reads as conversation rather than a solo prompt. */
const OTHER_USER_ID = asUserId("00000000-0000-7000-8000-0000000005a9");
const SESSION_ID = "00000000-0000-7000-8000-0000000005a4";
const SCHEDULED_ACTIVATION_MODEL = "deepseek/deepseek-v4-flash-0731";
const STREAM_FAILURE_PRIMARY_MODEL = "pipeline-b06/primary";
const STREAM_FAILURE_FALLBACK_MODEL = "pipeline-b06/fallback";
const INTERLEAVED_TOOLS_MODEL = "pipeline-b12/primary";
const QUEUED_FOLLOW_UP_MODEL = "pipeline-queued/primary";
const RETRY_AFTER_ASSISTANT_TURN_MODEL = "pipeline-retry-fence/primary";
const ASIDE_MODEL = "pipeline-aside/primary";
const ASIDE_WINDOW_MODEL = "pipeline-aside-window/primary";
const ASIDE_ELICITATION_MODEL = "pipeline-aside-elicitation/primary";
const ASIDE_BACKLOG_MODEL = "pipeline-aside-backlog/primary";

/**
 * What the polls below wait for is alarm delivery and the drain finishing under
 * cross-file contention — never a slow query, which answers in milliseconds.
 * These are wall-clock budgets, deliberately wider than the fixed-iteration
 * loops they replaced: those loops spent a Durable Object round trip per
 * iteration *on top of* their sleep, so their real window stretched as the
 * machine slowed, while `expect.poll` spends its probes out of a flat budget.
 * Sized for a contended multi-suite run and still well inside the suite's 30s
 * test budget, so the poll's own failure is what reports.
 */
const RUN_SETTLE_TIMEOUT_MS = 10_000;
const LOOP_RELEASE_TIMEOUT_MS = 10_000;
const SOCKET_EVIDENCE_TIMEOUT_MS = 5_000;
// The subscribed attachment write trails the snapshot by one storage round
// trip, never by real work — but the probes ride the same contended object,
// so this too is a wall-clock budget, not the 40x10ms loop it replaced.
const SUBSCRIPTION_SETTLE_TIMEOUT_MS = 2_000;


interface SocketFrame extends Record<string, unknown> {
  type: string;
}

/**
 * Where the one test that reads a log entry parks its capture.
 *
 * On the isolate rather than the object, because `logWarn` writes to the
 * `console` of the isolate the command runs in — so the original has to be
 * parked beside the collector and both restored in the same place.
 */
type WarnCaptureScope = typeof globalThis & {
  __rallyWarnLog?: unknown[];
  __rallyWarnOriginal?: typeof console.warn;
};

/** Failure codes that mean the run died before the provider boundary. */
const PRE_PROVIDER_FAILURES = [
  "harness_run_not_found",
  "workstream_run_start_fenced",
  "workstream_runtime_cross_authority_statement",
];

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  role: "member" as const,
};
const TEST_ENV: Env = env;

beforeEach(async () => {
  // Evict the shared agent before wiping storage: every test drives the same
  // named object, whose live instance — its persistent-loop drain above all —
  // survives `reset()` and keeps running. A drain that outlives its test
  // consumes the next test's freshly admitted pending inputs, and the failure
  // lands two tests away from its cause. Eviction joins that in-flight work;
  // `abortAllDurableObjects` is not an alternative here, because Miniflare's
  // D1 is itself a Durable Object and aborting it wedges every later reset.
  workstreamOrdinal += 1;
  WORKSTREAM_ID = asWorkstreamId(
    `00000000-0000-7000-8000-${String(workstreamOrdinal).padStart(4, "0")}000005a2`,
  );
  await reset();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles'
    )`),
    env.DB.prepare(`CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_type TEXT NOT NULL,
      actor_user_id TEXT, workstream_id TEXT, action TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', request_id TEXT, created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, USER_ID),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_USER_ID),
    env.DB.prepare(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, USER_ID, WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'member@example.com', 'Member', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(USER_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'other@example.com', 'Other Member', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(OTHER_USER_ID),
  ]);
  // The product's workspace reads route to the WorkspaceDO, which refuses
  // requests until it knows who it is — exactly as production bootstraps it.
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
  await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // holds every object's gate, so this hook can wait out a full reset before it
  // gets to run at all. The work itself — reset, the D1 seed, and the
  // `initializeWorkspace` RPC — takes milliseconds, so a failure here is a hang,
  // never a slow query.
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
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function externalAdmission(
  stub: DurableObjectStub,
  method: "admitExternalMessage" | "answerExternalElicitation",
  input: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await (stub as unknown as Record<
    typeof method,
    (value: unknown) => Promise<{ status: number; bodyJson: string }>
  >)[method](input);
  return { status: result.status, body: JSON.parse(result.bodyJson) as Record<string, unknown> };
}

async function initializeWorkstream(
  stub: DurableObjectStub,
  openingMessage: string,
  modelOverride: string | null = null,
  participantUserIds: readonly string[] = [],
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return product(stub, {
    operation: "initialize",
    auth: AUTH,
    input: {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
      title: "Pipeline",
      objective: "",
      descriptionSource: "derived",
      titleStatus: "settled",
      emailAddress: null,
      creatorUserId: USER_ID,
      openingMessage,
      clientMessageId: "pipeline-open-1",
      participantUserIds: [...participantUserIds],
      attachmentIds: [],
      modelOverride,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    },
  });
}

interface RunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  status: string;
  error_json: string | null;
  terminalized_at: number | null;
  final_turn_id: string | null;
  external_settled_at: number | null;
  last_settlement_error_code: string | null;
}

/** Polls the object until the run settles; a run that never settles fails here. */
async function settledRun(stub: DurableObjectStub, runId: string): Promise<RunRow> {
  // Use the workerd test helper so the alarm's execution context, including
  // waitUntil work, is joined before inspecting the terminal run. Calling the
  // instance method directly joins only the handler promise and can leave the
  // claimed loop execution running until the suite's wall-clock poll expires under
  // cross-file contention.
  //
  // A `false` return here is not a failure: an already-overdue alarm may have
  // fired on its own, leaving workerd's alarm slot empty and nothing to force.
  // The poll below is what proves the run settled.
  await runDurableObjectAlarm(stub);
  let settled: RunRow | null = null;
  await expect.poll(async () => {
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<RunRow>(
        `SELECT run_id, status, error_json, terminalized_at, final_turn_id,
                external_settled_at, last_settlement_error_code
           FROM runs WHERE run_id = ?`,
        runId,
      ).toArray()[0] ?? null);
    if (row && row.terminalized_at !== null) {
      settled = row;
      return "terminal";
    }
    const diagnostics = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      loop: state.storage.sql.exec(
        `SELECT loop_id, status, cycle_ordinal, active_execution_id,
                active_execution_epoch, lease_expires_at
           FROM substream_loops WHERE id = 1`,
      ).toArray()[0] ?? null,
    }));
    return `run ${runId} never reached a terminal state — row=${JSON.stringify(row)} `
      + `alarm=${String(diagnostics.alarm)} loop=${JSON.stringify(diagnostics.loop)}`;
  }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe("terminal");
  return settled!;
}

/** Polls until terminal side effects have consumed the saved canonical turn. */
async function externallySettledRun(stub: DurableObjectStub, runId: string): Promise<RunRow> {
  await settledRun(stub, runId);
  let settled: RunRow | null = null;
  await expect.poll(async () => {
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<RunRow>(
        `SELECT run_id, status, error_json, terminalized_at, final_turn_id,
                external_settled_at, last_settlement_error_code
           FROM runs WHERE run_id = ?`,
        runId,
      ).toArray()[0] ?? null);
    if (row?.external_settled_at !== null && row?.external_settled_at !== undefined) {
      settled = row;
      return "settled";
    }
    return `terminal side effects did not consume the canonical turn — row=${JSON.stringify(row)}`;
  }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe("settled");
  return settled!;
}

/**
 * The run a pending input's activation created for this trigger, then its
 * settlement.
 *
 * Activation happens on the object's alarm, and the alarm is forced first for
 * the reason `settledRun` gives. But a force that finds the alarm already in
 * flight returns `false` and waits for nothing, so a single read after it can
 * land before the activation commits — which is exactly what one contended
 * full-suite run produced: `no execution receipt was created`, for a receipt
 * that existed a moment later. The receipt is therefore polled for on the same
 * wall-clock budget as the settlement it precedes.
 */
async function settledRunForTrigger(
  stub: DurableObjectStub,
  triggerMessageId: string,
): Promise<RunRow> {
  await runDurableObjectAlarm(stub);
  let runId: string | null = null;
  await expect.poll(async () => {
    runId = await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec<{ run_id: string; execution_context_json: string }>(
        `SELECT run_id, execution_context_json FROM runs
          WHERE execution_context_json IS NOT NULL ORDER BY created_at, run_id`,
      ).toArray();
      return rows.find((row) => (
        JSON.parse(row.execution_context_json) as { triggerMessageId?: string | null }
      ).triggerMessageId === triggerMessageId)?.run_id ?? null;
    });
    return runId === null ? `no execution receipt was created for ${triggerMessageId}` : "activated";
  }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe("activated");
  return settledRun(stub, runId!);
}

async function waitForLoopRelease(stub: DurableObjectStub): Promise<void> {
  await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM substream_loops WHERE status = 'executing'`,
    ).one().count), {
    timeout: LOOP_RELEASE_TIMEOUT_MS,
    interval: 50,
    message: "singleton loop did not release its execution",
  }).toBe(0);
}

/**
 * Give one real SubstreamAgent isolate a deterministic OpenRouter boundary.
 *
 * The Worker test deliberately omits a selected model so unrelated pipeline
 * cases cannot reach the network. This test needs the stronger oracle: the
 * exact body handed to the provider. The proxy changes only this live object,
 * and the fetch replacement records the wire body before returning a terminal
 * provider response. Neither bypasses the production harness or its RPC/storage
 * ports; they replace only the external system workerd cannot own.
 */

function nextSocketFrameOfType(socket: WebSocket, type: string): Promise<SocketFrame> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const frame = JSON.parse(String(event.data)) as SocketFrame;
        if (frame.type !== type) return;
        socket.removeEventListener("message", onMessage);
        resolve(frame);
      } catch {
        // Ignore heartbeat and unrelated non-JSON frames.
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

function nextSocketCommandOutcome(socket: WebSocket): Promise<SocketFrame> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const frame = JSON.parse(String(event.data)) as SocketFrame;
        if (!["client_command_succeeded", "client_command_failed", "error"].includes(frame.type)) return;
        socket.removeEventListener("message", onMessage);
        resolve(frame);
      } catch {
        // Ignore heartbeat and unrelated non-JSON frames.
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

async function openSubscribedSocket(
  stub: DurableObjectStub,
  ticketId: string,
  substreamId = "0",
): Promise<{ socket: WebSocket; initial: SocketFrame }> {
  const response = await stub.fetch("https://substream.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-workstream-id": WORKSTREAM_ID,
      "x-rally-substream-id": substreamId,
      ...(substreamId !== "0" ? { "x-rally-socket-admission-membership-version": "1" } : {}),
      "x-rally-user-id": USER_ID,
      "x-rally-session-id": SESSION_ID,
      "x-rally-socket-ticket-id": ticketId,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const initial = nextSocketFrameOfType(socket, "snapshot");
  socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0, publishPresence: false }));
  const initialFrame = await initial;
  // Snapshot delivery precedes the server's final subscribed attachment write.
  // Do not let the alarm publish into that narrow gap or the test could miss
  // the first live frame while still appearing to have a subscribed client.
  try {
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) =>
        state.getWebSockets().some((server) => (
          server.deserializeAttachment() as { subscribed?: boolean }
        ).subscribed === true)),
      { timeout: SUBSCRIPTION_SETTLE_TIMEOUT_MS, interval: 10 },
    ).toBe(true);
  } catch (error) {
    socket.close(1011, "subscription did not settle");
    throw new Error("product socket did not become subscribed", { cause: error });
  }
  return { socket, initial: initialFrame };
}

function collectSocketFrames(socket: WebSocket): {
  frames: SocketFrame[];
  stop: () => void;
} {
  const frames: SocketFrame[] = [];
  const onMessage = (event: MessageEvent) => {
    try {
      frames.push(JSON.parse(String(event.data)) as SocketFrame);
    } catch {
      // Heartbeats are not semantic transcript evidence.
    }
  };
  socket.addEventListener("message", onMessage);
  return { frames, stop: () => socket.removeEventListener("message", onMessage) };
}

async function waitForSocketEvidence(
  frames: readonly SocketFrame[],
  predicate: (frame: SocketFrame) => boolean,
): Promise<void> {
  await expect.poll(() => (frames.some(predicate)
    ? "arrived"
    : `socket evidence did not arrive: ${frames.map((frame) => frame.type).join(",")}`), {
    timeout: SOCKET_EVIDENCE_TIMEOUT_MS,
    // 25ms, not the file's 50ms convention: this replaces a 40x25ms loop, and
    // frames land in a local array, so the tighter probe costs nothing.
    interval: 25,
  }).toBe("arrived");
}

/**
 * Record what the mailbox held the first time this object armed its alarm.
 *
 * The claim under test is an ordering *inside* one invocation — the wake-up is
 * armed before the reservation it covers is committed — and the only observer
 * of that order is the invocation itself. So the storage the product writes
 * through reports the mailbox depth at the moment `setAlarm` is called; zero
 * means the reservation was not yet durable, which is the invariant.
 */
function recordFirstAlarmArm(product: { storage: DurableObjectStorage }): {
  mailboxRowsAtFirstArm: number | null;
} {
  const order: { mailboxRowsAtFirstArm: number | null } = { mailboxRowsAtFirstArm: null };
  const storage = product.storage;
  product.storage = createCloudflareTestBinding<DurableObjectStorage>(new Proxy(storage, {
    get: (current, property) => {
      const value = Reflect.get(current, property) as unknown;
      if (property !== "setAlarm") {
        return typeof value === "function" ? value.bind(current) : value;
      }
      return (scheduledTime: number | Date) => {
        order.mailboxRowsAtFirstArm ??= Number(storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_input_mailbox`,
        ).one().count);
        return storage.setAlarm(scheduledTime);
      };
    },
  }));
  return order;
}

/** Release the held first provider call installed by `gateFirstCall`. */

function visibleAssistantBlockOrder(turns: readonly Record<string, unknown>[]): string[] {
  return [...turns]
    .filter((turn) => turn.actor === "assistant" && turn.entryKind === "conversation")
    .sort((left, right) => Number(left.transcriptSequence) - Number(right.transcriptSequence))
    .flatMap((turn) => (turn.blocks as Array<Record<string, unknown>>).flatMap((block) => {
      if (block.type === "text") return [`text:${String(block.text)}`];
      if (block.type === "tool") return ["tool"];
      return [];
    }));
}

function answeredExternalElicitationContent(answer: string): string {
  // This is the same durable answered-question projection the Slack product
  // path prepares before admission. A kind-only object cannot become a Bind
  // user message and correctly fails closed at the mailbox boundary.
  return JSON.stringify({
    kind: "elicitation_response",
    elicitation: {
      prompt: "Choose",
      responseType: "text",
      options: [],
      status: "answered",
      answer,
    },
  });
}

function snapshotTurns(frame: SocketFrame | Record<string, unknown>): Record<string, unknown>[] {
  const transcript = frame.transcript as {
    ranges?: Array<{ turns?: Record<string, unknown>[] }>;
    activeTurns?: Record<string, unknown>[];
  } | undefined;
  return [
    ...(transcript?.ranges ?? []).flatMap((range) => range.turns ?? []),
    ...(transcript?.activeTurns ?? []),
  ];
}

function latestLiveTurns(frames: readonly SocketFrame[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const frame of frames) {
    if (frame.type !== "transcript_turn_upserted") continue;
    const turn = frame.turn as Record<string, unknown>;
    const turnId = String(turn.turnId);
    const current = byId.get(turnId);
    if (!current || Number(turn.revision) > Number(current.revision)) byId.set(turnId, turn);
  }
  return [...byId.values()];
}

function failureCode(row: RunRow): string {
  const parsed = row.error_json ? JSON.parse(row.error_json) as { code?: string } : {};
  return parsed.code ?? "";
}

describe("a member's message travels the whole pipeline", () => {
  it("initialize admits a run and carries it to the provider boundary", async () => {
    const stub = agentStub();

    const opened = await initializeWorkstream(stub, "please look into this");
    expect(opened.status).toBe(200);
    const runId = opened.body.harnessRunId as string;
    expect(runId).toBeTruthy();

    const run = await settledRun(stub, runId);

    // Terminal, and honestly so: with no provider credentials the run must
    // fail — but *at* the provider, past admission, claim, transcript
    // projection, and prompt assembly. The recorded inference attempt is the
    // proof the pipeline reached the model: a run that died in plumbing never
    // writes one, whatever error code the wreck happens to carry. Both halves
    // of this incident — the misrouted transcript read and the unselectable
    // resources view — failed with the same catch-all code, which is why the
    // code alone is not the oracle.
    expect(run.status).toBe("failed");
    expect(PRE_PROVIDER_FAILURES).not.toContain(failureCode(run));
    // The Bind engine's member-safe sentence is the boundary marker: a run
    // that dies in plumbing is terminalized with the generic "could not
    // complete this run" from the drain's catch, while a run that survived
    // transcript projection and prompt assembly reaches the engine, whose
    // outcomes carry the "retrying/support" family. Both halves of this
    // incident — the misrouted transcript read and the unselectable resources
    // view — carried the same failure *code*, which is why the code alone is
    // not the oracle. (The test worker has no flag service, so the engine
    // stops at endpoint selection; that is as far as any credential-less
    // environment can prove.)
    const message = (JSON.parse(String(run.error_json)) as { message?: string }).message ?? "";
    expect(message).toMatch(/Retrying is unlikely to help|try again|support/iu);

    // The member sees the truth, not a spinner: the work stream reflects the
    // failure and the singleton loop releases its active execution.
    //
    // Both land after the run settles, and the loop release lands last: a run
    // reaching a terminal status is not the end of the drain, which then names
    // the work stream and refreshes its description before releasing the row.
    // So both halves wait, and on the same window — waiting on the state alone
    // and then asserting on the loop reads whatever the drain happens to
    // have reached, which is a race the drain wins or loses by milliseconds.
    let observed = "";
    let outstanding = -1;
    // Forty tenths, not sixty: the window stays well inside the suite's 30s
    // test budget, so a drain that never releases its row reports as the
    // assertion that names it rather than as a harness timeout.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      [observed, outstanding] = await runInDurableObject(stub, (_instance, state) => [
        state.storage.sql.exec<{ exact_state: string }>(
          `SELECT exact_state FROM workstream WHERE id = 1`,
        ).toArray()[0]!.exact_state,
        state.storage.sql.exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM substream_loops WHERE status = 'executing'`,
        ).toArray()[0]!.n,
      ] as const);
      if (observed === "failed" && outstanding === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(observed, "run failed but the member still sees it running").toBe("failed");
    expect(outstanding, "the drain left the singleton loop executing").toBe(0);
    const assistantSettlement = await runInDurableObject(stub, (_instance, state) => {
      const reservation = state.storage.sql.exec<{
        turn_id: string;
        transcript_sequence: number;
        state: string;
        outcome: string | null;
      }>(
        `SELECT turn_id, transcript_sequence, state, outcome
           FROM assistant_turn_reservations ORDER BY assistant_turn_sequence DESC LIMIT 1`,
      ).toArray()[0] ?? null;
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const projection = transcript.readBindProjection(substreamLoopId(WORKSTREAM_ID));
      const turn = reservation ? transcript.participantTurn(reservation.turn_id) : null;
      return {
        reservation,
        lastAssistantReservation: projection?.lastAssistantReservation ?? null,
        turn: turn ? {
          transcriptSequence: turn.transcriptSequence,
          actor: turn.actor,
          text: turn.blocks.find((block) => block.type === "text")?.text ?? null,
        } : null,
      };
    });
    expect(assistantSettlement.reservation).toMatchObject({
      state: "materialized",
      outcome: "error",
    });
    expect(assistantSettlement.lastAssistantReservation).toMatchObject({
      turnId: assistantSettlement.reservation?.turn_id,
      transcriptSequence: assistantSettlement.reservation?.transcript_sequence,
      status: "failed",
    });
    expect(assistantSettlement.turn).toMatchObject({
      transcriptSequence: assistantSettlement.reservation?.transcript_sequence,
      actor: "system",
      text: "Response could not be completed",
    });
    // The bounded wait above ends well inside the suite's 30s budget, so a
    // drain that never releases its row reports as the assertion that names
    // it rather than as a timeout.
  });

  it("delivers a scheduled activation into an existing Bind projection exactly once across eviction and replay", async () => {
    const stub = agentStub();
    const opened = await (async () => {
      // The `try` opens before the install so the restore is unconditional: a
      // throw inside it would otherwise leave `fetch` patched for the rest of
      // the file.
      try {
        await installScriptedProvider(stub, [[
          { choices: [{ delta: { content: "persistent conversation ready" }, finish_reason: "stop" }] },
        ]], {
          primaryModel: SCHEDULED_ACTIVATION_MODEL,
          fallbackModels: [],
        });
        const result = await initializeWorkstream(
          stub,
          "establish the persistent conversation",
          SCHEDULED_ACTIVATION_MODEL,
        );
        const settled = await externallySettledRun(stub, result.body.harnessRunId as string);
        expect(settled).toMatchObject({
          status: "completed",
          last_settlement_error_code: null,
        });
        expect(settled.final_turn_id).toContain(":turn:");
        await waitForLoopRelease(stub);
        return result;
      } finally {
        await restoreProviderFetch(stub);
      }
    })();

    const wakeupId = "00000000-0000-7000-8000-0000000005c1";
    const wakeupPrompt = "Inspect the canary after its quiet period";
    const existingBindRevision = await runInDurableObject(stub, (_instance, state) =>
      new WorkstreamTranscriptStorage(state.storage)
        .readBindProjection(substreamLoopId(WORKSTREAM_ID))!.stateRevision);
    expect(existingBindRevision).toBeGreaterThan(0);
    const scheduled = await createSchedulingObjectPort(TEST_ENV, WORKSPACE_ID, WORKSTREAM_ID)
      .scheduleWakeup({
        wakeupId,
        createdByRunId: opened.body.harnessRunId as string,
        executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        prompt: wakeupPrompt,
        // This test activates the saved wake-up explicitly. Keeping the timer
        // in the future prevents its separate scheduler alarm from becoming a
        // second producer while the activation replay is under test.
        dueAt: Date.now() + 3_600_000,
        idempotencyKey: "pipeline-scheduled-activation-1",
        now: Date.now(),
      });
    expect(scheduled).toMatchObject({ outcome: "scheduled", wakeupId });

    const activation = {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      triggerMessageId: null,
      origin: "scheduled_wakeup",
      executionPrincipal: { type: "user" as const, userId: USER_ID },
      scheduledWakeupId: wakeupId,
    };
    const { runId, workflowInput, providerRequests } = await (async () => {
      try {
        // The alarm is autonomous in real workerd. Install the only external
        // dependency before admission so the test remains about durable replay
        // even when workerd runs the alarm between either awaited assertion —
        // inside the `try`, so the restore below is unconditional.
        await installProviderCapture(stub, SCHEDULED_ACTIVATION_MODEL);
        const runId = await launchWorkstreamHarness(TEST_ENV, activation);
        const workflowInput = await runInDurableObject(stub, (_instance, state) => {
          const row = state.storage.sql.exec<{ execution_context_json: string }>(
            `SELECT execution_context_json FROM runs WHERE run_id = ?`,
            runId,
          ).one();
          return WorkstreamWorkflowInputSchema.parse(JSON.parse(row.execution_context_json));
        });
        expect(workflowInput).toMatchObject({
          loopId: substreamLoopId(WORKSTREAM_ID),
          harnessRunId: runId,
          triggerMessageId: null,
          scheduledWakeupId: wakeupId,
        });

        // Lose every in-memory activation hint before the executor runs, then
        // replay the same public launch. Stable source/run identity must re-arm
        // the existing receipt, not mint a second execution or model input. If
        // the autonomous alarm already terminalized it, replay still returns
        // that stable receipt and never attempts to reactivate it.
        await evictDurableObject(stub);
        await expect(launchWorkstreamHarness(TEST_ENV, activation)).resolves.toBe(runId);
        await runInDurableObject(stub, (_instance, state) => {
          expect(state.storage.sql.exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM runs WHERE run_id = ?`,
            runId,
          ).one().count).toBe(1);
        });

        const run = await settledRun(stub, runId);
        expect(run.status).toBe("failed");
        expect(PRE_PROVIDER_FAILURES).not.toContain(failureCode(run));
        await waitForLoopRelease(stub);
        return {
          runId,
          workflowInput,
          providerRequests: await capturedProviderRequests(stub),
        };
      } finally {
        await restoreProviderFetch(stub);
      }
    })();

    const chatRequests = providerRequests.filter((request) =>
      request.url === "https://openrouter.ai/api/v1/chat/completions");
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0]!.body.model).toBe(SCHEDULED_ACTIVATION_MODEL);
    const providerMessages = chatRequests[0]!.body.messages as Array<{
      role?: unknown;
      content?: unknown;
    }>;
    expect(providerMessages.filter((message) =>
      message.role === "user" && JSON.stringify(message.content).includes(wakeupPrompt)))
      .toHaveLength(1);

    const durableBeforeTerminalReplay = await runInDurableObject(stub, (_instance, state) => {
      const participantPromptCopies = new WorkstreamTranscriptStorage(state.storage)
        .createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null })
        .ranges.flatMap((range) => range.turns)
        .filter((turn) => turn.blocks.some((block) =>
          block.type === "text" && block.text.includes(wakeupPrompt)));
      expect(participantPromptCopies).toHaveLength(0);
      const activationRows = state.storage.sql.exec<{
        activation_input_id: string;
        fact_kind: string;
        source_kind: string | null;
        source_id: string | null;
        source_revision: number | null;
        payload_json: string;
        admitted_state_revision: number;
      }>(
        `SELECT receipt.activation_input_id, receipt.admitted_state_revision,
                fact.fact_kind, fact.source_kind, fact.source_id, fact.source_revision,
                payload.payload_json
           FROM bind_activation_inputs receipt
           JOIN transcript_facts fact ON fact.fact_id = receipt.fact_id
           JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
          WHERE receipt.loop_id = ? AND fact.source_kind = 'scheduled_wakeup'
            AND fact.source_id = ?`,
        substreamLoopId(WORKSTREAM_ID),
        wakeupId,
      ).toArray();
      expect(activationRows).toHaveLength(1);
      expect(activationRows[0]).toMatchObject({
        activation_input_id: `activation:${JSON.stringify(["scheduled_wakeup", wakeupId, null])}`,
        fact_kind: "activation_input",
        source_kind: "scheduled_wakeup",
        source_id: wakeupId,
        source_revision: null,
      });
      expect(JSON.parse(activationRows[0]!.payload_json)).toMatchObject({
        role: "user",
        content: expect.stringContaining(wakeupPrompt),
      });

      const boundary = state.storage.sql.exec<{
        state_revision: number;
        projected_hash: string;
        bind_hash: string;
      }>(
        `SELECT state_revision, projected_hash, bind_hash
           FROM bind_provider_boundaries WHERE loop_id = ?
          ORDER BY state_revision DESC LIMIT 1`,
        substreamLoopId(WORKSTREAM_ID),
      ).one();
      expect(boundary.projected_hash).toBe(boundary.bind_hash);
      expect(boundary.state_revision).toBeGreaterThan(existingBindRevision);
      expect(boundary.state_revision).toBeGreaterThanOrEqual(activationRows[0]!.admitted_state_revision);
      // Storage holds one current projected state per loop (v35's head model),
      // so the exactly-once claim is asked of that state rather than of a
      // per-revision history the schema deliberately does not keep.
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM bind_loop_state_messages projected
           JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
          WHERE projected.loop_id = ?
            AND fact.source_kind = 'scheduled_wakeup' AND fact.source_id = ?`,
        substreamLoopId(WORKSTREAM_ID),
        wakeupId,
      ).one().count).toBe(1);

      return {
        activationInputs: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM bind_activation_inputs
            WHERE loop_id = ? AND activation_input_id = ?`,
          substreamLoopId(WORKSTREAM_ID),
          `activation:${JSON.stringify(["scheduled_wakeup", wakeupId, null])}`,
        ).one().count,
        providerBoundaries: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM bind_provider_boundaries WHERE loop_id = ?`,
          substreamLoopId(WORKSTREAM_ID),
        ).one().count,
        inferenceAttempts: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM inference_attempts WHERE run_id = ?`,
          runId,
        ).one().count,
        runs: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM runs WHERE run_id = ?`,
          runId,
        ).one().count,
      };
    });
    expect(durableBeforeTerminalReplay).toMatchObject({
      activationInputs: 1,
      inferenceAttempts: 1,
      runs: 1,
    });

    // A late delivery retry reaches the replacement object through the real
    // activation RPC. The terminal receipt refuses re-execution, and—more
    // importantly—the durable Bind/source identities remain byte-for-byte one.
    await evictDurableObject(stub);
    const terminalReplay = await (stub as unknown as {
      activateLoop(input: WorkstreamWorkflowInput): Promise<{
        status: number;
        bodyJson: string;
      }>;
    }).activateLoop(workflowInput);
    expect(terminalReplay.status).toBe(409);
    expect(JSON.parse(terminalReplay.bodyJson)).toMatchObject({
      error: "substream_loop_execution_receipt_terminal",
    });
    const durableAfterTerminalReplay = await runInDurableObject(stub, (_instance, state) => ({
      activationInputs: state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM bind_activation_inputs
          WHERE loop_id = ? AND activation_input_id = ?`,
        substreamLoopId(WORKSTREAM_ID),
        `activation:${JSON.stringify(["scheduled_wakeup", wakeupId, null])}`,
      ).one().count,
      providerBoundaries: state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM bind_provider_boundaries WHERE loop_id = ?`,
        substreamLoopId(WORKSTREAM_ID),
      ).one().count,
      inferenceAttempts: state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM inference_attempts WHERE run_id = ?`,
        runId,
      ).one().count,
      runs: state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runs WHERE run_id = ?`,
        runId,
      ).one().count,
    }));
    expect(durableAfterTerminalReplay).toEqual(durableBeforeTerminalReplay);
  });

  it("admits an addressed follow-up as immutable pending input without publishing it early", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    // Settle the opening run before taking the hold: its activation alarm is
    // armed one millisecond out, and if it claims the loop first the hold's
    // `WHERE status = 'idle'` matches nothing and the fixture throws
    // `loop_hold_failed`. The sibling invoked-external-message test below
    // learned the same lesson.
    await settledRun(stub, opened.body.harnessRunId as string);

    await runInDurableObject(stub, async (instance, state) => {
      const productService = (instance as unknown as { product: WorkstreamObjectProductService }).product;
      // Admissions below schedule loop activation one millisecond out; on a
      // fast run the loop promotes the very inputs whose *pending* stage this
      // test asserts. Hold the step in flight — the state a follow-up really
      // queues behind — so pending is a fact rather than a race.
      holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
      // The regional-effect claim below is "admission wrote no NEW effect",
      // established by comparing message-id sets: the background drain
      // legitimately empties this queue at any moment, so an absolute row
      // count races it by construction.
      const effectIdsBefore = new Set(state.storage.sql.exec<{ message_id: string }>(
        `SELECT message_id FROM durable_outbox WHERE channel = 'regional_effect_v1'`,
      ).toArray().map((row) => row.message_id));
      const before = {
        turns: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
        ).one().count,
        runs: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM runs`,
        ).one().count,
        transcriptSequence: state.storage.sql.exec<{ next_transcript_sequence: number }>(
          `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
        ).one().next_transcript_sequence,
        attention: state.storage.sql.exec<{ next_attention_ordinal: number }>(
          `SELECT next_attention_ordinal FROM workstream WHERE id = 1`,
        ).one().next_attention_ordinal,
      };
      const input = {
        text: "exactly once after the safe boundary",
        clientMessageId: "pipeline-pending-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      };
      const first = await productService.createMessage(AUTH, input);
      const replay = await productService.createMessage(AUTH, input);
      const concurrentInput = {
        ...input,
        text: "one future turn under interleaving",
        clientMessageId: "pipeline-pending-concurrent-1",
      };
      const concurrent = await Promise.all([
        productService.createMessage(AUTH, concurrentInput),
        productService.createMessage(AUTH, concurrentInput),
      ]);

      expect(first).toMatchObject({
        deliveryState: "pending",
        inserted: true,
        // No wake is requested while a step is in flight: the held loop
        // observes queued input at its own safe boundary. Idle-loop admission
        // returning an activate_substream_loop request is proved end-to-end by
        // the promotion test below, which actually mints the run.
        activationRequest: null,
      });
      expect(replay).toMatchObject({
        turn: { turnId: first.turn.turnId },
        deliveryState: "pending",
        inserted: false,
      });
      expect(concurrent[0].turn.turnId).toBe(concurrent[1].turn.turnId);
      expect(concurrent.map((result) => result.inserted).sort()).toEqual([false, true]);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM substream_loops`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ loop_id: string }>(
        `SELECT loop_id FROM substream_loops WHERE id = 1`,
      ).one().loop_id).toBe(substreamLoopId(WORKSTREAM_ID));
      const openingContext = JSON.parse(state.storage.sql.exec<{
        execution_context_json: string;
      }>(
        `SELECT execution_context_json FROM runs WHERE run_id = ?`,
        opened.body.harnessRunId as string,
      ).one().execution_context_json) as Record<string, unknown>;
      expect(openingContext).toMatchObject({
        loopId: substreamLoopId(WORKSTREAM_ID),
        harnessRunId: opened.body.harnessRunId,
      });
      expect(openingContext.loopId).not.toBe(opened.body.harnessRunId);
      const pending = state.storage.sql.exec<{
        prepared_turn_id: string;
        client_message_id: string;
        prepared_payload_json: string;
        provenance_json: string;
        authorization_json: string;
        attachments_json: string;
        mentions_json: string;
      }>(
        `SELECT prepared_turn_id, client_message_id, prepared_payload_json,
                provenance_json, authorization_json, attachments_json, mentions_json
           FROM pending_loop_inputs WHERE client_message_id = ?`,
        input.clientMessageId,
      ).one();
      expect(pending).toMatchObject({
        prepared_turn_id: first.turn.turnId,
        client_message_id: input.clientMessageId,
        attachments_json: "[]",
        mentions_json: "[]",
      });
      expect(JSON.parse(pending.prepared_payload_json)).toMatchObject({
        role: "user",
        content: input.text,
      });
      expect(JSON.parse(pending.provenance_json)).toMatchObject({
        factKind: "participant_message",
        originKind: "canonical",
        sourceKind: null,
        sourceId: null,
        sourceRevision: null,
        runId: null,
        toolCallId: null,
      });
      expect(JSON.parse(pending.authorization_json)).toMatchObject({
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        executionPrincipal: { type: "user", userId: USER_ID },
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns
          WHERE client_message_id = ?`,
        input.clientMessageId,
      ).one().count).toBe(0);
      expect({
        turns: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
        ).one().count,
        runs: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM runs`,
        ).one().count,
        transcriptSequence: state.storage.sql.exec<{ next_transcript_sequence: number }>(
          `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
        ).one().next_transcript_sequence,
        attention: state.storage.sql.exec<{ next_attention_ordinal: number }>(
          `SELECT next_attention_ordinal FROM workstream WHERE id = 1`,
        ).one().next_attention_ordinal,
      }).toEqual(before);
      const newEffectIds = state.storage.sql.exec<{ message_id: string }>(
        `SELECT message_id FROM durable_outbox WHERE channel = 'regional_effect_v1'`,
      ).toArray().map((row) => row.message_id)
        .filter((messageId) => !effectIdsBefore.has(messageId));
      expect(newEffectIds).toEqual([]);
    });
  });

  it("delivers an invoked external message through pending input before minting its run", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    // This is the forward-resume case that regressed: Bind already has a
    // durable head from an earlier execution, so the connector turn must enter
    // through pending delivery rather than rely on bootstrap history.
    await settledRun(stub, opened.body.harnessRunId as string);
    // Admission schedules loop activation one millisecond out, so on a fast
    // machine the input this test wants to observe as *pending* is already
    // promoted by the time the replay answers. Hold the loop mid-execution —
    // the durable state in which a queued connector message actually waits —
    // so the pending stage is a fact rather than a race.
    await runInDurableObject(stub, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
    });
    const now = Date.now();
    const messageId = "00000000-0000-7000-8000-0000000005d1";
    const actor = {
      provider: "slack",
      providerAccountId: "T123",
      providerUserId: "U456",
      displayName: "Taylor",
      avatarUrl: null,
    };
    const admitted = await externalAdmission(stub, "admitExternalMessage", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      messageId,
      clientMessageId: "slack:event:pending-1",
      actor,
      messageType: "text",
      text: "Please inspect the latest deploy",
      structuredContentJson: null,
      executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
      origin: "slack_workspace_message",
      slackOrigin: {
        teamId: "T123",
        actorSlackUserId: "U456",
        channelId: "C123",
        channelName: null,
        threadTs: "1710000000.000001",
        invocationType: "direct_message",
        channelType: "im",
        matchedAvalonUserId: null,
        nearbyMessagesStatus: "not_applicable",
        nearbyMessages: [],
        attachments: [],
      },
      runMode: "steer",
      now,
    });
    const replay = await externalAdmission(stub, "admitExternalMessage", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      messageId: "00000000-0000-7000-8000-0000000005d2",
      clientMessageId: "slack:event:pending-1",
      actor,
      messageType: "text",
      text: "Please inspect the latest deploy",
      structuredContentJson: null,
      executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
      origin: "slack_workspace_message",
      slackOrigin: {
        teamId: "T123",
        actorSlackUserId: "U456",
        channelId: "C123",
        channelName: null,
        threadTs: "1710000000.000001",
        invocationType: "direct_message",
        channelType: "im",
        matchedAvalonUserId: null,
        nearbyMessagesStatus: "not_applicable",
        nearbyMessages: [],
        attachments: [],
      },
      runMode: "steer",
      now: now + 1,
    });

    expect(admitted).toEqual({
      status: 200,
      body: {
        turn: {
          turnId: messageId,
          clientMessageId: "slack:event:pending-1",
          createdAt: new Date(now).toISOString(),
        },
        deliveryState: "pending",
      },
    });
    expect(replay).toEqual({
      status: 200,
      body: {
        turn: {
          turnId: messageId,
          clientMessageId: "slack:event:pending-1",
          createdAt: new Date(now).toISOString(),
        },
        deliveryState: "pending",
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE turn_id = ?`,
        messageId,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runs WHERE trigger_part_id = ?`,
        messageId,
      ).one().count).toBe(0);
      const pending = new SubstreamLoopStorage(state.storage).input(messageId)!;
      expect(pending).toMatchObject({
        actor: "external",
        external_actor_json: JSON.stringify(actor),
      });
      expect(JSON.parse(pending.authorization_json)).toMatchObject({
        executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
        reason: "slack_workspace_message",
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM pending_loop_inputs
          WHERE client_message_id = 'slack:event:pending-1'`,
      ).one().count).toBe(1);
    });

    // Pending is proved; let go of the held step so the loop can promote the
    // input and mint its execution receipt.
    await runInDurableObject(stub, (_instance, state) => {
      releaseHeldLoop(state);
    });
    const run = await settledRunForTrigger(stub, messageId);
    expect(PRE_PROVIDER_FAILURES).not.toContain(failureCode(run));
    const deliveredReplay = await externalAdmission(stub, "admitExternalMessage", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      messageId: "00000000-0000-7000-8000-0000000005d3",
      clientMessageId: "slack:event:pending-1",
      actor,
      messageType: "text",
      text: "Please inspect the latest deploy",
      structuredContentJson: null,
      executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
      origin: "slack_workspace_message",
      runMode: "steer",
      now: now + 2,
    });
    expect(deliveredReplay).toEqual({
      status: 200,
      body: {
        turn: {
          turnId: messageId,
          clientMessageId: "slack:event:pending-1",
          createdAt: expect.any(String),
        },
        deliveryState: "canonical",
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT author_type, external_actor_json FROM canonical_conversation_turn_details
          WHERE id = ?`,
        messageId,
      ).one()).toEqual({
        author_type: "external",
        external_actor_json: JSON.stringify(actor),
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runs WHERE trigger_part_id = ?`,
        messageId,
      ).one().count).toBe(1);
    });
  });

  it("keeps non-final external elicitation answers canonical and admits only the final answer", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    const firstId = "00000000-0000-7000-8000-0000000005e1";
    const finalId = "00000000-0000-7000-8000-0000000005e2";
    await runInDurableObject(stub, (_instance, state) => {
      for (const [elicitationId, createdAt] of [[firstId, 1], [finalId, 2]] as const) {
        state.storage.sql.exec(
          `INSERT INTO elicitation_requests
             (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
              minimum_selections, maximum_selections, target_user_id, status,
              answer_json, answered_by_user_id, external_actor_json, created_at, answered_at)
           VALUES (?, ?, ?, 'Choose', 'text', '[]', 0, NULL, NULL, 'pending',
                   NULL, NULL, NULL, ?, NULL)`,
          elicitationId,
          opened.body.harnessRunId as string,
          `${opened.body.harnessRunId as string}:turn:1:tool:${createdAt}`,
          createdAt,
        );
      }
    });
    const actor = {
      provider: "slack",
      providerAccountId: "T123",
      providerUserId: "U456",
      displayName: "Taylor",
      avatarUrl: null,
    };
    const answer = (elicitationId: string, messageId: string, clientMessageId: string) => ({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      elicitationId,
      answerJson: JSON.stringify("yes"),
      messageId,
      clientMessageId,
      actor,
      messageType: "elicitation" as const,
      text: "",
      structuredContentJson: answeredExternalElicitationContent("yes"),
      executionPrincipal: { type: "workspace" as const, workspaceId: WORKSPACE_ID },
      origin: "slack_workspace_elicitation_answer",
      parentHarnessRunId: opened.body.harnessRunId as string,
      runMode: "steer" as const,
      now: Date.now(),
    });
    const firstMessageId = "00000000-0000-7000-8000-0000000005f1";
    const finalMessageId = "00000000-0000-7000-8000-0000000005f2";
    const first = await externalAdmission(
      stub,
      "answerExternalElicitation",
      answer(firstId, firstMessageId, "slack:answer:first"),
    );
    const final = await externalAdmission(
      stub,
      "answerExternalElicitation",
      answer(finalId, finalMessageId, "slack:answer:final"),
    );

    expect(first).toEqual({
      status: 200,
      body: {
        turn: {
          turnId: firstMessageId,
          clientMessageId: "slack:answer:first",
          createdAt: expect.any(String),
        },
        deliveryState: "canonical",
      },
    });
    expect(final).toEqual({
      status: 200,
      body: {
        turn: {
          turnId: finalMessageId,
          clientMessageId: "slack:answer:final",
          createdAt: expect.any(String),
        },
        deliveryState: "pending",
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT elicitation_id, status FROM elicitation_requests ORDER BY created_at`,
      ).toArray()).toEqual([
        { elicitation_id: firstId, status: "answered" },
        { elicitation_id: finalId, status: "answered" },
      ]);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE turn_id = ?`,
        firstMessageId,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE turn_id = ?`,
        finalMessageId,
      ).one().count).toBe(0);
      expect(new SubstreamLoopStorage(state.storage).input(finalMessageId)).toMatchObject({
        actor: "external",
        message_type: "elicitation",
      });
    });
  });

  it("refuses an external answer when the durable elicitation targets another member", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    const elicitationId = "00000000-0000-7000-8000-0000000005e3";
    const targetUserId = "00000000-0000-4000-8000-000000000099";
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO elicitation_requests
           (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
            minimum_selections, maximum_selections, target_user_id, status,
            answer_json, answered_by_user_id, external_actor_json, created_at, answered_at)
         VALUES (?, ?, ?, 'Choose', 'text', '[]', 0, NULL, ?, 'pending',
                 NULL, NULL, NULL, ?, NULL)`,
        elicitationId,
        opened.body.harnessRunId as string,
        `${opened.body.harnessRunId as string}:turn:1:tool:0`,
        targetUserId,
        Date.now(),
      );
    });
    const response = await externalAdmission(stub, "answerExternalElicitation", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      elicitationId,
      answerJson: JSON.stringify("yes"),
      messageId: "00000000-0000-7000-8000-0000000005f3",
      clientMessageId: "slack:answer:target-mismatch",
      actor: {
        provider: "slack",
        providerAccountId: "T123",
        providerUserId: "U456",
        displayName: "Taylor",
        avatarUrl: null,
      },
      messageType: "elicitation",
      text: "",
      structuredContentJson: answeredExternalElicitationContent("yes"),
      executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
      origin: "slack_workspace_elicitation_answer",
      parentHarnessRunId: opened.body.harnessRunId as string,
      runMode: "steer",
      now: Date.now(),
    });
    expect(response.status).toBe(403);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT status, answer_json FROM elicitation_requests WHERE elicitation_id = ?`,
        elicitationId,
      ).one()).toEqual({ status: "pending", answer_json: null });
    });
  });

  it("retries a run whose newest turn is the assistant turn it failed on", async () => {
    // The retry a person actually clicks. Every other retry case here settles a
    // run that never spoke, so the newest conversation turn is the member
    // message that started it and its id is a UUID — which is how the fence
    // resolved from that turn came to be held as one, and why holding it as one
    // survived review. A real run speaks first: it answers, calls a tool, and
    // dies on a later step, leaving its own assistant turn newest, and an
    // assistant turn's id is `<loopId>:turn:<ordinal>`. Held as a UUID, the
    // retry threw `ZodError` before reaching any of its own guards, and the
    // socket reported the generic `substream_command_failed` — so the button
    // did nothing and explained nothing.
    const stub = agentStub();
    try {
      await installScriptedProvider(stub, [
        [
          { choices: [{ delta: { content: "here is what I found" }, finish_reason: null }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "retry-fence-tool-1",
                  type: "function",
                  function: { name: "core_current_time", arguments: "{}" },
                }],
              },
              finish_reason: "tool_calls",
            }],
          },
        ],
        // The step after the one that spoke. A refusal is the provider's own
        // terminal status, so the run fails where production's did — at the
        // provider — with the turn it already materialized left standing.
        "refuse",
      ], {
        primaryModel: RETRY_AFTER_ASSISTANT_TURN_MODEL,
        fallbackModels: [],
      });
      const opened = await initializeWorkstream(stub, "answer, then break");
      const failed = await settledRun(stub, opened.body.harnessRunId as string);
      expect(failed.status).toBe("failed");
      await waitForLoopRelease(stub);

      await runInDurableObject(stub, async (instance, state) => {
        const productService =
          (instance as unknown as { product: WorkstreamObjectProductService }).product;
        const newest = state.storage.sql.exec<{ id: string }>(
          `SELECT id FROM canonical_conversation_turn_details
            WHERE substream_id = '0' ORDER BY sequence_number DESC LIMIT 1`,
        ).one();
        // The premise, asserted rather than assumed: this case only exercises
        // the retry if the turn its fence resolves to is an assistant turn.
        expect(newest.id).toBe(`${substreamLoopId(WORKSTREAM_ID)}:turn:1`);

        const retryRunId = asHarnessRunId("00000000-0000-7000-8000-0000000000f2");
        const retry = await productService.retry(AUTH, retryRunId);
        // The fence is that assistant turn, carried whole. Dropping it to
        // `null` would also parse, and would replay against the trigger's own
        // window — losing anything said after the failure.
        expect(retry.activationRequest.workflowInput).toMatchObject({
          harnessRunId: retryRunId,
          transcriptFenceMessageId: newest.id,
          reason: "manual_retry",
        });
        // The receipt is what the replay reads back, so the fence has to
        // survive the round trip through storage, not just the call.
        expect(WorkstreamWorkflowInputSchema.parse(JSON.parse(
          state.storage.sql.exec<{ execution_context_json: string }>(
            `SELECT execution_context_json FROM runs WHERE run_id = ?`,
            retryRunId,
          ).one().execution_context_json,
        )).transcriptFenceMessageId).toBe(newest.id);
        // The other half of what was broken: the fence has to resolve, not just
        // parse. `resolveTranscriptFence` looks it up through this exact query,
        // and a turn key is what that column holds — so a fence the contract now
        // accepts and the storage cannot find would fail just as completely, one
        // stage later, as `fence_message_not_found`.
        expect(new WorkstreamMessageStorage(state.storage)
          .message({ messageId: newest.id })?.id).toBe(newest.id);
      });
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("records stop on the loop and makes retry durable as a subordinate execution receipt", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    // Settle the opening run first: this test claims the loop by hand, and the
    // opening run's live activation alarm would otherwise race that claim.
    await settledRun(stub, opened.body.harnessRunId as string);

    await runInDurableObject(stub, async (instance, state) => {
      const productService = (instance as unknown as { product: WorkstreamObjectProductService }).product;
      const loops = new SubstreamLoopStorage(state.storage);
      const initial = loops.loop()!;
      const now = Date.now();
      // A receipt deferred beyond the wall clock: the object's own drain skips
      // it on every alarm, so only this test's logical clock can claim it.
      const executionId = "00000000-0000-7000-8000-00000000e001";
      const deferredUntil = now + 3_600_000;
      const logicalNow = deferredUntil + 1;
      state.storage.sql.exec(
        `INSERT INTO runs (
           run_id, substream_id, status, budget, attempt_epoch,
           model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
           active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
           tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
           origin, execution_principal_json,
           execution_context_json, execution_available_at, chain_depth, created_at, updated_at
         ) VALUES (?, '0', 'admitted', '{}', 0, 0, '', 0, 0, ?,
                   0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                   'member_message', ?, ?, ?, 0, ?, ?)`,
        executionId,
        now,
        JSON.stringify({ type: "user", userId: USER_ID }),
        JSON.stringify({
          region: "global",
          workspaceId: WORKSPACE_ID,
          parentKind: "workstream",
          parentId: WORKSTREAM_ID,
          substreamId: "0",
          loopId: initial.loop_id,
          harnessRunId: executionId,
          triggerMessageId: null,
          activityId: null,
          executionPrincipal: { type: "user", userId: USER_ID },
          reason: "user_message",
        }),
        deferredUntil,
        now,
        now,
      );
      const leaseOwner = "product-control-test";
      const executing = loops.activateExecutionReceipt({
        runId: executionId,
        loopId: initial.loop_id,
        executionEpoch: 1,
        leaseOwner,
        leaseExpiresAt: logicalNow + 60_000,
        expectedLoopRevision: initial.revision,
        expectedBindStateRevision: initial.bind_state_revision,
        now: logicalNow,
      }).loop;

      await productService.stop(AUTH, "00000000-0000-7000-8000-0000000005cf");
      const stopped = loops.loop()!;
      expect(stopped).toMatchObject({
        loop_id: substreamLoopId(WORKSTREAM_ID),
        status: "executing",
        active_execution_id: executionId,
        stop_after_step_ordinal: executing.step_ordinal,
        stop_reason: "stopped_by_user",
      });
      expect(state.storage.sql.exec<{ cancellation_requested_at: number | null }>(
        `SELECT cancellation_requested_at FROM runs WHERE run_id = ?`,
        executionId,
      ).one().cancellation_requested_at).toBeNull();

      await productService.recordWorkflowFailed(
        executionId,
        { code: "test_execution_settled", message: "Test execution settled" },
        {
          loopId: stopped.loop_id,
          executionId,
          executionEpoch: 1,
          leaseOwner,
        },
      );
      const idle = loops.loop()!;
      const runCount = state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runs`,
      ).one().count;
      await expect(productService.retry(AUTH, asHarnessRunId(executionId))).rejects.toMatchObject({
        status: 409,
        code: "substream_command_idempotency_conflict",
      });
      const retryRunId = asHarnessRunId("00000000-0000-7000-8000-0000000000f1");
      const [retry, concurrentReplay] = await Promise.all([
        productService.retry(AUTH, retryRunId),
        productService.retry(AUTH, retryRunId),
      ]);
      expect(concurrentReplay).toEqual(retry);

      expect(retry).toMatchObject({
        activationRequest: {
          kind: "activate_substream_loop",
          loopId: idle.loop_id,
          cause: "manual_retry",
          inputId: null,
          receiptRunId: retry.harnessRunId,
          workflowInput: {
            loopId: idle.loop_id,
            harnessRunId: retry.harnessRunId,
            executionPrincipal: { type: "user", userId: USER_ID },
            reason: "manual_retry",
          },
        },
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runs`,
      ).one().count).toBe(runCount + 1);
      await expect(productService.retry(AUTH, retryRunId)).resolves.toEqual(retry);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runs`,
      ).one().count).toBe(runCount + 1);
      const receipt = state.storage.sql.exec<{
        status: string;
        origin: string;
        substream_loop_id: string | null;
        execution_context_json: string;
      }>(
        `SELECT status, origin, substream_loop_id, execution_context_json
           FROM runs WHERE run_id = ?`,
        retry.harnessRunId,
      ).one();
      expect(receipt).toMatchObject({
        status: "admitted",
        origin: "manual_retry",
        substream_loop_id: null,
      });
      expect(JSON.parse(receipt.execution_context_json)).toEqual(
        retry.activationRequest.workflowInput,
      );
      expect(loops.loop()).toMatchObject({
        loop_id: initial.loop_id,
        status: "idle",
      });
    });
    // The budget covers driving a real run through admission and the alarm to
    // the provider boundary, not the stop and retry assertions that follow
    // inside the fenced `runInDurableObject` block.
  });

  it("a follow-up is promoted by the same loop after the failed execution releases it", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    // Hold the step so the pending mid-state below is observable rather than a
    // race against the one-millisecond activation alarm; released before the
    // promotion this test is actually about.
    await runInDurableObject(stub, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
    });

    const followUp = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "are you still there?",
        clientMessageId: "pipeline-follow-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });

    expect(followUp.status).toBe(200);
    expect(followUp.body).toEqual({
      turn: {
        turnId: expect.any(String),
        clientMessageId: "pipeline-follow-1",
        createdAt: expect.any(String),
      },
      deliveryState: "pending",
    });
    const turnId = (followUp.body.turn as { turnId: string }).turnId;
    await runInDurableObject(stub, (_instance, state) => {
      expect(new SubstreamLoopStorage(state.storage).pendingInputs()
        .map((input) => input.prepared_turn_id)).toContain(turnId);
      expect(state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs
          WHERE json_extract(execution_context_json, '$.triggerMessageId') = ?`,
        turnId,
      ).one().n).toBe(0);
    });

    await runInDurableObject(stub, (_instance, state) => {
      releaseHeldLoop(state);
    });
    const second = await settledRunForTrigger(stub, turnId);
    expect(second.run_id).not.toBe(opened.body.harnessRunId);
    expect(PRE_PROVIDER_FAILURES).not.toContain(failureCode(second));
  });

  it("carries a message queued during a live run to the model once that run ends", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          [{ choices: [{ delta: { content: "answering the first" }, finish_reason: "stop" }] }],
          [{ choices: [{ delta: { content: "answering the queued one" }, finish_reason: "stop" }] }],
        ],
        {
          primaryModel: QUEUED_FOLLOW_UP_MODEL,
          fallbackModels: [],
          gateFirstCall: true,
        },
      );
      const opened = await initializeWorkstream(
        stub,
        "first message",
        QUEUED_FOLLOW_UP_MODEL,
      );
      // Real execution, not a fixture hold: this is the state in which the
      // composer stops offering steer at all and the server admits the message
      // as `queue`, which is the delivery mode under test.
      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ status: string }>(
          `SELECT status FROM substream_loops WHERE id = 1`,
        ).toArray()[0]?.status ?? "absent"), {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "the opening run never took the loop",
      }).toBe("executing");

      const followUp = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "and answer this next",
          clientMessageId: "pipeline-queued-1",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(followUp.status).toBe(200);
      expect(followUp.body.deliveryState).toBe("pending");
      const turnId = (followUp.body.turn as { turnId: string }).turnId;
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ mode: string }>(
          `SELECT mode FROM pending_loop_inputs WHERE prepared_turn_id = ?`,
          turnId,
        ).one().mode)).toBe("queue");

      await openProviderGate(stub);
      await externallySettledRun(stub, opened.body.harnessRunId as string);

      // Deliberately without `runDurableObjectAlarm`: a queued message is
      // admitted with no activation request of its own, so the loop that just
      // finished is the only thing that can carry it to the model. Forcing an
      // alarm here would supply the wake-up whose absence is the bug.
      await expect.poll(async () => runInDurableObject(stub, (_instance, state) => {
        const rows = state.storage.sql.exec<{
          run_id: string;
          status: string;
          terminalized_at: number | null;
          execution_context_json: string;
        }>(
          `SELECT run_id, status, terminalized_at, execution_context_json FROM runs
            WHERE execution_context_json IS NOT NULL ORDER BY created_at, run_id`,
        ).toArray();
        const row = rows.find((candidate) => (
          JSON.parse(candidate.execution_context_json) as { triggerMessageId?: string | null }
        ).triggerMessageId === turnId);
        if (!row) {
          return {
            outcome: "no execution receipt was minted for the queued message",
            status: null as string | null,
          };
        }
        return {
          outcome: row.terminalized_at === null ? "the queued run never settled" : "settled",
          status: row.status,
        };
      }), {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 50,
      }).toMatchObject({ outcome: "settled" });

      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_inputs`,
        ).one().count)).toBe(0);
      const providerRequests = await capturedProviderRequests(stub);
      const asked = providerRequests.flatMap((request) =>
        (request.body.messages as Array<{ role?: unknown; content?: unknown }>)
          .filter((message) => message.role === "user"
            && JSON.stringify(message.content).includes("and answer this next")));
      expect(asked.length).toBeGreaterThan(0);
    } finally {
      // Before tearing the install down, and unconditionally: a failed
      // assertion above would otherwise leave the held provider call parked in
      // its wait loop for the rest of the file, where it outlives this test and
      // can hang or contaminate the next one. Tolerant of a gate that was never
      // installed, because an `installScriptedProvider` that itself threw
      // reaches here too.
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("carries a message that started no run to the model on the next run", async () => {
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          [{ choices: [{ delta: { content: "looked into it" }, finish_reason: "stop" }] }],
          [{ choices: [{ delta: { content: "here is the summary" }, finish_reason: "stop" }] }],
        ],
        { primaryModel: ASIDE_MODEL, fallbackModels: [] },
      );
      // Two people in the room. With one, every message is aimed at the agent
      // by construction and nothing here could be an aside.
      const opened = await initializeWorkstream(stub, "please look into this", ASIDE_MODEL, [OTHER_USER_ID]);
      expect(opened.status).toBe(200);
      await settledRun(stub, opened.body.harnessRunId as string);
      await waitForLoopRelease(stub);
      const runsBefore = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM runs`).one().count);

      // A remark to the other person. The heuristic classifier settles this
      // deterministically as human conversation, so no model is asked and no
      // run starts — which is the whole condition under test: the turn is
      // canonical, visible to every member, and until now never entered the
      // projection the model reads.
      const aside = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "sounds good",
          clientMessageId: "pipeline-aside-1",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(aside.status).toBe(200);
      const asideTurnId = (aside.body.turn as { turnId: string }).turnId;
      expect(await runInDurableObject(stub, (_instance, state) => ({
        pending: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_inputs`,
        ).one().count,
        runs: state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM runs`).one().count,
        canonical: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE turn_id = ?`,
          asideTurnId,
        ).one().count,
      }))).toEqual({ pending: 0, runs: runsBefore, canonical: 1 });

      // Then a message that does start a run. Its admission is what carries the
      // aside across: everything the projection has not looked at, in
      // transcript order, ahead of the message that follows it.
      const question = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "please summarize what we agreed",
          clientMessageId: "pipeline-aside-2",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(question.status).toBe(200);
      const questionTurnId = (question.body.turn as { turnId: string }).turnId;
      await settledRunForTrigger(stub, questionTurnId);

      const requests = await capturedProviderRequests(stub);
      const last = requests.at(-1);
      expect(last).toBeDefined();
      const userTexts = (last!.body.messages as Array<{ role?: unknown; content?: unknown }>)
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content));
      const asideIndex = userTexts.findIndex((text) => text.includes("sounds good"));
      const questionIndex = userTexts.findIndex((text) => text.includes("please summarize what we agreed"));
      expect(asideIndex, "the aside never reached the model").toBeGreaterThanOrEqual(0);
      expect(questionIndex).toBeGreaterThan(asideIndex);

      // And the loop knows it has looked this far: through the aside, which is
      // what the gap-fill scanned. Not through the question — its sequence was
      // allocated after the scan, and a turn written between the two would
      // otherwise sit below the mark unseen. The question is skipped on the
      // next scan by its provenance, not by the mark.
      const mark = await runInDurableObject(stub, (_instance, state) => ({
        projectedThrough: state.storage.sql.exec<{ transcript_projected_through: number }>(
          `SELECT transcript_projected_through FROM substream_loops WHERE id = 1`,
        ).one().transcript_projected_through,
        asideSequence: state.storage.sql.exec<{ transcript_sequence: number }>(
          `SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?`,
          asideTurnId,
        ).one().transcript_sequence,
        questionSequence: state.storage.sql.exec<{ transcript_sequence: number }>(
          `SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?`,
          questionTurnId,
        ).one().transcript_sequence,
      }));
      expect(mark.projectedThrough).toBe(mark.asideSequence);
      expect(mark.questionSequence).toBeGreaterThan(mark.projectedThrough);
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("carries an aside written between a question's admission and its activation", async () => {
    // The window the first version missed. A question is admitted — its
    // mailbox row records the transcript high-water at that instant — and
    // somebody talks before the alarm activates it. The aside sits above the
    // admission fence; the question's own turn is allocated at activation,
    // above the aside. Scanning to the fence skipped the aside, and marking the
    // question's turn then buried it. Both are reachable in any room where an
    // activation's alarm takes longer than a person's next message.
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          [{ choices: [{ delta: { content: "looked into it" }, finish_reason: "stop" }] }],
          [{ choices: [{ delta: { content: "here is the summary" }, finish_reason: "stop" }] }],
          [{ choices: [{ delta: { content: "and after that" }, finish_reason: "stop" }] }],
        ],
        { primaryModel: ASIDE_WINDOW_MODEL, fallbackModels: [] },
      );
      const opened = await initializeWorkstream(stub, "please look into this", ASIDE_WINDOW_MODEL, [OTHER_USER_ID]);
      expect(opened.status).toBe(200);
      await settledRun(stub, opened.body.harnessRunId as string);
      await waitForLoopRelease(stub);

      // Hold activation: the admission arms an alarm and asks for a wake-up,
      // and both are swallowed until the aside is in.
      const held = await runInDurableObject(stub, (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          requestPersistentLoopActivation: (request: unknown) => Promise<void>;
        };
        const original = { alarm: target.alarm, activate: target.requestPersistentLoopActivation };
        target.alarm = async () => {};
        target.requestPersistentLoopActivation = async () => {};
        return original;
      });
      const question = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "please summarize what we agreed",
          clientMessageId: "pipeline-aside-window-1",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(question.status).toBe(200);
      const questionTurnId = (question.body.turn as { turnId: string }).turnId;
      const aside = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "sounds good",
          clientMessageId: "pipeline-aside-window-2",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(aside.status).toBe(200);
      const asideTurnId = (aside.body.turn as { turnId: string }).turnId;
      const before = await runInDurableObject(stub, (_instance, state) => ({
        pending: state.storage.sql.exec<{ admitted_after_transcript_sequence: number }>(
          `SELECT admitted_after_transcript_sequence FROM pending_loop_inputs`,
        ).toArray(),
        asideSequence: state.storage.sql.exec<{ transcript_sequence: number }>(
          `SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?`,
          asideTurnId,
        ).one().transcript_sequence,
      }));
      // The question is still waiting, and the aside landed above its fence.
      expect(before.pending).toHaveLength(1);
      expect(before.asideSequence).toBeGreaterThan(before.pending[0]!.admitted_after_transcript_sequence);

      await runInDurableObject(stub, async (instance, state) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          requestPersistentLoopActivation: (request: unknown) => Promise<void>;
        };
        target.alarm = held.alarm;
        target.requestPersistentLoopActivation = held.activate;
        await state.storage.setAlarm(Date.now());
      });
      await settledRunForTrigger(stub, questionTurnId);

      const userTexts = (message: { role?: unknown; content?: unknown }) =>
        message.role === "user" ? [JSON.stringify(message.content)] : [];
      const requests = await capturedProviderRequests(stub);
      const texts = (requests.at(-1)!.body.messages as Array<{ role?: unknown; content?: unknown }>).flatMap(userTexts);
      const asideIndex = texts.findIndex((text) => text.includes("sounds good"));
      const questionIndex = texts.findIndex((text) => text.includes("please summarize what we agreed"));
      expect(asideIndex, "the aside in the admission window never reached the model").toBeGreaterThanOrEqual(0);
      expect(questionIndex).toBeGreaterThan(asideIndex);
      // Rendered as what it is: something said to the room, not a request.
      expect(texts[asideIndex]).toContain("SAID TO THE ROOM, NOT TO RALLY");
      expect(texts[questionIndex]).not.toContain("SAID TO THE ROOM");

      // The mark stopped at the aside. The question, above it, is skipped by
      // its provenance on the next scan rather than appended twice.
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ transcript_projected_through: number }>(
          `SELECT transcript_projected_through FROM substream_loops WHERE id = 1`,
        ).one().transcript_projected_through)).toBe(before.asideSequence);
      const follow = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          // Phrased like the question so the same deterministic fast path
          // admits it without asking a model whether it is addressed.
          text: "please summarize the risks",
          clientMessageId: "pipeline-aside-window-3",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(follow.status).toBe(200);
      await settledRunForTrigger(stub, (follow.body.turn as { turnId: string }).turnId);
      const later = ((await capturedProviderRequests(stub)).at(-1)!.body.messages as Array<{ role?: unknown; content?: unknown }>)
        .flatMap(userTexts);
      expect(later.filter((text) => text.includes("please summarize what we agreed"))).toHaveLength(1);
      expect(later.filter((text) => text.includes("sounds good"))).toHaveLength(1);
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("keeps an aside said while a question was open for the next request, after the answer", async () => {
    // People talk while Rally's question is open. The answer is a tool result
    // that has to follow its call directly, so it carries no gap-fill — and it
    // must not move the mark past what was said meanwhile, or those turns are
    // gone. They belong to the next text input, which appends them after the
    // result and before itself.
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          [{
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "aside-elicitation-1",
                  type: "function",
                  function: {
                    name: "core_request_elicitation",
                    arguments: JSON.stringify({
                      prompt: "Which option?",
                      responseType: "radio",
                      options: [
                        { value: "a", label: "Option A", description: null },
                        { value: "b", label: "Option B", description: null },
                      ],
                      minimumSelections: 1,
                      maximumSelections: 1,
                    }),
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          }],
          [{ choices: [{ delta: { content: "noted, going with A" }, finish_reason: "stop" }] }],
          [{ choices: [{ delta: { content: "here is the summary" }, finish_reason: "stop" }] }],
        ],
        { primaryModel: ASIDE_ELICITATION_MODEL, fallbackModels: [] },
      );
      const opened = await initializeWorkstream(stub, "please decide between the options", ASIDE_ELICITATION_MODEL, [OTHER_USER_ID]);
      expect(opened.status).toBe(200);
      const asked = await settledRun(stub, opened.body.harnessRunId as string);
      expect(asked.status).toBe("needs_input");
      await waitForLoopRelease(stub);
      const elicitationId = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ elicitation_id: string }>(
          `SELECT elicitation_id FROM elicitation_requests WHERE status = 'pending'`,
        ).one().elicitation_id);

      const aside = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "sounds good",
          clientMessageId: "pipeline-aside-elicitation-1",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(aside.status).toBe(200);
      const asideSequence = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ transcript_sequence: number }>(
          `SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?`,
          (aside.body.turn as { turnId: string }).turnId,
        ).one().transcript_sequence);

      const answered = await product(stub, {
        operation: "answer_elicitation",
        auth: AUTH,
        elicitationId,
        input: { answer: "a" },
      });
      expect(answered.status).toBe(200);
      // The answer resumes the loop: its run is the second row.
      let resumedRunId: string | null = null;
      await expect.poll(async () => {
        resumedRunId = await runInDurableObject(stub, (_instance, state) =>
          state.storage.sql.exec<{ run_id: string }>(
            `SELECT run_id FROM runs ORDER BY created_at, run_id`,
          ).toArray()[1]?.run_id ?? null);
        return resumedRunId === null ? "the answer started no run" : "resumed";
      }, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe("resumed");
      await settledRun(stub, resumedRunId!);
      await waitForLoopRelease(stub);
      // The answer advanced nothing: the aside is still above the mark.
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ transcript_projected_through: number }>(
          `SELECT transcript_projected_through FROM substream_loops WHERE id = 1`,
        ).one().transcript_projected_through)).toBeLessThan(asideSequence);

      const question = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "please summarize what we agreed",
          clientMessageId: "pipeline-aside-elicitation-2",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(question.status).toBe(200);
      await settledRunForTrigger(stub, (question.body.turn as { turnId: string }).turnId);

      const messages = (await capturedProviderRequests(stub)).at(-1)!.body.messages as Array<{ role?: unknown; content?: unknown }>;
      const index = (predicate: (message: { role?: unknown; content?: unknown }) => boolean) => messages.findIndex(predicate);
      const toolResult = index((message) => message.role === "tool");
      const asideIndex = index((message) => message.role === "user" && JSON.stringify(message.content).includes("sounds good"));
      const questionIndex = index((message) => message.role === "user" && JSON.stringify(message.content).includes("please summarize what we agreed"));
      expect(toolResult, "the answer never reached the model as a tool result").toBeGreaterThanOrEqual(0);
      expect(asideIndex, "the aside said during the question never reached the model").toBeGreaterThan(toolResult);
      expect(questionIndex).toBeGreaterThan(asideIndex);
      expect(messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("sounds good"))).toHaveLength(1);
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("carries a backlog wider than one statement's bound parameters", async () => {
    // A quiet-agent room where people talk for a day. The gap-fill's range is
    // everything since the last admission, and its hydration expands turn ids
    // into `IN (?, …)` lists — which the engine refuses past 100 parameters.
    // A backlog past the chunk size must hydrate whole, or the admission that
    // meets it throws and the room stops processing anything after it.
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          [{ choices: [{ delta: { content: "looked into it" }, finish_reason: "stop" }] }],
          [{ choices: [{ delta: { content: "here is the summary" }, finish_reason: "stop" }] }],
        ],
        { primaryModel: ASIDE_BACKLOG_MODEL, fallbackModels: [] },
      );
      const opened = await initializeWorkstream(stub, "please look into this", ASIDE_BACKLOG_MODEL, [OTHER_USER_ID]);
      expect(opened.status).toBe(200);
      await settledRun(stub, opened.body.harnessRunId as string);
      await waitForLoopRelease(stub);
      // Past the engine's own ceiling of 100, not merely past the chunk the
      // hydration uses beneath it: only then does an unchunked list fail.
      const backlog = 105;
      expect(backlog).toBeGreaterThan(BOUND_PARAMETER_ID_CHUNK);
      for (let index = 0; index < backlog; index += 1) {
        const aside = await product(stub, {
          operation: "create_message",
          auth: AUTH,
          input: {
            text: "sounds good",
            clientMessageId: `pipeline-aside-backlog-${index}`,
            mentions: [],
            confirmedParticipantUserIds: [],
            attachmentIds: [],
          },
        });
        expect(aside.status).toBe(200);
      }
      const question = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "please summarize what we agreed",
          clientMessageId: "pipeline-aside-backlog-question",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(question.status).toBe(200);
      const settled = await settledRunForTrigger(stub, (question.body.turn as { turnId: string }).turnId);
      expect(settled.status).toBe("completed");
      const texts = ((await capturedProviderRequests(stub)).at(-1)!.body.messages as Array<{ role?: unknown; content?: unknown }>)
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content));
      expect(texts.filter((text) => text.includes("sounds good"))).toHaveLength(backlog);
      expect(texts.at(-1)).toContain("please summarize what we agreed");
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("recovers an admitted message whose preparation is interrupted", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await externallySettledRun(stub, opened.body.harnessRunId as string);
    await waitForLoopRelease(stub);
    // The oracle below is that the *admission* is what arms the alarm, so this
    // proves the object has no wake-up of its own left to take credit for it.
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
      { timeout: LOOP_RELEASE_TIMEOUT_MS, interval: 50, message: "the object never quiesced" },
    ).toBeNull();

    let armOrder: { mailboxRowsAtFirstArm: number | null } = { mailboxRowsAtFirstArm: null };
    const gate = await runInDurableObject(stub, (instance) => {
      const product = (instance as unknown as {
        product: WorkstreamObjectProductService;
      }).product;
      // `env` is a constructor parameter property: private to the compiler,
      // an ordinary writable field to the runtime this test replaces it in.
      const held = holdFirstWorkspaceRead(product as unknown as { env: Env });
      armOrder = recordFirstAlarmArm(product as unknown as { storage: DurableObjectStorage });
      // Not awaited, and never released below: the invocation that commits the
      // reservation and then never returns is the case under test.
      void product.createMessage(AUTH, {
        text: "answer this once the run is over",
        clientMessageId: "pipeline-interrupted-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      }).catch(() => undefined);
      return held;
    });

    try {
      const reservedInputId = (): Promise<string | null> =>
        runInDurableObject(stub, (_instance, state) =>
          state.storage.sql.exec<{ input_id: string }>(
            `SELECT input_id FROM pending_loop_input_mailbox WHERE state = 'preparing'`,
          ).toArray()[0]?.input_id ?? null);
      await expect.poll(reservedInputId, {
        timeout: SUBSCRIPTION_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "the admission never reserved its mailbox row",
      }).not.toBeNull();
      const inputId = (await reservedInputId())!;

      // Armed before the row it covers, not after: a wake-up written second
      // leaves a window in which the reservation is durable and nothing is left
      // to rediscover it, which is the whole failure this guards.
      expect(armOrder.mailboxRowsAtFirstArm).toBe(0);

      // The reservation is durable; nothing else in this object knows about it,
      // because the head-of-line gate keeps it out of `pendingInputs` until it
      // settles. Without a wake-up the message — and everything queued behind
      // it — is stranded until something unrelated touches the object, which for
      // a work stream nobody reopens is never.
      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()))
        .not.toBeNull();
      // And it has to survive the wake it just bought: the alarm re-derives from
      // durable state on its way out, and an unresolved reservation that
      // contributes nothing there loses the wake-up again one heartbeat later.
      await runDurableObjectAlarm(stub);
      expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()))
        .not.toBeNull();

      // Age the claim past the recovery horizon. The suite cannot wait five real
      // minutes, and this claim is in memory rather than a row, so the instant it
      // was taken is rewound in place — the same move a durable-lease test makes
      // against `lease_expires_at`. Nothing else about the parked invocation
      // changes: it is still holding the first D1 read and will never return.
      await runInDurableObject(stub, (instance) => {
        const claims = (instance as unknown as {
          product: { activeInputPreparations: Map<string, { depth: number; claimedAt: number }> };
        }).product.activeInputPreparations;
        const claim = claims.get(inputId);
        expect(claim).toBeDefined();
        claims.set(inputId, { ...claim!, claimedAt: claim!.claimedAt - LOOP_EXECUTION_LEASE_MS - 1 });
      });

      // Recovery has to settle the mailbox row and carry the message to a run,
      // driven by the alarm rather than by the invocation that vanished — the
      // gate is never opened above, so the original `createMessage` is still
      // parked and cannot be what does this.
      await runDurableObjectAlarm(stub);
      await expect.poll(() => runInDurableObject(stub, (_instance, state) => {
        const settled = state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_input_mailbox
            WHERE input_id = ? AND state = 'preparing'`,
          inputId,
        ).one().count === 0;
        if (!settled) return "the interrupted preparation was never resumed";
        const minted = state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM runs
            WHERE json_extract(execution_context_json, '$.triggerMessageId') = ?`,
          inputId,
        ).one().count > 0;
        return minted ? "runnable" : "the resumed message never became runnable";
      }), { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toBe("runnable");
    } finally {
      // Unconditionally, and only here: every assertion above runs while the
      // admission is parked in a wait loop, and one that fails without this
      // would leave that loop spinning for the rest of the file.
      gate.open = true;
    }

    // The vanished invocation is fenced, not raced: released above, it finishes
    // against a client message id the takeover already made canonical, and it
    // must not admit a second copy of the same message.
    await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE client_message_id = ?`,
        "pipeline-interrupted-1",
      ).one().count), { timeout: SUBSCRIPTION_SETTLE_TIMEOUT_MS, interval: 25 }).toBe(1);
  });

  it("message writes are idempotent across the whole path", async () => {
    const stub = agentStub();
    await initializeWorkstream(stub, "first message");

    const input = {
      text: "exactly once",
      clientMessageId: "pipeline-dup-1",
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    };
    const first = await product(stub, { operation: "create_message", auth: AUTH, input });
    const repeat = await product(stub, { operation: "create_message", auth: AUTH, input });
    const conflict = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: { ...input, text: "different message under the reused id" },
    });

    expect(first.status).toBe(200);
    expect(repeat.status).toBe(200);
    expect(conflict).toMatchObject({
      status: 409,
      body: { error: "substream_message_idempotency_conflict" },
    });
    // The replay returns the same future turn and admits neither a duplicate
    // pending input nor any message-owned run.
    expect((repeat.body.turn as { turnId: string }).turnId)
      .toBe((first.body.turn as { turnId: string }).turnId);
    expect(Object.keys(first.body).sort()).toEqual(["deliveryState", "turn"]);
    expect(Object.keys(repeat.body).sort()).toEqual(["deliveryState", "turn"]);
    expect(["canonical", "pending"]).toContain(first.body.deliveryState);
    expect(["canonical", "pending"]).toContain(repeat.body.deliveryState);

    await runInDurableObject(stub, (_instance, state) => {
      const canonicalCopies = state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM participant_transcript_turns
          WHERE client_message_id = 'pipeline-dup-1'`,
      ).toArray()[0]!;
      const pendingCopies = state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pending_loop_inputs
          WHERE client_message_id = 'pipeline-dup-1'`,
      ).toArray()[0]!;
      // An alarm may promote the input between the two HTTP requests. The
      // authority invariant is one logical turn across both states, not which
      // side of that asynchronous boundary happens to be observed here.
      expect(canonicalCopies.n + pendingCopies.n).toBe(1);
    });
  });

  it("admits an idempotent message on the authenticated room socket across hibernation", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    const openingRunId = opened.body.harnessRunId as string;
    await settledRun(stub, openingRunId);
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005b7",
    );
    await runInDurableObject(stub, (instance) => {
      const productService = (instance as unknown as {
        product: { authorize: () => Promise<never> };
      }).product;
      productService.authorize = async () => {
        throw new Error("socket_message_reauthorized_workspace_membership");
      };
    });
    const command = {
      type: "create_message",
      operationId: "00000000-0000-7000-8000-0000000005b8",
      payload: {
        text: "send me to the room directly",
        clientMessageId: "pipeline-room-socket-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    };
    const firstReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify(command));
    const accepted = await firstReceipt;
    expect(accepted).toMatchObject({
      type: "client_command_succeeded",
      command: "create_message",
      clientMessageId: command.payload.clientMessageId,
      deliveryState: expect.stringMatching(/^(canonical|pending)$/u),
    });

    await evictDurableObject(stub);

    const replayReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify(command));
    expect(await replayReceipt).toMatchObject({
      type: "client_command_succeeded",
      command: "create_message",
      clientMessageId: command.payload.clientMessageId,
      turn: accepted.turn,
    });
    socket.close(1000, "done");
  });

  it("admits a message through a non-main child using its external loop identity", async () => {
    const substreamId = asSubstreamId("00000000-0000-7000-8000-0000000005d0");
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, substreamId),
    ));
    const child = stub as unknown as {
      bootstrapRuntime(input: Record<string, unknown>): Promise<{ status: number }>;
      executeIdentityOperation(input: Record<string, unknown>): Promise<{ status: number }>;
    };
    expect((await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      substreamId,
      generation: 1,
    })).status).toBe(200);
    expect((await child.executeIdentityOperation({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      substreamId,
      operation: "provision",
      args: [{
        title: "Child conversation",
        objective: "Exercise one independently owned conversation.",
        scope: "workspace",
        originType: "ad_hoc",
        createdByUserId: USER_ID,
        participantUserIds: [USER_ID],
        harnessStatus: "idle",
        emailAddress: null,
        emailRouteStatus: null,
        systemKind: null,
        automationRunId: null,
        plannedFor: null,
        modelOverride: null,
        now: Date.now(),
      }],
    })).status).toBe(200);

    // This direct bootstrap fixture bypasses the parent creation service, so
    // install the same creator membership mirror that service confirms before
    // issuing a child socket ticket.
    await stub.applyPrivateChildMembership({
      workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId,
      userId: USER_ID, actorUserId: USER_ID, active: true, membershipVersion: 1,
    });

    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005d1",
      substreamId,
    );
    const operationId = "00000000-0000-7000-8000-0000000005d2";
    const receipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "create_message",
      operationId,
      payload: {
        text: "child-local message",
        clientMessageId: "pipeline-child-socket-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    }));
    expect(await receipt).toMatchObject({
      type: "client_command_succeeded",
      command: "create_message",
      operationId,
      clientMessageId: "pipeline-child-socket-1",
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ loop_id: string }>(
        `SELECT loop_id FROM substream_loops WHERE id = 1`,
      ).one().loop_id).toBe(substreamLoopId(WORKSTREAM_ID, substreamId));
      expect(state.storage.sql.exec<{ id: string }>(
        `SELECT id FROM substreams ORDER BY id`,
      ).one().id).toBe("0");
    });
    socket.close(1000, "done");
  });

  it("correlates a malformed create command to the pending client message", async () => {
    const stub = agentStub();
    await initializeWorkstream(stub, "first message");
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005b9",
    );
    const receipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "create_message",
      operationId: "00000000-0000-7000-8000-0000000005ba",
      payload: { clientMessageId: "pipeline-room-socket-invalid-1" },
    }));

    expect(await receipt).toMatchObject({
      type: "client_command_failed",
      command: "create_message",
      clientMessageId: "pipeline-room-socket-invalid-1",
      error: { code: "invalid_event" },
    });
    socket.close(1000, "done");
  });

  it("keeps a malformed mutation correlated when its optional client id is oversized", async () => {
    const stub = agentStub();
    await initializeWorkstream(stub, "first message");
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005d3",
    );
    const receipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "answer_elicitation",
      operationId: "00000000-0000-7000-8000-0000000005d4",
      payload: { clientMessageId: "x".repeat(121) },
    }));

    expect(await receipt).toMatchObject({
      type: "client_command_failed",
      command: "answer_elicitation",
      operationId: "00000000-0000-7000-8000-0000000005d4",
      error: { code: "invalid_event" },
    });
    socket.close(1000, "done");
  });

  it("rejects an oversized message without closing its substream socket", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005c4",
    );
    const rejected = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "create_message",
      operationId: "00000000-0000-7000-8000-0000000005c5",
      payload: {
        text: "x".repeat(MESSAGE_MAX_CHARACTERS + 1),
        clientMessageId: "pipeline-room-socket-too-long-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    }));
    expect(await rejected).toMatchObject({
      type: "client_command_failed",
      command: "create_message",
      operationId: "00000000-0000-7000-8000-0000000005c5",
      clientMessageId: "pipeline-room-socket-too-long-1",
      error: {
        code: "message_too_long",
        message: MESSAGE_TOO_LONG_MESSAGE,
      },
    });

    const accepted = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "create_message",
      operationId: "00000000-0000-7000-8000-0000000005c6",
      payload: {
        text: "the socket stayed open",
        clientMessageId: "pipeline-room-socket-after-too-long-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    }));
    expect(await accepted).toMatchObject({
      type: "client_command_succeeded",
      command: "create_message",
      operationId: "00000000-0000-7000-8000-0000000005c6",
      clientMessageId: "pipeline-room-socket-after-too-long-1",
    });
    socket.close(1000, "done");
  });

  it("answers an elicitation through its substream socket and safely replays the command", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    const elicitationId = "00000000-0000-7000-8000-0000000005bd";
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO elicitation_requests
           (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
            minimum_selections, maximum_selections, target_user_id, status,
            answer_json, answered_by_user_id, external_actor_json, created_at, answered_at)
         VALUES (?, ?, ?, 'Choose', 'text', '[]', 0, NULL, ?, 'pending',
                 NULL, NULL, NULL, ?, NULL)`,
        elicitationId,
        opened.body.harnessRunId as string,
        `${opened.body.harnessRunId as string}:turn:1:tool:0`,
        USER_ID,
        Date.now(),
      );
    });
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005be",
    );
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as {
        product: { authorize: () => Promise<never> };
        requestPersistentLoopActivation: () => Promise<never>;
        publishLocalProductEvent: () => Promise<never>;
      };
      target.product.authorize = async () => {
        throw new Error("socket_elicitation_reauthorized_workspace_membership");
      };
      target.requestPersistentLoopActivation = async () => {
        throw new Error("injected_elicitation_activation_failure");
      };
      target.publishLocalProductEvent = async () => {
        throw new Error("injected_elicitation_publication_failure");
      };
    });
    const command = {
      type: "answer_elicitation",
      operationId: "00000000-0000-7000-8000-0000000005bf",
      elicitationId,
      payload: { answer: "yes" },
    };
    const firstReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify(command));
    expect(await firstReceipt).toMatchObject({
      type: "client_command_succeeded",
      command: "answer_elicitation",
      operationId: command.operationId,
      elicitation: { id: elicitationId, status: "answered", answer: "yes" },
    });
    const sequenceAfterFirst = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ event_sequence: number }>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ).one().event_sequence);
    const replayReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify(command));
    expect(await replayReceipt).toMatchObject({
      type: "client_command_succeeded",
      command: "answer_elicitation",
      operationId: command.operationId,
      elicitation: { id: elicitationId, status: "answered" },
    });
    expect(await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ event_sequence: number }>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ).one().event_sequence)).toBe(sequenceAfterFirst);
    const conflictReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      ...command,
      operationId: "00000000-0000-7000-8000-0000000005d5",
      payload: { answer: "no" },
    }));
    expect(await conflictReceipt).toMatchObject({
      type: "client_command_failed",
      command: "answer_elicitation",
      error: { code: "elicitation_response_idempotency_conflict" },
    });
    const customConflictReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      ...command,
      operationId: "00000000-0000-7000-8000-0000000005d6",
      payload: { answer: "yes", customResponse: "changed metadata" },
    }));
    expect(await customConflictReceipt).toMatchObject({
      type: "client_command_failed",
      command: "answer_elicitation",
      error: { code: "elicitation_response_idempotency_conflict" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT status, answer_json FROM elicitation_requests WHERE elicitation_id = ?`,
        elicitationId,
      ).one()).toEqual({ status: "answered", answer_json: JSON.stringify("yes") });
    });
    socket.close(1000, "done");
  });

  it("acknowledges a durable retry when its eager wake-up fails", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    await waitForLoopRelease(stub);
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005db",
    );
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as {
        product: { authorize: () => Promise<never> };
        requestPersistentLoopActivation: () => Promise<never>;
      };
      target.product.authorize = async () => {
        throw new Error("socket_retry_reauthorized_workspace_membership");
      };
      target.requestPersistentLoopActivation = async () => {
        throw new Error("injected_retry_activation_failure");
      };
    });
    const operationId = "00000000-0000-7000-8000-0000000005dc";
    const receipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({ type: "retry_harness", operationId }));

    expect(await receipt).toMatchObject({
      type: "client_command_succeeded",
      command: "retry_harness",
      operationId,
      harnessRunId: operationId,
    });
    // The retry is a durable row the moment the command is acknowledged. Its
    // eager wake-up threw, so only the object's alarm can move it on — and
    // under a contended shard that alarm may already have fired by the time
    // this reads (and, with `authorize` stubbed to throw, failed the run), so
    // the status is not asserted at an instant. What the command promised is
    // the row: a run with the retry's origin, recorded whether or not the
    // wake-up that was supposed to follow it did.
    const recorded = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ status: string; origin: string }>(
        `SELECT status, origin FROM runs WHERE run_id = ?`,
        operationId,
      ).one());
    expect(recorded.origin).toBe("manual_retry");
    // `authorize` is stubbed to throw, so a run the alarm reached fails; it
    // cannot complete. Anything outside this set is a regression, not timing.
    expect(["admitted", "running", "failed"]).toContain(recorded.status);
    socket.close(1000, "done");
  });

  it("retries the latest run when two runs share a created_at", async () => {
    // `created_at` is milliseconds and two runs can be admitted inside one, so
    // "the latest run" is only well defined once the ordering carries a
    // tie-break. This read happens twice — once to choose the run, once inside
    // the commit to prove it is still the latest — and only the second carried
    // one, so on a tie the two could resolve to different rows and the
    // transaction refused a retry the person was looking straight at. Both
    // rows here are retryable, so nothing but that disagreement can refuse it.
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    await waitForLoopRelease(stub);

    await runInDurableObject(stub, async (instance, state) => {
      const productService =
        (instance as unknown as { product: WorkstreamObjectProductService }).product;
      const template = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT execution_principal_json, execution_context_json FROM runs
          WHERE execution_context_json IS NOT NULL LIMIT 1`,
      ).one();
      // Newer than the settled opening run, and identical to each other: the
      // tie has to be at the top of the ordering to be the tie that decides.
      const tied = Number(state.storage.sql.exec<{ newest: number }>(
        `SELECT MAX(created_at) AS newest FROM runs`,
      ).one().newest) + 1_000;
      const lower = "00000000-0000-7000-8000-00000000aa01";
      const higher = "00000000-0000-7000-8000-00000000aa02";
      for (const runId of [lower, higher]) {
        state.storage.sql.exec(
          `INSERT INTO runs (
             run_id, substream_id, status, budget, attempt_epoch, model_iteration,
             next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
             idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
             input_tokens, output_tokens, cost_micros, output_bytes, origin,
             execution_principal_json, execution_context_json, chain_depth, created_at, updated_at
           ) VALUES (?, '0', 'failed', '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                     'member_message', ?, ?, 0, ?, ?)`,
          runId,
          tied,
          String(template.execution_principal_json),
          String(template.execution_context_json),
          tied,
          tied,
        );
      }
      // The premise, asserted rather than assumed: the two orderings really do
      // resolve this tie differently, so the case is not quietly proving
      // nothing. Asserted as a disagreement rather than as a specific winner,
      // because which row an unspecified tie resolves to is SQLite's to choose:
      // `runs_recency_idx` is `(created_at DESC, run_id DESC)` and satisfies the
      // un-tie-broken clause on its own, so a planner that starts using it would
      // make the naive read agree — and a premise pinned to today's winner would
      // then fail as if `retryWithAuthority` had regressed. If this assertion
      // ever fires, the scenario stopped reproducing the bug; the behavior
      // asserted below did not change.
      const naive = state.storage.sql.exec<{ run_id: string }>(
        `SELECT run_id FROM runs WHERE substream_id = '0' AND parent_tool_call_id IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      ).one().run_id;
      const tieBroken = state.storage.sql.exec<{ run_id: string }>(
        `SELECT run_id FROM runs WHERE substream_id = '0' AND parent_tool_call_id IS NULL
          ORDER BY created_at DESC, run_id DESC LIMIT 1`,
      ).one().run_id;
      expect(tieBroken).toBe(higher);
      expect(naive).not.toBe(tieBroken);

      const retryRunId = asHarnessRunId("00000000-0000-7000-8000-0000000000f3");
      await expect(productService.retry(AUTH, retryRunId)).resolves.toMatchObject({
        harnessRunId: retryRunId,
        activationRequest: { cause: "manual_retry" },
      });
    });
  });

  it("names the field when a stored execution context fails its own contract", async () => {
    // The other half of the retry outage: whatever a command throws that is not
    // an `ApiError` reaches the person as one flat `substream_command_failed`,
    // so this log entry is the only account of what happened. A `ZodError`'s
    // `message` is multi-line JSON, and logging it as `reason` produced a blob
    // that grouped with nothing and hid the failing field inside itself — the
    // real retry failure read for its whole life as an unexplained 500. A
    // stored context that stops parsing is not hypothetical either: schema v37
    // exists because a contract change did exactly this to every receipt
    // written before it.
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    await waitForLoopRelease(stub);
    await runInDurableObject(stub, (_instance, state) => {
      // A receipt that is valid JSON and a valid object — the column's own
      // CHECK holds — and no longer a valid workflow input.
      state.storage.sql.exec(
        `UPDATE runs SET execution_context_json = json_remove(execution_context_json, '$.reason')
          WHERE execution_context_json IS NOT NULL`,
      );
    });
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005f3",
    );
    // Collected inside the object, and only after lowering its level. `logWarn`
    // writes to the `console` of the isolate the command runs in rather than
    // the runner's, and this Worker's test config sets `LOG_LEVEL` to `error`,
    // which drops every warning before it is written — a spy taken outside, or
    // taken here without the level, records nothing and lets every assertion
    // below pass vacuously.
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as { env: Env };
      target.env = new Proxy(target.env, {
        get: (current, property, receiver) => (
          property === "LOG_LEVEL" ? "warn" : Reflect.get(current, property, receiver)
        ),
      });
      const scope = globalThis as WarnCaptureScope;
      scope.__rallyWarnLog = [];
      scope.__rallyWarnOriginal = console.warn;
      console.warn = (entry: unknown) => { scope.__rallyWarnLog!.push(entry); };
    });
    try {
      const operationId = "00000000-0000-7000-8000-0000000005f4";
      const receipt = nextSocketCommandOutcome(socket);
      socket.send(JSON.stringify({ type: "retry_harness", operationId }));
      expect(await receipt).toMatchObject({
        type: "client_command_failed",
        command: "retry_harness",
        error: { status: 500, code: "substream_command_failed" },
      });
      const entry = (await runInDurableObject(stub, () => structuredClone(
        (globalThis as WarnCaptureScope).__rallyWarnLog ?? [],
      )) as Record<string, unknown>[])
        .find((call) => call.event === "substream_socket_command_failed");
      expect(entry).toMatchObject({
        command: "retry_harness",
        operation_id: operationId,
        // A code that groups, rather than one run's JSON blob.
        reason: "schema_validation_failed",
        validation_issues: [{ path: "reason", code: "invalid_type" }],
      });
      // Which `parse` threw. The message names the field; only the frames name
      // the call site, and a command path runs several. Under `stack`, the key
      // this file's other `harnessErrorFrames` sites already use.
      expect(entry?.stack).toEqual(expect.any(String));
      // The paths and codes are schema shape. The stored context's own values
      // are not, and the entry must not carry them. Asserted against the loop
      // id because the context genuinely holds it: the opening message text
      // would pass this even through a real leak, since neither a `ZodError`'s
      // issue list nor the receipt ever carries message content.
      expect(JSON.stringify(entry)).not.toContain(substreamLoopId(WORKSTREAM_ID));
    } finally {
      // The object's `env` proxy dies with the instance, but `console` and the
      // collector are the isolate's, which every later test in this file shares:
      // left patched, they divert those tests' warnings into a stale array
      // instead of emitting them. Restored through the object because that is
      // the isolate the patch was applied in.
      await runInDurableObject(stub, () => {
        const scope = globalThis as WarnCaptureScope;
        if (scope.__rallyWarnOriginal) console.warn = scope.__rallyWarnOriginal;
        delete scope.__rallyWarnOriginal;
        delete scope.__rallyWarnLog;
      });
      socket.close(1000, "done");
    }
  });

  describe("shared appearance projection", () => {
    useHeldEffectQueue();
    it("persists shared appearance patches and does not replay an old choice", async () => {
      const stub = agentStub();
      const opened = await initializeWorkstream(stub, "first message");
      await settledRun(stub, opened.body.harnessRunId as string);
      const { socket } = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000006c0");
      const choose = async (operationId: string, appearance: Record<string, string>) => {
        const receipt = nextSocketCommandOutcome(socket);
        socket.send(JSON.stringify({ type: "set_workstream_appearance", operationId, appearance }));
        expect(await receipt).toMatchObject({ type: "client_command_succeeded", command: "set_workstream_appearance", operationId });
      };
      await choose("00000000-0000-7000-8000-0000000006c1", { color: "blue" });
      await choose("00000000-0000-7000-8000-0000000006c2", { icon: "rocket" });
      await choose("00000000-0000-7000-8000-0000000006c3", { color: "purple" });
      await choose("00000000-0000-7000-8000-0000000006c1", { color: "blue" });
      await deliverEffectsToWorkspaceInOrder(env, stub);
      const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
      const page = await workspace.listWorkstreams({ workspaceId: WORKSPACE_ID, userId: USER_ID, limit: 20, includeSystem: false });
      expect(page.items.find((item) => item.id === WORKSTREAM_ID)?.appearance).toEqual({ icon: "rocket", color: "purple" });
      const service = new WorkstreamService({ ...TEST_ENV, SESSION_SIGNING_KEY: "appearance-test-signing-key", PUBLIC_API_BASE_URL: "https://api.rally.test" }, AUTH);
      const ticket = await service.workstreamControlSocketTicket(WORKSTREAM_ID);
      expect(new URL(ticket.url).search).toBe("");
      socket.close(1000, "done");
      await evictDurableObject(stub);
      const reopened = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000006c4");
      expect(reopened.initial).toMatchObject({ workstream: { appearance: { icon: "rocket", color: "purple" } } });
      reopened.socket.close(1000, "done");
    });
  });

  it("does not replay an old reorder command over newer queue state", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005c0",
    );
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as { product: { authorize: () => Promise<never> } };
      target.product.authorize = async () => {
        throw new Error("socket_reorder_reauthorized_workspace_membership");
      };
    });
    await runInDurableObject(stub, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
    });
    const enqueue = async (operationId: string, clientMessageId: string) => {
      const receipt = nextSocketCommandOutcome(socket);
      socket.send(JSON.stringify({
        type: "create_message",
        operationId,
        payload: {
          text: clientMessageId,
          clientMessageId,
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
          runMode: "queue",
        },
      }));
      return await receipt;
    };
    const first = await enqueue(
      "00000000-0000-7000-8000-0000000005c1",
      "socket-reorder-first",
    );
    const second = await enqueue(
      "00000000-0000-7000-8000-0000000005c2",
      "socket-reorder-second",
    );
    expect(first.deliveryState).toBe("pending");
    expect(second.deliveryState).toBe("pending");
    const firstTurn = first.turn as { turnId: string };
    const secondTurn = second.turn as { turnId: string };
    const firstOperationId = "00000000-0000-7000-8000-0000000005c3";
    const firstReceipt = nextSocketCommandOutcome(socket);
    const firstCommand = {
      type: "reorder_pending_inputs",
      operationId: firstOperationId,
      inputIds: [secondTurn.turnId, firstTurn.turnId],
    };
    socket.send(JSON.stringify(firstCommand));
    expect(await firstReceipt).toMatchObject({
      type: "client_command_succeeded",
      command: "reorder_pending_inputs",
      operationId: firstOperationId,
      pendingInputs: [
        { clientMessageId: "socket-reorder-second" },
        { clientMessageId: "socket-reorder-first" },
      ],
    });

    const secondOperationId = "00000000-0000-7000-8000-0000000005c7";
    const secondReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "reorder_pending_inputs",
      operationId: secondOperationId,
      inputIds: [firstTurn.turnId, secondTurn.turnId],
    }));
    expect(await secondReceipt).toMatchObject({
      type: "client_command_succeeded",
      pendingInputs: [
        { clientMessageId: "socket-reorder-first" },
        { clientMessageId: "socket-reorder-second" },
      ],
    });

    const replayReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify(firstCommand));
    expect(await replayReceipt).toMatchObject({
      type: "client_command_succeeded",
      operationId: firstOperationId,
      pendingInputs: [
        { clientMessageId: "socket-reorder-first" },
        { clientMessageId: "socket-reorder-second" },
      ],
    });
    expect(await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_inbox_receipts
          WHERE channel = 'substream_socket_command'`,
      ).one().count)).toBe(2);
    socket.close(1000, "done");
  });

  it("does not replay an old stop command against a newer execution", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    await runInDurableObject(stub, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
    });
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005c8",
    );
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as { product: { authorize: () => Promise<never> } };
      target.product.authorize = async () => {
        throw new Error("socket_stop_reauthorized_workspace_membership");
      };
    });
    const command = {
      type: "stop_harness",
      operationId: "00000000-0000-7000-8000-0000000005c9",
    };
    const firstReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify(command));
    expect(await firstReceipt).toMatchObject({
      type: "client_command_succeeded",
      operationId: command.operationId,
    });
    await runInDurableObject(stub, (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `UPDATE substream_loops
            SET status = 'executing', active_execution_id = 'newer-execution',
                active_execution_epoch = 2, lease_owner = 'newer-owner',
                lease_expires_at = ?, stop_requested_at = NULL,
                stop_after_step_ordinal = NULL, stop_reason = NULL,
                revision = revision + 1, updated_at = MAX(updated_at, ?)
          WHERE id = 1`,
        now + 60_000,
        now,
      );
    });

    await evictDurableObject(stub);
    const replayReceipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify(command));
    expect(await replayReceipt).toMatchObject({
      type: "client_command_succeeded",
      operationId: command.operationId,
    });
    expect(await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ active_execution_id: string; stop_requested_at: number | null }>(
        `SELECT active_execution_id, stop_requested_at FROM substream_loops WHERE id = 1`,
      ).one())).toEqual({ active_execution_id: "newer-execution", stop_requested_at: null });
    socket.close(1000, "done");
  });

  it("archives and fences the active loop in one durable transition", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    await runInDurableObject(stub, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
    });

    const archived = await product(stub, {
      operation: "update",
      auth: AUTH,
      input: { archived: true },
    });
    expect(archived.status).toBe(200);
    expect(await runInDurableObject(stub, async (instance, state) => {
      const loop = state.storage.sql.exec<{
        stop_requested_at: number | null;
        stop_reason: string | null;
      }>(
        `SELECT stop_requested_at, stop_reason FROM substream_loops WHERE id = 1`,
      ).one();
      const claim = await (instance as unknown as {
        claimPersistentLoopExecution: () => Promise<unknown>;
      }).claimPersistentLoopExecution();
      return { loop, claim };
    })).toEqual({
      loop: {
        stop_requested_at: expect.any(Number),
        stop_reason: "workstream_archived",
      },
      claim: null,
    });
  });

  it("does not claim an admitted retry while its room is archived", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    await waitForLoopRelease(stub);
    const retryRunId = asHarnessRunId("00000000-0000-7000-8000-0000000005da");
    // Retried and archived under one input gate. The retry arms the loop's
    // activation alarm for now, and between two separate requests workerd may
    // fire it: the retry then runs before the archive, and what the assertion
    // sees is that run's outcome rather than an admitted run the archive
    // fenced. Storage awaits keep the gate closed, so nothing interleaves here.
    await runInDurableObject(stub, async (instance) => {
      const productService = (instance as unknown as {
        product: WorkstreamObjectProductService;
      }).product;
      await productService.retry(AUTH, retryRunId);
      await productService.update(AUTH, { archived: true });
    });
    await runDurableObjectAlarm(stub);

    expect(await runInDurableObject(stub, async (instance, state) => ({
      claim: await (instance as unknown as {
        claimPersistentLoopExecution: () => Promise<unknown>;
      }).claimPersistentLoopExecution(),
      runStatus: state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM runs WHERE run_id = ?`,
        retryRunId,
      ).one().status,
      loopStatus: state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM substream_loops WHERE id = 1`,
      ).one().status,
    }))).toEqual({ claim: null, runStatus: "admitted", loopStatus: "idle" });
  });


  it("fences deferred classifier context before its canonical turn and later sends", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "opening context", null, [OTHER_USER_ID]);
    await settledRun(stub, opened.body.harnessRunId as string);
    await waitForLoopRelease(stub);
    await installScriptedProvider(stub, ["refuse"], {
      primaryModel: "openai/gpt-4.1-mini", fallbackModels: [],
      structuredReply: { classification: "human_only", confidence: 0.95, rationaleCode: "human_coordination" },
    });
    type RecoveryProbe = WorkstreamObjectProductService & { releaseRecovery: () => void; restoreRecovery: () => void };
    await runInDurableObject(stub, (instance) => {
      const product = (instance as unknown as { product: RecoveryProbe }).product;
      const originalEnv = Reflect.get(product, "env");
      Object.defineProperty(product, "env", { value: Reflect.get(instance, "env") });
      const original = product.resumeOldestInputPreparation;
      let release = () => undefined as void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      product.resumeOldestInputPreparation = async () => {
        await gate;
        return original.call(product);
      };
      product.releaseRecovery = release;
      product.restoreRecovery = () => {
        release();
        product.resumeOldestInputPreparation = original;
        Object.defineProperty(product, "env", { value: originalEnv });
      };
    });
    const first = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000007d1");
    const later = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000007d2");
    try {
      const firstReceipt = nextSocketCommandOutcome(first.socket);
      first.socket.send(JSON.stringify({
        type: "create_message", operationId: "00000000-0000-7000-8000-0000000007d3",
        payload: { text: "The revised launch timeline is in the shared notes", clientMessageId: "classifier-fence-first", mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] },
      }));
      expect(await firstReceipt).toMatchObject({ deliveryState: "canonical" });
      const laterReceipt = nextSocketCommandOutcome(later.socket);
      later.socket.send(JSON.stringify({
        type: "create_message", operationId: "00000000-0000-7000-8000-0000000007d4",
        payload: { text: "later canonical turn", clientMessageId: "classifier-fence-later", mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] },
      }));
      expect(await laterReceipt).toMatchObject({ deliveryState: "canonical" });
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { product: RecoveryProbe }).product.releaseRecovery();
      });
      await expect.poll(async () => (await capturedProviderRequests(stub))
        .filter((request) => request.body.stream !== true).length, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBeGreaterThan(0);
      const contexts = (await capturedProviderRequests(stub))
        .filter((request) => request.body.stream !== true)
        .map((request) => {
          const messages = request.body.messages;
          if (!Array.isArray(messages)) throw new Error("classifier_messages_missing");
          const last = messages.at(-1) as { content?: unknown } | undefined;
          if (typeof last?.content !== "string") throw new Error("classifier_context_missing");
          return JSON.parse(last.content.split("\n\n")[0]!) as {
            currentMessage: string;
            recentMessages: Array<{ message: string }>;
          };
        });
      const context = contexts.find((candidate) =>
        candidate.currentMessage === "The revised launch timeline is in the shared notes");
      expect(context).toBeDefined();
      expect(context!.recentMessages.map((message) => message.message)).toContain("opening context");
      expect(context!.recentMessages.map((message) => message.message)).not.toContain("The revised launch timeline is in the shared notes");
      expect(context!.recentMessages.map((message) => message.message)).not.toContain("later canonical turn");
    } finally {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as { product: RecoveryProbe }).product.restoreRecovery();
      });
      await restoreProviderFetch(stub);
      first.socket.close(1000, "done"); later.socket.close(1000, "done");
    }
  });

  it.each(["human_only", "agent_action"] as const)("delivers to subscribed readers while %s classification is held", async (classification) => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message", null, [OTHER_USER_ID]);
    await settledRun(stub, opened.body.harnessRunId as string);
    await waitForLoopRelease(stub);
    const sender = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000007a0");
    const reader = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000007a1");
    const sent = collectSocketFrames(sender.socket);
    const received = collectSocketFrames(reader.socket);
    const text = "The revised launch timeline is in the shared notes";
    const clientMessageId = "delivered-before-classification";
    const command = {
      type: "create_message", operationId: "00000000-0000-7000-8000-0000000007a2",
      payload: { text, clientMessageId, mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] },
    };
    try {
      await installScriptedProvider(stub, ["refuse"], {
        primaryModel: "openai/gpt-4.1-mini", fallbackModels: [], gateFirstCall: true,
        structuredReply: { classification, confidence: 0.95, rationaleCode: "human_coordination" },
      });
      // The product and loop share this external provider boundary. The helper
      // normally replaces only the loop's environment for streaming tests.
      await runInDurableObject(stub, (instance) => {
        Object.defineProperty(Reflect.get(instance, "product"), "env", { value: Reflect.get(instance, "env") });
      });
      sender.socket.send(JSON.stringify(command));
      await expect.poll(async () => JSON.stringify({
        calls: (await capturedProviderRequests(stub)).filter((request) => request.body.stream !== true).length,
        mailbox: await runInDurableObject(stub, (_instance, state) =>
          state.storage.sql.exec(`SELECT state, terminal_code FROM pending_loop_input_mailbox`).toArray()),
        frames: sent.frames.filter((frame) => frame.type.startsWith("client_command")),
      }), { timeout: RUN_SETTLE_TIMEOUT_MS }).toContain('"calls":1');
      await waitForSocketEvidence(sent.frames, (frame) => frame.type === "client_command_succeeded"
        && frame.clientMessageId === clientMessageId && frame.deliveryState === "canonical");
      await waitForSocketEvidence(received.frames, (frame) => frame.type === "transcript_turn_upserted"
        && JSON.stringify(frame.turn).includes(text));
      const canonical = () => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ id: string }>(
          `SELECT id FROM canonical_conversation_turn_details WHERE client_message_id = ?`, clientMessageId,
        ).toArray());
      const turns = await canonical();
      expect(turns).toHaveLength(1);
      const replay = nextSocketCommandOutcome(sender.socket);
      sender.socket.send(JSON.stringify(command));
      expect(await replay).toMatchObject({ deliveryState: "canonical", turn: { turnId: turns[0]!.id } });
      expect(await canonical()).toEqual(turns);
      await openProviderGate(stub);
      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_input_mailbox WHERE state = 'preparing'`,
        ).one().count), { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(0);
      if (classification === "agent_action") {
        await expect.poll(async () => JSON.stringify({
          calls: (await capturedProviderRequests(stub)).filter((request) => request.body.stream === true).length,
          mailbox: await runInDurableObject(stub, (_instance, state) => ({
            inputs: state.storage.sql.exec(`SELECT state, terminal_code FROM pending_loop_input_mailbox`).toArray(),
            runs: state.storage.sql.exec(`SELECT status, error_json FROM runs`).toArray(),
          })),
        }), { timeout: RUN_SETTLE_TIMEOUT_MS }).toContain('"calls":1');
        const request = (await capturedProviderRequests(stub)).find((item) => item.body.stream === true)!;
        expect((JSON.stringify(request.body.messages).match(new RegExp(text, "g")) ?? [])).toHaveLength(1);
        await waitForLoopRelease(stub);
        // Activation consumed this delivered turn. Its pending row remains in
        // the transaction until the activation completes, so the model
        // waterline must explicitly exclude that row rather than checkpointing
        // just before a turn the model already received.
        const waterline = await runInDurableObject(stub, (_instance, state) =>
          state.storage.sql.exec<{ transcript_projected_through: number; transcript_sequence: number }>(
            `SELECT loop.transcript_projected_through, turn.transcript_sequence
               FROM substream_loops loop
               JOIN participant_transcript_turns turn ON turn.turn_id = ?
              WHERE loop.id = 1`,
            turns[0]!.id,
          ).one());
        expect(waterline.transcript_projected_through).toBe(waterline.transcript_sequence);
      }
      expect(await canonical()).toEqual(turns);
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
      sent.stop(); received.stop();
      sender.socket.close(1000, "done"); reader.socket.close(1000, "done");
    }
  });

  it("falls back to deterministic pending preparation when a run starts during canonical preparation", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    await runInDurableObject(stub, (instance, state) => {
      const transcript = Reflect.get(instance, "transcript") as {
        prepareParticipantMessage: (input: { clientMessageId: string }) => Promise<unknown>;
      };
      const original = transcript.prepareParticipantMessage.bind(transcript);
      transcript.prepareParticipantMessage = async (input) => {
        const prepared = await original(input);
        if (input.clientMessageId === "late-handoff-deterministic") {
          holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
        }
        return prepared;
      };
    });
    const { socket } = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000007c1");
    const receipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "create_message", operationId: "00000000-0000-7000-8000-0000000007c2",
      payload: {
        text: "deterministic invocation after handoff", clientMessageId: "late-handoff-deterministic",
        mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
      },
    }));
    expect(await receipt).toMatchObject({ deliveryState: "pending" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(new SubstreamLoopStorage(state.storage).inputByClientMessageId("late-handoff-deterministic"))
        .toBeDefined();
    });
    socket.close(1000, "done");
  });

  it("keeps an ordinary socket send and queued follow-up visible during an active run", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    await runInDurableObject(stub, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
    });
    const { socket } = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000007b1");
    const receipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "create_message",
      operationId: "00000000-0000-7000-8000-0000000007b2",
      payload: {
        text: "ordinary during the active run",
        clientMessageId: "active-run-ordinary",
        mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
      },
    }));
    expect(await receipt).toMatchObject({ deliveryState: "pending" });
    const queued = await product(stub, {
      operation: "create_message", auth: AUTH,
      input: {
        text: "queued after ordinary", clientMessageId: "active-run-queued",
        mentions: [], confirmedParticipantUserIds: [], attachmentIds: [], runMode: "queue",
      },
    });
    expect(queued.body).toMatchObject({ deliveryState: "pending" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(new SubstreamLoopStorage(state.storage).pendingInputs()
        .map((input) => input.client_message_id)).toEqual([
          "active-run-ordinary", "active-run-queued",
        ]);
    });
    socket.close(1000, "done");
  });

  it("acknowledges durable admission when the eager loop wake-up fails", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    const { socket } = await openSubscribedSocket(
      stub,
      "00000000-0000-7000-8000-0000000005bb",
    );
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as {
        requestPersistentLoopActivation: () => Promise<never>;
      };
      target.requestPersistentLoopActivation = async () => {
        throw new Error("injected_activation_wakeup_failure");
      };
    });
    const receipt = nextSocketCommandOutcome(socket);
    socket.send(JSON.stringify({
      type: "create_message",
      operationId: "00000000-0000-7000-8000-0000000005bc",
      payload: {
        text: "the durable row is the authority",
        clientMessageId: "pipeline-room-socket-wakeup-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
        runMode: "queue",
      },
    }));

    expect(await receipt).toMatchObject({
      type: "client_command_succeeded",
      command: "create_message",
      clientMessageId: "pipeline-room-socket-wakeup-1",
      deliveryState: "pending",
    });
    // The injected eager wake-up failed after pending admission, so the durable
    // input remains the activation authority rather than being lost.
    expect(await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM pending_loop_inputs
          WHERE client_message_id = 'pipeline-room-socket-wakeup-1'`,
      ).one().count)).toBe(1);
    socket.close(1000, "done");
  });

  it("a revoked session cannot write into the work stream", async () => {
    const stub = agentStub();
    await initializeWorkstream(stub, "first message");
    await env.DB.prepare(
      `UPDATE sessions SET revoked_at = '2026-08-18T00:00:00.000Z' WHERE id = ?`,
    ).bind(SESSION_ID).run();

    const attempt = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "should not land",
        clientMessageId: "pipeline-revoked-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });

    expect(attempt.status).toBe(401);
    await runInDurableObject(stub, (_instance, state) => {
      const copies = state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM participant_transcript_turns
          WHERE client_message_id = 'pipeline-revoked-1'`,
      ).toArray()[0]!;
      expect(copies.n).toBe(0);
    });
  });

  it("fails an observable streamed response without retry and replaces its partial overlay with the reserved error turn", async () => {
    const stub = agentStub();
    let socket: WebSocket | null = null;
    let stopCollecting: (() => void) | null = null;

    // Installed inside the `try` so the restore is unconditional: a throw in the
    // install would otherwise leave `fetch` patched for the rest of the file.
    try {
      await installScriptedProvider(stub, [[
        { choices: [{ delta: { content: "observable partial" }, finish_reason: null }] },
        { error: { message: "provider stream broke" } },
      ]], {
        // The fallback is deliberate: the oracle proves that participant-visible
        // output closes the entire route, rather than succeeding because there
        // was no later model available.
        primaryModel: STREAM_FAILURE_PRIMARY_MODEL,
        fallbackModels: [STREAM_FAILURE_FALLBACK_MODEL],
      });
      const opened = await initializeWorkstream(stub, "show me a streamed answer");
      expect(opened.status).toBe(200);
      ({ socket } = await openSubscribedSocket(
        stub,
        "00000000-0000-7000-8000-0000000005c1",
      ));
      const live = collectSocketFrames(socket);
      stopCollecting = live.stop;

      const run = await settledRun(stub, opened.body.harnessRunId as string);
      expect(run.status).toBe("failed");
      await waitForSocketEvidence(live.frames, (frame) => frame.type === "stream_completed");
      await waitForLoopRelease(stub);

      const partialIndex = live.frames.findIndex((frame) =>
        frame.type === "stream_delta" && frame.delta === "observable partial");
      const partial = live.frames[partialIndex];
      expect(partialIndex).toBeGreaterThanOrEqual(0);
      const reservedTurnId = String(partial?.turnId);
      const errorIndex = live.frames.findIndex((frame) => {
        if (frame.type !== "transcript_turn_upserted") return false;
        const turn = frame.turn as Record<string, unknown>;
        return turn.turnId === reservedTurnId
          && (turn.blocks as Array<Record<string, unknown>>).some((block) =>
            block.type === "text"
            && block.text === "Response could not be completed"
            && (block.structuredContent as Record<string, unknown> | undefined)?.kind
              === "assistant_turn_failed");
      });
      const completionIndex = live.frames.findIndex((frame) =>
        frame.type === "stream_completed" && frame.streamId === opened.body.harnessRunId);
      expect(errorIndex).toBeGreaterThan(partialIndex);
      expect(completionIndex).toBeGreaterThan(errorIndex);

      const streamedRequests = (await capturedProviderRequests(stub))
        .filter((request) => request.body.stream === true);
      expect(streamedRequests.map((request) => request.body.model))
        .toEqual([STREAM_FAILURE_PRIMARY_MODEL]);

      const reloaded = await product(stub, { operation: "boot", auth: AUTH });
      expect(reloaded.status).toBe(200);
      const turns = snapshotTurns(reloaded.body);
      const reserved = turns.find((turn) => turn.turnId === reservedTurnId);
      expect(reserved).toMatchObject({
        entryKind: "status",
        actor: "system",
        blocks: [{
          type: "text",
          text: "Response could not be completed",
          structuredContent: {
            kind: "assistant_turn_failed",
          },
        }],
      });
      expect(JSON.stringify(turns)).not.toContain("observable partial");
    } finally {
      stopCollecting?.();
      socket?.close(1000, "test complete");
      await restoreProviderFetch(stub);
    }
  });

  it("keeps interleaved assistant text and tools in exact order live, after reconnect, and after cold reload", async () => {
    const stub = agentStub();
    const toolCall = (id: string) => ({
      index: 0,
      id,
      type: "function",
      function: { name: "core_current_time", arguments: "{}" },
    });
    const expectedOrder = ["text:text A", "tool", "text:text B", "tool", "text:final C"];
    let liveSocket: WebSocket | null = null;
    let reconnectSocket: WebSocket | null = null;
    let stopCollecting: (() => void) | null = null;

    // Installed inside the `try` so the restore is unconditional: a throw in the
    // install would otherwise leave `fetch` patched for the rest of the file.
    try {
      await installScriptedProvider(stub, [
        [
          { choices: [{ delta: { content: "text A" }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [toolCall("provider-tool-1")] }, finish_reason: "tool_calls" }] },
        ],
        [
          { choices: [{ delta: { content: "text B" }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [toolCall("provider-tool-2")] }, finish_reason: "tool_calls" }] },
        ],
        [{ choices: [{ delta: { content: "final C" }, finish_reason: "stop" }] }],
      ], {
        primaryModel: INTERLEAVED_TOOLS_MODEL,
        fallbackModels: [],
      });
      const opened = await initializeWorkstream(stub, "perform two deterministic tool steps");
      expect(opened.status).toBe(200);
      ({ socket: liveSocket } = await openSubscribedSocket(
        stub,
        "00000000-0000-7000-8000-0000000005c2",
      ));
      const live = collectSocketFrames(liveSocket);
      stopCollecting = live.stop;

      const run = await settledRun(stub, opened.body.harnessRunId as string);
      expect(run.status).toBe("completed");
      await waitForSocketEvidence(live.frames, (frame) =>
        visibleAssistantBlockOrder(latestLiveTurns(live.frames)).join("|")
          === expectedOrder.join("|")
        && frame.type === "stream_completed");
      await waitForLoopRelease(stub);
      expect(visibleAssistantBlockOrder(latestLiveTurns(live.frames))).toEqual(expectedOrder);

      stopCollecting();
      stopCollecting = null;
      liveSocket.close(1000, "reconnect");
      liveSocket = null;

      const reconnect = await openSubscribedSocket(
        stub,
        "00000000-0000-7000-8000-0000000005c3",
      );
      reconnectSocket = reconnect.socket;
      expect(visibleAssistantBlockOrder(snapshotTurns(reconnect.initial))).toEqual(expectedOrder);

      const streamedRequests = (await capturedProviderRequests(stub))
        .filter((request) => request.body.stream === true);
      expect(streamedRequests.map((request) => request.body.model)).toEqual([
        INTERLEAVED_TOOLS_MODEL,
        INTERLEAVED_TOOLS_MODEL,
        INTERLEAVED_TOOLS_MODEL,
      ]);

      reconnectSocket.close(1000, "cold reload");
      reconnectSocket = null;
      await evictDurableObject(stub);
      // A product boot after eviction is the cold-load source the desktop uses
      // when neither an object cache nor a socket replay cursor survives.
      const reloaded = await product(agentStub(), { operation: "boot", auth: AUTH });
      expect(reloaded.status).toBe(200);
      expect(visibleAssistantBlockOrder(snapshotTurns(reloaded.body))).toEqual(expectedOrder);
    } finally {
      stopCollecting?.();
      liveSocket?.close(1000, "test complete");
      reconnectSocket?.close(1000, "test complete");
      await restoreProviderFetch(stub);
    }
  });

  it("the failed run leaves the transcript readable and ordered", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "the opening message");
    await settledRun(stub, opened.body.harnessRunId as string);

    await runInDurableObject(stub, async (_instance, state) => {
      const counters = state.storage.sql.exec<{
        next_sequence_number: number;
        next_attention_ordinal: number;
      }>(
        `SELECT next_sequence_number, next_attention_ordinal FROM workstream WHERE id = 1`,
      ).one();
      const now = Date.now();
      await seedCanonicalMessageRecord(state, {
        id: "00000000-0000-7000-8000-0000000005b1",
        sequence: counters.next_sequence_number,
        messageType: "tool",
        structuredContentJson: '{"invocation":{"status":"completed"}}',
        effectIntentId: "00000000-0000-7000-8000-0000000005b3",
        toolName: "attachment_read",
        toolStatus: "completed",
        now,
      });
      await seedParticipantMessage(state, {
        id: "00000000-0000-7000-8000-0000000005b2",
        sequence: counters.next_sequence_number + 1,
        text: "answer after tool",
        authorType: "agent",
        attentionOrdinal: counters.next_attention_ordinal,
        now,
      });
      state.storage.sql.exec(
        `UPDATE workstream
            SET next_sequence_number = ?, next_attention_ordinal = ?, updated_at = ?
          WHERE id = 1`,
        counters.next_sequence_number + 2,
        counters.next_attention_ordinal + 1,
        Date.now(),
      );
    });

    const items = await runInDurableObject(stub, (_instance, state) => (
      new WorkstreamTranscriptStorage(state.storage)
        .createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null })
        .ranges.flatMap((range) => range.turns)
    ));
    expect(items.length).toBeGreaterThan(0);
    const sequences = items.map((item) => item.transcriptSequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(items.some((item) => item.attentionOrdinal === 1)).toBe(true);
    expect(items.filter((item) => [
      "00000000-0000-7000-8000-0000000005b1",
      "00000000-0000-7000-8000-0000000005b2",
    ].includes(item.turnId)).map((item) => item.attentionOrdinal ?? null))
      .toEqual([null, 2]);
  });
});

describe("deferred message preparation failures", () => {
  it.each(["inner preparation", "before preparation guard"] as const)(
    "terminalizes and notifies once when access changes %s",
    async (failurePoint) => {
      const stub = agentStub();
      const opened = await initializeWorkstream(stub, "opening before recovery failure");
      await settledRun(stub, opened.body.harnessRunId as string);
      const { socket } = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000007d1");
      type RecoveryProbe = WorkstreamObjectProductService & {
        releaseRecovery: () => void;
        restoreRecovery: () => void;
        opsNotices: string[];
      };
      await runInDurableObject(stub, (instance) => {
        const product = (instance as unknown as { product: RecoveryProbe }).product;
        const originalResume = product.resumeOldestInputPreparation;
        const originalFetch = globalThis.fetch;
        const environment = product as unknown as { env: Env };
        const originalEnv = environment.env;
        let release = () => undefined as void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        // Hold only scheduling: all admission, authorization, mailbox writes,
        // failure handling, and the eventual alarm remain the production path.
        product.resumeOldestInputPreparation = async () => {
          await gate;
          return originalResume.call(product);
        };
        product.opsNotices = [];
        environment.env = {
          ...originalEnv,
          APP_ENV: "staging",
          OPS_SLACK_BOT_TOKEN: "xoxb-ops-test",
          OPS_SLACK_CHANNEL_ID: "recovery-test-ops",
        };
        globalThis.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url !== "https://slack.com/api/chat.postMessage") return originalFetch(input, init);
          product.opsNotices.push(String(init?.body));
          return Response.json({ ok: true });
        };
        product.releaseRecovery = release;
        product.restoreRecovery = () => {
          release();
          product.resumeOldestInputPreparation = originalResume;
          environment.env = originalEnv;
          globalThis.fetch = originalFetch;
        };
      });

      try {
        const receipt = nextSocketCommandOutcome(socket);
        socket.send(JSON.stringify({
          type: "create_message",
          operationId: "00000000-0000-7000-8000-0000000007d2",
          payload: {
            text: "human text must not leave in an ops notice",
            clientMessageId: "canonical-before-preparation-failure",
            mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
          },
        }));
        expect(await receipt).toMatchObject({ deliveryState: "canonical" });
        if (failurePoint === "inner preparation") {
          // Membership authorization still succeeds, but profile hydration
          // fails inside runInputPreparation's guarded work.
          await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(USER_ID).run();
        } else {
          // Local authorization fails before runInputPreparation is entered.
          await runInDurableObject(stub, (_instance, state) => {
            state.storage.sql.exec(
              "UPDATE participants SET status = 'removed', removed_at = ?, updated_at = ? WHERE user_id = ?",
              Date.now(), Date.now(), USER_ID,
            );
          });
        }
        await runInDurableObject(stub, (instance) => {
          (instance as unknown as { product: RecoveryProbe }).product.releaseRecovery();
        });
        await runDurableObjectAlarm(stub);
        await expect.poll(() => runInDurableObject(stub, (instance, state) => ({
          mailbox: state.storage.sql.exec<{ state: string; terminal_code: string }>(
            "SELECT state, terminal_code FROM pending_loop_input_mailbox WHERE client_message_id = ?",
            "canonical-before-preparation-failure",
          ).one(),
          noticeCount: (instance as unknown as { product: RecoveryProbe }).product.opsNotices.length,
        })), { timeout: RUN_SETTLE_TIMEOUT_MS }).toEqual({
          mailbox: {
            state: "failed",
            terminal_code: failurePoint === "inner preparation" ? "invalid_workspace_member" : "workstream_not_found",
          },
          noticeCount: 1,
        });
        await runInDurableObject(stub, async (instance, state) => {
          const product = (instance as unknown as { product: RecoveryProbe }).product;
          expect(await product.resumeOldestInputPreparation()).toBe("none");
          expect(await product.resumeOldestInputPreparation()).toBe("none");
          expect(product.opsNotices).toHaveLength(1);
          const notice = JSON.parse(product.opsNotices[0]!) as { text: string };
          expect(notice.text).toContain("delivered_message_agent_preparation_failed");
          expect(notice.text).not.toContain("human text must not leave");
          expect(state.storage.sql.exec(
            "SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE client_message_id = ?",
            "canonical-before-preparation-failure",
          ).one()).toEqual({ count: 1 });
        });
      } finally {
        await runInDurableObject(stub, (instance) => {
          (instance as unknown as { product: RecoveryProbe }).product.restoreRecovery();
        });
        socket.close(1000, "done");
      }
    },
  );
});
