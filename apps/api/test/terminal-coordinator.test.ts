import { asUserId } from "@avalon/contracts";
import type { HarnessToolContext } from "@avalon/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TerminalSandboxCoordinator,
  type TerminalClock,
} from "../src/services/terminal/coordinator";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  seedToolReceipt,
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
  testWorkstreamRuntimeD1,
  workstreamObjectGet,
  workstreamObjectRun,
  testTerminalPortFactory,
} from "./helpers/durable-authority";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = asUserId("00000000-0000-4000-8000-000000000004");

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture() {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${USER_ID}', 'terminal-user', 'terminal@example.com', 'Terminal User', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Terminal', 'terminal', 'global', '${USER_ID}', '2026-08-13', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Terminal', 'Terminal', 'ad_hoc', '${USER_ID}',
            'idle', '2026-08-13', '2026-08-13', '2026-08-13');
  `);
  // Runs and sandbox rows live in the work stream's own object since
  // migration 0090 dropped the D1 copies.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: WORKSTREAM_ID, workspaceId: WORKSPACE_ID });
  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES (?, ?, ?, 'test', ?, 'running', '2026-08-13')`,
    RUN_ID, WORKSPACE_ID, WORKSTREAM_ID, JSON.stringify({ type: "user", userId: USER_ID }),
  );
  let now = new Date("2026-08-13T12:00:00.000Z");
  const clock: TerminalClock = { now: () => new Date(now) };
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(async (input) => ({
      id: `sandbox-${input.generation}`,
      name: input.stableName,
      state: "running" as const,
      domainAllowList: input.domainAllowList,
    })),
    getSandbox: vi.fn(async (name) => ({
      id: "sandbox-recovered",
      name,
      state: "running" as const,
      domainAllowList: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
    })),
    startSandbox: vi.fn(async () => undefined),
    stopSandbox: vi.fn(async () => undefined),
    archiveSandbox: vi.fn(async () => undefined),
    deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(async () => undefined),
    configureGitHubReadAccess: vi.fn(async () => undefined),
    clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    cleanupCommand: vi.fn(async () => undefined),
    publishGitBundle: vi.fn(async (input) => ({ publishedSha: input.headSha })),
  };
  return {
    database,
    objectStore,
    db: testWorkstreamRuntimeD1(sqliteD1(database), objectStore, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    }),
    provider,
    clock,
    advance(minutes: number) { now = new Date(now.getTime() + minutes * 60_000); },
  };
}

function context(userId = USER_ID): HarnessToolContext {
  return {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: RUN_ID,
    toolCallId: "call-1",
    executionPrincipal: { type: "user", userId },
    signal: new AbortController().signal,
  };
}

describe("Terminal sandbox coordinator", () => {
  it("creates lazily on first tool use and reuses one sandbox per work stream", async () => {
    const { objectStore, db,  provider, clock } = fixture();
    const acquisitionObserved = vi.fn(async () => undefined);
    const coordinator = new TerminalSandboxCoordinator(db, testTerminalPortFactory(objectStore), provider,
      clock,
      undefined,
      false,
      acquisitionObserved,
    );

    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_workspace")).toEqual({ count: 0 });
    const first = await coordinator.acquire(context());
    const second = await coordinator.acquire({ ...context(), toolCallId: "call-2" });

    expect(first).toMatchObject({ providerSandboxId: "sandbox-1", generation: 1, state: "running" });
    expect(second).toEqual(first);
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(provider.startSandbox).not.toHaveBeenCalled();
    expect(acquisitionObserved).toHaveBeenCalledOnce();
    expect(acquisitionObserved).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ action: "start" }));
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM terminal_workspace")).toEqual({ count: 1 });
  });

  it("recovers an ambiguous create by the stable provider name", async () => {
    const { db, objectStore, provider, clock } = fixture();
    vi.mocked(provider.createSandbox).mockRejectedValueOnce(new Error("provider timeout"));
    provider.prepareSandbox = vi.fn(async (id: string, expectedDomainAllowList: string[]) => ({
      id,
      name: id,
      state: "running" as const,
      domainAllowList: expectedDomainAllowList,
    }));
    const coordinator = new TerminalSandboxCoordinator(db, testTerminalPortFactory(objectStore), provider, clock);

    await expect(coordinator.acquire(context())).resolves.toMatchObject({
      providerSandboxId: "sandbox-recovered",
      state: "running",
    });
    expect(provider.getSandbox).toHaveBeenCalledOnce();
    expect(provider.prepareSandbox).toHaveBeenCalledWith(
      "sandbox-recovered",
      compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
    );
  });

  it("fails closed when a new sandbox does not report the requested trusted policy", async () => {
    const { objectStore, db,  provider, clock } = fixture();
    vi.mocked(provider.createSandbox).mockImplementationOnce(async (input) => ({
      id: "sandbox-policy-mismatch",
      name: input.stableName,
      state: "running",
      domainAllowList: [],
    }));
    const coordinator = new TerminalSandboxCoordinator(db, testTerminalPortFactory(objectStore), provider, clock);

    await expect(coordinator.acquire(context())).rejects.toMatchObject({
      code: "network_policy_unverified",
    });
    expect(provider.deleteSandbox).toHaveBeenCalledWith("sandbox-policy-mismatch");
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, failure_code FROM terminal_workspace WHERE id = 1",
    )).toEqual({
      lifecycle_state: "failed",
      failure_code: "provider_policy_mismatch",
    });
  });

  it("destroys and reprovisions before reuse when execution authority changes", async () => {
    const { database, db, objectStore, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(db, testTerminalPortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('other-user', 'other-terminal-user', 'other@example.com', 'Other', '2026-08-13', '2026-08-13');
    `);

    await expect(coordinator.acquire(context(asUserId("00000000-0000-4000-8000-000000000005")))).resolves.toMatchObject({
      providerSandboxId: "sandbox-2",
      generation: 2,
    });
    expect(provider.deleteSandbox).toHaveBeenCalledWith("sandbox-1");
    expect(provider.createSandbox).toHaveBeenCalledTimes(2);
  });

  it("starts stopped sandboxes and refreshes lifecycle deadlines without polling", async () => {
    const { objectStore, db, provider, clock, advance } = fixture();
    const coordinator = new TerminalSandboxCoordinator(db, testTerminalPortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET lifecycle_state = 'stopped' WHERE id = 1",
    );
    advance(10);

    const acquired = await coordinator.acquire(context());
    expect(provider.startSandbox).toHaveBeenCalledWith("sandbox-1");
    expect(acquired).toMatchObject({ state: "running" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT idle_expires_at, archive_due_at, expire_due_at FROM terminal_workspace WHERE id = 1",
    )).toEqual({
      idle_expires_at: Date.parse("2026-08-13T12:15:00.000Z"),
      archive_due_at: Date.parse("2026-08-13T13:10:00.000Z"),
      expire_due_at: Date.parse("2026-09-12T12:10:00.000Z"),
    });
  });

  it("serializes mutating runs with the durable operation lease", async () => {
    const { objectStore, db,  provider, clock } = fixture();
    const otherRun = "00000000-0000-4000-8000-000000000099";
    // Scheduled, not running: the object admits at most one mutating run per
    // substream (`runs_mutating_substream_uq`), so the contender waits in the
    // admitted state while the fixture run holds the lease.
    workstreamObjectRun(
      objectStore,
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
       VALUES (?, ?, ?, 'test', ?, 'scheduled', '2026-08-13')`,
      otherRun, WORKSPACE_ID, WORKSTREAM_ID, `{"type":"user","userId":"${USER_ID}"}`,
    );
    const coordinator = new TerminalSandboxCoordinator(db, testTerminalPortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());

    await expect(coordinator.acquire({ ...context(), harnessRunId: otherRun, toolCallId: "other-call" }))
      .rejects.toMatchObject({
        code: "sandbox_busy",
        details: {
          retryAfterMs: 5_000,
          reason: "Wait for the current agent run to release the Terminal workspace, then retry.",
        },
      });
    expect(provider.createSandbox).toHaveBeenCalledOnce();

    workstreamObjectRun(objectStore, "UPDATE harness_runs SET status = 'completed' WHERE id = ?", RUN_ID);
    await expect(coordinator.acquire({ ...context(), harnessRunId: otherRun, toolCallId: "other-call" }))
      .resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
  });

  it("continues yielded-task cleanup in bounded batches", async () => {
    const { objectStore, db, provider, clock } = fixture();
    const otherRun = "00000000-0000-4000-8000-000000000099";
    const coordinator = new TerminalSandboxCoordinator(
      db,
      testTerminalPortFactory(objectStore),
      provider,
      clock,
    );
    await coordinator.acquire(context());
    workstreamObjectRun(
      objectStore,
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
       VALUES (?, ?, ?, 'test', ?, 'scheduled', '2026-08-13')`,
      otherRun, WORKSPACE_ID, WORKSTREAM_ID, `{"type":"user","userId":"${USER_ID}"}`,
    );
    workstreamObjectRun(objectStore, "UPDATE harness_runs SET status = 'failed' WHERE id = ?", RUN_ID);
    for (let index = 0; index < 21; index += 1) {
      const invocationId = `batch-invocation-${index}`;
      seedToolReceipt(objectStore, {
        id: invocationId,
        runId: RUN_ID,
        toolCallId: `batch-call-${index}`,
        toolName: "terminal_run_command",
        position: index,
      });
      workstreamObjectRun(
        objectStore,
        `INSERT INTO terminal_tasks
          (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name,
           state, command_sha256, command_deadline_at, stdout_head, stdout_tail,
           stderr_head, stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, 'running', 'hash', ?, '', '', '', '', 0, 0, ?, ?)`,
        `batch-task-${index}`,
        RUN_ID,
        invocationId,
        `batch-provider-task-${index}`,
        Date.parse("2026-08-13T11:59:00.000Z"),
        Date.parse("2026-08-13T11:58:00.000Z"),
        Date.parse("2026-08-13T11:58:00.000Z"),
      );
    }
    const contender = { ...context(), harnessRunId: otherRun, toolCallId: "batch-contender" };

    await expect(coordinator.acquire(contender)).rejects.toMatchObject({ code: "sandbox_busy" });
    expect(provider.cleanupCommand).toHaveBeenCalledTimes(20);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM terminal_tasks WHERE state = 'running'",
    )).toEqual({ count: 1 });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_claim_id, operation_run_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_claim_id: null, operation_run_id: RUN_ID });

    await expect(coordinator.acquire(contender)).resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
    expect(provider.cleanupCommand).toHaveBeenCalledTimes(21);
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM terminal_tasks WHERE state = 'running'",
    )).toEqual({ count: 0 });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT operation_run_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ operation_run_id: otherRun });
  });

  it("does not stop a successor after a degraded cleanup batch loses its renewed token", async () => {
    const { objectStore, db, provider, clock, advance } = fixture();
    const linkedRun = "00000000-0000-4000-8000-000000000098";
    const successorRun = "00000000-0000-4000-8000-000000000099";
    const effectId = "renew-race-effect";
    const baseFactory = testTerminalPortFactory(objectStore);
    let renewCalls = 0;
    let renewPaused!: () => void;
    let releaseRenew!: () => void;
    const pausedRenew = new Promise<void>((resolve) => { renewPaused = resolve; });
    const renewRelease = new Promise<void>((resolve) => { releaseRenew = resolve; });
    const interceptingFactory = ((workspaceId: string, workstreamId: string) => {
      const port = baseFactory(workspaceId, workstreamId);
      return {
        ...port,
        renewLifecycleClaim: async (...args: Parameters<typeof port.renewLifecycleClaim>) => {
          renewCalls += 1;
          if (renewCalls === 2) {
            renewPaused();
            await renewRelease;
          }
          return port.renewLifecycleClaim(...args);
        },
      };
    }) satisfies typeof baseFactory;
    const coordinator = new TerminalSandboxCoordinator(db, interceptingFactory, provider, clock);
    await coordinator.acquire(context());
    seedToolReceipt(objectStore, {
      id: effectId,
      runId: RUN_ID,
      toolCallId: "renew-race-call",
      toolName: "terminal_run_command",
    });
    const terminal = baseFactory(WORKSPACE_ID, WORKSTREAM_ID);
    await expect(terminal.insertTask({
      taskId: "renew-race-task",
      runId: RUN_ID,
      effectIntentId: effectId,
      sandboxGeneration: 1,
      sandboxId: "sandbox-1",
      providerTaskName: "renew-race-provider-task",
      commandSha256: "renew-race-hash",
      commandDeadlineAt: clock.now().getTime() + 60_000,
      startedAt: clock.now().getTime(),
      now: clock.now().getTime(),
    })).resolves.toBe(true);
    await expect(terminal.markTaskRunning({
      effectIntentId: effectId,
      providerTaskId: "renew-race-command",
      now: clock.now().getTime(),
    })).resolves.toBe(true);
    workstreamObjectRun(
      objectStore,
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
       VALUES (?, ?, ?, 'test', ?, 'scheduled', '2026-08-13'),
              (?, ?, ?, 'test', ?, 'scheduled', '2026-08-13')`,
      linkedRun, WORKSPACE_ID, WORKSTREAM_ID, `{"type":"user","userId":"${USER_ID}"}`,
      successorRun, WORKSPACE_ID, WORKSTREAM_ID, `{"type":"user","userId":"${USER_ID}"}`,
    );
    workstreamObjectRun(objectStore, "UPDATE harness_runs SET status = 'failed' WHERE id = ?", RUN_ID);

    let rejectCleanup!: () => void;
    vi.mocked(provider.cleanupCommand!).mockImplementationOnce(async () => (
      new Promise<void>((_resolve, reject) => {
        rejectCleanup = () => reject(new Error("cleanup degraded"));
      })
    ));
    const staleAcquire = coordinator.acquire({
      ...context(),
      harnessRunId: linkedRun,
      toolCallId: "renew-race-linked",
    });
    await vi.waitFor(() => expect(provider.cleanupCommand).toHaveBeenCalledOnce());
    advance(4);
    rejectCleanup();
    await pausedRenew;

    const claimed = await terminal.sandbox();
    await expect(terminal.claimYieldedOperationRecovery({
      runId: successorRun,
      generation: 1,
      sandboxId: "sandbox-1",
      version: claimed!.version,
      claimId: "successor-cleanup-claim",
      claimExpiresAt: clock.now().getTime() + 3 * 60_000,
      now: clock.now().getTime(),
    })).resolves.toBe(true);
    await expect(terminal.cancelTaskAfterProviderCleanup({
      taskId: "renew-race-task",
      runId: RUN_ID,
      effectIntentId: effectId,
      sandboxGeneration: 1,
      providerTaskName: "renew-race-provider-task",
      claimId: "successor-cleanup-claim",
      now: clock.now().getTime(),
    })).resolves.toBe(true);
    await expect(terminal.settleYieldedOperationRecovery({
      runId: successorRun,
      generation: 1,
      sandboxId: "sandbox-1",
      claimId: "successor-cleanup-claim",
      leaseExpiresAt: clock.now().getTime() + 16 * 60_000,
      sandboxStopped: false,
      now: clock.now().getTime(),
    })).resolves.toMatchObject({ operationRunId: successorRun });

    releaseRenew();
    await expect(staleAcquire).rejects.toMatchObject({ code: "sandbox_busy" });
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    await expect(coordinator.acquire({
      ...context(),
      harnessRunId: successorRun,
      toolCallId: "renew-race-successor",
    })).resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
  });
});
