import { STRICT_UUID_PATTERN } from "@rally/contracts/uuid-validation";
import { Hono } from "hono";
import {
  AutomationDraftSchema,
  ScopeSchema,
  asAutomationId,
  asUserId,
  asWorkspaceId,
} from "@rally/contracts";
import { z } from "zod/v3";
import { zValidator } from "@hono/zod-validator";

import type { Env } from "../env";
import { automationAgentName, workspaceDOName } from "../durable-objects/names";
import { canonicalTranscriptJson } from "../durable-objects/ordered-transcript-sqlite/canonical-payload-store";
import { ApiError } from "../lib/api-error";
import { sha256 } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  bootstrapWorkstreamRuntimeEnvironment,
} from "../services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { readWorkstreamAuthorityControl } from "../services/workstream-authority";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { createTranscriptObjectPort } from "../runtime/transcript-port";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createToolReceiptObjectPort } from "../runtime/tool-receipt-port";
import type { ToolReceiptObjectPort } from "../durable-objects/workstream-tool-receipt-protocol";
import type { PersistedRunStatus } from "../durable-objects/workstream-harness-run-storage";

const row = z.record(z.string(), z.union([z.string(), z.number().finite(), z.null()]));

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
  "connector_connections", "automation_templates", "automation_template_versions",
  "resources",
]);

const seedAutomation = z.object({
  id: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  authorUserId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  source: z.object({
    definition: AutomationDraftSchema,
    status: z.enum(["active", "paused", "error"]),
    scope: ScopeSchema,
    unsupportedTrigger: z.boolean(),
    schedules: z.array(z.object({
      nextDueAt: z.number().int().safe().nonnegative().nullable(),
    }).passthrough()),
  }).passthrough(),
}).strict();

const seedBody = z.object({
  workspaceId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  workspaceTables: z.record(z.string(), z.array(row)),
  automations: z.array(seedAutomation),
  workstreams: z.array(z.object({
    id: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
    title: z.string().min(1),
    objective: z.string(),
    harnessStatus: z.string(),
    nextSequenceNumber: z.number().int().safe().positive(),
    participants: z.array(row),
    harnessRuns: z.array(row),
    toolInvocations: z.array(row),
    resourceIds: z.array(z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID")),
    messages: z.array(row),
  })),
}).strict();

/** The route owns this shape; dev tooling has no member-facing contract. */
const SeedProductResultSchema = z.object({
  seeded: z.boolean(),
  workspaceTables: z.record(z.string(), z.number().finite()),
  automations: z.array(z.object({
    automationId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
    lifecycle: z.enum(["active", "paused"]),
  }).strict()),
  workstreams: z.array(z.object({
    workstreamId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
    copied: z.record(z.string(), z.number().finite()),
  })),
}).strict();

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
devRoutes.post("/seed-product", zValidator("json", seedBody), async (c) => {
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

async function seedProduct(env: Env, body: z.infer<typeof seedBody>) {
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
    env.AVALON_REGION === "eu" ? "weur" : "wnam",
  );
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
    const automationId = asAutomationId(automation.id);
    const sourceHash = await sha256(canonicalTranscriptJson(automation.source));
    const agent = await durableObjectStubForWorkspace(
      env,
      env.AUTOMATION_AGENTS,
      asWorkspaceId(workspaceId),
      automationAgentName(env.AVALON_REGION, asWorkspaceId(workspaceId), automationId),
    );
    const receipt = await agent.importAcceptedAutomation({
      schemaVersion: 1,
      automationId,
      workspaceId,
      authorUserId: automation.authorUserId,
      region: env.AVALON_REGION,
      sourceHash,
      source: automation.source,
    });
    await workspaceObject.applyAutomationProjection({
      schemaVersion: 1,
      automationId,
      workspaceId,
      authorUserId: automation.authorUserId,
      authorityGeneration: receipt.authorityGeneration,
      projectionVersion: 1,
      payloadHash: sourceHash,
      lifecycle: receipt.lifecycle,
      scope: automation.source.scope,
      title: automation.source.definition.name,
      description: automation.source.definition.description,
      nextRunAt: automation.source.schedules.reduce<number | null>((value, schedule) => (
        schedule.nextDueAt !== null && (value === null || schedule.nextDueAt < value)
          ? schedule.nextDueAt
          : value
      ), null),
      attentionCode: automation.source.unsupportedTrigger ? "unsupported_trigger"
        : automation.source.status === "error" ? "legacy_runtime_error" : null,
    });
    automations.push({ automationId, lifecycle: receipt.lifecycle });
  }

  const results = [];
  for (const workstream of body.workstreams) {
    const routed = await bootstrapWorkstreamRuntimeEnvironment(env, workspaceId, workstream.id);
    const copied: Record<string, number> = {};

    const identityPort = createIdentityObjectPort(env, workspaceId, workstream.id);
    await identityPort.seedFromFixture({
      title: workstream.title,
      // The fixture speaks the published vocabulary because it was captured
      // from an API response; the object stores its own.
      exactState: storedWorkstreamState(workstream.harnessStatus),
      nextSequenceNumber: workstream.nextSequenceNumber,
      now: Date.now(),
    });

    // Seated through the identity authority rather than inserted: the
    // participant view is retired, and the fixture's `joined_at` is the ISO
    // rendering that view produced.
    for (const participant of workstream.participants) {
      await identityPort.admitParticipant({
        userId: String(participant.user_id),
        addedByUserId: String(participant.added_by_user_id ?? participant.user_id),
        reason: String(participant.participation_reason ?? "explicit"),
        now: Date.parse(String(participant.joined_at ?? new Date().toISOString())),
      });
    }
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
  return { seeded: true, workspaceTables: workspaceCounts, automations, workstreams: results };
}
