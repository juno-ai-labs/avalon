import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { enqueueActivityOpportunity } from "../src/services/work-opportunity-batching";
import { __workOpportunityTesting, WorkOpportunityService } from "../src/services/work-opportunity-service";
import { WorkstreamService } from "../src/services/workstream-service";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestEnv } from "./helpers/cloudflare-test";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const userOne = "00000000-0000-7000-8000-000000000002";
const userTwo = "00000000-0000-7000-8000-000000000003";
const migrationsDirectory = new URL("../../../packages/db/migrations/", import.meta.url);
const databases: DatabaseSync[] = [];

class Statement {
  private values: SQLInputValue[] = [];
  constructor(
    private readonly statement: ReturnType<DatabaseSync["prepare"]>,
    private readonly sql: string,
    private readonly afterFirst?: (sql: string) => void,
  ) {}
  bind(...values: unknown[]): this { this.values = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> {
    const value = (this.statement.get(...this.values) as T | undefined) ?? null;
    this.afterFirst?.(this.sql);
    return value;
  }
  async all<T>(): Promise<{ success: true; results: T[]; meta: Record<string, unknown> }> {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }
  async run<T>(): Promise<{ success: true; results: T[]; meta: { changes: number } }> {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class D1Adapter {
  constructor(
    private readonly database: DatabaseSync,
    private readonly afterFirst?: (sql: string) => void,
  ) {}
  prepare(sql: string): D1PreparedStatement {
    return createTestD1PreparedStatement(new Statement(this.database.prepare(sql), sql, this.afterFirst));
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
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(file, migrationsDirectory), "utf8"));
  }
  databases.push(database);
  return database;
}

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${userOne}', 'subject-one', 'one@example.com', 'One User', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
      ('${userTwo}', 'subject-two', 'two@example.com', 'Two User', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', '${userOne}', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES ('${workspaceId}', '${userOne}', 'owner', 'active', '2026-08-01T00:00:00.000Z'),
             ('${workspaceId}', '${userTwo}', 'member', 'active', '2026-08-01T00:00:00.000Z');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
       granted_scopes_json, model_plugin_id, status, created_at, updated_at)
      VALUES
      ('00000000-0000-7000-8000-000000000011', '${workspaceId}', 'github', 'workspace', NULL, 'tenant-gh', 'GitHub', '[]', 'plugin_github', 'healthy', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
      ('00000000-0000-7000-8000-000000000012', '${workspaceId}', 'linear', 'workspace', NULL, 'tenant-linear', 'Linear', '[]', 'plugin_linear', 'healthy', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
      ('00000000-0000-7000-8000-000000000013', '${workspaceId}', 'google', 'personal', '${userOne}', 'one@example.com', 'Google One', '[]', 'plugin_google_one', 'healthy', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
      ('00000000-0000-7000-8000-000000000014', '${workspaceId}', 'granola', 'personal', '${userTwo}', 'granola-two', 'Granola Two', '[]', 'plugin_granola_two', 'healthy', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  `);
}

function insertActivity(
  database: DatabaseSync,
  id: string,
  connectionId: string,
  scope: "personal" | "workspace",
  ownerId: string | null,
): void {
  database.prepare(`
    INSERT INTO activities
      (id, workspace_id, connection_id, connection_scope, connection_owner_user_id,
       provider, provider_event_id, event_type, occurred_at, received_at, title, dedupe_key)
    VALUES (?, ?, ?, ?, ?, 'test', ?, 'changed', ?, ?, ?, ?)
  `).run(
    id, workspaceId, connectionId, scope, ownerId, `event-${id}`,
    new Date().toISOString(), new Date().toISOString(), `Activity ${id}`, `dedupe-${id}`,
  );
}

function environment(database: DatabaseSync, overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    DB: new D1Adapter(database),
    APP_ENV: "development",
    AVALON_REGION: "global",
    ...overrides,
  });
}

function insertOpportunity(database: DatabaseSync, id: string, version = 1): void {
  database.prepare(`
    INSERT INTO work_opportunities
     (id, workspace_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
      admission_reasoning, provider_icon, source_label, source_fingerprint, version,
      display_prompt_hash, execution_prompt_hash, status, expires_at, created_at, updated_at)
     VALUES (?, ?, 'workspace', NULL, 'Handle the blocker', 'Investigate and resolve the blocker.',
      'The blocker is urgent and actionable.', 'plug', 'Connected activity', ?, ?,
      'display-hash', 'execution-hash', 'active', '2027-08-07T00:00:00.000Z',
      '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z')
  `).run(id, workspaceId, `fingerprint-${id}`, version);
}

function insertOpportunityWorkstream(
  database: DatabaseSync,
  opportunityId: string,
  workstreamId: string,
  messageId: string,
): void {
  const at = "2026-08-07T00:00:00.000Z";
  database.prepare(`
    INSERT INTO workstreams
     (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
      next_sequence_number, last_activity_at, created_at, updated_at, created_from_opportunity_id,
      opportunity_version, opportunity_display_prompt_hash, opportunity_execution_prompt_hash)
     VALUES (?, ?, 'Handle the blocker', 'Handle the blocker', 'ad_hoc', ?, 'failed',
      2, ?, ?, ?, ?, 1, 'display-hash', 'execution-hash')
  `).run(workstreamId, workspaceId, userOne, at, at, at, opportunityId);
  database.prepare(`
    INSERT INTO messages
     (id, client_message_id, workspace_id, workstream_id, author_type, message_type,
      text_content, sequence_number, created_at)
     VALUES (?, ?, ?, ?, 'agent', 'text', 'Investigate and resolve the blocker.', 1, ?)
  `).run(messageId, `opportunity:${opportunityId}:v1`, workspaceId, workstreamId, at);
}

describe("suggested-work aggregation", () => {
  it("shares workspace connector types, isolates private owners, debounces, and caps the window at one hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T10:00:00.000Z"));
    const database = migratedDatabase();
    seed(database);
    insertActivity(database, "00000000-0000-7000-8000-000000000101", "00000000-0000-7000-8000-000000000011", "workspace", null);
    await enqueueActivityOpportunity(environment(database), "00000000-0000-7000-8000-000000000101");
    expect(database.prepare("SELECT partition_key, process_after FROM opportunity_batch_windows").get()).toEqual({
      partition_key: "workspace",
      process_after: "2026-08-07T10:10:00.000Z",
    });

    vi.setSystemTime(new Date("2026-08-07T10:09:00.000Z"));
    insertActivity(database, "00000000-0000-7000-8000-000000000102", "00000000-0000-7000-8000-000000000012", "workspace", null);
    await enqueueActivityOpportunity(environment(database), "00000000-0000-7000-8000-000000000102");
    expect(database.prepare("SELECT COUNT(*) AS count FROM opportunity_batch_windows").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT process_after FROM opportunity_batch_windows").get()).toEqual({ process_after: "2026-08-07T10:19:00.000Z" });

    vi.setSystemTime(new Date("2026-08-07T10:55:00.000Z"));
    insertActivity(database, "00000000-0000-7000-8000-000000000103", "00000000-0000-7000-8000-000000000011", "workspace", null);
    await enqueueActivityOpportunity(environment(database), "00000000-0000-7000-8000-000000000103");
    expect(database.prepare("SELECT process_after FROM opportunity_batch_windows").get()).toEqual({ process_after: "2026-08-07T11:00:00.000Z" });

    insertActivity(database, "00000000-0000-7000-8000-000000000104", "00000000-0000-7000-8000-000000000013", "personal", userOne);
    insertActivity(database, "00000000-0000-7000-8000-000000000105", "00000000-0000-7000-8000-000000000014", "personal", userTwo);
    insertActivity(database, "00000000-0000-7000-8000-000000000106", "00000000-0000-7000-8000-000000000011", "workspace", null);
    database.prepare("UPDATE activities SET visibility_json = ? WHERE id = ?").run(
      JSON.stringify({ allowedUserIds: [userOne] }),
      "00000000-0000-7000-8000-000000000106",
    );
    await enqueueActivityOpportunity(environment(database), "00000000-0000-7000-8000-000000000104");
    await enqueueActivityOpportunity(environment(database), "00000000-0000-7000-8000-000000000105");
    await enqueueActivityOpportunity(environment(database), "00000000-0000-7000-8000-000000000106");
    expect(database.prepare("SELECT partition_key FROM opportunity_batch_windows ORDER BY partition_key").all()).toEqual([
      { partition_key: `personal:${userOne}` },
      { partition_key: `personal:${userTwo}` },
      { partition_key: `restricted:00000000-0000-7000-8000-000000000011:${userOne}` },
      { partition_key: "workspace" },
    ]);
  });

  it("moves an event into a new window when the selected window is claimed before insertion", async () => {
    const database = migratedDatabase();
    seed(database);
    insertActivity(database, "00000000-0000-7000-8000-000000000107", "00000000-0000-7000-8000-000000000011", "workspace", null);
    insertActivity(database, "00000000-0000-7000-8000-000000000108", "00000000-0000-7000-8000-000000000011", "workspace", null);
    await enqueueActivityOpportunity(environment(database), "00000000-0000-7000-8000-000000000107");
    const originalWindow = database.prepare("SELECT id FROM opportunity_batch_windows").get() as { id: string };
    let claimed = false;
    const racingDatabase = new D1Adapter(database, (sql) => {
      if (claimed || !sql.includes("SELECT id, first_event_at FROM opportunity_batch_windows")) return;
      claimed = true;
      database.prepare("UPDATE opportunity_batch_windows SET status = 'processing' WHERE id = ?").run(originalWindow.id);
    });

    await enqueueActivityOpportunity(
      environment(database, { DB: createTestD1Database(racingDatabase) }),
      "00000000-0000-7000-8000-000000000108",
    );

    expect(database.prepare(`
      SELECT w.status, e.source_id
      FROM opportunity_batch_events e JOIN opportunity_batch_windows w ON w.id = e.window_id
      WHERE e.source_id = '00000000-0000-7000-8000-000000000108'
    `).get()).toEqual({ status: "queued", source_id: "00000000-0000-7000-8000-000000000108" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM opportunity_batch_windows").get()).toEqual({ count: 2 });
  });

  it("enforces model batch bounds and maximum concurrency three", async () => {
    const source = (index: number, text = "x") => ({
      event: { id: String(index), source_kind: "activity" as const, source_id: String(index), occurred_at: "2026-08-07T00:00:00.000Z", input_characters: text.length, attempt_count: 0 },
      source: { id: String(index), kind: "activity" as const, provider: "test", providerTenantId: "tenant", connectionId: "connection", title: `Title ${index}`, summary: "", text, actor: {}, subject: {}, externalPeople: [], entityKeys: ["same"], canonicalUrl: null, workstreamId: null, occurredAt: "2026-08-07T00:00:00.000Z" },
    });
    const batches = __workOpportunityTesting.packBatches(Array.from({ length: 33 }, (_, index) => source(index)));
    expect(batches.map((batch) => batch.length)).toEqual([16, 16, 1]);
    expect(__workOpportunityTesting.packBatches([source(1, "x".repeat(13_000)), source(2, "x".repeat(13_000))])).toHaveLength(2);
    const bounded = __workOpportunityTesting.packBatches([source(1, "x".repeat(100_000))]);
    expect(JSON.stringify(bounded[0]![0]!.source).length).toBeLessThanOrEqual(24_000);

    let active = 0;
    let maximum = 0;
    await __workOpportunityTesting.mapConcurrent(Array.from({ length: 9 }, (_, index) => index), 3, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(maximum).toBe(3);
  });

  it("keeps admission output portable while enforcing limits after generation", () => {
    const serialized = JSON.stringify(__workOpportunityTesting.admissionJsonSchema);
    for (const providerConstraint of [
      "maxItems",
      "minItems",
      "maxLength",
      "minLength",
      "minimum",
      "maximum",
      "format",
    ]) {
      expect(serialized).not.toContain(`"${providerConstraint}"`);
    }
    expect(__workOpportunityTesting.admissionJsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
          },
        },
      },
    });

    const decision = {
      action: "ignore",
      existingTargetId: null,
      displayPrompt: "",
      executionPrompt: "",
      admissionReasoning: "",
      linkedUsers: [],
      sourceIds: ["source-1"],
    };
    expect(() => __workOpportunityTesting.parseAdmissionResult({
      decisions: Array.from({ length: 5 }, () => decision),
    })).toThrow();
  });

  it("bounds every ranking candidate and guarantees tournament rounds shrink", () => {
    type RankingCandidate = Parameters<typeof __workOpportunityTesting.rankingGroups>[0][number];
    const candidate = (index: number): RankingCandidate => __workOpportunityTesting.boundRankingCandidate({
      id: `candidate-${index}`,
      version: 1,
      displayPrompt: `Candidate ${index}`,
      admissionReasoning: "r".repeat(20_000),
      linkedUsers: Array.from({ length: 20 }, () => ({
        reasoning: "l".repeat(1_000),
      })),
      provenance: Array.from({ length: 32 }, (_, nodeIndex) => ({
        id: `node-${nodeIndex}`,
        node_kind: "activity",
        source_id: `source-${nodeIndex}`,
        label: "p".repeat(500),
        locator_json: JSON.stringify({ excerpt: "x".repeat(2_000) }),
      })),
      age: { createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z" },
      impressions: { count: 0, firstAt: null, lastAt: null },
      currentlySuggested: false,
      public: {
        id: `candidate-${index}`,
        version: 1,
        displayPrompt: `Candidate ${index}`,
        icon: "plug",
        sourceLabel: "Connected activity",
      },
    });
    let pool = Array.from({ length: 37 }, (_, index) => candidate(index));
    expect(pool.every((item) => JSON.stringify(item).length <= __workOpportunityTesting.limits.rankCandidateCharacters)).toBe(true);
    let rounds = 0;
    while (__workOpportunityTesting.rankingGroups(pool).length > 1) {
      const next = __workOpportunityTesting.rankingGroups(pool).flatMap((group) => group.slice(0, 4));
      expect(next.length).toBeLessThan(pool.length);
      pool = next;
      rounds += 1;
      expect(rounds).toBeLessThan(10);
    }
    expect(pool.length).toBeLessThanOrEqual(12);
  });

  it("scopes source fingerprints and provenance roots to each personal target", async () => {
    const database = migratedDatabase();
    seed(database);
    const source = {
      id: "00000000-0000-7000-8000-000000000109",
      kind: "activity" as const,
      provider: "github",
      providerTenantId: "tenant-gh",
      connectionId: "00000000-0000-7000-8000-000000000011",
      title: "Review requested",
      summary: "Please review the change",
      text: "Please review the change",
      actor: {},
      subject: {},
      externalPeople: [],
      entityKeys: [],
      canonicalUrl: null,
      workstreamId: null,
      occurredAt: "2026-08-07T00:00:00.000Z",
    };
    const windowFor = (userId: string) => ({
      id: `window-${userId}`,
      workspace_id: workspaceId,
      partition_key: `mention:${userId}`,
      audience_scope: "personal" as const,
      audience_user_id: userId,
      first_event_at: "2026-08-07T00:00:00.000Z",
      last_event_at: "2026-08-07T00:00:00.000Z",
    });
    const firstFingerprint = await __workOpportunityTesting.opportunityFingerprint(windowFor(userOne), [source]);
    const secondFingerprint = await __workOpportunityTesting.opportunityFingerprint(windowFor(userTwo), [source]);
    expect(firstFingerprint).not.toBe(secondFingerprint);

    const firstNode = await __workOpportunityTesting.provenanceNodeForSource(environment(database), windowFor(userOne), source);
    const secondNode = await __workOpportunityTesting.provenanceNodeForSource(environment(database), windowFor(userTwo), source);
    expect(firstNode).not.toBe(secondNode);
    expect(database.prepare(`
      SELECT visibility_user_id FROM opportunity_provenance_nodes
      WHERE source_id = ? ORDER BY visibility_user_id
    `).all(source.id)).toEqual([
      { visibility_user_id: userOne },
      { visibility_user_id: userTwo },
    ]);
  });

  it("does not turn route_existing decisions into work-stream suggestions while the surface is paused", async () => {
    const database = migratedDatabase();
    seed(database);
    const activityId = "00000000-0000-7000-8000-000000000110";
    const workstreamId = "00000000-0000-7000-8000-000000000310";
    insertActivity(database, activityId, "00000000-0000-7000-8000-000000000011", "workspace", null);
    database.prepare(`
      INSERT INTO workstreams
       (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
        next_sequence_number, last_activity_at, created_at, updated_at)
       VALUES (?, ?, 'Existing launch work', 'Ship the launch', 'ad_hoc', ?, 'idle', 1, ?, ?, ?)
    `).run(
      workstreamId, workspaceId, userOne,
      "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z",
    );
    const roomFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const rooms = createCloudflareTestBinding<DurableObjectNamespace>({
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue({ fetch: roomFetch }),
    });
    const routed = await __workOpportunityTesting.routeExistingDecision(
      environment(database, { WORKSTREAM_ROOMS: rooms }),
      {
        id: "window-route",
        workspace_id: workspaceId,
        partition_key: "workspace",
        audience_scope: "workspace",
        audience_user_id: null,
        first_event_at: "2026-08-07T00:00:00.000Z",
        last_event_at: "2026-08-07T00:00:00.000Z",
      },
      {
        action: "route_existing",
        existingTargetId: workstreamId,
        displayPrompt: "Route the launch dependency update here",
        executionPrompt: "",
        admissionReasoning: "This update belongs in the existing launch work stream.",
        linkedUsers: [],
        sourceIds: [activityId],
      },
      [{
        id: activityId,
        kind: "activity",
        provider: "test",
        providerTenantId: "tenant-gh",
        connectionId: "00000000-0000-7000-8000-000000000011",
        title: "Launch update",
        summary: "A launch dependency changed",
        text: "",
        actor: {},
        subject: {},
        externalPeople: [],
        entityKeys: ["launch"],
        canonicalUrl: null,
        workstreamId: null,
        occurredAt: "2026-08-07T00:00:00.000Z",
      }],
      [{ id: workstreamId, title: "Existing launch work", objective: "Ship the launch" }],
    );
    expect(routed).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM activity_suggestions").get()).toEqual({ count: 0 });
    expect(roomFetch).not.toHaveBeenCalled();

    await expect(__workOpportunityTesting.routeExistingDecision(
      environment(database, { WORKSTREAM_ROOMS: rooms }),
      {
        id: "window-private-route",
        workspace_id: workspaceId,
        partition_key: `personal:${userOne}`,
        audience_scope: "personal",
        audience_user_id: userOne,
        first_event_at: "2026-08-07T00:00:00.000Z",
        last_event_at: "2026-08-07T00:00:00.000Z",
      },
      {
        action: "route_existing",
        existingTargetId: workstreamId,
        displayPrompt: "Do not expose this private update",
        executionPrompt: "",
        admissionReasoning: "Private source reasoning.",
        linkedUsers: [],
        sourceIds: [activityId],
      },
      [],
      [{ id: workstreamId, title: "Existing launch work", objective: "Ship the launch" }],
    )).resolves.toBe(false);
    expect(roomFetch).not.toHaveBeenCalled();
  });

  it("keeps execution prompts and reasoning out of the renderer contract and rejects stale starts", async () => {
    const database = migratedDatabase();
    seed(database);
    database.prepare(`
      INSERT INTO work_opportunities
       (id, workspace_id, audience_scope, audience_user_id, display_prompt, execution_prompt,
        admission_reasoning, provider_icon, source_label, source_fingerprint, version,
        display_prompt_hash, execution_prompt_hash, status, expires_at, created_at, updated_at)
       VALUES (?, ?, 'workspace', NULL, ?, ?, ?, 'brand-slack', 'From slack', 'source-one', 3,
        'display-hash', 'execution-hash', 'active', '2027-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z')
    `).run(
      "00000000-0000-7000-8000-000000000201",
      workspaceId,
      "Follow up on the launch blocker",
      "Long execution instructions that must never appear in the suggestion API.",
      "Extensive internal admission reasoning that must never appear in the suggestion API.",
    );
    const auth: AuthContext = {
      sessionId: "session",
      userId: userOne,
      workspaceId,
      region: "global",
      role: "owner",
    };
    const service = new WorkOpportunityService(environment(database), auth);
    await expect(service.list(4)).resolves.toEqual({
      items: [{
        id: "00000000-0000-7000-8000-000000000201",
        version: 3,
        displayPrompt: "Follow up on the launch blocker",
        icon: "brand-slack",
        sourceLabel: "From slack",
      }],
    });
    const publicJson = JSON.stringify(await service.list(4));
    expect(publicJson).not.toContain("Long execution instructions");
    expect(publicJson).not.toContain("Extensive internal admission reasoning");
    await expect(service.start(
      "00000000-0000-7000-8000-000000000201",
      2,
      "stale-attempt",
    )).rejects.toMatchObject({ code: "stale_work_opportunity", status: 409 });
  });

  it("debounces impression-driven ranking requests for one hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    const database = migratedDatabase();
    seed(database);
    const opportunityId = "00000000-0000-7000-8000-000000000204";
    insertOpportunity(database, opportunityId);
    database.prepare(`
      INSERT INTO suggested_work_sets
       (workspace_id, user_id, workspace_version, candidate_fingerprint,
        opportunity_ids_json, ranking_reasoning, status, created_at, updated_at)
      VALUES (?, ?, 1, 'fingerprint', ?, 'Initial ranking', 'ready', ?, ?)
    `).run(
      workspaceId,
      userOne,
      JSON.stringify([opportunityId]),
      "2026-08-10T12:00:00.000Z",
      "2026-08-10T12:00:00.000Z",
    );
    const service = new WorkOpportunityService(environment(database), {
      sessionId: "session",
      userId: userOne,
      workspaceId,
      region: "global",
      role: "owner",
    });

    // Impressions are the one input that asks for a re-rank without the
    // candidates having changed, so within the hour they must ask for nothing.
    await service.recordImpressions([opportunityId]);
    expect(database.prepare(
      "SELECT due_at FROM suggested_work_sets WHERE workspace_id = ? AND user_id = ?",
    ).get(workspaceId, userOne)).toEqual({ due_at: null });

    vi.setSystemTime(new Date("2026-08-10T13:00:01.000Z"));
    await service.recordImpressions([opportunityId]);
    expect(database.prepare(
      "SELECT due_at FROM suggested_work_sets WHERE workspace_id = ? AND user_id = ?",
    ).get(workspaceId, userOne)).toEqual({ due_at: "2026-08-10T13:00:01.000Z" });
    expect(database.prepare(
      "SELECT impression_count FROM work_opportunity_user_states WHERE opportunity_id = ? AND user_id = ?",
    ).get(opportunityId, userOne)).toEqual({ impression_count: 2 });
  });

  it("rolls a partially created work stream forward instead of making the opportunity claimable again", async () => {
    const database = migratedDatabase();
    seed(database);
    const opportunityId = "00000000-0000-7000-8000-000000000202";
    const workstreamId = "00000000-0000-7000-8000-000000000302";
    const messageId = "00000000-0000-7000-8000-000000000402";
    insertOpportunity(database, opportunityId);
    vi.spyOn(WorkstreamService.prototype, "createFromOpportunity").mockImplementation(async () => {
      insertOpportunityWorkstream(database, opportunityId, workstreamId, messageId);
      throw new Error("post_insert_launch_failure");
    });
    const service = new WorkOpportunityService(environment(database), {
      sessionId: "session",
      userId: userOne,
      workspaceId,
      region: "global",
      role: "owner",
    });

    await expect(service.start(opportunityId, 1, "durable-attempt")).rejects.toThrow("post_insert_launch_failure");

    expect(database.prepare(`
      SELECT status, created_workstream_id, created_message_id, start_idempotency_key
      FROM work_opportunities WHERE id = ?
    `).get(opportunityId)).toEqual({
      status: "started",
      created_workstream_id: workstreamId,
      created_message_id: messageId,
      start_idempotency_key: "durable-attempt",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM work_opportunity_snapshots WHERE opportunity_id = ?",
    ).get(opportunityId)).toEqual({ count: 1 });
  });

  it("replays a concurrent start that uses the same idempotency key", async () => {
    const database = migratedDatabase();
    seed(database);
    const opportunityId = "00000000-0000-7000-8000-000000000203";
    const workstreamId = "00000000-0000-7000-8000-000000000303";
    const messageId = "00000000-0000-7000-8000-000000000403";
    insertOpportunity(database, opportunityId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = vi.spyOn(WorkstreamService.prototype, "createFromOpportunity").mockImplementation(async () => {
      await gate;
      insertOpportunityWorkstream(database, opportunityId, workstreamId, messageId);
      return {
        workstream: { id: workstreamId },
        messageId,
        harnessRunId: "run-one",
      } as never;
    });
    vi.spyOn(WorkstreamService.prototype, "get").mockResolvedValue({
      id: workstreamId,
      latestHarnessRunId: "run-one",
    } as never);
    const service = new WorkOpportunityService(environment(database), {
      sessionId: "session",
      userId: userOne,
      workspaceId,
      region: "global",
      role: "owner",
    });

    const first = service.start(opportunityId, 1, "same-attempt");
    while ((database.prepare("SELECT status FROM work_opportunities WHERE id = ?").get(opportunityId) as { status: string }).status !== "starting") {
      await Promise.resolve();
    }
    const second = service.start(opportunityId, 1, "same-attempt");
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.workstream.id).toBe(workstreamId);
    expect(secondResult.workstream.id).toBe(workstreamId);
    expect(create).toHaveBeenCalledOnce();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM work_opportunity_snapshots WHERE opportunity_id = ?",
    ).get(opportunityId)).toEqual({ count: 1 });
  });
});
