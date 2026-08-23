import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { reconcileDueTerminalSandbox } from "../src/services/terminal/lifecycle";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
  testWorkstreamRuntimeD1,
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
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(async () => ({ id: "provider-1", name: "sandbox-lifecycle", state, domainAllowList: [] })),
    startSandbox: vi.fn(), stopSandbox: vi.fn(async () => undefined), archiveSandbox: vi.fn(async () => undefined), deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(), configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(), writeFile: vi.fn(), runCommand: vi.fn(), publishGitBundle: vi.fn(),
  };
  return {
    database,
    objectStore,
    db: testWorkstreamRuntimeD1(sqliteD1(database), objectStore, { workspaceId: W, workstreamId: S }),
    provider,
  };
}

describe("Terminal scheduled lifecycle", () => {
  it("stops one idle running sandbox exactly once after the warm deadline", async () => {
    const { objectStore, db, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    await expect(reconcileDueTerminalSandbox(db, testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "stopped" });
    await expect(reconcileDueTerminalSandbox(db, testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "none" });
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, idle_expires_at FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "stopped", idle_expires_at: null });
  });

  it("archives stopped state and expires archived state without polling", async () => {
    const stopped = fixture("stopped", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:59:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    await expect(reconcileDueTerminalSandbox(stopped.db, testTerminalPortFactory(stopped.objectStore), stopped.provider, W, S, NOW)).resolves.toEqual({ transition: "archived" });
    expect(stopped.provider.archiveSandbox).toHaveBeenCalledWith("provider-1");

    const archived = fixture("archived", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:30:00.000Z", expire: "2026-08-13T11:59:00.000Z",
    });
    const preserveFinalDiff = vi.fn(async () => undefined);
    await expect(reconcileDueTerminalSandbox(archived.db, testTerminalPortFactory(archived.objectStore), archived.provider, W, S, NOW, preserveFinalDiff)).resolves.toEqual({ transition: "expired" });
    expect(preserveFinalDiff).not.toHaveBeenCalled();
    expect(archived.provider.clearGitHubReadAccess).toHaveBeenCalledWith("provider-1");
    expect(archived.provider.deleteSandbox).toHaveBeenCalledWith("provider-1");
    expect(workstreamObjectGet(archived.objectStore, "SELECT lifecycle_state, sandbox_id FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "expired", sandbox_id: null });
  });

  it("defers lifecycle transitions while a command task is still running", async () => {
    const { objectStore, db, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES ('run-lifecycle', ?, ?, 'test', ?, 'running', '2026-08-13')`,
      W, S, JSON.stringify({ type: "user", userId: U }),
    );
    seedToolReceipt(objectStore, {
      id: 'invocation-lifecycle', runId: 'run-lifecycle', toolCallId: 'call',
      toolName: 'terminal_run_command',
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
    await expect(reconcileDueTerminalSandbox(db, testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "deferred" });
    expect(provider.stopSandbox).not.toHaveBeenCalled();
  });

  it("restores a stable due state after a transient provider failure so the scheduler can retry", async () => {
    const { objectStore, db, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(new Error("transient stop failure"));
    vi.mocked(provider.getSandbox).mockResolvedValueOnce({
      id: "provider-1", name: "sandbox-lifecycle", state: "running", domainAllowList: [],
    });

    await expect(reconcileDueTerminalSandbox(db, testTerminalPortFactory(objectStore), provider, W, S, NOW)).rejects.toThrow("transient stop failure");
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, failure_code FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "running", failure_code: "stopped_provider_failed" });

    await expect(reconcileDueTerminalSandbox(db, testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "stopped" });
    expect(provider.stopSandbox).toHaveBeenCalledTimes(2);
  });

  it("finalizes expiry when a retry observes that Daytona already deleted the sandbox", async () => {
    const { objectStore, db, provider } = fixture("archived", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:30:00.000Z", expire: "2026-08-13T11:59:00.000Z",
    });
    const notFound = Object.assign(new Error("sandbox not found"), { response: { status: 404 } });
    vi.mocked(provider.deleteSandbox).mockRejectedValueOnce(new Error("delete response lost"));
    vi.mocked(provider.getSandbox).mockRejectedValueOnce(notFound);

    await expect(reconcileDueTerminalSandbox(db, testTerminalPortFactory(objectStore), provider, W, S, NOW)).resolves.toEqual({ transition: "expired" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, sandbox_id, expire_due_at FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "expired", sandbox_id: null, expire_due_at: null });
  });
});
