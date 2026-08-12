import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { NoteService } from "../src/services/note-service";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const USER_ID = "00000000-0000-4000-8000-000000000000";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const HARNESS_RUN_ID = "00000000-0000-4000-8000-000000000003";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return { success: true, meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: { changes: 0 },
    } as unknown as D1Result<T>;
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new SqliteD1Statement(database.prepare(sql)) as unknown as D1PreparedStatement,
    batch: async (statements: D1PreparedStatement[]) => {
      const results: D1Result<unknown>[] = [];
      database.exec("BEGIN");
      try {
        for (const statement of statements) {
          results.push(await (statement as unknown as SqliteD1Statement).run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

/**
 * Enough of R2 for the tools under test to read what they wrote. It carried
 * put-recording and a timeout injector for `create_artifact`, which was the one
 * provider-key tool that wrote an object before its row; no tool here writes R2
 * any more, so asserting on puts would only be asserting on this class.
 */
class MemoryBucket {
  private readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ text: () => Promise<string> } | null> {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(): { database: DatabaseSync; env: Env } {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
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
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES ('${HARNESS_RUN_ID}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'test',
            '{"type":"user","userId":"${USER_ID}"}', 'running', '2026-08-03');
  `);
  return {
    database,
    env: {
      DB: sqliteD1(database),
      PAYLOADS: new MemoryBucket() as unknown as R2Bucket,
      AVALON_REGION: "global",
      APP_ENV: "test",
    } as Env,
  };
}

function workflowInput(): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    automationSubscriptionId: null,
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

describe("Avalon core write-tool idempotency", () => {
  it("revokes private note access from workspace-principal resource tools", async () => {
    const { database, env } = fixture();
    const noteService = new NoteService(env, {
      sessionId: "note-owner-session",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "owner",
    });
    const note = await noteService.create({
      id: "00000000-0000-4000-8000-000000000010",
      title: "Sensitive note",
      scope: "personal",
    });
    database.prepare(
      `INSERT INTO workstream_resources
       (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
       VALUES (?, ?, ?, 0, 'context', ?)`,
    ).run(WORKSTREAM_ID, note.resourceId, USER_ID, "2026-08-07T18:00:00.000Z");
    const workspaceInput = workflowInput();
    workspaceInput.executionPrincipal = { type: "workspace", workspaceId: WORKSPACE_ID };
    const tools = __integrationTesting.createAvalonTools(env, workspaceInput);
    const read = tools.find((tool) => tool.definition.name === "read")!;
    const readResource = tools.find((tool) => tool.definition.name === "read_resource")!;

    await expect(read.execute({}, context())).resolves.toMatchObject({
      output: { attachedResources: [] },
    });
    await expect(readResource.execute({ resourceId: note.resourceId }, context()))
      .rejects.toThrow("Attached resource content is not hydrated");

    await noteService.update(note.id, { scope: "workspace" });
    const visible = await read.execute({}, context());
    expect(visible.output).toMatchObject({
      attachedResources: [expect.objectContaining({ id: note.resourceId, title: "Sensitive note" })],
    });
    await expect(readResource.execute({ resourceId: note.resourceId }, context()))
      .resolves.toMatchObject({ output: expect.objectContaining({ title: "Sensitive note" }) });

    await noteService.update(note.id, { scope: "personal" });
    await expect(readResource.execute({ resourceId: note.resourceId }, context()))
      .rejects.toThrow("Attached resource content is not hydrated");

    const ownerReadResource = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((tool) => tool.definition.name === "read_resource")!;
    await expect(ownerReadResource.execute({ resourceId: note.resourceId }, context()))
      .resolves.toMatchObject({ output: expect.objectContaining({ title: "Sensitive note" }) });

    database.prepare("UPDATE notes SET archived_at = ? WHERE id = ?")
      .run("2026-08-07T19:00:00.000Z", note.id);
    await expect(ownerReadResource.execute({ resourceId: note.resourceId }, context()))
      .rejects.toThrow("Attached resource content is not hydrated");
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
    const { database, env } = fixture();
    const databaseBinding = env.DB;
    let staleExistenceChecks = 0;
    const staleExistenceEnv = {
      ...env,
      DB: {
        prepare: (sql: string) => {
          if (sql.includes("SELECT id FROM elicitations")) {
            staleExistenceChecks += 1;
            const statement = {
              bind: () => statement,
              first: async () => null,
            };
            return statement as unknown as D1PreparedStatement;
          }
          return databaseBinding.prepare(sql);
        },
        batch: databaseBinding.batch.bind(databaseBinding),
      } as D1Database,
    } as Env;
    const tool = __integrationTesting.createAvalonTools(staleExistenceEnv, workflowInput())
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

    expect(staleExistenceChecks).toBe(2);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ halt: "needs_input" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM elicitations").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT target_user_id FROM elicitations").get()).toEqual({ target_user_id: null });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE message_type = 'elicitation'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      `SELECT harness_status, next_sequence_number, latest_attention_sequence_number
       FROM workstreams WHERE id = ?`,
    ).get(WORKSTREAM_ID)).toEqual({
      harness_status: "needs_input",
      next_sequence_number: 2,
      latest_attention_sequence_number: 1,
    });
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
