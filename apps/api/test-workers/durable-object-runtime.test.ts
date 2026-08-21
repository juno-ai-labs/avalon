/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { asBlockId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId, type BlockDashboardBlockRun } from "@avalon/contracts";
import {
  evictDurableObject,
  listDurableObjectIds,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { SubstreamAgent } from "../src/durable-objects/substream-agent";
import {
  BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS,
  BlockDashboardAgent,
} from "../src/durable-objects/block-dashboard-agent";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS, WorkspaceDO } from "../src/durable-objects/workspace-do";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { WorkspaceScheduler } from "../src/durable-objects/workspace-scheduler";
import { WorkstreamDO } from "../src/durable-objects/workstream-do";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import {
  substreamAgentName,
  blockDashboardAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import {
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffect,
} from "../src/durable-objects/workstream-regional-effect";
import {
  BlockDashboardBlockDispatchSchema,
  blockDashboardBlockResultHash,
  type BlockDashboardBlockDispatch,
} from "../src/durable-objects/block-dashboard-protocol";
import { WorkspaceActivityEventListResultSchema } from "../src/durable-objects/workspace-activity-event-protocol";
import type { WorkspaceOpportunityPersistRequest } from "../src/durable-objects/workspace-opportunity-protocol";
import { WORKSPACE_LOCAL_TABLES } from "../src/services/workspace-runtime-database";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000101");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000102");
const CHILD_SUBSTREAM_ID = asSubstreamId("00000000-0000-7000-8000-000000000103");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000104");
const SESSION_ID = "runtime-test-session";
const BLOCK_DASHBOARD_BLOCK_ID = asBlockId("00000000-0000-7000-8000-000000000109");

beforeEach(async () => {
  await reset();
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
      analytics_workspace_id TEXT
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

function tableNames(state: DurableObjectState): string[] {
  return state.storage.sql.exec<{ name: string }>(
    `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).toArray().map((row) => row.name);
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
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
  effect: WorkstreamRegionalEffect,
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
  ): Promise<{ failed: boolean; errorCode: string | null; retryAt: number | null }>;
};

type TestableSubstreamAgent = {
  publishAgentRuntimeEvent(event: Record<string, unknown>): Promise<void>;
  nextRunDispatchAt(): number | null;
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

describe("Durable Objects in the Workers runtime", () => {
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

      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM durable_outbox WHERE channel = 'regional_effect_v1'`,
      ).one().count).toBe(2);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM projection_keys`,
      ).one().count).toBe(2);
    });
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
          "parts",
          "agent_run_dispatches",
          "active_agent_compaction",
        ],
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
          "workspace_workstream_suggestion_feedback",
          "workspace_workstream_viewers",
          "workspace_sync_events",
          "workspace_socket_ticket_receipts",
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
      {
        namespace: env.WORKSPACE_SCHEDULERS,
        name: workspaceDOName("global", WORKSPACE_ID),
        constructor: WorkspaceScheduler,
        migrations: 1,
        tables: ["_sql_schema_migrations", "workspace_scheduler_state", "scheduler_retry_states"],
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
          table.type === "table" && !table.name.startsWith("sqlite_") && table.strict !== 1
        ));
        expect(nonStrict).toEqual([]);
        if (instance instanceof SubstreamAgent) {
          const dispatchColumns = state.storage.sql.exec<{ name: string }>(
            `PRAGMA table_info(agent_run_dispatches)`,
          ).toArray().map((column) => column.name);
          expect(dispatchColumns).toEqual(expect.arrayContaining([
            "terminal_outcome_json",
            "settled_at",
            "last_settlement_error_code",
          ]));
        }
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
    await runInDurableObject(stub, (_instance, state) => {
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
            depth, return_mode, origin_part_id, owner_user_id, audience,
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
      state.storage.sql.exec(
        `INSERT INTO parts
           (id, substream_id, sequence_number, attention_ordinal, role, kind,
            author_type, author_user_id, content, visibility, pinned, created_at, updated_at)
         VALUES ('message-1', '0', 1, 1, 'assistant', 'text', 'agent', NULL,
                 'before tool', 'both', 0, 1000, 1000)`,
      );
      state.storage.sql.exec(
        `INSERT INTO parts
           (id, substream_id, sequence_number, role, kind, author_type, content,
            effect_intent_id, tool_name, tool_mode, tool_status, visibility, pinned,
            created_at, updated_at)
         VALUES ('tool-2', '0', 2, 'assistant', 'tool_call', 'agent', '', 'effect-2',
                 'terminal_run', 'read', 'pending', 'people', 0, 1001, 1001)`,
      );
      state.storage.sql.exec(
        `INSERT INTO parts
           (id, substream_id, sequence_number, attention_ordinal, role, kind,
            author_type, author_user_id, content, visibility, pinned, created_at, updated_at)
         VALUES ('message-3', '0', 3, 2, 'user', 'text', 'member', ?,
                 'queued while the tool runs', 'both', 0, 1002, 1002)`,
        USER_ID,
      );
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
    await runInDurableObject(stub, (_instance, state) => {
      const pending = JSON.parse(state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM due_work WHERE job_key = 'block_dashboard_refresh'`,
      ).one().payload_json) as { contextFence: { throughSequence: number } };
      expect(pending.contextFence.throughSequence).toBe(1);
      state.storage.sql.exec(
        `UPDATE parts SET tool_status = 'completed', updated_at = 1003 WHERE id = 'tool-2'`,
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
        messageId: "00000000-0000-7000-8000-000000000116",
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
        messageId: checkpoint.messageId,
        harnessRunId: dispatch.harnessRunId,
        turnId: checkpoint.turnId,
        epoch: checkpoint.epoch,
        streamSeq: 0,
        reset: false,
      });
      await testable.recordStreamEvent(dispatch, {
        type: "stream_delta",
        messageId: checkpoint.messageId,
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
        "x-avalon-region": "global",
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-block-dashboard-block-id": BLOCK_DASHBOARD_BLOCK_ID,
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": "00000000-0000-7000-8000-000000000117",
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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
        "x-avalon-region": "global",
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-block-dashboard-block-id": BLOCK_DASHBOARD_BLOCK_ID,
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": "00000000-0000-7000-8000-000000000117",
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(replayed.status).toBe(401);
    const expired = await fetchAndDrain(blockStub, "https://block-dashboard.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-avalon-region": "global",
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-block-dashboard-block-id": BLOCK_DASHBOARD_BLOCK_ID,
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": "00000000-0000-7000-8000-000000000118",
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) - 1),
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
        messageId: "00000000-0000-7000-8000-000000000116",
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
      await (instance as unknown as TestableBlockDashboardAgent).persistAndSettle(dispatch, {
        run: completed,
      });
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
    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), SESSION_ID).run();
    const blockClosed = nextClose(blockSocket);
    await blockStub.revalidateViewerAccess({
      region: "global",
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      blockId: BLOCK_DASHBOARD_BLOCK_ID,
      userId: USER_ID,
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
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-placement-affinity": "wnam",
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": ticketId,
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-placement-affinity": "wnam",
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": ticketId,
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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
          "x-avalon-workspace-id": WORKSPACE_ID,
          "x-avalon-placement-affinity": "wnam",
          "x-avalon-user-id": userId,
          "x-avalon-session-id": `${SESSION_ID}-${userId}`,
          "x-avalon-socket-ticket-id": ticketId,
          "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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
    const claims = await Promise.all([
      stub.claimOpportunityStart(claimRequest),
      stub.claimOpportunityStart(claimRequest),
    ]);
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
    })).resolves.toBe(true);
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

  it("holds product alarm work while a maintenance campaign owns the tables", async () => {
    await seedOpenAuthority();
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
      workspaceDOName("global", WORKSPACE_ID),
    ));
    await stub.initializeWorkspace(WORKSPACE_ID, "wnam");
    const windowId = "00000000-0000-7000-8000-000000000443";
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO opportunity_batch_windows
           (window_id, partition_key, audience_scope, audience_user_id,
            first_event_at, last_event_at, process_after, status, attempt,
            lease_id, lease_expires_at, created_at, updated_at, completed_at)
         VALUES (?, 'workspace', 'workspace', NULL, 1, 1, 1, 'pending', 0,
                 NULL, NULL, 1, 1, NULL)`,
        windowId,
      );
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
    // environment binds no Workflow, so reaching it surfaces as that binding's
    // absence — which is the proof the window was claimed rather than held.
    await env.DB.prepare(
      `UPDATE workstream_authority_control SET phase = 'durable_object_open' WHERE id = 1`,
    ).run();
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.alarm()).rejects.toThrow(/WORK_OPPORTUNITY_WORKFLOW|create/u);
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM opportunity_batch_windows WHERE window_id = ?`,
        windowId,
      ).one().status).toBe("processing");
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
    const receiptId = "00000000-0000-7000-8000-000000000428";
    const receipt = await stub.executeRuntimeSql({
      workspaceId: WORKSPACE_ID,
      requestId: "00000000-0000-7000-8000-000000000429",
      statements: [{
        sql: `INSERT INTO webhook_receipts
          (id, workspace_id, connection_id, signature_hash, received_at, expires_at)
         VALUES (?, ?, ?, 'signed-delivery',
                 '2026-08-18T20:00:00.000Z', '2026-08-19T20:00:00.000Z')`,
        params: [receiptId, WORKSPACE_ID, connectionId],
      }],
    });
    expect(receipt.status).toBe(200);
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
        "SELECT workspace_id FROM webhook_receipts WHERE id = ?",
        receiptId,
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

  it("owns connector events, deduplicates Queue replays, and fences Workflow settlement", async () => {
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
    const workflowInstanceId = `connector-event:${firstId}`;
    const claim = await stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      workflowInstanceId,
      attempt: 0,
    });
    expect(claim).toMatchObject({
      outcome: "claimed",
      event: { connectorType: "github", activity: { id: firstId, workspaceId: WORKSPACE_ID } },
    });
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      workflowInstanceId: "connector-event:other",
      attempt: 0,
    })).resolves.toEqual({ outcome: "busy" });
    await stub.settleConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      workflowInstanceId,
      outcome: "processed",
      error: null,
    });
    await expect(stub.claimConnectorEvent({
      workspaceId: WORKSPACE_ID,
      eventId: firstId,
      workflowInstanceId,
      attempt: 0,
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
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": ticketId,
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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

  it("shrinks the resume window too when the snapshot frame is over its cap", async () => {
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
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-substream-id": "0",
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": "00000000-0000-7000-8000-000000000801",
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    // The oldest messages are the heavy ones, so the reader's resume window is
    // what puts the frame over the cap while the newest page stays small. Only
    // the newest page used to be reducible, which left the loop with nothing to
    // trim and failed the open outright.
    await runInDurableObject(stub, (_instance, state) => {
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
        state.storage.sql.exec(
          `INSERT INTO parts
             (id, substream_id, sequence_number, role, kind, author_type, content,
              visibility, pinned, created_at, updated_at)
           VALUES (?, '0', ?, 'assistant', 'text', 'agent', ?, 'people', 0, ?, ?)`,
          `00000000-0000-7000-8004-${String(sequence).padStart(12, "0")}`,
          sequence,
          sequence <= 40 ? "z".repeat(120_000) : `short ${sequence}`,
          4_000 + sequence,
          4_000 + sequence,
        );
      }
    });

    const snapshot = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    const frame = JSON.parse(String((await snapshot).data)) as {
      type: string;
      code?: string;
      resumeFeed: { items: unknown[] } | null;
    };
    // A snapshot, not `snapshot_unavailable`, and one that still carries the
    // reader's window rather than dropping it wholesale.
    expect(frame.type).toBe("snapshot");
    expect(frame.resumeFeed).not.toBeNull();
    expect(frame.resumeFeed!.items.length).toBeGreaterThan(0);
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
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-substream-id": "0",
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": "00000000-0000-7000-8000-000000000601",
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();

    // 60 messages, with this reader stopped a long way behind the end.
    await runInDurableObject(stub, (_instance, state) => {
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
        state.storage.sql.exec(
          `INSERT INTO parts
             (id, substream_id, sequence_number, role, kind, author_type, content,
              visibility, pinned, created_at, updated_at)
           VALUES (?, '0', ?, 'assistant', 'text', 'agent', ?, 'people', 0, ?, ?)`,
          `00000000-0000-7000-8003-${String(sequence).padStart(12, "0")}`,
          sequence,
          `message ${sequence}`,
          3_000 + sequence,
          3_000 + sequence,
        );
      }
    });

    const snapshot = nextMessage(socket);
    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    const frame = JSON.parse(String((await snapshot).data)) as {
      type: string;
      workstream: { firstUnreadSequenceNumber: number | null };
      messageFeed: { items: { sequenceNumber: number }[] };
      resumeFeed: { items: { sequenceNumber: number }[] } | null;
    };
    expect(frame.type).toBe("snapshot");
    // The newest page is bounded now: a scroll-back buffer is not worth paying
    // for on the frame a person waits to see.
    const newest = frame.messageFeed.items.map((item) => item.sequenceNumber);
    expect(newest).toHaveLength(20);
    expect(newest.at(-1)).toBe(60);
    expect(newest[0]).toBe(41);

    // And the reader's own position arrives with it, so opening on it costs no
    // second request. `around` splits its limit either side of the sequence.
    const resumeAt = frame.workstream.firstUnreadSequenceNumber!;
    expect(resumeAt).toBeLessThan(41);
    const resume = frame.resumeFeed!.items.map((item) => item.sequenceNumber);
    expect(resume).toContain(resumeAt);
    expect(Math.min(...resume)).toBeLessThan(resumeAt);
    expect(Math.max(...resume)).toBeGreaterThan(resumeAt);
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
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-substream-id": "0",
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": "00000000-0000-7000-8000-000000000131",
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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

    await runInDurableObject(stub, (_instance, state) => {
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
        state.storage.sql.exec(
          `INSERT INTO parts
             (id, substream_id, sequence_number, role, kind, author_type, content,
              visibility, pinned, created_at, updated_at)
           VALUES (?, '0', ?, 'assistant', 'text', 'agent', ?, 'people', 0, ?, ?)`,
          `00000000-0000-7000-8002-${String(sequence).padStart(12, "0")}`,
          sequence,
          `canonical ${sequence}`,
          2_000 + sequence,
          2_000 + sequence,
        );
      }
    });

    const snapshot = nextMessage(socket);
    socket.send(JSON.stringify({ type: "request_snapshot" }));
    const frame = JSON.parse(String((await snapshot).data)) as {
      type: string;
      workstream: { id: string };
      messageFeed: { items: { sequenceNumber: number }[] };
    };
    expect(frame.type).toBe("snapshot");
    expect(frame.workstream.id).toBe(WORKSTREAM_ID);
    expect(frame.messageFeed.items.map((item) => item.sequenceNumber)).toEqual([1, 2, 3]);

    // The request holds the socket out of broadcasts while the snapshot is
    // assembled. Leaving it that way would silently stop every later frame, so
    // the end state is the one thing worth pinning here.
    await runInDurableObject(stub, (_instance, state) => {
      const attachment = state.getWebSockets()[0]!.deserializeAttachment() as { subscribed: boolean };
      expect(attachment.subscribed).toBe(true);
    });
  });

  it("pages a subscribed feed in both directions without advancing the shared room cursor", async () => {
    await seedOpenAuthority();
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
    })).status).toBe(200);
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-substream-id": "0",
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": "00000000-0000-7000-8000-000000000121",
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
      },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    let roomSequence = 0;
    await runInDurableObject(stub, (_instance, state) => {
      const server = state.getWebSockets()[0]!;
      server.serializeAttachment({
        ...(server.deserializeAttachment() as Record<string, unknown>),
        subscribed: true,
      });
      for (let sequence = 1; sequence <= 6; sequence += 1) {
        state.storage.sql.exec(
          `INSERT INTO parts
             (id, substream_id, sequence_number, role, kind, author_type, content,
              visibility, pinned, created_at, updated_at)
           VALUES (?, '0', ?, 'assistant', 'text', 'agent', ?, 'people', 0, ?, ?)`,
          `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
          sequence,
          `message ${sequence}`,
          1_000 + sequence,
          1_000 + sequence,
        );
      }
      roomSequence = state.storage.sql.exec<{ event_sequence: number }>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ).one().event_sequence;
    });

    const beforeReceipt = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "load_message_page",
      requestId: "00000000-0000-7000-8000-000000000122",
      limit: 2,
      cursor: { direction: "before", value: "6" },
    }));
    expect(JSON.parse(String((await beforeReceipt).data))).toMatchObject({
      type: "message_page",
      requestId: "00000000-0000-7000-8000-000000000122",
      page: {
        items: [{ sequenceNumber: 4 }, { sequenceNumber: 5 }],
        nextCursor: "4",
        newerCursor: null,
      },
    });

    const afterReceipt = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "load_message_page",
      requestId: "00000000-0000-7000-8000-000000000123",
      limit: 2,
      cursor: { direction: "after", value: "2" },
    }));
    expect(JSON.parse(String((await afterReceipt).data))).toMatchObject({
      type: "message_page",
      requestId: "00000000-0000-7000-8000-000000000123",
      page: {
        items: [{ sequenceNumber: 3 }, { sequenceNumber: 4 }],
        nextCursor: null,
        newerCursor: "4",
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ event_sequence: number }>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ).one().event_sequence).toBe(roomSequence);
      for (let sequence = 7; sequence <= 11; sequence += 1) {
        state.storage.sql.exec(
          `INSERT INTO parts
             (id, substream_id, sequence_number, role, kind, author_type, content,
              visibility, pinned, created_at, updated_at)
           VALUES (?, '0', ?, 'assistant', 'text', 'agent', ?, 'people', 0, ?, ?)`,
          `00000000-0000-7000-8001-${String(sequence).padStart(12, "0")}`,
          sequence,
          `message ${sequence} ${"x".repeat(240_000)}`,
          1_000 + sequence,
          1_000 + sequence,
        );
      }
    });

    const cappedReceipt = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "load_message_page",
      requestId: "00000000-0000-7000-8000-000000000125",
      limit: 5,
      cursor: { direction: "after", value: "6" },
    }));
    const cappedFrame = String((await cappedReceipt).data);
    expect(new TextEncoder().encode(cappedFrame).byteLength).toBeLessThanOrEqual(900_000);
    expect(JSON.parse(cappedFrame)).toMatchObject({
      type: "message_page",
      requestId: "00000000-0000-7000-8000-000000000125",
      page: {
        items: [{ sequenceNumber: 7 }, { sequenceNumber: 8 }, { sequenceNumber: 9 }],
        newerCursor: "9",
      },
    });

    const cappedBeforeReceipt = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "load_message_page",
      requestId: "00000000-0000-7000-8000-000000000139",
      limit: 5,
      cursor: { direction: "before", value: "12" },
    }));
    const cappedBeforeFrame = String((await cappedBeforeReceipt).data);
    expect(new TextEncoder().encode(cappedBeforeFrame).byteLength).toBeLessThanOrEqual(900_000);
    expect(JSON.parse(cappedBeforeFrame)).toMatchObject({
      type: "message_page",
      requestId: "00000000-0000-7000-8000-000000000139",
      page: {
        items: [{ sequenceNumber: 9 }, { sequenceNumber: 10 }, { sequenceNumber: 11 }],
        nextCursor: "9",
      },
    });

    await runInDurableObject(stub, (_instance, state) => {
      const oversizedPartId = "00000000-0000-7000-8001-000000000012";
      state.storage.sql.exec(
        `INSERT INTO parts
           (id, substream_id, sequence_number, role, kind, author_type, content,
            visibility, pinned, message_type, structured_content_json, created_at, updated_at)
         VALUES (?, '0', 12, 'assistant', 'text', 'agent', ?, 'people', 0, 'text', ?, 1012, 1012)`,
        oversizedPartId,
        "z".repeat(260_000),
        JSON.stringify({ payload: "y".repeat(259_900) }),
      );
      for (let mentionIndex = 0; mentionIndex < 3_000; mentionIndex += 1) {
        state.storage.sql.exec(
          `INSERT INTO part_mentions
             (part_id, mention_index, mention_kind, target_user_id, connector_type,
              start_offset, end_offset, attention_ordinal)
           VALUES (?, ?, 'connector', NULL, ?, 0, 1, ?)`,
          oversizedPartId,
          mentionIndex,
          `connector-${String(mentionIndex).padStart(60, "x")}`,
          mentionIndex + 1,
        );
      }
    });
    const oversizedReceipt = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "load_message_page",
      requestId: "00000000-0000-7000-8000-000000000140",
      cursor: { direction: "after", value: "11" },
    }));
    expect(JSON.parse(String((await oversizedReceipt).data))).toMatchObject({
      type: "message_page_error",
      requestId: "00000000-0000-7000-8000-000000000140",
      code: "message_page_too_large",
    });

    await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), SESSION_ID).run();
    const revokedReceipt = nextMessage(socket);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({
      type: "load_message_page",
      requestId: "00000000-0000-7000-8000-000000000124",
      cursor: { direction: "before", value: "4" },
    }));
    expect(JSON.parse(String((await revokedReceipt).data))).toMatchObject({
      type: "message_page_error",
      requestId: "00000000-0000-7000-8000-000000000124",
      code: "socket_access_revoked",
    });
    expect((await closed).code).toBe(1008);
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
          "x-avalon-workspace-id": WORKSPACE_ID,
          "x-avalon-workstream-id": WORKSTREAM_ID,
          "x-avalon-substream-id": "0",
          "x-avalon-user-id": USER_ID,
          "x-avalon-session-id": SESSION_ID,
          "x-avalon-socket-ticket-id": ticketId,
          "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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

  it("makes the SubstreamAgent socket read-only for user commands", async () => {
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
    const response = await stub.fetch("https://substream.test/socket", {
      headers: {
        Upgrade: "websocket",
        "x-avalon-workspace-id": WORKSPACE_ID,
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-substream-id": "0",
        "x-avalon-user-id": USER_ID,
        "x-avalon-session-id": SESSION_ID,
        "x-avalon-socket-ticket-id": "00000000-0000-7000-8000-000000000106",
        "x-avalon-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
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
      type: "message_page_error",
      requestId: "00000000-0000-7000-8000-000000000118",
      code: "subscription_required",
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
  // the shared helper: `nextRunDispatchAt`/`nextRunAt` once consulted the
  // in-memory drain flag, so a claimed run stopped contributing a due time, the
  // alarm was deleted, and the cancelled drain left nothing to rediscover it.
  // A drain that never settles is exactly the state a cancellation produces.
  it("keeps a claimed run schedulable in both agents while a drain is in flight", async () => {
    const wedged = new Promise<void>(() => {});

    const substream = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, CHILD_SUBSTREAM_ID),
    ));
    await fetchAndDrain(substream, "https://object.test/health");
    await runInDurableObject(substream, async (instance, state) => {
      const testable = instance as unknown as TestableSubstreamAgent;
      state.storage.sql.exec(
        `INSERT INTO substreams
           (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
         VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 1)
         ON CONFLICT(id) DO NOTHING`,
      );
      state.storage.sql.exec(
        `INSERT INTO runs (
           run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
           model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
           active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
           tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
           created_at, updated_at
         ) VALUES ('run-wedged', '0', NULL, 'admitted', '{}', 0, 0, '', 0, 0, 1,
                   0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_run_dispatches
           (run_id, input_json, state, attempt, available_at, started_at, created_at, updated_at)
         VALUES ('run-wedged', '{}', 'running', 1, 1, 1, 1, 1)`,
      );
      // Put the drain in the state a cancelled invocation leaves behind.
      void testable.agentDrain.resume(() => wedged, () => undefined);
      expect(testable.nextRunDispatchAt()).not.toBeNull();
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
});
