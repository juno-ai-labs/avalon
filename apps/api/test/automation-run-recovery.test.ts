import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { AutomationService } from "../src/services/automation-service";

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

  readonly binding = {
    prepare: (sql: string) => new ManualRunStatement(this, sql) as unknown as D1PreparedStatement,
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
      return results;
    },
  } as unknown as D1Database;
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
      const run = this.database.run;
      if (!run || run.workspaceId !== this.values[0] || run.subscriptionId !== this.values[1] || run.idempotencyKey !== this.values[2]) {
        return null;
      }
      const harness = this.database.harnessRun;
      return {
        run_id: run.id,
        workstream_id: run.workstreamId,
        run_status: run.status,
        run_workflow_instance_id: run.workflowInstanceId,
        harness_run_id: harness?.id ?? null,
        harness_status: harness?.status ?? null,
        harness_workflow_instance_id: harness?.workflowInstanceId ?? null,
      } as T;
    }
    throw new Error(`Unexpected first() query: ${normalized}`);
  }

  async run<T>(): Promise<D1Result<T>> {
    const normalized = this.normalizedSql();
    if (normalized.startsWith("INSERT INTO workstreams")) {
      this.database.workstreamStatus = String(this.values[7]);
    } else if (normalized.startsWith("INSERT INTO automation_runs")) {
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
    return {
      success: true,
      results: [],
      meta: { changes: 1 },
    } as unknown as D1Result<T>;
  }

  private normalizedSql(): string {
    return this.sql.replace(/\s+/gu, " ").trim();
  }
}

describe("manual automation run recovery", () => {
  it("retries a launch-pending idempotent run after a transient workflow failure", async () => {
    const database = new ManualRunDatabase();
    const createWorkflow = vi.fn()
      .mockRejectedValueOnce(new Error("temporary workflow service outage"))
      .mockResolvedValueOnce({});
    const env = {
      DB: database.binding,
      WORKSTREAM_LOOP_WORKFLOW: { create: createWorkflow },
      AVALON_REGION: "global",
      OPENROUTER_PRIMARY_MODEL: "test-model",
    } as unknown as Env;
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

    await expect(service.runNow("subscription-1", "manual-retry-key")).resolves.toMatchObject({
      runId: originalRunId,
      reused: true,
    });
    expect(createWorkflow).toHaveBeenCalledTimes(2);
  });
});
