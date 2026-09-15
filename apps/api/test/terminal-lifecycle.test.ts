import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { reconcileDueTerminalSandbox } from "../src/services/terminal/lifecycle";
import { preRetirementProductSqliteDatabase } from "./helpers/sqlite-d1";
import {
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testHarnessRunPortFactory,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
  testTerminalPortFactory,
  seedToolReceipt,
} from "./helpers/durable-authority";

const W = "40000000-0000-4000-8000-000000000001";
const S = "40000000-0000-4000-8000-000000000002";
const U = "40000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-13T12:00:00.000Z");

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture(state: "running" | "stopped" | "archived", deadlines: { warm: string; archive: string; expire: string }) {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'lifecycle-user', 'lifecycle@example.com', 'Lifecycle', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Lifecycle', 'terminal-lifecycle', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Lifecycle', 'Lifecycle', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
  `);
  // The sandbox row and everything the lifecycle touches live in the work
  // stream's own object since migration 0090 dropped the D1 copies.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  workstreamObjectRun(
    objectStore,
    `INSERT INTO terminal_workspace
      (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
       authority_fingerprint, applied_network_revision, version, last_command_at,
       idle_expires_at, archive_due_at, expire_due_at, created_at, updated_at)
    VALUES (1, 'daytona', ?, 'sandbox-lifecycle', 'provider-1', 1,
            'authority', 1, 1, ?, ?, ?, ?, ?, ?)`,
    state,
    Date.parse("2026-08-13T10:00:00.000Z"),
    Date.parse(deadlines.warm),
    Date.parse(deadlines.archive),
    Date.parse(deadlines.expire),
    Date.parse("2026-08-13T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
  );
  let providerState = state;
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(async () => ({ id: "provider-1", name: "sandbox-lifecycle", state: providerState, domainAllowList: [] })),
    recoverSandbox: vi.fn(async () => undefined),
    startSandbox: vi.fn(async () => { providerState = "running"; }), stopSandbox: vi.fn(async () => { providerState = "stopped"; }), archiveSandbox: vi.fn(async () => { providerState = "archived"; }), deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(), configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(), writeFile: vi.fn(), runUtilityCommand: vi.fn(), runCommand: vi.fn(),
    cleanupCommand: vi.fn(async () => undefined),
  };
  return {
    database,
    objectStore,
    provider,
  };
}

describe("Terminal scheduled lifecycle", () => {
  it("stops one idle running sandbox exactly once after the warm deadline", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "stopped" });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "none" });
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, idle_expires_at FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "stopped", idle_expires_at: null });
  });

  it("reconciles an active holder after its operation lease expires", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z",
      archive: "2026-08-13T13:00:00.000Z",
      expire: "2026-09-12T12:00:00.000Z",
    });
    seedWorkstreamRun(objectStore, { id: "run-expired-active",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    workstreamObjectRun(
      objectStore,
      `UPDATE terminal_workspace
          SET operation_run_id = 'run-expired-active', operation_lease_expires_at = ?
        WHERE id = 1`,
      NOW.getTime() - 1,
    );

    await expect(reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      testTerminalPortFactory(objectStore),
      provider,
      W,
      S,
      NOW,
    )).resolves.toEqual({ transition: "stopped" });
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
  });

  it("does not let an expired lifecycle continuation stop after a replacement scheduler settles", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    const baseFactory = testTerminalPortFactory(objectStore);
    let renewalReached!: () => void;
    let releaseRenewal!: () => void;
    const renewalStarted = new Promise<void>((resolve) => { renewalReached = resolve; });
    const renewalRelease = new Promise<void>((resolve) => { releaseRenewal = resolve; });
    let firstRenewal = true;
    const staleFactory = ((workspaceId: string, workstreamId: string) => {
      const port = baseFactory(workspaceId, workstreamId);
      return {
        ...port,
        renewLifecycleClaim: async (...args: Parameters<typeof port.renewLifecycleClaim>) => {
          if (firstRenewal) {
            firstRenewal = false;
            renewalReached();
            await renewalRelease;
          }
          return port.renewLifecycleClaim(...args);
        },
      };
    }) satisfies typeof baseFactory;

    const staleReconcile = reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      staleFactory,
      provider,
      W,
      S,
      NOW,
    );
    await renewalStarted;

    const replacementNow = new Date(NOW.getTime() + 17 * 60_000);
    await expect(reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      baseFactory,
      provider,
      W,
      S,
      replacementNow,
    )).resolves.toEqual({ transition: "stopped" });
    expect(provider.stopSandbox).toHaveBeenCalledOnce();

    releaseRenewal();
    await expect(staleReconcile).rejects.toThrow("terminal_lifecycle_claim_lost");
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, lifecycle_claim_id, failure_code FROM terminal_workspace WHERE id = 1",
    )).toEqual({
      lifecycle_state: "stopped",
      lifecycle_claim_id: null,
      failure_code: null,
    });
  });

  it("adopts Daytona archival without toolbox calls or losing the sandbox identity", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    vi.mocked(provider.getSandbox).mockResolvedValue({ id: "provider-1", name: "sandbox-lifecycle", state: "archived", domainAllowList: [] });
    const preserve = vi.fn(async () => { throw Object.assign(new Error("does not have a runner"), { status: 404 }); });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW, preserve))
      .resolves.toEqual({ transition: "archived" });
    expect(preserve).not.toHaveBeenCalled();
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "archived", sandbox_id: "provider-1" });
  });

  it("reconciles a runner 404 against metadata instead of retiring the retained archive", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    const preserve = vi.fn(async () => {
      vi.mocked(provider.getSandbox).mockResolvedValue({ id: "provider-1", name: "sandbox-lifecycle", state: "archived", domainAllowList: [] });
      throw Object.assign(new Error("does not have a runner"), { status: 404 });
    });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW, preserve))
      .resolves.toEqual({ transition: "archived" });
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "archived", sandbox_id: "provider-1" });
  });

  it.each(["starting", "stopped"] as const)("waits for accepted archival while metadata reports %s", async (state) => {
    const { objectStore, provider } = fixture("stopped", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:59:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    vi.mocked(provider.archiveSandbox).mockImplementation(async () => {
      vi.mocked(provider.getSandbox).mockResolvedValue({ id: "provider-1", name: "sandbox-lifecycle", state, domainAllowList: [] });
    });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW))
      .resolves.toEqual({ transition: "deferred" });
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, sandbox_id, archive_due_at, failure_code FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "stopped", sandbox_id: "provider-1", archive_due_at: Date.parse("2026-08-13T11:59:00.000Z"), failure_code: null });
    vi.mocked(provider.getSandbox).mockResolvedValue({ id: "provider-1", name: "sandbox-lifecycle", state: "archived", domainAllowList: [] });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, new Date(NOW.getTime() + 60_000)))
      .resolves.toEqual({ transition: "archived" });
    expect(provider.archiveSandbox).toHaveBeenCalledOnce();
  });

  it("recovers a failed sandbox before preserving files and expiring it", async () => {
    const { objectStore, provider } = fixture("stopped", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:30:00.000Z", expire: "2026-08-13T11:59:00.000Z",
    });
    let recovered = false;
    vi.mocked(provider.getSandbox).mockResolvedValue({ id: "provider-1", name: "sandbox-lifecycle", state: "failed", recoverable: true, domainAllowList: [] });
    vi.mocked(provider.recoverSandbox).mockImplementation(async () => { recovered = true; });
    const preserve = vi.fn(async () => { if (!recovered) throw new Error("no runner before recovery"); });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW, preserve))
      .resolves.toEqual({ transition: "expired" });
    expect(preserve).toHaveBeenCalledWith("provider-1", 1);
    expect(provider.recoverSandbox).toHaveBeenCalledWith("provider-1");
    expect(provider.deleteSandbox).toHaveBeenCalledWith("provider-1");
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "expired", sandbox_id: null });
  });

  it("archives stopped state and expires archived state without polling", async () => {
    const stopped = fixture("stopped", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:59:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(stopped.objectStore), testTerminalPortFactory(stopped.objectStore), stopped.provider, W, S, NOW)).resolves.toEqual({ transition: "archived" });
    expect(stopped.provider.archiveSandbox).toHaveBeenCalledWith("provider-1");

    const archived = fixture("archived", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:30:00.000Z", expire: "2026-08-13T11:59:00.000Z",
    });
    const preserveFinalDiff = vi.fn(async () => undefined);
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(archived.objectStore), testTerminalPortFactory(archived.objectStore), archived.provider, W, S, NOW, preserveFinalDiff)).resolves.toEqual({ transition: "expired" });
    expect(preserveFinalDiff).not.toHaveBeenCalled();
    expect(archived.provider.clearGitHubReadAccess).toHaveBeenCalledWith("provider-1");
    expect(archived.provider.deleteSandbox).toHaveBeenCalledWith("provider-1");
    expect(workstreamObjectGet(archived.objectStore, "SELECT lifecycle_state, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "expired", sandbox_id: null });
  });

  it("defers a yielded run's lifecycle until its retained command deadline", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    seedWorkstreamRun(objectStore, { id: "run-lifecycle",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    workstreamObjectRun(
      objectStore,
      `UPDATE runs SET status = 'needs_input', terminalized_at = ? WHERE run_id = 'run-lifecycle'`,
      NOW.getTime(),
    );
    workstreamObjectRun(
      objectStore,
      `UPDATE terminal_workspace
          SET operation_run_id = 'run-lifecycle', operation_lease_expires_at = ?
        WHERE id = 1`,
      Date.parse("2026-08-13T12:16:00.000Z"),
    );
    seedToolReceipt(objectStore, {
      id: "invocation-lifecycle", runId: "run-lifecycle", toolCallId: "call",
      toolName: "terminal_run_command",
    });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_tasks
        (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name, state,
         command_sha256, command_deadline_at, stdout_head, stdout_tail, stderr_head,
         stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
      VALUES ('task-lifecycle', 'run-lifecycle', 'invocation-lifecycle', 1,
              'task', 'running', 'hash', ?, '', '', '', '', 0, 0, ?, ?)`,
      Date.parse("2026-08-13T12:10:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
    );
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "deferred" });
    expect(provider.stopSandbox).not.toHaveBeenCalled();

    await expect(reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      testTerminalPortFactory(objectStore),
      provider,
      W,
      S,
      new Date("2026-08-13T12:10:00.001Z"),
    )).resolves.toEqual({ transition: "stopped" });
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(provider.cleanupCommand).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state, termination_reason FROM terminal_tasks WHERE task_id = 'task-lifecycle'",
    )).toEqual({ state: "cancelled", termination_reason: "cancelled" });
  });

  it.each(["planned", "submitting"] as const)(
    "retires an unconfirmed %s sandbox without waiting for a linked run",
    async (taskState) => {
      const { objectStore, provider } = fixture("running", {
        warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
      });
      seedWorkstreamRun(objectStore, { id: "run-submitting-lifecycle", status: "needs_input",
        executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
      workstreamObjectRun(
        objectStore,
        `UPDATE terminal_workspace
          SET operation_run_id = 'run-submitting-lifecycle', operation_lease_expires_at = ?,
              final_diff_resource_id = 'pre-acceptance-old-final-diff'
        WHERE id = 1`,
        Date.parse("2026-08-13T12:16:00.000Z"),
      );
      seedToolReceipt(objectStore, {
        id: "invocation-submitting-lifecycle",
        runId: "run-submitting-lifecycle",
        toolCallId: "call",
        toolName: "terminal_run_command",
      });
      workstreamObjectRun(
        objectStore,
        `INSERT INTO terminal_tasks
        (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name, state,
         command_sha256, command_deadline_at, stdout_head, stdout_tail, stderr_head,
         stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
      VALUES ('task-submitting-lifecycle', 'run-submitting-lifecycle',
              'invocation-submitting-lifecycle', 1, 'task-submitting', ?,
              'hash', ?, '', '', '', '', 0, 0, ?, ?)`,
        taskState,
        Date.parse("2026-08-13T11:59:00.000Z"),
        Date.parse("2026-08-13T11:00:00.000Z"),
        Date.parse("2026-08-13T11:00:00.000Z"),
      );
      await expect(reconcileDueTerminalSandbox(
        testHarnessRunPortFactory(objectStore),
        testTerminalPortFactory(objectStore),
        provider,
        W,
        S,
        NOW,
      )).resolves.toEqual({ transition: "deferred" });
      expect(provider.deleteSandbox).toHaveBeenCalledWith("provider-1");
      expect(provider.stopSandbox).not.toHaveBeenCalled();
      expect(workstreamObjectGet(
        objectStore,
        "SELECT state FROM terminal_tasks WHERE task_id = 'task-submitting-lifecycle'",
      )).toEqual({ state: "cancelled" });
      expect(workstreamObjectGet(
        objectStore,
        `SELECT generation, sandbox_id, lifecycle_state, final_diff_resource_id, failure_code
           FROM terminal_workspace WHERE id = 1`,
      )).toEqual({
        generation: 2,
        sandbox_id: null,
        lifecycle_state: "starting",
        final_diff_resource_id: null,
        failure_code: null,
      });
      await expect(reconcileDueTerminalSandbox(
        testHarnessRunPortFactory(objectStore),
        testTerminalPortFactory(objectStore),
        provider,
        W,
        S,
        NOW,
      )).resolves.toEqual({ transition: "none" });
      expect(provider.deleteSandbox).toHaveBeenCalledOnce();
    },
  );

  it("cancels retained tasks before expiry after a lost delete response", async () => {
    const { objectStore, provider } = fixture("archived", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:30:00.000Z", expire: "2026-08-13T11:59:00.000Z",
    });
    seedWorkstreamRun(objectStore, { id: "run-missing-sandbox", status: "needs_input",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    seedWorkstreamRun(objectStore, { id: "run-after-missing-sandbox", status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    workstreamObjectRun(
      objectStore,
      `UPDATE terminal_workspace
          SET operation_run_id = 'run-missing-sandbox', operation_lease_expires_at = ?,
              final_diff_resource_id = 'final-diff'
        WHERE id = 1`,
      Date.parse("2026-08-13T12:16:00.000Z"),
    );
    seedToolReceipt(objectStore, {
      id: "invocation-missing-sandbox",
      runId: "run-missing-sandbox",
      toolCallId: "call",
      toolName: "terminal_run_command",
    });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_tasks
        (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name, state,
         command_sha256, command_deadline_at, stdout_head, stdout_tail, stderr_head,
         stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
      VALUES ('task-missing-sandbox', 'run-missing-sandbox', 'invocation-missing-sandbox',
              1, 'task-missing', 'submitting', 'hash', ?, '', '', '', '', 0, 0, ?, ?)`,
      Date.parse("2026-08-13T11:59:00.000Z"),
      Date.parse("2026-08-13T11:00:00.000Z"),
      Date.parse("2026-08-13T11:00:00.000Z"),
    );
    vi.mocked(provider.deleteSandbox).mockRejectedValueOnce(
      new Error("delete response lost"),
    );
    vi.mocked(provider.getSandbox).mockRejectedValueOnce(
      Object.assign(new Error("sandbox missing"), { statusCode: 404 }),
    );

    await expect(reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      testTerminalPortFactory(objectStore),
      provider,
      W,
      S,
      NOW,
    )).resolves.toEqual({ transition: "expired" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE task_id = 'task-missing-sandbox'",
    )).toEqual({ state: "cancelled" });
    expect(workstreamObjectGet(
      objectStore,
      `SELECT generation, sandbox_id, lifecycle_state, final_diff_resource_id
         FROM terminal_workspace WHERE id = 1`,
    )).toEqual({
      generation: 1,
      sandbox_id: null,
      lifecycle_state: "expired",
      final_diff_resource_id: "final-diff",
    });
  });

  it("does not settle expiry when cancellation fails after provider absence", async () => {
    const { objectStore, provider } = fixture("archived", {
      warm: "2026-08-13T11:00:00.000Z",
      archive: "2026-08-13T11:30:00.000Z",
      expire: "2026-08-13T11:59:00.000Z",
    });
    seedWorkstreamRun(objectStore, { id: "run-cancel-failure", status: "needs_input",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    workstreamObjectRun(
      objectStore,
      `UPDATE terminal_workspace
          SET operation_run_id = 'run-cancel-failure', operation_lease_expires_at = ?
        WHERE id = 1`,
      Date.parse("2026-08-13T12:16:00.000Z"),
    );
    seedToolReceipt(objectStore, {
      id: "invocation-cancel-failure",
      runId: "run-cancel-failure",
      toolCallId: "call",
      toolName: "terminal_run_command",
    });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_tasks
        (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name, state,
         command_sha256, command_deadline_at, stdout_head, stdout_tail, stderr_head,
         stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
      VALUES ('task-cancel-failure', 'run-cancel-failure', 'invocation-cancel-failure',
              1, 'provider-cancel-failure', 'submitting', 'hash', ?, '', '', '', '', 0, 0, ?, ?)`,
      Date.parse("2026-08-13T11:59:00.000Z"),
      Date.parse("2026-08-13T11:00:00.000Z"),
      Date.parse("2026-08-13T11:00:00.000Z"),
    );
    const baseFactory = testTerminalPortFactory(objectStore);
    let failCancellation = true;
    const flakyFactory = ((workspaceId: string, workstreamId: string) => {
      const port = baseFactory(workspaceId, workstreamId);
      return {
        ...port,
        cancelTaskAfterProviderCleanup: async (
          ...args: Parameters<typeof port.cancelTaskAfterProviderCleanup>
        ) => {
          if (failCancellation) {
            failCancellation = false;
            throw new Error("cancel port unavailable");
          }
          return port.cancelTaskAfterProviderCleanup(...args);
        },
      };
    }) satisfies typeof baseFactory;
    const missing = () => Object.assign(new Error("sandbox missing"), { statusCode: 404 });
    vi.mocked(provider.deleteSandbox).mockRejectedValueOnce(new Error("delete response lost"));
    vi.mocked(provider.getSandbox)
      .mockRejectedValueOnce(missing())
      .mockRejectedValueOnce(missing());

    await expect(reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      flakyFactory,
      provider,
      W,
      S,
      NOW,
    )).rejects.toThrow("terminal_lifecycle_expiry_tasks_unsettled");
    expect(workstreamObjectGet(
      objectStore,
      `SELECT lifecycle_state, sandbox_id, lifecycle_claim_id
         FROM terminal_workspace WHERE id = 1`,
    )).toMatchObject({
      lifecycle_state: "expiring",
      sandbox_id: "provider-1",
    });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE task_id = 'task-cancel-failure'",
    )).toEqual({ state: "submitting" });

    await expect(reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      baseFactory,
      provider,
      W,
      S,
      new Date(NOW.getTime() + 17 * 60_000),
    )).resolves.toEqual({ transition: "expired" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE task_id = 'task-cancel-failure'",
    )).toEqual({ state: "cancelled" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, sandbox_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "expired", sandbox_id: null });
  });

  it("keeps operation claims fenced while lifecycle cleanup owns the provider", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    seedWorkstreamRun(objectStore, { id: "run-lifecycle-race", status: "needs_input",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    seedWorkstreamRun(objectStore, { id: "run-linked-race", status: "admitted",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    workstreamObjectRun(
      objectStore,
      `UPDATE terminal_workspace
          SET operation_run_id = 'run-lifecycle-race', operation_lease_expires_at = ?
        WHERE id = 1`,
      Date.parse("2026-08-13T12:16:00.000Z"),
    );
    seedToolReceipt(objectStore, {
      id: "invocation-lifecycle-race",
      runId: "run-lifecycle-race",
      toolCallId: "call",
      toolName: "terminal_run_command",
    });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_tasks
        (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name, state,
         command_sha256, command_deadline_at, stdout_head, stdout_tail, stderr_head,
         stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
      VALUES ('task-lifecycle-race', 'run-lifecycle-race', 'invocation-lifecycle-race', 1,
              'task-race', 'running', 'hash', ?, '', '', '', '', 0, 0, ?, ?)`,
      Date.parse("2026-08-13T11:59:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
    );
    let finishStop!: () => void;
    vi.mocked(provider.stopSandbox).mockImplementationOnce(async () => (
      new Promise<void>((resolve) => { finishStop = resolve; })
    ));

    const lifecycle = reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      testTerminalPortFactory(objectStore),
      provider,
      W,
      S,
      NOW,
    );
    await vi.waitFor(() => expect(provider.stopSandbox).toHaveBeenCalledOnce());
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE task_id = 'task-lifecycle-race'",
    )).toEqual({ state: "running" });
    const terminal = testTerminalPortFactory(objectStore)(W, S);
    await expect(terminal.claimOperation({
      runId: "run-linked-race",
      generation: 1,
      leaseExpiresAt: Date.parse("2026-08-13T12:20:00.000Z"),
      now: NOW.getTime(),
    })).resolves.toBeNull();

    finishStop();
    await expect(lifecycle).resolves.toEqual({ transition: "stopped" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT state FROM terminal_tasks WHERE task_id = 'task-lifecycle-race'",
    )).toEqual({ state: "cancelled" });
    await expect(terminal.claimOperation({
      runId: "run-linked-race",
      generation: 1,
      leaseExpiresAt: Date.parse("2026-08-13T12:20:00.000Z"),
      now: NOW.getTime() + 1,
    })).resolves.toMatchObject({ operationRunId: "run-linked-race" });
  });

  it("settles every retained task after the required stop before lifecycle transition", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    seedWorkstreamRun(objectStore, { id: "run-lifecycle-batch", status: "needs_input",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    workstreamObjectRun(
      objectStore,
      `UPDATE terminal_workspace
          SET operation_run_id = 'run-lifecycle-batch', operation_lease_expires_at = ?
        WHERE id = 1`,
      Date.parse("2026-08-13T12:16:00.000Z"),
    );
    for (let index = 0; index < 21; index += 1) {
      const invocation = `lifecycle-batch-invocation-${index}`;
      seedToolReceipt(objectStore, {
        id: invocation,
        runId: "run-lifecycle-batch",
        toolCallId: `lifecycle-batch-call-${index}`,
        toolName: "terminal_run_command",
        position: index,
      });
      workstreamObjectRun(
        objectStore,
        `INSERT INTO terminal_tasks
          (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name, state,
           command_sha256, command_deadline_at, stdout_head, stdout_tail, stderr_head,
           stderr_tail, stdout_bytes, stderr_bytes, created_at, updated_at)
        VALUES (?, 'run-lifecycle-batch', ?, 1, ?, 'running', 'hash', ?, '', '', '', '', 0, 0, ?, ?)`,
        `lifecycle-batch-task-${index}`,
        invocation,
        `lifecycle-batch-provider-${index}`,
        Date.parse("2026-08-13T11:59:00.000Z"),
        Date.parse("2026-08-13T11:00:00.000Z"),
        Date.parse("2026-08-13T11:00:00.000Z"),
      );
    }
    await expect(reconcileDueTerminalSandbox(
      testHarnessRunPortFactory(objectStore),
      testTerminalPortFactory(objectStore),
      provider,
      W,
      S,
      NOW,
    )).resolves.toEqual({ transition: "stopped" });
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(
      objectStore,
      `SELECT COUNT(*) AS count FROM terminal_tasks WHERE state IN ('planned', 'submitting', 'running')`,
    )).toEqual({ count: 0 });
  });

  it("retains an unexpected metadata absence until the lifecycle retry can observe the archive", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    vi.mocked(provider.getSandbox).mockRejectedValue(Object.assign(new Error("missing metadata"), { status: 404 }));
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW))
      .rejects.toThrow("terminal_lifecycle_metadata_missing");
    expect(workstreamObjectGet(objectStore, "SELECT generation, sandbox_id, lifecycle_state, lifecycle_claim_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ generation: 1, sandbox_id: "provider-1", lifecycle_state: "running", lifecycle_claim_id: null });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    vi.mocked(provider.getSandbox).mockResolvedValue({ id: "provider-1", name: "sandbox-lifecycle", state: "archived", domainAllowList: [] });
    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW))
      .resolves.toEqual({ transition: "archived" });
    expect(workstreamObjectGet(objectStore, "SELECT sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ sandbox_id: "provider-1" });
  });

  it("restores a stable due state after a transient provider failure so the scheduler can retry", async () => {
    const { objectStore, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(new Error("transient stop failure"));
    vi.mocked(provider.getSandbox).mockResolvedValueOnce({
      id: "provider-1", name: "sandbox-lifecycle", state: "running", domainAllowList: [],
    });

    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW)).rejects.toThrow("transient stop failure");
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, failure_code FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "running", failure_code: "stopped_provider_failed" });

    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "stopped" });
    expect(provider.stopSandbox).toHaveBeenCalledTimes(2);
  });

  it("settles expiry when its retry observes Daytona already deleted the sandbox", async () => {
    const { objectStore, provider } = fixture("archived", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:30:00.000Z", expire: "2026-08-13T11:59:00.000Z",
    });
    const notFound = Object.assign(new Error("sandbox not found"), { response: { status: 404 } });
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET final_diff_resource_id = 'final-diff' WHERE id = 1",
    );
    vi.mocked(provider.deleteSandbox).mockRejectedValueOnce(new Error("delete response lost"));
    vi.mocked(provider.getSandbox).mockRejectedValueOnce(notFound);

    await expect(reconcileDueTerminalSandbox(testHarnessRunPortFactory(objectStore), testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "expired" });
    expect(workstreamObjectGet(
      objectStore,
      `SELECT generation, lifecycle_state, sandbox_id, expire_due_at, final_diff_resource_id
         FROM terminal_workspace WHERE id = 1`,
    )).toEqual({
      generation: 1,
      lifecycle_state: "expired",
      sandbox_id: null,
      expire_due_at: null,
      final_diff_resource_id: "final-diff",
    });
  });
});
