/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Terminal's object-local authority, exercised on real workerd.
 *
 * Every test here goes through `/internal/terminal` — the same entry point the
 * Worker uses — against a real Durable Object: real SQLite, real foreign keys
 * (workerd enforces them and refuses to let a PRAGMA turn them off), real
 * CHECK constraints, real transactions, and real eviction.
 *
 * That matters because what this subsystem gets wrong is never the shape of a
 * single statement. It is the interaction: a lease decided on state that has
 * already moved, a claim that races an alarm, a two-statement sequence whose
 * guard only held while both halves shared a transaction. The Node suite runs
 * the same schema over `node:sqlite` and proves the SQL; only this suite can
 * prove the object serializes it.
 *
 * Daytona is absent, and nothing here needs it: every property under test
 * concerns what Avalon durably decides before and after a provider call.
 */

import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import type { TerminalOperation } from "../src/durable-objects/workstream-terminal-protocol";
import { rpcResultBody } from "../src/durable-objects/rpc-result";
import {
  createTerminalPortFactory,
  type TerminalPortFactory,
} from "../src/services/terminal/object-port";
import type { Env } from "../src/env";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedOpenWorkstreamAuthority,
  seedParticipantMessage,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`),
    ),
  ));
}

/** The one main-child object whose Terminal tables are work-stream authority. */
function mainAgent(): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, WORKSTREAM_ID, asSubstreamId("0")),
  ));
}

const RUN_A = "00000000-0000-7000-8000-00000000ra01";
const RUN_B = "00000000-0000-7000-8000-00000000rb02";
const EFFECT_A = "terminal-effect-a";
const TASK_A = "terminal-task-a";

/** Call the real endpoint, exactly as the Worker's port does. */
async function terminal(
  stub: DurableObjectStub,
  operation: string,
  ...args: unknown[]
): Promise<{ status: number; value: unknown; error?: string }> {
  const { status, body } = await post(stub, "/internal/terminal", {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation,
    args,
  });
  const parsed = body as { value?: unknown; error?: string } | null;
  return { status, value: parsed?.value ?? null, ...(parsed?.error ? { error: parsed.error } : {}) };
}

/**
 * Run a Terminal operation and read the effects it enqueued, in one invocation.
 *
 * The delivery alarm deletes each `durable_outbox` row the moment it forwards
 * it to the parent, so a test that reads those rows in a later call is racing
 * a drain that means the effect *succeeded* — and losing that race looks
 * exactly like the effect never having been enqueued. Parking the alarm is not
 * enough either: the object re-arms one when it is next opened.
 *
 * So the read happens here, synchronously, with no await between the operation
 * returning and the query. Within one invocation the input gate is closed and
 * the alarm cannot interleave.
 *
 * Do not reach for `blockConcurrencyWhile` to build this fence — it holds the
 * gate `reset()` needs, and defers the test's own writes into the next test.
 */
async function terminalCommonEffects(
  stub: DurableObjectStub,
  operation: TerminalOperation,
  ...args: unknown[]
): Promise<Array<string | null | undefined>> {
  return runInDurableObject(stub, async (instance, state) => {
    // The stub is untyped here; this file drives one class and it defines this.
    await (instance as SubstreamAgent).executeTerminalOperation({
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation,
      args,
    });
    return state.storage.sql.exec<{ payload_json: string | null }>(
      `SELECT payload_json FROM durable_outbox
        WHERE channel = 'regional_effect_v1' AND partition_key = 'common'`,
    ).toArray()
      .map((row) => JSON.parse(row.payload_json ?? "{}") as {
        effect?: { nextTerminalActionAt?: string | null };
      })
      .map((body) => body.effect?.nextTerminalActionAt)
      .filter((value) => value !== undefined);
  });
}

function seedRunRow(state: DurableObjectState, runId: string, status: string, now = 1): void {
  state.storage.sql.exec(
    `INSERT INTO runs (
       run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
       model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
       active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
       tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
       created_at, updated_at
     ) VALUES (?, '0', NULL, ?, '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
    runId,
    status,
    now,
    now,
    now,
  );
}

/** A tool effect for the task and publication foreign keys to land on. */
function seedEffect(state: DurableObjectState, effectId: string, runId: string, position = 0): void {
  state.storage.sql.exec(
    `INSERT INTO tool_effects (
       effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
       tool_name, mode, request_hash, authority_revision, status, tool_call_id, input_json
     ) VALUES (?, ?, 0, ?, ?, 'terminal_run_command', 'write', 'hash', 'rev', 'admitted', ?, '{}')`,
    effectId,
    runId,
    position,
    `occurrence-${position}`,
    `call-${position}`,
  );
}

/** The sandbox every lifecycle test starts from, reserved through the port. */
async function reserve(
  stub: DurableObjectStub,
  runId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await terminal(stub, "reserveFirstGeneration", {
    stableName: "avalon-e2e",
    authorityFingerprint: "authority",
    networkRevision: 1,
    runId,
    operationLeaseExpiresAt: 1_000_000,
    idleExpiresAt: 2_000_000,
    archiveDueAt: 3_000_000,
    expireDueAt: 4_000_000,
    now: 1_000,
    ...overrides,
  });
  expect(result.status).toBe(200);
  return result.value as Record<string, unknown>;
}

/**
 * The resident Terminal factory as a run gets it: built from the execution
 * environment the object installs its authorities on, rather than from a
 * method that hands one out. That is the boundary under test — if the
 * installation regresses, this factory dispatches and the assertions below
 * catch it at the object's own RPC method.
 */
function residentExecutionEnvironment(instance: object): Env {
  return (instance as unknown as {
    localRuntimeEnvironment(workspaceId: string, workstreamId: string, substreamId: string): Env;
  }).localRuntimeEnvironment(WORKSPACE_ID, WORKSTREAM_ID, "0");
}

function residentTerminalFactory(instance: object): TerminalPortFactory {
  return createTerminalPortFactory(residentExecutionEnvironment(instance));
}

describe("Terminal authority on real workerd", () => {
  it("returns typed non-retryable protocol and routing rejections", async () => {
    const stub = agent();
    await boot(stub);

    const invalid = await post(stub, "/internal/terminal", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "operation-from-a-newer-worker",
      args: [],
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      error: "invalid_terminal_operation",
      failure: {
        code: "invalid_terminal_operation",
        outcome: "rejected",
        retryable: false,
      },
    });

    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
    const misrouted = await post(stub, "/internal/terminal", {
      workspaceId: "00000000-0000-7000-8000-00000000ffff",
      workstreamId: WORKSTREAM_ID,
      operation: "sandbox",
      args: [],
    });
    expect(misrouted.status).toBe(409);
    expect(misrouted.body).toMatchObject({
      error: "workstream_terminal_identity_mismatch",
      failure: {
        code: "workstream_terminal_identity_mismatch",
        outcome: "rejected",
        retryable: false,
      },
    });
  });

  it("returns a typed retry contract without exposing a pre-commit storage cause", async () => {
    const stub = agent();
    await boot(stub);
    const result = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      seedRunRow(state, RUN_A, "running");
      const terminal = (instance as unknown as {
        terminal: { reserveFirstGeneration(input: unknown): unknown };
      }).terminal;
      Object.defineProperty(terminal, "reserveFirstGeneration", {
        configurable: true,
        value: () => { throw new Error("raw sqlite constraint and private detail"); },
      });
      return (instance as unknown as {
        executeTerminalOperation(input: Record<string, unknown>): Promise<{
          status: number;
          bodyJson: string;
        }>;
      }).executeTerminalOperation({
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        operation: "reserveFirstGeneration",
        args: [{
          stableName: "avalon-precommit-proof",
          authorityFingerprint: "authority",
          networkRevision: 1,
          runId: RUN_A,
          operationLeaseExpiresAt: 1_000_000,
          idleExpiresAt: 2_000_000,
          archiveDueAt: 3_000_000,
          expireDueAt: 4_000_000,
          now: 1_000,
        }],
      });
    });

    expect(result.status).toBe(409);
    expect(rpcResultBody(result)).toMatchObject({
      ok: false,
      error: "terminal_operation_not_committed",
      failure: {
        code: "terminal_operation_not_committed",
        outcome: "not_committed",
        retryable: true,
      },
    });
    expect(JSON.stringify(rpcResultBody(result))).not.toContain("sqlite");
    expect(JSON.stringify(rpcResultBody(result))).not.toContain("private detail");
  });

  it("returns a committed mutation even when its follow-up alarm cannot be scheduled", async () => {
    const stub = agent();
    await boot(stub);
    const result = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      seedRunRow(state, RUN_A, "running");
      Object.defineProperty(instance, "scheduleNextAlarm", {
        configurable: true,
        value: async () => { throw new Error("injected_alarm_failure"); },
      });
      try {
        return await (instance as unknown as {
          executeTerminalOperation(input: Record<string, unknown>): Promise<{
            status: number;
            bodyJson: string;
          }>;
        }).executeTerminalOperation({
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          operation: "reserveFirstGeneration",
          args: [{
            stableName: "avalon-alarm-proof",
            authorityFingerprint: "authority",
            networkRevision: 1,
            runId: RUN_A,
            operationLeaseExpiresAt: 1_000_000,
            idleExpiresAt: 2_000_000,
            archiveDueAt: 3_000_000,
            expireDueAt: 4_000_000,
            now: 1_000,
          }],
        });
      } finally {
        delete (instance as unknown as Record<string, unknown>).scheduleNextAlarm;
      }
    });

    // The SQLite transaction is already committed before alarm scheduling.
    // Reporting failure here would invite a caller to repeat a write that did
    // happen; the durable directory effect and scheduler sweep own recovery.
    expect(result.status).toBe(200);
    expect(rpcResultBody(result)).toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ stable_name: string }>(
        `SELECT stable_name FROM terminal_workspace WHERE id = 1`,
      ).one().stable_name).toBe("avalon-alarm-proof");
    });
  });

  it("keeps sequential resident-agent Terminal operations in the owning event", async () => {
    const stub = mainAgent();
    await boot(stub);
    const result = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      seedRunRow(state, RUN_A, "running", Date.now());
      const terminalPortFactory = residentTerminalFactory(instance);
      const terminal = terminalPortFactory(WORKSPACE_ID, WORKSTREAM_ID);
      const now = Date.now();
      // If this port regresses to namespace routing, its first call re-enters
      // this object's public RPC method and the test fails at the exact
      // request-context boundary production crossed.
      Object.defineProperty(instance, "executeTerminalOperation", {
        configurable: true,
        value: () => { throw new Error("resident_terminal_self_rpc"); },
      });
      try {
        await terminal.reserveFirstGeneration({
          stableName: "avalon-resident-agent",
          authorityFingerprint: "authority",
          networkRevision: 1,
          runId: RUN_A,
          operationLeaseExpiresAt: now + 60_000,
          idleExpiresAt: now + 120_000,
          archiveDueAt: now + 180_000,
          expireDueAt: now + 240_000,
          now,
        });
        await terminal.attachProviderSandbox({
          generation: 1,
          sandboxId: "sandbox-resident-agent",
          lifecycleState: "running",
          idleExpiresAt: now + 120_000,
          archiveDueAt: now + 180_000,
          expireDueAt: now + 240_000,
          now: now + 1,
        });
        const first = await terminal.claimOperation({
          runId: RUN_A,
          generation: 1,
          leaseExpiresAt: now + 60_000,
          now: now + 2,
        });
        const second = await terminal.claimOperation({
          runId: RUN_A,
          generation: 1,
          leaseExpiresAt: now + 90_000,
          now: now + 3,
        });
        return { first, second, sandbox: await terminal.sandbox() };
      } finally {
        delete (instance as unknown as Record<string, unknown>).executeTerminalOperation;
      }
    });

    expect(result.first).toMatchObject({
      sandboxId: "sandbox-resident-agent",
      operationRunId: RUN_A,
    });
    expect(result.second).toMatchObject({
      sandboxId: "sandbox-resident-agent",
      operationRunId: RUN_A,
      operationLeaseExpiresAt: expect.any(Number),
    });
    expect(result.sandbox).toMatchObject({
      sandboxId: "sandbox-resident-agent",
      operationRunId: RUN_A,
    });
  });

  it("rejects a mismatched identity at the resident Terminal factory boundary", async () => {
    const stub = mainAgent();
    await boot(stub);
    const failure = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      const terminalPortFactory = residentTerminalFactory(instance);
      try {
        await terminalPortFactory(
          "00000000-0000-7000-8000-00000000ffff",
          WORKSTREAM_ID,
        ).sandbox();
        return null;
      } catch (error) {
        return error instanceof Error && "code" in error
          ? { name: error.name, code: error.code }
          : { name: "unknown", code: null };
      }
    });

    expect(failure).toEqual({
      name: "TerminalObjectPortError",
      code: "workstream_terminal_identity_mismatch",
    });
  });

  it("keeps resident-agent resource attachments in the owning artifact event and broadcasts them", async () => {
    const stub = mainAgent();
    await boot(stub);
    const resourceId = "00000000-0000-7000-8000-00000000aa03";
    const outcome = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      const recorded: unknown[][] = [];
      const emitted: unknown[] = [];
      const resource = {
        id: resourceId,
        slug: null,
        workspaceId: WORKSPACE_ID,
        connectionId: null,
        resourceType: "generated_file",
        provider: "avalon_generated",
        providerResourceId: "generated:effect",
        title: "Generated recording.mp3",
        mimeType: "audio/mpeg",
        canonicalUrl: null,
        refreshSupported: false,
        watchEnabled: false,
        watchStatus: "unsupported" as const,
        lastHydratedAt: null,
        createdAt: "2026-09-02T10:35:06.000Z",
        updatedAt: "2026-09-02T10:35:06.000Z",
        contentAvailable: true,
        sizeBytes: 1_024,
        currentVersion: 1,
        relationshipType: "generated" as const,
        direction: "artifact" as const,
      };
      const product = (instance as unknown as {
        product: { attachRuntimeResource(...args: unknown[]): Promise<typeof resource> };
      }).product;
      const attacher = (instance as unknown as {
        localRuntimeResourceAttacher(
          workspaceId: string,
          workstreamId: string,
        ): (input: Record<string, unknown>) => Promise<void>;
      }).localRuntimeResourceAttacher(WORKSPACE_ID, WORKSTREAM_ID);
      const snapshotState = instance as unknown as {
        preparedSocketAdmissions: Map<string, { snapshot: unknown }>;
        preparedSocketSnapshotTicketId: string | null;
        socketSnapshotRevision: number;
      };
      const preparedTicketId = "00000000-0000-7000-8000-00000000aa05";
      snapshotState.preparedSocketAdmissions.set(preparedTicketId, { snapshot: { stale: true } });
      snapshotState.preparedSocketSnapshotTicketId = preparedTicketId;
      const snapshotRevisionBefore = snapshotState.socketSnapshotRevision;
      Object.defineProperty(instance, "attachRuntimeResource", {
        configurable: true,
        value: () => { throw new Error("resident_resource_self_rpc"); },
      });
      Object.defineProperty(product, "attachRuntimeResource", {
        configurable: true,
        value: async (...args: unknown[]) => {
          recorded.push(args);
          return resource;
        },
      });
      Object.defineProperty(instance, "broadcast", {
        configurable: true,
        value: (event: unknown) => { emitted.push(event); },
      });
      try {
        await attacher({
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          resourceId,
          attachedByUserId: null,
          relationshipType: "generated",
        });
        const realtime = state.storage.sql.exec<{ event_sequence: number }>(
          `SELECT event_sequence FROM realtime_state WHERE id = 1`,
        ).toArray()[0];
        return {
          recorded,
          emitted,
          eventSequence: realtime?.event_sequence ?? null,
          preparedSnapshot: snapshotState.preparedSocketAdmissions.get(preparedTicketId)?.snapshot,
          preparedSnapshotTicketId: snapshotState.preparedSocketSnapshotTicketId,
          snapshotRevision: snapshotState.socketSnapshotRevision,
          snapshotRevisionBefore,
        };
      } finally {
        snapshotState.preparedSocketAdmissions.delete(preparedTicketId);
        delete (instance as unknown as Record<string, unknown>).attachRuntimeResource;
        delete (instance as unknown as Record<string, unknown>).broadcast;
        delete (product as unknown as Record<string, unknown>).attachRuntimeResource;
      }
    });

    expect(outcome.recorded).toEqual([[
      WORKSPACE_ID,
      resourceId,
      null,
      "generated",
    ]]);
    expect(outcome.eventSequence).toBe(1);
    expect(outcome.preparedSnapshot).toBeNull();
    expect(outcome.preparedSnapshotTicketId).toBeNull();
    expect(outcome.snapshotRevision).toBe(outcome.snapshotRevisionBefore + 1);
    expect(outcome.emitted).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "resource_attached",
        resource: expect.objectContaining({
          id: resourceId,
          relationshipType: "generated",
          direction: "artifact",
          title: "Generated recording.mp3",
        }),
      }),
    ]);
  });

  it("forces canonical resync when a committed resource event is deferred", async () => {
    const stub = mainAgent();
    await boot(stub);
    const resourceId = "00000000-0000-7000-8000-00000000aa06";
    const outcome = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      const resource = {
        id: resourceId,
        slug: null,
        workspaceId: WORKSPACE_ID,
        connectionId: null,
        resourceType: "generated_file",
        provider: "avalon_generated",
        providerResourceId: "generated:deferred",
        title: "Deferred recording.mp3",
        mimeType: "audio/mpeg",
        canonicalUrl: null,
        refreshSupported: false,
        watchEnabled: false,
        watchStatus: "unsupported" as const,
        lastHydratedAt: null,
        createdAt: "2026-09-02T10:35:06.000Z",
        updatedAt: "2026-09-02T10:35:06.000Z",
        contentAvailable: true,
        sizeBytes: 1_024,
        currentVersion: 1,
        relationshipType: "generated" as const,
        direction: "artifact" as const,
      };
      const product = (instance as unknown as {
        product: { attachRuntimeResource(...args: unknown[]): Promise<typeof resource> };
      }).product;
      const attacher = (instance as unknown as {
        localRuntimeResourceAttacher(
          workspaceId: string,
          workstreamId: string,
        ): (input: Record<string, unknown>) => Promise<void>;
      }).localRuntimeResourceAttacher(WORKSPACE_ID, WORKSTREAM_ID);
      const captured: unknown[] = [];
      Object.defineProperty(product, "attachRuntimeResource", {
        configurable: true,
        value: async () => resource,
      });
      Object.defineProperty(instance, "flushSemanticRealtimeOutboxBestEffort", {
        configurable: true,
        value: async () => false,
      });
      Object.defineProperty(instance, "broadcast", {
        configurable: true,
        value: (event: unknown) => { captured.push(event); },
      });
      (instance as unknown as { semanticRealtimePending: boolean }).semanticRealtimePending = true;
      const sequenceBefore = state.storage.sql.exec<{ event_sequence: number }>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ).toArray()[0]?.event_sequence ?? 0;
      try {
        await attacher({
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          resourceId,
          attachedByUserId: null,
          relationshipType: "generated",
        });
        const sequenceAfter = state.storage.sql.exec<{ event_sequence: number }>(
          `SELECT event_sequence FROM realtime_state WHERE id = 1`,
        ).toArray()[0]?.event_sequence ?? 0;
        return { captured, sequenceBefore, sequenceAfter };
      } finally {
        (instance as unknown as { semanticRealtimePending: boolean }).semanticRealtimePending = false;
        delete (instance as unknown as Record<string, unknown>).flushSemanticRealtimeOutboxBestEffort;
        delete (instance as unknown as Record<string, unknown>).broadcast;
        delete (product as unknown as Record<string, unknown>).attachRuntimeResource;
      }
    });

    expect(outcome.sequenceAfter).toBe(outcome.sequenceBefore);
    expect(outcome.captured).toEqual([
      expect.objectContaining({
        type: "resync_required",
        reason: "history_unavailable",
        sequence: outcome.sequenceAfter,
        latestSequence: outcome.sequenceAfter,
      }),
    ]);
  });

  it("keeps committed resource attachments successful when readback or publication fails", async () => {
    const stub = mainAgent();
    await boot(stub);
    const readbackFailureId = "00000000-0000-7000-8000-00000000aa07";
    const publishFailureId = "00000000-0000-7000-8000-00000000aa08";
    const outcome = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      const resource = {
        id: publishFailureId,
        slug: null,
        workspaceId: WORKSPACE_ID,
        connectionId: null,
        resourceType: "generated_file",
        provider: "avalon_generated",
        providerResourceId: "generated:publish-failure",
        title: "Committed recording.mp3",
        mimeType: "audio/mpeg",
        canonicalUrl: null,
        refreshSupported: false,
        watchEnabled: false,
        watchStatus: "unsupported" as const,
        lastHydratedAt: null,
        createdAt: "2026-09-02T10:35:06.000Z",
        updatedAt: "2026-09-02T10:35:06.000Z",
        contentAvailable: true,
        sizeBytes: 1_024,
        currentVersion: 1,
        relationshipType: "generated" as const,
        direction: "artifact" as const,
      };
      const product = (instance as unknown as {
        product: { attachRuntimeResource(...args: unknown[]): Promise<typeof resource | null> };
      }).product;
      const attacher = (instance as unknown as {
        localRuntimeResourceAttacher(
          workspaceId: string,
          workstreamId: string,
        ): (input: Record<string, unknown>) => Promise<void>;
      }).localRuntimeResourceAttacher(WORKSPACE_ID, WORKSTREAM_ID);
      const captured: unknown[] = [];
      const published: unknown[] = [];
      Object.defineProperty(product, "attachRuntimeResource", {
        configurable: true,
        value: async (_workspaceId: string, resourceId: string) =>
          resourceId === readbackFailureId ? null : resource,
      });
      Object.defineProperty(instance, "publishLocalProductEvent", {
        configurable: true,
        value: async (...args: unknown[]) => {
          published.push(args);
          throw new Error("room unavailable");
        },
      });
      Object.defineProperty(instance, "broadcast", {
        configurable: true,
        value: (event: unknown) => { captured.push(event); },
      });
      try {
        for (const resourceId of [readbackFailureId, publishFailureId]) {
          await attacher({
            workspaceId: WORKSPACE_ID,
            workstreamId: WORKSTREAM_ID,
            resourceId,
            attachedByUserId: null,
            relationshipType: "generated",
          });
        }
        return { captured, published };
      } finally {
        delete (instance as unknown as Record<string, unknown>).publishLocalProductEvent;
        delete (instance as unknown as Record<string, unknown>).broadcast;
        delete (product as unknown as Record<string, unknown>).attachRuntimeResource;
      }
    });

    expect(outcome.published).toHaveLength(1);
    expect(outcome.captured).toEqual([
      expect.objectContaining({ type: "resync_required", reason: "history_unavailable" }),
      expect.objectContaining({ type: "resync_required", reason: "history_unavailable" }),
    ]);
  });

  it("refuses local Terminal and resource authority in a non-main child", async () => {
    const stub = agent();
    await boot(stub);
    const failures = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      // Genuinely non-main, whatever this object was before: Terminal is
      // work-stream-wide authority held by the main child, so a non-main
      // substream must reach it over the wire rather than out of its own
      // storage.
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO substream_agent_identity
           (id, external_substream_id, created_at, updated_at)
         VALUES (1, '00000000-0000-7000-8000-000000000001', 1, 1)`,
      );
      // Read back rather than trusted: this assertion is only about a non-main
      // child, and a write that silently did nothing would leave it testing the
      // main child's behaviour under a misleading name.
      expect(state.storage.sql.exec<{ external_substream_id: string }>(
        `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
      ).one().external_substream_id).not.toBe("0");
      const resourceAttacher = (instance as unknown as {
        localRuntimeResourceAttacher(
          workspaceId: string,
          workstreamId: string,
        ): (input: Record<string, unknown>) => Promise<void>;
      }).localRuntimeResourceAttacher(WORKSPACE_ID, WORKSTREAM_ID);
      const observed: string[] = [];
      // Not a sentinel on this instance: a dispatched port reaches the *main*
      // child, a different object, which would answer normally and prove
      // nothing. Making the namespace unusable is what distinguishes the two —
      // a port that answers here held local authority, and a non-main child
      // must not.
      const execution = new Proxy(residentExecutionEnvironment(instance), {
        get(target, property, receiver) {
          if (property === "SUBSTREAM_AGENTS") {
            throw new Error("terminal operation left the isolate");
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      try {
        await createTerminalPortFactory(execution)(WORKSPACE_ID, WORKSTREAM_ID).sandbox();
        observed.push("terminal_answered_locally");
      } catch (error) {
        observed.push(error instanceof Error ? error.message : "unknown_terminal_error");
      }
      // Every conversation attaches its own resources, so the refusal a
      // non-main child must give is for an attachment addressed to another
      // conversation of the work stream: here the main child's.
      try {
        await resourceAttacher({
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          substreamId: "0",
          resourceId: "00000000-0000-7000-8000-00000000aa04",
          attachedByUserId: null,
          relationshipType: "generated",
        });
      } catch (error) {
        observed.push(error instanceof Error ? error.message : "unknown_resource_error");
      }
      return observed;
    });

    expect(failures).toEqual([
      "terminal operation left the isolate",
      "workstream_runtime_identity_mismatch",
    ]);
  });

  describe("the operation lease", () => {
    it("admits one run and refuses a second while the holder is still live", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
      });
      await reserve(stub, RUN_A);

      const contender = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 2_000,
      });

      // Null, not an error: a busy workspace is an ordinary outcome the tool
      // layer turns into a retry, not a fault.
      expect(contender.status).toBe(200);
      expect(contender.value).toBeNull();
      const held = await terminal(stub, "sandbox");
      expect((held.value as { operationRunId: string }).operationRunId).toBe(RUN_A);
    });

    it("reclaims a lease whose holder is no longer running", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
      });
      await reserve(stub, RUN_A);

      // The holder settles without releasing — an evicted or cancelled run.
      // Its lease deadline is still in the future, so only the run's own
      // status can say the workspace is free.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE runs SET status = 'failed' WHERE run_id = ?`, RUN_A);
      });

      const reclaimed = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 2_000,
      });
      expect((reclaimed.value as { operationRunId: string }).operationRunId).toBe(RUN_B);
    });

    it("reclaims a lease from a run waiting for human input", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
      });
      await reserve(stub, RUN_A);
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
          1_500,
          RUN_A,
        );
      });

      // A reply never resumes the same execution: it admits a new linked run.
      // The yielded run must therefore not retain Terminal's exclusive lease
      // until the otherwise unrelated sixteen-minute deadline.
      const reclaimed = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 2_000,
      });

      expect((reclaimed.value as { operationRunId: string }).operationRunId).toBe(RUN_B);
    });

    it("keeps a yielded run fenced until provider cleanup settles its retained task", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
        seedEffect(state, EFFECT_A, RUN_A);
      });
      await reserve(stub, RUN_A, { operationLeaseExpiresAt: 1_500 });
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-retained",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await terminal(stub, "insertTask", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-retained",
        providerTaskName: "retained-command",
        commandSha256: "command-hash",
        commandDeadlineAt: 5_000,
        startedAt: 1_000,
        now: 1_000,
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
          1_500,
          RUN_A,
        );
      });

      // Neither the caller's nominal command deadline nor the broader lease
      // expiry proves that Daytona has stopped the retained process.
      const blocked = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 6_000,
      });
      expect(blocked.value).toBeNull();

      const beforeRecovery = await terminal(stub, "sandbox");
      const recoveryClaim = await terminal(stub, "claimYieldedOperationRecovery", {
        runId: RUN_B,
        generation: 1,
        sandboxId: "daytona-retained",
        version: (beforeRecovery.value as { version: number }).version,
        claimId: "recovery-claim",
        claimExpiresAt: 9_000_000,
        now: 6_001,
      });
      expect(recoveryClaim.value).toBe(true);
      const duringCleanup = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 6_001,
      });
      expect(duringCleanup.value).toBeNull();
      const claimedSnapshot = await terminal(stub, "sandbox");
      const duplicateRecovery = await terminal(stub, "claimYieldedOperationRecovery", {
        runId: RUN_B,
        generation: 1,
        sandboxId: "daytona-retained",
        version: (claimedSnapshot.value as { version: number }).version,
        claimId: "duplicate-recovery-claim",
        claimExpiresAt: 9_000_000,
        now: 6_001,
      });
      expect(duplicateRecovery.value).toBe(false);
      const wrongClaim = await terminal(stub, "cancelTaskAfterProviderCleanup", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        providerTaskName: "retained-command",
        claimId: "duplicate-recovery-claim",
        now: 6_002,
      });
      expect(wrongClaim.value).toBe(false);
      const settled = await terminal(stub, "cancelTaskAfterProviderCleanup", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        providerTaskName: "retained-command",
        claimId: "recovery-claim",
        now: 6_002,
      });
      expect(settled.value).toBe(true);

      // A late provider continuation cannot rewrite the task after cleanup.
      await terminal(stub, "settleTask", {
        effectIntentId: EFFECT_A,
        runId: RUN_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-retained",
        state: "completed",
        exitCode: 0,
        terminationReason: "exited",
        stdoutHead: "late",
        stdoutTail: "",
        stderrHead: "",
        stderrTail: "",
        stdoutBytes: 4,
        stderrBytes: 0,
        completedAt: 6_003,
        now: 6_003,
      });
      expect(await terminal(stub, "attachTaskOutputResource", {
        effectIntentId: EFFECT_A,
        runId: RUN_A,
        sandboxGeneration: 1,
        state: "completed",
        completedAt: 6_003,
        outputResourceId: "late-log",
        now: 6_004,
      })).toMatchObject({ value: false });
      const task = await terminal(stub, "taskByEffect", EFFECT_A);
      expect(task.value).toMatchObject({ state: "cancelled", stdoutHead: "" });
      const lateSubmission = await terminal(stub, "markTaskRunning", {
        effectIntentId: EFFECT_A,
        providerTaskId: "late-provider-command",
        commandDeadlineAt: 9_000,
        now: 6_003,
      });
      expect(lateSubmission.value).toBe(false);

      const afterCleanup = await terminal(stub, "settleYieldedOperationRecovery", {
        runId: RUN_B,
        generation: 1,
        sandboxId: "daytona-retained",
        claimId: "recovery-claim",
        leaseExpiresAt: 9_000_000,
        sandboxStopped: false,
        now: 6_004,
      });
      expect((afterCleanup.value as { operationRunId: string }).operationRunId).toBe(RUN_B);
    });

    it("renews exact submission authority and token-fences fresh-generation retirement", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
        seedEffect(state, EFFECT_A, RUN_A);
      });
      await reserve(stub, RUN_A, { operationLeaseExpiresAt: 1_500 });
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-submitting",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await terminal(stub, "setFinalDiffResourceId", "pre-acceptance-retirement-diff", 1_001);
      await terminal(stub, "insertTask", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-submitting",
        providerTaskName: "submitting-command",
        commandSha256: "command-hash",
        commandDeadlineAt: 2_000,
        startedAt: 1_000,
        now: 1_000,
      });
      const renewed = await terminal(stub, "renewTaskSubmissionAuthority", {
        effectIntentId: EFFECT_A,
        runId: RUN_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-submitting",
        commandDeadlineAt: 5_000,
        now: 1_100,
      });
      expect(renewed.value).toBe(true);
      expect(await terminal(stub, "taskByEffect", EFFECT_A)).toMatchObject({
        value: { state: "submitting", commandDeadlineAt: 5_000 },
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
          1_500,
          RUN_A,
        );
      });
      const staleRenewal = await terminal(stub, "renewTaskSubmissionAuthority", {
        effectIntentId: EFFECT_A,
        runId: RUN_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-submitting",
        commandDeadlineAt: 8_000,
        now: 5_001,
      });
      expect(staleRenewal.value).toBe(false);

      const beforeRecovery = await terminal(stub, "sandbox");
      expect(await terminal(stub, "claimYieldedOperationRecovery", {
        runId: RUN_B,
        generation: 1,
        sandboxId: "daytona-submitting",
        version: (beforeRecovery.value as { version: number }).version,
        claimId: "retirement-claim",
        claimExpiresAt: 9_000_000,
        now: 5_001,
      })).toMatchObject({ value: true });
      expect(await terminal(stub, "cancelTaskAfterProviderCleanup", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        providerTaskName: "submitting-command",
        claimId: "retirement-claim",
        now: 5_002,
      })).toMatchObject({ value: true });
      expect(await terminal(stub, "retireYieldedOperationRecovery", {
        runId: RUN_B,
        generation: 1,
        sandboxId: "daytona-submitting",
        claimId: "wrong-claim",
        leaseExpiresAt: 9_000_000,
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 5_003,
      })).toMatchObject({ value: null });
      const retired = await terminal(stub, "retireYieldedOperationRecovery", {
        runId: RUN_B,
        generation: 1,
        sandboxId: "daytona-submitting",
        claimId: "retirement-claim",
        leaseExpiresAt: 9_000_000,
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 5_004,
      });
      expect(retired.value).toMatchObject({
        generation: 2,
        sandboxId: null,
        lifecycleState: "starting",
        operationRunId: RUN_B,
        finalDiffResourceId: null,
      });
    });

    it("token-fences generation retirement after lifecycle proves the sandbox absent", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedEffect(state, EFFECT_A, RUN_A);
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-lifecycle-missing",
        lifecycleState: "archived",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await terminal(stub, "setFinalDiffResourceId", "lifecycle-retirement-diff", 1_001);
      await terminal(stub, "insertTask", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-lifecycle-missing",
        providerTaskName: "missing-sandbox-command",
        commandSha256: "command-hash",
        commandDeadlineAt: 2_000,
        startedAt: 1_000,
        now: 1_000,
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
          2_500,
          RUN_A,
        );
      });
      const beforeClaim = await terminal(stub, "sandbox");
      const claim = await terminal(stub, "claimLifecycleTransition", {
        lifecycleState: "expiring",
        claimId: "missing-sandbox-claim",
        claimExpiresAt: 9_000_000,
        generation: 1,
        version: (beforeClaim.value as { version: number }).version,
        now: 3_000,
      });
      expect(claim.value).toEqual({ sandboxId: "daytona-lifecycle-missing" });
      expect(await terminal(stub, "renewLifecycleClaim", {
        generation: 1,
        sandboxId: "daytona-lifecycle-missing",
        claimId: "wrong-claim",
        claimExpiresAt: 10_000_000,
        now: 3_000,
      })).toMatchObject({ value: false });
      expect(await terminal(stub, "renewLifecycleClaim", {
        generation: 1,
        sandboxId: "daytona-lifecycle-missing",
        claimId: "missing-sandbox-claim",
        claimExpiresAt: 10_000_000,
        now: 3_000,
      })).toMatchObject({ value: true });
      expect(await terminal(stub, "cancelTaskAfterProviderCleanup", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        providerTaskName: "missing-sandbox-command",
        claimId: "missing-sandbox-claim",
        now: 3_001,
      })).toMatchObject({ value: true });
      expect(await terminal(stub, "retireMissingSandboxAfterLifecycleClaim", {
        generation: 1,
        sandboxId: "daytona-lifecycle-missing",
        claimId: "wrong-claim",
        now: 3_002,
      })).toMatchObject({ value: null });
      const retired = await terminal(stub, "retireMissingSandboxAfterLifecycleClaim", {
        generation: 1,
        sandboxId: "daytona-lifecycle-missing",
        claimId: "missing-sandbox-claim",
        now: 3_003,
      });
      expect(retired.value).toMatchObject({
        generation: 2,
        sandboxId: null,
        lifecycleState: "starting",
        operationRunId: RUN_A,
        finalDiffResourceId: null,
      });
    });

    it("does not revive an expired lifecycle cleanup token", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "needs_input");
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-expired-lifecycle-claim",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      const beforeClaim = await terminal(stub, "sandbox");
      expect(await terminal(stub, "claimLifecycleTransition", {
        lifecycleState: "stopping",
        claimId: "expired-lifecycle-claim",
        claimExpiresAt: 4_000,
        generation: 1,
        version: (beforeClaim.value as { version: number }).version,
        now: 3_000,
      })).toMatchObject({ value: { sandboxId: "daytona-expired-lifecycle-claim" } });

      expect(await terminal(stub, "renewLifecycleClaim", {
        generation: 1,
        sandboxId: "daytona-expired-lifecycle-claim",
        claimId: "expired-lifecycle-claim",
        claimExpiresAt: 10_000,
        now: 4_000,
      })).toMatchObject({ value: false });
    });

    it("exposes a failed holder's retained task for provider cleanup", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
        seedEffect(state, EFFECT_A, RUN_A);
      });
      await reserve(stub, RUN_A, { operationLeaseExpiresAt: 1_500 });
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-failed-holder",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await terminal(stub, "insertTask", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-failed-holder",
        providerTaskName: "failed-holder-command",
        commandSha256: "command-hash",
        commandDeadlineAt: 2_000,
        startedAt: 1_000,
        now: 1_000,
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE runs SET status = 'failed' WHERE run_id = ?`, RUN_A);
      });

      const blocked = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 3_000,
      });
      expect(blocked.value).toBeNull();
      const beforeRecovery = await terminal(stub, "sandbox");
      const recovery = await terminal(stub, "claimYieldedOperationRecovery", {
        runId: RUN_B,
        generation: 1,
        sandboxId: "daytona-failed-holder",
        version: (beforeRecovery.value as { version: number }).version,
        claimId: "failed-holder-recovery",
        claimExpiresAt: 9_000_000,
        now: 3_001,
      });
      expect(recovery.value).toBe(true);
    });

    it("treats a waiting run as still holding the workspace", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        // `waiting` and `steering` projected as `running` through the retired
        // compatibility view. Against the real column they are simply not
        // terminal, and the lease has to keep honouring that.
        seedRunRow(state, RUN_A, "waiting");
        seedRunRow(state, RUN_B, "admitted");
      });
      await reserve(stub, RUN_A);

      const contender = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 2_000,
      });
      expect(contender.value).toBeNull();
    });

    it("prevents a stopped holder from admitting a command after lease handoff", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
        seedEffect(state, EFFECT_A, RUN_A);
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-admission-race",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = ?`,
          1_500,
          RUN_A,
        );
      });
      const successor = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 2_000,
      });
      expect(successor.value).toMatchObject({ operationRunId: RUN_B });

      const staleAdmission = await terminal(stub, "insertTask", {
        taskId: TASK_A,
        runId: RUN_A,
        effectIntentId: EFFECT_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-admission-race",
        providerTaskName: "stale-command",
        commandSha256: "command-hash",
        commandDeadlineAt: 5_000,
        startedAt: 1_000,
        now: 2_001,
      });
      expect(staleAdmission.value).toBe(false);
      expect((await terminal(stub, "taskByEffect", EFFECT_A)).value).toBeNull();
    });

    it("does not convert an expired lifecycle transition into operation ownership", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "needs_input");
        seedRunRow(state, RUN_B, "admitted");
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-lifecycle-race",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      const beforeLifecycle = await terminal(stub, "sandbox");
      await terminal(stub, "claimLifecycleTransition", {
        lifecycleState: "stopping",
        claimId: "expired-lifecycle-claim",
        claimExpiresAt: 1_500,
        generation: 1,
        version: (beforeLifecycle.value as { version: number }).version,
        now: 1_100,
      });
      const transitional = await terminal(stub, "sandbox");
      const recovery = await terminal(stub, "claimYieldedOperationRecovery", {
        runId: RUN_B,
        generation: 1,
        sandboxId: "daytona-lifecycle-race",
        version: (transitional.value as { version: number }).version,
        claimId: "operation-recovery",
        claimExpiresAt: 9_000_000,
        now: 2_000,
      });
      expect(recovery.value).toBe(false);
      expect(await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 2_001,
      })).toMatchObject({ value: null });
      expect((await terminal(stub, "sandbox")).value).toMatchObject({
        lifecycleState: "stopping",
        lifecycleClaimId: "expired-lifecycle-claim",
        operationRunId: RUN_A,
      });
    });

    it("reclaims an expired lease even while its holder still runs", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
      });
      await reserve(stub, RUN_A, { operationLeaseExpiresAt: 1_500 });

      const reclaimed = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 2_000,
      });
      expect((reclaimed.value as { operationRunId: string }).operationRunId).toBe(RUN_B);
    });

    it("keeps the lease across an eviction", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedRunRow(state, RUN_B, "admitted");
      });
      await reserve(stub, RUN_A);

      await evictDurableObject(stub);
      await boot(stub);

      const contender = await terminal(stub, "claimOperation", {
        runId: RUN_B,
        generation: 1,
        leaseExpiresAt: 9_000_000,
        now: 2_000,
      });
      expect(contender.value).toBeNull();
    });
  });

  describe("the workspace scheduler's input", () => {
    it("publishes a terminal deadline to the directory when a sandbox starts", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        state.storage.sql.exec(`DELETE FROM durable_outbox`);
      });
      await reserve(stub, RUN_A);

      // `workspace_workstream_directory.next_terminal_action_at` is the only
      // input the workspace's alarm has for Terminal work, and this effect is
      // its only writer. A sandbox holding three durable deadlines that
      // enqueues nothing leaves the sweep with no reason to ever run.
      const published = await terminalCommonEffects(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-1",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_500,
      });

      expect(published.length).toBeGreaterThan(0);
      expect(published.at(-1)).toBe(new Date(2_000_000).toISOString());
    });

    it("clears the published deadline when the sandbox expires", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-1",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_500,
      });
      const before = (await terminal(stub, "sandbox")).value as { version: number };
      await terminal(stub, "claimLifecycleTransition", {
        lifecycleState: "expiring",
        claimId: "claim-expire",
        claimExpiresAt: 9_000_000,
        generation: 1,
        version: before.version,
        now: 2_000,
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`DELETE FROM durable_outbox`);
      });

      // Nothing sweeps this column, so a settle that publishes no effect
      // leaves a past timestamp in the directory forever and the scheduler
      // keeps re-arming its alarm on it.
      const published = await terminalCommonEffects(stub, "settleLifecycleTransition", {
        lifecycleState: "expired",
        claimId: "claim-expire",
        now: 3_000,
      });

      expect(published.length).toBeGreaterThan(0);
      expect(published.at(-1)).toBeNull();
    });
  });

  describe("the table's own invariants", () => {
    it("refuses a lease with no deadline to expire it", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
      });
      await reserve(stub, RUN_A);

      // A run id with no lease deadline is unreleasable: nothing can decide it
      // has expired, so the workspace stays held forever. This was
      // unexpressible while the pair lived in a JSON blob.
      await runInDurableObject(stub, (_instance, state) => {
        expect(() => state.storage.sql.exec(
          `UPDATE terminal_workspace SET operation_lease_expires_at = NULL WHERE id = 1`,
        )).toThrow();
      });
    });

    it("refuses a request routed to the wrong work stream", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

      const misrouted = await post(stub, "/internal/terminal", {
        workspaceId: WORKSPACE_ID,
        workstreamId: "00000000-0000-7000-8000-0000000000ff",
        operation: "sandbox",
        args: [],
      });
      expect(misrouted.status).toBe(409);
      expect((misrouted.body as { error: string }).error)
        .toBe("workstream_terminal_identity_mismatch");
    });

    it("refuses an operation name that is not on the contract", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

      const unknown = await post(stub, "/internal/terminal", {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        operation: "dropEverything",
        args: [],
      });
      expect(unknown.status).toBe(400);
    });
  });

  describe("generation replacement", () => {
    it("discards the retired generation's import provenance in the same transaction", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "recordImportedResource", {
        sandboxGeneration: 1,
        resourceId: "00000000-0000-7000-8000-0000000000e1",
        destinationPath: ".rally/resources/one",
        sourceSha256: "a".repeat(64),
        sizeBytes: 10,
        state: "completed",
        importedAt: 1_000,
        now: 1_000,
      });
      expect((await terminal(stub, "importedResources", 1)).value).toHaveLength(1);

      const replaced = await terminal(stub, "replaceGeneration", {
        generation: 1,
        authorityFingerprint: "authority-two",
        networkRevision: 1,
        runId: RUN_A,
        operationLeaseExpiresAt: 9_000_000,
        idleExpiresAt: 9_000_000,
        archiveDueAt: 9_000_000,
        expireDueAt: 9_000_000,
        now: 5_000,
      });

      expect(replaced.value).toMatchObject({
        generation: 2,
        sandboxId: null,
        lifecycleState: "starting",
        authorityFingerprint: "authority-two",
      });
      // Provenance from the discarded sandbox must not survive: the next
      // authority check would otherwise pass on evidence for files that are
      // gone.
      expect((await terminal(stub, "importedResources", 1)).value).toHaveLength(0);
      expect((await terminal(stub, "importedResources", 2)).value).toHaveLength(0);
    });
  });

  describe("the lifecycle claim", () => {
    it("lets exactly one of two concurrent claims win on the version fence", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-1",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_500,
      });
      const version = (await terminal(stub, "sandbox")).value as { version: number };

      // Both read the same version — a scheduler alarm racing a live tool.
      const [first, second] = await Promise.all([
        terminal(stub, "claimLifecycleTransition", {
          lifecycleState: "stopping",
          claimId: "claim-one",
          claimExpiresAt: 9_000_000,
          generation: 1,
          version: version.version,
          now: 2_000,
        }),
        terminal(stub, "claimLifecycleTransition", {
          lifecycleState: "stopping",
          claimId: "claim-two",
          claimExpiresAt: 9_000_000,
          generation: 1,
          version: version.version,
          now: 2_000,
        }),
      ]);

      const winners = [first.value, second.value].filter((value) => value !== null);
      expect(winners).toHaveLength(1);
    });

    it("clears every deadline and the provider sandbox when expiry settles", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-1",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_500,
      });
      const before = (await terminal(stub, "sandbox")).value as { version: number };
      await terminal(stub, "claimLifecycleTransition", {
        lifecycleState: "expiring",
        claimId: "claim-expire",
        claimExpiresAt: 9_000_000,
        generation: 1,
        version: before.version,
        now: 2_000,
      });

      expect(await terminal(stub, "settleLifecycleTransition", {
        lifecycleState: "expired",
        claimId: "claim-expire",
        now: 3_000,
      })).toMatchObject({ value: true });

      // Past expiry there is nothing left to stop, archive, or reattach to, so
      // every deadline and the provider id go together.
      expect((await terminal(stub, "sandbox")).value).toMatchObject({
        lifecycleState: "expired",
        sandboxId: null,
        idleExpiresAt: null,
        archiveDueAt: null,
        expireDueAt: null,
        operationRunId: null,
        operationLeaseExpiresAt: null,
        lifecycleClaimId: null,
      });
    });

    it("refuses final expiry while its generation still has an unsettled task", async () => {
      const stub = agent();
      const effect = "00000000-0000-7000-8000-0000000000f6";
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedEffect(state, effect, RUN_A);
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-expiry-task",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await terminal(stub, "insertTask", {
        taskId: "00000000-0000-7000-8000-0000000000a6",
        runId: RUN_A,
        effectIntentId: effect,
        sandboxGeneration: 1,
        sandboxId: "daytona-expiry-task",
        providerTaskName: "avalon-expiry-task",
        commandSha256: "c".repeat(64),
        commandDeadlineAt: 2_000,
        startedAt: 1_500,
        now: 1_500,
      });
      const before = (await terminal(stub, "sandbox")).value as { version: number };
      await terminal(stub, "claimLifecycleTransition", {
        lifecycleState: "expiring",
        claimId: "claim-expiry-task",
        claimExpiresAt: 9_000_000,
        generation: 1,
        version: before.version,
        now: 3_000,
      });

      expect(await terminal(stub, "settleLifecycleTransition", {
        lifecycleState: "expired",
        claimId: "claim-expiry-task",
        now: 3_001,
      })).toMatchObject({ value: false });
      expect((await terminal(stub, "sandbox")).value).toMatchObject({
        lifecycleState: "expiring",
        sandboxId: "daytona-expiry-task",
        lifecycleClaimId: "claim-expiry-task",
      });

      expect(await terminal(stub, "cancelTaskAfterProviderCleanup", {
        taskId: "00000000-0000-7000-8000-0000000000a6",
        runId: RUN_A,
        effectIntentId: effect,
        sandboxGeneration: 1,
        providerTaskName: "avalon-expiry-task",
        claimId: "claim-expiry-task",
        now: 3_002,
      })).toMatchObject({ value: true });
      expect(await terminal(stub, "settleLifecycleTransition", {
        lifecycleState: "expired",
        claimId: "claim-expiry-task",
        now: 3_003,
      })).toMatchObject({ value: true });
      expect((await terminal(stub, "sandbox")).value).toMatchObject({
        lifecycleState: "expired",
        sandboxId: null,
        lifecycleClaimId: null,
      });
    });
  });

  describe("sequences that used to span two statements", () => {
    it("drops the sandbox and its repository bootstrap together", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "replaceRepository", {
        generation: 1,
        connectionId: "00000000-0000-7000-8000-0000000000c1",
        repositoryId: 42,
        repositoryFullName: "owner/repo",
        baseRef: "main",
        baseSha: "b".repeat(40),
        headRef: "avalon/work",
        remoteAccess: "full_access",
        selectedByUserId: "00000000-0000-7000-8000-0000000000u1",
        now: 1_000,
      });
      // The replace consumed the sandbox it was fenced on; the bootstrap
      // belongs to the generation reserved after it.
      await reserve(stub, RUN_A);
      await terminal(stub, "recordRepositoryBootstrap", {
        generation: 1,
        readTokenExpiresAt: 5_000_000,
        repositoryFullName: "owner/repo",
        baseSha: "b".repeat(40),
        now: 1_200,
      });

      const reset = await terminal(stub, "resetSandbox", { generation: 1, now: 6_000 });

      expect(reset.value).toEqual({ deleted: true });
      expect((await terminal(stub, "sandbox")).value).toBeNull();
      // A repository still marked bootstrapped into a sandbox that no longer
      // exists is exactly the state the next bootstrap check reads to decide
      // it can skip its work.
      expect((await terminal(stub, "repository")).value).toMatchObject({
        state: "selected",
        bootstrappedSandboxGeneration: null,
        readTokenExpiresAt: null,
      });
    });

    it("keeps a live generation's import provenance when a stale reset misses", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "replaceGeneration", {
        generation: 1,
        authorityFingerprint: "authority-two",
        networkRevision: 1,
        runId: RUN_A,
        operationLeaseExpiresAt: 9_000_000,
        idleExpiresAt: 9_000_000,
        archiveDueAt: 9_000_000,
        expireDueAt: 9_000_000,
        now: 5_000,
      });
      await terminal(stub, "recordImportedResource", {
        sandboxGeneration: 2,
        resourceId: "00000000-0000-7000-8000-0000000000e2",
        destinationPath: ".rally/resources/two",
        sourceSha256: "b".repeat(64),
        sizeBytes: 20,
        state: "completed",
        importedAt: 6_000,
        now: 6_000,
      });

      // `startFresh` reads a generation, then awaits the provider's delete
      // before resetting. Another run can replace the generation in that
      // window, so the reset arrives naming one that is no longer current.
      const stale = await terminal(stub, "resetSandbox", { generation: 1, now: 7_000 });

      expect(stale.value).toEqual({ deleted: false });
      // The live generation keeps its provenance. Losing it would read as
      // "nothing was imported" to the next authority check, which is how a
      // revoked resource would go unnoticed and its files be reused.
      expect((await terminal(stub, "importedResources", 2)).value).toHaveLength(1);
      expect((await terminal(stub, "sandbox")).value).toMatchObject({ generation: 2 });
    });

    it("fences the repository replacement on the generation it read", async () => {
      const stub = agent();
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
      });
      await reserve(stub, RUN_A);

      const stale = await terminal(stub, "replaceRepository", {
        generation: 7,
        connectionId: "00000000-0000-7000-8000-0000000000c1",
        repositoryId: 42,
        repositoryFullName: "owner/repo",
        baseRef: "main",
        baseSha: "b".repeat(40),
        headRef: "avalon/work",
        remoteAccess: "full_access",
        selectedByUserId: "00000000-0000-7000-8000-0000000000u1",
        now: 2_000,
      });

      expect(stale.value).toBe(false);
      // Nothing partial: the sandbox is intact and no repository was written.
      expect((await terminal(stub, "sandbox")).value).toMatchObject({ generation: 1 });
      expect((await terminal(stub, "repository")).value).toBeNull();
    });
  });

  describe("command tasks", () => {
    it("keeps one task per effect across an eviction and a replayed submission", async () => {
      const stub = agent();
      const effect = "00000000-0000-7000-8000-0000000000f1";
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedEffect(state, effect, RUN_A);
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-command-tasks",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await terminal(stub, "insertTask", {
        taskId: "00000000-0000-7000-8000-0000000000t1",
        runId: RUN_A,
        effectIntentId: effect,
        sandboxGeneration: 1,
        sandboxId: "daytona-command-tasks",
        providerTaskName: "avalon-task-one",
        commandSha256: "c".repeat(64),
        commandDeadlineAt: 9_000_000,
        startedAt: 1_500,
        now: 1_500,
      });

      await evictDurableObject(stub);
      await boot(stub);
      // The Worker was interrupted and re-enters the same receipt with a new
      // task id. The unique effect intent is what makes that a no-op.
      await terminal(stub, "insertTask", {
        taskId: "00000000-0000-7000-8000-0000000000t2",
        runId: RUN_A,
        effectIntentId: effect,
        sandboxGeneration: 1,
        sandboxId: "daytona-command-tasks",
        providerTaskName: "avalon-task-one",
        commandSha256: "c".repeat(64),
        commandDeadlineAt: 9_000_000,
        startedAt: 7_000,
        now: 7_000,
      });

      expect((await terminal(stub, "taskByEffect", effect)).value).toMatchObject({
        taskId: "00000000-0000-7000-8000-0000000000t1",
        startedAt: 1_500,
      });
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM terminal_tasks`,
        ).one().count).toBe(1);
      });
    });

    it("defers a lifecycle sweep while a command is inside its deadline", async () => {
      const stub = agent();
      const effect = "00000000-0000-7000-8000-0000000000f2";
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedEffect(state, effect, RUN_A);
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-live-task",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await terminal(stub, "insertTask", {
        taskId: "00000000-0000-7000-8000-0000000000t3",
        runId: RUN_A,
        effectIntentId: effect,
        sandboxGeneration: 1,
        sandboxId: "daytona-live-task",
        providerTaskName: "avalon-task-two",
        commandSha256: "c".repeat(64),
        commandDeadlineAt: 9_000_000,
        startedAt: 1_500,
        now: 1_500,
      });

      expect((await terminal(stub, "hasLiveTask", 1, 5_000)).value).toBe(true);
      // Past the command's own deadline the sweep is free to proceed even
      // though the row is still `running`; that is what stops a lost command
      // from pinning the workspace.
      expect((await terminal(stub, "hasLiveTask", 1, 9_000_001)).value).toBe(false);
    });

    it("does not settle a command while lifecycle owns provider authority", async () => {
      const stub = agent();
      const effect = "00000000-0000-7000-8000-0000000000f5";
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedEffect(state, effect, RUN_A);
      });
      await reserve(stub, RUN_A);
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-lifecycle-result",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_000,
      });
      await terminal(stub, "insertTask", {
        taskId: "00000000-0000-7000-8000-0000000000a5",
        runId: RUN_A,
        effectIntentId: effect,
        sandboxGeneration: 1,
        sandboxId: "daytona-lifecycle-result",
        providerTaskName: "avalon-task-lifecycle-result",
        commandSha256: "c".repeat(64),
        commandDeadlineAt: 2_000,
        startedAt: 1_500,
        now: 1_500,
      });
      const beforeClaim = await terminal(stub, "sandbox");
      await terminal(stub, "claimLifecycleTransition", {
        lifecycleState: "stopping",
        claimId: "lifecycle-result-claim",
        claimExpiresAt: 9_000_000,
        generation: 1,
        version: (beforeClaim.value as { version: number }).version,
        now: 3_000,
      });

      expect(await terminal(stub, "settleTask", {
        effectIntentId: effect,
        runId: RUN_A,
        sandboxGeneration: 1,
        sandboxId: "daytona-lifecycle-result",
        state: "completed",
        exitCode: 0,
        terminationReason: "exited",
        stdoutHead: "late",
        stdoutTail: "",
        stderrHead: "",
        stderrTail: "",
        stdoutBytes: 4,
        stderrBytes: 0,
        completedAt: 3_001,
        now: 3_001,
      })).toMatchObject({ value: false });
      expect((await terminal(stub, "taskByEffect", effect)).value)
        .toMatchObject({ state: "submitting", stdoutHead: "" });
    });
  });

  describe("publication grants", () => {
    it("consumes a grant once and keeps the first consumer's identity", async () => {
      const stub = agent();
      const part = "00000000-0000-7000-8000-0000000000p1";
      const effectOne = "00000000-0000-7000-8000-0000000000f3";
      const effectTwo = "00000000-0000-7000-8000-0000000000f4";
      await boot(stub);
      await runInDurableObject(stub, async (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        await seedParticipantMessage(state, {
          id: part,
          sequence: 1,
          text: "hi",
          authorUserId: "00000000-0000-7000-8000-0000000000u1",
          now: 1,
        });
        seedEffect(state, effectOne, RUN_A, 0);
        seedEffect(state, effectTwo, RUN_A, 1);
      });
      await terminal(stub, "admitPublicationGrant", {
        grantId: "00000000-0000-7000-8000-0000000000g1",
        runId: RUN_A,
        sourcePartId: part,
        principalKey: "user:one",
        repositoryFullName: "owner/repo",
        baseRef: "main",
        headRef: "avalon/work",
        expiresAt: 9_000_000,
        now: 1_000,
      });
      // A replayed admission must not mint a second grant for the same source.
      await terminal(stub, "admitPublicationGrant", {
        grantId: "00000000-0000-7000-8000-0000000000g2",
        runId: RUN_A,
        sourcePartId: part,
        principalKey: "user:one",
        repositoryFullName: "owner/repo",
        baseRef: "main",
        headRef: "avalon/work",
        expiresAt: 9_000_000,
        now: 1_100,
      });
      const grant = (await terminal(stub, "latestPublicationGrant", {
        runId: RUN_A,
        repositoryFullName: "owner/repo",
      })).value as { grantId: string };
      expect(grant.grantId).toBe("00000000-0000-7000-8000-0000000000g1");

      await terminal(stub, "consumePublicationGrant", {
        grantId: grant.grantId,
        effectIntentId: effectOne,
        now: 2_000,
      });
      await terminal(stub, "consumePublicationGrant", {
        grantId: grant.grantId,
        effectIntentId: effectTwo,
        now: 3_000,
      });

      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{
          consumed_by_effect_intent_id: string;
          consumed_at: number;
          count: number;
        }>(
          `SELECT consumed_by_effect_intent_id, consumed_at,
                  (SELECT COUNT(*) FROM terminal_publication_grants) AS count
             FROM terminal_publication_grants`,
        ).one()).toEqual({
          consumed_by_effect_intent_id: effectOne,
          consumed_at: 2_000,
          count: 1,
        });
      });
    });

    it("refuses a publication receipt whose grant does not exist", async () => {
      const stub = agent();
      const effect = "00000000-0000-7000-8000-0000000000f5";
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedEffect(state, effect, RUN_A);
      });

      // The storage boundary rejects an orphan even while a schema migration
      // has temporarily disabled SQLite foreign-key enforcement.
      const orphan = await terminal(stub, "beginPublication", {
        publicationId: "00000000-0000-7000-8000-0000000000b1",
        effectIntentId: effect,
        grantId: "00000000-0000-7000-8000-0000000000g9",
        repositoryFullName: "owner/repo",
        baseRef: "main",
        headRef: "avalon/work",
        expectedOldSha: null,
        requestedCommitSha: "d".repeat(40),
        title: "Ship",
        body: "",
        now: 1_000,
      });
      expect(orphan.status).toBe(409);
    });
  });
});
