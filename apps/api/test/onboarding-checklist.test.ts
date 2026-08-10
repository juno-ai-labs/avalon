import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import {
  onboardingCatalog,
  onboardingStepsForRole,
  type OnboardingCatalog,
} from "../src/services/onboarding-checklist-catalog";
import { OnboardingChecklistService } from "../src/services/onboarding-checklist-service";

interface RecordedStatement {
  sql: string;
  values: unknown[];
}

/**
 * A D1 stand-in that answers by SQL shape. Signal statements are keyed by the
 * table they read, so a test declares "an automation exists" rather than
 * mirroring the catalog's SQL.
 */
class StubDatabase {
  readonly writes: RecordedStatement[] = [];
  progress: Record<string, { state: string; source: string; resolved_at: string }> = {};
  checklistState: { active_step_id: string | null; dismissed_version: string | null } | null = null;
  satisfiedTables = new Set<string>();

  readonly binding = {
    prepare: (sql: string) => new StubStatement(this, sql) as unknown as D1PreparedStatement,
    batch: async <T = unknown>(statements: D1PreparedStatement[]) =>
      Promise.all(
        statements.map((statement) => (statement as unknown as StubStatement).all<T>()),
      ) as unknown as Promise<D1Result<T>[]>,
  } as unknown as D1Database;

  rowsFor(statement: RecordedStatement): unknown[] {
    if (statement.sql.startsWith("SELECT step_id")) {
      return Object.entries(this.progress).map(([stepId, row]) => ({ step_id: stepId, ...row }));
    }
    if (statement.sql.startsWith("SELECT active_step_id")) {
      return this.checklistState ? [this.checklistState] : [];
    }
    if (statement.sql.startsWith("SELECT 1 FROM")) {
      const table = /SELECT 1 FROM (\w+)/u.exec(statement.sql)?.[1] ?? "";
      const unionTable = /UNION ALL SELECT 1 FROM (\w+)/u.exec(statement.sql)?.[1] ?? "";
      return this.satisfiedTables.has(table) || this.satisfiedTables.has(unionTable) ? [{ 1: 1 }] : [];
    }
    this.writes.push(statement);
    return [];
  }
}

class StubStatement {
  private values: unknown[] = [];

  constructor(private readonly database: StubDatabase, private readonly rawSql: string) {}

  bind(...values: unknown[]): StubStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.rowsFor(this.record())[0] ?? null) as T | null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.database.rowsFor(this.record()) as T[],
      meta: {},
    } as unknown as D1Result<T>;
  }

  async run<T>(): Promise<D1Result<T>> {
    this.database.rowsFor(this.record());
    return { success: true, results: [], meta: { changes: 1 } } as unknown as D1Result<T>;
  }

  record(): RecordedStatement {
    return { sql: this.rawSql.replace(/\s+/gu, " ").trim(), values: this.values };
  }
}

const workspaceId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1";
const userId = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d2";

const ownerAuth: AuthContext = {
  sessionId: "session-1",
  userId,
  workspaceId,
  region: "global",
  role: "owner",
};

const memberAuth: AuthContext = { ...ownerAuth, role: "member" };

function environment(database: StubDatabase): Env {
  return { DB: database.binding, APP_ENV: "test", AVALON_REGION: "global" } as unknown as Env;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
});

describe("onboarding checklist", () => {
  it("serves the catalog with nothing resolved for a fresh organization", async () => {
    const database = new StubDatabase();
    const checklist = await new OnboardingChecklistService(environment(database), ownerAuth).state();

    expect(checklist.title).toBe(onboardingCatalog.title);
    expect(checklist.steps.map((step) => step.id)).toEqual(onboardingCatalog.steps.map((step) => step.id));
    expect(checklist.steps.every((step) => step.state === "pending")).toBe(true);
    expect(checklist.completedCount).toBe(0);
    expect(checklist.complete).toBe(false);
    expect(checklist.dismissed).toBe(false);
    // Every step ships the guidance a client needs to point at something.
    expect(checklist.steps.every((step) => step.spotlight !== null)).toBe(true);
  });

  it("completes a step from real workspace data and records it durably", async () => {
    const database = new StubDatabase();
    database.satisfiedTables.add("automation_subscriptions");
    const checklist = await new OnboardingChecklistService(environment(database), ownerAuth).state();

    const automationStep = checklist.steps.find((step) => step.id === "create-automation");
    expect(automationStep?.state).toBe("completed");
    expect(automationStep?.source).toBe("signal");
    expect(automationStep?.resolvedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(checklist.completedCount).toBe(1);

    const recorded = database.writes.find((write) => write.sql.includes("INSERT INTO onboarding_step_progress"));
    expect(recorded?.values).toEqual([workspaceId, userId, "create-automation", "2026-08-10T12:00:00.000Z"]);
  });

  it("keeps a completed step completed after the underlying data goes away", async () => {
    const database = new StubDatabase();
    database.progress = {
      "connect-tools": { state: "completed", source: "signal", resolved_at: "2026-08-01T09:00:00.000Z" },
    };
    const checklist = await new OnboardingChecklistService(environment(database), ownerAuth).state();

    expect(checklist.steps.find((step) => step.id === "connect-tools")?.state).toBe("completed");
    expect(database.writes.some((write) => write.sql.includes("INSERT INTO onboarding_step_progress"))).toBe(false);
  });

  it("lets a member resolve steps in any order and undo them", async () => {
    const database = new StubDatabase();
    const service = new OnboardingChecklistService(environment(database), ownerAuth);

    database.progress["invite-teammate"] = {
      state: "completed",
      source: "manual",
      resolved_at: "2026-08-10T12:00:00.000Z",
    };
    const marked = await service.setStepState("invite-teammate", "completed");
    expect(marked.steps.find((step) => step.id === "invite-teammate")?.state).toBe("completed");
    expect(marked.steps.find((step) => step.id === "connect-tools")?.state).toBe("pending");

    delete database.progress["invite-teammate"];
    const undone = await service.setStepState("invite-teammate", "pending");
    expect(undone.steps.find((step) => step.id === "invite-teammate")?.state).toBe("pending");
    expect(database.writes.some((write) => write.sql.startsWith("DELETE FROM onboarding_step_progress"))).toBe(true);
  });

  it("hides steps the member's role cannot act on", async () => {
    const database = new StubDatabase();
    const checklist = await new OnboardingChecklistService(environment(database), memberAuth).state();

    expect(checklist.steps.some((step) => step.id === "invite-teammate")).toBe(false);
    expect(checklist.totalCount).toBe(onboardingStepsForRole("member").length);
    await expect(
      new OnboardingChecklistService(environment(database), memberAuth).setStepState("invite-teammate", "completed"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("reports completion once every step is resolved, counting skips as resolved", async () => {
    const database = new StubDatabase();
    database.progress = Object.fromEntries(
      onboardingStepsForRole("owner").map((step, index) => [
        step.id,
        {
          state: index === 0 ? "skipped" : "completed",
          source: "manual",
          resolved_at: "2026-08-10T11:00:00.000Z",
        },
      ]),
    );
    const checklist = await new OnboardingChecklistService(environment(database), ownerAuth).state();

    expect(checklist.remainingCount).toBe(0);
    expect(checklist.complete).toBe(true);
    expect(checklist.completedCount).toBe(onboardingStepsForRole("owner").length - 1);
  });

  it("tracks the active step so guidance can follow the member, and drops it once resolved", async () => {
    const database = new StubDatabase();
    const service = new OnboardingChecklistService(environment(database), ownerAuth);

    database.checklistState = { active_step_id: "connect-tools", dismissed_version: null };
    const guiding = await service.updateChecklist({ activeStepId: "connect-tools" });
    expect(guiding.activeStepId).toBe("connect-tools");

    database.progress["connect-tools"] = {
      state: "completed",
      source: "manual",
      resolved_at: "2026-08-10T12:00:00.000Z",
    };
    const resolved = await service.state();
    expect(resolved.activeStepId).toBeNull();
  });

  it("re-offers the checklist when the catalog changes after a dismissal", async () => {
    const database = new StubDatabase();
    database.checklistState = { active_step_id: null, dismissed_version: onboardingCatalog.version };

    const dismissed = await new OnboardingChecklistService(environment(database), ownerAuth).state();
    expect(dismissed.dismissed).toBe(true);

    const revisedCatalog: OnboardingCatalog = { ...onboardingCatalog, version: "2099-01-01.1" };
    const revised = await new OnboardingChecklistService(environment(database), ownerAuth, revisedCatalog).state();
    expect(revised.dismissed).toBe(false);
  });

  it("rejects steps that are not in the catalog", async () => {
    const database = new StubDatabase();
    await expect(
      new OnboardingChecklistService(environment(database), ownerAuth).setStepState("not-a-step", "completed"),
    ).rejects.toMatchObject({ status: 404, code: "onboarding_step_not_found" });
  });
});
