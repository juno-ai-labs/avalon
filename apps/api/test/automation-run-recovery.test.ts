import { describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

interface StoredRun {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  workstreamId: string;
  status: string;
  startedAt: string | null;
  idempotencyKey: string;
  workflowInstanceId: string | null;
}

interface StoredHarnessRun {
  id: string;
  workspaceId: string;
  workstreamId: string;
  status: string;
  startedAt: string | null;
  workflowInstanceId: string | null;
}

interface StoredEmailRoute {
  local_part: string;
  region: "global";
  workspace_id: string;
  workstream_id: string;
  status: "reserved" | "active" | "disabled";
}

interface StoredWorkstreamEmailOwner {
  id: string;
  workspace_id: string;
  email_address: string;
  email_route_status: "reserved" | "active" | "disabled";
  archived_at: string | null;
}

interface StoredOpeningMessage {
  id: string;
  clientMessageId: string;
  workspaceId: string;
  workstreamId: string;
  textContent: string;
  structuredContent: Record<string, unknown>;
}

class ManualRunDatabase {
  readonly subscription: Record<string, unknown> = {
    id: "subscription-1",
    workspace_id: "workspace-1",
    status: "active",
    scope: "personal",
    owner_user_id: "user-1",
    name: "Daily brief",
    description: "Build the daily brief",
    execution_principal_json: JSON.stringify({ type: "user", userId: "user-1" }),
  };

  run: StoredRun | null = null;
  harnessRun: StoredHarnessRun | null = null;
  workstreamStatus: string | null = null;
  workstreamEmailOwner: StoredWorkstreamEmailOwner | null = null;
  emailRoute: StoredEmailRoute | null = null;
  openingMessage: StoredOpeningMessage | null = null;
  attachedResourceId: string | null = null;
  automationResource: {
    id: string;
    scope: "personal" | "workspace";
    ownerUserId: string;
    archived: boolean;
  } | null = null;
  workstreamInsertCount = 0;
  automationRunInsertCount = 0;

  readonly binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new ManualRunStatement(this, sql)),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
      return results;
    },
  });
}

class ManualRunStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: ManualRunDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): ManualRunStatement {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const normalized = this.normalizedSql();
    if (normalized.includes("FROM automation_subscriptions s JOIN automation_templates")) {
      return this.database.subscription as T;
    }
    if (normalized.includes("FROM automation_runs r LEFT JOIN harness_runs h")) {
      if (!normalized.includes("h.parent_tool_call_id IS NULL")) {
        throw new Error("idempotent automation recovery must ignore inline child runs");
      }
      const run = this.database.run;
      if (!run || run.workspaceId !== this.values[0] || run.subscriptionId !== this.values[1] || run.idempotencyKey !== this.values[2]) {
        return null;
      }
      const harness = this.database.harnessRun;
      const openingMessage = this.database.openingMessage;
      return {
        run_id: run.id,
        workstream_id: run.workstreamId,
        run_status: run.status,
        run_workflow_instance_id: run.workflowInstanceId,
        harness_run_id: harness?.id ?? null,
        harness_status: harness?.status ?? null,
        harness_workflow_instance_id: harness?.workflowInstanceId ?? null,
        trigger_message_id: openingMessage && openingMessage.clientMessageId === this.values[3]
          ? openingMessage.id
          : null,
      } as T;
    }
    if (normalized.includes("SELECT email_address, email_route_status, archived_at FROM workstreams")) {
      const owner = this.database.workstreamEmailOwner;
      if (!owner || owner.id !== this.values[0] || owner.workspace_id !== this.values[1]) {
        return null;
      }
      return {
        email_address: owner.email_address,
        email_route_status: owner.email_route_status,
        archived_at: owner.archived_at,
      } as T;
    }
    if (normalized.includes("FROM workstream_email_routes") && normalized.includes("WHERE region = ?")) {
      const route = this.database.emailRoute;
      if (!route || route.region !== this.values[0] || route.workspace_id !== this.values[1] || route.workstream_id !== this.values[2]) {
        return null;
      }
      return route as T;
    }
    throw new Error(`Unexpected first() query: ${normalized}`);
  }

  async run<T>(): Promise<D1Result<T>> {
    const normalized = this.normalizedSql();
    if (normalized.startsWith("INSERT INTO workstreams")) {
      this.database.workstreamInsertCount += 1;
      this.database.workstreamStatus = String(this.values[8]);
      this.database.workstreamEmailOwner = {
        id: String(this.values[0]),
        workspace_id: String(this.values[1]),
        email_address: String(this.values[4]),
        email_route_status: "reserved",
        archived_at: null,
      };
    } else if (normalized.startsWith("INSERT INTO workstream_email_routes")) {
      if (!this.database.emailRoute) {
        this.database.emailRoute = {
          local_part: String(this.values[0]),
          region: String(this.values[1]) as "global",
          workspace_id: String(this.values[2]),
          workstream_id: String(this.values[3]),
          status: "reserved",
        };
      }
    } else if (normalized.startsWith("UPDATE workstream_email_routes SET status")) {
      const route = this.database.emailRoute;
      const matches = route
        && route.region === this.values[4]
        && route.workspace_id === this.values[5]
        && route.workstream_id === this.values[6];
      if (matches) route.status = String(this.values[0]) as StoredEmailRoute["status"];
      return createTestD1Result<T>({
        success: true,
        results: [],
        meta: { changes: matches ? 1 : 0 },
      });
    } else if (normalized.startsWith("UPDATE workstreams SET email_route_status")) {
      const owner = this.database.workstreamEmailOwner;
      const matches = owner
        && owner.id === this.values[2]
        && owner.workspace_id === this.values[3]
        && owner.email_address.toLowerCase() === String(this.values[4]).toLowerCase();
      if (matches) {
        owner.email_route_status = String(this.values[0]) as StoredWorkstreamEmailOwner["email_route_status"];
      }
      return createTestD1Result<T>({
        success: true,
        results: [],
        meta: { changes: matches ? 1 : 0 },
      });
    } else if (normalized.startsWith("INSERT INTO automation_runs")) {
      this.database.automationRunInsertCount += 1;
      this.database.run = {
        id: String(this.values[0]),
        workspaceId: String(this.values[1]),
        subscriptionId: String(this.values[2]),
        workstreamId: String(this.values[3]),
        startedAt: this.values[7] == null ? null : String(this.values[7]),
        status: String(this.values[8]),
        idempotencyKey: String(this.values[9]),
        workflowInstanceId: null,
      };
    } else if (normalized.startsWith("INSERT INTO messages")) {
      this.database.openingMessage = {
        id: String(this.values[0]),
        clientMessageId: String(this.values[1]),
        workspaceId: String(this.values[2]),
        workstreamId: String(this.values[3]),
        textContent: String(this.values[4]),
        structuredContent: JSON.parse(String(this.values[5])) as Record<string, unknown>,
      };
    } else if (normalized.startsWith("INSERT OR IGNORE INTO workstream_resources")) {
      expect(normalized).toContain("JOIN notes n ON n.resource_id = ar.resource_id");
      expect(normalized).toContain("n.archived_at IS NULL");
      const resource = this.database.automationResource;
      const principalUserId = this.values[4] == null ? null : String(this.values[4]);
      if (resource && !resource.archived && (
        resource.scope === "workspace" || resource.ownerUserId === principalUserId
      )) {
        this.database.attachedResourceId = resource.id;
      }
    } else if (normalized.startsWith("INSERT INTO workstream_resources")) {
      this.database.attachedResourceId = String(this.values[1]);
    } else if (normalized.startsWith("INSERT INTO harness_runs")) {
      this.database.harnessRun = {
        id: String(this.values[0]),
        workspaceId: String(this.values[1]),
        workstreamId: String(this.values[2]),
        status: "scheduled",
        startedAt: null,
        workflowInstanceId: null,
      };
    } else if (normalized.startsWith("UPDATE harness_runs SET workflow_instance_id")) {
      const harness = this.database.harnessRun;
      if (harness) {
        harness.workflowInstanceId = String(this.values[0]);
        if (normalized.includes("status = CASE") && harness.status === "scheduled") {
          harness.status = "running";
          harness.startedAt = String(this.values[1]);
        }
      }
    } else if (normalized.startsWith("UPDATE automation_runs SET workflow_instance_id")) {
      const run = this.database.run;
      if (run) {
        run.workflowInstanceId = String(this.values[0]);
        if (normalized.includes("status = CASE") && run.status === "scheduled") {
          run.status = "running";
          run.startedAt = String(this.values[1]);
        }
      }
    } else if (normalized.startsWith("UPDATE workstreams SET harness_status")) {
      if (this.database.workstreamStatus === "scheduled") this.database.workstreamStatus = "running";
    } else {
      throw new Error(`Unexpected run() query: ${normalized}`);
    }
    return createTestD1Result<T>({
      success: true,
      results: [],
      meta: { changes: 1 },
    });
  }

  private normalizedSql(): string {
    return this.sql.replace(/\s+/gu, " ").trim();
  }
}

describe("manual automation run recovery", () => {
  it("rechecks note visibility before copying resources into each automation run", async () => {
    const runWithNote = async (scope: "personal" | "workspace", archived = false) => {
      const database = new ManualRunDatabase();
      Object.assign(database.subscription, {
        scope: "workspace",
        owner_user_id: null,
        execution_principal_json: JSON.stringify({ type: "workspace", workspaceId: "workspace-1" }),
      });
      database.automationResource = {
        id: "note-resource-1",
        scope,
        ownerUserId: "user-1",
        archived,
      };
      const service = new AutomationService(createTestEnv({
        DB: database.binding,
        WORKSTREAM_LOOP_WORKFLOW: { create: vi.fn().mockResolvedValue({}) },
        AVALON_REGION: "global",
        OPENROUTER_PRIMARY_MODEL: "test-model",
        WORKSTREAM_EMAIL_ADDRESS_KEY: `note-visibility-${scope}-address-key-v1`,
        WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
      }), {
        sessionId: "session-1",
        userId: "user-1",
        workspaceId: "workspace-1",
        region: "global",
        role: "member",
      });

      await service.runNow("subscription-1", `note-${scope}-run`);
      return database.attachedResourceId;
    };

    await expect(runWithNote("workspace")).resolves.toBe("note-resource-1");
    await expect(runWithNote("personal")).resolves.toBeNull();
    await expect(runWithNote("workspace", true)).resolves.toBeNull();
  });

  it("retries a launch-pending idempotent run after a transient workflow failure", async () => {
    const database = new ManualRunDatabase();
    const createWorkflow = vi.fn()
      .mockRejectedValueOnce(new Error("temporary workflow service outage"))
      .mockResolvedValueOnce({});
    const env = createTestEnv({
      DB: database.binding,
      WORKSTREAM_LOOP_WORKFLOW: { create: createWorkflow },
      AVALON_REGION: "global",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      WORKSTREAM_EMAIL_ADDRESS_KEY: "manual-run-recovery-address-key-v1",
      WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
    });
    const auth: AuthContext = {
      sessionId: "session-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      region: "global",
      role: "member",
    };
    const service = new AutomationService(env, auth);

    await expect(service.runNow("subscription-1", "manual-retry-key"))
      .rejects.toMatchObject({ status: 503, code: "workflow_unavailable" });

    expect(database.run).toMatchObject({ status: "scheduled", workflowInstanceId: null });
    expect(database.harnessRun).toMatchObject({ status: "scheduled", workflowInstanceId: null });
    expect(database.emailRoute).toMatchObject({ status: "active" });
    expect(database.workstreamEmailOwner).toMatchObject({
      email_route_status: "active",
      archived_at: null,
    });
    const originalRunId = database.run?.id;
    const originalWorkstreamId = database.run?.workstreamId;
    const originalHarnessRunId = database.harnessRun?.id;

    const recovered = await service.runNow("subscription-1", "manual-retry-key");

    expect(recovered).toEqual({
      runId: originalRunId,
      workstreamId: originalWorkstreamId,
      harnessRunId: originalHarnessRunId,
      reused: true,
    });
    expect(createWorkflow).toHaveBeenCalledTimes(2);
    const expectedWorkflowId = `workstream-${originalHarnessRunId}`;
    expect(database.run).toMatchObject({ status: "running", workflowInstanceId: expectedWorkflowId });
    expect(database.harnessRun).toMatchObject({ status: "running", workflowInstanceId: expectedWorkflowId });
    expect(database.workstreamStatus).toBe("running");
    expect(database.emailRoute).toMatchObject({
      workstream_id: originalWorkstreamId,
      status: "active",
    });
    expect(database.workstreamEmailOwner).toMatchObject({
      id: originalWorkstreamId,
      email_route_status: "active",
      archived_at: null,
    });

    await expect(service.runNow("subscription-1", "manual-retry-key")).resolves.toMatchObject({
      runId: originalRunId,
      reused: true,
    });
    expect(createWorkflow).toHaveBeenCalledTimes(2);
  });

  it("creates exactly one work stream and run for duplicate inbound email delivery", async () => {
    const database = new ManualRunDatabase();
    const createWorkflow = vi.fn().mockResolvedValue({});
    const env = createTestEnv({
      DB: database.binding,
      WORKSTREAM_LOOP_WORKFLOW: { create: createWorkflow },
      AVALON_REGION: "global",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      WORKSTREAM_EMAIL_ADDRESS_KEY: "inbound-email-automation-address-key-v1",
      WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
    });
    const service = new AutomationService(env, {
      sessionId: "system-inbound-email",
      userId: "user-1",
      workspaceId: "workspace-1",
      region: "global",
      role: "member",
    });
    const opening = {
      resendEmailId: "resend-email-1",
      textContent: "Subject: Prepare the brief\n\nUse the attached notes.",
      structuredContent: {
        kind: "inbound_email",
        provider: "resend",
        untrusted: true,
        emailId: "resend-email-1",
      },
      resourceId: "resource-email-1",
    };

    const first = await service.runFromInboundEmail("subscription-1", opening);
    const duplicate = await service.runFromInboundEmail("subscription-1", opening);

    expect(first).toMatchObject({ reused: false });
    expect(duplicate).toEqual({
      runId: first.runId,
      workstreamId: first.workstreamId,
      harnessRunId: first.harnessRunId,
      reused: true,
    });
    expect(database.workstreamInsertCount).toBe(1);
    expect(database.automationRunInsertCount).toBe(1);
    expect(database.attachedResourceId).toBe("resource-email-1");
    expect(database.openingMessage).toMatchObject({
      clientMessageId: "resend:resend-email-1",
      workstreamId: first.workstreamId,
      textContent: opening.textContent,
      structuredContent: opening.structuredContent,
    });
    expect(createWorkflow).toHaveBeenCalledTimes(1);
    expect(createWorkflow).toHaveBeenCalledWith({
      id: `workstream-${first.harnessRunId}`,
      params: expect.objectContaining({
        workstreamId: first.workstreamId,
        triggerMessageId: database.openingMessage?.id,
        automationSubscriptionId: "subscription-1",
      }),
    });
  });
});
