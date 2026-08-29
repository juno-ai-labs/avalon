import { asUserId } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { TerminalSettingsService } from "../src/services/terminal/settings";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamContract,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
} from "./helpers/durable-authority";
import {
  createTestWorkspaceDO,
  workspaceObjectRpcs,
} from "./helpers/workspace-object-rpcs";

const W = asWorkspaceId("50000000-0000-4000-8000-000000000001");
const S = "50000000-0000-4000-8000-000000000002";
const U = asUserId("50000000-0000-4000-8000-000000000003");
const databases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
const objectDatabases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const database of objectDatabases.splice(0)) database.close();
});

/** Opens a work stream's own object and drops the sandbox row into it. */
function seedSandboxObject(
  objectStores: Map<string, DatabaseSync>,
  workstreamId: string,
  sandbox: { state: string; stableName: string; providerSandboxId: string },
): DatabaseSync {
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId, workspaceId: W });
  objectStores.set(workstreamId, objectStore);
  workstreamObjectRun(
    objectStore,
    `INSERT INTO terminal_workspace
      (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
       authority_fingerprint, applied_network_revision, version, last_command_at,
       idle_expires_at, archive_due_at, expire_due_at, created_at, updated_at)
    VALUES (1, 'daytona', ?, ?, ?, 1, 'authority', 1, 1, ?, ?, ?, ?, ?, ?)`,
    sandbox.state, sandbox.stableName, sandbox.providerSandboxId,
    Date.parse("2026-08-13T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
    Date.parse("2026-09-12T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
  );
  return objectStore;
}

function fixture(role: AuthContext["role"] = "owner") {
  const database = preRetirementProductSqliteDatabase(); databases.push(database);
  // The settings service walks the directory and reaches each sandbox through
  // the work-stream object port once the authority is open — the D1 sandbox
  // copies were dropped by migration 0090.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'settings-user', 'settings@example.com', 'Settings', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Settings', 'terminal-settings', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'owner', 'active', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Settings', 'Settings', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
  `);
  const objectStores = new Map<string, DatabaseSync>();
  const objectStore = seedSandboxObject(objectStores, S, {
    state: "running", stableName: "settings-sandbox", providerSandboxId: "provider-1",
  });
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", TERMINAL_REGION_CAPABILITY: "supported",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    // The cross-workstream directory the settings walk lives in WorkspaceDO;
    // the stub serves it from the regional index the fixture seeds.
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        // The Terminal network policy is decided by a real WorkspaceDO over its
        // own schema, so these tests assert the object's revision fencing and
        // claim atomicity rather than a re-implementation of them.
        ...workspaceObjectRpcs(createTestWorkspaceDO({
          workspaceId: W,
          regionalDatabase: database,
          register: (created) => { objectDatabases.push(created); },
        }).instance, [
          "terminalNetworkSettings",
          "terminalNetworkMode",
          "recordTerminalPolicyPreview",
          "claimTerminalPolicyApplication",
          "failTerminalPolicyApplication",
          "commitTerminalPolicyApplication",
        ]),
        listWorkstreams: async () => {
          const rows = database.prepare(
            "SELECT id, title FROM workstreams WHERE workspace_id = ? ORDER BY id",
          ).all(W) as Array<{ id: string; title: string }>;
          return {
            items: rows.map((row) => testWorkstreamContract({
              id: row.id, workspaceId: W, title: row.title, harnessStatus: "idle",
            })),
            stateVersions: rows.map((row) => ({
              workstreamId: row.id,
              commonEventId: "00000000-0000-7000-8000-0000000000e1",
              viewerEventId: null,
              authorityGeneration: 1,
              commonWaterline: 1,
              viewerWaterline: 0,
            })),
            nextCursor: null,
            directoryWaterline: 0,
          };
        },
      },
    }),
    DAYTONA_API_KEY: "key", DAYTONA_API_URL: "https://app.daytona.io/api", DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "snapshot", TERMINAL_EMERGENCY_DISABLED: "false",
  });
  let appliedDomains: string[] = [];
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(async () => ({ id: "provider-1", name: "settings-sandbox", state: "stopped" as const, domainAllowList: appliedDomains })),
    startSandbox: vi.fn(), stopSandbox: vi.fn(async () => undefined), archiveSandbox: vi.fn(), deleteSandbox: vi.fn(),
    updateNetworkPolicy: vi.fn(async (_id, domains) => { appliedDomains = domains ?? []; }), configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(),
    readFile: vi.fn(), writeFile: vi.fn(), runUtilityCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
  const auth: AuthContext = { sessionId: "session", userId: U, workspaceId: W, region: "global", role };
  return {
    database,
    objectStore,
    objectStores,
    env,
    provider,
    service: new TerminalSettingsService(env, auth, provider),
  };
}

describe("Terminal workspace settings", () => {
  it("keeps the immutable baseline out of the participant response", async () => {
    const { service } = fixture();
    const settings = await service.get();
    expect(settings).toMatchObject({
      availability: "supported", mode: "trusted_only", revision: 1, verificationState: "verified",
      customDomains: [], remainingCustomSlots: 7,
    });
    expect(settings).not.toHaveProperty("baselineGroups");
    expect(settings).not.toHaveProperty("effectiveDomains");
  });

  it("previews before confirmation and reconciles active sandboxes without restarting", async () => {
    const { objectStore, provider, service } = fixture();
    const preview = await service.preview({ expectedRevision: 1, mode: "trusted_only", customDomains: ["custom.example"] });
    expect(preview).toMatchObject({ affectedWorkstreamIds: [S], customDomains: ["custom.example"], remainingCustomSlots: 6 });
    expect(preview).not.toHaveProperty("effectiveDomains");

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true })).resolves.toMatchObject({
      revision: 2, verificationState: "verified", customDomains: ["custom.example"], remainingCustomSlots: 6,
    });
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
    expect(provider.updateNetworkPolicy).toHaveBeenCalledWith("provider-1", expect.arrayContaining(["custom.example"]));
    expect(provider.startSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, applied_network_revision FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "stopped", applied_network_revision: 2 });
  });

  it("does not mark a sandbox created after the policy claim as verified", async () => {
    const { database, objectStores, provider, service } = fixture();
    const lateWorkstream = "50000000-0000-4000-8000-000000000098";
    vi.mocked(provider.stopSandbox).mockImplementationOnce(async () => {
      database.exec(`
        INSERT INTO workstreams
          (id, workspace_id, title, objective, origin_type, created_by_user_id,
           harness_status, last_activity_at, created_at, updated_at)
        VALUES ('${lateWorkstream}', '${W}', 'Late sandbox', 'Late', 'ad_hoc', '${U}', 'idle',
                '2026-08-13', '2026-08-13', '2026-08-13');
      `);
      seedSandboxObject(objectStores, lateWorkstream, {
        state: "stopped", stableName: "late-sandbox", providerSandboxId: "provider-late",
      });
    });
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2, verificationState: "verified" });
    expect(workstreamObjectGet(
      objectStores.get(lateWorkstream)!,
      "SELECT lifecycle_state, applied_network_revision FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "stopped", applied_network_revision: 1 });
  });

  it("does not mutate a replacement generation created while the old sandbox stops", async () => {
    const { objectStore, provider, service } = fixture();
    vi.mocked(provider.stopSandbox).mockImplementationOnce(async () => {
      workstreamObjectRun(
        objectStore,
        `UPDATE terminal_workspace
            SET generation = 2, sandbox_id = 'provider-replacement',
                lifecycle_state = 'running', version = version + 1
          WHERE id = 1`,
      );
    });
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2, verificationState: "verified" });
    expect(workstreamObjectGet(
      objectStore,
      "SELECT generation, sandbox_id, lifecycle_state, applied_network_revision FROM terminal_workspace WHERE id = 1",
    )).toEqual({
      generation: 2,
      sandbox_id: "provider-replacement",
      lifecycle_state: "running",
      applied_network_revision: 1,
    });
  });

  it("keeps failed sandboxes out of both preview and apply", async () => {
    const { objectStore, provider, service } = fixture();
    workstreamObjectRun(
      objectStore,
      "UPDATE terminal_workspace SET lifecycle_state = 'failed' WHERE id = 1",
    );
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });
    expect(preview.affectedWorkstreamIds).toEqual([]);

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2, verificationState: "verified" });
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(provider.updateNetworkPolicy).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, applied_network_revision FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "failed", applied_network_revision: 1 });
  });

  it("rejects members and stale revisions with recovery guidance", async () => {
    await expect(fixture("member").service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] }))
      .rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
    const owner = fixture();
    await expect(owner.service.preview({ expectedRevision: 99, mode: "full_internet", customDomains: [] }))
      .rejects.toMatchObject({ status: 409, code: "terminal_policy_revision_conflict", message: expect.stringContaining("reload") });
  });

  it("stops every affected sandbox even when the first provider stop fails", async () => {
    const { database, objectStores, provider, service } = fixture();
    const second = "50000000-0000-4000-8000-000000000099";
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('${second}', '${W}', 'Second sandbox', 'Second', 'ad_hoc', '${U}', 'idle',
              '2026-08-13', '2026-08-13', '2026-08-13');
    `);
    seedSandboxObject(objectStores, second, {
      state: "running", stableName: "settings-sandbox-two", providerSandboxId: "provider-2",
    });
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(new Error("first stop failed"));
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .rejects.toMatchObject({ status: 502, code: "terminal_policy_verification_failed" });
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-2");
    expect(workstreamObjectGet(
      objectStores.get(second)!,
      "SELECT lifecycle_state FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "stopped" });
    // The policy row is the object's, not the region's, so this reads what a
    // person would see: the failed application kept the last verified policy
    // and did not leave the workspace stuck in `pending`.
    expect(await service.get()).toMatchObject({
      mode: "trusted_only",
      revision: 1,
      verificationState: "verified",
      failureCode: "provider_policy_mismatch",
    });
  });

  it("reports a sandbox as quarantined when neither stop nor deletion is confirmed", async () => {
    const { provider, service } = fixture();
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(new Error("stop failed"));
    vi.mocked(provider.deleteSandbox).mockRejectedValueOnce(new Error("delete failed"));
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .rejects.toMatchObject({
        status: 502,
        code: "terminal_policy_verification_failed",
        details: {
          sandboxOutcomes: [{ workstreamId: S, title: "Settings", outcome: "quarantined" }],
        },
      });
  });
});
