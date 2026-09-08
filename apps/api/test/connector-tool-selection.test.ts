import { asAutomationId, asHarnessRunId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type {
  AutomationDetail,
  AutomationDraft,
  AutomationRunDefinitionV1,
  WorkstreamWorkflowInput,
} from "@rally/contracts";
import { runHarness, type HarnessEvent } from "@rally/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import { createMemoryTableTools } from "../src/services/memory-table-service";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestD1Result,
  createTestD1Results,
  createTestEnv,
} from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000003");
const USER_ID = asUserId("00000000-0000-4000-8000-000000000004");
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000005";
const WORKSPACE_CONNECTION_ID = "00000000-0000-4000-8000-000000000006";
const OWNER_CONNECTION_ID = "00000000-0000-4000-8000-000000000007";
const OTHER_CONNECTION_ID = "00000000-0000-4000-8000-000000000008";
const AUTOMATION_ID = asAutomationId("00000000-0000-4000-8000-000000000009");
const RUN_ID = "00000000-0000-4000-8000-000000000014";
const CHILD_HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000012");
const AUTOMATION_RESOURCE_ID = "00000000-0000-4000-8000-000000000013";
/** An automation this room owns, the one an edit from the room may name. */
const OWNED_AUTOMATION_ID = "00000000-0000-4000-8000-000000000015";
/** A second one, so a room's list is more than the single row it must contain. */
const SECOND_OWNED_AUTOMATION_ID = "00000000-0000-4000-8000-000000000016";
/** An automation another room owns, which no edit from this room may name. */
const FOREIGN_AUTOMATION_ID = "00000000-0000-4000-8000-000000000017";
const OTHER_WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000018");

const GOOGLE_WORKSPACE_CAPABILITIES = [
  "drive.read",
  "docs.read",
  "docs.write",
  "sheets.read",
  "sheets.write",
] as const;

const GOOGLE_WORKSPACE_TOOLS = [
  "drive.search",
  "drive.get_metadata",
  "drive.download",
  "drive.export",
  "docs.read_document",
  "docs.create_document",
  "docs.append_text",
  "docs.replace_text",
  "sheets.read_spreadsheet",
  "sheets.read_values",
  "sheets.create_spreadsheet",
  "sheets.update_values",
  "sheets.append_values",
] as const;

const GOOGLE_MAIL_CALENDAR_CAPABILITIES = [
  "gmail.read",
  "gmail.draft",
  "gmail.send",
  "calendar.read",
  "calendar.write",
] as const;

interface ConnectionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  connector_type: "google";
  scope: "personal" | "workspace";
  owner_user_id: string | null;
  granted_scopes_json: string;
  status: "healthy" | "error" | "needs_reconnect" | "disabled";
  created_at: string;
  model_plugin_id?: string;
  encrypted_credentials?: string;
  credential_iv?: string;
}

class ToolSelectionDatabase {
  readonly binding: D1Database;
  readonly connections: ConnectionRow[];
  /** Every `submitDefinition` request the automations plugin sent, in order. */
  readonly submittedDefinitions: Array<Record<string, unknown>> = [];
  /** The plugin defaults the automation's definition names; see {@link runDefinition}. */
  defaultPluginIds: string[] = [];
  readonly runDefinitionReads: Array<Record<string, unknown>> = [];
  readonly proposedDraftCards: Array<Record<string, unknown>> = [];
  /** Every `create` request, so an edit can be shown not to make a second automation. */
  readonly createdAutomations: Array<Record<string, unknown>> = [];
  /**
   * The runtime bootstrap and conversation provisioning a creation runs, on a
   * replay too: the D1 anchor batches, the `bootstrapRuntime` requests, and
   * the identity `provision` operations, each recorded rather than executed.
   * What they do is `test-workers/automation-do.test.ts`'s subject.
   */
  readonly anchorBatches: string[][] = [];
  readonly bootstrappedConversations: Array<Record<string, unknown>> = [];
  readonly provisionedConversations: Array<Record<string, unknown>> = [];
  /** Every `readDetail` request the directory port sent, in order. */
  readonly detailReads: Array<Record<string, unknown>> = [];
  /** Every `listWorkstreamAutomations` request, in order. */
  readonly workstreamAutomationListReads: Array<Record<string, unknown>> = [];
  /** Which work stream owns each automation, keyed by automation id. */
  readonly automationOwners = new Map<string, string>();
  /** The automations each work stream's rail lists, keyed by work-stream id. */
  readonly workstreamAutomations = new Map<string, string[]>();
  /** What each automation answers `readDetail` with, keyed by automation id. */
  readonly automationDetails = new Map<string, AutomationDetail>();
  readonly replayOutputs = new Map<string, unknown>();
  memberStatus = "active";

  constructor(
    connections: ConnectionRow[],
    /** The definition's connector bindings, capability to connection; see {@link runDefinition}. */
    readonly automationBindings: Array<{ capability: string; connection_id: string }> = [],
    readonly attachedConnectionIds: string[] = [],
  ) {
    const counts = new Map<string, number>();
    this.connections = connections.map((row) => {
      const base = "plugin_google";
      const key = `${row.workspace_id}:${base}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      row.model_plugin_id ??= count === 1 ? base : `${base}_${count}`;
      return row;
    });
    this.binding = createTestD1Database({
      prepare: (sql: string) => createTestD1PreparedStatement(new ToolSelectionStatement(this, sql)),
      // The regional anchor and route a creation's bootstrap writes.
      batch: async (statements: D1PreparedStatement[]) => {
        this.anchorBatches.push(statements.map((statement) =>
          (statement as unknown as ToolSelectionStatement).describe()
        ));
        return createTestD1Results(statements.map(() => ({ success: true, results: [] })));
      },
    });
    // Which resources this work stream has attached is the object's answer now,
    // and which connection owns each of them is the workspace's. The fixture
    // still names connections, because that is what these tests are about; one
    // attached resource stands for each, seeded where the port will read it.
    seedWorkstreamObjectRoot(this.objectStore, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    });
    for (const connectionId of this.attachedConnectionIds) {
      this.objectStore.prepare(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, NULL, 0, 'attachment', '{}', 1, 1)`,
      ).run(resourceFor(connectionId));
    }
  }

  readonly objectStore = testWorkstreamObjectStore();
  /** The helper's own stub, for the identity reads the room's tools make. */
  private readonly roomAgent = (() => {
    const binding = testSubstreamAgentsBinding(this.objectStore);
    return binding.get(binding.idFromName("room")) as unknown as {
      executeIdentityOperation(request: unknown): unknown;
    };
  })();
  readonly agents = testSubstreamAgentsBinding(this.objectStore, {
    extra: {
      appendDraftProposedCard: vi.fn(async (request: Record<string, unknown>) => {
        this.proposedDraftCards.push(request);
      }),
      // A created automation's own conversation is opened and provisioned on
      // the shared object store's binding; recorded, not executed, because
      // the store here is the room's and the helper would seed a second root
      // into it.
      bootstrapRuntime: vi.fn(async (request: Record<string, unknown>) => {
        this.bootstrappedConversations.push(request);
        return { status: 200, bodyJson: "{}" };
      }),
      executeIdentityOperation: vi.fn(async (request: { operation: string } & Record<string, unknown>) => {
        if (request.operation !== "provision") {
          return this.roomAgent.executeIdentityOperation(request);
        }
        this.provisionedConversations.push(request);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: null }) };
      }),
    },
  });

  /**
   * The workspace, for the two directory reads a room's automation edit makes:
   * who owns the automation the model named, and which ones the room owns.
   */
  readonly workspaces = testSubstreamAgentsBinding(this.objectStore, {
    extra: {
      automationOwner: vi.fn(async (request: Record<string, unknown>) => ({
        owningWorkstreamId: this.automationOwners.get(String(request.automationId)) ?? null,
      })),
      listWorkstreamAutomations: vi.fn(async (request: Record<string, unknown>) => {
        this.workstreamAutomationListReads.push(request);
        const ids = this.workstreamAutomations.get(String(request.workstreamId)) ?? [];
        return {
          items: ids.map((id) => {
            const detail = this.automationDetails.get(id);
            return {
              id,
              name: detail?.name ?? "Unnamed",
              description: detail?.description ?? "",
              emailAddress: null,
              status: detail?.status ?? "draft",
              nextRunAt: null,
              lastRunAt: null,
              updatedAt: detail?.updatedAt ?? "2026-08-01T00:00:00.000Z",
            };
          }),
        };
      }),
    },
  });
}

/** The one resource standing in for an attached connection. */
function resourceFor(connectionId: string): string {
  return `resource-for-${connectionId}`;
}

class ToolSelectionStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: ToolSelectionDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): ToolSelectionStatement {
    this.values = values;
    return this;
  }

  /** The statement's SQL with its whitespace collapsed, for a batch's record. */
  describe(): string {
    return this.sql.replace(/\s+/gu, " ").trim();
  }

  async all<T>(): Promise<D1Result<T>> {
    const sql = this.sql.replace(/\s+/gu, " ").trim();
    let results: unknown[];
    if (sql.includes("SELECT DISTINCT connection_id FROM resources")) {
      const requested = new Set(this.values.slice(1).map(String));
      results = this.database.attachedConnectionIds
        .filter((connectionId) => requested.has(resourceFor(connectionId)))
        .map((connection_id) => ({ connection_id }));
    } else if (sql.includes("FROM connector_connections")) {
      if (sql.includes("(scope = 'workspace' OR (scope = 'personal'")) {
        expect(this.values).toEqual([WORKSPACE_ID, USER_ID]);
        results = this.database.connections.filter((row) =>
          row.workspace_id === WORKSPACE_ID && row.status === "healthy" &&
          (row.scope === "workspace" || row.owner_user_id === USER_ID)
        );
      } else {
        expect(this.values).toEqual([WORKSPACE_ID]);
        results = this.database.connections;
      }
    } else {
      throw new Error(`Unexpected tool-selection query: ${sql}`);
    }
    return createTestD1Result<T>({ success: true, results });
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql.replace(/\s+/gu, " ").trim();
    if (sql.includes("SELECT role FROM workspace_members")) return { role: "member" } as T;
    if (sql.includes("FROM workspace_members wm")) {
      expect(this.values).toEqual([WORKSPACE_ID, USER_ID]);
      return { status: this.database.memberStatus } as T;
    }
    if (sql.includes("FROM connector_connections") && sql.includes("WHERE id = ? AND workspace_id = ?")) {
      const [connectionId, workspaceId] = this.values;
      return (this.database.connections.find((row) =>
        row.id === connectionId && row.workspace_id === workspaceId
      ) ?? null) as T | null;
    }
    if (sql.includes("SELECT id FROM workspaces")) {
      return { id: WORKSPACE_ID } as T;
    }
    // The bootstrap's schema probe: no legacy `title` column, so the anchor
    // takes its final shape.
    if (sql.includes("FROM pragma_table_info('workstreams')")) {
      return null;
    }
    throw new Error(`Unexpected tool-selection first query: ${sql}`);
  }
}

function connection(
  id: string,
  scope: "personal" | "workspace",
  ownerUserId: string | null,
  capabilities: readonly string[] = GOOGLE_WORKSPACE_CAPABILITIES,
  createdAt = "2026-08-01T00:00:00.000Z",
  workspaceId = WORKSPACE_ID,
): ConnectionRow {
  return {
    id,
    workspace_id: workspaceId,
    connector_type: "google",
    scope,
    owner_user_id: ownerUserId,
    granted_scopes_json: JSON.stringify(capabilities),
    cursor_json: "{}",
    config_json: "{}",
    status: "healthy",
    created_at: createdAt,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function env(database: ToolSelectionDatabase): Env {
  return createTestEnv({
    DB: database.binding,
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({
      get: vi.fn(async (key: string) => {
        if (!database.replayOutputs.has(key)) return null;
        return {
          text: async () => JSON.stringify({
            replayVersion: 1,
            output: database.replayOutputs.get(key),
          }),
        };
      }),
    }),
    SUBSTREAM_AGENTS: database.agents,
    AUTOMATION_DOS: testSubstreamAgentsBinding(database.objectStore, {
      extra: {
        // Answered as already existing. The Worker still bootstraps and
        // provisions the automation's own conversation on a replay, and the
        // doubles above record that rather than run it: creating an
        // automation from a room is `test-workers/automation-do.test.ts`'s
        // subject, and what this file proves about a submission is what
        // reaches `submitDefinition`.
        create: vi.fn(async (request: Record<string, unknown>) => {
          database.createdAutomations.push(request);
          return { created: false };
        }),
        saveDefinition: vi.fn(async (request: Record<string, unknown>) => {
          database.submittedDefinitions.push(request);
          return { definitionRevision: 1 };
        }),
        // The definition an edit starts from. One shared stub answers for every
        // automation id, so the fixture keyed by the requested id is what
        // decides whether a read reached the automation the caller meant.
        readDetail: vi.fn(async (request: Record<string, unknown>) => {
          database.detailReads.push(request);
          const detail = database.automationDetails.get(String(request.automationId));
          if (!detail) throw new Error(`no_automation_detail_fixture:${String(request.automationId)}`);
          return detail;
        }),
        // A run reads its definition from its automation by revision when it
        // starts; the plugin defaults it preloads come from there.
        readRunDefinition: vi.fn(async (request: Record<string, unknown>) => {
          database.runDefinitionReads.push(request);
          return runDefinition(database);
        }),
      },
    }),
    WORKSPACE_DOS: database.workspaces,
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-connector-client",
    GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-connector-secret",
    CONNECTOR_CREDENTIALS_KEY: "must-not-be-used-after-revocation",
    AVALON_REGION: "global",
  });
}

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
    reason: "Ad-hoc test",
  };
}

/**
 * A run under an automation: the automation is the parent, the run its child
 * substream, and the loop carries a reference to the definition rather than a
 * copy of it.
 */
function automationRunInput(reason = "Automation test"): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "automation",
    parentId: AUTOMATION_ID,
    substreamId: asSubstreamId(RUN_ID),
    loopId: `workstream:${AUTOMATION_ID}:substream:${RUN_ID}:loop`,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason,
    automationRun: {
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      runId: RUN_ID,
      definitionRevision: 1,
      trigger: { kind: "manual", requestedByUserId: USER_ID },
    },
  };
}

/**
 * An automation's own conversation: the automation is the parent and the chat
 * is its main substream, with no run in flight. This is the loop that drafts
 * and edits that one automation, so the drafting tools are registered here;
 * a run under the same parent carries `automationRun` and gets none.
 */
function automationConversationInput(): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "automation",
    parentId: AUTOMATION_ID,
    loopId: `workstream:${AUTOMATION_ID}:substream:0:loop`,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "Automation chat test",
  };
}

/** A submittable draft with no trigger that needs a plugin or an evaluator. */
function manualDraft(name: string): AutomationDraft {
  return {
    name,
    description: `${name}, on request.`,
    overview: `Runs ${name} when somebody asks for it.`,
    instructions: `Do ${name}.`,
    triggers: [{ type: "manual" }],
    requiredCapabilities: [],
    expectedOutputs: [],
    defaultBehavior: {},
    recommendedPlugins: [],
    memoryTables: [],
    suggestedScope: "workstream",
    followUpQuestion: null,
    elicitation: null,
    ready: true,
  };
}

/** What one automation answers `readDetail` with. */
function automationDetail(
  automationId: string,
  name: string,
  overrides: Partial<AutomationDetail> = {},
): AutomationDetail {
  return {
    id: automationId,
    loadable: false,
    runnable: true,
    name,
    description: `${name}, on request.`,
    emailAddress: null,
    scope: "workstream",
    owningWorkstreamId: WORKSTREAM_ID,
    status: "active",
    nextRunAt: null,
    lastRunAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    lifecycle: "active",
    authorUserId: USER_ID,
    runAsUserId: USER_ID,
    currentDefinition: manualDraft(name),
    currentDefinitionRevision: 3,
    acceptedDefinitionRevision: 2,
    connectorBindings: {},
    recentRuns: [],
    ...overrides,
  };
}

/** One drafting tool from a run's assembled surface, by name. */
async function automationCreatorTool(
  database: ToolSelectionDatabase,
  input: WorkstreamWorkflowInput,
  name: string,
): Promise<Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>["tools"][number]> {
  const selected = await __integrationTesting.loadHarnessTools(env(database), input);
  const plugin = selected.plugins.find((candidate) => candidate.canonicalId === "rally:automations");
  if (!plugin) throw new Error("automations_plugin_missing");
  const tool = plugin.tools.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`automation_creator_tool_missing:${name}`);
  return tool;
}

/** The definition the automation answers a run's read with. */
function runDefinition(database: ToolSelectionDatabase): AutomationRunDefinitionV1 {
  return {
    schemaVersion: 1,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    definitionRevision: 1,
    definition: {
      name: "Drive digest",
      description: "Summarize new files.",
      overview: "Watch Drive and summarize what is new.",
      instructions: "Summarize the new files.",
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
    },
    defaultPluginIds: database.defaultPluginIds,
    activitySourcePluginIds: {},
    connectorBindings: Object.fromEntries(
      database.automationBindings.map((binding) => [binding.capability, binding.connection_id]),
    ),
    scope: "personal",
    owningWorkstreamId: null,
    runAsUserId: USER_ID,
    modelOverride: null,
    trigger: { kind: "manual", requestedByUserId: USER_ID },
    opening: null,
    state: "running",
  };
}

/**
 * Check every `<wire name> {json}` call in a plugin message against the input
 * schema of the tool it names, returning one description per mismatch.
 *
 * A worked example is documentation the model executes, so it decays exactly
 * like code and silently: renaming a parameter or a result key leaves the
 * example compiling, passing a substring assertion, and teaching a call that
 * now fails.
 */
function workedExampleCallsAgainstSchemas(
  plugin: {
    modelId: string;
    systemMessage?: string | undefined;
    tools: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>["tools"];
  },
): string[] {
  const { tools } = plugin;
  const systemMessage = plugin.systemMessage ?? "";
  // Derived, not assumed: a second credential of the same provider is
  // `google_2_…`, and hardcoding the first one's prefix made this check
  // silently validate nothing for every plugin but the first.
  const wirePrefix = plugin.modelId.replace(/^plugin_/u, "");
  const schemas = new Map(tools.map((tool) => {
    const schema = tool.definition.inputSchema as { properties?: Record<string, unknown> };
    return [
      `${wirePrefix}_${tool.definition.name.replace(".", "_")}`,
      new Set(Object.keys(schema.properties ?? {})),
    ];
  }));
  const problems: string[] = [];
  let found = 0;
  for (const match of systemMessage.matchAll(/`(google[a-z0-9_]*) (\{.*?\})`/gu)) {
    const [, wireName, json] = match;
    const properties = schemas.get(wireName!);
    if (!properties) {
      problems.push(`${wireName} is not a tool on this plugin`);
      continue;
    }
    found += 1;
    for (const key of Object.keys(JSON.parse(json!) as Record<string, unknown>)) {
      if (!properties.has(key)) problems.push(`${wireName} has no ${key} parameter`);
    }
  }
  if (found === 0) problems.push("no worked example calls were found to check");
  return problems;
}

function googleToolNames(tools: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>["tools"]): string[] {
  return tools
    .map((tool) => tool.definition.name)
    .filter((name) => (GOOGLE_WORKSPACE_TOOLS as readonly string[]).includes(name));
}

function pluginConnectionIds(
  selected: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>,
): string[] {
  return selected.plugins
    .filter((plugin) => plugin.canonicalId.startsWith("connection:"))
    .map((plugin) => plugin.canonicalId.slice("connection:".length));
}

function childWorkflowInput(parent = workflowInput()): WorkstreamWorkflowInput {
  return {
    ...parent,
    harnessRunId: CHILD_HARNESS_RUN_ID,
    reason: "sub_agent",
  };
}

describe("connector tools selected for harness runs", () => {
  it("registers multimodal generation only when the main Azure inference deployment is configured", async () => {
    const database = new ToolSelectionDatabase([]);
    const withoutAzure = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    expect(withoutAzure.plugins.some((plugin) => plugin.canonicalId === "rally:multimodal-generation")).toBe(false);

    const withAzure = await __integrationTesting.loadHarnessTools(createTestEnv({
      ...env(database),
      AZURE_INFERENCE_ENDPOINT: "https://monad-prod-resource.services.ai.azure.com",
      AZURE_INFERENCE_API_KEY: "azure-test-key",
    }), workflowInput());
    const plugin = withAzure.plugins.find((candidate) => candidate.canonicalId === "rally:multimodal-generation");

    expect(plugin).toMatchObject({
      modelId: "rally_multimodal_generation",
      preload: false,
      explicit: false,
    });
    expect(plugin?.tools.map((tool) => tool.definition.name)).toEqual(["generate_image", "edit_image", "generate_audio"]);
    expect(withAzure.idempotencyByTool.get("multimodal_generation_generate_image")).toBe("record_before_execute");
    expect(withAzure.modeByTool.get("multimodal_generation_edit_image")).toBe("write");
    expect(withAzure.idempotencyByTool.get("multimodal_generation_generate_audio")).toBe("record_before_execute");
    expect(withAzure.modeByTool.get("multimodal_generation_generate_audio")).toBe("write");
  });

  it("authorizes every built-in plugin this run registered and denies unregistered or invented ids", async () => {
    const database = new ToolSelectionDatabase([]);
    const selected = await __integrationTesting.loadHarnessTools(createTestEnv({
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
      AZURE_INFERENCE_ENDPOINT: "https://monad-prod-resource.services.ai.azure.com",
      AZURE_INFERENCE_API_KEY: "azure-test-key",
    }), workflowInput());

    // Derived from the registered surface rather than a list repeated here: a
    // built-in added later is covered by this test on the day it registers,
    // which is the property whose absence let image generation ship denied.
    const registeredBuiltinIds = selected.plugins
      .filter((plugin) => !selected.frozenConnections.has(plugin.canonicalId))
      .map((plugin) => plugin.canonicalId);
    expect(registeredBuiltinIds).toContain("rally:multimodal-generation");
    expect(registeredBuiltinIds).toContain("rally:web");
    expect(registeredBuiltinIds).toContain("rally:workstream");
    // The derivation this change made load-bearing, checked against a set the
    // test built without it: a built-in registered under a `connection:` id
    // would be counted by one and not the other.
    expect(selected.builtinPluginIds).toEqual(new Set(registeredBuiltinIds));
    for (const pluginId of registeredBuiltinIds) {
      expect(__integrationTesting.builtinPluginAuthorization(pluginId, selected)).toBe("authorized");
    }

    // Terminal is absent without its provider configuration, so a restored
    // activation hint naming it, or an id the model invented, must fail closed.
    expect(registeredBuiltinIds).not.toContain("rally:terminal");
    expect(__integrationTesting.builtinPluginAuthorization("rally:terminal", selected)).toBe("denied");
    expect(__integrationTesting.builtinPluginAuthorization("rally:not-a-plugin", selected)).toBe("denied");
  });

  it("resolves durable receipt policy from canonical identity, never a provider wire alias", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);
    const selected = await __integrationTesting.loadHarnessTools(createTestEnv({
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    }), workflowInput());

    const listPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:discovery",
      canonicalToolName: "list_plugins",
      capability: "rally.plugins.list",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const loadPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:discovery",
      canonicalToolName: "load_plugin",
      capability: "rally.plugins.load",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const timePolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:core",
      canonicalToolName: "current_time",
      capability: "time.read",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const workstreamPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:workstream",
      canonicalToolName: "list_resources",
      capability: "workstream.resources.list",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const webPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: "rally:web",
      canonicalToolName: "search",
      capability: "web.search",
      mode: "read",
      idempotency: "safe",
    }, selected);
    const googlePluginId = `connection:${WORKSPACE_CONNECTION_ID}`;
    const googlePolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: googlePluginId,
      canonicalToolName: "drive.search",
      capability: "drive.read",
      mode: "read",
      idempotency: "safe",
    }, selected);

    expect(listPolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(loadPolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(timePolicy).toMatchObject({ connectionId: null, definition: { mode: "read", idempotency: "safe" } });
    expect(workstreamPolicy).toMatchObject({
      pluginId: "rally:workstream",
      connectionId: null,
      toolSurfaceHash: expect.any(String),
      definition: { name: "list_resources", mode: "read", idempotency: "safe" },
    });
    expect(webPolicy).toMatchObject({
      pluginId: "rally:web",
      connectionId: null,
      toolSurfaceHash: expect.any(String),
      definition: { name: "search", mode: "read", idempotency: "safe" },
    });
    expect(googlePolicy).toMatchObject({
      pluginId: googlePluginId,
      connectionId: WORKSPACE_CONNECTION_ID,
      definition: { name: "drive.search", mode: "read", idempotency: "safe" },
      legacyReceiptIdentity: {
        canonicalToolName: "google.drive.search",
        toolSurfaceHash: expect.any(String),
      },
    });
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: googlePolicy.pluginId,
      canonicalToolName: googlePolicy.definition.name,
      capability: googlePolicy.definition.capability,
      mode: googlePolicy.definition.mode,
      idempotency: googlePolicy.definition.idempotency,
      connectionId: googlePolicy.connectionId,
      toolSurfaceHash: googlePolicy.toolSurfaceHash,
    }), googlePolicy)).toBe(true);
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: googlePolicy.pluginId,
      canonicalToolName: googlePolicy.legacyReceiptIdentity?.canonicalToolName,
      capability: googlePolicy.definition.capability,
      mode: googlePolicy.definition.mode,
      idempotency: googlePolicy.definition.idempotency,
      connectionId: googlePolicy.connectionId,
      toolSurfaceHash: googlePolicy.legacyReceiptIdentity?.toolSurfaceHash,
    }), googlePolicy)).toBe(true);
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: googlePolicy.pluginId,
      canonicalToolName: googlePolicy.legacyReceiptIdentity?.canonicalToolName,
      capability: googlePolicy.definition.capability,
      mode: googlePolicy.definition.mode,
      idempotency: googlePolicy.definition.idempotency,
      connectionId: googlePolicy.connectionId,
      toolSurfaceHash: googlePolicy.toolSurfaceHash,
    }), googlePolicy)).toBe(false);
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({
      pluginId: googlePolicy.pluginId,
      canonicalToolName: googlePolicy.definition.name,
      capability: googlePolicy.definition.capability,
      mode: "write",
      idempotency: "record_before_execute",
      connectionId: googlePolicy.connectionId,
      toolSurfaceHash: googlePolicy.toolSurfaceHash,
    }), googlePolicy)).toBe(false);
    expect(() => __integrationTesting.resolveHarnessToolReceiptPolicy({
      pluginId: googlePluginId,
      canonicalToolName: "drive.search",
      capability: "drive.read",
      mode: "write",
      idempotency: "record_before_execute",
    }, selected)).toThrow("outside this run scope");
  });

  it("installs one durable read-only sub-agent tool into the root core surface", async () => {
    const database = new ToolSelectionDatabase([]);
    const parentInput = workflowInput();
    const selected = await __integrationTesting.loadHarnessTools(env(database), parentInput);

    const tool = await __integrationTesting.installInlineChildAgentTool({
      env: env(database),
      input: parentInput,
      parentLease: () => ({
        attemptId: "attempt-parent",
        owner: "owner-parent",
        attemptNumber: 1,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
      parentSignal: new AbortController().signal,
      runAuthoritySnapshot: {
        automationRunId: null,
        automationTemplateVersionId: null,
        triggerType: null,
      },
      harnessTools: selected,
      activeCredentialPluginIds: new Set(),
    });

    expect(tool.definition).toMatchObject({
      name: "run_subagent",
      capability: "subagent.run",
      mode: "read",
      idempotency: "safe",
    });
    expect(selected.coreTools.filter(({ definition }) =>
      definition.name === "run_subagent"
    )).toHaveLength(1);
    expect(selected.corePlugins.map((plugin) => plugin.canonicalId)).toEqual([
      "rally:core",
      "rally:tables",
      "rally:memory",
    ]);
    expect(selected.corePlugins.find((plugin) => plugin.canonicalId === "rally:core")
      ?.tools.map(({ definition }) => definition.name)).toEqual([
        "current_time",
        "request_elicitation",
      ]);
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === "rally:workstream"
    )?.tools.filter(({ definition }) => definition.name === "run_subagent")).toHaveLength(1);
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === "rally:workstream"
    )).toMatchObject({
      modelId: "rally_workstream",
      shortWireName: "workstream",
      preload: true,
      explicit: true,
    });
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === "rally:workstream"
    )?.tools.map(({ definition }) => definition.name)).toEqual(expect.arrayContaining([
      "list_resources",
      "read_resource",
      "search_resource",
      "run_subagent",
    ]));
    expect(selected.tools.filter(({ definition }) =>
      definition.name === "run_subagent"
    )).toHaveLength(1);
    expect(selected.modeByTool.get("workstream_run_subagent")).toBe("read");
    expect(selected.idempotencyByTool.get("workstream_run_subagent")).toBe("safe");
  });

  it("builds a non-recursive read-only child surface from only inherited active plugins", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID),
    ]);
    const parentInput = workflowInput();
    const runtimeEnv = createTestEnv({
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    });
    const parentTools = await __integrationTesting.loadHarnessTools(runtimeEnv, parentInput);
    // Every work-stream run can draft an automation, so the plugin is on the
    // parent surface — deferred, so being here costs a catalog entry and no
    // connector read until somebody loads it.
    expect(parentTools.plugins.map((plugin) => plugin.canonicalId))
      .toContain("rally:automations");
    expect(parentTools.plugins).toHaveLength(5);
    expect(parentTools.plugins.flatMap((plugin) => plugin.tools)
      .some((tool) => tool.definition.mode === "write")).toBe(true);

    const childTools = await __integrationTesting.createInlineChildHarnessSurface({
      env: runtimeEnv,
      parentInput,
      childInput: childWorkflowInput(parentInput),
      parentHarnessTools: parentTools,
      selectedPluginIds: [`connection:${WORKSPACE_CONNECTION_ID}`],
      assertChildOwned: async () => undefined,
    });

    // Not inherited: this surface is read-only and non-recursive, and drafting
    // an automation is a write a child running on somebody's behalf must not
    // make on its own.
    expect(childTools.plugins.map((plugin) => plugin.canonicalId)).toEqual([
      "rally:workstream",
      "rally:web",
      `connection:${WORKSPACE_CONNECTION_ID}`,
    ]);
    expect(childTools.plugins[0]).toMatchObject({ preload: true, explicit: true });
    expect(childTools.plugins[1]).toMatchObject({ preload: false, explicit: false });
    expect(childTools.plugins[2]).toMatchObject({ preload: true, explicit: true });
    expect(childTools.tools.every((tool) => tool.definition.mode === "read")).toBe(true);
    expect(childTools.plugins[2]?.tools.map((tool) => tool.definition.name)).toEqual([
      "drive.search",
      "drive.get_metadata",
      "drive.download",
      "drive.export",
      "docs.read_document",
      "sheets.read_spreadsheet",
      "sheets.read_values",
    ]);
    expect(childTools.coreTools.map((tool) => tool.definition.name)).toEqual([
      "list_resources",
      "read_resource",
      "search",
      "fetch",
      "search_resource",
      "view_resource",
      "summarize_resource",
      // Read-only and safe to repeat, so a read-only child inherits them like
      // every other resource read.
      "describe_artifact_data",
      "query_artifact_data",
      "current_time",
    ]);
    expect(childTools.coreTools.some((tool) => tool.definition.capability.startsWith("memory.")))
      .toBe(false);
    expect(childTools.corePlugins.map((plugin) => plugin.canonicalId)).toEqual([
      "rally:core",
    ]);
    expect(childTools.tools.map((tool) => tool.definition.name)).not.toContain("run_subagent");
    expect(childTools.frozenConnections.has(`connection:${OWNER_CONNECTION_ID}`)).toBe(false);
    expect(childTools.frozenConnections.has(`connection:${WORKSPACE_CONNECTION_ID}`)).toBe(true);
    expect(__integrationTesting.eligibleConnectionCapabilityMap(
      childTools.plugins,
      childTools.frozenConnections,
    )).toEqual({
      [WORKSPACE_CONNECTION_ID]: childTools.plugins[2]?.tools.map((tool) =>
        tool.definition.capability),
    });
  });

  it("shares a durable connector activation with ready automation validation", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);
    database.objectStore.prepare(
      `INSERT INTO runs
         (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
          next_action_cursor, input_fence_seq, revision, started_at,
          active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count,
          retry_count, tool_count, input_tokens, output_tokens, cost_micros,
          output_bytes, created_at, updated_at)
       VALUES (?, '0', 'running', '{}', 0, 0, '', 0, 0, 1,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`,
    ).run(HARNESS_RUN_ID);
    database.objectStore.prepare(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
          tool_name, mode, request_hash, authority_revision, status, tool_call_id,
          connection_id, input_json, output_summary, execution_plan_json,
          started_at, settled_at)
       VALUES (?, ?, 0, 1, ?, 'automation_plugin_inspect', 'read', ?,
               'development_fixture', 'completed', 'inspect-before-eviction',
               NULL, ?, 'Inspected Google', ?, 1, 2)`,
    ).run(
      "persisted-automation-inspection",
      HARNESS_RUN_ID,
      "development_fixture:persisted-automation-inspection",
      "persisted-inspection-input",
      JSON.stringify({ pluginId: "plugin_google" }),
      JSON.stringify({
        canonicalToolName: "plugin_inspect",
        capability: "rally.automation.plugins.inspect",
      }),
    );
    database.objectStore.prepare(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
          tool_name, mode, request_hash, authority_revision, status, tool_call_id,
          connection_id, input_json, output_ref, output_summary, execution_plan_json,
          started_at, settled_at)
       VALUES (?, ?, 0, 2, ?, 'automation_resources_search', 'read', ?,
               'development_fixture', 'completed', 'resources-before-eviction',
               NULL, ?, ?, 'Found a mail thread', ?, 2, 3)`,
    ).run(
      "persisted-automation-resources",
      HARNESS_RUN_ID,
      "development_fixture:persisted-automation-resources",
      "persisted-resource-input",
      JSON.stringify({ query: "mail thread" }),
      "replay/automation-resources",
      JSON.stringify({
        canonicalToolName: "resources_search",
        capability: "rally.automation.resources.search",
      }),
    );
    database.replayOutputs.set("replay/automation-resources", {
      resources: [{
        id: AUTOMATION_RESOURCE_ID,
        pluginId: "plugin_google",
        resourceType: "gmail_thread",
        sourceBindingKeys: ["google_source"],
      }],
    });
    const evaluatorRules = {
      schemaVersion: 1,
      evaluators: [{
        evaluatorKey: "mail_received",
        source: {
          sourceBindingKey: "google_source",
          suggestedSourcePluginId: "plugin_google",
          resourceId: AUTOMATION_RESOURCE_ID,
          event: { kind: "event_type", eventType: "email.received" },
        },
        when: { kind: "always" },
      }],
    };
    database.objectStore.prepare(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
          tool_name, mode, request_hash, authority_revision, status, tool_call_id,
          connection_id, input_json, output_summary, execution_plan_json,
          started_at, settled_at)
       VALUES (?, ?, 0, 3, ?, 'automation_set_evaluator_rules', 'write', ?,
               'development_fixture', 'completed', 'rules-before-eviction',
               NULL, ?, 'Stored evaluator rules', ?, 2, 3)`,
    ).run(
      "persisted-automation-evaluators",
      HARNESS_RUN_ID,
      "development_fixture:persisted-automation-evaluators",
      "persisted-evaluator-input",
      JSON.stringify(evaluatorRules),
      JSON.stringify({
        canonicalToolName: "set_evaluator_rules",
        capability: "rally.automation.evaluators.set",
      }),
    );
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const automations = selected.plugins.find((plugin) =>
      plugin.canonicalId === "rally:automations"
    );
    if (!automations) throw new Error("automations_plugin_missing");
    // A restored durable activation skips onActivate. Its first tool still has
    // to rebuild completed authoring facts before validating the draft.
    const submit = automations.tools.find((tool) =>
      tool.definition.name === "submit_draft"
    );
    if (!submit) throw new Error("automation_creator_tools_missing");

    const readyDraft = {
      name: "New mail summary",
      description: "Summarize new mail.",
      overview: "Reports newly received messages.",
      instructions: "Summarize the message.",
      triggers: [{
        type: "connector_activity",
        connectorType: "google",
        sourceBindingKey: "google_source",
        suggestedSourcePluginId: "plugin_google",
        eventTypes: ["email.received"],
        deterministicFilters: {},
      }],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    };
    await expect(submit.execute(readyDraft, { toolCallId: "submit-before-load" } as never))
      .rejects.toThrow("Load and inspect plugin_google");

    const activeCredentialPluginIds = new Set<string>();
    __integrationTesting.recordCredentialPluginActivation(
      `connection:${WORKSPACE_CONNECTION_ID}`,
      selected.frozenConnections,
      activeCredentialPluginIds,
      selected.loadedAutomationPluginIds,
    );

    expect(activeCredentialPluginIds).toEqual(new Set([`connection:${WORKSPACE_CONNECTION_ID}`]));
    expect(selected.loadedAutomationPluginIds).toEqual(new Set(["plugin_google"]));
    const setEvaluatorRules = automations.tools.find((tool) =>
      tool.definition.name === "set_evaluator_rules"
    );
    if (!setEvaluatorRules) throw new Error("automation_evaluator_tools_missing");
    await expect(setEvaluatorRules.execute(
      evaluatorRules,
      { toolCallId: "reset-rules-after-eviction" } as never,
    )).resolves.toMatchObject({ output: { accepted: true } });
    await expect(submit.execute(readyDraft, { toolCallId: "submit-after-load" } as never))
      .resolves.toMatchObject({ output: { accepted: true } });
    expect(database.submittedDefinitions).toHaveLength(1);
    expect(database.submittedDefinitions[0]).toMatchObject({
      automationId: HARNESS_RUN_ID,
      evaluatorRules,
    });
    expect(database.proposedDraftCards).toHaveLength(0);

    __integrationTesting.forgetCredentialPluginActivation(
      { name: `connection:${WORKSPACE_CONNECTION_ID}`, reason: "socket_closed" },
      selected.frozenConnections,
      activeCredentialPluginIds,
      selected.loadedAutomationPluginIds,
    );
    expect(activeCredentialPluginIds).toEqual(new Set());
    expect(selected.loadedAutomationPluginIds).toEqual(new Set());
    await expect(submit.execute(readyDraft, { toolCallId: "submit-after-drop" } as never))
      .rejects.toThrow("Load and inspect plugin_google");

    const replacement = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    __integrationTesting.recordCredentialPluginActivation(
      `connection:${WORKSPACE_CONNECTION_ID}`,
      replacement.frozenConnections,
      new Set(),
      replacement.loadedAutomationPluginIds,
    );
    const replacementSubmit = replacement.plugins.find((candidate) =>
      candidate.canonicalId === "rally:automations"
    )?.tools.find((tool) => tool.definition.name === "submit_draft");
    if (!replacementSubmit) throw new Error("replacement_automation_creator_tools_missing");
    await expect(replacementSubmit.execute(
      readyDraft,
      { toolCallId: "submit-after-eviction" } as never,
    )).resolves.toMatchObject({ output: { accepted: true } });
    expect(database.submittedDefinitions.map((draft) => draft.automationId))
      .toEqual([HARNESS_RUN_ID, HARNESS_RUN_ID]);
    expect(database.proposedDraftCards).toHaveLength(0);
  });

  it("drops a replayed rule's sentinel resourceId before it can reach the next revision", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);
    database.objectStore.prepare(
      `INSERT INTO runs
         (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
          next_action_cursor, input_fence_seq, revision, started_at,
          active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count,
          retry_count, tool_count, input_tokens, output_tokens, cost_micros,
          output_bytes, created_at, updated_at)
       VALUES (?, '0', 'running', '{}', 0, 0, '', 0, 0, 1,
               0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`,
    ).run(HARNESS_RUN_ID);
    database.objectStore.prepare(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
          tool_name, mode, request_hash, authority_revision, status, tool_call_id,
          connection_id, input_json, output_summary, execution_plan_json,
          started_at, settled_at)
       VALUES (?, ?, 0, 1, ?, 'automation_plugin_inspect', 'read', ?,
               'development_fixture', 'completed', 'inspect-sentinel',
               NULL, ?, 'Inspected Google', ?, 1, 2)`,
    ).run(
      "sentinel-inspection",
      HARNESS_RUN_ID,
      "development_fixture:sentinel-inspection",
      "sentinel-inspection-input",
      JSON.stringify({ pluginId: "plugin_google" }),
      JSON.stringify({
        canonicalToolName: "plugin_inspect",
        capability: "rally.automation.plugins.inspect",
      }),
    );
    // The receipt holds what the model sent, sentinel included: the strip
    // happens on the live call, and a replay that rebuilt the draft from the
    // raw receipt put the sentinel back, so the next submit wrote it into the
    // revision and acceptance refused a resource that does not exist.
    const sentinelRules = {
      schemaVersion: 1,
      evaluators: [{
        evaluatorKey: "mail_received",
        source: {
          sourceBindingKey: "google_source",
          suggestedSourcePluginId: "plugin_google",
          resourceId: "00000000-0000-0000-0000-000000000000",
          event: { kind: "event_type", eventType: "email.received" },
        },
        when: { kind: "always" },
      }],
    };
    database.objectStore.prepare(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
          tool_name, mode, request_hash, authority_revision, status, tool_call_id,
          connection_id, input_json, output_summary, execution_plan_json,
          started_at, settled_at)
       VALUES (?, ?, 0, 2, ?, 'automation_set_evaluator_rules', 'write', ?,
               'development_fixture', 'completed', 'sentinel-rules',
               NULL, ?, 'Stored evaluator rules', ?, 2, 3)`,
    ).run(
      "sentinel-evaluators",
      HARNESS_RUN_ID,
      "development_fixture:sentinel-evaluators",
      "sentinel-evaluator-input",
      JSON.stringify(sentinelRules),
      JSON.stringify({
        canonicalToolName: "set_evaluator_rules",
        capability: "rally.automation.evaluators.set",
      }),
    );
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const automations = selected.plugins.find((plugin) => plugin.canonicalId === "rally:automations");
    if (!automations) throw new Error("automations_plugin_missing");
    __integrationTesting.recordCredentialPluginActivation(
      `connection:${WORKSPACE_CONNECTION_ID}`,
      selected.frozenConnections,
      new Set<string>(),
      selected.loadedAutomationPluginIds,
    );
    const submit = automations.tools.find((tool) => tool.definition.name === "submit_draft");
    if (!submit) throw new Error("automation_creator_tools_missing");

    await expect(submit.execute({
      name: "New mail summary",
      description: "Summarize new mail.",
      overview: "Reports newly received messages.",
      instructions: "Summarize the message.",
      triggers: [{
        type: "connector_activity",
        connectorType: "google",
        sourceBindingKey: "google_source",
        suggestedSourcePluginId: "plugin_google",
        eventTypes: ["email.received"],
        deterministicFilters: {},
      }],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    }, { toolCallId: "submit-after-sentinel-replay" } as never))
      .resolves.toMatchObject({ output: { accepted: true } });
    expect(database.submittedDefinitions).toHaveLength(1);
    const submitted = database.submittedDefinitions[0] as {
      evaluatorRules: { evaluators: Array<{ source: Record<string, unknown> }> };
    };
    expect(submitted.evaluatorRules.evaluators[0]!.source).not.toHaveProperty("resourceId");
  });

  it("inherits tools committed into a deferred parent plugin after activation", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);
    const parentInput = workflowInput();
    const runtimeEnv = env(database);
    const parentTools = await __integrationTesting.loadHarnessTools(runtimeEnv, parentInput);
    const pluginId = `connection:${WORKSPACE_CONNECTION_ID}`;
    const parentPlugin = parentTools.plugins.find((plugin) => plugin.canonicalId === pluginId);
    if (!parentPlugin) throw new Error("expected workspace plugin");
    const discoveredReadTool = parentPlugin.tools.find((tool) => tool.definition.name === "drive.search");
    if (!discoveredReadTool) throw new Error("expected a read tool fixture");
    const hostArray = parentPlugin.tools;
    hostArray.splice(0);

    expect(__integrationTesting.installDynamicPluginTools(hostArray, [discoveredReadTool])).toBe(hostArray);
    const childTools = await __integrationTesting.createInlineChildHarnessSurface({
      env: runtimeEnv,
      parentInput,
      childInput: childWorkflowInput(parentInput),
      parentHarnessTools: parentTools,
      selectedPluginIds: [pluginId],
      assertChildOwned: async () => undefined,
    });

    expect(childTools.plugins.find((plugin) => plugin.canonicalId === pluginId)
      ?.tools.map((tool) => tool.definition.name)).toEqual(["drive.search"]);
  });

  it("keeps the child's built-in authorization set narrower than the parent's", async () => {
    const database = new ToolSelectionDatabase([]);
    const parentInput = workflowInput();
    const runtimeEnv = createTestEnv({
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
      AZURE_INFERENCE_ENDPOINT: "https://monad-prod-resource.services.ai.azure.com",
      AZURE_INFERENCE_API_KEY: "azure-test-key",
    });
    const parentTools = await __integrationTesting.loadHarnessTools(runtimeEnv, parentInput);
    expect(__integrationTesting.builtinPluginAuthorization("rally:multimodal-generation", parentTools))
      .toBe("authorized");

    const childTools = await __integrationTesting.createInlineChildHarnessSurface({
      env: runtimeEnv,
      parentInput,
      childInput: childWorkflowInput(parentInput),
      parentHarnessTools: parentTools,
      selectedPluginIds: [],
      assertChildOwned: async () => undefined,
    });

    // A sub-agent assembles its own built-ins, so authorization has to be
    // answered from the child's set. Inheriting the parent's would activate a
    // plugin the child never registered — and multimodal generation is the
    // case that matters, since it is all writes.
    expect(childTools.builtinPluginIds).toEqual(new Set(["rally:workstream", "rally:web"]));
    expect(__integrationTesting.builtinPluginAuthorization("rally:multimodal-generation", childTools))
      .toBe("denied");
    expect(__integrationTesting.builtinPluginAuthorization("rally:terminal", childTools)).toBe("denied");
    expect(__integrationTesting.builtinPluginAuthorization("rally:web", childTools)).toBe("authorized");
  });

  it("gives an inbound-email child the same web tools as any other child", async () => {
    const database = new ToolSelectionDatabase([]);
    const parentInput = workflowInput();
    parentInput.reason = "inbound_email";
    const runtimeEnv = createTestEnv({
      ...env(database),
      FIRECRAWL_API_KEY: "firecrawl-test-key",
    });
    const parentTools = await __integrationTesting.loadHarnessTools(runtimeEnv, parentInput);

    const childTools = await __integrationTesting.createInlineChildHarnessSurface({
      env: runtimeEnv,
      parentInput,
      childInput: childWorkflowInput(parentInput),
      parentHarnessTools: parentTools,
      selectedPluginIds: [],
      assertChildOwned: async () => undefined,
    });

    // `search` and `fetch` are here now. The parent's trigger used to strip
    // them from the child as well, on the same reasoning the parent's own strip
    // used, and both are gone: a child inherits its parent's read-only surface
    // and nothing narrows it further for one trigger kind.
    expect(childTools.coreTools.map((tool) => tool.definition.name)).toEqual([
      "list_resources",
      "read_resource",
      "search",
      "fetch",
      "search_resource",
      "view_resource",
      "summarize_resource",
      // Read-only and safe to repeat, so a read-only child inherits them like
      // every other resource read.
      "describe_artifact_data",
      "query_artifact_data",
      "current_time",
    ]);
    // The web plugin registers now that its tools survive, so `load_plugin` for
    // it is authorized rather than refused against an empty surface.
    expect(childTools.builtinPluginIds).toEqual(new Set(["rally:workstream", "rally:web"]));
    expect(__integrationTesting.builtinPluginAuthorization("rally:web", childTools)).toBe("authorized");
  });

  it("does not add plugin, schema, or result ceilings to child runs", () => {
    const defaultLimits = __integrationTesting.childRunLimits(env(new ToolSelectionDatabase([])));

    expect(defaultLimits).not.toHaveProperty("maxActivePlugins");
    expect(defaultLimits).not.toHaveProperty("maxToolSchemaBytes");
    expect(defaultLimits).not.toHaveProperty("maxToolResultBytes");
  });

  it("rejects a child request for a credential plugin not already active in the parent", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID),
    ]);
    const parentInput = workflowInput();
    const selected = await __integrationTesting.loadHarnessTools(env(database), parentInput);
    const tool = await __integrationTesting.installInlineChildAgentTool({
      env: env(database),
      input: parentInput,
      parentLease: () => ({
        attemptId: "attempt-parent",
        owner: "owner-parent",
        attemptNumber: 1,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
      parentSignal: new AbortController().signal,
      runAuthoritySnapshot: {
        automationRunId: null,
        automationTemplateVersionId: null,
        triggerType: null,
      },
      harnessTools: selected,
      activeCredentialPluginIds: new Set([`connection:${WORKSPACE_CONNECTION_ID}`]),
    });

    await expect(tool.execute(
      {
        objective: "Read the private plan",
        pluginIds: ["plugin_google_2"],
      },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        harnessRunId: HARNESS_RUN_ID,
        toolCallId: "tool-inactive-child-plugin",
        executionPrincipal: { type: "user", userId: USER_ID },
        signal: new AbortController().signal,
      },
    )).rejects.toThrow("only inherit connector plugins already activated");
  });

  it("exposes every granted read and write tool from a workspace connection to an ad-hoc workstream", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([WORKSPACE_CONNECTION_ID]));
    expect(pluginConnectionIds(selected)).toEqual([WORKSPACE_CONNECTION_ID]);
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`
    )?.tools.map((tool) => tool.definition.name)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(selected.modeByTool.get("google_drive_search")).toBe("read");
    expect(selected.modeByTool.get("google_docs_create_document")).toBe("write");
    expect(selected.modeByTool.get("google_sheets_update_values")).toBe("write");
    const tables = __integrationTesting.createWorkstreamCorePlugins(
      createMemoryTableTools(env(database), workflowInput()),
    ).find((plugin) => plugin.canonicalId === "rally:tables");
    expect(tables?.systemMessage).toContain("query those exact row IDs again");
    expect(tables?.systemMessage).toContain("table_insert_rows");
    expect(tables?.systemMessage).not.toMatch(/\binsert_rows\b(?!\s+can)/u);
  });

  it("exposes a personal connection only to its owning user", async () => {
    const database = new ToolSelectionDatabase([
      connection(OTHER_CONNECTION_ID, "personal", OTHER_USER_ID, GOOGLE_WORKSPACE_CAPABILITIES, "2026-07-01T00:00:00.000Z"),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, GOOGLE_WORKSPACE_CAPABILITIES, "2026-08-01T00:00:00.000Z"),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([OWNER_CONNECTION_ID]));
  });

  it("retains each eligible credential as a separate plugin while preferring personal identity in the diagnostic view", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null, GOOGLE_WORKSPACE_CAPABILITIES, "2026-07-01T00:00:00.000Z"),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, GOOGLE_WORKSPACE_CAPABILITIES, "2026-08-01T00:00:00.000Z"),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(pluginConnectionIds(selected))).toEqual(new Set([OWNER_CONNECTION_ID, WORKSPACE_CONNECTION_ID]));
    expect(selected.connectionByTool.get("drive.search")).toBe(OWNER_CONNECTION_ID);
  });

  it("advertises every Google credential as a distinct capability-specific loadable plugin", async () => {
    const database = new ToolSelectionDatabase([
      connection(
        OWNER_CONNECTION_ID,
        "personal",
        USER_ID,
        GOOGLE_MAIL_CALENDAR_CAPABILITIES,
        "2026-07-01T00:00:00.000Z",
      ),
      connection(
        WORKSPACE_CONNECTION_ID,
        "workspace",
        null,
        GOOGLE_WORKSPACE_CAPABILITIES,
        "2026-08-01T00:00:00.000Z",
      ),
    ]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const mail = selected.plugins.find((plugin) => plugin.canonicalId === `connection:${OWNER_CONNECTION_ID}`);
    const drive = selected.plugins.find((plugin) => plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`);

    expect(mail).toMatchObject({
      modelId: "plugin_google",
      displayName: "Google Mail + Calendar",
      preload: false,
      explicit: false,
    });
    expect(mail?.description).toContain("email, inbox, mail");
    expect(mail?.searchAliases).toEqual(expect.arrayContaining(["gmail", "email", "inbox", "calendar"]));
    expect(mail?.systemMessage).toContain("use the Gmail search tool first");
    expect(mail?.systemMessage).toContain("do not substitute public web search");
    expect(mail?.systemMessage).not.toContain("Drive search");
    // The plugin message carries only Gmail mechanics; not inventing an address
    // is platform policy and lives in the work-stream system prompt.
    expect(mail?.systemMessage).toContain("Resolve an unknown recipient address");
    expect(mail?.systemMessage).toContain("rather than inferring it from a signature or a header");
    expect(mail?.systemMessage).not.toContain("plausible placeholder");
    // Worked examples name this connection's own tools, and only the ones its
    // grants can actually call.
    expect(mail?.systemMessage).toContain("Worked examples:");
    expect(mail?.systemMessage).toContain("google_gmail_find_contacts {\"name\"");
    expect(mail?.systemMessage).toContain("google_calendar_update_event");
    // Every argument a worked example demonstrates has to exist on the tool it
    // names. Asserting on substrings alone let an example keep teaching
    // `attendeeEmails` after that parameter was removed from the update schema.
    expect(workedExampleCallsAgainstSchemas({
      modelId: mail!.modelId,
      systemMessage: mail!.systemMessage,
      tools: mail!.tools,
    })).toEqual([]);
    expect(mail?.tools.map((tool) => tool.definition.name)).toEqual([
      "gmail.read_profile",
      "gmail.search",
      "gmail.find_contacts",
      "gmail.read_thread",
      "gmail.read_message",
      "gmail.create_draft",
      "gmail.send",
      "calendar.list_calendars",
      "calendar.list_events",
      "calendar.read_event",
      "calendar.create_event",
      "calendar.update_event",
    ]);
    const updateEvent = mail?.tools.find((tool) => tool.definition.name === "calendar.update_event");
    expect(updateEvent?.validateInput?.({ eventId: "event-1" })).toBeInstanceOf(Error);
    expect(updateEvent?.validateInput?.({ eventId: "event-1", summary: "Updated" })).toBeNull();

    // The files plugin's examples are checked against its schemas too, so an
    // example cannot outlive the parameter it demonstrates.
    expect(drive?.systemMessage).toContain("Worked examples:");
    expect(drive?.systemMessage).toContain("writableByRally");
    expect(workedExampleCallsAgainstSchemas({
      modelId: drive!.modelId,
      systemMessage: drive!.systemMessage,
      tools: drive!.tools,
    })).toEqual([]);
    expect(drive).toMatchObject({
      modelId: "plugin_google_2",
      displayName: "Google Drive + Docs + Sheets",
    });
    expect(drive?.description).toContain("file, document, spreadsheet");
    expect(drive?.searchAliases).toEqual(expect.arrayContaining(["drive", "files", "docs", "sheets"]));
    expect(drive?.systemMessage).toContain("use the Drive search tool");
    expect(drive?.systemMessage).toContain("do not substitute public web search");
    expect(drive?.systemMessage).toContain("writableByRally=true");
    expect(drive?.systemMessage).not.toContain("Gmail search");
    expect(drive?.tools.map((tool) => tool.definition.name)).toEqual(GOOGLE_WORKSPACE_TOOLS);
  });

  it("preloads an explicitly attached workspace identity without dropping another eligible personal plugin", async () => {
    const database = new ToolSelectionDatabase([
      connection(OWNER_CONNECTION_ID, "personal", USER_ID),
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
    ], [], [WORKSPACE_CONNECTION_ID]);

    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());

    expect(new Set(pluginConnectionIds(selected))).toEqual(new Set([OWNER_CONNECTION_ID, WORKSPACE_CONNECTION_ID]));
    expect(selected.connectionByTool.get("drive.search")).toBe(WORKSPACE_CONNECTION_ID);
    expect(selected.plugins.find((plugin) => plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`)).toMatchObject({
      preload: true,
      explicit: true,
    });
  });

  it("uses automation plugin defaults as preload hints without narrowing granted tools", async () => {
    const database = new ToolSelectionDatabase(
      [connection(WORKSPACE_CONNECTION_ID, "workspace", null)],
      [
        { capability: "drive.read", connection_id: WORKSPACE_CONNECTION_ID },
        { capability: "docs.write", connection_id: WORKSPACE_CONNECTION_ID },
      ],
    );

    database.defaultPluginIds = ["plugin_google"];
    const selected = await __integrationTesting.loadHarnessTools(env(database), automationRunInput());

    // Read from the automation for this run, by the reference the loop carries.
    expect(database.runDefinitionReads).toEqual([{
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      runId: RUN_ID,
    }]);

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(new Set(selected.connectionByTool.values())).toEqual(new Set([WORKSPACE_CONNECTION_ID]));
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`
    )).toMatchObject({
      canonicalId: `connection:${WORKSPACE_CONNECTION_ID}`,
      preload: true,
      explicit: true,
    });
  });

  it("preloads every granted capability from a workstream-attached connection during an automation", async () => {
    const database = new ToolSelectionDatabase(
      [connection(WORKSPACE_CONNECTION_ID, "workspace", null)],
      [],
      [WORKSPACE_CONNECTION_ID],
    );

    const selected = await __integrationTesting.loadHarnessTools(
      env(database),
      automationRunInput(),
    );

    expect(googleToolNames(selected.tools)).toEqual(GOOGLE_WORKSPACE_TOOLS);
    expect(selected.plugins.filter((plugin) => plugin.canonicalId.startsWith("connection:"))).toHaveLength(1);
    expect(selected.plugins.find((plugin) =>
      plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`
    )).toMatchObject({
      canonicalId: `connection:${WORKSPACE_CONNECTION_ID}`,
      modelId: "plugin_google",
      shortWireName: "google",
      preload: true,
      explicit: true,
    });
  });

  it("keeps connector writes on an inbound-email automation, like any other trigger", async () => {
    const database = new ToolSelectionDatabase(
      [connection(WORKSPACE_CONNECTION_ID, "workspace", null)],
      [
        { capability: "drive.read", connection_id: WORKSPACE_CONNECTION_ID },
        { capability: "docs.read", connection_id: WORKSPACE_CONNECTION_ID },
        { capability: "docs.write", connection_id: WORKSPACE_CONNECTION_ID },
        { capability: "sheets.write", connection_id: WORKSPACE_CONNECTION_ID },
      ],
    );
    const input = automationRunInput("inbound_email");

    const selected = await __integrationTesting.loadHarnessTools(env(database), input);

    // The write halves used to be stripped here. They are not any more: the
    // trigger no longer decides the tool surface, and an automation that
    // delivers its own result through its bound tools needs them whatever woke
    // it. What still gates these is the grant — every name below is a
    // capability this connection was actually given.
    expect(googleToolNames(selected.tools)).toEqual([
      "drive.search",
      "drive.get_metadata",
      "drive.download",
      "drive.export",
      "docs.read_document",
      "docs.create_document",
      "docs.append_text",
      "docs.replace_text",
      "sheets.read_spreadsheet",
      "sheets.read_values",
      "sheets.create_spreadsheet",
      "sheets.update_values",
      "sheets.append_values",
    ]);
    expect(selected.modeByTool.has("google_docs_create_document")).toBe(true);
    expect(selected.connectionByTool.has("google_sheets_update_values")).toBe(true);
  });

  it.each([
    {
      authority: "workspace membership",
      revoke: (database: ToolSelectionDatabase, row: ConnectionRow) => {
        database.memberStatus = "removed";
        void row;
      },
      message: "User is not an active workspace member",
    },
    {
      authority: "personal connection ownership",
      revoke: (_database: ToolSelectionDatabase, row: ConnectionRow) => {
        row.owner_user_id = OTHER_USER_ID;
      },
      message: "Connector is no longer authorized for this run",
    },
    {
      authority: "capability grant",
      revoke: (_database: ToolSelectionDatabase, row: ConnectionRow) => {
        row.granted_scopes_json = "[]";
      },
      message: "Connector capability was revoked",
    },
    {
      // A person disabling a connection mid-run is a decision, and it is the
      // one status value that still closes the door. `error` and
      // `needs_reconnect` no longer do: they are beliefs about a past moment,
      // and the provider is what says whether the credential still works.
      authority: "connection disablement",
      revoke: (_database: ToolSelectionDatabase, row: ConnectionRow) => {
        row.status = "disabled";
      },
      message: "Connector is no longer authorized for this run",
    },
  ])("blocks credential access when $authority changes between model selection and tool execution", async ({
    revoke,
    message,
  }) => {
    const row = connection(OWNER_CONNECTION_ID, "personal", USER_ID, ["drive.read"]);
    // Deliberately invalid ciphertext: reaching decryption would produce a
    // crypto failure instead of the member-safe authorization failure below.
    row.encrypted_credentials = "credential-ciphertext-must-not-be-read";
    row.credential_iv = "credential-iv-must-not-be-read";
    const database = new ToolSelectionDatabase([row]);
    const providerFetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", providerFetch);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const plugin = selected.plugins.find((candidate) =>
      candidate.canonicalId === `connection:${OWNER_CONNECTION_ID}`
    )!;
    const wireToolName = "google_drive_search";
    const events: HarnessEvent[] = [];
    let modelTurn = 0;
    const modelFetch = vi.fn<typeof globalThis.fetch>(async () => {
      modelTurn += 1;
      if (modelTurn === 1) {
        // The run scope and active plugin were already authorized before this
        // response. Mutating now proves the tool boundary independently checks
        // the durable authority before credentials can be decrypted.
        revoke(database, row);
        return authorityStreamResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "provider-authority-read",
                type: "function",
                function: { name: wireToolName, arguments: JSON.stringify({ query: "quarterly plan" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }]);
      }
      return authorityStreamResponse([{
        choices: [{ delta: { content: "Authorization changed; tool was not executed." }, finish_reason: "stop" }],
      }]);
    });

    const outcome = await runHarness({
      config: {
        apiKey: "test-key",
        primaryModel: "google/gemini-2.5-flash-lite",
        fetch: modelFetch,
        maxIterations: 3,
        maxToolCalls: 2,
        // A real Bind run deadline, not a test budget — wide so a starved
        // scheduler cannot abort the scripted run (see
        // model-protocol-transcript.test.ts for the incident shape).
        maxWallClockMs: 10_000,
        toolTimeoutMs: 100,
        maxWebResults: 4,
      },
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
      harnessRunId: HARNESS_RUN_ID,
      executionPrincipal: { type: "user", userId: USER_ID },
      systemPrompt: "Use only currently authorized connector tools.",
      messages: [{ role: "user", content: "Search my Drive." }],
      corePlugins: [],
      plugins: selected.plugins,
      activationHints: [plugin.canonicalId],
      // Connector execution performs the authoritative database check. This
      // callback remains true so Bind keeps the frozen plugin active long
      // enough to exercise that exact boundary.
      reauthorizePlugin: () => "authorized",
      onEvent: (event) => { events.push(event); },
    });

    expect(outcome).toMatchObject({
      status: "completed",
      content: "Authorization changed; tool was not executed.",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_failed",
      pluginId: plugin.canonicalId,
      error: message,
      phase: "execution",
      outcome: "definitive_failure",
    }));
    expect(events.some((event) => event.type === "tool_completed")).toBe(false);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe("editing an automation a conversation already owns", () => {
  it("writes the named automation's next revision instead of creating another", async () => {
    const database = new ToolSelectionDatabase([]);
    database.automationOwners.set(OWNED_AUTOMATION_ID, WORKSTREAM_ID);
    const submit = await automationCreatorTool(database, workflowInput(), "submit_draft");

    await expect(submit.execute(
      { ...manualDraft("Weekly digest"), automationId: OWNED_AUTOMATION_ID },
      { toolCallId: "edit-owned" } as never,
    )).resolves.toMatchObject({ output: { accepted: true } });

    expect(database.submittedDefinitions).toHaveLength(1);
    expect(database.submittedDefinitions[0]).toMatchObject({
      automationId: OWNED_AUTOMATION_ID,
      draft: { name: "Weekly digest" },
    });
    // The run id is the id a *new* automation would have been given, so an
    // edit that quietly created one instead would submit under that name.
    expect(database.submittedDefinitions[0]).not.toMatchObject({ automationId: HARNESS_RUN_ID });
    expect(database.createdAutomations).toEqual([]);
    expect(database.proposedDraftCards).toEqual([]);
  });

  it("refuses an automation another room owns, and submits nothing", async () => {
    const database = new ToolSelectionDatabase([]);
    database.automationOwners.set(FOREIGN_AUTOMATION_ID, OTHER_WORKSTREAM_ID);
    const submit = await automationCreatorTool(database, workflowInput(), "submit_draft");

    await expect(submit.execute(
      { ...manualDraft("Weekly digest"), automationId: FOREIGN_AUTOMATION_ID },
      { toolCallId: "edit-foreign" } as never,
    )).rejects.toThrow("not one this work stream owns");

    expect(database.submittedDefinitions).toEqual([]);
    expect(database.createdAutomations).toEqual([]);
    expect(database.proposedDraftCards).toEqual([]);
  });

  it("lets an automation's own conversation change only that automation", async () => {
    const database = new ToolSelectionDatabase([]);
    database.automationOwners.set(OWNED_AUTOMATION_ID, WORKSTREAM_ID);
    const submit = await automationCreatorTool(database, automationConversationInput(), "submit_draft");

    await expect(submit.execute(
      { ...manualDraft("Someone else's job"), automationId: OWNED_AUTOMATION_ID },
      { toolCallId: "edit-another-automation" } as never,
    )).rejects.toThrow("edits only its own automation");
    expect(database.submittedDefinitions).toEqual([]);

    await expect(submit.execute(
      { ...manualDraft("Named itself"), automationId: AUTOMATION_ID },
      { toolCallId: "edit-itself-by-id" } as never,
    )).resolves.toMatchObject({ output: { accepted: true } });
    await expect(submit.execute(
      { ...manualDraft("Named nothing"), automationId: null },
      { toolCallId: "edit-itself-by-default" } as never,
    )).resolves.toMatchObject({ output: { accepted: true } });

    expect(database.submittedDefinitions.map((request) => request.automationId))
      .toEqual([AUTOMATION_ID, AUTOMATION_ID]);
    // Nothing is created here either: the automation this conversation belongs
    // to already exists, and its own chat has no room to post a proposal into.
    expect(database.createdAutomations).toEqual([]);
    expect(database.proposedDraftCards).toEqual([]);
  });

  it("lists the room's automations with their definitions, and one automation's chat lists only itself", async () => {
    const database = new ToolSelectionDatabase([]);
    database.workstreamAutomations.set(WORKSTREAM_ID, [
      OWNED_AUTOMATION_ID,
      SECOND_OWNED_AUTOMATION_ID,
    ]);
    database.automationDetails.set(OWNED_AUTOMATION_ID, automationDetail(OWNED_AUTOMATION_ID, "Weekly digest"));
    database.automationDetails.set(
      SECOND_OWNED_AUTOMATION_ID,
      automationDetail(SECOND_OWNED_AUTOMATION_ID, "Standup notes", {
        lifecycle: "paused",
        status: "paused",
        acceptedDefinitionRevision: null,
        currentDefinitionRevision: 1,
      }),
    );
    database.automationDetails.set(AUTOMATION_ID, automationDetail(AUTOMATION_ID, "Drive digest"));

    const roomList = await automationCreatorTool(database, workflowInput(), "automations_list");
    await expect(roomList.execute({}, { toolCallId: "list-in-room" } as never))
      .resolves.toMatchObject({
        output: {
          automations: [
            {
              automationId: OWNED_AUTOMATION_ID,
              name: "Weekly digest",
              lifecycle: "active",
              scope: "workstream",
              currentDefinitionRevision: 3,
              acceptedDefinitionRevision: 2,
              currentDefinition: { name: "Weekly digest", definitionVersion: 2, triggers: [{ type: "manual" }, { type: "inbound_email" }] },
            },
            {
              automationId: SECOND_OWNED_AUTOMATION_ID,
              name: "Standup notes",
              lifecycle: "paused",
              currentDefinitionRevision: 1,
              acceptedDefinitionRevision: null,
              currentDefinition: { name: "Standup notes" },
            },
          ],
        },
      });
    expect(database.workstreamAutomationListReads).toMatchObject([
      { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, userId: USER_ID },
    ]);
    expect(database.detailReads.map((request) => request.automationId))
      .toEqual([OWNED_AUTOMATION_ID, SECOND_OWNED_AUTOMATION_ID]);

    database.detailReads.length = 0;
    database.workstreamAutomationListReads.length = 0;
    const ownList = await automationCreatorTool(database, automationConversationInput(), "automations_list");
    await expect(ownList.execute({}, { toolCallId: "list-in-automation" } as never))
      .resolves.toMatchObject({
        output: {
          automations: [{ automationId: AUTOMATION_ID, name: "Drive digest" }],
        },
      });
    // The room's rail is never consulted from an automation's own conversation:
    // the one automation it may edit is the one it belongs to.
    expect(database.workstreamAutomationListReads).toEqual([]);
    expect(database.detailReads.map((request) => request.automationId)).toEqual([AUTOMATION_ID]);
  });
});

function authorityStreamResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
