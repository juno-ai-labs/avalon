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
import { SignJWT } from "jose";
import { socketTicketProtocols } from "@rally/contracts/socket-tickets";
import { createApp } from "../src/app";
import { ArtifactOpenService } from "../src/services/artifact-open-service";
import { __integrationTesting, runWorkstreamHarness } from "../src/services/integrations";
import { encryptString } from "../src/lib/crypto";
import { readWorkspaceRelationship } from "../src/services/workspace-relationship-service";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { consumeAccessRevocationQueue } from "../src/queues/access-revocation-consumer";
import {
  evictDurableObject,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { consumeEffectBodies, deliverChildEffects, deliverEffectsToWorkspaceInOrder } from "./helpers/conversation-effects";

import {
  AutomationDraftSchema,
  asAutomationId,
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  ParentEffectEnvelopeSchema,
  WorkstreamWorkflowInputSchema,
  asArtifactId,
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import {
  capturedProviderRequests,
  capturedCompletionRequests,
  installProviderCapture,
  installScriptedProvider,
  openProviderGate,
  restoreProviderFetch,
} from "./helpers/scripted-provider";
import { createCloudflareTestBinding } from "../test/helpers/cloudflare-test";
import {
  artifactHostDOName,
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
import { WorkstreamIdentityStorage } from "../src/durable-objects/workstream-identity-storage";
import { ParticipantAuthorityTransferStorage } from "../src/durable-objects/participant-authority-transfer";
import { enqueueSemanticRealtimeReference } from "../src/durable-objects/workstream-semantic-realtime-outbox";
import type { ScopeGrantStorage } from "../src/durable-objects/scope-grant-storage";
import { hostedParentStub, insertChannelRow, readSharedWorkstream, withHostedParent } from "./helpers/hosted-parent";
import { resolveSidekickSkills } from "../src/services/sidekick-skills";
import { AuthorizationService } from "../src/services/authorization-service";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { createSchedulingObjectPort } from "../src/runtime/scheduling-port";
import { launchWorkstreamHarness, WorkstreamService } from "../src/services/workstream-service";
import { BOUND_PARAMETER_ID_CHUNK } from "../src/durable-objects/bound-parameters";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";
import { ensureAuditSchema } from "./helpers/audit-fixture";
import {
  seedCanonicalMessageRecord,
  seedParticipantMessage,
  holdFirstWorkspaceRead,
  holdLoopExecuting,
  releaseHeldLoop,
} from "./helpers/substream-fixture";

/**
 * Runs `fn` against a hosted parent's grant store inside the Organization
 * object. The store is private to `HostedParent`; the cast reaches it the way
 * the legacy tests reached `WorkstreamDO`'s.
 */
function withParentGrants<T>(
  stub: DurableObjectStub,
  address: { workspaceId: string; parentId: string },
  fn: (store: ScopeGrantStorage, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return withHostedParent(stub, address.parentId, (parent, state) => fn(
    (parent as unknown as { scopeGrants(address: { workspaceId: string; parentId: string }): ScopeGrantStorage })
      .scopeGrants(address),
    state,
  ));
}

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
const PERSONAL_PROMPT_MODEL = "pipeline-personal-prompt/primary";
const ASIDE_WINDOW_MODEL = "pipeline-aside-window/primary";
const ASIDE_ELICITATION_MODEL = "pipeline-aside-elicitation/primary";
const ASIDE_BACKLOG_MODEL = "pipeline-aside-backlog/primary";
const ASIDE_BEHIND_QUEUE_MODEL = "pipeline-aside-behind-queue/primary";

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
  await ensureAuditSchema();
  await env.DB.batch([
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
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
    env.DB.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT DEFAULT 'member', incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, USER_ID),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_USER_ID),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
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

function agentStub(): DurableObjectStub<SubstreamAgent> {
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
  reason = "user_message",
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
      reason,
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
  membershipVersion = substreamId === "0" ? 0 : 1,
  upgradedResponse?: Response,
): Promise<{ socket: WebSocket; initial: SocketFrame }> {
  const response = upgradedResponse ?? await stub.fetch("https://substream.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-workstream-id": WORKSTREAM_ID,
      "x-rally-substream-id": substreamId,
      "x-rally-socket-admission-membership-version": String(membershipVersion),
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

  it("recovers a persisted host outcome without re-admitting the execution principal", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "recover this attempt");
    const runId = opened.body.harnessRunId as string;
    const settled = await settledRun(stub, runId);
    const input = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ execution_context_json: string }>(
        "SELECT execution_context_json FROM runs WHERE run_id=?", runId).one();
      return WorkstreamWorkflowInputSchema.parse(JSON.parse(row.execution_context_json));
    });
    // The completed result remains recoverable after membership ends. No new
    // provider/tool work is authorized by returning this durable receipt.
    await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .bind(WORKSPACE_ID, USER_ID).run();
    expect(await runWorkstreamHarness(TEST_ENV, input)).toMatchObject({ status: settled.status });
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
      conversation: { parentKind: "workstream" as const, substreamId: "0" as const, backgroundAgent: false },
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
      request.url === "https://openrouter.ai/api/v1/responses");
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

  it.each(["healthy", "publication_failed", "canonical_blocked", "removed_before_recovery"] as const)("adds a public Channel author while queued and recovers participant publication (%s)", async (delivery) => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    expect(await product(stub, { operation: "update", auth: AUTH, input: { scope: "workspace" } }))
      .toMatchObject({ status: 200 });
    const otherSessionId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO sessions (id,user_id,workspace_id,region,expires_at)
      VALUES (?,?,?,'global','2099-01-01T00:00:00.000Z')`).bind(otherSessionId, OTHER_USER_ID, WORKSPACE_ID).run();
    const otherAuth = { ...AUTH, userId: OTHER_USER_ID, sessionId: otherSessionId };
    const { socket } = await openSubscribedSocket(stub, crypto.randomUUID());
    const live = collectSocketFrames(socket);
    try {
      // Hold execution so this proves admission, without letting this message
      // reach a provider or relying on the loop promoting its turn first.
      await runInDurableObject(stub, (_instance, state) => holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) }));
      if (delivery !== "healthy") await runInDurableObject(stub, (instance, state) => {
        if (delivery === "canonical_blocked") {
          const turnId = state.storage.sql.exec<{ turn_id: string }>(
            "SELECT turn_id FROM participant_transcript_turns ORDER BY transcript_sequence LIMIT 1",
          ).one().turn_id;
          enqueueSemanticRealtimeReference(state.storage.sql, { kind: "transcript_turn", turnId }, Date.now());
        }
        const publisher = instance as unknown as {
          deliverCommittedRealtimeEvent(event: { type: string }): Promise<void>;
        };
        const deliver = publisher.deliverCommittedRealtimeEvent.bind(instance);
        vi.spyOn(publisher, "deliverCommittedRealtimeEvent").mockImplementation(async (event) => {
          if (event.type === (delivery === "canonical_blocked" ? "transcript_turn_upserted" : "participant_added")) {
            throw new Error("forced_participant_publication_failure");
          }
          await deliver(event);
        });
      });
      const input = { text: "Start my thread here", clientMessageId: crypto.randomUUID(),
        forcedHarnessOrigin: "user_message", mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] };
      expect(await product(stub, { operation: "create_message", auth: otherAuth, input }))
        .toMatchObject({ status: 200, body: { deliveryState: "pending" } });
      expect(await product(stub, { operation: "get", auth: AUTH }))
        .toMatchObject({ status: 200, body: { participants: expect.arrayContaining([
          expect.objectContaining({ user: expect.objectContaining({ id: OTHER_USER_ID }), participationReason: "message" }),
        ]) } });
      if (delivery === "canonical_blocked") await runInDurableObject(stub, async (instance) => {
        // A later drain must not bypass the predecessor's deferred retry gate.
        expect(await (instance as unknown as { flushSemanticRealtimeOutboxBestEffort(): Promise<boolean> })
          .flushSemanticRealtimeOutboxBestEffort()).toBe(false);
      });
      if (delivery !== "healthy") await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM durable_outbox
          WHERE channel='semantic_realtime_v1' AND json_extract(payload_json, '$.reference.kind')='participant_changed'`).one())
          .toEqual({ count: 1 });
      });
      if (delivery === "removed_before_recovery") {
        expect(await product(stub, { operation: "remove_participant", auth: AUTH, userId: OTHER_USER_ID }))
          .toMatchObject({ status: 200 });
      }
      expect(await product(stub, { operation: "create_message", auth: otherAuth, input }))
        .toMatchObject({ status: 200, body: { deliveryState: "pending" } });
      if (delivery !== "healthy") await runInDurableObject(stub, async (instance, state) => {
        const publisher = instance as unknown as {
          deliverCommittedRealtimeEvent(event: { type: string }): Promise<void>;
          flushSemanticRealtimeOutboxBestEffort(): Promise<boolean>;
        };
        vi.mocked(publisher.deliverCommittedRealtimeEvent).mockRestore();
        state.storage.sql.exec("UPDATE durable_outbox SET not_before=0 WHERE channel='semantic_realtime_v1'");
        expect(await publisher.flushSemanticRealtimeOutboxBestEffort()).toBe(true);
      });
      if (delivery === "removed_before_recovery") {
        await expect.poll(() => live.frames.filter((frame) => frame.type === "participant_removed"))
          .toMatchObject([{ userId: OTHER_USER_ID }]);
        expect(live.frames.filter((frame) => frame.type === "participant_added")).toEqual([]);
      } else {
        await expect.poll(() => live.frames.filter((frame) => frame.type === "participant_added"))
          .toMatchObject([{ participant: { user: { id: OTHER_USER_ID } } }]);
      }
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM participants WHERE user_id=? AND status='active'", OTHER_USER_ID).one())
          .toEqual({ count: delivery === "removed_before_recovery" ? 0 : 1 });
        expect(state.storage.sql.exec("SELECT 1 FROM canonical_conversation_turn_details WHERE client_message_id=?", input.clientMessageId).toArray())
          .toEqual([]);
      });
    } finally {
      vi.restoreAllMocks();
      live.stop();
      socket.close(1000, "test complete");
    }
  });

  it("hydrates one participant in a roster larger than D1's parameter limit", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    const userIds = Array.from({ length: 101 }, () => crypto.randomUUID());
    await env.DB.batch(userIds.map((id) => env.DB.prepare(`INSERT INTO users
      (id,email,name,timezone,created_at) VALUES (?,?,'Roster member','UTC','2026-01-01T00:00:00.000Z')`)
      .bind(id, `${id}@example.test`)));
    await runInDurableObject(stub, async (instance, state) => {
      new WorkstreamIdentityStorage(state.storage).admitParticipants({
        userIds: [...userIds, OTHER_USER_ID], addedByUserId: USER_ID, reason: "explicit", now: Date.parse("2026-10-21T00:00:00.000Z"),
      });
      // Read the actual service output against real D1, without loading the
      // whole roster or starting another model run.
      expect(await (instance as unknown as { product: WorkstreamObjectProductService }).product.participant(OTHER_USER_ID))
        .toMatchObject({ user: { id: OTHER_USER_ID }, participationReason: "explicit", joinedAt: "2026-10-21T00:00:00.000Z" });
    });
  });

  it.each(["removed", "added"] as const)("publishes the admission's actual participant transition when the author is %s during preparation", async (change) => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);
    expect(await product(stub, { operation: "update", auth: AUTH, input: { scope: "workspace" } }))
      .toMatchObject({ status: 200 });
    const sessionId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO sessions (id,user_id,workspace_id,region,expires_at)
      VALUES (?,?,?,'global','2099-01-01T00:00:00.000Z')`).bind(sessionId, OTHER_USER_ID, WORKSPACE_ID).run();
    const otherAuth = { ...AUTH, userId: OTHER_USER_ID, sessionId };
    if (change === "removed") expect(await product(stub, { operation: "add_participant", auth: AUTH, userId: OTHER_USER_ID }))
      .toMatchObject({ status: 200 });
    const { socket } = await openSubscribedSocket(stub, crypto.randomUUID());
    const live = collectSocketFrames(socket);
    await runInDurableObject(stub, (_instance, state) => holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) }));
    const gate = { open: false, entered: false };
    await runInDurableObject(stub, (instance) => {
      const service = (instance as unknown as { product: {
        reserveAttachmentDrafts(...args: unknown[]): Promise<unknown>;
      } }).product;
      const reserve = service.reserveAttachmentDrafts.bind(service);
      // Pause an existing preparation await; execute the real reservation on
      // release. The gate decides ordering; polling only waits for its state.
      vi.spyOn(service, "reserveAttachmentDrafts").mockImplementation(async (...args) => {
        gate.entered = true;
        while (!gate.open) await scheduler.wait(10);
        return reserve(...args);
      });
    });
    const clientMessageId = crypto.randomUUID();
    const sending = product(stub, { operation: "create_message", auth: otherAuth, input: {
      text: "Participating now", clientMessageId, forcedHarnessOrigin: "user_message",
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
    } });
    try {
      // Execution stays held, so the accepted message never reaches a provider.
      await expect.poll(() => gate.entered).toBe(true);
      expect(await product(stub, { operation: change === "removed" ? "remove_participant" : "add_participant",
        auth: AUTH, userId: OTHER_USER_ID })).toMatchObject({ status: 200 });
      gate.open = true;
      expect(await sending).toMatchObject({ status: 200, body: { deliveryState: "pending" } });
      await expect.poll(() => live.frames.filter((frame) => frame.type === "participant_added"))
        .toMatchObject([{ participant: { user: { id: OTHER_USER_ID } } }]);
      expect(await product(stub, { operation: "get", auth: AUTH })).toMatchObject({ status: 200, body: {
        participants: expect.arrayContaining([expect.objectContaining({ user: expect.objectContaining({ id: OTHER_USER_ID }) })]),
      } });
    } finally {
      gate.open = true;
      await sending;
      vi.restoreAllMocks();
      live.stop();
      socket.close(1000, "test complete");
    }
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
                  function: { name: "current_time", arguments: "{}" },
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

  it("retries an interrupted opening after the personal instruction cache refreshes", async () => {
    const stub = agentStub();
    await env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID)).savePersonalSystemPrompt({
      workspaceId: WORKSPACE_ID, userId: USER_ID, personalSystemPrompt: "Answer briefly.",
    });
    await runInDurableObject(stub, (instance) => {
      const transcript = (instance as unknown as { product: { transcript: WorkstreamTranscriptStorage } }).product.transcript;
      // The receipt already exists when transcript preparation starts. An
      // uncertain failure must leave that frozen content available to retry.
      vi.spyOn(transcript, "prepareConversation").mockRejectedValueOnce(new Error("interrupted_transcript_preparation"));
    });
    try {
      await installScriptedProvider(stub, [
        [{ choices: [{ delta: { content: "recovered answer" }, finish_reason: "stop" }] }],
      ], { primaryModel: PERSONAL_PROMPT_MODEL, fallbackModels: [] });
      expect(await initializeWorkstream(stub, "original opening", PERSONAL_PROMPT_MODEL, [], "opening_message"))
        .toMatchObject({ status: 500 });
      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ text: string }>(
          "SELECT text FROM personal_system_prompt_copies WHERE user_id = ?", USER_ID,
        ).toArray()[0]?.text), { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 25 }).toBe("Answer briefly.");
      const retried = await initializeWorkstream(stub, "original opening", PERSONAL_PROMPT_MODEL, [], "opening_message");
      expect(retried).toMatchObject({ status: 200 });
      await externallySettledRun(stub, retried.body.harnessRunId as string);
      await waitForLoopRelease(stub);
      const request = (await capturedProviderRequests(stub)).find((entry) => entry.url === "https://openrouter.ai/api/v1/responses")!;
      const users = (request.body.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "user");
      expect(users.at(-1)?.content).toContain("original opening");
      expect(JSON.stringify(users)).not.toContain("<user_system_prompt>");
    } finally {
      vi.restoreAllMocks();
      await restoreProviderFetch(stub);
    }
  });

  it("refreshes personal instructions on a room-only message before the next request", async () => {
    const stub = agentStub();
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
    const copiedInstructions = () => runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ text: string }>(
        "SELECT text FROM personal_system_prompt_copies WHERE user_id = ?", USER_ID,
      ).toArray()[0]?.text ?? null);
    try {
      await workspace.savePersonalSystemPrompt({
        workspaceId: WORKSPACE_ID, userId: USER_ID, personalSystemPrompt: "Answer briefly.",
      });
      await installScriptedProvider(stub, [
        [{ choices: [{ delta: { content: "first answer" }, finish_reason: "stop" }] }],
        [{ choices: [{ delta: { content: "next answer" }, finish_reason: "stop" }] }],
      ], { primaryModel: PERSONAL_PROMPT_MODEL, fallbackModels: [] });
      const opened = await initializeWorkstream(stub, "please look into this", PERSONAL_PROMPT_MODEL, [OTHER_USER_ID], "opening_message");
      expect(opened.status).toBe(200);
      await externallySettledRun(stub, opened.body.harnessRunId as string);
      await waitForLoopRelease(stub);
      await expect.poll(copiedInstructions, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 25 }).toBe("Answer briefly.");
      await workspace.savePersonalSystemPrompt({
        workspaceId: WORKSPACE_ID, userId: USER_ID, personalSystemPrompt: "",
      });
      const aside = await product(stub, { operation: "create_message", auth: AUTH, input: {
        text: "sounds good", clientMessageId: "personal-prompt-aside", mentions: [],
        confirmedParticipantUserIds: [], attachmentIds: [],
      } });
      expect(aside.status).toBe(200);
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM runs").one().count)).toBe(1);
      await expect.poll(copiedInstructions, { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 25 }).toBe("");
      const question = await product(stub, { operation: "create_message", auth: AUTH, input: {
        text: "please summarize what we agreed", clientMessageId: "personal-prompt-after-aside", mentions: [],
        confirmedParticipantUserIds: [], attachmentIds: [],
      } });
      expect(question.status).toBe(200);
      await settledRunForTrigger(stub, (question.body.turn as { turnId: string }).turnId);
      await waitForLoopRelease(stub);
      const request = (await capturedProviderRequests(stub)).filter((entry) => entry.url === "https://openrouter.ai/api/v1/responses").at(-1)!;
      const users = (request.body.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "user");
      expect(String(users.at(-2)?.content)).toContain("<user_system_prompt>");
      expect(String(users.at(-2)?.content)).toContain("Answer briefly.");
      expect(String(users.at(-2)?.content)).toContain("sounds good");
      expect(String(users.at(-1)?.content)).toContain("please summarize what we agreed");
      expect(String(users.at(-1)?.content)).not.toContain("<user_system_prompt>");
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it.each([
    { name: "uncertain promise", answer: { choice: "answer_or_result" as const, confidence: 0.70 }, verify: true },
    { name: "unavailable judge", answer: "unavailable" as const, verify: true },
    { name: "confident result", answer: { choice: "answer_or_result" as const, confidence: 0.95 }, verify: false },
  ])("completion verification handles $name in the production loop", async ({ answer, verify }) => {
    const stub = agentStub();
    try {
      await installScriptedProvider(stub, [
        [{ choices: [{ delta: { content: verify ? "I'm drafting the article now." : "Here is the article." }, finish_reason: "stop" }] }],
        ...(verify ? [[{ choices: [{ delta: { content: "Here is the completed article." }, finish_reason: "stop" }] }]] : []),
      ], { primaryModel: PERSONAL_PROMPT_MODEL, fallbackModels: [], completionAnswers: [answer] });
      const opened = await initializeWorkstream(stub, "Write an article about launch planning.", PERSONAL_PROMPT_MODEL);
      expect(opened.status).toBe(200);
      const run = await externallySettledRun(stub, opened.body.harnessRunId as string);
      expect(run.status).toBe("completed");
      const requests = (await capturedProviderRequests(stub)).filter((request) => request.url.endsWith("/responses"));
      expect(requests).toHaveLength(verify ? 2 : 1);
      const judgments = await capturedCompletionRequests(stub);
      expect(judgments).toHaveLength(1);
      expect(judgments[0]!.body).toMatchObject({ model: "jev-1.14.0", state: {
        triggering_request: { text: "Write an article about launch planning." }, context_status: "resolved",
      } });
      const saved = await runInDurableObject(stub, (_instance, state) => ({
        markers: state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM transcript_facts
          WHERE source_kind = 'completion_verification' AND source_id = ?`, run.run_id).one().n,
        final: new WorkstreamMessageStorage(state.storage).message({ messageId: run.final_turn_id! })?.text_content,
      }));
      expect(saved).toEqual({ markers: verify ? 1 : 0,
        final: verify ? "Here is the completed article." : "Here is the article." });
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("refreshes personal instructions at admission and keeps earlier message values in history", async () => {
    const stub = agentStub();
    const instructions = "Answer in French, and keep every reply under fifty words.";
    const messages = (requests: Awaited<ReturnType<typeof capturedProviderRequests>>) => requests
      .filter((request) => request.url === "https://openrouter.ai/api/v1/responses")
      .map((request) => request.body.messages as Array<{ role: string; content: unknown }>);
    const copiedInstructions = () => runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ text: string }>(
        "SELECT text FROM personal_system_prompt_copies WHERE user_id = ?", USER_ID,
      ).toArray()[0]?.text ?? null);
    try {
      const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
      await workspace.savePersonalSystemPrompt({
        workspaceId: WORKSPACE_ID, userId: USER_ID, personalSystemPrompt: instructions,
      });
      await installScriptedProvider(stub, [
        [{ choices: [{ delta: { content: "first answer" }, finish_reason: "stop" }] }],
        [{ choices: [{ delta: { content: "second answer" }, finish_reason: "stop" }] }],
      ], { primaryModel: PERSONAL_PROMPT_MODEL, fallbackModels: [], gateFirstCall: true });
      const opened = await initializeWorkstream(stub, "first message", PERSONAL_PROMPT_MODEL, [], "opening_message");
      await expect.poll(async () => messages(await capturedProviderRequests(stub)).length,
        { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 25 }).toBe(1);
      // A fresh opening uses its empty copy and refreshes it for the next admission.
      expect(JSON.stringify(messages(await capturedProviderRequests(stub))[0])).not.toContain(instructions);
      await expect.poll(copiedInstructions,
        { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 25 }).toBe(instructions);

      await workspace.savePersonalSystemPrompt({
        workspaceId: WORKSPACE_ID, userId: USER_ID, personalSystemPrompt: "",
      });
      const followUp = await product(stub, {
        operation: "create_message", auth: AUTH,
        input: { text: "second message", clientMessageId: "pipeline-personal-prompt-1",
          mentions: [], confirmedParticipantUserIds: [], attachmentIds: [], runMode: "queue" },
      });
      expect(followUp.status).toBe(200);
      // The first run is still blocked. A refresh owned by the queued run's
      // startup could not happen yet, so this proves admission owns it.
      await expect.poll(copiedInstructions,
        { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 25 }).toBe("");
      expect(messages(await capturedProviderRequests(stub))).toHaveLength(1);
      await openProviderGate(stub);
      await externallySettledRun(stub, opened.body.harnessRunId as string);
      await settledRunForTrigger(stub, (followUp.body.turn as { turnId: string }).turnId);

      const second = messages(await capturedProviderRequests(stub))[1]!;
      expect(JSON.stringify(second.filter((message) => message.role === "system"))).not.toContain(instructions);
      const userMessage = second.filter((message) => message.role === "user").at(-1);
      expect(userMessage?.content).toContain(`<user_system_prompt>\nThe following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.\n<user_suppplied>\n${instructions}\n</user_suppplied>\n</user_system_prompt>\n\nsecond message`);

      await waitForLoopRelease(stub);
      await evictDurableObject(stub);
      // Reinstall only the provider double on the new instance; history is durable.
      await installScriptedProvider(stub, [
        [{ choices: [{ delta: { content: "third answer" }, finish_reason: "stop" }] }],
      ], { primaryModel: PERSONAL_PROMPT_MODEL, fallbackModels: [] });
      const next = await product(stub, {
        operation: "create_message", auth: AUTH,
        input: { text: "third message", clientMessageId: "pipeline-personal-prompt-2",
          mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] },
      });
      expect(next.status).toBe(200);
      await settledRunForTrigger(stub, (next.body.turn as { turnId: string }).turnId);
      await waitForLoopRelease(stub);
      const third = messages(await capturedProviderRequests(stub)).at(-1)!;
      const history = third.filter((message) => message.role === "user");
      expect(history[1]?.content).toEqual(userMessage?.content);
      expect(String(history[2]?.content)).toContain("third message");
      expect(String(history[2]?.content)).not.toContain("<user_system_prompt>");
      expect(JSON.stringify(third.filter((message) => message.role === "system"))).not.toContain(instructions);
      const { socket, initial } = await openSubscribedSocket(stub, crypto.randomUUID());
      try {
        expect(JSON.stringify(snapshotTurns(initial))).toContain("second message");
        expect(JSON.stringify(snapshotTurns(initial))).toContain("<user_system_prompt>");
        expect(JSON.stringify(snapshotTurns(initial))).toContain(instructions);
      } finally { socket.close(); }
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("lands an aside sent behind a queued question under that question, without a run", async () => {
    // The production report: one person asks Rally for something while a run
    // is going, so it queues; a second person answers the first ("sounds good")
    // without addressing Rally. Written straight to the transcript, the reply
    // took a sequence ahead of the queued question and read above it forever.
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [
          [{ choices: [{ delta: { content: "answering the first" }, finish_reason: "stop" }] }],
          [{ choices: [{ delta: { content: "here is the summary" }, finish_reason: "stop" }] }],
        ],
        { primaryModel: ASIDE_BEHIND_QUEUE_MODEL, fallbackModels: [], gateFirstCall: true },
      );
      // Two people, or every message is aimed at Rally and none is an aside.
      const opened = await initializeWorkstream(
        stub,
        "first message",
        ASIDE_BEHIND_QUEUE_MODEL,
        [OTHER_USER_ID],
      );
      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ status: string }>(
          `SELECT status FROM substream_loops WHERE id = 1`,
        ).toArray()[0]?.status ?? "absent"), {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "the opening run never took the loop",
      }).toBe("executing");

      const send = (text: string, clientMessageId: string) => product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: { text, clientMessageId, mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] },
      });
      const question = await send("please summarize what we agreed", "pipeline-behind-queue-1");
      const aside = await send("sounds good", "pipeline-behind-queue-2");
      expect([question.body.deliveryState, aside.body.deliveryState]).toEqual(["pending", "pending"]);
      const questionTurnId = (question.body.turn as { turnId: string }).turnId;
      const asideTurnId = (aside.body.turn as { turnId: string }).turnId;

      await openProviderGate(stub);
      await settledRun(stub, opened.body.harnessRunId as string);
      await settledRunForTrigger(stub, questionTurnId);

      const landed = await runInDurableObject(stub, (_instance, state) => ({
        order: state.storage.sql.exec<{ turn_id: string }>(
          `SELECT turn_id FROM participant_transcript_turns
            WHERE turn_id IN (?, ?) ORDER BY transcript_sequence`,
          questionTurnId,
          asideTurnId,
        ).toArray().map((row) => row.turn_id),
        // Directly under the question: nothing the question's run wrote sits
        // between them.
        gap: state.storage.sql.exec<{ gap: number }>(
          `SELECT aside.transcript_sequence - question.transcript_sequence AS gap
             FROM participant_transcript_turns AS question, participant_transcript_turns AS aside
            WHERE question.turn_id = ? AND aside.turn_id = ?`,
          questionTurnId,
          asideTurnId,
        ).one().gap,
        pending: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_inputs`,
        ).one().count,
        asideRuns: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM runs
            WHERE json_extract(execution_context_json, '$.triggerMessageId') = ?`,
          asideTurnId,
        ).one().count,
      }));
      expect(landed).toEqual({ order: [questionTurnId, asideTurnId], gap: 1, pending: 0, asideRuns: 0 });
    } finally {
      await openProviderGate(stub).catch(() => undefined);
      await restoreProviderFetch(stub);
    }
  });

  it("lands an aside on an idle loop when the admission it waited behind fails", async () => {
    // An aside waits only on what was sent ahead of it. When that fails instead
    // of landing, nothing will ever activate the loop on the aside's behalf —
    // it starts no run — so the idle loop has to land it by itself.
    const stub = agentStub();
    try {
      await installScriptedProvider(
        stub,
        [[{ choices: [{ delta: { content: "looked into it" }, finish_reason: "stop" }] }]],
        { primaryModel: ASIDE_BEHIND_QUEUE_MODEL, fallbackModels: [] },
      );
      const opened = await initializeWorkstream(
        stub,
        "please look into this",
        ASIDE_BEHIND_QUEUE_MODEL,
        [OTHER_USER_ID],
      );
      await settledRun(stub, opened.body.harnessRunId as string);
      await waitForLoopRelease(stub);
      const runsBefore = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM runs`).one().count);

      // Mentions someone outside the workspace, so preparation refuses it once
      // the held read is released; until then it is `preparing`, ahead of the aside.
      const gate = await runInDurableObject(stub, (instance) => holdFirstWorkspaceRead(
        (instance as unknown as { product: WorkstreamObjectProductService }).product as unknown as { env: Env },
      ));
      void product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "Stranger please check this",
          clientMessageId: "pipeline-aside-orphan-1",
          mentions: [{
            type: "person",
            label: "Stranger",
            userId: "00000000-0000-7000-8000-00000000beef",
            connectorType: null,
            startOffset: 0,
            endOffset: 8,
          }],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      }).catch(() => undefined);
      await expect.poll(() => runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_input_mailbox WHERE state = 'preparing'`,
        ).one().count), {
        timeout: SUBSCRIPTION_SETTLE_TIMEOUT_MS,
        interval: 25,
        message: "the doomed admission never reserved its mailbox row",
      }).toBe(1);

      const aside = await product(stub, {
        operation: "create_message",
        auth: AUTH,
        input: {
          text: "sounds good",
          clientMessageId: "pipeline-aside-orphan-2",
          mentions: [],
          confirmedParticipantUserIds: [],
          attachmentIds: [],
        },
      });
      expect(aside.body.deliveryState).toBe("pending");
      const asideTurnId = (aside.body.turn as { turnId: string }).turnId;

      gate.open = true;
      // No forced alarm: the failed admission's own settlement is the only
      // thing that can bring the loop back to the aside.
      await expect.poll(() => runInDurableObject(stub, (_instance, state) => ({
        canonical: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE turn_id = ?`,
          asideTurnId,
        ).one().count,
        pending: state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM pending_loop_inputs`,
        ).one().count,
      })), {
        timeout: RUN_SETTLE_TIMEOUT_MS,
        interval: 50,
        message: "the aside was stranded behind a failed admission",
      }).toEqual({ canonical: 1, pending: 0 });
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM runs`).one().count))
        .toBe(runsBefore);
    } finally {
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

  it("keeps an aside written between a question's admission and its activation behind the question", async () => {
    // A question is admitted and somebody talks before the alarm activates it.
    // The aside used to be written at once, above the question's admission
    // fence and below the turn the question took at activation — so the room
    // read the reply above what it replied to, and the first version of the
    // gap-fill, scanning only to that fence, lost the aside from the model
    // entirely. Now the aside queues behind the question and lands directly
    // under it; the model reads it once, after the question, as an aside.
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
      expect(aside.body.deliveryState).toBe("pending");
      // Both wait, in the order they were sent; only the question starts a run.
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ prepared_turn_id: string; starts_run: number }>(
          `SELECT prepared_turn_id, starts_run FROM pending_loop_inputs ORDER BY input_sequence`,
        ).toArray().map((row) => ({ ...row })))).toEqual([
        { prepared_turn_id: questionTurnId, starts_run: 1 },
        { prepared_turn_id: asideTurnId, starts_run: 0 },
      ]);

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
      // Sent before the question's run started, so that run reads it: after
      // the question, and as something said to the room, not a request.
      const questionIndex = texts.findIndex((text) => text.includes("please summarize what we agreed"));
      const asideIndex = texts.findIndex((text) => text.includes("sounds good"));
      expect(questionIndex).toBeGreaterThanOrEqual(0);
      expect(asideIndex).toBeGreaterThan(questionIndex);
      expect(texts[asideIndex]).toContain("SAID TO THE ROOM, NOT TO RALLY");
      expect(texts[questionIndex]).not.toContain("SAID TO THE ROOM");

      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ gap: number }>(
          `SELECT aside.transcript_sequence - question.transcript_sequence AS gap
             FROM participant_transcript_turns AS question, participant_transcript_turns AS aside
            WHERE question.turn_id = ? AND aside.turn_id = ?`,
          questionTurnId,
          asideTurnId,
        ).one().gap)).toBe(1);
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
      // Once each: the gap-fill skips the aside by its provenance.
      expect(later.filter((text) => text.includes("please summarize what we agreed"))).toHaveLength(1);
      expect(later.filter((text) => text.includes("sounds good"))).toHaveLength(1);
    } finally {
      await restoreProviderFetch(stub);
    }
  });

  it("cancels an open question when an aside arrives and keeps the aside for the next request", async () => {
    // The aside closes the question without starting a run. The next invoked
    // input supplies the cancellation tool result before the aside and itself.
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
                    name: "request_elicitation",
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
      expect(await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ status: string }>(
          `SELECT status FROM elicitation_requests WHERE elicitation_id = ?`,
          elicitationId,
        ).one().status)).toBe("cancelled");

      const answered = await product(stub, {
        operation: "answer_elicitation",
        auth: AUTH,
        elicitationId,
        input: { answer: "a" },
      });
      expect(answered.status).toBe(409);
      expect(answered.body).toMatchObject({ error: "elicitation_cancelled" });
      // A direct canonical aside does not advance the model's transcript mark.
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
      expect(toolResult, "the cancellation never reached the model as a tool result").toBeGreaterThanOrEqual(0);
      expect(JSON.parse(String(messages[toolResult]?.content))).toMatchObject({
        data: { elicitationId, answer: null, cancelled: true },
      });
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
    await runInDurableObject(stub, (_instance, state) => {
      // The Queue is not consumed here; arrange delivered previews before
      // asserting that admission owns the next wake-up.
      state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL");
    });
    await runDurableObjectAlarm(stub);
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

  it("leaves successful activation alarm ownership with the SubstreamAgent", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await externallySettledRun(stub, opened.body.harnessRunId as string);
    await waitForLoopRelease(stub);
    await runInDurableObject(stub, (_instance, state) => {
      // Initial preview delivery is settled before testing activation's alarm.
      state.storage.sql.exec("UPDATE conversation_view_changes SET pending = 0, in_flight_revision = NULL, in_flight_until = NULL");
    });
    await runDurableObjectAlarm(stub);
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
      { timeout: LOOP_RELEASE_TIMEOUT_MS, interval: 50, message: "the object never quiesced" },
    ).toBeNull();

    let alarmWrites = 0;
    let activationCalls = 0;
    let activationAlarm: number | null = null;
    await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as {
        product: WorkstreamObjectProductService;
        requestPersistentLoopActivation: (request: unknown) => Promise<void>;
      };
      const storage = (target.product as unknown as { storage: DurableObjectStorage }).storage;
      const activate = target.requestPersistentLoopActivation.bind(target);
      target.requestPersistentLoopActivation = async (request: unknown) => {
        activationCalls += 1;
        await activate(request);
        activationAlarm = await state.storage.getAlarm();
      };
      (target.product as unknown as { storage: DurableObjectStorage }).storage =
        createCloudflareTestBinding<DurableObjectStorage>(new Proxy(storage, {
          get: (current, property) => {
            const value = Reflect.get(current, property) as unknown;
            if (property !== "setAlarm") {
              return typeof value === "function" ? value.bind(current) : value;
            }
            return (scheduledTime: number | Date) => {
              alarmWrites += 1;
              return storage.setAlarm(scheduledTime);
            };
          },
        }));
    });

    const activationStartedAt = Date.now();
    const result = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "please continue",
        clientMessageId: "pipeline-activation-owner-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });
    expect(result.status).toBe(200);
    const activationSettledAt = Date.now();
    // The public product endpoint must route the returned request through the
    // single outer activation owner. The invocation starts the drain directly,
    // so its one alarm write stays at the 30-second eviction-recovery horizon
    // instead of racing the healthy drain with a due-now wake.
    expect(alarmWrites).toBe(1);
    expect(activationCalls).toBe(1);
    expect(activationAlarm).not.toBeNull();
    expect(activationAlarm!).toBeGreaterThanOrEqual(activationStartedAt + 30_000);
    expect(activationAlarm!).toBeLessThanOrEqual(activationSettledAt + 30_000);
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

  it("admits one ordinary human continuation from a resource authorization callback", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message", null, [OTHER_USER_ID]);
    await settledRun(stub, opened.body.harnessRunId as string);
    const failedToolInvocationId = `${crypto.randomUUID()}:turn:1:tool:0`;
    const input = {
      text: "Document “Ellen Buckley Assessment” was authorized.",
      clientMessageId: `resource-authorization:${failedToolInvocationId}`,
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
      runMode: "queue",
      forcedHarnessOrigin: "resource_authorization",
    };
    const auth = { ...AUTH, sessionId: "resource-authorization:callback", principal: "resource_authorization" };
    const before = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM runs").one().count);

    const spoof = await product(stub, { operation: "create_message", auth: AUTH, input });
    expect(spoof.status).toBe(403);

    const first = await product(stub, { operation: "create_message", auth, input });
    const replay = await product(stub, { operation: "create_message", auth, input });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect((replay.body.turn as { turnId: string }).turnId)
      .toBe((first.body.turn as { turnId: string }).turnId);
    await expect.poll(() => runInDurableObject(stub, (_instance, state) => {
      const turn = state.storage.sql.exec<{ author_user_id: string; actor: string }>(
        `SELECT author_user_id, actor FROM participant_transcript_turns WHERE client_message_id = ?`,
        input.clientMessageId,
      ).toArray()[0];
      const runs = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM runs").one().count;
      return { turn, runs };
    }), { timeout: RUN_SETTLE_TIMEOUT_MS, interval: 50 }).toEqual({
      turn: { author_user_id: USER_ID, actor: "human" },
      runs: before + 1,
    });
  });

  describe("participant projection delivery", () => {
    useHeldEffectQueue();
    it("migrates authoritative private-child membership and keeps Main mutations independently scoped", async () => {
      const main = agentStub();
      const opened = await initializeWorkstream(main,"first message");
      await settledRun(main,opened.body.harnessRunId as string);
      const substreamId = asSubstreamId(crypto.randomUUID());
      const child = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global",WORKSPACE_ID,WORKSTREAM_ID,substreamId));
      expect((await child.bootstrapRuntime({ workspaceId:WORKSPACE_ID,parentKind:"workstream",parentId:WORKSTREAM_ID,
        substreamId,generation:1 })).status).toBe(200);
      expect((await child.executeIdentityOperation({ workspaceId:WORKSPACE_ID,workstreamId:WORKSTREAM_ID,substreamId,
        operation:"provision",args:[{ title:"Private child",objective:"Migration test",scope:"personal",
          originType:"ad_hoc",createdByUserId:USER_ID,participantUserIds:[USER_ID],harnessStatus:"idle",emailAddress:null,
          emailRouteStatus:null,systemKind:null,automationRunId:null,plannedFor:null,modelOverride:null,now:Date.now() }] })).status).toBe(200);
      const parent = hostedParentStub(env,WORKSPACE_ID);
      await parent.authority({ workspaceId:WORKSPACE_ID,parentId:WORKSTREAM_ID });
      await runInDurableObject(parent, (_instance,state) => {
        state.storage.sql.exec(`INSERT OR IGNORE INTO parent_metadata
          (parent_id,parent_kind,workspace_id,region,authority_generation,created_at,updated_at)
          VALUES (?,'workstream',?,'global',1,0,0)`,WORKSTREAM_ID,WORKSPACE_ID);
        // A hosted parent's Channel row is written with its metadata, and its
        // viewer rows land in the same transactions as the parent's writes,
        // so the Organization's directory holds the row at the parent's first
        // common version.
        state.storage.sql.exec(`INSERT OR IGNORE INTO channels
          (workstream_id,authority_generation,waterline,source_event_id,payload_hash,title,description,preview,scope,
           exact_state,last_activity_at,origin_type,title_status,latest_attention_ordinal,unread_tracking_start_ordinal,
           source_created_at,source_updated_at,projected_at)
          VALUES (?,1,1,?,'fixture','Child migration','','','personal','idle',0,'ad_hoc','settled',0,0,0,0,0)`,
        WORKSTREAM_ID,crypto.randomUUID());
        state.storage.sql.exec(`INSERT OR IGNORE INTO parent_projection_keys(parent_id,projection_key,next_version,last_payload_hash,updated_at)
          VALUES (?,'common',2,'fixture',0)`,WORKSTREAM_ID);
        // Its authorization inventory is walked, as a created Channel's is.
        state.storage.sql.exec("INSERT OR IGNORE INTO authorization_backfill(parent_id,parent_kind,completed) VALUES (?,'workstream',1)",WORKSTREAM_ID);
        state.storage.sql.exec("INSERT OR IGNORE INTO parent_children(parent_id,substream_id,kind,created_by_user_id,created_at) VALUES (?,?,'child',?,0)",WORKSTREAM_ID,substreamId,USER_ID);
        state.storage.sql.exec(`INSERT INTO parent_breakout_members
          (parent_id,substream_id,user_id,active,version,added_by_user_id,added_at,updated_at) VALUES (?,?,?,1,2,?,10,10)`,
        WORKSTREAM_ID,substreamId,OTHER_USER_ID,USER_ID);
        state.storage.sql.exec(`INSERT INTO parent_breakout_members
          (parent_id,substream_id,user_id,active,version,added_by_user_id,added_at,removed_at,updated_at) VALUES (?,?,?,0,3,?,10,20,20)`,
        WORKSTREAM_ID,substreamId,USER_ID,USER_ID);
        // Parked until the migration has frozen it: the Organization object's
        // own alarms drain due breakout effects, and one firing before the
        // migration would deliver this row as ordinary pre-migration work.
        state.storage.sql.exec(`INSERT INTO parent_breakout_member_effects
          (parent_id,operation_id,substream_id,user_id,actor_user_id,active,membership_version,state,attempts,not_before,created_at)
          VALUES (?,?,?,?,?,0,3,'pending',0,?,20)`,WORKSTREAM_ID,crypto.randomUUID(),substreamId,USER_ID,USER_ID,Number.MAX_SAFE_INTEGER);
      });
      const address = { workspaceId:WORKSPACE_ID,parentId:WORKSTREAM_ID,substreamId };
      const invitation = { workspaceId:WORKSPACE_ID,parentId:WORKSTREAM_ID,actorUserId:USER_ID,
        operationId:crypto.randomUUID(),emails:["guest@example.test"],expiresAt:null,
        targets:[{ kind:"conversation" as const,...address }] };
      expect(await parent.createScopeInvitations(invitation)).toMatchObject({ status:"denied" });
      await runInDurableObject(parent, (_instance,state) => {
        expect(state.storage.sql.exec("SELECT 1 FROM parent_participant_migrations WHERE parent_id=? AND substream_id<>'0'",WORKSTREAM_ID).toArray()).toEqual([]);
      });
      expect(await parent.createScopeInvitations({ ...invitation,actorUserId:OTHER_USER_ID }))
        .toMatchObject({ status:"created" });
      const migration = await parent.beginChildParticipantMigration(address);
      expect(migration.status).toBe("complete");
      await runDurableObjectAlarm(parent);
      await expect.poll(() => parent.beginChildParticipantMigration(address), { timeout:30_000 })
        .toEqual({ status:"complete",transferId:migration.transferId });
      await withParentGrants(parent, address, (store) => {
        expect(store.forUser(USER_ID)).toEqual([]);
      });
      await runDurableObjectAlarm(parent);
      await expect.poll(() => runInDurableObject(child, (_instance,state) =>
        state.storage.sql.exec("SELECT user_id FROM participants WHERE status='active' ORDER BY user_id").toArray()),
      { timeout:30_000 }).toEqual([{ user_id:OTHER_USER_ID }]);
      // Now due, the frozen legacy effect must still be skipped by the drain.
      await withHostedParent(parent, WORKSTREAM_ID, async (hosted, state) => {
        state.storage.sql.exec("UPDATE parent_breakout_member_effects SET not_before=0 WHERE parent_id=? AND substream_id=?",WORKSTREAM_ID,substreamId);
        await hosted.drainPrivateChildMembershipEffects();
      });
      await withParentGrants(parent, address, (store,state) => {
        expect(store.forUser(OTHER_USER_ID)).toMatchObject([{ target:{ kind:"conversation",substreamId },active:true }]);
        expect(store.forUser(USER_ID)).toEqual([]);
        expect(store.read(OTHER_USER_ID,{ kind:"workstream",workspaceId:WORKSPACE_ID,parentId:WORKSTREAM_ID })).toBeNull();
        expect(() => state.storage.sql.exec("UPDATE parent_breakout_members SET active=0 WHERE parent_id=? AND substream_id=?",WORKSTREAM_ID,substreamId))
          .toThrow("participant_authority_transferred");
        expect(state.storage.sql.exec("SELECT state,attempts FROM parent_breakout_member_effects WHERE parent_id=? AND substream_id=?",WORKSTREAM_ID,substreamId).one())
          .toEqual({ state:"pending",attempts:0 });
      });
      await runInDurableObject(main, (_instance,state) => {
        expect(new ParticipantAuthorityTransferStorage(state.storage).currentTransferId()).toBeNull();
      });
      const participantRequest = { ...address,actorUserId:OTHER_USER_ID,userId:USER_ID,operationId:"child-participant-add" };
      const added = await parent.addPrivateChildParticipant(participantRequest);
      expect(added.outcome).toBe("added");
      await env.DB.prepare("UPDATE workspace_members SET access_class='guest',role=NULL WHERE workspace_id=? AND user_id=?")
        .bind(WORKSPACE_ID,USER_ID).run();
      // The relationship change event the D1 write would publish: the
      // Organization answers access from its own member table, which may
      // already hold this person as a member.
      const demoted = await readWorkspaceRelationship(env.DB,WORKSPACE_ID,USER_ID);
      expect(await parent.applyMemberStatus({ workspaceId:WORKSPACE_ID,sequence:1,removed:false,relationship:demoted! }))
        .toEqual({ applied:true });
      const renamed = await product(child,{ operation:"update",auth:{ ...AUTH,role:null },input:{ title:"Guest collaboration" } });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ title:"Guest collaboration" });
      // Workspace-public legacy visibility must not become implicit guest access.
      await runInDurableObject(parent,(_instance,state) => {
        state.storage.sql.exec("UPDATE channels SET scope='workspace' WHERE workstream_id = ?",WORKSTREAM_ID);
      });
      await env.DB.prepare("ALTER TABLE users ADD COLUMN analytics_person_id TEXT").run();
      const signingKey = "guest-route-signing-key-for-workerd-test";
      const apiEnv = { ...TEST_ENV,SESSION_SIGNING_KEY:signingKey,ALLOWED_ORIGINS:"https://app.example.test",
        PUBLIC_API_BASE_URL:"https://api.example.test",RALLY_DEV_AUTH:"false" };
      const token = await new SignJWT({ sid:SESSION_ID,wid:WORKSPACE_ID,region:"global" })
        .setProtectedHeader({ alg:"HS256",typ:"JWT" }).setSubject(USER_ID).setIssuer("avalon-api")
        .setAudience("avalon-desktop").setIssuedAt().setExpirationTime("15m").sign(new TextEncoder().encode(signingKey));
      const app = createApp();
      const headers = { authorization:`Bearer ${token}` };
      const path = `/conversations/${WORKSTREAM_ID}/substreams/${substreamId}`;
      expect((await app.request(path,{},apiEnv)).status).toBe(401);
      const renameResponse = await app.request(path,{ method:"PATCH",headers:{ ...headers,"content-type":"application/json" },
        body:JSON.stringify({ title:"Guest API collaboration" }) },apiEnv);
      expect(renameResponse.status).toBe(204);
      const guestBoot = await app.request(path,{ headers },apiEnv);
      expect(guestBoot.status).toBe(200);
      expect(await guestBoot.json()).toMatchObject({ title:"Guest API collaboration" });
      expect((await app.request(`/conversations/${WORKSTREAM_ID}`,{ headers },apiEnv)).status).toBe(404);
      expect((await app.request(`/conversations/${WORKSTREAM_ID}/substreams/${crypto.randomUUID()}`,{ headers },apiEnv)).status).toBe(404);
      for (const archived of [true, false]) {
        const archiveResponse = await app.request(path, { method: "PATCH",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ archived }),
        }, apiEnv);
        expect(archiveResponse.status).toBe(204);
        const directory = await readSharedWorkstream(parent, { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID,
          userId: USER_ID, membershipIncarnation: "existing-member" });
        expect(directory?.conversations.find((conversation) => conversation.substreamId === substreamId)?.archived).toBe(archived);
        await runInDurableObject(parent, (_instance, state) => {
          const row = state.storage.sql.exec<{ archived_at: number | null }>(
            "SELECT archived_at FROM parent_children WHERE parent_id=? AND substream_id=?", WORKSTREAM_ID, substreamId).one();
          expect(row.archived_at !== null).toBe(archived);
        });
      }
      // Child-only guests can manage this roster without acquiring Main access.
      for (const active of [false, true]) {
        const rosterResponse = await app.request(`${path}/participants${active ? "" : "/remove"}`, {
          method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ userId: OTHER_USER_ID, operationId: crypto.randomUUID() }),
        }, apiEnv);
        expect(rosterResponse.status).toBe(200);
        expect(await rosterResponse.json()).toMatchObject({ outcome: active ? "added" : "removed" });
        expect(await parent.readScopeAccess({ userId: OTHER_USER_ID,
          target: { kind: "conversation", ...address } })).toMatchObject({ allowed: active });
      }
      const ticketResponse = await app.request(`${path}/socket`,{ headers },apiEnv);
      expect(ticketResponse.status).toBe(200);
      const issued = await ticketResponse.json() as { ticket:string;url:string };
      expect(issued).toMatchObject({ ticket:expect.any(String) });
      const upgrade = await app.request(issued.url.replace("wss:","https:"),{ headers:{
        Origin:"https://app.example.test",Upgrade:"websocket",
        "Sec-WebSocket-Protocol":socketTicketProtocols(issued.ticket).join(", "),
      } },apiEnv);
      const childAdmission = await parent.authorizeViewer({ ...address,userId:USER_ID });
      expect(childAdmission.authorized).toBe(true);
      expect(await parent.readScopeAccess({ userId:USER_ID,target:{ kind:"conversation",...address,substreamId:asSubstreamId("0") } }))
        .toMatchObject({ allowed:false });
      const childSocket = await openSubscribedSocket(child,crypto.randomUUID(),substreamId,childAdmission.membershipVersion,upgrade);
      const childClosed = new Promise<CloseEvent>((resolve) => childSocket.socket.addEventListener("close",resolve,{ once:true }));
      const uploadId = crypto.randomUUID();
      const upload = async (id: string) => {
        const body = new FormData();
        body.set("file",new File(["Guest uploaded bytes"],"guest.txt",{ type:"text/plain" }));
        return app.request("/resources/upload",{ method:"POST",headers:{ ...headers,"x-rally-draft-id":id },body },apiEnv);
      };
      const uploaded = await upload(uploadId);
      expect(uploaded.status,await uploaded.clone().text()).toBe(201);
      const draftBytes = await app.request(`/resources/${uploadId}/content`,{ headers },apiEnv);
      expect(draftBytes.status).toBe(200);
      expect(await draftBytes.text()).toBe("Guest uploaded bytes");
      const attach = (resourceId: string) => app.request(`${path}/resources`,{
        method:"POST",headers:{ ...headers,"content-type":"application/json" },body:JSON.stringify({ resourceId }),
      },apiEnv);
      expect((await attach(uploadId)).status).toBe(409);
      const discardedId = crypto.randomUUID();
      expect((await upload(discardedId)).status).toBe(201);
      expect((await app.request(`/resources/${discardedId}`,{ method:"DELETE",headers },apiEnv)).status).toBe(204);
      expect((await app.request(`/resources/${discardedId}/content`,{ headers },apiEnv)).status).toBe(404);
      const receipt = nextSocketCommandOutcome(childSocket.socket);
      childSocket.socket.send(JSON.stringify({ type:"create_message",operationId:crypto.randomUUID(),payload:{
        text:"please summarize the risks",clientMessageId:crypto.randomUUID(),mentions:[],confirmedParticipantUserIds:[],attachmentIds:[uploadId],
      } }));
      const outcome = await receipt;
      expect(outcome,JSON.stringify(outcome)).toMatchObject({ type:"client_command_succeeded",command:"create_message" });

      expect((await app.request(`/resources/${uploadId}`,{ method:"DELETE",headers },apiEnv)).status).toBe(404);
      expect((await app.request(`/resources/${uploadId}/content`,{ headers },apiEnv)).status).toBe(200);
      await runDurableObjectAlarm(child);
      await expect.poll(() => runInDurableObject(child,(_instance,state) => {
        const attachments = state.storage.sql.exec("SELECT resource_id FROM participant_transcript_attachments WHERE resource_id=?",uploadId).toArray();
        if (attachments.length) return "delivered";
        return JSON.stringify({ pending:state.storage.sql.exec("SELECT * FROM pending_loop_input_mailbox").toArray(),
          loops:state.storage.sql.exec("SELECT * FROM substream_loops").toArray(),runs:state.storage.sql.exec("SELECT status,error_json FROM runs").toArray() });
      }), { timeout:RUN_SETTLE_TIMEOUT_MS }).toBe("delivered");
      const deliveredEffects = await deliverChildEffects(TEST_ENV,child);
      const uploadPublication = deliveredEffects.find((entry) => entry.effect.kind === "directory_common"
        && entry.effect.attachmentReservationReleases?.some((release) => release.resourceId === uploadId));
      expect(uploadPublication).toBeDefined();
      expect(await consumeEffectBodies(TEST_ENV,[uploadPublication])).toEqual({ acked:1,retried:0 });
      await runInDurableObject(env.WORKSPACE_DOS.getByName(workspaceDOName("global",WORKSPACE_ID)),(_instance,state) => {
        expect(state.storage.sql.exec("SELECT attachment_status FROM resources WHERE id=?",uploadId).one()).toEqual({ attachment_status:"attached" });
        expect(state.storage.sql.exec("SELECT resource_id FROM pending_attachment_reservations WHERE resource_id=?",uploadId).toArray()).toEqual([]);
        expect(state.storage.sql.exec("SELECT resource_id FROM workspace_workstream_resource_links WHERE resource_id=?",uploadId).toArray()).toEqual([]);
      });
      const existingAttachment = await attach(uploadId);
      expect(existingAttachment.status,await existingAttachment.clone().text()).toBe(201);
      expect((await app.request(`${path}/resources/${uploadId}`,{ method:"DELETE",headers },apiEnv)).status).toBe(204);
      expect((await attach(uploadId)).status).toBe(201);
      const sharedResource = crypto.randomUUID();
      const unrelatedResource = crypto.randomUUID();
      const ownDraft = crypto.randomUUID();
      const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName("global",WORKSPACE_ID));
      await runInDurableObject(workspace,(_instance,state) => {
        for (const id of [sharedResource,unrelatedResource,ownDraft]) {
          state.storage.sql.exec(`INSERT INTO resources
            (id,workspace_id,resource_type,provider,title,metadata_json,created_at,updated_at,uploaded_by_user_id)
            VALUES (?,?,'file',?,'Guest resource','{}','2026-09-16T00:00:00Z','2026-09-16T00:00:00Z',?)`,
          id,WORKSPACE_ID,id === ownDraft ? 'avalon_upload' : 'google_drive',id === ownDraft ? USER_ID : null);
        }
      });
      await runInDurableObject(child,(_instance,state) => {
        state.storage.sql.exec(`INSERT INTO workstream_resource_links
          (resource_id,attached_by_user_id,watch_enabled,relationship_type,resource_json,attached_at,updated_at)
          VALUES (?,?,0,'attachment','{}',1,1)`,sharedResource,OTHER_USER_ID);
      });
      await workspace.applyAuthorizationLocations({ ...address,parentKind:"workstream",revision:1,validatedAt:Date.now(),resourceIds:[sharedResource] });
      await runInDurableObject(main,(_instance,state) => {
        state.storage.sql.exec(`INSERT INTO workstream_resource_links
          (resource_id,attached_by_user_id,watch_enabled,relationship_type,resource_json,attached_at,updated_at)
          VALUES (?,?,0,'attachment','{}',1,1)`,unrelatedResource,OTHER_USER_ID);
      });
      await workspace.applyAuthorizationLocations({ ...address,substreamId:"0",parentKind:"workstream",revision:1,validatedAt:Date.now(),resourceIds:[unrelatedResource] });
      const payloadKey = `guest-resource/${sharedResource}`;
      await env.PAYLOADS.put(payloadKey,"Shared resource bytes",{ httpMetadata:{ contentType:"text/plain" } });
      await env.PAYLOADS.put(`${payloadKey}/private`,"Unshared resource bytes",{ httpMetadata:{ contentType:"text/plain" } });
      await env.PAYLOADS.put(`${payloadKey}/model`,"Shared extracted text",{ httpMetadata:{ contentType:"text/plain" } });
      await runInDurableObject(workspace,(_instance,state) => {
        state.storage.sql.exec("UPDATE resources SET content_ref=?,mime_type='text/plain',model_content_ref=?,model_mime_type='text/plain' WHERE id=?",payloadKey,`${payloadKey}/model`,sharedResource);
        state.storage.sql.exec("UPDATE resources SET content_ref=?,mime_type='text/plain' WHERE id=?",`${payloadKey}/private`,unrelatedResource);
      });
      expect((await app.request(`/resources/${sharedResource}`,{ headers },apiEnv)).status).toBe(200);
      const download = await app.request(`/resources/${sharedResource}/content`,{ headers },apiEnv);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("Shared resource bytes");
      const inaccessibleDownload = await app.request(`/resources/${unrelatedResource}/content`,{ headers },apiEnv);
      expect(inaccessibleDownload.status).not.toBe(200);
      const versionPaths = ["/versions", "/versions/2", "/versions/2/content", "/versions/2/model-content"];
      for (const suffix of versionPaths) {
        const shared = await app.request(`/resources/${sharedResource}${suffix}`, { headers }, apiEnv);
        expect(shared.status, suffix).toBe(200);
        if (suffix.endsWith("/model-content")) expect(await shared.text()).toBe("Shared extracted text");
        else if (suffix.endsWith("/content")) expect(await shared.text()).toBe("Shared resource bytes");
        else if (suffix === "/versions/2") expect(await shared.json()).toMatchObject({ version: 2 });
        else expect(await shared.json()).toEqual(expect.arrayContaining([expect.objectContaining({ version: 2 })]));
        expect((await app.request(`/resources/${unrelatedResource}${suffix}`, { headers }, apiEnv)).status, suffix).toBe(404);
      }


      const artifactId = asArtifactId(crypto.randomUUID());
      const artifactHost = env.ARTIFACT_HOSTS.getByName(artifactHostDOName("global", artifactId));
      await runInDurableObject(workspace, (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO artifact_registry
          (artifact_id,workspace_id,workstream_id,resource_id,mode,stateful,current_version,manifest_ref,created_at,updated_at,hostname_stub)
          VALUES (?,?,?,?,'static',0,1,'test-manifest',0,0,'level-luminous-sequential-schrodinger')`,
        artifactId, WORKSPACE_ID, WORKSTREAM_ID, sharedResource);
      });
      await artifactHost.recordPublish({ artifactId, workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID,
        resourceId: sharedResource, region: "global", manifest: { version: 1, artifactId, artifactVersion: 1,
          mode: "static", stateful: false, serverModuleSha256: null, assets: [], totalBytes: 0,
          publishedAt: "2026-09-17T00:00:00.000Z" } });
      const artifactService = new ArtifactOpenService(TEST_ENV, { ...AUTH, role: null });
      await runInDurableObject(workspace, (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO artifact_registry
          (artifact_id,workspace_id,workstream_id,resource_id,mode,stateful,current_version,manifest_ref,created_at,updated_at,hostname_stub)
          VALUES (?,?,?,?,'static',0,1,'test-manifest',0,0,NULL)`,
        crypto.randomUUID(), WORKSPACE_ID, WORKSTREAM_ID, unrelatedResource);
      });
      await runInDurableObject(parent, (_instance, state) => {
        state.storage.sql.exec("UPDATE channels SET scope='workspace' WHERE workstream_id = ?", WORKSTREAM_ID);
      });
      expect(await withHostedParent(parent, WORKSTREAM_ID, (hosted) => hosted.canRead(USER_ID))).toBe(true); // Legacy public visibility must not authorize a guest.
      await expect(artifactService.open(unrelatedResource)).rejects.toMatchObject({ status: 404, code: "artifact_not_found" });
      await runInDurableObject(parent, (_instance, state) => {
        state.storage.sql.exec("UPDATE channels SET scope='personal' WHERE workstream_id = ?", WORKSTREAM_ID);
      });
      const refreshResponse = await app.request(`/resources/${sharedResource}/hydrate`, { method: "POST", headers }, apiEnv);
      expect(refreshResponse.status, await refreshResponse.clone().text()).toBe(200);
      expect((await app.request(`/resources/${unrelatedResource}/hydrate`, { method: "POST", headers }, apiEnv)).status).toBe(404);
      const artifactResponse = await app.request(`/resources/${sharedResource}/artifact/open`, { method: "POST", headers }, apiEnv);
      expect(artifactResponse.status, await artifactResponse.clone().text()).toBe(200);
      const artifactOpen = await artifactResponse.json() as { openUrl: string };
      const artifactSession = await artifactHost.redeemCode(new URL(artifactOpen.openUrl).hash.slice(1));
      expect(artifactSession).not.toBeNull();
      expect(await artifactHost.checkSession(artifactSession!.session)).toMatchObject({ ok: true, viewerId: USER_ID });

      const attachmentChecks = vi.spyOn(AuthorizationService.prototype, "checkMany");
      try {
        const memberAttach = await product(child, { operation: "attach_resource",
          auth: { ...AUTH, userId: OTHER_USER_ID, role: "member", principal: "connector" },
          resourceId: sharedResource });
        expect(memberAttach.status).toBe(200);
        expect(attachmentChecks).not.toHaveBeenCalled();
        const allowedAttach = await attach(sharedResource);
        expect(allowedAttach.status, await allowedAttach.clone().text()).toBe(201);
        expect(attachmentChecks.mock.calls.filter(([, resources]) => resources.some((resource) =>
          resource.kind === "resource" && resource.resourceId === sharedResource))).toHaveLength(1);
      } finally { attachmentChecks.mockRestore(); }
      expect((await attach(unrelatedResource)).status).toBe(404);
      await runInDurableObject(child,(_instance,state) => {
        expect(state.storage.sql.exec("SELECT resource_id FROM workstream_resource_links WHERE resource_id=?",unrelatedResource).toArray()).toEqual([]);
      });
      const authorizer = new AuthorizationService(TEST_ENV);
      const subject = { workspaceId:WORKSPACE_ID,userId:USER_ID,delegation:null };
      // A mixed legacy/shared batch must read the real parent once, without
      // substituting Main's legacy decision for the independently shared child.
      await runInDurableObject(parent, async (instance) => {
        const reads = vi.spyOn(Object.getPrototypeOf(instance) as typeof instance, "readAuthorizationFacts");
        try {
          const decisions = await authorizer.checkMany(subject, ["0", substreamId].map((id) => ({
            kind: "conversation" as const, workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID,
            substreamId: asSubstreamId(id),
          })));
          expect(decisions.map((decision) => decision.status)).toEqual(["denied", "allowed"]);
          expect(reads).toHaveBeenCalledTimes(1);
        } finally { reads.mockRestore(); }
      });
      const resourceAccess = (resourceId:string) => ({ kind:"resource" as const,workspaceId:WORKSPACE_ID,resourceId });
      const resourceDecisions = await authorizer.checkMany(subject,[resourceAccess(sharedResource),resourceAccess(unrelatedResource),resourceAccess(ownDraft)]);
      expect(resourceDecisions[0]).toMatchObject({ status:"allowed" });
      expect(resourceDecisions[1]?.status).not.toBe("allowed");
      expect(resourceDecisions[2]).toMatchObject({ status:"allowed" });
      const makeSidekick = async (scope: "workspace" | "workstream" | "personal",owningWorkstreamId: string | null = null) => {
        const automationId = asAutomationId(crypto.randomUUID());
        // Every Sidekick's parent is hosted by the Organization object.
        const sidekick = workspace;
        await sidekick.sidekickCreate({ workspaceId:WORKSPACE_ID,automationId,authorUserId:OTHER_USER_ID,
          scope,owningWorkstreamId,authorityGeneration:1 });
        await sidekick.sidekickSaveDefinition({ workspaceId:WORKSPACE_ID,automationId,
          actor:{ userId:OTHER_USER_ID,actorRole:"member",participantOfOwningWorkstream:true },
          submittedByRunId:null,evaluatorRules:null,
          draft:AutomationDraftSchema.parse({ definitionVersion:2,name:`${scope} helper`,description:"Shared instructions",
            overview:"A guest collaboration helper",instructions:"Use short sentences.",triggers:[],requiredCapabilities:[],
            expectedOutputs:[],defaultBehavior:{},recommendedPlugins:[],memoryTables:[],suggestedScope:scope,
            followUpQuestion:null,elicitation:null,ready:true }),
        });
        return { automationId,sidekick };
      };
      const ownedSidekick = await makeSidekick("workstream",WORKSTREAM_ID);
      const authoringAgent = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, ownedSidekick.automationId));
      expect((await authoringAgent.bootstrapRuntime({ workspaceId: WORKSPACE_ID, parentKind: "automation",
        parentId: ownedSidekick.automationId, substreamId: "0", generation: 1 })).status).toBe(200);
      expect((await authoringAgent.executeIdentityOperation({ workspaceId: WORKSPACE_ID, workstreamId: ownedSidekick.automationId,
        operation: "provision", args: [{ title: "Owned Sidekick", objective: "Author shared instructions", scope: "personal",
          originType: "ad_hoc", createdByUserId: OTHER_USER_ID, participantUserIds: [OTHER_USER_ID],
          harnessStatus: "idle", emailAddress: null, emailRouteStatus: null, systemKind: null, automationRunId: null,
          plannedFor: null, modelOverride: null, now: Date.now() }] })).status).toBe(200);
      const authoringResource = crypto.randomUUID();
      await runInDurableObject(workspace, (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO resources
          (id,workspace_id,resource_type,provider,title,metadata_json,created_at,updated_at)
          VALUES (?,?,'file','google_drive','Sidekick resource','{}','2026-09-17T00:00:00Z','2026-09-17T00:00:00Z')`, authoringResource, WORKSPACE_ID);
      });
      await runInDurableObject(authoringAgent, (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO workstream_resource_links
          (resource_id,attached_by_user_id,watch_enabled,relationship_type,resource_json,attached_at,updated_at)
          VALUES (?,?,0,'attachment','{}',1,1)`, authoringResource, OTHER_USER_ID);
      });
      await workspace.applyAuthorizationLocations({ workspaceId: WORKSPACE_ID, parentId: ownedSidekick.automationId,
        substreamId: "0", parentKind: "automation", revision: 1, validatedAt: Date.now(), resourceIds: [authoringResource] });
      const readAuthoringResource = () => app.request(`/resources/${authoringResource}`, { headers }, apiEnv);
      expect((await readAuthoringResource()).status).not.toBe(200);
      const recommendedSidekick = await makeSidekick("workspace");
      const privateSidekick = await makeSidekick("personal");
      const otherRoomSidekick = await makeSidekick("workstream",crypto.randomUUID());
      const unselectedSidekick = await makeSidekick("workspace");
      await runInDurableObject(parent,(_instance,state) => {
        for (const id of [recommendedSidekick.automationId,privateSidekick.automationId,otherRoomSidekick.automationId]) {
          state.storage.sql.exec("INSERT INTO parent_sidekicks(parent_id,sidekick_id,attached_at) VALUES (?,?,?)",WORKSTREAM_ID,id,Date.now());
        }
      });
      // Stale or corrupt discovery IDs never widen canonical source access.
      const recommendationReads: { check?: () => void; restore?: () => void } = {};
      await runInDurableObject(parent, (instance) => {
        // A Channel's kind and authority now come from one hosted-parent read.
        const authority = vi.spyOn(Object.getPrototypeOf(instance), "resolveHostedParent");
        // One resolution at admission and one at the final access recheck.
        recommendationReads.check = () => expect(authority).toHaveBeenCalledTimes(2);
        recommendationReads.restore = () => authority.mockRestore();
      });
      let recommendations: Response;
      try {
        recommendations = await app.request(`${path}/recommended-sidekicks`,{ headers },apiEnv);
        await runInDurableObject(parent, () => recommendationReads.check!());
      } finally {
        await runInDurableObject(parent, () => recommendationReads.restore!());
      }
      expect(recommendations.status,await recommendations.clone().text()).toBe(200);
      const recommendationsBody = await recommendations.json() as { items: Array<{ id:string;available:boolean }> };
      expect(recommendationsBody.items.map((item) => item.id).sort()).toEqual([ownedSidekick.automationId,recommendedSidekick.automationId].sort());
      expect(recommendationsBody.items.every((item) => item.available)).toBe(true);
      for (const item of recommendationsBody.items) expect(Object.keys(item).sort()).toEqual(["available","description","id","name"]);
      expect(recommendationsBody.items.some((item) => item.id === unselectedSidekick.automationId)).toBe(false);
      const guestExecution = WorkstreamWorkflowInputSchema.parse({ region:"global",workspaceId:WORKSPACE_ID,
        parentKind:"workstream",parentId:WORKSTREAM_ID,substreamId,loopId:substreamLoopId(WORKSTREAM_ID,substreamId),
        harnessRunId:crypto.randomUUID(),triggerMessageId:null,activityId:null,
        executionPrincipal:{ type:"user",userId:USER_ID },reason:"guest_sidekick_test" });
      const sources = await resolveSidekickSkills(TEST_ENV,guestExecution,true,
        [ownedSidekick.automationId,recommendedSidekick.automationId,privateSidekick.automationId,otherRoomSidekick.automationId]);
      expect(sources.map((source) => source.id).sort()).toEqual([ownedSidekick.automationId,recommendedSidekick.automationId].sort());
      expect(sources.every((source) => source.instructions === "Use short sentences.")).toBe(true);
      const freshSources = await resolveSidekickSkills(TEST_ENV,guestExecution,true);
      expect(freshSources.map((source) => source.id).sort()).toEqual([ownedSidekick.automationId,recommendedSidekick.automationId].sort());
      await recommendedSidekick.sidekick.sidekickPause({ workspaceId:WORKSPACE_ID,automationId:recommendedSidekick.automationId,
        actor:{ userId:OTHER_USER_ID,actorRole:"member",participantOfOwningWorkstream:false } });
      const pausedRecommendations = await app.request(`${path}/recommended-sidekicks`,{ headers },apiEnv);
      expect(await pausedRecommendations.json()).toMatchObject({ items:expect.arrayContaining([{ id:recommendedSidekick.automationId,
        name:"workspace helper",description:"Shared instructions",available:false }]) });
      expect(await resolveSidekickSkills(TEST_ENV,guestExecution,true,[recommendedSidekick.automationId],false)).toEqual([]);

      expect((await app.request(`/conversations/${ownedSidekick.automationId}`,{ headers },apiEnv)).status).not.toBe(200);
      expect((await app.request(`/conversations/${WORKSTREAM_ID}/substreams/0/recommended-sidekicks`,{ headers },apiEnv)).status).toBe(404);
      await waitForLoopRelease(child);
      try {
        await installScriptedProvider(child,[
          [{ choices:[{ delta:{ tool_calls:[{ index:0,id:"guest-sidekick-plugin",type:"function",
            function:{ name:"load_plugin",arguments:JSON.stringify({ pluginId:"rally_sidekicks" }) } }] },finish_reason:"tool_calls" }] }],
          [{ choices:[{ delta:{ tool_calls:[{ index:0,id:"guest-sidekick-list",type:"function",
            function:{ name:"sidekick_sidekicks_list",arguments:"{}" } }] },finish_reason:"tool_calls" }] }],
          [{ choices:[{ delta:{ tool_calls:[{ index:0,id:"guest-load-sidekick",type:"function",
            function:{ name:"load_skill",arguments:JSON.stringify({ name:"sidekick-workstream-helper" }) } }] },finish_reason:"tool_calls" }] }],
          [{ choices:[{ delta:{ content:"I will use short sentences." },finish_reason:"stop" }] }],
        ],{ primaryModel:"guest-sidekick/primary",fallbackModels:[] });
        const parentCalls: { check?: () => void; restore?: () => void } = {};
        await runInDurableObject(parent, (instance) => {
          const prototype = Object.getPrototypeOf(instance) as typeof instance;
          const joins = vi.spyOn(prototype, "joinConversation");
          const grants = vi.spyOn(prototype, "mutateParticipantGrant");
          parentCalls.check = () => {
            expect(joins).not.toHaveBeenCalled();
            expect(grants).not.toHaveBeenCalled();
          };
          parentCalls.restore = () => { joins.mockRestore(); grants.mockRestore(); };
        });
        const loadedReceipt = nextSocketCommandOutcome(childSocket.socket);
        let loadedOutcome: SocketFrame;
        try {
          childSocket.socket.send(JSON.stringify({ type:"create_message",operationId:crypto.randomUUID(),payload:{
            text:"please summarize the risks",clientMessageId:crypto.randomUUID(),mentions:[],confirmedParticipantUserIds:[],attachmentIds:[],
          } }));
          loadedOutcome = await loadedReceipt;
          await runInDurableObject(parent, () => parentCalls.check!());
        } finally {
          await runInDurableObject(parent, () => parentCalls.restore!());
        }
        expect(loadedOutcome).toMatchObject({ type:"client_command_succeeded" });
        const loadedTurn = loadedOutcome.turn as { turnId:string };
        const loadedRun = await settledRunForTrigger(child,loadedTurn.turnId);
        expect(loadedRun.status,loadedRun.error_json ?? "").toBe("completed");
        const catalogResults = (await capturedProviderRequests(child)).flatMap((request) =>
          request.body.messages as Array<{ role?: string; tool_call_id?: string; content?: string }>)
          .filter((message) => message.role === "tool" && message.tool_call_id === "guest-sidekick-list");
        expect(catalogResults.length).toBeGreaterThan(0);
        for (const result of catalogResults) {
          expect(JSON.parse(result.content ?? "null")).toMatchObject({ success: true, data: {
            workspaceSidekicks: [{ sidekickId: recommendedSidekick.automationId,
              canAttach: false, attached: true }],
          } });
        }
        await waitForLoopRelease(child);
      } finally {
        await restoreProviderFetch(child);
      }
      expect(await runInDurableObject(main,(_instance,state) => state.storage.sql.exec("SELECT sidekick_id FROM sidekick_attachments").toArray())).toEqual([]);
      await runInDurableObject(main,(_instance,state) => {
        state.storage.sql.exec("INSERT INTO sidekick_attachments(sidekick_id,attached_at) VALUES (?,?)",ownedSidekick.automationId,Date.now());
      });
      const localSidekicks = await app.request(`${path}/sidekicks`,{ headers },apiEnv);
      expect(localSidekicks.status,await localSidekicks.clone().text()).toBe(200);
      expect(await localSidekicks.json()).toMatchObject({ items:[{ id:ownedSidekick.automationId,available:true }] });
      const removedSidekick = await app.request(`${path}/sidekicks/${ownedSidekick.automationId}`,{ method:"DELETE",headers },apiEnv);
      expect(removedSidekick.status,await removedSidekick.clone().text()).toBe(200);
      expect(await removedSidekick.json()).toEqual({ items:[] });
      expect(await runInDurableObject(main,(_instance,state) => state.storage.sql.exec<{ sidekick_id:string }>("SELECT sidekick_id FROM sidekick_attachments").toArray().map((row) => row.sidekick_id))).toEqual([ownedSidekick.automationId]);
      expect(await parent.recommendedSidekickIds({ workspaceId:WORKSPACE_ID,parentId:WORKSTREAM_ID })).toContain(recommendedSidekick.automationId);
      const recommendationMutation = (sidekickId: string, method: "PUT" | "DELETE") =>
        app.request(`${path}/recommended-sidekicks/${sidekickId}`, { method, headers }, apiEnv);
      expect((await recommendationMutation(recommendedSidekick.automationId, "PUT")).status).toBe(403);
      const readOptions = async () => {
        const response = await app.request(`${path}/sidekick-recommendation-options`, { headers }, apiEnv);
        expect(response.status).toBe(200);
        return response.json() as Promise<{ canManage: boolean; items: Array<{ id: string; attached: boolean }> }>;
      };
      const childOptions = await readOptions();
      expect(childOptions.canManage).toBe(false);
      expect(childOptions.items.map((item) => item.id)).toEqual([recommendedSidekick.automationId]);
      const changeSidekickAppearance = (color: string) => app.request(`/sidekicks/${ownedSidekick.automationId}/appearance`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ color }),
      }, apiEnv);
      expect((await changeSidekickAppearance("blue")).status).toBe(403);
      const parentTarget = { kind: "workstream" as const, workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID };
      await withParentGrants(parent, address, (store) => {
        expect(store.mutate({ operationId: crypto.randomUUID(),
          actorUserId: OTHER_USER_ID, userId: USER_ID, target: parentTarget, active: true, expectedRevision: 0 }, "existing-member"))
          .toMatchObject({ status: "committed" });
      });
      // Whether the grant makes them one of the home's people is the
      // Organization object's to decide, from its own rows; the request below
      // is how that shows.
      const changedAppearance = await changeSidekickAppearance("blue");
      expect(changedAppearance.status, await changedAppearance.clone().text()).toBe(200);
      expect(await changedAppearance.json()).toMatchObject({ appearance: { color: "blue" } });
      for (const action of ["pause", "resume"]) {
        const response = await app.request(`/sidekicks/${ownedSidekick.automationId}/${action}`, { method: "POST", headers }, apiEnv);
        expect(response.status, await response.clone().text()).toBe(204);
      }
      for (const suffix of ["", "/runs"]) {
        const response = await app.request(`/sidekicks/${ownedSidekick.automationId}${suffix}`, { headers }, apiEnv);
        expect(response.status, await response.clone().text()).toBe(200);
        expect((await app.request(`/sidekicks/${recommendedSidekick.automationId}${suffix}`, { headers }, apiEnv)).status).toBe(404);
      }
      const authoringResourceResponse = await readAuthoringResource();
      expect(authoringResourceResponse.status, await authoringResourceResponse.clone().text()).toBe(200);
      expect(await authoringResourceResponse.json()).toMatchObject({ id: authoringResource, title: "Sidekick resource" });
      const authoringTicket = await app.request(`/conversations/${ownedSidekick.automationId}/substreams/0/socket`, { headers }, apiEnv);
      expect(authoringTicket.status, await authoringTicket.clone().text()).toBe(200);
      const authoringIssued = await authoringTicket.json() as { ticket: string; url: string };
      const authoringUpgrade = await app.request(authoringIssued.url.replace("wss:", "https:"), { headers: {
        Origin: "https://app.example.test", Upgrade: "websocket",
        "Sec-WebSocket-Protocol": socketTicketProtocols(authoringIssued.ticket).join(", "),
      } }, apiEnv);
      const authoringSocket = await openSubscribedSocket(authoringAgent, crypto.randomUUID(), "0", 0, authoringUpgrade);
      let authoringClosed = false;
      authoringSocket.socket.addEventListener("close", () => { authoringClosed = true; }, { once: true });
      const parentOptions = await readOptions();
      expect(parentOptions.canManage).toBe(true);
      expect(parentOptions.items.map((item) => item.id)).toEqual([recommendedSidekick.automationId]);
      // Parent management does not grant discovery of unrelated workspace skills.
      expect((await recommendationMutation(unselectedSidekick.automationId, "PUT")).status).toBe(403);
      expect((await recommendationMutation(recommendedSidekick.automationId, "PUT")).status).toBe(200);
      expect((await recommendationMutation(recommendedSidekick.automationId, "DELETE")).status).toBe(200);
      // The Organization object publishes the owned Sidekicks' `automation`
      // hops itself while it applies the revoked grant's directory row, since
      // it holds the list of Sidekicks the Channel owns. Refuse that publish
      // until released, so the test can see the row wait in the local outbox.
      type RevocationSender = {
        sendBatch: (messages: Iterable<MessageSendRequest<unknown>>, options?: QueueSendBatchOptions) => Promise<void>;
      };
      const revocationQueue: RevocationSender = Object.getPrototypeOf(env.ACCESS_REVOCATION_QUEUE);
      // Every Queue binding shares this prototype, and the held effect queue
      // (`helpers/effect-queue-hold.ts`) already spies on its `sendBatch`.
      // Spying again returns that same spy, so this layers on top of its
      // implementation and puts it back afterwards rather than restoring the
      // real binding under it.
      const heldSendBatch = vi.isMockFunction(revocationQueue.sendBatch)
        ? revocationQueue.sendBatch.getMockImplementation()
        : undefined;
      const originalRevocationSendBatch = heldSendBatch ?? revocationQueue.sendBatch;
      let holdSidekickRevocations = true;
      let sidekickRevocationRefusals = 0;
      const isSidekickRevocation = (body: unknown) => {
        const target = (body as { target?: { scope?: string; automationId?: string } } | null)?.target;
        return target?.scope === "automation" && target.automationId === ownedSidekick.automationId;
      };
      const publishedSidekickRevocations: unknown[] = [];
      const revocationSend = vi.spyOn(revocationQueue, "sendBatch").mockImplementation(async function (this: RevocationSender, messages, options) {
        const requests = [...messages];
        const bodies = requests.map((message) => message.body);
        if (bodies.some(isSidekickRevocation)) {
          if (holdSidekickRevocations) {
            sidekickRevocationRefusals += 1;
            throw new Error("revocation_queue_unavailable");
          }
          publishedSidekickRevocations.push(...bodies.filter(isSidekickRevocation));
        }
        return originalRevocationSendBatch.call(this, requests, options);
      });
      await withParentGrants(parent, address, (store) => {
        expect(store.mutate({ operationId: crypto.randomUUID(), actorUserId: OTHER_USER_ID, userId: USER_ID,
          target: parentTarget, active: false, expectedRevision: store.read(USER_ID, parentTarget)!.revision }, "existing-member"))
          .toMatchObject({ status: "committed" });
      });
      expect((await recommendationMutation(recommendedSidekick.automationId, "DELETE")).status).toBe(403);
      expect((await changeSidekickAppearance("red")).status).toBe(403);
      expect((await readAuthoringResource()).status).not.toBe(200);
      expect((await app.request(`/sidekicks/${ownedSidekick.automationId}`, { headers }, apiEnv)).status).toBe(404);
      expect((await app.request(`/conversations/${ownedSidekick.automationId}`, { headers }, apiEnv)).status).toBe(404);
      await runInDurableObject(ownedSidekick.sidekick,(_instance,state) => {
        expect(JSON.parse(state.storage.sql.exec<{ appearance_json:string }>("SELECT appearance_json FROM automation_directory WHERE automation_id=?",ownedSidekick.automationId).one().appearance_json).color).toBe("blue");
      });
      expect((await readOptions()).canManage).toBe(false);
      // Directory rows are applied inside the Organization object right after
      // the parent write, so Main's directory row exists without a Queue hop.
      await deliverChildEffects(TEST_ENV, main);
      await runInDurableObject(parent, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT workstream_id FROM channels WHERE workstream_id=?", WORKSTREAM_ID).toArray())
          .toEqual([{ workstream_id: WORKSTREAM_ID }]);
      });
      const revokedGrantRows = () => runInDurableObject(parent, (_instance, state) => state.storage.sql.exec<{ payload_json: string; attempts: number }>(
        "SELECT payload_json,attempts FROM parent_outbox WHERE parent_id=? AND effect_kind='scope_grant_directory'", WORKSTREAM_ID,
      ).toArray().filter((row) => {
        const envelope = ParentEffectEnvelopeSchema.parse(JSON.parse(row.payload_json));
        return envelope.effect.kind === "scope_grant_directory" && !envelope.effect.grant.active
          && envelope.effect.grant.target.kind === "workstream" && envelope.effect.grant.userId === USER_ID;
      }));
      const drainParentOutboxNow = async () => {
        await runInDurableObject(parent, async (_instance, state) => {
          state.storage.sql.exec("UPDATE parent_outbox SET not_before=0 WHERE parent_id=?", WORKSTREAM_ID);
          await state.storage.setAlarm(Date.now());
        });
        await runDurableObjectAlarm(parent);
      };
      const revocationBatch = vi.spyOn(TEST_ENV.ACCESS_REVOCATION_QUEUE, "sendBatch");
      try {
        // A refused publish keeps the grant row in the local outbox for the
        // alarm to retry, the way the Queue retried it before the move.
        await expect.poll(async () => {
          await drainParentOutboxNow();
          return sidekickRevocationRefusals;
        }, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBeGreaterThan(0);
        expect((await revokedGrantRows())[0]?.attempts).toBeGreaterThan(0);
        holdSidekickRevocations = false;
        await expect.poll(async () => {
          await drainParentOutboxNow();
          return (await revokedGrantRows()).length;
        }, { timeout: RUN_SETTLE_TIMEOUT_MS }).toBe(0);
        const published = publishedSidekickRevocations;
        expect(published.length).toBeGreaterThan(0);
        const pending: unknown[] = [published.at(-1)];
        let batchOffset = 0;
        while (pending.length) {
          const batch = createMessageBatch("avalon-do-runtime-test-access-revocations", pending.splice(0).map((body) => ({
            id: crypto.randomUUID(), body, timestamp: new Date(), attempts: 1,
          })));
          await consumeAccessRevocationQueue(batch, TEST_ENV);
          expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
          for (const [messages] of revocationBatch.mock.calls.slice(batchOffset)) {
            for (const message of messages) pending.push(message.body);
          }
          batchOffset = revocationBatch.mock.calls.length;
        }
        await expect.poll(() => authoringClosed, { timeout: SUBSCRIPTION_SETTLE_TIMEOUT_MS }).toBe(true);
      } finally {
        if (heldSendBatch) revocationSend.mockImplementation(heldSendBatch);
        else revocationSend.mockRestore();
        revocationBatch.mockRestore();
        authoringSocket.socket.close(1000, "done");
      }
      // The same resource may remain shared through another conversation.
      const secondChildId = asSubstreamId("ffffffff-ffff-4fff-8fff-ffffffffffff");
      const secondAddress = { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: secondChildId };
      const secondChild = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, secondChildId));
      await secondChild.bootstrapRuntime({ ...secondAddress, parentKind: "workstream", generation: 1 });
      expect((await secondChild.executeIdentityOperation({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID,
        substreamId: secondChildId, operation: "provision", args: [{ title: "Other shared child", objective: "Overlap test",
          scope: "personal", originType: "ad_hoc", createdByUserId: OTHER_USER_ID, participantUserIds: [OTHER_USER_ID],
          harnessStatus: "idle", emailAddress: null, emailRouteStatus: null, systemKind: null, automationRunId: null,
          plannedFor: null, modelOverride: null, now: Date.now() }] })).status).toBe(200);
      await runInDurableObject(secondChild, (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO workstream_resource_links
          (resource_id,attached_by_user_id,watch_enabled,relationship_type,resource_json,attached_at,updated_at)
          VALUES (?,?,0,'attachment','{}',1,1)`, sharedResource, OTHER_USER_ID);
      });
      await withParentGrants(parent, address, (store, state) => {
        state.storage.sql.exec("INSERT INTO parent_children(parent_id,substream_id,kind,created_at) VALUES (?,?,'child',0)", WORKSTREAM_ID, secondChildId);
        state.storage.sql.exec("INSERT INTO parent_participant_migrations(parent_id,substream_id,transfer_id,phase) VALUES (?,?,?,'complete')", WORKSTREAM_ID, secondChildId, crypto.randomUUID());
        expect(store.mutate({ operationId: crypto.randomUUID(),
          actorUserId: OTHER_USER_ID, userId: USER_ID, target: { kind: "conversation", ...secondAddress },
          active: true, expectedRevision: 0 }, "existing-member")).toMatchObject({ status: "committed" });
      });
      await workspace.applyAuthorizationLocations({ ...secondAddress, parentKind: "workstream", revision: 1,
        validatedAt: Date.now(), resourceIds: [sharedResource] });
      const guestToolInput = guestExecution;
      await runInDurableObject(parent, async (instance) => {
        const prototype = Object.getPrototypeOf(instance) as typeof instance;
        const admission = vi.spyOn(prototype, "authorizeViewer");
        const lifecycle = vi.spyOn(prototype, "authority");
        const resolution = vi.spyOn(prototype, "resolveHostedParent");
        const resourceChecks = vi.spyOn(AuthorizationService.prototype, "checkMany");
        try {
          await expect(__integrationTesting.assertRunAuthorityStillValid(TEST_ENV, guestToolInput))
            .resolves.toMatchObject({ automationRunId: null });
          expect(admission).toHaveBeenCalledTimes(1);
          expect(lifecycle).not.toHaveBeenCalled();
          expect(resolution).not.toHaveBeenCalled();
          expect(resourceChecks).not.toHaveBeenCalled();
        } finally { admission.mockRestore(); lifecycle.mockRestore(); resolution.mockRestore(); resourceChecks.mockRestore(); }
      });
      const connectorId = crypto.randomUUID();
      const credentialKey = "guest-connector-fixture-encryption-key";
      const freshCredentials = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: "2099-01-01T00:00:00.000Z" };
      const credentials = await encryptString(JSON.stringify(freshCredentials), credentialKey, connectorId);
      await runInDurableObject(workspace, (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO connector_connections
          (id,workspace_id,connector_type,scope,display_name,encrypted_credentials,credential_iv,credential_key_version,
           granted_scopes_json,model_plugin_id,created_at,updated_at)
          VALUES (?,?,'google','workspace','Shared Google',?,?,1,'["docs.write"]','guest_google','2026-09-17','2026-09-17')`,
        connectorId, WORKSPACE_ID, credentials.ciphertext, credentials.iv);
      });
      // The existing watch protocol belongs to Main, independently of child grants.
      await runInDurableObject(workspace, (_instance, state) => {
        state.storage.sql.exec("UPDATE resources SET connection_id=? WHERE id=?", connectorId, unrelatedResource);
      });
      const watchMain = () => app.request(`/resources/${unrelatedResource}/watch`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ workstreamId: WORKSTREAM_ID }),
      }, apiEnv);
      const unwatchMain = () => app.request(`/resources/${unrelatedResource}/watch?workstreamId=${WORKSTREAM_ID}`, {
        method: "DELETE", headers,
      }, apiEnv);
      expect((await watchMain()).status).toBe(404);
      expect((await unwatchMain()).status).toBe(404);
      const connectorEnv = withWorkspaceRuntimeDatabase({ ...TEST_ENV, CONNECTOR_CREDENTIALS_KEY: credentialKey,
        CONNECTOR_CREDENTIALS_KEY_VERSION: "1", GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "fixture-client",
        GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "fixture-secret", PUBLIC_API_BASE_URL: "https://api.example.test" }, WORKSPACE_ID);
      const frozen = { pluginId: `connection:${connectorId}`, modelPluginId: "guest_google", connectionId: connectorId,
        workspaceId: WORKSPACE_ID, connectorType: "google", scope: "workspace" as const, ownerUserId: null,
        grantedScopes: ["docs.write"], toolCapabilities: ["docs.write"], shortWireName: "google" };
      const providerCalls: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (request) => {
        const url = request instanceof Request ? request.url : String(request);
        providerCalls.push(url);
        if (url === "https://docs.googleapis.com/v1/documents") {
          return Response.json({ documentId: "guest-created-document", title: "Shared draft" });
        }
        if (url === "https://oauth2.googleapis.com/token") {
          // Revocation during refresh lands after this call's authorization
          // boundary. The call can finish; the next call must be refused.
          expect(await parent.removePrivateChildParticipant({ ...participantRequest, operationId: "child-participant-remove" }))
            .toMatchObject({ outcome: "removed" });
          return Response.json({ access_token: "refreshed-fixture-access", expires_in: 3600, token_type: "Bearer" });
        }
        throw new Error(`Unexpected guest provider call: ${url}`);
      };
      try {
        const executeWrite = async () => {
          const row = await __integrationTesting.assertFrozenConnectionAuthorized(
            connectorEnv, guestToolInput, frozen, "docs.write",
          );
          return __integrationTesting.executeAuthorizedConnectorTool(connectorEnv, guestToolInput,
            frozen, "docs.create_document", "docs.write", { title: "Shared draft" }, new AbortController().signal,
            undefined, undefined, undefined, { frozen, capability: "docs.write", row });
        };
        expect(await executeWrite()).toMatchObject({ output: { documentId: "guest-created-document" } });
        expect(providerCalls).toEqual(["https://docs.googleapis.com/v1/documents"]);
        const expired = await encryptString(JSON.stringify({ ...freshCredentials, expiresAt: "2000-01-01T00:00:00.000Z" }), credentialKey, connectorId);
        await runInDurableObject(workspace, (_instance, state) => {
          state.storage.sql.exec("UPDATE connector_connections SET encrypted_credentials=?,credential_iv=? WHERE id=?", expired.ciphertext, expired.iv, connectorId);
        });
        await expect(executeWrite()).resolves.toMatchObject({ output: { documentId: "guest-created-document" } });
        expect(providerCalls).toEqual([
          "https://docs.googleapis.com/v1/documents",
          "https://oauth2.googleapis.com/token",
          "https://docs.googleapis.com/v1/documents",
        ]);
        await expect(executeWrite()).rejects.toThrow("Shared conversation access has ended");
      } finally {
        globalThis.fetch = originalFetch;
      }
      const removed = await parent.removePrivateChildParticipant({ ...participantRequest,operationId:"child-participant-remove" });
      expect(removed.outcome).toBe("removed");
      expect((await childClosed).code).toBe(1008);
      await expect(__integrationTesting.assertRunAuthorityStillValid(TEST_ENV, guestToolInput))
        .rejects.toThrow("Shared conversation access has ended");
      const overlappingDownload = await app.request(`/resources/${sharedResource}/versions/2/model-content`, { headers }, apiEnv);
      expect(overlappingDownload.status).toBe(200);
      expect(await overlappingDownload.text()).toBe("Shared extracted text");
      expect(await artifactHost.checkSession(artifactSession!.session)).toMatchObject({ ok: true });
      await withParentGrants(parent, address, (store) => {
        const target = { kind: "conversation" as const, ...secondAddress };
        expect(store.mutate({ operationId: crypto.randomUUID(), actorUserId: OTHER_USER_ID, userId: USER_ID,
          target, active: false, expectedRevision: store.read(USER_ID, target)!.revision }, "existing-member"))
          .toMatchObject({ status: "committed" });
      });
      expect((await authorizer.checkMany(subject,[resourceAccess(sharedResource)]))[0]?.status).not.toBe("allowed");
      expect((await app.request(`/resources/${sharedResource}/content`,{ headers },apiEnv)).status).not.toBe(200);
      // This fixture has no completed workspace-wide location inventory. Once
      // its only positive source is revoked, reads fail closed as unavailable.
      for (const suffix of versionPaths) {
        const revoked = await app.request(`/resources/${sharedResource}${suffix}`, { headers }, apiEnv);
        expect(revoked.status, suffix).toBe(503);
        expect(await revoked.json()).toMatchObject({ error: { code: "authorization_unavailable" } });
      }


      await expect(artifactService.open(sharedResource)).rejects.toThrow("Authorization could not be established");
      // A viewer session is an admitted capability: resource-scope changes do
      // not put canonical authorization back in front of every artifact asset.
      // It remains valid until explicit revocation or fixed expiry.
      expect(await artifactHost.checkSession(artifactSession!.session)).toMatchObject({ ok: true, viewerId: USER_ID });

      expect((await app.request(path,{ headers },apiEnv)).status).toBe(404);
      expect((await app.request(path, { method: "PATCH",
        headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ archived: true }),
      }, apiEnv)).status).toBe(404);
      expect((await app.request(`${path}/participants/remove`, { method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ userId: OTHER_USER_ID, operationId: crypto.randomUUID() }),
      }, apiEnv)).status).toBe(404);
      await expect(async () => await parent.setPrivateChildArchived({ ...address,
        actorUserId: USER_ID, archived: true })).rejects.toThrow("private_child_participant_required");
      await runInDurableObject(parent, (_instance, state) => {
        expect(state.storage.sql.exec<{ archived_at: number | null }>(
          "SELECT archived_at FROM parent_children WHERE parent_id=? AND substream_id=?", WORKSTREAM_ID, substreamId).one().archived_at).toBeNull();
      });
      expect((await app.request(`${path}/socket`,{ headers },apiEnv)).status).toBe(404);
      expect((await app.request(`${path}/recommended-sidekicks`,{ headers },apiEnv)).status).toBe(404);
      expect((await app.request(`${path}/sidekicks`,{ headers },apiEnv)).status).toBe(404);
      expect((await attach(uploadId)).status).toBe(404);
      childSocket.socket.close(1000,"done");
      expect(await parent.addPrivateChildParticipant(participantRequest)).toEqual(added);
      await withParentGrants(parent, address, (store,state) => {
        expect(store.read(USER_ID,{ kind:"conversation",...address }))
          .toMatchObject({ active:false,revision:removed.membershipVersion });
        // The legacy authority stays frozen at its pre-migration fact.
        expect(state.storage.sql.exec("SELECT version,active FROM parent_breakout_members WHERE parent_id=? AND substream_id=? AND user_id=?",WORKSTREAM_ID,substreamId,USER_ID).one())
          .toEqual({ version:3,active:0 });
      });
      expect(await parent.mutateParticipantGrant({ operationId:crypto.randomUUID(),actorUserId:OTHER_USER_ID,userId:OTHER_USER_ID,
        target:{ kind:"conversation",...address },active:false })).toEqual({ status:"denied",reason:"participant_required" });

      const mainTarget = { kind: "conversation" as const, workspaceId: WORKSPACE_ID,
        parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0") };
      await withParentGrants(parent, address, (store, state) => {
        state.storage.sql.exec("INSERT INTO parent_participant_migrations (parent_id,substream_id,transfer_id,incarnations_json,phase) VALUES (?, '0', ?, '{}', 'complete')", WORKSTREAM_ID, crypto.randomUUID());
        state.storage.sql.exec("INSERT OR IGNORE INTO parent_children (parent_id,substream_id,kind,status,created_by_user_id,created_at) VALUES (?,'0','main','ready',?,0)", WORKSTREAM_ID, OTHER_USER_ID);
        expect(store.mutate({ operationId: crypto.randomUUID(), actorUserId: OTHER_USER_ID,
          userId: USER_ID, target: mainTarget, active: true, expectedRevision: 0 }, "existing-member"))
          .toMatchObject({ status: "committed" });
      });
      const watched = await watchMain();
      expect(watched.status, await watched.clone().text()).toBe(200);
      expect(await watched.json()).toEqual({ watchEnabled: true });
      expect(await runInDurableObject(main, (_instance, state) => state.storage.sql.exec(
        "SELECT watch_enabled FROM workstream_resource_links WHERE resource_id=?", unrelatedResource).one()))
        .toEqual({ watch_enabled: 1 });
      expect(await runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec(
        "SELECT enabled FROM resource_watches WHERE workstream_id=? AND resource_id=?", WORKSTREAM_ID, unrelatedResource).one()))
        .toEqual({ enabled: 1 });
      expect((await unwatchMain()).status).toBe(204);
      expect(await runInDurableObject(main, (_instance, state) => state.storage.sql.exec(
        "SELECT watch_enabled FROM workstream_resource_links WHERE resource_id=?", unrelatedResource).one()))
        .toEqual({ watch_enabled: 0 });
      expect(await runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec(
        "SELECT enabled FROM resource_watches WHERE workstream_id=? AND resource_id=?", WORKSTREAM_ID, unrelatedResource).one()))
        .toEqual({ enabled: 0 });
    });

    it("prepares inheriting child authority before accepting a whole-workstream invitation", async () => {
      const main = agentStub();
      const opened = await initializeWorkstream(main, "first message");
      await settledRun(main, opened.body.harnessRunId as string);
      const substreamId = asSubstreamId(crypto.randomUUID());
      const child = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, substreamId));
      expect((await child.bootstrapRuntime({ workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID,
        substreamId, generation: 1 })).status).toBe(200);
      expect((await child.executeIdentityOperation({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, substreamId,
        operation: "provision", args: [{ title: "Inherited child", objective: "Sharing test", scope: "personal",
          originType: "ad_hoc", createdByUserId: USER_ID, participantUserIds: [], harnessStatus: "idle", emailAddress: null,
          emailRouteStatus: null, systemKind: null, automationRunId: null, plannedFor: null, modelOverride: null, now: Date.now() }] })).status).toBe(200);
      const parent = hostedParentStub(env, WORKSPACE_ID);
      await parent.authority({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID });
      await runInDurableObject(parent, (_instance, state) => {
        state.storage.sql.exec(`INSERT OR IGNORE INTO parent_metadata
          (parent_id,parent_kind,workspace_id,region,authority_generation,created_at,updated_at)
          VALUES (?,'workstream',?,'global',1,0,0)`, WORKSTREAM_ID, WORKSPACE_ID);
        state.storage.sql.exec("INSERT OR IGNORE INTO parent_children(parent_id,substream_id,kind,created_at) VALUES (?,'0','main',0)", WORKSTREAM_ID);
        state.storage.sql.exec("INSERT INTO parent_children(parent_id,substream_id,kind,created_at,audience) VALUES (?,?,'child',0,'inherits_workstream')", WORKSTREAM_ID, substreamId);
      });
      expect(await parent.createScopeInvitations({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, actorUserId: USER_ID,
        operationId: crypto.randomUUID(), emails: ["guest@example.test"], expiresAt: null,
        targets: [{ kind: "workstream", workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID }] })).toMatchObject({ status: "created" });
      await withParentGrants(parent, { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID }, (store, state) => {
        expect(state.storage.sql.exec("SELECT phase FROM parent_participant_migrations WHERE parent_id=? AND substream_id=?", WORKSTREAM_ID, substreamId).one())
          .toEqual({ phase: "complete" });
        expect(store.participantProjection(substreamId, USER_ID)?.active).toBe(true);
      });
      await runInDurableObject(child, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT phase FROM participant_authority_transfer").one()).toEqual({ phase: "projection" });
      });
    });

    it.each(["self", "mention", "queued", "controls"] as const)("prepares legacy Main sharing and handles %s participation through grants", async (participation) => {
      const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID));
      const opened = await initializeWorkstream(stub, "first message");
      await settledRun(stub, opened.body.harnessRunId as string);
      const parent = hostedParentStub(env, WORKSPACE_ID);
      await parent.authority({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID });
      await runInDurableObject(parent, (_instance, state) => {
        state.storage.sql.exec(`INSERT OR IGNORE INTO parent_metadata
          (parent_id,parent_kind,workspace_id,region,authority_generation,created_at,updated_at)
          VALUES (?,'workstream',?,'global',1,0,0)`, WORKSTREAM_ID, WORKSPACE_ID);
        // An open Channel, which is what lets a member join Main by speaking.
        insertChannelRow(state, WORKSTREAM_ID, "Sharing test", "workspace");
        if (participation !== "controls") state.storage.sql.exec("INSERT OR IGNORE INTO parent_children(parent_id,substream_id,kind,created_at) VALUES (?,'0','main',0)", WORKSTREAM_ID);
      });
      const request = { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, actorUserId: OTHER_USER_ID,
        operationId: crypto.randomUUID(), emails: ["guest@example.test"], expiresAt: null,
        targets: [{ kind: "conversation" as const, workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0") }] };
      expect(await parent.createScopeInvitations(request)).toMatchObject({ status: "denied" });
      expect(await parent.scopeSharingOptions({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, actorUserId: OTHER_USER_ID }))
        .toEqual({ scopes: [], completeWorkstreamTargets: null });
      const options = await parent.scopeSharingOptions({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, actorUserId: USER_ID });
      expect(options.completeWorkstreamTargets).toEqual([
        { kind: "workstream", workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID },
      ]);
      expect(options.scopes).toContainEqual({ target:request.targets[0],title:"Main" });
      if (participation === "controls") await runInDurableObject(parent,(_instance,state) => {
        expect(state.storage.sql.exec("SELECT 1 FROM parent_children WHERE parent_id=? AND substream_id='0'", WORKSTREAM_ID).toArray()).toEqual([]);
      });
      await runInDurableObject(parent, (_instance, state) => {
        // Discovering first-share choices never transfers the source authority.
        expect(state.storage.sql.exec("SELECT 1 FROM parent_participant_migrations WHERE parent_id=? AND substream_id='0'", WORKSTREAM_ID).toArray()).toEqual([]);
      });
      let queuedTurnId: string | null = null;
      if (participation === "queued") {
        await runInDurableObject(stub, (_instance, state) => holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) }));
        const queued = await product(stub, { operation: "create_message", auth: AUTH, input: {
          text: "Hello @Other Member", clientMessageId: "before-handoff-mention", forcedHarnessOrigin: "user_message",
          attachmentIds: [], confirmedParticipantUserIds: [OTHER_USER_ID],
          mentions: [{ type: "person", userId: OTHER_USER_ID, connectorType: null, startOffset: 6, endOffset: 19 }],
        } });
        expect(queued).toMatchObject({ status: 200, body: { deliveryState: "pending" } });
        queuedTurnId = (queued.body.turn as { turnId: string }).turnId;
      }
      const created = await parent.createScopeInvitations({ ...request, actorUserId: USER_ID });
      expect(created).toMatchObject({ status: "created", invitations: [{ email: "guest@example.test" }] });
      expect(await parent.createScopeInvitations({ ...request, actorUserId: USER_ID })).toEqual(created);
      expect(await parent.beginMainParticipantMigration({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID }))
        .toMatchObject({ status: "complete" });
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT phase FROM participant_authority_transfer").one()).toEqual({ phase: "projection" });
      });
      expect(await parent.readScopeAccess({ userId: USER_ID, target: request.targets[0]! }))
        .toMatchObject({ allowed: true, writable: true });
      // Joining an already inherited audience must not create an independent
      // grant that survives removal of the parent grant.
      expect(await parent.joinConversation({ operationId: crypto.randomUUID(), actorUserId: USER_ID,
        userId: USER_ID, target: request.targets[0]!, active: true })).toEqual({ status: "ready" });
      await withParentGrants(parent, request, (store) => {
        expect(store.forUser(USER_ID))
          .toMatchObject([{ target: { kind: "workstream" } }]);
      });
      if (queuedTurnId !== null) {
        await runInDurableObject(stub, (_instance, state) => releaseHeldLoop(state));
        const run = await settledRunForTrigger(stub, queuedTurnId);
        expect(PRE_PROVIDER_FAILURES).not.toContain(failureCode(run));
        await runInDurableObject(stub, (_instance, state) => {
          expect(state.storage.sql.exec("SELECT 1 FROM participants WHERE user_id=? AND status='active'", OTHER_USER_ID).toArray()).toEqual([]);
        });
        await withParentGrants(parent, request, (store) => {
          expect(store.forUser(OTHER_USER_ID)).toEqual([]);
        });
        return;
      }
      if (participation === "self") {
        expect(await product(stub, { operation: "update", auth: AUTH, input: { scope: "workspace" } }))
          .toMatchObject({ status: 200 });
      }
      const otherSessionId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO sessions (id,user_id,workspace_id,region,expires_at)
        VALUES (?,?,?,'global','2099-01-01T00:00:00.000Z')`).bind(otherSessionId,OTHER_USER_ID,WORKSPACE_ID).run();
      if (participation === "controls") {
        await env.DB.prepare("UPDATE workspace_members SET access_class='guest',role=NULL WHERE user_id=?").bind(OTHER_USER_ID).run();
        expect(await parent.mutateParticipantGrant({ operationId:crypto.randomUUID(),actorUserId:USER_ID,
          userId:OTHER_USER_ID,target:request.targets[0]!,active:true })).toMatchObject({ status:"committed" });
        const recipientId = asUserId(crypto.randomUUID());
        await env.DB.batch([
          env.DB.prepare("INSERT INTO users(id,email,name,timezone,created_at) VALUES (?,'recipient@example.test','Recipient','UTC','2026-01-01T00:00:00.000Z')").bind(recipientId),
          env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,access_class,role) VALUES (?,?,'active','guest',NULL)")
            .bind(WORKSPACE_ID,recipientId),
        ]);
        await env.DB.prepare("ALTER TABLE users ADD COLUMN analytics_person_id TEXT").run();
        const signingKey = "guest-main-rename-signing-key";
        const mainToken = await new SignJWT({ sid: otherSessionId, wid: WORKSPACE_ID, region: "global" })
          .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(OTHER_USER_ID).setIssuer("avalon-api")
          .setAudience("avalon-desktop").setIssuedAt().setExpirationTime("15m").sign(new TextEncoder().encode(signingKey));
        const apiEnv = { ...TEST_ENV, SESSION_SIGNING_KEY: signingKey, RALLY_DEV_AUTH: "false" };
        const mainHeaders = { authorization: `Bearer ${mainToken}`, "content-type": "application/json" };
        const app = createApp();
        const mainPath = `/conversations/${WORKSTREAM_ID}/substreams/0`;
        expect((await app.request(mainPath, { method: "PATCH", headers: mainHeaders,
          body: JSON.stringify({ title: "Main renamed by a guest" }) }, apiEnv)).status).toBe(204);
        await runInDurableObject(stub, (_instance, state) => {
          expect(state.storage.sql.exec("SELECT title FROM workstream WHERE id=1").one().title).toBe("Main renamed by a guest");
        });
        const guestAuth = { ...AUTH,userId:OTHER_USER_ID,sessionId:otherSessionId,role:null };

        const add = { operation:"add_participant",auth:guestAuth,userId:recipientId,operationId:crypto.randomUUID() };
        expect(await product(stub,add)).toMatchObject({ status:200 });
        await withParentGrants(parent, request, (store) => {
          expect(store.forUser(recipientId))
            .toMatchObject([{ active:true,target:{ kind:"conversation",substreamId:"0" } }]);
        });
        const parentTarget = { kind:"workstream" as const,workspaceId:WORKSPACE_ID,parentId:WORKSTREAM_ID };
        const inherited = await parent.mutateScopeGrant({ operationId:crypto.randomUUID(),actorUserId:USER_ID,
          userId:recipientId,target:parentTarget,active:true,expectedRevision:0 });
        if (inherited.status !== "committed") throw new Error("Expected parent grant");
        const remove = { operation:"remove_participant",auth:guestAuth,userId:recipientId,operationId:crypto.randomUUID() };
        expect(await product(stub,remove)).toMatchObject({ status:409,body:{ error:"participant_inherited_access" } });
        await withParentGrants(parent, request, (store) => {
          expect(store.forUser(recipientId).every((grant) => grant.active)).toBe(true);
        });
        expect(await parent.mutateScopeGrant({ operationId:crypto.randomUUID(),actorUserId:USER_ID,
          userId:recipientId,target:parentTarget,active:false,expectedRevision:inherited.grant.revision }))
          .toMatchObject({ status:"committed" });
        expect(await product(stub,remove)).toMatchObject({ status:200 });
        expect(await product(stub,remove)).toMatchObject({ status:200 });
        expect(await product(stub,{ ...add,operationId:crypto.randomUUID() })).toMatchObject({ status:200 });
        expect(await product(stub,remove)).toMatchObject({ status:409,body:{ error:"participant_change_superseded" } });
        expect(await parent.readScopeAccess({ userId:recipientId,target:request.targets[0]! })).toMatchObject({ allowed:true });
        expect(await parent.readScopeAccess({ userId:OTHER_USER_ID,target:parentTarget })).toMatchObject({ allowed:false });
        return;
      }
      const message = { operation: "create_message", auth: participation === "self" ? { ...AUTH, userId: OTHER_USER_ID, sessionId: otherSessionId } : AUTH,
        input: { text: participation === "self" ? "Joining the discussion" : "Hello @Other Member",
          clientMessageId: `after-handoff-${participation}`, attachmentIds: [], forcedHarnessOrigin: "user_message",
          mentions: participation === "self" ? [] : [{ type: "person", userId: OTHER_USER_ID,
            connectorType: null, startOffset: 6, endOffset: 19 }],
          confirmedParticipantUserIds: participation === "self" ? [] : [OTHER_USER_ID] } };
      const { socket } = await openSubscribedSocket(stub, crypto.randomUUID());
      const live = collectSocketFrames(socket);
      try {
        expect(await product(stub, message)).toMatchObject({ status: 200 });
        expect(await product(stub, message)).toMatchObject({ status: 200 });
        await expect.poll(() => live.frames.filter((frame) => frame.type === "participant_added"))
          .toMatchObject([{ participant: { user: { id: OTHER_USER_ID } } }]);
      } finally {
        live.stop();
        socket.close(1000, "test complete");
      }
      await withParentGrants(parent, request, (store) => {
        expect(store.forUser(OTHER_USER_ID))
          .toMatchObject([{ active: true, target: { kind: "conversation", substreamId: "0" } }]);
      });
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec("SELECT status FROM participants WHERE user_id=?", OTHER_USER_ID).one())
          .toEqual({ status: "active" });
      });
    });

    it("delivers a canonical grant revocation through the parent alarm to the real feed socket", async () => {
      const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID));
      const opened = await initializeWorkstream(stub, "first message", null, [OTHER_USER_ID]);
      await settledRun(stub, opened.body.harnessRunId as string);
      const parent = hostedParentStub(env, WORKSPACE_ID);
      await parent.authority({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID });
      const target = { kind: "workstream" as const, workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID };
      await runInDurableObject(parent, (_instance,state) => {
        state.storage.sql.exec(`INSERT OR IGNORE INTO parent_metadata
          (parent_id,parent_kind,workspace_id,region,authority_generation,created_at,updated_at)
          VALUES (?,'workstream',?,'global',1,0,0)`, WORKSTREAM_ID,WORKSPACE_ID);
        state.storage.sql.exec("INSERT OR IGNORE INTO parent_children(parent_id,substream_id,kind,created_at) VALUES (?,'0','main',0)", WORKSTREAM_ID);
        state.storage.sql.exec(`CREATE TRIGGER fail_migration_completion BEFORE UPDATE OF phase ON parent_participant_migrations
          WHEN NEW.phase='complete' AND NEW.substream_id='0' BEGIN SELECT RAISE(ABORT, 'migration completion unavailable'); END`);
      });
      const migration = await parent.beginMainParticipantMigration({ workspaceId: WORKSPACE_ID,parentId: WORKSTREAM_ID });
      expect(migration.status).toBe("pending");
      if (!migration.transferId) throw new Error("Expected transfer token");
      await runDurableObjectAlarm(parent);
      await expect.poll(() => runInDurableObject(parent, (_instance,state) =>
        state.storage.sql.exec<{ attempt: number }>(
          "SELECT attempt FROM _internal_durable_alarms WHERE kind='parent_participant_migration'",
        ).toArray()[0]?.attempt ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
      // Failure after source commit must retain the same token and frozen
      // snapshot, and must not admit grant writes during the incomplete handoff.
      expect(await parent.beginMainParticipantMigration({ workspaceId: WORKSPACE_ID,parentId: WORKSTREAM_ID })).toEqual(migration);
      expect(await parent.mutateScopeGrant({ operationId: crypto.randomUUID(),target,
        actorUserId: OTHER_USER_ID,userId: USER_ID,active:false,expectedRevision: 0 }))
        .toEqual({ status:"denied",reason:"migration_pending" });
      await runInDurableObject(stub, (_instance,state) => {
        expect(state.storage.sql.exec("SELECT transfer_id,phase FROM participant_authority_transfer").one())
          .toEqual({ transfer_id: migration.transferId,phase:"projection" });
      });
      expect(await stub.transferParticipantAuthority({ workspaceId: asWorkspaceId(crypto.randomUUID()),
        parentId: WORKSTREAM_ID,substreamId: asSubstreamId("0"),transferId: migration.transferId,phase:"prepare" })).toEqual({ status:"identity_mismatch" });
      expect(await stub.transferParticipantAuthority({ workspaceId: WORKSPACE_ID,
        parentId: WORKSTREAM_ID,substreamId: asSubstreamId("0"),transferId: crypto.randomUUID(),phase:"commit" })).toEqual({ status:"conflict" });
      const priorRevision = await withParentGrants(parent, target, async (store,state) => {
        state.storage.sql.exec("DROP TRIGGER fail_migration_completion");
        // Advance the failed entry's retry gate explicitly, without timing the
        // test against the production scheduler's backoff interval.
        state.storage.sql.exec("UPDATE _internal_durable_alarms SET retry_at=0 WHERE kind='parent_participant_migration'");
        const revision = store.read(USER_ID,target)!.revision;
        await state.storage.setAlarm(Date.now());
        return revision;
      });
      await runDurableObjectAlarm(parent);
      // setAlarm can start the real alarm before runDurableObjectAlarm sees it;
      // wait for its durable completion, not the helper's observation window.
      await expect.poll(() => parent.beginMainParticipantMigration({ workspaceId: WORKSPACE_ID,parentId: WORKSTREAM_ID }),
        { timeout: 30_000 }).toEqual({ status:"complete",transferId:migration.transferId });
      await runDurableObjectAlarm(parent);
      const admission = await parent.authorizeViewer({ workspaceId:WORKSPACE_ID,parentId:WORKSTREAM_ID,userId:USER_ID,substreamId:asSubstreamId("0") });
      expect(admission.authorized).toBe(true);
      expect(admission.membershipVersion).toBeGreaterThan(0);
      const { socket } = await openSubscribedSocket(stub,crypto.randomUUID(),"0",admission.membershipVersion);
      const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close",resolve,{ once:true }));
      try {
        const result = await parent.mutateScopeGrant({ operationId: crypto.randomUUID(), target,
          actorUserId: OTHER_USER_ID, userId: USER_ID, active:false, expectedRevision: priorRevision });
        expect(result.status).toBe("committed");
        if (result.status !== "committed") throw new Error("Expected revocation");
        await runDurableObjectAlarm(parent);
        expect((await closed).code).toBe(1008);
        // Version zero is reserved for parent-authorized implicit Main readers.
        // A formerly admitted positive grant revision must fail after revocation.
        const stale = await stub.fetch("https://substream.test/socket",{ headers:{
          Upgrade:"websocket","x-rally-workspace-id":WORKSPACE_ID,"x-rally-workstream-id":WORKSTREAM_ID,
          "x-rally-substream-id":"0","x-rally-user-id":USER_ID,"x-rally-session-id":SESSION_ID,
          "x-rally-socket-ticket-id":crypto.randomUUID(),
          "x-rally-socket-ticket-expires-at":String(Math.floor(Date.now()/1000)+60),
          "x-rally-socket-admission-membership-version":String(admission.membershipVersion),
        } });
        if (stale.webSocket) { stale.webSocket.accept();stale.webSocket.close(1000,"unexpected admission"); }
        expect(stale.status).toBe(403);
        await withParentGrants(parent, target, (store) => {
          expect(store.pendingParticipantProjection("0",USER_ID,result.grant.revision)).toBeNull();
        });
        await runInDurableObject(stub, (_instance,state) => {
          expect(new ParticipantAuthorityTransferStorage(state.storage).projectionForUser(USER_ID))
            .toMatchObject({ active:false, revision: result.grant.revision });
        });
      } finally { socket.close(1000,"done"); }
      const otherSessionId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO sessions (id,user_id,workspace_id,region,revoked_at,expires_at)
        VALUES (?,?,?,'global',NULL,'2099-01-01T00:00:00.000Z')`).bind(otherSessionId,OTHER_USER_ID,WORKSPACE_ID).run();
      const add = { operation: "add_participant", auth: { ...AUTH, userId: OTHER_USER_ID, sessionId: otherSessionId },
        userId: USER_ID, operationId: crypto.randomUUID() };
      const added = await product(stub, add);
      expect(added).toMatchObject({ status: 200 });
      expect(added.body).toMatchObject({ user: { id: USER_ID } });
      expect((await product(stub, add)).status).toBe(200);
      const remove = { ...add, operation: "remove_participant", operationId: crypto.randomUUID() };
      expect(await product(stub, remove)).toEqual({ status: 200, body: { ok: true } });
      expect(await product(stub, remove)).toEqual({ status: 200, body: { ok: true } });
      expect((await product(stub, add)).status).toBe(409);
      await withParentGrants(parent, target, (store) => {
        expect(store.read(USER_ID,target)?.active).toBe(false);
      });
      await runInDurableObject(stub, (_instance,state) => {
        expect(state.storage.sql.exec("SELECT status FROM participants WHERE user_id=?",USER_ID).one().status).toBe("removed");
      });
      expect((await product(stub, { ...remove, userId: OTHER_USER_ID, operationId: crypto.randomUUID() })).status).toBe(409);
    });

    it("applies a participant projection with durable effects and closes the removed reader socket", async () => {
      const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID));
      const opened = await initializeWorkstream(stub, "first message");
      await settledRun(stub, opened.body.harnessRunId as string);
      const { socket } = await openSubscribedSocket(stub, crypto.randomUUID());
      const transferId = crypto.randomUUID();
      const before = await runInDurableObject(stub, (_instance, state) => {
        const store = new ParticipantAuthorityTransferStorage(state.storage);
        store.prepare(transferId);
        store.commit(transferId);
        return state.storage.sql.exec<{ version: number }>(
          "SELECT COALESCE(MAX(source_version),0) AS version FROM durable_outbox WHERE partition_key=?", `user:${USER_ID}`,
        ).one().version;
      });
      const request = { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: "0",
        projection: { transferId, userId: USER_ID, revision: 1, active: false,
          reason: "explicit" as const, addedByUserId: OTHER_USER_ID, changedAt: Date.now() } };
      const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
      try {
        expect(await stub.applyParticipantProjection(request)).toEqual({ status: "applied" });
        expect((await closed).code).toBe(1008);
        expect(await stub.applyParticipantProjection(request)).toEqual({ status: "unchanged" });
        await runInDurableObject(stub, (_instance, state) => {
          expect(state.storage.sql.exec("SELECT status FROM participants WHERE user_id=?", USER_ID).one().status).toBe("removed");
          expect(state.storage.sql.exec<{ version: number }>(
            "SELECT MAX(source_version) AS version FROM durable_outbox WHERE partition_key=?", `user:${USER_ID}`,
          ).one().version).toBe(before + 1);
          expect(state.storage.sql.exec("SELECT revision FROM participant_projection_revisions WHERE user_id=?", USER_ID).one().revision).toBe(1);
        });
        expect(await stub.applyParticipantProjection({ ...request,
          projection: { ...request.projection, revision: 3, active: true } })).toEqual({ status: "applied" });
        const reopened = await openSubscribedSocket(stub, crypto.randomUUID(), "0", 3);
        try {
          expect(await stub.applyParticipantProjection({ ...request,
            projection: { ...request.projection, revision: 2 } })).toEqual({ status: "stale" });
          expect(await runInDurableObject(stub, (_instance, state) =>
            state.getWebSockets().filter((server) => server.readyState === WebSocket.OPEN).length)).toBe(1);
        } finally { reopened.socket.close(1000, "done"); }
      } finally { socket.close(1000, "done"); }
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

  it("leaves a Breakout's newest message unread only for somebody another person adds", async () => {
    const substreamId = asSubstreamId("00000000-0000-7000-8000-0000000005d3");
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, substreamId),
    ));
    const child = stub as unknown as {
      bootstrapRuntime(input: Record<string, unknown>): Promise<{ status: number }>;
      executeIdentityOperation(input: Record<string, unknown>): Promise<{ status: number }>;
    };
    expect((await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID, substreamId, generation: 1,
    })).status).toBe(200);
    expect((await child.executeIdentityOperation({
      workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, substreamId, operation: "provision",
      args: [{
        title: "Private Breakout", objective: "Hold history before anybody joins.", scope: "workspace",
        originType: "ad_hoc", createdByUserId: USER_ID, participantUserIds: [USER_ID], harnessStatus: "idle",
        emailAddress: null, emailRouteStatus: null, systemKind: null, automationRunId: null,
        plannedFor: null, modelOverride: null, now: Date.now(),
      }],
    })).status).toBe(200);
    // Four messages with attention ordinals 1 to 4.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE workstream SET next_attention_ordinal = 5 WHERE id = 1");
    });
    const membership = { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId, userId: OTHER_USER_ID };
    const seen = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ seen: number }>(
      "SELECT seen_attention_ordinal AS seen FROM member_attention WHERE user_id = ?", OTHER_USER_ID,
    ).one().seen);

    await stub.applyPrivateChildMembership({ ...membership, actorUserId: USER_ID, active: true, membershipVersion: 1 });
    expect(await seen()).toBe(3);
    await stub.applyPrivateChildMembership({ ...membership, actorUserId: USER_ID, active: false, membershipVersion: 2 });
    await stub.applyPrivateChildMembership({ ...membership, actorUserId: OTHER_USER_ID, active: true, membershipVersion: 3 });
    expect(await seen()).toBe(4);
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
      error: { code: expect.stringContaining("payload.text:invalid_type") },
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
      error: { code: expect.stringContaining("elicitationId:invalid_type") },
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
    // A stored-contract defect remains a server error, with the declared field
    // preserved in both the command receipt and the log. A `ZodError`'s
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
        error: { status: 500, code: "substream_command_invalid:reason:invalid_type" },
      });
      const entry = (await runInDurableObject(stub, () => structuredClone(
        (globalThis as WarnCaptureScope).__rallyWarnLog ?? [],
      )) as Record<string, unknown>[])
        .find((call) => call.event === "substream_socket_command_failed");
      expect(entry).toMatchObject({
        command: "retry_harness",
        operation_id: operationId,
        // A code that groups, rather than one run's JSON blob.
        reason: "substream_command_invalid:reason:invalid_type",
        validation_issues: "reason:invalid_type",
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
    it("persists shared icon patches, drops a client's colour, and does not replay an old choice", async () => {
      const stub = agentStub();
      const opened = await initializeWorkstream(stub, "first message");
      await settledRun(stub, opened.body.harnessRunId as string);
      const { socket } = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000006c0");
      const choose = async (operationId: string, appearance: Record<string, string>) => {
        const receipt = nextSocketCommandOutcome(socket);
        socket.send(JSON.stringify({ type: "set_workstream_appearance", operationId, appearance }));
        expect(await receipt).toMatchObject({ type: "client_command_succeeded", command: "set_workstream_appearance", operationId });
      };
      await choose("00000000-0000-7000-8000-0000000006c1", { icon: "heart" });
      await choose("00000000-0000-7000-8000-0000000006c2", { icon: "rocket" });
      // A thread's colour is its Channel's, written by the server alone
      // (channel-color-sync.ts): the command succeeds and the colour is dropped.
      await choose("00000000-0000-7000-8000-0000000006c3", { icon: "rocket", color: "purple" });
      await choose("00000000-0000-7000-8000-0000000006c1", { icon: "heart" });
      await deliverEffectsToWorkspaceInOrder(env, stub);
      const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
      const page = await workspace.listWorkstreams({ workspaceId: WORKSPACE_ID, userId: USER_ID, limit: 20, includeSystem: false });
      expect(page.items.find((item) => item.id === WORKSTREAM_ID)?.appearance).toEqual({ icon: "rocket", color: null });
      const service = new WorkstreamService({ ...TEST_ENV, SESSION_SIGNING_KEY: "appearance-test-signing-key", PUBLIC_API_BASE_URL: "https://api.rally.test" }, AUTH);
      const ticket = await service.workstreamControlSocketTicket(WORKSTREAM_ID);
      expect(new URL(ticket.url).search).toBe("");
      socket.close(1000, "done");
      await evictDurableObject(stub);
      const reopened = await openSubscribedSocket(stub, "00000000-0000-7000-8000-0000000006c4");
      expect(reopened.initial).toMatchObject({ workstream: { appearance: { icon: "rocket", color: null } } });
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
      },
    }));

    expect(await receipt).toMatchObject({
      type: "client_command_succeeded",
      command: "create_message",
      clientMessageId: "pipeline-room-socket-wakeup-1",
      deliveryState: "pending",
    });
    // Admission arms alarm recovery before committing the pending row. That
    // alarm may legally promote it while the socket receipt is in flight, so
    // prove exactly one durable owner rather than racing that promotion.
    expect(await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM (
           SELECT input_id FROM pending_loop_inputs
            WHERE client_message_id = 'pipeline-room-socket-wakeup-1'
           UNION ALL
           SELECT delivered.input_id
             FROM delivered_loop_inputs delivered
             JOIN canonical_conversation_turn_details turn
               ON turn.id = delivered.delivered_turn_id
            WHERE turn.client_message_id = 'pipeline-room-socket-wakeup-1'
         )`,
      ).one().count)).toBe(1);
    socket.close(1000, "done");
  });

  it("uses a cached product session until revocation reaches the room, then refuses writes", async () => {
    const stub = agentStub();
    await initializeWorkstream(stub, "first message");
    await env.DB.prepare(
      `UPDATE sessions SET revoked_at = '2026-08-18T00:00:00.000Z' WHERE id = ?`,
    ).bind(SESSION_ID).run();

    const attempt = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "already admitted",
        clientMessageId: "pipeline-revoked-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });

    expect(attempt.status).toBe(200);
    await stub.revokeSocketAccess({
      reason: "session_revoked",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const denied = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "should not land",
        clientMessageId: "pipeline-revoked-2",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });
    expect(denied.status).toBe(401);
  });

  it("refreshes cached product admission when the Worker presents a changed member role", async () => {
    const stub = agentStub();
    await initializeWorkstream(stub, "first message");
    await env.DB.prepare("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, USER_ID).run();

    const promoted = await product(stub, {
      operation: "create_message",
      auth: { ...AUTH, role: "admin" },
      input: {
        text: "after promotion",
        clientMessageId: "pipeline-role-change-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });
    expect(promoted.status).toBe(200);
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
        // The run must still be streaming when the socket subscribes. A
        // scripted stream answers in microseconds and run start is faster than
        // a socket upgrade, so without the gate the frames are gone before
        // anyone listens for them.
        gateFirstCall: true,
      });
      const opened = await initializeWorkstream(stub, "show me a streamed answer");
      expect(opened.status).toBe(200);
      ({ socket } = await openSubscribedSocket(
        stub,
        "00000000-0000-7000-8000-0000000005c1",
      ));
      const live = collectSocketFrames(socket);
      stopCollecting = live.stop;
      await openProviderGate(stub);

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
      function: { name: "current_time", arguments: "{}" },
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
        // As above: the live frames exist only while a listener is attached.
        gateFirstCall: true,
      });
      const opened = await initializeWorkstream(stub, "perform two deterministic tool steps");
      expect(opened.status).toBe(200);
      ({ socket: liveSocket } = await openSubscribedSocket(
        stub,
        "00000000-0000-7000-8000-0000000005c2",
      ));
      const live = collectSocketFrames(liveSocket);
      stopCollecting = live.stop;
      await openProviderGate(stub);

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
