import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { __workOpportunityTesting, WorkOpportunityService } from "../src/services/work-opportunity-service";
import { createConnectorRegistry } from "@rally/connectors";
import {
  enqueueActivityOpportunity,
  isSuggestedWorkCandidateEventType,
  SUGGESTED_WORK_EXCLUDED_EVENT_TYPE_PREFIXES,
  SUGGESTED_WORK_RETIRED_EVENT_TYPE_PREFIXES,
} from "../src/services/work-opportunity-batching";
import { WorkstreamService } from "../src/services/workstream-service";
import { createCloudflareTestBinding, createTestD1PreparedStatement, createTestEnv } from "./helpers/cloudflare-test";
import { openWorkstreamAuthorityForTest, testSubstreamAgentsBinding } from "./helpers/durable-authority";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const userOne = asUserId("00000000-0000-7000-8000-000000000002");
const userTwo = "00000000-0000-7000-8000-000000000003";
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
  const database = legacyProductSqliteDatabase();
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
  // The durable creation path leaves a completed create receipt keyed by the
  // opportunity's client message id. Since the cutover the transcript row
  // itself lives in the work stream's object; this receipt — not a D1
  // transcript join — is how a failed start's recovery finds what was
  // already created.
  database.prepare(`
    INSERT INTO workstream_create_receipts
      (workspace_id, creator_user_id, client_message_id, workstream_id, generation,
       request_hash, state, message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 'request-hash', 'completed', ?, ?, ?)
  `).run(workspaceId, userOne, `opportunity:${opportunityId}:v1`, workstreamId, messageId, at, at);
}

describe("suggested-work aggregation", () => {
  it("fans workspace-visible activity into every active member's personal admission window", async () => {
    const database = migratedDatabase();
    seed(database);
    const activityId = "00000000-0000-7000-8000-000000000120";
    const enqueueOpportunitySource = vi.fn(async (input: Record<string, unknown>) => {
      void input;
    });
    const workspaces = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue({
        connectorEvent: vi.fn(async () => ({
          connectorType: "github",
          activity: {
            id: activityId,
            workspaceId,
            region: "global",
            connectionId: "00000000-0000-7000-8000-000000000011",
            connectionScope: "workspace",
            connectionOwnerUserId: null,
            provider: "github",
            providerEventId: "workspace-event",
            eventType: "pull_request.opened",
            resourceType: "github_pull_request",
            providerResourceId: "juno-ai-labs/avalon#120",
            actor: {},
            subject: {},
            occurredAt: "2026-08-07T00:00:00.000Z",
            receivedAt: "2026-08-07T00:00:01.000Z",
            title: "Workspace-visible review request",
            summary: "Every member may use this as private Suggested Work context",
            textSnippet: "Review requested",
            payloadRef: null,
            visibility: {},
            targetUserIds: [],
            entityKeys: ["github:pr:120"],
            dedupeKey: "github:workspace-event",
            rawContentHash: null,
            metadata: {},
            externalPeople: [],
          },
        })),
        enqueueOpportunitySource,
      }),
    });

    const outcome = await enqueueActivityOpportunity(
      environment(database, { WORKSPACE_DOS: workspaces }),
      activityId,
      workspaceId,
    );

    expect(outcome).toBe("enqueued");
    expect(enqueueOpportunitySource.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        partitionKey: `workspace:${userOne}`,
        audience: { scope: "personal", userId: userOne },
        sourceId: activityId,
      }),
      expect.objectContaining({
        partitionKey: `workspace:${userTwo}`,
        audience: { scope: "personal", userId: userTwo },
        sourceId: activityId,
      }),
    ]);
  });

  it("withholds CI status activity from every admission window", async () => {
    const database = migratedDatabase();
    seed(database);
    const activityId = "00000000-0000-7000-8000-000000000121";
    const enqueueOpportunitySource = vi.fn(async (input: Record<string, unknown>) => {
      void input;
    });
    const connectorEvent = vi.fn(async () => ({
      connectorType: "github",
      activity: {
        id: activityId,
        workspaceId,
        region: "global",
        connectionId: "00000000-0000-7000-8000-000000000011",
        connectionScope: "workspace",
        connectionOwnerUserId: null,
        provider: "github",
        providerEventId: "check-run-event",
        eventType: "github.check_run.completed",
        resourceType: "github_check_run",
        providerResourceId: "juno-ai-labs/avalon/check-runs/1",
        actor: {},
        subject: {},
        occurredAt: "2026-08-07T00:00:00.000Z",
        receivedAt: "2026-08-07T00:00:01.000Z",
        title: "CI passed",
        summary: "A commit status, not work for a person",
        textSnippet: "lint: success",
        payloadRef: null,
        visibility: {},
        targetUserIds: [],
        entityKeys: ["github:check_run:1"],
        dedupeKey: "github:check-run-event",
        rawContentHash: null,
        metadata: {},
        externalPeople: [],
      },
    }));
    const workspaces = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue({ connectorEvent, enqueueOpportunitySource }),
    });

    const outcome = await enqueueActivityOpportunity(
      environment(database, { WORKSPACE_DOS: workspaces }),
      activityId,
      workspaceId,
    );

    // The activity was read — the decision needs its event type — and then
    // nothing was opened for it, for either member, and the caller is told so
    // rather than left to infer "unclaimed, therefore enqueued".
    expect(outcome).toBe("excluded");
    expect(connectorEvent).toHaveBeenCalledTimes(1);
    expect(enqueueOpportunitySource).not.toHaveBeenCalled();

    // The families the gate names, and the neighbours it must keep admitting.
    for (const excluded of [
      "github.check_run.created",
      "github.check_run.completed",
      "github.workflow_run.requested",
      "github.workflow_run.in_progress",
      "github.workflow_run.completed",
    ]) {
      expect(isSuggestedWorkCandidateEventType(excluded), excluded).toBe(false);
    }
    for (const admitted of [
      "github.pull_request.opened",
      "github.pull_request_review.submitted",
      "github.push",
      // One series edit is one activity per connection since the connector's
      // 2026-09-02 collapse, and a moved or cancelled meeting can be work.
      "calendar.event_changed",
      "calendar.event_completed",
      "email.received",
      "linear.issue.update",
    ]) {
      expect(isSuggestedWorkCandidateEventType(admitted), admitted).toBe(true);
    }
  });

  it("withholds only what the connector that emits it already called operational", () => {
    // The gate is Suggested Work's own judgement, not the digest's — the
    // recorded decision in `activity-consumer.ts` is that this surface must not
    // inherit that notification choice, and 136 of the 197 declared types are
    // operational where this gate withholds 1. What it may not do is disagree
    // with a manifest: a type withheld from the home screen has to be one its
    // own connector already declined to call news. This is the check that keeps
    // the two from drifting apart, since neither file mentions the other in a
    // way a grep would find.
    const oauth = { clientId: "client", clientSecret: "secret", redirectUri: "https://api.example.com/callback" };
    const registry = createConnectorRegistry({
      granola: { redirectUri: "https://api.example.com/callback" },
      google: oauth,
      github: {
        appId: "1",
        clientId: "Iv1.client-id",
        clientSecret: "secret",
        privateKey: `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\nAA==\n${["-----END", "PRIVATE KEY-----"].join(" ")}`,
        webhookSecret: "webhook",
        redirectUri: "https://api.example.com/callback",
      },
      linear: oauth,
      notion: oauth,
      slack: { ...oauth, signingSecret: "signing" },
      x: { apiKey: "key" },
    });

    const withheld: string[] = [];
    const digestibleButWithheld: string[] = [];
    for (const manifest of registry.list()) {
      const digestible = new Set(manifest.digestibleActivityTypes);
      for (const eventType of manifest.activityTypes) {
        if (isSuggestedWorkCandidateEventType(eventType)) continue;
        withheld.push(eventType);
        if (digestible.has(eventType)) digestibleButWithheld.push(eventType);
      }
    }

    // Nothing this gate withholds is news to its own connector.
    expect(digestibleButWithheld).toEqual([]);
    // And the one it withholds today is the CI family GitHub ingress keeps.
    expect([...withheld].sort()).toEqual([
      "github.workflow_run.completed",
    ]);

    // Every prefix earns its place. A prefix matching no declared type is a
    // rule written against an event nobody emits — it reads as coverage and is
    // not, and the assertion above cannot see it, because withholding nothing
    // leaves that list unchanged. This is how a family renamed at the
    // connector (`check_run` to `check_suite`, say) surfaces here rather than
    // as a bill. The one exception is a family retired on purpose whose stored
    // events can still drain, and it has to be named as that.
    const declared = registry.list().flatMap((manifest) => manifest.activityTypes);
    expect(SUGGESTED_WORK_EXCLUDED_EVENT_TYPE_PREFIXES.filter((prefix) => (
      !declared.some((eventType) => eventType.startsWith(prefix))
    ))).toEqual([...SUGGESTED_WORK_RETIRED_EVENT_TYPE_PREFIXES]);
  });

  // Two suites lived here and covered the D1 batching window: the debounce and
  // one-hour cap on `process_after`, and the retry that moves an event when its
  // window is claimed between select and insert. `enqueue` no longer owns that
  // window — WorkspaceDO does, with the same 10-minute debounce and one-hour cap
  // at `workspace-product-storage.ts:24-53` — and the D1 arm they exercised was
  // reachable only with the authority closed. Deleted rather than rewired: they
  // asserted on rows this side no longer writes. The gap is in
  // `docs/potential-bugs.md`.
  it("preserves every person in source storage and covers all people across model windows", () => {
    const people = Array.from({ length: 10_000 }, (_, index) => ({
      provider: "google", providerTenantId: "account", providerUserId: null, handle: null,
      email: `guest${index}@example.com`, displayName: null, role: "recipient", sourceText: "evidence".repeat(40),
    }));
    const source = { id: "source", kind: "activity" as const, provider: "google", providerTenantId: "account", connectionId: null,
      title: "A large meeting", summary: "", text: "Meeting details", actor: {}, subject: {}, externalPeople: people,
      entityKeys: [], canonicalUrl: null, workstreamId: null, occurredAt: "2026-10-19T00:00:00.000Z", sourceAudience: { scope: "workspace" as const } };
    const packed = __workOpportunityTesting.packBatches([{ source,
      event: { id: "event", source_kind: "activity" as const, source_id: "source", occurred_at: source.occurredAt, input_characters: 10, attempt_count: 0 } }]);
    expect(packed[0]![0]!.source.externalPeople).toHaveLength(10_000);
    const windows = __workOpportunityTesting.admissionSourceBatches(packed.flatMap((batch) => batch.map((item) => item.source)));
    expect(windows.length).toBeGreaterThan(1);
    const represented = windows.flatMap((batch) => batch.flatMap((item) => item.externalPeople));
    expect(represented).toEqual(people);
    expect(windows.every((batch) => JSON.stringify(batch).length <= 24_002)).toBe(true);
  });

  it("enforces model batch bounds and maximum concurrency three", async () => {
    const source = (index: number, text = "x") => ({
      event: { id: String(index), source_kind: "activity" as const, source_id: String(index), occurred_at: "2026-08-07T00:00:00.000Z", input_characters: text.length, attempt_count: 0 },
      source: { id: String(index), kind: "activity" as const, provider: "test", providerTenantId: "tenant", connectionId: "connection", title: `Title ${index}`, summary: "", text, actor: {}, subject: {}, externalPeople: [], entityKeys: ["same"], canonicalUrl: null, workstreamId: null, occurredAt: "2026-08-07T00:00:00.000Z", sourceAudience: { scope: "workspace" as const } },
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
      linkedUsers: Array.from({ length: 20 }, (_, linkIndex) => ({
        user_id: `user-${linkIndex}`,
        role: "mentioned",
        resolution: "verified",
        reasoning: "l".repeat(1_000),
      })),
      provenance: Array.from({ length: 32 }, (_, nodeIndex) => ({
        id: `node-${nodeIndex}`,
        kind: "activity",
        label: "p".repeat(500),
        provider: "slack",
        occurredAt: "2026-08-07T00:00:00.000Z",
        canonicalUrl: null,
        depth: 0,
        locator: JSON.stringify({ excerpt: "x".repeat(2_000) }),
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
      sourceAudience: { scope: "workspace" as const },
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

  it("keeps execution prompts and reasoning out of the renderer contract and rejects stale starts", async () => {
    const database = migratedDatabase();
    seed(database);
    openWorkstreamAuthorityForTest(database);
    const opportunityId = "00000000-0000-7000-8000-000000000201";
    const auth: AuthContext = {
      sessionId: "session",
      userId: userOne,
      workspaceId,
      region: "global",
      role: "owner",
    };
    // The object is the one that holds the execution prompt and the admission
    // reasoning, so the contract boundary worth asserting is the Worker's parse
    // of what it hands back — here it hands back both, and neither may survive.
    const env = createTestEnv({
      DB: new D1Adapter(database),
      APP_ENV: "development",
      AVALON_REGION: "global",
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          listOpportunities: vi.fn(async () => ({
            items: [{
              id: opportunityId,
              version: 3,
              displayPrompt: "Follow up on the launch blocker",
              icon: "brand-slack",
              sourceLabel: "From slack",
              executionPrompt: "Long execution instructions that must never appear in the suggestion API.",
              admissionReasoning: "Extensive internal admission reasoning that must never appear in the suggestion API.",
            }],
          })),
          claimOpportunityStart: vi.fn(async () => ({
            outcome: "stale",
            opportunity: null,
            telemetryContext: null,
          })),
        },
      }),
    });
    const service = new WorkOpportunityService(env, auth);

    await expect(service.list(4)).resolves.toEqual({
      items: [{
        id: opportunityId,
        version: 3,
        displayPrompt: "Follow up on the launch blocker",
        icon: "brand-slack",
        sourceLabel: "From slack",
      }],
    });
    const publicJson = JSON.stringify(await service.list(4));
    expect(publicJson).not.toContain("Long execution instructions");
    expect(publicJson).not.toContain("Extensive internal admission reasoning");
    // A start against a version the member is no longer looking at is refused,
    // not silently applied to whatever the suggestion has since become.
    await expect(service.start(opportunityId, 2, "stale-attempt"))
      .rejects.toMatchObject({ code: "stale_work_opportunity", status: 409 });
  });

  it("rolls a partially created work stream forward instead of making the opportunity claimable again", async () => {
    const database = migratedDatabase();
    seed(database);
    // Starting an opportunity is a durable-path operation since the cutover:
    // the workspace object owns the claim ledger, and this test asserts the
    // contract with it — a launch failure after the work stream exists must
    // complete the claim with what was created, never release it.
    openWorkstreamAuthorityForTest(database);
    const opportunityId = "00000000-0000-7000-8000-000000000202";
    const workstreamId = "00000000-0000-7000-8000-000000000302";
    const messageId = "00000000-0000-7000-8000-000000000402";
    insertOpportunity(database, opportunityId);
    vi.spyOn(WorkstreamService.prototype, "createFromOpportunity").mockImplementation(async () => {
      insertOpportunityWorkstream(database, opportunityId, workstreamId, messageId);
      throw new Error("post_insert_launch_failure");
    });
    const complete = vi.fn<(input: Record<string, unknown>) => Promise<object>>(async () => ({}));
    const releaseClaim = vi.fn(async () => ({}));
    const env = createTestEnv({
      DB: new D1Adapter(database),
      APP_ENV: "development",
      AVALON_REGION: "global",
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          claimOpportunityStart: vi.fn(async () => ({
            outcome: "claimed",
            opportunity: database.prepare("SELECT * FROM work_opportunities WHERE id = ?").get(opportunityId),
            telemetryContext: null,
          })),
          completeOpportunityStart: complete,
          releaseOpportunityStart: releaseClaim,
        },
      }),
    });
    const service = new WorkOpportunityService(env, {
      sessionId: "session",
      userId: userOne,
      workspaceId,
      region: "global",
      role: "owner",
    });

    await expect(service.start(opportunityId, 1, "durable-attempt")).rejects.toThrow("post_insert_launch_failure");

    // The recovery found the created work stream through its create receipt
    // and rolled the claim forward to `started` with the durable ids; a
    // release here would let a retry digest the same window twice.
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]![0]).toMatchObject({
      workspaceId,
      opportunityId,
      idempotencyKey: "durable-attempt",
      workstreamId,
      messageId,
      snapshotId: expect.any(String),
    });
  });

  it("replays a start that reuses the idempotency key instead of creating a second work stream", async () => {
    const database = migratedDatabase();
    seed(database);
    openWorkstreamAuthorityForTest(database);
    const opportunityId = "00000000-0000-7000-8000-000000000203";
    const workstreamId = "00000000-0000-7000-8000-000000000303";
    const messageId = "00000000-0000-7000-8000-000000000403";
    insertOpportunity(database, opportunityId);
    const create = vi.spyOn(WorkstreamService.prototype, "createFromOpportunity").mockImplementation(async () => {
      insertOpportunityWorkstream(database, opportunityId, workstreamId, messageId);
      return {
        workstream: { id: workstreamId },
        turnId: messageId,
        harnessRunId: "run-one",
      } as never;
    });
    vi.spyOn(WorkstreamService.prototype, "get").mockResolvedValue({
      id: workstreamId,
      latestHarnessRunId: "run-one",
    } as never);
    // The workspace object's ledger arbitrates the race: the first attempt is
    // admitted, and every later start carrying the same key is answered as a
    // replay. The replay arrives without the created ids — the shape of an
    // attempt that crashed between creating and recording — so resolving it
    // exercises the receipt-based recovery rather than a stored answer.
    let claimed = false;
    const complete = vi.fn<(input: Record<string, unknown>) => Promise<object>>(async () => ({}));
    const env = createTestEnv({
      DB: new D1Adapter(database),
      APP_ENV: "development",
      AVALON_REGION: "global",
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          claimOpportunityStart: vi.fn(async () => {
            const opportunity = database.prepare("SELECT * FROM work_opportunities WHERE id = ?").get(opportunityId);
            if (!claimed) {
              claimed = true;
              return { outcome: "claimed", opportunity, telemetryContext: null };
            }
            return { outcome: "replay", opportunity, telemetryContext: null };
          }),
          completeOpportunityStart: complete,
          releaseOpportunityStart: vi.fn(async () => ({})),
        },
      }),
    });
    const service = new WorkOpportunityService(env, {
      sessionId: "session",
      userId: userOne,
      workspaceId,
      region: "global",
      role: "owner",
    });

    const [firstResult, secondResult] = await Promise.all([
      service.start(opportunityId, 1, "same-attempt"),
      service.start(opportunityId, 1, "same-attempt"),
    ]);

    expect(firstResult.workstream.id).toBe(workstreamId);
    expect(secondResult.workstream.id).toBe(workstreamId);
    expect(create).toHaveBeenCalledOnce();
    // Both attempts settle the same durable ids onto the claim.
    expect(complete).toHaveBeenCalledTimes(2);
    for (const call of complete.mock.calls) {
      expect(call[0]).toMatchObject({ workstreamId, messageId, idempotencyKey: "same-attempt" });
    }
  });
});
