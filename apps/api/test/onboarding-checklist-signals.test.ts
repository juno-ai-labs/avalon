import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { onboardingCatalog } from "../src/services/onboarding-checklist-catalog";
import { OnboardingChecklistService } from "../src/services/onboarding-checklist-service";

/**
 * Runs the catalog's signals against the real migrated schema. The stubbed
 * service tests cover behaviour; this covers the part a stub cannot — that each
 * declared signal is valid SQL against the tables it claims to read.
 */

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const userId = "00000000-0000-4000-8000-000000000301";
const teammateId = "00000000-0000-4000-8000-000000000302";
const workspaceId = "00000000-0000-4000-8000-000000000303";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result<T>;
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
    // D1 hands back rows for every statement in a batch, including selects.
    batch: async (statements: D1PreparedStatement[]) => {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) {
        results.push(await (statement as unknown as SqliteD1Statement).all());
      }
      return results;
    },
  } as unknown as D1Database;
}

const openDatabases: DatabaseSync[] = [];

function fixture(): { auth: AuthContext; database: DatabaseSync; env: Env } {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${userId}', 'google-founder', 'founder@example.com', 'Founder', '2026-08-01', '2026-08-01'),
      ('${teammateId}', 'google-teammate', 'teammate@example.com', 'Teammate', '2026-08-01', '2026-08-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${workspaceId}', 'Juno Labs', 'juno-labs', 'global', '${userId}', '2026-08-01', '2026-08-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES ('${workspaceId}', '${userId}', 'owner', 'active', '2026-08-01');
  `);

  return {
    auth: { sessionId: "session-1", userId, workspaceId, region: "global", role: "owner" },
    database,
    env: { DB: sqliteD1(database), APP_ENV: "test", AVALON_REGION: "global" } as unknown as Env,
  };
}

function stateOf(steps: { id: string; state: string }[], id: string): string | undefined {
  return steps.find((step) => step.id === id)?.state;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  for (const database of openDatabases.splice(0)) database.close();
});

describe("onboarding checklist signals", () => {
  it("runs every catalog signal against the migrated schema", async () => {
    const { auth, env } = fixture();
    const checklist = await new OnboardingChecklistService(env, auth).state();

    expect(checklist.steps).toHaveLength(onboardingCatalog.steps.length);
    expect(checklist.steps.every((step) => step.state === "pending")).toBe(true);
  });

  it("completes the connector step from a connection this member can use", async () => {
    const { auth, database, env } = fixture();
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, status,
         model_plugin_id, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000401', '${workspaceId}', 'linear', 'workspace', NULL,
        'Linear', 'healthy', 'plugin_linear', '2026-08-10', '2026-08-10');
    `);

    const checklist = await new OnboardingChecklistService(env, auth).state();
    expect(stateOf(checklist.steps, "connect-tools")).toBe("completed");
    expect(stateOf(checklist.steps, "create-automation")).toBe("pending");
  });

  it("ignores a disabled connection", async () => {
    const { auth, database, env } = fixture();
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, status,
         model_plugin_id, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000402', '${workspaceId}', 'github', 'workspace', NULL,
        'GitHub', 'disabled', 'plugin_github', '2026-08-10', '2026-08-10');
    `);

    const checklist = await new OnboardingChecklistService(env, auth).state();
    expect(stateOf(checklist.steps, "connect-tools")).toBe("pending");
  });

  it("completes the automation step from a subscription in this workspace", async () => {
    const { auth, database, env } = fixture();
    database.exec(`
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000501', '${workspaceId}', '${userId}', 'Daily brief',
        'Morning summary', 'private', '2026-08-10', '2026-08-10');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json, created_by_user_id, created_at)
      VALUES ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000501', 1,
        'Summarize', '[]', '${userId}', '2026-08-10');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, status, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000503', '${workspaceId}',
        '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000502',
        'personal', '${userId}', '{}', 'active', '2026-08-10', '2026-08-10');
    `);

    const checklist = await new OnboardingChecklistService(env, auth).state();
    expect(stateOf(checklist.steps, "create-automation")).toBe("completed");
  });

  it("completes the invite step from an invitation or from a second member", async () => {
    const invited = fixture();
    invited.database.exec(`
      INSERT INTO workspace_invitations
        (id, workspace_id, email, invited_by_user_id, token_hash, expires_at, created_at, role)
      VALUES ('00000000-0000-4000-8000-000000000601', '${workspaceId}', 'teammate@example.com',
        '${userId}', 'hash-1', '2026-08-17', '2026-08-10', 'member');
    `);
    expect(stateOf((await new OnboardingChecklistService(invited.env, invited.auth).state()).steps, "invite-teammate"))
      .toBe("completed");

    const joined = fixture();
    joined.database.exec(`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
        VALUES ('${workspaceId}', '${teammateId}', 'member', 'active', '2026-08-10');
    `);
    expect(stateOf((await new OnboardingChecklistService(joined.env, joined.auth).state()).steps, "invite-teammate"))
      .toBe("completed");
  });

  it("persists a signal completion so a later read does not re-evaluate it", async () => {
    const { auth, database, env } = fixture();
    database.exec(`
      INSERT INTO workspace_invitations
        (id, workspace_id, email, invited_by_user_id, token_hash, expires_at, created_at, role)
      VALUES ('00000000-0000-4000-8000-000000000701', '${workspaceId}', 'teammate@example.com',
        '${userId}', 'hash-2', '2026-08-17', '2026-08-10', 'member');
    `);
    await new OnboardingChecklistService(env, auth).state();

    const stored = database
      .prepare("SELECT state, source, resolved_at FROM onboarding_step_progress WHERE step_id = 'invite-teammate'")
      .get() as { state: string; source: string; resolved_at: string } | undefined;
    expect(stored).toEqual({ state: "completed", source: "signal", resolved_at: "2026-08-10T12:00:00.000Z" });

    // The invitation is revoked outright; the finished step stays finished.
    database.exec("DELETE FROM workspace_invitations");
    const afterRevocation = await new OnboardingChecklistService(env, auth).state();
    expect(stateOf(afterRevocation.steps, "invite-teammate")).toBe("completed");
  });

  it("upgrades a skipped step when the member turns out to have done it", async () => {
    const { auth, database, env } = fixture();
    const service = new OnboardingChecklistService(env, auth);
    await service.setStepState("connect-tools", "skipped");

    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, status,
         model_plugin_id, created_at, updated_at)
      VALUES ('00000000-0000-4000-8000-000000000801', '${workspaceId}', 'google', 'personal', '${userId}',
        'Google Workspace', 'healthy', 'plugin_google', '2026-08-10', '2026-08-10');
    `);

    expect(stateOf((await service.state()).steps, "connect-tools")).toBe("completed");
  });

  it("stores dismissal and guidance per member", async () => {
    const { auth, env } = fixture();
    const service = new OnboardingChecklistService(env, auth);

    const guiding = await service.updateChecklist({ activeStepId: "connect-tools" });
    expect(guiding.activeStepId).toBe("connect-tools");
    expect(guiding.dismissed).toBe(false);

    const dismissed = await service.updateChecklist({ dismissed: true });
    expect(dismissed.dismissed).toBe(true);
    expect(dismissed.activeStepId).toBe("connect-tools");

    const restored = await service.updateChecklist({ dismissed: false });
    expect(restored.dismissed).toBe(false);
  });
});
