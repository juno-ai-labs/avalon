import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import { testSubstreamAgentsBinding, testWorkstreamObjectStore, workstreamObjectGet } from "./helpers/durable-authority";
import { publishedRunStatus } from "../src/runtime/harness-run-runtime";

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

interface StoredEmailRoute {
  local_part: string;
  region: "global";
  workspace_id: string;
  workstream_id: string;
}

class ManualRunDatabase {
  readonly subscription: Record<string, unknown> = {
    id: "subscription-1",
    workspace_id: "668953d2-25f2-44fd-8d72-1e8cf024a277",
    status: "active",
    scope: "personal",
    owner_user_id: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
    name: "Daily brief",
    description: "Build the daily brief",
    execution_principal_json: JSON.stringify({ type: "user", userId: "d6d77053-92bc-4af6-8332-8bea8c4c6904" }),
  };

  run: StoredRun | null = null;
  /** Every statement that arrived on the work-stream object's port. */
  readonly objectPortSql: string[] = [];
  emailRoute: StoredEmailRoute | null = null;
  attachedResourceId: string | null = null;
  automationResource: {
    id: string;
    scope: "personal" | "workspace";
    ownerUserId: string;
    archived: boolean;
  } | null = null;
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
    if (normalized.includes("SELECT id AS run_id, workstream_id, status AS run_status")
      && normalized.includes("FROM automation_runs")) {
      const run = this.database.run;
      if (!run || run.workspaceId !== this.values[0] || run.subscriptionId !== this.values[1] || run.idempotencyKey !== this.values[2]) {
        return null;
      }
      return {
        run_id: run.id,
        workstream_id: run.workstreamId,
        run_status: run.status,
        run_workflow_instance_id: run.workflowInstanceId,
      } as T;
    }
    if (normalized.includes("FROM automation_resources ar JOIN notes n")) {
      // The open-phase copy reads eligible rows here and attaches each through
      // the object's runtime port; the visibility rule rides on this SELECT.
      const resource = this.database.automationResource;
      const principalUserId = this.values[2] == null ? null : String(this.values[2]);
      if (!resource || resource.archived) return null;
      if (resource.scope !== "workspace" && resource.ownerUserId !== principalUserId) return null;
      return {
        resource_id: resource.id,
        attached_by_user_id: null,
        relationship_type: "context",
      } as T;
    }
    if (normalized.includes("FROM workstream_authority_control")) {
      // Legacy execution arms are retired; every launch requires the open
      // Durable-Object authority, which this deployment models as reached.
      return {
        phase: "durable_object_open",
        generation: 1,
        required_serving_contract_version: 1,
        serving_contract_version: 1,
      } as T;
    }
    if (normalized.includes("FROM workstream_email_routes") && normalized.includes("WHERE region = ?")) {
      const route = this.database.emailRoute;
      if (!route || route.region !== this.values[0] || route.workspace_id !== this.values[1] || route.workstream_id !== this.values[2]) {
        return null;
      }
      return route as T;
    }
    if (normalized.includes("FROM pragma_table_info('workstreams')")) {
      return null;
    }
    throw new Error(`Unexpected first() query: ${normalized}`);
  }

  // The runtime database port reads and writes through `.all()` alike, so the
  // shim routes reads through the pattern table and writes through `run()`.
  async all<T>(): Promise<D1Result<T>> {
    if (!/^\s*(?:SELECT|WITH)/iu.test(this.sql)) return this.run<T>();
    const row = await this.first<T>();
    return createTestD1Result<T>({
      success: true,
      results: row == null ? [] : [row],
      meta: { changes: 0 },
    });
  }

  async run<T>(): Promise<D1Result<T>> {
    const normalized = this.normalizedSql();
    if ((normalized.startsWith("INSERT INTO workstreams") && normalized.includes("(id, workspace_id, do_identity_anchor)"))
      || normalized.startsWith("INSERT OR IGNORE INTO workstreams")
      || normalized.startsWith("INSERT OR IGNORE INTO workstream_authority_routes")) {
      // The regional identity anchor and route the runtime bootstrap reserves;
      // product state lives behind the object port below.
    } else if (normalized.startsWith("INSERT INTO workstream_email_routes")) {
      if (!this.database.emailRoute) {
        this.database.emailRoute = {
          local_part: String(this.values[0]),
          region: String(this.values[1]) as "global",
          workspace_id: String(this.values[2]),
          workstream_id: String(this.values[3]),
        };
      }
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
    } else if (normalized.startsWith("UPDATE automation_runs SET workflow_instance_id")) {
      const run = this.database.run;
      if (run) {
        run.workflowInstanceId = String(this.values[0]);
        if (normalized.includes("status = CASE") && run.status === "scheduled") {
          run.status = "running";
          run.startedAt = String(this.values[1]);
        }
      }
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

/**
 * The SubstreamAgent boundary the retired Workflow binding used to play.
 *
 * Every object-owned operation — the provision, the transcript, the runs, the
 * runtime SQL port — runs against a real object database through the shared
 * stub, so this file asserts on what the storage classes actually wrote. Only
 * the two edges that are not the object's own state stand in: run dispatch,
 * which is the recorded launch, and the resource attachment, whose eligibility
 * rule is what these tests are about. `executeRuntimeSql` is wrapped rather
 * than replaced so the statements that reach the port stay recorded.
 */
function agentsBinding(database: ManualRunDatabase, failures: Error[] = []) {
  const objectStore = testWorkstreamObjectStore();
  openObjectStores.push(objectStore);
  const dispatchRun = vi.fn(() => {
    const failure = failures.shift();
    if (failure) throw failure;
    return { status: 200, bodyJson: "{}" };
  });
  const attachRuntimeResource = vi.fn((input: { resourceId: string }) => {
    database.attachedResourceId = input.resourceId;
    return { status: 200, bodyJson: "{}" };
  });
  const base = testSubstreamAgentsBinding(objectStore, {
    extra: { dispatchRun, attachRuntimeResource },
  });
  const baseStub = base.get(base.idFromName("substream-agent"));
  const identityOperations: string[] = [];
  const stub = new Proxy(baseStub, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "executeIdentityOperation") {
        const forward = value as (input: { operation: string }) => unknown;
        return (input: { operation: string }) => {
          identityOperations.push(input.operation);
          return forward(input);
        };
      }
      if (property !== "executeRuntimeSql") return value;
      const forward = value as (input: RuntimeSqlRequest) => unknown;
      return (input: RuntimeSqlRequest) => {
        for (const statement of input.statements) database.objectPortSql.push(statement.sql);
        return forward(input);
      };
    },
  });
  const namespace = {
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return { binding: namespace, dispatchRun, objectStore, identityOperations };
}

interface RuntimeSqlRequest {
  statements: Array<{ sql: string; params: unknown[] }>;
}

/** The work stream the object holds, in the columns these tests assert on. */
function storedWorkstream(objectStore: DatabaseSync) {
  return workstreamObjectGet<{
    id: string;
    title: string;
    scope: string;
    created_by_user_id: string | null;
    automation_subscription_id: string | null;
    automation_run_id: string | null;
    archived_at: string | null;
    harness_status: string;
  }>(
    objectStore,
    `SELECT id, title, scope, created_by_user_id, automation_subscription_id,
            automation_run_id, archived_at, harness_status
       FROM workstreams`,
  );
}

/** The opening transcript part the object holds, in the legacy vocabulary. */
function storedOpeningMessage(objectStore: DatabaseSync) {
  return workstreamObjectGet<{
    id: string;
    client_message_id: string | null;
    text_content: string;
    structured_content_json: string | null;
  }>(
    objectStore,
    `SELECT id, client_message_id, text_content, structured_content_json
       FROM messages WHERE message_type = 'system'`,
  );
}

/** The root run the object holds, in the published vocabulary. */
function storedHarnessRun(objectStore: DatabaseSync) {
  const run = workstreamObjectGet<{
    id: string;
    status: string;
    workflow_instance_id: string | null;
  }>(
    objectStore,
    `SELECT run_id AS id, status, workflow_instance_id
       FROM runs WHERE substream_id = '0' AND parent_run_id IS NULL`,
  );
  return run === null ? null : { ...run, status: publishedRunStatus(run.status) };
}

const openObjectStores: DatabaseSync[] = [];

afterEach(() => {
  while (openObjectStores.length > 0) openObjectStores.pop()?.close();
});

describe("manual automation run recovery", () => {
  it("rechecks note visibility before copying resources into each automation run", async () => {
    const runWithNote = async (scope: "personal" | "workspace", archived = false) => {
      const database = new ManualRunDatabase();
      Object.assign(database.subscription, {
        scope: "workspace",
        owner_user_id: null,
        execution_principal_json: JSON.stringify({ type: "workspace", workspaceId: "668953d2-25f2-44fd-8d72-1e8cf024a277" }),
      });
      database.automationResource = {
        id: "note-resource-1",
        scope,
        ownerUserId: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
        archived,
      };
      const service = new AutomationService(createTestEnv({
        DB: database.binding,
        SUBSTREAM_AGENTS: agentsBinding(database).binding,
        AVALON_REGION: "global",
        OPENROUTER_PRIMARY_MODEL: "test-model",
        WORKSTREAM_EMAIL_ADDRESS_KEY: `note-visibility-${scope}-address-key-v1`,
        WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
      }), {
        sessionId: "session-1",
        userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
        workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
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
    const agents = agentsBinding(database, [new Error("temporary substream agent outage")]);
    const env = createTestEnv({
      DB: database.binding,
      SUBSTREAM_AGENTS: agents.binding,
      AVALON_REGION: "global",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      WORKSTREAM_EMAIL_ADDRESS_KEY: "manual-run-recovery-address-key-v1",
      WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
    });
    const auth: AuthContext = {
      sessionId: "session-1",
      userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
      workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
      region: "global",
      role: "member",
    };
    const service = new AutomationService(env, auth);

    await expect(service.runNow("subscription-1", "manual-retry-key"))
      .rejects.toMatchObject({ status: 503, code: "workflow_unavailable" });

    expect(database.run).toMatchObject({ status: "scheduled", workflowInstanceId: null });
    expect(storedHarnessRun(agents.objectStore)).toMatchObject({ status: "scheduled", workflow_instance_id: null });
    expect(storedWorkstream(agents.objectStore)).toMatchObject({ archived_at: null });
    // `archived_at` left regional D1 with migration 0090 — the work-stream
    // object owns it now. Both reads of it on the create path reach the
    // identity authority; one issued against `env.DB` would ask the identity
    // anchor for a column it no longer has, and fail the route gate with
    // `no such column` after the address was already reserved. The route gate
    // reads it twice, once to ensure the address and once to activate.
    expect(agents.identityOperations.filter((operation) => operation === "identity").length)
      .toBeGreaterThanOrEqual(2);
    expect(database.objectPortSql.filter((sql) => /FROM workstreams/u.test(sql))).toEqual([]);
    const originalRunId = database.run?.id;
    const originalWorkstreamId = database.run?.workstreamId;
    const originalHarnessRunId = storedHarnessRun(agents.objectStore)?.id;

    const recovered = await service.runNow("subscription-1", "manual-retry-key");

    expect(recovered).toEqual({
      runId: originalRunId,
      workstreamId: originalWorkstreamId,
      harnessRunId: originalHarnessRunId,
      reused: true,
    });
    expect(agents.dispatchRun).toHaveBeenCalledTimes(2);
    const expectedWorkflowId = `substream-agent:0:${originalHarnessRunId}`;
    expect(database.run).toMatchObject({ status: "running", workflowInstanceId: expectedWorkflowId });
    expect(storedHarnessRun(agents.objectStore)).toMatchObject({
      status: "running",
      workflow_instance_id: expectedWorkflowId,
    });
    expect(database.emailRoute).toMatchObject({ workstream_id: originalWorkstreamId });
    expect(storedWorkstream(agents.objectStore)).toMatchObject({
      id: originalWorkstreamId,
      harness_status: "running",
      archived_at: null,
    });

    await expect(service.runNow("subscription-1", "manual-retry-key")).resolves.toMatchObject({
      runId: originalRunId,
      reused: true,
    });
    expect(agents.dispatchRun).toHaveBeenCalledTimes(2);
  });

  it("creates exactly one work stream and run for duplicate inbound email delivery", async () => {
    const database = new ManualRunDatabase();
    const agents = agentsBinding(database);
    const env = createTestEnv({
      DB: database.binding,
      SUBSTREAM_AGENTS: agents.binding,
      AVALON_REGION: "global",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      WORKSTREAM_EMAIL_ADDRESS_KEY: "inbound-email-automation-address-key-v1",
      WORKSTREAM_EMAIL_DOMAIN: "automation.with-avalon.com",
    });
    const service = new AutomationService(env, {
      sessionId: "system-inbound-email",
      userId: asUserId("d6d77053-92bc-4af6-8332-8bea8c4c6904"),
      workspaceId: asWorkspaceId("668953d2-25f2-44fd-8d72-1e8cf024a277"),
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
    expect(database.automationRunInsertCount).toBe(1);
    expect(storedWorkstream(agents.objectStore)).toMatchObject({
      id: first.workstreamId,
      title: database.subscription.name,
      scope: "personal",
      created_by_user_id: database.subscription.owner_user_id,
      automation_subscription_id: "subscription-1",
      automation_run_id: first.runId,
    });
    expect(workstreamObjectGet(
      agents.objectStore,
      `SELECT user_id FROM workstream_participants WHERE removed_at IS NULL`,
    )).toMatchObject({ user_id: database.subscription.owner_user_id });
    expect(database.attachedResourceId).toBe("resource-email-1");
    const openingMessage = storedOpeningMessage(agents.objectStore);
    expect(openingMessage).toMatchObject({
      client_message_id: "resend:resend-email-1",
      text_content: opening.textContent,
    });
    expect(JSON.parse(openingMessage?.structured_content_json ?? "null")).toEqual(opening.structuredContent);
    expect(agents.dispatchRun).toHaveBeenCalledTimes(1);
    expect(agents.dispatchRun).toHaveBeenCalledWith(expect.objectContaining({
      workstreamId: first.workstreamId,
      triggerMessageId: openingMessage?.id,
      automationSubscriptionId: "subscription-1",
    }));
  });
});
