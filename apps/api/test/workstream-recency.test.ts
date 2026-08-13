import { WorkstreamDetailSchema } from "@avalon/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoAppEnv } from "../src/env";
import { workstreamRoutes } from "../src/routes/workstreams";
import type { GlobalWorkstreamEmailRouterRpcBinding } from "../src/services/workstream-email-routing-service";
import { WorkstreamService } from "../src/services/workstream-service";
import { createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const EMAIL_DOMAIN = "automation.with-avalon.com";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000003";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000004";

describe("work-stream recency ordering", () => {
  it("opens a healthy work stream with one combined visibility lookup", async () => {
    const row = contractWorkstreamRow();
    const sqlStatements: string[] = [];
    const prepare = vi.fn((sql: string) => {
      sqlStatements.push(sql);
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => sql.includes("SELECT w.*, t.name AS origin_label") ? row : null),
        all: vi.fn(async () => ({ success: true, results: [] })),
      };
      return statement;
    });
    const service = new WorkstreamService(
      createTestEnv({
        APP_ENV: "production",
        AVALON_REGION: "global",
        DB: { prepare, batch: vi.fn() },
      }),
      { workspaceId: WORKSPACE_ID, userId: USER_ID } as never,
    );

    await expect(service.get(WORKSTREAM_ID)).resolves.toMatchObject({ id: WORKSTREAM_ID });

    expect(sqlStatements.filter((sql) => sql.includes("SELECT w.*, t.name AS origin_label"))).toHaveLength(1);
    expect(sqlStatements.some((sql) => sql.includes("SELECT email_address, email_route_status, archived_at"))).toBe(false);
  });

  it("includes the model-facing plugin id in embedded work-stream connections", async () => {
    const row = contractWorkstreamRow();
    const connection = contractConnectionRow();
    const prepare = vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => sql.includes("SELECT w.*, t.name AS origin_label") ? row : null),
        all: vi.fn(async () => ({
          success: true,
          results: sql.includes("FROM connector_connections c") ? [connection] : [],
        })),
      };
      return statement;
    });
    const service = new WorkstreamService(
      createTestEnv({
        APP_ENV: "production",
        AVALON_REGION: "global",
        DB: { prepare, batch: vi.fn() },
      }),
      { workspaceId: WORKSPACE_ID, userId: USER_ID } as never,
    );

    const detail = await service.get(WORKSTREAM_ID);

    expect(detail.connections).toEqual([
      expect.objectContaining({ id: CONNECTION_ID, modelPluginId: "plugin_google" }),
    ]);
  });

  it("serves a GET work-stream response that satisfies the released wire contract", async () => {
    const row = contractWorkstreamRow();
    const connection = contractConnectionRow();
    const prepare = vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => sql.includes("SELECT w.*, t.name AS origin_label") ? row : null),
        all: vi.fn(async () => ({
          success: true,
          results: sql.includes("FROM connector_connections c") ? [connection] : [],
        })),
      };
      return statement;
    });
    const environment = createTestEnv({
      APP_ENV: "production",
      AVALON_REGION: "global",
      DB: { prepare, batch: vi.fn() },
    });
    const app = new Hono<HonoAppEnv>();
    app.use("*", async (context, next) => {
      context.set("auth", {
        sessionId: "test-session",
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        region: "global",
        role: "owner",
      });
      await next();
    });
    app.route("/workstreams", workstreamRoutes);

    const response = await app.request(`/workstreams/${WORKSTREAM_ID}`, undefined, environment);

    expect(response.status).toBe(200);
    expect(WorkstreamDetailSchema.parse(await response.json()).connections).toEqual([
      expect.objectContaining({ id: CONNECTION_ID, modelPluginId: "plugin_google" }),
    ]);
  });

  it("rejects a connection row that violates the wire contract", async () => {
    const row = contractWorkstreamRow();
    const connection = {
      ...contractConnectionRow(),
      model_plugin_id: null,
    };
    const prepare = vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => sql.includes("SELECT w.*, t.name AS origin_label") ? row : null),
        all: vi.fn(async () => ({
          success: true,
          results: sql.includes("FROM connector_connections c") ? [connection] : [],
        })),
      };
      return statement;
    });
    const service = new WorkstreamService(
      createTestEnv({
        APP_ENV: "production",
        AVALON_REGION: "global",
        DB: { prepare, batch: vi.fn() },
      }),
      { workspaceId: WORKSPACE_ID, userId: USER_ID } as never,
    );

    await expect(service.get(WORKSTREAM_ID)).rejects.toThrow();
  });

  function contractConnectionRow() {
    return {
      id: CONNECTION_ID,
      model_plugin_id: "plugin_google",
      workspace_id: WORKSPACE_ID,
      connector_type: "google",
      scope: "workspace",
      owner_user_id: null,
      owner_name: null,
      display_name: "Google Workspace",
      granted_scopes_json: "[]",
      status: "healthy",
      last_sync_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
    };
  }

  it("selects the latest activity before applying the page limit", async () => {
    const statement = {
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ success: true, results: [] })
    };
    const prepare = vi.fn().mockReturnValue(statement);
    const service = new WorkstreamService(
      { DB: { prepare, batch: vi.fn() } } as never,
      { workspaceId: "workspace-1", userId: "user-1" } as never
    );

    await service.list(25);

    const sql = String(prepare.mock.calls[0]?.[0]);
    expect(sql).toContain("ORDER BY w.last_activity_at DESC LIMIT ?");
    expect(sql).not.toContain("ORDER BY CASE");
  });

  it("backfills every legacy EU row with one Global service-binding call", async () => {
    const pendingAddress = `gentle-clear-ready-heron@${EMAIL_DOMAIN}`;
    const pendingRow = workstreamRow("workstream-pending", pendingAddress, "2026-08-02T01:30:00.000Z");
    pendingRow.email_route_status = "reserved";
    const rows = [
      workstreamRow("workstream-1", null, "2026-08-02T03:00:00.000Z"),
      workstreamRow("workstream-existing", `calm-bright-ready-otter@${EMAIL_DOMAIN}`, "2026-08-02T02:00:00.000Z"),
      pendingRow,
      workstreamRow("workstream-2", null, "2026-08-02T01:00:00.000Z"),
    ];
    const prepared = new Map<object, { sql: string; values: unknown[] }>();
    const prepare = vi.fn((sql: string) => {
      const record = { sql, values: [] as unknown[] };
      const statement = {
        bind: vi.fn((...values: unknown[]) => {
          record.values = values;
          return statement;
        }),
        // Nothing is pinned here, so the read that collects the viewer's pins
        // answers with nothing. This fixture otherwise returns `rows` for every
        // statement, which would hand the listing each row a second time.
        all: vi.fn(async () => ({
          success: true,
          results: sql.includes("pin.user_id IS NOT NULL") ? [] : rows,
        })),
      };
      prepared.set(statement, record);
      return statement;
    });
    const batch = vi.fn(async (statements: object[]) => statements.map((statement) => {
      const record = prepared.get(statement)!;
      if (record.sql.includes("SET email_address = ?")) {
        const [emailAddress, updatedAt, workstreamId, workspaceId] = record.values.map(String);
        const row = rows.find((candidate) =>
          candidate.id === workstreamId && candidate.workspace_id === workspaceId);
        if (row && row.email_address == null) {
          row.email_address = emailAddress!;
          row.email_route_status = "reserved";
          row.updated_at = updatedAt!;
          return d1Result(1);
        }
        return d1Result(0);
      }
      if (record.sql.includes("SET email_route_status = 'active'")) {
        const [updatedAt, workstreamId, workspaceId, emailAddress] = record.values.map(String);
        const row = rows.find((candidate) =>
          candidate.id === workstreamId
          && candidate.workspace_id === workspaceId
          && candidate.email_address?.toLowerCase() === emailAddress?.toLowerCase());
        if (row && row.archived_at == null) {
          row.email_route_status = "active";
          row.updated_at = updatedAt!;
          return d1Result(1);
        }
        return d1Result(0);
      }
      if (record.sql.includes("SELECT email_address, email_route_status, archived_at")) {
        const [workstreamId, workspaceId] = record.values.map(String);
        const row = rows.find((candidate) =>
          candidate.id === workstreamId && candidate.workspace_id === workspaceId);
        return d1Result(0, row ? [{
          email_address: row.email_address,
          email_route_status: row.email_route_status,
          archived_at: row.archived_at,
        }] : []);
      }
      throw new Error(`Unexpected batch query: ${record.sql}`);
    }));
    const reservationInputs = [
      { region: "eu" as const, workspaceId: "workspace-1", workstreamId: "workstream-1" },
      { region: "eu" as const, workspaceId: "workspace-1", workstreamId: "workstream-2" },
    ];
    const activationInputs = [
      reservationInputs[0]!,
      { region: "eu" as const, workspaceId: "workspace-1", workstreamId: "workstream-pending" },
      reservationInputs[1]!,
    ];
    const routes = reservationInputs.map((input, index) => ({
      ...input,
      localPart: index === 0 ? "calm-bright-ready-heron" : "clear-kind-steady-otter",
      emailAddress: `${index === 0 ? "calm-bright-ready-heron" : "clear-kind-steady-otter"}@${EMAIL_DOMAIN}`,
      status: "reserved" as const,
    }));
    const reserve = vi.fn();
    const reserveMany = vi.fn(async () => ({ ok: true as const, value: routes }));
    const activateMany = vi.fn(async () => ({ ok: true as const, value: { ok: true as const } }));
    const globalRouter = {
      ping: vi.fn(),
      reserve,
      reserveMany,
      activateMany,
      setStatus: vi.fn(),
    } satisfies GlobalWorkstreamEmailRouterRpcBinding;
    const service = new WorkstreamService(
      createTestEnv({
        APP_ENV: "production",
        AVALON_REGION: "eu",
        DB: { prepare, batch },
        GLOBAL_EMAIL_ROUTER: globalRouter,
      }),
      { workspaceId: "workspace-1", userId: "user-1" } as never,
    );

    const page = await service.list(25);

    expect(reserveMany).toHaveBeenCalledExactlyOnceWith(reservationInputs);
    expect(activateMany).toHaveBeenCalledExactlyOnceWith(activationInputs);
    expect(reserve).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(5);
    expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual([3, 2, 3, 3, 3]);
    expect(page.items.map((item) => item.emailAddress)).toEqual([
      routes[0]!.emailAddress,
      `calm-bright-ready-otter@${EMAIL_DOMAIN}`,
      pendingAddress,
      routes[1]!.emailAddress,
    ]);
  });
});

function workstreamRow(id: string, emailAddress: string | null, lastActivityAt: string) {
  return {
    id,
    workspace_id: "workspace-1",
    title: id,
    objective: "",
    email_address: emailAddress,
    email_route_status: emailAddress ? "active" : "reserved",
    origin_type: "ad_hoc",
    origin_label: null,
    created_by_user_id: "user-1",
    automation_subscription_id: null,
    automation_run_id: null,
    planned_for: null,
    harness_status: "idle",
    last_activity_at: lastActivityAt,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    archived_at: null,
    // `SELECT w.*` returns every column, and these are NOT NULL with a default
    // in `workstreams`, so no real row can omit them. The fixture did, and the
    // reader's old hand-coercion silently produced "workspace", "settled" and 0
    // for the absent ones rather than saying the row was wrong.
    scope: "workspace",
    system_kind: null,
    title_status: "settled",
    latest_attention_sequence_number: 0,
    unread_tracking_start_sequence_number: 0,
    // The viewer projection joins the next pending wake-up; these rows stand in
    // for the completed SELECT rather than just for the workstreams table.
    next_pending_wakeup_at: null,
    next_pending_wakeup_prompt_prefix: null,
  };
}

function contractWorkstreamRow() {
  return {
    ...workstreamRow(WORKSTREAM_ID, `calm-bright-ready-otter@${EMAIL_DOMAIN}`, "2026-08-02T03:00:00.000Z"),
    workspace_id: WORKSPACE_ID,
    created_by_user_id: USER_ID,
  };
}

function d1Result<T>(changes: number, results: T[] = []): D1Result<T> {
  return createTestD1Result<T>({
    success: true,
    results,
    meta: { changes },
  });
}
