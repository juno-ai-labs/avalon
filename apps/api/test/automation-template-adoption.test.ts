import { asUserId, asWorkspaceId } from "@rally/contracts";
import type * as WakeupService from "../src/services/workstream-wakeup-service";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";

// Binding WORKSPACE_DOS here would route this fixture's SQL into a stub object;
// the reconcile call is the seam this file cares about.
vi.mock("../src/services/workstream-wakeup-service", async (importOriginal) => ({
  ...await importOriginal<typeof WakeupService>(),
  refreshWorkspaceSchedule: vi.fn(async () => undefined),
}));

import { refreshWorkspaceSchedule } from "../src/services/workstream-wakeup-service";
import { AutomationService } from "../src/services/automation-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

interface ExecutedStatement {
  sql: string;
  values: unknown[];
}

class AdoptionDatabase {
  readonly executed: ExecutedStatement[] = [];
  /** Every user id the timezone lookup asked about, so a test can name whose day was read. */
  readonly timezoneLookups: unknown[] = [];
  readonly subscription: Record<string, unknown> = {
    id: "subscription-1",
    workspace_id: "668953d2-25f2-44fd-8d72-1e8cf024a277",
    template_id: "template-1",
    template_version_id: "version-1",
    status: "active",
    scope: "personal",
    owner_user_id: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
    connector_bindings_json: "{}",
    overrides_json: JSON.stringify({ tone: "concise" }),
  };
  readonly version: Record<string, unknown> = {
    id: "version-2",
    template_id: "template-1",
    version_number: 2,
    instructions: "Build the updated brief.",
    trigger_definitions_json: JSON.stringify([{
      type: "interval",
      intervalSeconds: 3_600,
      summary: "Every hour",
    }]),
    required_capabilities_json: "[]",
    expected_outputs_json: JSON.stringify(["A concise brief"]),
  };

  readonly binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new AdoptionStatement(this, sql)),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      return results;
    },
  });
}

class AdoptionStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: AdoptionDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): AdoptionStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.normalizedSql();
    if (sql.includes("FROM automation_subscriptions s JOIN automation_templates")) {
      return this.database.subscription as T;
    }
    if (sql.includes("FROM automation_template_versions WHERE id = ? AND template_id = ?")) {
      return this.values[0] === this.database.version.id && this.values[1] === this.database.version.template_id
        ? this.database.version as T
        : null;
    }
    if (sql.includes("(SELECT u.timezone FROM users u WHERE u.id = ?) AS user_timezone")) {
      this.database.timezoneLookups.push(this.values[0]);
      return {
        workspace_timezone: "Europe/London",
        user_timezone: this.values[0] === this.database.subscription.owner_user_id ? "America/New_York" : null,
      } as T;
    }
    throw new Error(`Unexpected first() query: ${sql}`);
  }

  async run<T>(): Promise<D1Result<T>> {
    this.database.executed.push({ sql: this.normalizedSql(), values: this.values });
    return createTestD1Result<T>({
      success: true,
      results: [],
      meta: { changes: 1 },
    });
  }

  private normalizedSql(): string {
    return this.sql.replace(/\s+/gu, " ").trim();
  }
}

afterEach(() => vi.useRealTimers());

describe("automation template version adoption", () => {
  it("atomically replaces schedule state while preserving subscription overrides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const database = new AdoptionDatabase();
    const env = createTestEnv({
      DB: database.binding,
      AVALON_REGION: "global",
    });
    const auth: AuthContext = {
      sessionId: "session-1",
      userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
      workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
      region: "global",
      role: "member",
    };
    const service = new AutomationService(env, auth);
    const get = vi.spyOn(service, "get").mockResolvedValue({ id: "subscription-1" } as never);

    await expect(service.adoptVersion("subscription-1", "version-2"))
      .resolves.toEqual({ id: "subscription-1" });

    expect(database.executed).toHaveLength(3);
    expect(database.executed[0]).toMatchObject({
      sql: expect.stringContaining("SET template_version_id = ?, connector_bindings_json = ?, activity_trigger_bindings_json = ?"),
      values: [
        "version-2",
        "{}",
        "{}",
        "2026-08-01T01:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        "subscription-1",
        "668953d2-25f2-44fd-8d72-1e8cf024a277",
      ],
    });
    expect(database.executed[0]!.sql).not.toContain("overrides_json");
    expect(database.executed[1]).toEqual({
      sql: "DELETE FROM schedules WHERE automation_subscription_id = ? AND workspace_id = ?",
      values: ["subscription-1", "668953d2-25f2-44fd-8d72-1e8cf024a277"],
    });
    expect(database.executed[2]).toMatchObject({
      sql: expect.stringContaining("INSERT INTO schedules"),
      values: [
        expect.any(String),
        "668953d2-25f2-44fd-8d72-1e8cf024a277",
        "subscription-1",
        "interval",
        null,
        3_600,
        "UTC",
        "2026-08-01T01:00:00.000Z",
        1,
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ],
    });
    expect(refreshWorkspaceSchedule).toHaveBeenCalledWith(
      expect.anything(),
      "668953d2-25f2-44fd-8d72-1e8cf024a277",
    );
    expect(get).toHaveBeenCalledWith("subscription-1");
  });

  it.each([
    {
      name: "reads a personal automation's occurrences in its owner's day",
      scope: "personal",
      ownerUserId: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
      lookedUpUserId: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
      timezone: "America/New_York",
      // 09:00 in New York on the first of August, which is 13:00 UTC.
      nextRunAt: "2026-08-01T13:00:00.000Z",
    },
    {
      name: "reads a workspace automation's in the workspace's",
      scope: "workspace",
      ownerUserId: null,
      lookedUpUserId: null,
      timezone: "Europe/London",
      // The same wall-clock hour in London, which is 08:00 UTC.
      nextRunAt: "2026-08-01T08:00:00.000Z",
    },
  ])("$name", async ({ scope, ownerUserId, lookedUpUserId, timezone, nextRunAt }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const database = new AdoptionDatabase();
    database.subscription.scope = scope;
    database.subscription.owner_user_id = ownerUserId;
    // A version whose calendar trigger names no zone: the automation runs at
    // nine in somebody's morning, and which morning is the account's answer
    // rather than one frozen into the definition by whoever wrote it.
    database.version.trigger_definitions_json = JSON.stringify([{
      type: "calendar",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      timezone: null,
      summary: "Every morning at 9:00 AM",
    }]);
    const env = createTestEnv({ DB: database.binding, AVALON_REGION: "global" });
    const auth: AuthContext = {
      sessionId: "session-1",
      userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
      workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
      region: "global",
      // A workspace automation is an administrator's to adopt a version of.
      role: scope === "workspace" ? "owner" : "member",
    };
    const service = new AutomationService(env, auth);
    vi.spyOn(service, "get").mockResolvedValue({ id: "subscription-1" } as never);

    await service.adoptVersion("subscription-1", "version-2");

    expect(database.timezoneLookups).toEqual([lookedUpUserId]);
    const scheduleInsert = database.executed.find((statement) =>
      statement.sql.includes("INSERT INTO schedules"));
    expect(scheduleInsert!.values).toEqual([
      expect.any(String),
      "668953d2-25f2-44fd-8d72-1e8cf024a277",
      "subscription-1",
      "calendar",
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      null,
      timezone,
      nextRunAt,
      1,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
  });
});
