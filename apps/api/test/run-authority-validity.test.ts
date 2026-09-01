import { asAutomationId, asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { __integrationTesting } from "../src/services/integrations";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = asUserId("00000000-0000-4000-8000-000000000004");
const SUBSCRIPTION_ID = asAutomationId("00000000-0000-4000-8000-000000000005");
const ACTIVITY_ID = "00000000-0000-4000-8000-000000000006";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000008";

type AuthorityState = {
  memberStatus: string;
  archivedAt: string | null;
  subscriptionStatus: string;
  subscriptionLifecycleState: string;
  templateVersionId: string;
  templateArchivedAt: string | null;
  automationRunStatus: string;
  triggerType: string;
  triggerActivityId: string | null;
  hasEnabledSchedule: number;
  emailRouteStatus: string;
  activityExists: boolean;
  /**
   * What the automation's own durable object says about the run right now.
   *
   * Separate from the legacy `subscription*` fields above, and deliberately so:
   * those are the D1 rows the revalidation must *not* re-read, while this is
   * the one live fact it does — whether the automation still consents to the
   * run it admitted.
   */
  agentLifecycle: string;
  agentAuthorityGeneration: number;
  agentRunPresent: boolean;
};

/** The connector event the WorkspaceDO answers a trigger lookup with. */
function connectorActivity() {
  return {
    id: ACTIVITY_ID,
    workspaceId: WORKSPACE_ID,
    region: "global",
    connectionId: CONNECTION_ID,
    connectionScope: "workspace",
    connectionOwnerUserId: null,
    provider: "github",
    providerEventId: "delivery-1",
    eventType: "issue.created",
    resourceType: "issue",
    providerResourceId: "issue-1",
    actor: {},
    subject: {},
    occurredAt: "2026-08-18T00:00:00.000Z",
    receivedAt: "2026-08-18T00:00:01.000Z",
    title: "Issue created",
    summary: "A new issue needs attention",
    textSnippet: "Details",
    payloadRef: null,
    visibility: {},
    targetUserIds: [],
    entityKeys: ["issue-1"],
    dedupeKey: "issue-created-1",
    rawContentHash: null,
    metadata: {},
    externalPeople: [],
  };
}

class AuthorityDatabase {
  readonly binding: D1Database;
  legacyActivityReads = 0;
  /**
   * The work stream's own object.
   *
   * The archive gate and the automation ids the revalidation reads are the
   * identity authority's row, so they are held by the real storage class over
   * a real object store rather than by another arm of the matcher below.
   */
  readonly objectStore: DatabaseSync;
  readonly env: Env;

  constructor(readonly state: AuthorityState) {
    this.binding = createTestD1Database({
      prepare: (sql: string) => createTestD1PreparedStatement(new AuthorityStatement(this, sql)),
    });
    this.objectStore = testWorkstreamObjectStore();
    openStores.push(this.objectStore);
    seedWorkstreamObjectRoot(this.objectStore, {
      workstreamId: WORKSTREAM_ID,
      workspaceId: WORKSPACE_ID,
      automationSubscriptionId: SUBSCRIPTION_ID,
      automationRunId: RUN_ID,
      archivedAt: state.archivedAt === null ? null : Date.parse(state.archivedAt),
    });

    this.env = createTestEnv({
      DB: this.binding,
      AVALON_REGION: "global",
      APP_ENV: "test",
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(this.objectStore),
      // The evidence a connector run was started from is the WorkspaceDO's.
      // The regional `activities` fallback beside it is gone, so a fixture
      // that wants a trigger to exist has to say so here.
      WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: () => ({
          connectorEvent: async () => (this.state.activityExists
            ? { connectorType: "github", activity: connectorActivity() }
            : null),
        }),
      }),
      // The automation's own object, which is the only authority on whether it
      // still wants this run finished.
      AUTOMATION_AGENTS: createCloudflareTestBinding<Env["AUTOMATION_AGENTS"]>({
        idFromName: (name: string) => createTestDurableObjectId(name),
        get: () => ({
          readRunAuthority: async () => ({
            lifecycle: this.state.agentLifecycle,
            authorityGeneration: this.state.agentAuthorityGeneration,
            runPresent: this.state.agentRunPresent,
          }),
        }),
      }),
    });
  }
}

const openStores: DatabaseSync[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

class AuthorityStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: AuthorityDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): AuthorityStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql.replace(/\s+/gu, " ").trim();
    if (sql.includes("FROM workspace_members wm")) {
      expect(this.values).toEqual([WORKSPACE_ID, USER_ID]);
      return { status: this.database.state.memberStatus } as T;
    }
    if (sql.includes("FROM workstream_authority_control")) {
      return {
        phase: "durable_object_open",
        generation: 1,
        required_serving_contract_version: 1,
        serving_contract_version: 1,
      } as T;
    }
    if (sql.includes("SELECT placement_affinity FROM workspaces")) {
      return { placement_affinity: "wnam" } as T;
    }
    if (sql.includes("FROM automation_subscriptions s")) {
      expect(this.values).toEqual([RUN_ID, WORKSTREAM_ID, SUBSCRIPTION_ID, WORKSPACE_ID]);
      return {
        subscription_status: this.database.state.subscriptionStatus,
        subscription_lifecycle_state: this.database.state.subscriptionLifecycleState,
        template_version_id: this.database.state.templateVersionId,
        email_route_status: this.database.state.emailRouteStatus,
        template_archived_at: this.database.state.templateArchivedAt,
        automation_run_id: RUN_ID,
        automation_run_status: this.database.state.automationRunStatus,
        trigger_type: this.database.state.triggerType,
        trigger_activity_id: this.database.state.triggerActivityId,
        has_enabled_schedule: this.database.state.hasEnabledSchedule,
      } as T;
    }
    if (sql.includes("SELECT id FROM activities")) {
      this.database.legacyActivityReads += 1;
      expect(this.values).toEqual([ACTIVITY_ID, WORKSPACE_ID]);
      return (this.database.state.activityExists ? { id: ACTIVITY_ID } : null) as T | null;
    }
    throw new Error(`Unexpected authority query: ${sql}`);
  }
}

function state(overrides: Partial<AuthorityState> = {}): AuthorityState {
  return {
    memberStatus: "active",
    archivedAt: null,
    subscriptionStatus: "active",
    subscriptionLifecycleState: "visible",
    templateVersionId: "version-one",
    templateArchivedAt: null,
    automationRunStatus: "running",
    triggerType: "schedule",
    triggerActivityId: null,
    hasEnabledSchedule: 1,
    emailRouteStatus: "active",
    activityExists: true,
    agentLifecycle: "active",
    agentAuthorityGeneration: 1,
    agentRunPresent: true,
    ...overrides,
  };
}

function input(activityId: string | null = null): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
    harnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000007"),
    triggerMessageId: null,
    automationSubscriptionId: SUBSCRIPTION_ID,
    activityId,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "automation",
    automationRunContext: {
      schemaVersion: 1,
      automationId: SUBSCRIPTION_ID,
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      authorityGeneration: 1,
      definitionRevision: 1,
      definition: {
        name: "Issue watcher",
        description: "Watches issues.",
        overview: "Report matching issues.",
        instructions: "Report the issue.",
        requiredCapabilities: [],
        expectedOutputs: [],
        defaultBehavior: {},
        recommendedPlugins: [],
        memoryTables: [],
      },
      defaultPluginIds: [],
      activitySourcePluginIds: {},
      connectorBindings: {},
      deliveryTargets: [],
      owningWorkstreamId: null,
      modelOverride: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      trigger: activityId
        ? {
            kind: "external_event",
            workspaceEventId: activityId,
            eventType: "issue.created",
            occurredAt: Date.parse("2026-08-18T00:00:00.000Z"),
            payloadHash: "activity-hash",
          }
        : { kind: "manual", requestedByUserId: USER_ID },
      opening: null,
      memoryScope: { automationId: SUBSCRIPTION_ID, authorityGeneration: 1 },
    },
  };
}

describe("durable run authority revalidation", () => {
  it("keeps an admitted run immutable when its automation is later paused", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    database.state.subscriptionStatus = "paused";
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .resolves.toEqual(snapshot);
  });

  it("keeps an admitted run immutable when its automation is later deleted", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    database.state.subscriptionLifecycleState = "deleted";
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .resolves.toEqual(snapshot);
  });

  it("does not revoke an admitted run when a later schedule is disabled", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    database.state.hasEnabledSchedule = 0;
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .resolves.toEqual(snapshot);
  });

  it("rejects a template-version change so run authority cannot widen", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    const changed = input();
    changed.automationRunContext = {
      ...changed.automationRunContext!,
      definitionRevision: 2,
    };
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, changed, snapshot))
      .rejects.toThrow(/immutable run authority changed/i);
  });

  it("does not re-read mutable connector evidence after admission", async () => {
    const database = new AuthorityDatabase(state({
      triggerType: "issue.created",
      triggerActivityId: ACTIVITY_ID,
    }));
    const activityInput = input(ACTIVITY_ID);
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, activityInput);
    database.state.activityExists = false;
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, activityInput, snapshot))
      .resolves.toEqual(snapshot);
  });

  it("does not consult WorkspaceDO for connector evidence frozen into the run", async () => {
    const database = new AuthorityDatabase(state({
      triggerType: "issue.created",
      triggerActivityId: ACTIVITY_ID,
      activityExists: false,
    }));
    let durableActivityExists = true;
    const connectorEvent = vi.fn(async () => durableActivityExists
      ? { connectorType: "github", activity: connectorActivity() }
      : null);
    const namespace = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => ({ connectorEvent }),
    });
    const env = createTestEnv({
      ...database.env,
      // This test drives the trigger lookup itself, so it replaces the
      // fixture's WorkspaceDO with one it can flip mid-run.
      WORKSPACE_DOS: namespace,
    });
    const activityInput = input(ACTIVITY_ID);

    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(env, activityInput);
    expect(database.legacyActivityReads).toBe(0);
    expect(connectorEvent).not.toHaveBeenCalled();

    durableActivityExists = false;
    await expect(__integrationTesting.assertRunAuthorityStillValid(env, activityInput, snapshot))
      .resolves.toEqual(snapshot);
    expect(database.legacyActivityReads).toBe(0);
    expect(connectorEvent).not.toHaveBeenCalled();
  });

  it("stops a run whose automation was paused after it was admitted", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    database.state.agentLifecycle = "paused";
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .rejects.toThrow(/no longer running/i);
  });

  it("stops a run left behind by a newer authority generation", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    // What a pause-and-resume, or a re-accepted definition, looks like from
    // here: the automation is running again, but not the run this tool belongs
    // to. Lifecycle alone would read as consent.
    database.state.agentAuthorityGeneration = 2;
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .rejects.toThrow(/no longer running/i);
  });

  it("rejects an archived work stream before a tool can run", async () => {
    const database = new AuthorityDatabase(state({ archivedAt: "2026-08-03T00:00:00.000Z" }));
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input()))
      .rejects.toThrow(/work stream is no longer active/i);
  });
});
