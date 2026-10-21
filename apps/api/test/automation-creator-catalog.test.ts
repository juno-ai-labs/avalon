import { DatabaseSync } from "node:sqlite";
import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";
import { testSubstreamAgentsBinding, testWorkstreamObjectStore } from "./helpers/durable-authority";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";
import { sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000101");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000102");
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000103");
const USER_ID = asUserId("00000000-0000-4000-8000-000000000104");

/**
 * The narrow slice of workspace-authority tables this catalog's tools reach:
 * `connector_connections` and `resources` (routed to WorkspaceDO storage in
 * production, per `WORKSPACE_LOCAL_TABLES`) alongside the regional-only
 * `users`/`workspace_members`. One hand-rolled database stands in for both
 * authorities here — it is bound as `env.DB` directly for the drafting tools'
 * own regional reads, and again through `WORKSPACE_DOS.executeRuntimeSql` for
 * `ResourceService`'s workspace-routed ones — so a row seeded once is visible
 * on whichever path a tool takes to it.
 */
function localDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL
    );
    CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      access_class TEXT NOT NULL DEFAULT 'member'
    );
    CREATE TABLE connector_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      owner_user_id TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'healthy',
      model_plugin_id TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      cursor_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE resources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connection_id TEXT,
      resource_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_resource_id TEXT,
      title TEXT NOT NULL,
      mime_type TEXT,
      canonical_url TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_hydrated_at TEXT,
      attachment_status TEXT NOT NULL DEFAULT 'attached',
      uploaded_by_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE resource_watches (
      resource_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      enabled INTEGER NOT NULL
    );
    CREATE TABLE notes (
      resource_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      archived_at TEXT
    );
  `);
  return database;
}

const authorizationDatabases: DatabaseSync[] = [];

function env(localDb: DatabaseSync): Env {
  const workspace = createTestWorkspaceDO({ workspaceId: WORKSPACE_ID, regionalDatabase: localDb, register: (db) => authorizationDatabases.push(db) });
  localDb.exec(`CREATE TABLE IF NOT EXISTS workspace_members(workspace_id TEXT, user_id TEXT, status TEXT)`);
  localDb.prepare("INSERT OR IGNORE INTO workspace_members(workspace_id, user_id, status) VALUES (?, ?, 'active')").run(WORKSPACE_ID, USER_ID);
  for (const table of ['connector_connections', 'resources', 'notes']) {
    for (const row of localDb.prepare(`SELECT * FROM ${table}`).all()) {
      if (table === 'connector_connections') {
        row.display_name = String(row.connector_type);
        row.updated_at = row.created_at ?? '2026-08-01T00:00:00.000Z';
      }
      const keys = Object.keys(row);
      workspace.objectDatabase.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...Object.values(row));
    }
  }
  return createTestEnv({
    DB: sqliteD1(localDb),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(testWorkstreamObjectStore()),
    WORKSPACE_DOS: testSubstreamAgentsBinding(localDb, { extra: workspaceObjectRpcs(workspace.instance, []) }),
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
  });
}

function workflowInput(): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "automation",
    parentId: WORKSTREAM_ID,
    loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "Automation catalog test",
  };
}

/** One drafting tool from a run's assembled surface, by name. */
async function automationCreatorTool(
  localDb: DatabaseSync,
  input: WorkstreamWorkflowInput,
  name: string,
): Promise<Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>["tools"][number]> {
  const selected = await __integrationTesting.loadHarnessTools(env(localDb), input);
  const plugin = selected.plugins.find((candidate) => candidate.canonicalId === "rally:sidekicks");
  if (!plugin) throw new Error("automations_plugin_missing");
  const tool = plugin.tools.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`automation_creator_tool_missing:${name}`);
  return tool;
}

function insertConnection(
  localDb: DatabaseSync,
  row: {
    id: string;
    connectorType: string;
    scope: "personal" | "workspace";
    ownerUserId: string | null;
    modelPluginId: string;
    grantedScopes?: readonly string[];
    configJson?: string;
  },
): void {
  localDb.prepare(
    `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, granted_scopes_json,
        status, model_plugin_id, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'healthy', ?, ?, '2026-08-01T00:00:00.000Z')`,
  ).run(
    row.id,
    WORKSPACE_ID,
    row.connectorType,
    row.scope,
    row.ownerUserId,
    JSON.stringify(row.grantedScopes ?? []),
    row.modelPluginId,
    row.configJson ?? "{}",
  );
}

afterEach(() => {
  for (const database of authorizationDatabases.splice(0)) database.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("automation-creator plugin catalog", () => {
  it("lists a generic webhook connection by its activity triggers, with no tools, and inspects it", async () => {
    const localDb = localDatabase();
    insertConnection(localDb, {
      id: "00000000-0000-4000-8000-000000000201",
      connectorType: "generic_webhook",
      scope: "workspace",
      ownerUserId: null,
      modelPluginId: "plugin_webhook",
      configJson: JSON.stringify({ eventTypes: ["order.created"] }),
    });
    const input = workflowInput();

    const pluginsList = await automationCreatorTool(localDb, input, "plugins_list");
    const listed = await pluginsList.execute({}, { toolCallId: "list-webhook" } as never);
    const entries = (listed.output as {
      plugins: Array<{ pluginId: string; tools: unknown[]; activityTriggerCount: number }>;
    }).plugins;
    const webhookEntry = entries.find((entry) => entry.pluginId === "plugin_webhook");
    // A generic webhook has no outbound tools by design and exists only to be
    // an automation's trigger: it earns its catalog entry by its activity
    // triggers alone, not by having anything to call.
    expect(webhookEntry).toBeDefined();
    expect(webhookEntry?.tools).toEqual([]);
    expect(webhookEntry?.activityTriggerCount).toBeGreaterThan(0);

    const pluginInspect = await automationCreatorTool(localDb, input, "plugin_inspect");
    const inspected = await pluginInspect.execute(
      { pluginId: "plugin_webhook" },
      { toolCallId: "inspect-webhook" } as never,
    );
    expect(inspected.output).toMatchObject({
      plugin: {
        pluginId: "plugin_webhook",
        tools: [],
        // A webhook connection's triggers are its configured event types, with the payload's own keys as filter fields.
        activityTriggers: [expect.objectContaining({ eventType: "order.created", openFilterFields: true })],
      },
    });

    // A connector with neither tools nor an event source would be excluded by
    // the same `eventCapable` check this test's break exercises, but no
    // adapter under packages/connectors is built that way today: every one of
    // google, github, granola, linear, notion, slack, and x declares at least
    // one tool, and generic_webhook (checked above) declares activity
    // triggers instead. There is nothing to seed for that arm without
    // inventing a connector, so it is left unexercised here rather than
    // faked.
  });

  it("advertises a connector's events only to a connection whose scope can receive them", async () => {
    const localDb = localDatabase();
    insertConnection(localDb, {
      id: "00000000-0000-4000-8000-000000000211",
      connectorType: "granola",
      scope: "personal",
      ownerUserId: USER_ID,
      modelPluginId: "plugin_granola",
    });
    insertConnection(localDb, {
      id: "00000000-0000-4000-8000-000000000212",
      connectorType: "generic_webhook",
      scope: "personal",
      ownerUserId: USER_ID,
      modelPluginId: "plugin_webhook",
      configJson: JSON.stringify({ eventTypes: ["order.created"] }),
    });
    const input = workflowInput();

    const pluginsList = await automationCreatorTool(localDb, input, "plugins_list");
    const listed = await pluginsList.execute({}, { toolCallId: "list-personal" } as never);
    const entries = (listed.output as {
      plugins: Array<{ pluginId: string; activityTriggerCount: number; activityTriggersUnavailable?: string }>;
    }).plugins;

    // Granola's webhook belongs to the workspace install and its `normalize`
    // refuses every other connection, so the four triggers this personal
    // connection used to advertise were events it could never receive: the
    // Sidekick drafted on one applied, activated, and then never fired.
    const granolaEntry = entries.find((entry) => entry.pluginId === "plugin_granola");
    expect(granolaEntry?.activityTriggerCount).toBe(0);
    expect(granolaEntry?.activityTriggersUnavailable).toMatch(/workspace connection/u);

    // Narrowed per connector, not per scope: a personal webhook receives its
    // own deliveries and keeps every trigger it configured.
    const webhookEntry = entries.find((entry) => entry.pluginId === "plugin_webhook");
    expect(webhookEntry?.activityTriggerCount).toBe(1);
    expect(webhookEntry).not.toHaveProperty("activityTriggersUnavailable");
  });

  it("keeps every trigger on a workspace connection of the same connector", async () => {
    const localDb = localDatabase();
    insertConnection(localDb, {
      id: "00000000-0000-4000-8000-000000000213",
      connectorType: "granola",
      scope: "workspace",
      ownerUserId: null,
      modelPluginId: "plugin_granola",
    });

    const pluginsList = await automationCreatorTool(localDb, workflowInput(), "plugins_list");
    const listed = await pluginsList.execute({}, { toolCallId: "list-workspace" } as never);
    const entry = (listed.output as {
      plugins: Array<{ pluginId: string; activityTriggerCount: number; activityTriggersUnavailable?: string }>;
    }).plugins.find((candidate) => candidate.pluginId === "plugin_granola");

    // Counted rather than enumerated: which events Granola declares is the
    // connector's business and changes with its API, while the contrast with
    // the personal connection's zero above is what this asserts.
    expect(entry?.activityTriggerCount).toBeGreaterThan(0);
    expect(entry).not.toHaveProperty("activityTriggersUnavailable");
  });

  it("returns active workspace members matching a name or email fragment, excluding suspended ones", async () => {
    const localDb = localDatabase();
    const activeUserId = "00000000-0000-4000-8000-000000000301";
    const suspendedUserId = "00000000-0000-4000-8000-000000000302";
    localDb.prepare(
      `INSERT INTO users (id, name, email) VALUES (?, ?, ?), (?, ?, ?)`,
    ).run(
      activeUserId, "Ada Teammate", "ada@rally.example",
      suspendedUserId, "Sam Teammate", "sam@rally.example",
    );
    localDb.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status)
       VALUES (?, ?, 'member', 'active'), (?, ?, 'member', 'suspended')`,
    ).run(WORKSPACE_ID, activeUserId, WORKSPACE_ID, suspendedUserId);

    const peopleSearch = await automationCreatorTool(localDb, workflowInput(), "people_search");
    const result = await peopleSearch.execute({ query: "teammate" }, { toolCallId: "people-1" } as never);

    expect(result.output).toMatchObject({
      people: [{ id: activeUserId, name: "Ada Teammate", email: "ada@rally.example" }],
    });
    const people = (result.output as { people: Array<{ id: string }> }).people;
    expect(people.some((person) => person.id === suspendedUserId)).toBe(false);
  });

  it("names the run's own person on a search that matches nobody, so \"me\" resolves", async () => {
    const localDb = localDatabase();
    localDb.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`)
      .run(USER_ID, "Ada Lovelace", "ada@rally.example");
    localDb.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status)
       VALUES (?, ?, 'member', 'active')`,
    ).run(WORKSPACE_ID, USER_ID);

    const peopleSearch = await automationCreatorTool(localDb, workflowInput(), "people_search");
    // The literal query that produced this: a run asked to notify the person
    // asking has no name to search for, and "me" is a substring of neither
    // "Ada Lovelace" nor "ada@rally.example". The match list is empty and must
    // stay empty — `you` is what carries the answer.
    const result = await peopleSearch.execute({ query: "me" }, { toolCallId: "people-me" } as never);

    expect(result.output).toMatchObject({
      you: { id: USER_ID, name: "Ada Lovelace", email: "ada@rally.example" },
      people: [],
    });
  });

  it("omits the run's own person when they are no longer an active member", async () => {
    const localDb = localDatabase();
    localDb.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`)
      .run(USER_ID, "Ada Lovelace", "ada@rally.example");
    localDb.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status)
       VALUES (?, ?, 'member', 'suspended')`,
    ).run(WORKSPACE_ID, USER_ID);

    const peopleSearch = await automationCreatorTool(localDb, workflowInput(), "people_search");
    const result = await peopleSearch.execute({ query: "ada" }, { toolCallId: "people-suspended" } as never);

    // The membership predicate is the same one the match list is filtered by:
    // `you` is a convenience over the directory, never a way around it.
    expect(result.output).toEqual({ people: [] });
  });

  it("returns only the containers an event can be narrowed to, with the plugin and relationship each is reached through", async () => {
    const localDb = localDatabase();
    localDb.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status)
       VALUES (?, ?, 'member', 'active')`,
    ).run(WORKSPACE_ID, USER_ID);
    // `granola` rather than `github` or `google`: it is registered
    // unconditionally in the connector registry, while the OAuth-backed
    // connectors register only when their client credentials are configured
    // in `env` — which this fixture deliberately does not set up, since the
    // catalog preparation this plugin always runs resolves every seeded
    // connection's adapter regardless of which tool a test calls.
    insertConnection(localDb, {
      id: "00000000-0000-4000-8000-000000000401",
      connectorType: "granola",
      scope: "workspace",
      ownerUserId: null,
      modelPluginId: "plugin_granola",
    });
    // Granola's `note.generated` declares a relationship to a folder and to
    // nothing else, so the folder is a rule's to name and the notes it produced
    // are not. The notes are `granola_note`, the type the connector actually
    // writes, and every one of them is newer than the folder.
    //
    // The count is the point. The page is fetched with `limit: 10`, so seeding
    // more than ten fresher notes is what separates the fix from a filter
    // applied after the fetch: post-filtering ten notes leaves an empty answer
    // and the folder still unreachable, which is the original defect exactly.
    // Two rows would let either implementation pass.
    const insertResource = localDb.prepare(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
          title, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'granola', ?, ?, ?, ?)`,
    );
    insertResource.run(
      "00000000-0000-4000-8000-000000000402", WORKSPACE_ID, "00000000-0000-4000-8000-000000000401",
      "granola_folder", "folder-1", "Automation catalog folder",
      "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z",
    );
    for (let index = 0; index < 14; index += 1) {
      insertResource.run(
        `00000000-0000-4000-8000-0000000005${String(index).padStart(2, "0")}`,
        WORKSPACE_ID, "00000000-0000-4000-8000-000000000401",
        "granola_note", `note-${index}`, `Automation catalog kickoff notes ${index}`,
        "2026-08-02T00:00:00.000Z", `2026-08-02T00:00:${String(index).padStart(2, "0")}.000Z`,
      );
    }

    const resourcesSearch = await automationCreatorTool(localDb, workflowInput(), "resources_search");
    const result = await resourcesSearch.execute(
      { query: "automation catalog" },
      { toolCallId: "resources-1" } as never,
    );

    expect(result.output).toEqual({
      searchableResourceTypes: ["granola_folder"],
      resources: [{
        id: "00000000-0000-4000-8000-000000000402",
        title: "Automation catalog folder",
        resourceType: "granola_folder",
        provider: "granola",
        pluginId: "plugin_granola",
        relationships: ["folder"],
        sourceBindingKeys: [],
      }],
    });
  });

  it("assigns resources to the matching Google bundle on a shared credential", async () => {
    const localDb = localDatabase();
    localDb.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status)
      VALUES (?, ?, 'member', 'active')`).run(WORKSPACE_ID, USER_ID);
    const connectionId = "00000000-0000-4000-8000-000000000601";
    insertConnection(localDb, {
      id: connectionId, connectorType: "google", scope: "workspace", ownerUserId: null,
      modelPluginId: "plugin_google", grantedScopes: ["gmail.read", "calendar.read", "drive.read", "docs.read"],
    });
    for (const [id, type] of [["00000000-0000-4000-8000-000000000602", "gmail_thread"],
      ["00000000-0000-4000-8000-000000000603", "google_doc"]]) {
      localDb.prepare(`INSERT INTO resources
        (id, workspace_id, connection_id, resource_type, provider, provider_resource_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'google', ?, 'Google bundle resource', ?, ?)`).run(
        id!, WORKSPACE_ID, connectionId, type!, id!, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z",
      );
    }
    const runtimeEnv = createTestEnv({ ...env(localDb),
      GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-client", GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-secret",
    });
    const selected = await __integrationTesting.loadHarnessTools(runtimeEnv, workflowInput());
    const search = selected.plugins.find((plugin) => plugin.canonicalId === "rally:sidekicks")!
      .tools.find((tool) => tool.definition.name === "resources_search")!;
    const result = await search.execute({ query: "Google bundle" }, { toolCallId: "google-resources" } as never);
    expect(result.output).toMatchObject({ resources: expect.arrayContaining([
      { id: "00000000-0000-4000-8000-000000000602", title: "Google bundle resource", resourceType: "gmail_thread",
        provider: "google", pluginId: "plugin_google_mail_calendar", relationships: ["thread"], sourceBindingKeys: [] },
      { id: "00000000-0000-4000-8000-000000000603", title: "Google bundle resource", resourceType: "google_doc",
        provider: "google", pluginId: "plugin_google_drive", relationships: ["file"], sourceBindingKeys: [] },
    ]) });
  });

  it("returns nothing rather than everything when the workspace's connectors declare no bindable resource", async () => {
    const localDb = localDatabase();
    localDb.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status)
       VALUES (?, ?, 'member', 'active')`,
    ).run(WORKSPACE_ID, USER_ID);
    // A generic webhook's events reach no container at all. Its resources are
    // therefore offerable to nobody, and an empty answer is the honest one:
    // the tool's own description tells the model to write the rule with a
    // filter field instead of hunting for an id that cannot exist.
    insertConnection(localDb, {
      id: "00000000-0000-4000-8000-000000000501",
      connectorType: "generic_webhook",
      scope: "workspace",
      ownerUserId: null,
      modelPluginId: "plugin_webhook",
      configJson: JSON.stringify({ eventTypes: ["order.created"] }),
    });
    localDb.prepare(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
          title, created_at, updated_at)
       VALUES (?, ?, ?, 'webhook_payload', 'generic_webhook', 'order-1',
               'Automation catalog order', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run("00000000-0000-4000-8000-000000000502", WORKSPACE_ID, "00000000-0000-4000-8000-000000000501");

    const resourcesSearch = await automationCreatorTool(localDb, workflowInput(), "resources_search");
    const result = await resourcesSearch.execute(
      { query: "automation catalog" },
      { toolCallId: "resources-2" } as never,
    );

    // Both halves matter to the model: nothing came back, and nothing could
    // have. An empty `searchableResourceTypes` is the only case in which
    // abandoning `resourceId` is the right read of an empty page.
    expect(result.output).toEqual({ searchableResourceTypes: [], resources: [] });
  });

  it("separates a query that matched nothing from a workspace where nothing could match", async () => {
    const localDb = localDatabase();
    localDb.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status)
       VALUES (?, ?, 'member', 'active')`,
    ).run(WORKSPACE_ID, USER_ID);
    insertConnection(localDb, {
      id: "00000000-0000-4000-8000-000000000601",
      connectorType: "granola",
      scope: "workspace",
      ownerUserId: null,
      modelPluginId: "plugin_granola",
    });
    localDb.prepare(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
          title, created_at, updated_at)
       VALUES (?, ?, ?, 'granola_folder', 'granola', 'folder-1',
               'Design review folder', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run("00000000-0000-4000-8000-000000000602", WORKSPACE_ID, "00000000-0000-4000-8000-000000000601");

    const resourcesSearch = await automationCreatorTool(localDb, workflowInput(), "resources_search");
    const result = await resourcesSearch.execute(
      { query: "quarterly planning" },
      { toolCallId: "resources-3" } as never,
    );

    // The folder the model wanted is one wording away. Answering this the same
    // as the webhook case above is how a search miss reaches a person as "the
    // automation system cannot bind this" — the sentence that produced the
    // incident this whole path exists to stop repeating.
    expect(result.output).toEqual({ searchableResourceTypes: ["granola_folder"], resources: [] });
  });
});
