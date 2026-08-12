import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import type { Env } from "../src/env";
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
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

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
  env: Env;
  schedulerRefreshes: string[];
  workflowCreations: Array<{ id: string; params: WorkstreamWorkflowInput }>;
}

function fixture(): Fixture {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
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
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Wake Up', 'Wake Up', 'ad_hoc', '${USER_ID}',
            'running', '2026-01-01', '2026-01-01', '2026-01-01');
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES ('${HARNESS_RUN_ID}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'test',
            '{"type":"user","userId":"${USER_ID}"}', 'running', '2026-01-01');
  `);

  const schedulerRefreshes: string[] = [];
  const workflowCreations: Array<{ id: string; params: WorkstreamWorkflowInput }> = [];
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    WORKSPACE_SCHEDULERS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (_url: string, init: { body: string }) => {
          schedulerRefreshes.push(`${name}:${init.body}`);
          return new Response("{}", { status: 200 });
        },
      }),
    },
    WORKSTREAM_ROOMS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
    },
    WORKSTREAM_LOOP_WORKFLOW: {
      create: async (options: { id: string; params: WorkstreamWorkflowInput }) => {
        workflowCreations.push(options);
      },
    },
  });
  return { database, env, schedulerRefreshes, workflowCreations };
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
  const tools = __integrationTesting.createAvalonTools(env, workflowInput());
  return {
    schedule: tools.find((tool) => tool.definition.name === "schedule_wakeup")!,
    list: tools.find((tool) => tool.definition.name === "list_wakeups")!,
    cancel: tools.find((tool) => tool.definition.name === "cancel_wakeup")!,
  };
}

function pendingRow(database: DatabaseSync, wakeupId: string): WorkstreamWakeupRow {
  const row = database.prepare(
    `SELECT id, workspace_id, workstream_id, execution_principal_json, prompt,
            due_at, status, version, created_at
       FROM workstream_wakeups WHERE id = ?`,
  ).get(wakeupId);
  return WorkstreamWakeupRowSchema.parse(row);
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

  it("names every accepted unit in the hint on every delay rejection", () => {
    for (const text of ["5", "1.5h", "5 fortnights", "5m 10m"]) {
      try {
        parseWakeupDelay(text);
        expect.unreachable(`expected ${text} to be rejected`);
      } catch (error) {
        const hint = (error as WakeupInputError).hint;
        for (const unit of ["seconds", "minutes", "hours", "days", "weeks", "ISO-8601"]) {
          expect(hint).toContain(unit);
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
        const { hint } = error as WakeupInputError;
        expect((error as WakeupInputError).code).toBe(code);
        // A caller who passed `at` gets the timestamp grammar, not duration units.
        if (form === "delay") {
          expect(hint).toContain("Accepted units are seconds");
          expect(hint).not.toContain("ISO-8601 date and time");
        } else {
          expect(hint).toContain("ISO-8601 date and time");
          expect(hint).not.toContain("Accepted units are seconds");
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

  it("carries a remediation hint on every rejection", () => {
    try {
      resolveWakeupInstant({ defaultTimezone: "UTC", now });
      expect.unreachable("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WakeupInputError);
      expect((error as WakeupInputError).hint.length).toBeGreaterThan(0);
    }
  });
});

describe("wake-up tools", () => {
  it("schedules a wake-up and refreshes the workspace alarm", async () => {
    const { database, env, schedulerRefreshes } = fixture();
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
    expect(schedulerRefreshes).toHaveLength(1);

    const row = database.prepare("SELECT status, prompt FROM workstream_wakeups").get() as {
      status: string;
      prompt: string;
    };
    expect(row).toMatchObject({ status: "pending", prompt: "Check whether the deploy finished" });
  });

  it("returns the persisted wake-up on a replayed receipt instead of scheduling a second", async () => {
    const { database, env } = fixture();
    const { schedule } = wakeupTools(env);
    const args = { prompt: "Send the recap", delay: "1 hour" };

    const first = await schedule.execute(args, context("receipt-replay"));
    const second = await schedule.execute(args, context("receipt-replay"));

    expect((second.output as { wakeupId: string }).wakeupId)
      .toBe((first.output as { wakeupId: string }).wakeupId);
    expect((second.output as { dueAt: string }).dueAt)
      .toBe((first.output as { dueAt: string }).dueAt);
    const count = database.prepare("SELECT COUNT(*) AS n FROM workstream_wakeups").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("leaves no pending wake-up behind when the alarm cannot be armed", async () => {
    const { database, env } = fixture();
    (env as unknown as { WORKSPACE_SCHEDULERS: unknown }).WORKSPACE_SCHEDULERS = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }),
    };
    const { schedule } = wakeupTools(env);

    await expect(schedule.execute(
      { prompt: "Unarmed", delay: "1 hour" },
      context(),
    )).rejects.toThrow();

    // Either it is scheduled and armed, or it does not exist. A pending row with
    // no alarm behind it would never fire in a workspace with nothing else due.
    const rows = database.prepare("SELECT COUNT(*) AS n FROM workstream_wakeups").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("re-arms the alarm when a replayed receipt finds a still-pending wake-up", async () => {
    const { database, env, schedulerRefreshes } = fixture();
    const { schedule } = wakeupTools(env);
    // Stand in for a first attempt that persisted the row and then failed before
    // arming: the row is present, the workspace has never been refreshed.
    database.prepare(
      `INSERT INTO workstream_wakeups
         (id, workspace_id, workstream_id, execution_principal_json, prompt, due_at,
          status, idempotency_key, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)`,
    ).run(
      "00000000-0000-4000-8000-0000000000b1",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      JSON.stringify({ type: "user", userId: USER_ID }),
      "Orphaned by a failed refresh",
      "2026-12-01T00:00:00.000Z",
      "receipt-orphan",
      "2026-08-11",
      "2026-08-11",
    );
    expect(schedulerRefreshes).toHaveLength(0);

    const replay = await schedule.execute(
      { prompt: "Orphaned by a failed refresh", delay: "1 hour" },
      context("receipt-orphan"),
    );

    expect((replay.output as { wakeupId: string }).wakeupId)
      .toBe("00000000-0000-4000-8000-0000000000b1");
    expect(schedulerRefreshes).toHaveLength(1);
    const count = database.prepare("SELECT COUNT(*) AS n FROM workstream_wakeups").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("returns a recoverable error with the hint in output, never a throw", async () => {
    const { env } = fixture();
    const { schedule } = wakeupTools(env);

    const result = await schedule.execute({ prompt: "Too soon", delay: "5s" }, context());

    expect(result.output).toMatchObject({
      error: "wakeup_too_soon",
      hint: expect.stringContaining("seconds from now"),
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

    const result = await schedule.execute(
      { prompt: "One too many", delay: "150 minutes" },
      context("receipt-overflow"),
    );

    const output = result.output as { error: string; pending: unknown[] };
    expect(output.error).toBe("wakeup_limit_reached");
    expect(output.pending).toHaveLength(MAXIMUM_PENDING_WAKEUPS_PER_WORKSTREAM);
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
    await expect(cancel.execute({ wakeupId }, context())).resolves.toMatchObject({
      output: { error: "wakeup_not_pending" },
    });
    expect((await list.execute({}, context())).output).toMatchObject({ wakeups: [] });
  });

  it("does not expose a wake-up belonging to another work stream", async () => {
    const { database, env } = fixture();
    const otherWorkstream = "00000000-0000-4000-8000-000000000009";
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('${otherWorkstream}', '${WORKSPACE_ID}', 'Other', 'Other', 'ad_hoc', '${USER_ID}',
              'idle', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO workstream_wakeups
        (id, workspace_id, workstream_id, execution_principal_json, prompt, due_at,
         status, idempotency_key, version, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-00000000000a', '${WORKSPACE_ID}', '${otherWorkstream}',
              '{"type":"user","userId":"${USER_ID}"}', 'Foreign', '2026-08-12T00:00:00.000Z',
              'pending', 'foreign-receipt', 1, '2026-08-11', '2026-08-11');
    `);
    const { list, cancel } = wakeupTools(env);

    expect((await list.execute({}, context())).output).toMatchObject({ wakeups: [] });
    await expect(cancel.execute(
      { wakeupId: "00000000-0000-4000-8000-00000000000a" },
      context(),
    )).resolves.toMatchObject({ output: { error: "wakeup_not_found" } });
  });
});

describe("firing a due wake-up", () => {
  it("claims the wake-up, notes it in the transcript, and starts a run carrying its id", async () => {
    const { database, env, workflowCreations } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Check the deploy", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;

    const outcome = await fireWorkstreamWakeup(env, pendingRow(database, wakeupId));

    expect(outcome.fired).toBe(true);
    expect(workflowCreations).toHaveLength(1);
    expect(workflowCreations[0]?.params.scheduledWakeupId).toBe(wakeupId);
    expect(workflowCreations[0]?.params.reason).toBe("scheduled_wakeup");

    const row = database.prepare("SELECT status, fired_at FROM workstream_wakeups WHERE id = ?")
      .get(wakeupId) as { status: string; fired_at: string | null };
    expect(row.status).toBe("fired");
    expect(row.fired_at).not.toBeNull();

    const message = database.prepare(
      "SELECT author_type, message_type, text_content FROM messages WHERE workstream_id = ?",
    ).get(WORKSTREAM_ID) as { author_type: string; message_type: string; text_content: string };
    expect(message).toMatchObject({ author_type: "system", message_type: "system" });
    expect(message.text_content).toContain("Check the deploy");
  });

  it("previews a long prompt on a word boundary with a visible marker", async () => {
    const { database, env } = fixture();
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
      env,
      pendingRow(database, (scheduled.output as { wakeupId: string }).wakeupId),
    );

    const message = database.prepare(
      "SELECT text_content FROM messages WHERE workstream_id = ?",
    ).get(WORKSTREAM_ID) as { text_content: string };
    expect(message.text_content).toMatch(/…$/u);
    // The cut lands between words, never inside one.
    expect(message.text_content.replace(/…$/u, "")).toMatch(/\w$/u);
    expect(prompt).toContain(
      message.text_content.replace("Avalon woke this work stream up as scheduled: ", "").replace(/…$/u, ""),
    );
  });

  it("fires a wake-up at most once when two alarms race the same row", async () => {
    const { database, env, workflowCreations } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Only once", delay: "1 hour" },
      context(),
    );
    const row = pendingRow(database, (scheduled.output as { wakeupId: string }).wakeupId);

    const outcomes = [
      await fireWorkstreamWakeup(env, row),
      await fireWorkstreamWakeup(env, row),
    ];

    expect(outcomes.filter((outcome) => outcome.fired)).toHaveLength(1);
    expect(workflowCreations).toHaveLength(1);
  });

  it("releases the claim when the harness cannot be started, so a later alarm retries", async () => {
    const { database, env } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Retry me", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    (env as unknown as { WORKSTREAM_LOOP_WORKFLOW: { create: () => Promise<void> } })
      .WORKSTREAM_LOOP_WORKFLOW = {
        create: async () => { throw new Error("workflow binding unavailable"); },
      };

    await expect(fireWorkstreamWakeup(env, pendingRow(database, wakeupId))).rejects.toThrow();

    const row = database.prepare("SELECT status, fired_at FROM workstream_wakeups WHERE id = ?")
      .get(wakeupId) as { status: string; fired_at: string | null };
    expect(row).toMatchObject({ status: "pending", fired_at: null });
  });

  it("releases the claim when pre-launch preparation fails, not just the launch", async () => {
    const { database, env, workflowCreations } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Transcript write fails", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    const row = pendingRow(database, wakeupId);
    // Fail the transcript batch, which runs after the claim and before the
    // launch. The claim is only safe to hold if every throw between them
    // releases it: once the row leaves `pending`, the scheduler's retry gate
    // cannot see it as due and the wake-up is consumed with no run.
    const realBatch = env.DB.batch.bind(env.DB);
    let failed = false;
    (env.DB as unknown as { batch: unknown }).batch = async (statements: D1PreparedStatement[]) => {
      if (!failed) {
        failed = true;
        throw new Error("D1 batch unavailable");
      }
      return realBatch(statements);
    };

    await expect(fireWorkstreamWakeup(env, row)).rejects.toThrow("D1 batch unavailable");

    expect(workflowCreations).toHaveLength(0);
    const after = database.prepare("SELECT status, fired_at FROM workstream_wakeups WHERE id = ?")
      .get(wakeupId) as { status: string; fired_at: string | null };
    expect(after).toMatchObject({ status: "pending", fired_at: null });
  });

  it("does not duplicate the transcript row when a released wake-up fires again", async () => {
    const { database, env } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Retried after a launch failure", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    const workflow = env.WORKSTREAM_LOOP_WORKFLOW;
    (env as unknown as { WORKSTREAM_LOOP_WORKFLOW: unknown }).WORKSTREAM_LOOP_WORKFLOW = {
      create: async () => { throw new Error("workflow binding unavailable"); },
    };

    await expect(fireWorkstreamWakeup(env, pendingRow(database, wakeupId))).rejects.toThrow();
    (env as unknown as { WORKSTREAM_LOOP_WORKFLOW: unknown }).WORKSTREAM_LOOP_WORKFLOW = workflow;
    expect((await fireWorkstreamWakeup(env, pendingRow(database, wakeupId))).fired).toBe(true);

    const messages = database.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE workstream_id = ? AND message_type = 'system'",
    ).get(WORKSTREAM_ID) as { n: number };
    expect(messages.n).toBe(1);
  });

  it("consumes without running a wake-up whose principal lost workspace membership", async () => {
    const { database, env, workflowCreations } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Revoked", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    database.prepare("UPDATE workspace_members SET status = 'suspended' WHERE user_id = ?")
      .run(USER_ID);

    const outcome = await fireWorkstreamWakeup(env, pendingRow(database, wakeupId));

    expect(outcome.fired).toBe(false);
    expect(workflowCreations).toHaveLength(0);
    const row = database.prepare("SELECT status FROM workstream_wakeups WHERE id = ?")
      .get(wakeupId) as { status: string };
    expect(row.status).toBe("fired");
  });

  it("does not run a wake-up whose work stream was archived", async () => {
    const { database, env, workflowCreations } = fixture();
    const { schedule } = wakeupTools(env);
    const scheduled = await schedule.execute(
      { prompt: "Archived", delay: "1 hour" },
      context(),
    );
    const wakeupId = (scheduled.output as { wakeupId: string }).wakeupId;
    database.prepare("UPDATE workstreams SET archived_at = ? WHERE id = ?")
      .run("2026-08-11T12:00:00.000Z", WORKSTREAM_ID);

    expect((await fireWorkstreamWakeup(env, pendingRow(database, wakeupId))).fired).toBe(false);
    expect(workflowCreations).toHaveLength(0);
  });
});
