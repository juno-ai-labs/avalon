import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { TerminalSettingsService } from "../src/services/terminal/settings";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "50000000-0000-4000-8000-000000000001";
const S = "50000000-0000-4000-8000-000000000002";
const U = "50000000-0000-4000-8000-000000000003";
const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture(role: AuthContext["role"] = "owner") {
  const database = migratedSqliteDatabase(); databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'settings-user', 'settings@example.com', 'Settings', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Settings', 'terminal-settings', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Settings', 'Settings', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO workstream_sandboxes
      (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
       authority_fingerprint, applied_network_revision, version, last_activity_at,
       warm_stop_due_at, archive_due_at, expire_due_at, created_at, updated_at)
    VALUES ('${W}', '${S}', 'running', 'settings-sandbox', 'provider-1', 1,
            'authority', 1, 1, '2026-08-13', '2026-08-13', '2026-08-13', '2026-09-12', '2026-08-13', '2026-08-13');
  `);
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", TERMINAL_REGION_CAPABILITY: "supported",
    DAYTONA_API_KEY: "key", DAYTONA_API_URL: "https://app.daytona.io/api", DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "snapshot", TERMINAL_EMERGENCY_DISABLED: "false",
  });
  let appliedDomains: string[] = [];
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(async () => ({ id: "provider-1", name: "settings-sandbox", state: "stopped" as const, domainAllowList: appliedDomains })),
    startSandbox: vi.fn(), stopSandbox: vi.fn(async () => undefined), archiveSandbox: vi.fn(), deleteSandbox: vi.fn(),
    updateNetworkPolicy: vi.fn(async (_id, domains) => { appliedDomains = domains ?? []; }), configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(),
    readFile: vi.fn(), writeFile: vi.fn(), runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), publishGitBundle: vi.fn(),
  };
  const auth: AuthContext = { sessionId: "session", userId: U, workspaceId: W, region: "global", role };
  return { database, env, provider, service: new TerminalSettingsService(env, auth, provider) };
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
    const { database, provider, service } = fixture();
    const preview = await service.preview({ expectedRevision: 1, mode: "trusted_only", customDomains: ["custom.example"] });
    expect(preview).toMatchObject({ affectedWorkstreamIds: [S], customDomains: ["custom.example"], remainingCustomSlots: 6 });
    expect(preview).not.toHaveProperty("effectiveDomains");

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true })).resolves.toMatchObject({
      revision: 2, verificationState: "verified", customDomains: ["custom.example"], remainingCustomSlots: 6,
    });
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
    expect(provider.updateNetworkPolicy).toHaveBeenCalledWith("provider-1", expect.arrayContaining(["custom.example"]));
    expect(provider.startSandbox).not.toHaveBeenCalled();
    expect(database.prepare("SELECT state, applied_network_revision FROM workstream_sandboxes WHERE workspace_id = ?").get(W))
      .toEqual({ state: "stopped", applied_network_revision: 2 });
  });

  it("does not mark a sandbox created after the policy claim as verified", async () => {
    const { database, provider, service } = fixture();
    const lateWorkstream = "50000000-0000-4000-8000-000000000098";
    vi.mocked(provider.stopSandbox).mockImplementationOnce(async () => {
      database.exec(`
        INSERT INTO workstreams
          (id, workspace_id, title, objective, origin_type, created_by_user_id,
           harness_status, last_activity_at, created_at, updated_at)
        VALUES ('${lateWorkstream}', '${W}', 'Late sandbox', 'Late', 'ad_hoc', '${U}', 'idle',
                '2026-08-13', '2026-08-13', '2026-08-13');
        INSERT INTO workstream_sandboxes
          (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
           authority_fingerprint, applied_network_revision, version, last_activity_at,
           warm_stop_due_at, archive_due_at, expire_due_at, created_at, updated_at)
        VALUES ('${W}', '${lateWorkstream}', 'stopped', 'late-sandbox', 'provider-late', 1,
                'authority', 1, 1, '2026-08-13', NULL, NULL, '2026-09-12', '2026-08-13', '2026-08-13');
      `);
    });
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2, verificationState: "verified" });
    expect(database.prepare(
      "SELECT state, applied_network_revision FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, lateWorkstream)).toEqual({ state: "stopped", applied_network_revision: 1 });
  });

  it("does not mutate a replacement generation created while the old sandbox stops", async () => {
    const { database, provider, service } = fixture();
    vi.mocked(provider.stopSandbox).mockImplementationOnce(async () => {
      database.prepare(
        `UPDATE workstream_sandboxes
            SET generation = 2, provider_sandbox_id = 'provider-replacement', state = 'running', version = version + 1
          WHERE workspace_id = ? AND workstream_id = ?`,
      ).run(W, S);
    });
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2, verificationState: "verified" });
    expect(database.prepare(
      "SELECT generation, provider_sandbox_id, state, applied_network_revision FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({
      generation: 2,
      provider_sandbox_id: "provider-replacement",
      state: "running",
      applied_network_revision: 1,
    });
  });

  it("keeps failed sandboxes out of both preview and apply", async () => {
    const { database, provider, service } = fixture();
    database.prepare(
      "UPDATE workstream_sandboxes SET state = 'failed' WHERE workspace_id = ? AND workstream_id = ?",
    ).run(W, S);
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });
    expect(preview.affectedWorkstreamIds).toEqual([]);

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2, verificationState: "verified" });
    expect(provider.stopSandbox).not.toHaveBeenCalled();
    expect(provider.updateNetworkPolicy).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT state, applied_network_revision FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, S)).toEqual({ state: "failed", applied_network_revision: 1 });
  });

  it("rejects members and stale revisions with recovery guidance", async () => {
    await expect(fixture("member").service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] }))
      .rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
    const owner = fixture();
    await expect(owner.service.preview({ expectedRevision: 99, mode: "full_internet", customDomains: [] }))
      .rejects.toMatchObject({ status: 409, code: "terminal_policy_revision_conflict", message: expect.stringContaining("reload") });
  });

  it("stops every affected sandbox even when the first provider stop fails", async () => {
    const { database, provider, service } = fixture();
    const second = "50000000-0000-4000-8000-000000000099";
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('${second}', '${W}', 'Second sandbox', 'Second', 'ad_hoc', '${U}', 'idle',
              '2026-08-13', '2026-08-13', '2026-08-13');
      INSERT INTO workstream_sandboxes
        (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
         authority_fingerprint, applied_network_revision, version, last_activity_at,
         warm_stop_due_at, archive_due_at, expire_due_at, created_at, updated_at)
      VALUES ('${W}', '${second}', 'running', 'settings-sandbox-two', 'provider-2', 1,
              'authority', 1, 1, '2026-08-13', '2026-08-13', '2026-08-13', '2026-09-12', '2026-08-13', '2026-08-13');
    `);
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(new Error("first stop failed"));
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .rejects.toMatchObject({ status: 502, code: "terminal_policy_verification_failed" });
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-2");
    expect(database.prepare(
      "SELECT state FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).get(W, second)).toEqual({ state: "stopped" });
    expect(database.prepare(
      "SELECT mode, revision, verification_state FROM workspace_sandbox_network_policies WHERE workspace_id = ?",
    ).get(W)).toEqual({ mode: "trusted_only", revision: 1, verification_state: "verified" });
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
