import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { reconcileDueTerminalSandbox } from "../src/services/terminal/lifecycle";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "40000000-0000-4000-8000-000000000001";
const S = "40000000-0000-4000-8000-000000000002";
const U = "40000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-13T12:00:00.000Z");

const openDatabases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture(state: "running" | "stopped" | "archived", deadlines: { warm: string; archive: string; expire: string }) {
  const database = migratedSqliteDatabase();
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
    INSERT INTO workstream_sandboxes
      (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
       authority_fingerprint, applied_network_revision, version, last_activity_at,
       warm_stop_due_at, archive_due_at, expire_due_at, created_at, updated_at)
    VALUES ('${W}', '${S}', '${state}', 'sandbox-lifecycle', 'provider-1', 1,
            'authority', 1, 1, '2026-08-13T10:00:00.000Z', '${deadlines.warm}',
            '${deadlines.archive}', '${deadlines.expire}', '2026-08-13', '2026-08-13');
  `);
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(async () => ({ id: "provider-1", name: "sandbox-lifecycle", state, domainAllowList: [] })),
    startSandbox: vi.fn(), stopSandbox: vi.fn(async () => undefined), archiveSandbox: vi.fn(async () => undefined), deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(), configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(), writeFile: vi.fn(), runCommand: vi.fn(), publishGitBundle: vi.fn(),
  };
  return { database, db: sqliteD1(database), provider };
}

describe("Terminal scheduled lifecycle", () => {
  it("stops one idle running sandbox exactly once after the warm deadline", async () => {
    const { database, db, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    await expect(reconcileDueTerminalSandbox(db, provider, W, S, NOW)).resolves.toEqual({ transition: "stopped" });
    await expect(reconcileDueTerminalSandbox(db, provider, W, S, NOW)).resolves.toEqual({ transition: "none" });
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT state, warm_stop_due_at FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?").get(W, S))
      .toEqual({ state: "stopped", warm_stop_due_at: null });
  });

  it("archives stopped state and expires archived state without polling", async () => {
    const stopped = fixture("stopped", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:59:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    await expect(reconcileDueTerminalSandbox(stopped.db, stopped.provider, W, S, NOW)).resolves.toEqual({ transition: "archived" });
    expect(stopped.provider.archiveSandbox).toHaveBeenCalledWith("provider-1");

    const archived = fixture("archived", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:30:00.000Z", expire: "2026-08-13T11:59:00.000Z",
    });
    const preserveFinalDiff = vi.fn(async () => undefined);
    await expect(reconcileDueTerminalSandbox(archived.db, archived.provider, W, S, NOW, preserveFinalDiff)).resolves.toEqual({ transition: "expired" });
    expect(preserveFinalDiff).not.toHaveBeenCalled();
    expect(archived.provider.clearGitHubReadAccess).toHaveBeenCalledWith("provider-1");
    expect(archived.provider.deleteSandbox).toHaveBeenCalledWith("provider-1");
    expect(archived.database.prepare("SELECT state, provider_sandbox_id FROM workstream_sandboxes WHERE workspace_id = ?").get(W))
      .toEqual({ state: "expired", provider_sandbox_id: null });
  });

  it("defers lifecycle transitions while a command task is still running", async () => {
    const { database, db, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    database.exec(`
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES ('run-lifecycle', '${W}', '${S}', 'test', '{"type":"user","userId":"${U}"}', 'running', '2026-08-13');
      INSERT INTO tool_invocations
        (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name, input_hash, input_json, status)
      VALUES ('invocation-lifecycle', '${W}', '${S}', 'run-lifecycle', 'call', 'terminal_run_command', 'hash', '{}', 'started');
      INSERT INTO sandbox_tasks
        (id, workspace_id, workstream_id, harness_run_id, tool_invocation_id, sandbox_generation,
         provider_task_name, state, command_sha256, command_deadline_at, created_at, updated_at)
      VALUES ('task-lifecycle', '${W}', '${S}', 'run-lifecycle', 'invocation-lifecycle', 1,
              'task', 'running', 'hash', '2026-08-13T12:10:00.000Z', '2026-08-13', '2026-08-13');
    `);
    await expect(reconcileDueTerminalSandbox(db, provider, W, S, NOW)).resolves.toEqual({ transition: "deferred" });
    expect(provider.stopSandbox).not.toHaveBeenCalled();
  });

  it("restores a stable due state after a transient provider failure so the scheduler can retry", async () => {
    const { database, db, provider } = fixture("running", {
      warm: "2026-08-13T11:55:00.000Z", archive: "2026-08-13T13:00:00.000Z", expire: "2026-09-12T12:00:00.000Z",
    });
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(new Error("transient stop failure"));
    vi.mocked(provider.getSandbox).mockResolvedValueOnce({
      id: "provider-1", name: "sandbox-lifecycle", state: "running", domainAllowList: [],
    });

    await expect(reconcileDueTerminalSandbox(db, provider, W, S, NOW)).rejects.toThrow("transient stop failure");
    expect(database.prepare(
      "SELECT state, failure_code FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ state: "running", failure_code: "stopped_provider_failed" });

    await expect(reconcileDueTerminalSandbox(db, provider, W, S, NOW)).resolves.toEqual({ transition: "stopped" });
    expect(provider.stopSandbox).toHaveBeenCalledTimes(2);
  });

  it("finalizes expiry when a retry observes that Daytona already deleted the sandbox", async () => {
    const { database, db, provider } = fixture("archived", {
      warm: "2026-08-13T11:00:00.000Z", archive: "2026-08-13T11:30:00.000Z", expire: "2026-08-13T11:59:00.000Z",
    });
    const notFound = Object.assign(new Error("sandbox not found"), { response: { status: 404 } });
    vi.mocked(provider.deleteSandbox).mockRejectedValueOnce(new Error("delete response lost"));
    vi.mocked(provider.getSandbox).mockRejectedValueOnce(notFound);

    await expect(reconcileDueTerminalSandbox(db, provider, W, S, NOW)).resolves.toEqual({ transition: "expired" });
    expect(database.prepare(
      "SELECT state, provider_sandbox_id, expire_due_at FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ state: "expired", provider_sandbox_id: null, expire_due_at: null });
  });
});
