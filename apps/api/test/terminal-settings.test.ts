import { asUserId } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { terminalSandboxStableName } from "../src/services/terminal/coordinator";
import { TerminalSettingsService } from "../src/services/terminal/settings";
import { TerminalProviderError } from "../src/services/terminal/provider-contract";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
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
  const routedStatements: string[] = [];
  const workspaceObject = createTestWorkspaceDO({
    workspaceId: W,
    regionalDatabase: database,
    register: (created) => { objectDatabases.push(created); },
  });
  const objectStores = new Map<string, DatabaseSync>();
  const objectStore = seedSandboxObject(objectStores, S, {
    state: "running", stableName: "settings-sandbox", providerSandboxId: "provider-1",
  });
  // A conversation whose sandbox exists but whose deadline projection has not
  // reached the parent yet: the parent's list is asynchronous to the sandbox.
  const unprojected = new Set<string>();
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", TERMINAL_REGION_CAPABILITY: "supported",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    // The cross-workstream directory the settings walk lives in WorkspaceDO;
    // the stub serves it from the regional index the fixture seeds.
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        // Which conversations of a work stream own a sandbox is the work
        // stream's parent's knowledge, hosted in this same object. The stub
        // answers from the conversation stores this fixture seeded: the main
        // one under the work stream's own id, a side thread under
        // `<workstreamId>:<substreamId>`.
        childTerminalDeadlines: async (input: { parentId: string }) => ({
          items: [...objectStores.keys()]
            .filter((key) => !unprojected.has(key)
              && (key === input.parentId || key.startsWith(`${input.parentId}:`)))
            .map((key) => ({
              substreamId: key === input.parentId ? "0" : key.slice(input.parentId.length + 1),
              nextTerminalActionAt: "2026-08-13T00:00:00.000Z",
            })),
        }),
        // The Terminal network policy is decided by a real WorkspaceDO over its
        // own schema, so these tests assert the object's revision fencing and
        // claim atomicity rather than a re-implementation of them.
        // `executeRuntimeSql` is served by the real object too, so the
        // statements this service's collaborators still route — the final-diff
        // preserver's `resources` and `resource_object_deletion_outbox` writes
        // — run against WorkspaceDO's own schema rather than the frozen
        // through-0089 stand-in, whose `resource_object_deletion_outbox` has
        // since lost a column the production table has.
        executeRuntimeSql: (input: { statements: Array<{ sql: string }> }) => {
          for (const statement of input.statements) routedStatements.push(statement.sql);
          return workspaceObject.instance.executeRuntimeSql(input as never);
        },
        ...workspaceObjectRpcs(workspaceObject.instance, [
          "terminalNetworkSettings",
          "terminalNetworkMode",
          "recordTerminalPolicyPreview",
          "claimTerminalPolicyApplication",
          "failTerminalPolicyApplication",
          "commitTerminalPolicyApplication",
        ]),
        terminalSandboxParents: async () => (database.prepare(
          "SELECT id, title FROM workstreams WHERE workspace_id = ? ORDER BY id",
        ).all(W) as Array<{ id: string; title: string }>)
          .map((row) => ({ workstreamId: row.id, title: row.title })),
      },
    }),
    // The final-diff preserver stages the diff in R2 before it writes the
    // resource row, so the bucket has to exist for that path to be reached.
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: async () => undefined }),
    DAYTONA_API_KEY: "key", DAYTONA_API_URL: "https://app.daytona.io/api", DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "snapshot", TERMINAL_EMERGENCY_DISABLED: "false",
  });
  let appliedDomains: string[] = [];
  // Daytona's own state per sandbox: running until stopped, unless a test says otherwise.
  const providerStates = new Map<string, "running" | "stopped" | "archived">();
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(),
    getSandbox: vi.fn(async (id: string) => ({ id, name: "settings-sandbox", state: providerStates.get(id) ?? "running", domainAllowList: appliedDomains })),
    recoverSandbox: vi.fn(async () => undefined),
    startSandbox: vi.fn(), stopSandbox: vi.fn(async (id: string) => { providerStates.set(id, "stopped"); }), archiveSandbox: vi.fn(), deleteSandbox: vi.fn(),
    updateNetworkPolicy: vi.fn(async (_id, domains) => { appliedDomains = domains ?? []; }), configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(),
    readFile: vi.fn(), writeFile: vi.fn(), runUtilityCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
  const auth: AuthContext = { sessionId: "session", userId: U, workspaceId: W, region: "global", role };
  return {
    database,
    objectStore,
    objectStores,
    unprojected,
    routedStatements,
    env,
    provider,
    providerStates,
    service: new TerminalSettingsService(env, auth, provider),
  };
}

describe("Terminal workspace settings", () => {
  it("keeps the immutable baseline out of the participant response", async () => {
    const { service } = fixture();
    const settings = await service.get();
    expect(settings).toMatchObject({
      availability: "supported", mode: "trusted_only", revision: 1, verificationState: "verified",
      customDomains: [], remainingCustomSlots: 5,
    });
    expect(settings).not.toHaveProperty("baselineGroups");
    expect(settings).not.toHaveProperty("effectiveDomains");
  });

  it("previews before confirmation and reconciles active sandboxes without restarting", async () => {
    const { objectStore, provider, service } = fixture();
    const preview = await service.preview({ expectedRevision: 1, mode: "trusted_only", customDomains: ["custom.example"] });
    expect(preview).toMatchObject({ customDomains: ["custom.example"], remainingCustomSlots: 4 });
    expect(preview).not.toHaveProperty("effectiveDomains");

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true })).resolves.toMatchObject({
      revision: 2, verificationState: "verified", customDomains: ["custom.example"], remainingCustomSlots: 4,
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

  it("keeps the final-diff preserver's writes routed to the object", async () => {
    // The service stopped wrapping its environment when its own statements
    // became typed methods — and `apply` still hands that environment to the
    // final-diff preserver, which writes `resources` and
    // `resource_object_deletion_outbox` through `env.DB`. Both are WorkspaceDO
    // tables that migration 0090 dropped from regional D1, so an unrouted
    // handle makes the first of them `no such table`: swallowed into
    // `failures`, surfacing as a 502 blaming the provider, with the policy
    // change unable to land while any sandbox holds a diff.
    //
    // The other cases cannot see it. Their `runUtilityCommand` returns empty
    // stdout, so the preserver returns before reaching any SQL. This one gives
    // it a diff, and asserts on where the statement went rather than on the
    // whole preserve path, which needs more of the runtime than this suite has.
    const { provider, service, routedStatements } = fixture();
    vi.mocked(provider.runUtilityCommand).mockResolvedValue({
      exitCode: 0,
      stdout: "diff --git a/a.txt b/a.txt\n+one\n",
      stderr: "",
    });
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });
    await service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true })
      .catch(() => undefined);

    expect(routedStatements.some((sql) => sql.includes("resource_object_deletion_outbox")))
      .toBe(true);
  });

  it("keeps the change and leaves a sandbox whose stop fails for its next claim", async () => {
    const { database, objectStore, objectStores, provider, service } = fixture();
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
    vi.mocked(provider.stopSandbox).mockRejectedValueOnce(
      new TerminalProviderError("Sandbox provider-1 is in state archiving", "DaytonaConflictError:409"),
    );
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ mode: "full_internet", revision: 2, verificationState: "verified" });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    // Revision 0: a run already holding it goes stale, and the next claim reapplies the policy.
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, sandbox_id, applied_network_revision, failure_code FROM terminal_workspace WHERE id = 1",
    )).toEqual({
      lifecycle_state: "running",
      sandbox_id: "provider-1",
      applied_network_revision: 0,
      failure_code: "policy_transition:stop:DaytonaConflictError:409",
    });
    expect(workstreamObjectGet(
      objectStores.get(second)!,
      "SELECT lifecycle_state, applied_network_revision, failure_code FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "stopped", applied_network_revision: 2, failure_code: null });
  });

  it("changes an archived sandbox's policy without stopping it", async () => {
    // Daytona refuses to stop an archived sandbox, and the stop failure used to
    // delete it: every idle sandbox in an organization went that way.
    const { objectStore, provider, providerStates, service } = fixture();
    workstreamObjectRun(objectStore, "UPDATE terminal_workspace SET lifecycle_state = 'archived' WHERE id = 1");
    providerStates.set("provider-1", "archived");
    vi.mocked(provider.stopSandbox).mockRejectedValue(new Error("sandbox is archived"));
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2, verificationState: "verified" });
    expect(provider.updateNetworkPolicy).toHaveBeenCalledWith("provider-1", null);
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(
      objectStore,
      "SELECT lifecycle_state, sandbox_id, applied_network_revision, failure_code FROM terminal_workspace WHERE id = 1",
    )).toEqual({ lifecycle_state: "archived", sandbox_id: "provider-1", applied_network_revision: 2, failure_code: null });
  });

  it("stops a sandbox Daytona reports running even when Rally's row says stopped", async () => {
    const { objectStore, provider, service } = fixture();
    workstreamObjectRun(objectStore, "UPDATE terminal_workspace SET lifecycle_state = 'stopped' WHERE id = 1");
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2 });
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, applied_network_revision FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "stopped", applied_network_revision: 2 });
  });

  it("records why a side thread's policy update failed on the side thread's own row", async () => {
    const { objectStore, objectStores, provider, service } = fixture();
    const thread = "00000000-0000-4000-8000-000000000077";
    const threadStore = seedSandboxObject(objectStores, `${S}:${thread}`, {
      state: "running", stableName: await terminalSandboxStableName(W, S, thread), providerSandboxId: "provider-2",
    });
    const applyPolicy = vi.mocked(provider.updateNetworkPolicy);
    const base = applyPolicy.getMockImplementation()!;
    applyPolicy.mockImplementation(async (id, domains) => {
      if (id === "provider-2") throw new Error("provider-2 unreachable");
      return base(id, domains);
    });
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });

    await expect(service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }))
      .resolves.toMatchObject({ revision: 2, verificationState: "verified" });
    expect(provider.deleteSandbox).not.toHaveBeenCalled();
    expect(workstreamObjectGet(threadStore, "SELECT lifecycle_state, sandbox_id, applied_network_revision, failure_code FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "stopped", sandbox_id: "provider-2", applied_network_revision: 0, failure_code: "policy_transition:policy:Error" });
    expect(workstreamObjectGet(objectStore, "SELECT lifecycle_state, applied_network_revision FROM terminal_workspace WHERE id = 1"))
      .toEqual({ lifecycle_state: "stopped", applied_network_revision: 2 });
  });

  it("reaches the main conversation's sandbox before its projection reaches the parent", async () => {
    const { objectStores, unprojected, provider, service } = fixture();
    const thread = "00000000-0000-4000-8000-000000000077";
    seedSandboxObject(objectStores, `${S}:${thread}`, {
      state: "running", stableName: await terminalSandboxStableName(W, S, thread), providerSandboxId: "provider-2",
    });
    unprojected.add(S);
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });
    await service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true });

    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-2");
  });

  it("leaves a row a side thread reserved under the main conversation's name to the main conversation", async () => {
    const { objectStores, provider, service } = fixture();
    const thread = "00000000-0000-4000-8000-000000000077";
    // Reserved before a sandbox belonged to a conversation: the work stream's
    // one name, and the main conversation's sandbox behind it.
    seedSandboxObject(objectStores, `${S}:${thread}`, {
      state: "running", stableName: await terminalSandboxStableName(W, S, "0"), providerSandboxId: "provider-1",
    });
    const preview = await service.preview({ expectedRevision: 1, mode: "full_internet", customDomains: [] });
    await service.apply({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true });

    // Stopped once, through the row that owns it.
    expect(provider.stopSandbox).toHaveBeenCalledOnce();
    expect(provider.stopSandbox).toHaveBeenCalledWith("provider-1");
  });
});
