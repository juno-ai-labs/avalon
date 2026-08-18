/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  listDurableObjectIds,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { SubstreamAgent } from "../src/durable-objects/substream-agent";
import { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { WorkspaceScheduler } from "../src/durable-objects/workspace-scheduler";
import { WorkstreamDO } from "../src/durable-objects/workstream-do";
import {
  substreamAgentName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import {
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffect,
} from "../src/durable-objects/workstream-regional-effect";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000101";
const WORKSTREAM_ID = "00000000-0000-7000-8000-000000000102";
const CHILD_SUBSTREAM_ID = "00000000-0000-7000-8000-000000000103";
const USER_ID = "00000000-0000-7000-8000-000000000104";
const SESSION_ID = "runtime-test-session";

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
        namespace: env.WORKSTREAM_DOS,
        name: workstreamDOName("global", WORKSPACE_ID, WORKSTREAM_ID),
        constructor: WorkstreamDO,
        tables: ["_sql_schema_migrations", "substream_directory", "durable_outbox"],
      },
      {
        namespace: env.WORKSPACE_DOS,
        name: workspaceDOName("global", WORKSPACE_ID),
        constructor: WorkspaceDO,
        tables: ["_sql_schema_migrations", "workspace_identity", "socket_ticket_receipts"],
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
        last_activity_at: string;
        completed_at: string | null;
      }>(`SELECT exact_state, last_activity_at, completed_at FROM workstream_metadata WHERE id = 1`).one())
        .toEqual({ exact_state: "running", last_activity_at: later, completed_at: null });
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
      state.storage.sql.exec(`DELETE FROM durable_outbox`);
      await state.storage.deleteAlarm();
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
        "x-avalon-workstream-id": WORKSTREAM_ID,
        "x-avalon-substream-id": "0",
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
    const socket = response.webSocket;
    expect(socket).toBeDefined();
    socket!.accept();

    const replay = await stub.fetch("https://workspace.test/socket", {
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
    expect(replay.status).toBe(401);
    await replay.arrayBuffer();

    await evictDurableObject(stub);
    const closed = new Promise<CloseEvent>((resolve) => {
      socket!.addEventListener("close", resolve, { once: true });
    });
    socket!.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    expect((await closed).code).toBe(1008);
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
