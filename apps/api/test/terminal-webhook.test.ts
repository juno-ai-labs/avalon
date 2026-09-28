import { terminalSandboxStableName } from "../src/services/terminal/coordinator";
import { runWorkspaceScheduleTarget } from "../src/services/workspace-schedule-execution";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { HonoAppEnv } from "../src/env";
import type { TerminalProviderRpcBinding, TerminalProviderRpcSession } from "../src/services/terminal/provider-rpc-contract";
import { daytonaWebhookRoutes } from "../src/routes/daytona";
import { errorHandler } from "../src/middleware/errors";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { seedWorkstreamObjectRoot, testSubstreamAgentsBinding, testTerminalPortFactory, testWorkstreamObjectStore } from "./helpers/durable-authority";
import { signedDaytonaHeaders } from "../scripts/daytona-webhook-provisioning";
import { refreshTerminalProviderObservation } from "../src/services/terminal/observation";

const W = "00000000-0000-4000-8000-000000000001";
const S = "00000000-0000-4000-8000-000000000002";
const U = "00000000-0000-4000-8000-000000000003";
const AT = "2026-09-14T00:00:00.000Z";
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const database = migratedSqliteDatabase();
  const store = testWorkstreamObjectStore();
  databases.push(database, store);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${U}', 'webhook-user', 'webhook@example.com', 'Webhook', '${AT}', '${AT}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${W}', 'Webhook', 'webhook', 'global', '${U}', '${AT}', '${AT}');
    INSERT INTO workstreams (id, workspace_id, do_identity_anchor) VALUES ('${S}', '${W}', 1);
    UPDATE workstream_authority_control SET phase = 'maintenance_draining', generation = 1, updated_at = '${AT}' WHERE id = 1;
    UPDATE workstream_authority_control SET phase = 'maintenance_importing' WHERE id = 1;
    UPDATE workstream_authority_control SET phase = 'maintenance_verified' WHERE id = 1;
    UPDATE workstream_authority_control SET phase = 'durable_object_open', serving_contract_version = 1 WHERE id = 1;
  `);
  seedWorkstreamObjectRoot(store, { workspaceId: W, workstreamId: S });
  store.exec(`INSERT INTO terminal_workspace
    (id, provider, lifecycle_state, sandbox_id, generation, authority_fingerprint,
     applied_network_revision, version, created_at, updated_at, expire_due_at)
    VALUES (1, 'daytona', 'running', 'sandbox-1', 1, 'authority', 1, 1, 0, 0, 9999999999999)`);
  const snapshot = { id: "sandbox-1", name: "rally", state: "archived" as const, domainAllowList: [],
    labels: { "rally.workspace": W, "rally.workstream": S, "rally.generation": "1" } };
  // Only the external provider is a double; routing and authority execute real SQL.
  const getSandbox = vi.fn<TerminalProviderRpcSession["getSandbox"]>(async () => ({ ok: true, value: snapshot }));
  const unexpected = async (): Promise<never> => { throw new Error("Observation attempted a provider mutation"); };
  const binding: TerminalProviderRpcBinding = { createSession: async () => ({
    getSandbox, createSandbox: unexpected, prepareSandbox: unexpected, startSandbox: unexpected,
    recoverSandbox: unexpected, stopSandbox: unexpected, archiveSandbox: unexpected, deleteSandbox: unexpected,
    updateNetworkPolicy: unexpected, configureGitHubReadAccess: unexpected, clearGitHubReadAccess: unexpected,
    readFile: unexpected, writeFile: unexpected, runUtilityCommand: unexpected, runCommand: unexpected,
    cleanupCommand: unexpected,
  }) };
  // The main conversation's object under the work stream's own id; a side
  // thread's is added under `<workstreamId>:<substreamId>` by the test that has one.
  const objectStores = new Map([[S, store]]);
  const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    DAYTONA_API_KEY: "test-key", DAYTONA_API_URL: "https://app.daytona.io/api", DAYTONA_TARGET: "us",
    DAYTONA_TERMINAL_SNAPSHOT: "snapshot", TERMINAL_REGION_CAPABILITY: "supported",
    DAYTONA_ORGANIZATION_ID: "org-1", DAYTONA_WEBHOOK_SECRET: secret, TERMINAL_PROVIDER: binding });
  const app = new Hono<HonoAppEnv>();
  app.onError(errorHandler);
  app.route("/ingest/daytona", daytonaWebhookRoutes);
  const terminal = testTerminalPortFactory(store)(W, S);
  const send = (payload: unknown, headers?: Record<string, string>) => {
    const body = JSON.stringify(payload);
    return app.request("https://api.example.com/ingest/daytona", { method: "POST", body,
      headers: headers ?? signedDaytonaHeaders(secret, body) }, env);
  };
  return { send, getSandbox, terminal, store, objectStores, env, snapshot };
}
const event = { event: "sandbox.state.updated", organizationId: "org-1", id: "sandbox-1", newState: "deleted" };
describe("Daytona webhook reconciliation", () => {
  it("reads current metadata for duplicate and out-of-order events without changing retention intent", async () => {
    const f = fixture();
    const before = await f.terminal.sandbox();
    for (let i = 0; i < 2; i += 1) expect((await f.send(event)).status).toBe(200);
    expect(await f.terminal.providerObservation()).toMatchObject({ state: "archived", errorCode: null });
    expect(await f.terminal.sandbox()).toEqual(before);
    expect(f.getSandbox).toHaveBeenCalledTimes(4);
  });
  it("rejects forged signatures and wrong organizations before provider lookup", async () => {
    const f = fixture();
    expect((await f.send(event, signedDaytonaHeaders(secret, "other body"))).status).toBe(401);
    expect((await f.send({ ...event, organizationId: "other-org" })).status).toBe(403);
    expect(f.getSandbox).not.toHaveBeenCalled();
  });
  it("ignores an old generation and another region", async () => {
    const f = fixture();
    f.store.exec("UPDATE terminal_workspace SET generation = 2, sandbox_id = 'replacement'");
    expect(await (await f.send(event)).json()).toEqual({ accepted: true, ignored: true });
    expect(await f.terminal.providerObservation()).toBeNull();
    f.env.AVALON_REGION = "eu";
    expect(await (await f.send(event)).json()).toEqual({ accepted: true, ignored: true });
  });
  it("the workspace scheduler leaves provider observation to the conversation and waits out a stale deadline", async () => {
    const f = fixture();
    const unused = async (): Promise<never> => { throw new Error("unrelated scheduler operation"); };
    const context = { env: f.env, workspaceEnv: f.env, workspaceId: W,
      directory: { workstreamScheduleTargets: unused },
      notificationIntents: { notificationIntentMaintenanceTarget: unused, reapSettledWorkstreamNotificationIntents: unused },
      // The work stream's parent is not built here; the main conversation is
      // the one this fixture's sandbox row belongs to.
      dueTerminalSubstreams: async () => [] };
    const target = { kind: "terminal" as const, id: S, dueAt: new Date(0).toISOString() };
    // Nothing is due on this row, so the entry that woke the sweep is stale:
    // it reports no wait and asks Daytona nothing — the object's own alarm
    // owns observation. That it republishes the deadline needs the object's
    // projection, so it is proved on workerd in `terminal-authority.test.ts`.
    expect(await runWorkspaceScheduleTarget(context, target, new Date())).toBeUndefined();
    expect(f.getSandbox).not.toHaveBeenCalled();
    expect(await f.terminal.providerObservation()).toBeNull();
  });

  it("the workspace scheduler reconciles every conversation the parent lists as due", async () => {
    const f = fixture();
    const thread = "00000000-0000-4000-8000-000000000077";
    const threadStore = testWorkstreamObjectStore();
    databases.push(threadStore);
    seedWorkstreamObjectRoot(threadStore, { workspaceId: W, workstreamId: S });
    threadStore.exec(`INSERT INTO terminal_workspace
      (id, provider, lifecycle_state, stable_name, sandbox_id, generation, authority_fingerprint,
       applied_network_revision, version, created_at, updated_at, archive_due_at, expire_due_at)
      VALUES (1, 'daytona', 'stopped', '${await terminalSandboxStableName(W, S, thread)}', 'sandbox-2', 1, 'authority', 1, 1, 0, 0, 1, 9999999999999)`);
    f.objectStores.set(`${S}:${thread}`, threadStore);
    // Both conversations' archives are due, and Daytona has already archived
    // both, so each pass settles its own row without a provider mutation.
    f.store.exec("UPDATE terminal_workspace SET lifecycle_state = 'stopped', archive_due_at = 1 WHERE id = 1");
    f.getSandbox.mockImplementation(async (id) => ({ ok: true, value: { ...f.snapshot, id, labels: { ...f.snapshot.labels, ...(id === "sandbox-2" ? { "rally.substream": thread } : {}) } } }));
    const unused = async (): Promise<never> => { throw new Error("unrelated scheduler operation"); };
    const context = { env: f.env, workspaceEnv: f.env, workspaceId: W,
      directory: { workstreamScheduleTargets: unused },
      notificationIntents: { notificationIntentMaintenanceTarget: unused, reapSettledWorkstreamNotificationIntents: unused },
      // The parent lists both conversations as due; each is reconciled on its own row.
      dueTerminalSubstreams: async () => ["0", thread] };
    const target = { kind: "terminal" as const, id: S, dueAt: new Date(0).toISOString() };

    await runWorkspaceScheduleTarget(context, target, new Date());
    expect(await f.terminal.sandbox()).toMatchObject({ sandboxId: "sandbox-1", lifecycleState: "archived" });
    expect(await testTerminalPortFactory(threadStore)(W, S, thread).sandbox())
      .toMatchObject({ sandboxId: "sandbox-2", lifecycleState: "archived" });
  });

  it("keeps the last observation on provider failure and can observe deletion without a webhook", async () => {
    const f = fixture();
    const identity = { sandboxId: "sandbox-1", generation: 1 };
    await refreshTerminalProviderObservation(f.terminal, { getSandbox: async () => f.snapshot }, identity);
    await expect(refreshTerminalProviderObservation(f.terminal, { getSandbox: async () => { throw new Error("offline"); } }, identity)).rejects.toThrow("offline");
    expect(await f.terminal.providerObservation()).toMatchObject({ state: "archived", errorCode: "provider_unavailable" });
    await refreshTerminalProviderObservation(f.terminal, { getSandbox: async () => { throw Object.assign(new Error("gone"), { status: 404 }); } }, identity);
    expect(await f.terminal.providerObservation()).toMatchObject({ state: "absent", errorCode: null });
    expect(await f.terminal.sandbox()).toMatchObject({ sandboxId: "sandbox-1", generation: 1 });
  });
});
