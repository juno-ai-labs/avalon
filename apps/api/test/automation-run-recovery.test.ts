import { asUserId, asWorkspaceId } from "@avalon/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import { testSubstreamAgentsBinding, testWorkstreamObjectStore } from "./helpers/durable-authority";

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
}

interface StoredWorkstreamEmailOwner {
  id: string;
  workspace_id: string;
  email_address: string;
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
    workspace_id: "668953d2-25f2-44fd-8d72-1e8cf024a277",
    status: "active",
    scope: "personal",
    owner_user_id: "d6d77053-92bc-4af6-8332-8bea8c4c6904",
    name: "Daily brief",
    description: "Build the daily brief",
    execution_principal_json: JSON.stringify({ type: "user", userId: "d6d77053-92bc-4af6-8332-8bea8c4c6904" }),
  };

  run: StoredRun | null = null;
  harnessRun: StoredHarnessRun | null = null;
  workstreamStatus: string | null = null;
  workstreamCreatorUserId: string | null = null;
  workstreamParticipantUserId: string | null = null;
  workstreamScope: "personal" | "workspace" | null = null;
  workstreamEmailOwner: StoredWorkstreamEmailOwner | null = null;
  /** Every statement that arrived on the work-stream object's port. */
  readonly objectPortSql: string[] = [];
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
    if (normalized.includes("archived_at FROM workstreams WHERE id = ? AND workspace_id = ?")) {
      const owner = this.database.workstreamEmailOwner;
      if (!owner || owner.id !== this.values[0] || owner.workspace_id !== this.values[1]) {
        return null;
      }
      return { email_address: owner.email_address, archived_at: owner.archived_at } as T;
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
    if (normalized.includes("SELECT id, status, workflow_instance_id FROM harness_runs")) {
      const harness = this.database.harnessRun;
      if (!harness || harness.workspaceId !== this.values[0] || harness.workstreamId !== this.values[1]) {
        return null;
      }
      return {
        id: harness.id,
        status: harness.status,
        workflow_instance_id: harness.workflowInstanceId,
      } as T;
    }
    if (normalized.includes("SELECT id FROM messages")) {
      const message = this.database.openingMessage;
      if (!message || message.workspaceId !== this.values[0] || message.workstreamId !== this.values[1]
        || message.clientMessageId !== this.values[2]) {
        return null;
      }
      return { id: message.id } as T;
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
    } else if (normalized.startsWith("INSERT INTO workstreams")) {
      this.database.workstreamInsertCount += 1;
      this.database.workstreamStatus = String(this.values[9]);
      this.database.workstreamCreatorUserId = String(this.values[5]);
      this.database.workstreamScope = normalized.includes("'personal')") ? "personal" : "workspace";
      this.database.workstreamEmailOwner = {
        id: String(this.values[0]),
        workspace_id: String(this.values[1]),
        email_address: String(this.values[4]),
        archived_at: null,
      };
    } else if (normalized.startsWith("INSERT INTO workstream_participants")) {
      this.database.workstreamParticipantUserId = String(this.values[1]);
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

/**
 * The SubstreamAgent boundary the retired Workflow binding used to play: the
 * runtime SQL port forwards object-owned statements back into the manual
 * database, and `dispatchRun` is the recorded launch edge.
 */
function agentsBinding(database: ManualRunDatabase, failures: Error[] = []) {
  const dispatchRun = vi.fn(async () => {
    const failure = failures.shift();
    if (failure) throw failure;
    return { status: 200, bodyJson: "{}" };
  });
  const stub = {
    dispatchRun,
    bootstrapRuntime: vi.fn(async () => ({ status: 200, bodyJson: "{}" })),
    attachRuntimeResource: vi.fn(async (input: { resourceId: string }) => {
      database.attachedResourceId = input.resourceId;
      return { status: 200, bodyJson: "{}" };
    }),
    /**
     * The harness-run port, answered from this file's hand-built model.
     *
     * The run itself is still created by a routed statement — it is one member
     * of the work-stream bootstrap batch, which stays atomic until the
     * transcript moves too — so its record lives in `ManualRunDatabase` beside
     * the automation row these assertions are written against. Answering the
     * port from the same model is what keeps the two halves of a half-converted
     * path talking about the same run. Unknown operations throw rather than
     * returning nothing, so a new one cannot quietly read as "no such run".
     */
    executeHarnessRunOperation: vi.fn((input: { operation: string; args: unknown[] }) => {
      const stored = database.harnessRun;
      const value = (() => {
        switch (input.operation) {
          case "latestRootRun":
            return stored === null ? null : {
              run_id: stored.id,
              // The port speaks the object's vocabulary, where `scheduled` is
              // `admitted`; the caller maps it back.
              status: stored.status === "scheduled" ? "admitted" : stored.status,
              workflow_instance_id: stored.workflowInstanceId,
              parent_tool_call_id: null,
            };
          case "launchRun": {
            const { workflowInstanceId, startedAt } = input.args[0] as {
              workflowInstanceId: string;
              startedAt: number;
            };
            if (!stored) return { outcome: "not_found" };
            stored.workflowInstanceId = workflowInstanceId;
            if (stored.status === "scheduled") {
              stored.status = "running";
              stored.startedAt = new Date(startedAt).toISOString();
            }
            if (database.workstreamStatus === "scheduled") database.workstreamStatus = "running";
            return { outcome: "launched" };
          }
          case "bindWorkflowInstance": {
            const { workflowInstanceId } = input.args[0] as { workflowInstanceId: string };
            if (!stored) return { outcome: "not_found" };
            stored.workflowInstanceId = workflowInstanceId;
            return { outcome: "bound" };
          }
          default:
            throw new Error(`Unmodelled harness-run operation: ${input.operation}`);
        }
      })();
      return { status: 200, bodyJson: JSON.stringify({ ok: true, value }) };
    }),
    executeRuntimeSql: async (input: { statements: Array<{ sql: string; params: unknown[] }> }) => {
      const results = [];
      for (const { sql, params } of input.statements) {
        database.objectPortSql.push(sql);
        const statement = database.binding.prepare(sql).bind(...params as never[]);
        if (/^\s*(?:SELECT|WITH)/iu.test(sql)) {
          const row = await statement.first<Record<string, string | number | null>>();
          results.push({ columns: row ? Object.keys(row) : [], rows: row ? [row] : [], changes: 0 });
        } else {
          const run = await statement.run();
          results.push({ columns: [], rows: [], changes: Number(run.meta?.changes ?? 1) });
        }
      }
      return { status: 200, bodyJson: JSON.stringify({ results }) };
    },
  };
  // The opening-message lookup goes through the message port, which dispatches
  // `executeMessageOperation`. That one operation runs against a real object
  // store — the storage class, its schema and its statements — while the rest
  // of this stub keeps answering from the fake regional database the other
  // assertions here are written against.
  const objectStore = testWorkstreamObjectStore();
  openObjectStores.push(objectStore);
  const transcript = testSubstreamAgentsBinding(objectStore);
  const transcriptStub = transcript.get(transcript.idFromName("transcript"));
  const stubWithTranscript = new Proxy(stub, {
    get(target, property, receiver) {
      return property === "executeMessageOperation"
        ? Reflect.get(transcriptStub, property)
        : Reflect.get(target, property, receiver);
    },
  });
  const namespace = {
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stubWithTranscript,
    jurisdiction: () => namespace,
  };
  return { binding: namespace, dispatchRun };
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
    expect(database.harnessRun).toMatchObject({ status: "scheduled", workflowInstanceId: null });
    expect(database.workstreamEmailOwner).toMatchObject({ archived_at: null });
    // `archived_at` left regional D1 with migration 0090 — the work-stream
    // object owns it now. Both reads of it on the create path must therefore
    // arrive on the object's port; one issued against `env.DB` would ask the
    // identity anchor for a column it no longer has, and fail the route gate
    // with `no such column` after the address was already reserved.
    const archiveReads = database.objectPortSql
      .filter((sql) => /archived_at[\s\S]*FROM workstreams/u.test(sql));
    expect(archiveReads.length).toBeGreaterThanOrEqual(2);
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
    expect(agents.dispatchRun).toHaveBeenCalledTimes(2);
    const expectedWorkflowId = `substream-agent:0:${originalHarnessRunId}`;
    expect(database.run).toMatchObject({ status: "running", workflowInstanceId: expectedWorkflowId });
    expect(database.harnessRun).toMatchObject({ status: "running", workflowInstanceId: expectedWorkflowId });
    expect(database.workstreamStatus).toBe("running");
    expect(database.emailRoute).toMatchObject({ workstream_id: originalWorkstreamId });
    expect(database.workstreamEmailOwner).toMatchObject({
      id: originalWorkstreamId,
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
    expect(database.workstreamInsertCount).toBe(1);
    expect(database.automationRunInsertCount).toBe(1);
    expect(database.workstreamScope).toBe("personal");
    expect(database.workstreamCreatorUserId).toBe(database.subscription.owner_user_id);
    expect(database.workstreamParticipantUserId).toBe(database.subscription.owner_user_id);
    expect(database.attachedResourceId).toBe("resource-email-1");
    expect(database.openingMessage).toMatchObject({
      clientMessageId: "resend:resend-email-1",
      workstreamId: first.workstreamId,
      textContent: opening.textContent,
      structuredContent: opening.structuredContent,
    });
    expect(agents.dispatchRun).toHaveBeenCalledTimes(1);
    expect(agents.dispatchRun).toHaveBeenCalledWith(expect.objectContaining({
      workstreamId: first.workstreamId,
      triggerMessageId: database.openingMessage?.id,
      automationSubscriptionId: "subscription-1",
    }));
  });
});
