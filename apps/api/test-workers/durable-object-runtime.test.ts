/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import {
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  DEFAULT_MEMBER_PREFERENCES,
  MESSAGE_MAX_CHARACTERS,
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WorkspaceWorkstreamPageEventSchema,
  ServerSocketEventSchema,
} from "@rally/contracts";
import {
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type ParentEffect,
  type ParentEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import {
  evictDurableObject,
  listDurableObjectIds,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RALLY_HEADERS } from "@rally/contracts/http-headers";

import { WorkspaceConversationView } from "../src/durable-objects/workspace-conversation-view";
import { AgentLoopDO } from "../src/durable-objects/agent-loop-do";
import { type SidekickDirectoryRow, writeSidekickDirectoryRow } from "./helpers/sidekick";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS, WorkspaceDO } from "../src/durable-objects/workspace-do";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import type { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { WorkstreamMessageStorage } from "../src/durable-objects/workstream-message-storage";
import {
  WorkstreamTranscriptStorage,
  insertPreparedTranscriptFact,
  prepareTranscriptFact,
} from "../src/durable-objects/workstream-transcript-storage";
import type { Env } from "../src/env";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import {
  admitFixturePendingInput,
  seedParticipantMessage,
  seedCanonicalMessageRecord,
  holdLoopExecuting,
} from "./helpers/substream-fixture";
import {
  consumeEffectBodies,
  deliverEffectsToWorkspaceInOrder,
} from "./helpers/conversation-effects";
import {
  conversationObjectName,
  substreamLoopId,
  workspaceDOName,
} from "../src/durable-objects/names";
import {
  LegacyWorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventClaimResultSchema,
} from "../src/durable-objects/workspace-connector-event-protocol";
import { WORKSPACE_LOCAL_TABLES } from "../src/services/workspace-runtime-database";
import { workspaceConnectorEventQueueMessage } from "../src/services/workspace-connector-event-ingress";
import { hostedParentStub, withHostedParent, seedParticipantGrants } from "./helpers/hosted-parent";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000101");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000102");
const CHILD_SUBSTREAM_ID = asSubstreamId("00000000-0000-7000-8000-000000000103");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000104");
const SESSION_ID = "runtime-test-session";
const SPACE_ID = asSpaceId("00000000-0000-7000-8000-00000000010b");
const OTHER_SPACE_ID = asSpaceId("00000000-0000-7000-8000-00000000010c");

beforeEach(async () => {
  clearFlagTargetingAttributeCache();
  await reset();
});

afterEach(() => {
  clearFlagTargetingAttributeCache();
  vi.restoreAllMocks();
});

async function seedOpenAuthority(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (
      id INTEGER PRIMARY KEY,
      phase TEXT NOT NULL,
      generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
    VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      -- Read by the socket authorization query so a socket-rooted trace can be
      -- matched to the workspace's product analytics; see
      -- docs/performance-tracing.md.
      analytics_workspace_id TEXT,
      abandoned_at TEXT
    )`),
    env.DB.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (access_class TEXT NOT NULL DEFAULT 'member', incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      role TEXT NOT NULL,
      last_seen_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, USER_ID),
    env.DB.prepare(`CREATE TABLE sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      region TEXT NOT NULL,
      revoked_at TEXT,
      expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    env.DB.prepare(`INSERT INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, USER_ID, WORKSPACE_ID),
  ]);
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
  await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
}

async function enableWorkspaceInfoLogs(stub: DurableObjectStub<WorkspaceDO>): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "LOG_LEVEL"
        ? "info"
        : Reflect.get(current, property, receiver),
    });
  });
}

async function seedCreatorProfile(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`INSERT OR IGNORE INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'creator@example.com', 'Creator', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(USER_ID),
  ]);
}

/**
 * Tables this repository's migrations created.
 *
 * `sqlite_%` is SQLite's own bookkeeping and `_cf_%` is the runtime's — the
 * hibernation API writes `_cf_METADATA` the first time an object accepts a
 * WebSocket, and nothing here creates, migrates, or can make it STRICT. Both
 * are excluded so an assertion about our schema is not decided by whether an
 * earlier test in the file happened to open a socket on the same object.
 */
function tableNames(state: DurableObjectState): string[] {
  return state.storage.sql.exec<{ name: string }>(
    `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
      ORDER BY name`,
  ).toArray().map((row) => row.name);
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
}

function nextMessageWhileOpen(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const onClose = (event: CloseEvent): void => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`Socket closed before its next event: ${event.code} ${event.reason}`));
    };
    const onMessage = (event: MessageEvent): void => {
      socket.removeEventListener("close", onClose);
      resolve(event);
    };
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

function nextMessageOfType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const decoded = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (decoded.type !== type) return;
        socket.removeEventListener("message", onMessage);
        resolve(decoded);
      } catch {
        // Heartbeat frames and unrelated messages are not the requested event.
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

function nextEncodedMessageOfType(
  socket: WebSocket,
  type: string,
): Promise<{ encoded: string; decoded: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const encoded = String(event.data);
        const decoded = JSON.parse(encoded) as Record<string, unknown>;
        if (decoded.type !== type) return;
        socket.removeEventListener("message", onMessage);
        resolve({ encoded, decoded });
      } catch {
        // Heartbeat frames and unrelated messages are not the requested event.
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}

function nextMessages(socket: WebSocket, count: number): Promise<MessageEvent[]> {
  return new Promise((resolve) => {
    const messages: MessageEvent[] = [];
    const onMessage = (event: MessageEvent) => {
      messages.push(event);
      if (messages.length < count) return;
      socket.removeEventListener("message", onMessage);
      resolve(messages);
    };
    socket.addEventListener("message", onMessage);
  });
}

type DirectoryCommonEffect = Extract<ConversationEffect, { kind: "directory_common" }>;
type DirectoryUserEffect = Extract<ConversationEffect, { kind: "directory_user" }>;

function partitionKeyFor(effect: ConversationEffect | ParentEffect): string {
  return effect.kind === "directory_user" ? `user:${effect.userId}` : "common";
}

/** One effect as a child conversation addresses it to its work stream. */
function childEffectEnvelope(
  effect: ConversationEffect,
  messageId: string,
  sourceVersion = 1,
  parentId: string = WORKSTREAM_ID,
  substreamId = asSubstreamId("0"),
): ConversationEffectEnvelope {
  return {
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId,
    substreamId,
    generation: 1,
    messageId,
    partitionKey: partitionKeyFor(effect),
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

/** One effect as a work stream forwards it to the workspace. */
function parentEffectEnvelope(
  effect: ParentEffect,
  messageId: string,
  sourceVersion = 1,
  parentId: string = WORKSTREAM_ID,
): ParentEffectEnvelope {
  return {
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId,
    generation: 1,
    messageId,
    partitionKey: partitionKeyFor(effect),
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

/**
 * Keep an object's outbox where a test can read it.
 *
 * The test Worker's `ACTIVITY_QUEUE` accepts a send and delivers it nowhere,
 * so an alarm that drains before `deliverEffectsToWorkspace` looks would lose
 * the effect the test is about. Refusing the send leaves the rows pending,
 * deferred the way a Queue outage defers them, for the helper to hand to the
 * real consumer. Eviction restores the binding.
 */
async function holdActivityQueue(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as { env: Env };
    const held: Pick<Queue, "send" | "sendBatch"> = {
      send: () => Promise.reject(new Error("activity_queue_held_by_test")),
      sendBatch: () => Promise.reject(new Error("activity_queue_held_by_test")),
    };
    target.env = new Proxy(target.env, {
      get: (current, property, receiver) => property === "ACTIVITY_QUEUE"
        ? held
        : Reflect.get(current, property, receiver),
    });
  });
}

/** The first frame of one type that satisfies `matches`; earlier ones are skipped. */
function nextMatchingMessage(
  socket: WebSocket,
  type: string,
  matches: (decoded: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const decoded = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (decoded.type !== type || !matches(decoded)) return;
        socket.removeEventListener("message", onMessage);
        resolve(decoded);
      } catch {
        // Heartbeat frames and unrelated messages are not the requested event.
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

function connectorEvent(eventId = "00000000-0000-7000-8000-000000000301") {
  return {
    connectorType: "github",
    activity: {
      id: eventId,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      connectionId: "00000000-0000-7000-8000-000000000302",
      connectionScope: "workspace" as const,
      connectionOwnerUserId: null,
      provider: "github",
      providerEventId: "delivery-42",
      eventType: "github.pull_request.edited",
      resourceType: "github_pull_request",
      providerResourceId: "juno-ai-labs/avalon#42",
      actor: { displayName: "Ada" },
      subject: { number: 42 },
      occurredAt: "2026-08-18T20:00:00.000Z",
      receivedAt: "2026-08-18T20:00:01.000Z",
      title: "Pull request edited",
      summary: "Ada edited the connector architecture",
      textSnippet: "Queue to WorkspaceDO to Workflow",
      payloadRef: "global/provider-webhooks/github/body.json",
      visibility: {},
      targetUserIds: [USER_ID],
      entityKeys: ["github:pr:42"],
      dedupeKey: "github:delivery-42:pull-request-edited",
      rawContentHash: "raw-sha256",
      metadata: { url: "https://github.com/juno-ai-labs/avalon/pull/42" },
      externalPeople: [],
    },
  };
}

type TestableSubstreamAgent = {
  publishAgentRuntimeEvent(event: Record<string, unknown>): Promise<void>;
  deliverCommittedRealtimeEvent(event: Record<string, unknown>): Promise<void>;
  drainSemanticRealtimeOutbox(): Promise<void>;
  semanticRealtimeEvent(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  nextLoopWorkAt(): number | null;
  agentDrain: { resume(operation: () => Promise<void>, settled: () => void): Promise<void> };
  runtimeRecovery: Promise<void> | null;
  runtimeRecoveryAttempt: () => Promise<void>;
  startRuntimeRecovery(): Promise<void>;
  fulfillSubscription(...args: unknown[]): Promise<boolean>;
  socketAuth(...args: unknown[]): Promise<unknown>;
  assembleSocketSnapshot(...args: unknown[]): Promise<unknown>;
  preparedSocketAdmissions: Map<string, { snapshot: unknown; input: { userId: string } }>;
  preparedSocketSnapshotTicketId: string | null;
  latestSocketRevocationAt: number;
};

/** The hosted parent's per-envelope apply, reached below the facade that drains after it. */
type TestableHostedParent = {
  applyChildEnvelope(substreamId: string, envelope: ConversationEffectEnvelope): void;
};

async function fetchAndDrain(
  stub: DurableObjectStub,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await stub.fetch(input, init);
  await response.clone().arrayBuffer();
  return response;
}

/**
 * Seat the reader these fixtures connect as.
 *
 * A bootstrapped-but-uninitialized work stream is born `personal`, so nobody is
 * a reader of it until somebody is in it — which is what a real create writes in
 * the same transaction as the root row. A fixture that stops at
 * `bootstrapRuntime` and then opens a socket has to do the same, or the room
 * refuses it with 403 for a reason that has nothing to do with what the test is
 * about.
 */
async function seatBootstrapParticipant(
  stub: DurableObjectStub,
  userId: string,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    if (state.storage.sql.exec("SELECT 1 FROM participants WHERE user_id = ? AND status = 'active'", userId).toArray().length) return;
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, updated_at)
       VALUES (?, 'creator', ?, 'active', 0, ?, NULL, ?)`,
      userId,
      userId,
      Date.now(),
      Date.now(),
    );
  });
}

/**
 * Provision the bootstrapped object the way a system producer does, through the
 * real identity operation. `bootstrapRuntime` alone opens an *empty*
 * authoritative object — its title is blank — and the socket snapshot's schema
 * rightly refuses a blank title, so a test that subscribes without this step
 * hangs on a snapshot that is never sent.
 */
async function provisionBootstrappedWorkstream(
  stub: DurableObjectStub<AgentLoopDO>,
  userId: string,
): Promise<void> {
  await seedCreatorProfile();
  const provisioned = await stub.executeIdentityOperation({
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation: "provision",
    args: [{
      title: "Runtime fixture work stream",
      objective: "Exercise the runtime under test.",
      scope: "workspace",
      createdByUserId: userId,
      participantUserIds: [userId],
      harnessStatus: "idle",
      emailAddress: null,
      emailRouteStatus: null,
      systemKind: null,
      modelOverride: null,
      now: Date.now(),
    }],
  });
  if (provisioned.status !== 200) {
    throw new Error(`workstream_fixture_provision_failed:${provisioned.status}`);
  }
}

describe("Durable Objects in the Workers runtime", () => {
  it("retries runtime recovery after one attempt fails instead of poisoning the isolate", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));

    await runInDurableObject(stub, async (instance) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      let attempts = 0;
      testable.runtimeRecovery = null;
      testable.runtimeRecoveryAttempt = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("injected_runtime_recovery_failure");
      };

      await expect(testable.startRuntimeRecovery())
        .rejects.toThrow("injected_runtime_recovery_failure");
      await expect(testable.startRuntimeRecovery()).resolves.toBeUndefined();
      expect(attempts).toBe(2);
    });
  });

  it("refuses fresh workspace, work-stream, and substream admission after abandonment", async () => {
    await seedOpenAuthority();
    const identity = { sessionId: SESSION_ID, userId: USER_ID, workspaceId: WORKSPACE_ID };
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const substream = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, asSubstreamId("0")),
    ));
    const authorization = async () => ({
      workspace: await runInDurableObject(workspace, async (instance: WorkspaceDO) => (
        (instance as unknown as { sessionAuth(value: typeof identity): Promise<unknown> }).sessionAuth(identity)
      )),
      // The Channel control socket's own admission, now answered by the
      // hosted parent inside the Organization object.
      workstream: await withHostedParent(workspace, WORKSTREAM_ID, (parent) => (
        (parent as unknown as { sessionAuth(value: typeof identity): Promise<unknown> }).sessionAuth(identity)
      )),
      substream: await runInDurableObject(substream, async (instance: AgentLoopDO) => (
        (instance as unknown as { socketAuth(value: typeof identity): Promise<unknown> }).socketAuth(identity)
      )),
    });

    // Admitted while the workspace is live, so the refusal below is the
    // abandonment's and not a fixture's.
    const admitted = await authorization();
    expect(admitted.workspace).not.toBeNull();
    expect(admitted.workstream).not.toBeNull();
    expect(admitted.substream).not.toBeNull();
    await env.DB.prepare(`UPDATE workspaces SET abandoned_at = ? WHERE id = ?`)
      .bind("2026-09-01T00:00:00.000Z", WORKSPACE_ID).run();

    await expect(authorization()).resolves.toEqual({
      workspace: null,
      workstream: null,
      substream: null,
    });
  });

  it("preserves HTTP-style success and conflict envelopes across native RPC", async () => {
    await seedOpenAuthority();
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const bootstrapped = await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    });
    expect(bootstrapped.status).toBe(200);
    expect(JSON.parse(bootstrapped.bodyJson)).toEqual({ ok: true });
    const fenced = await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 2,
    });
    expect(fenced.status).toBe(409);
    expect(JSON.parse(fenced.bodyJson)).toEqual({ error: "workstream_runtime_bootstrap_fenced" });

    const parent = hostedParentStub(env, WORKSPACE_ID);
    const common = childEffectEnvelope({
      kind: "directory_common",
      title: "Native RPC",
      description: "Typed child-to-parent delivery",
      preview: "RPC",
      scope: "workspace",
      state: "idle",
      systemKind: null,
      lastActivityAt: "2026-08-18T12:00:00.000Z",
      completedAt: null,
      archivedAt: null,
    }, "native-rpc-common");
    // The parent contract answers with a receipt per envelope, not an HTTP
    // envelope: the consumer reads the receipt and nothing else.
    await expect(parent.receiveChildEffects({ substreamId: "0", envelopes: [common] })).resolves.toEqual({
      accepted: [{ messageId: common.messageId, payloadHash: common.payloadHash }],
    });
    // Asserted inside the object: a rejected native RPC on a stub leaves a
    // second rejection the runtime holds, which fails the run under a summary
    // of passing tests. The Organization object picks the parent from the
    // batch's first envelope, so the mismatch it refuses is a batch that names
    // a second parent.
    await runInDurableObject(parent, async (instance: WorkspaceDO) => {
      await expect(instance.receiveChildEffects({
        substreamId: "0",
        envelopes: [{ ...common, messageId: "native-rpc-matched" }, {
          ...common,
          messageId: "native-rpc-mismatch",
          parentId: "00000000-0000-7000-8000-000000000199",
        }],
      })).rejects.toThrow("workstream_effect_identity_mismatch");
    });
    // A newer epoch is adopted, not refused: the metadata row is stamped once
    // and never rewritten, so gating on it strands every effect a restarted
    // campaign produces.
    const newer = await parent.receiveChildEffects({
      substreamId: "0",
      envelopes: [{ ...common, messageId: "native-rpc-newer-epoch", generation: common.generation + 1 }],
    });
    expect(newer.accepted).toEqual([{ messageId: "native-rpc-newer-epoch", payloadHash: common.payloadHash }]);
    // An earlier epoch is a replay, not a mismatch. A restarted maintenance
    // campaign moves an object's generation forward, and refusing these would
    // strand every effect already in flight, permanently, since the numbers
    // can never agree again.
    const replayWorkstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000001aa");
    const replayParent = hostedParentStub(env, WORKSPACE_ID);
    const establishedAtTwo = await replayParent.receiveChildEffects({
      substreamId: "0",
      envelopes: [{
        ...common,
        messageId: "epoch-two",
        parentId: replayWorkstreamId,
        generation: 2,
      }],
    });
    expect(establishedAtTwo.accepted).toHaveLength(1);
    // ...and an older one still applies afterwards, which is the case a
    // restart actually produces: effects already in flight carry the epoch
    // they were enqueued under.
    const replayedFromOne = await replayParent.receiveChildEffects({
      substreamId: "0",
      envelopes: [{
        ...common,
        messageId: "epoch-one",
        parentId: replayWorkstreamId,
        generation: 1,
      }],
    });
    expect(replayedFromOne.accepted).toEqual([{ messageId: "epoch-one", payloadHash: common.payloadHash }]);
    // A child restarts its own projection numbering when a maintenance import
    // rebuilds it, so the same source version legitimately comes back carrying
    // different content. The newer payload wins instead of failing delivery.
    const reusedHash = `${common.payloadHash.slice(0, -1)}f`;
    const reused = await replayParent.receiveChildEffects({
      substreamId: "0",
      envelopes: [{
        ...common,
        messageId: "epoch-one-reused-version",
        parentId: replayWorkstreamId,
        generation: 2,
        payloadHash: reusedHash,
      }],
    });
    expect(reused.accepted).toEqual([{ messageId: "epoch-one-reused-version", payloadHash: reusedHash }]);
  });

  it("carries a creation snapshot through its parent into the workspace directory", async () => {
    await seedOpenAuthority();
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    });
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
    const common = childEffectEnvelope({
      kind: "directory_common",
      title: "Creation fence",
      description: "The route stays verified until this row exists",
      preview: "Synchronous hierarchy drain",
      scope: "workspace",
      state: "scheduled",
      systemKind: null,
      lastActivityAt: "2026-08-18T12:00:00.000Z",
      completedAt: null,
      archivedAt: null,
    }, "creation-fence-common");
    await runInDurableObject(child, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO durable_outbox
           (message_id, channel, destination_kind, destination_id, partition_key,
            source_version, source_epoch, contract_version, payload_json, payload_ref,
            payload_hash, state, attempts, not_before, created_at, acked_at)
         VALUES (?, 'regional_effect_v1', 'queue', 'global', 'common', 1, 1, 1, ?, NULL,
                 ?, 'pending', 1, ?, 1, NULL)`,
        common.messageId,
        JSON.stringify(common),
        common.payloadHash,
        Date.now() + 60_000,
      );
    });

    // The parent step and the directory step are one call now: the
    // Organization object applies the child's effect to the hosted parent and
    // then its own directory row from the local outbox, before returning.
    await expect(workspace.receiveChildEffects({ substreamId: "0", envelopes: [common] })).resolves.toEqual({
      accepted: [{ messageId: common.messageId, payloadHash: common.payloadHash }],
    });
    await runInDurableObject(child, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM durable_outbox WHERE message_id = ?`, common.messageId);
    });
    await expect(workspace.lookupWorkstreamDirectory({
      workspaceId: WORKSPACE_ID,
      workstreamIds: [WORKSTREAM_ID],
    })).resolves.toMatchObject({
      items: [{ workstreamId: WORKSTREAM_ID, title: "Creation fence", state: "scheduled" }],
    });
    await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_outbox`,
      ).one().count).toBe(0);
    });
    await runInDurableObject(workspace, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM parent_outbox WHERE parent_id = ?`,
        WORKSTREAM_ID,
      ).one().count).toBe(0);
    });
  });

  it("repairs a missing creation projection when initialize is replayed", async () => {
    await seedOpenAuthority();
    await seedCreatorProfile();
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const auth = {
      sessionId: SESSION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      role: "member" as const,
    };
    const input = {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
      title: "Replay-safe creation",
      objective: "Repair the parent directory after an ambiguous creation response",
      descriptionSource: "authored" as const,
      titleStatus: "settled" as const,
      emailAddress: null,
      creatorUserId: USER_ID,
      openingMessage: "Start",
      openingStructuredContent: null,
      clientMessageId: "creation-replay-client-message",
      participantUserIds: [],
      attachmentIds: [],
      originResourceIds: [],
      scope: "personal" as const,
      modelOverride: "test-model",
      systemKind: null,
      createdFromOpportunityId: null,
      opportunityVersion: null,
      opportunityDisplayPromptHash: null,
      opportunityExecutionPromptHash: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    };

    await runInDurableObject(child, async (instance, state) => {
      const product = (instance as unknown as { product: WorkstreamObjectProductService }).product;
      await product.initialize(auth, input);
      state.storage.sql.exec(`DELETE FROM durable_outbox`);
      state.storage.sql.exec(`DELETE FROM projection_keys`);

      await product.initialize(auth, input);

      // `projection_keys`, not `durable_outbox`. Both rows are written per
      // effect in the same transaction, so this count proves the repair
      // re-enqueued two — but only this one is stable to observe from a test:
      // the object's delivery alarm deletes an outbox row the moment it
      // forwards it to the parent, so counting those races a drain that is
      // the effect *succeeding*. Nothing ever deletes a projection key.
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM projection_keys`,
      ).one().count).toBe(2);
    });
  });

  it("does not read a preparing work stream while resolving its first model", async () => {
    await seedOpenAuthority();
    await seedCreatorProfile();
    const modelTargetingWorkstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000001ab");
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, modelTargetingWorkstreamId),
    ));
    const auth = {
      sessionId: SESSION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      role: "member" as const,
    };

    await runInDurableObject(child, async (instance, state) => {
      const residentProduct = (instance as unknown as {
        product: WorkstreamObjectProductService;
      }).product as unknown as {
        objectStore: WorkstreamObjectStore;
        env: Env;
      };
      const getObjectDetails = vi.fn(async (flagKey: string, defaultValue: unknown) => ({
        flagKey,
        value: defaultValue,
        reason: "DEFAULT",
      }));
      const flags = {
        getObjectDetails,
      };
      const product = new WorkstreamObjectProductService(
        state.storage,
        residentProduct.objectStore,
        new Proxy(residentProduct.env, {
          get(target, property, receiver) {
            if (property === "FLAGS") return flags;
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      );

      await product.initialize(auth, {
        workspaceId: WORKSPACE_ID,
        workstreamId: modelTargetingWorkstreamId,
        generation: 1,
        title: "Authority-safe model targeting",
        objective: "Resolve the first model without querying a preparing object",
        descriptionSource: "authored",
        titleStatus: "settled",
        emailAddress: null,
        creatorUserId: USER_ID,
        openingMessage: "Start",
        openingStructuredContent: null,
        clientMessageId: "authority-safe-model-targeting",
        participantUserIds: [],
        attachmentIds: [],
        originResourceIds: [],
        scope: "personal",
        modelOverride: null,
        systemKind: null,
        createdFromOpportunityId: null,
        opportunityVersion: null,
        opportunityDisplayPromptHash: null,
        opportunityExecutionPromptHash: null,
        executionPrincipal: { type: "user", userId: USER_ID },
        reason: "user_message",
      });

      expect(getObjectDetails).toHaveBeenCalledOnce();
    });
  });

  it("creates a work stream nobody named an audience for as private", async () => {
    await seedOpenAuthority();
    // A second active member of the same workspace, so "who else can read it"
    // is a real question rather than one nobody is standing there to ask.
    const otherUserId = asUserId("00000000-0000-7000-8000-0000000004b7");
    const otherSessionId = "00000000-0000-7000-8000-0000000004b9";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
         VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`,
      ).bind(WORKSPACE_ID, otherUserId),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
         VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`,
      ).bind(otherSessionId, otherUserId, WORKSPACE_ID),
    ]);
    // The detail read joins the regional profile, pin, and connection tables.
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const auth = {
      sessionId: SESSION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      role: "member" as const,
    };
    // No `scope`, which is the whole point: an initialize nobody named an
    // audience for is born private. `POST /workstreams` names `workspace`
    // itself, so a Channel a person starts is not this case.
    const input = {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
      title: "Born private",
      objective: "A work stream nobody said anything about the audience of",
      descriptionSource: "authored" as const,
      titleStatus: "settled" as const,
      emailAddress: null,
      creatorUserId: USER_ID,
      openingMessage: "Start",
      openingStructuredContent: null,
      clientMessageId: "born-private-client-message",
      participantUserIds: [],
      attachmentIds: [],
      originResourceIds: [],
      modelOverride: "test-model",
      systemKind: null,
      createdFromOpportunityId: null,
      opportunityVersion: null,
      opportunityDisplayPromptHash: null,
      opportunityExecutionPromptHash: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    };

    await runInDurableObject(child, async (instance, state) => {
      const product = (instance as unknown as { product: WorkstreamObjectProductService }).product;
      const created = await product.initialize(auth, input);
      expect(created.workstream.scope).toBe("personal");
      // The authoritative row, not only what the response said about it.
      expect(state.storage.sql.exec<{ scope: string }>(
        `SELECT scope FROM workstream WHERE id = 1`,
      ).one().scope).toBe("personal");
    });

    // Private is enforced against the participant room, so the creator — seated
    // by the same transaction that wrote the row — still reads it, and the
    // other member of the workspace does not.
    const mine = await child.handleProductRequest({ operation: "get", auth });
    expect(mine.status).toBe(200);
    expect(JSON.parse(mine.bodyJson)).toMatchObject({ id: WORKSTREAM_ID, scope: "personal" });
    await expect(child.readerAudience({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).resolves.toEqual({ scope: "personal", userIds: [USER_ID] });
    const theirs = await child.handleProductRequest({
      operation: "get",
      auth: { ...auth, sessionId: otherSessionId, userId: otherUserId },
    });
    expect(theirs.status).toBe(404);
    expect(JSON.parse(theirs.bodyJson)).toMatchObject({ error: "workstream_not_found" });
  });

  it("creates a work stream whose caller named the workspace as readable by it", async () => {
    await seedOpenAuthority();
    const otherUserId = asUserId("00000000-0000-7000-8000-0000000004b8");
    const otherSessionId = "00000000-0000-7000-8000-0000000004ba";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
         VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`,
      ).bind(WORKSPACE_ID, otherUserId),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
         VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`,
      ).bind(otherSessionId, otherUserId, WORKSPACE_ID),
    ]);
    // The detail read joins the regional profile, pin, and connection tables.
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const auth = {
      sessionId: SESSION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      role: "member" as const,
    };
    // What the Slack ingress computes for a thread in a public channel: the
    // room is the channel, so no participant is seated and `workspace` is the
    // only thing that makes the work stream readable by any of them.
    await runInDurableObject(child, async (instance, state) => {
      const product = (instance as unknown as { product: WorkstreamObjectProductService }).product;
      const created = await product.initialize(auth, {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        generation: 1,
        title: "Summoned in a public channel",
        objective: "A work stream whose audience the ingress knew",
        descriptionSource: "derived" as const,
        titleStatus: "settled" as const,
        emailAddress: null,
        creatorUserId: USER_ID,
        openingMessage: "Start",
        openingStructuredContent: null,
        clientMessageId: "public-audience-client-message",
        participantUserIds: [],
        attachmentIds: [],
        originResourceIds: [],
        scope: "workspace" as const,
        modelOverride: "test-model",
        systemKind: null,
        createdFromOpportunityId: null,
        opportunityVersion: null,
        opportunityDisplayPromptHash: null,
        opportunityExecutionPromptHash: null,
        executionPrincipal: { type: "user", userId: USER_ID },
        reason: "user_message",
      });
      expect(created.workstream.scope).toBe("workspace");
      expect(state.storage.sql.exec<{ scope: string }>(
        `SELECT scope FROM workstream WHERE id = 1`,
      ).one().scope).toBe("workspace");
    });

    const theirs = await child.handleProductRequest({
      operation: "get",
      auth: { ...auth, sessionId: otherSessionId, userId: otherUserId },
    });
    expect(theirs.status).toBe(200);
    expect(JSON.parse(theirs.bodyJson)).toMatchObject({ id: WORKSTREAM_ID, scope: "workspace" });
  });

  it("constructs every object through its SQL migration ledger", async () => {
    const cases = [
      {
        namespace: env.SUBSTREAM_AGENTS,
        name: conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
        constructor: AgentLoopDO,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.length,
        tables: [
          "_sql_schema_migrations",
          "active_agent_compaction",
          "substream_loops",
          "pending_attachment_reservation_recovery",
          "pending_loop_input_mailbox",
          "pending_loop_inputs",
          "delivered_loop_inputs",
          "assistant_turn_reservations",
        ],
        absentTables: ["agent_run_dispatches", "run_steering"],
      },
      {
        namespace: env.WORKSPACE_DOS,
        name: workspaceDOName("global", WORKSPACE_ID),
        constructor: WorkspaceDO,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.length,
        tables: [
          "_sql_schema_migrations",
          "workspace_directory_state",
          "workspace_connector_event_ingress_receipts",
          "workspace_connector_events",
          "workspace_identity",
          "channels",
          "workspace_workstream_effect_receipts",
          "workspace_workstream_pins",
          "workspace_workstream_resource_links",
          "pending_attachment_reservations",
          "channel_viewers",
          // Every Channel's and Space's parent state, keyed by parent id.
          "parent_metadata",
          "parent_children",
          "parent_child_projections",
          "parent_outbox",
          "parent_state_changes",
          "parent_grants",
          "workspace_sync_events",
          "workspace_socket_ticket_receipts",
          "workspace_batch_dispatches",
          "workspace_batch_dispatch_targets",
          "workspace_activity_events",
          "workspace_activity_event_targets",
          "opportunity_batch_windows",
          "opportunity_batch_events",
          "work_opportunities",
          "opportunity_provenance_nodes",
          "opportunity_provenance_edges",
          "work_opportunity_provenance_roots",
          "work_opportunity_user_links",
          "work_opportunity_user_states",
          "suggested_work_sets",
          "suggested_work_ranking_rounds",
          "work_opportunity_snapshots",
          ...WORKSPACE_LOCAL_TABLES,
        ],
        // Retired in schema version 3. Version 1 still creates them and always
        // will — its statements are hashed into the migration receipt — so a
        // fresh object proves the drop only by not having them at the end.
        absentTables: ["external_delivery_attempts", "slack_agent_channel_allowlist", "notes", "note_transcript_segments", "note_privacy_change_outbox", "note_resource_deletion_outbox", "workspace_batch_dispatch_note_targets"],
      },
    ] as const;

    for (const entry of cases) {
      const stub = entry.namespace.get(entry.namespace.idFromName(entry.name));
      await fetchAndDrain(stub, "https://object.test/health");
      await runInDurableObject(stub, (instance, state) => {
        expect(instance).toBeInstanceOf(entry.constructor);
        expect(tableNames(state)).toEqual(expect.arrayContaining([...entry.tables]));
        const absent: readonly string[] = "absentTables" in entry ? entry.absentTables : [];
        expect(tableNames(state).filter((table) => absent.includes(table))).toEqual([]);
        // A fresh object applies its object's whole published ledger, and each
        // version lands exactly once. Objects created before a version was
        // published apply only the new tail, which is why the ledger is
        // append-only and never edited in place.
        expect(state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM _sql_schema_migrations`,
        ).one().count).toBe(entry.migrations);
        const nonStrict = state.storage.sql.exec<{ name: string; type: string; strict: number }>(
          `PRAGMA table_list`,
        ).toArray().filter((table) => (
          table.type === "table"
          && !table.name.startsWith("sqlite_")
          // The runtime's own `_cf_METADATA` is not STRICT and never will be.
          // It appears once an object has accepted a hibernating WebSocket, so
          // leaving it in makes this assertion depend on test order.
          && !table.name.startsWith("_cf_")
          && table.strict !== 1
        ));
        expect(nonStrict).toEqual([]);
        if (instance instanceof WorkspaceDO) {
          const stateColumns = state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(parent_state_changes)`,
          ).toArray().map((column) => column.name);
          expect(stateColumns).toEqual(expect.arrayContaining([
            "parent_id",
            "sequence",
            "state_key",
            "waterline",
            "event_id",
            "state_json",
          ]));
          const syncColumns = state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(workspace_sync_events)`,
          ).toArray().map((column) => column.name);
          expect(syncColumns).toEqual(["waterline", "event_id", "topics_json", "occurred_at", "audience_json"]);
          const directoryColumns = state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(channels)`,
          ).toArray().map((column) => column.name);
          expect(directoryColumns).toEqual(expect.arrayContaining([
            "authority_generation",
            "waterline",
            "source_event_id",
          ]));
          // Global records only that an address is claimed, so there is no
          // route lifecycle for this object to mirror. A fresh chain must not
          // recreate the column the drop migration removed.
          const subscriptionColumns = state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(automation_subscriptions)`,
          ).toArray().map((column) => column.name);
          expect(subscriptionColumns).toContain("email_address");
          expect(subscriptionColumns).not.toContain("email_route_status");
        }
      });
    }
  });

  it("gives main and child substreams isolated SQLite databases that survive eviction", async () => {
    const mainId = env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const childId = env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, CHILD_SUBSTREAM_ID),
    );
    const main = env.SUBSTREAM_AGENTS.get(mainId);
    const child = env.SUBSTREAM_AGENTS.get(childId);
    await Promise.all([
      fetchAndDrain(main, "https://object.test/health"),
      fetchAndDrain(child, "https://object.test/health"),
    ]);
    await runInDurableObject(main, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO substream_agent_identity(id, external_substream_id, created_at, updated_at)
         VALUES (1, '0', 1, 1)`,
      );
    });
    await runInDurableObject(child, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO substream_agent_identity(id, external_substream_id, created_at, updated_at)
         VALUES (1, ?, 1, 1)`,
        CHILD_SUBSTREAM_ID,
      );
    });

    await Promise.all([evictDurableObject(main), evictDurableObject(child)]);
    await Promise.all([
      fetchAndDrain(main, "https://object.test/health"),
      fetchAndDrain(child, "https://object.test/health"),
    ]);
    await runInDurableObject(main, (_instance, state) => {
      expect(state.storage.sql.exec<{ external_substream_id: string }>(
        `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
      ).one().external_substream_id).toBe("0");
    });
    await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec<{ external_substream_id: string }>(
        `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
      ).one().external_substream_id).toBe(CHILD_SUBSTREAM_ID);
    });
    const ids = await listDurableObjectIds(env.SUBSTREAM_AGENTS);
    expect(ids.some((id) => id.equals(mainId))).toBe(true);
    expect(ids.some((id) => id.equals(childId))).toBe(true);
  });

  it("uses a ref-counted heartbeat alarm only while an in-memory loop is active", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, CHILD_SUBSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await fetchAndDrain(stub, "https://object.test/health");
    await runInDurableObject(stub, async (instance, state) => {
      await instance.keepAlive();
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 31_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await evictDurableObject(stub);
    // The lease is intentionally in-memory. Eviction ends the computation it
    // protected, so a new instance must not retain a heartbeat with no durable
    // work to recover.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("forwards the earliest Terminal deadline of any conversation and lists which conversations own one", async () => {
    const stub = hostedParentStub(env, WORKSPACE_ID);
    const at = "2026-08-17T20:00:00.000Z";
    const mainDue = "2026-08-17T21:00:00.000Z";
    const threadDue = "2026-08-17T20:30:00.000Z";
    const common = (title: string, nextTerminalActionAt: string | null) => ({
      kind: "directory_common" as const,
      title,
      description: "Whose sandbox is due",
      preview: "",
      scope: "workspace" as const,
      state: "idle",
      systemKind: null,
      lastActivityAt: at,
      completedAt: null,
      archivedAt: null,
      nextTerminalActionAt,
    });
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    // Driven on the hosted parent below the Organization facade. What the
    // parent published is read from its own record of each projection
    // version, which the directory applied in the same transaction.
    const forwarded = await withHostedParent(stub, WORKSTREAM_ID, (parent, state) => {
      const testable = parent as unknown as TestableHostedParent;
      const deadline = () => state.storage.sql.exec<{ next_terminal_action_at: number | null }>(
        `SELECT next_terminal_action_at FROM channels WHERE workstream_id = ?`, WORKSTREAM_ID,
      ).one().next_terminal_action_at;
      testable.applyChildEnvelope("0", childEffectEnvelope(common("Main", mainDue), "main-terminal-1"));
      expect(deadline()).toBe(Date.parse(mainDue));
      // A side thread's sandbox comes due first. The thread's projection is
      // not the one the workspace sees, but its deadline has to be: the
      // workspace alarm is the only thing that ever stops that sandbox.
      testable.applyChildEnvelope(CHILD_SUBSTREAM_ID, childEffectEnvelope(
        common("Thread", threadDue), "thread-terminal-1", 1, WORKSTREAM_ID, CHILD_SUBSTREAM_ID,
      ));
      expect(deadline()).toBe(Date.parse(threadDue));
      expect(parent.childTerminalDeadlines({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID }))
        .toEqual({ items: [
          { substreamId: CHILD_SUBSTREAM_ID, nextTerminalActionAt: threadDue },
          { substreamId: "0", nextTerminalActionAt: mainDue },
        ] });
      // The thread's sandbox is gone; the main conversation's is the earliest again.
      testable.applyChildEnvelope(CHILD_SUBSTREAM_ID, childEffectEnvelope(
        common("Thread", null), "thread-terminal-2", 2, WORKSTREAM_ID, CHILD_SUBSTREAM_ID,
      ));
      expect(deadline()).toBe(Date.parse(mainDue));
      expect(parent.childTerminalDeadlines({ workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID }))
        .toEqual({ items: [{ substreamId: "0", nextTerminalActionAt: mainDue }] });
      return state.storage.sql.exec<{ state_json: string }>(
        `SELECT state_json FROM parent_state_changes
          WHERE parent_id = ? AND state_key = 'common'
          ORDER BY waterline`,
        WORKSTREAM_ID,
      ).toArray().map((row) => JSON.parse(row.state_json) as { title: string; nextTerminalActionAt: string | null });
    });
    // Every row the workspace hears is the main conversation's, carrying
    // whichever deadline was earliest at the time.
    expect(forwarded).toEqual([
      { ...common("Main", mainDue) },
      { ...common("Main", threadDue) },
      { ...common("Main", mainDue) },
    ].map((effect) => expect.objectContaining({ title: effect.title, nextTerminalActionAt: effect.nextTerminalActionAt })));
  });

  it("stores private child projections without changing Main's directory in the hosted parent", async () => {
    const stub = hostedParentStub(env, WORKSPACE_ID);
    const at = "2026-08-17T20:00:00.000Z";
    const later = "2026-08-17T20:01:00.000Z";
    const common = (state: string, lastActivityAt: string, completedAt: string | null) => ({
      kind: "directory_common" as const,
      title: state === "running" ? "Child is running" : "Main is done",
      description: "Aggregate me",
      preview: "Latest child preview",
      scope: "workspace" as const,
      state,
      systemKind: null,
      lastActivityAt,
      completedAt,
      archivedAt: null,
    });
    const user = (unreadCount: number, youAreMentioned: boolean) => ({
      kind: "directory_user" as const,
      userId: USER_ID,
      isParticipant: true,
      unreadCount,
      youAreMentioned,
      listable: true,
    });
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    await stub.applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: false,
      relationship: {
        workspaceId: WORKSPACE_ID, userId: USER_ID, accessClass: "member", role: "member",
        status: "active", incarnation: "existing-member", revision: 1,
      },
    });
    await withHostedParent(stub, WORKSTREAM_ID, (parent, state) => {
      const testable = parent as unknown as TestableHostedParent;
      for (const [substreamId, envelopes] of [
        ["0", [
          childEffectEnvelope(common("completed", at, at), "main-common"),
          childEffectEnvelope(user(2, false), "main-user"),
        ]],
        [CHILD_SUBSTREAM_ID, [
          childEffectEnvelope(common("running", later, null), "child-common"),
          childEffectEnvelope(user(3, true), "child-user"),
        ]],
      ] as const) {
        for (const envelope of envelopes) testable.applyChildEnvelope(substreamId, envelope);
      }
      expect(state.storage.sql.exec<{
        exact_state: string;
        last_activity_at: number;
        completed_at: number | null;
      }>(`SELECT exact_state, last_activity_at, completed_at FROM channels WHERE workstream_id = ?`, WORKSTREAM_ID).one())
        .toEqual({ exact_state: "completed", last_activity_at: Date.parse(at), completed_at: Date.parse(at) });
      const effects = state.storage.sql.exec<{ effect_json: string }>(
        `SELECT effect_json FROM parent_child_viewer_projections WHERE parent_id = ? AND user_id = ? ORDER BY substream_id`,
        WORKSTREAM_ID,
        USER_ID,
      ).toArray().map((row) => JSON.parse(row.effect_json) as { unreadCount: number; youAreMentioned: boolean });
      expect(effects).toHaveLength(2);
      expect(effects.reduce((sum, effect) => sum + effect.unreadCount, 0)).toBe(5);
      expect(effects.some((effect) => effect.youAreMentioned)).toBe(true);
      // Main published once per key, and the Organization's rows are Main's.
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM parent_state_changes
          WHERE parent_id = ? AND state_key IN ('common', ?)`,
        WORKSTREAM_ID,
        `user:${USER_ID}`,
      ).one().count).toBe(2);
      const directory = () => ({
        channel: state.storage.sql.exec(
          `SELECT exact_state, waterline FROM channels WHERE workstream_id = ?`, WORKSTREAM_ID,
        ).toArray(),
        viewer: state.storage.sql.exec(
          `SELECT unread_count, you_are_mentioned FROM channel_viewers WHERE workstream_id = ? AND user_id = ?`,
          WORKSTREAM_ID, USER_ID,
        ).toArray(),
      });
      expect(directory()).toEqual({
        channel: [{ exact_state: "completed", waterline: 1 }],
        viewer: [{ unread_count: 2, you_are_mentioned: 0 }],
      });
      testable.applyChildEnvelope(
        CHILD_SUBSTREAM_ID,
        childEffectEnvelope(
          common("running", "2026-08-17T20:02:00.000Z", null),
          "child-common-v2",
          2,
        ),
      );
      // The later private update is retained locally, not emitted as Main.
      expect(state.storage.sql.exec<{ waterline: number }>(
        `SELECT waterline FROM parent_state_changes WHERE parent_id = ? AND state_key = 'common'`,
        WORKSTREAM_ID,
      ).toArray()).toEqual([{ waterline: 1 }]);
      expect(directory().channel).toEqual([{ exact_state: "completed", waterline: 1 }]);
      expect(state.storage.sql.exec(`SELECT message_id FROM parent_outbox WHERE parent_id = ?`, WORKSTREAM_ID)
        .toArray()).toEqual([]);
    });
  });

  describe("workspace socket handshake logs", () => {
    let logged: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      logged = vi.spyOn(console, "info").mockImplementation(() => {});
    });

    it("keeps a hibernating workspace socket alive across forced eviction", async () => {
      await seedOpenAuthority();
      const diagnosticAttemptId = "018f22f2-4c22-7abc-8def-0123456789ab";
      const id = env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID));
      const stub = env.WORKSPACE_DOS.get(id);
      await enableWorkspaceInfoLogs(stub);
      const ticketId = "00000000-0000-7000-8000-000000000105";
      const response = await stub.fetch("https://workspace.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-rally-workspace-id": WORKSPACE_ID,
          "x-rally-placement-affinity": "wnam",
          "x-rally-user-id": USER_ID,
          "x-rally-session-id": SESSION_ID,
          "x-rally-socket-ticket-id": ticketId,
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        },
      });
      if (response.status !== 101) {
        throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
      }
      expect(response.status).toBe(101);
      await expect(stub.initializeWorkspace(WORKSPACE_ID, "wnam")).resolves.toEqual({ spacesReady: false });
      const socket = response.webSocket;
      expect(socket).toBeDefined();
      socket!.accept();

      const replay = await stub.fetch("https://workspace.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-rally-workspace-id": WORKSPACE_ID,
          "x-rally-placement-affinity": "wnam",
          "x-rally-user-id": USER_ID,
          "x-rally-session-id": SESSION_ID,
          "x-rally-socket-ticket-id": ticketId,
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        },
      });
      expect(replay.status).toBe(401);
      await replay.arrayBuffer();

      try {
        await evictDurableObject(stub);
        await enableWorkspaceInfoLogs(stub);
        const pong = nextMessage(socket!);
        socket!.send("ping");
        expect((await pong).data).toBe("pong");
        const snapshot = nextMessageWhileOpen(socket!);
        socket!.send(JSON.stringify({ type: "future_workspace_event" }));
        socket!.send(JSON.stringify({ type: "subscribe", afterWaterline: 0, diagnosticAttemptId, future: true }));
        expect(JSON.parse(String((await snapshot).data))).toMatchObject({
          type: "workspace_sync",
          waterline: 0,
          reason: "initial",
        });
        const phases: Record<string, unknown>[] = logged.mock.calls
          .map(([entry]: unknown[]) => entry as Record<string, unknown>)
          .filter((entry: Record<string, unknown>) => entry.event === "workspace_socket_handshake");
        const subscribed = phases.filter((entry) => entry.diagnostic_attempt_id === diagnosticAttemptId);
        expect(subscribed.map((entry) => entry.phase)).toEqual([
          "subscribe_received", "subscribe_authorized", "sidebar_built", "flags_resolved", "sync_sent",
        ]);
        expect(phases).toContainEqual(expect.objectContaining({
          phase: "accepted", connection_id: subscribed[0]?.connection_id,
        }));
        expect(phases).toContainEqual(expect.objectContaining({
          phase: "frame_received", connection_id: subscribed[0]?.connection_id,
        }));
        expect(phases.filter((entry) => entry.phase === "frame_received")).toHaveLength(1);
        expect(JSON.stringify(phases)).not.toContain(ticketId);
      } finally {
        socket!.close(1000, "test complete");
      }
    });
  });

  async function openWorkspaceSocket(
    stub: DurableObjectStub<WorkspaceDO>,
    ticketId: string,
    sessionId: string = SESSION_ID,
    userId: string = USER_ID,
    impersonatorUserId?: string,
  ): Promise<WebSocket> {
    const response = await stub.fetch("https://workspace.test/socket", {
      headers: {
        ...(impersonatorUserId ? { [RALLY_HEADERS.SOCKET_IMPERSONATOR_ID]: impersonatorUserId } : {}),
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": userId,
        "x-rally-session-id": sessionId,
        "x-rally-socket-ticket-id": ticketId,
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    if (response.status !== 101) {
      throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
    }
    const socket = response.webSocket!;
    socket.accept();
    const subscribed = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
    await subscribed;
    return socket;
  }

  it("persists per-user access ordering and pushes it across sessions", async () => {
    await seedOpenAuthority();
    const otherUserId = asUserId("00000000-0000-7000-8000-00000000040a");
    const otherSessionId = `${SESSION_ID}-presence`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
        VALUES (?, ?, 'active', 'member', '2026-08-26T20:00:00.000Z')`).bind(WORKSPACE_ID, otherUserId),
      env.DB.prepare(`INSERT INTO sessions
        (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(otherSessionId, otherUserId, WORKSPACE_ID),
    ]);
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
    const at = "2026-08-26T20:00:00.000Z";
    const common = {
      kind: "directory_common" as const,
      title: "Foreground presence",
      description: "Presence does not follow pooled sockets",
      preview: "idle",
      scope: "workspace" as const,
      state: "idle",
      systemKind: null,
      lastActivityAt: at,
      completedAt: null,
      archivedAt: null,
      createdByUserId: null,
      latestAttentionOrdinal: 0,
      unreadTrackingStartOrdinal: 0,
      createdAt: at,
      updatedAt: at,
    };
    const viewer = (userId: string, isParticipant: boolean) => ({
      kind: "directory_user" as const,
      userId,
      isParticipant,
      unreadCount: 0,
      youAreMentioned: false,
      listable: isParticipant,
      seenAttentionOrdinal: 0,
      manualUnreadFromOrdinal: null,
      manualUnreadGeneration: 0,
      latestMentionAttentionOrdinal: 0,
    });
    await workspace.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [
        parentEffectEnvelope(common, "00000000-0000-7000-8000-00000000040b"),
        parentEffectEnvelope(
          viewer(USER_ID, true),
          "00000000-0000-7000-8000-00000000040f",
        ),
      ],
    });

    const newerId = asWorkstreamId("00000000-0000-7000-8000-000000000411");
    await workspace.applyWorkstreamDirectoryEffects({ workspaceId: WORKSPACE_ID, envelopes: [
      parentEffectEnvelope({ ...common, title: "Newer unvisited", createdAt: "2026-08-27T20:00:00.000Z",
        lastActivityAt: "2026-08-28T20:00:00.000Z" },
      "00000000-0000-7000-8000-000000000412", 1, newerId),
    ] });
    const request = { workspaceId: WORKSPACE_ID, userId: USER_ID, limit: 1, includeSystem: false };
    expect((await workspace.listWorkstreams(request)).items[0]?.id).toBe(newerId);
    const first = await openWorkspaceSocket(workspace, "00000000-0000-7000-8000-000000000413");
    const peer = await openWorkspaceSocket(workspace, "00000000-0000-7000-8000-000000000414");
    const outsider = await openWorkspaceSocket(workspace, "00000000-0000-7000-8000-000000000416", otherSessionId, otherUserId);
    const outsiderEvents: string[] = [];
    outsider.addEventListener("message", (event) => { outsiderEvents.push(String(event.data)); });
    try {
      const appliedRevision = async (revision: number): Promise<void> => {
        await vi.waitFor(async () => {
          const observed = await runInDurableObject(workspace, (_instance, state) =>
            state.getWebSockets().some((socket) => {
              const attachment = socket.deserializeAttachment() as { presenceRevision: number };
              return attachment.presenceRevision === revision;
            }));
          expect(observed).toBe(true);
        });
      };
      first.send(JSON.stringify({ type: "set_presence", revision: 1,
        applicationState: "background", foregroundWorkstreamId: null }));
      await appliedRevision(1);
      expect((await workspace.listWorkstreams({ ...request, limit: 20 })).items
        .find((item) => item.id === WORKSTREAM_ID)?.lastAccessedAt).toBeNull();
      first.send(JSON.stringify({ type: "set_presence", revision: 2,
        applicationState: "foreground", foregroundWorkstreamId: null }));
      await appliedRevision(2);
      expect((await workspace.listWorkstreams({ ...request, limit: 20 })).items
        .find((item) => item.id === WORKSTREAM_ID)?.lastAccessedAt).toBeNull();
      // A Rally access support session as this person opens the channel without
      // recording that they visited it (docs/impersonation.md).
      const support = await openWorkspaceSocket(workspace, "00000000-0000-7000-8000-000000000419",
        SESSION_ID, USER_ID, otherUserId);
      support.send(JSON.stringify({ type: "set_presence", revision: 9,
        applicationState: "foreground", foregroundWorkstreamId: WORKSTREAM_ID }));
      await appliedRevision(9);
      support.close();
      expect((await workspace.listWorkstreams({ ...request, limit: 20 })).items
        .find((item) => item.id === WORKSTREAM_ID)?.lastAccessedAt).toBeNull();
      const delivered = nextMessageOfType(peer, "workspace_workstream_recency");
      first.send(JSON.stringify({ type: "set_presence", revision: 3,
        applicationState: "foreground", foregroundWorkstreamId: WORKSTREAM_ID }));
      expect(await delivered).toMatchObject({ workstream:
        { id: WORKSTREAM_ID, lastAccessedAt: expect.any(String) },
      });
      const outsiderBarrier = nextMessageOfType(outsider, "workspace_workstream_page");
      outsider.send(JSON.stringify({ type: "list_workstreams", requestId: "00000000-0000-7000-8000-000000000417", limit: 20, includeSystem: false }));
      await outsiderBarrier;
      expect(outsiderEvents.some((event) => event.includes('"type":"workspace_workstream_recency"'))).toBe(false);
      await evictDurableObject(workspace);
      const page = await workspace.listWorkstreams(request);
      expect(page.items[0]?.id).toBe(WORKSTREAM_ID);
      expect(page.items[0]?.lastAccessedAt).not.toBeNull();
      const socketPagePromise = nextMessageOfType(peer, "workspace_workstream_page");
      peer.send(JSON.stringify({
        type: "list_workstreams",
        requestId: "00000000-0000-7000-8000-000000000418",
        limit: 20,
        includeSystem: false,
      }));
      const socketPage = WorkspaceWorkstreamPageEventSchema.parse(await socketPagePromise);
      expect(socketPage.items.map(({ id, scope }) => ({ id, scope }))).toEqual([
        { id: WORKSTREAM_ID, scope: "workspace" },
        { id: newerId, scope: "workspace" },
      ]);
      const legacyPage = await workspace.listWorkstreams({ ...request,
        before: `${Date.parse("2026-08-28T20:00:00.000Z")}:${newerId}` });
      expect(legacyPage.items[0]?.id).toBe(WORKSTREAM_ID);
      const next = await workspace.listWorkstreams({ ...request, before: page.nextCursor! });
      expect(next.items.map((item) => item.id)).toEqual([newerId]);
      expect((await workspace.listWorkstreams({ ...request, userId: otherUserId })).items[0]?.id).toBe(newerId);
      const targets = await workspace.batchUpdateTargets({ workspaceId: WORKSPACE_ID, userId: USER_ID,
        filter: { recency: "access", lastActivityAt: { atOrAfter: page.items[0]!.lastAccessedAt! }, includeSystem: false } });
      expect(targets.items).toEqual([WORKSTREAM_ID]);
      await workspace.applyWorkstreamDirectoryEffects({ workspaceId: WORKSPACE_ID, envelopes: [
        parentEffectEnvelope({ ...common, lastActivityAt: "2099-01-01T00:00:00.000Z" },
          "00000000-0000-7000-8000-000000000415", 2, newerId),
      ] });
      expect((await workspace.listWorkstreams(request)).items[0]?.id).toBe(WORKSTREAM_ID);
    } finally {
      first.close();
      peer.close();
      outsider.close();
    }
  });

  it("orders presence across hibernation and clears it when directory visibility changes", async () => {
    await seedOpenAuthority();
    const otherUserId = asUserId("00000000-0000-7000-8000-00000000040a");
    const otherSessionId = `${SESSION_ID}-presence`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
        VALUES (?, ?, 'active', 'member', '2026-08-26T20:00:00.000Z')`).bind(WORKSPACE_ID, otherUserId),
      env.DB.prepare(`INSERT INTO sessions
        (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(otherSessionId, otherUserId, WORKSPACE_ID),
    ]);
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
    const at = "2026-08-26T20:00:00.000Z";
    const common = {
      kind: "directory_common" as const,
      title: "Foreground presence",
      description: "Presence does not follow pooled sockets",
      preview: "idle",
      scope: "workspace" as const,
      state: "idle",
      systemKind: null,
      lastActivityAt: at,
      completedAt: null,
      archivedAt: null,
      createdByUserId: null,
      latestAttentionOrdinal: 0,
      unreadTrackingStartOrdinal: 0,
      createdAt: at,
      updatedAt: at,
    };
    const viewer = (userId: string, isParticipant: boolean) => ({
      kind: "directory_user" as const,
      userId,
      isParticipant,
      unreadCount: 0,
      youAreMentioned: false,
      listable: isParticipant,
      seenAttentionOrdinal: 0,
      manualUnreadFromOrdinal: null,
      manualUnreadGeneration: 0,
      latestMentionAttentionOrdinal: 0,
    });
    await workspace.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [
        parentEffectEnvelope(common, "00000000-0000-7000-8000-00000000040b"),
        parentEffectEnvelope(
          viewer(USER_ID, true),
          "00000000-0000-7000-8000-00000000040f",
        ),
      ],
    });

    const first = await openWorkspaceSocket(
      workspace,
      "00000000-0000-7000-8000-00000000040c",
    );
    const second = await openWorkspaceSocket(
      workspace,
      "00000000-0000-7000-8000-00000000040d",
      otherSessionId,
      otherUserId,
    );
    try {
      const firstUpdate = nextMessage(first);
      first.send(JSON.stringify({
        type: "set_presence",
        revision: 1,
        applicationState: "foreground",
        foregroundWorkstreamId: WORKSTREAM_ID,
      }));
      expect(JSON.parse(String((await firstUpdate).data))).toMatchObject({
        type: "workspace_presence",
        workstreamId: WORKSTREAM_ID,
        userIds: [],
      });
      await evictDurableObject(workspace);
      // An auth query yields the DO input gate. A newer revision must fence an
      // older handler that resumes later, even when the newer state itself did
      // not change and therefore emitted no snapshot.
      first.send(JSON.stringify({
        type: "set_presence",
        revision: 2,
        applicationState: "foreground",
        foregroundWorkstreamId: WORKSTREAM_ID,
      }));
      first.send(JSON.stringify({
        type: "set_presence",
        revision: 1,
        applicationState: "background",
        foregroundWorkstreamId: null,
      }));
      const firstAfterWake = nextMessage(first);
      const secondAfterWake = nextMessage(second);
      second.send(JSON.stringify({
        type: "set_presence",
        revision: 1,
        applicationState: "foreground",
        foregroundWorkstreamId: WORKSTREAM_ID,
      }));
      expect(JSON.parse(String((await firstAfterWake).data))).toMatchObject({
        type: "workspace_presence",
        workstreamId: WORKSTREAM_ID,
        userIds: [otherUserId],
      });
      expect(JSON.parse(String((await secondAfterWake).data))).toMatchObject({
        type: "workspace_presence",
        workstreamId: WORKSTREAM_ID,
        userIds: [USER_ID],
      });

      const firstBackgrounded = nextMessage(first);
      second.send(JSON.stringify({
        type: "set_presence",
        revision: 2,
        applicationState: "background",
        foregroundWorkstreamId: null,
      }));
      expect(JSON.parse(String((await firstBackgrounded).data))).toMatchObject({
        type: "workspace_presence",
        workstreamId: WORKSTREAM_ID,
        userIds: [],
      });
      expect(first.readyState).toBe(WebSocket.OPEN);
      expect(second.readyState).toBe(WebSocket.OPEN);

      const firstReforegrounded = nextMessageOfType(first, "workspace_presence");
      const secondReforegrounded = nextMessageOfType(second, "workspace_presence");
      second.send(JSON.stringify({
        type: "set_presence",
        revision: 3,
        applicationState: "foreground",
        foregroundWorkstreamId: WORKSTREAM_ID,
      }));
      await Promise.all([firstReforegrounded, secondReforegrounded]);

      // Narrowing a workspace stream to personal removes a foreground viewer
      // who has no participant row. The remaining viewer gets a canonical
      // empty set while the removed socket stays connected but backgrounded.
      const afterScopeRestriction = nextMessageOfType(first, "workspace_presence");
      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [parentEffectEnvelope(
          { ...common, scope: "personal", updatedAt: "2026-08-26T20:01:00.000Z" },
          "00000000-0000-7000-8000-000000000410",
          2,
        )],
      });
      expect(await afterScopeRestriction).toMatchObject({
        workstreamId: WORKSTREAM_ID,
        userIds: [],
      });
      await runInDurableObject(workspace, (_instance, state) => {
        const removed = state.getWebSockets()
          .map((socket) => socket.deserializeAttachment() as Record<string, unknown>)
          .find((candidate) => candidate.userId === otherUserId);
        expect(removed).toMatchObject({
          applicationState: "background",
          foregroundWorkstreamId: null,
        });
      });

      // Restore broad visibility, seat the second viewer, then narrow again.
      // Restoring access alone must not resurrect the cleared attachment.
      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [
          parentEffectEnvelope(
            { ...common, updatedAt: "2026-08-26T20:02:00.000Z" },
            "00000000-0000-7000-8000-000000000411",
            3,
          ),
          parentEffectEnvelope(
            viewer(otherUserId, true),
            "00000000-0000-7000-8000-000000000412",
          ),
        ],
      });
      const firstAfterParticipantJoin = nextMessageOfType(first, "workspace_presence");
      const secondAfterParticipantJoin = nextMessageOfType(second, "workspace_presence");
      second.send(JSON.stringify({
        type: "set_presence",
        revision: 4,
        applicationState: "foreground",
        foregroundWorkstreamId: WORKSTREAM_ID,
      }));
      await Promise.all([firstAfterParticipantJoin, secondAfterParticipantJoin]);
      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [parentEffectEnvelope(
          { ...common, scope: "personal", updatedAt: "2026-08-26T20:03:00.000Z" },
          "00000000-0000-7000-8000-000000000413",
          4,
        )],
      });

      const afterParticipantRemoval = nextMessageOfType(first, "workspace_presence");
      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [parentEffectEnvelope(
          viewer(otherUserId, false),
          "00000000-0000-7000-8000-000000000414",
          2,
        )],
      });
      expect(await afterParticipantRemoval).toMatchObject({
        workstreamId: WORKSTREAM_ID,
        userIds: [],
      });

      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [parentEffectEnvelope(
          viewer(otherUserId, true),
          "00000000-0000-7000-8000-000000000415",
          3,
        )],
      });
      const firstBeforeArchive = nextMessageOfType(first, "workspace_presence");
      const secondBeforeArchive = nextMessageOfType(second, "workspace_presence");
      second.send(JSON.stringify({
        type: "set_presence",
        revision: 5,
        applicationState: "foreground",
        foregroundWorkstreamId: WORKSTREAM_ID,
      }));
      await Promise.all([firstBeforeArchive, secondBeforeArchive]);

      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [parentEffectEnvelope(
          {
            ...common,
            scope: "personal",
            archivedAt: "2026-08-26T20:04:00.000Z",
            updatedAt: "2026-08-26T20:04:00.000Z",
          },
          "00000000-0000-7000-8000-000000000416",
          5,
        )],
      });
      await runInDurableObject(workspace, (_instance, state) => {
        const attachments = state.getWebSockets()
          .map((socket) => socket.deserializeAttachment() as Record<string, unknown>);
        expect(attachments).toHaveLength(2);
        expect(attachments).toEqual(expect.arrayContaining([
          expect.objectContaining({
            userId: USER_ID,
            applicationState: "background",
            foregroundWorkstreamId: null,
          }),
          expect.objectContaining({
            userId: otherUserId,
            applicationState: "background",
            foregroundWorkstreamId: null,
          }),
        ]));
      });
    } finally {
      first.close(1000, "test complete");
      second.close(1000, "test complete");
    }
  });

  it("keeps the socket open on presence for an unlisted Channel and applies it once the Channel is listed", async () => {
    await seedOpenAuthority();
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
    const socket = await openWorkspaceSocket(workspace, "00000000-0000-7000-8000-000000000419");
    const closed = nextClose(socket).then((event) => {
      throw new Error(`workspace socket closed with ${event.code}`);
    });
    try {
      socket.send(JSON.stringify({
        type: "set_presence",
        revision: 1,
        applicationState: "foreground",
        foregroundWorkstreamId: WORKSTREAM_ID,
      }));
      // Frames are handled in order, so a page answered after the presence
      // frame proves the socket outlived it.
      const page = nextMessageOfType(socket, "workspace_workstream_page");
      socket.send(JSON.stringify({
        type: "list_workstreams",
        requestId: "00000000-0000-7000-8000-00000000041a",
        limit: 20,
        includeSystem: false,
      }));
      await Promise.race([page, closed]);
      const attachment = await runInDurableObject(workspace, (_instance, state) =>
        state.getWebSockets()[0]!.deserializeAttachment() as Record<string, unknown>);
      expect(attachment).toMatchObject({
        presenceRevision: 1,
        applicationState: "foreground",
        foregroundWorkstreamId: null,
      });

      // The renderer does not resend for a route it has not left, so the
      // directory change that lists the Channel is what applies the presence.
      const at = "2026-08-26T20:00:00.000Z";
      const opened = nextMessageOfType(socket, "workspace_workstream_recency");
      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [
          parentEffectEnvelope({
            kind: "directory_common",
            title: "Listed after it was opened",
            description: "",
            preview: "idle",
            scope: "workspace",
            state: "idle",
            systemKind: null,
            lastActivityAt: at,
            completedAt: null,
            archivedAt: null,
            createdByUserId: null,
            latestAttentionOrdinal: 0,
            unreadTrackingStartOrdinal: 0,
            createdAt: at,
            updatedAt: at,
          }, "00000000-0000-7000-8000-00000000041b"),
          parentEffectEnvelope({
            kind: "directory_user",
            userId: USER_ID,
            isParticipant: true,
            unreadCount: 0,
            youAreMentioned: false,
            listable: true,
            seenAttentionOrdinal: 0,
            manualUnreadFromOrdinal: null,
            manualUnreadGeneration: 0,
            latestMentionAttentionOrdinal: 0,
          }, "00000000-0000-7000-8000-00000000041c"),
        ],
      });
      expect(await Promise.race([opened, closed])).toMatchObject({
        workstream: { id: WORKSTREAM_ID, lastAccessedAt: expect.any(String) },
      });
      const promoted = await runInDurableObject(workspace, (_instance, state) =>
        state.getWebSockets()[0]!.deserializeAttachment() as Record<string, unknown>);
      expect(promoted).toMatchObject({
        applicationState: "foreground",
        foregroundWorkstreamId: WORKSTREAM_ID,
        pendingForegroundWorkstreamId: null,
      });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("re-evaluates a changed product flag privately for subscribed users", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const socket = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-00000000060b");
    try {
      const delivered = nextMessage(socket);
      await expect(stub.notifyProductFeatureFlagChanged(
        "suggested-work-enabled",
        WORKSPACE_ID,
        "wnam",
      )).resolves.toBe(1);
      expect(JSON.parse(String((await delivered).data))).toMatchObject({
        type: "workspace_feature_flags",
        changedFlag: "suggested-work-enabled",
        flags: { suggestedWorkEnabled: false },
      });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("sends the meter after a plan change to every member socket, never a guest's, and drops one read before the last sent", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    // Opened first and marked while it is the only socket, so the mark is on
    // this one.
    const guest = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-00000000060e");
    await runInDurableObject(stub, (_instance, state) => {
      const [socket] = state.getWebSockets();
      socket!.serializeAttachment({ ...(socket!.deserializeAttachment() as object), accessClass: "guest" });
    });
    const first = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-00000000060c");
    const second = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-00000000060d");
    const usage = (plan: "starter" | "growth", quotaRemainingPercent: number) => ({
      plan,
      quotaRemainingPercent,
      weekResetsAt: "2026-10-08T09:00:00.000Z",
      overage: {
        amountMicrousd: 0,
        periodStart: "2026-10-01T09:00:00.000Z",
        periodEndsAt: "2026-11-01T09:00:00.000Z",
        billed: false as const,
      },
    });
    const guestHeard: unknown[] = [];
    guest.addEventListener("message", (event) => {
      const decoded = JSON.parse(String(event.data)) as { type?: string };
      if (decoded.type === "workspace_usage") guestHeard.push(decoded);
    });
    try {
      const delivered = [nextMessageOfType(first, "workspace_usage"), nextMessageOfType(second, "workspace_usage")];
      await expect(stub.publishUsage(usage("growth", 44), "2026-10-03T00:00:02.000Z", WORKSPACE_ID, "wnam"))
        .resolves.toBe(2);
      for (const message of await Promise.all(delivered)) {
        expect(message).toMatchObject({ type: "workspace_usage", usage: usage("growth", 44) });
      }
      // The push for an earlier change, arriving last, would put Starter back.
      await expect(stub.publishUsage(usage("starter", 0), "2026-10-03T00:00:01.000Z", WORKSPACE_ID, "wnam"))
        .resolves.toBe(0);
      expect(guestHeard).toEqual([]);
    } finally {
      first.close(1000, "test complete");
      second.close(1000, "test complete");
      guest.close(1000, "test complete");
    }
  });

  it("distinguishes an invalid workspace frame from access revocation and logs only its shape", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const socket = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-00000000060a");
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as { env: Env };
      target.env = new Proxy(target.env, {
        get: (current, property, receiver) => property === "LOG_LEVEL"
          ? "info"
          : Reflect.get(current, property, receiver),
      });
    });
    try {
      const closed = nextClose(socket);
      socket.send(JSON.stringify({ type: "subscribe", afterWaterline: "invalid", text: "must not reach logs" }));
      const event = await closed;
      expect(event.code).toBe(WORKSPACE_SOCKET_INVALID_MESSAGE_CODE);
      expect(event.code).not.toBe(1008);
      expect(event.reason).toBe("Invalid workspace socket event");
      expect(logged).toHaveBeenCalledTimes(1);
      const entry = logged.mock.calls[0]![0] as Record<string, unknown>;
      expect(entry).toMatchObject({
        event: "workspace_socket_closed",
        code: "invalid_event",
        close_code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
        operation: "validate",
        workspace_id: WORKSPACE_ID,
        user_id: USER_ID,
        validation_issues: expect.any(Array),
      });
      expect(JSON.stringify(entry)).not.toContain("must not reach logs");
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it.each(["revocation", "membership replacement"])("distinguishes an inactive session from access revocation after %s", async (change) => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const socket = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-00000000060b");
    if (change === "revocation") {
      await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`)
        .bind("2026-08-24T20:00:00.000Z", SESSION_ID).run();
    } else {
      await env.DB.prepare("UPDATE workspace_members SET incarnation='replacement-membership' WHERE workspace_id=? AND user_id=?")
        .bind(WORKSPACE_ID,USER_ID).run();
    }
    try {
      const closed = nextClose(socket);
      socket.send(JSON.stringify({
        type: "list_workstreams",
        requestId: "00000000-0000-7000-8000-00000000060c",
        limit: 1,
        includeSystem: false,
      }));
      const event = await closed;
      expect(event.code).toBe(WORKSPACE_SOCKET_SESSION_INACTIVE_CODE);
      expect(event.code).not.toBe(1008);
      expect(event.reason).toBe("Session no longer active");
    } finally {
      socket.close(1000, "test complete");
    }
  });


  it("closes a workspace socket when told the person lost access, and names their work streams", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const socket = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-000000000601");
    try {
      const closed = nextClose(socket);
      const result = await stub.revokeSocketAccess({
        reason: "workspace_membership_removed",
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        sessionId: null,
      });
      expect((await closed).code).toBe(1008);
      // The consumer carries the revocation onward from this list, so an empty
      // directory and a missing directory must not look the same.
      expect(Array.isArray(result.workstreamIds)).toBe(true);
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("closes only the windows that presented a revoked session", async () => {
    await seedOpenAuthority();
    const otherSessionId = `${SESSION_ID}-second`;
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
       VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`,
    ).bind(otherSessionId, USER_ID, WORKSPACE_ID).run();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const revoked = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-000000000602");
    const kept = await openWorkspaceSocket(
      stub,
      "00000000-0000-7000-8000-000000000603",
      otherSessionId,
    );
    try {
      const closed = nextClose(revoked);
      const delivered = nextMessage(kept);
      await stub.revokeSocketAccess({
        reason: "session_revoked",
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
      expect((await closed).code).toBe(1008);
      // The other window is untouched, and proves it by still receiving.
      await stub.publishSync(["automations"], WORKSPACE_ID, "wnam");
      expect(JSON.parse(String((await delivered).data))).toMatchObject({ type: "workspace_sync" });
    } finally {
      revoked.close(1000, "test complete");
      kept.close(1000, "test complete");
    }
  });

  it("names a work stream's substreams when its access is revoked", async () => {
    await seedOpenAuthority();
    const parent = hostedParentStub(env, WORKSPACE_ID);
    await parent.receiveChildEffects({
      substreamId: "0",
      envelopes: [childEffectEnvelope({
        kind: "directory_common",
        title: "Revocation fan-out",
        description: "Names its own children",
        preview: "idle",
        scope: "workspace",
        state: "idle",
        systemKind: null,
        lastActivityAt: "2026-08-22T12:00:00.000Z",
        completedAt: null,
        archivedAt: null,
      }, "00000000-0000-7000-8000-000000000604")],
    });
    const result = await parent.revokeParentSocketAccess({
      parentId: WORKSTREAM_ID,
      revocation: {
        reason: "workspace_membership_removed",
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        sessionId: null,
      },
    });
    // The main substream keeps the historical name and is never in the
    // directory, so a walk that only read the table would skip the one object
    // holding the transcript.
    expect(result.substreamIds).toContain("0");
  });

  it("pushes a child state change to the workspace socket once its parent forwards it", async () => {
    await seedOpenAuthority();
    const outsiderId = "00000000-0000-7000-8000-000000000401";
    // Two members of the same workspace, each with a live session, so the only
    // thing separating them is participation in the work stream itself.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
        VALUES (?, ?, 'active', 'member', '2026-08-21T20:00:00.000Z')`).bind(WORKSPACE_ID, outsiderId),
      env.DB.prepare(`INSERT INTO sessions
        (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(`${SESSION_ID}-${USER_ID}`, USER_ID, WORKSPACE_ID),
      env.DB.prepare(`INSERT INTO sessions
        (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(`${SESSION_ID}-${outsiderId}`, outsiderId, WORKSPACE_ID),
    ]);
    const workspaceStub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await workspaceStub.initializeWorkspace(WORKSPACE_ID, "wnam");

    const connect = async (userId: string, ticketId: string): Promise<WebSocket> => {
      const response = await workspaceStub.fetch("https://workspace.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-rally-workspace-id": WORKSPACE_ID,
          "x-rally-placement-affinity": "wnam",
          "x-rally-user-id": userId,
          "x-rally-session-id": `${SESSION_ID}-${userId}`,
          "x-rally-socket-ticket-id": ticketId,
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        },
      });
      if (response.status !== 101) {
        throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
      }
      const socket = response.webSocket!;
      socket.accept();
      const initial = nextMessage(socket);
      socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      expect(JSON.parse(String((await initial).data))).toMatchObject({ type: "workspace_sync" });
      return socket;
    };

    const participant = await connect(USER_ID, "00000000-0000-7000-8000-000000000402");
    const outsider = await connect(outsiderId, "00000000-0000-7000-8000-000000000403");

    // The row itself, not an invalidation to go and fetch it with. The common
    // effect can land before the viewer effect, in which case the first frame
    // is a tombstone (a personal work stream with no participant row yet), so
    // the wait is for the frame that carries the transition.
    const participantPush = nextMatchingMessage(
      participant,
      "workspace_workstream_state",
      (frame) => frame.workstream !== null,
    );
    const outsiderFrames: string[] = [];
    outsider.addEventListener("message", (event) => { outsiderFrames.push(String(event.data)); });
    const at = "2026-08-21T20:00:00.000Z";
    // A run finishing, as the child reports it: the consumer hands it to the
    // Organization object, whose hosted parent sums it into the work stream's
    // row, and whose directory step then pushes that row to every subscribed
    // sidebar, in the same delivery.
    await expect(consumeEffectBodies(env, [
      childEffectEnvelope({
        kind: "directory_common",
        title: "Finished while the sidebar watched",
        description: "Pushed as soon as the parent forwards it",
        preview: "completed",
        // Personal, so the outsider is not an audience for it.
        scope: "personal",
        state: "completed",
        systemKind: null,
        lastActivityAt: at,
        completedAt: at,
        archivedAt: null,
        createdByUserId: USER_ID,
        latestAttentionOrdinal: 3,
        unreadTrackingStartOrdinal: 0,
        createdAt: at,
        updatedAt: at,
      }, "00000000-0000-7000-8000-000000000404"),
      childEffectEnvelope({
        kind: "directory_user",
        userId: USER_ID,
        isParticipant: true,
        unreadCount: 1,
        youAreMentioned: false,
        listable: true,
        seenAttentionOrdinal: 2,
        manualUnreadFromOrdinal: null,
        manualUnreadGeneration: 0,
        latestMentionAttentionOrdinal: 0,
      }, "00000000-0000-7000-8000-000000000405"),
    ])).resolves.toEqual({ acked: 2, retried: 0 });
    // Both projections were applied to the directory locally, not queued.
    await runInDurableObject(workspaceStub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM parent_outbox WHERE parent_id = ?`, WORKSTREAM_ID,
      ).one().count).toBe(0);
    });

    expect(await participantPush).toMatchObject({
      type: "workspace_workstream_state",
      workstreamId: WORKSTREAM_ID,
      workstream: { harnessStatus: "completed", title: "Finished while the sidebar watched" },
    });
    // The outsider is subscribed to the same workspace and hears nothing of
    // it, not even a tombstone: a personal work stream they never saw is not
    // theirs to learn the id of because someone else's run finished. Every
    // frame sent before the ping has arrived once its auto-response has.
    const pong = new Promise<void>((resolve) => {
      outsider.addEventListener("message", (event) => { if (String(event.data) === "pong") resolve(); });
    });
    outsider.send("ping");
    await pong;
    expect(outsiderFrames.filter((frame) => frame.includes(WORKSTREAM_ID))).toEqual([]);
  });

  it("pushes a generated name to a participant who never opened the work stream", async () => {
    await seedOpenAuthority();
    const participantId = "00000000-0000-7000-8000-000000000406";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
        VALUES (?, ?, 'active', 'member', '2026-08-24T20:00:00.000Z')`).bind(WORKSPACE_ID, participantId),
      env.DB.prepare(`INSERT INTO sessions
        (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(`${SESSION_ID}-${participantId}`, participantId, WORKSPACE_ID),
      // Naming somebody on the create is an add, and an add is told about, so
      // the effects the create enqueues carry both people's display names.
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
        VALUES (?, 'creator@example.com', 'Creator', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
        .bind(USER_ID),
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
        VALUES (?, 'participant@example.com', 'Participant', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
        .bind(participantId),
      // The opening message is also an activity event, and the consumer
      // applies one of those only under the work stream's active route.
      // Bootstrap reads it to refuse a Space or Sidekick id a Channel create claimed.
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
        workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
        state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
      )`),
      env.DB.prepare(`CREATE TABLE workstream_authority_routes (
        workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
        object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
        source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
        source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
        verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
      )`),
      env.DB.prepare(`INSERT INTO workstream_authority_routes
        (workspace_id, workstream_id, generation, object_name, state, source_fence_sequence, updated_at)
        VALUES (?, ?, 1, ?, 'active', 0, '2026-08-24T20:00:00.000Z')`)
        .bind(WORKSPACE_ID, WORKSTREAM_ID, conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID)),
    ]);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    // Both outboxes stay readable: the effects are walked to the workspace by
    // hand below, and an alarm that beat the walk would send them nowhere.
    // The Organization's holds only the activity rows its hosted parent queues.
    await holdActivityQueue(child);
    await holdActivityQueue(workspace);
    // Created the way `POST /workstreams` creates one it has no title for: the
    // first line of the request stands in, and `naming` promises a name.
    await runInDurableObject(child, async (instance) => {
      const product = (instance as unknown as { product: WorkstreamObjectProductService }).product;
      await product.initialize({
        sessionId: SESSION_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        region: "global" as const,
        role: "member" as const,
      }, {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        generation: 1,
        title: "let's talk about avalon pricing",
        objective: "let's talk about avalon pricing",
        descriptionSource: "authored" as const,
        titleStatus: "naming" as const,
        emailAddress: null,
        creatorUserId: USER_ID,
        openingMessage: "let's talk about avalon pricing",
        openingStructuredContent: null,
        clientMessageId: "naming-push-client-message",
        participantUserIds: [participantId],
        attachmentIds: [],
        originResourceIds: [],
        scope: "workspace" as const,
        modelOverride: "test-model",
        systemKind: null,
        createdFromOpportunityId: null,
        opportunityVersion: null,
        opportunityDisplayPromptHash: null,
        opportunityExecutionPromptHash: null,
        executionPrincipal: { type: "user", userId: USER_ID },
        reason: "user_message",
      });
    });
    const created = await deliverEffectsToWorkspaceInOrder(env, child);
    expect(created.child.map((envelope) => envelope.effect.kind)).toContain("directory_common");
    // The directory step ran in the Organization object as the parent applied
    // the child's effects; only activity is left for the Queue.
    expect(created.parent.map((envelope) => envelope.effect.kind)).not.toContain("directory_common");
    await expect(workspace.lookupWorkstreamDirectory({
      workspaceId: WORKSPACE_ID,
      workstreamIds: [WORKSTREAM_ID],
    })).resolves.toMatchObject({ items: [{ workstreamId: WORKSTREAM_ID }] });

    // The participant is watching the sidebar and nothing else: no work-stream
    // room socket, so the `workstream_renamed` event the naming service
    // publishes to the room reaches nobody here. This frame is their only path
    // to the name.
    const response = await workspace.fetch("https://workspace.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": participantId,
        "x-rally-session-id": `${SESSION_ID}-${participantId}`,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000407",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const subscribed = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
    expect(JSON.parse(String((await subscribed).data))).toMatchObject({ type: "workspace_sync" });
    // The opening message starts a run, and the run's own state changes ride
    // the same legs as the rename, so an earlier frame can still carry the
    // placeholder title. The wait is for the frame that carries the name.
    const push = nextMatchingMessage(
      socket,
      "workspace_workstream_state",
      (frame) => (frame.workstream as { titleStatus?: string } | null)?.titleStatus !== "naming",
    );

    // Exactly the operation the naming service issues once the model answers,
    // through the port it issues it on. It was a routed `UPDATE workstreams`
    // fenced on `title_status`; the identity authority holds that fence now
    // and answers `renamed` or `superseded` rather than a row count.
    const named = await child.executeIdentityOperation({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "rename",
      args: [{
        title: "Avalon pricing conversation",
        icon: "coins",
        from: "naming",
        to: "automatic",
        now: Date.now(),
      }],
    });
    expect(named.status).toBe(200);

    // The rename rides the same leg the creation did: child to the
    // Organization object, whose directory step pushes the row.
    const renamed = await deliverEffectsToWorkspaceInOrder(env, child);
    expect(renamed.child.map((envelope) => envelope.effect.kind)).toContain("directory_common");

    expect(await push).toMatchObject({
      type: "workspace_workstream_state",
      workstreamId: WORKSTREAM_ID,
      // The icon the pass chose rides the same legs as the name. This
      // participant has no room socket, so the `workstream_renamed` event that
      // carries the icon to an open header reaches nobody here — the directory
      // projection is their only path to the glyph as well as to the name.
      workstream: {
        title: "Avalon pricing conversation",
        titleStatus: "automatic",
        appearance: { icon: "coins", color: null },
      },
    });
  });

  it("owns and pages the viewer-specific work-stream directory in WorkspaceDO SQL", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const common: DirectoryCommonEffect = {
      kind: "directory_common",
      title: "Workspace-owned sidebar",
      description: "No D1 serving projection",
      preview: "Authoritative in WorkspaceDO",
      scope: "personal",
      state: "running",
      systemKind: null,
      lastActivityAt: "2026-08-17T20:00:00.000Z",
      completedAt: null,
      archivedAt: null,
      createdByUserId: USER_ID,
      latestAttentionOrdinal: 4,
      unreadTrackingStartOrdinal: 0,
      createdAt: "2026-08-17T19:00:00.000Z",
      updatedAt: "2026-08-17T20:00:00.000Z",
      resourceLinks: [{
        resourceId: "00000000-0000-7000-8000-000000000108",
        watchEnabled: true,
        relationshipType: "context",
      }],
    };
    const viewer: DirectoryUserEffect = {
      kind: "directory_user",
      userId: USER_ID,
      isParticipant: true,
      unreadCount: 2,
      youAreMentioned: true,
      listable: true,
      seenAttentionOrdinal: 2,
      manualUnreadFromOrdinal: null,
      manualUnreadGeneration: 0,
      latestMentionAttentionOrdinal: 4,
    };
    await expect(stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [
        parentEffectEnvelope(common, "00000000-0000-7000-8000-000000000201"),
        parentEffectEnvelope(viewer, "00000000-0000-7000-8000-000000000202"),
      ],
    })).resolves.toMatchObject({ directoryChanged: true });

    const page = await stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      limit: 20,
      includeSystem: false,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: WORKSTREAM_ID,
      title: "Workspace-owned sidebar",
      harnessStatus: "running",
      hasUnread: true,
      youAreMentioned: true,
    });
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [parentEffectEnvelope(
        {
          ...viewer,
          unreadCount: 9,
          youAreMentioned: false,
          latestMentionAttentionOrdinal: 2,
        },
        "00000000-0000-7000-8000-000000000203",
        3,
      )],
    });
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [parentEffectEnvelope(
        { ...viewer, unreadCount: 1, youAreMentioned: true },
        "00000000-0000-7000-8000-000000000204",
        2,
      )],
    });
    const afterReorder = await stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      limit: 20,
      includeSystem: false,
    });
    expect(afterReorder.items[0]).toMatchObject({ hasUnread: true, youAreMentioned: false });
    expect(afterReorder.stateVersions[0]).toMatchObject({ viewerWaterline: 3 });

    // A replacement authority's viewer row may beat its common row through
    // the unordered Queue. Once the common row arrives, the WorkspaceDO must
    // expose the new generation's low waterline instead of retaining the old
    // generation's numerically larger viewer waterline.
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [{
        ...parentEffectEnvelope(viewer, "00000000-0000-7000-8000-000000000205"),
        generation: 2,
      }],
    });
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [{
        ...parentEffectEnvelope(
          { ...common, title: "Replacement authority" },
          "00000000-0000-7000-8000-000000000206",
        ),
        generation: 2,
      }],
    });
    const afterGenerationChange = await stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      limit: 20,
      includeSystem: false,
    });
    expect(afterGenerationChange.items[0]).toMatchObject({
      title: "Replacement authority",
      youAreMentioned: true,
    });
    expect(afterGenerationChange.stateVersions[0]).toMatchObject({
      authorityGeneration: 2,
      commonWaterline: 1,
      viewerWaterline: 1,
    });

    const tiedCommon: DirectoryCommonEffect = {
      ...common,
      scope: "workspace",
      title: "Tied recency",
      resourceLinks: [],
    };
    const tiedIds = [
      "00000000-0000-7000-8000-000000000106",
      "00000000-0000-7000-8000-000000000107",
    ];
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: tiedIds.map((workstreamId, index) => parentEffectEnvelope(
        tiedCommon,
        `00000000-0000-7000-8000-${(0x210 + index).toString(16).padStart(12, "0")}`,
        1,
        asWorkstreamId(workstreamId),
      )),
    });
    const pagedIds: string[] = [];
    let before: string | undefined;
    do {
      const tiedPage = await stub.listWorkstreams({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        limit: 1,
        includeSystem: false,
        ...(before ? { before } : {}),
      });
      pagedIds.push(...tiedPage.items.map((item) => item.id));
      before = tiedPage.nextCursor ?? undefined;
    } while (before);
    expect(pagedIds).toEqual([WORKSTREAM_ID, ...tiedIds]);
    const firstVisiblePage = await stub.visibleWorkstreamIds({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      includeSystem: false,
      participantsOnly: false,
      limit: 2,
    });
    expect(firstVisiblePage).toEqual({
      items: [WORKSTREAM_ID, tiedIds[0]],
      nextCursor: tiedIds[0],
    });
    await expect(stub.visibleWorkstreamIds({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      includeSystem: false,
      participantsOnly: false,
      after: firstVisiblePage.nextCursor!,
      limit: 2,
    })).resolves.toEqual({ items: [tiedIds[1]], nextCursor: null });
    await expect(stub.workstreamsForResource({
      workspaceId: WORKSPACE_ID,
      resourceId: "00000000-0000-7000-8000-000000000108",
      watchedOnly: true,
    })).resolves.toEqual({ workstreamIds: [WORKSTREAM_ID] });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM channels`,
      ).one().count).toBe(3);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM channel_viewers`,
      ).one().count).toBe(1);
    });
  });

  it("answers subscribe with the whole sidebar", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");

    const common: DirectoryCommonEffect = {
      kind: "directory_common",
      title: "Opened in one round trip",
      description: "One answer, three lists",
      preview: "One answer, three lists",
      scope: "workspace",
      state: "running",
      systemKind: null,
      lastActivityAt: "2026-08-21T20:00:00.000Z",
      completedAt: null,
      archivedAt: null,
      createdByUserId: USER_ID,
      latestAttentionOrdinal: 1,
      unreadTrackingStartOrdinal: 0,
      createdAt: "2026-08-21T19:00:00.000Z",
      updatedAt: "2026-08-21T20:00:00.000Z",
      resourceLinks: [],
    };
    await expect(stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [parentEffectEnvelope(common, "00000000-0000-7000-8000-000000000701")],
    })).resolves.toMatchObject({ directoryChanged: true });

    // Notes remain workspace product state. Automations arrive as the row
    // their own AutomationDO publishes through its outbox.
    const subscriptionId = "00000000-0000-7000-8000-000000000704";
    const resourceId = "00000000-0000-7000-8000-000000000705";
    await expect(stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-000000000707",
      statements: [
        {
          sql: `INSERT INTO resources
            (id, workspace_id, resource_type, provider, title, created_at, updated_at)
            VALUES (?, ?, 'note', 'avalon', 'Standup', '2026-08-21T19:00:00.000Z',
                    '2026-08-21T19:00:00.000Z')`,
          params: [resourceId, WORKSPACE_ID],
        },
      ],
    })).resolves.toMatchObject({ status: 200 });
    await writeSidekickDirectoryRow(env, {
        workspaceId: WORKSPACE_ID,
        automationId: subscriptionId,
        authorUserId: USER_ID,
        lifecycle: "active",
        scope: "workspace",
        title: "Monday brief",
        description: "Every Monday",
        nextRunAt: null,
      });
    const response = await stub.fetch("https://workspace.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000708",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    socket!.accept();

    try {
      // The only thing the client says is where it got to. Everything the
      // sidebar paints comes back on the answer, without being named.
      const answer = nextMessage(socket!);
      socket!.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      const event = JSON.parse(String((await answer).data)) as {
        type: string;
        reason: string;
        sidebar: {
          workstreams: { items: Array<{ id: string; title: string }>; nextCursor: string | null };
          automations: { waterline: number; items: Array<{ id: string; name: string; emailAddress: string | null }> };
          notes: { waterline: number; items: Array<{ id: string; title: string }> };
        };
        featureFlags: { suggestedWorkEnabled: boolean };
      };

      expect(event.type).toBe("workspace_sync");
      expect(event.reason).toBe("initial");
      expect(event.featureFlags).toMatchObject({ suggestedWorkEnabled: false });
      const page = event.sidebar;
      expect(page).toBeDefined();
      expect(page.workstreams.items).toHaveLength(1);
      expect(page.workstreams.items[0]).toMatchObject({
        id: WORKSTREAM_ID,
        title: "Opened in one round trip",
      });
      expect(page.workstreams.nextCursor).toBeNull();
      expect(page.automations.items).toHaveLength(1);
      expect(page.automations.items[0]).toMatchObject({ id: subscriptionId, name: "Monday brief" });
      // Served as stored: reconciling a route is a Global-registry call, and
      // this handler runs on the object's single thread beside the directory
      // read. The REST refresh is what fills it in.
      expect(page.automations.items[0]?.emailAddress).toBeNull();
      expect(page.notes.items).toEqual([]);
      // The batch carries the same counters the pushes carry, so the client
      // can order the opening list against everything that follows it.
      expect(page.automations.waterline).toBeGreaterThan(0);
      expect(page.notes.waterline).toBeGreaterThanOrEqual(0);
    } finally {
      socket!.close(1000, "test complete");
    }
  });

  it("answers subscribe with the viewer's stored display preferences", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    // Nothing stored is every default.
    await expect(stub.memberPreferences({ workspaceId: WORKSPACE_ID, userId: USER_ID }))
      .resolves.toEqual(DEFAULT_MEMBER_PREFERENCES);
    await expect(stub.saveMemberPreferences({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      preferences: { showAgentWork: false },
    })).resolves.toEqual({ ...DEFAULT_MEMBER_PREFERENCES, showAgentWork: false });

    const response = await stub.fetch("https://workspace.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000709",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    try {
      const answer = nextMessage(socket);
      socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      const event = JSON.parse(String((await answer).data)) as { viewerPreferences?: unknown };
      // On the answer itself, so the first frame hides the calls without a read.
      expect(event.viewerPreferences).toEqual({ ...DEFAULT_MEMBER_PREFERENCES, showAgentWork: false });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("includes every live-state work stream beyond both the recent page and 1,250 rows", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `WITH digits(d) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
           sequence(n) AS (
             SELECT ones.d + tens.d * 10 + hundreds.d * 100 + thousands.d * 1000 + 1
             FROM digits ones CROSS JOIN digits tens CROSS JOIN digits hundreds
             CROSS JOIN digits thousands
             WHERE ones.d + tens.d * 10 + hundreds.d * 100 + thousands.d * 1000 < 1252
           )
           INSERT INTO channels
             (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
              title, description, preview, scope, exact_state, system_kind, last_activity_at,
              completed_at, archived_at, email_address, origin_type, origin_label,
              created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
              title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
              next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
              source_created_at, source_updated_at, projected_at)
           SELECT printf('00000000-0000-7000-8002-%012d', n), 1, n,
             printf('00000000-0000-7000-8003-%012d', n), 'test',
             printf('Old live state %d', n), '', '', 'workspace',
             CASE n % 4
               WHEN 1 THEN 'running'
               WHEN 2 THEN 'interrupting'
               WHEN 3 THEN 'preparing_context'
               ELSE 'waiting_capacity'
             END,
             NULL, n, NULL, NULL, NULL, 'ad_hoc', NULL, ?, NULL, NULL, NULL,
             'settled', 0, 0, NULL, NULL, NULL, n, n, n
           FROM sequence`,
          USER_ID,
        );
        state.storage.sql.exec(
          `WITH RECURSIVE sequence(n) AS (
             SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 251
           )
           INSERT INTO channels
             (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
              title, description, preview, scope, exact_state, system_kind, last_activity_at,
              completed_at, archived_at, email_address, origin_type, origin_label,
              created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
              title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
              next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
              source_created_at, source_updated_at, projected_at)
           SELECT printf('00000000-0000-7000-8004-%012d', n), 1, 1252 + n,
             printf('00000000-0000-7000-8005-%012d', n), 'test',
             printf('Recent completed %d', n), '', '', 'workspace', 'completed', NULL,
             10000 + n, 10000 + n, NULL, NULL, 'ad_hoc', NULL, ?, NULL, NULL, NULL,
             'settled', 0, 0, NULL, NULL, NULL, 10000 + n, 10000 + n, 10000 + n
           FROM sequence`,
          USER_ID,
        );
        state.storage.sql.exec(
          `UPDATE workspace_directory_state SET waterline = 1503, updated_at = 10251 WHERE id = 1`,
        );
      });
    });

    const response = await stub.fetch("https://workspace.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000709",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    try {
      const answer = nextMessage(socket);
      socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      const event = JSON.parse(String((await answer).data)) as {
        sidebar: { workstreams: { items: Array<{ id: string }>; nextCursor: string | null } };
      };
      const page = event.sidebar.workstreams;
      expect(page.nextCursor).not.toBeNull();
      expect(page.items).toHaveLength(1_502);
      for (let sequence = 1; sequence <= 4; sequence += 1) {
        expect(page.items.some((item) =>
          item.id === `00000000-0000-7000-8002-${String(sequence).padStart(12, "0")}`)).toBe(true);
      }
    } finally {
      socket.close(1000, "test complete");
    }
    // Assembling and Zod-validating ~3,000 sidebar objects (1,502 items plus
    // their state versions) in one invocation is real work, covered by the
    // suite's 30s budget.
  });

  it("pushes the automation list when an automation's row lands", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");

    const subscriptionId = "00000000-0000-7000-8000-000000000803";
    const row = (lifecycle: "active" | "paused", nextRunAt: string): SidekickDirectoryRow => ({
      automationId: subscriptionId,
      workspaceId: WORKSPACE_ID,
      authorUserId: USER_ID,
      lifecycle,
      scope: "workspace",
      title: "Weekly changelog",
      description: "Every Monday",
      nextRunAt,
    });
    await writeSidekickDirectoryRow(env, row("active", "2026-08-28T09:00:00.000Z"));

    const response = await stub.fetch("https://workspace.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000805",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    socket!.accept();

    try {
      const subscribed = nextMessage(socket!);
      socket!.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      expect(JSON.parse(String((await subscribed).data))).toMatchObject({ type: "workspace_sync" });

      // The Sidekick's directory row is what reaches the workspace sidebar.
      const pushed = nextMessage(socket!);
      await writeSidekickDirectoryRow(env, row("active", "2026-09-04T09:00:00.000Z"));

      const event = JSON.parse(String((await pushed).data)) as {
        type: string;
        list: string;
        waterline: number;
        items: Array<{ id: string; nextRunAt: string | null }>;
      };
      expect(event.type).toBe("workspace_sidebar_list");
      expect(event.list).toBe("automations");
      expect(event.items).toHaveLength(1);
      expect(event.items[0]).toMatchObject({
        id: subscriptionId,
        nextRunAt: "2026-09-04T09:00:00.000Z",
      });

      // A second write moves the counter again, and a write to the other list
      // leaves this one alone: two lists that change independently keep
      // independent counters, or a note write would hide an automation update.
      const secondPush = nextMessage(socket!);
      await writeSidekickDirectoryRow(env, row("paused", "2026-09-04T09:00:00.000Z"));
      const second = JSON.parse(String((await secondPush).data)) as {
        waterline: number;
        items: Array<{ status: string }>;
      };
      expect(second.waterline).toBeGreaterThan(event.waterline);
      expect(second.items[0]?.status).toBe("paused");
    } finally {
      socket!.close(1000, "test complete");
    }
  });

  it("does not push a sidebar list to a socket that has not subscribed", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const resourceId = "00000000-0000-7000-8000-000000000811";

    const response = await stub.fetch("https://workspace.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000813",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    socket!.accept();

    try {
      const frames: string[] = [];
      socket!.addEventListener("message", (event) => frames.push(String(event.data)));
      await expect(stub.executeRuntimeSql({
        workspaceId: WORKSPACE_ID,
        requestId: "00000000-0000-7000-8000-000000000814",
        statements: [
          {
            sql: `INSERT INTO resources
              (id, workspace_id, resource_type, provider, title, created_at, updated_at)
              VALUES (?, ?, 'note', 'avalon', 'Retro', '2026-08-21T19:00:00.000Z',
                      '2026-08-21T19:00:00.000Z')`,
            params: [resourceId, WORKSPACE_ID],
          },
        ],
      })).resolves.toMatchObject({ status: 200 });

      // A socket that never subscribed is mid-handshake as far as the room is
      // concerned; it asks for the whole sidebar when it is ready.
      expect(frames).toEqual([]);
    } finally {
      socket!.close(1000, "test complete");
    }
  });

  it("owns per-user pin ordering in WorkspaceDO SQL", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const workstreamIds = [
      WORKSTREAM_ID,
      asWorkstreamId("00000000-0000-7000-8000-000000000106"),
      asWorkstreamId("00000000-0000-7000-8000-000000000107"),
    ];
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: workstreamIds.flatMap((workstreamId, index) => [
        parentEffectEnvelope({
          kind: "directory_common",
          title: `Pinned ${index + 1}`,
          description: "WorkspaceDO pin fixture",
          preview: "Authoritative directory",
          scope: "workspace",
          state: "idle",
          systemKind: null,
          lastActivityAt: `2026-08-17T2${index}:00:00.000Z`,
          completedAt: null,
          archivedAt: null,
          createdByUserId: USER_ID,
          latestAttentionOrdinal: 0,
          unreadTrackingStartOrdinal: 0,
          createdAt: "2026-08-17T19:00:00.000Z",
          updatedAt: `2026-08-17T2${index}:00:00.000Z`,
          resourceLinks: [],
        }, `00000000-0000-7000-8000-${(0x280 + index).toString(16).padStart(12, "0")}`, 1, workstreamId),
      ]),
    });
    const now = Date.now();
    await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-000000000288",
      statements: [
        ...[SPACE_ID, OTHER_SPACE_ID].map((spaceId, index) => ({
          sql: `INSERT INTO spaces
            (space_id, title, scope, appearance_json, archived_at, created_by_user_id,
             system_role, authority_generation, source_version, payload_hash, revision,
             created_at, updated_at, source_created_at, source_updated_at)
            VALUES (?, ?, 'workspace', NULL, NULL, ?, NULL, 1, 1, ?, 1, ?, ?, ?, ?)`,
          params: [spaceId, `Space ${index + 1}`, USER_ID, `hash-${index}`, now, now, now, now],
        })),
        ...[SPACE_ID, OTHER_SPACE_ID].flatMap((spaceId) => workstreamIds.map((workstreamId) => ({
          sql: `INSERT INTO space_channel_memberships
            (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
            VALUES (?, ?, 'active', 1, ?, ?, NULL)`,
          params: [spaceId, workstreamId, now, now],
        }))),
      ],
    });

    await expect(stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      spaceId: SPACE_ID,
      workstreamId: workstreamIds[2]!,
    })).resolves.toMatchObject({
      items: [{ id: workstreamIds[2], pinPosition: null, spacePins: [{ spaceId: SPACE_ID, position: 0 }] }],
    });
    await stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      spaceId: SPACE_ID,
      workstreamId: workstreamIds[0]!,
    });
    const repeated = await stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      spaceId: SPACE_ID,
      workstreamId: workstreamIds[2]!,
    });
    expect(repeated.items.map((item) => [item.id, item.spacePins])).toEqual([
      [workstreamIds[2], [{ spaceId: SPACE_ID, position: 0 }]],
      [workstreamIds[0], [{ spaceId: SPACE_ID, position: 1 }]],
    ]);

    const reordered = await stub.reorderWorkstreamPins({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      spaceId: SPACE_ID,
      workstreamIds: [workstreamIds[0]!, workstreamIds[1]!, workstreamIds[2]!],
    });
    expect(reordered.items.map((item) => [item.id, item.spacePins])).toEqual([
      [workstreamIds[0], [{ spaceId: SPACE_ID, position: 0 }]],
      [workstreamIds[2], [{ spaceId: SPACE_ID, position: 1 }]],
    ]);
    const unpinned = await stub.unpinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      spaceId: SPACE_ID,
      workstreamId: workstreamIds[0]!,
    });
    expect(unpinned.items.map((item) => [item.id, item.spacePins]))
      .toEqual([[workstreamIds[2], [{ spaceId: SPACE_ID, position: 0 }]]]);

    const pinnedInBothSpaces = await stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      spaceId: OTHER_SPACE_ID,
      workstreamId: workstreamIds[2]!,
    });
    expect(pinnedInBothSpaces.items).toEqual([
      expect.objectContaining({
        id: workstreamIds[2],
        spacePins: [
          { spaceId: SPACE_ID, position: 0 },
          { spaceId: OTHER_SPACE_ID, position: 0 },
        ],
      }),
    ]);
    await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-000000000289",
      statements: [{
        sql: "UPDATE spaces SET archived_at = ?, updated_at = ? WHERE space_id = ?",
        params: [now + 1, now + 1, OTHER_SPACE_ID],
      }],
    });
    await expect(stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      limit: 20,
      includeSystem: false,
    })).resolves.toMatchObject({
      items: [
        { id: workstreamIds[0], spaceIds: [SPACE_ID], spacePins: [] },
        { id: workstreamIds[1], spaceIds: [SPACE_ID], spacePins: [] },
        {
          id: workstreamIds[2],
          spaceIds: [SPACE_ID],
          spacePins: [{ spaceId: SPACE_ID, position: 0 }],
        },
      ],
    });
    await expect(stub.unpinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      spaceId: OTHER_SPACE_ID,
      workstreamId: workstreamIds[2]!,
    })).resolves.toMatchObject({ items: [] });

    const otherUserId = asUserId("00000000-0000-7000-8000-000000000108");
    await expect(stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: otherUserId,
      spaceId: SPACE_ID,
      workstreamId: workstreamIds[1]!,
    })).resolves.toMatchObject({
      items: [{ id: workstreamIds[1], spacePins: [{ spaceId: SPACE_ID, position: 0 }] }],
    });
    await expect(stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      limit: 20,
      includeSystem: false,
    })).resolves.toMatchObject({
      items: [
        { id: workstreamIds[0], pinPosition: null, spacePins: [] },
        { id: workstreamIds[1], pinPosition: null, spacePins: [] },
        { id: workstreamIds[2], pinPosition: null, spacePins: [{ spaceId: SPACE_ID, position: 0 }] },
      ],
    });
  });

  it("lists personal system work only for its participant and only on opt-in", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [
        parentEffectEnvelope({
          kind: "directory_common",
          title: "Digest fixture",
          description: "Personal machinery",
          preview: "Hidden by default",
          scope: "personal",
          state: "completed",
          systemKind: "digest",
          lastActivityAt: "2026-08-17T20:00:00.000Z",
          completedAt: "2026-08-17T20:00:00.000Z",
          archivedAt: null,
          createdByUserId: USER_ID,
          latestAttentionOrdinal: 0,
          unreadTrackingStartOrdinal: 0,
          createdAt: "2026-08-17T19:00:00.000Z",
          updatedAt: "2026-08-17T20:00:00.000Z",
          resourceLinks: [],
        }, "00000000-0000-7000-8000-000000000290"),
        parentEffectEnvelope({
          kind: "directory_user",
          userId: USER_ID,
          isParticipant: true,
          unreadCount: 0,
          youAreMentioned: false,
          listable: true,
          seenAttentionOrdinal: 0,
          manualUnreadFromOrdinal: null,
          manualUnreadGeneration: 0,
          latestMentionAttentionOrdinal: 0,
        }, "00000000-0000-7000-8000-000000000291"),
      ],
    });

    await expect(stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      limit: 20,
      includeSystem: false,
    })).resolves.toMatchObject({ items: [] });
    await expect(stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      limit: 20,
      includeSystem: true,
    })).resolves.toMatchObject({ items: [{ id: WORKSTREAM_ID, systemKind: "digest" }] });
    await expect(stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: asUserId("00000000-0000-7000-8000-000000000108"),
      limit: 20,
      includeSystem: true,
    })).resolves.toMatchObject({ items: [] });
  });

  it("serves workspace product SQL locally and rejects a row for another workspace", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const connectionId = "00000000-0000-7000-8000-000000000423";
    const insert = await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-000000000424",
      statements: [{
        sql: `INSERT INTO connector_connections
          (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
           display_name, granted_scopes_json, status, cursor_json, config_json,
           created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'github', 'workspace', NULL, NULL, 'Repository', '[]', 'healthy',
                 '{}', '{}', '2026-08-18T20:00:00.000Z', '2026-08-18T20:00:00.000Z', ?)`,
        params: [connectionId, WORKSPACE_ID, `github-${connectionId}`],
      }],
    });
    expect(insert.status).toBe(200);
    // Receipt claims moved to the typed `claimWebhookReceipt` RPC, so the
    // generic port refuses the table by name rather than executing a claim
    // whose outcome the caller would read off a physical write counter.
    const receipt = await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-000000000429",
      statements: [{
        sql: `INSERT INTO webhook_receipts
          (id, workspace_id, connection_id, signature_hash, received_at, expires_at)
         VALUES (?, ?, ?, 'signed-delivery',
                 '2026-08-18T20:00:00.000Z', '2026-08-19T20:00:00.000Z')`,
        params: ["00000000-0000-7000-8000-000000000428", WORKSPACE_ID, connectionId],
      }],
    });
    expect(receipt.status).toBe(409);
    expect(receipt.bodyJson).toContain(
      "workspace_runtime_table_requires_typed_rpc:webhook_receipts",
    );
    const selected = await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-000000000425",
      statements: [{
        sql: "SELECT id, display_name FROM connector_connections WHERE workspace_id = ?",
        params: [WORKSPACE_ID],
      }],
    });
    expect(JSON.parse(selected.bodyJson)).toMatchObject({
      results: [{ rows: [{ id: connectionId, display_name: "Repository" }] }],
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ workspace_id: string }>(
        "SELECT workspace_id FROM connector_connections WHERE id = ?",
        connectionId,
      ).one()).toEqual({ workspace_id: WORKSPACE_ID });
    });
    const mismatch = await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-000000000426",
      statements: [{
        sql: `INSERT INTO external_user_identities
          (id, workspace_id, user_id, provider, provider_tenant_id, provider_user_id,
           verification_source, created_at, updated_at)
         VALUES (?, ?, ?, 'github', 'tenant', 'provider-user', 'test',
                 '2026-08-18T20:00:00.000Z', '2026-08-18T20:00:00.000Z')`,
        params: ["00000000-0000-7000-8000-000000000427", WORKSTREAM_ID, USER_ID],
      }],
    });
    expect(mismatch.status).toBe(409);
    expect(JSON.parse(mismatch.bodyJson)).toMatchObject({
      error: expect.stringContaining("workspace_identity_mismatch"),
    });
  });

  it("ages processed connector events out on the alarm and keeps every event still in flight", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const ids = {
      expired: "00000000-0000-7000-8000-000000000311",
      recent: "00000000-0000-7000-8000-000000000312",
      pendingOld: "00000000-0000-7000-8000-000000000313",
      failedOld: "00000000-0000-7000-8000-000000000314",
    };
    for (const [index, id] of Object.values(ids).entries()) {
      const event = connectorEvent(id);
      await stub.ingestConnectorEvent({
        workspaceId: WORKSPACE_ID,
        ingressEventId: id,
        payloadHash: `sha256:${String(index).repeat(64)}`,
        event: {
          ...event,
          activity: {
            ...event.activity,
            providerEventId: `delivery-${index}`,
            dedupeKey: `retention:${index}`,
            // Distinct content, or ingest keeps only the first as nothing new.
            summary: `Retention case ${index}`,
          },
        },
      });
    }
    const day = 24 * 60 * 60_000;
    const old = Date.now() - 91 * day;
    await runInDurableObject(stub, async (_instance, state) => {
      const set = (id: string, status: string, receivedAt: number) => state.storage.sql.exec(
        `UPDATE workspace_connector_events SET processing_status = ?, received_at = ? WHERE event_id = ?`,
        status, receivedAt, id,
      );
      set(ids.expired, "processed", old);
      set(ids.recent, "processed", Date.now() - 89 * day);
      set(ids.pendingOld, "pending", old);
      set(ids.failedOld, "failed", old);
      // An hour out, not now: workerd fires a due alarm on its own, and this
      // read could then land between that alarm's awaits and before its reap.
      // `runDurableObjectAlarm` runs it now whatever time it is set for.
      await state.storage.setAlarm(Date.now() + 60 * 60_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ event_id: string }>(
        "SELECT event_id FROM workspace_connector_events ORDER BY event_id",
      ).toArray().map((row) => row.event_id)).toEqual([ids.recent, ids.pendingOld, ids.failedOld]);
    });
  });

  it("arms the alarm for a connector event's expiry when it settles as processed", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    // Close the Space cutover, as the path that opens a new Organization does.
    // A pending one is due at once, and when workerd fires it before the
    // settle below, its page claim re-arms the alarm a retry delay out, which
    // is earlier than the expiry this case measures.
    await stub.finalizeSpaceBootstrap({ workspaceId: WORKSPACE_ID });
    const eventId = "00000000-0000-7000-8000-000000000316";
    const processingOwnerId = "00000000-0000-7000-8000-000000000317";
    await stub.ingestConnectorEvent({
      workspaceId: WORKSPACE_ID,
      ingressEventId: eventId,
      payloadHash: `sha256:${"e".repeat(64)}`,
      event: connectorEvent(eventId),
    });
    // Due an hour from now: late enough that workerd does not fire it before
    // the assertion reads it, and later than anything else this object waits on.
    const expiresAt = Date.now() + 60 * 60_000;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE workspace_connector_events SET received_at = ? WHERE event_id = ?",
        expiresAt - 90 * 24 * 60 * 60_000, eventId,
      );
      await state.storage.deleteAlarm();
    });
    const claim = WorkspaceConnectorEventClaimResultSchema.parse(await stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId,
      processingOwnerId,
      attempt: 0,
      orchestrator: "queue",
    }));
    if (claim.outcome !== "claimed") throw new Error("expected the connector event to be claimed");
    await stub.settleConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId,
      processingOwnerId,
      processingLeaseId: claim.processingLeaseId,
      outcome: "processed",
      error: null,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(expiresAt);
      // As if the first settle committed its row and died before arming.
      await state.storage.deleteAlarm();
    });
    await stub.settleConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId,
      processingOwnerId,
      processingLeaseId: claim.processingLeaseId,
      outcome: "processed",
      error: null,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(expiresAt);
    });
  });

  it("receipts a new identity that repeats its resource's latest content against the earlier event", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    // A provider re-stamping an unchanged resource: every identity field moves
    // and nothing a reader sees does.
    const restamped = (id: string, stamp: string, summary = "Ada edited the connector architecture") => {
      const event = connectorEvent(id);
      return {
        ...event,
        activity: {
          ...event.activity,
          providerEventId: `delivery-${stamp}`,
          dedupeKey: `github:delivery-${stamp}:pull-request-edited`,
          occurredAt: `2026-08-1${stamp}T20:00:00.000Z`,
          payloadRef: `global/provider-webhooks/github/${stamp}.json`,
          summary,
        },
      };
    };
    const ingest = (id: string, event: ReturnType<typeof restamped>) => stub.ingestConnectorEvent({
      workspaceId: WORKSPACE_ID,
      ingressEventId: id,
      payloadHash: `sha256:${id.slice(-1).repeat(64)}`,
      event,
    });
    const firstId = "00000000-0000-7000-8000-000000000501";
    const touchId = "00000000-0000-7000-8000-000000000502";
    const editId = "00000000-0000-7000-8000-000000000503";
    const revertId = "00000000-0000-7000-8000-000000000504";

    await expect(ingest(firstId, restamped(firstId, "1"))).resolves.toMatchObject({
      eventId: firstId, duplicate: false,
    });
    const unchanged = {
      eventId: firstId,
      duplicate: true,
      processingStatus: "pending",
      processingAttempt: -1,
      unchangedContent: true,
    };
    await expect(ingest(touchId, restamped(touchId, "2"))).resolves.toEqual(unchanged);
    // The Queue redelivering the repeat is answered by its receipt, and is
    // still a repeat rather than a replay of the earlier event's own delivery.
    await expect(ingest(touchId, restamped(touchId, "2"))).resolves.toEqual(unchanged);
    await expect(ingest(editId, restamped(editId, "3", "Ada renamed the queue"))).resolves.toMatchObject({
      eventId: editId, duplicate: false,
    });
    // Only the latest event is compared: changing back is news.
    await expect(ingest(revertId, restamped(revertId, "4"))).resolves.toMatchObject({
      eventId: revertId, duplicate: false,
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ event_id: string }>(
        "SELECT event_id FROM workspace_connector_events ORDER BY event_sequence",
      ).toArray().map((row) => row.event_id)).toEqual([firstId, editId, revertId]);
    });
  });

  it("wakes no processing for a repeat of a pending event, and retries one of a failed event afresh", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const delivery = async (id: string, stamp: string) => {
      const { activity, connectorType } = connectorEvent(id);
      return workspaceConnectorEventQueueMessage({
        connectorType,
        activity: {
          ...activity,
          providerEventId: `delivery-${stamp}`,
          dedupeKey: `github:delivery-${stamp}:pull-request-edited`,
        },
      });
    };
    const send = vi.spyOn(env.ACTIVITY_QUEUE, "send");
    const processWakes = () => send.mock.calls
      .filter(([body]) => (body as { kind?: string }).kind === "connector_event_process").length;
    try {
      const firstId = "00000000-0000-7000-8000-000000000511";
      const first = await delivery(firstId, "1");
      const touch = await delivery("00000000-0000-7000-8000-000000000512", "2");
      const afterFailureId = "00000000-0000-7000-8000-000000000513";
      const afterFailure = await delivery(afterFailureId, "3");
      await consumeEffectBodies(env, [first]);
      expect(processWakes()).toBe(1);
      // The first event is still pending: its own admission woke it, and the
      // repeat, redelivered too, wakes nothing more.
      await consumeEffectBodies(env, [touch, touch]);
      expect(processWakes()).toBe(1);
      // Once it has failed for good, a repeat is stored as a new event with a
      // retry budget of its own, rather than folded into one that never ran.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE workspace_connector_events SET processing_status = 'failed', processing_attempt = 5",
        );
      });
      await consumeEffectBodies(env, [afterFailure]);
      expect(processWakes()).toBe(2);
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ event_id: string }>(
          "SELECT event_id FROM workspace_connector_events ORDER BY event_sequence",
        ).toArray().map((row) => row.event_id)).toEqual([firstId, afterFailureId]);
      });
    } finally {
      send.mockRestore();
    }
  });

  it("restores a dropped repeat when an older, different event for its resource arrives after it", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    // A changed to B and back to A, the change back delivered first.
    const delivery = async (id: string, day: number, summary: string) => {
      const { activity, connectorType } = connectorEvent(id);
      return workspaceConnectorEventQueueMessage({
        connectorType,
        activity: {
          ...activity,
          providerEventId: `delivery-${day}`,
          dedupeKey: `github:delivery-${day}:pull-request-edited`,
          occurredAt: `2026-08-1${day}T20:00:00.000Z`,
          summary,
        },
      });
    };
    const ids = {
      first: "00000000-0000-7000-8000-000000000521",
      change: "00000000-0000-7000-8000-000000000522",
      changeBack: "00000000-0000-7000-8000-000000000523",
      repeat: "00000000-0000-7000-8000-000000000524",
    };
    const first = await delivery(ids.first, 1, "A");
    const change = await delivery(ids.change, 2, "B");
    const changeBack = await delivery(ids.changeBack, 3, "A");
    const repeat = await delivery(ids.repeat, 4, "A");
    const send = vi.spyOn(env.ACTIVITY_QUEUE, "send");
    const woken = () => send.mock.calls
      .map(([body]) => body as { kind?: string; eventId?: string })
      .filter((body) => body.kind === "connector_event_process")
      .map((body) => body.eventId);
    const stored = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{
      event_id: string;
      occurred_at: number;
    }>("SELECT event_id, occurred_at FROM workspace_connector_events ORDER BY event_sequence").toArray());
    try {
      await consumeEffectBodies(env, [first]);
      await consumeEffectBodies(env, [changeBack]);
      // In order, the change back repeats the latest content and is dropped.
      expect((await stored()).map((row) => row.event_id)).toEqual([ids.first]);
      expect(woken()).toEqual([ids.first]);

      // The change arrives late: stored, and the dropped change back is
      // restored after it under its own identity and time, and woken.
      await consumeEffectBodies(env, [change]);
      expect(await stored()).toEqual([
        { event_id: ids.first, occurred_at: Date.parse("2026-08-11T20:00:00.000Z") },
        { event_id: ids.change, occurred_at: Date.parse("2026-08-12T20:00:00.000Z") },
        { event_id: ids.changeBack, occurred_at: Date.parse("2026-08-13T20:00:00.000Z") },
      ]);
      expect(woken()).toEqual([ids.first, ids.change, ids.changeBack]);

      // A redelivery of the late change still wakes the restored event, which
      // nothing else would.
      await consumeEffectBodies(env, [change]);
      expect(woken().slice(3)).toEqual([ids.change, ids.changeBack]);

      // The restored event is now the latest, and a repeat of it is dropped.
      await consumeEffectBodies(env, [repeat]);
      expect((await stored()).map((row) => row.event_id))
        .toEqual([ids.first, ids.change, ids.changeBack]);
      expect(woken()).toHaveLength(5);
    } finally {
      send.mockRestore();
    }
  });

  it("owns connector events, deduplicates Queue replays, and fences processing settlement", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const firstId = "00000000-0000-7000-8000-000000000301";
    const replayId = "00000000-0000-7000-8000-000000000303";
    const payloadHash = `sha256:${"a".repeat(64)}`;
    await expect(stub.ingestConnectorEvent({
      workspaceId: WORKSPACE_ID,
      ingressEventId: firstId,
      payloadHash,
      event: connectorEvent(firstId),
    })).resolves.toEqual({
      eventId: firstId,
      duplicate: false,
      processingStatus: "pending",
      processingAttempt: -1,
    });
    await expect(stub.ingestConnectorEvent({
      workspaceId: WORKSPACE_ID,
      ingressEventId: replayId,
      payloadHash,
      event: connectorEvent(replayId),
    })).resolves.toEqual({
      eventId: firstId,
      duplicate: true,
      processingStatus: "pending",
      processingAttempt: -1,
    });
    const legacyWorkflowId = `connector-event-${firstId}-5`;
    const legacyClaim = LegacyWorkspaceConnectorEventClaimResultSchema.parse(
      await stub.claimConnectorEvent({
        workspaceId: WORKSPACE_ID,
        eventId: firstId,
        workflowInstanceId: legacyWorkflowId,
        attempt: 5,
      }),
    );
    expect(legacyClaim).toEqual({
      outcome: "claimed",
      event: connectorEvent(firstId),
    });
    if (legacyClaim.outcome !== "claimed") throw new Error("expected legacy Workflow claim");
    const replayedLegacyClaim = LegacyWorkspaceConnectorEventClaimResultSchema.parse(
      await stub.claimConnectorEvent({
        workspaceId: WORKSPACE_ID,
        eventId: firstId,
        workflowInstanceId: legacyWorkflowId,
        attempt: 5,
      }),
    );
    expect(replayedLegacyClaim).toEqual({
      outcome: "claimed",
      event: connectorEvent(firstId),
    });
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      workflowInstanceId: `connector-event-${firstId}-4`,
      attempt: 5,
    })).resolves.toEqual({ outcome: "busy" });
    await runInDurableObject(stub, (_instance, state) => {
      // Simulate an active claim written before migration 12 added the
      // orchestrator discriminator, and age it past the Queue lease window.
      state.storage.sql.exec(
        `UPDATE workspace_connector_events
            SET processing_orchestrator = NULL, claimed_at = ?
          WHERE event_id = ?`,
        Date.now() - 15 * 60_000 - 1,
        firstId,
      );
    });
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId: "00000000-0000-7000-8000-000000000306",
      attempt: 5,
      orchestrator: "queue",
    })).resolves.toEqual({
      outcome: "busy",
      reason: "legacy_workflow_active",
      retryAt: null,
    });
    await stub.settleConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      workflowInstanceId: legacyWorkflowId,
      outcome: "failed",
      error: "legacy Workflow retry handoff",
    });
    const processingOwnerId = "00000000-0000-7000-8000-000000000304";
    const claim = WorkspaceConnectorEventClaimResultSchema.parse(await stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId,
      attempt: 5,
      orchestrator: "queue",
    }));
    expect(claim).toMatchObject({
      outcome: "claimed",
      event: { connectorType: "github", activity: { id: firstId, workspaceId: WORKSPACE_ID } },
      processingLeaseId: expect.any(String),
      processingLeaseExpiresAt: expect.any(Number),
    });
    if (claim.outcome !== "claimed") throw new Error("expected initial connector claim");
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId,
      attempt: 5,
      orchestrator: "queue",
    })).resolves.toMatchObject({
      outcome: "busy",
      reason: "active_lease_not_expired",
      retryAt: expect.any(Number),
    });
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId: "00000000-0000-7000-8000-000000000305",
      attempt: 5,
      orchestrator: "queue",
    })).resolves.toMatchObject({
      outcome: "busy",
      reason: "active_lease_not_expired",
      retryAt: expect.any(Number),
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE workspace_connector_events SET claimed_at = ? WHERE event_id = ?`,
        Date.now() - 15 * 60_000 - 1,
        firstId,
      );
    });
    const recovered = WorkspaceConnectorEventClaimResultSchema.parse(await stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId,
      attempt: 5,
      orchestrator: "queue",
    }));
    expect(recovered).toMatchObject({
      outcome: "claimed",
      processingLeaseId: expect.any(String),
    });
    if (recovered.outcome !== "claimed") throw new Error("expected recovered connector claim");
    expect(recovered.processingLeaseId).not.toBe(claim.processingLeaseId);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.settleConnectorEvent({
        workspaceId: WORKSPACE_ID,
        eventId: firstId,
        processingOwnerId,
        processingLeaseId: claim.processingLeaseId,
        outcome: "failed",
        error: "stale handler",
      })).rejects.toThrow("connector_event_settlement_fenced");
    });
    await stub.settleConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId,
      processingLeaseId: recovered.processingLeaseId,
      outcome: "failed",
      error: "injected retry",
      // The code the settler derived beside the message a person reads; the
      // entry point parses through `parseRpcInput`, so a code outside the
      // class would refuse the settlement naming the field.
      errorCode: "connector_event_processing_failed:event.eventType:invalid_type",
    });
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId: "00000000-0000-7000-8000-000000000305",
      attempt: 4,
      orchestrator: "queue",
    })).resolves.toEqual({
      outcome: "busy",
      reason: "failed_attempt_not_advanced",
      retryAt: null,
    });
    const retried = WorkspaceConnectorEventClaimResultSchema.parse(await stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId,
      attempt: 5,
      orchestrator: "queue",
    }));
    expect(retried).toMatchObject({ outcome: "claimed", processingLeaseId: expect.any(String) });
    if (retried.outcome !== "claimed") throw new Error("expected retried connector claim");
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId: "00000000-0000-7000-8000-000000000305",
      attempt: 5,
      orchestrator: "queue",
    })).resolves.toMatchObject({
      outcome: "busy",
      reason: "active_lease_not_expired",
      retryAt: expect.any(Number),
    });
    await stub.settleConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId,
      processingLeaseId: retried.processingLeaseId,
      outcome: "processed",
      error: null,
    });
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      processingOwnerId,
      attempt: 5,
      orchestrator: "queue",
    })).resolves.toEqual({ outcome: "processed" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workspace_connector_events`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workspace_connector_event_ingress_receipts`,
      ).one().count).toBe(2);
    });
  });

  it("warms the Channel's Main conversation when someone opens the Channel", async () => {
    await seedOpenAuthority();
    const stub = hostedParentStub(env, WORKSPACE_ID);
    const at = "2026-08-22T12:00:00.000Z";
    await stub.receiveChildEffects({
      substreamId: "0",
      envelopes: [childEffectEnvelope({
        kind: "directory_common" as const,
        title: "Warm on open",
        description: "Main wakes before it is read",
        preview: "idle",
        scope: "workspace",
        state: "idle",
        systemKind: null,
        lastActivityAt: at,
        completedAt: null,
        archivedAt: null,
        emailAddress: "workstream@automation.with-avalon.com",
        createdByUserId: USER_ID,
        titleStatus: "settled" as const,
        latestAttentionOrdinal: 1,
        unreadTrackingStartOrdinal: 0,
        nextWakeupDueAt: null,
        nextWakeupPrompt: null,
        nextTerminalActionAt: null,
        createdAt: at,
        updatedAt: at,
      }, "00000000-0000-7000-8000-000000000711")],
    });
    const main = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));

    const response = await stub.fetch("https://workspace.test/parent-socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000712",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    response.webSocket!.accept();

    // Whether Main is *running* is the observable, and eviction is what asks:
    // the harness refuses to evict an object that was never started. The wake
    // is not awaited by the open, so give it a few turns to land. Nothing in
    // this test addresses Main.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await evictDurableObject(main);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(lastError).toBeNull();
    response.webSocket!.close(1000, "done");
  });

  it("closes a metadata socket when the work stream itself stops admitting its reader", async () => {
    await seedOpenAuthority();
    const stub = hostedParentStub(env, WORKSPACE_ID);
    const at = "2026-08-22T12:00:00.000Z";
    const otherCreator = "00000000-0000-7000-8000-000000000706";
    const directory = (
      scope: "workspace" | "personal",
      eventId: string,
      creatorUserId = otherCreator,
    ) => childEffectEnvelope({
      kind: "directory_common" as const,
      title: "Narrowing work stream",
      description: "Readable, then not",
      preview: "idle",
      scope,
      state: "idle",
      systemKind: null,
      lastActivityAt: at,
      completedAt: null,
      archivedAt: null,
      emailAddress: "workstream@automation.with-avalon.com",
      createdByUserId: creatorUserId,
      titleStatus: "settled" as const,
      latestAttentionOrdinal: 1,
      unreadTrackingStartOrdinal: 0,
      nextWakeupDueAt: null,
      nextWakeupPrompt: null,
      nextTerminalActionAt: null,
      createdAt: at,
      updatedAt: at,
    }, eventId);
    // Readable because the work stream is open to the workspace. Seat this
    // reader before narrowing so the private scope keeps admitting them.
    await stub.receiveChildEffects({
      substreamId: "0",
      envelopes: [directory("workspace", "00000000-0000-7000-8000-000000000701"), childEffectEnvelope({
        kind: "directory_user" as const,
        userId: USER_ID,
        isParticipant: true,
        unreadCount: 0,
        youAreMentioned: false,
        listable: true,
        seenAttentionOrdinal: 0,
        manualUnreadFromOrdinal: null,
        manualUnreadGeneration: 0,
        latestMentionAttentionOrdinal: 0,
      }, "00000000-0000-7000-8000-000000000702")],
    });

    await seedParticipantGrants(env, WORKSPACE_ID, WORKSTREAM_ID, [USER_ID]);
    const response = await stub.fetch("https://workspace.test/parent-socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000703",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const subscribed = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe" }));
    await subscribed;

    try {
      const creatorUpdate = nextMessage(socket);
      await stub.receiveChildEffects({
        substreamId: "0",
        envelopes: [directory(
          "personal",
          "00000000-0000-7000-8000-000000000704",
          USER_ID,
        )],
      });
      expect(JSON.parse(String((await creatorUpdate).data))).toMatchObject({
        type: "workstream_metadata",
        metadata: { scope: "personal", createdByUserId: USER_ID },
      });

      const closed = nextClose(socket);
      // Creator metadata is not authority. Once the participant projection is
      // removed, the private work stream must close this creator's socket too.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec("UPDATE parent_grants SET grant_json = json_set(grant_json, '$.active', json('false')) WHERE parent_id = ? AND user_id = ?", WORKSTREAM_ID, USER_ID);
      });
      await stub.receiveChildEffects({
        substreamId: "0",
        envelopes: [childEffectEnvelope({
          kind: "directory_user" as const,
          userId: USER_ID,
          isParticipant: false,
          unreadCount: 0,
          youAreMentioned: false,
          listable: false,
          seenAttentionOrdinal: 0,
          manualUnreadFromOrdinal: null,
          manualUnreadGeneration: 0,
          latestMentionAttentionOrdinal: 0,
        }, "00000000-0000-7000-8000-000000000707")],
      });
      expect((await closed).code).toBe(1008);
    } finally {
      try { socket.close(1000, "test complete"); } catch { /* already closed */ }
      // Put the shared work stream back the way this test found it. Durable
      // Object storage outlives the file inside one suite run, so a scope left
      // narrowed here is a scope every later file inherits.
      await stub.receiveChildEffects({
        substreamId: "0",
        envelopes: [directory("workspace", "00000000-0000-7000-8000-000000000705")],
      });
    }
  });

  it("serves complete Channel metadata without query configuration after hibernation", async () => {
    await seedOpenAuthority();
    const stub = hostedParentStub(env, WORKSPACE_ID);
    const at = "2026-08-17T20:00:00.000Z";
    const common = {
      kind: "directory_common" as const,
      appearance: { icon: "rocket" as const, color: "purple" as const },
      title: "Socket metadata",
      description: "Owned by the non-agent work-stream object",
      preview: "Metadata preview",
      scope: "workspace" as const,
      state: "running",
      systemKind: null,
      lastActivityAt: at,
      completedAt: null,
      archivedAt: null,
      emailAddress: "workstream@automation.with-avalon.com",
      createdByUserId: USER_ID,
      titleStatus: "settled" as const,
      latestAttentionOrdinal: 7,
      unreadTrackingStartOrdinal: 2,
      nextWakeupDueAt: "2026-08-18T20:00:00.000Z",
      nextWakeupPrompt: "Continue the coding session",
      nextTerminalActionAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const user = {
      kind: "directory_user" as const,
      userId: USER_ID,
      isParticipant: true,
      unreadCount: 3,
      youAreMentioned: true,
      listable: true,
      seenAttentionOrdinal: 4,
      manualUnreadFromOrdinal: null,
      manualUnreadGeneration: 2,
      latestMentionAttentionOrdinal: 7,
    };
    const initialized = await stub.receiveChildEffects({
      substreamId: "0",
      envelopes: [childEffectEnvelope(common, "socket-common"), childEffectEnvelope(user, "socket-user")],
    });
    expect(initialized.accepted).toHaveLength(2);

    const ticketId = "00000000-0000-7000-8000-000000000108";
    const response = await stub.fetch("https://workspace.test/parent-socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": ticketId,
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    if (response.status !== 101) {
      throw new Error(`workstream socket rejected: ${response.status} ${await response.text()}`);
    }
    const socket = response.webSocket!;
    socket.accept();
    await evictDurableObject(stub);
    const pong = nextMessage(socket);
    socket.send("ping");
    expect((await pong).data).toBe("pong");
    const snapshot = nextMessageWhileOpen(socket);
    socket.send(JSON.stringify({ type: "future_control_event" }));
    socket.send(JSON.stringify({ type: "subscribe", future: true }));
    const initialMetadata = JSON.parse(String((await snapshot).data)) as {
      metadata: { appearance?: unknown; stateVersion: { commonEventId: string; viewerEventId: string | null } };
    };
    expect(initialMetadata).toMatchObject({
      type: "workstream_metadata",
      metadata: {
        stateVersion: {
          authorityGeneration: 1,
          commonWaterline: 1,
          viewerWaterline: 1,
        },
        id: WORKSTREAM_ID,
        workspaceId: WORKSPACE_ID,
        title: "Socket metadata",
        description: "Owned by the non-agent work-stream object",
        emailAddress: "workstream@automation.with-avalon.com",
        createdByUserId: USER_ID,
        harnessStatus: "running",
        latestAttentionSequenceNumber: 7,
        createdAt: at,
        viewer: {
          isParticipant: true,
          unreadCount: 3,
          youAreMentioned: true,
          readThroughSequenceNumber: 4,
        },
      },
    });
    expect(initialMetadata.metadata.appearance).toEqual(common.appearance);
    expect(Object.hasOwn(initialMetadata.metadata, "appearance")).toBe(true);
    expect(initialMetadata.metadata.stateVersion.commonEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(initialMetadata.metadata.stateVersion.viewerEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    await evictDurableObject(stub);
    const pushed = nextMessage(socket);
    const update = await stub.receiveChildEffects({
      substreamId: "0",
      envelopes: [childEffectEnvelope({ ...common, title: "Renamed from another client" }, "socket-common-2", 2)],
    });
    expect(update.accepted).toHaveLength(1);
    const pushedMetadata = JSON.parse(String((await pushed).data)) as typeof initialMetadata;
    expect(pushedMetadata.metadata.appearance).toEqual(common.appearance);
    expect(Object.hasOwn(pushedMetadata.metadata, "appearance")).toBe(true);
    expect(pushedMetadata).toMatchObject({
      type: "workstream_metadata",
      metadata: { title: "Renamed from another client" },
    });
    socket.close(1000, "done");
  });

  it("reports its own accept time and instance age on the 101, and on nothing else", async () => {
    // The room reports only accepted upgrades. Clock arithmetic is covered by
    // durable-object-instance-age.test.ts; this test proves real header emission
    // and that replay admission remains enforced.
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const upgrade = (ticketId: string) => stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": ticketId,
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    // Presence first, then the number: `Number(null)` is 0, and a room that
    // stopped reporting would otherwise pass as one that reported zero.
    const reported = (response: Response) => {
      const read = (name: string): number => {
        const value = response.headers.get(name);
        expect(value, `${name} on the 101`).not.toBeNull();
        expect(value).toMatch(/^\d+$/);
        return Number(value);
      };
      return {
        acceptMs: read("x-rally-room-accept-ms"),
        instanceAgeMs: read("x-rally-room-instance-age-ms"),
      };
    };

    const first = await upgrade("00000000-0000-7000-8000-000000000901");
    expect(first.status).toBe(101);
    const firstReport = reported(first);
    expect(firstReport.acceptMs).toBeGreaterThanOrEqual(0);
    expect(firstReport.instanceAgeMs).toBeGreaterThanOrEqual(0);
    first.webSocket!.accept();

    // The same instance served both, so its age cannot have gone backwards.
    const second = await upgrade("00000000-0000-7000-8000-000000000902");
    expect(second.status).toBe(101);
    expect(reported(second).instanceAgeMs).toBeGreaterThanOrEqual(firstReport.instanceAgeMs);
    second.webSocket!.accept();

    const replayed = await upgrade("00000000-0000-7000-8000-000000000901");
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toEqual({ error: "socket_ticket_replayed" });
    expect(replayed.headers.get("x-rally-room-accept-ms")).toBeNull();
    expect(replayed.headers.get("x-rally-room-instance-age-ms")).toBeNull();

    first.webSocket!.close(1000, "test complete");
    second.webSocket!.close(1000, "test complete");
  });

  it("keeps the full opening feed when the authoritative socket replaces a preview", async () => {
    await seedOpenAuthority();
    await seedCreatorProfile();
    const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID));
    expect((await stub.bootstrapRuntime({ workspaceId: WORKSPACE_ID, parentKind: "workstream",
      parentId: WORKSTREAM_ID, generation: 1 })).status).toBe(200);
    await provisionBootstrappedWorkstream(stub, USER_ID);
    await seatBootstrapParticipant(stub, USER_ID);
    await runInDurableObject(stub, async (_instance, state) => {
      await seedParticipantMessage(state, { id: "opening-request", sequence: 1, text: "Opening request" });
      await seedParticipantMessage(state, { id: "working-reply", sequence: 2, authorType: "agent", text: "Working on it" });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      for (let sequence = 3; sequence <= 8; sequence += 1) {
        await seedCanonicalMessageRecord(state, {
          id: `plugin-only-${sequence}`, sequence, messageType: "tool", text: "Private tool output", toolName: "search",
        });
        const activityId = `assistant-${sequence}`;
        transcript.upsertActivity({ activityId, parentActivityId: null, scope: "assistant_turn",
          subjectId: `plugin-only-${sequence}`, callIndex: null, label: "Rally", action: "complete",
          revision: 1, occurredAtUtc: "2026-10-21T12:00:01.000Z" });
        for (const [action, revision, occurredAtUtc] of [
          ["start", 1, "2026-10-21T12:00:00.000Z"], ["complete", 2, "2026-10-21T12:00:01.000Z"],
        ] as const) transcript.upsertActivity({ activityId: `plugin-${sequence}`, parentActivityId: activityId,
          scope: "plugin", subjectId: "search", callIndex: null, label: "Search", action, revision, occurredAtUtc });
      }
      await seedParticipantMessage(state, { id: "final-reply", sequence: 9, authorType: "agent", text: "Final answer" });
    });
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));
    for (const turnId of ["opening-request", "working-reply", "plugin-only-3", "plugin-only-4",
      "plugin-only-5", "plugin-only-6", "plugin-only-7", "plugin-only-8", "final-reply"]) {
      const projection = await stub.conversationViewProjection({ type: "conversation_view_v1", region: "global",
        workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, substreamId: "0", turnId });
      expect(projection).not.toBeNull();
      await workspace.applyConversationView(projection);
    }
    const preview = await runInDurableObject(workspace, (_instance, state) =>
      new WorkspaceConversationView(state.storage).opening({ requestId: "00000000-0000-7000-8000-0000000008f2",
        parentId: WORKSTREAM_ID, substreamId: asSubstreamId("0") }));
    expect(preview.view?.transcript.ranges[0]?.turns.map((turn) => turn.turnId)).toEqual([
      "opening-request", "working-reply", "plugin-only-3", "plugin-only-4", "plugin-only-5",
      "plugin-only-6", "plugin-only-7", "plugin-only-8", "final-reply",
    ]);
    const response = await stub.fetch("https://substream.test/socket", { headers: {
      Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-workstream-id": WORKSTREAM_ID,
      "x-rally-substream-id": "0", "x-rally-user-id": USER_ID, "x-rally-session-id": SESSION_ID,
      "x-rally-socket-ticket-id": "00000000-0000-7000-8000-0000000008f1",
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const pending = nextMessageWhileOpen(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    const frame = ServerSocketEventSchema.parse(JSON.parse(String((await pending).data)));
    expect(frame.type).toBe("snapshot");
    if (frame.type !== "snapshot") throw new Error("snapshot_required");
    expect(frame.transcript.ranges[0]?.covered).toEqual({ startInclusive: 1, endExclusive: 10 });
    expect(frame.transcript.ranges.flatMap((range) => range.turns.flatMap((turn) =>
      turn.blocks.flatMap((block) => block.type === "text" ? [block.text] : []))))
      .toEqual(["Opening request", "Working on it", "Final answer"]);
    expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThanOrEqual(WORKSTREAM_REALTIME_MAX_FRAME_BYTES);
    socket.close(1000, "test complete");
  });

  // These three tests deliberately hash and persist enough payload to cross the
  // platform's 1 MB socket boundary in real workerd. Fixture construction is
  // not a product latency assertion, so each gets an integration-test timeout.
  it("narrows truthful transcript coverage when an opening socket frame exceeds its cap", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000801",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    // The oldest messages are the heavy ones, so the reader's resume window is
    // what puts the frame over the cap while the newest page stays small. Only
    // the newest page used to be reducible, which left the loop with nothing to
    // trim and failed the open outright.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE workstream SET title = 'Oversized resume', next_attention_ordinal = 81, updated_at = ?
          WHERE id = 1`,
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO member_attention
           (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
            manual_unread_from_ordinal, latest_mention_attention_ordinal, version,
            last_seen_at, updated_at)
         VALUES (?, 0, 20, NULL, 0, 1, ?, ?)`,
        USER_ID,
        Date.now(),
        Date.now(),
      );
      for (let sequence = 1; sequence <= 80; sequence += 1) {
        await seedParticipantMessage(state, {
          id: `00000000-0000-7000-8004-${String(sequence).padStart(12, "0")}`,
          sequence,
          text: sequence <= 40 ? "z".repeat(200_000) : `short ${sequence}`,
          authorType: "agent",
          now: 4_000 + sequence,
        });
      }
    });

    const snapshot = nextMessageWhileOpen(socket);
    socket.send(JSON.stringify({ type: "future_feed_event" }));
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0, future: true }));
    const frame = JSON.parse(String((await snapshot).data)) as {
      type: string;
      code?: string;
      transcript: { ranges: Array<{
        purpose: string;
        covered: { startInclusive: number; endExclusive: number };
        turns: Array<{ transcriptSequence: number }>;
      }> };
    };
    expect(frame.type).toBe("snapshot");
    const delivered = frame.transcript.ranges.flatMap((range) => range.turns);
    expect(delivered.map((turn) => turn.transcriptSequence)).toEqual([
      37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
      53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68,
      69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
    ]);
    expect(frame.transcript.ranges).toEqual([
      expect.objectContaining({
        purpose: "latest",
        covered: { startInclusive: 37, endExclusive: 81 },
      }),
    ]);
    expect(frame).not.toHaveProperty("messageFeed");
    expect(frame).not.toHaveProperty("resumeFeed");
  });

  it("narrows an oversized transcript range frame and reports only the covered prefix", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    await provisionBootstrappedWorkstream(stub, USER_ID);
    await runInDurableObject(stub, async (_instance, state) => {
      for (let sequence = 1; sequence <= 16; sequence += 1) {
        await seedParticipantMessage(state, {
          id: `00000000-0000-7000-8020-${String(sequence).padStart(12, "0")}`,
          sequence,
          text: sequence <= 11 ? "r".repeat(MESSAGE_MAX_CHARACTERS) : `short ${sequence}`,
          authorType: "agent",
          now: 20_000 + sequence,
        });
      }
    });
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8020-000000000801",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    try {
      const snapshotMessage = nextMessageOfType(socket, "snapshot");
      socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
      const snapshot = await snapshotMessage as {
        sequence: number;
        transcript: { snapshotId: string };
      };
      const rangeMessage = nextEncodedMessageOfType(socket, "transcript_range");
      socket.send(JSON.stringify({
        type: "load_transcript_range",
        requestId: "00000000-0000-7000-8020-000000000802",
        request: {
          snapshotId: snapshot.transcript.snapshotId,
          range: { startInclusive: 1, endExclusive: 12 },
          resumeAfterEventSequence: snapshot.sequence,
        },
      }));
      const { encoded, decoded } = await rangeMessage;
      const result = decoded.result as {
        requested: { startInclusive: number; endExclusive: number };
        covered: { startInclusive: number; endExclusive: number };
        turns: Array<{ transcriptSequence: number }>;
      };

      expect(new TextEncoder().encode(encoded).byteLength)
        .toBeLessThanOrEqual(WORKSTREAM_REALTIME_MAX_FRAME_BYTES);
      expect(result.requested).toEqual({ startInclusive: 1, endExclusive: 12 });
      expect(result.covered.startInclusive).toBe(1);
      expect(result.covered.endExclusive).toBeLessThan(12);
      const lastSequence = result.turns.at(-1)?.transcriptSequence;
      expect(lastSequence).toBeDefined();
      expect((lastSequence ?? 0) + 1).toBe(result.covered.endExclusive);
      expect(result.turns.map((turn) => turn.transcriptSequence)).toEqual(
        Array.from({ length: result.covered.endExclusive - 1 }, (_, index) => index + 1),
      );
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("serves a transcript range while this socket's own snapshot is assembling", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    await provisionBootstrappedWorkstream(stub, USER_ID);
    await runInDurableObject(stub, async (_instance, state) => {
      for (let sequence = 1; sequence <= 6; sequence += 1) {
        await seedParticipantMessage(state, {
          id: `00000000-0000-7000-8021-${String(sequence).padStart(12, "0")}`,
          sequence,
          text: `assembling ${sequence}`,
          authorType: "agent",
          now: 30_000 + sequence,
        });
      }
    });
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8021-000000000801",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    try {
      const snapshotMessage = nextMessageOfType(socket, "snapshot");
      socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
      const snapshot = await snapshotMessage as {
        sequence: number;
        transcript: { snapshotId: string };
      };

      // The window `request_snapshot` opens: this reader is subscribed and its
      // fence still stands, but the attachment says otherwise so that
      // broadcasts stay out while its replacement snapshot is assembled. A
      // range asked for inside it is still this reader's own question.
      await runInDurableObject(stub, async (_instance, state) => {
        const server = state.getWebSockets()[0]!;
        server.serializeAttachment({
          ...(server.deserializeAttachment() as Record<string, unknown>),
          subscribed: false,
          snapshotInFlight: true,
        });
      });

      const rangeMessage = nextMessageOfType(socket, "transcript_range");
      socket.send(JSON.stringify({
        type: "load_transcript_range",
        requestId: "00000000-0000-7000-8021-000000000802",
        request: {
          snapshotId: snapshot.transcript.snapshotId,
          range: { startInclusive: 1, endExclusive: 4 },
          resumeAfterEventSequence: snapshot.sequence,
        },
      }));
      const range = await rangeMessage as {
        requestId: string;
        result: {
          covered: { startInclusive: number; endExclusive: number };
          turns: Array<{ transcriptSequence: number }>;
        };
      };

      expect(range.requestId).toBe("00000000-0000-7000-8021-000000000802");
      expect(range.result.covered).toEqual({ startInclusive: 1, endExclusive: 4 });
      expect(range.result.turns.map((turn) => turn.transcriptSequence)).toEqual([1, 2, 3]);
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("names the request a refused transcript range answers", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8021-000000000901",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    try {
      // A socket that never subscribed is still refused. The caller is holding
      // a promise only this identity can settle, so the refusal has to carry
      // it — otherwise the refusal is invisible and the caller waits out its
      // own timeout instead.
      const refusal = nextMessageOfType(socket, "error");
      socket.send(JSON.stringify({
        type: "load_transcript_range",
        requestId: "00000000-0000-7000-8021-000000000902",
        request: {
          snapshotId: "00000000-0000-7000-8021-000000000903",
          range: { startInclusive: 1, endExclusive: 4 },
          resumeAfterEventSequence: 0,
        },
      }));

      expect(await refusal).toMatchObject({
        type: "error",
        code: "subscription_required",
        requestId: "00000000-0000-7000-8021-000000000902",
      });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("serves an indivisible oversized turn as a sequence-owning placeholder envelope", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    await provisionBootstrappedWorkstream(stub, USER_ID);
    const prepared = await prepareTranscriptFact({
      factId: "oversized-turn:block:0:fact:v2",
      factKind: "participant_message",
      audience: "participant",
      payload: {
        role: "assistant",
        content: "x".repeat(WORKSTREAM_REALTIME_MAX_FRAME_BYTES),
        structuredContent: null,
      },
      origin: { originKind: "protocol", sourceKind: null, sourceId: null, sourceRevision: null },
      runId: null,
      turnId: "oversized-turn",
      toolCallId: null,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await seedParticipantMessage(state, {
        id: "oversized-turn",
        sequence: 1,
        text: "placeholder",
        authorType: "agent",
        now: 30_000,
      });
      insertPreparedTranscriptFact(state.storage.sql, prepared, 30_001);
      state.storage.sql.exec(
        `UPDATE participant_transcript_blocks
            SET fact_id = ?, revision = revision + 1, updated_at = ?
          WHERE turn_id = 'oversized-turn' AND block_index = 0`,
        prepared.factId,
        30_001,
      );
      state.storage.sql.exec(
        `UPDATE participant_transcript_turns
            SET revision = revision + 1, updated_at = ?
          WHERE turn_id = 'oversized-turn'`,
        30_001,
      );
    });
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8030-000000000801",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    try {
      const snapshotMessage = nextEncodedMessageOfType(socket, "snapshot");
      socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
      const { encoded, decoded } = await snapshotMessage;
      expect(new TextEncoder().encode(encoded).byteLength)
        .toBeLessThanOrEqual(WORKSTREAM_REALTIME_MAX_FRAME_BYTES);
      const snapshot = decoded.transcript as {
        snapshotId: string;
        ranges: Array<{ turns: Array<{
          transcriptSequence: number;
          blocks: unknown[];
          blockCount: number;
          blocksOmitted?: boolean;
        }> }>;
      };
      const snapshotEnvelope = snapshot.ranges[0]!.turns[0]!;
      // The turn cannot fit a frame, so its envelope owns the exact sequence
      // with payloads deliberately omitted. There is no hydration protocol:
      // the placeholder is the whole oversized-turn contract.
      expect(snapshotEnvelope).toMatchObject({
        transcriptSequence: 1,
        blocks: [],
        blockCount: 1,
        blocksOmitted: true,
      });

      const rangeReply = nextEncodedMessageOfType(socket, "transcript_range");
      socket.send(JSON.stringify({
        type: "load_transcript_range",
        requestId: "00000000-0000-7000-8030-000000000800",
        request: {
          snapshotId: snapshot.snapshotId,
          range: { startInclusive: 1, endExclusive: 2 },
          resumeAfterEventSequence: Number(decoded.sequence),
        },
      }));
      const rangeFrame = await rangeReply;
      expect(new TextEncoder().encode(rangeFrame.encoded).byteLength)
        .toBeLessThanOrEqual(WORKSTREAM_REALTIME_MAX_FRAME_BYTES);
      const rangeResult = rangeFrame.decoded.result as {
        covered: { startInclusive: number; endExclusive: number };
        turns: Array<typeof snapshotEnvelope>;
      };
      expect(rangeResult.covered).toEqual({ startInclusive: 1, endExclusive: 2 });
      expect(rangeResult.turns[0]).toEqual(snapshotEnvelope);
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("delivers an oversized pending-only snapshot as a complete ordered chunk set", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    await provisionBootstrappedWorkstream(stub, USER_ID);
    await runInDurableObject(stub, async (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(WORKSTREAM_ID) });
      for (let index = 1; index <= 10; index += 1) {
        await admitFixturePendingInput(state, {
          inputId: `00000000-0000-7000-8010-${String(index).padStart(12, "0")}`,
          clientMessageId: `pending-snapshot-${index}`,
          text: `${index}:`.padEnd(100_000, "p"),
          mode: "queue",
          loopId: substreamLoopId(WORKSTREAM_ID),
          now: 10_000 + index,
        });
      }
    });
    const ticketId = "00000000-0000-7000-8010-000000000801";
    const ticketIssuedAt = Math.floor(Date.now() / 1_000);
    const ticketExpiresAt = ticketIssuedAt + 60;
    await expect(stub.prepareSocketAdmission({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
      userId: USER_ID,
      sessionId: SESSION_ID,
      ticketId,
      ticketIssuedAt,
      ticketExpiresAt,
      authorityGeneration: 1,
      role: "member",
      analyticsWorkspaceId: null,
      speculative: false,
    })).resolves.toEqual({ outcome: "admission_prepared" });
    await runInDurableObject(stub, (instance) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      expect(testable.preparedSocketAdmissions.get(ticketId)?.snapshot).toBeNull();
      expect(testable.preparedSocketSnapshotTicketId).toBeNull();
    });
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": ticketId,
        "x-rally-socket-ticket-expires-at": String(ticketExpiresAt),
        "x-rally-socket-admission-version": "1",
        "x-rally-socket-admission-authority-generation": "1",
        "x-rally-socket-admission-role": "member",
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    // One accumulating listener, not eleven concurrent `once` listeners — those
    // would all resolve with the first frame.
    const delivered = nextMessages(socket, 11);
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    const frames = (await delivered).map((event) =>
      JSON.parse(String(event.data)) as Record<string, unknown>);
    expect(frames[0]).toMatchObject({
      type: "snapshot",
      pendingInputChunkCount: 10,
      transcript: { pendingInputs: [] },
    });
    expect(frames.slice(1).map((frame) => frame.type)).toEqual(
      Array.from({ length: 10 }, () => "pending_inputs_snapshot_chunk"),
    );
    expect(frames.slice(1).flatMap((frame) => (frame.inputs as Array<{
      inputSequence: number;
    }>).map((input) => input.inputSequence))).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
  });

  it("bootstraps the presence-free feed during upgrade without a subscribe message", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await provisionBootstrappedWorkstream(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000600",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        "x-rally-socket-after-sequence": "0",
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const delivered = nextMessage(socket);
    socket.accept();

    expect(JSON.parse(String((await delivered).data))).toMatchObject({
      type: "snapshot",
      reason: "initial",
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets()[0]!.deserializeAttachment()).toMatchObject({
        afterSequence: 0,
        publishPresence: false,
        subscribed: true,
        role: "member",
      });
    });
    socket.close(1000, "test complete");
  });

  it("uses the exact ticket-prepared admission and snapshot on the upgrade fast path", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await provisionBootstrappedWorkstream(stub, USER_ID);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE participants SET first_opened_at = ? WHERE user_id = ?`,
        Date.now(),
        USER_ID,
      );
    });

    // A revocation can beat the deferred preparation RPC to this object. Keep
    // that ordering visible even though no preparation or socket existed when
    // the retraction arrived.
    const retractedBeforePreparationIssuedAt = Math.floor(Date.now() / 1_000) - 1;
    await stub.revokeSocketAccess({
      reason: "session_revoked",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    await expect(stub.prepareSocketAdmission({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
      userId: USER_ID,
      sessionId: SESSION_ID,
      ticketId: "00000000-0000-7000-8000-00000000060d",
      ticketIssuedAt: retractedBeforePreparationIssuedAt,
      ticketExpiresAt: retractedBeforePreparationIssuedAt + 60,
      authorityGeneration: 1,
      role: "member",
      analyticsWorkspaceId: null,
      afterSequence: 0,
      speculative: false,
    })).resolves.toEqual({ outcome: "refused" });
    // Sessions are never un-revoked in production. This fixture deliberately
    // continues with the same identity, so clear its synthetic retraction.
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as TestableSubstreamAgent).latestSocketRevocationAt = 0;
    });

    const revokedTicketId = "00000000-0000-7000-8000-00000000060f";
    const revokedTicketIssuedAt = Math.floor(Date.now() / 1_000);
    const revokedTicketExpiresAt = revokedTicketIssuedAt + 60;
    expect(await stub.prepareSocketAdmission({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
      userId: USER_ID,
      sessionId: SESSION_ID,
      ticketId: revokedTicketId,
      ticketIssuedAt: revokedTicketIssuedAt,
      ticketExpiresAt: revokedTicketExpiresAt,
      authorityGeneration: 1,
      role: "member",
      analyticsWorkspaceId: null,
      afterSequence: 0,
      speculative: false,
    })).toEqual({ outcome: "snapshot_prepared" });
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`)
      .bind("2026-09-02T00:00:00.000Z", SESSION_ID).run();
    await stub.revokeSocketAccess({
      reason: "session_revoked",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const revoked = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": revokedTicketId,
        "x-rally-socket-ticket-expires-at": String(revokedTicketExpiresAt),
        "x-rally-socket-after-sequence": "0",
        "x-rally-socket-admission-version": "1",
        "x-rally-socket-admission-authority-generation": "1",
        "x-rally-socket-admission-role": "member",
      },
    });
    expect(revoked.status).toBe(403);
    await revoked.arrayBuffer();
    await env.DB.prepare(`UPDATE sessions SET revoked_at = NULL WHERE id = ?`).bind(SESSION_ID).run();
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as TestableSubstreamAgent).latestSocketRevocationAt = 0;
    });

    const maintenanceTicketId = "00000000-0000-7000-8000-000000000611";
    const maintenanceTicketIssuedAt = Math.floor(Date.now() / 1_000);
    const maintenanceTicketExpiresAt = maintenanceTicketIssuedAt + 60;
    await expect(stub.prepareSocketAdmission({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
      userId: USER_ID,
      sessionId: SESSION_ID,
      ticketId: maintenanceTicketId,
      ticketIssuedAt: maintenanceTicketIssuedAt,
      ticketExpiresAt: maintenanceTicketExpiresAt,
      authorityGeneration: 1,
      role: "member",
      analyticsWorkspaceId: null,
      afterSequence: 0,
      speculative: false,
    })).resolves.toEqual({ outcome: "snapshot_prepared" });
    await env.DB.prepare(
      `UPDATE workstream_authority_control SET phase = 'maintenance_draining' WHERE id = 1`,
    ).run();
    const maintenance = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": maintenanceTicketId,
        "x-rally-socket-ticket-expires-at": String(maintenanceTicketExpiresAt),
        "x-rally-socket-after-sequence": "0",
        "x-rally-socket-admission-version": "1",
        "x-rally-socket-admission-authority-generation": "1",
        "x-rally-socket-admission-role": "member",
      },
    });
    expect(maintenance.status).toBe(503);
    await expect(maintenance.json()).resolves.toMatchObject({
      error: "workstream_maintenance",
      phase: "maintenance_draining",
    });
    await env.DB.prepare(
      `UPDATE workstream_authority_control SET phase = 'durable_object_open' WHERE id = 1`,
    ).run();

    const ticketId = "00000000-0000-7000-8000-000000000610";
    const ticketIssuedAt = Math.floor(Date.now() / 1_000);
    const ticketExpiresAt = ticketIssuedAt + 60;
    await expect(stub.prepareSocketAdmission({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
      userId: USER_ID,
      sessionId: SESSION_ID,
      ticketId,
      ticketIssuedAt,
      ticketExpiresAt,
      authorityGeneration: 1,
      role: "member",
      analyticsWorkspaceId: null,
      afterSequence: 0,
      speculative: false,
    })).resolves.toEqual({ outcome: "snapshot_prepared" });
    await runInDurableObject(stub, (instance) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      // The newer ticket replaces this room's maintenance-era preparation,
      // and only its one completed snapshot remains resident in the room.
      expect([...testable.preparedSocketAdmissions.keys()]).toEqual([ticketId]);
      expect(testable.preparedSocketSnapshotTicketId).toBe(ticketId);
    });

    // Once preparation has established the exact ticket-scoped decision, the
    // upgrade must neither re-run D1 session authorization nor rebuild detail.
    // Replacing both methods makes this test fail if either old blocking path
    // returns to the fast path.
    let originalSocketAuth: TestableSubstreamAgent["socketAuth"] | undefined;
    let originalAssembleSocketSnapshot: TestableSubstreamAgent["assembleSocketSnapshot"] | undefined;
    await runInDurableObject(stub, (instance) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      originalSocketAuth = testable.socketAuth;
      originalAssembleSocketSnapshot = testable.assembleSocketSnapshot;
      testable.socketAuth = async () => { throw new Error("unexpected_session_authorization"); };
      testable.assembleSocketSnapshot = async () => { throw new Error("unexpected_snapshot_assembly"); };
    });

    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": ticketId,
        "x-rally-socket-ticket-expires-at": String(ticketExpiresAt),
        "x-rally-socket-after-sequence": "0",
        "x-rally-socket-admission-version": "1",
        "x-rally-socket-admission-authority-generation": "1",
        "x-rally-socket-admission-role": "member",
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const delivered = nextMessage(socket);
    socket.accept();
    expect(JSON.parse(String((await delivered).data))).toMatchObject({
      type: "snapshot",
      reason: "initial",
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.getWebSockets()[0]!.deserializeAttachment()).toMatchObject({
        ticketId,
        role: "member",
        subscribed: true,
      });
    });
    socket.close(1000, "test complete");
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) => state.getWebSockets().length),
      { timeout: 5_000 },
    ).toBe(0);
    await runInDurableObject(stub, (instance) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      testable.socketAuth = originalSocketAuth!;
      testable.assembleSocketSnapshot = originalAssembleSocketSnapshot!;
    });

    const speculativeIssuedAt = Math.floor(Date.now() / 1_000);
    await expect(stub.prepareSocketAdmission({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
      userId: USER_ID,
      sessionId: SESSION_ID,
      ticketId: "00000000-0000-7000-8000-000000000612",
      ticketIssuedAt: speculativeIssuedAt,
      ticketExpiresAt: speculativeIssuedAt + 60,
      authorityGeneration: 1,
      role: "member",
      analyticsWorkspaceId: null,
      afterSequence: 0,
      speculative: true,
    })).resolves.toEqual({ outcome: "admission_prepared" });
    await runInDurableObject(stub, (instance) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      expect([...testable.preparedSocketAdmissions.values()][0]?.snapshot).toBeNull();
      expect(testable.preparedSocketSnapshotTicketId).toBeNull();
    });

    const invalidatedTicketId = "00000000-0000-7000-8000-000000000613";
    const invalidatedIssuedAt = Math.floor(Date.now() / 1_000);
    await expect(stub.prepareSocketAdmission({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      workstreamId: WORKSTREAM_ID,
      substreamId: asSubstreamId("0"),
      userId: USER_ID,
      sessionId: SESSION_ID,
      ticketId: invalidatedTicketId,
      ticketIssuedAt: invalidatedIssuedAt,
      ticketExpiresAt: invalidatedIssuedAt + 60,
      authorityGeneration: 1,
      role: "member",
      analyticsWorkspaceId: null,
      afterSequence: 0,
      speculative: false,
    })).resolves.toEqual({ outcome: "snapshot_prepared" });
    expect((await stub.handleProductRequest({
      operation: "mark_unread",
      auth: {
        sessionId: SESSION_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        region: "global",
        role: "member",
      },
    })).status).toBe(200);
    await runInDurableObject(stub, (instance) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      expect(testable.preparedSocketAdmissions.get(invalidatedTicketId)?.snapshot).toBeNull();
      expect(testable.preparedSocketSnapshotTicketId).toBeNull();
    });
  });

  it("does not trust an unsigned bootstrap cursor from the room URL", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await provisionBootstrappedWorkstream(stub, USER_ID);

    const response = await stub.fetch("https://substream.test/socket?afterSequence=0", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-00000000060e",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });

    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.getWebSockets()[0]!.deserializeAttachment()).toMatchObject({
        afterSequence: 0,
        publishPresence: true,
        subscribed: false,
      });
    });
    socket.close(1000, "test complete");
  });

  it("closes an accepted socket when upgrade-time subscription bootstrap throws", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await provisionBootstrappedWorkstream(stub, USER_ID);
    await runInDurableObject(stub, (instance) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      testable.fulfillSubscription = async () => {
        throw new Error("injected_subscription_bootstrap_failure");
      };
    });

    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-00000000060f",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        "x-rally-socket-after-sequence": "0",
      },
    });

    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    const closed = nextClose(socket);
    socket.accept();
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) => state.getWebSockets().length),
      { timeout: 5_000 },
    ).toBe(0);
  });

  it("sends the newest page and the reader's own position in one snapshot", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000601",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    // 60 messages, with this reader stopped a long way behind the end.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE workstream SET title = 'Two windows', next_attention_ordinal = 61, updated_at = ?
          WHERE id = 1`,
        Date.now(),
      );
      // Stopped at 30, so the first unread is 31 — well behind the newest page.
      state.storage.sql.exec(
        `INSERT INTO member_attention
           (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
            manual_unread_from_ordinal, latest_mention_attention_ordinal, version,
            last_seen_at, updated_at)
         VALUES (?, 0, 30, NULL, 0, 1, ?, ?)`,
        USER_ID,
        Date.now(),
        Date.now(),
      );
      for (let sequence = 1; sequence <= 60; sequence += 1) {
        await seedParticipantMessage(state, {
          id: `00000000-0000-7000-8003-${String(sequence).padStart(12, "0")}`,
          sequence,
          text: `message ${sequence}`,
          authorType: "agent",
          attentionOrdinal: sequence,
          now: 3_000 + sequence,
        });
      }
    });

    const snapshot = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    const frame = JSON.parse(String((await snapshot).data)) as {
      type: string;
      workstream: { firstUnreadSequenceNumber: number | null };
      transcript: { ranges: Array<{ turns: Array<{ transcriptSequence: number }> }> };
    };
    expect(frame.type).toBe("snapshot");
    // The newest page is bounded now: a scroll-back buffer is not worth paying
    // for on the frame a person waits to see.
    const sequences = frame.transcript.ranges.flatMap((range) => range.turns)
      .map((turn) => turn.transcriptSequence);
    expect(sequences.at(-1)).toBe(60);

    // And the reader's own position arrives with it, so opening on it costs no
    // second request. `around` splits its limit either side of the sequence.
    const resumeAt = frame.workstream.firstUnreadSequenceNumber!;
    expect(resumeAt).toBeLessThan(41);
    expect(sequences).toContain(resumeAt);
  });

  it("serves a canonical snapshot on the same socket when hibernation lost replay history", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000602",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    // The durable cursor survived, while the events that produced it existed
    // only in the old instance's bounded replay cache.
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE workstream
            SET title = 'Hibernation recovery', next_attention_ordinal = 61, updated_at = ?
          WHERE id = 1`,
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO member_attention
           (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
            manual_unread_from_ordinal, latest_mention_attention_ordinal, version,
            last_seen_at, updated_at)
         VALUES (?, 0, 30, NULL, 0, 1, ?, ?)`,
        USER_ID,
        Date.now(),
        Date.now(),
      );
      for (let sequence = 1; sequence <= 60; sequence += 1) {
        await seedParticipantMessage(state, {
          id: `00000000-0000-7000-8006-${String(sequence).padStart(12, "0")}`,
          sequence,
          text: `message ${sequence}`,
          authorType: "agent",
          now: 6_000 + sequence,
        });
      }
      state.storage.sql.exec(`UPDATE realtime_state SET event_sequence = 2 WHERE id = 1`);
    });
    await evictDurableObject(stub);

    const delivered = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 1, publishPresence: false }));
    const frame = JSON.parse(String((await delivered).data)) as {
      type: string;
      reason: string;
      sequence: number;
      workstream: { viewers: unknown[] };
      transcript: { snapshotThrough: number };
    };

    expect(frame).toMatchObject({
      type: "snapshot",
      reason: "history_unavailable",
      sequence: 2,
    });
    expect(frame.workstream.viewers).toEqual([]);
    expect(frame.transcript.snapshotThrough).toBe(60);
    expect(frame).not.toHaveProperty("messageFeed");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets()[0]!.deserializeAttachment()).toMatchObject({
        afterSequence: 2,
        publishPresence: false,
        subscribed: true,
      });
      expect(state.storage.sql.exec<{ event_sequence: number }>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ).one().event_sequence).toBe(2);
    });
    socket.close(1000, "test complete");
  });

  it("falls back without admitting the socket when a recovery snapshot cannot be assembled", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000603",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE realtime_state SET event_sequence = 2 WHERE id = 1`);
    });
    // Revocation between socket admission and cold snapshot assembly is one
    // real failure boundary. It leaves every binding and schema intact while
    // making the canonical snapshot deliberately unavailable.
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), SESSION_ID).run();
    await evictDurableObject(stub);

    const fallback = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 1 }));
    expect(JSON.parse(String((await fallback).data))).toMatchObject({
      type: "resync_required",
      reason: "history_unavailable",
      latestSequence: 2,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.getWebSockets()[0]!.deserializeAttachment()).toMatchObject({
        afterSequence: 0,
        subscribed: false,
      });
    });
    socket.close(1000, "test complete");
  });

  it("re-serves canonical state to a subscribed viewer and puts it back in the room", async () => {
    await seedOpenAuthority();
    // The snapshot is assembled from D1 as well as object-local SQL, and this
    // suite starts with no schema, so a test declares what the path it exercises
    // reads.
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000131",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    // A viewer that never subscribed has no feed to refresh, and answering one
    // would hand out canonical state on a socket that skipped the subscribe
    // path's authority and maintenance checks.
    const refusal = nextMessage(socket);
    socket.send(JSON.stringify({ type: "request_snapshot" }));
    expect(JSON.parse(String((await refusal).data))).toMatchObject({
      type: "error",
      code: "subscription_required",
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const server = state.getWebSockets()[0]!;
      server.serializeAttachment({
        ...(server.deserializeAttachment() as Record<string, unknown>),
        subscribed: true,
      });
      state.storage.sql.exec(
        `UPDATE workstream SET title = 'Re-served snapshot', updated_at = ? WHERE id = 1`,
        Date.now(),
      );
      for (let sequence = 1; sequence <= 3; sequence += 1) {
        await seedParticipantMessage(state, {
          id: `00000000-0000-7000-8002-${String(sequence).padStart(12, "0")}`,
          sequence,
          text: `canonical ${sequence}`,
          authorType: "agent",
          now: 2_000 + sequence,
        });
      }
    });

    const snapshot = nextMessage(socket);
    socket.send(JSON.stringify({ type: "request_snapshot" }));
    const frame = JSON.parse(String((await snapshot).data)) as {
      type: string;
      reason: string;
      workstream: { id: string };
      transcript: { ranges: Array<{ turns: Array<{ transcriptSequence: number }> }> };
    };
    expect(frame.type).toBe("snapshot");
    expect(frame.reason).toBe("reconciliation");
    expect(frame.workstream.id).toBe(WORKSTREAM_ID);
    expect(frame.transcript.ranges.flatMap((range) => range.turns)
      .map((turn) => turn.transcriptSequence)).toEqual([1, 2, 3]);

    // The request holds the socket out of broadcasts while the snapshot is
    // assembled. Leaving it that way would silently stop every later frame, so
    // the end state is the one thing worth pinning here.
    await runInDurableObject(stub, (_instance, state) => {
      const attachment = state.getWebSockets()[0]!.deserializeAttachment() as { subscribed: boolean };
      expect(attachment.subscribed).toBe(true);
    });
  });

  it("publishes a routed participant turn to a subscribed viewer without a reconnect", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000141",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    await runInDurableObject(stub, async (_instance, state) => {
      const server = state.getWebSockets()[0]!;
      server.serializeAttachment({
        ...(server.deserializeAttachment() as Record<string, unknown>),
        subscribed: true,
      });
    });

    try {
      const delivered = nextMessageOfType(socket, "transcript_turn_upserted");
      const append = await stub.fetch("https://substream.test/internal/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          operation: "appendMessage",
          args: [{
            messageId: "00000000-0000-7000-8000-000000000142",
            clientMessageId: "routed-live-message",
            authorType: "external",
            authorUserId: null,
            externalActorJson: JSON.stringify({ provider: "slack", displayName: "Release bot" }),
            messageType: "text",
            text: "The deploy finished.",
            structuredContentJson: null,
            producedByRunId: null,
            now: Date.parse("2026-08-26T20:00:00.000Z"),
          }],
        }),
      });
      expect(append.status).toBe(200);
      expect(await append.json()).toMatchObject({ ok: true, value: { outcome: "appended" } });
      expect(await delivered).toMatchObject({
        type: "transcript_turn_upserted",
        turn: {
          turnId: "00000000-0000-7000-8000-000000000142",
          clientMessageId: "routed-live-message",
          actor: "external",
          blocks: [{ type: "text", text: "The deploy finished." }],
        },
      });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("recovers a committed semantic event after the post-commit drain crashes", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);

    await runInDurableObject(stub, async (instance, state) => {
      const messages = new WorkstreamMessageStorage(state.storage);
      await messages.appendMessage({
        messageId: "00000000-0000-7000-8000-00000000014a",
        clientMessageId: "semantic-crash-window",
        authorType: "external",
        authorUserId: null,
        externalActorJson: JSON.stringify({ provider: "slack", displayName: "Release bot" }),
        messageType: "text",
        text: "Canonical before publication",
        structuredContentJson: null,
        producedByRunId: null,
        now: Date.parse("2026-08-26T20:00:00.000Z"),
      });

      const testable = instance as unknown as TestableSubstreamAgent;
      const delivery = vi.spyOn(testable, "deliverCommittedRealtimeEvent")
        .mockRejectedValueOnce(new Error("forced_semantic_delivery_failure"));
      await expect(testable.drainSemanticRealtimeOutbox())
        .rejects.toThrow("forced_semantic_delivery_failure");
      delivery.mockRestore();

      // The canonical row and its exact room sequence survive together. The
      // outbox is acknowledged only after delivery succeeds.
      expect(state.storage.sql.exec(
        `SELECT turn_id FROM participant_transcript_turns WHERE turn_id = ?`,
        "00000000-0000-7000-8000-00000000014a",
      ).one()).toEqual({ turn_id: "00000000-0000-7000-8000-00000000014a" });
      expect(state.storage.sql.exec(
        `SELECT source_version, state FROM durable_outbox
          WHERE channel = 'semantic_realtime_v1'`,
      ).one()).toEqual({ source_version: 1, state: "pending" });
      state.storage.sql.exec(
        `UPDATE durable_outbox SET not_before = 0
          WHERE channel = 'semantic_realtime_v1'`,
      );
    });

    // Simulate eviction in the gap before the best-effort continuation could
    // re-arm delivery. Construction derives the alarm from the durable outbox.
    await evictDurableObject(stub);
    await stub.wake();
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) => Number(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM durable_outbox
          WHERE channel = 'semantic_realtime_v1'`,
      ).one().count)),
      { timeout: 4_000, interval: 50 },
    ).toBe(0);
  });

  it("hydrates an overtaken pending upsert as a delivered removal from the minimal receipt", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);

    await runInDurableObject(stub, async (instance, state) => {
      const inputId = "00000000-0000-7000-8000-00000000014b";
      await new WorkstreamMessageStorage(state.storage).appendMessage({
        messageId: inputId,
        clientMessageId: "semantic-overtaken-pending",
        authorType: "external",
        authorUserId: null,
        externalActorJson: JSON.stringify({ provider: "slack", displayName: "Release bot" }),
        messageType: "text",
        text: "Canonical before the pending upsert drained",
        structuredContentJson: null,
        producedByRunId: null,
        now: Date.parse("2026-08-26T20:00:00.000Z"),
      });
      const turn = state.storage.sql.exec<{
        attention_ordinal: number;
      }>(
        `SELECT attention_ordinal FROM participant_transcript_turns WHERE turn_id = ?`,
        inputId,
      ).one();
      const loops = new SubstreamLoopStorage(state.storage);
      const loop = loops.loop() ?? loops.ensureLoop({
        loopId: substreamLoopId(WORKSTREAM_ID),
        bindStateRevision: 0,
        now: Date.parse("2026-08-26T20:00:00.001Z"),
      });
      state.storage.sql.exec(
        `INSERT INTO delivered_loop_inputs
           (input_id, loop_id, input_sequence, delivered_turn_id,
            delivered_attention_ordinal, delivered_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
        inputId,
        loop.loop_id,
        inputId,
        turn.attention_ordinal,
        Date.parse("2026-08-26T20:00:00.001Z"),
      );

      const event = await (instance as unknown as TestableSubstreamAgent).semanticRealtimeEvent({
        messageId: "semantic-realtime:1",
        sequence: 1,
        occurredAtUtc: "2026-08-26T20:00:00.001Z",
        reference: { kind: "loop_input_upserted", inputId },
      });
      expect(event).toMatchObject({
        type: "loop_input_removed",
        sequence: 1,
        inputId,
        outcome: "delivered",
      });
    });
  });

  it("forces subscribed viewers to resync when a committed runtime event exceeds the frame", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000143",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    await runInDurableObject(stub, async (_instance, state) => {
      const server = state.getWebSockets()[0]!;
      server.serializeAttachment({
        ...(server.deserializeAttachment() as Record<string, unknown>),
        subscribed: true,
      });
    });

    try {
      const resync = nextMessageOfType(socket, "resync_required");
      await runInDurableObject(stub, async (instance) => {
        await (instance as unknown as TestableSubstreamAgent).publishAgentRuntimeEvent({
          type: "transcript_turn_upserted",
          turn: {
            transcriptSequence: 1,
            turnId: "00000000-0000-7000-8000-000000000144",
            entryKind: "conversation",
            actor: "external",
            authorUserId: null,
            authorSnapshot: null,
            clientMessageId: "oversized-runtime-event",
            externalActor: null,
            attentionOrdinal: null,
            createdAtUtc: "2026-08-26T20:00:00.000Z",
            revision: 1,
            blocks: [{
              type: "text",
              blockId: "00000000-0000-7000-8000-000000000144:text",
              blockIndex: 0,
              text: "x".repeat(WORKSTREAM_REALTIME_MAX_FRAME_BYTES),
              streaming: false,
              mentions: [],
              attachments: [],
              messageType: "text",
              structuredContent: null,
            }],
            activityId: null,
          },
        });
      });
      expect(await resync).toMatchObject({
        type: "resync_required",
        reason: "history_unavailable",
        sequence: 1,
        latestSequence: 1,
      });
    } finally {
      socket.close(1000, "test complete");
    }
  });

  it("restores active compaction in a hibernating snapshot and suppresses it after terminal state", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const harnessRunId = "00000000-0000-7000-8000-000000000125";
    const attemptId = "00000000-0000-7000-8000-000000000126";
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE workstream SET title = 'Compaction snapshot', exact_state = 'running', updated_at = ?
          WHERE id = 1`,
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO runs
           (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
            next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
            idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
            input_tokens, output_tokens, cost_micros, output_bytes, origin,
            execution_principal_json, chain_depth, created_at, updated_at)
         VALUES (?, '0', 'running', '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0,
                 0, 0, 0, 0, 'user_message', '{}', 0, ?, ?)`,
        harnessRunId,
        Date.now(),
        Date.now(),
        Date.now(),
      );
      state.storage.sql.exec(
        `UPDATE runs
            SET legacy_attempt_id = ?, lease_owner = 'compaction-test-owner',
                lease_expires_at = ?
          WHERE run_id = ?`,
        attemptId,
        Date.now() + 600_000,
        harnessRunId,
      );
      await (instance as unknown as TestableSubstreamAgent).publishAgentRuntimeEvent({
        type: "compaction_started",
        compaction: {
          harnessRunId,
          attemptId,
          compactionIndex: 2,
          trigger: "auto",
          startedAt: "2026-08-17T20:00:02.000Z",
        },
      });
    });
    const detailResult = await stub.handleProductRequest({
      operation: "get",
      auth: {
        sessionId: SESSION_ID,
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        region: "global",
        role: "member",
      },
    });
    expect(JSON.parse(detailResult.bodyJson)).toMatchObject({ id: WORKSTREAM_ID });
    expect(detailResult.status).toBe(200);
    const connect = async (ticketId: string): Promise<WebSocket> => {
      const response = await stub.fetch("https://substream.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-rally-workspace-id": WORKSPACE_ID,
          "x-rally-workstream-id": WORKSTREAM_ID,
          "x-rally-substream-id": "0",
          "x-rally-user-id": USER_ID,
          "x-rally-session-id": SESSION_ID,
          "x-rally-socket-ticket-id": ticketId,
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        },
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      return socket;
    };

    const first = await connect("00000000-0000-7000-8000-000000000127");
    await evictDurableObject(stub);
    const firstSnapshot = nextMessage(first);
    first.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    expect(JSON.parse(String((await firstSnapshot).data))).toMatchObject({
      type: "snapshot",
      workstream: { harnessStatus: "running", latestHarnessRunId: harnessRunId },
      activeCompaction: { harnessRunId, attemptId, compactionIndex: 2, trigger: "auto" },
    });
    first.close(1000, "done");

    const recoveredAttemptId = "00000000-0000-7000-8000-000000000129";
    await runInDurableObject(stub, async (instance, state) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      state.storage.sql.exec(
        `UPDATE runs
            SET legacy_attempt_id = ?, lease_owner = 'recovered-compaction-test-owner',
                lease_expires_at = ?
          WHERE run_id = ?`,
        recoveredAttemptId,
        Date.now() + 600_000,
        harnessRunId,
      );
      await testable.publishAgentRuntimeEvent({
        type: "compaction_started",
        compaction: {
          harnessRunId,
          attemptId: recoveredAttemptId,
          compactionIndex: 2,
          trigger: "auto",
          startedAt: "2026-08-17T20:00:03.000Z",
        },
      });
      await testable.publishAgentRuntimeEvent({
        type: "compaction_finished",
        harnessRunId,
        attemptId,
        compactionIndex: 2,
        outcome: "completed",
      });
      expect(state.storage.sql.exec<{ attempt_id: string }>(
        `SELECT attempt_id FROM active_agent_compaction WHERE id = 1`,
      ).one().attempt_id).toBe(recoveredAttemptId);
    });
    const recovered = await connect("00000000-0000-7000-8000-000000000128");
    await evictDurableObject(stub);
    const recoveredSnapshot = nextMessage(recovered);
    recovered.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    expect(JSON.parse(String((await recoveredSnapshot).data))).toMatchObject({
      type: "snapshot",
      workstream: { harnessStatus: "running", latestHarnessRunId: harnessRunId },
      activeCompaction: {
        harnessRunId,
        attemptId: recoveredAttemptId,
        compactionIndex: 2,
      },
    });
    recovered.close(1000, "done");

    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE workstream SET exact_state = 'completed', updated_at = ? WHERE id = 1`,
        Date.now(),
      );
      state.storage.sql.exec(
        `UPDATE runs SET status = 'completed', completed_at = ?, updated_at = ? WHERE run_id = ?`,
        Date.now(),
        Date.now(),
        harnessRunId,
      );
      await (instance as unknown as TestableSubstreamAgent).publishAgentRuntimeEvent({
        type: "harness_status_changed",
        status: "completed",
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM active_agent_compaction`,
      ).one().count).toBe(0);
    });
    const second = await connect("00000000-0000-7000-8000-000000000130");
    await evictDurableObject(stub);
    const secondSnapshot = nextMessage(second);
    second.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    expect(JSON.parse(String((await secondSnapshot).data))).toMatchObject({
      type: "snapshot",
      workstream: { harnessStatus: "completed", latestHarnessRunId: harnessRunId },
      activeCompaction: null,
    });
    second.close(1000, "done");
  });

  it("broadcasts inference delay, restores it on reconnect, and fences settled or superseded attempts", async () => {
    await seedOpenAuthority();
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
      )`),
      env.DB.prepare(`CREATE TABLE workstream_pins (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
        PRIMARY KEY (workstream_id, user_id)
      )`),
      env.DB.prepare(`CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        owner_user_id TEXT, display_name TEXT NOT NULL
      )`),
    ]);
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const harnessRunId = "00000000-0000-7000-8000-000000000125";
    const childRunId = "00000000-0000-7000-8000-000000000145";
    const attemptId = "00000000-0000-7000-8000-000000000126";
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE workstream SET title = 'Inference wait', exact_state = 'running', updated_at = ?
          WHERE id = 1`,
        Date.now(),
      );
      for (const executionId of [harnessRunId, childRunId]) {
        state.storage.sql.exec(
          `INSERT INTO runs
             (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
              next_action_cursor, input_fence_seq, revision, started_at, active_elapsed_ms,
              idle_elapsed_ms, step_count, subrequest_count, retry_count, tool_count,
              input_tokens, output_tokens, cost_micros, output_bytes, origin,
              execution_principal_json, chain_depth, parent_run_id, chain_root_run_id, created_at, updated_at)
           VALUES (?, '0', 'running', '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0,
                   0, 0, 0, 0, 'user_message', '{}', ?, ?, ?, ?, ?)`,
          executionId,
          Date.now(),
          executionId === harnessRunId ? 0 : 1,
          executionId === harnessRunId ? null : harnessRunId,
          harnessRunId,
          Date.now(),
          Date.now(),
        );
        state.storage.sql.exec(`UPDATE runs SET legacy_attempt_id = ?, lease_expires_at = ? WHERE run_id = ?`,
          attemptId, Date.now() + 600_000, executionId);
      }
      state.storage.sql.exec(`UPDATE runs SET parent_tool_call_id = ? WHERE run_id = ?`,
        "call:child", childRunId);
    });
    const connect = async (ticketId: string): Promise<WebSocket> => {
      const response = await stub.fetch("https://substream.test/socket", {
        headers: {
          Upgrade: "websocket",
          "x-rally-workspace-id": WORKSPACE_ID,
          "x-rally-workstream-id": WORKSTREAM_ID,
          "x-rally-substream-id": "0",
          "x-rally-user-id": USER_ID,
          "x-rally-session-id": SESSION_ID,
          "x-rally-socket-ticket-id": ticketId,
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
        },
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      return socket;
    };

    const delay = {
      type: "inference_delay_changed",
      harnessRunId, executionId: harnessRunId, attemptId,
      inferenceRequestId: "00000000-0000-7000-8000-000000000140",
      turnId: "turn:1", active: true,
    };
    const publish = async (event: Record<string, unknown>) => {
      const result = await stub.publishEvent({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, event });
      expect(result.status).toBe(202);
    };
    const first = await connect("00000000-0000-7000-8000-000000000127");
    const second = await connect("00000000-0000-7000-8000-000000000128");
    try {
      for (const socket of [first, second]) {
        const snapshot = nextMessageOfType(socket, "snapshot");
        socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
        expect(await snapshot).toMatchObject({ activeInferenceDelays: [] });
      }
      const notices = [first, second].map((socket) => nextMessageOfType(socket, delay.type));
      await publish(delay);
      for (const notice of notices) expect(await notice).toMatchObject(delay);
      await evictDurableObject(stub);
      const reconnect = nextMessageOfType(first, "snapshot");
      first.send(JSON.stringify({ type: "request_snapshot" }));
      expect(await reconnect).toMatchObject({ activeInferenceDelays: [{ inferenceRequestId: delay.inferenceRequestId }] });

      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE workstream SET exact_state = 'completed' WHERE id = 1`);
      });
      const stoppedResync = nextMessageOfType(first, "resync_required");
      first.send(JSON.stringify({ type: "subscribe", afterSequence: 100_000 }));
      expect(await stoppedResync).toMatchObject({ activeInferenceDelays: [] });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE workstream SET exact_state = 'running' WHERE id = 1`);
      });
      const restored = nextMessageOfType(first, "snapshot");
      first.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
      expect(await restored).toMatchObject({ activeInferenceDelays: [{ inferenceRequestId: delay.inferenceRequestId }] });

      const concurrent = { ...delay, parentAttemptId: attemptId, executionId: childRunId, inferenceRequestId: "00000000-0000-7000-8000-000000000141" };
      const concurrentNotice = nextMessageOfType(first, delay.type);
      await publish(concurrent);
      expect(await concurrentNotice).toMatchObject(concurrent);
      const cleared = nextMessageOfType(first, delay.type);
      await publish({ ...delay, active: false });
      expect(await cleared).toMatchObject({ ...delay, active: false });
      const late = nextMessageOfType(first, delay.type);
      await publish(delay);
      expect(await late).toMatchObject({ ...delay, active: false });
      const remaining = nextMessageOfType(first, "snapshot");
      first.send(JSON.stringify({ type: "request_snapshot" }));
      expect((await remaining).activeInferenceDelays).toEqual([{
        harnessRunId, executionId: childRunId, attemptId, parentAttemptId: attemptId,
        inferenceRequestId: concurrent.inferenceRequestId, turnId: delay.turnId,
      }]);

      // Superseding only the parent must fence a still-leased child's notice.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE runs SET legacy_attempt_id = ? WHERE run_id = ?`,
          "00000000-0000-7000-8000-000000000142", harnessRunId);
      });
      const parentStale = nextMessageOfType(first, delay.type);
      await publish({ ...concurrent, inferenceRequestId: "00000000-0000-7000-8000-000000000146" });
      expect(await parentStale).toMatchObject({ active: false });
      const parentSnapshot = nextMessageOfType(first, "snapshot");
      first.send(JSON.stringify({ type: "request_snapshot" }));
      expect(await parentSnapshot).toMatchObject({ activeInferenceDelays: [] });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE runs SET legacy_attempt_id = ? WHERE run_id = ?`, attemptId, harnessRunId);
      });

      // A clear received after lease expiry must remain cleared after renewal.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`,
          Date.now() - 1, childRunId);
      });
      await publish({ ...concurrent, active: false });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE runs SET lease_expires_at = ? WHERE run_id = ?`,
          Date.now() + 600_000, childRunId);
      });
      const renewed = nextMessageOfType(first, "snapshot");
      first.send(JSON.stringify({ type: "request_snapshot" }));
      expect(await renewed).toMatchObject({ activeInferenceDelays: [] });

      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE runs SET legacy_attempt_id = ? WHERE run_id IN (?, ?)`,
          "00000000-0000-7000-8000-000000000142", harnessRunId, childRunId);
      });
      const stale = nextMessageOfType(first, delay.type);
      await publish({ ...concurrent, inferenceRequestId: "00000000-0000-7000-8000-000000000143" });
      expect(await stale).toMatchObject({ active: false });
      const recovered = nextMessageOfType(first, "snapshot");
      first.send(JSON.stringify({ type: "request_snapshot" }));
      expect(await recovered).toMatchObject({ activeInferenceDelays: [] });

      const replacement = nextMessageOfType(first, delay.type);
      await publish({ ...delay, attemptId: "00000000-0000-7000-8000-000000000142",
        inferenceRequestId: "00000000-0000-7000-8000-000000000144" });
      expect(await replacement).toMatchObject({ active: true });

      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE runs SET status = 'completed' WHERE run_id = ?`, harnessRunId);
        state.storage.sql.exec(`UPDATE workstream SET exact_state = 'completed' WHERE id = 1`);
      });
      const done = nextMessageOfType(first, "harness_status_changed");
      await publish({ type: "harness_status_changed", status: "completed" });
      expect(await done).toMatchObject({ status: "completed" });
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM inference_delay_status`,
        ).one().count).toBe(0);
      });
      const terminalLate = nextMessageOfType(first, delay.type);
      await publish(delay);
      expect(await terminalLate).toMatchObject({ active: false });
      const terminalSnapshot = nextMessageOfType(first, "snapshot");
      first.send(JSON.stringify({ type: "request_snapshot" }));
      expect(await terminalSnapshot).toMatchObject({ activeInferenceDelays: [] });
    } finally {
      first.close(1000, "done"); second.close(1000, "done");
    }
  });

  it("ignores retired message events and accepts the next authenticated subscription", async () => {
    await seedOpenAuthority();
    const id = env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    const bootstrap = await fetchAndDrain(stub, "https://substream.test/internal/runtime-bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
        parentKind: "workstream",
        parentId: WORKSTREAM_ID,
        generation: 1,
      }),
    });
    expect(bootstrap.status).toBe(200);
    await seatBootstrapParticipant(stub, USER_ID);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000106",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    if (response.status !== 101) {
      throw new Error(`substream socket rejected: ${response.status} ${await response.text()}`);
    }
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    socket!.accept();
    await evictDurableObject(stub);
    const pong = nextMessage(socket!);
    socket!.send("ping");
    expect((await pong).data).toBe("pong");
    const pageReceipt = nextMessageWhileOpen(socket!);
    socket!.send(JSON.stringify({
      type: "load_message_page",
      requestId: "00000000-0000-7000-8000-000000000118",
      cursor: { direction: "before", value: "10" },
    }));
    socket!.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    // This bootstrap-only room has no canonical snapshot yet; subscribe
    // requests recovery rather than reporting an invalid unknown event.
    expect(JSON.parse(String((await pageReceipt).data))).toMatchObject({ type: "resync_required" });
    socket!.close(1000, "done");
  });
  // The production stall in one assertion, against the real objects rather than
  // the shared helper: `nextLoopWorkAt`/`nextRunAt` once consulted the
  // in-memory drain flag, so a claimed run stopped contributing a due time, the
  // alarm was deleted, and the cancelled drain left nothing to rediscover it.
  // A drain that never settles is exactly the state a cancellation produces.
  it("keeps a claimed run schedulable while a drain is in flight", async () => {
    await seedOpenAuthority();
    const wedged = new Promise<void>(() => {});

    const substream = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await substream.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    await runInDurableObject(substream, async (instance, state) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      state.storage.sql.exec(
        `INSERT INTO runs (
           run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
           model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
           active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
           tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
           execution_context_json, execution_available_at, created_at, updated_at
         ) VALUES ('run-wedged', '0', NULL, 'admitted', '{}', 0, 0, '', 0, 0, 1,
                   0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, 1, 1, 1)`,
        JSON.stringify({
          region: "global",
          workspaceId: WORKSPACE_ID,
          parentKind: "workstream",
          parentId: WORKSTREAM_ID,
          substreamId: "0",
          loopId: substreamLoopId(WORKSTREAM_ID),
          harnessRunId: "run-wedged",
          triggerMessageId: null,
          activityId: null,
          executionPrincipal: { type: "system" },
          reason: "user_message",
        }),
      );
      // Put the drain in the state a cancelled invocation leaves behind.
      void testable.agentDrain.resume(() => wedged, () => undefined);
      expect(testable.nextLoopWorkAt()).not.toBeNull();
    });
  });
});
