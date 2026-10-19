import {
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  readStructuredFailure,
} from "@rally/contracts";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKSTREAM_WAKEUP_PROMPT_PREVIEW_LENGTH,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { substreamLoopId } from "../src/durable-objects/names";
import type { Env } from "../src/env";
import { withLocalWorkstreamAuthorities } from "../src/runtime/local-authorities";
import { __integrationTesting } from "../src/services/integrations";
import { fireWorkstreamWakeup } from "../src/services/workstream-service";
import {
  MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM,
  MINIMUM_WAKEUP_DELAY_SECONDS,
  WakeupInputError,
  WorkstreamWakeupRowSchema,
  parseWakeupDelay,
  resolveWakeupInstant,
  type WorkstreamWakeupRow,
} from "../src/services/workstream-wakeup-service";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestD1Result,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testIdentityOperationStub,
  testMessagePort,
  testSchedulingPort,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  type RecordedDispatch,
  applyWorkstreamObjectRootFields,
} from "./helpers/durable-authority";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000000");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000003");

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

function sqliteD1(database: DatabaseSync): D1Database {
  return createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql))),
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
  });
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Fixture {
  database: DatabaseSync;
  /** The main work stream's own object database, where its wake-ups live. */
  objectStore: DatabaseSync;
  /** Per-workstream object databases the runtime SQL port has opened. */
  objectStores: Map<string, DatabaseSync>;
  env: Env;
  /** Every agent timer refresh — how a wake-up is armed after cutover. */
  timerRefreshes: string[];
  /** Every run dispatched to the substream agent, in order. */
  dispatches: RecordedDispatch[];
  /** Set to make the next dispatches fail as if the agent were unreachable. */
  dispatchControl: { error: Error | null };
  /** Set to make the next timer refreshes fail as if the agent were unreachable. */
  timerControl: { error: Error | null };
  /** Set to make transcript writes fail as if the object's message port were down. */
  transcriptControl: { error: Error | null };
}

function fixture(): Fixture {
  const database = legacyProductSqliteDatabase();
  openDatabases.push(database);
  // The retired pre-cutover arms are gone: firing a wake-up now requires the
  // Durable-Object authority, so the fixture opens it (before any product rows
  // exist, the way a fresh local stack does) and serves the object's runtime
  // SQL from the same database.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users
      (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${USER_ID}', 'google-wakeup', 'wakeup@example.com', 'Wake Up',
            'America/Los_Angeles', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, timezone, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Wake Up', 'wake-up', 'global', '${USER_ID}',
            'America/New_York', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members
      (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE_ID}', '${USER_ID}', 'owner', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, email_address, email_route_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Wake Up', 'Wake Up', 'ad_hoc', '${USER_ID}',
            'running', 'wake-up@automation.with-avalon.com', 'active',
            '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  // Since migration 0090 the run and its transcript live only in the work
  // stream's object; the fixture opens that object and writes the run row
  // through the same compat port the harness uses.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM_ID,
    workspaceId: WORKSPACE_ID,
    title: "Wake Up",
    description: "Wake Up",
    originType: "ad_hoc",
    createdByUserId: USER_ID,
    exactState: "running",
    emailAddress: "wake-up@automation.with-avalon.com",
    emailRouteStatus: "active",
  });
  const objectStores = new Map<string, DatabaseSync>([[WORKSTREAM_ID, objectStore]]);
  // Settled, not running: the object enforces at most one mutating run per
  // substream (`runs_mutating_substream_uq`), so a fixture run left `running`
  // would block the very admission a fired wake-up performs. This run exists
  // as receipt context for the tools, the way a finished run precedes a
  // wake-up in production.
  seedWorkstreamRun(objectStore, { id: HARNESS_RUN_ID, status: "completed",
    executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }) });

  const timerRefreshes: string[] = [];
  const dispatches: RecordedDispatch[] = [];
  const dispatchControl: { error: Error | null } = { error: null };
  const timerControl: { error: Error | null } = { error: null };
  const transcriptControl: { error: Error | null } = { error: null };
  const transcript = testMessagePort(objectStore) as unknown as
    Record<string, (...args: unknown[]) => Promise<unknown>>;
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, {
      objectStores,
      dispatches,
      failDispatch: () => {
        if (dispatchControl.error) throw dispatchControl.error;
        return null;
      },
      extra: {
        refreshTimerAlarm: vi.fn((input: { workstreamId: string }) => {
          if (timerControl.error) throw timerControl.error;
          timerRefreshes.push(input.workstreamId);
          return { status: 200, bodyJson: "{}" };
        }),
        // The transcript reaches the object through its own port now, so a test
        // that needs the transcript write to fail injects here rather than into
        // the runtime SQL executor.
        executeMessageOperation: vi.fn(async (input: { operation: string; args: unknown[] }) => {
          if (transcriptControl.error) throw transcriptControl.error;
          const value = await transcript[input.operation]!(...input.args);
          return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
        }),
      },
    }),
  });
  return {
    database,
    objectStore,
    objectStores,
    env,
    timerRefreshes,
    dispatches,
    dispatchControl,
    timerControl,
    transcriptControl,
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
    reason: "Wake-up test",
  };
}

function context(providerIdempotencyKey = "receipt-1") {
  return {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: HARNESS_RUN_ID,
    toolCallId: providerIdempotencyKey,
    executionPrincipal: { type: "user" as const, userId: USER_ID },
    providerIdempotencyKey,
    signal: new AbortController().signal,
  };
}

function wakeupTools(env: Env) {
  // A tool's wake-up operation reaches the work stream through its typed port.
  const tools = __integrationTesting.createAvalonTools(
    env,
    workflowInput(),
  );
  return {
    schedule: tools.find((tool) => tool.definition.name === "schedule_wakeup")!,
    list: tools.find((tool) => tool.definition.name === "list_wakeups")!,
    cancel: tools.find((tool) => tool.definition.name === "cancel_wakeup")!,
  };
}

/**
 * The environment production fires wake-ups under: both the scheduler and the
 * agent timer wrap the bindings in the work-stream runtime router before
 * calling `fireWorkstreamWakeup`, so claim and transcript statements reach the
 * object while the directory reads stay regional.
 */
function executionEnvironment(env: Env): Env {
  return env;
}

function pendingRow(objectStore: DatabaseSync, wakeupId: string): WorkstreamWakeupRow {
  // The object's own columns, and the identity the retired view invented from
  // its root row. A fixture written in the view's vocabulary would be seeding
  // the thing this slice deletes.
  const row = objectGet<{
    wakeup_id: string; execution_principal_json: string; prompt: string;
    due_at: number; status: string; version: number; created_at: number;
  }>(
    objectStore,
    `SELECT wakeup_id, execution_principal_json, prompt, due_at, status, version, created_at
       FROM workstream_wakeups WHERE wakeup_id = ?`,
    wakeupId,
  )!;
  return WorkstreamWakeupRowSchema.parse({
    id: row.wakeup_id,
    workspace_id: WORKSPACE_ID,
    workstream_id: WORKSTREAM_ID,
    execution_principal_json: row.execution_principal_json,
    prompt: row.prompt,
    due_at: new Date(row.due_at).toISOString(),
    status: row.status,
    version: row.version,
    created_at: new Date(row.created_at).toISOString(),
  });
}

/**
 * Read the object's own tables, without the compatibility rewrite.
 *
 * `workstreamObjectGet` sends its SQL through the runtime router, which renames
 * `workstream_wakeups` onto `_runtime_wakeups` — the view this slice deletes.
 * A converted fixture has to read what the object actually stores.
 */
function objectGet<T>(objectStore: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | null {
  return (objectStore.prepare(sql).get(...params) as T | undefined) ?? null;
}

/** The port the owning object hands `fireWorkstreamWakeup`, over its own store. */
function schedulingPort(objectStore: DatabaseSync) {
  return testSchedulingPort(objectStore);
}

describe("wake-up delay grammar", () => {
  it.each([
    ["5 minutes", 300],
    ["5 minute", 300],
    ["5 min", 300],
    ["5 mins", 300],
    ["5m", 300],
    ["5M", 300],
    ["90 seconds", 90],
    ["90 second", 90],
    ["90 secs", 90],
    ["90 sec", 90],
    ["90s", 90],
    ["2 hours", 7_200],
    ["2 hour", 7_200],
    ["2 hrs", 7_200],
    ["2 hr", 7_200],
    ["2h", 7_200],
    ["3 days", 259_200],
    ["3 day", 259_200],
    ["3d", 259_200],
    ["2 weeks", 1_209_600],
    ["2w", 1_209_600],
    ["1h30m", 5_400],
    ["1h 30m", 5_400],
    ["1 hour 30 minutes", 5_400],
    ["1d, 2h, 30m", 95_400],
    ["  2 hours  ", 7_200],
    ["PT5M", 300],
    ["PT2H30M", 9_000],
    ["P1DT2H", 93_600],
    ["pt90s", 90],
  ])("reads %j as %i seconds", (text, seconds) => {
    expect(parseWakeupDelay(text)).toBe(seconds);
  });

  it.each([
    ["5", "wakeup_delay_unit_missing"],
    ["", "wakeup_delay_invalid"],
    ["   ", "wakeup_delay_invalid"],
    ["1.5h", "wakeup_delay_invalid"],
    ["5 fortnights", "wakeup_delay_unit_unknown"],
    ["5 months", "wakeup_delay_unit_unknown"],
    ["5 minutes 5 minutes", "wakeup_delay_invalid"],
    ["5m 10m", "wakeup_delay_invalid"],
    ["tomorrow", "wakeup_delay_invalid"],
    ["in 5 minutes", "wakeup_delay_invalid"],
    ["5 minutes please", "wakeup_delay_invalid"],
    ["-5m", "wakeup_delay_invalid"],
    ["P", "wakeup_delay_invalid"],
    ["2026-08-12T17:26", "wakeup_delay_invalid"],
  ])("rejects %j with %s", (text, code) => {
    expect(() => parseWakeupDelay(text)).toThrow(expect.objectContaining({ code }));
  });

  it("names every accepted unit in the model-visible reason on every delay rejection", () => {
    for (const text of ["5", "1.5h", "5 fortnights", "5m 10m"]) {
      try {
        parseWakeupDelay(text);
        expect.unreachable(`expected ${text} to be rejected`);
      } catch (error) {
        const reason = (error as WakeupInputError).details.reason;
        for (const unit of ["seconds", "minutes", "hours", "days", "weeks", "ISO-8601"]) {
          expect(reason).toContain(unit);
        }
      }
    }
  });
});

describe("wake-up instant resolution", () => {
  const now = new Date("2026-08-11T12:00:00.000Z");

  it("resolves a relative delay against the current instant", () => {
    expect(resolveWakeupInstant({
      delay: "2 hours",
      defaultTimezone: "America/Los_Angeles",
      now,
    }).dueAt.toISOString()).toBe("2026-08-11T14:00:00.000Z");
  });

  it("reads a local wall-clock time in the named zone, daylight offset included", () => {
    // 5:26pm on 12 August is Pacific Daylight Time, seven hours behind UTC.
    expect(resolveWakeupInstant({
      at: "2026-08-12T17:26",
      timezone: "America/Los_Angeles",
      defaultTimezone: "UTC",
      now,
    }).dueAt.toISOString()).toBe("2026-08-13T00:26:00.000Z");
  });

  it("reads the same wall-clock time in the same zone as standard time in winter", () => {
    // The identical local reading in January is eight hours behind UTC, which is
    // the whole reason the tool resolves zones rather than asking for an offset.
    expect(resolveWakeupInstant({
      at: "2027-01-12T17:26",
      timezone: "America/Los_Angeles",
      defaultTimezone: "UTC",
      now,
    }).dueAt.toISOString()).toBe("2027-01-13T01:26:00.000Z");
  });

  it("falls back to the work stream's local zone when no timezone is given", () => {
    expect(resolveWakeupInstant({
      at: "2026-08-12T17:26:00",
      defaultTimezone: "America/Los_Angeles",
      now,
    }).dueAt.toISOString()).toBe("2026-08-13T00:26:00.000Z");
  });

  it("accepts an offset-bearing timestamp as absolute", () => {
    expect(resolveWakeupInstant({
      at: "2026-08-12T17:26:00-07:00",
      defaultTimezone: "UTC",
      now,
    }).dueAt.toISOString()).toBe("2026-08-13T00:26:00.000Z");
  });

  it("rejects an offset-bearing timestamp paired with a timezone rather than picking one", () => {
    expect(() => resolveWakeupInstant({
      at: "2026-08-12T17:26:00Z",
      timezone: "America/Los_Angeles",
      defaultTimezone: "UTC",
      now,
    })).toThrow(expect.objectContaining({ code: "wakeup_time_ambiguous" }));
  });

  it("rejects a partial or non-ISO timestamp rather than guessing the rest", () => {
    for (const at of [
      "2026-08-12",
      "17:26",
      "2026-08-12T17",
      "08/12/2026 17:26",
      "next Tuesday",
      "2026-08-12T17:26:00+7:00",
      "2026-13-12T17:26",
      "2026-02-31T17:26",
      "2026-08-12T25:26",
      "2026-08-12T17:60",
    ]) {
      expect(() => resolveWakeupInstant({ at, defaultTimezone: "UTC", now }))
        .toThrow(expect.objectContaining({ code: "wakeup_time_invalid" }));
    }
  });

  it("rejects both time forms at once, and neither", () => {
    expect(() => resolveWakeupInstant({
      delay: "5 minutes",
      at: "2026-08-12T17:26",
      defaultTimezone: "UTC",
      now,
    })).toThrow(expect.objectContaining({ code: "wakeup_time_ambiguous" }));
    expect(() => resolveWakeupInstant({ defaultTimezone: "UTC", now }))
      .toThrow(expect.objectContaining({ code: "wakeup_time_missing" }));
  });

  it("holds the one-minute floor against a relative delay and an absolute time alike", () => {
    expect(MINIMUM_WAKEUP_DELAY_SECONDS).toBe(60);
    // Second-granularity units parse; it is the resolved instant that is bound.
    expect(parseWakeupDelay("59s")).toBe(59);
    expect(() => resolveWakeupInstant({ delay: "59s", defaultTimezone: "UTC", now }))
      .toThrow(expect.objectContaining({ code: "wakeup_too_soon" }));
    expect(() => resolveWakeupInstant({
      at: "2026-08-11T12:00:30Z",
      defaultTimezone: "UTC",
      now,
    })).toThrow(expect.objectContaining({ code: "wakeup_too_soon" }));
    expect(() => resolveWakeupInstant({
      at: "2026-08-11T11:00:00Z",
      defaultTimezone: "UTC",
      now,
    })).toThrow(expect.objectContaining({ code: "wakeup_too_soon" }));
    // Exactly the floor is allowed, in both forms.
    expect(resolveWakeupInstant({ delay: "60s", defaultTimezone: "UTC", now }).dueAt.toISOString())
      .toBe("2026-08-11T12:01:00.000Z");
    expect(resolveWakeupInstant({
      at: "2026-08-11T12:01:00Z",
      defaultTimezone: "UTC",
      now,
    }).dueAt.toISOString()).toBe("2026-08-11T12:01:00.000Z");
  });

  it("quotes the grammar of the form the caller used when a bound is tripped", () => {
    const bounds: Array<[Parameters<typeof resolveWakeupInstant>[0], string, string]> = [
      [{ delay: "10s", defaultTimezone: "UTC", now }, "wakeup_too_soon", "delay"],
      [{ at: "2026-08-11T12:00:10Z", defaultTimezone: "UTC", now }, "wakeup_too_soon", "at"],
      [{ delay: "60 weeks", defaultTimezone: "UTC", now }, "wakeup_too_distant", "delay"],
      [{ at: "2030-08-12T17:26:00Z", defaultTimezone: "UTC", now }, "wakeup_too_distant", "at"],
    ];
    for (const [request, code, form] of bounds) {
      try {
        resolveWakeupInstant(request);
        expect.unreachable(`expected ${code}`);
      } catch (error) {
        const reason = (error as WakeupInputError).details.reason;
        expect((error as WakeupInputError).code).toBe(code);
        // A caller who passed `at` gets the timestamp grammar, not duration units.
        if (form === "delay") {
          expect(reason).toContain("Accepted units are seconds");
          expect(reason).not.toContain("ISO-8601 date and time");
        } else {
          expect(reason).toContain("ISO-8601 date and time");
          expect(reason).not.toContain("Accepted units are seconds");
        }
      }
    }
  });

  it("rejects a time beyond the one-year horizon in either form", () => {
    expect(() => resolveWakeupInstant({
      at: "2030-08-12T17:26:00Z",
      defaultTimezone: "UTC",
      now,
    })).toThrow(expect.objectContaining({ code: "wakeup_too_distant" }));
    expect(() => resolveWakeupInstant({
      delay: "60 weeks",
      defaultTimezone: "UTC",
      now,
    })).toThrow(expect.objectContaining({ code: "wakeup_too_distant" }));
  });

  it("carries a model-visible remediation reason on every rejection", () => {
    try {
      resolveWakeupInstant({ defaultTimezone: "UTC", now });
      expect.unreachable("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WakeupInputError);
      expect((error as WakeupInputError).details.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("wake-up tools", () => {
  it("keeps the earliest pending wake-up for a marker in the object as wake-ups come and go", async () => {
    const { objectStore, env } = fixture();
    const { schedule, cancel } = wakeupTools(env);
    const earliestPending = () => objectGet<{ prompt: string; due_at: number }>(
      objectStore,
      `SELECT prompt, due_at FROM workstream_wakeups
        WHERE status = 'pending' ORDER BY due_at, wakeup_id LIMIT 1`,
    );

    expect(earliestPending()).toBeNull();

    const later = await schedule.execute(
      { prompt: "Send the final deployment recap", delay: "3 hours" },
      context("later-sidebar-marker"),
    );
    const earlierPrompt = "Check whether the production deployment finished successfully";
    const earlier = await schedule.execute(
      { prompt: earlierPrompt, delay: "2 hours" },
      context("earlier-sidebar-marker"),
    );
    expect(earliestPending()).toEqual({
      prompt: earlierPrompt,
      // The object's own instant. The tool still answers ISO-8601 — that is a
      // boundary format now rather than a stored one.
      due_at: Date.parse((earlier.output as { dueAt: string }).dueAt),
    });
    expect(`${earlierPrompt.slice(0, WORKSTREAM_WAKEUP_PROMPT_PREVIEW_LENGTH).trimEnd()}…`)
      .toBe("Check whether the production deployment…");

    await cancel.execute(
      { wakeupId: (earlier.output as { wakeupId: string }).wakeupId },
      context("cancel-earlier-sidebar-marker"),
    );
    expect(earliestPending()).toEqual({
      prompt: "Send the final deployment recap",
      due_at: Date.parse((later.output as { dueAt: string }).dueAt),
    });

    await cancel.execute(
      { wakeupId: (later.output as { wakeupId: string }).wakeupId },
      context("cancel-later-sidebar-marker"),
    );
    expect(earliestPending()).toBeNull();
  });

  it("schedules a wake-up and arms the work stream's own agent timer", async () => {
    const { objectStore, env, timerRefreshes } = fixture();
    const { schedule } = wakeupTools(env);

    const result = await schedule.execute(
      { prompt: "Check whether the deploy finished", delay: "2 hours" },
      context(),
    );

    const output = result.output as Record<string, unknown>;
    expect(output.prompt).toBe("Check whether the deploy finished");
    expect(output.pendingWakeups).toBe(1);
    // The user principal's own zone wins over the workspace's.
    expect(output.timezone).toBe("America/Los_Angeles");
    expect(String(output.dueAtLocal)).toContain("America/Los_Angeles");
    // After cutover the timer's owner is the SubstreamAgent whose tool
    // inserted the row, not the workspace scheduler.
    expect(timerRefreshes).toEqual([WORKSTREAM_ID]);

    const row = objectGet<{ status: string; prompt: string }>(
      objectStore,
      "SELECT status, prompt FROM workstream_wakeups",
    );
    expect(row).toMatchObject({ status: "pending", prompt: "Check whether the deploy finished" });
  });

  it("returns the persisted wake-up on a replayed receipt instead of scheduling a second", async () => {
    const { objectStore, env } = fixture();
    const { schedule } = wakeupTools(env);
    const args = { prompt: "Send the recap", delay: "1 hour" };

    const first = await schedule.execute(args, context("receipt-replay"));
    const second = await schedule.execute(args, context("receipt-replay"));

    expect((second.output as { wakeupId: string }).wakeupId)
      .toBe((first.output as { wakeupId: string }).wakeupId);
    expect((second.output as { dueAt: string }).dueAt)
      .toBe((first.output as { dueAt: string }).dueAt);
    const count = objectGet<{ n: number }>(objectStore, "SELECT COUNT(*) AS n FROM workstream_wakeups")!;
    expect(count.n).toBe(1);
  });

  it("leaves no pending wake-up behind when the alarm cannot be armed", async () => {
    const { objectStore, env, timerControl } = fixture();
    timerControl.error = new Error("agent timer unavailable");
    const { schedule } = wakeupTools(env);

    await expect(schedule.execute(
      { prompt: "Unarmed", delay: "1 hour" },
      context(),
    )).rejects.toThrow();

    // Either it is scheduled and armed, or it does not exist. A pending row with
    // no alarm behind it would never fire in a workspace with nothing else due.
    const rows = objectGet<{ n: number }>(objectStore, "SELECT COUNT(*) AS n FROM workstream_wakeups")!;
    expect(rows.n).toBe(0);
  });

  it("re-arms the alarm when a replayed receipt finds a still-pending wake-up", async () => {
    const { objectStore, env, timerRefreshes } = fixture();
    const { schedule } = wakeupTools(env);
    // Stand in for a first attempt that persisted the row and then failed before
    // arming: the row is present, the workspace has never been refreshed.
    objectStore.prepare(
      `INSERT INTO workstream_wakeups
         (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
          status, idempotency_key, version, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 'pending', ?, 1, ?, ?)`,
    ).run(
      "00000000-0000-4000-8000-0000000000b1",
      JSON.stringify({ type: "user", userId: USER_ID }),
      "Orphaned by a failed refresh",
      Date.parse("2026-12-01T00:00:00.000Z"),
      "receipt-orphan",
      Date.parse("2026-08-11"),
      Date.parse("2026-08-11"),
    );
    expect(timerRefreshes).toHaveLength(0);

    const replay = await schedule.execute(
      { prompt: "Orphaned by a failed refresh", delay: "1 hour" },
      context("receipt-orphan"),
    );

    expect((replay.output as { wakeupId: string }).wakeupId)
      .toBe("00000000-0000-4000-8000-0000000000b1");
    expect(timerRefreshes).toHaveLength(1);
    const count = objectGet<{ n: number }>(objectStore, "SELECT COUNT(*) AS n FROM workstream_wakeups")!;
    expect(count.n).toBe(1);
  });

  it("throws a classified recoverable error with model-visible guidance", async () => {
    const { env } = fixture();
    const { schedule } = wakeupTools(env);

    await expect(schedule.execute({ prompt: "Too soon", delay: "5s" }, context()))
      .rejects.toMatchObject({
        code: "wakeup_too_soon",
        details: { reason: expect.stringContaining("seconds from now") },
      });
  });

  it("refuses an undeclared parameter rather than dropping it", async () => {
    const { env } = fixture();
    const { schedule } = wakeupTools(env);

    await expect(schedule.execute(
      { prompt: "Preview only", delay: "5 minutes", dryRun: true },
      context(),
    )).rejects.toThrow();
  });

  it("caps pending wake-ups and names what is already scheduled", async () => {
    const { env } = fixture();
    const { schedule } = wakeupTools(env);
    for (let index = 0; index < MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM; index += 1) {
      await schedule.execute(
        { prompt: `Wake ${index}`, delay: `${60 + index} minutes` },
        context(`receipt-${index}`),
      );
    }

    await expect(schedule.execute(
      { prompt: "One too many", delay: "150 minutes" },
      context("receipt-overflow"),
    )).rejects.toMatchObject({
      code: "wakeup_limit_reached",
      details: {
        reason: expect.stringContaining("cancel one pending wake-up"),
        available: expect.arrayContaining([expect.any(String)]),
      },
    });
  });

  it("bounds wake-up recovery IDs before structured-failure sanitization", () => {
    const valid = Array.from(
      { length: MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM + 5 },
      (_, index) => `wakeup-${String(index).padStart(2, "0")}`,
    );
    const failure = new WakeupInputError(
      "wakeup_limit_reached",
      "Too many wake-ups",
      "Cancel one pending wake-up before retrying.",
      [`wakeup-${"x".repeat(170)}`, ...valid],
    );

    expect(readStructuredFailure(failure)).toEqual({
      code: "wakeup_limit_reached",
      details: {
        reason: "Cancel one pending wake-up before retrying.",
        available: valid.slice(0, MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM),
      },
    });
  });

  it("lists and cancels a pending wake-up, then refuses to cancel it twice", async () => {
    const { env } = fixture();
    const { schedule, list, cancel } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Follow up", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;

    const listed = await list.execute({}, context());
    expect((listed.output as { wakeups: unknown[] }).wakeups).toHaveLength(1);

    await expect(cancel.execute({ wakeupId }, context())).resolves.toMatchObject({
      output: { status: "cancelled" },
    });
    await expect(cancel.execute({ wakeupId }, context())).rejects.toMatchObject({
      code: "wakeup_not_pending",
      details: { reason: expect.stringContaining("still pending") },
    });
    expect((await list.execute({}, context())).output).toMatchObject({ wakeups: [] });
  });

  it("does not expose a wake-up belonging to another work stream", async () => {
    const { database, objectStores, env } = fixture();
    const otherWorkstream = "00000000-0000-4000-8000-000000000009";
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('${otherWorkstream}', '${WORKSPACE_ID}', 'Other', 'Other', 'ad_hoc', '${USER_ID}',
              'idle', '2026-01-01', '2026-01-01', '2026-01-01');
    `);
    // The foreign wake-up lives in the other work stream's own object, the way
    // production isolates it; nothing about the tools' own object mentions it.
    const foreignStore = testWorkstreamObjectStore();
    openDatabases.push(foreignStore);
    seedWorkstreamObjectRoot(foreignStore, { workstreamId: otherWorkstream, workspaceId: WORKSPACE_ID });
    objectStores.set(otherWorkstream, foreignStore);
    foreignStore.prepare(
      `INSERT INTO workstream_wakeups
         (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
          status, idempotency_key, version, created_at, updated_at)
       VALUES ('00000000-0000-4000-8000-00000000000a', NULL, ?, 'Foreign', ?,
               'pending', 'foreign-receipt', 1, ?, ?)`,
    ).run(
      JSON.stringify({ type: "user", userId: USER_ID }),
      Date.parse("2026-08-12T00:00:00.000Z"),
      Date.parse("2026-08-11"),
      Date.parse("2026-08-11"),
    );
    const { list, cancel } = wakeupTools(env);

    expect((await list.execute({}, context())).output).toMatchObject({ wakeups: [] });
    await expect(cancel.execute(
      { wakeupId: "00000000-0000-4000-8000-00000000000a" },
      context(),
    )).rejects.toMatchObject({
      code: "wakeup_not_found",
      message: expect.not.stringContaining("another work stream"),
    });
  });
});

/**
 * A child conversation as its own object stands: its own store, holding the
 * wake-up its run scheduled, and the environment its alarm fires under, with
 * this conversation's identity and transcript installed the way
 * `localRuntimeEnvironment` installs them. A port that wrongly named Main
 * would reach the fixture's Main store instead, which the tests check is
 * left untouched.
 */
function childConversation(
  fixtureEnv: Env,
  objectStores: Map<string, DatabaseSync>,
  substreamId: string,
  prompt: string,
): { store: DatabaseSync; env: Env; row: WorkstreamWakeupRow } {
  const store = testWorkstreamObjectStore();
  openDatabases.push(store);
  seedWorkstreamObjectRoot(store, { workstreamId: WORKSTREAM_ID, workspaceId: WORKSPACE_ID });
  objectStores.set(`${WORKSTREAM_ID}:${substreamId}`, store);
  const now = Date.now();
  store.prepare(
    `INSERT INTO workstream_wakeups
       (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
        status, idempotency_key, version, created_at, updated_at)
     VALUES ('00000000-0000-4000-8000-0000000000d1', NULL, ?, ?, ?, 'pending', 'child-receipt', 1, ?, ?)`,
  ).run(JSON.stringify({ type: "user", userId: USER_ID }), prompt, now - 1_000, now - 60_000, now - 60_000);
  const transcript = testMessagePort(store) as unknown as
    Record<string, (...args: unknown[]) => Promise<unknown>>;
  const identity = testIdentityOperationStub(store);
  const env = withLocalWorkstreamAuthorities(fixtureEnv, WORKSPACE_ID, WORKSTREAM_ID, substreamId, {
    message: async (operation, args) => ({ ok: true, value: (await transcript[operation]!(...args)) ?? null }),
    identity: async (operation, args) => JSON.parse(identity({ operation, args }).bodyJson) as { ok?: boolean; value?: unknown },
  });
  return { store, env, row: pendingRow(store, "00000000-0000-4000-8000-0000000000d1") };
}

function wakeupNotes(store: DatabaseSync): string[] {
  return (store.prepare(
    "SELECT content FROM canonical_conversation_turn_details WHERE message_type = 'system'",
  ).all() as { content: string }[]).map((row) => row.content);
}

describe("firing a due wake-up", () => {
  it("claims the wake-up, notes it in the transcript, and starts a run carrying its id", async () => {
    const { objectStore, env, dispatches } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Check the deploy", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;

    const outcome = await fireWorkstreamWakeup(
      executionEnvironment(env),
      pendingRow(objectStore, wakeupId),
      schedulingPort(objectStore),
    );

    expect(outcome.fired).toBe(true);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.scheduledWakeupId).toBe(wakeupId);
    expect(dispatches[0]?.reason).toBe("scheduled_wakeup");

    const row = objectGet(
      objectStore,
      "SELECT status, fired_at FROM workstream_wakeups WHERE wakeup_id = ?",
      wakeupId,
    ) as { status: string; fired_at: string | null };
    expect(row.status).toBe("fired");
    expect(row.fired_at).not.toBeNull();

    const message = workstreamObjectGet(
      objectStore,
      "SELECT author_type, message_type, content AS text_content FROM canonical_conversation_turn_details",
    ) as { author_type: string; message_type: string; text_content: string };
    expect(message).toMatchObject({ author_type: "system", message_type: "system" });
    expect(message.text_content).toContain("Check the deploy");
  });

  it("starts a Breakout's wake-up in the Breakout's own loop, not Main's", async () => {
    const { objectStore, objectStores, env: base, dispatches } = fixture();
    const breakoutId = asSubstreamId("00000000-0000-4000-8000-0000000000b1");
    const breakout = childConversation(base, objectStores, breakoutId, "Check the private deploy");

    const outcome = await fireWorkstreamWakeup(
      breakout.env,
      breakout.row,
      schedulingPort(breakout.store),
      { parentKind: "workstream", substreamId: breakoutId },
    );

    expect(outcome.fired).toBe(true);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      parentKind: "workstream",
      substreamId: breakoutId,
      loopId: substreamLoopId(WORKSTREAM_ID, breakoutId),
    });
    // The claim, the transcript note and the run's receipt are all the
    // Breakout's. Main sees none of them: its transcript would otherwise
    // carry a private Breakout's prompt.
    expect(objectGet(breakout.store, "SELECT status FROM workstream_wakeups WHERE wakeup_id = ?", breakout.row.id))
      .toEqual({ status: "fired" });
    expect(wakeupNotes(breakout.store)).toEqual([
      "Rally woke this thread up as scheduled: Check the private deploy",
    ]);
    expect(objectGet(breakout.store, "SELECT origin FROM runs WHERE run_id = ?", outcome.harnessRunId!))
      .toEqual({ origin: "scheduled_wakeup" });
    expect(wakeupNotes(objectStore)).toEqual([]);
    expect(objectGet(objectStore, "SELECT run_id FROM runs WHERE run_id = ?", outcome.harnessRunId!))
      .toBeNull();
  });

  describe("in a Sidekick run child", () => {
    const runId = asSubstreamId("00000000-0000-4000-8000-0000000000c1");
    const runAsUserId = asUserId("00000000-0000-4000-8000-0000000000c2");
    const automationRun = {
      schemaVersion: 1 as const,
      automationId: WORKSTREAM_ID,
      runId,
      definitionRevision: 3,
      trigger: { kind: "manual" as const, requestedByUserId: USER_ID },
    };

    /** The Organization object's half: whether the Sidekick lets this run go on. */
    function withSidekick(env: Env, answer: unknown): { env: Env; asked: unknown[] } {
      const asked: unknown[] = [];
      const workspaces = createCloudflareTestBinding<DurableObjectNamespace>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: () => ({
          sidekickContinueRun: async (request: unknown) => {
            asked.push(request);
            return answer;
          },
        }),
      });
      const withWorkspaces = new Proxy(env, {
        get: (target, property, receiver) => property === "WORKSPACE_DOS"
          ? workspaces
          : Reflect.get(target, property, receiver) as unknown,
      });
      return { env: withWorkspaces, asked };
    }

    it("continues the run that scheduled it, as the Sidekick's run-as user", async () => {
      const { objectStore, objectStores, env: fixtureEnv, dispatches } = fixture();
      const { env: base, asked } = withSidekick(fixtureEnv, {
        outcome: "continue",
        automationRun,
        executionPrincipal: { type: "user", userId: runAsUserId },
        stopGeneration: 4,
      });
      const run = childConversation(base, objectStores, runId, "Start the monitoring window");

      const outcome = await fireWorkstreamWakeup(
        run.env,
        run.row,
        schedulingPort(run.store),
        { parentKind: "automation", substreamId: runId },
      );

      expect(outcome.fired).toBe(true);
      expect(asked).toEqual([{ workspaceId: WORKSPACE_ID, automationId: WORKSTREAM_ID, runId }]);
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({
        parentKind: "automation",
        substreamId: runId,
        loopId: substreamLoopId(WORKSTREAM_ID, runId),
        executionPrincipal: { type: "user", userId: runAsUserId },
        automationRun,
        automationContinuation: { stopGeneration: 4, senderName: "Rally", source: { kind: "run" } },
      });
      expect(wakeupNotes(run.store)).toEqual([
        "Rally woke this thread up as scheduled: Start the monitoring window",
      ]);
      expect(wakeupNotes(objectStore)).toEqual([]);
    });

    it("consumes without running a wake-up the Sidekick refuses", async () => {
      const { objectStores, env: fixtureEnv, dispatches } = fixture();
      const { env: base } = withSidekick(fixtureEnv, { outcome: "refused", code: "sidekick_paused" });
      const run = childConversation(base, objectStores, runId, "Start the monitoring window");

      const outcome = await fireWorkstreamWakeup(
        run.env,
        run.row,
        schedulingPort(run.store),
        { parentKind: "automation", substreamId: runId },
      );

      expect(outcome.fired).toBe(false);
      expect(dispatches).toHaveLength(0);
      expect(objectGet(run.store, "SELECT status FROM workstream_wakeups WHERE wakeup_id = ?", run.row.id))
        .toEqual({ status: "fired" });
      expect(wakeupNotes(run.store)).toEqual([]);
    });
  });

  it("previews a long prompt on a word boundary with a visible marker", async () => {
    const { objectStore, env } = fixture();
    const { schedule } = wakeupTools(env);
    const prompt = [
      "Check whether the Acme production deploy completed successfully, then compare",
      "the error rate over the following hour against the prior seven-day baseline,",
      "and if it regressed by more than two percent write a short incident note naming",
      "the affected endpoints and page the on-call engineer for the checkout service",
      "immediately without waiting for anyone else to confirm the regression first.",
    ].join(" ");
    const scheduled = await schedule.execute({ prompt, delay: "1 hour" }, context());

    await fireWorkstreamWakeup(
      executionEnvironment(env),
      pendingRow(objectStore, (scheduled.output as { wakeupId: string }).wakeupId),
      schedulingPort(objectStore),
    );

    const message = workstreamObjectGet(
      objectStore,
      "SELECT content AS text_content FROM canonical_conversation_turn_details",
    ) as { text_content: string };
    expect(message.text_content).toMatch(/…$/u);
    // The cut lands between words, never inside one.
    expect(message.text_content.replace(/…$/u, "")).toMatch(/\w$/u);
    expect(prompt).toContain(
      message.text_content.replace("Rally woke this thread up as scheduled: ", "").replace(/…$/u, ""),
    );
  });

  it("fires a wake-up at most once when two alarms race the same row", async () => {
    const { objectStore, env, dispatches } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Only once", delay: "1 hour" },
      context(),
    );
    const row = pendingRow(objectStore, (scheduled.output as { wakeupId: string }).wakeupId);

    const outcomes = [
      await fireWorkstreamWakeup(executionEnvironment(env), row, schedulingPort(objectStore)),
      await fireWorkstreamWakeup(executionEnvironment(env), row, schedulingPort(objectStore)),
    ];

    expect(outcomes.filter((outcome) => outcome.fired)).toHaveLength(1);
    expect(dispatches).toHaveLength(1);
  });

  it("releases the claim when the harness cannot be started, so a later alarm retries", async () => {
    const { objectStore, env, dispatchControl } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Retry me", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    dispatchControl.error = new Error("substream agent unavailable");

    await expect(fireWorkstreamWakeup(
      executionEnvironment(env),
      pendingRow(objectStore, wakeupId),
      schedulingPort(objectStore),
    )).rejects.toThrow();

    const row = objectGet(
      objectStore,
      "SELECT status, fired_at FROM workstream_wakeups WHERE wakeup_id = ?",
      wakeupId,
    ) as { status: string; fired_at: string | null };
    expect(row).toMatchObject({ status: "pending", fired_at: null });
  });

  it("releases the claim when pre-launch preparation fails, not just the launch", async () => {
    const { objectStore, env, dispatches, transcriptControl } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Transcript write fails", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    const row = pendingRow(objectStore, wakeupId);
    // Fail the transcript write, which runs after the claim and before the
    // launch. The claim is only safe to hold if every throw between them
    // releases it: once the row leaves `pending`, the scheduler's retry gate
    // cannot see it as due and the wake-up is consumed with no run. The
    // transcript has its own port since the messages slice, so the failure is
    // injected there — the claim's own operation passes through.
    transcriptControl.error = new Error("transcript port unavailable");

    await expect(fireWorkstreamWakeup(
      executionEnvironment(env),
      row,
      schedulingPort(objectStore),
    )).rejects.toThrow("transcript port unavailable");

    expect(dispatches).toHaveLength(0);
    const after = objectGet<{ status: string; fired_at: number | null }>(
      objectStore,
      "SELECT status, fired_at FROM workstream_wakeups WHERE wakeup_id = ?",
      wakeupId,
    );
    expect(after).toMatchObject({ status: "pending", fired_at: null });
  });

  it("does not duplicate the transcript row when a released wake-up fires again", async () => {
    const { objectStore, env, dispatchControl } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Retried after a launch failure", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    dispatchControl.error = new Error("substream agent unavailable");

    await expect(fireWorkstreamWakeup(
      executionEnvironment(env),
      pendingRow(objectStore, wakeupId),
      schedulingPort(objectStore),
    )).rejects.toThrow();
    dispatchControl.error = null;
    expect((await fireWorkstreamWakeup(
      executionEnvironment(env),
      pendingRow(objectStore, wakeupId),
      schedulingPort(objectStore),
    )).fired).toBe(true);

    const messages = workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS n FROM canonical_conversation_turn_details WHERE message_type = 'system'",
    ) as { n: number };
    expect(messages.n).toBe(1);
  });

  it("consumes without running a wake-up whose principal lost workspace membership", async () => {
    const { database, objectStore, env, dispatches } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Revoked", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    database.prepare("UPDATE workspace_members SET status = 'suspended' WHERE user_id = ?")
      .run(USER_ID);

    const outcome = await fireWorkstreamWakeup(
      executionEnvironment(env),
      pendingRow(objectStore, wakeupId),
      schedulingPort(objectStore),
    );

    expect(outcome.fired).toBe(false);
    expect(dispatches).toHaveLength(0);
    const row = objectGet(
      objectStore,
      "SELECT status FROM workstream_wakeups WHERE wakeup_id = ?",
      wakeupId,
    ) as { status: string };
    expect(row.status).toBe("fired");
  });

  it("does not run a wake-up whose work stream was archived", async () => {
    const { database, objectStore, env, dispatches } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Archived", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    // Archiving writes both stores in production: the regional directory index
    // and the object root the routed `archived_at` guard reads.
    database.prepare("UPDATE workstreams SET archived_at = ? WHERE id = ?")
      .run("2026-08-11T12:00:00.000Z", WORKSTREAM_ID);
    applyWorkstreamObjectRootFields(objectStore, {
      archivedAt: Date.parse("2026-08-11T12:00:00.000Z"),
    });

    expect((await fireWorkstreamWakeup(
      executionEnvironment(env),
      pendingRow(objectStore, wakeupId),
      schedulingPort(objectStore),
    )).fired).toBe(false);
    expect(dispatches).toHaveLength(0);
  });
});
