import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSocketEventSchema } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { scheduledAlarmRetryDelay } from "../src/durable-objects/scheduled-alarms";
import {
  calculateNextOccurrence,
  type ScheduleTiming,
} from "../src/services/workspace-schedule-execution";
import {
  applyActiveStreamCheckpointEvent,
  distinctNonParticipantViewers,
  isPersonalEventAudience,
  planSocketReplay,
  splitActiveStreamCheckpointText,
  substreamAgentName,
} from "../src/durable-objects/substream-agent";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import {
  assertDurableObjectJurisdiction,
  deriveWorkspacePlacementAffinity,
  durableObjectStubForRegion,
  durableObjectStubForWorkspace,
} from "../src/lib/durable-object-namespace";
import type { Env } from "../src/env";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
  createTestJurisdictionalDurableObjectId,
} from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import { sqliteD1 } from "./helpers/sqlite-d1";

function timing(overrides: Partial<ScheduleTiming> = {}): ScheduleTiming {
  return {
    next_run_at: "2026-01-01T00:00:00.000Z",
    interval_seconds: null,
    rrule: null,
    timezone: "UTC",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtime component invariants", () => {
  it("persists suggestions only when their source audience contains every work-stream reader", async () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      transactionSync: (callback: () => unknown) => callback(),
      sql,
    });
    const store = new WorkstreamObjectStore(storage, "test", "global");
    const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000000a1");
    const workstreamId = asWorkstreamId("00000000-0000-4000-8000-0000000000a2");
    const creatorId = asUserId("00000000-0000-4000-8000-0000000000a3");
    const participantId = asUserId("00000000-0000-4000-8000-0000000000a4");
    const outsiderId = asUserId("00000000-0000-4000-8000-0000000000a7");
    store.ensureIdentity({ workspaceId, workstreamId }, "global");
    sql.exec(
      `UPDATE workstream
          SET authority_mode = 'authoritative', authority_generation = 1,
              scope = 'personal', created_by_user_id = ?
        WHERE id = 1`,
      creatorId,
    );
    const now = Date.now();
    for (const userId of [creatorId, participantId]) {
      sql.exec(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status, participant_epoch,
            added_at, removed_at, updated_at)
         VALUES (?, 'explicit', ?, 'active', 0, ?, NULL, ?)`,
        userId,
        creatorId,
        now,
        now,
      );
    }
    const regional = new DatabaseSync(":memory:");
    regional.exec(`CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, role TEXT NOT NULL
    )`);
    const memberships: Array<[string, string]> = [
      [creatorId, "owner"],
      [participantId, "member"],
      [outsiderId, "member"],
    ];
    for (const [userId, role] of memberships) {
      regional.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, status, role)
         VALUES (?, ?, 'active', ?)`,
      ).run(workspaceId, userId, role);
    }
    const product = new WorkstreamObjectProductService(
      storage,
      store,
      createTestEnv({ DB: sqliteD1(regional) }),
    );
    const suggestion = {
      id: "00000000-0000-4000-8000-0000000000a5",
      activityId: "00000000-0000-4000-8000-0000000000a6",
      title: "Private activity",
      summary: "Only its source audience may read this",
      confidence: 0.9,
      reason: "Relevant to this work stream",
      matchedEntities: [],
      source: "contextual_routing" as const,
    };

    await expect(product.createSuggestion(workspaceId, {
      ...suggestion,
      sourceAudience: { scope: "users", userIds: [creatorId] },
    })).rejects.toMatchObject({ status: 403, code: "suggestion_audience_mismatch" });
    await expect(product.createSuggestion(workspaceId, {
      ...suggestion,
      sourceAudience: { scope: "users", userIds: [creatorId, participantId] },
    })).resolves.toMatchObject({ inserted: true });

    const visibleSuggestions = () => (
      product as unknown as { suggestions(): Array<{ id: string }> }
    ).suggestions();
    expect(visibleSuggestions()).toEqual([expect.objectContaining({ id: suggestion.id })]);

    sql.exec(
      `UPDATE suggested_actions SET status = 'accepted', resolved_at = ?,
              resolved_by_user_id = ?, resolution_client_id = ?
        WHERE action_id = ?`,
      now,
      creatorId,
      `${creatorId}:accepted`,
      suggestion.id,
    );
    await expect(product.addParticipant({
      sessionId: "test-session",
      userId: creatorId,
      workspaceId,
      region: "global",
      role: "owner",
    }, outsiderId)).rejects.toMatchObject({
      status: 409,
      code: "workstream_audience_restricted_content",
    });

    // Pre-contract rows carry no auditable source audience. Keeping one hidden
    // is safer than reviving a card whose title may already be a disclosure.
    const legacySuggestionId = "00000000-0000-4000-8000-0000000000a8";
    await product.createSuggestion(workspaceId, {
      ...suggestion,
      id: legacySuggestionId,
      sourceAudience: { scope: "users", userIds: [creatorId, participantId] },
    });
    sql.exec(
      `UPDATE suggested_actions SET share_intent_json = ? WHERE action_id = ?`,
      JSON.stringify({ confidence: 0.9, reason: suggestion.reason }),
      legacySuggestionId,
    );
    expect(visibleSuggestions()).toEqual([]);
    regional.close();
    database.close();
  });

  it("rechecks drain identity after the pre-claim regional-effects await", () => {
    const source = readFileSync(
      new URL("../src/durable-objects/substream-agent.ts", import.meta.url),
      "utf8",
    );
    const barrier = source.indexOf("await this.flushDueRegionalEffects();");
    const claim = source.indexOf("const claim = claimAgentRunDispatch(", barrier);
    expect(barrier).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(barrier);
    expect(source.slice(barrier, claim)).toContain("if (!ownsDrain()) return;");
  });

  it("fences product failure on the dispatch token owned by the caller", async () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      transactionSync: (callback: () => unknown) => callback(),
      setAlarm: async () => undefined,
      sql,
    });
    const store = new WorkstreamObjectStore(storage, "test", "global");
    const workspaceId = asWorkspaceId("00000000-0000-4000-8000-0000000000d1");
    const workstreamId = asWorkstreamId("00000000-0000-4000-8000-0000000000d2");
    const runId = "00000000-0000-7000-8000-0000000000d3";
    store.ensureIdentity({ workspaceId, workstreamId }, "global");
    sql.exec(
      `UPDATE workstream
          SET authority_mode = 'authoritative', authority_generation = 1,
              exact_state = 'running', state_reason_code = 'workflow_started'
        WHERE id = 1`,
    );
    const now = Date.now();
    sql.exec(
      `INSERT INTO runs (
         run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
         model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
         active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
         tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
         created_at, updated_at
       ) VALUES (?, '0', NULL, 'running', '{}', 0, 0, '', 0, 0, ?,
                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
      runId,
      now,
      now,
      now,
    );
    sql.exec(
      `INSERT INTO agent_run_dispatches
         (run_id, input_json, state, attempt, available_at, started_at,
          completed_at, last_error_code, lease_token, lease_expires_at,
          created_at, updated_at)
       VALUES (?, '{}', 'running', 2, ?, ?, NULL, NULL, 'successor-token', ?, ?, ?)`,
      runId,
      now,
      now,
      now + 60_000,
      now,
      now,
    );
    const product = new WorkstreamObjectProductService(storage, store, createTestEnv({}));

    await expect(product.recordWorkflowFailed(
      runId,
      { code: "provider_failed", message: "Provider failed" },
      "stale-token",
    )).rejects.toThrow("workstream_run_failure_fenced");
    expect(sql.exec<{ status: string }>(
      `SELECT status FROM runs WHERE run_id = ?`, runId,
    ).toArray()[0]).toEqual({ status: "running" });
    expect(sql.exec<{ exact_state: string }>(
      `SELECT exact_state FROM workstream WHERE id = 1`,
    ).toArray()[0]).toEqual({ exact_state: "running" });

    await expect(product.recordWorkflowFailed(
      runId,
      { code: "provider_failed", message: "Provider failed" },
      "successor-token",
    )).resolves.toBeUndefined();
    expect(sql.exec<{ status: string }>(
      `SELECT status FROM runs WHERE run_id = ?`, runId,
    ).toArray()[0]).toEqual({ status: "failed" });
    expect(sql.exec<{ exact_state: string }>(
      `SELECT exact_state FROM workstream WHERE id = 1`,
    ).toArray()[0]).toEqual({ exact_state: "failed" });
    database.close();
  });

  it.each([
    ["global", "-122.4194", "wnam"],
    ["global", "-73.9857", "enam"],
    ["eu", "-0.1276", "weur"],
    ["eu", "30.5234", "eeur"],
  ] as const)("derives %s workspace affinity from request longitude %s", (region, longitude, expected) => {
    expect(deriveWorkspacePlacementAffinity(region, { longitude })).toEqual({
      affinity: expected,
      source: "request_longitude",
    });
  });

  it.each([
    ["global", undefined, "wnam"],
    ["eu", { longitude: "not-a-coordinate" }, "weur"],
  ] as const)("uses the %s migration/background fallback when request metadata is absent", (
    region,
    metadata,
    expected,
  ) => {
    expect(deriveWorkspacePlacementAffinity(region, metadata)).toEqual({
      affinity: expected,
      source: "missing_request_metadata",
    });
  });

  it("uses a region/workspace/work-stream stable room name", () => {
    expect(substreamAgentName(
      "eu",
      asWorkspaceId("00000000-0000-4000-8000-00000000000a"),
      asWorkstreamId("00000000-0000-4000-8000-00000000000b"),
    )).toBe(
      "eu:00000000-0000-4000-8000-00000000000a:00000000-0000-4000-8000-00000000000b"
    );
  });

  it("delivers personal room events only to the authenticated target user", () => {
    expect(isPersonalEventAudience("user-one", "user-one")).toBe(true);
    expect(isPersonalEventAudience("user-two", "user-one")).toBe(false);
  });

  it("locks Durable Object IDs and first placement to the product region", () => {
    const usStub = {};
    const euStub = {};
    const usId = createTestDurableObjectId("us-id");
    const euId = createTestDurableObjectId("eu-id");
    const usGet = vi.fn(() => usStub);
    const euGet = vi.fn(() => euStub);
    const usIdFromName = vi.fn(() => usId);
    const euIdFromName = vi.fn(() => euId);
    const usNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
      get: usGet,
      idFromName: usIdFromName,
    });
    const euNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
      get: euGet,
      idFromName: euIdFromName,
    });
    const jurisdiction = vi.fn((value: DurableObjectJurisdiction) => (
      value === "us" ? usNamespace : euNamespace
    ));
    const namespace = createCloudflareTestBinding<DurableObjectNamespace>({ jurisdiction });

    expect(durableObjectStubForRegion(
      { AVALON_REGION: "global", APP_ENV: "production" },
      namespace,
      "global",
      "workspace-one",
      "wnam",
    )).toBe(usStub);
    expect(durableObjectStubForRegion(
      { AVALON_REGION: "eu", APP_ENV: "production" },
      namespace,
      "eu",
      "workspace-two",
      "weur",
    )).toBe(euStub);
    expect(jurisdiction.mock.calls).toEqual([["us"], ["eu"]]);
    expect(usIdFromName).toHaveBeenCalledWith("workspace-one");
    expect(euIdFromName).toHaveBeenCalledWith("workspace-two");
    expect(usGet).toHaveBeenCalledWith(usId, { locationHint: "wnam" });
    expect(euGet).toHaveBeenCalledWith(euId, { locationHint: "weur" });
  });

  it("uses one persisted workspace affinity for every child lookup", async () => {
    const first = vi.fn(async () => ({ placement_affinity: "enam" }));
    const bind = vi.fn();
    const statement = createTestD1PreparedStatement({
      bind,
      first,
    });
    bind.mockReturnValue(statement);
    const database = createTestD1Database({ prepare: vi.fn(() => statement) });
    const get = vi.fn(() => ({}));
    const regionalNamespace = createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get,
    });
    const namespace = createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      jurisdiction: vi.fn(() => regionalNamespace),
    });
    const env = createTestEnv({
      APP_ENV: "production",
      AVALON_REGION: "global",
      DB: database,
    });

    await durableObjectStubForWorkspace(env, namespace, "workspace-east", "child-one");
    await durableObjectStubForWorkspace(env, namespace, "workspace-east", "child-two");

    expect(first).toHaveBeenCalledOnce();
    expect(get).toHaveBeenNthCalledWith(1, expect.anything(), { locationHint: "enam" });
    expect(get).toHaveBeenNthCalledWith(2, expect.anything(), { locationHint: "enam" });
  });

  it("omits unsupported jurisdiction and location options in local workerd", () => {
    const stub = {};
    const id = createTestDurableObjectId("local-id");
    const get = vi.fn(() => stub);
    const idFromName = vi.fn(() => id);
    const jurisdiction = vi.fn();
    const namespace = createCloudflareTestBinding<DurableObjectNamespace>({
      get,
      idFromName,
      jurisdiction,
    });

    expect(durableObjectStubForRegion(
      { AVALON_REGION: "eu", APP_ENV: "test" },
      namespace,
      "eu",
      "local",
      "eeur",
    )).toBe(stub);
    expect(jurisdiction).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(id);
  });

  it("fails closed when a production object was created outside its jurisdiction", () => {
    expect(() => assertDurableObjectJurisdiction(
      createTestJurisdictionalDurableObjectId("us-object", "us"),
      "global",
      "production",
    )).not.toThrow();
    expect(() => assertDurableObjectJurisdiction(
      createTestJurisdictionalDurableObjectId("eu-object", "eu"),
      "global",
      "production",
    )).toThrow("durable_object_jurisdiction_mismatch:us:eu");
  });

  it("replays an available in-memory window and explicitly resyncs after hibernation", () => {
    const event = ServerSocketEventSchema.parse({
      type: "harness_status_changed",
      sequence: 12,
      occurredAt: "2026-01-01T00:00:00.000Z",
      status: "running",
    });

    expect(planSocketReplay(11, 12, 11, [event])).toEqual({ type: "replay", events: [event] });
    expect(planSocketReplay(11, 12, null, [])).toEqual({
      type: "resync_required",
      reason: "history_unavailable",
    });
    expect(planSocketReplay(13, 12, 11, [event])).toEqual({
      type: "resync_required",
      reason: "sequence_ahead",
    });
    expect(planSocketReplay(0, 12, null, [])).toEqual({ type: "snapshot" });
    const firstEvent = { ...event, sequence: 1 };
    expect(planSocketReplay(0, 1, 0, [firstEvent], false)).toEqual({
      type: "replay",
      events: [firstEvent],
    });
  });

  it("checkpoints the exact active stream for subscribers joining mid-response", () => {
    const messageId = "00000000-0000-7000-8000-000000000010";
    const harnessRunId = "00000000-0000-7000-8000-000000000011";
    const at = "2026-01-01T00:00:00.000Z";
    expect(applyActiveStreamCheckpointEvent([], ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 9,
      occurredAt: at,
      messageId,
      harnessRunId,
      turnId: "turn-one",
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: "Missing prefix",
    }))).toEqual([]);
    let checkpoints = applyActiveStreamCheckpointEvent([], ServerSocketEventSchema.parse({
      type: "stream_started",
      sequence: 10,
      occurredAt: at,
      messageId,
      harnessRunId,
      turnId: "turn-one",
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 11,
      occurredAt: at,
      messageId,
      turnId: "turn-one",
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: "First answer.",
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_started",
      sequence: 12,
      occurredAt: at,
      messageId,
      harnessRunId,
      turnId: "turn-two",
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 13,
      occurredAt: at,
      messageId,
      turnId: "turn-two",
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: " Discard this attempt.",
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 14,
      occurredAt: at,
      messageId,
      turnId: "turn-two",
      epoch: 1,
      streamSeq: 2,
      reset: true,
      delta: " Final continuation.",
    }));

    expect(checkpoints).toEqual([expect.objectContaining({
      messageId,
      harnessRunId,
      text: "First answer. Final continuation.",
      turnStartOffset: "First answer.".length,
      roomSequence: 14,
      seenTurnIds: ["turn-one", "turn-two"],
    })]);

    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "harness_status_changed",
      sequence: 15,
      occurredAt: at,
      status: "running",
    }));
    expect(checkpoints).toHaveLength(1);

    const completed = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "harness_status_changed",
      sequence: 16,
      occurredAt: at,
      status: "completed",
    }));
    expect(completed).toEqual([]);
  });

  it("segments checkpoints before one Durable Object value can exceed its limit", () => {
    const text = `${"a".repeat(2_100_000)}😀${"z".repeat(35_000)}`;
    const chunks = splitActiveStreamCheckpointText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).byteLength <= 60 * 1024)).toBe(true);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => {
      const last = chunk.charCodeAt(chunk.length - 1);
      return !(last >= 0xD800 && last <= 0xDBFF);
    })).toBe(true);
  });

  it("skips missed interval ticks without creating a catch-up storm", () => {
    expect(
      calculateNextOccurrence(
        timing({ interval_seconds: 300 }),
        new Date("2026-01-01T00:12:00.000Z")
      )
    ).toBe("2026-01-01T00:15:00.000Z");
  });

  it("calculates the next RRULE occurrence after the claimed due time", () => {
    expect(
      calculateNextOccurrence(
        timing({ rrule: "FREQ=DAILY;COUNT=3" }),
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("bounds scheduled-alarm retry backoff with equal jitter", () => {
    expect(scheduledAlarmRetryDelay(1, () => 0)).toBe(30_000);
    expect(scheduledAlarmRetryDelay(2, () => 0)).toBe(60_000);
    expect(scheduledAlarmRetryDelay(99, () => 0.999)).toBeLessThanOrEqual(30 * 60_000);
  });

  it("keeps a local calendar hour across the daylight-saving boundary", () => {
    expect(
      calculateNextOccurrence(
        timing({
          next_run_at: "2026-03-07T17:00:00.000Z",
          created_at: "2026-03-07T17:00:00.000Z",
          timezone: "America/Los_Angeles",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        }),
        new Date("2026-03-07T17:00:00.000Z"),
      ),
    ).toBe("2026-03-08T16:00:00.000Z");
  });

  it("consumes each signed socket ticket identity only once", async () => {
    const database = new DatabaseSync(":memory:");
    const values = new Map<string, unknown>();
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      get: async (key: string | string[]) => Array.isArray(key)
        ? new Map(key.flatMap((entry) => values.has(entry) ? [[entry, values.get(entry)]] : []))
        : values.get(key),
      list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map(
        [...values].filter(([key]) => key.startsWith(prefix)),
      ),
      delete: async (key: string | string[]) => {
        if (Array.isArray(key)) {
          let deleted = 0;
          for (const entry of key) if (values.delete(entry)) deleted += 1;
          return deleted;
        }
        return values.delete(key);
      },
      transactionSync: (callback: () => unknown) => callback(),
      sql: createTestSqlStorage(database),
    });
    const store = new WorkstreamObjectStore(storage, "test", "global");
    await store.waitUntilReady();

    expect(store.consumeSocketTicket("ticket-1", 2_000, 1_000)).toBe(true);
    expect(store.consumeSocketTicket("ticket-1", 2_000, 1_000)).toBe(false);
    database.close();
  });

  it("keeps active participants out of the ephemeral viewer list", () => {
    const viewers = distinctNonParticipantViewers([
      { userId: "participant", connectedAt: "2026-01-01T00:00:00.000Z" },
      { userId: "viewer", connectedAt: "2026-01-01T00:01:00.000Z" },
      { userId: "viewer", connectedAt: "2026-01-01T00:02:00.000Z" },
    ], new Set(["participant"]));
    expect(viewers).toEqual([
      { userId: "viewer", connectedAt: "2026-01-01T00:01:00.000Z" },
    ]);
  });

  it("disables a one-shot schedule after it runs", () => {
    expect(calculateNextOccurrence(timing(), new Date("2026-01-01T00:00:00.000Z"))).toBeNull();
  });
});
