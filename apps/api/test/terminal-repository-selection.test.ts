import { asUserId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptString, sha256Hex } from "../src/lib/crypto";
import { TerminalSandboxCoordinator } from "../src/services/terminal/coordinator";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { TERMINAL_REPOSITORY_PREPARATION_BUDGET_MS } from "../src/services/terminal/contract";
import { createTerminalRepositorySelector } from "../src/services/terminal/repository-selection";
import {
  createTerminalFinalDiffPreserver,
  createTerminalWorkspaceBackup,
} from "../src/services/terminal/lifecycle";
import {
  createGitHubTerminalCatalogGateway,
  type TerminalRepositoryCatalogGateway,
} from "../src/services/terminal/workstream-state";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import type { WorkstreamRuntimeResourceAttachment } from "../src/services/workstream-object-client";
import type { DatabaseSync } from "node:sqlite";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
  testResourcePortFactory,
  testTerminalPortFactory,
  seedWorkstreamObjectParticipant,
  applyWorkstreamObjectRootFields,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "71000000-0000-4000-8000-000000000001";
const S = "71000000-0000-4000-8000-000000000002";
const U = asUserId("71000000-0000-4000-8000-000000000003");
const R = "71000000-0000-4000-8000-000000000004";
const PERSONAL = "71000000-0000-4000-8000-000000000005";
const WORKSPACE = "71000000-0000-4000-8000-000000000006";
const databases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
const objectDatabases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
  for (const database of objectDatabases.splice(0)) database.close();
});

async function fixture(input?: {
  backupResult?: string;
  baseSha?: string;
  emailAddress?: string | null;
  residentResourceAttacher?: boolean;
}) {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // This focused selector fixture still forwards workspace resource SQL to
  // its pre-cutover D1 snapshot. Give that compatibility table the column the
  // WorkspaceDO migration adds in production.
  database.exec(
    `ALTER TABLE resource_object_deletion_outbox
       ADD COLUMN cleanup_eligible INTEGER NOT NULL DEFAULT 1
       CHECK (cleanup_eligible IN (0, 1))`,
  );
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
  // The routed statements read work-stream product state (the branch name
  // comes from the work stream's email address) and the run rows from the
  // object, so the fixture opens the authority and seeds the object the way
  // the cutover left production.
  openWorkstreamAuthorityForTest(database);
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
  `);
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  const recordRuntimeResourceAttachment = (request: WorkstreamRuntimeResourceAttachment): void => {
    objectStore.prepare(
      `INSERT OR IGNORE INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type,
          resource_json, attached_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?)`,
    ).run(
      request.resourceId,
      request.attachedByUserId,
      request.relationshipType ?? "generated",
      JSON.stringify({ id: request.resourceId }),
      Date.parse("2026-08-13T12:00:00.000Z"),
      Date.parse("2026-08-13T12:00:00.000Z"),
    );
  };
  const residentResourceAttacher = vi.fn(async (request: WorkstreamRuntimeResourceAttachment) => {
    recordRuntimeResourceAttachment(request);
  });
  applyWorkstreamObjectRootFields(objectStore, {
    title: "Repo",
    description: "Repo",
    originType: "ad_hoc",
    createdByUserId: U,
    exactState: "running",
    emailAddress: input?.emailAddress === null
      ? null
      : input?.emailAddress ?? "bright-coastal-exact-heron@automation.with-avalon.com",
  }, Date.parse("2026-08-13T00:00:00.000Z"));
  seedWorkstreamObjectParticipant(objectStore, {
    userId: U,
    participationReason: "creator",
    addedAt: Date.parse("2026-08-13T00:00:00.000Z"),
  });
  seedWorkstreamRun(objectStore, { id: R, origin: "manual",
    executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
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
    recoverSandbox: vi.fn(async () => undefined),
    startSandbox: vi.fn(async () => undefined),
    stopSandbox: vi.fn(),
    archiveSandbox: vi.fn(),
    deleteSandbox: vi.fn(async () => undefined),
    updateNetworkPolicy: vi.fn(),
    configureGitHubReadAccess: vi.fn(),
    clearGitHubReadAccess: vi.fn(async () => undefined),
    readFile: vi.fn(async () => backupBytes),
    writeFile: vi.fn(),
    runUtilityCommand: vi.fn(),
    runCommand: vi.fn(async (_sandbox, command) => ({
      exitCode: 0,
      stdout: command.taskName.includes("cleanup")
        ? ""
        : input?.backupResult ?? `READY ${backupBytes.byteLength} ${backupSha}\n`,
      stderr: "",
    })),
  };
  const utilityImplementation = vi.mocked(provider.runCommand).getMockImplementation()!;
  provider.runUtilityCommand = vi.fn((id, command) => utilityImplementation(id, {
    ...command,
    taskName: command.operation === "lifecycle.backup_cleanup" ? "cleanup" : "terminal-utility",
  }));
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
  // Wrapped the way the harness wraps its execution environment, so the
  // routed DB carries object statements to the store while
  // `regionalDatabase(env)` still reaches the raw regional binding. That is
  // an intentional guard: an accidental escape from the routed `env.DB`
  // reaches the retired schema and fails this fixture.
  const baseEnv = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: payloadPut }),
    // Backup uploads attach their resource through the object's RPC surface;
    // the stub records the link the way the AgentLoopDO's product does.
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore, {
      extra: {
        attachRuntimeResource: vi.fn((request: WorkstreamRuntimeResourceAttachment) => {
          recordRuntimeResourceAttachment(request);
          return { status: 200, bodyJson: JSON.stringify({ ok: true }) };
        }),
      },
    }),
    // The coordinator asks the object for the workspace's network policy.
    WORKSPACE_DOS: testWorkspaceObjectBinding(createTestWorkspaceDO({
      workspaceId: W,
      regionalDatabase: database,
      register: (created) => { objectDatabases.push(created); },
    }).instance, ["terminalNetworkSettings"]),
  });
  const env = baseEnv;
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
    objectStore,
    env,
    provider,
    payloadPut,
    context,
    catalog,
    residentResourceAttacher,
    selector: createTerminalRepositorySelector(
      env,
      provider,
      catalog,
      new TerminalSandboxCoordinator(
        env,
        testTerminalPortFactory(objectStore),
        testResourcePortFactory(objectStore),
        provider,
      ),
      testTerminalPortFactory(objectStore),
      input?.residentResourceAttacher ? residentResourceAttacher : undefined,
    ),
  };
}

/**
 * The `metadata_json` a lifecycle capture bound into its `INSERT INTO resources`.
 *
 * Found by shape rather than by position: both captures bind their metadata as
 * the one parameter that parses to an object carrying `source`, and an index
 * would silently follow the wrong column the next time either statement gains one.
 */
function insertedResourceMetadata(
  inserts: ReadonlyArray<ReadonlyArray<string | number | null>>,
): Record<string, unknown> {
  const found = inserts.flat().flatMap((value) => {
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && "source" in (parsed as Record<string, unknown>)
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("Terminal model repository selection", () => {
  it("keeps final-diff preservation ownership in WorkspaceDO after D1 retirement", async () => {
    const regional = preRetirementProductSqliteDatabase();
    databases.push(regional);
    regional.exec("DROP TABLE resource_object_deletion_outbox");

    const objectStore = testWorkstreamObjectStore();
    databases.push(objectStore);
    const payloadPut = vi.fn(async () => undefined);
    const attachRuntimeResource = vi.fn(() => ({ status: 200, bodyJson: JSON.stringify({ ok: true }) }));
    const runtimeStatements: string[] = [];
    const resourceInserts: Array<Array<string | number | null>> = [];
    const workstreamEnv = createTestEnv({
        DB: sqliteD1(regional),
        AVALON_REGION: "global",
        PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: payloadPut }),
        SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore, { extra: { attachRuntimeResource } }),
      });
    const env = withWorkspaceRuntimeDatabase(workstreamEnv, W, async (statements) => {
      runtimeStatements.push(...statements.map(({ sql }) => sql));
      for (const statement of statements) {
        if (statement.sql.includes("INSERT INTO resources")) resourceInserts.push([...statement.params]);
      }
      return statements.map(() => ({ columns: [], rows: [], changes: 1 }));
    });
    const provider = {
      runUtilityCommand: vi.fn(async () => ({
        exitCode: 0,
        stdout: "diff --git a/file.txt b/file.txt\n+preserved\n",
        stderr: "",
      })),
    } satisfies Pick<TerminalSandboxProvider, "runUtilityCommand">;

    await expect(
      createTerminalFinalDiffPreserver(env, provider, W, S)("provider-1", 1),
    ).resolves.toBeUndefined();

    expect(runtimeStatements.some((sql) => sql.includes("INSERT OR IGNORE INTO resource_object_deletion_outbox")))
      .toBe(true);
    expect(runtimeStatements.some((sql) => sql.includes("INSERT INTO resources"))).toBe(true);
    expect(payloadPut).toHaveBeenCalledOnce();
    expect(attachRuntimeResource).toHaveBeenCalledOnce();
    // The contrast that gives the backup's flag its meaning: a preserved diff is
    // what the work produced, so it stays in the artifacts rail.
    expect(insertedResourceMetadata(resourceInserts)).not.toHaveProperty("listing");
  });

  it("keeps repository-replacement backup ownership in WorkspaceDO after D1 retirement", async () => {
    const regional = preRetirementProductSqliteDatabase();
    databases.push(regional);
    regional.exec("DROP TABLE resource_object_deletion_outbox");

    const backupBytes = new TextEncoder().encode("workspace-backup");
    const backupSha = await sha256Hex(backupBytes);
    const payloadPut = vi.fn(async () => undefined);
    const runtimeStatements: string[] = [];
    const resourceInserts: Array<Array<string | number | null>> = [];
    const workstreamEnv = createTestEnv({
        DB: sqliteD1(regional),
        AVALON_REGION: "global",
        PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: payloadPut }),
      });
    const env = withWorkspaceRuntimeDatabase(workstreamEnv, W, async (statements) => {
      runtimeStatements.push(...statements.map(({ sql }) => sql));
      for (const statement of statements) {
        if (statement.sql.includes("INSERT INTO resources")) resourceInserts.push([...statement.params]);
      }
      return statements.map(() => ({ columns: [], rows: [], changes: 1 }));
    });
    const provider = {
      readFile: vi.fn(async () => backupBytes),
      runUtilityCommand: vi.fn(async (_sandboxId: string, command: { operation: string }) => ({
        exitCode: 0,
        stdout: command.operation === "lifecycle.backup_cleanup"
          ? ""
          : `READY ${backupBytes.byteLength} ${backupSha}\n`,
        stderr: "",
      })),
    } satisfies Pick<TerminalSandboxProvider, "readFile" | "runUtilityCommand">;
    const attach = vi.fn(async () => undefined);

    await expect(createTerminalWorkspaceBackup(env, provider, {
      workspaceId: W,
      workstreamId: S,
      toolCallId: "post-d1-retirement-backup",
      repositoryFullName: "acme/widget",
      providerSandboxId: "provider-1",
      generation: 1,
      signal: new AbortController().signal,
    }, attach)).resolves.toMatchObject({
      title: "Terminal backup before acme/widget",
      sizeBytes: backupBytes.byteLength,
      sourceSha256: backupSha,
    });

    expect(runtimeStatements.some((sql) => sql.includes("INSERT OR IGNORE INTO resource_object_deletion_outbox")))
      .toBe(true);
    expect(runtimeStatements.some((sql) => sql.includes("INSERT INTO resources"))).toBe(true);
    expect(payloadPut).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledOnce();
    // Attached, so the receipt's resource id still opens and imports it, and
    // unlisted, so no rail or model inventory advertises the archive.
    expect(insertedResourceMetadata(resourceInserts)).toMatchObject({
      source: "terminal_repository_replacement",
      listing: "unlisted",
    });
  });

  it("prefers read-only remote authority while keeping local edits available and backs up before replacement", async () => {
    const {
      objectStore,
      provider,
      payloadPut,
      context,
      selector,
      residentResourceAttacher,
    } = await fixture({ residentResourceAttacher: true });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_workspace
       (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_command_at,
        created_at, updated_at)
       VALUES (1, 'daytona', 'running', 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?)`,
      Date.parse("2026-08-13T00:00:00.000Z"), Date.parse("2026-08-13T00:00:00.000Z"), Date.parse("2026-08-13T00:00:00.000Z"),
    );

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
    expect(residentResourceAttacher).toHaveBeenCalledOnce();
    const archiveCommand = vi.mocked(provider.runUtilityCommand).mock.calls.find(([, command]) => (
      command.operation === "lifecycle.backup"
    ))?.[1].command;
    expect(archiveCommand).toContain("git bundle create");
    expect(archiveCommand).toContain("--exclude='*/.git'");
    expect(archiveCommand).toContain("--exclude='*/node_modules'");
    expect(provider.runUtilityCommand).toHaveBeenCalledBefore(vi.mocked(provider.deleteSandbox));
    expect(provider.deleteSandbox).toHaveBeenCalledWith("provider-1");
    expect(workstreamObjectGet(
      objectStore,
      "SELECT connection_id, repository_full_name FROM terminal_repository WHERE id = 1",
    )).toEqual({ connection_id: PERSONAL, repository_full_name: "acme/widget" });
    expect(objectStore.prepare(
      "SELECT COUNT(*) AS count FROM workstream_resource_links",
    ).get()).toEqual({ count: 1 });
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

  it("treats a read-only request as a durable ceiling even when the policy allows full access", async () => {
    const { database, objectStore, context, selector } = await fixture();
    database.prepare("UPDATE connector_connections SET status = 'disabled' WHERE id = ?")
      .run(PERSONAL);

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).resolves.toMatchObject({
      connectionId: WORKSPACE,
      remoteAccess: "read_only",
      remoteWritesAllowed: false,
    });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT remote_access FROM terminal_repository WHERE id = 1",
    )).toEqual({ remote_access: "read_only" });
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
    const { objectStore, context, selector } = await fixture({ baseSha: nextBase });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_repository
       (id, connection_id, repository_id, repository_full_name,
        base_ref, base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
       VALUES (1, ?, 41, 'acme/widget', 'main', ?, ?, 'selected', ?, ?, ?)`,
      PERSONAL,
      "a".repeat(40),
      "avalon/bright-coastal-exact-heron",
      U,
      Date.parse("2026-08-13T00:00:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
    );

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).resolves.toMatchObject({
      outcome: "selected",
      baseSha: nextBase,
      headRef: "avalon/bright-coastal-exact-heron",
    });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT base_sha FROM terminal_repository WHERE id = 1",
    )).toEqual({ base_sha: nextBase });
  });

  it("claims the shared sandbox lease before replacing repository state", async () => {
    const { objectStore, provider, context, selector } = await fixture();
    const otherRun = "71000000-0000-4000-8000-000000000099";
    // Admitted rather than running: the object allows one executing receipt
    // per substream and the fixture's own run holds that slot; the lease check
    // counts an admitted receipt as active all the same.
    seedWorkstreamRun(objectStore, { id: otherRun, status: "admitted", origin: "manual",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: U }) });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_workspace
       (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, operation_run_id,
        operation_lease_expires_at, last_command_at, created_at, updated_at)
       VALUES (1, 'daytona', 'running', 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?, ?, ?)`,
      otherRun,
      Date.parse("2099-01-01T00:00:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
      Date.parse("2026-08-13T00:00:00.000Z"),
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
      const { objectStore, provider, context, selector } = await fixture();
      workstreamObjectRun(
        objectStore,
        `INSERT INTO terminal_workspace
         (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
          authority_fingerprint, applied_network_revision, version, last_command_at,
          created_at, updated_at)
         VALUES (1, 'daytona', ?, 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?)`,
        state, Date.parse("2026-08-13T00:00:00.000Z"), Date.parse("2026-08-13T00:00:00.000Z"), Date.parse("2026-08-13T00:00:00.000Z"),
      );
      vi.mocked(provider.runUtilityCommand).mockRejectedValueOnce(new Error("R2 backup failed"));

      await expect(selector.checkout(context, {
        repositoryFullName: "acme/widget",
        requiredRemoteAccess: "read_only",
      })).rejects.toThrow("R2 backup failed");
      // Checkout restores outside `acquire`, so it carries the preparation
      // budget's own deadline. Unbudgeted it would fall to the Daytona SDK's
      // 60s default and keep feeding censored samples into the same
      // `sandbox_start`/`archived` analytics bucket as the budgeted restores.
      expect(provider.startSandbox).toHaveBeenCalledWith("provider-1", {
        deadlineAtMs: expect.any(Number),
      });
      expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
      if (state === "archived") expect(provider.archiveSandbox).toHaveBeenCalledWith("provider-1");
      else expect(provider.archiveSandbox).not.toHaveBeenCalled();
      expect(provider.deleteSandbox).not.toHaveBeenCalled();
    },
  );

  it("bounds the checkout restore by the repository-preparation budget", async () => {
    const { objectStore, provider, context, selector } = await fixture();
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_workspace
       (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_command_at,
        created_at, updated_at)
       VALUES (1, 'daytona', 'archived', 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?)`,
      Date.parse("2026-08-13T00:00:00.000Z"), Date.parse("2026-08-13T00:00:00.000Z"), Date.parse("2026-08-13T00:00:00.000Z"),
    );
    const preparationStartedAt = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(preparationStartedAt);
    vi.mocked(provider.runUtilityCommand).mockRejectedValueOnce(new Error("R2 backup failed"));

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).rejects.toThrow("R2 backup failed");

    expect(provider.startSandbox).toHaveBeenCalledWith("provider-1", {
      deadlineAtMs: preparationStartedAt + TERMINAL_REPOSITORY_PREPARATION_BUDGET_MS,
    });
  });

  it("fails closed without deleting the sandbox when the harness backup exceeds its limit", async () => {
    const { objectStore, provider, context, selector } = await fixture({ backupResult: "TOO_LARGE 60000000\n" });
    workstreamObjectRun(
      objectStore,
      `INSERT INTO terminal_workspace
       (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, last_command_at,
        created_at, updated_at)
       VALUES (1, 'daytona', 'running', 'repo-sandbox', 'provider-1', 1, 'authority', 1, 1, ?, ?, ?)`,
      Date.parse("2026-08-13T00:00:00.000Z"), Date.parse("2026-08-13T00:00:00.000Z"), Date.parse("2026-08-13T00:00:00.000Z"),
    );

    await expect(selector.checkout(context, {
      repositoryFullName: "acme/widget",
      requiredRemoteAccess: "read_only",
    })).rejects.toMatchObject({ code: "workspace_backup_too_large" });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT sandbox_id FROM terminal_workspace WHERE id = 1",
    )).toEqual({ sandbox_id: "provider-1" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT COUNT(*) AS count FROM terminal_repository",
    )).toEqual({ count: 0 });
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
