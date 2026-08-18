/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import type { HyperSightBlockRun } from "@avalon/contracts";
import {
  evictDurableObject,
  listDurableObjectIds,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { SubstreamAgent } from "../src/durable-objects/substream-agent";
import { HyperSightBlockAgent } from "../src/durable-objects/hypersight-block-agent";
import { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { WorkspaceScheduler } from "../src/durable-objects/workspace-scheduler";
import { WorkstreamDO } from "../src/durable-objects/workstream-do";
import {
  substreamAgentName,
  hyperSightBlockAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import {
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffect,
} from "../src/durable-objects/workstream-regional-effect";
import { hyperSightBlockResultHash } from "../src/durable-objects/hypersight-protocol";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000101";
const WORKSTREAM_ID = "00000000-0000-7000-8000-000000000102";
const CHILD_SUBSTREAM_ID = "00000000-0000-7000-8000-000000000103";
const USER_ID = "00000000-0000-7000-8000-000000000104";
const SESSION_ID = "runtime-test-session";
const HYPERSIGHT_BLOCK_ID = "00000000-0000-7000-8000-000000000109";

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
      region TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role)
      VALUES (?, ?, 'active', 'member')`).bind(WORKSPACE_ID, USER_ID),
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

function effectEnvelope(
  effect: WorkstreamRegionalEffect,
  messageId: string,
  sourceVersion = 1,
) {
  return {
    kind: "workstream_regional_effect" as const,
    contractVersion: 1 as const,
    region: "global" as const,
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    generation: 1,
    messageId,
    partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: workstreamRegionalEffectHash(effect),
    effect,
  };
}

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
  it("constructs every object through its SQL migration ledger", async () => {
    const cases = [
      {
        namespace: env.SUBSTREAM_AGENTS,
        name: substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
        constructor: SubstreamAgent,
        tables: ["_sql_schema_migrations", "parts", "agent_run_dispatches"],
      },
      {
        namespace: env.HYPERSIGHT_BLOCK_AGENTS,
        name: hyperSightBlockAgentName(
          "global",
          WORKSPACE_ID,
          WORKSTREAM_ID,
          HYPERSIGHT_BLOCK_ID,
        ),
        constructor: HyperSightBlockAgent,
        tables: ["_sql_schema_migrations", "hypersight_block_identity", "agent_run_dispatches"],
      },
      {
        namespace: env.WORKSTREAM_DOS,
        name: workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
        constructor: WorkstreamDO,
        tables: [
          "_sql_schema_migrations",
          "substream_directory",
          "durable_outbox",
          "workstream_socket_ticket_receipts",
          "hypersight_configuration_versions",
          "hypersight_dispatch_outbox",
          "hypersight_source_refresh_outbox",
        ],
      },
      {
        namespace: env.WORKSPACE_DOS,
        name: workspaceDOName("global", WORKSPACE_ID),
        constructor: WorkspaceDO,
        tables: [
          "_sql_schema_migrations",
          "workspace_identity",
          "workspace_sync_events",
          "workspace_socket_ticket_receipts",
        ],
      },
      {
        namespace: env.WORKSPACE_SCHEDULERS,
        name: workspaceDOName("global", WORKSPACE_ID),
        constructor: WorkspaceScheduler,
        tables: ["_sql_schema_migrations", "workspace_scheduler_state", "scheduler_retry_states"],
      },
    ] as const;

    for (const entry of cases) {
      const stub = entry.namespace.get(entry.namespace.idFromName(entry.name));
      await fetchAndDrain(stub, "https://object.test/health");
      await runInDurableObject(stub, (instance, state) => {
        expect(instance).toBeInstanceOf(entry.constructor);
        expect(tableNames(state)).toEqual(expect.arrayContaining([...entry.tables]));
        expect(state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM _sql_schema_migrations`,
        ).one().count).toBeGreaterThan(0);
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
        "https://substream.test/internal/hypersight-refresh-request",
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
        `SELECT payload_json FROM due_work WHERE job_key = 'hypersight_refresh'`,
      ).one().payload_json) as { contextFence: { throughSequence: number } };
      expect(pending.contextFence.throughSequence).toBe(1);
      state.storage.sql.exec(
        `UPDATE parts SET tool_status = 'completed', updated_at = 1003 WHERE id = 'tool-2'`,
      );
    });

    await requestRefresh(4);
    await runInDurableObject(stub, (_instance, state) => {
      const pending = JSON.parse(state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM due_work WHERE job_key = 'hypersight_refresh'`,
      ).one().payload_json) as { contextFence: { throughSequence: number } };
      expect(pending.contextFence.throughSequence).toBe(3);
    });
  });

  it("gives each stable HyperSight block an isolated SQLite dispatch ledger that survives eviction", async () => {
    const secondBlockId = "00000000-0000-7000-8000-000000000110";
    const first = env.HYPERSIGHT_BLOCK_AGENTS.get(env.HYPERSIGHT_BLOCK_AGENTS.idFromName(
      hyperSightBlockAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, HYPERSIGHT_BLOCK_ID),
    ));
    const second = env.HYPERSIGHT_BLOCK_AGENTS.get(env.HYPERSIGHT_BLOCK_AGENTS.idFromName(
      hyperSightBlockAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, secondBlockId),
    ));
    await Promise.all([
      fetchAndDrain(first, "https://hypersight.test/health"),
      fetchAndDrain(second, "https://hypersight.test/health"),
    ]);
    await runInDurableObject(first, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO hypersight_block_identity
           (id, workspace_id, workstream_id, block_id, region, created_at)
         VALUES (1, ?, ?, ?, 'global', 1)`,
        WORKSPACE_ID,
        WORKSTREAM_ID,
        HYPERSIGHT_BLOCK_ID,
      );
    });
    await runInDurableObject(second, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM hypersight_block_identity`,
      ).one().count).toBe(0);
    });
    await evictDurableObject(first);
    await fetchAndDrain(first, "https://hypersight.test/health");
    await runInDurableObject(first, (_instance, state) => {
      expect(state.storage.sql.exec<{ block_id: string }>(
        `SELECT block_id FROM hypersight_block_identity WHERE id = 1`,
      ).one().block_id).toBe(HYPERSIGHT_BLOCK_ID);
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
      const response = await fetchAndDrain(stub, "https://workstream.test/internal/substream-effects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ substreamId, envelopes }),
      });
      expect(response.status).toBe(200);
    }

    await runInDurableObject(stub, async (_instance, state) => {
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
      ).one().count).toBe(2);
      state.storage.sql.exec(
        `UPDATE durable_outbox SET state = 'inflight' WHERE partition_key = 'common'`,
      );
      state.storage.sql.exec(
        `DELETE FROM durable_outbox WHERE partition_key = ?`,
        `user:${USER_ID}`,
      );
    });

    const newest = "2026-08-17T20:02:00.000Z";
    const replacement = await fetchAndDrain(
      stub,
      "https://workstream.test/internal/substream-effects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          substreamId: CHILD_SUBSTREAM_ID,
          envelopes: [effectEnvelope(common("running", newest, null), "child-common-v2", 2)],
        }),
      },
    );
    expect(replacement.status).toBe(200);
    await runInDurableObject(stub, async (_instance, state) => {
      const replacements = state.storage.sql.exec<{ source_version: number; state: string }>(
        `SELECT source_version, state FROM durable_outbox WHERE partition_key = 'common'
          ORDER BY source_version`,
      ).toArray();
      expect(replacements).toHaveLength(2);
      expect(replacements[1]!.source_version).toBe(replacements[0]!.source_version + 1);
      expect(replacements[0]?.state).toBe("inflight");
      state.storage.sql.exec(`DELETE FROM durable_outbox`);
      await state.storage.deleteAlarm();
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
        }, "hypersight-common")],
      }),
    });
    expect(initialized.status).toBe(200);

    const versionId = "00000000-0000-7000-8000-000000000111";
    const updated = await fetchAndDrain(stub, "https://workstream.test/internal/hypersight", {
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
          blocks: [{ id: HYPERSIGHT_BLOCK_ID, prompt: "" }],
        },
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      hypersight: {
        versionId,
        versionNumber: 1,
        blocks: [{ id: HYPERSIGHT_BLOCK_ID, prompt: "", latestRun: null }],
      },
      runs: [],
    });

    const conflict = await fetchAndDrain(stub, "https://workstream.test/internal/hypersight", {
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
    expect(await conflict.json()).toEqual({ error: "hypersight_version_conflict" });

    const preference = await fetchAndDrain(stub, "https://workstream.test/internal/hypersight", {
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
        `SELECT COUNT(*) AS count FROM hypersight_configuration_versions`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ visible: number }>(
        `SELECT visible FROM hypersight_user_preferences WHERE user_id = ?`,
        USER_ID,
      ).one().visible).toBe(1);
    });
  });

  it("dispatches a block to its named agent and applies versioned results idempotently", async () => {
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
        }, "hypersight-dispatch-common")],
      }),
    });
    const versionId = "00000000-0000-7000-8000-000000000113";
    const updated = await fetchAndDrain(stub, "https://workstream.test/internal/hypersight", {
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
          blocks: [{ id: HYPERSIGHT_BLOCK_ID, prompt: "Summarize the current state" }],
        },
      }),
    });
    expect(await updated.json()).toMatchObject({ runs: [] });
    const scheduled = await fetchAndDrain(stub, "https://workstream.test/internal/hypersight", {
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
    const payload = await scheduled.json() as { runs: HyperSightBlockRun[] };
    expect(payload.runs).toHaveLength(1);
    const queued = payload.runs[0]!;
    await runDurableObjectAlarm(stub);

    const blockStub = env.HYPERSIGHT_BLOCK_AGENTS.get(env.HYPERSIGHT_BLOCK_AGENTS.idFromName(
      hyperSightBlockAgentName("global", WORKSPACE_ID, WORKSTREAM_ID, HYPERSIGHT_BLOCK_ID),
    ));
    await fetchAndDrain(blockStub, "https://hypersight.test/health");
    await runInDurableObject(blockStub, (_instance, state) => {
      expect(state.storage.sql.exec<{ block_id: string }>(
        `SELECT block_id FROM hypersight_block_identity WHERE id = 1`,
      ).one().block_id).toBe(HYPERSIGHT_BLOCK_ID);
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
      blockId: HYPERSIGHT_BLOCK_ID,
      sourceVersion: 1,
      payloadHash: hyperSightBlockResultHash(running),
      run: running,
    };
    const first = await fetchAndDrain(stub, "https://workstream.test/internal/hypersight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(effect),
    });
    expect(await first.json()).toEqual({ accepted: true });
    const duplicate = await fetchAndDrain(stub, "https://workstream.test/internal/hypersight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(effect),
    });
    expect(await duplicate.json()).toEqual({ accepted: false });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string; started_at: number }>(
        `SELECT status, started_at FROM hypersight_block_runs WHERE block_run_id = ?`,
        queued.id,
      ).one()).toEqual({ status: "running", started_at: Date.parse(running.startedAt) });
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

    await evictDurableObject(stub);
    const pong = nextMessage(socket!);
    socket!.send("ping");
    expect((await pong).data).toBe("pong");
    const snapshot = nextMessage(socket!);
    socket!.send(JSON.stringify({ type: "subscribe", afterVersion: 0 }));
    expect(JSON.parse(String((await snapshot).data))).toMatchObject({
      type: "workspace_sync",
      version: 0,
      reason: "initial",
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
    expect(JSON.parse(String((await snapshot).data))).toMatchObject({
      type: "workstream_metadata",
      metadata: {
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
});
