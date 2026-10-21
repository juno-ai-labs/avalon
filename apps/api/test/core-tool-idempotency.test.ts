import { asAutomationId, asHarnessRunId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRootRow,
} from "./helpers/durable-authority";
import { legacyProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000000");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const BREAKOUT_ID = asSubstreamId("00000000-0000-7000-8000-0000000000b1");
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000003");

/**
 * The `PAYLOADS` binding the tools under test need in order to construct, kept
 * behaviourally honest so a read finds whatever a fixture put there. It also
 * carried put-recording and a timeout injector for `create_artifact`, the one
 * provider-key tool that wrote an object before its row; nothing here writes R2
 * any more, so asserting on puts would only be asserting on this class.
 */
class MemoryBucket {
  private readonly objects = new Map<string, string | ArrayBuffer>();

  async put(key: string, value: string | ArrayBuffer): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    return {
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(): {
  database: DatabaseSync;
  objectDatabase: DatabaseSync;
  objectStore: DatabaseSync;
  baseEnv: Env;
  env: Env;
} {
  const database = legacyProductSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'google-core-tool', 'core-tool@example.com', 'Core Tool', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Core Tool', 'core-tool', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Core Tool', 'Core Tool', 'ad_hoc', '${USER_ID}',
            'running', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  // The run, transcript, and elicitations live in the work stream's own
  // object since migration 0090; the tools reach them through the runtime
  // router, so the env under test is the routed execution environment the
  // harness hands its tools.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM_ID,
    workspaceId: WORKSPACE_ID,
    title: "Core Tool",
    description: "Core Tool",
    originType: "ad_hoc",
    createdByUserId: USER_ID,
    exactState: "running",
  });

  seedWorkstreamRun(objectStore, { id: HARNESS_RUN_ID,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }) });
  // The note and resource rows live in a real WorkspaceDO over its own schema:
  // NoteService reaches the notes as typed methods, and the resource tools'
  // runtime SQL routes to the same object through its compatibility port.
  const workspaceObject = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: database,
    register: (created) => { openDatabases.push(created); },
  });
  const baseEnv = createTestEnv({
    DB: sqliteD1(database),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>(new MemoryBucket()),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_API_BASE_URL: "https://api.example.test",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-client",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-secret",
    SLACK_CLIENT_ID: "slack-client",
    SLACK_CLIENT_SECRET: "slack-secret",
    SLACK_SIGNING_SECRET: "slack-signing-secret",
    // The elicitation tool's replay check reaches the object through the
    // scheduling port rather than the runtime router, so the fixture needs the
    // binding that port dispatches through — over this same object store.
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
    WORKSPACE_DOS: testSubstreamAgentsBinding(objectStore, {
      extra: workspaceObjectRpcs(workspaceObject.instance, [
        "executeRuntimeSql",
      ]),
    }),
  });
  return {
    database,
    objectDatabase: workspaceObject.objectDatabase,
    objectStore,
    baseEnv,
    // The env under test is the routed execution environment the harness
    // wraps before handing its tools out; with the workspace object attached,
    // the identity wrap the fixture used to get away with routes nothing.
    env: withWorkspaceRuntimeDatabase(baseEnv, WORKSPACE_ID),
  };
}

function workflowInput(): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: WORKSTREAM_ID,
    loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "Core-tool idempotency test",
  };
}

function context(providerIdempotencyKey?: string) {
  return {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: HARNESS_RUN_ID,
    toolCallId: providerIdempotencyKey ?? "tool-call-without-provider-key",
    executionPrincipal: { type: "user" as const, userId: USER_ID },
    ...(providerIdempotencyKey ? { providerIdempotencyKey } : {}),
    signal: new AbortController().signal,
  };
}

describe("Avalon connector connection tools", () => {
  it("offers a trusted connector card only to interactive user runs", async () => {
    const { env } = fixture();
    const userTool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "show_connector_connection");

    expect(userTool?.definition).toMatchObject({
      capability: "connector.connection.present",
      mode: "read",
      idempotency: "safe",
    });
    expect(userTool!.validateInput?.({ connectorId: "granola", scope: "workspace" }))
      .toBeInstanceOf(z.ZodError);
    await expect(userTool!.execute({ connectorId: "slack", scope: "personal" }, context()))
      .resolves.toEqual({
        output: { connectorId: "slack", scope: "personal" },
        summary: "Presented the slack personal connection card",
      });
    await expect(userTool!.execute({ connectorId: "granola", scope: "workspace" }, context()))
      .rejects.toThrow("does not support a workspace connection card");

    const workspaceInput = workflowInput();
    workspaceInput.executionPrincipal = { type: "workspace", workspaceId: WORKSPACE_ID };
    expect(__integrationTesting.createAvalonTools(env, workspaceInput)
      .some((candidate) => candidate.definition.name === "show_connector_connection"))
      .toBe(false);
    expect(__integrationTesting.createAvalonTools(env, workspaceInput)
      .some((candidate) => candidate.definition.name === "get_connector_connection_state"))
      .toBe(false);

    const automationInput = workflowInput();
    automationInput.automationRun = {
      schemaVersion: 1,
      automationId: asAutomationId("00000000-0000-4000-8000-000000000006"),
      definitionRevision: 1,
      runId: "00000000-0000-4000-8000-000000000007",
      trigger: { kind: "manual", requestedByUserId: USER_ID },
    };
    expect(__integrationTesting.createAvalonTools(env, automationInput)
      .some((candidate) => candidate.definition.capability.startsWith("connector.connection.")))
      .toBe(false);
  });

  it("reads the current authorized connector catalog state", async () => {
    const { env, objectDatabase } = fixture();
    const stateTool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "get_connector_connection_state");

    expect(stateTool?.definition).toMatchObject({
      capability: "connector.connection.read",
      mode: "read",
      idempotency: "safe",
    });
    await expect(stateTool!.execute({ connectorId: "google-drive", scope: "personal" }, context()))
      .resolves.toMatchObject({ output: { state: "not_connected" } });
    await expect(stateTool!.execute({ connectorId: "github", scope: "personal" }, context()))
      .resolves.toMatchObject({ output: { state: "unavailable" } });

    objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name,
          granted_scopes_json, status, created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'slack', 'workspace', NULL, 'Workspace Slack',
          ?, 'healthy', '2026-01-01', '2026-01-01', 'plugin_slack_workspace')`,
    ).run(
      "00000000-0000-4000-8000-000000000013",
      WORKSPACE_ID,
      JSON.stringify(["slack.agent"]),
    );
    await expect(stateTool!.execute({ connectorId: "slack", scope: "workspace" }, context()))
      .resolves.toMatchObject({ output: { state: "connected" } });
    // Asked about the personal scope, it still says the Organization's works.
    await expect(stateTool!.execute({ connectorId: "slack", scope: "personal" }, context()))
      .resolves.toMatchObject({ output: {
        state: "connected",
        connections: [{ scope: "personal", state: "not_connected" }, { scope: "workspace", state: "connected" }],
      } });

    objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name,
          granted_scopes_json, status, created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'google', 'personal', ?, 'Someone else Google Drive',
          ?, 'healthy', '2026-01-01', '2026-01-01', 'plugin_google_other')`,
    ).run(
      "00000000-0000-4000-8000-000000000011",
      WORKSPACE_ID,
      "00000000-0000-4000-8000-000000000099",
      JSON.stringify(["drive.read"]),
    );
    await expect(stateTool!.execute({ connectorId: "google-drive", scope: "personal" }, context()))
      .resolves.toMatchObject({ output: { state: "not_connected" } });

    objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name,
          granted_scopes_json, status, created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'google', 'personal', ?, 'Google Drive + Docs + Sheets',
          ?, 'healthy', '2026-01-01', '2026-01-01', 'plugin_google')`,
    ).run(
      "00000000-0000-4000-8000-000000000010",
      WORKSPACE_ID,
      USER_ID,
      JSON.stringify(["drive.read", "docs.read", "sheets.read"]),
    );

    await expect(stateTool!.execute({ connectorId: "google-mail-calendar", scope: "personal" }, context()))
      .resolves.toMatchObject({ output: { state: "not_connected" } });
    await expect(stateTool!.execute({ connectorId: "google-drive", scope: "personal" }, context()))
      .resolves.toEqual({
        output: {
          connectorId: "google-drive",
          state: "connected",
          connections: [{ scope: "personal", state: "connected" }, { scope: "workspace", state: "not_connected" }],
        },
        summary: "google-drive: personal connected, workspace not_connected",
      });

    objectDatabase.prepare(
      "UPDATE connector_connections SET status = 'needs_reconnect' WHERE model_plugin_id = 'plugin_google'",
    ).run();
    await expect(stateTool!.execute({ connectorId: "google-drive", scope: "personal" }, context()))
      .resolves.toMatchObject({ output: { state: "reconnect_required" } });
    objectDatabase.prepare(
      "UPDATE connector_connections SET status = 'error' WHERE model_plugin_id = 'plugin_google'",
    ).run();
    await expect(stateTool!.execute({ connectorId: "google-drive", scope: "personal" }, context()))
      .resolves.toMatchObject({ output: { state: "connected" } });

    objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name,
          granted_scopes_json, status, created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'google', 'workspace', NULL, 'Workspace Google Drive',
          ?, 'healthy', '2026-01-01', '2026-01-01', 'plugin_google_workspace')`,
    ).run(
      "00000000-0000-4000-8000-000000000012",
      WORKSPACE_ID,
      JSON.stringify(["drive.read"]),
    );
    await expect(stateTool!.execute({ connectorId: "google-drive", scope: "workspace" }, context()))
      .resolves.toMatchObject({ output: { state: "connected" } });
  });

  it("checks every scope a connector offers, whatever scope is named", async () => {
    // A person whose personal Drive was connected was asked to connect Drive,
    // because the check looked at the workspace scope alone.
    const { env, objectDatabase } = fixture();
    const stateTool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "get_connector_connection_state");
    objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name,
          granted_scopes_json, status, created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'google', 'personal', ?, 'Google Drive + Docs + Sheets',
          ?, 'healthy', '2026-01-01', '2026-01-01', 'plugin_google')`,
    ).run(
      "00000000-0000-4000-8000-000000000020",
      WORKSPACE_ID,
      USER_ID,
      JSON.stringify(["drive.read", "sheets.write"]),
    );

    await expect(stateTool!.execute({ connectorId: "google-drive" }, context()))
      .resolves.toEqual({
        output: {
          connectorId: "google-drive",
          state: "connected",
          connections: [
            { scope: "personal", state: "connected" },
            { scope: "workspace", state: "not_connected" },
          ],
        },
        summary: "google-drive: personal connected, workspace not_connected",
      });
    // What two agents asked in production: the workspace scope, by name, while
    // the person's own Drive worked. The answer must still say so.
    await expect(stateTool!.execute({ connectorId: "google-drive", scope: "workspace" }, context()))
      .resolves.toMatchObject({ output: {
        state: "connected",
        connections: [{ scope: "personal", state: "connected" }, { scope: "workspace", state: "not_connected" }],
      } });

    objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name,
          granted_scopes_json, status, created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'google', 'workspace', NULL, 'Workspace Google Drive',
          ?, 'needs_reconnect', '2026-01-01', '2026-01-01', 'plugin_google_workspace')`,
    ).run(
      "00000000-0000-4000-8000-000000000021",
      WORKSPACE_ID,
      JSON.stringify(["drive.read"]),
    );
    objectDatabase.prepare(
      "UPDATE connector_connections SET status = 'disabled' WHERE model_plugin_id = 'plugin_google'",
    ).run();
    await expect(stateTool!.execute({ connectorId: "google-drive" }, context()))
      .resolves.toMatchObject({
        output: {
          state: "reconnect_required",
          connections: [
            { scope: "personal", state: "not_connected" },
            { scope: "workspace", state: "reconnect_required" },
          ],
        },
      });
    // A personal-only connector reports the one scope it has.
    await expect(stateTool!.execute({ connectorId: "google-mail-calendar" }, context()))
      .resolves.toMatchObject({
        output: { state: "not_connected", connections: [{ scope: "personal", state: "not_connected" }] },
      });
  });

  it("returns easy-English current time in the user's configured timezone", async () => {
    const { database, env } = fixture();
    database.prepare("UPDATE users SET timezone = ? WHERE id = ?")
      .run("America/New_York", USER_ID);
    database.prepare("UPDATE workspaces SET timezone = ? WHERE id = ?")
      .run("Europe/London", WORKSPACE_ID);
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "current_time");

    expect(tool?.definition).toMatchObject({
      capability: "time.read",
      mode: "read",
      idempotency: "safe",
    });
    const result = await tool!.execute({}, context());
    const lines = String(result.output).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^current local time: \d{2}:\d{2} (AM|PM)$/u);
    expect(lines[1]).toBe("local timezone: America/New_York");
    expect(lines[2]).toBe("workspace timezone: Europe/London");
    expect(lines[3]).toMatch(/^local date: [A-Z][a-z]+ \d{1,2} \d{4}$/u);
    expect(lines[4]).toMatch(/^iso8601 timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(result.summary).toBe(result.output);
  });

  it("uses workspace time for workspace runs and validates explicit timezone overrides", async () => {
    const { database, env } = fixture();
    database.prepare("UPDATE workspaces SET timezone = ? WHERE id = ?")
      .run("Europe/London", WORKSPACE_ID);
    const workspaceInput = workflowInput();
    workspaceInput.executionPrincipal = { type: "workspace", workspaceId: WORKSPACE_ID };
    const tool = __integrationTesting.createAvalonTools(env, workspaceInput)
      .find((candidate) => candidate.definition.name === "current_time");

    const workspaceTime = await tool!.execute({}, {
      ...context(),
      executionPrincipal: workspaceInput.executionPrincipal,
    });
    expect(String(workspaceTime.output)).toContain("local timezone: Europe/London");
    expect(String(workspaceTime.output)).toContain("workspace timezone: Europe/London");

    const overrideTime = await tool!.execute({ timezone: "America/Los_Angeles" }, {
      ...context(),
      executionPrincipal: workspaceInput.executionPrincipal,
    });
    expect(String(overrideTime.output)).toContain("local timezone: America/Los_Angeles");
    expect(String(overrideTime.output)).toContain("workspace timezone: Europe/London");
    await expect(tool!.execute({ timezone: "Mars/Olympus_Mons" }, {
      ...context(),
      executionPrincipal: workspaceInput.executionPrincipal,
    })).rejects.toThrow("Invalid IANA timezone");
  });

  it("converges elicitation retries on one durable question", async () => {
    const { objectStore, baseEnv } = fixture();
    // The routed version could be raced: the existence check was a read of its
    // own in front of a three-statement batch, and this test injected a stale
    // answer to prove the `ON CONFLICT` converged anyway. The check is the
    // first statement of the authority's own transaction now, so there is no
    // window left to inject into — what is asserted instead is the outcome the
    // caller acts on: the second attempt writes nothing and announces nothing,
    // and the first attempt's question is still the only one.
    const roomEvents: Array<Record<string, unknown>> = [];
    const env = createTestEnv({
        ...baseEnv,
        SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore, { roomEvents }),
      });
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "request_elicitation");
    expect(tool?.definition.idempotency).toBe("provider_key");
    expect(tool?.definition.inputSchema).not.toHaveProperty("properties.targetUserId");

    const args = {
      prompt: "Which environment should Avalon deploy?",
      responseType: "single_select",
      options: [
        { value: "staging", label: "Staging", description: null },
        { value: "production", label: "Production", description: null },
      ],
      minimumSelections: 1,
      maximumSelections: 1,
    };
    const first = await tool!.execute(args, context("run:turn:2:tool:0"));
    const second = await tool!.execute(args, context("run:turn:2:tool:0"));

    expect(second).toEqual(first);
    expect(first).toMatchObject({ halt: "needs_input" });
    expect(roomEvents.filter((event) => event.type === "elicitation_created")).toHaveLength(1);
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM elicitation_requests")).toEqual({ count: 1 });
    expect(workstreamObjectGet(objectStore, "SELECT target_user_id FROM elicitation_requests")).toEqual({ target_user_id: null });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE message_type = 'elicitation'",
    )).toEqual({ count: 1 });
    // `next_attention_ordinal` is the object's own counter; the retired view
    // rendered it as `latest_attention_sequence_number = next_attention_ordinal - 1`.
    expect(workstreamObjectRootRow(
      objectStore,
      "exact_state, next_sequence_number, next_attention_ordinal",
    )).toEqual({
      exact_state: "needs_input",
      next_sequence_number: 2,
      next_attention_ordinal: 2,
    });
  });

  it("announces a breakout's question in the breakout's room, not the Channel's", async () => {
    const { objectStore, baseEnv } = fixture();
    const roomEvents: Array<{ room: string; event: Record<string, unknown> }> = [];
    const agents = testSubstreamAgentsBinding(objectStore);
    const env = createTestEnv({
      ...baseEnv,
      SUBSTREAM_AGENTS: createCloudflareTestBinding<DurableObjectNamespace>({
        idFromName: (name: string) => agents.idFromName(name),
        get: (id: DurableObjectId) => ({
          ...agents.get(id),
          publishEvent: (input: { event: Record<string, unknown> }) => {
            roomEvents.push({ room: String(id), event: input.event });
            return { status: 204, bodyJson: "null" };
          },
        }),
        jurisdiction: () => agents,
      }),
    });
    const tool = __integrationTesting.createAvalonTools(env, { ...workflowInput(), substreamId: BREAKOUT_ID })
      .find((candidate) => candidate.definition.name === "request_elicitation");

    await tool!.execute(
      { prompt: "What should I do with rain?", responseType: "text" },
      context("run:turn:3:tool:0"),
    );

    expect(roomEvents.filter(({ event }) => event.type === "elicitation_created").map(({ room }) => room))
      .toEqual([`global:${WORKSPACE_ID}:${WORKSTREAM_ID}:${BREAKOUT_ID}`]);
  });

  it("refuses to execute provider-key writes without the receipt-derived key", async () => {
    const { env } = fixture();
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "request_elicitation");

    await expect(tool!.execute(
      { prompt: "No receipt", responseType: "text" },
      context(),
    )).rejects.toThrow("requires a durable provider idempotency key");
  });
});
