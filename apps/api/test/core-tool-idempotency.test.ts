import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";

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

class MemoryBucket {
  readonly objects = new Map<string, string>();
  readonly puts: string[] = [];
  failAfterNextPut = false;

  async put(key: string, value: string): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, value);
    if (this.failAfterNextPut) {
      this.failAfterNextPut = false;
      throw new DOMException("The storage request timed out", "TimeoutError");
    }
  }
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(): { database: DatabaseSync; env: Env; bucket: MemoryBucket } {
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
  const bucket = new MemoryBucket();
  return {
    database,
    bucket,
    env: {
      DB: sqliteD1(database),
      PAYLOADS: bucket as unknown as R2Bucket,
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
  it("converges artifact retries on one deterministic D1 row and R2 object", async () => {
    const { database, env, bucket } = fixture();
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "avalon.create_artifact");
    expect(tool?.definition.idempotency).toBe("provider_key");

    const args = { title: "Release notes", artifactType: "markdown", content: "Shipped once." };
    const first = await tool!.execute(args, context("run:turn:1:tool:0"));
    const second = await tool!.execute(args, context("run:turn:1:tool:0"));

    expect(second).toEqual(first);
    expect(first.providerOperationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 1 });
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.objects.get(bucket.puts[0]!)).toBe("Shipped once.");
  });

  it("safely retries an artifact write whose R2 timeout may have followed persistence", async () => {
    const { database, env, bucket } = fixture();
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "avalon.create_artifact");
    const args = { title: "Timeout-safe", artifactType: "text", content: "One logical object." };
    const toolContext = context("run:turn:1:tool:timeout");
    bucket.failAfterNextPut = true;

    await expect(tool!.execute(args, toolContext)).rejects.toMatchObject({ name: "TimeoutError" });
    const retried = await tool!.execute(args, toolContext);

    expect(retried.providerOperationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(new Set(bucket.puts)).toHaveLength(1);
    expect(bucket.objects.size).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({ count: 1 });
  });

  it("converges elicitation retries on one durable question", async () => {
    const { database, env } = fixture();
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "avalon.request_elicitation");
    expect(tool?.definition.idempotency).toBe("provider_key");

    const args = {
      prompt: "Which environment should Avalon deploy?",
      responseType: "single_select",
      options: [
        { value: "staging", label: "Staging", description: null },
        { value: "production", label: "Production", description: null },
      ],
      minimumSelections: 1,
      maximumSelections: 1,
      targetUserId: null,
    };
    const first = await tool!.execute(args, context("run:turn:2:tool:0"));
    const second = await tool!.execute(args, context("run:turn:2:tool:0"));

    expect(second).toEqual(first);
    expect(first).toMatchObject({ halt: "needs_input" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM elicitations").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT harness_status FROM workstreams WHERE id = ?").get(WORKSTREAM_ID))
      .toEqual({ harness_status: "needs_input" });
  });

  it("refuses to execute provider-key writes without the receipt-derived key", async () => {
    const { env } = fixture();
    const tool = __integrationTesting.createAvalonTools(env, workflowInput())
      .find((candidate) => candidate.definition.name === "avalon.create_artifact");

    await expect(tool!.execute(
      { title: "Unsafe", artifactType: "text", content: "No receipt" },
      context(),
    )).rejects.toThrow("requires a durable provider idempotency key");
  });
});
