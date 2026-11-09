import "../../../tests/isolated-region";
import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSocketEventSchema } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";

import { scheduledAlarmRetryDelay } from "../src/durable-objects/scheduled-alarms";
import {
  calculateNextOccurrence,
  type ScheduleTiming,
} from "../src/services/workspace-schedule-execution";
import {
  applyActiveStreamCheckpointEvent,
  distinctNonParticipantViewers,
  planSocketReplay,
  splitActiveStreamCheckpointText,
  conversationObjectName,
} from "../src/durable-objects/agent-loop-do";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import { unlistedResourceMetadata } from "../src/services/resource-listing";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { substreamLoopId } from "../src/durable-objects/names";
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
import { testSubstreamAgentsBinding } from "./helpers/durable-authority";
import { createTestSqlStorage } from "./helpers/sql-storage";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

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
  it("reads back only the runtime attachment and derives its work-stream direction", async () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      transactionSync: (callback: () => unknown) => callback(),
      setAlarm: async () => undefined,
      sql,
    });
    const store = new WorkstreamObjectStore(storage, "runtime-resource-test", "global");
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000061");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000062");
    const creatorId = asUserId("00000000-0000-7000-8000-000000000063");
    const generatedId = "00000000-0000-7000-8000-000000000064";
    const originId = "00000000-0000-7000-8000-000000000065";
    const readbackFailureId = "00000000-0000-7000-8000-000000000066";
    const backupId = "00000000-0000-7000-8000-000000000067";
    store.ensureIdentity({ workspaceId, parentKind: "canvas", parentId: workstreamId }, "global");
    sql.exec(
      `UPDATE workstream
          SET authority_mode = 'authoritative', authority_generation = 1,
              created_by_user_id = ?
        WHERE id = 1`,
      creatorId,
    );
    for (let index = 1; index <= 99; index += 1) {
      const resourceId = `00000000-0000-7000-9000-${String(index).padStart(12, "0")}`;
      sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, NULL, 0, 'attachment', '{}', ?, ?)`,
        resourceId,
        index,
        index,
      );
    }

    const workspace = preRetirementProductSqliteDatabase();
    workspace.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${creatorId}', 'runtime-resource-user', 'runtime@example.com', 'Runtime',
              '2026-09-02', '2026-09-02');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${workspaceId}', 'Runtime', 'runtime-resource', 'global', '${creatorId}',
              '2026-09-02', '2026-09-02');
    `);
    const descriptors = [
      { id: generatedId, title: "Generated recording.mp3", relationship: "generated" },
      { id: originId, title: "Slack thread", relationship: "origin" },
      { id: readbackFailureId, title: "Committed before readback failed", relationship: "generated" },
      { id: backupId, title: "Terminal backup before acme/widget", relationship: "generated", unlisted: true },
    ].map((entry) => ({
      id: entry.id,
      connection_id: null,
      resource_type: "generated_file",
      provider: "avalon_generated",
      provider_resource_id: `runtime:${entry.id}`,
      title: entry.title,
      mime_type: entry.relationship === "generated" ? "audio/mpeg" : "text/plain",
      content_ref: `global/${entry.id}`,
      content_sha256: "a".repeat(64),
      canonical_url: null,
      metadata_json: JSON.stringify({
        size: 1_024,
        ...("unlisted" in entry ? unlistedResourceMetadata() : {}),
      }),
      model_content_ref: null,
      model_mime_type: null,
      model_content_sha256: null,
      model_metadata_json: null,
      model_content_status: "unsupported" as const,
      model_content_extractor_version: null,
      model_content_error_code: null,
      created_at: "2026-09-02T10:35:06.000Z",
      updated_at: "2026-09-02T10:35:06.000Z",
    }));
    for (const descriptor of descriptors) {
      workspace.prepare(
        `INSERT INTO resources
           (id, workspace_id, resource_type, provider, provider_resource_id, title,
            mime_type, content_ref, content_sha256, metadata_json, attachment_status,
            model_content_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attached', ?, ?, ?)`,
      ).run(
        descriptor.id,
        workspaceId,
        descriptor.resource_type,
        descriptor.provider,
        descriptor.provider_resource_id,
        descriptor.title,
        descriptor.mime_type,
        descriptor.content_ref,
        descriptor.content_sha256,
        descriptor.metadata_json,
        descriptor.model_content_status,
        descriptor.created_at,
        descriptor.updated_at,
      );
    }
    const workspaceBinding = testSubstreamAgentsBinding(workspace, {
      extra: {
        resourceDescriptors: vi.fn(async (input: { resourceIds: string[] }) => ({
          items: descriptors.filter((descriptor) => input.resourceIds.includes(descriptor.id)),
        })),
      },
    });
    const workspaceStub = workspaceBinding.get(workspaceBinding.idFromName("runtime-resource-test")) as unknown as {
      executeRuntimeSql(input: { statements: Array<{ params: unknown[] }> }): unknown;
    };
    const executeRuntimeSql = workspaceStub.executeRuntimeSql.bind(workspaceStub);
    workspaceStub.executeRuntimeSql = (input) => {
      for (const statement of input.statements) {
        if (statement.params.length > 100) throw new Error("too many SQL variables");
      }
      return executeRuntimeSql(input);
    };
    const product = new WorkstreamObjectProductService(
      storage,
      store,
      createTestEnv({
        DB: sqliteD1(workspace),
        WORKSPACE_DOS: workspaceBinding,
        AVALON_REGION: "global",
      }),
    );

    await expect(product.attachRuntimeResource(
      workspaceId,
      generatedId,
      creatorId,
      "generated",
    )).resolves.toMatchObject({
      outcome: "attached",
      resource: {
        id: generatedId,
        relationshipType: "generated",
        direction: "artifact",
        sizeBytes: 1_024,
      },
    });
    await expect(product.attachRuntimeResource(
      workspaceId,
      originId,
      creatorId,
      "origin",
    )).resolves.toMatchObject({
      outcome: "attached",
      resource: { id: originId, relationshipType: "origin", direction: "source" },
    });
    expect(sql.exec<{ relationship_type: string }>(
      `SELECT relationship_type FROM workstream_resource_links WHERE resource_id = ?`,
      generatedId,
    ).one()).toEqual({ relationship_type: "generated" });
    // The live half of the listing rule. A socket event is how an open work
    // stream's rail learns about a resource without reloading, so it advertises
    // — and this is the one caller that turns a by-id read into a broadcast.
    // Attached, so the checkout receipt and an import still resolve it; not
    // published, so the rail keeps agreeing with the enumeration behind the
    // initial detail instead of disagreeing with it until the next reload.
    await expect(product.attachRuntimeResource(
      workspaceId,
      backupId,
      creatorId,
      "generated",
    )).resolves.toEqual({ outcome: "unlisted" });
    expect(sql.exec<{ relationship_type: string }>(
      `SELECT relationship_type FROM workstream_resource_links WHERE resource_id = ?`,
      backupId,
    ).one()).toEqual({ relationship_type: "generated" });

    workspaceStub.executeRuntimeSql = () => { throw new Error("workspace read unavailable"); };
    await expect(product.attachRuntimeResource(
      workspaceId,
      readbackFailureId,
      creatorId,
      "generated",
    )).resolves.toEqual({ outcome: "readback_failed" });
    expect(sql.exec<{ relationship_type: string }>(
      `SELECT relationship_type FROM workstream_resource_links WHERE resource_id = ?`,
      readbackFailureId,
    ).one()).toEqual({ relationship_type: "generated" });

    workspace.close();
    database.close();
  });

  it("returns a structured conflict before retained content gains new readers", async () => {
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
    const outsiderId = asUserId("00000000-0000-4000-8000-0000000000a4");
    store.ensureIdentity({ workspaceId, parentKind: "canvas", parentId: workstreamId }, "global");
    sql.exec(
      `UPDATE workstream
          SET authority_mode = 'authoritative', authority_generation = 1,
              scope = 'personal', created_by_user_id = ?
        WHERE id = 1`,
      creatorId,
    );
    const now = Date.now();
    sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, updated_at)
       VALUES (?, 'explicit', ?, 'active', 0, ?, NULL, ?)`,
      creatorId,
      creatorId,
      now,
      now,
    );
    sql.exec(
      `INSERT INTO content_audience_fences (fence_id, audience_json, created_at)
       VALUES ('accepted-resource', ?, ?)`,
      JSON.stringify({ scope: "users", userIds: [creatorId] }),
      now,
    );
    const regional = new DatabaseSync(":memory:");
    regional.exec(`CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, role TEXT NOT NULL, access_class TEXT NOT NULL DEFAULT 'member'
    )`);
    regional.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role)
       VALUES (?, ?, 'active', ?)`,
    ).run(workspaceId, creatorId, "owner");
    regional.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, role)
       VALUES (?, ?, 'active', 'member')`,
    ).run(workspaceId, outsiderId);
    const product = new WorkstreamObjectProductService(
      storage,
      store,
      createTestEnv({ DB: sqliteD1(regional) }),
    );
    const auth = {
      sessionId: "test-session",
      userId: creatorId,
      workspaceId,
      region: "global" as const,
      role: "owner" as const,
    };

    await expect(product.addParticipant(auth, outsiderId)).rejects.toMatchObject({
      status: 409,
      code: "workstream_audience_restricted_content",
    });
    await expect(product.update(auth, { scope: "workspace" })).rejects.toMatchObject({
      status: 409,
      code: "workstream_audience_restricted_content",
    });

    regional.close();
    database.close();
  });

  it("fences product failure on the singleton loop execution lease", async () => {
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
    store.ensureIdentity({ workspaceId, parentKind: "canvas", parentId: workstreamId }, "global");
    sql.exec(
      `UPDATE workstream
          SET authority_mode = 'authoritative', authority_generation = 1,
              exact_state = 'running', state_reason_code = 'workflow_started'
        WHERE id = 1`,
    );
    const now = Date.now();
    const loopId = substreamLoopId(workstreamId);
    const leaseOwner = "successor-owner";
    const loops = new SubstreamLoopStorage(storage);
    loops.ensureLoop({ loopId, bindStateRevision: 0, now });
    sql.exec(
      `INSERT INTO runs (
         run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
         model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
         active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
         tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
         execution_context_json, created_at, updated_at
       ) VALUES (?, '0', NULL, 'admitted', '{}', 0, 0, '', 0, 0, ?,
                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}', ?, ?)`,
      runId,
      now,
      now,
      now,
    );
    loops.activateExecutionReceipt({
      runId,
      loopId,
      expectedLoopRevision: loops.loop()!.revision,
      expectedBindStateRevision: 0,
      executionEpoch: 1,
      leaseOwner,
      leaseExpiresAt: now + 60_000,
      now,
    });
    sql.exec(
      `INSERT INTO active_output_turns
         (run_id, attempt_epoch, turn_id, transcript_sequence, substream_id, status,
          durable_event_seq, durable_through_frame_seq, next_chunk_index, stream_id,
          seen_turn_ids_json, turn_start_offset, started_at, checkpointed_at, updated_at)
       VALUES (?, 0, 'failure-turn', 1, '0', 'streaming', 1, 1, 1,
               'failure-stream', '[]', 0, ?, ?, ?)`,
      runId,
      now,
      now,
      now,
    );
    const product = new WorkstreamObjectProductService(storage, store, createTestEnv({}));

    await expect(product.recordWorkflowFailed(
      runId,
      { code: "provider_failed", message: "Provider failed" },
      { loopId, executionId: runId, executionEpoch: 1, leaseOwner: "stale-owner" },
    )).rejects.toThrow("workstream_run_failure_fenced");
    expect(sql.exec<{ status: string }>(
      `SELECT status FROM runs WHERE run_id = ?`, runId,
    ).toArray()[0]).toEqual({ status: "running" });
    expect(sql.exec<{ exact_state: string }>(
      `SELECT exact_state FROM workstream WHERE id = 1`,
    ).toArray()[0]).toEqual({ exact_state: "running" });

    sql.exec(`UPDATE substream_loops SET lease_expires_at = 1 WHERE id = 1`);
    await expect(product.recordWorkflowFailed(
      runId,
      { code: "provider_failed", message: "Provider failed" },
      { loopId, executionId: runId, executionEpoch: 1, leaseOwner },
    )).rejects.toThrow("workstream_run_failure_fenced");
    expect(sql.exec<{ status: string }>(
      `SELECT status FROM runs WHERE run_id = ?`, runId,
    ).toArray()[0]).toEqual({ status: "running" });

    sql.exec(
      `UPDATE substream_loops SET lease_expires_at = ? WHERE id = 1`,
      Date.now() + 60_000,
    );
    await expect(product.recordWorkflowFailed(
      runId,
      { code: "provider_failed", message: "Provider failed" },
      { loopId, executionId: runId, executionEpoch: 1, leaseOwner },
    )).resolves.toBeUndefined();
    expect(sql.exec<{ status: string; terminal_reason: string; legacy_attempt_id: string }>(
      `SELECT status, terminal_reason, legacy_attempt_id FROM runs WHERE run_id = ?`, runId,
    ).toArray()[0]).toEqual({
      status: "failed",
      terminal_reason: "failed",
      legacy_attempt_id: `workflow-failure:${runId}`,
    });
    expect(sql.exec<{ status: string; attempt_id: string }>(
      `SELECT status, attempt_id FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'terminal'`,
      runId,
    ).toArray()[0]).toEqual({
      status: "failed",
      attempt_id: `workflow-failure:${runId}`,
    });
    expect(sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM active_output_turns WHERE run_id = ?`,
      runId,
    ).toArray()[0]).toEqual({ count: 0 });
    expect(sql.exec<{ exact_state: string }>(
      `SELECT exact_state FROM workstream WHERE id = 1`,
    ).toArray()[0]).toEqual({ exact_state: "failed" });
    database.close();
  });

  it.each([
    ["global", "-122.4194", "wnam"],
    ["global", "-73.9857", "enam"],
    ["enterprise", "-0.1276", "weur"],
    ["enterprise", "30.5234", "eeur"],
  ] as const)("derives %s workspace affinity from request longitude %s", (region, longitude, expected) => {
    expect(deriveWorkspacePlacementAffinity(region, { longitude })).toEqual({
      affinity: expected,
      source: "request_longitude",
    });
  });

  it.each([
    ["global", undefined, "wnam"],
    ["enterprise", { longitude: "not-a-coordinate" }, "weur"],
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

  it("replays the canonical turn and discards a preparation the canonical write outran", async () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    // The admission transaction re-checks `client_message_id` because a
    // canonical turn can land during the asynchronous preparation window.
    // This hook commits exactly that interleaving deterministically: the
    // canonical write happens after admission's outer replay checks ran, but
    // before its commit transaction observes the world.
    let commitCanonicalBeforeNextTransaction: (() => void) | null = null;
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (callback: () => unknown) => {
        const inject = commitCanonicalBeforeNextTransaction;
        commitCanonicalBeforeNextTransaction = null;
        if (inject) inject();
        return callback();
      },
      sql,
    });
    const store = new WorkstreamObjectStore(storage, "test", "global");
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-0000000000b1");
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-0000000000b2");
    store.ensureIdentity({ workspaceId, parentKind: "canvas", parentId: workstreamId }, "global");
    sql.exec(
      `UPDATE workstream
          SET authority_mode = 'authoritative', authority_generation = 1,
              scope = 'workspace', exact_state = 'running'
        WHERE id = 1`,
    );
    const product = new WorkstreamObjectProductService(storage, store, createTestEnv({}));
    const transcript = new WorkstreamTranscriptStorage(storage);
    const now = Date.now();
    const clientMessageId = "external:duplicate-delivery:1";
    const canonicalTurnId = "00000000-0000-7000-8000-0000000000b3";
    const canonical = await transcript.prepareParticipantMessage({
      turnId: canonicalTurnId,
      actor: "external",
      authorUserId: null,
      authorSnapshot: null,
      clientMessageId,
      messageType: "text",
      text: "Duplicate connector delivery",
      structuredContentJson: null,
      externalActorJson: JSON.stringify({
        provider: "slack",
        providerAccountId: "team-1",
        providerUserId: "member-1",
        displayName: "Slack Member",
        avatarUrl: null,
      }),
      producedByRunId: null,
      messageSequenceNumber: 1,
      createdAtUtc: new Date(now).toISOString(),
      attentionOrdinal: null,
    });
    commitCanonicalBeforeNextTransaction = () => {
      transcript.appendPreparedParticipantMessage(canonical);
    };

    const inputId = "00000000-0000-7000-8000-0000000000b4";
    const result = await product.admitExternalMessage({
      workspaceId,
      workstreamId,
      messageId: inputId,
      clientMessageId,
      actor: {
        provider: "slack",
        providerAccountId: "team-1",
        providerUserId: "member-1",
        displayName: "Slack Member",
        avatarUrl: null,
      },
      text: "Duplicate connector delivery",
      structuredContentJson: null,
      executionPrincipal: { type: "workspace", workspaceId },
      origin: "slack_message",
      messageType: "text",
      runMode: "steer",
      now,
    });

    // The canonical write actually raced (the hook fired), and the admission
    // answered with the canonical turn instead of admitting a duplicate.
    expect(commitCanonicalBeforeNextTransaction).toBeNull();
    expect(result).toMatchObject({
      deliveryState: "canonical",
      inserted: false,
      activationRequest: null,
      turn: { turnId: canonicalTurnId, clientMessageId },
    });
    // The outran preparation is discarded, not left to deliver a second copy.
    expect(sql.exec<{ state: string }>(
      `SELECT state FROM pending_loop_input_mailbox WHERE input_id = ?`,
      inputId,
    ).one().state).toBe("discarded");
    expect(new SubstreamLoopStorage(storage).inputByClientMessageId(clientMessageId)).toBeUndefined();
    // Exactly one canonical turn owns the client message id.
    expect(sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details
        WHERE client_message_id = ?`,
      clientMessageId,
    ).one().count).toBe(1);
    database.close();
  });

  it("uses a region/workspace/work-stream stable room name", () => {
    expect(conversationObjectName(
      "enterprise",
      asWorkspaceId("00000000-0000-4000-8000-00000000000a"),
      asWorkstreamId("00000000-0000-4000-8000-00000000000b"),
    )).toBe(
      "enterprise:00000000-0000-4000-8000-00000000000a:00000000-0000-4000-8000-00000000000b"
    );
  });

  it("locks Durable Object IDs and first placement to the product region", () => {
    const usStub = {};
    const enterpriseStub = {};
    const usId = createTestDurableObjectId("us-id");
    const enterpriseId = createTestDurableObjectId("enterprise-id");
    const usGet = vi.fn(() => usStub);
    const enterpriseGet = vi.fn(() => enterpriseStub);
    const usIdFromName = vi.fn(() => usId);
    const enterpriseIdFromName = vi.fn(() => enterpriseId);
    const usNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
      get: usGet,
      idFromName: usIdFromName,
    });
    const enterpriseNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
      get: enterpriseGet,
      idFromName: enterpriseIdFromName,
    });
    const jurisdiction = vi.fn((value: DurableObjectJurisdiction) => (
      value === "us" ? usNamespace : enterpriseNamespace
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
      { AVALON_REGION: "enterprise", APP_ENV: "production" },
      namespace,
      "enterprise",
      "workspace-two",
      "weur",
    )).toBe(enterpriseStub);
    expect(jurisdiction.mock.calls).toEqual([["us"], ["eu"]]);
    expect(usIdFromName).toHaveBeenCalledWith("workspace-one");
    expect(enterpriseIdFromName).toHaveBeenCalledWith("workspace-two");
    expect(usGet).toHaveBeenCalledWith(usId, { locationHint: "wnam" });
    expect(enterpriseGet).toHaveBeenCalledWith(enterpriseId, { locationHint: "weur" });
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
      { AVALON_REGION: "enterprise", APP_ENV: "test" },
      namespace,
      "enterprise",
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
      createTestJurisdictionalDurableObjectId("other-object", "eu"),
      "global",
      "production",
    )).toThrow("durable_object_jurisdiction_mismatch:us:eu");
  });

  it("replays an available window and snapshots canonical state after hibernation", () => {
    const event = ServerSocketEventSchema.parse({
      type: "harness_status_changed",
      sequence: 12,
      occurredAt: "2026-01-01T00:00:00.000Z",
      status: "running",
    });

    expect(planSocketReplay(11, 12, 11, [event])).toEqual({ type: "replay", events: [event] });
    expect(planSocketReplay(11, 12, null, [])).toEqual({
      type: "snapshot",
      reason: "history_unavailable",
    });
    expect(planSocketReplay(11, 12, 11, [])).toEqual({
      type: "snapshot",
      reason: "history_unavailable",
    });
    expect(planSocketReplay(13, 12, 11, [event])).toEqual({
      type: "resync_required",
      reason: "sequence_ahead",
    });
    expect(planSocketReplay(0, 12, null, [])).toEqual({ type: "snapshot", reason: "initial" });
    const firstEvent = { ...event, sequence: 1 };
    expect(planSocketReplay(0, 1, 0, [firstEvent], false)).toEqual({
      type: "replay",
      events: [firstEvent],
    });
    expect(planSocketReplay(4, 12, 8, [event], false)).toEqual({
      type: "resync_required",
      reason: "history_unavailable",
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
      streamId: messageId,
      harnessRunId,
      turnId: "turn-one",
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: "Missing prefix",
    }))).toEqual([]);
    let checkpoints = applyActiveStreamCheckpointEvent([], ServerSocketEventSchema.parse({
      type: "stream_started",
      sequence: 10,
      occurredAt: at,
      streamId: messageId,
      harnessRunId,
      turnId: "turn-one",
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 11,
      occurredAt: at,
      streamId: messageId,
      turnId: "turn-one",
      transcriptSequence: 1,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: "First answer.",
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_started",
      sequence: 12,
      occurredAt: at,
      streamId: messageId,
      harnessRunId,
      turnId: "turn-two",
      transcriptSequence: 2,
      epoch: 0,
      streamSeq: 0,
      reset: false,
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 13,
      occurredAt: at,
      streamId: messageId,
      turnId: "turn-two",
      transcriptSequence: 2,
      epoch: 0,
      streamSeq: 1,
      reset: false,
      delta: " Discard this attempt.",
    }));
    checkpoints = applyActiveStreamCheckpointEvent(checkpoints, ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 14,
      occurredAt: at,
      streamId: messageId,
      turnId: "turn-two",
      transcriptSequence: 2,
      epoch: 1,
      streamSeq: 2,
      reset: true,
      delta: " Final continuation.",
    }));

    expect(checkpoints).toEqual([expect.objectContaining({
      streamId: messageId,
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
