import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { asWorkspaceId, type BlockDashboard, type BlockDashboardBlockRun } from "@rally/contracts";
import type { Env } from "../src/env";
import { BlockDashboardService, launchBlockDashboardRefresh } from "../src/services/block-dashboard-service";
import { createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000401");
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
  requests: Array<Record<string, unknown>>;
} {
  const database = legacyProductSqliteDatabase();
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('${OWNER_ID}', 'block-dashboard-owner', 'owner-block-dashboard@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('${MEMBER_ID}', 'block-dashboard-member', 'member-block-dashboard@example.com', 'Member', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'HyperSight', 'block-dashboard-service', 'global', '${OWNER_ID}', '2026-01-01', '2026-01-01');
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
  const requests: Array<Record<string, unknown>> = [];
  let blockDashboard: BlockDashboard = { versionId: null, versionNumber: 0, blocks: [], updatedAt: null };
  const preferences = new Map<string, { visible: boolean; updatedAt: string | null }>();
  const run: BlockDashboardBlockRun = {
    id: "00000000-0000-4000-8000-000000000406",
    blockId: BLOCK_ID,
    configurationVersionId: "00000000-0000-4000-8000-000000000407",
    triggerSequence: 42,
    status: "queued",
    markdown: null,
    error: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (body.operation === "get") return Response.json({ blockDashboard });
    if (body.operation === "get_preference") {
      return Response.json({
        preference: preferences.get(String(body.userId)) ?? { visible: false, updatedAt: null },
      });
    }
    if (body.operation === "update_preference") {
      const preference = { visible: Boolean(body.visible), updatedAt: String(body.updatedAt) };
      preferences.set(String(body.userId), preference);
      return Response.json({ preference });
    }
    if (body.operation === "update_configuration") {
      const input = body.input as { expectedVersionNumber: number; blocks: Array<{ id: string; prompt: string }> };
      if (input.expectedVersionNumber !== blockDashboard.versionNumber) {
        return Response.json({ error: "block_dashboard_version_conflict" }, { status: 409 });
      }
      blockDashboard = {
        versionId: String(body.configurationVersionId),
        versionNumber: blockDashboard.versionNumber + 1,
        blocks: input.blocks.map((block) => ({ ...block, latestRun: null })),
        updatedAt: String(body.createdAt),
      };
      return Response.json({ blockDashboard, runs: [] });
    }
    return Response.json({ runs: [run] });
  });
  const controlBlockDashboard = vi.fn(async (body: Record<string, unknown>) => {
    const response = await fetch("https://workstream.internal/block-dashboard", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { status: response.status, bodyJson: await response.text() };
  });
  const namespace = {
    idFromName: vi.fn(() => ({ toString: () => "workstream-do-id" })),
    get: vi.fn(() => ({ controlBlockDashboard })),
  };
  const workspaceNamespace = {
    idFromName: vi.fn(() => ({ toString: () => "workspace-do-id" })),
    get: vi.fn(() => ({ canReadWorkstream: vi.fn(async () => true) })),
  };
  const env = createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: { prepare },
    WORKSTREAM_DOS: namespace,
    WORKSPACE_DOS: workspaceNamespace,
  });
  return { database, env, requests };
}

describe("BlockDashboardService", () => {
  it("stores shared configuration and personal visibility through WorkstreamDO", async () => {
    const { database, env, requests } = fixture();
    const owner = new BlockDashboardService(env, { workspaceId: WORKSPACE_ID, userId: OWNER_ID } as never);
    const member = new BlockDashboardService(env, { workspaceId: WORKSPACE_ID, userId: MEMBER_ID } as never);

    await expect(owner.get(WORKSTREAM_ID)).resolves.toMatchObject({ versionNumber: 0 });
    const first = await owner.update(WORKSTREAM_ID, {
      expectedVersionNumber: 0,
      blocks: [{ id: BLOCK_ID, prompt: "Summarize" }],
    });
    await expect(member.get(WORKSTREAM_ID)).resolves.toEqual(first);
    await expect(owner.update(WORKSTREAM_ID, {
      expectedVersionNumber: 0,
      blocks: [],
    })).rejects.toMatchObject({ status: 409, code: "block_dashboard_version_conflict" });

    // Read through the detail path now: the preference has no REST route of its
    // own, and is answered on `GET /workstreams/:id` and the control socket's
    // boot frame instead.
    await expect(owner.preferenceForDetail(WORKSTREAM_ID)).resolves.toEqual({ visible: false, updatedAt: null });
    const visible = await owner.updatePreference(WORKSTREAM_ID, { visible: true });
    await expect(owner.preferenceForDetail(WORKSTREAM_ID)).resolves.toEqual(visible);
    // Still per viewer: one person opening the panel does not open it for another.
    await expect(member.preferenceForDetail(WORKSTREAM_ID)).resolves.toEqual({ visible: false, updatedAt: null });
    expect(requests.map((request) => request.operation)).toEqual(expect.arrayContaining([
      "get",
      "update_configuration",
      "get_preference",
      "update_preference",
    ]));
    database.close();
  });

  it("asks WorkstreamDO to fan out one fenced refresh", async () => {
    const { database, env, requests } = fixture();
    const contextFence = { throughSequence: 42, compaction: null } as const;
    await expect(launchBlockDashboardRefresh(
      env,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      51,
      contextFence,
    )).resolves.toEqual([
      expect.objectContaining({ blockId: BLOCK_ID, triggerSequence: 42, status: "queued" }),
    ]);
    expect(requests.at(-1)).toMatchObject({
      operation: "schedule_refresh",
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      triggerSequence: 51,
      contextFence,
    });
    database.close();
  });

  it("does not let an unavailable preference fail the work-stream open", async () => {
    // The preference now rides on `GET /workstreams/:id`, beside the room call
    // that answers the detail and the transcript. Before, it was a request of
    // its own and could fail on its own; sharing a response is what made the
    // route able to lose the whole open over an optional panel flag.
    const { env, database } = fixture();
    (env.WORKSTREAM_DOS as unknown as { get: () => unknown }).get = () => ({
      controlBlockDashboard: async () => {
        throw new Error("workstream_do_unavailable");
      },
    });
    const service = new BlockDashboardService(
      env,
      { workspaceId: WORKSPACE_ID, userId: OWNER_ID } as never,
    );

    await expect(service.preferenceForDetail(WORKSTREAM_ID)).rejects.toThrow();
    // The route swallows exactly that rejection, so the field is omitted and
    // the detail still answers. Asserted here rather than only in the route so
    // the reason the `catch` exists is written down beside the thing it guards.
    await expect(
      service.preferenceForDetail(WORKSTREAM_ID).catch(() => undefined),
    ).resolves.toBeUndefined();
    database.close();
  });
});
