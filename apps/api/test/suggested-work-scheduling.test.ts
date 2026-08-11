import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { processDueSuggestedWork, WorkOpportunityService } from "../src/services/work-opportunity-service";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const activeUser = "00000000-0000-7000-8000-000000000002";
const dormantUser = "00000000-0000-7000-8000-000000000003";
const migrationsDirectory = new URL("../../../packages/db/migrations/", import.meta.url);
const databases: DatabaseSync[] = [];
const now = "2026-08-10T12:00:00.000Z";

class Statement {
  private values: SQLInputValue[] = [];
  constructor(private readonly statement: ReturnType<DatabaseSync["prepare"]>) {}
  bind(...values: unknown[]): this { this.values = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> { return (this.statement.get(...this.values) as T | undefined) ?? null; }
  async all<T>(): Promise<{ success: true; results: T[]; meta: Record<string, unknown> }> {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }
  async run<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class D1Adapter {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): Statement { return new Statement(this.database.prepare(sql)); }
  async batch(statements: Statement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(file, migrationsDirectory), "utf8"));
  }
  databases.push(database);
  return database;
}

function environment(database: DatabaseSync, overrides: Partial<Env> = {}): Env {
  return {
    DB: new D1Adapter(database),
    APP_ENV: "development",
    AVALON_REGION: "global",
    ...overrides,
  } as unknown as Env;
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

function markDue(database: DatabaseSync, userId: string, dueAt: string): void {
  database.prepare(`
    INSERT INTO suggested_work_sets
     (workspace_id, user_id, candidate_fingerprint, due_at, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, ?)
  `).run(workspaceId, userId, dueAt, now, now);
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

describe("suggested-work scheduler", () => {
  it("ranks a member who is around and leaves a dormant one for when they return", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, {
      [activeUser]: "2026-08-10T11:55:00.000Z",
      [dormantUser]: "2026-07-01T00:00:00.000Z",
    });
    insertOpportunity(database, "00000000-0000-7000-8000-000000000207");
    markDue(database, activeUser, "2026-08-10T11:00:00.000Z");
    markDue(database, dormantUser, "2026-08-10T11:00:00.000Z");

    // No OPENROUTER_API_KEY, so ranking takes its no-model path and settles on
    // recency. What is under test is who gets ranked at all.
    await processDueSuggestedWork(environment(database));

    expect(database.prepare("SELECT due_at, status FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: null, status: "ready" });
    // Still outstanding rather than discarded: their request survives until the
    // authentication middleware records them again.
    expect(database.prepare("SELECT due_at FROM suggested_work_sets WHERE user_id = ?").get(dormantUser))
      .toEqual({ due_at: "2026-08-10T11:00:00.000Z" });
  });

  it("ignores a set that is not due yet", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    insertOpportunity(database, "00000000-0000-7000-8000-000000000208");
    markDue(database, activeUser, "2026-08-10T12:05:00.000Z");

    await processDueSuggestedWork(environment(database));

    expect(database.prepare("SELECT due_at, status FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: "2026-08-10T12:05:00.000Z", status: "stale" });
  });

  it("clears an outstanding request when the candidates turn out not to have changed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    const opportunityId = "00000000-0000-7000-8000-000000000209";
    insertOpportunity(database, opportunityId);
    // The fingerprint a candidate list of exactly this one opportunity hashes to.
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(`${opportunityId}:1`),
    ))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    database.prepare(`
      INSERT INTO suggested_work_sets
       (workspace_id, user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        status, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Ranked', 'ready', ?, ?, ?)
    `).run(workspaceId, activeUser, fingerprint, JSON.stringify([opportunityId]), now, now, now);

    await processDueSuggestedWork(environment(database));

    // A due time left behind is re-claimed on every pass forever.
    expect(database.prepare("SELECT due_at, ranking_reasoning FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: null, ranking_reasoning: "Ranked" });
  });
});
