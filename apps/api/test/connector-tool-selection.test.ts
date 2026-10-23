import { asAutomationId, asHarnessRunId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type {
  AutomationDetail,
  AutomationDraft,
  AutomationRunDefinitionV1,
  WorkstreamWorkflowInput,
} from "@rally/contracts";
import { runHarness, type HarnessEvent } from "@rally/agent-harness";
import { slackTools, notionTools, granolaTools } from "@rally/connectors";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@rally/contracts";
import historicalGoogleTools from "./fixtures/google-tools-before-workflows.json";
import combinedGoogleReceipts from "./fixtures/google-combined-receipts.json";

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
import { responsesStreamResponse } from "@rally/agent-harness/test-support/responses-stream";

// Frozen pre-cutover definitions. Google uses a historical fixture because
// new workflows and attachment inputs intentionally change the current receipt
// digest; older receipts must remain fenced. Prose participates in the hash.
it.each([
  ["google", historicalGoogleTools as ToolDefinition[], "ee3d58df9c6be517cf31c61c24ff0a9e48496b6985952f2b1fb233c9e17107f3"],
  ["slack", slackTools, "4252e614c1b846896edb924fd3210d89339b1536a81b22b19e8c5010baa27820"],
  ["notion", notionTools, "9df5f6fbfe14255d35486d5efb4f90545bdf2919cab5a4321a5b3c43014f3ef6"],
  ["granola", granolaTools, "68ee12b5c978b26d85e9d8893c0f9f5d3bdd5d6f42a1c4ef0f36654a6550c807"],
] as const)("reconstructs the historical %s receipt surface", async (pluginId, definitions, expected) => {
  const tools = __integrationTesting.prePaginationTools(definitions.map((definition) => ({
    definition, execute: async () => ({ output: null, summary: "Unused hash fixture" }),
  })));
  expect(await __integrationTesting.connectorToolSurfaceHash(pluginId, tools)).toBe(Buffer.from(expected, "hex").toString("base64url"));
});

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
/** An automation another room owns, which no edit from this room may name. */

const GOOGLE_WORKSPACE_CAPABILITIES = [
  "drive.read",
  "docs.read",
  "docs.write",
  "sheets.read",
  "sheets.write",
] as const;

const GOOGLE_WORKSPACE_TOOLS = [
  "drive.search",
  "drive.search_next",
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
  connector_type: string;
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
    } else if (sql.includes("FROM users")) {
      results = [{ id: USER_ID, name: "Member" }];
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

/**
 * The Organization object, which hosts every Sidekick: the shared stub, plus
 * the Sidekick methods this file's subjects call.
 *
 * Creation is answered as already existing. The Worker still bootstraps and
 * provisions the automation's own conversation on a replay, and these doubles
 * record that rather than run it: creating an automation from a room is
 * `test-workers/hosted-sidekick.test.ts`'s subject, and what this file proves
 * about a submission is what reaches `sidekickSaveDefinition`.
 */
function hostingSidekicks(database: ToolSelectionDatabase): Env["WORKSPACE_DOS"] {
  const sidekicks: Record<string, unknown> = {
    // Catalog input only. Real consent/admission is exercised in test-workers;
    // this suite checks tool projection for a supplied eligible-user snapshot.
    sidekickReadExecutionDelegation: async (request: { automationId: string }) => ({
      sidekickId: request.automationId, creatorUserId: USER_ID, accountUserId: USER_ID,
      delegates: [{ userId: USER_ID, generation: 1, grantedAt: 1 }],
    }),
    sidekickCreate: vi.fn(async (request: Record<string, unknown>) => {
      database.createdAutomations.push(request);
      return { created: false };
    }),
    sidekickSaveDefinition: vi.fn(async (request: Record<string, unknown>) => {
      database.submittedDefinitions.push(request);
      return { definitionRevision: 1 };
    }),
    // The definitions an edit starts from, in one call. One shared stub answers
    // for every automation id, so the fixture keyed by the requested id is what
    // decides whether a read reached the automation the caller meant.
    sidekickReadDetails: vi.fn(async (request: Record<string, unknown>) => {
      const owned = typeof request.channelOwnedBy === "string"
        ? [...database.automationOwners].filter(([, owner]) => owner === request.channelOwnedBy).map(([id]) => id)
        : [];
      const ids = [...new Set([...(request.automationIds as string[] | undefined ?? []), ...owned])];
      return ids.map((automationId) => {
        database.detailReads.push({ ...request, automationId });
        const detail = database.automationDetails.get(automationId);
        if (!detail) throw new Error(`no_automation_detail_fixture:${automationId}`);
        return detail;
      });
    }),
    // A run reads its definition from its Sidekick by revision when it
    // starts; the plugin defaults it preloads come from there.
    sidekickReadRunDefinition: vi.fn(async (request: Record<string, unknown>) => {
      database.runDefinitionReads.push(request);
      return runDefinition(database);
    }),
  };
  return createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => database.workspaces.idFromName(name),
    get: (id: DurableObjectId) => {
      const base = database.workspaces.get(id) as unknown as Record<string, unknown>;
      return new Proxy(base, {
        get: (target, property) => (typeof property === "string" && property in sidekicks)
          ? sidekicks[property]
          : Reflect.get(target, property),
      });
    },
  });
}

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
    WORKSPACE_DOS: hostingSidekicks(database),
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
    owningThread: null,
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
  const plugin = selected.plugins.find((candidate) => candidate.canonicalId === "rally:sidekicks");
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
    owningSubstreamId: asSubstreamId("0"),
    runAsUserId: USER_ID,
    modelOverride: null,
    trigger: { kind: "manual", requestedByUserId: USER_ID },
    opening: null,
    state: "running",
  };
}

/**
 * The concrete calls a plugin's system message demonstrates, parsed back into
 * the wire tool name and the arguments each one teaches.
 *
 * One parser for both checks below, because they ask different questions of the
 * same text: whether every demonstrated parameter exists, and whether a
 * demonstrated call would survive the tool's own validator.
 */
function workedExampleCalls(
  systemMessage: string,
): { wireName: string; arguments: Record<string, unknown> }[] {
  return [...systemMessage.matchAll(/`(google[a-z0-9_]*) (\{.*?\})`/gu)].map((match) => ({
    wireName: match[1]!,
    arguments: JSON.parse(match[2]!) as Record<string, unknown>,
  }));
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
    shortWireName?: string;
    systemMessage?: string | undefined;
    tools: Awaited<ReturnType<typeof __integrationTesting.loadHarnessTools>>["tools"];
  },
): string[] {
  const { tools } = plugin;
  const systemMessage = plugin.systemMessage ?? "";
  // Derived, not assumed: a second credential of the same provider is
  // `google_2_…`, and hardcoding the first one's prefix made this check
  // silently validate nothing for every plugin but the first.
  const wirePrefix = plugin.shortWireName ?? plugin.modelId.replace(/^plugin_/u, "");
  const schemas = new Map(tools.map((tool) => {
    const schema = tool.definition.inputSchema as { properties?: Record<string, unknown> };
    return [
      `${wirePrefix}_${tool.definition.name.replace(".", "_")}`,
      new Set(Object.keys(schema.properties ?? {})),
    ];
  }));
  const problems: string[] = [];
  let found = 0;
  for (const call of workedExampleCalls(systemMessage)) {
    const properties = schemas.get(call.wireName);
    if (!properties) {
      problems.push(`${call.wireName} is not a tool on this plugin`);
      continue;
    }
    found += 1;
    for (const key of Object.keys(call.arguments)) {
      if (!properties.has(key)) problems.push(`${call.wireName} has no ${key} parameter`);
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
    substreamId: asSubstreamId(CHILD_HARNESS_RUN_ID),
    backgroundAgent: true,
    reason: "agent_message",
  };
}

describe("connector tools selected for harness runs", () => {
  it("withholds Sidekick management from workspace-principal runs", async () => {
    const selected = await __integrationTesting.loadHarnessTools(env(new ToolSelectionDatabase([])), {
      ...workflowInput(), executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
    });
    expect(selected.plugins.map((plugin) => plugin.canonicalId)).not.toContain("rally:sidekicks");
  });
  it("gives background substreams normal writes, independent discovery and recursive agent tools", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null),
      connection(OWNER_CONNECTION_ID, "personal", USER_ID),
    ]);
    const runtimeEnv = createTestEnv({ ...env(database), FIRECRAWL_API_KEY: "firecrawl-test-key" });
    const selected = await __integrationTesting.loadHarnessTools(runtimeEnv, childWorkflowInput());
    expect(pluginConnectionIds(selected)).toEqual(expect.arrayContaining([
      WORKSPACE_CONNECTION_ID, OWNER_CONNECTION_ID,
    ]));
    expect(selected.plugins.find((plugin) => plugin.canonicalId === `connection:${WORKSPACE_CONNECTION_ID}`)
      ?.tools.some((tool) => tool.definition.mode === "write")).toBe(true);
    expect(selected.plugins.find((plugin) => plugin.canonicalId === "avalon:agents")
      ?.tools.map((tool) => tool.definition.name)).toEqual(expect.arrayContaining([
        "start_agent", "list_agents", "send_message", "reply_to_message", "stop_agent",
      ]));
    expect(selected.plugins.find((plugin) => plugin.canonicalId === "rally:sidekicks")
      ?.tools.map((tool) => tool.definition.name)).toEqual(["list_skill_recommendations", "recommend_skill", "unrecommend_skill",
        "sidekick_my_delegations_list", "sidekick_delegates_list", "sidekick_set_delegation"]);
    expect(selected.tools.some((tool) => tool.definition.name === "run_subagent")).toBe(false);
  });

  it("offers drafting only to Sidekick authoring and communication to ordinary conversations", async () => {
    const database = new ToolSelectionDatabase([]);
    const runtimeEnv = env(database);
    const room = await __integrationTesting.loadHarnessTools(runtimeEnv, workflowInput());
    const authoring = await __integrationTesting.loadHarnessTools(runtimeEnv, automationConversationInput());
    const child = await __integrationTesting.loadHarnessTools(runtimeEnv, childWorkflowInput(automationConversationInput()));
    expect(room.plugins.find((plugin) => plugin.canonicalId === "rally:sidekicks")
      ?.tools.map((tool) => tool.definition.name)).toEqual(["list_skill_recommendations", "recommend_skill", "unrecommend_skill",
        "sidekick_my_delegations_list", "sidekick_delegates_list", "sidekick_set_delegation"]);
    expect(child.plugins.find((plugin) => plugin.canonicalId === "rally:sidekicks")?.tools.map((tool) => tool.definition.name))
      .toEqual(["my_delegations_list", "delegates_list", "set_delegation"]);
    expect(authoring.plugins.map((plugin) => plugin.canonicalId)).toContain("rally:sidekicks");
    expect(room.plugins.find((plugin) => plugin.canonicalId === "avalon:agents")
      ?.tools.map((tool) => tool.definition.name)).toEqual(expect.arrayContaining(["sidekicks_list", "create_sidekick"]));
  });

  it("skips a connection whose connector this deployment does not configure, rather than failing the run", async () => {
    // A rollout gate turned back off leaves its rows in place on purpose, so
    // `registry.get` has a type it has never heard of. Throwing here does not
    // cost that connector its tools — it costs the workspace every conversation,
    // which makes the gate unusable in the one direction it exists for.
    const database = new ToolSelectionDatabase([
      {
        id: WORKSPACE_CONNECTION_ID,
        workspace_id: WORKSPACE_ID,
        connector_type: "fireflies",
        scope: "workspace",
        owner_user_id: null,
        granted_scopes_json: JSON.stringify(["fireflies.workspace.read"]),
        status: "healthy",
        created_at: "2026-09-12T12:00:00.000Z",
        model_plugin_id: "plugin_fireflies_one",
      },
    ]);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    expect(selected.plugins.some((plugin) => plugin.modelId === "plugin_fireflies_one")).toBe(false);
    // The rest of the run is untouched: the built-in plugins are all still here.
    expect(selected.builtinPluginIds.size).toBeGreaterThan(0);
  });

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
    expect(withAzure.idempotencyByTool.get("generate_image")).toBe("record_before_execute");
    expect(withAzure.modeByTool.get("edit_image")).toBe("write");
    expect(withAzure.idempotencyByTool.get("generate_audio")).toBe("record_before_execute");
    expect(withAzure.modeByTool.get("generate_audio")).toBe("write");
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

    const unchanged = selected.plugins.find((plugin) => plugin.canonicalId === googlePluginId)!.tools.find((tool) => !tool.definition.pagination)!;
    const unchangedPolicy = __integrationTesting.resolveHarnessToolReceiptPolicy({ pluginId: googlePluginId,
      canonicalToolName: unchanged.definition.name, capability: unchanged.definition.capability,
      mode: unchanged.definition.mode, idempotency: unchanged.definition.idempotency }, selected);
    expect(unchangedPolicy.prePaginationSurfaceHash).toEqual(selected.prePaginationSurfaceHashes.get(googlePluginId));
    expect(unchangedPolicy.prePaginationSurfaceHash).toEqual(expect.any(String));
    const priorPlan = { pluginId: googlePluginId, canonicalToolName: unchanged.definition.name,
      capability: unchanged.definition.capability, mode: unchanged.definition.mode, idempotency: unchanged.definition.idempotency,
      connectionId: WORKSPACE_CONNECTION_ID, toolSurfaceHash: unchangedPolicy.prePaginationSurfaceHash };
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify(priorPlan), unchangedPolicy)).toBe(true);
    expect(googlePolicy.prePaginationSurfaceHash).toBeUndefined();
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({ ...priorPlan,
      canonicalToolName: googlePolicy.definition.name, capability: googlePolicy.definition.capability }), googlePolicy)).toBe(false);

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

  it("shares a durable connector activation with ready automation validation", async () => {
    const database = new ToolSelectionDatabase([
      connection(WORKSPACE_CONNECTION_ID, "workspace", null, GOOGLE_MAIL_CALENDAR_CAPABILITIES),
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
        // A receipt this conversation wrote before the Sidekick rename: the wire
        // name and the capability are the old vocabulary, and the replay still
        // has to count the inspection.
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
        capability: "rally.sidekick.resources.search",
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
        capability: "rally.sidekick.evaluators.set",
      }),
    );
    const selected = await __integrationTesting.loadHarnessTools(env(database), automationConversationInput());
    const automations = selected.plugins.find((plugin) =>
      plugin.canonicalId === "rally:sidekicks"
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
      icon: "file-text",
      color: "blue",
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
      automationId: AUTOMATION_ID,
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

    const replacement = await __integrationTesting.loadHarnessTools(env(database), automationConversationInput());
    __integrationTesting.recordCredentialPluginActivation(
      `connection:${WORKSPACE_CONNECTION_ID}`,
      replacement.frozenConnections,
      new Set(),
      replacement.loadedAutomationPluginIds,
    );
    const replacementSubmit = replacement.plugins.find((candidate) =>
      candidate.canonicalId === "rally:sidekicks"
    )?.tools.find((tool) => tool.definition.name === "submit_draft");
    if (!replacementSubmit) throw new Error("replacement_automation_creator_tools_missing");
    await expect(replacementSubmit.execute(
      readyDraft,
      { toolCallId: "submit-after-eviction" } as never,
    )).resolves.toMatchObject({ output: { accepted: true } });
    expect(database.submittedDefinitions.map((draft) => draft.automationId))
      .toEqual([AUTOMATION_ID, AUTOMATION_ID]);
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
        capability: "rally.sidekick.plugins.inspect",
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
        capability: "rally.sidekick.evaluators.set",
      }),
    );
    const selected = await __integrationTesting.loadHarnessTools(env(database), automationConversationInput());
    const automations = selected.plugins.find((plugin) => plugin.canonicalId === "rally:sidekicks");
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
      icon: "file-text",
      color: "blue",
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

  it("splits one combined credential into independently loadable Google plugins", async () => {
    const database = new ToolSelectionDatabase([
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, [...GOOGLE_WORKSPACE_CAPABILITIES, ...GOOGLE_MAIL_CALENDAR_CAPABILITIES]),
    ]);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const plugins = selected.plugins.filter((plugin) => plugin.connectorType === "google")
      .sort((left, right) => left.modelId.localeCompare(right.modelId)).reverse();
    expect(plugins.map((plugin) => [plugin.modelId, plugin.canonicalId, plugin.displayName])).toEqual([
      ["plugin_google_mail_calendar", `connection:${OWNER_CONNECTION_ID}:mail_calendar`, "Google Mail + Calendar"],
      ["plugin_google_drive", `connection:${OWNER_CONNECTION_ID}:drive`, "Google Drive + Docs + Sheets"],
    ]);
    expect(plugins.map((plugin) => plugin.shortWireName)).toEqual(["google", "google"]);
    expect(plugins[0]?.tools.every((tool) => /^(gmail|calendar)\./u.test(tool.definition.capability))).toBe(true);
    expect(plugins[1]?.tools.every((tool) => /^(drive|docs|sheets)\./u.test(tool.definition.capability))).toBe(true);
    expect(plugins[0]?.tools.map((tool) => tool.definition.name)).toContain("gmail.search");
    expect(plugins[1]?.tools.map((tool) => tool.definition.name)).toContain("drive.search");
    for (const plugin of plugins) expect(workedExampleCallsAgainstSchemas(plugin)).toEqual([]);
    expect([...selected.frozenConnections.values()].map((plugin) => plugin.connectionId)).toEqual([
      OWNER_CONNECTION_ID, OWNER_CONNECTION_ID,
    ]);
    expect(__integrationTesting.eligibleConnectionCapabilityMap(plugins, selected.frozenConnections))
      .toEqual({ [OWNER_CONNECTION_ID]: expect.arrayContaining(["gmail.read", "calendar.read", "drive.read", "docs.read"]) });
    const catalog = (await __integrationTesting.loadAutomationCreatorPluginCatalog(env(database), WORKSPACE_ID, USER_ID))
      .sort((left, right) => left.pluginId.localeCompare(right.pluginId)).reverse();
    expect(catalog.map((entry) => entry.pluginId)).toEqual(["plugin_google_mail_calendar", "plugin_google_drive"]);
    expect(catalog[0]?.activityTriggers.map((trigger) => trigger.eventType)).toEqual([
      "email.received", "calendar.event_changed", "calendar.event_completed", "email.updated",
    ]);
    expect(catalog[1]?.activityTriggers.map((trigger) => trigger.eventType)).toEqual([
      "drive.file_changed", "docs.document_changed", "sheets.spreadsheet_changed",
    ]);
  });

  it("loads Mail and Drive independently through the harness discovery tools", async () => {
    const database = new ToolSelectionDatabase([
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, ["gmail.read", "drive.read"]),
    ]);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const visibleTools: string[][] = [];
    const modelFetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools: Array<{ name: string }> };
      visibleTools.push(body.tools.map((tool) => tool.name));
      const pluginId = ["plugin_google_mail_calendar", "plugin_google_drive"][visibleTools.length - 1];
      return authorityStreamResponse([{
        choices: [{
          delta: pluginId ? { tool_calls: [{
            index: 0, id: `load-${visibleTools.length}`, type: "function",
            function: { name: "load_plugin", arguments: JSON.stringify({ pluginId }) },
          }] } : { content: "Loaded both Google plugins." },
          finish_reason: pluginId ? "tool_calls" : "stop",
        }],
      }]);
    });
    const outcome = await runHarness({
      config: {
        apiKey: "test-key", primaryModel: "google/gemini-2.5-flash-lite", fetch: modelFetch,
        maxIterations: 4, maxToolCalls: 3, maxWallClockMs: 120_000, toolTimeoutMs: 30_000, maxWebResults: 4,
      },
      workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID,
      loopId: workflowInput().loopId, harnessRunId: HARNESS_RUN_ID,
      executionPrincipal: { type: "user", userId: USER_ID },
      systemPrompt: "Load the requested Google plugins.",
      messages: [{ role: "user", content: "Load Mail, then Drive." }],
      corePlugins: [], plugins: selected.plugins, activationHints: [], reauthorizePlugin: () => "authorized",
      onEvent: () => {},
    });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "completed" });
    expect(visibleTools).toHaveLength(3);
    expect(visibleTools[0]).not.toContain("google_gmail_search");
    expect(visibleTools[0]).not.toContain("google_drive_search");
    expect(visibleTools[1]).toContain("google_gmail_search");
    expect(visibleTools[1]).not.toContain("google_drive_search");
    expect(visibleTools[2]).toEqual(expect.arrayContaining(["google_gmail_search", "google_drive_search"]));
    expect(new Set(visibleTools[2]).size).toBe(visibleTools[2]?.length);
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
    expect(tables?.systemMessage).toContain("a pending claim is not completed work");
    expect(tables?.systemMessage).toContain("must still process the event that triggered the run");
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
    expect(mail?.systemMessage).not.toContain("Search names and contents together");
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
      "calendar.cancel_event", "calendar.cancel_recurring_series", "calendar.respond_to_event", "calendar.respond_to_recurring_series", "calendar.suggest_time",
      "gmail.list_labels", "gmail.list_drafts", "gmail.list_drafts_next", "gmail.read_draft",
      "gmail.read_profile",
      "gmail.search",
      "gmail.search_next",
      "gmail.find_contacts",
      "gmail.read_thread",
      "gmail.read_message",
      "gmail.create_draft",
      "gmail.send",
      "gmail.create_reply_draft", "gmail.reply",
      "calendar.list_calendars",
      "calendar.list_calendars_next",
      "calendar.query_availability",
      "calendar.list_events",
      "calendar.list_events_next",
      "calendar.read_event",
      "calendar.create_event",
      "calendar.create_all_day_event", "calendar.create_recurring_event",
      "calendar.update_event",
    ]);
    const availability = mail?.tools.find((tool) => tool.definition.name === "calendar.query_availability");
    const window = { calendarIds: ["alex@example.com"], timeMin: "2026-10-20T17:00:00Z" };
    for (const timeMax of ["2026-10-20T16:00:00Z", "2026-10-20T17:00:00Z"]) {
      expect(availability?.validateInput?.({ ...window, timeMax })).toMatchObject({
        issues: [{ path: ["timeMax"], message: "timeMax must follow timeMin" }],
      });
    }
    expect(availability?.validateInput?.({ ...window, timeMax: "2026-10-20T18:00:00Z" })).toBeNull();

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
    expect(drive?.searchAliases).toEqual(expect.arrayContaining(["drive", "files", "docs", "sheets", "meet", "notes", "transcripts"]));
    expect(drive?.systemMessage).toContain("use the Drive search tool");
    expect(drive?.systemMessage).toContain("do not substitute public web search");
    expect(drive?.systemMessage).toContain("writableByRally=true");
    expect(drive?.systemMessage).not.toContain("Gmail search");
    expect(drive?.tools.map((tool) => tool.definition.name)).toEqual(GOOGLE_WORKSPACE_TOOLS);
  });

  it("offers no Google meeting skill without an eligible Google read capability", async () => {
    expect(__integrationTesting.connectorSkillsForPlugins([])).toEqual([]);
    for (const capabilities of [["gmail.send"], ["docs.write"], ["gmail.read"]]) {
      const database = new ToolSelectionDatabase([connection(OWNER_CONNECTION_ID, "personal", USER_ID, capabilities)]);
      const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
      expect(__integrationTesting.connectorSkillsForPlugins(selected.plugins)).toEqual([]);
    }
  });

  it("offers one meeting skill across separate Calendar and Drive connections", async () => {
    const database = new ToolSelectionDatabase([
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, ["calendar.read"]),
      connection(WORKSPACE_CONNECTION_ID, "workspace", null, ["drive.read", "docs.read"]),
    ]);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const skills = __integrationTesting.connectorSkillsForPlugins(selected.plugins);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("reading-google-meeting-notes");
    expect(selected.plugins.map((plugin) => plugin.canonicalId)).toContain(skills[0]?.ownerPlugin);
  });

  it.each([
    ["calendar.read"],
    ["drive.read", "docs.read"],
    ["calendar.read", "drive.read", "docs.read"],
  ])("prioritizes the attached transcript in the Google plugin with grants %j", async (...capabilities) => {
    const database = new ToolSelectionDatabase([
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, capabilities),
    ]);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const plugin = selected.plugins.find((item) => item.canonicalId.startsWith(`connection:${OWNER_CONNECTION_ID}`))!;
    // Assert the presentation the harness actually receives, including Calendar-
    // only credentials that must load a separate Docs plugin to read the file.

    expect(plugin.systemMessage).toContain("load the reading-google-meeting-notes skill");
    const skills = __integrationTesting.connectorSkillsForPlugins(selected.plugins);
    expect(skills.map((skill) => ({ name: skill.name, owner: skill.ownerPlugin }))).toEqual([
      { name: "reading-google-meeting-notes", owner: plugin.canonicalId },
    ]);
    expect(skills[0]?.body).toContain("pass fileId as documentId");
    const examples = workedExampleCalls(plugin.systemMessage ?? "");
    if (plugin.tools.some((tool) => tool.definition.capability === "docs.read")) expect(workedExampleCallsAgainstSchemas(plugin)).toEqual([]);
    expect(examples.some((call) => call.wireName.endsWith("_docs_read_document"))).toBe(false);
  });

  it.each([
    {
      capabilities: ["gmail.read", "gmail.draft", "gmail.send"],
      expected: [["google_gmail_create_draft", "new"], ["google_gmail_create_reply_draft", "reply"], ["google_gmail_send", "new"], ["google_gmail_reply", "reply"]],
    },
    { capabilities: ["gmail.send"], expected: [["google_gmail_send", "new"]] },
    { capabilities: ["gmail.draft"], expected: [["google_gmail_create_draft", "new"]] },
  ])("demonstrates exactly the Gmail message kinds permitted by $capabilities", async ({ capabilities, expected }) => {
    const database = new ToolSelectionDatabase([
      connection(OWNER_CONNECTION_ID, "personal", USER_ID, capabilities, "2026-07-01T00:00:00.000Z"),
    ]);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const mail = selected.plugins.find((plugin) => plugin.canonicalId === `connection:${OWNER_CONNECTION_ID}`);
    expect(mail?.systemMessage?.includes("Reply tools take body and either an exact known messageId or a Gmail query")).toBe(capabilities.includes("gmail.read"));
    const examples = workedExampleCalls(mail?.systemMessage ?? "")
      .filter((call) => /google_gmail_(?:send|create_draft|reply|create_reply_draft)$/u.test(call.wireName));
    expect(examples.map((call) => [call.wireName, call.arguments])).toMatchObject(
      expected.map(([wireName, intent]) => [wireName, intent === "reply" ? { messageId: "18f0a2c4d5e6f702", body: "Thank you, Dana." } : { to: ["dana@example.com"], subject: "Renewal", body: "Hello Dana." }]),
    );
    for (const call of examples) {
      const name = call.wireName.replace("google_gmail_", "gmail.");
      const tool = mail?.tools.find((candidate) => candidate.definition.name === name);
      expect(tool?.validateInput?.(call.arguments)).toBeNull();
    }
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

  // Captured with the pre-split combined projection and its original surface.
  // Hashes are fixture data, not derived from the policy being checked.
  it.each(combinedGoogleReceipts)("replays a pre-split Google $mode receipt without relaxing its fences", async (receipt) => {
    const database = new ToolSelectionDatabase([connection(OWNER_CONNECTION_ID, "personal", USER_ID,
      [...GOOGLE_WORKSPACE_CAPABILITIES, ...GOOGLE_MAIL_CALENDAR_CAPABILITIES])]);
    const selected = await __integrationTesting.loadHarnessTools(env(database), workflowInput());
    const pluginId = `connection:${OWNER_CONNECTION_ID}:drive`;
    const policy = __integrationTesting.resolveHarnessToolReceiptPolicy({ pluginId,
      canonicalToolName: receipt.canonicalToolName, capability: receipt.capability,
      mode: receipt.mode as "read" | "write", idempotency: receipt.idempotency as "safe" | "record_before_execute" }, selected);
    expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify(receipt), policy)).toBe(true);
    for (const changed of [
      { pluginId: `connection:${WORKSPACE_CONNECTION_ID}` }, { connectionId: WORKSPACE_CONNECTION_ID },
      { toolSurfaceHash: "changed-surface" }, { canonicalToolName: "drive.download" }, { capability: "gmail.read" },
      { mode: receipt.mode === "read" ? "write" : "read" },
      { idempotency: receipt.idempotency === "safe" ? "record_before_execute" : "safe" },
    ]) expect(__integrationTesting.storedToolPolicyMatches(JSON.stringify({ ...receipt, ...changed }), policy)).toBe(false);
    expect(__integrationTesting.compatiblePriorReceiptPlans({ ...receipt, pluginId,
      toolSurfaceHash: policy.toolSurfaceHash, inputHash: "same-input" }, policy))
      .toContainEqual({ ...receipt, inputHash: "same-input" });
  });

  it.each([
    { saved: "plugin_google_mail_calendar", removed: "plugin_google_drive", retained: GOOGLE_MAIL_CALENDAR_CAPABILITIES },
    { saved: "plugin_google_drive", removed: "plugin_google_mail_calendar", retained: GOOGLE_WORKSPACE_CAPABILITIES },
  ])("preloads saved $saved after the other Google bundle is removed", async ({ saved, removed, retained }) => {
    const row = connection(OWNER_CONNECTION_ID, "personal", USER_ID, [...GOOGLE_WORKSPACE_CAPABILITIES, ...GOOGLE_MAIL_CALENDAR_CAPABILITIES]);
    const database = new ToolSelectionDatabase([row]);
    database.defaultPluginIds = [saved];
    const before = await __integrationTesting.loadHarnessTools(env(database), automationRunInput());
    expect(before.plugins.filter((plugin) => plugin.connectorType === "google" && plugin.preload).map((plugin) => plugin.modelId))
      .toEqual([saved]);
    row.granted_scopes_json = JSON.stringify(retained);
    const after = await __integrationTesting.loadHarnessTools(env(database), automationRunInput());
    expect(after.plugins.filter((plugin) => plugin.connectorType === "google").map((plugin) => ({
      modelId: plugin.modelId, preload: plugin.preload, explicit: plugin.explicit,
    }))).toEqual([{ modelId: "plugin_google", preload: true, explicit: true }]);
    database.defaultPluginIds = [removed];
    const denied = await __integrationTesting.loadHarnessTools(env(database), automationRunInput());
    expect(denied.plugins.filter((plugin) => plugin.connectorType === "google").map((plugin) => plugin.preload)).toEqual([false]);
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
    // A scheduled activation names only the run, in the request shape every
    // deployed SidekickDO accepts: its strict schema would refuse a field it
    // does not know during a mixed-version rollout.
    expect(database.runDefinitionReads).toEqual([{
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      runId: RUN_ID,
    }]);

    // A continuation names the revision `continueRun` handed it, which may be
    // newer than the one the run started with.
    await __integrationTesting.loadHarnessTools(env(database), {
      ...automationRunInput(),
      automationContinuation: { stopGeneration: 0, senderName: "Member", source: { kind: "run" } },
    });
    expect(database.runDefinitionReads.at(-1)).toEqual({
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      runId: RUN_ID,
      definitionRevision: 1,
    });

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
      "drive.search_next",
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
  it("lets an automation's own conversation change only that automation", async () => {
    const database = new ToolSelectionDatabase([]);
    database.automationOwners.set(OWNED_AUTOMATION_ID, WORKSTREAM_ID);
    const submit = await automationCreatorTool(database, automationConversationInput(), "submit_draft");

    await expect(submit.execute(
      { ...manualDraft("Someone else's job"), icon: "file-text", color: "blue", sidekickId: OWNED_AUTOMATION_ID },
      { toolCallId: "edit-another-automation" } as never,
    )).rejects.toThrow("edits only its own Sidekick");
    expect(database.submittedDefinitions).toEqual([]);

    await expect(submit.execute(
      { ...manualDraft("Named itself"), icon: "file-text", color: "blue", sidekickId: AUTOMATION_ID },
      { toolCallId: "edit-itself-by-id" } as never,
    )).resolves.toMatchObject({ output: { accepted: true } });
    await expect(submit.execute(
      { ...manualDraft("Named nothing"), icon: "file-text", color: "blue", sidekickId: null },
      { toolCallId: "edit-itself-by-default" } as never,
    )).resolves.toMatchObject({ output: { accepted: true } });

    expect(database.submittedDefinitions.map((request) => request.automationId))
      .toEqual([AUTOMATION_ID, AUTOMATION_ID]);
    // The icon and colour ride beside the draft to the object, not inside it.
    expect(database.submittedDefinitions.map((request) => request.appearance))
      .toEqual([{ icon: "file-text", color: "blue" }, { icon: "file-text", color: "blue" }]);
    // Nothing is created here either: the automation this conversation belongs
    // to already exists, and its own chat has no room to post a proposal into.
    expect(database.createdAutomations).toEqual([]);
    expect(database.proposedDraftCards).toEqual([]);
  });

  it("lists only itself from a Sidekick authoring conversation", async () => {
    const database = new ToolSelectionDatabase([]);
    database.automationDetails.set(AUTOMATION_ID, automationDetail(AUTOMATION_ID, "Drive digest"));
    const ownList = await automationCreatorTool(database, automationConversationInput(), "sidekicks_list");
    await expect(ownList.execute({}, { toolCallId: "list-in-automation" } as never))
      .resolves.toMatchObject({
        output: {
          sidekicks: [{ sidekickId: AUTOMATION_ID, name: "Drive digest" }],
        },
      });
    // The room's rail is never consulted from an automation's own conversation:
    // the one automation it may edit is the one it belongs to.
    expect(database.workstreamAutomationListReads).toEqual([]);
    expect(database.detailReads.map((request) => request.automationId)).toEqual([AUTOMATION_ID]);
  });
});

function authorityStreamResponse(events: unknown[]): Response {
  return responsesStreamResponse(events);
}
