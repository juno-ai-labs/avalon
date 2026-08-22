import { asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import {
  __workOpportunityTesting,
  processDueSuggestedWork,
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

/**
 * The write that stores a ranking, which happens while the lease is held.
 *
 * Matched on collapsed whitespace so that rewrapping the statement cannot
 * quietly stop this from matching — a hook that never fires makes the tests
 * below pass without testing anything, so they also assert that it fired.
 */
function isRankingWrite(sql: string): boolean {
  const collapsed = sql.replace(/\s+/gu, " ");
  return collapsed.includes("INSERT INTO suggested_work_sets")
    && collapsed.includes("opportunity_ids_json")
    && collapsed.includes("ranking_reasoning");
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

  it("holds its lease across the whole run, including the provisional write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    insertOpportunity(database, "00000000-0000-7000-8000-00000000020a");
    markDue(database, activeUser, "2026-08-10T11:00:00.000Z");
    const leasesDuringRun: Array<string | null> = [];

    await processDueSuggestedWork(environment(database, {}, (sql) => {
      if (!isRankingWrite(sql)) return;
      const row = database.prepare("SELECT lease_id FROM suggested_work_sets WHERE user_id = ?")
        .get(activeUser) as { lease_id: string | null };
      leasesDuringRun.push(row.lease_id);
    }));

    // A write that released the lease mid-run let the next scheduler pass claim
    // the same member and run a second tournament beside the first.
    expect(leasesDuringRun.length).toBeGreaterThan(0);
    expect(leasesDuringRun.every((lease) => lease !== null)).toBe(true);
    expect(database.prepare("SELECT lease_id, due_at FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ lease_id: null, due_at: null });
  });

  it("keeps a request that arrives while the ranking is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    insertOpportunity(database, "00000000-0000-7000-8000-00000000020b");
    markDue(database, activeUser, "2026-08-10T11:00:00.000Z");
    let interrupted = false;

    await processDueSuggestedWork(environment(database, {}, (sql) => {
      if (interrupted || !isRankingWrite(sql)) return;
      interrupted = true;
      // Someone dismisses a suggestion while the tournament is still going,
      // exactly as `dismiss()` writes it — a new due time and a new request.
      database.prepare(
        "UPDATE suggested_work_sets SET due_at = ?, request_seq = request_seq + 1 WHERE user_id = ?",
      ).run("2026-08-10T12:30:00.000Z", activeUser);
    }));

    expect(interrupted).toBe(true);
    // Settling cleared only the request it claimed, so this one survives to be
    // served on a later pass rather than being silently dropped.
    expect(database.prepare("SELECT due_at, lease_id FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: "2026-08-10T12:30:00.000Z", lease_id: null });
  });

  it("keeps a request raised mid-run that does not move the due time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    insertOpportunity(database, "00000000-0000-7000-8000-00000000020f");
    markDue(database, activeUser, "2026-08-10T11:00:00.000Z");
    let interrupted = false;
    const pending: Array<Promise<void>> = [];

    await processDueSuggestedWork(environment(database, {}, (sql) => {
      if (interrupted || !isRankingWrite(sql)) return;
      interrupted = true;
      // An admission lands mid-tournament, through the helper the write path
      // actually calls rather than a hand-written statement — the point of the
      // test is what that helper does. It debounces two minutes out, which is
      // *later* than the 11:00 request being ranked, so `MIN` keeps 11:00 and
      // `due_at` does not move at all: the column is left byte-identical.
      pending.push(__workOpportunityTesting.markSuggestedWorkDue(
        environment(database), workspaceId, [activeUser],
      ));
    }));

    await Promise.all(pending);
    expect(interrupted).toBe(true);
    // Identifying the request by its due time could not see this one, so the
    // completed run cleared it and the member kept a set that was already out of
    // date. The sequence number is what makes the ask visible.
    expect(database.prepare("SELECT due_at, lease_id FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: "2026-08-10T11:00:00.000Z", lease_id: null });
  });

  it("does not claim a request that was withdrawn after it was selected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    insertOpportunity(database, "00000000-0000-7000-8000-000000000210");
    markDue(database, activeUser, "2026-08-10T11:00:00.000Z");
    let selected = false;

    await processDueSuggestedWork(environment(database, {}, () => undefined, (sql) => {
      if (selected || !sql.includes("FROM suggested_work_sets s")) return;
      selected = true;
      // Between the scan and the claim, the request is superseded.
      database.prepare("UPDATE suggested_work_sets SET request_seq = request_seq + 1, due_at = ? WHERE user_id = ?")
        .run("2026-08-10T14:00:00.000Z", activeUser);
    }));

    expect(selected).toBe(true);
    // Claimed on the exact request that was selected, so this pass declines it
    // rather than spending a tournament answering a request nobody made.
    expect(database.prepare("SELECT due_at, lease_id, last_ranked_at FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: "2026-08-10T14:00:00.000Z", lease_id: null, last_ranked_at: null });
  });

  it("re-ranks for impressions even though the candidates are unchanged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    const opportunityId = "00000000-0000-7000-8000-00000000020c";
    insertOpportunity(database, opportunityId);
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(`${opportunityId}:1`),
    ))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    database.prepare(`
      INSERT INTO suggested_work_sets
       (workspace_id, user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        status, last_ranked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Ranked an hour ago', 'ready', ?, ?, ?)
    `).run(workspaceId, activeUser, fingerprint, JSON.stringify([opportunityId]), now, now, now);
    const service = new WorkOpportunityService(environment(database), auth(activeUser));

    vi.setSystemTime(new Date("2026-08-10T13:00:01.000Z"));
    await service.recordImpressions([opportunityId]);
    await processDueSuggestedWork(environment(database));

    // Impressions are not in the fingerprint, so asking for a ranking without
    // also invalidating the hash short-circuited straight back to the stored set.
    expect(database.prepare("SELECT ranking_reasoning FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .not.toEqual({ ranking_reasoning: "Ranked an hour ago" });
  });
});

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

  it("never settles on an empty ranking while candidates exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const database = migratedDatabase();
    seed(database, { [activeUser]: now });
    const opportunityId = "00000000-0000-7000-8000-000000000211";
    insertOpportunity(database, opportunityId);
    markDue(database, activeUser, "2026-08-10T11:00:00.000Z");
    const service = new WorkOpportunityService(environment(database), auth(activeUser));

    await processDueSuggestedWork(environment(database));
    const stored = database.prepare("SELECT opportunity_ids_json, due_at FROM suggested_work_sets WHERE user_id = ?")
      .get(activeUser) as { opportunity_ids_json: string; due_at: string | null };

    // An empty set stored against the real fingerprint is a trap: the read path
    // calls it unranked and asks, the scheduler cache-hits on the fingerprint and
    // clears the request without ranking, and the two do that to each other
    // forever, a candidate load and a ranking slot at a time.
    expect(JSON.parse(stored.opportunity_ids_json)).toEqual([opportunityId]);
    expect(stored.due_at).toBeNull();

    await service.list(4);

    expect(database.prepare("SELECT due_at FROM suggested_work_sets WHERE user_id = ?").get(activeUser))
      .toEqual({ due_at: null });
  });

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
