import { asUserId, asWorkspaceId, type WorkstreamWorkflowInput } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "../src/env";
import { AutomationService } from "../src/services/automation-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import {
  testHarnessRunStorage,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectParticipantRows,
  workstreamObjectRootRow,
} from "./helpers/durable-authority";
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
  email_address: string;
  address_source: "allocator";
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
  /**
   * One row per work stream, as `workstream_email_routes` holds them — each
   * reservation takes its own full address. A single slot would make a second
   * work stream's reservation look like an exhausted address space.
   */
  readonly emailRoutes: StoredEmailRoute[] = [];
  get emailRoute(): StoredEmailRoute | null {
    return this.emailRoutes[0] ?? null;
  }
  attachedResourceId: string | null = null;
  automationResource: {
    id: string;
    scope: "personal" | "workspace";
    ownerUserId: string;
    archived: boolean;
  } | null = null;
  automationRunInsertCount = 0;
  /**
   * Model the window two concurrent requests with one idempotency key race in:
   * the loser's lookup runs before the winner's insert is visible, so both
   * reach the insert and the unique index decides. Set for the loser's call.
   */
  concealRunFromLookupOnce = false;

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
    if (normalized.includes("pragma_table_info('workstream_email_routes')")) {
      return { name: "email_address" } as T;
    }
    if (normalized.includes("FROM automation_subscriptions s JOIN automation_templates")) {
      return this.database.subscription as T;
    }
    if (normalized.includes("SELECT id AS run_id, workstream_id, status AS run_status")
      && normalized.includes("FROM automation_runs")) {
      const run = this.database.run;
      if (this.database.concealRunFromLookupOnce) {
        this.database.concealRunFromLookupOnce = false;
        return null;
      }
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
      const route = this.database.emailRoutes.find((candidate) => (
        candidate.region === this.values[0]
        && candidate.workspace_id === this.values[1]
        && candidate.workstream_id === this.values[2]
      ));
      return (route ?? null) as T;
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
      const emailAddress = String(this.values[0]);
      // `ON CONFLICT DO NOTHING` on the full address.
      if (!this.database.emailRoutes.some((route) => route.email_address === emailAddress)) {
        this.database.emailRoutes.push({
          email_address: emailAddress,
          address_source: "allocator",
          region: String(this.values[1]) as "global",
          workspace_id: String(this.values[2]),
          workstream_id: String(this.values[3]),
        });
      }
    } else if (normalized.startsWith("INSERT INTO automation_runs")) {
      // `automation_runs_idempotency_uq`. It is what decides a race between two
      // deliveries of one email, so the fixture has to enforce it rather than
      // record every insert as having won.
      if (this.database.run && this.database.run.idempotencyKey === String(this.values[9])) {
        throw new Error("UNIQUE constraint failed: automation_runs.idempotency_key");
      }
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
 * stub, so this file asserts on what the storage classes actually wrote. The
 * activation wrapper forwards through the real object method before optionally
 * losing its response; the resource attachment remains a stand-in because its eligibility
 * rule is what these tests are about. `executeRuntimeSql` is wrapped rather
 * than replaced so the statements that reach the port stay recorded.
 */
function agentsBinding(database: ManualRunDatabase, failures: Error[] = []) {
  const objectStore = testWorkstreamObjectStore();
  openObjectStores.push(objectStore);
  const attachRuntimeResource = vi.fn((input: { resourceId: string }) => {
    database.attachedResourceId = input.resourceId;
    return { status: 200, bodyJson: "{}" };
  });
  const base = testSubstreamAgentsBinding(objectStore, {
    extra: { attachRuntimeResource },
  });
  const baseStub = base.get(base.idFromName("substream-agent"));
  const activateLoop = vi.fn(async (input: LoopActivationInput) => {
    const now = Date.now();
    const workflowInstanceId = `substream-agent:${input.substreamId ?? "0"}:${input.harnessRunId}`;
    const launched = testHarnessRunStorage(objectStore).launchRun({
      runId: input.harnessRunId,
      workflowInstanceId,
      executionContextJson: JSON.stringify(input),
      executionAvailableAt: now,
      startedAt: now,
      now,
    });
    if (launched.outcome !== "launched") {
      return { status: 409, bodyJson: JSON.stringify({ error: "execution_receipt_not_found" }) };
    }
    const failure = failures.shift();
    if (failure) throw failure;
    return { status: 202, bodyJson: JSON.stringify({ accepted: true }) };
  });
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
      if (property === "activateLoop") return activateLoop;
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
  return { binding: namespace, activateLoop, objectStore, identityOperations };
}

interface RuntimeSqlRequest {
  statements: Array<{ sql: string; params: unknown[] }>;
}

type LoopActivationInput = WorkstreamWorkflowInput;

/** The work stream the object holds, in the columns these tests assert on. */
function storedWorkstream(objectStore: DatabaseSync) {
  return workstreamObjectRootRow<{
    workstream_key: string;
    title: string;
    scope: string;
    created_by_user_id: string | null;
    automation_subscription_id: string | null;
    automation_run_id: string | null;
    archived_at: number | null;
    exact_state: string;
  }>(
    objectStore,
    `workstream_key, title, scope, created_by_user_id, automation_subscription_id,
     automation_run_id, archived_at, exact_state`,
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
    `SELECT id, client_message_id, content AS text_content, structured_content_json
       FROM canonical_conversation_turn_details WHERE message_type = 'system'`,
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

  it("replays the same durable activation receipt after a transient agent failure", async () => {
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
    expect(storedHarnessRun(agents.objectStore)).toMatchObject({
      status: "running",
      workflow_instance_id: expect.stringMatching(/^substream-agent:0:/u),
    });
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
    expect(agents.activateLoop).toHaveBeenCalledTimes(2);
    const expectedWorkflowId = `substream-agent:0:${originalHarnessRunId}`;
    expect(database.run).toMatchObject({ status: "running", workflowInstanceId: expectedWorkflowId });
    expect(storedHarnessRun(agents.objectStore)).toMatchObject({
      status: "running",
      workflow_instance_id: expectedWorkflowId,
    });
    expect(database.emailRoute).toMatchObject({ workstream_id: originalWorkstreamId });
    expect(storedWorkstream(agents.objectStore)).toMatchObject({
      workstream_key: originalWorkstreamId,
      exact_state: "running",
      archived_at: null,
    });

    await expect(service.runNow("subscription-1", "manual-retry-key")).resolves.toMatchObject({
      runId: originalRunId,
      reused: true,
    });
    expect(agents.activateLoop).toHaveBeenCalledTimes(2);
  });

  it("provisions nothing when the run it would belong to loses the idempotency race", async () => {
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
      structuredContent: { kind: "inbound_email", provider: "resend", untrusted: true, emailId: "resend-email-1" },
      resourceId: "resource-email-1",
    };

    const winner = await service.runFromInboundEmail("subscription-1", opening);
    // The loser's lookup ran before the winner's insert was visible, so it
    // reaches the insert too and the unique index refuses it there.
    database.concealRunFromLookupOnce = true;
    const loser = await service.runFromInboundEmail("subscription-1", opening);

    expect(loser).toMatchObject({ runId: winner.runId, workstreamId: winner.workstreamId, reused: true });
    expect(database.automationRunInsertCount).toBe(1);
    // The control row is claimed before anything visible exists, so the loser
    // never provisions. Provisioning first would leave a sidebar entry and a
    // reserved address for a run that does not exist — and `controlRunInserted`
    // is false down that path, so nothing compensates it away.
    expect(agents.identityOperations.filter((operation) => operation === "provision"))
      .toEqual(["provision"]);
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
      workstream_key: first.workstreamId,
      title: database.subscription.name,
      scope: "personal",
      created_by_user_id: database.subscription.owner_user_id,
      automation_subscription_id: "subscription-1",
      automation_run_id: first.runId,
    });
    expect(workstreamObjectParticipantRows(agents.objectStore, "user_id"))
      .toEqual([{ user_id: database.subscription.owner_user_id }]);
    expect(database.attachedResourceId).toBe("resource-email-1");
    const openingMessage = storedOpeningMessage(agents.objectStore);
    expect(openingMessage).toMatchObject({
      client_message_id: "resend:resend-email-1",
      text_content: opening.textContent,
    });
    expect(JSON.parse(openingMessage?.structured_content_json ?? "null")).toEqual(opening.structuredContent);
    // Once the regional projection and object receipt both prove that the
    // stable activation committed, a duplicate delivery returns that receipt
    // without asking the loop to activate again. The durable run and
    // transcript remain singular.
    expect(agents.activateLoop).toHaveBeenCalledTimes(1);
    expect(agents.activateLoop).toHaveBeenCalledWith(expect.objectContaining({
      workstreamId: first.workstreamId,
      triggerMessageId: openingMessage?.id,
      automationSubscriptionId: "subscription-1",
    }));
  });
});
