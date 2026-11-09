import {
  asAutomationId,
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
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
const AUTOMATION_ID = asAutomationId("00000000-0000-4000-8000-000000000005");
const ACTIVITY_ID = "00000000-0000-4000-8000-000000000006";
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000007");
const CONNECTION_ID = "00000000-0000-4000-8000-000000000008";

type RunState = "pending" | "running" | "needs_input" | "completed" | "failed" | "stopped";
type Lifecycle = "draft" | "active" | "paused" | "deleted";

type AuthorityState = {
  memberStatus: string;
  archivedAt: string | null;
  activityExists: boolean;
  /**
   * What the automation's own object says about the run right now, and the
   * one live fact the revalidation re-reads: whether the automation still
   * consents to the run it admitted. `null` is a run the automation does not
   * know.
   */
  run: { state: RunState; lifecycle: Lifecycle; stopGeneration?: number } | null;
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
  /** Every `readRunState` request, so a test can assert which run was asked about. */
  readonly runStateReads: Array<Record<string, unknown>> = [];
  /**
   * The conversation parent's own object.
   *
   * The archive gate the revalidation reads is the identity authority's row,
   * so it is held by the real storage class over a real object store rather
   * than by another arm of the matcher below. Seeded for the parent the input
   * names: the automation for an automation run, the work stream otherwise.
   */
  readonly objectStore: DatabaseSync;
  readonly env: Env;

  constructor(readonly state: AuthorityState, parentId: string = AUTOMATION_ID) {
    this.binding = createTestD1Database({
      prepare: (sql: string) => createTestD1PreparedStatement(new AuthorityStatement(this, sql)),
    });
    this.objectStore = testWorkstreamObjectStore();
    openStores.push(this.objectStore);
    seedWorkstreamObjectRoot(this.objectStore, {
      workstreamId: parentId,
      workspaceId: WORKSPACE_ID,
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
          // The Sidekick, hosted here, is the only authority on whether it
          // still wants this run finished.
          sidekickReadRunState: async (request: Record<string, unknown>) => {
            this.runStateReads.push(request);
            return this.state.run ? this.state.run : null;
          },
          sidekickNoteCoordinatorUnavailable: async () => undefined,
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
    activityExists: true,
    run: { state: "running", lifecycle: "active" },
    ...overrides,
  };
}

/** A run under an automation: the automation is the parent, the run is its child substream. */
function input(activityId: string | null = null): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "automation",
    parentId: AUTOMATION_ID,
    substreamId: asSubstreamId(RUN_ID),
    loopId: `workstream:${AUTOMATION_ID}:substream:${RUN_ID}:loop`,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    activityId,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "automation",
    automationRun: {
      schemaVersion: 1,
      automationId: AUTOMATION_ID,
      runId: RUN_ID,
      definitionRevision: 1,
      trigger: activityId
        ? {
            kind: "external_event",
            workspaceEventId: activityId,
            eventType: "issue.created",
            occurredAt: Date.parse("2026-08-18T00:00:00.000Z"),
            payloadHash: "activity-hash",
          }
        : { kind: "manual", requestedByUserId: USER_ID },
    },
  };
}

/** A run in a work stream, which no automation has to consent to. */
function workstreamInput(): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "canvas",
    parentId: WORKSTREAM_ID,
    loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
    harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "human_message",
  };
}

describe("durable run authority revalidation", () => {
  it("keeps a valid authority decision when diagnostic timing throws", async () => {
    const database = new AuthorityDatabase(state());
    const observed: string[] = [];
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(
      database.env,
      input(),
      undefined,
      (stage) => {
        observed.push(stage);
        throw new Error("diagnostic unavailable");
      },
    );
    expect(snapshot.automationRunId).toBe(RUN_ID);
    expect(observed).toEqual(["principal", "identity", "automation"]);
  });

  it("admits a running automation run and re-reads only the automation's consent", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    expect(snapshot).toEqual({
      automationRunId: RUN_ID,
      automationTemplateVersionId: `${AUTOMATION_ID}:1`,
      triggerType: "manual",
    });
    // Asked about this run of this automation, not about the automation alone:
    // an automation that is active again after a pause and resume still does
    // not consent to the run the pause stopped.
    expect(database.runStateReads).toEqual([{
      workspaceId: WORKSPACE_ID,
      automationId: AUTOMATION_ID,
      runId: RUN_ID,
    }]);
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .resolves.toEqual(snapshot);
  });

  it("keeps a run that is waiting on a person alive", async () => {
    const database = new AuthorityDatabase(state({ run: { state: "needs_input", lifecycle: "active" } }));
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .resolves.toEqual(snapshot);
  });

  it("stops a run whose automation was paused after it was admitted", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    database.state.run = { state: "running", lifecycle: "paused" };
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .rejects.toThrow(/no longer running/i);
  });

  it.each([
    "stopped",
    "completed",
    "failed",
  ] as const)("stops a run its automation marked %s before a provider write", async (runState) => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    database.state.run = { state: runState, lifecycle: "active" };
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .rejects.toThrow(/no longer running/i);
  });

  describe("a continued run, whose row reopens only when its child's projection lands", () => {
    const STOP_GENERATION = 3;
    function continued(): WorkstreamWorkflowInput {
      return {
        ...input(),
        automationContinuation: { stopGeneration: STOP_GENERATION, senderName: "Adam", source: { kind: "run" } },
      };
    }

    it.each(["completed", "failed"] as const)("acts through a %s row: the child's own finish, never a revocation", async (runState) => {
      const database = new AuthorityDatabase(state({
        run: { state: runState, lifecycle: "active", stopGeneration: STOP_GENERATION + 1 },
      }));
      await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, continued()))
        .resolves.toMatchObject({ automationRunId: RUN_ID });
    });

    it("acts through a row stopped before the continuation was approved", async () => {
      const database = new AuthorityDatabase(state({
        run: { state: "stopped", lifecycle: "active", stopGeneration: STOP_GENERATION },
      }));
      await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, continued()))
        .resolves.toMatchObject({ automationRunId: RUN_ID });
    });

    it("stops when a pause stopped the row after the approval, even once the Sidekick is resumed", async () => {
      const database = new AuthorityDatabase(state({
        run: { state: "stopped", lifecycle: "active", stopGeneration: STOP_GENERATION + 1 },
      }));
      await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, continued()))
        .rejects.toThrow(/no longer running/i);
    });

    it("stops when the Sidekick is paused, whatever the row says", async () => {
      const database = new AuthorityDatabase(state({
        run: { state: "completed", lifecycle: "paused", stopGeneration: STOP_GENERATION },
      }));
      await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, continued()))
        .rejects.toThrow(/no longer running/i);
    });
  });

  it("stops a run its automation no longer knows", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, input());
    database.state.run = null;
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input(), snapshot))
      .rejects.toThrow(/no longer running/i);
  });

  it("does not re-read mutable connector evidence after admission", async () => {
    const database = new AuthorityDatabase(state());
    const activityInput = input(ACTIVITY_ID);
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, activityInput);
    expect(snapshot.triggerType).toBe("external_event");
    database.state.activityExists = false;
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, activityInput, snapshot))
      .resolves.toEqual(snapshot);
  });

  it("does not consult WorkspaceDO for connector evidence frozen into the run", async () => {
    const database = new AuthorityDatabase(state({ activityExists: false }));
    let durableActivityExists = true;
    const connectorEvent = vi.fn(async () => durableActivityExists
      ? { connectorType: "github", activity: connectorActivity() }
      : null);
    const namespace = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      // The run's own state is the Sidekick's, hosted in the same object.
      get: () => ({ connectorEvent, sidekickReadRunState: async () => database.state.run
        ? database.state.run : null }),
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

  it("rejects a removed member before the automation is even asked", async () => {
    const database = new AuthorityDatabase(state({ memberStatus: "removed" }));
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input()))
      .rejects.toThrow(/not an active workspace member/i);
    expect(database.runStateReads).toEqual([]);
  });

  it("rejects an archived parent before a tool can run", async () => {
    const database = new AuthorityDatabase(state({ archivedAt: "2026-08-03T00:00:00.000Z" }));
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, input()))
      .rejects.toThrow(/no longer active/i);
    expect(database.runStateReads).toEqual([]);
  });

  it("treats a run with no automation reference as a work-stream run and asks no automation", async () => {
    const database = new AuthorityDatabase(state(), WORKSTREAM_ID);
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.env, workstreamInput());
    expect(snapshot).toEqual({
      automationRunId: null,
      automationTemplateVersionId: null,
      triggerType: null,
    });
    expect(database.runStateReads).toEqual([]);
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.env, workstreamInput(), snapshot))
      .resolves.toEqual(snapshot);
  });
});
