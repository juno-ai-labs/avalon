import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { GlobalWorkstreamEmailRouterRpcBinding } from "../src/services/workstream-email-routing-service";
import { WorkstreamService } from "../src/services/workstream-service";

const EMAIL_DOMAIN = "automation.with-avalon.com";

describe("work-stream recency ordering", () => {
  it("opens a healthy work stream with one combined visibility lookup", async () => {
    const row = workstreamRow("workstream-1", `calm-bright-ready-otter@${EMAIL_DOMAIN}`, "2026-08-02T03:00:00.000Z");
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
      {
        APP_ENV: "production",
        AVALON_REGION: "global",
        DB: { prepare, batch: vi.fn() },
      } as unknown as Env,
      { workspaceId: "workspace-1", userId: "user-1" } as never,
    );

    await expect(service.get("workstream-1")).resolves.toMatchObject({ id: "workstream-1" });

    expect(sqlStatements.filter((sql) => sql.includes("SELECT w.*, t.name AS origin_label"))).toHaveLength(1);
    expect(sqlStatements.some((sql) => sql.includes("SELECT email_address, email_route_status, archived_at"))).toBe(false);
  });

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
        all: vi.fn(async () => ({ success: true, results: rows })),
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
    } as unknown as GlobalWorkstreamEmailRouterRpcBinding;
    const service = new WorkstreamService(
      {
        APP_ENV: "production",
        AVALON_REGION: "eu",
        DB: { prepare, batch },
        GLOBAL_EMAIL_ROUTER: globalRouter,
      } as unknown as Env,
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
  };
}

function d1Result<T>(changes: number, results: T[] = []): D1Result<T> {
  return {
    success: true,
    results,
    meta: { changes },
  } as D1Result<T>;
}
