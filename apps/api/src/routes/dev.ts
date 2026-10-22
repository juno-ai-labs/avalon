import { ConnectorParticipantAdmissionSchema } from "@rally/contracts/scope-grants";
import { fallbackWorkspacePlacementAffinity } from "../lib/durable-object-namespace";
import { Hono } from "hono";
import {
  AutomationDraftSchema,
  asUserId,
  asWorkspaceId,
  type WorkstreamId,
} from "@rally/contracts";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import type { Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { ApiError } from "../lib/api-error";
import { sha256Hex } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  bootstrapWorkstreamRuntimeEnvironment,
} from "../services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { readWorkstreamAuthorityControl } from "../services/workstream-authority";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { createAutomation } from "../services/automation-service";
import {
  openGeneralSpaceForNewWorkspace,
  placeConnectorChannelInGeneral,
} from "../services/space-bootstrap-service";
import {
  WorkspaceSpaceBootstrapPageSchema,
  type SpaceBootstrapChannel,
  type WorkspaceSpaceBootstrapPage,
} from "../durable-objects/workspace-space-protocol";
import { enqueueWorkspaceConnectorEvent } from "../services/workspace-connector-event-ingress";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { createTranscriptObjectPort } from "../runtime/transcript-port";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createToolReceiptObjectPort } from "../runtime/tool-receipt-port";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
import type { PersistedRunStatus } from "../durable-objects/workstream-harness-run-storage";
import { hostedParentStub } from "../services/conversation-parent-client";

const row = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

/**
 * Seed tool receipts through the work stream's typed receipt authority.
 *
 * The fixture is written in the vocabulary a reader of this repository knows —
 * `harness_run_id`, `input_hash`, ISO-8601 timestamps — and it stays that way,
 * because a checked-in seed is meant to be read. What used to translate it was
 * the `_runtime_tool_invocations` insert trigger, which also *invented* the
 * columns the old vocabulary never carried. Doing that here rather than in SQL
 * is the point of the change: every fabricated value is now visible at the one
 * place that fabricates it.
 *
 * `tool_position` is the row's index rather than a count of what is already
 * there. The trigger used `COUNT(*)`, which stops being injective the moment a
 * receipt is deleted — the defect object schema migration 16 repaired.
 */
async function insertToolReceipts(
  receiptsPort: ToolReceiptObjectPort,
  receipts: z.infer<typeof row>[],
  copied: Record<string, number>,
): Promise<void> {
  for (const [position, receipt] of receipts.entries()) {
    const id = String(receipt.id);
    const plan = typeof receipt.execution_plan_json === "string" ? receipt.execution_plan_json : null;
    const at = (value: unknown): number | null =>
      typeof value === "string" ? Date.parse(value) : null;
    const status = receipt.status === "pending" ? "admitted"
      : receipt.status === "started" ? "executing"
        : String(receipt.status);
    if (!["admitted", "executing", "completed", "failed", "ambiguous"].includes(status)) {
      throw new Error("seed_tool_receipt_status_invalid");
    }
    await receiptsPort.seedDevelopmentReceipt({
      effectIntentId: id,
      runId: String(receipt.harness_run_id),
      toolPosition: position,
      toolCallId: String(receipt.tool_call_id),
      toolName: String(receipt.tool_name),
      mode: plan?.includes('"mode":"write"') ? "write" : "read",
      requestHash: String(receipt.input_hash ?? "seed"),
      status: status as "admitted" | "executing" | "completed" | "failed" | "ambiguous",
      connectionId: typeof receipt.connection_id === "string" ? receipt.connection_id : null,
      inputJson: typeof receipt.input_json === "string" ? receipt.input_json : "{}",
      outputSummary: typeof receipt.output_summary === "string" ? receipt.output_summary : null,
      executionPlanJson: plan,
      startedAt: at(receipt.started_at),
      settledAt: at(receipt.completed_at),
    });
  }
  copied.tool_effects = receipts.length;
}

/**
 * The only tables this route will write, per authority. The fixture file is
 * checked in, but the route is an HTTP surface even dev-gated, so what it can
 * touch is enumerated here rather than taken from the request.
 */
const WORKSPACE_SEED_TABLES = new Set([
  "connector_connections",
  "resources",
]);

const seedAutomation = z.strictObject({
  id: z.string().uuid(),
  authorUserId: z.string().uuid(),
  scope: z.enum(["personal", "workspace"]),
  draft: AutomationDraftSchema,
});

export const SeedProductBodySchema = z.strictObject({
  workspaceId: z.string().uuid(),
  workspaceTables: z.record(z.string(), z.array(row)),
  automations: z.array(seedAutomation),
  workstreams: z.array(z.object({
    id: z.string().uuid(),
    title: z.string().min(1),
    objective: z.string(),
    harnessStatus: z.string(),
    nextSequenceNumber: z.number().int().positive(),
    participants: z.array(row),
    harnessRuns: z.array(row),
    toolInvocations: z.array(row),
    resourceIds: z.array(z.string().uuid()),
    messages: z.array(row),
  })),
});

/** The route owns this shape; dev tooling has no member-facing contract. */
const SeedProductResultSchema = z.strictObject({
  seeded: z.boolean(),
  workspaceTables: z.record(z.string(), z.number()),
  automations: z.array(z.strictObject({
    automationId: z.string().uuid(),
    lifecycle: z.enum(["active"]),
  })),
  workstreams: z.array(z.object({
    workstreamId: z.string().uuid(),
    copied: z.record(z.string(), z.number()),
  })),
});

/**
 * The `exact_state` a captured `harnessStatus` restores to.
 *
 * The retired `_runtime_workstreams` update trigger's mapping, kept here
 * because only the seed route speaks the published vocabulary: a fixture is a
 * recorded API response, and the object stores its own states. Every state the
 * trigger did not name collapsed to `idle`, and so does every one here.
 */
function storedWorkstreamState(harnessStatus: string): string {
  return ["scheduled", "running", "needs_input", "completed", "failed"]
    .includes(harnessStatus)
    ? harnessStatus
    : "idle";
}

export const devRoutes = new Hono<{ Bindings: Env }>();

/**
 * Seeds product-authority fixtures into the Durable Objects through the same
 * typed object operations every post-cutover producer writes through.
 *
 * Local development only. `packages/db/seed.sql` owns the regional control
 * plane; the product content a member sees — transcripts, tool events,
 * resources, connections, automations — belongs to the objects, and lives in
 * `packages/db/seed-product.json`, which `pnpm db:open-authority` posts here.
 * Keeping the fixtures out of D1 entirely is what lets the legacy product
 * tables be dropped: nothing writes them, so nothing needs them.
 *
 * Everything is idempotent — messages replay-absorb by client id and message
 * id, the rest upsert or ignore — so a re-run repairs a partial seed.
 */
devRoutes.post("/seed-product", zValidator("json", SeedProductBodySchema), async (c) => {
  if (c.env.APP_ENV !== "development" || c.env.RALLY_DEV_AUTH !== "true") {
    throw new ApiError(404, "not_found", "Development tooling is unavailable");
  }
  const body = c.req.valid("json");
  const authority = await readWorkstreamAuthorityControl(c.env);
  if (authority.phase !== "durable_object_open") {
    throw new ApiError(409, "authority_not_open", "Run pnpm db:open-authority first");
  }
  try {
    return c.json(SeedProductResultSchema.parse(await seedProduct(c.env, body)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // A development tool's failure detail belongs in its response; the global
    // handler's member-safe 500 was built for members, not for the person
    // debugging their own local stack.
    throw new ApiError(500, "seed_product_failed",
      error instanceof Error ? error.message.slice(0, 400) : "unknown");
  }
});

async function seedProduct(env: Env, body: z.infer<typeof SeedProductBodySchema>) {
  const workspaceId = body.workspaceId;
  // A wiped local state means the WorkspaceDO has never learned who it is;
  // production teaches it at onboarding, the dev seed teaches it here.
  const workspaceObject = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
  await workspaceObject.initializeWorkspace(
    workspaceId,
    fallbackWorkspacePlacementAffinity(env.AVALON_REGION),
  );
  // The same step onboarding takes: every Channel this seed is about to write
  // belongs to a Space, and the sidebar cannot be drawn without General.
  await openGeneralSpaceForNewWorkspace(env, workspaceId);
  const workspaceDatabase = withWorkspaceRuntimeDatabase(env, workspaceId);

  const workspaceCounts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(body.workspaceTables)) {
    if (!WORKSPACE_SEED_TABLES.has(table)) {
      throw new ApiError(422, "seed_table_not_allowed", `Table ${table} is not seedable`);
    }
    for (const record of rows) {
      // Null-valued keys are omitted so column defaults apply, and the
      // conflict target is the id alone: OR IGNORE would also swallow
      // constraint violations, which is how a fixture mismatch once vanished
      // silently instead of failing this route loudly.
      const columns = Object.keys(record).filter((column) => record[column] !== null);
      await workspaceDatabase.DB.prepare(
        `INSERT INTO ${table} (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})
         ON CONFLICT(id) DO NOTHING`,
      ).bind(...columns.map((column) => record[column])).run();
    }
    workspaceCounts[table] = rows.length;
  }

  const automations = [];
  for (const automation of body.automations) {
    // The same three steps a person takes: the object with its conversation,
    // the definition the conversation would have submitted, and Create.
    const { automationId } = await createAutomation(env, {
      workspaceId,
      authorUserId: automation.authorUserId,
      scope: automation.scope,
      owningWorkstreamId: null,
      automationId: automation.id,
    });
    const workspace = await hostedParentStub(env, workspaceId);
    await workspace.sidekickSubmitDefinition({
      workspaceId: asWorkspaceId(workspaceId),
      automationId,
      draft: { ...automation.draft, suggestedScope: automation.scope },
      evaluatorRules: null,
      submittedByRunId: null,
    });
    await workspace.sidekickApply({
      workspaceId: asWorkspaceId(workspaceId),
      automationId,
      actor: { userId: asUserId(automation.authorUserId), actorRole: "owner", participantOfOwningWorkstream: false },
    });
    automations.push({ automationId, lifecycle: "active" as const });
  }

  const results = [];
  for (const workstream of body.workstreams) {
    const routed = await bootstrapWorkstreamRuntimeEnvironment(env, workspaceId, workstream.id, "workstream");
    const copied: Record<string, number> = {};

    const identityPort = createIdentityObjectPort(env, workspaceId, workstream.id);
    const existingIdentity = await identityPort.identity();
    await identityPort.provision({ title: workstream.title, objective: workstream.objective,
      scope: existingIdentity?.scope === "workspace" ? "workspace" : "personal",
      createdByUserId: existingIdentity?.created_by_user_id ?? null, participantUserIds: [],
      harnessStatus: "idle", emailAddress: existingIdentity?.email_address ?? null, emailRouteStatus: null,
      systemKind: null, modelOverride: null, now: Date.now() });
    await identityPort.seedFromFixture({
      title: workstream.title,
      // The fixture speaks the published vocabulary because it was captured
      // from an API response; the object stores its own.
      exactState: storedWorkstreamState(workstream.harnessStatus),
      nextSequenceNumber: workstream.nextSequenceNumber,
      now: Date.now(),
    });

    // Fixture hydration uses the same grant authority as other trusted
    // producer audiences; it never reopens the source's participant writer.
    const userIds = workstream.participants.map((participant) => String(participant.user_id));
    const admission = await (await hostedParentStub(env, workspaceId)).admitConnectorParticipants(ConnectorParticipantAdmissionSchema.parse({
      workspaceId, parentId: workstream.id, userIds, addedByUserId: existingIdentity?.created_by_user_id ?? null,
      eventId: JSON.stringify(["dev-seed-participants", workstream.id, [...userIds].sort()]),
    }));
    if (admission.status !== "ready") throw new Error("dev_seed_participant_admission_pending");
    copied.workstream_participants = workstream.participants.length;
    const runs = createHarnessRunObjectPort(routed, workspaceId, workstream.id);
    for (const fixtureRun of workstream.harnessRuns) {
      const status = fixtureRun.status === "scheduled" ? "admitted"
        : fixtureRun.status === "stopped" ? "cancelled"
          : String(fixtureRun.status);
      if (!["admitted", "running", "needs_input", "completed", "failed", "cancelled"].includes(status)) {
        throw new Error("seed_harness_run_status_invalid");
      }
      const at = (value: unknown): number | null =>
        typeof value === "string" ? Date.parse(value) : null;
      const createdAt = at(fixtureRun.created_at);
      const startedAt = at(fixtureRun.started_at) ?? createdAt;
      if (createdAt === null || startedAt === null) throw new Error("seed_harness_run_timestamp_invalid");
      await runs.seedDevelopmentRun({
        runId: String(fixtureRun.id),
        origin: String(fixtureRun.origin),
        executionPrincipalJson: typeof fixtureRun.execution_principal_json === "string"
          ? fixtureRun.execution_principal_json : "{}",
        status: status as PersistedRunStatus,
        startedAt,
        completedAt: at(fixtureRun.completed_at),
        terminalizedAt: at(fixtureRun.terminalized_at),
        createdAt,
      });
    }
    copied.harness_runs = workstream.harnessRuns.length;
    await insertToolReceipts(
      createToolReceiptObjectPort(routed, workspaceId, workstream.id),
      workstream.toolInvocations,
      copied,
    );
    const transcript = createTranscriptObjectPort(routed, workspaceId, workstream.id);
    for (const message of workstream.messages) {
      const authorType = String(message.author_type);
      const actor = authorType === "agent" ? "assistant" : authorType;
      if (actor !== "human" && actor !== "assistant"
        && actor !== "external" && actor !== "system") {
        throw new Error("seed_conversation_actor_invalid");
      }
      const messageType = String(message.message_type);
      if (messageType !== "text" && messageType !== "system"
        && messageType !== "elicitation" && messageType !== "tool") {
        throw new Error("seed_conversation_type_invalid");
      }
      const fixtureHasAuthorSnapshot = (message.author_name_snapshot !== null
        && message.author_name_snapshot !== undefined)
        || (message.author_avatar_url_snapshot !== null
          && message.author_avatar_url_snapshot !== undefined);
      await transcript.seedDevelopmentConversationTurn({
        turnId: String(message.id),
        clientMessageId: message.client_message_id === null
          || message.client_message_id === undefined
          ? null
          : String(message.client_message_id),
        actor,
        authorUserId: message.author_user_id === null || message.author_user_id === undefined
          ? null
          : String(message.author_user_id),
        authorSnapshot: actor === "human" || fixtureHasAuthorSnapshot
          ? {
            displayName: String(message.author_name_snapshot ?? ""),
            avatarUrl: message.author_avatar_url_snapshot === null
              || message.author_avatar_url_snapshot === undefined
              ? null
              : String(message.author_avatar_url_snapshot),
          }
          : null,
        externalActorJson: message.external_actor_json === null
          || message.external_actor_json === undefined
          ? null
          : String(message.external_actor_json),
        messageType,
        text: String(message.text_content ?? ""),
        structuredContentJson: message.structured_content_json === null
          || message.structured_content_json === undefined
          ? null
          : String(message.structured_content_json),
        producedByRunId: message.harness_run_id === null || message.harness_run_id === undefined
          ? null
          : String(message.harness_run_id),
        expectedTranscriptSequence: Number(message.sequence_number),
        createdAtUtc: String(message.created_at),
      });
    }
    copied.participant_transcript_turns = workstream.messages.length;

    if (workstream.resourceIds.length > 0) {
      const creator = String(workstream.participants[0]?.user_id ?? "");
      const client = new WorkstreamObjectClient(env, {
        sessionId: "development",
        userId: asUserId(creator),
        workspaceId: asWorkspaceId(workspaceId),
        region: env.AVALON_REGION,
        role: "owner",
      }, workstream.id);
      for (const resourceId of workstream.resourceIds) {
        // Re-runs repair partial seeds; an attachment that already exists is
        // that repair finding nothing to do.
        await client.attachResource(resourceId).catch((error: unknown) => {
          const code = error instanceof ApiError ? error.code : "";
          if (code !== "resource_already_attached" && code !== "conflict") throw error;
        });
      }
      copied.resources_attached = workstream.resourceIds.length;
    }
    results.push({ workstreamId: workstream.id, copied });
  }

  await placeSeededChannelsInGeneral(env, workspaceId, results.map((result) => result.workstreamId));
  return { seeded: true, workspaceTables: workspaceCounts, automations, workstreams: results };
}

/**
 * Give every Channel this seed wrote its home in General.
 *
 * Every non-deleted Channel belongs to a Space, and this route does not reach
 * `WorkstreamObjectCreationService` — it restores a captured fixture into
 * objects it provisions under the ids the fixture chose. So it is the second
 * creation path the coordinator's placement does not cover, and it takes the
 * same step the Slack agent's does, through the same
 * `placeConnectorChannelInGeneral`.
 *
 * **It waits for the Organization to know the Channel exists first**, which is
 * what the creation coordinator gets for free. Reserving a Channel's main
 * conversation writes the parent authority's own identity row and delivers a
 * provisional directory row synchronously; seeding writes through the
 * conversation instead, so the parent learns of the Channel from an effect
 * that drifts up on its outbox. A placement issued before that lands is
 * refused `conversation_parent_missing` by the Channel's own authority. The
 * directory row is published *by* that parent, so one page of the cutover's
 * own view of the Organization is exactly the signal: seeing the Channel there
 * means the authority the placement addresses exists.
 *
 * It is also the best answer to what to place: the page's item is the Channel
 * as the Organization records it — the scope its projection carries and the
 * participants who may act on it — rather than two facts this route would have
 * to assert about a Channel whose audience it does not set.
 *
 * **And the wait is what makes the fallback converge.** The participant half
 * of the projection arrives as its own effect, so a placement can still be
 * refused `space_bootstrap_no_active_actor` for a Channel whose directory row
 * has landed and whose viewers have not. That refusal reopens the cutover, and
 * the cutover's close asks whether any Channel in the directory is outside
 * every Space — a question that can only be answered about a Channel the
 * directory holds. Waiting for the row is therefore what stops the reopened
 * walk from finding an empty directory, closing as complete, and leaving the
 * Channel homeless with nothing left to notice.
 *
 * The wait has no deadline of its own. This is development tooling behind
 * `APP_ENV=development`, `pnpm db:open-authority` is its only caller and
 * already reports loudly, and an effect that never arrives is a local stack
 * broken in a way a timeout here would only disguise.
 */
async function placeSeededChannelsInGeneral(
  env: Env,
  workspaceId: string,
  workstreamIds: readonly string[],
): Promise<void> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
  for (const workstreamId of workstreamIds) {
    let channel: SpaceBootstrapChannel | undefined;
    while (!channel) {
      let cursor: WorkstreamId | null = null;
      do {
        const page: WorkspaceSpaceBootstrapPage = WorkspaceSpaceBootstrapPageSchema.parse(
          await workspace.spaceBootstrapPage({ workspaceId, cursor }),
        );
        channel = page.items.find((item) => item.workstreamId === workstreamId);
        cursor = page.nextCursor;
      } while (!channel && cursor !== null);
      // One directory round trip per poll, so the loop yields on real I/O
      // rather than spinning; the interval is a cadence, not a limit.
      if (!channel) await scheduler.wait(50);
    }
    // Idempotent on a warm container: a Channel General already holds settles
    // the membership it has rather than staging a second one. A refusal this
    // could not settle reopens the Organization's cutover, whose walk reaches
    // the same Channel with the same directory record.
    await placeConnectorChannelInGeneral(env, workspaceId, channel);
  }
}

/**
 * A synthetic connector event, for driving the routing path without a
 * provider.
 *
 * Local development only, gated the same way the seed is. The body is the
 * normalized activity a connector adapter would have produced; it is enqueued
 * exactly where a verified webhook or a poll enqueues one, so everything after
 * ingress (the workspace's event ledger, the matcher, the automation's
 * admission, the run) is the production path. The connection it names must
 * exist in the workspace, which the seed can provide.
 */
const SyntheticConnectorEventBodySchema = z.strictObject({
  workspaceId: z.string().uuid(),
  connectorType: z.string().min(1).max(80),
  activity: z.object({
    connectionId: z.string().uuid(),
    connectionScope: z.enum(["personal", "workspace"]).default("workspace"),
    connectionOwnerUserId: z.string().uuid().nullable().default(null),
    provider: z.string().min(1).max(80),
    providerEventId: z.string().min(1).max(200),
    eventType: z.string().min(1).max(200),
    resourceType: z.string().max(80).nullable().default(null),
    providerResourceId: z.string().max(500).nullable().default(null),
    title: z.string().min(1).max(300),
    summary: z.string().max(4_000).default(""),
    textSnippet: z.string().max(4_000).default(""),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    targetUserIds: z.array(z.string().uuid()).default([]),
    visibility: z.record(z.string(), z.unknown()).default({ kind: "workspace" }),
    metadata: z.record(z.string(), z.unknown()).default({}),
    actor: z.record(z.string(), z.unknown()).default({}),
    subject: z.record(z.string(), z.unknown()).default({}),
  }),
});

/** A UUID-shaped id from a hash, so the same event always gets the same id. */
function syntheticActivityId(hex: string): string {
  const digits = hex.replace(/[^0-9a-f]/giu, "").padEnd(32, "0").slice(0, 32);
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-4${digits.slice(13, 16)}-8${digits.slice(17, 20)}-${digits.slice(20, 32)}`;
}

const SyntheticConnectorEventResultSchema = z.strictObject({
  activityId: z.string().uuid(),
  enqueued: z.literal(true),
});

devRoutes.post("/connector-events", zValidator("json", SyntheticConnectorEventBodySchema), async (c) => {
  if (c.env.APP_ENV !== "development" || c.env.RALLY_DEV_AUTH !== "true") {
    throw new ApiError(404, "not_found", "Development tooling is unavailable");
  }
  const body = c.req.valid("json");
  const now = new Date().toISOString();
  // The same provider event id is the same event: a replay must carry the
  // identity the first delivery had, or the ledger refuses it as a reuse.
  // Callers replaying an event pass the same occurredAt too.
  const deliveryHash = await sha256Hex(
    `${body.workspaceId}:${body.connectorType}:${body.activity.connectionId}:${body.activity.providerEventId}`,
  );
  const activityId = syntheticActivityId(deliveryHash);
  await enqueueWorkspaceConnectorEvent(c.env, {
    connectorType: body.connectorType,
    activity: {
      id: activityId,
      workspaceId: body.workspaceId,
      region: c.env.AVALON_REGION,
      connectionId: body.activity.connectionId,
      connectionScope: body.activity.connectionScope,
      connectionOwnerUserId: body.activity.connectionOwnerUserId,
      provider: body.activity.provider,
      providerEventId: body.activity.providerEventId,
      eventType: body.activity.eventType,
      resourceType: body.activity.resourceType,
      providerResourceId: body.activity.providerResourceId,
      actor: body.activity.actor,
      subject: body.activity.subject,
      occurredAt: body.activity.occurredAt ?? now,
      receivedAt: now,
      title: body.activity.title,
      summary: body.activity.summary,
      textSnippet: body.activity.textSnippet,
      payloadRef: null,
      visibility: body.activity.visibility,
      targetUserIds: body.activity.targetUserIds,
      entityKeys: [],
      dedupeKey: `${body.connectorType}:${body.activity.providerEventId}`,
      // A webhook delivery's body hash differs per delivery, and ingest drops
      // a new event whose content repeats its resource's last one. Standing in
      // for that hash keeps two synthetic events two events.
      rawContentHash: `sha256:${deliveryHash}`,
      metadata: body.activity.metadata,
      externalPeople: [],
    },
  });
  return c.json(SyntheticConnectorEventResultSchema.parse({ activityId, enqueued: true }), 202);
});
