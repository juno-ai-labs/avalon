import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTOMATION_SANDBOX_DELETE_AFTER_STOPPED_MINUTES,
  TerminalSandboxCoordinator,
  terminalSandboxStableName,
  type TerminalClock,
} from "../src/services/terminal/coordinator";
import { TERMINAL_OPERATION_LEASE_MS } from "../src/durable-objects/workstream-terminal-storage";
import { TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS } from "../src/services/terminal/contract";
import { sha256 } from "../src/lib/crypto";
import { resolveTerminalRunScope } from "../src/services/terminal/authority";
import type {
  TerminalSandboxProvider,
  TerminalSandboxState,
} from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import type { TerminalPortFactory } from "../src/services/terminal/object-port";
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
  testHarnessRunPort,
  testTerminalPortFactory,
  testResourcePort,
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
    recoverSandbox: vi.fn(async () => undefined),
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
    expect(provider.startSandbox).toHaveBeenCalledWith(
      "sandbox-1",
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
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

    expect(provider.startSandbox).toHaveBeenCalledWith(
      "sandbox-1",
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
    expect(acquired).toMatchObject({ providerSandboxId: "sandbox-1", state: "running" });
    expect(provider.createSandbox).toHaveBeenCalledOnce();
  });

  describe("acquisition deadline", () => {
    // Installed and restored in hooks rather than the test body, per
    // docs/testing.md: a restore a throwing assertion can skip is not a
    // restore.
    const ACQUISITION_STARTED_AT = 1_700_000_000_000;
    let wallClock = ACQUISITION_STARTED_AT;

    beforeEach(() => {
      wallClock = ACQUISITION_STARTED_AT;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("gives a restore the tool's acquisition deadline, not a provider default", async () => {
      const { objectStore, env, provider, clock, advance } = fixture();
      const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
      await coordinator.acquire(context());
      advance(90);

      // The deadline is anchored to when acquisition began, so everything it
      // spends before the restore — the workspace policy read, the
      // repository-authority join, the provider state read-back — comes out of
      // the same budget rather than resetting it. Handing the provider an
      // instant rather than a duration is what makes that true across the RPC
      // hop and the adapter's own lookup as well.
      vi.spyOn(Date, "now").mockImplementation(() => wallClock);
      vi.mocked(provider.getSandbox).mockImplementation(async (requested) => {
        wallClock += 25_000;
        return {
          id: "sandbox-1",
          name: requested,
          state: "archived" as const,
          domainAllowList: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
        };
      });

      await coordinator.acquire(context());

      expect(provider.startSandbox).toHaveBeenLastCalledWith("sandbox-1", {
        deadlineAtMs: ACQUISITION_STARTED_AT + TERMINAL_SANDBOX_ACQUISITION_BUDGET_MS,
      });
    });
  });

  it("re-observes a created sandbox whose start ran out of the deadline", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    vi.mocked(provider.createSandbox).mockResolvedValueOnce({
      id: "sandbox-1",
      name: "stable",
      state: "archived",
      domainAllowList: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
    });
    // The wait is bounded by the caller's deadline now, not a fixed minute, so
    // running out of it is an ordinary outcome. The restore is still on its
    // way, and Daytona says so when asked.
    vi.mocked(provider.startSandbox).mockRejectedValueOnce(new Error("timed out"));

    await expect(coordinator.acquire(context())).resolves.toMatchObject({
      providerSandboxId: "sandbox-1",
      state: "running",
    });
    expect(provider.getSandbox).toHaveBeenCalledWith("sandbox-1");
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
  });

  it("returns retryable guidance when a created sandbox is still starting", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    vi.mocked(provider.createSandbox).mockResolvedValueOnce({
      id: "sandbox-1",
      name: "stable",
      state: "archived",
      domainAllowList: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
    });
    vi.mocked(provider.startSandbox).mockRejectedValueOnce(new Error("timed out"));
    observeProviderState(provider, "sandbox-1", "starting");

    // A raw Daytona error here would reach the model as an unclassified tool
    // failure. It gets a retryable code and a reason instead, and the sandbox
    // is kept rather than discarded over a wait that merely ran out.
    await expect(coordinator.acquire(context())).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { retryAfterMs: 5_000 },
    });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])("honors provider recoverability %s before replacing an errored sandbox", async (recoverable) => {
    const { objectStore, env, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    vi.mocked(provider.getSandbox).mockResolvedValue({
      id: "sandbox-1", name: "sandbox-1", state: "failed", recoverable, domainAllowList: [],
    });
    if (recoverable === undefined) {
      await expect(coordinator.acquire(context())).rejects.toMatchObject({ code: "sandbox_unavailable" });
      expect(provider.recoverSandbox).not.toHaveBeenCalled();
    } else {
      await expect(coordinator.acquire(context())).resolves.toMatchObject({
        providerSandboxId: recoverable ? "sandbox-1" : "sandbox-2",
        generation: recoverable ? 1 : 2,
      });
      expect(provider.recoverSandbox).toHaveBeenCalledTimes(recoverable ? 1 : 0);
      expect(provider.runUtilityCommand).toHaveBeenCalledTimes(recoverable ? 1 : 0);
      expect(provider.readFile).toHaveBeenCalledTimes(recoverable ? 1 : 0);
    }
    expect(provider.deleteSandbox).toHaveBeenCalledTimes(recoverable === false ? 1 : 0);
    expect(provider.createSandbox).toHaveBeenCalledTimes(recoverable === false ? 2 : 1);
    expect(workstreamObjectGet(objectStore, "SELECT sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ sandbox_id: recoverable === false ? "sandbox-2" : "sandbox-1" });
  });

  it("retains a recoverable sandbox after recovery times out, then adopts its completed restore", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    vi.mocked(provider.getSandbox).mockResolvedValueOnce({
      id: "sandbox-1", name: "sandbox-1", state: "failed", recoverable: true, domainAllowList: [],
    }).mockResolvedValueOnce({
      id: "sandbox-1", name: "sandbox-1", state: "starting", domainAllowList: [],
    });
    vi.mocked(provider.recoverSandbox).mockRejectedValueOnce(new Error("recovery timed out"));
    await expect(coordinator.acquire(context())).rejects.toMatchObject({ code: "sandbox_unavailable" });
    observeProviderState(provider, "sandbox-1", "running");
    await expect(coordinator.acquire(context())).resolves.toMatchObject({ providerSandboxId: "sandbox-1", generation: 1 });
    expect(provider.recoverSandbox).toHaveBeenCalledOnce();
    // Recovery is a restore too — the failed-but-recoverable case is exactly
    // the one the old fixed minute censored — so it is bounded like one.
    // Asserting only the call count here left the argument unproved: deleting
    // it from the coordinator kept the whole suite green.
    expect(provider.recoverSandbox).toHaveBeenCalledWith(
      "sandbox-1",
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledOnce();
  });

  it("keeps the old generation when deletion of an unrecoverable sandbox is unconfirmed", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    vi.mocked(provider.getSandbox).mockResolvedValue({
      id: "sandbox-1", name: "sandbox-1", state: "failed", recoverable: false, domainAllowList: [],
    });
    vi.mocked(provider.deleteSandbox).mockRejectedValue(new Error("delete unavailable"));
    await expect(coordinator.acquire(context())).rejects.toThrow("delete unavailable");
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(objectStore, "SELECT generation, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ generation: 1, sandbox_id: "sandbox-1" });
  });

  it("preserves an unexpected metadata 404 and restores the same identity when it reappears", async () => {
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
    const missing = new Error("Sandbox with ID sandbox-1 not found") as Error & { status: number };
    missing.status = 404;
    vi.mocked(provider.getSandbox).mockRejectedValue(missing);
    advance(70);

    await expect(coordinator.acquire(context())).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(objectStore, "SELECT generation, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ generation: 1, sandbox_id: "sandbox-1" });

    observeProviderState(provider, "sandbox-1", "archived");
    await expect(coordinator.acquire(context())).resolves.toMatchObject({ providerSandboxId: "sandbox-1", generation: 1 });
    expect(provider.startSandbox).toHaveBeenCalledWith(
      "sandbox-1",
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
    expect(provider.createSandbox).toHaveBeenCalledOnce();
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

  it("preserves missing metadata before applying a changed network policy", async () => {
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
      .rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(provider.updateNetworkPolicy).not.toHaveBeenCalled();
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledOnce();
  });

  it("does not stamp a changed network policy Daytona did not apply", async () => {
    const { objectStore, env, provider, clock, advance } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET applied_network_revision = 0 WHERE id = 1",
    );
    // Daytona accepts the write and keeps the sandbox on unrestricted egress.
    vi.mocked(provider.getSandbox).mockResolvedValue({
      id: "sandbox-1", name: "sandbox-1", state: "running", domainAllowList: [],
    });
    advance(20);

    await expect(coordinator.acquire(context()))
      .rejects.toMatchObject({ code: "network_policy_unverified" });
    expect(provider.updateNetworkPolicy).toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT applied_network_revision FROM terminal_workspace WHERE id = 1",
    )).toEqual({ applied_network_revision: 0 });
  });

  it.each([400, 404])("keeps a restored sandbox unavailable until file readiness succeeds after HTTP %s", async (status) => {
    const { objectStore, env, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    observeProviderState(provider, "sandbox-1", "archived");
    vi.mocked(provider.readFile).mockRejectedValueOnce(Object.assign(new Error("runner unavailable"), { status }));
    await expect(coordinator.acquire(context())).rejects.toMatchObject({ code: "sandbox_unavailable" });
    expect(provider.startSandbox).toHaveBeenCalledWith(
      "sandbox-1",
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(objectStore, "SELECT generation, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ generation: 1, sandbox_id: "sandbox-1" });
    observeProviderState(provider, "sandbox-1", "running");
    await expect(coordinator.acquire(context())).resolves.toMatchObject({ providerSandboxId: "sandbox-1", generation: 1 });
    expect(provider.readFile).toHaveBeenLastCalledWith("sandbox-1", "/etc/hostname");
    expect(provider.startSandbox).toHaveBeenCalledOnce();
  });

  it("does not probe a healthy acquisition before the first real operation", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock);
    await coordinator.acquire(context());
    vi.mocked(provider.runUtilityCommand).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not ready" });
    await expect(coordinator.acquire(context())).resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
    expect(provider.runUtilityCommand).not.toHaveBeenCalled();
    expect(provider.readFile).not.toHaveBeenCalled();
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(provider.createSandbox).toHaveBeenCalledOnce();
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
          reason: "Retry in a few seconds; the workspace is released after each tool call.",
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
        toolName: "run_command",
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
      toolName: "run_command",
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
        toolName: "run_command",
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
      toolName: "run_command",
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
      toolName: "run_command",
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

  it("names a side thread's sandbox by its own conversation and keeps the main conversation's name", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const thread = "00000000-0000-4000-8000-000000000077";
    // The main conversation's derivation is the one every deployed sandbox
    // was created under; a changed hash would orphan them all at Daytona.
    const legacyHash = await sha256(`${WORKSPACE_ID}:${WORKSTREAM_ID}`);
    const mainName = `avalon-${legacyHash.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 24).toLowerCase()}`;
    await expect(terminalSandboxStableName(WORKSPACE_ID, WORKSTREAM_ID, "0")).resolves.toBe(mainName);

    const coordinator = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
      undefined, false, undefined,
      { parentKind: "canvas", backgroundAgent: false, runSubstreamId: thread, authoritySubstreamId: thread, runsPort: () => testHarnessRunPort(objectStore) },
    );
    await coordinator.acquire(context());

    const created = vi.mocked(provider.createSandbox).mock.calls[0]![0];
    expect(created.substreamId).toBe(thread);
    expect(created.stableName).not.toBe(mainName);
    expect(created.stableName).toBe(await terminalSandboxStableName(WORKSPACE_ID, WORKSTREAM_ID, thread));
  });

  it("hands a Sidekick's sandbox to Daytona for deletion, and a work stream's to the sweep", async () => {
    const run = "00000000-0000-4000-8000-000000000088";
    const created = async (parentKind: "automation" | "workstream", substreamId: string) => {
      // Each conversation's object is its own store; one fixture is one conversation.
      const { objectStore, env, provider, clock } = fixture();
      const coordinator = new TerminalSandboxCoordinator(
        env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
        undefined, false, undefined,
        { ...await resolveTerminalRunScope({ workspaceId: asWorkspaceId(WORKSPACE_ID), parentId: WORKSTREAM_ID,
          parentKind, substreamId: asSubstreamId(substreamId), backgroundAgent: false }, async () => null),
          runsPort: () => testHarnessRunPort(objectStore) },
      );
      await coordinator.acquire(context());
      expect(provider.createSandbox).toHaveBeenCalledOnce();
      return vi.mocked(provider.createSandbox).mock.calls[0]![0];
    };

    // A triggered run's conversation sits under the automation, where no
    // workspace sweep projects a deadline; Daytona must retire it alone.
    expect(await created("automation", run)).toMatchObject({
      substreamId: "0",
      autoDeleteAfterStoppedMinutes: AUTOMATION_SANDBOX_DELETE_AFTER_STOPPED_MINUTES,
    });
    expect(await created("workstream", "0")).not.toHaveProperty("autoDeleteAfterStoppedMinutes");
  });

  it("retries a failed lease release once and logs one that fails again, with its reason", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const ports = testTerminalPortFactory(objectStore);
    let refusals = 0;
    // The owner's object refusing the release hop, as a reset object does.
    const flaky: TerminalPortFactory = (workspaceId, workstreamId, substreamId) => {
      const port = ports(workspaceId, workstreamId, substreamId);
      return new Proxy(port, {
        get(target, key, receiver) {
          if (key !== "releaseOperation") return Reflect.get(target, key, receiver);
          return async (input: Parameters<typeof port.releaseOperation>[0]) => {
            if (refusals > 0) {
              refusals -= 1;
              throw new Error("object_reset");
            }
            return target.releaseOperation(input);
          };
        },
      });
    };
    const coordinator = new TerminalSandboxCoordinator(env, flaky, testResourcePortFactory(objectStore), provider, clock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const lease = () => workstreamObjectGet(objectStore, "SELECT operation_run_id FROM terminal_workspace WHERE id = 1");

    await coordinator.acquire(context());
    expect(lease()).toEqual({ operation_run_id: RUN_ID });
    refusals = 1;
    await coordinator.release(context());
    // The second attempt gave it back, and a hop that recovered is not news.
    expect(lease()).toEqual({ operation_run_id: null });
    expect(warn).not.toHaveBeenCalled();

    await coordinator.acquire({ ...context(), toolCallId: "second-call" });
    refusals = 2;
    await expect(coordinator.release({ ...context(), toolCallId: "second-call" })).resolves.toBeUndefined();
    // Still this run's until its next call, its yield, or the lease deadline;
    // the log says so, and says why.
    expect(lease()).toEqual({ operation_run_id: RUN_ID });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "terminal_lease_release_failed",
      harness_run_id: RUN_ID,
      tool_call_id: "second-call",
      reason: "object_reset",
    }));
  });

  it("drops a row a side thread reserved under the main conversation's name and reserves its own", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const thread = "00000000-0000-4000-8000-000000000066";
    // Before a sandbox belonged to a conversation, this thread's row was
    // reserved under the work stream's one name and holds the main
    // conversation's Daytona sandbox.
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_workspace
        (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
         authority_fingerprint, applied_network_revision, version, last_command_at,
         idle_expires_at, archive_due_at, expire_due_at, created_at, updated_at)
       VALUES (1, 'daytona', 'running', ?, 'sandbox-main', 1, 'authority', 1, 1, ?, ?, ?, ?, ?, ?)`,
      await terminalSandboxStableName(WORKSPACE_ID, WORKSTREAM_ID, "0"),
      Date.parse("2026-08-13T11:59:00.000Z"),
      Date.parse("2026-08-13T12:04:00.000Z"),
      Date.parse("2026-08-13T13:00:00.000Z"),
      Date.parse("2026-09-12T12:00:00.000Z"),
      Date.parse("2026-08-13T11:00:00.000Z"),
      Date.parse("2026-08-13T11:59:00.000Z"),
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const coordinator = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
      undefined, false, undefined,
      { parentKind: "canvas", backgroundAgent: false, runSubstreamId: thread, authoritySubstreamId: thread, runsPort: () => testHarnessRunPort(objectStore) },
    );

    // Not a sandbox a read may use, and not one readiness reuses.
    await expect(coordinator.peekRunning(context())).resolves.toBeNull();
    await expect(coordinator.acquire(context())).resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
    expect(vi.mocked(provider.createSandbox).mock.calls[0]![0].stableName)
      .toBe(await terminalSandboxStableName(WORKSPACE_ID, WORKSTREAM_ID, thread));
    // The main conversation's sandbox was neither stopped nor deleted by a
    // conversation that does not own it; only the row was dropped, and said so.
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "terminal_legacy_alias_row_retired", terminal_substream_id: thread, sandbox_generation: 1,
    }));
    info.mockRestore();
  });

  it("refuses a background agent whose authority differs from its owner's sandbox rather than replacing it", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const worker = "00000000-0000-4000-8000-000000000088";
    const workerRun = "00000000-0000-4000-8000-000000000089";
    const otherUser = asUserId("00000000-0000-4000-8000-0000000000ee");
    seedWorkstreamRun(objectStore, {
      id: workerRun,
      executionPrincipalJson: JSON.stringify({ type: "user", userId: otherUser }),
      createdAt: Date.parse("2026-08-13"),
    });
    const runsPort = () => testHarnessRunPort(objectStore);
    const owner = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
      undefined, false, undefined,
      { parentKind: "canvas", backgroundAgent: false, runSubstreamId: "0", authoritySubstreamId: "0", runsPort },
    );
    await owner.acquire(context());
    await owner.release(context());
    const agent = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
      undefined, false, undefined,
      { parentKind: "canvas", backgroundAgent: true, runSubstreamId: worker, authoritySubstreamId: "0", runsPort },
    );

    // An agent under another principal would, as an ordinary run, destroy
    // and reprovision the sandbox; it is the owner's checkout, so it refuses.
    await expect(agent.acquire({ ...context(otherUser), harnessRunId: workerRun, toolCallId: "worker-call" }))
      .rejects.toMatchObject({ code: "sandbox_authority_mismatch" });
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(objectStore, "SELECT generation, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ generation: 1, sandbox_id: "sandbox-1" });
  });

  it.each([false, true])("retains pre-delegation Sidekick files for another eligible coordinator (background=%s)", async (backgroundAgent) => {
    const { objectStore, env, provider, clock } = fixture();
    const child = "00000000-0000-4000-8000-000000000088";
    const childRun = "00000000-0000-4000-8000-000000000089";
    const otherUser = asUserId("00000000-0000-4000-8000-0000000000ee");
    const childStore = testWorkstreamObjectStore();
    openDatabases.push(childStore);
    seedWorkstreamObjectRoot(childStore, { workstreamId: WORKSTREAM_ID, workspaceId: WORKSPACE_ID });
    seedWorkstreamRun(childStore, { id: childRun,
      executionPrincipalJson: JSON.stringify({ type: "user", userId: otherUser }) });
    const runsPort = (_workspaceId: string, _parentId: string, substreamId?: string) =>
      testHarnessRunPort(substreamId === child ? childStore : objectStore);
    const scope = (substreamId: string, background: boolean) => resolveTerminalRunScope({
      workspaceId: asWorkspaceId(WORKSPACE_ID), parentId: WORKSTREAM_ID, parentKind: "automation",
      substreamId: asSubstreamId(substreamId), backgroundAgent: background,
    }, async () => null);
    const wizard = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
      undefined, false, undefined, { ...await scope("0", false), runsPort },
    );
    await wizard.acquire(context());
    await wizard.release(context());
    const activation = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
      undefined, false, undefined, { ...await scope(child, backgroundAgent), runsPort, sharedFileUserId: USER_ID },
    );
    const nextContext = { ...context(otherUser), harnessRunId: childRun, toolCallId: "sidekick-next" };
    await expect(activation.acquire(nextContext)).resolves.toMatchObject({ providerSandboxId: "sandbox-1", generation: 1 });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(objectStore, "SELECT generation FROM terminal_workspace WHERE id = 1"))
      .toEqual({ generation: 1 });
  });

  it("judges each import by the conversation whose attachment authorized it", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const worker = "00000000-0000-4000-8000-000000000088";
    const workerRun = "00000000-0000-4000-8000-000000000089";
    const ownerResource = "00000000-0000-4000-8000-0000000000a1";
    const workerResource = "00000000-0000-4000-8000-0000000000a2";
    seedWorkstreamRun(objectStore, {
      id: workerRun,
      executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
      createdAt: Date.parse("2026-08-13"),
    });
    // The agent's conversation is its own object, with its own attachments.
    const workerStore = testWorkstreamObjectStore();
    openDatabases.push(workerStore);
    seedWorkstreamObjectRoot(workerStore, { workstreamId: WORKSTREAM_ID, workspaceId: WORKSPACE_ID });
    for (const [store, resourceId] of [[objectStore, ownerResource], [workerStore, workerResource]] as const) {
      await env.DB.prepare(
        `INSERT INTO resources
           (id, workspace_id, resource_type, provider, title, created_at, updated_at, uploaded_by_user_id, attachment_status)
         VALUES (?, ?, 'file', 'avalon_upload', 'file.txt', '2026-08-13', '2026-08-13', ?, 'attached')`,
      ).bind(resourceId, WORKSPACE_ID, USER_ID).run();
      workstreamObjectRun(
        store,
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
         VALUES (?, ?, 0, 'attachment', ?, ?, ?)`,
        resourceId, USER_ID, JSON.stringify({ id: resourceId }), Date.parse("2026-08-13"), Date.parse("2026-08-13"),
      );
    }
    const ownerLinks = testResourcePort(objectStore);
    const workerLinks = testResourcePort(workerStore);
    const resources = (_workspaceId: string, _workstreamId: string, substreamId?: string) =>
      substreamId === worker ? workerLinks : ownerLinks;
    const runsPort = () => testHarnessRunPort(objectStore);
    const owner = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), resources, provider, clock,
      undefined, false, undefined,
      { parentKind: "canvas", backgroundAgent: false, runSubstreamId: "0", authoritySubstreamId: "0", runsPort },
    );
    const agent = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), resources, provider, clock,
      undefined, false, undefined,
      { parentKind: "canvas", backgroundAgent: true, runSubstreamId: worker, authoritySubstreamId: "0", runsPort },
    );
    await owner.acquire(context());
    await owner.release(context());
    // The owner imported what its conversation had attached; the agent, what its own had.
    const terminal = testTerminalPortFactory(objectStore)(WORKSPACE_ID, WORKSTREAM_ID, "0");
    await terminal.recordImportedResource({
      sandboxGeneration: 1, resourceId: ownerResource, destinationPath: "/workspace/imports/owner.txt",
      sourceSha256: "a".repeat(64), sizeBytes: 1, state: "completed", importedAt: 1, now: 1,
    });
    await terminal.recordImportedResource({
      sandboxGeneration: 1, resourceId: workerResource, destinationPath: "/workspace/imports/worker.txt",
      sourceSha256: "b".repeat(64), sizeBytes: 1, state: "completed", importedAt: 1, attachedSubstreamId: worker, now: 1,
    });
    const agentContext = { ...context(), harnessRunId: workerRun, toolCallId: "worker-call" };

    // Neither conversation's import is revoked by the other's attachments.
    await expect(agent.acquire(agentContext)).resolves.toMatchObject({ generation: 1 });
    await agent.release(agentContext);
    await expect(owner.acquire({ ...context(), toolCallId: "owner-second" })).resolves.toMatchObject({ generation: 1 });
    await owner.release({ ...context(), toolCallId: "owner-second" });
    expect(provider.createSandbox).toHaveBeenCalledOnce();

    // Detached where it was attached, the agent's import is revoked for the
    // sandbox: no read uses it, and the owner's next call replaces it.
    workstreamObjectRun(workerStore, "DELETE FROM workstream_resource_links WHERE resource_id = ?", workerResource);
    await expect(owner.peekRunning({ ...context(), toolCallId: "owner-peek" })).resolves.toBeNull();
    await expect(owner.acquire({ ...context(), toolCallId: "owner-third" })).resolves.toMatchObject({ generation: 2 });
    expect(provider.createSandbox).toHaveBeenCalledTimes(2);
  });

  it("lets a background agent settle a command that outran its lease", async () => {
    const { objectStore } = fixture();
    const worker = "00000000-0000-4000-8000-000000000088";
    const workerRun = "00000000-0000-4000-8000-000000000089";
    const terminal = testTerminalPortFactory(objectStore)(WORKSPACE_ID, WORKSTREAM_ID, "0");
    const claimedAt = Date.parse("2026-08-13T12:00:00.000Z");
    const deadlines = {
      idleExpiresAt: claimedAt + 5 * 60_000, archiveDueAt: claimedAt + 60 * 60_000, expireDueAt: claimedAt + 30 * 24 * 60 * 60_000,
    };
    // The worker's run is in its own object; here it is known only by its lease.
    await terminal.reserveFirstGeneration({
      stableName: "owner-sandbox", authorityFingerprint: "authority", networkRevision: 1,
      runId: workerRun, runSubstreamId: worker,
      operationLeaseExpiresAt: claimedAt + TERMINAL_OPERATION_LEASE_MS, ...deadlines, now: claimedAt,
    });
    await terminal.attachProviderSandbox({ generation: 1, sandboxId: "sandbox-1", lifecycleState: "running", ...deadlines, now: claimedAt });
    await expect(terminal.insertTask({
      taskId: "task-long", runId: workerRun, runSubstreamId: worker, effectIntentId: "effect-long",
      sandboxGeneration: 1, sandboxId: "sandbox-1", providerTaskName: "avalon-task-effect-long",
      commandSha256: "command", commandDeadlineAt: claimedAt + 17 * 60_000, startedAt: claimedAt, now: claimedAt,
    })).resolves.toBe(true);

    // Seventeen minutes on the lease is past its deadline, and the command
    // has just finished. The run that submitted it is the one that settles it.
    const finishedAt = claimedAt + 17 * 60_000;
    await expect(terminal.settleTask({
      effectIntentId: "effect-long", runId: workerRun, sandboxGeneration: 1, sandboxId: "sandbox-1",
      state: "completed", exitCode: 0, terminationReason: "exited",
      stdoutHead: "", stdoutTail: "", stderrHead: "", stderrTail: "", stdoutBytes: 0, stderrBytes: 0,
      completedAt: finishedAt, now: finishedAt,
    })).resolves.toBe(true);
    expect(workstreamObjectGet(objectStore, "SELECT state FROM terminal_tasks WHERE task_id = 'task-long'"))
      .toEqual({ state: "completed" });
  });

  it("lets a background agent hold its owner's lease from another conversation until it yields", async () => {
    const { objectStore, env, provider, clock } = fixture();
    const worker = "00000000-0000-4000-8000-000000000088";
    const workerRun = "00000000-0000-4000-8000-000000000089";
    // The worker's run row is in the worker's own object, never in the
    // owner's, so the owner's storage cannot read its liveness itself.
    const workerStore = testWorkstreamObjectStore();
    openDatabases.push(workerStore);
    seedWorkstreamObjectRoot(workerStore, { workstreamId: WORKSTREAM_ID, workspaceId: WORKSPACE_ID });
    seedWorkstreamRun(workerStore, { id: workerRun,
      executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }) });
    const runsPort = (_workspaceId: string, _workstreamId: string, substreamId?: string) =>
      testHarnessRunPort(substreamId === worker ? workerStore : objectStore);
    const owner = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
      undefined, false, undefined,
      { parentKind: "canvas", backgroundAgent: false, runSubstreamId: "0", authoritySubstreamId: "0", runsPort },
    );
    const agent = new TerminalSandboxCoordinator(
      env, testTerminalPortFactory(objectStore), testResourcePortFactory(objectStore), provider, clock,
      undefined, false, undefined,
      { parentKind: "canvas", backgroundAgent: true, runSubstreamId: worker, authoritySubstreamId: "0", runsPort },
    );
    const workerContext = { ...context(), harnessRunId: workerRun, toolCallId: "worker-call" };

    await expect(agent.acquire(workerContext)).resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT operation_run_id, operation_run_substream_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ operation_run_id: workerRun, operation_run_substream_id: worker });
    // Held: the worker is still running in its own object, which is where
    // the owner's coordinator asks.
    await expect(owner.acquire(context())).rejects.toMatchObject({ code: "sandbox_busy" });

    workstreamObjectRun(workerStore, "UPDATE runs SET status = 'completed' WHERE run_id = ?", workerRun);
    await expect(owner.acquire(context())).resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT operation_run_id, operation_run_substream_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ operation_run_id: RUN_ID, operation_run_substream_id: null });
    // One sandbox, shared: the worker created it and the owner reused it.
    expect(provider.createSandbox).toHaveBeenCalledOnce();
  });
});
