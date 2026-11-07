/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkstreamWorkflowInputSchema, asUserId, asWorkspaceId } from "@rally/contracts";
import { createAutomationsPlugin, type HarnessToolContext } from "@rally/agent-harness";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { resolveWorkspaceEventResources } from "../src/durable-objects/workspace-event-resources";
import { encryptString } from "../src/lib/crypto";
import { ResourceService } from "../src/services/resource-service";
import { __integrationTesting } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { boot, seedRun, seedWorkstreamRoot, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE = asWorkspaceId("625b4efa-b784-45da-a06a-480d530e18ca");
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
    return Response.json({ id: FILE, name: "Content calendar", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: LINK, ...file }, { status });
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
  const credentials = await encryptString(JSON.stringify({ accessToken: "test-token", expiresAt: Date.now() + 3_600_000 }), env.CONNECTOR_CREDENTIALS_KEY, CONNECTION);
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name, model_plugin_id,
       granted_scopes_json, encrypted_credentials, credential_iv, created_at, updated_at)
      VALUES (?, ?, 'google', 'personal', ?, 'Google', 'plugin_google', '["drive.read","sheets.read"]', ?, ?, '2026-10-22', '2026-10-22')`,
    CONNECTION, WORKSPACE, USER, credentials.ciphertext, credentials.iv);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  it.each(["folder", "shortcut"])("refuses %s registration instead of advertising a file-contents watch", async (kind) => {
    googleFile(200, { mimeType: `application/vnd.google-apps.${kind}` });
    const { register } = await tools();
    await expect(register.execute({ pluginId: "plugin_google", resource: FILE }, context()))
      .rejects.toMatchObject({ code: "unsupported_capability" });
    expect(await resourceCount()).toBe(0);
  });

  it("refuses a stale stored resource type instead of returning inconsistent relationships", async () => {
    googleFile();
    await workspace().resolveConnectorResource({ workspaceId: WORKSPACE, candidateResourceId: "00000000-0000-7000-8000-00000000fa17",
      connectionId: CONNECTION, provider: "google", providerResourceId: FILE, resourceType: "drive_file",
      title: "Old resource", canonicalUrl: LINK, at: new Date().toISOString() });
    const { register } = await tools();
    await expect(register.execute({ pluginId: "plugin_google", resource: LINK }, context()))
      .rejects.toMatchObject({ code: "invalid_configuration", message: expect.stringContaining("metadata needs correction") });
    expect(await resourceCount()).toBe(1);
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

  it.each([["gmail.read"], ["calendar.read"], ["sheets.read"], ["docs.read"]])(
    "does not advertise registration for unsupported grants %s", async (...grants) => {
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec("UPDATE connector_connections SET granted_scopes_json = ? WHERE id = ?", JSON.stringify(grants), CONNECTION);
      });
      const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(withWorkspaceRuntimeDatabase(env, WORKSPACE), WORKSPACE, USER);
      expect(catalog).toHaveLength(1);
      expect(catalog[0]?.registerResource).toBeUndefined();
    },
  );

  it("advertises registration only on the Drive view of a split Google connection", async () => {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE connector_connections SET granted_scopes_json = '["gmail.read","drive.read"]' WHERE id = ?`, CONNECTION);
    });
    const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(withWorkspaceRuntimeDatabase(env, WORKSPACE), WORKSPACE, USER);
    expect(catalog.map((entry) => ({ plugin: entry.pluginId, registration: Boolean(entry.registerResource) }))).toEqual([
      { plugin: "plugin_google_drive", registration: true }, { plugin: "plugin_google_mail_calendar", registration: false },
    ]);
  });

  it.each(["disabled", "grant_removed", "owner_changed"] as const)("refuses %s at the canonical write after service checks", async (change) => {
    googleFile();
    const { register } = await tools();
    // Interpose the revocation at the real RPC receiver, after the service has
    // admitted the connection but before its canonical write transaction starts.
    await runInDurableObject(workspace(), (instance, state) => {
      const resolve = instance.resolveConnectorResource.bind(instance);
      const prototype: typeof instance = Object.getPrototypeOf(instance);
      vi.spyOn(prototype, "resolveConnectorResource").mockImplementationOnce(async (request) => {
        if (change === "disabled") state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", CONNECTION);
        if (change === "grant_removed") state.storage.sql.exec(`UPDATE connector_connections SET granted_scopes_json = '["sheets.read"]' WHERE id = ?`, CONNECTION);
        if (change === "owner_changed") state.storage.sql.exec("UPDATE connector_connections SET owner_user_id = ? WHERE id = ?", "00000000-0000-7000-8000-00000000fa15", CONNECTION);
        return resolve(request);
      });
    });
    const result = await register.execute({ pluginId: "plugin_google", resource: LINK }, context()).catch((error: unknown) => error);
    expect(await resourceCount()).toBe(0);
    expect(result).toMatchObject({ code: "resource_connection_unavailable" });
  });

  it("preserves the frozen connection identity across the resource service read", async () => {
    googleFile();
    const { register } = await tools();
    const resolve = ResourceService.prototype.resolve;
    vi.spyOn(ResourceService.prototype, "resolve").mockImplementationOnce(async function (this: ResourceService, input, authority) {
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec("UPDATE connector_connections SET scope = 'workspace', owner_user_id = NULL WHERE id = ?", CONNECTION);
      });
      return resolve.call(this, input, authority);
    });
    const result = await register.execute({ pluginId: "plugin_google", resource: LINK }, context()).catch((error: unknown) => error);
    expect(await resourceCount()).toBe(0);
    expect(result).toMatchObject({ code: "resource_connection_unavailable" });
  });

  it("restores registration receipts in a later authoring turn without registering again", async () => {
    const fetcher = googleFile();
    const parentId = context().workstreamId;
    const conversation = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE, parentId));
    await boot(conversation);
    await runInDurableObject(conversation, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE, workstreamId: parentId });
      seedRun(state, context().harnessRunId);
    });
    const makeHost = (runId: string) => __integrationTesting.createAvalonAutomationsPlugin(
      withWorkspaceRuntimeDatabase(env, WORKSPACE), WorkstreamWorkflowInputSchema.parse({
        region: "global", workspaceId: WORKSPACE, parentKind: "automation", parentId,
        loopId: `workstream:${parentId}:substream:0:loop`, harnessRunId: runId,
        triggerMessageId: null, activityId: null, executionPrincipal: { type: "user", userId: USER }, reason: "replay test",
      }), new Set(), (tool) => [tool],
    );
    const first = makeHost(context().harnessRunId);
    const registered = await first.tools.find((tool) => tool.definition.name === "resources_register")!
      .execute({ pluginId: "plugin_google", resource: LINK }, context());
    const id = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ id: string }>("SELECT id FROM resources").one().id);
    const outputRef = "test/registration-replay.json";
    await env.PAYLOADS.put(outputRef, JSON.stringify({ replayVersion: 1, output: registered.output }));
    await runInDurableObject(conversation, (_instance, state) => {
      for (const [position, name, capability, ref] of [
        [0, "plugin_inspect", "rally.sidekick.plugins.inspect", null],
        [1, "resources_register", "rally.sidekick.resources.register", outputRef],
      ] as const) {
        state.storage.sql.exec(`INSERT INTO tool_effects
          (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name, mode,
           request_hash, authority_revision, status, tool_call_id, input_json, output_ref, execution_plan_json, settled_at)
          VALUES (?, ?, 0, ?, ?, ?, ?, 'hash', '1', 'completed', ?, ?, ?, ?, ?)`,
        crypto.randomUUID(), context().harnessRunId, position, `occurrence-${name}`, name, name === "resources_register" ? "write" : "read", `call-${name}`,
        JSON.stringify({ pluginId: "plugin_google", resource: LINK }), ref, JSON.stringify({ canonicalToolName: name, capability }), position + 1);
      }
    });
    const resumed = makeHost("00000000-0000-7000-8000-00000000fa16");
    await expect(resumed.tools.find((tool) => tool.definition.name === "set_evaluator_rules")!.execute({
      schemaVersion: 1, evaluators: [{ evaluatorKey: "sheet_changed", source: {
        sourceBindingKey: "sheet", suggestedSourcePluginId: "plugin_google", resourceId: id,
        event: { kind: "event_type", eventType: "sheets.spreadsheet_changed" },
      }, when: { kind: "always" } }],
    }, context())).resolves.toMatchObject({ output: { accepted: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

});
