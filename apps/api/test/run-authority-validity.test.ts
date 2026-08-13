import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import { describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";
import { createTestD1Database, createTestD1PreparedStatement } from "./helpers/cloudflare-test";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000004";
const SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000005";
const ACTIVITY_ID = "00000000-0000-4000-8000-000000000006";

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
};

class AuthorityDatabase {
  readonly binding: D1Database;

  constructor(readonly state: AuthorityState) {
    this.binding = createTestD1Database({
      prepare: (sql: string) => createTestD1PreparedStatement(new AuthorityStatement(this, sql)),
    });
  }
}

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
    if (sql.includes("FROM workstreams") && sql.includes("automation_subscription_id")) {
      expect(this.values).toEqual([WORKSTREAM_ID, WORKSPACE_ID]);
      return {
        archived_at: this.database.state.archivedAt,
        automation_subscription_id: SUBSCRIPTION_ID,
        automation_run_id: RUN_ID,
      } as T;
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
    ...overrides,
  };
}

function input(activityId: string | null = null): WorkstreamWorkflowInput {
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    harnessRunId: "00000000-0000-4000-8000-000000000007",
    triggerMessageId: null,
    automationSubscriptionId: SUBSCRIPTION_ID,
    activityId,
    executionPrincipal: { type: "user", userId: USER_ID },
    reason: "automation",
  };
}

describe("durable run authority revalidation", () => {
  it("rejects a subscription paused between model turns", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.binding, input());
    database.state.subscriptionStatus = "paused";
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.binding, input(), snapshot))
      .rejects.toThrow(/no longer active/i);
  });

  it("rejects a subscription deleted between model turns", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.binding, input());
    database.state.subscriptionLifecycleState = "deleted";
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.binding, input(), snapshot))
      .rejects.toThrow(/no longer active/i);
  });

  it("rejects a trigger disabled after admission", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.binding, input());
    database.state.hasEnabledSchedule = 0;
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.binding, input(), snapshot))
      .rejects.toThrow(/trigger was disabled/i);
  });

  it("rejects a template-version change so run authority cannot widen", async () => {
    const database = new AuthorityDatabase(state());
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.binding, input());
    database.state.templateVersionId = "version-two";
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.binding, input(), snapshot))
      .rejects.toThrow(/immutable run authority changed/i);
  });

  it("rejects removed activity trigger evidence", async () => {
    const database = new AuthorityDatabase(state({
      triggerType: "issue.created",
      triggerActivityId: ACTIVITY_ID,
    }));
    const activityInput = input(ACTIVITY_ID);
    const snapshot = await __integrationTesting.assertRunAuthorityStillValid(database.binding, activityInput);
    database.state.activityExists = false;
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.binding, activityInput, snapshot))
      .rejects.toThrow(/trigger is no longer available/i);
  });

  it("rejects an archived work stream before a tool can run", async () => {
    const database = new AuthorityDatabase(state({ archivedAt: "2026-08-03T00:00:00.000Z" }));
    await expect(__integrationTesting.assertRunAuthorityStillValid(database.binding, input()))
      .rejects.toThrow(/work stream is no longer active/i);
  });
});
