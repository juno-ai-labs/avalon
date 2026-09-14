import { asUserId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TerminalSandboxCoordinator,
  type TerminalClock,
} from "../src/services/terminal/coordinator";
import { TERMINAL_OPERATION_LEASE_MS } from "../src/durable-objects/workstream-terminal-storage";
import type {
  TerminalSandboxProvider,
  TerminalSandboxState,
} from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";
import type { DatabaseSync } from "node:sqlite";
import {
  seedToolReceipt,
  seedWorkstreamRun,
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
  testResourcePortFactory,
  testTerminalPortFactory,
} from "./helpers/durable-authority";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = asUserId("00000000-0000-4000-8000-000000000004");

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
const objectDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
  for (const database of objectDatabases.splice(0)) database.close();
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
  seedWorkstreamRun(objectStore, {
    id: RUN_ID,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
    createdAt: Date.parse("2026-08-13"),
  });
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
    runUtilityCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    cleanupCommand: vi.fn(async () => undefined),
  };
  return {
    database,
    objectStore,
    env: createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      APP_ENV: "test",
      // The network policy is decided by a real WorkspaceDO over its own
      // schema; the coordinator asks it rather than issuing SQL at a router.
      WORKSPACE_DOS: testWorkspaceObjectBinding(createTestWorkspaceDO({
        workspaceId: WORKSPACE_ID,
        regionalDatabase: database,
        register: (created) => { objectDatabases.push(created); },
      }).instance, ["terminalNetworkSettings"]),
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

/**
 * What the provider reports for one sandbox.
 *
 * Acquisition reads the provider's state back rather than trusting the row, so
 * a test about a stopped or archived workspace has to say so on both sides; a
 * fixture that always answers "running" would prove the read-back never
 * happened.
 */
function observeProviderState(
  provider: TerminalSandboxProvider,
  id: string,
  state: TerminalSandboxState,
): void {
  vi.mocked(provider.getSandbox).mockImplementation(async (requested) => ({
    id,
    name: requested,
    state,
    domainAllowList: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
  }));
}

describe("Terminal sandbox coordinator", () => {
  it("creates lazily on first tool use and reuses one sandbox per work stream", async () => {
    const { objectStore, env,  provider, clock } = fixture();
    const acquisitionObserved = vi.fn(async () => undefined);
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider,
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
    const { env, objectStore, provider, clock } = fixture();
    vi.mocked(provider.createSandbox).mockRejectedValueOnce(new Error("provider timeout"));
    provider.prepareSandbox = vi.fn(async (id: string, expectedDomainAllowList: string[]) => ({
      id,
      name: id,
      state: "running" as const,
      domainAllowList: expectedDomainAllowList,
    }));
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);

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
    const { objectStore, env,  provider, clock } = fixture();
    vi.mocked(provider.createSandbox).mockImplementationOnce(async (input) => ({
      id: "sandbox-policy-mismatch",
      name: input.stableName,
      state: "running",
      domainAllowList: [],
    }));
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);

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
    const { database, env, objectStore, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
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
    const { objectStore, env, provider, clock, advance } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET lifecycle_state = 'stopped' WHERE id = 1",
    );
    observeProviderState(provider, "sandbox-1", "stopped");
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

  it("starts a sandbox Daytona archived while the row still claimed it was running", async () => {
    const { objectStore, env, provider, clock, advance } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    // Daytona auto-stops at fifteen minutes and auto-archives an hour later on
    // its own schedule. Rally's transition never ran, so the row still says
    // running over a sandbox whose runner archiving released.
    observeProviderState(provider, "sandbox-1", "archived");
    advance(90);

    const acquired = await coordinator.acquire(context());

    expect(provider.startSandbox).toHaveBeenCalledWith("sandbox-1");
    expect(acquired).toMatchObject({ providerSandboxId: "sandbox-1", state: "running" });
    expect(provider.createSandbox).toHaveBeenCalledOnce();
  });

  it("replaces a sandbox the provider no longer has instead of failing every later run", async () => {
    const { objectStore, env, provider, clock, advance } = fixture();
    const acquisitionObserved = vi.fn(async () => undefined);
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider,
      clock,
      undefined,
      false,
      acquisitionObserved,
    );
    await coordinator.acquire(context());
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET lifecycle_state = 'archived' WHERE id = 1",
    );
    const missing = new Error("Sandbox with ID sandbox-1 does not have a runner") as Error & { status: number };
    missing.status = 404;
    vi.mocked(provider.getSandbox).mockRejectedValue(missing);
    advance(70);

    const acquired = await coordinator.acquire(context());

    expect(acquired).toMatchObject({ providerSandboxId: "sandbox-2", generation: 2, state: "running" });
    expect(provider.createSandbox).toHaveBeenCalledTimes(2);
    expect(acquisitionObserved).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: "start_fresh", localFilesRetained: false }),
    );
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, sandbox_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "running", sandbox_id: "sandbox-2" });
  });

  it("waits out a sandbox mid-transition instead of discarding its files", async () => {
    const { objectStore, env, provider, clock, advance } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    // Daytona stops and archives on its own schedule, and the provider reports
    // the states it does not recognize as `unknown`. Neither is a verdict.
    for (const transitional of ["starting", "unknown"] as const) {
      observeProviderState(provider, "sandbox-1", transitional);
      advance(20);

      await expect(coordinator.acquire(context()), transitional)
        .rejects.toMatchObject({ code: "sandbox_unavailable" });
    }
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT sandbox_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ sandbox_id: "sandbox-1" });
  });

  it("replaces a lost sandbox before running the provider mutations its row would order", async () => {
    const { objectStore, env, provider, clock, advance } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    // A stale policy revision makes acquisition stop and reconfigure the
    // sandbox before it would ever reach the recovery. Driving that from the
    // row is how a work stream whose sandbox Daytona had lost threw a raw
    // provider error one branch early, and repeated it on every later run.
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET applied_network_revision = 0 WHERE id = 1",
    );
    const missing = new Error("Sandbox with ID sandbox-1 not found") as Error & { status: number };
    missing.status = 404;
    for (const call of [provider.getSandbox, provider.stopSandbox, provider.updateNetworkPolicy, provider.deleteSandbox]) {
      vi.mocked(call).mockRejectedValue(missing);
    }
    advance(20);

    await expect(coordinator.acquire(context()))
      .resolves.toMatchObject({ providerSandboxId: "sandbox-2", generation: 2, state: "running" });
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(provider.updateNetworkPolicy).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledTimes(2);
  });

  it("keeps a sandbox the provider still holds when one start attempt fails", async () => {
    const { objectStore, env, provider, clock, advance } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET lifecycle_state = 'archived' WHERE id = 1",
    );
    // A restore that outran the start call's own deadline is still on its way.
    observeProviderState(provider, "sandbox-1", "archived");
    vi.mocked(provider.startSandbox).mockRejectedValue(new Error("timed out"));
    advance(70);

    await expect(coordinator.acquire(context())).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT sandbox_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ sandbox_id: "sandbox-1" });
  });

  it("serializes mutating runs with the durable operation lease", async () => {
    const { objectStore, env,  provider, clock } = fixture();
    const otherRun = "00000000-0000-4000-8000-000000000099";
    // Scheduled, not running: the object admits at most one mutating run per
    // substream (`runs_mutating_substream_uq`), so the contender waits in the
    // admitted state while the fixture run holds the lease.
    seedWorkstreamRun(objectStore, { id: otherRun, status: "admitted",
      executionPrincipalJson: `{"type":"user","userId":"${USER_ID}"}` });
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
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

    workstreamObjectRun(objectStore, "UPDATE runs SET status = 'completed' WHERE run_id = ?", RUN_ID);
    await expect(coordinator.acquire({ ...context(), harnessRunId: otherRun, toolCallId: "other-call" }))
      .resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
  });

  it("settles every retained task before handing the lease to a linked run", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const otherRun = "00000000-0000-4000-8000-000000000099";
    const coordinator = new TerminalSandboxCoordinator(
      env,
      testTerminalPortFactory(objectStore),
      testResourcePortFactory(objectStore),
      provider,
      clock,
    );
    await coordinator.acquire(context());
    seedWorkstreamRun(objectStore, { id: otherRun, status: "admitted",
      executionPrincipalJson: `{"type":"user","userId":"${USER_ID}"}` });
    workstreamObjectRun(objectStore, "UPDATE runs SET status = 'failed' WHERE run_id = ?", RUN_ID);
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

    await expect(coordinator.acquire(contender)).resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(provider.cleanupCommand).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM terminal_tasks WHERE state = 'running'",
    )).toEqual({ count: 0 });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT operation_run_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ operation_run_id: otherRun });
  });

  it("retires a planned task before linked handoff", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const linkedRun = "00000000-0000-4000-8000-000000000099";
    const effectId = "planned-recovery-effect";
    const coordinator = new TerminalSandboxCoordinator(
      env,
      testTerminalPortFactory(objectStore),
      testResourcePortFactory(objectStore),
      provider,
      clock,
    );
    await coordinator.acquire(context());
    seedWorkstreamRun(objectStore, { id: linkedRun, status: "admitted",
      executionPrincipalJson: `{"type":"user","userId":"${USER_ID}"}` });
    seedToolReceipt(objectStore, {
      id: effectId,
      runId: RUN_ID,
      toolCallId: "planned-recovery-call",
      toolName: "terminal_run_command",
    });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_tasks
        (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name,
         state, command_sha256, command_deadline_at, stdout_head, stdout_tail,
         stderr_head, stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
       VALUES ('planned-recovery-task', ?, ?, 1, 'planned-recovery-provider', 'planned',
               'planned-hash', ?, '', '', '', '', 0, 0, ?, ?)`,
      RUN_ID,
      effectId,
      clock.now().getTime() - 1,
      clock.now().getTime() - 2,
      clock.now().getTime() - 2,
    );
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET final_diff_resource_id = 'planned-old-final-diff' WHERE id = 1",
    );
    workstreamObjectRun(objectStore, "UPDATE runs SET status = 'failed' WHERE run_id = ?", RUN_ID);

    await expect(coordinator.acquire({
      ...context(),
      harnessRunId: linkedRun,
      toolCallId: "planned-recovery-linked",
    })).resolves.toMatchObject({ providerSandboxId: "sandbox-2", generation: 2 });
    expect(provider.deleteSandbox).toHaveBeenCalledWith("sandbox-1");
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE task_id = 'planned-recovery-task'",
    )).toEqual({ state: "cancelled" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT generation, final_diff_resource_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ generation: 2, final_diff_resource_id: null });
  });

  it("retires a mixed generation before a later submitting task can overlap handoff", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const linkedRun = "00000000-0000-4000-8000-000000000099";
    const runningEffect = "mixed-running-effect";
    const submittingEffect = "mixed-submitting-effect";
    const terminal = testTerminalPortFactory(objectStore)(WORKSPACE_ID, WORKSTREAM_ID);
    const coordinator = new TerminalSandboxCoordinator(
      env,
      testTerminalPortFactory(objectStore),
      testResourcePortFactory(objectStore),
      provider,
      clock,
    );
    await coordinator.acquire(context());
    seedWorkstreamRun(objectStore, { id: linkedRun, status: "admitted",
      executionPrincipalJson: `{"type":"user","userId":"${USER_ID}"}` });
    for (const [effectId, callId, position] of [
      [runningEffect, "mixed-running-call", 0],
      [submittingEffect, "mixed-submitting-call", 1],
    ] as const) {
      seedToolReceipt(objectStore, {
        id: effectId,
        runId: RUN_ID,
        toolCallId: callId,
        toolName: "terminal_run_command",
        position,
      });
    }
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_tasks
        (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name,
         state, command_sha256, command_deadline_at, stdout_head, stdout_tail,
         stderr_head, stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
       VALUES ('a-running-task', ?, ?, 1, 'mixed-running-provider', 'running',
               'running-hash', ?, '', '', '', '', 0, 0, ?, ?),
              ('z-submitting-task', ?, ?, 1, 'mixed-submitting-provider', 'submitting',
               'submitting-hash', ?, '', '', '', '', 0, 0, ?, ?)`,
      RUN_ID,
      runningEffect,
      clock.now().getTime() - 1,
      clock.now().getTime() - 2,
      clock.now().getTime() - 2,
      RUN_ID,
      submittingEffect,
      clock.now().getTime() - 1,
      clock.now().getTime() - 2,
      clock.now().getTime() - 2,
    );
    workstreamObjectRun(objectStore, "UPDATE runs SET status = 'failed' WHERE run_id = ?", RUN_ID);
    let finishDelete!: () => void;
    vi.mocked(provider.deleteSandbox).mockImplementationOnce(async () => (
      new Promise<void>((resolve) => { finishDelete = resolve; })
    ));

    const acquired = coordinator.acquire({
      ...context(),
      harnessRunId: linkedRun,
      toolCallId: "mixed-linked-call",
    });
    await vi.waitFor(() => expect(provider.deleteSandbox).toHaveBeenCalledWith("sandbox-1"));
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    await expect(terminal.markTaskRunning({
      effectIntentId: submittingEffect,
      providerTaskId: "mixed-late-provider-command",
      commandDeadlineAt: clock.now().getTime() + 60_000,
      now: clock.now().getTime(),
    })).resolves.toBe(true);

    finishDelete();
    await expect(acquired).resolves.toMatchObject({ providerSandboxId: "sandbox-2", generation: 2 });
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      `SELECT COUNT(*) AS count FROM terminal_tasks
        WHERE state IN ('planned', 'submitting', 'running')`,
    )).toEqual({ count: 0 });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT generation, operation_run_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ generation: 2, operation_run_id: linkedRun });
  });

  it("releases a transient recovery claim without publishing a stale failure", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const linkedRun = "00000000-0000-4000-8000-000000000099";
    const effectId = "transient-recovery-effect";
    const terminal = testTerminalPortFactory(objectStore)(WORKSPACE_ID, WORKSTREAM_ID);
    const coordinator = new TerminalSandboxCoordinator(
      env,
      testTerminalPortFactory(objectStore),
      testResourcePortFactory(objectStore),
      provider,
      clock,
    );
    await coordinator.acquire(context());
    seedToolReceipt(objectStore, {
      id: effectId,
      runId: RUN_ID,
      toolCallId: "transient-recovery-call",
      toolName: "terminal_run_command",
    });
    await expect(terminal.insertTask({
      taskId: "transient-recovery-task",
      runId: RUN_ID,
      effectIntentId: effectId,
      sandboxGeneration: 1,
      sandboxId: "sandbox-1",
      providerTaskName: "transient-recovery-provider-task",
      commandSha256: "transient-recovery-hash",
      commandDeadlineAt: clock.now().getTime() + 60_000,
      startedAt: clock.now().getTime(),
      now: clock.now().getTime(),
    })).resolves.toBe(true);
    await expect(terminal.markTaskRunning({
      effectIntentId: effectId,
      providerTaskId: "transient-recovery-provider-command",
      commandDeadlineAt: clock.now().getTime() + 60_000,
      now: clock.now().getTime(),
    })).resolves.toBe(true);
    seedWorkstreamRun(objectStore, { id: linkedRun, status: "admitted",
      executionPrincipalJson: `{"type":"user","userId":"${USER_ID}"}` });
    workstreamObjectRun(objectStore, "UPDATE runs SET status = 'failed' WHERE run_id = ?", RUN_ID);
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(new Error("stop unavailable"));
    const linked = { ...context(), harnessRunId: linkedRun, toolCallId: "transient-recovery-linked" };

    await expect(coordinator.acquire(linked)).rejects.toMatchObject({ code: "sandbox_busy" });
    await expect(terminal.sandbox()).resolves.toMatchObject({
      lifecycleState: "running",
      failureCode: null,
      lifecycleClaimId: null,
      operationRunId: RUN_ID,
    });

    await expect(coordinator.acquire(linked)).resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
    await expect(terminal.sandbox()).resolves.toMatchObject({
      lifecycleState: "running",
      failureCode: null,
      operationRunId: linkedRun,
    });
  });

  it("does not stop a successor after recovery renewal loses its exact token", async () => {
    const { objectStore, env, provider, clock, advance } = fixture();
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
          if (renewCalls === 1) {
            renewPaused();
            await renewRelease;
          }
          return port.renewLifecycleClaim(...args);
        },
      };
    }) satisfies typeof baseFactory;
    const coordinator = new TerminalSandboxCoordinator(
      env,
      interceptingFactory,
      testResourcePortFactory(objectStore),
      provider,
      clock,
    );
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
      commandDeadlineAt: clock.now().getTime() + 60_000,
      now: clock.now().getTime(),
    })).resolves.toBe(true);
    seedWorkstreamRun(objectStore, { id: linkedRun, status: "admitted",
      executionPrincipalJson: `{"type":"user","userId":"${USER_ID}"}` });
    seedWorkstreamRun(objectStore, { id: successorRun, status: "admitted",
      executionPrincipalJson: `{"type":"user","userId":"${USER_ID}"}` });
    workstreamObjectRun(objectStore, "UPDATE runs SET status = 'failed' WHERE run_id = ?", RUN_ID);

    const staleAcquire = coordinator.acquire({
      ...context(),
      harnessRunId: linkedRun,
      toolCallId: "renew-race-linked",
    });
    await pausedRenew;
    advance(17);

    const claimed = await terminal.sandbox();
    await expect(terminal.claimYieldedOperationRecovery({
      runId: successorRun,
      generation: 1,
      sandboxId: "sandbox-1",
      version: claimed!.version,
      claimId: "successor-cleanup-claim",
      claimExpiresAt: clock.now().getTime() + TERMINAL_OPERATION_LEASE_MS,
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
