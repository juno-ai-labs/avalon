/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { createAutomationsPlugin, type HarnessToolContext } from "@rally/agent-harness";
import { workspaceDOName } from "../src/durable-objects/names";
import { resolveWorkspaceEventResources } from "../src/durable-objects/workspace-event-resources";
import { encryptString } from "../src/lib/crypto";
import { __integrationTesting } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000fa10");
const USER = asUserId("00000000-0000-7000-8000-00000000fa11");
const CONNECTION = "00000000-0000-7000-8000-00000000fa12";
const FILE = "sheet-file-id-01";
const LINK = `https://docs.google.com/spreadsheets/d/${FILE}/edit`;
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE));
const signal = () => new AbortController().signal;
const context = (): HarnessToolContext => ({
  workspaceId: WORKSPACE, workstreamId: "00000000-0000-7000-8000-00000000fa13",
  harnessRunId: "00000000-0000-7000-8000-00000000fa14", toolCallId: "register-sheet",
  executionPrincipal: { type: "user", userId: USER }, signal: signal(),
});

async function tools() {
  const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(
    withWorkspaceRuntimeDatabase(env, WORKSPACE), WORKSPACE, USER,
  );
  const plugin = createAutomationsPlugin({
    catalog, inspectedPluginIds: new Set(), resolvedResources: new Map(),
    loadedPluginIds: new Set(), resolvedPersonIds: new Set(),
    draftState: { submitted: null }, model: "test/model",
  });
  const named = (name: string) => {
    const tool = plugin.tools.find((candidate) => candidate.definition.name === name);
    if (!tool) throw new Error(`missing_tool:${name}`);
    return tool;
  };
  return { register: named("resources_register"), inspect: named("plugin_inspect"), rules: named("set_evaluator_rules") };
}

// Only the external Google HTTP API is replaced. Resource creation, access,
// identity deduplication and event resolution use real WorkspaceDO SQLite/RPC.
function googleFile(status = 200, file: Record<string, unknown> = {}) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe("https://www.googleapis.com");
    expect(url.pathname).toBe(`/drive/v3/files/${FILE}`);
    expect(init?.method ?? "GET").toBe("GET");
    return Response.json({ id: FILE, name: "Content calendar", mimeType: "application/vnd.google-apps.spreadsheet", ...file }, { status });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

async function resourceCount() {
  return runInDurableObject(workspace(), (_instance, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM resources").one().n);
}

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE, userId: USER, sessionId: "registration-session" });
  await workspace().initializeWorkspace(WORKSPACE, "wnam");
  await workspace().finalizeSpaceBootstrap({ workspaceId: WORKSPACE });
  const credentials = await encryptString(JSON.stringify({ accessToken: "test-token", expiresAt: Date.now() + 3_600_000 }), env.CONNECTOR_CREDENTIALS_KEY, CONNECTION);
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name, model_plugin_id,
       granted_scopes_json, encrypted_credentials, credential_iv, created_at, updated_at)
      VALUES (?, ?, 'google', 'personal', ?, 'Google', 'plugin_google', '["drive.read","sheets.read"]', ?, ?, '2026-10-22', '2026-10-22')`,
    CONNECTION, WORKSPACE, USER, credentials.ciphertext, credentials.iv);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Sidekick external resource registration", () => {
  it("registers a Sheet once, accepts its event binding and resolves incoming changes to that ID", async () => {
    googleFile();
    const { register, inspect, rules } = await tools();
    const first = await register.execute({ pluginId: "plugin_google", resource: LINK }, context());
    expect(first.output).toMatchObject({ resources: [{ title: "Content calendar", pluginId: "plugin_google",
      resourceType: "google_sheet", provider: "google", relationships: ["file"], sourceBindingKeys: [] }] });
    const row = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT id, provider_resource_id, resource_type, canonical_url FROM resources",
    ).one());
    expect(row).toMatchObject({ provider_resource_id: FILE, resource_type: "google_sheet", canonical_url: LINK });
    expect(row.id).not.toBe(FILE);
    expect(first.output).toMatchObject({ resources: [{ id: row.id }] });
    const again = await register.execute({ pluginId: "plugin_google", resource: FILE }, context());
    expect(again.output).toEqual(first.output);
    expect(await resourceCount()).toBe(1);
    await inspect.execute({ pluginId: "plugin_google" }, context());
    expect(rules.validateInput?.({ schemaVersion: 1, evaluators: [{ evaluatorKey: "sheet_changed", source: {
      sourceBindingKey: "calendar_sheet", suggestedSourcePluginId: "plugin_google", resourceId: row.id,
      event: { kind: "event_type", eventType: "sheets.spreadsheet_changed" },
    }, when: { kind: "always" } }] })).toBeNull();
    const matched = await runInDurableObject(workspace(), (_instance, state) => resolveWorkspaceEventResources(state.storage.sql, {
      workspaceId: WORKSPACE, connectionId: CONNECTION, provider: "google", providerResourceId: FILE, entityKeys: [],
    }));
    expect(matched).toEqual([row.id]);
  });

  it.each([
    [404, {}, "not_found_or_not_shared"],
    [403, {}, "provider_refused"],
    [200, { trashed: true }, "trashed"],
  ])("refuses inaccessible files (%s, %j) without registering them", async (status, file, reason) => {
    googleFile(status, file);
    const { register } = await tools();
    await expect(register.execute({ pluginId: "plugin_google", resource: LINK }, context())).rejects.toThrow(String(reason));
    expect(await resourceCount()).toBe(0);
  });

  it("refuses a revoked connection before contacting Google", async () => {
    const fetcher = googleFile();
    const { register } = await tools();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", CONNECTION);
    });
    await expect(register.execute({ pluginId: "plugin_google", resource: LINK }, context())).rejects.toThrow("no longer healthy or authorized");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await resourceCount()).toBe(0);
  });

  it("refuses a connection revoked while the provider lookup is in flight", async () => {
    const fetcher = googleFile();
    const { register } = await tools();
    fetcher.mockImplementationOnce(async () => {
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", CONNECTION);
      });
      return Response.json({ id: FILE, name: "Content calendar", mimeType: "application/vnd.google-apps.spreadsheet" });
    });
    await expect(register.execute({ pluginId: "plugin_google", resource: LINK }, context())).rejects.toThrow("no longer healthy or authorized");
    expect(await resourceCount()).toBe(0);
  });

  it("rejects an unrecognized URL and undeclared arguments without a provider call", async () => {
    const fetcher = googleFile();
    const { register } = await tools();
    await expect(register.execute({ pluginId: "plugin_google", resource: "https://example.com/sheet" }, context()))
      .rejects.toThrow("does not recognize");
    await expect(register.execute({ pluginId: "plugin_google", resource: LINK, resourceType: "google_sheet" }, context()))
      .rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await resourceCount()).toBe(0);
  });

  it("cannot use another person's personal connection", async () => {
    const fetcher = googleFile();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE connector_connections SET owner_user_id = ? WHERE id = ?", "another-user", CONNECTION);
    });
    const { register } = await tools();
    await expect(register.execute({ pluginId: "plugin_google", resource: LINK }, context())).rejects.toThrow("sidekick_resource_plugin_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await resourceCount()).toBe(0);
  });

  it("does not expand a frozen run's access when new capabilities are granted", async () => {
    googleFile(200, { mimeType: "application/vnd.google-apps.document" });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE connector_connections SET granted_scopes_json = '["sheets.read"]' WHERE id = ?`, CONNECTION);
    });
    const { register } = await tools();
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE connector_connections SET granted_scopes_json = '["sheets.read","docs.read","drive.read"]' WHERE id = ?`, CONNECTION);
    });
    await expect(register.execute({ pluginId: "plugin_google", resource: FILE }, context())).rejects.toThrow("capability_not_granted");
    expect(await resourceCount()).toBe(0);
  });
});
