/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import {
  asAutomationId,
  asBlockId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  MESSAGE_MAX_CHARACTERS,
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  type BlockDashboardBlockRun,
} from "@rally/contracts";
import {
  evictDurableObject,
  listDurableObjectIds,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubstreamAgent } from "../src/durable-objects/substream-agent";
import type { AutomationAgent } from "../src/durable-objects/automation-agent";
import {
  BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS,
  BlockDashboardAgent,
} from "../src/durable-objects/block-dashboard-agent";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS, WorkspaceDO } from "../src/durable-objects/workspace-do";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { ScheduledAlarmStore } from "../src/durable-objects/scheduled-alarms";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { WorkstreamDO } from "../src/durable-objects/workstream-do";
import { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import type { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { WorkstreamMessageStorage } from "../src/durable-objects/workstream-message-storage";
import {
  insertPreparedTranscriptFact,
  prepareTranscriptFact,
} from "../src/durable-objects/workstream-transcript-storage";
import type { Env } from "../src/env";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import {
  admitFixturePendingInput,
  seedCanonicalMessageRecord,
  seedParticipantMessage,
  holdLoopExecuting,
} from "./helpers/substream-fixture";
import {
  automationAgentName,
  substreamAgentName,
  substreamLoopId,
  blockDashboardAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import {
  workstreamRegionalEffectHash,
  type WireWorkstreamRegionalEffect,
  type WorkstreamRegionalEffect,
} from "../src/durable-objects/workstream-regional-effect";
import {
  BlockDashboardBlockDispatchSchema,
  blockDashboardBlockResultHash,
  type BlockDashboardBlockDispatch,
} from "../src/durable-objects/block-dashboard-protocol";
import { WorkspaceActivityEventListResultSchema } from "../src/durable-objects/workspace-activity-event-protocol";
import {
  LegacyWorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventClaimResultSchema,
} from "../src/durable-objects/workspace-connector-event-protocol";
import {
  WorkspaceOpportunityClaimStartResultSchema,
  type WorkspaceOpportunityPersistRequest,
} from "../src/durable-objects/workspace-opportunity-protocol";
import { WORKSPACE_LOCAL_TABLES } from "../src/services/workspace-runtime-database";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000101");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000102");
const CHILD_SUBSTREAM_ID = asSubstreamId("00000000-0000-7000-8000-000000000103");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000104");
const SESSION_ID = "runtime-test-session";
const BLOCK_DASHBOARD_BLOCK_ID = asBlockId("00000000-0000-7000-8000-000000000109");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-00000000010a");

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
    env.DB.prepare(`CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      role TEXT NOT NULL,
      last_seen_at TEXT,
      PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, USER_ID),
    env.DB.prepare(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      region TEXT NOT NULL,
      revoked_at TEXT,
      expires_at TEXT NOT NULL
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

async function seedCreatorProfile(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
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

function effectEnvelope(
  effect: WireWorkstreamRegionalEffect,
  messageId: string,
  sourceVersion = 1,
  workstreamId = WORKSTREAM_ID,
) {
  return {
    kind: "workstream_regional_effect" as const,
    contractVersion: 1 as const,
    region: "global" as const,
    workspaceId: WORKSPACE_ID,
    workstreamId,
    generation: 1,
    messageId,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: workstreamRegionalEffectHash(effect),
    effect,
  };
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

type TestableBlockDashboardAgent = {
  recordStreamEvent(
    dispatch: BlockDashboardBlockDispatch,
    event: Record<string, unknown>,
  ): Promise<void>;
  persistAndSettle(
    dispatch: BlockDashboardBlockDispatch,
    outcome: { run: BlockDashboardBlockRun },
    leaseToken: string,
  ): Promise<{ failed: boolean; errorCode: string | null; retryAt: number | null }>;
};

type TestableSubstreamAgent = {
  publishAgentRuntimeEvent(event: Record<string, unknown>): Promise<void>;
  drainSemanticRealtimeOutbox(): Promise<void>;
  scheduleBlockDashboardRefresh(triggerSequence: number): Promise<void>;
  semanticRealtimeEvent(input: Record<string, unknown>): Record<string, unknown>;
  nextLoopWorkAt(): number | null;
  agentDrain: { resume(operation: () => Promise<void>, settled: () => void): Promise<void> };
};

type TestableDispatchScheduler = {
  nextRunDispatchAt?(): number | null;
  nextRunAt?(): number | null;
  agentDrain: { resume(operation: () => Promise<void>, settled: () => void): Promise<void> };
};

type TestableWorkstreamDO = {
  applyChildEnvelope(substreamId: string, envelope: ReturnType<typeof effectEnvelope>): void;
  deliverBlockDashboardDispatches(limit?: number): Promise<void>;
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
  stub: DurableObjectStub<SubstreamAgent>,
  userId: string,
): Promise<void> {
  const provisioned = await stub.executeIdentityOperation({
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation: "provision",
    args: [{
      title: "Runtime fixture work stream",
      objective: "Exercise the runtime under test.",
      scope: "workspace",
      originType: "ad_hoc",
      createdByUserId: userId,
      participantUserIds: [userId],
      harnessStatus: "idle",
      emailAddress: null,
      emailRouteStatus: null,
      systemKind: null,
      automationSubscriptionId: null,
      automationRunId: null,
      plannedFor: null,
      modelOverride: null,
      now: Date.now(),
    }],
  });
  if (provisioned.status !== 200) {
    throw new Error(`workstream_fixture_provision_failed:${provisioned.status}`);
  }
}

describe("Durable Objects in the Workers runtime", () => {
  it("refuses fresh workspace, work-stream, substream, and automation admission after abandonment", async () => {
    await seedOpenAuthority();
    const identity = { sessionId: SESSION_ID, userId: USER_ID, workspaceId: WORKSPACE_ID };
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const workstream = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const substream = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, asSubstreamId("0")),
    ));
    const automation = env.AUTOMATION_AGENTS.get(env.AUTOMATION_AGENTS.idFromName(
      automationAgentName("global", WORKSPACE_ID, AUTOMATION_ID),
    ));
    const authorization = async () => ({
      workspace: await runInDurableObject(workspace, async (instance: WorkspaceDO) => (
        (instance as unknown as { sessionAuth(value: typeof identity): Promise<unknown> }).sessionAuth(identity)
      )),
      workstream: await runInDurableObject(workstream, async (instance: WorkstreamDO) => (
        (instance as unknown as { sessionAuth(value: typeof identity): Promise<unknown> }).sessionAuth(identity)
      )),
      substream: await runInDurableObject(substream, async (instance: SubstreamAgent) => (
        (instance as unknown as { socketAuth(value: typeof identity): Promise<unknown> }).socketAuth(identity)
      )),
      automation: await runInDurableObject(automation, async (instance: AutomationAgent) => (
        (instance as unknown as { sessionIsActive(value: typeof identity): Promise<boolean> })
          .sessionIsActive(identity)
      )),
    });

    await expect(authorization()).resolves.toMatchObject({ automation: true });
    await env.DB.prepare(`UPDATE workspaces SET abandoned_at = ? WHERE id = ?`)
      .bind("2026-09-01T00:00:00.000Z", WORKSPACE_ID).run();

    await expect(authorization()).resolves.toEqual({
      workspace: null,
      workstream: null,
      substream: null,
      automation: false,
    });
  });

  it("preserves HTTP-style success and conflict envelopes across native RPC", async () => {
    await seedOpenAuthority();
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const bootstrapped = await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
    });
    expect(bootstrapped.status).toBe(200);
    expect(JSON.parse(bootstrapped.bodyJson)).toEqual({ ok: true });
    const fenced = await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 2,
    });
    expect(fenced.status).toBe(409);
    expect(JSON.parse(fenced.bodyJson)).toEqual({ error: "workstream_runtime_bootstrap_fenced" });

    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const common = effectEnvelope({
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
    const accepted = await parent.receiveSubstreamEffects({ substreamId: "0", envelopes: [common] });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.bodyJson)).toEqual({ ok: true, accepted: 1 });
    const mismatched = await parent.receiveSubstreamEffects({
      substreamId: "0",
      envelopes: [{
        ...common,
        messageId: "native-rpc-mismatch",
        workstreamId: asWorkstreamId("00000000-0000-7000-8000-000000000199"),
      }],
    });
    expect(mismatched.status).toBe(409);
    expect(JSON.parse(mismatched.bodyJson)).toEqual({ error: "workstream_effect_identity_mismatch" });
    // A newer epoch is adopted, not refused: the metadata row is stamped once
    // and never rewritten, so gating on it strands every effect a restarted
    // campaign produces.
    const newer = await parent.receiveSubstreamEffects({
      substreamId: "0",
      envelopes: [{ ...common, messageId: "native-rpc-newer-epoch", generation: common.generation + 1 }],
    });
    expect(newer.status).toBe(200);
    expect(JSON.parse(newer.bodyJson)).toEqual({ ok: true, accepted: 1 });
    // An earlier epoch is a replay, not a mismatch. A restarted maintenance
    // campaign moves an object's generation forward, and refusing these would
    // strand every effect already in flight — permanently, since the numbers
    // can never agree again.
    const replayWorkstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000001aa");
    const replayParent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, replayWorkstreamId),
    ));
    const establishedAtTwo = await replayParent.receiveSubstreamEffects({
      substreamId: "0",
      envelopes: [{
        ...common,
        messageId: "epoch-two",
        workstreamId: replayWorkstreamId,
        generation: 2,
      }],
    });
    expect(establishedAtTwo.status).toBe(200);
    // ...and an older one still applies afterwards, which is the case a
    // restart actually produces: effects already in flight carry the epoch
    // they were enqueued under.
    const replayedFromOne = await replayParent.receiveSubstreamEffects({
      substreamId: "0",
      envelopes: [{
        ...common,
        messageId: "epoch-one",
        workstreamId: replayWorkstreamId,
        generation: 1,
      }],
    });
    expect(replayedFromOne.status).toBe(200);
    expect(JSON.parse(replayedFromOne.bodyJson)).toEqual({ ok: true, accepted: 1 });
    // A child restarts its own projection numbering when a maintenance import
    // rebuilds it, so the same source version legitimately comes back carrying
    // different content. The newer payload wins instead of failing delivery.
    const reused = await replayParent.receiveSubstreamEffects({
      substreamId: "0",
      envelopes: [{
        ...common,
        messageId: "epoch-one-reused-version",
        workstreamId: replayWorkstreamId,
        generation: 2,
        payloadHash: `${common.payloadHash.slice(0, -1)}f`,
      }],
    });
    expect(reused.status).toBe(200);
    expect(JSON.parse(reused.bodyJson)).toEqual({ ok: true, accepted: 1 });
  });

  it("acknowledges in-flight suggestion feedback from older isolates without reviving its state", async () => {
    await seedOpenAuthority();
    const effect: WireWorkstreamRegionalEffect = {
      kind: "suggestion_feedback",
      actionId: "00000000-0000-7000-8000-0000000001e1",
      activityId: "00000000-0000-7000-8000-0000000001e2",
      source: "suggested_work",
      status: "accepted",
      resolvedAt: "2026-08-30T12:00:00.000Z",
      resolvedByUserId: USER_ID,
    };
    const envelope = effectEnvelope(
      effect,
      "00000000-0000-7000-8000-0000000001e3",
    );
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));

    const childHandoff = await parent.receiveSubstreamEffects({
      substreamId: "0",
      envelopes: [envelope],
    });
    expect(childHandoff.status).toBe(200);
    expect(JSON.parse(childHandoff.bodyJson)).toEqual({ ok: true, accepted: 1 });
    await runInDurableObject(parent, (_instance: WorkstreamDO, state) => {
      expect(state.storage.sql.exec(
        `SELECT message_id FROM child_effect_receipts WHERE message_id = ?`,
        envelope.messageId,
      ).toArray()).toEqual([]);
      expect(state.storage.sql.exec(
        `SELECT message_id FROM durable_outbox WHERE message_id = ?`,
        envelope.messageId,
      ).toArray()).toEqual([]);
    });

    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const directoryHandoff = await workspace.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [envelope],
    });
    expect(directoryHandoff).toEqual({
      accepted: [{ messageId: envelope.messageId, payloadHash: envelope.payloadHash }],
      directoryChanged: false,
    });
    await runInDurableObject(workspace, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workspace_workstream_effect_receipts
          WHERE message_id = ?`,
        envelope.messageId,
      ).one()).toEqual({ count: 1 });
      expect(state.storage.sql.exec(
        `SELECT name FROM sqlite_schema WHERE name LIKE '%suggestion_feedback%'`,
      ).toArray()).toEqual([]);
    });
  });

  it("flushes a creation snapshot through both parents before a route can be advertised", async () => {
    await seedOpenAuthority();
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await child.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
    });
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
    const common = effectEnvelope({
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

    await expect(child.flushEffectsToWorkstreamDO()).resolves.toBe(1);
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await expect(parent.flushWorkspaceDirectoryEffects()).resolves.toBe(1);
    await expect(workspace.hasWorkstreamDirectory({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).resolves.toBe(true);
    await runInDurableObject(child, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_outbox`,
      ).one().count).toBe(0);
    });
    await runInDurableObject(parent, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_outbox`,
      ).one().count).toBe(0);
    });
  });

  it("repairs a missing creation projection when initialize is replayed", async () => {
    await seedOpenAuthority();
    await seedCreatorProfile();
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
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
      originType: "ad_hoc" as const,
      automationSubscriptionId: null,
      automationRunId: null,
      plannedFor: null,
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
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
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
        workstreamId: WORKSTREAM_ID,
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
        originType: "ad_hoc",
        automationSubscriptionId: null,
        automationRunId: null,
        plannedFor: null,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const auth = {
      sessionId: SESSION_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      role: "member" as const,
    };
    // No `scope`, which is the whole point: `POST /workstreams` carries none,
    // so this is the shape every create a person makes in Avalon arrives in.
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
      originType: "ad_hoc" as const,
      automationSubscriptionId: null,
      automationRunId: null,
      plannedFor: null,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
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
        originType: "ad_hoc" as const,
        automationSubscriptionId: null,
        automationRunId: null,
        plannedFor: null,
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
        name: substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
        constructor: SubstreamAgent,
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
        namespace: env.BLOCK_DASHBOARD_AGENTS,
        name: blockDashboardAgentName(
          "global",
          WORKSPACE_ID,
          WORKSTREAM_ID,
          BLOCK_DASHBOARD_BLOCK_ID,
        ),
        constructor: BlockDashboardAgent,
        migrations: BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS.length,
        tables: [
          "_sql_schema_migrations",
          "block_dashboard_block_identity",
          "agent_run_dispatches",
          "latest_dispatch_freshness",
        ],
      },
      {
        namespace: env.WORKSTREAM_DOS,
        name: workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
        constructor: WorkstreamDO,
        migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS.length,
        tables: [
          "_sql_schema_migrations",
          "substream_directory",
          "durable_outbox",
          "workstream_socket_ticket_receipts",
          "block_dashboard_configuration_versions",
          "block_dashboard_dispatch_outbox",
          "block_dashboard_source_refresh_outbox",
        ],
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
          "workspace_workstream_directory",
          "workspace_workstream_effect_receipts",
          "workspace_workstream_pins",
          "workspace_workstream_resource_links",
          "pending_attachment_reservations",
          "workspace_workstream_viewers",
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
        absentTables: ["external_delivery_attempts", "slack_agent_channel_allowlist"],
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
        if (instance instanceof WorkstreamDO) {
          const stateColumns = state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(workstream_state_changes)`,
          ).toArray().map((column) => column.name);
          expect(stateColumns).toEqual(expect.arrayContaining([
            "sequence",
            "state_key",
            "waterline",
            "event_id",
            "state_json",
          ]));
        }
        if (instance instanceof WorkspaceDO) {
          const syncColumns = state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(workspace_sync_events)`,
          ).toArray().map((column) => column.name);
          expect(syncColumns).toEqual(["waterline", "event_id", "topics_json", "occurred_at"]);
          const directoryColumns = state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(workspace_workstream_directory)`,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const childId = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, CHILD_SUBSTREAM_ID),
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

  it("freezes HyperSight before a pending tool and advances only after the pair settles", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await fetchAndDrain(stub, "https://substream.test/health");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO workstream
           (id, workstream_key, parent_workspace_key, region, authority_mode,
            authority_generation, title, description, scope, exact_state,
            state_reason_code, next_sequence_number, next_attention_ordinal,
            authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
            deletion_epoch, run_revision, created_at, last_people_activity_at,
            state_changed_at, updated_at)
         VALUES (1, ?, ?, 'global', 'authoritative', 1, '', '', 'workspace', 'running',
                 'test', 4, 3, 1, 0, 0, 1, 0, 1, 1000, 1000, 1000, 1000)`,
        WORKSTREAM_ID,
        WORKSPACE_ID,
      );
      state.storage.sql.exec(
        `INSERT INTO substreams
           (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq,
            depth, return_mode, origin_message_id, owner_user_id, audience,
            tool_policy, status, created_at, closed_at)
         VALUES ('0', 'main', 'none', NULL, NULL, 0, 'none', NULL, NULL,
                 'workspace', 'full', 'open', 1000, NULL)`,
      );
      state.storage.sql.exec(
        `INSERT INTO substream_agent_identity(id, external_substream_id, created_at, updated_at)
         VALUES (1, '0', 1000, 1000)`,
      );
      state.storage.sql.exec(
        `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 0, 1000)`,
      );
      await seedParticipantMessage(state, {
        id: "message-1", sequence: 1, text: "before tool", authorType: "agent",
        attentionOrdinal: 1, now: 1_000,
      });
      await seedCanonicalMessageRecord(state, {
        id: "tool-2", sequence: 2, messageType: "tool",
        structuredContentJson: '{"invocation":{"status":"pending"}}',
        effectIntentId: "effect-2", toolName: "terminal_run", toolStatus: "pending", now: 1_001,
      });
      await seedParticipantMessage(state, {
        id: "message-3", sequence: 3, text: "queued while the tool runs",
        authorUserId: USER_ID, attentionOrdinal: 2, now: 1_002,
      });
    });

    const requestRefresh = async (triggerSequence: number): Promise<void> => {
      const response = await fetchAndDrain(
        stub,
        "https://substream.test/internal/block-dashboard-refresh-request",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, triggerSequence }),
        },
      );
      expect(response.status).toBe(200);
    };
    await requestRefresh(3);
    await runInDurableObject(stub, async (_instance, state) => {
      const pending = JSON.parse(state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM due_work WHERE job_key = 'block_dashboard_refresh'`,
      ).one().payload_json) as { contextFence: { throughSequence: number } };
      expect(pending.contextFence.throughSequence).toBe(1);
      state.storage.sql.exec(
        `UPDATE participant_transcript_blocks
            SET lifecycle_state = 'completed', revision = revision + 1
          WHERE turn_id = 'tool-2' AND block_kind = 'tool'`,
      );
    });

    await requestRefresh(4);
    await runInDurableObject(stub, (_instance, state) => {
      const pending = JSON.parse(state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM due_work WHERE job_key = 'block_dashboard_refresh'`,
      ).one().payload_json) as { contextFence: { throughSequence: number } };
      expect(pending.contextFence.throughSequence).toBe(3);
    });
  });

  it("gives each stable HyperSight block an isolated SQLite dispatch ledger that survives eviction", async () => {
    const secondBlockId = asBlockId("00000000-0000-7000-8000-000000000110");
    const first = env.BLOCK_DASHBOARD_AGENTS.get(env.BLOCK_DASHBOARD_AGENTS.idFromName(
      blockDashboardAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, BLOCK_DASHBOARD_BLOCK_ID),
    ));
    const second = env.BLOCK_DASHBOARD_AGENTS.get(env.BLOCK_DASHBOARD_AGENTS.idFromName(
      blockDashboardAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, secondBlockId),
    ));
    await Promise.all([
      fetchAndDrain(first, "https://block-dashboard.test/health"),
      fetchAndDrain(second, "https://block-dashboard.test/health"),
    ]);
    await runInDurableObject(first, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO block_dashboard_block_identity
           (id, workspace_id, workstream_id, block_id, region, created_at)
         VALUES (1, ?, ?, ?, 'global', 1)`,
        WORKSPACE_ID,
        WORKSTREAM_ID,
        BLOCK_DASHBOARD_BLOCK_ID,
      );
    });
    await runInDurableObject(second, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM block_dashboard_block_identity`,
      ).one().count).toBe(0);
    });
    await evictDurableObject(first);
    await fetchAndDrain(first, "https://block-dashboard.test/health");
    await runInDurableObject(first, (_instance, state) => {
      expect(state.storage.sql.exec<{ block_id: string }>(
        `SELECT block_id FROM block_dashboard_block_identity WHERE id = 1`,
      ).one().block_id).toBe(BLOCK_DASHBOARD_BLOCK_ID);
    });
  });

  it("uses a ref-counted heartbeat alarm only while an in-memory loop is active", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, CHILD_SUBSTREAM_ID),
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

  it("aggregates common and per-user child projections in the non-agent WorkstreamDO", async () => {
    const stub = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await fetchAndDrain(stub, "https://workstream.test/health");
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
    await runInDurableObject(stub, (instance, state) => {
      const testable = instance as unknown as TestableWorkstreamDO;
      for (const [substreamId, envelopes] of [
        ["0", [
          effectEnvelope(common("completed", at, at), "main-common"),
          effectEnvelope(user(2, false), "main-user"),
        ]],
        [CHILD_SUBSTREAM_ID, [
          effectEnvelope(common("running", later, null), "child-common"),
          effectEnvelope(user(3, true), "child-user"),
        ]],
      ] as const) {
        for (const envelope of envelopes) testable.applyChildEnvelope(substreamId, envelope);
      }
      expect(state.storage.sql.exec<{
        exact_state: string;
        last_activity_at: number;
        completed_at: number | null;
      }>(`SELECT exact_state, last_activity_at, completed_at FROM workstream_metadata WHERE id = 1`).one())
        .toEqual({ exact_state: "running", last_activity_at: Date.parse(later), completed_at: null });
      const effects = state.storage.sql.exec<{ effect_json: string }>(
        `SELECT effect_json FROM substream_user_directory WHERE user_id = ? ORDER BY substream_id`,
        USER_ID,
      ).toArray().map((row) => JSON.parse(row.effect_json) as { unreadCount: number; youAreMentioned: boolean });
      expect(effects).toHaveLength(2);
      expect(effects.reduce((sum, effect) => sum + effect.unreadCount, 0)).toBe(5);
      expect(effects.some((effect) => effect.youAreMentioned)).toBe(true);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_outbox WHERE partition_key IN ('common', ?)`,
        `user:${USER_ID}`,
      ).one().count).toBe(4);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workstream_state_changes
          WHERE state_key IN ('common', ?)`,
        `user:${USER_ID}`,
      ).one().count).toBe(4);
      state.storage.sql.exec(
        `UPDATE durable_outbox SET state = 'inflight' WHERE partition_key = 'common'`,
      );
      state.storage.sql.exec(
        `DELETE FROM durable_outbox WHERE partition_key = ?`,
        `user:${USER_ID}`,
      );
      testable.applyChildEnvelope(
        CHILD_SUBSTREAM_ID,
        effectEnvelope(
          common("running", "2026-08-17T20:02:00.000Z", null),
          "child-common-v2",
          2,
        ),
      );
      const replacements = state.storage.sql.exec<{ source_version: number; state: string }>(
        `SELECT source_version, state FROM durable_outbox WHERE partition_key = 'common'
          ORDER BY source_version`,
      ).toArray();
      // Every aggregate state transition remains independently deliverable.
      // Queue delivery may duplicate or reorder these rows, so WorkspaceDO
      // accepts only the greatest waterline for the common state key.
      expect(replacements).toHaveLength(3);
      expect(replacements.map((row) => row.source_version)).toEqual([1, 2, 3]);
      expect(replacements.slice(0, 2).every((row) => row.state === "inflight")).toBe(true);
      state.storage.sql.exec(`DELETE FROM durable_outbox`);
    });
  });

  it("keeps HyperSight configuration and viewer preferences authoritative in WorkstreamDO", async () => {
    const stub = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const at = "2026-08-17T20:00:00.000Z";
    const initialized = await fetchAndDrain(stub, "https://workstream.test/internal/substream-effects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        substreamId: "0",
        envelopes: [effectEnvelope({
          kind: "directory_common",
          title: "HyperSight authority",
          description: "The parent owns dashboard configuration",
          preview: "Control plane",
          scope: "workspace",
          state: "idle",
          systemKind: null,
          lastActivityAt: at,
          completedAt: null,
          archivedAt: null,
          latestAttentionOrdinal: 9,
        }, "block-dashboard-common")],
      }),
    });
    expect(initialized.status).toBe(200);

    const versionId = "00000000-0000-7000-8000-000000000111";
    const updated = await fetchAndDrain(stub, "https://workstream.test/internal/block-dashboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "update_configuration",
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        userId: USER_ID,
        configurationVersionId: versionId,
        createdAt: at,
        input: {
          expectedVersionNumber: 0,
          blocks: [{ id: BLOCK_DASHBOARD_BLOCK_ID, prompt: "" }],
        },
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      blockDashboard: {
        versionId,
        versionNumber: 1,
        blocks: [{ id: BLOCK_DASHBOARD_BLOCK_ID, prompt: "", latestRun: null }],
      },
      runs: [],
    });

    const conflict = await fetchAndDrain(stub, "https://workstream.test/internal/block-dashboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "update_configuration",
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        userId: USER_ID,
        configurationVersionId: "00000000-0000-7000-8000-000000000112",
        createdAt: at,
        input: { expectedVersionNumber: 0, blocks: [] },
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "block_dashboard_version_conflict" });

    const preference = await fetchAndDrain(stub, "https://workstream.test/internal/block-dashboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "update_preference",
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        userId: USER_ID,
        visible: true,
        updatedAt: at,
      }),
    });
    expect(await preference.json()).toEqual({ preference: { visible: true, updatedAt: at } });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM block_dashboard_configuration_versions`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ visible: number }>(
        `SELECT visible FROM block_dashboard_user_preferences WHERE user_id = ?`,
        USER_ID,
      ).one().visible).toBe(1);
    });
  });

  it("dispatches a block to its named agent and applies versioned results idempotently", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const at = "2026-08-17T20:00:00.000Z";
    await fetchAndDrain(stub, "https://workstream.test/internal/substream-effects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        substreamId: "0",
        envelopes: [effectEnvelope({
          kind: "directory_common",
          title: "HyperSight dispatch",
          description: "One block, one agent",
          preview: "Dispatch",
          scope: "workspace",
          state: "idle",
          systemKind: null,
          lastActivityAt: at,
          completedAt: null,
          archivedAt: null,
          latestAttentionOrdinal: 9,
        }, "block-dashboard-dispatch-common")],
      }),
    });
    const versionId = "00000000-0000-7000-8000-000000000113";
    const updated = await fetchAndDrain(stub, "https://workstream.test/internal/block-dashboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "update_configuration",
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        userId: USER_ID,
        configurationVersionId: versionId,
        createdAt: at,
        input: {
          expectedVersionNumber: 0,
          blocks: [{ id: BLOCK_DASHBOARD_BLOCK_ID, prompt: "Summarize the current state" }],
        },
      }),
    });
    expect(await updated.json()).toMatchObject({ runs: [] });
    const scheduled = await fetchAndDrain(stub, "https://workstream.test/internal/block-dashboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "schedule_refresh",
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        triggerSequence: 9,
        contextFence: { throughSequence: 0, compaction: null },
      }),
    });
    const payload = await scheduled.json() as { runs: BlockDashboardBlockRun[] };
    expect(payload.runs).toHaveLength(1);
    const queued = payload.runs[0]!;
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as TestableWorkstreamDO).deliverBlockDashboardDispatches();
    });

    const blockStub = env.BLOCK_DASHBOARD_AGENTS.get(env.BLOCK_DASHBOARD_AGENTS.idFromName(
      blockDashboardAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, BLOCK_DASHBOARD_BLOCK_ID),
    ));
    await fetchAndDrain(blockStub, "https://block-dashboard.test/health");
    await runInDurableObject(blockStub, (_instance, state) => {
      expect(state.storage.sql.exec<{ block_id: string }>(
        `SELECT block_id FROM block_dashboard_block_identity WHERE id = 1`,
      ).one().block_id).toBe(BLOCK_DASHBOARD_BLOCK_ID);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM agent_run_dispatches WHERE block_run_id = ?`,
        queued.id,
      ).one().count).toBe(1);
    });

    const running = {
      ...queued,
      status: "running" as const,
      startedAt: "2026-08-17T20:00:01.000Z",
    };
    const effect = {
      operation: "block_result",
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      blockId: BLOCK_DASHBOARD_BLOCK_ID,
      sourceVersion: 1,
      payloadHash: blockDashboardBlockResultHash(running),
      run: running,
    };
    const first = await fetchAndDrain(stub, "https://workstream.test/internal/block-dashboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(effect),
    });
    expect(await first.json()).toEqual({ accepted: true });
    const duplicate = await fetchAndDrain(stub, "https://workstream.test/internal/block-dashboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(effect),
    });
    expect(await duplicate.json()).toEqual({ accepted: false });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string; started_at: number }>(
        `SELECT status, started_at FROM block_dashboard_block_runs WHERE block_run_id = ?`,
        queued.id,
      ).one()).toEqual({ status: "running", started_at: Date.parse(running.startedAt) });
    });

    const checkpointText = "Streaming HyperSight output survives eviction";
    await runInDurableObject(blockStub, async (instance, state) => {
      const dispatch = BlockDashboardBlockDispatchSchema.parse(JSON.parse(
        state.storage.sql.exec<{ dispatch_json: string }>(
          `SELECT dispatch_json FROM agent_run_dispatches WHERE block_run_id = ?`,
          queued.id,
        ).one().dispatch_json,
      ));
      const checkpoint = {
        streamId: "00000000-0000-7000-8000-000000000116",
        harnessRunId: dispatch.harnessRunId,
        turnId: "turn-runtime-resume",
        epoch: 0,
        streamSeq: 4,
        seenTurnIds: ["turn-runtime-resume"],
        text: checkpointText,
        turnStartOffset: 0,
        roomSequence: 4,
        createdAt: "2026-08-17T20:00:02.000Z",
      };
      state.storage.sql.exec(
        `UPDATE agent_run_dispatches SET state = 'running', terminal_outcome_json = NULL,
           started_at = ?, completed_at = NULL WHERE block_run_id = ?`,
        Date.parse("2026-08-17T20:00:01.000Z"),
        queued.id,
      );
      const testable = instance as unknown as TestableBlockDashboardAgent;
      await testable.recordStreamEvent(dispatch, {
        type: "stream_started",
        streamId: checkpoint.streamId,
        harnessRunId: dispatch.harnessRunId,
        turnId: checkpoint.turnId,
        epoch: checkpoint.epoch,
        streamSeq: 0,
        reset: false,
      });
      await testable.recordStreamEvent(dispatch, {
        type: "stream_delta",
        streamId: checkpoint.streamId,
        harnessRunId: dispatch.harnessRunId,
        turnId: checkpoint.turnId,
        epoch: checkpoint.epoch,
        streamSeq: 1,
        reset: false,
        delta: checkpointText,
      });
      expect(state.storage.sql.exec<{ revision: number }>(
        `SELECT revision FROM agent_stream_checkpoint WHERE id = 1`,
      ).one().revision).toBe(2);
    });
    const blockSocketResponse = await blockStub.fetch("https://block-dashboard.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-region": "global",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-block-dashboard-block-id": BLOCK_DASHBOARD_BLOCK_ID,
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000117",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    if (blockSocketResponse.status !== 101) {
      throw new Error(`HyperSight socket rejected: ${blockSocketResponse.status} ${await blockSocketResponse.text()}`);
    }
    const blockSocket = blockSocketResponse.webSocket!;
    blockSocket.accept();
    const replayed = await fetchAndDrain(blockStub, "https://block-dashboard.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-region": "global",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-block-dashboard-block-id": BLOCK_DASHBOARD_BLOCK_ID,
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000117",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(replayed.status).toBe(401);
    const expired = await fetchAndDrain(blockStub, "https://block-dashboard.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-region": "global",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-block-dashboard-block-id": BLOCK_DASHBOARD_BLOCK_ID,
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8000-000000000118",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) - 1),
      },
    });
    expect(expired.status).toBe(401);
    await evictDurableObject(blockStub);
    const pong = nextMessage(blockSocket);
    blockSocket.send("ping");
    expect((await pong).data).toBe("pong");
    const snapshot = nextMessage(blockSocket);
    blockSocket.send(JSON.stringify({ type: "subscribe" }));
    expect(JSON.parse(String((await snapshot).data))).toMatchObject({
      type: "block_dashboard_block_snapshot",
      blockId: BLOCK_DASHBOARD_BLOCK_ID,
      run: { id: queued.id, status: "running", markdown: checkpointText },
      streamCheckpoint: { roomSequence: 2, text: checkpointText },
    });

    const continuedText = " and continues without a visual reset";
    const continued = nextMessage(blockSocket);
    await runInDurableObject(blockStub, async (instance, state) => {
      const dispatch = BlockDashboardBlockDispatchSchema.parse(JSON.parse(
        state.storage.sql.exec<{ dispatch_json: string }>(
          `SELECT dispatch_json FROM agent_run_dispatches WHERE block_run_id = ?`,
          queued.id,
        ).one().dispatch_json,
      ));
      await (instance as unknown as TestableBlockDashboardAgent).recordStreamEvent(dispatch, {
        type: "stream_delta",
        streamId: "00000000-0000-7000-8000-000000000116",
        harnessRunId: dispatch.harnessRunId,
        turnId: "turn-runtime-resume",
        epoch: 0,
        streamSeq: 2,
        reset: false,
        delta: continuedText,
      });
      const persisted = JSON.parse(state.storage.sql.exec<{ checkpoint_json: string }>(
        `SELECT checkpoint_json FROM agent_stream_checkpoint WHERE id = 1`,
      ).one().checkpoint_json) as { roomSequence: number; text: string };
      expect(persisted).toMatchObject({
        roomSequence: 3,
        text: checkpointText + continuedText,
      });
    });
    expect(JSON.parse(String((await continued).data))).toMatchObject({
      type: "block_dashboard_block_stream_checkpoint",
      blockRunId: queued.id,
      streamCheckpoint: { roomSequence: 3, text: checkpointText + continuedText },
    });

    const terminalFrames = nextMessages(blockSocket, 2);
    await runInDurableObject(blockStub, async (instance, state) => {
      const dispatch = BlockDashboardBlockDispatchSchema.parse(JSON.parse(
        state.storage.sql.exec<{ dispatch_json: string }>(
          `SELECT dispatch_json FROM agent_run_dispatches WHERE block_run_id = ?`,
          queued.id,
        ).one().dispatch_json,
      ));
      const completed = {
        ...running,
        status: "completed" as const,
        markdown: checkpointText + continuedText,
        completedAt: "2026-08-17T20:00:03.000Z",
      };
      state.storage.sql.exec(
        `UPDATE agent_run_dispatches
            SET state = 'running', lease_token = 'successor-terminal-owner',
                lease_expires_at = ?
          WHERE block_run_id = ?`,
        Date.now() + 60_000,
        queued.id,
      );
      const testable = instance as unknown as TestableBlockDashboardAgent;
      await expect(testable.persistAndSettle(dispatch, {
        run: completed,
      }, "obsolete-terminal-owner")).rejects.toMatchObject({
        code: "block_dashboard_dispatch_ownership_lost",
      });
      expect(state.storage.sql.exec<{
        lease_token: string | null;
        terminal_outcome_json: string | null;
      }>(
        `SELECT lease_token, terminal_outcome_json FROM agent_run_dispatches
          WHERE block_run_id = ?`,
        queued.id,
      ).one()).toEqual({
        lease_token: "successor-terminal-owner",
        terminal_outcome_json: null,
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM agent_stream_checkpoint`,
      ).one().count).toBe(1);

      await testable.persistAndSettle(dispatch, {
        run: completed,
      }, "successor-terminal-owner");
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM agent_stream_checkpoint`,
      ).one().count).toBe(0);
    });
    const terminalEvents = (await terminalFrames).map((event) => JSON.parse(String(event.data)));
    expect(terminalEvents.find((event) => event.type === "block_dashboard_block_stream_checkpoint"))
      .toMatchObject({
      type: "block_dashboard_block_stream_checkpoint",
      blockRunId: queued.id,
      streamCheckpoint: null,
    });
    // A block socket is closed by the access-revocation queue and by nothing
    // else; the agent never re-asks D1 on its own. See docs/access-revocation.md.
    const blockClosed = nextClose(blockSocket);
    await blockStub.revokeSocketAccess({
      reason: "workspace_membership_removed",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      sessionId: null,
    });
    expect((await blockClosed).code).toBe(1008);
  });

  it("coalesces obsolete queued HyperSight dispatches while preserving an in-flight run", async () => {
    await seedOpenAuthority();
    await env.DB.prepare(
      `UPDATE workstream_authority_control SET phase = 'maintenance_importing' WHERE id = 1`,
    ).run();
    const blockStub = env.BLOCK_DASHBOARD_AGENTS.get(env.BLOCK_DASHBOARD_AGENTS.idFromName(
      blockDashboardAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, BLOCK_DASHBOARD_BLOCK_ID),
    ));
    const versionId = "00000000-0000-7000-8000-000000000131";
    const dispatch = (ordinal: number) => BlockDashboardBlockDispatchSchema.parse({
      region: "global",
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      blockId: BLOCK_DASHBOARD_BLOCK_ID,
      blockRunId: `00000000-0000-7000-8000-${String(132 + ordinal).padStart(12, "0")}`,
      harnessRunId: `00000000-0000-7000-8000-${String(142 + ordinal).padStart(12, "0")}`,
      configurationVersionId: versionId,
      configurationVersionNumber: 1,
      prompt: "Summarize the newest state",
      triggerSequence: ordinal,
      contextFence: { throughSequence: ordinal, compaction: null },
      createdAt: new Date(Date.parse("2026-08-18T12:00:00.000Z") + ordinal).toISOString(),
    });
    const first = dispatch(1);
    const second = dispatch(2);
    const newest = dispatch(3);
    const staleRetry = dispatch(0);
    await blockStub.dispatchRun(first);
    await blockStub.dispatchRun(second);
    await blockStub.dispatchRun(newest);
    await blockStub.dispatchRun(staleRetry);

    await runInDurableObject(blockStub, (_instance, state) => {
      const rows = state.storage.sql.exec<{
        block_run_id: string;
        state: string;
        terminal_outcome_json: string | null;
      }>(
        `SELECT block_run_id, state, terminal_outcome_json
           FROM agent_run_dispatches ORDER BY created_at, block_run_id`,
      ).toArray();
      expect(rows).toHaveLength(4);
      expect(rows.find((row) => row.block_run_id === newest.blockRunId)?.terminal_outcome_json).toBeNull();
      expect(rows.find((row) => row.block_run_id === staleRetry.blockRunId)).toMatchObject({
        state: "completed",
      });
      expect(JSON.parse(rows.find((row) =>
        row.block_run_id === staleRetry.blockRunId)!.terminal_outcome_json!)).toMatchObject({
        run: { status: "stopped", error: { code: "block_dashboard_run_superseded" } },
      });
      for (const row of rows.filter((candidate) => candidate.block_run_id !== newest.blockRunId)) {
        if (row.terminal_outcome_json === null) expect(row.state).toBe("running");
        else expect(JSON.parse(row.terminal_outcome_json)).toMatchObject({
          run: { status: "stopped", error: { code: "block_dashboard_run_superseded" } },
        });
      }
      expect(rows.filter((row) => row.block_run_id !== newest.blockRunId
        && row.state === "queued" && row.terminal_outcome_json === null)).toHaveLength(0);
      expect(rows.filter((row) => row.state === "running" && row.terminal_outcome_json === null).length)
        .toBeLessThanOrEqual(1);
    });
  });

  it("holds later same-block dispatches behind an older parent outbox retry", async () => {
    await seedOpenAuthority();
    await env.DB.prepare(
      `UPDATE workstream_authority_control SET phase = 'maintenance_importing' WHERE id = 1`,
    ).run();
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await fetchAndDrain(parent, "https://workstream.test/health");
    const configurationVersionId = "00000000-0000-7000-8000-000000000151";
    const makeDispatch = (ordinal: number) => BlockDashboardBlockDispatchSchema.parse({
      region: "global",
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      blockId: BLOCK_DASHBOARD_BLOCK_ID,
      blockRunId: `00000000-0000-7000-8000-${String(151 + ordinal).padStart(12, "0")}`,
      harnessRunId: `00000000-0000-7000-8000-${String(161 + ordinal).padStart(12, "0")}`,
      configurationVersionId,
      configurationVersionNumber: 1,
      prompt: "Respect per-block head-of-line delivery",
      triggerSequence: ordinal,
      contextFence: { throughSequence: ordinal, compaction: null },
      createdAt: new Date(Date.parse("2026-08-18T12:00:00.000Z") + ordinal).toISOString(),
    });
    const older = makeDispatch(1);
    const newer = makeDispatch(2);
    const notBefore = Date.now() + 60_000;
    await runInDurableObject(parent, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO block_dashboard_configuration_versions
           (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
         VALUES (?, 1, ?, ?, 1)`,
        configurationVersionId,
        JSON.stringify([{ id: BLOCK_DASHBOARD_BLOCK_ID, prompt: older.prompt }]),
        USER_ID,
      );
      for (const [dispatch, createdAt, dueAt] of [
        [older, 1, notBefore],
        [newer, 2, Date.now()],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO block_dashboard_block_runs
             (block_run_id, configuration_version_id, block_id, prompt, trigger_sequence,
              harness_run_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
          dispatch.blockRunId,
          configurationVersionId,
          BLOCK_DASHBOARD_BLOCK_ID,
          dispatch.prompt,
          dispatch.triggerSequence,
          dispatch.harnessRunId,
          createdAt,
        );
        state.storage.sql.exec(
          `INSERT INTO block_dashboard_dispatch_outbox
             (block_run_id, block_id, dispatch_json, attempts, not_before, created_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
          dispatch.blockRunId,
          BLOCK_DASHBOARD_BLOCK_ID,
          JSON.stringify(dispatch),
          dueAt,
          createdAt,
        );
      }
      await (instance as unknown as TestableWorkstreamDO).deliverBlockDashboardDispatches();
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM block_dashboard_dispatch_outbox`,
      ).one().count).toBe(2);
    });
    await runInDurableObject(parent, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE block_dashboard_dispatch_outbox SET not_before = 0 WHERE block_run_id = ?`,
        older.blockRunId,
      );
      const testable = instance as unknown as TestableWorkstreamDO;
      await testable.deliverBlockDashboardDispatches();
      expect(state.storage.sql.exec<{ block_run_id: string }>(
        `SELECT block_run_id FROM block_dashboard_dispatch_outbox`,
      ).one().block_run_id).toBe(newer.blockRunId);
      await testable.deliverBlockDashboardDispatches();
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM block_dashboard_dispatch_outbox`,
      ).one().count).toBe(0);
    });
    const child = env.BLOCK_DASHBOARD_AGENTS.get(env.BLOCK_DASHBOARD_AGENTS.idFromName(
      blockDashboardAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, BLOCK_DASHBOARD_BLOCK_ID),
    ));
    await runInDurableObject(child, (_instance, state) => {
      const rows = state.storage.sql.exec<{ block_run_id: string }>(
        `SELECT block_run_id FROM agent_run_dispatches ORDER BY created_at, block_run_id`,
      ).toArray();
      expect(rows.map((row) => row.block_run_id)).toEqual([older.blockRunId, newer.blockRunId]);
    });
  });

  it("terminalizes a malformed HyperSight dispatch instead of retrying it forever", async () => {
    await seedOpenAuthority();
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await fetchAndDrain(parent, "https://workstream.test/health");
    const configurationVersionId = "00000000-0000-7000-8000-000000000171";
    const blockRunId = "00000000-0000-7000-8000-000000000172";
    await runInDurableObject(parent, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO block_dashboard_configuration_versions
           (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
         VALUES (?, 1, ?, ?, 1)`,
        configurationVersionId,
        JSON.stringify([{ id: BLOCK_DASHBOARD_BLOCK_ID, prompt: "Summarize" }]),
        USER_ID,
      );
      state.storage.sql.exec(
        `INSERT INTO block_dashboard_block_runs
           (block_run_id, configuration_version_id, block_id, prompt, trigger_sequence,
            harness_run_id, status, created_at)
         VALUES (?, ?, ?, 'Summarize', 1, ?, 'queued', 1)`,
        blockRunId,
        configurationVersionId,
        BLOCK_DASHBOARD_BLOCK_ID,
        "00000000-0000-7000-8000-000000000173",
      );
      state.storage.sql.exec(
        `INSERT INTO block_dashboard_dispatch_outbox
           (block_run_id, block_id, dispatch_json, attempts, not_before, created_at)
         VALUES (?, ?, ?, 0, 0, 1)`,
        blockRunId,
        BLOCK_DASHBOARD_BLOCK_ID,
        JSON.stringify({ schema: "drifted" }),
      );

      await (instance as unknown as TestableWorkstreamDO).deliverBlockDashboardDispatches();

      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM block_dashboard_dispatch_outbox`,
      ).one().count).toBe(0);
      const run = state.storage.sql.exec<{
        status: string;
        error_json: string | null;
        completed_at: number | null;
      }>(
        `SELECT status, error_json, completed_at FROM block_dashboard_block_runs
          WHERE block_run_id = ?`,
        blockRunId,
      ).one();
      expect(run.status).toBe("failed");
      expect(run.completed_at).not.toBeNull();
      expect(JSON.parse(run.error_json!)).toMatchObject({
        code: "block_dashboard_dispatch_invalid",
      });
    });
  });

  it("keeps a hibernating workspace socket alive across forced eviction", async () => {
    await seedOpenAuthority();
    const id = env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID));
    const stub = env.WORKSPACE_DOS.get(id);
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
    await expect(stub.initializeWorkspace(WORKSPACE_ID, "wnam")).resolves.toBeUndefined();
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
      const pong = nextMessage(socket!);
      socket!.send("ping");
      expect((await pong).data).toBe("pong");
      const snapshot = nextMessage(socket!);
      socket!.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      expect(JSON.parse(String((await snapshot).data))).toMatchObject({
        type: "workspace_sync",
        waterline: 0,
        reason: "initial",
      });
    } finally {
      socket!.close(1000, "test complete");
    }
  });

  async function openWorkspaceSocket(
    stub: DurableObjectStub<WorkspaceDO>,
    ticketId: string,
    sessionId: string = SESSION_ID,
    userId: string = USER_ID,
  ): Promise<WebSocket> {
    const response = await stub.fetch("https://workspace.test/socket", {
      headers: {
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
      originType: "ad_hoc" as const,
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
        effectEnvelope(common, "00000000-0000-7000-8000-00000000040b"),
        effectEnvelope(
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
        envelopes: [effectEnvelope(
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
          effectEnvelope(
            { ...common, updatedAt: "2026-08-26T20:02:00.000Z" },
            "00000000-0000-7000-8000-000000000411",
            3,
          ),
          effectEnvelope(
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
        envelopes: [effectEnvelope(
          { ...common, scope: "personal", updatedAt: "2026-08-26T20:03:00.000Z" },
          "00000000-0000-7000-8000-000000000413",
          4,
        )],
      });

      const afterParticipantRemoval = nextMessageOfType(first, "workspace_presence");
      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: WORKSPACE_ID,
        envelopes: [effectEnvelope(
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
        envelopes: [effectEnvelope(
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
        envelopes: [effectEnvelope(
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
        "hypersight-enabled",
        WORKSPACE_ID,
        "wnam",
      )).resolves.toBe(1);
      expect(JSON.parse(String((await delivered).data))).toMatchObject({
        type: "workspace_feature_flags",
        changedFlag: "hypersight-enabled",
        flags: { hypersightEnabled: false, meetingRecordingEnabled: false },
      });
    } finally {
      socket.close(1000, "test complete");
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
      socket.send(JSON.stringify({ type: "create_message", text: "must not reach logs" }));
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

  it("distinguishes an inactive session from access revocation", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    const socket = await openWorkspaceSocket(stub, "00000000-0000-7000-8000-00000000060b");
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`)
      .bind("2026-08-24T20:00:00.000Z", SESSION_ID)
      .run();
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

  it("names a work stream's substreams and blocks when its access is revoked", async () => {
    await seedOpenAuthority();
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await fetchAndDrain(parent, "https://workstream.test/health");
    await parent.receiveSubstreamEffects({
      substreamId: "0",
      envelopes: [effectEnvelope({
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
    const result = await parent.revokeSocketAccess({
      reason: "workspace_membership_removed",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      sessionId: null,
    });
    // The main substream keeps the historical name and is never in the
    // directory, so a walk that only read the table would skip the one object
    // holding the transcript.
    expect(result.substreamIds).toContain("0");
    expect(Array.isArray(result.blockIds)).toBe(true);
  });

  it("pushes a child state change to the workspace socket without waiting for the Queue", async () => {
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

    const participantPush = nextMessage(participant);
    const outsiderPush = nextMessage(outsider);
    const workstreamStub = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const at = "2026-08-21T20:00:00.000Z";
    // A run finishing, as the child reports it. Nothing here touches the
    // alarm or the Queue: `alarm()` is never called in this test, so a push
    // that arrives can only have come from the eager delivery.
    const accepted = await fetchAndDrain(
      workstreamStub,
      "https://workstream.test/internal/substream-effects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          substreamId: "0",
          envelopes: [effectEnvelope({
            kind: "directory_common",
            title: "Finished while the sidebar watched",
            description: "Pushed without the Queue",
            preview: "completed",
            // Personal, so the outsider is not an audience for it.
            scope: "personal",
            state: "completed",
            systemKind: null,
            lastActivityAt: at,
            completedAt: at,
            archivedAt: null,
            originType: "ad_hoc",
            createdByUserId: USER_ID,
            latestAttentionOrdinal: 3,
            unreadTrackingStartOrdinal: 0,
            createdAt: at,
            updatedAt: at,
          }, "00000000-0000-7000-8000-000000000404"),
          effectEnvelope({
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
          }, "00000000-0000-7000-8000-000000000405")],
        }),
      },
    );
    expect(accepted.status).toBe(200);

    // The participant sees the transition itself, not an invalidation to go
    // and fetch it with.
    expect(JSON.parse(String((await participantPush).data))).toMatchObject({
      type: "workspace_workstream_state",
      workstreamId: WORKSTREAM_ID,
      workstream: { harnessStatus: "completed", title: "Finished while the sidebar watched" },
    });
    // The outsider is subscribed to the same workspace and gets the frame, but
    // it carries a tombstone rather than the row: a personal work stream they
    // do not participate in must not become readable because someone else's
    // run finished.
    expect(JSON.parse(String((await outsiderPush).data))).toMatchObject({
      type: "workspace_workstream_state",
      workstreamId: WORKSTREAM_ID,
      workstream: null,
    });

    // Automation-owned runs can still be opened directly from their parent,
    // but their child state must never insert a row into the workspace's
    // recent-work cache. The same pushed-state path therefore sends a
    // tombstone even to the execution participant once the authoritative
    // origin identifies this as automation machinery.
    const participantAutomationPush = nextMessage(participant);
    const outsiderAutomationPush = nextMessage(outsider);
    const automationAccepted = await fetchAndDrain(
      workstreamStub,
      "https://workstream.test/internal/substream-effects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          substreamId: "0",
          envelopes: [effectEnvelope({
            kind: "directory_common",
            title: "Generated automation run",
            description: "Reachable from the automation only",
            preview: "completed",
            scope: "personal",
            state: "completed",
            systemKind: null,
            lastActivityAt: at,
            completedAt: at,
            archivedAt: null,
            originType: "automation",
            createdByUserId: USER_ID,
            automationSubscriptionId: "00000000-0000-7000-8000-000000000406",
            automationRunId: "00000000-0000-7000-8000-000000000407",
            latestAttentionOrdinal: 3,
            unreadTrackingStartOrdinal: 0,
            createdAt: at,
            updatedAt: at,
          }, "00000000-0000-7000-8000-000000000408", 2)],
        }),
      },
    );
    expect(automationAccepted.status).toBe(200);
    expect(JSON.parse(String((await participantAutomationPush).data))).toMatchObject({
      type: "workspace_workstream_state",
      workstreamId: WORKSTREAM_ID,
      workstream: null,
    });
    expect(JSON.parse(String((await outsiderAutomationPush).data))).toMatchObject({
      type: "workspace_workstream_state",
      workstreamId: WORKSTREAM_ID,
      workstream: null,
    });
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
    ]);
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const parent = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
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
        originType: "ad_hoc" as const,
        automationSubscriptionId: null,
        automationRunId: null,
        plannedFor: null,
        systemKind: null,
        createdFromOpportunityId: null,
        opportunityVersion: null,
        opportunityDisplayPromptHash: null,
        opportunityExecutionPromptHash: null,
        executionPrincipal: { type: "user", userId: USER_ID },
        reason: "user_message",
      });
    });
    await child.flushEffectsToWorkstreamDO();
    await parent.flushWorkspaceDirectoryEffects();

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
    const push = nextMessage(socket);

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
        from: "naming",
        to: "automatic",
        now: Date.now(),
      }],
    });
    expect(named.status).toBe(200);

    // Nothing is flushed by hand from here: the child's own alarm forwards the
    // effect, and WorkstreamDO hands it to WorkspaceDO eagerly on arrival.
    await runDurableObjectAlarm(child);

    expect(JSON.parse(String((await push).data))).toMatchObject({
      type: "workspace_workstream_state",
      workstreamId: WORKSTREAM_ID,
      workstream: { title: "Avalon pricing conversation", titleStatus: "automatic" },
    });
    // The alarm is armed already overdue, so workerd may have fired it before
    // `runDurableObjectAlarm` looked: the helper then finds nothing, returns
    // false, and the socket push is what the forwarding chain is proved by
    // either way. Calling `alarm()` directly instead would keep this green
    // even if construction stopped arming the alarm, so the wait stays on the
    // push, inside the suite's 30s budget.
  });

  it("owns and pages the viewer-specific work-stream directory in WorkspaceDO SQL", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const common: WorkstreamRegionalEffect = {
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
      originType: "ad_hoc",
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
    const viewer: WorkstreamRegionalEffect = {
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
        effectEnvelope(common, "00000000-0000-7000-8000-000000000201"),
        effectEnvelope(viewer, "00000000-0000-7000-8000-000000000202"),
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
      envelopes: [effectEnvelope(
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
      envelopes: [effectEnvelope(
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
        ...effectEnvelope(viewer, "00000000-0000-7000-8000-000000000205"),
        generation: 2,
      }],
    });
    await stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [{
        ...effectEnvelope(
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

    const tiedCommon: WorkstreamRegionalEffect = {
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
      envelopes: tiedIds.map((workstreamId, index) => effectEnvelope(
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
        `SELECT COUNT(*) AS count FROM workspace_workstream_directory`,
      ).one().count).toBe(3);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workspace_workstream_viewers`,
      ).one().count).toBe(1);
    });
  });

  it("answers subscribe with the whole sidebar, unasked", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");

    const common: WorkstreamRegionalEffect = {
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
      originType: "ad_hoc",
      createdByUserId: USER_ID,
      latestAttentionOrdinal: 1,
      unreadTrackingStartOrdinal: 0,
      createdAt: "2026-08-21T19:00:00.000Z",
      updatedAt: "2026-08-21T20:00:00.000Z",
      resourceLinks: [],
    };
    await expect(stub.applyWorkstreamDirectoryEffects({
      workspaceId: WORKSPACE_ID,
      envelopes: [effectEnvelope(common, "00000000-0000-7000-8000-000000000701")],
    })).resolves.toMatchObject({ directoryChanged: true });

    // Notes remain workspace product state. Automations arrive through a
    // content-free projection from their named AutomationAgent.
    const subscriptionId = "00000000-0000-7000-8000-000000000704";
    const resourceId = "00000000-0000-7000-8000-000000000705";
    const noteId = "00000000-0000-7000-8000-000000000706";
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
        {
          sql: `INSERT INTO notes
            (id, workspace_id, owner_user_id, resource_id, scope, title,
             last_activity_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'workspace', 'Standup', '2026-08-21T20:30:00.000Z',
                    '2026-08-21T19:00:00.000Z', '2026-08-21T20:30:00.000Z')`,
          params: [noteId, WORKSPACE_ID, USER_ID, resourceId],
        },
      ],
    })).resolves.toMatchObject({ status: 200 });
    await expect(stub.applyAutomationProjection({
      schemaVersion: 1,
      automationId: subscriptionId,
      workspaceId: WORKSPACE_ID,
      authorUserId: USER_ID,
      authorityGeneration: 1,
      projectionVersion: 1,
      payloadHash: "monday-brief-v1",
      lifecycle: "active",
      scope: "workspace",
      title: "Monday brief",
      description: "Every Monday",
      nextRunAt: null,
      attentionCode: null,
    })).resolves.toEqual({ applied: true });

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
        featureFlags: { hypersightEnabled: boolean; meetingRecordingEnabled: boolean };
      };

      expect(event.type).toBe("workspace_sync");
      expect(event.reason).toBe("initial");
      expect(event.featureFlags).toMatchObject({ hypersightEnabled: false, meetingRecordingEnabled: false });
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
      expect(page.notes.items).toHaveLength(1);
      expect(page.notes.items[0]).toMatchObject({ id: noteId, title: "Standup" });
      // The batch carries the same counters the pushes carry, so the client
      // can order the opening list against everything that follows it.
      expect(page.automations.waterline).toBeGreaterThan(0);
      expect(page.notes.waterline).toBeGreaterThan(0);
    } finally {
      socket!.close(1000, "test complete");
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
           INSERT INTO workspace_workstream_directory
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
           INSERT INTO workspace_workstream_directory
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

  it("lists an automation's attention reason and refuses one no screen can render", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");

    const automationId = "00000000-0000-7000-8000-000000000821";
    const projection = {
      schemaVersion: 1 as const,
      automationId,
      workspaceId: WORKSPACE_ID,
      authorUserId: USER_ID,
      authorityGeneration: 1,
      projectionVersion: 1,
      payloadHash: "carried-over-v1",
      // What the cutover writes for an automation whose trigger it could not
      // carry: paused, with the reason beside it. Nothing about "paused" alone
      // tells the person this one is never starting again.
      lifecycle: "paused" as const,
      scope: "workspace" as const,
      title: "Release watcher",
      description: "Watched a document",
      nextRunAt: null,
      attentionCode: "unsupported_trigger",
    };
    await expect(stub.applyAutomationProjection(projection)).resolves.toEqual({ applied: true });

    await expect(stub.listAutomationDirectory({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    })).resolves.toMatchObject({
      items: [{ id: automationId, status: "paused", attention: "unsupported_trigger" }],
    });

    // A reason the client has no words for is a marker with nothing behind it,
    // so it is refused where it is written rather than rendered as a mystery.
    // Asserted inside the object: a rejected native RPC on a stub leaves a
    // second rejection the runtime holds, which fails the run under a summary
    // of passing tests.
    await runInDurableObject(stub, async (instance: WorkspaceDO) => {
      await expect(instance.applyAutomationProjection({
        ...projection,
        projectionVersion: 2,
        payloadHash: "carried-over-v2",
        attentionCode: "something_the_client_has_never_heard_of",
      })).rejects.toThrow();
    });
    await expect(stub.listAutomationDirectory({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
    })).resolves.toMatchObject({
      items: [{ id: automationId, attention: "unsupported_trigger" }],
    });
  });

  it("pushes the automation list when a write lands, including the scheduler's", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");

    const subscriptionId = "00000000-0000-7000-8000-000000000803";
    await expect(stub.applyAutomationProjection({
      schemaVersion: 1,
      automationId: subscriptionId,
      workspaceId: WORKSPACE_ID,
      authorUserId: USER_ID,
      authorityGeneration: 1,
      projectionVersion: 1,
      payloadHash: "weekly-changelog-v1",
      lifecycle: "active",
      scope: "workspace",
      title: "Weekly changelog",
      description: "Every Monday",
      nextRunAt: Date.parse("2026-08-28T09:00:00.000Z"),
      attentionCode: null,
    })).resolves.toEqual({ applied: true });

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

      // The parent projection is the only automation write that reaches the
      // workspace sidebar; the schedule itself remains agent-owned.
      const pushed = nextMessage(socket!);
      await expect(stub.applyAutomationProjection({
        schemaVersion: 1,
        automationId: subscriptionId,
        workspaceId: WORKSPACE_ID,
        authorUserId: USER_ID,
        authorityGeneration: 1,
        projectionVersion: 2,
        payloadHash: "weekly-changelog-v2",
        lifecycle: "active",
        scope: "workspace",
        title: "Weekly changelog",
        description: "Every Monday",
        nextRunAt: Date.parse("2026-09-04T09:00:00.000Z"),
        attentionCode: null,
      })).resolves.toEqual({ applied: true });

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
      await expect(stub.applyAutomationProjection({
        schemaVersion: 1,
        automationId: subscriptionId,
        workspaceId: WORKSPACE_ID,
        authorUserId: USER_ID,
        authorityGeneration: 1,
        projectionVersion: 3,
        payloadHash: "weekly-changelog-v3",
        lifecycle: "paused",
        scope: "workspace",
        title: "Weekly changelog",
        description: "Every Monday",
        nextRunAt: Date.parse("2026-09-04T09:00:00.000Z"),
        attentionCode: "legacy_runtime_error",
      })).resolves.toEqual({ applied: true });
      const second = JSON.parse(String((await secondPush).data)) as {
        waterline: number;
        items: Array<{ status: string; attention: string | null }>;
      };
      expect(second.waterline).toBeGreaterThan(event.waterline);
      expect(second.items[0]?.status).toBe("paused");
      // The status says it stopped; only the reason says why, and the row is
      // where the sidebar reads both.
      expect(second.items[0]?.attention).toBe("legacy_runtime_error");
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
    const noteId = "00000000-0000-7000-8000-000000000812";

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
          {
            sql: `INSERT INTO notes
              (id, workspace_id, owner_user_id, resource_id, scope, title,
               last_activity_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'workspace', 'Retro', '2026-08-21T20:00:00.000Z',
                      '2026-08-21T19:00:00.000Z', '2026-08-21T20:00:00.000Z')`,
            params: [noteId, WORKSPACE_ID, USER_ID, resourceId],
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
        effectEnvelope({
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
          originType: "ad_hoc",
          createdByUserId: USER_ID,
          latestAttentionOrdinal: 0,
          unreadTrackingStartOrdinal: 0,
          createdAt: "2026-08-17T19:00:00.000Z",
          updatedAt: `2026-08-17T2${index}:00:00.000Z`,
          resourceLinks: [],
        }, `00000000-0000-7000-8000-${(0x280 + index).toString(16).padStart(12, "0")}`, 1, workstreamId),
      ]),
    });

    await expect(stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamId: workstreamIds[2]!,
    })).resolves.toMatchObject({ items: [{ id: workstreamIds[2], pinPosition: 0 }] });
    await stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamId: workstreamIds[0]!,
    });
    const repeated = await stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamId: workstreamIds[2]!,
    });
    expect(repeated.items.map((item) => [item.id, item.pinPosition])).toEqual([
      [workstreamIds[2], 0],
      [workstreamIds[0], 1],
    ]);

    const reordered = await stub.reorderWorkstreamPins({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamIds: [workstreamIds[0]!, workstreamIds[1]!, workstreamIds[2]!],
    });
    expect(reordered.items.map((item) => [item.id, item.pinPosition])).toEqual([
      [workstreamIds[0], 0],
      [workstreamIds[2], 1],
    ]);
    const unpinned = await stub.unpinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamId: workstreamIds[0]!,
    });
    expect(unpinned.items.map((item) => [item.id, item.pinPosition]))
      .toEqual([[workstreamIds[2], 0]]);

    const otherUserId = asUserId("00000000-0000-7000-8000-000000000108");
    await expect(stub.pinWorkstream({
      workspaceId: WORKSPACE_ID,
      userId: otherUserId,
      workstreamId: workstreamIds[1]!,
    })).resolves.toMatchObject({ items: [{ id: workstreamIds[1], pinPosition: 0 }] });
    await expect(stub.listWorkstreams({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      limit: 20,
      includeSystem: false,
    })).resolves.toMatchObject({
      items: [
        { id: workstreamIds[1], pinPosition: null },
        { id: workstreamIds[0], pinPosition: null },
        { id: workstreamIds[2], pinPosition: 0 },
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
        effectEnvelope({
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
          originType: "ad_hoc",
          createdByUserId: USER_ID,
          latestAttentionOrdinal: 0,
          unreadTrackingStartOrdinal: 0,
          createdAt: "2026-08-17T19:00:00.000Z",
          updatedAt: "2026-08-17T20:00:00.000Z",
          resourceLinks: [],
        }, "00000000-0000-7000-8000-000000000290"),
        effectEnvelope({
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

  it("owns activity, opportunity provenance, and resolved suggestion state in WorkspaceDO SQL", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const activityId = await stub.recordActivityEvent({
      workspaceId: WORKSPACE_ID,
      eventType: "workstream.mention.created",
      subjectType: "workstream",
      subjectId: WORKSTREAM_ID,
      subjectSequenceNumber: 7,
      actorType: "user",
      actorUserId: USER_ID,
      actorLabel: "Ada",
      title: "Ada mentioned you",
      body: "Review the Durable Object cutover",
      canonicalUrl: null,
      audience: { kind: "user", userId: USER_ID },
      digestible: true,
      occurredAt: "2026-08-18T20:00:00.000Z",
      sourceKind: "workstream_message",
      sourceId: "00000000-0000-7000-8000-000000000401",
      dedupeKey: "mention:workspace-product-runtime",
      metadata: { reason: "runtime-test" },
      targets: [{ userId: USER_ID, relation: "mentioned" }],
    });
    await expect(stub.recordActivityEvent({
      workspaceId: WORKSPACE_ID,
      eventType: "workstream.mention.created",
      subjectType: "workstream",
      subjectId: WORKSTREAM_ID,
      actorType: "user",
      actorUserId: USER_ID,
      actorLabel: "Ada",
      title: "Duplicate delivery",
      body: "Must resolve to the first event",
      canonicalUrl: null,
      audience: { kind: "user", userId: USER_ID },
      digestible: true,
      occurredAt: "2026-08-18T20:00:00.000Z",
      sourceKind: "workstream_message",
      sourceId: "00000000-0000-7000-8000-000000000401",
      dedupeKey: "mention:workspace-product-runtime",
      metadata: {},
      targets: [{ userId: USER_ID, relation: "mentioned" }],
    })).resolves.toBe(activityId);
    const activityPage = WorkspaceActivityEventListResultSchema.parse(await stub.listActivityEvents({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      from: null,
      through: 100,
      notBefore: null,
      digestibleOnly: false,
      limit: 20,
    }));
    expect(activityPage.items).toHaveLength(1);
    expect(activityPage.items[0]).toMatchObject({
      id: activityId,
      isTarget: true,
      targetRelations: ["mentioned"],
      title: "Ada mentioned you",
    });

    const opportunityId = "00000000-0000-7000-8000-000000000402";
    const opportunitySourceId = "00000000-0000-7000-8000-000000000403";
    await expect(stub.ingestConnectorEvent({
      workspaceId: WORKSPACE_ID,
      ingressEventId: opportunitySourceId,
      payloadHash: `sha256:${"d".repeat(64)}`,
      event: {
        connectorType: "github",
        activity: {
          id: opportunitySourceId,
          workspaceId: WORKSPACE_ID,
          region: "global",
          connectionId: "00000000-0000-7000-8000-000000000404",
          connectionScope: "workspace",
          connectionOwnerUserId: null,
          provider: "github",
          providerEventId: "delivery-42",
          eventType: "pull_request.review_requested",
          resourceType: "pull_request",
          providerResourceId: "juno-ai-labs/avalon#42",
          actor: { login: "ada" },
          subject: { number: 42 },
          occurredAt: "2026-08-18T20:00:00.000Z",
          receivedAt: "2026-08-18T20:00:01.000Z",
          title: "Cutover review requested",
          summary: "Review requested",
          textSnippet: "Ada assigned the WorkspaceDO cutover review.",
          payloadRef: null,
          visibility: {},
          targetUserIds: [],
          entityKeys: ["github:pr:42"],
          dedupeKey: "github:delivery-42",
          rawContentHash: null,
          metadata: { canonicalUrl: "https://github.com/juno-ai-labs/avalon/pull/42" },
          externalPeople: [],
        },
      },
    })).resolves.toMatchObject({ eventId: opportunitySourceId, duplicate: false });
    const hash = "a".repeat(64);
    const opportunityInput = {
      workspaceId: WORKSPACE_ID,
      audience: { scope: "personal", userId: USER_ID },
      proposedId: opportunityId,
      existingTargetId: null,
      sourceFingerprint: hash,
      displayPrompt: "Review the DO cutover",
      executionPrompt: "Review the WorkspaceDO authority cutover and report risks.",
      admissionReasoning: "The member was explicitly asked to review the cutover.",
      providerIcon: "brand-github",
      sourceLabel: "From github",
      displayPromptHash: "b".repeat(64),
      executionPromptHash: "c".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      sources: [{
        id: opportunitySourceId,
        kind: "activity",
        provider: "github",
        providerTenantId: "juno-ai-labs",
        connectionId: "00000000-0000-7000-8000-000000000404",
        title: "Cutover review requested",
        summary: "Review requested",
        text: "Ada assigned the WorkspaceDO cutover review.",
        actor: { login: "ada" },
        subject: { number: 42 },
        externalPeople: [{ handle: "ada", role: "assignee" }],
        entityKeys: ["github:pr:42"],
        canonicalUrl: "https://github.com/juno-ai-labs/avalon/pull/42",
        workstreamId: null,
        occurredAt: "2026-08-18T20:00:00.000Z",
      }],
      links: [{
        id: "00000000-0000-7000-8000-000000000405",
        sourceId: opportunitySourceId,
        userId: USER_ID,
        role: "reviewer",
        resolution: "inferred",
        reasoning: "The source names this member.",
        sourceText: "Ada",
        startOffset: 0,
        endOffset: 3,
        verifiedIdentity: null,
      }],
      rankUserIds: [USER_ID],
      eagerUserIds: [],
      rankDueAt: "2099-01-01T00:00:00.000Z",
    } satisfies WorkspaceOpportunityPersistRequest;
    await expect(stub.persistOpportunity(opportunityInput)).resolves.toMatchObject({
      opportunityId,
      version: 1,
    });
    await expect(stub.persistOpportunity(opportunityInput)).resolves.toMatchObject({
      opportunityId,
      version: 1,
    });
    await expect(stub.listOpportunities({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      now: "2026-08-18T20:01:00.000Z",
      limit: 4,
      scheduleAt: "2026-08-18T20:03:00.000Z",
    })).resolves.toMatchObject({ items: [{ id: opportunityId, version: 1 }] });
    await expect(stub.opportunityOriginEvents({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      opportunityId,
      now: "2026-08-18T20:01:00.000Z",
      limit: 8,
    })).resolves.toMatchObject([{
      connectorType: "github",
      activity: { id: opportunitySourceId, providerResourceId: "juno-ai-labs/avalon#42" },
    }]);
    const claimRequest = {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      opportunityId,
      now: "2026-08-18T20:01:00.000Z",
      version: 1,
      idempotencyKey: "same-live-start",
    } as const;
    const claims = (await Promise.all([
      stub.claimOpportunityStart(claimRequest),
      stub.claimOpportunityStart(claimRequest),
    ])).map((claim) => WorkspaceOpportunityClaimStartResultSchema.parse(claim));
    expect(claims.map((claim) => claim.outcome).sort()).toEqual(["claimed", "replay"]);
    await stub.releaseOpportunityStart(claimRequest);
    await env.DB.prepare(
      `UPDATE workspace_members SET last_seen_at = '2000-01-01T00:00:00.000Z'
        WHERE workspace_id = ? AND user_id = ?`,
    ).bind(WORKSPACE_ID, USER_ID).run();
    await expect(stub.dismissOpportunity({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      opportunityId,
      now: "2026-08-18T20:01:00.000Z",
    })).resolves.toMatchObject({ dismissed: true });
    await expect(stub.listOpportunities({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      now: "2026-08-18T20:01:01.000Z",
      limit: 4,
      scheduleAt: "2026-08-18T20:03:00.000Z",
    })).resolves.toEqual({ items: [] });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM opportunity_provenance_nodes",
      ).one().count).toBeGreaterThanOrEqual(4);
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM work_opportunity_user_states WHERE opportunity_id = ? AND user_id = ?",
        opportunityId,
        USER_ID,
      ).one().status).toBe("dismissed");
    });
  });

  it("makes opportunity batch mutation and settlement retries no-ops after completion", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const windowId = "00000000-0000-7000-8000-000000000411";
    const eventId = "00000000-0000-7000-8000-000000000412";
    const leaseId = "00000000-0000-7000-8000-000000000413";
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO opportunity_batch_windows
           (window_id, partition_key, audience_scope, audience_user_id,
            first_event_at, last_event_at, process_after, status, attempt,
            lease_id, lease_expires_at, created_at, updated_at, completed_at)
         VALUES (?, 'workspace', 'workspace', NULL, 1, 1, 1, 'processing', 1,
                 ?, 10000, 1, 1, NULL)`,
        windowId,
        leaseId,
      );
      state.storage.sql.exec(
        `INSERT INTO opportunity_batch_events
           (batch_event_id, window_id, partition_key, source_kind, source_id,
            occurred_at, input_characters, status, attempt_count, error_text,
            created_at, updated_at)
         VALUES (?, ?, 'workspace', 'activity', 'source', 1, 10, 'pending', 0, NULL, 1, 1)`,
        eventId,
        windowId,
      );
    });
    const eventRequest = {
      workspaceId: WORKSPACE_ID,
      windowId,
      leaseId,
      eventIds: [eventId],
      outcome: "processing" as const,
      error: null,
    };
    await stub.mutateOpportunityBatchEvents(eventRequest);
    await stub.mutateOpportunityBatchEvents({ ...eventRequest, outcome: "completed" });
    const settleRequest = { workspaceId: WORKSPACE_ID, windowId, leaseId, retryDelayMs: 1_000 };
    await stub.settleOpportunityWindow(settleRequest);

    await expect(stub.mutateOpportunityBatchEvents(eventRequest)).resolves.toBeUndefined();
    await expect(stub.settleOpportunityWindow(settleRequest)).resolves.toBeUndefined();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM opportunity_batch_events WHERE batch_event_id = ?`,
        eventId,
      ).one()).toEqual({ status: "completed", attempt_count: 1 });
      expect(state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM opportunity_batch_windows WHERE window_id = ?`,
        windowId,
      ).one()).toEqual({ status: "completed" });
    });
  });

  /**
   * The read path's request rules, against the object that owns them.
   *
   * These were asserted in the Node suite against a parallel D1 implementation
   * that migration 0090 made unreachable, so what they proved was never what
   * production ran. `persistOpportunity` needs an ingested connector event
   * behind it and none of these rules turn on provenance — they turn on the
   * stored ranking, the opportunity's status and the member's own state — so
   * the fixtures below write the object's tables directly, the way the batch
   * window fixture above does.
   */
  async function seedOpportunity(
    stub: DurableObjectStub<WorkspaceDO>,
    id: string,
    options: { updatedAt: string; status?: "active" | "started" } = {
      updatedAt: "2026-08-10T12:00:00.000Z",
    },
  ): Promise<void> {
    const at = Date.parse(options.updatedAt);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO work_opportunities
           (opportunity_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
            admission_reasoning, provider_icon, source_label, source_fingerprint, version,
            display_prompt_hash, execution_prompt_hash, status, created_workstream_id,
            created_message_id, started_by_user_id, start_idempotency_key, expires_at,
            created_at, updated_at, started_at)
         VALUES (?, 'workspace', NULL, 'Handle the blocker', 'Investigate the blocker.',
            'Urgent and actionable.', 'plug', 'Connected activity', ?, 1, ?, ?, ?, NULL,
            NULL, NULL, NULL, ?, ?, ?, NULL)`,
        id,
        id.replaceAll("-", "").padEnd(64, "f"),
        "b".repeat(64),
        "c".repeat(64),
        options.status ?? "active",
        Date.parse("2027-08-07T00:00:00.000Z"),
        at,
        at,
      );
    });
  }

  async function seedRankingSet(
    stub: DurableObjectStub<WorkspaceDO>,
    ids: string[],
    fingerprint = "fingerprint",
  ): Promise<void> {
    const at = Date.parse("2026-08-10T12:00:00.000Z");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO suggested_work_sets
           (user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning, model,
            status, due_at, request_seq, lease_id, lease_expires_at, last_ranked_at,
            created_at, updated_at)
         VALUES (?, ?, ?, 'Ranked', NULL, 'ready', NULL, 0, NULL, NULL, NULL, ?, ?)`,
        USER_ID,
        fingerprint,
        JSON.stringify(ids),
        at,
        at,
      );
    });
  }

  async function storedDueAt(stub: DurableObjectStub<WorkspaceDO>): Promise<number | null> {
    return runInDurableObject(stub, (_instance, state) => (
      state.storage.sql.exec<{ due_at: number | null }>(
        "SELECT due_at FROM suggested_work_sets WHERE user_id = ?",
        USER_ID,
      ).toArray()[0]?.due_at ?? null
    ));
  }

  async function openWorkspaceStub() {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    return stub;
  }

  const READ = {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    now: "2026-08-10T12:00:00.000Z",
    limit: 4,
    scheduleAt: "2026-08-10T12:02:00.000Z",
  } as const;

  it("serves a member's stored ranking in its stored order and asks for nothing", async () => {
    const stub = await openWorkspaceStub();
    const first = "00000000-0000-7000-8000-000000000201";
    const second = "00000000-0000-7000-8000-000000000202";
    // Seeded against recency order: the point of the read path is that it
    // returns the ranking, not the newest thing.
    await seedOpportunity(stub, first, { updatedAt: "2026-08-09T00:00:00.000Z" });
    await seedOpportunity(stub, second, { updatedAt: "2026-08-10T00:00:00.000Z" });
    await seedRankingSet(stub, [first, second]);

    const page = await stub.listOpportunities(READ);

    expect(page.items.map((item) => item.id)).toEqual([first, second]);
    // Nothing was asked for: the set is current and no ranking is outstanding.
    await expect(storedDueAt(stub)).resolves.toBeNull();
  });

  it("falls back to recency and asks for a ranking when a member has nothing stored", async () => {
    const stub = await openWorkspaceStub();
    const older = "00000000-0000-7000-8000-000000000205";
    const newer = "00000000-0000-7000-8000-000000000206";
    await seedOpportunity(stub, older, { updatedAt: "2026-08-08T00:00:00.000Z" });
    await seedOpportunity(stub, newer, { updatedAt: "2026-08-09T00:00:00.000Z" });

    const page = await stub.listOpportunities(READ);

    // Something, rather than the blank section a member used to get.
    expect(page.items.map((item) => item.id)).toEqual([newer, older]);
    await expect(storedDueAt(stub)).resolves.toBe(Date.parse(READ.scheduleAt));
  });

  it("asks for a refill when a ranked suggestion is no longer showable", async () => {
    const stub = await openWorkspaceStub();
    const kept = "00000000-0000-7000-8000-00000000020d";
    const started = "00000000-0000-7000-8000-00000000020e";
    await seedOpportunity(stub, kept);
    // Started rather than dismissed: dismissing asks for its own refill, and
    // this is the hole nothing on the write path would have noticed.
    await seedOpportunity(stub, started, {
      updatedAt: "2026-08-10T12:00:00.000Z",
      status: "started",
    });
    await seedRankingSet(stub, [kept, started]);

    const page = await stub.listOpportunities(READ);

    expect(page.items.map((item) => item.id)).toEqual([kept]);
    await expect(storedDueAt(stub)).resolves.toBe(Date.parse(READ.scheduleAt));
  });

  it("treats an empty ranking with no candidates as a steady state, not a gap", async () => {
    const stub = await openWorkspaceStub();
    await seedRankingSet(stub, []);

    await stub.listOpportunities(READ);
    await stub.listOpportunities(READ);

    // An empty set is this member's steady state, not a gap to be filled.
    // Asking on every read cost a write per request and an alarm claim per pass.
    await expect(storedDueAt(stub)).resolves.toBeNull();
  });

  it("drops a dismissed suggestion from a member's set and asks for a replacement", async () => {
    const stub = await openWorkspaceStub();
    const kept = "00000000-0000-7000-8000-000000000203";
    const dismissed = "00000000-0000-7000-8000-000000000204";
    await seedOpportunity(stub, kept);
    await seedOpportunity(stub, dismissed);
    await seedRankingSet(stub, [kept, dismissed]);

    await expect(stub.dismissOpportunity({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      opportunityId: dismissed,
      now: READ.now,
    })).resolves.toMatchObject({ dismissed: true });

    // Read before the list: dismissing leaves a hole the member can see, so the
    // request is filed by the dismissal itself rather than waiting for the next
    // read to notice the gap — which is what the refill test above covers.
    await expect(storedDueAt(stub)).resolves.not.toBeNull();
    const page = await stub.listOpportunities(READ);
    expect(page.items.map((item) => item.id)).toEqual([kept]);
  });

  it("debounces impression-driven ranking requests for one hour", async () => {
    const stub = await openWorkspaceStub();
    const opportunityId = "00000000-0000-7000-8000-000000000204";
    await seedOpportunity(stub, opportunityId);
    await seedRankingSet(stub, [opportunityId]);

    // Impressions are the one input that asks for a re-rank without the
    // candidates having changed, so within the hour they must ask for nothing.
    await stub.recordOpportunityImpressions({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      opportunityIds: [opportunityId],
      now: READ.now,
      rerankBefore: "2026-08-10T11:00:00.000Z",
    });
    await expect(storedDueAt(stub)).resolves.toBeNull();

    await stub.recordOpportunityImpressions({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      opportunityIds: [opportunityId],
      now: "2026-08-10T13:00:01.000Z",
      rerankBefore: "2026-08-10T12:00:01.000Z",
    });

    await expect(storedDueAt(stub)).resolves.not.toBeNull();
    await expect(runInDurableObject(stub, (_instance, state) => (
      state.storage.sql.exec<{ impression_count: number; candidate_fingerprint: string }>(
        `SELECT state.impression_count, sets.candidate_fingerprint
           FROM work_opportunity_user_states state
           JOIN suggested_work_sets sets ON sets.user_id = state.user_id
          WHERE state.opportunity_id = ? AND state.user_id = ?`,
        opportunityId,
        USER_ID,
      ).one()
    ))).resolves.toEqual({
      impression_count: 2,
      // Blanked deliberately. Asking for a ranking is not enough on its own —
      // the alarm skips a run whose candidates hash to what is already stored,
      // and by definition that is every run this asks for.
      candidate_fingerprint: "",
    });
  });

  it("marks every active member's ranking due, and only the active ones", async () => {
    const stub = await openWorkspaceStub();
    const suspended = "00000000-0000-7000-8000-0000000002ff";
    await env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role, last_seen_at)
       VALUES (?, ?, 'suspended', 'member', NULL)`,
    ).bind(WORKSPACE_ID, suspended).run();

    await stub.markWorkspaceOpportunityRankingDue(WORKSPACE_ID, 0);

    await expect(runInDurableObject(stub, (_instance, state) => (
      state.storage.sql.exec<{ user_id: string }>(
        "SELECT user_id FROM suggested_work_sets ORDER BY user_id",
      ).toArray().map((row) => row.user_id)
    ))).resolves.toEqual([USER_ID]);
  });

  it("holds product alarm work while a maintenance campaign owns the tables", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const windowId = "00000000-0000-7000-8000-000000000443";
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO opportunity_batch_windows
           (window_id, partition_key, audience_scope, audience_user_id,
            first_event_at, last_event_at, process_after, status, attempt,
            lease_id, lease_expires_at, created_at, updated_at, completed_at)
         VALUES (?, 'workspace', 'workspace', NULL, 1, 1, 1, 'pending', 0,
                 NULL, NULL, 1, 1, NULL)`,
        windowId,
      );
      // Every production writer of this table arms the product entry in the
      // same RPC. This fixture writes the row directly to fix its due time in
      // the past, so it arms it the same way afterwards; without an entry the
      // alarm has nothing to run, which is the contract, not a gap.
      await (instance as unknown as { refreshProductAlarm(): Promise<void> })
        .refreshProductAlarm();
    });
    await env.DB.prepare(
      `UPDATE workstream_authority_control SET phase = 'maintenance_importing' WHERE id = 1`,
    ).run();

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    // The due window is still exactly as the importer left it: unclaimed.
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string; lease_id: string | null }>(
        `SELECT status, lease_id FROM opportunity_batch_windows WHERE window_id = ?`,
        windowId,
      ).one()).toEqual({ status: "pending", lease_id: null });
    });

    // The gate is the phase and nothing else: once the region opens, the same
    // alarm walks straight into the admission Workflow launch. This
    // environment binds no Workflow, so reaching it fails — and the shared
    // alarm base holds that failure against the product entry alone rather
    // than letting it throw the whole alarm, which is why the claim below is
    // the proof the window was reached rather than held.
    await env.DB.prepare(
      `UPDATE workstream_authority_control SET phase = 'durable_object_open' WHERE id = 1`,
    ).run();
    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM opportunity_batch_windows WHERE window_id = ?`,
        windowId,
      ).one().status).toBe("processing");
      const gated = new ScheduledAlarmStore(state.storage.sql).get("product", "workspace");
      expect(gated?.attempt).toBe(1);
      expect(gated!.retryAt).toBeGreaterThan(Date.now());
    });
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

  it("closes a metadata socket when the work stream itself stops admitting its reader", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const at = "2026-08-22T12:00:00.000Z";
    const otherCreator = "00000000-0000-7000-8000-000000000706";
    const directory = (
      scope: "workspace" | "personal",
      eventId: string,
      creatorUserId = otherCreator,
    ) => effectEnvelope({
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
      originType: "ad_hoc" as const,
      createdByUserId: creatorUserId,
      automationSubscriptionId: null,
      automationRunId: null,
      plannedFor: null,
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
    await stub.receiveSubstreamEffects({
      substreamId: "0",
      envelopes: [directory("workspace", "00000000-0000-7000-8000-000000000701"), effectEnvelope({
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

    const response = await stub.fetch("https://workstream.test/socket", {
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
      await stub.receiveSubstreamEffects({
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
      await stub.receiveSubstreamEffects({
        substreamId: "0",
        envelopes: [effectEnvelope({
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
      await stub.receiveSubstreamEffects({
        substreamId: "0",
        envelopes: [directory("workspace", "00000000-0000-7000-8000-000000000705")],
      });
    }
  });

  it("serves complete WorkstreamDO metadata and pushes changes after hibernation", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    const at = "2026-08-17T20:00:00.000Z";
    const common = {
      kind: "directory_common" as const,
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
      originType: "ad_hoc" as const,
      createdByUserId: USER_ID,
      automationSubscriptionId: null,
      automationRunId: null,
      plannedFor: null,
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
    const initialized = await fetchAndDrain(stub, "https://workstream.test/internal/substream-effects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        substreamId: "0",
        envelopes: [effectEnvelope(common, "socket-common"), effectEnvelope(user, "socket-user")],
      }),
    });
    expect(initialized.status).toBe(200);

    const ticketId = "00000000-0000-7000-8000-000000000108";
    const response = await stub.fetch("https://workstream.test/socket", {
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
    const snapshot = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe" }));
    const initialMetadata = JSON.parse(String((await snapshot).data)) as {
      metadata: { stateVersion: { commonEventId: string; viewerEventId: string | null } };
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
    expect(initialMetadata.metadata.stateVersion.commonEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(initialMetadata.metadata.stateVersion.viewerEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const pushed = nextMessage(socket);
    const update = await fetchAndDrain(stub, "https://workstream.test/internal/substream-effects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        substreamId: "0",
        envelopes: [effectEnvelope({ ...common, title: "Renamed from another client" }, "socket-common-2", 2)],
      }),
    });
    expect(update.status).toBe(200);
    expect(JSON.parse(String((await pushed).data))).toMatchObject({
      type: "workstream_metadata",
      metadata: { title: "Renamed from another client" },
    });
    socket.close(1000, "done");
  });

  it("warms substream zero when the work stream wakes", async () => {
    await seedOpenAuthority();
    const workstreamStub = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
      workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    // Give the parent an identity to read: a first wake has no child, and the
    // guard is what stops it looking for one.
    const at = "2026-08-21T20:00:00.000Z";
    expect((await fetchAndDrain(
      workstreamStub,
      "https://workstream.test/internal/substream-effects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          substreamId: "0",
          envelopes: [effectEnvelope({
            kind: "directory_common",
            title: "Rides together",
            description: "Parent and main child",
            preview: "Preview",
            scope: "workspace",
            state: "idle",
            systemKind: null,
            lastActivityAt: at,
            completedAt: null,
            archivedAt: null,
            latestAttentionOrdinal: 1,
          }, "00000000-0000-7000-8000-000000000701")],
        }),
      },
    )).status).toBe(200);

    // Evict the parent and touch it again, so its constructor runs with an
    // identity in storage. Nothing in this test addresses the child.
    const substreamStub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await evictDurableObject(workstreamStub);
    await workstreamStub.flushWorkspaceDirectoryEffects();

    // Whether the child is *running* is the observable, and eviction is what
    // asks: the harness refuses to evict an object that was never started.
    // Asserting on its schema instead would prove nothing, because reaching in
    // to look would construct it and run the migrations itself.
    await expect(evictDurableObject(substreamStub)).resolves.toBeUndefined();
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
          text: sequence <= 40 ? "z".repeat(120_000) : `short ${sequence}`,
          authorType: "agent",
          now: 4_000 + sequence,
        });
      }
    });

    const snapshot = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
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
    expect(delivered.map((turn) => turn.transcriptSequence)).toEqual([76, 77, 78, 79, 80]);
    expect(frame.transcript.ranges).toEqual([
      expect.objectContaining({
        purpose: "latest",
        covered: { startInclusive: 76, endExclusive: 81 },
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-rally-workspace-id": WORKSPACE_ID,
        "x-rally-workstream-id": WORKSTREAM_ID,
        "x-rally-substream-id": "0",
        "x-rally-user-id": USER_ID,
        "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": "00000000-0000-7000-8010-000000000801",
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      const dashboard = vi.spyOn(testable, "scheduleBlockDashboardRefresh")
        .mockRejectedValueOnce(new Error("forced_dashboard_intent_failure"));
      await expect(testable.drainSemanticRealtimeOutbox())
        .rejects.toThrow("forced_dashboard_intent_failure");
      dashboard.mockRestore();

      // The canonical row and its exact room sequence survive together. The
      // outbox is not acknowledged until dashboard refresh intent is durable.
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

    // Simulate the isolate disappearing in the gap before its best-effort
    // post-commit continuation could re-arm delivery. Construction derives the
    // alarm from the persisted outbox and the platform alarm then drains it —
    // nothing else wakes this object, so synchronize with that delivery
    // rather than forcing it: a `runDurableObjectAlarm` call is a no-op in
    // the window where an auto-fired overdue alarm has not yet re-armed, and
    // a direct `alarm()` invocation would keep this test green even if
    // construction stopped arming the alarm. A probe may run while the drain
    // is still in flight, but a read-only probe can neither advance nor
    // duplicate delivery and succeeds only once the drain has synchronously
    // acknowledged the row; it fails by timeout if the reconstructed object
    // never armed or never delivered.
    await evictDurableObject(stub);
    await stub.wake();
    // The empty outbox is the complete witness: the drain acknowledges the
    // row only after the semantic frame and the dashboard-refresh intent are
    // both durable, so nothing further is asserted here. `realtime_state` is
    // written at enqueue time and would pass before the drain ever ran, and
    // the pending dashboard-refresh row is consumed by the debounced alarm,
    // so asserting either from a separate invocation proves nothing or races.
    await expect.poll(
      () => runInDurableObject(stub, (_instance, state) => Number(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM durable_outbox
          WHERE channel = 'semantic_realtime_v1'`,
      ).one().count)),
      { timeout: 4_000, interval: 50 },
    ).toBe(0);
    // The poll keeps its tighter 4s budget so a genuine recovery failure is
    // reported as its own `expected 1 to be +0` well inside the suite's 30s
    // test budget, rather than as a harness timeout.
  });

  it("hydrates an overtaken pending upsert as a delivered removal from the minimal receipt", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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

      const event = (instance as unknown as TestableSubstreamAgent).semanticRealtimeEvent({
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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

  it("rejects retired message pages and keeps the SubstreamAgent socket read-only for commands", async () => {
    await seedOpenAuthority();
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    const bootstrap = await fetchAndDrain(stub, "https://substream.test/internal/runtime-bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
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
    const pageReceipt = nextMessage(socket!);
    socket!.send(JSON.stringify({
      type: "load_message_page",
      requestId: "00000000-0000-7000-8000-000000000118",
      cursor: { direction: "before", value: "10" },
    }));
    expect(JSON.parse(String((await pageReceipt).data))).toMatchObject({
      type: "error",
      code: "invalid_event",
    });
    const receipt = nextMessage(socket!);
    socket!.send(JSON.stringify({
      type: "create_message",
      operationId: "00000000-0000-7000-8000-000000000107",
      payload: {
        text: "route me through the workspace",
        clientMessageId: "client-runtime-test",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    }));
    expect(JSON.parse(String((await receipt).data))).toMatchObject({
      type: "error",
      code: "workspace_socket_required",
    });
    socket!.close(1000, "done");
  });
  // The production stall in one assertion, against the real objects rather than
  // the shared helper: `nextLoopWorkAt`/`nextRunAt` once consulted the
  // in-memory drain flag, so a claimed run stopped contributing a due time, the
  // alarm was deleted, and the cancelled drain left nothing to rediscover it.
  // A drain that never settles is exactly the state a cancellation produces.
  it("keeps a claimed run schedulable in both agents while a drain is in flight", async () => {
    await seedOpenAuthority();
    const wedged = new Promise<void>(() => {});

    const substream = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await substream.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
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
          workstreamId: WORKSTREAM_ID,
          substreamId: "0",
          loopId: substreamLoopId(WORKSTREAM_ID),
          harnessRunId: "run-wedged",
          triggerMessageId: null,
          automationSubscriptionId: null,
          activityId: null,
          executionPrincipal: { type: "system" },
          reason: "user_message",
        }),
      );
      // Put the drain in the state a cancelled invocation leaves behind.
      void testable.agentDrain.resume(() => wedged, () => undefined);
      expect(testable.nextLoopWorkAt()).not.toBeNull();
    });

    const block = env.BLOCK_DASHBOARD_AGENTS.get(env.BLOCK_DASHBOARD_AGENTS.idFromName(
      blockDashboardAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, BLOCK_DASHBOARD_BLOCK_ID),
    ));
    await fetchAndDrain(block, "https://block-dashboard.test/health");
    await runInDurableObject(block, async (instance, state) => {
      const testable = instance as unknown as TestableDispatchScheduler;
      state.storage.sql.exec(
        `INSERT INTO agent_run_dispatches
           (block_run_id, dispatch_json, configuration_version_number, trigger_sequence,
            source_created_at, state, attempt, available_at, started_at, created_at, updated_at)
         VALUES ('block-wedged', '{}', 1, 0, 1, 'running', 1, 1, 1, 1, 1)`,
      );
      void testable.agentDrain.resume(() => wedged, () => undefined);
      expect(testable.nextRunAt!()).not.toBeNull();
    });
  });

  describe("delivery authority for a work stream", () => {
    const OWNING_ID = "00000000-0000-7000-8006-000000000001";
    const ARCHIVED_ID = "00000000-0000-7000-8006-000000000002";

    async function seededWorkspace(): Promise<DurableObjectStub<WorkspaceDO>> {
      const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
        workspaceDOName("global", WORKSPACE_ID),
      ));
      await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
      await runInDurableObject(stub, (_instance, state) => {
        const insert = (id: string, generation: number, archivedAt: number | null): void => {
          state.storage.sql.exec(
            `INSERT INTO workspace_workstream_directory
               (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
                title, description, preview, scope, exact_state, system_kind, last_activity_at,
                completed_at, archived_at, email_address, origin_type, origin_label,
                created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
                title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
                next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
                source_created_at, source_updated_at, projected_at)
             VALUES (?, ?, 1, ?, 'test', 'Owning room', '', '', 'workspace', 'idle', NULL, 1,
                     NULL, ?, NULL, 'ad_hoc', NULL, ?, NULL, NULL, NULL,
                     'settled', 0, 0, NULL, NULL, NULL, 1, 1, 1)`,
            id,
            generation,
            `00000000-0000-7000-8007-${id.slice(-12)}`,
            archivedAt,
            USER_ID,
          );
        };
        insert(OWNING_ID, 4, null);
        insert(ARCHIVED_ID, 1, 1);
      });
      return stub;
    }

    it("answers the current fence, and refuses to name one for a room it does not have", async () => {
      const stub = await seededWorkspace();

      // The generation, not a default: an automation delivering behind a stale
      // fence is the case the fence exists for, so reading one that was never
      // bumped would make every delivery look current.
      expect(await stub.workstreamDeliveryAuthority({
        workspaceId: WORKSPACE_ID,
        workstreamId: OWNING_ID,
      })).toEqual({ authorityGeneration: 4, archived: false });

      // An automation can outlive the room it belongs to. Null rather than a
      // generation, so a caller cannot mistake "gone" for "generation 1".
      expect(await stub.workstreamDeliveryAuthority({
        workspaceId: WORKSPACE_ID,
        workstreamId: "00000000-0000-7000-8006-000000000009",
      })).toBeNull();
    });

    it("reports an archived room as archived rather than as absent", async () => {
      const stub = await seededWorkspace();

      // Archived is not the same as gone: unarchiving restores the room and its
      // automations, so the caller declines to write without concluding the
      // work stream no longer exists.
      expect(await stub.workstreamDeliveryAuthority({
        workspaceId: WORKSPACE_ID,
        workstreamId: ARCHIVED_ID,
      })).toEqual({ authorityGeneration: 1, archived: true });
    });
  });

  describe("exposing an automation run", () => {
    const RUN_ID = "00000000-0000-7000-8008-000000000001";
    const ARCHIVED_RUN_ID = "00000000-0000-7000-8008-000000000002";
    const AD_HOC_ID = "00000000-0000-7000-8008-000000000003";

    async function seededWorkspace(): Promise<DurableObjectStub<WorkspaceDO>> {
      const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
        workspaceDOName("global", WORKSPACE_ID),
      ));
      await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
      await runInDurableObject(stub, (_instance, state) => {
        const insert = (id: string, originType: string, archivedAt: number | null): void => {
          state.storage.sql.exec(
            `INSERT INTO workspace_workstream_directory
               (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
                title, description, preview, scope, exact_state, system_kind, last_activity_at,
                completed_at, archived_at, email_address, origin_type, origin_label,
                created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
                title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
                next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
                source_created_at, source_updated_at, projected_at)
             VALUES (?, 1, 1, ?, 'test', 'An occurrence', '', '', 'personal', 'completed', NULL, 1,
                     1, ?, NULL, ?, NULL, ?, NULL, NULL, NULL,
                     'settled', 0, 0, NULL, NULL, NULL, 1, 1, 1)`,
            id,
            `00000000-0000-7000-8009-${id.slice(-12)}`,
            archivedAt,
            originType,
            USER_ID,
          );
        };
        insert(RUN_ID, "automation", null);
        insert(ARCHIVED_RUN_ID, "automation", 1);
        insert(AD_HOC_ID, "ad_hoc", null);
      });
      return stub;
    }

    function exposedScope(
      stub: DurableObjectStub<WorkspaceDO>,
      workstreamId: string,
    ): Promise<{ automation_exposed: number; scope: string }> {
      return runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec<{ automation_exposed: number; scope: string }>(
          `SELECT automation_exposed, scope FROM workspace_workstream_directory
            WHERE workstream_id = ?`,
          workstreamId,
        ).one());
    }

    it("reveals a shared automation's run to the workspace, and stays idempotent", async () => {
      const stub = await seededWorkspace();

      expect(await stub.exposeAutomationRunWorkstream({
        workspaceId: WORKSPACE_ID,
        workstreamId: RUN_ID,
        scope: "workspace",
      })).toEqual({ exposed: true, outcomeCode: "workstream_exposed" });
      // Shared automation, shared output: the run is promoted, not merely
      // unhidden for the one person the child work stream was created under.
      expect(await exposedScope(stub, RUN_ID))
        .toEqual({ automation_exposed: 1, scope: "workspace" });

      // A delivery retry after a crash has nothing to duplicate.
      expect(await stub.exposeAutomationRunWorkstream({
        workspaceId: WORKSPACE_ID,
        workstreamId: RUN_ID,
        scope: "workspace",
      })).toEqual({ exposed: true, outcomeCode: "workstream_exposed" });
      expect(await exposedScope(stub, RUN_ID))
        .toEqual({ automation_exposed: 1, scope: "workspace" });
    });

    it("reveals a run whose scope was never recorded without widening it", async () => {
      const stub = await seededWorkspace();

      expect(await stub.exposeAutomationRunWorkstream({
        workspaceId: WORKSPACE_ID,
        workstreamId: RUN_ID,
        scope: null,
      })).toEqual({ exposed: true, outcomeCode: "workstream_exposed" });
      // Revealed narrowly. Guessing "workspace" for a context frozen before the
      // scope travelled with it would hand somebody's run to everyone.
      expect(await exposedScope(stub, RUN_ID))
        .toEqual({ automation_exposed: 1, scope: "personal" });
    });

    it("leaves an archived run archived and refuses a work stream a person made", async () => {
      const stub = await seededWorkspace();

      // Somebody archived this occurrence. A later occurrence classifying
      // expose_workstream must not undo that decision.
      expect(await stub.exposeAutomationRunWorkstream({
        workspaceId: WORKSPACE_ID,
        workstreamId: ARCHIVED_RUN_ID,
        scope: "workspace",
      })).toEqual({ exposed: false, outcomeCode: "workstream_archived" });
      expect(await exposedScope(stub, ARCHIVED_RUN_ID))
        .toEqual({ automation_exposed: 0, scope: "personal" });

      // Only a run's own work stream. Otherwise this RPC could unhide a room
      // whose visibility somebody chose deliberately.
      expect(await stub.exposeAutomationRunWorkstream({
        workspaceId: WORKSPACE_ID,
        workstreamId: AD_HOC_ID,
        scope: "workspace",
      })).toEqual({ exposed: false, outcomeCode: "workstream_not_an_automation_run" });
      expect(await exposedScope(stub, AD_HOC_ID))
        .toEqual({ automation_exposed: 0, scope: "personal" });
    });
  });

  describe("automation activation", () => {
    const activation = {
      type: "automation_activation" as const,
      schemaVersion: 1 as const,
      automationId: "00000000-0000-7000-8000-0000000001a1",
      automationName: "Candidate email intake",
      runId: "00000000-0000-7000-8000-0000000001a2",
      runWorkstreamId: "00000000-0000-7000-8000-0000000001a3",
      deliveryId: "delivery-1",
      trigger: { kind: "external_event" as const },
      occurredAt: Date.parse("2026-09-01T09:00:00.000Z"),
    };

    async function openRuntime(): Promise<DurableObjectStub<SubstreamAgent>> {
      await seedOpenAuthority();
      const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
        substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
      ));
      expect((await stub.bootstrapRuntime({
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        generation: 1,
      })).status).toBe(200);
      return stub;
    }

    it("lands one row a retry cannot duplicate", async () => {
      const stub = await openRuntime();
      const request = {
        schemaVersion: 1 as const,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        authorityGeneration: 1,
        deliveryId: activation.deliveryId,
        text: "Two candidates reached final round.",
        executionPrincipal: { type: "workspace" as const, workspaceId: WORKSPACE_ID },
        activation,
      };

      expect(await stub.appendAutomationActivation(request))
        .toEqual({ outcome: "appended", code: "automation_activation_appended" });
      // The delivery loop retries after a crash; the room must not be told
      // twice, and the idempotency is the delivery's own id.
      expect(await stub.appendAutomationActivation(request))
        .toEqual({ outcome: "replayed", code: "automation_activation_replayed" });

      await runInDurableObject(stub, async (_instance, state) => {
        // An activation is loop input, not a canonical turn: it becomes one
        // when the loop promotes it, and the run it starts is the whole point
        // of delivering into a room rather than appending to it.
        const rows = state.storage.sql.exec<{
          actor: string; message_type: string; mode: string; bind_payload_json: string;
        }>(
          `SELECT actor, message_type, mode, bind_payload_json FROM pending_loop_inputs`,
        ).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.actor).toBe("system");
        expect(rows[0]!.message_type).toBe("automation_activation");
        // Never mid-run: a person watching the room is doing something.
        expect(rows[0]!.mode).toBe("queue");
        // What the woken agent reads. The untrusted wrapper travels with it —
        // an activation quotes connector content and is not an instruction.
        expect(rows[0]!.bind_payload_json).toContain("UNTRUSTED AUTOMATION RESULT");
        expect(rows[0]!.bind_payload_json).toContain("Two candidates reached final round.");
      });
    });

    it("wakes the room rather than leaving the input for somebody else to find", async () => {
      const stub = await openRuntime();

      // Asserted at the admission itself: the activation request is what the
      // object turns into an alarm, and by the time an assertion outside could
      // look, that alarm has already fired and cleared. Without this request an
      // activation is a row in a mailbox nothing ever drains.
      await runInDurableObject(stub, async (instance) => {
        const product = (instance as unknown as {
          product: { admitAutomationActivation: (input: unknown) => Promise<{
            activationRequest: { kind: string; cause: string } | null;
          }> };
        }).product;
        const result = await product.admitAutomationActivation({
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          messageId: "00000000-0000-7000-8000-0000000001b1",
          clientMessageId: "automation-activation:delivery-wake",
          text: "The board deck went out.",
          activation: { ...activation, deliveryId: "delivery-wake" },
          executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
          origin: "automation_activation",
          now: activation.occurredAt,
        });
        expect(result.activationRequest).toMatchObject({
          kind: "activate_substream_loop",
          cause: "pending_input",
        });
      });
    });

    it("refuses a run that outlived a pause, and an archived room", async () => {
      const stub = await openRuntime();
      const request = {
        schemaVersion: 1 as const,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        authorityGeneration: 2,
        deliveryId: "delivery-stale",
        text: "Nobody should read this.",
        executionPrincipal: { type: "workspace" as const, workspaceId: WORKSPACE_ID },
        activation: { ...activation, deliveryId: "delivery-stale" },
      };

      // The same fence provider writes respect: an in-flight run whose
      // automation was paused or deleted does not get to deliver.
      expect(await stub.appendAutomationActivation(request))
        .toEqual({ outcome: "refused", code: "workstream_authority_generation_stale" });

      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(`UPDATE workstream SET archived_at = ? WHERE id = 1`, Date.now());
      });
      expect(await stub.appendAutomationActivation({ ...request, authorityGeneration: 1 }))
        .toEqual({ outcome: "refused", code: "workstream_archived" });
    });
  });
});
