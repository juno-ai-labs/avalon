import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { HYPERSIGHT_MODEL, type Env } from "../src/env";
import { HyperSightService, launchHyperSightRefresh } from "../src/services/hypersight-service";
import { createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000401";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000402";
const OWNER_ID = "00000000-0000-4000-8000-000000000403";
const MEMBER_ID = "00000000-0000-4000-8000-000000000404";
const BLOCK_ID = "00000000-0000-4000-8000-000000000405";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<unknown>({ success: true, meta: { changes: Number(result.changes) } });
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>({
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: { changes: 0 },
    });
  }
}

function fixture(): {
  database: DatabaseSync;
  env: Env;
  publish: ReturnType<typeof vi.fn>;
  startWorkflow: ReturnType<typeof vi.fn>;
} {
  const database = new DatabaseSync(":memory:");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('${OWNER_ID}', 'hypersight-owner', 'owner-hypersight@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('${MEMBER_ID}', 'hypersight-member', 'member-hypersight@example.com', 'Member', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'HyperSight', 'hypersight-service', 'global', '${OWNER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('${WORKSPACE_ID}', '${OWNER_ID}', 'owner', 'active', '2026-01-01'),
      ('${WORKSPACE_ID}', '${MEMBER_ID}', 'member', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Shared panel', 'Test shared state',
            'ad_hoc', '${OWNER_ID}', 'idle', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  const prepare = (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql)));
  const batch = async (statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> => {
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
  };
  const publish = vi.fn(async () => new Response(null, { status: 202 }));
  const startWorkflow = vi.fn(async () => ({ id: "workflow" }));
  const namespace = {
    idFromName: vi.fn(() => ({ toString: () => "room-id" })),
    get: vi.fn(() => ({ fetch: publish })),
  };
  const env = createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: { prepare, batch },
    WORKSTREAM_ROOMS: namespace,
    WORKSTREAM_LOOP_WORKFLOW: { create: startWorkflow },
  });
  return { database, env, publish, startWorkflow };
}

describe("HyperSightService", () => {
  it("stores one personal visibility preference per user and syncs updates", async () => {
    const { database, env, publish } = fixture();
    const owner = new HyperSightService(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID } as never);
    const member = new HyperSightService(env, { workspaceId: WORKSPACE_ID, userId: MEMBER_ID } as never);

    await expect(owner.getPreference(WORKSTREAM_ID)).resolves.toEqual({ visible: false, updatedAt: null });
    await expect(member.getPreference(WORKSTREAM_ID)).resolves.toEqual({ visible: false, updatedAt: null });
    const visible = await owner.updatePreference(WORKSTREAM_ID, { visible: true });
    expect(visible).toMatchObject({ visible: true, updatedAt: expect.any(String) });
    await expect(owner.getPreference(WORKSTREAM_ID)).resolves.toEqual(visible);
    await expect(member.getPreference(WORKSTREAM_ID)).resolves.toEqual({ visible: false, updatedAt: null });

    const hidden = await owner.updatePreference(WORKSTREAM_ID, { visible: false });
    await expect(owner.getPreference(WORKSTREAM_ID)).resolves.toEqual(hidden);
    expect(database.prepare(
      "SELECT user_id, visible FROM hypersight_user_preferences WHERE workstream_id = ?",
    ).all(WORKSTREAM_ID)).toEqual([{ user_id: OWNER_ID, visible: 0 }]);
    expect(publish).toHaveBeenLastCalledWith(
      "https://room.internal/internal/events",
      expect.objectContaining({
        body: JSON.stringify({
          event: {
            type: "hypersight_preference_updated",
            preference: hidden,
          },
          audienceUserId: OWNER_ID,
        }),
      }),
    );
    database.close();
  });

  it("shares the latest configuration while retaining every prior version", async () => {
    const { database, env, publish } = fixture();
    const owner = new HyperSightService(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID } as never);
    const member = new HyperSightService(env, { workspaceId: WORKSPACE_ID, userId: MEMBER_ID } as never);

    await expect(member.get(WORKSTREAM_ID)).resolves.toEqual({
      versionId: null,
      versionNumber: 0,
      blocks: [],
      updatedAt: null,
    });
    const first = await owner.update(WORKSTREAM_ID, {
      expectedVersionNumber: 0,
      blocks: [{ id: BLOCK_ID, prompt: "Summarize the latest decision" }],
    });
    expect(first).toMatchObject({
      versionNumber: 1,
      blocks: [{ id: BLOCK_ID, prompt: "Summarize the latest decision", latestRun: null }],
    });
    const second = await member.update(WORKSTREAM_ID, {
      expectedVersionNumber: 1,
      blocks: [{ id: BLOCK_ID, prompt: "List the last five decisions" }],
    });
    expect(second.versionNumber).toBe(2);
    await expect(owner.get(WORKSTREAM_ID)).resolves.toEqual(second);

    const versions = database.prepare(
      `SELECT version_number, blocks_json, created_by_user_id
         FROM hypersight_configuration_versions
        WHERE workstream_id = ? ORDER BY version_number`,
    ).all(WORKSTREAM_ID);
    expect(versions).toEqual([
      {
        version_number: 1,
        blocks_json: `[{"id":"${BLOCK_ID}","prompt":"Summarize the latest decision"}]`,
        created_by_user_id: OWNER_ID,
      },
      {
        version_number: 2,
        blocks_json: `[{"id":"${BLOCK_ID}","prompt":"List the last five decisions"}]`,
        created_by_user_id: MEMBER_ID,
      },
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("rejects an optimistic update against a stale version", async () => {
    const { database, env } = fixture();
    const service = new HyperSightService(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID } as never);
    await service.update(WORKSTREAM_ID, {
      expectedVersionNumber: 0,
      blocks: [{ id: BLOCK_ID, prompt: "Summarize" }],
    });

    await expect(service.update(WORKSTREAM_ID, {
      expectedVersionNumber: 0,
      blocks: [{ id: BLOCK_ID, prompt: "Overwrite someone else's change" }],
    })).rejects.toMatchObject({ status: 409, code: "hypersight_version_conflict" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM hypersight_configuration_versions WHERE workstream_id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ count: 1 });
    database.close();
  });

  it("launches one debounced 4.3 agent run per prompted block and deduplicates a trigger", async () => {
    const { database, env, startWorkflow } = fixture();
    const service = new HyperSightService(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID } as never);
    await service.update(WORKSTREAM_ID, {
      expectedVersionNumber: 0,
      blocks: [
        { id: BLOCK_ID, prompt: "Summarize" },
        { id: "00000000-0000-4000-8000-000000000406", prompt: "" },
      ],
    });

    const launched = await launchHyperSightRefresh(env, WORKSPACE_ID, WORKSTREAM_ID, 42);
    expect(launched).toEqual([
      expect.objectContaining({ blockId: BLOCK_ID, triggerSequence: 42, status: "queued" }),
    ]);
    expect(startWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        reason: "hypersight_block",
        executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
      }),
    }));
    const link = database.prepare(
      "SELECT harness_run_id FROM hypersight_block_runs WHERE id = ?",
    ).get(launched[0]!.id) as { harness_run_id: string };
    expect(database.prepare(
      "SELECT origin, model, execution_principal_json FROM harness_runs WHERE id = ?",
    ).get(link.harness_run_id)).toEqual({
      origin: "hypersight_block",
      model: HYPERSIGHT_MODEL,
      execution_principal_json: `{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}`,
    });
    await expect(launchHyperSightRefresh(env, WORKSPACE_ID, WORKSTREAM_ID, 42)).resolves.toEqual([]);
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    database.close();
  });
});
