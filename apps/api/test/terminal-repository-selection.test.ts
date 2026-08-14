import type { HarnessToolContext } from "@avalon/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptString, sha256Hex } from "../src/lib/crypto";
import { TerminalSandboxCoordinator } from "../src/services/terminal/coordinator";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { createTerminalRepositorySelector } from "../src/services/terminal/repository-selection";
import {
  createGitHubTerminalCatalogGateway,
  type TerminalRepositoryCatalogGateway,
} from "../src/services/terminal/workstream-state";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "71000000-0000-4000-8000-000000000001";
const S = "71000000-0000-4000-8000-000000000002";
const U = "71000000-0000-4000-8000-000000000003";
const R = "71000000-0000-4000-8000-000000000004";
const PERSONAL = "71000000-0000-4000-8000-000000000005";
const WORKSPACE = "71000000-0000-4000-8000-000000000006";
const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

async function fixture(input?: { backupResult?: string; baseSha?: string; emailAddress?: string | null }) {
  const database = migratedSqliteDatabase();
  databases.push(database);
  const emailAddressSql = input?.emailAddress === null
    ? "NULL"
    : `'${input?.emailAddress ?? "bright-coastal-exact-heron@automation.with-avalon.com"}'`;
  const readPolicy = JSON.stringify({
    githubRepositoryAccess: {
      version: 1,
      revision: 1,
      mode: "all_repositories",
      defaultAccess: "read_only",
      repositories: [],
    },
  });
  const fullPolicy = JSON.stringify({
    githubRepositoryAccess: {
      version: 1,
      revision: 1,
      mode: "all_repositories",
      defaultAccess: "full_access",
      repositories: [],
    },
  });
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'repository-selection', 'repo@example.com', 'Repo', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Repo', 'repo-selection', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'owner', 'active', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, email_address, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Repo', 'Repo', 'ad_hoc', '${U}', 'running',
            ${emailAddressSql},
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${S}', '${U}', '${U}', 'creator', '2026-08-13');
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES ('${R}', '${W}', '${S}', 'manual', '{"type":"user","userId":"${U}"}', 'running', '2026-08-13');
  `);
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, granted_scopes_json, model_plugin_id, status, config_json, created_at, updated_at)
     VALUES (?, ?, 'github', 'personal', ?, '42', 'Personal GitHub', '[]', 'plugin_github', 'healthy', ?, ?, ?)`,
  ).run(PERSONAL, W, U, readPolicy, "2026-08-13", "2026-08-13");
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, granted_scopes_json, model_plugin_id, status, config_json, created_at, updated_at)
     VALUES (?, ?, 'github', 'workspace', NULL, '42', 'Workspace GitHub', '[]', 'plugin_github_2', 'healthy', ?, ?, ?)`,
  ).run(WORKSPACE, W, fullPolicy, "2026-08-13T00:00:01Z", "2026-08-13T00:00:01Z");
  const backupBytes = new TextEncoder().encode("backup-bytes");
  const backupSha = await sha256Hex(backupBytes);
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(),
    getSandbox: vi.fn(),
    startSandbox: vi.fn(async () => undefined),
    stopSandbox: vi.fn(),
    archiveSandbox: vi.fn(),
    deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(),
    configureGitHubReadAccess: vi.fn(),
    clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(async () => backupBytes),
    writeFile: vi.fn(),
    runCommand: vi.fn(async (_sandbox, command) => ({
      exitCode: 0,
      stdout: command.taskName.includes("cleanup")
        ? ""
        : input?.backupResult ?? `READY ${backupBytes.byteLength} ${backupSha}\n`,
      stderr: "",
    })),
    publishGitBundle: vi.fn(),
  };
  const catalog: TerminalRepositoryCatalogGateway = {
    resolveRepository: vi.fn(async () => ({
      id: 41,
      fullName: "acme/widget",
      defaultBranch: "main",
      baseSha: input?.baseSha ?? "a".repeat(40),
      private: true,
    })),
  };
  const payloadPut = vi.fn(async () => undefined);
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: payloadPut }),
  });
  const context: HarnessToolContext = {
    workspaceId: W,
    workstreamId: S,
    harnessRunId: R,
    toolCallId: "checkout-call",
    executionPrincipal: { type: "user", userId: U },
    signal: new AbortController().signal,
  };
  return {
    database,
    env,
    provider,
    payloadPut,
    context,
    catalog,
    selector: createTerminalRepositorySelector(
      env,
      provider,
      catalog,
      new TerminalSandboxCoordinator(env.DB, provider),
    ),
  };
}

describe("Terminal model repository selection", () => {
  it("prefers read-only remote authority while keeping local edits available and backs up before replacement", async () => {
    const { database, provider, payloadPut, context, selector } = await fixture();
    database.prepare(
      `INSERT INTO workstream_sandboxes
       (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_activity_at,
        created_at, updated_at)
       VALUES (?, ?, 'running', 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?)`,
    ).run(W, S, "2026-08-13", "2026-08-13", "2026-08-13");

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).resolves.toMatchObject({
      repository: "acme/widget",
      connectionId: PERSONAL,
      remoteAccess: "read_only",
      localEditsAllowed: true,
      remoteWritesAllowed: false,
      headRef: "avalon/bright-coastal-exact-heron",
      outcome: "selected",
      backup: { title: "Terminal backup before acme/widget", sizeBytes: 12 },
    });
    expect(payloadPut).toHaveBeenCalledOnce();
    const archiveCommand = vi.mocked(provider.runCommand).mock.calls.find(([, command]) => (
      command.taskName.includes("workspace-backup") && !command.taskName.includes("cleanup")
    ))?.[1].command;
    expect(archiveCommand).toContain("--exclude='*/.git'");
    expect(archiveCommand).toContain("--exclude='*/node_modules'");
    expect(provider.runCommand).toHaveBeenCalledBefore(vi.mocked(provider.deleteSandbox));
    expect(provider.deleteSandbox).toHaveBeenCalledWith("provider-1");
    expect(database.prepare(
      "SELECT connection_id, repository_full_name FROM workstream_terminal_repositories WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ connection_id: PERSONAL, repository_full_name: "acme/widget" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_resources WHERE workstream_id = ?",
    ).get(S)).toEqual({ count: 1 });
  });

  it("selects full remote authority only when the model explicitly requires it", async () => {
    const { context, selector } = await fixture();
    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "full_access",
    })).resolves.toMatchObject({
      connectionId: WORKSPACE,
      remoteAccess: "full_access",
      localEditsAllowed: true,
      remoteWritesAllowed: true,
      headRef: "avalon/bright-coastal-exact-heron",
      backup: null,
    });
  });

  it("reuses the shared four-word Avalon naming scheme when no work-stream address exists", async () => {
    const { context, selector } = await fixture({ emailAddress: null });

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).resolves.toMatchObject({
      headRef: expect.stringMatching(/^avalon\/[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u),
    });
  });

  it("tries recoverable connector states and skips only disabled connections", async () => {
    const { database, context, selector, catalog } = await fixture();
    database.prepare("UPDATE connector_connections SET status = 'needs_reconnect' WHERE id = ?")
      .run(PERSONAL);
    database.prepare("UPDATE connector_connections SET status = 'disabled' WHERE id = ?")
      .run(WORKSPACE);

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).resolves.toMatchObject({ connectionId: PERSONAL, remoteAccess: "read_only" });
    expect(catalog.resolveRepository).toHaveBeenCalledOnce();
    expect(catalog.resolveRepository).toHaveBeenCalledWith(
      PERSONAL,
      W,
      "acme/widget",
      context.signal,
    );
  });

  it("refreshes an existing repository selection when its default branch advances", async () => {
    const nextBase = "b".repeat(40);
    const { database, context, selector } = await fixture({ baseSha: nextBase });
    database.prepare(
      `INSERT INTO workstream_terminal_repositories
       (workspace_id, workstream_id, connection_id, repository_id, repository_full_name,
        base_ref, base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 41, 'acme/widget', 'main', ?, ?, 'selected', ?, ?, ?)`,
    ).run(
      W,
      S,
      PERSONAL,
      "a".repeat(40),
      "avalon/bright-coastal-exact-heron",
      U,
      "2026-08-13",
      "2026-08-13",
    );

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).resolves.toMatchObject({
      outcome: "selected",
      baseSha: nextBase,
      headRef: "avalon/bright-coastal-exact-heron",
    });
    expect(database.prepare(
      "SELECT base_sha FROM workstream_terminal_repositories WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ base_sha: nextBase });
  });

  it("claims the shared sandbox lease before replacing repository state", async () => {
    const { database, provider, context, selector } = await fixture();
    const otherRun = "71000000-0000-4000-8000-000000000099";
    database.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
       VALUES (?, ?, ?, 'manual', ?, 'running', ?)`,
    ).run(otherRun, W, S, JSON.stringify({ type: "user", userId: U }), "2026-08-13");
    database.prepare(
      `INSERT INTO workstream_sandboxes
       (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, operation_run_id,
        operation_lease_expires_at, last_activity_at, created_at, updated_at)
       VALUES (?, ?, 'running', 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?, ?, ?)`,
    ).run(
      W,
      S,
      otherRun,
      "2099-01-01T00:00:00.000Z",
      "2026-08-13",
      "2026-08-13",
      "2026-08-13",
    );

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).rejects.toMatchObject({ code: "sandbox_busy" });
    expect(provider.startSandbox).not.toHaveBeenCalled();
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
  });

  it.each(["stopped", "archived"] as const)(
    "restores a %s sandbox when backup fails after temporary startup",
    async (state) => {
      const { database, provider, context, selector } = await fixture();
      database.prepare(
        `INSERT INTO workstream_sandboxes
         (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
          authority_fingerprint, applied_network_revision, version, last_activity_at,
          created_at, updated_at)
         VALUES (?, ?, ?, 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?)`,
      ).run(W, S, state, "2026-08-13", "2026-08-13", "2026-08-13");
      vi.mocked(provider.runCommand).mockRejectedValueOnce(new Error("R2 backup failed"));

      await expect(selector.checkout(context, {
        repositoryFullName: "acme/widget",
        requiredRemoteAccess: "read_only",
      })).rejects.toThrow("R2 backup failed");
      expect(provider.startSandbox).toHaveBeenCalledWith("provider-1");
      expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
      if (state === "archived") expect(provider.archiveSandbox).toHaveBeenCalledWith("provider-1");
      else expect(provider.archiveSandbox).not.toHaveBeenCalled();
      expect(provider.deleteSandbox).not.toHaveBeenCalled();
    },
  );

  it("fails closed without deleting the sandbox when the harness backup exceeds its limit", async () => {
    const { database, provider, context, selector } = await fixture({ backupResult: "TOO_LARGE 60000000\n" });
    database.prepare(
      `INSERT INTO workstream_sandboxes
       (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_activity_at,
        created_at, updated_at)
       VALUES (?, ?, 'running', 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?)`,
    ).run(W, S, "2026-08-13", "2026-08-13", "2026-08-13");

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).rejects.toMatchObject({ code: "workspace_backup_too_large" });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT provider_sandbox_id FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ provider_sandbox_id: "provider-1" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_terminal_repositories WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ count: 0 });
  });

  it("revalidates a personal GitHub user's current repository visibility before App checkout", async () => {
    const { database } = await fixture();
    const credentialKey = "terminal-personal-github-test-key";
    const encrypted = await encryptString(JSON.stringify({
      installationId: "42",
      accessToken: "personal-user-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }), credentialKey, PERSONAL);
    database.prepare(
      `UPDATE connector_connections
          SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = 1
        WHERE id = ?`,
    ).run(encrypted.ciphertext, encrypted.iv, PERSONAL);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe("/user/installations/42/repositories");
      return new Response(JSON.stringify({ total_count: 0, repositories: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.test",
      CONNECTOR_CREDENTIALS_KEY: credentialKey,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      GITHUB_APP_ID: "1",
      GITHUB_APP_CLIENT_ID: "Iv1.test",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nunused-test-key\n-----END PRIVATE KEY-----",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
    });

    await expect(createGitHubTerminalCatalogGateway(env).resolveRepository(
      PERSONAL,
      W,
      "acme/widget",
      new AbortController().signal,
    )).rejects.toMatchObject({ status: 422, code: "github_repository_unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
