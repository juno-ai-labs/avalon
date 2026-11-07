/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * External conversation bindings against the objects that hold them.
 *
 * A binding is only worth what its transactions are: a room's binding and its
 * Space commit together or not at all, a thread's pending binding commits with
 * its Channel's birth and placement, and a run's outbound binding commits with
 * the tool receipt of the send that opened its thread. Each of those is a
 * `transactionSync` over real Durable Object storage, and two of them cross
 * objects (the coordinator between D1 and WorkspaceDO; a run child's outbox
 * into WorkspaceDO), so they are proved here on workerd rather than over a
 * Node double. Slack itself is not in this file: the service's provider calls
 * are covered in the Node suite, and what the adapter decides is covered in
 * the connectors package.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  WorkspaceExternalEventMatchResultSchema,
} from "@rally/contracts";
import { writeSidekickDirectoryRow } from "./helpers/sidekick";

import { conversationObjectName, substreamLoopId, workspaceDOName } from "../src/durable-objects/names";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { externalBindingReplyAdmission } from "../src/services/slack-agent-service";
import { admitExternalWorkstreamMessage } from "../src/services/workstream-service";
import {
  bootstrapConversationChildRuntime,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import {
  ExternalBindingResolutionSchema,
} from "../src/durable-objects/workspace-external-binding-protocol";
import {
  EXTERNAL_BINDING_OUTBOX_CHANNEL,
  drainExternalBindingOutbox,
  enqueueExternalBindingInTransaction,
} from "../src/durable-objects/external-binding-outbox";

import {
  WORKSPACE_ID as RUN_WORKSPACE_ID,
  WORKSTREAM_ID as SIDEKICK_ID,
  boot,
  holdLoopExecuting,
  post,
  seedWorkspaceControlPlane,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ec0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000ec1");
const OTHER_USER_ID = asUserId("00000000-0000-7000-8000-000000000ec3");
const SESSION_ID = "00000000-0000-7000-8000-000000000ec2";
const INSTALLATION = "slack:T1";
const SIDEKICK = "00000000-0000-7000-8000-000000000ec5";
const RUN = "00000000-0000-7000-8000-000000000ec6";

function workspace(workspaceId: string = WORKSPACE_ID) {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", asWorkspaceId(workspaceId))));
}

const at = () => new Date().toISOString();
/** A claim no attempt has abandoned: its stale horizon is long past. */
const LIVE = "2000-01-01T00:00:00.000Z";

async function resolve(path: string[], input: { addressed?: boolean; claimKey?: string | null; staleBefore?: string } = {}) {
  return ExternalBindingResolutionSchema.parse(await workspace().resolveExternalConversation({
    workspaceId: WORKSPACE_ID,
    installationId: INSTALLATION,
    path,
    addressed: input.addressed ?? false,
    claimKey: input.claimKey ?? null,
    pendingStaleBefore: input.staleBefore ?? LIVE,
  }));
}

/**
 * A person closing a run's binding. No surface does this yet; the state and
 * its reason exist, so the tests that must tell it apart from a disconnect
 * write it directly.
 */
async function closeRunBindings(runId: string) {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE external_conversation_bindings SET state = 'suspended', suspended_reason = 'closed'
        WHERE parent_kind = 'automation' AND substream_id = ?`,
      runId,
    );
  });
}

async function bindingRows() {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
    path_json: string; target_kind: string; parent_id: string | null; state: string;
  }>(
    "SELECT path_json, target_kind, parent_id, state FROM external_conversation_bindings ORDER BY path_json",
  ).toArray());
}

async function spaceIds(): Promise<string[]> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ space_id: string }>(
    "SELECT space_id FROM spaces WHERE system_role IS NULL ORDER BY space_id",
  ).toArray().map((row) => row.space_id));
}

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_USER_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'other@example.com', 'Other', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`).bind(OTHER_USER_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

describe("suspending bindings", () => {
  it("suspends every binding to a deleted Sidekick's runs", async () => {
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1.0"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });
    // Through the product path: a person archives the Sidekick.
    await workspace().sidekickCreate({
      workspaceId: WORKSPACE_ID, automationId: SIDEKICK, authorUserId: USER_ID,
      scope: "personal", authorityGeneration: 1,
    });
    await workspace().sidekickRemove({
      workspaceId: WORKSPACE_ID, automationId: SIDEKICK,
      actor: { userId: USER_ID, actorRole: "member", participantOfOwningWorkstream: false },
    });
    expect(await resolve(["D1", "1.0"])).toEqual({ outcome: "suspended", path: ["D1", "1.0"], reason: "sidekick_deleted" });
  });

});

describe("outbound bindings", () => {
  it("keeps the first binding of a path, and a redelivery is a no-op", async () => {
    const record = (substreamId: string) => workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1.0"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId }, at: at(),
    });
    expect(await record(RUN)).toEqual({ outcome: "bound" });
    expect(await record(RUN)).toEqual({ outcome: "already_bound" });
    expect(await record("00000000-0000-7000-8000-000000000ec8")).toEqual({ outcome: "conflict" });
    expect(await resolve(["D1", "1.0"])).toMatchObject({ outcome: "deliver", target: { substreamId: RUN } });
  });

  it("finds a bot DM's most recent open request, and nothing in a DM without one", async () => {
    const EARLIER_RUN = "00000000-0000-7000-8000-000000000ec9";
    const record = async (path: string[], runId: string) => {
      await workspace().recordOutboundExternalConversationBinding({
        workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path,
        target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: runId }, at: at(),
      });
      await scheduler.wait(5);
    };
    // Recorded out of timestamp order, so the most recent is not the one
    // that sorts last by path.
    await record(["D1", "2.0"], EARLIER_RUN);
    await record(["D1", "1.0"], RUN);
    const latest = (prefix: string) => workspace().latestOutboundExternalConversation({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, prefix: [prefix],
    });
    expect(await latest("D1")).toEqual({ latest: { path: ["D1", "1.0"], sidekickId: SIDEKICK, runId: RUN } });
    expect(await latest("D2")).toEqual({ latest: null });
    // A closed request is no longer one to point at.
    await closeRunBindings(RUN);
    await closeRunBindings(EARLIER_RUN);
    expect(await latest("D1")).toEqual({ latest: null });
  });
});

describe("a Sidekick run's send", () => {
  const ATTEMPT = "attempt-1";
  const OWNER = "owner-1";
  const HARNESS_RUN = "00000000-0000-7000-8000-00000000ec99";
  let unique = 0;

  function runChild(): DurableObjectStub {
    unique += 1;
    return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName(
      "global",
      RUN_WORKSPACE_ID,
      SIDEKICK_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`),
    )));
  }

  async function receipt(stub: DurableObjectStub, operation: string, args: Record<string, unknown>) {
    const { body } = await post(stub, "/internal/tool-receipt", {
      workspaceId: RUN_WORKSPACE_ID, workstreamId: SIDEKICK_ID, operation, args: [args],
    });
    return body as { ok: boolean; value?: unknown; error?: string };
  }

  async function sentMessage(stub: DurableObjectStub, externalBinding: Record<string, unknown> | null, owner = OWNER) {
    const fence = { runId: HARNESS_RUN, attemptId: ATTEMPT, owner: OWNER };
    await receipt(stub, "admit", {
      effectIntentId: "send", runId: HARNESS_RUN, toolCallId: "send", toolName: "send_message", mode: "write",
      connectionId: "slack-workspace", requestHash: "request-hash", inputJson: "{}", executionPlanHash: "plan-hash",
      executionPlanJson: '{"mode":"write"}', compatiblePriorPlanHashes: [], providerIdempotencyKey: null, fence, now: Date.now(),
    });
    return receipt(stub, "complete", {
      effectIntentId: "send", checkpointIndex: 1, outputRef: "send-output", outputSummary: "Sent",
      providerOperationId: "D9:1727.002", payloadJson: "{}", allowAmbiguousReconciliation: false,
      ...(externalBinding ? { externalBinding } : {}),
      fence: { ...fence, owner }, now: Date.now(),
    });
  }

  async function outboxRows(stub: DurableObjectStub) {
    return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ payload_json: string }>(
      "SELECT payload_json FROM durable_outbox WHERE channel = ?", EXTERNAL_BINDING_OUTBOX_CHANNEL,
    ).toArray());
  }

  async function seedRunChild(stub: DurableObjectStub) {
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: RUN_WORKSPACE_ID, workstreamId: SIDEKICK_ID });
      state.storage.sql.exec("UPDATE workstream SET parent_kind = 'automation' WHERE id = 1");
      state.storage.sql.exec(
        `INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
           model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
           active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
           tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
           created_at, updated_at, legacy_attempt_id, lease_owner, lease_expires_at)
         VALUES (?,'0','running','{}',0,0,'',0,0,1,0,0,0,0,0,0,0,0,0,0,1,1,?,?,?)`,
        HARNESS_RUN, ATTEMPT, OWNER, Date.now() + 600_000,
      );
    });
  }

  // Where the send's replies arrive; the run child that commits it is the target.
  const binding = { installationId: INSTALLATION, path: ["D9", "1727.002"] };

  async function resolveRun(path: string[]) {
    return ExternalBindingResolutionSchema.parse(await workspace(RUN_WORKSPACE_ID).resolveExternalConversation({
      workspaceId: RUN_WORKSPACE_ID, installationId: INSTALLATION, path,
      addressed: false, claimKey: null, pendingStaleBefore: LIVE,
    }));
  }

  it("binds the reply thread with the receipt, and WorkspaceDO has it once the outbox drains", async () => {
    await workspace(RUN_WORKSPACE_ID).initializeWorkspace(RUN_WORKSPACE_ID, "wnam");
    const stub = runChild();
    await seedRunChild(stub);

    expect(await sentMessage(stub, binding)).toMatchObject({ ok: true, value: "persisted" });
    // The receipt schedules the outbox alarm for now, so workerd may already be
    // draining it: running the alarm here can find none pending and return
    // before that drain finishes. The row is deleted only once WorkspaceDO has
    // the binding, so wait for the empty outbox, not for the alarm call.
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect(await outboxRows(stub)).toEqual([]);
    });
    expect(await resolveRun(["D9", "1727.002"])).toEqual({
      outcome: "deliver",
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK_ID, substreamId: "0" },
    });
  });

  it("parks a binding that can never be delivered, and keeps delivering the ones behind a failing one", async () => {
    const stub = runChild();
    await seedRunChild(stub);
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const now = Date.now();
      for (const [index, path] of [["D1", "1.0"], ["D2", "1.0"]].entries()) {
        enqueueExternalBindingInTransaction(sql, { ...binding, path, at: at() }, now + index);
      }
      // A row whose payload no longer parses, written ahead of both.
      sql.exec(
        `INSERT INTO durable_outbox
           (message_id, channel, destination_kind, destination_id, partition_key, source_version, source_epoch,
            contract_version, payload_json, payload_ref, payload_hash, state, attempts, not_before, created_at, acked_at)
         VALUES ('poisoned', ?, 'durable_object', ?, 'p', 1, 0, 1, '{"installationId":"slack:T1"}', NULL, 'h',
                 'pending', 0, ?, ?, NULL)`,
        EXTERNAL_BINDING_OUTBOX_CHANNEL, RUN_WORKSPACE_ID, now - 1, now - 1,
      );
      const delivered: string[] = [];
      const report = await drainExternalBindingOutbox(sql, async (payload) => {
        if (payload.path[0] === "D1") throw new Error("workspace_unavailable");
        delivered.push(payload.path[0]!);
        return "bound";
      }, now + 10);
      const rows = sql.exec<{ message_id: string; state: string; attempts: number }>(
        "SELECT message_id, state, attempts FROM durable_outbox WHERE channel = ? ORDER BY message_id",
        EXTERNAL_BINDING_OUTBOX_CHANNEL,
      ).toArray().map((row) => ({ ...row, message_id: row.message_id.includes("D1") ? "D1" : row.message_id }));
      return { delivered, report, rows };
    });
    // The failing row did not stop the one behind it.
    expect(result.delivered).toEqual(["D2"]);
    expect(result.rows).toEqual([
      { message_id: "D1", state: "pending", attempts: 1 },
      { message_id: "poisoned", state: "dead", attempts: 1 },
    ]);
    expect(result.report.dead).toEqual([{ messageId: "poisoned", code: expect.stringContaining("external_binding_payload_invalid") }]);
    expect(result.report.deferred).toEqual([{ messageId: expect.stringContaining("D1"), code: "workspace_unavailable" }]);
  });

  it("writes no binding for a send whose receipt did not commit, nor for one that carried none", async () => {
    await workspace(RUN_WORKSPACE_ID).initializeWorkspace(RUN_WORKSPACE_ID, "wnam");
    const lost = runChild();
    await seedRunChild(lost);
    // The fence refused the completion, so its binding went with it.
    expect(await sentMessage(lost, binding, "another-owner")).toMatchObject({ ok: true, value: "ownership_lost" });
    expect(await outboxRows(lost)).toEqual([]);

    // A send through a person's own connection reports no conversation, so
    // its completion carries no binding.
    const personal = runChild();
    await seedRunChild(personal);
    expect(await sentMessage(personal, null)).toMatchObject({ ok: true, value: "persisted" });
    expect(await outboxRows(personal)).toEqual([]);
  });
});

describe("a reply in a thread bound to a Sidekick run", () => {
  it("lands in the run child as the sender's external message, not in a new Channel", async () => {
    const runId = asSubstreamId("00000000-0000-7000-8000-000000000ed1");
    // The run child as a scheduled run provisions it: the Sidekick parent,
    // the run as its substream, personal to the run-as member.
    await bootstrapConversationChildRuntime(env, WORKSPACE_ID, "automation", SIDEKICK, runId);
    await provisionWorkstreamObject(env, {
      workspaceId: WORKSPACE_ID, workstreamId: SIDEKICK, substreamId: runId,
      title: "Weekly call prep", objective: "Ask the founders for updates", scope: "personal",
      createdByUserId: USER_ID, participantUserIds: [USER_ID], harnessStatus: "idle", titleStatus: "settled",
      emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
    });
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, SIDEKICK, runId),
    ));
    // Hold the run's loop, so the delivered input is observed as pending rather
    // than raced by its own activation.
    await runInDurableObject(child, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(SIDEKICK, runId) });
    });
    const actor = {
      provider: "slack", providerAccountId: "T1", providerUserId: "UADAM", displayName: "Adam", avatarUrl: null,
    };
    const admission = externalBindingReplyAdmission({
      workspaceId: WORKSPACE_ID,
      teamId: "T1",
      slackUserId: "UADAM",
      actor,
      matchedWorkspaceUserId: null,
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: runId },
      message: {
        channelId: "D1", threadTs: "1727.002", messageTs: "1727.100", text: "Nothing from me",
        clientMessageId: "event:EvReply", channelType: "im",
      },
      now: Date.now(),
    });
    const admitted = await admitExternalWorkstreamMessage(env, admission);
    expect(admitted.deliveryState).toBe("pending");

    await runInDurableObject(child, (_instance, state) => {
      const pending = new SubstreamLoopStorage(state.storage).input(admission.messageId)!;
      expect(pending).toMatchObject({ actor: "external", external_actor_json: JSON.stringify(actor) });
      expect(JSON.parse(pending.authorization_json)).toMatchObject({ reason: "external_conversation_binding" });
      expect(state.storage.sql.exec<{ parent_kind: string; workstream_key: string }>(
        "SELECT parent_kind, workstream_key FROM workstream WHERE id = 1",
      ).one()).toEqual({ parent_kind: "automation", workstream_key: SIDEKICK });
    });
  });
});

describe("the connector side of a binding", () => {
  const CONNECTION = "00000000-0000-7000-8000-000000000ef1";
  const AUTOMATION = "00000000-0000-7000-8000-000000000ef2";

  async function seedSlackConnection() {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            status, config_json, created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'slack', 'workspace', NULL, 'T1', 'Slack', 'healthy', '{}', ?, ?, 'plugin_slack_bindings')`,
        CONNECTION, WORKSPACE_ID, at(), at(),
      );
    });
  }

  it("claims a message in a bound thread, so it never also becomes Suggested Work", async () => {
    await seedSlackConnection();
    let ordinal = 0;
    const ingest = async () => {
      ordinal += 1;
      const eventId = `00000000-0000-7000-8000-00000000ef${String(10 + ordinal)}`;
      await workspace().ingestConnectorEvent({
        workspaceId: WORKSPACE_ID,
        ingressEventId: eventId,
        payloadHash: `sha256:${String(ordinal).padStart(2, "0").repeat(32)}`,
        event: {
          connectorType: "slack",
          activity: {
            id: eventId, workspaceId: WORKSPACE_ID, region: "global", connectionId: CONNECTION,
            connectionScope: "workspace", connectionOwnerUserId: null, provider: "slack",
            providerEventId: `Ev${ordinal}`, eventType: "slack.direct_message.received", resourceType: "slack_message",
            providerResourceId: `D1:1727.10${ordinal}`, actor: {}, subject: {}, occurredAt: at(), receivedAt: at(),
            title: "Slack direct message", summary: "", textSnippet: "Nothing from me", payloadRef: null,
            visibility: { kind: "workspace" }, targetUserIds: [], entityKeys: [], dedupeKey: `slack:${ordinal}`,
            rawContentHash: null, externalPeople: [],
            metadata: { teamId: "T1", channelId: "D1", threadTs: "1727.002", externalConversationPath: ["D1", "1727.002"], externalConversationInstallationId: INSTALLATION },
          },
        },
      });
      return WorkspaceExternalEventMatchResultSchema.parse(
        await workspace().matchExternalEventDestinations({ workspaceId: WORKSPACE_ID, eventId }),
      );
    };
    // Nothing binds the thread yet: an ordinary unclaimed event.
    expect(await ingest()).toEqual({ matched: false, deliveries: [] });
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1727.002"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });
    expect(await ingest()).toEqual({ matched: true, deliveries: [] });
  });

  it("does not also start the bound Sidekick from a reply its run receives, and still triggers others", async () => {
    await seedSlackConnection();
    for (const automationId of [SIDEKICK, AUTOMATION]) {
      await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId, authorUserId: USER_ID,
        scope: "workspace", authorityGeneration: 1 });
      await writeSidekickDirectoryRow(env, { automationId, workspaceId: WORKSPACE_ID, authorUserId: USER_ID,
        lifecycle: "active", scope: "workspace", title: "Reply watcher", description: "Watch replies" });
    }
    const register = (automationId: string, evaluatorId: string) => workspace().applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      destination: { kind: "automation", automationId },
      evaluators: [{
        evaluatorId,
        source: { connectorType: "slack", connectionId: CONNECTION, eventType: "slack.direct_message.received" },
        when: { kind: "all", allOf: [{ kind: "string", attribute: "channelId", operator: "in", value: ["D1"] }] },
      }],
    });
    await register(SIDEKICK, "00000000-0000-7000-8000-000000000ef6");
    await register(AUTOMATION, "00000000-0000-7000-8000-000000000ef7");
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1727.002"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });
    const eventId = "00000000-0000-7000-8000-00000000ef21";
    await workspace().ingestConnectorEvent({
      workspaceId: WORKSPACE_ID,
      ingressEventId: eventId,
      payloadHash: `sha256:${"21".repeat(32)}`,
      event: {
        connectorType: "slack",
        activity: {
          id: eventId, workspaceId: WORKSPACE_ID, region: "global", connectionId: CONNECTION,
          connectionScope: "workspace", connectionOwnerUserId: null, provider: "slack",
          providerEventId: "Ev21", eventType: "slack.direct_message.received", resourceType: "slack_message",
          providerResourceId: "D1:1727.121", actor: {}, subject: {}, occurredAt: at(), receivedAt: at(),
          title: "Slack direct message", summary: "", textSnippet: "Nothing from me", payloadRef: null,
          visibility: { kind: "workspace" }, targetUserIds: [], entityKeys: [], dedupeKey: "slack:21",
          rawContentHash: null, externalPeople: [],
          metadata: { teamId: "T1", channelId: "D1", threadTs: "1727.002", externalConversationPath: ["D1", "1727.002"], externalConversationInstallationId: INSTALLATION },
        },
      },
    });
    const matched = WorkspaceExternalEventMatchResultSchema.parse(
      await workspace().matchExternalEventDestinations({ workspaceId: WORKSPACE_ID, eventId }),
    );
    expect(matched.matched).toBe(true);
    expect(matched.deliveries.map((delivery) => delivery.destination))
      .toEqual([{ kind: "automation", automationId: AUTOMATION }]);
  });

  it("queues a join for the conversations a saved Slack source names, and links no Space", async () => {
    await seedSlackConnection();
    await workspace().applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      destination: { kind: "automation", automationId: AUTOMATION },
      evaluators: [{
        evaluatorId: "00000000-0000-7000-8000-000000000ef3",
        source: { connectorType: "slack", connectionId: CONNECTION, eventType: "slack.message.posted" },
        when: { kind: "all", allOf: [
          { kind: "string", attribute: "channelId", operator: "in", value: ["C9", "C8"] },
          { kind: "string", attribute: "text", operator: "contains", value: "deploy" },
        ] },
      }],
    });
    const jobs = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      id: string; connection_id: string; payload_json: string;
    }>("SELECT id, connection_id, payload_json FROM slack_ingress_jobs").toArray());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.connection_id).toBe(CONNECTION);
    expect(JSON.parse(jobs[0]!.payload_json)).toMatchObject({
      team_id: "T1",
      event: { type: "rally_sidekick_source_join", channel_ids: ["C8", "C9"] },
    });
    // A join a Sidekick needs is not an invitation.
    expect(await bindingRows()).toEqual([]);
    expect(await spaceIds()).toEqual([]);
  });

  it("joins again on every accepted save of the same conversations, and not on a stale one", async () => {
    await seedSlackConnection();
    const save = (sourceGeneration: number, channels = ["C9"]) => workspace().applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      destination: { kind: "automation", automationId: AUTOMATION },
      sourceGeneration,
      evaluators: [{
        evaluatorId: "00000000-0000-7000-8000-000000000ef4",
        source: { connectorType: "slack", connectionId: CONNECTION, eventType: "slack.message.posted" },
        when: { kind: "all", allOf: [{ kind: "string", attribute: "channelId", operator: "in", value: channels }] },
      }],
    });
    const jobs = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ id: string }>(
      "SELECT id FROM slack_ingress_jobs ORDER BY id",
    ).toArray().map((row) => row.id));
    await save(1);
    expect(await jobs()).toHaveLength(1);
    // The first join ran; the bot has since been removed from C9.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE slack_ingress_jobs SET status = 'completed', payload_json = NULL");
    });
    await save(2);
    expect(await jobs()).toHaveLength(2);
    // A projection older than the one applied changes nothing, so it joins
    // nothing, whatever conversations it names.
    await save(1, ["C7"]);
    expect(await jobs()).toHaveLength(2);
  });
});
