import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptString } from "../src/lib/crypto";
import { __integrationTesting } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  seedToolReceipt,
  testToolReceiptPort,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000000");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000003");
const PERSONAL_ID = "00000000-0000-4000-8000-000000000030";
const WORKSPACE_CONNECTION_ID = "00000000-0000-4000-8000-000000000031";
const FILE_ID = "sheet-file-id-01";
const NOW = "2026-01-01T00:00:00.000Z";
const CAPABILITIES = ["drive.read", "sheets.read", "sheets.write"];

type Frozen = Parameters<typeof __integrationTesting.executeAuthorizedConnectorTool>[2];

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of openDatabases.splice(0)) database.close();
});

function workflowInput(): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: WORKSTREAM_ID,
    loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "Connector resource access test",
  };
}

/**
 * A member with a personal Google connection in an Organization that also
 * holds a workspace one, each sealed with its own access token.
 */
async function fixture() {
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, 'google-resource-access', 'member@example.test', 'Member', ?, ?)`,
  ).run(USER_ID, NOW, NOW);
  database.prepare(
    `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Test', 'test', 'global', ?, ?, ?)`,
  ).run(WORKSPACE_ID, USER_ID, NOW, NOW);
  database.prepare(
    `INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(WORKSPACE_ID, USER_ID, NOW);
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM_ID,
    workspaceId: WORKSPACE_ID,
    title: "Creator content",
    description: "Creator content",
    originType: "ad_hoc",
    createdByUserId: USER_ID,
    exactState: "running",
  });
  seedWorkstreamRun(objectStore, { id: HARNESS_RUN_ID,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }) });
  const workspaceObject = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: database,
    register: (created) => { openDatabases.push(created); },
  });
  const baseEnv = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_API_BASE_URL: "https://api.example.test",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-client",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-secret",
    CONNECTOR_CREDENTIALS_KEY: "resource-access-credential-key",
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
    WORKSPACE_DOS: testSubstreamAgentsBinding(objectStore, {
      extra: workspaceObjectRpcs(workspaceObject.instance, ["executeRuntimeSql", "sidekickReadExecutionDelegation"]),
    }),
  });
  const insert = async (id: string, scope: "personal" | "workspace", token: string, plugin: string): Promise<Frozen> => {
    const sealed = await encryptString(JSON.stringify({ accessToken: token }), baseEnv.CONNECTOR_CREDENTIALS_KEY, id);
    workspaceObject.objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name, granted_scopes_json,
          encrypted_credentials, credential_iv, credential_key_version, status, created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'google', ?, ?, 'Google Drive', ?, ?, ?, 1, 'healthy', ?, ?, ?)`,
    ).run(id, WORKSPACE_ID, scope, scope === "personal" ? USER_ID : null, JSON.stringify(CAPABILITIES),
      sealed.ciphertext, sealed.iv, NOW, NOW, plugin);
    return {
      pluginId: `connection:${id}`,
      modelPluginId: plugin,
      connectionId: id,
      workspaceId: WORKSPACE_ID,
      connectorType: "google",
      scope,
      ownerUserId: scope === "personal" ? USER_ID : null,
      grantedScopes: CAPABILITIES,
      toolCapabilities: CAPABILITIES,
      shortWireName: plugin.replace("plugin_", ""),
    } as Frozen;
  };
  return {
    env: withWorkspaceRuntimeDatabase(baseEnv, WORKSPACE_ID),
    database, objectStore, workspaceObject,
    personal: await insert(PERSONAL_ID, "personal", "personal-token", "plugin_google"),
    workspace: await insert(WORKSPACE_CONNECTION_ID, "workspace", "workspace-token", "plugin_google_2"),
  };
}

/**
 * Google as two accounts. By default the personal token's account was never
 * shared the file and the Organization's can edit it. Returns each Sheets
 * write, by the token that sent it.
 */
function googleAsTwoAccounts(options: {
  visibleTo?: readonly string[];
  reads?: string[];
  refuseWritesFrom?: string;
  /** Tokens whose account can edit the file but has not granted Rally it. */
  needGrant?: readonly string[];
} = {}): string[] {
  const visibleTo = options.visibleTo ?? ["workspace-token"];
  const writes: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const token = String(new Headers(init?.headers).get("authorization")).replace("Bearer ", "");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" } });
    if (url.hostname === "www.googleapis.com") {
      return !visibleTo.includes(token)
        ? json({ error: { code: 404 } }, 404)
        : json({ id: FILE_ID, name: "Creator Content Intake", mimeType: "application/vnd.google-apps.spreadsheet",
          isAppAuthorized: !(options.needGrant ?? []).includes(token), capabilities: { canEdit: true } });
    }
    if (url.hostname === "sheets.googleapis.com" && init?.method === "PUT") {
      writes.push(token);
      return token === options.refuseWritesFrom
        ? json({ error: { code: 403 } }, 403)
        : json({ updatedRange: "A1:B1", updatedRows: 1, updatedCells: 2 });
    }
    if (url.hostname === "sheets.googleapis.com" && url.pathname.includes("/values/")) {
      options.reads?.push(token);
      return visibleTo.includes(token) ? json({ range: "A1:B1", majorDimension: "ROWS", values: [["Content calendar"]] })
        : json({ error: { code: 404 } }, 404);
    }
    return json({ error: { code: 404 } }, 404);
  });
  return writes;
}

const write = { spreadsheetId: FILE_ID, range: "A1:B1", values: [["a", "b"]], valueInputOption: "RAW" };

describe("reaching one resource through whichever connection can", () => {
  it("dispatches an assembled Sidekick Google tool through eligible delegates after definite refusals", async () => {    const reads: string[] = [];
    const writes = googleAsTwoAccounts({ reads });
    const { env, database, objectStore, workspaceObject } = await fixture();
    const other = asUserId("00000000-0000-4000-8000-000000000032");
    database.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES (?,'other','other@example.test','Maya',?,?)")
      .run(other, NOW, NOW);
    database.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,joined_at) VALUES (?,?,'member','active',?)")
      .run(WORKSPACE_ID, other, NOW);
    await workspaceObject.instance.sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: WORKSTREAM_ID,
      authorUserId: USER_ID, scope: "workspace", owningWorkstreamId: null, authorityGeneration: 1
    });
    const request = { workspaceId: WORKSPACE_ID, automationId: WORKSTREAM_ID, userId: other, allowed: true, operationId: crypto.randomUUID() };
    const prepared = await workspaceObject.instance.sidekickPrepareMyDelegation(request);
    await workspaceObject.instance.sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
    workspaceObject.objectDatabase.prepare("UPDATE connector_connections SET scope='personal',owner_user_id=? WHERE id=?")
      .run(other, WORKSPACE_CONNECTION_ID);
    const lease = { attemptId: "account-attempt", owner: "account-owner", attemptNumber: 1,
      leaseExpiresAt: new Date(Date.now()+600_000).toISOString() };
    objectStore.prepare("UPDATE runs SET legacy_attempt_id=?,lease_owner=?,lease_expires_at=? WHERE run_id=?")
      .run(lease.attemptId, lease.owner, Date.now()+600_000, HARNESS_RUN_ID);
    seedToolReceipt(objectStore, { id: "read-effect", runId: HARNESS_RUN_ID, toolCallId: "read-call",
      toolName: "sheets.read_values", status: "executing", mode: "read", executionPlanJson: '{"mode":"read"}' });
    const input = { ...workflowInput(), parentKind: "automation" as const };
    const catalog = await __integrationTesting.loadHarnessTools(env, input, undefined, undefined, undefined, undefined, lease);
    const plugin = catalog.plugins.find((candidate) => catalog.frozenConnections.get(candidate.canonicalId)?.ownerUserId === USER_ID
      && candidate.tools.some((tool) => tool.definition.name === "sheets.update_values"))!;
    const read = plugin.tools.find((candidate) => candidate.definition.name === "sheets.read_values")!;
    const readResult = await read.execute({ spreadsheetId: FILE_ID, range: "A1:B1" }, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID,
      harnessRunId: HARNESS_RUN_ID, toolCallId: "read-call", effectIntentId: "read-effect",
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal });
    expect(reads).toEqual(["personal-token", "workspace-token"]);
    expect(readResult.output).toMatchObject({ values: [["Content calendar"]] });
    const receipts = testToolReceiptPort(objectStore);
    expect(await receipts.executionAccount({ runId: HARNESS_RUN_ID, effectIntentId: "read-effect" }))
      .toMatchObject({ originalAccount: { connectionId: PERSONAL_ID }, account: { connectionId: WORKSPACE_CONNECTION_ID } });
    await receipts.complete({ effectIntentId: "read-effect", checkpointIndex: 5, outputRef: "read-output", outputSummary: "Read calendar",
      providerOperationId: FILE_ID, payloadJson: "{}", allowAmbiguousReconciliation: false,
      fence: { runId: HARNESS_RUN_ID, attemptId: lease.attemptId, owner: lease.owner }, now: Date.now() });
    seedToolReceipt(objectStore, { id: "account-effect", runId: HARNESS_RUN_ID, toolCallId: "account-call", position: 1,
      toolName: "sheets.update_values", status: "executing", mode: "write", executionPlanJson: '{"mode":"write"}' });
    const tool = plugin.tools.find((candidate) => candidate.definition.name === "sheets.update_values")!;
    const result = await tool.execute(write, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID,
      harnessRunId: HARNESS_RUN_ID, toolCallId: "account-call", effectIntentId: "account-effect",
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal });
    expect(writes).toEqual(["workspace-token"]);
    expect(result.output).toMatchObject({ updatedCells: 2 });
    expect(await testToolReceiptPort(objectStore).executionAccount({ runId: HARNESS_RUN_ID, effectIntentId: "account-effect" }))
      .toMatchObject({ phase: "served", originalAccount: { connectionId: PERSONAL_ID },
        account: { principal: { type: "user", userId: other }, connectionId: WORKSPACE_CONNECTION_ID } });
    const revoke = { ...request, allowed: false, operationId: crypto.randomUUID() };
    const revocation = await workspaceObject.instance.sidekickPrepareMyDelegation(revoke);
    await workspaceObject.instance.sidekickSetDelegation({ ...revoke, expectedGeneration: revocation.generation, source: "self_service" });
    seedToolReceipt(objectStore, { id: "after-withdrawal", runId: HARNESS_RUN_ID, toolCallId: "after-withdrawal", position: 2,
      toolName: "sheets.update_values", status: "executing", mode: "write", executionPlanJson: '{"mode":"write"}' });
    const afterWithdrawal = { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID,
      harnessRunId: HARNESS_RUN_ID, toolCallId: "after-withdrawal", effectIntentId: "after-withdrawal",
      executionPrincipal: input.executionPrincipal, signal: new AbortController().signal };
    // Consent propagates with inventory refresh, not with a grant RPC per call.
    await expect(tool.execute(write, afterWithdrawal))
      .resolves.toMatchObject({ output: { updatedCells: 2 } });
    const refreshed = await __integrationTesting.loadHarnessTools(env, input, undefined, undefined, undefined, undefined, lease);
    const refreshedTool = refreshed.plugins.find((candidate) => candidate.canonicalId === plugin.canonicalId)!
      .tools.find((candidate) => candidate.definition.name === "sheets.update_values")!;
    await expect(refreshedTool.execute(write, afterWithdrawal))
      .rejects.toThrow("originating delegate is unavailable");
    expect(writes).toEqual(["workspace-token", "workspace-token"]);
  });

  it("writes through the Organization's connection when the person's own cannot reach the file", async () => {
    const writes = googleAsTwoAccounts();
    const { env, personal, workspace } = await fixture();

    const result = await __integrationTesting.executeAuthorizedConnectorTool(
      env, workflowInput(), personal, "sheets.update_values", "sheets.write", write,
      new AbortController().signal, undefined, undefined, undefined, undefined, () => [workspace],
    );

    expect(writes).toEqual(["workspace-token"]);
    expect(result.output).toMatchObject({
      servedThrough: { plugin: "plugin_google_2", scope: "workspace", couldNotReach: "plugin_google" },
    });
    expect(result.summary).toBe("Updated 1 row in Google Sheets (through plugin_google_2; plugin_google could not reach it)");
  });

  it("does not retry a write the provider refused after it was sent", async () => {
    // Both accounts can edit the file, so only the guard stops a second write.
    const writes = googleAsTwoAccounts({
      visibleTo: ["workspace-token", "personal-token"],
      refuseWritesFrom: "workspace-token",
    });
    const { env, personal, workspace } = await fixture();

    // The Organization's connection passes the check, sends the write, and
    // Google refuses it. Whatever happened there, it is not tried again.
    await expect(__integrationTesting.executeAuthorizedConnectorTool(
      env, workflowInput(), workspace, "sheets.update_values", "sheets.write", write,
      new AbortController().signal, undefined, undefined, undefined, undefined, () => [personal],
    )).rejects.toMatchObject({ code: "provider_error" });
    expect(writes).toEqual(["workspace-token"]);
  });

  it("reports the Organization's grant request when only that account could edit", async () => {
    // The person's own account cannot see the file; the Organization's can edit
    // it once Rally has the one-file grant. The card must ask about that one.
    const writes = googleAsTwoAccounts({ needGrant: ["workspace-token"] });
    const { env, personal, workspace } = await fixture();

    await expect(__integrationTesting.executeAuthorizedConnectorTool(
      env, workflowInput(), personal, "sheets.update_values", "sheets.write", write,
      new AbortController().signal, undefined, undefined, undefined, undefined, () => [workspace],
    )).rejects.toMatchObject({
      message: expect.stringMatching(/^Rally needs a one-file grant\./u),
      details: {
        resourceAuthorizationConnectionId: WORKSPACE_CONNECTION_ID,
        resourceAuthorization: {
          kind: "connector_resource_authorization",
          capability: "sheets.write",
          resource: { id: FILE_ID, name: "Creator Content Intake" },
        },
      },
    });
    expect(writes).toEqual([]);
  });

  it("shows the card rather than writing as the Organization when the person's own account only needs the grant", async () => {
    // Both accounts can edit; the person's own lacks only Rally's one-file grant.
    const writes = googleAsTwoAccounts({
      visibleTo: ["workspace-token", "personal-token"],
      needGrant: ["personal-token"],
    });
    const { env, personal, workspace } = await fixture();

    const refusal = await __integrationTesting.executeAuthorizedConnectorTool(
      env, workflowInput(), personal, "sheets.update_values", "sheets.write", write,
      new AbortController().signal, undefined, undefined, undefined, undefined, () => [workspace],
    ).catch((error: unknown) => error);

    expect(writes).toEqual([]);
    expect(refusal).toMatchObject({
      details: { resourceAuthorization: { kind: "connector_resource_authorization", resource: { id: FILE_ID } } },
    });
    // The request is the chosen connection's own, so the card asks about it.
    expect((refusal as { details: Record<string, unknown> }).details.resourceAuthorizationConnectionId).toBeUndefined();
  });

  it("names which connection can open a file and how far", async () => {
    googleAsTwoAccounts();
    const { env, personal, workspace } = await fixture();
    const tool = __integrationTesting.createAvalonTools(env, workflowInput(), {
      connectorTypes: ["google"],
      connections: () => [personal, workspace],
    }).find((candidate) => candidate.definition.name === "check_resource_access");
    const link = `https://docs.google.com/spreadsheets/d/${FILE_ID}/edit`;

    expect(tool?.definition).toMatchObject({ mode: "read", idempotency: "safe" });
    await expect(tool!.execute({ connector: "google", resource: link }, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: HARNESS_RUN_ID,
      toolCallId: "check-access",
      executionPrincipal: { type: "user", userId: USER_ID },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      output: {
        connector: "google",
        resource: link,
        name: "Creator Content Intake",
        connections: [
          { plugin: "plugin_google", scope: "personal", access: "none", resourceId: FILE_ID, reason: "not_found_or_not_shared" },
          { plugin: "plugin_google_2", scope: "workspace", access: "edit", resourceId: FILE_ID, name: "Creator Content Intake" },
        ],
        canEdit: "plugin_google_2",
        canRead: "plugin_google_2",
      },
      summary: "Creator Content Intake: plugin_google (personal) none; plugin_google_2 (workspace) edit",
    });
  });

  it("reports only what the run froze, not grants added to the connection since", async () => {
    // The live row grants Drive and Sheets; the run started when it did not.
    googleAsTwoAccounts({ visibleTo: ["workspace-token"] });
    const { env, personal, workspace } = await fixture();
    const frozenWithoutDrive = { ...workspace, grantedScopes: ["gmail.read"], toolCapabilities: ["gmail.read"] } as Frozen;
    const tool = __integrationTesting.createAvalonTools(env, workflowInput(), {
      connectorTypes: ["google"],
      connections: () => [personal, frozenWithoutDrive],
    }).find((candidate) => candidate.definition.name === "check_resource_access");

    const result = await tool!.execute({ connector: "google", resource: FILE_ID }, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: HARNESS_RUN_ID,
      toolCallId: "check-access-frozen",
      executionPrincipal: { type: "user", userId: USER_ID },
      signal: new AbortController().signal,
    });
    expect(result.output).toMatchObject({
      connections: [
        { plugin: "plugin_google", access: "none" },
        { plugin: "plugin_google_2", access: "none", reason: "capability_not_granted" },
      ],
      canRead: null,
    });
  });
});
