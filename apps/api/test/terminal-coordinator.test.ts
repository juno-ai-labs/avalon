import type { HarnessToolContext } from "@avalon/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TerminalSandboxCoordinator,
  type TerminalClock,
} from "../src/services/terminal/coordinator";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { compileTerminalNetworkPolicy } from "../src/services/terminal/network-policy";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000004";

const openDatabases: ReturnType<typeof migratedSqliteDatabase>[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture() {
  const database = migratedSqliteDatabase();
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
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES ('${RUN_ID}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'test',
            '{"type":"user","userId":"${USER_ID}"}', 'running', '2026-08-13');
  `);
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
    publishGitBundle: vi.fn(async (input) => ({ publishedSha: input.headSha })),
  };
  return {
    database,
    db: sqliteD1(database),
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
  it("creates on first acquisition and reuses one sandbox per work stream", async () => {
    const { database, db, provider, clock } = fixture();
    const acquisitionObserved = vi.fn(async () => undefined);
    const coordinator = new TerminalSandboxCoordinator(
      db,
      provider,
      clock,
      undefined,
      false,
      acquisitionObserved,
    );

    expect(database.prepare("SELECT COUNT(*) AS count FROM workstream_sandboxes").get()).toEqual({ count: 0 });
    const first = await coordinator.acquire(context());
    const second = await coordinator.acquire({ ...context(), toolCallId: "call-2" });

    expect(first).toMatchObject({ providerSandboxId: "sandbox-1", generation: 1, state: "running" });
    expect(second).toEqual(first);
    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(provider.startSandbox).not.toHaveBeenCalled();
    expect(acquisitionObserved).toHaveBeenCalledOnce();
    expect(acquisitionObserved).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ action: "start" }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstream_sandboxes").get()).toEqual({ count: 1 });
  });

  it("recovers an ambiguous create by the stable provider name", async () => {
    const { db, provider, clock } = fixture();
    vi.mocked(provider.createSandbox).mockRejectedValueOnce(new Error("provider timeout"));
    provider.prepareSandbox = vi.fn(async (id: string, expectedDomainAllowList: string[]) => ({
      id,
      name: id,
      state: "running" as const,
      domainAllowList: expectedDomainAllowList,
    }));
    const coordinator = new TerminalSandboxCoordinator(db, provider, clock);

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
    const { database, db, provider, clock } = fixture();
    vi.mocked(provider.createSandbox).mockImplementationOnce(async (input) => ({
      id: "sandbox-policy-mismatch",
      name: input.stableName,
      state: "running",
      domainAllowList: [],
    }));
    const coordinator = new TerminalSandboxCoordinator(db, provider, clock);

    await expect(coordinator.acquire(context())).rejects.toMatchObject({
      code: "network_policy_unverified",
    });
    expect(provider.deleteSandbox).toHaveBeenCalledWith("sandbox-policy-mismatch");
    expect(database.prepare(
      "SELECT state, failure_code FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(WORKSPACE_ID, WORKSTREAM_ID)).toEqual({
      state: "failed",
      failure_code: "provider_policy_mismatch",
    });
  });

  it("destroys and reprovisions before reuse when execution authority changes", async () => {
    const { database, db, provider, clock } = fixture();
    const coordinator = new TerminalSandboxCoordinator(db, provider, clock);
    await coordinator.acquire(context());
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('other-user', 'other-terminal-user', 'other@example.com', 'Other', '2026-08-13', '2026-08-13');
    `);

    await expect(coordinator.acquire(context("other-user"))).resolves.toMatchObject({
      providerSandboxId: "sandbox-2",
      generation: 2,
    });
    expect(provider.deleteSandbox).toHaveBeenCalledWith("sandbox-1");
    expect(provider.createSandbox).toHaveBeenCalledTimes(2);
  });

  it("starts stopped sandboxes and refreshes lifecycle deadlines without polling", async () => {
    const { database, db, provider, clock, advance } = fixture();
    const coordinator = new TerminalSandboxCoordinator(db, provider, clock);
    await coordinator.acquire(context());
    database.prepare("UPDATE workstream_sandboxes SET state = 'stopped' WHERE workspace_id = ? AND workstream_id = ?")
      .run(WORKSPACE_ID, WORKSTREAM_ID);
    advance(10);

    const acquired = await coordinator.acquire(context());
    expect(provider.startSandbox).toHaveBeenCalledWith("sandbox-1");
    expect(acquired).toMatchObject({ state: "running" });
    expect(database.prepare(
      "SELECT warm_stop_due_at, archive_due_at, expire_due_at FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(WORKSPACE_ID, WORKSTREAM_ID)).toEqual({
      warm_stop_due_at: "2026-08-13T12:15:00.000Z",
      archive_due_at: "2026-08-13T13:10:00.000Z",
      expire_due_at: "2026-09-12T12:10:00.000Z",
    });
  });

  it("serializes mutating runs with the durable operation lease", async () => {
    const { database, db, provider, clock } = fixture();
    const otherRun = "00000000-0000-4000-8000-000000000099";
    database.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
       VALUES (?, ?, ?, 'test', ?, 'running', '2026-08-13')`,
    ).run(otherRun, WORKSPACE_ID, WORKSTREAM_ID, `{"type":"user","userId":"${USER_ID}"}`);
    const coordinator = new TerminalSandboxCoordinator(db, provider, clock);
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

    database.prepare("UPDATE harness_runs SET status = 'completed' WHERE id = ?").run(RUN_ID);
    await expect(coordinator.acquire({ ...context(), harnessRunId: otherRun, toolCallId: "other-call" }))
      .resolves.toMatchObject({ providerSandboxId: "sandbox-1" });
  });
});
