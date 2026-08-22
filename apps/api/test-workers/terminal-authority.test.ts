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
import { beforeAll, describe, expect, it } from "vitest";

import { asSubstreamId } from "@avalon/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import { rpcResultBody } from "../src/durable-objects/rpc-result";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeAll(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
});

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    substreamAgentName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`),
    ),
  ));
}

const RUN_A = "00000000-0000-7000-8000-00000000ra01";
const RUN_B = "00000000-0000-7000-8000-00000000rb02";

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

function seedPart(state: DurableObjectState, partId: string, sequence: number): void {
  state.storage.sql.exec(
    `INSERT INTO parts (
       id, substream_id, sequence_number, role, kind, author_type, author_user_id,
       visibility, pinned, message_type, content, created_at, updated_at
     ) VALUES (?, '0', ?, 'user', 'text', 'member', ?, 'both', 0, 'text', 'hi', 1, 1)`,
    partId,
    sequence,
    "00000000-0000-7000-8000-0000000000u1",
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

describe("Terminal authority on real workerd", () => {
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

  it("returns a committed tool receipt when runtime-SQL alarm scheduling fails afterward", async () => {
    const stub = agent();
    await boot(stub);
    const effectId = "00000000-0000-7000-8000-00000000ae01";
    const result = await runInDurableObject(stub, async (instance, state) => {
      seedWorkstreamRoot(state);
      seedRunRow(state, RUN_A, "running");
      seedEffect(state, effectId, RUN_A);
      Object.defineProperty(instance, "scheduleNextAlarm", {
        configurable: true,
        value: async () => { throw new Error("injected_runtime_alarm_failure"); },
      });
      try {
        return await (instance as unknown as {
          executeRuntimeSql(input: Record<string, unknown>): Promise<{
            status: number;
            bodyJson: string;
          }>;
        }).executeRuntimeSql({
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          requestId: "00000000-0000-7000-8000-00000000ae02",
          statements: [{
            sql: "UPDATE tool_invocations SET status = ?, started_at = ? WHERE id = ?",
            params: ["started", "2026-08-21T22:00:00.000Z", effectId],
          }, {
            // This legacy statement rewrites directly to the normalized table,
            // not a compatibility view, so its native count must remain live.
            sql: `UPDATE workstreams SET next_sequence_number = next_sequence_number + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ?
              RETURNING next_sequence_number - 1 AS sequence_number`,
            params: ["2026-08-21T22:00:00.000Z", WORKSTREAM_ID, WORKSPACE_ID],
          }],
        });
      } finally {
        delete (instance as unknown as Record<string, unknown>).scheduleNextAlarm;
      }
    });

    expect(result.status).toBe(200);
    expect(rpcResultBody(result)).toMatchObject({
      results: [
        { changes: 1 },
        { changes: 1, rows: [{ sequence_number: expect.any(Number) }] },
      ],
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        `SELECT status FROM tool_effects WHERE effect_intent_id = ?`,
        effectId,
      ).one().status).toBe("executing");
    });
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
      await terminal(stub, "attachProviderSandbox", {
        generation: 1,
        sandboxId: "daytona-1",
        lifecycleState: "running",
        idleExpiresAt: 2_000_000,
        archiveDueAt: 3_000_000,
        expireDueAt: 4_000_000,
        now: 1_500,
      });

      // `workspace_workstream_directory.next_terminal_action_at` is the only
      // input `WorkspaceScheduler` has for Terminal work, and this effect is
      // its only writer. A sandbox holding three durable deadlines that
      // enqueues nothing leaves the sweep with no reason to ever run.
      await runInDurableObject(stub, (_instance, state) => {
        const effects = state.storage.sql.exec<{ payload_json: string | null }>(
          `SELECT payload_json FROM durable_outbox
            WHERE channel = 'regional_effect_v1' AND partition_key = 'common'`,
        ).toArray();
        expect(effects.length).toBeGreaterThan(0);
        const published = effects
          .map((row) => JSON.parse(row.payload_json ?? "{}") as {
            effect?: { nextTerminalActionAt?: string | null };
          })
          .map((body) => body.effect?.nextTerminalActionAt)
          .filter((value) => value !== undefined);
        expect(published.at(-1)).toBe(new Date(2_000_000).toISOString());
      });
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

      await terminal(stub, "settleLifecycleTransition", {
        lifecycleState: "expired",
        claimId: "claim-expire",
        now: 3_000,
      });

      // Nothing sweeps this column, so a settle that publishes no effect
      // leaves a past timestamp in the directory forever and the scheduler
      // keeps re-arming its alarm on it.
      await runInDurableObject(stub, (_instance, state) => {
        const published = state.storage.sql.exec<{ payload_json: string | null }>(
          `SELECT payload_json FROM durable_outbox
            WHERE channel = 'regional_effect_v1' AND partition_key = 'common'`,
        ).toArray()
          .map((row) => JSON.parse(row.payload_json ?? "{}") as {
            effect?: { nextTerminalActionAt?: string | null };
          })
          .map((body) => body.effect?.nextTerminalActionAt)
          .filter((value) => value !== undefined);
        expect(published.length).toBeGreaterThan(0);
        expect(published.at(-1)).toBeNull();
      });
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
        destinationPath: ".avalon/resources/one",
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

      await terminal(stub, "settleLifecycleTransition", {
        lifecycleState: "expired",
        claimId: "claim-expire",
        now: 3_000,
      });

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
        destinationPath: ".avalon/resources/two",
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
      await terminal(stub, "insertTask", {
        taskId: "00000000-0000-7000-8000-0000000000t1",
        runId: RUN_A,
        effectIntentId: effect,
        sandboxGeneration: 1,
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
      await terminal(stub, "insertTask", {
        taskId: "00000000-0000-7000-8000-0000000000t3",
        runId: RUN_A,
        effectIntentId: effect,
        sandboxGeneration: 1,
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
  });

  describe("publication grants", () => {
    it("consumes a grant once and keeps the first consumer's identity", async () => {
      const stub = agent();
      const part = "00000000-0000-7000-8000-0000000000p1";
      const effectOne = "00000000-0000-7000-8000-0000000000f3";
      const effectTwo = "00000000-0000-7000-8000-0000000000f4";
      await boot(stub);
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        seedRunRow(state, RUN_A, "running");
        seedPart(state, part, 1);
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

      // workerd enforces the foreign key, so a receipt can never point at a
      // grant that was never admitted.
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
