import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import {
  TerminalWorkstreamService,
  type TerminalRepositoryCatalogGateway,
} from "../src/services/terminal/workstream-state";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "61000000-0000-4000-8000-000000000001";
const S = "61000000-0000-4000-8000-000000000002";
const U = "61000000-0000-4000-8000-000000000003";
const C = "61000000-0000-4000-8000-000000000004";
const RUN = "61000000-0000-4000-8000-000000000005";
const INVOCATION = "61000000-0000-4000-8000-000000000006";
const NEWER_RUN = "61000000-0000-4000-8000-000000000007";
const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = migratedSqliteDatabase(); databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'terminal-state', 'state@example.com', 'State', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'State', 'terminal-state', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'member', 'active', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'State', 'State', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${S}', '${U}', '${U}', 'creator', '2026-08-13');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, granted_scopes_json, model_plugin_id, status, created_at, updated_at)
    VALUES ('${C}', '${W}', 'github', 'workspace', NULL, '1234', 'GitHub',
            '[]', 'plugin_github', 'healthy', '2026-08-13', '2026-08-13');
  `);
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", TERMINAL_REGION_CAPABILITY: "supported",
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn(async () => undefined) }),
    DAYTONA_API_KEY: "key", DAYTONA_API_URL: "https://app.daytona.io/api", DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "snapshot", TERMINAL_EMERGENCY_DISABLED: "false",
  });
  const auth: AuthContext = { sessionId: "session", userId: U, workspaceId: W, region: "global", role: "member" };
  const catalog: TerminalRepositoryCatalogGateway = {
    listRepositories: vi.fn(async () => [{
      id: 42, fullName: "owner/repo", defaultBranch: "main", private: true,
    }]),
    resolveRepository: vi.fn(async () => ({
      id: 42, fullName: "owner/repo", defaultBranch: "main", baseSha: "a".repeat(40), private: true,
    })),
  };
  return { database, env, auth, catalog, service: new TerminalWorkstreamService(env, auth, catalog) };
}

describe("Terminal work-stream state", () => {
  it("projects absent state without allocating Daytona and lists only App-authorized repositories", async () => {
    const { catalog, service } = fixture();
    await expect(service.get(S)).resolves.toMatchObject({
      availability: "supported", state: "absent", repository: null, repositoryRequest: null,
      lastActivityAt: null, expiresAt: null,
    });
    await expect(service.repositories(S, new AbortController().signal)).resolves.toEqual({
      state: "available",
      connections: [{ connectionId: C, displayName: "GitHub", repositories: [{ id: 42, fullName: "owner/repo", defaultBranch: "main", private: true }] }],
    });
    expect(catalog.listRepositories).toHaveBeenCalledWith(C, W, expect.any(AbortSignal));
  });

  it("projects a repository request only from the latest run's durable repository failure", async () => {
    const { database, service } = fixture();
    database.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
       VALUES (?, ?, ?, 'manual', '{}', 'needs_input', ?)`,
    ).run(RUN, W, S, "2026-08-13T12:00:00.000Z");
    database.prepare(
      `INSERT INTO tool_invocations
       (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
        input_hash, input_json, status, error_json, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'call-1', 'terminal_write_file', 'hash', '{}', 'ambiguous', ?, ?, ?)`,
    ).run(
      INVOCATION,
      W,
      S,
      RUN,
      JSON.stringify({ code: "ambiguous_external_write", message: "Operation timed out" }),
      "2026-08-13T12:00:01.000Z",
      "2026-08-13T12:01:01.000Z",
    );

    await expect(service.get(S)).resolves.toMatchObject({ repositoryRequest: null });

    database.prepare(
      "UPDATE tool_invocations SET status = 'failed', error_json = ? WHERE id = ?",
    ).run(JSON.stringify({ code: "repository_not_configured", message: "Choose a repository" }), INVOCATION);

    await expect(service.get(S)).resolves.toMatchObject({
      repositoryRequest: { id: INVOCATION, harnessRunId: RUN },
    });

    database.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
       VALUES (?, ?, ?, 'manual', '{}', 'completed', ?)`,
    ).run(NEWER_RUN, W, S, "2026-08-13T12:02:00.000Z");
    await expect(service.get(S)).resolves.toMatchObject({ repositoryRequest: null });
  });

  it("selects an exact authorized repository and returns lifecycle retention state", async () => {
    const { database, service } = fixture();
    await expect(service.selectRepository(S, {
      connectionId: C, repositoryFullName: "owner/repo",
    }, new AbortController().signal)).resolves.toMatchObject({
      repository: { id: 42, fullName: "owner/repo", baseRef: "main", baseSha: "a".repeat(40), headRef: `avalon/${S}` },
    });
    database.prepare(
      `INSERT INTO workstream_sandboxes
       (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_activity_at,
        expire_due_at, final_diff_resource_id, created_at, updated_at)
       VALUES (?, ?, 'stopped', 'state-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, NULL, ?, ?)`,
    ).run(W, S, "2026-08-13T12:00:00.000Z", "2026-09-12T12:00:00.000Z", "2026-08-13T12:00:00.000Z", "2026-08-13T12:00:00.000Z");
    await expect(service.get(S)).resolves.toMatchObject({
      state: "stopped", lastActivityAt: "2026-08-13T12:00:00.000Z", expiresAt: "2026-09-12T12:00:00.000Z",
      localFilesRetained: true,
    });
  });

  it("requires an active participant to change repository selection", async () => {
    const { database, service } = fixture();
    database.prepare("UPDATE workstream_participants SET removed_at = '2026-08-13' WHERE workstream_id = ? AND user_id = ?").run(S, U);
    await expect(service.selectRepository(S, { connectionId: C, repositoryFullName: "owner/repo" }, new AbortController().signal)).rejects.toMatchObject({
      status: 403, code: "workstream_participant_required",
    });
  });

  it("requires destructive confirmation and preserves a final diff before replacing retained files", async () => {
    const { database, env, auth, catalog, service } = fixture();
    await service.selectRepository(S, { connectionId: C, repositoryFullName: "owner/repo" }, new AbortController().signal);
    database.prepare(
      `INSERT INTO workstream_sandboxes
       (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_activity_at,
        expire_due_at, created_at, updated_at)
       VALUES (?, ?, 'running', 'state-sandbox', 'provider-1', 1, 'authority', 1, 1,
               '2026-08-13', '2026-09-12', '2026-08-13', '2026-08-13')`,
    ).run(W, S);
    const provider: TerminalSandboxProvider = {
      createSandbox: vi.fn(), getSandbox: vi.fn(), startSandbox: vi.fn(), stopSandbox: vi.fn(), archiveSandbox: vi.fn(),
      deleteSandbox: vi.fn(async () => undefined), updateNetworkPolicy: vi.fn(), configureGitHubReadAccess: vi.fn(),
      clearGitHubReadAccess: vi.fn(async () => undefined), readFile: vi.fn(), writeFile: vi.fn(),
      runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "diff --git a/a b/a\n", stderr: "" })),
      publishGitBundle: vi.fn(),
    };
    const replacing = new TerminalWorkstreamService(env, auth, catalog, provider);

    await expect(replacing.selectRepository(S, {
      connectionId: C, repositoryFullName: "owner/repo",
    }, new AbortController().signal)).rejects.toMatchObject({
      status: 409, code: "terminal_local_files_confirmation_required",
    });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();

    await expect(replacing.selectRepository(S, {
      connectionId: C, repositoryFullName: "owner/repo", confirmDiscardLocalFiles: true,
    }, new AbortController().signal)).resolves.toMatchObject({ repository: { fullName: "owner/repo" } });
    expect(provider.runCommand).toHaveBeenCalledBefore(vi.mocked(provider.deleteSandbox));
    expect(provider.deleteSandbox).toHaveBeenCalledWith("provider-1");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_resources WHERE workstream_id = ?",
    ).get(S)).toEqual({ count: 1 });
  });
});
