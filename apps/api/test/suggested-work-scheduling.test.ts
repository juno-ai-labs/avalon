import { asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import {
  __workOpportunityTesting,
  WorkOpportunityService,
} from "../src/services/work-opportunity-service";
import { createTestD1PreparedStatement, createTestEnv } from "./helpers/cloudflare-test";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const activeUser = "00000000-0000-7000-8000-000000000002";
const dormantUser = "00000000-0000-7000-8000-000000000003";
const databases: DatabaseSync[] = [];
const now = "2026-08-10T12:00:00.000Z";

interface Hooks {
  afterRun?: (sql: string) => void;
  afterAll?: (sql: string) => void;
}

class Statement {
  private values: SQLInputValue[] = [];
  constructor(
    private readonly statement: ReturnType<DatabaseSync["prepare"]>,
    private readonly sql: string,
    private readonly hooks: Hooks,
  ) {}
  bind(...values: unknown[]): this { this.values = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> { return (this.statement.get(...this.values) as T | undefined) ?? null; }
  async all<T>(): Promise<{ success: true; results: T[]; meta: Record<string, unknown> }> {
    const results = this.statement.all(...this.values) as T[];
    this.hooks.afterAll?.(this.sql);
    return { success: true, results, meta: {} };
  }
  async run<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    const result = this.statement.run(...this.values);
    this.hooks.afterRun?.(this.sql);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class D1Adapter {
  constructor(
    private readonly database: DatabaseSync,
    private readonly hooks: Hooks = {},
  ) {}
  prepare(sql: string): D1PreparedStatement {
    return createTestD1PreparedStatement(new Statement(this.database.prepare(sql), sql, this.hooks));
  }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function migratedDatabase(): DatabaseSync {
  const database = legacyProductSqliteDatabase();
  databases.push(database);
  return database;
}

function environment(
  database: DatabaseSync,
  overrides: Partial<Env> = {},
  afterRun?: (sql: string) => void,
  afterAll?: (sql: string) => void,
): Env {
  return createTestEnv({
    DB: new D1Adapter(database, { ...(afterRun ? { afterRun } : {}), ...(afterAll ? { afterAll } : {}) }),
    APP_ENV: "development",
    AVALON_REGION: "global",
    ...overrides,
  });
}

function auth(userId: string): AuthContext {
  return { sessionId: "session", userId, workspaceId, region: "global", role: "owner" } as AuthContext;
}

function seed(database: DatabaseSync, lastSeen: Record<string, string | null>): void {
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${activeUser}', 'subject-one', 'one@example.com', 'One User', '${now}', '${now}'),
      ('${dormantUser}', 'subject-two', 'two@example.com', 'Two User', '${now}', '${now}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', '${activeUser}', '${now}', '${now}');
  `);
  for (const [userId, seenAt] of Object.entries(lastSeen)) {
    database.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at, last_seen_at)
       VALUES (?, ?, 'member', 'active', ?, ?)`,
    ).run(workspaceId, userId, now, seenAt);
  }
}

function insertOpportunity(database: DatabaseSync, id: string, updatedAt = now): void {
  database.prepare(`
    INSERT INTO work_opportunities
     (id, workspace_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
      admission_reasoning, provider_icon, source_label, source_fingerprint, version,
      display_prompt_hash, execution_prompt_hash, status, expires_at, created_at, updated_at)
     VALUES (?, ?, 'workspace', NULL, 'Handle the blocker', 'Investigate the blocker.',
      'Urgent and actionable.', 'plug', 'Connected activity', ?, 1,
      'display-hash', 'execution-hash', 'active', '2027-08-07T00:00:00.000Z', ?, ?)
  `).run(id, workspaceId, `fingerprint-${id}`, updatedAt, updatedAt);
}

describe("suggested-work read path", () => {
  it("serves the stored ranking without ranking anything", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    const first = "00000000-0000-7000-8000-000000000201";
    const second = "00000000-0000-7000-8000-000000000202";
    insertOpportunity(database, first, "2026-08-09T00:00:00.000Z");
    insertOpportunity(database, second, "2026-08-10T00:00:00.000Z");
    // Stored deliberately against recency order: the point of the read path is
    // that it returns the ranking, not the newest thing.
    database.prepare(`
      INSERT INTO suggested_work_sets
       (workspace_id, user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        status, created_at, updated_at)
       VALUES (?, ?, 'fingerprint', ?, 'Ranked', 'ready', ?, ?)
    `).run(workspaceId, activeUser, JSON.stringify([first, second]), now, now);

    const page = await new WorkOpportunityService(environment(database), auth(activeUser)).list(4);

    expect(page.items.map((item) => item.id)).toEqual([first, second]);
    // Nothing was asked for: the set is current and no ranking is outstanding.
    expect(database.prepare(
      "SELECT due_at FROM suggested_work_sets WHERE user_id = ?",
    ).get(activeUser)).toEqual({ due_at: null });
  });

  it("drops a dismissed suggestion from the stored set and asks for a replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    const kept = "00000000-0000-7000-8000-000000000203";
    const dismissed = "00000000-0000-7000-8000-000000000204";
    insertOpportunity(database, kept);
    insertOpportunity(database, dismissed);
    database.prepare(`
      INSERT INTO suggested_work_sets
       (workspace_id, user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        status, created_at, updated_at)
       VALUES (?, ?, 'fingerprint', ?, 'Ranked', 'ready', ?, ?)
    `).run(workspaceId, activeUser, JSON.stringify([kept, dismissed]), now, now);
    const service = new WorkOpportunityService(environment(database), auth(activeUser));

    await service.dismiss(dismissed);
    const page = await service.list(4);

    expect(page.items.map((item) => item.id)).toEqual([kept]);
    expect(database.prepare("SELECT due_at FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: now });
  });

  it("falls back to recency and asks for a ranking when nothing is stored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    const older = "00000000-0000-7000-8000-000000000205";
    const newer = "00000000-0000-7000-8000-000000000206";
    insertOpportunity(database, older, "2026-08-08T00:00:00.000Z");
    insertOpportunity(database, newer, "2026-08-09T00:00:00.000Z");

    const page = await new WorkOpportunityService(environment(database), auth(activeUser)).list(4);

    // Something, rather than the blank section a member used to get.
    expect(page.items.map((item) => item.id)).toEqual([newer, older]);
    expect(database.prepare("SELECT due_at FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: now });
  });
});

// The "suggested-work scheduler" suite is gone with the cron pass it covered.
// `processDueSuggestedWork` returned immediately once the authority was open, so
// it did nothing in any supported deployment; WorkspaceDO's product alarm claims
// due rankings and launches the workflow instead, with the same dormant/active
// filtering (`workspace-do.ts:1420-1441`). What the suite proved about *who*
// gets ranked now lives there and is untested — see `docs/potential-bugs.md`.

describe("suggested-work request rules", () => {
  it("asks for a refill when a ranked suggestion is no longer showable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    const kept = "00000000-0000-7000-8000-00000000020d";
    const started = "00000000-0000-7000-8000-00000000020e";
    insertOpportunity(database, kept);
    insertOpportunity(database, started);
    database.prepare(`
      INSERT INTO suggested_work_sets
       (workspace_id, user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        status, created_at, updated_at)
       VALUES (?, ?, 'fingerprint', ?, 'Ranked', 'ready', ?, ?)
    `).run(workspaceId, activeUser, JSON.stringify([kept, started]), now, now);
    // Started rather than dismissed: `dismiss()` asks for its own refill, and
    // this is the hole nothing on the write path would have noticed.
    database.prepare("UPDATE work_opportunities SET status = 'started' WHERE id = ?").run(started);

    const page = await new WorkOpportunityService(environment(database), auth(activeUser)).list(4);

    expect(page.items.map((item) => item.id)).toEqual([kept]);
    expect(database.prepare("SELECT due_at FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: "2026-08-10T12:02:00.000Z" });
  });

  // "never settles on an empty ranking while candidates exist" is gone with the
  // cron scheduler half of the trap it described: an empty set stored against a
  // real fingerprint makes the read path ask for a ranking and the scheduler
  // cache-hit and clear the request, forever. The read-path half is still here
  // and still asserted; the scheduler half is WorkspaceDO's alarm now. The trap
  // is recorded in `docs/potential-bugs.md` so it is not rediscovered the hard
  // way.

  it("asks for nothing when a member has no opportunities at all", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    database.prepare(`
      INSERT INTO suggested_work_sets
       (workspace_id, user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        status, created_at, updated_at)
       VALUES (?, ?, 'fingerprint', '[]', 'No eligible opportunities.', 'ready', ?, ?)
    `).run(workspaceId, activeUser, now, now);
    const service = new WorkOpportunityService(environment(database), auth(activeUser));

    await service.list(4);
    await service.list(4);

    // An empty set is this member's steady state, not a gap to be filled. Asking
    // on every read cost a write per request and a scheduler claim per pass.
    expect(database.prepare("SELECT due_at FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: null });
  });

  it("marks every active member due, not just the ones an admission prompt listed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now, [dormantUser]: null });
    database.prepare("UPDATE workspace_members SET status = 'suspended' WHERE user_id = ?").run(dormantUser);

    await __workOpportunityTesting.markWorkspaceSuggestedWorkDue(environment(database), workspaceId, 0);

    expect(database.prepare("SELECT user_id, due_at FROM suggested_work_sets ORDER BY user_id").all())
      .toEqual([{ user_id: activeUser, due_at: now }]);
  });
});
